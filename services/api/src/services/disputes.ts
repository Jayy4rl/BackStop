// Dispute rulings (C4-9), second review, 2-of-3 arbiter approval and execution (C4-4), and
// fraud findings opening C5 cases (C4-12).
import { addressKey, contentHash, type Network } from '@backstop/shared';
import type { Hex } from 'viem';
import type { Ctx } from '../ctx.ts';
import { many, maybe, one, type Queryable } from '../db/pool.ts';
import { audit } from '../lib/audit.ts';
import { canonicalJson } from '../lib/crypto.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { upsertListing } from './fraudlist.ts';
import { notify } from './notify.ts';
import { getPayment, type PaymentRow } from './payments.ts';

export interface DisputeRow {
  id: string;
  payment_id: string;
  loop: 'L2' | 'L3' | 'L4';
  opened_by_role: 'payer' | 'payee';
  reason: string;
  evidence_due_at: Date;
  ruling_due_at: Date;
  status: 'evidence' | 'in_review' | 'ruled' | 'awaiting_signatures' | 'executed' | 'closed';
  reviewer_id: string | null;
  ruling: 'release' | 'refund' | null;
  ruling_reason: string | null;
  ruling_hash: string | null;
  fraud_found: boolean;
  fraud_party: 'payer' | 'payee' | null;
  ruled_at: Date | null;
  second_review_requested_at: Date | null;
  second_reviewer_id: string | null;
  final_ruling: 'release' | 'refund' | null;
  final_reason: string | null;
  review_window_ends_at: Date | null;
  opened_onchain_at: Date | null;
  executed_at: Date | null;
}

export const REQUIRED_SIGNERS = 2;

/** Window after a ruling in which a party can ask for one second review (C4-9). */
export function reviewWindowMs(loop: string): number {
  return loop === 'L4' ? 2 * 3600_000 : 24 * 3600_000;
}

export async function getDispute(q: Queryable, id: string, lock = false): Promise<DisputeRow> {
  const d = await maybe<DisputeRow>(q, `SELECT * FROM network.disputes WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!d) throw notFound('Dispute not found.');
  return d;
}

export function effectiveRuling(d: DisputeRow): { ruling: 'release' | 'refund'; reason: string } | null {
  const r = d.final_ruling ?? d.ruling;
  const why = d.final_reason ?? d.ruling_reason;
  return r && why ? { ruling: r, reason: why } : null;
}

async function rulingHashFor(q: Queryable, d: DisputeRow, ruling: string, reason: string, reviewer: string, at: Date): Promise<Hex> {
  const ev = await many<{ sha256: string }>(q, 'SELECT sha256 FROM network.dispute_evidence WHERE dispute_id = $1 ORDER BY sha256', [d.id]);
  // The ruling document hash commits to the evidence hashes, so the on-chain record covers both (C4-8).
  return contentHash(canonicalJson({ disputeId: d.id, paymentId: d.payment_id, ruling, reason, reviewer, at: at.toISOString(), evidence: ev.map((e) => e.sha256) }));
}

export async function ruleDispute(ctx: Ctx, q: Queryable, id: string, staffId: string, r: { ruling: 'release' | 'refund'; reason: string; fraudFound: boolean; fraudParty?: 'payer' | 'payee' }): Promise<DisputeRow> {
  const d = await getDispute(q, id, true);
  if (!d.opened_onchain_at) throw conflict('not_live', 'This dispute has not been confirmed on-chain yet.');
  if (!['evidence', 'in_review'].includes(d.status)) throw conflict('already_ruled', `This dispute is ${d.status}.`);
  if (r.fraudFound && !r.fraudParty) throw badRequest('fraud_party', 'Say which party committed fraud.');
  const p = await getPayment(q, d.payment_id);
  const now = ctx.now();
  if (p.disputed_at && now.getTime() >= p.disputed_at.getTime() + p.arbiter_timeout_seconds * 1000) throw conflict('arbiter_timed_out', 'The arbiter timeout has passed; the payer can be refunded by anyone.');
  const second = !!d.second_review_requested_at;
  if (second && (staffId === d.reviewer_id)) throw forbidden('second_reviewer', 'A second review must be done by a different reviewer.');
  const hash = await rulingHashFor(q, d, r.ruling, r.reason, staffId, now);
  if (second) {
    await q.query(
      "UPDATE network.disputes SET second_reviewer_id = $2, final_ruling = $3, final_reason = $4, ruling_hash = $5, status = 'awaiting_signatures', fraud_found = $6, fraud_party = $7 WHERE id = $1",
      [id, staffId, r.ruling, r.reason, hash, r.fraudFound, r.fraudParty ?? null],
    );
  } else {
    await q.query(
      "UPDATE network.disputes SET reviewer_id = $2, ruling = $3, ruling_reason = $4, ruling_hash = $5, ruled_at = $6, review_window_ends_at = $7, status = 'ruled', fraud_found = $8, fraud_party = $9 WHERE id = $1",
      [id, staffId, r.ruling, r.reason, hash, now, new Date(now.getTime() + reviewWindowMs(d.loop)), r.fraudFound, r.fraudParty ?? null],
    );
  }
  await q.query('DELETE FROM network.arbiter_approvals WHERE dispute_id = $1 AND ruling_hash <> $2', [id, hash]);
  await audit(q, { type: 'staff', id: staffId }, second ? 'dispute.second_ruling' : 'dispute.ruled', 'dispute', id, { ruling: r.ruling, fraudFound: r.fraudFound, hash });
  // Both parties see the outcome and reason; one second review can be requested in the window.
  const ruleText = r.ruling === 'release' ? 'for the payee (release)' : 'for the payer (refund)';
  const vars = { title: p.title, ruling: ruleText, reason: second ? `${r.reason} (second review, final)` : `${r.reason} You can ask for one review by a second reviewer within ${d.loop === 'L4' ? '2 hours' : '24 hours'}.` };
  if (p.payer_user_id) await notify(q, { userId: p.payer_user_id, kind: 'ruling', vars, data: { disputeId: id }, dedupeKey: `ruling:${id}:${hash}:payer` });
  else if (p.payer_email) await notify(q, { email: p.payer_email, kind: 'ruling', vars, data: { disputeId: id }, dedupeKey: `ruling:${id}:${hash}:payer` });
  await notify(q, { userId: p.payee_user_id, kind: 'ruling', vars, data: { disputeId: id }, dedupeKey: `ruling:${id}:${hash}:payee` });
  if (r.fraudFound && r.fraudParty) await openFraudCaseFromRuling(ctx, q, p, d, r.fraudParty, staffId, r.reason);
  return getDispute(q, id);
}

/** C4-12: a ruling that finds fraud opens a C5 case automatically; ruling-based listings enter as confirmed. */
async function openFraudCaseFromRuling(ctx: Ctx, q: Queryable, p: PaymentRow, d: DisputeRow, party: 'payer' | 'payee', staffId: string, reason: string): Promise<void> {
  const address = party === 'payer' ? p.payer_address : p.payee_address;
  if (!address) return;
  const rules = await ctx.versioned.rules();
  const c = await one<{ id: string }>(
    q,
    `INSERT INTO network.fraud_cases (address_key, address, status, amount_units, analyst_id, decision_code, decision_reason, decided_at, due_at)
     VALUES ($1,$2,'confirmed',$3,$4,'dispute_ruling',$5,$6,$6) RETURNING id`,
    [addressKey(address), address, p.amount_units, staffId, reason, ctx.now()],
  );
  await q.query(
    `INSERT INTO network.fraud_reports (source, case_type, tx_hashes, suspect_addresses, network, amount_units, statement, related_payment_id, case_id, complete_at)
     VALUES ('dispute_ruling','non_delivery','{}',$1,$2,$3,$4,$5,$6,$7)`,
    [[address], p.network, p.amount_units, `Fraud found in dispute ${d.id}: ${reason}`, p.id, c.id, ctx.now()],
  );
  await upsertListing(q, { address, label: 'fraud', source: 'dispute_ruling', status: 'confirmed', caseId: c.id, confirmedBy: staffId, now: ctx.now(), expiryMonths: rules.fraudList.listingExpiryMonths }).catch(async (e: Error) => {
    await audit(q, { type: 'staff', id: staffId }, 'fraud.listing_refused', 'fraud_case', c.id, { reason: e.message });
  });
  await audit(q, { type: 'staff', id: staffId }, 'fraud.case_from_ruling', 'fraud_case', c.id, { disputeId: d.id, party });
}

/** A signer approves the current ruling; on the second distinct approval the ruling is executed. */
export async function approveRuling(ctx: Ctx, q: Queryable, id: string, staffId: string): Promise<{ approvals: number; executed: boolean; execution?: unknown }> {
  const d = await getDispute(q, id, true);
  const eff = effectiveRuling(d);
  if (!eff || !d.ruling_hash) throw conflict('no_ruling', 'There is no ruling to approve.');
  const now = ctx.now();
  const windowOpen = d.status === 'ruled' && d.review_window_ends_at && d.review_window_ends_at > now;
  if (windowOpen) throw conflict('review_window', `Parties can ask for a second review until ${d.review_window_ends_at!.toISOString()}.`);
  if (!['ruled', 'awaiting_signatures'].includes(d.status)) throw conflict('state', `This dispute is ${d.status}.`);
  const p = await getPayment(q, d.payment_id);
  if (p.disputed_at && now.getTime() >= p.disputed_at.getTime() + p.arbiter_timeout_seconds * 1000) throw conflict('arbiter_timed_out', 'The arbiter timeout has passed.');
  await q.query('INSERT INTO network.arbiter_approvals (dispute_id, ruling_hash, ruling, staff_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id, d.ruling_hash, eff.ruling, staffId]);
  await q.query("UPDATE network.disputes SET status = 'awaiting_signatures' WHERE id = $1 AND status = 'ruled'", [id]);
  const n = Number((await one<{ n: string }>(q, 'SELECT count(*) AS n FROM network.arbiter_approvals WHERE dispute_id = $1 AND ruling_hash = $2', [id, d.ruling_hash])).n);
  await audit(q, { type: 'staff', id: staffId }, 'arbiter.approved', 'dispute', id, { approvals: n, hash: d.ruling_hash });
  if (n < REQUIRED_SIGNERS) return { approvals: n, executed: false };
  if (!p.escrow_address || !p.network) throw conflict('not_funded', 'Payment has no escrow.');
  const execution = await ctx.arbiter.execute(p.network as Network, p.escrow_address, eff.ruling, d.ruling_hash as Hex);
  await q.query('UPDATE network.disputes SET execution = $2, executed_tx = $3 WHERE id = $1', [id, JSON.stringify(execution), execution.status === 'executed' ? execution.txHash : null]);
  await audit(q, { type: 'staff', id: staffId }, 'arbiter.execution', 'dispute', id, { execution });
  return { approvals: n, executed: execution.status === 'executed', execution };
}
