// L1-2 payment requests (amount, note, expiry; payable by Backstop users or any wallet) and
// L1-4 saved contacts with the network last used successfully.
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Copy, ErrorNotice, Field, Loading, Money, Notice, Qr, Status, useAction, useLoad, When } from '../components/ui';

export function Requests() {
  const reqs = useLoad(() => api.get('/payment-requests'));
  const contacts = useLoad(() => api.get('/contacts'));
  const [f, setF] = useState({ amount: '', token: 'USDT', note: '', expiresInHours: 72 });
  const [created, setCreated] = useState<any>(null);
  const [c, setC] = useState({ label: '', recipient: '' });
  const create = useAction(async () => {
    setCreated(await api.post('/payment-requests', f));
    reqs.reload();
  });
  const addContact = useAction(async () => {
    await api.post('/contacts', c);
    setC({ label: '', recipient: '' });
    contacts.reload();
  });
  return (
    <div>
      <h1>Requests and contacts</h1>
      <div className="grid two">
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void create.run();
          }}
        >
          <h2>Request a payment</h2>
          <ErrorNotice error={create.error} />
          <Field label="Amount in dollars">{(id) => <input id={id} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required />}</Field>
          <Field label="Token">
            {(id) => (
              <select id={id} value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })}>
                <option>USDT</option>
                <option>USDC</option>
              </select>
            )}
          </Field>
          <Field label="Note">{(id) => <input id={id} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={200} />}</Field>
          <Field label="Expires after (hours)">{(id) => <input id={id} type="number" min={1} max={720} value={f.expiresInHours} onChange={(e) => setF({ ...f, expiresInHours: Number(e.target.value) })} />}</Field>
          <button className="btn" disabled={create.busy}>
            Create link
          </button>
          {created && (
            <div className="stack" style={{ marginTop: 12 }}>
              <Notice kind="ok">Share this link. Anyone can pay it, from Backstop or any wallet.</Notice>
              <code>{created.link}</code>
              <Copy text={created.link} label="Copy link" />
            </div>
          )}
        </form>
        <div className="card">
          <h2>Contacts</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void addContact.run();
            }}
          >
            <ErrorNotice error={addContact.error} />
            <Field label="Name">{(id) => <input id={id} value={c.label} onChange={(e) => setC({ ...c, label: e.target.value })} required />}</Field>
            <Field label="@handle, phone or address">{(id) => <input id={id} value={c.recipient} onChange={(e) => setC({ ...c, recipient: e.target.value })} required />}</Field>
            <button className="btn secondary" disabled={addContact.busy}>
              Save contact
            </button>
          </form>
          <ul className="list">
            {(contacts.data?.contacts ?? []).map((x: any) => (
              <li key={x.id} className="spread">
                <div>
                  <strong>{x.label}</strong> {x.handle ? `@${x.handle}` : <code>{x.address?.slice(0, 14)}…</code>}
                  <div className="small muted">{x.last_network ? `Last paid on ${x.last_network} (${x.last_token})` : 'Not paid yet'}</div>
                </div>
                <div className="row">
                  <Link className="btn secondary" to={`/send?to=${encodeURIComponent(x.handle ? `@${x.handle}` : x.address)}${x.last_token ? `&token=${x.last_token}` : ''}`}>
                    Pay
                  </Link>
                  <button className="btn link" onClick={() => void api.del(`/contacts/${x.id}`).then(contacts.reload)}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="card">
        <h2>Your requests</h2>
        {!reqs.data ? (
          <Loading />
        ) : (
          <ul className="list">
            {reqs.data.requests.map((r: any) => (
              <li key={r.id} className="spread">
                <span>
                  <Money amount={(Number(r.amount_units) / 1e6).toString()} token={r.token} /> {r.note && <span className="muted">· {r.note}</span>}
                </span>
                <span className="small">
                  <Status value={r.status} /> expires <When at={r.expires_at} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function PayRequest() {
  const { slug } = useParams();
  const { me } = useSession();
  const r = useLoad(() => api.get(`/public/pay/${slug}`), [slug]);
  if (r.error) return <ErrorNotice error={r.error} />;
  if (!r.data) return <Loading />;
  const d = r.data;
  return (
    <div className="card stack">
      <h1>
        Pay {d.payee.verifiedName ?? d.payee.displayName} <span className="muted">@{d.payee.handle}</span>
      </h1>
      <p className="big">
        <Money amount={d.amount} token={d.token} />
      </p>
      {d.note && <p>{d.note}</p>}
      {d.status !== 'open' ? (
        <Notice kind="warn">This request is {d.status}.</Notice>
      ) : (
        <>
          <p className="small muted">
            Expires <When at={d.expiresAt} />
          </p>
          {me ? (
            <Link className="btn" to={`/send?to=@${d.payee.handle}&amount=${d.amount}&token=${d.token}&request=${d.id}`}>
              Pay with Backstop
            </Link>
          ) : (
            <Link className="btn" to={`/welcome?next=${encodeURIComponent(`/pay/${slug}`)}`}>
              Pay with Backstop
            </Link>
          )}
          <h2>Or pay from any wallet</h2>
          {d.pay.map((p: any) => (
            <div key={p.network} className="card">
              <Notice kind="warn">{p.warning}</Notice>
              <div className="row">
                <Qr value={p.address} label={`${p.token} address on ${p.networkLabel}`} />
                <div className="stack">
                  <code>{p.address}</code>
                  <Copy text={p.address} />
                </div>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
