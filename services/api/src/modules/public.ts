// Public endpoints: document verification and client configuration.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NETWORK_INFO, type Network } from '@backstop/shared';
import type { Ctx } from '../ctx.ts';
import { maybe } from '../db/pool.ts';
import { notFound, tooMany } from '../lib/errors.ts';
import { clientIp, parse } from '../http.ts';
import { CONSENT_TEXT, CONSENT_VERSION } from './auth.ts';

export function registerPublic(app: FastifyInstance, ctx: Ctx): void {
  // Anyone (a supplier's bank, a seller's bank) can check a signed Backstop document.
  app.get('/public/documents/:code', async (req) => {
    if (!(await ctx.limiter.hit(`docverify:${clientIp(req)}`, 120, 3600))) throw tooMany();
    const { code } = parse(z.object({ code: z.string().min(6).max(40) }), req.params);
    const d = await maybe<{ kind: string; canonical: string; signature: string; public_key: string; created_at: Date }>(ctx.db, 'SELECT * FROM app.documents WHERE verify_code = $1', [code]);
    if (!d) throw notFound('No Backstop document has that code.');
    return {
      kind: d.kind,
      issuedAt: d.created_at,
      facts: JSON.parse(d.canonical),
      signature: d.signature,
      publicKey: d.public_key,
      signatureValid: ctx.crypto.verifyDocument(d.canonical, d.signature) && d.public_key === ctx.crypto.signingPublicKeyHex,
    };
  });

  app.get('/public/config', async () => ({
    networks: (Object.keys(NETWORK_INFO) as Network[]).map((n) => ({ ...NETWORK_INFO[n], enabled: !!ctx.cfg.chains[n], escrow: !!ctx.cfg.chains[n]?.factory, chainId: ctx.cfg.chains[n]?.chainId ?? null })),
    p2pEnabled: ctx.cfg.p2pEnabled,
    captcha: { provider: ctx.captcha.name, siteKey: process.env.TURNSTILE_SITE_KEY ?? null },
    consent: { version: CONSENT_VERSION, text: CONSENT_TEXT },
    walletProvider: ctx.cfg.adapters.wallet,
    documentPublicKey: ctx.crypto.signingPublicKeyHex,
  }));
}
