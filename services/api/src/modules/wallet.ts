// C2 wallet and L1 send and receive.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  addressKey,
  CCTP_ESTIMATE,
  checkAddress,
  formatNairaReference,
  formatUnits,
  NETWORK_INFO,
  networksForAddress,
  parseUnits,
  PREFERRED_INTERNAL_NETWORK,
  quoteSendFee,
  type Network,
  type Token,
} from '@backstop/shared';
import type { Ctx } from '../ctx.ts';
import { maybe, many, one, tx, type Queryable } from '../db/pool.ts';
import { audit } from '../lib/audit.ts';
import { randomToken, sha256Hex } from '../lib/crypto.ts';
import { badRequest, conflict, forbidden, notFound, unavailable } from '../lib/errors.ts';
import { assertCanMoveMoney, j, parse, requireUser, zAmount, zNetwork, zToken, zUuid } from '../http.ts';
import { presendCheck, recordOverride, canonicalTokenFor, backstopAccepts } from '../services/checks.ts';
import { assertWithinLimits } from '../services/limits.ts';
import { addressOn, assertSpendable, balances, latestRate, pairBalance, walletOf } from '../services/wallet.ts';
import { bundle, transferCall } from '../services/txbuild.ts';
import { indexerHealth } from '../services/health.ts';

const DECISION_TTL_MS = 10 * 60_000;

interface Resolved {
  type: 'user' | 'address';
  userId: string | null;
  handle: string | null;
  verifiedName: string | null;
  displayName: string | null;
  address: string | null;
  networks: Network[];
}

async function resolveRecipient(ctx: Ctx, input: string): Promise<Resolved> {
  const s = input.trim();
  if (s.startsWith('@') || /^[a-z0-9_]{3,20}$/i.test(s)) {
    const u = await maybe<{ id: string; handle: string; verified_name: string | null; display_name: string | null; status: string }>(
      ctx.db,
      'SELECT id, handle, verified_name, display_name, status FROM app.users WHERE tenant_id = $1 AND lower(handle) = lower($2)',
      [ctx.cfg.tenantId, s.replace(/^@/, '')],
    );
    if (u && u.status === 'active') return { type: 'user', userId: u.id, handle: u.handle, verifiedName: u.verified_name, displayName: u.display_name, address: null, networks: [] };
    if (s.startsWith('@')) throw notFound(`No Backstop user ${s}.`);
  }
  if (/^\+\d{8,15}$/.test(s)) {
    // L1-1: found by phone number only if they opted in.
    const u = await maybe<{ id: string; handle: string; verified_name: string | null; display_name: string | null }>(
      ctx.db,
      "SELECT id, handle, verified_name, display_name FROM app.users WHERE tenant_id = $1 AND phone_e164 = $2 AND phone_discoverable AND phone_verified_at IS NOT NULL AND status = 'active'",
      [ctx.cfg.tenantId, s],
    );
    if (!u) throw notFound('No Backstop user can be found with that phone number.');
    return { type: 'user', userId: u.id, handle: u.handle, verifiedName: u.verified_name, displayName: u.display_name, address: null, networks: [] };
  }
  const c = checkAddress(s);
  if (!c.valid) throw badRequest('invalid_address', c.reason === 'bad_checksum' ? 'This address has a typo: its checksum does not match.' : 'This is not a valid handle, phone number or address.');
  const owner = await maybe<{ user_id: string; handle: string; verified_name: string | null; display_name: string | null }>(
    ctx.db,
    'SELECT w.user_id, u.handle, u.verified_name, u.display_name FROM app.wallets w JOIN app.users u ON u.id = w.user_id WHERE lower(w.evm_address) = $1 OR w.tron_address = $2',
    [addressKey(c.normalized), c.normalized],
  );
  return {
    type: 'address',
    userId: owner?.user_id ?? null,
    handle: owner?.handle ?? null,
    verifiedName: owner?.verified_name ?? null,
    displayName: owner?.display_name ?? null,
    address: c.normalized,
    networks: networksForAddress(c.normalized),
  };
}

/** C2-7: between Backstop users, pick the cheapest network both accept that the sender can pay from. */
async function routeInternal(ctx: Ctx, senderId: string, token: Token, amount: bigint): Promise<Network> {
  const w = await walletOf(ctx.db, senderId);
  if (!w) throw forbidden('no_wallet', 'Set up your wallet first.');
  const order = (token === 'USDT' ? (['tron', 'ethereum'] as Network[]) : ([PREFERRED_INTERNAL_NETWORK.USDC, 'base', 'ethereum'] as Network[])).filter((n) => !!ctx.cfg.chains[n]);
  if (!order.length) throw unavailable('network_unavailable', `Sending ${token} is not available right now.`);
  let best: { n: Network; balance: bigint } | null = null;
  for (const n of order) {
    const b = await pairBalance(ctx, ctx.db, senderId, w, n, token);
    if (b.spendable >= amount) return n;
    if (!best || b.balance > best.balance) best = { n, balance: b.balance };
  }
  // None can pay: route where the money is so the user sees the real reason (e.g. funds on hold).
  return best!.n;
}

export function registerWallet(app: FastifyInstance, ctx: Ctx): void {
  // C2-4: one address per network, the only token it accepts, and a plain warning.
  app.get('/wallet/receive', async (req) => {
    const s = await requireUser(ctx, req);
    const w = await walletOf(ctx.db, s.user.id);
    if (!w) throw notFound('Wallet not set up.');
    const entries = (
      [
        ['tron', 'USDT'],
        ['arc', 'USDC'],
        ['base', 'USDC'],
        ['ethereum', 'USDC'],
      ] as const
    ).map(([network, token]) => ({
      network,
      networkLabel: NETWORK_INFO[network].label,
      token,
      address: addressOn(w, network),
      qr: network === 'tron' ? addressOn(w, network) : `ethereum:${addressOn(w, network)}`,
      warning:
        network === 'tron'
          ? 'Send only USDT on the TRON network (TRC-20) to this address. Any other token or network can strand your money.'
          : `Send only USDC on ${NETWORK_INFO[network].label} to this address. Do not send USDT or any other token here.`,
      finality: NETWORK_INFO[network].finality,
      depositOnly: network === 'ethereum',
    }));
    return { handle: s.user.handle, entries };
  });

  app.get('/wallet/balances', async (req) => {
    const s = await requireUser(ctx, req);
    const b = await balances(ctx, ctx.db, s.user.id);
    if (!b) throw notFound('Wallet not set up.');
    return j(b);
  });

  app.get('/rates/ngn', async () => j(await latestRate(ctx, ctx.db)));

  // C2-9: history with status, counterparty, network, fee and naira reference; CSV export.
  const historyQuery = `
    SELECT t.id, t.direction, t.kind, t.network, t.token, t.amount_units, t.fee_units, t.status, t.availability, t.hold_reason,
           t.from_address, t.to_address, t.tx_hash, t.note, t.created_at, t.final_at, t.ngn_per_usd, t.rate_source, t.rate_as_of,
           coalesce(cu.handle, t.counterparty_label) AS counterparty, cu.verified_name AS counterparty_name
    FROM app.transfers t LEFT JOIN app.users cu ON cu.id = t.counterparty_user_id
    WHERE t.user_id = $1 AND t.availability <> 'dust_hidden' AND ($2::timestamptz IS NULL OR t.created_at < $2)
    ORDER BY t.created_at DESC LIMIT $3`;

  app.get('/wallet/history', async (req) => {
    const s = await requireUser(ctx, req);
    const qy = parse(z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const rows = await many<Record<string, unknown>>(ctx.db, historyQuery, [s.user.id, qy.before ?? null, qy.limit]);
    return j({
      items: rows.map((r) => ({
        ...r,
        amount: formatUnits(BigInt(r.amount_units as string)),
        fee: formatUnits(BigInt(r.fee_units as string)),
        nairaReference: r.ngn_per_usd ? formatNairaReference(BigInt(r.amount_units as string), { ngnPerUsd: String(r.ngn_per_usd), source: String(r.rate_source), asOf: String(r.rate_as_of) }) : null,
      })),
    });
  });

  app.get('/wallet/history.csv', async (req, reply) => {
    const s = await requireUser(ctx, req);
    const rows = await many<Record<string, unknown>>(ctx.db, historyQuery, [s.user.id, null, 10_000]);
    const esc = (v: unknown) => {
      const t = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const header = ['date', 'direction', 'type', 'status', 'availability', 'counterparty', 'network', 'token', 'amount_usd', 'fee_usd', 'naira_reference', 'rate_source', 'tx_hash'];
    const lines = rows.map((r) => {
      const amt = BigInt(r.amount_units as string);
      const ngn = r.ngn_per_usd ? formatNairaReference(amt, { ngnPerUsd: String(r.ngn_per_usd), source: '', asOf: '' }) : '';
      return [r.created_at, r.direction, r.kind, r.status, r.availability, r.counterparty ?? r.to_address ?? r.from_address, r.network, r.token, formatUnits(amt), formatUnits(BigInt(r.fee_units as string)), ngn, r.rate_source, r.tx_hash]
        .map(esc)
        .join(',');
    });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="backstop-history.csv"');
    return [header.join(','), ...lines].join('\n');
  });

  // L1-4 saved contacts with the network last used successfully.
  app.get('/contacts', async (req) => {
    const s = await requireUser(ctx, req);
    return j({
      contacts: await many(
        ctx.db,
        'SELECT c.id, c.label, c.address, c.last_network, c.last_token, c.last_success_at, u.handle, u.verified_name FROM app.contacts c LEFT JOIN app.users u ON u.id = c.recipient_user_id WHERE c.owner_id = $1 ORDER BY c.last_success_at DESC NULLS LAST, c.label',
        [s.user.id],
      ),
    });
  });

  app.post('/contacts', async (req) => {
    const s = await requireUser(ctx, req);
    const b = parse(z.object({ label: z.string().min(1).max(60), recipient: z.string().min(3) }), req.body);
    const r = await resolveRecipient(ctx, b.recipient);
    const row = await one(
      ctx.db,
      `INSERT INTO app.contacts (owner_id, label, recipient_user_id, address) VALUES ($1,$2,$3,$4)
       ON CONFLICT (owner_id, coalesce(recipient_user_id::text, address)) DO UPDATE SET label = EXCLUDED.label RETURNING id`,
      [s.user.id, b.label, r.type === 'user' ? r.userId : null, r.type === 'address' ? r.address : null],
    );
    return j(row);
  });

  app.delete('/contacts/:id', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await ctx.db.query('DELETE FROM app.contacts WHERE id = $1 AND owner_id = $2', [id, s.user.id]);
    return { ok: true };
  });

  // Step 1 of the send flow: who is the recipient, and which networks fit (L1-3).
  app.post('/send/resolve', async (req) => {
    await requireUser(ctx, req);
    const b = parse(z.object({ recipient: z.string().min(3).max(120) }), req.body);
    const r = await resolveRecipient(ctx, b.recipient);
    return {
      ...r,
      requiresNetworkConfirmation: r.type === 'address' && r.networks.length > 1,
      networkHint: r.type === 'address' && r.networks.length > 1 ? 'This address works on Base, Arc and Ethereum. Confirm which network the recipient expects.' : null,
    };
  });

  // Steps 2-4: amount in dollars, naira reference, fee, and the pre-send check.
  app.post('/send/quote', async (req) => {
    const s = await requireUser(ctx, req);
    const b = parse(
      z.object({
        recipient: z.string().min(3).max(120),
        token: zToken,
        amount: zAmount,
        network: zNetwork.optional(),
        networkConfirmed: z.boolean().default(false),
        typedName: z.string().max(120).optional(),
        paymentRequestId: zUuid.optional(),
      }),
      req.body,
    );
    const amount = parseUnits(b.amount);
    if (amount <= 0n) throw badRequest('amount', 'Enter an amount above zero.');
    const r = await resolveRecipient(ctx, b.recipient);
    let network: Network;
    let address: string;
    let internal = false;
    if (r.type === 'user') {
      if (r.userId === s.user.id) throw badRequest('self', 'You cannot send to yourself.');
      const rw = await walletOf(ctx.db, r.userId!);
      if (!rw) throw badRequest('recipient_no_wallet', 'This user has not set up their wallet yet.');
      network = b.network && backstopAccepts(b.network, b.token) ? b.network : await routeInternal(ctx, s.user.id, b.token, amount);
      address = addressOn(rw, network);
      internal = true;
    } else {
      if (!b.network) throw badRequest('network_required', 'Choose the network the recipient expects.', { networks: r.networks });
      if (!r.networks.includes(b.network)) throw badRequest('network_mismatch', `This address cannot receive on ${NETWORK_INFO[b.network].label}.`);
      if (r.networks.length > 1 && !b.networkConfirmed) throw badRequest('network_confirmation', 'Confirm the recipient expects this network.', { networks: r.networks });
      network = b.network;
      address = r.address!;
      internal = !!r.userId;
    }
    const fee = quoteSendFee({ internal, token: b.token }, await ctx.versioned.fees());
    const rate = await latestRate(ctx, ctx.db);
    const check = await presendCheck(ctx, ctx.db, {
      userId: s.user.id,
      recipientUserId: r.userId,
      address,
      network,
      token: b.token,
      amountUnits: amount,
      typedName: b.typedName ?? null,
      protectedPayment: false,
    });
    await audit(ctx.db, { type: 'user', id: s.user.id }, 'check.presend', 'check_decision', check.decisionId, { decision: check.decision, reasons: check.reasons.map((x) => x.code) });
    return j({
      recipient: { ...r, address },
      network,
      networkLabel: NETWORK_INFO[network].label,
      token: b.token,
      amount: formatUnits(amount),
      fee: formatUnits(fee),
      total: formatUnits(amount + fee),
      nairaReference: { value: formatNairaReference(amount, rate), rate: rate.ngnPerUsd, source: rate.source, asOf: rate.asOf },
      check,
      gas: NETWORK_INFO[network].gas,
    });
  });

  // C3-2: warnings can be overridden after reading and confirming; logged.
  app.post('/send/override', async (req) => {
    const s = await requireUser(ctx, req);
    const b = parse(z.object({ decisionId: zUuid, acknowledged: z.array(z.string()).min(1) }), req.body);
    await tx(ctx.db, async (q) => {
      await recordOverride(q, b.decisionId, s.user.id, b.acknowledged, ctx.now());
      await audit(q, { type: 'user', id: s.user.id }, 'check.override', 'check_decision', b.decisionId, { acknowledged: b.acknowledged });
    });
    return { ok: true };
  });

  // Step 5a: build the unsigned transfer for the device to sign with the passkey.
  app.post('/send/prepare', async (req) => {
    const s = await requireUser(ctx, req);
    assertCanMoveMoney(ctx, s);
    const b = parse(z.object({ decisionId: zUuid, idempotencyKey: z.string().min(8).max(100), note: z.string().max(200).optional(), paymentRequestId: zUuid.optional() }), req.body);
    if (s.user.tier === 'none' || s.user.kind === 'counterparty') throw forbidden('tier_required', 'Verify your identity before sending money.');
    return tx(ctx.db, async (q) => {
      const existing = await maybe<{ id: string }>(q, 'SELECT id FROM app.transfers WHERE user_id = $1 AND idempotency_key = $2', [s.user.id, b.idempotencyKey]);
      if (existing) return prepared(q, existing.id);
      const d = await maybe<{ user_id: string; kind: string; decision: string; inputs: Record<string, unknown>; overridden_at: Date | null; created_at: Date; degraded: boolean }>(
        q,
        'SELECT * FROM network.check_decisions WHERE id = $1',
        [b.decisionId],
      );
      if (!d || d.user_id !== s.user.id || d.kind !== 'presend') throw notFound('Run the safety check first.');
      if (d.decision === 'block') throw forbidden('blocked', 'This payment is blocked and cannot be sent.');
      if (d.decision === 'warn' && !d.overridden_at) throw forbidden('warning_unconfirmed', 'Read and confirm the warnings first.');
      if (ctx.now().getTime() - d.created_at.getTime() > DECISION_TTL_MS) throw conflict('check_expired', 'The safety check is out of date. Check again.');
      const facts = d.inputs as { input: { network: Network; token: Token; amountUnits: string; recipientUserId?: string | null }; normalizedAddress: string | null; recipientIsBackstop: boolean };
      if (!facts.normalizedAddress) throw forbidden('blocked', 'This payment is blocked and cannot be sent.');
      const i = { ...facts.input, address: facts.normalizedAddress, recipientUserId: facts.input.recipientUserId ?? null };
      const amount = BigInt(i.amountUnits);
      await assertWithinLimits(ctx, q, s.user.id, s.user.tier, amount);
      const internal = !!i.recipientUserId || facts.recipientIsBackstop;
      const fee = quoteSendFee({ internal, token: i.token }, await ctx.versioned.fees());
      await assertSpendable(ctx, q, s.user.id, i.network, i.token, amount + fee, 'payments');
      const w = (await walletOf(q, s.user.id))!;
      const rate = await latestRate(ctx, q);
      const t = await one<{ id: string }>(
        q,
        `INSERT INTO app.transfers (user_id, direction, kind, network, token, token_contract, amount_units, fee_units, from_address, to_address, counterparty_user_id, status, availability,
           presend_decision_id, idempotency_key, note, payment_request_id, ngn_per_usd, rate_source, rate_as_of)
         VALUES ($1,'out','transfer',$2,$3,$4,$5,$6,$7,$8,$9,'prepared','available',$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [
          s.user.id,
          i.network,
          i.token,
          canonicalTokenFor(ctx, i.network, i.token),
          amount.toString(),
          fee.toString(),
          addressOn(w, i.network),
          i.address,
          i.recipientUserId,
          b.decisionId,
          b.idempotencyKey,
          b.note ?? null,
          b.paymentRequestId ?? null,
          rate.ngnPerUsd,
          rate.source,
          rate.asOf,
        ],
      );
      await audit(q, { type: 'user', id: s.user.id }, 'send.prepared', 'transfer', t.id, { decisionId: b.decisionId, degraded: d.degraded });
      return prepared(q, t.id);
    });

    async function prepared(q: Queryable, id: string) {
      const t = await one<{ id: string; network: Network; token: Token; token_contract: string; amount_units: string; fee_units: string; to_address: string; status: string }>(
        q,
        'SELECT * FROM app.transfers WHERE id = $1',
        [id],
      );
      const calls = [transferCall(t.network, t.token_contract, t.to_address, BigInt(t.amount_units), `Send ${formatUnits(BigInt(t.amount_units))} ${t.token}`)];
      const treasury = ctx.cfg.treasury[t.network];
      if (BigInt(t.fee_units) > 0n) {
        if (!treasury) throw unavailable('fee_unconfigured', 'Sending is unavailable on this network right now.');
        calls.push(transferCall(t.network, t.token_contract, treasury, BigInt(t.fee_units), `Network fee ${formatUnits(BigInt(t.fee_units))} ${t.token} (TRON energy)`));
      }
      return j({ transferId: t.id, status: t.status, bundle: bundle(t.network, calls, ctx.cfg.chains[t.network]?.chainId) });
    }
  });

  // Step 5b: the device returns the signed transaction(s). A signed transaction is never broadcast
  // twice: the same bytes resubmitted return the existing record (NFR Connectivity).
  app.post('/send/submit', async (req) => {
    const s = await requireUser(ctx, req);
    assertCanMoveMoney(ctx, s);
    const b = parse(z.object({ transferId: zUuid, signedTx: z.string().min(10).optional(), txHash: z.string().min(10).optional(), feeSignedTx: z.string().min(10).optional() }), req.body);
    if (!b.signedTx && !b.txHash) throw badRequest('signed_tx', 'Provide the signed transaction or its hash.');
    const t = await maybe<{ id: string; user_id: string; network: Network; status: string; signed_tx_sha256: string | null; tx_hash: string | null }>(
      ctx.db,
      'SELECT id, user_id, network, status, signed_tx_sha256, tx_hash FROM app.transfers WHERE id = $1',
      [b.transferId],
    );
    if (!t || t.user_id !== s.user.id) throw notFound('Payment not found.');
    if (t.status !== 'prepared') return { transferId: t.id, status: t.status, txHash: t.tx_hash };
    let txHash = b.txHash ?? null;
    if (b.signedTx) {
      const digest = sha256Hex(b.signedTx.toLowerCase());
      const claimed = await ctx.db.query("UPDATE app.transfers SET signed_tx_sha256 = $2, status = 'submitted', submitted_at = $3 WHERE id = $1 AND status = 'prepared' AND signed_tx_sha256 IS NULL RETURNING id", [
        t.id,
        digest,
        ctx.now(),
      ]).catch((e: Error & { code?: string }) => {
        if (e.code === '23505') throw conflict('already_broadcast', 'This signed payment was already sent.');
        throw e;
      });
      if (!claimed.rowCount) return { transferId: t.id, status: 'submitted', txHash: t.tx_hash };
      const chain = ctx.chains[t.network];
      if (!chain) throw unavailable('network_unavailable', `${NETWORK_INFO[t.network].label} is unavailable right now.`);
      try {
        txHash = await chain.broadcast(b.signedTx);
      } catch (e) {
        await ctx.db.query("UPDATE app.transfers SET status = 'failed' WHERE id = $1", [t.id]);
        await audit(ctx.db, { type: 'user', id: s.user.id }, 'send.broadcast_failed', 'transfer', t.id, { error: (e as Error).message });
        throw badRequest('broadcast_failed', 'The network rejected this payment. No money left your wallet.');
      }
      // TRON: the flat energy fee is a second transaction, relayed after the payment itself.
      if (b.feeSignedTx) await chain.broadcast(b.feeSignedTx).catch(async (e: Error) => audit(ctx.db, { type: 'user', id: s.user.id }, 'send.fee_broadcast_failed', 'transfer', t.id, { error: e.message }));
    }
    await ctx.db.query("UPDATE app.transfers SET tx_hash = $2, status = 'submitted', submitted_at = coalesce(submitted_at, $3) WHERE id = $1", [t.id, txHash, ctx.now()]);
    await audit(ctx.db, { type: 'user', id: s.user.id }, 'send.submitted', 'transfer', t.id, { txHash });
    return { transferId: t.id, status: 'submitted', txHash };
  });

  app.get('/transfers/:id', async (req) => {
    const s = await requireUser(ctx, req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const t = await maybe<Record<string, unknown>>(ctx.db, 'SELECT * FROM app.transfers WHERE id = $1 AND user_id = $2', [id, s.user.id]);
    if (!t) throw notFound();
    const decision = t.check_decision_id ? await maybe(ctx.db, 'SELECT id, decision, reasons, list_version, rule_version, created_at FROM network.check_decisions WHERE id = $1', [t.check_decision_id]) : null;
    const appeal = await maybe(ctx.db, 'SELECT public_ref, status, due_at FROM network.appeals WHERE transfer_id = $1 ORDER BY created_at DESC LIMIT 1', [id]);
    return j({ ...t, amount: formatUnits(BigInt(t.amount_units as string)), decision, appeal });
  });

  // L1-2 payment-request links with amount, note and expiry.
  app.post('/payment-requests', async (req) => {
    const s = await requireUser(ctx, req);
    const b = parse(z.object({ amount: zAmount, token: zToken, note: z.string().max(200).optional(), expiresInHours: z.number().int().min(1).max(24 * 30).default(72) }), req.body);
    const slug = randomToken(9);
    const r = await one(
      ctx.db,
      'INSERT INTO app.payment_requests (user_id, slug, amount_units, token, note, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, slug, expires_at',
      [s.user.id, slug, parseUnits(b.amount).toString(), b.token, b.note ?? null, new Date(ctx.now().getTime() + b.expiresInHours * 3600_000)],
    );
    return j({ ...r, link: `${ctx.cfg.webBaseUrl}/pay/${slug}` });
  });

  app.get('/payment-requests', async (req) => {
    const s = await requireUser(ctx, req);
    return j({ requests: await many(ctx.db, 'SELECT id, slug, amount_units, token, note, expires_at, status, created_at FROM app.payment_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [s.user.id]) });
  });

  // Public: payable by Backstop users or any external wallet.
  app.get('/public/pay/:slug', async (req) => {
    const { slug } = parse(z.object({ slug: z.string().min(6).max(40) }), req.params);
    const r = await maybe<{ id: string; user_id: string; amount_units: string; token: Token; note: string | null; expires_at: Date; status: string }>(ctx.db, 'SELECT * FROM app.payment_requests WHERE slug = $1', [slug]);
    if (!r) throw notFound('Payment request not found.');
    const u = await one<{ handle: string; verified_name: string | null; display_name: string | null }>(ctx.db, 'SELECT handle, verified_name, display_name FROM app.users WHERE id = $1', [r.user_id]);
    const w = await walletOf(ctx.db, r.user_id);
    const expired = r.expires_at < ctx.now() || r.status !== 'open';
    const networks: Network[] = r.token === 'USDT' ? ['tron'] : ['arc', 'base', 'ethereum'];
    return j({
      id: r.id,
      payee: { handle: u.handle, verifiedName: u.verified_name, displayName: u.display_name },
      amount: formatUnits(BigInt(r.amount_units)),
      token: r.token,
      note: r.note,
      expiresAt: r.expires_at,
      status: expired && r.status === 'open' ? 'expired' : r.status,
      pay: expired || !w ? [] : networks.map((n) => ({ network: n, networkLabel: NETWORK_INFO[n].label, address: addressOn(w, n), token: r.token, warning: `Send exactly ${formatUnits(BigInt(r.amount_units))} ${r.token} on ${NETWORK_INFO[n].label} only.` })),
    });
  });

  // C2-8 (Should): move USDC between Base and Arc through CCTP, showing the expected wait.
  app.post('/cctp/quote', async (req) => {
    const s = await requireUser(ctx, req);
    const b = parse(z.object({ from: z.enum(['base', 'arc']), to: z.enum(['base', 'arc']), amount: zAmount, fast: z.boolean().default(false) }), req.body);
    if (b.from === b.to) throw badRequest('same_network', 'Choose two different networks.');
    const amount = parseUnits(b.amount);
    await assertSpendable(ctx, ctx.db, s.user.id, b.from, 'USDC', amount, 'transfers');
    const est = b.fast ? CCTP_ESTIMATE.fastSeconds : CCTP_ESTIMATE.standardSeconds;
    const configured = !!process.env[`${b.from.toUpperCase()}_CCTP_TOKEN_MESSENGER`];
    return {
      from: b.from,
      to: b.to,
      amount: formatUnits(amount),
      mode: b.fast ? 'fast' : 'standard',
      expectedWait: { minSeconds: est.min, maxSeconds: est.max, text: b.fast ? 'About 8 to 20 seconds' : 'About 15 to 19 minutes' },
      available: configured,
      note: configured ? null : 'Moving USDC between Base and Arc is not switched on yet.',
    };
  });

  // Indexer/health status for the app's notices (edge case: indexer behind).
  app.get('/status', async () => j(await indexerHealth(ctx)));
}
