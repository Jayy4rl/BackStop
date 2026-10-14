// Sandbox embedded wallet (the PRD leaves the embedded-wallet vendor to be chosen; this is the
// integration point). Keys are created on this device and never leave it: Backstop's servers only
// learn the addresses and a signature proving them. The key is stored encrypted in IndexedDB,
// wrapped by a non-extractable WebCrypto key; where the browser supports the WebAuthn PRF
// extension it is re-wrapped with a key derived from the passkey, so only the passkey unlocks it.
import { generatePrivateKey, privateKeyToAccount, sign, serializeSignature } from 'viem/accounts';
import { createWalletClient, http, type Hex, type Chain } from 'viem';
import { hexToTron, tronMessageHash } from '@backstop/shared';
import { publicConfig } from './api';

const DB = 'backstop-wallet';
const STORE = 'keys';

interface Stored {
  id: 'wallet';
  mode: 'device' | 'passkey';
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  deviceKey?: CryptoKey;
  prfSalt?: ArrayBuffer;
  evm: string;
  tron: string;
}

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function put(v: Stored): Promise<void> {
  const db = await idb();
  await new Promise<void>((res, rej) => {
    const t = db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).put(v);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

async function get(): Promise<Stored | null> {
  const db = await idb();
  return new Promise((res, rej) => {
    const r = db.transaction(STORE).objectStore(STORE).get('wallet');
    r.onsuccess = () => res((r.result as Stored) ?? null);
    r.onerror = () => rej(r.error);
  });
}

async function prfKey(prf: ArrayBuffer): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('backstop-wallet-v1'), info: new Uint8Array() }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

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

/** Stores a new wallet wrapped by a non-extractable device key. */
export async function storeWallet(w: NewWallet): Promise<void> {
  const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, deviceKey, new TextEncoder().encode(w.key));
  await put({ id: 'wallet', mode: 'device', iv: iv.buffer, ciphertext, deviceKey, evm: w.evm, tron: w.tron });
}

export async function walletInfo(): Promise<{ evm: string; tron: string; mode: 'device' | 'passkey' } | null> {
  const s = await get();
  return s ? { evm: s.evm, tron: s.tron, mode: s.mode } : null;
}

/** PRF salt to request with the next passkey assertion (null when the key is device-wrapped). */
export async function prfSalt(): Promise<ArrayBuffer> {
  const s = await get();
  if (s?.prfSalt) return s.prfSalt;
  return crypto.getRandomValues(new Uint8Array(32)).buffer;
}

/**
 * Unlocks the key after a passkey assertion. If the assertion returned a PRF output and the key is
 * still device-wrapped, it is upgraded to passkey wrapping.
 */
export async function unlock(prfOutput: ArrayBuffer | null, salt: ArrayBuffer | null): Promise<Hex> {
  const s = await get();
  if (!s) throw new Error('No wallet on this device. Recover your account to restore it.');
  let key: Hex;
  if (s.mode === 'passkey') {
    if (!prfOutput) throw new Error('Confirm with the passkey that protects this wallet.');
    const k = await prfKey(prfOutput);
    key = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: s.iv }, k, s.ciphertext)) as Hex;
  } else {
    key = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: s.iv }, s.deviceKey!, s.ciphertext)) as Hex;
    if (prfOutput && salt) {
      const k = await prfKey(prfOutput);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(key));
      await put({ id: 'wallet', mode: 'passkey', iv: iv.buffer, ciphertext, prfSalt: salt, evm: s.evm, tron: s.tron });
    }
  }
  return key;
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
  sponsorship: string;
  atomic: boolean;
  calls: Array<{ kind: 'evm'; to: string; data: Hex; description: string } | { kind: 'tron'; contract: string; functionSelector: string; parameter: string; feeLimitSun: number; description: string }>;
}

/**
 * Signs and sends a call bundle. EVM calls go to the network directly (the provider's paymaster
 * sponsors gas in production); TRON calls are built through the node API, signed here, and relayed
 * through Backstop (energy sponsored).
 */
export async function execute(key: Hex, b: Bundle, relay: (signed: string[]) => Promise<string[]>): Promise<string[]> {
  const cfg = await publicConfig();
  const n = cfg.networks.find((x) => x.network === b.network);
  if (!n?.publicRpc) throw new Error(`${b.network} is not available for signing right now.`);
  if (b.network !== 'tron') {
    const chain = { id: n.chainId ?? 1, name: n.label, nativeCurrency: { name: 'native', symbol: 'NATIVE', decimals: 18 }, rpcUrls: { default: { http: [n.publicRpc] } } } as Chain;
    const w = createWalletClient({ chain, transport: http(n.publicRpc), account: privateKeyToAccount(key) });
    const hashes: string[] = [];
    for (const c of b.calls) {
      if (c.kind !== 'evm') continue;
      hashes.push(await w.sendTransaction({ to: c.to as Hex, data: c.data }));
    }
    return hashes;
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
