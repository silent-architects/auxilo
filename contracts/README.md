# AuxiloSplitRouter — non-custodial x402 settlement (Option 1 / R-01)

**Status 2026-07-04: the MVP rail is the RECEIVE-ONLY contract
`AuxiloSplitRouterReceiveOnly.sol` — LIVE on Base Sepolia at
`0x149C21BD3aC4364528fECceF29acf4Ec8ecf8145`. The server rewire is deployed to
prod INERT behind `X402_ROUTER_ADDRESS` (unset). The FREE/in-control mainnet
gates (A1 monitor+breaker, A3 deploy-attestation, A4 confirmation-depth,
receive-only wiring) are BUILT + testnet-verified — see VERIFICATION.md §10 and
the "Flip-the-flag runbook" at the bottom of this file. NOT on mainnet.**

**Two hard gates remain before any mainnet deploy:**
1. **External security audit** (now a ~100-LOC Receive-only subset — cheap).
2. **R-01 written sign-off** from fintech counsel on the non-custodial design
   (see `~/.auxilo/handoffs/AUXILO-COUNSEL-BRIEF-money-transmission-R01.md`).

**Mainnet enable is additionally gated on TYLER'S EXPLICIT WORD.** Base Sepolia
testnet deployment + flag-on staging are fine now (no real funds).

> The both-paths `AuxiloSplitRouter.sol` below is the preserved FUTURE variant
> (generic-x402 interop; retains a settler-discretionary Transfer/Stranded
> surface). The MVP ships Receive-only. Everything about the Transfer/Stranded
> paths in this doc applies ONLY to that future variant, not the MVP rail.

---

## What this replaces

Today (custodial): buyer USDC → platform wallet `0x1BE9…6Ca6` (100%), contributor
share = off-chain `pending_balance` ledger credit, paid out later from the
platform wallet (`POST /withdraw` → `sendUSDC`). Auxilo holds third-party funds
→ money-transmitter exposure.

After (non-custodial): buyer USDC → **router contract** → contributor 70/60% +
platform fee, **atomically in one transaction**. No platform custody, no crypto
`pending_balance`, no custodial withdraw rail.

## Verified facts this design rests on (2026-07-03)

- Base USDC (`0x8335…2913`, impl `FiatTokenV2_2` at `0x2ce6…d779`) exposes
  **both** `receiveWithAuthorization` (`0xef55bec6`, `0x88b7ab63`) and
  `transferWithAuthorization` (`0xe3ee160e`, `0xcf092995`) — confirmed by
  on-chain bytecode inspection (ZeppelinOS proxy slot).
- The x402 **exact EVM scheme** specifies `transferWithAuthorization`
  (coinbase/x402 `specs/schemes/exact/scheme_exact_evm.md`). Generic x402
  clients sign the **Transfer** typed struct, not Receive.

## Client compatibility → which settlement path

| Buyer client | Signs | Router path | Notes |
|---|---|---|---|
| Generic x402 agent (standard libs) | `TransferWithAuthorization` (to = router) | `settleAndSplitTransfer` | Full ecosystem interop. Griefing vector (direct submission strands funds in router) recovered by `splitStranded`. **Residual control (red-team P1-1): the settler supplies `contributor`+`bps`, unconstrained — the contract enforces a two-way split's SHAPE, not its DESTINATION. The settler key can divert stranded funds; it is a theft vector + a control surface for FinCEN/DFAL analysis. Do not represent as "Auxilo cannot divert."** |
| Auxilo-aware client (auxilo MCP / SDK) | `ReceiveWithAuthorization` (to = router) | `settleAndSplitReceive` | Preferred: front-run-proof by construction. Advertise via a hint in the 402 challenge `extra`. |

## Server rewire plan

**REWIRE STATUS 2026-07-03: steps 1–3 BUILT, flag-gated behind
`X402_ROUTER_ADDRESS` (unset → facilitator rail byte-for-byte, verified live),
and DEPLOYED INERT to Fly prod. 21-test unit suite green
(`test/x402-router.test.js`); live Sepolia E2E green on BOTH paths through the
lib (`scripts/x402-router-sepolia-e2e.js` — receive tx `0xb6282c11…`, transfer
tx `0x1266b3e6…`, exact 70/30 splits, router residue 0). Gate A reviews:
engineering PASS-WITH-CONDITIONS (MED-1 self-unlock settlement booking — FIXED
same day), security PASS for inert deploy. The two hard gates above still
stand before ANY mainnet flag-enable.**

**Conditions before flipping the flag ON (from Gate A) — status 2026-07-03:**
- ✅ DONE — Hint-mint flood hardening (sec L-1): challenges now REUSE one salt
  per (resource, contributor, bps, amount) within a 5-min window, and hints
  are no longer consumed on settle success (EIP-3009 nonces are
  per-authorizer, so buyers share a salt safely; the same buyer re-buying the
  same learning within one window fails closed until the salt rotates —
  documented edge). Live-hint population is bounded by catalog size, not
  request rate.
- ✅ DONE — Exact on-chain micro-USDC (`floor(value*bps/1e4)`, dust to fee
  side, matching `_split`) recorded as gross/contributor/platform_micro at
  all three `onchain_settlements` booking sites incl. WAL replay (sec L-2).
- ✅ DONE — `test/x402-router-server.test.js`: structural suite for the
  self-unlock booking, the single guarded `pending_balance` credit site, the
  WAL replay guard, and router-mode control flow (eng MED-1 follow-up).
- ◐ PROTOCOL DOCS DONE — mcp-server.js is a pass-through (the agent's own
  x402 library signs), so the client contract is documentation:
  AGENT-LEARNING-GUIDE.md §4 and the `auxilo_unlock` tool schema now describe
  both paths (standard Transfer unchanged; Receive = sign with
  `extra.router.nonce`, echo `{extra:{salt}}`). REMAINING: Tyler's npm
  republish (2FA) ships the schema text to installed clients.
- Testnet flag-on staging is acceptable now; mainnet remains gated on the
  external audit + R-01 counsel structure per the top of this file.

1. **`lib/x402-router.js` — DONE 2026-07-03.** Wraps the router: builds the
   `settleAndSplitTransfer`/`Receive` call from the X-Payment payload +
   `(contributorWallet, bps)`, broadcasts via the viem `walletClient`
   pattern from `lib/tx-manager.js` and SHARES tx-manager's nonce mutex
   (exported for this). Auxilo self-settles — **no facilitator `/settle`
   dependency**, and no facilitator `/verify` either (pre-broadcast checks +
   USDC's own sig verification cover it). Dual OFAC (buyer AND contributor)
   fail-closed before broadcast on BOTH paths, deps-injected from server.js.
2. **402 challenge — DONE 2026-07-03 (flag-gated).** Router-mode challenges are
   minted by `_routerAccepts` in `verifyPaymentOrReject` (the dynamic-price
   path the unlock route uses): `payTo` → router, `extra.router` carries
   `(contributor, contributorBps, salt)` + the precomputed derived nonce; a
   server-side salt→hint store (TTL 15 min, cap 5000, single-use on settle
   success) pins the advertised split so the settle broadcasts exactly what
   the buyer signed. SCOPE DECISION: `x402Gate` fixed-price platform-service
   routes (extract, …) intentionally STAY on the legacy
   payTo-platform rail even in router mode — those payments are for Auxilo's
   own services, no third-party funds, no custody exposure.
3. **Unlock handler — DONE 2026-07-03 (flag-gated).** Resolves + validates the
   contributor wallet BEFORE settlement (wallet-link-to-earn: only a VERIFIED
   `verifiedWallets` entry rides the router; unverified/no-wallet learnings
   fall back to the legacy rail, never a crypto balance); contributor OFAC
   runs fail-closed inside `settleWithRouter`; on settle success the split is
   recorded in `earnings[...].onchain_settlements` (incl. router-settled
   self-unlocks) with **no crypto `pending_balance` credit**, and the WAL
   replay path (`replayUnlock`) carries the same `settled_onchain` guard so a
   crash replay can never re-create custody.
   **ADD — buyer-side OFAC (red-team P0-4): SHIPPED on the CURRENT rail
   2026-07-03** — `checkOFAC(paymentPayload.payload.authorization.from)` in
   `_verifyPayment` (server.js ~1986) before `verifyAndSettle`, fail-closed
   (list-not-ready → 503 via the rateLimited signal). Carry the same screen
   into `lib/x402-router.js` for BOTH router paths when the rewire lands —
   the local self-submitted fallback with an unparseable header still has no
   extractable buyer address; the router path closes that gap.
6. **Pre-audit contract change (red-team P1-1): ADOPTED 2026-07-03.**
   `settleAndSplitReceive` now takes `salt` (not `nonce`) and DERIVES
   `nonce = keccak256(abi.encode(contributor, contributorBps, salt))`
   in-contract — settler substitution of split params is unexpressible on
   path 1 (a tampered derivation fails USDC's own signature verification).
   CLIENT REQUIREMENT this creates: the 402 challenge `extra` hint must carry
   `(contributor, contributorBps, salt)` and the Auxilo-aware buyer client
   must compute the identical derived nonce before signing the
   ReceiveWithAuthorization struct (wire in `lib/x402-router.js`, step 1).
   Settler-key-compromise scenario is REQUIRED in the Foundry suite. Tax note
   (P1-7): W-9/W-8 collection must gate at wallet-link/contribution (atomic
   settlement removes the payout chokepoint).
4. **Delete/deprecate** crypto `POST /withdraw` after the dust migration (see
   BUILD-SPEC §12). **STILL OPEN 2026-07-03** — the rail stays PAUSED behind
   `CUSTODIAL_WITHDRAW_ENABLED` (default off, verified unset in Fly secrets);
   deletion lands with the flag-enable milestone, not before.
5. **Gas note:** self-settling means Auxilo pays Base gas per unlock
   (~fractions of a cent; the old facilitator path externalized this).
   **Settler key isolation (audit F5, 2026-07-04):** the `settler` key MUST be a
   dedicated, minimally-scoped key (`X402_SETTLER_PRIVATE_KEY`), provisioned in
   HSM/KMS or behind a multisig/threshold signer — it must NOT be the shared
   custodial payout key (`WALLET_PRIVATE_KEY`). `lib/x402-router.js` now
   fails closed if the dedicated key is unset (no fallback). Sharing the payout
   key would make one compromised secret a full settler-role compromise on the
   unbound Transfer/Stranded paths, and `settler` is immutable so recovery is
   redeploy-only. Rehearse a rotation-by-redeploy runbook before mainnet.

## No-wallet contributors

A learning whose contributor has no verified wallet cannot settle on the crypto
rail. Per BUILD-SPEC §6: require wallet at contribution for the crypto rail;
legacy learnings fall back to credits/fiat accounting. **Never** hold the share
as a crypto balance — that re-creates custody.

## Test plan (Foundry recommended)

- Split math exactness at 7000/6000 bps incl. rounding dust (goes to fee side).
- `onlySettler` enforcement on all three settle/recovery functions.
- Receive path: end-to-end against a mainnet-fork USDC.
- Transfer path: normal settle + griefing scenario (direct submission →
  `splitStranded` completes the intended split; `skim` cannot touch USDC).
- Reentrancy + zero/edge params revert correctly.
- Event fields correct for reconciliation (nonce ↔ x402 payload dedup).

---

## Receive-only MVP guards (A1 / A3 / A4) — built 2026-07-04

All behind `X402_ROUTER_ADDRESS`, inert by default. See VERIFICATION.md §10.

- **A4 confirmation-depth** (`lib/x402-router.js`): settles are booked as final
  only after a reorg-safe finality wait, never at depth 1. Books only when the
  tx is min-depth deep, its block is **still canonical at that height** (a
  deterministic reorg check — the canonical block-hash-at-height must equal the
  tx's block hash; Gate-A H1), and the OP-stack `safe`/`finalized` head has
  reached it. `X402_ROUTER_CONFIRM_TAG` = `safe` (default) | `finalized` |
  `latest`; `X402_ROUTER_MIN_CONFIRMATIONS` (default 2, floored to ≥1 on mainnet);
  `X402_ROUTER_CONFIRM_TIMEOUT_MS` (default 180000). `reverted` /
  `reorged_before_final` / `confirm_timeout` all fail closed. Requires an RPC
  that supports the OP-stack `safe`/`finalized` tags. Latency tradeoff: with
  `tag=safe` the unlock request blocks for the safe-head wait (seconds–minutes on
  Base).
- **A1 USDC-impl monitor + circuit-breaker** (`lib/usdc-impl-monitor.js`,
  `scripts/usdc-impl-monitor.js`): the settle path fails closed if Circle
  upgrades the USDC proxy impl out from under the verified assumptions; the
  standalone monitor alerts (cron one-shot or `--watch`, optional
  `X402_MONITOR_WEBHOOK_URL`). Pinned impls: Base `0x2ce6…d779`, Sepolia
  `0xd74c…c5b5`; override `X402_USDC_EXPECTED_IMPL`. The inline guard re-checks
  every settle by default (`X402_USDC_IMPL_CHECK_TTL_MS=0`); keep any positive
  cache TTL ≤ the monitor's poll interval. The breaker is per-process sticky —
  once tripped it clears only on restart (with a corrected pin); run the
  standalone monitor fleet-wide so no instance is blind.
- **A3 deploy-attestation** (`scripts/deploy-attest.js`,
  `DEPLOY-ATTESTATION.md`): `preflight` before deploy, `readback` after
  (on-chain immutable read-back + immutable-aware bytecode match). Both exit
  non-zero on any hard failure.
- **Receive-only** (`X402_ROUTER_RECEIVE_ONLY`, default ON): 402 challenge mints
  the Receive path only; saltless Transfer payments are refused fail-closed
  (closes F8). Settler key is the dedicated fail-closed `X402_SETTLER_PRIVATE_KEY`
  (F5).

---

## Flip-the-flag runbook (mainnet — GATED ON TYLER'S EXPLICIT WORD)

**Do NOT run this without (a) the paid external audit, (b) written R-01
counsel sign-off, and (c) Tyler's explicit go. Testnet flag-on is fine now.**

**Prereqs (one-time):**
1. Provision a **fresh single-purpose** `feeWallet` and a **dedicated** settler
   key in HSM/KMS (F5) — see `DEPLOY-ATTESTATION.md` §1–§2.
2. `cd contracts && forge build` (fresh artifact for the readback bytecode match).

**Deploy + attest (A3):**
3. `node scripts/deploy-attest.js preflight --chain 8453 --usdc 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 --fee <FRESH_FEE> --settler <SETTLER>` → must be all ✓. Save + sign off the attestation record.
4. Deploy `AuxiloSplitRouterReceiveOnly(usdc, feeWallet, settler)` with exactly the attested args.
5. `forge verify-contract` on Basescan (DEPLOY-ATTESTATION.md §5).
6. `node scripts/deploy-attest.js readback --chain 8453 --router <ROUTER> --usdc 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 --fee <FRESH_FEE> --settler <SETTLER>` → must be all ✓ incl. the bytecode match.

**Arm the guards (A1) + policy (A4):**
7. `node scripts/usdc-impl-monitor.js` (chain 8453) → exit 0. Wire it to cron/alerting (`--watch` + `X402_MONITOR_WEBHOOK_URL`).
8. Set the settle env on the server:
   - `X402_ROUTER_CHAIN_ID=8453`
   - `X402_ROUTER_RECEIVE_ONLY=1` (default, be explicit)
   - `X402_ROUTER_CONFIRM_TAG=safe` (or `finalized` for max safety), `X402_ROUTER_MIN_CONFIRMATIONS=2`
   - `X402_SETTLER_PRIVATE_KEY=<dedicated settler key>` (fails closed if unset)
   - `CUSTODIAL_WITHDRAW_ENABLED` stays unset (custodial withdraw remains paused).

**Flip:**
9. **Only when 3–8 are all green:** set `X402_ROUTER_ADDRESS=<ROUTER>`. The router
   rail is now live; a first real unlock self-settles + splits atomically.

**Rollback:** unset `X402_ROUTER_ADDRESS` → instant revert to the facilitator
rail (byte-for-byte). The A1 breaker also auto-fails-closed on a USDC upgrade.

**Settler rotation:** `settler` is immutable → rotation is redeploy-only (repeat
3–9 with a new settler; move `X402_ROUTER_ADDRESS` to the new contract).
