// L2 invoices, L3 orders, L4 offer book and bank accounts, fraud reports, account recovery.
import { useState } from 'react';
import { View } from 'react-native';
import { api } from '../lib/api';
import { createPasskey, deviceId, deviceLabel } from '../lib/passkey';
import { useSession } from '../lib/session';
import { Badge, Button, Card, ErrorText, Input, Notice, Screen, T, usd, useAction, useLoad } from '../components/ui';

export function InvoicesScreen({ open }: { open: (paymentId: string) => void }) {
  const { me } = useSession();
  const inv = useLoad(() => api.get('/invoices'));
  const due = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const [f, setF] = useState({ clientEmail: '', description: '', amount: '', dueDate: due, token: 'USDC' });
  const [link, setLink] = useState<string | null>(null);
  const create = useAction(async () => {
    const dueIso = new Date(`${f.dueDate}T17:00:00Z`).toISOString();
    const r = await api.post('/invoices', { clientEmail: f.clientEmail, description: f.description, token: f.token, dueDate: dueIso, milestones: [{ title: f.description.slice(0, 60), amount: f.amount, dueDate: dueIso }] });
    setLink(r.link);
    inv.reload();
  });
  return (
    <Screen title="Invoices">
      {me?.tier !== 'tier1' ? (
        <Notice kind="warn">Verify your identity (Tier 1) to send invoices.</Notice>
      ) : (
        <Card>
          <T bold>New invoice</T>
          <ErrorText error={create.error} />
          <Input label="Client email" autoCapitalize="none" keyboardType="email-address" value={f.clientEmail} onChangeText={(v) => setF({ ...f, clientEmail: v })} />
          <Input label="What is the work?" value={f.description} onChangeText={(v) => setF({ ...f, description: v })} />
          <Input label="Amount ($)" keyboardType="decimal-pad" value={f.amount} onChangeText={(v) => setF({ ...f, amount: v })} />
          <Input label="Deliver by" hint="YYYY-MM-DD" value={f.dueDate} onChangeText={(v) => setF({ ...f, dueDate: v })} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {['USDC', 'USDT'].map((t) => (
              <View key={t} style={{ flex: 1 }}>
                <Button label={t} kind={t === f.token ? 'primary' : 'secondary'} onPress={() => setF({ ...f, token: t })} />
              </View>
            ))}
          </View>
          <Button label="Send invoice" onPress={() => void create.run()} busy={create.busy} />
          {link && <Notice kind="ok" title="Checkout link sent to the client">{link}</Notice>}
        </Card>
      )}
      {(inv.data?.invoices ?? []).map((i: any) => (
        <Card key={i.id}>
          <T bold>{i.description}</T>
          <T muted size={14}>
            {i.client_email} · {usd(i.total)} {i.token}
          </T>
          {i.milestones.map((m: any) => (
            <Button key={m.id} kind="secondary" label={`${m.title}: ${m.status}`} onPress={() => open(m.id)} />
          ))}
        </Card>
      ))}
    </Screen>
  );
}

export function OrdersScreen({ open }: { open: (paymentId: string) => void }) {
  const o = useLoad(() => api.get('/orders'));
  return (
    <Screen title="Trade orders">
      <T muted>Create new orders (with the pro forma upload) in the web app; track and act on them here.</T>
      <ErrorText error={o.error} />
      {(o.data?.orders ?? []).map((x: any) => (
        <Card key={x.id}>
          <T bold>{x.goods}</T>
          <T muted size={14}>
            {x.supplierEmail} · {usd(x.total)} {x.token} · {x.supplierAccepted ? 'accepted' : 'awaiting supplier'}
          </T>
          {x.payments.map((p: any) => (
            <Button key={p.id} kind="secondary" label={`${p.title}: ${p.status}`} onPress={() => open(p.id)} />
          ))}
        </Card>
      ))}
    </Screen>
  );
}

export function P2PScreen({ openTrade }: { openTrade: (id: string) => void }) {
  const [side, setSide] = useState<'sell' | 'buy'>('sell');
  const book = useLoad(() => api.get(`/p2p/offers?side=${side}`), [side]);
  const banks = useLoad(() => api.get('/bank-accounts'));
  const [take, setTake] = useState<any>(null);
  const [amount, setAmount] = useState('');
  const [bank, setBank] = useState<string | null>(null);
  const [newBank, setNewBank] = useState({ bankCode: '', accountNumber: '' });
  const open = useAction(async () => {
    const t = await api.post('/p2p/trades', { offerId: take.id, amount, bankAccountId: bank });
    openTrade(t.id);
  });
  const addBank = useAction(async () => {
    await api.post('/bank-accounts', newBank);
    setNewBank({ bankCode: '', accountNumber: '' });
    banks.reload();
  });
  if ((book.error as { code?: string } | null)?.code === 'p2p_unavailable') return <Screen title="P2P"><Notice kind="info">P2P trading launches after legal sign-off.</Notice></Screen>;
  return (
    <Screen title="P2P trading">
      <Notice kind="info">The seller's USDT is held in escrow. Pay naira only from your own registered account.</Notice>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button label="Buy USDT" kind={side === 'sell' ? 'primary' : 'secondary'} onPress={() => setSide('sell')} />
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Sell USDT" kind={side === 'buy' ? 'primary' : 'secondary'} onPress={() => setSide('buy')} />
        </View>
      </View>
      {(book.data?.offers ?? []).map((o: any) => (
        <Card key={o.id}>
          <T bold>
            ₦{Number(o.priceNgn).toLocaleString()} · {o.merchant.verifiedName}
          </T>
          <T muted size={14}>
            {usd(o.min)}–{usd(o.max)} · {o.paymentWindowMinutes} min · {o.merchant.completedTrades} trades · {o.merchant.disputeRate}% disputed
          </T>
          <Button label={take?.id === o.id ? 'Selected' : side === 'sell' ? 'Buy from this merchant' : 'Sell to this merchant'} kind="secondary" onPress={() => setTake(o)} />
        </Card>
      ))}
      {take && (
        <Card>
          <ErrorText error={open.error} />
          <Input label="Amount (USDT)" keyboardType="decimal-pad" value={amount} onChangeText={setAmount} />
          <T bold>{take.side === 'sell' ? 'Pay naira from' : 'Receive naira into'}</T>
          {(banks.data?.accounts ?? []).map((a: any) => (
            <Button key={a.id} label={`${a.bank_name} ••••${a.account_last4}${bank === a.id ? ' ✓' : ''}`} kind={bank === a.id ? 'primary' : 'secondary'} onPress={() => setBank(a.id)} />
          ))}
          <Button label="Open trade" onPress={() => void open.run()} busy={open.busy} disabled={!bank || !amount} />
        </Card>
      )}
      <Card>
        <T bold>Bank accounts</T>
        <T muted size={14}>
          Only accounts in your own verified name.
        </T>
        {(banks.data?.accounts ?? []).map((a: any) => (
          <T key={a.id}>
            {a.bank_name} ••••{a.account_last4} · {a.account_name}
          </T>
        ))}
        <ErrorText error={addBank.error} />
        <Input label="Bank code" hint={(banks.data?.banks ?? []).slice(0, 4).map((b: any) => `${b.code} ${b.name}`).join(', ')} value={newBank.bankCode} onChangeText={(v) => setNewBank({ ...newBank, bankCode: v })} />
        <Input label="Account number" keyboardType="number-pad" maxLength={10} value={newBank.accountNumber} onChangeText={(v) => setNewBank({ ...newBank, accountNumber: v })} />
        <Button label="Add and verify name" kind="secondary" onPress={() => void addBank.run()} busy={addBank.busy} />
      </Card>
    </Screen>
  );
}

export function ReportScreen() {
  const [f, setF] = useState({ caseType: 'scam', addresses: '', txHashes: '', statement: '' });
  const [done, setDone] = useState<string | null>(null);
  const a = useAction(async () => {
    const r = await api.post('/fraud-reports', { caseType: f.caseType, suspectAddresses: f.addresses.split(/[\s,]+/).filter(Boolean), txHashes: f.txHashes.split(/[\s,]+/).filter(Boolean), statement: f.statement });
    setDone(r.message);
  });
  return (
    <Screen title="Report fraud">
      {done ? (
        <Notice kind="ok">{done}</Notice>
      ) : (
        <Card>
          <ErrorText error={a.error} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {['scam', 'non_delivery', 'impersonation', 'phishing', 'third_party_naira', 'other'].map((c) => (
              <Button key={c} label={c.replace(/_/g, ' ')} kind={c === f.caseType ? 'primary' : 'secondary'} onPress={() => setF({ ...f, caseType: c })} />
            ))}
          </View>
          <Input label="Suspect addresses" value={f.addresses} onChangeText={(v) => setF({ ...f, addresses: v })} autoCapitalize="none" />
          <Input label="Transaction hashes" value={f.txHashes} onChangeText={(v) => setF({ ...f, txHashes: v })} autoCapitalize="none" />
          <Input label="What happened" multiline value={f.statement} onChangeText={(v) => setF({ ...f, statement: v })} style={{ minHeight: 100, textAlignVertical: 'top' }} />
          <Button label="Send report" onPress={() => void a.run()} busy={a.busy} disabled={f.statement.length < 20} />
        </Card>
      )}
    </Screen>
  );
}

export function RecoverScreen({ onBack }: { onBack: () => void }) {
  const { signIn } = useSession();
  const [step, setStep] = useState(1);
  const [f, setF] = useState({ email: '', phone: '+234', phoneCode: '', emailCode: '', idType: 'bvn', idNumber: '' });
  const [ids, setIds] = useState<any>(null);
  const [reg, setReg] = useState<any>(null);
  const start = useAction(async () => {
    const r = await api.post('/auth/recovery/start', { email: f.email, phone: f.phone });
    if (!r.recoveryId) throw new Error('No account matches that email and phone.');
    setIds(r);
    setStep(2);
  });
  const verify = useAction(async () => {
    setReg(
      await api.post('/auth/recovery/verify', {
        recoveryId: ids.recoveryId,
        phoneOtpId: ids.phoneOtpId,
        phoneCode: f.phoneCode,
        emailOtpId: ids.emailOtpId,
        emailCode: f.emailCode,
        identity: f.idNumber ? { idType: f.idType, idNumber: f.idNumber, livenessToken: `sandbox-live-${Date.now()}` } : undefined,
      }),
    );
    setStep(3);
  });
  const finish = useAction(async () => {
    const cred = await createPasskey(reg.options);
    const r = await api.post('/auth/recovery/finish', { challengeId: reg.challengeId, credential: cred, deviceFingerprint: await deviceId(), deviceLabel: deviceLabel() });
    await signIn(r.token);
  });
  return (
    <Screen title="Recover your account">
      <Notice kind="info">After recovery, outgoing transfers stay locked for 48 hours. Protected payments keep running on their timers.</Notice>
      {step === 1 && (
        <Card>
          <ErrorText error={start.error} />
          <Input label="Email" autoCapitalize="none" value={f.email} onChangeText={(v) => setF({ ...f, email: v })} />
          <Input label="Phone" value={f.phone} keyboardType="phone-pad" onChangeText={(v) => setF({ ...f, phone: v })} />
          <Button label="Send codes" onPress={() => void start.run()} busy={start.busy} />
          <Button label="Back" kind="secondary" onPress={onBack} />
        </Card>
      )}
      {step === 2 && (
        <Card>
          <ErrorText error={verify.error} />
          <Input label="SMS code" keyboardType="number-pad" value={f.phoneCode} onChangeText={(v) => setF({ ...f, phoneCode: v })} />
          <Input label="Email code" keyboardType="number-pad" value={f.emailCode} onChangeText={(v) => setF({ ...f, emailCode: v })} />
          <Input label="BVN or NIN (if verified)" keyboardType="number-pad" value={f.idNumber} onChangeText={(v) => setF({ ...f, idNumber: v })} />
          <Button label="Continue" onPress={() => void verify.run()} busy={verify.busy} />
        </Card>
      )}
      {step === 3 && reg && (
        <Card>
          <T>Outgoing transfers unlock {new Date(reg.outgoingLockedUntil).toLocaleString()}.</T>
          <ErrorText error={finish.error} />
          <Button label="Create passkey on this phone" onPress={() => void finish.run()} busy={finish.busy} />
        </Card>
      )}
      <Badge label="Your wallet provider restores your wallet keys" />
    </Screen>
  );
}
