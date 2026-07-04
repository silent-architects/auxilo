# AuxiloSplitRouter — Verification Program

**Purpose.** This document is the executable-verification program for `AuxiloSplitRouter.sol`, maintained in lieu of a paid external audit firm. It exists to move the contract's safety properties from *argued* (a reviewer's reasoning) to *executed* (a tool or test proving it), and to record honestly where confidence rests on proof versus judgment.

**Honest framing (read first).** Executable verification + adversarial multi-agent review is a strong diligence posture, but it is **not identical** to a licensed independent audit firm's engagement. It substitutes breadth of automated proof and adversarial simulation for a named firm's reputational sign-off. The residual risk of that substitution is documented in §5 and must be understood before mainnet. This program's job is to shrink that residual to the smallest honest size.

---

## 1. Methodology — seven layers

| Layer | Tool | What it proves | Strength |
|---|---|---|---|
| L1 Static analysis | Slither, Aderyn | Known vulnerability patterns (reentrancy, arbitrary-send, uninitialized, etc.) across the whole contract | Broad, pattern-based |
| L2 Unit tests | Foundry | Specific behaviors on chosen inputs | Concrete, example-based |
| L3 Fuzz tests | Foundry (`forge test` w/ fuzz) | Properties hold across thousands of random inputs | Samples the input space |
| L4 Invariant tests | Foundry (stateful invariants) | Properties hold across random *call sequences* | Stateful, samples call space |
| L5 Symbolic proof | Halmos | Properties hold for **ALL** inputs (bounded), not sampled | Strongest — exhaustive within bounds |
| L6 Mainnet-fork | Foundry fork tests | Behavior against the **real** deployed USDC bytecode | Environmental fidelity |
| L7 Adversarial review | Multi-agent audit teams | Human-style reasoning attacks + review of the executed evidence above | Catches design/logic gaps tools miss |

The layers are complementary: tools (L1/L5) catch what examples (L2) miss; examples catch what tools can't model (external-call semantics); fork (L6) catches what mocks abstract away; agents (L7) catch what all of them miss (intent, economic, off-chain trust).

---

## 2. Executed results — post-expansion (2026-07-04)

**Headline:** 50 Foundry tests (46 unit/audit/fork + 4 stateful invariants) all green; **100% branch coverage (18/18)**; 5 of 6 Halmos symbolic checks proven exhaustively (the 6th is an SMT-division timeout, not a counterexample, and its property is a corollary of a check that DID prove); Slither 0 findings; Aderyn 0 High / 5 Low (all style/known-register items). The three previously-uncovered branches are now closed.

- **L1 Slither** — `slither AuxiloSplitRouter.sol` (contract analyzed in isolation): **0 results found.** No reentrancy, arbitrary-send, uninitialized-state, dead-code, or low-level-call findings in the contract. (A full-project run's findings are entirely in `lib/forge-std` test fixtures, not the contract.)

- **L1 Aderyn 0.6.8** — `aderyn . --src AuxiloSplitRouter.sol` (88 detectors, contract in isolation): **0 High, 5 Low.** Every Low is either style or an item already in the audit register — none require a code change and none is a vulnerability:
  - *L-1 Large numeric literal* (`10_000` at L115) — style; `10_000` is intentionally readable as basis points. Non-issue.
  - *L-2 `nonReentrant` not the first modifier* (`onlySettler nonReentrant`, 3 sites) — true observation, immaterial HERE: `onlySettler` makes no external call (only `if (msg.sender != settler) revert`), so no reentrancy can occur before the guard sets. Worth noting for future modifier changes; not exploitable as written.
  - *L-3 PUSH0 opcode* — not an issue on the target chain: Base (OP-stack) supports Shanghai/PUSH0; `foundry.toml` pins `evm_version = "cancun"`.
  - *L-4 Unsafe ERC20 operation* (the 3 `require(...transfer(...))` sites) — the contract already wraps every transfer in `require(bool)`, handling the false-return case; USDC returns a proper bool. This is the SafeERC20-vs-raw distinction; it overlaps audit **F9/B8** (a no-boolean-return or `false`-returning token bricks `skim`) which is already documented and, for USDC specifically, does not apply. The false-return path of all three requires is now unit-tested (see below).
  - *L-5 Unspecific pragma* (`^0.8.24`) — matches audit **B2**: pin the exact compiler for the audited artifact. Already in the register.

- **L2/L3/L6 Foundry unit + fork** — `forge test`: **46 passed / 0 failed** across the unit, audit, and fork suites.
  - *Unit* (`AuxiloSplitRouter.t.sol`, 28): split math + fuzz, nonce-binding (P1-1), access control, stranded recovery, skim, reentrancy on all 4 paths, constructor/validate edges.
  - *Audit* (`AuxiloSplitRouter.audit.t.sol`, 15, NEW): the audit's named-missing tests + the 3 branch-closers — see §3.
  - *Fork* (`AuxiloSplitRouter.fork.t.sol`, 3): real Base-USDC receive E2E, settler-compromise reverting inside real FiatTokenV2_2 sig verification, on-chain typehash check. (Fork tests `vm.skip` gracefully if the Base RPC is unreachable; on this run they executed against live mainnet USDC.)

- **Coverage** — `forge coverage`: **100.00% lines (42/42), 100.00% statements (45/45), 100.00% functions (9/9), 100.00% branches (18/18).** The three formerly-uncovered branches were the `false`-return path of each `require(token.transfer(...))` — line 237 (skim), line 263 (contributor), line 266 (fee). All three are now hit by dedicated mocks (a `false`-returning USDC and a blacklist-reverting USDC).

- **L4 Foundry invariants** (`AuxiloSplitRouter.invariants.t.sol`, 4, NEW) — a stateful handler random-sequences valid receive/transfer settlements, grief-ins, stranded recoveries, non-settler attempts, and skims, signing each authorization on the fly and tracking ghost accounting. All 4 hold at default depth (512 runs × 256 000 calls each, **0 reverts** across every handler action) and again at depth 500:
  - **INV_A value conservation** — `totalContributorPaid + totalFeePaid == totalGrossSettled` across the whole history (no USDC created or lost).
  - **INV_B zero live-path residue** — router USDC balance equals ONLY the griefed-in-but-not-yet-recovered amount; every successful live settle leaves the router holding nothing.
  - **INV_C settler-only** — a ghost counter of unauthorized fund movements stays 0: non-settler calls always revert and never move balances.
  - **INV_D split integrity** — the ledger identity holds AND on-chain reality matches it (`feeWallet` balance == cumulative fee, sum of contributor balances == cumulative contributor).

- **L5 Halmos 0.3.3 symbolic** (`AuxiloSplitRouter.symbolic.t.sol`, 6 checks, NEW) — a permissive mock USDC isolates the split arithmetic from `ecrecover` (an SMT wall). `halmos --contract AuxiloSplitRouterSymbolicTest --function check_`: **5 passed, 1 SMT-timeout.** What is PROVEN exhaustively (for ALL inputs Halmos enumerates, not sampled):
  - **`check_split_conservation`** — `contributorAmount + feeAmount == value` and router residue == 0, for all `value ≤ 2^128` and all `bps ∈ [0,10000]`. **This is the core no-wei-created/lost property, proven exhaustively.**
  - **`check_fee_is_complement`** — `contributorAmount == floor(value*bps/1e4)` and `feeAmount == value − contributorAmount` for all value, all bps: floor-rounding dust always rides the FEE side. (This proof already SUBSUMES the bps=0 and bps=10000 extremes as instances.)
  - **`check_contributor_le_value`** — `contributorAmount ≤ value` always (no overflow steal).
  - **`check_bps_zero_all_to_fee`** — bps==0 ⇒ 100% to fee, for all value.
  - **`check_nonce_binding_distinct`** — different `(contributor,bps)` under the SAME salt cannot derive the same nonce (second-preimage intuition). Under Halmos's standard keccak-injectivity model this PROVES a settler cannot substitute contributor/bps beneath a buyer-signed nonce without changing the buyer-signed salt.
  - **`check_bps_full_all_to_contributor` — SMT TIMEOUT (honest note, NOT a counterexample).** At the concrete extreme bps==10000 the solver must discharge `value − value*10000/10000 == 0` for symbolic `value` — an exact-division simplification Halmos does not close even at a 120s per-assertion budget and even bounded to `value ≤ 2^64`. Halmos reports TIMEOUT, never a counterexample. The property is nonetheless PROVEN as a **corollary of `check_fee_is_complement`**, which discharged `contributorAmount == value*bps/1e4` for all bps (10000 included) in 0.42s. It is retained as documented belt-and-suspenders.

---

## 3. Additions — status

**DONE — coverage + the audit's named gaps (L2, `test/AuxiloSplitRouter.audit.t.sol`):**
- ✅ The 3 uncovered branches — all were the `false`-return path of a `require(token.transfer(...))` (skim L237, contributor L263, fee L266); closed via a `false`-returning USDC mock and a blacklist-reverting USDC mock. Branches now 18/18.
- ✅ Settler-compromise KAT asserting the **exact maximum extractable value**: on the Transfer path and the Stranded path, a settler naming attacker=contributor at bps=10000 extracts **exactly 100% of `value`** to an arbitrary address (asserted precisely, on record). Contrast KAT: on the Receive path the same attack extracts **exactly 0** — the derived nonce makes it unexpressible.
- ✅ EIP-1271 smart-account buyer: a minimal 1271 wallet + a 1271-verifying USDC mock drive `settleAndSplitReceive`; asserts it settles (and a negative test where the wallet declines).
- ✅ Transfer-hook reentrancy: a malicious token (== the settler) whose `transfer` re-enters each settlement fn; asserts the `nonReentrant` guard reverts on all three paths (guards the A1 "USDC upgraded to add a hook" assumption).
- ✅ `balanceOf < value` stranded branch (explicit KAT, no partial debit); blacklist-of-`feeWallet` brick (atomic revert, buyer not debited, nonce not consumed → retriable); the F8-tie (a saltless Transfer still splits deterministically to the settler-named contributor).

**DONE — exhaustive properties (L4/L5):**
- ✅ **Invariant (L4, `test/AuxiloSplitRouter.invariants.t.sol`):** value conservation, zero live-path residue, settler-only fund movement, per-settlement split integrity — all green at high runs/depth, 0 reverts.
- ✅ **Symbolic (L5, `test/AuxiloSplitRouter.symbolic.t.sol`):** `contributorAmount + feeAmount == value` PROVEN for all `value ≤ 2^128, bps ∈ [0,10000]`; floor-to-fee complement PROVEN; the nonce-derivation second-preimage no-collision PROVEN (keccak-injectivity model). One redundant extreme (bps=10000 full) is an SMT-division timeout, covered by corollary — see §2.

**DONE — L1 breadth:** ✅ Aderyn 0.6.8 static pass (0 High / 5 Low, all style or known-register).

**OPEN — L7 adversarial:** a multi-agent team audits the executed evidence above and attacks specifically what the tests do NOT cover. The 2026-07-04 simulated adversarial audit (private handoff) is that pass; its §5 "Areas for Further Review" (environmental/off-chain blind spots A1–A4, B1–B9) is carried into §5 below and is the standing scope for the paid auditor + counsel.

---

## 4. Confidence assessment — property by property (honest)

**Legend.** **PROVEN** = exhaustive within stated bounds (Halmos) or 100%-branch executable coverage of the exact code path. **HIGH-CONFIDENCE** = holds across hundreds of thousands of sampled states/inputs, 0 counterexamples, but not exhaustive. **FORK-VERIFIED** = executed against real deployed Base USDC bytecode (current impl only). **ARGUED** = reasoning + example tests, no exhaustive tool. **OPEN** = not reached by any executable layer; the property is enforced (or not) off-chain / at deploy / by an external assumption. Where a property is *harness-excluded* — the suite is green only because its own setup filters out the failing inputs — that is called out explicitly, because a green result there is not evidence the contract enforces the property.

| # | Property | Status | Layer that earns it | Honest caveat |
|---|---|---|---|---|
| P1 | No wei created or lost in a split (`contributor + fee == value`) | **PROVEN** | Halmos `check_split_conservation`, all `value ≤ 2^128`, all bps; reinforced by fuzz + INV_A/D | Conservation of the `value` **parameter**, given the pull delivered exactly `value`. The mock and Halmos both move 1:1. Does **not** cover a USDC that delivers less than `value` (see A1/A2). |
| P2 | Floor-rounding dust always rides the fee side | **PROVEN** | Halmos `check_fee_is_complement`, all value, all bps | None material. Economic note: at `value·bps < 10000` (i.e. `value = 1` micro-USDC at 60/70%) the contributor floors to 0 — unreachable in production, floored by the $0.05 price minimum. |
| P3 | Contributor share never exceeds gross | **PROVEN** | Halmos `check_contributor_le_value` | None. |
| P4 | bps extremes (0 → all fee; 10000 → all contributor) | **PROVEN (0) / PROVEN-by-corollary (10000)** | Halmos `check_bps_zero_all_to_fee`; the 10000 case is a direct instance of P2 (its dedicated check SMT-timeouts, not a counterexample) | The 10000 corollary rests on a reader accepting `value·10000/10000 == value`, trivial and true under the no-overflow bound. |
| P5 | Receive path: settler cannot substitute contributor/bps (theft unexpressible) | **PROVEN (derivation) + FORK-VERIFIED (rejection)** | Halmos `check_nonce_binding_distinct` proves any change to (contributor,bps) yields a different nonce; real-USDC fork test proves the mismatched nonce makes FiatTokenV2_2 revert; KAT max-extractable == exactly 0 | Composite: the *injectivity* half is symbolic (under keccak-injectivity model); the *rejection-on-mismatch* half is Circle's ecrecover, verified at 2 concrete fork tamper points, not symbolically. This is the correct division of labor — ecrecover is an SMT wall — and the doc grades it exactly so. Contingent on current USDC impl (A1). |
| P6 | Transfer/Stranded path: max settler-extractable == exactly 100% of value to an arbitrary address | **PROVEN as a ceiling — and this is a disclosed accepted residual, NOT a safety property** | KAT `test_KAT_SettlerCompromise_*_100pct` (exact `vm.expectEmit` + balances) | This is the honest ceiling of the entire program. On these two paths the contract contributes ~0 diversion protection; whether the right contributor is paid reduces entirely to (a) the off-chain settler naming honest params and (b) the settler key not being stolen. Neither is on-chain. |
| P7 | Value conservation across arbitrary call sequences | **HIGH-CONFIDENCE** | INV_A/D, 512×256 000 calls, 0 reverts, on-chain balances == ledger | The handler only ever plays an **honest settler**; it is structurally incapable of generating the P6 theft sequence, so a green result here cannot distinguish "safe" from "settler diverted everything but conserved the total." Conservation is real; destination-honesty is not what these invariants measure. |
| P8 | Live paths leave zero router residue | **HIGH-CONFIDENCE** | INV_B (residue == only un-recovered stranded) | The stranded-residue ghost is a single fungible scalar that mirrors the contract's commingled balance, so INV_B is near-tautological on **per-deposit attribution**. It proves live paths drain to zero; it does **not** prove stranded funds are attributed to the right deposit (that is F1). |
| P9 | Only the settler moves funds on split paths | **HIGH-CONFIDENCE + PROVEN-coverage** | INV_C (0 unauthorized movements); `onlySettler` branch-covered | Proves no *unauthorized* address moves funds. Says nothing about where the *authorized-but-compromised* settler sends them (that is P6). |
| P10 | Reentrancy blocked on all fund-moving paths (incl. a hypothetical USDC transfer hook) | **PROVEN-coverage** | 4 reentrancy tests + a hook-adding malicious-token mock; guard reverts | The guard is proven to fire. The *no-hook assumption* about real USDC is not proven — it is A1. Guard would still revert re-entry under a hooked upgrade; other properties would not survive. |
| P11 | Blacklisted feeWallet/contributor ⇒ atomic revert, no partial debit, nonce not consumed | **PROVEN-coverage** | blacklist + false-transfer mocks on all three require-false branches | Covers the **outbound** (fee/contributor) leg blacklist. A blacklisted **buyer** (`from`) or a global **pause** — which real USDC also gates — is not modeled; by EVM atomicity that revert is a strict subset (nonce provably not consumed), so it is safe, but it is argued, not executed. |
| P12 | EIP-3009/EIP-712 binding, replay, malleability, domain, validity window, front-run-proofness of Receive | **HIGH-CONFIDENCE / FORK-VERIFIED (Receive/EOA only)** | unit suite + real Base-mainnet-fork typehash/domain/settlement tests | Fork fidelity is **Receive-path + EOA only**. The Transfer path typehash and splitStranded are never fork-read (mock-only). The signature *verifier itself* is Circle's code, not Auxilo's — correctly out of scope, but that means this is fork/sample-grade, not exhaustive. |
| P13 | EIP-1271 smart-account buyers can settle | **ARGUED-by-mock (weakest cell)** | a bespoke 1271-verifying USDC mock + minimal 1271 wallet | **No real-USDC 1271 fork test exists.** All 3 fork tests are ECDSA. Smart-account agent buyers are a named primary user, yet this class sits alone at the lowest tier. Failure mode if the mock and real SignatureChecker diverge is liveness (buyer can't settle), not theft. Closable by one fork test. |
| — | **Event-field correctness for off-chain reconciliation** (`Settled.authNonce`, `.buyer`) | **OPEN (by design)** | none — spot-checked by `vm.expectEmit` on happy paths only; no invariant binds emitted fields to state | On splitStranded these fields are raw settler-supplied params copied verbatim into the event. The dedup key downstream accounting trusts most is settler-forgeable. This is an off-chain reconciliation property no contract test can bind. |
| — | **Stranded single-settlement / anti-replay** ("each authNonce settles at most once") | **OPEN — no invariant, no on-chain guard** | none | splitStranded has no on-chain replay guard; `authNonce` is cosmetic; the only gate is `balanceOf ≥ value` against a commingled balance. The invariant handler recovers honestly exactly once by construction, so no green invariant can catch a double-fire. This is F1 + F2, both still open. |
| — | **contributor == feeWallet / == address(this)** accounting integrity | **OPEN — harness-excluded from every layer** | none | `_validate` blocks only the zero address. Halmos `vm.assume`s these aliases away; the invariant handler filters them out of contributor selection; no unit/audit test exercises them. Green INV_D is green *because the setup avoids the failing inputs*. `==feeWallet` mis-books contributor earnings; `==address(this)` re-strands funds under a "Settled" banner with no recovery path. Removable by a one-line on-chain guard. |

**Overall, honestly stated.** The split arithmetic and value conservation are genuinely **proven** (P1–P4, P7) — the property the rail depends on for "no funds created or lost in a completed settlement" is exhaustive where it matters. The Receive-path buyer-attestation is **proven and fork-verified** (P5); on that path the settler really is demoted to executor. Everything a Foundry/Halmos/Slither/Aderyn program can reach on *this contract's logic*, it reaches, and it comes back clean.

But three honest asterisks sit on top of that clean result, and the reader must carry all three:

1. **The invariant suite proves per-settlement conservation, not cross-settlement single-use, and not destination-honesty.** It is green partly because its handler only ever plays an honest settler and filters out the adversarial and aliased inputs. That is the correct scope for what it claims — but it means "4 invariants green at 512×256k calls" is not evidence against P6 theft, F1 replay, or the B5 identity edges.
2. **The strongest results are conservation of the `value` parameter under a 1:1 token.** Halmos and the mocks all deliver exactly `value`. That is honest and disclosed (A2), but "proven conservation" reads narrower once you know it is conditional on the pull delivering face value.
3. **The honest ceiling is P6 and it is not a test result — it is a trust assumption.** On the Transfer and Stranded paths the settler key can direct 100% of an in-flight payment anywhere. No contract test removes this; it is settler-key custody + counsel scope.

---

## 5. Three confidence figures — do not blend them

These measure three different things. Collapsing them into one number is the single most common way a package like this misleads.

### (a) CONTRACT-logic confidence — **~93%**
*"Is the Solidity correct for what it is designed to do?"*

**What earns it.** The split arithmetic is machine-proven exhaustively (Halmos, all `value ≤ 2^128`, all bps). 100% branch/line/statement/function coverage. Four stateful invariants green at 512×256k calls, 0 reverts, on-chain balances reconciled to the ledger. Slither 0 findings; Aderyn 0 High. Reentrancy, access control, atomic-revert-on-blacklist, and false-return handling all executed. The Receive-path nonce binding is both symbolically proven (injectivity) and fork-verified against real USDC (rejection). This is a genuinely strong, honestly-executed body of evidence — stronger than most contracts carry into a paid audit.

**What keeps it off 100% and out of the high-90s.** Two of the confirmed gaps are contract-level and *not* inherent trust boundaries — they are removable by cheap on-chain checks the contract does not yet have, which means the suite is green in part because it excludes the failing inputs rather than because the contract handles them:
- **B5 identity edges** (`contributor == feeWallet` / `== address(this)`) traverse the happy path unchecked. Every proving layer `vm.assume`s or filters them out. `== address(this)` silently and irrecoverably strands funds under a "Settled" event. One-line `_validate` guard closes it. Until then it is an un-demonstrated failure mode the invariants are structurally blind to.
- **F1 stranded replay**: no on-chain single-use key on `authNonce`; settles against a commingled balance. A one-line `strandedSettled` mapping closes it.

Neither is a High-severity money-theft hole *beyond* the disclosed settler surface, and both are honestly logged — which is why this is 93% and not lower. But leaving a removable on-chain gap to off-chain discipline is a *choice*, and an honest contract-logic number cannot round it away. If the two one-line guards land (or B5/F1 are executed as KATs and formally accepted), this rises to ~96–97% — the residual then being only the inherent bounds of bounded symbolic execution and the mock-vs-real fidelity ceiling.

### (b) DEPLOYED-SYSTEM confidence — **~78%**
*"If real money flows through this on mainnet, does the right person get paid and can it not be stolen or frozen?"*

This is materially lower than contract-logic confidence, and the gap is the honest headline. The contract is one component; the deployed system is contract + trusted off-chain settler + key management + deploy correctness + L2 environment. The proofs do not touch most of that surface, and several load-bearing controls are unbuilt or untested.

**Why it is lower than 93%, concretely:**
- **The settler key is the whole ballgame on 2 of 3 paths, and it is a hot key in an env var.** P6 pins settler-extractable at exactly 100% on Transfer/Stranded. The F5 shared-key foot-gun is *fixed and fails closed* (verified: `X402_SETTLER_PRIVATE_KEY` mandatory, no `WALLET_PRIVATE_KEY` fallback) — but the fix has **zero test coverage** (a refactor could silently reintroduce the fallback and every test stays green), and the audit's second half of F5 (HSM/KMS or multisig/threshold custody) is **unbuilt**. A leaked env var is full settler compromise. No contract test reduces this by one bit.
- **F2 stranded module does not exist.** Verified: no `splitStranded` caller, no ABI entry, no dedup ledger in `lib/x402-router.js`. If `splitStranded` ships to a flag-enabled mainnet, its only safety control is an uncoded manual process. This is a hard pre-mainnet gate that is currently open.
- **A4 reorg / confirmation-depth is unimplemented.** The settler books earnings and serves content on the *first* successful receipt (depth 1) — no finality wait, no reorg reconciliation. On a Base OP-stack reorg a `Settled` can be emitted → booked → un-mined (phantom settlement), and on splitStranded the dedup key is settler-forgeable. Documented as required; not built.
- **A3 deploy-time constructor is the entire trust root and is uncovered by every layer.** A single wrong-but-nonzero `feeWallet_` sends 30–40% of every settlement to a typo/attacker address forever, and every test re-passes against it because they all construct correctly in setup. Immutability means redeploy-and-abandon is the only remedy.
- **P13 smart-account buyers** have no real-USDC fork test (liveness risk for a named primary user class).

**Why it is not lower than 78%.** Every one of these is honestly disclosed in the artifacts, most are settler-key-gated (require the operator key, no unprivileged attacker path), the rail is inert in prod today (`X402_ROUTER_ADDRESS` unset), and the failure modes are predominantly *freeze/liveness or operator-trust*, not silent unprivileged theft. The system's dominant real-world loss scenario is **settler-key theft**, which is a custody problem with a known fix, not a code defect. Close F2 (build-or-descope), land the F1 + B5 on-chain guards, put the settler key in HSM/multisig, implement a confirmation-depth policy, and execute the A3 deploy checklist, and this rises toward the high-80s. It does not reach the contract-logic number until the settler ceases to be a single hot key that can divert 100% on two paths — which is an architectural/legal property, not a testing one.

### (c) R-01 / legal (non-custodial) confidence — **neither figure above touches it. Treat as UNADJUDICATED.**
*"Can Auxilo represent this as non-custodial / not a money transmitter?"*

This is a **category error to fold into either number above**, and stating that plainly is part of being honest to a fault. The contract's own header says it verbatim: *"Do not represent this contract as 'Auxilo cannot divert funds' — it can, via the settler."*

- Contract-logic confidence being 93% says the code does what it says. What it says includes **"the settler can divert 100% on Transfer/Stranded."** A high code-correctness score is therefore fully consistent with a *weak* non-custodial claim.
- The Receive-path non-custody property (P5) is real but **conditional on the buyer independently deriving the nonce** (F6/AR-2). The current client still ships "sign nonce as given," which invites blind signing; a blind-signing buyer gets zero protection from the binding against a compromised challenge server. The `:242` UNSAFE marker is still un-done.
- FinCEN independent-control and DFAL control-based analysis must treat the settler as a **residual-control surface**, not assume it away. That is a licensed-counsel determination. No amount of Foundry/Halmos work moves it.

**The honest statement:** the executable program can make the non-custodial *argument* cleaner (Receive-path binding proven, settler-extraction ceiling pinned exactly) but it **cannot supply the legal conclusion**. R-01 sign-off is an independent gate that neither confidence figure above should be read as advancing.

---

## 6. What a paid audit firm still adds that this program cannot

Stated plainly, because the whole point of this artifact is deciding whether to skip one:

1. **Reputational sign-off with a name attached.** A licensed firm's report is a market signal counterparties, counsel, and (if relevant) regulators recognize. This program produces evidence; it does not produce a name that stands behind the evidence.
2. **An adversary with independent economic and legal incentive to break it.** A simulated multi-agent red-team, however rigorous, shares this project's priors and has nothing at stake. A paid engagement puts a hostile, independently-motivated team on the contract — and, critically, one that *compiles and runs* the artifact independently rather than reasoning about the source.
3. **Liability if something is missed.** The firm carries professional liability. This program carries none; if it misses something, the loss is entirely Auxilo's.
4. **Independent execution of the very tests this program describes.** The 2026-07-04 adversarial audit explicitly did **not** compile the contract or run the suite — several of its recommendations were "add the Foundry test that would confirm this." The VERIFICATION.md run did execute them, but by the same party that wrote them. A paid firm re-derives the harness independently, which is where mock-fidelity errors (e.g. the 1271 path, the blacklist ordering) get caught.

This program legitimately **shrinks** the paid audit — it de-risks it and shortens it — but it does not substitute for it, and the artifacts say so in their own framing.

---

## 7. Residual-risk register — what stays OPEN and why no contract test removes it

### Confirmed gaps that are CONTRACT-CLOSEABLE (a choice, not an inherent boundary — should close before mainnet)
| ID | Gap | Why a test didn't catch it | Close it with |
|---|---|---|---|
| **F1** | splitStranded has no on-chain replay guard; `authNonce` cosmetic; settles against commingled balance | Invariant handler recovers honestly exactly once by construction — it *cannot* generate the double-fire | `mapping(bytes32=>bool) strandedSettled` single-use key + bind `value` to a recorded deposit |
| **B5** | `contributor == feeWallet` / `== address(this)` corrupt accounting / silently strand funds; every layer excludes them | Halmos `vm.assume`s them away; invariant handler filters them; no unit test | One-line `_validate` revert; then drop the exclusions so the property is *proven*, not assumed |
| **F5 (test half)** | The fail-closed settler-key guard has zero regression coverage | No JS test asserts `_getClients()` throws when the key is unset | ~5-line unit test; a refactor could otherwise silently reintroduce the shared-key fallback |
| **P13** | EIP-1271 smart-account buyers proven only by mock | All 3 fork tests are ECDSA | One real-USDC 1271 fork test against a deployed smart account |

### Accepted limitations — REAL, disclosed, and NOT removable by any contract test
| ID | Limitation | Honest note |
|---|---|---|
| **P6 / F4 / AR-1** | Settler can divert 100% on Transfer & Stranded to any address | The program's honest ceiling. Inherent to generic-x402 interop (random-nonce clients can't be nonce-bound). Off-chain settler-key custody + counsel scope. **No contract test removes it.** |
| **A1** | USDC is a Circle-upgradeable proxy | Every PROVEN/SAFE verdict is "against FiatTokenV2_2 as deployed today." A future Circle upgrade (fee-on-transfer, transfer hook, changed nonce semantics) silently invalidates the proofs with no on-chain signal. Only Circle can trigger it; needs an off-chain impl-hash monitor + circuit-breaker. **No contract test removes it.** |
| **A2** | No post-pull balance assertion on the two live paths | Conservation proofs assume the pull delivered exactly `value`. Under a short-delivering USDC the fee leg reverts (liveness break, not theft). Closeable by a post-pull balance-delta gate *if a redeploy is cut*; inherent otherwise. |
| **A3** | Deploy-time constructor is the entire trust root, uncovered by every layer | A wrong immutable is permanent and unrecoverable; every test re-passes against it. Only `usdc_` is code-pinnable (canonical-address assert); `feeWallet_`/`settler_` are irreducibly a deploy-attestation procedure. **No runtime test removes it.** |
| **A4 / B1** | Reorg / confirmation-depth; event-log-as-source-of-truth; forgeable stranded dedup key | Off-chain booking property. Settler books at depth 1 today. Needs a finality-depth policy + reorg-aware ledger. **No Foundry/Halmos property on an immutable settlement contract reaches it.** |
| **B3** | Settler shares tx-manager's nonce mutex — one stuck tx head-of-line-blocks the rail | Pure off-chain liveness SPOF. **No on-chain test can reach it.** |
| **F6 / AR-2** | Receive non-custody property is conditional on buyer-side nonce derivation | The `:242` "sign nonce as given" wording is still un-marked-UNSAFE. Client-copy + counsel-disclosure item. |

Every accepted limitation above is documented in VERIFICATION.md §5 and/or the 2026-07-04 audit. None is laundered into "proven" — they are the price of an immutable contract composed with an upgradeable external token and a trusted operator key.

---

## 8. Closing recommendation

**From a pure contract-verification standpoint: the Solidity logic is ready for a testnet-staged, then mainnet, deploy — with two cheap on-chain hardenings landed first, and only behind the non-contract gates below.**

The contract's *logic* is in strong shape (§5a, ~93%). The evidence that it does what it says is real, executed, and clean. That is a genuinely good result and should be stated plainly rather than hedged into meaninglessness.

But the **deployed-system** number (§5b, ~78%) is the one that governs whether to put real money on it, and it is lower for reasons that are *not* contract bugs. The following non-contract conditions must hold before mainnet flag-enable — they are the gap between the two numbers:

**Must clear before flag-enable (hard gates):**
1. **Settler key in HSM/KMS or behind a multisig/threshold signer** — the F5 code fix (fails closed, verified) removes the shared-key foot-gun but leaves a hot key in an env var; P6 makes that key the 100%-diversion surface on two paths. Custody is the dominant real-world loss scenario.
2. **The F2 stranded decision, made explicitly and enforced as a checklist item** — either descope `splitStranded` from the deployed contract, **or** build the off-chain recovery module (dedup ledger + dual OFAC + verified-wallet resolution + amount reconciliation + fail-closed broadcast). "The flag stays unset" is currently the *only* control between the disclosed capability and a live incident, and that must not be an accident.
3. **Land the F1 `strandedSettled` mapping** if `splitStranded` ships at all, plus the B5 `_validate` identity guard — both are one-liners that convert harness-excluded gaps into proven ones.
4. **Deploy-time attestation (A3)** — canonical-USDC assertion, fresh single-purpose non-blacklistable `feeWallet`, bytecode verification, and a post-deploy on-chain read-back of all three immutables before flipping `X402_ROUTER_ADDRESS`.
5. **A confirmation-depth policy (A4)** before booking earnings/serving content, and a USDC impl-hash monitor + circuit-breaker (A1).
6. **The two README gates remain in force and are NOT satisfied by this program:** a paid external audit (independent compile + fuzz + formal) and written fintech-counsel R-01 sign-off. This assessment shortens both; it replaces neither.

**Binding legal condition:** every "non-custodial" representation — to counsel and in public copy — must be scoped to the Receive path only and must never assert diversion-impossibility for Transfer/Stranded. The contract header already says this; the claims must match it.

**Sequencing:** testnet-stage with the two on-chain guards (F1, B5) and the F5 regression test in place → verify the F2 build-or-descope decision is enforced → complete A3 attestation → then mainnet behind the paid-audit + R-01 gates. Do not read 93% contract-logic confidence as clearance to skip the paid audit; read it as evidence that the paid audit should be fast and cheap, and that the real remaining risk lives in key custody, the stranded path, deploy correctness, and the legal characterization — none of which a verification suite can sign off.

---

## 9. Receive-only MVP variant — `AuxiloSplitRouterReceiveOnly.sol` (2026-07-04)

**Decision context.** A 4-0 panel selected a RECEIVE-ONLY contract as the bootstrapped MVP. It is a strict subset of `AuxiloSplitRouter.sol` (the both-paths FUTURE variant, preserved unmodified): it keeps ONLY the buyer-attested Receive path and drops `settleAndSplitTransfer`, `splitStranded`, the `transferWithAuthorization` interface method, and the `InsufficientStranded` error. It ADDS the B5 identity guard to `_validate` (`contributor == feeWallet || contributor == address(this)` reverts `BadContributor`). The MVP is additive-reversible to the both-paths variant; the original file is untouched.

**Why this variant exists — the structural collapse.** Cutting Transfer + Stranded removes every settlement on which the settler retained destination discretion. On this contract the ONLY path derives the EIP-3009 nonce from `(contributor, contributorBps, salt)` and the buyer signs that exact nonce, so **every** settlement is buyer-attested. The consequences, stated against the §4/§5 register:

- **P6 (settler diverts 100% on Transfer/Stranded) → collapses to exactly 0.** Those paths do not exist. There is no settlement whose destination the settler can choose. A compromised settler's worst action is to *not settle* (a liveness denial), never to misdirect. "Auxilo cannot divert funds" becomes **STRUCTURALLY TRUE for 100% of settlements**, not a claim conditional on off-chain honesty. This is proven by the receive-path KAT (`test_KAT_SettlerCompromise_ReceivePath_MaxExtractable_ZERO`) and fork-verified against real Base USDC (`test_Fork_SettlerCompromise_RevertsInRealUsdc` — attacker balance asserted exactly 0).
- **F2 (unbuilt stranded off-chain module) and F1 (stranded on-chain replay guard) → VANISH.** There is no stranded path to recover, dedup, or guard. Both open items are moot for this contract.
- **B5 (identity edges) → PROVEN, not harness-excluded.** The one-line `_validate` guard is now enforced on-chain. The Halmos and invariant harnesses NO LONGER `vm.assume`/filter the aliasing inputs away: Halmos `check_b5_guard_reverts_alias` proves that `contributor ∈ {feeWallet, router}` ALWAYS reverts for all value/bps; the invariant handler's `b5Aliased` action submits genuine buyer-signed aliased settles across 63k+ calls and the ghost counter of any resulting fund movement stays 0. Two unit KATs (`test_B5_ContributorEqualsFeeWallet_Reverts`, `test_B5_ContributorEqualsRouter_Reverts`) sign against the aliased derived nonce so the revert is proven to be the router's own guard.
- **F5 (settler-key custody) → demoted from THEFT to LIVENESS.** The settler key is still a single operational key, but on this contract its compromise can only deny settlement, not divert it. The dominant real-world loss scenario on the both-paths variant (settler-key theft → 100% diversion on two paths) is not expressible here. Custody hardening remains worthwhile as an availability/operational control, not as a theft mitigation.

**Executed results (2026-07-04).**

- **L2/L3/L6 Foundry** — `forge test --match-contract ReceiveOnly`: **40 passed / 0 failed** — 27 unit (`AuxiloSplitRouterReceiveOnly.t.sol`: split math + fuzz, nonce-binding P5, access control, reentrancy incl. a receive-path transfer-hook mock, skim incl. USDC-excluded + false-return, constructor/validate edges, **2 B5 KATs**, the receive-path zero-extraction KAT), 6 audit (`.audit.t.sol`: false-return on contributor + fee legs, blacklist atomic-revert on both legs, EIP-1271 positive + negative), 3 fork (`.fork.t.sol`: real Base-USDC receive E2E, settler-compromise reverting in real FiatTokenV2_2, on-chain typehash — executed live against Base mainnet USDC, not skipped), 4 stateful invariants (`.invariants.t.sol`: value conservation, zero residue, settler-only-**and-B5-aliased**-move-nothing, split integrity — 512×256 000 calls, **0 reverts**).
- **Coverage** — `forge coverage`: **100.00% lines (35/35), 100.00% statements (41/41), 100.00% branches (18/18), 100.00% functions (7/7)** on `AuxiloSplitRouterReceiveOnly.sol` — including the now-guarded B5 branches (both the `== feeWallet` and `== address(this)` disjuncts are hit).
- **L5 Halmos 0.3.3** — `halmos --contract AuxiloSplitRouterReceiveOnlySymbolicTest --function check_`: **6 passed, 0 failed, 0 timeout** (1.22s total). All proven exhaustively: `check_split_conservation` (contributor+fee==value, residue 0, all value ≤ 2^128, all bps), `check_fee_is_complement` (floor dust to fee — this SUBSUMES the bps=10000 extreme, so the original variant's lone SMT-division timeout is ELIMINATED, not merely corollary'd), `check_contributor_le_value`, `check_bps_zero_all_to_fee`, `check_nonce_binding_distinct`, and **`check_b5_guard_reverts_alias` (B5 PROVEN)**.
- **L1 Slither 0.11.5** — `slither AuxiloSplitRouterReceiveOnly.sol`: **0 results found** (3 contracts, 101 detectors).
- **Live testnet** — deployed to Base Sepolia at **`0x149C21BD3aC4364528fECceF29acf4Ec8ecf8145`** and exercised end-to-end (`script/SepoliaReceiveOnlyE2E.s.sol`). The live derived-nonce receive settle split 70/30 with router residue 0. Tx hashes (block 43701863, all status 0x1): deploy `0xd23b9a440f61755214e381d33bf5895d159f73fc7109a92896699740e8be2a03`, buyer-funding `0xc8f3a4fc1e55dc2baa5d700c77b2e4ec896621dd2f56b58baf859eb83df3f707`, `settleAndSplitReceive` `0x53155665f6c2af7bdb6da57a3ce123d3a72e37f13a351652738f3c1ba10a6767`. Independently verified on-chain: router USDC balance 0, immutables read back correct, contributor +700000 / feeWallet +300000 micro-USDC.

**Confidence delta (honest).** On the contract-logic axis this variant is *tighter* than the both-paths one: the SMT timeout is gone (all 6 symbolic checks close), B5 moves from "harness-excluded" to "proven," and F1 is not applicable. On the deployed-system axis the collapse is larger — the P6 100%-diversion ceiling, which was the honest headline dragging §5b to ~78%, is **structurally 0 here**, and F2 (the unbuilt stranded module that was a hard pre-mainnet gate) does not apply. The system's dominant loss scenario shifts from *settler-key theft* to *settler-key unavailability* (liveness), a materially milder failure class.

**Still deferred (unchanged by this variant — do not read the collapse as clearance).**
- **Paid external audit + written fintech-counsel R-01 sign-off** remain hard gates. This program shortens both; it replaces neither. The non-diversion property being structural (not merely argued) should make the R-01 characterization *cleaner*, but the legal conclusion is still counsel's, not a test result.
- **A1 (USDC is a Circle-upgradeable proxy)** — every PROVEN/FORK verdict is against FiatTokenV2_2 as deployed today; a Circle upgrade (hook, fee-on-transfer, changed nonce semantics) silently invalidates the proofs. Needs an off-chain impl-hash monitor + circuit-breaker. Applies identically here.
- **A3 (deploy-time constructor is the trust root, uncovered by every layer)** — a wrong-but-nonzero `feeWallet_`/`settler_` is permanent; only `usdc_` is code-pinnable. The A3 attestation checklist (canonical-USDC assert, fresh non-blacklistable feeWallet, bytecode verify, post-deploy read-back) is still required before any mainnet flag-enable.
- **A2 (no post-pull balance assertion)** and **P13 (EIP-1271 proven by mock, no real-USDC 1271 fork test)** carry over unchanged; both are liveness, not theft.
