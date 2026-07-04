# AuxiloSplitRouter — non-custodial x402 settlement (Option 1 / R-01)

**Status 2026-07-03: contract LIVE on Base Sepolia (`0x8979…6142`) + server
rewire (steps 1–3) BUILT and deployed to prod INERT behind
`X402_ROUTER_ADDRESS` (unset). NOT on mainnet. Two hard gates before any
mainnet deploy:**
1. **External security audit** of `AuxiloSplitRouter.sol` (it moves real USDC).
2. **R-01 written sign-off** from fintech counsel on the non-custodial design
   (see `~/.auxilo/handoffs/AUXILO-COUNSEL-BRIEF-money-transmission-R01.md`).

Base Sepolia testnet deployment is fine now (no real funds; validates the flow).

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
   routes (extract, renderly, …) intentionally STAY on the legacy
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
