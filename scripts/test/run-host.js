#!/usr/bin/env node
'use strict';

/**
 * scripts/test/run-host.js — `npm run test:host`: the REAL-HOME counterpart
 * to `npm test` (scripts/test/run-isolated.js).
 *
 * TEST-HOME-ISOLATION (see run-isolated.js's own header) puts the ENTIRE
 * `npm test` / `bash scripts/check-test-count.sh` run under a fresh
 * mkdtemp'd HOME/AUXILO_HOME, on purpose — that is the fix for the incident
 * this repo is guarding against (a stray fixture written into the operator's
 * real ~/.auxilo). The tradeoff: a handful of tests are genuine SELF-CHECKS
 * of THIS machine's actual installed state (a LaunchAgent plist under the
 * real ~/Library/LaunchAgents, a counsel-draft file under the real
 * ~/.auxilo/handoffs) — under the isolated HOME those always see an empty
 * temp dir and always skip, on every machine, forever. That's correct for
 * `npm test` (which must be reproducible in CI, where none of that state
 * exists) but it means these self-checks never actually run anywhere.
 *
 * This script is the other half: it runs ONLY the files containing those
 * self-checks, and DOES NOT touch HOME or AUXILO_HOME at all — it inherits
 * the parent process's environment exactly as the operator's shell has it
 * (os.userInfo().homedir semantics: whatever the OS user database says this
 * account's home directory is, since that's what os.homedir() falls back to
 * once nothing has overridden $HOME). Run it on the operator's own machine
 * to actually exercise these checks against real installed state.
 *
 * Read-only by design: every check this script runs only reads existing
 * paths under the real HOME (fs.existsSync / fs.readFileSync) — nothing in
 * either target file, or in this script, writes under HOME. Verified by
 * inspection at the time this was written (both files were read end-to-end
 * for any fs.writeFileSync/mkdirSync/etc. call reachable without a HOME
 * override already in place — see the commit that added this script for
 * the specifics). If a future test added to either file writes under HOME,
 * that is a bug in the new test, not in this runner.
 *
 * Target files and their host-dependent subtests:
 *   - test/p2-1a-digest.test.js — describe('B3: LaunchAgent plist'): 4
 *     subtests against ~/Library/LaunchAgents/io.auxilo.digest.plist
 *     (label = DIGEST_LABEL in scripts/runner.js — the installer this test
 *     matches).
 *   - test/clean-lane-phase-b-notice.test.js — 1 subtest ("the counsel
 *     draft ... quotes the same sentence, verbatim") against
 *     ~/.auxilo/handoffs/CLEAN-LANE-PHASE-B-LEGAL-DRAFT-2026-09-06.md.
 *
 * test/p2-1a-retraction.test.js is deliberately NOT included here: its
 * former 'B2: LaunchAgent plist' describe checked for a
 * io.auxilo.retraction-sweeper.plist that no installer in this repo has
 * ever written (scripts/runner.js has --install-sweeper /
 * --install-digest only; the retraction-sunset LaunchAgent was RETIRED
 * 2026-06-11 per jobs/retraction-sunset.js's own header) — it was not a
 * host self-check at all, just a test that could never pass or run
 * anywhere. See the commit that added this script for the fix (restored
 * to a retirement-documentation check, which needs no HOME override and
 * already runs under `npm test`).
 *
 * Every subtest below is independently { skip }-guarded in its own file —
 * this script does not force anything to run; it only reports what the
 * real machine state made run vs skip, plus the same test-reporter=tap
 * pass/fail signal `npm test` uses.
 *
 * Usage: npm run test:host
 */

const { spawnSync } = require('child_process');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

const TARGET_FILES = [
  'test/p2-1a-digest.test.js',
  'test/clean-lane-phase-b-notice.test.js',
];

// Known host-dependent subtest names, per file, for the ran/skipped report.
// Keep these in sync with the { skip: ... } guards in the target files.
const HOST_CHECKS = [
  { file: 'test/p2-1a-digest.test.js', name: 'io.auxilo.digest.plist exists' },
  { file: 'test/p2-1a-digest.test.js', name: 'plist contains correct label' },
  { file: 'test/p2-1a-digest.test.js', name: 'plist schedules at 07:00' },
  { file: 'test/p2-1a-digest.test.js', name: 'plist logs to ~/.auxilo/logs/' },
  {
    file: 'test/clean-lane-phase-b-notice.test.js',
    name: 'the counsel draft (§6 read #2, move 3) quotes the same sentence, verbatim (skipped where the draft is not on disk)',
  },
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * TAP emits each subtest as `ok N - <name>` (or `not ok N - <name>`),
 * with a trailing ` # SKIP <reason>` when the test's own { skip } option
 * fired. Match on the exact name text (node's TAP reporter escapes `#` as
 * `\#`, so normalize both sides before comparing).
 */
function classify(tapOutput, name) {
  const normalized = name.replace(/#/g, '\\#');
  const re = new RegExp(
    `^\\s*(ok|not ok) \\d+ - ${escapeRegExp(normalized)}(?: # SKIP(.*))?$`,
    'm'
  );
  const m = tapOutput.match(re);
  if (!m) return { status: 'NOT FOUND', detail: 'no matching TAP line — name may be stale' };
  if (m[2] !== undefined) return { status: 'SKIPPED', detail: m[2].trim() };
  return { status: m[1] === 'ok' ? 'RAN (pass)' : 'RAN (FAIL)', detail: '' };
}

console.log('── test:host — real-HOME self-checks ──');
console.log(`Running under real HOME: ${process.env.HOME || '(unset)'}`);
console.log(`AUXILO_HOME: ${process.env.AUXILO_HOME || '(unset — falls back to real HOME)'}`);
console.log(`Target files: ${TARGET_FILES.join(', ')}`);
console.log('');

const result = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=tap', ...TARGET_FILES],
  {
    cwd: REPO_ROOT,
    env: process.env, // deliberately unmodified — no HOME/AUXILO_HOME override
    encoding: 'utf8',
  }
);

if (result.error) throw result.error;

const tapOutput = `${result.stdout || ''}${result.stderr || ''}`;
console.log(tapOutput);

console.log('── test:host — host-check verdict ──');
let anyFail = false;
for (const check of HOST_CHECKS) {
  const { status, detail } = classify(tapOutput, check.name);
  if (status === 'RAN (FAIL)' || status === 'NOT FOUND') anyFail = true;
  const detailSuffix = detail ? ` (${detail})` : '';
  console.log(`  [${check.file}] ${check.name} — ${status}${detailSuffix}`);
}

console.log('');
const exitCode = result.status === null ? 1 : result.status;
if (exitCode !== 0) {
  console.log(`🛑 node --test exited ${exitCode} (non-zero)`);
} else if (anyFail) {
  console.log('🛑 one or more host checks failed or could not be located in TAP output');
} else {
  console.log('✅ test:host completed — see per-check verdict above for ran vs skipped');
}

process.exit(exitCode !== 0 ? exitCode : (anyFail ? 1 : 0));
