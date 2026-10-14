// Request helpers shared by route modules: validation, sessions, guards.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import type { Ctx } from './ctx.ts';
import { maybe } from './db/pool.ts';
import { sha256Hex } from './lib/crypto.ts';
import { ApiError, badRequest, forbidden, unauthorized } from './lib/errors.ts';

export const SESSION_COOKIE = 'bs_session';
export const STAFF_COOKIE = 'bs_staff';
/** A passkey confirmation is valid for sensitive actions for this long (C3 send flow step 5). */
export const STEP_UP_SECONDS = 5 * 60;

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    throw badRequest('invalid_request', first ? `${first.path.join('.') || 'request'}: ${first.message}` : 'Invalid request.', { issues: r.error.issues });
  }
  return r.data;
}

export function clientIp(req: FastifyRequest): string {
  return req.ip;
}

export interface UserRow {
  id: string;
  tenant_id: number;
  kind: 'individual' | 'business' | 'counterparty';
  handle: string | null;
  email: string;
  phone_e164: string | null;
  display_name: string | null;
  verified_name: string | null;
  tier: 'none' | 'tier1' | 'tier2' | 'counterparty';
  status: 'active' | 'suspended' | 'closed';
  suspended_reason: string | null;
  country: string;
  locale: string;
  reverify_required: boolean;
  reverify_reason: string | null;
  outgoing_locked_until: Date | null;
  sanctions_status: string;
  counterparty_verified_at: Date | null;
  new_payee_threshold_units: string | null;
  phone_verified_at: Date | null;
  email_verified_at: Date | null;
}

export interface SessionInfo {
  user: UserRow;
  sessionId: string;
  deviceId: string | null;
  lastPasskeyAt: Date | null;
}

function tokenFrom(req: FastifyRequest, cookie: string): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  const c = (req.cookies as Record<string, string | undefined> | undefined)?.[cookie];
  if (c) {
    // Cookie-authenticated mutations must carry the custom header (blocks cross-site form posts).
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-backstop-csrf'] !== '1') throw forbidden('csrf', 'Missing CSRF header.');
    return c;
  }
  return null;
}

export async function optionalUser(ctx: Ctx, req: FastifyRequest): Promise<SessionInfo | null> {
  const token = tokenFrom(req, SESSION_COOKIE);
  if (!token) return null;
  const row = await maybe<{ session_id: string; device_id: string | null; last_passkey_at: Date | null } & UserRow>(
    ctx.db,
    `SELECT s.id AS session_id, s.device_id, s.last_passkey_at, u.*
     FROM app.sessions s JOIN app.users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
    [sha256Hex(token), ctx.now()],
  );
  if (!row) return null;
  return { user: row, sessionId: row.session_id, deviceId: row.device_id, lastPasskeyAt: row.last_passkey_at };
}

export async function requireUser(ctx: Ctx, req: FastifyRequest): Promise<SessionInfo> {
  const s = await optionalUser(ctx, req);
  if (!s) throw unauthorized();
  if (s.user.status === 'closed') throw unauthorized('This account is closed.');
  return s;
}

/**
 * Guards for any action that moves money (send, fund escrow, release, P2P). Enforces suspension,
 * C1-8 re-verification, the C2-2 48-hour recovery lock, sanctions results and a fresh passkey
 * confirmation.
 */
export function assertCanMoveMoney(ctx: Ctx, s: SessionInfo, opts: { stepUp?: boolean } = { stepUp: true }): void {
  const u = s.user;
  if (u.status === 'suspended') throw forbidden('account_suspended', `Your account is suspended: ${u.suspended_reason ?? 'under review'}. Contact support.`);
  if (u.sanctions_status === 'confirmed_match') throw forbidden('sanctions', 'This account cannot move money. Contact support.');
  if (u.reverify_required)
    throw forbidden('reverify_required', u.reverify_reason === 'phone_changed' ? 'Your phone number changed. Verify it again before sending or releasing money.' : 'You signed in on a new device. Verify it is you before sending or releasing money.');
  if (u.outgoing_locked_until && u.outgoing_locked_until > ctx.now())
    throw forbidden('recovery_lock', `After wallet recovery, outgoing transfers are locked until ${u.outgoing_locked_until.toISOString()}.`, { until: u.outgoing_locked_until.toISOString() });
  if (opts.stepUp !== false) {
    if (!s.lastPasskeyAt || ctx.now().getTime() - s.lastPasskeyAt.getTime() > STEP_UP_SECONDS * 1000)
      throw forbidden('passkey_required', 'Confirm with your passkey to continue.');
  }
}

export function assertTier(s: SessionInfo, allowed: Array<UserRow['tier']>, what: string): void {
  if (!allowed.includes(s.user.tier)) throw forbidden('tier_required', `${what} needs identity verification (${allowed.join(' or ')}). Complete verification in Settings.`, { required: allowed, current: s.user.tier });
}

export interface StaffInfo {
  id: string;
  email: string;
  name: string;
  roles: string[];
  sessionId: string;
}

export async function requireStaff(ctx: Ctx, req: FastifyRequest, roles: string[] = []): Promise<StaffInfo> {
  const token = tokenFrom(req, STAFF_COOKIE);
  if (!token) throw unauthorized('Staff sign-in required.');
  const row = await maybe<{ id: string; email: string; name: string; roles: string[]; session_id: string; mfa_verified_at: Date | null }>(
    ctx.db,
    `SELECT st.id, st.email, st.name, st.roles, ss.id AS session_id, ss.mfa_verified_at
     FROM app.staff_sessions ss JOIN app.staff st ON st.id = ss.staff_id
     WHERE ss.token_hash = $1 AND ss.revoked_at IS NULL AND ss.expires_at > $2 AND st.active`,
    [sha256Hex(token), ctx.now()],
  );
  if (!row) throw unauthorized('Staff sign-in required.');
  if (!row.mfa_verified_at) throw forbidden('mfa_required', 'Complete multi-factor authentication.');
  if (roles.length && !roles.some((r) => row.roles.includes(r) || row.roles.includes('admin')))
    throw forbidden('role_required', `This needs one of: ${roles.join(', ')}.`);
  return { id: row.id, email: row.email, name: row.name, roles: row.roles, sessionId: row.session_id };
}

export function sendError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof ApiError) return reply.status(e.status).send({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } });
  throw e;
}

/** JSON-safe conversion: bigint -> string, Date -> ISO. */
export function j<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}

export const zAmount = z.string().regex(/^\d{1,15}(\.\d{1,6})?$/, 'amount must be a dollar value with at most 6 decimals');
export const zUuid = z.string().uuid();
export const zToken = z.enum(['USDT', 'USDC']);
export const zNetwork = z.enum(['tron', 'base', 'arc', 'ethereum']);
