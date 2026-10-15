// L3 supplier view: read the terms, verify, accept (recorded before funding), then see proof of
// funds and upload shipping proof from the payment page.
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { LaunchButton } from '../lib/demo';
import { useSession } from '../lib/session';
import { ErrorNotice, Loading, Money, Notice, Status, useAction, useLoad, When } from '../components/ui';

export function SupplierOrder() {
  const { slug } = useParams();
  const { me } = useSession();
  const o = useLoad(() => api.get(`/public/orders/${slug}`), [slug]);
  const accept = useAction(async () => {
    await api.post(`/orders/accept/${slug}`, { termsSha256: o.data.termsSha256 });
    o.reload();
  });
  if (o.error) return <ErrorNotice error={o.error} />;
  if (!o.data) return <Loading />;
  const x = o.data;
  return (
    <div className="stack">
      <h1>Order from {x.importer.name}</h1>
      <div className="card">
        <dl className="kv">
          <dt>Goods</dt>
          <dd>{x.terms.goods}</dd>
          <dt>Amount</dt>
          <dd>
            <Money amount={x.total} token={x.token} /> {x.split === 'deposit_balance' && <>(deposit <Money amount={x.deposit} />, then balance)</>}
          </dd>
          <dt>Ship by</dt>
          <dd>
            <When at={x.shippingDeadline} />
          </dd>
          <dt>Release</dt>
          <dd>{x.terms.release}</dd>
          <dt>If not shipped</dt>
          <dd>{x.terms.cancel}</dd>
          <dt>Pro forma</dt>
          <dd className="mono small">sha256 {x.terms.proformaSha256}</dd>
        </dl>
        <Notice kind="info">You're paid in the same token and network the escrow is funded in. Before funding, you'll get a signed proof of funds showing the escrow address.</Notice>
      </div>
      {x.supplierAccepted ? (
        <div className="card">
          <p>
            <Status value="allow" /> You accepted these terms <When at={x.supplierAcceptedAt} />.
          </p>
          <ul className="list">
            {x.payments.map((p: any) => (
              <li key={p.id} className="spread">
                <span>{p.title}</span>
                {me ? <Link to={`/payments/${p.id}`}>Open</Link> : <Status value={p.status} />}
              </li>
            ))}
          </ul>
        </div>
      ) : !me ? (
        <div className="card">
          <p>Open a free supplier account for {x.supplierEmail} to accept and get paid.</p>
          <LaunchButton kind="counterparty" orderSlug={slug} next={`/orders/${slug}`} label="Open supplier account" />
        </div>
      ) : (
        <div className="card">
          <ErrorNotice error={accept.error} />
          {me.kind === 'counterparty' && !me.verifiedName && (
            <Notice kind="warn">
              Verify your ID first so the money can be released to you. <Link to="/verify-identity">Verify</Link>
            </Notice>
          )}
          <button className="btn" disabled={accept.busy} onClick={() => void accept.run()}>
            Accept these terms
          </button>
        </div>
      )}
    </div>
  );
}
