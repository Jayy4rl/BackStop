// L3 trade orders: a Tier 2 importer prepays an overseas supplier into escrow; the supplier sees
// signed proof of funds, ships, uploads shipping proof, and is paid when the importer approves or
// the 14-day hold ends.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatUnits, LOOP_TERMS, NETWORK_INFO, parseUnits, quoteEscrowFee } from '@backstop/shared';
import type { Ctx } from '../ctx.ts';
import { maybe, many, one, tx } from '../db/pool.ts';
import { audit } from '../lib/audit.ts';
import { canonicalJson, randomToken, sha256Hex } from '../lib/crypto.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { assertTier, clientIp, j, parse, requireUser, zAmount, zUuid } from '../http.ts';
import { notify } from '../services/notify.ts';
import { createPayment, getPayment, partyCall, paymentView, roleOf, type PaymentRow } from '../services/payments.ts';
import { renderPdf, signDocument } from '../services/documents.ts';

interface OrderRow {
  id: string;
  importer_id: string;
  supplier_email: string;
  supplier_user_id: string | null;
  goods_description: string;
  proforma_file_id: string;
  token: 'USDC' | 'USDT';
  total_units: string;
  shipping_deadline: Date;
  split: 'single' | 'deposit_balance';
  deposit_units: string | null;
  slug: string;
  terms_sha256: string;
  supplier_accepted_at: Date | null;
  status: string;
  created_at: Date;
}

function termsOf(o: Pick<OrderRow, 'goods_description' | 'token' | 'total_units' | 'shipping_deadline' | 'split' | 'deposit_units' | 'supplier_email'>, proformaSha: string) {
  return {
    goods: o.goods_description,
    token: o.token,
    total: formatUnits(BigInt(o.total_units)),
    shippingDeadline: o.shipping_deadline.toISOString(),
    split: o.split,
    deposit: o.deposit_units ? formatUnits(BigInt(o.deposit_units)) : null,
    supplier: o.supplier_email,
    proformaSha256: proformaSha,
    holdDays: LOOP_TERMS.L3.holdPeriod / 86_400,
    release: 'Importer approves, or the hold ends 14 days after the supplier uploads shipping proof.',
    cancel: 'If the supplier misses the shipping deadline, the importer can cancel for a full refund without a ruling.',
  };
}

async function orderView(ctx: Ctx, o: OrderRow, viewerId: string | null) {
  const payments = await many<PaymentRow>(ctx.db, 'SELECT * FROM app.payments WHERE order_id = $1 ORDER BY part_index', [o.id]);
  const importer = await one<{ verified_name: string | null; handle: string }>(ctx.db, 'SELECT verified_name, handle FROM app.users WHERE id = $1', [o.importer_id]);
  const fees = await ctx.versioned.fees();
  return {
    id: o.id,
    status: o.status,
    importer: { name: importer.verified_name, handle: importer.handle },
    supplierEmail: o.supplier_email,
    supplierAccepted: !!o.supplier_accepted_at,
    supplierAcceptedAt: o.supplier_accepted_at,
    goods: o.goods_description,
    proformaFileId: o.proforma_file_id,
    token: o.token,
    total: formatUnits(BigInt(o.total_units)),
    shippingDeadline: o.shipping_deadline,
    split: o.split,
    deposit: o.deposit_units ? formatUnits(BigInt(o.deposit_units)) : null,
    termsSha256: o.terms_sha256,
    feeQuote: { bps: fees.l3.bps, cap: fees.l3.capUnits !== null ? formatUnits(fees.l3.capUnits) : null, paidBy: 'importer', estimate: formatUnits(quoteEscrowFee('L3', BigInt(o.total_units), fees).feeUnits) },
    link: `${ctx.cfg.webBaseUrl}/orders/${o.slug}`,
    payments: await Promise.all(payments.map((p) => paymentView(ctx, ctx.db, p, viewerId ? roleOf(p, viewerId) : null))),
  };
}

export function registerOrders(app: FastifyInstance, ctx: Ctx): void {
  // L3-1: supplier, goods, pro forma invoice upload, amount, token, shipping deadline, single or deposit+balance.
  app.post('/orders', async (req) => {
    const s = await requireUser(ctx, req);
    assertTier(s, ['tier2'], 'Trade orders');
    const b = parse(
      z.object({
        supplierEmail: z.string().email(),
        goodsDescription: z.string().min(3).max(3_000),
        proformaFileId: zUuid,
        token: z.enum(['USDC', 'USDT']),
        total: zAmount,
        shippingDeadline: z.string().datetime(),
        split: z.enum(['single', 'deposit_balance']),
        deposit: zAmount.optional(),
      }),
      req.body,
    );
    const total = parseUnits(b.total);
    const deposit = b.deposit ? parseUnits(b.deposit) : null;
    if (b.split === 'deposit_balance' && (!deposit || deposit <= 0n || deposit >= total)) throw badRequest('deposit', 'The deposit must be more than zero and less than the total.');
    if (new Date(b.shippingDeadline) <= ctx.now()) throw badRequest('deadline', 'The shipping deadline must be in the future.');
    const file = await maybe<{ sha256: string }>(ctx.db, "SELECT sha256 FROM app.files WHERE id = $1 AND owner_user_id = $2 AND purpose = 'proforma'", [b.proformaFileId, s.user.id]);
    if (!file) throw badRequest('proforma', 'Upload the pro forma invoice first.');
    const slug = randomToken(9);
    const terms = termsOf({ goods_description: b.goodsDescription, token: b.token, total_units: total.toString(), shipping_deadline: new Date(b.shippingDeadline), split: b.split, deposit_units: deposit?.toString() ?? null, supplier_email: b.supplierEmail.toLowerCase() }, file.sha256);
    const id = await tx(ctx.db, async (q) => {
      const o = await one<{ id: string }>(
        q,
        `INSERT INTO app.trade_orders (importer_id, supplier_email, goods_description, proforma_file_id, token, total_units, shipping_deadline, split, deposit_units, slug, terms_sha256, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$1) RETURNING id`,
        [s.user.id, b.supplierEmail.toLowerCase(), b.goodsDescription, b.proformaFileId, b.token, total.toString(), b.shippingDeadline, b.split, deposit?.toString() ?? null, slug, sha256Hex(canonicalJson(terms))],
      );
      await q.query('UPDATE app.files SET attached_to = $2, attached_at = $3 WHERE id = $1', [b.proformaFileId, `order:${o.id}`, ctx.now()]);
      await notify(q, {
        email: b.supplierEmail,
        kind: 'order_sent',
        vars: { importer: s.user.verified_name ?? 'A Nigerian importer', description: b.goodsDescription.slice(0, 140), amount: formatUnits(total), token: b.token, link: `${ctx.cfg.webBaseUrl}/orders/${slug}` },
        dedupeKey: `order:${o.id}`,
      });
      await audit(q, { type: 'user', id: s.user.id }, 'order.created', 'order', o.id, { split: b.split });
      return o.id;
    });
    return j(await orderView(ctx, await one<OrderRow>(ctx.db, 'SELECT * FROM app.trade_orders WHERE id = $1', [id]), s.user.id));
  });

  app.get('/orders', async (req) => {
    const s = await requireUser(ctx, req);
    const rows = await many<OrderRow>(ctx.db, 'SELECT * FROM app.trade_orders WHERE importer_id = $1 OR supplier_user_id = $1 ORDER BY created_at DESC LIMIT 100', [s.user.id]);
    return j({ orders: await Promise.all(rows.map((o) => orderView(ctx, o, s.user.id))) });
  });

  app.get('/orders/:id', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const o = await maybe<OrderRow>(ctx.db, 'SELECT * FROM app.trade_orders WHERE id = $1 AND (importer_id = $2 OR supplier_user_id = $2)', [id, s.user.id]);
    if (!o) throw notFound('Order not found.');
    return j(await orderView(ctx, o, s.user.id));
  });

  // Supplier's view of the terms before accepting (no account needed to read).
  app.get('/public/orders/:slug', async (req) => {
    const { slug } = parse(z.object({ slug: z.string().min(6).max(40) }), req.params);
    const o = await maybe<OrderRow>(ctx.db, 'SELECT * FROM app.trade_orders WHERE slug = $1', [slug]);
    if (!o) throw notFound('Order not found.');
    const v = await orderView(ctx, o, null);
    const file = await one<{ sha256: string }>(ctx.db, 'SELECT sha256 FROM app.files WHERE id = $1', [o.proforma_file_id]);
    return j({ ...v, terms: termsOf(o, file.sha256) });
  });

  // L3-2: supplier acceptance recorded before funding; counterparty verification first.
  app.post('/orders/accept/:slug', async (req) => {
    const s = await requireUser(ctx, req);
    const { slug } = parse(z.object({ slug: z.string().min(6).max(40) }), req.params);
    const b = parse(z.object({ termsSha256: z.string().length(64) }), req.body);
    if (s.user.kind !== 'counterparty') throw forbidden('supplier_account', 'Accept with your supplier account.');
    if (!s.user.counterparty_verified_at) throw forbidden('counterparty_verification', 'Verify your ID document and take a selfie before accepting, so the money can be released to you.');
    const o = await maybe<OrderRow>(ctx.db, 'SELECT * FROM app.trade_orders WHERE slug = $1', [slug]);
    if (!o) throw notFound('Order not found.');
    if (o.supplier_email !== s.user.email.toLowerCase()) throw forbidden('wrong_supplier', 'This order was sent to a different email.');
    if (o.supplier_accepted_at) throw conflict('accepted', 'You already accepted this order.');
    if (b.termsSha256 !== o.terms_sha256) throw conflict('terms_changed', 'The terms you saw do not match. Reload and review them again.');
    await tx(ctx.db, async (q) => {
      await q.query("UPDATE app.trade_orders SET supplier_user_id = $2, supplier_accepted_at = $3, supplier_accept_ip = $4, status = 'accepted' WHERE id = $1", [o.id, s.user.id, ctx.now(), clientIp(req)]);
      const network = o.token === 'USDT' ? 'tron' : null;
      const parts: Array<{ title: string; amount: bigint }> =
        o.split === 'single'
          ? [{ title: o.goods_description.slice(0, 80), amount: BigInt(o.total_units) }]
          : [
              { title: `Deposit: ${o.goods_description.slice(0, 60)}`, amount: BigInt(o.deposit_units!) },
              { title: `Balance: ${o.goods_description.slice(0, 60)}`, amount: BigInt(o.total_units) - BigInt(o.deposit_units!) },
            ];
      const biz = await maybe<{ second_approver_above_units: string | null }>(q, 'SELECT second_approver_above_units FROM app.businesses WHERE user_id = $1', [o.importer_id]);
      for (const [i, part] of parts.entries()) {
        await createPayment(ctx, q, {
          loop: 'L3',
          orderId: o.id,
          partIndex: i,
          title: part.title,
          payerUserId: o.importer_id,
          payeeUserId: s.user.id,
          token: o.token,
          network,
          amountUnits: part.amount,
          deliverBy: o.shipping_deadline,
          approvalRequired: !!biz?.second_approver_above_units && part.amount > BigInt(biz.second_approver_above_units),
        });
      }
      await notify(q, { userId: o.importer_id, kind: 'staff_alert', vars: { title: 'Supplier accepted your order', body: 'Fund the escrow so the supplier can ship.' }, dedupeKey: `order-accepted:${o.id}` });
      await audit(q, { type: 'user', id: s.user.id }, 'order.accepted', 'order', o.id, { termsSha256: b.termsSha256 });
    });
    return j(await orderView(ctx, await one<OrderRow>(ctx.db, 'SELECT * FROM app.trade_orders WHERE id = $1', [o.id]), s.user.id));
  });

  // L3-3: signed proof-of-funds PDF showing amount, escrow address and release terms.
  app.get('/payments/:id/proof-of-funds.pdf', async (req, reply) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const p = await getPayment(ctx.db, id);
    if (!roleOf(p, s.user.id) || p.loop !== 'L3') throw notFound('Payment not found.');
    if (!p.escrow_address || !['funded', 'delivered', 'disputed'].includes(p.status)) throw conflict('not_funded', 'Proof of funds is available while the money is held in escrow.');
    const o = await one<OrderRow>(ctx.db, 'SELECT * FROM app.trade_orders WHERE id = $1', [p.order_id]);
    const importer = await one<{ verified_name: string }>(ctx.db, 'SELECT verified_name FROM app.users WHERE id = $1', [o.importer_id]);
    const supplier = await one<{ verified_name: string | null; email: string }>(ctx.db, 'SELECT verified_name, email FROM app.users WHERE id = $1', [p.payee_user_id]);
    const facts = {
      paymentId: p.id,
      orderId: o.id,
      importer: importer.verified_name,
      supplier: supplier.verified_name ?? supplier.email,
      amount: formatUnits(BigInt(p.amount_units)),
      token: p.token,
      network: p.network,
      escrowAddress: p.escrow_address,
      fundedAt: p.funded_at?.toISOString(),
      shippingDeadline: p.deliver_by.toISOString(),
      releaseTerms: `Released to the supplier when the importer approves, or automatically ${LOOP_TERMS.L3.holdPeriod / 86_400} days after shipping proof is uploaded unless the importer disputes. If shipping proof is not uploaded by the deadline, the importer can reclaim the funds.`,
    };
    const sig = await signDocument(ctx, ctx.db, 'proof_of_funds', p.id, facts);
    const pdf = await renderPdf(
      ctx,
      'proof_of_funds',
      [
        ['Importer', facts.importer],
        ['Supplier', facts.supplier],
        ['Amount held', `${facts.amount} ${p.token}`],
        ['Network', p.network ? NETWORK_INFO[p.network].label : ''],
        ['Escrow contract address', facts.escrowAddress ?? ''],
        ['Funded', facts.fundedAt ?? ''],
        ['Ship by', facts.shippingDeadline],
        ['Release terms', facts.releaseTerms],
      ],
      { intro: 'The funds below are held in a smart contract that can only pay the supplier or refund the importer. Backstop cannot move them anywhere else. Check the escrow address on a block explorer.', signed: sig },
    );
    reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="proof-of-funds-${p.id}.pdf"`);
    return reply.send(pdf);
  });

  // Public calldata for an external-wallet payer to approve (the contract checks the payer signs).
  app.post('/public/payments/:id/release', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const p = await getPayment(ctx.db, id);
    return j({ bundle: partyCall(p, 'payer', 'release', ctx.now()), note: 'Sign with the wallet that funded this payment.' });
  });
}
