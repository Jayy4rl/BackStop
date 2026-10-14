// UI strings come from per-locale templates (NFR Language: plain English at launch; Nigerian
// Pidgin, Yoruba, Hausa and Igbo can be added as further tables).
type Table = Record<string, string>;

const en: Table = {
  'nav.home': 'Home',
  'nav.send': 'Send',
  'nav.receive': 'Receive',
  'nav.history': 'History',
  'nav.requests': 'Requests & contacts',
  'nav.invoices': 'Invoices',
  'nav.orders': 'Trade orders',
  'nav.p2p': 'P2P trading',
  'nav.verify': 'Verification',
  'nav.support': 'Support',
  'nav.settings': 'Settings',
  'hold.meaning':
    'Held funds stay in your own wallet. Backstop cannot move or freeze them, but the app will not use them for protected payments, P2P trades or in-app payments until the hold is cleared.',
  'fee.rule': 'Fees are deducted only when money is released to the payee. Refunds return the full amount.',
};

const tables: Record<string, Table> = { en };
let locale = 'en';

export function setLocale(l: string) {
  if (tables[l]) locale = l;
}

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const s = tables[locale]?.[key] ?? en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}
