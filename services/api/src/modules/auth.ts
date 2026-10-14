// C1-1 sign-up (phone and email OTP, passkey created at the same time as the wallet), passkey
// sign-in, C1-8 re-verification after a new device or phone change, passkey step-up for money
// movement, and C2-2 recovery (second passkey, or provider recovery with identity re-check and a
// 48-hour lock on outgoing transfers).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { challengeMessage, checkEvmAddress, checkTronAddress, verifyOwnership } from '@backstop/shared';
import type { Ctx } from '../ctx.ts';
import { maybe, one, tx, type Queryable } from '../db/pool.ts';
import { audit } from '../lib/audit.ts';
import { randomCode, randomToken, sha256Hex, safeEqual } from '../lib/crypto.ts';
import { badRequest, conflict, forbidden, notFound, tooMany, unauthorized } from '../lib/errors.ts';
import { clientIp, j, parse, requireUser, SESSION_COOKIE, type UserRow } from '../http.ts';
import { notify } from '../services/notify.ts';
import { screenUser } from './identity.ts';

const OTP_TTL_MS = 10 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const CHALLENGE_TTL_MS = 5 * 60_000;
export const CONSENT_VERSION = 'ndpa-2023-v1';
export const CONSENT_TEXT =
  'I agree that Backstop may process my identity data (phone, email, BVN or NIN, selfie and liveness result) to verify who I am, to screen against sanctions lists, to prevent fraud and to resolve disputes, under the Nigeria Data Protection Act 2023. Data is encrypted and kept only as long as the law requires.';

const zPhone = z.string().regex(/^\+[1-9]\d{7,14}$/, 'phone must be in international format, e.g. +2348031234567');
const zHandle = z.string().regex(/^[a-z0-9_]{3,20}$/i, 'handle: 3-20 letters, digits or _');
const zDevice = z.string().min(8).max(200);

// ---------------------------------------------------------------- OTP

export async function sendOtp(ctx: Ctx, q: Queryable, channel: 'sms' | 'email', destination: string, purpose: string, userId: string | null): Promise<string> {
  if (!(await ctx.limiter.hit(`otp:${destination}`, 5, 3600))) throw tooMany('Too many codes requested. Try again in an hour.');
  const code = randomCode(6);
  const r = await one<{ id: string }>(
    q,
    'INSERT INTO app.otp_challenges (channel, destination, purpose, user_id, code_hash, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [channel, destination, purpose, userId, sha256Hex(`${destination}:${code}`), new Date(ctx.now().getTime() + OTP_TTL_MS)],
  );
  const body = `Your Backstop code is ${code}. It expires in 10 minutes. Never share it.`;
  await ctx.messengers[channel].send(q, { channel, to: destination, subject: 'Your Backstop code', body, data: { purpose } });
  return r.id;
}

export async function checkOtp(ctx: Ctx, q: Queryable, id: string, code: string, purpose: string): Promise<{ destination: string; userId: string | null }> {
  const row = await maybe<{ id: string; destination: string; user_id: string | null; code_hash: string; attempts: number; expires_at: Date; consumed_at: Date | null; purpose: string }>(
    q,
    'SELECT * FROM app.otp_challenges WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!row || row.purpose !== purpose) throw badRequest('otp_invalid', 'That code is not valid. Request a new one.');
  if (row.consumed_at || row.expires_at < ctx.now()) throw badRequest('otp_expired', 'That code has expired. Request a new one.');
  if (row.attempts >= OTP_MAX_ATTEMPTS) throw tooMany('Too many wrong codes. Request a new one.');
  if (!safeEqual(row.code_hash, sha256Hex(`${row.destination}:${code}`))) {
    await q.query('UPDATE app.otp_challenges SET attempts = attempts + 1 WHERE id = $1', [id]);
    throw badRequest('otp_wrong', 'That code is not right.');
  }
  await q.query('UPDATE app.otp_challenges SET consumed_at = $2 WHERE id = $1', [id, ctx.now()]);
  return { destination: row.destination, userId: row.user_id };
}

// ---------------------------------------------------------------- sessions

async function createSession(ctx: Ctx, q: Queryable, userId: string, deviceId: string | null, passkeyNow: boolean): Promise<string> {
  const token = randomToken();
  await q.query('INSERT INTO app.sessions (user_id, device_id, token_hash, expires_at, last_passkey_at) VALUES ($1,$2,$3,$4,$5)', [
    userId,
    deviceId,
    sha256Hex(token),
    new Date(ctx.now().getTime() + ctx.cfg.sessionTtlHours * 3600_000),
    passkeyNow ? ctx.now() : null,
  ]);
  return token;
}

function setSessionCookie(ctx: Ctx, reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: ctx.cfg.env === 'production', path: '/', maxAge: ctx.cfg.sessionTtlHours * 3600 });
}

/** Records the device; returns whether it is new for this user. */
async function touchDevice(q: Queryable, userId: string, fingerprint: string, label: string | undefined, trust: boolean): Promise<{ id: string; isNew: boolean; trusted: boolean }> {
  const ex = await maybe<{ id: string; trusted_at: Date | null }>(q, 'SELECT id, trusted_at FROM app.devices WHERE user_id = $1 AND fingerprint = $2', [userId, fingerprint]);
  if (ex) return { id: ex.id, isNew: false, trusted: !!ex.trusted_at };
  const r = await one<{ id: string }>(q, 'INSERT INTO app.devices (user_id, fingerprint, label, trusted_at) VALUES ($1,$2,$3,$4) RETURNING id', [userId, fingerprint, label ?? null, trust ? new Date() : null]);
  return { id: r.id, isNew: true, trusted: trust };
}

// ---------------------------------------------------------------- WebAuthn

async function storeChallenge(ctx: Ctx, q: Queryable, userId: string | null, purpose: string, challenge: string, data: Record<string, unknown> = {}): Promise<string> {
  const r = await one<{ id: string }>(q, 'INSERT INTO app.webauthn_challenges (user_id, purpose, challenge, data, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id', [
    userId,
    purpose,
    challenge,
    JSON.stringify(data),
    new Date(ctx.now().getTime() + CHALLENGE_TTL_MS),
  ]);
  return r.id;
}

async function takeChallenge(ctx: Ctx, q: Queryable, id: string, purpose: string): Promise<{ user_id: string | null; challenge: string; data: Record<string, unknown> }> {
  const row = await maybe<{ user_id: string | null; challenge: string; data: Record<string, unknown>; expires_at: Date; used_at: Date | null; purpose: string }>(
    q,
    'SELECT * FROM app.webauthn_challenges WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!row || row.purpose !== purpose || row.used_at || row.expires_at < ctx.now()) throw badRequest('challenge_invalid', 'This passkey request expired. Try again.');
  await q.query('UPDATE app.webauthn_challenges SET used_at = $2 WHERE id = $1', [id, ctx.now()]);
  return row;
}

async function registrationOptions(ctx: Ctx, q: Queryable, user: { id: string; email: string; handle: string | null }, purpose: string, data: Record<string, unknown> = {}) {
  const existing = await q.query('SELECT credential_id, transports FROM app.passkeys WHERE user_id = $1 AND revoked_at IS NULL', [user.id]);
  const options = await generateRegistrationOptions({
    rpName: ctx.cfg.webauthn.rpName,
    rpID: ctx.cfg.webauthn.rpId,
    userName: user.handle ?? user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    excludeCredentials: existing.rows.map((r) => ({ id: r.credential_id as string, transports: r.transports as string[] })),
  });
  const challengeId = await storeChallenge(ctx, q, user.id, purpose, options.challenge, data);
  return { challengeId, options };
}

async function verifyRegistration(ctx: Ctx, q: Queryable, userId: string, expectedChallenge: string, response: RegistrationResponseJSON, label?: string): Promise<string> {
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ctx.cfg.webauthn.origins,
    expectedRPID: ctx.cfg.webauthn.rpId,
    requireUserVerification: true,
  }).catch((e: Error) => {
    throw badRequest('passkey_invalid', `Passkey could not be verified: ${e.message}`);
  });
  if (!v.verified) throw badRequest('passkey_invalid', 'Passkey could not be verified.');
  const c = v.registrationInfo.credential;
  await q.query('INSERT INTO app.passkeys (user_id, credential_id, public_key, counter, transports, device_label) VALUES ($1,$2,$3,$4,$5,$6)', [
    userId,
    c.id,
    Buffer.from(c.publicKey),
    c.counter,
    c.transports ?? [],
    label ?? null,
  ]);
  return c.id;
}

async function authenticationOptions(ctx: Ctx, q: Queryable, userId: string | null, purpose: string) {
  const creds = userId ? await q.query('SELECT credential_id, transports FROM app.passkeys WHERE user_id = $1 AND revoked_at IS NULL', [userId]) : { rows: [] };
  const options = await generateAuthenticationOptions({
    rpID: ctx.cfg.webauthn.rpId,
    userVerification: 'required',
    allowCredentials: creds.rows.map((r) => ({ id: r.credential_id as string, transports: r.transports as never })),
  });
  const challengeId = await storeChallenge(ctx, q, userId, purpose, options.challenge);
  return { challengeId, options };
}

async function verifyAssertion(ctx: Ctx, q: Queryable, expectedUserId: string | null, challenge: string, response: AuthenticationResponseJSON): Promise<string> {
  const pk = await maybe<{ id: string; user_id: string; credential_id: string; public_key: Buffer; counter: bigint; transports: string[] }>(
    q,
    'SELECT * FROM app.passkeys WHERE credential_id = $1 AND revoked_at IS NULL',
    [response.id],
  );
  if (!pk || (expectedUserId && pk.user_id !== expectedUserId)) throw unauthorized('That passkey is not registered to this account.');
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: ctx.cfg.webauthn.origins,
    expectedRPID: ctx.cfg.webauthn.rpId,
    credential: { id: pk.credential_id, publicKey: new Uint8Array(pk.public_key), counter: Number(pk.counter), transports: pk.transports as never },
    requireUserVerification: true,
  }).catch((e: Error) => {
    throw unauthorized(`Passkey check failed: ${e.message}`);
  });
  if (!v.verified) throw unauthorized('Passkey check failed.');
  await q.query('UPDATE app.passkeys SET counter = $2, last_used_at = $3 WHERE id = $1', [pk.id, v.authenticationInfo.newCounter, ctx.now()]);
  return pk.user_id;
}

// ---------------------------------------------------------------- wallet linking (C2)

/**
 * Non-custodial wallet: keys live in the embedded wallet on the user's device, gated by the
 * passkey. Backstop learns only the addresses, and requires a signature from each to prove they
 * belong to this user (no Backstop key can move funds, C2-1).
 */
export function walletLinkMessage(userId: string, address: string, nonce: string, issuedAt: Date): string {
  return challengeMessage({ address, nonce: `${userId}:${nonce}`, purpose: 'wallet_link', issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + CHALLENGE_TTL_MS).toISOString() });
}

const zWallet = z.object({
  provider: z.string().min(1).max(40),
  providerWalletId: z.string().min(1).max(200),
  evmAddress: z.string(),
  tronAddress: z.string(),
  evmSignature: z.string(),
  tronSignature: z.string(),
});

async function linkWallet(ctx: Ctx, q: Queryable, userId: string, nonce: string, issuedAt: Date, w: z.infer<typeof zWallet>): Promise<void> {
  const evm = checkEvmAddress(w.evmAddress);
  const tron = checkTronAddress(w.tronAddress);
  if (!evm.valid || !tron.valid) throw badRequest('wallet_invalid', 'Wallet addresses are not valid.');
  const okEvm = await verifyOwnership(evm.normalized, walletLinkMessage(userId, evm.normalized, nonce, issuedAt), w.evmSignature);
  const okTron = await verifyOwnership(tron.normalized, walletLinkMessage(userId, tron.normalized, nonce, issuedAt), w.tronSignature);
  if (!okEvm || !okTron) throw badRequest('wallet_signature', 'Wallet ownership signatures did not verify.');
  await q
    .query(
      `INSERT INTO app.wallets (user_id, provider, provider_wallet_id, evm_address, tron_address) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET provider = EXCLUDED.provider, provider_wallet_id = EXCLUDED.provider_wallet_id, evm_address = EXCLUDED.evm_address, tron_address = EXCLUDED.tron_address`,
      [userId, w.provider, w.providerWalletId, evm.normalized, tron.normalized],
    )
    .catch((e: Error & { code?: string }) => {
      if (e.code === '23505') throw conflict('wallet_taken', 'This wallet is already linked to another account.');
      throw e;
    });
}

// ---------------------------------------------------------------- routes

export function registerAuth(app: FastifyInstance, ctx: Ctx): void {
  app.get('/auth/consent', async () => ({ version: CONSENT_VERSION, text: CONSENT_TEXT }));

  // Step 1: details and consent; OTP to both phone and email.
  app.post('/auth/signup/start', async (req) => {
    const b = parse(
      z.object({
        kind: z.enum(['individual', 'business', 'counterparty']).default('individual'),
        email: z.string().email().max(200),
        phone: zPhone,
        handle: zHandle.optional(),
        displayName: z.string().min(1).max(100),
        country: z.string().length(2).default('NG'),
        consent: z.object({ version: z.literal(CONSENT_VERSION), accepted: z.literal(true) }),
      }),
      req.body,
    );
    if (b.kind !== 'counterparty' && b.country.toUpperCase() !== 'NG') throw badRequest('country', 'Backstop accounts are for people and registered businesses in Nigeria. Clients and suppliers abroad pay or get paid through a link.');
    if (b.kind !== 'counterparty' && !b.handle) throw badRequest('handle_required', 'Choose a handle, e.g. @ada.');
    if (!(await ctx.limiter.hit(`signup:${clientIp(req)}`, 20, 3600))) throw tooMany();
    return tx(ctx.db, async (q) => {
      const taken = await maybe<{ id: string; email_verified_at: Date | null; phone_verified_at: Date | null; handle: string | null; email: string }>(
        q,
        'SELECT id, email_verified_at, phone_verified_at, handle, email FROM app.users WHERE tenant_id = $1 AND (lower(email) = lower($2) OR (handle IS NOT NULL AND lower(handle) = lower($3)))',
        [ctx.cfg.tenantId, b.email, b.handle ?? null],
      );
      let userId: string;
      if (taken) {
        const passkeys = await q.query('SELECT 1 FROM app.passkeys WHERE user_id = $1', [taken.id]);
        if (passkeys.rowCount) throw conflict('account_exists', taken.email.toLowerCase() === b.email.toLowerCase() ? 'An account with this email already exists. Sign in instead.' : 'That handle is taken.');
        if (taken.email.toLowerCase() !== b.email.toLowerCase()) throw conflict('handle_taken', 'That handle is taken.');
        userId = taken.id;
        await q.query('UPDATE app.users SET phone_e164 = $2, handle = $3, display_name = $4, kind = $5, country = $6 WHERE id = $1', [userId, b.phone, b.handle ?? null, b.displayName, b.kind, b.country.toUpperCase()]);
      } else {
        const r = await one<{ id: string }>(
          q,
          'INSERT INTO app.users (tenant_id, kind, email, phone_e164, handle, display_name, country, tier) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
          [ctx.cfg.tenantId, b.kind, b.email, b.phone, b.handle ?? null, b.displayName, b.country.toUpperCase(), b.kind === 'counterparty' ? 'counterparty' : 'none'],
        );
        userId = r.id;
      }
      const phoneOtp = await sendOtp(ctx, q, 'sms', b.phone, 'signup_phone', userId);
      const emailOtp = await sendOtp(ctx, q, 'email', b.email, 'signup_email', userId);
      await audit(q, { type: 'public' }, 'signup.started', 'user', userId, { kind: b.kind });
      return { signupId: userId, phoneOtpId: phoneOtp, emailOtpId: emailOtp };
    });
  });

  // Step 2: both codes; consent recorded; returns passkey registration options + wallet link nonce.
  app.post('/auth/signup/verify', async (req) => {
    const b = parse(z.object({ signupId: z.string().uuid(), phoneOtpId: z.string().uuid(), phoneCode: z.string(), emailOtpId: z.string().uuid(), emailCode: z.string() }), req.body);
    return tx(ctx.db, async (q) => {
      const p = await checkOtp(ctx, q, b.phoneOtpId, b.phoneCode, 'signup_phone');
      const e = await checkOtp(ctx, q, b.emailOtpId, b.emailCode, 'signup_email');
      if (p.userId !== b.signupId || e.userId !== b.signupId) throw badRequest('otp_invalid', 'Those codes are for a different sign-up.');
      const u = await one<UserRow>(q, 'SELECT * FROM app.users WHERE id = $1', [b.signupId]);
      const phoneTaken = await maybe(q, 'SELECT 1 FROM app.users WHERE tenant_id = $1 AND phone_e164 = $2 AND phone_verified_at IS NOT NULL AND id <> $3', [u.tenant_id, u.phone_e164, u.id]);
      if (phoneTaken) throw conflict('phone_taken', 'This phone number is already used by another account.');
      await q.query('UPDATE app.users SET phone_verified_at = $2, email_verified_at = $2 WHERE id = $1', [u.id, ctx.now()]);
      await q.query('INSERT INTO app.consents (user_id, version, text_sha256, purposes, ip) VALUES ($1,$2,$3,$4,$5)', [
        u.id,
        CONSENT_VERSION,
        sha256Hex(CONSENT_TEXT),
        ['identity_verification', 'sanctions_screening', 'fraud_prevention', 'disputes'],
        clientIp(req),
      ]);
      const nonce = randomToken(12);
      const issuedAt = ctx.now();
      const reg = await registrationOptions(ctx, q, u, 'signup', { nonce, issuedAt: issuedAt.toISOString() });
      await audit(q, { type: 'user', id: u.id }, 'signup.contacts_verified', 'user', u.id, { consent: CONSENT_VERSION });
      return {
        ...reg,
        walletLink: {
          nonce,
          issuedAt: issuedAt.toISOString(),
          // The device signs one message per address with the embedded wallet.
          messageTemplate: walletLinkMessage(u.id, '{address}', nonce, issuedAt),
        },
      };
    });
  });

  // Step 3: passkey + wallet created together (C1-1, C2).
  app.post('/auth/signup/finish', async (req, reply) => {
    const b = parse(
      z.object({ challengeId: z.string().uuid(), credential: z.any(), deviceFingerprint: zDevice, deviceLabel: z.string().max(80).optional(), wallet: zWallet }),
      req.body,
    );
    const result = await tx(ctx.db, async (q) => {
      const ch = await takeChallenge(ctx, q, b.challengeId, 'signup');
      const userId = ch.user_id!;
      await verifyRegistration(ctx, q, userId, ch.challenge, b.credential as RegistrationResponseJSON, b.deviceLabel);
      await linkWallet(ctx, q, userId, String(ch.data.nonce), new Date(String(ch.data.issuedAt)), b.wallet);
      const device = await touchDevice(q, userId, b.deviceFingerprint, b.deviceLabel, true);
      const token = await createSession(ctx, q, userId, device.id, true);
      await audit(q, { type: 'user', id: userId }, 'signup.completed', 'user', userId, { device: device.id });
      return { token, userId };
    });
    await screenUser(ctx, result.userId).catch(() => undefined);
    setSessionCookie(ctx, reply, result.token);
    return { token: result.token, userId: result.userId };
  });

  // Sign-in with passkey.
  app.post('/auth/login/options', async (req) => {
    const b = parse(z.object({ identifier: z.string().min(3).max(200) }), req.body);
    if (!(await ctx.limiter.hit(`login:${clientIp(req)}`, 30, 600))) throw tooMany();
    const u = await maybe<{ id: string }>(
      ctx.db,
      `SELECT id FROM app.users WHERE tenant_id = $1 AND (lower(email) = lower($2) OR phone_e164 = $2 OR lower(handle) = lower(ltrim($2, '@'))) AND status <> 'closed'`,
      [ctx.cfg.tenantId, b.identifier],
    );
    return tx(ctx.db, (q) => authenticationOptions(ctx, q, u?.id ?? null, 'login'));
  });

  app.post('/auth/login/finish', async (req, reply) => {
    const b = parse(z.object({ challengeId: z.string().uuid(), credential: z.any(), deviceFingerprint: zDevice, deviceLabel: z.string().max(80).optional() }), req.body);
    const out = await tx(ctx.db, async (q) => {
      const ch = await takeChallenge(ctx, q, b.challengeId, 'login');
      const userId = await verifyAssertion(ctx, q, ch.user_id, ch.challenge, b.credential as AuthenticationResponseJSON);
      const device = await touchDevice(q, userId, b.deviceFingerprint, b.deviceLabel, false);
      if (device.isNew || !device.trusted) {
        // C1-8: new device -> re-verify before any send or release.
        await q.query("UPDATE app.users SET reverify_required = true, reverify_reason = 'new_device' WHERE id = $1", [userId]);
      }
      const token = await createSession(ctx, q, userId, device.id, true);
      await audit(q, { type: 'user', id: userId }, 'login', 'session', null, { device: device.id, newDevice: device.isNew });
      return { token, userId, newDevice: device.isNew || !device.trusted };
    });
    setSessionCookie(ctx, reply, out.token);
    return out;
  });

  app.post('/auth/logout', async (req, reply) => {
    const s = await requireUser(ctx, req);
    await ctx.db.query('UPDATE app.sessions SET revoked_at = $2 WHERE id = $1', [s.sessionId, ctx.now()]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // Passkey step-up before signing a payment or release.
  app.post('/auth/step-up/options', async (req) => {
    const s = await requireUser(ctx, req);
    return tx(ctx.db, (q) => authenticationOptions(ctx, q, s.user.id, 'step_up'));
  });

  app.post('/auth/step-up/finish', async (req) => {
    const s = await requireUser(ctx, req);
    const b = parse(z.object({ challengeId: z.string().uuid(), credential: z.any() }), req.body);
    return tx(ctx.db, async (q) => {
      const ch = await takeChallenge(ctx, q, b.challengeId, 'step_up');
      if (ch.user_id !== s.user.id) throw forbidden('challenge_user', 'This request belongs to another account.');
      await verifyAssertion(ctx, q, s.user.id, ch.challenge, b.credential as AuthenticationResponseJSON);
      await q.query('UPDATE app.sessions SET last_passkey_at = $2 WHERE id = $1', [s.sessionId, ctx.now()]);
      return { ok: true, validForSeconds: 300 };
    });
  });

  // C1-8 re-verification: SMS code to the (new) phone plus a fresh liveness check.
  app.post('/auth/reverify/start', async (req) => {
    const s = await requireUser(ctx, req);
    if (!s.user.phone_e164) throw badRequest('no_phone', 'Add a phone number first.');
    const otpId = await tx(ctx.db, (q) => sendOtp(ctx, q, 'sms', s.user.phone_e164!, 'reverify', s.user.id));
    return { otpId, livenessRequired: s.user.tier !== 'none' };
  });

  app.post('/auth/reverify/finish', async (req) => {
    const s = await requireUser(ctx, req);
    const b = parse(z.object({ otpId: z.string().uuid(), code: z.string(), livenessToken: z.string().optional() }), req.body);
    return tx(ctx.db, async (q) => {
      const o = await checkOtp(ctx, q, b.otpId, b.code, 'reverify');
      if (o.userId !== s.user.id) throw badRequest('otp_invalid', 'That code is for a different account.');
      if (s.user.tier !== 'none') {
        if (!b.livenessToken) throw badRequest('liveness_required', 'Complete the selfie check.');
        const l = await ctx.identity.verifyLiveness(b.livenessToken, s.user.verified_name ?? '');
        if (!l.passed) throw forbidden('liveness_failed', 'The selfie check did not pass. Try again in good light.');
      }
      await q.query('UPDATE app.users SET reverify_required = false, reverify_reason = NULL WHERE id = $1', [s.user.id]);
      if (s.deviceId) await q.query('UPDATE app.devices SET trusted_at = $2 WHERE id = $1', [s.deviceId, ctx.now()]);
      await audit(q, { type: 'user', id: s.user.id }, 'reverify.completed', 'user', s.user.id, { reason: s.user.reverify_reason });
      return { ok: true };
    });
  });

  // Phone change (C1-8): verify the new number, then sends and releases pause until re-verification.
  app.post('/me/phone/start', async (req) => {
    const s = await requireUser(ctx, req);
    const b = parse(z.object({ phone: zPhone }), req.body);
    const otpId = await tx(ctx.db, (q) => sendOtp(ctx, q, 'sms', b.phone, 'phone_change', s.user.id));
    return { otpId };
  });

  app.post('/me/phone/finish', async (req) => {
    const s = await requireUser(ctx, req);
    const b = parse(z.object({ otpId: z.string().uuid(), code: z.string() }), req.body);
    return tx(ctx.db, async (q) => {
      const o = await checkOtp(ctx, q, b.otpId, b.code, 'phone_change');
      if (o.userId !== s.user.id) throw badRequest('otp_invalid', 'That code is for a different account.');
      const dup = await maybe(q, 'SELECT 1 FROM app.users WHERE tenant_id = $1 AND phone_e164 = $2 AND phone_verified_at IS NOT NULL AND id <> $3', [s.user.tenant_id, o.destination, s.user.id]);
      if (dup) throw conflict('phone_taken', 'This phone number is already used by another account.');
      await q.query("UPDATE app.users SET phone_e164 = $2, phone_verified_at = $3, reverify_required = true, reverify_reason = 'phone_changed' WHERE id = $1", [s.user.id, o.destination, ctx.now()]);
      await audit(q, { type: 'user', id: s.user.id }, 'phone.changed', 'user', s.user.id, {});
      return { ok: true, reverifyRequired: true };
    });
  });

  // C2-2 recovery path 1: add a second passkey on another device while signed in.
  app.post('/auth/passkeys/options', async (req) => {
    const s = await requireUser(ctx, req);
    return tx(ctx.db, (q) => registrationOptions(ctx, q, s.user, 'add_passkey'));
  });

  app.post('/auth/passkeys', async (req) => {
    const s = await requireUser(ctx, req);
    if (!s.lastPasskeyAt || ctx.now().getTime() - s.lastPasskeyAt.getTime() > 300_000) throw forbidden('passkey_required', 'Confirm with your current passkey first.');
    const b = parse(z.object({ challengeId: z.string().uuid(), credential: z.any(), label: z.string().max(80).optional() }), req.body);
    return tx(ctx.db, async (q) => {
      const ch = await takeChallenge(ctx, q, b.challengeId, 'add_passkey');
      if (ch.user_id !== s.user.id) throw forbidden('challenge_user', 'This request belongs to another account.');
      const id = await verifyRegistration(ctx, q, s.user.id, ch.challenge, b.credential as RegistrationResponseJSON, b.label);
      await audit(q, { type: 'user', id: s.user.id }, 'passkey.added', 'passkey', id, {});
      return { ok: true };
    });
  });

  app.get('/auth/passkeys', async (req) => {
    const s = await requireUser(ctx, req);
    const r = await ctx.db.query('SELECT id, device_label, created_at, last_used_at FROM app.passkeys WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at', [s.user.id]);
    return j({ passkeys: r.rows });
  });

  // C2-2 recovery path 2: provider recovery + identity re-verification + 48-hour outgoing lock.
  app.post('/auth/recovery/start', async (req) => {
    const b = parse(z.object({ email: z.string().email(), phone: zPhone }), req.body);
    if (!(await ctx.limiter.hit(`recovery:${clientIp(req)}`, 5, 3600))) throw tooMany();
    return tx(ctx.db, async (q) => {
      const u = await maybe<UserRow>(q, 'SELECT * FROM app.users WHERE tenant_id = $1 AND lower(email) = lower($2) AND phone_e164 = $3 AND status <> $4', [ctx.cfg.tenantId, b.email, b.phone, 'closed']);
      if (!u) return { recoveryId: null, phoneOtpId: null, emailOtpId: null }; // no account enumeration
      const r = await one<{ id: string }>(q, "INSERT INTO app.recovery_requests (user_id, method, status) VALUES ($1, 'provider_recovery', 'started') RETURNING id", [u.id]);
      const phoneOtpId = await sendOtp(ctx, q, 'sms', b.phone, 'recovery_phone', u.id);
      const emailOtpId = await sendOtp(ctx, q, 'email', b.email, 'recovery_email', u.id);
      await audit(q, { type: 'public' }, 'recovery.started', 'user', u.id, {});
      return { recoveryId: r.id, phoneOtpId, emailOtpId };
    });
  });

  app.post('/auth/recovery/verify', async (req) => {
    const b = parse(
      z.object({
        recoveryId: z.string().uuid(),
        phoneOtpId: z.string().uuid(),
        phoneCode: z.string(),
        emailOtpId: z.string().uuid(),
        emailCode: z.string(),
        identity: z.object({ idType: z.enum(['bvn', 'nin']), idNumber: z.string(), livenessToken: z.string() }).optional(),
      }),
      req.body,
    );
    return tx(ctx.db, async (q) => {
      const rec = await maybe<{ id: string; user_id: string; status: string }>(q, 'SELECT * FROM app.recovery_requests WHERE id = $1 FOR UPDATE', [b.recoveryId]);
      if (!rec || rec.status !== 'started') throw notFound('Recovery request not found.');
      const p = await checkOtp(ctx, q, b.phoneOtpId, b.phoneCode, 'recovery_phone');
      const e = await checkOtp(ctx, q, b.emailOtpId, b.emailCode, 'recovery_email');
      if (p.userId !== rec.user_id || e.userId !== rec.user_id) throw badRequest('otp_invalid', 'Those codes are for a different request.');
      const u = await one<UserRow>(q, 'SELECT * FROM app.users WHERE id = $1', [rec.user_id]);
      if (u.tier === 'tier1' || u.tier === 'tier2') {
        if (!b.identity) throw badRequest('identity_required', 'Verify your identity with your BVN or NIN and a selfie.');
        const hmac = ctx.crypto.lookupHmac(b.identity.idType, b.identity.idNumber);
        const rec2 = await maybe(q, "SELECT 1 FROM app.identity_records WHERE user_id = $1 AND kind = $2 AND lookup_hmac = $3 AND status = 'verified'", [u.id, b.identity.idType, hmac]);
        if (!rec2) throw forbidden('identity_mismatch', 'Those identity details do not match this account.');
        const l = await ctx.identity.verifyLiveness(b.identity.livenessToken, u.verified_name ?? '');
        if (!l.passed) throw forbidden('liveness_failed', 'The selfie check did not pass.');
      }
      const until = new Date(ctx.now().getTime() + 48 * 3600_000);
      await q.query("UPDATE app.recovery_requests SET status = 'identity_verified', identity_reverified_at = $2, outgoing_locked_until = $3 WHERE id = $1", [rec.id, ctx.now(), until]);
      await q.query('UPDATE app.users SET outgoing_locked_until = $2 WHERE id = $1', [u.id, until]);
      await notify(q, { userId: u.id, kind: 'recovery_started', vars: { until: until.toUTCString() }, dedupeKey: `recovery:${rec.id}` });
      const reg = await registrationOptions(ctx, q, u, 'recovery', { recoveryId: rec.id });
      await audit(q, { type: 'user', id: u.id }, 'recovery.identity_verified', 'user', u.id, { lockedUntil: until.toISOString() });
      return { ...reg, outgoingLockedUntil: until.toISOString() };
    });
  });

  app.post('/auth/recovery/finish', async (req, reply) => {
    const b = parse(z.object({ challengeId: z.string().uuid(), credential: z.any(), deviceFingerprint: zDevice, deviceLabel: z.string().max(80).optional() }), req.body);
    const out = await tx(ctx.db, async (q) => {
      const ch = await takeChallenge(ctx, q, b.challengeId, 'recovery');
      const userId = ch.user_id!;
      await verifyRegistration(ctx, q, userId, ch.challenge, b.credential as RegistrationResponseJSON, b.deviceLabel);
      await q.query("UPDATE app.recovery_requests SET status = 'completed', completed_at = $2 WHERE id = $1", [ch.data.recoveryId, ctx.now()]);
      // The lost device's sessions end; the recovered device is trusted (identity was re-checked).
      await q.query('UPDATE app.sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [userId, ctx.now()]);
      const device = await touchDevice(q, userId, b.deviceFingerprint, b.deviceLabel, true);
      const token = await createSession(ctx, q, userId, device.id, true);
      await audit(q, { type: 'user', id: userId }, 'recovery.completed', 'user', userId, {});
      return { token, userId };
    });
    setSessionCookie(ctx, reply, out.token);
    return out;
  });
}
