import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addressKey, hexToTron, parseUnits } from '@backstop/shared';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { call, createHarness, ok, signup, stepUp, tier1, type Harness, type TestUser } from './helpers/harness.ts';
import { FakeChain } from './helpers/fakechain.ts';
import { inboundCheck, presendCheck, replayDecision } from '../src/services/checks.ts';
import { upsertListing } from '../src/services/fraudlist.ts';

const base = new FakeChain('base');
const tron = new FakeChain('tron');
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // testnet canonical (base sepolia)
const USDT_TRON = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';

let h: Harness;
let alice: TestUser;
let bob: TestUser;
const ext = () => privateKeyToAccount(generatePrivateKey()).address;

beforeAll(async () => {
  h = await createHarness({
    cfg: {
      chains: {
        base: { network: 'base', rpcUrls: ['http://fake'], tokens: { USDC }, finality: 'latest', startBlock: 0n },
        tron: { network: 'tron', rpcUrls: ['http://fake'], tokens: { USDT: USDT_TRON }, finality: 'solidified', startBlock: 0n },
      },
    },
    overrides: { chains: { base, tron } },
  });
  alice = await signup(h, { handle: 'alice' });
  bob = await signup(h, { handle: 'bob' });
  await tier1(h, alice, 'Alice', 'Ade');
  await tier1(h, bob, 'Bob', 'Bello');
});
afterAll(async () => {
  await h?.close();
});

async function quote(u: TestUser, body: Record<string, unknown>) {
  return call(h, { method: 'POST', url: '/send/quote', token: u.token, payload: body });
}

const codes = (r: { body: { check: { reasons: Array<{ code: string }> } } }) => r.body.check.reasons.map((x) => x.code).sort();

describe('C3 pre-send check', () => {
  it('blocks a bad checksum before anything else', async () => {
    const r = await quote(alice, { recipient: '0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913', token: 'USDC', amount: '10', network: 'base', networkConfirmed: true });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_address');
  });

  it('requires network confirmation for EVM addresses (L1-3)', async () => {
    const r = await quote(alice, { recipient: ext(), token: 'USDC', amount: '10', network: 'base' });
    expect(r.body.error.code).toBe('network_confirmation');
  });

  it('blocks token contracts and other contracts that cannot receive', async () => {
    const r = await quote(alice, { recipient: USDC, token: 'USDC', amount: '10', network: 'base', networkConfirmed: true });
    expect(r.body.check.decision).toBe('block');
    expect(codes(r)).toContain('contract_recipient');
    const c = ext();
    base.contracts.add(c.toLowerCase());
    const r2 = await quote(alice, { recipient: c, token: 'USDC', amount: '10', network: 'base', networkConfirmed: true });
    expect(codes(r2)).toEqual(['contract_recipient']);
  });

  it('routes Backstop users automatically: USDT on TRON, USDC on Arc else Base (C2-7)', async () => {
    const r = await quote(alice, { recipient: '@bob', token: 'USDT', amount: '5' });
    expect(r.status).toBe(200);
    expect(r.body.network).toBe('tron');
    expect(r.body.recipient.address).toBe(bob.tron);
    expect(r.body.fee).toBe('0');
    expect(r.body.check.decision).toBe('allow');
  });

  it('blocks a network a known service does not accept', async () => {
    const svc = ext();
    await h.ctx.db.query("INSERT INTO network.labelled_addresses (address_key, address, family, kind, name, accepts) VALUES ($1,$2,'evm','service','Acme Pay',$3)", [addressKey(svc), svc, ['base:USDC']]);
    const r = await quote(alice, { recipient: svc, token: 'USDC', amount: '5', network: 'ethereum', networkConfirmed: true });
    expect(r.body.check.decision).toBe('block');
    expect(codes(r)).toEqual(['network_not_accepted']);
    const r2 = await quote(alice, { recipient: svc, token: 'USDC', amount: '5', network: 'base', networkConfirmed: true });
    expect(r2.body.check.decision).toBe('allow');
  });

  it('blocks confirmed fraud and warns on reported addresses', async () => {
    const bad = ext();
    const reported = ext();
    await upsertListing(h.ctx.db, { address: bad, label: 'fraud', source: 'user_report', status: 'confirmed', now: h.clock.now, expiryMonths: 12 });
    await upsertListing(h.ctx.db, { address: reported, label: 'scam_report', source: 'public_scam_site', status: 'reported', now: h.clock.now, expiryMonths: 12 });
    const r = await quote(alice, { recipient: bad, token: 'USDC', amount: '10', network: 'base', networkConfirmed: true });
    expect(r.body.check.decision).toBe('block');
    expect(codes(r)).toContain('recipient_confirmed_fraud');
    const r2 = await quote(alice, { recipient: reported, token: 'USDC', amount: '10', network: 'base', networkConfirmed: true });
    expect(r2.body.check.decision).toBe('warn');
    expect(codes(r2)).toContain('recipient_under_review');
  });

  it('warns on a stranger above thresholds and offers the protected switch', async () => {
    const r = await quote(alice, { recipient: ext(), token: 'USDC', amount: '600', network: 'base', networkConfirmed: true });
    expect(codes(r)).toEqual(['new_payee_high_amount', 'support_unknown', 'unprotected_stranger']);
    expect(r.body.check.offerProtectedSwitch).toBe(true);
    expect(r.body.check.reasons.every((x: { body: string }) => x.body.length > 20)).toBe(true);
  });

  it('warns when the typed name does not match the verified name', async () => {
    const r = await quote(alice, { recipient: '@bob', token: 'USDC', amount: '5', typedName: 'Chinedu Eze' });
    expect(codes(r)).toEqual(['name_mismatch']);
    const ok2 = await quote(alice, { recipient: '@bob', token: 'USDC', amount: '5', typedName: 'bob bello' });
    expect(ok2.body.check.decision).toBe('allow');
  });

  it('warns on look-alike addresses from history', async () => {
    const known = '0x1234567890abcdef1234567890abcdef1234abcd';
    await h.ctx.db.query("INSERT INTO app.transfers (user_id, direction, network, token, amount_units, to_address, status) VALUES ($1,'out','base','USDC',1,$2,'final')", [alice.id, known]);
    const r = await quote(alice, { recipient: '0x1234000000000000000000000000000000ffabcd', token: 'USDC', amount: '10', network: 'base', networkConfirmed: true });
    expect(codes(r)).toContain('lookalike_address');
  });

  it('degrades to direct-list matching with a notice when the chain is slow', async () => {
    base.slowMs = 400;
    const r = await quote(alice, { recipient: ext(), token: 'USDC', amount: '10', network: 'base', networkConfirmed: true });
    base.slowMs = 0;
    expect(r.body.check.degraded).toBe(true);
    expect(r.body.check.degradedNotice).toMatch(/fraud list/);
    expect(r.body.check.latencyMs).toBeLessThan(300);
  });

  it('C3-2: warn can be overridden after confirming each reason; block never; overrides are logged', async () => {
    const r = await quote(alice, { recipient: ext(), token: 'USDC', amount: '600', network: 'base', networkConfirmed: true });
    const id = r.body.check.decisionId;
    const partial = await call(h, { method: 'POST', url: '/send/override', token: alice.token, payload: { decisionId: id, acknowledged: ['support_unknown'] } });
    expect(partial.status).toBe(400);
    await ok(h, { method: 'POST', url: '/send/override', token: alice.token, payload: { decisionId: id, acknowledged: r.body.check.reasons.map((x: { code: string }) => x.code) } });
    const row = await h.ctx.db.query('SELECT overridden_at FROM network.check_decisions WHERE id = $1', [id]);
    expect(row.rows[0].overridden_at).not.toBeNull();
    const audit = await h.ctx.db.query("SELECT 1 FROM audit.events WHERE action = 'check.override' AND subject_id = $1", [id]);
    expect(audit.rowCount).toBe(1);
    const blk = await quote(alice, { recipient: USDC, token: 'USDC', amount: '10', network: 'base', networkConfirmed: true });
    const o = await call(h, { method: 'POST', url: '/send/override', token: alice.token, payload: { decisionId: blk.body.check.decisionId, acknowledged: ['contract_recipient'] } });
    expect(o.status).toBe(403);
    await stepUp(h, alice);
    const prep = await call(h, { method: 'POST', url: '/send/prepare', token: alice.token, payload: { decisionId: blk.body.check.decisionId, idempotencyKey: 'blocked-1' } });
    expect(prep.body.error.code).toBe('blocked');
  });

  it('C3-6: every decision replays from stored facts, list version and rule version', async () => {
    const r = await quote(alice, { recipient: ext(), token: 'USDC', amount: '600', network: 'base', networkConfirmed: true });
    const rep = await replayDecision(h.ctx, h.ctx.db, r.body.check.decisionId);
    expect(rep.matches).toBe(true);
    expect(rep.ruleVersion).toBe('rules-2026-10-v1');
    expect(Number(rep.listVersion)).toBeGreaterThan(0);
  });

  it('C3-1: pre-send p95 is under 300 ms', async () => {
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      await presendCheck(h.ctx, h.ctx.db, { userId: alice.id, address: bob.tron, network: 'tron', token: 'USDT', amountUnits: parseUnits('20'), protectedPayment: false });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(300);
  });
});

describe('C3 inbound check', () => {
  const run = (from: string, amount: string, tokenContract = USDC) =>
    inboundCheck(h.ctx, h.ctx.db, { userId: alice.id, network: 'base', token: 'USDC', tokenContract, from, to: alice.evm, amountUnits: parseUnits(amount) });

  it('holds funds from a confirmed fraud address and reviews reported senders', async () => {
    const bad = ext();
    await upsertListing(h.ctx.db, { address: bad, label: 'fraud', source: 'user_report', status: 'confirmed', now: h.clock.now, expiryMonths: 12 });
    const r = await run(bad, '50');
    expect(r.decision).toBe('hold');
    expect(r.reasons.map((x) => x.code)).toEqual(['sender_confirmed_fraud']);
    const rep = ext();
    await upsertListing(h.ctx.db, { address: rep, label: 'scam_report', source: 'public_scam_site', status: 'reported', now: h.clock.now, expiryMonths: 12 });
    expect((await run(rep, '50')).decision).toBe('review');
  });

  it('ignores dust from listed addresses and hides it', async () => {
    const bad = ext();
    await upsertListing(h.ctx.db, { address: bad, label: 'fraud', source: 'user_report', status: 'confirmed', now: h.clock.now, expiryMonths: 12 });
    const r = await run(bad, '0.5');
    expect(r.availability).toBe('dust_hidden');
    expect(r.decision).toBe('allow');
  });

  it('marks fake tokens as unrecognised', async () => {
    const r = await run(ext(), '100', '0x0000000000000000000000000000000000000bad');
    expect(r.availability).toBe('unrecognised');
    expect(r.reasons[0]!.code).toBe('token_not_canonical');
  });

  it('holds on issuer-frozen senders', async () => {
    const f = ext();
    base.frozen.add(f.toLowerCase());
    expect((await run(f, '20')).reasons.map((x) => x.code)).toEqual(['issuer_frozen']);
  });

  it('traces indirect exposure: >=25% hold, >=5% review, stops at exchanges, ignores <$1', async () => {
    const bad = ext();
    const sender = ext();
    const clean = ext();
    const exchange = ext();
    await upsertListing(h.ctx.db, { address: bad, label: 'fraud', source: 'user_report', status: 'confirmed', now: h.clock.now, expiryMonths: 12 });
    const seed = async (from: string, to: string, amt: string, i: number) =>
      h.ctx.db.query('INSERT INTO network.chain_transfers (network, tx_hash, log_index, token_contract, from_key, to_key, amount_units, block_number, block_time) VALUES ($1,$2,$3,$4,$5,$6,$7,1,now())', [
        'base',
        `0x${String(i).padStart(64, '0')}`,
        i,
        addressKey(USDC),
        addressKey(from),
        addressKey(to),
        parseUnits(amt).toString(),
      ]);
    // sender received 30 from bad and 70 from clean -> 30% exposure -> hold
    await seed(bad, sender, '30', 1);
    await seed(clean, sender, '70', 2);
    const r = await run(sender, '100');
    expect(r.decision).toBe('hold');
    expect(r.exposure).toBeCloseTo(0.3, 3);
    expect(r.trace.some((t) => t.listed === 'fraud')).toBe(true);

    // two hops: s2 <- mid (100%) <- {bad 10, clean 90} => 10% -> review
    const s2 = ext();
    const mid = ext();
    await seed(mid, s2, '100', 3);
    await seed(bad, mid, '10', 4);
    await seed(clean, mid, '90', 5);
    const r2 = await run(s2, '50');
    expect(r2.decision).toBe('review');
    expect(r2.exposure).toBeCloseTo(0.1, 3);

    // labelled exchange in the path stops tracing
    await h.ctx.db.query("INSERT INTO network.labelled_addresses (address_key, address, family, kind, name) VALUES ($1,$2,'evm','exchange','Test Exchange')", [addressKey(exchange), exchange]);
    const s3 = ext();
    await seed(exchange, s3, '100', 6);
    await seed(bad, exchange, '100', 7);
    expect((await run(s3, '50')).decision).toBe('allow');

    // dust from bad is ignored in tracing
    const s4 = ext();
    await seed(bad, s4, '0.9', 8);
    await seed(clean, s4, '10', 9);
    expect((await run(s4, '5')).decision).toBe('allow');
  });

  it('labelled exchanges cannot be listed (C5-5)', async () => {
    const exchange = ext();
    await h.ctx.db.query("INSERT INTO network.labelled_addresses (address_key, address, family, kind, name) VALUES ($1,$2,'evm','exchange','Big Exchange')", [addressKey(exchange), exchange]);
    await expect(upsertListing(h.ctx.db, { address: exchange, label: 'fraud', source: 'user_report', status: 'confirmed', now: h.clock.now, expiryMonths: 12 })).rejects.toThrow(/cannot be listed/);
  });

  it('works for TRON addresses too', async () => {
    const t = hexToTron(ext());
    await upsertListing(h.ctx.db, { address: t, label: 'fraud', source: 'user_report', status: 'confirmed', now: h.clock.now, expiryMonths: 12 });
    const r = await inboundCheck(h.ctx, h.ctx.db, { userId: alice.id, network: 'tron', token: 'USDT', tokenContract: USDT_TRON, from: t, to: alice.tron, amountUnits: parseUnits('10') });
    expect(r.decision).toBe('hold');
  });
});
