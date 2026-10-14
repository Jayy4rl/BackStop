# Backstop

A stablecoin wallet for people and businesses in Nigeria where every payment is checked before it
is sent, and money paid to strangers can be held in escrow until the other side delivers. Four
loops on one shared core: send and receive (L1), freelancer invoices (L2), trade orders (L3) and
P2P USDT/naira trading (L4, off until legal gate G2 clears).

Built from the *Backstop Product PRD* and the *Backstop Escrow Contract Architecture* (Oct 13, 2026).

## Layout

| Path | What |
|---|---|
| `contracts/` | Solidity: `EscrowFactory` + per-payment `Escrow` clones (UC1–UC13, admin A1–A9), freeze adapters, 48h-timelock deploy script, Foundry tests (transition matrix, hostile tokens, invariants I1–I9). See `contracts/README.md`. |
| `packages/shared/` | TypeScript shared by every app: address validation (EIP-55, TRON Base58Check), EIP-191 and TRON `signMessageV2` recovery, money, fees, reason codes and templates, versioned rules and limits, escrow model mirroring the contract guards, business-day SLAs, chat contact blocking, name matching, generated ABIs. |
| `services/api/` | Fastify API and worker (Node 22, Postgres 16, Redis): identity, wallet, safety checks, protected payments, disputes, fraud list and appeals, the four loops, staff console API, indexer, keeper, durable job queue. |
| `apps/web/` | React web app: user app, client checkout, supplier order page, public appeal page, document verification, staff console. |
| `apps/mobile/` | Expo / React Native app for Android and iOS. |

## Architecture in one page

- **Non-custodial.** Wallet keys are created on the user's device and gated by the device (OS
  keystore on mobile; WebCrypto + WebAuthn PRF on web). Backstop learns addresses only, proven by
  EIP-191 and TRON signatures. The API builds unsigned call bundles; the device signs them.
- **Escrow on-chain, everything else off-chain.** One escrow contract per payment (CREATE2,
  `orderRef` salt). The database changes only from events in **final** blocks (Arc deterministic,
  Base `finalized`, Ethereum finalized, TRON solidified). Keeper calls are permissionless and
  idempotent; the payee's own release button is the fallback.
- **Rule-based checks, replayable.** Each check gathers facts (list standing, labels, history,
  chain lookups, exposure trace), then a pure evaluation decides. Facts, list version and rule
  version are stored with the decision; staff can replay any decision exactly (C3-6). Pre-send
  chain lookups have a 150 ms budget and degrade to direct-list matching with a visible notice.
- **Service-layer ready.** Every row carries `tenant_id` (Backstop app = 1). Fraud-list, check and
  dispute data live in the `network` schema, apart from app user data in `app`. Rules, fees and
  limits are versioned data (`config.versions`). `audit.events` is append-only and hash-chained
  (updates and deletes are rejected by trigger).
- **Vendors behind adapters.** Identity (BVN/NIN + liveness), CAC, sanctions/PEP, bank name
  enquiry, embedded wallet, SMS/email/push, captcha, storage, FX, arbiter execution and staff SSO
  are interfaces with deterministic `sandbox` implementations; real implementations exist for
  Termii SMS, Postmark email, Expo push, Cloudflare Turnstile, OIDC SSO, OFAC SDN address parsing,
  generic HTTP FX, and Safe/TRON-multisig arbiter proposals.

## Running locally

Requirements: Node 22.5+, Postgres 16, Redis 7, Foundry (forge, anvil).

```sh
git submodule update --init          # forge-std
npm install
(cd contracts && forge build && forge test)

anvil &                              # local EVM chain
npm run dev:chain > .env.chain       # deploys factory + mock USDC, prints chain env
set -a; . ./.env.chain; set +a
export SEED_STAFF='you@backstop.ng|You|admin,risk_analyst,dispute_reviewer,arbiter_signer,support' P2P_ENABLED=true
npm run dev:api                      # http://localhost:4000 (creates and migrates the database)
npm run dev:worker                   # indexer, keeper, job queue
npm run dev:web                      # http://localhost:5173 (proxies /api to the API)
```

All other settings and their defaults are in `services/api/.env.example`. Sandbox OTPs are
recorded in `ops.outbox`; the sandbox identity vendor accepts any 11-digit BVN/NIN (IDs ending
`0000` are "not found"); sandbox bank enquiry treats account numbers starting `99` as someone
else's account; the sandbox captcha token is `sandbox-pass`; staff sandbox SSO signs in with the
staff email, then TOTP MFA.

Mobile: `cd apps/mobile && npx expo run:android` (or `run:ios`), with `extra.apiUrl` in
`app.json` pointing at the API and the app's origin added to `WEBAUTHN_ORIGINS`.

## Tests

| Command | Covers | Result (last run) |
|---|---|---|
| `cd contracts && forge test` | 77 Foundry tests: transition matrix, guard failures, hostile tokens, re-entrancy, time boundaries, same-block races, factory, deploy, invariants I1–I9 under fuzzing | 77 passed |
| `npm run test -w @backstop/shared` | addresses, signatures (TRON signatures cross-checked against TronWeb), money, fees, escrow guards, business days, chat blocking, name matching | 23 passed |
| `npm run test -w @backstop/api` | real Postgres per test file: auth with a software WebAuthn authenticator, identity, C3 checks and replay, P2P, fraud list and appeals, keeper; plus an **anvil end-to-end suite running the real contracts** through L1, L2 auto-release and fee collection, L3 dispute with 2-of-3 arbiter execution, frozen-payee refund (UC12), reclaim (UC9), payee-listed pause, indexer-behind pause, audit-chain integrity | 63 passed |
| `npm run test:e2e` | Chromium with a virtual WebAuthn authenticator against the real API and anvil: sign-up, Tier 1, deposit, on-chain send between users, fraud-list block, L2 checkout from an external wallet, staff SSO+TOTP, axe-core WCAG 2.1 A/AA scan of 15 pages | 7 passed |
| `npm run typecheck` | shared, API, web, mobile | clean |
| `npm run build:web`; `expo export` (android, ios) | production builds | build |

CI (`.github/workflows/ci.yml`) runs the same commands with Postgres, Redis and Foundry.

## Requirement traceability

Legend: ✅ implemented and tested · 🟡 implemented, partly verified or limited by a dependency · ⛔ not done (see blockers) · ⏭ PRD says *Later*.

| ID | Status | Where |
|---|---|---|
| C1-1 sign-up, OTPs, passkey with wallet | ✅ | `modules/auth.ts`; tests `auth.test.ts`, browser e2e |
| C1-2 Tier 1 BVN/NIN + liveness | 🟡 vendor adapter, sandbox | `modules/identity.ts`, `adapters/identity.ts` |
| C1-3 Tier 2 CAC + Tier 1 director + address | 🟡 sandbox registry | `modules/identity.ts` |
| C1-4 counterparty document + liveness above threshold | ✅ | `identity.ts`, checkout, order acceptance |
| C1-5 one Tier 1 account per BVN/NIN | ✅ | HMAC unique index |
| C1-6 sanctions/PEP at onboarding, daily | 🟡 sandbox person screening; OFAC address parser | `screenUser`, `sanctions_refresh` job |
| C1-7 tier limits in config, shown in app | ✅ | `services/limits.ts`, `/me/limits` |
| C1-8 new device / phone change re-verification | ✅ | `assertCanMoveMoney`, `/auth/reverify/*` |
| C1-9 encrypted identity data, consent, retention | ✅ | AES-GCM at rest, `app.consents`, closure + keeper purge |
| C2-1 embedded wallet, passkey, no Backstop key | 🟡 device-key sandbox wallet; vendor not chosen | `apps/web/src/lib/wallet.ts`, `apps/mobile/src/lib/wallet.ts` |
| C2-2 recovery: second passkey or provider recovery + 48h delay | 🟡 flows done; sandbox wallet keys are device-bound | `/auth/passkeys`, `/auth/recovery/*` |
| C2-3 no TRX/ETH needed (Arc native, Base paymaster, TRON energy) | 🟡 bundles carry the sponsorship; paymaster/energy integration needs the wallet vendor | `services/txbuild.ts` |
| C2-4 receive: one address per network, QR, warning | ✅ | `/wallet/receive`, web + mobile |
| C2-5 balances, dollar total, naira reference with source/time | ✅ | `services/wallet.ts` |
| C2-6 available / on hold with reason and appeal | ✅ | indexer + `holds.ts` |
| C2-7 routing between Backstop users | ✅ | `routeInternal` |
| C2-8 CCTP between Base and Arc (Should) | 🟡 quote and expected wait only | `/cctp/quote` |
| C2-9 history + CSV | ✅ | `/wallet/history(.csv)` |
| C2-10 swaps | ⏭ | — |
| C3-1 pre-send before every signature, p95 ≤ 300 ms | ✅ local p95 tested | `services/checks.ts` |
| C3-2 block never overridden; warn overridable, logged | ✅ | `recordOverride` |
| C3-3 inbound at finality and before escrow/P2P | ✅ | indexer, `counterpartyFundsCheck` |
| C3-4 held funds unusable for escrow/P2P/in-app | ✅ | `assertSpendable` |
| C3-5 review within 1 business day | ✅ | review cases + SLA alerts |
| C3-6 decisions replayable | ✅ | `replayDecision`, `/staff/decisions/:id/replay` |
| C3-7 30-day re-screening | ✅ | `rescreen_transfer` jobs |
| C4-1 USDC escrow (Refund Protocol or equivalent) | ✅ equivalent contract (D7 open) | `contracts/` |
| C4-2 TRON USDT escrow | 🟡 same Solidity; TVM compile + Nile spike not done | `contracts/` |
| C4-3 one escrow per payment | ✅ | factory |
| C4-4 2-of-3 arbiter, release/refund only | ✅ | approvals table + executor; contract |
| C4-5 unfunded after 72h cancelled | ✅ | keeper |
| C4-6 keeper auto-release, payee fallback | ✅ | keeper + `/release-after-hold` |
| C4-7 disputes before hold end, 24h warning | ✅ | contract + `dispute_window_warning` |
| C4-8 evidence windows, encrypted, hash on-chain | ✅ | `openDisputeRequest`, ruling hash commits to evidence |
| C4-9 written ruling, one second review | ✅ | `services/disputes.ts` |
| C4-10 mutual cancel | ✅ | `/cancel-request` + `refundByPayee` |
| C4-11 fees shown before funding, deducted on-chain | ✅ (no fee on refunds, per D5) | fee quotes, contract |
| C4-12 fraud ruling opens C5 case | ✅ | `openFraudCaseFromRuling` |
| C4-13 independent audit | ⛔ external | — |
| C4-14 split outcomes | ⏭ | — |
| C5-1 report fraud | ✅ | `/fraud-reports`, web + mobile |
| C5-2 analyst console | ✅ | `modules/staff.ts`, staff web console |
| C5-3 second analyst above amount | ✅ | case decision flow |
| C5-4 seed from sanctions and issuer freezes, daily | 🟡 OFAC parser + freeze-event indexing; live feeds need network access | `sanctions_refresh`, `handleFreeze` |
| C5-5 exchanges/bridges can't be listed | ✅ | `upsertListing` |
| C5-6 public appeal page, rate-limited, bot protection | ✅ | `/public/appeals*`, web `/appeal` |
| C5-7 `under_appeal` while open | ✅ | appeal flow |
| C5-8 analyst targets | ✅ | due dates + SLA alerts |
| C5-9 12-month expiry and re-review | ✅ | keeper |
| L1-1 … L1-7 | ✅ | `modules/wallet.ts`, web + mobile |
| L2-1 … L2-8 | ✅ (L2-6 PDFs, L2-7 profile) | `modules/invoices.ts`, checkout |
| L3-1 … L3-5, L3-8, L3-9 | ✅ | `modules/orders.ts` |
| L3-6 tracking validation (Should) | 🟡 format check sandbox | `adapters/misc.ts` |
| L3-7 second approver (Should) | ✅ | approval requests |
| L4-1 … L4-5, L4-7 … L4-10 | ✅ (bank enquiry sandbox) | `modules/p2p.ts` |
| L4-6 auto-cancel and refund when buyer doesn't pay | 🟡 trade cancelled automatically; refund needs the seller's one-tap signature (see deviations) | keeper |
| Fees | ✅ L1 flat external-USDT fee, L2 1% capped and splittable, L3 1.25% capped, L4 0.5% | `packages/shared/src/fees.ts` |
| NFR availability, freshness, auditability, reliability, support, language | ✅ | degraded checks, `/status`, audit chain, keeper, support SLAs, locale templates |
| NFR accessibility | 🟡 web: zero axe WCAG 2.1 A/AA violations on 15 pages; mobile: labels/roles/font scaling, not device-tested | |
| NFR performance (mobile cold start, 2 GB devices, < 40 MB) | ⛔ not measurable here | Android min SDK 28 configured |

## Deviations from the documents

1. **Fees on refunds (C4-11)** follow the architecture doc's decision D5(a): fees only on release;
   refunds return the full amount.
2. **Open decisions D1–D6** are implemented as the architecture doc recommends (see
   `contracts/README.md`); **D7** (Circle Refund Protocol) is not adopted: one Backstop contract
   on every chain until its licence and audit status are checked.
3. **L4-6 refund on timeout.** The contract lets only the payer (the seller) reclaim after the
   deadline (UC9), so Backstop cannot refund automatically. When the buyer misses the window the
   trade is cancelled and the seller gets a one-tap "Reclaim USDT"; the USDT can only ever go back
   to the seller.
4. **L2 clients paying from Ethereum.** Escrow never lives on Ethereum (PRD: not used for escrow
   because of fees). Checkout tells Ethereum USDC holders to move to Base first (CCTP) and then pay.
5. **L2 clients paying from an exchange address.** `createEscrow` must be called by the payer, so
   an exchange withdrawal cannot fund escrow at all. The checkout refuses labelled exchange
   addresses, requires confirming refunds go back to the paying wallet, and offers a free client
   account. This replaces "ask for a separate refund address", which the contract cannot honour
   (refunds only go to the payer).
6. **Second review timing (C4-9).** A ruling is shown to both parties with its reason as soon as
   it is made; parties have 24 hours (2 hours in L4) to request the one second review, after which
   arbiter signers can execute. The final on-chain execution records the ruling hash.
7. **Sandbox wallet (C2-1/C2-2/C2-3).** Until the embedded-wallet vendor is chosen, keys are
   device-bound (web: WebCrypto, upgraded to a passkey-PRF key where supported; mobile: OS
   keystore with biometric gating). Cross-device recovery of the keys themselves and gas
   sponsorship are the vendor's job and are not simulated.
8. **Limits, thresholds and fee caps** are pilot placeholders in versioned config (PRD: set with
   counsel and pilot data).

## Blockers and what is not done

- **Vendors not chosen** (PRD open questions): identity/liveness, CAC, PEP screening, bank name
  enquiry, embedded wallet with TRON + EVM passkeys, SMS/email in production. Each has an adapter
  interface and a sandbox; production use needs the vendor integration.
- **TRON contracts**: no TRON Solidity compiler or TRON node is reachable here, so the TVM build
  and the Nile testnet spike (CREATE2 addresses, USDT return values, freeze behaviour, energy
  sponsorship) are not done. The TRON chain client, TRON call bundles and TRON signature handling
  are implemented and unit-tested against TronWeb, but not run against a TRON node.
- **External gates**: smart-contract audits (C4-13), penetration test, counsel's written advice
  (G1–G6), staffing, closed pilot.
- **Not run on devices**: the mobile app typechecks and its production bundles build for Android
  and iOS, but it has not been run on a phone or emulator (no Android SDK / Xcode here).
- **Pushing**: commits in this session could not be pushed (GitHub returned 403 for the Claude
  GitHub App on this repository).
