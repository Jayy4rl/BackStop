// C1-1: sign up with phone and email, both verified by one-time code; the wallet's passkey is
// created at the same time (C2).
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, publicConfig } from '../lib/api';
import { deviceFingerprint, deviceLabel, register } from '../lib/passkey';
import { createWallet, signLink, storeWallet } from '../lib/wallet';
import { useSession } from '../lib/session';
import { ErrorNotice, Field, Notice, useAction } from '../components/ui';

export function SignUp() {
  const nav = useNavigate();
  const [q] = useSearchParams();
  const { signIn } = useSession();
  const [step, setStep] = useState(1);
  const [consent, setConsent] = useState<{ version: string; text: string } | null>(null);
  const [f, setF] = useState({ kind: 'individual', email: '', phone: '+234', handle: '', displayName: '', country: 'NG', accepted: false });
  const [ids, setIds] = useState<{ signupId: string; phoneOtpId: string; emailOtpId: string } | null>(null);
  const [codes, setCodes] = useState({ phone: '', email: '' });
  const [reg, setReg] = useState<{ challengeId: string; options: unknown; walletLink: { messageTemplate: string } } | null>(null);
  useEffect(() => {
    publicConfig().then((c) => setConsent(c.consent)).catch(() => undefined);
  }, []);
  const start = useAction(async () => {
    const r = await api.post('/auth/signup/start', {
      kind: f.kind,
      email: f.email,
      phone: f.phone,
      handle: f.kind === 'counterparty' ? undefined : f.handle,
      displayName: f.displayName,
      country: f.country,
      consent: { version: consent?.version, accepted: f.accepted },
    });
    setIds(r);
    setStep(2);
  });
  const verify = useAction(async () => {
    const r = await api.post('/auth/signup/verify', { signupId: ids!.signupId, phoneOtpId: ids!.phoneOtpId, phoneCode: codes.phone, emailOtpId: ids!.emailOtpId, emailCode: codes.email });
    setReg(r);
    setStep(3);
  });
  const finish = useAction(async () => {
    const wallet = createWallet();
    const cred = await register(reg!.options);
    const sigs = await signLink(wallet.key, reg!.walletLink.messageTemplate);
    const r = await api.post('/auth/signup/finish', {
      challengeId: reg!.challengeId,
      credential: cred,
      deviceFingerprint: deviceFingerprint(),
      deviceLabel: deviceLabel(),
      wallet: { provider: 'sandbox', providerWalletId: `device:${deviceFingerprint()}`, evmAddress: wallet.evm, tronAddress: wallet.tron, ...sigs },
    });
    await storeWallet(wallet);
    await signIn(r.token);
    nav(q.get('next') ?? '/verify-identity');
  });

  return (
    <div className="card">
      <div className="steps" aria-hidden="true">
        {[1, 2, 3].map((n) => (
          <span key={n} className={n <= step ? 'on' : ''} />
        ))}
      </div>
      <p className="small muted">Step {step} of 3</p>
      {step === 1 && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void start.run();
          }}
        >
          <h1>Create your account</h1>
          <ErrorNotice error={start.error} />
          <Field label="Account type">
            {(id) => (
              <select id={id} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, country: e.target.value === 'counterparty' ? '' : 'NG' })}>
                <option value="individual">Person in Nigeria</option>
                <option value="business">Registered business in Nigeria</option>
                <option value="counterparty">Client or supplier abroad</option>
              </select>
            )}
          </Field>
          <Field label={f.kind === 'business' ? 'Business name' : 'Your name'}>{(id) => <input id={id} value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} required />}</Field>
          {f.kind !== 'counterparty' && (
            <Field label="Handle" hint="People can pay you at @handle. Letters, digits and _.">
              {(id, d) => <input id={id} aria-describedby={d} value={f.handle} onChange={(e) => setF({ ...f, handle: e.target.value.replace(/^@/, '') })} required pattern="[A-Za-z0-9_]{3,20}" />}
            </Field>
          )}
          {f.kind === 'counterparty' && <Field label="Country (2-letter code)">{(id) => <input id={id} value={f.country} maxLength={2} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })} required />}</Field>}
          <Field label="Email">{(id) => <input id={id} type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />}</Field>
          <Field label="Phone" hint="International format, e.g. +2348031234567">{(id, d) => <input id={id} aria-describedby={d} type="tel" autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required />}</Field>
          {consent && (
            <label className="check">
              <input type="checkbox" checked={f.accepted} onChange={(e) => setF({ ...f, accepted: e.target.checked })} required />
              <span className="small">{consent.text}</span>
            </label>
          )}
          <button className="btn full" disabled={start.busy || !f.accepted} style={{ marginTop: 12 }}>
            Send codes
          </button>
        </form>
      )}
      {step === 2 && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void verify.run();
          }}
        >
          <h1>Enter your codes</h1>
          <ErrorNotice error={verify.error} />
          <Field label={`Code sent by SMS to ${f.phone}`}>{(id) => <input id={id} inputMode="numeric" autoComplete="one-time-code" value={codes.phone} onChange={(e) => setCodes({ ...codes, phone: e.target.value })} required />}</Field>
          <Field label={`Code sent to ${f.email}`}>{(id) => <input id={id} inputMode="numeric" value={codes.email} onChange={(e) => setCodes({ ...codes, email: e.target.value })} required />}</Field>
          <button className="btn full" disabled={verify.busy}>
            Verify
          </button>
        </form>
      )}
      {step === 3 && (
        <div className="stack">
          <h1>Create your passkey and wallet</h1>
          <p>Your passkey signs in to Backstop and approves every payment. Your wallet keys are created on this device and protected by it.</p>
          <Notice kind="info">Backstop never holds a key that can move your money. Add a second passkey on another device later so you can recover if you lose this one.</Notice>
          <ErrorNotice error={finish.error} />
          <button className="btn full" onClick={() => void finish.run()} disabled={finish.busy}>
            {finish.busy ? 'Waiting for your passkey…' : 'Create passkey and wallet'}
          </button>
        </div>
      )}
    </div>
  );
}
