// Dollar amounts and token base units. All stablecoins in scope use 6 decimals through their token
// interface (L1-6); amounts are carried as bigint base units and as decimal strings over the wire.
import { TOKEN_DECIMALS } from './chains.ts';

const SCALE = 10n ** BigInt(TOKEN_DECIMALS);
const AMOUNT_RE = /^(\d{1,15})(?:\.(\d{1,6}))?$/;

/** Parses "12.34" dollars into base units. Rejects more precision than the token supports. */
export function parseUnits(input: string): bigint {
  const s = input.trim().replace(/,/g, '').replace(/^\$/, '');
  const m = AMOUNT_RE.exec(s);
  if (!m) throw new RangeError(`invalid amount "${input}" (max ${TOKEN_DECIMALS} decimals)`);
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? '').padEnd(TOKEN_DECIMALS, '0'));
  return whole * SCALE + frac;
}

export function tryParseUnits(input: string): bigint | null {
  try {
    return parseUnits(input);
  } catch {
    return null;
  }
}

/** Formats base units as a plain decimal string with up to 6 decimals ("12.5", "0.000001"). */
export function formatUnits(units: bigint): string {
  const neg = units < 0n;
  const v = neg ? -units : units;
  const whole = v / SCALE;
  const frac = (v % SCALE).toString().padStart(TOKEN_DECIMALS, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** "$1,234.50" for display; always two decimals, rounding half up on cents. */
export function formatUsd(units: bigint): string {
  const neg = units < 0n;
  const v = neg ? -units : units;
  const cents = (v + 5_000n) / 10_000n;
  const whole = (cents / 100n).toLocaleString('en-US');
  const c = (cents % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}$${whole}.${c}`;
}

/** Naira reference rate: naira per dollar, with source and time (C2-5). */
export interface NairaRate {
  ngnPerUsd: string; // decimal string, e.g. "1530.25"
  source: string;
  asOf: string; // ISO
}

/** Naira reference value in kobo-precision string, e.g. "₦15,302.50". Display only: the app never holds naira. */
export function formatNairaReference(units: bigint, rate: NairaRate): string {
  const [w = '0', f = ''] = rate.ngnPerUsd.split('.');
  const rateMicro = BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, '0').slice(0, 6));
  // units (1e6) * rateMicro (1e6) = 1e12 scale -> kobo (1e2)
  const kobo = (units * rateMicro + 5_000_000_000n) / 10_000_000_000n;
  const whole = (kobo / 100n).toLocaleString('en-US');
  return `₦${whole}.${(kobo % 100n).toString().padStart(2, '0')}`;
}

export const ONE_DOLLAR = SCALE;
export const usd = (dollars: number | string): bigint => parseUnits(String(dollars));
