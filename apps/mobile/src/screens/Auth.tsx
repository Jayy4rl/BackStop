import { useState } from 'react';
import { View } from 'react-native';
import { api } from '../lib/api';
import { createPasskey, deviceId, deviceLabel, getPasskey } from '../lib/passkey';
import { createWallet, signLink, storeWallet } from '../lib/wallet';
import { useSession } from '../lib/session';
import { Button, Card, ErrorText, Input, Notice, Screen, T, useAction } from '../components/ui';

export function SignInScreen({ onSignUp, onRecover }: { onSignUp: () => void; onRecover: () => void }) {
  const { signIn } = useSession();
  const [id, setId] = useState('');
  const a = useAction(async () => {
    const o = await api.post('/auth/login/options', { identifier: id });
    const cred = await getPasskey(o.options);
    const r = await api.post('/auth/login/finish', { challengeId: o.challengeId, credential: cred, deviceFingerprint: await deviceId(), deviceLabel: deviceLabel() });
    await signIn(r.token);
  });
  return (
    <Screen title="Backstop">
      <T muted>Every payment checked. Money to strangers held until they deliver.</T>
      <View style={{ height: 16 }} />
      <Card>
        <ErrorText error={a.error} />
        <Input label="Email, phone or @handle" value={id} onChangeText={setId} autoCapitalize="none" autoComplete="username" />
        <Button label="Sign in with passkey" onPress={() => void a.run()} busy={a.busy} />
        <Button label="Create an account" kind="secondary" onPress={onSignUp} />
        <Button label="Lost your phone? Recover" kind="secondary" onPress={onRecover} />
      </Card>
    </Screen>
  );
}

export function SignUpScreen({ onBack }: { onBack: () => void }) {
  const { signIn } = useSession();
  const [step, setStep] = useState(1);
  const [f, setF] = useState({ email: '', phone: '+234', handle: '', displayName: '' });
  const [ids, setIds] = useState<any>(null);
  const [codes, setCodes] = useState({ phone: '', email: '' });
  const [reg, setReg] = useState<any>(null);
  const [consent, setConsent] = useState<{ version: string; text: string } | null>(null);
  const [agreed, setAgreed] = useState(false);
  const start = useAction(async () => {
    const c: { version: string; text: string } = consent ?? (await api.get<{ version: string; text: string }>('/auth/consent'));
    setConsent(c);
    if (!agreed) return;
    setIds(await api.post('/auth/signup/start', { kind: 'individual', ...f, country: 'NG', consent: { version: c.version, accepted: true } }));
    setStep(2);
  });
  const verify = useAction(async () => {
    setReg(await api.post('/auth/signup/verify', { signupId: ids.signupId, phoneOtpId: ids.phoneOtpId, phoneCode: codes.phone, emailOtpId: ids.emailOtpId, emailCode: codes.email }));
    setStep(3);
  });
  const finish = useAction(async () => {
    const w = createWallet();
    const cred = await createPasskey(reg.options);
    const sigs = await signLink(w.key, reg.walletLink.messageTemplate);
    const r = await api.post('/auth/signup/finish', {
      challengeId: reg.challengeId,
      credential: cred,
      deviceFingerprint: await deviceId(),
      deviceLabel: deviceLabel(),
      wallet: { provider: 'sandbox', providerWalletId: `device:${await deviceId()}`, evmAddress: w.evm, tronAddress: w.tron, ...sigs },
    });
    await storeWallet(w);
    await signIn(r.token);
  });
  return (
    <Screen title={`Create account (${step}/3)`}>
      {step === 1 && (
        <Card>
          <ErrorText error={start.error} />
          <Input label="Your name" value={f.displayName} onChangeText={(v) => setF({ ...f, displayName: v })} />
          <Input label="Handle" hint="People pay you at @handle" value={f.handle} autoCapitalize="none" onChangeText={(v) => setF({ ...f, handle: v.replace(/^@/, '') })} />
          <Input label="Email" value={f.email} autoCapitalize="none" keyboardType="email-address" onChangeText={(v) => setF({ ...f, email: v })} />
          <Input label="Phone" hint="e.g. +2348031234567" value={f.phone} keyboardType="phone-pad" onChangeText={(v) => setF({ ...f, phone: v })} />
          {consent && (
            <Notice kind="info" title="Your data">
              {consent.text}
            </Notice>
          )}
          {consent && <Button label={agreed ? 'I agree ✓' : 'I agree'} kind="secondary" onPress={() => setAgreed(!agreed)} />}
          <Button label={consent ? 'Send codes' : 'Continue'} onPress={() => void start.run()} busy={start.busy} disabled={!!consent && !agreed} />
          <Button label="Back" kind="secondary" onPress={onBack} />
        </Card>
      )}
      {step === 2 && (
        <Card>
          <ErrorText error={verify.error} />
          <Input label={`SMS code sent to ${f.phone}`} keyboardType="number-pad" autoComplete="sms-otp" value={codes.phone} onChangeText={(v) => setCodes({ ...codes, phone: v })} />
          <Input label={`Code sent to ${f.email}`} keyboardType="number-pad" value={codes.email} onChangeText={(v) => setCodes({ ...codes, email: v })} />
          <Button label="Verify" onPress={() => void verify.run()} busy={verify.busy} />
        </Card>
      )}
      {step === 3 && (
        <Card>
          <T>Your passkey signs in and approves every payment. Your wallet keys are created on this phone and protected by its lock.</T>
          <Notice kind="info">Backstop never holds a key that can move your money.</Notice>
          <ErrorText error={finish.error} />
          <Button label="Create passkey and wallet" onPress={() => void finish.run()} busy={finish.busy} />
        </Card>
      )}
    </Screen>
  );
}
