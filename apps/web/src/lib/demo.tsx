// "Launch App": opens a sandbox demo account without sign-up. The wallet key is still created on
// this device and only its addresses and ownership signatures reach the server; the passkey is
// created at the first payment confirmation (see confirmWithPasskey).
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, publicConfig } from './api';
import { deviceFingerprint, deviceLabel } from './passkey';
import { useSession } from './session';
import { createWallet, signLink, storeWallet } from './wallet';
import { ErrorNotice, useAction } from '../components/ui';

export interface DemoOptions {
  kind?: 'individual' | 'counterparty';
  invoiceSlug?: string;
  orderSlug?: string;
}

export async function launchDemo(o: DemoOptions = {}): Promise<string> {
  const start = await api.post('/auth/demo/start', { kind: o.kind ?? 'individual', invoiceSlug: o.invoiceSlug, orderSlug: o.orderSlug });
  const wallet = createWallet();
  const sigs = await signLink(wallet.key, start.walletLink.messageTemplate);
  const r = await api.post('/auth/demo/finish', {
    challengeId: start.challengeId,
    deviceFingerprint: deviceFingerprint(),
    deviceLabel: deviceLabel(),
    wallet: { provider: 'sandbox', providerWalletId: `device:${deviceFingerprint()}`, evmAddress: wallet.evm, tronAddress: wallet.tron, ...sigs },
  });
  await storeWallet(wallet);
  return r.token;
}

export function useDemoAvailable(): boolean | null {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    publicConfig()
      .then((c) => setOn(c.demoAccounts))
      .catch(() => setOn(true));
  }, []);
  return on;
}

export function LaunchButton({ next = '/', label = 'Launch App', className = 'btn', ...o }: DemoOptions & { next?: string; label?: string; className?: string }) {
  const nav = useNavigate();
  const { signIn } = useSession();
  const available = useDemoAvailable();
  const a = useAction(async () => {
    await signIn(await launchDemo(o));
    nav(next);
  });
  return (
    <>
      <ErrorNotice error={a.error} />
      <button type="button" className={className} onClick={() => void a.run()} disabled={a.busy || available === false} aria-busy={a.busy}>
        {a.busy ? 'Opening…' : label}
      </button>
      {available === false && <p className="small muted">Demo accounts aren't available on this server.</p>}
    </>
  );
}
