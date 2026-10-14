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
