// Keeper and scheduled jobs (NFR Reliability of escrow: keeper jobs are idempotent, monitored, and
// backed by the payee's own release button after expiry). Time-based contract calls are
// permissionless, so a keeper failure never strands funds.
import { addressKey, type Network } from '@backstop/shared';
import type { Ctx } from '../ctx.ts';
import { maybe, many, one, tx } from '../db/pool.ts';
import { audit, SYSTEM } from '../lib/audit.ts';
import { enqueue, type Handler } from '../lib/jobs.ts';
import { addressStanding, addMonths, bumpVersion, upsertListing } from './fraudlist.ts';
import { rescreenTransfer, type TransferRow } from './holds.ts';
import { deliverNotification, notify, notifyStaff } from './notify.ts';
import { getPayment, notifyParties, type PaymentRow } from './payments.ts';
import { screenUser } from '../modules/identity.ts';
import { latestRate } from './wallet.ts';
import { indexAll } from './indexer.ts';

const KEEPER_MAX_ATTEMPTS = 3;
const ACTOR = { type: 'keeper' as const };

async function keeperCall(ctx: Ctx, p: PaymentRow, fn: 'releaseAfterHold' | 'collectFee' | 'refundAfterArbiterTimeout' | 'refundFrozenPayee'): Promise<string | null> {
  const chain = p.network ? ctx.chains[p.network as Network] : undefined;
  if (!chain || !p.escrow_address) return null;
  try {
    const hash = await chain.callEscrow(p.escrow_address, fn);
    await ctx.db.query('UPDATE app.payments SET keeper_last_error = NULL WHERE id = $1', [p.id]);
    await audit(ctx.db, ACTOR, `keeper.${fn}`, 'payment', p.id, { tx: hash });
    return hash;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    const r = await one<{ keeper_attempts: number }>(ctx.db, 'UPDATE app.payments SET keeper_attempts = keeper_attempts + 1, keeper_last_error = $2 WHERE id = $1 RETURNING keeper_attempts', [p.id, msg]);
    await audit(ctx.db, ACTOR, `keeper.${fn}.failed`, 'payment', p.id, { error: msg, attempts: r.keeper_attempts });
    if (fn === 'releaseAfterHold' && r.keeper_attempts >= KEEPER_MAX_ATTEMPTS) {
      // Edge case "keeper fails to auto-release": payee sees a release button; monitoring alerts staff.
      await notify(ctx.db, { userId: p.payee_user_id, kind: 'keeper_fallback', vars: { title: p.title }, data: { paymentId: p.id }, dedupeKey: `keeper-fallback:${p.id}` });
      await notifyStaff(ctx.db, 'admin', 'Keeper failed to auto-release', `Payment ${p.id} ("${p.title}") failed ${r.keeper_attempts} times: ${msg}`, { paymentId: p.id }, `keeper-fail:${p.id}`);
      await ctx.db.query("INSERT INTO network.review_cases (kind, payment_id, due_at) SELECT 'keeper_failure', $1, $2 WHERE NOT EXISTS (SELECT 1 FROM network.review_cases WHERE kind = 'keeper_failure' AND payment_id = $1)", [p.id, new Date(ctx.now().getTime() + 4 * 3600_000)]);
    }
    throw e;
  }
}

/** Auto-release at hold end, unless the payee address was listed during the hold (edge case). */
async function keeperRelease(ctx: Ctx, paymentId: string): Promise<void> {
  const p = await getPayment(ctx.db, paymentId);
  if (p.status !== 'delivered' || !p.auto_release || !p.hold_until || p.hold_until > ctx.now() || p.release_paused_reason) return;
  const standing = await addressStanding(ctx.db, addressKey(p.payee_address));
  if (standing.confirmed || standing.reported || standing.underAppeal) {
    await tx(ctx.db, async (q) => {
      await q.query('UPDATE app.payments SET release_paused_reason = $2 WHERE id = $1', [p.id, 'The payee address was reported or listed during the hold and is being reviewed.']);
      await q.query("INSERT INTO network.review_cases (kind, payment_id, user_id, due_at) VALUES ('payee_listed_during_hold', $1, $2, $3)", [p.id, p.payee_user_id, new Date(ctx.now().getTime() + 86_400_000)]);
      await notifyParties(q, p, 'release_paused', {}, `release-paused:${p.id}`);
      await audit(q, ACTOR, 'keeper.release_paused', 'payment', p.id, {});
    });
    return;
  }
  // D1: if the issuer froze the payee, releases revert; return the money to the payer instead.
  const chain = p.network ? ctx.chains[p.network as Network] : undefined;
  const token = chain && p.network ? ctx.cfg.chains[p.network as Network]?.tokens[p.token] : undefined;
  if (chain && token && (await chain.isFrozen(token, p.payee_address).catch(() => false))) {
    await ctx.db.query('UPDATE app.payments SET payee_frozen = true WHERE id = $1', [p.id]);
    await keeperCall(ctx, p, 'refundFrozenPayee');
    return;
  }
  await keeperCall(ctx, p, 'releaseAfterHold');
}

export function jobHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    deliver_notification: (pl) => deliverNotification(ctx, pl as { id: string; push: boolean; email: boolean }),
    keeper_release: (pl) => keeperRelease(ctx, String(pl.paymentId)),
    keeper_collect_fee: async (pl) => {
      const p = await getPayment(ctx.db, String(pl.paymentId));
      if (p.status === 'released' && BigInt(p.fee_owed_units) > 0n && !p.fee_collected) await keeperCall(ctx, p, 'collectFee');
    },
    keeper_arbiter_timeout: async (pl) => {
      const p = await getPayment(ctx.db, String(pl.paymentId));
      if (p.status !== 'disputed' || !p.disputed_at || p.disputed_at.getTime() + p.arbiter_timeout_seconds * 1000 > ctx.now().getTime()) return;
      await keeperCall(ctx, p, 'refundAfterArbiterTimeout');
    },
    arbiter_timeout_alert: async (pl) => {
      const p = await getPayment(ctx.db, String(pl.paymentId));
      if (p.status !== 'disputed' || !p.disputed_at) return;
      const at = new Date(p.disputed_at.getTime() + p.arbiter_timeout_seconds * 1000);
      // D2(c): the timeout should never fire in practice; alert staff well before it.
      await notifyStaff(ctx.db, 'dispute_reviewer', 'Arbiter timeout approaching', `"${p.title}" refunds the payer automatically at ${at.toISOString()} unless ruled.`, { paymentId: p.id }, `arbiter-alert:${p.id}`);
      await notifyStaff(ctx.db, 'arbiter_signer', 'Arbiter timeout approaching', `"${p.title}" refunds the payer automatically at ${at.toISOString()} unless ruled.`, { paymentId: p.id }, `arbiter-alert-s:${p.id}`);
    },
    release_reminder: async (pl) => {
      const p = await getPayment(ctx.db, String(pl.paymentId));
      if (p.status !== 'delivered' || !p.auto_release) return;
      const vars = { title: p.title, hours: Number(pl.hours) };
      if (p.payer_user_id) await notify(ctx.db, { userId: p.payer_user_id, kind: 'release_reminder', vars, dedupeKey: `reminder:${p.id}:${pl.hours}` });
      else if (p.payer_email) await notify(ctx.db, { email: p.payer_email, kind: 'release_reminder', vars, dedupeKey: `reminder:${p.id}:${pl.hours}` });
    },
    dispute_window_warning: async (pl) => {
      const p = await getPayment(ctx.db, String(pl.paymentId));
      if (p.status !== 'delivered' || !p.hold_until) return;
      const vars = { title: p.title, deadline: p.hold_until.toUTCString() };
      if (p.payer_user_id) await notify(ctx.db, { userId: p.payer_user_id, kind: 'dispute_window_closing', vars, dedupeKey: `dispute-warn:${p.id}` });
      else if (p.payer_email) await notify(ctx.db, { email: p.payer_email, kind: 'dispute_window_closing', vars, dedupeKey: `dispute-warn:${p.id}` });
    },
    rescreen_transfer: async (pl) => {
      const t = await maybe<TransferRow>(ctx.db, 'SELECT * FROM app.transfers WHERE id = $1', [pl.transferId]);
      if (!t || !t.final_at || !['available', 'under_review', 'on_hold'].includes(t.availability)) return;
      const rules = await ctx.versioned.rules();
      await tx(ctx.db, (q) => rescreenTransfer(ctx, q, t));
      const round = Number(pl.round);
      if (round < rules.inbound.rescreenDays) await enqueue(ctx.db, 'rescreen_transfer', { transferId: t.id, round: round + 1 }, { runAt: new Date(t.final_at.getTime() + (round + 1) * 86_400_000), dedupeKey: `rescreen:${t.id}:${round + 1}` });
    },
    sanctions_refresh: async () => {
      // C5-4: seed and refresh daily from sanctions lists; C1-6: re-screen users daily.
      const rules = await ctx.versioned.rules();
      const list = await ctx.sanctions.sanctionedAddresses();
      await tx(ctx.db, async (q) => {
        for (const a of list) await upsertListing(q, { address: a.address, label: 'sanctions', source: 'sanctions', status: 'confirmed', sourceRef: a.sourceRef, now: ctx.now(), expiryMonths: rules.fraudList.listingExpiryMonths }).catch(() => undefined);
        await audit(q, SYSTEM, 'sanctions.list_refreshed', 'list', null, { addresses: list.length, provider: ctx.sanctions.name });
      });
      const users = await many<{ id: string }>(ctx.db, "SELECT id FROM app.users WHERE status <> 'closed' AND (verified_name IS NOT NULL OR display_name IS NOT NULL)");
      for (const u of users) await screenUser(ctx, u.id).catch(() => undefined);
    },
    fx_refresh: async () => {
      const r = await ctx.fx.latest();
      await ctx.db.query('INSERT INTO app.rate_snapshots (ngn_per_usd, source, as_of) VALUES ($1,$2,$3)', [r.ngnPerUsd, r.source, r.asOf]);
    },
    index_chains: async () => {
      await indexAll(ctx);
    },
  };
}

/** Periodic sweep that schedules or performs due work. Safe to run concurrently (dedupe keys + state guards). */
export async function keeperSweep(ctx: Ctx): Promise<Record<string, number>> {
  const now = ctx.now();
  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);

  // C4-5: not funded within 72 hours (L4: the short funding window) -> cancelled. No fee.
  const stale = await many<PaymentRow>(ctx.db, "SELECT * FROM app.payments WHERE status = 'created' AND funding_deadline < $1", [now]);
  for (const p of stale) {
    await tx(ctx.db, async (q) => {
      const r = await q.query("UPDATE app.payments SET status = 'cancelled', cancelled_at = $2, cancel_reason = 'Not funded in time' WHERE id = $1 AND status = 'created'", [p.id, now]);
      if (!r.rowCount) return;
      if (p.trade_id) await q.query("UPDATE app.p2p_trades SET status = 'cancelled', cancelled_at = $2, cancel_reason = 'Seller did not fund in time', cancelled_by = seller_id WHERE id = $1 AND status = 'awaiting_escrow'", [p.trade_id, now]);
      await notifyParties(q, p, 'payment_cancelled', { reason: 'it was not funded in time' }, `cancelled:${p.id}`);
      await audit(q, ACTOR, 'escrow.cancelled_unfunded', 'payment', p.id, { reason: 'funding window passed' });
    });
    bump('cancelled');
  }

  // Auto-release, fee collection, arbiter timeouts: enqueue (deduped) in case an event-time job was missed.
  for (const p of await many<{ id: string }>(ctx.db, "SELECT id FROM app.payments WHERE status = 'delivered' AND auto_release AND hold_until <= $1 AND release_paused_reason IS NULL", [now])) {
    await enqueue(ctx.db, 'keeper_release', { paymentId: p.id }, { dedupeKey: `release:${p.id}` });
    bump('release');
  }
  for (const p of await many<{ id: string }>(ctx.db, "SELECT id FROM app.payments WHERE status = 'released' AND fee_owed_units > 0 AND NOT fee_collected")) {
    await enqueue(ctx.db, 'keeper_collect_fee', { paymentId: p.id }, { dedupeKey: `fee:${p.id}` });
    bump('fee');
  }
  for (const p of await many<{ id: string; disputed_at: Date }>(ctx.db, "SELECT id, disputed_at FROM app.payments WHERE status = 'disputed' AND disputed_at + make_interval(secs => arbiter_timeout_seconds) <= $1", [now])) {
    await enqueue(ctx.db, 'keeper_arbiter_timeout', { paymentId: p.id }, { dedupeKey: `arbiter-timeout:${p.id}:${p.disputed_at.getTime()}` });
    bump('arbiter_timeout');
  }

  // L4-6: buyer didn't mark paid in the window -> trade cancelled; the seller reclaims (only the payer can).
  for (const p of await many<PaymentRow>(ctx.db, "SELECT * FROM app.payments WHERE loop = 'L4' AND status = 'funded' AND deliver_by < $1", [now])) {
    await tx(ctx.db, async (q) => {
      const t = await maybe<{ id: string; seller_id: string; status: string }>(q, "SELECT id, seller_id, status FROM app.p2p_trades WHERE id = $1 AND status = 'escrowed' FOR UPDATE", [p.trade_id]);
      if (!t) return;
      await q.query("UPDATE app.p2p_trades SET status = 'cancelled', cancelled_at = $2, cancel_reason = 'Buyer did not mark paid in the payment window', cancelled_by = buyer_id WHERE id = $1", [t.id, now]);
      await q.query('INSERT INTO app.trade_messages (trade_id, body, system) VALUES ($1,$2,true)', [t.id, 'The payment window ended without the buyer marking the trade paid. The trade is cancelled; the seller can reclaim the USDT.']);
      await notify(q, { userId: t.seller_id, kind: 'p2p_trade_expired', vars: {}, data: { paymentId: p.id }, dedupeKey: `p2p-expired:${t.id}` });
      await audit(q, ACTOR, 'p2p.timer_expired', 'p2p_trade', t.id, {});
    });
    bump('p2p_expired');
  }

  // Disputes: evidence window ends -> in review; ruling review window ends -> signatures; stale requests close.
  await ctx.db.query("UPDATE network.disputes SET status = 'in_review' WHERE status = 'evidence' AND opened_onchain_at IS NOT NULL AND evidence_due_at < $1", [now]);
  const toSign = await many<{ id: string }>(ctx.db, "UPDATE network.disputes SET status = 'awaiting_signatures' WHERE status = 'ruled' AND review_window_ends_at < $1 RETURNING id", [now]);
  for (const d of toSign) await notifyStaff(ctx.db, 'arbiter_signer', 'Ruling ready for signatures', `Dispute ${d.id} needs two arbiter approvals.`, { disputeId: d.id }, `sign:${d.id}`);
  await ctx.db.query("UPDATE network.disputes SET status = 'closed' WHERE status = 'evidence' AND opened_onchain_at IS NULL AND created_at < $1", [new Date(now.getTime() - 2 * 3600_000)]);

  // SLA alerts (C3-5, C5-8, ruling targets, support): once per item per day.
  const day = now.toISOString().slice(0, 10);
  for (const r of await many<{ id: string }>(ctx.db, "SELECT id FROM network.review_cases WHERE status = 'open' AND due_at < $1", [now]))
    await notifyStaff(ctx.db, 'risk_analyst', 'Review overdue', `Review ${r.id} is past its 1-business-day target.`, { reviewId: r.id }, `sla-review:${r.id}:${day}`);
  for (const r of await many<{ id: string }>(ctx.db, "SELECT id FROM network.appeals WHERE status = 'open' AND due_at < $1", [now]))
    await notifyStaff(ctx.db, 'risk_analyst', 'Appeal overdue', `Appeal ${r.id} is past its 5-business-day target.`, { appealId: r.id }, `sla-appeal:${r.id}:${day}`);
  for (const r of await many<{ id: string }>(ctx.db, "SELECT id FROM network.fraud_cases WHERE status IN ('open','awaiting_second') AND due_at < $1", [now]))
    await notifyStaff(ctx.db, 'risk_analyst', 'Fraud case overdue', `Case ${r.id} is past its 2-business-day target.`, { caseId: r.id }, `sla-case:${r.id}:${day}`);
  for (const r of await many<{ id: string }>(ctx.db, "SELECT id FROM network.disputes WHERE status IN ('evidence','in_review') AND opened_onchain_at IS NOT NULL AND ruling_due_at < $1", [now]))
    await notifyStaff(ctx.db, 'dispute_reviewer', 'Ruling overdue', `Dispute ${r.id} is past its ruling target.`, { disputeId: r.id }, `sla-dispute:${r.id}:${day}`);
  for (const r of await many<{ id: string }>(ctx.db, "SELECT id FROM app.support_threads WHERE status = 'open' AND first_response_at IS NULL AND first_response_due < $1", [now]))
    await notifyStaff(ctx.db, 'support', 'Support response overdue', `Thread ${r.id} has had no human response within its target.`, { threadId: r.id }, `sla-support:${r.id}:${day}`);

  // C5-9: 12-month expiry and re-review of every confirmed listing (sanctions/issuer listings refresh daily instead).
  const expiring = await many<{ id: string; address: string; address_key: string }>(ctx.db, "SELECT id, address, address_key FROM network.listings WHERE status = 'confirmed' AND label IN ('fraud','scam_report') AND expires_at < $1", [now]);
  for (const l of expiring) {
    await tx(ctx.db, async (q) => {
      await q.query("UPDATE network.listings SET status = 'expired', updated_at = $2 WHERE id = $1 AND status = 'confirmed'", [l.id, now]);
      await bumpVersion(q, `expire ${l.address_key}`, l.id);
      await audit(q, ACTOR, 'listing.expired', 'listing', l.id, {});
    });
    bump('expired');
  }
  for (const l of await many<{ id: string; address: string }>(ctx.db, "SELECT id, address FROM network.listings WHERE status = 'confirmed' AND label IN ('fraud','scam_report') AND expires_at BETWEEN $1 AND $2", [now, addMonths(now, 1)]))
    await notifyStaff(ctx.db, 'risk_analyst', 'Listing due for re-review', `Listing ${l.id} (${l.address}) expires within a month. Renew with new evidence or let it expire.`, { listingId: l.id }, `rereview:${l.id}`);

  // Unused uploads are deleted after 7 days.
  const unused = await many<{ id: string; storage_key: string }>(ctx.db, 'SELECT id, storage_key FROM app.files WHERE attached_at IS NULL AND deleted_at IS NULL AND created_at < $1 AND purpose NOT IN (\'proforma\')', [new Date(now.getTime() - 7 * 86_400_000)]);
  for (const f of unused) {
    const referenced = await maybe(
      ctx.db,
      `SELECT 1 FROM app.deliveries WHERE $1 = ANY(file_ids) UNION SELECT 1 FROM network.dispute_evidence WHERE file_id = $1
       UNION SELECT 1 FROM network.appeals WHERE $1 = ANY(file_ids) OR $1 = ANY(reporter_file_ids) UNION SELECT 1 FROM network.fraud_reports WHERE $1 = ANY(file_ids)`,
      [f.id],
    );
    if (referenced) {
      await ctx.db.query('UPDATE app.files SET attached_at = $2 WHERE id = $1', [f.id, now]);
      continue;
    }
    await ctx.blobs.delete(f.storage_key);
    await ctx.db.query('UPDATE app.files SET deleted_at = $2 WHERE id = $1', [f.id, now]);
    bump('files_deleted');
  }

  await ctx.db.query("UPDATE app.payment_requests SET status = 'expired' WHERE status = 'open' AND expires_at < $1", [now]);

  // Daily and hourly schedules.
  await enqueue(ctx.db, 'sanctions_refresh', {}, { dedupeKey: `sanctions:${day}` });
  await enqueue(ctx.db, 'fx_refresh', {}, { dedupeKey: `fx:${now.toISOString().slice(0, 13)}` });
  return counts;
}

export async function ensureRate(ctx: Ctx): Promise<void> {
  await latestRate(ctx, ctx.db);
}

