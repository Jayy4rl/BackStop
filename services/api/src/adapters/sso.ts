// Staff sign-in (NFR Security: staff tools behind SSO and MFA). OIDC authorization code flow with
// PKCE against the company identity provider; MFA (TOTP) is enforced by Backstop on top.
import { createHash, createPublicKey, randomBytes, verify as verifySig } from 'node:crypto';

export interface SsoIdentity {
  subject: string;
  email: string;
  name: string;
}

export interface SsoProvider {
  readonly name: string;
  /** Returns the URL to send the browser to, plus state to persist. */
  begin(): Promise<{ url: string; state: string; nonce: string; codeVerifier: string }>;
  complete(code: string, saved: { nonce: string; codeVerifier: string }): Promise<SsoIdentity>;
}

const b64url = (b: Buffer) => b.toString('base64url');

export class OidcProvider implements SsoProvider {
  readonly name = 'oidc';
  private discovery?: { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string };
  constructor(private readonly o: { issuer: string; clientId: string; clientSecret: string; redirectUri: string }) {}

  private async disco() {
    if (!this.discovery) {
      const r = await fetch(`${this.o.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
      if (!r.ok) throw new Error('OIDC discovery failed');
      this.discovery = (await r.json()) as NonNullable<OidcProvider['discovery']>;
    }
    return this.discovery;
  }

  async begin() {
    const d = await this.disco();
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const codeVerifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(codeVerifier).digest());
    const u = new URL(d.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.o.clientId,
      redirect_uri: this.o.redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return { url: u.toString(), state, nonce, codeVerifier };
  }

  async complete(code: string, saved: { nonce: string; codeVerifier: string }): Promise<SsoIdentity> {
    const d = await this.disco();
    const r = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.o.redirectUri,
        client_id: this.o.clientId,
        client_secret: this.o.clientSecret,
        code_verifier: saved.codeVerifier,
      }),
    });
    if (!r.ok) throw new Error('OIDC token exchange failed');
    const { id_token } = (await r.json()) as { id_token: string };
    const claims = await this.verifyIdToken(id_token, d);
    if (claims.nonce !== saved.nonce) throw new Error('OIDC nonce mismatch');
    return { subject: String(claims.sub), email: String(claims.email), name: String(claims.name ?? claims.email) };
  }

  private async verifyIdToken(jwt: string, d: { jwks_uri: string; issuer: string }): Promise<Record<string, unknown>> {
    const [h, p, s] = jwt.split('.');
    if (!h || !p || !s) throw new Error('malformed id_token');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { kid?: string; alg: string };
    if (header.alg !== 'RS256') throw new Error('unsupported id_token alg');
    const jwks = (await (await fetch(d.jwks_uri)).json()) as { keys: Array<Record<string, string>> };
    const jwk = jwks.keys.find((k) => k.kid === header.kid) ?? jwks.keys[0];
    if (!jwk) throw new Error('no signing key');
    const key = createPublicKey({ key: jwk as unknown as import('node:crypto').JsonWebKey, format: 'jwk' });
    if (!verifySig('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) throw new Error('bad id_token signature');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
    if (claims.iss !== d.issuer) throw new Error('bad issuer');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.o.clientId)) throw new Error('bad audience');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) throw new Error('id_token expired');
    return claims;
  }
}

/** Development only: "signs in" any active staff email without an IdP. Refused in production. */
export class SandboxSso implements SsoProvider {
  readonly name = 'sandbox';
  async begin() {
    const state = b64url(randomBytes(16));
    return { url: `/staff/sso/sandbox?state=${state}`, state, nonce: 'sandbox', codeVerifier: 'sandbox' };
  }
  async complete(code: string): Promise<SsoIdentity> {
    // In the sandbox the "code" is the staff email.
    return { subject: `sandbox:${code.toLowerCase()}`, email: code.toLowerCase(), name: code };
  }
}

export function createSso(name: string, env: string, o: { issuer?: string; clientId?: string; clientSecret?: string; redirectUri?: string }): SsoProvider {
  if (name === 'oidc') {
    if (!o.issuer || !o.clientId || !o.clientSecret || !o.redirectUri) throw new Error('SSO_ISSUER, SSO_CLIENT_ID, SSO_CLIENT_SECRET and SSO_REDIRECT_URI are required');
    return new OidcProvider(o as Required<typeof o>);
  }
  if (env === 'production') throw new Error('sandbox SSO is not allowed in production');
  return new SandboxSso();
}
