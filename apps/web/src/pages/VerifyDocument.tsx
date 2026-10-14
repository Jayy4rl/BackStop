// Public check of a signed Backstop document (proof of funds, trade record, receipt).
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { ErrorNotice, Loading, Notice, When, useLoad } from '../components/ui';

function Facts({ v }: { v: unknown }): JSX.Element {
  if (v && typeof v === 'object')
    return (
      <dl className="kv">
        {Object.entries(v as Record<string, unknown>).map(([k, x]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd>{x && typeof x === 'object' ? <Facts v={x} /> : String(x ?? '—')}</dd>
          </div>
        ))}
      </dl>
    );
  return <span>{String(v)}</span>;
}

export function VerifyDocument() {
  const { code } = useParams();
  const d = useLoad(() => api.get(`/public/documents/${code}`), [code]);
  if (d.error) return <ErrorNotice error={d.error} />;
  if (!d.data) return <Loading />;
  return (
    <div className="card">
      <h1>Document check</h1>
      {d.data.signatureValid ? <Notice kind="ok" title="Genuine Backstop document">The signature matches Backstop's signing key. Issued <When at={d.data.issuedAt} />.</Notice> : <Notice kind="danger" title="Signature does not match">Do not rely on this document.</Notice>}
      <Facts v={d.data.facts} />
      <p className="small muted mono">Signature {d.data.signature}</p>
    </div>
  );
}
