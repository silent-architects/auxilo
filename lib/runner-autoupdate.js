'use strict';

/**
 * lib/runner-autoupdate.js — Runner self-update on the hook path
 * (RUNNER-AUTO-UPDATE, 0.9.16).
 *
 * `auxilo setup` copies the extraction runner stack (RUNNER_STACK) into
 * <home>/.auxilo/bin ONCE, and the SessionEnd hook always execs whatever is
 * on disk there — nothing ever re-copies it. A real install can sit on a
 * stale runner indefinitely (the operator's own machine sat on 0.9.14
 * through the entire 0.9.15 privacy-fix window because `setup` was never
 * re-run). This module closes that gap: it runs on the SAME hook path,
 * before any extraction work, at most once per 24h, and — offline or not —
 * NEVER blocks or fails extraction.
 *
 * Call site: scripts/runner.js's main(), immediately after the kill-switch
 * sentinel + recursion-guard block and before the credentials check (see
 * BUILD-SPEC-RUNNER-AUTO-UPDATE-2026-09-07.md §2 "Trigger point").
 *
 * ── What is verified, and how ──────────────────────────────────────────
 *   1. `GET https://registry.npmjs.org/auxilo-mcp/latest` (2s timeout).
 *      PACKAGE_NAME is a hardcoded literal everywhere — never read from the
 *      response — closing a name-confusion/typosquat vector.
 *   2. The fetched version must be semver-GREATER than the installed
 *      runner stamp (<home>/.auxilo/bin/VERSION). Equal or older is a
 *      silent no-op; this also structurally refuses downgrade.
 *   3. The tarball URL (`dist.tarball`) must be `https://registry.npmjs.org/…`
 *      — refused otherwise, before any download.
 *   4. The downloaded tarball's SHA-512 must match `dist.integrity` (npm's
 *      own SRI string — the same check `npm install` performs internally),
 *      falling back to `dist.shasum` (SHA-1) only if integrity is absent.
 *   5. The registry's own detached signature (`dist.signatures[]`) must
 *      verify against a PINNED npm registry public key (ECDSA P-256/SHA-256
 *      over the exact string `${name}@${version}:${integrity}` — this is
 *      npm's own registry-signing scheme; see NPM_REGISTRY_SIGNING_KEYS
 *      below for the refresh path).
 *   Either (4) or (5) failing → REFUSE. Nothing is installed, the current
 *   copy is untouched, one log line states verification failed (fail-closed,
 *   never silent), and the failure is recorded for `auxilo status`.
 *
 * ── What happens on failure ────────────────────────────────────────────
 * Any failure at any stage (offline, timeout, malformed JSON, wrong host,
 * integrity mismatch, signature mismatch, extraction error, install error)
 * falls through to normal extraction on the CURRENTLY installed copy. This
 * function never throws and never changes the caller's exit path.
 *
 * ── When the new code first runs ───────────────────────────────────────
 * The swap is `fs.renameSync` of a fully-staged, fully-verified directory
 * into place — the ONLY irreversible step, and it's a single syscall. The
 * CURRENT process has already loaded/executed code from the OLD tree and
 * keeps running on it for the rest of this invocation (Node does not hot-
 * swap already-`require()`d modules, and a live process reading files out
 * from under itself mid-run is exactly what the in-flight guard below
 * exists to prevent for OTHER concurrent processes). The new copy takes
 * effect starting with the NEXT session's SessionEnd hook invocation. No
 * re-exec is attempted.
 *
 * ── Opt-out surfaces ────────────────────────────────────────────────────
 *   - `AUXILO_RUNNER_AUTOUPDATE=0` (env, this run only, no persistence).
 *   - `auxilo setup --no-autoupdate` → persists `{ autoupdate: false }` to
 *     <home>/.auxilo/runner-config.json (lib/installer.js readRunnerConfig/
 *     writeRunnerConfig).
 * Either one skips the network check entirely for that run (no fetch is
 * made) — see isAutoupdateOptedOut / checkAndApplyRunnerUpdate. A notice is
 * still printed when a previously-cached "last known latest" (recorded by
 * an earlier, non-opted-out check) is newer than the installed runner, so
 * an opted-out user still learns an update exists without this run itself
 * touching the network.
 *
 * @module runner-autoupdate
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { extractTarGz } = require('./tar-extract.js');
const { semverGt } = require('./semver-min.js');
const installerDefault = require('./installer.js');

// ─── Constants ──────────────────────────────────────────────────────────────

/** Hardcoded literal — NEVER derived from fetched registry data (GOV-3). */
const PACKAGE_NAME = 'auxilo-mcp';
const REGISTRY_HOST = 'registry.npmjs.org';
const REGISTRY_LATEST_URL = `https://${REGISTRY_HOST}/${PACKAGE_NAME}/latest`;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** SessionEnd hooks must not hold up session teardown (spec §2). */
const METADATA_FETCH_TIMEOUT_MS = 2000;
/**
 * Not spec-mandated (spec only pins 2s for the metadata GET) — a tarball is
 * tens to low hundreds of KB and deserves more slack than the metadata
 * probe before we give up and fall back to the current copy.
 */
const TARBALL_FETCH_TIMEOUT_MS = 10000;
/** In-flight lock: tolerate a marker left behind by a process that died
 * without running its exit handler (e.g. SIGKILL) rather than wedging auto-
 * update forever. Generous on purpose — a real extraction run is seconds,
 * not hours. */
const STALE_LOCK_MS = 2 * 60 * 60 * 1000;

/**
 * npm registry signing keys, PINNED (not fetched at verify time — a
 * compromised/MITM'd fetch of the keys endpoint would defeat the whole
 * point of pinning). Only keys with a null `expires` in the registry's own
 * `/-/npm/v1/keys` response are current; this array holds exactly those,
 * live-fetched and hand-verified against a real signed package
 * (auxilo-mcp@0.9.15) during this build — see BUILD-SPEC-RUNNER-AUTO-UPDATE
 * §3/§4.
 *
 * REFRESH PATH (when npm rotates keys): `curl
 * https://registry.npmjs.org/-/npm/v1/keys`, take the entries with
 * `"expires":null`, add their `{keyid, key}` here (key is the base64 DER
 * SubjectPublicKeyInfo, exactly as the endpoint returns it — no
 * reformatting needed, crypto.createPublicKey({key, format:'der',
 * type:'spki'}) below consumes it directly). Old keys can stay listed even
 * after rotation (harmless — a signature just won't match an expired key
 * used going forward) or be pruned; either is safe.
 */
const NPM_REGISTRY_SIGNING_KEYS = Object.freeze([
  Object.freeze({
    keyid: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U',
    key: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==',
  }),
]);

// ─── Cadence stamp (plain-text ISO timestamp, spec §2) ──────────────────────

function lastCheckStampPath(homeDir) {
  return path.join(homeDir, '.auxilo', 'last-runner-update-check');
}

/** @returns {number|null} epoch ms, or null when absent/unparsable (→ "never checked"). */
function readLastCheckStamp(homeDir) {
  try {
    const raw = fs.readFileSync(lastCheckStampPath(homeDir), 'utf-8').trim();
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** Best-effort — a failed stamp write must never throw. */
function writeLastCheckStamp(homeDir, now) {
  try {
    const p = lastCheckStampPath(homeDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${new Date(now).toISOString()}\n`);
  } catch {
    /* best-effort */
  }
}

function shouldCheckNow(homeDir, now, intervalMs = ONE_DAY_MS) {
  const last = readLastCheckStamp(homeDir);
  if (last === null) return true;
  return now - last >= intervalMs;
}

// ─── Opt-out (spec §6) ───────────────────────────────────────────────────────

/** Env opt-out is per-run, not persisted; config opt-out is `auxilo setup --no-autoupdate`. */
function isEnvOptedOut(env) {
  return env.AUXILO_RUNNER_AUTOUPDATE === '0';
}

function isConfigOptedOut(homeDir, installer) {
  const cfg = installer.readRunnerConfig(homeDir);
  return cfg && cfg.autoupdate === false;
}

function isAutoupdateOptedOut(homeDir, env, installer) {
  return isEnvOptedOut(env) || isConfigOptedOut(homeDir, installer);
}

// ─── In-flight extraction lock (spec §2 "never swap while a spawn is in flight") ──

function extractionLockPath(homeDir) {
  return path.join(homeDir, '.auxilo', 'extraction-in-progress');
}

/**
 * True iff a lock marker exists AND is fresh (younger than STALE_LOCK_MS).
 * A stale marker (left by a process that never reached its cleanup, e.g.
 * SIGKILL) is treated as absent — this guard must not wedge auto-update
 * forever over a single crashed run.
 */
function isExtractionInProgress(homeDir, now = Date.now(), staleMs = STALE_LOCK_MS) {
  try {
    const stat = fs.statSync(extractionLockPath(homeDir));
    return now - stat.mtimeMs < staleMs;
  } catch {
    return false;
  }
}

/** Call at the top of runner.js's extraction-work block. Best-effort. */
function markExtractionStart(homeDir) {
  try {
    const p = extractionLockPath(homeDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${process.pid}\n${new Date().toISOString()}\n`);
  } catch {
    /* best-effort — see doc comment on markExtractionEnd */
  }
}

/**
 * Call in a `process.on('exit', ...)` handler, NOT a try/finally — main()
 * in scripts/runner.js calls process.exit() from many branches, and Node
 * does not run pending finally blocks across a process.exit() call, but it
 * DOES fire the 'exit' event synchronously first. That is the one cleanup
 * hook that reliably fires on every one of those exit paths (and on an
 * uncaught exception).
 */
function markExtractionEnd(homeDir) {
  try {
    fs.unlinkSync(extractionLockPath(homeDir));
  } catch {
    /* best-effort */
  }
}

// ─── Integrity + signature verification (spec §3/§4) ────────────────────────

/** `dist.integrity` is `sha512-<base64>`. Returns the algo + raw base64, or null if malformed. */
function parseSri(integrity) {
  const m = /^(sha512|sha384|sha256)-([A-Za-z0-9+/=]+)$/.exec(String(integrity || ''));
  return m ? { algo: m[1], digestB64: m[2] } : null;
}

/**
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifyTarballIntegrity(buffer, dist) {
  const sri = parseSri(dist && dist.integrity);
  if (sri) {
    const nodeAlgo = { sha512: 'sha512', sha384: 'sha384', sha256: 'sha256' }[sri.algo];
    const actual = crypto.createHash(nodeAlgo).update(buffer).digest();
    const expected = Buffer.from(sri.digestB64, 'base64');
    const ok = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    return ok ? { ok: true } : { ok: false, reason: `integrity-mismatch (${sri.algo})` };
  }
  // Pre-2018-publish fallback (won't occur for this package, defensive only).
  if (dist && dist.shasum) {
    const actualHex = crypto.createHash('sha1').update(buffer).digest('hex');
    const ok = actualHex === String(dist.shasum).toLowerCase();
    return ok ? { ok: true } : { ok: false, reason: 'shasum-mismatch' };
  }
  return { ok: false, reason: 'no-integrity-field' };
}

/**
 * @param {{name:string, version:string, integrity:string, signatures?: Array<{keyid:string,sig:string}>}} pkg
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifyRegistrySignature(pkg, pinnedKeys = NPM_REGISTRY_SIGNING_KEYS) {
  const signatures = (pkg && pkg.signatures) || [];
  if (signatures.length === 0) return { ok: false, reason: 'no-signatures-in-metadata' };
  const message = Buffer.from(`${pkg.name}@${pkg.version}:${pkg.integrity}`);
  for (const sig of signatures) {
    const pinned = pinnedKeys.find((k) => k.keyid === sig.keyid);
    if (!pinned) continue; // signed with a key we don't pin — try the next one
    try {
      const publicKey = crypto.createPublicKey({
        key: Buffer.from(pinned.key, 'base64'),
        format: 'der',
        type: 'spki',
      });
      const ok = crypto.verify(
        'sha256',
        message,
        { key: publicKey, dsaEncoding: 'der' },
        Buffer.from(sig.sig, 'base64')
      );
      if (ok) return { ok: true };
    } catch {
      continue; // malformed key/sig material — try the next signature
    }
  }
  return { ok: false, reason: 'signature-verification-failed' };
}

// ─── Networking (injectable) ────────────────────────────────────────────────

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLatestMetadata(fetchImpl, timeoutMs) {
  const res = await fetchWithTimeout(fetchImpl, REGISTRY_LATEST_URL, {}, timeoutMs);
  if (!res || !res.ok) throw new Error(`registry HTTP ${res && res.status}`);
  const body = await res.json();
  if (!body || typeof body.version !== 'string' || !body.version) {
    throw new Error('malformed registry metadata (no version)');
  }
  return body;
}

async function fetchTarball(fetchImpl, url, timeoutMs) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== REGISTRY_HOST) {
    throw new Error(`refusing tarball URL outside ${REGISTRY_HOST}: ${url}`);
  }
  const res = await fetchWithTimeout(fetchImpl, url, {}, timeoutMs);
  if (!res || !res.ok) throw new Error(`tarball fetch HTTP ${res && res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// ─── Logging ────────────────────────────────────────────────────────────────

/** Default logger mirrors scripts/runner.js's own log() line format/target. */
function defaultLog(homeDir) {
  const logPath = path.join(homeDir, '.auxilo', 'extract.log');
  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, `${line}\n`);
    } catch {
      /* best-effort */
    }
  };
}

// ─── Atomic swap ─────────────────────────────────────────────────────────────

/**
 * Build the new stack in `<binRoot>.new` via installer.installRunner, then
 * swap it into place: drop any stale `.prev` from an earlier cycle, rename
 * the current tree to `.prev`, rename `.new` into the real binRoot. On any
 * failure before the final rename, `.new` is removed and binRoot is
 * untouched. This is the ONLY function that ever writes into the real
 * binRoot for an auto-update.
 */
function stageAndSwap(homeDir, extractedPackageDir, installer) {
  const binRoot = installer.binRootFor(homeDir);
  const newRoot = `${binRoot}.new`;
  const prevRoot = `${binRoot}.prev`;

  fs.rmSync(newRoot, { recursive: true, force: true });
  try {
    installer.installRunner(homeDir, { packageRoot: extractedPackageDir, binRootOverride: newRoot });
  } catch (err) {
    fs.rmSync(newRoot, { recursive: true, force: true });
    throw err;
  }

  try {
    fs.rmSync(prevRoot, { recursive: true, force: true }); // drop >1-cycle-old backup
    if (fs.existsSync(binRoot)) {
      fs.renameSync(binRoot, prevRoot);
    }
    fs.renameSync(newRoot, binRoot);
  } catch (err) {
    // Best-effort rollback: put the old tree back if we moved it but the
    // final rename failed.
    if (!fs.existsSync(binRoot) && fs.existsSync(prevRoot)) {
      try { fs.renameSync(prevRoot, binRoot); } catch { /* out of options */ }
    }
    fs.rmSync(newRoot, { recursive: true, force: true });
    throw err;
  }
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * @param {string} homeDir
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl]     default global fetch
 * @param {object}   [opts.installer]     default require('./installer.js')
 * @param {Function} [opts.extractImpl]   default extractTarGz
 * @param {Function} [opts.log]           default file+best-effort logger
 * @param {number}   [opts.now]           default Date.now()
 * @param {object}   [opts.env]           default process.env
 * @param {number}   [opts.metadataTimeoutMs]
 * @param {number}   [opts.tarballTimeoutMs]
 * @param {number}   [opts.intervalMs]    cadence gate, default 24h
 * @param {boolean}  [opts.force]         bypass the cadence stamp (manual/testing)
 * @param {Array}    [opts.pinnedKeys]    default NPM_REGISTRY_SIGNING_KEYS —
 *   test-only override so a suite can exercise the real crypto.verify() path
 *   with a throwaway keypair instead of npm's actual private key (which
 *   nobody but npm holds).
 * @returns {Promise<{status: string, [key: string]: any}>}
 *   status is one of: 'opted-out', 'skipped-recent', 'skipped-in-flight',
 *   'check-failed', 'no-op', 'refused', 'updated'. Never throws.
 */
async function checkAndApplyRunnerUpdate(homeDir, opts = {}) {
  const installer = opts.installer || installerDefault;
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const extractImpl = opts.extractImpl || extractTarGz;
  const log = opts.log || defaultLog(homeDir);
  const now = opts.now !== undefined ? opts.now : Date.now();
  const env = opts.env || process.env;
  const metadataTimeoutMs = opts.metadataTimeoutMs || METADATA_FETCH_TIMEOUT_MS;
  const tarballTimeoutMs = opts.tarballTimeoutMs || TARBALL_FETCH_TIMEOUT_MS;
  const intervalMs = opts.intervalMs || ONE_DAY_MS;
  const pinnedKeys = opts.pinnedKeys || NPM_REGISTRY_SIGNING_KEYS;

  try {
    // ── Opt-out: skip the network check ENTIRELY for this run ────────────
    if (isAutoupdateOptedOut(homeDir, env, installer)) {
      const cfg = installer.readRunnerConfig(homeDir);
      const installed = installer.installedRunnerVersion(homeDir);
      if (cfg.last_known_latest && installed && semverGt(cfg.last_known_latest, installed)) {
        log(`[runner] auxilo-mcp v${cfg.last_known_latest} is available (auto-update is off) — run: npx auxilo setup`);
      }
      return { status: 'opted-out' };
    }

    // ── In-flight guard: never swap under a running extraction ───────────
    if (isExtractionInProgress(homeDir, now)) {
      log('[runner] auto-update check skipped: extraction in progress');
      return { status: 'skipped-in-flight' };
    }

    // ── Cadence: at most once per 24h, tracked in a plain-text stamp ─────
    if (!opts.force && !shouldCheckNow(homeDir, now, intervalMs)) {
      return { status: 'skipped-recent' };
    }

    if (!fetchImpl) {
      writeLastCheckStamp(homeDir, now);
      log('[runner] auto-update check failed: no fetch implementation available, continuing on installed copy');
      return { status: 'check-failed', reason: 'no-fetch-impl' };
    }

    // ── Fetch registry metadata, offline-tolerant ─────────────────────────
    let meta;
    try {
      meta = await fetchLatestMetadata(fetchImpl, metadataTimeoutMs);
    } catch (err) {
      writeLastCheckStamp(homeDir, now);
      const installedNow = installer.installedRunnerVersion(homeDir);
      log(`[runner] auto-update check failed: ${err.message}, continuing on installed v${installedNow || 'unknown'}`);
      return { status: 'check-failed', reason: err.message };
    }

    writeLastCheckStamp(homeDir, now);
    const latest = meta.version;
    installer.writeRunnerConfig(homeDir, { last_known_latest: latest });

    const installed = installer.installedRunnerVersion(homeDir);
    if (installed !== null && !semverGt(latest, installed)) {
      return { status: 'no-op', installed, latest };
    }

    // ── Newer version available — download, verify, install ──────────────
    const dist = meta.dist || {};
    let tarballBuffer;
    try {
      tarballBuffer = await fetchTarball(fetchImpl, dist.tarball, tarballTimeoutMs);
    } catch (err) {
      log(`[runner] auto-update check failed: ${err.message}, continuing on installed v${installed || 'unknown'}`);
      return { status: 'check-failed', reason: err.message };
    }

    const integrityResult = verifyTarballIntegrity(tarballBuffer, dist);
    const signatureResult = integrityResult.ok
      ? verifyRegistrySignature({ name: PACKAGE_NAME, version: latest, integrity: dist.integrity, signatures: dist.signatures }, pinnedKeys)
      : { ok: false, reason: 'skipped (integrity already failed)' };

    if (!integrityResult.ok || !signatureResult.ok) {
      const reason = !integrityResult.ok ? integrityResult.reason : signatureResult.reason;
      installer.writeRunnerConfig(homeDir, {
        last_verification: { result: 'failed', at: new Date(now).toISOString(), reason },
      });
      log(`[runner] auto-update REFUSED for v${latest}: ${reason} — keeping installed v${installed || 'unknown'}`);
      return { status: 'refused', reason };
    }

    installer.writeRunnerConfig(homeDir, {
      last_verification: { result: 'ok', at: new Date(now).toISOString(), reason: null },
    });

    // ── Extract + stage + atomic swap ─────────────────────────────────────
    const tmpBase = opts.tmpBase || os.tmpdir();
    const extractDir = fs.mkdtempSync(path.join(tmpBase, 'auxilo-update-'));
    try {
      extractImpl(tarballBuffer, extractDir);
      stageAndSwap(homeDir, extractDir, installer);
    } catch (err) {
      log(`[runner] auto-update REFUSED for v${latest}: install failed (${err.message}) — keeping installed v${installed || 'unknown'}`);
      return { status: 'refused', reason: err.message };
    } finally {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }

    installer.writeRunnerConfig(homeDir, {
      last_update_applied: { version: latest, at: new Date(now).toISOString() },
    });
    // The running process is still executing the OLD tree's already-loaded
    // modules — see module doc comment "When the new code first runs".
    log(`[runner] updated to v${latest}, effective next session`);
    return { status: 'updated', version: latest };
  } catch (err) {
    // Belt-and-braces: this function must NEVER throw out of the hook path.
    try { log(`[runner] auto-update check crashed: ${err.message}, continuing on installed copy`); } catch { /* best-effort */ }
    return { status: 'check-failed', reason: err.message };
  }
}

// ─── `auxilo status` support (spec §6) ───────────────────────────────────────

/**
 * Pure render for the CLI's status extension — mirrors bin/auxilo-cli.js's
 * runnerSkewLine style. Returns null when there is nothing installed to
 * report against (caller already gates on s.runnerInstalled).
 *
 * @param {object} state
 * @param {number|null} state.lastCheckAt   epoch ms, or null
 * @param {'on'|'off'|'paused-by-env'} state.autoupdateState
 * @param {{result:string, at:string, reason:string|null}|null} state.lastVerification
 */
function runnerAutoupdateStatusLine(state) {
  if (!state) return null;
  // Epoch 0 (1970-01-01) is a legitimate timestamp, not "never" — check for
  // null/undefined explicitly rather than a truthy test.
  const lastCheck = state.lastCheckAt === null || state.lastCheckAt === undefined
    ? 'never'
    : new Date(state.lastCheckAt).toISOString();
  let line = `  Auto-update: ${state.autoupdateState} (last check: ${lastCheck})`;
  if (state.lastVerification && state.lastVerification.result) {
    const v = state.lastVerification;
    line += v.result === 'ok'
      ? `, last verification: ok (${v.at})`
      : `, last verification: FAILED — ${v.reason} (${v.at})`;
  }
  return line;
}

/**
 * Assemble the state runnerAutoupdateStatusLine renders, from disk.
 * @param {string} homeDir
 * @param {object} [opts]
 * @param {object} [opts.installer]
 * @param {object} [opts.env]
 */
function getRunnerAutoupdateStatus(homeDir, opts = {}) {
  const installer = opts.installer || installerDefault;
  const env = opts.env || process.env;
  const cfg = installer.readRunnerConfig(homeDir);
  let autoupdateState = 'on';
  if (isEnvOptedOut(env)) autoupdateState = 'paused-by-env';
  else if (cfg.autoupdate === false) autoupdateState = 'off';
  return {
    lastCheckAt: readLastCheckStamp(homeDir),
    autoupdateState,
    lastVerification: cfg.last_verification || null,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  PACKAGE_NAME,
  REGISTRY_HOST,
  REGISTRY_LATEST_URL,
  ONE_DAY_MS,
  METADATA_FETCH_TIMEOUT_MS,
  TARBALL_FETCH_TIMEOUT_MS,
  STALE_LOCK_MS,
  NPM_REGISTRY_SIGNING_KEYS,
  lastCheckStampPath,
  readLastCheckStamp,
  writeLastCheckStamp,
  shouldCheckNow,
  isEnvOptedOut,
  isConfigOptedOut,
  isAutoupdateOptedOut,
  extractionLockPath,
  isExtractionInProgress,
  markExtractionStart,
  markExtractionEnd,
  parseSri,
  verifyTarballIntegrity,
  verifyRegistrySignature,
  fetchLatestMetadata,
  fetchTarball,
  stageAndSwap,
  checkAndApplyRunnerUpdate,
  runnerAutoupdateStatusLine,
  getRunnerAutoupdateStatus,
};
