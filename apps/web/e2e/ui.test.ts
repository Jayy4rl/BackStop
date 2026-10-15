// Browser end-to-end: real Chromium with a virtual WebAuthn authenticator, the Vite app, the real
// API over HTTP, and anvil running the real contracts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import * as OTPAuth from 'otpauth';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseUnits } from '@backstop/shared';
import { createHarness, type Harness } from '../../../services/api/test/helpers/harness.ts';
import { KEYS, startAnvil, type Anvil } from '../../../services/api/test/helpers/anvil.ts';
import { indexAll } from '../../../services/api/src/services/indexer.ts';
import { JobRunner } from '../../../services/api/src/lib/jobs.ts';
import { jobHandlers } from '../../../services/api/src/services/keeper.ts';

const API_PORT = 4100 + Math.floor(Math.random() * 400);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let chain: Anvil;
let h: Harness;
let vite: ViteDevServer;
let browser: Browser;

async function index() {
  h.clock.set(new Date());
  await indexAll(h.ctx);
  await new JobRunner(h.ctx.db, jobHandlers(h.ctx)).runOnce(100, new Date());
}

async function newUserContext(): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: 'http://localhost:5173', permissions: ['camera', 'clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  return { ctx, page };
}

/** Landing page -> "Launch App" -> Home with a demo account. Returns the account's @handle. */
async function launchApp(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('heading', { name: 'Pay anyone. Get what you paid for.' }).waitFor();
  await page.getByRole('button', { name: 'Launch App' }).click();
  await page.getByRole('heading', { name: /^Hello/ }).waitFor({ timeout: 20_000 }).catch(async (e) => {
    throw new Error(`${(e as Error).message}\nPAGE: ${await page.locator('body').innerText()}`);
  });
  const handle = (await page.locator('aside strong').first().textContent())!.trim();
  expect(handle).toMatch(/^@demo_[0-9a-f]{8}$/);
  await page.goto('/verify-identity');
  return handle;
}

async function verifyTier1(page: Page, id: string, first: string, last: string) {
  await page.getByLabel('Number', { exact: true }).fill(id);
  await page.getByLabel('First name').fill(first);
  await page.getByLabel('Last name').fill(last);
  await page.getByLabel('Date of birth').fill('1990-05-05');
  await page.getByRole('button', { name: 'Start selfie check' }).click();
  await page.getByRole('button', { name: /I'm looking at the camera|Continue \(sandbox\)/ }).click();
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await page.getByText("You're verified.").waitFor();
}

beforeAll(async () => {
  chain = await startAnvil();
  h = await createHarness({
    cfg: {
      chains: { base: { network: 'base', rpcUrls: [chain.url], chainId: 31337, factory: chain.factory, tokens: { USDC: chain.usdc }, finality: 'latest', startBlock: await chain.pub.getBlockNumber(), keeperKey: KEYS.keeper } },
      arbiterExecutorKey: KEYS.arbiter,
    },
  });
  // The UI runs on real time.
  h.clock.set(new Date());
  (h.ctx as { now: () => Date }).now = () => new Date();
  await h.app.listen({ port: API_PORT, host: '127.0.0.1' });
  vite = await createServer({
    root,
    configFile: false,
    plugins: [react()],
    logLevel: 'error',
    server: { port: 5173, strictPort: true, proxy: { '/api': { target: `http://127.0.0.1:${API_PORT}`, rewrite: (p: string) => p.replace(/^\/api/, '') } } },
  });
  await vite.listen();
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  await index();
});

afterAll(async () => {
  await browser?.close();
  await vite?.close();
  await h?.close();
  chain?.stop();
});

describe('web app end to end', () => {
  let ada: Page;
  let ben: Page;
  let adaHandle: string;
  let benHandle: string;
  const passkeys = async (handle: string) =>
    Number((await h.ctx.db.query('SELECT count(*) FROM app.passkeys p JOIN app.users u ON u.id = p.user_id WHERE u.handle = $1', [handle.slice(1)])).rows[0].count);

  it('opens the app from the landing page with a demo account and device wallet, then verifies Tier 1', async () => {
    ada = (await newUserContext()).page;
    adaHandle = await launchApp(ada);
    await verifyTier1(ada, '21212121212', 'Ada', 'Uche');
    const me = await h.ctx.db.query('SELECT u.demo, u.tier, u.verified_name, w.evm_address FROM app.users u JOIN app.wallets w ON w.user_id = u.id WHERE u.handle = $1', [adaHandle.slice(1)]);
    expect(me.rows[0]).toMatchObject({ demo: true, tier: 'tier1', verified_name: 'ADA UCHE' });
    // The passkey is created at the first payment confirmation, not at launch.
    expect(await passkeys(adaHandle)).toBe(0);
  });

  it('keeps the old sign-in links working: they land on the landing page', async () => {
    const { page } = await newUserContext();
    for (const p of ['/signup', '/signin', '/welcome?next=/send', '/history']) {
      await page.goto(p);
      await page.getByRole('button', { name: 'Launch App' }).waitFor();
    }
    expect(new URL(page.url()).searchParams.get('next')).toBe('/history');
    await page.context().close();
  });

  it('shows the receive address with the one-token warning, then the deposit on Home', async () => {
    await ada.goto('/receive');
    await ada.getByRole('radio', { name: 'USDC on Base' }).click();
    await expect(ada.getByText('Do not send USDT or any other token here.')).toBeTruthy();
    const address = (await ada.locator('code').first().textContent())!.trim();
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    await chain.fund(address as `0x${string}`);
    await chain.mint(address as `0x${string}`, parseUnits('100'));
    await index();
    await ada.goto('/');
    await ada.getByText('Total balance').waitFor();
    await expect.poll(async () => ada.locator('.big').first().textContent()).toContain('$100.00');
  });

  it('sends to another user through the UI: check, passkey, device signature, final on chain', async () => {
    ben = (await newUserContext()).page;
    benHandle = await launchApp(ben);
    await verifyTier1(ben, '23232323232', 'Ben', 'Okoro');
    await ada.goto('/send');
    await ada.getByLabel('Who are you paying?').fill(benHandle);
    await ada.getByRole('button', { name: 'Continue' }).click();
    await ada.getByLabel('Token').selectOption('USDC');
    await ada.getByLabel('Amount in dollars').fill('25');
    await ada.getByLabel('Their name (optional)').fill('Ben Okoro');
    await ada.getByRole('button', { name: 'Review' }).click();
    await ada.getByText('Safety check').waitFor();
    await ada.getByRole('button', { name: 'Confirm and send' }).click();
    await ada.getByRole('heading', { name: 'Sent' }).waitFor({ timeout: 60_000 });
    await index();
    await ben.goto('/');
    await expect.poll(async () => ben.locator('.big').first().textContent(), { timeout: 20_000 }).toContain('$25.00');
    await ada.goto('/history');
    await ada.getByText(`To ${benHandle}`).waitFor();
    const t = await h.ctx.db.query("SELECT t.status FROM app.transfers t JOIN app.users u ON u.id = t.user_id WHERE u.handle = $1 AND t.direction = 'out'", [adaHandle.slice(1)]);
    expect(t.rows[0].status).toBe('final');
    // The first confirmation created Ada's passkey on this device.
    expect(await passkeys(adaHandle)).toBe(1);
  });

  it('shows a blocking warning for a confirmed-fraud address and no send button', async () => {
    const { upsertListing } = await import('../../../services/api/src/services/fraudlist.ts');
    const bad = '0x000000000000000000000000000000000000dEaD';
    await upsertListing(h.ctx.db, { address: bad, label: 'fraud', source: 'user_report', status: 'confirmed', now: new Date(), expiryMonths: 12 });
    await ada.goto('/send');
    await ada.getByLabel('Who are you paying?').fill(bad);
    await ada.getByRole('button', { name: 'Continue' }).click();
    await ada.getByLabel('Token').selectOption('USDC');
    await ada.getByLabel('Network the recipient expects').selectOption('base');
    await ada.getByRole('checkbox').check();
    await ada.getByLabel('Amount in dollars').fill('5');
    await ada.getByRole('button', { name: 'Review' }).click();
    await ada.getByRole('dialog').getByText('This address is on the fraud list').waitFor();
    await ada.getByRole('dialog').getByRole('button', { name: 'OK' }).click();
    await ada.getByText("This payment can't be sent").waitFor();
    expect(await ada.getByRole('button', { name: 'Confirm and send' }).count()).toBe(0);
  });

  it('L2: freelancer invoices in the UI; the client pays at the web checkout with an external wallet', async () => {
    await ada.goto('/invoices/new');
    await ada.getByLabel('Client email').fill('client@abroad.com');
    await ada.getByLabel('What is the work?').fill('Mobile app UI');
    await ada.getByLabel('Title').fill('Screens');
    await ada.getByLabel('Amount ($)').fill('40');
    await ada.getByRole('button', { name: 'Send invoice' }).click();
    await ada.getByRole('heading', { name: 'Mobile app UI' }).waitFor();
    const link = (await ada.locator('code').first().textContent())!.trim();
    const slug = link.split('/').pop()!;

    // Client with an injected EIP-1193 wallet (backed by a real key on the local chain).
    const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
    const { createWalletClient, http } = await import('viem');
    const key = generatePrivateKey();
    const acct = privateKeyToAccount(key);
    await chain.fund(acct.address);
    await chain.mint(acct.address, parseUnits('100'));
    const wallet = createWalletClient({ chain: chain.chain, transport: http(chain.url), account: acct });
    const { ctx: cctx, page: client } = await newUserContext();
    await client.exposeFunction('bsWallet', async (method: string, params: any[]) => {
      if (method === 'eth_requestAccounts') return [acct.address];
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'eth_sendTransaction') {
        const hash = await wallet.sendTransaction({ to: params[0].to, data: params[0].data });
        await chain.pub.waitForTransactionReceipt({ hash });
        return hash;
      }
      throw new Error(`unsupported ${method}`);
    });
    await client.addInitScript(() => {
      (window as any).ethereum = { request: ({ method, params }: { method: string; params?: unknown[] }) => (window as any).bsWallet(method, params ?? []) };
    });
    await client.goto(`/checkout/${slug}`);
    await client.getByText('ADA UCHE').waitFor();
    await client.getByText(/held in escrow/).first().waitFor();
    await client.getByLabel('Your country (2-letter code)').fill('GB');
    await client.getByRole('checkbox').check();
    await client.getByRole('button', { name: 'Pay into escrow' }).click();
    await client.getByText('Submitted:').waitFor({ timeout: 30_000 });
    await index();
    await client.reload();
    await client.getByText('Held in escrow', { exact: true }).waitFor();
    await ada.reload();
    await ada.getByText('Held in escrow').first().waitFor();
    const p = await h.ctx.db.query("SELECT p.status, p.escrow_address FROM app.payments p JOIN app.invoices i ON i.id = p.invoice_id WHERE i.slug = $1", [slug]);
    expect(p.rows[0].status).toBe('funded');
    expect(await chain.pub.readContract({ address: chain.usdc, abi: (await import('viem')).erc20Abi, functionName: 'balanceOf', args: [p.rows[0].escrow_address] })).toBe(parseUnits('40'));
    await cctx.close();
  });

  it('WCAG 2.1 AA: no automated axe violations on key pages', async () => {
    const { createRequire } = await import('node:module');
    const axeSource = (await import('node:fs')).readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
    const check = async (page: Page, path: string) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await page.addScriptTag({ content: axeSource });
      const r = await page.evaluate(async () => (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
      return (r.violations as Array<{ id: string; impact: string; nodes: Array<{ target: string[] }> }>).map((v) => `${path}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
    };
    const { page: anon } = await newUserContext();
    const found: string[] = [];
    for (const p of ['/', '/appeal']) found.push(...(await check(anon, p)));
    for (const p of ['/', '/send', '/receive', '/history', '/invoices', '/invoices/new', '/requests', '/settings', '/verify-identity', '/support', '/report']) found.push(...(await check(ada, p)));
    expect(found).toEqual([]);
  });

  it('staff sign in with SSO and TOTP and see the queues', async () => {
    await h.ctx.db.query("INSERT INTO app.staff (email, name, roles) VALUES ('analyst@backstop.ng','Analyst',ARRAY['risk_analyst'])");
    const { page } = await newUserContext();
    await page.goto('/staff');
    await page.getByLabel('Work email').fill('analyst@backstop.ng');
    await page.getByRole('button', { name: 'Continue with SSO' }).click();
    await page.getByRole('button', { name: 'Set up authenticator app' }).click();
    const secret = (await page.locator('p.mono').textContent())!.trim();
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate();
    await page.getByLabel('6-digit code').fill(code);
    await page.getByRole('button', { name: 'Verify' }).click();
    await page.getByRole('heading', { name: 'Queues' }).waitFor();
    await page.getByRole('link', { name: 'Fraud list' }).click();
    await page.getByText('0x000000000000000000000000000000000000dEaD').waitFor();
  });
});
