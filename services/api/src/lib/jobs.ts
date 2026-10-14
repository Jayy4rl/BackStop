// Durable job queue in Postgres (PRD: a durable queue for indexing, keepers and notifications).
// Jobs are claimed with SKIP LOCKED, retried with backoff, and deduplicated by key so keeper work
// is idempotent: enqueueing the same action twice runs it once.
import type { Db, Queryable } from '../db/pool.ts';

export interface JobRow {
  id: bigint;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export async function enqueue(q: Queryable, kind: string, payload: Record<string, unknown>, opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {}): Promise<void> {
  await q.query(
    `INSERT INTO ops.jobs (kind, payload, run_at, dedupe_key, max_attempts) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    // No runAt means "due now": the epoch is due under any clock.
    [kind, JSON.stringify(payload), opts.runAt ?? new Date(0), opts.dedupeKey ?? null, opts.maxAttempts ?? 10],
  );
}

export type Handler = (payload: Record<string, unknown>, job: JobRow) => Promise<void>;

export class JobRunner {
  private stopped = false;
  constructor(private readonly db: Db, private readonly handlers: Record<string, Handler>, private readonly workerId = `w-${process.pid}`) {}

  /** Claims and runs up to `batch` due jobs. Returns how many ran. */
  async runOnce(batch = 20, now = new Date()): Promise<number> {
    const r = await this.db.query(
      `UPDATE ops.jobs SET locked_until = $2::timestamptz + interval '5 minutes', locked_by = $3, attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM ops.jobs
         WHERE done_at IS NULL AND failed_at IS NULL AND run_at <= $2 AND (locked_until IS NULL OR locked_until < $2)
           AND kind = ANY($4)
         ORDER BY run_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING id, kind, payload, attempts, max_attempts`,
      [batch, now, this.workerId, Object.keys(this.handlers)],
    );
    for (const job of r.rows as JobRow[]) {
      const h = this.handlers[job.kind]!;
      try {
        await h(job.payload, job);
        await this.db.query('UPDATE ops.jobs SET done_at = now(), locked_until = NULL, last_error = NULL WHERE id = $1', [job.id]);
      } catch (e) {
        const msg = (e as Error).message?.slice(0, 2_000) ?? String(e);
        const backoff = Math.min(3600, 2 ** job.attempts * 5);
        await this.db.query(
          `UPDATE ops.jobs SET locked_until = NULL, last_error = $2,
             run_at = now() + ($3 || ' seconds')::interval,
             failed_at = CASE WHEN attempts >= max_attempts THEN now() END
           WHERE id = $1`,
          [job.id, msg, String(backoff)],
        );
      }
    }
    return r.rowCount ?? 0;
  }

  async loop(intervalMs = 1_000): Promise<void> {
    while (!this.stopped) {
      const n = await this.runOnce().catch(() => 0);
      if (n === 0) await new Promise((res) => setTimeout(res, intervalMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
