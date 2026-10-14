// In-app support chat: a human replies within 4 business hours for held or escrowed funds.
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { ErrorNotice, Field, Notice, Status, useAction, useLoad, When } from '../components/ui';

export function Support() {
  const [q] = useSearchParams();
  const threads = useLoad(() => api.get('/support/threads'));
  const [sel, setSel] = useState<string | null>(null);
  const thread = useLoad(() => (sel ? api.get(`/support/threads/${sel}`) : Promise.resolve(null)), [sel]);
  const [f, setF] = useState({ subject: '', body: '' });
  const [reply, setReply] = useState('');
  const [created, setCreated] = useState<any>(null);
  const create = useAction(async () => {
    const r = await api.post('/support/threads', { ...f, paymentId: q.get('payment') ?? undefined, transferId: q.get('transfer') ?? undefined });
    setCreated(r);
    setF({ subject: '', body: '' });
    threads.reload();
  });
  const send = useAction(async () => {
    await api.post(`/support/threads/${sel}/messages`, { body: reply });
    setReply('');
    thread.reload();
  });
  return (
    <div>
      <h1>Support</h1>
      <div className="grid two">
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void create.run();
          }}
        >
          <h2>Ask for help</h2>
          {created && <Notice kind="ok">We'll reply by <When at={created.firstResponseDue} />{created.fundsInvolved ? ' (held or escrowed funds get priority)' : ''}.</Notice>}
          <ErrorNotice error={create.error} />
          <Field label="Subject">{(id) => <input id={id} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} required />}</Field>
          <Field label="Message">{(id) => <textarea id={id} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required />}</Field>
          <button className="btn" disabled={create.busy}>
            Send
          </button>
        </form>
        <div className="card">
          <h2>Conversations</h2>
          <ul className="list">
            {(threads.data?.threads ?? []).map((t: any) => (
              <li key={t.id} className="spread">
                <button className="btn link" onClick={() => setSel(t.id)}>
                  {t.subject}
                </button>
                <Status value={t.status} />
              </li>
            ))}
          </ul>
        </div>
      </div>
      {thread.data && (
        <div className="card">
          <h2>{thread.data.thread.subject}</h2>
          <div className="chat">
            {thread.data.messages.map((m: any) => (
              <div key={m.id} className={`bubble ${m.from_support ? '' : 'me'}`}>
                {m.body}
                <div className="small muted">{m.from_support ? 'Backstop support' : 'You'} · <When at={m.created_at} /></div>
              </div>
            ))}
          </div>
          <form
            className="row"
            style={{ marginTop: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              void send.run();
            }}
          >
            <label htmlFor="supreply" className="skip">
              Reply
            </label>
            <input id="supreply" value={reply} onChange={(e) => setReply(e.target.value)} style={{ flex: 1 }} required />
            <button className="btn">Send</button>
          </form>
        </div>
      )}
    </div>
  );
}
