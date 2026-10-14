import type { Config } from '../config.ts';
import type { Network } from '@backstop/shared';
import { EvmChainClient } from './evm.ts';
import { TronChainClient } from './tron.ts';
import type { ChainClient } from './types.ts';

export type Chains = Partial<Record<Network, ChainClient>>;

export function createChains(cfg: Config): Chains {
  const out: Chains = {};
  for (const [n, c] of Object.entries(cfg.chains)) {
    if (!c) continue;
    out[n as Network] =
      n === 'tron'
        ? new TronChainClient({ hosts: c.rpcUrls, apiKey: process.env.TRON_API_KEY, keeperKey: c.keeperKey })
        : new EvmChainClient({ network: n as Network, rpcUrls: c.rpcUrls, chainId: c.chainId, finality: c.finality, keeperKey: c.keeperKey });
  }
  return out;
}

export type { ChainClient } from './types.ts';
