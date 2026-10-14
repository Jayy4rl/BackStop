// Staff console API: dispute reviewers and risk analysts (behind SSO and MFA). Every staff action
// is written to the append-only audit log.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as OTPAuth from 'otpauth';
import { addressKey, checkAddress, formatUnits, deserializeRules, type RuleSet } from '@backstop/shared';
import type { Ctx } from '../ctx.ts';
import { maybe, many, one, tx } from '../db/pool.ts';
import { audit } from '../lib/audit.ts';
import { randomToken, sha256Hex } from '../lib/crypto.ts';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.ts';
import { j, parse, requireStaff, STAFF_COOKIE, zUuid } from '../http.ts';
import { notify, notifyStaff } from '../services/notify.ts';
import { replayDecision, traceExposure, canonicalTokenFor } from '../services/checks.ts';
import { setListingStatus, upsertListing, bumpVersion, addMonths } from '../services/fraudlist.ts';
import { recheckHoldsForAddress, setTransferAvailability } from '../services/holds.ts';
import { approveRuling, getDispute, ruleDispute } from '../services/disputes.ts';
import { getPayment, paymentView } from '../services/payments.ts';
import { metrics } from '../services/metrics.ts';

const STAFF_SESSION_HOURS = 10;

function totpFor(secretB32: string, email: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({ issuer: 'Backstop Staff', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secretB32) });
}

export function registerStaff(app: FastifyInstance, ctx: Ctx): void {
  // ---------------------------------------------------------------- SSO + MFA
  app.get('/staff/sso/start', async () => {
    const b = await ctx.sso.begin();
    await ctx.db.query('INSERT INTO app.sso_states (state, nonce, code_verifier, expires_at) VALUES ($1,$2,$3,$4)', [b.state, b.nonce, b.codeVerifier, new Date(ctx.now().getTime() + 10 * 60_000)]);
    return { url: b.url, state: b.state };
  });

  app.post('/staff/sso/callback', async (req, reply) => {
    const b = parse(z.object({ state: z.string(), code: z.string() }), req.body);
    const st = await maybe<{ nonce: string; code_verifier: string; expires_at: Date }>(ctx.db, 'DELETE FROM app.sso_states WHERE state = $1 RETURNING *', [b.state]);
    if (!st || st.expires_at < ctx.now()) throw unauthorized('Sign-in expired. Start again.');
    const id = await ctx.sso.complete(b.code, { nonce: st.nonce, codeVerifier: st.code_verifier });
    const staff = await maybe<{ id: string; active: boolean; sso_subject: string | null; mfa_enrolled_at: Date | null }>(ctx.db, 'SELECT * FROM app.staff WHERE lower(email) = lower($1)', [id.email]);
    if (!staff || !staff.active) throw forbidden('not_staff', 'This account is not on the Backstop staff list.');
    if (staff.sso_subject && staff.sso_subject !== id.subject) throw forbidden('sso_mismatch', 'Identity provider subject does not match.');
    if (!staff.sso_subject) await ctx.db.query('UPDATE app.staff SET sso_subject = $2 WHERE id = $1', [staff.id, id.subject]);
    const token = randomToken();
    await ctx.db.query('INSERT INTO app.staff_sessions (staff_id, token_hash, expires_at) VALUES ($1,$2,$3)', [staff.id, sha256Hex(token), new Date(ctx.now().getTime() + STAFF_SESSION_HOURS * 3600_000)]);
    await audit(ctx.db, { type: 'staff', id: staff.id }, 'staff.sso_login', 'staff', staff.id, {});
    reply.setCookie(STAFF_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: ctx.cfg.env === 'production', path: '/', maxAge: STAFF_SESSION_HOURS * 3600 });
    return { token, mfaEnrolled: !!staff.mfa_enrolled_at };
  });

  async function preMfa(req: Parameters<typeof requireStaff>[1]) {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : (req.cookies as Record<string, string | undefined>)?.[STAFF_COOKIE];
    if (!token) throw unauthorized('Staff sign-in required.');
    const row = await maybe<{ session_id: string; id: string; email: string; totp_secret_enc: Buffer | null; mfa_enrolled_at: Date | null }>(
      ctx.db,
      'SELECT ss.id AS session_id, st.id, st.email, st.totp_secret_enc, st.mfa_enrolled_at FROM app.staff_sessions ss JOIN app.staff st ON st.id = ss.staff_id WHERE ss.token_hash = $1 AND ss.revoked_at IS NULL AND ss.expires_at > $2 AND st.active',
      [sha256Hex(token), ctx.now()],
    );
    if (!row) throw unauthorized('Staff sign-in required.');
    return row;
  }

  app.post('/staff/mfa/enroll', async (req) => {
    const s = await preMfa(req);
    if (s.mfa_enrolled_at) throw conflict('enrolled', 'MFA is already set up. Ask an admin to reset it.');
    const secret = new OTPAuth.Secret({ size: 20 });
    await ctx.db.query('UPDATE app.staff SET totp_secret_enc = $2 WHERE id = $1', [s.id, ctx.crypto.encrypt(secret.base32, `totp:${s.id}`)]);
    return { otpauthUri: totpFor(secret.base32, s.email).toString(), secret: secret.base32 };
  });

  app.post('/staff/mfa/verify', async (req) => {
    const s = await preMfa(req);
    const b = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
    if (!s.totp_secret_enc) throw badRequest('mfa_not_enrolled', 'Set up MFA first.');
    if (!(await ctx.limiter.hit(`staffmfa:${s.id}`, 10, 900))) throw forbidden('mfa_locked', 'Too many attempts. Wait 15 minutes.');
    const secret = ctx.crypto.decrypt(s.totp_secret_enc, `totp:${s.id}`).toString();
    const delta = totpFor(secret, s.email).validate({ token: b.code, window: 1, timestamp: ctx.now().getTime() });
    if (delta === null) {
      await audit(ctx.db, { type: 'staff', id: s.id }, 'staff.mfa_failed', 'staff', s.id, {});
      throw unauthorized('That code is not right.');
    }
    await ctx.db.query('UPDATE app.staff_sessions SET mfa_verified_at = $2 WHERE id = $1', [s.session_id, ctx.now()]);
    await ctx.db.query('UPDATE app.staff SET mfa_enrolled_at = coalesce(mfa_enrolled_at, $2) WHERE id = $1', [s.id, ctx.now()]);
    await audit(ctx.db, { type: 'staff', id: s.id }, 'staff.mfa_verified', 'staff', s.id, {});
    return { ok: true };
  });

  app.get('/staff/me', async (req) => j(await requireStaff(ctx, req)));

  app.post('/staff/logout', async (req, reply) => {
    const s = await requireStaff(ctx, req);
    await ctx.db.query('UPDATE app.staff_sessions SET revoked_at = $2 WHERE id = $1', [s.sessionId, ctx.now()]);
    reply.clearCookie(STAFF_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---------------------------------------------------------------- queues overview
  app.get('/staff/queues', async (req) => {
    await requireStaff(ctx, req);
    const now = ctx.now();
    const q = async (sql: string) => one<{ open: string; overdue: string }>(ctx.db, sql, [now]);
    return j({
      reviews: await q("SELECT count(*) AS open, count(*) FILTER (WHERE due_at < $1) AS overdue FROM network.review_cases WHERE status = 'open'"),
      fraudCases: await q("SELECT count(*) AS open, count(*) FILTER (WHERE due_at < $1) AS overdue FROM network.fraud_cases WHERE status IN ('open','awaiting_second')"),
      appeals: await q("SELECT count(*) AS open, count(*) FILTER (WHERE due_at < $1) AS overdue FROM network.appeals WHERE status = 'open'"),
      disputes: await q("SELECT count(*) AS open, count(*) FILTER (WHERE ruling_due_at < $1) AS overdue FROM network.disputes WHERE status IN ('evidence','in_review') AND opened_onchain_at IS NOT NULL"),
      signatures: await q("SELECT count(*) AS open, 0 AS overdue FROM network.disputes WHERE status IN ('ruled','awaiting_signatures') AND ($1::timestamptz IS NOT NULL)"),
      support: await q("SELECT count(*) AS open, count(*) FILTER (WHERE first_response_due < $1 AND first_response_at IS NULL) AS overdue FROM app.support_threads WHERE status = 'open'"),
    });
  });

  // ---------------------------------------------------------------- C3-5 inbound reviews
  app.get('/staff/reviews', async (req) => {
    await requireStaff(ctx, req, ['risk_analyst']);
    return j({
      reviews: await many(
        ctx.db,
        `SELECT r.*, t.amount_units, t.network, t.token, t.from_address, t.availability, d.reasons, u.handle
         FROM network.review_cases r LEFT JOIN app.transfers t ON t.id = r.transfer_id LEFT JOIN network.check_decisions d ON d.id = r.decision_id LEFT JOIN app.users u ON u.id = r.user_id
         WHERE r.status = 'open' ORDER BY r.due_at`,
      ),
    });
  });

  app.post('/staff/reviews/:id/decide', async (req) => {
    const st = await requireStaff(ctx, req, ['risk_analyst']);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ action: z.enum(['clear', 'hold', 'resolve']), reason: z.string().min(10).max(2_000) }), req.body);
    return tx(ctx.db, async (q) => {
      const r = await maybe<{ id: string; status: string; transfer_id: string | null; kind: string; payment_id: string | null }>(q, 'SELECT * FROM network.review_cases WHERE id = $1 FOR UPDATE', [id]);
      if (!r) throw notFound();
      if (r.status !== 'open') throw conflict('decided', 'Already decided.');
      if (r.transfer_id && b.action !== 'resolve') await setTransferAvailability(ctx, q, r.transfer_id, b.action === 'clear' ? 'available' : 'on_hold', b.reason, st.id);
      if (r.kind === 'payee_listed_during_hold' && r.payment_id && b.action === 'clear') await q.query('UPDATE app.payments SET release_paused_reason = NULL WHERE id = $1', [r.payment_id]);
      await q.query('UPDATE network.review_cases SET status = $2, analyst_id = $3, resolution_reason = $4, resolved_at = $5 WHERE id = $1', [id, b.action === 'clear' ? 'cleared' : b.action === 'hold' ? 'held' : 'resolved', st.id, b.reason, ctx.now()]);
      await audit(q, { type: 'staff', id: st.id }, `review.${b.action}`, 'review_case', id, { reason: b.reason });
      return { ok: true };
    });
  });

  // ---------------------------------------------------------------- C5-2 analyst console: fraud cases
  app.get('/staff/cases', async (req) => {
    await requireStaff(ctx, req, ['risk_analyst']);
    const qy = parse(z.object({ status: z.enum(['open', 'awaiting_second', 'confirmed', 'rejected']).default('open') }), req.query);
    return j({ cases: await many(ctx.db, `SELECT c.*, (SELECT count(*) FROM network.fraud_reports r WHERE r.case_id = c.id) AS reports FROM network.fraud_cases c WHERE status = $1 ORDER BY due_at`, [qy.status]) });
  });

  app.get('/staff/cases/:id', async (req) => {
    const st = await requireStaff(ctx, req, ['risk_analyst']);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const c = await maybe<{ id: string; address: string; address_key: string; traced_path: unknown }>(ctx.db, 'SELECT * FROM network.fraud_cases WHERE id = $1', [id]);
    if (!c) throw notFound();
    const reports = await many<{ reporter_user_id: string | null } & Record<string, unknown>>(ctx.db, 'SELECT * FROM network.fraud_reports WHERE case_id = $1 ORDER BY created_at', [id]);
    // Reporter history: how many reports each reporter filed and how they were decided.
    const history = await many(
      ctx.db,
      `SELECT r.reporter_user_id, u.handle, u.tier, count(*) AS reports, count(*) FILTER (WHERE c.status = 'confirmed') AS confirmed, count(*) FILTER (WHERE c.status = 'rejected') AS rejected
       FROM network.fraud_reports r JOIN network.fraud_cases c ON c.id = r.case_id LEFT JOIN app.users u ON u.id = r.reporter_user_id
       WHERE r.reporter_user_id = ANY($1) GROUP BY r.reporter_user_id, u.handle, u.tier`,
      [reports.map((r) => r.reporter_user_id).filter(Boolean)],
    );
    const listings = await many(ctx.db, 'SELECT * FROM network.listings WHERE address_key = $1 ORDER BY created_at DESC', [c.address_key]);
    await audit(ctx.db, { type: 'staff', id: st.id }, 'case.viewed', 'fraud_case', id, {});
    return j({ case: c, reports, reporterHistory: history, listings });
  });

  // Traced fund path into the suspect address (for the console's path view).
  app.post('/staff/cases/:id/trace', async (req) => {
    const st = await requireStaff(ctx, req, ['risk_analyst']);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ network: z.enum(['tron', 'base', 'arc', 'ethereum']), token: z.enum(['USDT', 'USDC']) }), req.body);
    const c = await one<{ address: string }>(ctx.db, 'SELECT address FROM network.fraud_cases WHERE id = $1', [id]);
    const token = canonicalTokenFor(ctx, b.network, b.token);
    if (!token) throw badRequest('token', 'Token not available on that network.');
    const t = await traceExposure(ctx, ctx.db, b.network, token, c.address, await ctx.versioned.rules());
    await ctx.db.query('UPDATE network.fraud_cases SET traced_path = $2 WHERE id = $1', [id, JSON.stringify(t)]);
    await audit(ctx.db, { type: 'staff', id: st.id }, 'case.traced', 'fraud_case', id, { share: t.share });
    return j(t);
  });

  // Confirmation standard: on-chain trail + (identity-checked reporter | law-enforcement ref | two independent reports).
  // C5-3: above a set amount, a second analyst must confirm. C5-5: a specific deposit address, never a labelled exchange.
  app.post('/staff/cases/:id/decide', async (req) => {
    const st = await requireStaff(ctx, req, ['risk_analyst']);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(
      z.object({
        decision: z.enum(['confirm', 'reject', 'mark_reported']),
        reasonCode: z.enum(['onchain_trail_confirmed', 'insufficient_evidence', 'mistaken_report', 'labelled_service', 'duplicate', 'law_enforcement', 'other']),
        reason: z.string().min(10).max(2_000),
        onchainTrailConfirmed: z.boolean().default(false),
        lawEnforcementRef: z.string().max(100).optional(),
      }),
      req.body,
    );
    const rules = await ctx.versioned.rules();
    return tx(ctx.db, async (q) => {
      const c = await maybe<{ id: string; status: string; address: string; address_key: string; amount_units: string | null; analyst_id: string | null }>(q, 'SELECT * FROM network.fraud_cases WHERE id = $1 FOR UPDATE', [id]);
      if (!c) throw notFound();
      if (!['open', 'awaiting_second'].includes(c.status)) throw conflict('decided', 'This case is already decided.');
      const reports = await many<{ reporter_user_id: string | null; reporter_identity_checked: boolean; law_enforcement_ref: string | null }>(q, 'SELECT reporter_user_id, reporter_identity_checked, law_enforcement_ref FROM network.fraud_reports WHERE case_id = $1', [id]);
      if (b.decision === 'confirm') {
        if (!b.onchainTrailConfirmed) throw badRequest('standard', 'Confirm only when the on-chain trail links the funds to this address.');
        const idChecked = reports.some((r) => r.reporter_identity_checked);
        const independent = new Set(reports.map((r) => r.reporter_user_id).filter(Boolean)).size >= 2;
        const le = !!b.lawEnforcementRef || reports.some((r) => r.law_enforcement_ref);
        if (!idChecked && !independent && !le) throw badRequest('standard', 'Confirmation needs a report from an identity-checked user, a law-enforcement reference, or two independent reports.');
        const big = c.amount_units !== null && BigInt(c.amount_units) > rules.fraudList.secondAnalystAboveUnits;
        if (big && c.status === 'open') {
          await q.query("UPDATE network.fraud_cases SET status = 'awaiting_second', analyst_id = $2, decision_code = $3, decision_reason = $4 WHERE id = $1", [id, st.id, b.reasonCode, b.reason]);
          await audit(q, { type: 'staff', id: st.id }, 'case.first_confirmation', 'fraud_case', id, { reasonCode: b.reasonCode });
          await notifyStaff(q, 'risk_analyst', 'Second analyst needed', `Case ${id} for ${c.address} needs a second confirmation (above $${formatUnits(rules.fraudList.secondAnalystAboveUnits)}).`, { caseId: id }, `second:${id}`);
          return { status: 'awaiting_second' };
        }
        if (c.status === 'awaiting_second' && c.analyst_id === st.id) throw forbidden('second_analyst', 'A different analyst must give the second confirmation.');
        await upsertListing(q, {
          address: c.address,
          label: 'fraud',
          source: 'user_report',
          status: 'confirmed',
          caseId: id,
          confirmedBy: c.status === 'awaiting_second' ? c.analyst_id : st.id,
          secondConfirmedBy: c.status === 'awaiting_second' ? st.id : null,
          sourceRef: b.lawEnforcementRef ?? null,
          now: ctx.now(),
          expiryMonths: rules.fraudList.listingExpiryMonths,
        });
        await q.query("UPDATE network.fraud_cases SET status = 'confirmed', analyst_id = coalesce(analyst_id, $2), second_analyst_id = CASE WHEN status = 'awaiting_second' THEN $2 END, decision_code = $3, decision_reason = $4, decided_at = $5 WHERE id = $1", [
          id,
          st.id,
          b.reasonCode,
          b.reason,
          ctx.now(),
        ]);
      } else if (b.decision === 'mark_reported') {
        await upsertListing(q, { address: c.address, label: 'fraud', source: 'user_report', status: 'reported', caseId: id, now: ctx.now(), expiryMonths: rules.fraudList.listingExpiryMonths });
        await audit(q, { type: 'staff', id: st.id }, 'case.marked_reported', 'fraud_case', id, { reason: b.reason });
        return { status: 'open' };
      } else {
        await q.query("UPDATE network.fraud_cases SET status = 'rejected', analyst_id = $2, decision_code = $3, decision_reason = $4, decided_at = $5 WHERE id = $1", [id, st.id, b.reasonCode, b.reason, ctx.now()]);
        // A rejected case removes any interim 'reported' listing it created.
        const rep = await many<{ id: string }>(q, "SELECT id FROM network.listings WHERE case_id = $1 AND status = 'reported'", [id]);
        for (const l of rep) await setListingStatus(q, l.id, 'rejected', ctx.now(), `case rejected ${c.address_key}`);
      }
      await audit(q, { type: 'staff', id: st.id }, `case.${b.decision}`, 'fraud_case', id, { reasonCode: b.reasonCode });
      for (const r of reports.filter((x) => x.reporter_user_id))
        await notify(q, { userId: r.reporter_user_id, kind: 'report_decided', vars: { outcome: b.decision === 'confirm' ? 'confirmed and listed' : 'not confirmed', reason: b.reason }, dedupeKey: `report-decided:${id}:${r.reporter_user_id}` });
      return { status: b.decision === 'confirm' ? 'confirmed' : 'rejected' };
    });
  });

  // ---------------------------------------------------------------- listings
  app.get('/staff/listings', async (req) => {
    await requireStaff(ctx, req, ['risk_analyst']);
    const qy = parse(z.object({ status: z.string().optional(), address: z.string().optional() }), req.query);
    const rows = await many(
      ctx.db,
      `SELECT * FROM network.listings WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR address_key = $2) ORDER BY updated_at DESC LIMIT 500`,
      [qy.status ?? null, qy.address ? addressKey(qy.address) : null],
    );
    return j({ listings: rows });
  });

  app.post('/staff/listings', async (req) => {
    const st = await requireStaff(ctx, req, ['risk_analyst']);
    const b = parse(
      z.object({
        address: z.string(),
        label: z.enum(['fraud', 'sanctions', 'issuer_frozen', 'scam_report']),
        source: z.enum(['user_report', 'sanctions', 'issuer_freeze', 'public_scam_site']),
        status: z.enum(['reported', 'confirmed']),
        sourceRef: z.string().max(200).optional(),
        reason: z.string().min(10),
      }),
      req.body,
    );
    const rules = await ctx.versioned.rules();
    return tx(ctx.db, async (q) => {
      const r = await upsertListing(q, { address: b.address, label: b.label, source: b.source, status: b.status, sourceRef: b.sourceRef, confirmedBy: b.status === 'confirmed' ? st.id : null, now: ctx.now(), expiryMonths: rules.fraudList.listingExpiryMonths });
      await audit(q, { type: 'staff', id: st.id }, 'listing.added', 'listing', r.id, { ...b });
      return r;
    });
  });

  // C5-9: renew a confirmed listing with new evidence (re-review), or delist.
  app.post('/staff/listings/:id/renew', async (req) => {
    const st = await requireStaff(ctx, req, ['risk_analyst']);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ reason: z.string().min(10) }), req.body);
    const rules = await ctx.versioned.rules();
    return tx(ctx.db, async (q) => {
      const l = await maybe<{ status: string; address_key: string }>(q, 'SELECT * FROM network.listings WHERE id = $1 FOR UPDATE', [id]);
      if (!l || !['confirmed', 'expired'].includes(l.status)) throw conflict('state', 'Only confirmed or expired listings can be renewed.');
      await q.query("UPDATE network.listings SET status = 'confirmed', expires_at = $2, renewed_at = $3, updated_at = $3 WHERE id = $1", [id, addMonths(ctx.now(), rules.fraudList.listingExpiryMonths), ctx.now()]);
      await bumpVersion(q, `renew ${l.address_key}`, id);
      await audit(q, { type: 'staff', id: st.id }, 'listing.renewed', 'listing', id, { reason: b.reason });
      return { ok: true };
    });
  });

  app.post('/staff/listings/:id/delist', async (req) => {
    const st = await requireStaff(ctx, req, ['risk_analyst']);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ reason: z.string().min(10) }), req.body);
    const l = await tx(ctx.db, async (q) => {
      const row = await maybe<{ address: string; address_key: string }>(q, 'SELECT * FROM network.listings WHERE id = $1 FOR UPDATE', [id]);
      if (!row) throw notFound();
      await setListingStatus(q, id, 'delisted', ctx.now(), `delist ${row.address_key}`);
      await audit(q, { type: 'staff', id: st.id }, 'listing.delisted', 'listing', id, { reason: b.reason });
      return row;
    });
    await tx(ctx.db, (q) => recheckHoldsForAddress(ctx, q, l.address));
    return { ok: true };
  });

  // Labelled exchanges, bridges, token contracts and known services (tracing stops; can't be listed).
  app.get('/staff/labels', async (req) => {
    await requireStaff(ctx, req, ['risk_analyst']);
    return j({ labels: await many(ctx.db, 'SELECT * FROM network.labelled_addresses ORDER BY name') });
  });

  app.post('/staff/labels', async (req) => {
    const st = await requireStaff(ctx, req, ['risk_analyst', 'admin']);
    const b = parse(z.object({ address: z.string(), kind: z.enum(['exchange', 'bridge', 'token_contract', 'service']), name: z.string().min(2).max(100), accepts: z.array(z.string().regex(/^(tron|base|arc|ethereum):(USDT|USDC)$/)).default([]) }), req.body);
    const c = checkAddress(b.address);
    if (!c.valid) throw badRequest('invalid_address', 'Invalid address.');
    await ctx.db.query(
      `INSERT INTO network.labelled_addresses (address_key, address, family, kind, name, accepts) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (address_key) DO UPDATE SET kind = EXCLUDED.kind, name = EXCLUDED.name, accepts = EXCLUDED.accepts`,
      [addressKey(c.normalized), c.normalized, c.family, b.kind, b.name, b.accepts],
    );
    await audit(ctx.db, { type: 'staff', id: st.id }, 'label.set', 'address', addressKey(c.normalized), { ...b });
    return { ok: true };
  });

  // ---------------------------------------------------------------- appeals (step 4 and 5)
  app.get('/staff/appeals', async (req) => {
    await requireStaff(ctx, req, ['risk_analyst']);
    return j({
      appeals: await many(
        ctx.db,
        `SELECT a.*, l.label, l.status AS listing_status, l.confirmed_by, l.second_confirmed_by FROM network.appeals a LEFT JOIN network.listings l ON l.id = a.listing_id WHERE a.status = 'open' ORDER BY a.due_at`,
      ),
    });
  });

  app.post('/staff/appeals/:id/decide', async (req) => {
    const st = await requireStaff(ctx, req, ['risk_analyst']);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ outcome: z.enum(['granted', 'upheld']), reason: z.string().min(10).max(2_000) }), req.body);
    const out = await tx(ctx.db, async (q) => {
      const a = await maybe<{ id: string; status: string; kind: string; listing_id: string | null; transfer_id: string | null; appellant_user_id: string | null; appellant_email: string | null; public_ref: string; address: string | null }>(
        q,
        'SELECT * FROM network.appeals WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!a) throw notFound();
      if (a.status !== 'open') throw conflict('decided', 'Already decided.');
      if (a.listing_id) {
        const l = await one<{ confirmed_by: string | null; second_confirmed_by: string | null; status_before_appeal: string | null; address: string }>(q, 'SELECT * FROM network.listings WHERE id = $1', [a.listing_id]);
        // Step 4: an analyst who did not confirm the listing decides.
        if (l.confirmed_by === st.id || l.second_confirmed_by === st.id) throw forbidden('conflict_of_interest', 'An analyst who confirmed the listing cannot decide its appeal.');
        if (b.outcome === 'granted') await setListingStatus(q, a.listing_id, 'delisted', ctx.now(), `appeal granted ${a.public_ref}`);
        else await setListingStatus(q, a.listing_id, (l.status_before_appeal as 'confirmed' | 'reported') ?? 'confirmed', ctx.now(), `appeal upheld ${a.public_ref}`);
      }
      if (a.transfer_id) {
        const caseAnalyst = await maybe(q, "SELECT 1 FROM network.review_cases WHERE transfer_id = $1 AND analyst_id = $2 AND status = 'held'", [a.transfer_id, st.id]);
        if (caseAnalyst) throw forbidden('conflict_of_interest', 'A different analyst must decide an appeal of your own hold.');
        if (b.outcome === 'granted') await setTransferAvailability(ctx, q, a.transfer_id, 'available', b.reason, st.id);
      }
      await q.query('UPDATE network.appeals SET status = $2, analyst_id = $3, decision_reason = $4, decided_at = $5 WHERE id = $1', [id, b.outcome, st.id, b.reason, ctx.now()]);
      await audit(q, { type: 'staff', id: st.id }, `appeal.${b.outcome}`, 'appeal', id, { reason: b.reason });
      const vars = { ref: a.public_ref, outcome: b.outcome === 'granted' ? 'granted' : 'upheld', reason: b.outcome === 'granted' ? `${b.reason} The listing has been removed.` : `${b.reason} You can appeal again after 90 days or with new evidence.` };
      if (a.appellant_user_id) await notify(q, { userId: a.appellant_user_id, kind: 'appeal_decided', vars, dedupeKey: `appeal-decided:${id}` });
      else if (a.appellant_email) await notify(q, { email: a.appellant_email, kind: 'appeal_decided', vars, dedupeKey: `appeal-decided:${id}` });
      return a;
    });
    // Step 5: granted -> delisted and affected users' holds re-checked.
    if (b.outcome === 'granted' && out.listing_id && out.address) await tx(ctx.db, (q) => recheckHoldsForAddress(ctx, q, out.address!));
    return { ok: true };
  });

  // ---------------------------------------------------------------- disputes (C4)
  app.get('/staff/disputes', async (req) => {
    await requireStaff(ctx, req, ['dispute_reviewer', 'arbiter_signer']);
    return j({
      disputes: await many(
        ctx.db,
        `SELECT d.*, p.title, p.amount_units, p.token, p.network, p.escrow_address, p.disputed_at, p.arbiter_timeout_seconds,
                (SELECT count(*) FROM network.arbiter_approvals a WHERE a.dispute_id = d.id AND a.ruling_hash = d.ruling_hash) AS approvals
         FROM network.disputes d JOIN app.payments p ON p.id = d.payment_id
         WHERE d.status NOT IN ('executed','closed') AND d.opened_onchain_at IS NOT NULL ORDER BY d.ruling_due_at`,
      ),
    });
  });

  app.get('/staff/disputes/:id', async (req) => {
    const st = await requireStaff(ctx, req, ['dispute_reviewer', 'arbiter_signer']);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const d = await getDispute(ctx.db, id);
    const p = await getPayment(ctx.db, d.payment_id);
    const evidence = await many(ctx.db, 'SELECT * FROM network.dispute_evidence WHERE dispute_id = $1 ORDER BY created_at', [id]);
    const approvals = await many(ctx.db, 'SELECT staff_id, approved_at, ruling FROM network.arbiter_approvals WHERE dispute_id = $1 AND ruling_hash = $2', [id, d.ruling_hash]);
    const partyHistory = async (userId: string | null) =>
      userId
        ? one(ctx.db, `SELECT count(*) AS payments, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM network.disputes x WHERE x.payment_id = p.id AND x.opened_onchain_at IS NOT NULL)) AS disputed FROM app.payments p WHERE payer_user_id = $1 OR payee_user_id = $1`, [userId])
        : null;
    await audit(ctx.db, { type: 'staff', id: st.id }, 'dispute.viewed', 'dispute', id, {});
    return j({ dispute: d, payment: await paymentView(ctx, ctx.db, p, null), evidence, approvals, payerHistory: await partyHistory(p.payer_user_id), payeeHistory: await partyHistory(p.payee_user_id) });
  });

  app.post('/staff/disputes/:id/claim', async (req) => {
    const st = await requireStaff(ctx, req, ['dispute_reviewer']);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await ctx.db.query("UPDATE network.disputes SET status = CASE WHEN status = 'evidence' THEN 'in_review' ELSE status END, reviewer_id = coalesce(reviewer_id, $2) WHERE id = $1", [id, st.id]);
    await audit(ctx.db, { type: 'staff', id: st.id }, 'dispute.claimed', 'dispute', id, {});
    return { ok: true };
  });

  app.post('/staff/disputes/:id/rule', async (req) => {
    const st = await requireStaff(ctx, req, ['dispute_reviewer']);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ ruling: z.enum(['release', 'refund']), reason: z.string().min(20).max(4_000), fraudFound: z.boolean().default(false), fraudParty: z.enum(['payer', 'payee']).optional() }), req.body);
    return j(await tx(ctx.db, (q) => ruleDispute(ctx, q, id, st.id, b)));
  });

  app.post('/staff/disputes/:id/approve', async (req) => {
    const st = await requireStaff(ctx, req, ['arbiter_signer']);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return j(await tx(ctx.db, (q) => approveRuling(ctx, q, id, st.id)));
  });

  // ---------------------------------------------------------------- users (suspension, L4-8)
  app.get('/staff/users/:id', async (req) => {
    const st = await requireStaff(ctx, req, ['risk_analyst', 'dispute_reviewer', 'support']);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const u = await maybe(ctx.db, 'SELECT id, kind, handle, email, phone_e164, verified_name, tier, status, suspended_reason, sanctions_status, created_at FROM app.users WHERE id = $1', [id]);
    if (!u) throw notFound();
    const wallet = await maybe(ctx.db, 'SELECT evm_address, tron_address FROM app.wallets WHERE user_id = $1', [id]);
    await audit(ctx.db, { type: 'staff', id: st.id }, 'user.viewed', 'user', id, {});
    return j({ user: u, wallet });
  });

  app.post('/staff/users/:id/suspend', async (req) => {
    const st = await requireStaff(ctx, req, ['risk_analyst']);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ reason: z.string().min(10), nairaFraud: z.boolean().default(false) }), req.body);
    const rules = await ctx.versioned.rules();
    return tx(ctx.db, async (q) => {
      await q.query("UPDATE app.users SET status = 'suspended', suspended_reason = $2 WHERE id = $1", [id, b.reason]);
      if (b.nairaFraud) {
        // L4-8: naira later reported as fraudulent -> suspended, addresses enter C5 review.
        const w = await maybe<{ evm_address: string; tron_address: string }>(q, 'SELECT evm_address, tron_address FROM app.wallets WHERE user_id = $1', [id]);
        for (const a of [w?.tron_address, w?.evm_address].filter((x): x is string => !!x)) {
          await upsertListing(q, { address: a, label: 'fraud', source: 'p2p_naira_fraud', status: 'reported', now: ctx.now(), expiryMonths: rules.fraudList.listingExpiryMonths }).catch(() => undefined);
          await q.query("INSERT INTO network.fraud_cases (address_key, address, due_at) VALUES ($1,$2,$3)", [addressKey(a), a, new Date(ctx.now().getTime() + 2 * 86_400_000)]);
        }
      }
      await notify(q, { userId: id, kind: 'account_suspended', vars: { reason: b.reason }, dedupeKey: `suspend:${id}:${ctx.now().getTime()}` });
      await audit(q, { type: 'staff', id: st.id }, 'user.suspended', 'user', id, { reason: b.reason, nairaFraud: b.nairaFraud });
      return { ok: true };
    });
  });

  app.post('/staff/users/:id/reinstate', async (req) => {
    const st = await requireStaff(ctx, req, ['risk_analyst']);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ reason: z.string().min(10) }), req.body);
    await ctx.db.query("UPDATE app.users SET status = 'active', suspended_reason = NULL WHERE id = $1", [id]);
    await audit(ctx.db, { type: 'staff', id: st.id }, 'user.reinstated', 'user', id, { reason: b.reason });
    return { ok: true };
  });

  // ---------------------------------------------------------------- versioned config (rules, fees, limits)
  app.get('/staff/config', async (req) => {
    await requireStaff(ctx, req);
    return j({ versions: await many(ctx.db, 'SELECT kind, version, active, created_by, created_at, body FROM config.versions ORDER BY kind, created_at DESC') });
  });

  app.post('/staff/config/:kind', async (req) => {
    const st = await requireStaff(ctx, req, ['admin']);
    const { kind } = parse(z.object({ kind: z.enum(['rules', 'fees', 'limits']) }), req.params);
    const b = parse(z.object({ version: z.string().min(3).max(60), body: z.record(z.any()) }), req.body);
    const body = deserializeRules(JSON.stringify({ ...b.body, version: b.version })) as unknown as RuleSet;
    await tx(ctx.db, async (q) => {
      await ctx.versioned.publish(q, kind, b.version, body, st.email);
      await audit(q, { type: 'staff', id: st.id }, 'config.published', 'config', `${kind}:${b.version}`, {});
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- audit and replay
  app.get('/staff/audit', async (req) => {
    await requireStaff(ctx, req, ['risk_analyst', 'dispute_reviewer', 'admin']);
    const qy = parse(z.object({ subjectType: z.string().optional(), subjectId: z.string().optional(), limit: z.coerce.number().int().max(500).default(100) }), req.query);
    return j({
      events: await many(ctx.db, 'SELECT * FROM audit.events WHERE ($1::text IS NULL OR subject_type = $1) AND ($2::text IS NULL OR subject_id = $2) ORDER BY id DESC LIMIT $3', [qy.subjectType ?? null, qy.subjectId ?? null, qy.limit]),
    });
  });

  app.get('/staff/audit/verify', async (req) => {
    await requireStaff(ctx, req, ['admin']);
    const r = await one<{ broken: string; total: string }>(
      ctx.db,
      `SELECT count(*) FILTER (WHERE e.prev_hash IS DISTINCT FROM p.hash) AS broken, count(*) AS total
       FROM audit.events e LEFT JOIN LATERAL (SELECT hash FROM audit.events x WHERE x.id < e.id ORDER BY x.id DESC LIMIT 1) p ON true`,
    );
    return { total: Number(r.total), brokenLinks: Number(r.broken), intact: Number(r.broken) === 0 };
  });

  app.get('/staff/decisions/:id/replay', async (req) => {
    const st = await requireStaff(ctx, req, ['risk_analyst', 'dispute_reviewer']);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const r = await replayDecision(ctx, ctx.db, id);
    await audit(ctx.db, { type: 'staff', id: st.id }, 'decision.replayed', 'check_decision', id, { matches: r.matches });
    return j(r);
  });

  // ---------------------------------------------------------------- success metrics
  app.get('/staff/metrics', async (req) => {
    await requireStaff(ctx, req);
    return j(await metrics(ctx));
  });

  // ---------------------------------------------------------------- support (NFR: human response within 4 business hours)
  app.get('/staff/support', async (req) => {
    await requireStaff(ctx, req, ['support']);
    return j({ threads: await many(ctx.db, "SELECT t.*, u.handle FROM app.support_threads t JOIN app.users u ON u.id = t.user_id WHERE t.status <> 'closed' ORDER BY t.funds_involved DESC, t.first_response_due NULLS LAST") });
  });

  app.get('/staff/support/:id', async (req) => {
    await requireStaff(ctx, req, ['support']);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return j({ thread: await one(ctx.db, 'SELECT * FROM app.support_threads WHERE id = $1', [id]), messages: await many(ctx.db, 'SELECT * FROM app.support_messages WHERE thread_id = $1 ORDER BY created_at', [id]) });
  });

  app.post('/staff/support/:id/reply', async (req) => {
    const st = await requireStaff(ctx, req, ['support']);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ body: z.string().min(1).max(5_000), close: z.boolean().default(false) }), req.body);
    return tx(ctx.db, async (q) => {
      const t = await one<{ user_id: string }>(q, 'SELECT user_id FROM app.support_threads WHERE id = $1', [id]);
      await q.query('INSERT INTO app.support_messages (thread_id, author_staff_id, body) VALUES ($1,$2,$3)', [id, st.id, b.body]);
      await q.query("UPDATE app.support_threads SET status = $2, first_response_at = coalesce(first_response_at, $3) WHERE id = $1", [id, b.close ? 'closed' : 'answered', ctx.now()]);
      await notify(q, { userId: t.user_id, kind: 'support_reply', vars: { body: b.body.slice(0, 300) }, dedupeKey: `support:${id}:${ctx.now().getTime()}` });
      await audit(q, { type: 'staff', id: st.id }, 'support.replied', 'support_thread', id, {});
      return { ok: true };
    });
  });
}
