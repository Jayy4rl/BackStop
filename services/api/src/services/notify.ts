// In-app, push and email notifications (L1-5, L2-5, C4-7, C5 appeals). Wording comes from per-locale
// templates so other Nigerian languages can be added (NFR Language).
import { fill, type Locale } from '@backstop/shared';
import type { Queryable } from '../db/pool.ts';
import type { Ctx } from '../ctx.ts';
import { enqueue } from '../lib/jobs.ts';

type Template = { title: string; body: string; email?: boolean; push?: boolean };

const EN: Record<string, Template> = {
  otp: { title: 'Your Backstop code', body: 'Your Backstop code is {code}. It expires in 10 minutes. Never share it.', email: true },
  incoming_available: { title: 'Money received', body: '{amount} {token} arrived on {network} and is available.', push: true },
  incoming_on_hold: { title: 'Money received and on hold', body: '{amount} {token} arrived on {network} but is on hold: {reason}. Tap to see why and how to appeal.', push: true, email: true },
  incoming_review: { title: 'Money received, under review', body: '{amount} {token} arrived on {network}. A risk analyst will review it within 1 business day.', push: true },
  incoming_unrecognised: { title: 'Unrecognised token received', body: 'A token calling itself {token} arrived, but it is not the official contract. It is not counted in your balance.', push: true },
  incoming_unsupported: { title: 'Funds on an unsupported network', body: '{token} arrived on {network}, which this address does not support. The money is still in your wallet; contact support to move it.', push: true, email: true },
  send_final: { title: 'Payment complete', body: 'Your payment of {amount} {token} to {to} is final.', push: true },
  send_failed: { title: 'Payment failed', body: 'Your payment of {amount} {token} to {to} failed. No money left your wallet.', push: true },
  hold_cleared: { title: 'Hold cleared', body: 'The hold on {amount} {token} has been cleared. {reason}', push: true, email: true },
  hold_applied: { title: 'Funds placed on hold', body: 'A risk analyst placed {amount} {token} on hold: {reason}. You can appeal.', push: true, email: true },
  rescreen_changed: { title: 'Check result changed', body: 'A re-check of a transfer you received changed its result to {decision}.', push: true, email: true },
  invoice_sent: { title: 'Invoice from {freelancer}', body: '{freelancer} sent you an invoice for {amount} {token}: {description}. Pay into protected escrow: {link}', email: true },
  order_sent: { title: 'Trade order from {importer}', body: '{importer} wants to order: {description} for {amount} {token}. Review and accept the terms: {link}', email: true },
  payment_funded: { title: 'Money is held in escrow', body: '{amount} {token} for "{title}" is now held in escrow. You can start work or ship.', push: true, email: true },
  payment_delivered: { title: 'Marked delivered', body: '"{title}" was marked delivered. Approve, or dispute before {deadline}. Otherwise it releases automatically.', push: true, email: true },
  payment_delivered_manual: { title: 'Buyer marked the naira as paid', body: 'Check your bank account. Confirm only when the naira has arrived in your account from {buyerName}.', push: true },
  payment_released: { title: 'Payment released', body: '{amount} {token} for "{title}" was released to the payee.', push: true, email: true },
  payment_refunded: { title: 'Payment refunded', body: '{amount} {token} for "{title}" was refunded to the payer.', push: true, email: true },
  payment_cancelled: { title: 'Payment cancelled', body: '"{title}" was cancelled: {reason}. No fee was charged.', push: true, email: true },
  release_reminder: { title: 'Auto-release in {hours} hours', body: '"{title}" releases automatically in {hours} hours. Approve it now, or open a dispute before then if something is wrong.', push: true, email: true },
  dispute_window_closing: { title: 'Dispute window closes in 24 hours', body: 'You can dispute "{title}" until {deadline}. After that the payment releases.', push: true, email: true },
  dispute_opened: { title: 'Dispute opened', body: 'A dispute was opened on "{title}". Upload your evidence before {deadline}. Release is paused until a reviewer rules.', push: true, email: true },
  ruling: { title: 'Ruling on "{title}"', body: 'The reviewer ruled {ruling}. Reason: {reason}', push: true, email: true },
  escrow_issuer_frozen: { title: 'Payment stuck: issuer freeze', body: 'The token issuer has frozen the escrow for "{title}". Your other payments are not affected. Backstop is preparing evidence for the issuer.', push: true, email: true },
  release_paused: { title: 'Auto-release paused for review', body: 'Auto-release of "{title}" is paused while Backstop reviews the payee address.', push: true, email: true },
  keeper_fallback: { title: 'You can release this payment now', body: 'The hold on "{title}" has ended. If it has not released, tap Release to claim it yourself.', push: true },
  p2p_trade_opened: { title: 'New P2P trade', body: '{buyerName} wants to buy {amount} USDT. Fund the escrow to start.', push: true },
  p2p_trade_escrowed: { title: 'USDT in escrow', body: 'The seller\'s USDT is in escrow. Pay {naira} to {bankName} ••••{last4} ({accountName}) from your own account within {minutes} minutes, then mark it paid.', push: true },
  p2p_trade_expired: { title: 'Trade cancelled', body: 'The buyer did not mark the trade paid in time. Reclaim your USDT from escrow with one tap.', push: true },
  appeal_received: { title: 'Appeal received', body: 'We received your appeal {ref}. An analyst who did not make the original decision will decide by {due}.', email: true },
  appeal_reporter: { title: 'An address you reported is being appealed', body: 'You can add evidence about {address} until {due}.', push: true, email: true },
  appeal_decided: { title: 'Appeal {ref}: {outcome}', body: '{reason}', email: true, push: true },
  report_decided: { title: 'Your fraud report was reviewed', body: 'Outcome: {outcome}. {reason}', push: true, email: true },
  account_suspended: { title: 'Account suspended', body: 'Your account was suspended: {reason}. Contact support to appeal.', email: true, push: true },
  support_reply: { title: 'Support replied', body: '{body}', push: true, email: true },
  recovery_started: { title: 'Wallet recovery started', body: 'Wallet recovery was started on your account. Outgoing transfers are locked until {until}. If this was not you, contact support now.', email: true, push: true },
  staff_alert: { title: '{title}', body: '{body}', email: true },
};

const TEMPLATES: Partial<Record<Locale, Record<string, Template>>> = { en: EN };

export interface NotifyInput {
  userId?: string | null;
  email?: string | null;
  kind: keyof typeof EN | string;
  vars?: Record<string, string | number>;
  data?: Record<string, unknown>;
  dedupeKey?: string;
  locale?: Locale;
}

export function render(kind: string, vars: Record<string, string | number> = {}, locale: Locale = 'en'): { title: string; body: string; t: Template } {
  const t = TEMPLATES[locale]?.[kind] ?? EN[kind];
  if (!t) throw new Error(`unknown notification template ${kind}`);
  return { title: fill(t.title, vars), body: fill(t.body, vars), t };
}

/** Records the notification and queues delivery. Deduplicated by key (keeper reminders run once). */
export async function notify(q: Queryable, n: NotifyInput): Promise<void> {
  const { title, body, t } = render(n.kind, n.vars, n.locale);
  const r = await q.query(
    `INSERT INTO app.notifications (user_id, email, kind, title, body, data, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [n.userId ?? null, n.email ?? null, n.kind, title, body, JSON.stringify(n.data ?? {}), n.dedupeKey ?? null],
  );
  if (!r.rowCount) return;
  const id = r.rows[0].id as string;
  if (t.push || t.email) await enqueue(q, 'deliver_notification', { id, push: !!t.push, email: !!t.email }, { dedupeKey: `deliver:${id}` });
}

export async function notifyStaff(q: Queryable, role: string, title: string, body: string, data: Record<string, unknown> = {}, dedupeKey?: string): Promise<void> {
  const staff = await q.query('SELECT email FROM app.staff WHERE active AND $1 = ANY(roles)', [role]);
  for (const s of staff.rows) {
    await notify(q, { email: s.email as string, kind: 'staff_alert', vars: { title, body }, data, dedupeKey: dedupeKey ? `${dedupeKey}:${s.email}` : undefined });
  }
}

/** Job handler: pushes to the user's devices and emails the user or address. */
export async function deliverNotification(ctx: Ctx, payload: { id: string; push: boolean; email: boolean }): Promise<void> {
  const r = await ctx.db.query(
    'SELECT n.*, u.email AS user_email FROM app.notifications n LEFT JOIN app.users u ON u.id = n.user_id WHERE n.id = $1',
    [payload.id],
  );
  const n = r.rows[0];
  if (!n) return;
  if (payload.push && n.user_id) {
    const tokens = await ctx.db.query('SELECT token FROM app.push_tokens WHERE user_id = $1', [n.user_id]);
    for (const t of tokens.rows) await ctx.messengers.push.send(ctx.db, { channel: 'push', to: t.token as string, subject: n.title, body: n.body, data: n.data });
  }
  const email = (n.email ?? n.user_email) as string | null;
  if (payload.email && email) await ctx.messengers.email.send(ctx.db, { channel: 'email', to: email, subject: n.title, body: n.body });
}
