// L2 freelancer invoices.
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Copy, ErrorNotice, Field, Loading, Money, Notice, Status, useAction, useLoad, When } from '../components/ui';

export function Invoices() {
  const inv = useLoad(() => api.get('/invoices'));
  const approvals = useLoad(() => api.get('/approvals'));
  return (
    <div>
      <div className="spread">
        <h1>Invoices</h1>
        <Link className="btn" to="/invoices/new">
          New invoice
        </Link>
      </div>
      <ErrorNotice error={inv.error} />
      {approvals.data?.approvals?.filter((a: any) => a.status === 'pending').length > 0 && (
        <div className="card">
          <h2>Waiting for your approval</h2>
          {approvals.data.approvals
            .filter((a: any) => a.status === 'pending')
            .map((a: any) => (
              <div key={a.id} className="spread">
                <span>
                  {a.company_name}: {a.action} “{a.title}”
                </span>
                <span className="row">
                  <button className="btn" onClick={() => void api.post(`/approvals/${a.id}/decide`, { approve: true }).then(approvals.reload)}>
                    Approve
                  </button>
                  <button className="btn secondary" onClick={() => void api.post(`/approvals/${a.id}/decide`, { approve: false }).then(approvals.reload)}>
                    Reject
                  </button>
                </span>
              </div>
            ))}
        </div>
      )}
      {!inv.data ? (
        <Loading />
      ) : inv.data.invoices.length === 0 ? (
        <div className="card">
          <p>Invoice a client abroad. Their money is locked in escrow before you start, and released when you deliver.</p>
        </div>
      ) : (
        <div className="card">
          <ul className="list">
            {inv.data.invoices.map((i: any) => (
              <li key={i.id} className="spread">
                <div>
                  <Link to={`/invoices/${i.id}`}>{i.description}</Link>
                  <div className="small muted">
                    {i.client_email} · <Money amount={i.total} token={i.token} /> · {i.milestones.length} milestone(s)
                  </div>
                </div>
                <Status value={i.status === 'sent' ? 'created' : i.status} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function NewInvoice() {
  const nav = useNavigate();
  const [q] = useSearchParams();
  const { me } = useSession();
  const defDue = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const [f, setF] = useState({ clientEmail: '', clientCountry: '', description: '', token: 'USDC', dueDate: defDue, feeSplit: false });
  const [ms, setMs] = useState([{ title: 'Full project', amount: q.get('amount') ?? '', dueDate: defDue }]);
  const create = useAction(async () => {
    const r = await api.post('/invoices', {
      ...f,
      clientCountry: f.clientCountry || undefined,
      dueDate: new Date(`${f.dueDate}T17:00:00Z`).toISOString(),
      milestones: ms.map((m) => ({ ...m, dueDate: new Date(`${m.dueDate}T17:00:00Z`).toISOString() })),
    });
    nav(`/invoices/${r.id}`);
  });
  if (me && me.tier !== 'tier1')
    return (
      <Notice kind="warn" title="Verify your identity first">
        Invoices need Tier 1 verification so clients see your verified name. <Link to="/verify-identity">Verify now</Link>
      </Notice>
    );
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        void create.run();
      }}
    >
      <h1>New invoice</h1>
      <ErrorNotice error={create.error} />
      <Field label="Client email">{(id) => <input id={id} type="email" value={f.clientEmail} onChange={(e) => setF({ ...f, clientEmail: e.target.value })} required />}</Field>
      <Field label="Client country (2-letter code, optional)">{(id) => <input id={id} maxLength={2} value={f.clientCountry} onChange={(e) => setF({ ...f, clientCountry: e.target.value.toUpperCase() })} />}</Field>
      <Field label="What is the work?">{(id) => <textarea id={id} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required />}</Field>
      <div className="grid two">
        <Field label="Token" hint="USDC by default; USDT on TRON allowed.">
          {(id, d) => (
            <select id={id} aria-describedby={d} value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })}>
              <option>USDC</option>
              <option>USDT</option>
            </select>
          )}
        </Field>
        <Field label="Invoice due date">{(id) => <input id={id} type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} required />}</Field>
      </div>
      <h2>Milestones</h2>
      <p className="small muted">Each milestone is its own escrow, up to 10.</p>
      {ms.map((m, i) => (
        <fieldset key={i} className="card" style={{ padding: 12 }}>
          <legend className="small">Milestone {i + 1}</legend>
          <div className="grid two">
            <Field label="Title">{(id) => <input id={id} value={m.title} onChange={(e) => setMs(ms.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} required />}</Field>
            <Field label="Amount ($)">{(id) => <input id={id} inputMode="decimal" value={m.amount} onChange={(e) => setMs(ms.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} required />}</Field>
            <Field label="Deliver by">{(id) => <input id={id} type="date" value={m.dueDate} onChange={(e) => setMs(ms.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)))} required />}</Field>
          </div>
          {ms.length > 1 && (
            <button type="button" className="btn link" onClick={() => setMs(ms.filter((_, j) => j !== i))}>
              Remove milestone
            </button>
          )}
        </fieldset>
      ))}
      {ms.length < 10 && (
        <button type="button" className="btn secondary" onClick={() => setMs([...ms, { title: '', amount: '', dueDate: defDue }])}>
          Add milestone
        </button>
      )}
      <label className="check" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={f.feeSplit} onChange={(e) => setF({ ...f, feeSplit: e.target.checked })} />
        Split the 1% fee with the client
      </label>
      <button className="btn" disabled={create.busy} style={{ marginTop: 12 }}>
        Send invoice
      </button>
    </form>
  );
}

export function InvoiceDetail() {
  const { id } = useParams();
  const inv = useLoad(() => api.get(`/invoices/${id}`), [id]);
  if (inv.error) return <ErrorNotice error={inv.error} />;
  if (!inv.data) return <Loading />;
  const i = inv.data;
  return (
    <div>
      <h1>{i.description}</h1>
      <div className="card stack">
        <p>
          To {i.client_email} · <Money amount={i.total} token={i.token} /> · due <When at={i.due_date} />
        </p>
        <div className="row">
          <code>{i.link}</code>
          <Copy text={i.link} label="Copy checkout link" />
          <button className="btn secondary" onClick={() => void api.download(`/invoices/${i.id}/pdf`, `invoice-${i.id}.pdf`)}>
            Invoice PDF
          </button>
        </div>
      </div>
      <div className="card">
        <h2>Milestones</h2>
        <ul className="list">
          {i.milestones.map((m: any) => (
            <li key={m.id} className="spread">
              <div>
                <Link to={`/payments/${m.id}`}>{m.title}</Link>
                <div className="small muted">
                  <Money amount={m.amount} token={m.token} /> · fee <Money amount={m.fee} /> · deliver by <When at={m.deliverBy} />
                </div>
              </div>
              <Status value={m.status} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
