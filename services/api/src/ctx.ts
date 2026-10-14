// Dependency container shared by the HTTP server and the worker.
import { Redis } from 'ioredis';
import type { Config } from './config.ts';
import { createPool, type Db } from './db/pool.ts';
import { Crypto } from './lib/crypto.ts';
import { VersionedConfig } from './lib/versioned.ts';
import { MemoryRateLimiter, RedisRateLimiter, type RateLimiter } from './lib/ratelimit.ts';
import { createMessengers, type Messenger } from './adapters/messaging.ts';
import { createCompanyRegistry, createIdentityVendor, type CompanyRegistry, type IdentityVendor } from './adapters/identity.ts';
import { createSanctionsProvider, type SanctionsProvider } from './adapters/sanctions.ts';
import { createBankEnquiry, createCaptcha, createFx, createTracking, type BankNameEnquiry, type Captcha, type FxSource, type TrackingValidator } from './adapters/misc.ts';
import { createBlobStore, type BlobStore } from './adapters/storage.ts';
import { createArbiterExecutor, type ArbiterExecutor } from './adapters/arbiter.ts';
import { createSso, type SsoProvider } from './adapters/sso.ts';
import { createChains, type Chains } from './chain/index.ts';

export interface Ctx {
  cfg: Config;
  db: Db;
  redis: Redis | null;
  crypto: Crypto;
  versioned: VersionedConfig;
  limiter: RateLimiter;
  messengers: Record<'sms' | 'email' | 'push', Messenger>;
  identity: IdentityVendor;
  companies: CompanyRegistry;
  sanctions: SanctionsProvider;
  bank: BankNameEnquiry;
  captcha: Captcha;
  fx: FxSource;
  tracking: TrackingValidator;
  blobs: BlobStore;
  chains: Chains;
  arbiter: ArbiterExecutor;
  sso: SsoProvider;
  /** Overridable clock so tests can move time. */
  now: () => Date;
}

export type CtxOverrides = Partial<Omit<Ctx, 'cfg'>>;

export function createCtx(cfg: Config, overrides: CtxOverrides = {}): Ctx {
  const db = overrides.db ?? createPool(cfg.databaseUrl);
  const redis = overrides.redis !== undefined ? overrides.redis : cfg.redisUrl ? new Redis(cfg.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 }) : null;
  const crypto = overrides.crypto ?? new Crypto(cfg.dataKeyHex, cfg.lookupKeyHex, cfg.documentSigningKeyHex);
  const chains = overrides.chains ?? createChains(cfg);
  return {
    cfg,
    db,
    redis,
    crypto,
    versioned: overrides.versioned ?? new VersionedConfig(db, cfg.tenantId),
    limiter: overrides.limiter ?? (redis ? new RedisRateLimiter(redis) : new MemoryRateLimiter()),
    messengers: overrides.messengers ?? createMessengers(cfg.adapters),
    identity: overrides.identity ?? createIdentityVendor(cfg.adapters.identity),
    companies: overrides.companies ?? createCompanyRegistry(cfg.adapters.cac),
    sanctions: overrides.sanctions ?? createSanctionsProvider(cfg.adapters.sanctions, cfg.sanctionsListUrl),
    bank: overrides.bank ?? createBankEnquiry(cfg.adapters.bankEnquiry),
    captcha: overrides.captcha ?? createCaptcha(cfg.adapters.captcha, cfg.turnstileSecret),
    fx: overrides.fx ?? createFx(cfg.adapters.fx),
    tracking: overrides.tracking ?? createTracking(),
    blobs: overrides.blobs ?? createBlobStore(cfg.adapters.storage, cfg.storageDir, crypto),
    chains,
    arbiter: overrides.arbiter ?? createArbiterExecutor(cfg.adapters.arbiter, chains, cfg.arbiterExecutorKey ?? (cfg.env === 'production' ? undefined : '0x'.padEnd(66, '1'))),
    sso: overrides.sso ?? createSso(cfg.adapters.sso, cfg.env, cfg.sso),
    now: overrides.now ?? (() => new Date()),
  };
}

export async function closeCtx(ctx: Ctx): Promise<void> {
  await ctx.db.end().catch(() => undefined);
  ctx.redis?.disconnect();
}
