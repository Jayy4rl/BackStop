// Chain indexer. The chain is the source of truth: the database changes only from events in blocks
// that are final for that chain (Arc deterministic, Base `finalized`, Ethereum finalized checkpoint,
// TRON solidified), never optimistically. Every handler is idempotent so replays change nothing.
import {
  addressKey,
  AUTO_RELEASE_REMINDERS_SECONDS,
  ARBITER_TIMEOUT_ALERT_FRACTION,
  DISPUTE_EXPIRY_WARNING_SECONDS,
  formatUnits,
  NETWORK_INFO,
  TOKENS,
  type Network,
  type Token,
} from '@backstop/shared';
import type { Ctx } from '../ctx.ts';
import { maybe, many, one, tx, type Queryable } from '../db/pool.ts';
import { audit } from '../lib/audit.ts';
import { enqueue } from '../lib/jobs.ts';
import type { ChainClient } from '../chain/types.ts';
import type { EscrowEvent, TokenTransferLog } from '../chain/types.ts';
import { canonicalTokenFor, inboundCheck } from './checks.ts';
import { upsertListing, setListingStatus } from './fraudlist.ts';
import { applyInboundDecision, type TransferRow } from './holds.ts';
import { notify, notifyStaff } from './notify.ts';
import { applyChainState, getPayment, notifyParties, type PaymentRow } from './payments.ts';
import { deadlineFor, LOOP_TERMS } from '@backstop/shared';

const ZERO_HASH = `0x${'0'.repeat(64)}`;
const BATCH_BLOCKS = 5_000n;

async function cursor(q: Queryable, network: Network, stream: string, start: bigint): Promise<bigint> {
  const r = await maybe<{ last_block: bigint }>(q, 'SELECT last_block FROM ops.indexer_cursors WHERE network = $1 AND stream = $2', [network, stream]);
  return r ? BigInt(r.last_block) : start - 1n;
}

async function saveCursor(q: Queryable, network: Network, stream: string, last: bigint, head: bigint, now: Date): Promise<void> {
  await q.query(
    `INSERT INTO ops.indexer_cursors (network, stream, last_block, head_block, head_seen_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)
     ON CONFLICT (network, stream) DO UPDATE SET last_block = EXCLUDED.last_block, head_block = EXCLUDED.head_block, head_seen_at = EXCLUDED.head_seen_at, updated_at = EXCLUDED.updated_at`,
    [network, stream, last.toString(), head.toString(), now],
  );
}

async function paymentByEscrow(q: Queryable, escrow: string): Promise<PaymentRow | null> {
  return maybe<PaymentRow>(q, 'SELECT * FROM app.payments WHERE lower(escrow_address) = lower($1) OR escrow_address = $1 FOR UPDATE', [escrow]);
}

// ---------------------------------------------------------------- escrow events

export async function handleEscrowEvent(ctx: Ctx, q: Queryable, network: Network, e: EscrowEvent): Promise<void> {
  const at = e.blockTime;
  if (e.name === 'EscrowCreated') {
    const ref = String(e.args.orderRef);
    const p = await maybe<PaymentRow>(q, 'SELECT * FROM app.payments WHERE order_ref = $1 FOR UPDATE', [ref]);
    if (!p) {
      await audit(q, { type: 'indexer' }, 'escrow.unknown_created', 'escrow', e.escrow, { network, orderRef: ref, tx: e.txHash });
      return;
    }
    if (p.escrow_address) return; // replay
    const changed = await applyChainState(ctx, q, p, 'funded', at, { escrow_address: e.escrow, funded_tx: e.txHash, network, payer_address: String(e.args.payer) });
    if (!changed && p.status !== 'cancelled') return;
    if (p.status === 'cancelled') {
      // Funded after an off-chain cancel (e.g. funding window raced the keeper): the contract governs.
      await q.query("UPDATE app.payments SET status = 'funded', escrow_address = $2, funded_at = $3, funded_tx = $4, cancelled_at = NULL, cancel_reason = NULL WHERE id = $1", [p.id, e.escrow, at, e.txHash]);
    }
    if (p.payer_user_id)
      await q.query(
        `INSERT INTO app.transfers (user_id, direction, kind, network, token, amount_units, from_address, to_address, counterparty_user_id, status, availability, tx_hash, log_index, block_number, payment_id, final_at)
         VALUES ($1,'out','escrow_funding',$2,$3,$4,$5,$6,$7,'final','available',$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
        [p.payer_user_id, network, p.token, p.amount_units, String(e.args.payer), e.escrow, p.payee_user_id, e.txHash, -1 - e.logIndex, e.blockNumber.toString(), p.id, at],
      );
    await notifyParties(q, p, 'payment_funded', {}, `funded:${p.id}`);
    if (p.loop === 'L4' && p.trade_id) {
      await q.query("UPDATE app.p2p_trades SET status = 'escrowed' WHERE id = $1 AND status = 'awaiting_escrow'", [p.trade_id]);
      const t = await one<{ buyer_id: string; naira_kobo: string; seller_bank_account_id: string; payment_deadline: Date | null }>(q, 'SELECT * FROM app.p2p_trades WHERE id = $1', [p.trade_id]);
      const bank = await one<{ bank_name: string; account_last4: string; account_name: string }>(q, 'SELECT bank_name, account_last4, account_name FROM app.bank_accounts WHERE id = $1', [t.seller_bank_account_id]);
      const kobo = BigInt(t.naira_kobo);
      await notify(q, {
        userId: t.buyer_id,
        kind: 'p2p_trade_escrowed',
        vars: { naira: `₦${(kobo / 100n).toLocaleString('en-US')}`, bankName: bank.bank_name, last4: bank.account_last4, accountName: bank.account_name, minutes: Math.max(1, Math.round((p.deliver_by.getTime() - at.getTime()) / 60_000)) },
        dedupeKey: `p2p-escrowed:${p.trade_id}`,
      });
      await q.query('INSERT INTO app.trade_messages (trade_id, body, system) VALUES ($1,$2,true)', [p.trade_id, 'USDT is locked in escrow. Buyer: pay now from your own registered account, then mark the trade paid.']);
    }
    if (p.order_id) await q.query("UPDATE app.trade_orders SET status = 'funded' WHERE id = $1 AND status IN ('accepted')", [p.order_id]);
    if (p.invoice_id) await refreshInvoiceStatus(q, p.invoice_id);
    return;
  }

  const p = await paymentByEscrow(q, e.escrow);
  if (!p) return;
  if (e.name === 'Delivered') {
    const holdUntil = new Date(Number(e.args.holdUntil as bigint) * 1000);
    if (!(await applyChainState(ctx, q, p, 'delivered', at, { hold_until: p.auto_release ? holdUntil : null }))) return;
    if (p.loop === 'L4' && p.trade_id) {
      await q.query("UPDATE app.p2p_trades SET status = 'paid', marked_paid_at = $2 WHERE id = $1", [p.trade_id, at]);
      const t = await one<{ seller_id: string; buyer_id: string }>(q, 'SELECT seller_id, buyer_id FROM app.p2p_trades WHERE id = $1', [p.trade_id]);
      const buyer = await one<{ verified_name: string }>(q, 'SELECT verified_name FROM app.users WHERE id = $1', [t.buyer_id]);
      await notify(q, { userId: t.seller_id, kind: 'payment_delivered_manual', vars: { buyerName: buyer.verified_name }, dedupeKey: `p2p-paid:${p.trade_id}` });
    } else {
      await notifyParties(q, p, 'payment_delivered', { deadline: holdUntil.toUTCString() }, `delivered:${p.id}`);
      if (p.order_id) await q.query("UPDATE app.trade_orders SET status = 'shipped' WHERE id = $1", [p.order_id]);
      if (p.auto_release) {
        // L2-5 reminders 72h and 24h before auto-release; C4-7 warning 24h before the dispute window closes.
        for (const s of AUTO_RELEASE_REMINDERS_SECONDS) {
          const runAt = new Date(holdUntil.getTime() - s * 1000);
          if (runAt > ctx.now()) await enqueue(q, 'release_reminder', { paymentId: p.id, hours: s / 3600 }, { runAt, dedupeKey: `reminder:${p.id}:${s}` });
        }
        const warnAt = new Date(holdUntil.getTime() - DISPUTE_EXPIRY_WARNING_SECONDS * 1000);
        if (warnAt > ctx.now()) await enqueue(q, 'dispute_window_warning', { paymentId: p.id }, { runAt: warnAt, dedupeKey: `dispute-warn:${p.id}` });
        await enqueue(q, 'keeper_release', { paymentId: p.id }, { runAt: holdUntil, dedupeKey: `release:${p.id}` });
      }
    }
    return;
  }
  if (e.name === 'Disputed') {
    if (!(await applyChainState(ctx, q, p, 'disputed', at))) return;
    const by = String(e.args.by).toLowerCase();
    const role = by === (p.payer_address ?? '').toLowerCase() ? 'payer' : 'payee';
    const pending = await maybe<{ id: string }>(q, "SELECT id FROM network.disputes WHERE payment_id = $1 AND status NOT IN ('executed','closed') ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [p.id]);
    const holidays = await ctx.versioned.holidays();
    const lt = LOOP_TERMS[p.loop];
    let disputeId: string;
    if (pending) {
      disputeId = pending.id;
      // Evidence and ruling clocks run from the on-chain dispute.
      await q.query('UPDATE network.disputes SET opened_onchain_at = $2, evidence_due_at = $3, ruling_due_at = $4 WHERE id = $1', [pending.id, at, deadlineFor(at, lt.evidenceWindow, holidays), deadlineFor(at, lt.rulingTarget, holidays)]);
    } else {
      const d = await one<{ id: string }>(
        q,
        `INSERT INTO network.disputes (payment_id, loop, opened_by_role, reason, evidence_due_at, ruling_due_at, evidence_hash, opened_onchain_at) VALUES ($1,$2,$3,'Opened on-chain',$4,$5,$6,$7) RETURNING id`,
        [p.id, p.loop, role, deadlineFor(at, lt.evidenceWindow, holidays), deadlineFor(at, lt.rulingTarget, holidays), String(e.args.evidenceHash), at],
      );
      disputeId = d.id;
    }
    if (p.trade_id) await q.query("UPDATE app.p2p_trades SET status = 'disputed' WHERE id = $1", [p.trade_id]);
    await notifyParties(q, p, 'dispute_opened', { deadline: deadlineFor(at, lt.evidenceWindow, holidays).toUTCString() }, `disputed:${p.id}:${disputeId}`);
    await notifyStaff(q, 'dispute_reviewer', 'New dispute', `"${p.title}" (${p.loop}, $${formatUnits(BigInt(p.amount_units))}) was disputed.`, { disputeId }, `staff-dispute:${disputeId}`);
    const timeoutAt = new Date(at.getTime() + p.arbiter_timeout_seconds * 1000);
    await enqueue(q, 'arbiter_timeout_alert', { paymentId: p.id }, { runAt: new Date(at.getTime() + p.arbiter_timeout_seconds * 1000 * ARBITER_TIMEOUT_ALERT_FRACTION), dedupeKey: `arbiter-alert:${p.id}:${at.getTime()}` });
    await enqueue(q, 'keeper_arbiter_timeout', { paymentId: p.id }, { runAt: timeoutAt, dedupeKey: `arbiter-timeout:${p.id}:${at.getTime()}` });
    return;
  }
  if (e.name === 'Released' || e.name === 'Refunded') {
    const released = e.name === 'Released';
    const rulingHash = String(e.args.rulingHash);
    const extra: Record<string, unknown> = released ? { fee_owed_units: String(e.args.feeOwed) } : {};
    if (rulingHash !== ZERO_HASH) extra.last_ruling_hash = rulingHash;
    if (!(await applyChainState(ctx, q, p, released ? 'released' : 'refunded', at, extra))) return;
    if (rulingHash !== ZERO_HASH) {
      await q.query("UPDATE network.disputes SET status = 'executed', executed_at = $2, executed_tx = $3 WHERE payment_id = $1 AND ruling_hash = $4", [p.id, at, e.txHash, rulingHash]);
    } else {
      // Settled without a ruling (approval, auto-release, payee refund, reclaim, timeout): close any open dispute.
      await q.query("UPDATE network.disputes SET status = 'closed' WHERE payment_id = $1 AND status NOT IN ('executed','closed')", [p.id]);
    }
    await notifyParties(q, p, released ? 'payment_released' : 'payment_refunded', {}, `${released ? 'released' : 'refunded'}:${p.id}`);
    if (released && BigInt(String(e.args.feeOwed)) > 0n) await enqueue(q, 'keeper_collect_fee', { paymentId: p.id }, { dedupeKey: `fee:${p.id}` });
    if (p.trade_id) await q.query(`UPDATE app.p2p_trades SET status = $2, confirmed_at = CASE WHEN $2 = 'released' THEN $3::timestamptz ELSE confirmed_at END WHERE id = $1`, [p.trade_id, released ? 'released' : 'refunded', at]);
    if (p.order_id) {
      const open = await one<{ n: string }>(q, "SELECT count(*) AS n FROM app.payments WHERE order_id = $1 AND status NOT IN ('released','refunded','cancelled')", [p.order_id]);
      if (Number(open.n) === 0) await q.query("UPDATE app.trade_orders SET status = 'completed' WHERE id = $1", [p.order_id]);
    }
    if (p.invoice_id) await refreshInvoiceStatus(q, p.invoice_id);
    return;
  }
  if (e.name === 'FeeCollected') {
    await q.query('UPDATE app.payments SET fee_collected = true WHERE id = $1', [p.id]);
    await audit(q, { type: 'indexer' }, 'escrow.fee_collected', 'payment', p.id, { amount: String(e.args.amount), treasury: String(e.args.treasury) });
    return;
  }
  if (e.name === 'ExcessReturned') await audit(q, { type: 'indexer' }, 'escrow.excess_returned', 'payment', p.id, { amount: String(e.args.amount) });
}

async function refreshInvoiceStatus(q: Queryable, invoiceId: string): Promise<void> {
  const r = await one<{ total: string; funded: string; done: string; cancelled: string }>(
    q,
    `SELECT count(*) AS total, count(*) FILTER (WHERE status IN ('funded','delivered','disputed','released','refunded')) AS funded,
            count(*) FILTER (WHERE status IN ('released','refunded')) AS done, count(*) FILTER (WHERE status = 'cancelled') AS cancelled FROM app.payments WHERE invoice_id = $1`,
    [invoiceId],
  );
  const total = Number(r.total);
  const status = Number(r.done) + Number(r.cancelled) === total && Number(r.done) > 0 ? 'completed' : Number(r.cancelled) === total ? 'cancelled' : Number(r.funded) === total ? 'funded' : Number(r.funded) > 0 ? 'partially_funded' : 'sent';
  await q.query('UPDATE app.invoices SET status = $2 WHERE id = $1', [invoiceId, status]);
}

// ---------------------------------------------------------------- wallet transfers

interface WalletOwner {
  user_id: string;
  address: string;
}

async function owners(q: Queryable, network: Network): Promise<WalletOwner[]> {
  const col = NETWORK_INFO[network].family === 'tron' ? 'tron_address' : 'evm_address';
  return many<WalletOwner>(q, `SELECT user_id, ${col} AS address FROM app.wallets WHERE ${col} IS NOT NULL`);
}

export async function handleTransfer(ctx: Ctx, q: Queryable, network: Network, token: Token | null, t: TokenTransferLog, byKey: Map<string, string>): Promise<void> {
  // Tracing graph for inbound checks.
  await q.query(
    `INSERT INTO network.chain_transfers (network, tx_hash, log_index, token_contract, from_key, to_key, amount_units, block_number, block_time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
    [network, t.txHash, t.logIndex, addressKey(t.tokenContract), addressKey(t.from), addressKey(t.to), t.amount.toString(), t.blockNumber.toString(), t.blockTime],
  );
  const sender = byKey.get(addressKey(t.from));
  const recipient = byKey.get(addressKey(t.to));
  const symbol = token ?? (TOKENS.find((s) => canonicalTokenFor(ctx, network, s) && addressKey(canonicalTokenFor(ctx, network, s)!) === addressKey(t.tokenContract)) ?? null);
  const fromEscrow = await maybe<{ id: string; payer_user_id: string | null; payee_user_id: string }>(q, 'SELECT id, payer_user_id, payee_user_id FROM app.payments WHERE lower(escrow_address) = lower($1) OR escrow_address = $1', [t.from]);
  const toEscrow = await maybe<{ id: string }>(q, 'SELECT id FROM app.payments WHERE lower(escrow_address) = lower($1) OR escrow_address = $1', [t.to]);
  const rate = await maybe<{ ngn_per_usd: string; source: string; as_of: Date }>(q, 'SELECT ngn_per_usd, source, as_of FROM app.rate_snapshots ORDER BY as_of DESC LIMIT 1');

  if (sender) {
    // Outgoing: finalise a submitted send, or record one made outside the app.
    const done = await q.query(
      "UPDATE app.transfers SET status = 'final', final_at = $3, log_index = $4, block_number = $5 WHERE user_id = $1 AND tx_hash = $2 AND direction = 'out' AND status IN ('submitted','confirmed') AND (to_address = $6 OR lower(to_address) = lower($6)) AND amount_units = $7 RETURNING id, to_address, counterparty_user_id, amount_units, token",
      [sender, t.txHash, t.blockTime, t.logIndex, t.blockNumber.toString(), t.to, t.amount.toString()],
    );
    if (done.rowCount) {
      const row = done.rows[0];
      await notify(q, { userId: sender, kind: 'send_final', vars: { amount: formatUnits(t.amount), token: String(row.token), to: String(row.to_address) }, dedupeKey: `send-final:${row.id}` });
      // L1-4: remember the network last used successfully.
      await q.query('UPDATE app.contacts SET last_network = $3, last_token = $4, last_success_at = $5 WHERE owner_id = $1 AND (address = $2 OR recipient_user_id = $6)', [sender, row.to_address, network, row.token, t.blockTime, row.counterparty_user_id]);
      await q.query("UPDATE app.payment_requests SET status = 'paid', paid_transfer_id = $1 WHERE id = (SELECT payment_request_id FROM app.transfers WHERE id = $1) AND status = 'open'", [row.id]);
    } else if (!toEscrow) {
      await q.query(
        `INSERT INTO app.transfers (user_id, direction, kind, network, token, token_contract, amount_units, from_address, to_address, counterparty_user_id, status, availability, tx_hash, log_index, block_number, final_at, ngn_per_usd, rate_source, rate_as_of)
         VALUES ($1,'out',$2,$3,$4,$5,$6,$7,$8,$9,'final','available',$10,$11,$12,$13,$14,$15,$16) ON CONFLICT DO NOTHING`,
        [sender, 'transfer', network, symbol ?? 'UNKNOWN', t.tokenContract, t.amount.toString(), t.from, t.to, recipient ?? null, t.txHash, t.logIndex, t.blockNumber.toString(), t.blockTime, rate?.ngn_per_usd ?? null, rate?.source ?? null, rate?.as_of ?? null],
      );
    }
  }

  if (recipient) {
    const kind = fromEscrow ? (fromEscrow.payee_user_id === recipient ? 'escrow_payout' : 'escrow_refund') : 'transfer';
    const ins = await q.query(
      `INSERT INTO app.transfers (user_id, direction, kind, network, token, token_contract, amount_units, from_address, to_address, counterparty_user_id, status, availability, tx_hash, log_index, block_number, final_at, payment_id, ngn_per_usd, rate_source, rate_as_of)
       VALUES ($1,'in',$2,$3,$4,$5,$6,$7,$8,$9,'final','pending',$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT DO NOTHING RETURNING *`,
      [recipient, kind, network, symbol ?? 'UNKNOWN', t.tokenContract, t.amount.toString(), t.from, t.to, sender ?? null, t.txHash, t.logIndex, t.blockNumber.toString(), t.blockTime, fromEscrow?.id ?? null, rate?.ngn_per_usd ?? null, rate?.source ?? null, rate?.as_of ?? null],
    );
    if (!ins.rowCount) return; // replay
    const row = ins.rows[0] as TransferRow;
    if (fromEscrow && symbol) {
      // Escrow payouts and refunds come from our own contracts: no inbound check needed.
      await q.query("UPDATE app.transfers SET availability = 'available' WHERE id = $1", [row.id]);
      return;
    }
    // Edge case: a token sent on a pair this address doesn't support (e.g. USDT to the TRON-only address).
    const pairOk = symbol ? (NETWORK_INFO[network].family === 'tron' ? symbol === 'USDT' : network === 'ethereum' || symbol === 'USDC') : true;
    if (symbol && !pairOk) {
      await q.query("UPDATE app.transfers SET availability = 'unsupported_pair' WHERE id = $1", [row.id]);
      await notify(q, { userId: recipient, kind: 'incoming_unsupported', vars: { token: symbol, network: NETWORK_INFO[network].label }, dedupeKey: `unsupported:${row.id}` });
      return;
    }
    // C3-3: inbound check when the transfer reaches finality.
    const r = await inboundCheck(ctx, q, { userId: recipient, network, token: symbol, tokenContract: t.tokenContract, from: t.from, to: t.to, amountUnits: t.amount, txHash: t.txHash });
    await applyInboundDecision(ctx, q, row, r);
    // L1-2: a payment request paid by an external wallet (exact amount, open, same token).
    if (symbol && r.availability !== 'unrecognised') {
      await q.query(
        `UPDATE app.payment_requests SET status = 'paid', paid_transfer_id = $4 WHERE id = (
           SELECT id FROM app.payment_requests WHERE user_id = $1 AND token = $2 AND amount_units = $3 AND status = 'open' AND expires_at > now() ORDER BY created_at LIMIT 1)`,
        [recipient, symbol, t.amount.toString(), row.id],
      );
    }
    // C3-7: re-screen incoming transfers for 30 days.
    await enqueue(q, 'rescreen_transfer', { transferId: row.id, round: 1 }, { runAt: new Date(ctx.now().getTime() + 86_400_000), dedupeKey: `rescreen:${row.id}:1` });
  }
}

// ---------------------------------------------------------------- issuer freezes

export async function handleFreeze(ctx: Ctx, q: Queryable, network: Network, ev: { address: string; frozen: boolean; txHash: string }): Promise<void> {
  const rules = await ctx.versioned.rules();
  const key = addressKey(ev.address);
  if (ev.frozen) {
    await upsertListing(q, { address: ev.address, label: 'issuer_frozen', source: 'issuer_freeze', status: 'confirmed', sourceRef: `${network}:${ev.txHash}`, now: ctx.now(), expiryMonths: rules.fraudList.listingExpiryMonths }).catch(() => undefined);
  } else {
    const l = await maybe<{ id: string }>(q, "SELECT id FROM network.listings WHERE address_key = $1 AND label = 'issuer_frozen' AND status IN ('confirmed','under_appeal')", [key]);
    if (l) await setListingStatus(q, l.id, 'delisted', ctx.now(), `issuer unfreeze ${key}`);
  }
  // Edge case: the issuer blacklists one escrow contract -> that payment is stuck; both parties told; evidence for the issuer.
  const esc = await maybe<PaymentRow>(q, 'SELECT * FROM app.payments WHERE lower(escrow_address) = $1 OR escrow_address = $2', [key, ev.address]);
  if (esc && ev.frozen) {
    await q.query('UPDATE app.payments SET issuer_frozen_at = $2 WHERE id = $1', [esc.id, ctx.now()]);
    await notifyParties(q, esc, 'escrow_issuer_frozen', {}, `escrow-frozen:${esc.id}`);
    await q.query("INSERT INTO network.review_cases (kind, payment_id, due_at) VALUES ('issuer_freeze_escrow', $1, $2)", [esc.id, new Date(ctx.now().getTime() + 86_400_000)]);
    await notifyStaff(q, 'risk_analyst', 'Issuer froze an escrow', `Escrow ${ev.address} for "${esc.title}" was frozen by the issuer. Prepare evidence for the issuer.`, { paymentId: esc.id }, `escrow-frozen:${esc.id}`);
  }
  // D1: a frozen payee of a delivered payment makes UC12 refundFrozenPayee available.
  await q.query('UPDATE app.payments SET payee_frozen = $3 WHERE (lower(payee_address) = $1 OR payee_address = $2) AND status IN (\'funded\',\'delivered\',\'disputed\')', [key, ev.address, ev.frozen]);
}

// ---------------------------------------------------------------- driver

export interface IndexResult {
  network: Network;
  from: bigint;
  to: bigint;
  escrowEvents: number;
  transfers: number;
}

/** Indexes one batch of final blocks for one network. Returns null when already at head. */
export async function indexOnce(ctx: Ctx, network: Network, chain: ChainClient): Promise<IndexResult | null> {
  const cfg = ctx.cfg.chains[network]!;
  const head = await chain.head();
  const last = await cursor(ctx.db, network, 'escrow', cfg.startBlock);
  if (last >= head.final) {
    await saveCursor(ctx.db, network, 'escrow', last, head.final, ctx.now());
    return null;
  }
  const from = last + 1n;
  const to = head.final - from > BATCH_BLOCKS ? from + BATCH_BLOCKS : head.final;
  const known = await many<{ escrow_address: string }>(ctx.db, "SELECT escrow_address FROM app.payments WHERE network = $1 AND escrow_address IS NOT NULL AND status NOT IN ('refunded') AND NOT (status = 'released' AND fee_collected)", [network]);
  const events = cfg.factory ? await chain.escrowEvents(cfg.factory, known.map((k) => k.escrow_address), from, to) : [];
  const walletOwners = await owners(ctx.db, network);
  const byKey = new Map(walletOwners.map((o) => [addressKey(o.address), o.user_id]));
  const watched = walletOwners.map((o) => o.address);
  const transfers: Array<{ token: Token | null; log: TokenTransferLog }> = [];
  for (const sym of TOKENS) {
    const tokenContract = cfg.tokens[sym];
    if (!tokenContract || !watched.length) continue;
    for (const log of await chain.transferLogs(tokenContract, watched, from, to)) transfers.push({ token: sym, log });
  }
  if (chain.anyTokenTransfersTo && watched.length) {
    const canonical = new Set(Object.values(cfg.tokens).filter(Boolean).map((a) => addressKey(a!)));
    for (const log of await chain.anyTokenTransfersTo(watched, from, to)) if (!canonical.has(addressKey(log.tokenContract))) transfers.push({ token: null, log });
  }
  const freezes: Array<{ address: string; frozen: boolean; txHash: string; blockNumber: bigint }> = [];
  for (const sym of TOKENS) {
    const tokenContract = cfg.tokens[sym];
    if (tokenContract) freezes.push(...(await chain.freezeEvents(tokenContract, from, to).catch(() => [])));
  }
  // Apply in block order: escrow events first within a block so payouts are recognised as escrow transfers.
  await tx(ctx.db, async (q) => {
    for (const e of events) await handleEscrowEvent(ctx, q, network, e);
    for (const f of freezes) await handleFreeze(ctx, q, network, f);
    for (const t of transfers.sort((a, b) => (a.log.blockNumber === b.log.blockNumber ? a.log.logIndex - b.log.logIndex : a.log.blockNumber < b.log.blockNumber ? -1 : 1)))
      await handleTransfer(ctx, q, network, t.token, t.log, byKey);
    await saveCursor(q, network, 'escrow', to, head.final, ctx.now());
  });
  return { network, from, to, escrowEvents: events.length, transfers: transfers.length };
}

/** Marks submitted sends confirmed or failed from receipts (status: submitted -> confirmed -> final). */
export async function trackSubmitted(ctx: Ctx, network: Network, chain: ChainClient): Promise<void> {
  const rows = await many<{ id: string; user_id: string; tx_hash: string; amount_units: string; token: string; to_address: string; status: string }>(
    ctx.db,
    "SELECT id, user_id, tx_hash, amount_units, token, to_address, status FROM app.transfers WHERE network = $1 AND direction = 'out' AND status IN ('submitted','confirmed') AND tx_hash IS NOT NULL",
    [network],
  );
  for (const r of rows) {
    const s = await chain.txStatus(r.tx_hash).catch(() => 'unknown' as const);
    if (s === 'success' && r.status === 'submitted') await ctx.db.query("UPDATE app.transfers SET status = 'confirmed', confirmed_at = $2 WHERE id = $1 AND status = 'submitted'", [r.id, ctx.now()]);
    if (s === 'reverted') {
      await tx(ctx.db, async (q) => {
        await q.query("UPDATE app.transfers SET status = 'failed' WHERE id = $1", [r.id]);
        await notify(q, { userId: r.user_id, kind: 'send_failed', vars: { amount: formatUnits(BigInt(r.amount_units)), token: r.token, to: r.to_address }, dedupeKey: `send-failed:${r.id}` });
      });
    }
  }
}

export async function indexAll(ctx: Ctx): Promise<IndexResult[]> {
  const out: IndexResult[] = [];
  for (const [n, chain] of Object.entries(ctx.chains)) {
    const network = n as Network;
    if (!chain) continue;
    const lock = await ctx.db.connect();
    try {
      const got = await lock.query('SELECT pg_try_advisory_lock(733200, $1) AS ok', [Object.keys(NETWORK_INFO).indexOf(network)]);
      if (!got.rows[0].ok) continue;
      try {
        for (let i = 0; i < 20; i++) {
          const r = await indexOnce(ctx, network, chain);
          if (!r) break;
          out.push(r);
        }
        await trackSubmitted(ctx, network, chain);
      } finally {
        await lock.query('SELECT pg_advisory_unlock(733200, $1)', [Object.keys(NETWORK_INFO).indexOf(network)]);
      }
    } finally {
      lock.release();
    }
  }
  return out;
}

export { getPayment };
