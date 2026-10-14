// EVM chains (Base, Arc, Ethereum) through viem, with automatic failover across the configured
// node providers (PRD: two node providers per chain).
import {
  createPublicClient,
  createWalletClient,
  fallback,
  getAddress,
  http,
  keccak256,
  parseAbiItem,
  type Hex,
  type PublicClient,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { escrowAbi, escrowFactoryAbi, OnChainState, type Network } from '@backstop/shared';
import type { ChainClient, EscrowEvent, EscrowFn, OnChainEscrow, TokenTransferLog } from './types.ts';

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'isBlacklisted', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'isBlackListed', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'bool' }] },
] as const;

const MAX_RANGE = 2_000n;
const ADDRESS_CHUNK = 200;

export interface EvmClientOptions {
  network: Network;
  rpcUrls: string[];
  chainId?: number;
  finality: 'finalized' | 'latest' | 'solidified';
  keeperKey?: string;
}

export class EvmChainClient implements ChainClient {
  readonly family = 'evm' as const;
  readonly network: Network;
  private readonly client: PublicClient;
  private readonly chain: Chain | undefined;
  private readonly blockTimes = new Map<bigint, Date>();

  constructor(private readonly opts: EvmClientOptions) {
    this.network = opts.network;
    this.chain = opts.chainId
      ? ({ id: opts.chainId, name: opts.network, nativeCurrency: { name: 'native', symbol: 'NATIVE', decimals: 18 }, rpcUrls: { default: { http: opts.rpcUrls } } } as Chain)
      : undefined;
    this.client = createPublicClient({
      chain: this.chain,
      transport: fallback(opts.rpcUrls.map((u) => http(u, { timeout: 10_000, retryCount: 1 })), { rank: false }),
    }) as PublicClient;
  }

  async head() {
    const latest = await this.client.getBlock({ blockTag: 'latest' });
    const final = this.opts.finality === 'finalized' ? await this.client.getBlock({ blockTag: 'finalized' }) : latest;
    return { latest: latest.number!, final: final.number!, finalTime: new Date(Number(final.timestamp) * 1000) };
  }

  async isContract(address: string) {
    const code = await this.client.getCode({ address: getAddress(address) });
    return !!code && code !== '0x';
  }

  async tokenBalance(token: string, owner: string) {
    return this.client.readContract({ address: getAddress(token), abi: erc20Abi, functionName: 'balanceOf', args: [getAddress(owner)] });
  }

  private async blockTime(n: bigint): Promise<Date> {
    const hit = this.blockTimes.get(n);
    if (hit) return hit;
    const b = await this.client.getBlock({ blockNumber: n });
    const d = new Date(Number(b.timestamp) * 1000);
    if (this.blockTimes.size > 5_000) this.blockTimes.clear();
    this.blockTimes.set(n, d);
    return d;
  }

  private async toTransfers(token: string, logs: Array<{ args: { from?: Hex; to?: Hex; value?: bigint }; transactionHash: Hex | null; logIndex: number | null; blockNumber: bigint | null }>): Promise<TokenTransferLog[]> {
    const out: TokenTransferLog[] = [];
    for (const l of logs) {
      if (!l.transactionHash || l.logIndex === null || l.blockNumber === null) continue;
      out.push({
        network: this.network,
        tokenContract: getAddress(token),
        from: getAddress(l.args.from!),
        to: getAddress(l.args.to!),
        amount: l.args.value!,
        txHash: l.transactionHash,
        logIndex: l.logIndex,
        blockNumber: l.blockNumber,
        blockTime: await this.blockTime(l.blockNumber),
      });
    }
    return out;
  }

  async transferLogs(token: string, addresses: string[], fromBlock: bigint, toBlock: bigint) {
    const seen = new Set<string>();
    const out: TokenTransferLog[] = [];
    const addrs = addresses.map((a) => getAddress(a));
    for (let start = fromBlock; start <= toBlock; start += MAX_RANGE) {
      const end = start + MAX_RANGE - 1n < toBlock ? start + MAX_RANGE - 1n : toBlock;
      for (let i = 0; i < addrs.length; i += ADDRESS_CHUNK) {
        const chunk = addrs.slice(i, i + ADDRESS_CHUNK);
        for (const args of [{ to: chunk }, { from: chunk }]) {
          const logs = await this.client.getLogs({ address: getAddress(token), event: transferEvent, args, fromBlock: start, toBlock: end });
          for (const t of await this.toTransfers(token, logs)) {
            const k = `${t.txHash}:${t.logIndex}`;
            if (!seen.has(k)) {
              seen.add(k);
              out.push(t);
            }
          }
        }
      }
    }
    return out.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  }

  async incomingTransfers(token: string, address: string, limit: number) {
    const { latest } = await this.head();
    const window = 50_000n;
    const from = latest > window ? latest - window : 0n;
    const logs: TokenTransferLog[] = [];
    for (let end = latest; end >= from && logs.length < limit; end -= MAX_RANGE) {
      const start = end - MAX_RANGE + 1n > from ? end - MAX_RANGE + 1n : from;
      const l = await this.client.getLogs({ address: getAddress(token), event: transferEvent, args: { to: getAddress(address) }, fromBlock: start, toBlock: end });
      logs.unshift(...(await this.toTransfers(token, l)));
      if (start === from) break;
    }
    return logs.slice(-limit);
  }

  async escrowEvents(factory: string, escrows: string[], fromBlock: bigint, toBlock: bigint) {
    const out: EscrowEvent[] = [];
    for (let start = fromBlock; start <= toBlock; start += MAX_RANGE) {
      const end = start + MAX_RANGE - 1n < toBlock ? start + MAX_RANGE - 1n : toBlock;
      const created = await this.client.getContractEvents({ address: getAddress(factory), abi: escrowFactoryAbi, eventName: 'EscrowCreated', fromBlock: start, toBlock: end });
      for (const l of created) {
        const a = l.args as { escrow: Hex };
        out.push({ name: 'EscrowCreated', escrow: getAddress(a.escrow), txHash: l.transactionHash!, logIndex: l.logIndex!, blockNumber: l.blockNumber!, blockTime: await this.blockTime(l.blockNumber!), args: l.args as Record<string, unknown> });
      }
      const known = [...new Set([...escrows.map((e) => getAddress(e)), ...created.map((l) => getAddress((l.args as { escrow: Hex }).escrow))])];
      for (let i = 0; i < known.length; i += ADDRESS_CHUNK) {
        const chunk = known.slice(i, i + ADDRESS_CHUNK);
        if (!chunk.length) continue;
        const logs = await this.client.getContractEvents({ address: chunk, abi: escrowAbi, fromBlock: start, toBlock: end });
        for (const l of logs) {
          const name = l.eventName as EscrowEvent['name'];
          if (!['Delivered', 'Disputed', 'Released', 'Refunded', 'FeeCollected', 'ExcessReturned'].includes(name)) continue;
          out.push({ name, escrow: getAddress(l.address), txHash: l.transactionHash!, logIndex: l.logIndex!, blockNumber: l.blockNumber!, blockTime: await this.blockTime(l.blockNumber!), args: l.args as Record<string, unknown> });
        }
      }
    }
    return out.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  }

  async readEscrow(escrow: string): Promise<OnChainEscrow> {
    const address = getAddress(escrow);
    const [state, holdUntil, disputedAt, feeOwed, feeCollected, terms] = await Promise.all([
      this.client.readContract({ address, abi: escrowAbi, functionName: 'state' }),
      this.client.readContract({ address, abi: escrowAbi, functionName: 'holdUntil' }),
      this.client.readContract({ address, abi: escrowAbi, functionName: 'disputedAt' }),
      this.client.readContract({ address, abi: escrowAbi, functionName: 'feeOwed' }),
      this.client.readContract({ address, abi: escrowAbi, functionName: 'feeCollected' }),
      this.client.readContract({ address, abi: escrowAbi, functionName: 'terms' }),
    ]);
    const t = terms as { payer: Hex; payee: Hex; token: Hex; amount: bigint };
    return { state: Number(state) as OnChainState, holdUntil: BigInt(holdUntil), disputedAt: BigInt(disputedAt), feeOwed, feeCollected, payer: t.payer, payee: t.payee, token: t.token, amount: t.amount };
  }

  async isFrozen(token: string, address: string) {
    for (const fn of ['isBlacklisted', 'isBlackListed'] as const) {
      try {
        return await this.client.readContract({ address: getAddress(token), abi: erc20Abi, functionName: fn, args: [getAddress(address)] });
      } catch {
        // try the other naming
      }
    }
    return false;
  }

  async broadcast(signedTx: string) {
    const raw = signedTx as Hex;
    const hash = keccak256(raw);
    try {
      return await this.client.sendRawTransaction({ serializedTransaction: raw });
    } catch (e) {
      // Re-sending the same signed bytes is harmless: report the hash if the node already has it.
      if (/already known|nonce too low|known transaction/i.test(String((e as Error).message))) return hash;
      throw e;
    }
  }

  private wallet(key: string) {
    return createWalletClient({
      account: privateKeyToAccount(key as Hex),
      chain: this.chain,
      transport: fallback(this.opts.rpcUrls.map((u) => http(u))),
    });
  }

  async callEscrow(escrow: string, fn: EscrowFn) {
    if (!this.opts.keeperKey) throw new Error(`no keeper key configured for ${this.network}`);
    const w = this.wallet(this.opts.keeperKey);
    const { request } = await this.client.simulateContract({ account: w.account, address: getAddress(escrow), abi: escrowAbi, functionName: fn });
    return w.writeContract(request);
  }

  async callArbiter(escrow: string, fn: 'resolveRelease' | 'resolveRefund', rulingHash: Hex, key: Hex) {
    const w = this.wallet(key);
    const { request } = await this.client.simulateContract({ account: w.account, address: getAddress(escrow), abi: escrowAbi, functionName: fn, args: [rulingHash] });
    return w.writeContract(request);
  }

  async txStatus(hash: string) {
    try {
      const r = await this.client.getTransactionReceipt({ hash: hash as Hex });
      return r.status === 'success' ? 'success' : 'reverted';
    } catch {
      try {
        await this.client.getTransaction({ hash: hash as Hex });
        return 'pending';
      } catch {
        return 'unknown';
      }
    }
  }
}
