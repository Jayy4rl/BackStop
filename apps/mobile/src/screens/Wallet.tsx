// Home (balances, holds), Receive (QR per network with warnings), History, Send.
import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, Share, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import { api } from '../lib/api';
import { signSend } from '../lib/passkey';
import { useSession } from '../lib/session';
import { Badge, Button, Card, ErrorText, Input, Notice, Screen, T, usd, useAction, useLoad } from '../components/ui';

const HOLD_MEANING =
  'Held funds stay in your own wallet. Backstop cannot move or freeze them, but the app will not use them for protected payments, P2P trades or in-app payments until the hold is cleared.';

export function HomeScreen({ go }: { go: (screen: string, params?: Record<string, string>) => void }) {
  const { me } = useSession();
  const b = useLoad(() => api.get('/wallet/balances'));
  const n = useLoad(() => api.get('/notifications'));
  return (
    <Screen title={`Hello${me?.displayName ? `, ${me.displayName.split(' ')[0]}` : ''}`}>
      {me?.tier === 'none' && <Notice kind="warn" title="Verify your identity">Verify to send money and use protected payments.</Notice>}
      {me?.reverifyRequired && <Notice kind="warn" title="Verify it's you">Sends and releases are paused until you verify in Settings.</Notice>}
      <ErrorText error={b.error} />
      {b.data && (
        <Card>
          <T muted>Total balance</T>
          <T size={34} bold>
            {usd(b.data.totalUsd)}
          </T>
          <T muted size={13}>
            ≈ {b.data.nairaReference.value} (reference, {b.data.nairaReference.source})
          </T>
          {b.data.pairs
            .filter((p: any) => p.balance !== '0')
            .map((p: any) => (
              <View key={`${p.network}${p.token}`} style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                <T>
                  {p.token} · {p.network}
                </T>
                <T>
                  {usd(p.spendable)}
                  {p.held !== '0' ? ` (+${usd(p.held)} held)` : ''}
                </T>
              </View>
            ))}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <View style={{ flex: 1 }}>
              <Button label="Send" onPress={() => go('Send')} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Receive" kind="secondary" onPress={() => go('Receive')} />
            </View>
          </View>
        </Card>
      )}
      {b.data?.holds?.length > 0 && (
        <Card>
          <T bold>Funds on hold</T>
          <T muted size={13}>
            {HOLD_MEANING}
          </T>
          {b.data.holds.map((h: any) => (
            <View key={h.id} style={{ marginTop: 10 }}>
              <Badge label={h.availability === 'on_hold' ? 'On hold' : 'Under review'} kind={h.availability === 'on_hold' ? 'danger' : 'warn'} />
              <T>{h.hold_reason}</T>
              <Button label={h.appeal_ref ? `Appeal ${h.appeal_ref}: ${h.appeal_status}` : 'Appeal this hold'} kind="secondary" onPress={() => go('Appeal', { transferId: h.id })} disabled={!!h.appeal_ref} />
            </View>
          ))}
        </Card>
      )}
      <Card>
        <T bold>Notifications</T>
        {(n.data?.notifications ?? []).slice(0, 6).map((x: any) => (
          <View key={x.id} style={{ marginTop: 8 }} accessible accessibilityLabel={`${x.title}. ${x.body}`}>
            <T bold>{x.title}</T>
            <T muted size={14}>
              {x.body}
            </T>
          </View>
        ))}
      </Card>
    </Screen>
  );
}

export function AppealHoldScreen({ transferId, done }: { transferId: string; done: () => void }) {
  const [statement, setStatement] = useState('');
  const a = useAction(async () => {
    await api.post('/appeals/hold', { transferId, statement });
    done();
  });
  return (
    <Screen title="Appeal a hold">
      <ErrorText error={a.error} />
      <Input label="Where did this money come from?" multiline value={statement} onChangeText={setStatement} style={{ minHeight: 120, textAlignVertical: 'top' }} />
      <Button label="Send appeal" onPress={() => void a.run()} busy={a.busy} disabled={statement.length < 20} />
    </Screen>
  );
}

export function ReceiveScreen() {
  const r = useLoad(() => api.get('/wallet/receive'));
  const [i, setI] = useState(0);
  if (!r.data) return <Screen title="Receive">{r.error ? <ErrorText error={r.error} /> : <T muted>Loading…</T>}</Screen>;
  const e = r.data.entries[i];
  return (
    <Screen title="Receive">
      <T>Backstop users can pay you at @{r.data.handle}.</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 12 }} accessibilityRole="radiogroup">
        {r.data.entries.map((x: any, j: number) => (
          <Pressable key={x.network} accessibilityRole="radio" accessibilityState={{ checked: j === i }} onPress={() => setI(j)} style={{ minHeight: 44, justifyContent: 'center' }}>
            <Badge label={`${x.token} on ${x.networkLabel}`} kind={j === i ? 'ok' : 'info'} />
          </Pressable>
        ))}
      </View>
      <Notice kind="warn" title={`Only ${e.token} on ${e.networkLabel}`}>
        {e.warning}
      </Notice>
      <Card>
        <View style={{ alignItems: 'center', padding: 12, backgroundColor: '#fff', borderRadius: 12 }} accessible accessibilityLabel={`QR code for your ${e.token} address on ${e.networkLabel}`}>
          <QRCode value={e.qr} size={200} />
        </View>
        <T style={{ marginTop: 12, fontFamily: 'monospace' }}>{e.address}</T>
        <Button label="Copy address" kind="secondary" onPress={() => void Clipboard.setStringAsync(e.address)} />
        <Button label="Share" kind="secondary" onPress={() => void Share.share({ message: `${e.token} on ${e.networkLabel}: ${e.address}` })} />
      </Card>
    </Screen>
  );
}

export function HistoryScreen() {
  const h = useLoad(() => api.get('/wallet/history?limit=100'));
  return (
    <Screen title="History">
      <ErrorText error={h.error} />
      {(h.data?.items ?? []).map((x: any) => (
        <Card key={x.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <T bold>
              {x.direction === 'in' ? '+' : '−'}
              {usd(x.amount)} {x.token}
            </T>
            <Badge label={x.status} kind={x.status === 'final' ? 'ok' : x.status === 'failed' ? 'danger' : 'info'} />
          </View>
          <T muted size={14}>
            {x.direction === 'in' ? 'From' : 'To'} {x.counterparty ? `@${x.counterparty}` : (x.direction === 'in' ? x.from_address : x.to_address)?.slice(0, 14) + '…'} · {x.network}
          </T>
          {x.direction === 'in' && x.availability !== 'available' && <Badge label={x.availability.replace('_', ' ')} kind="warn" />}
          {x.nairaReference && (
            <T muted size={13}>
              ≈ {x.nairaReference}
            </T>
          )}
        </Card>
      ))}
    </Screen>
  );
}

export function SendScreen({ done }: { done: () => void }) {
  const [step, setStep] = useState(1);
  const [recipient, setRecipient] = useState('');
  const [resolved, setResolved] = useState<any>(null);
  const [token, setToken] = useState<'USDT' | 'USDC'>('USDT');
  const [network, setNetwork] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<any>(null);
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const [receipt, setReceipt] = useState<any>(null);
  const idem = useMemo(() => Crypto.randomUUID(), [quote?.check?.decisionId]);
  const resolve = useAction(async () => {
    const r = await api.post('/send/resolve', { recipient: recipient.trim() });
    setResolved(r);
    if (r.type === 'address' && r.networks.length === 1) setNetwork(r.networks[0]);
    setStep(2);
  });
  const getQuote = useAction(async () => {
    setQuote(await api.post('/send/quote', { recipient: recipient.trim(), token, amount, network: network || undefined, networkConfirmed: confirmed }));
    setAcks({});
    setStep(3);
  });
  const send = useAction(async () => {
    if (quote.check.decision === 'warn') await api.post('/send/override', { decisionId: quote.check.decisionId, acknowledged: Object.keys(acks).filter((k) => acks[k]) });
    setReceipt(await signSend(quote.check.decisionId, idem));
    setStep(4);
  });
  const reasons = quote?.check?.reasons ?? [];
  const blocked = quote?.check?.decision === 'block';
  return (
    <Screen title="Send">
      {step === 1 && (
        <Card>
          <ErrorText error={resolve.error} />
          <Input label="Who are you paying?" hint="@handle, phone number or address" autoCapitalize="none" value={recipient} onChangeText={setRecipient} />
          <Button label="Continue" onPress={() => void resolve.run()} busy={resolve.busy} />
        </Card>
      )}
      {step === 2 && resolved && (
        <Card>
          <T>
            Paying {resolved.handle ? `@${resolved.handle}` : resolved.address}
            {resolved.verifiedName ? ` (${resolved.verifiedName})` : ''}
          </T>
          <ErrorText error={getQuote.error} />
          <View style={{ flexDirection: 'row', gap: 8, marginVertical: 8 }}>
            {(['USDT', 'USDC'] as const).map((tk) => (
              <View key={tk} style={{ flex: 1 }}>
                <Button label={tk} kind={tk === token ? 'primary' : 'secondary'} onPress={() => setToken(tk)} disabled={network === 'tron' && tk === 'USDC'} />
              </View>
            ))}
          </View>
          {resolved.type === 'address' && resolved.networks.length > 1 && (
            <>
              <T muted size={14}>
                {resolved.networkHint}
              </T>
              {resolved.networks.map((nw: string) => (
                <Button key={nw} label={`${nw}${nw === network ? ' ✓' : ''}`} kind={nw === network ? 'primary' : 'secondary'} onPress={() => setNetwork(nw)} />
              ))}
              <Button label={confirmed ? 'Recipient expects this network ✓' : 'I confirmed the network with the recipient'} kind="secondary" onPress={() => setConfirmed(!confirmed)} />
            </>
          )}
          <Input label="Amount in dollars" keyboardType="decimal-pad" value={amount} onChangeText={setAmount} />
          <Button label="Review" onPress={() => void getQuote.run()} busy={getQuote.busy} />
        </Card>
      )}
      {step === 3 && quote && (
        <Card>
          <T>
            {usd(quote.amount)} {quote.token} on {quote.networkLabel}
          </T>
          <T muted>
            Fee {usd(quote.fee)} · total {usd(quote.total)} · ≈ {quote.nairaReference.value}
          </T>
          {quote.check.degradedNotice && <Notice kind="warn">{quote.check.degradedNotice}</Notice>}
          {reasons.map((r: any) => (
            <Notice key={r.code} kind={r.severity === 'block' ? 'danger' : 'warn'} title={r.title}>
              <T>{r.body}</T>
              {r.severity === 'warn' && <Button label={acks[r.code] ? 'I understand ✓' : 'I understand'} kind="secondary" onPress={() => setAcks({ ...acks, [r.code]: !acks[r.code] })} />}
            </Notice>
          ))}
          <ErrorText error={send.error} />
          {blocked ? (
            <Notice kind="danger" title="This payment can't be sent" />
          ) : (
            <Button label="Confirm and send" onPress={() => void send.run()} busy={send.busy} disabled={reasons.some((r: any) => !acks[r.code])} />
          )}
        </Card>
      )}
      {step === 4 && receipt && (
        <Card>
          <T bold>Sent</T>
          <T muted>We'll notify you when it's final.</T>
          <T style={{ fontFamily: 'monospace' }}>{receipt.txHash}</T>
          <Button label="Share receipt" kind="secondary" onPress={() => void Share.share({ message: `Backstop payment sent. Transaction: ${receipt.txHash}` })} />
          <Button label="Done" onPress={done} />
        </Card>
      )}
    </Screen>
  );
}

export function useRefresh(reload: () => void) {
  const [refreshing, setRefreshing] = useState(false);
  return <RefreshControl refreshing={refreshing} onRefresh={() => (setRefreshing(true), reload(), setTimeout(() => setRefreshing(false), 600))} />;
}
