// L4 P2P trading: verified users buy and sell USDT for naira. The seller's USDT waits in escrow on
// TRON; the buyer pays naira bank to bank from their own verified account; the seller confirms and
// the USDT releases. Backstop never touches naira. Off unless legal gate G2 is cleared (P2P_ENABLED).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatUnits, namesAgree, matchNames, parseUnits, P2P_DEFAULT_PAYMENT_WINDOW_SECONDS, scanForContactDetails } from '@backstop/shared';
import type { Ctx } from '../ctx.ts';
import { maybe, many, one, tx, type Queryable } from '../db/pool.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { assertCanMoveMoney, assertTier, j, parse, requireUser, type SessionInfo, zAmount, zUuid } from '../http.ts';
import { notify } from '../services/notify.ts';
import { assertAction, createPayment, fundingBundle, getPayment, openDisputeRequest, partyCall, paymentView, recordDelivery, type PaymentRow } from '../services/payments.ts';
import { renderPdf, signDocument } from '../services/documents.ts';
import { addressOn, walletOf } from '../services/wallet.ts';
import { assertIndexerFresh } from '../services/health.ts';
import { contentHash } from '@backstop/shared';

/** Platform bounds for per-merchant settings (L4-10). */
export const P2P_BOUNDS = { windowMinutes: { min: 15, max: 60 }, feeBps: { min: 50, max: 100 } };
const FUNDING_MINUTES = 15;

interface TradeRow {
  id: string;
  offer_id: string;
  seller_id: string;
  buyer_id: string;
  amount_units: string;
  price_ngn: string;
  naira_kobo: string;
  seller_bank_account_id: string;
  buyer_bank_account_id: string;
  payment_id: string | null;
  status: string;
  payment_deadline: Date | null;
  marked_paid_at: Date | null;
  confirmed_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  created_at: Date;
}

function gate(ctx: Ctx): void {
  if (!ctx.cfg.p2pEnabled) throw forbidden('p2p_unavailable', 'P2P trading is not available yet.');
}

async function reputation(q: Queryable, userId: string) {
  const r = await one<{ completed: string; disputed: string; total: string; cancels_today: string }>(
    q,
    `SELECT count(*) FILTER (WHERE t.status = 'released') AS completed,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM network.disputes d WHERE d.payment_id = t.payment_id AND d.opened_onchain_at IS NOT NULL)) AS disputed,
            count(*) FILTER (WHERE t.status IN ('released','refunded','disputed')) AS total,
            count(*) FILTER (WHERE t.status = 'cancelled' AND t.cancelled_by = $1 AND t.cancelled_at > now() - interval '1 day') AS cancels_today
     FROM app.p2p_trades t WHERE t.seller_id = $1 OR t.buyer_id = $1`,
    [userId],
  );
  const total = Number(r.total);
  return { completedTrades: Number(r.completed), disputeRate: total ? Math.round((Number(r.disputed) / total) * 1000) / 10 : 0, cancellationsToday: Number(r.cancels_today) };
}

async function bankAccount(q: Queryable, id: string, userId: string) {
  const b = await maybe<{ id: string; user_id: string; bank_name: string; account_last4: string; account_name: string; verified_at: Date | null; removed_at: Date | null; account_number_enc: Buffer }>(
    q,
    'SELECT * FROM app.bank_accounts WHERE id = $1',
    [id],
  );
  if (!b || b.user_id !== userId || b.removed_at || !b.verified_at) throw badRequest('bank_account', 'Choose one of your verified bank accounts.');
  return b;
}

/** Naira amount in kobo: USDT units (1e6) × price (2 decimals). */
function nairaKobo(amountUnits: bigint, priceNgn: string): bigint {
  const [w = '0', f = ''] = priceNgn.split('.');
  const priceKobo = BigInt(w) * 100n + BigInt(f.padEnd(2, '0').slice(0, 2));
  return (amountUnits * priceKobo) / 1_000_000n;
}

const fmtNaira = (kobo: bigint) => `₦${(kobo / 100n).toLocaleString('en-US')}.${(kobo % 100n).toString().padStart(2, '0')}`;

export function registerP2p(app: FastifyInstance, ctx: Ctx): void {
  // L4-3: register bank accounts; the account name must match the verified name (bank name enquiry).
  app.post('/bank-accounts', async (req) => {
    const s = await requireUser(ctx, req);
    gate(ctx);
    assertTier(s, ['tier1', 'tier2'], 'Bank accounts for P2P');
    const b = parse(z.object({ bankCode: z.string().min(3).max(10), accountNumber: z.string().regex(/^\d{10}$/, 'Account numbers are 10 digits') }), req.body);
    const bank = ctx.bank.banks().find((x) => x.code === b.bankCode);
    if (!bank) throw badRequest('bank', 'Choose a bank from the list.');
    const r = await ctx.bank.nameEnquiry(b.bankCode, b.accountNumber, { expectedName: s.user.verified_name ?? undefined });
    if (!r.found || !r.accountName) throw badRequest('account_not_found', 'The bank could not find that account.');
    const match = matchNames(r.accountName, s.user.verified_name ?? '');
    const agrees = namesAgree(r.accountName, s.user.verified_name ?? '');
    const row = await one<{ id: string }>(
      ctx.db,
      `INSERT INTO app.bank_accounts (user_id, bank_code, bank_name, account_number_enc, account_number_hmac, account_last4, account_name, name_match, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [s.user.id, b.bankCode, bank.name, ctx.crypto.encrypt(b.accountNumber, `bank:${s.user.id}`), ctx.crypto.lookupHmac('nuban', `${b.bankCode}:${b.accountNumber}`), b.accountNumber.slice(-4), r.accountName, match, agrees ? ctx.now() : null],
    ).catch((e: Error & { code?: string }) => {
      if (e.code === '23505') throw conflict('account_registered', 'This bank account is already registered on Backstop.');
      throw e;
    });
    await audit(ctx.db, { type: 'user', id: s.user.id }, agrees ? 'bank_account.verified' : 'bank_account.name_mismatch', 'bank_account', row.id, { match });
    if (!agrees) throw forbidden('name_mismatch', `The account name "${r.accountName}" does not match your verified name. You can only use accounts in your own name.`);
    return { id: row.id, bankName: bank.name, accountName: r.accountName, last4: b.accountNumber.slice(-4) };
  });

  app.get('/bank-accounts', async (req) => {
    const s = await requireUser(ctx, req);
    return j({ accounts: await many(ctx.db, 'SELECT id, bank_code, bank_name, account_last4, account_name, verified_at, created_at FROM app.bank_accounts WHERE user_id = $1 AND removed_at IS NULL AND verified_at IS NOT NULL ORDER BY created_at', [s.user.id]), banks: ctx.bank.banks() });
  });

  app.delete('/bank-accounts/:id', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await ctx.db.query('UPDATE app.bank_accounts SET removed_at = $3 WHERE id = $1 AND user_id = $2', [id, s.user.id, ctx.now()]);
    return { ok: true };
  });

  // L4-1/L4-10: offers with price, limits, payment window and fee within platform bounds.
  app.post('/p2p/offers', async (req) => {
    const s = await requireUser(ctx, req);
    gate(ctx);
    assertTier(s, ['tier1', 'tier2'], 'P2P offers');
    const b = parse(
      z.object({
        side: z.enum(['sell', 'buy']),
        priceNgn: z.string().regex(/^\d{1,7}(\.\d{1,2})?$/),
        min: zAmount,
        max: zAmount,
        paymentWindowMinutes: z.number().int().min(P2P_BOUNDS.windowMinutes.min).max(P2P_BOUNDS.windowMinutes.max).default(P2P_DEFAULT_PAYMENT_WINDOW_SECONDS / 60),
        feeBps: z.number().int().min(P2P_BOUNDS.feeBps.min).max(P2P_BOUNDS.feeBps.max).optional(),
        bankAccountId: zUuid,
        terms: z.string().max(1_000).optional(),
      }),
      req.body,
    );
    const contact = scanForContactDetails(b.terms ?? '');
    if (contact.blocked) throw badRequest('contact_details', 'Offer terms cannot include phone numbers, emails, links or messenger handles.');
    await bankAccount(ctx.db, b.bankAccountId, s.user.id);
    // L4-2: merchants with volume above a set amount must be Tier 2.
    const limits = await ctx.versioned.limits();
    const vol = await one<{ v: string }>(ctx.db, "SELECT coalesce(sum(amount_units),0) AS v FROM app.p2p_trades WHERE (seller_id = $1 OR buyer_id = $1) AND status = 'released' AND created_at > now() - interval '30 days'", [s.user.id]);
    if (BigInt(vol.v) > limits.p2pMerchantTier2VolumeUnits && s.user.tier !== 'tier2') throw forbidden('tier2_required', `Merchants trading more than $${formatUnits(limits.p2pMerchantTier2VolumeUnits)} a month must verify as a business (Tier 2).`);
    const fees = await ctx.versioned.fees();
    const r = await one(
      ctx.db,
      `INSERT INTO app.p2p_offers (merchant_id, side, price_ngn, min_units, max_units, payment_window_seconds, fee_bps, bank_account_id, terms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [s.user.id, b.side, b.priceNgn, parseUnits(b.min).toString(), parseUnits(b.max).toString(), b.paymentWindowMinutes * 60, b.feeBps ?? fees.l4.bps, b.bankAccountId, b.terms ?? null],
    );
    return j(r);
  });

  app.patch('/p2p/offers/:id', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ status: z.enum(['active', 'paused', 'closed']) }), req.body);
    await ctx.db.query('UPDATE app.p2p_offers SET status = $3 WHERE id = $1 AND merchant_id = $2', [id, s.user.id, b.status]);
    return { ok: true };
  });

  // Offer book with merchant reputation. L4-9: repeated cancellations lower visibility.
  app.get('/p2p/offers', async (req) => {
    await requireUser(ctx, req);
    gate(ctx);
    const qy = parse(z.object({ side: z.enum(['sell', 'buy']).default('sell') }), req.query);
    const limits = await ctx.versioned.limits();
    const offers = await many<{ id: string; merchant_id: string; side: string; price_ngn: string; min_units: string; max_units: string; payment_window_seconds: number; fee_bps: number; terms: string | null; handle: string; verified_name: string; tier: string }>(
      ctx.db,
      `SELECT o.*, u.handle, u.verified_name, u.tier FROM app.p2p_offers o JOIN app.users u ON u.id = o.merchant_id
       WHERE o.status = 'active' AND o.side = $1 AND u.status = 'active'`,
      [qy.side],
    );
    const withRep = await Promise.all(offers.map(async (o) => ({ ...o, reputation: await reputation(ctx.db, o.merchant_id) })));
    const visible = withRep
      .map((o) => ({ ...o, demoted: o.reputation.cancellationsToday >= limits.p2pMaxCancellationsPerDay }))
      .sort((a, b) => Number(a.demoted) - Number(b.demoted) || (qy.side === 'sell' ? Number(a.price_ngn) - Number(b.price_ngn) : Number(b.price_ngn) - Number(a.price_ngn)));
    return j({
      offers: visible.map((o) => ({
        id: o.id,
        side: o.side,
        priceNgn: o.price_ngn,
        min: formatUnits(BigInt(o.min_units)),
        max: formatUnits(BigInt(o.max_units)),
        paymentWindowMinutes: o.payment_window_seconds / 60,
        feeBps: o.fee_bps,
        terms: o.terms,
        merchant: { handle: o.handle, verifiedName: o.verified_name, tier: o.tier, ...o.reputation },
        demoted: o.demoted,
      })),
    });
  });

  // Step 2: pick an offer and amount; both sides see each other's verified name, trades and dispute rate.
  app.post('/p2p/trades', async (req) => {
    const s = await requireUser(ctx, req);
    gate(ctx);
    assertTier(s, ['tier1', 'tier2'], 'P2P trading');
    assertCanMoveMoney(ctx, s, { stepUp: false });
    const b = parse(z.object({ offerId: zUuid, amount: zAmount, bankAccountId: zUuid }), req.body);
    await assertIndexerFresh(ctx, 'tron');
    const offer = await maybe<{ id: string; merchant_id: string; side: 'sell' | 'buy'; price_ngn: string; min_units: string; max_units: string; payment_window_seconds: number; fee_bps: number; bank_account_id: string; status: string }>(
      ctx.db,
      'SELECT * FROM app.p2p_offers WHERE id = $1',
      [b.offerId],
    );
    if (!offer || offer.status !== 'active') throw notFound('Offer not available.');
    if (offer.merchant_id === s.user.id) throw badRequest('own_offer', 'You cannot trade with your own offer.');
    const amount = parseUnits(b.amount);
    if (amount < BigInt(offer.min_units) || amount > BigInt(offer.max_units)) throw badRequest('amount', `Choose between $${formatUnits(BigInt(offer.min_units))} and $${formatUnits(BigInt(offer.max_units))}.`);
    const merchant = await one<{ tier: string; status: string }>(ctx.db, 'SELECT tier, status FROM app.users WHERE id = $1', [offer.merchant_id]);
    if (merchant.status !== 'active' || !['tier1', 'tier2'].includes(merchant.tier)) throw forbidden('merchant_unavailable', 'This merchant cannot trade right now.');
    await bankAccount(ctx.db, b.bankAccountId, s.user.id);
    const sellerId = offer.side === 'sell' ? offer.merchant_id : s.user.id;
    const buyerId = offer.side === 'sell' ? s.user.id : offer.merchant_id;
    const sellerBank = offer.side === 'sell' ? offer.bank_account_id : b.bankAccountId;
    const buyerBank = offer.side === 'sell' ? b.bankAccountId : offer.bank_account_id;
    const id = await tx(ctx.db, async (q) => {
      const trade = await one<{ id: string }>(
        q,
        `INSERT INTO app.p2p_trades (offer_id, seller_id, buyer_id, amount_units, price_ngn, naira_kobo, seller_bank_account_id, buyer_bank_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [offer.id, sellerId, buyerId, amount.toString(), offer.price_ngn, nairaKobo(amount, offer.price_ngn).toString(), sellerBank, buyerBank],
      );
      const fundingDeadline = new Date(ctx.now().getTime() + FUNDING_MINUTES * 60_000);
      const p = await createPayment(ctx, q, {
        loop: 'L4',
        tradeId: trade.id,
        title: `P2P: ${formatUnits(amount)} USDT at ₦${offer.price_ngn}`,
        payerUserId: sellerId,
        payeeUserId: buyerId,
        token: 'USDT',
        network: 'tron',
        amountUnits: amount,
        // Provisional; fixed to "end of the payment window" when the seller funds.
        deliverBy: new Date(fundingDeadline.getTime() + offer.payment_window_seconds * 1000),
        fundingDeadline,
      });
      // Merchant-set fee within bounds (L4-10): recompute the payment's fee terms.
      const feeUnits = (amount * BigInt(offer.fee_bps)) / 10_000n;
      await q.query('UPDATE app.payments SET fee_bps = $2, fee_units = $3 WHERE id = $1', [p.id, offer.fee_bps, feeUnits.toString()]);
      await q.query('UPDATE app.p2p_trades SET payment_id = $2 WHERE id = $1', [trade.id, p.id]);
      const buyer = await one<{ verified_name: string }>(q, 'SELECT verified_name FROM app.users WHERE id = $1', [buyerId]);
      await notify(q, { userId: sellerId, kind: 'p2p_trade_opened', vars: { buyerName: buyer.verified_name, amount: formatUnits(amount) }, dedupeKey: `p2p-open:${trade.id}` });
      await q.query("INSERT INTO app.trade_messages (trade_id, body, system) VALUES ($1, $2, true)", [trade.id, 'Trade opened. The seller funds the escrow, then the buyer pays naira from their own registered account.']);
      await audit(q, { type: 'user', id: s.user.id }, 'p2p.trade_opened', 'p2p_trade', trade.id, { offerId: offer.id });
      return trade.id;
    });
    return j(await tradeView(ctx, id, s.user.id));
  });

  app.get('/p2p/trades', async (req) => {
    const s = await requireUser(ctx, req);
    const rows = await many<{ id: string }>(ctx.db, 'SELECT id FROM app.p2p_trades WHERE seller_id = $1 OR buyer_id = $1 ORDER BY created_at DESC LIMIT 100', [s.user.id]);
    return j({ trades: await Promise.all(rows.map((r) => tradeView(ctx, r.id, s.user.id))) });
  });

  app.get('/p2p/trades/:id', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return j(await tradeView(ctx, id, s.user.id));
  });

  // Step 3: inbound check on the seller's USDT, then into escrow.
  app.post('/p2p/trades/:id/fund', async (req) => {
    const s = await requireUser(ctx, req);
    gate(ctx);
    assertCanMoveMoney(ctx, s);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const t = await mine(ctx, id, s);
    if (t.seller_id !== s.user.id) throw forbidden('not_seller', 'Only the seller funds the escrow.');
    const offer = await one<{ payment_window_seconds: number }>(ctx.db, 'SELECT payment_window_seconds FROM app.p2p_offers WHERE id = $1', [t.offer_id]);
    const w = await walletOf(ctx.db, s.user.id);
    if (!w) throw forbidden('no_wallet', 'Set up your wallet first.');
    return tx(ctx.db, async (q) => {
      // deliverBy = end of the payment window, counted from now (plus a minute for the funding tx to land).
      const deliverBy = new Date(ctx.now().getTime() + offer.payment_window_seconds * 1000 + 60_000);
      await q.query('UPDATE app.payments SET deliver_by = $2 WHERE id = $1 AND status = $3', [t.payment_id, deliverBy, 'created']);
      await q.query('UPDATE app.p2p_trades SET payment_deadline = $2 WHERE id = $1', [t.id, deliverBy]);
      const p = await getPayment(q, t.payment_id!);
      return j(await fundingBundle(ctx, q, p, { network: 'tron', payerAddress: addressOn(w, 'tron'), confirmRefundToPayer: true, actorUserId: s.user.id }));
    });
  });

  // Step 4: buyer pays naira from their own registered account, then marks paid (UC2).
  app.post('/p2p/trades/:id/paid', async (req) => {
    const s = await requireUser(ctx, req);
    gate(ctx);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ fromOwnAccount: z.literal(true), reference: z.string().max(100).optional(), fileIds: z.array(zUuid).max(5).default([]) }), req.body);
    const t = await mine(ctx, id, s);
    if (t.buyer_id !== s.user.id) throw forbidden('not_buyer', 'Only the buyer marks the trade paid.');
    const p = await getPayment(ctx.db, t.payment_id!);
    assertAction(p, 'payee', 'markDelivered', ctx.now());
    return tx(ctx.db, async (q) => {
      const d = await recordDelivery(ctx, q, p, s.user.id, { note: `Naira paid from own registered account${b.reference ? `, reference ${b.reference}` : ''}`, links: [], fileIds: b.fileIds });
      await q.query("INSERT INTO app.trade_messages (trade_id, body, system) VALUES ($1, $2, true)", [t.id, 'Buyer says the naira has been sent. Seller: confirm only when it has arrived in your account from the buyer\'s own account.']);
      return j({ bundle: partyCall(p, 'payee', 'markDelivered', ctx.now(), d.hash) });
    });
  });

  // Step 5: seller confirms naira arrived (UC3 release).
  app.post('/p2p/trades/:id/confirm', async (req) => {
    const s = await requireUser(ctx, req);
    gate(ctx);
    assertCanMoveMoney(ctx, s);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ receivedFromBuyerAccount: z.literal(true) }), req.body);
    void b;
    const t = await mine(ctx, id, s);
    if (t.seller_id !== s.user.id) throw forbidden('not_seller', 'Only the seller confirms the naira.');
    const p = await getPayment(ctx.db, t.payment_id!);
    await audit(ctx.db, { type: 'user', id: s.user.id }, 'p2p.confirm_prepared', 'p2p_trade', t.id, {});
    return j({ bundle: partyCall(p, 'payer', 'release', ctx.now()) });
  });

  // Cancel: before funding (off-chain), or the buyer gives up before paying (refundByPayee).
  app.post('/p2p/trades/:id/cancel', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ reason: z.string().max(200).default('Cancelled') }), req.body);
    const t = await mine(ctx, id, s);
    const p = await getPayment(ctx.db, t.payment_id!);
    if (p.status === 'created') {
      await tx(ctx.db, async (q) => {
        await q.query("UPDATE app.payments SET status = 'cancelled', cancelled_at = $2, cancel_reason = $3 WHERE id = $1 AND status = 'created'", [p.id, ctx.now(), b.reason]);
        await q.query("UPDATE app.p2p_trades SET status = 'cancelled', cancelled_at = $2, cancelled_by = $3, cancel_reason = $4 WHERE id = $1", [t.id, ctx.now(), s.user.id, b.reason]);
        await audit(q, { type: 'user', id: s.user.id }, 'p2p.cancelled', 'p2p_trade', t.id, { reason: b.reason });
      });
      return { ok: true };
    }
    if (t.buyer_id === s.user.id && p.status === 'funded') {
      await ctx.db.query('UPDATE app.p2p_trades SET cancelled_by = $2, cancel_reason = $3 WHERE id = $1', [t.id, s.user.id, b.reason]);
      return j({ bundle: partyCall(p, 'payee', 'refundByPayee', ctx.now()), note: 'Sign to return the USDT to the seller and cancel the trade.' });
    }
    throw conflict('cannot_cancel', 'This trade can no longer be cancelled. Open a dispute if something is wrong.');
  });

  // Step 6: dispute; both sides upload bank evidence (2-hour window); ruling within 24 hours.
  app.post('/p2p/trades/:id/dispute', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ reason: z.enum(['paid_not_released', 'not_received', 'third_party_payment', 'other']), statement: z.string().min(10).max(5_000), fileIds: z.array(zUuid).max(20).default([]) }), req.body);
    const t = await mine(ctx, id, s);
    const p = await getPayment(ctx.db, t.payment_id!);
    const role = t.seller_id === s.user.id ? 'payer' : 'payee';
    assertAction(p, role, 'dispute', ctx.now());
    return tx(ctx.db, async (q) => {
      const d = await openDisputeRequest(ctx, q, p, role, s.user.id, { reason: b.reason, statement: b.statement, fileIds: b.fileIds, links: [] });
      // L4-5: the trade chat is kept as dispute evidence.
      const chat = await many<{ sender_id: string | null; body: string; created_at: Date; blocked: boolean }>(q, 'SELECT sender_id, body, created_at, blocked FROM app.trade_messages WHERE trade_id = $1 ORDER BY created_at', [t.id]);
      const log = chat.map((m) => `${m.created_at.toISOString()} ${m.sender_id === t.seller_id ? 'seller' : m.sender_id === t.buyer_id ? 'buyer' : 'system'}${m.blocked ? ' [blocked]' : ''}: ${m.body}`).join('\n');
      await q.query("INSERT INTO network.dispute_evidence (dispute_id, party, kind, body, sha256) VALUES ($1,'system','chat_log',$2,$3)", [d.disputeId, log, contentHash(log).slice(2)]);
      if (b.reason === 'third_party_payment') {
        // Edge case: buyer paid from someone else's account -> refund to seller's escrow; buyer suspended and reviewed.
        await q.query("INSERT INTO network.review_cases (kind, user_id, payment_id, due_at) VALUES ('p2p_naira_fraud', $1, $2, $3)", [t.buyer_id, p.id, new Date(ctx.now().getTime() + 24 * 3600_000)]);
      }
      return j({ disputeId: d.disputeId, bundle: partyCall(p, role, 'dispute', ctx.now(), d.hash) });
    });
  });

  // L4-5: in-app trade chat; outside contact details are blocked; kept as dispute evidence.
  app.get('/p2p/trades/:id/messages', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const t = await mine(ctx, id, s);
    const msgs = await many<{ id: string; sender_id: string | null; body: string; blocked: boolean; blocked_kinds: string[]; system: boolean; created_at: Date }>(ctx.db, 'SELECT * FROM app.trade_messages WHERE trade_id = $1 ORDER BY created_at', [t.id]);
    return j({
      messages: msgs.map((m) => ({
        id: m.id,
        from: m.system ? 'system' : m.sender_id === s.user.id ? 'me' : 'them',
        // Blocked messages are shown to the sender only, with the reason.
        body: m.blocked ? (m.sender_id === s.user.id ? m.body : '[message blocked]') : m.body,
        blocked: m.blocked,
        blockedKinds: m.blocked_kinds,
        at: m.created_at,
      })),
    });
  });

  app.post('/p2p/trades/:id/messages', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ body: z.string().min(1).max(1_000) }), req.body);
    const t = await mine(ctx, id, s);
    const scan = scanForContactDetails(b.body);
    await ctx.db.query('INSERT INTO app.trade_messages (trade_id, sender_id, body, blocked, blocked_kinds) VALUES ($1,$2,$3,$4,$5)', [t.id, s.user.id, b.body, scan.blocked, scan.kinds]);
    if (scan.blocked) return { delivered: false, blocked: true, reason: 'Sharing phone numbers, emails, links or messenger handles is not allowed in trade chat. Keep the trade on Backstop so it stays protected.' };
    return { delivered: true };
  });

  // L4-7: signed trade record for both sides.
  app.get('/p2p/trades/:id/record.pdf', async (req, reply) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const t = await mine(ctx, id, s);
    if (!['released', 'refunded'].includes(t.status)) throw conflict('not_complete', 'The signed record is available when the trade completes.');
    const seller = await one<{ verified_name: string; handle: string }>(ctx.db, 'SELECT verified_name, handle FROM app.users WHERE id = $1', [t.seller_id]);
    const buyer = await one<{ verified_name: string; handle: string }>(ctx.db, 'SELECT verified_name, handle FROM app.users WHERE id = $1', [t.buyer_id]);
    const sb = await one<{ bank_name: string; account_last4: string; account_name: string; name_match: string }>(ctx.db, 'SELECT bank_name, account_last4, account_name, name_match FROM app.bank_accounts WHERE id = $1', [t.seller_bank_account_id]);
    const bb = await one<{ bank_name: string; account_last4: string; account_name: string; name_match: string }>(ctx.db, 'SELECT bank_name, account_last4, account_name, name_match FROM app.bank_accounts WHERE id = $1', [t.buyer_bank_account_id]);
    const p = await getPayment(ctx.db, t.payment_id!);
    const facts = {
      tradeId: t.id,
      seller: { name: seller.verified_name, handle: seller.handle, bank: `${sb.bank_name} ****${sb.account_last4}`, accountName: sb.account_name, nameMatch: sb.name_match },
      buyer: { name: buyer.verified_name, handle: buyer.handle, bank: `${bb.bank_name} ****${bb.account_last4}`, accountName: bb.account_name, nameMatch: bb.name_match },
      usdt: formatUnits(BigInt(t.amount_units)),
      priceNgn: t.price_ngn,
      naira: fmtNaira(BigInt(t.naira_kobo)),
      outcome: t.status,
      escrow: p.escrow_address,
      openedAt: t.created_at.toISOString(),
      fundedAt: p.funded_at?.toISOString() ?? null,
      markedPaidAt: t.marked_paid_at?.toISOString() ?? null,
      confirmedAt: t.confirmed_at?.toISOString() ?? null,
      closedAt: (p.released_at ?? p.refunded_at)?.toISOString() ?? null,
    };
    const sig = await signDocument(ctx, ctx.db, 'trade_record', t.id, facts);
    const pdf = await renderPdf(
      ctx,
      'trade_record',
      [
        ['Trade', t.id],
        ['Seller (verified identity)', `${facts.seller.name} (@${facts.seller.handle})`],
        ['Seller bank account', `${facts.seller.bank}, name "${facts.seller.accountName}" (${facts.seller.nameMatch} match to verified name)`],
        ['Buyer (verified identity)', `${facts.buyer.name} (@${facts.buyer.handle})`],
        ['Buyer bank account', `${facts.buyer.bank}, name "${facts.buyer.accountName}" (${facts.buyer.nameMatch} match to verified name)`],
        ['USDT', facts.usdt],
        ['Price', `NGN ${facts.priceNgn} per USDT`],
        ['Naira', facts.naira],
        ['Outcome', facts.outcome],
        ['Escrow contract (TRON)', facts.escrow ?? ''],
        ['Opened', facts.openedAt],
        ['USDT locked', facts.fundedAt ?? ''],
        ['Buyer marked paid', facts.markedPaidAt ?? ''],
        ['Seller confirmed', facts.confirmedAt ?? ''],
        ['Closed', facts.closedAt ?? ''],
      ],
      { intro: 'Backstop verified both identities and checked both bank account names against them. Backstop did not handle the naira.', signed: sig },
    );
    reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="trade-record-${t.id}.pdf"`);
    return reply.send(pdf);
  });
}

async function mine(ctx: Ctx, id: string, s: SessionInfo): Promise<TradeRow> {
  const t = await maybe<TradeRow>(ctx.db, 'SELECT * FROM app.p2p_trades WHERE id = $1', [id]);
  if (!t || (t.seller_id !== s.user.id && t.buyer_id !== s.user.id)) throw notFound('Trade not found.');
  return t;
}

async function tradeView(ctx: Ctx, id: string, viewerId: string) {
  const t = await one<TradeRow>(ctx.db, 'SELECT * FROM app.p2p_trades WHERE id = $1', [id]);
  const role = t.seller_id === viewerId ? 'seller' : 'buyer';
  const seller = await one<{ handle: string; verified_name: string }>(ctx.db, 'SELECT handle, verified_name FROM app.users WHERE id = $1', [t.seller_id]);
  const buyer = await one<{ handle: string; verified_name: string }>(ctx.db, 'SELECT handle, verified_name FROM app.users WHERE id = $1', [t.buyer_id]);
  const sb = await one<{ bank_name: string; account_last4: string; account_name: string }>(ctx.db, 'SELECT bank_name, account_last4, account_name FROM app.bank_accounts WHERE id = $1', [t.seller_bank_account_id]);
  const bb = await one<{ bank_name: string; account_last4: string; account_name: string }>(ctx.db, 'SELECT bank_name, account_last4, account_name FROM app.bank_accounts WHERE id = $1', [t.buyer_bank_account_id]);
  const p = t.payment_id ? await getPayment(ctx.db, t.payment_id) : null;
  const sellerAccountNumber = role === 'buyer' && p && ['funded', 'delivered', 'disputed'].includes(p.status)
    ? ctx.crypto.decrypt((await one<{ account_number_enc: Buffer }>(ctx.db, 'SELECT account_number_enc FROM app.bank_accounts WHERE id = $1', [t.seller_bank_account_id])).account_number_enc, `bank:${t.seller_id}`).toString()
    : null;
  return {
    id: t.id,
    role,
    status: t.status,
    usdt: formatUnits(BigInt(t.amount_units)),
    priceNgn: t.price_ngn,
    naira: fmtNaira(BigInt(t.naira_kobo)),
    paymentDeadline: t.payment_deadline,
    seller: { handle: seller.handle, verifiedName: seller.verified_name, ...(await reputation(ctx.db, t.seller_id)) },
    buyer: { handle: buyer.handle, verifiedName: buyer.verified_name, ...(await reputation(ctx.db, t.buyer_id)) },
    // The buyer sees where to pay once USDT is locked; must pay from their own registered account.
    payTo: sellerAccountNumber ? { bankName: sb.bank_name, accountNumber: sellerAccountNumber, accountName: sb.account_name } : { bankName: sb.bank_name, last4: sb.account_last4, accountName: sb.account_name },
    payFrom: { bankName: bb.bank_name, last4: bb.account_last4, accountName: bb.account_name, rule: 'Pay only from this account in your own name. Payments from anyone else are refunded and the trade is closed.' },
    payment: p ? await paymentView(ctx, ctx.db, p, role === 'seller' ? 'payer' : 'payee') : null,
    times: { opened: t.created_at, markedPaid: t.marked_paid_at, confirmed: t.confirmed_at, cancelled: t.cancelled_at },
  };
}

export type { PaymentRow };
