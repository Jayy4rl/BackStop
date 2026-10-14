// Versioned rule configuration (PRD "Path to the service layer": rules, thresholds and reason codes
// are versioned data, not app code). The server stores rule sets by version and every check decision
// records which version it used (C3-6). These are the pilot starting values.
import { parseUnits } from './money.ts';

export interface RuleSet {
  version: string;
  presend: {
    /** new_payee_high_amount: first payment above this triggers a warning (user can lower it). */
    defaultNewPayeeThresholdUnits: bigint;
    /** unprotected_stranger: paying a stranger outside escrow above this warns. */
    unprotectedStrangerThresholdUnits: bigint;
    /** C3-1 latency target. */
    p95BudgetMs: number;
  };
  inbound: {
    hopLimit: number;
    maxHopLimit: number;
    holdExposureShare: number; // >= 25% -> hold
    reviewExposureShare: number; // >= 5% -> review
    dustThresholdUnits: bigint; // transfers under $1 ignored
    rescreenDays: number; // C3-7
    reviewSlaBusinessDays: number; // C3-5
  };
  fraudList: {
    listingExpiryMonths: number; // C5-9
    secondAnalystAboveUnits: bigint; // C5-3
    caseDecisionBusinessDays: number; // C5-8
    appealDecisionBusinessDays: number;
    reporterEvidenceBusinessDays: number;
    appealCooldownDays: number;
  };
}

export const DEFAULT_RULES: RuleSet = {
  version: 'rules-2026-10-v1',
  presend: {
    defaultNewPayeeThresholdUnits: parseUnits('500'),
    unprotectedStrangerThresholdUnits: parseUnits('200'),
    p95BudgetMs: 300,
  },
  inbound: {
    hopLimit: 2,
    maxHopLimit: 3,
    holdExposureShare: 0.25,
    reviewExposureShare: 0.05,
    dustThresholdUnits: parseUnits('1'),
    rescreenDays: 30,
    reviewSlaBusinessDays: 1,
  },
  fraudList: {
    listingExpiryMonths: 12,
    secondAnalystAboveUnits: parseUnits('10000'),
    caseDecisionBusinessDays: 2,
    appealDecisionBusinessDays: 5,
    reporterEvidenceBusinessDays: 3,
    appealCooldownDays: 90,
  },
};

/** bigint-safe JSON for storing rule sets. */
export function serializeRules(r: RuleSet): string {
  return JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? { $big: v.toString() } : v));
}

export function deserializeRules(s: string): RuleSet {
  return JSON.parse(s, (_k, v) => (v && typeof v === 'object' && '$big' in v ? BigInt(v.$big) : v)) as RuleSet;
}

/** Tier limits (C1-7, L1-7). Values are configuration to be set with counsel; these are placeholders for the pilot. */
export type Tier = 'none' | 'tier1' | 'tier2' | 'counterparty';

export interface TierLimits {
  perTxUnits: bigint;
  dailyUnits: bigint;
  /** Counterparty: identity document + liveness needed above this amount (C1-4). */
  verificationThresholdUnits?: bigint;
}

export interface LimitConfig {
  version: string;
  tiers: Record<Tier, TierLimits>;
  /** L4-2: merchants with monthly volume above this must be Tier 2. */
  p2pMerchantTier2VolumeUnits: bigint;
  /** L3-7: business second approver above this amount. */
  secondApproverAboveUnits: bigint;
  /** L4-9: P2P cancellations per day before visibility drops. */
  p2pMaxCancellationsPerDay: number;
}

export const DEFAULT_LIMITS: LimitConfig = {
  version: 'limits-2026-10-v1',
  tiers: {
    none: { perTxUnits: 0n, dailyUnits: 0n },
    tier1: { perTxUnits: parseUnits('5000'), dailyUnits: parseUnits('10000') },
    tier2: { perTxUnits: parseUnits('100000'), dailyUnits: parseUnits('250000') },
    counterparty: { perTxUnits: parseUnits('50000'), dailyUnits: parseUnits('100000'), verificationThresholdUnits: parseUnits('1000') },
  },
  p2pMerchantTier2VolumeUnits: parseUnits('20000'),
  secondApproverAboveUnits: parseUnits('25000'),
  p2pMaxCancellationsPerDay: 3,
};
