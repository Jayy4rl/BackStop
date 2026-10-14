// L2-2/L2-3 web checkout for clients: no app install; shows the freelancer's verified name, hold
// rules and fee before funding; pays from an external wallet (or a free client account).
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, publicConfig } from '../lib/api';
import { evmAccount, hasEvmWallet, hasTronWallet, sendExternal, tronAccount } from '../lib/external';
import { ErrorNotice, Field, Loading, Money, Notice, Status, useAction, useLoad, When } from '../components/ui';

export function Checkout() {
  const { slug } = useParams();
  const inv = useLoad(() => api.get(`/public/invoices/${slug}`), [slug]);
  const [network, setNetwork] = useState('');
  const [country, setCountry] = useState('');
  const [confirmRefund, setConfirmRefund] = useState(false);
  const [sent, setSent] = useState<Record<string, string[]>>({});
  const fund = useAction(async (milestoneId: string) => {
    const net = network || inv.data.networks[0]?.network;
    const cfg = await publicConfig();
    const n = cfg.networks.find((x) => x.network === net);
    const payer = net === 'tron' ? tronAccount() : await evmAccount(n?.chainId);
    const r = await api.post(`/public/invoices/${slug}/fund`, { milestoneId, network: net, payerAddress: payer, clientCountry: country, confirmRefundToPayer: confirmRefund });
    const hashes = await sendExternal(r.bundle, payer);
    setSent((s) => ({ ...s, [milestoneId]: hashes }));
    setTimeout(inv.reload, 3000);
  });
  const approve = useAction(async (paymentId: string, net: string) => {
    const cfg = await publicConfig();
    const payer = net === 'tron' ? tronAccount() : await evmAccount(cfg.networks.find((x) => x.network === net)?.chainId);
    const r = await api.post(`/public/payments/${paymentId}/release`);
    await sendExternal(r.bundle, payer);
    setTimeout(inv.reload, 3000);
  });
  if (inv.error) return <ErrorNotice error={inv.error} />;
  if (!inv.data) return <Loading />;
  const d = inv.data;
  const walletReady = d.token === 'USDT' ? hasTronWallet() : hasEvmWallet();
  return (
    <div className="stack">
      <h1>{d.description}</h1>
      <div className="card">
        <p>
          From <strong>{d.freelancer.verifiedName}</strong> (@{d.freelancer.handle}) {d.freelancer.verified && <span className="badge ok">Identity verified</span>}
        </p>
        <p className="big">
          <Money amount={d.total} token={d.token} />
        </p>
        <Notice kind="info" title="How your money is protected">
          {d.holdRules.text} {d.holdRules.disputes}
        </Notice>
        <p className="small">
          Backstop fee: {d.feeRule.bps / 100}%{d.feeRule.cap ? ` (capped at $${d.feeRule.cap})` : ''} of each milestone, paid by {d.feeRule.paidBy}, deducted only on release.
        </p>
        {d.ethereumNote && <p className="small muted">{d.ethereumNote}</p>}
      </div>
      <div className="card">
        <h2>Pay</h2>
        <ErrorNotice error={fund.error} />
        <div className="grid two">
          <Field label="Your country (2-letter code)">{(id) => <input id={id} maxLength={2} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} required />}</Field>
          <Field label="Network">
            {(id) => (
              <select id={id} value={network} onChange={(e) => setNetwork(e.target.value)}>
                {d.networks.map((n: any) => (
                  <option key={n.network} value={n.network}>
                    {d.token} on {n.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={confirmRefund} onChange={(e) => setConfirmRefund(e.target.checked)} />
          Pay from a wallet I control (not an exchange). Any refund returns to that wallet.
        </label>
        {!walletReady && <Notice kind="warn">Open this page in your wallet app, or install a wallet extension, to pay.</Notice>}
        <p className="small muted">
          Paying more than ${d.counterpartyVerificationAbove}? You'll need a free client account with a quick ID check. <Link to={`/signup?next=/checkout/${slug}`}>Create one</Link>
        </p>
      </div>
      <div className="card">
        <h2>Milestones</h2>
        <ul className="list">
          {d.milestones.map((m: any) => (
            <li key={m.id} className="spread">
              <div>
                <strong>{m.title}</strong> <Money amount={m.amount} token={d.token} />
                <div className="small muted">
                  Due <When at={m.dueDate} /> · fee <Money amount={m.fee} />
                  {m.status === 'created' && (
                    <>
                      {' '}
                      · fund by <When at={m.fundingDeadline} />
                    </>
                  )}
                </div>
                {sent[m.id] && <div className="small">Submitted: <code>{sent[m.id]!.at(-1)}</code></div>}
              </div>
              <div className="row">
                <Status value={m.status} />
                {m.status === 'created' && (
                  <button className="btn" disabled={fund.busy || !country || !confirmRefund || !walletReady} onClick={() => void fund.run(m.id)}>
                    Pay into escrow
                  </button>
                )}
                {['delivered', 'disputed'].includes(m.status) && (
                  <button className="btn secondary" disabled={approve.busy} onClick={() => void approve.run(m.id, network || d.networks[0]?.network)}>
                    Approve and release
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        <ErrorNotice error={approve.error} />
        <p className="small muted">To dispute a milestone, sign in with a free client account using the email this invoice was sent to.</p>
      </div>
    </div>
  );
}
