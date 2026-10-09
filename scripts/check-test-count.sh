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
# CLI-BINARY-RESOLUTION: +15 tests (T1–T15) for version-ranked resolution,
# native CLI provenance, known-old auth gating and setup path persistence.
# Verified post-build discovered count: 3106 (3100 pass, 0 fail, 6 skipped).
# CODEX-ROUTE-ISOLATION: +16 tests (T1–T16) for isolated argv/env/cwd,
# skill-mention transport encoding, fail-closed JSONL auditing and cleanup.
# TRUSTED-PUBLISHING: +8 OIDC guard cases and +8 workflow/fixture cases
# (T1–T15); the local token guard remains covered by its existing tests.
# CLAUDE-CHILD-MCP-CONTEXT Parts A+B: +12 tests (T1–T6, selection no-fallback,
# TB1–TB5) for MCP isolation, wrapper decoding and strict Codex output schemas.
# D1-SITE-COPY: +6 tests (T1–T6) for boundary placement, retired Codex-drafting
# wording, approved docs literals, preserved capture claims, FAQ parity/JSON-LD,
# and punctuation/marketplace exclusions.
#
# CH-7 (site/launch-wave-0926 integration, base 3169): the wave's four new
# test files (launch-wave-emails/for-agents/for-builders/home.test.js) each
# had a describe-body assert or describe-scope assert-bearing-helper call
# flagged by test/ch7-describe-body-guard.test.js (silently swallowed under
# npm test's flags — fail 0/exit 0 even when the assertion is false). Fixed
# by relocating each into a real test-harness frame (a before() hook for
# data shared by static it() blocks; a module-scope function declaration for
# the emails.test.js `slice` helper, since it is only ever CALLED from
# inside it() bodies and a plain function DEFINITION never executes at
# describe time; a non-asserting `faqJsonLdEntriesCore` for for-builders.
# test.js's per-entry dynamic-it()-generation loop, paired with a new it()
# that exercises the real asserting `faqJsonLdEntries`) — net +1 test.
# Also added 3 sanity guards (assert an array is non-empty before a loop
# that is the test's only assertion) against the same silent-pass class the
# guard does not scan for. Verified against the actual `npm test` discovered
# count, run twice, identical both times: 3169 -> 3436, 0 fail, 6 skipped
# (pre-existing, unrelated).
#
# site/launch-wave-0926 close-out: f4329cb (+30/-1) and 5021755 (+12), both
# already on this branch, bring the pin to 3436 -> 3477; A1's api.html/
# how-it-works.html fix nets 0 (one assertion replaced). Verified twice: 3477.
#
# Part D brand-gate rows D1-D5 (openapi.json/agent-card description parity;
# "AI"->"agents" on how-it-works/pricing/index; sitewide standalone-"AI"
# guard): +18 assertions, 0 removed. 3477 -> 3495, verified twice.
#
# FIX-UNIT-2 + FIX-UNIT-2B (site/launch-wave-0926 final visual QA + one FAQ
# item, base 3495): +56, 0 removed. All 56 are in the one new file
# test/launch-wave-fixes-visual.test.js (header-clearance/earnings-highlight/
# trust-page-secondary-style/button-height/contrast/skip-link/heading-
# hierarchy/heading-<br>-sweep fixes, the FIX-UNIT-2B heading corrections
# H1-H5, and the new /for-builders FAQ item Q-01 REV 2). Every other file
# touched by this pass (test/mobile-header-offset.test.js,
# test/launch-wave-emails-e2e.test.js, test/faq-consolidation.test.js,
# test/launch-wave-for-builders.test.js, test/trust-page.test.js) had only
# existing it() bodies/pinned values edited to the new deliberate state, no
# it() blocks added or removed. Verified against the actual `npm test`
# discovered count, run twice, identical both times: 3495 -> 3551, 0 fail,
# 6 skipped (pre-existing, unrelated).
#
# EMAIL-FONT-REGRESSION fix (PM-found, on top of committed FIX-UNIT-2/2B,
# base 3551): renderEmail() (lib/email.js) set font-family only on the
# wordmark cell and the button, so every email's heading/body/footer fell
# back to the mail client's serif default. Fixed by adding font-family to
# <body>, the content cell, the heading <p>, and the footer cell. +4 tests,
# all in the one new file test/launch-wave-email-font.test.js (static
# per-body font-family assertions across all five rendered emails, a
# rendered/Playwright check with network fully blocked, and a positive
# control proving that check can fail). 0 removed. Verified against the
# actual `npm test` discovered count: 3551 -> 3555, 0 fail, 6 skipped
# (pre-existing, unrelated).
#
# VISION PASS (SITE-PM, 2026-09-27, BUILD-BRIEF-VISION.md): the excuse/
# usage-number cut across /, /for-builders, /for-agents, /how-it-works,
# /pricing, and the dashboard. New: test/vision-pass-guard.test.js (the
# brief's Part B guard, plus the S-3 non-empty-ledger proof) and
# test/vision-dashboard-payout-panel.test.js (V-27/V-28/V-33, the payout
# panel's non-paused branch, driven via a network mock per the brief).
# Updated in place (net test-count deltas, not just re-pins): launch-wave-
# for-builders.test.js (+2: V-12's new sentence gets its own check, and the
# math block section grows from one byte-for-byte pin into four V-07/V-08-T/
# V-09-T checks), builders-strip-zeros.test.js (net +5: the retired ledger-
# strip suite is replaced by absence + S-2-no-longer-fires checks, plus new
# V-29/P-3 checks), site-restructure-w3-c.test.js and pricing-live-range.
# test.js (the pricing hero ledger tile's presence checks become absence
# checks, same test count), wave-e-fix.test.js and launch-wave-dashboard.
# test.js and title-case-sweep.test.js (pin updates only, same count),
# strip-date-hook.test.js (the retired as-of suite replaced by absence
# checks, same count). Verified against the actual `npm test` discovered
# count: 3555 -> 3646, 0 fail, 6 skipped (pre-existing, unrelated).
#
# Coordinator fixes F1-F4 (2026-09-27), same wave: +3, all in
# test/vision-pass-guard.test.js's new F4 describe block (the two
# reference-line reason-clause checks, api.html and llms.txt, plus one
# sanity test that openapi.json/status.html/the trust page are untouched).
# F1/F2/F3 changed CSS/markup only, no test added or removed for those three
# (F1's hero-padding change updated one existing pin in test/mobile-header-
# offset.test.js's EXPECTED_1440_H1_TOP map, not a count change). Verified
# against the actual `npm test` discovered count: 3646 -> 3649, 0 fail, 6
# skipped (pre-existing, unrelated).
# AUD-CAC / credits-as-cash (2026-09-27): +71 across four test files —
# test/credits-as-cash-lots.test.js (48, lot schema/caps/holds/flag/never-do),
# test/credits-as-cash-unlock.test.js (8, staged-server dollar-lot accrual
# math), test/credits-as-cash-refunds.test.js (12, Part 2 refunds/disputes),
# and 3 new assertions in test/credits-control-part1.test.js (cap check,
# account-hold gate, flag-read-once wiring). Verified against the actual
# discovered count: 3649 -> 3720, 0 fail, 6 skipped (pre-existing, unrelated).
# CREDITS-FOLLOWUP-ONE-BALANCE (2026-09-27): the switch and the old
# unit-credit model are removed (lib/credits-flag.js, lib/unlock-attribution.js
# deleted; addPurchasedCredits/refundCredit/ensureUnlockLots/consumeUnlockLot/
# deriveLegacyUnitPrice deleted from lib/credits.js). test/credits.test.js,
# test/aud19-2-econ.test.js, test/credits-as-cash-lots.test.js,
# test/credits-as-cash-unlock.test.js, test/credits-control-part1.test.js,
# test/wave1-money-closures.test.js, test/dr8-self-unlock-free.test.js,
# test/wave2b-ops-hardening.test.js, test/launch-wave-emails.test.js,
# test/envelope-0831.test.js, test/ci5-scope-enforcement.test.js,
# test/r13-close.test.js, test/spec3-e1-account-vocab-runtime.test.js,
# test/spec3-f1-neardup-runtime.test.js and test/spec3-g1-private-visibility.test.js
# each retire or update the tests that pinned that model (unit-lot spend/grant,
# the 30-day repeat-accrual cap, and the capped-repeat projection's own
# buyer-facing strip site, each named in its file with its reason); a new
# test/credits-one-balance.test.js (18 tests) proves the one-balance final
# state fresh. Verified against the actual discovered count: 3720 -> 3677,
# 0 fail, 6 skipped (pre-existing, unrelated).
# credits-as-cash pages build (2026-09-27, BUILD-BRIEF-CREDITS-PAGES.md): +188,
# all from one new file, test/credits-as-cash-copy-guard.test.js (Part D's
# register-C copy guard, the /for-builders math-block guard, the rate/
# not-guaranteed/open-soon guard across the eleven files, and the Terms
# defined-terms + CURRENT_TOS_VERSION guard). Every other touched test file
# only updates existing pins to the new copy/logic (no it() added or removed).
# FIX-UNIT-MONEY (2026-09-27): the money-path review fix unit (H1/H2/M1-M9/
# L1-L12/T1/T2/D1/D2) added two new files (test/fix-unit-money.test.js,
# test/fix-unit-money-webhook.test.js) and new it()s across
# credits-as-cash-lots/refunds/unlock, wave1-money-closures, and
# credits-control-part1, plus the M6/L5 NO-CHANGE pins and the L10 fixes.
# Verified against the actual discovered count: 3865 -> 3925, 0 fail, 7
# skipped (pre-existing, environment-dependent sandbox skips — unrelated to
# this unit).
# FIX-UNIT-MONEY-2 (2026-09-27): the confirm-pass fix unit (N1/N2/N3/N4/N5/
# N6/N7/N8/N9/N10/N11/N13/M3/X1) added two new files
# (test/fix-unit-money-2.test.js, test/fix-unit-money-2-route.test.js), two
# new it()s in test/fix-unit-money-webhook.test.js (a real-route N7 corrupt-
# file test and a real-route M3 concurrency test), and one new it() in
# test/credits-as-cash-lots.test.js (the ruling N1 "bigger than the
# uncovered amount" case); every other touched file only renames/re-asserts
# an existing pin (wave1-money-closures, wave2b-ops-hardening,
# dr8-self-unlock-free, credits-e2e-findings, credits-control-part1,
# credits-config-usable) for the N4 try/catch reshape or the N11 column
# removal — no it() count change there. Verified against the actual
# discovered count: 3925 -> 3951, 0 fail, 7 skipped (same pre-existing
# sandbox skips, unrelated to this unit).
#
# FIX-UNIT-MONEY-3 (2026-09-27): +15 it()s -- test/fix-unit-money-3.test.js
# (13: N14 Walk C/variant/dispute-first/p26-mirror, N15, N16 x3, N18 x2, R1
# x3) and test/fix-unit-money-3-route.test.js (2: N17 corrupt-sessions-file
# and corrupt-account-holds-file, through the real staged webhook route).
# Verified against the actual discovered count: 3951 -> 3966, 1 pre-existing
# unrelated fail (LW3 Credits-card-vs-origin/main, public/dashboard.html --
# out of this unit's scope, forbidden to touch), 7 skipped (same
# pre-existing sandbox skips).
#
# PM follow-up (2026-09-27): origin/main advanced (the release merged and
# pushed) so the LW3 case now pins a state the product no longer has --
# RETIRED (-1 it(), see test/launch-wave-dashboard.test.js). Also: CI-1
# (test/vision-dashboard-payout-panel.test.js loses its two machine-local
# screenshot writes, no it() count change), CI-2 (test/launch-wave-fixes-
# visual.test.js's V8 skip-link case stops reading a computed style mid-
# transition, no it() count change), CI-3 (a scratchpad-path comment reworded
# in test/launch-wave-fixes-frontend.test.js, no it() count change) plus the
# new guard test/no-local-paths-guard.test.js (+261 it()s: 2 positive-control
# + 1 sweep-worked sanity + 257 per-tracked-file checks under test/+scripts/
# + 1 EXCEPTIONS-still-tracked check). Verified: 3966 -> 4226 (-1 + 261 = 260
# net), 0 fail, 7 skipped (same pre-existing sandbox skips).
#
# PM follow-up 2 (2026-09-27): a guard that lists files from `git ls-files`
# only sees TRACKED files -- this pin was set from an uncommitted working
# tree where the guard's own 4 new files (itself included) were not yet
# tracked, so it never scanned them. Once committed (b349732), `git
# ls-files test/ scripts/` reports 4 more files, adding 4 more per-file
# checks (257 -> 261 in the guard's own count), and the guard found its OWN
# search-pattern literals in its own source -- fixed by assembling those
# patterns (and the positive control's sample paths) from string parts at
# runtime, never as a complete literal in the file (see the guard's header
# comment). Verified against a git-add--N-staged run (git ls-files sees
# every changed file as a fresh clone/CI would, without committing):
# 4226 -> 4230, 0 fail, 7 skipped.
#
# MONEYFIX4 (2026-09-27): +20 it()s -- test/fix-unit-money-4.test.js (17: N20
# x3, L-d x5, L-b x3, L-a x3, L-c x2, W1 x1) and test/fix-unit-money-4-
# route.test.js (3: N19 Walk F2 through the real staged boot sequence, an
# idle boot, a corrupt-credits.json boot) -- plus +2 from the no-local-paths
# guard's own per-tracked-file sweep (git-add--N-staged run, its 2 new files
# counted the same way PM follow-up 2 above describes). test/fix-unit-
# money-3-route.test.js's N17 test gained new assertions (ruling L-b changed
# what it proves) but no new it() count. 20 + 2 = 22 net. Verified against a
# git-add--N-staged run: 4230 -> 4252, 0 fail, 7 skipped (same pre-existing
# sandbox skips).
#
# BUILD-BRIEF-TERMS-SCROLL (2026-09-27): +12 it()s -- two new files,
# test/terms-scroll-accept.test.js (7: the card is T-1/T-2/T-3 only + no
# horizontal scroll, the dialog shows the real /terms content with Accept
# disabled, partial-vs-full scroll, keyboard-only reach-the-end, the real
# accept-terms POST + terms-status flip, a failed load + Try Again, Escape
# closes and returns focus) and test/session-ended.test.js (5: S-1 expired
# stored token, S-2 a server-refused token redirecting once with no card
# printing the raw text, S-3a/b/c the three 403 dispositions). No existing
# file's it() count changed -- fix-unit-money.test.js, tos-clickwrap-
# assent.test.js, and credits-control-part1.test.js's T15 each swapped
# checkbox-era assertions for the new dialog/button ones in place; launch-
# wave-dashboard.test.js and launch-wave-fixes-visual.test.js only edited
# existing it() bodies (a heading-order array entry; forcing the new dialog
# overlay visible to measure #terms-accept-btn, same pattern already used
# for #clean-lane-grant-form). Plus +2 from the no-local-paths guard's own
# per-tracked-file sweep picking up the two new files (same mechanism as PM
# follow-up 2 above). 12 + 2 = 14 net. Verified against a git-add--N-staged
# run (the two new files tracked): 4252 -> 4266, 0 fail, 7 skipped (same
# pre-existing sandbox skips).
#
# BUILD-BRIEF-TERMS-SCROLL ROUND 2 (2026-09-27): +4 it()s -- one new file,
# test/legal-code-spans.test.js (4: no backtick survives in any of the four
# served legal pages' visible text, the /terms amendment id renders inside
# a <code> element, an asterisk/bracket/less-than inside a code span render
# literally and escaped while a lone unpaired backtick is left alone, and
# the four pages' visible text is unchanged apart from the backtick
# characters themselves versus the server.js at HEAD). No existing file's
# it() count changed -- test/terms-scroll-accept.test.js's tests 2 and 3
# gained new assertions in place (R2-1 hint/aria-describedby, R2-2 full-
# opacity + background-match waited-for by state not by time, R2-3 no h1
# inside the dialog), and test/analytics-gating.test.js only widened a
# fixed-length source slice past the new code-span block, same as every
# prior addition ahead of that same call. Plus +1 from the no-local-paths
# guard's own per-tracked-file sweep picking up the one new file. 4 + 1 = 5
# net. Verified against a git-add--N-staged run (the new file tracked):
# 4266 -> 4271, 0 fail, 7 skipped (same pre-existing sandbox skips).
#
# FIX-UNIT-TERMS-3 ROUND 3 (2026-09-27): +14 it()s across three new files --
# test/terms-dialog-hardening.test.js (9: R3-1a/b/c the three ways Accept
# could turn on without reading, R3-3a/b cache:no-store + the version-
# mismatch load-failure state, R3-8 onclick/javascript:/style/iframe/
# colliding-id all neutralized, R3-10 Tab-alone reaches Accept, R3-11 the
# background is inert while open and restored on close, R3-4 Accept/Close/
# region sizing across six viewports), test/welcome-email-flag.test.js (1:
# the fly.toml pin), test/review-table-phone-width.test.js (2: readable +
# 44x44 controls + no horizontal scroll at 375/320, unchanged at 1280).
# test/session-ended.test.js gained +2 in place (R3-5, R3-6); its S-1/S-2
# only gained assertions (R3-12), no count change. test/legal-code-spans.
# test.js stayed at 4 -- R3-2 replaced the git-history comparison test with
# one comprehensive synthetic-Markdown test (also proving R3-7's link/
# heading-id fixes) and added a dedicated heading-id-list pin, a wash.
# test/analytics-gating.test.js and test/launch-wave-dashboard.test.js only
# widened a fixed-length slice / moved one expected array entry to its new
# DOM position (the Terms dialog now sits outside #dash-view, R3-11) -- no
# count change. Plus +3 from the no-local-paths guard's own per-tracked-
# file sweep picking up the three new files. 14 + 3 = 17 net. Verified
# against a git-add--N-staged run (the three new files tracked): 4271 ->
# 4288, 0 fail, 7 skipped (same pre-existing sandbox skips).
# The homepage headline and lede: test/hero-0927.test.js adds 25 tests, and
# the local path guard adds one for that file once it is tracked. 4291 + 26 = 4317.
# The dashboard review table at phone width: test/review-table-phone-width.test.js
# grew from 2 tests to 14. 4317 + 12 = 4329.
# MONEY-0928 ("earn a share" -> "earn money"): test/earn-money-guard.test.js adds
# 29 tests, plus 1 from the local path guard once it is tracked. 4329 + 30 = 4359.
# Uniform spacing: the spacing suite measures every page at three widths
# against the spacing tokens, and compares type against a committed baseline.
# The pin is the total npm test prints on the integrated tree.
# FIX-UNIT-LEGAL-CLEARANCE (2026-09-28): the missing nav-clearance test, new
# test/nav-clearance.test.js (93). Verified `npm test` discovered count: 4497.
# EPC2-2 A+B: 63 binding protocol + 29 routing + 32 adapter tests,
# plus 3 tracked-file path guards for the new source, test and fixture helper.
# Merged onto main at 4921 (design wave) + the 127 above = 5048.
# SETUP-SIGNIN: 12 integration tests + 1 tracked-file path guard = +13.
# SLW-6: 33 tests + 1 tracked-file guard + 1 SETUP-SIGNIN review regression = +35.
# CLIENT-CONNECT Part A: 9 registration/header tests + 1 tracked-file guard.
# CLIENT-CONNECT Part B: 14 Windows tests + 1 rollback test + 1 tracked-file guard.
# CLIENT-CONNECT review: +2 foreign node-hook ownership regression cases.
# D0: baseline 5134 + 131 transfer-safety tests + 8 tracked-file path guards = 5273.
# STRIPE-ACCOUNT-MIGRATION: measured staged suite 5499; dual-platform durable
# state, reconciliation/boot barriers, queued reversal and route regressions.
# STRIPE-PRODUCTION-OPERATOR: measured staged suite 5549; shared pure planner,
# explicit maintenance admission and real SIGKILL forward-recovery coverage.
# Persisted-plan correction: two additional canonical reload / CLI tests.
# SERVING-UNKNOWN-HISTORY: measured staged suite after reviewed serving guards,
# typed overlay operator, durable quarantine and explicit capture recovery.
# A1 null-wallet guard: +3 A1 tests + 1 per-file sweep entry for the new test file (sweep enumerates git ls-files, so run the suite with the file committed).
EXPECTED_TEST_COUNT=5608
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

# TEST-HOME-ROUTE-BINDINGS: no test may leave Auxilo state under the suite's
# temp home. Every test is expected to pass an explicit path option (or set its
# own temp home before requiring the module), so a ${AUXILO_TEST_HOME}/.auxilo
# directory means some test reached a default state path (the same path a bare
# `node --test test/<file>` would write into the operator's real ~/.auxilo).
if [ -e "${AUXILO_TEST_HOME}/.auxilo" ]; then
  echo "  ❌ DEFAULT STATE PATH: tests left files under the suite's temp home (${AUXILO_TEST_HOME}/.auxilo):"
  find "${AUXILO_TEST_HOME}/.auxilo" | sed "s#^${AUXILO_TEST_HOME}/##" | sort | sed 's/^/     /'
  echo "     A test reached a default Auxilo state path without an explicit option."
  echo "     Give the call an explicit path (e.g. routeBindingsDir, providersStatePath, indexPath)"
  echo "     inside a temp directory, or set a temp HOME/AUXILO_HOME before requiring the module."
  FAILED=1
fi

echo ""
if [ "${FAILED}" -ne 0 ]; then
  echo "🛑 check-test-count FAILED"
  exit 1
fi

echo "✅ check-test-count PASSED"
exit 0
