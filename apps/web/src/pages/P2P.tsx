// L4 P2P trading: offer book, bank accounts, my offers and trades; trade room with timer and chat.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { signPaymentAction } from '../lib/sign';
import { ErrorNotice, Field, Loading, Money, Notice, Sheet, Status, useAction, useLoad, When } from '../components/ui';

function BankAccounts({ onChange }: { onChange?: () => void }) {
  const b = useLoad(() => api.get('/bank-accounts'));
  const [f, setF] = useState({ bankCode: '', accountNumber: '' });
  const add = useAction(async () => {
    await api.post('/bank-accounts', f);
    setF({ bankCode: '', accountNumber: '' });
    b.reload();
    onChange?.();
  });
  return (
    <div className="card">
      <h2>Your bank accounts</h2>
      <p className="small muted">Only accounts in your own verified name. We check the name with the bank; we never move naira.</p>
      <ul className="list">
        {(b.data?.accounts ?? []).map((a: any) => (
          <li key={a.id} className="spread">
            <span>
              {a.bank_name} ••••{a.account_last4} · {a.account_name}
            </span>
            <button className="btn link" onClick={() => void api.del(`/bank-accounts/${a.id}`).then(b.reload)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void add.run();
        }}
      >
        <ErrorNotice error={add.error} />
        <div className="grid two">
          <Field label="Bank">
            {(id) => (
              <select id={id} value={f.bankCode} onChange={(e) => setF({ ...f, bankCode: e.target.value })} required>
                <option value="">Choose…</option>
                {(b.data?.banks ?? []).map((x: any) => (
                  <option key={x.code} value={x.code}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Account number">{(id) => <input id={id} inputMode="numeric" maxLength={10} value={f.accountNumber} onChange={(e) => setF({ ...f, accountNumber: e.target.value })} required />}</Field>
        </div>
        <button className="btn secondary" disabled={add.busy}>
          Add and verify name
        </button>
      </form>
    </div>
  );
}

export function P2P() {
  const nav = useNavigate();
  const [side, setSide] = useState<'sell' | 'buy'>('sell');
  const book = useLoad(() => api.get(`/p2p/offers?side=${side}`), [side]);
  const trades = useLoad(() => api.get('/p2p/trades'));
  const banks = useLoad(() => api.get('/bank-accounts'));
  const [take, setTake] = useState<any>(null);
  const [amount, setAmount] = useState('');
  const [bank, setBank] = useState('');
  const [offer, setOffer] = useState({ side: 'sell', priceNgn: '', min: '', max: '', paymentWindowMinutes: 30, bankAccountId: '', terms: '' });
  const [showOffer, setShowOffer] = useState(false);
  const open = useAction(async () => {
    const t = await api.post('/p2p/trades', { offerId: take.id, amount, bankAccountId: bank });
    nav(`/p2p/trades/${t.id}`);
  });
  const post = useAction(async () => {
    await api.post('/p2p/offers', { ...offer, terms: offer.terms || undefined });
    setShowOffer(false);
    book.reload();
  });
  if (book.error && (book.error as { code?: string }).code === 'p2p_unavailable') return <Notice kind="info" title="P2P trading is coming soon">It launches after legal sign-off.</Notice>;
  return (
    <div>
      <div className="spread">
        <h1>P2P trading</h1>
        <button className="btn" onClick={() => setShowOffer(true)}>
          Post an offer
        </button>
      </div>
      <Notice kind="info">The seller's USDT is held in escrow. Pay naira only from your own registered account; payments from anyone else are refunded and the trade is closed.</Notice>
      <div className="card">
        <div role="tablist" className="row" style={{ marginBottom: 12 }}>
          <button role="tab" aria-selected={side === 'sell'} className={`btn ${side === 'sell' ? '' : 'secondary'}`} onClick={() => setSide('sell')}>
            Buy USDT
          </button>
          <button role="tab" aria-selected={side === 'buy'} className={`btn ${side === 'buy' ? '' : 'secondary'}`} onClick={() => setSide('buy')}>
            Sell USDT
          </button>
        </div>
        <ErrorNotice error={book.error} />
        {!book.data ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Merchant</th>
                  <th scope="col">Price</th>
                  <th scope="col">Limits</th>
                  <th scope="col">Window</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {book.data.offers.map((o: any) => (
                  <tr key={o.id}>
                    <td>
                      <strong>{o.merchant.verifiedName}</strong> @{o.merchant.handle}
                      <div className="small muted">
                        {o.merchant.completedTrades} trades · {o.merchant.disputeRate}% disputed {o.merchant.tier === 'tier2' && '· business'}
                      </div>
                    </td>
                    <td>₦{Number(o.priceNgn).toLocaleString()}</td>
                    <td>
                      <Money amount={o.min} />–<Money amount={o.max} />
                    </td>
                    <td>{o.paymentWindowMinutes} min</td>
                    <td>
                      <button className="btn secondary" onClick={() => setTake(o)}>
                        {side === 'sell' ? 'Buy' : 'Sell'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card">
        <h2>Your trades</h2>
        <ul className="list">
          {(trades.data?.trades ?? []).map((t: any) => (
            <li key={t.id} className="spread">
              <Link to={`/p2p/trades/${t.id}`}>
                {t.role === 'seller' ? 'Selling' : 'Buying'} {t.usdt} USDT for {t.naira}
              </Link>
              <Status value={t.status} />
            </li>
          ))}
        </ul>
      </div>
      <BankAccounts onChange={banks.reload} />
      {take && (
        <Sheet title={`Trade with ${take.merchant.verifiedName}`} onClose={() => setTake(null)}>
          <p className="small">
            {take.merchant.completedTrades} completed trades, {take.merchant.disputeRate}% disputed. Price ₦{Number(take.priceNgn).toLocaleString()} per USDT.
          </p>
          <ErrorNotice error={open.error} />
          <Field label="Amount (USDT)" hint={`Between ${take.min} and ${take.max}`}>
            {(id, d) => <input id={id} aria-describedby={d} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />}
          </Field>
          <Field label={take.side === 'sell' ? 'Pay naira from' : 'Receive naira into'}>
            {(id) => (
              <select id={id} value={bank} onChange={(e) => setBank(e.target.value)} required>
                <option value="">Choose your account…</option>
                {(banks.data?.accounts ?? []).map((a: any) => (
                  <option key={a.id} value={a.id}>
                    {a.bank_name} ••••{a.account_last4}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {amount && <p>≈ ₦{(Number(amount) * Number(take.priceNgn)).toLocaleString()}</p>}
          <button className="btn" disabled={open.busy || !bank || !amount} onClick={() => void open.run()}>
            Open trade
          </button>
        </Sheet>
      )}
      {showOffer && (
        <Sheet title="Post an offer" onClose={() => setShowOffer(false)}>
          <ErrorNotice error={post.error} />
          <Field label="I want to">
            {(id) => (
              <select id={id} value={offer.side} onChange={(e) => setOffer({ ...offer, side: e.target.value })}>
                <option value="sell">Sell USDT</option>
                <option value="buy">Buy USDT</option>
              </select>
            )}
          </Field>
          <Field label="Price (₦ per USDT)">{(id) => <input id={id} inputMode="decimal" value={offer.priceNgn} onChange={(e) => setOffer({ ...offer, priceNgn: e.target.value })} required />}</Field>
          <div className="grid two">
            <Field label="Min ($)">{(id) => <input id={id} inputMode="decimal" value={offer.min} onChange={(e) => setOffer({ ...offer, min: e.target.value })} required />}</Field>
            <Field label="Max ($)">{(id) => <input id={id} inputMode="decimal" value={offer.max} onChange={(e) => setOffer({ ...offer, max: e.target.value })} required />}</Field>
          </div>
          <Field label="Payment window (minutes, 15–60)">{(id) => <input id={id} type="number" min={15} max={60} value={offer.paymentWindowMinutes} onChange={(e) => setOffer({ ...offer, paymentWindowMinutes: Number(e.target.value) })} />}</Field>
          <Field label={offer.side === 'sell' ? 'Receive naira into' : 'Pay naira from'}>
            {(id) => (
              <select id={id} value={offer.bankAccountId} onChange={(e) => setOffer({ ...offer, bankAccountId: e.target.value })} required>
                <option value="">Choose…</option>
                {(banks.data?.accounts ?? []).map((a: any) => (
                  <option key={a.id} value={a.id}>
                    {a.bank_name} ••••{a.account_last4}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Terms (optional)" hint="No phone numbers, emails or links.">
            {(id, d) => <textarea id={id} aria-describedby={d} value={offer.terms} onChange={(e) => setOffer({ ...offer, terms: e.target.value })} />}
          </Field>
          <button className="btn" disabled={post.busy} onClick={() => void post.run()}>
            Post offer
          </button>
        </Sheet>
      )}
    </div>
  );
}

function Countdown({ until }: { until: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!until) return null;
  const left = Math.max(0, new Date(until).getTime() - now);
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return (
    <span className="badge warn" role="timer" aria-live="off">
      {left ? `${m}:${String(s).padStart(2, '0')} left` : 'Time is up'}
    </span>
  );
}

export function TradeRoom() {
  const { id } = useParams();
  const t = useLoad(() => api.get(`/p2p/trades/${id}`), [id]);
  const msgs = useLoad(() => api.get(`/p2p/trades/${id}/messages`), [id]);
  const [text, setText] = useState('');
  const [blocked, setBlocked] = useState<string | null>(null);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [disp, setDisp] = useState({ reason: 'not_received', statement: '' });
  useEffect(() => {
    const iv = setInterval(() => {
      t.reload();
      msgs.reload();
    }, 10_000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const act = useAction(async (path: string, body?: unknown) => {
    await signPaymentAction(t.data.payment.id, () => api.post(path, body ?? {}));
    setTimeout(t.reload, 1500);
  });
  const send = useAction(async () => {
    const r = await api.post(`/p2p/trades/${id}/messages`, { body: text });
    setBlocked(r.blocked ? r.reason : null);
    setText('');
    msgs.reload();
  });
  if (t.error) return <ErrorNotice error={t.error} />;
  if (!t.data) return <Loading />;
  const x = t.data;
  const seller = x.role === 'seller';
  return (
    <div>
      <div className="spread">
        <h1>
          {seller ? 'Selling' : 'Buying'} {x.usdt} USDT
        </h1>
        <Status value={x.status} />
      </div>
      <div className="grid two">
        <div className="card">
          <dl className="kv">
            <dt>Seller</dt>
            <dd>
              {x.seller.verifiedName} · {x.seller.completedTrades} trades · {x.seller.disputeRate}% disputed
            </dd>
            <dt>Buyer</dt>
            <dd>
              {x.buyer.verifiedName} · {x.buyer.completedTrades} trades · {x.buyer.disputeRate}% disputed
            </dd>
            <dt>Naira</dt>
            <dd>
              <strong>{x.naira}</strong> at ₦{Number(x.priceNgn).toLocaleString()}
            </dd>
            {x.status === 'escrowed' && (
              <>
                <dt>Time left</dt>
                <dd>
                  <Countdown until={x.paymentDeadline} />
                </dd>
              </>
            )}
          </dl>
          {!seller && x.status === 'escrowed' && (
            <Notice kind="info" title="Pay now">
              Send {x.naira} to {x.payTo.bankName} {x.payTo.accountNumber ?? `••••${x.payTo.last4}`} ({x.payTo.accountName}) from {x.payFrom.bankName} ••••{x.payFrom.last4}. {x.payFrom.rule}
            </Notice>
          )}
          <ErrorNotice error={act.error} />
          <div className="row">
            {seller && x.status === 'awaiting_escrow' && (
              <button className="btn" disabled={act.busy} onClick={() => void act.run(`/p2p/trades/${id}/fund`)}>
                Lock USDT in escrow
              </button>
            )}
            {!seller && x.status === 'escrowed' && (
              <button className="btn" disabled={act.busy} onClick={() => void act.run(`/p2p/trades/${id}/paid`, { fromOwnAccount: true })}>
                I've paid from my own account
              </button>
            )}
            {seller && x.status === 'paid' && (
              <button className="btn" disabled={act.busy} onClick={() => void act.run(`/p2p/trades/${id}/confirm`, { receivedFromBuyerAccount: true })}>
                Naira received from the buyer's account — release USDT
              </button>
            )}
            {seller && x.status === 'cancelled' && x.payment?.actions.includes('reclaimAfterDeadline') && (
              <button className="btn" disabled={act.busy} onClick={() => void act.run(`/payments/${x.payment.id}/reclaim`)}>
                Reclaim USDT
              </button>
            )}
            {['escrowed', 'paid'].includes(x.status) && (
              <button className="btn danger" onClick={() => setDisputeOpen(true)}>
                Open dispute
              </button>
            )}
            {['released', 'refunded'].includes(x.status) && (
              <button className="btn secondary" onClick={() => void api.download(`/p2p/trades/${id}/record.pdf`, `trade-record-${id}.pdf`)}>
                Signed trade record (PDF)
              </button>
            )}
          </div>
        </div>
        <div className="card">
          <h2>Trade chat</h2>
          <div className="chat" aria-live="polite">
            {(msgs.data?.messages ?? []).map((m: any) => (
              <div key={m.id} className={`bubble ${m.from} ${m.blocked ? 'blocked' : ''}`}>
                {m.body}
                {m.blocked && m.from === 'me' && <div className="small">Not delivered: contact details aren't allowed.</div>}
              </div>
            ))}
          </div>
          {blocked && <Notice kind="warn">{blocked}</Notice>}
          <form
            className="row"
            style={{ marginTop: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              void send.run();
            }}
          >
            <label htmlFor="chatmsg" className="skip">
              Message
            </label>
            <input id="chatmsg" value={text} onChange={(e) => setText(e.target.value)} placeholder="Message" style={{ flex: 1 }} required />
            <button className="btn" disabled={send.busy}>
              Send
            </button>
          </form>
          <p className="small muted">Kept as dispute evidence. Sharing phone numbers, emails or links is blocked.</p>
        </div>
      </div>
      {disputeOpen && (
        <Sheet title="Open a dispute" onClose={() => setDisputeOpen(false)}>
          <Notice kind="info">Upload bank evidence within 2 hours. A reviewer rules within 24 hours.</Notice>
          <Field label="What happened?">
            {(fid) => (
              <select id={fid} value={disp.reason} onChange={(e) => setDisp({ ...disp, reason: e.target.value })}>
                {seller ? (
                  <>
                    <option value="not_received">Naira not received</option>
                    <option value="third_party_payment">Naira came from someone else's account</option>
                  </>
                ) : (
                  <option value="paid_not_released">I paid but the seller didn't release</option>
                )}
                <option value="other">Something else</option>
              </select>
            )}
          </Field>
          <Field label="Explain">{(fid) => <textarea id={fid} value={disp.statement} onChange={(e) => setDisp({ ...disp, statement: e.target.value })} minLength={10} required />}</Field>
          <button
            className="btn danger"
            disabled={act.busy || disp.statement.length < 10}
            onClick={() => {
              setDisputeOpen(false);
              void act.run(`/p2p/trades/${id}/dispute`, disp);
            }}
          >
            Open dispute and sign
          </button>
        </Sheet>
      )}
      <p className="small">
        <When at={x.times.opened} /> · <Link to={`/report?trade=${id}`}>Report fraud</Link>
      </p>
    </div>
  );
}
