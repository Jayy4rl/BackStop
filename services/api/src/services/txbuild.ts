// Builds the unsigned calls the user's embedded wallet signs on the device. Backstop never signs
// for the user (C2-1). Gas: Arc pays gas in USDC natively, Base through a USDC paymaster, TRON
// energy and bandwidth sponsored by Backstop (C2-3) — the wallet provider applies the sponsorship
// named in each call bundle.
import { encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, type Hex } from 'viem';
import { escrowAbi, escrowFactoryAbi, tronToHex, type EscrowTerms, type Network } from '@backstop/shared';

export type Sponsorship = 'arc_native_usdc' | 'base_usdc_paymaster' | 'tron_energy_sponsored' | 'ethereum_usdc_paymaster';

export interface EvmCall {
  kind: 'evm';
  to: string;
  data: Hex;
  value: '0';
  description: string;
}

export interface TronCall {
  kind: 'tron';
  contract: string;
  functionSelector: string;
  parameter: string; // ABI-encoded args, hex without 0x
  feeLimitSun: number;
  description: string;
}

export interface CallBundle {
  network: Network;
  chainId?: number;
  sponsorship: Sponsorship;
  /** EVM smart wallets batch these into one user operation (atomic); TRON sends them in order. */
  atomic: boolean;
  calls: Array<EvmCall | TronCall>;
}

export function sponsorshipFor(network: Network): Sponsorship {
  return network === 'arc' ? 'arc_native_usdc' : network === 'base' ? 'base_usdc_paymaster' : network === 'tron' ? 'tron_energy_sponsored' : 'ethereum_usdc_paymaster';
}

const tronAddr = (a: string) => tronToHex(a);
const FEE_LIMIT = 50_000_000; // 50 TRX ceiling; energy is sponsored

export function transferCall(network: Network, token: string, to: string, amount: bigint, description: string): EvmCall | TronCall {
  if (network === 'tron') {
    return {
      kind: 'tron',
      contract: token,
      functionSelector: 'transfer(address,uint256)',
      parameter: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [tronAddr(to), amount]).slice(2),
      feeLimitSun: FEE_LIMIT,
      description,
    };
  }
  return { kind: 'evm', to: getAddress(token), data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(to), amount] }), value: '0', description };
}

export function approveCall(network: Network, token: string, spender: string, amount: bigint): EvmCall | TronCall {
  const description = `Allow the escrow factory to take exactly this payment (${amount} base units)`;
  if (network === 'tron') {
    return {
      kind: 'tron',
      contract: token,
      functionSelector: 'approve(address,uint256)',
      parameter: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [tronAddr(spender), amount]).slice(2),
      feeLimitSun: FEE_LIMIT,
      description,
    };
  }
  return { kind: 'evm', to: getAddress(token), data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [getAddress(spender), amount] }), value: '0', description };
}

const TERMS_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'payer', type: 'address' },
    { name: 'payee', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'feeBps', type: 'uint16' },
    { name: 'deliverBy', type: 'uint64' },
    { name: 'holdPeriod', type: 'uint32' },
    { name: 'autoRelease', type: 'bool' },
    { name: 'arbiterTimeout', type: 'uint32' },
    { name: 'orderRef', type: 'bytes32' },
  ],
} as const;

/** Terms with chain-native addresses; TRON addresses are converted to their 20-byte form. */
export function encodeTerms(network: Network, t: { payer: string; payee: string; token: string; amount: bigint; feeBps: number; deliverBy: bigint; holdPeriod: number; autoRelease: boolean; arbiterTimeout: number; orderRef: Hex }): EscrowTerms {
  const a = (x: string) => (network === 'tron' ? tronAddr(x) : getAddress(x));
  return { payer: a(t.payer), payee: a(t.payee), token: a(t.token), amount: t.amount, feeBps: t.feeBps, deliverBy: t.deliverBy, holdPeriod: t.holdPeriod, autoRelease: t.autoRelease, arbiterTimeout: t.arbiterTimeout, orderRef: t.orderRef };
}

export function createEscrowCall(network: Network, factory: string, terms: EscrowTerms): EvmCall | TronCall {
  const description = 'Fund the protected payment (creates its own escrow contract)';
  if (network === 'tron') {
    return {
      kind: 'tron',
      contract: factory,
      functionSelector: 'createEscrow((address,address,address,uint256,uint16,uint64,uint32,bool,uint32,bytes32))',
      parameter: encodeAbiParameters([TERMS_TUPLE], [terms]).slice(2),
      feeLimitSun: 150_000_000,
      description,
    };
  }
  return { kind: 'evm', to: getAddress(factory), data: encodeFunctionData({ abi: escrowFactoryAbi, functionName: 'createEscrow', args: [terms] }), value: '0', description };
}

export type PartyFn = 'markDelivered' | 'release' | 'dispute' | 'refundByPayee' | 'reclaimAfterDeadline' | 'releaseAfterHold';

export function escrowCall(network: Network, escrow: string, fn: PartyFn, hash?: Hex): EvmCall | TronCall {
  const withHash = fn === 'markDelivered' || fn === 'dispute';
  const description = {
    markDelivered: 'Mark delivered (starts the hold)',
    release: 'Release the payment to the payee',
    dispute: 'Open a dispute (pauses release)',
    refundByPayee: 'Return the money to the payer',
    reclaimAfterDeadline: 'Reclaim the money after the missed deadline',
    releaseAfterHold: 'Release the payment now that the hold has ended',
  }[fn];
  if (network === 'tron') {
    return {
      kind: 'tron',
      contract: escrow,
      functionSelector: withHash ? `${fn}(bytes32)` : `${fn}()`,
      parameter: withHash ? encodeAbiParameters([{ type: 'bytes32' }], [hash!]).slice(2) : '',
      feeLimitSun: FEE_LIMIT,
      description,
    };
  }
  const data = withHash
    ? encodeFunctionData({ abi: escrowAbi, functionName: fn as 'markDelivered' | 'dispute', args: [hash!] })
    : encodeFunctionData({ abi: escrowAbi, functionName: fn as 'release' | 'refundByPayee' | 'reclaimAfterDeadline' | 'releaseAfterHold' });
  return { kind: 'evm', to: getAddress(escrow), data, value: '0', description };
}

export function bundle(network: Network, calls: Array<EvmCall | TronCall>, chainId?: number): CallBundle {
  return { network, chainId, sponsorship: sponsorshipFor(network), atomic: network !== 'tron', calls };
}
