// Sanctions and PEP screening of people (C1-6, daily re-screening) and sanctioned crypto addresses
// for seeding the fraud list (C5-4, refreshed daily).
import { checkAddress } from '@backstop/shared';

export interface PersonScreen {
  fullName: string;
  dateOfBirth?: string;
  country: string;
}

export interface ScreenResult {
  status: 'clear' | 'potential_match' | 'confirmed_match';
  pep: boolean;
  matches: Array<{ list: string; name: string; score: number }>;
}

export interface SanctionedAddress {
  address: string;
  family: 'evm' | 'tron';
  sourceRef: string; // e.g. OFAC SDN entry uid
}

export interface SanctionsProvider {
  readonly name: string;
  screenPerson(p: PersonScreen): Promise<ScreenResult>;
  sanctionedAddresses(): Promise<SanctionedAddress[]>;
  sanctionedCountries(): Promise<Array<{ country: string; name: string }>>;
}

/** Comprehensive-sanctions jurisdictions blocked at checkout (L2-8); configuration, reviewed with counsel. */
export const DEFAULT_SANCTIONED_COUNTRIES = [
  { country: 'CU', name: 'Cuba' },
  { country: 'IR', name: 'Iran' },
  { country: 'KP', name: 'North Korea' },
  { country: 'SY', name: 'Syria' },
  { country: 'RU', name: 'Russia (sectoral)' },
  { country: 'BY', name: 'Belarus (sectoral)' },
];

/**
 * Parses OFAC's SDN XML for "Digital Currency Address - <ASSET>" identifiers and keeps EVM and
 * TRON addresses (the families Backstop supports).
 */
export function parseSdnDigitalCurrencyAddresses(xml: string): SanctionedAddress[] {
  const out: SanctionedAddress[] = [];
  const entries = xml.split(/<sdnEntry>/).slice(1);
  for (const e of entries) {
    const uid = /<uid>(\d+)<\/uid>/.exec(e)?.[1] ?? 'unknown';
    const re = /<idType>Digital Currency Address - ([A-Z0-9]+)<\/idType>\s*<idNumber>([^<]+)<\/idNumber>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(e))) {
      const asset = m[1]!;
      const addr = m[2]!.trim();
      const c = checkAddress(addr);
      if (!c.valid) continue;
      if (c.family === 'evm' && !['ETH', 'USDT', 'USDC', 'ARB', 'BSC'].includes(asset)) continue;
      out.push({ address: c.normalized, family: c.family, sourceRef: `OFAC-SDN-${uid}-${asset}` });
    }
  }
  return out;
}

const SANDBOX_PEOPLE = ['SANCTIONED TEST PERSON', 'JOHN SDN EXAMPLE'];
const SANDBOX_PEP = ['POLITICAL TEST PERSON'];

export class SandboxSanctions implements SanctionsProvider {
  readonly name: string = 'sandbox';
  constructor(private readonly addresses: SanctionedAddress[] = []) {}
  async screenPerson(p: PersonScreen): Promise<ScreenResult> {
    const n = p.fullName.trim().toUpperCase();
    if (SANDBOX_PEOPLE.includes(n)) return { status: 'confirmed_match', pep: false, matches: [{ list: 'sandbox-sdn', name: n, score: 1 }] };
    if (SANDBOX_PEP.includes(n)) return { status: 'potential_match', pep: true, matches: [{ list: 'sandbox-pep', name: n, score: 0.95 }] };
    return { status: 'clear', pep: false, matches: [] };
  }
  async sanctionedAddresses(): Promise<SanctionedAddress[]> {
    return this.addresses;
  }
  async sanctionedCountries() {
    return DEFAULT_SANCTIONED_COUNTRIES;
  }
}

/** OFAC SDN feed for addresses; person screening still needs a commercial PEP/sanctions vendor. */
export class OfacAddressFeed extends SandboxSanctions {
  override readonly name = 'ofac';
  constructor(private readonly url: string) {
    super();
  }
  override async sanctionedAddresses(): Promise<SanctionedAddress[]> {
    const r = await fetch(this.url);
    if (!r.ok) throw new Error(`SDN download failed: ${r.status}`);
    return parseSdnDigitalCurrencyAddresses(await r.text());
  }
}

export function createSanctionsProvider(name: string, url: string): SanctionsProvider {
  if (name === 'ofac') return new OfacAddressFeed(url);
  return new SandboxSanctions(
    (process.env.SANDBOX_SANCTIONED_ADDRESSES ?? '')
      .split(',')
      .filter(Boolean)
      .map((a, i) => {
        const c = checkAddress(a);
        if (!c.valid) throw new Error(`bad SANDBOX_SANCTIONED_ADDRESSES entry ${a}`);
        return { address: c.normalized, family: c.family, sourceRef: `SANDBOX-${i}` };
      }),
  );
}
