// Verification (Tier 1 with a camera selfie), Settings (re-verification, limits), Support.
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Button, Card, ErrorText, Input, Notice, Screen, T, usd, useAction, useLoad } from '../components/ui';

/** Selfie step; the identity vendor's liveness SDK replaces the sandbox token here. */
function Selfie({ onDone }: { onDone: (token: string) => void }) {
  const [perm, ask] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [done, setDone] = useState(false);
  if (done) return <Notice kind="ok">Selfie captured.</Notice>;
  if (!perm?.granted) return <Button label="Allow camera for the selfie check" kind="secondary" onPress={() => void ask()} />;
  return (
    <View>
      <CameraView ref={cam} facing="front" style={{ height: 260, borderRadius: 12, overflow: 'hidden' }} accessibilityLabel="Camera preview for your selfie" />
      <Button
        label="Take selfie"
        onPress={async () => {
          await cam.current?.takePictureAsync({ quality: 0.3, skipProcessing: true });
          setDone(true);
          onDone(`sandbox-live-${Date.now()}`);
        }}
      />
    </View>
  );
}

export function VerifyScreen() {
  const { me, refresh } = useSession();
  const [f, setF] = useState({ idType: 'bvn', idNumber: '', firstName: '', lastName: '', dateOfBirth: '' });
  const [live, setLive] = useState<string | null>(null);
  const a = useAction(async () => {
    await api.post('/identity/tier1', { ...f, livenessToken: live });
    await refresh();
  });
  if (me?.tier !== 'none') return <Screen title="Verification"><Notice kind="ok">You're verified as {me?.verifiedName}.</Notice></Screen>;
  return (
    <Screen title="Verify with BVN or NIN">
      <T muted>One account per BVN or NIN. Your data is encrypted and kept only as long as the law requires.</T>
      <Card>
        <ErrorText error={a.error} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {['bvn', 'nin'].map((t) => (
            <View key={t} style={{ flex: 1 }}>
              <Button label={t.toUpperCase()} kind={t === f.idType ? 'primary' : 'secondary'} onPress={() => setF({ ...f, idType: t })} />
            </View>
          ))}
        </View>
        <Input label="Number" keyboardType="number-pad" maxLength={11} value={f.idNumber} onChangeText={(v) => setF({ ...f, idNumber: v })} />
        <Input label="First name" value={f.firstName} onChangeText={(v) => setF({ ...f, firstName: v })} />
        <Input label="Last name" value={f.lastName} onChangeText={(v) => setF({ ...f, lastName: v })} />
        <Input label="Date of birth" hint="YYYY-MM-DD" value={f.dateOfBirth} onChangeText={(v) => setF({ ...f, dateOfBirth: v })} />
        <Selfie onDone={setLive} />
        <Button label="Verify" onPress={() => void a.run()} busy={a.busy} disabled={!live} />
      </Card>
    </Screen>
  );
}

export function SettingsScreen({ navigation }: { navigation?: { navigate: (s: string) => void } }) {
  const { me, refresh, signOut } = useSession();
  const [otp, setOtp] = useState<{ otpId: string } | null>(null);
  const [code, setCode] = useState('');
  const [live, setLive] = useState<string | null>(null);
  const rv = useAction(async () => {
    if (!otp) return setOtp(await api.post('/auth/reverify/start'));
    await api.post('/auth/reverify/finish', { otpId: otp.otpId, code, livenessToken: live ?? undefined });
    setOtp(null);
    await refresh();
  });
  if (!me) return null;
  return (
    <Screen title="Settings">
      {me.reverifyRequired && (
        <Card>
          <T bold>Verify it's you</T>
          <T muted>{me.reverifyReason === 'phone_changed' ? 'Your phone number changed.' : 'You signed in on a new device.'}</T>
          <ErrorText error={rv.error} />
          {otp && <Input label="Code" keyboardType="number-pad" value={code} onChangeText={setCode} />}
          {otp && me.tier !== 'none' && <Selfie onDone={setLive} />}
          <Button label={otp ? 'Verify' : 'Send code'} onPress={() => void rv.run()} busy={rv.busy} />
        </Card>
      )}
      <Card>
        <T>
          @{me.handle} · {me.email} · {me.phone}
        </T>
        <T muted>
          Limits: {usd(me.limits.perTransaction)} per payment · {usd(me.limits.daily)} per day · {usd(me.limits.remainingToday)} left today
        </T>
      </Card>
      <Button label="Trade orders" kind="secondary" onPress={() => navigation?.navigate('Orders')} />
      <Button label="Report fraud" kind="secondary" onPress={() => navigation?.navigate('Report')} />
      <Button label="Support" kind="secondary" onPress={() => navigation?.navigate('Support')} />
      <Button label="Sign out" kind="secondary" onPress={() => void signOut()} />
    </Screen>
  );
}

export function SupportScreen() {
  const threads = useLoad(() => api.get('/support/threads'));
  const [f, setF] = useState({ subject: '', body: '' });
  const [sent, setSent] = useState<string | null>(null);
  const a = useAction(async () => {
    const r = await api.post('/support/threads', f);
    setSent(`We'll reply by ${new Date(r.firstResponseDue).toLocaleString()}.`);
    setF({ subject: '', body: '' });
    threads.reload();
  });
  return (
    <Screen title="Support">
      {sent && <Notice kind="ok">{sent}</Notice>}
      <Card>
        <ErrorText error={a.error} />
        <Input label="Subject" value={f.subject} onChangeText={(v) => setF({ ...f, subject: v })} />
        <Input label="Message" multiline value={f.body} onChangeText={(v) => setF({ ...f, body: v })} style={{ minHeight: 100, textAlignVertical: 'top' }} />
        <Button label="Send" onPress={() => void a.run()} busy={a.busy} disabled={!f.subject || !f.body} />
      </Card>
      {(threads.data?.threads ?? []).map((t: any) => (
        <Card key={t.id}>
          <T bold>{t.subject}</T>
          <T muted>{t.status}</T>
        </Card>
      ))}
    </Screen>
  );
}
