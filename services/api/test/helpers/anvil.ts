// Local EVM chain with the real contracts deployed (EscrowFactory + Escrow implementation, a mock
// USDC with an issuer blacklist, and the USDC freeze adapter). With { arc: true } the chain behaves
// like Arc: USDC is logged by the system emitter in 18 decimals, its blocklist is the
// NativeCoinControl precompile, and the factory uses the Arc freeze adapter.
import { spawn, type ChildProcess } from 'node:child_process';
import { createPublicClient, createWalletClient, http, parseEther, type Hex, type PublicClient, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ARC_NATIVE_COIN_CONTROL, ARC_SYSTEM_EMITTER, escrowFactoryAbi, escrowFactoryBytecode } from '@backstop/shared';
import {
  arcUsdcFreezeAdapterAbi,
  arcUsdcFreezeAdapterBytecode,
  mockArcSystemEmitterRuntimeBytecode,
  mockArcUsdcAbi,
  mockArcUsdcBytecode,
  mockNativeCoinControlAbi,
  mockNativeCoinControlRuntimeBytecode,
  mockUsdcAbi,
  mockUsdcBytecode,
  usdcFreezeAdapterAbi,
  usdcFreezeAdapterBytecode,
} from '../../../../packages/shared/src/testing.generated.ts';

// anvil's default deterministic accounts
export const KEYS = {
  admin: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  arbiter: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  keeper: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  treasury: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  backupArbiter: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
} as const satisfies Record<string, Hex>;

export interface Anvil {
  url: string;
  chain: Chain;
  pub: PublicClient;
  factory: Hex;
  usdc: Hex;
  stop(): void;
  mint(to: Hex, amount: bigint): Promise<void>;
  fund(to: Hex): Promise<void>;
  setBlacklisted(who: Hex, b: boolean): Promise<void>;
  /** Advances chain time and mines a block; returns the new block timestamp. */
  warp(seconds: number): Promise<Date>;
  time(): Promise<Date>;
  send(key: Hex, calls: Array<{ to: string; data: Hex }>): Promise<Hex[]>;
  /** Arc only: a plain native-coin send of `value18` (18 decimals) from `key`. */
  nativeSend(key: Hex, to: Hex, value18: bigint): Promise<Hex>;
}

export async function startAnvil(opts: { arc?: boolean } = {}): Promise<Anvil> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const proc: ChildProcess = spawn('anvil', ['--port', String(port), '--silent', '--chain-id', '31337', '--timestamp', String(Math.floor(new Date('2026-10-14T10:00:00Z').getTime() / 1000))], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  const chain = { id: 31337, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } } as Chain;
  const pub = createPublicClient({ chain, transport: http(url) }) as PublicClient;
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getBlockNumber();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const admin = createWalletClient({ chain, transport: http(url), account: privateKeyToAccount(KEYS.admin) });
  const deploy = async (abi: readonly unknown[], bytecode: Hex, args: unknown[] = []) => {
    const hash = await admin.deployContract({ abi: abi as never, bytecode, args: args as never });
    const r = await pub.waitForTransactionReceipt({ hash });
    return r.contractAddress!;
  };
  if (opts.arc) {
    await pub.request({ method: 'anvil_setCode' as never, params: [ARC_SYSTEM_EMITTER, mockArcSystemEmitterRuntimeBytecode] as never });
    await pub.request({ method: 'anvil_setCode' as never, params: [ARC_NATIVE_COIN_CONTROL, mockNativeCoinControlRuntimeBytecode] as never });
  }
  const usdc = opts.arc ? await deploy(mockArcUsdcAbi, mockArcUsdcBytecode as Hex) : await deploy(mockUsdcAbi, mockUsdcBytecode as Hex);
  const adapter = opts.arc ? await deploy(arcUsdcFreezeAdapterAbi, arcUsdcFreezeAdapterBytecode as Hex) : await deploy(usdcFreezeAdapterAbi, usdcFreezeAdapterBytecode as Hex);
  const factory = await deploy(escrowFactoryAbi, escrowFactoryBytecode as Hex, [
    privateKeyToAccount(KEYS.admin).address,
    privateKeyToAccount(KEYS.arbiter).address,
    privateKeyToAccount(KEYS.treasury).address,
    500,
    '0xff',
  ]);
  const adminCall = async (fn: string, args: unknown[]) => {
    const hash = await admin.writeContract({ address: factory, abi: escrowFactoryAbi, functionName: fn as never, args: args as never });
    await pub.waitForTransactionReceipt({ hash });
  };
  await adminCall('allowToken', [usdc]);
  await adminCall('setFreezeAdapter', [usdc, adapter]);
  await adminCall('setBackupArbiter', [privateKeyToAccount(KEYS.backupArbiter).address]);

  const a: Anvil = {
    url,
    chain,
    pub,
    factory,
    usdc,
    stop: () => proc.kill('SIGKILL'),
    async mint(to, amount) {
      const hash = await admin.writeContract({ address: usdc, abi: mockUsdcAbi, functionName: 'mint', args: [to, amount] });
      await pub.waitForTransactionReceipt({ hash });
    },
    async fund(to) {
      await pub.request({ method: 'anvil_setBalance' as never, params: [to, `0x${parseEther('10').toString(16)}`] as never });
    },
    async setBlacklisted(who, b) {
      const hash = opts.arc
        ? await admin.writeContract({ address: ARC_NATIVE_COIN_CONTROL, abi: mockNativeCoinControlAbi, functionName: b ? 'blocklist' : 'unBlocklist', args: [who] })
        : await admin.writeContract({ address: usdc, abi: mockUsdcAbi, functionName: 'setBlacklisted', args: [who, b] });
      await pub.waitForTransactionReceipt({ hash });
    },
    async nativeSend(key, to, value18) {
      if (!opts.arc) throw new Error('nativeSend is Arc only');
      const w = createWalletClient({ chain, transport: http(url), account: privateKeyToAccount(key) });
      const hash = await w.writeContract({ address: usdc, abi: mockArcUsdcAbi, functionName: 'nativeSend', args: [to, value18] });
      await pub.waitForTransactionReceipt({ hash });
      return hash;
    },
    async warp(seconds) {
      await pub.request({ method: 'evm_increaseTime' as never, params: [seconds] as never });
      await pub.request({ method: 'evm_mine' as never, params: [] as never });
      return a.time();
    },
    async time() {
      const b = await pub.getBlock({ blockTag: 'latest' });
      return new Date(Number(b.timestamp) * 1000);
    },
    async send(key, calls) {
      const w = createWalletClient({ chain, transport: http(url), account: privateKeyToAccount(key) });
      const hashes: Hex[] = [];
      for (const c of calls) {
        const hash = await w.sendTransaction({ to: c.to as Hex, data: c.data });
        const r = await pub.waitForTransactionReceipt({ hash });
        if (r.status !== 'success') throw new Error(`tx reverted: ${c.to}`);
        hashes.push(hash);
      }
      return hashes;
    },
  };
  return a;
}
