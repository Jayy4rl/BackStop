// Address format and checksum validation (C3 pre-send `invalid_address`): EIP-55 on EVM,
// Base58Check on TRON.
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, getAddress, hexToBytes } from 'viem';
import { NETWORKS, NETWORK_INFO, type AddressFamily, type Network } from './chains.ts';

const b58c = createBase58check(sha256);
const TRON_PREFIX = 0x41;

export type AddressCheck =
  | { valid: true; family: AddressFamily; normalized: string; checksummed: boolean }
  | { valid: false; reason: 'empty' | 'bad_format' | 'bad_checksum' };

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const TRON_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

export function checkEvmAddress(input: string): AddressCheck {
  const a = input.trim();
  if (!a) return { valid: false, reason: 'empty' };
  if (!EVM_RE.test(a)) return { valid: false, reason: 'bad_format' };
  const body = a.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  const normalized = getAddress(a.toLowerCase());
  if (mixed && normalized !== a) return { valid: false, reason: 'bad_checksum' };
  // A single-case address carries no checksum; it is valid but the user gets no typo protection
  // from it, which the app surfaces as `checksummed: false`.
  return { valid: true, family: 'evm', normalized, checksummed: mixed };
}

export function checkTronAddress(input: string): AddressCheck {
  const a = input.trim();
  if (!a) return { valid: false, reason: 'empty' };
  if (!TRON_RE.test(a)) return { valid: false, reason: 'bad_format' };
  let raw: Uint8Array;
  try {
    raw = b58c.decode(a);
  } catch {
    return { valid: false, reason: 'bad_checksum' };
  }
  if (raw.length !== 21 || raw[0] !== TRON_PREFIX) return { valid: false, reason: 'bad_format' };
  return { valid: true, family: 'tron', normalized: a, checksummed: true };
}

export function checkAddress(input: string): AddressCheck {
  const a = input.trim();
  if (a.startsWith('0x') || a.startsWith('0X')) return checkEvmAddress(a);
  if (a.startsWith('T')) return checkTronAddress(a);
  return a ? { valid: false, reason: 'bad_format' } : { valid: false, reason: 'empty' };
}

export function checkAddressForNetwork(input: string, network: Network): AddressCheck {
  const fam = NETWORK_INFO[network].family;
  return fam === 'tron' ? checkTronAddress(input) : checkEvmAddress(input);
}

/**
 * L1-3: networks valid for an address format. Any EVM address fits Base, Arc and Ethereum,
 * so the user must confirm which one the recipient expects.
 */
export function networksForAddress(input: string): Network[] {
  const c = checkAddress(input);
  if (!c.valid) return [];
  return NETWORKS.filter((n) => NETWORK_INFO[n].family === c.family);
}

export function tronToHex(tron: string): `0x${string}` {
  const raw = b58c.decode(tron);
  if (raw.length !== 21 || raw[0] !== TRON_PREFIX) throw new Error('not a TRON address');
  return getAddress(bytesToHex(raw.slice(1)));
}

/** Accepts a 20-byte hex address, or the 21-byte TRON form with its 0x41 prefix (as TRON nodes return it). */
export function hexToTron(hex: string): string {
  const raw = hex.replace(/^0x/i, '');
  const body = raw.length === 42 && raw.startsWith('41') ? raw.slice(2) : raw;
  if (body.length !== 40) throw new Error('expected 20-byte address');
  const bytes = new Uint8Array(21);
  bytes[0] = TRON_PREFIX;
  bytes.set(hexToBytes(`0x${body}`), 1);
  return b58c.encode(bytes);
}

/**
 * Canonical key used for fraud-list and history lookups. EVM addresses are lower-cased
 * (checksums differ only in case); TRON addresses are case-sensitive Base58 and kept as is.
 */
export function addressKey(input: string): string {
  const c = checkAddress(input);
  if (!c.valid) throw new Error(`invalid address: ${input}`);
  return c.family === 'evm' ? c.normalized.toLowerCase() : c.normalized;
}

/** C3 `lookalike_address`: same first and last 4 characters (after the 0x/T prefix) but different. */
export function isLookalike(a: string, b: string): boolean {
  const ka = addressKey(a);
  const kb = addressKey(b);
  if (ka === kb) return false;
  if (ka.startsWith('0x') !== kb.startsWith('0x')) return false;
  const strip = (s: string) => (s.startsWith('0x') ? s.slice(2) : s.slice(1));
  const sa = strip(ka);
  const sb = strip(kb);
  return sa.slice(0, 4) === sb.slice(0, 4) && sa.slice(-4) === sb.slice(-4);
}
