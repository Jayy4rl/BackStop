// C1 account and identity: Tier 1 (BVN or NIN + liveness, one account per ID), Tier 2 (CAC company
// register + at least one Tier 1 director + business address), counterparty document checks above a
// threshold, sanctions and PEP screening at onboarding and daily, identity data encrypted at rest.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatUnits, namesAgree, parseUnits, type Tier } from '@backstop/shared';
import type { Ctx } from '../ctx.ts';
import { maybe, many, one, tx, type Queryable } from '../db/pool.ts';
import { audit, SYSTEM } from '../lib/audit.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { j, parse, requireUser, type UserRow } from '../http.ts';
import { limitsView } from '../services/limits.ts';
import { notifyStaff } from '../services/notify.ts';

/** Retention under the NDPA 2023 and AML record-keeping: identity records kept 5 years after verification. */
function retainUntil(now: Date): string {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() + 5);
  return d.toISOString().slice(0, 10);
}

/** C1-6: sanctions and PEP screening. Confirmed matches suspend money movement; potential matches go to an analyst. */
export async function screenUser(ctx: Ctx, userId: string): Promise<string> {
  const u = await one<UserRow>(ctx.db, 'SELECT * FROM app.users WHERE id = $1', [userId]);
  const name = u.verified_name ?? u.display_name ?? '';
  if (!name) return u.sanctions_status;
  const r = await ctx.sanctions.screenPerson({ fullName: name, country: u.country });
  await tx(ctx.db, async (q) => {
    await q.query('UPDATE app.users SET sanctions_status = $2, sanctions_screened_at = $3 WHERE id = $1', [userId, r.status, ctx.now()]);
    if (r.status !== 'clear' && r.status !== u.sanctions_status) {
      await audit(q, SYSTEM, 'sanctions.match', 'user', userId, { status: r.status, pep: r.pep, matches: r.matches });
      await notifyStaff(q, 'risk_analyst', 'Sanctions/PEP screening match', `User ${userId} screened as ${r.status}${r.pep ? ' (PEP)' : ''}.`, { userId }, `sanctions:${userId}:${r.status}`);
    } else {
      await audit(q, SYSTEM, 'sanctions.screened', 'user', userId, { status: r.status });
    }
  });
  return r.status;
}

export async function profile(ctx: Ctx, q: Queryable, userId: string) {
  const u = await one<UserRow & { phone_discoverable: boolean }>(q, 'SELECT * FROM app.users WHERE id = $1', [userId]);
  const w = await maybe<{ evm_address: string; tron_address: string; provider: string }>(q, 'SELECT evm_address, tron_address, provider FROM app.wallets WHERE user_id = $1', [userId]);
  const biz = u.kind === 'business' ? await maybe(q, 'SELECT company_name, cac_number, address, verified_at, second_approver_above_units FROM app.businesses WHERE user_id = $1', [userId]) : null;
  const memberships = await many(q, `SELECT m.business_id, m.role, b.company_name FROM app.business_members m JOIN app.businesses b ON b.user_id = m.business_id WHERE m.member_id = $1`, [userId]);
  return {
    id: u.id,
    kind: u.kind,
    handle: u.handle,
    email: u.email,
    phone: u.phone_e164,
    phoneDiscoverable: u.phone_discoverable,
    displayName: u.display_name,
    verifiedName: u.verified_name,
    country: u.country,
    tier: u.tier,
    status: u.status,
    suspendedReason: u.suspended_reason,
    locale: u.locale,
    reverifyRequired: u.reverify_required,
    reverifyReason: u.reverify_reason,
    outgoingLockedUntil: u.outgoing_locked_until,
    newPayeeThreshold: u.new_payee_threshold_units ? formatUnits(BigInt(u.new_payee_threshold_units)) : null,
    wallet: w ? { evmAddress: w.evm_address, tronAddress: w.tron_address, provider: w.provider } : null,
    business: biz,
    businessMemberships: memberships,
    limits: await limitsView(ctx, q, userId, u.tier as Tier),
  };
}

export function registerIdentity(app: FastifyInstance, ctx: Ctx): void {
  app.get('/me', async (req) => {
    const s = await requireUser(ctx, req);
    return j(await profile(ctx, ctx.db, s.user.id));
  });

  app.patch('/me', async (req) => {
    const s = await requireUser(ctx, req);
    const b = parse(
      z.object({
        displayName: z.string().min(1).max(100).optional(),
        phoneDiscoverable: z.boolean().optional(),
        locale: z.enum(['en', 'pcm', 'yo', 'ha', 'ig']).optional(),
        newPayeeThreshold: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/).optional(),
      }),
      req.body,
    );
    await ctx.db.query(
      `UPDATE app.users SET display_name = coalesce($2, display_name), phone_discoverable = coalesce($3, phone_discoverable), locale = coalesce($4, locale),
         new_payee_threshold_units = coalesce($5, new_payee_threshold_units) WHERE id = $1`,
      [s.user.id, b.displayName ?? null, b.phoneDiscoverable ?? null, b.locale ?? null, b.newPayeeThreshold ? parseUnits(b.newPayeeThreshold).toString() : null],
    );
    return j(await profile(ctx, ctx.db, s.user.id));
  });

  app.get('/me/limits', async (req) => {
    const s = await requireUser(ctx, req);
    return j(await limitsView(ctx, ctx.db, s.user.id, s.user.tier));
  });

  app.post('/me/push-tokens', async (req) => {
    const s = await requireUser(ctx, req);
    const b = parse(z.object({ token: z.string().min(10).max(300), platform: z.enum(['ios', 'android', 'web']) }), req.body);
    await ctx.db.query('INSERT INTO app.push_tokens (user_id, token, platform) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [s.user.id, b.token, b.platform]);
    return { ok: true };
  });

  // C1-2 Tier 1: BVN or NIN match + liveness through the identity vendor. C1-5: one Tier 1 account per BVN/NIN.
  app.post('/identity/tier1', async (req) => {
    const s = await requireUser(ctx, req);
    if (s.user.kind !== 'individual') throw badRequest('wrong_kind', 'Tier 1 is for individual accounts.');
    if (s.user.tier === 'tier1') throw conflict('already_verified', 'You are already verified.');
    const b = parse(
      z.object({
        idType: z.enum(['bvn', 'nin']),
        idNumber: z.string().regex(/^\d{11}$/, 'BVN and NIN are 11 digits'),
        firstName: z.string().min(1).max(60),
        lastName: z.string().min(1).max(60),
        dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        livenessToken: z.string().min(1),
      }),
      req.body,
    );
    const hmac = ctx.crypto.lookupHmac(b.idType, b.idNumber);
    const other = await maybe(ctx.db, "SELECT user_id FROM app.identity_records WHERE tenant_id = $1 AND kind = $2 AND lookup_hmac = $3 AND status = 'verified' AND user_id <> $4", [
      ctx.cfg.tenantId,
      b.idType,
      hmac,
      s.user.id,
    ]);
    if (other) throw conflict('id_in_use', `This ${b.idType.toUpperCase()} is already linked to another Backstop account. Each person can have one account.`);
    const res = await ctx.identity.verifyIndividual({ ...b, phone: s.user.phone_e164 ?? '' });
    const ok = res.match && res.livenessPassed && !!res.verifiedName;
    await tx(ctx.db, async (q) => {
      await q.query(
        `INSERT INTO app.identity_records (tenant_id, user_id, kind, lookup_hmac, payload_enc, vendor, vendor_ref, status, failure_reason, verified_at, retain_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          ctx.cfg.tenantId,
          s.user.id,
          b.idType,
          ok ? hmac : null,
          ctx.crypto.encryptJson({ idNumber: b.idNumber, firstName: b.firstName, lastName: b.lastName, dateOfBirth: b.dateOfBirth, verifiedName: res.verifiedName }, `identity:${s.user.id}`),
          ctx.identity.name,
          res.vendorRef,
          ok ? 'verified' : 'failed',
          res.failureReason ?? null,
          ok ? ctx.now() : null,
          retainUntil(ctx.now()),
        ],
      );
      if (ok) await q.query("UPDATE app.users SET tier = 'tier1', verified_name = $2 WHERE id = $1", [s.user.id, res.verifiedName]);
      await audit(q, { type: 'user', id: s.user.id }, ok ? 'identity.tier1.verified' : 'identity.tier1.failed', 'user', s.user.id, { idType: b.idType, vendorRef: res.vendorRef, reason: res.failureReason });
    }).catch((e: Error & { code?: string }) => {
      if (e.code === '23505') throw conflict('id_in_use', 'This ID is already linked to another Backstop account.');
      throw e;
    });
    if (!ok) {
      const msg = {
        id_not_found: 'We could not find that ID. Check the number.',
        details_mismatch: 'Your name or date of birth does not match the ID record.',
        liveness_failed: 'The selfie check did not pass. Try again in good light.',
        phone_mismatch: 'Your phone number does not match the ID record.',
      }[res.failureReason ?? 'id_not_found'];
      throw forbidden(res.failureReason ?? 'verification_failed', msg);
    }
    await screenUser(ctx, s.user.id);
    return j(await profile(ctx, ctx.db, s.user.id));
  });

  // C1-3 Tier 2: CAC registration, at least one Tier 1 director, business address.
  app.post('/identity/business', async (req) => {
    const s = await requireUser(ctx, req);
    if (s.user.kind !== 'business') throw badRequest('wrong_kind', 'Tier 2 is for business accounts. Sign up a business account for your company.');
    const b = parse(
      z.object({
        rcNumber: z.string().min(3).max(20),
        address: z.string().min(10).max(300),
        directorHandles: z.array(z.string().min(3)).min(1).max(10),
        approverHandles: z.array(z.string().min(3)).max(10).default([]),
        secondApproverAbove: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/).optional(),
      }),
      req.body,
    );
    const rec = await ctx.companies.lookup(b.rcNumber);
    if (!rec.found || rec.status !== 'active') throw forbidden('cac_not_found', 'That RC number is not an active company on the CAC register.');
    const handles = [...b.directorHandles, ...b.approverHandles].map((h) => h.replace(/^@/, '').toLowerCase());
    const people = await many<{ id: string; handle: string; tier: string; verified_name: string | null }>(
      ctx.db,
      'SELECT id, handle, tier, verified_name FROM app.users WHERE tenant_id = $1 AND lower(handle) = ANY($2)',
      [ctx.cfg.tenantId, handles],
    );
    const byHandle = new Map(people.map((p) => [p.handle.toLowerCase(), p]));
    const directors = b.directorHandles.map((h) => byHandle.get(h.replace(/^@/, '').toLowerCase()));
    if (directors.some((d) => !d)) throw badRequest('unknown_handle', 'Every director must have a Backstop account.');
    const verifiedDirectors = directors.filter((d) => d!.tier === 'tier1' && d!.verified_name && (rec.directors ?? []).some((n) => namesAgree(n, d!.verified_name!)));
    if (!verifiedDirectors.length) throw forbidden('director_required', 'At least one director on the CAC record must be a Tier 1 verified Backstop user.');
    const approvers = b.approverHandles.map((h) => byHandle.get(h.replace(/^@/, '').toLowerCase()));
    if (approvers.some((a) => !a || a.tier !== 'tier1')) throw badRequest('approver_tier', 'Approvers must be Tier 1 verified users.');
    await tx(ctx.db, async (q) => {
      await q.query(
        `INSERT INTO app.businesses (user_id, tenant_id, company_name, cac_number, address, verified_at, second_approver_above_units) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (user_id) DO UPDATE SET company_name = EXCLUDED.company_name, cac_number = EXCLUDED.cac_number, address = EXCLUDED.address, verified_at = EXCLUDED.verified_at,
           second_approver_above_units = EXCLUDED.second_approver_above_units`,
        [s.user.id, ctx.cfg.tenantId, rec.companyName, b.rcNumber.toUpperCase(), b.address, ctx.now(), b.secondApproverAbove ? parseUnits(b.secondApproverAbove).toString() : null],
      );
      for (const d of verifiedDirectors) await q.query("INSERT INTO app.business_members (business_id, member_id, role) VALUES ($1,$2,'director') ON CONFLICT DO NOTHING", [s.user.id, d!.id]);
      for (const a of approvers) await q.query("INSERT INTO app.business_members (business_id, member_id, role) VALUES ($1,$2,'approver') ON CONFLICT DO NOTHING", [s.user.id, a!.id]);
      await q.query(
        `INSERT INTO app.identity_records (tenant_id, user_id, kind, payload_enc, vendor, status, verified_at, retain_until) VALUES ($1,$2,'cac',$3,$4,'verified',$5,$6)`,
        [ctx.cfg.tenantId, s.user.id, ctx.crypto.encryptJson({ rec, address: b.address }, `identity:${s.user.id}`), ctx.companies.name, ctx.now(), retainUntil(ctx.now())],
      );
      await q.query("UPDATE app.users SET tier = 'tier2', verified_name = $2 WHERE id = $1", [s.user.id, rec.companyName]);
      await audit(q, { type: 'user', id: s.user.id }, 'identity.tier2.verified', 'user', s.user.id, { rc: b.rcNumber, directors: verifiedDirectors.map((d) => d!.id) });
    }).catch((e: Error & { code?: string }) => {
      if (e.code === '23505') throw conflict('cac_in_use', 'This company is already registered on Backstop.');
      throw e;
    });
    await screenUser(ctx, s.user.id);
    return j(await profile(ctx, ctx.db, s.user.id));
  });

  // C1-4 counterparty verification by document and liveness, required above a threshold.
  app.post('/identity/counterparty', async (req) => {
    const s = await requireUser(ctx, req);
    if (s.user.kind !== 'counterparty') throw badRequest('wrong_kind', 'Document verification is for client and supplier accounts.');
    const b = parse(
      z.object({ docType: z.enum(['passport', 'national_id', 'drivers_licence']), docNumber: z.string().min(5).max(40), fullName: z.string().min(2).max(120), livenessToken: z.string().min(1) }),
      req.body,
    );
    const res = await ctx.identity.verifyDocument({ country: s.user.country, ...b });
    const ok = res.match && res.livenessPassed;
    await tx(ctx.db, async (q) => {
      await q.query(
        `INSERT INTO app.identity_records (tenant_id, user_id, kind, payload_enc, vendor, vendor_ref, status, failure_reason, verified_at, retain_until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [ctx.cfg.tenantId, s.user.id, b.docType, ctx.crypto.encryptJson(b, `identity:${s.user.id}`), ctx.identity.name, res.vendorRef, ok ? 'verified' : 'failed', res.failureReason ?? null, ok ? ctx.now() : null, retainUntil(ctx.now())],
      );
      if (ok) await q.query('UPDATE app.users SET counterparty_verified_at = $2, verified_name = $3 WHERE id = $1', [s.user.id, ctx.now(), res.verifiedName]);
      await audit(q, { type: 'user', id: s.user.id }, ok ? 'identity.counterparty.verified' : 'identity.counterparty.failed', 'user', s.user.id, { docType: b.docType });
    });
    if (!ok) throw forbidden(res.failureReason ?? 'verification_failed', 'We could not verify that document. Check the details and try again.');
    await screenUser(ctx, s.user.id);
    return j(await profile(ctx, ctx.db, s.user.id));
  });

  // Public lookups used by send flow and checkout: verified name by handle; phone only if opted in (L1-1).
  app.get('/users/lookup', async (req) => {
    await requireUser(ctx, req);
    const qy = parse(z.object({ handle: z.string().optional(), phone: z.string().optional() }), req.query);
    if (!qy.handle && !qy.phone) throw badRequest('lookup', 'Give a handle or phone number.');
    const u = qy.handle
      ? await maybe<UserRow>(ctx.db, "SELECT * FROM app.users WHERE tenant_id = $1 AND lower(handle) = lower($2) AND status = 'active'", [ctx.cfg.tenantId, qy.handle.replace(/^@/, '')])
      : await maybe<UserRow>(ctx.db, "SELECT * FROM app.users WHERE tenant_id = $1 AND phone_e164 = $2 AND phone_discoverable AND phone_verified_at IS NOT NULL AND status = 'active'", [ctx.cfg.tenantId, qy.phone]);
    if (!u) throw notFound('No Backstop user found.');
    return { id: u.id, handle: u.handle, displayName: u.display_name, verifiedName: u.verified_name, tier: u.tier, kind: u.kind };
  });
}

export async function counterpartyNeedsVerification(ctx: Ctx, user: UserRow, amount: bigint): Promise<boolean> {
  if (user.kind !== 'counterparty' || user.counterparty_verified_at) return false;
  const limits = await ctx.versioned.limits();
  const t = limits.tiers.counterparty.verificationThresholdUnits ?? 0n;
  return amount > t;
}

export function counterpartyThresholdMessage(t: bigint): string {
  return `Payments above $${formatUnits(t)} need a quick ID document and selfie check.`;
}
