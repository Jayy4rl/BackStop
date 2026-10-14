// Sandbox embedded wallet for mobile (the embedded-wallet vendor is still to be chosen, C2-1).
// The key is created on the device and kept in the OS keystore (iOS Keychain / Android Keystore)
// with `requireAuthentication`, so the OS asks for biometrics or the device passcode to unlock it.
// Backstop's servers only ever learn the addresses.
import * as SecureStore from 'expo-secure-store';
import { generatePrivateKey, privateKeyToAccount, sign, serializeSignature } from 'viem/accounts';
import { createWalletClient, http, type Chain, type Hex } from 'viem';
import { hexToTron, tronMessageHash } from '@backstop/shared';
import { api } from './api';

const KEY = 'bs_wallet_key';
const ADDR = 'bs_wallet_addr';

export interface NewWallet {
  key: Hex;
  evm: Hex;
  tron: string;
}

export function createWallet(): NewWallet {
  const key = generatePrivateKey();
  const evm = privateKeyToAccount(key).address;
  return { key, evm, tron: hexToTron(evm) };
}

export async function storeWallet(w: NewWallet): Promise<void> {
  await SecureStore.setItemAsync(KEY, w.key, { requireAuthentication: true, authenticationPrompt: 'Protect your Backstop wallet', keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  await SecureStore.setItemAsync(ADDR, JSON.stringify({ evm: w.evm, tron: w.tron }));
}

export async function unlock(): Promise<Hex> {
  const k = await SecureStore.getItemAsync(KEY, { requireAuthentication: true, authenticationPrompt: 'Approve with Face ID, fingerprint or passcode' });
  if (!k) throw new Error('No wallet on this device. Recover your account to restore it.');
  return k as Hex;
}

export async function signLink(key: Hex, template: string) {
  const acct = privateKeyToAccount(key);
  const tron = hexToTron(acct.address);
  return {
    evmSignature: await acct.signMessage({ message: template.replace('{address}', acct.address) }),
    tronSignature: serializeSignature(await sign({ hash: tronMessageHash(template.replace('{address}', tron)), privateKey: key })),
  };
}

export interface Bundle {
  network: string;
  chainId?: number;
  calls: Array<{ kind: 'evm'; to: string; data: Hex } | { kind: 'tron'; contract: string; functionSelector: string; parameter: string; feeLimitSun: number }>;
}

/** Signs and sends a call bundle the API built (EVM directly; TRON built via node API and relayed). */
export async function execute(key: Hex, b: Bundle, relay: (signed: string[]) => Promise<string[]>): Promise<string[]> {
  const cfg = await api.get('/public/config');
  const n = cfg.networks.find((x: { network: string }) => x.network === b.network);
  if (!n?.publicRpc) throw new Error(`${b.network} is not available right now.`);
  if (b.network !== 'tron') {
    const chain = { id: n.chainId ?? 1, name: n.label, nativeCurrency: { name: 'native', symbol: 'NATIVE', decimals: 18 }, rpcUrls: { default: { http: [n.publicRpc] } } } as Chain;
    const w = createWalletClient({ chain, transport: http(n.publicRpc), account: privateKeyToAccount(key) });
    const out: string[] = [];
    for (const c of b.calls) if (c.kind === 'evm') out.push(await w.sendTransaction({ to: c.to as Hex, data: c.data }));
    return out;
  }
  const owner = hexToTron(privateKeyToAccount(key).address);
  const signed: string[] = [];
  for (const c of b.calls) {
    if (c.kind !== 'tron') continue;
    const r = await fetch(`${n.publicRpc.replace(/\/$/, '')}/wallet/triggersmartcontract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner_address: owner, contract_address: c.contract, function_selector: c.functionSelector, parameter: c.parameter, fee_limit: c.feeLimitSun, call_value: 0, visible: true }),
    });
    const built = (await r.json()) as { transaction?: { txID: string } };
    if (!built.transaction) throw new Error('Could not prepare the TRON transaction.');
    const sig = serializeSignature(await sign({ hash: `0x${built.transaction.txID}`, privateKey: key }));
    signed.push(JSON.stringify({ ...built.transaction, signature: [sig.slice(2)] }));
  }
  return relay(signed);
}
