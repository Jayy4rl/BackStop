// PRD "Success metrics": verified users, protected volume, completion without ruling, dispute
// rate, ruling time, false holds, appeal time, retention, plus check latency (C3-1 p95 ≤ 300 ms).
import { formatUnits } from '@backstop/shared';
import type { Ctx } from '../ctx.ts';
import { many, one } from '../db/pool.ts';

export async function metrics(ctx: Ctx) {
  const db = ctx.db;
  const verified = await one<{ tier1: string; tier2: string }>(db, "SELECT count(*) FILTER (WHERE tier = 'tier1') AS tier1, count(*) FILTER (WHERE tier = 'tier2') AS tier2 FROM app.users");
  const volume = await many<{ loop: string; month: string; volume: string }>(
    db,
    "SELECT loop, to_char(date_trunc('month', funded_at), 'YYYY-MM') AS month, sum(amount_units) AS volume FROM app.payments WHERE funded_at IS NOT NULL GROUP BY 1, 2 ORDER BY 2 DESC, 1",
  );
  const completion = await many<{ loop: string; funded: string; ok: string; disputed: string }>(
    db,
    `SELECT p.loop, count(*) AS funded,
            count(*) FILTER (WHERE p.status IN ('released','refunded') AND NOT EXISTS (SELECT 1 FROM network.disputes d WHERE d.payment_id = p.id AND d.ruling IS NOT NULL)) AS ok,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM network.disputes d WHERE d.payment_id = p.id AND d.opened_onchain_at IS NOT NULL)) AS disputed
     FROM app.payments p WHERE p.funded_at IS NOT NULL GROUP BY p.loop`,
  );
  const ruling = await many<{ loop: string; median_hours: string | null }>(
    db,
    "SELECT loop, percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ruled_at - opened_onchain_at) / 3600) AS median_hours FROM network.disputes WHERE ruled_at IS NOT NULL GROUP BY loop",
  );
  const falseHolds = await many<{ week: string; released: string }>(
    db,
    `SELECT to_char(date_trunc('week', coalesce(r.resolved_at, a.decided_at)), 'IYYY-IW') AS week, count(*) AS released
     FROM network.review_cases r FULL JOIN network.appeals a ON false
     WHERE (r.status = 'cleared') OR (a.kind = 'hold' AND a.status = 'granted')
     GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
  );
  const appeal = await one<{ median_hours: string | null }>(db, "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM decided_at - created_at) / 3600) AS median_hours FROM network.appeals WHERE decided_at IS NOT NULL");
  const retention = await one<{ repeaters: string; payers: string }>(
    db,
    `WITH firsts AS (SELECT payer_user_id AS u, min(funded_at) AS f FROM app.payments WHERE funded_at IS NOT NULL AND payer_user_id IS NOT NULL GROUP BY 1)
     SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM app.payments p WHERE p.payer_user_id = firsts.u AND p.funded_at > firsts.f AND p.funded_at <= firsts.f + interval '60 days')) AS repeaters, count(*) AS payers FROM firsts`,
  );
  const latency = await one<{ p95: string | null; n: string }>(db, "SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95, count(*) AS n FROM network.check_decisions WHERE kind = 'presend' AND created_at > now() - interval '1 day'");
  const misdirected = await one<{ sends: string; failed: string }>(db, "SELECT count(*) AS sends, count(*) FILTER (WHERE availability = 'unsupported_pair') AS failed FROM app.transfers WHERE kind = 'transfer'");
  return {
    verifiedUsers: { tier1: Number(verified.tier1), tier2: Number(verified.tier2) },
    protectedVolume: volume.map((v) => ({ loop: v.loop, month: v.month, usd: formatUnits(BigInt(v.volume)) })),
    protectedPaymentsCompleted: completion.map((c) => ({ loop: c.loop, funded: Number(c.funded), completedWithoutRuling: Number(c.ok), share: Number(c.funded) ? Number(c.ok) / Number(c.funded) : null, target: 0.9 })),
    disputeRate: completion.map((c) => ({ loop: c.loop, rate: Number(c.funded) ? Number(c.disputed) / Number(c.funded) : 0, reviewTrigger: 0.05, needsReview: Number(c.funded) ? Number(c.disputed) / Number(c.funded) > 0.05 : false })),
    medianRulingHours: ruling.map((r) => ({ loop: r.loop, hours: r.median_hours === null ? null : Number(r.median_hours) })),
    falseHoldsPerWeek: falseHolds.map((f) => ({ week: f.week, count: Number(f.released) })),
    medianAppealHours: appeal.median_hours === null ? null : Number(appeal.median_hours),
    retention60d: { repeaters: Number(retention.repeaters), payers: Number(retention.payers) },
    presendLatency24h: { p95Ms: latency.p95 === null ? null : Number(latency.p95), samples: Number(latency.n), targetMs: 300 },
    misdirectedSends: { sends: Number(misdirected.sends), stranded: Number(misdirected.failed) },
  };
}
