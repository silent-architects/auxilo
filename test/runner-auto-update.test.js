'use strict';

/**
 * test/runner-auto-update.test.js — RUNNER-AUTO-UPDATE (0.9.16) coverage,
 * including the 0.9.16 FIX PASS (security review B1/B2/B3/M4/L6/L7/L8/L9).
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
 * FIX PASS additions are tagged with the reviewer's finding id (B1/B2/B3/
 * M4/L6/L7/L8/L9). B1 and B2 changed stageAndSwap's actual mechanism (no
 * more whole-directory rename; the EXTRACTED tree's own installer.js is
 * require()d and invoked), so fixture tarballs built by buildFakeRelease()
 * now carry a real, working lib/installer.js — see fixtureInstallerSource()
 * — and stageAndSwap genuinely exercises "the extracted tree installs
 * itself", not a mock.
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

const REPO_PKG_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8')).version;

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

// ─── B1/B2 fixture support ───────────────────────────────────────────────
//
// stageAndSwap now require()s the EXTRACTED tree's OWN lib/installer.js and
// calls THAT tree's installRunnerAtomic (B2) — which writes per-file atomic
// (B1) straight into the real <home>/.auxilo/bin. So every fixture tarball
// that is meant to reach a successful install needs a REAL, working
// lib/installer.js inside it. fixtureInstallerSource() generates one,
// deliberately independent of the production lib/installer.js's internals
// (that file has its own coverage — "installer.js: installRunnerAtomic"
// below) — these tests are about stageAndSwap's require-and-invoke
// contract with WHATEVER the extracted tree provides.

/** Default fixture stack: just enough to prove an install happened. */
const FIXTURE_STACK_DEFAULT = [
  ['scripts/runner.js', 'scripts/runner.js', 0o755],
];

function fixtureInstallerSource(stackRows) {
  return `'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const RUNNER_STACK = ${JSON.stringify(stackRows)};
function binRootFor(homeDir) { return path.join(homeDir, '.auxilo', 'bin'); }
function atomicWrite(destPath, data, mode) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = destPath + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, data);
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, destPath);
}
function installRunnerAtomic(homeDir, opts) {
  opts = opts || {};
  const packageRoot = opts.packageRoot;
  const binRoot = binRootFor(homeDir);
  const installed = [];
  for (const row of RUNNER_STACK) {
    const src = row[0], dest = row[1], mode = row[2];
    const srcPath = path.join(packageRoot, src);
    const destPath = path.join(binRoot, dest);
    if (!fs.existsSync(srcPath)) throw new Error('installRunnerAtomic: missing package file ' + srcPath);
    atomicWrite(destPath, fs.readFileSync(srcPath), mode);
    installed.push(destPath);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8'));
  const versionPath = path.join(binRoot, 'VERSION');
  atomicWrite(versionPath, pkg.version + '\\n', 0o644);
  installed.push(versionPath);
  return { binRoot, versionPath, installed };
}
module.exports = { RUNNER_STACK, binRootFor, installRunnerAtomic };
`;
}

/**
 * Builds a full fake registry metadata doc + matching tarball bytes. The
 * tarball always contains a real, working lib/installer.js (see above) —
 * override `stackRows`/`extraFiles` to prove the EXTRACTED tree's own
 * (possibly LARGER) stack wins over the running copy's (B2 test below).
 */
function buildFakeRelease(version, { stackRows = FIXTURE_STACK_DEFAULT, extraFiles = {} } = {}) {
  const files = {
    'package.json': JSON.stringify({ name: 'auxilo-mcp', version }),
    'lib/installer.js': fixtureInstallerSource(stackRows),
    'scripts/runner.js': '// fixture marker file\nmodule.exports = {};\n',
    ...extraFiles,
  };
  const tarball = buildFixtureTarball(files);
  const integrity = sri(tarball);
  const signatures = signMetadata('auxilo-mcp', version, integrity);
  const meta = {
    name: 'auxilo-mcp',
    version,
    dist: {
      tarball: `https://registry.npmjs.org/auxilo-mcp/-/auxilo-mcp-${version}.tgz`,
      integrity,
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

/** @param {object} [headers]  e.g. { 'content-length': '123' } (L6). */
function bufferResponse(buffer, headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (Object.prototype.hasOwnProperty.call(lower, name.toLowerCase()) ? lower[name.toLowerCase()] : null) },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

/**
 * A fake `installer` for the orchestrator tests: readRunnerConfig/
 * writeRunnerConfig/binRootFor/packageVersion delegate to the REAL
 * lib/installer.js (pure, homeDir-scoped, already covered by its own
 * tests) so stageAndSwap's real fs.renameSync-per-file dance is genuinely
 * exercised against a real temp directory. installedRunnerVersion is the
 * only thing actually faked (the scenario under test). NOTE: unlike the
 * pre-fix-pass version of this helper, `installRunner` is deliberately NOT
 * provided — stageAndSwap no longer calls the injected installer's
 * installRunner at all (B2: it requires the EXTRACTED tree's own
 * installer.js instead), so a mock here would be dead code.
 */
function fakeInstaller(installedVersion, opts = {}) {
  return {
    readRunnerConfig: (home) => installer.readRunnerConfig(home),
    writeRunnerConfig: (home, patch) => installer.writeRunnerConfig(home, patch),
    binRootFor: (home) => installer.binRootFor(home),
    installedRunnerVersion: () => installedVersion,
    packageVersion: () => (opts.packageVersion !== undefined ? opts.packageVersion : REPO_PKG_VERSION),
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
// Integrity + signature verification (spec §3/§4, fix pass L9)
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

  it('verifyTarballIntegrity: L9 — refuses when integrity is absent (the sha1 shasum fallback was DELETED)', () => {
    const buf = Buffer.from('hello world');
    const shasum = crypto.createHash('sha1').update(buf).digest('hex');
    // Only a legacy shasum field, no integrity — old code fell back to sha1;
    // the fix requires sha512 unconditionally.
    const result = autoupdate.verifyTarballIntegrity(buf, { shasum });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing-or-non-sha512-integrity/);
    assert.equal(autoupdate.verifyTarballIntegrity(buf, {}).ok, false);
  });

  it('verifyTarballIntegrity / parseSri: L9 — sha256 and sha384 SRI strings are refused, only sha512 is accepted', () => {
    const buf = Buffer.from('hello world');
    const sha256 = `sha256-${crypto.createHash('sha256').update(buf).digest('base64')}`;
    const sha384 = `sha384-${crypto.createHash('sha384').update(buf).digest('base64')}`;
    assert.equal(autoupdate.parseSri(sha256), null);
    assert.equal(autoupdate.parseSri(sha384), null);
    assert.equal(autoupdate.verifyTarballIntegrity(buf, { integrity: sha256 }).ok, false);
    assert.equal(autoupdate.verifyTarballIntegrity(buf, { integrity: sha384 }).ok, false);
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
// fetchTarball hardening (fix pass L6): host-pinning, redirect refusal, size cap
// ═════════════════════════════════════════════════════════════════════════

describe('runner-autoupdate: fetchTarball hardening (L6)', () => {
  it('host-pinning refusal: a tarball URL outside registry.npmjs.org is refused before any fetch is attempted', async () => {
    let called = false;
    const fi = async () => { called = true; return bufferResponse(Buffer.from('x')); };
    await assert.rejects(
      () => autoupdate.fetchTarball(fi, 'https://evil.example.com/auxilo-mcp-0.9.16.tgz', 1000),
      /refusing tarball URL outside registry\.npmjs\.org/
    );
    assert.equal(called, false, 'fetchImpl must never be invoked for an off-host URL');
  });

  it('forces redirect: "error" on the underlying fetch call', async () => {
    let seenInit = null;
    const fi = async (url, init) => { seenInit = init; return bufferResponse(Buffer.from('x')); };
    await autoupdate.fetchTarball(fi, `https://${autoupdate.REGISTRY_HOST}/auxilo-mcp-0.9.16.tgz`, 1000);
    assert.equal(seenInit.redirect, 'error');
  });

  it('fetchLatestMetadata also forces redirect: "error"', async () => {
    let seenInit = null;
    const fi = async (url, init) => { seenInit = init; return jsonResponse({ version: '1.0.0' }); };
    await autoupdate.fetchLatestMetadata(fi, 1000);
    assert.equal(seenInit.redirect, 'error');
  });

  it('a declared content-length over the cap is refused before the body is read', async () => {
    const url = `https://${autoupdate.REGISTRY_HOST}/big.tgz`;
    const fi = fakeFetch({
      [url]: bufferResponse(Buffer.from('small-body-but-lying-header'), { 'content-length': String(autoupdate.MAX_TARBALL_BYTES + 1) }),
    });
    await assert.rejects(() => autoupdate.fetchTarball(fi, url, 1000), /exceeds size cap/);
  });

  it('a streamed body exceeding the cap (no honest content-length) is aborted mid-stream, never fully buffered', async () => {
    const chunkSize = 1024 * 1024;
    const chunkCount = Math.ceil(autoupdate.MAX_TARBALL_BYTES / chunkSize) + 2;
    let cancelled = false;
    const fi = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader() {
          let i = 0;
          return {
            read: async () => {
              if (i >= chunkCount) return { done: true, value: undefined };
              i++;
              return { done: false, value: new Uint8Array(chunkSize) };
            },
            cancel: async () => { cancelled = true; },
          };
        },
      },
    });
    await assert.rejects(
      () => autoupdate.fetchTarball(fi, `https://${autoupdate.REGISTRY_HOST}/huge.tgz`, 1000),
      /exceeds size cap while streaming/
    );
    assert.equal(cancelled, true, 'the reader must be cancelled once the cap is exceeded');
  });

  it('a body within the cap streams through normally and reassembles intact', async () => {
    const payload = Buffer.from('hello world, this is a small fixture tarball body');
    const fi = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader() {
          let sent = false;
          return {
            read: async () => {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: payload };
            },
            cancel: async () => {},
          };
        },
      },
    });
    const buf = await autoupdate.fetchTarball(fi, `https://${autoupdate.REGISTRY_HOST}/ok.tgz`, 1000);
    assert.equal(buf.toString('utf-8'), payload.toString('utf-8'));
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

// B3 fix: the in-flight extraction marker is now PID-SCOPED — one marker
// file per pid in a directory, and a caller's OWN pid is always excluded
// from its own isExtractionInProgress check (see lib/runner-autoupdate.js
// doc comment on extractionLockDir).
describe('runner-autoupdate: in-flight extraction lock (PID-scoped, B3)', () => {
  let home;
  before(() => { home = tmp('autoupdate-lock-'); });
  after(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('absent → not in progress', () => {
    assert.equal(autoupdate.isExtractionInProgress(home), false);
  });

  it("a runner's OWN marker (default pid = process.pid) never blocks its own check", () => {
    autoupdate.markExtractionStart(home);
    assert.equal(autoupdate.isExtractionInProgress(home), false, 'a process must not see its own marker as another runner in flight');
    autoupdate.markExtractionEnd(home);
    assert.equal(autoupdate.isExtractionInProgress(home), false);
  });

  it("ANOTHER process's marker (stubbed pid) IS seen as in-progress; clearing it clears the state", () => {
    autoupdate.markExtractionStart(home, { pid: 424242 });
    assert.equal(autoupdate.isExtractionInProgress(home), true);
    autoupdate.markExtractionEnd(home, { pid: 424242 });
    assert.equal(autoupdate.isExtractionInProgress(home), false);
  });

  it('a stale OTHER-process marker (older than the tolerance window) reads as NOT in progress', () => {
    autoupdate.markExtractionStart(home, { pid: 424242 });
    const old = Date.now() - (autoupdate.STALE_LOCK_MS + 60000);
    fs.utimesSync(autoupdate.extractionMarkerPath(home, 424242), old / 1000, old / 1000);
    assert.equal(autoupdate.isExtractionInProgress(home, Date.now()), false);
    autoupdate.markExtractionEnd(home, { pid: 424242 });
  });

  it('multiple other-process markers: only a FRESH one counts as in-progress', () => {
    autoupdate.markExtractionStart(home, { pid: 111 });
    const old = Date.now() - (autoupdate.STALE_LOCK_MS + 60000);
    fs.utimesSync(autoupdate.extractionMarkerPath(home, 111), old / 1000, old / 1000);
    autoupdate.markExtractionStart(home, { pid: 222 });
    assert.equal(autoupdate.isExtractionInProgress(home), true);
    autoupdate.markExtractionEnd(home, { pid: 111 });
    autoupdate.markExtractionEnd(home, { pid: 222 });
    assert.equal(autoupdate.isExtractionInProgress(home), false);
  });
});

// B3 fix: a second, independent exclusive lock around the whole risky
// fetch→verify→extract→install section, using O_EXCL create semantics.
describe('runner-autoupdate: exclusive update lock (O_EXCL, stale-tolerant, B3)', () => {
  it('acquire succeeds; a second acquire before release fails; release then re-acquire succeeds', () => {
    const home = tmp('autoupdate-updatelock-');
    const now = Date.now();
    const first = autoupdate.acquireUpdateLock(home, now);
    assert.equal(first.ok, true);
    const second = autoupdate.acquireUpdateLock(home, now);
    assert.equal(second.ok, false);
    autoupdate.releaseUpdateLock(home);
    const third = autoupdate.acquireUpdateLock(home, now);
    assert.equal(third.ok, true);
    autoupdate.releaseUpdateLock(home);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('a stale lock (older than STALE_LOCK_MS) is reclaimed rather than wedging auto-update forever', () => {
    const home = tmp('autoupdate-updatelock-stale-');
    const t0 = Date.now();
    const first = autoupdate.acquireUpdateLock(home, t0);
    assert.equal(first.ok, true);
    const old = t0 - autoupdate.STALE_LOCK_MS - 60000;
    fs.utimesSync(autoupdate.updateLockPath(home), old / 1000, old / 1000);
    const reclaimed = autoupdate.acquireUpdateLock(home, t0 + autoupdate.STALE_LOCK_MS + 60000);
    assert.equal(reclaimed.ok, true);
    autoupdate.releaseUpdateLock(home);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// installer.js: installRunner binRootOverride seam (RUNNER-AUTO-UPDATE addition)
// ═════════════════════════════════════════════════════════════════════════

describe('installer.installRunner: binRootOverride (staging seam, general-purpose, unrelated to the auto-updater since the B1 fix)', () => {
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

// B1 fix: the auto-updater no longer uses installRunner+binRootOverride at
// all — it uses installRunnerAtomic, which writes straight into the REAL
// bin root, per file, atomically, and never touches anything it doesn't
// know about.
describe('installer.js: installRunnerAtomic (RUNNER-AUTO-UPDATE B1 — per-file atomic install into the REAL bin root)', () => {
  it('writes the full stack + hook + VERSION directly into <home>/.auxilo/bin', () => {
    const home = tmp('installrunneratomic-basic-');
    const res = installer.installRunnerAtomic(home);
    assert.equal(res.binRoot, installer.binRootFor(home));
    assert.equal(fs.existsSync(path.join(res.binRoot, 'scripts', 'runner.js')), true);
    assert.equal(fs.existsSync(res.hookPath), true);
    assert.equal(fs.existsSync(res.versionPath), true);
    assert.equal(fs.readFileSync(res.versionPath, 'utf-8').trim(), installer.packageVersion());
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('leaves sibling files/dirs in <bin> that it does not know about completely untouched', () => {
    const home = tmp('installrunneratomic-siblings-');
    const binRoot = installer.binRootFor(home);
    fs.mkdirSync(path.join(binRoot, 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(binRoot, 'capture-shim-x.sh'), 'sentinel-shim');
    fs.writeFileSync(path.join(binRoot, 'jobs', 'sweeper.sh'), 'sentinel-sweeper');
    installer.installRunnerAtomic(home);
    assert.equal(fs.readFileSync(path.join(binRoot, 'capture-shim-x.sh'), 'utf-8'), 'sentinel-shim');
    assert.equal(fs.readFileSync(path.join(binRoot, 'jobs', 'sweeper.sh'), 'utf-8'), 'sentinel-sweeper');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('a re-run overwrites existing stack files atomically, leaving no leftover .tmp- files', () => {
    const home = tmp('installrunneratomic-rerun-');
    installer.installRunnerAtomic(home);
    installer.installRunnerAtomic(home);
    const binRoot = installer.binRootFor(home);
    const leftoverTmp = fs.readdirSync(path.join(binRoot, 'scripts')).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftoverTmp, []);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('throws when a RUNNER_STACK source file is missing from packageRoot (never partially installs silently)', () => {
    const home = tmp('installrunneratomic-missing-');
    const fakePackageRoot = tmp('installrunneratomic-missing-pkg-');
    assert.throws(() => installer.installRunnerAtomic(home, { packageRoot: fakePackageRoot }), /missing package file/);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fakePackageRoot, { recursive: true, force: true });
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
  it("installs the newer version atomically, via the extracted tree's own installer (B2), and logs the effective-next-session line", async () => {
    const home = tmp('autoupdate-spec1-');
    const { meta, tarball } = buildFakeRelease('0.9.16');
    const logs = [];

    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller('0.9.14'),
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
    assert.equal(
      fs.readFileSync(path.join(installer.binRootFor(home), 'VERSION'), 'utf-8').trim(),
      '0.9.16'
    );
    assert.equal(fs.existsSync(path.join(installer.binRootFor(home), 'scripts', 'runner.js')), true);
    assert.ok(logs.some((l) => /updated to v0\.9\.16, effective next session/.test(l)));
    assert.equal(autoupdate.readLastCheckStamp(home), 1000000);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('B1: sibling files/dirs in <bin> the auto-updater does not manage (capture shims, jobs/) survive the update untouched; no .new/.prev scratch dirs are created', async () => {
    const home = tmp('autoupdate-spec1-siblings-');
    const binRoot = installer.binRootFor(home);
    fs.mkdirSync(path.join(binRoot, 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(binRoot, 'capture-shim-claude-code.sh'), '#!/bin/sh\necho shim\n');
    fs.writeFileSync(path.join(binRoot, 'jobs', 'sweeper.sh'), '#!/bin/sh\necho sweep\n');
    fs.writeFileSync(path.join(binRoot, 'VERSION'), '0.9.14\n');

    const { meta, tarball } = buildFakeRelease('0.9.15');
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller('0.9.14'),
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({
        [autoupdate.REGISTRY_LATEST_URL]: jsonResponse(meta),
        [meta.dist.tarball]: bufferResponse(tarball),
      }),
      log: () => {},
      now: 1,
    });

    assert.equal(result.status, 'updated');
    // The OLD whole-directory-rename design silently deleted these.
    assert.equal(fs.existsSync(path.join(binRoot, 'capture-shim-claude-code.sh')), true);
    assert.equal(fs.readFileSync(path.join(binRoot, 'capture-shim-claude-code.sh'), 'utf-8'), '#!/bin/sh\necho shim\n');
    assert.equal(fs.existsSync(path.join(binRoot, 'jobs', 'sweeper.sh')), true);
    assert.equal(fs.readFileSync(path.join(binRoot, 'jobs', 'sweeper.sh'), 'utf-8'), '#!/bin/sh\necho sweep\n');
    assert.equal(fs.existsSync(`${binRoot}.new`), false);
    assert.equal(fs.existsSync(`${binRoot}.prev`), false);
    assert.equal(fs.readFileSync(path.join(binRoot, 'VERSION'), 'utf-8').trim(), '0.9.15');

    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("checkAndApplyRunnerUpdate — B2: installs via the EXTRACTED tree's own installer, not the running copy's stack", () => {
  it('a fixture "newer" release whose RUNNER_STACK includes a file this running copy has never heard of is still installed in full', async () => {
    const home = tmp('autoupdate-b2-');
    const biggerStack = [
      ['scripts/runner.js', 'scripts/runner.js', 0o755],
      ['lib/new-feature.js', 'lib/new-feature.js', 0o644],
    ];
    const { meta, tarball } = buildFakeRelease('0.9.17', {
      stackRows: biggerStack,
      extraFiles: { 'lib/new-feature.js': 'module.exports = { newFeature: true };\n' },
    });

    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller('0.9.14'),
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({
        [autoupdate.REGISTRY_LATEST_URL]: jsonResponse(meta),
        [meta.dist.tarball]: bufferResponse(tarball),
      }),
      log: () => {},
      now: 1,
    });

    assert.equal(result.status, 'updated');
    const installedNewFile = path.join(installer.binRootFor(home), 'lib', 'new-feature.js');
    assert.equal(fs.existsSync(installedNewFile), true);
    assert.equal(fs.readFileSync(installedNewFile, 'utf-8'), 'module.exports = { newFeature: true };\n');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('checkAndApplyRunnerUpdate — SPEC #2/#3: same or older fetched version → no-op, no log, stamp touched', () => {
  it('equal version: no swap, no log line', async () => {
    const home = tmp('autoupdate-spec2-');
    const { meta } = buildFakeRelease('0.9.15');
    const logs = [];
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller('0.9.15'),
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({ [autoupdate.REGISTRY_LATEST_URL]: jsonResponse(meta) }),
      log: (m) => logs.push(m),
      now: 5000,
    });
    assert.equal(result.status, 'no-op');
    assert.deepEqual(logs, []);
    assert.equal(autoupdate.readLastCheckStamp(home), 5000);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('older fetched version than installed: no swap, no log line (refuse-downgrade)', async () => {
    const home = tmp('autoupdate-spec3-');
    const { meta } = buildFakeRelease('0.9.10');
    const logs = [];
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller('0.9.15'),
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({ [autoupdate.REGISTRY_LATEST_URL]: jsonResponse(meta) }),
      log: (m) => logs.push(m),
      now: 6000,
    });
    assert.equal(result.status, 'no-op');
    assert.deepEqual(logs, []);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('checkAndApplyRunnerUpdate — SPEC #4: registry fetch fails/times out → continue, one log line, stamp updated', () => {
  it('fetch throwing (network error) falls through to the current copy', async () => {
    const home = tmp('autoupdate-spec4-');
    const logs = [];
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller('0.9.15'),
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({ [autoupdate.REGISTRY_LATEST_URL]: new Error('getaddrinfo ENOTFOUND registry.npmjs.org') }),
      log: (m) => logs.push(m),
      now: 7000,
    });
    assert.equal(result.status, 'check-failed');
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

describe('checkAndApplyRunnerUpdate — SPEC #5: integrity mismatch → refuse, log, bin untouched', () => {
  it('a tampered tarball (integrity mismatch) is refused and never installed', async () => {
    const home = tmp('autoupdate-spec5-');
    const { meta, tarball } = buildFakeRelease('0.9.16');
    const tampered = Buffer.concat([tarball, Buffer.from('extra-bytes')]); // breaks the sha512
    const logs = [];

    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller('0.9.14'),
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
    assert.equal(fs.existsSync(installer.binRootFor(home)), false, 'installRunnerAtomic must never be invoked on a failed verification');
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

    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller('0.9.14'),
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
    assert.equal(fs.existsSync(installer.binRootFor(home)), false);
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
  it("ANOTHER process's marker (stubbed pid) → skipped (no fetch); cleared → the retry on the next call succeeds", async () => {
    const home = tmp('autoupdate-spec8-');
    const otherPid = 999999; // simulate a different, overlapping runner process
    autoupdate.markExtractionStart(home, { pid: otherPid });
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

    autoupdate.markExtractionEnd(home, { pid: otherPid });
    const { meta, tarball } = buildFakeRelease('0.9.16');
    const retried = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller('0.9.14'),
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

  it("B3: a runner's OWN in-flight marker (its own pid, marked BEFORE the update check per the new scripts/runner.js ordering) never blocks its own update check", async () => {
    const home = tmp('autoupdate-spec8-self-');
    autoupdate.markExtractionStart(home); // default: process.pid (this test process)
    const { meta, tarball } = buildFakeRelease('0.9.16');
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller('0.9.14'),
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({
        [autoupdate.REGISTRY_LATEST_URL]: jsonResponse(meta),
        [meta.dist.tarball]: bufferResponse(tarball),
      }),
      log: () => {},
      now: Date.now(),
    });
    assert.equal(result.status, 'updated');
    autoupdate.markExtractionEnd(home);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('checkAndApplyRunnerUpdate — B3: a held update lock skips this run without fetching', () => {
  it('lock already held (another process) → status skipped-locked, zero fetch calls, no stamp write', async () => {
    const home = tmp('autoupdate-b3-locked-');
    const now = Date.now();
    const held = autoupdate.acquireUpdateLock(home, now);
    assert.equal(held.ok, true);
    let fetchCalls = 0;
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller('0.9.14'),
      fetchImpl: async () => { fetchCalls++; throw new Error('must not be called'); },
      log: () => {},
      now,
    });
    assert.equal(result.status, 'skipped-locked');
    assert.equal(fetchCalls, 0);
    autoupdate.releaseUpdateLock(home);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('the lock is released after a successful update (a subsequent call can acquire it again)', async () => {
    const home = tmp('autoupdate-b3-release-');
    const { meta, tarball } = buildFakeRelease('0.9.16');
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller('0.9.14'),
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({
        [autoupdate.REGISTRY_LATEST_URL]: jsonResponse(meta),
        [meta.dist.tarball]: bufferResponse(tarball),
      }),
      log: () => {},
      now: 1,
    });
    assert.equal(result.status, 'updated');
    const canAcquire = autoupdate.acquireUpdateLock(home, 2);
    assert.equal(canAcquire.ok, true);
    autoupdate.releaseUpdateLock(home);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('checkAndApplyRunnerUpdate — M4: an unknown installed version does not blindly install', () => {
  it('installed version unknown (no VERSION stamp) and the fetched version is NOT newer than the RUNNING package → refused, nothing installed', async () => {
    const home = tmp('autoupdate-m4-refuse-');
    const { meta } = buildFakeRelease(REPO_PKG_VERSION); // same as our own running version — not "newer"
    const logs = [];
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller(null),
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({ [autoupdate.REGISTRY_LATEST_URL]: jsonResponse(meta) }),
      log: (m) => logs.push(m),
      now: 1,
    });
    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'unknown-installed-version');
    assert.equal(fs.existsSync(installer.binRootFor(home)), false);
    assert.ok(logs.some((l) => /unknown-installed-version|installed runner version is unknown/.test(l)));
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('installed version unknown BUT the fetched version IS newer than the running package → proceeds to install', async () => {
    const home = tmp('autoupdate-m4-proceed-');
    const newer = '9.9.9'; // guaranteed greater than any real REPO_PKG_VERSION
    const { meta, tarball } = buildFakeRelease(newer);
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller(null),
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({
        [autoupdate.REGISTRY_LATEST_URL]: jsonResponse(meta),
        [meta.dist.tarball]: bufferResponse(tarball),
      }),
      log: () => {},
      now: 1,
    });
    assert.equal(result.status, 'updated');
    assert.equal(result.version, newer);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('checkAndApplyRunnerUpdate — L7: the registry version string is strictly validated before it is persisted or logged', () => {
  it('a non-semver version string (newline/ANSI-bearing) is refused, never persisted to last_known_latest, never echoed raw in a log line', async () => {
    const home = tmp('autoupdate-l7-');
    const evilVersion = '0.9.16\n\x1b[31mPWNED\x1b[0m';
    const meta = {
      name: 'auxilo-mcp',
      version: evilVersion,
      dist: { tarball: `https://${autoupdate.REGISTRY_HOST}/auxilo-mcp-evil.tgz`, integrity: 'sha512-AA==' },
    };
    const logs = [];
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller('0.9.14'),
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({ [autoupdate.REGISTRY_LATEST_URL]: jsonResponse(meta) }),
      log: (m) => logs.push(m),
      now: 1,
    });
    assert.equal(result.status, 'check-failed');
    assert.equal(result.reason, 'malformed-version');
    const cfg = installer.readRunnerConfig(home);
    assert.equal(cfg.last_known_latest, undefined, 'an unvalidated version string must never reach runner-config.json');
    for (const l of logs) {
      assert.ok(!l.includes(evilVersion), `log line echoed the unparsed version string raw: ${JSON.stringify(l)}`);
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('a well-formed semver (including a prerelease suffix) still passes through normally', async () => {
    const home = tmp('autoupdate-l7-good-');
    const { meta, tarball } = buildFakeRelease('0.9.17-beta.1');
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller('0.9.14'),
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({
        [autoupdate.REGISTRY_LATEST_URL]: jsonResponse(meta),
        [meta.dist.tarball]: bufferResponse(tarball),
      }),
      log: () => {},
      now: 1,
    });
    assert.equal(result.status, 'updated');
    assert.equal(result.version, '0.9.17-beta.1');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('checkAndApplyRunnerUpdate — L8: an install failure records last_update_error for `auxilo status`', () => {
  it('extraction/install throwing (no lib/installer.js in the tarball) → refused, and last_update_error is persisted + rendered', async () => {
    const home = tmp('autoupdate-l8-');
    const version = '0.9.16';
    // Deliberately NO lib/installer.js — stageAndSwap's require() must throw.
    const files = { 'package.json': JSON.stringify({ name: 'auxilo-mcp', version }) };
    const tarball = buildFixtureTarball(files);
    const integrity = sri(tarball);
    const signatures = signMetadata('auxilo-mcp', version, integrity);
    const meta = { name: 'auxilo-mcp', version, dist: { tarball: `https://${autoupdate.REGISTRY_HOST}/no-installer.tgz`, integrity, signatures } };

    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller('0.9.14'),
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({
        [autoupdate.REGISTRY_LATEST_URL]: jsonResponse(meta),
        [meta.dist.tarball]: bufferResponse(tarball),
      }),
      log: () => {},
      now: 1,
    });
    assert.equal(result.status, 'refused');
    const cfg = installer.readRunnerConfig(home);
    assert.ok(cfg.last_update_error && cfg.last_update_error.reason, 'last_update_error must be persisted on an install failure');
    const status = autoupdate.getRunnerAutoupdateStatus(home, { env: {} });
    assert.ok(status.lastUpdateError && status.lastUpdateError.reason);
    const line = autoupdate.runnerAutoupdateStatusLine(status);
    assert.match(line, /last update error:/);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('a subsequent SUCCESSFUL update clears last_update_error', async () => {
    const home = tmp('autoupdate-l8-clear-');
    installer.writeRunnerConfig(home, { last_update_error: { reason: 'stale failure', at: '2020-01-01T00:00:00.000Z' } });
    const { meta, tarball } = buildFakeRelease('0.9.16');
    const result = await autoupdate.checkAndApplyRunnerUpdate(home, {
      env: {},
      installer: fakeInstaller('0.9.14'),
      pinnedKeys: testPinnedKeys,
      fetchImpl: fakeFetch({
        [autoupdate.REGISTRY_LATEST_URL]: jsonResponse(meta),
        [meta.dist.tarball]: bufferResponse(tarball),
      }),
      log: () => {},
      now: 1,
    });
    assert.equal(result.status, 'updated');
    const cfg = installer.readRunnerConfig(home);
    assert.equal(cfg.last_update_error, null);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// `auxilo status` — Auto-update line (spec §6, fix pass L8)
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

  it('L8: renders a last update error when present, appended after verification', () => {
    const line = autoupdate.runnerAutoupdateStatusLine({
      lastCheckAt: 0,
      autoupdateState: 'on',
      lastVerification: null,
      lastUpdateError: { reason: 'install failed (ENOENT)', at: '2026-09-07T00:00:00.000Z' },
    });
    assert.match(line, /last update error: install failed \(ENOENT\) \(2026-09-07T00:00:00\.000Z\)$/);
  });

  it('getRunnerAutoupdateStatus: reflects env pause, persisted opt-out, and stamp/verification/error state from disk', () => {
    const home = tmp('autoupdate-status-');
    assert.equal(autoupdate.getRunnerAutoupdateStatus(home, { env: {} }).autoupdateState, 'on');
    assert.equal(autoupdate.getRunnerAutoupdateStatus(home, { env: { AUXILO_RUNNER_AUTOUPDATE: '0' } }).autoupdateState, 'paused-by-env');
    installer.writeRunnerConfig(home, { autoupdate: false });
    assert.equal(autoupdate.getRunnerAutoupdateStatus(home, { env: {} }).autoupdateState, 'off');
    assert.equal(autoupdate.getRunnerAutoupdateStatus(home, { env: {} }).lastUpdateError, null);
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
