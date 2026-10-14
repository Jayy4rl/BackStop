// A software WebAuthn authenticator (ES256, "none" attestation) so tests exercise the real
// registration and assertion verification in @simplewebauthn/server.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');

// ---- minimal CBOR encoder (maps, ints, byte strings, text strings)
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function cbor(v: unknown): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, s.length), s]);
  }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) {
    const parts = [head(5, v.size)];
    for (const [k, x] of v) parts.push(cbor(k), cbor(x));
    return Buffer.concat(parts);
  }
  if (v && typeof v === 'object') return cbor(new Map(Object.entries(v)));
  throw new Error(`cbor: unsupported ${typeof v}`);
}

export class SoftAuthenticator {
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  readonly credentialId = randomBytes(16);
  private counter = 0;

  constructor(private readonly rpId: string, private readonly origin: string) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    this.publicJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  }

  private rpIdHash(): Buffer {
    return createHash('sha256').update(this.rpId).digest();
  }

  register(options: { challenge: string }) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(this.publicJwk.x, 'base64url')], [-3, Buffer.from(this.publicJwk.y, 'base64url')]]));
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credentialId.length);
    const counter = Buffer.alloc(4);
    const authData = Buffer.concat([this.rpIdHash(), Buffer.from([0x01 | 0x04 | 0x40]), counter, Buffer.alloc(16), len, this.credentialId, cose]);
    const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), transports: ['internal'] },
      clientExtensionResults: {},
    };
  }

  assert(options: { challenge: string }, userId?: string) {
    this.counter += 1;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const c = Buffer.alloc(4);
    c.writeUInt32BE(this.counter);
    const authData = Buffer.concat([this.rpIdHash(), Buffer.from([0x01 | 0x04]), c]);
    const sig = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]), this.privateKey);
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authData), signature: b64url(sig), ...(userId ? { userHandle: b64url(Buffer.from(userId)) } : {}) },
      clientExtensionResults: {},
    };
  }
}
