// In-memory ChainClient for check and keeper tests that don't need a real node. End-to-end tests
// use a real anvil chain with the deployed contracts instead.
import type { Network } from '@backstop/shared';
import type { ChainClient, EscrowEvent, EscrowFn, OnChainEscrow, TokenTransferLog } from '../../src/chain/types.ts';

export class FakeChain implements ChainClient {
  readonly family: 'evm' | 'tron';
  contracts = new Set<string>();
  frozen = new Set<string>();
  balances = new Map<string, bigint>();
  incoming = new Map<string, TokenTransferLog[]>();
  calls: Array<{ escrow: string; fn: string }> = [];
  failCalls = false;
  slowMs = 0;
  constructor(readonly network: Network) {
    this.family = network === 'tron' ? 'tron' : 'evm';
  }
  async head() {
    return { latest: 100n, final: 100n, finalTime: new Date() };
  }
  async isContract(a: string) {
    if (this.slowMs) await new Promise((r) => setTimeout(r, this.slowMs));
    return this.contracts.has(a.toLowerCase());
  }
  async tokenBalance(_t: string, owner: string) {
    return this.balances.get(owner.toLowerCase()) ?? 0n;
  }
  async transferLogs(): Promise<TokenTransferLog[]> {
    return [];
  }
  async incomingTransfers(_t: string, address: string) {
    return this.incoming.get(address.toLowerCase()) ?? [];
  }
  async escrowEvents(): Promise<EscrowEvent[]> {
    return [];
  }
  async readEscrow(): Promise<OnChainEscrow> {
    throw new Error('not implemented');
  }
  async isFrozen(_t: string, a: string) {
    return this.frozen.has(a.toLowerCase());
  }
  async broadcast(signed: string) {
    return `0x${signed.slice(-64).padStart(64, '0')}`;
  }
  async callEscrow(escrow: string, fn: EscrowFn) {
    if (this.failCalls) throw new Error('keeper rpc down');
    this.calls.push({ escrow, fn });
    return `0x${'ab'.repeat(32)}`;
  }
  async txStatus() {
    return 'success' as const;
  }
  async freezeEvents() {
    return [];
  }
}
