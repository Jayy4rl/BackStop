// C5 fraud reports and appeals (user and public side). Staff decisions live in modules/staff.ts.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addressKey, challengeMessage, checkAddress, deadlineFor, parseUnits, verifyOwnership } from '@backstop/shared';
import type { Ctx } from '../ctx.ts';
import { maybe, many, one, tx } from '../db/pool.ts';
import { audit } from '../lib/audit.ts';
import { randomToken } from '../lib/crypto.ts';
import { badRequest, conflict, forbidden, notFound, tooMany } from '../lib/errors.ts';
import { clientIp, j, parse, requireUser, zUuid } from '../http.ts';
import { notify } from '../services/notify.ts';
import { activeListings, setListingStatus, type Listing } from '../services/fraudlist.ts';

const CASE_TYPES = ['scam', 'impersonation', 'non_delivery', 'stolen_funds', 'third_party_naira', 'phishing', 'other'] as const;
const CHALLENGE_TTL_MS = 15 * 60_000;

function publicRef(): string {
  return `AP-${randomToken(6).replace(/[^A-Za-z0-9]/g, 'X').toUpperCase()}`;
}

export function registerFraud(app: FastifyInstance, ctx: Ctx): void {
  // C5-1: "Report fraud" on every payment and P2P trade.
  app.post('/fraud-reports', async (req) => {
    const s = await requireUser(ctx, req);
    const b = parse(
      z.object({
        caseType: z.enum(CASE_TYPES),
        txHashes: z.array(z.string().min(10).max(100)).max(20).default([]),
        suspectAddresses: z.array(z.string()).min(1).max(10),
        network: z.enum(['tron', 'base', 'arc', 'ethereum']).optional(),
        amount: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/).optional(),
        statement: z.string().min(20).max(5_000),
        fileIds: z.array(zUuid).max(20).default([]),
        transferId: zUuid.optional(),
        paymentId: zUuid.optional(),
        tradeId: zUuid.optional(),
      }),
      req.body,
    );
    const addrs = b.suspectAddresses.map((a) => {
      const c = checkAddress(a);
      if (!c.valid) throw badRequest('invalid_address', `${a} is not a valid address.`);
      return c.normalized;
    });
    if (!(await ctx.limiter.hit(`report:${s.user.id}`, 10, 86_400))) throw tooMany('You have sent many reports today. Contact support if this is urgent.');
    const holidays = await ctx.versioned.holidays();
    const rules = await ctx.versioned.rules();
    const id = await tx(ctx.db, async (q) => {
      const r = await one<{ id: string }>(
        q,
        `INSERT INTO network.fraud_reports (reporter_user_id, reporter_identity_checked, source, case_type, tx_hashes, suspect_addresses, network, amount_units, statement, file_ids,
           related_transfer_id, related_payment_id, related_trade_id, complete_at)
         VALUES ($1,$2,'user',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          s.user.id,
          s.user.tier === 'tier1' || s.user.tier === 'tier2',
          b.caseType,
          b.txHashes,
          addrs,
          b.network ?? null,
          b.amount ? parseUnits(b.amount).toString() : null,
          b.statement,
          b.fileIds,
          b.transferId ?? null,
          b.paymentId ?? null,
          b.tradeId ?? null,
          b.txHashes.length ? ctx.now() : null,
        ],
      );
      // One case per suspect address; reports about the same address join the open case.
      for (const a of addrs) {
        const key = addressKey(a);
        const open = await maybe<{ id: string }>(q, "SELECT id FROM network.fraud_cases WHERE address_key = $1 AND status IN ('open','awaiting_second')", [key]);
        const caseId =
          open?.id ??
          (
            await one<{ id: string }>(q, 'INSERT INTO network.fraud_cases (address_key, address, amount_units, due_at) VALUES ($1,$2,$3,$4) RETURNING id', [
              key,
              a,
              b.amount ? parseUnits(b.amount).toString() : null,
              deadlineFor(ctx.now(), { businessDays: rules.fraudList.caseDecisionBusinessDays }, holidays),
            ])
          ).id;
        await q.query('UPDATE network.fraud_reports SET case_id = $2 WHERE id = $1', [r.id, caseId]);
      }
      await audit(q, { type: 'user', id: s.user.id }, 'fraud.reported', 'fraud_report', r.id, { caseType: b.caseType, addresses: addrs.length });
      return r.id;
    });
    return { id, status: 'received', message: 'Thank you. A risk analyst reviews complete reports within 2 business days. We will tell you the outcome.' };
  });

  app.get('/fraud-reports', async (req) => {
    const s = await requireUser(ctx, req);
    return j({
      reports: await many(
        ctx.db,
        `SELECT r.id, r.case_type, r.suspect_addresses, r.created_at, c.status AS case_status, c.decided_at FROM network.fraud_reports r LEFT JOIN network.fraud_cases c ON c.id = r.case_id
         WHERE r.reporter_user_id = $1 ORDER BY r.created_at DESC`,
        [s.user.id],
      ),
    });
  });

  // Public listing status (no account; rate limited). Addresses only; never people or evidence.
  app.get('/public/listings/:address', async (req) => {
    if (!(await ctx.limiter.hit(`publist:${clientIp(req)}`, 60, 3600))) throw tooMany();
    const { address } = parse(z.object({ address: z.string().min(20).max(80) }), req.params);
    const c = checkAddress(address);
    if (!c.valid) throw badRequest('invalid_address', 'That is not a valid address.');
    const all = await activeListings(ctx.db, addressKey(c.normalized));
    return j({
      address: c.normalized,
      listed: all.length > 0,
      listings: all.map((l) => ({ status: l.status, caseType: l.label, listedAt: l.created_at, confirmedAt: l.confirmed_at, expiresAt: l.expires_at })),
    });
  });

  // Appeal step 2: one-time message to sign (EIP-191 on EVM, signMessageV2 on TRON).
  app.post('/public/appeals/challenge', async (req) => {
    const ip = clientIp(req);
    if (!(await ctx.limiter.hit(`appealch:${ip}`, 20, 3600))) throw tooMany();
    const b = parse(z.object({ address: z.string().min(20).max(80), captchaToken: z.string().optional() }), req.body);
    if (!(await ctx.captcha.verify(b.captchaToken, ip))) throw forbidden('captcha', 'Complete the bot check.');
    const c = checkAddress(b.address);
    if (!c.valid) throw badRequest('invalid_address', 'That is not a valid address.');
    const now = ctx.now();
    const nonce = randomToken(16);
    const message = challengeMessage({ address: c.normalized, nonce, purpose: 'appeal', issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString() });
    const r = await one<{ id: string }>(ctx.db, 'INSERT INTO network.ownership_challenges (address, nonce, message, expires_at) VALUES ($1,$2,$3,$4) RETURNING id', [c.normalized, nonce, message, new Date(now.getTime() + CHALLENGE_TTL_MS)]);
    return {
      challengeId: r.id,
      message,
      family: c.family,
      howToSign: c.family === 'evm' ? 'Sign this message in your wallet (personal_sign / EIP-191).' : 'Sign this message with TronLink (signMessageV2).',
    };
  });

  // Appeal steps 2-3: prove control, explain, upload evidence. Listing shows under_appeal (C5-7).
  app.post('/public/appeals', async (req) => {
    const ip = clientIp(req);
    if (!(await ctx.limiter.hit(`appeal:${ip}`, 5, 3600))) throw tooMany();
    const b = parse(
      z.object({
        challengeId: zUuid,
        signature: z.string().min(130).max(140),
        email: z.string().email(),
        statement: z.string().min(20).max(5_000),
        fileIds: z.array(zUuid).max(20).default([]),
        newEvidence: z.boolean().default(false),
        captchaToken: z.string().optional(),
      }),
      req.body,
    );
    if (!(await ctx.captcha.verify(b.captchaToken, ip))) throw forbidden('captcha', 'Complete the bot check.');
    const rules = await ctx.versioned.rules();
    const holidays = await ctx.versioned.holidays();
    const out = await tx(ctx.db, async (q) => {
      const ch = await maybe<{ id: string; address: string; message: string; expires_at: Date; used_at: Date | null }>(q, 'SELECT * FROM network.ownership_challenges WHERE id = $1 FOR UPDATE', [b.challengeId]);
      if (!ch || ch.used_at || ch.expires_at < ctx.now()) throw badRequest('challenge_expired', 'This signing request expired. Start again.');
      if (!(await verifyOwnership(ch.address, ch.message, b.signature))) throw forbidden('signature', 'The signature does not prove control of this address.');
      await q.query('UPDATE network.ownership_challenges SET used_at = $2 WHERE id = $1', [ch.id, ctx.now()]);
      const key = addressKey(ch.address);
      const listings = (await activeListings(q, key)).filter((l) => l.status === 'confirmed' || l.status === 'reported');
      if (!listings.length) {
        const open = await maybe(q, "SELECT 1 FROM network.appeals a JOIN network.listings l ON l.id = a.listing_id WHERE l.address_key = $1 AND a.status = 'open'", [key]);
        if (open) throw conflict('appeal_open', 'An appeal for this address is already open.');
        throw notFound('This address is not on the Backstop fraud list.');
      }
      const listing: Listing = listings[0]!;
      // Upheld: may appeal again after 90 days or with new evidence.
      const last = await maybe<{ decided_at: Date }>(q, "SELECT decided_at FROM network.appeals WHERE listing_id = $1 AND status = 'upheld' ORDER BY decided_at DESC LIMIT 1", [listing.id]);
      if (last && ctx.now().getTime() - last.decided_at.getTime() < rules.fraudList.appealCooldownDays * 86_400_000 && !(b.newEvidence && b.fileIds.length))
        throw forbidden('appeal_cooldown', `A previous appeal was upheld. You can appeal again after ${rules.fraudList.appealCooldownDays} days, or now with new evidence.`);
      const due = deadlineFor(ctx.now(), { businessDays: rules.fraudList.appealDecisionBusinessDays }, holidays);
      const reporterDue = deadlineFor(ctx.now(), { businessDays: rules.fraudList.reporterEvidenceBusinessDays }, holidays);
      const ref = publicRef();
      const a = await one<{ id: string }>(
        q,
        `INSERT INTO network.appeals (public_ref, kind, listing_id, address, address_key, appellant_email, ownership_challenge_id, ownership_signature, ownership_verified_at, statement, file_ids, due_at, reporter_evidence_due)
         VALUES ($1,'listing',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [ref, listing.id, ch.address, key, b.email.toLowerCase(), ch.id, b.signature, ctx.now(), b.statement, b.fileIds, due, reporterDue],
      );
      await q.query('UPDATE app.files SET attached_to = $2, attached_at = $3 WHERE id = ANY($1)', [b.fileIds, `appeal:${a.id}`, ctx.now()]);
      await q.query('UPDATE network.listings SET status_before_appeal = status WHERE id = $1', [listing.id]);
      await setListingStatus(q, listing.id, 'under_appeal', ctx.now(), `appeal opened ${key}`);
      // Step 3: the reporter is notified and can add evidence within 3 business days.
      const reporters = await many<{ reporter_user_id: string }>(
        q,
        'SELECT DISTINCT r.reporter_user_id FROM network.fraud_reports r JOIN network.fraud_cases c ON c.id = r.case_id WHERE c.address_key = $1 AND r.reporter_user_id IS NOT NULL',
        [key],
      );
      for (const r of reporters) await notify(q, { userId: r.reporter_user_id, kind: 'appeal_reporter', vars: { address: ch.address, due: reporterDue.toUTCString() }, data: { appealId: a.id }, dedupeKey: `appeal-reporter:${a.id}:${r.reporter_user_id}` });
      if (reporters.length) await q.query('UPDATE network.appeals SET reporter_notified_at = $2 WHERE id = $1', [a.id, ctx.now()]);
      await notify(q, { email: b.email, kind: 'appeal_received', vars: { ref, due: due.toUTCString() }, dedupeKey: `appeal-received:${a.id}` });
      await audit(q, { type: 'public' }, 'appeal.opened', 'appeal', a.id, { listingId: listing.id, ref });
      return { ref, due };
    });
    return j({ reference: out.ref, status: 'open', decisionDueBy: out.due, message: 'Your appeal is open. Track it with your reference number.' });
  });

  // C5-6: public status page shows status, case type and dates; never the reporter or evidence.
  app.get('/public/appeals/:ref', async (req) => {
    if (!(await ctx.limiter.hit(`appealstatus:${clientIp(req)}`, 60, 3600))) throw tooMany();
    const { ref } = parse(z.object({ ref: z.string().min(4).max(20) }), req.params);
    const a = await maybe<{ public_ref: string; status: string; kind: string; created_at: Date; due_at: Date; decided_at: Date | null; decision_reason: string | null; listing_id: string | null }>(
      ctx.db,
      'SELECT public_ref, status, kind, created_at, due_at, decided_at, decision_reason, listing_id FROM network.appeals WHERE public_ref = $1',
      [ref.toUpperCase()],
    );
    if (!a) throw notFound('Appeal not found.');
    const l = a.listing_id ? await maybe<{ label: string; status: string; created_at: Date }>(ctx.db, 'SELECT label, status, created_at FROM network.listings WHERE id = $1', [a.listing_id]) : null;
    return j({
      reference: a.public_ref,
      status: a.status,
      caseType: l?.label ?? a.kind,
      listingStatus: l?.status ?? null,
      listedAt: l?.created_at ?? null,
      appealedAt: a.created_at,
      decisionDueBy: a.due_at,
      decidedAt: a.decided_at,
      decisionReason: a.status === 'open' ? null : a.decision_reason,
    });
  });

  // In-app appeal for a held transfer (step 1). Exposure holds go to a risk analyst (the user is not listed).
  app.post('/appeals/hold', async (req) => {
    const s = await requireUser(ctx, req);
    const b = parse(z.object({ transferId: zUuid, statement: z.string().min(20).max(5_000), fileIds: z.array(zUuid).max(20).default([]) }), req.body);
    const rules = await ctx.versioned.rules();
    const holidays = await ctx.versioned.holidays();
    const out = await tx(ctx.db, async (q) => {
      const t = await maybe<{ id: string; availability: string; to_address: string }>(q, 'SELECT id, availability, to_address FROM app.transfers WHERE id = $1 AND user_id = $2', [b.transferId, s.user.id]);
      if (!t) throw notFound('Transfer not found.');
      if (!['on_hold', 'under_review'].includes(t.availability)) throw conflict('not_held', 'These funds are not on hold.');
      const open = await maybe(q, "SELECT 1 FROM network.appeals WHERE transfer_id = $1 AND status = 'open'", [t.id]);
      if (open) throw conflict('appeal_open', 'You already appealed this hold.');
      const ref = publicRef();
      const due = deadlineFor(ctx.now(), { businessDays: rules.fraudList.appealDecisionBusinessDays }, holidays);
      await q.query(
        `INSERT INTO network.appeals (public_ref, kind, transfer_id, appellant_user_id, appellant_email, statement, file_ids, due_at, address, address_key)
         VALUES ($1,'hold',$2,$3,$4,$5,$6,$7,$8,$9)`,
        [ref, t.id, s.user.id, s.user.email, b.statement, b.fileIds, due, t.to_address, t.to_address ? addressKey(t.to_address) : null],
      );
      await audit(q, { type: 'user', id: s.user.id }, 'appeal.hold_opened', 'transfer', t.id, { ref });
      await notify(q, { userId: s.user.id, kind: 'appeal_received', vars: { ref, due: due.toUTCString() }, dedupeKey: `appeal-received:${ref}` });
      return { ref, due };
    });
    return j({ reference: out.ref, decisionDueBy: out.due });
  });

  // Reporter adds evidence to an appeal against an address they reported (within 3 business days).
  app.post('/appeals/:id/reporter-evidence', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ statement: z.string().min(10).max(5_000), fileIds: z.array(zUuid).max(20).default([]) }), req.body);
    const a = await maybe<{ id: string; address_key: string; reporter_evidence_due: Date | null; status: string }>(ctx.db, 'SELECT * FROM network.appeals WHERE id = $1', [id]);
    if (!a || a.status !== 'open') throw notFound('Appeal not found.');
    const isReporter = await maybe(ctx.db, 'SELECT 1 FROM network.fraud_reports r JOIN network.fraud_cases c ON c.id = r.case_id WHERE c.address_key = $1 AND r.reporter_user_id = $2', [a.address_key, s.user.id]);
    if (!isReporter) throw forbidden('not_reporter', 'Only the reporter can add evidence here.');
    if (!a.reporter_evidence_due || a.reporter_evidence_due < ctx.now()) throw conflict('window_closed', 'The time to add evidence has passed.');
    await ctx.db.query('UPDATE network.appeals SET reporter_statement = $2, reporter_file_ids = $3 WHERE id = $1', [id, b.statement, b.fileIds]);
    await audit(ctx.db, { type: 'user', id: s.user.id }, 'appeal.reporter_evidence', 'appeal', id, {});
    return { ok: true };
  });
}
