// Reference data every environment needs: sanctioned countries (L2-8), canonical token contracts as
// labelled addresses (never valid recipients; can't be listed), and staff accounts from SEED_STAFF
// ("email|Name|role,role;email2|..."). Idempotent.
import { fileURLToPath } from 'node:url';
import { addressKey, CANONICAL_TOKENS, checkAddress } from '@backstop/shared';
import type { Ctx } from './ctx.ts';
import { DEFAULT_SANCTIONED_COUNTRIES } from './adapters/sanctions.ts';

export async function seedReferenceData(ctx: Ctx): Promise<void> {
  for (const c of await ctx.sanctions.sanctionedCountries().catch(() => DEFAULT_SANCTIONED_COUNTRIES)) {
    await ctx.db.query('INSERT INTO config.sanctioned_countries (country, name, source) VALUES ($1,$2,$3) ON CONFLICT (country) DO NOTHING', [c.country, c.name, ctx.sanctions.name]);
  }
  const tokens = new Map<string, string>();
  for (const [env, table] of Object.entries(CANONICAL_TOKENS)) for (const [pair, a] of Object.entries(table)) if (a) tokens.set(a, `${pair} (${env})`);
  for (const c of Object.values(ctx.cfg.chains)) for (const [sym, a] of Object.entries(c?.tokens ?? {})) if (a) tokens.set(a, `${c!.network}:${sym} (configured)`);
  for (const [a, name] of tokens) {
    const c = checkAddress(a);
    if (!c.valid) continue;
    await ctx.db.query(
      "INSERT INTO network.labelled_addresses (address_key, address, family, kind, name) VALUES ($1,$2,$3,'token_contract',$4) ON CONFLICT (address_key) DO NOTHING",
      [addressKey(c.normalized), c.normalized, c.family, `Token contract ${name}`],
    );
  }
  for (const entry of (process.env.SEED_STAFF ?? '').split(';').filter(Boolean)) {
    const [email, name, roles] = entry.split('|');
    if (!email || !name || !roles) continue;
    await ctx.db.query('INSERT INTO app.staff (email, name, roles) VALUES ($1,$2,$3) ON CONFLICT (email) DO UPDATE SET roles = EXCLUDED.roles, name = EXCLUDED.name', [email.toLowerCase(), name, roles.split(',')]);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { loadConfig } = await import('./config.ts');
  const { createCtx, closeCtx } = await import('./ctx.ts');
  const ctx = createCtx(loadConfig());
  await ctx.versioned.ensureDefaults();
  await seedReferenceData(ctx);
  await closeCtx(ctx);
  console.log('seeded');
}
