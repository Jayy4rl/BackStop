// Reason codes for the two safety checks (C3) and plain-language templates. Wording lives in
// per-locale template tables so Nigerian Pidgin, Yoruba, Hausa and Igbo can be added (NFR Language).

export const PRESEND_REASONS = [
  'invalid_address',
  'contract_recipient',
  'network_not_accepted',
  'recipient_confirmed_fraud',
  'recipient_under_review',
  'lookalike_address',
  'name_mismatch',
  'new_payee_high_amount',
  'unprotected_stranger',
  'support_unknown',
] as const;
export type PresendReason = (typeof PRESEND_REASONS)[number];

export const INBOUND_REASONS = [
  'sender_confirmed_fraud',
  'indirect_exposure',
  'issuer_frozen',
  'token_not_canonical',
  'sender_reported',
] as const;
export type InboundReason = (typeof INBOUND_REASONS)[number];

export type ReasonCode = PresendReason | InboundReason;

export type PresendDecision = 'allow' | 'warn' | 'block';
export type InboundDecision = 'allow' | 'review' | 'hold';

/** Result each pre-send rule produces when it fails (PRD C3 table). Block can never be overridden (C3-2). */
export const PRESEND_SEVERITY: Record<PresendReason, Exclude<PresendDecision, 'allow'>> = {
  invalid_address: 'block',
  contract_recipient: 'block',
  network_not_accepted: 'block',
  recipient_confirmed_fraud: 'block',
  recipient_under_review: 'warn',
  lookalike_address: 'warn',
  name_mismatch: 'warn',
  new_payee_high_amount: 'warn',
  unprotected_stranger: 'warn',
  support_unknown: 'warn',
};

export type Locale = 'en' | 'pcm' | 'yo' | 'ha' | 'ig';
export const SUPPORTED_LOCALES: Locale[] = ['en'];

type Vars = Record<string, string | number>;
type Table = Record<ReasonCode, { title: string; body: string }>;

const EN: Table = {
  invalid_address: {
    title: 'This address is not valid',
    body: 'The address does not match the format or checksum for {network}. Check it with the recipient; sending to it would lose the money.',
  },
  contract_recipient: {
    title: 'This address cannot receive {token}',
    body: 'The address is a token contract or another contract that cannot receive {token}. Money sent there is usually lost for good.',
  },
  network_not_accepted: {
    title: 'The recipient does not accept {token} on {network}',
    body: 'This recipient only accepts other networks or tokens. Sending here would strand the money.',
  },
  recipient_confirmed_fraud: {
    title: 'This address is on the fraud list',
    body: 'Backstop has confirmed fraud tied to this address. This payment cannot be sent.',
  },
  recipient_under_review: {
    title: 'This address is under review',
    body: 'Someone has reported this address, or its listing is being appealed. Nothing is confirmed yet. Only continue if you know and trust the recipient.',
  },
  lookalike_address: {
    title: 'This address looks like one you have paid before',
    body: 'It starts and ends like {similar}, but the middle is different. Scammers create look-alike addresses. Compare every character before you continue.',
  },
  name_mismatch: {
    title: 'The name does not match',
    body: 'You entered "{typedName}", but this Backstop account is verified as "{verifiedName}". Make sure you are paying the right person.',
  },
  new_payee_high_amount: {
    title: 'First payment to this recipient',
    body: 'You have not paid this recipient before, and {amount} is above your {threshold} new-payee threshold. Confirm the address with them by another channel.',
  },
  unprotected_stranger: {
    title: 'You are paying someone you do not know, without protection',
    body: 'Payments over {threshold} to a stranger are safer as a protected payment: the money is held until they deliver. You can switch with one tap.',
  },
  support_unknown: {
    title: 'We do not know this address',
    body: 'This is an external address with no label, so we cannot tell whether it accepts {token} on {network}. Confirm with the recipient before sending.',
  },
  sender_confirmed_fraud: {
    title: 'On hold: sender is on the fraud list',
    body: 'These funds came from an address with confirmed fraud. They cannot be used in protected payments, P2P trades or in-app payments while on hold. You can appeal.',
  },
  indirect_exposure: {
    title: 'Funds linked to fraud',
    body: 'About {share}% of this transfer can be traced to confirmed fraud within {hops} transfers. {consequence}',
  },
  issuer_frozen: {
    title: 'On hold: sender frozen by the token issuer',
    body: 'The {token} issuer has frozen the sending address. You can appeal.',
  },
  token_not_canonical: {
    title: 'Unrecognised token',
    body: 'This token uses the {token} name but is not the official {token} contract. It is not counted in your balance and cannot be used.',
  },
  sender_reported: {
    title: 'Under review: sender has been reported',
    body: 'The sending address has been reported but not confirmed. A risk analyst will review it within 1 business day.',
  },
};

const TABLES: Partial<Record<Locale, Partial<Table>>> = { en: EN };

export function fill(template: string, vars: Vars = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export function explainReason(code: ReasonCode, vars: Vars = {}, locale: Locale = 'en'): { title: string; body: string } {
  const t = TABLES[locale]?.[code] ?? EN[code];
  return { title: fill(t.title, vars), body: fill(t.body, vars) };
}

/**
 * Honest explanation of a hold in a non-custodial wallet (C2): Backstop cannot stop the user moving
 * the funds on-chain; it only refuses to use them in escrow, P2P or in-app payments.
 */
export const HOLD_MEANING =
  'Held funds stay in your own wallet. Backstop cannot move or freeze them, but the app will not use them for protected payments, P2P trades or in-app payments until the hold is cleared.';
