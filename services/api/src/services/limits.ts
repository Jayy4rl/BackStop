// C1-7 / L1-7: per-transaction and daily limits by tier, from versioned configuration, shown in the
// app before a user hits them. "Daily" is the calendar day in Lagos.
import { formatUnits, type Tier } from '@backstop/shared';
import type { Ctx } from '../ctx.ts';
import type { Queryable } from '../db/pool.ts';
import { forbidden } from '../lib/errors.ts';

function lagosDayStart(now: Date): Date {
  const l = new Date(now.getTime() + 3600_000);
  return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()) - 3600_000);
}

export async function usedToday(ctx: Ctx, q: Queryable, userId: string): Promise<bigint> {
  const since = lagosDayStart(ctx.now());
  const r = await q.query(
    `SELECT coalesce((SELECT sum(amount_units) FROM app.transfers
                       WHERE user_id = $1 AND direction = 'out' AND kind = 'transfer' AND status NOT IN ('failed','dropped') AND created_at >= $2), 0)
          + coalesce((SELECT sum(amount_units) FROM app.payments
                       WHERE payer_user_id = $1 AND funded_at >= $2), 0) AS used`,
    [userId, since],
  );
  return BigInt(r.rows[0].used as string);
}

export async function limitsView(ctx: Ctx, q: Queryable, userId: string, tier: Tier) {
  const cfg = await ctx.versioned.limits();
  const l = cfg.tiers[tier];
  const used = await usedToday(ctx, q, userId);
  const remaining = l.dailyUnits > used ? l.dailyUnits - used : 0n;
  return {
    version: cfg.version,
    tier,
    perTransaction: formatUnits(l.perTxUnits),
    daily: formatUnits(l.dailyUnits),
    usedToday: formatUnits(used),
    remainingToday: formatUnits(remaining),
    counterpartyVerificationThreshold: l.verificationThresholdUnits !== undefined ? formatUnits(l.verificationThresholdUnits) : null,
    resetsAt: new Date(lagosDayStart(ctx.now()).getTime() + 86_400_000).toISOString(),
  };
}

export async function assertWithinLimits(ctx: Ctx, q: Queryable, userId: string, tier: Tier, amount: bigint): Promise<void> {
  const cfg = await ctx.versioned.limits();
  const l = cfg.tiers[tier];
  if (l.perTxUnits === 0n) throw forbidden('tier_required', 'Verify your identity to move money.', { tier });
  if (amount > l.perTxUnits) throw forbidden('limit_per_tx', `This is above your per-payment limit of $${formatUnits(l.perTxUnits)}.`, { limit: formatUnits(l.perTxUnits) });
  const used = await usedToday(ctx, q, userId);
  if (used + amount > l.dailyUnits)
    throw forbidden('limit_daily', `This would pass your daily limit of $${formatUnits(l.dailyUnits)}. You have $${formatUnits(l.dailyUnits > used ? l.dailyUnits - used : 0n)} left today.`, {
      limit: formatUnits(l.dailyUnits),
      used: formatUnits(used),
    });
}
