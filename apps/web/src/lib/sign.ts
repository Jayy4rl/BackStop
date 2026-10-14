// Signing flows: one passkey confirmation (server step-up + wallet unlock), then the device signs
// the call bundle the API built.
import { api } from './api';
import { confirmWithPasskey } from './passkey';
import { execute, type Bundle } from './wallet';

/** For escrow actions: sign the bundle and report it; the payment updates when the chain confirms. */
export async function signPaymentAction(paymentId: string, getBundle: () => Promise<{ bundle: Bundle }>): Promise<string[]> {
  const key = await confirmWithPasskey();
  const { bundle } = await getBundle();
  const hashes = await execute(key, bundle, async (signed) => (await api.post(`/payments/${paymentId}/submitted`, { signedTxs: signed })).txHashes);
  if (bundle.network !== 'tron' && hashes[hashes.length - 1]) await api.post(`/payments/${paymentId}/submitted`, { txHash: hashes[hashes.length - 1] });
  return hashes;
}

/** For L1 sends: passkey, prepare (idempotent), sign, submit. */
export async function signSend(decisionId: string, idempotencyKey: string, note?: string, paymentRequestId?: string): Promise<{ transferId: string; txHash: string | null }> {
  const key = await confirmWithPasskey();
  const prep = await api.post('/send/prepare', { decisionId, idempotencyKey, note, paymentRequestId });
  let txHash: string | null = null;
  const hashes = await execute(key, prep.bundle, async (signed) => {
    const r = await api.post('/send/submit', { transferId: prep.transferId, signedTx: signed[0], feeSignedTx: signed[1] });
    return [r.txHash];
  });
  txHash = hashes[0] ?? null;
  if (prep.bundle.network !== 'tron') await api.post('/send/submit', { transferId: prep.transferId, txHash });
  return { transferId: prep.transferId, txHash };
}
