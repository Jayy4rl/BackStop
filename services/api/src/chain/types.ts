import type { Network, OnChainState } from '@backstop/shared';

export interface TokenTransferLog {
  network: Network;
  tokenContract: string;
  from: string;
  to: string;
  amount: bigint;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockTime: Date;
}

export type EscrowEventName = 'EscrowCreated' | 'Delivered' | 'Disputed' | 'Released' | 'Refunded' | 'FeeCollected' | 'ExcessReturned';

export interface EscrowEvent {
  name: EscrowEventName;
  /** Escrow clone address (for EscrowCreated, the new escrow). */
  escrow: string;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockTime: Date;
  args: Record<string, unknown>;
}

export interface OnChainEscrow {
  state: OnChainState;
  holdUntil: bigint;
  disputedAt: bigint;
  feeOwed: bigint;
  feeCollected: boolean;
  payer: string;
  payee: string;
  token: string;
  amount: bigint;
}

export type EscrowFn = 'releaseAfterHold' | 'collectFee' | 'refundAfterArbiterTimeout' | 'refundFrozenPayee' | 'returnExcess';

export interface ChainClient {
  readonly network: Network;
  readonly family: 'evm' | 'tron';
  /** Latest block and the newest block that counts as final for this chain. */
  head(): Promise<{ latest: bigint; final: bigint; finalTime: Date }>;
  isContract(address: string): Promise<boolean>;
  tokenBalance(tokenContract: string, owner: string): Promise<bigint>;
  /** Token transfers to or from any of `addresses` in [fromBlock, toBlock]. */
  transferLogs(tokenContract: string, addresses: string[], fromBlock: bigint, toBlock: bigint): Promise<TokenTransferLog[]>;
  /** Most recent incoming token transfers to `address` (inbound tracing). */
  incomingTransfers(tokenContract: string, address: string, limit: number): Promise<TokenTransferLog[]>;
  escrowEvents(factory: string, escrows: string[], fromBlock: bigint, toBlock: bigint): Promise<EscrowEvent[]>;
  readEscrow(escrow: string): Promise<OnChainEscrow>;
  /** Issuer freeze status (USDC isBlacklisted / USDT isBlackListed). */
  isFrozen(tokenContract: string, address: string): Promise<boolean>;
  /** Relays a transaction the user signed on their device. Idempotent for the same signed bytes. */
  broadcast(signedTx: string): Promise<string>;
  /** Keeper: calls a permissionless time-based escrow function. */
  callEscrow(escrow: string, fn: EscrowFn): Promise<string>;
  /** Arbiter executor (dev/local): calls resolveRelease / resolveRefund. */
  callArbiter?(escrow: string, fn: 'resolveRelease' | 'resolveRefund', rulingHash: `0x${string}`, key: `0x${string}`): Promise<string>;
  txStatus(hash: string): Promise<'pending' | 'success' | 'reverted' | 'unknown'>;
}
