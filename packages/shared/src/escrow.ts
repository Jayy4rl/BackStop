// Protected payment model shared by L2, L3 and L4 (PRD C4; Escrow Contract Architecture).
import { encodeAbiParameters, keccak256, stringToHex, type Hex } from 'viem';

/** Mirrors `enum State` in contracts/src/Types.sol. */
export enum OnChainState {
  None = 0,
  Funded = 1,
  Delivered = 2,
  Disputed = 3,
  Released = 4,
  Refunded = 5,
}

/**
 * Product lifecycle (PRD: 6 states). `created` and `cancelled` are off-chain only: an escrow
 * contract exists only once it is funded (architecture doc).
 */
export type PaymentStatus = 'created' | 'cancelled' | 'funded' | 'delivered' | 'disputed' | 'released' | 'refunded';

export function statusFromChain(s: OnChainState): PaymentStatus {
  switch (s) {
    case OnChainState.Funded:
      return 'funded';
    case OnChainState.Delivered:
      return 'delivered';
    case OnChainState.Disputed:
      return 'disputed';
    case OnChainState.Released:
      return 'released';
    case OnChainState.Refunded:
      return 'refunded';
    default:
      return 'created';
  }
}

export const TERMINAL_STATUSES: PaymentStatus[] = ['released', 'refunded', 'cancelled'];

export const DAY = 86_400;
export const HOUR = 3_600;

export type EscrowLoop = 'L2' | 'L3' | 'L4';

/** How each loop fills the terms (architecture doc, "How each loop fills the terms"). */
export interface LoopTermDefaults {
  holdPeriod: number; // seconds
  autoRelease: boolean;
  arbiterTimeout: number; // seconds
  /** Business days both sides get to upload evidence after a dispute (C4-8); L4 uses hours. */
  evidenceWindow: { businessDays?: number; hours?: number };
  /** Ruling target (PRD rules per loop). */
  rulingTarget: { businessDays?: number; hours?: number };
}

export const LOOP_TERMS: Record<EscrowLoop, LoopTermDefaults> = {
  L2: { holdPeriod: 7 * DAY, autoRelease: true, arbiterTimeout: 30 * DAY, evidenceWindow: { businessDays: 3 }, rulingTarget: { businessDays: 5 } },
  L3: { holdPeriod: 14 * DAY, autoRelease: true, arbiterTimeout: 30 * DAY, evidenceWindow: { businessDays: 3 }, rulingTarget: { businessDays: 5 } },
  L4: { holdPeriod: 0, autoRelease: false, arbiterTimeout: 3 * DAY, evidenceWindow: { hours: 2 }, rulingTarget: { hours: 24 } },
};

/** C4-5: a payment not funded within 72 hours of creation is cancelled. */
export const FUNDING_WINDOW_SECONDS = 72 * HOUR;
/** L4 default payment window. */
export const P2P_DEFAULT_PAYMENT_WINDOW_SECONDS = 30 * 60;
/** L2-5: reminders to the client 72 and 24 hours before auto-release. */
export const AUTO_RELEASE_REMINDERS_SECONDS = [72 * HOUR, 24 * HOUR];
/** C4-7: warn the payer 24 hours before the dispute window closes. */
export const DISPUTE_EXPIRY_WARNING_SECONDS = 24 * HOUR;
/** D2(c): alert staff well before an arbiter timeout would refund automatically. */
export const ARBITER_TIMEOUT_ALERT_FRACTION = 0.5;

/** Terms struct as encoded on-chain (contracts/src/Types.sol). */
export interface EscrowTerms {
  payer: Hex;
  payee: Hex;
  token: Hex;
  amount: bigint;
  feeBps: number;
  deliverBy: bigint;
  holdPeriod: number;
  autoRelease: boolean;
  arbiterTimeout: number;
  orderRef: Hex;
}

/**
 * orderRef: hash of the off-chain order, also the CREATE2 salt, so the same order can't be funded
 * twice (I9). Includes the tenant so the network can later serve other apps without collisions.
 */
export function orderRefFor(tenantId: number, paymentId: string): Hex {
  return keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'uint256' }, { type: 'string' }], ['backstop.escrow.v1', BigInt(tenantId), paymentId]));
}

/** Hash written on-chain for evidence bundles and ruling documents (C4-8). */
export function contentHash(content: string | Uint8Array): Hex {
  return keccak256(typeof content === 'string' ? stringToHex(content) : content);
}

export type EscrowAction =
  | 'markDelivered'
  | 'release'
  | 'releaseAfterHold'
  | 'dispute'
  | 'resolveRelease'
  | 'resolveRefund'
  | 'refundByPayee'
  | 'reclaimAfterDeadline'
  | 'refundAfterArbiterTimeout'
  | 'collectFee'
  | 'refundFrozenPayee'
  | 'returnExcess';

export interface EscrowView {
  status: PaymentStatus;
  deliverBy: number; // unix seconds
  holdUntil: number | null;
  disputedAt: number | null;
  autoRelease: boolean;
  arbiterTimeout: number;
  feeOwed: bigint;
  feeCollected: boolean;
  /** Issuer freeze status of the payee, when the token has a freeze adapter (UC12, D1(b)). */
  payeeFrozen?: boolean;
}

export type Role = 'payer' | 'payee' | 'arbiter' | 'anyone';

/**
 * Which contract functions a role may call now. Mirrors the guards in contracts/src/Escrow.sol so
 * the app only shows buttons that will succeed (the contract remains the authority).
 */
export function allowedActions(v: EscrowView, role: Role, now: number): EscrowAction[] {
  const out: EscrowAction[] = [];
  const s = v.status;
  const arbiterOpen = v.disputedAt !== null && now < v.disputedAt + v.arbiterTimeout;
  if (role === 'payee') {
    if (s === 'funded' && now <= v.deliverBy) out.push('markDelivered');
    if (s === 'funded' && now <= v.deliverBy) out.push('dispute'); // D4(b)
    if (s === 'delivered' && (!v.autoRelease || (v.holdUntil !== null && now < v.holdUntil))) out.push('dispute');
    if (s === 'funded' || s === 'delivered' || s === 'disputed') out.push('refundByPayee');
  }
  if (role === 'payer') {
    if (s === 'delivered' || s === 'disputed') out.push('release');
    if (s === 'funded') out.push('dispute');
    if (s === 'delivered' && (!v.autoRelease || (v.holdUntil !== null && now < v.holdUntil))) out.push('dispute');
    if (s === 'funded' && now > v.deliverBy) out.push('reclaimAfterDeadline');
  }
  if (role === 'arbiter' && s === 'disputed' && arbiterOpen) out.push('resolveRelease', 'resolveRefund');
  // Anyone (including keeper and payee as fallback, C4-6):
  if (s === 'delivered' && v.autoRelease && v.holdUntil !== null && now >= v.holdUntil) out.push('releaseAfterHold');
  if (s === 'disputed' && v.disputedAt !== null && !arbiterOpen) out.push('refundAfterArbiterTimeout');
  if (s === 'released' && v.feeOwed > 0n && !v.feeCollected) out.push('collectFee');
  if (s === 'delivered' && v.payeeFrozen) out.push('refundFrozenPayee');
  return [...new Set(out)];
}

/** C4-7: last moment a dispute is accepted (null when the hold has not started or has no end). */
export function disputeDeadline(v: EscrowView): number | null {
  if (v.status === 'funded') return v.deliverBy;
  if (v.status === 'delivered' && v.autoRelease) return v.holdUntil;
  return null;
}
