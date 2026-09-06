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
EXPECTED_TEST_COUNT=2030
# ──────────────────────────────────────────────────────────────────────────

echo "── check-test-count: running the node:test suite (test/*.test.js) ──"
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
