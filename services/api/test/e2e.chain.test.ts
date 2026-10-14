// End-to-end on a real local chain: the API builds call bundles, wallets sign them, the real
// contracts execute, and the indexer and keeper drive the product state from the chain.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { erc20Abi, type Hex } from 'viem';
import { parseUnits } from '@backstop/shared';
import { call, createHarness, ok, signup, stepUp, tier1, addStaff, staffLogin, type Harness, type TestUser } from './helpers/harness.ts';
import { KEYS, startAnvil, type Anvil } from './helpers/anvil.ts';
import { indexAll } from '../src/services/indexer.ts';
import { jobHandlers, keeperSweep } from '../src/services/keeper.ts';
import { JobRunner } from '../src/lib/jobs.ts';
import { upsertListing } from '../src/services/fraudlist.ts';
import { SandboxCompanyRegistry } from '../src/adapters/identity.ts';

let chain: Anvil;
let h: Harness;
let runner: JobRunner;
const companies = new SandboxCompanyRegistry('');
const treasury = privateKeyToAccount(KEYS.treasury).address;

async function sync() {
  h.clock.set(await chain.time());
}
async function index() {
  await sync();
  await indexAll(h.ctx);
}
async function work() {
  await sync();
  await keeperSweep(h.ctx);
  for (let i = 0; i < 5; i++) if ((await runner.runOnce(100, h.clock.now)) === 0) break;
  await index();
}
async function usdc(addr: string): Promise<bigint> {
  return chain.pub.readContract({ address: chain.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [addr as Hex] });
}
async function signBundle(key: Hex, b: { calls: Array<{ to: string; data: Hex }> }) {
  return chain.send(key, b.calls);
}
function multipart(fields: Record<string, string>, file: { name: string; type: string; data: Buffer }) {
  const boundary = `----bs${Date.now()}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
async function upload(u: TestUser, purpose: string, name = 'proof.pdf'): Promise<string> {
  const m = multipart({ purpose }, { name, type: 'application/pdf', data: Buffer.from(`%PDF-1.4 test ${name} ${Math.random()}`) });
  const res = await h.app.inject({ method: 'POST', url: '/files', payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${u.token}` } });
  if (res.statusCode !== 200) throw new Error(res.body);
  return JSON.parse(res.body).id;
}
async function fundedUser(opts: Parameters<typeof signup>[1] = {}, usd = '1000'): Promise<TestUser> {
  const u = await signup(h, opts);
  await chain.fund(u.evm);
  await chain.mint(u.evm, parseUnits(usd));
  return u;
}

beforeAll(async () => {
  chain = await startAnvil();
  const start = await chain.pub.getBlockNumber();
  h = await createHarness({
    cfg: {
      chains: { base: { network: 'base', rpcUrls: [chain.url], chainId: 31337, factory: chain.factory, tokens: { USDC: chain.usdc }, finality: 'latest', startBlock: start, keeperKey: KEYS.keeper } },
      arbiterExecutorKey: KEYS.arbiter,
      treasury: { base: treasury },
    },
    overrides: { companies },
  });
  runner = new JobRunner(h.ctx.db, jobHandlers(h.ctx));
  await index();
}, 120_000);

afterAll(async () => {
  await h?.close();
  chain?.stop();
});

describe('L1 send and receive on chain', () => {
  let ada: TestUser;
  let ben: TestUser;
  it('indexes deposits, runs the inbound check and shows balances', async () => {
    ada = await fundedUser({ handle: 'adae2e' }, '500');
    ben = await signup(h, { handle: 'bene2e' });
    await tier1(h, ada, 'Ada', 'Eze');
    await tier1(h, ben, 'Ben', 'Obi');
    await index();
    const hist = await ok(h, { method: 'GET', url: '/wallet/history', token: ada.token });
    expect(hist.items[0]).toMatchObject({ direction: 'in', status: 'final', availability: 'available', amount: '500', network: 'base' });
    const bal = await ok(h, { method: 'GET', url: '/wallet/balances', token: ada.token });
    const b = bal.pairs.find((p: { network: string; token: string }) => p.network === 'base' && p.token === 'USDC');
    expect(b).toMatchObject({ balance: '500', spendable: '500', source: 'chain' });
    expect(bal.nairaReference.source).toBeTruthy();
  });

  it('sends to a Backstop user: check, passkey, sign, submit, final; never broadcasts twice', async () => {
    const q = await ok(h, { method: 'POST', url: '/send/quote', token: ada.token, payload: { recipient: '@bene2e', token: 'USDC', amount: '25' } });
    expect(q.network).toBe('base');
    expect(q.check.decision).toBe('allow');
    await stepUp(h, ada);
    const prep = await ok(h, { method: 'POST', url: '/send/prepare', token: ada.token, payload: { decisionId: q.check.decisionId, idempotencyKey: 'send-ada-1' } });
    const again = await ok(h, { method: 'POST', url: '/send/prepare', token: ada.token, payload: { decisionId: q.check.decisionId, idempotencyKey: 'send-ada-1' } });
    expect(again.transferId).toBe(prep.transferId);
    expect(prep.bundle.sponsorship).toBe('base_usdc_paymaster');
    const [hash] = await signBundle(ada.key, prep.bundle);
    await ok(h, { method: 'POST', url: '/send/submit', token: ada.token, payload: { transferId: prep.transferId, txHash: hash } });
    await index();
    const t = await ok(h, { method: 'GET', url: `/transfers/${prep.transferId}`, token: ada.token });
    expect(t.status).toBe('final');
    const benHist = await ok(h, { method: 'GET', url: '/wallet/history', token: ben.token });
    expect(benHist.items[0]).toMatchObject({ direction: 'in', amount: '25', availability: 'available', counterparty: 'adae2e' });
    const notes = await ok(h, { method: 'GET', url: '/notifications', token: ada.token });
    expect(notes.notifications.map((n: { kind: string }) => n.kind)).toContain('send_final');
    const csv = await call(h, { method: 'GET', url: '/wallet/history.csv', token: ada.token });
    expect(String(csv.body)).toContain('date,direction,type,status');
    expect(String(csv.body).split('\n').length).toBeGreaterThanOrEqual(3);
  });

  it('holds funds from a listed sender: not spendable, explained, appealable', async () => {
    const scammerKey = generatePrivateKey();
    const scammer = privateKeyToAccount(scammerKey).address;
    await chain.fund(scammer);
    await chain.mint(scammer, parseUnits('300'));
    await upsertListing(h.ctx.db, { address: scammer, label: 'fraud', source: 'user_report', status: 'confirmed', now: h.clock.now, expiryMonths: 12 });
    await chain.send(scammerKey, [{ to: chain.usdc, data: (await import('viem')).encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ben.evm, parseUnits('300')] }) }]);
    await index();
    const bal = await ok(h, { method: 'GET', url: '/wallet/balances', token: ben.token });
    const b = bal.pairs.find((p: { network: string; token: string }) => p.network === 'base' && p.token === 'USDC');
    expect(b).toMatchObject({ balance: '325', held: '300', spendable: '25' });
    expect(bal.holds[0].hold_reason).toMatch(/fraud list/);
    // C3-4: held funds can't be used for in-app payments
    const q = await ok(h, { method: 'POST', url: '/send/quote', token: ben.token, payload: { recipient: '@adae2e', token: 'USDC', amount: '100' } });
    await stepUp(h, ben);
    const prep = await call(h, { method: 'POST', url: '/send/prepare', token: ben.token, payload: { decisionId: q.check.decisionId, idempotencyKey: 'ben-held-1' } });
    expect(prep.body.error.code).toBe('funds_on_hold');
    // appeal the hold -> analyst grants -> available
    const held = bal.holds[0].id;
    const ap = await ok(h, { method: 'POST', url: '/appeals/hold', token: ben.token, payload: { transferId: held, statement: 'This was payment for a laptop I sold. Receipts attached.' } });
    expect(ap.reference).toMatch(/^AP-/);
    await addStaff(h, 'analyst1@backstop.ng', ['risk_analyst']);
    const st = await staffLogin(h, 'analyst1@backstop.ng');
    const list = await ok(h, { method: 'GET', url: '/staff/appeals', token: st });
    const appeal = list.appeals.find((a: { transfer_id: string }) => a.transfer_id === held);
    await ok(h, { method: 'POST', url: `/staff/appeals/${appeal.id}/decide`, token: st, payload: { outcome: 'granted', reason: 'Seller provided receipts; buyer was not involved in the fraud.' } });
    const bal2 = await ok(h, { method: 'GET', url: '/wallet/balances', token: ben.token });
    expect(bal2.pairs.find((p: { network: string }) => p.network === 'base').spendable).toBe('325');
  });
});

describe('L2 freelancer invoice on chain', () => {
  let fre: TestUser;
  const clientKey = generatePrivateKey();
  const client = privateKeyToAccount(clientKey).address;
  let invoice: { id: string; slug: string; milestones: Array<{ id: string }> };

  it('creates an invoice with milestones; checkout shows verified name, hold rules and fee', async () => {
    fre = await signup(h, { handle: 'freelancer1' });
    await tier1(h, fre, 'Chioma', 'Nwosu');
    await chain.fund(fre.evm);
    await chain.fund(client);
    await chain.mint(client, parseUnits('2000'));
    const due = new Date(h.clock.now.getTime() + 20 * 86_400_000).toISOString();
    invoice = await ok(h, {
      method: 'POST',
      url: '/invoices',
      token: fre.token,
      payload: { clientEmail: 'client@abroad.com', clientCountry: 'GB', description: 'Website redesign', dueDate: due, milestones: [{ title: 'Design', amount: '400', dueDate: due }, { title: 'Build', amount: '600', dueDate: due }] },
    });
    expect(invoice.milestones).toHaveLength(2);
    const pub = await ok(h, { method: 'GET', url: `/public/invoices/${invoice.slug}` });
    expect(pub.freelancer).toMatchObject({ verifiedName: 'CHIOMA NWOSU', verified: true });
    expect(pub.holdRules.holdDays).toBe(7);
    expect(pub.milestones[0].fee).toBe('4');
    expect(pub.networks.map((n: { network: string }) => n.network)).toEqual(['base']);
    await runner.runOnce(100, h.clock.now); // delivers queued notifications
    const email = await h.ctx.db.query("SELECT body FROM ops.outbox WHERE destination = 'client@abroad.com'");
    expect(email.rows[0].body).toContain(`/checkout/${invoice.slug}`);
    const pdf = await call(h, { method: 'GET', url: `/invoices/${invoice.id}/pdf`, token: fre.token });
    expect(pdf.status).toBe(200);
  });

  it('blocks sanctioned countries at checkout (L2-8)', async () => {
    const r = await call(h, { method: 'POST', url: `/public/invoices/${invoice.slug}/fund`, payload: { milestoneId: invoice.milestones[0]!.id, network: 'base', payerAddress: client, clientCountry: 'IR', confirmRefundToPayer: true } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('sanctioned_country');
  });

  it('funds from an external wallet; the indexer moves it to funded', async () => {
    const f = await ok(h, { method: 'POST', url: `/public/invoices/${invoice.slug}/fund`, payload: { milestoneId: invoice.milestones[0]!.id, network: 'base', payerAddress: client, clientCountry: 'GB', confirmRefundToPayer: true } });
    expect(f.bundle.calls).toHaveLength(2);
    expect(f.bundle.atomic).toBe(true);
    await signBundle(clientKey, f.bundle);
    await index();
    const p = await ok(h, { method: 'GET', url: `/payments/${invoice.milestones[0]!.id}`, token: fre.token });
    expect(p.status).toBe('funded');
    expect(p.escrowAddress).toMatch(/^0x/);
    expect(await usdc(p.escrowAddress)).toBe(parseUnits('400'));
    const replay = await call(h, { method: 'POST', url: `/public/invoices/${invoice.slug}/fund`, payload: { milestoneId: invoice.milestones[0]!.id, network: 'base', payerAddress: client, clientCountry: 'GB', confirmRefundToPayer: true } });
    expect(replay.body.error.code).toBe('not_fundable');
  });

  it('delivery starts the 7-day hold; reminders scheduled; keeper auto-releases; fee pulled to treasury', async () => {
    const id = invoice.milestones[0]!.id;
    const fileId = await upload(fre, 'delivery', 'design.pdf');
    const d = await ok(h, { method: 'POST', url: `/payments/${id}/deliveries`, token: fre.token, payload: { note: 'Designs attached', links: ['https://figma.com/file/abc'], fileIds: [fileId] } });
    await signBundle(fre.key, d.bundle);
    await index();
    const p = await ok(h, { method: 'GET', url: `/payments/${id}`, token: fre.token });
    expect(p.status).toBe('delivered');
    expect(new Date(p.holdUntil).getTime() - new Date(p.times.delivered).getTime()).toBe(7 * 86_400_000);
    const jobs = await h.ctx.db.query("SELECT kind FROM ops.jobs WHERE payload->>'paymentId' = $1 ORDER BY kind", [id]);
    expect(jobs.rows.map((r) => r.kind)).toEqual(['dispute_window_warning', 'keeper_release', 'release_reminder', 'release_reminder']);
    // before the hold ends the keeper does nothing
    await work();
    expect((await ok(h, { method: 'GET', url: `/payments/${id}`, token: fre.token })).status).toBe('delivered');
    const before = await usdc(fre.evm);
    await chain.warp(7 * 86_400 + 5);
    await work();
    await work();
    const after = await ok(h, { method: 'GET', url: `/payments/${id}`, token: fre.token });
    expect(after.status).toBe('released');
    expect((await usdc(fre.evm)) - before).toBe(parseUnits('396'));
    expect(await usdc(treasury)).toBe(parseUnits('4'));
    const row = await h.ctx.db.query('SELECT fee_collected FROM app.payments WHERE id = $1', [id]);
    expect(row.rows[0].fee_collected).toBe(true);
    const reminders = await h.ctx.db.query("SELECT kind FROM app.notifications WHERE email = 'client@abroad.com' ORDER BY created_at");
    expect(reminders.rows.map((r) => r.kind)).toEqual(expect.arrayContaining(['invoice_sent', 'payment_funded', 'payment_delivered', 'release_reminder', 'dispute_window_closing', 'payment_released']));
    // L2-6 receipt, signed and verifiable
    const rc = await h.app.inject({ method: 'GET', url: `/payments/${id}/receipt.pdf`, headers: { authorization: `Bearer ${fre.token}` } });
    expect(rc.statusCode).toBe(200);
    expect(rc.body.slice(0, 5)).toBe('%PDF-');
    const doc = await h.ctx.db.query("SELECT verify_code FROM app.documents WHERE kind = 'receipt' AND subject_id = $1", [id]);
    const v = await ok(h, { method: 'GET', url: `/public/documents/${doc.rows[0].verify_code}` });
    expect(v.signatureValid).toBe(true);
    expect(v.facts.paidToPayee).toBe('396');
  });

  it('C4-5: an unfunded milestone is cancelled after 72 hours with no fee', async () => {
    await work();
    const p = await ok(h, { method: 'GET', url: `/payments/${invoice.milestones[1]!.id}`, token: fre.token });
    expect(p.status).toBe('cancelled');
  });

  it('L2-7: freelancer profile shows completed protected jobs', async () => {
    const prof = await ok(h, { method: 'GET', url: '/public/profiles/freelancer1' });
    expect(prof).toMatchObject({ completedProtectedJobs: 1, disputes: 0, verified: true });
  });
});

describe('L3 trade order with dispute, ruling and 2-of-3 arbiter', () => {
  let director: TestUser;
  let importer: TestUser;
  let supplier: TestUser;
  let paymentId: string;

  it('Tier 2 business creates an order; supplier verifies and accepts the exact terms', async () => {
    director = await signup(h, { handle: 'director1' });
    await tier1(h, director, 'Emeka', 'Obi');
    importer = await fundedUser({ kind: 'business', handle: 'importco' }, '5000');
    companies.register('RC1234567', ['Emeka Obi']);
    await ok(h, { method: 'POST', url: '/identity/business', token: importer.token, payload: { rcNumber: 'RC1234567', address: '12 Broad Street, Lagos Island', directorHandles: ['director1'] } });
    expect((await ok(h, { method: 'GET', url: '/me', token: importer.token })).tier).toBe('tier2');
    const pf = await upload(importer, 'proforma', 'proforma.pdf');
    const order = await ok(h, {
      method: 'POST',
      url: '/orders',
      token: importer.token,
      payload: { supplierEmail: 'sales@supplier.cn', goodsDescription: '200 solar panels', proformaFileId: pf, token: 'USDC', total: '3000', shippingDeadline: new Date(h.clock.now.getTime() + 30 * 86_400_000).toISOString(), split: 'single' },
    });
    expect(order.status).toBe('awaiting_supplier');
    supplier = await signup(h, { kind: 'counterparty', country: 'CN' });
    await h.ctx.db.query("UPDATE app.users SET email = 'sales@supplier.cn' WHERE id = $1", [supplier.id]);
    supplier.email = 'sales@supplier.cn';
    const slug = order.link.split('/').pop();
    const pub = await ok(h, { method: 'GET', url: `/public/orders/${slug}` });
    const noVerify = await call(h, { method: 'POST', url: `/orders/accept/${slug}`, token: supplier.token, payload: { termsSha256: pub.termsSha256 } });
    expect(noVerify.body.error.code).toBe('counterparty_verification');
    await ok(h, { method: 'POST', url: '/identity/counterparty', token: supplier.token, payload: { docType: 'passport', docNumber: 'E12345678', fullName: 'Li Wei', livenessToken: 'ok' } });
    const accepted = await ok(h, { method: 'POST', url: `/orders/accept/${slug}`, token: supplier.token, payload: { termsSha256: pub.termsSha256 } });
    expect(accepted.supplierAccepted).toBe(true);
    paymentId = accepted.payments[0].id;
  });

  it('importer funds; supplier gets a signed proof of funds', async () => {
    await stepUp(h, importer);
    const f = await ok(h, { method: 'POST', url: `/payments/${paymentId}/fund`, token: importer.token, payload: { network: 'base' } });
    await signBundle(importer.key, f.bundle);
    await index();
    const pof = await h.app.inject({ method: 'GET', url: `/payments/${paymentId}/proof-of-funds.pdf`, headers: { authorization: `Bearer ${supplier.token}` } });
    expect(pof.statusCode).toBe(200);
    const doc = await h.ctx.db.query("SELECT verify_code FROM app.documents WHERE kind = 'proof_of_funds' AND subject_id = $1", [paymentId]);
    const v = await ok(h, { method: 'GET', url: `/public/documents/${doc.rows[0].verify_code}` });
    expect(v).toMatchObject({ signatureValid: true, facts: { amount: '3000', importer: 'SANDBOX COMPANY RC1234567' } });
  });

  it('shipping proof with tracking starts the hold; importer disputes before it ends', async () => {
    const noProof = await call(h, { method: 'POST', url: `/payments/${paymentId}/deliveries`, token: supplier.token, payload: { note: 'shipped' } });
    expect(noProof.body.error.code).toBe('shipping_proof');
    const bl = await upload(supplier, 'shipping_document', 'bill-of-lading.pdf');
    const d = await ok(h, { method: 'POST', url: `/payments/${paymentId}/deliveries`, token: supplier.token, payload: { fileIds: [bl], carrier: 'DHL', trackingNumber: '1234567890' } });
    expect(d.trackingValidation).toBe('valid');
    await chain.fund(supplier.evm);
    await signBundle(supplier.key, d.bundle);
    await index();
    const insp = await upload(importer, 'inspection_report', 'inspection.pdf');
    const disp = await ok(h, { method: 'POST', url: `/payments/${paymentId}/disputes`, token: importer.token, payload: { reason: 'Wrong goods', statement: 'We received 200 lead-acid batteries, not solar panels. Inspection attached.', fileIds: [insp] } });
    await signBundle(importer.key, disp.bundle);
    await index();
    const p = await ok(h, { method: 'GET', url: `/payments/${paymentId}`, token: importer.token });
    expect(p.status).toBe('disputed');
    expect(p.dispute.opened_onchain_at).toBeTruthy();
    // both sides add evidence within the window
    await ok(h, { method: 'POST', url: `/disputes/${disp.disputeId}/evidence`, token: supplier.token, payload: { kind: 'statement', body: 'We shipped the panels in the pro forma; photos of loading attached.' } });
  });

  it('reviewer rules; second-review window; two signers approve; the arbiter executes on chain', async () => {
    await addStaff(h, 'rev1@backstop.ng', ['dispute_reviewer']);
    await addStaff(h, 'sig1@backstop.ng', ['arbiter_signer']);
    await addStaff(h, 'sig2@backstop.ng', ['arbiter_signer']);
    const rev = await staffLogin(h, 'rev1@backstop.ng');
    const s1 = await staffLogin(h, 'sig1@backstop.ng');
    const s2 = await staffLogin(h, 'sig2@backstop.ng');
    const list = await ok(h, { method: 'GET', url: '/staff/disputes', token: rev });
    const d = list.disputes.find((x: { payment_id: string }) => x.payment_id === paymentId);
    await ok(h, { method: 'POST', url: `/staff/disputes/${d.id}/claim`, token: rev });
    const ruled = await ok(h, { method: 'POST', url: `/staff/disputes/${d.id}/rule`, token: rev, payload: { ruling: 'refund', reason: 'Inspection report and photos show the goods do not match the pro forma invoice.' } });
    expect(ruled.status).toBe('ruled');
    const early = await call(h, { method: 'POST', url: `/staff/disputes/${d.id}/approve`, token: s1 });
    expect(early.body.error.code).toBe('review_window');
    const reviewerSign = await call(h, { method: 'POST', url: `/staff/disputes/${d.id}/approve`, token: rev });
    expect(reviewerSign.status).toBe(403); // reviewers are not signers
    // The 24h second-review window passes (staff sessions last 10h, so signers sign in again).
    await chain.warp(25 * 3600);
    await sync();
    await keeperSweep(h.ctx);
    const s1b = await staffLogin(h, 'sig1@backstop.ng');
    const s2b = await staffLogin(h, 'sig2@backstop.ng');
    expect((await call(h, { method: 'POST', url: `/staff/disputes/${d.id}/approve`, token: s1 })).status).toBe(401);
    const a1 = await ok(h, { method: 'POST', url: `/staff/disputes/${d.id}/approve`, token: s1b });
    expect(a1).toMatchObject({ approvals: 1, executed: false });
    const dup = await ok(h, { method: 'POST', url: `/staff/disputes/${d.id}/approve`, token: s1b });
    expect(dup.approvals).toBe(1);
    const before = await usdc(importer.evm);
    void s2;
    const a2 = await ok(h, { method: 'POST', url: `/staff/disputes/${d.id}/approve`, token: s2b });
    expect(a2).toMatchObject({ approvals: 2, executed: true });
    await index();
    const p = await ok(h, { method: 'GET', url: `/payments/${paymentId}`, token: importer.token });
    expect(p.status).toBe('refunded');
    expect(p.dispute.ruling).toBe('refund');
    expect((await usdc(importer.evm)) - before).toBe(parseUnits('3000')); // full amount, no fee on refunds
    const dd = await h.ctx.db.query('SELECT status, ruling_hash FROM network.disputes WHERE id = $1', [d.id]);
    expect(dd.rows[0].status).toBe('executed');
    const onchain = await h.ctx.db.query('SELECT last_ruling_hash FROM app.payments WHERE id = $1', [paymentId]);
    expect(onchain.rows[0].last_ruling_hash).toBe(dd.rows[0].ruling_hash);
  });
});

describe('edge cases on chain', () => {
  it('payee listed during the hold: auto-release pauses and goes to review', async () => {
    const fre = await signup(h, { handle: 'freelancer2' });
    await tier1(h, fre, 'Tola', 'Bami');
    const ck = generatePrivateKey();
    const ca = privateKeyToAccount(ck).address;
    await chain.fund(ca);
    await chain.mint(ca, parseUnits('100'));
    await chain.fund(fre.evm);
    const due = new Date(h.clock.now.getTime() + 10 * 86_400_000).toISOString();
    const inv = await ok(h, { method: 'POST', url: '/invoices', token: fre.token, payload: { clientEmail: 'c2@abroad.com', description: 'Logo', dueDate: due, milestones: [{ title: 'Logo', amount: '100', dueDate: due }] } });
    const pid = inv.milestones[0].id;
    const f = await ok(h, { method: 'POST', url: `/public/invoices/${inv.slug}/fund`, payload: { milestoneId: pid, network: 'base', payerAddress: ca, clientCountry: 'US', confirmRefundToPayer: true } });
    await signBundle(ck, f.bundle);
    await index();
    const d = await ok(h, { method: 'POST', url: `/payments/${pid}/deliveries`, token: fre.token, payload: { links: ['https://dribbble.com/x'] } });
    await signBundle(fre.key, d.bundle);
    await index();
    await upsertListing(h.ctx.db, { address: fre.evm, label: 'fraud', source: 'user_report', status: 'reported', now: h.clock.now, expiryMonths: 12 });
    await chain.warp(7 * 86_400 + 5);
    await work();
    const p = await ok(h, { method: 'GET', url: `/payments/${pid}`, token: fre.token });
    expect(p.status).toBe('delivered');
    expect(p.releasePausedReason).toMatch(/reviewed/);
    expect(p.actions).not.toContain('releaseAfterHold');
    const rc = await h.ctx.db.query("SELECT 1 FROM network.review_cases WHERE kind = 'payee_listed_during_hold' AND payment_id = $1", [pid]);
    expect(rc.rowCount).toBe(1);
  });

  it('D1: a payee frozen by the issuer after delivery is refunded by the keeper (UC12)', async () => {
    const fre = await signup(h, { handle: 'freelancer3' });
    await tier1(h, fre, 'Kemi', 'Ade');
    const ck = generatePrivateKey();
    const ca = privateKeyToAccount(ck).address;
    await chain.fund(ca);
    await chain.mint(ca, parseUnits('50'));
    await chain.fund(fre.evm);
    const due = new Date(h.clock.now.getTime() + 10 * 86_400_000).toISOString();
    const inv = await ok(h, { method: 'POST', url: '/invoices', token: fre.token, payload: { clientEmail: 'c3@abroad.com', description: 'Copy', dueDate: due, milestones: [{ title: 'Copy', amount: '50', dueDate: due }] } });
    const pid = inv.milestones[0].id;
    const f = await ok(h, { method: 'POST', url: `/public/invoices/${inv.slug}/fund`, payload: { milestoneId: pid, network: 'base', payerAddress: ca, clientCountry: 'US', confirmRefundToPayer: true } });
    await signBundle(ck, f.bundle);
    await index();
    const d = await ok(h, { method: 'POST', url: `/payments/${pid}/deliveries`, token: fre.token, payload: { links: ['https://docs.example.com/copy'] } });
    await signBundle(fre.key, d.bundle);
    await index();
    await chain.setBlacklisted(fre.evm, true);
    await chain.warp(7 * 86_400 + 5);
    await work();
    await work();
    const p = await ok(h, { method: 'GET', url: `/payments/${pid}`, token: fre.token });
    expect(p.status).toBe('refunded');
    expect(await usdc(ca)).toBe(parseUnits('50'));
  });

  it('L3-5 / UC9: missed deadline lets the payer reclaim without a ruling', async () => {
    const director = await signup(h, { handle: 'director2' });
    await tier1(h, director, 'Ngozi', 'Eke');
    const imp = await fundedUser({ kind: 'business', handle: 'importco2' }, '500');
    companies.register('RC7654321', ['Ngozi Eke']);
    await ok(h, { method: 'POST', url: '/identity/business', token: imp.token, payload: { rcNumber: 'RC7654321', address: '3 Marina Road, Lagos Island', directorHandles: ['director2'] } });
    const pf = await upload(imp, 'proforma');
    const order = await ok(h, { method: 'POST', url: '/orders', token: imp.token, payload: { supplierEmail: 's2@supplier.tr', goodsDescription: 'Textiles', proformaFileId: pf, token: 'USDC', total: '200', shippingDeadline: new Date(h.clock.now.getTime() + 5 * 86_400_000).toISOString(), split: 'single' } });
    const sup = await signup(h, { kind: 'counterparty', country: 'TR' });
    await h.ctx.db.query("UPDATE app.users SET email = 's2@supplier.tr' WHERE id = $1", [sup.id]);
    await ok(h, { method: 'POST', url: '/identity/counterparty', token: sup.token, payload: { docType: 'passport', docNumber: 'U99887766', fullName: 'Ayse Kaya', livenessToken: 'ok' } });
    const slug = order.link.split('/').pop();
    const pub = await ok(h, { method: 'GET', url: `/public/orders/${slug}` });
    const acc = await ok(h, { method: 'POST', url: `/orders/accept/${slug}`, token: sup.token, payload: { termsSha256: pub.termsSha256 } });
    const pid = acc.payments[0].id;
    await stepUp(h, imp);
    const f = await ok(h, { method: 'POST', url: `/payments/${pid}/fund`, token: imp.token, payload: { network: 'base' } });
    await signBundle(imp.key, f.bundle);
    await index();
    const early = await call(h, { method: 'POST', url: `/payments/${pid}/reclaim`, token: imp.token });
    expect(early.body.error.code).toBe('action_not_allowed');
    await chain.warp(5 * 86_400 + 60);
    await sync();
    await stepUp(h, imp);
    const r = await ok(h, { method: 'POST', url: `/payments/${pid}/reclaim`, token: imp.token });
    await signBundle(imp.key, r.bundle);
    await index();
    expect((await ok(h, { method: 'GET', url: `/payments/${pid}`, token: imp.token })).status).toBe('refunded');
    expect(await usdc(imp.evm)).toBe(parseUnits('500'));
  });

  it('indexer behind: escrow funding pauses with a notice; simple sends continue', async () => {
    await h.ctx.db.query("UPDATE ops.indexer_cursors SET updated_at = $1 WHERE network = 'base'", [new Date(h.clock.now.getTime() - 10 * 60_000)]);
    const st = await ok(h, { method: 'GET', url: '/status' });
    expect(st.escrowPaused).toEqual(['base']);
    await index();
    const st2 = await ok(h, { method: 'GET', url: '/status' });
    expect(st2.escrowPaused).toEqual([]);
  });

  it('the audit chain is intact after everything above', async () => {
    await addStaff(h, 'admin@backstop.ng', ['admin']);
    const t = await staffLogin(h, 'admin@backstop.ng');
    const v = await ok(h, { method: 'GET', url: '/staff/audit/verify', token: t });
    expect(v.intact).toBe(true);
    expect(v.total).toBeGreaterThan(50);
  });
});
