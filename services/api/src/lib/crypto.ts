// Encryption at rest for identity data and evidence (C1-9, C4-8), lookup HMACs, session tokens and
// signed documents. Keys come from configuration; in production the data key is unwrapped from a
// managed KMS at start-up.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';

export class Crypto {
  private readonly dataKey: Buffer;
  private readonly lookupKey: Buffer;
  private readonly signingKey: Uint8Array;
  readonly signingPublicKeyHex: string;

  constructor(dataKeyHex: string, lookupKeyHex: string, signingKeyHex: string) {
    this.dataKey = Buffer.from(dataKeyHex, 'hex');
    this.lookupKey = Buffer.from(lookupKeyHex, 'hex');
    if (this.dataKey.length !== 32 || this.lookupKey.length !== 32) throw new Error('data and lookup keys must be 32 bytes');
    this.signingKey = Uint8Array.from(Buffer.from(signingKeyHex, 'hex'));
    this.signingPublicKeyHex = Buffer.from(ed25519.getPublicKey(this.signingKey)).toString('hex');
  }

  /** AES-256-GCM: version byte | 12-byte IV | 16-byte tag | ciphertext. */
  encrypt(plain: Buffer | string, aad = ''): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.dataKey, iv);
    c.setAAD(Buffer.from(aad));
    const body = Buffer.concat([c.update(typeof plain === 'string' ? Buffer.from(plain) : plain), c.final()]);
    return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]);
  }

  decrypt(blob: Buffer, aad = ''): Buffer {
    if (blob[0] !== 1) throw new Error('unknown ciphertext version');
    const iv = blob.subarray(1, 13);
    const tag = blob.subarray(13, 29);
    const d = createDecipheriv('aes-256-gcm', this.dataKey, iv);
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(blob.subarray(29)), d.final()]);
  }

  encryptJson(v: unknown, aad = ''): Buffer {
    return this.encrypt(JSON.stringify(v), aad);
  }

  decryptJson<T>(blob: Buffer, aad = ''): T {
    return JSON.parse(this.decrypt(blob, aad).toString('utf8')) as T;
  }

  lookupHmac(kind: string, value: string): string {
    return createHmac('sha256', this.lookupKey).update(`${kind}:${value.trim().toLowerCase()}`).digest('hex');
  }

  /** Detached Ed25519 signature over a canonical JSON document. */
  signDocument(doc: Record<string, unknown>): { canonical: string; signature: string; publicKey: string } {
    const canonical = canonicalJson(doc);
    const sig = ed25519.sign(new TextEncoder().encode(canonical), this.signingKey);
    return { canonical, signature: Buffer.from(sig).toString('hex'), publicKey: this.signingPublicKeyHex };
  }

  verifyDocument(canonical: string, signatureHex: string): boolean {
    try {
      return ed25519.verify(Buffer.from(signatureHex, 'hex'), new TextEncoder().encode(canonical), Buffer.from(this.signingPublicKeyHex, 'hex'));
    } catch {
      return false;
    }
  }
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomCode(digits = 6): string {
  const n = randomBytes(4).readUInt32BE(0) % 10 ** digits;
  return n.toString().padStart(digits, '0');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(typeof v === 'bigint' ? v.toString() : v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(typeof o[k] === 'bigint' ? (o[k] as bigint).toString() : o[k])}`)
    .join(',')}}`;
}
