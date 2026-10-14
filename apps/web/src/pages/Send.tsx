// L1 send flow: recipient -> network (auto for Backstop users, confirmed for external addresses)
// -> amount in dollars with naira reference and fee -> pre-send check (warnings in a sheet) ->
// passkey -> receipt with the transaction hash.
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { signSend } from '../lib/sign';
import { ErrorNotice, Field, Money, Notice, Sheet, Status, useAction } from '../components/ui';

type Quote = any;

export function Send() {
  const nav = useNavigate();
  const [q] = useSearchParams();
  const [step, setStep] = useState(1);
  const [recipient, setRecipient] = useState(q.get('to') ?? '');
  const [resolved, setResolved] = useState<any>(null);
  const [token, setToken] = useState<'USDT' | 'USDC'>((q.get('token') as 'USDT' | 'USDC') ?? 'USDT');
  const [network, setNetwork] = useState<string>('');
  const [networkConfirmed, setNetworkConfirmed] = useState(false);
  const [amount, setAmount] = useState(q.get('amount') ?? '');
  const [typedName, setTypedName] = useState('');
  const [note, setNote] = useState('');
  const [quote, setQuote] = useState<Quote>(null);
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const [showWarnings, setShowWarnings] = useState(false);
  const [receipt, setReceipt] = useState<{ transferId: string; txHash: string | null } | null>(null);
  const idem = useMemo(() => crypto.randomUUID(), [quote?.check?.decisionId]);

  const resolve = useAction(async () => {
    const r = await api.post('/send/resolve', { recipient });
    setResolved(r);
    if (r.type === 'address') {
      setNetwork(r.networks.length === 1 ? r.networks[0] : '');
      if (r.networks.length === 1 && r.networks[0] === 'tron') setToken('USDT');
    }
    setStep(2);
  });
  const getQuote = useAction(async () => {
    const r = await api.post('/send/quote', { recipient, token, amount, network: network || undefined, networkConfirmed, typedName: typedName || undefined, paymentRequestId: q.get('request') ?? undefined });
    setQuote(r);
    setAcks({});
    if (r.check.decision !== 'allow') setShowWarnings(true);
    setStep(3);
  });
  const send = useAction(async () => {
    if (quote.check.decision === 'warn') await api.post('/send/override', { decisionId: quote.check.decisionId, acknowledged: Object.keys(acks).filter((k) => acks[k]) });
    const r = await signSend(quote.check.decisionId, idem, note || undefined, q.get('request') ?? undefined);
    setReceipt(r);
    setStep(4);
  });

  const warnings = quote?.check?.reasons ?? [];
  const blocked = quote?.check?.decision === 'block';
  const allAcked = warnings.every((w: any) => acks[w.code]);

  return (
    <div>
      <h1>Send</h1>
      <div className="steps" aria-hidden="true">
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={n <= step ? 'on' : ''} />
        ))}
      </div>

      {step === 1 && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void resolve.run();
          }}
        >
          <ErrorNotice error={resolve.error} />
          <Field label="Who are you paying?" hint="A Backstop @handle, a phone number (if they allow it), or a TRON or EVM address.">
            {(id, d) => <input id={id} aria-describedby={d} value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} required autoFocus />}
          </Field>
          <button className="btn" disabled={resolve.busy}>
            Continue
          </button>
        </form>
      )}

      {step === 2 && resolved && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void getQuote.run();
          }}
        >
          <p>
            Paying{' '}
            <strong>
              {resolved.handle ? `@${resolved.handle}` : <code>{resolved.address}</code>}
              {resolved.verifiedName ? ` (${resolved.verifiedName})` : ''}
            </strong>
            . <button type="button" className="btn link" onClick={() => setStep(1)}>Change</button>
          </p>
          <ErrorNotice error={getQuote.error} />
          <Field label="Token">
            {(id) => (
              <select id={id} value={token} onChange={(e) => setToken(e.target.value as 'USDT' | 'USDC')} disabled={network === 'tron'}>
                <option value="USDT">USDT</option>
                <option value="USDC">USDC</option>
              </select>
            )}
          </Field>
          {resolved.type === 'user' ? (
            <p className="small muted">We pick the cheapest network you both accept: TRON for USDT, Arc for USDC.</p>
          ) : (
            <>
              <Field label="Network the recipient expects" hint={resolved.networkHint}>
                {(id, d) => (
                  <select id={id} aria-describedby={d} value={network} onChange={(e) => setNetwork(e.target.value)} required>
                    <option value="">Choose…</option>
                    {resolved.networks.map((n: string) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {resolved.requiresNetworkConfirmation && (
                <label className="check">
                  <input type="checkbox" checked={networkConfirmed} onChange={(e) => setNetworkConfirmed(e.target.checked)} required />
                  The recipient told me they expect {token} on {network || 'this network'}. Sending on the wrong network can lose the money.
                </label>
              )}
            </>
          )}
          <Field label="Amount in dollars" hint="Up to 6 decimal places.">
            {(id, d) => <input id={id} aria-describedby={d} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required pattern="\d+(\.\d{1,6})?" />}
          </Field>
          {resolved.type === 'user' && (
            <Field label="Their name (optional)" hint="We'll warn you if it doesn't match their verified name.">
              {(id, d) => <input id={id} aria-describedby={d} value={typedName} onChange={(e) => setTypedName(e.target.value)} />}
            </Field>
          )}
          <Field label="Note (optional)">{(id) => <input id={id} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />}</Field>
          <button className="btn" disabled={getQuote.busy}>
            Review
          </button>
        </form>
      )}

      {step === 3 && quote && (
        <div className="card">
          {quote.check.degradedNotice && <Notice kind="warn">{quote.check.degradedNotice}</Notice>}
          <dl className="kv">
            <dt>To</dt>
            <dd>
              {quote.recipient.handle ? `@${quote.recipient.handle}` : ''} <code>{quote.recipient.address}</code>
            </dd>
            <dt>Network</dt>
            <dd>{quote.networkLabel}</dd>
            <dt>Amount</dt>
            <dd>
              <Money amount={quote.amount} token={quote.token} /> <span className="muted">≈ {quote.nairaReference.value} (reference, {quote.nairaReference.source})</span>
            </dd>
            <dt>Fee</dt>
            <dd>
              <Money amount={quote.fee} token={quote.token} />
            </dd>
            <dt>Total</dt>
            <dd>
              <strong>
                <Money amount={quote.total} token={quote.token} />
              </strong>
            </dd>
            <dt>Safety check</dt>
            <dd>
              <Status value={quote.check.decision} />{' '}
              {warnings.length > 0 && (
                <button className="btn link" onClick={() => setShowWarnings(true)}>
                  See {warnings.length} reason{warnings.length > 1 ? 's' : ''}
                </button>
              )}
            </dd>
          </dl>
          <ErrorNotice error={send.error} />
          {blocked ? (
            <Notice kind="danger" title="This payment can't be sent">
              {warnings.filter((w: any) => w.severity === 'block').map((w: any) => w.body).join(' ')}
            </Notice>
          ) : (
            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn" disabled={send.busy || (quote.check.decision === 'warn' && !allAcked)} onClick={() => void send.run()}>
                {send.busy ? 'Confirm with your passkey…' : 'Confirm and send'}
              </button>
              {quote.check.decision === 'warn' && !allAcked && (
                <button className="btn secondary" onClick={() => setShowWarnings(true)}>
                  Read warnings
                </button>
              )}
              <button className="btn secondary" onClick={() => setStep(2)}>
                Back
              </button>
            </div>
          )}
          {showWarnings && (
            <Sheet title={blocked ? 'Payment blocked' : 'Before you send'} onClose={() => setShowWarnings(false)}>
              {warnings.map((w: any) => (
                <div key={w.code} className={`notice ${w.severity === 'block' ? 'danger' : 'warn'}`}>
                  <strong>{w.title}</strong>
                  <p>{w.body}</p>
                  {w.severity === 'warn' && (
                    <label className="check">
                      <input type="checkbox" checked={!!acks[w.code]} onChange={(e) => setAcks({ ...acks, [w.code]: e.target.checked })} />I understand
                    </label>
                  )}
                </div>
              ))}
              {quote.check.offerProtectedSwitch && (
                <Notice kind="info" title="Safer: send as a protected payment">
                  The money is held until they deliver, with a Backstop dispute desk if they don't.{' '}
                  <Link to={`/invoices/new?protected=1&amount=${quote.amount}`}>Switch to a protected payment</Link>
                </Notice>
              )}
              <button className="btn" onClick={() => setShowWarnings(false)}>
                {blocked ? 'OK' : 'Done'}
              </button>
            </Sheet>
          )}
        </div>
      )}

      {step === 4 && receipt && (
        <div className="card stack">
          <h2>Sent</h2>
          <p>
            Your payment is submitted. It moves from <Status value="submitted" /> to <Status value="confirmed" /> to <Status value="final" />; we'll notify you when it's final.
          </p>
          {receipt.txHash && (
            <p>
              Transaction hash: <code>{receipt.txHash}</code>
            </p>
          )}
          <div className="row">
            <button
              className="btn secondary"
              onClick={() => void navigator.share?.({ title: 'Backstop payment', text: `Payment sent. Transaction: ${receipt.txHash}` }).catch(() => undefined)}
            >
              Share receipt
            </button>
            <button className="btn" onClick={() => nav(`/transfers/${receipt.transferId}`)}>
              View status
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
