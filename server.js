const { Hono } = require('hono');
const { serve } = require('@hono/node-server');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isAddress } = require('viem');
const {
  createNonce,
  consumeNonce,
  verifyChallengeSignature,
  verifyWithdrawalSignature,
  EIP712_DOMAIN,
} = require('./lib/eip712.js');
const { scanLearning, getRedactionHint } = require('./lib/sensitivity-filter.js');

const app = new Hono();

const WALLET = '0x1BE960313c93b3aA0AA62BF33B300CAB48c36Ca6';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FACILITATOR = 'https://facilitator.openx402.ai';
const VERSION = '0.3.0';

// Load skill catalog
let skills = [];
try {
  skills = JSON.parse(fs.readFileSync(path.join(__dirname, 'skills.json'), 'utf8'));
} catch (e) {
  console.error('Failed to load skills.json:', e.message);
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
const VERIFIED_WALLETS_FILE = path.join(DATA_DIR, 'verified-wallets.json');
// WALLET_CHALLENGES_FILE removed — nonces are now in-memory via lib/eip712.js (SPEC-A3)
const SETTLEMENTS_FILE = path.join(DATA_DIR, 'settlements.jsonl');

let learnings = [];
try { learnings = JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf8')); } catch { learnings = []; }

let earnings = {};
try { earnings = JSON.parse(fs.readFileSync(EARNINGS_FILE, 'utf8')); } catch { earnings = {}; }

let verifiedWallets = {};
try { verifiedWallets = JSON.parse(fs.readFileSync(VERIFIED_WALLETS_FILE, 'utf8')); } catch { verifiedWallets = {}; }
verifiedWallets[WALLET.toLowerCase()] = true; // Auto-verify platform wallet

// walletChallenges removed — nonces are now in-memory via lib/eip712.js (SPEC-A3)

// Step 5: Earnings Migration
for (const w of Object.keys(earnings)) {
  const entry = earnings[w];
  if (entry && entry.total_withdrawn === undefined) {
    entry.total_withdrawn = 0;
    entry.pending_balance = entry.total_contributor || 0;
    entry.withdrawal_count = 0;
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

let lastBackupCleanup = 0;
function safeWrite(filepath, data) {
  const tmp = filepath + '.tmp';
  const strData = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, strData);
  fs.renameSync(tmp, filepath);
  try {
    const filename = path.basename(filepath);
    const dateStr = new Date().toISOString().split('T')[0];
    const backupPath = path.join(BACKUP_DIR, `${filename}-${dateStr}.json`);
    fs.writeFileSync(backupPath + '.tmp', strData);
    fs.renameSync(backupPath + '.tmp', backupPath);
  } catch (e) {
    console.error('Backup failed:', e.message);
  }
  // Cleanup old backups (keep last 7 days), runs max once per hour to avoid blocking hot paths
  if (Date.now() - lastBackupCleanup > 3600000) {
    lastBackupCleanup = Date.now();
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
    }
  }
}

function appendSettlement(s) {
  fs.appendFileSync(SETTLEMENTS_FILE, JSON.stringify(s) + '\n');
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

// ─── Write-Ahead Log (SPEC-A2 / C3) ────────────────────────────────────────
const { createWalEntry, markStepComplete, commitWal, getPendingWalEntries } = require('./lib/wal.js');

// ─── WAL Crash Recovery (SPEC-A2 / C3) ─────────────────────────────────────
const { acquireWalletLock, getActiveLockCount } = require('./lib/wallet-lock.js');

/**
 * Replay a partial unlock operation from a WAL entry.
 * Only credits the steps that were NOT yet completed when the crash occurred.
 * IMPL-A2-02: payload stores contributor_earned + platform_earned separately.
 */
function replayUnlock(entry) {
  const { learning_id, builder_wallet, unlock_price, contributor_earned, platform_earned } = entry.payload;
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

    if (!earnings[builder_wallet]) {
      earnings[builder_wallet] = {
        total_gross: 0, total_contributor: 0, total_platform: 0,
        by_learning: {}, last_updated: null,
        pending_balance: 0, total_withdrawn: 0, withdrawal_count: 0,
      };
    }

    const e = earnings[builder_wallet];
    e.total_gross += unlock_price;
    e.total_contributor += contributor_earned;
    e.total_platform += platform_earned;
    e.pending_balance += contributor_earned;
    e.last_updated = new Date().toISOString();

    if (!e.by_learning[learning_id]) {
      e.by_learning[learning_id] = { gross: 0, contributor: 0, platform: 0, unlocks: 0 };
    }
    e.by_learning[learning_id].gross += unlock_price;
    e.by_learning[learning_id].contributor += contributor_earned;
    e.by_learning[learning_id].platform += platform_earned;
    e.by_learning[learning_id].unlocks += 1;

    safeWrite(EARNINGS_FILE, earnings);
    console.log(`[wal-recovery] ${entry.id}: earnings replayed (+${contributor_earned.toFixed(6)} USDC to ${builder_wallet})`);
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
    const entry = earnings[s.wallet];
    if (!entry) { console.warn(`[SETTLEMENT] No earnings entry for ${s.wallet}`); continue; }

    if (!entry.processed_settlements) entry.processed_settlements = {};
    if (entry.processed_settlements[s.id]) {
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

/**
 * Release a reservation that is no longer backed by an active settlement.
 * Placeholder for SPEC-A1's reservation ledger.
 */
function releaseOrphanedReservation(wallet, amount) {
  releaseReservation(wallet);
  console.log(`[settlement-daemon] Released orphaned reservation: ${wallet} ${amount} USDC`);
}

/**
 * Scan earnings ledger for drift relative to settled/withdrawn totals.
 * IMPL-A2-04: uses total_withdrawn (not withdrawn — that field does not exist).
 */
function runConsistencyCheck() {
  for (const [w, entry] of Object.entries(earnings)) {
    if (entry.pending_balance !== undefined && entry.total_contributor !== undefined) {
      const expected = (entry.total_contributor || 0) - (entry.total_withdrawn || 0);
      const actual = entry.pending_balance;
      if (Math.abs(expected - actual) > 0.000001) {
        console.warn(
          `[CONSISTENCY] Wallet ${w}: expected pending=${expected.toFixed(6)}, ` +
          `actual=${actual.toFixed(6)}. Drift: ${(actual - expected).toFixed(6)}`
        );
      }
    }
  }
}

/**
 * C4 fix: retry or auto-refund settlements in 'pending' or 'retry' status.
 * Uses append-only JSONL semantics (appendSettlement) — IMPL-A2-03: never rewrites the full file.
 * IMPL-A2-05: missing created_at defaults to Date.now() (treat as new, not ancient).
 */
async function resolveStuckSettlements() {
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

  if (candidates.length === 0) {
    console.log('[settlement-daemon] No pending/retry settlements found.');
    return;
  }

  let earningsChanged = false;

  for (const s of candidates) {
    const retryCount = s.retry_count ?? 0;
    // IMPL-A2-05: missing created_at → treat as brand-new (Date.now()), not epoch (0)
    const age = Date.now() - (s.created_at ?? Date.now());

    if (retryCount >= SETTLEMENT_MAX_RETRIES) {
      if (age > SETTLEMENT_REFUND_AGE_MS) {
        // Max retries exhausted AND old enough — auto-refund
        console.log(`[settlement-daemon] ${s.id}: max retries + age exceeded, auto-refunding ${s.wallet}`);
        const entry = earnings[s.wallet];
        if (entry) {
          entry.pending_balance += s.amount;
          earningsChanged = true;
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
      const entry = earnings[s.wallet];
      if (entry) {
        entry.total_withdrawn = (entry.total_withdrawn || 0) + s.amount;
        entry.pending_balance = Math.max(0, (entry.pending_balance || 0) - s.amount);
        if (!entry.processed_settlements) entry.processed_settlements = {};
        entry.processed_settlements[s.id] = true;
        earningsChanged = true;
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

  if (earningsChanged) safeWrite(EARNINGS_FILE, earnings);
  runConsistencyCheck();
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
      if (earnings[wallet_address]) {
        earnings[wallet_address].total_withdrawn = parseFloat(
          (earnings[wallet_address].total_withdrawn + amount).toFixed(6)
        );
        earnings[wallet_address].withdrawal_count = (earnings[wallet_address].withdrawal_count || 0) + 1;
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

function generateId() {
  return 'lrn_' + Math.random().toString(36).substring(2, 10);
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

const MIN_UNLOCK_PRICE = 0.005;
const DEFAULT_UNLOCK_PRICE = 0.005;

// ─── Search/Match Engine ─────────────────────────────────────────────
function matchSkills(query, filters = {}) {
  const q = query.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(t => t.length > 1);

  let results = skills.map(skill => {
    let score = 0;
    const searchable = [
      skill.name,
      skill.description,
      ...skill.tags,
      skill.category
    ].join(' ').toLowerCase();

    // Exact phrase match in name/description
    if (searchable.includes(q)) score += 10;

    // Individual token matches
    for (const token of tokens) {
      if (skill.name.toLowerCase().includes(token)) score += 5;
      if (skill.description.toLowerCase().includes(token)) score += 3;
      if (skill.tags.some(t => t.toLowerCase().includes(token))) score += 4;
      if (skill.category.toLowerCase().includes(token)) score += 2;
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
function computeScore(learning) {
  const q = learning.quality;
  const ageDays = (Date.now() - new Date(learning.created_at).getTime()) / 86400000;
  const unlockSignal = Math.min((q.unlocks || 0) * 2, 40);
  const helpScores = q.helpfulness_scores || [];
  const avgHelp = helpScores.length > 0
    ? helpScores.reduce((a, b) => a + b, 0) / helpScores.length
    : 2.5;
  const helpSignal = avgHelp * 8;
  const ratingVolume = Math.min((q.ratings || 0), 20);
  const recencyPenalty = Math.min(ageDays * 0.05, 10);
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

    if (searchable.includes(q)) textScore += 10;
    for (const token of tokens) {
      if (learning.title.toLowerCase().includes(token)) textScore += 5;
      if (learning.body.toLowerCase().includes(token)) textScore += 3;
      if (learning.tags.some(t => t.toLowerCase().includes(token))) textScore += 4;
      if (learning.task_context.toLowerCase().includes(token)) textScore += 3;
    }

    const qualityScore = computeScore(learning);
    return { ...learning, _score: (textScore * 10) + qualityScore, _textScore: textScore };
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
      '/openapi.json': { price: 'free', method: 'GET', description: 'OpenAPI 3.0 specification for all endpoints' },
      '/.well-known/agent.json': { price: 'free', method: 'GET', description: 'A2A agent card (Google Agent-to-Agent protocol)' },
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

app.post('/discover', x402Gate(0.001, 'Query agent capabilities. Returns ranked matches.'), async (c) => {
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
      relevance: r.relevance
    })),
    knowledge_hint: learnings.length > 0
      ? `Auxilo also has ${learnings.length} operational learnings from other agents. Try POST /knowledge to find tips before using these tools.`
      : null,
    timestamp: new Date().toISOString()
  });
});

app.get('/skill/:id', x402Gate(0.001, 'Get full skill details including content'), (c) => {
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
    return true; // allowed
  }

  if (entry.count >= CHALLENGE_RATE_LIMIT) {
    return false; // rate limited
  }

  entry.count++;
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

  // C7 FIX: Consume nonce BEFORE verification (single-use enforcement)
  const nonceData = consumeNonce(wallet);
  if (!nonceData) {
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

// Submit a learning (FREE — encourages contributions)
app.post('/learn', async (c) => {
  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { title, body: content, category, tags, task_context, outcome,
    contributor_wallet, contributor_agent, related_skills, unlock_price } = body;

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
  if (unlock_price !== undefined) {
    const price = Number(unlock_price);
    if (isNaN(price) || price < MIN_UNLOCK_PRICE) {
      return c.json({ error: `unlock_price must be >= $${MIN_UNLOCK_PRICE} USD` }, 400);
    }
  }

  const resolvedPrice = unlock_price !== undefined ? Number(unlock_price) : DEFAULT_UNLOCK_PRICE;

  // --- Duplicate detection ---
  const normalizedBody = content.toLowerCase().replace(/\s+/g, ' ').trim();
  const bodyHash = crypto.createHash('sha256').update(normalizedBody).digest('hex');
  const normalizedTitle = title.toLowerCase().replace(/\s+/g, ' ').trim();

  const duplicate = learnings.find(existing => {
    // Exact body match (normalized)
    const existingBodyNorm = existing.body.toLowerCase().replace(/\s+/g, ' ').trim();
    const existingHash = crypto.createHash('sha256').update(existingBodyNorm).digest('hex');
    if (existingHash === bodyHash) return true;
    // Exact title match (normalized) within same category
    const existingTitleNorm = existing.title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (existingTitleNorm === normalizedTitle && existing.category === category) return true;
    return false;
  });

  if (duplicate) {
    return c.json({
      error: 'Duplicate learning detected',
      existing_id: duplicate.id,
      existing_title: duplicate.title,
      message: 'A learning with the same content or title+category already exists. If this is an update, consider submitting with a different title or additional context.'
    }, 409);
  }
  // --- End duplicate detection ---

  // --- Sensitivity filter ---
  const scanResult = scanLearning({ title, body: content, task_context, tags });
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

  const learning = {
    id: generateId(),
    title,
    snippet: content.substring(0, 120) + (content.length > 120 ? '...' : ''),
    body: content,
    category,
    tags,
    task_context,
    outcome,
    unlock_price: resolvedPrice,
    contributor_wallet: walletLower,
    contributor_agent: contributor_agent || 'unknown',
    related_skills: related_skills || [],
    quality: { unlocks: 0, ratings: 0, avg_helpfulness: 0, helpfulness_scores: [], score: 0 },
    earnings: { gross_usd: 0, contributor_share_usd: 0, platform_share_usd: 0 },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

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

// Search knowledge (PAID $0.0005 — returns snippets, no full body)
app.post('/knowledge', x402Gate(0.0005, 'Search agent knowledge base. Returns ranked snippets.'), async (c) => {
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
  const totalEarnings = Object.values(earnings).reduce((sum, w) => sum + w.total_gross, 0);
  const totalContributors = Object.keys(earnings).length;

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
  const rejection = await verifyPaymentOrReject(c, UNLOCK_PRICE,
    `Unlock "${learning.title}" — ${UNLOCK_PRICE} USDC. 70% goes to contributor.`);
  if (rejection) return rejection;

  // Track unlock
  learning.quality.unlocks = (learning.quality.unlocks || 0) + 1;

  // Track earnings
  const contributorEarned = UNLOCK_PRICE * CONTRIBUTOR_SHARE;
  const platformEarned = UNLOCK_PRICE * (1 - CONTRIBUTOR_SHARE);

  learning.earnings.gross_usd = (learning.earnings.gross_usd || 0) + UNLOCK_PRICE;
  learning.earnings.contributor_share_usd = (learning.earnings.contributor_share_usd || 0) + contributorEarned;
  learning.earnings.platform_share_usd = (learning.earnings.platform_share_usd || 0) + platformEarned;

  // Update contributor ledger
  const wallet = learning.contributor_wallet;
  if (!earnings[wallet]) {
    earnings[wallet] = { total_gross: 0, total_contributor: 0, total_platform: 0, by_learning: {}, last_updated: null, pending_balance: 0, total_withdrawn: 0, withdrawal_count: 0 };
  }
  earnings[wallet].total_gross += UNLOCK_PRICE;
  earnings[wallet].total_contributor += contributorEarned;
  earnings[wallet].total_platform += platformEarned;
  if (!earnings[wallet].by_learning[id]) {
    earnings[wallet].by_learning[id] = { gross: 0, contributor: 0, platform: 0, unlocks: 0 };
  }
  earnings[wallet].by_learning[id].gross += UNLOCK_PRICE;
  earnings[wallet].by_learning[id].contributor += contributorEarned;
  earnings[wallet].by_learning[id].platform += platformEarned;
  earnings[wallet].by_learning[id].unlocks += 1;
  earnings[wallet].pending_balance += contributorEarned;
  earnings[wallet].last_updated = new Date().toISOString();

  // SPEC-A2 C3: WAL-protected dual write — crash-safe atomicity
  // IMPL-A2-02: payload stores contributor_earned + platform_earned separately (not gross amount)
  const walId = createWalEntry('unlock', {
    learning_id: id,
    builder_wallet: wallet,
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
app.post('/knowledge/:id/rate', async (c) => {
  const id = c.req.param('id');
  const idx = learnings.findIndex(l => l.id === id);

  if (idx === -1) return c.json({ error: 'Learning not found', id }, 404);

  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { helpfulness, notes } = body;
  if (!helpfulness || helpfulness < 1 || helpfulness > 5) {
    return c.json({ error: 'helpfulness must be 1-5' }, 400);
  }

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
  const data = earnings[wallet];

  if (!data) {
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
  try {
    return JSON.parse(fs.readFileSync(RESERVATIONS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveReservations(reservations) {
  const tmp = RESERVATIONS_FILE + '.tmp';
  const strData = JSON.stringify(reservations, null, 2);
  fs.writeFileSync(tmp, strData);
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

  const entry = earnings[walletLower];
  if (!entry || typeof entry.pending_balance !== 'number' || entry.pending_balance < 0.05) {
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

    if (timeSinceLastAttempt < WITHDRAWAL_RATE_LIMIT_MS) {
      const retry_after = Math.ceil((WITHDRAWAL_RATE_LIMIT_MS - timeSinceLastAttempt) / 1000);
      return c.json({ error: 'Rate limited. One withdrawal per hour.', retry_after }, 429);
    }

    // 3. Load earnings + check pending balance
    if (!entry || typeof entry.pending_balance !== 'number') {
      return c.json({ error: 'No earnings found' }, 404);
    }

    const pendingBalance = entry.pending_balance;
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
    const settlementId = `wd_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
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
      earnings_before: { ...entry }
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

      // Step A: Deduct from earnings
      entry.total_withdrawn = parseFloat((entry.total_withdrawn + payout_amount).toFixed(6));
      entry.withdrawal_count = (entry.withdrawal_count || 0) + 1;
      entry.pending_balance = parseFloat((entry.pending_balance - payout_amount).toFixed(6));
      if (!entry.processed_settlements) entry.processed_settlements = {};
      entry.processed_settlements[settlementId] = true;

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
  const entry = earnings[walletLower];
  if (!entry) return c.json({ error: 'Wallet not found' }, 404);

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
    total_platform_earnings: Object.values(earnings).reduce((s, e) => s + (e.total_platform || 0), 0)
  });
});

// POST /admin/settle — admin scope required (read token rejected)
app.post('/admin/settle', adminAuth('admin'), async (c) => {
  return c.json({ error: 'Manual settle not fully implemented yet' }, 501);
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

// ─── Start ───────────────────────────────────────────────────────────
const PORT = 3000;
console.log(`Auxilo v${VERSION} starting on port ${PORT}...`);
console.log(`Catalog: ${skills.length} skills loaded`);
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Auxilo running at http://0.0.0.0:${PORT}`);
  console.log(`Wallet: ${WALLET}`);
  console.log(`x402 payments on Base mainnet`);
});
