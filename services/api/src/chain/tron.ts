// TRON through the TronGrid HTTP API (or any java-tron full node exposing the same endpoints),
// with failover across providers. Finality = solidified blocks (19 of 27 Super Representatives).
import { createHash } from 'node:crypto';
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, type Hex } from 'viem';
import { sign, serializeSignature } from 'viem/accounts';
import { escrowAbi, hexToTron, OnChainState, tronToHex, type Network } from '@backstop/shared';
import type { ChainClient, EscrowEvent, EscrowEventName, EscrowFn, OnChainEscrow, TokenTransferLog } from './types.ts';

type Fetch = typeof fetch;

export interface TronClientOptions {
  hosts: string[];
  apiKey?: string;
  keeperKey?: string;
  feeLimitSun?: number;
  fetchImpl?: Fetch;
}

interface GridTrc20 {
  transaction_id: string;
  from: string;
  to: string;
  value: string;
  block_timestamp: number;
  token_info: { address: string };
}

interface GridEvent {
  block_number: number;
  block_timestamp: number;
  transaction_id: string;
  event_index: number;
  event_name: string;
  contract_address: string;
  result: Record<string, string>;
}

export class TronChainClient implements ChainClient {
  readonly family = 'tron' as const;
  readonly network: Network = 'tron';
  private readonly f: Fetch;

  constructor(private readonly opts: TronClientOptions) {
    if (!opts.hosts.length) throw new Error('TRON needs at least one node host');
    this.f = opts.fetchImpl ?? fetch;
  }

  /** Tries each provider in turn (failover); throws the last error if all fail. */
  private async call<T>(path: string, body?: unknown): Promise<T> {
    let last: unknown;
    for (const host of this.opts.hosts) {
      try {
        const r = await this.f(`${host.replace(/\/$/, '')}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json', ...(this.opts.apiKey ? { 'TRON-PRO-API-KEY': this.opts.apiKey } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
        return (await r.json()) as T;
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  async head() {
    const latest = await this.call<{ block_header: { raw_data: { number: number } } }>('/wallet/getnowblock', {});
    const solid = await this.call<{ block_header: { raw_data: { number: number; timestamp: number } } }>('/walletsolidity/getnowblock', {});
    return {
      latest: BigInt(latest.block_header.raw_data.number),
      final: BigInt(solid.block_header.raw_data.number),
      finalTime: new Date(solid.block_header.raw_data.timestamp),
    };
  }

  async isContract(address: string) {
    const r = await this.call<Record<string, unknown>>('/wallet/getcontract', { value: address, visible: true });
    return !!r && Object.keys(r).length > 0 && ('bytecode' in r || 'contract_address' in r);
  }

  private async constant(contract: string, selector: string, parameter: string): Promise<string> {
    const r = await this.call<{ constant_result?: string[]; result?: { result?: boolean; message?: string } }>('/wallet/triggerconstantcontract', {
      owner_address: contract,
      contract_address: contract,
      function_selector: selector,
      parameter,
      visible: true,
    });
    const out = r.constant_result?.[0];
    if (out === undefined) throw new Error(`constant call ${selector} failed: ${r.result?.message ?? 'no result'}`);
    return out;
  }

  private addrParam(address: string): string {
    return encodeAbiParameters([{ type: 'address' }], [tronToHex(address)]).slice(2);
  }

  async tokenBalance(token: string, owner: string) {
    return BigInt(`0x${(await this.constant(token, 'balanceOf(address)', this.addrParam(owner))) || '0'}`);
  }

  private async blockTimestamp(n: bigint): Promise<number> {
    const b = await this.call<{ block_header?: { raw_data: { timestamp: number } } }>('/wallet/getblockbynum', { num: Number(n) });
    if (!b.block_header) throw new Error(`block ${n} not found`);
    return b.block_header.raw_data.timestamp;
  }

  /** Finds block number and log index of a TRC-20 Transfer inside a confirmed transaction. */
  private async locate(txId: string, token: string, from: string, to: string, value: bigint): Promise<{ blockNumber: bigint; logIndex: number } | null> {
    const info = await this.call<{ blockNumber?: number; log?: Array<{ address: string; topics: string[]; data: string }> }>('/walletsolidity/gettransactioninfobyid', { value: txId });
    if (!info.blockNumber) return null;
    const logs = info.log ?? [];
    for (let i = 0; i < logs.length; i++) {
      const l = logs[i]!;
      if (hexToTron(l.address) !== token || l.topics.length !== 3) continue;
      const lf = hexToTron(`0x${l.topics[1]!.slice(-40)}`);
      const lt = hexToTron(`0x${l.topics[2]!.slice(-40)}`);
      if (lf === from && lt === to && BigInt(`0x${l.data || '0'}`) === value) return { blockNumber: BigInt(info.blockNumber), logIndex: i };
    }
    return null;
  }

  private async trc20(address: string, token: string, query: string): Promise<GridTrc20[]> {
    const out: GridTrc20[] = [];
    let url: string | null = `/v1/accounts/${address}/transactions/trc20?only_confirmed=true&limit=200&contract_address=${token}&${query}`;
    while (url && out.length < 2_000) {
      const page: { data?: GridTrc20[]; meta?: { links?: { next?: string } } } = await this.call(url);
      out.push(...(page.data ?? []));
      const next: string | undefined = page.meta?.links?.next;
      url = next ? next.replace(/^https?:\/\/[^/]+/, '') : null;
    }
    return out;
  }

  async transferLogs(token: string, addresses: string[], fromBlock: bigint, toBlock: bigint) {
    const [minTs, maxTs] = await Promise.all([this.blockTimestamp(fromBlock), this.blockTimestamp(toBlock)]);
    const seen = new Set<string>();
    const out: TokenTransferLog[] = [];
    for (const a of addresses) {
      for (const t of await this.trc20(a, token, `min_timestamp=${minTs}&max_timestamp=${maxTs}&order_by=block_timestamp,asc`)) {
        const value = BigInt(t.value);
        const loc = await this.locate(t.transaction_id, token, t.from, t.to, value);
        if (!loc || loc.blockNumber < fromBlock || loc.blockNumber > toBlock) continue;
        const k = `${t.transaction_id}:${loc.logIndex}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ network: 'tron', tokenContract: token, from: t.from, to: t.to, amount: value, txHash: t.transaction_id, logIndex: loc.logIndex, blockNumber: loc.blockNumber, blockTime: new Date(t.block_timestamp) });
      }
    }
    return out.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  }

  async incomingTransfers(token: string, address: string, limit: number) {
    const rows = (await this.trc20(address, token, 'only_to=true&order_by=block_timestamp,desc')).slice(0, limit);
    return rows.map((t, i) => ({
      network: 'tron' as const,
      tokenContract: token,
      from: t.from,
      to: t.to,
      amount: BigInt(t.value),
      txHash: t.transaction_id,
      logIndex: i,
      blockNumber: 0n,
      blockTime: new Date(t.block_timestamp),
    }));
  }

  private async events(contract: string, minTs: number, maxTs: number): Promise<GridEvent[]> {
    const out: GridEvent[] = [];
    let url: string | null = `/v1/contracts/${contract}/events?only_confirmed=true&limit=200&order_by=block_timestamp,asc&min_block_timestamp=${minTs}&max_block_timestamp=${maxTs}`;
    while (url) {
      const page: { data?: GridEvent[]; meta?: { links?: { next?: string } } } = await this.call(url);
      out.push(...(page.data ?? []));
      const next: string | undefined = page.meta?.links?.next;
      url = next ? next.replace(/^https?:\/\/[^/]+/, '') : null;
    }
    return out;
  }

  async escrowEvents(factory: string, escrows: string[], fromBlock: bigint, toBlock: bigint) {
    const [minTs, maxTs] = await Promise.all([this.blockTimestamp(fromBlock), this.blockTimestamp(toBlock)]);
    const out: EscrowEvent[] = [];
    const toAddr = (v: string | undefined) => (v ? hexToTron(v) : '');
    const created = (await this.events(factory, minTs, maxTs)).filter((e) => e.event_name === 'EscrowCreated');
    for (const e of created) {
      out.push({
        name: 'EscrowCreated',
        escrow: toAddr(e.result.escrow),
        txHash: e.transaction_id,
        logIndex: e.event_index,
        blockNumber: BigInt(e.block_number),
        blockTime: new Date(e.block_timestamp),
        args: { ...e.result, escrow: toAddr(e.result.escrow), payer: toAddr(e.result.payer), payee: toAddr(e.result.payee), token: toAddr(e.result.token), amount: BigInt(e.result.amount ?? '0') },
      });
    }
    const all = new Set([...escrows, ...created.map((c) => toAddr(c.result.escrow))]);
    for (const esc of all) {
      for (const e of await this.events(esc, minTs, maxTs)) {
        if (!['Delivered', 'Disputed', 'Released', 'Refunded', 'FeeCollected', 'ExcessReturned'].includes(e.event_name)) continue;
        const args: Record<string, unknown> = { ...e.result };
        for (const k of ['toPayee', 'feeOwed', 'toPayer', 'amount', 'holdUntil']) if (args[k] !== undefined) args[k] = BigInt(String(args[k]));
        out.push({ name: e.event_name as EscrowEventName, escrow: esc, txHash: e.transaction_id, logIndex: e.event_index, blockNumber: BigInt(e.block_number), blockTime: new Date(e.block_timestamp), args });
      }
    }
    return out.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  }

  async readEscrow(escrow: string): Promise<OnChainEscrow> {
    const call = async (fn: 'state' | 'holdUntil' | 'disputedAt' | 'feeOwed' | 'feeCollected' | 'terms') => {
      const data = encodeFunctionData({ abi: escrowAbi, functionName: fn });
      const out = await this.constant(escrow, `${fn}()`, data.slice(10));
      return decodeFunctionResult({ abi: escrowAbi, functionName: fn, data: `0x${out}` as Hex });
    };
    const [state, holdUntil, disputedAt, feeOwed, feeCollected, terms] = await Promise.all([call('state'), call('holdUntil'), call('disputedAt'), call('feeOwed'), call('feeCollected'), call('terms')]);
    const t = terms as { payer: Hex; payee: Hex; token: Hex; amount: bigint };
    return {
      state: Number(state) as OnChainState,
      holdUntil: BigInt(holdUntil as bigint | number),
      disputedAt: BigInt(disputedAt as bigint | number),
      feeOwed: feeOwed as bigint,
      feeCollected: feeCollected as boolean,
      payer: hexToTron(t.payer),
      payee: hexToTron(t.payee),
      token: hexToTron(t.token),
      amount: t.amount,
    };
  }

  async isFrozen(token: string, address: string) {
    for (const sel of ['isBlackListed(address)', 'getBlackListStatus(address)']) {
      try {
        const out = await this.constant(token, sel, this.addrParam(address));
        if (out) return BigInt(`0x${out}`) !== 0n;
      } catch {
        // try next selector
      }
    }
    return false;
  }

  async broadcast(signedTx: string) {
    // Signed transactions arrive as protobuf hex, or as the signed JSON TronWeb/TronGrid produce.
    if (signedTx.trim().startsWith('{')) {
      const tx = JSON.parse(signedTx) as { txID: string };
      const r = await this.call<{ result?: boolean; code?: string; message?: string }>('/wallet/broadcasttransaction', tx);
      if (r.result || r.code === 'DUP_TRANSACTION_ERROR') return tx.txID;
      throw new Error(`broadcast failed: ${r.code ?? ''} ${r.message ? Buffer.from(r.message, 'hex').toString() : ''}`.trim());
    }
    const r = await this.call<{ result?: boolean; txid?: string; code?: string; message?: string }>('/wallet/broadcasthex', { transaction: signedTx.replace(/^0x/, '') });
    if (r.result && r.txid) return r.txid;
    if (r.code === 'DUP_TRANSACTION_ERROR' && r.txid) return r.txid; // already broadcast: same bytes, same tx
    throw new Error(`broadcast failed: ${r.code ?? ''} ${r.message ? Buffer.from(r.message, 'hex').toString() : ''}`.trim());
  }

  /** Builds, signs and broadcasts a contract call from a hot key (keeper / local arbiter). */
  private async sendCall(key: Hex, contract: string, selector: string, parameter: string): Promise<string> {
    const { privateKeyToAccount } = await import('viem/accounts');
    const owner = hexToTron(privateKeyToAccount(key).address);
    const built = await this.call<{ transaction?: { txID: string; raw_data: unknown; raw_data_hex: string }; result?: { result?: boolean; message?: string } }>('/wallet/triggersmartcontract', {
      owner_address: owner,
      contract_address: contract,
      function_selector: selector,
      parameter,
      fee_limit: this.opts.feeLimitSun ?? 50_000_000,
      call_value: 0,
      visible: true,
    });
    if (!built.transaction) throw new Error(`trigger failed: ${built.result?.message ?? 'unknown'}`);
    const txID = createHash('sha256').update(Buffer.from(built.transaction.raw_data_hex, 'hex')).digest('hex');
    if (txID !== built.transaction.txID) throw new Error('node returned a transaction whose ID does not match its raw data');
    const sig = serializeSignature(await sign({ hash: `0x${txID}`, privateKey: key }));
    const r = await this.call<{ result?: boolean; code?: string }>('/wallet/broadcasttransaction', { ...built.transaction, signature: [sig.slice(2)], visible: true });
    if (!r.result) throw new Error(`broadcast failed: ${r.code ?? 'unknown'}`);
    return txID;
  }

  async callEscrow(escrow: string, fn: EscrowFn) {
    if (!this.opts.keeperKey) throw new Error('no keeper key configured for tron');
    return this.sendCall(this.opts.keeperKey as Hex, escrow, `${fn}()`, '');
  }

  async callArbiter(escrow: string, fn: 'resolveRelease' | 'resolveRefund', rulingHash: Hex, key: Hex) {
    return this.sendCall(key, escrow, `${fn}(bytes32)`, rulingHash.slice(2));
  }

  async freezeEvents(token: string, fromBlock: bigint, toBlock: bigint) {
    const [minTs, maxTs] = await Promise.all([this.blockTimestamp(fromBlock), this.blockTimestamp(toBlock)]);
    const out: Array<{ address: string; frozen: boolean; txHash: string; blockNumber: bigint }> = [];
    for (const e of await this.events(token, minTs, maxTs)) {
      if (!['AddedBlackList', 'RemovedBlackList'].includes(e.event_name)) continue;
      const raw = e.result._user ?? e.result.user ?? Object.values(e.result)[0];
      if (!raw) continue;
      out.push({ address: hexToTron(raw), frozen: e.event_name === 'AddedBlackList', txHash: e.transaction_id, blockNumber: BigInt(e.block_number) });
    }
    return out;
  }

  async txStatus(hash: string) {
    const info = await this.call<{ blockNumber?: number; receipt?: { result?: string } }>('/walletsolidity/gettransactioninfobyid', { value: hash });
    if (!info.blockNumber) return 'pending';
    return !info.receipt?.result || info.receipt.result === 'SUCCESS' ? 'success' : 'reverted';
  }
}
