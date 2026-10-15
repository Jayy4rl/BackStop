import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hexToTron } from '@backstop/shared';
import { loadConfig } from '../src/config.ts';
import { call, createHarness, demoAccount, lastOtp, ok, signup, stepUp, tier1, tronSign, type Harness } from './helpers/harness.ts';
import { SoftAuthenticator } from './helpers/webauthn.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

describe('C1-1 sign-up with OTPs, passkey and wallet', () => {
  it('creates a verified account with a passkey session and linked wallet', async () => {
    const u = await signup(h, { handle: 'ada' });
    const me = await ok(h, { method: 'GET', url: '/me', token: u.token });
    expect(me.handle).toBe('ada');
    expect(me.tier).toBe('none');
    expect(me.wallet.evmAddress).toBe(u.evm);
    expect(me.wallet.tronAddress).toBe(u.tron);
    expect(me.limits.perTransaction).toBe('0');
    const consent = await h.ctx.db.query('SELECT version FROM app.consents WHERE user_id = $1', [u.id]);
    expect(consent.rows[0].version).toBe('ndpa-2023-v1');
    const audit = await h.ctx.db.query("SELECT action FROM audit.events WHERE subject_id = $1 ORDER BY id", [u.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['signup.started', 'signup.contacts_verified', 'signup.completed']));
  });

  it('rejects a wrong OTP and a duplicate handle', async () => {
    const start = await ok(h, { method: 'POST', url: '/auth/signup/start', payload: { email: 'x1@example.com', phone: '+2348030000001', handle: 'xone', displayName: 'X', consent: { version: 'ndpa-2023-v1', accepted: true } } });
    const bad = await call(h, { method: 'POST', url: '/auth/signup/verify', payload: { signupId: start.signupId, phoneOtpId: start.phoneOtpId, phoneCode: '000000', emailOtpId: start.emailOtpId, emailCode: '000000' } });
    expect(bad.status).toBe(400);
    const dup = await call(h, { method: 'POST', url: '/auth/signup/start', payload: { email: 'other@example.com', phone: '+2348030000002', handle: 'ada', displayName: 'Y', consent: { version: 'ndpa-2023-v1', accepted: true } } });
    expect(dup.status).toBe(409);
  });

  it('requires a wallet ownership signature from both addresses', async () => {
    const start = await ok(h, { method: 'POST', url: '/auth/signup/start', payload: { email: 'w@example.com', phone: '+2348030000009', handle: 'wally', displayName: 'W', consent: { version: 'ndpa-2023-v1', accepted: true } } });
    const v = await ok(h, { method: 'POST', url: '/auth/signup/verify', payload: { signupId: start.signupId, phoneOtpId: start.phoneOtpId, phoneCode: await lastOtp(h, '+2348030000009'), emailOtpId: start.emailOtpId, emailCode: await lastOtp(h, 'w@example.com') } });
    const auth = new SoftAuthenticator('localhost', 'http://localhost:5173');
    const r = await call(h, {
      method: 'POST',
      url: '/auth/signup/finish',
      payload: { challengeId: v.challengeId, credential: auth.register(v.options), deviceFingerprint: 'dev-wally-1', wallet: { provider: 'sandbox', providerWalletId: 'x', evmAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', tronAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', evmSignature: `0x${'11'.repeat(65)}`, tronSignature: `0x${'11'.repeat(65)}` } },
    });
    expect(r.status).toBe(400);
  });
});

describe('C1-2, C1-5 Tier 1 verification', () => {
  it('verifies via BVN + liveness and enforces one account per BVN', async () => {
    const a = await signup(h);
    const b = await signup(h);
    await ok(h, { method: 'POST', url: '/identity/tier1', token: a.token, payload: { idType: 'bvn', idNumber: '22211133344', firstName: 'Bola', lastName: 'Ade', dateOfBirth: '1991-02-03', livenessToken: 'ok' } });
    const me = await ok(h, { method: 'GET', url: '/me', token: a.token });
    expect(me.tier).toBe('tier1');
    expect(me.verifiedName).toBe('BOLA ADE');
    const dup = await call(h, { method: 'POST', url: '/identity/tier1', token: b.token, payload: { idType: 'bvn', idNumber: '22211133344', firstName: 'Bola', lastName: 'Ade', dateOfBirth: '1991-02-03', livenessToken: 'ok' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('id_in_use');
    const live = await call(h, { method: 'POST', url: '/identity/tier1', token: b.token, payload: { idType: 'nin', idNumber: '12345678901', firstName: 'C', lastName: 'D', dateOfBirth: '1991-02-03', livenessToken: 'fail' } });
    expect(live.status).toBe(403);
    // identity payload is encrypted at rest
    const rec = await h.ctx.db.query("SELECT payload_enc FROM app.identity_records WHERE user_id = $1 AND status = 'verified'", [a.id]);
    expect(Buffer.from(rec.rows[0].payload_enc).toString('utf8')).not.toContain('22211133344');
  });

  it('C1-6 screens sanctions at onboarding', async () => {
    const u = await signup(h);
    await ok(h, { method: 'POST', url: '/identity/tier1', token: u.token, payload: { idType: 'nin', idNumber: '55566677788', firstName: 'Sanctioned Test', lastName: 'Person', dateOfBirth: '1980-01-01', livenessToken: 'ok' } });
    const r = await h.ctx.db.query('SELECT sanctions_status FROM app.users WHERE id = $1', [u.id]);
    expect(r.rows[0].sanctions_status).toBe('confirmed_match');
  });
});

describe('sandbox demo accounts ("Launch App")', () => {
  it('creates an account with a linked device wallet and a session, without sign-up', async () => {
    const d = await demoAccount(h);
    const me = await ok(h, { method: 'GET', url: '/me', token: d.token });
    expect(me).toMatchObject({ demo: true, hasPasskey: false, kind: 'individual', tier: 'none', country: 'NG' });
    expect(me.handle).toMatch(/^demo_[0-9a-f]{8}$/);
    expect(me.wallet.evmAddress).toBe(d.evm);
    expect(me.wallet.tronAddress).toBe(d.tron);
    const audit = await h.ctx.db.query('SELECT action FROM audit.events WHERE subject_id = $1 ORDER BY id', [d.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['demo.started', 'demo.created']));
    const cp = await demoAccount(h, 'counterparty');
    expect(await ok(h, { method: 'GET', url: '/me', token: cp.token })).toMatchObject({ demo: true, kind: 'counterparty', tier: 'counterparty', handle: null });
  });

  it('creates the first passkey at the first money confirmation, which counts as the step-up', async () => {
    const d = await demoAccount(h);
    const noPasskey = await call(h, { method: 'POST', url: '/auth/passkeys', token: d.token, payload: {} });
    expect(noPasskey.body.error.code).toBe('passkey_required');
    const o = await ok(h, { method: 'POST', url: '/auth/demo/passkey/options', token: d.token });
    await ok(h, { method: 'POST', url: '/auth/demo/passkey', token: d.token, payload: { challengeId: o.challengeId, credential: d.auth.register(o.options) } });
    const s = await h.ctx.db.query('SELECT last_passkey_at FROM app.sessions WHERE user_id = $1', [d.id]);
    expect(s.rows[0].last_passkey_at).not.toBeNull();
    expect((await ok(h, { method: 'GET', url: '/me', token: d.token })).hasPasskey).toBe(true);
    // Only the first one: later confirmations use the passkey as usual.
    const again = await call(h, { method: 'POST', url: '/auth/demo/passkey/options', token: d.token });
    expect(again.body.error.code).toBe('passkey_exists');
    await stepUp(h, d);
  });

  it('refuses the first-passkey shortcut for real accounts', async () => {
    const u = await signup(h);
    const r = await call(h, { method: 'POST', url: '/auth/demo/passkey/options', token: u.token });
    expect(r.status).toBe(403);
  });

  it('gives a client opened from an invoice link the email the invoice was sent to', async () => {
    const fre = await signup(h);
    await tier1(h, fre);
    const due = new Date(h.clock.now.getTime() + 10 * 86_400_000).toISOString();
    const inv = await ok(h, { method: 'POST', url: '/invoices', token: fre.token, payload: { clientEmail: 'Client@Abroad.com', description: 'Logo', dueDate: due, milestones: [{ title: 'Logo', amount: '100', dueDate: due }] } });
    const first = await demoAccount(h, 'counterparty', { invoiceSlug: inv.slug });
    expect((await ok(h, { method: 'GET', url: '/me', token: first.token })).email).toBe('client@abroad.com');
    // Launching again from the same link hands the email to the new demo account.
    const second = await demoAccount(h, 'counterparty', { invoiceSlug: inv.slug });
    expect((await ok(h, { method: 'GET', url: '/me', token: second.token })).email).toBe('client@abroad.com');
    expect((await ok(h, { method: 'GET', url: '/me', token: first.token })).email).toMatch(/^demo-released-/);
    // A real account's email is never taken over.
    const inv2 = await ok(h, { method: 'POST', url: '/invoices', token: fre.token, payload: { clientEmail: fre.email, description: 'Logo', dueDate: due, milestones: [{ title: 'Logo', amount: '100', dueDate: due }] } });
    const taken = await call(h, { method: 'POST', url: '/auth/demo/start', payload: { kind: 'counterparty', invoiceSlug: inv2.slug } });
    expect(taken.body.error.code).toBe('account_exists');
    expect((await call(h, { method: 'POST', url: '/auth/demo/start', payload: { kind: 'counterparty', orderSlug: 'nope' } })).status).toBe(404);
  });

  it('requires the wallet ownership signatures and a single-use challenge', async () => {
    const start = await ok(h, { method: 'POST', url: '/auth/demo/start', payload: {} });
    const key = generatePrivateKey();
    const acct = privateKeyToAccount(key);
    const tron = hexToTron(acct.address);
    const tmpl: string = start.walletLink.messageTemplate;
    const wallet = { provider: 'sandbox', providerWalletId: 'device:x', evmAddress: acct.address, tronAddress: tron, evmSignature: await acct.signMessage({ message: 'something else' }), tronSignature: await tronSign(key, tmpl.replace('{address}', tron)) };
    const bad = await call(h, { method: 'POST', url: '/auth/demo/finish', payload: { challengeId: start.challengeId, deviceFingerprint: 'demo-device-bad', wallet } });
    expect(bad.body.error.code).toBe('wallet_signature');
    const good = { ...wallet, evmSignature: await acct.signMessage({ message: tmpl.replace('{address}', acct.address) }) };
    await ok(h, { method: 'POST', url: '/auth/demo/finish', payload: { challengeId: start.challengeId, deviceFingerprint: 'demo-device-ok', wallet: good } });
    const replay = await call(h, { method: 'POST', url: '/auth/demo/finish', payload: { challengeId: start.challengeId, deviceFingerprint: 'demo-device-ok', wallet: good } });
    expect(replay.body.error.code).toBe('challenge_invalid');
  });

  it('is unavailable when switched off, and can never be switched on in production', async () => {
    h.ctx.cfg.demoAccounts = false;
    try {
      expect((await call(h, { method: 'POST', url: '/auth/demo/start', payload: {} })).status).toBe(404);
      expect((await ok(h, { method: 'GET', url: '/public/config' })).demoAccounts).toBe(false);
    } finally {
      h.ctx.cfg.demoAccounts = true;
    }
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { NODE_ENV: 'production', DATA_KEY_HEX: 'aa'.repeat(32), LOOKUP_KEY_HEX: 'bb'.repeat(32), DOCUMENT_SIGNING_KEY_HEX: 'cc'.repeat(32) });
      delete process.env.DEMO_ACCOUNTS;
      expect(loadConfig().demoAccounts).toBe(false);
      process.env.DEMO_ACCOUNTS = 'true';
      expect(() => loadConfig()).toThrow(/cannot be enabled in production/);
    } finally {
      process.env = saved;
    }
  });
});

describe('C1-8 re-verification and step-up', () => {
  it('a new device must re-verify before sending', async () => {
    const u = await signup(h);
    await tier1(h, u);
    const opts = await ok(h, { method: 'POST', url: '/auth/login/options', payload: { identifier: u.email } });
    const login = await ok(h, { method: 'POST', url: '/auth/login/finish', payload: { challengeId: opts.challengeId, credential: u.auth.assert(opts.options, u.id), deviceFingerprint: 'brand-new-device' } });
    expect(login.newDevice).toBe(true);
    const u2 = { ...u, token: login.token };
    const prep = await call(h, { method: 'POST', url: '/send/prepare', token: u2.token, payload: { decisionId: '00000000-0000-0000-0000-000000000000', idempotencyKey: 'abcdefgh1' } });
    expect(prep.status).toBe(403);
    expect(prep.body.error.code).toBe('reverify_required');
    const s = await ok(h, { method: 'POST', url: '/auth/reverify/start', token: u2.token });
    await ok(h, { method: 'POST', url: '/auth/reverify/finish', token: u2.token, payload: { otpId: s.otpId, code: await lastOtp(h, u.phone), livenessToken: 'ok' } });
    const after = await call(h, { method: 'POST', url: '/send/prepare', token: u2.token, payload: { decisionId: '00000000-0000-0000-0000-000000000000', idempotencyKey: 'abcdefgh2' } });
    expect(after.body.error.code).toBe('not_found'); // past the guards now
  });

  it('a phone change pauses sends until re-verified', async () => {
    const u = await signup(h);
    const s = await ok(h, { method: 'POST', url: '/me/phone/start', token: u.token, payload: { phone: '+2348099990000' } });
    await ok(h, { method: 'POST', url: '/me/phone/finish', token: u.token, payload: { otpId: s.otpId, code: await lastOtp(h, '+2348099990000') } });
    const me = await ok(h, { method: 'GET', url: '/me', token: u.token });
    expect(me.reverifyRequired).toBe(true);
    expect(me.reverifyReason).toBe('phone_changed');
  });

  it('money movement needs a fresh passkey confirmation', async () => {
    const u = await signup(h);
    await tier1(h, u);
    h.clock.advance(10 * 60_000);
    const r = await call(h, { method: 'POST', url: '/send/prepare', token: u.token, payload: { decisionId: '00000000-0000-0000-0000-000000000000', idempotencyKey: 'abcdefgh3' } });
    expect(r.body.error.code).toBe('passkey_required');
    await stepUp(h, u);
    const r2 = await call(h, { method: 'POST', url: '/send/prepare', token: u.token, payload: { decisionId: '00000000-0000-0000-0000-000000000000', idempotencyKey: 'abcdefgh4' } });
    expect(r2.body.error.code).toBe('not_found');
  });
});

describe('C2-2 recovery', () => {
  it('re-checks identity and locks outgoing transfers for 48 hours', async () => {
    const u = await signup(h);
    await ok(h, { method: 'POST', url: '/identity/tier1', token: u.token, payload: { idType: 'bvn', idNumber: '33344455566', firstName: 'Rec', lastName: 'Over', dateOfBirth: '1990-01-01', livenessToken: 'ok' } });
    const st = await ok(h, { method: 'POST', url: '/auth/recovery/start', payload: { email: u.email, phone: u.phone } });
    const wrong = await call(h, {
      method: 'POST',
      url: '/auth/recovery/verify',
      payload: { recoveryId: st.recoveryId, phoneOtpId: st.phoneOtpId, phoneCode: await lastOtp(h, u.phone), emailOtpId: st.emailOtpId, emailCode: await lastOtp(h, u.email), identity: { idType: 'bvn', idNumber: '99999999999', livenessToken: 'ok' } },
    });
    expect(wrong.status).toBe(403);
    const st2 = await ok(h, { method: 'POST', url: '/auth/recovery/start', payload: { email: u.email, phone: u.phone } });
    const v = await ok(h, {
      method: 'POST',
      url: '/auth/recovery/verify',
      payload: { recoveryId: st2.recoveryId, phoneOtpId: st2.phoneOtpId, phoneCode: await lastOtp(h, u.phone), emailOtpId: st2.emailOtpId, emailCode: await lastOtp(h, u.email), identity: { idType: 'bvn', idNumber: '33344455566', livenessToken: 'ok' } },
    });
    expect(new Date(v.outgoingLockedUntil).getTime() - h.clock.now.getTime()).toBe(48 * 3600_000);
    const auth2 = new SoftAuthenticator('localhost', 'http://localhost:5173');
    const fin = await ok(h, { method: 'POST', url: '/auth/recovery/finish', payload: { challengeId: v.challengeId, credential: auth2.register(v.options), deviceFingerprint: 'recovered-device' } });
    const old = await call(h, { method: 'GET', url: '/me', token: u.token });
    expect(old.status).toBe(401); // lost device's session revoked
    const r = await call(h, { method: 'POST', url: '/send/prepare', token: fin.token, payload: { decisionId: '00000000-0000-0000-0000-000000000000', idempotencyKey: 'abcdefgh5' } });
    expect(r.body.error.code).toBe('recovery_lock');
  });
});

describe('C1-9 account closure and retention', () => {
  it('closes the account, then purges identity data after the retention period', async () => {
    const { keeperSweep } = await import('../src/services/keeper.ts');
    const u = await signup(h);
    await ok(h, { method: 'POST', url: '/identity/tier1', token: u.token, payload: { idType: 'nin', idNumber: '44455566677', firstName: 'Close', lastName: 'Me', dateOfBirth: '1990-01-01', livenessToken: 'ok' } });
    const r = await ok(h, { method: 'POST', url: '/me/close', token: u.token });
    expect(r.identityDataRetainedUntil).toMatch(/^2031-/);
    expect((await call(h, { method: 'GET', url: '/me', token: u.token })).status).toBe(401);
    await keeperSweep(h.ctx);
    const before = await h.ctx.db.query('SELECT length(payload_enc) AS n FROM app.identity_records WHERE user_id = $1', [u.id]);
    expect(Number(before.rows[0].n)).toBeGreaterThan(0);
    const saved = h.clock.now;
    h.clock.set(new Date('2031-12-01T00:00:00Z'));
    await keeperSweep(h.ctx);
    h.clock.set(saved);
    const after = await h.ctx.db.query('SELECT length(payload_enc) AS n, lookup_hmac FROM app.identity_records WHERE user_id = $1', [u.id]);
    expect(Number(after.rows[0].n)).toBe(0);
    expect(after.rows[0].lookup_hmac).toBeNull();
  });
});

describe('audit log', () => {
  it('is append-only', async () => {
    await expect(h.ctx.db.query('DELETE FROM audit.events')).rejects.toThrow(/append-only/);
    await expect(h.ctx.db.query("UPDATE audit.events SET action = 'x'")).rejects.toThrow(/append-only/);
  });
});
