// Arbiter execution (C4-4: a 2-of-3 multisig of Backstop staff keys that can call only release or
// refund). The app records each signer's approval; once two of three have approved, the executor
// carries the ruling on-chain.
//  - `local`: dev/test only; a single key that is the escrow arbiter on the local chain.
//  - `safe`: production on EVM; produces the Safe transaction for the hardware-key signers to sign
//    in the Safe app. The ruling becomes final when the indexer sees Released/Refunded.
//    On TRON the arbiter is an account with a 2-of-3 active permission; signers co-sign the same
//    transaction in their wallets (same `proposed` flow).
import { encodeFunctionData, type Hex } from 'viem';
import { escrowAbi, type Network } from '@backstop/shared';
import type { Chains } from '../chain/index.ts';

export type ExecutionResult =
  | { status: 'executed'; txHash: string }
  | { status: 'proposed'; to: string; data: Hex; network: Network; instructions: string };

export interface ArbiterExecutor {
  readonly name: string;
  execute(network: Network, escrow: string, ruling: 'release' | 'refund', rulingHash: Hex): Promise<ExecutionResult>;
}

export class LocalArbiterExecutor implements ArbiterExecutor {
  readonly name = 'local';
  constructor(private readonly chains: Chains, private readonly key: Hex) {}
  async execute(network: Network, escrow: string, ruling: 'release' | 'refund', rulingHash: Hex): Promise<ExecutionResult> {
    const c = this.chains[network];
    if (!c?.callArbiter) throw new Error(`no chain client for ${network}`);
    const tx = await c.callArbiter(escrow, ruling === 'release' ? 'resolveRelease' : 'resolveRefund', rulingHash, this.key);
    return { status: 'executed', txHash: tx };
  }
}

export class SafeProposalExecutor implements ArbiterExecutor {
  readonly name = 'safe';
  constructor(private readonly safeAddresses: Partial<Record<Network, string>>) {}
  async execute(network: Network, escrow: string, ruling: 'release' | 'refund', rulingHash: Hex): Promise<ExecutionResult> {
    const data = encodeFunctionData({ abi: escrowAbi, functionName: ruling === 'release' ? 'resolveRelease' : 'resolveRefund', args: [rulingHash] });
    const safe = this.safeAddresses[network];
    return {
      status: 'proposed',
      to: escrow,
      data,
      network,
      instructions: safe
        ? `Create a transaction from arbiter ${safe} to ${escrow} with this data and collect two hardware-key signatures.`
        : `Co-sign this call from the 2-of-3 arbiter account on ${network}.`,
    };
  }
}

export function createArbiterExecutor(name: string, chains: Chains, key?: string): ArbiterExecutor {
  if (name === 'local') {
    if (!key) throw new Error('ARBITER_EXECUTOR_KEY is required for the local arbiter executor');
    return new LocalArbiterExecutor(chains, key as Hex);
  }
  return new SafeProposalExecutor({
    base: process.env.BASE_ARBITER_SAFE,
    arc: process.env.ARC_ARBITER_SAFE,
    tron: process.env.TRON_ARBITER_ACCOUNT,
  });
}
