#!/usr/bin/env node
'use strict';

/**
 * scripts/test/run-isolated.js — TEST-HOME-ISOLATION suite-wide safety net.
 *
 * `npm test` runs this instead of a bare `node --test test/*.test.js && node
 * tests/test-mobile-nav-overlay.js`. What changes: the ENTIRE run (both
 * commands, every spawned test-file child process node --test forks) gets a
 * single freshly mkdtemp'd directory as both `AUXILO_HOME` and `HOME`,
 * cleaned up afterward — so any test, existing or future, that forgets its
 * own home-directory override (a `providersStatePath` opt, a `HOME` env on a
 * spawned CLI child, a `homeDir`/`dataDir` opt) still cannot read or write
 * the operator's real ~/.auxilo or ~/.claude trees. This is defense in depth
 * on top of the per-test overrides already used throughout test/ — see
 * PUNCH-LIST TEST-HOME-ISOLATION for the incident this closes (a stray
 * fixture `{"byo":{"provider":"anthropic","model":"x","api_key":"y"}}` was
 * found written into the operator's real ~/.auxilo/providers.json).
 *
 * Two env vars, not one, because os.homedir() is read directly (with no
 * override seam at all) by a wide swath of this repo's OTHER modules
 * (scripts/runner.js's ~/.claude/settings.json and LaunchAgents paths,
 * mcp-server.js's credentials/config paths, lib/installer.js's VERSION
 * stamp, lib/extraction-index.js, scripts/sources/*.js, ...) — only `HOME`
 * reaches those, since os.homedir() prefers $HOME on POSIX. AUXILO_HOME is
 * additionally the dedicated seam scripts/providers/{byo-key,index}.js honor
 * (see those files) — both point at the same temp dir here so neither
 * surface can slip through.
 *
 * test/no-real-home-writes.test.js checks the REAL home (via
 * os.userInfo().homedir, which — unlike os.homedir() — reads the OS user
 * database directly and ignores this override) stays untouched, as a
 * regression guard on this mechanism itself.
 *
 * scripts/check-test-count.sh is the OTHER entry point that runs
 * test/*.test.js (it is the actual CI-blocking gate, invoked directly by
 * .github/workflows/ci.yml — not through `npm test`) and sets up the same
 * isolated HOME/AUXILO_HOME independently, since it does not go through this
 * file.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

function discoverTestFiles() {
  const dir = path.join(REPO_ROOT, 'test');
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => path.join('test', name));
}

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: isolatedEnv,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status === null ? 1 : result.status;
}

/**
 * Playwright resolves its browser cache under $HOME by default
 * (~/Library/Caches/ms-playwright on macOS, ~/.cache/ms-playwright on
 * Linux, %USERPROFILE%\AppData\Local\ms-playwright on Windows) —
 * overriding HOME below would otherwise make test/sheet9-fixups.test.js's
 * Tier-2 suite think the already-installed browsers (installed under the
 * REAL home, e.g. CI's `npx playwright install chromium` step, which runs
 * BEFORE this script and BEFORE any HOME override) are missing. Point
 * PLAYWRIGHT_BROWSERS_PATH at the REAL home's cache (read-only from here —
 * nothing in this repo writes into it) so the isolated HOME doesn't shadow
 * it.
 */
function defaultPlaywrightBrowsersPath(realHome) {
  if (process.platform === 'darwin') return path.join(realHome, 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return path.join(realHome, 'AppData', 'Local', 'ms-playwright');
  return path.join(realHome, '.cache', 'ms-playwright'); // linux and other POSIX
}

const realHome = os.userInfo().homedir;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-test-home-'));
const isolatedEnv = {
  ...process.env,
  AUXILO_HOME: tmpHome,
  HOME: tmpHome,
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || defaultPlaywrightBrowsersPath(realHome),
};

let exitCode = 0;
try {
  exitCode = run(['--test', ...discoverTestFiles()]);
  if (exitCode === 0) {
    exitCode = run([path.join('tests', 'test-mobile-nav-overlay.js')]);
  }
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

process.exit(exitCode);
