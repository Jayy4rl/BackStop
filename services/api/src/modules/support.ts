// In-app support chat (NFR Support): a human response within 4 business hours for anything
// involving held or escrowed funds.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addBusinessHours } from '@backstop/shared';
import type { Ctx } from '../ctx.ts';
import { maybe, many, one, tx } from '../db/pool.ts';
import { notFound } from '../lib/errors.ts';
import { j, parse, requireUser, zUuid } from '../http.ts';
import { notifyStaff } from '../services/notify.ts';

export function registerSupport(app: FastifyInstance, ctx: Ctx): void {
  app.post('/support/threads', async (req) => {
    const s = await requireUser(ctx, req);
    const b = parse(z.object({ subject: z.string().min(3).max(200), body: z.string().min(1).max(5_000), paymentId: zUuid.optional(), transferId: zUuid.optional() }), req.body);
    let funds = false;
    if (b.paymentId) {
      const p = await maybe<{ status: string }>(ctx.db, 'SELECT status FROM app.payments WHERE id = $1 AND (payer_user_id = $2 OR payee_user_id = $2)', [b.paymentId, s.user.id]);
      if (!p) throw notFound('Payment not found.');
      funds = ['funded', 'delivered', 'disputed'].includes(p.status);
    }
    if (b.transferId) {
      const t = await maybe<{ availability: string }>(ctx.db, 'SELECT availability FROM app.transfers WHERE id = $1 AND user_id = $2', [b.transferId, s.user.id]);
      if (!t) throw notFound('Transfer not found.');
      funds = funds || ['on_hold', 'under_review', 'unsupported_pair'].includes(t.availability);
    }
    const holidays = await ctx.versioned.holidays();
    const due = funds ? addBusinessHours(ctx.now(), 4, holidays) : addBusinessHours(ctx.now(), 16, holidays);
    const id = await tx(ctx.db, async (q) => {
      const t = await one<{ id: string }>(q, 'INSERT INTO app.support_threads (user_id, subject, payment_id, transfer_id, funds_involved, first_response_due) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [
        s.user.id,
        b.subject,
        b.paymentId ?? null,
        b.transferId ?? null,
        funds,
        due,
      ]);
      await q.query('INSERT INTO app.support_messages (thread_id, author_user_id, body) VALUES ($1,$2,$3)', [t.id, s.user.id, b.body]);
      if (funds) await notifyStaff(q, 'support', 'Support: funds involved', `${b.subject} (respond by ${due.toISOString()})`, { threadId: t.id }, `support-new:${t.id}`);
      return t.id;
    });
    return { id, firstResponseDue: due, fundsInvolved: funds };
  });

  app.get('/support/threads', async (req) => {
    const s = await requireUser(ctx, req);
    return j({ threads: await many(ctx.db, 'SELECT * FROM app.support_threads WHERE user_id = $1 ORDER BY created_at DESC', [s.user.id]) });
  });

  app.get('/support/threads/:id', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const t = await maybe(ctx.db, 'SELECT * FROM app.support_threads WHERE id = $1 AND user_id = $2', [id, s.user.id]);
    if (!t) throw notFound();
    const msgs = await many(ctx.db, 'SELECT id, body, created_at, author_staff_id IS NOT NULL AS from_support FROM app.support_messages WHERE thread_id = $1 ORDER BY created_at', [id]);
    return j({ thread: t, messages: msgs });
  });

  app.post('/support/threads/:id/messages', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ body: z.string().min(1).max(5_000) }), req.body);
    const t = await maybe(ctx.db, 'SELECT id FROM app.support_threads WHERE id = $1 AND user_id = $2', [id, s.user.id]);
    if (!t) throw notFound();
    await ctx.db.query('INSERT INTO app.support_messages (thread_id, author_user_id, body) VALUES ($1,$2,$3)', [id, s.user.id, b.body]);
    await ctx.db.query("UPDATE app.support_threads SET status = 'open' WHERE id = $1", [id]);
    return { ok: true };
  });

  app.get('/notifications', async (req) => {
    const s = await requireUser(ctx, req);
    return j({ notifications: await many(ctx.db, 'SELECT id, kind, title, body, data, created_at, read_at FROM app.notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [s.user.id]) });
  });

  app.post('/notifications/read', async (req) => {
    const s = await requireUser(ctx, req);
    await ctx.db.query('UPDATE app.notifications SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL', [s.user.id, ctx.now()]);
    return { ok: true };
  });
}
