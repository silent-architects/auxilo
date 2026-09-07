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
 *      own SRI string — the same check `npm install` performs internally).
 *      `dist.integrity` MUST be `sha512-…`; sha256/sha384/sha1 are refused,
 *      not accepted as a fallback (0.9.16 fix pass, L9 — a pre-2018-publish
 *      sha1 `dist.shasum` fallback existed here and was removed).
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
 * The swap is a set of PER-FILE atomic writes (temp file + `fs.renameSync`
 * for each RUNNER_STACK entry, the hook script, and VERSION) into the REAL
 * `<home>/.auxilo/bin` — NOT a whole-directory rename (0.9.16 fix pass, B1:
 * the old design renamed the entire `<bin>` directory, which silently
 * deleted every file `installRunner` doesn't know about — capture shims,
 * the review-notice shim, sweeper/backup wrappers, jobs/ — on the very
 * first auto-update). See lib/installer.js installRunnerAtomic and this
 * module's stageAndSwap. Each file lands atomically; there is no
 * cross-file transaction, so a crash mid-swap can leave a partially-mixed
 * old/new file set, but `<bin>` itself is never missing. VERSION is always
 * the LAST file written in an install (lib/installer.js installRunnerAtomic),
 * so a crash mid-swap is also detectable after the fact: an old VERSION
 * stamp alongside partially-new stack files, never the reverse.
 *
 * The CURRENT process is GUARANTEED to keep running the OLD code for the
 * rest of this invocation, not merely as a side effect of Node's module
 * cache but as an explicit precondition this module relies on: every stack
 * module that scripts/runner.js or scripts/providers/index.js would
 * otherwise require() LAZILY (on first use, potentially AFTER this check
 * has already swapped the files on disk) is pre-warmed — required once, up
 * front — by scripts/runner.js's main(), immediately before it calls
 * checkAndApplyRunnerUpdate (0.9.16 fix pass 2, MEDIUM-1). Node caches a
 * module by resolved path the first time it is require()'d and never
 * re-reads the file from disk on a later require() of the same path, so
 * pre-warming pins this process to the OLD module identity regardless of
 * what stageAndSwap does next. Without that pre-warm, a lazy first
 * require() occurring after the swap would load the BRAND NEW code inside
 * the still-running OLD process — the exact thing this paragraph promises
 * does not happen. A live process reading files out from under itself
 * mid-run this way is also exactly what the in-flight guard below exists
 * to prevent for OTHER concurrent processes. The new copy takes effect
 * starting with the NEXT session's SessionEnd hook invocation. No re-exec
 * is attempted.
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
const { semverGt, semverParse } = require('./semver-min.js');
const installerDefault = require('./installer.js');

/** L6: a published auxilo-mcp tarball is tens to low hundreds of KB — 5MB is
 * generous headroom against a compromised/MITM'd registry response trying to
 * exhaust memory on an unattended hook path. */
const MAX_TARBALL_BYTES = 5 * 1024 * 1024;

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
//
// B3 fix: PID-SCOPED. The old design wrote ONE shared marker file — any
// runner process's `process.on('exit', ...)` handler unlinked it, so two
// overlapping runners raced each other's cleanup (process A's exit handler
// could delete the marker process B just wrote). It also had to run AFTER
// checkAndApplyRunnerUpdate's own in-flight check (or every run would see
// its own not-yet-written marker as "in progress" and refuse to check at
// all), which left a real window: two overlapping runners could both read
// "no marker" and both pass the gate before either wrote one.
//
// Fixed shape: one marker file PER PID, in a directory. markExtractionStart
// is now called BEFORE checkAndApplyRunnerUpdate (scripts/runner.js), and
// isExtractionInProgress always EXCLUDES the caller's own pid — a runner's
// own just-written marker never blocks its own auto-update check, but any
// OTHER live (or recently-crashed-but-not-yet-stale) runner's marker does.

function extractionLockDir(homeDir) {
  return path.join(homeDir, '.auxilo', 'extraction-in-progress.d');
}

function extractionMarkerPath(homeDir, pid) {
  return path.join(extractionLockDir(homeDir), String(pid));
}

/**
 * True iff SOME OTHER process's marker exists AND is fresh (younger than
 * STALE_LOCK_MS). A stale marker (left by a process that never reached its
 * cleanup, e.g. SIGKILL) is treated as absent — this guard must not wedge
 * auto-update forever over a single crashed run. The caller's own pid
 * (default process.pid) is always excluded — a runner marking its own
 * extraction-in-progress before checking for updates must not see itself
 * as "another runner in flight".
 */
function isExtractionInProgress(homeDir, now = Date.now(), staleMs = STALE_LOCK_MS, opts = {}) {
  const selfPid = String(opts.pid !== undefined ? opts.pid : process.pid);
  let entries;
  try {
    entries = fs.readdirSync(extractionLockDir(homeDir));
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry === selfPid) continue;
    try {
      const stat = fs.statSync(path.join(extractionLockDir(homeDir), entry));
      if (now - stat.mtimeMs < staleMs) return true;
    } catch {
      /* raced deletion between readdir and stat — treat that entry as absent */
    }
  }
  return false;
}

/** Call at the top of runner.js's extraction-work block, BEFORE the
 * auto-update check (B3) — best-effort, PID-scoped. */
function markExtractionStart(homeDir, opts = {}) {
  const pid = opts.pid !== undefined ? opts.pid : process.pid;
  try {
    const p = extractionMarkerPath(homeDir, pid);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${pid}\n${new Date().toISOString()}\n`);
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
 * uncaught exception). PID-scoped: only ever removes THIS process's own
 * marker, never a sibling runner's.
 */
function markExtractionEnd(homeDir, opts = {}) {
  const pid = opts.pid !== undefined ? opts.pid : process.pid;
  try {
    fs.unlinkSync(extractionMarkerPath(homeDir, pid));
  } catch {
    /* best-effort */
  }
}

// ─── Exclusive update lock (B3: O_EXCL PID lock, stale-tolerant) ───────────
//
// Distinct from the extraction-in-progress marker above (which guards the
// SWAP against a concurrently-running EXTRACTION). This lock guards the
// auto-update operation itself — fetch → verify → extract → install —
// against two overlapping invocations of checkAndApplyRunnerUpdate racing
// each other (e.g. two SessionEnd hooks firing close together before either
// extraction marker is visible to the other). `wx` is Node's O_EXCL open
// flag: it fails with EEXIST if the file already exists, giving a real
// exclusive-create instead of a check-then-write race.

function updateLockPath(homeDir) {
  return path.join(homeDir, '.auxilo', 'runner-update.lock');
}

/** @returns {{ok: boolean, reason?: string}} */
function acquireUpdateLock(homeDir, now = Date.now(), staleMs = STALE_LOCK_MS) {
  const p = updateLockPath(homeDir);
  const tryCreate = () => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const fd = fs.openSync(p, 'wx'); // O_EXCL — throws EEXIST if present
    try {
      fs.writeSync(fd, `${process.pid}\n${new Date(now).toISOString()}\n`);
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    tryCreate();
    return { ok: true };
  } catch (err) {
    if (err.code !== 'EEXIST') return { ok: false, reason: err.message };
    // Stale-tolerant: a lock left by a process that died without releasing
    // it (SIGKILL) must not wedge auto-update forever.
    try {
      const stat = fs.statSync(p);
      if (now - stat.mtimeMs >= staleMs) {
        // LOW-3 fix: claim the stale lock via an atomic rename, never a
        // bare rmSync. Two processes that both observe the SAME stale lock
        // can both reach this branch at once; a bare `fs.rmSync(p)` from
        // each would let whichever one runs SECOND delete whatever the
        // FIRST just created — including a legitimately fresh lock the
        // first process already wrote via its own tryCreate() below — so
        // both processes could end up believing they hold the lock
        // exclusively. `fs.renameSync(p, <claim path>)` only succeeds for
        // whichever process's rename executes while `p` still names the
        // STALE file (POSIX rename requires the source to exist), so only
        // ONE concurrent renamer can ever win; the other's rename throws
        // (ENOENT — the winner already moved it away) and that loser falls
        // through to reporting 'locked' rather than touching anything.
        const claimPath = `${p}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        try {
          fs.renameSync(p, claimPath);
        } catch {
          return { ok: false, reason: 'locked' };
        }
        // This process exclusively owns the stale lock now — discard the
        // claimed file and create the real, fresh lock via the same
        // O_EXCL path as any ordinary first-time acquire.
        try { fs.rmSync(claimPath, { force: true }); } catch { /* best-effort */ }
        try {
          tryCreate();
          return { ok: true };
        } catch (err2) {
          return { ok: false, reason: err2.message };
        }
      }
    } catch {
      /* raced stat (lock released between our EEXIST and this check) —
       * fall through and report locked; the next scheduled check retries. */
    }
    return { ok: false, reason: 'locked' };
  }
}

function releaseUpdateLock(homeDir) {
  try {
    fs.unlinkSync(updateLockPath(homeDir));
  } catch {
    /* best-effort */
  }
}

// ─── Integrity + signature verification (spec §3/§4) ────────────────────────

/**
 * `dist.integrity` must be `sha512-<base64>` — L9 fix: sha256/sha384 are no
 * longer accepted (npm's own registry always publishes sha512 for a package
 * this recent; accepting weaker algorithms only widens the attack surface
 * with no legitimate use). Returns the raw base64 digest, or null if
 * malformed or a non-sha512 algorithm.
 */
function parseSri(integrity) {
  const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(String(integrity || ''));
  return m ? { algo: 'sha512', digestB64: m[1] } : null;
}

/**
 * L9 fix: the sha1 `dist.shasum` fallback is DELETED — sha512 SRI is
 * required unconditionally, refused otherwise. No pre-2018-publish
 * tolerance; this package never shipped without a sha512 integrity field.
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifyTarballIntegrity(buffer, dist) {
  const sri = parseSri(dist && dist.integrity);
  if (!sri) return { ok: false, reason: 'missing-or-non-sha512-integrity' };
  const actual = crypto.createHash('sha512').update(buffer).digest();
  const expected = Buffer.from(sri.digestB64, 'base64');
  const ok = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  return ok ? { ok: true } : { ok: false, reason: 'integrity-mismatch (sha512)' };
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

/**
 * L6 fix: `redirect: 'error'` is forced unconditionally (never overridable
 * via `init`) on every fetch this module makes — a registry response that
 * tries to redirect to a different host must fail outright rather than be
 * silently followed, since REGISTRY_HOST pinning on the tarball URL (below)
 * would otherwise be bypassable by a same-origin response that 302s
 * elsewhere.
 */
async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
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

/**
 * L6 fix: unbounded buffering removed. The response's declared
 * content-length is checked first (cheap early refusal when present and
 * lying-small isn't a concern — a body LARGER than declared still hits the
 * streamed cap below), and the body is read as a stream with a hard byte
 * cap enforced DURING the read (never trusting content-length alone, since
 * it can be absent or wrong) — a malicious/compromised response can never
 * force this process to buffer more than MAX_TARBALL_BYTES.
 */
async function fetchTarball(fetchImpl, url, timeoutMs) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== REGISTRY_HOST) {
    throw new Error(`refusing tarball URL outside ${REGISTRY_HOST}: ${url}`);
  }
  const res = await fetchWithTimeout(fetchImpl, url, {}, timeoutMs);
  if (!res || !res.ok) throw new Error(`tarball fetch HTTP ${res && res.status}`);

  const declared = res.headers && typeof res.headers.get === 'function'
    ? Number(res.headers.get('content-length'))
    : NaN;
  if (Number.isFinite(declared) && declared > MAX_TARBALL_BYTES) {
    throw new Error(`tarball exceeds size cap (declared ${declared} > ${MAX_TARBALL_BYTES} bytes)`);
  }

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TARBALL_BYTES) {
        try { await reader.cancel(); } catch { /* best-effort */ }
        throw new Error(`tarball exceeds size cap while streaming (> ${MAX_TARBALL_BYTES} bytes)`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  // Fallback for test doubles / environments without a real streamable
  // body — still capped, just after the full read rather than during it.
  const ab = await res.arrayBuffer();
  if (ab.byteLength > MAX_TARBALL_BYTES) {
    throw new Error(`tarball exceeds size cap (${ab.byteLength} > ${MAX_TARBALL_BYTES} bytes)`);
  }
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
 * B1 + B2 fix.
 *
 * B1 (was: whole-directory rename deleted every non-stack sibling in
 * `<bin>`): this function no longer stages a scratch `<binRoot>.new` tree
 * and `fs.renameSync`s the whole directory into place. `installRunner` only
 * ever writes RUNNER_STACK + the hook script + VERSION — but `<bin>` also
 * holds the per-client capture shims (installer.js captureShimPath), the
 * review-notice shim (noticeShimPath), the sweeper/backup wrappers, and
 * jobs/, all referenced by ABSOLUTE PATH from client settings/launchd. A
 * directory-rename swap silently deleted every one of those on the first
 * auto-update. Fixed: `installer.js`'s `installRunnerAtomic` (see there for
 * the atomic-per-file mechanism) writes straight into the REAL `<bin>`,
 * touching only the files it knows about.
 *
 * B2 (was: this running copy's OWN RUNNER_STACK — enumerated at require
 * time from the CURRENTLY installed package — could only ever install the
 * OLD version's file list, so a newer version that adds a file was never
 * copied and the installed runner MODULE_NOT_FOUNDs on its first use):
 * fixed by requiring the EXTRACTED tree's OWN `lib/installer.js` and
 * calling THAT tree's `installRunnerAtomic` — its RUNNER_STACK reflects
 * whatever the new version actually ships. This introduces no new trust:
 * by the time stageAndSwap runs, `extractedPackageDir` has already passed
 * SRI + registry-signature verification in checkAndApplyRunnerUpdate.
 *
 * @param {string} homeDir
 * @param {string} extractedPackageDir  Already SRI+signature-verified.
 * @param {object} installer  Injected installer (readRunnerConfig/etc only —
 *   the actual file copy always uses the EXTRACTED tree's own installer,
 *   per B2, never this one).
 * @returns {string} binRoot
 */
function stageAndSwap(homeDir, extractedPackageDir, installer) {
  const binRoot = installer.binRootFor(homeDir);
  const extractedInstallerPath = path.join(extractedPackageDir, 'lib', 'installer.js');
  if (!fs.existsSync(extractedInstallerPath)) {
    throw new Error(`extracted tree has no lib/installer.js at ${extractedInstallerPath} — refusing update`);
  }
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const extractedInstaller = require(extractedInstallerPath);
  if (typeof extractedInstaller.installRunnerAtomic !== 'function') {
    throw new Error('extracted tree\'s installer.js has no installRunnerAtomic — refusing update (incompatible installer)');
  }
  const result = extractedInstaller.installRunnerAtomic(homeDir, { packageRoot: extractedPackageDir });

  // LOW-4: containment. The extracted tree's installer.js is already
  // SRI+signature-verified by the time this runs, but a signed release can
  // still ship a BUG — and a test fixture can deliberately be hostile —
  // whose installRunnerAtomic reports having written somewhere OUTSIDE
  // `<home>/.auxilo/bin`. Verify every path it claims to have touched
  // (binRoot itself, hookPath, versionPath, and each entry of `installed`)
  // resolves, via realpath (so a symlink can't launder the check), under
  // binRootFor(homeDir) — abort the whole update otherwise. This cannot
  // undo writes installRunnerAtomic already made; it exists to stop
  // TRUSTING the result and surface a loud, specific failure (which the
  // caller records as a refused update, never a silently-accepted one)
  // rather than treating an escaped write as a normal success.
  const expectedRoot = fs.realpathSync(binRoot);
  const claimedPaths = [result.binRoot, result.hookPath, result.versionPath, ...(result.installed || [])];
  for (const claimed of claimedPaths) {
    if (!claimed) continue;
    let real;
    try {
      real = fs.realpathSync(claimed);
    } catch {
      // Path doesn't exist to realpath (e.g. never actually written) —
      // fall back to a resolved-but-unverified path for the containment
      // check rather than skipping it.
      real = path.resolve(claimed);
    }
    const rel = path.relative(expectedRoot, real);
    if (rel === '') continue; // claimed === binRoot itself
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`install-path-escape: ${claimed} resolves outside ${expectedRoot}`);
    }
  }

  return binRoot;
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
 *   'skipped-locked', 'check-failed', 'no-op', 'refused', 'updated'. Never
 *   throws.
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

  let lockHeld = false;
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
    // B3: this checks for OTHER processes' markers only (the caller's own
    // pid is excluded) — see the doc comment on isExtractionInProgress.
    if (isExtractionInProgress(homeDir, now)) {
      log('[runner] auto-update check skipped: extraction in progress');
      return { status: 'skipped-in-flight' };
    }

    // ── Cadence: at most once per 24h, tracked in a plain-text stamp ─────
    if (!opts.force && !shouldCheckNow(homeDir, now, intervalMs)) {
      return { status: 'skipped-recent' };
    }

    // ── B3: exclusive O_EXCL PID lock around the whole risky section ─────
    // (fetch → verify → extract → install). Guards against two overlapping
    // checkAndApplyRunnerUpdate calls racing each other before either one's
    // extraction-in-progress marker would catch it.
    const lock = acquireUpdateLock(homeDir, now);
    if (!lock.ok) {
      log(`[runner] auto-update check skipped: another update holds the lock (${lock.reason})`);
      return { status: 'skipped-locked' };
    }
    lockHeld = true;

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

    // ── L7: the fetched version string must be a STRICT semver before it
    // is persisted or logged anywhere — never trust an unparsed registry
    // string into a config file or a log line (both are read/rendered
    // later, e.g. by `auxilo status`, which would otherwise echo whatever
    // the registry sent — including control characters or ANSI escapes —
    // straight to a terminal). ─────────────────────────────────────────
    const latestRaw = meta.version;
    if (!semverParse(latestRaw)) {
      log('[runner] auto-update check failed: registry returned a malformed version string, refusing');
      return { status: 'check-failed', reason: 'malformed-version' };
    }
    const latest = latestRaw;
    installer.writeRunnerConfig(homeDir, { last_known_latest: latest });

    // ── LOW-2: a corrupted/non-semver VERSION stamp must not silently
    // wedge auto-update forever. semverGt(latest, installed) is false
    // whenever EITHER side fails to parse (lib/semver-min.js), so a garbled
    // stamp would otherwise fall straight into the "no-op" branch below —
    // permanently, since nothing ever repairs the stamp on its own. Treat
    // an unparsable non-null stamp exactly like "unknown" (null) and route
    // it through the same M4/LOW-1 catch-up-or-refuse logic just below,
    // with one log line noting the corruption. ─────────────────────────
    let installed = installer.installedRunnerVersion(homeDir);
    if (installed !== null && !semverParse(installed)) {
      log(`[runner] installed runner VERSION stamp is corrupted/non-semver (${JSON.stringify(installed)}), treating as unknown`);
      installed = null;
    }

    // ── M4: an unknown installed version (no VERSION stamp — pre-0.9.12,
    // a prior update that never wrote one, or LOW-2's corrupted-stamp
    // case above) must NOT fall through to installing whatever the
    // registry named. Refuse unless the fetched version is newer than the
    // RUNNING package's own version — i.e. we only trust an
    // unknown-installed state enough to catch up to ourselves, never to
    // blindly install an arbitrary registry answer. ──────────────────────
    if (installed === null) {
      // LOW-1: on a REAL install, PACKAGE_ROOT resolves to this module's
      // own on-disk location (<home>/.auxilo/bin) — but package.json is
      // deliberately NOT part of RUNNER_STACK (it isn't code), so
      // `<bin>/package.json` never exists and packageVersion() throws
      // ENOENT here on every real install that reaches this branch. Refuse
      // with a clear, specific reason instead of letting a raw fs error
      // surface as a confusing 'check-failed'.
      let ownVersion;
      try {
        ownVersion = installer.packageVersion();
      } catch (err) {
        log(`[runner] auto-update REFUSED: installed runner version is unknown and the running package's own version could not be read (${err.message})`);
        return { status: 'refused', reason: 'installed-version-unknown' };
      }
      if (!semverGt(latest, ownVersion)) {
        log(`[runner] auto-update REFUSED: installed runner version is unknown and fetched v${latest} is not newer than the running package v${ownVersion}`);
        return { status: 'refused', reason: 'unknown-installed-version' };
      }
    } else if (!semverGt(latest, installed)) {
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
      // L8: an install failure must reach `auxilo status`, not just the
      // log file — record it so runnerAutoupdateStatusLine can render it.
      installer.writeRunnerConfig(homeDir, {
        last_update_error: { reason: err.message, at: new Date(now).toISOString() },
      });
      log(`[runner] auto-update REFUSED for v${latest}: install failed (${err.message}) — keeping installed v${installed || 'unknown'}`);
      return { status: 'refused', reason: err.message };
    } finally {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }

    installer.writeRunnerConfig(homeDir, {
      last_update_applied: { version: latest, at: new Date(now).toISOString() },
      last_update_error: null,
    });
    // The running process is still executing the OLD tree's already-loaded
    // modules — see module doc comment "When the new code first runs".
    log(`[runner] updated to v${latest}, effective next session`);
    return { status: 'updated', version: latest };
  } catch (err) {
    // Belt-and-braces: this function must NEVER throw out of the hook path.
    try { log(`[runner] auto-update check crashed: ${err.message}, continuing on installed copy`); } catch { /* best-effort */ }
    return { status: 'check-failed', reason: err.message };
  } finally {
    if (lockHeld) releaseUpdateLock(homeDir);
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
 * @param {{reason:string, at:string}|null} [state.lastUpdateError]  L8: an
 *   extract/install failure that was refused — surfaced here so it reaches
 *   `auxilo status`, not just the extract.log file.
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
  if (state.lastUpdateError && state.lastUpdateError.reason) {
    line += `, last update error: ${state.lastUpdateError.reason} (${state.lastUpdateError.at})`;
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
    lastUpdateError: cfg.last_update_error || null,
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
  MAX_TARBALL_BYTES,
  NPM_REGISTRY_SIGNING_KEYS,
  lastCheckStampPath,
  readLastCheckStamp,
  writeLastCheckStamp,
  shouldCheckNow,
  isEnvOptedOut,
  isConfigOptedOut,
  isAutoupdateOptedOut,
  extractionLockDir,
  extractionMarkerPath,
  isExtractionInProgress,
  markExtractionStart,
  markExtractionEnd,
  updateLockPath,
  acquireUpdateLock,
  releaseUpdateLock,
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
