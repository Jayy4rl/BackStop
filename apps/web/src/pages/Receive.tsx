// C2-4: one address per network, with a QR, the token it accepts, and a plain warning naming the
// only token and network to send.
import { useState } from 'react';
import { api } from '../lib/api';
import { Copy, ErrorNotice, Loading, Notice, Qr, useLoad } from '../components/ui';

export function Receive() {
  const r = useLoad(() => api.get('/wallet/receive'));
  const [sel, setSel] = useState(0);
  if (r.error) return <ErrorNotice error={r.error} />;
  if (!r.data) return <Loading />;
  const e = r.data.entries[sel];
  return (
    <div>
      <h1>Receive</h1>
      <div className="card">
        <p>
          Backstop users can pay you at <strong>@{r.data.handle}</strong>. From another wallet or exchange, choose what they will send:
        </p>
        <div role="radiogroup" aria-label="Token and network" className="row" style={{ marginBottom: 16 }}>
          {r.data.entries.map((x: any, i: number) => (
            <button key={x.network} role="radio" aria-checked={i === sel} className={`btn ${i === sel ? '' : 'secondary'}`} onClick={() => setSel(i)}>
              {x.token} on {x.networkLabel}
            </button>
          ))}
        </div>
        <Notice kind="warn" title={`Only ${e.token} on ${e.networkLabel}`}>
          {e.warning}
        </Notice>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <Qr value={e.qr} label={`QR code for your ${e.token} address on ${e.networkLabel}`} />
          <div className="stack" style={{ flex: 1, minWidth: 220 }}>
            <div>
              <div className="small muted">Your {e.networkLabel} address</div>
              <code>{e.address}</code>
            </div>
            <Copy text={e.address} label="Copy address" />
            <p className="small muted">Funds count as available once final ({e.finality}) and checked. {e.depositOnly ? 'Ethereum is for deposits and withdrawals only.' : ''}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
