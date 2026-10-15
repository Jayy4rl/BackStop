// Arc on a local chain: USDC is the native coin, so every movement is logged by the system emitter
// in 18 decimals (the 0x3600… interface also logs ERC-20 transfers, in 6), and the blocklist is the
// NativeCoinControl precompile. The indexer, sends and the frozen-payee refund must all follow that.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeFunctionData, erc20Abi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseUnits } from '@backstop/shared';
import { createHarness, ok, signup, stepUp, tier1, type Harness, type TestUser } from './helpers/harness.ts';
import { KEYS, startAnvil, type Anvil } from './helpers/anvil.ts';
import { indexAll } from '../src/services/indexer.ts';
import { jobHandlers, keeperSweep } from '../src/services/keeper.ts';
import { JobRunner } from '../src/lib/jobs.ts';

let chain: Anvil;
let h: Harness;
let runner: JobRunner;

async function index() {
  h.clock.set(await chain.time());
  await indexAll(h.ctx);
}
async function work() {
  h.clock.set(await chain.time());
  await keeperSweep(h.ctx);
  for (let i = 0; i < 5; i++) if ((await runner.runOnce(100, h.clock.now)) === 0) break;
  await index();
}
async function usdc(addr: string): Promise<bigint> {
  return chain.pub.readContract({ address: chain.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [addr as Hex] });
}
async function incoming(u: TestUser) {
  return (await h.ctx.db.query("SELECT token, amount_units, tx_hash FROM app.transfers WHERE user_id = $1 AND direction = 'in' ORDER BY block_number, log_index", [u.id])).rows;
}

beforeAll(async () => {
  chain = await startAnvil({ arc: true });
  const start = await chain.pub.getBlockNumber();
  h = await createHarness({
    cfg: {
      chains: { arc: { network: 'arc', rpcUrls: [chain.url], chainId: 31337, factory: chain.factory, tokens: { USDC: chain.usdc }, finality: 'latest', startBlock: start, keeperKey: KEYS.keeper } },
      arbiterExecutorKey: KEYS.arbiter,
      treasury: { arc: privateKeyToAccount(KEYS.treasury).address },
    },
  });
  runner = new JobRunner(h.ctx.db, jobHandlers(h.ctx));
  await index();
}, 120_000);

afterAll(async () => {
  await h?.close();
  chain?.stop();
});

describe('Arc native USDC', () => {
  let ada: TestUser;
  let ben: TestUser;

  it('indexes mints, ERC-20 transfers and plain native sends once each, in token units', async () => {
    ada = await signup(h, { handle: 'adaarc' });
    ben = await signup(h, { handle: 'benarc' });
    await tier1(h, ada, 'Ada', 'Eze');
    await tier1(h, ben, 'Ben', 'Obi');
    await chain.fund(ada.evm);
    await chain.mint(ada.evm, parseUnits('100')); // system log only
    const otherKey = generatePrivateKey();
    const other = privateKeyToAccount(otherKey).address;
    await chain.fund(other);
    await chain.mint(other, parseUnits('50'));
    // ERC-20 transfer: two logs (interface, 6 decimals; system, 18) for one movement.
    await chain.send(otherKey, [{ to: chain.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ada.evm, parseUnits('20')] }) }]);
    // Native send of 2.5 USDC plus dust below one token unit: system log only.
    await chain.nativeSend(otherKey, ada.evm, 2_500_000_000_000_000_000n + 7n);
    await index();
    const rows = await incoming(ada);
    expect(rows.map((r) => [r.token, String(r.amount_units)])).toEqual([
      ['USDC', parseUnits('100').toString()],
      ['USDC', parseUnits('20').toString()],
      ['USDC', parseUnits('2.5').toString()],
    ]);
    const bal = await ok(h, { method: 'GET', url: '/wallet/balances', token: ada.token });
    expect(bal.pairs.find((p: { network: string }) => p.network === 'arc')).toMatchObject({ balance: '122.5', spendable: '122.5' });
  });

  it('settles a send on Arc: the system log matches the submitted transfer', async () => {
    const q = await ok(h, { method: 'POST', url: '/send/quote', token: ada.token, payload: { recipient: '@benarc', token: 'USDC', amount: '25' } });
    expect(q.network).toBe('arc');
    await stepUp(h, ada);
    const prep = await ok(h, { method: 'POST', url: '/send/prepare', token: ada.token, payload: { decisionId: q.check.decisionId, idempotencyKey: 'arc-send-1' } });
    expect(prep.bundle.sponsorship).toBe('arc_native_usdc');
    const [hash] = await chain.send(ada.key, prep.bundle.calls);
    await ok(h, { method: 'POST', url: '/send/submit', token: ada.token, payload: { transferId: prep.transferId, txHash: hash } });
    await index();
    expect((await ok(h, { method: 'GET', url: `/transfers/${prep.transferId}`, token: ada.token })).status).toBe('final');
    const benIn = await incoming(ben);
    expect(benIn).toHaveLength(1);
    expect(String(benIn[0].amount_units)).toBe(parseUnits('25').toString());
  });

  it('reads the blocklist precompile and indexes its events as issuer freezes', async () => {
    const victim = privateKeyToAccount(generatePrivateKey()).address;
    const arc = h.ctx.chains.arc!;
    expect(await arc.isFrozen(chain.usdc, victim)).toBe(false);
    await chain.setBlacklisted(victim, true);
    expect(await arc.isFrozen(chain.usdc, victim)).toBe(true);
    await index();
    const l = await h.ctx.db.query("SELECT label, status FROM network.listings WHERE address_key = lower($1)", [victim]);
    expect(l.rows[0]).toMatchObject({ label: 'issuer_frozen', status: 'confirmed' });
  });

  it('D1 on Arc: a payee blocklisted after delivery is refunded by the keeper', async () => {
    const fre = await signup(h, { handle: 'frearc' });
    await tier1(h, fre, 'Kemi', 'Ade');
    const ck = generatePrivateKey();
    const ca = privateKeyToAccount(ck).address;
    await chain.fund(ca);
    await chain.mint(ca, parseUnits('50'));
    await chain.fund(fre.evm);
    const due = new Date(h.clock.now.getTime() + 10 * 86_400_000).toISOString();
    const inv = await ok(h, { method: 'POST', url: '/invoices', token: fre.token, payload: { clientEmail: 'c@abroad.com', description: 'Copy', dueDate: due, milestones: [{ title: 'Copy', amount: '50', dueDate: due }] } });
    const pid = inv.milestones[0].id;
    const f = await ok(h, { method: 'POST', url: `/public/invoices/${inv.slug}/fund`, payload: { milestoneId: pid, network: 'arc', payerAddress: ca, clientCountry: 'US', confirmRefundToPayer: true } });
    await chain.send(ck, f.bundle.calls);
    await index();
    const d = await ok(h, { method: 'POST', url: `/payments/${pid}/deliveries`, token: fre.token, payload: { links: ['https://docs.example.com/copy'] } });
    await chain.send(fre.key, d.bundle.calls);
    await index();
    await chain.setBlacklisted(fre.evm, true);
    await chain.warp(7 * 86_400 + 5);
    await work();
    await work();
    expect((await ok(h, { method: 'GET', url: `/payments/${pid}`, token: fre.token })).status).toBe('refunded');
    expect(await usdc(ca)).toBe(parseUnits('50'));
  });
});
