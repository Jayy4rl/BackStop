// Staff console for dispute reviewers, risk analysts, arbiter signers and support (C5-2, C4, C3-5).
// Behind SSO and MFA; every action is recorded in the audit log by the API.
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, hasStaffToken, setStaffToken, staffApi } from '../lib/api';
import { ErrorNotice, Field, Loading, Money, Notice, Qr, Status, useAction, useLoad, When } from '../components/ui';

const units = (u: string | null | undefined) => (u ? (Number(u) / 1e6).toString() : '0');

function StaffLogin({ onDone }: { onDone: () => void }) {
  const [q] = useSearchParams();
  const [step, setStep] = useState<'sso' | 'mfa'>(hasStaffToken() ? 'mfa' : 'sso');
  const [email, setEmail] = useState('');
  const [enroll, setEnroll] = useState<{ otpauthUri: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [mfaEnrolled, setMfaEnrolled] = useState(true);
  const sso = useAction(async () => {
    const s = await api.get('/staff/sso/start');
    if (!s.url.startsWith('/staff/sso/sandbox')) {
      window.location.href = s.url;
      return;
    }
    const r = await api.post('/staff/sso/callback', { state: s.state, code: email });
    setStaffToken(r.token);
    setMfaEnrolled(r.mfaEnrolled);
    setStep('mfa');
  });
  // Real IdP redirect lands here with ?state&code.
  useEffect(() => {
    const state = q.get('state');
    const c = q.get('code');
    if (state && c && !hasStaffToken())
      void api.post('/staff/sso/callback', { state, code: c }).then((r) => {
        setStaffToken(r.token);
        setMfaEnrolled(r.mfaEnrolled);
        setStep('mfa');
      });
  }, [q]);
  const mfa = useAction(async () => {
    await staffApi.post('/staff/mfa/verify', { code });
    onDone();
  });
  const startEnroll = useAction(async () => setEnroll(await staffApi.post('/staff/mfa/enroll')));
  return (
    <main className="public" id="main">
      <h1>Backstop staff</h1>
      {step === 'sso' ? (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void sso.run();
          }}
        >
          <ErrorNotice error={sso.error} />
          <Field label="Work email" hint="You'll sign in with the company identity provider.">
            {(id, d) => <input id={id} aria-describedby={d} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />}
          </Field>
          <button className="btn" disabled={sso.busy}>
            Continue with SSO
          </button>
        </form>
      ) : (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void mfa.run();
          }}
        >
          <h2>Multi-factor authentication</h2>
          <ErrorNotice error={mfa.error ?? startEnroll.error} />
          {!mfaEnrolled && !enroll && (
            <button type="button" className="btn secondary" onClick={() => void startEnroll.run()}>
              Set up authenticator app
            </button>
          )}
          {enroll && (
            <div className="stack">
              <Qr value={enroll.otpauthUri} label="Authenticator setup QR code" />
              <p className="small mono">{enroll.secret}</p>
            </div>
          )}
          <Field label="6-digit code">{(id) => <input id={id} inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />}</Field>
          <button className="btn" disabled={mfa.busy}>
            Verify
          </button>
        </form>
      )}
    </main>
  );
}

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  );
}

function Queues() {
  const q = useLoad(() => staffApi.get('/staff/queues'));
  if (q.error) return <ErrorNotice error={q.error} />;
  if (!q.data) return <Loading />;
  return (
    <Page title="Queues">
      <div className="grid two">
        {Object.entries(q.data).map(([k, v]: [string, any]) => (
          <div key={k} className="card">
            <h2>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</h2>
            <p className="big">{v.open}</p>
            {Number(v.overdue) > 0 ? <span className="badge danger">{v.overdue} past target</span> : <span className="badge ok">on target</span>}
          </div>
        ))}
      </div>
    </Page>
  );
}

function Reviews() {
  const r = useLoad(() => staffApi.get('/staff/reviews'));
  const [reason, setReason] = useState<Record<string, string>>({});
  const act = useAction(async (id: string, action: string) => {
    await staffApi.post(`/staff/reviews/${id}/decide`, { action, reason: reason[id] });
    r.reload();
  });
  return (
    <Page title="Reviews (clear or hold within 1 business day)">
      <ErrorNotice error={r.error ?? act.error} />
      {(r.data?.reviews ?? []).map((x: any) => (
        <div key={x.id} className="card">
          <div className="spread">
            <strong>{x.kind.replace(/_/g, ' ')}</strong>
            <span className="small">
              due <When at={x.due_at} />
            </span>
          </div>
          {x.amount_units && (
            <p>
              <Money amount={units(x.amount_units)} token={x.token} /> on {x.network} from <code>{x.from_address}</code> to @{x.handle}
            </p>
          )}
          {(x.reasons ?? []).map((rr: any) => (
            <p key={rr.code} className="small">
              <Status value={rr.severity === 'hold' ? 'on_hold' : 'under_review'} /> {rr.title}: {rr.body}
            </p>
          ))}
          {x.decision_id && (
            <p className="small">
              <NavLink to={`/staff/decisions/${x.decision_id}`}>Replay decision</NavLink>
            </p>
          )}
          <Field label="Written reason">{(id) => <textarea id={id} value={reason[x.id] ?? ''} onChange={(e) => setReason({ ...reason, [x.id]: e.target.value })} />}</Field>
          <div className="row">
            <button className="btn" disabled={act.busy} onClick={() => void act.run(x.id, 'clear')}>
              Clear
            </button>
            <button className="btn danger" disabled={act.busy} onClick={() => void act.run(x.id, 'hold')}>
              Hold
            </button>
            <button className="btn secondary" disabled={act.busy} onClick={() => void act.run(x.id, 'resolve')}>
              Resolve (no change)
            </button>
          </div>
        </div>
      ))}
      {r.data && r.data.reviews.length === 0 && <p className="muted">Nothing to review.</p>}
    </Page>
  );
}

function Cases() {
  const [status, setStatus] = useState('open');
  const c = useLoad(() => staffApi.get(`/staff/cases?status=${status}`), [status]);
  return (
    <Page title="Fraud cases">
      <div className="row" style={{ marginBottom: 12 }}>
        {['open', 'awaiting_second', 'confirmed', 'rejected'].map((s) => (
          <button key={s} className={`btn ${s === status ? '' : 'secondary'}`} onClick={() => setStatus(s)}>
            {s.replace('_', ' ')}
          </button>
        ))}
      </div>
      <div className="card">
        <ul className="list">
          {(c.data?.cases ?? []).map((x: any) => (
            <li key={x.id} className="spread">
              <NavLink to={`/staff/cases/${x.id}`}>
                <code>{x.address}</code>
              </NavLink>
              <span className="small">
                {x.reports} report(s) · <Money amount={units(x.amount_units)} /> · due <When at={x.due_at} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Page>
  );
}

function CaseDetail() {
  const { id } = useParams();
  const c = useLoad(() => staffApi.get(`/staff/cases/${id}`), [id]);
  const [d, setD] = useState({ decision: 'confirm', reasonCode: 'onchain_trail_confirmed', reason: '', onchainTrailConfirmed: false, lawEnforcementRef: '' });
  const [trace, setTrace] = useState<any>(null);
  const [tr, setTr] = useState({ network: 'tron', token: 'USDT' });
  const decide = useAction(async () => {
    await staffApi.post(`/staff/cases/${id}/decide`, { ...d, lawEnforcementRef: d.lawEnforcementRef || undefined });
    c.reload();
  });
  const doTrace = useAction(async () => setTrace(await staffApi.post(`/staff/cases/${id}/trace`, tr)));
  if (!c.data) return <Loading />;
  const x = c.data;
  return (
    <Page title="Case">
      <div className="card">
        <p>
          <code>{x.case.address}</code> <Status value={x.case.status} />
        </p>
        <h2>Reports</h2>
        {x.reports.map((r: any) => (
          <div key={r.id} className="card" style={{ background: 'var(--surface-2)' }}>
            <p className="small">
              {r.case_type} · <When at={r.created_at} /> · identity-checked reporter: {r.reporter_identity_checked ? 'yes' : 'no'} {r.law_enforcement_ref && `· LE ref ${r.law_enforcement_ref}`}
            </p>
            <p>{r.statement}</p>
            {r.tx_hashes.map((h: string) => (
              <code key={h} className="small">
                {h}
              </code>
            ))}
            {r.file_ids.map((f: string) => (
              <button key={f} className="btn link" onClick={() => void api.download(`/files/${f}`, `evidence-${f}`, true)}>
                Download evidence
              </button>
            ))}
          </div>
        ))}
        <h2>Reporter history</h2>
        <ul className="list">
          {x.reporterHistory.map((h: any) => (
            <li key={h.reporter_user_id}>
              @{h.handle} ({h.tier}): {h.reports} reports, {h.confirmed} confirmed, {h.rejected} rejected
            </li>
          ))}
        </ul>
      </div>
      <div className="card">
        <h2>Traced fund path</h2>
        <div className="row">
          <select aria-label="Network" value={tr.network} onChange={(e) => setTr({ ...tr, network: e.target.value })}>
            {['tron', 'base', 'arc', 'ethereum'].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
          <select aria-label="Token" value={tr.token} onChange={(e) => setTr({ ...tr, token: e.target.value })}>
            <option>USDT</option>
            <option>USDC</option>
          </select>
          <button className="btn secondary" onClick={() => void doTrace.run()}>
            Trace
          </button>
        </div>
        <ErrorNotice error={doTrace.error} />
        {(trace ?? x.case.traced_path) && (
          <ul className="list small">
            {((trace ?? x.case.traced_path).trace ?? []).map((n: any, i: number) => (
              <li key={i}>
                hop {n.depth}: <code>{n.address}</code> share {(n.share * 100).toFixed(1)}% {n.listed && <Status value="confirmed_listing" />} {n.stoppedAt && `stopped at ${n.stoppedAt}`}
              </li>
            ))}
          </ul>
        )}
      </div>
      {['open', 'awaiting_second'].includes(x.case.status) && (
        <div className="card">
          <h2>Decision</h2>
          <ErrorNotice error={decide.error} />
          <Field label="Decision">
            {(fid) => (
              <select id={fid} value={d.decision} onChange={(e) => setD({ ...d, decision: e.target.value })}>
                <option value="confirm">Confirm and list</option>
                <option value="mark_reported">Mark as reported (under review)</option>
                <option value="reject">Reject</option>
              </select>
            )}
          </Field>
          <Field label="Reason code">
            {(fid) => (
              <select id={fid} value={d.reasonCode} onChange={(e) => setD({ ...d, reasonCode: e.target.value })}>
                {['onchain_trail_confirmed', 'law_enforcement', 'insufficient_evidence', 'mistaken_report', 'labelled_service', 'duplicate', 'other'].map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Written reason">{(fid) => <textarea id={fid} value={d.reason} onChange={(e) => setD({ ...d, reason: e.target.value })} />}</Field>
          <Field label="Law-enforcement reference (if any)">{(fid) => <input id={fid} value={d.lawEnforcementRef} onChange={(e) => setD({ ...d, lawEnforcementRef: e.target.value })} />}</Field>
          <label className="check">
            <input type="checkbox" checked={d.onchainTrailConfirmed} onChange={(e) => setD({ ...d, onchainTrailConfirmed: e.target.checked })} />
            The on-chain trail links the funds to this specific address (not a labelled exchange or bridge).
          </label>
          <button className="btn" disabled={decide.busy} onClick={() => void decide.run()}>
            Record decision
          </button>
        </div>
      )}
    </Page>
  );
}

function Appeals() {
  const a = useLoad(() => staffApi.get('/staff/appeals'));
  const [reason, setReason] = useState<Record<string, string>>({});
  const act = useAction(async (id: string, outcome: string) => {
    await staffApi.post(`/staff/appeals/${id}/decide`, { outcome, reason: reason[id] });
    a.reload();
  });
  return (
    <Page title="Appeals (decide within 5 business days)">
      <ErrorNotice error={a.error ?? act.error} />
      {(a.data?.appeals ?? []).map((x: any) => (
        <div key={x.id} className="card">
          <div className="spread">
            <strong>
              {x.public_ref} · {x.kind === 'hold' ? 'hold appeal' : `listing (${x.label})`}
            </strong>
            <span className="small">
              due <When at={x.due_at} />
            </span>
          </div>
          {x.address && <code>{x.address}</code>}
          <p>{x.statement}</p>
          {x.ownership_verified_at && <p className="small">Ownership proven by signature <When at={x.ownership_verified_at} /></p>}
          {x.reporter_statement && <Notice kind="info" title="Reporter's evidence">{x.reporter_statement}</Notice>}
          {[...(x.file_ids ?? []), ...(x.reporter_file_ids ?? [])].map((f: string) => (
            <button key={f} className="btn link" onClick={() => void api.download(`/files/${f}`, `evidence-${f}`, true)}>
              Download evidence
            </button>
          ))}
          <Field label="Written reason (shown to the appellant)">{(id) => <textarea id={id} value={reason[x.id] ?? ''} onChange={(e) => setReason({ ...reason, [x.id]: e.target.value })} />}</Field>
          <div className="row">
            <button className="btn" disabled={act.busy} onClick={() => void act.run(x.id, 'granted')}>
              Grant
            </button>
            <button className="btn secondary" disabled={act.busy} onClick={() => void act.run(x.id, 'upheld')}>
              Uphold
            </button>
          </div>
        </div>
      ))}
    </Page>
  );
}

function Disputes() {
  const d = useLoad(() => staffApi.get('/staff/disputes'));
  return (
    <Page title="Disputes">
      <ErrorNotice error={d.error} />
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Payment</th>
              <th scope="col">Loop</th>
              <th scope="col">Status</th>
              <th scope="col">Ruling due</th>
              <th scope="col">Approvals</th>
            </tr>
          </thead>
          <tbody>
            {(d.data?.disputes ?? []).map((x: any) => (
              <tr key={x.id}>
                <td>
                  <NavLink to={`/staff/disputes/${x.id}`}>{x.title}</NavLink>
                  <div className="small muted">
                    <Money amount={units(x.amount_units)} token={x.token} />
                  </div>
                </td>
                <td>{x.loop}</td>
                <td>{x.status}</td>
                <td>
                  <When at={x.ruling_due_at} />
                </td>
                <td>{x.approvals}/2</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>
  );
}

function DisputeDetail() {
  const { id } = useParams();
  const d = useLoad(() => staffApi.get(`/staff/disputes/${id}`), [id]);
  const [r, setR] = useState({ ruling: 'release', reason: '', fraudFound: false, fraudParty: '' });
  const rule = useAction(async () => {
    await staffApi.post(`/staff/disputes/${id}/rule`, { ...r, fraudParty: r.fraudFound ? r.fraudParty : undefined });
    d.reload();
  });
  const claim = useAction(async () => {
    await staffApi.post(`/staff/disputes/${id}/claim`);
    d.reload();
  });
  const approve = useAction(async () => {
    const out = await staffApi.post(`/staff/disputes/${id}/approve`);
    d.reload();
    return out;
  });
  if (!d.data) return <Loading />;
  const x = d.data;
  return (
    <Page title={x.payment.title}>
      <div className="card">
        <p>
          {x.dispute.loop} · <Money amount={x.payment.amount} token={x.payment.token} /> · escrow <code>{x.payment.escrowAddress}</code>
        </p>
        <p>
          Opened by the {x.dispute.opened_by_role}: {x.dispute.reason} · status <strong>{x.dispute.status}</strong> · evidence until <When at={x.dispute.evidence_due_at} /> · ruling due{' '}
          <When at={x.dispute.ruling_due_at} />
        </p>
        <p className="small">
          Payer history: {x.payerHistory?.payments ?? '—'} payments, {x.payerHistory?.disputed ?? '—'} disputed · Payee history: {x.payeeHistory?.payments} payments, {x.payeeHistory?.disputed} disputed
        </p>
        <button className="btn secondary" onClick={() => void claim.run()}>
          Claim for review
        </button>
      </div>
      <div className="card">
        <h2>Evidence</h2>
        <ul className="list">
          {x.evidence.map((e: any) => (
            <li key={e.id} className="small">
              <strong>{e.party}</strong> · {e.kind} · <When at={e.created_at} /> · <code>{e.sha256.slice(0, 16)}…</code>
              {e.body && <div style={{ whiteSpace: 'pre-wrap' }}>{e.body}</div>}
              {e.url && <div>{e.url}</div>}
              {e.file_id && (
                <button className="btn link" onClick={() => void api.download(`/files/${e.file_id}`, `evidence-${e.file_id}`, true)}>
                  Download
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
      {['evidence', 'in_review'].includes(x.dispute.status) && (
        <div className="card">
          <h2>{x.dispute.second_review_requested_at ? 'Second review (final)' : 'Ruling'}</h2>
          <ErrorNotice error={rule.error} />
          <Field label="Ruling">
            {(fid) => (
              <select id={fid} value={r.ruling} onChange={(e) => setR({ ...r, ruling: e.target.value })}>
                <option value="release">Release to the payee</option>
                <option value="refund">Refund the payer (full amount, no fee)</option>
              </select>
            )}
          </Field>
          <Field label="Reason (both parties see this)">{(fid) => <textarea id={fid} value={r.reason} onChange={(e) => setR({ ...r, reason: e.target.value })} />}</Field>
          <label className="check">
            <input type="checkbox" checked={r.fraudFound} onChange={(e) => setR({ ...r, fraudFound: e.target.checked })} /> This ruling finds fraud (opens a fraud-list case)
          </label>
          {r.fraudFound && (
            <Field label="Which party">
              {(fid) => (
                <select id={fid} value={r.fraudParty} onChange={(e) => setR({ ...r, fraudParty: e.target.value })}>
                  <option value="">Choose…</option>
                  <option value="payer">Payer</option>
                  <option value="payee">Payee</option>
                </select>
              )}
            </Field>
          )}
          <button className="btn" disabled={rule.busy} onClick={() => void rule.run()}>
            Record ruling
          </button>
        </div>
      )}
      {['ruled', 'awaiting_signatures'].includes(x.dispute.status) && (
        <div className="card">
          <h2>Arbiter signatures (2 of 3)</h2>
          <p>
            Ruling: <strong>{x.dispute.final_ruling ?? x.dispute.ruling}</strong> — {x.dispute.final_reason ?? x.dispute.ruling_reason}
          </p>
          {x.dispute.review_window_ends_at && new Date(x.dispute.review_window_ends_at) > new Date() && x.dispute.status === 'ruled' && (
            <Notice kind="info">Parties can ask for a second review until <When at={x.dispute.review_window_ends_at} />.</Notice>
          )}
          <p className="small">
            Approvals: {x.approvals.length}/2 <code>{x.dispute.ruling_hash}</code>
          </p>
          <ErrorNotice error={approve.error} />
          <button className="btn" disabled={approve.busy} onClick={() => void approve.run()}>
            Approve this ruling
          </button>
        </div>
      )}
    </Page>
  );
}

function Listings() {
  const [addr, setAddr] = useState('');
  const l = useLoad(() => staffApi.get(`/staff/listings${addr ? `?address=${encodeURIComponent(addr)}` : ''}`), [addr]);
  const [f, setF] = useState({ address: '', label: 'fraud', source: 'user_report', status: 'confirmed', sourceRef: '', reason: '' });
  const add = useAction(async () => {
    await staffApi.post('/staff/listings', { ...f, sourceRef: f.sourceRef || undefined });
    l.reload();
  });
  const act = useAction(async (id: string, what: 'renew' | 'delist') => {
    const reason = window.prompt(`Reason to ${what}`);
    if (!reason) return;
    await staffApi.post(`/staff/listings/${id}/${what}`, { reason });
    l.reload();
  });
  return (
    <Page title="Fraud list">
      <div className="card">
        <Field label="Find address">{(id) => <input id={id} value={addr} onChange={(e) => setAddr(e.target.value.trim())} />}</Field>
        <ErrorNotice error={l.error ?? act.error} />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Address</th>
                <th scope="col">Label</th>
                <th scope="col">Status</th>
                <th scope="col">Expires</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {(l.data?.listings ?? []).map((x: any) => (
                <tr key={x.id}>
                  <td>
                    <code className="small">{x.address}</code>
                  </td>
                  <td>
                    {x.label} <span className="small muted">({x.source})</span>
                  </td>
                  <td>{x.status}</td>
                  <td>
                    <When at={x.expires_at} />
                  </td>
                  <td className="row">
                    <button className="btn link" onClick={() => void act.run(x.id, 'renew')}>
                      Renew
                    </button>
                    <button className="btn link" onClick={() => void act.run(x.id, 'delist')}>
                      Delist
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void add.run();
        }}
      >
        <h2>Add a listing</h2>
        <ErrorNotice error={add.error} />
        <Field label="Specific address (never an exchange hot wallet or bridge)">{(id) => <input id={id} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} required />}</Field>
        <div className="grid two">
          <Field label="Label">
            {(id) => (
              <select id={id} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })}>
                <option>fraud</option>
                <option>sanctions</option>
                <option>issuer_frozen</option>
                <option>scam_report</option>
              </select>
            )}
          </Field>
          <Field label="Source">
            {(id) => (
              <select id={id} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
                <option value="user_report">User report</option>
                <option value="sanctions">Sanctions list</option>
                <option value="issuer_freeze">Issuer freeze</option>
                <option value="public_scam_site">Public scam site (reported only)</option>
              </select>
            )}
          </Field>
          <Field label="Status">
            {(id) => (
              <select id={id} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
                <option value="confirmed">Confirmed</option>
                <option value="reported">Reported</option>
              </select>
            )}
          </Field>
          <Field label="Source reference">{(id) => <input id={id} value={f.sourceRef} onChange={(e) => setF({ ...f, sourceRef: e.target.value })} />}</Field>
        </div>
        <Field label="Reason">{(id) => <textarea id={id} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required />}</Field>
        <button className="btn" disabled={add.busy}>
          Add
        </button>
      </form>
    </Page>
  );
}

function Users() {
  const [id, setId] = useState('');
  const [reason, setReason] = useState('');
  const u = useLoad(() => (id.length === 36 ? staffApi.get(`/staff/users/${id}`) : Promise.resolve(null)), [id]);
  const act = useAction(async (what: string, body: Record<string, unknown>) => {
    await staffApi.post(`/staff/users/${id}/${what}`, body);
    u.reload();
  });
  return (
    <Page title="Users">
      <div className="card">
        <Field label="User ID">{(fid) => <input id={fid} value={id} onChange={(e) => setId(e.target.value.trim())} />}</Field>
        <ErrorNotice error={u.error ?? act.error} />
        {u.data && (
          <>
            <dl className="kv">
              {Object.entries(u.data.user).map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt>
                  <dd>{String(v ?? '—')}</dd>
                </div>
              ))}
              <dt>wallet</dt>
              <dd>
                <code>{u.data.wallet?.tron_address}</code> <code>{u.data.wallet?.evm_address}</code>
              </dd>
            </dl>
            <Field label="Reason">{(fid) => <textarea id={fid} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
            <div className="row">
              <button className="btn danger" onClick={() => void act.run('suspend', { reason })}>
                Suspend
              </button>
              <button className="btn danger" onClick={() => void act.run('suspend', { reason, nairaFraud: true })}>
                Suspend: naira reported fraudulent (L4-8)
              </button>
              <button className="btn secondary" onClick={() => void act.run('reinstate', { reason })}>
                Reinstate
              </button>
            </div>
          </>
        )}
      </div>
    </Page>
  );
}

function Metrics() {
  const m = useLoad(() => staffApi.get('/staff/metrics'));
  if (m.error) return <ErrorNotice error={m.error} />;
  if (!m.data) return <Loading />;
  const x = m.data;
  return (
    <Page title="Success metrics">
      <div className="grid two">
        <div className="card">
          <h2>Verified users</h2>
          <p className="big">{x.verifiedUsers.tier1 + x.verifiedUsers.tier2}</p>
          <p className="small">
            Tier 1 {x.verifiedUsers.tier1} · Tier 2 {x.verifiedUsers.tier2}
          </p>
        </div>
        <div className="card">
          <h2>Pre-send check p95 (24h)</h2>
          <p className="big">{x.presendLatency24h.p95Ms === null ? '—' : `${Math.round(x.presendLatency24h.p95Ms)} ms`}</p>
          <p className="small">Target ≤ {x.presendLatency24h.targetMs} ms · {x.presendLatency24h.samples} checks</p>
        </div>
        <div className="card">
          <h2>Completed without a ruling</h2>
          {x.protectedPaymentsCompleted.map((c: any) => (
            <p key={c.loop}>
              {c.loop}: {c.share === null ? '—' : `${Math.round(c.share * 100)}%`} of {c.funded} (target ≥ 90%)
            </p>
          ))}
        </div>
        <div className="card">
          <h2>Dispute rate</h2>
          {x.disputeRate.map((d: any) => (
            <p key={d.loop}>
              {d.loop}: {(d.rate * 100).toFixed(1)}% {d.needsReview && <span className="badge danger">above 5%: review</span>}
            </p>
          ))}
        </div>
        <div className="card">
          <h2>Median ruling time</h2>
          {x.medianRulingHours.map((r: any) => (
            <p key={r.loop}>
              {r.loop}: {r.hours === null ? '—' : `${r.hours.toFixed(1)} h`}
            </p>
          ))}
          <p className="small muted">Targets: ≤ 5 business days (L2, L3), ≤ 24 h (L4)</p>
        </div>
        <div className="card">
          <h2>Appeals and holds</h2>
          <p>Median appeal time: {x.medianAppealHours === null ? '—' : `${x.medianAppealHours.toFixed(1)} h`}</p>
          <p className="small">False holds per week: {x.falseHoldsPerWeek.map((w: any) => `${w.week}: ${w.count}`).join(', ') || '—'}</p>
          <p className="small">
            60-day retention: {x.retention60d.repeaters}/{x.retention60d.payers}
          </p>
        </div>
      </div>
      <div className="card">
        <h2>Protected volume</h2>
        <ul className="list">
          {x.protectedVolume.map((v: any) => (
            <li key={`${v.loop}${v.month}`}>
              {v.month} {v.loop}: <Money amount={v.usd} />
            </li>
          ))}
        </ul>
      </div>
    </Page>
  );
}

function Audit() {
  const [subject, setSubject] = useState('');
  const a = useLoad(() => staffApi.get(`/staff/audit?limit=200${subject ? `&subjectId=${subject}` : ''}`), [subject]);
  const v = useAction(async () => staffApi.get('/staff/audit/verify'));
  const [verify, setVerify] = useState<any>(null);
  return (
    <Page title="Audit log">
      <div className="card">
        <div className="row">
          <button className="btn secondary" onClick={() => void v.run().then(setVerify)}>
            Verify hash chain
          </button>
          {verify && (verify.intact ? <span className="badge ok">Intact ({verify.total} events)</span> : <span className="badge danger">{verify.brokenLinks} broken links</span>)}
        </div>
        <ErrorNotice error={v.error ?? a.error} />
        <Field label="Subject ID">{(id) => <input id={id} value={subject} onChange={(e) => setSubject(e.target.value.trim())} />}</Field>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Subject</th>
              </tr>
            </thead>
            <tbody>
              {(a.data?.events ?? []).map((e: any) => (
                <tr key={e.id}>
                  <td className="small">
                    <When at={e.at} />
                  </td>
                  <td className="small">
                    {e.actor_type} {e.actor_id?.slice(0, 8)}
                  </td>
                  <td>{e.action}</td>
                  <td className="small">
                    {e.subject_type} {e.subject_id?.slice(0, 8)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Page>
  );
}

function DecisionReplay() {
  const { id } = useParams();
  const r = useLoad(() => staffApi.get(`/staff/decisions/${id}/replay`), [id]);
  if (r.error) return <ErrorNotice error={r.error} />;
  if (!r.data) return <Loading />;
  return (
    <Page title="Decision replay">
      <div className="card">
        {r.data.matches ? <Notice kind="ok">Replaying the stored inputs under {r.data.ruleVersion} gives the same result.</Notice> : <Notice kind="danger">Replay differs from the recorded decision.</Notice>}
        <p>
          Recorded: <Status value={r.data.recorded.decision} /> {r.data.recorded.reasons.join(', ')} · list version {r.data.listVersion}
        </p>
        <pre className="mono small" style={{ whiteSpace: 'pre-wrap' }}>
          {JSON.stringify(r.data.facts, null, 2)}
        </pre>
      </div>
    </Page>
  );
}

function SupportDesk() {
  const t = useLoad(() => staffApi.get('/staff/support'));
  const [sel, setSel] = useState<string | null>(null);
  const th = useLoad(() => (sel ? staffApi.get(`/staff/support/${sel}`) : Promise.resolve(null)), [sel]);
  const [body, setBody] = useState('');
  const reply = useAction(async (close: boolean) => {
    await staffApi.post(`/staff/support/${sel}/reply`, { body, close });
    setBody('');
    th.reload();
    t.reload();
  });
  return (
    <Page title="Support">
      <div className="grid two">
        <div className="card">
          <ul className="list">
            {(t.data?.threads ?? []).map((x: any) => (
              <li key={x.id}>
                <button className="btn link" onClick={() => setSel(x.id)}>
                  {x.subject}
                </button>{' '}
                {x.funds_involved && <span className="badge warn">funds</span>}
                <div className="small muted">
                  @{x.handle} · respond by <When at={x.first_response_due} />
                </div>
              </li>
            ))}
          </ul>
        </div>
        {th.data && (
          <div className="card">
            <div className="chat">
              {th.data.messages.map((m: any) => (
                <div key={m.id} className={`bubble ${m.author_staff_id ? 'me' : ''}`}>
                  {m.body}
                </div>
              ))}
            </div>
            <Field label="Reply">{(id) => <textarea id={id} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
            <div className="row">
              <button className="btn" onClick={() => void reply.run(false)}>
                Send
              </button>
              <button className="btn secondary" onClick={() => void reply.run(true)}>
                Send and close
              </button>
            </div>
          </div>
        )}
      </div>
    </Page>
  );
}

export function StaffApp() {
  const nav = useNavigate();
  const me = useLoad(() => (hasStaffToken() ? staffApi.get('/staff/me') : Promise.reject(new Error('signed out'))), []);
  if (me.loading) return <Loading />;
  if (me.error || !me.data) return <StaffLogin onDone={() => (me.reload(), nav('/staff'))} />;
  const links: Array<[string, string]> = [
    ['/staff', 'Queues'],
    ['/staff/reviews', 'Reviews'],
    ['/staff/cases', 'Fraud cases'],
    ['/staff/appeals', 'Appeals'],
    ['/staff/disputes', 'Disputes'],
    ['/staff/listings', 'Fraud list'],
    ['/staff/users', 'Users'],
    ['/staff/metrics', 'Metrics'],
    ['/staff/audit', 'Audit log'],
    ['/staff/support', 'Support'],
  ];
  return (
    <div className="shell">
      <aside className="side">
        <div className="logo">Backstop staff</div>
        <nav aria-label="Staff">
          {links.map(([to, l]) => (
            <NavLink key={to} to={to} end={to === '/staff'}>
              {l}
            </NavLink>
          ))}
        </nav>
        <p className="small muted" style={{ padding: 12 }}>
          {me.data.name} · {me.data.roles.join(', ')}
          <br />
          <button className="btn link" onClick={() => void staffApi.post('/staff/logout').finally(() => (setStaffToken(null), me.reload()))}>
            Sign out
          </button>
        </p>
      </aside>
      <main className="main" id="main">
        <Routes>
          <Route index element={<Queues />} />
          <Route path="reviews" element={<Reviews />} />
          <Route path="cases" element={<Cases />} />
          <Route path="cases/:id" element={<CaseDetail />} />
          <Route path="appeals" element={<Appeals />} />
          <Route path="disputes" element={<Disputes />} />
          <Route path="disputes/:id" element={<DisputeDetail />} />
          <Route path="listings" element={<Listings />} />
          <Route path="users" element={<Users />} />
          <Route path="metrics" element={<Metrics />} />
          <Route path="audit" element={<Audit />} />
          <Route path="decisions/:id" element={<DecisionReplay />} />
          <Route path="support" element={<SupportDesk />} />
        </Routes>
      </main>
    </div>
  );
}
