// Balances and spendable amounts (C2-5, C2-6, C3-4). Holds are honest: funds stay in the user's own
// wallet; the app only refuses to use held amounts for escrow, P2P or in-app payments.
import { formatNairaReference, formatUnits, NETWORK_INFO, type NairaRate, type Network, type Token } from '@backstop/shared';
import type { Ctx } from '../ctx.ts';
import { maybe, many, type Queryable } from '../db/pool.ts';
import { forbidden } from '../lib/errors.ts';
import { canonicalTokenFor } from './checks.ts';

export interface WalletRow {
  user_id: string;
  evm_address: string;
  tron_address: string;
}

export async function walletOf(q: Queryable, userId: string): Promise<WalletRow | null> {
  return maybe<WalletRow>(q, 'SELECT user_id, evm_address, tron_address FROM app.wallets WHERE user_id = $1', [userId]);
}

export function addressOn(w: WalletRow, network: Network): string {
  return NETWORK_INFO[network].family === 'tron' ? w.tron_address : w.evm_address;
}

export async function latestRate(ctx: Ctx, q: Queryable): Promise<NairaRate> {
  const r = await maybe<{ ngn_per_usd: string; source: string; as_of: Date }>(q, 'SELECT ngn_per_usd, source, as_of FROM app.rate_snapshots ORDER BY as_of DESC LIMIT 1');
  if (r && ctx.now().getTime() - r.as_of.getTime() < 6 * 3600_000) return { ngnPerUsd: String(r.ngn_per_usd), source: r.source, asOf: r.as_of.toISOString() };
  const fresh = await ctx.fx.latest();
  await q.query('INSERT INTO app.rate_snapshots (ngn_per_usd, source, as_of) VALUES ($1,$2,$3)', [fresh.ngnPerUsd, fresh.source, fresh.asOf]);
  return fresh;
}

export const PAIRS: Array<{ network: Network; token: Token }> = [
  { network: 'tron', token: 'USDT' },
  { network: 'arc', token: 'USDC' },
  { network: 'base', token: 'USDC' },
  { network: 'ethereum', token: 'USDC' },
  { network: 'ethereum', token: 'USDT' },
];

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p.catch(() => null), new Promise<null>((res) => (t = setTimeout(() => res(null), ms)))]);
  } finally {
    clearTimeout(t);
  }
}

/** Amounts on hold or under review for a user on one network/token. */
export async function heldUnits(q: Queryable, userId: string, network: Network, token: Token): Promise<bigint> {
  const r = await q.query(
    "SELECT coalesce(sum(amount_units),0) AS s FROM app.transfers WHERE user_id = $1 AND network = $2 AND token = $3 AND direction = 'in' AND availability IN ('on_hold','under_review') AND status = 'final'",
    [userId, network, token],
  );
  return BigInt(r.rows[0].s as string);
}

/** Balance derived from indexed final transfers, used when the chain is unreachable. */
async function ledgerBalance(q: Queryable, userId: string, network: Network, token: Token): Promise<bigint> {
  const r = await q.query(
    `SELECT coalesce(sum(CASE WHEN direction = 'in' THEN amount_units ELSE -amount_units END),0) AS s
     FROM app.transfers WHERE user_id = $1 AND network = $2 AND token = $3 AND status = 'final' AND availability NOT IN ('unrecognised','dust_hidden','unsupported_pair')`,
    [userId, network, token],
  );
  return BigInt(r.rows[0].s as string);
}

export interface PairBalance {
  network: Network;
  token: Token;
  address: string;
  balance: bigint;
  held: bigint;
  spendable: bigint;
  source: 'chain' | 'ledger';
}

export async function pairBalance(ctx: Ctx, q: Queryable, userId: string, w: WalletRow, network: Network, token: Token): Promise<PairBalance> {
  const address = addressOn(w, network);
  const tokenContract = canonicalTokenFor(ctx, network, token);
  const chain = ctx.chains[network];
  let balance: bigint | null = null;
  if (chain && tokenContract) balance = await withTimeout(chain.tokenBalance(tokenContract, address), 2_000);
  const source = balance === null ? 'ledger' : 'chain';
  if (balance === null) balance = await ledgerBalance(q, userId, network, token);
  // Dust from listed addresses is hidden from the balance (edge case: never counted).
  const dust = await q.query("SELECT coalesce(sum(amount_units),0) AS s FROM app.transfers WHERE user_id = $1 AND network = $2 AND token = $3 AND direction = 'in' AND availability = 'dust_hidden'", [userId, network, token]);
  if (source === 'chain') balance -= BigInt(dust.rows[0].s as string);
  if (balance < 0n) balance = 0n;
  const held = await heldUnits(q, userId, network, token);
  return { network, token, address, balance, held, spendable: balance > held ? balance - held : 0n, source };
}

export async function balances(ctx: Ctx, q: Queryable, userId: string) {
  const w = await walletOf(q, userId);
  if (!w) return null;
  const rate = await latestRate(ctx, q);
  const rows = await Promise.all(PAIRS.map((p) => pairBalance(ctx, q, userId, w, p.network, p.token)));
  const total = rows.reduce((s, r) => s + r.balance, 0n);
  const held = rows.reduce((s, r) => s + r.held, 0n);
  const holds = await many(
    q,
    `SELECT t.id, t.network, t.token, t.amount_units, t.availability, t.hold_reason, t.from_address, t.created_at, a.public_ref AS appeal_ref, a.status AS appeal_status
     FROM app.transfers t LEFT JOIN network.appeals a ON a.transfer_id = t.id
     WHERE t.user_id = $1 AND t.direction = 'in' AND t.availability IN ('on_hold','under_review') AND t.status = 'final' ORDER BY t.created_at DESC`,
    [userId],
  );
  const unrecognised = await many(q, "SELECT id, network, token, token_contract, amount_units, from_address, created_at FROM app.transfers WHERE user_id = $1 AND availability = 'unrecognised' ORDER BY created_at DESC LIMIT 20", [userId]);
  const unsupported = await many(q, "SELECT id, network, token, amount_units, created_at FROM app.transfers WHERE user_id = $1 AND availability = 'unsupported_pair' ORDER BY created_at DESC LIMIT 20", [userId]);
  return {
    pairs: rows.map((r) => ({ ...r, balance: formatUnits(r.balance), held: formatUnits(r.held), spendable: formatUnits(r.spendable), nairaReference: formatNairaReference(r.balance, rate) })),
    totalUsd: formatUnits(total),
    heldUsd: formatUnits(held),
    nairaReference: { value: formatNairaReference(total, rate), rate: rate.ngnPerUsd, source: rate.source, asOf: rate.asOf },
    holds,
    unrecognisedTokens: unrecognised,
    unsupportedArrivals: unsupported,
  };
}

/** C3-4: refuse to use held funds; explain why and how to appeal. */
export async function assertSpendable(ctx: Ctx, q: Queryable, userId: string, network: Network, token: Token, amount: bigint, what: string): Promise<void> {
  const w = await walletOf(q, userId);
  if (!w) throw forbidden('no_wallet', 'Set up your wallet first.');
  const b = await pairBalance(ctx, q, userId, w, network, token);
  if (b.spendable >= amount) return;
  if (b.balance >= amount)
    throw forbidden('funds_on_hold', `$${formatUnits(b.held)} of your ${token} on ${NETWORK_INFO[network].label} is on hold and can't be used for ${what}. See the hold reason and appeal from your wallet.`, {
      held: formatUnits(b.held),
      spendable: formatUnits(b.spendable),
    });
  throw forbidden('insufficient_funds', `You have $${formatUnits(b.spendable)} ${token} available on ${NETWORK_INFO[network].label}.`, { spendable: formatUnits(b.spendable) });
}
