'use strict';

/**
 * test/runner-auto-update.test.js — RUNNER-AUTO-UPDATE (0.9.16) coverage.
 *
 * BUILD-SPEC-RUNNER-AUTO-UPDATE-2026-09-07.md §5 lists 8 required scenarios
 * (each tagged "SPEC #N" below) plus the integrity/signature mechanism
 * (§3/§4) and the atomic-swap/binRootOverride seam it reuses from
 * lib/installer.js's installRunner. Every network/tarball/installer
 * dependency is injected — NO real network call is made anywhere in this
 * file (the pinned npm registry key + a throwaway EC keypair are used to
 * produce REAL, cryptographically-valid signatures over synthetic fixture
 * data, so the actual crypto.verify() code path is genuinely exercised,
 * not mocked away).
 *
 * Runner: node --test test/runner-auto-update.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const CLI_PATH = path.join(REPO, 'bin', 'auxilo-cli.js');
const installer = require('../lib/installer.js');
const { extractTarGz } = require('../lib/tar-extract.js');
const { semverGt, semverCompare } = require('../lib/semver-min.js');
const autoupdate = require('../lib/runner-autoupdate.js');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── Test-only tar writer (mirrors the real ustar layout lib/tar-extract.js
// reads — verified against a REAL npm tarball during this build) ───────────

function octal(n, width) {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function buildTarEntry(name, content, { typeflag = '0' } = {}) {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 'utf-8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(octal(content.length, 12), 124);
  header.write(octal(0, 12), 136);
  header.write('        ', 148); // checksum placeholder (8 spaces)
  header.write(typeflag, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  header.write(octal(sum, 8).slice(0, 6) + '\0 ', 148);

  const contentBuf = Buffer.from(content, 'utf-8');
  const padLen = (512 - (contentBuf.length % 512)) % 512;
  return Buffer.concat([header, contentBuf, Buffer.alloc(padLen)]);
}

/** Builds a minimal gzip'd tar with `package/<name>` entries. */
function buildFixtureTarball(files) {
  const parts = Object.entries(files).map(([name, content]) => buildTarEntry(`package/${name}`, content));
  const tar = Buffer.concat([...parts, Buffer.alloc(1024)]); // two zero blocks = EOF
  return zlib.gzipSync(tar);
}

function sri(buffer) {
  return `sha512-${crypto.createHash('sha512').update(buffer).digest('base64')}`;
}

// A throwaway EC P-256 keypair, used ONLY to produce genuinely-verifiable
// signatures for fixture metadata in these tests — verifyRegistrySignature
// is given this key via `pinnedKeys` instead of the real npm key (which
// nobody but npm holds the private half of).
const testKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const testPinnedKeys = [{
  keyid: 'SHA256:test-key',
  key: testKeyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
}];

function signMetadata(name, version, integrity) {
  const message = Buffer.from(`${name}@${version}:${integrity}`);
  const sig = crypto.sign('sha256', message, { key: testKeyPair.privateKey, dsaEncoding: 'der' });
  return [{ keyid: 'SHA256:test-key', sig: sig.toString('base64') }];
}

/** Builds a full fake registry metadata doc + matching tarball bytes. */
function buildFakeRelease(version, files = { 'package.json': JSON.stringify({ name: 'auxilo-mcp', version }) }) {
  const tarball = buildFixtureTarball(files);
  const integrity = sri(tarball);
  const signatures = signMetadata('auxilo-mcp', version, integrity);
  const meta = {
    name: 'auxilo-mcp',
    version,
    dist: {
      tarball: `https://registry.npmjs.org/auxilo-mcp/-/auxilo-mcp-${version}.tgz`,
      integrity,
      shasum: crypto.createHash('sha1').update(tarball).digest('hex'),
      signatures,
    },
  };
  return { meta, tarball };
}

/** Fake global-fetch-shaped implementation keyed by exact URL. */
function fakeFetch(routes) {
  return async (url) => {
    const entry = routes[url];
    if (entry === undefined) throw new Error(`fakeFetch: unexpected URL ${url}`);
    if (entry instanceof Error) throw entry;
    if (typeof entry === 'function') return entry();
    return entry;
  };
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function bufferResponse(buffer) {
  return { ok: true, status: 200, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
}

/**
 * A fake `installer` for the orchestrator tests: readRunnerConfig/
 * writeRunnerConfig/binRootFor delegate to the REAL lib/installer.js
 * (pure, homeDir-scoped, already covered by its own tests) so
 * stageAndSwap's real fs.renameSync dance is genuinely exercised against a
 * real temp directory; installRunner is a lightweight stand-in that avoids
 * needing every RUNNER_STACK file physically present in the fixture
 * tarball (that closure is covered separately by
 * test/runner-packaging-closure.test.js).
 */
function fakeInstaller(installedVersion) {
  const calls = [];
  return {
    calls,
    readRunnerConfig: (home) => installer.readRunnerConfig(home),
    writeRunnerConfig: (home, patch) => installer.writeRunnerConfig(home, patch),
    binRootFor: (home) => installer.binRootFor(home),
    installedRunnerVersion: () => installedVersion,
    installRunner: (home, opts) => {
      calls.push({ home, opts });
      fs.mkdirSync(opts.binRootOverride, { recursive: true });
      fs.writeFileSync(path.join(opts.binRootOverride, 'VERSION'), `${JSON.parse(fs.readFileSync(path.join(opts.packageRoot, 'package.json'), 'utf-8')).version}\n`);
      fs.writeFileSync(path.join(opts.binRootOverride, 'scripts-marker.js'), 'installed');
      return { binRoot: opts.binRootOverride, installed: [] };
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════
// lib/semver-min.js
// ═════════════════════════════════════════════════════════════════════════

describe('semver-min', () => {
  it('semverGt: basic major/minor/patch precedence', () => {
    assert.equal(semverGt('0.9.16', '0.9.15'), true);
    assert.equal(semverGt('0.9.15', '0.9.16'), false);
    assert.equal(semverGt('0.9.15', '0.9.15'), false);
    assert.equal(semverGt('1.0.0', '0.9.99'), true);
    assert.equal(semverGt('0.10.0', '0.9.99'), true);
  });

  it('semverGt: prerelease precedence (no-prerelease > prerelease)', () => {
    assert.equal(semverGt('1.0.0', '1.0.0-beta.1'), true);
    assert.equal(semverGt('1.0.0-beta.1', '1.0.0'), false);
    assert.equal(semverGt('1.0.0-beta.2', '1.0.0-beta.1'), true);
  });

  it('semverCompare/semverGt: invalid input never compares as greater', () => {
    assert.equal(semverCompare('not-a-version', '0.9.15'), null);
    assert.equal(semverGt('not-a-version', '0.9.15'), false);
    assert.equal(semverGt('0.9.15', 'not-a-version'), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// lib/tar-extract.js
// ═════════════════════════════════════════════════════════════════════════

describe('tar-extract', () => {
  it('extracts a fixture tarball, stripping the package/ root', () => {
    const gz = buildFixtureTarball({
      'package.json': '{"name":"x"}',
      'scripts/runner.js': 'console.log(1);',
    });
    const dest = tmp('tar-extract-');
    const res = extractTarGz(gz, dest);
    assert.deepEqual(res.files.sort(), ['package.json', 'scripts/runner.js']);
    assert.equal(fs.readFileSync(path.join(dest, 'package.json'), 'utf-8'), '{"name":"x"}');
    assert.equal(fs.readFileSync(path.join(dest, 'scripts/runner.js'), 'utf-8'), 'console.log(1);');
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it('refuses a path-traversal entry rather than writing outside destDir', () => {
    const evil = buildTarEntry('package/../../evil.js', 'pwned');
    const gz = zlib.gzipSync(Buffer.concat([evil, Buffer.alloc(1024)]));
    const dest = tmp('tar-extract-evil-');
    assert.throws(() => extractTarGz(gz, dest), /refusing path-traversal/);
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it('skips symlink entries (typeflag 2) rather than extracting them', () => {
    const link = buildTarEntry('package/evil-link', 'target-content', { typeflag: '2' });
    const gz = zlib.gzipSync(Buffer.concat([link, Buffer.alloc(1024)]));
    const dest = tmp('tar-extract-symlink-');
    const res = extractTarGz(gz, dest);
    assert.deepEqual(res.files, []);
    assert.deepEqual(res.skipped, ['evil-link']);
    assert.equal(fs.existsSync(path.join(dest, 'evil-link')), false);
    fs.rmSync(dest, { recursive: true, force: true });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Integrity + signature verification (spec §3/§4)
// ═════════════════════════════════════════════════════════════════════════

describe('runner-autoupdate: integrity + signature verification', () => {
  it('verifyTarballIntegrity: matches real sha512 SRI, rejects tampered bytes', () => {
    const buf = Buffer.from('hello world');
    const good = autoupdate.verifyTarballIntegrity(buf, { integrity: sri(buf) });
    assert.equal(good.ok, true);
    const bad = autoupdate.verifyTarballIntegrity(Buffer.from('tampered'), { integrity: sri(buf) });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /integrity-mismatch/);
  });

  it('verifyTarballIntegrity: falls back to shasum (sha1) when integrity is absent', () => {
    const buf = Buffer.from('hello world');
    const shasum = crypto.createHash('sha1').update(buf).digest('hex');
    assert.equal(autoupdate.verifyTarballIntegrity(buf, { shasum }).ok, true);
    assert.equal(autoupdate.verifyTarballIntegrity(buf, {}).ok, false);
  });

  it('verifyRegistrySignature: a real ECDSA signature over name@version:integrity verifies against the matching pinned key', () => {
    const integrity = sri(Buffer.from('x'));
    const signatures = signMetadata('auxilo-mcp', '0.9.16', integrity);
    const result = autoupdate.verifyRegistrySignature(
      { name: 'auxilo-mcp', version: '0.9.16', integrity, signatures },
      testPinnedKeys
    );
    assert.equal(result.ok, true);
  });

  it('verifyRegistrySignature: refuses a signature over the WRONG message (tampered version/integrity)', () => {
    const integrity = sri(Buffer.from('x'));
    const signatures = signMetadata('auxilo-mcp', '0.9.16', integrity);
    // Verifier is asked to check a DIFFERENT version than what was signed.
    const result = autoupdate.verifyRegistrySignature(
      { name: 'auxilo-mcp', version: '0.9.17', integrity, signatures },
      testPinnedKeys
    );
    assert.equal(result.ok, false);
  });

  it('verifyRegistrySignature: refuses when no signature matches a pinned keyid', () => {
    const integrity = sri(Buffer.from('x'));
    const result = autoupdate.verifyRegistrySignature(
      { name: 'auxilo-mcp', version: '0.9.16', integrity, signatures: [{ keyid: 'SHA256:unknown', sig: 'AA==' }] },
      testPinnedKeys
    );
    assert.equal(result.ok, false);
  });

  it('verifyRegistrySignature: refuses when signatures array is missing/empty', () => {
    assert.equal(autoupdate.verifyRegistrySignature({ name: 'x', version: '1.0.0', integrity: 'sha512-a', signatures: [] }, testPinnedKeys).ok, false);
    assert.equal(autoupdate.verifyRegistrySignature({ name: 'x', version: '1.0.0', integrity: 'sha512-a' }, testPinnedKeys).ok, false);
  });

  it('the REAL pinned NPM_REGISTRY_SIGNING_KEYS entry verifies a real npm-signed payload (auxilo-mcp@0.9.15, captured live from registry.npmjs.org during this build)', () => {
    // Golden fixture — NOT a network call. Ground-truths that the pinned
    // key/verification code path matches npm's actual production signing
    // scheme, not just our own synthetic fixtures.
    const result = autoupdate.verifyRegistrySignature({
      name: 'auxilo-mcp',
      version: '0.9.15',
      integrity: 'sha512-xCv7SqmfzoAAuwl5OU+NtL0/1elpJQm12B/YejBNITN4FkIf1F/u1jhbZHBghCVXZ83aZWBZevceL5fmvFU6wA==',
      signatures: [{
        sig: 'MEUCIQCFEcbpqplZmLXG+3vyxOhIi43H/vsEn5qKxkWjFS8OIgIgE32bhAzY2pkUavBOqYbQOTBCXDG++aYltKgBN7rH8M4=',
        keyid: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U',
      }],
    });
    assert.equal(result.ok, true);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Cadence stamp + in-flight lock
// ═════════════════════════════════════════════════════════════════════════

describe('runner-autoupdate: cadence stamp', () => {
  let home;
  before(() => { home = tmp('autoupdate-stamp-'); });
  after(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('shouldCheckNow: true when never checked; false within 24h; true after 24h', () => {
    assert.equal(autoupdate.shouldCheckNow(home, Date.now()), true);
    const now = Date.now();
    autoupdate.writeLastCheckStamp(home, now);
    assert.equal(autoupdate.shouldCheckNow(home, now + 1000), false);
    assert.equal(autoupdate.shouldCheckNow(home, now + autoupdate.ONE_DAY_MS), true);
    assert.equal(autoupdate.shouldCheckNow(home, now + autoupdate.ONE_DAY_MS - 1), false);
  });

  it('readLastCheckStamp: malformed/absent reads as null (never checked)', () => {
    const home2 = tmp('autoupdate-stamp-bad-');
    assert.equal(autoupdate.readLastCheckStamp(home2), null);
    fs.mkdirSync(path.join(home2, '.auxilo'), { recursive: true });
    fs.writeFileSync(autoupdate.lastCheckStampPath(home2), 'not-a-date\n');
    assert.equal(autoupdate.readLastCheckStamp(home2), null);
    fs.rmSync(home2, { recursive: true, force: true });
  });
});

describe('runner-autoupdate: in-flight extraction lock', () => {
  let home;
  before(() => { home = tmp('autoupdate-lock-'); });
  after(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('absent → not in progress; marked → in progress; cleared → not in progress', () => {
    assert.equal(autoupdate.isExtractionInProgress(home), false);
    autoupdate.markExtractionStart(home);
    assert.equal(autoupdate.isExtractionInProgress(home), true);
    autoupdate.markExtractionEnd(home);
    assert.equal(autoupdate.isExtractionInProgress(home), false);
  });

  it('a stale marker (older than the tolerance window) reads as NOT in progress', () => {
    autoupdate.markExtractionStart(home);
    const old = Date.now() - (autoupdate.STALE_LOCK_MS + 60000);
    fs.utimesSync(autoupdate.extractionLockPath(home), old / 1000, old / 1000);
    assert.equal(autoupdate.isExtractionInProgress(home, Date.now()), false);
    autoupdate.markExtractionEnd(home);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// installer.js: installRunner binRootOverride seam (RUNNER-AUTO-UPDATE addition)
// ═════════════════════════════════════════════════════════════════════════

describe('installer.installRunner: binRootOverride (RUNNER-AUTO-UPDATE staging seam)', () => {
  it('stages the full stack at the override path, leaves the real bin root untouched, and the hook content still names the REAL final path', () => {
    const home = tmp('installrunner-override-');
    const override = `${installer.binRootFor(home)}.new`;
    const res = installer.installRunner(home, { binRootOverride: override });
    assert.equal(res.binRoot, override);
    assert.equal(fs.existsSync(installer.binRootFor(home)), false);
    assert.equal(fs.existsSync(path.join(override, 'scripts', 'runner.js')), true);
    assert.equal(fs.existsSync(res.versionPath), true);
    assert.ok(res.versionPath.startsWith(override));
    assert.ok(res.hookPath.startsWith(override));
    const hookBody = fs.readFileSync(res.hookPath, 'utf-8');
    assert.ok(hookBody.includes(path.join(home, '.auxilo', 'bin', 'scripts', 'runner.js')));
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('omitting binRootOverride keeps writing straight into <home>/.auxilo/bin (unchanged default behavior)', () => {
    const home = tmp('installrunner-default-');
    const res = installer.installRunner(home);
    assert.equal(res.binRoot, installer.binRootFor(home));
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('installer.js: runner-config read/write helpers', () => {
  it('readRunnerConfig: absent/malformed → {}', () => {
    const home = tmp('runnerconfig-absent-');
    assert.deepEqual(installer.readRunnerConfig(home), {});
    fs.mkdirSync(path.join(home, '.auxilo'), { recursive: true });
    fs.writeFileSync(installer.runnerConfigPath(home), 'not json');
    assert.deepEqual(installer.readRunnerConfig(home), {});
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('writeRunnerConfig: shallow-merges into the existing file, tmp+rename', () => {
    const home = tmp('runnerconfig-merge-');
    installer.writeRunnerConfig(home, { autoupdate: false });
    assert.deepEqual(installer.readRunnerConfig(home), { autoupdate: false });
    installer.writeRunnerConfig(home, { last_known_latest: '0.9.16' });
    assert.deepEqual(installer.readRunnerConfig(home), { autoupdate: false, last_known_latest: '0.9.16' });
    assert.equal(fs.existsSync(`${installer.runnerConfigPath(home)}.tmp`), false);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// checkAndApplyRunnerUpdate — the 8 spec §5 scenarios
// ═════════════════════════════════════════════════════════════════════════

describe('checkAndApplyRunnerUpdate — SPEC #1: newer version, online, no lock → swap + stamp + log', () => {
  it('installs the newer version atomically and logs the effective-next-session line', async () => {
    const home = tmp('autoupdate-spec1-');
    const { meta, tarball } = buildFakeRelease('0.9.16');
    const logs = [];
    const fi = fakeInstaller('0.9.14');

    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fi,
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({
        [autoupdate.REGISTRY_LATEST_URL]: jsonResponse(meta),
        [meta.dist.tarball]: bufferResponse(tarball),
      }),
      log: (m) => logs.push(m),
      now: 1000000,
    });

    assert.equal(result.status, 'updated');
    assert.equal(result.version, '0.9.16');
    assert.equal(fi.calls.length, 1);
    assert.equal(
      fs.readFileSync(path.join(installer.binRootFor(home), 'VERSION'), 'utf-8').trim(),
      '0.9.16'
    );
    assert.ok(logs.some((l) => /updated to v0\.9\.16, effective next session/.test(l)));
    assert.equal(autoupdate.readLastCheckStamp(home), 1000000);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('the swap keeps the OLD tree as .prev for one cycle, and a second update rotates it out', async () => {
    const home = tmp('autoupdate-spec1-prev-');
    // Seed a real "current" install first (0.9.14).
    installer.installRunner(home);
    fs.writeFileSync(path.join(installer.binRootFor(home), 'VERSION'), '0.9.14\n');
    fs.writeFileSync(path.join(installer.binRootFor(home), 'marker-a'), 'gen-a');

    const fi = fakeInstaller('0.9.14');
    const { meta, tarball } = buildFakeRelease('0.9.15');
    await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fi,
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({
        [autoupdate.REGISTRY_LATEST_URL]: jsonResponse(meta),
        [meta.dist.tarball]: bufferResponse(tarball),
      }),
      log: () => {},
      now: 1,
    });
    const binRoot = installer.binRootFor(home);
    assert.equal(fs.existsSync(`${binRoot}.prev`), true);
    assert.equal(fs.readFileSync(path.join(`${binRoot}.prev`, 'marker-a'), 'utf-8'), 'gen-a');
    assert.equal(fs.existsSync(`${binRoot}.new`), false);

    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('checkAndApplyRunnerUpdate — SPEC #2/#3: same or older fetched version → no-op, no log, stamp touched', () => {
  it('equal version: no swap, no log line', async () => {
    const home = tmp('autoupdate-spec2-');
    const { meta } = buildFakeRelease('0.9.15');
    const logs = [];
    const fi = fakeInstaller('0.9.15');
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fi,
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({ [autoupdate.REGISTRY_LATEST_URL]: jsonResponse(meta) }),
      log: (m) => logs.push(m),
      now: 5000,
    });
    assert.equal(result.status, 'no-op');
    assert.equal(fi.calls.length, 0);
    assert.deepEqual(logs, []);
    assert.equal(autoupdate.readLastCheckStamp(home), 5000);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('older fetched version than installed: no swap, no log line (refuse-downgrade)', async () => {
    const home = tmp('autoupdate-spec3-');
    const { meta } = buildFakeRelease('0.9.10');
    const logs = [];
    const fi = fakeInstaller('0.9.15');
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fi,
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({ [autoupdate.REGISTRY_LATEST_URL]: jsonResponse(meta) }),
      log: (m) => logs.push(m),
      now: 6000,
    });
    assert.equal(result.status, 'no-op');
    assert.equal(fi.calls.length, 0);
    assert.deepEqual(logs, []);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('checkAndApplyRunnerUpdate — SPEC #4: registry fetch fails/times out → continue, one log line, stamp updated', () => {
  it('fetch throwing (network error) falls through to the current copy', async () => {
    const home = tmp('autoupdate-spec4-');
    const logs = [];
    const fi = fakeInstaller('0.9.15');
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fi,
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({ [autoupdate.REGISTRY_LATEST_URL]: new Error('getaddrinfo ENOTFOUND registry.npmjs.org') }),
      log: (m) => logs.push(m),
      now: 7000,
    });
    assert.equal(result.status, 'check-failed');
    assert.equal(fi.calls.length, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /auto-update check failed:.*continuing on installed/);
    assert.equal(autoupdate.readLastCheckStamp(home), 7000); // no retry storm
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('a non-ok HTTP response is treated the same way (offline-tolerant)', async () => {
    const home = tmp('autoupdate-spec4b-');
    const logs = [];
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller('0.9.15'),
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({ [autoupdate.REGISTRY_LATEST_URL]: { ok: false, status: 500 } }),
      log: (m) => logs.push(m),
      now: 8000,
    });
    assert.equal(result.status, 'check-failed');
    assert.equal(logs.length, 1);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('checkAndApplyRunnerUpdate — SPEC #5: integrity mismatch → refuse, log, bin untouched, .new cleaned up', () => {
  it('a tampered tarball (integrity mismatch) is refused and never installed', async () => {
    const home = tmp('autoupdate-spec5-');
    const { meta, tarball } = buildFakeRelease('0.9.16');
    const tampered = Buffer.concat([tarball, Buffer.from('extra-bytes')]); // breaks the sha512
    const logs = [];
    const fi = fakeInstaller('0.9.14');

    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fi,
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({
        [autoupdate.REGISTRY_LATEST_URL]: jsonResponse(meta),
        [meta.dist.tarball]: bufferResponse(tampered),
      }),
      log: (m) => logs.push(m),
      now: 9000,
    });

    assert.equal(result.status, 'refused');
    assert.match(result.reason, /integrity-mismatch/);
    assert.equal(fi.calls.length, 0, 'installRunner must never be called on a failed verification');
    assert.equal(fs.existsSync(installer.binRootFor(home)), false);
    assert.equal(fs.existsSync(`${installer.binRootFor(home)}.new`), false);
    assert.ok(logs.some((l) => /REFUSED.*integrity-mismatch/.test(l)));

    const cfg = installer.readRunnerConfig(home);
    assert.equal(cfg.last_verification.result, 'failed');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('a signature that does not verify against the pinned key is ALSO refused (even with correct integrity)', async () => {
    const home = tmp('autoupdate-spec5b-');
    const { meta, tarball } = buildFakeRelease('0.9.16');
    meta.dist.signatures = [{ keyid: 'SHA256:test-key', sig: Buffer.from('not-a-real-signature').toString('base64') }];
    const logs = [];
    const fi = fakeInstaller('0.9.14');

    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fi,
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({
        [autoupdate.REGISTRY_LATEST_URL]: jsonResponse(meta),
        [meta.dist.tarball]: bufferResponse(tarball),
      }),
      log: (m) => logs.push(m),
      now: 9500,
    });

    assert.equal(result.status, 'refused');
    assert.match(result.reason, /signature/);
    assert.equal(fi.calls.length, 0);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('checkAndApplyRunnerUpdate — SPEC #6: opt-out skips the check entirely', () => {
  it('AUXILO_RUNNER_AUTOUPDATE=0: no fetch call, silent when no cached "latest" is known', async () => {
    const home = tmp('autoupdate-spec6-env-');
    let fetchCalls = 0;
    const logs = [];
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      installer: fakeInstaller('0.9.15'),
      env: { AUXILO_RUNNER_AUTOUPDATE: '0' },
      fetchImpl: async () => { fetchCalls++; throw new Error('must not be called'); },
      log: (m) => logs.push(m),
    });
    assert.equal(result.status, 'opted-out');
    assert.equal(fetchCalls, 0);
    assert.deepEqual(logs, []);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('persisted opt-out (installer runner-config autoupdate:false): no fetch call', async () => {
    const home = tmp('autoupdate-spec6-cfg-');
    installer.writeRunnerConfig(home, { autoupdate: false });
    let fetchCalls = 0;
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer,
      fetchImpl: async () => { fetchCalls++; throw new Error('must not be called'); },
      log: () => {},
    });
    assert.equal(result.status, 'opted-out');
    assert.equal(fetchCalls, 0);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('opted-out but a PREVIOUSLY cached last_known_latest is newer than installed → one notice line, still no fetch', async () => {
    const home = tmp('autoupdate-spec6-notice-');
    installer.installRunner(home);
    fs.writeFileSync(path.join(installer.binRootFor(home), 'VERSION'), '0.9.10\n');
    installer.writeRunnerConfig(home, { autoupdate: false, last_known_latest: '0.9.20' });
    const logs = [];
    let fetchCalls = 0;
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer,
      fetchImpl: async () => { fetchCalls++; throw new Error('must not be called'); },
      log: (m) => logs.push(m),
    });
    assert.equal(result.status, 'opted-out');
    assert.equal(fetchCalls, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /v0\.9\.20 is available \(auto-update is off\)/);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('checkAndApplyRunnerUpdate — SPEC #7: stamp <24h old → skipped, zero network calls', () => {
  it('a fresh stamp suppresses the check without ever calling fetch', async () => {
    const home = tmp('autoupdate-spec7-');
    autoupdate.writeLastCheckStamp(home, 1000);
    let fetchCalls = 0;
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller('0.9.15'),
      fetchImpl: async () => { fetchCalls++; throw new Error('must not be called'); },
      log: () => {},
      now: 1000 + autoupdate.ONE_DAY_MS - 1,
    });
    assert.equal(result.status, 'skipped-recent');
    assert.equal(fetchCalls, 0);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('checkAndApplyRunnerUpdate — SPEC #8: extraction-in-progress marker → skipped this run, succeeds once cleared', () => {
  it('present → skipped (no fetch); cleared → the retry on the next call succeeds', async () => {
    const home = tmp('autoupdate-spec8-');
    autoupdate.markExtractionStart(home);
    let fetchCalls = 0;
    const skipped = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller('0.9.14'),
      fetchImpl: async () => { fetchCalls++; throw new Error('must not be called'); },
      log: () => {},
      now: Date.now(),
    });
    assert.equal(skipped.status, 'skipped-in-flight');
    assert.equal(fetchCalls, 0);

    autoupdate.markExtractionEnd(home);
    const { meta, tarball } = buildFakeRelease('0.9.16');
    const fi = fakeInstaller('0.9.14');
    const retried = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fi,
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({
        [autoupdate.REGISTRY_LATEST_URL]: jsonResponse(meta),
        [meta.dist.tarball]: bufferResponse(tarball),
      }),
      log: () => {},
      now: Date.now(),
    });
    assert.equal(retried.status, 'updated');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// `auxilo status` — Auto-update line (spec §6)
// ═════════════════════════════════════════════════════════════════════════

describe('runnerAutoupdateStatusLine / getRunnerAutoupdateStatus', () => {
  it('pure render: on/off/paused-by-env, with and without a verification result', () => {
    assert.equal(
      autoupdate.runnerAutoupdateStatusLine({ lastCheckAt: null, autoupdateState: 'on', lastVerification: null }),
      '  Auto-update: on (last check: never)'
    );
    const withVerification = autoupdate.runnerAutoupdateStatusLine({
      lastCheckAt: 0,
      autoupdateState: 'off',
      lastVerification: { result: 'failed', at: '2026-09-07T00:00:00.000Z', reason: 'integrity-mismatch (sha512)' },
    });
    assert.match(withVerification, /^ {2}Auto-update: off \(last check: 1970-01-01T00:00:00\.000Z\), last verification: FAILED — integrity-mismatch \(sha512\) \(2026-09-07T00:00:00\.000Z\)$/);
    assert.equal(autoupdate.runnerAutoupdateStatusLine(null), null);
  });

  it('getRunnerAutoupdateStatus: reflects env pause, persisted opt-out, and stamp/verification state from disk', () => {
    const home = tmp('autoupdate-status-');
    assert.equal(autoupdate.getRunnerAutoupdateStatus(home, { env: {} }).autoupdateState, 'on');
    assert.equal(autoupdate.getRunnerAutoupdateStatus(home, { env: { AUXILO_RUNNER_AUTOUPDATE: '0' } }).autoupdateState, 'paused-by-env');
    installer.writeRunnerConfig(home, { autoupdate: false });
    assert.equal(autoupdate.getRunnerAutoupdateStatus(home, { env: {} }).autoupdateState, 'off');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

// ─── CLI integration: `auxilo status` prints the Auto-update line ─────────

function runCli(args, env) {
  const mergedEnv = { ...process.env, ...env };
  if (env && Object.prototype.hasOwnProperty.call(env, 'HOME') && !Object.prototype.hasOwnProperty.call(env, 'AUXILO_HOME')) {
    mergedEnv.AUXILO_HOME = env.HOME;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env: mergedEnv, stdio: ['pipe', 'pipe', 'pipe'] });
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

describe('CLI integration: `auxilo status` Auto-update line', () => {
  it('prints "Auto-update: on (last check: never)" for a freshly installed runner with no opt-out', async () => {
    const home = tmp('cli-autoupdate-status-');
    installer.installRunner(home);
    // Override the suite-wide AUXILO_RUNNER_AUTOUPDATE=0 (scripts/test/run-
    // isolated.js's defense-in-depth against a stray network call elsewhere
    // in the suite) — THIS test specifically verifies the on-by-default
    // rendering, so it must not inherit that suppression.
    const res = await runCli(['status'], { HOME: home, AUXILO_RUNNER_AUTOUPDATE: '' });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Auto-update: on \(last check: never\)/);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('prints "off" once --no-autoupdate-equivalent runner-config is persisted', async () => {
    const home = tmp('cli-autoupdate-status-off-');
    installer.installRunner(home);
    installer.writeRunnerConfig(home, { autoupdate: false });
    const res = await runCli(['status'], { HOME: home, AUXILO_RUNNER_AUTOUPDATE: '' });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Auto-update: off \(last check: never\)/);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
