// C5-1: "Report fraud" with case type, transaction hashes, statement and attachments.
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { ErrorNotice, Field, Notice, useAction } from '../components/ui';
import { FileInput } from './Payment';

export function ReportFraud() {
  const [q] = useSearchParams();
  const [f, setF] = useState({ caseType: 'scam', addresses: q.get('address') ?? '', txHashes: '', amount: '', statement: '' });
  const [files, setFiles] = useState<Array<{ id: string; name: string }>>([]);
  const [done, setDone] = useState<string | null>(null);
  const submit = useAction(async () => {
    const r = await api.post('/fraud-reports', {
      caseType: f.caseType,
      suspectAddresses: f.addresses.split(/[\s,]+/).filter(Boolean),
      txHashes: f.txHashes.split(/[\s,]+/).filter(Boolean),
      amount: f.amount || undefined,
      statement: f.statement,
      fileIds: files.map((x) => x.id),
      transferId: q.get('transfer') ?? undefined,
      paymentId: q.get('payment') ?? undefined,
      tradeId: q.get('trade') ?? undefined,
    });
    setDone(r.message);
  });
  if (done) return <Notice kind="ok" title="Report received">{done}</Notice>;
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        void submit.run();
      }}
    >
      <h1>Report fraud</h1>
      <p className="small muted">The fraud list holds addresses, never people. An analyst confirms only when the on-chain trail links the funds to the address.</p>
      <ErrorNotice error={submit.error} />
      <Field label="What happened?">
        {(id) => (
          <select id={id} value={f.caseType} onChange={(e) => setF({ ...f, caseType: e.target.value })}>
            <option value="scam">Scam</option>
            <option value="non_delivery">Paid but nothing delivered</option>
            <option value="impersonation">Impersonation</option>
            <option value="phishing">Phishing / stolen access</option>
            <option value="stolen_funds">Stolen funds</option>
            <option value="third_party_naira">Naira from someone else's account (P2P)</option>
            <option value="other">Other</option>
          </select>
        )}
      </Field>
      <Field label="Suspect addresses" hint="One or more, separated by spaces or commas.">
        {(id, d) => <textarea id={id} aria-describedby={d} value={f.addresses} onChange={(e) => setF({ ...f, addresses: e.target.value })} required />}
      </Field>
      <Field label="Transaction hashes">{(id) => <textarea id={id} value={f.txHashes} onChange={(e) => setF({ ...f, txHashes: e.target.value })} />}</Field>
      <Field label="Amount lost ($)">{(id) => <input id={id} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />}</Field>
      <Field label="What happened, in your words">{(id) => <textarea id={id} value={f.statement} onChange={(e) => setF({ ...f, statement: e.target.value })} required minLength={20} />}</Field>
      <FileInput purpose="report_evidence" label="Screenshots, receipts, chats" onUploaded={(id, name) => setFiles((x) => [...x, { id, name }])} />
      {files.length > 0 && <p className="small">Attached: {files.map((x) => x.name).join(', ')}</p>}
      <button className="btn" disabled={submit.busy}>
        Send report
      </button>
    </form>
  );
}
