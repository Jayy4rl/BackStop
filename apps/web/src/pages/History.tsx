// C2-9 history (status, counterparty, network, fee, naira reference; CSV export) and transfer
// detail with the hold reason and appeal link (C2-6, C3-4).
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { ErrorNotice, Field, Loading, Money, Notice, Status, useAction, useLoad, When } from '../components/ui';

export function History() {
  const h = useLoad(() => api.get('/wallet/history?limit=200'));
  return (
    <div>
      <div className="spread">
        <h1>History</h1>
        <button className="btn secondary" onClick={() => void api.download('/wallet/history.csv', 'backstop-history.csv')}>
          Export CSV
        </button>
      </div>
      <ErrorNotice error={h.error} />
      {!h.data ? (
        <Loading />
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Details</th>
                <th scope="col">Network</th>
                <th scope="col">Amount</th>
                <th scope="col">Fee</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {h.data.items.map((x: any) => (
                <tr key={x.id}>
                  <td className="small">
                    <When at={x.created_at} />
                  </td>
                  <td>
                    <Link to={`/transfers/${x.id}`}>
                      {x.direction === 'in' ? 'From' : 'To'} {x.counterparty ? `@${x.counterparty}` : <code>{(x.direction === 'in' ? x.from_address : x.to_address)?.slice(0, 12)}…</code>}
                    </Link>
                    <div className="small muted">{x.kind.replace(/_/g, ' ')}</div>
                  </td>
                  <td>{x.network}</td>
                  <td>
                    {x.direction === 'in' ? '+' : '−'}
                    <Money amount={x.amount} token={x.token} />
                    {x.nairaReference && <div className="small muted">≈ {x.nairaReference}</div>}
                  </td>
                  <td>{x.fee !== '0' ? <Money amount={x.fee} /> : '—'}</td>
                  <td>
                    <Status value={x.status} /> {x.direction === 'in' && x.availability !== 'available' && <Status value={x.availability} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function TransferPage() {
  const { id } = useParams();
  const tr = useLoad(() => api.get(`/transfers/${id}`), [id]);
  const [statement, setStatement] = useState('');
  const appeal = useAction(async () => {
    await api.post('/appeals/hold', { transferId: id, statement });
    tr.reload();
  });
  if (tr.error) return <ErrorNotice error={tr.error} />;
  if (!tr.data) return <Loading />;
  const x = tr.data;
  const held = x.direction === 'in' && ['on_hold', 'under_review'].includes(x.availability);
  return (
    <div>
      <h1>
        {x.direction === 'in' ? 'Received' : 'Sent'} <Money amount={x.amount} token={x.token} />
      </h1>
      <div className="card">
        <dl className="kv">
          <dt>Status</dt>
          <dd>
            <Status value={x.status} /> {x.direction === 'in' && <Status value={x.availability} />}
          </dd>
          <dt>Network</dt>
          <dd>{x.network}</dd>
          <dt>From</dt>
          <dd>
            <code>{x.from_address}</code>
          </dd>
          <dt>To</dt>
          <dd>
            <code>{x.to_address}</code>
          </dd>
          <dt>Transaction</dt>
          <dd>
            <code>{x.tx_hash ?? '—'}</code>
          </dd>
          <dt>Date</dt>
          <dd>
            <When at={x.created_at} />
          </dd>
        </dl>
      </div>
      {held && (
        <div className="card">
          <h2>Why these funds are {x.availability === 'on_hold' ? 'on hold' : 'under review'}</h2>
          {(x.decision?.reasons ?? []).map((r: any) => (
            <Notice key={r.code} kind={r.severity === 'hold' ? 'danger' : 'warn'} title={r.title}>
              {r.body}
            </Notice>
          ))}
          <p className="small muted">{t('hold.meaning')}</p>
          {x.appeal ? (
            <Notice kind="info" title={`Appeal ${x.appeal.public_ref}: ${x.appeal.status}`}>
              A risk analyst decides by <When at={x.appeal.due_at} />.
            </Notice>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void appeal.run();
              }}
            >
              <ErrorNotice error={appeal.error} />
              <Field label="Appeal this hold" hint="Explain where the money came from. An analyst replies with a written reason.">
                {(fid, d) => <textarea id={fid} aria-describedby={d} value={statement} onChange={(e) => setStatement(e.target.value)} minLength={20} required />}
              </Field>
              <button className="btn" disabled={appeal.busy}>
                Send appeal
              </button>
            </form>
          )}
        </div>
      )}
      <p className="small">
        Something wrong with this payment? <Link to={`/report?transfer=${x.id}&address=${x.direction === 'in' ? x.from_address : x.to_address}`}>Report fraud</Link> ·{' '}
        <Link to={`/support?transfer=${x.id}`}>Contact support</Link>
      </p>
    </div>
  );
}
