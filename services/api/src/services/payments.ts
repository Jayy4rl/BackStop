// Protected payments (C4) shared by L2, L3 and L4. The chain is the source of truth: these
// functions record off-chain terms and evidence and build the calls a party signs; status changes
// only when the indexer sees the contract's events after finality (architecture doc).
import { randomUUID } from 'node:crypto';
import {
  allowedActions,
  contentHash,
  DISPUTE_EXPIRY_WARNING_SECONDS,
  FUNDING_WINDOW_SECONDS,
  formatUnits,
  LOOP_TERMS,
  NETWORK_INFO,
  OnChainState,
  orderRefFor,
  quoteEscrowFee,
  type EscrowLoop,
  type EscrowView,
  type Network,
  type PaymentStatus,
  type Role,
  type Token,
} from '@backstop/shared';
import type { Hex } from 'viem';
import type { Ctx } from '../ctx.ts';
import { maybe, many, one, type Queryable } from '../db/pool.ts';
import { audit, type Actor } from '../lib/audit.ts';
import { canonicalJson } from '../lib/crypto.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { deadlineFor } from '@backstop/shared';
import { canonicalTokenFor, counterpartyFundsCheck } from './checks.ts';
import { labelOf } from './fraudlist.ts';
import { assertIndexerFresh } from './health.ts';
import { assertWithinLimits } from './limits.ts';
import { notify } from './notify.ts';
import { approveCall, bundle, createEscrowCall, encodeTerms, escrowCall, type CallBundle, type PartyFn } from './txbuild.ts';
import { addressOn, assertSpendable, walletOf } from './wallet.ts';

export interface PaymentRow {
  id: string;
  tenant_id: number;
  loop: EscrowLoop;
  invoice_id: string | null;
  order_id: string | null;
  trade_id: string | null;
  part_index: number;
  title: string;
  payer_user_id: string | null;
  payee_user_id: string;
  payer_address: string | null;
  payee_address: string;
  refund_address: string | null;
  network: Network | null;
  token: Token;
  amount_units: string;
  fee_bps: number;
  fee_units: string;
  fee_schedule_version: string;
  deliver_by: Date;
  hold_period_seconds: number;
  auto_release: boolean;
  arbiter_timeout_seconds: number;
  order_ref: string;
  escrow_address: string | null;
  factory_address: string | null;
  status: PaymentStatus;
  funding_deadline: Date;
  funded_at: Date | null;
  delivered_at: Date | null;
  hold_until: Date | null;
  disputed_at: Date | null;
  released_at: Date | null;
  refunded_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  fee_owed_units: string;
  fee_collected: boolean;
  release_paused_reason: string | null;
  payee_frozen: boolean;
  approval_required: boolean;
  cancel_requested_by: string | null;
  cancel_requested_at: Date | null;
  payer_email: string | null;
  created_at: Date;
}

export interface NewPayment {
  loop: EscrowLoop;
  invoiceId?: string;
  orderId?: string;
  tradeId?: string;
  partIndex?: number;
  title: string;
  payerUserId: string | null;
  payerEmail?: string | null;
  payeeUserId: string;
  token: Token;
  network: Network | null;
  amountUnits: bigint;
  deliverBy: Date;
  splitFee?: boolean;
  approvalRequired?: boolean;
  /** L4: payment window instead of the default funding window. */
  fundingDeadline?: Date;
}

/** Records an off-chain `created` payment with its immutable terms and the fee shown before funding (C4-11). */
export async function createPayment(ctx: Ctx, q: Queryable, n: NewPayment): Promise<PaymentRow> {
  const id = randomUUID();
  const fees = await ctx.versioned.fees();
  const quote = quoteEscrowFee(n.loop, n.amountUnits, fees, !!n.splitFee);
  const terms = LOOP_TERMS[n.loop];
  const payeeWallet = await walletOf(q, n.payeeUserId);
  if (!payeeWallet) throw badRequest('payee_wallet', 'The payee has not set up their wallet.');
  const network = n.network;
  const payeeAddress = network ? addressOn(payeeWallet, network) : payeeWallet.evm_address;
  const now = ctx.now();
  return one<PaymentRow>(
    q,
    `INSERT INTO app.payments (id, loop, invoice_id, order_id, trade_id, part_index, title, payer_user_id, payer_email, payee_user_id, payee_address, network, token,
       amount_units, fee_bps, fee_units, fee_schedule_version, deliver_by, hold_period_seconds, auto_release, arbiter_timeout_seconds, order_ref, funding_deadline, approval_required)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
    [
      id,
      n.loop,
      n.invoiceId ?? null,
      n.orderId ?? null,
      n.tradeId ?? null,
      n.partIndex ?? 0,
      n.title,
      n.payerUserId,
      n.payerEmail ?? null,
      n.payeeUserId,
      payeeAddress,
      network,
      n.token,
      quote.amountUnits.toString(),
      quote.feeBps,
      quote.feeUnits.toString(),
      quote.scheduleVersion,
      n.deliverBy,
      terms.holdPeriod,
      terms.autoRelease,
      terms.arbiterTimeout,
      orderRefFor(ctx.cfg.tenantId, id),
      n.fundingDeadline ?? new Date(now.getTime() + FUNDING_WINDOW_SECONDS * 1000),
      !!n.approvalRequired,
    ],
  );
}

export async function getPayment(q: Queryable, id: string, lock = false): Promise<PaymentRow> {
  const p = await maybe<PaymentRow>(q, `SELECT * FROM app.payments WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!p) throw notFound('Payment not found.');
  return p;
}

export function roleOf(p: PaymentRow, userId: string): 'payer' | 'payee' | null {
  if (p.payer_user_id === userId) return 'payer';
  if (p.payee_user_id === userId) return 'payee';
  return null;
}

export function escrowView(p: PaymentRow): EscrowView {
  const s = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : null);
  return {
    status: p.status,
    deliverBy: Math.floor(p.deliver_by.getTime() / 1000),
    holdUntil: s(p.hold_until),
    disputedAt: s(p.disputed_at),
    autoRelease: p.auto_release,
    arbiterTimeout: p.arbiter_timeout_seconds,
    feeOwed: BigInt(p.fee_owed_units),
    feeCollected: p.fee_collected,
    payeeFrozen: p.payee_frozen,
  };
}

/** Public projection of a payment for its parties, including deadlines and what they can do now. */
export async function paymentView(ctx: Ctx, q: Queryable, p: PaymentRow, viewer: Role | null) {
  const now = Math.floor(ctx.now().getTime() / 1000);
  const actions = viewer ? allowedActions(escrowView(p), viewer, now) : [];
  // Auto-release paused while the payee address is reviewed (edge case); the app hides the payee's own release.
  const visible = p.release_paused_reason ? actions.filter((a) => a !== 'releaseAfterHold') : actions;
  const deliveries = await many(q, 'SELECT id, note, links, file_ids, tracking_number, carrier, tracking_validation, evidence_hash, created_at FROM app.deliveries WHERE payment_id = $1 ORDER BY created_at', [p.id]);
  const dispute = await maybe<Record<string, unknown>>(
    q,
    `SELECT id, status, opened_by_role, reason, evidence_due_at, ruling_due_at, review_window_ends_at, opened_onchain_at,
            CASE WHEN status IN ('ruled','awaiting_signatures','executed','closed') THEN coalesce(final_ruling, ruling) END AS ruling,
            CASE WHEN status IN ('ruled','awaiting_signatures','executed','closed') THEN coalesce(final_reason, ruling_reason) END AS ruling_reason,
            second_review_requested_at
     FROM network.disputes WHERE payment_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [p.id],
  );
  const disputeDeadline = p.status === 'funded' ? p.deliver_by : p.status === 'delivered' && p.auto_release ? p.hold_until : null;
  return {
    id: p.id,
    loop: p.loop,
    title: p.title,
    status: p.status,
    network: p.network,
    networkLabel: p.network ? NETWORK_INFO[p.network].label : null,
    token: p.token,
    amount: formatUnits(BigInt(p.amount_units)),
    fee: formatUnits(BigInt(p.fee_units)),
    feeBps: p.fee_bps,
    payeeReceives: formatUnits(BigInt(p.amount_units) - BigInt(p.fee_units)),
    feeRule: 'The fee is deducted only when money is released to the payee. Refunds return the full amount.',
    escrowAddress: p.escrow_address,
    payerAddress: p.payer_address,
    payeeAddress: p.payee_address,
    deliverBy: p.deliver_by,
    fundingDeadline: p.funding_deadline,
    holdUntil: p.hold_until,
    disputeDeadline,
    disputeWarningAt: disputeDeadline ? new Date(disputeDeadline.getTime() - DISPUTE_EXPIRY_WARNING_SECONDS * 1000) : null,
    autoRelease: p.auto_release,
    holdPeriodDays: p.hold_period_seconds / 86_400,
    releasePausedReason: p.release_paused_reason,
    payeeFrozen: p.payee_frozen,
    cancelRequestedBy: p.cancel_requested_by,
    viewerRole: viewer,
    actions: visible,
    deliveries,
    dispute,
    times: { created: p.created_at, funded: p.funded_at, delivered: p.delivered_at, disputed: p.disputed_at, released: p.released_at, refunded: p.refunded_at, cancelled: p.cancelled_at },
  };
}

/** Second approver (L3-7): business payer above its threshold needs an approved request by another member. */
export async function assertApproved(q: Queryable, p: PaymentRow, action: 'fund' | 'release'): Promise<void> {
  if (!p.payer_user_id) return;
  const biz = await maybe<{ second_approver_above_units: string | null }>(q, 'SELECT second_approver_above_units FROM app.businesses WHERE user_id = $1', [p.payer_user_id]);
  if (!biz?.second_approver_above_units || BigInt(p.amount_units) <= BigInt(biz.second_approver_above_units)) return;
  const ok = await maybe(q, "SELECT 1 FROM app.approval_requests WHERE payment_id = $1 AND action = $2 AND status = 'approved'", [p.id, action]);
  if (!ok) throw forbidden('approval_required', `A second approver must approve this ${action === 'fund' ? 'funding' : 'release'} first.`, { action });
}

export interface FundingRequest {
  network: Network;
  payerAddress: string;
  /** External payers confirm refunds return to the paying address (edge case: exchange addresses). */
  confirmRefundToPayer: boolean;
  actorUserId: string | null;
}

/**
 * Builds approve + createEscrow for the payer to sign (C3-3: the payer's funds are checked first).
 * Funding is refused when the indexer is behind (edge case) or the payer address is a labelled
 * exchange that could not receive a refund.
 */
export async function fundingBundle(ctx: Ctx, q: Queryable, p: PaymentRow, r: FundingRequest): Promise<{ bundle: CallBundle; escrowPredicted: string | null; check: { decision: string; reasons: unknown[] } }> {
  if (p.status !== 'created') throw conflict('not_fundable', `This payment is ${p.status}.`);
  if (p.funding_deadline < ctx.now()) throw conflict('funding_expired', 'This payment was not funded in time and is cancelled.');
  if (!['tron', 'arc', 'base'].includes(r.network)) throw badRequest('network', 'Protected payments are held on TRON (USDT), Arc or Base (USDC). From Ethereum, move USDC to Base first.');
  if ((r.network === 'tron') !== (p.token === 'USDT')) throw badRequest('network', `${p.token} protected payments are held on ${p.token === 'USDT' ? 'TRON' : 'Arc or Base'}.`);
  if (p.network && p.network !== r.network) throw badRequest('network', `This payment is set up on ${NETWORK_INFO[p.network].label}.`);
  await assertIndexerFresh(ctx, r.network);
  const chainCfg = ctx.cfg.chains[r.network]!;
  if (!chainCfg.factory) throw badRequest('network_unavailable', 'Protected payments are not available on this network yet.');
  const token = canonicalTokenFor(ctx, r.network, p.token);
  if (!token) throw badRequest('network_unavailable', 'This token is not available on this network.');
  const lab = await labelOf(q, r.payerAddress.startsWith('0x') ? r.payerAddress.toLowerCase() : r.payerAddress);
  if (lab && lab.kind === 'exchange')
    throw forbidden('exchange_payer', `That is a ${lab.name} exchange address. Exchange withdrawals cannot fund escrow and could not receive a refund. Pay from a wallet you control, or create a free Backstop account and pay from it.`);
  if (!r.confirmRefundToPayer) throw badRequest('refund_address', 'Confirm that any refund goes back to the paying wallet.');

  if (p.payer_user_id) {
    const w = await walletOf(q, p.payer_user_id);
    if (!w || addressOn(w, r.network) !== r.payerAddress) throw forbidden('payer_wallet', 'Fund from your Backstop wallet.');
    const u = await one<{ tier: 'tier1' | 'tier2' | 'counterparty' | 'none' }>(q, 'SELECT tier FROM app.users WHERE id = $1', [p.payer_user_id]);
    await assertWithinLimits(ctx, q, p.payer_user_id, u.tier, BigInt(p.amount_units));
    await assertSpendable(ctx, q, p.payer_user_id, r.network, p.token, BigInt(p.amount_units), 'protected payments');
    await assertApproved(q, p, 'fund');
  }
  // C3-3: inbound check on the counterparty's funds before they enter escrow.
  const check = await counterpartyFundsCheck(ctx, q, { userId: p.payer_user_id, network: r.network, token: p.token, payer: r.payerAddress, amountUnits: BigInt(p.amount_units) });
  if (check.decision !== 'allow') {
    await audit(q, { type: r.actorUserId ? 'user' : 'public', id: r.actorUserId }, 'escrow.funding_refused', 'payment', p.id, { decision: check.decision, reasons: check.reasons.map((x) => x.code) });
    throw forbidden('funds_not_accepted', check.decision === 'hold' ? 'These funds cannot be used for a protected payment.' : 'These funds need a quick review before they can be used. Try again after review.', {
      decision: check.decision,
      reasons: check.reasons,
    });
  }
  const payeeWallet = (await walletOf(q, p.payee_user_id))!;
  const payeeAddress = addressOn(payeeWallet, r.network);
  await q.query('UPDATE app.payments SET network = $2, payer_address = $3, payee_address = $4, refund_address = $3, factory_address = $5, payer_confirmed_refund_address = true, funding_check_id = $6 WHERE id = $1', [
    p.id,
    r.network,
    r.payerAddress,
    payeeAddress,
    chainCfg.factory,
    check.decisionId,
  ]);
  const terms = encodeTerms(r.network, {
    payer: r.payerAddress,
    payee: payeeAddress,
    token,
    amount: BigInt(p.amount_units),
    feeBps: p.fee_bps,
    deliverBy: BigInt(Math.floor(p.deliver_by.getTime() / 1000)),
    holdPeriod: p.hold_period_seconds,
    autoRelease: p.auto_release,
    arbiterTimeout: p.arbiter_timeout_seconds,
    orderRef: p.order_ref as Hex,
  });
  // On TRON approve and create are two transactions: approve the exact amount only (architecture doc).
  const calls = [approveCall(r.network, token, chainCfg.factory, BigInt(p.amount_units)), createEscrowCall(r.network, chainCfg.factory, terms)];
  return { bundle: bundle(r.network, calls, chainCfg.chainId), escrowPredicted: null, check: { decision: check.decision, reasons: check.reasons } };
}

/** Builds a party's signed action on its escrow, after the app-level guards. */
export function assertAction(p: PaymentRow, role: Role, fn: PartyFn, now: Date): void {
  if (!p.escrow_address || !p.network) throw conflict('not_funded', 'This payment is not funded yet.');
  const allowed = allowedActions(escrowView(p), role, Math.floor(now.getTime() / 1000));
  if (!allowed.includes(fn)) throw conflict('action_not_allowed', `You can't do that now (payment is ${p.status}).`, { allowed });
}

export function partyCall(p: PaymentRow, role: Role, fn: PartyFn, now: Date, hash?: Hex): CallBundle {
  assertAction(p, role, fn, now);
  return bundle(p.network!, [escrowCall(p.network!, p.escrow_address!, fn, hash)]);
}

/** Evidence bundle hash written on-chain with markDelivered or dispute (C4-8). */
export function evidenceHash(parts: Record<string, unknown>): Hex {
  return contentHash(canonicalJson(parts));
}

export async function recordDelivery(
  ctx: Ctx,
  q: Queryable,
  p: PaymentRow,
  userId: string,
  d: { note?: string; links: string[]; fileIds: string[]; trackingNumber?: string; carrier?: string; trackingValidation?: string },
): Promise<{ id: string; hash: Hex }> {
  const files = d.fileIds.length ? await many<{ id: string; sha256: string; filename: string }>(q, 'SELECT id, sha256, filename FROM app.files WHERE id = ANY($1) AND owner_user_id = $2 AND deleted_at IS NULL', [d.fileIds, userId]) : [];
  if (files.length !== d.fileIds.length) throw badRequest('files', 'Some files were not found. Upload them again.');
  const at = ctx.now().toISOString();
  const hash = evidenceHash({ paymentId: p.id, kind: 'delivery', note: d.note ?? '', links: d.links, files: files.map((f) => f.sha256).sort(), tracking: d.trackingNumber ?? '', carrier: d.carrier ?? '', at });
  const r = await one<{ id: string }>(
    q,
    'INSERT INTO app.deliveries (payment_id, submitted_by, note, links, file_ids, tracking_number, carrier, tracking_validation, evidence_hash, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
    [p.id, userId, d.note ?? null, d.links, d.fileIds, d.trackingNumber ?? null, d.carrier ?? null, d.trackingValidation ?? null, hash, at],
  );
  await q.query("UPDATE app.files SET attached_to = $2, attached_at = $3 WHERE id = ANY($1)", [d.fileIds, `delivery:${r.id}`, ctx.now()]);
  await audit(q, { type: 'user', id: userId }, 'escrow.delivery_recorded', 'payment', p.id, { deliveryId: r.id, hash });
  return { id: r.id, hash };
}

/** Records a dispute request with its opening evidence; becomes live at the on-chain Disputed event. */
export async function openDisputeRequest(
  ctx: Ctx,
  q: Queryable,
  p: PaymentRow,
  role: 'payer' | 'payee',
  userId: string | null,
  d: { reason: string; statement: string; fileIds: string[]; links: string[] },
): Promise<{ disputeId: string; hash: Hex }> {
  const open = await maybe<{ id: string; evidence_hash: string }>(q, "SELECT id, evidence_hash FROM network.disputes WHERE payment_id = $1 AND status NOT IN ('executed','closed')", [p.id]);
  if (open) return { disputeId: open.id, hash: open.evidence_hash as Hex };
  const holidays = await ctx.versioned.holidays();
  const lt = LOOP_TERMS[p.loop];
  const now = ctx.now();
  const files = d.fileIds.length ? await many<{ id: string; sha256: string }>(q, 'SELECT id, sha256 FROM app.files WHERE id = ANY($1) AND deleted_at IS NULL', [d.fileIds]) : [];
  const hash = evidenceHash({ paymentId: p.id, kind: 'dispute', by: role, reason: d.reason, statement: d.statement, links: d.links, files: files.map((f) => f.sha256).sort(), at: now.toISOString() });
  const dispute = await one<{ id: string }>(
    q,
    `INSERT INTO network.disputes (payment_id, loop, opened_by_role, opened_by_user, reason, evidence_due_at, ruling_due_at, evidence_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [p.id, p.loop, role, userId, d.reason, deadlineFor(now, lt.evidenceWindow, holidays), deadlineFor(now, lt.rulingTarget, holidays), hash],
  );
  await q.query("INSERT INTO network.dispute_evidence (dispute_id, party, user_id, kind, body, sha256) VALUES ($1,$2,$3,'statement',$4,$5)", [dispute.id, role, userId, d.statement, hash.slice(2)]);
  for (const f of files) await q.query("INSERT INTO network.dispute_evidence (dispute_id, party, user_id, kind, file_id, sha256) VALUES ($1,$2,$3,'file',$4,$5)", [dispute.id, role, userId, f.id, f.sha256]);
  for (const l of d.links) await q.query("INSERT INTO network.dispute_evidence (dispute_id, party, user_id, kind, url, sha256) VALUES ($1,$2,$3,'link',$4,$5)", [dispute.id, role, userId, l, contentHash(l).slice(2)]);
  // Delivery submissions, chat logs etc. are attached as system evidence for the reviewer.
  for (const del of await many<{ id: string; evidence_hash: string }>(q, 'SELECT id, evidence_hash FROM app.deliveries WHERE payment_id = $1', [p.id]))
    await q.query("INSERT INTO network.dispute_evidence (dispute_id, party, kind, body, sha256) VALUES ($1,'system','delivery',$2,$3)", [dispute.id, `delivery ${del.id}`, del.evidence_hash.slice(2)]);
  await audit(q, { type: userId ? 'user' : 'public', id: userId }, 'dispute.requested', 'dispute', dispute.id, { paymentId: p.id, role });
  return { disputeId: dispute.id, hash };
}

/** Applies an indexed on-chain state to the payment row. Idempotent: replays change nothing. */
export async function applyChainState(ctx: Ctx, q: Queryable, p: PaymentRow, next: PaymentStatus, at: Date, extra: Record<string, unknown> = {}, actor: Actor = { type: 'indexer' }): Promise<boolean> {
  if (p.status === next) return false;
  if (p.status === 'released' || p.status === 'refunded') return false; // terminal (I5)
  if (p.status === 'cancelled' && next !== 'funded') return false;
  const sets: string[] = ['status = $2'];
  const vals: unknown[] = [p.id, next];
  const col = { funded: 'funded_at', delivered: 'delivered_at', disputed: 'disputed_at', released: 'released_at', refunded: 'refunded_at' }[next as 'funded'];
  if (col) {
    vals.push(at);
    sets.push(`${col} = $${vals.length}`);
  }
  for (const [k, v] of Object.entries(extra)) {
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  await q.query(`UPDATE app.payments SET ${sets.join(', ')} WHERE id = $1`, vals);
  await audit(q, actor, `escrow.${next}`, 'payment', p.id, { from: p.status, ...extra });
  return true;
}

export const ON_CHAIN_TO_STATUS: Record<number, PaymentStatus> = {
  [OnChainState.Funded]: 'funded',
  [OnChainState.Delivered]: 'delivered',
  [OnChainState.Disputed]: 'disputed',
  [OnChainState.Released]: 'released',
  [OnChainState.Refunded]: 'refunded',
};

export async function notifyParties(q: Queryable, p: PaymentRow, kind: string, vars: Record<string, string | number>, dedupe: string): Promise<void> {
  const base = { title: p.title, amount: formatUnits(BigInt(p.amount_units)), token: p.token, ...vars };
  if (p.payer_user_id) await notify(q, { userId: p.payer_user_id, kind, vars: base, data: { paymentId: p.id }, dedupeKey: `${dedupe}:payer` });
  else if (p.payer_email) await notify(q, { email: p.payer_email, kind, vars: base, data: { paymentId: p.id }, dedupeKey: `${dedupe}:payer` });
  await notify(q, { userId: p.payee_user_id, kind, vars: base, data: { paymentId: p.id }, dedupeKey: `${dedupe}:payee` });
}
