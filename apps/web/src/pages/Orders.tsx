// L3 trade orders (importer side).
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Copy, ErrorNotice, Field, Loading, Money, Notice, Status, useAction, useLoad, When } from '../components/ui';
import { FileInput } from './Payment';

export function Orders() {
  const o = useLoad(() => api.get('/orders'));
  return (
    <div>
      <div className="spread">
        <h1>Trade orders</h1>
        <Link className="btn" to="/orders/new">
          New order
        </Link>
      </div>
      <ErrorNotice error={o.error} />
      {!o.data ? (
        <Loading />
      ) : (
        <div className="card">
          {o.data.orders.length === 0 && <p>Prepay an overseas supplier safely: the money is held until they ship, like a letter of credit at a fraction of the cost.</p>}
          <ul className="list">
            {o.data.orders.map((x: any) => (
              <li key={x.id} className="spread">
                <div>
                  <Link to={`/my-orders/${x.id}`}>{x.goods}</Link>
                  <div className="small muted">
                    {x.supplierEmail} · <Money amount={x.total} token={x.token} /> · ship by <When at={x.shippingDeadline} />
                  </div>
                </div>
                <Status value={x.status === 'awaiting_supplier' ? 'created' : x.status} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function NewOrder() {
  const nav = useNavigate();
  const { me } = useSession();
  const [f, setF] = useState({ supplierEmail: '', goodsDescription: '', token: 'USDC', total: '', shippingDeadline: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10), split: 'single', deposit: '' });
  const [proforma, setProforma] = useState<{ id: string; name: string } | null>(null);
  const create = useAction(async () => {
    if (!proforma) throw new Error('Upload the pro forma invoice.');
    const r = await api.post('/orders', { ...f, proformaFileId: proforma.id, shippingDeadline: new Date(`${f.shippingDeadline}T17:00:00Z`).toISOString(), deposit: f.split === 'deposit_balance' ? f.deposit : undefined });
    nav(`/my-orders/${r.id}`);
  });
  if (me && me.tier !== 'tier2')
    return (
      <Notice kind="warn" title="Business verification needed">
        Trade orders are for verified businesses (Tier 2). <Link to="/verify-identity">Verify your business</Link>
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
      <h1>New trade order</h1>
      <ErrorNotice error={create.error} />
      <Field label="Supplier email">{(id) => <input id={id} type="email" value={f.supplierEmail} onChange={(e) => setF({ ...f, supplierEmail: e.target.value })} required />}</Field>
      <Field label="Goods">{(id) => <textarea id={id} value={f.goodsDescription} onChange={(e) => setF({ ...f, goodsDescription: e.target.value })} required />}</Field>
      <FileInput purpose="proforma" label="Pro forma invoice" onUploaded={(id, name) => setProforma({ id, name })} />
      {proforma && <p className="small">Attached: {proforma.name}</p>}
      <div className="grid two">
        <Field label="Token">
          {(id) => (
            <select id={id} value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })}>
              <option>USDC</option>
              <option>USDT</option>
            </select>
          )}
        </Field>
        <Field label="Total ($)">{(id) => <input id={id} inputMode="decimal" value={f.total} onChange={(e) => setF({ ...f, total: e.target.value })} required />}</Field>
        <Field label="Shipping deadline">{(id) => <input id={id} type="date" value={f.shippingDeadline} onChange={(e) => setF({ ...f, shippingDeadline: e.target.value })} required />}</Field>
        <Field label="Payment">
          {(id) => (
            <select id={id} value={f.split} onChange={(e) => setF({ ...f, split: e.target.value })}>
              <option value="single">One payment</option>
              <option value="deposit_balance">Deposit and balance</option>
            </select>
          )}
        </Field>
      </div>
      {f.split === 'deposit_balance' && <Field label="Deposit ($)" hint="Deposit and balance are separate escrows.">{(id, d) => <input id={id} aria-describedby={d} inputMode="decimal" value={f.deposit} onChange={(e) => setF({ ...f, deposit: e.target.value })} required />}</Field>}
      <p className="small muted">Fee: 1.25% of the order, capped, paid by you and deducted only on release. If the supplier misses the shipping deadline you can cancel for a full refund.</p>
      <button className="btn" disabled={create.busy}>
        Send order to supplier
      </button>
    </form>
  );
}

export function OrderDetail() {
  const { id } = useParams();
  const o = useLoad(() => api.get(`/orders/${id}`), [id]);
  if (o.error) return <ErrorNotice error={o.error} />;
  if (!o.data) return <Loading />;
  const x = o.data;
  return (
    <div>
      <h1>{x.goods}</h1>
      <div className="card stack">
        <p>
          Supplier {x.supplierEmail} · <Money amount={x.total} token={x.token} /> · ship by <When at={x.shippingDeadline} />
        </p>
        <p>{x.supplierAccepted ? <Status value="allow" /> : <Status value="created" />} {x.supplierAccepted ? <>Supplier accepted the terms <When at={x.supplierAcceptedAt} /></> : 'Waiting for the supplier to accept the terms.'}</p>
        <div className="row">
          <code>{x.link}</code>
          <Copy text={x.link} label="Copy supplier link" />
        </div>
        <p className="small muted">Estimated fee {x.feeQuote.estimate} {x.token} on release.</p>
      </div>
      <div className="card">
        <h2>Payments</h2>
        <ul className="list">
          {x.payments.map((p: any) => (
            <li key={p.id} className="spread">
              <Link to={`/payments/${p.id}`}>{p.title}</Link>
              <span>
                <Money amount={p.amount} token={p.token} /> <Status value={p.status} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
