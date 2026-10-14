// Name matching for C3 `name_mismatch` and L4-3/L4-4 bank-account name checks. Bank name enquiry
// returns names in varied order and casing ("ADEYEMI ADA CHIOMA"), sometimes with initials, so we
// compare normalized token sets rather than raw strings.

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'chief', 'alhaji', 'alhaja', 'engr', 'prof', 'pastor', 'barr']);

export function nameTokens(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t && !HONORIFICS.has(t));
}

export type NameMatch = 'exact' | 'strong' | 'partial' | 'none';

/**
 * exact: same token set. strong: every token of the shorter name is in the longer one (or matches
 * an initial) and at least two full tokens match. partial: at least one full token matches.
 */
export function matchNames(a: string, b: string): NameMatch {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return 'none';
  const sa = new Set(ta);
  const sb = new Set(tb);
  if (sa.size === sb.size && [...sa].every((t) => sb.has(t))) return 'exact';
  const [short, long] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  const full = [...short].filter((t) => t.length > 1 && long.has(t)).length;
  const covered = [...short].every((t) => long.has(t) || (t.length === 1 && [...long].some((l) => l.startsWith(t))));
  if (covered && full >= 2) return 'strong';
  return full >= 1 ? 'partial' : 'none';
}

/** Bank-account and payment-source checks require at least a strong match. */
export function namesAgree(a: string, b: string): boolean {
  const m = matchNames(a, b);
  return m === 'exact' || m === 'strong';
}
