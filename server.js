const { Hono } = require('hono');
const { serve } = require('@hono/node-server');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { isAddress } = require('viem');
const { privateKeyToAccount } = require('viem/accounts'); // M-F: key validation
const {
  createNonce,
  consumeNonce,
  verifyChallengeSignature,
  verifyWithdrawalSignature,
  EIP712_DOMAIN,
} = require('./lib/eip712.js');
const { scanLearning, scanText, getRedactionHint, SENSITIVITY_FILTER_VERSION } = require('./lib/sensitivity-filter.js');
const { fetchPage, stripNonContent, htmlToMarkdown, extractStructured, validateUrl, LLMS_TXT } = require('./lib/renderly.js');

// ─── Phase 2.1a: Autonomous Extraction Pipeline ─────────────────────────────
const { extractWithRetry } = require('./lib/providers/anthropic.js');
const { ProviderAuthError } = require('./lib/providers/provider.interface.js');
const { extractLearnings, sanitizeLearningBody, scoreLearning, VALID_CATEGORIES: EXTRACTOR_CATEGORIES } = require('./lib/extractor.js');
const { getConsentState, appendConsent, hasActiveConsent } = require('./lib/extraction-consent-reader.js');
const { appendAuditRow } = require('./lib/extraction-audit-writer.js');

// ─── Phase 0.5: Earnings Helpers (SPEC-P0.5) — must load before data init ────
const {
  resolveEarningsEntry,
  initEarningsEntry,
  migrateEarningsToAccountKeyed,
  lazyMigrateOnWalletLink,
  setWalletIndex,
} = require('./lib/earnings.js');

// ─── S21-4: SESSION_SECRET Startup Validation ──────────────────────────────
// If SESSION_SECRET is unset in production, sessions use an ephemeral key and
// break on restart — this is a silent, session-breaking vulnerability.
if (!process.env.SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[FATAL] SESSION_SECRET environment variable is not set.');
    console.error('[FATAL] In production, sessions require a stable secret. Refusing to start.');
    console.error('[FATAL] Set SESSION_SECRET to a random 64+ character hex string.');
    process.exit(1);
  } else {
    const generated = crypto.randomBytes(32).toString('hex');
    process.env.SESSION_SECRET = generated;
    console.warn('[WARNING] SESSION_SECRET is not set. Generated ephemeral secret for this session.');
    console.warn('[WARNING] Sessions will NOT survive a restart. Set SESSION_SECRET for persistence.');
  }
}

// ─── FIX 1: Restrict file creation permissions (umask 077) ──────────────────
// Ensures every file written by this process (writeFileSync/renameSync/.tmp
// atomic-swap pattern) gets mode 600 automatically, so no manual chmod is
// needed after each write and credentials / wallet data are never world-readable.
process.umask(0o077);

const app = new Hono();

// IR-M-003 FIX: CORS origin restriction — only allow expected frontends
//
// Current allowed origins:
//   1. https://auxilo.slamagency.com          — production frontend
//   2. https://3000-{vm-id}.life.conway.tech  — Conway VM dev environment
//
// Conway VM URL format: https://{port}-{vm-id}.life.conway.tech
//   Example: https://3000-725fa3fea775ba39db5a2e3703fa4557.life.conway.tech
//
// When the Conway VM changes (new session/rebuild), update the second entry above
// with the new vm-id. The port (3000) stays the same as long as server.js is
// listening on PORT=3000. Redeploy server.js after updating.
const ALLOWED_ORIGINS = new Set([
  'https://auxilo.slamagency.com',
  'https://3000-725fa3fea775ba39db5a2e3703fa4557.life.conway.tech',
]);
app.use('*', async (c, next) => {
  const origin = c.req.header('origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
    c.header('Access-Control-Max-Age', '86400');
  }
  if (c.req.method === 'OPTIONS') return c.text('', 204);
  await next();
});

// Security headers middleware (Hono equivalent of Helmet)
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // HSTS handled by Cloudflare, CSP not needed for API-only responses
});

// IR-C-002 FIX: Global body size limit — reject oversized payloads before JSON parsing
// A4: /extract uses 256KB cap from model_config.json; all other routes use 100KB.
const MAX_BODY_SIZE = 100 * 1024; // 100KB — generous for all Auxilo routes
app.use('*', async (c, next) => {
  if (c.req.method === 'POST' || c.req.method === 'PUT' || c.req.method === 'PATCH') {
    const contentLength = parseInt(c.req.header('content-length') || '0', 10);
    const cap = c.req.path === '/extract' ? 262144 : MAX_BODY_SIZE;
    if (contentLength > cap) {
      return c.json({ error: 'Request body too large', max_bytes: cap }, 413);
    }
  }
  await next();
});

// S26-1: Hono global error handler — last-resort catch for any unhandled route errors.
// Never exposes err.message or stack traces to the client; logs internally for ops.
app.onError((err, c) => {
  const ts = new Date().toISOString();
  console.error(`[S26-1] [${ts}] Unhandled route error: ${err.message}`);
  console.error(err.stack || err);
  return c.json({ error: 'Internal server error' }, 500);
});

// S8-I4: In-flight request tracking + shutdown-aware middleware
let activeRequests = 0;
let shutdownInProgress = false;
app.use('*', async (c, next) => {
  if (shutdownInProgress) {
    // During shutdown, reject new requests with 503
    c.header('Connection', 'close');
    c.header('Retry-After', '30');
    return c.json({
      error: 'Service is shutting down',
      retry_after: 30,
    }, 503);
  }
  activeRequests++;
  try {
    await next();
  } finally {
    activeRequests--;
  }
});

const WALLET = '0x1BE960313c93b3aA0AA62BF33B300CAB48c36Ca6';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FACILITATOR = 'https://facilitator.openx402.ai';
const VERSION = '0.7.0';

// S21-2: Content moderation config. When enabled, new learnings default to
// 'pending_review' and are excluded from /discover and /knowledge results.
// Set CONTENT_MODERATION_ENABLED=true to activate. Default: auto-approve.
const CONTENT_MODERATION_ENABLED = process.env.CONTENT_MODERATION_ENABLED === 'true';

// Load skill catalog — M-E: NON-CRITICAL (static catalog, easily restored)
let skills = [];
try {
  const skillsPath = path.join(__dirname, 'skills.json');
  if (fs.existsSync(skillsPath)) {
    skills = JSON.parse(fs.readFileSync(skillsPath, 'utf8'));
  }
} catch (e) {
  console.warn(`[M-E] [WARNING] Failed to load skills.json: ${e.message}. Continuing with empty catalog.`);
}

// Track query counts
const queryLog = { total: 0, byCategory: {}, bySkill: {} };

// ─── Persistent Storage ─────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const LEARNINGS_FILE = path.join(DATA_DIR, 'learnings.json');
const RATINGS_FILE = path.join(DATA_DIR, 'ratings.jsonl');
const EARNINGS_FILE = path.join(DATA_DIR, 'earnings.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const VERIFIED_WALLETS_FILE = path.join(DATA_DIR, 'verified-wallets.json');
// WALLET_CHALLENGES_FILE removed — nonces are now in-memory via lib/eip712.js (SPEC-A3)
const SETTLEMENTS_FILE = path.join(DATA_DIR, 'settlements.jsonl');
const SETTLEMENT_COMPACTION_THRESHOLD = 1000; // M-C: lines before compaction triggers
const RATE_LIMITS_FILE = path.join(DATA_DIR, 'rate-limits.json'); // M-A: persisted rate limit state
const STAGED_KEY_FILE  = path.join(DATA_DIR, 'staged-key.json');  // M-F: pending key rotation

// S21-1: Persistent x402 transaction hash deduplication store.
// Append-only file recording every accepted tx hash — prevents replay attacks where
// a valid on-chain payment is resubmitted across endpoints or after LRU cache expiry.
// At 66 bytes per hash + newline, 1M transactions = ~66MB — acceptable.
const DEDUP_FILE = path.join(DATA_DIR, 'tx-hashes.log');
const consumedTxHashes = new Set();

// Load existing tx hashes on startup
try {
  if (fs.existsSync(DEDUP_FILE)) {
    const raw = fs.readFileSync(DEDUP_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) {
      consumedTxHashes.add(line.trim());
    }
    console.log(`[S21-1] Loaded ${consumedTxHashes.size} consumed tx hashes from ${DEDUP_FILE}`);
  }
} catch (e) {
  console.warn(`[S21-1] [WARNING] Failed to load tx-hashes.log: ${e.message}. Starting with empty set.`);
}

/**
 * Check if a tx hash has already been consumed. If not, record it.
 * @param {string} txHash - Transaction hash to check/record
 * @returns {boolean} true if the hash is NEW (not previously consumed), false if already used
 */
function recordTxHash(txHash) {
  const normalized = txHash.toLowerCase().trim();
  if (consumedTxHashes.has(normalized)) {
    return false; // Already consumed — replay attempt
  }
  consumedTxHashes.add(normalized);
  try {
    fs.appendFileSync(DEDUP_FILE, normalized + '\n');
  } catch (e) {
    console.error(`[S21-1] Failed to append tx hash to ${DEDUP_FILE}: ${e.message}`);
    // Hash is still in the in-memory Set, so dedup still works for this session.
  }
  return true; // New hash — accepted
}

// S21-3: Content reports append-only log
const REPORTS_FILE = path.join(DATA_DIR, 'reports.log');

// S21-3: Report rate limiting — 10 reports per IP per hour
const REPORT_RATE_LIMIT = 10;
const REPORT_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const reportRateStore = new Map(); // ip -> number[] (timestamps)

function isReportRateLimited(ip) {
  const now = Date.now();
  if (!reportRateStore.has(ip)) {
    reportRateStore.set(ip, [now]);
    return false;
  }
  const timestamps = reportRateStore.get(ip).filter(ts => now - ts < REPORT_RATE_WINDOW_MS);
  if (timestamps.length >= REPORT_RATE_LIMIT) {
    reportRateStore.set(ip, timestamps);
    return true;
  }
  timestamps.push(now);
  reportRateStore.set(ip, timestamps);
  return false;
}

// ─── M-F: Staged Key Rotation — Startup Apply ──────────────────────────────
// If a staged-key.json exists from a previous /admin/stage-key call, validate
// the key and apply it to the environment BEFORE tx-manager initialises its
// module-level constants.  On success the file is deleted; on failure it is
// renamed to .failed for forensics.
if (fs.existsSync(STAGED_KEY_FILE)) {
  try {
    const staged = JSON.parse(fs.readFileSync(STAGED_KEY_FILE, 'utf8'));
    if (!staged || !staged.private_key || typeof staged.private_key !== 'string') {
      throw new Error('Malformed staged-key.json — missing private_key field');
    }

    // Validate the key actually produces a valid account
    const keyHex = staged.private_key.startsWith('0x')
      ? staged.private_key
      : `0x${staged.private_key}`;
    const acct = privateKeyToAccount(keyHex);
    const newAddress = acct.address;

    // Apply to environment — tx-manager will pick this up when require()'d
    process.env.PRIVATE_KEY = keyHex;

    // Remove the staged file (rotation consumed)
    fs.unlinkSync(STAGED_KEY_FILE);

    console.log(`[M-F] [KEY-ROTATION] Staged key applied. New wallet: ${newAddress}. staged-key.json deleted.`);
    console.log(`[M-F] [AUDIT] Key rotation completed at ${new Date().toISOString()}, staged_by: ${staged.staged_by || 'unknown'}, staged_at: ${staged.staged_at || 'unknown'}.`);
  } catch (e) {
    console.error(`[M-F] [KEY-ROTATION-FAILED] Could not apply staged key: ${e.message}`);
    // Rename to .failed for forensics — don't retry next startup
    try {
      fs.renameSync(STAGED_KEY_FILE, STAGED_KEY_FILE + '.failed');
      console.error('[M-F] Renamed staged-key.json to staged-key.json.failed for inspection.');
    } catch (renameErr) {
      console.error(`[M-F] Could not rename staged-key.json: ${renameErr.message}`);
    }
  }
}

/**
 * M-E: Attempt to restore a corrupted data file from the most recent backup.
 * Scans data/backups/ for files matching the pattern {filename}-{date}.json.
 * Returns parsed data if a valid backup is found, null otherwise.
 */
function attemptBackupRestore(filepath, label) {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return null;

    const backupFiles = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith(label))
      .sort()
      .reverse(); // Most recent first (date-sorted filenames)

    for (const backupFile of backupFiles) {
      try {
        const backupPath = path.join(BACKUP_DIR, backupFile);
        const raw = fs.readFileSync(backupPath, 'utf8');
        const data = JSON.parse(raw);
        console.log(`[M-E] Restored ${label} from backup: ${backupFile}`);

        // Write restored data back to the primary file — writeAndSync for durability (S9-3)
        const tmp = filepath + '.tmp';
        writeAndSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, filepath);

        return data;
      } catch {
        // This backup is also corrupt, try next
        continue;
      }
    }
  } catch {
    // Backup dir read failed — nothing to restore
  }
  return null;
}

/**
 * M-E: Load a JSON data file with corruption detection.
 * @param {string} filepath - Absolute path to JSON file
 * @param {*} emptyDefault - Default value if file doesn't exist
 * @param {boolean} critical - If true, exit(1) on corruption. If false, warn and use default.
 * @returns {*} Parsed data or default
 */
function loadDataFile(filepath, emptyDefault, critical) {
  const label = path.basename(filepath);

  // File doesn't exist — not corruption, just first run
  if (!fs.existsSync(filepath)) {
    console.log(`[startup] ${label} not found, initializing with empty state`);
    return emptyDefault;
  }

  try {
    const raw = fs.readFileSync(filepath, 'utf8');

    // Empty file — treat as "not yet written"
    if (raw.trim().length === 0) {
      console.warn(`[startup] ${label} exists but is empty, initializing with empty state`);
      return emptyDefault;
    }

    return JSON.parse(raw);
  } catch (e) {
    if (critical) {
      // Attempt backup restoration before failing
      const restored = attemptBackupRestore(filepath, label);
      if (restored !== null) {
        console.warn(`[M-E] [CRITICAL] ${label} corrupted but restored from backup: ${e.message}`);
        return restored;
      }

      console.error(`[M-E] [CRITICAL] Failed to parse ${label}: ${e.message}`);
      console.error(`[M-E] [CRITICAL] No valid backup found. Server cannot start with corrupted financial data.`);
      console.error(`[M-E] [CRITICAL] Manual intervention required. Check data/backups/ for recent copies.`);
      process.exit(1);
    } else {
      console.warn(`[M-E] [WARNING] Failed to parse ${label}: ${e.message}. Continuing with empty state.`);
      return emptyDefault;
    }
  }
}

let learnings = loadDataFile(LEARNINGS_FILE, [], true);     // CRITICAL
let earnings  = loadDataFile(EARNINGS_FILE, {}, true);      // CRITICAL
let accounts  = loadDataFile(ACCOUNTS_FILE, {}, true);      // CRITICAL
let verifiedWallets = loadDataFile(VERIFIED_WALLETS_FILE, {}, false); // NON-CRITICAL
verifiedWallets[WALLET.toLowerCase()] = true; // Auto-verify platform wallet

// walletChallenges removed — nonces are now in-memory via lib/eip712.js (SPEC-A3)

// ─── Device Code Login Store (Change 3) ────────────────────────────────────────────
const DEVICE_CODE_TTL = 600_000; // 10 minutes
const deviceCodeStore = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [code, entry] of deviceCodeStore) {
        if (now - entry.created_at > DEVICE_CODE_TTL) deviceCodeStore.delete(code);
    }
}, 60_000);

// Phase 0.5: Account-keyed earnings migration (SPEC-P0.5 §3.1)
// Runs after both earnings + accounts are loaded. Idempotent + atomic.
// The old inline migration (defaults only) is superseded by this call.
migrateEarningsToAccountKeyed(earnings, accounts, DATA_DIR);

// ─── M-B: Post-migration earnings validation ─────────────────────────────────
// Validate pending_balance against (total_contributor - total_withdrawn) for
// every earnings entry.  Also cross-check by_learning totals against the
// learnings catalog to detect any phantom earnings from deleted learnings.
// Migration-only: runs once at startup, logs discrepancies, uses validated
// (lower) amount.  Non-fatal — never blocks startup.
{
  let corrected = 0;
  const learningPriceMap = {};
  for (const l of learnings) {
    if (l && l.id && typeof l.price === 'number') {
      learningPriceMap[l.id] = l.price;
    }
  }

  for (const [key, entry] of Object.entries(earnings)) {
    if (key.startsWith('__') || !entry || typeof entry !== 'object') continue;

    const totalContrib  = entry.total_contributor || 0;
    const totalWithdrawn = entry.total_withdrawn  || 0;
    const currentPending = entry.pending_balance  || 0;

    // Cross-check: sum by_learning contributor earnings
    let byLearningSum = 0;
    if (entry.by_learning && typeof entry.by_learning === 'object') {
      for (const [lid, data] of Object.entries(entry.by_learning)) {
        byLearningSum += (data.contributor || 0);
        // Check for phantom earnings from deleted learnings
        if (learningPriceMap[lid] === undefined && (data.contributor || 0) > 0) {
          console.warn(`[M-B] [AUDIT] Entry ${key}: by_learning[${lid}] has $${(data.contributor || 0).toFixed(6)} but learning not found in catalog.`);
        }
      }
    }

    // Validated pending = total_contributor - total_withdrawn (never negative)
    const validatedPending = Math.max(0, totalContrib - totalWithdrawn);

    // Correct if current pending exceeds validated amount
    if (currentPending > validatedPending + 0.000001) { // float tolerance
      console.warn(
        `[M-B] [CORRECTED] Entry ${key}: pending_balance $${currentPending.toFixed(6)} ` +
        `exceeds validated $${validatedPending.toFixed(6)} (contributor=$${totalContrib.toFixed(6)}, ` +
        `withdrawn=$${totalWithdrawn.toFixed(6)}). Clamping to validated amount.`
      );
      entry.pending_balance = validatedPending;
      corrected++;
    }

    // Also warn if by_learning sum diverges from total_contributor
    if (Math.abs(byLearningSum - totalContrib) > 0.000001) {
      console.warn(
        `[M-B] [AUDIT] Entry ${key}: by_learning contributor sum $${byLearningSum.toFixed(6)} ` +
        `!= total_contributor $${totalContrib.toFixed(6)}. Possible data drift.`
      );
    }
  }

  if (corrected > 0) {
    console.log(`[M-B] Corrected ${corrected} earnings entries with inflated pending_balance.`);
    safeWrite(EARNINGS_FILE, earnings);
  } else {
    console.log('[M-B] Earnings validation passed — no discrepancies found.');
  }
}

// On first startup, seed from seed-knowledge.json if learnings is empty
if (learnings.length === 0) {
  try {
    const seedFile = path.join(__dirname, 'seed-knowledge.json');
    if (fs.existsSync(seedFile)) {
      learnings = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
      safeWrite(LEARNINGS_FILE, learnings);
      console.log(`Seeded ${learnings.length} initial learnings`);
    }
  } catch (e) {
    console.error('Failed to load seed knowledge:', e.message);
  }
}

// IR-M-001 FIX: fsync before rename — ensures data hits disk before atomic swap
function writeAndSync(filepath, content) {
  const fd = fs.openSync(filepath, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

let lastBackupCleanup = 0;
let cleanupRunning = false; // M-G: prevent concurrent backup cleanup
/**
 * Redact a client IP for consent/audit logs.
 *
 * IPv4: mask the final octet — 1.2.3.4 → 1.2.3.*
 * IPv6: truncate to /64 network prefix (first 4 hextets), drop the
 *       interface identifier that can uniquely identify the device.
 *       2a09:8280:0001:0000:0105:bffb:0000:0000 → 2a09:8280:1:0::
 *
 * Returns the string 'unknown' for null/undefined inputs.
 *
 * P1-4 fix: the earlier inline regex `ip.replace(/\.\d+$/, '.*')` only
 * matched IPv4 (requires trailing dot+digits); IPv6 addresses have `:`
 * separators and were stored unredacted.
 */
function redactIp(ip) {
  if (!ip || typeof ip !== 'string') return 'unknown';
  // IPv4 — mask last octet
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.replace(/\.\d+$/, '.*');
  }
  // IPv6 — keep first 4 hextets (/64 prefix), drop the rest
  if (ip.includes(':')) {
    // Expand :: if present, then take the first 4 groups
    let parts;
    if (ip.includes('::')) {
      const [head, tail] = ip.split('::');
      const headParts = head ? head.split(':') : [];
      const tailParts = tail ? tail.split(':') : [];
      const needed = 8 - headParts.length - tailParts.length;
      parts = [...headParts, ...Array(needed).fill('0'), ...tailParts];
    } else {
      parts = ip.split(':');
    }
    // Take first 4 hextets, collapse the rest with ::
    const prefix = parts.slice(0, 4).join(':');
    return `${prefix}::/64`;
  }
  // Unknown format — log as-is but truncated to avoid PII leak
  return ip.length > 32 ? ip.slice(0, 32) + '…' : ip;
}

function safeWrite(filepath, data) {
  const tmp = filepath + '.tmp';
  const strData = JSON.stringify(data, null, 2);
  writeAndSync(tmp, strData);
  fs.renameSync(tmp, filepath);
  try {
    const filename = path.basename(filepath);
    const dateStr = new Date().toISOString().split('T')[0];
    const backupPath = path.join(BACKUP_DIR, `${filename}-${dateStr}.json`);
    writeAndSync(backupPath + '.tmp', strData);
    fs.renameSync(backupPath + '.tmp', backupPath);
  } catch (e) {
    console.error('Backup failed:', e.message);
  }
  // Cleanup old backups (keep last 7 days), runs max once per hour to avoid blocking hot paths
  // M-G: mutex flag prevents concurrent cleanup if safeWrite is ever made async
  // M-D: throttle already present (1-hour window) — observability log added
  if (!cleanupRunning && Date.now() - lastBackupCleanup > 3600000) {
    cleanupRunning = true;           // M-G: acquire mutex
    lastBackupCleanup = Date.now();  // M-D: throttle (set before cleanup)
    console.log('[M-D] Running periodic backup cleanup');
    try {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const backupFiles = fs.readdirSync(BACKUP_DIR);
      for (const f of backupFiles) {
        try {
          const fpath = path.join(BACKUP_DIR, f);
          const stat = fs.statSync(fpath);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(fpath);
            console.log(`[BACKUP] Cleaned up old backup: ${f}`);
          }
        } catch (unlinkErr) {
          console.error(`Backup cleanup failed for ${f}:`, unlinkErr.message);
        }
      }
    } catch (e) {
      console.error('Backup cleanup read/stat failed:', e.message);
    } finally {
      cleanupRunning = false;        // M-G: release mutex (always, even on error)
    }
  }
}

let settlementAppendCount = 0; // M-C: track appends for compaction trigger

function appendSettlement(s) {
  fs.appendFileSync(SETTLEMENTS_FILE, JSON.stringify(s) + '\n');
  // S20-F1 FIX: Invalidate the settlement cache for this wallet so that
  // GET /contributor/:wallet/settlements doesn't serve stale data after a write.
  if (s.wallet) invalidateCachedSettlement(`settlements:${s.wallet.toLowerCase()}`);
  settlementAppendCount++;
  if (settlementAppendCount >= SETTLEMENT_COMPACTION_THRESHOLD) {
    settlementAppendCount = 0;
    // Defer to next tick to avoid blocking the current request
    process.nextTick(compactSettlements);
  }
}

/**
 * M-C: Compact settlements.jsonl — archive completed entries, keep only active.
 * Safe: writes archive first, verifies, then rewrites active file.
 */
function compactSettlements() {
  try {
    if (!fs.existsSync(SETTLEMENTS_FILE)) return;

    const raw = fs.readFileSync(SETTLEMENTS_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);

    if (lines.length < SETTLEMENT_COMPACTION_THRESHOLD) {
      return; // Not enough lines to justify compaction
    }

    console.log(`[M-C] Starting settlement compaction (${lines.length} lines)`);

    // Build latest state per settlement ID
    const latestState = {};
    for (const line of lines) {
      try {
        const s = JSON.parse(line);
        if (s.id) latestState[s.id] = s;
      } catch {
        // Skip malformed lines
      }
    }

    // Separate completed from active
    const COMPLETED_STATUSES = new Set(['settled', 'failed', 'refunded']);
    const completed = [];
    const active = [];

    for (const s of Object.values(latestState)) {
      if (COMPLETED_STATUSES.has(s.status)) {
        completed.push(s);
      } else {
        active.push(s);
      }
    }

    if (completed.length === 0) {
      console.log('[M-C] No completed settlements to archive');
      return;
    }

    // Step 1: Write archive (append if today's archive exists)
    const dateStr = new Date().toISOString().split('T')[0];
    const archiveFile = path.join(DATA_DIR, `settlements-archive-${dateStr}.jsonl`);
    const archiveContent = completed.map(s => JSON.stringify(s)).join('\n') + '\n';
    fs.appendFileSync(archiveFile, archiveContent);

    // Step 2: Verify archive is readable
    const archiveRaw = fs.readFileSync(archiveFile, 'utf8');
    const archiveLines = archiveRaw.split('\n').filter(Boolean);
    let archivedIds = 0;
    for (const line of archiveLines) {
      try {
        const s = JSON.parse(line);
        if (s.id) archivedIds++;
      } catch {
        // ignore
      }
    }

    if (archivedIds < completed.length) {
      console.error(`[M-C] Archive verification failed: expected ${completed.length} entries, found ${archivedIds}. Aborting compaction.`);
      return;
    }

    // Step 3: Rewrite active file with only active entries — writeAndSync for durability (S9-3)
    const activeContent = active.map(s => JSON.stringify(s)).join('\n') + (active.length > 0 ? '\n' : '');
    const tmpFile = SETTLEMENTS_FILE + '.compact-tmp';
    writeAndSync(tmpFile, activeContent);
    fs.renameSync(tmpFile, SETTLEMENTS_FILE);

    console.log(`[M-C] Compacted: ${completed.length} archived, ${active.length} active retained (was ${lines.length} lines)`);
  } catch (e) {
    console.error('[M-C] Settlement compaction failed:', e.message);
    // Non-fatal — append-only file remains intact
  }
}

// ─── Transaction Manager (SPEC-A0) ─────────────────────────────────────
// ALL on-chain USDC broadcasts go through TxManager.sendUSDC().
// No direct walletClient.writeContract() or sendTransaction() calls in this file.
const {
  sendUSDC,
  checkBalance,
  checkGasBalance,
  getPublicClient,
  getWalletAddress,
  USDC_BASE: TX_USDC_BASE,
  WALLET_ADDRESS,
  ERC20_ABI,
} = require('./lib/tx-manager.js');

// ─── A4: Local x402 Fallback (C5 + AUDIT-12) ────────────────────────────────
const { verifyPaymentLocally, getCacheStats } = require('./lib/x402-local.js');

// ─── A4: Admin Auth Hardening (H4 + H5) ─────────────────────────────────────
const { verifyAdminToken } = require('./lib/admin-auth.js');

// ─── Phase 0.1: Account System (SPEC-P0.1) ───────────────────────────────────
const {
  setupAccountRoutes,
  requireAuth,
  validateApiKey,
  linkWallet,
  getClientIp,
  setStripeConnectId,
  newAccountCreationStore,  // FIX 5: periodic sweep of IP-throttle store
  NEW_ACCOUNT_WINDOW_MS,    // FIX 5: 24-hour window constant
  addToKeyIndex,
  migrateToApiKeysArray,
  loadAccounts,
  saveAccounts,
} = require('./lib/accounts.js');
const requireSession = requireAuth; // alias used by /pipeline/* and /referral/* routes

// ─── Write-Ahead Log (SPEC-A2 / C3) ────────────────────────────────────────
const { createWalEntry, markStepComplete, commitWal, getPendingWalEntries } = require('./lib/wal.js');

// ─── WAL Crash Recovery (SPEC-A2 / C3) ─────────────────────────────────────
const { acquireWalletLock, getActiveLockCount } = require('./lib/wallet-lock.js');

// ─── Phase 0.3: Credit System (SPEC-P0.3) ──────────────────────────────────
const { deductCredit, getCreditStatus } = require('./lib/credits.js');

// ─── Phase 0.4: Stripe Integration (SPEC-P0.4) ─────────────────────────────
const {
    PACKS,
    createCheckoutSession,
    verifyWebhookSignature,
    appendPurchase,
    isSessionProcessed,
    getPurchasesForAccount,
    generatePurchaseId,
    createConnectAccountLink,
    createTransferToConnect,
    getConnectAccountStatus,
} = require('./lib/stripe.js');
const { addPurchasedCredits } = require('./lib/credits.js');
// P2.1a: extractLearnings import moved to line 22 (with sanitizeLearningBody, scoreLearning, VALID_CATEGORIES)
const { processMemoryFiles, DEFAULT_ADAPTER_CONFIG } = require('./lib/openclaw-adapter.js');

// ─── Dynamic Pricing Engine (Change 7 + Wave 1 Build E1) ───────────────────
const pricingEngine = require('./lib/pricing.js');
const { computeCurrentPrice, getLockedPrice, lockPrice } = pricingEngine;

/**
 * Replay a partial unlock operation from a WAL entry.
 * Only credits the steps that were NOT yet completed when the crash occurred.
 * IMPL-A2-02: payload stores contributor_earned + platform_earned separately.
 */
function replayUnlock(entry) {
  const { learning_id, builder_wallet, contributor_account_id, unlock_price, contributor_earned, platform_earned } = entry.payload;
  const steps = entry.steps_completed || [];

  // If learnings write didn't complete, we can't determine the learning state.
  // Log and preserve the WAL entry for manual review rather than guess.
  if (!steps.includes('update_learnings')) {
    console.warn(`[wal-recovery] ${entry.id}: learnings write incomplete — earnings credit skipped. Review data/wal/${entry.id}.wal.json manually.`);
    return; // Do NOT commit — leave entry on disk
  }

  // learnings write succeeded; earnings write may or may not have completed.
  if (!steps.includes('update_earnings')) {
    console.log(`[wal-recovery] ${entry.id}: replaying missed earnings credit for ${builder_wallet}`);

    // SPEC-P0.5: resolve via account_id (new WAL entries) or wallet (legacy)
    const { key, entry: e, source } = resolveEarningsEntry(earnings, {
      account_id: contributor_account_id || null,
      wallet: builder_wallet,
    });
    const resolvedKey = (source === 'new')
      ? (contributor_account_id || builder_wallet)
      : key;

    if (source === 'new') {
      earnings[resolvedKey] = initEarningsEntry(contributor_account_id || null, builder_wallet);
    }
    const earningsEntry = earnings[resolvedKey];

    earningsEntry.total_gross += unlock_price;
    earningsEntry.total_contributor += contributor_earned;
    earningsEntry.total_platform += platform_earned;
    earningsEntry.pending_balance += contributor_earned;
    earningsEntry.last_updated = new Date().toISOString();

    if (!earningsEntry.by_learning[learning_id]) {
      earningsEntry.by_learning[learning_id] = { gross: 0, contributor: 0, platform: 0, unlocks: 0 };
    }
    earningsEntry.by_learning[learning_id].gross += unlock_price;
    earningsEntry.by_learning[learning_id].contributor += contributor_earned;
    earningsEntry.by_learning[learning_id].platform += platform_earned;
    earningsEntry.by_learning[learning_id].unlocks += 1;

    safeWrite(EARNINGS_FILE, earnings);
    console.log(`[wal-recovery] ${entry.id}: earnings replayed (+${contributor_earned.toFixed(6)} USDC to ${resolvedKey})`);
  }
  // Both steps done — nothing to replay; commitWal will clean up.
}

/**
 * Replay a partial pipeline-approve operation from a WAL entry.
 *
 * The approve handler writes in this order:
 *   1. update_learnings  — safeWrite(LEARNINGS_FILE, learnings)
 *   2. update_pipelines  — savePipelines()
 *
 * If the server crashed after step 1 but before step 2, the pipeline entry
 * still shows 'awaiting_review', which would allow a second approve and
 * duplicate learnings. This replay corrects the pipeline status.
 *
 * If the crash was before step 1 (no steps recorded), we cannot safely
 * determine the learning state — log and leave for manual review.
 */
function replayPipelineApprove(entry) {
  const { pipeline_id } = entry.payload;
  const steps = entry.steps_completed || [];

  if (!steps.includes('update_learnings')) {
    // learnings write never completed — pipeline was not mutated; nothing to fix.
    // The learnings array is already consistent with disk (the write never landed).
    // Leave WAL entry; commitWal will still be called by recoverWalEntries to clean up,
    // BUT we must NOT flip the pipeline status — it correctly stays 'awaiting_review'.
    console.warn(
      `[wal-recovery] ${entry.id}: pipeline approve — learnings write incomplete for ${pipeline_id}. ` +
      `Pipeline status remains 'awaiting_review'; no action needed.`
    );
    return;
  }

  if (!steps.includes('update_pipelines')) {
    // learnings were written but pipeline status was not updated.
    // Flip the pipeline status to 'published' and persist.
    const pipeline = pipelineEntries.find(p => p.id === pipeline_id);
    if (!pipeline) {
      console.warn(`[wal-recovery] ${entry.id}: pipeline ${pipeline_id} not found in pipelineEntries — skipping.`);
      return;
    }
    if (pipeline.status !== 'published') {
      pipeline.status = 'published';
      savePipelines();
      console.log(`[wal-recovery] ${entry.id}: pipeline ${pipeline_id} status corrected to 'published'.`);
    }
  }
  // Both steps done — nothing to replay.
}

/**
 * Scan data/wal/ for pending entries and replay any interrupted operations.
 * IMPL-A2-01: commitWal is ONLY called if replay succeeds (inside try block).
 * On failure the WAL entry is left on disk for manual inspection.
 */
function recoverWalEntries() {
  const pending = getPendingWalEntries();
  if (pending.length === 0) return;
  console.log(`[wal-recovery] Found ${pending.length} pending WAL entries. Replaying...`);

  for (const entry of pending) {
    try {
      if (entry.operation === 'unlock') replayUnlock(entry);
      else if (entry.operation === 'pipeline_approve') replayPipelineApprove(entry);
      // IMPL-A2-01 fix: commitWal is INSIDE the try block — only reached if replay did not throw.
      commitWal(entry.id);
    } catch (err) {
      console.error(`[wal-recovery] Failed to replay ${entry.id}: ${err.message}. Entry preserved on disk for manual review.`);
      // WAL file is intentionally left intact.
    }
  }
}

// ─── Legacy Settlement Recovery (SPEC-A0 startup path) ───────────────────────
// Renamed from resolveStuckSettlements — handles processing/processing_timeout/
// processing_unresolved statuses only. The new C4 daemon below handles pending/retry.
async function resolveProcessingSettlements() {
  if (!fs.existsSync(SETTLEMENTS_FILE)) return;
  const lines = fs.readFileSync(SETTLEMENTS_FILE, 'utf8').split('\n').filter(Boolean);

  const latestState = {};
  lines.forEach(line => {
    try {
      const s = JSON.parse(line);
      latestState[s.id] = s;
    } catch (e) {
      console.warn('Skipping malformed settlement JSON line:', e.message);
    }
  });

  const stuck = Object.values(latestState).filter(s =>
    s.status === 'processing' || s.status === 'processing_timeout' || s.status === 'processing_unresolved'
  );

  for (const s of stuck) {
    // S20-F3 FIX: Acquire per-wallet lock before mutating earnings, matching the
    // pattern used in resolveStuckSettlements (IR-C-001). Each settlement is written
    // individually under its lock instead of in a single batch at the end.
    const walletKey = s.wallet.toLowerCase();
    const releaseLock = await acquireWalletLock(walletKey);
    try {
      // SPEC-P0.5: resolve via wallet index or direct key
      const { entry, source } = resolveEarningsEntry(earnings, { wallet: s.wallet });
      if (source === 'new') { console.warn(`[SETTLEMENT] No earnings entry for ${s.wallet}`); continue; }

      if (!entry.processed_settlements) entry.processed_settlements = {};
      if (typeof entry.processed_settlements === 'object' && !Array.isArray(entry.processed_settlements) && entry.processed_settlements[s.id]) {
        console.log(`[SETTLEMENT] ${s.id} already applied to ledger. Skipping.`);
        continue;
      }

      if (s.tx_hash) {
        const _pc = getPublicClient();
        if (!_pc) { console.warn(`[SETTLEMENT] Public client missing, skipping resolve ${s.id}`); continue; }
        try {
          const receipt = await _pc.getTransactionReceipt({ hash: s.tx_hash });
          if (receipt.status === 'success') {
            entry.total_withdrawn += s.amount;
            entry.processed_settlements[s.id] = true;
            safeWrite(EARNINGS_FILE, earnings);
            appendSettlement({ ...s, status: 'settled' });
          } else {
            entry.pending_balance += s.amount;
            entry.processed_settlements[s.id] = true;
            safeWrite(EARNINGS_FILE, earnings);
            appendSettlement({ ...s, status: 'failed', error: 'Reverted on-chain' });
          }
        } catch {
          // Pending Mempool Trap fix — receipt unavailable, leave unresolved
          console.warn(`[SETTLEMENT] tx_hash ${s.tx_hash} has no receipt — may be pending. Leaving unresolved.`);
          appendSettlement({ ...s, status: 'processing_unresolved' });
        }
      } else {
        // No tx_hash = never broadcast — safe to refund
        entry.pending_balance += s.amount;
        entry.processed_settlements[s.id] = true;
        safeWrite(EARNINGS_FILE, earnings);
        appendSettlement({ ...s, status: 'failed', error: 'Never broadcast' });
      }
    } finally {
      releaseLock();
    }
  }
}

// ─── SPEC-A2 C4: Stuck Settlement Daemon (pending/retry) ─────────────────────

const SETTLEMENT_MAX_RETRIES = 3;
const SETTLEMENT_REFUND_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SETTLEMENT_DAEMON_INTERVAL_MS = 60 * 60 * 1000;       // 1 hour (AUDIT-06)
// S9-4: max age before a processing_unresolved settlement is forcibly resolved (F-9 audit finding)
const PROCESSING_UNRESOLVED_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours

/**
 * Release a reservation that is no longer backed by an active settlement.
 * Placeholder for SPEC-A1's reservation ledger.
 */
function releaseOrphanedReservation(wallet, amount) {
  if (fs.existsSync(SETTLEMENTS_FILE)) {
    const lines = fs.readFileSync(SETTLEMENTS_FILE, 'utf8').split('\n').filter(Boolean);
    const hasPending = lines.some(line => {
      try {
        const s = JSON.parse(line);
        return s.wallet === wallet && (s.status === 'pending' || s.status === 'retry' || s.status === 'processing');
      } catch (e) {
        return false;
      }
    });

    if (hasPending) {
      console.log(`[settlement-daemon] Cannot release orphaned reservation for ${wallet}, active settlements exist.`);
      return;
    }
  }

  releaseReservation(wallet);
  console.log(`[settlement-daemon] Released orphaned reservation: ${wallet} ${amount} USDC`);
}

/**
 * Scan earnings ledger for drift relative to settled/withdrawn totals.
 * IMPL-A2-04: uses total_withdrawn (not withdrawn — that field does not exist).
 */
function runConsistencyCheck() {
  for (const [w, entry] of Object.entries(earnings)) {
    // SPEC-P0.5: skip metadata keys (e.g. __wallet_index)
    if (w.startsWith('__')) continue;
    if (entry.pending_balance !== undefined && entry.total_contributor !== undefined) {
      const expected = (entry.total_contributor || 0) - (entry.total_withdrawn || 0);
      const actual = entry.pending_balance;
      if (Math.abs(expected - actual) > 0.000001) {
        console.warn(
          `[CONSISTENCY] ${w}: expected pending=${expected.toFixed(6)}, ` +
          `actual=${actual.toFixed(6)}. Drift: ${(actual - expected).toFixed(6)}`
        );
      }
    }
  }
}

let settlementDaemonRunning = false;

/**
 * C4 fix: retry or auto-refund settlements in 'pending' or 'retry' status.
 * Uses append-only JSONL semantics (appendSettlement) — IMPL-A2-03: never rewrites the full file.
 * IMPL-A2-05: missing created_at defaults to Date.now() (treat as new, not ancient).
 */
async function resolveStuckSettlements() {
  if (settlementDaemonRunning) {
    console.log('[settlement-daemon] Already running, skipping execution.');
    return;
  }
  settlementDaemonRunning = true;
  try {
    console.log('[settlement-daemon] Running stuck settlement resolver...');
    if (!fs.existsSync(SETTLEMENTS_FILE)) return;

    const lines = fs.readFileSync(SETTLEMENTS_FILE, 'utf8').split('\n').filter(Boolean);
    const latestState = {};
    for (const line of lines) {
      try {
        const s = JSON.parse(line);
        latestState[s.id] = s;
      } catch (e) {
        console.warn('[settlement-daemon] Skipping malformed settlement line:', e.message);
      }
    }

    const candidates = Object.values(latestState).filter(s =>
      s.status === 'pending' || s.status === 'retry'
    );

    // S9-4: also collect processing_unresolved for separate resolution (F-9 audit finding)
    const unresolvedCandidates = Object.values(latestState).filter(s =>
      s.status === 'processing_unresolved'
    );

    if (candidates.length === 0 && unresolvedCandidates.length === 0) {
      console.log('[settlement-daemon] No pending/retry/processing_unresolved settlements found.');
      return;
    }

    for (const s of candidates) {
      const retryCount = s.retry_count ?? 0;
      // IMPL-A2-05: missing created_at → treat as brand-new (Date.now()), not epoch (0)
      const age = Date.now() - (s.created_at ?? Date.now());

      if (retryCount >= SETTLEMENT_MAX_RETRIES) {
        if (age > SETTLEMENT_REFUND_AGE_MS) {
          // Max retries exhausted AND old enough — auto-refund
          console.log(`[settlement-daemon] ${s.id}: max retries + age exceeded, auto-refunding ${s.wallet}`);

          if (s.tx_hash) {
            const _pc = getPublicClient();
            if (_pc) {
              try {
                const receipt = await _pc.getTransactionReceipt({ hash: s.tx_hash });
                if (receipt.status === 'success') {
                  console.log(`[settlement-daemon] ${s.id}: actually settled on-chain. Marking as settled.`);
                  // SPEC-P0.5: resolve via wallet index
                  // IR-C-001 FIX: acquire wallet lock before mutating earnings
                  const releaseLock1 = await acquireWalletLock(s.wallet.toLowerCase());
                  try {
                    const { key: eKeyS1, entry: entryS1, source: srcS1 } = resolveEarningsEntry(earnings, { wallet: s.wallet });
                    if (srcS1 !== 'new') {
                      entryS1.total_withdrawn = (entryS1.total_withdrawn || 0) + s.amount;
                      entryS1.pending_balance = Math.max(0, (entryS1.pending_balance || 0) - s.amount);
                      if (!entryS1.processed_settlements) entryS1.processed_settlements = {};
                      entryS1.processed_settlements[s.id] = true;
                      safeWrite(EARNINGS_FILE, earnings);
                    }
                  } finally {
                    releaseLock1();
                  }
                  appendSettlement({ ...s, status: 'settled', tx_hash: receipt.transactionHash, settled_at: Date.now() });
                  continue; // Skip the auto-refund below
                }
              } catch (err) {
                console.warn(`[settlement-daemon] ${s.id}: Could not verify tx_hash ${s.tx_hash}: ${err.message}`);
              }
            }
          }

          // SPEC-P0.5: resolve via wallet index
          // IR-C-001 FIX: acquire wallet lock before mutating earnings
          const releaseLock2 = await acquireWalletLock(s.wallet.toLowerCase());
          try {
            const { key: eKeyS2, entry: entryS2, source: srcS2 } = resolveEarningsEntry(earnings, { wallet: s.wallet });
            if (srcS2 !== 'new') {
              entryS2.pending_balance += s.amount;
              safeWrite(EARNINGS_FILE, earnings);
            }
          } finally {
            releaseLock2();
          }
          releaseOrphanedReservation(s.wallet, s.amount);
          // IMPL-A2-03: append-only — never rewrite full JSONL
          appendSettlement({ ...s, status: 'refunded', refunded_at: Date.now() });
        } else {
          // Max retries but still young — wait for next interval
          console.log(`[settlement-daemon] ${s.id}: max retries reached but only ${Math.round(age / 60000)}min old — waiting.`);
        }
        continue;
      }

      // Under retry limit — attempt broadcast
      console.log(`[settlement-daemon] ${s.id}: attempt ${retryCount + 1}/${SETTLEMENT_MAX_RETRIES} for ${s.wallet}`);
      const result = await sendUSDC(s.wallet, s.amount);

      if (result.status === 'confirmed') {
        // SPEC-P0.5: resolve via wallet index
        // IR-C-001 FIX: acquire wallet lock before mutating earnings
        const releaseLock3 = await acquireWalletLock(s.wallet.toLowerCase());
        try {
          const { key: eKeyS3, entry: entryS3, source: srcS3 } = resolveEarningsEntry(earnings, { wallet: s.wallet });
          if (srcS3 !== 'new') {
            entryS3.total_withdrawn = (entryS3.total_withdrawn || 0) + s.amount;
            entryS3.pending_balance = Math.max(0, (entryS3.pending_balance || 0) - s.amount);
            if (!entryS3.processed_settlements) entryS3.processed_settlements = {};
            entryS3.processed_settlements[s.id] = true;
            safeWrite(EARNINGS_FILE, earnings);
          }
        } finally {
          releaseLock3();
        }
        appendSettlement({ ...s, status: 'settled', tx_hash: result.hash, settled_at: Date.now() });
        console.log(`[settlement-daemon] ${s.id}: settled tx=${result.hash}`);
      } else {
        // Failed or timeout — increment retry count and re-queue
        appendSettlement({
          ...s,
          status: 'retry',
          retry_count: retryCount + 1,
          last_error: result.error || result.status,
          last_attempt_at: Date.now(),
        });
        console.warn(`[settlement-daemon] ${s.id}: attempt failed (${result.error || result.status}), retry_count now ${retryCount + 1}`);
      }
    }

    // IR-C-001: earnings are now written immediately under wallet lock at each mutation site
    runConsistencyCheck();

    // S9-4: Resolve processing_unresolved settlements (F-9 audit finding)
    // Each entry has a tx_hash that couldn't be confirmed at broadcast time.
    // Strategy: check on-chain receipt; resolve after 48h if still no receipt.
    if (unresolvedCandidates.length > 0) {
      console.log(`[settlement-daemon] Checking ${unresolvedCandidates.length} processing_unresolved settlement(s)...`);
    }
    for (const s of unresolvedCandidates) {
      const age = Date.now() - (s.created_at ?? Date.now());

      // Check for on-chain receipt first (if tx_hash exists)
      if (s.tx_hash) {
        const _pc = getPublicClient();
        if (_pc) {
          try {
            const receipt = await _pc.getTransactionReceipt({ hash: s.tx_hash });
            if (receipt && receipt.status === 'success') {
              // Transaction confirmed — mark settled, deduct from earnings
              console.log(`[settlement-daemon] ${s.id}: processing_unresolved tx confirmed on-chain. Marking settled.`);
              const releaseLockU1 = await acquireWalletLock(s.wallet.toLowerCase());
              try {
                const { entry: entryU1, source: srcU1 } = resolveEarningsEntry(earnings, { wallet: s.wallet });
                if (srcU1 !== 'new') {
                  entryU1.total_withdrawn = (entryU1.total_withdrawn || 0) + s.amount;
                  entryU1.pending_balance = Math.max(0, (entryU1.pending_balance || 0) - s.amount);
                  if (!entryU1.processed_settlements) entryU1.processed_settlements = {};
                  entryU1.processed_settlements[s.id] = true;
                  safeWrite(EARNINGS_FILE, earnings);
                }
              } finally {
                releaseLockU1();
              }
              appendSettlement({ ...s, status: 'settled', tx_hash: receipt.transactionHash, settled_at: Date.now() });
              commitReservation(s.wallet.toLowerCase());
              console.log(`[settlement-daemon] ${s.id}: resolved processing_unresolved → settled.`);
              continue;
            } else if (receipt && receipt.status !== 'success') {
              // Transaction failed on-chain — refund immediately
              console.log(`[settlement-daemon] ${s.id}: processing_unresolved tx reverted on-chain. Marking failed + refunding.`);
              const releaseLockU2 = await acquireWalletLock(s.wallet.toLowerCase());
              try {
                const { entry: entryU2, source: srcU2 } = resolveEarningsEntry(earnings, { wallet: s.wallet });
                if (srcU2 !== 'new') {
                  entryU2.pending_balance += s.amount;
                  safeWrite(EARNINGS_FILE, earnings);
                }
              } finally {
                releaseLockU2();
              }
              releaseOrphanedReservation(s.wallet, s.amount);
              appendSettlement({ ...s, status: 'failed', error: 'Reverted on-chain', resolved_at: Date.now() });
              console.log(`[settlement-daemon] ${s.id}: resolved processing_unresolved → failed (reverted).`);
              continue;
            }
            // receipt === null means still pending in mempool — fall through to age check
          } catch (err) {
            console.warn(`[settlement-daemon] ${s.id}: receipt check failed: ${err.message}`);
            // Cannot confirm receipt — fall through to age check
          }
        }
      }

      // No receipt (or no tx_hash) — check age
      if (age > PROCESSING_UNRESOLVED_AGE_MS) {
        // 48h elapsed with no on-chain confirmation — force-fail and refund
        console.log(`[settlement-daemon] ${s.id}: processing_unresolved for ${Math.round(age / 3600000)}h with no receipt. Forcing failed + refund.`);
        const releaseLockU3 = await acquireWalletLock(s.wallet.toLowerCase());
        try {
          const { entry: entryU3, source: srcU3 } = resolveEarningsEntry(earnings, { wallet: s.wallet });
          if (srcU3 !== 'new') {
            entryU3.pending_balance += s.amount;
            safeWrite(EARNINGS_FILE, earnings);
          }
        } finally {
          releaseLockU3();
        }
        releaseOrphanedReservation(s.wallet, s.amount);
        appendSettlement({ ...s, status: 'failed', error: 'No receipt after 48h', resolved_at: Date.now() });
        console.log(`[settlement-daemon] ${s.id}: resolved processing_unresolved → failed (timeout 48h).`);
      } else {
        // Still within the 48h grace window — leave as-is
        console.log(`[settlement-daemon] ${s.id}: processing_unresolved ${Math.round(age / 3600000)}h old — still within 48h window, checking next interval.`);
      }
    }
  } finally {
    settlementDaemonRunning = false;
  }
}

// ─── Pipeline Data (must load BEFORE WAL recovery — replayPipelineApprove needs it) ──
const PIPELINES_FILE = path.join(__dirname, 'data', 'pipelines.json');
let pipelineEntries = [];
try { pipelineEntries = JSON.parse(fs.readFileSync(PIPELINES_FILE, 'utf8')); } catch { pipelineEntries = []; }
function savePipelines() {
  const tmp = PIPELINES_FILE + '.tmp';
  writeAndSync(tmp, JSON.stringify(pipelineEntries, null, 2));
  fs.renameSync(tmp, PIPELINES_FILE);
}

// ─── Startup Wiring (AU-6: parallelized) ─────────────────────────────────────
// Phase 1: WAL crash recovery (MUST run synchronously before async settlement ops)
//          — earnings state must be consistent before we touch on-chain state.
const _startupBegin = Date.now();

recoverWalEntries();       // 1a. WAL crash recovery (SPEC-A2 C3)

// --- Withdrawal WAL recovery (SPEC-A1) ---
const pendingWalEntries = getPendingWalEntries();
for (const entry of pendingWalEntries) {
  if (entry.operation === 'withdraw') {
    const { wallet_address, amount, settlement_id, earnings_before } = entry.payload;
    const completed = entry.steps_completed || [];

    if (completed.includes('earnings_deducted') && !completed.includes('settlement_appended')) {
      console.log(`[WAL Recovery] Completing settlement append for ${settlement_id}`);
      appendSettlement({
        id: settlement_id,
        wallet: wallet_address,
        amount,
        status: 'settled',
        note: 'Recovered from WAL — earnings already deducted',
        retry_count: 0,
        timestamp: new Date().toISOString()
      });
      markStepComplete(entry.id, 'settlement_appended');
      commitWal(entry.id);
      commitReservation(wallet_address);
    } else if (completed.includes('settlement_appended') && !completed.includes('earnings_deducted')) {
      console.log(`[WAL Recovery] Completing earnings deduction for ${settlement_id}`);
      // SPEC-P0.5: resolve via wallet index
      const { key: wKey, entry: wEntry, source: wSrc } = resolveEarningsEntry(earnings, { wallet: wallet_address });
      if (wSrc !== 'new') {
        wEntry.total_withdrawn = parseFloat((wEntry.total_withdrawn + amount).toFixed(6));
        wEntry.withdrawal_count = (wEntry.withdrawal_count || 0) + 1;
        safeWrite(EARNINGS_FILE, earnings);
      }
      markStepComplete(entry.id, 'earnings_deducted');
      commitWal(entry.id);
      commitReservation(wallet_address);
    } else if (!completed.includes('earnings_deducted') && !completed.includes('settlement_appended')) {
      console.log(`[WAL Recovery] Releasing reservation for incomplete withdrawal ${settlement_id}`);
      releaseReservation(wallet_address);
      commitWal(entry.id);
    }
  }
}

// Phase 2: Independent async startup tasks — run in parallel (AU-6)
// resolveProcessingSettlements and resolveStuckSettlements target disjoint settlement
// statuses and can safely run concurrently.
// S20-F4 FIX: compactSettlements is moved out of Promise.all into the .then() callback
// so it runs AFTER both recovery functions complete. This eliminates the race where
// compactSettlements could rename SETTLEMENTS_FILE while a recovery function is still
// appending to it, silently discarding appended data.
Promise.all([
  // 2a. Legacy processing/processing_timeout recovery (SPEC-A0)
  resolveProcessingSettlements()
    .then(() => runConsistencyCheck())
    .catch((err) => {
      console.error('[startup] [settlement-recovery] resolveProcessingSettlements failed:', err.message, err.stack);
    }),

  // 2b. C4: pending/retry daemon — first pass on startup
  resolveStuckSettlements()
    .catch((err) => {
      console.error('[startup] [settlement-daemon] resolveStuckSettlements startup pass failed:', err.message, err.stack);
    }),
]).then(() => {
  // 2c. Settlement compaction runs sequentially after both recovery tasks complete.
  // Safe: no concurrent writers to SETTLEMENTS_FILE at this point.
  compactSettlements();
  const elapsed = Date.now() - _startupBegin;
  console.log(`[startup] Parallel startup tasks complete in ${elapsed}ms`);
});

console.log(`[startup] Startup time to server-ready: ${Date.now() - _startupBegin}ms`);

setInterval(() => resolveStuckSettlements().catch((err) => {
  // Non-critical: periodic daemon tick failed. Will retry on next interval.
  console.error('[settlement-daemon] Interval tick failed:', err.message, err.stack);
}), SETTLEMENT_DAEMON_INTERVAL_MS); // AUDIT-06: hourly

// ─── S22-1: OFAC SDN Wallet Screening ────────────────────────────────────────
// Downloads the OFAC SDN list at startup, parses crypto wallet addresses,
// stores in a Set for O(1) lookup. Refreshes every 24 hours.
// No npm dependencies — uses native https module.

const OFAC_SDN_URL = 'https://sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/sdn.csv';
// F-06: Also download alt.csv — the alternate identities file where OFAC places
// Digital Currency Address records that may not appear in the primary sdn.csv.
const OFAC_ALT_URL = 'https://sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/alt.csv';
const OFAC_REQUEST_HEADERS = { 'User-Agent': 'Auxilo-Compliance/1.0 (OFAC-SDN-Check)' };
const OFAC_MAX_REDIRECTS = 5;
const OFAC_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const OFAC_BLOCKS_LOG = path.join(DATA_DIR, 'ofac-blocks.log');

const ofacState = {
  sanctionedAddresses: new Set(),
  lastRefresh: null,
  lastRefreshSuccess: true,
  consecutiveFailures: 0,
  blockCount: 0,
  listSize: 0,
  sdnAddressCount: 0,   // F-06: addresses sourced from sdn.csv
  altAddressCount: 0,   // F-06: addresses sourced from alt.csv
  refreshTimer: null,
};

/**
 * Download and parse the OFAC SDN CSV to extract digital currency addresses.
 * SDN CSV format: each row has fields; digital currency addresses appear as
 * entries with "Digital Currency Address" in the remarks/ID fields.
 * The CSV also has alt/address records with ID Type "Digital Currency Address".
 */
function _downloadSdnList() {
  return _fetchWithRedirects(OFAC_SDN_URL, 'SDN');
}

/**
 * Generic HTTPS GET with User-Agent header and up to OFAC_MAX_REDIRECTS
 * redirect hops (301/302/307/308). Used by both SDN and alt.csv downloads.
 */
function _fetchWithRedirects(url, label, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000, headers: OFAC_REQUEST_HEADERS }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); // drain the redirect response body
        if (redirectCount >= OFAC_MAX_REDIRECTS) {
          reject(new Error(`${label} download exceeded ${OFAC_MAX_REDIRECTS} redirects`));
          return;
        }
        _fetchWithRedirects(res.headers.location, label, redirectCount + 1)
          .then(resolve, reject);
        return;
      }
      _handleSdnResponse(res, resolve, reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`${label} download timeout`)); });
  });
}

function _handleSdnResponse(res, resolve, reject) {
  if (res.statusCode !== 200) {
    reject(new Error(`SDN download HTTP ${res.statusCode}`));
    res.resume(); // drain
    return;
  }
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  res.on('error', reject);
}

// F-06: Download the OFAC alt.csv (alternate identities file).
// Uses shared _fetchWithRedirects helper (User-Agent + multi-hop redirects).
function _downloadAltCsv() {
  return _fetchWithRedirects(OFAC_ALT_URL, 'alt.csv');
}

/**
 * Parse the SDN CSV and extract all crypto wallet addresses.
 * OFAC SDN CSV includes entries with "Digital Currency Address" as the ID type.
 * Wallet addresses appear in fields that look like blockchain addresses.
 * We extract any value that looks like a crypto address (0x hex, base58, etc.)
 * from lines that reference "Digital Currency Address".
 */
function _parseSdnAddresses(csvData) {
  const addresses = new Set();
  const lines = csvData.split('\n');

  // Regex patterns for crypto addresses
  const ethAddrRegex = /\b(0x[0-9a-fA-F]{40})\b/g;
  const btcAddrRegex = /\b([13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g;
  const btcBech32Regex = /\b(bc1[a-zA-HJ-NP-Z0-9]{25,90})\b/g;

  for (const line of lines) {
    // Only process lines that mention digital currency
    if (!line.toLowerCase().includes('digital currency address')) continue;

    // Extract Ethereum-style addresses (0x...)
    let match;
    while ((match = ethAddrRegex.exec(line)) !== null) {
      addresses.add(match[1].toLowerCase());
    }
    // Extract Bitcoin addresses
    while ((match = btcAddrRegex.exec(line)) !== null) {
      addresses.add(match[1]);
    }
    while ((match = btcBech32Regex.exec(line)) !== null) {
      addresses.add(match[1].toLowerCase());
    }
  }

  return addresses;
}

/**
 * Refresh the OFAC SDN list. Downloads both sdn.csv and alt.csv and merges
 * all digital-currency addresses into a single Set. If alt.csv fails, a
 * WARNING is logged but the function still succeeds using sdn.csv data.
 * On total failure, keeps the stale list.
 * After 2 consecutive failures, logs CRITICAL (must not operate without
 * a list for more than 48 hours).
 */
async function refreshOFACList() {
  try {
    console.log('[OFAC] Refreshing SDN list (sdn.csv + alt.csv)...');

    // Always download sdn.csv — required
    const sdnCsv = await _downloadSdnList();
    const sdnAddresses = _parseSdnAddresses(sdnCsv);

    // F-06: Also download alt.csv — optional, log WARNING on failure
    let altAddresses = new Set();
    try {
      const altCsv = await _downloadAltCsv();
      altAddresses = _parseSdnAddresses(altCsv);
      console.log(`[OFAC] alt.csv parsed: ${altAddresses.size} addresses`);
    } catch (altErr) {
      console.warn(`[OFAC] [WARNING] alt.csv download failed: ${altErr.message}. Continuing with sdn.csv data only.`);
    }

    // Merge both sources into one Set
    const addresses = new Set([...sdnAddresses, ...altAddresses]);

    ofacState.sanctionedAddresses = addresses;
    ofacState.lastRefresh = new Date().toISOString();
    ofacState.lastRefreshSuccess = true;
    ofacState.consecutiveFailures = 0;
    ofacState.listSize = addresses.size;
    ofacState.sdnAddressCount = sdnAddresses.size;
    ofacState.altAddressCount = altAddresses.size;

    console.log(`[OFAC] SDN list refreshed: ${addresses.size} total addresses (sdn.csv: ${sdnAddresses.size}, alt.csv: ${altAddresses.size})`);
  } catch (err) {
    ofacState.consecutiveFailures++;
    ofacState.lastRefreshSuccess = false;

    if (ofacState.consecutiveFailures >= 2) {
      console.error(`[OFAC] [CRITICAL] SDN list refresh failed ${ofacState.consecutiveFailures} consecutive times: ${err.message}`);
      console.error('[OFAC] [CRITICAL] Operating with stale sanctions list for >48h. Immediate attention required.');
    } else {
      console.warn(`[OFAC] [WARNING] SDN list refresh failed: ${err.message}. Using stale list.`);
    }
  }
}

/**
 * Check if a wallet address is on the OFAC SDN list.
 * @param {string} walletAddress - The wallet address to check
 * @returns {boolean} true if the address is sanctioned
 *
 * F-07: EVM addresses are case-insensitive (EIP-55 checksum is cosmetic),
 * so we normalize them to lowercase for the lookup. Bitcoin base58 addresses
 * ARE case-sensitive — '1BvBMSEYst...' is a different address from
 * '1bvbmseyst...' — so non-0x addresses are compared in their original case.
 */
function checkOFAC(walletAddress) {
  if (!walletAddress) return false;
  // Only lowercase EVM (0x) addresses; preserve case for Bitcoin base58 etc.
  const normalized = walletAddress.startsWith('0x')
    ? walletAddress.toLowerCase()
    : walletAddress;
  return ofacState.sanctionedAddresses.has(normalized);
}

/**
 * Log an OFAC block event to data/ofac-blocks.log
 */
function logOFACBlock(walletAddress, endpoint) {
  ofacState.blockCount++;
  const entry = `${new Date().toISOString()} | BLOCKED | wallet=${walletAddress} | endpoint=${endpoint}\n`;
  try {
    fs.appendFileSync(OFAC_BLOCKS_LOG, entry);
  } catch (err) {
    console.error(`[OFAC] Failed to write block log: ${err.message}`);
  }
  // Also log to stdout for PM2 capture
  console.warn(`[OFAC] Blocked sanctioned wallet on ${endpoint}`);
}

// Load SDN list at startup (non-blocking — don't prevent server start)
refreshOFACList().catch((err) => {
  console.warn(`[OFAC] [WARNING] Initial SDN list download failed: ${err.message}. Server starting without sanctions list.`);
});

// Refresh every 24 hours
ofacState.refreshTimer = setInterval(() => {
  refreshOFACList().catch((err) => {
    console.error(`[OFAC] Periodic refresh failed: ${err.message}`);
  });
}, OFAC_REFRESH_INTERVAL_MS);
if (ofacState.refreshTimer.unref) ofacState.refreshTimer.unref();

// ── OpenClaw Adapter Daemon ──────────────────────────────────────────────────
const OPENCLAW_DAEMON_INTERVAL_MS = parseInt(process.env.OPENCLAW_INTERVAL_MS) || 3600000;
const OPENCLAW_MEMORY_PATH = process.env.OPENCLAW_MEMORY_PATH || './data/openclaw-memories';
let openclawDaemonRunning = false;
let openclawLastRun = null;
let openclawLastResult = null;
let openclawRuntimeConfig = { ...DEFAULT_ADAPTER_CONFIG };

async function runOpenClawDaemon() {
  if (openclawDaemonRunning) {
    console.log('[openclaw-daemon] Already running, skipping');
    return;
  }
  openclawDaemonRunning = true;
  const startTime = Date.now();
  console.log('[openclaw-daemon] Starting run...');
  try {
    const llmCall = async (prompt) => {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Anthropic API error ${res.status}: ${errText}`);
      }
      const data = await res.json();
      return data.content?.[0]?.text || '';
    };

    const result = await processMemoryFiles({
      memoryPath: OPENCLAW_MEMORY_PATH,
      llmCall,
      config: openclawRuntimeConfig,
    });

    openclawLastRun = new Date().toISOString();
    openclawLastResult = result;
    console.log(`[openclaw-daemon] Complete: ${result.files_processed} files, ${result.total_learnings_extracted} learnings in ${Date.now() - startTime}ms`);
  } catch (err) {
    console.error('[openclaw-daemon] Error:', err.message);
    openclawLastRun = new Date().toISOString();
    openclawLastResult = { success: false, error: err.message };
  } finally {
    openclawDaemonRunning = false;
  }
}

if (process.env.ANTHROPIC_API_KEY) {
  runOpenClawDaemon().catch(err => console.error('[openclaw-daemon] Startup error:', err.message));
  setInterval(() => runOpenClawDaemon().catch(err => console.error('[openclaw-daemon] Interval error:', err.message)), OPENCLAW_DAEMON_INTERVAL_MS);
}

// IR-H-006 FIX: Use crypto.randomUUID() instead of Math.random() for learning IDs
function generateId() {
  return 'lrn_' + crypto.randomUUID();
}

// ─── x402 Payment Gate ───────────────────────────────────────────────

/**
 * Shared payment verification helper.
 * Tries the external facilitator first. On failure (network error or HTTP error),
 * falls back to local on-chain verification via lib/x402-local.js.
 *
 * @param {string} paymentHeader - Raw X-Payment header value
 * @param {number} price_usd - Expected payment amount in USD
 * @param {string} pathname - Request pathname (for facilitator payload)
 * @param {string} amount - Pre-computed micro-USDC amount string
 * @returns {Promise<{ verified: boolean, rateLimited: boolean }>}
 */
async function _verifyPayment(paymentHeader, price_usd, pathname, amount) {
  let verified = false;

  // 1. Try facilitator first (unchanged happy path)
  try {
    const verifyResp = await fetch(FACILITATOR + '/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment: paymentHeader,
        payTo: WALLET,
        maxAmountRequired: amount,
        network: 'eip155:8453',
        resource: pathname,
      })
    });

    if (verifyResp.ok) {
      const result = await verifyResp.json();
      if (result.valid || result.isValid) {
        verified = true;
      }
    } else {
      // Facilitator returned non-OK — fall through to local fallback
      console.warn(`[x402] Facilitator returned ${verifyResp.status}, trying local fallback`);
    }
  } catch (err) {
    // Facilitator unreachable (network error, timeout) — fall through to local fallback
    console.warn(`[x402] Facilitator unreachable: ${err.message}, trying local fallback`);
  }

  // 2. Local fallback (C5 + AUDIT-12)
  if (!verified) {
    const localResult = await verifyPaymentLocally(
      paymentHeader, price_usd, WALLET_ADDRESS, TX_USDC_BASE
    );

    if (localResult.valid) {
      verified = true;
      console.log('[x402] Verified via local fallback' + (localResult.cached ? ' (cache hit)' : ''));
    } else if (localResult.error && localResult.error.includes('rate limit')) {
      // RPC rate limited — signal caller to return 503
      return { verified: false, rateLimited: true };
    }
    // else: local verification rejected the proof — verified stays false
  }

  // S21-1: Transaction hash deduplication — prevent replay attacks across endpoints
  // and after LRU cache expiry. Extract tx hash from payment proof and check/record it.
  if (verified) {
    try {
      const proof = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
      const txHash = proof?.payload?.txHash || proof?.payload?.transaction;
      if (txHash && typeof txHash === 'string') {
        if (!recordTxHash(txHash)) {
          console.warn(`[x402] [S21-1] Replay blocked: tx hash ${txHash} already consumed`);
          return { verified: false, rateLimited: false, replayBlocked: true };
        }
      }
    } catch {
      // If we can't parse the proof to extract the hash, the payment was still verified
      // by the facilitator/local fallback. Log but allow — the facilitator has its own dedup.
      console.warn('[x402] [S21-1] Could not extract tx hash for dedup check');
    }
  }

  return { verified, rateLimited: false };
}

function x402Gate(price_usd, description) {
  const amount = String(Math.round(price_usd * 1_000_000));

  return async (c, next) => {
    const paymentHeader = c.req.header('X-Payment');

    if (!paymentHeader) {
      c.status(402);
      c.header('X-Payment-Required', 'true');
      return c.json({
        x402Version: 2,
        accepts: [{
          scheme: 'exact',
          network: 'eip155:8453',
          maxAmountRequired: amount,
          resource: new URL(c.req.url).pathname,
          description,
          mimeType: 'application/json',
          payTo: WALLET,
          maxTimeoutSeconds: 30,
          asset: USDC_BASE,
          extra: {
            assetTransferMethod: 'eip3009',
            name: 'USD Coin',
            version: '2'
          }
        }]
      });
    }

    const { verified, rateLimited, replayBlocked } = await _verifyPayment(
      paymentHeader, price_usd, new URL(c.req.url).pathname, amount
    );

    if (rateLimited) {
      return c.json({
        error: 'Payment verification temporarily unavailable',
        retry_after: 5
      }, 503);
    }

    // S21-1: Reject replayed transaction hashes
    if (replayBlocked) {
      c.status(402);
      return c.json({ error: 'Payment already used' });
    }

    if (!verified) {
      c.status(402);
      return c.json({
        error: 'Payment verification failed',
        accepts: [{
          scheme: 'exact',
          network: 'eip155:8453',
          maxAmountRequired: amount,
          resource: new URL(c.req.url).pathname,
          description,
          mimeType: 'application/json',
          payTo: WALLET,
          maxTimeoutSeconds: 30,
          asset: USDC_BASE,
          extra: {
            assetTransferMethod: 'eip3009',
            name: 'USD Coin',
            version: '2'
          }
        }]
      });
    }

    await next();
  };
}

// ─── Dynamic Payment Verification (for routes where price isn't known at registration) ──
async function verifyPaymentOrReject(c, price_usd, description) {
  const amount = String(Math.round(price_usd * 1_000_000));
  const paymentHeader = c.req.header('X-Payment');

  if (!paymentHeader) {
    c.status(402);
    c.header('X-Payment-Required', 'true');
    return c.json({
      x402Version: 2,
      accepts: [{
        scheme: 'exact',
        network: 'eip155:8453',
        maxAmountRequired: amount,
        resource: new URL(c.req.url).pathname,
        description,
        mimeType: 'application/json',
        payTo: WALLET,
        maxTimeoutSeconds: 30,
        asset: USDC_BASE,
        extra: {
          assetTransferMethod: 'eip3009',
          name: 'USD Coin',
          version: '2'
        }
      }]
    });
  }

  const { verified, rateLimited, replayBlocked } = await _verifyPayment(
    paymentHeader, price_usd, new URL(c.req.url).pathname, amount
  );

  if (rateLimited) {
    return c.json({
      error: 'Payment verification temporarily unavailable',
      retry_after: 5
    }, 503);
  }

  // S21-1: Reject replayed transaction hashes
  if (replayBlocked) {
    c.status(402);
    return c.json({ error: 'Payment already used' });
  }

  if (!verified) {
    c.status(402);
    return c.json({
      error: 'Payment verification failed',
      accepts: [{
        scheme: 'exact',
        network: 'eip155:8453',
        maxAmountRequired: amount,
        resource: new URL(c.req.url).pathname,
        description,
        mimeType: 'application/json',
        payTo: WALLET,
        maxTimeoutSeconds: 30,
        asset: USDC_BASE,
        extra: {
          assetTransferMethod: 'eip3009',
          name: 'USD Coin',
          version: '2'
        }
      }]
    });
  }

  return null; // null = payment OK, proceed
}

// ── Dual Auth: x402 OR API Key (SPEC-P0.2) ─────────────────────────────────

function dualAuth(price_usd, description, creditType, requiredScope) {
    const x402Middleware = x402Gate(price_usd, description);
    return async (c, next) => {
        // Fix 4: X-API-Key takes precedence; Authorization: Bearer is the fallback
        let apiKey = c.req.header('X-API-Key');
        if (!apiKey) {
            const authHeader = c.req.header('Authorization') || '';
            if (authHeader.startsWith('Bearer ')) apiKey = authHeader.slice(7);
        }
        const payment = c.req.header('X-Payment');

        // Path 1: API key present -- validate and bypass x402
        if (apiKey) {
            const result = validateApiKey(apiKey);
            if (!result.valid) {
                return c.json({ error: 'Invalid API key' }, 401);
            }

            // Scope enforcement: admin supersedes all scopes
            if (requiredScope && result.scope !== 'admin' && result.scope !== requiredScope) {
                return c.json({ error: 'API key scope insufficient', required: requiredScope, actual: result.scope }, 403);
            }

            c.set('accountId', result.accountId);
            c.set('authMethod', 'api_key');
            c.set('keyLabel', result.key_label || 'default');

            // Update last_used_at for the key (best-effort, non-blocking)
            if (result.key_index >= 0) {
                try {
                    const _accts = loadAccounts();
                    const _acct  = _accts[result.accountId];
                    if (_acct && _acct.api_keys && _acct.api_keys[result.key_index]) {
                        _acct.api_keys[result.key_index].last_used_at = new Date().toISOString();
                        saveAccounts(_accts);
                    }
                } catch { /* non-fatal */ }
            }

            // Credit check (Phase 0.3)
            if (creditType) {
                const creditResult = await deductCredit(result.accountId, creditType);
                if (!creditResult.success) {
                    return c.json({
                        error: 'Credits exhausted',
                        message: creditResult.message,
                        credits: creditResult.status,
                        options: {
                            x402_payment: {
                                header: 'X-Payment',
                                price_usd,
                                description,
                                protocol: 'x402 (https://www.x402.org)'
                            },
                            reset_at: creditResult.status.period_end
                        }
                    }, 402);
                }
            }

            return next();
        }

        // Path 2: x402 payment present -- delegate to existing x402Gate
        if (payment) {
            return x402Middleware(c, next);
        }

        // Path 3: Neither -- 401 with both options
        return c.json({
            error: 'Authentication required',
            message: 'This endpoint requires either an API key or x402 payment.',
            options: {
                api_key: {
                    header: 'X-API-Key',
                    format: 'axl_XXX',
                    obtain: 'POST /auth/magic-link -> GET /auth/verify -> POST /account/api-keys'
                },
                x402_payment: {
                    header: 'X-Payment',
                    price_usd: price_usd,
                    description: description,
                    protocol: 'x402 (https://www.x402.org)'
                }
            }
        }, 401);
    };
}

// ── Optional Auth: extract API key if present, but don't require auth or payment ──
// Used for free discovery/search endpoints that benefit from knowing the caller
function optionalAuth() {
    return async (c, next) => {
        let apiKey = c.req.header('X-API-Key');
        if (!apiKey) {
            const authHeader = c.req.header('Authorization') || '';
            if (authHeader.startsWith('Bearer ')) apiKey = authHeader.slice(7);
        }
        if (apiKey) {
            const result = validateApiKey(apiKey);
            if (result.valid) {
                c.set('accountId', result.accountId);
                c.set('authMethod', 'api_key');
                c.set('keyLabel', result.key_label || 'default');
                // Update last_used_at (best-effort)
                if (result.key_index >= 0) {
                    try {
                        const _accts = loadAccounts();
                        const _acct  = _accts[result.accountId];
                        if (_acct && _acct.api_keys && _acct.api_keys[result.key_index]) {
                            _acct.api_keys[result.key_index].last_used_at = new Date().toISOString();
                            saveAccounts(_accts);
                        }
                    } catch { /* non-fatal */ }
                }
            }
        }
        return next();
    };
}

async function dualAuthDynamic(c, price_usd, description, creditType, requiredScope) {
    // Fix: X-API-Key takes precedence; Authorization: Bearer is the fallback
    let apiKey = c.req.header('X-API-Key');
    if (!apiKey) {
        const authHeader = c.req.header('Authorization') || '';
        if (authHeader.startsWith('Bearer ')) apiKey = authHeader.slice(7);
    }
    const payment = c.req.header('X-Payment');

    // Path 1: API key
    if (apiKey) {
        const result = validateApiKey(apiKey);
        if (!result.valid) {
            return c.json({ error: 'Invalid API key' }, 401);
        }

        // Scope enforcement: admin supersedes all scopes
        if (requiredScope && result.scope !== 'admin' && result.scope !== requiredScope) {
            return c.json({ error: 'API key scope insufficient', required: requiredScope, actual: result.scope }, 403);
        }

        c.set('accountId', result.accountId);
        c.set('authMethod', 'api_key');
        c.set('keyLabel', result.key_label || 'default');

        // Update last_used_at for the key (best-effort, non-blocking)
        if (result.key_index >= 0) {
            try {
                const _accts = loadAccounts();
                const _acct  = _accts[result.accountId];
                if (_acct && _acct.api_keys && _acct.api_keys[result.key_index]) {
                    _acct.api_keys[result.key_index].last_used_at = new Date().toISOString();
                    saveAccounts(_accts);
                }
            } catch { /* non-fatal */ }
        }

        // Credit check (Phase 0.3)
        if (creditType) {
            const creditResult = await deductCredit(result.accountId, creditType);
            if (!creditResult.success) {
                return c.json({
                    error: 'Credits exhausted',
                    message: creditResult.message,
                    credits: creditResult.status,
                    options: {
                        x402_payment: {
                            header: 'X-Payment',
                            price_usd,
                            description,
                            protocol: 'x402 (https://www.x402.org)'
                        },
                        reset_at: creditResult.status.period_end
                    }
                }, 402);
            }
        }

        return null;  // Same contract as verifyPaymentOrReject
    }

    // Path 2: x402 payment
    if (payment) {
        return verifyPaymentOrReject(c, price_usd, description);
    }

    // Path 3: Neither
    return c.json({
        error: 'Authentication required',
        message: 'This endpoint requires either an API key or x402 payment.',
        options: {
            api_key: {
                header: 'X-API-Key',
                format: 'axl_XXX',
                obtain: 'POST /auth/magic-link -> GET /auth/verify -> POST /account/api-keys'
            },
            x402_payment: {
                header: 'X-Payment',
                price_usd: price_usd,
                description: description,
                protocol: 'x402 (https://www.x402.org)'
            }
        }
    }, 401);
}

const MIN_UNLOCK_PRICE = 0.05;     // approved pricing floor — matches lib/pricing.js (GTM-2 fix, PUNCH-LIST §17)
const MAX_UNLOCK_PRICE = 50.00;    // above this, hire a consultant (Change 7)
const DEFAULT_UNLOCK_PRICE = 0.08; // moderate complexity, moderate quality baseline (Change 7)

// ── Revenue Share Constants ───────────────────────────────────────────────────
// Standard: 70% contributor / 30% platform
// Discovery-driven (search-originated): 60% contributor / 40% platform
const CONTRIBUTOR_SHARE_STANDARD = 0.7;
const CONTRIBUTOR_SHARE_DISCOVERY = 0.6;

// ─── getCatalogStats (Change 7) ─────────────────────────────────────────────
function getCatalogStats() {
    const total = learnings.length;
    const categoryCounts = {};
    for (const l of learnings) {
        if (l && l.category) {
            categoryCounts[l.category] = (categoryCounts[l.category] || 0) + 1;
        }
    }
    return { total, categoryCounts };
}

// ─── Search/Match Engine ─────────────────────────────────────────────
function matchSkills(query, filters = {}) {
  const q = query.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(t => t.length > 1);

  let results = skills.map(skill => {
    let score = 0;
    const deps = skill.dependencies || {};
    const searchable = [
      skill.name,
      skill.description,
      ...skill.tags,
      skill.category,
      ...(deps.bins || []),
      ...(deps.apis || []),
      ...(deps.auth || []),
      ...(deps.runtime || [])
    ].join(' ').toLowerCase();

    // IR-M-005 FIX: Use named SCORING constants instead of inline magic numbers
    if (searchable.includes(q)) score += SCORING.EXACT_PHRASE_BOOST;

    // Individual token matches
    for (const token of tokens) {
      if (skill.name.toLowerCase().includes(token)) score += SCORING.TITLE_TOKEN_WEIGHT;
      if (skill.description.toLowerCase().includes(token)) score += SCORING.BODY_TOKEN_WEIGHT;
      if (skill.tags.some(t => t.toLowerCase().includes(token))) score += SCORING.TAG_TOKEN_WEIGHT;
      if (skill.category.toLowerCase().includes(token)) score += SCORING.CATEGORY_TOKEN_WEIGHT;
    }

    return { ...skill, _score: score };
  });

  // Apply filters
  if (filters.category) {
    results = results.filter(r => r.category === filters.category);
  }
  if (filters.type) {
    results = results.filter(r => r.type === filters.type);
  }
  if (filters.pricing) {
    results = results.filter(r => r.pricing.model === filters.pricing);
  }

  // Sort by score, filter out zeros
  return results
    .filter(r => r._score > 0)
    .sort((a, b) => b._score - a._score)
    .map(({ _score, ...skill }) => ({ ...skill, relevance: _score }));
}

// ─── Knowledge Search/Match Engine ──────────────────────────────────

// IR-M-005 FIX: Named scoring constants — no more inline magic numbers
const SCORING = Object.freeze({
  UNLOCK_WEIGHT:           2,     // Points per unlock
  UNLOCK_CAP:              40,    // Max contribution from unlocks
  HELPFULNESS_MULTIPLIER:  8,     // Scale factor for avg helpfulness (0-5 → 0-40)
  DEFAULT_HELPFULNESS:     2.5,   // When no helpfulness scores exist
  RATING_CAP:              20,    // Max contribution from raw rating count
  RECENCY_DECAY_PER_DAY:   0.05,  // Points lost per day since creation
  RECENCY_PENALTY_CAP:     10,    // Max recency penalty
  EXACT_PHRASE_BOOST:      10,    // Score boost for exact phrase match
  TITLE_TOKEN_WEIGHT:      5,     // Per-token boost for title matches
  BODY_TOKEN_WEIGHT:       3,     // Per-token boost for body/description matches
  TAG_TOKEN_WEIGHT:        4,     // Per-token boost for tag matches
  CONTEXT_TOKEN_WEIGHT:    3,     // Per-token boost for task_context matches
  CATEGORY_TOKEN_WEIGHT:   2,     // Per-token boost for category matches
  TEXT_SCORE_MULTIPLIER:   10,    // Multiplier to weight text relevance vs quality
});

function computeScore(learning) {
  const q = learning.quality;
  const ageDays = (Date.now() - new Date(learning.created_at).getTime()) / 86400000;
  const unlockSignal = Math.min((q.unlocks || 0) * SCORING.UNLOCK_WEIGHT, SCORING.UNLOCK_CAP);
  const helpScores = q.helpfulness_scores || [];
  const avgHelp = helpScores.length > 0
    ? helpScores.reduce((a, b) => a + b, 0) / helpScores.length
    : SCORING.DEFAULT_HELPFULNESS;
  const helpSignal = avgHelp * SCORING.HELPFULNESS_MULTIPLIER;
  const ratingVolume = Math.min((q.ratings || 0), SCORING.RATING_CAP);
  const recencyPenalty = Math.min(ageDays * SCORING.RECENCY_DECAY_PER_DAY, SCORING.RECENCY_PENALTY_CAP);
  return unlockSignal + helpSignal + ratingVolume - recencyPenalty;
}

function matchLearnings(query, filters = {}) {
  const q = query.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(t => t.length > 1);

  // S21-2: When content moderation is enabled, exclude non-approved learnings from results.
  // Legacy learnings without a status field are treated as 'approved' for backward compatibility.
  const visibleLearnings = CONTENT_MODERATION_ENABLED
    ? learnings.filter(l => !l.status || l.status === 'approved')
    : learnings;

  let results = visibleLearnings.map(learning => {
    let textScore = 0;
    const searchable = [
      learning.title,
      learning.body,
      ...learning.tags,
      learning.category,
      learning.task_context
    ].join(' ').toLowerCase();

    // IR-M-005 FIX: Use named SCORING constants instead of inline magic numbers
    if (searchable.includes(q)) textScore += SCORING.EXACT_PHRASE_BOOST;
    for (const token of tokens) {
      if (learning.title.toLowerCase().includes(token)) textScore += SCORING.TITLE_TOKEN_WEIGHT;
      if (learning.body.toLowerCase().includes(token)) textScore += SCORING.BODY_TOKEN_WEIGHT;
      if (learning.tags.some(t => t.toLowerCase().includes(token))) textScore += SCORING.TAG_TOKEN_WEIGHT;
      if (learning.task_context.toLowerCase().includes(token)) textScore += SCORING.CONTEXT_TOKEN_WEIGHT;
    }

    const qualityScore = computeScore(learning);
    return { ...learning, _score: (textScore * SCORING.TEXT_SCORE_MULTIPLIER) + qualityScore, _textScore: textScore };
  });

  if (filters.category) results = results.filter(r => r.category === filters.category);
  if (filters.outcome) results = results.filter(r => r.outcome === filters.outcome);
  if (filters.related_skill) results = results.filter(r =>
    r.related_skills && r.related_skills.includes(filters.related_skill)
  );

  return results
    .filter(r => r._textScore > 0)
    .sort((a, b) => b._score - a._score)
    .map(({ _score, _textScore, body, ...rest }) => ({
      ...rest,
      relevance: _score
      // NOTE: body is intentionally excluded — agents must unlock to read it
    }));
}

// ─── AU-7: In-Memory Cache (accounts + settlements) ─────────────────────────
// Simple Map-based TTL cache — no external dependencies.
// TTL: 60s for accounts, 30s for settlements.
// Invalidation: clear relevant entry on write (create/update account, new settlement).

const ACCOUNT_CACHE_TTL_MS  = 60 * 1000;  // 60 seconds
const SETTLEMENT_CACHE_TTL_MS = 30 * 1000; // 30 seconds

// Cache store: Map<key, { value, expiresAt }>
const accountCache    = new Map();
const settlementCache = new Map();

// Cache counters (exposed via /stats)
const cacheStats = {
  accounts:    { hits: 0, misses: 0 },
  settlements: { hits: 0, misses: 0 },
};

function cacheGet(store, key, statsKey) {
  const entry = store.get(key);
  if (!entry) { cacheStats[statsKey].misses++; return null; }
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    cacheStats[statsKey].misses++;
    return null;
  }
  cacheStats[statsKey].hits++;
  return entry.value;
}

function cacheSet(store, key, value, ttlMs) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function cacheInvalidate(store, key) {
  store.delete(key);
}

// Convenience wrappers
function getCachedAccount(accountId) {
  return cacheGet(accountCache, accountId, 'accounts');
}
function setCachedAccount(accountId, data) {
  cacheSet(accountCache, accountId, data, ACCOUNT_CACHE_TTL_MS);
}
function invalidateCachedAccount(accountId) {
  cacheInvalidate(accountCache, accountId);
}

function getCachedSettlement(settlementId) {
  return cacheGet(settlementCache, settlementId, 'settlements');
}
function setCachedSettlement(settlementId, data) {
  cacheSet(settlementCache, settlementId, data, SETTLEMENT_CACHE_TTL_MS);
}
function invalidateCachedSettlement(settlementId) {
  cacheInvalidate(settlementCache, settlementId);
}

// Sweep expired entries every 5 minutes (shared cleanup interval)
const cacheCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of accountCache)    { if (now > v.expiresAt) accountCache.delete(k); }
  for (const [k, v] of settlementCache) { if (now > v.expiresAt) settlementCache.delete(k); }
}, 5 * 60 * 1000);
cacheCleanupInterval.unref();

// ─── AU-8: Per-API-Key Rate Limiter ──────────────────────────────────────────
// Sliding window implementation — pure in-memory, no external dependencies.
// Limits apply per API key (not per IP). x402 callers have their own limiter below.
//
// Limits:
//   /discover            → 100 req/min
//   /skill/:id           → 200 req/min
//   /learn, /knowledge   → 50  req/min
//   /extract             → 20  req/min
//
// Headers added to every response: X-RateLimit-Limit, X-RateLimit-Remaining,
//   X-RateLimit-Reset (Unix epoch seconds).
// Exempt: /health, /stats, /categories and all other public/free endpoints.

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute sliding window

// Endpoint-to-limit map (pattern → max requests per window)
const RATE_LIMIT_CONFIG = {
  '/discover':  100,
  '/skill':     200,  // matches /skill/:id
  '/learn':      50,
  '/knowledge':  50,  // matches /knowledge POST
  '/extract':    20,
};

// Store: Map<apiKey, Map<endpointPattern, number[]>>
// Inner array holds timestamps (ms) of requests within the current window.
const apiKeyRateLimitStore = new Map();

// ─── Fix 3: x402 Per-Wallet Rate Limiter ─────────────────────────────────────
// Separate sliding window for x402 callers, keyed by wallet address.
// Limit: 1000 requests per minute per wallet (generous but prevents abuse).
// Store: Map<walletAddress, number[]> (timestamps in ms)
const X402_WALLET_RATE_LIMIT = 1000;
const x402WalletRateLimitStore = new Map();

function checkX402WalletRateLimit(walletAddress) {
  const limit = X402_WALLET_RATE_LIMIT;
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  if (!x402WalletRateLimitStore.has(walletAddress)) {
    x402WalletRateLimitStore.set(walletAddress, []);
  }
  const timestamps = x402WalletRateLimitStore.get(walletAddress);

  // Slide the window
  const trimmed = timestamps.filter(ts => ts > windowStart);
  x402WalletRateLimitStore.set(walletAddress, trimmed);

  const remaining = limit - trimmed.length;
  const resetAt = Math.ceil((windowStart + RATE_LIMIT_WINDOW_MS) / 1000);

  if (trimmed.length >= limit) {
    return { allowed: false, limit, remaining: 0, resetAt };
  }

  trimmed.push(now);
  return { allowed: true, limit, remaining: remaining - 1, resetAt };
}

/**
 * Returns the rate limit config key for a given pathname, or null if exempt.
 */
function getRateLimitPattern(pathname) {
  if (pathname === '/discover')  return '/discover';
  if (pathname === '/learn')     return '/learn';
  if (pathname === '/extract')   return '/extract';
  if (pathname === '/knowledge') return '/knowledge'; // POST /knowledge
  if (pathname.startsWith('/skill/')) return '/skill';
  return null; // exempt
}

/**
 * Check and record a request for the given API key + endpoint pattern.
 * Returns { allowed, limit, remaining, resetAt } where resetAt is epoch seconds.
 */
function checkApiKeyRateLimit(apiKey, pattern) {
  const limit = RATE_LIMIT_CONFIG[pattern];
  const now = Date.now();

  if (!apiKeyRateLimitStore.has(apiKey)) {
    apiKeyRateLimitStore.set(apiKey, new Map());
  }
  const keyStore = apiKeyRateLimitStore.get(apiKey);

  if (!keyStore.has(pattern)) {
    keyStore.set(pattern, []);
  }
  const timestamps = keyStore.get(pattern);

  // Slide the window: remove timestamps older than 1 minute
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  while (timestamps.length > 0 && timestamps[0] <= windowStart) {
    timestamps.shift();
  }

  const remaining = limit - timestamps.length;
  // Reset time = oldest request in window + window size, or 1 minute from now
  const resetAt = timestamps.length > 0
    ? Math.ceil((timestamps[0] + RATE_LIMIT_WINDOW_MS) / 1000)
    : Math.ceil((now + RATE_LIMIT_WINDOW_MS) / 1000);

  if (timestamps.length >= limit) {
    // Rate limited — do NOT add timestamp (don't penalise for the rejected req)
    return { allowed: false, limit, remaining: 0, resetAt };
  }

  timestamps.push(now);
  return { allowed: true, limit, remaining: remaining - 1, resetAt };
}

/**
 * Hono middleware: applies per-API-key rate limiting to paid endpoints.
 * Must be called after dualAuth sets 'accountId' / 'authMethod' on context.
 * Only fires when authMethod === 'api_key'; x402 callers pass through.
 */
function apiKeyRateLimitMiddleware(patternHint) {
  return async (c, next) => {
    const authMethod = c.get('authMethod');

    // Fix 3: x402 callers get their own per-wallet rate limit
    if (authMethod !== 'api_key') {
      const wallet = c.get('walletAddress') || c.req.header('X-Wallet-Address') || '';
      if (wallet) {
        const { allowed, limit, remaining, resetAt } = checkX402WalletRateLimit(wallet);
        c.header('X-RateLimit-Limit',     String(limit));
        c.header('X-RateLimit-Remaining', String(Math.max(0, remaining)));
        c.header('X-RateLimit-Reset',     String(resetAt));
        if (!allowed) {
          c.header('Retry-After', String(resetAt - Math.floor(Date.now() / 1000)));
          return c.json({
            error: 'Too Many Requests',
            message: `Rate limit of ${limit} requests/minute exceeded for this wallet.`,
            retry_after: resetAt - Math.floor(Date.now() / 1000),
          }, 429);
        }
      }
      // Unauthenticated caller (no API key, no wallet) — apply per-IP rate limit
      // to prevent catalog scraping on search endpoints.
      const unauthIp = getClientIp(c);
      if (isSearchUnauthRateLimited(unauthIp)) {
        return c.json({ error: 'Rate limit exceeded', retry_after: 60 }, 429);
      }
      return next();
    }

    const apiKey = c.req.header('X-API-Key') || '';
    const pathname = new URL(c.req.url).pathname;
    const pattern = patternHint || getRateLimitPattern(pathname);

    if (!pattern) return next(); // endpoint is exempt

    const { allowed, limit, remaining, resetAt } = checkApiKeyRateLimit(apiKey, pattern);

    // Always attach rate limit headers
    c.header('X-RateLimit-Limit',     String(limit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, remaining)));
    c.header('X-RateLimit-Reset',     String(resetAt));

    if (!allowed) {
      c.header('Retry-After', String(resetAt - Math.floor(Date.now() / 1000)));
      return c.json({
        error: 'Too Many Requests',
        message: `Rate limit of ${limit} requests/minute exceeded for this API key.`,
        retry_after: resetAt - Math.floor(Date.now() / 1000),
      }, 429);
    }

    return next();
  };
}

// Evict expired window entries every 5 minutes to prevent memory leak (AU-8 requirement)
const rateLimiterCleanupInterval = setInterval(() => {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  for (const [apiKey, keyStore] of apiKeyRateLimitStore) {
    for (const [pattern, timestamps] of keyStore) {
      // Remove stale timestamps
      const trimmed = timestamps.filter(ts => ts > windowStart);
      if (trimmed.length === 0) {
        keyStore.delete(pattern);
      } else {
        keyStore.set(pattern, trimmed);
      }
    }
    if (keyStore.size === 0) {
      apiKeyRateLimitStore.delete(apiKey);
    }
  }
}, 5 * 60 * 1000);
rateLimiterCleanupInterval.unref();

// ─── Phase 0.1: Account Routes (SPEC-P0.1) ──────────────────────────────────
setupAccountRoutes(app);

// ── GET /account/api-keys — list key metadata (D2: scoped keys) ──────────────
app.get('/account/api-keys', requireAuth, (c) => {
  const account = loadAccounts()[c.get('accountId')];
  if (!account) return c.json({ error: 'Account not found' }, 404);
  migrateToApiKeysArray(account);

  return c.json({
    keys: (account.api_keys || []).map(k => ({
      label:        k.label || k.name || 'default',
      created_at:   k.created_at,
      last_used_at: k.last_used_at || null,
      active:       k.active !== false,
      scope:        k.scope || 'admin',
      hash_prefix:  k.hash ? k.hash.slice(0, 8) + '...' : null,
    })),
  });
});

// ── DELETE /account/api-keys/:label — revoke a key by label (D2) ─────────────
app.delete('/account/api-keys/:label', requireAuth, (c) => {
  const label    = c.req.param('label');
  const accts    = loadAccounts();
  const account  = accts[c.get('accountId')];
  if (!account) return c.json({ error: 'Account not found' }, 404);
  migrateToApiKeysArray(account);

  const key = account.api_keys.find(k => (k.label || k.name) === label && k.active !== false);
  if (!key) return c.json({ error: 'Key not found' }, 404);

  // Cannot delete last active key
  const activeCount = account.api_keys.filter(k => k.active !== false).length;
  if (activeCount <= 1) {
    return c.json({ error: 'Cannot delete last active key' }, 400);
  }

  key.active = false;
  const { removeFromKeyIndex } = require('./lib/accounts.js');
  removeFromKeyIndex(key.hash);
  saveAccounts(accts);

  return c.json({ message: 'Key revoked', label });
});

// ─── Device Code Login Flow (Change 3) ───────────────────────────────────────────
app.post('/auth/device', async (c) => {
  const userCode = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 8);
  const baseUrl = process.env.BASE_URL || `https://${c.req.header('host')}`;
  deviceCodeStore.set(userCode, {
    status: 'pending',
    created_at: Date.now(),
  });
  return c.json({
    user_code: userCode,
    verification_url: `${baseUrl}/auth/device/verify?code=${userCode}`,
    expires_in: 600,
    interval: 5,
  });
});

app.get('/auth/device/status', (c) => {
  const code = c.req.query('code');
  if (!code) return c.json({ error: 'code query parameter is required' }, 400);
  const entry = deviceCodeStore.get(code);
  if (!entry) return c.json({ error: 'Unknown device code' }, 404);
  if (Date.now() - entry.created_at > DEVICE_CODE_TTL) {
    deviceCodeStore.delete(code);
    return c.json({ status: 'expired' });
  }
  if (entry.status === 'authorized') {
    return c.json({
      status: 'authorized',
      api_key: entry.api_key,
      account_id: entry.account_id,
      email: entry.email,
    });
  }
  return c.json({ status: 'pending' });
});

app.get('/auth/device/verify', (c) => {
  const code = c.req.query('code');
  const baseUrl = process.env.BASE_URL || `https://${c.req.header('host')}`;
  if (!code) return c.text('Missing code parameter', 400);
  const entry = deviceCodeStore.get(code);
  if (!entry || Date.now() - entry.created_at > DEVICE_CODE_TTL) {
    return c.html('<html><body><h1>Code expired or invalid</h1><p>Please request a new device code.</p></body></html>', 404);
  }
  if (entry.status === 'authorized') {
    return c.html('<html><body><h1>Already Authorized</h1><p>This device code has already been authorized. You can close this window.</p></body></html>');
  }
  // Serve minimal HTML page for device authorization
  return c.html(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Auxilo Device Login</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 420px; margin: 60px auto; padding: 0 20px; }
  h1 { font-size: 1.4em; }
  .code { font-size: 2em; font-weight: bold; letter-spacing: 4px; color: #2563eb; margin: 16px 0; }
  input { width: 100%; padding: 10px; margin: 8px 0; border: 1px solid #ccc; border-radius: 6px; font-size: 1em; box-sizing: border-box; }
  button { width: 100%; padding: 12px; background: #2563eb; color: #fff; border: none; border-radius: 6px; font-size: 1em; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .status { margin-top: 16px; padding: 10px; border-radius: 6px; }
  .success { background: #dcfce7; color: #166534; }
  .error { background: #fef2f2; color: #991b1b; }
  .info { background: #dbeafe; color: #1e40af; }
  #step2 { display: none; }
</style>
</head><body>
<h1>Authorize Device</h1>
<p>Confirm this code matches what your terminal shows:</p>
<div class="code">${code}</div>
<div id="step1">
  <p>Enter your email to receive a magic link:</p>
  <input type="email" id="email" placeholder="you@example.com" />
  <button onclick="sendMagicLink()">Send Magic Link</button>
  <div id="status1"></div>
</div>
<div id="step2">
  <p>Check your email and click the magic link. Then paste the JWT token here:</p>
  <input type="text" id="jwt" placeholder="Paste JWT token from magic link" />
  <button onclick="authorize()">Authorize Device</button>
  <div id="status2"></div>
</div>
<script>
async function sendMagicLink() {
  const email = document.getElementById('email').value.trim();
  if (!email) { show('status1', 'Please enter an email', 'error'); return; }
  try {
    const resp = await fetch('${baseUrl}/auth/magic-link', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await resp.json();
    show('status1', data.message || 'Check your email for the magic link.', 'success');
    document.getElementById('step2').style.display = 'block';
  } catch (err) { show('status1', 'Failed to send: ' + err.message, 'error'); }
}
async function authorize() {
  const jwt = document.getElementById('jwt').value.trim();
  if (!jwt) { show('status2', 'Please paste your JWT token', 'error'); return; }
  try {
    const resp = await fetch('${baseUrl}/auth/device/authorize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '${code}', session_token: jwt })
    });
    const data = await resp.json();
    if (resp.ok) {
      show('status2', 'Device authorized! You can close this window.', 'success');
    } else {
      show('status2', data.error || 'Authorization failed', 'error');
    }
  } catch (err) { show('status2', 'Failed: ' + err.message, 'error'); }
}
function show(id, msg, cls) {
  const el = document.getElementById(id);
  el.className = 'status ' + cls;
  el.textContent = msg;
}
</script>
</body></html>`);
});

app.post('/auth/device/authorize', async (c) => {
  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const { code, session_token } = body || {};
  if (!code || !session_token) {
    return c.json({ error: 'code and session_token are required' }, 400);
  }
  const entry = deviceCodeStore.get(code);
  if (!entry) return c.json({ error: 'Unknown device code' }, 404);
  if (Date.now() - entry.created_at > DEVICE_CODE_TTL) {
    deviceCodeStore.delete(code);
    return c.json({ error: 'Device code expired' }, 410);
  }
  if (entry.status === 'authorized') {
    return c.json({ status: 'authorized', message: 'Already authorized' }, 409);
  }
  // Verify JWT
  const { jwtVerify } = require('jose');
  const { SESSION_SECRET } = process.env;
  if (!SESSION_SECRET) return c.json({ error: 'Server not configured for sessions' }, 500);
  let payload;
  try {
    const secret = Buffer.from(SESSION_SECRET);
    const result = await jwtVerify(session_token, secret, { algorithms: ['HS256'] });
    payload = result.payload;
  } catch {
    return c.json({ error: 'Invalid or expired session token' }, 401);
  }
  if (!payload || !payload.accountId) {
    return c.json({ error: 'Invalid session token' }, 401);
  }
  // Generate a scoped API key (contribute scope) for the account
  const { loadAccounts, saveAccounts } = (() => {
    const accts = require('./lib/accounts.js');
    // loadAccounts and saveAccounts are not exported, so we inline the logic
    const acctData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'accounts.json'), 'utf8'));
    return {
      loadAccounts: () => acctData,
      saveAccounts: (d) => {
        const tmp = path.join(__dirname, 'data', 'accounts.json.tmp');
        fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
        fs.renameSync(tmp, path.join(__dirname, 'data', 'accounts.json'));
      }
    };
  })();
  const deviceAccounts = loadAccounts();
  const account = deviceAccounts[payload.accountId];
  if (!account) return c.json({ error: 'Account not found' }, 404);
  // Create contribute-scoped key
  const rawKey = 'axl_c_' + crypto.randomBytes(24).toString('base64url');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyId = 'key_' + crypto.randomBytes(4).toString('hex');
  account.api_keys.push({
    id: keyId,
    hash: keyHash,
    name: 'Device Login Key',
    scope: 'contribute',
    created_at: Date.now(),
  });
  saveAccounts(deviceAccounts);
  // Also update in-memory accounts if needed
  accounts = deviceAccounts;
  // Update device code store
  entry.status = 'authorized';
  entry.api_key = rawKey;
  entry.account_id = payload.accountId;
  entry.email = payload.email || account.email;
  return c.json({ status: 'authorized' });
});

// ── GET /account/credits (Phase 0.3) ──────────────────────────────────────
app.get('/account/credits', requireAuth, (c) => {
    const accountId = c.get('accountId');
    const status = getCreditStatus(accountId);
    return c.json(status);
});

// ── POST /checkout/session (Phase 0.4 — Stripe) ────────────────────────────
app.post('/checkout/session', requireAuth, async (c) => {
    let body;
    try { body = await c.req.json(); } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { pack } = body || {};
    if (!pack || !PACKS[pack]) {
        return c.json({
            error: 'Invalid pack',
            valid_packs: Object.keys(PACKS).map(k => ({
                id: k,
                price_usd: PACKS[k].price_usd,
                queries: PACKS[k].queries,
                unlocks: PACKS[k].unlocks,
            })),
        }, 400);
    }

    const accountId = c.get('accountId');
    const baseUrl = process.env.BASE_URL || `https://${c.req.header('host')}`;

    try {
        const session = await createCheckoutSession(accountId, pack, baseUrl);
        return c.json(session);
    } catch (err) {
        console.error('[stripe] Checkout session error:', err.message);
        if (err.message === 'Stripe not configured') {
            return c.json({ error: 'Payment system unavailable' }, 503);
        }
        return c.json({ error: 'Failed to create checkout session' }, 500);
    }
});

// ── POST /webhook/stripe (Phase 0.4 — Stripe Webhook) ──────────────────────
// IMPORTANT: This route must receive the raw body for signature verification.
// Hono's default JSON parsing must be bypassed.
app.post('/webhook/stripe', async (c) => {
    const signature = c.req.header('stripe-signature');
    if (!signature) {
        return c.json({ error: 'Missing stripe-signature header' }, 400);
    }

    let rawBody;
    try {
        rawBody = await c.req.text();
    } catch {
        return c.json({ error: 'Could not read request body' }, 400);
    }

    let event;
    try {
        event = verifyWebhookSignature(rawBody, signature);
    } catch (err) {
        console.warn('[stripe] Webhook signature verification failed:', err.message);
        return c.json({ error: 'Invalid signature' }, 400);
    }

    // Process event types
    if (event.type === 'checkout.session.completed') {

    const session = event.data.object;
    const metadata = session.metadata || {};
    const { account_id, pack_id, pack_queries, pack_unlocks } = metadata;

    if (!account_id || !pack_id) {
        console.warn('[stripe] Webhook missing metadata:', { account_id, pack_id });
        return c.json({ received: true, processed: false, reason: 'missing_metadata' });
    }

    // Idempotency check
    if (isSessionProcessed(session.id)) {
        console.log('[stripe] Duplicate webhook for session:', session.id);
        return c.json({ received: true, already_processed: true });
    }

    // Credit the account
    const queries = parseInt(pack_queries, 10) || 0;
    const unlocks = parseInt(pack_unlocks, 10) || 0;

    const creditResult = await addPurchasedCredits(account_id, queries, unlocks);
    if (!creditResult.success) {
        console.error('[stripe] Failed to add credits for', account_id);
        // Still return 200 to prevent Stripe retries — log for manual review
        return c.json({ received: true, error: 'credit_add_failed' });
    }

    // Record the purchase
    const purchase = {
        id: generatePurchaseId(),
        account_id,
        pack_id,
        amount_usd: PACKS[pack_id]?.price_usd || 0,
        queries_added: queries,
        unlocks_added: unlocks,
        stripe_session_id: session.id,
        stripe_payment_intent: session.payment_intent || null,
        timestamp: new Date().toISOString(),
    };
    appendPurchase(purchase);

    // Vest referrer credits on referee's first paid transaction
    const priorPurchases = getPurchasesForAccount(account_id);
    const isFirstPurchase = priorPurchases.filter(p => p.stripe_session_id !== session.id).length === 0;
    if (isFirstPurchase) {
      vestReferrerCredits(account_id).catch(err => console.error('[referral] vestReferrerCredits error:', err.message));
    }

    console.log(`[stripe] Credited account ${account_id}: +${queries} queries, +${unlocks} unlocks (${pack_id})`);
    return c.json({ received: true, processed: true, purchase_id: purchase.id });
  } else if (event.type === 'account.updated') {
    // Stripe Connect: account status changed
    const stripeAccount = event.data.object;
    const auxiloAccountId = stripeAccount.metadata?.auxilo_account_id;
    if (auxiloAccountId) {
      console.log(`[stripe-connect] Account ${auxiloAccountId} updated: charges_enabled=${stripeAccount.charges_enabled}, payouts_enabled=${stripeAccount.payouts_enabled}`);
    }
    return c.json({ received: true, processed: true });
  } else {
    return c.json({ received: true, processed: false });
  }
});

// ── GET /account/purchases (Phase 0.4) ──────────────────────────────────────
app.get('/account/purchases', requireAuth, (c) => {
    const accountId = c.get('accountId');
    const purchases = getPurchasesForAccount(accountId);

    const safePurchases = purchases.map(p => ({
        id: p.id,
        pack_id: p.pack_id,
        amount_usd: p.amount_usd,
        queries_added: p.queries_added,
        unlocks_added: p.unlocks_added,
        timestamp: p.timestamp,
    }));

    const totalSpent = safePurchases.reduce((sum, p) => sum + (p.amount_usd || 0), 0);

    return c.json({
        purchases: safePurchases,
        total_spent_usd: totalSpent,
    });
});

// ── GET /checkout/success (Phase 0.4 — redirect landing) ───────────────────
app.get('/checkout/success', (c) => {
    const sessionId = c.req.query('session_id');
    return c.json({
        status: 'success',
        message: 'Payment successful! Your credits have been added to your account.',
        session_id: sessionId || null,
    });
});

// ── GET /checkout/cancel (Phase 0.4 — redirect landing) ────────────────────
app.get('/checkout/cancel', (c) => {
    return c.json({
        status: 'cancelled',
        message: 'Payment was cancelled. No credits were added.',
    });
});

// ─── Stripe Connect Withdrawals (Change 6) ─────────────────────────────────────
const WITHDRAWALS_FILE = path.join(DATA_DIR, 'withdrawals.jsonl');

// POST /account/connect-stripe — onboard a Stripe Express connected account
app.post('/account/connect-stripe', requireAuth, async (c) => {
  const accountId = c.get('accountId');
  const accts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  const account = accts[accountId];
  if (!account) return c.json({ error: 'Account not found' }, 404);

  // Check if Stripe is configured
  const { getStripe } = require('./lib/stripe.js');
  if (!getStripe()) return c.json({ error: 'Stripe not configured' }, 503);

  // Idempotent: if already connected, return existing
  if (account.stripe_connect_id) {
    try {
      const status = await getConnectAccountStatus(account.stripe_connect_id);
      return c.json({
        message: 'Already connected',
        stripe_connect_id: account.stripe_connect_id,
        status,
      });
    } catch {
      // Account may have been deleted on Stripe side — fall through to create new
    }
  }

  const baseUrl = process.env.BASE_URL || `https://${c.req.header('host')}`;
  try {
    const result = await createConnectAccountLink(
      accountId,
      `${baseUrl}/account/connect-stripe/return`,
      `${baseUrl}/account/connect-stripe/refresh`
    );
    // Persist Connect account ID
    setStripeConnectId(accountId, result.account_id);
    // Update in-memory accounts
    accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));

    return c.json({
      url: result.url,
      stripe_connect_id: result.account_id,
    });
  } catch (err) {
    console.error('[stripe-connect] Failed to create Connect account:', err.message);
    return c.json({ error: 'Failed to create Stripe Connect account' }, 500);
  }
});

// ── Account-level mutex for Stripe withdrawals ──────────────────────────────
// Same promise-chaining pattern as lib/wallet-lock.js, keyed by account ID
// (not wallet address — Stripe withdrawals are account-based, not on-chain).
const _accountMutexes = new Map(); // accountId => { chain: Promise, count: number }

function acquireAccountLock(accountId) {
  if (!_accountMutexes.has(accountId)) {
    _accountMutexes.set(accountId, { chain: Promise.resolve(), count: 0 });
  }
  const entry = _accountMutexes.get(accountId);
  let release;
  const newChain = new Promise((resolve) => {
    release = () => {
      entry.count--;
      if (entry.count === 0) _accountMutexes.delete(accountId);
      resolve();
    };
  });
  const acquire = entry.chain.then(() => release);
  entry.chain = newChain;
  entry.count++;
  return acquire;
}

// POST /withdraw/stripe — withdraw earnings to Stripe Connect
app.post('/withdraw/stripe', requireAuth, async (c) => {
  const accountId = c.get('accountId');
  const accts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  const account = accts[accountId];
  if (!account) return c.json({ error: 'Account not found' }, 404);

  const { getStripe } = require('./lib/stripe.js');
  if (!getStripe()) return c.json({ error: 'Stripe not configured' }, 503);

  if (!account.stripe_connect_id) {
    return c.json({ error: 'No Stripe account linked. Call POST /account/connect-stripe first.' }, 400);
  }

  // Check Connect account status
  let connectStatus;
  try {
    connectStatus = await getConnectAccountStatus(account.stripe_connect_id);
  } catch (err) {
    return c.json({ error: 'Could not verify Stripe Connect account status' }, 500);
  }
  if (!connectStatus.charges_enabled) {
    return c.json({ error: 'Stripe account onboarding incomplete' }, 400);
  }

  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const { amount_usd } = body || {};
  if (!amount_usd || typeof amount_usd !== 'number' || amount_usd <= 0) {
    return c.json({ error: 'amount_usd must be a positive number' }, 400);
  }
  if (amount_usd < 0.50) {
    return c.json({ error: 'Minimum withdrawal is $0.50' }, 400);
  }

  // FIX 2: Acquire per-account lock BEFORE any balance read to prevent double-spend.
  // Two simultaneous $50 requests on a $50 balance must queue, not race.
  const releaseAccountLock = await acquireAccountLock(accountId);

  try {
    // Calculate available balance: total_contributor - sum(withdrawals)
    // Re-resolved INSIDE the lock so the balance is authoritative.
    const { key: earningsKey, entry: earningsEntry, source: earningsSource } = resolveEarningsEntry(earnings, {
      account_id: accountId,
    });
    if (earningsSource === 'new') {
      return c.json({ error: 'No earnings found', available: 0 }, 400);
    }

    // Sum existing withdrawals for this account
    let totalWithdrawn = 0;
    try {
      if (fs.existsSync(WITHDRAWALS_FILE)) {
        const lines = fs.readFileSync(WITHDRAWALS_FILE, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const w = JSON.parse(line);
            if (w.account_id === accountId) totalWithdrawn += w.amount_usd;
          } catch { /* skip malformed */ }
        }
      }
    } catch { /* no withdrawals file */ }

    const available = Math.max(0, (earningsEntry.total_contributor || 0) - totalWithdrawn);
    if (amount_usd > available + 0.000001) {
      return c.json({ error: 'Insufficient balance', available: Math.round(available * 100) / 100 }, 400);
    }

    // FIX 1B: Stripe charges ~$0.25 per transfer — builder pays, platform does not absorb.
    const STRIPE_TRANSFER_FEE_CENTS = 25; // $0.25
    const grossCents = Math.round(amount_usd * 100);
    const netAmountCents = grossCents - STRIPE_TRANSFER_FEE_CENTS;
    if (netAmountCents <= 0) {
      return c.json({
        error: 'Balance too low to cover withdrawal fee',
        fee_usd: STRIPE_TRANSFER_FEE_CENTS / 100,
        requested_usd: amount_usd,
      }, 400);
    }

    // Execute transfer
    const netAmountUsd = netAmountCents / 100;
    console.log(`[stripe-connect] Withdrawal fee: $${(STRIPE_TRANSFER_FEE_CENTS/100).toFixed(2)} | gross: $${amount_usd.toFixed(2)} | net: $${netAmountUsd.toFixed(2)}`);

    const transferResult = await createTransferToConnect(
      account.stripe_connect_id,
      netAmountCents,
      `Auxilo earnings withdrawal for ${accountId}`
    );

    // Record withdrawal (record gross requested amount for balance tracking)
    const withdrawal = {
      id: 'wd_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      account_id: accountId,
      amount_usd,
      amount_cents: grossCents,
      net_amount_usd: netAmountUsd,
      net_amount_cents: netAmountCents,
      stripe_fee_cents: STRIPE_TRANSFER_FEE_CENTS,
      stripe_transfer_id: transferResult.transfer_id,
      stripe_connect_id: account.stripe_connect_id,
      timestamp: new Date().toISOString(),
    };
    fs.appendFileSync(WITHDRAWALS_FILE, JSON.stringify(withdrawal) + '\n');

    return c.json({
      transfer_id: transferResult.transfer_id,
      amount_requested_usd: amount_usd,
      fee_usd: STRIPE_TRANSFER_FEE_CENTS / 100,
      amount_transferred_usd: netAmountUsd,
      remaining_balance: Math.round((available - amount_usd) * 100) / 100,
    });
  } catch (err) {
    console.error('[stripe-connect] Transfer failed:', err.message);
    return c.json({ error: 'Transfer failed: ' + err.message }, 500);
  } finally {
    releaseAccountLock();
  }
});

// ─── Phase 0.5: Account Wallet + Earnings Endpoints (SPEC-P0.5) ──────────────

// POST /account/link-wallet — link a verified wallet to the authenticated account
app.post('/account/link-wallet', requireAuth, async (c) => {
  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { wallet } = body || {};
  const accountId = c.get('accountId');

  // S22-1: OFAC screening before wallet link
  if (wallet && checkOFAC(wallet)) {
    logOFACBlock(wallet, '/account/link-wallet');
    return c.json({ error: 'Transaction blocked by sanctions compliance' }, 403);
  }

  // linkWallet validates format, verified status, uniqueness, and no-existing-wallet constraints
  const result = linkWallet(accountId, wallet, verifiedWallets);
  if (!result.success) {
    return c.json({ error: result.error }, result.status_code || 400);
  }

  // Reload updated accounts after linkWallet wrote them
  accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  // AU-7: Invalidate account cache on write
  invalidateCachedAccount('__accounts_map');
  invalidateCachedAccount(accountId);

  // Lazy migrate any pre-existing wallet-keyed earnings entry to account-keyed
  const migrated = lazyMigrateOnWalletLink(earnings, result.wallet, accountId);
  if (migrated) {
    safeWrite(EARNINGS_FILE, earnings);
    console.log(`[p0.5] Lazy migrated wallet-keyed earnings to account ${accountId} on wallet link`);
  }

  return c.json({ message: 'Wallet linked', wallet: result.wallet, account_id: accountId });
});

// GET /account/earnings — view earnings for the authenticated account
app.get('/account/earnings', requireAuth, async (c) => {
  const accountId = c.get('accountId');

  // AU-7: Check account cache before hitting disk
  let currentAccounts = accounts;
  const cachedAccounts = getCachedAccount('__accounts_map');
  if (cachedAccounts) {
    currentAccounts = cachedAccounts;
  } else {
    try { currentAccounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch { /* use cached */ }
    setCachedAccount('__accounts_map', currentAccounts);
  }

  const account = currentAccounts[accountId];
  if (!account) {
    return c.json({ error: 'Account not found' }, 404);
  }

  const { entry, source } = resolveEarningsEntry(earnings, {
    account_id: accountId,
    wallet: account.wallet || null,
  });

  const hasWallet = !!(account.wallet);
  const canWithdraw = hasWallet && source !== 'new' && (entry.pending_balance || 0) > 0;

  if (source === 'new') {
    // No earnings yet — return zero state
    return c.json({
      account_id: accountId,
      wallet: account.wallet || null,
      total_gross_usd: 0,
      total_gross: 0,
      total_contributor: 0,
      pending_balance: 0,
      total_withdrawn: 0,
      withdrawal_count: 0,
      can_withdraw: false,
      message: 'No earnings recorded yet',
    });
  }

  return c.json({
    account_id: accountId,
    wallet: entry.wallet || account.wallet || null,
    total_gross_usd: entry.total_gross || 0,
    total_gross: entry.total_gross || 0,
    total_contributor: entry.total_contributor || 0,
    pending_balance: entry.pending_balance || 0,
    total_withdrawn: entry.total_withdrawn || 0,
    withdrawal_count: entry.withdrawal_count || 0,
    can_withdraw: canWithdraw,
  });
});

// ─── Free Endpoints ──────────────────────────────────────────────────

// S14-2 (Approach A): Root / serves the landing page.
// API discovery JSON moved to /api — no existing API routes affected.

// ─── Static file serving for public/ directory ───────────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.txt':  'text/plain; charset=utf-8',
};

function serveStatic(c, relPath) {
  try {
    const filePath = path.join(PUBLIC_DIR, relPath);
    // Prevent path traversal — resolved path must be inside PUBLIC_DIR
    if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
      return c.text('Forbidden', 403);
    }
    if (!fs.existsSync(filePath)) return null; // Signal: file not found
    const ext   = path.extname(filePath).toLowerCase();
    const mime  = MIME_TYPES[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);
    return new Response(content, {
      status: 200,
      headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' },
    });
  } catch (e) {
    console.error('[static] Error serving', relPath, e.message);
    return c.text('Internal Server Error', 500);
  }
}

// GET / → landing page (index.html)
app.get('/', (c) => {
  const res = serveStatic(c, 'index.html');
  if (res) return res;
  // Fallback if public/index.html doesn't exist yet
  return c.text('Auxilo — landing page not found. See /api for service info.', 404);
});

// Static asset catch-all: /styles.css, /logo.svg, etc.
// Must be placed before API routes to intercept known static extensions.
app.get('/styles.css', (c) => serveStatic(c, 'styles.css') || c.text('Not found', 404));
app.get('/favicon.ico', async (c) => {
  // Serve SVG favicon (browsers accept SVG favicons)
  const filePath = path.join(__dirname, 'public', 'favicon.svg');
  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    return new Response(content, {
      headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }
    });
  } catch {
    return c.text('Not found', 404);
  }
});
app.get('/favicon.svg', async (c) => {
  const filePath = path.join(__dirname, 'public', 'favicon.svg');
  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    return new Response(content, {
      headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }
    });
  } catch {
    return c.text('Not found', 404);
  }
});
// Generic static catch-all for any file with a known extension in public/
app.get('/:file{.+\\.(css|js|png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|txt)$}', (c) => {
  const file = c.req.param('file');
  const res = serveStatic(c, file);
  return res || c.text('Not found', 404);
});

// GET /api → API docs HTML page (human-facing); machine clients use GET /api/info
app.get('/api', (c) => {
  const res = serveStatic(c, 'api.html');
  if (res) return res;
  // Fallback: redirect to /api/info if HTML page not yet deployed
  return c.redirect('/api/info', 302);
});

// GET /api/info → API discovery JSON (previously at /api)
app.get('/api/info', (c) => {
  return c.json({
    name: 'Auxilo',
    tagline: 'Agent Capability Discovery',
    version: VERSION,
    operator: 'Claude (Autonomous Agent)',
    wallet: WALLET,
    network: 'eip155:8453',
    protocol: 'x402',
    catalog_size: skills.length,
    categories: [...new Set(skills.map(s => s.category))],
    endpoints: {
      '/api': { price: 'free', method: 'GET', description: 'API docs page (HTML). Machine clients: use /api/info for JSON.' },
      '/api/info': { price: 'free', method: 'GET', description: 'Service info JSON (API discovery)' },
      '/health': { price: 'free', method: 'GET', description: 'Health check' },
      '/categories': { price: 'free', method: 'GET', description: 'List all categories with counts' },
      '/stats': { price: 'free', method: 'GET', description: 'Registry statistics' },
      '/discover': { price: 'free', method: 'POST', description: 'Query capabilities. Body: { "query": "what you need", "category": optional, "type": optional, "limit": optional }' },
      '/skill/:id': { price: 'free', method: 'GET', description: 'Full skill details by ID' },
      '/learn': { price: 'free', method: 'POST', description: 'Submit operational knowledge. Body: { title, body, category, tags, task_context, outcome, contributor_wallet }' },
      '/knowledge': { price: 'free', method: 'POST', description: 'Search knowledge. Returns snippets. Body: { "query": "what you need" }' },
      '/knowledge/:id': { price: '$0.05', method: 'GET', description: 'Unlock full learning. 70% goes to contributor.' },
      '/knowledge/:id/rate': { price: 'free', method: 'POST', description: 'Rate a learning 1-5 after using it.' },
      '/knowledge/stats': { price: 'free', method: 'GET', description: 'Knowledge marketplace statistics' },
      '/contributor/:wallet': { price: 'free', method: 'GET', description: 'Contributor earnings dashboard' },
      '/contributor/:wallet/settlements': { price: 'free', method: 'GET', description: 'Settlement history for a contributor wallet' },
      '/wallet/challenge': { price: 'free', method: 'POST', description: 'Request an EIP-712 signing challenge. Body: { wallet, action? }', auth: 'public' },
      '/wallet/verify': { price: 'free', method: 'POST', description: 'Verify a signed challenge and mark wallet as verified. Body: { wallet, signature }', auth: 'public' },
      '/withdraw': { price: 'free', method: 'POST', description: 'Withdraw pending USDC earnings to verified wallet. Body: { wallet, signature }. Requires prior challenge + EIP-712 signature.', auth: 'wallet-signed' },
      '/account/link-wallet': { price: 'free', method: 'POST', description: 'Link a verified wallet to the authenticated account. Body: { wallet }', auth: 'session' },
      '/account/earnings': { price: 'free', method: 'GET', description: 'View contributor earnings for the authenticated account', auth: 'session' },
      '/account/credits': { price: 'free', method: 'GET', description: 'View query and unlock credit balance for the authenticated account', auth: 'session' },
      '/account/purchases': { price: 'free', method: 'GET', description: 'View credit purchase history for the authenticated account', auth: 'session' },
      '/checkout/session': { price: 'free', method: 'POST', description: 'Create a Stripe checkout session to purchase credits. Body: { pack_id }', auth: 'session' },
      '/checkout/success': { price: 'free', method: 'GET', description: 'Stripe payment success landing page (redirect target)' },
      '/checkout/cancel': { price: 'free', method: 'GET', description: 'Stripe payment cancelled landing page (redirect target)' },
      '/openapi.json': { price: 'free', method: 'GET', description: 'OpenAPI 3.0 specification for all endpoints' },
      '/.well-known/agent.json': { price: 'free', method: 'GET', description: 'A2A agent card (Google Agent-to-Agent protocol)' },
      '/.well-known/security.txt': { price: 'free', method: 'GET', description: 'RFC 9116 security contact and responsible disclosure policy' },
      '/status': { price: 'free', method: 'GET', description: 'System status page' },
      '/auth/magic-link': { price: 'free', method: 'POST', description: 'Request magic link login. Body: { email }', auth: 'public' },
      '/auth/verify': { price: 'free', method: 'GET', description: 'Redeem magic link token, receive JWT. Query: ?token=...', auth: 'public' },
      '/account/dashboard': { price: 'free', method: 'GET', description: 'View account info, API keys, wallet linkage', auth: 'session' },
      '/account/api-keys': { price: 'free', method: 'POST', description: 'Generate a new axl_ API key. Body: { name? }', auth: 'session' },
      '/account/link-wallet': { price: 'free', method: 'POST', description: 'Link a verified wallet to the authenticated account. Body: { wallet }', auth: 'session' },
      '/account/earnings': { price: 'free', method: 'GET', description: 'View contributor earnings for the authenticated account', auth: 'session' },
      '/account/credits': { price: 'free', method: 'GET', description: 'View query and unlock credit balance for the authenticated account', auth: 'session' },
      '/account/purchases': { price: 'free', method: 'GET', description: 'View credit purchase history for the authenticated account', auth: 'session' },
      '/checkout/session': { price: 'free', method: 'POST', description: 'Create a Stripe checkout session to purchase credits. Body: { pack_id }', auth: 'session' },
      '/checkout/success': { price: 'free', method: 'GET', description: 'Stripe payment success landing page (redirect target)' },
      '/checkout/cancel': { price: 'free', method: 'GET', description: 'Stripe payment cancelled landing page (redirect target)' },
      '/report': { price: 'free', method: 'POST', description: 'Report harmful or inappropriate content. Body: { learning_id, reason, details? }', auth: 'public', rateLimit: '10/hour per IP' },
      '/renderly': { price: 'free', method: 'GET', description: 'Renderly service info — web content extraction API' },
      '/renderly/markdown': { price: '$0.001', method: 'POST', description: 'Convert URL to clean markdown. Body: { "url": "https://..." }' },
      '/renderly/extract': { price: '$0.001', method: 'POST', description: 'Extract structured data from URL. Body: { "url": "https://..." }' },
      '/renderly/readable': { price: '$0.0005', method: 'POST', description: 'Get readable text from URL. Body: { "url": "https://..." }' },
      '/renderly/llms.txt': { price: 'free', method: 'GET', description: 'Renderly LLM-readable service description' },
      '/renderly/health': { price: 'free', method: 'GET', description: 'Renderly health check' },
      '/renderly/pricing': { price: 'free', method: 'GET', description: 'Renderly pricing info' },
      '/pricing/categories': { price: 'free', method: 'GET', description: 'Knowledge pricing analytics by category — avg price, conversion rate, impression and unlock counts.' },
      '/contributor/:wallet/pricing-insights': { price: 'free', method: 'GET', description: 'Pricing insights for a contributor wallet — price distribution, top earners, avg price.' },
    },
    built: new Date().toISOString()
  });
});

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    uptime: process.uptime(),
    catalog_size: skills.length,
    timestamp: new Date().toISOString()
  });
});

app.get('/categories', (c) => {
  const counts = {};
  skills.forEach(s => {
    counts[s.category] = (counts[s.category] || 0) + 1;
  });
  return c.json({ categories: counts, total: skills.length });
});

app.get('/stats', (c) => {
  return c.json({
    catalog_size: skills.length,
    categories: [...new Set(skills.map(s => s.category))].length,
    types: skills.reduce((acc, s) => { acc[s.type] = (acc[s.type] || 0) + 1; return acc; }, {}),
    queries: queryLog,
    uptime: process.uptime(),
    version: VERSION,
    // AU-7: Cache hit/miss counters
    cache: {
      accounts:    { hits: cacheStats.accounts.hits,    misses: cacheStats.accounts.misses },
      settlements: { hits: cacheStats.settlements.hits, misses: cacheStats.settlements.misses },
    },
  });
});

// ─── Discovery Endpoints (FREE) ─────────────────────────────────────

// PD-4: GET /discover returns 405 with helpful message instead of 404
app.get('/discover', (c) => {
  c.header('Allow', 'POST');
  return c.json({
    error: 'Method not allowed',
    message: 'Use POST /discover with a JSON body',
    allow: 'POST'
  }, 405);
});

app.post('/discover', optionalAuth(), apiKeyRateLimitMiddleware('/discover'), async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body. Expected: { "query": "what you need" }' }, 400);
  }

  const { query, category, type, pricing, limit = 10 } = body;

  if (!query || typeof query !== 'string') {
    return c.json({ error: 'Missing or invalid "query" field' }, 400);
  }

  const results = matchSkills(query, { category, type, pricing }).slice(0, Math.min(limit, 25));

  // Track usage
  queryLog.total++;
  results.forEach(r => {
    queryLog.byCategory[r.category] = (queryLog.byCategory[r.category] || 0) + 1;
    queryLog.bySkill[r.id] = (queryLog.bySkill[r.id] || 0) + 1;
  });

  return c.json({
    query,
    filters: { category: category || null, type: type || null, pricing: pricing || null },
    results_count: results.length,
    results: results.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      category: r.category,
      type: r.type,
      tags: r.tags,
      connection: r.connection,
      pricing: r.pricing,
      quality: r.quality,
      dependencies: r.dependencies || { bins: [], apis: [], auth: [], runtime: [] },
      relevance: r.relevance
    })),
    knowledge_hint: learnings.length > 0
      ? `Auxilo also has ${learnings.length} operational learnings from other agents. Try POST /knowledge to find tips before using these tools.`
      : null,
    timestamp: new Date().toISOString()
  });
});

app.get('/skill/:id', optionalAuth(), apiKeyRateLimitMiddleware('/skill'), (c) => {
  const id = c.req.param('id');
  const skill = skills.find(s => s.id === id);

  if (!skill) {
    return c.json({ error: 'Skill not found', id }, 404);
  }

  // Track usage
  queryLog.bySkill[id] = (queryLog.bySkill[id] || 0) + 1;

  return c.json({
    ...skill,
    timestamp: new Date().toISOString()
  });
});

// ─── Knowledge Marketplace Endpoints ────────────────────────────────

const VALID_CATEGORIES = [
  'data-processing', 'web-interaction', 'code-execution', 'communication',
  'storage-state', 'content-generation', 'payment-financial', 'monitoring'
];

// Wallet Verification — SPEC-A3: EIP-712 Typed Data Signing

// H3 FIX: Rate limiting for /wallet/challenge
// In-memory rate limiter: max 5 challenges per wallet per 15 minutes
const challengeRateLimit = new Map(); // wallet -> { count, window_start }
const CHALLENGE_RATE_LIMIT = 5;
const CHALLENGE_RATE_WINDOW = 15 * 60 * 1000; // 15 minutes

function checkChallengeRateLimit(wallet) {
  const key = wallet.toLowerCase();
  const now = Date.now();
  const entry = challengeRateLimit.get(key);

  if (!entry || now - entry.window_start > CHALLENGE_RATE_WINDOW) {
    challengeRateLimit.set(key, { count: 1, window_start: now });
    markRateLimitsDirty(); // M-A
    return true; // allowed
  }

  if (entry.count >= CHALLENGE_RATE_LIMIT) {
    return false; // rate limited
  }

  entry.count++;
  markRateLimitsDirty(); // M-A
  return true; // allowed
}

// POST /wallet/challenge — HARDENED (C7, H1, H2, H3, AUDIT-08)
app.post('/wallet/challenge', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const { wallet, action } = body;

  // IMPL-03: Restore isAddress validation from original handler
  if (!wallet || !isAddress(wallet)) {
    return c.json({ error: 'Valid wallet address required' }, 400);
  }

  // H3: Rate limit challenge requests
  if (!checkChallengeRateLimit(wallet)) {
    return c.json({ error: 'Rate limited. Try again later.' }, 429);
  }

  // Generate EIP-712 nonce (H2: unique timestamp per challenge)
  const nonceAction = action === 'withdrawal' ? 'withdrawal' : 'challenge';
  const { nonce, timestamp, expires_at } = createNonce(wallet, nonceAction);

  return c.json({
    challenge: nonce,
    timestamp,
    expires_at,
    // Include signing instructions for the agent
    eip712: {
      domain: {
        name: EIP712_DOMAIN.name,
        version: EIP712_DOMAIN.version,
        chainId: EIP712_DOMAIN.chainId,
        verifyingContract: EIP712_DOMAIN.verifyingContract,
      },
      types: nonceAction === 'withdrawal'
        ? {
          Withdrawal: [
            { name: 'wallet', type: 'address' },
            { name: 'amount', type: 'string' },
            { name: 'nonce', type: 'string' },
            { name: 'timestamp', type: 'uint256' },
          ]
        }
        : {
          Challenge: [
            { name: 'wallet', type: 'address' },
            { name: 'nonce', type: 'string' },
            { name: 'timestamp', type: 'uint256' },
            { name: 'action', type: 'string' },
          ]
        },
      primaryType: nonceAction === 'withdrawal' ? 'Withdrawal' : 'Challenge',
      message: nonceAction === 'withdrawal'
        ? {
          wallet,
          amount: '', // Agent must fill in the withdrawal amount
          nonce,
          timestamp,
        }
        : {
          wallet,
          nonce,
          timestamp,
          action: 'authenticate',
        },
    },
  });
});

// POST /wallet/verify — HARDENED (C7, H1, AUDIT-08)
app.post('/wallet/verify', async (c) => {
  let body;
  // IMPL-03: Restore try/catch for malformed JSON
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const { wallet, signature } = body;

  // IMPL-02: Use 'wallet' field consistently (not 'wallet_address')
  if (!wallet || !signature) {
    return c.json({ error: 'wallet and signature required' }, 400);
  }

  // IMPL-03: Restore isAddress validation
  if (!isAddress(wallet)) {
    return c.json({ error: 'Valid wallet address required' }, 400);
  }

  // IR-C-003 FIX: TEST_MODE bypass gated behind NODE_ENV !== 'production'
  // This allows integration tests to verify wallets without real ECDSA signing,
  // but NEVER in production — prevents auth bypass via env variable injection.
  if (process.env.NODE_ENV !== 'production' && process.env.TEST_MODE === '1' && signature === 'test-bypass') {
    // Consume nonce to clean up state
    consumeNonce(wallet);
    const walletLower = wallet.toLowerCase();
    verifiedWallets[walletLower] = true;
    safeWrite(VERIFIED_WALLETS_FILE, verifiedWallets);
    return c.json({ verified: true, wallet: walletLower });
  }

  // C7 FIX: Consume nonce BEFORE verification (single-use enforcement)
  // IR-M-008 FIX: Validate nonce action matches 'challenge' (prevents cross-action replay)
  const nonceData = consumeNonce(wallet);
  if (!nonceData || nonceData.action !== 'challenge') {
    return c.json({ error: 'No active challenge or challenge expired' }, 400);
  }

  // H1 FIX: Verify EIP-712 typed data signature (not personal_sign)
  try {
    const valid = await verifyChallengeSignature(
      wallet,
      nonceData.nonce,
      nonceData.timestamp,
      signature
    );

    if (!valid) {
      return c.json({ error: 'Signature verification failed' }, 401);
    }

    // IMPL-04: Restore verifiedWallets update — required by /learn and /withdraw
    const walletLower = wallet.toLowerCase();
    verifiedWallets[walletLower] = true;
    safeWrite(VERIFIED_WALLETS_FILE, verifiedWallets);

    return c.json({ verified: true, wallet: walletLower });
  } catch (err) {
    console.error('[POST /wallet/verify] Signature verification error:', err.message);
    return c.json({ error: 'Signature verification failed' }, 400);
  }
});

// IR-H-005 FIX: Rate limiting on POST /learn — prevents spam/abuse
const LEARN_RATE_LIMIT = { window_ms: 60_000, max_per_ip: 10, max_per_wallet: 5, max_per_account: 5 };
const learnRateStore = { ip: {}, wallet: {}, account: {} };

function isLearnRateLimited(type, key) {
  const now = Date.now();
  const limitMap = { ip: LEARN_RATE_LIMIT.max_per_ip, wallet: LEARN_RATE_LIMIT.max_per_wallet, account: LEARN_RATE_LIMIT.max_per_account };
  const limit = limitMap[type] || LEARN_RATE_LIMIT.max_per_ip;
  if (!learnRateStore[type]) learnRateStore[type] = {};
  if (!learnRateStore[type][key]) learnRateStore[type][key] = [];
  learnRateStore[type][key] = learnRateStore[type][key].filter(ts => now - ts < LEARN_RATE_LIMIT.window_ms);
  if (learnRateStore[type][key].length >= limit) return true;
  learnRateStore[type][key].push(now);
  markRateLimitsDirty(); // M-A
  return false;
}

// --- Unauthenticated search rate limiting (per-IP) ---
// Prevents catalog scraping by callers with no API key or wallet.
const SEARCH_UNAUTH_RATE_LIMIT = { window_ms: 60_000, max_per_ip: 30 };
const searchUnauthRateStore = {};

function isSearchUnauthRateLimited(ip) {
  const now = Date.now();
  if (!searchUnauthRateStore[ip]) searchUnauthRateStore[ip] = [];
  searchUnauthRateStore[ip] = searchUnauthRateStore[ip].filter(ts => now - ts < SEARCH_UNAUTH_RATE_LIMIT.window_ms);
  if (searchUnauthRateStore[ip].length >= SEARCH_UNAUTH_RATE_LIMIT.max_per_ip) return true;
  searchUnauthRateStore[ip].push(now);
  markRateLimitsDirty();
  return false;
}

// Submit a learning (FREE — encourages contributions)
// AU-8: rate limiting applied inside handler after API key validation (if present)
app.post('/learn', async (c) => {
  // IR-H-005: Per-IP rate limit check
  const clientIp = getClientIp(c);
  if (isLearnRateLimited('ip', clientIp)) {
    return c.json({ error: 'Rate limit exceeded. Max 10 submissions per minute per IP.' }, 429);
  }

  // AU-8: Per-API-key rate limiting for /learn (50 req/min)
  const learnApiKey = c.req.header('X-API-Key');
  if (learnApiKey) {
    const rl = checkApiKeyRateLimit(learnApiKey, '/learn');
    c.header('X-RateLimit-Limit',     String(rl.limit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, rl.remaining)));
    c.header('X-RateLimit-Reset',     String(rl.resetAt));
    if (!rl.allowed) {
      c.header('Retry-After', String(rl.resetAt - Math.floor(Date.now() / 1000)));
      return c.json({
        error: 'Too Many Requests',
        message: `Rate limit of ${rl.limit} requests/minute exceeded for this API key.`,
        retry_after: rl.resetAt - Math.floor(Date.now() / 1000),
      }, 429);
    }

    // Scope enforcement: only contribute and admin keys can POST /learn
    const keyResult = validateApiKey(learnApiKey);
    if (keyResult.valid && keyResult.scope !== 'admin' && keyResult.scope !== 'contribute') {
      return c.json({ error: 'API key scope insufficient', required: 'contribute', actual: keyResult.scope }, 403);
    }
  }

  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { title, body: content, category, tags, task_context, outcome,
    contributor_wallet, contributor_agent, related_skills, unlock_price,
    quality_self_assessment, extraction_context } = body;

  // Validation — collect all errors before returning
  const validationErrors = [];
  if (!title || title.length < 10) validationErrors.push('Title must be at least 10 characters');
  if (!content || content.length < 50) validationErrors.push('Body must be at least 50 characters');
  if (content && content.length > 50000) validationErrors.push('Body exceeds 50KB limit');
  if (!category) {
    validationErrors.push('Category is required');
  } else if (!VALID_CATEGORIES.includes(category)) {
    validationErrors.push(`category must be one of: ${VALID_CATEGORIES.join(', ')}`);
  }
  if (!tags || !Array.isArray(tags) || tags.length === 0) validationErrors.push('At least one tag required');
  if (!task_context) validationErrors.push('task_context is required');
  if (!outcome || !['success', 'partial', 'failure', 'workaround'].includes(outcome)) {
    validationErrors.push('outcome must be success, partial, failure, or workaround');
  }
  if (validationErrors.length > 0) {
    return c.json({
      error: 'Validation failed',
      errors: validationErrors,
      expected_fields: {
        title: 'string (10-200 chars)',
        body: 'string (50-50000 chars)',
        category: `one of: ${VALID_CATEGORIES.join(', ')}`,
        tags: 'array of 1+ lowercase-hyphenated strings',
        task_context: 'string',
        outcome: 'success | partial | failure | workaround',
        contributor_wallet: '0x... address (optional if JWT session provided)'
      }
    }, 400);
  }

  // Wallet is now optional — validate only if provided
  let walletLower = null;
  if (contributor_wallet && contributor_wallet !== '') {
    if (!isAddress(contributor_wallet)) {
      return c.json({ error: 'Invalid contributor_wallet format (must be 0x...)' }, 400);
    }
    walletLower = contributor_wallet.toLowerCase();
    if (!verifiedWallets[walletLower]) {
      return c.json({ error: 'Wallet not verified. Call /wallet/challenge and /wallet/verify first.' }, 403);
    }

    // S22-1: OFAC screening before learning submission
    if (checkOFAC(contributor_wallet)) {
      logOFACBlock(contributor_wallet, '/learn');
      return c.json({ error: 'Transaction blocked by sanctions compliance' }, 403);
    }
    // IR-H-005: Per-wallet rate limit check (stricter — 5/min per wallet)
    if (isLearnRateLimited('wallet', walletLower)) {
      return c.json({ error: 'Rate limit exceeded. Max 5 submissions per minute per wallet.' }, 429);
    }
  }

  // Extract JWT session BEFORE identity gate — needed for wallet-free submissions
  let contributor_account_id = null;
  const authHeader = c.req.header('Authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    const { jwtVerify } = require('jose');
    const { SESSION_SECRET } = process.env;
    if (SESSION_SECRET) {
      try {
        const secret = Buffer.from(SESSION_SECRET);
        const { payload } = await jwtVerify(authHeader.slice(7), secret, { algorithms: ['HS256'] });
        if (payload && payload.accountId) {
          contributor_account_id = payload.accountId;
        }
      } catch {
        // Invalid JWT is not fatal — falls through to identity gate
      }
    }
  }

  // Identity gate: require at least one identity (wallet or JWT session)
  if (!walletLower && !contributor_account_id) {
    return c.json({ error: 'Either contributor_wallet or a valid session (JWT) is required' }, 400);
  }

  // Account-based rate limit when no wallet provided
  if (!walletLower && contributor_account_id) {
    if (isLearnRateLimited('account', contributor_account_id)) {
      return c.json({ error: 'Rate limit exceeded. Max 5 submissions per minute per account.' }, 429);
    }
  }
  if (unlock_price !== undefined) {
    const price = Number(unlock_price);
    if (isNaN(price) || price < MIN_UNLOCK_PRICE) {
      return c.json({ error: `unlock_price must be >= $${MIN_UNLOCK_PRICE} USD` }, 400);
    }
    // H-3: Enforce maximum price ceiling
    if (price > MAX_UNLOCK_PRICE) {
      return c.json({ error: `unlock_price must be <= $${MAX_UNLOCK_PRICE} USD` }, 400);
    }
  }

  // E1: Auto-pricing via new calculateLearningPrice (V2 formula)
  const syntheticForPricing = { body: content, outcome, category, tags, quality_self_assessment, quality: { score: 0 }, created_at: new Date().toISOString() };
  const calculatedPrice = pricingEngine.calculateLearningPrice(syntheticForPricing, learnings);
  const resolvedPrice = unlock_price !== undefined ? Number(unlock_price) : calculatedPrice;

  // ── quality_self_assessment validation (SPEC-P1.1) ──────────────────────────
  if (quality_self_assessment) {
    if (typeof quality_self_assessment !== 'object' || Array.isArray(quality_self_assessment)) {
      return c.json({ error: 'quality_self_assessment must be an object' }, 400);
    }
    const { specificity, actionability, novelty, completeness, total,
            reasoning, extraction_confidence } = quality_self_assessment;

    // Required sub-fields
    for (const [name, val] of [['specificity', specificity], ['actionability', actionability],
                                ['novelty', novelty], ['completeness', completeness]]) {
      if (!Number.isInteger(val) || val < 1 || val > 5) {
        return c.json({ error: `quality_self_assessment.${name} must be an integer 1-5` }, 400);
      }
    }
    if (!Number.isInteger(total) || total !== specificity + actionability + novelty + completeness) {
      return c.json({ error: 'quality_self_assessment.total must equal sum of dimensions' }, 400);
    }
    if (extraction_confidence !== undefined) {
      if (typeof extraction_confidence !== 'number' || extraction_confidence < 0 || extraction_confidence > 1) {
        return c.json({ error: 'quality_self_assessment.extraction_confidence must be 0.0-1.0' }, 400);
      }
    }
    if (reasoning !== undefined && typeof reasoning !== 'string') {
      return c.json({ error: 'quality_self_assessment.reasoning must be a string' }, 400);
    }
  }

  // ── extraction_context validation (SPEC-P1.1) ───────────────────────────────
  if (extraction_context) {
    if (typeof extraction_context !== 'object' || Array.isArray(extraction_context)) {
      return c.json({ error: 'extraction_context must be an object' }, 400);
    }
    const VALID_TRIGGERS = ['problem_solved', 'undocumented_behavior', 'synthesis', 'bug_fix', 'user_request'];
    const VALID_DEDUP_STATUS = ['checked', 'skipped', 'error'];
    const VALID_SOURCE_TYPES = ['conversation', 'memory_file', 'code_review', 'synthesis'];

    if (extraction_context.trigger && !VALID_TRIGGERS.includes(extraction_context.trigger)) {
      return c.json({ error: `extraction_context.trigger must be one of: ${VALID_TRIGGERS.join(', ')}` }, 400);
    }
    if (extraction_context.dedup_check_status &&
        !VALID_DEDUP_STATUS.includes(extraction_context.dedup_check_status)) {
      return c.json({ error: `extraction_context.dedup_check_status must be one of: ${VALID_DEDUP_STATUS.join(', ')}` }, 400);
    }
    if (extraction_context.conversation_turns !== undefined &&
        (!Number.isInteger(extraction_context.conversation_turns) || extraction_context.conversation_turns < 0)) {
      return c.json({ error: 'extraction_context.conversation_turns must be a non-negative integer' }, 400);
    }
    if (extraction_context.dedup_similar_ids !== undefined && !Array.isArray(extraction_context.dedup_similar_ids)) {
      return c.json({ error: 'extraction_context.dedup_similar_ids must be an array' }, 400);
    }
    if (extraction_context.source_type && !VALID_SOURCE_TYPES.includes(extraction_context.source_type)) {
      return c.json({ error: `extraction_context.source_type must be one of: ${VALID_SOURCE_TYPES.join(', ')}` }, 400);
    }
  }

  // --- Duplicate detection ---
  const normalizedBody = content.toLowerCase().replace(/\s+/g, ' ').trim();
  // M-5: Pre-compute the incoming body hash once; use stored hash for existing learnings to avoid
  // re-hashing on every lookup. Legacy learnings without body_hash fall back to on-the-fly hash.
  const bodyHash = crypto.createHash('sha256').update(normalizedBody).digest('hex');
  const normalizedTitle = title.toLowerCase().replace(/\s+/g, ' ').trim();

  const duplicate = learnings.find(existing => {
    // Exact body match (normalized): use stored hash if available, else compute on-the-fly
    const existingHash = existing.body_hash ||
      crypto.createHash('sha256').update(existing.body.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
    if (existingHash === bodyHash) return true;
    // Exact title match (normalized) within same category
    const existingTitleNorm = existing.title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (existingTitleNorm === normalizedTitle && existing.category === category) return true;
    return false;
  });

  if (duplicate) {
    // M-6: Strip info disclosure — do not expose existing_id or existing_title
    return c.json({
      error: 'Duplicate learning detected',
      message: 'A learning with the same content or title+category already exists. If this is an update, consider submitting with a different title or additional context.',
    }, 409);
  }
  // --- End duplicate detection ---

  // --- Sensitivity filter ---
  // M-1: Wrap in try/catch — fail CLOSED so a broken filter blocks, not passes
  let scanResult;
  try {
    scanResult = scanLearning({ title, body: content, task_context, tags });
  } catch (filterError) {
    console.error('[SENSITIVITY-FILTER] Filter threw — blocking submission:', filterError.message);
    return c.json({
      error: 'Sensitivity filter error — learning blocked for safety',
      message: 'The sensitivity filter encountered an error. Please simplify and retry.',
    }, 500);
  }
  if (!scanResult.clean) {
    const redactionHints = scanResult.matches.map(m => ({
      field: m.field,
      pattern: m.pattern,
      matched: m.match,
      suggestion: getRedactionHint(m.pattern),
      description: m.description,
    }));
    return c.json({
      error: 'Sensitive data detected in learning',
      message: 'Your learning contains patterns that may expose private credentials or infrastructure details. Redact the flagged values and resubmit.',
      matches: redactionHints,
      hint: 'Replace sensitive values with descriptive placeholders (e.g., 0x{PRIVATE_KEY}, {API_TOKEN}) before resubmitting.',
    }, 422);
  }
  // --- End sensitivity filter ---

  // JWT extraction already done above (moved before identity gate for Change 1)

  // E1: Build pricing metadata block
  const complexity = pricingEngine.classifyComplexity(syntheticForPricing);
  let pricingMeta;
  if (unlock_price !== undefined) {
    pricingMeta = {
      base_price: calculatedPrice,
      current_price: Number(unlock_price),
      builder_override_price: Number(unlock_price),
      complexity,
      last_repriced_at: new Date().toISOString()
    };
  } else {
    pricingMeta = {
      base_price: calculatedPrice,
      current_price: calculatedPrice,
      builder_override_price: null,
      complexity,
      last_repriced_at: new Date().toISOString()
    };
  }

  const learning = {
    id: generateId(),
    title,
    snippet: content.substring(0, 120) + (content.length > 120 ? '...' : ''),
    body: content,
    body_hash: bodyHash, // M-5: Store pre-computed hash for fast dedup on future submissions
    category,
    tags,
    task_context,
    outcome,
    unlock_price: resolvedPrice,
    pricing: pricingMeta,
    demand: { search_impressions_7d: 0, search_impressions_30d: 0, unlocks_7d: 0, unlocks_30d: 0 },
    contributor_wallet: walletLower || null,
    contributor_account_id,  // SPEC-P0.5: null if no JWT session, acc_... if logged in
    contributor_key_label: c.get('keyLabel') || null,  // D2: which key environment contributed
    contributor_agent: contributor_agent || 'unknown',
    related_skills: related_skills || [],
    ...(quality_self_assessment && { quality_self_assessment }),
    ...(extraction_context && { extraction_context }),
    quality: { unlocks: 0, ratings: 0, avg_helpfulness: 0, helpfulness_scores: [], score: 0 },
    earnings: { gross_usd: 0, contributor_share_usd: 0, platform_share_usd: 0 },
    // S21-2: Content moderation status.
    // When CONTENT_MODERATION_ENABLED=true, new learnings are 'pending_review' and
    // excluded from /discover and /knowledge results until approved.
    // When disabled (default), learnings are auto-approved.
    status: CONTENT_MODERATION_ENABLED ? 'pending_review' : 'approved',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  // SPEC-P1.1: Apply extraction_confidence ranking boost (capped at +5)
  if (quality_self_assessment && typeof quality_self_assessment.extraction_confidence === 'number') {
    learning.quality.score = Math.min(quality_self_assessment.extraction_confidence * 5, 5);
  }

  learnings.push(learning);
  safeWrite(LEARNINGS_FILE, learnings);

  // E1: Advisory if builder price differs > 3x from calculated (per V2 spec)
  const pricingAdvisory = (unlock_price !== undefined &&
    (Number(unlock_price) > calculatedPrice * 3 || Number(unlock_price) < calculatedPrice * 0.3))
    ? {
        calculated_price: calculatedPrice,
        builder_price: Number(unlock_price),
        message: 'Your price differs significantly from the calculated value. Consider adjusting.'
      }
    : undefined;

  return c.json({
    id: learning.id,
    message: CONTENT_MODERATION_ENABLED
      ? 'Learning submitted for review. It will be visible after approval.'
      : 'Learning submitted successfully',
    status: learning.status,
    unlock_price: resolvedPrice,
    pricing: learning.pricing,
    contributor_wallet: learning.contributor_wallet,
    ...(pricingAdvisory && { pricing_advisory: pricingAdvisory }),
    timestamp: new Date().toISOString()
  }, 201);
});

// ═══════════════════════════════════════════════════════════════════════════════
// P2.1a: Autonomous Extraction Pipeline (§3)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Load extraction config from model_config.json ───────────────────────────
const extractionConfig = (() => {
  try {
    const mc = JSON.parse(fs.readFileSync(path.join(__dirname, 'model_config.json'), 'utf-8'));
    return mc.extraction || {};
  } catch { return {}; }
})();
const EXTRACT_BODY_MAX = extractionConfig.transcript_limits?.max_body_bytes || 262144; // 256 KB
const EXTRACT_MIN_CHARS = extractionConfig.transcript_limits?.min_chars || 1500;
const EXTRACT_MAX_CHARS = extractionConfig.transcript_limits?.max_chars || 30000;
const EXTRACT_MAX_DEPTH = extractionConfig.transcript_limits?.max_json_depth || 10;
const EXTRACT_SOURCE_ALLOWLIST = extractionConfig.source_allowlist || ['claude-code', 'openclaw'];
const EXTRACT_RETRACTION_DAYS = extractionConfig.retraction_window_days || 7;

// ── Per-account rate limit state (§3.6) ─────────────────────────────────────
const extractRateLimits = new Map(); // accountId -> { daily, hourly, burst: [] }

function getExtractRateLimitState(accountId) {
  const now = Date.now();
  const utcDate = new Date().toISOString().split('T')[0];
  const utcHour = new Date().getUTCHours();
  let state = extractRateLimits.get(accountId);
  if (!state || state.date !== utcDate) {
    state = { date: utcDate, hour: utcHour, dailyCount: 0, hourlyCount: 0, burst: [] };
    extractRateLimits.set(accountId, state);
  }
  if (state.hour !== utcHour) {
    state.hour = utcHour;
    state.hourlyCount = 0;
  }
  // Clean burst window (keep only last 60s)
  state.burst = state.burst.filter(t => now - t < 60000);
  return state;
}

function getAccountTier(account) {
  // Check override config — config/ is canonical, data/ is legacy fallback
  try {
    let overridesPath = path.join(__dirname, 'config', 'extract-cap-overrides.json');
    if (!fs.existsSync(overridesPath)) overridesPath = path.join(__dirname, 'data', 'extract-cap-overrides.json');
    const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf-8'));
    if (overrides[account.id]) return { ...overrides[account.id], tier: 'override' };
  } catch { /* no overrides or parse error */ }

  const tiers = extractionConfig.rate_limits?.tiers || {};
  if (account.extraction_tier === 'trusted') return { ...tiers.trusted, tier: 'trusted' };
  if (account.extraction_tier === 'verified') return { ...tiers.verified, tier: 'verified' };
  // Default to unverified tier
  const hasBoundWallet = !!(account.wallets && account.wallets.length > 0);
  const hasPublishedLearning = learnings.some(l => l.contributor_account_id === account.id);
  if (hasBoundWallet && hasPublishedLearning) return { ...tiers.verified, tier: 'verified' };
  return { ...tiers.unverified, tier: 'unverified' };
}

function checkExtractRateLimit(accountId, tierCaps) {
  const state = getExtractRateLimitState(accountId);
  const daily = tierCaps.daily || tierCaps.daily_cap || 50;
  const hourly = tierCaps.hourly || tierCaps.hourly_cap || 30;
  const burstMax = tierCaps.burst_per_min || 5;
  if (state.dailyCount >= daily) return { allowed: false, reason: 'daily_cap', retryAfter: 'midnight UTC' };
  if (state.hourlyCount >= hourly) return { allowed: false, reason: 'hourly_cap', retryAfter: '3600' };
  if (state.burst.length >= burstMax) return { allowed: false, reason: 'burst_cap', retryAfter: '60' };
  return { allowed: true };
}

function recordExtractRequest(accountId) {
  const state = getExtractRateLimitState(accountId);
  state.dailyCount++;
  state.hourlyCount++;
  state.burst.push(Date.now());
}

// ── Global $-denominated circuit breaker (§3.6) ─────────────────────────────
// A3: Persistent to data/circuit-breaker.json — survives restarts.
const CIRCUIT_BREAKER_FILE = path.join(__dirname, 'data', 'circuit-breaker.json');

function persistCircuitBreaker() {
  try {
    const tmp = CIRCUIT_BREAKER_FILE + '.tmp';
    writeAndSync(tmp, JSON.stringify({
      date: circuitBreaker.date,
      spendUsd: circuitBreaker.spendUsd,
      killSwitchActive: circuitBreaker.killSwitchActive,
    }));
    fs.renameSync(tmp, CIRCUIT_BREAKER_FILE);
  } catch (e) {
    console.error('[CIRCUIT-BREAKER] Persist failed:', e.message);
  }
}

const circuitBreaker = {
  date: new Date().toISOString().split('T')[0],
  spendUsd: 0,
  killSwitchActive: false,
  softAlertSent: false,

  reset() {
    this.date = new Date().toISOString().split('T')[0];
    this.spendUsd = 0;
    this.softAlertSent = false;
    // Kill switch does NOT auto-reset — requires manual scripts/admin.js
  },

  checkDate() {
    const today = new Date().toISOString().split('T')[0];
    if (today !== this.date) {
      this.date = today;
      this.spendUsd = 0;
      this.softAlertSent = false;
      // Kill switch persists across midnight
    }
  },

  recordSpend(costUsd) {
    this.checkDate();
    this.spendUsd += costUsd;
    const thresholds = extractionConfig.rate_limits?.global_circuit_breaker || {};
    // $25 soft alert
    if (this.spendUsd >= (thresholds.soft_alert_usd || 25) && !this.softAlertSent) {
      this.softAlertSent = true;
      console.warn(`[CIRCUIT-BREAKER] Soft alert: daily extraction spend $${this.spendUsd.toFixed(4)} >= $25 threshold`);
    }
    persistCircuitBreaker();
  },

  getState() {
    this.checkDate();
    const thresholds = extractionConfig.rate_limits?.global_circuit_breaker || {};
    if (this.killSwitchActive) return 'kill_switch';
    if (this.spendUsd >= (thresholds.kill_switch_usd || 100)) {
      this.killSwitchActive = true;
      console.error(`[CIRCUIT-BREAKER] KILL SWITCH: daily extraction spend $${this.spendUsd.toFixed(4)} >= $100. Route disabled.`);
      persistCircuitBreaker();
      return 'kill_switch';
    }
    if (this.spendUsd >= (thresholds.hard_throttle_usd || 50)) return 'hard_throttle';
    return 'ok';
  },
};

// A3: Restore circuit breaker state from disk on boot
(function loadCircuitBreakerState() {
  try {
    if (!fs.existsSync(CIRCUIT_BREAKER_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CIRCUIT_BREAKER_FILE, 'utf-8'));
    const today = new Date().toISOString().split('T')[0];
    // Kill switch ALWAYS restores (survives midnight + restart)
    if (raw.killSwitchActive) {
      circuitBreaker.killSwitchActive = true;
      console.warn('[CIRCUIT-BREAKER] Kill switch restored from disk — still active');
    }
    // Spend only restores if same day
    if (raw.date === today) {
      circuitBreaker.date = raw.date;
      circuitBreaker.spendUsd = raw.spendUsd || 0;
      console.log(`[CIRCUIT-BREAKER] Restored spend $${circuitBreaker.spendUsd.toFixed(4)} for ${today}`);
    }
  } catch (e) {
    console.warn('[CIRCUIT-BREAKER] Failed to load state:', e.message);
  }
})();

// ── Sentinel file for kill switch reset (used by scripts/admin.js) ──────────
const KILL_SWITCH_RESET_FILE = path.join(__dirname, 'data', '.extract-kill-switch-reset');
function checkKillSwitchReset() {
  if (fs.existsSync(KILL_SWITCH_RESET_FILE)) {
    // B8: Ownership + permission check before trusting sentinel
    try {
      const st = fs.statSync(KILL_SWITCH_RESET_FILE);
      if ((st.mode & 0o022) !== 0) {
        console.error('[CIRCUIT-BREAKER] kill-switch-reset sentinel has unsafe permissions (group/world-writable), ignoring');
        return;
      }
      // Only check uid on platforms that support it (not Windows)
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
        console.error('[CIRCUIT-BREAKER] kill-switch-reset sentinel not owned by server uid, ignoring');
        return;
      }
    } catch (statErr) {
      console.error('[CIRCUIT-BREAKER] Could not stat kill-switch-reset sentinel:', statErr.message);
      return;
    }
    try { fs.unlinkSync(KILL_SWITCH_RESET_FILE); } catch {}
    circuitBreaker.killSwitchActive = false;
    persistCircuitBreaker();
    console.log('[CIRCUIT-BREAKER] Kill switch reset via sentinel file');
  }
}

// ── JSON depth checker (§3.4) ───────────────────────────────────────────────
function jsonDepth(obj, maxDepth = 10, current = 0) {
  if (current > maxDepth) return current;
  if (obj === null || typeof obj !== 'object') return current;
  let max = current;
  const keys = Object.keys(obj);
  if (keys.length > 200) return maxDepth + 1; // max keys per object exceeded
  for (const key of keys) {
    const d = jsonDepth(obj[key], maxDepth, current + 1);
    if (d > max) max = d;
    if (max > maxDepth) return max;
  }
  return max;
}

// ── Idempotency ledger helpers (§3.7) ────────────────────────────────────────
const EXTRACTIONS_FILE = path.join(__dirname, 'data', 'extractions.jsonl');
const REVIEW_FILE = path.join(__dirname, 'data', 'extraction-review.jsonl');

function checkIdempotency(accountId, idempotencyKey, sessionId, transcriptSha256) {
  if (!fs.existsSync(EXTRACTIONS_FILE)) return null;
  const content = fs.readFileSync(EXTRACTIONS_FILE, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const cutoff = Date.now() - (extractionConfig.idempotency_ttl_hours || 24) * 3600000;

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(lines[i]);
      if (new Date(row.ts).getTime() < cutoff) continue;
      if (row.account_id !== accountId) continue;
      // Layer 1: client-supplied Idempotency-Key
      if (idempotencyKey && row.idempotency_key === idempotencyKey) return row.response_cache;
      // Layer 2: content hash
      if (sessionId && transcriptSha256 &&
          row.session_id === sessionId && row.transcript_sha256 === transcriptSha256) {
        return row.response_cache;
      }
    } catch { continue; }
  }
  return null;
}

function recordExtraction(accountId, idempotencyKey, sessionId, transcriptSha256, response) {
  const row = {
    account_id: accountId,
    idempotency_key: idempotencyKey,
    session_id: sessionId,
    transcript_sha256: transcriptSha256,
    response_cache: response,
    ts: new Date().toISOString(),
  };
  fs.appendFileSync(EXTRACTIONS_FILE, JSON.stringify(row) + '\n', 'utf-8');
}

function parkForReview(extractionId, accountId, candidates) {
  const row = {
    extraction_id: extractionId,
    account_id: accountId,
    candidates,
    ts: new Date().toISOString(),
  };
  fs.appendFileSync(REVIEW_FILE, JSON.stringify(row) + '\n', 'utf-8');
}

// ── POST /extract — P2.1a Autonomous Extraction Pipeline (§3) ───────────────
// Rewired from adminAuth('admin') to per-account API key authentication.
// This is the server-side extraction endpoint. The client runner uploads a
// PII-scrubbed transcript; Auxilo calls the LLM subprocessor (Anthropic).
app.post('/extract', async (c) => {
  // ── Step 0: Check circuit breaker ─────────────────────────────────────
  checkKillSwitchReset();
  const cbState = circuitBreaker.getState();
  if (cbState === 'kill_switch') {
    return c.json({ error: 'Extraction service temporarily disabled', code: 'kill_switch' }, 503);
  }
  if (cbState === 'hard_throttle') {
    c.header('Retry-After', '3600');
    return c.json({ error: 'Extraction service throttled — daily spend limit reached', code: 'hard_throttle' }, 503);
  }

  // ── Step 1: API-key auth → account_id (reuses /learn pattern) ─────────
  let apiKey = c.req.header('X-API-Key');
  if (!apiKey) {
    const authH = c.req.header('Authorization') || '';
    if (authH.startsWith('Bearer ')) apiKey = authH.slice(7);
  }
  if (!apiKey) {
    return c.json({ error: 'Authentication required. Provide X-API-Key header.' }, 401);
  }

  const keyResult = validateApiKey(apiKey);
  if (!keyResult.valid) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  const accountId = keyResult.accountId;
  const accounts = loadAccounts();
  const account = accounts[accountId];
  if (!account) {
    return c.json({ error: 'Account not found' }, 401);
  }

  // Check account disabled
  if (account.disabled_at) {
    return c.json({ error: 'Account suspended' }, 403);
  }

  // ── Step 2: Consent-log check (§3.5) ──────────────────────────────────
  const consentState = getConsentState(accountId);
  if (!consentState || consentState.action !== 'grant') {
    return c.json({
      error: 'Autonomous extraction consent required',
      code: 'consent_required',
      message: 'Enable autonomous extraction in your account settings.',
    }, 403);
  }

  // ── Step 3: Mode check (§3.5) ─────────────────────────────────────────
  const accountMode = account.autonomous_extraction_mode || 'off';
  if (accountMode === 'off') {
    return c.json({ error: 'Autonomous extraction is disabled', code: 'disabled' }, 403);
  }

  // ── Step 4: Tiered rate limit check (§3.6) ────────────────────────────
  const tierCaps = getAccountTier(account);
  const rlCheck = checkExtractRateLimit(accountId, tierCaps);
  if (!rlCheck.allowed) {
    c.header('Retry-After', rlCheck.retryAfter);
    return c.json({
      error: 'Rate limit exceeded',
      code: rlCheck.reason,
      tier: tierCaps.tier,
    }, 429);
  }

  // ── Step 5: Body size pre-check (§3.4) ────────────────────────────────
  const contentLength = parseInt(c.req.header('content-length') || '0', 10);
  if (contentLength > EXTRACT_BODY_MAX) {
    return c.json({ error: 'Request body too large', max_bytes: EXTRACT_BODY_MAX }, 413);
  }

  // Parse body
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Streaming length guard — re-measure actual bytes (§3.4)
  const bodyStr = JSON.stringify(body);
  if (Buffer.byteLength(bodyStr, 'utf-8') > EXTRACT_BODY_MAX) {
    return c.json({ error: 'Request body too large (chunked bypass)', max_bytes: EXTRACT_BODY_MAX }, 413);
  }

  // JSON depth cap (§3.4)
  if (jsonDepth(body) > EXTRACT_MAX_DEPTH) {
    return c.json({ error: `JSON nesting exceeds maximum depth (${EXTRACT_MAX_DEPTH})` }, 400);
  }

  // ── Step 5b: Request validation (§3.4) ────────────────────────────────
  const { source, transcript, transcript_sha256, mode_hint, client_scrub_report } = body;

  if (!source || !source.type || !source.session_id) {
    return c.json({ error: 'source.type and source.session_id are required' }, 400);
  }
  if (!EXTRACT_SOURCE_ALLOWLIST.includes(source.type)) {
    return c.json({ error: `source.type must be one of: ${EXTRACT_SOURCE_ALLOWLIST.join(', ')}` }, 400);
  }
  if (!transcript || typeof transcript !== 'string') {
    return c.json({ error: 'transcript is required and must be a string' }, 400);
  }
  if (transcript.length < EXTRACT_MIN_CHARS || transcript.length > EXTRACT_MAX_CHARS) {
    return c.json({
      error: `transcript must be ${EXTRACT_MIN_CHARS}-${EXTRACT_MAX_CHARS} characters`,
      actual: transcript.length,
    }, 400);
  }

  // transcript_sha256 verification (§3.4)
  if (!transcript_sha256) {
    return c.json({ error: 'transcript_sha256 is required' }, 400);
  }
  const computedSha = crypto.createHash('sha256').update(transcript).digest('hex');
  if (computedSha !== transcript_sha256) {
    return c.json({ error: 'transcript_sha256 mismatch', expected: computedSha }, 400);
  }

  // contributor_wallet NEVER from body (§3.4)
  const contributorWallet = (account.wallets && account.wallets[0]) || null;

  // ── Step 6: Idempotency check (§3.7) ──────────────────────────────────
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!idempotencyKey) {
    return c.json({ error: 'Idempotency-Key header is required' }, 400);
  }
  const cached = checkIdempotency(accountId, idempotencyKey, source.session_id, transcript_sha256);
  if (cached) {
    return c.json(cached, 200);
  }

  // Record rate limit hit
  recordExtractRequest(accountId);

  // ── Step 7: OFAC screening (§3.8) ─────────────────────────────────────
  if (contributorWallet && checkOFAC(contributorWallet)) {
    logOFACBlock(contributorWallet, '/extract');
    return c.json({ error: 'Transaction blocked by sanctions compliance', code: 'ofac_blocked' }, 403);
  }

  // ── Step 8: Server-side scrub (§5.1 step 1) ──────────────────────────
  const serverScrub = scanText(transcript);
  if (!serverScrub.clean) {
    return c.json({
      error: 'Server-side sensitivity scan detected patterns in transcript',
      code: 'sensitivity_fail',
      patterns: serverScrub.matches.map(m => m.pattern),
    }, 422);
  }

  // ── Step 9: Provider call (§6) ────────────────────────────────────────
  const extractionId = 'ext_' + crypto.randomBytes(12).toString('hex');
  let providerResult;
  // B4: Accumulate real usage tokens across all chunks for audit row
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  try {
    // Build the extraction prompt using the extractor pipeline
    const llmCall = async (prompt) => {
      const result = await extractWithRetry(
        { prompt, maxTokens: 4096 },
        extractionConfig
      );
      // Record cost for circuit breaker
      const costUsd = ((result.usage.input_tokens * 3) + (result.usage.output_tokens * 15)) / 1_000_000;
      circuitBreaker.recordSpend(costUsd);
      // B4: Accumulate for audit row
      totalInputTokens += result.usage.input_tokens;
      totalOutputTokens += result.usage.output_tokens;
      totalCostUsd += costUsd;
      return result.text;
    };

    providerResult = await extractLearnings(transcript, {
      llmCall,
      searchFn: (query, opts) => matchLearnings(query, opts),
      contributor_wallet: contributorWallet,
    });
  } catch (err) {
    if (err instanceof ProviderAuthError) {
      console.error('[POST /extract] Provider auth error — page ops:', err.message);
      return c.json({ error: 'Extraction provider authentication failed', extraction_id: extractionId }, 502);
    }
    console.error('[POST /extract] Provider error:', err.message);
    return c.json({ error: 'Extraction failed', extraction_id: extractionId }, 502);
  }

  // ── P1-9: Surface extractor chunk failures ────────────────────────────
  // extractLearnings swallows per-chunk LLM errors into providerResult.errors
  // so a transient failure doesn't halt the whole pipeline. That's correct,
  // but if ALL chunks fail (e.g., ANTHROPIC_API_KEY invalid), we previously
  // returned 200 with learnings_found=0 and usage.input_tokens=0 — silent
  // failure that was hard to debug. Log explicitly so operators can see the
  // class of error without diving into audit rows.
  if (providerResult.stats) {
    const { chunks_processed, chunks_failed } = providerResult.stats;
    if (chunks_failed > 0) {
      const firstErr = (providerResult.errors || [])[0];
      const msg = firstErr ? firstErr.message : 'unknown';
      console.error(
        `[POST /extract] ${chunks_failed}/${chunks_processed} chunks failed LLM extraction: ${msg}`
      );
    }
  }

  // ── Steps 10-14: Post-extraction processing ───────────────────────────
  const candidates = providerResult.learnings || [];
  const published = [];
  const rejected = [];
  // ITEM-1 (Phase 8): Defer catalog mutation until after audit write succeeds.
  // Candidates are prepared but NOT pushed to learnings[] here — they are
  // collected in pendingCatalogEntries and only pushed after appendAuditRow.
  const pendingCatalogEntries = [];

  for (const candidate of candidates) {
    // Quality gate check
    const score = scoreLearning(candidate);
    if (!score.passed) {
      rejected.push({ reason: 'quality_gate', title: candidate.title, detail: score.failed_reason });
      continue;
    }

    // Category allowlist
    if (!EXTRACTOR_CATEGORIES.includes(candidate.category)) {
      rejected.push({ reason: 'category', title: candidate.title });
      continue;
    }

    // Post-extraction scrub (§5.1 step 5)
    const postScrub = scanLearning(candidate);
    if (!postScrub.clean) {
      rejected.push({ reason: 'sensitivity_filter', title: candidate.title });
      continue;
    }

    // Sanitize body (§5.1 step 6)
    const sanitized = sanitizeLearningBody(candidate.body);
    if (!sanitized.clean) {
      rejected.push({ reason: sanitized.reason, title: candidate.title });
      continue;
    }
    candidate.body = sanitized.sanitized;

    // ── Step 15: In-flight consent re-check (§3.5.4) ────────────────────
    const freshConsent = getConsentState(accountId, { forceReload: true });
    if (!freshConsent || freshConsent.action !== 'grant') {
      rejected.push({ reason: 'revoked_in_flight', title: candidate.title });
      continue;
    }

    // Check mode hasn't changed to 'off'
    const freshAccounts = loadAccounts();
    const freshAccount = freshAccounts[accountId];
    if (freshAccount && freshAccount.autonomous_extraction_mode === 'off') {
      rejected.push({ reason: 'revoked_in_flight', title: candidate.title });
      continue;
    }

    // ── Step 16: Mode branch (§5.1 step 8) ──────────────────────────────
    const effectiveMode = freshAccount?.autonomous_extraction_mode || accountMode;
    if (effectiveMode === 'automatic') {
      // Publish via /learn write path — stamp retraction window fields
      candidate.contributor_wallet = contributorWallet;
      candidate.contributor_account_id = accountId;
      candidate.contributor_agent = 'auxilo-autonomous-extractor/0.1.0';
      candidate.extraction_id = extractionId;
      candidate.retraction_window_active = true;
      candidate.retraction_window_ends = new Date(Date.now() + EXTRACT_RETRACTION_DAYS * 86400000).toISOString();
      candidate.published_via = 'autonomous_extraction';

      // Write to learnings store (reuse /learn write logic)
      const bodyHash = crypto.createHash('sha256').update(
        candidate.body.toLowerCase().replace(/\s+/g, ' ').trim()
      ).digest('hex');
      candidate.body_hash = bodyHash;

      const learningId = generateId();
      candidate.id = learningId;
      candidate.snippet = candidate.body.substring(0, 120) + (candidate.body.length > 120 ? '...' : '');
      candidate.unlock_price = candidate.unlock_price || 0.08;
      candidate.quality = { unlocks: 0, ratings: 0, avg_helpfulness: 0, helpfulness_scores: [], score: 0 };
      candidate.earnings = { gross_usd: 0, contributor_share_usd: 0, platform_share_usd: 0 };
      candidate.demand = { search_impressions_7d: 0, search_impressions_30d: 0, unlocks_7d: 0, unlocks_30d: 0 };
      candidate.status = 'approved';
      candidate.created_at = new Date().toISOString();
      candidate.updated_at = new Date().toISOString();

      // Defer: do NOT push to learnings[] yet — collect for post-audit commit
      pendingCatalogEntries.push(candidate);
      published.push({ id: learningId, title: candidate.title });
    } else {
      // Scheduled or Manual — park for review
      parkForReview(extractionId, accountId, [candidate]);
    }
  }

  // ── Step 17: Audit log FIRST, then catalog mutation (§9.1) ────────────
  // ITEM-1 (Phase 8): audit-before-mutate on publish path.
  // Same invariant as the retraction path (CORRECTION 1.5):
  // If appendAuditRow throws, the catalog must NOT be mutated.
  // B1: Use fresh consent version from the most recent in-flight recheck
  const auditConsentVersion = (() => {
    const fresh = getConsentState(accountId, { forceReload: true });
    return fresh ? fresh.consent_version : consentState.consent_version;
  })();

  // B20: Validate client_scrub_report.patterns_matched before writing to audit
  let validatedPatterns = [];
  if (Array.isArray(client_scrub_report?.patterns_matched)) {
    validatedPatterns = client_scrub_report.patterns_matched
      .filter(p => typeof p === 'string' && p.length <= 64 && /^[a-z_]+$/.test(p))
      .slice(0, 50);
  }

  let auditRef = extractionId;
  try {
    await appendAuditRow({
      account_id: accountId,
      consent_version: auditConsentVersion,
      action: published.length > 0 ? 'publish' : (rejected.length > 0 ? 'reject' : 'extract_attempt'),
      source: { type: source.type, session_id: source.session_id },
      transcript_sha256,
      transcript_length: transcript.length,
      scrubber_version: `sensitivity-filter@${SENSITIVITY_FILTER_VERSION}`,
      client_scrub_matches: validatedPatterns,
      server_scrub_matches: [],
      provider: 'anthropic',
      model: extractionConfig.primary?.model || 'claude-haiku-4-5',
      usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
      cost_usd: totalCostUsd,
      quality_pass_count: published.length + (accountMode !== 'automatic' ? candidates.length - rejected.length : 0),
      quality_fail_count: rejected.filter(r => r.reason === 'quality_gate').length,
      published_learning_ids: published.map(p => p.id),
      mode: accountMode,
    });
  } catch (auditErr) {
    // Audit write failed — do NOT mutate the catalog.
    // Move all published learnings to rejected to prevent orphan catalog entries.
    console.error('[POST /extract] Audit log write failed — blocking publication:', auditErr.message);
    const auditFailCount = published.length;
    for (const pub of published) {
      rejected.push({ reason: 'audit_integrity_error', title: pub.title, detail: auditErr.message });
    }
    published.length = 0;
    return c.json({
      error: 'Publication failed: audit integrity error',
      code: 'audit_integrity_error',
      detail: auditErr.message,
      extraction_id: extractionId,
      learnings_found: candidates.length,
      learnings_published: 0,
      learnings_rejected: rejected.length,
      rejections: rejected.map(({ reason, title }) => ({ reason, title })),
    }, 500);
  }

  // ── Catalog mutation: ONLY after successful audit write ────────────────
  // ITEM-1 (Phase 8): Now commit deferred candidates to the in-memory catalog.
  // pendingCatalogEntries were prepared in the loop but NOT pushed to learnings[]
  // until the audit row succeeded. This closes the in-memory mutation gap.
  if (published.length > 0) {
    for (const entry of pendingCatalogEntries) {
      learnings.push(entry);
    }
    safeWrite(LEARNINGS_FILE, learnings);
  }

  // ── Step 18: Response (§3.2 / §3.3) ──────────────────────────────────
  const response = {
    extraction_id: extractionId,
    learnings_found: candidates.length,
    learnings_published: published.length,
    learnings_rejected: rejected.length,
    rejections: rejected.map(({ reason, title }) => ({ reason, title })),
    audit_ref: auditRef,
    ...(accountMode === 'automatic' && published.length > 0 ? {
      retraction_window_ends: new Date(Date.now() + EXTRACT_RETRACTION_DAYS * 86400000).toISOString(),
    } : {}),
    ...(accountMode !== 'automatic' ? {
      pending_review_ids: candidates.filter((_, i) => !rejected.some(r => r.title === candidates[i]?.title)).map(c => c.id || extractionId),
    } : {}),
  };

  // Cache for idempotency
  recordExtraction(accountId, idempotencyKey, source.session_id, transcript_sha256, response);

  return c.json(response, 200);
});

// ── DELETE /learn/:id?reason=retract — Retraction (§5.2) ────────────────────
app.delete('/learn/:id', async (c) => {
  const learningId = c.req.param('id');
  const reason = (new URL(c.req.url, 'http://localhost')).searchParams.get('reason');

  // Auth: API key required
  let apiKey = c.req.header('X-API-Key');
  if (!apiKey) {
    const authH = c.req.header('Authorization') || '';
    if (authH.startsWith('Bearer ')) apiKey = authH.slice(7);
  }
  if (!apiKey) return c.json({ error: 'Authentication required' }, 401);

  const keyResult = validateApiKey(apiKey);
  if (!keyResult.valid) return c.json({ error: 'Invalid API key' }, 401);

  const accountId = keyResult.accountId;

  // Find the learning
  const learning = learnings.find(l => l.id === learningId);
  if (!learning) return c.json({ error: 'Learning not found' }, 404);

  // Verify ownership
  if (learning.contributor_account_id !== accountId) {
    return c.json({ error: 'Not authorized to retract this learning' }, 403);
  }

  if (reason === 'retract') {
    // Check retraction window
    const publishedAt = new Date(learning.created_at).getTime();
    const daysSincePublish = (Date.now() - publishedAt) / 86400000;

    if (daysSincePublish > EXTRACT_RETRACTION_DAYS) {
      return c.json({
        error: 'Retraction window expired',
        message: `Retraction is only available within ${EXTRACT_RETRACTION_DAYS} days of publication. Use the standard takedown process.`,
        published_at: learning.created_at,
        retraction_deadline: new Date(publishedAt + EXTRACT_RETRACTION_DAYS * 86400000).toISOString(),
      }, 409);
    }

    // CORRECTION 1.5: Audit FIRST, mutate SECOND.
    // The appendAuditRow guard throws on missing consent_version.
    // That throw MUST propagate — the try/catch is removed intentionally.
    // If audit fails, catalog stays unchanged and user gets 500.
    let auditResult;
    try {
      auditResult = await appendAuditRow({
        account_id: accountId,
        consent_version: getConsentState(accountId).consent_version,
        action: 'retract',
        source: { learning_id: learningId },
        transcript_sha256: learning.body_hash || '',
        transcript_length: 0,
        scrubber_version: `sensitivity-filter@${SENSITIVITY_FILTER_VERSION}`,
        client_scrub_matches: [],
        server_scrub_matches: [],
        provider: 'none',
        model: 'none',
        usage: { input_tokens: 0, output_tokens: 0 },
        cost_usd: 0,
        quality_pass_count: 0,
        quality_fail_count: 0,
        published_learning_ids: [],
        mode: 'retraction',
      });
    } catch (auditErr) {
      // Hard assertion or chain corruption — do NOT mutate catalog.
      console.error('[DELETE /learn/:id] Retraction audit write failed, catalog NOT mutated:', auditErr.message);
      return c.json({
        error: 'Retraction failed: audit integrity error',
        code: 'audit_integrity_error',
        detail: auditErr.message,
      }, 500);
    }

    // Audit succeeded — now safe to mutate catalog
    learning.retracted_at = new Date().toISOString();
    learning.retraction_window_active = false;
    learning.status = 'retracted';
    safeWrite(LEARNINGS_FILE, learnings);

    return c.json({
      id: learningId,
      status: 'retracted',
      message: 'Learning retracted from catalog. Existing unlocks and earnings are not affected.',
      audit_ref: auditResult.audit_id,
    }, 200);
  }

  return c.json({ error: 'reason=retract is the only supported retraction method' }, 400);
});

// ── PATCH /account/settings — Mode toggle + consent (§3.5) ──────────────────
app.patch('/account/settings', requireAuth, async (c) => {
  const accountId = c.get('accountId');
  if (!accountId) return c.json({ error: 'Authentication required' }, 401);

  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const accounts = loadAccounts();
  const account = accounts[accountId];
  if (!account) return c.json({ error: 'Account not found' }, 404);

  const validModes = ['off', 'automatic', 'manual']; // A6 Option B: 'scheduled' removed — no review surface exists. Deferred to P2.1b.
  const changes = {};

  if (body.autonomous_extraction_mode !== undefined) {
    if (!validModes.includes(body.autonomous_extraction_mode)) {
      return c.json({ error: `autonomous_extraction_mode must be one of: ${validModes.join(', ')}` }, 400);
    }

    const oldMode = account.autonomous_extraction_mode || 'off';
    const newMode = body.autonomous_extraction_mode;
    account.autonomous_extraction_mode = newMode;
    changes.autonomous_extraction_mode = { from: oldMode, to: newMode };

    // Consent log: grant when activating, revoke when turning off
    const ip = getClientIp(c);
    const ua = c.req.header('user-agent') || 'unknown';
    if (newMode !== 'off' && oldMode === 'off') {
      appendConsent({
        accountId,
        action: 'grant',
        consentVersion: extractionConfig.consent_version || '2026-04-14',
        ipRedacted: redactIp(ip),
        userAgent: ua,
      });
    } else if (newMode === 'off' && oldMode !== 'off') {
      appendConsent({
        accountId,
        action: 'revoke',
        consentVersion: extractionConfig.consent_version || '2026-04-14',
        ipRedacted: redactIp(ip),
        userAgent: ua,
      });
    }
  }

  saveAccounts(accounts);

  return c.json({
    message: 'Account settings updated',
    changes,
    current: {
      autonomous_extraction_mode: account.autonomous_extraction_mode || 'off',
    },
  }, 200);
});


// ── POST /extract/consent — Grant/revoke autonomous extraction consent ────
// P1-6 fast-follow: this route was documented in openapi.json and
// agent.json but never implemented. Real consent flow was via
// `PATCH /account/settings` with the mode toggle. This endpoint is a
// thin wrapper that maps action→mode (grant→automatic, revoke→off)
// and delegates to the same appendConsent path, so agents that follow
// openapi cold-read don't hit a 404.
app.post('/extract/consent', requireAuth, async (c) => {
  const accountId = c.get('accountId');
  if (!accountId) return c.json({ error: 'Authentication required' }, 401);

  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const action = body.action;
  if (action !== 'grant' && action !== 'revoke') {
    return c.json({ error: 'action must be "grant" or "revoke"' }, 400);
  }

  const accounts = loadAccounts();
  const account = accounts[accountId];
  if (!account) return c.json({ error: 'Account not found' }, 404);

  const oldMode = account.autonomous_extraction_mode || 'off';
  // P2.1a §3.5 — grant implies automatic (default); revoke flips to off.
  // Callers who want 'manual' mode use PATCH /account/settings directly.
  const newMode = action === 'grant' ? 'automatic' : 'off';

  if (oldMode === newMode && oldMode !== 'off') {
    // Idempotent re-grant when already on automatic — record the consent
    // row again so we have fresh timestamp + IP redaction, but don't
    // mutate the mode itself.
  }

  account.autonomous_extraction_mode = newMode;

  const ip = getClientIp(c);
  const ua = c.req.header('user-agent') || 'unknown';
  const consentVersion = body.consent_version || extractionConfig.consent_version || '2026-04-14';

  if (action === 'grant' && oldMode === 'off') {
    appendConsent({
      accountId,
      action: 'grant',
      consentVersion,
      ipRedacted: redactIp(ip),
      userAgent: ua,
    });
  } else if (action === 'revoke' && oldMode !== 'off') {
    appendConsent({
      accountId,
      action: 'revoke',
      consentVersion,
      ipRedacted: redactIp(ip),
      userAgent: ua,
    });
  }

  saveAccounts(accounts);

  return c.json({
    consent_recorded: true,
    action,
    consent_version: consentVersion,
    current: {
      autonomous_extraction_mode: newMode,
    },
  }, 200);
});


// Search knowledge (FREE — returns snippets, no full body)
app.post('/knowledge', optionalAuth(), apiKeyRateLimitMiddleware('/knowledge'), async (c) => {
  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body. Expected: { "query": "what you need help with" }' }, 400);
  }

  const { query, category, outcome, related_skill, limit = 5 } = body;
  if (!query || typeof query !== 'string') {
    return c.json({ error: 'Missing or invalid "query" field' }, 400);
  }

  const results = matchLearnings(query, { category, outcome, related_skill })
    .slice(0, Math.min(limit, 15));

  // FIX 2B: Record server-side search attribution for each result shown.
  // accountId is set by dualAuth when an API key is used; null for x402 callers.
  const callerAccountId = c.get('accountId') || null;
  for (const r of results) {
    recordSearchSource(callerAccountId, r.id);
  }

  // E2: Search impression tracking — increment counters on source learnings
  for (const r of results) {
    const srcLearning = learnings.find(l => l.id === r.id);
    if (srcLearning) {
      if (!srcLearning.demand) srcLearning.demand = { search_impressions_7d: 0, search_impressions_30d: 0, unlocks_7d: 0, unlocks_30d: 0 };
      srcLearning.demand.search_impressions_7d++;
      srcLearning.demand.search_impressions_30d++;
    }
  }
  // Don't save on every search — batch with existing periodic save

  return c.json({
    query,
    results_count: results.length,
    results: results.map(r => ({
      id: r.id,
      title: r.title,
      snippet: r.snippet,
      category: r.category,
      task_context: r.task_context,
      outcome: r.outcome,
      tags: r.tags,
      unlock_price_usd: r.pricing?.current_price || r.unlock_price || DEFAULT_UNLOCK_PRICE,
      current_price: r.pricing?.current_price || computeCurrentPrice(r, getCatalogStats()),
      quality: { score: computeScore(r), unlocks: r.quality.unlocks, ratings: r.quality.ratings, avg_helpfulness: r.quality.avg_helpfulness },
      relevance: r.relevance,
      value_signal: {
        estimated_diy_cost_usd: (r.pricing?.token_cost_estimate || 0) + (r.pricing?.time_value_estimate || 0),
        quality_score: r.pricing?.quality_multiplier || null,
        verdict: pricingEngine.calculateVerdict(r) || null
      }
    })),
    pricing: `Dynamic — each learning has its own unlock price (min $${MIN_UNLOCK_PRICE} USDC). See unlock_price_usd per result.`,
    timestamp: new Date().toISOString()
  });
});

// Knowledge marketplace stats (FREE) — must be registered BEFORE /knowledge/:id
app.get('/knowledge/stats', (c) => {
  // SPEC-P0.5: filter __wallet_index and other metadata keys from earnings totals
  const earningsEntries = Object.entries(earnings).filter(([k]) => !k.startsWith('__'));
  const totalEarnings = earningsEntries.reduce((sum, [, w]) => sum + (w.total_gross || 0), 0);
  // PD-1 fix: count unique contributor wallets from learnings, not earnings entries
  const contributorWallets = new Set(learnings.map(l => l.contributor_wallet).filter(Boolean));
  const totalContributors = contributorWallets.size;

  return c.json({
    learnings_count: learnings.length,
    categories: [...new Set(learnings.map(l => l.category))],
    total_unlocks: learnings.reduce((sum, l) => sum + (l.quality.unlocks || 0), 0),
    total_ratings: learnings.reduce((sum, l) => sum + (l.quality.ratings || 0), 0),
    total_earnings_usd: totalEarnings,
    total_contributors: totalContributors,
    top_learnings: learnings
      .map(l => ({ id: l.id, title: l.title, score: computeScore(l), unlocks: l.quality.unlocks || 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5),
    timestamp: new Date().toISOString()
  });
});

// Unlock full learning (PAID — dynamic price set by contributor)
app.get('/knowledge/:id', async (c) => {
  const id = c.req.param('id');
  const idx = learnings.findIndex(l => l.id === id);

  if (idx === -1) return c.json({ error: 'Learning not found', id }, 404);

  const learning = learnings[idx];

  // S21-2: Block access to non-approved learnings when moderation is enabled
  if (CONTENT_MODERATION_ENABLED && learning.status && learning.status !== 'approved') {
    return c.json({ error: 'Learning not found', id }, 404);
  }

  // E1: Dynamic pricing — prefer new pricing.current_price, then fall through to engine
  let UNLOCK_PRICE = getLockedPrice(learning.id);
  if (UNLOCK_PRICE === null) {
    UNLOCK_PRICE = learning.pricing?.current_price
      || pricingEngine.getCurrentPrice?.(learning, learnings)
      || learning.unlock_price
      || DEFAULT_UNLOCK_PRICE;
    lockPrice(learning.id, UNLOCK_PRICE);
  }

  // FIX 2C: Discovery premium via server-side cache (NOT client ?source= query param).
  // Cache entry set by POST /knowledge when this learning appeared in search results.
  // Single-use: entry is deleted after consumption to prevent re-use.
  const callerAccountId = c.get('accountId') || null;
  const cacheKey = `${callerAccountId}:${id}`;
  const cachedAt = callerAccountId ? searchSourceCache.get(cacheKey) : undefined;
  const isFromSearch = cachedAt !== undefined && (Date.now() - cachedAt < SEARCH_SOURCE_TTL_MS);
  if (callerAccountId && isFromSearch) searchSourceCache.delete(cacheKey); // single-use
  const source = isFromSearch ? 'search' : 'direct';
  const CONTRIBUTOR_SHARE = (source === 'search') ? CONTRIBUTOR_SHARE_DISCOVERY : CONTRIBUTOR_SHARE_STANDARD;
  const shareLabel = (source === 'search') ? '60%' : '70%';

  // Dynamic x402 verification — price comes from the learning itself
  const rejection = await dualAuthDynamic(c, UNLOCK_PRICE,
    `Unlock "${learning.title}" — ${UNLOCK_PRICE} USDC. ${shareLabel} goes to contributor.`, 'unlock', 'read');
  if (rejection) return rejection;

  // Track unlock
  learning.quality.unlocks = (learning.quality.unlocks || 0) + 1;

  // E2: Demand tracking — unlock counters for rolling windows
  if (!learning.demand) learning.demand = { search_impressions_7d: 0, search_impressions_30d: 0, unlocks_7d: 0, unlocks_30d: 0 };
  learning.demand.unlocks_7d++;
  learning.demand.unlocks_30d++;

  // Track earnings with source attribution
  const contributorEarned = UNLOCK_PRICE * CONTRIBUTOR_SHARE;
  const platformEarned = UNLOCK_PRICE * (1 - CONTRIBUTOR_SHARE);

  learning.earnings.gross_usd = (learning.earnings.gross_usd || 0) + UNLOCK_PRICE;
  learning.earnings.contributor_share_usd = (learning.earnings.contributor_share_usd || 0) + contributorEarned;
  learning.earnings.platform_share_usd = (learning.earnings.platform_share_usd || 0) + platformEarned;

  // SPEC-P0.5: Resolve contributor earnings entry via account_id (preferred) or wallet fallback
  const contribWallet = learning.contributor_wallet;
  const contribAccountId = learning.contributor_account_id || null;

  const { key: earningsKey, entry: earningsEntry, source: earningsSource } = resolveEarningsEntry(earnings, {
    account_id: contribAccountId,
    wallet: contribWallet,
  });

  // If no existing entry, create a zero-value entry keyed by account_id or wallet
  const resolvedEarningsKey = (earningsSource === 'new')
    ? (contribAccountId || contribWallet)
    : earningsKey;

  if (earningsSource === 'new') {
    earnings[resolvedEarningsKey] = initEarningsEntry(contribAccountId, contribWallet);
    // If wallet-keyed new entry, also update wallet index if account is known
    if (contribAccountId) {
      setWalletIndex(earnings, contribWallet.toLowerCase(), contribAccountId);
    }
  }

  const activeEntry = earnings[resolvedEarningsKey];

  activeEntry.total_gross += UNLOCK_PRICE;
  activeEntry.total_contributor += contributorEarned;
  activeEntry.total_platform += platformEarned;
  if (!activeEntry.by_learning[id]) {
    activeEntry.by_learning[id] = { gross: 0, contributor: 0, platform: 0, unlocks: 0 };
  }
  activeEntry.by_learning[id].gross += UNLOCK_PRICE;
  activeEntry.by_learning[id].contributor += contributorEarned;
  activeEntry.by_learning[id].platform += platformEarned;
  activeEntry.by_learning[id].unlocks += 1;
  activeEntry.pending_balance += contributorEarned;
  activeEntry.last_updated = new Date().toISOString();

  // SPEC-A2 C3: WAL-protected dual write — crash-safe atomicity
  // IMPL-A2-02: payload stores contributor_earned + platform_earned separately (not gross amount)
  // SPEC-P0.5: include contributor_account_id in WAL payload for recovery
  const walId = createWalEntry('unlock', {
    learning_id: id,
    builder_wallet: contribWallet,
    contributor_account_id: contribAccountId,
    unlock_price: UNLOCK_PRICE,
    contributor_earned: contributorEarned,
    platform_earned: platformEarned,
    purchaser_key_label: c.get('keyLabel') || null,  // D2: which key environment unlocked
  });

  safeWrite(LEARNINGS_FILE, learnings);
  markStepComplete(walId, 'update_learnings');

  safeWrite(EARNINGS_FILE, earnings);
  markStepComplete(walId, 'update_earnings');

  commitWal(walId);

  return c.json({
    ...learning,
    _revenue: {
      unlock_price_usd: UNLOCK_PRICE,
      contributor_earned_usd: contributorEarned,
      platform_earned_usd: platformEarned
    },
    timestamp: new Date().toISOString()
  });
});

// Rate a learning (FREE — quality signal)
// IR-H-001 FIX: per-IP + per-learning rate limit prevents rating manipulation
const ratingLimitMap = new Map(); // key: `${ip}:${learningId}` → timestamp

// FIX 2A: Server-side discovery-premium attribution cache.
// Tracks which learnings were shown to which account via /knowledge search.
// key: `${accountId}:${learningId}` → timestamp (ms)
// TTL: 1 hour. Cap: 10,000 entries (oldest half evicted when limit hit).
const searchSourceCache = new Map();
const SEARCH_SOURCE_TTL_MS = 3_600_000; // 1 hour
const SEARCH_SOURCE_MAX_ENTRIES = 10_000;

function recordSearchSource(accountId, learningId) {
  if (!accountId) return; // x402 callers have no accountId — safe to skip
  const key = `${accountId}:${learningId}`;
  if (searchSourceCache.size >= SEARCH_SOURCE_MAX_ENTRIES) {
    // Evict oldest half: convert to array, sort by value (timestamp), delete first half
    const sorted = Array.from(searchSourceCache.entries()).sort((a, b) => a[1] - b[1]);
    const half = Math.floor(sorted.length / 2);
    for (let i = 0; i < half; i++) searchSourceCache.delete(sorted[i][0]);
  }
  searchSourceCache.set(key, Date.now());
}
const RATING_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour per IP per learning

app.post('/knowledge/:id/rate', async (c) => {
  const id = c.req.param('id');
  const idx = learnings.findIndex(l => l.id === id);

  if (idx === -1) return c.json({ error: 'Learning not found', id }, 404);

  // IR-H-001 FIX: rate limit by IP + learning ID
  // IR-H-003 FIX: Use canonical getClientIp() instead of inline extraction
  const raterIp = getClientIp(c);
  const rateKey = `${raterIp}:${id}`;
  const lastRating = ratingLimitMap.get(rateKey) || 0;
  if (Date.now() - lastRating < RATING_COOLDOWN_MS) {
    return c.json({ error: 'Already rated this learning recently. Try again later.', retry_after: Math.ceil((RATING_COOLDOWN_MS - (Date.now() - lastRating)) / 1000) }, 429);
  }

  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { helpfulness, notes } = body;
  if (!helpfulness || helpfulness < 1 || helpfulness > 5) {
    return c.json({ error: 'helpfulness must be 1-5' }, 400);
  }

  ratingLimitMap.set(rateKey, Date.now()); // burn BEFORE mutation

  const learning = learnings[idx];
  learning.quality.ratings = (learning.quality.ratings || 0) + 1;
  learning.quality.helpfulness_scores = learning.quality.helpfulness_scores || [];
  learning.quality.helpfulness_scores.push(helpfulness);
  learning.quality.avg_helpfulness = learning.quality.helpfulness_scores.reduce((a, b) => a + b, 0) / learning.quality.helpfulness_scores.length;
  learning.updated_at = new Date().toISOString();

  safeWrite(LEARNINGS_FILE, learnings);

  // Append-only JSONL log (crash-safe, distinct from safeWrite)
  const ratingEntry = { learning_id: id, helpfulness, notes: notes || null, timestamp: new Date().toISOString() };
  fs.appendFileSync(RATINGS_FILE, JSON.stringify(ratingEntry) + '\n');

  return c.json({
    recorded: true,
    learning_id: id,
    new_avg_helpfulness: learning.quality.avg_helpfulness,
    total_ratings: learning.quality.ratings
  });
});

// ─── E2: GET /pricing/categories — Category demand & pricing analytics (PUBLIC) ──
app.get('/pricing/categories', (c) => {
  const categoryData = {};
  for (const learning of learnings) {
    const cat = learning.category;
    if (!cat) continue;
    if (!categoryData[cat]) {
      categoryData[cat] = { count: 0, total_price: 0, unlocks_30d: 0, impressions_30d: 0 };
    }
    categoryData[cat].count++;
    categoryData[cat].total_price += (learning.pricing?.current_price || learning.unlock_price || DEFAULT_UNLOCK_PRICE);
    categoryData[cat].unlocks_30d += (learning.demand?.unlocks_30d || 0);
    categoryData[cat].impressions_30d += (learning.demand?.search_impressions_30d || 0);
  }

  return c.json({
    categories: Object.entries(categoryData).map(([cat, data]) => ({
      category: cat,
      learning_count: data.count,
      avg_price: Number((data.total_price / data.count).toFixed(4)),
      monthly_unlocks: data.unlocks_30d,
      monthly_impressions: data.impressions_30d,
      conversion_rate: data.impressions_30d > 0
        ? Number((data.unlocks_30d / data.impressions_30d).toFixed(4))
        : 0
    }))
  });
});

// ─── E2: GET /contributor/:wallet/pricing-insights — Builder analytics (PUBLIC) ──
app.get('/contributor/:wallet/pricing-insights', (c) => {
  const wallet = c.req.param('wallet');
  const builderLearnings = learnings.filter(l => l.contributor_wallet === wallet.toLowerCase());

  if (builderLearnings.length === 0) return c.json({ error: 'No learnings found for this wallet' }, 404);

  const prices = builderLearnings.map(l => l.pricing?.current_price || l.unlock_price || DEFAULT_UNLOCK_PRICE);
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

  const tiers = { micro: 0, standard: 0, premium: 0, expert: 0 };
  for (const p of prices) {
    if (p < 0.10) tiers.micro++;
    else if (p < 1.00) tiers.standard++;
    else if (p < 10.00) tiers.premium++;
    else tiers.expert++;
  }

  const topEarners = builderLearnings
    .sort((a, b) => (b.demand?.unlocks_30d || 0) - (a.demand?.unlocks_30d || 0))
    .slice(0, 5)
    .map(l => ({
      id: l.id,
      title: l.title,
      price: l.pricing?.current_price || l.unlock_price,
      unlocks_30d: l.demand?.unlocks_30d || 0
    }));

  return c.json({
    total_learnings: builderLearnings.length,
    avg_price: Number(avgPrice.toFixed(4)),
    price_distribution: tiers,
    top_earning_learnings: topEarners
  });
});

// Contributor earnings dashboard (FREE)
app.get('/contributor/:wallet', (c) => {
  const wallet = c.req.param('wallet').toLowerCase();

  // SPEC-P0.5: resolve via __wallet_index first, then direct wallet key
  const { entry: data, source } = resolveEarningsEntry(earnings, { wallet });

  if (source === 'new') {
    return c.json({
      wallet,
      message: 'No earnings found for this wallet',
      total_contributor_usd: 0,
      learnings_submitted: learnings.filter(l => l.contributor_wallet === wallet).length
    });
  }

  return c.json({
    wallet,
    total_gross_usd: data.total_gross,
    total_contributor_usd: data.total_contributor,
    total_platform_usd: data.total_platform,
    pending_balance: data.pending_balance || 0,
    total_withdrawn: data.total_withdrawn || 0,
    withdrawal_count: data.withdrawal_count || 0,
    by_learning: data.by_learning,
    learnings_submitted: learnings.filter(l => l.contributor_wallet === wallet).length,
    last_updated: data.last_updated
  });
});

const RESERVATIONS_FILE = path.join(DATA_DIR, 'reservations.json');

function loadReservations() {
  return loadDataFile(RESERVATIONS_FILE, {}, false); // M-E: NON-CRITICAL
}

function saveReservations(reservations) {
  const tmp = RESERVATIONS_FILE + '.tmp';
  const strData = JSON.stringify(reservations, null, 2);
  writeAndSync(tmp, strData); // S9-3: fsync before rename for crash durability
  fs.renameSync(tmp, RESERVATIONS_FILE);
}

function createReservation(walletAddress, amount) {
  const reservations = loadReservations();
  reservations[walletAddress] = {
    amount,
    created_at: Math.floor(Date.now() / 1000),
    status: 'reserved'
  };
  saveReservations(reservations);
}

function commitReservation(walletAddress) {
  const reservations = loadReservations();
  if (reservations[walletAddress]) {
    reservations[walletAddress].status = 'committed';
    saveReservations(reservations);
  }
}

function releaseReservation(walletAddress) {
  const reservations = loadReservations();
  if (reservations[walletAddress]) {
    reservations[walletAddress].status = 'released';
    saveReservations(reservations);
  }
}

const lastWithdrawalAttempt = {};
const WITHDRAWAL_RATE_LIMIT_MS = 3600000; // 1 hour

// ─── M-A: Rate Limit Persistence ─────────────────────────────────────────────
// Batch-writes dirty rate limit state to RATE_LIMITS_FILE every 30s.
// All three stores (challengeRateLimit, learnRateStore, lastWithdrawalAttempt)
// are now declared above, so we can safely reference them here.

let rateLimitsDirty = false;

function markRateLimitsDirty() {
  rateLimitsDirty = true;
}

/**
 * Serialize all three rate limit stores to disk (atomic write).
 * Only writes when rateLimitsDirty is true.  Resets flag on success.
 */
function saveRateLimits() {
  if (!rateLimitsDirty) return;
  try {
    const payload = {
      _saved_at: new Date().toISOString(),
      challengeRateLimit: Object.fromEntries(challengeRateLimit),
      learnRateStore: learnRateStore,
      lastWithdrawalAttempt: lastWithdrawalAttempt,
    };
    const tmp = RATE_LIMITS_FILE + '.tmp';
    writeAndSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, RATE_LIMITS_FILE);
    rateLimitsDirty = false;
  } catch (e) {
    console.error('[M-A] Failed to save rate limits:', e.message);
    // Non-fatal — next interval will retry
  }
}

/**
 * Load persisted rate limit state from disk.
 * Handles missing/corrupted files by logging a warning and starting fresh.
 */
function loadRateLimits() {
  if (!fs.existsSync(RATE_LIMITS_FILE)) return;
  try {
    const raw = fs.readFileSync(RATE_LIMITS_FILE, 'utf8');
    const data = JSON.parse(raw);

    // Restore challengeRateLimit (Map)
    if (data.challengeRateLimit && typeof data.challengeRateLimit === 'object') {
      const now = Date.now();
      for (const [key, val] of Object.entries(data.challengeRateLimit)) {
        // Only restore entries still within their window
        if (val && typeof val.window_start === 'number' && (now - val.window_start) < CHALLENGE_RATE_WINDOW) {
          challengeRateLimit.set(key, val);
        }
      }
    }

    // Restore learnRateStore (plain object with ip/wallet sub-objects)
    if (data.learnRateStore && typeof data.learnRateStore === 'object') {
      const now = Date.now();
      for (const type of ['ip', 'wallet']) {
        if (data.learnRateStore[type] && typeof data.learnRateStore[type] === 'object') {
          for (const [key, timestamps] of Object.entries(data.learnRateStore[type])) {
            if (Array.isArray(timestamps)) {
              const valid = timestamps.filter(ts => typeof ts === 'number' && (now - ts) < LEARN_RATE_LIMIT.window_ms);
              if (valid.length > 0) {
                learnRateStore[type][key] = valid;
              }
            }
          }
        }
      }
    }

    // Restore lastWithdrawalAttempt (plain object)
    if (data.lastWithdrawalAttempt && typeof data.lastWithdrawalAttempt === 'object') {
      const now = Date.now();
      for (const [key, ts] of Object.entries(data.lastWithdrawalAttempt)) {
        if (typeof ts === 'number' && (now - ts) < WITHDRAWAL_RATE_LIMIT_MS) {
          lastWithdrawalAttempt[key] = ts;
        }
      }
    }

    console.log('[M-A] Rate limit state restored from disk.');
  } catch (e) {
    console.warn(`[M-A] [WARNING] Corrupted rate-limits.json — starting fresh: ${e.message}`);
    // Non-fatal: start with empty stores (already initialized above)
  }
}

// Load persisted state at startup (before routes start processing)
loadRateLimits();

// Batch write every 30 seconds
const rateLimitFlushInterval = setInterval(saveRateLimits, 30_000);
rateLimitFlushInterval.unref(); // Don't prevent process exit

// S9-2: Periodic sweep to remove expired entries from unbounded in-memory rate limit stores
// Prevents memory growth from unique IPs/wallets that send one request and never return.
// Runs every 10 minutes; timer is .unref()'d so it never blocks graceful shutdown.
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

function sweepRateLimitStores() {
  const now = Date.now();

  // 1. challengeRateLimit Map: delete entries whose window has fully expired
  for (const [key, val] of challengeRateLimit) {
    if (now - val.window_start > CHALLENGE_RATE_WINDOW) {
      challengeRateLimit.delete(key);
    }
  }

  // 2. learnRateStore: delete keys where ALL timestamps are older than the 60s window
  for (const type of ['ip', 'wallet']) {
    for (const key of Object.keys(learnRateStore[type])) {
      const valid = learnRateStore[type][key].filter(ts => (now - ts) < LEARN_RATE_LIMIT.window_ms);
      if (valid.length === 0) {
        delete learnRateStore[type][key];
      } else {
        learnRateStore[type][key] = valid;
      }
    }
  }

  // 3. ratingLimitMap: delete entries older than the 1-hour cooldown window
  for (const [key, ts] of ratingLimitMap) {
    if (now - ts > RATING_COOLDOWN_MS) {
      ratingLimitMap.delete(key);
    }
  }

  // 4. S21-3: reportRateStore: delete entries where ALL timestamps are older than 1-hour window
  for (const [ip, timestamps] of reportRateStore) {
    const valid = timestamps.filter(ts => now - ts < REPORT_RATE_WINDOW_MS);
    if (valid.length === 0) {
      reportRateStore.delete(ip);
    } else {
      reportRateStore.set(ip, valid);
    }
  }

  // 5. FIX 4: x402WalletRateLimitStore — delete entries where ALL timestamps are older
  //    than RATE_LIMIT_WINDOW_MS (1-minute sliding window for x402 per-wallet rate limit).
  for (const [wallet, timestamps] of x402WalletRateLimitStore) {
    const valid = timestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
    if (valid.length === 0) {
      x402WalletRateLimitStore.delete(wallet);
    } else {
      x402WalletRateLimitStore.set(wallet, valid);
    }
  }

  // 6. FIX 5: newAccountCreationStore (lib/accounts.js) — delete entries whose
  //    24-hour window has fully expired. Uses NEW_ACCOUNT_WINDOW_MS exported from
  //    accounts.js to stay in sync with the source-of-truth constant.
  for (const [ip, entry] of newAccountCreationStore) {
    if ((now - entry.windowStart) >= NEW_ACCOUNT_WINDOW_MS) {
      newAccountCreationStore.delete(ip);
    }
  }
}

const rateLimitCleanupInterval = setInterval(sweepRateLimitStores, RATE_LIMIT_CLEANUP_INTERVAL_MS);
rateLimitCleanupInterval.unref(); // Don't prevent process exit

// ─── E2: Daily Pricing Cron ──────────────────────────────────────────────────
function runDailyPricingCron() {
  try {
    const catalog = learnings.slice(); // snapshot to avoid mutation during iteration
    let repriced = 0;

    for (const learning of catalog) {
      if (!learning.pricing) continue;

      const oldPrice = learning.pricing.current_price;
      const newPrice = pricingEngine.getCurrentPrice(learning, catalog);

      // Rate limit: max 15% change per day
      const maxUp = oldPrice * 1.15;
      const maxDown = oldPrice * 0.85;
      let adjusted = Math.max(maxDown, Math.min(maxUp, newPrice));
      adjusted = Math.max(MIN_UNLOCK_PRICE, Math.min(MAX_UNLOCK_PRICE, adjusted));

      learning.pricing.current_price = Number(adjusted.toFixed(6));
      learning.pricing.last_repriced_at = new Date().toISOString();
      learning.unlock_price = learning.pricing.current_price;
      repriced++;
    }

    // Roll demand windows: approximate daily decay for 7d rolling window (~1/7 per day)
    for (const learning of catalog) {
      if (learning.demand) {
        learning.demand.search_impressions_7d = Math.max(0, Math.floor(learning.demand.search_impressions_7d * 0.857));
        learning.demand.unlocks_7d = Math.max(0, Math.floor(learning.demand.unlocks_7d * 0.857));
      }
    }

    safeWrite(LEARNINGS_FILE, learnings);
    console.log(`[pricing-cron] Repriced ${repriced} learnings`);
  } catch (err) {
    console.error('[pricing-cron] Error:', err.message);
  }
}

// Run 30s after startup, then every 24 hours
const _pricingCronStartup = setTimeout(runDailyPricingCron, 30000);
if (_pricingCronStartup.unref) _pricingCronStartup.unref();
const _pricingCronInterval = setInterval(runDailyPricingCron, 24 * 60 * 60 * 1000);
if (_pricingCronInterval.unref) _pricingCronInterval.unref();

// Base L2 gas estimate for ERC-20 transfers (USDC). Configurable via GAS_ESTIMATE_USD env var.
// Falls back to $0.005 with a warning if the value is invalid (NaN, negative, or > $1.00).
const _rawGasEst = parseFloat(process.env.GAS_ESTIMATE_USD || '0.005');
const GAS_ESTIMATE_USD = (!isNaN(_rawGasEst) && _rawGasEst >= 0 && _rawGasEst <= 1.0)
  ? _rawGasEst
  : (() => { console.warn('[withdraw] GAS_ESTIMATE_USD env var is invalid; falling back to $0.005'); return 0.005; })();

// Request a withdrawal (FREE, Auth via EIP-712 Signature — SPEC-A3)
app.post('/withdraw', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const { wallet, signature } = body;

  if (!wallet || !signature) {
    return c.json({ error: 'wallet and signature required' }, 400);
  }

  // IMPL-03: Restore isAddress validation
  if (!isAddress(wallet)) {
    return c.json({ error: 'Valid wallet address required' }, 400);
  }

  const walletLower = wallet.toLowerCase();
  if (!verifiedWallets[walletLower]) return c.json({ error: 'Wallet not verified' }, 403);

  // S22-1: OFAC screening before withdrawal
  if (checkOFAC(wallet)) {
    logOFACBlock(wallet, '/withdraw');
    return c.json({ error: 'Transaction blocked by sanctions compliance' }, 403);
  }

  // SPEC-P0.5: resolve via __wallet_index (account-keyed) or direct wallet key
  const { entry, source: withdrawSource } = resolveEarningsEntry(earnings, { wallet: walletLower });
  if (withdrawSource === 'new' || typeof entry.pending_balance !== 'number' || entry.pending_balance < 0.05) {
    return c.json({ error: 'Insufficient pending balance (min $0.05 USDC)' }, 400);
  }

  // FIX 1A: Deduct gas estimate — builder pays withdrawal fees (see module-level GAS_ESTIMATE_USD).
  const gross_balance = Number(entry.pending_balance.toFixed(6));
  const net_payout = Number((gross_balance - GAS_ESTIMATE_USD).toFixed(6));
  if (net_payout <= 0) {
    return c.json({
      error: 'Balance too low to cover withdrawal fee',
      pending_balance_usd: gross_balance,
      gas_estimate_usd: GAS_ESTIMATE_USD,
    }, 400);
  }
  console.log(`[withdraw] Gas fee deduction: $${GAS_ESTIMATE_USD} | gross: $${gross_balance} | net: $${net_payout} | wallet: ${walletLower}`);

  // Server-side computed payout amount (IMPL-05: never trust client-provided amount)
  const payout_amount = net_payout;

  // C7 FIX: Consume withdrawal nonce BEFORE verification
  const nonceData = consumeNonce(wallet);
  if (!nonceData || nonceData.action !== 'withdrawal') {
    return c.json({ error: 'No active withdrawal challenge or challenge expired. Request a new challenge with action: "withdrawal".' }, 400);
  }

  // H1 FIX: Verify EIP-712 withdrawal signature
  // IMPL-05: amount in signed message must match server-side payout_amount
  try {
    const validSig = await verifyWithdrawalSignature(
      wallet,
      payout_amount.toString(),
      nonceData.nonce,
      nonceData.timestamp,
      signature
    );
    if (!validSig) return c.json({ error: 'Withdrawal signature verification failed' }, 401);
  } catch (err) {
    console.error('[POST /withdraw] Signature verification error:', err.message);
    return c.json({ error: 'Signature verification failed' }, 400);
  }

  // IMPL-A1-01 / IMPL-A1-02 fixes: use walletLower and entry.pending_balance!
  const releaseLock = await acquireWalletLock(walletLower);

  try {
    // 2. Rate limit — burns on ALL attempts (AR-1 / AUDIT-04)
    const lastAttempt = lastWithdrawalAttempt[walletLower] || 0;
    const timeSinceLastAttempt = Date.now() - lastAttempt;
    lastWithdrawalAttempt[walletLower] = Date.now(); // Burn BEFORE any checks
    markRateLimitsDirty(); // M-A

    if (timeSinceLastAttempt < WITHDRAWAL_RATE_LIMIT_MS) {
      const retry_after = Math.ceil((WITHDRAWAL_RATE_LIMIT_MS - timeSinceLastAttempt) / 1000);
      return c.json({ error: 'Rate limited. One withdrawal per hour.', retry_after }, 429);
    }

    // IR-H-008 FIX: Re-resolve earnings INSIDE the lock to prevent TOCTOU.
    // The pre-lock resolveEarningsEntry (line ~1904) is a fast-fail gating check.
    // Here we re-resolve under exclusive lock to get authoritative balance,
    // then verify the signed amount still matches (reject 409 if balance changed).
    const { entry: freshEntry, source: freshSource } = resolveEarningsEntry(earnings, { wallet: walletLower });
    if (freshSource === 'new' || !freshEntry || typeof freshEntry.pending_balance !== 'number') {
      return c.json({ error: 'No earnings found' }, 404);
    }

    const freshPayout = Number((freshEntry.pending_balance - GAS_ESTIMATE_USD).toFixed(6));
    if (freshPayout !== payout_amount) {
      // Balance changed between pre-lock check and lock acquisition.
      // The EIP-712 signature commits to payout_amount, which is now stale.
      return c.json({
        error: 'Balance changed since withdrawal was initiated. Please request a new withdrawal challenge.',
        stale_amount: payout_amount,
        current_amount: freshPayout
      }, 409);
    }

    const pendingBalance = freshEntry.pending_balance;
    if (pendingBalance < payout_amount) {
      return c.json({ error: 'Insufficient balance', available: pendingBalance }, 400);
    }
    if (payout_amount < 0.05) {
      return c.json({ error: 'Minimum withdrawal is $0.05 USDC' }, 400);
    }

    // 4. Check platform balance via TxManager (A0)
    const { sufficient, balance: platformBalance } = await checkBalance(payout_amount);
    if (!sufficient) {
      return c.json({
        error: 'Platform has insufficient funds. Try again later.',
        retry_after: 3600
      }, 503);
    }

    // 5. Create reservation (balance NOT deducted yet — C8 fix)
    createReservation(walletLower, payout_amount);

    // 6. Create settlement record
    // IR-H-006 FIX: Use crypto.randomUUID() instead of Math.random() for settlement IDs
    const settlementId = `wd_${crypto.randomUUID()}`;
    const settlementTemplate = {
      id: settlementId,
      wallet: walletLower, // Used walletLower
      amount: payout_amount,
      timestamp: new Date().toISOString()
    };

    // 7. Create WAL entry for the dual-write (AUDIT-05)
    const walId = createWalEntry('withdraw', {
      wallet_address: walletLower,
      amount: payout_amount,
      settlement_id: settlementId,
      earnings_before: { ...freshEntry }  // IR-H-008: use freshEntry resolved under lock
    });

    // 8. Broadcast via TxManager (A0 — global mutex + nonce)
    let txResult;
    try {
      txResult = await sendUSDC(walletLower, payout_amount);
    } catch (err) {
      // Pre-broadcast failure — TxManager couldn't even attempt (AR-6 → 503)
      releaseReservation(walletLower);
      commitWal(walId); // Nothing to recover
      appendSettlement({
        ...settlementTemplate,
        status: 'failed',
        error: err.message,
        retry_count: 0
      });
      return c.json({
        error: 'Withdrawal failed. Funds not sent.',
        retry_after: 60
      }, 503);
    }

    // 9. Handle TxManager result
    if (txResult.status === 'confirmed') {
      // SUCCESS — WAL-protected dual-write

      // Step A: Deduct from earnings (IR-H-008: use freshEntry resolved under lock)
      freshEntry.total_withdrawn = parseFloat((freshEntry.total_withdrawn + payout_amount).toFixed(6));
      freshEntry.withdrawal_count = (freshEntry.withdrawal_count || 0) + 1;
      freshEntry.pending_balance = parseFloat((freshEntry.pending_balance - payout_amount).toFixed(6));
      if (!freshEntry.processed_settlements) freshEntry.processed_settlements = {};
      freshEntry.processed_settlements[settlementId] = true;

      safeWrite(EARNINGS_FILE, earnings);
      markStepComplete(walId, 'earnings_deducted');

      // Step B: Append settled record
      appendSettlement({
        ...settlementTemplate,
        tx_hash: txResult.hash,
        status: 'settled',
        retry_count: 0
      });
      markStepComplete(walId, 'settlement_appended');

      // Commit WAL + reservation
      commitWal(walId);
      commitReservation(walletLower);

      return c.json({
        settlement_id: settlementId,
        status: 'settled',
        tx_hash: txResult.hash,
        amount: payout_amount,
        message: 'Withdrawal confirmed on-chain.'
      }, 200);

    } else if (txResult.status === 'timeout') {
      // Post-broadcast timeout — tx was sent but not confirmed (AR-6 → 202)
      // Reservation stays "reserved" — A2's daemon resolves after 24h
      appendSettlement({
        ...settlementTemplate,
        tx_hash: txResult.hash,
        status: 'processing_timeout',
        retry_count: 0
      });
      // Do NOT commit WAL — recovery will complete the dual-write if tx confirms later
      // Do NOT release reservation — daemon handles it

      return c.json({
        settlement_id: settlementId,
        status: 'pending',
        tx_hash: txResult.hash,
        message: 'Transaction broadcast. Polling for confirmation.',
        poll_url: `/settlement/${settlementId}`
      }, 202);

    } else {
      // Failed — broadcast attempted but failed
      releaseReservation(walletLower);
      commitWal(walId); // Nothing to recover
      appendSettlement({
        ...settlementTemplate,
        tx_hash: txResult.hash,
        status: 'failed',
        error: txResult.error || 'Broadcast failed',
        retry_count: 0
      });

      return c.json({
        error: 'Withdrawal failed. Funds not sent.',
        retry_after: 60
      }, 503);
    }

  } finally {
    // ALWAYS release per-wallet mutex
    releaseLock();
  }
});

app.get('/contributor/:wallet/settlements', (c) => {
  const walletLower = c.req.param('wallet').toLowerCase();
  // SPEC-P0.5: resolve via __wallet_index (account-keyed) or direct wallet key
  const { entry, source: settleSource } = resolveEarningsEntry(earnings, { wallet: walletLower });
  if (settleSource === 'new') return c.json({ error: 'Wallet not found' }, 404);

  // AU-7: Cache settlement lookup results per wallet
  const cacheKey = `settlements:${walletLower}`;
  const cached = getCachedSettlement(cacheKey);

  let settlements;
  if (cached) {
    settlements = cached;
  } else {
    settlements = [];
    if (fs.existsSync(SETTLEMENTS_FILE)) {
      const lines = fs.readFileSync(SETTLEMENTS_FILE, 'utf8').split('\n').filter(Boolean);
      const latestState = {};
      lines.forEach(line => {
        try {
          const s = JSON.parse(line);
          if (s.wallet === walletLower) {
            latestState[s.id] = s;
          }
        } catch (e) {
          // Ignore malformed lines
        }
      });
      settlements = Object.values(latestState).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }
    setCachedSettlement(cacheKey, settlements);
  }

  return c.json({
    wallet: walletLower,
    pending_balance: entry.pending_balance,
    total_withdrawn: entry.total_withdrawn,
    settlements
  });
});

// ─── Admin Auth Middleware (H4 + H5) ─────────────────────────────────────────
// Wraps verifyAdminToken into a Hono middleware factory.
// requiredScope: 'read' for GET endpoints, 'admin' for mutation endpoints.
function adminAuth(requiredScope = 'read') {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const result = verifyAdminToken(token, requiredScope);

    if (!result.valid) {
      // Generic 401 — no information leakage about which check failed
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Attach scope to context for handlers that care
    c.set('adminScope', result.scope);
    await next();
  };
}

// GET /admin/settlements — read scope sufficient (admin token also accepted)
app.get('/admin/settlements', adminAuth('read'), async (c) => {
  let ethBalance = 'Unknown';
  let usdcBalance = 'Unknown';
  const _adminPc = getPublicClient();
  const _adminWallet = getWalletAddress();
  if (_adminPc && _adminWallet) {
    try {
      const bal = await _adminPc.getBalance({ address: _adminWallet });
      const { formatUnits } = require('viem');
      ethBalance = `${parseFloat(formatUnits(bal, 18)).toFixed(6)} ETH`;
    } catch (e) { console.error('Admin ETH balance check failed:', e.message); }
    try {
      const usdcBal = await _adminPc.readContract({
        address: USDC_BASE, abi: ERC20_ABI,
        functionName: 'balanceOf', args: [_adminWallet],
      });
      const { formatUnits } = require('viem');
      usdcBalance = `${parseFloat(formatUnits(usdcBal, 6)).toFixed(6)} USDC`;
    } catch (e) { console.error('Admin USDC balance check failed:', e.message); }
  }
  return c.json({
    platform_wallet: _adminWallet || 'None',
    eth_balance: ethBalance,
    usdc_balance: usdcBalance,
    // SPEC-P0.5: filter __wallet_index and other metadata keys from aggregate totals
    total_platform_earnings: Object.entries(earnings).filter(([k]) => !k.startsWith('__')).reduce((s, [, e]) => s + (e.total_platform || 0), 0)
  });
});

// POST /admin/settle — admin scope required (read token rejected)
app.post('/admin/settle', adminAuth('admin'), async (c) => {
  return c.json({ error: 'Manual settle not fully implemented yet' }, 501);
});

// ─── M-F: POST /admin/stage-key — Stage a new private key for next restart ───
// Admin-only endpoint. Validates the provided key, writes it to staged-key.json.
// The key is NOT applied until next process restart (see startup block above).
// Rate limited: max 3 attempts per hour to prevent brute-force probing.
const stageKeyAttempts = []; // timestamps of recent attempts
const STAGE_KEY_RATE_LIMIT = 3;
const STAGE_KEY_RATE_WINDOW = 3600_000; // 1 hour

app.post('/admin/stage-key', adminAuth('admin'), async (c) => {
  // Rate limit check (global, not per-admin — only one admin expected)
  const now = Date.now();
  const recentAttempts = stageKeyAttempts.filter(ts => (now - ts) < STAGE_KEY_RATE_WINDOW);
  stageKeyAttempts.length = 0;
  stageKeyAttempts.push(...recentAttempts, now);

  if (recentAttempts.length >= STAGE_KEY_RATE_LIMIT) {
    console.warn(`[M-F] [AUDIT] Stage-key rate limited. ${recentAttempts.length} attempts in last hour.`);
    return c.json({ error: 'Rate limited. Max 3 key staging attempts per hour.' }, 429);
  }

  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

  const { private_key } = body;
  if (!private_key || typeof private_key !== 'string') {
    return c.json({ error: 'private_key field required (hex string)' }, 400);
  }

  // Normalise and validate the key
  const keyHex = private_key.startsWith('0x') ? private_key : `0x${private_key}`;

  // Basic length check before expensive crypto (64 hex chars + 0x prefix = 66)
  if (!/^0x[0-9a-fA-F]{64}$/.test(keyHex)) {
    console.warn('[M-F] [AUDIT] Stage-key rejected — invalid hex format.');
    return c.json({ error: 'Invalid private key format. Expected 64 hex characters.' }, 400);
  }

  let newAddress;
  try {
    const acct = privateKeyToAccount(keyHex);
    newAddress = acct.address;
  } catch (e) {
    console.warn(`[M-F] [AUDIT] Stage-key rejected — key validation failed: ${e.message}`);
    return c.json({ error: 'Invalid private key — could not derive account.' }, 400);
  }

  // Write to staged-key.json (atomic)
  try {
    const payload = {
      private_key: keyHex,
      derived_address: newAddress,
      staged_by: c.get('adminScope') || 'admin',
      staged_at: new Date().toISOString(),
    };
    const tmp = STAGED_KEY_FILE + '.tmp';
    writeAndSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, STAGED_KEY_FILE);
  } catch (e) {
    console.error(`[M-F] [AUDIT] Stage-key write failed: ${e.message}`);
    return c.json({ error: 'Failed to write staged key file.' }, 500);
  }

  console.log(`[M-F] [AUDIT] Key staged successfully. Derived address: ${newAddress}. Will apply on next restart.`);

  return c.json({
    staged: true,
    derived_address: newAddress,
    message: 'Key staged successfully. Restart the process (pm2 restart auxilo) to apply.',
  });
});

// ─── S21-2: Admin Moderation Endpoints ──────────────────────────────────────

// GET /admin/moderation/queue — returns learnings with status 'pending_review'
app.get('/admin/moderation/queue', adminAuth('read'), (c) => {
  const pending = learnings
    .filter(l => l.status === 'pending_review')
    .map(l => ({
      id: l.id,
      title: l.title,
      snippet: l.snippet,
      category: l.category,
      tags: l.tags,
      contributor_wallet: l.contributor_wallet,
      created_at: l.created_at,
      status: l.status,
    }));

  return c.json({
    pending_count: pending.length,
    learnings: pending,
    moderation_enabled: CONTENT_MODERATION_ENABLED,
  });
});

// POST /admin/moderation/:id/approve — approve a pending learning
app.post('/admin/moderation/:id/approve', adminAuth('admin'), (c) => {
  const id = c.req.param('id');
  const idx = learnings.findIndex(l => l.id === id);

  if (idx === -1) return c.json({ error: 'Learning not found', id }, 404);

  const learning = learnings[idx];
  if (learning.status === 'approved') {
    return c.json({ error: 'Learning is already approved', id }, 400);
  }

  learning.status = 'approved';
  learning.moderation_action = {
    action: 'approved',
    at: new Date().toISOString(),
  };
  learning.updated_at = new Date().toISOString();
  safeWrite(LEARNINGS_FILE, learnings);

  console.log(`[S21-2] Learning ${id} approved by admin`);
  return c.json({ approved: true, id, title: learning.title });
});

// POST /admin/moderation/:id/reject — reject a pending learning with a reason
app.post('/admin/moderation/:id/reject', adminAuth('admin'), async (c) => {
  const id = c.req.param('id');
  const idx = learnings.findIndex(l => l.id === id);

  if (idx === -1) return c.json({ error: 'Learning not found', id }, 404);

  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { reason } = body || {};
  if (!reason || typeof reason !== 'string' || reason.length < 5) {
    return c.json({ error: 'Rejection reason required (min 5 characters)' }, 400);
  }

  const learning = learnings[idx];
  if (learning.status === 'rejected') {
    return c.json({ error: 'Learning is already rejected', id }, 400);
  }

  learning.status = 'rejected';
  learning.moderation_action = {
    action: 'rejected',
    reason,
    at: new Date().toISOString(),
  };
  learning.updated_at = new Date().toISOString();
  safeWrite(LEARNINGS_FILE, learnings);

  console.log(`[S21-2] Learning ${id} rejected by admin: ${reason}`);
  return c.json({ rejected: true, id, reason });
});

// ─── S21-3: Content Reporting Endpoint ──────────────────────────────────────

// POST /report — flag a learning as harmful/spam/inaccurate
app.post('/report', async (c) => {
  const clientIp = getClientIp(c);

  // Rate limit: 10 reports per IP per hour
  if (isReportRateLimited(clientIp)) {
    return c.json({ error: 'Rate limit exceeded. Max 10 reports per hour.' }, 429);
  }

  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { learning_id, reason, reporter_wallet } = body || {};

  if (!learning_id || typeof learning_id !== 'string') {
    return c.json({ error: 'learning_id is required' }, 400);
  }

  // Validate learning_id exists
  const idx = learnings.findIndex(l => l.id === learning_id);
  if (idx === -1) {
    return c.json({ error: 'Learning not found', learning_id }, 404);
  }

  if (!reason || typeof reason !== 'string' || reason.length < 5) {
    return c.json({ error: 'reason is required (min 5 characters)' }, 400);
  }

  // Validate reporter_wallet format if provided
  if (reporter_wallet && !isAddress(reporter_wallet)) {
    return c.json({ error: 'Invalid reporter_wallet format' }, 400);
  }

  // F-05: Hash the IP before storage to avoid persisting PII.
  // SHA-256 truncated to 16 hex chars — enough to detect repeat reporters
  // (same hash == same IP) without storing the raw address.
  // The raw IP is kept in-memory only for rate limiting and is never written to disk.
  const reporterIpHash = crypto.createHash('sha256').update(clientIp).digest('hex').substring(0, 16);

  const report = {
    learning_id,
    reason,
    reporter_wallet: reporter_wallet ? reporter_wallet.toLowerCase() : null,
    reporter_ip_hash: reporterIpHash,
    timestamp: new Date().toISOString(),
  };

  // Append to reports.log (append-only, like settlements pattern)
  try {
    fs.appendFileSync(REPORTS_FILE, JSON.stringify(report) + '\n');
  } catch (e) {
    console.error(`[S21-3] Failed to append report: ${e.message}`);
    return c.json({ error: 'Failed to save report' }, 500);
  }

  console.log(`[S21-3] Report filed for learning ${learning_id}: ${reason.substring(0, 50)}`);
  return c.json({ reported: true }, 201);
});

// GET /admin/reports — view all reports (admin only)
app.get('/admin/reports', adminAuth('read'), (c) => {
  const reports = [];
  try {
    if (fs.existsSync(REPORTS_FILE)) {
      const raw = fs.readFileSync(REPORTS_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          reports.push(JSON.parse(line));
        } catch {
          // Skip malformed lines
        }
      }
    }
  } catch (e) {
    console.error(`[S21-3] Failed to read reports: ${e.message}`);
  }

  return c.json({
    total_reports: reports.length,
    reports: reports.reverse(), // Most recent first
  });
});

// ─── Static File Endpoints ───────────────────────────────────────────

// OpenAPI spec (FREE)
app.get('/openapi.json', (c) => {
  try {
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'openapi.json'), 'utf8'));
    return c.json(spec);
  } catch {
    return c.json({ error: 'OpenAPI spec not found' }, 404);
  }
});

// A2A agent card (FREE)
app.get('/.well-known/agent.json', (c) => {
  try {
    const card = JSON.parse(fs.readFileSync(path.join(__dirname, '.well-known', 'agent.json'), 'utf8'));
    return c.json(card);
  } catch {
    return c.json({ error: 'Agent card not found' }, 404);
  }
});

// S24-3: security.txt — RFC 9116 responsible disclosure contact
app.get('/.well-known/security.txt', (c) => {
  try {
    const txt = fs.readFileSync(path.join(__dirname, 'public', '.well-known', 'security.txt'), 'utf8');
    c.header('Content-Type', 'text/plain; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(txt);
  } catch {
    return c.text('security.txt not found', 404);
  }
});

// How It Works — static page
app.get('/how-it-works', (c) => {
  const res = serveStatic(c, 'how-it-works.html');
  if (res) return res;
  return c.text('How It Works page not found', 404);
});

// S24-4: /status — static status page
app.get('/status', (c) => {
  const res = serveStatic(c, 'status.html');
  if (res) return res;
  return c.text('Status page not found', 404);
});

// ─── Standalone marketing / informational pages ───────────────────────
app.get('/for-builders', (c) => {
  const res = serveStatic(c, 'for-builders.html');
  if (res) return res;
  return c.text('For Builders page not found', 404);
});

app.get('/for-agents', (c) => {
  const res = serveStatic(c, 'for-agents.html');
  if (res) return res;
  return c.text('For Agents page not found', 404);
});

app.get('/pricing', (c) => {
  const res = serveStatic(c, 'pricing.html');
  if (res) return res;
  return c.text('Pricing page not found', 404);
});

app.get('/earnings', (c) => {
  const res = serveStatic(c, 'earnings.html');
  if (res) return res;
  return c.text('Earnings page not found', 404);
});

// ─── Static text files (robots.txt, llms.txt) ────────────────────────

app.get('/robots.txt', (c) => {
  try {
    const txt = fs.readFileSync(path.join(__dirname, 'public', 'robots.txt'), 'utf8');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.text(txt);
  } catch {
    return c.text('robots.txt not found', 404);
  }
});

app.get('/llms.txt', (c) => {
  try {
    const txt = fs.readFileSync(path.join(__dirname, 'public', 'llms.txt'), 'utf8');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.text(txt);
  } catch {
    return c.text('llms.txt not found', 404);
  }
});

// ─── Legal pages (terms, privacy) ────────────────────────────────────

function serveLegalPage(c, filename, title) {
  try {
    const md = fs.readFileSync(path.join(__dirname, 'docs', filename), 'utf8');
    // Minimal markdown-to-HTML: headings, paragraphs, bold, italic, lists
    const body = md
      .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
      .replace(/^(?!<[hul])(.*\S.*)$/gm, '<p>$1</p>')
      .replace(/\n{2,}/g, '\n');
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${title} — Auxilo</title>
  <link rel="stylesheet" href="/styles.css?v=2"/>
  <style>
    .legal-wrap{max-width:720px;margin:0 auto;padding:120px 24px 80px;color:#E5E5E3}
    .legal-wrap h1{color:#FAFAF8;font-size:32px;margin-bottom:24px}
    .legal-wrap h2{color:#FAFAF8;font-size:22px;margin:32px 0 12px}
    .legal-wrap h3{color:#FAFAF8;font-size:18px;margin:24px 0 8px}
    .legal-wrap p{line-height:1.7;margin-bottom:16px}
    .legal-wrap ul{margin:0 0 16px 20px}
    .legal-wrap li{margin-bottom:6px;line-height:1.6}
    .legal-wrap strong{color:#FAFAF8}
    .legal-back{display:inline-block;margin-bottom:32px;color:#C9A84C;text-decoration:none;font-size:14px}
    .legal-back:hover{text-decoration:underline}
  </style>
</head>
<body>
  <div class="legal-wrap">
    <a href="/" class="legal-back">← Back to Auxilo</a>
    ${body}
  </div>
</body>
</html>`;
    c.header('Content-Type', 'text/html; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(html);
  } catch {
    return c.text(`${title} not found`, 404);
  }
}

app.get('/terms', (c) => serveLegalPage(c, 'TERMS-OF-SERVICE.md', 'Terms of Service'));
app.get('/privacy', (c) => serveLegalPage(c, 'PRIVACY-POLICY.md', 'Privacy Policy'));
app.get('/legal/subprocessors', (c) => serveLegalPage(c, 'SUBPROCESSORS.md', 'Sub-Processors'));
app.get('/legal/supported-clients', (c) => serveLegalPage(c, 'SUPPORTED-CLIENTS.md', 'Supported Clients'));

// ─── Renderly — Web Content Extraction API ───────────────────────────

app.get('/renderly', (c) => {
  return c.json({
    service: 'Renderly',
    version: '0.3.1',
    description: 'Web content extraction API — convert any URL to clean markdown, structured data, or readable text',
    parent: 'Auxilo',
    endpoints: {
      '/renderly/markdown': { method: 'POST', price: '$0.001', description: 'Convert URL to clean markdown' },
      '/renderly/extract': { method: 'POST', price: '$0.001', description: 'Extract structured data (title, description, headings, links, images, meta)' },
      '/renderly/readable': { method: 'POST', price: '$0.0005', description: 'Get readable text content' },
      '/renderly/llms.txt': { method: 'GET', price: 'free', description: 'LLM-readable service description' },
      '/renderly/health': { method: 'GET', price: 'free' },
      '/renderly/pricing': { method: 'GET', price: 'free' },
    },
    payment: { network: 'Base', token: 'USDC', protocol: 'x402' },
    wallet: WALLET,
  });
});

app.post('/renderly/markdown', dualAuth(0.001, 'Convert URL to markdown', 'query'), async (c) => {
  try {
    const { url } = await c.req.json();
    // IR-M-007 FIX: Properly destructure validateUrl result — return error string, not object
    const validation = validateUrl(url);
    if (!validation.valid) return c.json({ error: validation.error }, 400);
    const { html } = await fetchPage(validation.url);
    const stripped = stripNonContent(html);
    const markdown = htmlToMarkdown(stripped);
    return c.json({ url: validation.url, markdown, length: markdown.length, service: 'Renderly v0.3.1' });
  } catch (e) {
    return c.json({ error: e.message || 'Failed to process URL' }, 500);
  }
});

app.post('/renderly/extract', dualAuth(0.001, 'Extract structured data from URL', 'query'), async (c) => {
  try {
    const { url } = await c.req.json();
    // IR-M-007 FIX: Properly destructure validateUrl result — return error string, not object
    const validation = validateUrl(url);
    if (!validation.valid) return c.json({ error: validation.error }, 400);
    const { html } = await fetchPage(validation.url);
    const data = extractStructured(html, validation.url);
    return c.json({ url: validation.url, ...data, service: 'Renderly v0.3.1' });
  } catch (e) {
    return c.json({ error: e.message || 'Failed to extract data' }, 500);
  }
});

app.post('/renderly/readable', dualAuth(0.0005, 'Get readable text from URL', 'query'), async (c) => {
  try {
    const { url } = await c.req.json();
    // IR-M-007 FIX: Properly destructure validateUrl result — return error string, not object
    const validation = validateUrl(url);
    if (!validation.valid) return c.json({ error: validation.error }, 400);
    const { html } = await fetchPage(validation.url);
    const stripped = stripNonContent(html);
    const markdown = htmlToMarkdown(stripped);
    const readable = markdown.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*_`~>|-]/g, '').replace(/\n{3,}/g, '\n\n').trim();
    return c.json({ url: validation.url, text: readable, length: readable.length, service: 'Renderly v0.3.1' });
  } catch (e) {
    return c.json({ error: e.message || 'Failed to process URL' }, 500);
  }
});

app.get('/renderly/llms.txt', (c) => {
  c.header('Content-Type', 'text/plain');
  return c.body(LLMS_TXT);
});

app.get('/renderly/health', (c) => {
  return c.json({ status: 'healthy', service: 'Renderly', version: '0.3.1', timestamp: new Date().toISOString() });
});

app.get('/renderly/pricing', (c) => {
  return c.json({
    service: 'Renderly',
    pricing: {
      '/renderly/markdown': { price: '$0.001', description: 'Full markdown conversion' },
      '/renderly/extract': { price: '$0.001', description: 'Structured data extraction' },
      '/renderly/readable': { price: '$0.0005', description: 'Plain readable text' },
    },
    payment: { network: 'Base', token: 'USDC', protocol: 'x402' },
    wallet: WALLET,
  });
});

// ── OpenClaw Adapter Routes ──────────────────────────────────────────────────
// S9-1: All OpenClaw endpoints require admin auth (S-3 audit finding)
app.get('/openclaw/status', adminAuth('read'), (c) => {
  return c.json({
    daemon_running: openclawDaemonRunning,
    last_run: openclawLastRun,
    last_result: openclawLastResult,
    interval_ms: OPENCLAW_DAEMON_INTERVAL_MS,
    memory_path: OPENCLAW_MEMORY_PATH,
    config: openclawRuntimeConfig,
  });
});

app.post('/openclaw/trigger', adminAuth('admin'), async (c) => {
  if (openclawDaemonRunning) {
    return c.json({ error: 'Daemon already running' }, 409);
  }
  // Run in background, return immediately
  runOpenClawDaemon().catch(err => console.error('[openclaw-trigger] Error:', err.message));
  return c.json({ triggered: true, message: 'OpenClaw adapter run triggered' });
});

app.post('/openclaw/config', adminAuth('admin'), async (c) => {
  try {
    const body = await c.req.json();
    const allowed = ['glob_pattern', 'max_depth', 'max_file_size', 'max_files_per_run', 'min_file_size', 'delay_between_files_ms', 'auto_publish'];
    const updates = {};
    for (const key of allowed) {
      if (body[key] !== undefined) {
        updates[key] = body[key];
      }
    }
    openclawRuntimeConfig = { ...openclawRuntimeConfig, ...updates };
    return c.json({ config: openclawRuntimeConfig });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

app.get('/openclaw/state', adminAuth('read'), async (c) => {
  try {
    const { AdapterState } = require('./lib/openclaw-adapter.js');
    const state = new AdapterState(openclawRuntimeConfig.state_file);
    await state.load();
    const entries = [];
    state.entries.forEach((value, key) => {
      entries.push({ file: key, ...value });
    });
    return c.json({ entries, count: entries.length });
  } catch (err) {
    return c.json({ entries: [], count: 0, error: err.message });
  }
});

// ─── S22-1: GET /admin/ofac/status — OFAC sanctions screening status ─────────
app.get('/admin/ofac/status', adminAuth('read'), (c) => {
  return c.json({
    last_refresh: ofacState.lastRefresh,
    last_refresh_success: ofacState.lastRefreshSuccess,
    consecutive_failures: ofacState.consecutiveFailures,
    list_size: ofacState.listSize,
    // F-06: per-source breakdown
    sdn_address_count: ofacState.sdnAddressCount,
    alt_address_count: ofacState.altAddressCount,
    block_count: ofacState.blockCount,
    refresh_interval_hours: OFAC_REFRESH_INTERVAL_MS / (60 * 60 * 1000),
    status: ofacState.consecutiveFailures >= 2 ? 'CRITICAL' :
            ofacState.consecutiveFailures >= 1 ? 'DEGRADED' :
            ofacState.lastRefresh ? 'OK' : 'INITIALIZING',
  });
});

// ─── Phase 2: Chat History Extraction Pipeline ──────────────────────────────
// Accepts conversation uploads (JSON/markdown), runs LLM extraction,
// quality gate (14/20), dedup, auto-tag, auto-price, builder review.
const CHAT_QUALITY_THRESHOLD = 14; // Minimum score out of 20

// Fix 1: pipelineEntries + savePipelines() are defined near line 1153
// (moved earlier so WAL recovery's replayPipelineApprove can access them).

app.post('/pipeline/upload', requireSession, async (c) => {
  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON. Expected: { "conversation": "...", "format": "json"|"markdown" }' }, 400);
  }

  const { conversation, format = 'markdown' } = body;
  if (!conversation || typeof conversation !== 'string') {
    return c.json({ error: 'Missing or invalid "conversation" field' }, 400);
  }

  if (conversation.length > 500000) {
    return c.json({ error: 'Conversation too large (max 500KB)' }, 400);
  }

  const accountId = c.get('accountId');
  const account = accounts[accountId];
  if (!account) return c.json({ error: 'Account not found' }, 404);

  // Fix 2: Sensitivity pre-scan BEFORE sending to Anthropic API
  const preScanResult = scanLearning({ title: '', body: conversation, task_context: '', tags: [] });
  if (!preScanResult.clean) {
    return c.json({
      error: 'Conversation contains sensitive data. Please redact before uploading.',
      matches: preScanResult.matches,
      suggestion: preScanResult.matches.map(m =>
        `Redact ${m.description} in conversation (matched: ${m.match}) — replace with ${getRedactionHint(m.pattern)}`
      ),
    }, 400);
  }

  try {
    // Step 1: LLM extraction pass
    const extractionPrompt = `Extract discrete, actionable operational learnings from this ${format} conversation.
For each learning, provide:
- title: concise, descriptive title
- body: the full learning content (2-5 sentences)
- category: one of the standard categories
- tags: array of relevant tags
- quality_estimate: score 0-20 based on (specificity + actionability + novelty + completeness, each 0-5)

Return JSON array of learnings. Only include learnings scoring >= ${CHAT_QUALITY_THRESHOLD}/20.
Filter out: opinions, greetings, meta-discussion, anything with credentials/PII.

Conversation:
${conversation.substring(0, 100000)}`;

    const extractionResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: extractionPrompt }],
      }),
    });

    if (!extractionResponse.ok) {
      return c.json({ error: 'LLM extraction failed' }, 502);
    }

    const extractionData = await extractionResponse.json();
    const extractedText = extractionData.content?.[0]?.text || '[]';

    // Parse extracted learnings
    let extracted;
    try {
      const jsonMatch = extractedText.match(/\[[\s\S]*\]/);
      extracted = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch {
      extracted = [];
    }

    // Step 2: Quality gate
    const qualityPassed = extracted.filter(l =>
      (l.quality_estimate || 0) >= CHAT_QUALITY_THRESHOLD
    );

    // Step 3: Deduplication against existing catalog
    const deduplicated = qualityPassed.filter(candidate => {
      const candidateTitle = (candidate.title || '').toLowerCase();
      return !learnings.some(existing => {
        const existingTitle = (existing.title || '').toLowerCase();
        // Simple title similarity check
        const words1 = candidateTitle.split(/\s+/);
        const words2 = existingTitle.split(/\s+/);
        const common = words1.filter(w => words2.includes(w)).length;
        const similarity = common / Math.max(words1.length, words2.length);
        return similarity > 0.7;
      });
    });

    // Fix 5: Auto-pricing using computeCurrentPrice() with a synthetic learning object.
    // Falls back to the original formula if the engine returns 0 (e.g. empty body),
    // and always floors at MIN_UNLOCK_PRICE.
    const { MIN_UNLOCK_PRICE: PIPELINE_MIN_PRICE } = require('./lib/pricing.js');
    const priced = deduplicated.map(l => {
      const syntheticLearning = {
        body: l.body || '',
        outcome: 'success',
        category: l.category || '',
        quality: { score: Math.round((l.quality_estimate || 0) / 4), unlocks: 0 }, // map 0-20 → 0-5
        unlock_price: 0,
        created_at: new Date().toISOString(),
      };
      const enginePrice = computeCurrentPrice(syntheticLearning, null);
      const fallbackPrice = Math.max(PIPELINE_MIN_PRICE, (l.quality_estimate / 20) * 2.00);
      const suggested_price = Math.max(PIPELINE_MIN_PRICE, Math.min(10.00, enginePrice > PIPELINE_MIN_PRICE ? enginePrice : fallbackPrice));
      return { ...l, suggested_price, status: 'pending_review' };
    });

    // Fix 4: Hash-and-delete raw conversation after successful extraction
    const conversation_hash = crypto.createHash('sha256').update(conversation).digest('hex');

    // Store in pending pipeline for builder review — Fix 1: use module-level pipelineEntries
    const pipelineId = `pipe_${crypto.randomBytes(8).toString('hex')}`;
    const pipelineEntry = {
      id: pipelineId,
      account_id: accountId,
      uploaded_at: new Date().toISOString(),
      format,
      input_length: conversation.length,
      conversation_hash, // Fix 4: store hash, NOT the raw conversation
      total_extracted: extracted.length,
      quality_passed: qualityPassed.length,
      deduplicated: deduplicated.length,
      learnings: priced,
      status: 'awaiting_review',
    };

    // Fix 1: persist to disk on every mutation
    pipelineEntries.push(pipelineEntry);
    savePipelines();

    return c.json({
      pipeline_id: pipelineId,
      stats: {
        total_extracted: extracted.length,
        quality_passed: qualityPassed.length,
        duplicates_removed: qualityPassed.length - deduplicated.length,
        ready_for_review: priced.length,
      },
      learnings: priced.map(l => ({
        title: l.title,
        category: l.category,
        tags: l.tags,
        quality_score: l.quality_estimate,
        suggested_price: l.suggested_price,
        snippet: (l.body || '').substring(0, 100) + '...',
      })),
      next_step: 'POST /pipeline/:id/approve with { "approved": [0, 1, 3], "prices": { "0": 0.50, "1": 1.00 } }',
    });
  } catch (err) {
    console.error('[pipeline] Extraction error:', err.message);
    return c.json({ error: 'Pipeline extraction failed' }, 500);
  }
});

// Approve/publish pipeline learnings
app.post('/pipeline/:id/approve', requireSession, async (c) => {
  const pipelineId = c.req.param('id');
  const accountId = c.get('accountId');

  // Fix 1: use module-level pipelineEntries
  const pipeline = pipelineEntries.find(p => p.id === pipelineId && p.account_id === accountId);
  if (!pipeline) return c.json({ error: 'Pipeline not found' }, 404);
  if (pipeline.status !== 'awaiting_review') return c.json({ error: 'Pipeline already processed' }, 400);

  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const { approved = [], prices = {} } = body;
  const account = accounts[accountId];
  if (!account) return c.json({ error: 'Account not found' }, 404);

  const published = [];
  const rejected_for_sensitivity = [];

  for (const idx of approved) {
    if (idx < 0 || idx >= pipeline.learnings.length) continue;
    const pl = pipeline.learnings[idx];

    // Fix 3: Sensitivity scan on each learning BEFORE publishing
    const approvalScan = scanLearning({
      title: pl.title || '',
      body: pl.body || '',
      task_context: '',
      tags: pl.tags || [],
    });
    if (!approvalScan.clean) {
      rejected_for_sensitivity.push({
        index: idx,
        title: pl.title,
        matches: approvalScan.matches,
      });
      continue; // Skip this learning — do not publish
    }

    const price = prices[String(idx)] || pl.suggested_price;

    // Create the learning
    const learningId = `lrn_${crypto.randomBytes(6).toString('hex')}`;
    const newLearning = {
      id: learningId,
      title: pl.title,
      body: pl.body,
      snippet: (pl.body || '').substring(0, 150),
      category: pl.category || 'general',
      tags: pl.tags || [],
      contributor_id: accountId,
      contributor_wallet: account.walletAddress || null,
      unlock_price: Math.max(0.05, price),
      quality: { score: pl.quality_estimate || 14, unlocks: 0, ratings: 0, avg_helpfulness: 0 },
      earnings: { gross_usd: 0, contributor_share_usd: 0, platform_share_usd: 0 },
      created_at: new Date().toISOString(),
      source: 'chat_pipeline',
      status: CONTENT_MODERATION_ENABLED ? 'pending_review' : 'approved',
    };

    learnings.push(newLearning);
    published.push({ id: learningId, title: pl.title, price: newLearning.unlock_price });
  }

  // ── Atomicity fix: WAL-guarded dual write ─────────────────────────────────
  // C3-pipeline: crash between write-1 and write-2 previously left the pipeline
  // in 'awaiting_review' while learnings were already published, enabling
  // a re-approve that would duplicate every learning.  The WAL ensures that on
  // restart we detect the partial write and complete step-2 before serving
  // any traffic.
  const walId = createWalEntry('pipeline_approve', { pipeline_id: pipeline.id });

  // Write 1: persist learnings to disk
  safeWrite(LEARNINGS_FILE, learnings);
  markStepComplete(walId, 'update_learnings');

  // Write 2: persist pipeline status change to disk
  pipeline.status = 'published';
  savePipelines();
  markStepComplete(walId, 'update_pipelines');

  // Both writes succeeded — discard the WAL entry
  commitWal(walId);
  // ─────────────────────────────────────────────────────────────────────────

  return c.json({
    published_count: published.length,
    published,
    rejected_for_sensitivity,
    pipeline_status: 'complete',
  });
});

// Get pipeline status
app.get('/pipeline/:id', requireSession, (c) => {
  const pipelineId = c.req.param('id');
  const accountId = c.get('accountId');

  // Fix 1: use module-level pipelineEntries
  const pipeline = pipelineEntries.find(p => p.id === pipelineId && p.account_id === accountId);
  if (!pipeline) return c.json({ error: 'Pipeline not found' }, 404);

  return c.json({
    id: pipeline.id,
    status: pipeline.status,
    uploaded_at: pipeline.uploaded_at,
    conversation_hash: pipeline.conversation_hash || null, // Fix 4: expose hash, not raw text
    stats: {
      total_extracted: pipeline.total_extracted,
      quality_passed: pipeline.quality_passed,
      deduplicated: pipeline.deduplicated,
    },
    learnings: pipeline.learnings.map((l, i) => ({
      index: i,
      title: l.title,
      category: l.category,
      quality_score: l.quality_estimate,
      suggested_price: l.suggested_price,
    })),
  });
});


// ─── Phase 3: Referral System ───────────────────────────────────────────────
// Credits-only referral system: $5 referrer + $5 referee on first paid tx.
// First-touch attribution. Max 50 referral payouts/month per referrer.
const REFERRAL_FILE = path.join(__dirname, 'data', 'referrals.json');
let referrals = {};
try { referrals = JSON.parse(fs.readFileSync(REFERRAL_FILE, 'utf8')); } catch { referrals = {}; }
function saveReferrals() {
  fs.writeFileSync(REFERRAL_FILE, JSON.stringify(referrals, null, 2));
}

const REFERRER_CREDIT_USD = 5;
const REFEREE_CREDIT_USD = 5;
const MAX_REFERRAL_PAYOUTS_PER_MONTH = 50;

// Generate referral link
app.get('/referral/link', requireSession, (c) => {
  const accountId = c.get('accountId');
  const account = accounts[accountId];
  if (!account) return c.json({ error: 'Account not found' }, 404);

  // Initialize referral tracking for this account
  if (!referrals[accountId]) {
    referrals[accountId] = {
      referral_code: crypto.randomBytes(6).toString('hex'),
      total_referrals: 0,
      total_credits_earned: 0,
      monthly_payouts: {},
      referred_accounts: [],
    };
    saveReferrals();
  }

  const code = referrals[accountId].referral_code;
  return c.json({
    referral_link: `https://auxilo.io/ref/${code}`,
    direct_learning_link_template: `https://auxilo.io/learning/LEARNING_ID?ref=${code}`,
    referral_code: code,
    stats: {
      total_referrals: referrals[accountId].total_referrals,
      total_credits_earned: referrals[accountId].total_credits_earned,
    },
  });
});

// Per-referee processing lock — prevents race conditions on simultaneous /referral/track calls
const referralTrackingInProgress = new Set();

// Track referral signup (called during registration)
app.post('/referral/track', requireSession, async (c) => {
  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const { referee_account_id, referral_code } = body;
  if (!referee_account_id || !referral_code) {
    return c.json({ error: 'Missing referee_account_id or referral_code' }, 400);
  }

  // Validate caller owns the referee account
  if (referee_account_id !== c.get('accountId')) {
    return c.json({ error: 'Forbidden: referee_account_id does not match authenticated account' }, 403);
  }

  // Per-referee mutex: reject concurrent duplicate tracking attempts
  if (referralTrackingInProgress.has(referee_account_id)) {
    return c.json({ error: 'Referral tracking already in progress for this account' }, 409);
  }
  referralTrackingInProgress.add(referee_account_id);
  try {

  // Find referrer by code
  const referrerEntry = Object.entries(referrals).find(([, r]) => r.referral_code === referral_code);
  if (!referrerEntry) return c.json({ error: 'Invalid referral code' }, 400);

  const [referrerId, referrerData] = referrerEntry;

  // Self-referral blocked
  if (referrerId === referee_account_id) {
    return c.json({ error: 'Self-referral not allowed' }, 400);
  }

  // Already referred
  if (referrerData.referred_accounts.includes(referee_account_id)) {
    return c.json({ error: 'Already tracked' }, 200);
  }

  // First-touch: check if referee already has a referrer
  const existingReferrer = Object.entries(referrals).find(([, r]) =>
    r.referred_accounts.includes(referee_account_id)
  );
  if (existingReferrer) {
    return c.json({ error: 'Referee already attributed to another referrer' }, 400);
  }

  // Track the referral (credits vest on first paid transaction)
  referrerData.referred_accounts.push(referee_account_id);
  referrerData.total_referrals++;

  // Credit referee immediately ($5 credit)
  await addPurchasedCredits(referee_account_id, 200, 40); // ~$5 worth

  saveReferrals();

  return c.json({
    tracked: true,
    referee_credited: REFEREE_CREDIT_USD,
    referrer_credit_pending: 'Credits on first paid transaction by referee',
  });
  } finally {
    referralTrackingInProgress.delete(referee_account_id);
  }
});

// Vest referrer credits (called internally on first paid transaction)
async function vestReferrerCredits(refereeAccountId) {
  // Find who referred this account
  const referrerEntry = Object.entries(referrals).find(([, r]) =>
    r.referred_accounts.includes(refereeAccountId)
  );
  if (!referrerEntry) return null;

  const [referrerId, referrerData] = referrerEntry;

  // Fix C: Idempotency guard — prevent double-vesting on Stripe webhook retries
  if (referrerData.vested_referees && referrerData.vested_referees.includes(refereeAccountId)) {
    console.log(`[referral] Already vested for referee ${refereeAccountId} — skipping`);
    return null;
  }

  // Check monthly payout cap
  const monthKey = new Date().toISOString().substring(0, 7); // YYYY-MM
  const monthlyCount = referrerData.monthly_payouts[monthKey] || 0;
  if (monthlyCount >= MAX_REFERRAL_PAYOUTS_PER_MONTH) {
    console.log(`[referral] ${referrerId} hit monthly cap (${MAX_REFERRAL_PAYOUTS_PER_MONTH})`);
    return null;
  }

  // Credit referrer ($5)
  await addPurchasedCredits(referrerId, 200, 40); // ~$5 worth

  // Fix C: Mark this referee as vested to prevent re-vesting on duplicate webhooks
  if (!referrerData.vested_referees) referrerData.vested_referees = [];
  referrerData.vested_referees.push(refereeAccountId);

  referrerData.monthly_payouts[monthKey] = monthlyCount + 1;
  referrerData.total_credits_earned += REFERRER_CREDIT_USD;
  saveReferrals();

  console.log(`[referral] Credited ${referrerId} for referee ${refereeAccountId}`);
  return { referrer_id: referrerId, amount: REFERRER_CREDIT_USD };
}

// Referral stats
app.get('/referral/stats', requireSession, (c) => {
  const accountId = c.get('accountId');
  const data = referrals[accountId];
  if (!data) return c.json({ referrals: 0, credits_earned: 0, referred_accounts: [] });

  return c.json({
    referral_code: data.referral_code,
    total_referrals: data.total_referrals,
    total_credits_earned: data.total_credits_earned,
    monthly_payouts: data.monthly_payouts,
    referred_count: data.referred_accounts.length,
  });
});

// ─── JSON 404 catch-all — must be after ALL route definitions ────────
app.all('*', (c) => {
  return c.json({ error: 'Not found', message: `No endpoint at ${c.req.method} ${c.req.path}`, help: 'See GET /api for all available endpoints' }, 404);
});

// ─── Start ───────────────────────────────────────────────────────────
const PORT = 3000;
console.log(`Auxilo v${VERSION} starting on port ${PORT}...`);
console.log(`Catalog: ${skills.length} skills loaded`);
const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Auxilo running at http://0.0.0.0:${PORT}`);
  console.log(`Wallet: ${WALLET}`);
  console.log(`x402 payments on Base mainnet`);
});

// ─── Graceful Shutdown (S8-I4 enhanced) ─────────────────────────────
const SHUTDOWN_TIMEOUT_MS = 10000; // 10 seconds — PM2 kill_timeout is 12s (2s buffer)

function gracefulShutdown(signal) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  const shutdownStart = Date.now();
  console.log(`\n[SHUTDOWN] ${signal} received — shutting down gracefully...`);
  console.log(`[SHUTDOWN] Active requests: ${activeRequests}`);

  if (openclawDaemonRunning) {
    console.log('[SHUTDOWN] OpenClaw daemon is running — will wait for current cycle.');
  }

  if (settlementDaemonRunning) {
    console.log('[SHUTDOWN] Settlement daemon is running — will wait for current cycle.');
  }

  // Phase 1: Stop accepting new TCP connections
  server.close(() => {
    console.log('[SHUTDOWN] Server closed — no more connections.');
  });

  // Phase 2: Wait for in-flight requests to drain
  const drainCheck = setInterval(() => {
    const elapsed = Date.now() - shutdownStart;
    if (activeRequests === 0 && !openclawDaemonRunning && !settlementDaemonRunning) {
      clearInterval(drainCheck);
      rateLimitsDirty = true; saveRateLimits(); // M-A: final flush
      console.log(`[SHUTDOWN] All requests drained, daemons idle. Clean exit after ${elapsed}ms.`);
      process.exit(0);
    }
    // Log progress every 2 seconds
    if (elapsed % 2000 < 500) {
      console.log(`[SHUTDOWN] Waiting... Active requests: ${activeRequests}, OpenClaw: ${openclawDaemonRunning}, Settlement: ${settlementDaemonRunning} (${elapsed}ms elapsed)`);
    }
  }, 250);

  // Phase 3: Force exit after timeout
  setTimeout(() => {
    clearInterval(drainCheck);
    rateLimitsDirty = true; saveRateLimits(); // M-A: best-effort flush on timeout
    console.error(`[SHUTDOWN] Timeout after ${SHUTDOWN_TIMEOUT_MS}ms. Forcing exit.`);
    console.error(`[SHUTDOWN] Abandoned: ${activeRequests} requests, OpenClaw: ${openclawDaemonRunning}, Settlement: ${settlementDaemonRunning}`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// S26-1: Global process-level error handlers
// uncaughtException: log with timestamp, then exit \u2014 PM2 restarts the process.
// Do NOT re-throw; a second throw after uncaughtException crashes Node ungracefully.
process.on('uncaughtException', (err) => {
  const ts = new Date().toISOString();
  console.error(`[S26-1] [${ts}] UNCAUGHT EXCEPTION: ${err.message}`);
  console.error(err.stack || err);
  process.exit(1);
});

// unhandledRejection: log only, do NOT exit.
// Many third-party async paths (e.g. network timeouts) produce benign rejections;
// exiting would cause unnecessary restarts. Ops can grep [S26-1] for investigation.
process.on('unhandledRejection', (reason) => {
  const ts = new Date().toISOString();
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error(`[S26-1] [${ts}] UNHANDLED REJECTION: ${msg}`);
});
