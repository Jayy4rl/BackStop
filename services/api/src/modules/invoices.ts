// L2 freelancer invoices: the client's money is locked in escrow before work starts and released
// on delivery (client approves, or the hold ends).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatUnits, LOOP_TERMS, NETWORK_INFO, parseUnits, quoteEscrowFee, type Network } from '@backstop/shared';
import type { Ctx } from '../ctx.ts';
import { maybe, many, one, tx } from '../db/pool.ts';
import { audit } from '../lib/audit.ts';
import { randomToken } from '../lib/crypto.ts';
import { badRequest, conflict, forbidden, notFound, tooMany } from '../lib/errors.ts';
import { assertTier, clientIp, j, optionalUser, parse, requireUser, zAmount, zUuid } from '../http.ts';
import { notify } from '../services/notify.ts';
import { createPayment, fundingBundle, getPayment, paymentView, roleOf, type PaymentRow } from '../services/payments.ts';
import { renderPdf } from '../services/documents.ts';
import { counterpartyNeedsVerification } from './identity.ts';

const MAX_MILESTONES = 10;

async function sanctionedCountry(ctx: Ctx, country: string): Promise<boolean> {
  const r = await maybe(ctx.db, 'SELECT 1 FROM config.sanctioned_countries WHERE country = $1', [country.toUpperCase()]);
  return !!r;
}

async function invoiceView(ctx: Ctx, inv: Record<string, unknown>, viewerId: string | null) {
  const payments = await many<PaymentRow>(ctx.db, 'SELECT * FROM app.payments WHERE invoice_id = $1 ORDER BY part_index', [inv.id]);
  return {
    ...inv,
    total: formatUnits(BigInt(inv.total_units as string)),
    link: `${ctx.cfg.webBaseUrl}/checkout/${inv.slug}`,
    milestones: await Promise.all(payments.map((p) => paymentView(ctx, ctx.db, p, viewerId ? roleOf(p, viewerId) : null))),
  };
}

export function registerInvoices(app: FastifyInstance, ctx: Ctx): void {
  // L2-1: client email, description, amount, token, due date, up to 10 milestones (each its own escrow).
  app.post('/invoices', async (req) => {
    const s = await requireUser(ctx, req);
    assertTier(s, ['tier1'], 'Sending invoices');
    const b = parse(
      z.object({
        clientEmail: z.string().email(),
        clientCountry: z.string().length(2).optional(),
        description: z.string().min(3).max(2_000),
        token: z.enum(['USDC', 'USDT']).default('USDC'),
        dueDate: z.string().datetime(),
        feeSplit: z.boolean().default(false),
        milestones: z
          .array(z.object({ title: z.string().min(1).max(200), amount: zAmount, dueDate: z.string().datetime() }))
          .min(1)
          .max(MAX_MILESTONES),
      }),
      req.body,
    );
    if (b.clientCountry && (await sanctionedCountry(ctx, b.clientCountry))) throw forbidden('sanctioned_country', 'Backstop cannot serve clients in that country.');
    const now = ctx.now();
    for (const m of b.milestones) if (new Date(m.dueDate) <= now) throw badRequest('due_date', `Milestone "${m.title}" is due in the past.`);
    const total = b.milestones.reduce((s2, m) => s2 + parseUnits(m.amount), 0n);
    const result = await tx(ctx.db, async (q) => {
      const slug = randomToken(9);
      const inv = await one<{ id: string }>(
        q,
        `INSERT INTO app.invoices (freelancer_id, client_email, client_country, description, token, total_units, due_date, fee_split, slug) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [s.user.id, b.clientEmail.toLowerCase(), b.clientCountry?.toUpperCase() ?? null, b.description, b.token, total.toString(), b.dueDate, b.feeSplit, slug],
      );
      for (const [i, m] of b.milestones.entries()) {
        await createPayment(ctx, q, {
          loop: 'L2',
          invoiceId: inv.id,
          partIndex: i,
          title: b.milestones.length > 1 ? `${m.title} (milestone ${i + 1} of ${b.milestones.length})` : m.title,
          payerUserId: null,
          payerEmail: b.clientEmail.toLowerCase(),
          payeeUserId: s.user.id,
          token: b.token,
          network: b.token === 'USDT' ? 'tron' : null,
          amountUnits: parseUnits(m.amount),
          deliverBy: new Date(m.dueDate),
          splitFee: b.feeSplit,
        });
      }
      await notify(q, {
        email: b.clientEmail,
        kind: 'invoice_sent',
        vars: { freelancer: s.user.verified_name ?? s.user.display_name ?? 'A freelancer', amount: formatUnits(total), token: b.token, description: b.description.slice(0, 140), link: `${ctx.cfg.webBaseUrl}/checkout/${slug}` },
        dedupeKey: `invoice:${inv.id}`,
      });
      await audit(q, { type: 'user', id: s.user.id }, 'invoice.created', 'invoice', inv.id, { milestones: b.milestones.length });
      return inv.id;
    });
    const inv = await one(ctx.db, 'SELECT * FROM app.invoices WHERE id = $1', [result]);
    return j(await invoiceView(ctx, inv, s.user.id));
  });

  app.get('/invoices', async (req) => {
    const s = await requireUser(ctx, req);
    const rows = await many(ctx.db, 'SELECT * FROM app.invoices WHERE freelancer_id = $1 OR client_user_id = $1 ORDER BY created_at DESC LIMIT 100', [s.user.id]);
    return j({ invoices: await Promise.all(rows.map((r) => invoiceView(ctx, r, s.user.id))) });
  });

  app.get('/invoices/:id', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const inv = await maybe<Record<string, unknown>>(ctx.db, 'SELECT * FROM app.invoices WHERE id = $1 AND (freelancer_id = $2 OR client_user_id = $2)', [id, s.user.id]);
    if (!inv) throw notFound('Invoice not found.');
    return j(await invoiceView(ctx, inv, s.user.id));
  });

  // L2-6 PDF invoice.
  app.get('/invoices/:id/pdf', async (req, reply) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const inv = await maybe<{ id: string; freelancer_id: string; client_email: string; description: string; token: string; total_units: string; due_date: Date; slug: string; created_at: Date }>(
      ctx.db,
      'SELECT * FROM app.invoices WHERE id = $1 AND (freelancer_id = $2 OR client_user_id = $2)',
      [id, s.user.id],
    );
    if (!inv) throw notFound('Invoice not found.');
    const f = await one<{ verified_name: string | null; display_name: string | null; handle: string }>(ctx.db, 'SELECT verified_name, display_name, handle FROM app.users WHERE id = $1', [inv.freelancer_id]);
    const ms = await many<PaymentRow>(ctx.db, 'SELECT * FROM app.payments WHERE invoice_id = $1 ORDER BY part_index', [id]);
    const rows: Array<[string, string]> = [
      ['Invoice number', inv.id],
      ['From', `${f.verified_name ?? f.display_name} (@${f.handle}), identity verified by Backstop`],
      ['To', inv.client_email],
      ['Issued', inv.created_at.toISOString().slice(0, 10)],
      ['Due', inv.due_date.toISOString().slice(0, 10)],
      ['Description', inv.description],
      ...ms.map((m, i): [string, string] => [`Milestone ${i + 1}: ${m.title}`, `${formatUnits(BigInt(m.amount_units))} ${m.token}, due ${m.deliver_by.toISOString().slice(0, 10)} (fee ${formatUnits(BigInt(m.fee_units))} on release)`]),
      ['Total', `${formatUnits(BigInt(inv.total_units))} ${inv.token}`],
      ['Pay securely', `${ctx.cfg.webBaseUrl}/checkout/${inv.slug}`],
    ];
    const pdf = await renderPdf(ctx, 'invoice', rows, {
      intro: 'Payment is held in an escrow contract and released to the freelancer when you approve the work or the hold ends. You can dispute before the hold ends.',
      footer: 'Backstop does not hold your money: each milestone is held in its own smart contract that can only pay the freelancer or refund you.',
    });
    reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="invoice-${inv.id}.pdf"`);
    return reply.send(pdf);
  });

  // L2-2/L2-3 web checkout: freelancer's verified name, hold rules and fee before funding.
  app.get('/public/invoices/:slug', async (req) => {
    const { slug } = parse(z.object({ slug: z.string().min(6).max(40) }), req.params);
    const inv = await maybe<Record<string, unknown> & { freelancer_id: string; token: string; id: string }>(ctx.db, 'SELECT * FROM app.invoices WHERE slug = $1', [slug]);
    if (!inv) throw notFound('Invoice not found.');
    const f = await one<{ verified_name: string | null; handle: string; tier: string }>(ctx.db, 'SELECT verified_name, handle, tier FROM app.users WHERE id = $1', [inv.freelancer_id]);
    const ms = await many<PaymentRow>(ctx.db, 'SELECT * FROM app.payments WHERE invoice_id = $1 ORDER BY part_index', [inv.id]);
    const fees = await ctx.versioned.fees();
    const limits = await ctx.versioned.limits();
    const networks: Network[] = inv.token === 'USDT' ? ['tron'] : (['arc', 'base'] as Network[]).filter((n) => !!ctx.cfg.chains[n]?.factory);
    return j({
      id: inv.id,
      description: inv.description,
      token: inv.token,
      total: formatUnits(BigInt(inv.total_units as string)),
      dueDate: inv.due_date,
      status: inv.status,
      freelancer: { verifiedName: f.verified_name, handle: f.handle, verified: f.tier === 'tier1' },
      holdRules: {
        holdDays: LOOP_TERMS.L2.holdPeriod / 86_400,
        text: `Your money is held in escrow. When the freelancer marks a milestone delivered, you have ${LOOP_TERMS.L2.holdPeriod / 86_400} days to approve or dispute. If you do nothing, it releases automatically. If a milestone isn't delivered by its due date, you can reclaim it.`,
        disputes: 'Disputes are decided by a Backstop reviewer within 5 business days. Refunds return the full amount with no fee.',
      },
      feeRule: { bps: fees.l2.bps, cap: fees.l2.capUnits !== null ? formatUnits(fees.l2.capUnits) : null, paidBy: inv.fee_split ? 'split between you and the freelancer' : 'the freelancer' },
      counterpartyVerificationAbove: formatUnits(limits.tiers.counterparty.verificationThresholdUnits ?? 0n),
      networks: networks.map((n) => ({ network: n, label: NETWORK_INFO[n].label })),
      ethereumNote: inv.token === 'USDC' ? 'Paying from Ethereum? Move your USDC to Base first (Circle CCTP, about 15–19 minutes), then pay from Base.' : null,
      milestones: ms.map((m) => ({
        id: m.id,
        title: m.title,
        amount: formatUnits(BigInt(m.amount_units)),
        fee: formatUnits(BigInt(m.fee_units)),
        status: m.status,
        dueDate: m.deliver_by,
        fundingDeadline: m.funding_deadline,
        escrowAddress: m.escrow_address,
      })),
    });
  });

  // Checkout funding from an external wallet (or a counterparty account).
  app.post('/public/invoices/:slug/fund', async (req) => {
    const { slug } = parse(z.object({ slug: z.string().min(6).max(40) }), req.params);
    const b = parse(
      z.object({
        milestoneId: zUuid,
        network: z.enum(['tron', 'arc', 'base']),
        payerAddress: z.string().min(20).max(80),
        clientCountry: z.string().length(2),
        confirmRefundToPayer: z.boolean(),
      }),
      req.body,
    );
    if (!(await ctx.limiter.hit(`checkout:${clientIp(req)}`, 60, 3600))) throw tooMany();
    const inv = await maybe<{ id: string; client_email: string; client_user_id: string | null }>(ctx.db, 'SELECT * FROM app.invoices WHERE slug = $1', [slug]);
    if (!inv) throw notFound('Invoice not found.');
    // L2-8: block clients in sanctioned countries at checkout (C1-6).
    if (await sanctionedCountry(ctx, b.clientCountry)) throw forbidden('sanctioned_country', 'Backstop cannot accept payments from clients in that country.');
    const p = await getPayment(ctx.db, b.milestoneId);
    if (p.invoice_id !== inv.id) throw notFound('Milestone not found.');
    // C1-4: counterparty identity document and liveness above a threshold.
    const viewer = await optionalUser(ctx, req);
    const limits = await ctx.versioned.limits();
    const threshold = limits.tiers.counterparty.verificationThresholdUnits ?? 0n;
    if (BigInt(p.amount_units) > threshold) {
      if (!viewer || viewer.user.kind !== 'counterparty' || viewer.user.email.toLowerCase() !== inv.client_email)
        throw forbidden('counterparty_verification', `Payments above $${formatUnits(threshold)} need a free client account with a quick ID check. Create one with ${inv.client_email}.`, { threshold: formatUnits(threshold) });
      if (await counterpartyNeedsVerification(ctx, viewer.user, BigInt(p.amount_units))) throw forbidden('counterparty_verification', 'Verify your ID document and take a selfie to pay this amount.');
    }
    return tx(ctx.db, async (q) => {
      await q.query('UPDATE app.invoices SET client_country = $2 WHERE id = $1', [inv.id, b.clientCountry.toUpperCase()]);
      if (viewer && viewer.user.kind === 'counterparty' && viewer.user.email.toLowerCase() === inv.client_email) {
        await q.query('UPDATE app.invoices SET client_user_id = $2 WHERE id = $1', [inv.id, viewer.user.id]);
      }
      const r = await fundingBundle(ctx, q, p, { network: b.network, payerAddress: b.payerAddress, confirmRefundToPayer: b.confirmRefundToPayer, actorUserId: viewer?.user.id ?? null });
      await audit(q, { type: viewer ? 'user' : 'public', id: viewer?.user.id }, 'escrow.funding_prepared', 'payment', p.id, { network: b.network, payer: b.payerAddress, via: 'checkout' });
      return j(r);
    });
  });

  // Client claims the invoice into their counterparty account (to approve, dispute and get receipts in-app).
  app.post('/invoices/claim/:slug', async (req) => {
    const s = await requireUser(ctx, req);
    const { slug } = parse(z.object({ slug: z.string().min(6).max(40) }), req.params);
    const inv = await maybe<{ id: string; client_email: string; client_user_id: string | null }>(ctx.db, 'SELECT * FROM app.invoices WHERE slug = $1', [slug]);
    if (!inv) throw notFound('Invoice not found.');
    if (inv.client_email !== s.user.email.toLowerCase()) throw forbidden('wrong_client', 'This invoice was sent to a different email.');
    if (inv.client_user_id && inv.client_user_id !== s.user.id) throw conflict('claimed', 'This invoice is already linked to another account.');
    await tx(ctx.db, async (q) => {
      await q.query('UPDATE app.invoices SET client_user_id = $2 WHERE id = $1', [inv.id, s.user.id]);
      // The client becomes the payer of record for unfunded milestones, and for funded ones when the
      // escrow's payer address is the client's own wallet.
      await q.query(
        `UPDATE app.payments p SET payer_user_id = $2 WHERE invoice_id = $1 AND payer_user_id IS NULL
           AND (p.payer_address IS NULL OR EXISTS (SELECT 1 FROM app.wallets w WHERE w.user_id = $2 AND (lower(w.evm_address) = lower(p.payer_address) OR w.tron_address = p.payer_address)))`,
        [inv.id, s.user.id],
      );
      await audit(q, { type: 'user', id: s.user.id }, 'invoice.claimed', 'invoice', inv.id, {});
    });
    return { ok: true };
  });

  // L2-7 (Should): freelancer profile with completed protected jobs and dispute record.
  app.get('/public/profiles/:handle', async (req) => {
    const { handle } = parse(z.object({ handle: z.string().min(3).max(21) }), req.params);
    const u = await maybe<{ id: string; handle: string; verified_name: string | null; tier: string; created_at: Date }>(ctx.db, "SELECT id, handle, verified_name, tier, created_at FROM app.users WHERE lower(handle) = lower($1) AND status = 'active'", [handle.replace(/^@/, '')]);
    if (!u) throw notFound('Profile not found.');
    const stats = await one<{ completed: string; disputed: string; ruled_against: string; volume: string }>(
      ctx.db,
      `SELECT count(*) FILTER (WHERE p.status = 'released') AS completed,
              count(DISTINCT d.payment_id) AS disputed,
              count(DISTINCT d.payment_id) FILTER (WHERE coalesce(d.final_ruling, d.ruling) = 'refund' AND d.status IN ('executed','closed')) AS ruled_against,
              coalesce(sum(p.amount_units) FILTER (WHERE p.status = 'released'), 0) AS volume
       FROM app.payments p LEFT JOIN network.disputes d ON d.payment_id = p.id AND d.opened_onchain_at IS NOT NULL
       WHERE p.payee_user_id = $1 AND p.loop = 'L2'`,
      [u.id],
    );
    return {
      handle: u.handle,
      verifiedName: u.verified_name,
      verified: u.tier === 'tier1',
      memberSince: u.created_at,
      completedProtectedJobs: Number(stats.completed),
      disputes: Number(stats.disputed),
      disputesLost: Number(stats.ruled_against),
      releasedVolume: formatUnits(BigInt(stats.volume)),
    };
  });
}

export function feePreview(amount: string, split: boolean) {
  return quoteEscrowFee('L2', parseUnits(amount), undefined, split);
}
