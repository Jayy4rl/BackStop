// Applying inbound decisions to transfers (C2-6, C3-4, C3-5) and re-checking holds when the list
// changes (C5 appeals granted) or during the 30-day re-screen window (C3-7).
import { addressKey, deadlineFor, formatUnits, NETWORK_INFO, type Network, type Token } from '@backstop/shared';
import type { Ctx } from '../ctx.ts';
import { many, one, type Queryable } from '../db/pool.ts';
import { audit } from '../lib/audit.ts';
import { inboundCheck, type InboundResult } from './checks.ts';
import { notify, notifyStaff } from './notify.ts';

export interface TransferRow {
  id: string;
  user_id: string;
  network: Network;
  token: Token;
  token_contract: string;
  amount_units: string;
  from_address: string;
  to_address: string;
  availability: string;
  check_decision_id: string | null;
  final_at: Date | null;
  created_at: Date;
}

/** Writes a decision's availability onto the transfer, opens review cases and tells the user. */
export async function applyInboundDecision(ctx: Ctx, q: Queryable, t: TransferRow, r: InboundResult, opts: { rescreen?: boolean } = {}): Promise<void> {
  const holdReason = r.reasons.map((x) => x.title).join('; ') || null;
  const changed = t.availability !== r.availability;
  await q.query('UPDATE app.transfers SET availability = $2, hold_reason = $3, check_decision_id = $4 WHERE id = $1', [t.id, r.availability, holdReason, r.decisionId]);
  await audit(q, { type: 'system' }, opts.rescreen ? 'check.inbound.rescreen' : 'check.inbound', 'transfer', t.id, { decision: r.decision, availability: r.availability, reasons: r.reasons.map((x) => x.code), decisionId: r.decisionId });
  const vars = { amount: formatUnits(BigInt(t.amount_units)), token: t.token, network: NETWORK_INFO[t.network].label, reason: holdReason ?? '' };
  if (r.availability === 'under_review') {
    const rules = await ctx.versioned.rules();
    const holidays = await ctx.versioned.holidays();
    await q.query("INSERT INTO network.review_cases (kind, transfer_id, user_id, decision_id, due_at) VALUES ($1,$2,$3,$4,$5)", [
      opts.rescreen ? 'rescreen_change' : 'inbound',
      t.id,
      t.user_id,
      r.decisionId,
      deadlineFor(ctx.now(), { businessDays: rules.inbound.reviewSlaBusinessDays }, holidays),
    ]);
  }
  if (!opts.rescreen) {
    const kind = { available: 'incoming_available', on_hold: 'incoming_on_hold', under_review: 'incoming_review', unrecognised: 'incoming_unrecognised', dust_hidden: null }[r.availability];
    if (kind) await notify(q, { userId: t.user_id, kind, vars, data: { transferId: t.id }, dedupeKey: `incoming:${t.id}` });
  } else if (changed) {
    // C3-7: notify the user and the analyst if a decision would change.
    await notify(q, { userId: t.user_id, kind: 'rescreen_changed', vars: { decision: r.availability.replace('_', ' ') }, data: { transferId: t.id }, dedupeKey: `rescreen:${t.id}:${r.decisionId}` });
    await notifyStaff(q, 'risk_analyst', 'Re-screen changed a decision', `Transfer ${t.id} is now ${r.availability} (${r.reasons.map((x) => x.code).join(', ') || 'clear'}).`, { transferId: t.id }, `rescreen:${t.id}:${r.decisionId}`);
  }
}

export async function rescreenTransfer(ctx: Ctx, q: Queryable, t: TransferRow): Promise<InboundResult> {
  const r = await inboundCheck(ctx, q, {
    userId: t.user_id,
    network: t.network,
    token: t.token,
    tokenContract: t.token_contract,
    from: t.from_address,
    to: t.to_address,
    amountUnits: BigInt(t.amount_units),
    supersedes: t.check_decision_id,
  });
  // A held transfer that an analyst cleared stays cleared unless something new appears (new hold reason).
  const manual = await q.query("SELECT 1 FROM network.review_cases WHERE transfer_id = $1 AND status = 'cleared'", [t.id]);
  if (manual.rowCount && r.availability === 'under_review') return r;
  if (r.availability !== t.availability) await applyInboundDecision(ctx, q, t, r, { rescreen: true });
  return r;
}

/** After a listing is delisted (appeal granted), re-check every hold that could depend on it. */
export async function recheckHoldsForAddress(ctx: Ctx, q: Queryable, address: string): Promise<number> {
  const key = addressKey(address);
  const rows = await many<TransferRow>(
    q,
    `SELECT t.* FROM app.transfers t LEFT JOIN network.check_decisions d ON d.id = t.check_decision_id
     WHERE t.direction = 'in' AND t.availability IN ('on_hold','under_review')
       AND (lower(t.from_address) = $1 OR t.from_address = $2 OR d.inputs::text ILIKE '%' || $1 || '%')`,
    [key, address],
  );
  for (const t of rows) await rescreenTransfer(ctx, q, t);
  return rows.length;
}

/** Analyst clears or holds a transfer with a written reason (C3-5, C5 exposure-hold appeals). */
export async function setTransferAvailability(ctx: Ctx, q: Queryable, transferId: string, availability: 'available' | 'on_hold', reason: string, staffId: string): Promise<void> {
  const t = await one<TransferRow>(q, 'SELECT * FROM app.transfers WHERE id = $1', [transferId]);
  await q.query('UPDATE app.transfers SET availability = $2, hold_reason = $3 WHERE id = $1', [transferId, availability, availability === 'available' ? null : reason]);
  await audit(q, { type: 'staff', id: staffId }, availability === 'available' ? 'hold.cleared' : 'hold.applied', 'transfer', transferId, { reason });
  await notify(q, {
    userId: t.user_id,
    kind: availability === 'available' ? 'hold_cleared' : 'hold_applied',
    vars: { amount: formatUnits(BigInt(t.amount_units)), token: t.token, reason },
    data: { transferId },
    dedupeKey: `hold-change:${transferId}:${availability}:${Date.now()}`,
  });
}
