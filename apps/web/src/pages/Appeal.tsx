// C5 public appeal page: no account needed, rate-limited, bot-protected. The appellant proves
// control of the address by signing a one-time message (EIP-191 on EVM, signMessageV2 on TRON).
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, publicConfig } from '../lib/api';
import { signMessageExternal } from '../lib/external';
import { Copy, ErrorNotice, Field, Loading, Notice, Status, useAction, useLoad, When } from '../components/ui';

function useCaptcha(): [string | null, JSX.Element | null] {
  const cfg = useLoad(() => publicConfig());
  const [tok, setTok] = useState<string | null>(null);
  if (!cfg.data) return [null, null];
  if (cfg.data.captcha.provider === 'sandbox')
    return [
      tok,
      <label className="check" key="c">
        <input type="checkbox" checked={!!tok} onChange={(e) => setTok(e.target.checked ? 'sandbox-pass' : null)} /> I'm not a robot (test environment)
      </label>,
    ];
  // Cloudflare Turnstile widget: the token arrives through the global callback.
  (window as unknown as Record<string, unknown>).bsTurnstile = (t: string) => setTok(t);
  return [tok, <div key="t" className="cf-turnstile" data-sitekey={cfg.data.captcha.siteKey ?? ''} data-callback="bsTurnstile" />];
}

export function Appeal() {
  const nav = useNavigate();
  const [address, setAddress] = useState('');
  const [status, setStatus] = useState<any>(null);
  const [ch, setCh] = useState<any>(null);
  const [sig, setSig] = useState('');
  const [f, setF] = useState({ email: '', statement: '', newEvidence: false });
  const [files, setFiles] = useState<string[]>([]);
  const [captcha, captchaUi] = useCaptcha();
  const [ref, setRef] = useState('');
  const lookup = useAction(async () => setStatus(await api.get(`/public/listings/${encodeURIComponent(address.trim())}`)));
  const challenge = useAction(async () => setCh(await api.post('/public/appeals/challenge', { address: address.trim(), captchaToken: captcha })));
  const walletSign = useAction(async () => setSig(await signMessageExternal(ch.family, address.trim(), ch.message)));
  const upload = useAction(async (fl: FileList) => {
    for (const file of Array.from(fl)) {
      const r = await api.upload('appeal_evidence', file, { public: true, captchaToken: captcha ?? undefined });
      setFiles((x) => [...x, r.id]);
    }
  });
  const submit = useAction(async () => {
    const r = await api.post('/public/appeals', { challengeId: ch.challengeId, signature: sig.trim(), email: f.email, statement: f.statement, fileIds: files, newEvidence: f.newEvidence, captchaToken: captcha });
    nav(`/appeal/${r.reference}`);
  });
  return (
    <div className="stack">
      <h1>Appeal a fraud-list listing</h1>
      <p className="muted">The list holds addresses, never people. If you control a listed address you can appeal. An analyst who did not make the original decision decides within 5 business days.</p>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void lookup.run();
        }}
      >
        <ErrorNotice error={lookup.error} />
        <Field label="Address">{(id) => <input id={id} value={address} onChange={(e) => setAddress(e.target.value)} required />}</Field>
        <button className="btn secondary" disabled={lookup.busy}>
          Check status
        </button>
        {status && (
          <div style={{ marginTop: 12 }}>
            {status.listed ? (
              status.listings.map((l: any, i: number) => (
                <p key={i}>
                  <Status value={l.status === 'confirmed' ? 'confirmed_listing' : l.status} /> {l.caseType} · listed <When at={l.listedAt} /> {l.expiresAt && <>· expires <When at={l.expiresAt} /></>}
                </p>
              ))
            ) : (
              <Notice kind="ok">This address is not on the Backstop fraud list.</Notice>
            )}
          </div>
        )}
      </form>
      {status?.listed && (
        <div className="card">
          <h2>1. Prove you control the address</h2>
          {captchaUi}
          <ErrorNotice error={challenge.error} />
          {!ch ? (
            <button className="btn" disabled={!captcha || challenge.busy} onClick={() => void challenge.run()}>
              Get message to sign
            </button>
          ) : (
            <div className="stack">
              <p className="small">{ch.howToSign} It doesn't move funds.</p>
              <pre className="mono small" style={{ whiteSpace: 'pre-wrap', background: 'var(--surface-2)', padding: 12, borderRadius: 8 }}>
                {ch.message}
              </pre>
              <div className="row">
                <Copy text={ch.message} label="Copy message" />
                <button className="btn secondary" onClick={() => void walletSign.run()}>
                  Sign with my wallet
                </button>
              </div>
              <ErrorNotice error={walletSign.error} />
              <Field label="Signature" hint="Paste it here if you signed elsewhere.">
                {(id, d) => <textarea id={id} aria-describedby={d} className="mono" value={sig} onChange={(e) => setSig(e.target.value)} />}
              </Field>
            </div>
          )}
        </div>
      )}
      {ch && sig && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void submit.run();
          }}
        >
          <h2>2. Explain and add evidence</h2>
          <ErrorNotice error={submit.error} />
          <Field label="Email for updates">{(id) => <input id={id} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />}</Field>
          <Field label="Why the listing is wrong">{(id) => <textarea id={id} value={f.statement} onChange={(e) => setF({ ...f, statement: e.target.value })} required minLength={20} />}</Field>
          <label>
            Evidence files
            <input type="file" multiple onChange={(e) => e.target.files && void upload.run(e.target.files)} />
          </label>
          <ErrorNotice error={upload.error} />
          {files.length > 0 && <p className="small">{files.length} file(s) attached</p>}
          <label className="check">
            <input type="checkbox" checked={f.newEvidence} onChange={(e) => setF({ ...f, newEvidence: e.target.checked })} /> This includes new evidence since a previous appeal
          </label>
          <button className="btn" disabled={submit.busy}>
            Submit appeal
          </button>
        </form>
      )}
      <p className="small">
        Have a reference? <a href="#lookup" onClick={(e) => (e.preventDefault(), ref && nav(`/appeal/${ref}`))}>Check your appeal</a>{' '}
        <input aria-label="Appeal reference" value={ref} onChange={(e) => setRef(e.target.value.toUpperCase())} placeholder="AP-XXXXXX" style={{ maxWidth: 160, display: 'inline-block' }} />
      </p>
    </div>
  );
}

export function AppealStatus() {
  const { ref } = useParams();
  const a = useLoad(() => api.get(`/public/appeals/${ref}`), [ref]);
  if (a.error) return <ErrorNotice error={a.error} />;
  if (!a.data) return <Loading />;
  const x = a.data;
  return (
    <div className="card">
      <h1>Appeal {x.reference}</h1>
      <dl className="kv">
        <dt>Status</dt>
        <dd>
          <Status value={x.status} />
        </dd>
        <dt>Case type</dt>
        <dd>{x.caseType}</dd>
        {x.listingStatus && (
          <>
            <dt>Listing</dt>
            <dd>{x.listingStatus.replace(/_/g, ' ')}</dd>
          </>
        )}
        <dt>Appealed</dt>
        <dd>
          <When at={x.appealedAt} />
        </dd>
        <dt>Decision due</dt>
        <dd>
          <When at={x.decisionDueBy} />
        </dd>
        {x.decidedAt && (
          <>
            <dt>Decided</dt>
            <dd>
              <When at={x.decidedAt} />
            </dd>
            <dt>Reason</dt>
            <dd>{x.decisionReason}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
