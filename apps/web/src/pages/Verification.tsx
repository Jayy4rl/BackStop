// C1: Tier 1 (BVN or NIN + liveness), Tier 2 (CAC, Tier 1 director, address), counterparty documents.
import { useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { ErrorNotice, Field, Money, Notice, useAction } from '../components/ui';
import { Liveness } from '../components/Liveness';

export function Verification() {
  const { me, refresh } = useSession();
  const [t1, setT1] = useState({ idType: 'bvn', idNumber: '', firstName: '', lastName: '', dateOfBirth: '' });
  const [t2, setT2] = useState({ rcNumber: '', address: '', directors: '', approvers: '', secondApproverAbove: '' });
  const [cp, setCp] = useState({ docType: 'passport', docNumber: '', fullName: '' });
  const [live, setLive] = useState<string | null>(null);
  const tier1 = useAction(async () => {
    await api.post('/identity/tier1', { ...t1, livenessToken: live });
    await refresh();
  });
  const tier2 = useAction(async () => {
    await api.post('/identity/business', {
      rcNumber: t2.rcNumber,
      address: t2.address,
      directorHandles: t2.directors.split(',').map((s) => s.trim()).filter(Boolean),
      approverHandles: t2.approvers.split(',').map((s) => s.trim()).filter(Boolean),
      secondApproverAbove: t2.secondApproverAbove || undefined,
    });
    await refresh();
  });
  const counterparty = useAction(async () => {
    await api.post('/identity/counterparty', { ...cp, livenessToken: live });
    await refresh();
  });
  if (!me) return null;
  return (
    <div>
      <h1>Verification</h1>
      <div className="card">
        <p>
          Status: <strong>{me.tier === 'none' ? 'Not verified' : me.tier === 'tier1' ? 'Tier 1 (individual)' : me.tier === 'tier2' ? 'Tier 2 (business)' : 'Client/supplier account'}</strong>
          {me.verifiedName && <> · verified name <strong>{me.verifiedName}</strong></>}
        </p>
        <p className="small">
          Your limits: <Money amount={me.limits.perTransaction} /> per payment, <Money amount={me.limits.daily} /> per day.
        </p>
        <p className="small muted">Identity data is encrypted and kept only as long as the law requires (Nigeria Data Protection Act 2023).</p>
      </div>

      {me.kind === 'individual' && me.tier === 'none' && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void tier1.run();
          }}
        >
          <h2>Verify with BVN or NIN</h2>
          <p className="small muted">Unlocks sending, invoices and P2P. One account per BVN or NIN.</p>
          <ErrorNotice error={tier1.error} />
          <Field label="ID type">
            {(id) => (
              <select id={id} value={t1.idType} onChange={(e) => setT1({ ...t1, idType: e.target.value })}>
                <option value="bvn">BVN</option>
                <option value="nin">NIN</option>
              </select>
            )}
          </Field>
          <Field label="Number" hint="11 digits">
            {(id, d) => <input id={id} aria-describedby={d} inputMode="numeric" maxLength={11} value={t1.idNumber} onChange={(e) => setT1({ ...t1, idNumber: e.target.value })} required />}
          </Field>
          <div className="grid two">
            <Field label="First name">{(id) => <input id={id} value={t1.firstName} onChange={(e) => setT1({ ...t1, firstName: e.target.value })} required />}</Field>
            <Field label="Last name">{(id) => <input id={id} value={t1.lastName} onChange={(e) => setT1({ ...t1, lastName: e.target.value })} required />}</Field>
          </div>
          <Field label="Date of birth">{(id) => <input id={id} type="date" value={t1.dateOfBirth} onChange={(e) => setT1({ ...t1, dateOfBirth: e.target.value })} required />}</Field>
          <Liveness onDone={setLive} />
          <button className="btn" disabled={tier1.busy || !live}>
            Verify
          </button>
        </form>
      )}

      {me.kind === 'business' && me.tier !== 'tier2' && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void tier2.run();
          }}
        >
          <h2>Verify your business</h2>
          <p className="small muted">We check the CAC register. At least one director on the record must be a Tier 1 verified Backstop user.</p>
          <ErrorNotice error={tier2.error} />
          <Field label="RC number">{(id) => <input id={id} value={t2.rcNumber} onChange={(e) => setT2({ ...t2, rcNumber: e.target.value })} required />}</Field>
          <Field label="Business address">{(id) => <input id={id} value={t2.address} onChange={(e) => setT2({ ...t2, address: e.target.value })} required />}</Field>
          <Field label="Directors' Backstop handles" hint="Comma separated, e.g. ada, emeka">
            {(id, d) => <input id={id} aria-describedby={d} value={t2.directors} onChange={(e) => setT2({ ...t2, directors: e.target.value })} required />}
          </Field>
          <Field label="Second approvers (optional)" hint="Tier 1 users who must approve funding and release above an amount.">
            {(id, d) => <input id={id} aria-describedby={d} value={t2.approvers} onChange={(e) => setT2({ ...t2, approvers: e.target.value })} />}
          </Field>
          <Field label="Require a second approver above ($, optional)">{(id) => <input id={id} inputMode="decimal" value={t2.secondApproverAbove} onChange={(e) => setT2({ ...t2, secondApproverAbove: e.target.value })} />}</Field>
          <button className="btn" disabled={tier2.busy}>
            Verify business
          </button>
        </form>
      )}

      {me.kind === 'counterparty' && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void counterparty.run();
          }}
        >
          <h2>Verify your ID</h2>
          <p className="small muted">Needed to pay or be paid above {me.limits.counterpartyVerificationThreshold ? `$${me.limits.counterpartyVerificationThreshold}` : 'a threshold'}, and for suppliers before money is released to them.</p>
          <ErrorNotice error={counterparty.error} />
          <Field label="Document">
            {(id) => (
              <select id={id} value={cp.docType} onChange={(e) => setCp({ ...cp, docType: e.target.value })}>
                <option value="passport">Passport</option>
                <option value="national_id">National ID</option>
                <option value="drivers_licence">Driver's licence</option>
              </select>
            )}
          </Field>
          <Field label="Document number">{(id) => <input id={id} value={cp.docNumber} onChange={(e) => setCp({ ...cp, docNumber: e.target.value })} required />}</Field>
          <Field label="Full name as on the document">{(id) => <input id={id} value={cp.fullName} onChange={(e) => setCp({ ...cp, fullName: e.target.value })} required />}</Field>
          <Liveness onDone={setLive} />
          <button className="btn" disabled={counterparty.busy || !live}>
            Verify
          </button>
        </form>
      )}
      {me.tier !== 'none' && me.kind !== 'counterparty' && <Notice kind="ok">You're verified.</Notice>}
    </div>
  );
}
