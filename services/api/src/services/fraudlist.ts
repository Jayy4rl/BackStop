// C5 fraud list: addresses only, never people. Every change bumps the list version so check
// decisions can record exactly which list they saw (C3-6); list changes reach checks immediately
// because checks read the table directly (NFR: within 60 s).
import { addressKey, checkAddress } from '@backstop/shared';
import type { Queryable } from '../db/pool.ts';
import { maybe, one } from '../db/pool.ts';
import { forbidden } from '../lib/errors.ts';

export type ListingStatus = 'reported' | 'confirmed' | 'rejected' | 'under_appeal' | 'delisted' | 'expired';
export type ListingLabel = 'fraud' | 'sanctions' | 'issuer_frozen' | 'scam_report';

export interface Listing {
  id: string;
  address_key: string;
  address: string;
  status: ListingStatus;
  status_before_appeal: ListingStatus | null;
  label: ListingLabel;
  source: string;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
}

export async function listVersion(q: Queryable): Promise<bigint> {
  const r = await one<{ v: string }>(q, 'SELECT max(version)::text AS v FROM network.list_versions');
  return BigInt(r.v);
}

export async function bumpVersion(q: Queryable, change: string, listingId: string | null): Promise<bigint> {
  const r = await one<{ version: bigint }>(q, 'INSERT INTO network.list_versions (change, listing_id) VALUES ($1,$2) RETURNING version', [change, listingId]);
  return r.version;
}

/** Active listings for an address (reported, confirmed or under appeal). */
export async function activeListings(q: Queryable, key: string): Promise<Listing[]> {
  const r = await q.query("SELECT * FROM network.listings WHERE address_key = $1 AND status IN ('reported','confirmed','under_appeal') ORDER BY created_at", [key]);
  return r.rows as Listing[];
}

/**
 * How an address reads to the checks. An appeal against a confirmed listing shows `under_appeal`
 * (C5-7); the safety checks treat it as "under review or under appeal" (warn), not confirmed.
 */
export async function addressStanding(q: Queryable, key: string): Promise<{ confirmed: Listing | null; reported: Listing | null; underAppeal: Listing | null; all: Listing[] }> {
  const all = await activeListings(q, key);
  return {
    confirmed: all.find((l) => l.status === 'confirmed') ?? null,
    reported: all.find((l) => l.status === 'reported') ?? null,
    underAppeal: all.find((l) => l.status === 'under_appeal') ?? null,
    all,
  };
}

export interface LabelledAddress {
  address_key: string;
  kind: 'exchange' | 'bridge' | 'token_contract' | 'service';
  name: string;
  accepts: string[];
}

export async function labelOf(q: Queryable, key: string): Promise<LabelledAddress | null> {
  return maybe<LabelledAddress>(q, 'SELECT * FROM network.labelled_addresses WHERE address_key = $1', [key]);
}

export interface NewListing {
  address: string;
  label: ListingLabel;
  source: 'dispute_ruling' | 'user_report' | 'sanctions' | 'issuer_freeze' | 'public_scam_site' | 'p2p_naira_fraud';
  status: 'reported' | 'confirmed';
  caseId?: string | null;
  sourceRef?: string | null;
  confirmedBy?: string | null;
  secondConfirmedBy?: string | null;
  now: Date;
  expiryMonths: number;
}

/**
 * Adds or upgrades a listing. C5-5: labelled exchange and bridge addresses can't be listed; the
 * analyst must name a specific deposit address instead. Public scam-site reports enter as
 * `reported` only (never `hold`).
 */
export async function upsertListing(q: Queryable, n: NewListing): Promise<{ id: string; created: boolean }> {
  const c = checkAddress(n.address);
  if (!c.valid) throw forbidden('invalid_address', 'That is not a valid address.');
  const key = addressKey(n.address);
  const lab = await labelOf(q, key);
  if (lab && (lab.kind === 'exchange' || lab.kind === 'bridge' || lab.kind === 'token_contract'))
    throw forbidden('labelled_address', `${lab.name} is a labelled ${lab.kind} address and cannot be listed. Name the specific deposit address instead.`);
  if (n.source === 'public_scam_site' && n.status !== 'reported') throw forbidden('reported_only', 'Public scam-site reports can only create reported listings.');
  const expires = n.status === 'confirmed' ? addMonths(n.now, n.expiryMonths) : null;
  const ex = await maybe<Listing>(q, "SELECT * FROM network.listings WHERE address_key = $1 AND label = $2 AND status IN ('reported','confirmed','under_appeal') FOR UPDATE", [key, n.label]);
  if (ex) {
    if (ex.status === 'reported' && n.status === 'confirmed') {
      await q.query(
        "UPDATE network.listings SET status = 'confirmed', source = $2, case_id = coalesce($3, case_id), confirmed_by = $4, second_confirmed_by = $5, confirmed_at = $6, expires_at = $7, updated_at = $6 WHERE id = $1",
        [ex.id, n.source, n.caseId ?? null, n.confirmedBy ?? null, n.secondConfirmedBy ?? null, n.now, expires],
      );
      await bumpVersion(q, `confirm ${key}`, ex.id);
    } else if (ex.status === 'confirmed' && n.status === 'confirmed') {
      // Renewal with new evidence resets the 12-month expiry (C5-9).
      await q.query('UPDATE network.listings SET expires_at = $2, renewed_at = $3, updated_at = $3 WHERE id = $1', [ex.id, expires, n.now]);
      await bumpVersion(q, `renew ${key}`, ex.id);
    }
    return { id: ex.id, created: false };
  }
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO network.listings (address_key, address, family, status, label, source, case_id, source_ref, confirmed_by, second_confirmed_by, confirmed_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [key, c.normalized, c.family, n.status, n.label, n.source, n.caseId ?? null, n.sourceRef ?? null, n.confirmedBy ?? null, n.secondConfirmedBy ?? null, n.status === 'confirmed' ? n.now : null, expires],
  );
  await bumpVersion(q, `add ${n.status} ${n.label} ${key}`, r.id);
  return { id: r.id, created: true };
}

export async function setListingStatus(q: Queryable, id: string, status: ListingStatus, now: Date, change: string): Promise<void> {
  await q.query('UPDATE network.listings SET status = $2, updated_at = $3 WHERE id = $1', [id, status, now]);
  await bumpVersion(q, change, id);
}

export function addMonths(d: Date, m: number): Date {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + m);
  return x;
}
