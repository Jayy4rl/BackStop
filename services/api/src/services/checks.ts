// C3 safety checks. Both are rule-based so every outcome can be explained in an appeal. Each check
// first gathers its facts (list standing, labels, history, chain lookups, exposure trace), then a
// pure rule evaluation turns facts into a decision. The facts, list version and rule version are
// stored with the decision, so a reviewer can replay it exactly (C3-6).
// Pre-send must answer within p95 300 ms (C3-1): chain lookups have a hard time budget and when
// they miss it the check degrades to direct-list matching with a visible notice (NFR Availability).
import {
  addressKey,
  CANONICAL_TOKENS,
  checkAddressForNetwork,
  explainReason,
  formatUnits,
  isLookalike,
  isSupportedPair,
  matchNames,
  NETWORK_INFO,
  PRESEND_SEVERITY,
  type InboundDecision,
  type InboundReason,
  type Network,
  type PresendDecision,
  type PresendReason,
  type RuleSet,
  type Token,
} from '@backstop/shared';
import type { Ctx } from '../ctx.ts';
import { maybe, many, one, type Queryable } from '../db/pool.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { addressStanding, labelOf, listVersion } from './fraudlist.ts';

export interface ReasonOut {
  code: PresendReason | InboundReason;
  severity: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------- helpers

const contractCache = new Map<string, { at: number; v: boolean }>();
const CONTRACT_TTL_MS = 10 * 60_000;
export const CHAIN_BUDGET_MS = 150;

async function withBudget<T>(p: Promise<T>, ms: number): Promise<{ ok: true; v: T } | { ok: false }> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ ok: false }>((res) => (t = setTimeout(() => res({ ok: false }), ms)));
  try {
    return await Promise.race([p.then((v) => ({ ok: true as const, v })).catch(() => ({ ok: false as const })), timeout]);
  } finally {
    clearTimeout(t);
  }
}

/** Token contracts configured for any network are never valid recipients. */
export function canonicalTokenContracts(ctx: Ctx): Set<string> {
  const s = new Set<string>();
  for (const table of [CANONICAL_TOKENS.mainnet, CANONICAL_TOKENS.testnet]) for (const a of Object.values(table)) if (a) s.add(addressKey(a));
  for (const c of Object.values(ctx.cfg.chains)) for (const a of Object.values(c?.tokens ?? {})) if (a) s.add(addressKey(a));
  return s;
}

export function canonicalTokenFor(ctx: Ctx, network: Network, token: Token): string | null {
  const configured = ctx.cfg.chains[network]?.tokens[token];
  if (configured) return configured;
  const table = ctx.cfg.env === 'production' ? CANONICAL_TOKENS.mainnet : CANONICAL_TOKENS.testnet;
  return table[`${network}:${token}`] ?? null;
}

/** Which network:token pairs a Backstop user's addresses accept (C2-4). */
export function backstopAccepts(network: Network, token: Token): boolean {
  if (network === 'tron') return token === 'USDT';
  if (network === 'ethereum') return token === 'USDC' || token === 'USDT';
  return token === 'USDC';
}

function safeKey(a: string): string {
  try {
    return addressKey(a);
  } catch {
    return a;
  }
}

function safeLookalike(a: string, b: string): boolean {
  try {
    return isLookalike(a, b);
  } catch {
    return false;
  }
}

async function storeDecision(
  q: Queryable,
  d: { kind: 'presend' | 'inbound'; userId: string | null; subject: string; inputs: unknown; decision: string; reasons: ReasonOut[]; listVersion: bigint; ruleVersion: string; degraded: boolean; latencyMs: number; supersedes?: string | null },
): Promise<string> {
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO network.check_decisions (kind, user_id, subject, inputs, decision, reasons, list_version, rule_version, degraded, latency_ms, supersedes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [d.kind, d.userId, d.subject, JSON.stringify(d.inputs, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), d.decision, JSON.stringify(d.reasons), d.listVersion.toString(), d.ruleVersion, d.degraded, d.latencyMs, d.supersedes ?? null],
  );
  return r.id;
}

// ---------------------------------------------------------------- pre-send (allow / warn / block)

export interface PresendInput {
  userId: string;
  recipientUserId?: string | null;
  address: string;
  network: Network;
  token: Token;
  amountUnits: bigint;
  typedName?: string | null;
  /** True when the payment goes into escrow (protected). */
  protectedPayment: boolean;
}

/** Everything the pre-send rules look at; stored verbatim with the decision. */
export interface PresendFacts {
  input: Omit<PresendInput, 'amountUnits'> & { amountUnits: string };
  formatValid: boolean;
  formatReason: string | null;
  pairSupported: boolean;
  normalizedAddress: string | null;
  listing: { confirmed: { id: string; label: string } | null; reportedOrAppeal: { id: string; status: string } | null };
  isTokenContract: boolean;
  /** null when the lookup was skipped (degraded) or not needed. */
  isContract: boolean | null;
  degraded: boolean;
  recipientIsBackstop: boolean;
  recipientAddressFamily: 'tron' | 'evm' | null;
  label: { name: string; kind: string; accepts: string[] } | null;
  paidBefore: boolean;
  isContact: boolean;
  lookalikeOf: string | null;
  recipientVerifiedName: string | null;
  newPayeeThresholdUnits: string;
}

export function evaluatePresend(f: PresendFacts, rules: RuleSet): { decision: PresendDecision; reasons: ReasonOut[] } {
  const reasons: ReasonOut[] = [];
  const add = (code: PresendReason, vars: Record<string, string | number> = {}, data?: Record<string, unknown>) => {
    const e = explainReason(code, vars);
    reasons.push({ code, severity: PRESEND_SEVERITY[code], title: e.title, body: e.body, data });
  };
  const i = f.input;
  const netLabel = NETWORK_INFO[i.network].label;
  const amount = BigInt(i.amountUnits);
  if (!f.formatValid || !f.pairSupported) {
    add('invalid_address', { network: netLabel }, { reason: f.formatValid ? 'unsupported_pair' : f.formatReason });
  } else {
    if (f.listing.confirmed) add('recipient_confirmed_fraud', {}, { listingId: f.listing.confirmed.id, label: f.listing.confirmed.label });
    else if (f.listing.reportedOrAppeal) add('recipient_under_review', {}, { listingId: f.listing.reportedOrAppeal.id });
    if (f.isTokenContract || f.isContract) add('contract_recipient', { token: i.token });
    if (f.recipientIsBackstop) {
      const ok = f.recipientAddressFamily === 'tron' ? i.network === 'tron' && i.token === 'USDT' : i.network !== 'tron' && backstopAccepts(i.network, i.token);
      if (!ok) add('network_not_accepted', { token: i.token, network: netLabel });
    } else if (f.label && f.label.accepts.length && !f.label.accepts.includes(`${i.network}:${i.token}`)) {
      add('network_not_accepted', { token: i.token, network: netLabel }, { service: f.label.name });
    }
    if (f.lookalikeOf) add('lookalike_address', { similar: f.lookalikeOf }, { similar: f.lookalikeOf });
    if (f.recipientVerifiedName && i.typedName && matchNames(i.typedName, f.recipientVerifiedName) === 'none') add('name_mismatch', { typedName: i.typedName, verifiedName: f.recipientVerifiedName });
    const threshold = BigInt(f.newPayeeThresholdUnits);
    if (!f.paidBefore && amount > threshold) add('new_payee_high_amount', { amount: `$${formatUnits(amount)}`, threshold: `$${formatUnits(threshold)}` });
    const stranger = !f.paidBefore && !f.isContact && !f.label;
    if (stranger && !i.protectedPayment && amount > rules.presend.unprotectedStrangerThresholdUnits) add('unprotected_stranger', { threshold: `$${formatUnits(rules.presend.unprotectedStrangerThresholdUnits)}` });
    if (!f.recipientIsBackstop && !f.label && !f.isTokenContract && !f.isContract) add('support_unknown', { token: i.token, network: netLabel });
  }
  const decision: PresendDecision = reasons.some((r) => r.severity === 'block') ? 'block' : reasons.length ? 'warn' : 'allow';
  return { decision, reasons };
}

async function gatherPresendFacts(ctx: Ctx, q: Queryable, input: PresendInput, rules: RuleSet): Promise<PresendFacts> {
  const fmt = checkAddressForNetwork(input.address, input.network);
  const base: PresendFacts = {
    input: { ...input, amountUnits: input.amountUnits.toString() },
    formatValid: fmt.valid,
    formatReason: fmt.valid ? null : fmt.reason,
    pairSupported: isSupportedPair(input.network, input.token),
    normalizedAddress: fmt.valid ? fmt.normalized : null,
    listing: { confirmed: null, reportedOrAppeal: null },
    isTokenContract: false,
    isContract: null,
    degraded: false,
    recipientIsBackstop: false,
    recipientAddressFamily: null,
    label: null,
    paidBefore: false,
    isContact: false,
    lookalikeOf: null,
    recipientVerifiedName: null,
    newPayeeThresholdUnits: rules.presend.defaultNewPayeeThresholdUnits.toString(),
  };
  if (!fmt.valid || !base.pairSupported) return base;
  const key = addressKey(fmt.normalized);

  const standing = await addressStanding(q, key);
  if (standing.confirmed) base.listing.confirmed = { id: standing.confirmed.id, label: standing.confirmed.label };
  const ra = standing.reported ?? standing.underAppeal;
  if (ra) base.listing.reportedOrAppeal = { id: ra.id, status: ra.status };

  const label = await labelOf(q, key);
  if (label) base.label = { name: label.name, kind: label.kind, accepts: label.accepts };
  const recipientWallet = input.recipientUserId
    ? await maybe<{ user_id: string; evm_address: string; tron_address: string }>(q, 'SELECT user_id, evm_address, tron_address FROM app.wallets WHERE user_id = $1', [input.recipientUserId])
    : await maybe<{ user_id: string; evm_address: string; tron_address: string }>(q, 'SELECT user_id, evm_address, tron_address FROM app.wallets WHERE lower(evm_address) = $1 OR tron_address = $2', [key, fmt.normalized]);
  if (recipientWallet) {
    base.recipientIsBackstop = true;
    base.recipientAddressFamily = recipientWallet.tron_address === fmt.normalized ? 'tron' : 'evm';
  }
  base.isTokenContract = canonicalTokenContracts(ctx).has(key) || label?.kind === 'token_contract';
  if (!base.isTokenContract && !recipientWallet && !label) {
    const chain = ctx.chains[input.network];
    const hit = contractCache.get(`${input.network}:${key}`);
    if (hit && Date.now() - hit.at < CONTRACT_TTL_MS) base.isContract = hit.v;
    else if (chain) {
      const r = await withBudget(chain.isContract(fmt.normalized), CHAIN_BUDGET_MS);
      if (r.ok) {
        base.isContract = r.v;
        contractCache.set(`${input.network}:${key}`, { at: Date.now(), v: r.v });
      } else base.degraded = true;
    } else base.degraded = true;
  }

  const history = await many<{ to_address: string | null; counterparty_user_id: string | null }>(
    q,
    "SELECT DISTINCT to_address, counterparty_user_id FROM app.transfers WHERE user_id = $1 AND direction = 'out' AND status IN ('confirmed','final')",
    [input.userId],
  );
  const contacts = await many<{ address: string | null; recipient_user_id: string | null }>(q, 'SELECT address, recipient_user_id FROM app.contacts WHERE owner_id = $1', [input.userId]);
  const recipientUserId = input.recipientUserId ?? recipientWallet?.user_id ?? null;
  base.paidBefore = history.some((h) => (h.to_address && safeKey(h.to_address) === key) || (!!recipientUserId && h.counterparty_user_id === recipientUserId));
  base.isContact = contacts.some((c) => (c.address && safeKey(c.address) === key) || (!!recipientUserId && c.recipient_user_id === recipientUserId));
  const known = [...history.map((h) => h.to_address), ...contacts.map((c) => c.address)].filter((a): a is string => !!a);
  base.lookalikeOf = known.find((a) => safeKey(a) !== key && safeLookalike(a, fmt.normalized)) ?? null;
  if (recipientUserId) {
    const r = await maybe<{ verified_name: string | null; display_name: string | null }>(q, 'SELECT verified_name, display_name FROM app.users WHERE id = $1', [recipientUserId]);
    base.recipientVerifiedName = r?.verified_name ?? r?.display_name ?? null;
  }
  const u = await one<{ new_payee_threshold_units: string | null }>(q, 'SELECT new_payee_threshold_units FROM app.users WHERE id = $1', [input.userId]);
  if (u.new_payee_threshold_units) base.newPayeeThresholdUnits = BigInt(u.new_payee_threshold_units).toString();
  return base;
}

export interface PresendResult {
  decisionId: string;
  decision: PresendDecision;
  reasons: ReasonOut[];
  degraded: boolean;
  degradedNotice: string | null;
  listVersion: string;
  ruleVersion: string;
  /** For `unprotected_stranger`: the client can offer a one-tap switch to a protected payment. */
  offerProtectedSwitch: boolean;
  latencyMs: number;
}

export async function presendCheck(ctx: Ctx, q: Queryable, input: PresendInput): Promise<PresendResult> {
  const started = performance.now();
  const rules = await ctx.versioned.rules();
  const lv = await listVersion(q);
  const facts = await gatherPresendFacts(ctx, q, input, rules);
  const { decision, reasons } = evaluatePresend(facts, rules);
  const latencyMs = Math.round(performance.now() - started);
  const decisionId = await storeDecision(q, { kind: 'presend', userId: input.userId, subject: input.address, inputs: facts, decision, reasons, listVersion: lv, ruleVersion: rules.version, degraded: facts.degraded, latencyMs });
  return {
    decisionId,
    decision,
    reasons,
    degraded: facts.degraded,
    degradedNotice: facts.degraded ? 'Some safety checks are slow right now, so only the fraud list was checked for this address. Double-check the recipient.' : null,
    listVersion: lv.toString(),
    ruleVersion: rules.version,
    offerProtectedSwitch: reasons.some((r) => r.code === 'unprotected_stranger'),
    latencyMs,
  };
}

/** C3-2: warn may be overridden after the user reads and confirms; block never; every override is logged. */
export async function recordOverride(q: Queryable, decisionId: string, userId: string, acknowledged: string[], now: Date): Promise<void> {
  const d = await maybe<{ user_id: string; decision: string; reasons: ReasonOut[]; overridden_at: Date | null }>(q, 'SELECT * FROM network.check_decisions WHERE id = $1', [decisionId]);
  if (!d || d.user_id !== userId) throw notFound('Check not found.');
  if (d.decision === 'block') throw forbidden('blocked', 'This payment is blocked and cannot be sent.');
  if (d.decision !== 'warn' || d.overridden_at) return;
  if (!d.reasons.every((r) => acknowledged.includes(r.code))) throw badRequest('ack_required', 'Read and confirm every warning first.');
  await q.query('UPDATE network.check_decisions SET overridden_at = $2, override_ack = $3 WHERE id = $1', [decisionId, now, JSON.stringify(acknowledged)]);
}

// ---------------------------------------------------------------- inbound (allow / review / hold)

export interface InboundInput {
  userId: string | null;
  network: Network;
  token: Token | null;
  tokenContract: string;
  from: string;
  to: string;
  amountUnits: bigint;
  txHash?: string;
  /** Re-screen of an earlier decision (C3-7). */
  supersedes?: string | null;
}

export interface TraceNode {
  address: string;
  share: number;
  depth: number;
  listed?: string;
  stoppedAt?: string;
}

export interface InboundFacts {
  input: Omit<InboundInput, 'amountUnits'> & { amountUnits: string };
  canonicalToken: boolean;
  senderListing: { confirmed: { id: string; label: string } | null; reportedOrAppeal: { id: string; status: string } | null };
  issuerFrozen: boolean;
  exposure: number | null;
  trace: TraceNode[];
}

export type Availability = 'available' | 'on_hold' | 'under_review' | 'unrecognised' | 'dust_hidden';

export function evaluateInbound(f: InboundFacts, rules: RuleSet): { decision: InboundDecision; reasons: ReasonOut[]; availability: Availability } {
  const reasons: ReasonOut[] = [];
  const add = (code: InboundReason, severity: 'hold' | 'review', vars: Record<string, string | number> = {}, data?: Record<string, unknown>) => {
    const e = explainReason(code, vars);
    reasons.push({ code, severity, title: e.title, body: e.body, data });
  };
  const token = f.input.token ?? 'stablecoin';
  if (!f.canonicalToken) {
    // A fake token with a stablecoin's symbol: unrecognised, not counted, never usable in escrow.
    add('token_not_canonical', 'hold', { token });
    return { decision: 'hold', reasons, availability: 'unrecognised' };
  }
  const isDust = BigInt(f.input.amountUnits) < rules.inbound.dustThresholdUnits;
  if (isDust && (f.senderListing.confirmed || f.senderListing.reportedOrAppeal)) {
    // Dust from a listed address: ignored, never grounds to list the recipient, hidden from balance.
    return { decision: 'allow', reasons, availability: 'dust_hidden' };
  }
  if (f.senderListing.confirmed) {
    if (f.senderListing.confirmed.label === 'issuer_frozen') add('issuer_frozen', 'hold', { token });
    else add('sender_confirmed_fraud', 'hold', {}, { listingId: f.senderListing.confirmed.id, label: f.senderListing.confirmed.label });
  } else {
    if (f.issuerFrozen) add('issuer_frozen', 'hold', { token });
    if (f.senderListing.reportedOrAppeal) add('sender_reported', 'review', {}, { listingId: f.senderListing.reportedOrAppeal.id });
    if (f.exposure !== null) {
      const pct = Math.round(f.exposure * 1000) / 10;
      if (f.exposure >= rules.inbound.holdExposureShare)
        add('indirect_exposure', 'hold', { share: pct, hops: rules.inbound.hopLimit, consequence: 'The funds are on hold. You can appeal to a risk analyst.' }, { exposure: f.exposure });
      else if (f.exposure >= rules.inbound.reviewExposureShare)
        add('indirect_exposure', 'review', { share: pct, hops: rules.inbound.hopLimit, consequence: 'A risk analyst will review it within 1 business day.' }, { exposure: f.exposure });
    }
  }
  const availability: Availability = reasons.some((r) => r.severity === 'hold') ? 'on_hold' : reasons.length ? 'under_review' : 'available';
  return { decision: availability === 'on_hold' ? 'hold' : availability === 'under_review' ? 'review' : 'allow', reasons, availability };
}

/** Share of `address`'s incoming value that traces to confirmed fraud within the hop limit. */
export async function traceExposure(ctx: Ctx, q: Queryable, network: Network, tokenContract: string, address: string, rules: RuleSet): Promise<{ share: number; trace: TraceNode[] }> {
  const chain = ctx.chains[network];
  const hopLimit = Math.min(rules.inbound.hopLimit, rules.inbound.maxHopLimit);
  const trace: TraceNode[] = [];
  const memo = new Map<string, number>();
  const tokenKey = addressKey(tokenContract);

  async function incoming(addr: string) {
    const k = addressKey(addr);
    let rows = await many<{ from_key: string; amount_units: string }>(q, 'SELECT from_key, amount_units FROM network.chain_transfers WHERE network = $1 AND to_key = $2 AND token_contract = $3', [network, k, tokenKey]);
    if (!rows.length && chain) {
      const fetched = await chain.incomingTransfers(tokenContract, addr, 50).catch(() => []);
      for (const t of fetched) {
        await q.query(
          `INSERT INTO network.chain_transfers (network, tx_hash, log_index, token_contract, from_key, to_key, amount_units, block_number, block_time)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
          [network, t.txHash, t.logIndex, tokenKey, addressKey(t.from), addressKey(t.to), t.amount.toString(), t.blockNumber.toString(), t.blockTime],
        );
      }
      rows = fetched.map((t) => ({ from_key: addressKey(t.from), amount_units: t.amount.toString() }));
    }
    // Transfers under the dust threshold are ignored so dusting can't taint a user.
    return rows.filter((r) => BigInt(r.amount_units) >= rules.inbound.dustThresholdUnits);
  }

  async function exposure(addr: string, depth: number, path: Set<string>): Promise<number> {
    const k = addressKey(addr);
    if (memo.has(`${k}:${depth}`)) return memo.get(`${k}:${depth}`)!;
    if (depth > 0) {
      const standing = await addressStanding(q, k);
      if (standing.confirmed) {
        trace.push({ address: addr, share: 1, depth, listed: standing.confirmed.label });
        return 1;
      }
    }
    const lab = await labelOf(q, k);
    if (lab && (lab.kind === 'exchange' || lab.kind === 'bridge')) {
      // Tracing stops at labelled exchange hot wallets and bridges.
      trace.push({ address: addr, share: 0, depth, stoppedAt: `${lab.kind}: ${lab.name}` });
      return 0;
    }
    if (depth >= hopLimit) return 0;
    const ins = (await incoming(addr))
      .filter((r) => !path.has(r.from_key))
      .sort((a, b) => (BigInt(b.amount_units) > BigInt(a.amount_units) ? 1 : -1))
      .slice(0, 20);
    const total = ins.reduce((s, r) => s + BigInt(r.amount_units), 0n);
    if (total === 0n) return 0;
    let share = 0;
    for (const r of ins) {
      const weight = Number((BigInt(r.amount_units) * 1_000_000n) / total) / 1_000_000;
      const e = await exposure(r.from_key, depth + 1, new Set([...path, r.from_key]));
      if (e > 0 && !trace.some((t) => t.address === r.from_key && t.depth === depth + 1)) trace.push({ address: r.from_key, share: weight * e, depth: depth + 1 });
      share += weight * e;
    }
    memo.set(`${k}:${depth}`, share);
    return share;
  }

  const share = await exposure(address, 0, new Set([addressKey(address)]));
  return { share, trace };
}

export interface InboundResult {
  decisionId: string;
  decision: InboundDecision;
  reasons: ReasonOut[];
  availability: Availability;
  exposure: number;
  trace: TraceNode[];
  listVersion: string;
  ruleVersion: string;
}

export async function inboundCheck(ctx: Ctx, q: Queryable, input: InboundInput): Promise<InboundResult> {
  const started = performance.now();
  const rules = await ctx.versioned.rules();
  const lv = await listVersion(q);
  const canonical = input.token ? canonicalTokenFor(ctx, input.network, input.token) : null;
  const facts: InboundFacts = {
    input: { ...input, amountUnits: input.amountUnits.toString() },
    canonicalToken: !!canonical && addressKey(canonical) === addressKey(input.tokenContract),
    senderListing: { confirmed: null, reportedOrAppeal: null },
    issuerFrozen: false,
    exposure: null,
    trace: [],
  };
  if (facts.canonicalToken) {
    const standing = await addressStanding(q, addressKey(input.from));
    if (standing.confirmed) facts.senderListing.confirmed = { id: standing.confirmed.id, label: standing.confirmed.label };
    const ra = standing.reported ?? standing.underAppeal;
    if (ra) facts.senderListing.reportedOrAppeal = { id: ra.id, status: ra.status };
    const isDust = input.amountUnits < rules.inbound.dustThresholdUnits;
    if (!standing.confirmed && !(isDust && ra)) {
      const chain = ctx.chains[input.network];
      facts.issuerFrozen = chain ? await chain.isFrozen(input.tokenContract, input.from).catch(() => false) : false;
      if (!isDust) {
        const t = await traceExposure(ctx, q, input.network, input.tokenContract, input.from, rules);
        facts.exposure = t.share;
        facts.trace = t.trace;
      }
    }
  }
  const { decision, reasons, availability } = evaluateInbound(facts, rules);
  const latencyMs = Math.round(performance.now() - started);
  const decisionId = await storeDecision(q, { kind: 'inbound', userId: input.userId, subject: input.from, inputs: facts, decision, reasons, listVersion: lv, ruleVersion: rules.version, degraded: false, latencyMs, supersedes: input.supersedes });
  return { decisionId, decision, reasons, availability, exposure: facts.exposure ?? 0, trace: facts.trace, listVersion: lv.toString(), ruleVersion: rules.version };
}

/**
 * C3-3 for counterparties paying into escrow or a P2P trade: checks the paying address itself
 * before its funds enter escrow (the contract cannot hold funds back once they arrive).
 */
export async function counterpartyFundsCheck(ctx: Ctx, q: Queryable, p: { userId: string | null; network: Network; token: Token; payer: string; amountUnits: bigint }): Promise<InboundResult> {
  const tokenContract = canonicalTokenFor(ctx, p.network, p.token);
  if (!tokenContract) throw badRequest('network_unavailable', `${p.token} is not available on ${NETWORK_INFO[p.network].label}.`);
  return inboundCheck(ctx, q, { userId: p.userId, network: p.network, token: p.token, tokenContract, from: p.payer, to: p.payer, amountUnits: p.amountUnits });
}

/** C3-6 replay: re-evaluates stored facts under the recorded rule version. */
export async function replayDecision(ctx: Ctx, q: Queryable, id: string) {
  const d = await maybe<{ kind: 'presend' | 'inbound'; inputs: unknown; decision: string; reasons: ReasonOut[]; rule_version: string; list_version: string }>(q, 'SELECT * FROM network.check_decisions WHERE id = $1', [id]);
  if (!d) throw notFound('Decision not found.');
  const rules = await ctx.versioned.byVersion<RuleSet>('rules', d.rule_version);
  if (!rules) throw notFound(`Rule version ${d.rule_version} not found.`);
  const r = d.kind === 'presend' ? evaluatePresend(d.inputs as PresendFacts, rules) : evaluateInbound(d.inputs as InboundFacts, rules);
  return {
    id,
    kind: d.kind,
    ruleVersion: d.rule_version,
    listVersion: String(d.list_version),
    recorded: { decision: d.decision, reasons: d.reasons.map((x) => x.code) },
    replayed: { decision: r.decision, reasons: r.reasons.map((x) => x.code) },
    matches: r.decision === d.decision && JSON.stringify(r.reasons.map((x) => x.code)) === JSON.stringify(d.reasons.map((x) => x.code)),
    facts: d.inputs,
  };
}
