#!/usr/bin/env bash
# ─── check-test-count.sh — F7c discovered-test-count drift guard ─────────────
#
# Runs the full node:test suite (test/*.test.js) and BLOCKS the build if the
# runner's own summary footer (`ℹ tests <N>`) does not exactly match the
# pinned EXPECTED_TEST_COUNT below.
#
# Root cause this guards against (PUNCH-LIST §30 residual F7c): `npm test`
# used to run with --test-force-exit, which process.exit()s the top-level
# runner the instant it believes every spawned test-file child process has
# reported completion. Under ordinary system load that belief can outrun
# reality — the parent's IPC channel from the slowest-finishing child can
# still have that child's LAST batch of subtest results in flight (received
# but not yet dispatched through the parent's message handler, or the child
# itself force-exiting before its own final IPC write flushes) when
# force-exit fires. Those trailing subtests are never marked failed, never
# skipped, never cancelled — they are just silently never counted. 0-fail,
# wrong total, no signal.
#
# Confirmed empirically (2026-07-20, macOS, Node v24.13, 8 cores): sequential
# `node --test --test-force-exit test/*.test.js` runs wandered between 1266
# (correct) and as low as 1242–1260 depending on system load, always 0 fail.
# The missing tests were always the TAIL (last-declared describe/it blocks)
# of exactly one file per bad run — but WHICH file varied run to run
# (test/wave5a-money-closures.test.js's trailing GTM-9 block in one run,
# test/aud19-funnel.test.js's trailing link-wallet describes in another) —
# i.e. whichever child happened to lose the force-exit race that run, not a
# defect in either file's own tests.
#
# The real fix is that --test-force-exit is now GONE from `npm test` (see
# package.json) — removing it lets the runner's own event loop drain
# naturally instead of racing ahead of it. This was verified NOT to be
# masking a genuine hang in this repo: 10+ consecutive un-flagged runs all
# exited cleanly on their own within single-digit-to-low-teens seconds
# (comparable to, sometimes faster than, the force-exit runs) with the
# identical full count every time. This script is the tripwire against that
# whole class recurring (e.g. if --test-force-exit or an equivalent
# short-circuit ever gets reintroduced for a future hang) and, just as
# usefully, against an ordinary test addition/removal landing without
# updating the pin below in either direction.
#
# ── TO BUMP THE PIN ──────────────────────────────────────────────────────
# Run `npm test`, read the `ℹ tests <N>` line from the summary footer, and
# set EXPECTED_TEST_COUNT to N below, in the SAME commit that adds/removes
# tests. A pin that's stale in either direction is exactly the silent drift
# this guard exists to prevent — don't lower it to make a failure go away
# without first confirming the missing tests are gone on purpose.
# ────────────────────────────────────────────────────────────────────────
#
# Usage:   bash scripts/check-test-count.sh
# Wired as the BLOCKING "Run tests" replacement — see .github/workflows/ci.yml
# (job: test). Safe to run locally too; behaves identically to `npm test`
# plus the pin check, no extra local setup (no playwright/Tier-2 dependency
# — this only ever touches test/*.test.js).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# ─── THE PIN — bump this in the same commit that adds/removes tests ─────────
# integ (agent/assembly-0915): merges agent/mcp-0915 (0.9.15,
# EXTRACTION-CHILD-HOOKS: +17 tests — --setting-sources isolation +
# cli-settings-isolation-unsupported fallback/cache, getClaudeCliVersion,
# EXTRACTION-RUN-LOG provider-run log line, runAnchoredJudge
# judgeAttempted/judgeSucceeded) onto pm/integ-v (2665, post SITE-PERFECT-W1/W2).
# Verified against the actual `npm test` discovered count post-merge below:
# 2665 (pm/integ-v) + 18 new tests from agent/mcp-0915 (0.9.15
# EXTRACTION-CHILD-HOOKS: --setting-sources isolation/fallback/cache,
# getClaudeCliVersion, provider-run log line, judgeAttempted/judgeSucceeded,
# plus the extraction-zero-tool-calls STATIC pin split into 2 asserts on
# merge) = 2683.
#
# agent/footnote-sup-waitlist (base cacb665, 2693): FOOTNOTE-SUP added 1
# static assertion to test/fb-accrual-sentence.test.js (the href="#" /
# aria-describedby / id count pin). WAITLIST-DEAD-CODE removed the POST
# /waitlist route and rewrote test/waitlist.test.js's structural section —
# net +2 there (3 removed source-string assertions for the deleted route,
# 2 replacement assertions for the surviving GET /waitlist/count + purge
# wiring, plus a new 4-test staged-server section C proving the 404 and
# the public/ waitlist-string sweep). Verified against the actual
# `npm test` discovered count: 2693 + 1 + 2 = 2696.
#
# agent/fb-control-rev2 (base 7932958, 2696): FB-CONTROL-REV2 added
# test/fb-control-rev2.test.js — 6 static-file assertions (new label once
# as the section h2, old label gone, old h2 gone, old body gone / new body
# once with its page link, section keeps its id + background-alternation
# class, page h2 count still 7) plus 1 served-route assertion (staged
# server, mirroring test/fb-accrual-sentence.test.js). Verified against
# the actual `npm test` discovered count: 2696 + 7 = 2703.
# agent/fb-hero-stats (base pm/integ-y 35189e3, 2778): FB-HERO-STATS-MOBILE
# added 2 assertions to test/ask-wave.test.js (the deliberate
# ".pull-stat-num gold TEXT ... is not counted as a gold-fill event" case,
# once per viewport) and re-armed the existing /for-builders 375x812 (iii)
# fold case (already counted pre-change, no new test — was skipped, now
# runs). Verified against the actual `npm test` discovered count:
# 2778 + 2 = 2780.
#
# agent/ask-final (base pm/integ-y e0a6111, "integ: + FB-HERO-STATS-MOBILE
# (builder pass; ruled CSS applied in the final micro)"): the pin above was
# already 1 test stale on that base BEFORE this micro touched anything —
# `node --test --test-reporter=tap test/*.test.js` on the unmodified base
# reports 2781 discovered, not 2780 (4 failing overall: 3 in-scope here --
# the / (iii) fold case on the stale `#install` selector, and the two
# ask-wave-a.test.js footer-label assertions pending the SITE-PM ruling --
# plus 1 out-of-scope pre-existing asset-hash failure, unchanged by this
# micro). This micro's edits (the ruled hero-stats CSS, the / fold
# selector fix, the wave-A footer-label re-pin) fix the 3 in-scope
# failures and add/remove no `it()` blocks -- discovered count stays 2781,
# now pass-clean except that same 1 pre-existing asset-hash failure
# (pending the PM's hash rewrite) and 1 pre-existing, unrelated skip.
# Re-pinning to the actual count rather than carrying the stale drift
# forward. Wave continued (ASK wave A/B/C, PRICE guard) to main's tip at
# 2783 (see PUNCH-LIST for the per-wave breakdown) — that is the pin this
# branch's base (agent/mcp-0916-fix2's merge-base c1e06ec, 2711) diverged
# from.
#
# agent/mcp-0916-fix2 (base c1e06ec, 2711): RUNNER-AUTO-UPDATE added
# test/runner-auto-update.test.js — 38 new tests (semver-min, tar-extract,
# integrity/signature verification incl. a golden fixture against the real
# npm registry's live signing key, cadence stamp, in-flight lock, the
# installer.installRunner binRootOverride staging seam, runner-config
# read/write, all 8 BUILD-SPEC §5 orchestrator scenarios, the `auxilo
# status` Auto-update line pure-render + CLI integration). No other test
# file's count changed (envelope-0831/prepublish-guard version-string
# fixtures were value edits, not test additions/removals).
#
# agent/assembly-0916 (this merge, main f687402 x agent/mcp-0916-fix2
# 2fc2b69): two independent test-count deltas off the same base (c1e06ec,
# 2711) combine, neither branch touching the other's test files. Analytic
# estimate (main 2783 + branch's 38 RUNNER-AUTO-UPDATE tests = 2821) undershot
# the real post-merge total — main's own tip pin (2783) was itself carrying
# more in-tree tests than its comment math accounted for. Re-pinned to the
# actual post-merge `bash scripts/check-test-count.sh` discovered count
# (isolated HOME, --test-reporter=tap, test/*.test.js only): 2863, 0 fail,
# 6 skipped (pre-existing, unrelated to this merge).
# agent/mcp-0917 (base 5be93b8, 2866): MCP-SERVER-STALENESS added
# test/mcp-server-staleness.test.js — 38 tests covering registerMcp pinning
# per client format (json-mcpServers/json-dropin/opencode/amp/openhands-stdio/
# toml-codex), mcpPinnedVersion, rewriteMcpPins (the self-update re-pin path,
# including foreign-entry and malformed-config skip cases), stageAndSwap's
# call into the extracted tree's rewriteMcpPins, getStatus pin/staleness
# fields, the `auxilo status` CLI pin line, and mcp-server.js's startup
# version-skew notice. No other test file's assertion COUNT changed (two
# pre-existing hardcoded-version assertions in test/prepublish-guard.test.js
# and test/envelope-0831.test.js were updated to the new 0.9.17 value/a
# dynamic package.json read, not added or removed). Verified against the
# actual `npm test` discovered count (run twice, identical both times):
# 2866 + 38 = 2904, 0 fail, 6 skipped (pre-existing, unrelated).
#
# 0.9.17 FIX PASS (F1/F2/F3, same test file): +11 tests covering the review
# findings — F1 in-place command/args patching preserves user keys/order
# (json-mcpServers x2, opencode, amp, openhands-stdio = 5), F2 config
# writers preserve the existing file mode (json-mcpServers, writeJsonAtomic,
# toml-codex x2 = 4), F3 unique tmp names + stale-tmp sweep (2). Verified
# against the actual `npm test` discovered count (run twice, identical both
# times): 2904 + 11 = 2915, 0 fail, 6 skipped (pre-existing, unrelated).
# agent/assembly-0917 (this merge, main b9d241f x agent/mcp-0917-fix
# 6578d14): two independent test-count deltas off the same base (5be93b8,
# 2866) combine, neither branch touching the other's test files. main added
# 2 tests (test/wave-e3.test.js, test/works-with.test.js) for the
# COPY-UNGATED-SUPPORTED-CLIENTS revert (2866 -> 2868); the mcp-0917-fix
# branch added 49 (2866 -> 2915, per the history above). Analytic estimate
# 2868 + 49 = 2917. Re-pinned to the actual post-merge
# `bash scripts/check-test-count.sh` discovered count (isolated HOME,
# --test-reporter=tap, test/*.test.js only) below.
#
# 0.9.18 (MCP-PIN-LEGACY-OWNED): +21 for the new
# test/mcp-pin-legacy-owned.test.js (2917 -> 2938) — per-format legacy-bare-
# shape coverage (pin-in-place, extra-arg-is-foreign, idempotent) across all
# six MCP config formats plus a multi-client rewriteMcpPins() end-to-end run.
#
# SITE-RESTRUCTURE-W3 item A (FAQ consolidation, 2026-09-07): +30 for the
# new test/faq-consolidation.test.js (2938 -> 2968) — per-page expected-
# question-list assertions (rendered + JSON-LD), JSON-LD<->DOM equality per
# page, site-wide no-duplicate-question checks, and positive controls for
# every cut/moved question, covering the 31->18 FAQ consolidation across
# all six FAQ-bearing pages. test/site-system.test.js and
# test/site-perfect-w2.test.js and test/ask-wave-b.test.js were edited in
# place (assertions updated/narrowed for the new state), not added to or
# removed from, so they contribute no net delta. Verified against the
# actual `bash scripts/check-test-count.sh` discovered count (isolated
# HOME, --test-reporter=tap, test/*.test.js only), run 4 times: 2968, 0
# fail each time except one transient flake in test/x402-router.test.js's
# 2-second _waitForFinality timeout tests (pre-existing, unrelated to this
# wave — not touched) that did not reproduce on 3 immediate reruns.
#
# BUILD-SPEC-0919 (agent/0919-devin-cursor, base pm/integ-devin-0919 @
# 0dbdd41, inherited pin 3035): +20 for the new
# test/devin-cursor-0919.test.js — Cursor stop-hook registry/writer
# coverage, the windsurf->Devin registry rename (incl. dual-dir detection),
# and the new scripts/sources/devin.js poll adapter (registration/packaging
# closure, the EXTRACTABLE_SOURCES windsurf->devin swap, detect(),
# discover-filters-agent-only-DBs, since + -wal/-shm handling, streaming-
# chunk reassembly, unknown model provenance, and three best-effort/
# never-throw paths). test/wave3-client-funnel.test.js's existing UC-3
# dynamic-SOURCES-registry test had 'devin' added to its static expected-id
# list (value edit, not a new test — no count change). 3035 -> 3055.
#
# Also required to make `bash scripts/check-test-count.sh` pass, though not
# itself a test-count change and not named by this wave's spec: the
# package.json 0.9.18->0.9.19 bump has two companions the spec omitted but
# the suite enforces — openapi.json's info.version (test/envelope-0831.test.js
# + test/r01-launch-blockers.test.js both assert it equals package.json's
# version) and four hardcoded '0.9.18' literals in
# test/prepublish-guard.test.js's fixtures/assertions (the same drift class
# its own header comment already documents recurring at the 0.9.6 and
# 0.9.17 bumps). Verified against the actual `bash scripts/check-test-count.sh`
# discovered count (isolated HOME, --test-reporter=tap, test/*.test.js
# only): 3055, 0 fail.
#
# BUILD-SPEC-0920 (agent/0920-copilot, base pm/integ-0920 @ a2cd3c9, inherited
# pin 3055): +16 for the new test/copilot-0920.test.js — the new
# scripts/sources/copilot.js dedicated parser for GitHub Copilot CLI's typed
# events.jsonl (registration/packaging closure incl. RUNNER_STACK + sweeper
# manifest + EXTRACTABLE_SOURCES, detect(), discoverSessions() poll + since
# handling, [user]/[assistant] reconstruction, transformedContent ignored,
# empty-content tool-call turns skipped, non-conversation types ignored,
# real on-disk model provenance from session.start.selectedModel with
# last-assistant.message.model fallback, in-file sessionId override,
# malformed-line/non-object-line/unreadable-file/no-turns best-effort paths,
# poll-only registerSessionEndHook). test/wave3-client-funnel.test.js's
# existing UC-3 dynamic-SOURCES-registry test had 'copilot' added to its
# static expected-id list, nine->ten adapters (value edit, not a new test —
# no count change). package.json 0.9.19->0.9.20 bump's usual companions
# (openapi.json info.version, mcp-server.js, .well-known/agent.json, and the
# four hardcoded version literals in test/prepublish-guard.test.js) were
# applied in the same commit. 3055 -> 3071.
#
# GOTCHA (not a test-count factor, but blocks this script if missed): a
# fresh `git worktree add` does NOT carry node_modules (untracked, per
# worktree) — running this script straight after `git worktree add` fails
# ~340 tests short of the pin (59 real failures + 217 cancelled-by-parent +
# a handful skipped) via cascading `Cannot find module 'hono'` /
# `Cannot find module 'jose'` MODULE_NOT_FOUND errors (lib/accounts.js and
# the server-route test files require them). Confirmed by stashing every
# 0920 change and re-running against the untouched pm/integ-0920 base in
# the same node_modules-less worktree: identical 59 fail / 217 cancelled —
# i.e. this is a worktree-setup gap, not a base-branch regression. Fix:
# `npm ci --no-audit --no-fund` in the new worktree before running any test
# battery. Verified against the actual `bash scripts/check-test-count.sh`
# discovered count post-`npm ci` (isolated HOME, --test-reporter=tap,
# test/*.test.js only): 3071, 0 fail, 6 skipped (pre-existing, unrelated).
#
# EPC2-1 PROMPT BUNDLE: +20 tests — 14 byte-equivalence/version/digest tests
# in test/epc2-1-prompt-byte-equivalence.test.js, +3 npm RUNNER_STACK closure /
# copied-tree / derived-enumeration tests, and +3 sweeper manifest closure /
# copied-tree / derived-enumeration tests. Full-suite verification below pins
# the post-build discovered total at 3091.
EXPECTED_TEST_COUNT=3091
# ──────────────────────────────────────────────────────────────────────────

echo "── check-test-count: running the node:test suite (test/*.test.js) ──"

# TEST-HOME-ISOLATION: this script is the actual CI-blocking gate (wired
# directly into .github/workflows/ci.yml — NOT through `npm test`, so
# scripts/test/run-isolated.js's isolation never runs for this invocation
# unless duplicated here). A fresh mkdtemp'd dir stands in as both
# AUXILO_HOME (scripts/providers/{byo-key,index}.js's dedicated seam) and
# HOME (what every other os.homedir()-based path in this repo actually
# reads) for the whole run, so a test that forgets its own override still
# cannot reach the operator's real ~/.auxilo or ~/.claude. Cleaned up on
# every exit path via the trap.
#
# Tradeoff: a handful of tests are genuine self-checks of THIS machine's
# real installed state (a LaunchAgent plist, a counsel-draft file) — under
# this isolated HOME they always see an empty temp dir and always skip. Run
# `npm run test:host` (scripts/test/run-host.js) on the operator's own
# machine to actually exercise those checks against real installed state.
AUXILO_TEST_REAL_HOME="${HOME}"
AUXILO_TEST_HOME="$(mktemp -d)"
trap 'rm -rf "${AUXILO_TEST_HOME}"' EXIT
export AUXILO_HOME="${AUXILO_TEST_HOME}"
export HOME="${AUXILO_TEST_HOME}"

# RUNNER-AUTO-UPDATE (0.9.16): scripts/runner.js's main() now makes a real
# registry.npmjs.org network call (offline-tolerant, but still a call) past
# the kill-switch+recursion-guard checks unless opted out. This is the other
# suite entry point (see the matching comment in scripts/test/run-isolated.js)
# so it needs the same suite-wide opt-out — a test that forgets its own
# override must not reach the real network. lib/runner-autoupdate.js's own
# unit tests exercise the real check logic in-process with an injected
# fetchImpl and are unaffected by this env var.
export AUXILO_RUNNER_AUTOUPDATE="0"

# Playwright resolves its browser cache under $HOME by default
# (~/Library/Caches/ms-playwright on macOS, ~/.cache/ms-playwright on
# Linux) -- the HOME override above would otherwise make test/sheet9-
# fixups.test.js's Tier-2 suite think the browsers CI just installed
# (`npx playwright install chromium`, which runs under the REAL HOME,
# before this script) are missing. Point PLAYWRIGHT_BROWSERS_PATH at the
# REAL home's cache (read-only from here) so the isolated HOME doesn't
# shadow it.
if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
  case "$(uname -s)" in
    Darwin) export PLAYWRIGHT_BROWSERS_PATH="${AUXILO_TEST_REAL_HOME}/Library/Caches/ms-playwright" ;;
    *)      export PLAYWRIGHT_BROWSERS_PATH="${AUXILO_TEST_REAL_HOME}/.cache/ms-playwright" ;;
  esac
fi

# --test-reporter=tap is pinned EXPLICITLY (not left to node's ambient
# default) so the summary-footer format this script parses ("# tests N")
# is stable across node versions and TTY/non-TTY contexts -- the default
# reporter's own default has differed by node version and by whether stdout
# is a TTY, which would otherwise make the grep below silently stop
# matching (and this guard is not allowed to fail silently either).
OUTPUT="$(node --test --test-reporter=tap test/*.test.js 2>&1)"
TEST_EXIT=$?

echo "${OUTPUT}"

ACTUAL_TESTS="$(echo "${OUTPUT}" | grep -E '^# tests ' | tail -1 | awk '{print $3}')"
ACTUAL_FAIL="$(echo "${OUTPUT}" | grep -E '^# fail ' | tail -1 | awk '{print $3}')"
ACTUAL_PASS="$(echo "${OUTPUT}" | grep -E '^# pass ' | tail -1 | awk '{print $3}')"

echo ""
echo "── check-test-count: verdict ──"

FAILED=0

if [ "${TEST_EXIT}" -ne 0 ]; then
  echo "  ❌ node --test exited ${TEST_EXIT} (non-zero) — ${ACTUAL_FAIL:-?} failing test(s), see output above"
  FAILED=1
fi

if [ -z "${ACTUAL_TESTS}" ]; then
  echo "  ❌ could not parse the '# tests <N>' TAP summary line from node --test output — reporter format changed?"
  FAILED=1
elif [ "${ACTUAL_TESTS}" -ne "${EXPECTED_TEST_COUNT}" ]; then
  echo "  ❌ TEST-COUNT DRIFT: expected ${EXPECTED_TEST_COUNT} discovered/executed tests, got ${ACTUAL_TESTS}"
  if [ "${ACTUAL_TESTS}" -lt "${EXPECTED_TEST_COUNT}" ]; then
    echo "     Fewer tests ran than pinned — tests may be silently failing to"
    echo "     register/execute (the F7c class this guard exists to catch)."
    echo "     Do NOT just lower the pin — find out which tests went missing"
    echo "     first (diff sorted '✔/✖' lines between a passing run and this one)."
  else
    echo "     More tests ran than pinned — if this is an intentional test"
    echo "     addition, bump EXPECTED_TEST_COUNT in scripts/check-test-count.sh"
    echo "     to ${ACTUAL_TESTS} in the same commit."
  fi
  FAILED=1
else
  echo "  ✅ ${ACTUAL_TESTS} tests discovered/executed (pass ${ACTUAL_PASS:-?}, fail ${ACTUAL_FAIL:-0}) — matches the pin"
fi

echo ""
if [ "${FAILED}" -ne 0 ]; then
  echo "🛑 check-test-count FAILED"
  exit 1
fi

echo "✅ check-test-count PASSED"
exit 0
