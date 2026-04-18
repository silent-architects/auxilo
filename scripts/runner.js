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

// ─── Constants ──────────────────────────────────────────────────────────────

const API_KEY = process.env.AUXILO_API_KEY;
const BASE_URL = process.env.AUXILO_BASE_URL || 'http://localhost:49152';
const MIN_CHARS = 1500;
const MAX_CHARS = 30000;

const AUXILO_DIR = path.join(os.homedir(), '.auxilo');
const KILL_SWITCH_PATH = path.join(AUXILO_DIR, 'autonomous-enabled');
const PENDING_DIR = path.join(AUXILO_DIR, 'pending-learnings');
const LEDGER_PATH = path.join(AUXILO_DIR, 'ledger.json');
const LOG_PATH = path.join(AUXILO_DIR, 'extract.log');

// ─── Source Registry (§4.4) ─────────────────────────────────────────────────

const SOURCES = [
  ClaudeCodeSource,
  OpenClawSource,
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
    installHooks: false, status: false,
    transcript: null, flushPending: false,
    force: false, verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--install-hooks') args.installHooks = true;
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

async function postExtract(transcript, sessionId, sourceType, scrubReport) {
  const transcriptSha256 = crypto.createHash('sha256').update(transcript).digest('hex');
  const idempotencyKey = crypto.randomUUID();

  const res = await fetch(`${BASE_URL}/extract`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      source: { type: sourceType, session_id: sessionId },
      transcript,
      transcript_sha256: transcriptSha256,
      client_scrub_report: scrubReport,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Upload failed (${res.status}): ${data.error || JSON.stringify(data)}`);
  }
  return { ...data, transcript_sha256: transcriptSha256 };
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
        log(`[runner] ✓ Flushed ${path.basename(qf)}: ${result.learnings_published || 0} published`);
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

      let transcript = transcriptData.transcript;

      // Size check
      if (transcript.length < MIN_CHARS) {
        log(`[runner]   Skipped — too short (${transcript.length} chars, min ${MIN_CHARS})`);
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
        log(`[runner]   Scrub fail-closed — refusing to upload`);
        totalFailed++;
        continue;
      }

      if (!report.clean) {
        log(`[runner]   Scrubbed ${report.patterns_matched.length} sensitive pattern(s): ${[...new Set(report.patterns_matched)].join(', ')}`);
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
        log(`[runner]   Skipped — already in ledger`);
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
        log(`[runner]   ✓ ${result.learnings_published || 0} learning(s) published, ${result.learnings_rejected || 0} rejected (extraction: ${result.extraction_id})`);
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
  installHooks, printStatus, scrubAndVerify, enumerateActiveSources,
  KILL_SWITCH_PATH, PENDING_DIR, LEDGER_PATH,
};

// Only run main() when executed directly (not when required for tests)
if (require.main === module) {
  main().catch(err => {
    console.error('[runner] Fatal error:', err.message);
    process.exit(1);
  });
}
