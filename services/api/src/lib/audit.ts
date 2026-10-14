// NFR Auditability: every check, hold, ruling and staff action is written to the append-only,
// hash-chained audit log (audit.events; updates and deletes are rejected by trigger).
import type { Queryable } from '../db/pool.ts';

export type ActorType = 'user' | 'staff' | 'system' | 'public' | 'keeper' | 'indexer';

export interface Actor {
  type: ActorType;
  id?: string | null;
}

export async function audit(
  q: Queryable,
  actor: Actor,
  action: string,
  subjectType: string,
  subjectId: string | null,
  data: Record<string, unknown> = {},
  tenantId = 1,
): Promise<void> {
  await q.query(
    'INSERT INTO audit.events (tenant_id, actor_type, actor_id, action, subject_type, subject_id, data) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [tenantId, actor.type, actor.id ?? null, action, subjectType, subjectId, JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))],
  );
}

export const SYSTEM: Actor = { type: 'system' };
