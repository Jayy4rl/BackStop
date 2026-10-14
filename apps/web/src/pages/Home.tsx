import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { t } from '../lib/i18n';
import { ErrorNotice, Loading, Money, Notice, Status, useLoad, When } from '../components/ui';

export function Home() {
  const { me } = useSession();
  const bal = useLoad(() => api.get('/wallet/balances'));
  const notes = useLoad(() => api.get('/notifications'));
  const status = useLoad(() => api.get('/status'));
  const payments = useLoad(() => api.get('/payments'));
  return (
    <div>
      <h1>Hello{me?.displayName ? `, ${me.displayName.split(' ')[0]}` : ''}</h1>
      {me?.tier === 'none' && me.kind !== 'counterparty' && (
        <Notice kind="warn" title="Verify your identity to move money">
          Every account is identity-checked before sending, so disputes and appeals work. <Link to="/verify-identity">Verify now</Link>
        </Notice>
      )}
      {status.data?.escrowPaused?.length > 0 && (
        <Notice kind="warn" title="Protected payments paused briefly">
          We're catching up with {status.data.escrowPaused.join(', ')}. Escrow funding and P2P trades are paused for a few minutes; simple sends still work.
        </Notice>
      )}
      <div className="card">
        <ErrorNotice error={bal.error} />
        {bal.loading && !bal.data ? (
          <Loading />
        ) : bal.data ? (
          <>
            <div className="spread">
              <div>
                <div className="muted small">Total balance</div>
                <div className="big">
                  <Money amount={bal.data.totalUsd} />
                </div>
                <div className="small muted">
                  ≈ {bal.data.nairaReference.value} · reference only, {bal.data.nairaReference.source}, <When at={bal.data.nairaReference.asOf} />
                </div>
              </div>
              <div className="row">
                <Link className="btn" to="/send">
                  Send
                </Link>
                <Link className="btn secondary" to="/receive">
                  Receive
                </Link>
              </div>
            </div>
            <div className="table-wrap" style={{ marginTop: 16 }}>
              <table>
                <caption className="small muted" style={{ textAlign: 'left' }}>
                  Balances by token and network
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Token</th>
                    <th scope="col">Network</th>
                    <th scope="col">Balance</th>
                    <th scope="col">On hold</th>
                    <th scope="col">Available</th>
                  </tr>
                </thead>
                <tbody>
                  {bal.data.pairs.map((p: any) => (
                    <tr key={`${p.network}-${p.token}`}>
                      <td>{p.token}</td>
                      <td>{p.network}</td>
                      <td>
                        <Money amount={p.balance} />
                      </td>
                      <td>{p.held !== '0' ? <Money amount={p.held} /> : '—'}</td>
                      <td>
                        <Money amount={p.spendable} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </div>

      {bal.data?.holds?.length > 0 && (
        <div className="card">
          <h2>Funds on hold</h2>
          <p className="small muted">{t('hold.meaning')}</p>
          <ul className="list">
            {bal.data.holds.map((h: any) => (
              <li key={h.id} className="spread">
                <div>
                  <Status value={h.availability} /> <Money amount={(Number(h.amount_units) / 1e6).toString()} token={h.token} /> on {h.network}
                  <div className="small">{h.hold_reason}</div>
                  {h.appeal_ref && (
                    <div className="small muted">
                      Appeal {h.appeal_ref}: {h.appeal_status}
                    </div>
                  )}
                </div>
                <Link className="btn secondary" to={`/transfers/${h.id}`}>
                  {h.appeal_ref ? 'View' : 'Why and appeal'}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {bal.data?.unrecognisedTokens?.length > 0 && (
        <Notice kind="warn" title="Unrecognised tokens">
          {bal.data.unrecognisedTokens.length} transfer(s) used a stablecoin's name but not the official contract. They are not counted in your balance and can't be used.
        </Notice>
      )}
      {bal.data?.unsupportedArrivals?.length > 0 && (
        <Notice kind="warn" title="Money on an unsupported network">
          Some funds arrived on a network this address does not support. They are still in your wallet. <Link to="/support">Ask support how to move them</Link>.
        </Notice>
      )}

      <div className="grid two">
        <div className="card">
          <h2>Protected payments</h2>
          {payments.data?.payments?.length ? (
            <ul className="list">
              {payments.data.payments.slice(0, 6).map((p: any) => (
                <li key={p.id} className="spread">
                  <div>
                    <Link to={`/payments/${p.id}`}>{p.title}</Link>
                    <div className="small muted">
                      {p.loop} · <Money amount={p.amount} token={p.token} />
                    </div>
                  </div>
                  <Status value={p.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No protected payments yet. Send an invoice or a trade order to get started.</p>
          )}
        </div>
        <div className="card">
          <div className="spread">
            <h2>Notifications</h2>
            <button className="btn link" onClick={() => void api.post('/notifications/read').then(notes.reload)}>
              Mark all read
            </button>
          </div>
          <ul className="list" aria-live="polite">
            {(notes.data?.notifications ?? []).slice(0, 8).map((n: any) => (
              <li key={n.id}>
                <strong style={{ fontWeight: n.read_at ? 400 : 700 }}>{n.title}</strong>
                <div className="small">{n.body}</div>
                <div className="small muted">
                  <When at={n.created_at} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {me && (
        <div className="card">
          <h2>Your limits</h2>
          <p className="small">
            Per payment <Money amount={me.limits.perTransaction} /> · Daily <Money amount={me.limits.daily} /> · Used today <Money amount={me.limits.usedToday} /> · Left today <Money amount={me.limits.remainingToday} />
          </p>
          <p className="small muted">
            Resets <When at={me.limits.resetsAt} />. Limits rise with verification. <Link to="/report">Report fraud</Link>
          </p>
        </div>
      )}
    </div>
  );
}
