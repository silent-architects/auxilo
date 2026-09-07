#!/usr/bin/env node
'use strict';

/*
 * scripts/prepublish-guard.js — STALE-PRIMARY-CHECKOUT guard
 *
 * INCIDENT
 * --------
 * The operator ran `npm publish` from a stale local checkout that was 444
 * commits behind origin/main, at package.json version 0.9.10. npm only
 * refused because 0.9.10 already existed on the registry — a bump to any
 * unpublished version from that same stale checkout would have succeeded,
 * shipping 444 commits of drift as a "new" release with none of the
 * intervening fixes.
 *
 * FIX
 * ---
 * Wire this as `prepublishOnly` so no checkout location can ever matter:
 * publishing is refused unless the checkout is verifiably the tip of
 * origin/main, clean, and the version being published is genuinely new.
 *
 * CONDITIONS — ALL must hold, or the guard refuses:
 *   1. `git fetch origin main` succeeds (network reachable). If it fails,
 *      refuse — do not fall back to a possibly-stale local origin/main ref.
 *   2. `git rev-parse HEAD` === `git rev-parse origin/main` — HEAD is
 *      exactly the tip of origin/main, not merely an ancestor/descendant.
 *   3. `git status --porcelain` reports no TRACKED changes (staged or
 *      unstaged). Untracked files are allowed through this check alone —
 *      see the follow-up npm-pack note below for why that is still safe.
 *   4. The version in package.json is NOT already published to the
 *      registry (`npm view auxilo-mcp@<version> version` returns nothing).
 *
 * On untracked files: allowing untracked files past condition 3 is safe
 * only because npm's own packing step is independently authoritative over
 * what actually ships — `npm pack`/`npm publish` only include files that
 * are both tracked by git AND match the package.json `files` whitelist (see
 * .npmignore / files[] in package.json). An untracked file can never sneak
 * into the tarball through this guard; it can at most sit in the working
 * tree unpublished. Requiring untracked files to be absent would reject the
 * common case of scratch/log files sitting in the tree and add no actual
 * safety, so this guard checks the TRACKED tree only.
 *
 * ESCAPE HATCH
 * ------------
 * AUXILO_PUBLISH_FORCE=1 skips all four conditions, prints a loud warning,
 * and proceeds. For genuine emergencies only (e.g. registry/git outage
 * blocking a critical hotfix that has already been manually verified another
 * way). Using this flag re-opens exactly the hole this guard exists to
 * close — do not reach for it out of impatience.
 *
 * TESTABILITY
 * -----------
 * All git/npm calls go through an injectable `run(cmd)` seam so tests can
 * simulate every branch (clean pass, HEAD != origin/main, dirty tree,
 * already-published version, fetch failure, force override) without any
 * real network or git process. See test/prepublish-guard.test.js.
 *
 * USAGE
 * -----
 *   node scripts/prepublish-guard.js
 *   AUXILO_PUBLISH_FORCE=1 node scripts/prepublish-guard.js   # emergency bypass
 *
 * Wired via package.json `"prepublishOnly": "node scripts/prepublish-guard.js"`
 * so it runs automatically before `npm publish` (and `npm pack`), from any
 * checkout, with no separate step to remember.
 */

const { execSync } = require('child_process');

const PACKAGE_NAME = 'auxilo-mcp';

const CANONICAL_FIX =
  'Fix: `git fetch && git checkout --detach origin/main`, or publish from ' +
  'the canonical worktree at `cd ~/.auxilo/pm-main-worktree`.';

/**
 * Default shell-command runner. Returns trimmed stdout on success, throws
 * on non-zero exit (matching execSync's own behavior) so callers can
 * distinguish "ran and returned empty" from "failed to run".
 */
function defaultRun(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * check({ run, env }) — the injectable core. Returns:
 *   { ok: true, headSha, version }                     on pass
 *   { ok: false, reason: '<one-line failure message>' } on refusal
 * Never throws for an expected failure mode (fetch failure, dirty tree,
 * etc.) — those are all reported via the `ok: false` shape. An unexpected
 * error (e.g. `run` throws for a reason none of the branches anticipated)
 * is allowed to propagate, since it likely means the environment itself is
 * broken, not that any of the four conditions failed.
 */
function check({ run = defaultRun, env = process.env } = {}) {
  if (env.AUXILO_PUBLISH_FORCE === '1') {
    return {
      ok: true,
      forced: true,
      headSha: null,
      version: null,
    };
  }

  // 1. Fetch origin/main — tolerate offline by refusing with a clear message
  // rather than trusting a possibly-stale local origin/main ref.
  try {
    run('git fetch origin main --quiet');
  } catch (err) {
    return {
      ok: false,
      reason:
        `git fetch origin main failed (offline, or origin unreachable) — ` +
        `refusing to publish without a fresh comparison against origin/main. ` +
        `${CANONICAL_FIX}`,
    };
  }

  // 2. HEAD must be exactly origin/main's tip.
  let headSha;
  let originSha;
  try {
    headSha = run('git rev-parse HEAD');
    originSha = run('git rev-parse origin/main');
  } catch (err) {
    return {
      ok: false,
      reason: `could not resolve HEAD or origin/main via git rev-parse: ${err.message}`,
    };
  }

  if (headSha !== originSha) {
    return {
      ok: false,
      reason:
        `HEAD (${headSha}) is not origin/main (${originSha}) — this checkout is not ` +
        `the canonical tip. ${CANONICAL_FIX}`,
    };
  }

  // 3. Tracked working tree must be clean. Untracked files are fine — see
  // the module header for why that is still safe (npm's own files[]/
  // .npmignore filtering is independently authoritative over the tarball).
  let statusOutput;
  try {
    statusOutput = run('git status --porcelain');
  } catch (err) {
    return {
      ok: false,
      reason: `could not run git status --porcelain: ${err.message}`,
    };
  }

  const trackedDirtyLines = statusOutput
    .split('\n')
    .map((line) => line)
    .filter((line) => line.length > 0 && !line.startsWith('??'));

  if (trackedDirtyLines.length > 0) {
    return {
      ok: false,
      reason:
        `working tree has uncommitted changes to tracked files (${trackedDirtyLines.length} ` +
        `entr${trackedDirtyLines.length === 1 ? 'y' : 'ies'}) — commit or discard them before ` +
        `publishing. ${CANONICAL_FIX}`,
    };
  }

  // 4. package.json version must not already be on the registry.
  let pkg;
  try {
    // eslint-disable-next-line global-require
    pkg = require('../package.json');
  } catch (err) {
    return { ok: false, reason: `could not read package.json: ${err.message}` };
  }

  const version = pkg.version;
  let published;
  try {
    published = run(`npm view ${PACKAGE_NAME}@${version} version`);
  } catch (err) {
    // npm view exits non-zero (E404) when the version does not exist —
    // that IS the pass condition, not a failure to report.
    published = '';
  }

  if (published && published.trim().length > 0) {
    return {
      ok: false,
      reason:
        `${PACKAGE_NAME}@${version} is already published to the registry — bump the ` +
        `version in package.json before publishing again.`,
    };
  }

  return { ok: true, forced: false, headSha, version };
}

function main() {
  const result = check({});

  if (!result.ok) {
    // eslint-disable-next-line no-console
    console.error(`\n🛑 prepublish-guard REFUSED: ${result.reason}\n`);
    process.exit(1);
  }

  if (result.forced) {
    // eslint-disable-next-line no-console
    console.warn(
      '\n⚠️  AUXILO_PUBLISH_FORCE=1 set — prepublish-guard checks BYPASSED. ' +
        'Publishing without verifying origin/main, a clean tree, or an unpublished ' +
        'version. This should only ever happen in a genuine emergency.\n'
    );
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`✅ prepublish-guard PASS — HEAD ${result.headSha} == origin/main, version ${result.version} unpublished`);
}

if (require.main === module) {
  main();
}

module.exports = { check, defaultRun, CANONICAL_FIX, PACKAGE_NAME };
