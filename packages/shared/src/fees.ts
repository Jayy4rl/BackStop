// Fee schedule (PRD "Fees"). Starting prices are hypotheses for the pilot, so they live in versioned
// configuration (the server stores and versions them); these are the v1 defaults.
//
// On-chain the escrow only knows `feeBps` (architecture doc: fee = amount * feeBps / 10_000, charged
// only when money reaches the payee). A dollar cap is therefore applied by lowering feeBps at
// creation so the on-chain fee never exceeds the cap. Refunds carry no fee (decision D5(a)).
import { parseUnits } from './money.ts';

export type Loop = 'L1' | 'L2' | 'L3' | 'L4';

export interface FeeRule {
  bps: number;
  /** Cap in base units, or null for uncapped. */
  capUnits: bigint | null;
  payer: 'sender' | 'freelancer' | 'client' | 'split' | 'importer' | 'seller';
}

export interface FeeSchedule {
  version: string;
  /** L1: free between Backstop users; flat fee on external USDT sends to recover TRON energy. */
  l1ExternalUsdtFlatUnits: bigint;
  l2: FeeRule;
  l3: FeeRule;
  l4: FeeRule;
  /** Hard maximum the factory accepts (architecture doc A5, 500 bps). */
  factoryFeeCapBps: number;
}

export const DEFAULT_FEE_SCHEDULE: FeeSchedule = {
  version: 'fees-2026-10-v1',
  l1ExternalUsdtFlatUnits: parseUnits('1'),
  l2: { bps: 100, capUnits: parseUnits('50'), payer: 'freelancer' },
  l3: { bps: 125, capUnits: parseUnits('500'), payer: 'importer' },
  l4: { bps: 50, capUnits: null, payer: 'seller' },
  factoryFeeCapBps: 500,
};

/** Exactly what the escrow contract computes at release. */
export function onChainFee(amount: bigint, feeBps: number): bigint {
  return (amount * BigInt(feeBps)) / 10_000n;
}

/**
 * Picks the feeBps written into the escrow terms so the on-chain fee is at most `rule.bps` and at
 * most the dollar cap. Returns the bps and the exact fee that will be deducted at release.
 */
export function escrowFeeTerms(amount: bigint, rule: FeeRule): { feeBps: number; feeUnits: bigint } {
  if (amount <= 0n) throw new RangeError('amount must be positive');
  let bps = rule.bps;
  if (rule.capUnits !== null && onChainFee(amount, bps) > rule.capUnits) {
    bps = Number((rule.capUnits * 10_000n) / amount);
  }
  return { feeBps: bps, feeUnits: onChainFee(amount, bps) };
}

export interface FeeQuote {
  loop: Loop;
  amountUnits: bigint;
  feeUnits: bigint;
  feeBps: number;
  /** Who bears the fee; for L2 'split' the client adds half on top. */
  payer: FeeRule['payer'];
  /** What the payee receives on release. */
  payeeReceivesUnits: bigint;
  /** What the payer funds into escrow. */
  payerFundsUnits: bigint;
  onRefund: 'full amount, no fee';
  scheduleVersion: string;
}

/**
 * C4-11 / "All fees appear before the user confirms": the quote shown before funding.
 * L2 can be split with the client: the client funds amount + half the fee so the freelancer bears half.
 */
export function quoteEscrowFee(loop: Exclude<Loop, 'L1'>, amount: bigint, schedule = DEFAULT_FEE_SCHEDULE, splitWithClient = false): FeeQuote {
  const rule = loop === 'L2' ? schedule.l2 : loop === 'L3' ? schedule.l3 : schedule.l4;
  if (loop === 'L2' && splitWithClient) {
    // Client tops up half the fee: escrow amount A' = amount + ceil(fee/2), fee computed on A'.
    const base = escrowFeeTerms(amount, rule);
    const topUp = (base.feeUnits + 1n) / 2n;
    const funded = amount + topUp;
    const t = escrowFeeTerms(funded, rule);
    return {
      loop,
      amountUnits: funded,
      feeUnits: t.feeUnits,
      feeBps: t.feeBps,
      payer: 'split',
      payeeReceivesUnits: funded - t.feeUnits,
      payerFundsUnits: funded,
      onRefund: 'full amount, no fee',
      scheduleVersion: schedule.version,
    };
  }
  const t = escrowFeeTerms(amount, rule);
  return {
    loop,
    amountUnits: amount,
    feeUnits: t.feeUnits,
    feeBps: t.feeBps,
    payer: rule.payer,
    payeeReceivesUnits: amount - t.feeUnits,
    payerFundsUnits: amount,
    onRefund: 'full amount, no fee',
    scheduleVersion: schedule.version,
  };
}

/** L1 send fee: free between Backstop users; flat fee on external USDT (TRON energy recovery). */
export function quoteSendFee(opts: { internal: boolean; token: 'USDT' | 'USDC' }, schedule = DEFAULT_FEE_SCHEDULE): bigint {
  if (opts.internal) return 0n;
  return opts.token === 'USDT' ? schedule.l1ExternalUsdtFlatUnits : 0n;
}
