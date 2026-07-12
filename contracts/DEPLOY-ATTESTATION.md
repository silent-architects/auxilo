# A3 — Deploy-Time Constructor Attestation (AuxiloSplitRouterReceiveOnly)

**Audit finding A3 / VERIFICATION.md §7–§8.** The contract is **immutable**. Its
constructor args — `usdc`, `feeWallet`, `settler` — are the **entire trust
root** and are **unrecoverable if wrong**. Every unit / fuzz / invariant / fork
/ symbolic test re-passes against whatever addresses `setUp()` uses, so **no
test can catch a wrong deploy arg**. A single wrong-but-nonzero `feeWallet`
sends 30–40% of *every* settlement to a typo/attacker address **forever**;
immutability means redeploy-and-abandon is the only remedy.

This checklist is the only control over that risk. **Run it in full and record
the sign-off before `X402_ROUTER_ADDRESS` is ever set.** Most of it is scripted:
[`scripts/deploy-attest.js`](../scripts/deploy-attest.js) (`preflight` before
deploy, `readback` after). The script exits non-zero on any hard failure.

> Live rehearsal, 2026-07-04: both phases run PASS against the Sepolia deploy
> `0x149C21BD3aC4364528fECceF29acf4Ec8ecf8145` (incl. immutable-aware bytecode
> match). The mainnet run is identical with `--chain 8453`.

---

## 0. Pre-conditions

- [ ] The exact source at `contracts/AuxiloSplitRouterReceiveOnly.sol` is the
      version that passed the verification program (VERIFICATION.md) — no
      uncommitted edits. `git status` clean for that file; record the commit.
- [ ] `forge build` has been run in `contracts/` so
      `out/AuxiloSplitRouterReceiveOnly.sol/AuxiloSplitRouterReceiveOnly.json`
      is fresh (the readback bytecode match reads it).
- [ ] `X402_ROUTER_RPC_URL` points at a Base **mainnet** RPC you trust (a
      compromised RPC can lie about reads — prefer your own node or a reputable
      provider; cross-check one value on a second RPC).

## 1. Provision a FRESH single-purpose `feeWallet`

- [ ] Generate a **brand-new** key used for nothing else (`cast wallet new`).
      It receives only Auxilo's platform fee. It must NOT be:
  - the shared custodial payout wallet `0xA19Cf92cc1daCf742f0E50b4128cAD3A86A81EC4`
    (current — Auxilo, LLC, rotated 2026-07-12) or the retired pre-LLC wallet
    `0x1BE960313c93b3aA0AA62BF33B300CAB48c36Ca6`,
  - the settler key, or
  - any wallet with prior history/approvals.
- [ ] Confirm you control it and have backed up the key (offline).
- [ ] A fresh wallet is chosen because a used address is more likely to have been
      Circle-**blacklisted** at some point; a blacklisted `feeWallet` makes every
      fee leg revert and, being immutable, bricks the router. The preflight
      checks `isBlacklisted(feeWallet)` and the nonce (expects 0).

## 2. Provision the `settler` key (F5)

- [ ] `settler` is a **dedicated, isolated** key — NOT `WALLET_PRIVATE_KEY`
      (the shared custodial payout key). Provision it in an HSM/KMS or behind a
      threshold/multisig signer. It is passed to the running server as
      `X402_SETTLER_PRIVATE_KEY`; `lib/x402-router.js` **fails closed** if it is
      unset. `settler` is immutable → rotation is redeploy-only; rehearse that
      runbook (README.md §5).

## 3. PREFLIGHT (before deploy)

```sh
node scripts/deploy-attest.js preflight \
  --chain 8453 \
  --usdc 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  --fee  <FRESH_FEE_WALLET> \
  --settler <SETTLER_ADDRESS>
```

Must be **all ✓** (exit 0):

- [ ] `usdc` == canonical Base mainnet USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- [ ] `feeWallet` ≠ `settler`, ≠ `usdc`, ≠ platform custodial wallet
- [ ] `settler` ≠ platform custodial wallet
- [ ] USDC implementation == pinned `0x2ce6311ddae708829bc0784c967b7d77d19fd779` (A1 tie-in)
- [ ] `feeWallet` is NOT USDC-blacklisted
- [ ] `feeWallet` nonce == 0 (fresh) — a WARN here is a stop-and-think, not an auto-pass
- [ ] **Save the printed ATTESTATION RECORD**; a second person eyeballs the three
      addresses character-by-character and signs off.

## 4. Deploy

- [ ] Deploy `AuxiloSplitRouterReceiveOnly` with **exactly** the attested args,
      in the attested order `(usdc, feeWallet, settler)`. Record the deploy tx
      hash and the resulting router address.

## 5. Source verification (Basescan)

- [ ] Verify the source on Basescan so the immutables and logic are publicly
      auditable:

```sh
cd contracts
forge verify-contract <ROUTER_ADDRESS> \
  src/AuxiloSplitRouterReceiveOnly.sol:AuxiloSplitRouterReceiveOnly \
  --chain base --watch \
  --constructor-args $(cast abi-encode "constructor(address,address,address)" \
     0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 <FEE_WALLET> <SETTLER>)
```

- [ ] Basescan shows the contract **Verified** and the decoded constructor args
      match the attestation record.

## 6. READBACK (after deploy, before the flag)

```sh
node scripts/deploy-attest.js readback \
  --chain 8453 --router <ROUTER_ADDRESS> \
  --usdc 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  --fee  <FEE_WALLET> \
  --settler <SETTLER_ADDRESS>
```

Must be **all ✓** (exit 0):

- [ ] on-chain `usdc` / `feeWallet` / `settler` each equal the attested values
- [ ] on-chain `usdc` is canonical
- [ ] **deployed runtime bytecode matches the audited artifact** (immutable-aware
      compare) — this is the on-chain proof that what you deployed is the code
      that was verified, not a look-alike

## 7. Sign-off gate

- [ ] Preflight PASS, Basescan Verified, Readback PASS — all three recorded.
- [ ] A1 monitor pinned to this chain returns OK (`node scripts/usdc-impl-monitor.js`).
- [ ] Confirmation-depth policy configured (VERIFICATION.md §10 / README §"Confirmation depth").
- [ ] Only now set `X402_ROUTER_ADDRESS=<ROUTER_ADDRESS>` (and `X402_ROUTER_CHAIN_ID=8453`).

**If ANY check fails, the flag stays unset.** A wrong immutable is permanent —
there is no post-flip remedy but redeploy.
