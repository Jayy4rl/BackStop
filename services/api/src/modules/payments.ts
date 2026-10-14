// Party actions on protected payments (C4), shared by L2, L3 and L4.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { contentHash, formatUnits, NETWORK_INFO } from '@backstop/shared';
import type { Ctx } from '../ctx.ts';
import { maybe, many, one, tx } from '../db/pool.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { assertCanMoveMoney, j, parse, requireUser, zUuid } from '../http.ts';
import { notify } from '../services/notify.ts';
import {
  assertAction,
  assertApproved,
  fundingBundle,
  getPayment,
  openDisputeRequest,
  partyCall,
  paymentView,
  recordDelivery,
  roleOf,
  type PaymentRow,
} from '../services/payments.ts';
import { renderPdf, signDocument } from '../services/documents.ts';
import { walletOf, addressOn } from '../services/wallet.ts';

const zEvidence = z.object({
  reason: z.string().min(3).max(200),
  statement: z.string().min(10).max(5_000),
  fileIds: z.array(zUuid).max(20).default([]),
  links: z.array(z.string().url().max(500)).max(20).default([]),
});

export async function partyOf(ctx: Ctx, userId: string, paymentId: string): Promise<{ p: PaymentRow; role: 'payer' | 'payee' }> {
  const p = await getPayment(ctx.db, paymentId);
  const role = roleOf(p, userId);
  if (role) return { p, role };
  // Members of a business payer/payee act through the business account itself.
  throw notFound('Payment not found.');
}

export function registerPayments(app: FastifyInstance, ctx: Ctx): void {
  app.get('/payments', async (req) => {
    const s = await requireUser(ctx, req);
    const rows = await many<PaymentRow>(ctx.db, 'SELECT * FROM app.payments WHERE payer_user_id = $1 OR payee_user_id = $1 ORDER BY created_at DESC LIMIT 200', [s.user.id]);
    return j({ payments: await Promise.all(rows.map((p) => paymentView(ctx, ctx.db, p, roleOf(p, s.user.id)))) });
  });

  app.get('/payments/:id', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const { p, role } = await partyOf(ctx, s.user.id, id);
    return j(await paymentView(ctx, ctx.db, p, role));
  });

  // Fund from the payer's Backstop wallet (L3 importer, L2 client with an account, L4 seller).
  app.post('/payments/:id/fund', async (req) => {
    const s = await requireUser(ctx, req);
    assertCanMoveMoney(ctx, s);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ network: z.enum(['tron', 'arc', 'base']) }), req.body);
    const { p, role } = await partyOf(ctx, s.user.id, id);
    if (role !== 'payer') throw forbidden('not_payer', 'Only the payer funds this payment.');
    if (p.loop === 'L3') {
      const o = await one<{ supplier_accepted_at: Date | null }>(ctx.db, 'SELECT supplier_accepted_at FROM app.trade_orders WHERE id = $1', [p.order_id]);
      if (!o.supplier_accepted_at) throw conflict('terms_not_accepted', 'The supplier must accept the terms before funding (L3-2).');
    }
    const w = await walletOf(ctx.db, s.user.id);
    if (!w) throw forbidden('no_wallet', 'Set up your wallet first.');
    return tx(ctx.db, async (q) => {
      const r = await fundingBundle(ctx, q, p, { network: b.network, payerAddress: addressOn(w, b.network), confirmRefundToPayer: true, actorUserId: s.user.id });
      await audit(q, { type: 'user', id: s.user.id }, 'escrow.funding_prepared', 'payment', p.id, { network: b.network });
      return j(r);
    });
  });

  // The device reports what it broadcast (or relays TRON signed transactions). State still changes
  // only from indexed events.
  app.post('/payments/:id/submitted', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ txHash: z.string().min(10).optional(), signedTxs: z.array(z.string().min(10)).max(3).optional() }), req.body);
    const { p } = await partyOf(ctx, s.user.id, id);
    const hashes: string[] = [];
    if (b.signedTxs?.length) {
      const chain = p.network ? ctx.chains[p.network] : undefined;
      if (!chain) throw badRequest('network', 'Network unavailable.');
      for (const raw of b.signedTxs) hashes.push(await chain.broadcast(raw));
    }
    if (b.txHash) hashes.push(b.txHash);
    await audit(ctx.db, { type: 'user', id: s.user.id }, 'escrow.tx_submitted', 'payment', p.id, { hashes });
    return { ok: true, txHashes: hashes, note: 'The payment updates once the network confirms it.' };
  });

  // L2 freelancer marks a milestone delivered / L3 supplier uploads shipping proof (UC2).
  app.post('/payments/:id/deliveries', async (req) => {
    const s = await requireUser(ctx, req);
    assertCanMoveMoney(ctx, s, { stepUp: false });
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(
      z.object({
        note: z.string().max(5_000).optional(),
        links: z.array(z.string().url().max(500)).max(20).default([]),
        fileIds: z.array(zUuid).max(20).default([]),
        trackingNumber: z.string().max(60).optional(),
        carrier: z.string().max(40).optional(),
      }),
      req.body,
    );
    const { p, role } = await partyOf(ctx, s.user.id, id);
    if (role !== 'payee') throw forbidden('not_payee', 'Only the payee marks delivery.');
    if (p.loop === 'L4') throw badRequest('use_trade', 'Mark a P2P trade paid from the trade screen.');
    if (p.loop === 'L3' && (!b.trackingNumber || !b.fileIds.length || !b.carrier))
      throw badRequest('shipping_proof', 'Upload the bill of lading or air waybill and enter the carrier and tracking number. The hold starts only when proof is submitted.');
    if (p.loop === 'L2' && !b.fileIds.length && !b.links.length && !b.note) throw badRequest('delivery', 'Attach files or links to your delivery.');
    let trackingValidation: string | undefined;
    if (p.loop === 'L3' && b.carrier && b.trackingNumber) trackingValidation = await ctx.tracking.validate(b.carrier, b.trackingNumber, { destinationCountry: 'NG' });
    return tx(ctx.db, async (q) => {
      const d = await recordDelivery(ctx, q, p, s.user.id, { note: b.note, links: b.links, fileIds: b.fileIds, trackingNumber: b.trackingNumber, carrier: b.carrier, trackingValidation });
      return j({ deliveryId: d.id, evidenceHash: d.hash, trackingValidation: trackingValidation ?? null, bundle: partyCall(p, 'payee', 'markDelivered', ctx.now(), d.hash) });
    });
  });

  // UC3 payer approves.
  app.post('/payments/:id/release', async (req) => {
    const s = await requireUser(ctx, req);
    assertCanMoveMoney(ctx, s);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const { p, role } = await partyOf(ctx, s.user.id, id);
    if (role !== 'payer') throw forbidden('not_payer', 'Only the payer releases this payment.');
    await assertApproved(ctx.db, p, 'release');
    await audit(ctx.db, { type: 'user', id: s.user.id }, 'escrow.release_prepared', 'payment', p.id, {});
    return j({ bundle: partyCall(p, 'payer', 'release', ctx.now()) });
  });

  // C4-6 fallback: if the keeper fails, the payee can trigger release after expiry.
  app.post('/payments/:id/release-after-hold', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const { p } = await partyOf(ctx, s.user.id, id);
    if (p.release_paused_reason) throw conflict('release_paused', `Release is paused: ${p.release_paused_reason}`);
    return j({ bundle: partyCall(p, 'anyone', 'releaseAfterHold', ctx.now()) });
  });

  // UC5: dispute with opening evidence; its hash goes on-chain.
  app.post('/payments/:id/disputes', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(zEvidence, req.body);
    const { p, role } = await partyOf(ctx, s.user.id, id);
    return tx(ctx.db, async (q) => {
      assertAction(p, role, 'dispute', ctx.now());
      const d = await openDisputeRequest(ctx, q, p, role, s.user.id, b);
      return j({ disputeId: d.disputeId, evidenceHash: d.hash, bundle: partyCall(p, role, 'dispute', ctx.now(), d.hash) });
    });
  });

  // Cancel before funding (off-chain only; no fee).
  app.post('/payments/:id/cancel', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ reason: z.string().max(200).default('Cancelled before funding') }), req.body);
    const { p } = await partyOf(ctx, s.user.id, id);
    if (p.status !== 'created') throw conflict('funded', 'A funded payment can only be refunded: ask the payee to return it, or dispute.');
    await tx(ctx.db, async (q) => {
      await q.query("UPDATE app.payments SET status = 'cancelled', cancelled_at = $2, cancel_reason = $3 WHERE id = $1 AND status = 'created'", [p.id, ctx.now(), b.reason]);
      await audit(q, { type: 'user', id: s.user.id }, 'escrow.cancelled_unfunded', 'payment', p.id, { reason: b.reason });
    });
    return { ok: true };
  });

  // C4-10 mutual cancel: payer proposes; the payee refunds with refundByPayee (UC8), no ruling.
  app.post('/payments/:id/cancel-request', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const { p, role } = await partyOf(ctx, s.user.id, id);
    if (!['funded', 'delivered', 'disputed'].includes(p.status)) throw conflict('state', 'Only a funded payment can be cancelled this way.');
    await tx(ctx.db, async (q) => {
      await q.query('UPDATE app.payments SET cancel_requested_by = $2, cancel_requested_at = $3 WHERE id = $1', [p.id, s.user.id, ctx.now()]);
      const other = role === 'payer' ? p.payee_user_id : p.payer_user_id;
      if (other)
        await notify(q, {
          userId: other,
          kind: 'staff_alert',
          vars: { title: 'Cancel request', body: `The other side asked to cancel "${p.title}". ${role === 'payer' ? 'If you agree, return the money to the payer from the payment screen.' : 'The payee offered to return your money.'}` },
          dedupeKey: `cancelreq:${p.id}:${s.user.id}`,
        });
      await audit(q, { type: 'user', id: s.user.id }, 'escrow.cancel_requested', 'payment', p.id, { role });
    });
    return { ok: true };
  });

  app.post('/payments/:id/refund', async (req) => {
    const s = await requireUser(ctx, req);
    assertCanMoveMoney(ctx, s);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const { p, role } = await partyOf(ctx, s.user.id, id);
    if (role !== 'payee') throw forbidden('not_payee', 'Only the payee can give the money back.');
    return j({ bundle: partyCall(p, 'payee', 'refundByPayee', ctx.now()) });
  });

  // UC9 / L3-5: payer reclaims after a missed deadline, without a ruling.
  app.post('/payments/:id/reclaim', async (req) => {
    const s = await requireUser(ctx, req);
    assertCanMoveMoney(ctx, s);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const { p, role } = await partyOf(ctx, s.user.id, id);
    if (role !== 'payer') throw forbidden('not_payer', 'Only the payer can reclaim.');
    return j({ bundle: partyCall(p, 'payer', 'reclaimAfterDeadline', ctx.now()) });
  });

  // L3-7 second approver.
  app.post('/payments/:id/approval-requests', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ action: z.enum(['fund', 'release']) }), req.body);
    const { p, role } = await partyOf(ctx, s.user.id, id);
    if (role !== 'payer' || s.user.kind !== 'business') throw forbidden('not_business_payer', 'Only a business payer requests approvals.');
    const r = await one<{ id: string }>(
      ctx.db,
      `INSERT INTO app.approval_requests (business_id, payment_id, action, requested_by) VALUES ($1,$2,$3,$1) RETURNING id`,
      [s.user.id, p.id, b.action],
    );
    const approvers = await many<{ member_id: string }>(ctx.db, "SELECT member_id FROM app.business_members WHERE business_id = $1 AND role IN ('approver','director')", [s.user.id]);
    for (const a of approvers)
      await notify(ctx.db, { userId: a.member_id, kind: 'staff_alert', vars: { title: 'Approval needed', body: `Approve ${b.action === 'fund' ? 'funding' : 'release'} of "${p.title}" for $${formatUnits(BigInt(p.amount_units))}.` }, dedupeKey: `approval:${r.id}:${a.member_id}` });
    return { id: r.id };
  });

  app.get('/approvals', async (req) => {
    const s = await requireUser(ctx, req);
    return j({
      approvals: await many(
        ctx.db,
        `SELECT a.id, a.action, a.status, a.created_at, p.id AS payment_id, p.title, p.amount_units, p.token, b.company_name
         FROM app.approval_requests a JOIN app.payments p ON p.id = a.payment_id JOIN app.businesses b ON b.user_id = a.business_id
         JOIN app.business_members m ON m.business_id = a.business_id AND m.member_id = $1 AND m.role IN ('approver','director')
         ORDER BY a.created_at DESC LIMIT 100`,
        [s.user.id],
      ),
    });
  });

  app.post('/approvals/:id/decide', async (req) => {
    const s = await requireUser(ctx, req);
    assertCanMoveMoney(ctx, s);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ approve: z.boolean() }), req.body);
    return tx(ctx.db, async (q) => {
      const a = await maybe<{ id: string; business_id: string; requested_by: string; status: string; payment_id: string }>(q, 'SELECT * FROM app.approval_requests WHERE id = $1 FOR UPDATE', [id]);
      if (!a) throw notFound();
      const m = await maybe(q, "SELECT 1 FROM app.business_members WHERE business_id = $1 AND member_id = $2 AND role IN ('approver','director')", [a.business_id, s.user.id]);
      if (!m) throw forbidden('not_approver', 'You are not an approver for this business.');
      if (a.requested_by === s.user.id) throw forbidden('same_person', 'A different person must approve.');
      if (a.status !== 'pending') throw conflict('decided', 'Already decided.');
      await q.query('UPDATE app.approval_requests SET status = $2, approved_by = $3, decided_at = $4 WHERE id = $1', [id, b.approve ? 'approved' : 'rejected', s.user.id, ctx.now()]);
      await audit(q, { type: 'user', id: s.user.id }, b.approve ? 'approval.approved' : 'approval.rejected', 'payment', a.payment_id, { requestId: id });
      return { ok: true };
    });
  });

  // Dispute: party view, evidence (C4-8), second review (C4-9).
  app.get('/disputes/:id', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const d = await maybe<Record<string, unknown> & { payment_id: string; status: string }>(ctx.db, 'SELECT * FROM network.disputes WHERE id = $1', [id]);
    if (!d) throw notFound();
    const { p } = await partyOf(ctx, s.user.id, d.payment_id);
    const ev = await many(ctx.db, 'SELECT id, party, kind, file_id, url, body, sha256, created_at FROM network.dispute_evidence WHERE dispute_id = $1 ORDER BY created_at', [id]);
    const ruled = ['ruled', 'awaiting_signatures', 'executed', 'closed'].includes(d.status);
    return j({
      id: d.id,
      paymentId: p.id,
      status: d.status,
      reason: d.reason,
      openedBy: d.opened_by_role,
      evidenceDueAt: d.evidence_due_at,
      rulingDueAt: d.ruling_due_at,
      ruling: ruled ? (d.final_ruling ?? d.ruling) : null,
      rulingReason: ruled ? (d.final_reason ?? d.ruling_reason) : null,
      reviewWindowEndsAt: d.review_window_ends_at,
      secondReviewRequested: !!d.second_review_requested_at,
      evidence: ev,
    });
  });

  app.post('/disputes/:id/evidence', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ kind: z.enum(['statement', 'file', 'link', 'bank_evidence', 'inspection_report']), body: z.string().max(5_000).optional(), fileIds: z.array(zUuid).max(20).default([]), url: z.string().url().optional() }), req.body);
    return tx(ctx.db, async (q) => {
      const d = await maybe<{ id: string; payment_id: string; status: string; evidence_due_at: Date }>(q, 'SELECT * FROM network.disputes WHERE id = $1 FOR UPDATE', [id]);
      if (!d) throw notFound();
      const { role } = await partyOf(ctx, s.user.id, d.payment_id);
      if (d.status !== 'evidence') throw conflict('evidence_closed', 'Evidence is closed for this dispute.');
      if (d.evidence_due_at < ctx.now()) throw conflict('evidence_closed', 'The evidence window has closed.');
      if (b.body) await q.query('INSERT INTO network.dispute_evidence (dispute_id, party, user_id, kind, body, sha256) VALUES ($1,$2,$3,$4,$5,$6)', [id, role, s.user.id, b.kind === 'file' ? 'statement' : b.kind, b.body, contentHash(b.body).slice(2)]);
      if (b.url) await q.query("INSERT INTO network.dispute_evidence (dispute_id, party, user_id, kind, url, sha256) VALUES ($1,$2,$3,'link',$4,$5)", [id, role, s.user.id, b.url, contentHash(b.url).slice(2)]);
      for (const f of await many<{ id: string; sha256: string }>(q, 'SELECT id, sha256 FROM app.files WHERE id = ANY($1) AND owner_user_id = $2', [b.fileIds, s.user.id])) {
        await q.query('INSERT INTO network.dispute_evidence (dispute_id, party, user_id, kind, file_id, sha256) VALUES ($1,$2,$3,$4,$5,$6)', [id, role, s.user.id, b.kind === 'statement' || b.kind === 'link' ? 'file' : b.kind, f.id, f.sha256]);
        await q.query('UPDATE app.files SET attached_to = $2, attached_at = $3 WHERE id = $1', [f.id, `dispute:${id}`, ctx.now()]);
      }
      await audit(q, { type: 'user', id: s.user.id }, 'dispute.evidence_added', 'dispute', id, { role, kind: b.kind });
      return { ok: true };
    });
  });

  app.post('/disputes/:id/second-review', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return tx(ctx.db, async (q) => {
      const d = await maybe<{ id: string; payment_id: string; status: string; review_window_ends_at: Date | null; second_review_requested_at: Date | null }>(q, 'SELECT * FROM network.disputes WHERE id = $1 FOR UPDATE', [id]);
      if (!d) throw notFound();
      await partyOf(ctx, s.user.id, d.payment_id);
      if (d.second_review_requested_at) throw conflict('already_requested', 'A second review was already requested. Only one is allowed.');
      if (d.status !== 'ruled' || !d.review_window_ends_at || d.review_window_ends_at < ctx.now()) throw conflict('window_closed', 'A second review can be requested only shortly after a ruling.');
      await q.query("UPDATE network.disputes SET second_review_requested_by = $2, second_review_requested_at = $3, status = 'in_review' WHERE id = $1", [id, s.user.id, ctx.now()]);
      await q.query('DELETE FROM network.arbiter_approvals WHERE dispute_id = $1', [id]);
      await audit(q, { type: 'user', id: s.user.id }, 'dispute.second_review_requested', 'dispute', id, {});
      return { ok: true };
    });
  });

  // L2-6 receipt for each released milestone (and any released payment).
  app.get('/payments/:id/receipt.pdf', async (req, reply) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const { p } = await partyOf(ctx, s.user.id, id);
    if (p.status !== 'released') throw conflict('not_released', 'A receipt is available once the payment is released.');
    const payee = await one<{ verified_name: string | null; display_name: string | null; handle: string | null }>(ctx.db, 'SELECT verified_name, display_name, handle FROM app.users WHERE id = $1', [p.payee_user_id]);
    const facts = {
      paymentId: p.id,
      title: p.title,
      amount: formatUnits(BigInt(p.amount_units)),
      fee: formatUnits(BigInt(p.fee_owed_units)),
      paidToPayee: formatUnits(BigInt(p.amount_units) - BigInt(p.fee_owed_units)),
      token: p.token,
      network: p.network,
      escrow: p.escrow_address,
      payee: payee.verified_name ?? payee.display_name,
      releasedAt: p.released_at?.toISOString(),
    };
    const sig = await signDocument(ctx, ctx.db, 'receipt', p.id, facts);
    const pdf = await renderPdf(
      ctx,
      'receipt',
      [
        ['For', p.title],
        ['Paid to', `${facts.payee} (@${payee.handle ?? ''})`],
        ['Amount held', `${facts.amount} ${p.token}`],
        ['Backstop fee', `${facts.fee} ${p.token}`],
        ['Paid to payee', `${facts.paidToPayee} ${p.token}`],
        ['Network', p.network ? NETWORK_INFO[p.network].label : ''],
        ['Escrow contract', p.escrow_address ?? ''],
        ['Released', facts.releasedAt ?? ''],
      ],
      { signed: sig },
    );
    reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="receipt-${p.id}.pdf"`);
    return reply.send(pdf);
  });
}
