// Native passkeys (iOS AuthenticationServices / Android Credential Manager). The server's
// WEBAUTHN_ORIGINS must include the app origins (Android: android:apk-key-hash:<hash>).
import { Passkey } from 'react-native-passkey';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';
import { api } from './api';
import { execute, unlock, type Bundle } from './wallet';

export async function deviceId(): Promise<string> {
  let id = await SecureStore.getItemAsync('bs_device');
  if (!id) {
    id = Crypto.randomUUID();
    await SecureStore.setItemAsync('bs_device', id);
  }
  return id;
}

export const deviceLabel = () => `${Device.manufacturer ?? ''} ${Device.modelName ?? 'phone'}`.trim();

export async function createPasskey(options: any) {
  return Passkey.create(options);
}

export async function getPasskey(options: any) {
  return Passkey.get(options);
}

/** Passkey step-up on the server, then the OS unlocks the wallet key. */
export async function confirmAndUnlock() {
  const o = await api.post('/auth/step-up/options');
  const cred = await getPasskey(o.options);
  await api.post('/auth/step-up/finish', { challengeId: o.challengeId, credential: cred });
  return unlock();
}

export async function signPaymentAction(paymentId: string, getBundle: () => Promise<{ bundle: Bundle }>): Promise<string[]> {
  const key = await confirmAndUnlock();
  const { bundle } = await getBundle();
  const hashes = await execute(key, bundle, async (signed) => (await api.post(`/payments/${paymentId}/submitted`, { signedTxs: signed })).txHashes);
  if (bundle.network !== 'tron' && hashes.length) await api.post(`/payments/${paymentId}/submitted`, { txHash: hashes[hashes.length - 1] });
  return hashes;
}

export async function signSend(decisionId: string, idempotencyKey: string, note?: string): Promise<{ transferId: string; txHash: string | null }> {
  const key = await confirmAndUnlock();
  const prep = await api.post('/send/prepare', { decisionId, idempotencyKey, note });
  const hashes = await execute(key, prep.bundle, async (signed) => [(await api.post('/send/submit', { transferId: prep.transferId, signedTx: signed[0], feeSignedTx: signed[1] })).txHash]);
  if (prep.bundle.network !== 'tron') await api.post('/send/submit', { transferId: prep.transferId, txHash: hashes[0] });
  return { transferId: prep.transferId, txHash: hashes[0] ?? null };
}
