const { Hono } = require('hono');
const { serve } = require('@hono/node-server');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isAddress } = require('viem');
const { privateKeyToAccount } = require('viem/accounts'); // M-F: key validation
const {
  createNonce,
  consumeNonce,
  verifyChallengeSignature,
  verifyWithdrawalSignature,
  EIP712_DOMAIN,
} = require('./lib/eip712.js');
const { scanLearning, getRedactionHint } = require('./lib/sensitivity-filter.js');
const { fetchPage, stripNonContent, htmlToMarkdown, extractStructured, validateUrl, LLMS_TXT } = require('./lib/renderly.js');

// ─── Phase 0.5: Earnings Helpers (SPEC-P0.5) — must load before data init ────
const {
  resolveEarningsEntry,
  initEarningsEntry,
  migrateEarningsToAccountKeyed,
  lazyMigrateOnWalletLink,
  setWalletIndex,
} = require('./lib/earnings.js');

const app = new Hono();

// IR-M-003 FIX: CORS origin restriction — only allow expected frontends
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

// IR-C-002 FIX: Global body size limit — reject oversized payloads before JSON parsing
const MAX_BODY_SIZE = 100 * 1024; // 100KB — generous for all Auxilo routes
app.use('*', async (c, next) => {
  if (c.req.method === 'POST' || c.req.method === 'PUT' || c.req.method === 'PATCH') {
    const contentLength = parseInt(c.req.header('content-length') || '0', 10);
    if (contentLength > MAX_BODY_SIZE) {
      return c.json({ error: 'Request body too large', max_bytes: MAX_BODY_SIZE }, 413);
    }
  }
  await next();
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
const VERSION = '0.3.0';

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
const { setupAccountRoutes, requireAuth, validateApiKey, linkWallet, getClientIp } = require('./lib/accounts.js');

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
} = require('./lib/stripe.js');
const { addPurchasedCredits } = require('./lib/credits.js');
const { extractLearnings } = require('./lib/extractor.js');
const { processMemoryFiles, DEFAULT_ADAPTER_CONFIG } = require('./lib/openclaw-adapter.js');

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
 * Scan data/wal/ for pending entries and replay any interrupted unlock operations.
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
      // IMPL-A2-01 fix: commitWal is INSIDE the try block — only reached if replay did not throw.
      // If replayUnlock returns early (incomplete learnings write), it does NOT throw, so we commit
      // the WAL entry because there is nothing more we can safely do automatically.
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

  let changed = false;
  for (const s of stuck) {
    // SPEC-P0.5: resolve via wallet index or direct key
    const { key: eKey, entry, source } = resolveEarningsEntry(earnings, { wallet: s.wallet });
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
          appendSettlement({ ...s, status: 'settled' });
          changed = true;
        } else {
          entry.pending_balance += s.amount;
          entry.processed_settlements[s.id] = true;
          appendSettlement({ ...s, status: 'failed', error: 'Reverted on-chain' });
          changed = true;
        }
      } catch {
        // Pending Mempool Trap fix
        console.warn(`[SETTLEMENT] tx_hash ${s.tx_hash} has no receipt — may be pending. Leaving unresolved.`);
        appendSettlement({ ...s, status: 'processing_unresolved' });
      }
    } else {
      // No tx_hash = never broadcast — safe to refund
      entry.pending_balance += s.amount;
      entry.processed_settlements[s.id] = true;
      appendSettlement({ ...s, status: 'failed', error: 'Never broadcast' });
      changed = true;
    }
  }
  if (changed) safeWrite(EARNINGS_FILE, earnings);
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

// ─── Startup Wiring ───────────────────────────────────────────────────────────
recoverWalEntries();       // 1. WAL crash recovery (SPEC-A2 C3)

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
resolveProcessingSettlements()  // 2. Legacy processing/processing_timeout recovery (SPEC-A0)
  .then(() => runConsistencyCheck())
  .catch(console.error);
resolveStuckSettlements()  // 3. C4: pending/retry daemon — first pass on startup
  .catch(console.error);
setInterval(() => resolveStuckSettlements().catch(console.error), SETTLEMENT_DAEMON_INTERVAL_MS); // AUDIT-06: hourly

// M-C: Compact settlements if threshold exceeded
compactSettlements();

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

    const { verified, rateLimited } = await _verifyPayment(
      paymentHeader, price_usd, new URL(c.req.url).pathname, amount
    );

    if (rateLimited) {
      return c.json({
        error: 'Payment verification temporarily unavailable',
        retry_after: 5
      }, 503);
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

  const { verified, rateLimited } = await _verifyPayment(
    paymentHeader, price_usd, new URL(c.req.url).pathname, amount
  );

  if (rateLimited) {
    return c.json({
      error: 'Payment verification temporarily unavailable',
      retry_after: 5
    }, 503);
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

function dualAuth(price_usd, description, creditType) {
    const x402Middleware = x402Gate(price_usd, description);
    return async (c, next) => {
        const apiKey = c.req.header('X-API-Key');
        const payment = c.req.header('X-Payment');

        // Path 1: API key present -- validate and bypass x402
        if (apiKey) {
            const result = validateApiKey(apiKey);
            if (!result.valid) {
                return c.json({ error: 'Invalid API key' }, 401);
            }
            c.set('accountId', result.accountId);
            c.set('authMethod', 'api_key');

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

async function dualAuthDynamic(c, price_usd, description, creditType) {
    const apiKey = c.req.header('X-API-Key');
    const payment = c.req.header('X-Payment');

    // Path 1: API key
    if (apiKey) {
        const result = validateApiKey(apiKey);
        if (!result.valid) {
            return c.json({ error: 'Invalid API key' }, 401);
        }
        c.set('accountId', result.accountId);
        c.set('authMethod', 'api_key');

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

const MIN_UNLOCK_PRICE = 0.005;
const MAX_UNLOCK_PRICE = 1.00;   // H-3: ceiling to prevent runaway prices
const DEFAULT_UNLOCK_PRICE = 0.005;

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

  let results = learnings.map(learning => {
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

// ─── Phase 0.1: Account Routes (SPEC-P0.1) ──────────────────────────────────
setupAccountRoutes(app);

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

    // Only process checkout.session.completed
    if (event.type !== 'checkout.session.completed') {
        return c.json({ received: true, processed: false });
    }

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

    console.log(`[stripe] Credited account ${account_id}: +${queries} queries, +${unlocks} unlocks (${pack_id})`);
    return c.json({ received: true, processed: true, purchase_id: purchase.id });
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

// ─── Phase 0.5: Account Wallet + Earnings Endpoints (SPEC-P0.5) ──────────────

// POST /account/link-wallet — link a verified wallet to the authenticated account
app.post('/account/link-wallet', requireAuth, async (c) => {
  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { wallet } = body || {};
  const accountId = c.get('accountId');

  // linkWallet validates format, verified status, uniqueness, and no-existing-wallet constraints
  const result = linkWallet(accountId, wallet, verifiedWallets);
  if (!result.success) {
    return c.json({ error: result.error }, result.status_code || 400);
  }

  // Reload updated accounts after linkWallet wrote them
  accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));

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

  // Reload accounts to get current wallet linkage state
  let currentAccounts = accounts;
  try { currentAccounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch { /* use cached */ }

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

app.get('/', (c) => {
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
      '/': { price: 'free', method: 'GET', description: 'Service info' },
      '/health': { price: 'free', method: 'GET', description: 'Health check' },
      '/categories': { price: 'free', method: 'GET', description: 'List all categories with counts' },
      '/stats': { price: 'free', method: 'GET', description: 'Registry statistics' },
      '/discover': { price: '$0.001', method: 'POST', description: 'Query capabilities. Body: { "query": "what you need", "category": optional, "type": optional, "limit": optional }' },
      '/skill/:id': { price: '$0.001', method: 'GET', description: 'Full skill details by ID' },
      '/learn': { price: 'free', method: 'POST', description: 'Submit operational knowledge. Body: { title, body, category, tags, task_context, outcome, contributor_wallet }' },
      '/knowledge': { price: '$0.0005', method: 'POST', description: 'Search knowledge. Returns snippets. Body: { "query": "what you need" }' },
      '/knowledge/:id': { price: '$0.005', method: 'GET', description: 'Unlock full learning. 70% goes to contributor.' },
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
      '/renderly': { price: 'free', method: 'GET', description: 'Renderly service info — web content extraction API' },
      '/renderly/markdown': { price: '$0.001', method: 'POST', description: 'Convert URL to clean markdown. Body: { "url": "https://..." }' },
      '/renderly/extract': { price: '$0.001', method: 'POST', description: 'Extract structured data from URL. Body: { "url": "https://..." }' },
      '/renderly/readable': { price: '$0.0005', method: 'POST', description: 'Get readable text from URL. Body: { "url": "https://..." }' },
      '/renderly/llms.txt': { price: 'free', method: 'GET', description: 'Renderly LLM-readable service description' },
      '/renderly/health': { price: 'free', method: 'GET', description: 'Renderly health check' },
      '/renderly/pricing': { price: 'free', method: 'GET', description: 'Renderly pricing info' },
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
    version: VERSION
  });
});

// ─── Paid Endpoints ──────────────────────────────────────────────────

app.post('/discover', dualAuth(0.001, 'Query agent capabilities. Returns ranked matches.', 'query'), async (c) => {
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

app.get('/skill/:id', dualAuth(0.001, 'Get full skill details including content', 'unlock'), (c) => {
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
    return c.json({ error: 'Signature verification failed', details: err.message }, 400);
  }
});

// IR-H-005 FIX: Rate limiting on POST /learn — prevents spam/abuse
const LEARN_RATE_LIMIT = { window_ms: 60_000, max_per_ip: 10, max_per_wallet: 5 };
const learnRateStore = { ip: {}, wallet: {} };

function isLearnRateLimited(type, key) {
  const now = Date.now();
  const limit = type === 'ip' ? LEARN_RATE_LIMIT.max_per_ip : LEARN_RATE_LIMIT.max_per_wallet;
  if (!learnRateStore[type][key]) learnRateStore[type][key] = [];
  learnRateStore[type][key] = learnRateStore[type][key].filter(ts => now - ts < LEARN_RATE_LIMIT.window_ms);
  if (learnRateStore[type][key].length >= limit) return true;
  learnRateStore[type][key].push(now);
  markRateLimitsDirty(); // M-A
  return false;
}

// Submit a learning (FREE — encourages contributions)
app.post('/learn', async (c) => {
  // IR-H-005: Per-IP rate limit check
  const clientIp = getClientIp(c);
  if (isLearnRateLimited('ip', clientIp)) {
    return c.json({ error: 'Rate limit exceeded. Max 10 submissions per minute per IP.' }, 429);
  }

  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { title, body: content, category, tags, task_context, outcome,
    contributor_wallet, contributor_agent, related_skills, unlock_price,
    quality_self_assessment, extraction_context } = body;

  // Validation
  if (!title || title.length < 10) return c.json({ error: 'Title must be at least 10 characters' }, 400);
  if (!content || content.length < 50) return c.json({ error: 'Body must be at least 50 characters' }, 400);
  if (content.length > 50000) return c.json({ error: 'Body exceeds 50KB limit' }, 400);
  if (!category) return c.json({ error: 'Category is required' }, 400);
  if (!VALID_CATEGORIES.includes(category)) {
    return c.json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` }, 400);
  }
  if (!tags || !Array.isArray(tags) || tags.length === 0) return c.json({ error: 'At least one tag required' }, 400);
  if (!task_context) return c.json({ error: 'task_context is required' }, 400);
  if (!outcome || !['success', 'partial', 'failure', 'workaround'].includes(outcome)) {
    return c.json({ error: 'outcome must be success, partial, failure, or workaround' }, 400);
  }
  if (!contributor_wallet || !isAddress(contributor_wallet)) {
    return c.json({ error: 'Valid contributor_wallet (0x...) required for revenue sharing' }, 400);
  }
  const walletLower = contributor_wallet.toLowerCase();
  if (!verifiedWallets[walletLower]) {
    return c.json({ error: 'Wallet not verified. Call /wallet/challenge and /wallet/verify first.' }, 403);
  }
  // IR-H-005: Per-wallet rate limit check (stricter — 5/min per wallet)
  if (isLearnRateLimited('wallet', walletLower)) {
    return c.json({ error: 'Rate limit exceeded. Max 5 submissions per minute per wallet.' }, 429);
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

  const resolvedPrice = unlock_price !== undefined ? Number(unlock_price) : DEFAULT_UNLOCK_PRICE;

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

  // SPEC-P0.5: Optionally detect JWT session and attach contributor_account_id
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
        // Invalid JWT is not an error for /learn — wallet auth is sufficient
      }
    }
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
    contributor_wallet: walletLower,
    contributor_account_id,  // SPEC-P0.5: null if no JWT session, acc_... if logged in
    contributor_agent: contributor_agent || 'unknown',
    related_skills: related_skills || [],
    ...(quality_self_assessment && { quality_self_assessment }),
    ...(extraction_context && { extraction_context }),
    quality: { unlocks: 0, ratings: 0, avg_helpfulness: 0, helpfulness_scores: [], score: 0 },
    earnings: { gross_usd: 0, contributor_share_usd: 0, platform_share_usd: 0 },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  // SPEC-P1.1: Apply extraction_confidence ranking boost (capped at +5)
  if (quality_self_assessment && typeof quality_self_assessment.extraction_confidence === 'number') {
    learning.quality.score = Math.min(quality_self_assessment.extraction_confidence * 5, 5);
  }

  learnings.push(learning);
  safeWrite(LEARNINGS_FILE, learnings);

  return c.json({
    id: learning.id,
    message: 'Learning submitted successfully',
    unlock_price: resolvedPrice,
    contributor_wallet: learning.contributor_wallet,
    timestamp: new Date().toISOString()
  }, 201);
});

// ── POST /extract — Learning Extractor ──────────────────────────────────────
// S9-5: auth fixed (S-1/F-2 audit finding) — use adminAuth('admin') instead of
// broken c.get('session') check. OpenClaw adapter calls extractLearnings directly
// (not via HTTP), so this endpoint is only used by external admin callers.
app.post('/extract', adminAuth('admin'), async (c) => {
  // S9-5: rate limit call fixed — correct (type, key) argument order
  const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
  if (isLearnRateLimited('ip', ip)) {
    return c.json({ error: 'Rate limit exceeded. Try again later.' }, 429);
  }

  // Check Anthropic API key
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return c.json({ error: 'Extraction service not configured' }, 503);
  }

  // Parse and validate body
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { transcript, config, contributor_wallet } = body;
  if (!transcript || typeof transcript !== 'string') {
    return c.json({ error: 'transcript is required and must be a string (100-500000 chars)' }, 400);
  }
  if (transcript.trim().length < 100 || transcript.trim().length > 500000) {
    return c.json({ error: 'transcript is required and must be a string (100-500000 chars)' }, 400);
  }

  // Construct LLM call using Anthropic Messages API
  const llmCall = async (prompt) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic API error ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.content[0].text;
  };

  // Construct search function wrapping matchLearnings
  const searchFn = async (query, opts) => {
    return matchLearnings(query, opts);
  };

  // Run extraction pipeline
  try {
    const result = await extractLearnings(transcript, {
      llmCall,
      searchFn,
      config: config || {},
      contributor_wallet: contributor_wallet || null,
    });
    return c.json(result, 200);
  } catch (err) {
    if (err.name === 'ExtractorError') {
      return c.json({ error: err.message }, 400);
    }
    console.error('[POST /extract] Unexpected error:', err.message);
    return c.json({ error: 'Internal extraction error' }, 500);
  }
});

// Search knowledge (PAID $0.0005 — returns snippets, no full body)
app.post('/knowledge', dualAuth(0.0005, 'Search agent knowledge base. Returns ranked snippets.', 'query'), async (c) => {
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
      unlock_price_usd: r.unlock_price || DEFAULT_UNLOCK_PRICE,
      quality: { score: computeScore(r), unlocks: r.quality.unlocks, ratings: r.quality.ratings, avg_helpfulness: r.quality.avg_helpfulness },
      relevance: r.relevance
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
  const totalContributors = earningsEntries.length;

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
  const UNLOCK_PRICE = learning.unlock_price || DEFAULT_UNLOCK_PRICE;
  const CONTRIBUTOR_SHARE = 0.7;

  // Dynamic x402 verification — price comes from the learning itself
  const rejection = await dualAuthDynamic(c, UNLOCK_PRICE,
    `Unlock "${learning.title}" — ${UNLOCK_PRICE} USDC. 70% goes to contributor.`, 'unlock');
  if (rejection) return rejection;

  // Track unlock
  learning.quality.unlocks = (learning.quality.unlocks || 0) + 1;

  // Track earnings
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
}

const rateLimitCleanupInterval = setInterval(sweepRateLimitStores, RATE_LIMIT_CLEANUP_INTERVAL_MS);
rateLimitCleanupInterval.unref(); // Don't prevent process exit

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

  // SPEC-P0.5: resolve via __wallet_index (account-keyed) or direct wallet key
  const { entry, source: withdrawSource } = resolveEarningsEntry(earnings, { wallet: walletLower });
  if (withdrawSource === 'new' || typeof entry.pending_balance !== 'number' || entry.pending_balance < 0.05) {
    return c.json({ error: 'Insufficient pending balance (min $0.05 USDC)' }, 400);
  }

  // Server-side computed payout amount (IMPL-05: never trust client-provided amount)
  const payout_amount = Number(entry.pending_balance.toFixed(6));

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
    return c.json({ error: 'Signature verification failed', details: err.message }, 400);
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

    const freshPayout = Number(freshEntry.pending_balance.toFixed(6));
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

  let settlements = [];
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
