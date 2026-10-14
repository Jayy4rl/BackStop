// Test harness: a fresh Postgres database per test file, the real app with sandbox adapters, a
// controllable clock, and helpers that drive the real sign-up flow (OTP, passkey, wallet proofs).
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { generatePrivateKey, privateKeyToAccount, sign, serializeSignature } from 'viem/accounts';
import { hexToTron, tronMessageHash, type Network } from '@backstop/shared';
import type { Hex } from 'viem';
import { loadConfig, type Config } from '../../src/config.ts';
import { createCtx, type Ctx, type CtxOverrides } from '../../src/ctx.ts';
import { ensureDatabase, migrate } from '../../src/db/migrate.ts';
import { buildApp } from '../../src/app.ts';
import { seedReferenceData } from '../../src/seed.ts';
import { MemoryRateLimiter } from '../../src/lib/ratelimit.ts';
import { SoftAuthenticator } from './webauthn.ts';

export const ORIGIN = 'http://localhost:5173';
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';

export interface Harness {
  ctx: Ctx;
  app: FastifyInstance;
  clock: { now: Date; advance(ms: number): void; set(d: Date): void };
  dbName: string;
  close(): Promise<void>;
}

export async function createHarness(opts: { cfg?: Partial<Config>; overrides?: CtxOverrides } = {}): Promise<Harness> {
  const dbName = `backstop_test_${randomBytes(5).toString('hex')}`;
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  await ensureDatabase(url.toString());
  await migrate(url.toString());
  process.env.NODE_ENV = 'test';
  const base = loadConfig();
  const cfg: Config = {
    ...base,
    env: 'test',
    databaseUrl: url.toString(),
    redisUrl: null,
    storageDir: mkdtempSync(join(tmpdir(), 'backstop-files-')),
    webauthn: { rpId: 'localhost', rpName: 'Backstop', origins: [ORIGIN] },
    webBaseUrl: ORIGIN,
    chains: {},
    p2pEnabled: true,
    ...opts.cfg,
  };
  const clock = {
    now: new Date('2026-10-14T10:00:00Z'),
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
    set(d: Date) {
      this.now = d;
    },
  };
  const ctx = createCtx(cfg, { redis: null, limiter: new MemoryRateLimiter(), now: () => clock.now, ...opts.overrides });
  await ctx.versioned.ensureDefaults();
  await seedReferenceData(ctx);
  const app = await buildApp(ctx, { logger: !!process.env.TEST_LOG });
  return {
    ctx,
    app,
    clock,
    dbName,
    async close() {
      await app.close();
      await ctx.db.end();
      const admin = new pg.Client({ connectionString: ADMIN_URL });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    },
  };
}

export interface TestUser {
  id: string;
  token: string;
  handle: string | null;
  email: string;
  phone: string;
  key: Hex;
  evm: Hex;
  tron: string;
  auth: SoftAuthenticator;
  device: string;
}

type Inject = { method: string; url: string; payload?: unknown; token?: string; headers?: Record<string, string> };

export async function call<T = any>(h: Harness, r: Inject): Promise<{ status: number; body: T }> {
  const res = await h.app.inject({
    method: r.method as 'GET',
    url: r.url,
    payload: r.payload as Record<string, unknown>,
    headers: { ...(r.token ? { authorization: `Bearer ${r.token}` } : {}), ...(r.headers ?? {}) },
  });
  let body: unknown = res.body;
  try {
    body = JSON.parse(res.body);
  } catch {
    // not JSON (PDF, CSV)
  }
  return { status: res.statusCode, body: body as T };
}

export async function ok<T = any>(h: Harness, r: Inject): Promise<T> {
  const res = await call<T>(h, r);
  if (res.status >= 300) throw new Error(`${r.method} ${r.url} -> ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function lastOtp(h: Harness, destination: string): Promise<string> {
  const r = await h.ctx.db.query('SELECT body FROM ops.outbox WHERE destination = $1 ORDER BY id DESC LIMIT 1', [destination]);
  const m = /code is (\d{6})/.exec(String(r.rows[0]?.body ?? ''));
  if (!m) throw new Error(`no OTP for ${destination}`);
  return m[1]!;
}

export async function tronSign(key: Hex, message: string): Promise<string> {
  return serializeSignature(await sign({ hash: tronMessageHash(message), privateKey: key }));
}

let counter = 0;

export async function signup(h: Harness, o: { kind?: 'individual' | 'business' | 'counterparty'; handle?: string; country?: string; displayName?: string; key?: Hex } = {}): Promise<TestUser> {
  counter += 1;
  const tag = `${Date.now().toString(36)}${counter}`;
  const handle = o.kind === 'counterparty' ? null : (o.handle ?? `user${tag}`.slice(0, 20));
  const email = `${handle ?? `cp${tag}`}@example.com`;
  const phone = `+234803${String(1_000_000 + counter * 7919).slice(-7)}`;
  const start = await ok(h, { method: 'POST', url: '/auth/signup/start', payload: { kind: o.kind ?? 'individual', email, phone, handle: handle ?? undefined, displayName: o.displayName ?? `User ${tag}`, country: o.country ?? 'NG', consent: { version: 'ndpa-2023-v1', accepted: true } } });
  const verify = await ok(h, {
    method: 'POST',
    url: '/auth/signup/verify',
    payload: { signupId: start.signupId, phoneOtpId: start.phoneOtpId, phoneCode: await lastOtp(h, phone), emailOtpId: start.emailOtpId, emailCode: await lastOtp(h, email) },
  });
  const auth = new SoftAuthenticator('localhost', ORIGIN);
  const key = o.key ?? generatePrivateKey();
  const acct = privateKeyToAccount(key);
  const tron = hexToTron(acct.address);
  const tmpl: string = verify.walletLink.messageTemplate;
  const evmMsg = tmpl.replace('{address}', acct.address);
  const tronMsg = tmpl.replace('{address}', tron);
  const device = `device-${tag}`;
  const fin = await ok(h, {
    method: 'POST',
    url: '/auth/signup/finish',
    payload: {
      challengeId: verify.challengeId,
      credential: auth.register(verify.options),
      deviceFingerprint: device,
      deviceLabel: 'Test phone',
      wallet: { provider: 'sandbox', providerWalletId: `w-${tag}`, evmAddress: acct.address, tronAddress: tron, evmSignature: await acct.signMessage({ message: evmMsg }), tronSignature: await tronSign(key, tronMsg) },
    },
  });
  return { id: fin.userId, token: fin.token, handle, email, phone, key, evm: acct.address, tron, auth, device };
}

export async function stepUp(h: Harness, u: TestUser): Promise<void> {
  const o = await ok(h, { method: 'POST', url: '/auth/step-up/options', token: u.token });
  await ok(h, { method: 'POST', url: '/auth/step-up/finish', token: u.token, payload: { challengeId: o.challengeId, credential: u.auth.assert(o.options, u.id) } });
}

export async function tier1(h: Harness, u: TestUser, first = 'Ada', last = 'Okafor'): Promise<void> {
  const id = `2${String(Math.floor(Math.random() * 1e10)).padStart(10, '1')}`;
  await ok(h, { method: 'POST', url: '/identity/tier1', token: u.token, payload: { idType: 'bvn', idNumber: id, firstName: first, lastName: last, dateOfBirth: '1990-01-01', livenessToken: 'live-ok' } });
}

export async function addStaff(h: Harness, email: string, roles: string[]): Promise<string> {
  const r = await h.ctx.db.query('INSERT INTO app.staff (email, name, roles) VALUES ($1,$1,$2) RETURNING id', [email, roles]);
  return r.rows[0].id as string;
}

/** Sandbox SSO + TOTP enrolment; returns a staff bearer token. */
export async function staffLogin(h: Harness, email: string): Promise<string> {
  const OTPAuth = await import('otpauth');
  const start = await ok(h, { method: 'GET', url: '/staff/sso/start' });
  const cb = await ok(h, { method: 'POST', url: '/staff/sso/callback', payload: { state: start.state, code: email } });
  const token = cb.token as string;
  const r = await h.ctx.db.query('SELECT totp_secret_enc FROM app.staff WHERE email = $1', [email]);
  let secret: string;
  if (!r.rows[0].totp_secret_enc) secret = (await ok(h, { method: 'POST', url: '/staff/mfa/enroll', token })).secret;
  else secret = h.ctx.crypto.decrypt(r.rows[0].totp_secret_enc, `totp:${(await h.ctx.db.query('SELECT id FROM app.staff WHERE email = $1', [email])).rows[0].id}`).toString();
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate({ timestamp: h.clock.now.getTime() });
  await ok(h, { method: 'POST', url: '/staff/mfa/verify', token, payload: { code } });
  return token;
}

export function network(n: Network): Network {
  return n;
}
