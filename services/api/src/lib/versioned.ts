// Rules, fee schedules and tier limits are versioned data (PRD "Path to the service layer"). The
// active version of each is loaded from config.versions; every decision records the version it used.
import {
  DEFAULT_FEE_SCHEDULE,
  DEFAULT_LIMITS,
  DEFAULT_RULES,
  deserializeRules,
  serializeRules,
  type FeeSchedule,
  type LimitConfig,
  type RuleSet,
} from '@backstop/shared';
import type { Db, Queryable } from '../db/pool.ts';

type Kind = 'rules' | 'fees' | 'limits';

const serialize = (v: unknown) => serializeRules(v as RuleSet);
const deserialize = <T>(s: string) => deserializeRules(s) as unknown as T;

export class VersionedConfig {
  private cache = new Map<Kind, { at: number; value: unknown }>();
  private holidayCache: { at: number; value: Set<string> } | null = null;
  constructor(private readonly db: Db, private readonly tenantId: number, private readonly ttlMs = 30_000) {}

  /** Inserts the built-in defaults as the active versions when none exist. */
  async ensureDefaults(): Promise<void> {
    const defaults: Array<[Kind, string, unknown]> = [
      ['rules', DEFAULT_RULES.version, DEFAULT_RULES],
      ['fees', DEFAULT_FEE_SCHEDULE.version, DEFAULT_FEE_SCHEDULE],
      ['limits', DEFAULT_LIMITS.version, DEFAULT_LIMITS],
    ];
    for (const [kind, version, body] of defaults) {
      await this.db.query(
        `INSERT INTO config.versions (tenant_id, kind, version, body, active, created_by)
         SELECT $1, $2, $3, $4, NOT EXISTS (SELECT 1 FROM config.versions WHERE tenant_id = $1 AND kind = $2 AND active), 'system'
         ON CONFLICT DO NOTHING`,
        [this.tenantId, kind, version, serialize(body)],
      );
    }
  }

  private async load<T>(kind: Kind): Promise<T> {
    const hit = this.cache.get(kind);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as T;
    const r = await this.db.query('SELECT body FROM config.versions WHERE tenant_id = $1 AND kind = $2 AND active', [this.tenantId, kind]);
    if (!r.rowCount) throw new Error(`no active ${kind} configuration`);
    const value = deserialize<T>(JSON.stringify(r.rows[0].body));
    this.cache.set(kind, { at: Date.now(), value });
    return value;
  }

  rules(): Promise<RuleSet> {
    return this.load<RuleSet>('rules');
  }
  fees(): Promise<FeeSchedule> {
    return this.load<FeeSchedule>('fees');
  }
  limits(): Promise<LimitConfig> {
    return this.load<LimitConfig>('limits');
  }

  async byVersion<T>(kind: Kind, version: string): Promise<T | null> {
    const r = await this.db.query('SELECT body FROM config.versions WHERE tenant_id = $1 AND kind = $2 AND version = $3', [this.tenantId, kind, version]);
    return r.rowCount ? deserialize<T>(JSON.stringify(r.rows[0].body)) : null;
  }

  /** Publishes a new version and makes it active (staff admin action, audited by caller). */
  async publish(q: Queryable, kind: Kind, version: string, body: unknown, by: string): Promise<void> {
    await q.query('UPDATE config.versions SET active = false WHERE tenant_id = $1 AND kind = $2 AND active', [this.tenantId, kind]);
    await q.query('INSERT INTO config.versions (tenant_id, kind, version, body, active, created_by) VALUES ($1,$2,$3,$4,true,$5)', [this.tenantId, kind, version, serialize(body), by]);
    this.cache.delete(kind);
  }

  async holidays(): Promise<Set<string>> {
    if (this.holidayCache && Date.now() - this.holidayCache.at < this.ttlMs) return this.holidayCache.value;
    const r = await this.db.query("SELECT to_char(day, 'YYYY-MM-DD') AS d FROM config.holidays");
    const value = new Set(r.rows.map((x) => x.d as string));
    this.holidayCache = { at: Date.now(), value };
    return value;
  }
}
