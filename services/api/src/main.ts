import { loadConfig } from './config.ts';
import { createCtx } from './ctx.ts';
import { ensureDatabase, migrate } from './db/migrate.ts';
import { buildApp } from './app.ts';
import { seedReferenceData } from './seed.ts';

const cfg = loadConfig();
if (cfg.env !== 'production') await ensureDatabase(cfg.databaseUrl);
await migrate(cfg.databaseUrl);
const ctx = createCtx(cfg);
await ctx.versioned.ensureDefaults();
await seedReferenceData(ctx);
const app = await buildApp(ctx, { logger: true });
await app.listen({ port: cfg.port, host: '0.0.0.0' });
