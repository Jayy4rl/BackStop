// Smaller vendor integrations: bank name enquiry (L4-3), bot protection (C5-6), naira reference
// rate (C2-5) and carrier tracking validation (L3-6).
import type { NairaRate } from '@backstop/shared';

// ---------------------------------------------------------------- bank name enquiry

export interface BankNameEnquiry {
  readonly name: string;
  /** Reads the account name only; Backstop never moves naira. */
  nameEnquiry(bankCode: string, accountNumber: string, hint?: { expectedName?: string }): Promise<{ found: boolean; accountName?: string }>;
  banks(): Array<{ code: string; name: string }>;
}

export const NIGERIAN_BANKS = [
  { code: '044', name: 'Access Bank' },
  { code: '058', name: 'Guaranty Trust Bank' },
  { code: '011', name: 'First Bank of Nigeria' },
  { code: '033', name: 'United Bank for Africa' },
  { code: '057', name: 'Zenith Bank' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '232', name: 'Sterling Bank' },
  { code: '035', name: 'Wema Bank' },
  { code: '50211', name: 'Kuda Microfinance Bank' },
  { code: '999992', name: 'OPay' },
  { code: '50515', name: 'Moniepoint Microfinance Bank' },
];

/**
 * Sandbox NIP name enquiry: 10-digit NUBAN; numbers starting 99 belong to "UNRELATED THIRD PARTY";
 * numbers ending 0000 are not found; otherwise the account holder is the expected name.
 */
export class SandboxBankEnquiry implements BankNameEnquiry {
  readonly name = 'sandbox';
  async nameEnquiry(bankCode: string, accountNumber: string, hint?: { expectedName?: string }) {
    if (!/^\d{10}$/.test(accountNumber) || accountNumber.endsWith('0000') || !NIGERIAN_BANKS.some((b) => b.code === bankCode)) return { found: false };
    if (accountNumber.startsWith('99')) return { found: true, accountName: 'UNRELATED THIRD PARTY' };
    return { found: true, accountName: (hint?.expectedName ?? 'UNKNOWN HOLDER').toUpperCase() };
  }
  banks() {
    return NIGERIAN_BANKS;
  }
}

export function createBankEnquiry(name: string): BankNameEnquiry {
  if (name === 'sandbox') return new SandboxBankEnquiry();
  throw new Error(`bank name-enquiry provider "${name}" is not integrated yet (needs a licensed Nigerian provider)`);
}

// ---------------------------------------------------------------- bot protection

export interface Captcha {
  readonly name: string;
  verify(token: string | undefined, ip: string): Promise<boolean>;
}

export class SandboxCaptcha implements Captcha {
  readonly name = 'sandbox';
  async verify(token: string | undefined) {
    return token === 'sandbox-pass';
  }
}

/** Cloudflare Turnstile server-side verification. */
export class TurnstileCaptcha implements Captcha {
  readonly name = 'turnstile';
  constructor(private readonly secret: string) {}
  async verify(token: string | undefined, ip: string) {
    if (!token) return false;
    const body = new URLSearchParams({ secret: this.secret, response: token, remoteip: ip });
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const j = (await r.json().catch(() => ({}))) as { success?: boolean };
    return j.success === true;
  }
}

export function createCaptcha(name: string, secret?: string): Captcha {
  if (name === 'turnstile') {
    if (!secret) throw new Error('TURNSTILE_SECRET is required');
    return new TurnstileCaptcha(secret);
  }
  return new SandboxCaptcha();
}

// ---------------------------------------------------------------- naira reference rate

export interface FxSource {
  readonly name: string;
  latest(): Promise<NairaRate>;
}

export class SandboxFx implements FxSource {
  readonly name = 'sandbox';
  constructor(private readonly rate = process.env.SANDBOX_NGN_PER_USD ?? '1530.00') {}
  async latest(): Promise<NairaRate> {
    return { ngnPerUsd: this.rate, source: 'Sandbox reference rate', asOf: new Date().toISOString() };
  }
}

/** Generic JSON endpoint returning { rate, source?, asOf? } (e.g. an internal rates service). */
export class HttpFx implements FxSource {
  readonly name = 'http';
  constructor(private readonly url: string) {}
  async latest(): Promise<NairaRate> {
    const r = await fetch(this.url);
    if (!r.ok) throw new Error(`fx source failed: ${r.status}`);
    const j = (await r.json()) as { rate: number | string; source?: string; asOf?: string };
    return { ngnPerUsd: String(j.rate), source: j.source ?? this.url, asOf: j.asOf ?? new Date().toISOString() };
  }
}

export function createFx(name: string): FxSource {
  if (name === 'http') return new HttpFx(process.env.FX_URL ?? '');
  return new SandboxFx();
}

// ---------------------------------------------------------------- carrier tracking (L3-6, Should)

export type TrackingResult = 'valid' | 'mismatch' | 'unsupported';

export interface TrackingValidator {
  readonly name: string;
  validate(carrier: string, trackingNumber: string, expected: { destinationCountry: string }): Promise<TrackingResult>;
}

const FORMATS: Record<string, RegExp> = {
  dhl: /^\d{10}$/,
  fedex: /^\d{12}(\d{3})?$/,
  ups: /^1Z[0-9A-Z]{16}$/,
  maersk: /^[A-Z]{4}\d{7}$/, // container number
  msc: /^[A-Z]{4}\d{7}$/,
};

/** Sandbox: validates the carrier's number format; numbers ending 9999 report a destination mismatch. */
export class SandboxTracking implements TrackingValidator {
  readonly name = 'sandbox';
  async validate(carrier: string, n: string): Promise<TrackingResult> {
    const re = FORMATS[carrier.toLowerCase()];
    if (!re) return 'unsupported';
    if (!re.test(n.toUpperCase())) return 'mismatch';
    return n.endsWith('9999') ? 'mismatch' : 'valid';
  }
}

export function createTracking(): TrackingValidator {
  return new SandboxTracking();
}
