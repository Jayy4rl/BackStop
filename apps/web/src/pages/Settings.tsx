// Profile, discoverability (L1-1), new-payee threshold, re-verification (C1-8), phone change,
// second passkey (C2-2), limits (C1-7).
import { useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { authenticate, register } from '../lib/passkey';
import { walletInfo } from '../lib/wallet';
import { ErrorNotice, Field, Money, Notice, useAction, useLoad, When } from '../components/ui';
import { Liveness } from '../components/Liveness';

export function Settings() {
  const { me, refresh } = useSession();
  const passkeys = useLoad(() => api.get('/auth/passkeys'));
  const wallet = useLoad(() => walletInfo());
  const [profile, setProfile] = useState({ displayName: me?.displayName ?? '', phoneDiscoverable: me?.phoneDiscoverable ?? false, newPayeeThreshold: me?.newPayeeThreshold ?? '' });
  const [rv, setRv] = useState<{ otpId: string } | null>(null);
  const [rvCode, setRvCode] = useState('');
  const [live, setLive] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [ph, setPh] = useState<{ otpId: string } | null>(null);
  const [phCode, setPhCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const save = useAction(async () => {
    await api.patch('/me', { displayName: profile.displayName, phoneDiscoverable: profile.phoneDiscoverable, newPayeeThreshold: profile.newPayeeThreshold || undefined });
    await refresh();
    setMsg('Saved.');
  });
  const reverify = useAction(async () => {
    if (!rv) {
      setRv(await api.post('/auth/reverify/start'));
      return;
    }
    await api.post('/auth/reverify/finish', { otpId: rv.otpId, code: rvCode, livenessToken: live ?? undefined });
    setRv(null);
    await refresh();
    setMsg('Verified. Sends and releases are unlocked.');
  });
  const changePhone = useAction(async () => {
    if (!ph) {
      setPh(await api.post('/me/phone/start', { phone }));
      return;
    }
    await api.post('/me/phone/finish', { otpId: ph.otpId, code: phCode });
    setPh(null);
    await refresh();
  });
  const addPasskey = useAction(async () => {
    const s = await api.post('/auth/step-up/options');
    await api.post('/auth/step-up/finish', { challengeId: s.challengeId, credential: await authenticate(s.options) });
    const o = await api.post('/auth/passkeys/options');
    await api.post('/auth/passkeys', { challengeId: o.challengeId, credential: await register(o.options), label: 'Second device' });
    passkeys.reload();
  });
  if (!me) return null;
  return (
    <div>
      <h1>Settings</h1>
      {msg && <Notice kind="ok">{msg}</Notice>}
      {me.reverifyRequired && (
        <div className="card" id="reverify">
          <h2>Verify it's you</h2>
          <p>{me.reverifyReason === 'phone_changed' ? 'Your phone number changed.' : 'You signed in on a new device.'} We'll text a code to {me.phone}{me.tier !== 'none' ? ' and ask for a selfie' : ''}.</p>
          <ErrorNotice error={reverify.error} />
          {rv && <Field label="Code">{(id) => <input id={id} inputMode="numeric" value={rvCode} onChange={(e) => setRvCode(e.target.value)} />}</Field>}
          {rv && me.tier !== 'none' && <Liveness onDone={setLive} />}
          <button className="btn" disabled={reverify.busy || (!!rv && me.tier !== 'none' && !live)} onClick={() => void reverify.run()}>
            {rv ? 'Verify' : 'Send code'}
          </button>
        </div>
      )}
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run();
        }}
      >
        <h2>Profile</h2>
        <ErrorNotice error={save.error} />
        <p className="small">
          @{me.handle} · {me.email} · {me.phone}
        </p>
        <Field label="Display name">{(id) => <input id={id} value={profile.displayName} onChange={(e) => setProfile({ ...profile, displayName: e.target.value })} />}</Field>
        <label className="check">
          <input type="checkbox" checked={profile.phoneDiscoverable} onChange={(e) => setProfile({ ...profile, phoneDiscoverable: e.target.checked })} />
          Let people find me by my phone number
        </label>
        <Field label="Warn me before a first payment above ($)" hint="Used by the new-payee warning.">
          {(id, d) => <input id={id} aria-describedby={d} inputMode="decimal" value={profile.newPayeeThreshold} onChange={(e) => setProfile({ ...profile, newPayeeThreshold: e.target.value })} placeholder="500" />}
        </Field>
        <button className="btn" disabled={save.busy}>
          Save
        </button>
      </form>
      <div className="card">
        <h2>Limits</h2>
        <p>
          <Money amount={me.limits.perTransaction} /> per payment · <Money amount={me.limits.daily} /> per day · <Money amount={me.limits.remainingToday} /> left today (resets <When at={me.limits.resetsAt} />)
        </p>
      </div>
      <div className="card">
        <h2>Passkeys and recovery</h2>
        <ul className="list">
          {(passkeys.data?.passkeys ?? []).map((p: any) => (
            <li key={p.id}>
              {p.device_label ?? 'Passkey'} · added <When at={p.created_at} /> · last used <When at={p.last_used_at} />
            </li>
          ))}
        </ul>
        <p className="small muted">Add a passkey on a second device so you can recover your account if you lose this one.</p>
        <ErrorNotice error={addPasskey.error} />
        <button className="btn secondary" disabled={addPasskey.busy} onClick={() => void addPasskey.run()}>
          Add a passkey
        </button>
        {wallet.data && (
          <p className="small muted" style={{ marginTop: 12 }}>
            Wallet keys on this device are protected {wallet.data.mode === 'passkey' ? 'by your passkey' : 'by this device; they switch to passkey protection the next time you confirm a payment (if your browser supports it)'}.
          </p>
        )}
      </div>
      <div className="card">
        <h2>Change phone number</h2>
        <p className="small muted">After a change, sends and releases pause until you verify again.</p>
        <ErrorNotice error={changePhone.error} />
        {!ph ? (
          <Field label="New phone">{(id) => <input id={id} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
        ) : (
          <Field label="Code sent to the new number">{(id) => <input id={id} inputMode="numeric" value={phCode} onChange={(e) => setPhCode(e.target.value)} />}</Field>
        )}
        <button className="btn secondary" disabled={changePhone.busy} onClick={() => void changePhone.run()}>
          {ph ? 'Confirm' : 'Send code'}
        </button>
      </div>
    </div>
  );
}
