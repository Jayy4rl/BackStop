import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import type { Ctx } from './ctx.ts';
import { ApiError } from './lib/errors.ts';
import { registerAuth } from './modules/auth.ts';
import { registerIdentity } from './modules/identity.ts';
import { registerWallet } from './modules/wallet.ts';
import { registerFiles } from './modules/files.ts';
import { registerPayments } from './modules/payments.ts';
import { registerInvoices } from './modules/invoices.ts';
import { registerOrders } from './modules/orders.ts';
import { registerP2p } from './modules/p2p.ts';
import { registerFraud } from './modules/fraud.ts';
import { registerStaff } from './modules/staff.ts';
import { registerSupport } from './modules/support.ts';
import { registerPublic } from './modules/public.ts';

export async function buildApp(ctx: Ctx, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(cors, { origin: [ctx.cfg.webBaseUrl, ...ctx.cfg.webauthn.origins], credentials: true });
  await app.register(multipart, { limits: { fileSize: ctx.cfg.maxUploadBytes, files: 1 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: e.message } });
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong on our side. Nothing was sent. Try again.' } });
  });

  app.get('/health', async () => ({ ok: true }));
  registerAuth(app, ctx);
  registerIdentity(app, ctx);
  registerWallet(app, ctx);
  registerFiles(app, ctx);
  registerPayments(app, ctx);
  registerInvoices(app, ctx);
  registerOrders(app, ctx);
  registerP2p(app, ctx);
  registerFraud(app, ctx);
  registerStaff(app, ctx);
  registerSupport(app, ctx);
  registerPublic(app, ctx);
  return app;
}
