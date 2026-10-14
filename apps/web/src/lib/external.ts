// External wallets for clients, suppliers and appellants without a Backstop wallet: EIP-1193
// (MetaMask, Coinbase Wallet, etc.) on EVM and TronLink on TRON.
import type { Bundle } from './wallet';

declare global {
  interface Window {
    ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<any> };
    tronWeb?: any;
  }
}

export function hasEvmWallet() {
  return typeof window !== 'undefined' && !!window.ethereum;
}
export function hasTronWallet() {
  return typeof window !== 'undefined' && !!window.tronWeb?.defaultAddress?.base58;
}

export async function evmAccount(chainId?: number | null): Promise<string> {
  if (!window.ethereum) throw new Error('No EVM wallet found. Install one, or open this page in your wallet app.');
  const [acct] = await window.ethereum.request({ method: 'eth_requestAccounts' });
  if (chainId) {
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${chainId.toString(16)}` }] });
    } catch {
      throw new Error('Switch your wallet to the right network and try again.');
    }
  }
  return acct;
}

export function tronAccount(): string {
  const a = window.tronWeb?.defaultAddress?.base58;
  if (!a) throw new Error('Open TronLink and unlock it to continue.');
  return a;
}

/** Sends a call bundle from an external wallet; returns transaction hashes. */
export async function sendExternal(b: Bundle, from: string): Promise<string[]> {
  const out: string[] = [];
  for (const c of b.calls) {
    if (c.kind === 'evm') {
      out.push(await window.ethereum!.request({ method: 'eth_sendTransaction', params: [{ from, to: c.to, data: c.data }] }));
    } else {
      const tw = window.tronWeb;
      const built = await tw.transactionBuilder.triggerSmartContract(c.contract, c.functionSelector, { feeLimit: c.feeLimitSun, rawParameter: c.parameter }, [], from);
      const signed = await tw.trx.sign(built.transaction);
      const r = await tw.trx.sendRawTransaction(signed);
      if (!r.result) throw new Error('TRON rejected the transaction.');
      out.push(signed.txID);
    }
  }
  return out;
}

export async function signMessageExternal(family: 'evm' | 'tron', address: string, message: string): Promise<string> {
  if (family === 'evm') {
    if (!window.ethereum) throw new Error('No EVM wallet found.');
    return window.ethereum.request({ method: 'personal_sign', params: [message, address] });
  }
  if (!window.tronWeb?.trx?.signMessageV2) throw new Error('Open TronLink to sign.');
  return window.tronWeb.trx.signMessageV2(message);
}
