// L4 P2P (TRON, driven through the real indexer handlers with synthetic TRON events since no TRON
// node runs locally), C5 fraud list and appeals, C4-12 fraud rulings, keeper failure fallback.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hexToTron, parseUnits, orderRefFor } from '@backstop/shared';
import { call, createHarness, ok, signup, stepUp, tier1, addStaff, staffLogin, tronSign, type Harness, type TestUser } from './helpers/harness.ts';
import { FakeChain } from './helpers/fakechain.ts';
import { handleEscrowEvent } from '../src/services/indexer.ts';
import { jobHandlers, keeperSweep } from '../src/services/keeper.ts';
import { JobRunner } from '../src/lib/jobs.ts';
import { tx } from '../src/db/pool.ts';
import type { ArbiterExecutor } from '../src/adapters/arbiter.ts';
import type { EscrowEvent } from '../src/chain/types.ts';

const USDT = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
const FACTORY = hexToTron('0x00000000000000000000000000000000000fac70');
const tron = new FakeChain('tron');
const executed: Array<{ escrow: string; ruling: string }> = [];
const arbiter: ArbiterExecutor = {
  name: 'stub',
  async execute(_n, escrow, ruling) {
    executed.push({ escrow, ruling });
    return { status: 'executed', txHash: `0x${'cd'.repeat(32)}` };
  },
};

let h: Harness;
let runner: JobRunner;
let seq = 0;

function ev(name: EscrowEvent['name'], escrow: string, args: Record<string, unknown>): EscrowEvent {
  seq += 1;
  return { name, escrow, txHash: `${seq.toString(16).padStart(64, '0')}`, logIndex: 0, blockNumber: BigInt(1000 + seq), blockTime: h.clock.now, args };
}
async function emit(e: EscrowEvent) {
  await tx(h.ctx.db, (q) => handleEscrowEvent(h.ctx, q, 'tron', e));
}
async function freshIndexer() {
  await h.ctx.db.query(
    "INSERT INTO ops.indexer_cursors (network, stream, last_block, head_block, updated_at) VALUES ('tron','escrow',1,1,$1) ON CONFLICT (network, stream) DO UPDATE SET updated_at = $1",
    [h.clock.now],
  );
}
const fakeEscrow = () => hexToTron(privateKeyToAccount(generatePrivateKey()).address);

beforeAll(async () => {
  h = await createHarness({
    cfg: { chains: { tron: { network: 'tron', rpcUrls: ['http://fake'], tokens: { USDT }, factory: FACTORY, finality: 'solidified', startBlock: 0n } } },
    overrides: { chains: { tron }, arbiter },
  });
  runner = new JobRunner(h.ctx.db, jobHandlers(h.ctx));
});
afterAll(async () => {
  await h?.close();
});

describe('L4 P2P trading', () => {
  let seller: TestUser;
  let buyer: TestUser;
  let sellerBank: string;
  let buyerBank: string;
  let offerId: string;
  let tradeId: string;
  let paymentId: string;
  let escrow: string;

  it('L4-3: bank accounts must be in the verified name', async () => {
    seller = await signup(h, { handle: 'seller1' });
    buyer = await signup(h, { handle: 'buyer1' });
    await tier1(h, seller, 'Sola', 'Ade');
    await tier1(h, buyer, 'Bayo', 'Ola');
    const bad = await call(h, { method: 'POST', url: '/bank-accounts', token: buyer.token, payload: { bankCode: '058', accountNumber: '9912345678' } });
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe('name_mismatch');
    sellerBank = (await ok(h, { method: 'POST', url: '/bank-accounts', token: seller.token, payload: { bankCode: '044', accountNumber: '0123456789' } })).id;
    buyerBank = (await ok(h, { method: 'POST', url: '/bank-accounts', token: buyer.token, payload: { bankCode: '058', accountNumber: '0987654321' } })).id;
    const dup = await call(h, { method: 'POST', url: '/bank-accounts', token: buyer.token, payload: { bankCode: '044', accountNumber: '0123456789' } });
    expect(dup.status).toBe(409);
  });

  it('L4-1/L4-10: offers within platform bounds; offer book shows reputation', async () => {
    const outOfBounds = await call(h, { method: 'POST', url: '/p2p/offers', token: seller.token, payload: { side: 'sell', priceNgn: '1600', min: '10', max: '500', paymentWindowMinutes: 5, bankAccountId: sellerBank } });
    expect(outOfBounds.status).toBe(400);
    const contact = await call(h, { method: 'POST', url: '/p2p/offers', token: seller.token, payload: { side: 'sell', priceNgn: '1600', min: '10', max: '500', bankAccountId: sellerBank, terms: 'call me on 08031234567' } });
    expect(contact.body.error.code).toBe('contact_details');
    offerId = (await ok(h, { method: 'POST', url: '/p2p/offers', token: seller.token, payload: { side: 'sell', priceNgn: '1600.50', min: '10', max: '500', bankAccountId: sellerBank } })).id;
    const book = await ok(h, { method: 'GET', url: '/p2p/offers?side=sell', token: buyer.token });
    expect(book.offers[0]).toMatchObject({ priceNgn: '1600.50', paymentWindowMinutes: 30, feeBps: 50, merchant: { handle: 'seller1', verifiedName: 'SOLA ADE', completedTrades: 0, disputeRate: 0 } });
  });

  it('opens a trade, checks the seller funds, builds TRON escrow calls', async () => {
    await freshIndexer();
    const t = await ok(h, { method: 'POST', url: '/p2p/trades', token: buyer.token, payload: { offerId, amount: '100', bankAccountId: buyerBank } });
    tradeId = t.id;
    paymentId = t.payment.id;
    expect(t).toMatchObject({ role: 'buyer', usdt: '100', naira: '₦160,050.00', seller: { verifiedName: 'SOLA ADE' } });
    expect(t.payment.fee).toBe('0.5');
    tron.balances.set(seller.tron.toLowerCase(), parseUnits('50'));
    await stepUp(h, seller);
    const poor = await call(h, { method: 'POST', url: `/p2p/trades/${tradeId}/fund`, token: seller.token });
    expect(poor.body.error.code).toBe('insufficient_funds');
    tron.balances.set(seller.tron.toLowerCase(), parseUnits('1000'));
    const f = await ok(h, { method: 'POST', url: `/p2p/trades/${tradeId}/fund`, token: seller.token });
    expect(f.bundle).toMatchObject({ network: 'tron', sponsorship: 'tron_energy_sponsored', atomic: false });
    expect(f.bundle.calls.map((c: { functionSelector: string }) => c.functionSelector)).toEqual(['approve(address,uint256)', 'createEscrow((address,address,address,uint256,uint16,uint64,uint32,bool,uint32,bytes32))']);
    escrow = fakeEscrow();
    await emit(ev('EscrowCreated', escrow, { orderRef: orderRefFor(1, paymentId), payer: seller.tron }));
    const after = await ok(h, { method: 'GET', url: `/p2p/trades/${tradeId}`, token: buyer.token });
    expect(after.status).toBe('escrowed');
    expect(after.payTo.accountNumber).toBe('0123456789'); // full number shown to the buyer only once USDT is locked
  });

  it('L4-5: chat blocks outside contact details; they are hidden from the other side', async () => {
    const r = await ok(h, { method: 'POST', url: `/p2p/trades/${tradeId}/messages`, token: buyer.token, payload: { body: 'whatsapp me 0803 555 1234' } });
    expect(r.blocked).toBe(true);
    await ok(h, { method: 'POST', url: `/p2p/trades/${tradeId}/messages`, token: buyer.token, payload: { body: 'Sending the naira now' } });
    const seen = await ok(h, { method: 'GET', url: `/p2p/trades/${tradeId}/messages`, token: seller.token });
    const bodies = seen.messages.filter((m: { from: string }) => m.from === 'them').map((m: { body: string }) => m.body);
    expect(bodies).toEqual(['[message blocked]', 'Sending the naira now']);
  });

  it('buyer marks paid (UC2), seller confirms (UC3), both get a signed trade record', async () => {
    const paid = await ok(h, { method: 'POST', url: `/p2p/trades/${tradeId}/paid`, token: buyer.token, payload: { fromOwnAccount: true, reference: 'NIP-778' } });
    expect(paid.bundle.calls[0].functionSelector).toBe('markDelivered(bytes32)');
    await emit(ev('Delivered', escrow, { holdUntil: 0n, evidenceHash: '0x' }));
    expect((await ok(h, { method: 'GET', url: `/p2p/trades/${tradeId}`, token: seller.token })).status).toBe('paid');
    await stepUp(h, seller);
    const conf = await ok(h, { method: 'POST', url: `/p2p/trades/${tradeId}/confirm`, token: seller.token, payload: { receivedFromBuyerAccount: true } });
    expect(conf.bundle.calls[0].functionSelector).toBe('release()');
    await emit(ev('Released', escrow, { toPayee: parseUnits('99.5'), feeOwed: parseUnits('0.5'), rulingHash: `0x${'0'.repeat(64)}` }));
    const done = await ok(h, { method: 'GET', url: `/p2p/trades/${tradeId}`, token: buyer.token });
    expect(done.status).toBe('released');
    const pdf = await h.app.inject({ method: 'GET', url: `/p2p/trades/${tradeId}/record.pdf`, headers: { authorization: `Bearer ${seller.token}` } });
    expect(pdf.statusCode).toBe(200);
    const doc = await h.ctx.db.query("SELECT verify_code FROM app.documents WHERE kind = 'trade_record' AND subject_id = $1", [tradeId]);
    const v = await ok(h, { method: 'GET', url: `/public/documents/${doc.rows[0].verify_code}` });
    expect(v.signatureValid).toBe(true);
    expect(v.facts.seller).toMatchObject({ name: 'SOLA ADE', nameMatch: 'exact' });
    expect(v.facts.naira).toBe('₦160,050.00');
    const fee = await h.ctx.db.query("SELECT kind FROM ops.jobs WHERE kind = 'keeper_collect_fee' AND payload->>'paymentId' = $1", [paymentId]);
    expect(fee.rowCount).toBe(1);
  });

  it('L4-6: the payment window expires -> trade cancelled, seller prompted to reclaim', async () => {
    await freshIndexer();
    const t = await ok(h, { method: 'POST', url: '/p2p/trades', token: buyer.token, payload: { offerId, amount: '20', bankAccountId: buyerBank } });
    await stepUp(h, seller);
    await ok(h, { method: 'POST', url: `/p2p/trades/${t.id}/fund`, token: seller.token });
    await emit(ev('EscrowCreated', fakeEscrow(), { orderRef: orderRefFor(1, t.payment.id), payer: seller.tron }));
    h.clock.advance(32 * 60_000);
    await keeperSweep(h.ctx);
    const after = await ok(h, { method: 'GET', url: `/p2p/trades/${t.id}`, token: seller.token });
    expect(after.status).toBe('cancelled');
    expect(after.payment.actions).toContain('reclaimAfterDeadline');
    const n = await h.ctx.db.query("SELECT 1 FROM app.notifications WHERE user_id = $1 AND kind = 'p2p_trade_expired'", [seller.id]);
    expect(n.rowCount).toBe(1);
  });

  it('third-party naira: dispute with chat log evidence, buyer reviewed; ruling finds fraud -> C5 listing (C4-12)', async () => {
    await freshIndexer();
    const t = await ok(h, { method: 'POST', url: '/p2p/trades', token: buyer.token, payload: { offerId, amount: '30', bankAccountId: buyerBank } });
    await stepUp(h, seller);
    await ok(h, { method: 'POST', url: `/p2p/trades/${t.id}/fund`, token: seller.token });
    const esc = fakeEscrow();
    await emit(ev('EscrowCreated', esc, { orderRef: orderRefFor(1, t.payment.id), payer: seller.tron }));
    await ok(h, { method: 'POST', url: `/p2p/trades/${t.id}/paid`, token: buyer.token, payload: { fromOwnAccount: true } });
    await emit(ev('Delivered', esc, { holdUntil: 0n, evidenceHash: '0x' }));
    const d = await ok(h, { method: 'POST', url: `/p2p/trades/${t.id}/dispute`, token: seller.token, payload: { reason: 'third_party_payment', statement: 'The naira came from a stranger named Musa, not the buyer.' } });
    await emit(ev('Disputed', esc, { by: seller.tron, evidenceHash: d.bundle.calls[0].parameter }));
    const ev2 = await h.ctx.db.query("SELECT kind FROM network.dispute_evidence WHERE dispute_id = $1", [d.disputeId]);
    expect(ev2.rows.map((r) => r.kind)).toEqual(expect.arrayContaining(['statement', 'chat_log', 'delivery']));
    const rc = await h.ctx.db.query("SELECT 1 FROM network.review_cases WHERE kind = 'p2p_naira_fraud' AND user_id = $1", [buyer.id]);
    expect(rc.rowCount).toBe(1);
    const disp = await h.ctx.db.query('SELECT evidence_due_at, opened_onchain_at FROM network.disputes WHERE id = $1', [d.disputeId]);
    expect(new Date(disp.rows[0].evidence_due_at).getTime() - new Date(disp.rows[0].opened_onchain_at).getTime()).toBe(2 * 3600_000); // L4: 2 hours
    await addStaff(h, 'rev@b.ng', ['dispute_reviewer']);
    await addStaff(h, 'rev2@b.ng', ['dispute_reviewer']);
    await addStaff(h, 'signer1@b.ng', ['arbiter_signer']);
    await addStaff(h, 'signer2@b.ng', ['arbiter_signer']);
    const rev = await staffLogin(h, 'rev@b.ng');
    await ok(h, { method: 'POST', url: `/staff/disputes/${d.disputeId}/rule`, token: rev, payload: { ruling: 'refund', reason: 'Bank evidence shows the naira came from a third party, not the buyer.', fraudFound: true, fraudParty: 'payee' } });
    const listing = await h.ctx.db.query("SELECT status, source FROM network.listings WHERE address = $1", [buyer.tron]);
    expect(listing.rows[0]).toMatchObject({ status: 'confirmed', source: 'dispute_ruling' });
    // C4-9 second review requested by the buyer, decided by a different reviewer
    await ok(h, { method: 'POST', url: `/disputes/${d.disputeId}/second-review`, token: buyer.token });
    const again = await call(h, { method: 'POST', url: `/disputes/${d.disputeId}/second-review`, token: buyer.token });
    expect(again.status).toBe(409);
    const same = await call(h, { method: 'POST', url: `/staff/disputes/${d.disputeId}/rule`, token: rev, payload: { ruling: 'release', reason: 'Trying to rule again as the same reviewer here.' } });
    expect(same.status).toBe(403);
    const rev2 = await staffLogin(h, 'rev2@b.ng');
    const final = await ok(h, { method: 'POST', url: `/staff/disputes/${d.disputeId}/rule`, token: rev2, payload: { ruling: 'refund', reason: 'Second review agrees: third-party payment confirmed by bank statement.', fraudFound: true, fraudParty: 'payee' } });
    expect(final.status).toBe('awaiting_signatures');
    const s1 = await staffLogin(h, 'signer1@b.ng');
    const s2 = await staffLogin(h, 'signer2@b.ng');
    await ok(h, { method: 'POST', url: `/staff/disputes/${d.disputeId}/approve`, token: s1 });
    const done = await ok(h, { method: 'POST', url: `/staff/disputes/${d.disputeId}/approve`, token: s2 });
    expect(done.executed).toBe(true);
    expect(executed.at(-1)).toEqual({ escrow: esc, ruling: 'refund' });
  });

  it('L4-9: a user over the daily cancellation limit cannot open new trades', async () => {
    const b2 = await signup(h, { handle: 'buyer2' });
    await tier1(h, b2, 'Kola', 'Bello');
    const bank = (await ok(h, { method: 'POST', url: '/bank-accounts', token: b2.token, payload: { bankCode: '057', accountNumber: '0555666777' } })).id;
    for (let i = 0; i < 3; i++) {
      const t = await ok(h, { method: 'POST', url: '/p2p/trades', token: b2.token, payload: { offerId, amount: '10', bankAccountId: bank } });
      await ok(h, { method: 'POST', url: `/p2p/trades/${t.id}/cancel`, token: b2.token, payload: { reason: 'changed my mind' } });
    }
    const r = await call(h, { method: 'POST', url: '/p2p/trades', token: b2.token, payload: { offerId, amount: '10', bankAccountId: bank } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('cancellation_limit');
  });

  it('G2 gate: P2P is off unless enabled', async () => {
    h.ctx.cfg.p2pEnabled = false;
    const r = await call(h, { method: 'GET', url: '/p2p/offers', token: buyer.token });
    h.ctx.cfg.p2pEnabled = true;
    expect(r.body.error.code).toBe('p2p_unavailable');
  });
});

describe('C5 fraud list and appeals', () => {
  let reporter: TestUser;
  let analystA: string;
  let analystB: string;
  const suspectKey = generatePrivateKey();
  const suspect = privateKeyToAccount(suspectKey).address;

  it('C5-1/C5-2: a report opens a case; confirmation needs the standard and a second analyst above the threshold', async () => {
    reporter = await signup(h, { handle: 'reporter1' });
    await tier1(h, reporter, 'Rita', 'Uche');
    const r = await ok(h, { method: 'POST', url: '/fraud-reports', token: reporter.token, payload: { caseType: 'scam', suspectAddresses: [suspect], txHashes: ['0xabc0000000000000000000000000000000000000000000000000000000000001'], amount: '15000', statement: 'Paid for a car that never arrived; seller vanished after payment.' } });
    expect(r.status).toBe('received');
    await addStaff(h, 'ana@b.ng', ['risk_analyst']);
    await addStaff(h, 'anb@b.ng', ['risk_analyst']);
    analystA = await staffLogin(h, 'ana@b.ng');
    analystB = await staffLogin(h, 'anb@b.ng');
    const cases = await ok(h, { method: 'GET', url: '/staff/cases', token: analystA });
    const c = cases.cases.find((x: { address: string }) => x.address === suspect);
    const detail = await ok(h, { method: 'GET', url: `/staff/cases/${c.id}`, token: analystA });
    expect(detail.reporterHistory[0]).toMatchObject({ handle: 'reporter1', tier: 'tier1' });
    const noTrail = await call(h, { method: 'POST', url: `/staff/cases/${c.id}/decide`, token: analystA, payload: { decision: 'confirm', reasonCode: 'onchain_trail_confirmed', reason: 'Report looks credible to me.' } });
    expect(noTrail.status).toBe(400);
    const first = await ok(h, { method: 'POST', url: `/staff/cases/${c.id}/decide`, token: analystA, payload: { decision: 'confirm', reasonCode: 'onchain_trail_confirmed', reason: 'Funds traced from reporter to this address.', onchainTrailConfirmed: true } });
    expect(first.status).toBe('awaiting_second');
    const self = await call(h, { method: 'POST', url: `/staff/cases/${c.id}/decide`, token: analystA, payload: { decision: 'confirm', reasonCode: 'onchain_trail_confirmed', reason: 'Confirming again myself.', onchainTrailConfirmed: true } });
    expect(self.status).toBe(403);
    const second = await ok(h, { method: 'POST', url: `/staff/cases/${c.id}/decide`, token: analystB, payload: { decision: 'confirm', reasonCode: 'onchain_trail_confirmed', reason: 'Agree: direct on-chain trail and verified reporter.', onchainTrailConfirmed: true } });
    expect(second.status).toBe('confirmed');
    const pub = await ok(h, { method: 'GET', url: `/public/listings/${suspect}` });
    expect(pub).toMatchObject({ listed: true, listings: [{ status: 'confirmed', caseType: 'fraud' }] });
    expect(JSON.stringify(pub)).not.toContain('reporter');
    const l = await h.ctx.db.query('SELECT expires_at, confirmed_at FROM network.listings WHERE address = $1', [suspect]);
    expect(new Date(l.rows[0].expires_at).getUTCFullYear()).toBe(new Date(l.rows[0].confirmed_at).getUTCFullYear() + 1);
  });

  it('public appeal: prove control (EIP-191), listing shows under_appeal, reporter notified, status page hides reporter', async () => {
    const noCaptcha = await call(h, { method: 'POST', url: '/public/appeals/challenge', payload: { address: suspect } });
    expect(noCaptcha.status).toBe(403);
    const ch = await ok(h, { method: 'POST', url: '/public/appeals/challenge', payload: { address: suspect, captchaToken: 'sandbox-pass' } });
    const wrongKey = privateKeyToAccount(generatePrivateKey());
    const forged = await call(h, { method: 'POST', url: '/public/appeals', payload: { challengeId: ch.challengeId, signature: await wrongKey.signMessage({ message: ch.message }), email: 'me@x.com', statement: 'This is my exchange deposit address; I am not a scammer.', captchaToken: 'sandbox-pass' } });
    expect(forged.status).toBe(403);
    const ch2 = await ok(h, { method: 'POST', url: '/public/appeals/challenge', payload: { address: suspect, captchaToken: 'sandbox-pass' } });
    const sig = await privateKeyToAccount(suspectKey).signMessage({ message: ch2.message });
    const ap = await ok(h, { method: 'POST', url: '/public/appeals', payload: { challengeId: ch2.challengeId, signature: sig, email: 'owner@x.com', statement: 'I sold the car; the buyer refused delivery. Shipping documents attached later.', captchaToken: 'sandbox-pass' } });
    const status = await ok(h, { method: 'GET', url: `/public/appeals/${ap.reference}` });
    expect(status).toMatchObject({ status: 'open', caseType: 'fraud', listingStatus: 'under_appeal' });
    expect(Object.keys(status)).not.toContain('reporter');
    const n = await h.ctx.db.query("SELECT 1 FROM app.notifications WHERE user_id = $1 AND kind = 'appeal_reporter'", [reporter.id]);
    expect(n.rowCount).toBe(1);
    // the checks now warn (under review / appeal) rather than block
    const q = await ok(h, { method: 'POST', url: '/send/quote', token: reporter.token, payload: { recipient: suspect, token: 'USDT', amount: '1', network: 'ethereum', networkConfirmed: true } });
    expect(q.check.reasons.map((r: { code: string }) => r.code)).toContain('recipient_under_review');
    // step 4: an analyst who confirmed the listing cannot decide; another can
    const list = await ok(h, { method: 'GET', url: '/staff/appeals', token: analystA });
    const a = list.appeals.find((x: { public_ref: string }) => x.public_ref === ap.reference);
    const conflicted = await call(h, { method: 'POST', url: `/staff/appeals/${a.id}/decide`, token: analystA, payload: { outcome: 'granted', reason: 'Evidence shows the sale was genuine.' } });
    expect(conflicted.body.error.code).toBe('conflict_of_interest');
    await addStaff(h, 'anc@b.ng', ['risk_analyst']);
    const analystC = await staffLogin(h, 'anc@b.ng');
    await ok(h, { method: 'POST', url: `/staff/appeals/${a.id}/decide`, token: analystC, payload: { outcome: 'upheld', reason: 'No delivery evidence was supplied.' } });
    expect((await ok(h, { method: 'GET', url: `/public/listings/${suspect}` })).listings[0].status).toBe('confirmed');
    // upheld: may appeal again after 90 days or with new evidence
    const ch3 = await ok(h, { method: 'POST', url: '/public/appeals/challenge', payload: { address: suspect, captchaToken: 'sandbox-pass' } });
    const again = await call(h, { method: 'POST', url: '/public/appeals', payload: { challengeId: ch3.challengeId, signature: await privateKeyToAccount(suspectKey).signMessage({ message: ch3.message }), email: 'owner@x.com', statement: 'Please look again at my case, it is wrong.', captchaToken: 'sandbox-pass' } });
    expect(again.body.error.code).toBe('appeal_cooldown');
  });

  it('TRON appeal signatures (signMessageV2) are accepted; granted appeals delist and re-check holds', async () => {
    const key = generatePrivateKey();
    const addr = hexToTron(privateKeyToAccount(key).address);
    await addStaff(h, 'and@b.ng', ['risk_analyst']);
    const analystD = await staffLogin(h, 'and@b.ng');
    await ok(h, { method: 'POST', url: '/staff/listings', token: analystD, payload: { address: addr, label: 'fraud', source: 'user_report', status: 'confirmed', reason: 'Law enforcement reference LE-2026-77.' } });
    // a user who received from it is on hold
    const victim = await signup(h, { handle: 'victim1' });
    await h.ctx.db.query(
      "INSERT INTO app.transfers (user_id, direction, network, token, token_contract, amount_units, from_address, to_address, status, availability, final_at) VALUES ($1,'in','tron','USDT',$2,$3,$4,$5,'final','on_hold',now())",
      [victim.id, USDT, parseUnits('40').toString(), addr, victim.tron],
    );
    const ch = await ok(h, { method: 'POST', url: '/public/appeals/challenge', payload: { address: addr, captchaToken: 'sandbox-pass' } });
    expect(ch.family).toBe('tron');
    const ap = await ok(h, { method: 'POST', url: '/public/appeals', payload: { challengeId: ch.challengeId, signature: await tronSign(key, ch.message), email: 'tron@x.com', statement: 'This is a merchant wallet; the listing came from a mistaken report.', captchaToken: 'sandbox-pass' } });
    const list = await ok(h, { method: 'GET', url: '/staff/appeals', token: analystB });
    const a = list.appeals.find((x: { public_ref: string }) => x.public_ref === ap.reference);
    await ok(h, { method: 'POST', url: `/staff/appeals/${a.id}/decide`, token: analystB, payload: { outcome: 'granted', reason: 'Merchant records show legitimate sales.' } });
    expect((await ok(h, { method: 'GET', url: `/public/appeals/${ap.reference}` })).status).toBe('granted');
    expect((await ok(h, { method: 'GET', url: `/public/listings/${addr}` })).listed).toBe(false);
    const t = await h.ctx.db.query('SELECT availability FROM app.transfers WHERE user_id = $1', [victim.id]);
    expect(t.rows[0].availability).toBe('available');
  });

  it('C5-9: confirmed listings expire after 12 months', async () => {
    h.clock.advance(366 * 86_400_000);
    await keeperSweep(h.ctx);
    const r = await h.ctx.db.query("SELECT status FROM network.listings WHERE address = $1 AND label = 'fraud'", [suspect]);
    expect(r.rows[0].status).toBe('expired');
    h.clock.advance(-366 * 86_400_000);
  });
});

describe('keeper reliability', () => {
  it('after repeated failures the payee gets a release button and staff are alerted', async () => {
    const payee = await signup(h, { handle: 'payeek' });
    await tier1(h, payee, 'Kunle', 'Ojo');
    const payer = await signup(h, { handle: 'payerk' });
    await tier1(h, payer, 'Pat', 'Eze');
    const p = await h.ctx.db.query(
      `INSERT INTO app.payments (loop, title, payer_user_id, payee_user_id, payee_address, network, token, amount_units, fee_bps, fee_units, fee_schedule_version, deliver_by, hold_period_seconds, auto_release, arbiter_timeout_seconds, order_ref, escrow_address, status, funding_deadline, delivered_at, hold_until)
       VALUES ('L2','Keeper test',$1,$2,$3,'tron','USDT',1000000,100,10000,'v',$4,604800,true,2592000,$5,$6,'delivered',$4,$4,$4) RETURNING id`,
      [payer.id, payee.id, payee.tron, h.clock.now, `0x${'77'.repeat(32)}`, fakeEscrow()],
    );
    tron.failCalls = true;
    for (let i = 0; i < 3; i++) {
      await keeperSweep(h.ctx);
      await h.ctx.db.query("UPDATE ops.jobs SET run_at = '1970-01-01', locked_until = NULL WHERE kind = 'keeper_release'");
      await runner.runOnce(50, h.clock.now);
    }
    tron.failCalls = false;
    const n = await h.ctx.db.query("SELECT 1 FROM app.notifications WHERE user_id = $1 AND kind = 'keeper_fallback'", [payee.id]);
    expect(n.rowCount).toBe(1);
    const rc = await h.ctx.db.query("SELECT 1 FROM network.review_cases WHERE kind = 'keeper_failure' AND payment_id = $1", [p.rows[0].id]);
    expect(rc.rowCount).toBe(1);
    const view = await ok(h, { method: 'GET', url: `/payments/${p.rows[0].id}`, token: payee.token });
    expect(view.actions).toContain('releaseAfterHold');
    const b = await ok(h, { method: 'POST', url: `/payments/${p.rows[0].id}/release-after-hold`, token: payee.token });
    expect(b.bundle.calls[0].functionSelector).toBe('releaseAfterHold()');
  });
});
