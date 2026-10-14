import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { authenticate, deviceFingerprint, deviceLabel, register } from '../lib/passkey';
import { useSession } from '../lib/session';
import { ErrorNotice, Field, Notice, useAction } from '../components/ui';

export function Welcome() {
  const [q] = useSearchParams();
  const next = q.get('next') ?? '/';
  return (
    <div className="stack">
      <h1>Every payment checked. Money to strangers held until they deliver.</h1>
      <p className="muted">Send and receive USDT and USDC, invoice clients abroad, prepay suppliers and trade P2P, with a named reason and an appeal route for any hold.</p>
      <div className="row">
        <Link className="btn" to={`/signup?next=${encodeURIComponent(next)}`}>
          Create an account
        </Link>
        <Link className="btn secondary" to={`/signin?next=${encodeURIComponent(next)}`}>
          Sign in
        </Link>
      </div>
      <p className="small muted">
        Address on the fraud list? <Link to="/appeal">Appeal a listing</Link>
      </p>
    </div>
  );
}

export function SignIn() {
  const nav = useNavigate();
  const [q] = useSearchParams();
  const { signIn } = useSession();
  const [identifier, setIdentifier] = useState('');
  const a = useAction(async () => {
    const o = await api.post('/auth/login/options', { identifier });
    const cred = await authenticate(o.options);
    const r = await api.post('/auth/login/finish', { challengeId: o.challengeId, credential: cred, deviceFingerprint: deviceFingerprint(), deviceLabel: deviceLabel() });
    await signIn(r.token);
    nav(q.get('next') ?? '/');
  });
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run();
      }}
    >
      <h1>Sign in</h1>
      <ErrorNotice error={a.error} />
      <Field label="Email, phone or @handle">{(id, d) => <input id={id} aria-describedby={d} autoComplete="username webauthn" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />}</Field>
      <button className="btn full" disabled={a.busy}>
        {a.busy ? 'Waiting for your passkey…' : 'Sign in with passkey'}
      </button>
      <p className="small muted" style={{ marginTop: 12 }}>
        Lost your device? <Link to="/recover">Recover your account</Link>. New here? <Link to="/signup">Create an account</Link>.
      </p>
    </form>
  );
}

export function Recover() {
  const nav = useNavigate();
  const { signIn } = useSession();
  const [step, setStep] = useState<'start' | 'verify' | 'passkey'>('start');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [ids, setIds] = useState<{ recoveryId: string; phoneOtpId: string; emailOtpId: string } | null>(null);
  const [codes, setCodes] = useState({ phone: '', email: '' });
  const [idv, setIdv] = useState({ idType: 'bvn', idNumber: '', livenessToken: 'device-liveness' });
  const [reg, setReg] = useState<{ challengeId: string; options: unknown; outgoingLockedUntil: string } | null>(null);
  const start = useAction(async () => {
    const r = await api.post('/auth/recovery/start', { email, phone });
    if (!r.recoveryId) throw new Error('We could not find an account with that email and phone number.');
    setIds(r);
    setStep('verify');
  });
  const verify = useAction(async () => {
    const r = await api.post('/auth/recovery/verify', {
      recoveryId: ids!.recoveryId,
      phoneOtpId: ids!.phoneOtpId,
      phoneCode: codes.phone,
      emailOtpId: ids!.emailOtpId,
      emailCode: codes.email,
      identity: idv.idNumber ? idv : undefined,
    });
    setReg(r);
    setStep('passkey');
  });
  const finish = useAction(async () => {
    const cred = await register(reg!.options);
    const r = await api.post('/auth/recovery/finish', { challengeId: reg!.challengeId, credential: cred, deviceFingerprint: deviceFingerprint(), deviceLabel: deviceLabel() });
    await signIn(r.token);
    nav('/');
  });
  return (
    <div className="card">
      <h1>Recover your account</h1>
      <Notice kind="info">After recovery, outgoing transfers are locked for 48 hours. Your protected payments keep running on their timers.</Notice>
      {step === 'start' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void start.run();
          }}
        >
          <ErrorNotice error={start.error} />
          <Field label="Email">{(id) => <input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />}</Field>
          <Field label="Phone" hint="International format, e.g. +2348031234567">{(id, d) => <input id={id} aria-describedby={d} value={phone} onChange={(e) => setPhone(e.target.value)} required />}</Field>
          <button className="btn" disabled={start.busy}>
            Send codes
          </button>
        </form>
      )}
      {step === 'verify' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void verify.run();
          }}
        >
          <ErrorNotice error={verify.error} />
          <Field label="Code sent to your phone">{(id) => <input id={id} inputMode="numeric" value={codes.phone} onChange={(e) => setCodes({ ...codes, phone: e.target.value })} required />}</Field>
          <Field label="Code sent to your email">{(id) => <input id={id} inputMode="numeric" value={codes.email} onChange={(e) => setCodes({ ...codes, email: e.target.value })} required />}</Field>
          <h3>Confirm your identity</h3>
          <Field label="ID type">
            {(id) => (
              <select id={id} value={idv.idType} onChange={(e) => setIdv({ ...idv, idType: e.target.value })}>
                <option value="bvn">BVN</option>
                <option value="nin">NIN</option>
              </select>
            )}
          </Field>
          <Field label="ID number" hint="Required if your account was verified.">{(id, d) => <input id={id} aria-describedby={d} inputMode="numeric" value={idv.idNumber} onChange={(e) => setIdv({ ...idv, idNumber: e.target.value })} />}</Field>
          <button className="btn" disabled={verify.busy}>
            Continue
          </button>
        </form>
      )}
      {step === 'passkey' && reg && (
        <div className="stack">
          <ErrorNotice error={finish.error} />
          <p>Create a passkey on this device. Outgoing transfers unlock at {new Date(reg.outgoingLockedUntil).toLocaleString()}.</p>
          <button className="btn" onClick={() => void finish.run()} disabled={finish.busy}>
            Create passkey
          </button>
        </div>
      )}
    </div>
  );
}
