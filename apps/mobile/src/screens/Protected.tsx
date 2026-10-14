// Protected payments (L2/L3/L4 escrow) and the P2P trade room on mobile.
import { useState } from 'react';
import { View } from 'react-native';
import { api } from '../lib/api';
import { signPaymentAction } from '../lib/passkey';
import { Badge, Button, Card, ErrorText, Input, Notice, Screen, T, usd, useAction, useLoad } from '../components/ui';

const LABEL: Record<string, string> = {
  created: 'Awaiting funding',
  funded: 'Held in escrow',
  delivered: 'Delivered, on hold',
  disputed: 'Disputed',
  released: 'Released',
  refunded: 'Refunded',
  cancelled: 'Cancelled',
};

export function PaymentsScreen({ open }: { open: (id: string) => void }) {
  const p = useLoad(() => api.get('/payments'));
  const t = useLoad(() => api.get('/p2p/trades').catch(() => ({ trades: [] })));
  return (
    <Screen title="Protected payments">
      <ErrorText error={p.error} />
      {(p.data?.payments ?? []).map((x: any) => (
        <Card key={x.id}>
          <T bold>{x.title}</T>
          <T muted size={14}>
            {x.loop} · {usd(x.amount)} {x.token}
          </T>
          <Badge label={LABEL[x.status] ?? x.status} kind={x.status === 'disputed' ? 'warn' : 'info'} />
          <Button label="Open" kind="secondary" onPress={() => open(x.id)} />
        </Card>
      ))}
      {(t.data?.trades ?? []).length > 0 && <T bold>P2P trades</T>}
      {(t.data?.trades ?? []).map((x: any) => (
        <Card key={x.id}>
          <T>
            {x.role === 'seller' ? 'Selling' : 'Buying'} {x.usdt} USDT for {x.naira}
          </T>
          <Badge label={x.status} />
          <Button label="Open trade" kind="secondary" onPress={() => open(`trade:${x.id}`)} />
        </Card>
      ))}
    </Screen>
  );
}

export function PaymentScreen({ id }: { id: string }) {
  const p = useLoad(() => api.get(`/payments/${id}`), [id]);
  const [statement, setStatement] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const act = useAction(async (label: string, path: string, body: Record<string, unknown> = {}) => {
    await signPaymentAction(id, () => api.post(path, body));
    setMsg(`${label} submitted. This updates when the network confirms it.`);
    setTimeout(p.reload, 1500);
  });
  if (!p.data) return <Screen>{p.error ? <ErrorText error={p.error} /> : <T muted>Loading…</T>}</Screen>;
  const x = p.data;
  const can = (a: string) => x.actions.includes(a);
  return (
    <Screen title={x.title}>
      {msg && <Notice kind="ok">{msg}</Notice>}
      <ErrorText error={act.error} />
      {x.releasePausedReason && <Notice kind="warn" title="Auto-release paused">{x.releasePausedReason}</Notice>}
      <Card>
        <Badge label={LABEL[x.status] ?? x.status} />
        <T>
          {usd(x.amount)} {x.token} {x.networkLabel ? `on ${x.networkLabel}` : ''}
        </T>
        <T muted size={14}>
          Fee {usd(x.fee)} on release only. Refunds return the full amount.
        </T>
        {x.holdUntil && <T muted size={14}>Releases automatically {new Date(x.holdUntil).toLocaleString()}</T>}
        {x.disputeDeadline && ['funded', 'delivered'].includes(x.status) && <T muted size={14}>Dispute before {new Date(x.disputeDeadline).toLocaleString()}</T>}
      </Card>
      <Card>
        {can('release') && <Button label="Approve and release" onPress={() => void act.run('Release', `/payments/${id}/release`)} busy={act.busy} />}
        {can('releaseAfterHold') && <Button label="Release now (hold ended)" onPress={() => void act.run('Release', `/payments/${id}/release-after-hold`)} busy={act.busy} />}
        {can('markDelivered') && x.loop === 'L2' && <Button label="Mark delivered" onPress={() => void act.run('Delivery', `/payments/${id}/deliveries`, { note: statement || 'Delivered', links: [] })} busy={act.busy} />}
        {can('refundByPayee') && <Button label="Return the money to the payer" kind="secondary" onPress={() => void act.run('Refund', `/payments/${id}/refund`)} busy={act.busy} />}
        {can('reclaimAfterDeadline') && <Button label="Reclaim (deadline missed)" onPress={() => void act.run('Reclaim', `/payments/${id}/reclaim`)} busy={act.busy} />}
        {can('dispute') && (
          <View>
            <Input label="What went wrong?" multiline value={statement} onChangeText={setStatement} style={{ minHeight: 100, textAlignVertical: 'top' }} />
            <Button label="Open a dispute" kind="danger" disabled={statement.length < 10} onPress={() => void act.run('Dispute', `/payments/${id}/disputes`, { reason: 'Problem with this payment', statement })} busy={act.busy} />
          </View>
        )}
      </Card>
      {x.dispute && (
        <Card>
          <T bold>Dispute</T>
          <T>{x.dispute.reason}</T>
          {x.dispute.ruling && <Notice kind="info" title={`Ruling: ${x.dispute.ruling}`}>{x.dispute.ruling_reason}</Notice>}
        </Card>
      )}
    </Screen>
  );
}

export function TradeScreen({ id }: { id: string }) {
  const t = useLoad(() => api.get(`/p2p/trades/${id}`), [id]);
  const m = useLoad(() => api.get(`/p2p/trades/${id}/messages`), [id]);
  const [text, setText] = useState('');
  const [blocked, setBlocked] = useState<string | null>(null);
  const act = useAction(async (path: string, body?: unknown) => {
    await signPaymentAction(t.data.payment.id, () => api.post(path, body ?? {}));
    setTimeout(t.reload, 1500);
  });
  const send = useAction(async () => {
    const r = await api.post(`/p2p/trades/${id}/messages`, { body: text });
    setBlocked(r.blocked ? r.reason : null);
    setText('');
    m.reload();
  });
  if (!t.data) return <Screen>{t.error ? <ErrorText error={t.error} /> : <T muted>Loading…</T>}</Screen>;
  const x = t.data;
  const seller = x.role === 'seller';
  return (
    <Screen title={`${seller ? 'Selling' : 'Buying'} ${x.usdt} USDT`}>
      <Card>
        <T>Seller: {x.seller.verifiedName} · {x.seller.completedTrades} trades · {x.seller.disputeRate}% disputed</T>
        <T>Buyer: {x.buyer.verifiedName} · {x.buyer.completedTrades} trades · {x.buyer.disputeRate}% disputed</T>
        <T bold>{x.naira}</T>
        <Badge label={x.status} />
      </Card>
      {!seller && x.status === 'escrowed' && (
        <Notice kind="info" title="Pay now">
          <T>
            Send {x.naira} to {x.payTo.bankName} {x.payTo.accountNumber ?? `••••${x.payTo.last4}`} ({x.payTo.accountName}) from your own account {x.payFrom.bankName} ••••{x.payFrom.last4}.
          </T>
        </Notice>
      )}
      <ErrorText error={act.error} />
      {seller && x.status === 'awaiting_escrow' && <Button label="Lock USDT in escrow" onPress={() => void act.run(`/p2p/trades/${id}/fund`)} busy={act.busy} />}
      {!seller && x.status === 'escrowed' && <Button label="I've paid from my own account" onPress={() => void act.run(`/p2p/trades/${id}/paid`, { fromOwnAccount: true })} busy={act.busy} />}
      {seller && x.status === 'paid' && <Button label="Naira received — release USDT" onPress={() => void act.run(`/p2p/trades/${id}/confirm`, { receivedFromBuyerAccount: true })} busy={act.busy} />}
      <Card>
        <T bold>Trade chat</T>
        {(m.data?.messages ?? []).map((msg: any) => (
          <View key={msg.id} style={{ alignSelf: msg.from === 'me' ? 'flex-end' : msg.from === 'system' ? 'center' : 'flex-start', marginVertical: 4, maxWidth: '85%' }}>
            <T muted={msg.from === 'system'} size={msg.from === 'system' ? 13 : 16}>
              {msg.body}
            </T>
          </View>
        ))}
        {blocked && <Notice kind="warn">{blocked}</Notice>}
        <Input label="Message" value={text} onChangeText={setText} />
        <Button label="Send" kind="secondary" onPress={() => void send.run()} disabled={!text} busy={send.busy} />
      </Card>
    </Screen>
  );
}
