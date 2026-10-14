// Proof of address control for appeals (C5 appeals step 2): EIP-191 on EVM,
// TronWeb `signMessageV2` on TRON.
import { concat, keccak256, recoverAddress, recoverMessageAddress, stringToBytes, type Hex } from 'viem';
import { checkAddress, hexToTron } from './address.ts';

export const TRON_MESSAGE_PREFIX = '\x19TRON Signed Message:\n';

export interface OwnershipChallenge {
  address: string;
  nonce: string;
  purpose: 'appeal';
  issuedAt: string; // ISO
  expiresAt: string; // ISO
}

/** The exact one-time message the appellant signs. Plain text so wallets display it readably. */
export function challengeMessage(c: OwnershipChallenge): string {
  return [
    'Backstop: prove you control this address',
    `Purpose: ${c.purpose}`,
    `Address: ${c.address}`,
    `Nonce: ${c.nonce}`,
    `Issued: ${c.issuedAt}`,
    `Expires: ${c.expiresAt}`,
    'Signing this message does not move funds or approve any transaction.',
  ].join('\n');
}

/** Hash used by TronWeb's `signMessageV2` / `verifyMessageV2` for a string message. */
export function tronMessageHash(message: string): Hex {
  const body = stringToBytes(message);
  return keccak256(concat([stringToBytes(TRON_MESSAGE_PREFIX), stringToBytes(String(body.length)), body]));
}

function asHexSignature(sig: string): Hex {
  const s = sig.trim();
  const h = (s.startsWith('0x') ? s : `0x${s}`) as Hex;
  if (!/^0x[0-9a-fA-F]{130}$/.test(h)) throw new Error('signature must be 65 bytes');
  return h;
}

/** Recovers the signer of `message`. Returns the address in the family's display format. */
export async function recoverSigner(family: 'evm' | 'tron', message: string, signature: string): Promise<string> {
  const sig = asHexSignature(signature);
  if (family === 'evm') return recoverMessageAddress({ message, signature: sig });
  const evm = await recoverAddress({ hash: tronMessageHash(message), signature: sig });
  return hexToTron(evm);
}

/** True when `signature` over `message` was produced by the key controlling `address`. */
export async function verifyOwnership(address: string, message: string, signature: string): Promise<boolean> {
  const c = checkAddress(address);
  if (!c.valid) return false;
  try {
    const signer = await recoverSigner(c.family, message, signature);
    return c.family === 'evm' ? signer.toLowerCase() === c.normalized.toLowerCase() : signer === c.normalized;
  } catch {
    return false;
  }
}
