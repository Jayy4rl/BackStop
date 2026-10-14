// Uploads for delivery evidence (L2-4, up to 100 MB each), pro forma invoices, shipping documents,
// inspection reports, dispute and appeal evidence. Stored encrypted; unused uploads are deleted
// after 7 days by the keeper (architecture doc, "Evidence for delivery or dispute").
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.ts';
import { maybe, one } from '../db/pool.ts';
import { audit } from '../lib/audit.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { badRequest, forbidden, notFound, tooMany } from '../lib/errors.ts';
import { clientIp, optionalUser, parse, requireStaff, requireUser, zUuid } from '../http.ts';

const PURPOSES = ['delivery', 'proforma', 'shipping_document', 'inspection_report', 'dispute_evidence', 'appeal_evidence', 'report_evidence', 'bank_evidence', 'support'] as const;
const ALLOWED_MIME = /^(application\/pdf|image\/(png|jpeg|webp|heic)|text\/plain|application\/zip|application\/vnd\.openxmlformats-officedocument\.[a-z.]+|application\/msword|video\/mp4)$/;

async function readUpload(ctx: Ctx, req: FastifyRequest): Promise<{ data: Buffer; filename: string; mime: string; purpose: string }> {
  const part = await req.file({ limits: { fileSize: ctx.cfg.maxUploadBytes } });
  if (!part) throw badRequest('file', 'Attach a file.');
  const purpose = String((part.fields.purpose as { value?: string } | undefined)?.value ?? '');
  if (!PURPOSES.includes(purpose as (typeof PURPOSES)[number])) throw badRequest('purpose', 'Unknown upload purpose.');
  if (!ALLOWED_MIME.test(part.mimetype)) throw badRequest('file_type', 'Upload a PDF, image, document, ZIP or MP4 file.');
  const data = await part.toBuffer().catch(() => {
    throw badRequest('file_too_large', 'Files can be up to 100 MB each.');
  });
  if (part.file.truncated) throw badRequest('file_too_large', 'Files can be up to 100 MB each.');
  return { data, filename: part.filename.slice(0, 200), mime: part.mimetype, purpose };
}

export function registerFiles(app: FastifyInstance, ctx: Ctx): void {
  app.post('/files', async (req) => {
    const s = await requireUser(ctx, req);
    const u = await readUpload(ctx, req);
    const key = await ctx.blobs.put(u.data);
    const r = await one<{ id: string; created_at: Date }>(
      ctx.db,
      'INSERT INTO app.files (owner_user_id, purpose, filename, mime, size_bytes, sha256, storage_key) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at',
      [s.user.id, u.purpose, u.filename, u.mime, u.data.length, sha256Hex(u.data), key],
    );
    return { id: r.id, sha256: sha256Hex(u.data), size: u.data.length, uploadedAt: r.created_at };
  });

  // Public evidence upload for appeals (no account needed; rate-limited, bot-protected).
  app.post('/public/files', async (req) => {
    const ip = clientIp(req);
    if (!(await ctx.limiter.hit(`pubfile:${ip}`, 20, 3600))) throw tooMany();
    if (!(await ctx.captcha.verify(req.headers['x-captcha-token'] as string | undefined, ip))) throw forbidden('captcha', 'Complete the bot check.');
    const u = await readUpload(ctx, req);
    if (u.purpose !== 'appeal_evidence') throw badRequest('purpose', 'Only appeal evidence can be uploaded here.');
    const key = await ctx.blobs.put(u.data);
    const r = await one<{ id: string }>(ctx.db, 'INSERT INTO app.files (purpose, filename, mime, size_bytes, sha256, storage_key) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [
      u.purpose,
      u.filename,
      u.mime,
      u.data.length,
      sha256Hex(u.data),
      key,
    ]);
    return { id: r.id, sha256: sha256Hex(u.data) };
  });

  // Download: the owner, a party to a payment/dispute the file is attached to, or staff.
  app.get('/files/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const f = await maybe<{ id: string; owner_user_id: string | null; storage_key: string; filename: string; mime: string; attached_to: string | null; deleted_at: Date | null }>(
      ctx.db,
      'SELECT * FROM app.files WHERE id = $1',
      [id],
    );
    if (!f || f.deleted_at) throw notFound('File not found.');
    const user = await optionalUser(ctx, req);
    let allowed = !!user && f.owner_user_id === user.user.id;
    if (!allowed && user) {
      const party = await maybe(
        ctx.db,
        `SELECT 1 FROM app.deliveries d JOIN app.payments p ON p.id = d.payment_id WHERE $1 = ANY(d.file_ids) AND (p.payer_user_id = $2 OR p.payee_user_id = $2)
         UNION SELECT 1 FROM app.trade_orders o WHERE o.proforma_file_id = $1 AND (o.importer_id = $2 OR o.supplier_user_id = $2)
         UNION SELECT 1 FROM network.dispute_evidence e JOIN network.disputes d ON d.id = e.dispute_id JOIN app.payments p ON p.id = d.payment_id
               WHERE e.file_id = $1 AND (p.payer_user_id = $2 OR p.payee_user_id = $2)`,
        [id, user.user.id],
      );
      allowed = !!party;
    }
    let staffId: string | null = null;
    if (!allowed) {
      const st = await requireStaff(ctx, req).catch(() => null);
      allowed = !!st;
      staffId = st?.id ?? null;
    }
    if (!allowed) throw forbidden('file_access', 'You do not have access to this file.');
    if (staffId) await audit(ctx.db, { type: 'staff', id: staffId }, 'file.viewed', 'file', id, {});
    const data = await ctx.blobs.get(f.storage_key);
    reply.header('content-type', f.mime).header('content-disposition', `attachment; filename="${f.filename.replace(/"/g, '')}"`);
    return reply.send(data);
  });
}
