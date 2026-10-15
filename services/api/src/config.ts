// Runtime configuration from environment. Vendor adapters default to `sandbox` implementations
// because the PRD leaves identity, wallet, bank-enquiry and messaging vendors to be chosen; each
// adapter interface is the integration point for the chosen vendor.
import type { Network } from '@backstop/shared';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required environment variable ${name}`);
}

function list(name: string, fallback = ''): string[] {
  return env(name, fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ChainConfig {
  network: Network;
  /** Two node providers per chain with automatic failover (PRD constraint). */
  rpcUrls: string[];
  chainId?: number;
  factory?: string;
  /** Canonical token contracts on this network, keyed by symbol. */
  tokens: Partial<Record<'USDT' | 'USDC', string>>;
  /** Block tag or confirmation rule used to decide finality. */
  finality: 'finalized' | 'latest' | 'solidified';
  startBlock: bigint;
  /** Hot key the keeper uses to call time-based functions (any address may). */
  keeperKey?: string;
}

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  publicBaseUrl: string;
  webBaseUrl: string;
  databaseUrl: string;
  redisUrl: string | null;
  tenantId: number;
  /** 32-byte hex key for identity data encryption at rest (managed KMS in production). */
  dataKeyHex: string;
  /** HMAC key for lookup hashes (BVN/NIN uniqueness, bank accounts). */
  lookupKeyHex: string;
  /** Ed25519 private key (hex) for signed documents (proof of funds, trade records). */
  documentSigningKeyHex: string;
  sessionTtlHours: number;
  webauthn: { rpId: string; rpName: string; origins: string[] };
  adapters: {
    sms: string;
    email: string;
    push: string;
    identity: string;
    cac: string;
    sanctions: string;
    bankEnquiry: string;
    wallet: string;
    captcha: string;
    storage: string;
    fx: string;
    arbiter: string;
    sso: string;
    tracking: string;
  };
  turnstileSecret?: string;
  storageDir: string;
  maxUploadBytes: number;
  chains: Partial<Record<Network, ChainConfig>>;
  arbiterExecutorKey?: string;
  sso: { issuer?: string; clientId?: string; clientSecret?: string; redirectUri?: string };
  /** OFAC SDN list URL for sanctioned address seeding (C5-4). */
  sanctionsListUrl: string;
  /** P2P (L4) is off until legal gate G2 clears. */
  p2pEnabled: boolean;
  /** Sandbox demo accounts created without sign-up ("Launch App"). Never enabled in production. */
  demoAccounts: boolean;
  treasury: Partial<Record<Network, string>>;
}

function chain(network: Network, prefix: string): ChainConfig | undefined {
  const rpc = list(`${prefix}_RPC_URLS`);
  if (!rpc.length) return undefined;
  const tokens: ChainConfig['tokens'] = {};
  const usdt = process.env[`${prefix}_USDT`];
  const usdc = process.env[`${prefix}_USDC`];
  if (usdt) tokens.USDT = usdt;
  if (usdc) tokens.USDC = usdc;
  return {
    network,
    rpcUrls: rpc,
    chainId: process.env[`${prefix}_CHAIN_ID`] ? Number(process.env[`${prefix}_CHAIN_ID`]) : undefined,
    factory: process.env[`${prefix}_FACTORY`],
    tokens,
    finality: (process.env[`${prefix}_FINALITY`] as ChainConfig['finality']) ?? (network === 'tron' ? 'solidified' : 'finalized'),
    startBlock: BigInt(process.env[`${prefix}_START_BLOCK`] ?? '0'),
    keeperKey: process.env[`${prefix}_KEEPER_KEY`],
  };
}

function demoAccounts(e: Config['env']): boolean {
  const v = process.env.DEMO_ACCOUNTS;
  if (e === 'production') {
    if (v === 'true') throw new Error('DEMO_ACCOUNTS cannot be enabled in production');
    return false;
  }
  return v !== 'false';
}

export function loadConfig(): Config {
  const e = env('NODE_ENV', 'development') as Config['env'];
  const dev = e !== 'production';
  const cfg: Config = {
    env: e,
    port: Number(env('PORT', '4000')),
    publicBaseUrl: env('PUBLIC_BASE_URL', 'http://localhost:4000'),
    webBaseUrl: env('WEB_BASE_URL', 'http://localhost:5173'),
    databaseUrl: env('DATABASE_URL', 'postgres://postgres@127.0.0.1:5432/backstop'),
    redisUrl: process.env.REDIS_URL ?? (dev ? 'redis://127.0.0.1:6379' : null),
    tenantId: Number(env('TENANT_ID', '1')),
    dataKeyHex: env('DATA_KEY_HEX', dev ? '11'.repeat(32) : undefined),
    lookupKeyHex: env('LOOKUP_KEY_HEX', dev ? '22'.repeat(32) : undefined),
    documentSigningKeyHex: env('DOCUMENT_SIGNING_KEY_HEX', dev ? '33'.repeat(32) : undefined),
    sessionTtlHours: Number(env('SESSION_TTL_HOURS', '720')),
    webauthn: {
      rpId: env('WEBAUTHN_RP_ID', 'localhost'),
      rpName: env('WEBAUTHN_RP_NAME', 'Backstop'),
      origins: list('WEBAUTHN_ORIGINS', 'http://localhost:5173'),
    },
    adapters: {
      sms: env('SMS_ADAPTER', 'sandbox'),
      email: env('EMAIL_ADAPTER', 'sandbox'),
      push: env('PUSH_ADAPTER', 'sandbox'),
      identity: env('IDENTITY_ADAPTER', 'sandbox'),
      cac: env('CAC_ADAPTER', 'sandbox'),
      sanctions: env('SANCTIONS_ADAPTER', 'sandbox'),
      bankEnquiry: env('BANK_ENQUIRY_ADAPTER', 'sandbox'),
      wallet: env('WALLET_ADAPTER', 'sandbox'),
      captcha: env('CAPTCHA_ADAPTER', dev ? 'sandbox' : 'turnstile'),
      storage: env('STORAGE_ADAPTER', 'local'),
      fx: env('FX_ADAPTER', 'sandbox'),
      arbiter: env('ARBITER_ADAPTER', dev ? 'local' : 'safe'),
      sso: env('SSO_ADAPTER', dev ? 'sandbox' : 'oidc'),
      tracking: env('TRACKING_ADAPTER', 'sandbox'),
    },
    turnstileSecret: process.env.TURNSTILE_SECRET,
    storageDir: env('STORAGE_DIR', './.data/files'),
    maxUploadBytes: 100 * 1024 * 1024, // L2-4: up to 100 MB each
    chains: {},
    arbiterExecutorKey: process.env.ARBITER_EXECUTOR_KEY,
    sso: {
      issuer: process.env.SSO_ISSUER,
      clientId: process.env.SSO_CLIENT_ID,
      clientSecret: process.env.SSO_CLIENT_SECRET,
      redirectUri: process.env.SSO_REDIRECT_URI,
    },
    sanctionsListUrl: env('SANCTIONS_LIST_URL', 'https://www.treasury.gov/ofac/downloads/sdn.xml'),
    p2pEnabled: env('P2P_ENABLED', dev ? 'true' : 'false') === 'true',
    demoAccounts: demoAccounts(e),
    treasury: {},
  };
  for (const [n, p] of [['tron', 'TRON'], ['base', 'BASE'], ['arc', 'ARC'], ['ethereum', 'ETH']] as const) {
    const c = chain(n, p);
    if (c) cfg.chains[n] = c;
    const t = process.env[`${p}_TREASURY`];
    if (t) cfg.treasury[n] = t;
  }
  return cfg;
}
