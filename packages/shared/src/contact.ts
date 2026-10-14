// L4-5: in-app trade chat blocks sharing outside contact details (phone numbers, emails, links,
// messenger handles), which scammers use to move a trade off-platform.

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'email', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
  { kind: 'url', re: /\b(?:https?:\/\/|www\.)\S+/i },
  { kind: 'link', re: /\b[a-z0-9-]+\.(?:com|net|org|ng|io|me|ly|app|co)\b/i },
  { kind: 'messenger', re: /\b(?:wa\.me|t\.me|whatsapp|telegram|signal|snapchat|instagram|facebook|tiktok)\b/i },
  { kind: 'handle', re: /(?:^|\s)@[a-z0-9_]{4,}/i },
];

/** Digits with separators collapsed; Nigerian numbers are 11 digits (0803...) or 13 with 234. */
function hasPhoneNumber(text: string): boolean {
  const spelled = text
    .toLowerCase()
    .replace(/\b(zero|oh)\b/g, '0')
    .replace(/\bone\b/g, '1')
    .replace(/\btwo\b/g, '2')
    .replace(/\bthree\b/g, '3')
    .replace(/\bfour\b/g, '4')
    .replace(/\bfive\b/g, '5')
    .replace(/\bsix\b/g, '6')
    .replace(/\bseven\b/g, '7')
    .replace(/\beight\b/g, '8')
    .replace(/\bnine\b/g, '9');
  const runs = spelled.match(/[+\d][\d\s().-]{8,}\d/g) ?? [];
  return runs.some((r) => r.replace(/\D/g, '').length >= 10);
}

export interface ContactScan {
  blocked: boolean;
  kinds: string[];
}

export function scanForContactDetails(text: string): ContactScan {
  const kinds = PATTERNS.filter((p) => p.re.test(text)).map((p) => p.kind);
  if (hasPhoneNumber(text)) kinds.push('phone');
  return { blocked: kinds.length > 0, kinds };
}
