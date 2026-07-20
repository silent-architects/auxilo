# tests/ — legacy A-series harnesses (pre-`node --test`)

**Status: LEGACY, with one live exception.** `test-mobile-nav-overlay.js` is
the DR-1 regression test (PUNCH-LIST §31) and IS wired into `npm test` — by
explicit direct invocation (`node tests/test-mobile-nav-overlay.js`) appended
after the `node --test test/*.test.js` run, never via a `tests/*.js` glob.
Its Tier-1 (static CSS/DOM) checks always run; Tier-2 (Playwright-driven)
runs whenever `playwright` is resolvable (a devDependency), which is every
CI run (`.github/workflows/ci.yml` installs Chromium + sets
`CI_REQUIRE_TIER2=1`, which fails the build if Tier-2 would silently skip)
and optionally on a local machine that has installed the dep. Everything
else in this directory follows the LEGACY rule below.

**Everything else: nothing else in this directory is wired into CI or
`npm test`.** New tests go in `test/*.test.js`, never here.

These other files are the original SPEC-A0…A4 verification harnesses
(custom runTest/runAsyncTest pattern, direct `node tests/<file>` invocation).
They are kept as historical verification records per the never-delete doc
rule; several have drifted from the code they grep.

## Inventory (verified 2026-07-19, LW-10 cleanup)

| File | Verdict | Detail |
|---|---|---|
| `test-a0-unit.js` | **RETIRED — hangs** | Hangs after T-A0-UNIT-007 (mocked RPC promise never resolves under the proxyquire viem fake). tx-manager behavior is covered by `test/` suites (wave1/backup-runner era). Do not run. |
| `test-a1-unit.js` | stale | 13/14 pass; T-A1-UNIT-006 greps for a source shape (`createReservation`) the withdrawal flow no longer has. |
| `test-a2-unit.js` | passes | 2026-07-19: exit 0. |
| `test-a2-adversarial.js` | stale | 5/7 pass; ADV-005/006 grep source patterns (WAL tmp-rename spelling, refund guard shape) that evolved. |
| `test-a3-unit.js` | passes | 2026-07-19: exit 0. |
| `test-a3-adversarial.js` | passes | 2026-07-19: exit 0. |
| `test-a3-integration.js` | needs live server | Spawns the server and fetches; fails closed without a bootable local env. |
| `test-a3-sec.js` | needs live server | Same class as a3-integration. |
| `test-a4-unit.js` | stale | 25/26 pass; T-A4-INT-003 greps a log string the x402 fallback no longer emits. |
| `test-sensitivity-filter.js` | passes | 2026-07-19: exit 0. Superseded by `test/sensitivity-filter.test.js` + `test/p2-1a-sensitivity-filter-v04.test.js` for CI purposes. |
| `test-mobile-nav-overlay.js` | **CI-WIRED (live exception)** | DR-1 regression (PUNCH-LIST §31). Tier-1 always runs; Tier-2 runs when `playwright` resolves (devDependency, installed every CI run). See the exception note above -- not part of the LEGACY rule. |
| `helpers/` | support | mock-chain.js / test-wallet.js used by the A-series harnesses only. |

## Historical note (stale PUNCH-LIST references)

The LW-10 row named `tests/test-mcp-regression.js` (dead legacy-host BASE_URL +
stale v0.5.0 assertion) and `tests/test-eip712-negative.js` (hanging). **Neither
file exists in the tree** — they did not survive the 2026-07-01 repo
reconciliation (main was rebuilt from the deployed Fly image). The BASE_URL /
version-assertion fixes they needed are therefore moot; MCP regression coverage
lives in `test/mcp-auth-fix.test.js` and the aud19 suites.

## Live-coverage pointers (Wave 5C, 2026-07-19)

Client installer/runner coverage that would once have landed here lives in
`test/wave5c-client-closures.test.js` (CI-wired via `npm test`):
consent-gate integration (cmdSetup subprocess, mutation-verified — PUNCH-LIST
§18b N3), the adapter read-size cap (base-path `readSessionCapped`, 64MB
default / `AUXILO_MAX_SESSION_BYTES` — N1), and the Google Drive/Docs ID
client-scrub parity test (SKIPS LOUDLY until the Wave-5B sensitivity-filter
pattern merges, then enforces automatically).

## Running (manual only, except test-mobile-nav-overlay.js)

```
node tests/<file>.js        # direct; each prints its own pass/fail summary
```

`test-mobile-nav-overlay.js` also runs automatically via `npm test` (see the
exception note above); every other file in this directory is manual-only.

Do NOT add the legacy A-series files to `package.json` test globs: a0 hangs,
and the two integration files require a live server. `test-mobile-nav-
overlay.js` is wired in by explicit direct invocation instead of a glob, so
it doesn't carry that risk.
