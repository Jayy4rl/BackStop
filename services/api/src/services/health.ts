// Indexer freshness (NFR data freshness: within 30 s of head on TRON, Base and Arc, 60 s on
// Ethereum). Edge case "indexer behind": escrow funding and P2P trades pause with a notice; simple
// sends continue.
import { NETWORK_INFO, type Network } from '@backstop/shared';
import type { Ctx } from '../ctx.ts';
import { unavailable } from '../lib/errors.ts';

export interface NetworkHealth {
  network: Network;
  configured: boolean;
  lastIndexedBlock: string | null;
  finalHead: string | null;
  updatedAt: string | null;
  lagSeconds: number | null;
  behind: boolean;
}

export async function indexerHealth(ctx: Ctx): Promise<{ networks: NetworkHealth[]; escrowPaused: Network[] }> {
  const rows = await ctx.db.query("SELECT network, last_block, head_block, updated_at FROM ops.indexer_cursors WHERE stream = 'escrow'");
  const by = new Map(rows.rows.map((r) => [r.network as string, r]));
  const out: NetworkHealth[] = [];
  for (const n of Object.keys(NETWORK_INFO) as Network[]) {
    const configured = !!ctx.cfg.chains[n];
    const r = by.get(n);
    const lag = r ? (ctx.now().getTime() - new Date(r.updated_at as Date).getTime()) / 1000 : null;
    const behind = configured && (lag === null || lag > NETWORK_INFO[n].maxIndexerLagSeconds * 2);
    out.push({
      network: n,
      configured,
      lastIndexedBlock: r ? String(r.last_block) : null,
      finalHead: r?.head_block != null ? String(r.head_block) : null,
      updatedAt: r ? new Date(r.updated_at as Date).toISOString() : null,
      lagSeconds: lag === null ? null : Math.round(lag),
      behind,
    });
  }
  return { networks: out, escrowPaused: out.filter((h) => h.configured && h.behind).map((h) => h.network) };
}

export async function assertIndexerFresh(ctx: Ctx, network: Network): Promise<void> {
  if (!ctx.cfg.chains[network]) throw unavailable('network_unavailable', `${NETWORK_INFO[network].label} is not available.`);
  const h = await indexerHealth(ctx);
  if (h.escrowPaused.includes(network))
    throw unavailable('indexer_behind', `Protected payments and P2P trades on ${NETWORK_INFO[network].label} are paused for a few minutes while we catch up with the network. Simple sends still work.`);
}
