'use strict';

/**
 * test/clean-lane-phase-b-scoring.test.js — CLEAN-LANE-FLIP Phase B,
 * client-scoring leg (0.9.12).
 *
 * Covers:
 *   - runner-stack freshness: installRunner stamps ~/.auxilo/bin/VERSION with
 *     the package version; the stamp is NOT a RUNNER_STACK row; the skew
 *     helper reads missing / differing / matching stamps correctly.
 *   - `auxilo status` prints exactly ONE skew line when the stamp is missing
 *     or differs from the CLI's own package version, and none when current.
 *
 * (The A1 gate inversion — scoring ON by default — is pinned in
 * test/wave3-client-funnel.test.js.)
 *
 * Runner: node --test test/clean-lane-phase-b-scoring.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const CLI_PATH = path.join(REPO, 'bin', 'auxilo-cli.js');
const installer = require('../lib/installer.js');
const cli = require('../bin/auxilo-cli.js');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;

const SKEW_RE = /⚠ Installed runner is /g;

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timed out: ${args.join(' ')}`)); }, 15000);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end('');
  });
}

describe('Phase B — runner VERSION stamp (lib/installer.js installRunner)', () => {
  let home;
  before(() => { home = tmp('auxilo-phase-b-version-'); });
  after(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('installRunner writes <bin>/VERSION holding the package version and reports it', () => {
    const res = installer.installRunner(home);
    const versionPath = path.join(installer.binRootFor(home), 'VERSION');
    assert.equal(res.versionPath, versionPath);
    assert.equal(res.version, PKG_VERSION);
    assert.ok(res.installed.includes(versionPath), 'VERSION path is reported in installed[]');
    assert.equal(fs.readFileSync(versionPath, 'utf8'), `${PKG_VERSION}\n`);
    assert.equal(installer.installedRunnerVersion(home), PKG_VERSION);
    // The stack itself still lands (the stamp is additive, not a replacement).
    assert.ok(fs.existsSync(path.join(installer.binRootFor(home), 'scripts', 'runner.js')));
  });

  it('VERSION is a stamp, not a stack row — RUNNER_STACK is untouched by it', () => {
    for (const [src, dest] of installer.RUNNER_STACK) {
      assert.notEqual(src, 'VERSION');
      assert.notEqual(dest, 'VERSION');
    }
    assert.equal(installer.runnerVersionPath(home), path.join(installer.binRootFor(home), 'VERSION'));
  });

  it('runnerVersionSkew: matching stamp → no skew; differing → skew; missing → skew with installed null', () => {
    // Fresh install from this package: current.
    installer.installRunner(home);
    assert.deepEqual(installer.runnerVersionSkew(home), { installed: PKG_VERSION, package: PKG_VERSION, skew: false });

    // A package that moved on while ~/.auxilo/bin kept the old copy.
    const newerPkgRoot = tmp('auxilo-phase-b-pkgroot-');
    fs.writeFileSync(path.join(newerPkgRoot, 'package.json'), JSON.stringify({ name: 'auxilo-mcp', version: '99.0.0' }));
    assert.equal(installer.packageVersion(newerPkgRoot), '99.0.0');
    assert.deepEqual(installer.runnerVersionSkew(home, { packageRoot: newerPkgRoot }),
      { installed: PKG_VERSION, package: '99.0.0', skew: true });

    // Pre-0.9.12 install: no stamp at all.
    fs.unlinkSync(installer.runnerVersionPath(home));
    assert.equal(installer.installedRunnerVersion(home), null);
    assert.deepEqual(installer.runnerVersionSkew(home), { installed: null, package: PKG_VERSION, skew: true });

    // Empty / whitespace-only stamp reads as missing, never as a version.
    fs.writeFileSync(installer.runnerVersionPath(home), '  \n');
    assert.equal(installer.installedRunnerVersion(home), null);
    fs.rmSync(newerPkgRoot, { recursive: true, force: true });
  });
});

describe('Phase B — `auxilo status` runner-skew line (bin/auxilo-cli.js cmdStatus)', () => {
  let home;
  before(() => { home = tmp('auxilo-phase-b-status-'); });
  after(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('runnerSkewLine renders the one-line remedy, and nothing when current', () => {
    assert.equal(cli.runnerSkewLine({ installed: '0.9.11', package: '0.9.12', skew: true }),
      '  ⚠ Installed runner is v0.9.11 (package v0.9.12) — run: npx auxilo setup');
    assert.equal(cli.runnerSkewLine({ installed: null, package: '0.9.12', skew: true }),
      '  ⚠ Installed runner is unstamped (pre-0.9.12) (package v0.9.12) — run: npx auxilo setup');
    assert.equal(cli.runnerSkewLine({ installed: '0.9.12', package: '0.9.12', skew: false }), null);
    assert.equal(cli.runnerSkewLine(null), null);
  });

  it('status prints no skew line when no runner is installed, or when the stamp matches', async () => {
    const bare = await runCli(['status'], { HOME: home });
    assert.equal(bare.code, 0, bare.stderr);
    assert.match(bare.stdout, /Runner installed: no/);
    assert.equal((bare.stdout.match(SKEW_RE) || []).length, 0);

    installer.installRunner(home);
    const current = await runCli(['status'], { HOME: home });
    assert.equal(current.code, 0, current.stderr);
    assert.match(current.stdout, /Runner installed: yes/);
    assert.equal((current.stdout.match(SKEW_RE) || []).length, 0);
  });

  it('status prints exactly ONE skew line when VERSION differs, and when it is missing', async () => {
    installer.installRunner(home);
    fs.writeFileSync(installer.runnerVersionPath(home), '0.9.0\n');
    const stale = await runCli(['status'], { HOME: home });
    assert.equal(stale.code, 0, stale.stderr);
    assert.equal((stale.stdout.match(SKEW_RE) || []).length, 1);
    assert.ok(stale.stdout.includes(`  ⚠ Installed runner is v0.9.0 (package v${PKG_VERSION}) — run: npx auxilo setup`), stale.stdout);

    fs.unlinkSync(installer.runnerVersionPath(home));
    const unstamped = await runCli(['status'], { HOME: home });
    assert.equal(unstamped.code, 0, unstamped.stderr);
    assert.equal((unstamped.stdout.match(SKEW_RE) || []).length, 1);
    assert.ok(unstamped.stdout.includes(`  ⚠ Installed runner is unstamped (pre-0.9.12) (package v${PKG_VERSION}) — run: npx auxilo setup`), unstamped.stdout);

    // Re-running setup's runner step is the remedy: the stamp comes back current.
    installer.installRunner(home);
    const fixed = await runCli(['status'], { HOME: home });
    assert.equal((fixed.stdout.match(SKEW_RE) || []).length, 0);
  });
});
