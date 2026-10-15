# Backstop escrow contracts

`EscrowFactory` creates one `Escrow` (EIP-1167 clone, CREATE2 with `orderRef` as salt) per
protected payment. Implements the Backstop Escrow Contract Architecture (Oct 13, 2026):
use cases 1–11 and admin A1–A7, plus the recommended open decisions:

| Decision | Adopted | Where |
|---|---|---|
| D1 frozen payee after hold | (b) UC12 `refundFrozenPayee()` with per-token freeze adapters | `Escrow.sol`, `adapters/FreezeAdapters.sol`, admin A9 `setFreezeAdapter` |
| D2 P2P arbiter timeout | (c) keep timeout + backup arbiter set copied at creation | `Roles.backupArbiter`, admin A8 `setBackupArbiter` |
| D3 stray tokens | (b) UC13 `returnExcess()` after a terminal state | `Escrow.sol` |
| D4 payee dispute after missed deadline | (b) payee may dispute from Funded only while `now <= deliverBy` | `Escrow.dispute` |
| D5 fees on refunds | (a) none | `Escrow._refund` |
| D6 treasury redirect | (a) keep: `collectFee` reads the current treasury | `Escrow.collectFee` |
| D7 Circle Refund Protocol | not adopted yet: one codebase on all chains pending licence/audit check | — |

Compiled with solc 0.8.24, `evm_version = paris` (no PUSH0/MCOPY/transient storage) so the
same source can target the TVM. TRON compilation and the Nile spike are not done yet.

## Commands

```sh
git submodule update --init   # forge-std
forge build
forge test                    # unit, transition matrix, hostile tokens, invariants I1–I9
FOUNDRY_PROFILE=ci forge test # deeper invariant runs
```

## Deploy

`script/Deploy.s.sol` deploys an OpenZeppelin `TimelockController` (the factory admin) and the
factory. The initial allowlist, freeze adapter and backup arbiter are applied through the timelock
at zero delay, and the same batch raises the delay to 48h and revokes all deployer roles, leaving
`ADMIN_MULTISIG` as sole proposer/executor/canceller. Env vars are documented in the script.

```sh
npm install   # @openzeppelin/contracts 5.0.2 (repo root)
ADMIN_MULTISIG=0x.. ARBITER=0x.. TREASURY=0x.. TOKEN=0x.. TOKEN_KIND=usdc \
  forge script script/Deploy.s.sol --rpc-url $RPC --private-key $PK --broadcast
```

### Arc (testnet 5042002, mainnet 5042)

USDC is Arc's native coin. Its blocklist is the NativeCoinControl precompile
(`0x1800…0001`, `isBlocklisted(address)`), not the ERC-20 interface, so Arc needs
`ArcUsdcFreezeAdapter`: use `TOKEN_KIND=arc-usdc`. The script refuses any other kind on Arc's chain
IDs, and `arc-usdc` anywhere else. Each escrow copies the adapter when it is created, so it must be
right from the first deployment. The deployer and the keeper pay gas in USDC.

```sh
ADMIN_MULTISIG=0x.. ARBITER=0x.. TREASURY=0x.. \
TOKEN=0x3600000000000000000000000000000000000000 TOKEN_KIND=arc-usdc \
  forge script script/Deploy.s.sol --rpc-url $ARC_RPC --ledger --broadcast
```

API settings: `ARC_RPC_URLS` (two providers), `ARC_CHAIN_ID`, `ARC_USDC=0x3600…`, `ARC_FACTORY`,
`ARC_START_BLOCK` (deploy block), `ARC_FINALITY=latest` (deterministic finality), `ARC_KEEPER_KEY`,
`ARC_TREASURY`, `ARC_ARBITER_SAFE`, `PUBLIC_ARC_RPC_URL`. The API reads Arc USDC movements from
the system emitter `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE` (18 decimals, scaled to 6) and the
blocklist from the precompile.

Testnet checks (the local tests use stand-ins for Arc's system contracts):

1. `cast call 0x1800000000000000000000000000000000000001 "isBlocklisted(address)(bool)" 0x70997970C51812dc3A010C7d01b50e0d17dc79C8`
   returns `true` (Arc's documented blocklisted test address), and the deployed adapter's
   `isFrozen(0x3600…, that address)` agrees.
2. An ERC-20 `transfer` on `0x3600…` emits two `Transfer` logs (interface, 6 decimals; system
   emitter, 18 decimals); a plain native send emits only the system log. Send both to a Backstop
   wallet and check each appears once in its history with the right amount.
3. A `Blocklisted` event appears in logs from `0x1800…0001` when an address is blocklisted (the
   indexer turns it into an `issuer_frozen` listing). If testnet offers no way to trigger one,
   check the event against a past blocklisting in the explorer.
4. Full escrow flow on testnet: fund, deliver, release; and a reclaim after a missed deadline.
