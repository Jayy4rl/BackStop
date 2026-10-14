// One protected payment (C4): status, terms, fee, deadlines and every action the viewer can take
// right now (the contract stays the authority; buttons mirror its guards).
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { signPaymentAction } from '../lib/sign';
import { t } from '../lib/i18n';
import { ErrorNotice, Field, Loading, Money, Notice, Sheet, Status, useAction, useLoad, When } from '../components/ui';

export function FileInput({ purpose, onUploaded, label = 'Attach files' }: { purpose: string; onUploaded: (id: string, name: string) => void; label?: string }) {
  const up = useAction(async (files: FileList) => {
    for (const f of Array.from(files)) {
      if (f.size > 100 * 1024 * 1024) throw new Error(`${f.name} is over 100 MB.`);
      const r = await api.upload(purpose, f);
      onUploaded(r.id, f.name);
    }
  });
  return (
    <div className="field">
      <label>
        {label}
        <input type="file" multiple onChange={(e) => e.target.files && void up.run(e.target.files)} style={{ marginTop: 6 }} />
      </label>
      {up.busy && <div className="hint" role="status">Uploading…</div>}
      <ErrorNotice error={up.error} />
    </div>
  );
}

export function PaymentPage() {
  const { id } = useParams();
  const p = useLoad(() => api.get(`/payments/${id}`), [id]);
  const [sheet, setSheet] = useState<null | 'deliver' | 'dispute' | 'evidence'>(null);
  const [form, setForm] = useState({ note: '', links: '', trackingNumber: '', carrier: 'DHL', reason: '', statement: '' });
  const [files, setFiles] = useState<Array<{ id: string; name: string }>>([]);
  const [done, setDone] = useState<string | null>(null);
  const act = useAction(async (label: string, fn: () => Promise<unknown>) => {
    await fn();
    setDone(label);
    setSheet(null);
    setFiles([]);
    setTimeout(p.reload, 1500);
  });
  if (p.error) return <ErrorNotice error={p.error} />;
  if (!p.data) return <Loading />;
  const x = p.data;
  const can = (a: string) => x.actions.includes(a);
  const sign = (label: string, path: string, body: Record<string, unknown> = {}) => act.run(label, () => signPaymentAction(x.id, () => api.post(path, body)));

  return (
    <div>
      <div className="spread">
        <div>
          <h1>{x.title}</h1>
          <p className="muted">
            {x.loop === 'L2' ? 'Freelancer invoice' : x.loop === 'L3' ? 'Trade order' : 'P2P trade'} · you are the {x.viewerRole}
          </p>
        </div>
        <Status value={x.status} />
      </div>
      {done && <Notice kind="ok">{done} — submitted. This page updates when the network confirms it.</Notice>}
      <ErrorNotice error={act.error} />
      {x.releasePausedReason && <Notice kind="warn" title="Auto-release paused">{x.releasePausedReason}</Notice>}
      {x.payeeFrozen && <Notice kind="warn" title="Payee frozen by the token issuer">Releases can't reach the payee. The money can be returned to the payer.</Notice>}
      <div className="card">
        <dl className="kv">
          <dt>Amount held</dt>
          <dd>
            <Money amount={x.amount} token={x.token} /> on {x.networkLabel ?? 'the network chosen at funding'}
          </dd>
          <dt>Backstop fee</dt>
          <dd>
            <Money amount={x.fee} token={x.token} /> ({x.feeBps / 100}%) — {t('fee.rule')}
          </dd>
          <dt>Payee receives</dt>
          <dd>
            <Money amount={x.payeeReceives} token={x.token} />
          </dd>
          {x.escrowAddress && (
            <>
              <dt>Escrow contract</dt>
              <dd>
                <code>{x.escrowAddress}</code>
              </dd>
            </>
          )}
          {x.status === 'created' && (
            <>
              <dt>Fund by</dt>
              <dd>
                <When at={x.fundingDeadline} /> (cancelled automatically after that, no fee)
              </dd>
            </>
          )}
          <dt>{x.loop === 'L3' ? 'Ship by' : x.loop === 'L4' ? 'Pay by' : 'Deliver by'}</dt>
          <dd>
            <When at={x.deliverBy} />
          </dd>
          {x.holdUntil && (
            <>
              <dt>Releases automatically</dt>
              <dd>
                <When at={x.holdUntil} />
              </dd>
            </>
          )}
          {x.disputeDeadline && ['funded', 'delivered'].includes(x.status) && (
            <>
              <dt>Dispute before</dt>
              <dd>
                <When at={x.disputeDeadline} />
              </dd>
            </>
          )}
        </dl>
        {x.disputeWarningAt && new Date(x.disputeWarningAt) < new Date() && x.status === 'delivered' && x.viewerRole === 'payer' && (
          <Notice kind="warn" title="Less than 24 hours to dispute">If something is wrong, open a dispute now. After the deadline the payment releases.</Notice>
        )}
      </div>

      <div className="card">
        <h2>What you can do</h2>
        <div className="row">
          {x.status === 'created' && x.viewerRole === 'payer' && x.loop !== 'L4' && (
            <button className="btn" disabled={act.busy} onClick={() => void sign('Funding', `/payments/${x.id}/fund`, { network: x.network ?? (x.token === 'USDT' ? 'tron' : 'arc') })}>
              Fund escrow
            </button>
          )}
          {can('markDelivered') && x.loop !== 'L4' && (
            <button className="btn" onClick={() => setSheet('deliver')}>
              {x.loop === 'L3' ? 'Upload shipping proof' : 'Mark delivered'}
            </button>
          )}
          {can('release') && (
            <button className="btn" disabled={act.busy} onClick={() => void sign('Release', `/payments/${x.id}/release`)}>
              Approve and release
            </button>
          )}
          {can('releaseAfterHold') && (
            <button className="btn" disabled={act.busy} onClick={() => void sign('Release', `/payments/${x.id}/release-after-hold`)}>
              Release now (hold ended)
            </button>
          )}
          {can('dispute') && (
            <button className="btn danger" onClick={() => setSheet('dispute')}>
              Open a dispute
            </button>
          )}
          {can('refundByPayee') && (
            <button className="btn secondary" disabled={act.busy} onClick={() => void sign('Refund', `/payments/${x.id}/refund`)}>
              Return the money to the payer
            </button>
          )}
          {can('reclaimAfterDeadline') && (
            <button className="btn" disabled={act.busy} onClick={() => void sign('Reclaim', `/payments/${x.id}/reclaim`)}>
              Reclaim (deadline missed)
            </button>
          )}
          {['funded', 'delivered', 'disputed'].includes(x.status) && x.viewerRole === 'payer' && !x.cancelRequestedBy && (
            <button className="btn secondary" disabled={act.busy} onClick={() => void act.run('Cancel request sent', () => api.post(`/payments/${x.id}/cancel-request`))}>
              Ask to cancel
            </button>
          )}
          {x.status === 'created' && (
            <button className="btn secondary" disabled={act.busy} onClick={() => void act.run('Cancelled', () => api.post(`/payments/${x.id}/cancel`, {}))}>
              Cancel
            </button>
          )}
          {x.status === 'released' && (
            <button className="btn secondary" onClick={() => void api.download(`/payments/${x.id}/receipt.pdf`, `receipt-${x.id}.pdf`)}>
              Download receipt (PDF)
            </button>
          )}
          {x.loop === 'L3' && ['funded', 'delivered', 'disputed'].includes(x.status) && (
            <button className="btn secondary" onClick={() => void api.download(`/payments/${x.id}/proof-of-funds.pdf`, `proof-of-funds-${x.id}.pdf`)}>
              Proof of funds (PDF)
            </button>
          )}
          {x.status === 'created' && x.viewerRole === 'payer' && (
            <button className="btn link" onClick={() => void act.run('Approval requested', () => api.post(`/payments/${x.id}/approval-requests`, { action: 'fund' }))}>
              Request second approval
            </button>
          )}
        </div>
        {x.cancelRequestedBy && <p className="small muted">A cancel was requested. The payee can return the money with “Return the money to the payer”.</p>}
      </div>

      {x.deliveries.length > 0 && (
        <div className="card">
          <h2>{x.loop === 'L3' ? 'Shipping proof' : 'Deliveries'}</h2>
          <ul className="list">
            {x.deliveries.map((d: any) => (
              <li key={d.id}>
                <When at={d.created_at} /> {d.note}
                {d.links.map((l: string) => (
                  <div key={l}>
                    <a href={l} target="_blank" rel="noreferrer noopener">
                      {l}
                    </a>
                  </div>
                ))}
                {d.file_ids.map((f: string) => (
                  <div key={f}>
                    <button className="btn link" onClick={() => void api.download(`/files/${f}`, `evidence-${f}`)}>
                      Download file
                    </button>
                  </div>
                ))}
                {d.tracking_number && (
                  <div className="small">
                    {d.carrier} {d.tracking_number} {d.tracking_validation && <Status value={d.tracking_validation === 'valid' ? 'allow' : 'warn'} />}
                  </div>
                )}
                <div className="small muted">
                  Evidence hash <code>{d.evidence_hash}</code>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {x.dispute && <DisputePanel dispute={x.dispute} onChange={p.reload} />}

      <p className="small">
        <Link to={`/report?payment=${x.id}`}>Report fraud</Link> · <Link to={`/support?payment=${x.id}`}>Contact support</Link>
      </p>

      {sheet === 'deliver' && (
        <Sheet title={x.loop === 'L3' ? 'Shipping proof' : 'Mark delivered'} onClose={() => setSheet(null)}>
          <p className="small muted">{x.loop === 'L3' ? 'Upload the bill of lading or air waybill. The 14-day hold starts when you submit.' : 'Attach files (up to 100 MB each) or links. They are timestamped and kept as dispute evidence. The hold starts now.'}</p>
          <FileInput purpose={x.loop === 'L3' ? 'shipping_document' : 'delivery'} onUploaded={(fid, name) => setFiles((f) => [...f, { id: fid, name }])} />
          {files.length > 0 && <p className="small">Attached: {files.map((f) => f.name).join(', ')}</p>}
          {x.loop === 'L3' ? (
            <>
              <Field label="Carrier">
                {(fid) => (
                  <select id={fid} value={form.carrier} onChange={(e) => setForm({ ...form, carrier: e.target.value })}>
                    {['DHL', 'FedEx', 'UPS', 'Maersk', 'MSC', 'Other'].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Tracking number">{(fid) => <input id={fid} value={form.trackingNumber} onChange={(e) => setForm({ ...form, trackingNumber: e.target.value })} required />}</Field>
            </>
          ) : (
            <Field label="Links (one per line)">{(fid) => <textarea id={fid} value={form.links} onChange={(e) => setForm({ ...form, links: e.target.value })} />}</Field>
          )}
          <Field label="Note">{(fid) => <textarea id={fid} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field>
          <button
            className="btn"
            disabled={act.busy}
            onClick={() =>
              void sign(x.loop === 'L3' ? 'Shipping proof' : 'Delivery', `/payments/${x.id}/deliveries`, {
                note: form.note || undefined,
                links: form.links.split('\n').map((s) => s.trim()).filter(Boolean),
                fileIds: files.map((f) => f.id),
                trackingNumber: form.trackingNumber || undefined,
                carrier: x.loop === 'L3' ? form.carrier : undefined,
              })
            }
          >
            Submit and sign
          </button>
        </Sheet>
      )}
      {sheet === 'dispute' && (
        <Sheet title="Open a dispute" onClose={() => setSheet(null)}>
          <Notice kind="info">Release pauses until a Backstop reviewer rules ({x.loop === 'L4' ? 'within 24 hours' : 'within 5 business days'}). Both sides upload evidence ({x.loop === 'L4' ? '2 hours' : '3 business days'}).</Notice>
          <Field label="What went wrong?">{(fid) => <input id={fid} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required />}</Field>
          <Field label="Explain">{(fid) => <textarea id={fid} value={form.statement} onChange={(e) => setForm({ ...form, statement: e.target.value })} required minLength={10} />}</Field>
          <FileInput purpose="dispute_evidence" label={x.loop === 'L3' ? 'Inspection report and photos' : 'Evidence'} onUploaded={(fid, name) => setFiles((f) => [...f, { id: fid, name }])} />
          <button className="btn danger" disabled={act.busy || !form.reason || form.statement.length < 10} onClick={() => void sign('Dispute', `/payments/${x.id}/disputes`, { reason: form.reason, statement: form.statement, fileIds: files.map((f) => f.id) })}>
            Open dispute and sign
          </button>
        </Sheet>
      )}
    </div>
  );
}

function DisputePanel({ dispute, onChange }: { dispute: any; onChange: () => void }) {
  const d = useLoad(() => api.get(`/disputes/${dispute.id}`), [dispute.id]);
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const add = useAction(async () => {
    await api.post(`/disputes/${dispute.id}/evidence`, { kind: files.length ? 'file' : 'statement', body: body || undefined, fileIds: files });
    setBody('');
    setFiles([]);
    d.reload();
  });
  const second = useAction(async () => {
    await api.post(`/disputes/${dispute.id}/second-review`);
    d.reload();
    onChange();
  });
  if (!d.data) return <Loading />;
  const x = d.data;
  return (
    <div className="card">
      <h2>Dispute</h2>
      <p>
        <Status value={x.status === 'evidence' ? 'open' : x.status} /> Opened by the {x.openedBy}: {x.reason}
      </p>
      <p className="small muted">
        Evidence until <When at={x.evidenceDueAt} /> · ruling target <When at={x.rulingDueAt} />
      </p>
      {x.ruling && (
        <Notice kind="info" title={`Ruling: ${x.ruling === 'release' ? 'released to the payee' : 'refunded to the payer'}`}>
          {x.rulingReason}
        </Notice>
      )}
      {x.status === 'ruled' && !x.secondReviewRequested && x.reviewWindowEndsAt && new Date(x.reviewWindowEndsAt) > new Date() && (
        <div className="stack">
          <ErrorNotice error={second.error} />
          <button className="btn secondary" disabled={second.busy} onClick={() => void second.run()}>
            Ask for a second reviewer (once, until <When at={x.reviewWindowEndsAt} />)
          </button>
        </div>
      )}
      <h3>Evidence</h3>
      <ul className="list">
        {x.evidence.map((e: any) => (
          <li key={e.id} className="small">
            <strong>{e.party}</strong> · {e.kind.replace(/_/g, ' ')} · <When at={e.created_at} />
            {e.body && <div style={{ whiteSpace: 'pre-wrap' }}>{e.body}</div>}
            {e.url && (
              <a href={e.url} target="_blank" rel="noreferrer noopener">
                {e.url}
              </a>
            )}
            {e.file_id && (
              <button className="btn link" onClick={() => void api.download(`/files/${e.file_id}`, `evidence-${e.file_id}`)}>
                Download file
              </button>
            )}
          </li>
        ))}
      </ul>
      {x.status === 'evidence' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void add.run();
          }}
        >
          <ErrorNotice error={add.error} />
          <Field label="Add evidence">{(fid) => <textarea id={fid} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
          <FileInput purpose="dispute_evidence" onUploaded={(fid) => setFiles((f) => [...f, fid])} />
          <button className="btn secondary" disabled={add.busy || (!body && !files.length)}>
            Add
          </button>
        </form>
      )}
    </div>
  );
}
