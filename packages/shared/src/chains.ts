// Networks, tokens and finality rules (PRD "Technical constraints: assets and finality").

export const NETWORKS = ['tron', 'base', 'arc', 'ethereum'] as const;
export type Network = (typeof NETWORKS)[number];

export const TOKENS = ['USDT', 'USDC'] as const;
export type Token = (typeof TOKENS)[number];

export type AddressFamily = 'evm' | 'tron';

/** What a network/token pair may be used for in v1. */
export interface AssetUse {
  wallet: boolean;
  escrow: boolean;
  p2p: boolean;
  depositWithdrawOnly: boolean;
}

export interface NetworkInfo {
  network: Network;
  label: string;
  family: AddressFamily;
  tokens: Token[];
  /** Plain-language finality rule shown to users and used by the indexer. */
  finality: string;
  /** Maximum indexer lag allowed behind chain head, in seconds (NFR data freshness). */
  maxIndexerLagSeconds: number;
  /** Rough time until a transfer is final, in seconds, for UI estimates. */
  typicalFinalitySeconds: number;
  gas: string;
}

export const NETWORK_INFO: Record<Network, NetworkInfo> = {
  tron: {
    network: 'tron',
    label: 'TRON',
    family: 'tron',
    tokens: ['USDT'],
    finality: 'Block solidified (19 of 27 Super Representatives)',
    maxIndexerLagSeconds: 30,
    typicalFinalitySeconds: 60,
    gas: 'Energy and bandwidth sponsored by Backstop',
  },
  arc: {
    network: 'arc',
    label: 'Arc',
    family: 'evm',
    tokens: ['USDC'],
    finality: 'Deterministic, under a second',
    maxIndexerLagSeconds: 30,
    typicalFinalitySeconds: 1,
    gas: 'Paid in USDC natively',
  },
  base: {
    network: 'base',
    label: 'Base',
    family: 'evm',
    tokens: ['USDC'],
    finality: "Provider's finalized block tag",
    maxIndexerLagSeconds: 30,
    typicalFinalitySeconds: 15 * 60,
    gas: 'Paid in USDC through a paymaster',
  },
  ethereum: {
    network: 'ethereum',
    label: 'Ethereum',
    family: 'evm',
    tokens: ['USDT', 'USDC'],
    finality: 'Finalized checkpoint, about 15 minutes',
    maxIndexerLagSeconds: 60,
    typicalFinalitySeconds: 15 * 60,
    gas: 'Paid in USDC through a paymaster',
  },
};

export function assetUse(network: Network, token: Token): AssetUse | null {
  if (!NETWORK_INFO[network].tokens.includes(token)) return null;
  if (network === 'ethereum') return { wallet: true, escrow: false, p2p: false, depositWithdrawOnly: true };
  if (network === 'tron') return { wallet: true, escrow: true, p2p: true, depositWithdrawOnly: false };
  // Base and Arc: USDC wallet and escrow
  return { wallet: true, escrow: true, p2p: false, depositWithdrawOnly: false };
}

export function isSupportedPair(network: Network, token: Token): boolean {
  return assetUse(network, token) !== null;
}

/** Pairs that can hold a protected payment (escrow): USDT on TRON, USDC on Base and Arc. */
export const ESCROW_PAIRS: ReadonlyArray<{ network: Network; token: Token }> = [
  { network: 'tron', token: 'USDT' },
  { network: 'arc', token: 'USDC' },
  { network: 'base', token: 'USDC' },
];

/**
 * C2-7: payments between two Backstop users route on the cheapest network both accept:
 * TRON for USDT, Arc for USDC.
 */
export const PREFERRED_INTERNAL_NETWORK: Record<Token, Network> = { USDT: 'tron', USDC: 'arc' };

/** Every stablecoin in scope uses 6 decimals through its token interface (L1-6). */
export const TOKEN_DECIMALS = 6;

/**
 * Canonical token contracts per network. Arc's USDC is the native gas token exposed through an
 * ERC-20 interface (docs.arc.io lists 0x3600… on mainnet, chain 5042, and testnet, 5042002).
 * Testnet deployments override these through server configuration.
 */
export const CANONICAL_TOKENS: Record<'mainnet' | 'testnet', Partial<Record<`${Network}:${Token}`, string>>> = {
  mainnet: {
    'tron:USDT': 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    'base:USDC': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    'arc:USDC': '0x3600000000000000000000000000000000000000',
    'ethereum:USDC': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    'ethereum:USDT': '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  },
  testnet: {
    'tron:USDT': 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
    'base:USDC': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    'arc:USDC': '0x3600000000000000000000000000000000000000',
    'ethereum:USDC': '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  },
};

/**
 * Arc system addresses. USDC is Arc's native coin: every movement (ERC-20 transfers, plain native
 * sends, mints, burns) is logged as a standard Transfer from ARC_SYSTEM_EMITTER in 18 decimals,
 * while the 0x3600… interface logs only its own transfers, in 6. The blocklist is the
 * NativeCoinControl precompile (`isBlocklisted(address)`, events Blocklisted / UnBlocklisted).
 */
export const ARC_SYSTEM_EMITTER = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE';
export const ARC_NATIVE_COIN_CONTROL = '0x1800000000000000000000000000000000000001';
/** Native (18 decimals) to token units (6 decimals). */
export const ARC_NATIVE_SCALE = 10n ** 12n;

export function pairKey(network: Network, token: Token): `${Network}:${Token}` {
  return `${network}:${token}`;
}

/** CCTP (C2-8): expected wait when moving USDC between Base and Arc. */
export const CCTP_ESTIMATE = {
  standardSeconds: { min: 15 * 60, max: 19 * 60 },
  fastSeconds: { min: 8, max: 20 },
} as const;
