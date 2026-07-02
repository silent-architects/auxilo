#!/usr/bin/env node

/**
 * scripts/runner.js — Client-side Extraction Runner (P2.1a §7)
 *
 * Transport layer for the autonomous extraction pipeline:
 *   1. Check kill-switch sentinel + recursion guard (A5.2)
 *   2. Enumerate active sources via TranscriptSource interface (A5.1)
 *   3. For each new session: readSession() → client-side scrub → write queue file → POST /extract
 *   4. On success: update ledger, delete queue file. On failure: leave queue file.
 *
 * Usage:
 *   node scripts/runner.js                      # sweep all sources
 *   node scripts/runner.js --source claude-code  # specific source
 *   node scripts/runner.js --dry-run            # scrub only, no upload
 *   node scripts/runner.js --session <id>       # process specific session
 *   node scripts/runner.js --transcript <path>  # single-file mode (hook-fired)
 *   node scripts/runner.js --install-hooks      # install SessionEnd hook
 *   node scripts/runner.js --install-sweeper    # install launchd sweeper to ~/.auxilo/bin (P1-13)
 *   node scripts/runner.js --install-digest     # install launchd daily-digest to ~/.auxilo/bin (P1-13)
 *   node scripts/runner.js --status             # print status (B14)
 *   node scripts/runner.js --flush-pending      # retry queue files
 *   node scripts/runner.js --force              # ignore ledger high-water
 *
 * Environment:
 *   AUXILO_API_KEY      — API key for authenticated /extract calls (REQUIRED unless --dry-run)
 *   AUXILO_BASE_URL     — Server URL (default: http://localhost:49152)
 *   AUXILO_EXTRACTING   — Recursion guard (A5.2); set to "1" by this runner
 *
 * @module runner
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { scanText, SENSITIVITY_FILTER_VERSION } = require('../lib/sensitivity-filter.js');
const { ClaudeCodeSource } = require('./sources/claude-code.js');
const { OpenClawSource } = require('./sources/openclaw.js');
const { GeminiCliSource } = require('./sources/gemini-cli.js');
const { AntigravitySource } = require('./sources/antigravity.js');
const { GenericJsonlSource } = require('./sources/generic-jsonl.js');

// ─── Constants ──────────────────────────────────────────────────────────────

const AUXILO_DIR = path.join(os.homedir(), '.auxilo');
const CREDS_PATH = path.join(AUXILO_DIR, 'credentials.json');

/**
 * Credentials resolution order (P1-8 fast-follow):
 *   1. AUXILO_API_KEY env var (highest priority — for CI, launchd, hooks)
 *   2. ~/.auxilo/credentials.json { api_key, base_url }
 *   3. fallback to local dev URL
 *
 * Base URL resolution:
 *   1. AUXILO_BASE_URL env var
 *   2. credentials.json .base_url
 *   3. http://localhost:49152 (dev default)
 */
function loadCredentials() {
  let fileCreds = {};
  try {
    if (fs.existsSync(CREDS_PATH)) {
      fileCreds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf-8'));
    }
  } catch { /* malformed file — treat as absent */ }
  return {
    apiKey: process.env.AUXILO_API_KEY || fileCreds.api_key || null,
    baseUrl: process.env.AUXILO_BASE_URL || fileCreds.base_url || 'http://localhost:49152',
    accountLabel: fileCreds.label || fileCreds.account_id || null,
  };
}

const { apiKey: API_KEY, baseUrl: BASE_URL, accountLabel: ACCOUNT_LABEL } = loadCredentials();

// Parsing contract with jobs/daily-digest.js readLogRows(): digest-relevant log
// lines must carry `account=` (builder attribution) and, on publish lines,
// `published=` / `rejected=` count tokens.
const DIGEST_ACCOUNT = `account=${ACCOUNT_LABEL || 'unknown'}`;
const MIN_CHARS = 1500;
const MAX_CHARS = 30000;

const KILL_SWITCH_PATH = path.join(AUXILO_DIR, 'autonomous-enabled');
const PENDING_DIR = path.join(AUXILO_DIR, 'pending-learnings');
const LEDGER_PATH = path.join(AUXILO_DIR, 'ledger.json');
const LOG_PATH = path.join(AUXILO_DIR, 'extract.log');

// ─── Source Registry (§4.4) ─────────────────────────────────────────────────

const SOURCES = [
  ClaudeCodeSource,
  OpenClawSource,
  GeminiCliSource,
  AntigravitySource,
];

async function enumerateActiveSources(filter) {
  const active = [];
  for (const S of SOURCES) {
    const instance = new S();
    if (filter && instance.type !== filter) continue;
    if (await instance.detect()) active.push(instance);
  }
  return active;
}

// ─── CLI Parsing ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    source: null, dryRun: false, session: null,
    installHooks: false, installSweeper: false, installDigest: false, status: false,
    transcript: null, flushPending: false,
    force: false, verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--install-hooks') args.installHooks = true;
    else if (argv[i] === '--install-sweeper') args.installSweeper = true;
    else if (argv[i] === '--install-digest') args.installDigest = true;
    else if (argv[i] === '--status') args.status = true;
    else if (argv[i] === '--flush-pending') args.flushPending = true;
    else if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--verbose') args.verbose = true;
    else if (argv[i] === '--source' && argv[i + 1]) { args.source = argv[++i]; }
    else if (argv[i] === '--session' && argv[i + 1]) { args.session = argv[++i]; }
    else if (argv[i] === '--transcript' && argv[i + 1]) { args.transcript = argv[++i]; }
  }
  return args;
}

// ─── Logging ────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch { /* best-effort */ }
}

// ─── Ledger ─────────────────────────────────────────────────────────────────

function loadLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf-8'));
  } catch {
    return { sources: {}, lastSweep: null };
  }
}

function saveLedger(ledger) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  const tmp = LEDGER_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf-8');
  fs.renameSync(tmp, LEDGER_PATH);
}

function ledgerHighWater(ledger, sourceId) {
  return ledger.sources[sourceId]?.highWater || null;
}

function ledgerHas(ledger, sourceId, sessionId, sha) {
  const key = `${sourceId}:${sessionId}:${sha}`;
  return ledger.sources[sourceId]?.sessions?.[key] === true;
}

function ledgerMark(ledger, sourceId, sessionId, sha, mtime) {
  if (!ledger.sources[sourceId]) {
    ledger.sources[sourceId] = { highWater: null, sessions: {} };
  }
  const key = `${sourceId}:${sessionId}:${sha}`;
  ledger.sources[sourceId].sessions[key] = true;
  // Update high-water mark
  if (!ledger.sources[sourceId].highWater || mtime > ledger.sources[sourceId].highWater) {
    ledger.sources[sourceId].highWater = mtime;
  }
  ledger.lastSweep = new Date().toISOString();
}

// ─── Durable Queue (A5.3 / B6) ─────────────────────────────────────────────

let queueCounter = Date.now();

/**
 * Write a queue file BEFORE POSTing to /extract.
 * B6: Uses O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW with mode 0o600 to prevent
 * symlink attacks on the pending-learnings directory.
 *
 * @param {object} payload - The data to queue
 * @returns {string} Absolute path to the queue file
 */
function writeQueueFile(payload) {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  const slug = (payload.sessionId || 'unknown').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
  const filename = `${++queueCounter}-${slug}.json`;
  const filePath = path.join(PENDING_DIR, filename);

  // B6: O_EXCL blocks pre-planted symlinks; O_NOFOLLOW blocks symlink-following
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
  // O_NOFOLLOW may not be available on all platforms; use it where supported
  const flagsWithNoFollow = typeof fs.constants.O_NOFOLLOW === 'number'
    ? flags | fs.constants.O_NOFOLLOW
    : flags;

  const fd = fs.openSync(filePath, flagsWithNoFollow, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(payload, null, 2));
  } finally {
    fs.closeSync(fd);
  }

  return filePath;
}

function deleteQueueFile(filePath) {
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}

function listPendingFiles() {
  try {
    return fs.readdirSync(PENDING_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => path.join(PENDING_DIR, f))
      .sort();
  } catch {
    return [];
  }
}

// ─── Upload ─────────────────────────────────────────────────────────────────

async function postExtract(transcript, sessionId, sourceType, _scrubReport) {
  // CLIENT-SIDE extraction (2026-07-02). Server /extract is deprecated (410) — Auxilo
  // does not pay to extract. The local model (via `claude -p`) extracts + self-screens
  // the already-client-scrubbed transcript, and we submit finished learnings to /learn.
  const { extractLocally } = require('./extract-local.js');
  let learnings;
  let skipped;
  try {
    ({ learnings, skipped } = await extractLocally(transcript, sourceType));
  } catch (err) {
    throw new Error(`Local extraction failed: ${err.message}`);
  }
  if (skipped) {
    log(`[runner] ${skipped}`);
    return { learnings_published: 0, learnings_rejected: 0, extraction_id: 'client-skip' };
  }

  let published = 0;
  let rejected = 0;
  for (const l of learnings) {
    try {
      const res = await fetch(`${BASE_URL}/learn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': API_KEY,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          title: l.title,
          body: l.body,
          category: l.category,
          tags: l.tags,
          task_context: l.task_context,
          outcome: l.outcome,
          contributor_agent: `auxilo-hook/${sourceType}`,
        }),
      });
      if (res.ok) published += 1;
      else rejected += 1;
    } catch (_) {
      rejected += 1;
    }
  }
  log(`[runner] client-side extraction: ${learnings.length} candidate(s), published=${published} rejected=${rejected}`);
  return { learnings_published: published, learnings_rejected: rejected, extraction_id: `client-${sessionId}` };
}

// ─── Install Hooks (B15) ────────────────────────────────────────────────────

function installHooks() {
  const hookSrc = path.join(__dirname, 'hooks', 'auxilo-extract.sh');
  const claudeHooksDir = path.join(os.homedir(), '.claude', 'hooks');
  const hookDest = path.join(claudeHooksDir, 'auxilo-extract.sh');
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const hookCmd = hookDest;

  // 1. Copy hook script
  if (!fs.existsSync(hookSrc)) {
    console.error(`[install-hooks] Hook template not found: ${hookSrc}`);
    process.exit(1);
  }
  fs.mkdirSync(claudeHooksDir, { recursive: true });

  // B15: Backup existing hook file before overwrite
  if (fs.existsSync(hookDest)) {
    const backupPath = `${hookDest}.bak.${Date.now()}`;
    fs.copyFileSync(hookDest, backupPath);
    log(`[install-hooks] Backed up existing hook to ${backupPath}`);
  }

  fs.copyFileSync(hookSrc, hookDest);
  fs.chmodSync(hookDest, 0o755);
  log(`[install-hooks] ✓ Copied hook to ${hookDest}`);

  // 2. Patch settings.json SessionEnd array
  // B15: Fail loudly on malformed settings.json — do NOT catch-and-overwrite
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    try {
      settings = JSON.parse(raw);
    } catch (parseErr) {
      // B15: Malformed JSON — FAIL LOUDLY. Do NOT overwrite with fresh object.
      throw new Error(
        `[install-hooks] FATAL: ${settingsPath} contains malformed JSON. ` +
        `Refusing to overwrite — fix the file manually or restore from backup. ` +
        `Parse error: ${parseErr.message}`
      );
    }
  }

  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.SessionEnd)) settings.hooks.SessionEnd = [];

  if (!settings.hooks.SessionEnd.includes(hookCmd)) {
    settings.hooks.SessionEnd.push(hookCmd);
    log(`[install-hooks] ✓ Added ${hookCmd} to SessionEnd hooks`);
  } else {
    log(`[install-hooks] ✓ Hook already in SessionEnd array (no-op)`);
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  log(`[install-hooks] ✓ Updated ${settingsPath}`);

  // 3. Verify
  const exists = fs.existsSync(hookDest);
  const isExec = (fs.statSync(hookDest).mode & 0o111) !== 0;
  log(`[install-hooks] Verification: hook exists=${exists}, executable=${isExec}`);

  if (!exists || !isExec) {
    console.error('[install-hooks] ✗ Verification failed');
    process.exit(1);
  }
  log('[install-hooks] Done. Hook will fire on SessionEnd.');
}

// ─── Install Sweeper (P1-13) ────────────────────────────────────────────────
//
// macOS TCC blocks launchd from executing anything under ~/Documents
// ("Operation not permitted" in sweeper.err.log). Fix: copy the entire
// executable surface (wrapper + runner + sources + sensitivity filter) into
// ~/.auxilo/bin/ at install time — copied, NOT symlinked (a symlink back into
// ~/Documents would still be TCC-blocked) — and point the LaunchAgent plist
// at the installed copy. Re-run after changing any of these files.

const SWEEPER_LABEL = 'tech.conway.auxilo-sweeper';

function installSweeper() {
  const repoRoot = path.resolve(__dirname, '..');
  const binRoot = path.join(AUXILO_DIR, 'bin');

  // 1. Copy executable surface, preserving relative layout so requires resolve.
  const filesToCopy = [
    ['scripts/auxilo-sweeper-wrapper.sh', 'auxilo-sweeper-wrapper.sh', 0o755],
    ['scripts/runner.js', 'scripts/runner.js', 0o755],
    ['scripts/sources/source.interface.js', 'scripts/sources/source.interface.js', 0o644],
    ['scripts/sources/claude-code.js', 'scripts/sources/claude-code.js', 0o644],
    ['scripts/sources/openclaw.js', 'scripts/sources/openclaw.js', 0o644],
    ['lib/sensitivity-filter.js', 'lib/sensitivity-filter.js', 0o644],
  ];
  for (const [src, dest, mode] of filesToCopy) {
    const srcPath = path.join(repoRoot, src);
    const destPath = path.join(binRoot, dest);
    if (!fs.existsSync(srcPath)) {
      console.error(`[install-sweeper] ✗ Missing source file: ${srcPath}`);
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
    fs.chmodSync(destPath, mode);
    log(`[install-sweeper] ✓ Installed ${dest}`);
  }

  // 2. Write the LaunchAgent plist pointing at the installed wrapper.
  //    WorkingDirectory must also live outside ~/Documents (TCC getcwd errors).
  const wrapperPath = path.join(binRoot, 'auxilo-sweeper-wrapper.sh');
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${SWEEPER_LABEL}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SWEEPER_LABEL}</string>

    <!-- P1-13: executable surface lives in ~/.auxilo/bin — NEVER under ~/Documents (TCC). -->
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${wrapperPath}</string>
    </array>

    <!-- Run daily at 03:15 local time. -->
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>3</integer>
        <key>Minute</key>
        <integer>15</integer>
    </dict>

    <key>RunAtLoad</key>
    <false/>

    <key>StandardOutPath</key>
    <string>${path.join(AUXILO_DIR, 'sweeper.out.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(AUXILO_DIR, 'sweeper.err.log')}</string>

    <!-- P1-13: do NOT set AUXILO_EXTRACTING here — it trips the runner's own
         recursion guard and silently no-ops every sweep. The runner sets it
         itself for child processes. -->

    <key>WorkingDirectory</key>
    <string>${AUXILO_DIR}</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist);
  log(`[install-sweeper] ✓ Wrote ${plistPath}`);

  log('[install-sweeper] Done. Reload the agent:');
  log(`[install-sweeper]   launchctl bootout gui/$(id -u)/${SWEEPER_LABEL} 2>/dev/null; launchctl bootstrap gui/$(id -u) ${plistPath}`);
}

// ─── Install Daily Digest (P1-13 follow-up) ─────────────────────────────────
//
// Same TCC root cause as the sweeper: the original tech.conway.auxilo-digest
// plist ran node against jobs/daily-digest.js under ~/Documents, which launchd
// cannot read ("Unknown system error -11" in daily-digest.stderr.log). The
// digest is a purely local job — it summarizes ~/.auxilo/extract.log — so the
// fix is the same: copy it to ~/.auxilo/bin/ and point the plist there.
// daily-digest.js is self-contained (fs/path/os only), so it is the only file
// to copy. Re-run after changing it.

const DIGEST_LABEL = 'tech.conway.auxilo-digest';

function installDigest() {
  const repoRoot = path.resolve(__dirname, '..');
  const binRoot = path.join(AUXILO_DIR, 'bin');

  // 1. Copy the job script (self-contained — no repo-local requires).
  const srcPath = path.join(repoRoot, 'jobs', 'daily-digest.js');
  const destPath = path.join(binRoot, 'jobs', 'daily-digest.js');
  if (!fs.existsSync(srcPath)) {
    console.error(`[install-digest] ✗ Missing source file: ${srcPath}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  fs.chmodSync(destPath, 0o755);
  log(`[install-digest] ✓ Installed jobs/daily-digest.js`);

  // 2. Write the LaunchAgent plist pointing at the installed copy.
  //    Schedule and log paths preserved from the original plist (07:00 daily,
  //    ~/.auxilo/logs/). WorkingDirectory must live outside ~/Documents (TCC).
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${DIGEST_LABEL}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${DIGEST_LABEL}</string>

    <!-- P1-13: executable surface lives in ~/.auxilo/bin — NEVER under ~/Documents (TCC). -->
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>${destPath}</string>
    </array>

    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>7</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>

    <key>RunAtLoad</key>
    <false/>

    <key>StandardOutPath</key>
    <string>${path.join(AUXILO_DIR, 'logs', 'daily-digest.stdout.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(AUXILO_DIR, 'logs', 'daily-digest.stderr.log')}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>WorkingDirectory</key>
    <string>${AUXILO_DIR}</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist);
  log(`[install-digest] ✓ Wrote ${plistPath}`);

  log('[install-digest] Done. Reload the agent:');
  log(`[install-digest]   launchctl bootout gui/$(id -u)/${DIGEST_LABEL} 2>/dev/null; launchctl bootstrap gui/$(id -u) ${plistPath}`);
}

// ─── Status (B14) ───────────────────────────────────────────────────────────

async function printStatus() {
  const ledger = loadLedger();

  // 1. Kill-switch sentinel
  const sentinelPresent = fs.existsSync(KILL_SWITCH_PATH);
  console.log(`Kill-switch sentinel: ${sentinelPresent ? 'present' : 'MISSING'} (${KILL_SWITCH_PATH})`);

  // 2. AUXILO_EXTRACTING env var
  console.log(`AUXILO_EXTRACTING: ${process.env.AUXILO_EXTRACTING || 'unset'}`);

  // 3. Account mode (best-effort — may fail if server not running)
  let accountMode = 'unknown (server unreachable)';
  if (API_KEY) {
    try {
      const res = await fetch(`${BASE_URL}/account/settings`, {
        headers: { 'X-API-Key': API_KEY },
      });
      if (res.ok) {
        const data = await res.json();
        accountMode = data.autonomous_extraction_mode || 'off';
      }
    } catch { /* server not running */ }
  } else {
    accountMode = 'unknown (AUXILO_API_KEY not set)';
  }
  console.log(`Account mode: ${accountMode}`);

  // 4. Hook install state
  const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let hookInstalled = false;
  try {
    const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
    hookInstalled = Array.isArray(settings.hooks?.SessionEnd) &&
      settings.hooks.SessionEnd.some(h => h.includes('auxilo-extract'));
  } catch { /* no settings file */ }
  console.log(`Hook installed: ${hookInstalled ? 'yes' : 'no'}`);

  // 5. Last sweep ran at
  console.log(`Last sweep: ${ledger.lastSweep || 'never'}`);

  // 6. Pending queue size
  const pendingCount = listPendingFiles().length;
  console.log(`Pending queue: ${pendingCount} file(s)`);
}

// ─── Scrub + Verify ─────────────────────────────────────────────────────────

function scrubAndVerify(transcript) {
  const first = scanText(transcript);
  let cleaned = transcript;
  let report = {
    scrubber_version: SENSITIVITY_FILTER_VERSION,
    patterns_matched: [],
    clean: first.clean,
  };

  if (!first.clean) {
    // Redact and re-scan (fail-closed per §7.5)
    cleaned = first.redacted;
    report.patterns_matched = first.matches.map(m => m.pattern);

    const second = scanText(cleaned);
    if (!second.clean) {
      // Second pass still finds patterns — refuse to upload
      return { cleaned: null, report, refused: true };
    }
  }

  return { cleaned, report, refused: false };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  // B14: --status subcommand
  if (args.status) return printStatus();

  // --install-hooks subcommand
  if (args.installHooks) return installHooks();

  // --install-sweeper subcommand (P1-13)
  if (args.installSweeper) return installSweeper();

  // --install-digest subcommand (P1-13 follow-up)
  if (args.installDigest) return installDigest();

  // ── A5.2: Kill-switch sentinel check ──────────────────────────────────
  // MUST be the first check before any extraction work.
  if (!fs.existsSync(KILL_SWITCH_PATH)) {
    log('[runner] Kill-switch sentinel absent, exiting. Touch ~/.auxilo/autonomous-enabled to enable.');
    process.exit(0);
  }

  // ── A5.2: Recursion guard ─────────────────────────────────────────────
  if (process.env.AUXILO_EXTRACTING === '1') {
    log('[runner] Recursion guard (AUXILO_EXTRACTING=1) tripped, exiting.');
    process.exit(0);
  }
  process.env.AUXILO_EXTRACTING = '1';

  // ── Credentials ───────────────────────────────────────────────────────
  if (!API_KEY && !args.dryRun) {
    console.error('[runner] AUXILO_API_KEY not set. Use --dry-run for local testing.');
    process.exit(1);
  }

  // ── Single-file mode (--transcript <path>) ───────────────────────────
  // P1-3 fast-follow: this flag was parsed but never handled. Processes
  // one transcript file through the same scrub + POST pipeline used by
  // the discover loop, bypassing ledger/discovery. Used by SessionEnd
  // hooks and for targeted testing.
  if (args.transcript) {
    const transcriptPath = path.resolve(args.transcript);
    if (!fs.existsSync(transcriptPath)) {
      log(`[runner] Transcript file not found: ${transcriptPath}`);
      process.exit(1);
    }

    // Pick the right source adapter — capture-core forwards the client id
    // via --source (UC-1). Default to claude-code since it can parse either
    // JSONL or plain text. Unknown ids (cursor, windsurf, codex, copilot,
    // factory, ...) fall back to the generic Claude-style JSONL normalizer,
    // which tags uploads with the actual client id and refuses (fail-silent)
    // anything that doesn't probe as JSONL.
    const sourceType = args.source || 'claude-code';
    const SourceClass = SOURCES.find(S => S.id === sourceType);
    let source;
    if (SourceClass) {
      source = new SourceClass();
    } else {
      log(`[runner] No dedicated adapter for source "${sourceType}" — using generic-jsonl fallback`);
      source = new GenericJsonlSource({ id: sourceType });
    }
    const sessionId = path.basename(transcriptPath, path.extname(transcriptPath));
    const stat = fs.statSync(transcriptPath);
    const sessionRef = {
      path: transcriptPath,
      sessionId,
      mtime: stat.mtime.toISOString(),
      bytes: stat.size,
    };

    log(`[runner] Single-file mode: ${transcriptPath} (${stat.size} bytes)`);

    let transcriptData;
    try {
      transcriptData = await source.readSession(sessionRef);
    } catch (err) {
      // Fallback: treat the file as a plain pre-formatted transcript
      try {
        transcriptData = { transcript: fs.readFileSync(transcriptPath, 'utf-8') };
      } catch (e2) {
        log(`[runner] Read failed: ${err.message}`);
        process.exit(1);
      }
    }

    // UC-1 format-probe refusal: adapters return null (never throw) when a
    // file doesn't match their expected shape. Skip — do NOT fall back to
    // raw text, that would mis-parse garbage into a transcript (UC §5).
    if (!transcriptData || typeof transcriptData.transcript !== 'string') {
      log(`[runner] Format probe refused ${transcriptPath} (source=${source.type}). Exiting.`);
      process.exit(0);
    }

    let transcript = transcriptData.transcript;
    if (transcript.length < MIN_CHARS) {
      log(`[runner] Too short (${transcript.length} chars, min ${MIN_CHARS}). Exiting.`);
      process.exit(0);
    }
    if (transcript.length > MAX_CHARS) {
      log(`[runner] Truncating from ${transcript.length} to ${MAX_CHARS} chars`);
      transcript = transcript.slice(0, MAX_CHARS);
    }

    const { cleaned, report, refused } = scrubAndVerify(transcript);
    if (refused || !cleaned) {
      log(`[runner] Scrub fail-closed — refusing to upload ${DIGEST_ACCOUNT}`);
      process.exit(1);
    }
    if (!report.clean) {
      log(`[runner] Scrubbed ${report.patterns_matched.length} sensitive pattern(s): ${[...new Set(report.patterns_matched)].join(', ')} ${DIGEST_ACCOUNT}`);
    }

    // GOV-3 M2: content-sha ledger dedup for single-file mode. Some clients
    // fire their capture hook PER RESPONSE / PER TURN, not at session end
    // (Windsurf post_cascade_response_with_transcript; Codex/Antigravity
    // Stop). Without this, each firing re-uploads the whole transcript-so-far
    // as a fresh extraction (new idempotency key per call), burning rate
    // limit and re-running the LLM on growing partials. Keyed on the cleaned
    // content sha so identical/already-seen content is skipped. --force
    // bypasses (targeted re-test).
    const contentSha = crypto.createHash('sha256').update(cleaned).digest('hex');
    if (!args.force) {
      const ledger = loadLedger();
      if (ledgerHas(ledger, sourceType, sessionId, contentSha)) {
        log(`[runner] Already uploaded this content (source=${sourceType} session=${sessionId}). Skipping.`);
        process.exit(0);
      }
    }

    if (args.dryRun) {
      log(`[runner] [DRY RUN] Would upload ${cleaned.length} chars to ${BASE_URL}/extract`);
      process.exit(0);
    }

    try {
      const result = await postExtract(cleaned, sessionId, sourceType, report);
      log(`[runner] ✓ published=${result.learnings_published || 0} rejected=${result.learnings_rejected || 0} ${DIGEST_ACCOUNT} (extraction: ${result.extraction_id})`);
      // Mark only after a successful upload so a failed POST can be retried.
      const ledger = loadLedger();
      ledgerMark(ledger, sourceType, sessionId, contentSha, sessionRef.mtime);
      saveLedger(ledger);
      process.exit(0);
    } catch (err) {
      log(`[runner] ✗ Upload failed: ${err.message}`);
      process.exit(1);
    }
  }

  // ── Flush pending (--flush-pending) ───────────────────────────────────
  if (args.flushPending) {
    const pending = listPendingFiles();
    log(`[runner] Flushing ${pending.length} pending queue file(s)...`);
    let flushed = 0;
    for (const qf of pending) {
      try {
        const payload = JSON.parse(fs.readFileSync(qf, 'utf-8'));
        const result = await postExtract(
          payload.transcript, payload.sessionId, payload.source, payload.scrubReport
        );
        log(`[runner] ✓ Flushed ${path.basename(qf)}: published=${result.learnings_published || 0} rejected=${result.learnings_rejected || 0} ${DIGEST_ACCOUNT}`);
        deleteQueueFile(qf);
        flushed++;
      } catch (err) {
        log(`[runner] ✗ Retry failed for ${path.basename(qf)}: ${err.message}`);
      }
    }
    log(`[runner] Flush complete: ${flushed}/${pending.length} succeeded`);
    process.exit(0);
  }

  // ── Enumerate sources ─────────────────────────────────────────────────
  const sources = await enumerateActiveSources(args.source);
  if (sources.length === 0) {
    log(`[runner] No active sources found${args.source ? ` for type "${args.source}"` : ''}`);
    process.exit(0);
  }

  const ledger = loadLedger();
  let totalDiscovered = 0;
  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const source of sources) {
    log(`[runner] Discovering sessions from ${source.label} (${source.type})...`);

    let sessions;
    try {
      const since = args.force ? undefined : ledgerHighWater(ledger, source.type);
      sessions = await source.discoverSessions({ since });
    } catch (err) {
      log(`[runner] Discovery failed for ${source.type}: ${err.message}`);
      continue;
    }

    // Filter to specific session if requested
    if (args.session) {
      sessions = sessions.filter(s => s.sessionId === args.session);
    }

    log(`[runner] Found ${sessions.length} new session(s)`);
    totalDiscovered += sessions.length;

    for (const sessionRef of sessions) {
      log(`[runner]   Processing ${sessionRef.sessionId} (${sessionRef.bytes} bytes)...`);

      // Read transcript
      let transcriptData;
      try {
        transcriptData = await source.readSession(sessionRef);
      } catch (err) {
        log(`[runner]   Read failed: ${err.message}`);
        totalFailed++;
        continue;
      }

      // UC-1 format-probe refusal: null = skip silently (not a failure).
      if (!transcriptData || typeof transcriptData.transcript !== 'string') {
        log(`[runner]   Skipped — format probe refused (source=${source.type})`);
        totalSkipped++;
        ledgerMark(ledger, source.type, sessionRef.sessionId, 'probe-refused', sessionRef.mtime);
        continue;
      }

      let transcript = transcriptData.transcript;

      // Size check
      if (transcript.length < MIN_CHARS) {
        log(`[runner]   Skipped — too short (${transcript.length} chars, min ${MIN_CHARS}) ${DIGEST_ACCOUNT}`);
        totalSkipped++;
        ledgerMark(ledger, source.type, sessionRef.sessionId, 'skipped', sessionRef.mtime);
        continue;
      }

      // Truncate if too long
      if (transcript.length > MAX_CHARS) {
        log(`[runner]   Truncating from ${transcript.length} to ${MAX_CHARS} chars`);
        transcript = transcript.slice(0, MAX_CHARS);
      }

      // Client-side scrub (§7.5)
      const { cleaned, report, refused } = scrubAndVerify(transcript);
      if (refused || !cleaned) {
        log(`[runner]   Scrub fail-closed — refusing to upload ${DIGEST_ACCOUNT}`);
        totalFailed++;
        continue;
      }

      if (!report.clean) {
        log(`[runner]   Scrubbed ${report.patterns_matched.length} sensitive pattern(s): ${[...new Set(report.patterns_matched)].join(', ')} ${DIGEST_ACCOUNT}`);
      }

      if (args.dryRun) {
        log(`[runner]   [DRY RUN] Would upload ${cleaned.length} chars to ${BASE_URL}/extract`);
        totalProcessed++;
        continue;
      }

      // A5.3: Write durable queue file BEFORE POST (write-before-POST pattern)
      const sha = crypto.createHash('sha256').update(cleaned).digest('hex');

      // Local dedup via ledger
      if (ledgerHas(ledger, source.type, sessionRef.sessionId, sha)) {
        log(`[runner]   Skipped — already in ledger ${DIGEST_ACCOUNT}`);
        totalSkipped++;
        continue;
      }

      const queueFile = writeQueueFile({
        source: source.type,
        sessionId: sessionRef.sessionId,
        transcript: cleaned,
        sha,
        scrubReport: report,
        mtime: sessionRef.mtime,
        queuedAt: new Date().toISOString(),
      });

      try {
        const result = await postExtract(cleaned, sessionRef.sessionId, source.type, report);
        log(`[runner]   ✓ published=${result.learnings_published || 0} rejected=${result.learnings_rejected || 0} ${DIGEST_ACCOUNT} (extraction: ${result.extraction_id})`);
        ledgerMark(ledger, source.type, sessionRef.sessionId, sha, sessionRef.mtime);
        deleteQueueFile(queueFile);
        saveLedger(ledger);
        totalProcessed++;
      } catch (err) {
        log(`[runner]   ✗ Upload failed: ${err.message} — queue file retained at ${queueFile}`);
        totalFailed++;
        // Do NOT exit loop; try next session
      }
    }
  }

  saveLedger(ledger);
  log(`[runner] Summary: ${totalDiscovered} discovered, ${totalProcessed} processed, ${totalSkipped} skipped, ${totalFailed} failed`);
  process.exit(totalFailed > 0 ? 1 : 0);
}

// ─── Exports (for testing) + Entry Point ────────────────────────────────────

module.exports = {
  parseArgs, writeQueueFile, deleteQueueFile, listPendingFiles,
  loadLedger, saveLedger, ledgerHighWater, ledgerHas, ledgerMark,
  installHooks, installSweeper, installDigest, printStatus, scrubAndVerify, enumerateActiveSources,
  KILL_SWITCH_PATH, PENDING_DIR, LEDGER_PATH,
};

// Only run main() when executed directly (not when required for tests)
if (require.main === module) {
  main().catch(err => {
    console.error('[runner] Fatal error:', err.message);
    process.exit(1);
  });
}
