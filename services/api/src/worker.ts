// Worker process: chain indexer, keeper sweeps and the durable job queue.
import { loadConfig } from './config.ts';
import { createCtx } from './ctx.ts';
import { migrate } from './db/migrate.ts';
import { JobRunner } from './lib/jobs.ts';
import { indexAll } from './services/indexer.ts';
import { jobHandlers, keeperSweep } from './services/keeper.ts';
import { seedReferenceData } from './seed.ts';

const cfg = loadConfig();
await migrate(cfg.databaseUrl);
const ctx = createCtx(cfg);
await ctx.versioned.ensureDefaults();
await seedReferenceData(ctx);

const runner = new JobRunner(ctx.db, jobHandlers(ctx));
let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
  runner.stop();
});

const INDEX_MS = Number(process.env.INDEX_INTERVAL_MS ?? 5_000);
const SWEEP_MS = Number(process.env.KEEPER_INTERVAL_MS ?? 30_000);

async function loop(name: string, ms: number, fn: () => Promise<unknown>) {
  while (!stopping) {
    try {
      await fn();
    } catch (e) {
      console.error(`[${name}]`, (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, ms));
  }
}

console.log('worker started');
await Promise.all([loop('indexer', INDEX_MS, () => indexAll(ctx)), loop('keeper', SWEEP_MS, () => keeperSweep(ctx)), runner.loop(1_000)]);
