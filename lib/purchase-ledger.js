'use strict';

// ─── LW-7: durable purchaser ledger ──────────────────────────────────────────
//
// Proof-of-purchase records backing the rating endpoint's "must have unlocked
// it to rate it" gate. DELIBERATELY a separate store from
// lib/unlock-attribution.js: that file is the accrual-CAP store — it prunes
// every entry older than 30 days on every write, records only non-capped
// credit-path accruals, and exists for solvency, not rights. Rating
// eligibility is a durable RIGHT (a buyer may rate a learning they unlocked
// months ago), so it gets its own never-pruned file with its own contract
// rather than a dual-retention schema one prune-loop bug away from deleting
// purchase proofs.
//
// Written by the unlock handler at DELIVERY SUCCESS only:
//   - normal accrual path and capped-repeat path (both delivered content);
//   - NEVER on the self-unlock path (a contributor rating their own learning
//     is exactly the manipulation LW-7 exists to stop);
//   - NEVER on a refunded delivery failure (recording sits after the WAL
//     commit, and the AUD19-10 compensation path returns before it).
// Anonymous x402 buyers have no account and are not recorded — they cannot
// rate (documented breaking change, LW-7).
//
// Store: data/purchase-ledger.json — flat map
//   "<accountId>:<learningId>" -> { first_ts, last_ts, count }
// Read-per-call + tmp/rename atomic save, same idiom as lib/credits.js.

const fs = require('fs');
const path = require('path');

// AUXILO_PURCHASE_LEDGER_FILE override: test isolation only (unset in production).
const LEDGER_FILE = process.env.AUXILO_PURCHASE_LEDGER_FILE
    || path.join(__dirname, '..', 'data', 'purchase-ledger.json');

function loadLedger() {
    try { return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')); }
    catch { return {}; }
}

function saveLedger(map) {
    fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
    const tmp = LEDGER_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, LEDGER_FILE);
}

function ledgerKey(accountId, learningId) {
    return `${accountId}:${learningId}`;
}

/**
 * Record a delivered, account-authenticated unlock. Idempotent-additive:
 * repeat unlocks bump count/last_ts, first_ts is preserved.
 */
function recordPurchase(accountId, learningId, now = Date.now()) {
    if (!accountId || !learningId) return;
    const map = loadLedger();
    const key = ledgerKey(accountId, learningId);
    const existing = map[key];
    if (existing && typeof existing === 'object') {
        existing.last_ts = now;
        existing.count = (existing.count || 0) + 1;
    } else {
        map[key] = { first_ts: now, last_ts: now, count: 1 };
    }
    saveLedger(map);
}

/**
 * True when this account has at least one delivered unlock of this learning.
 * Never expires — the ledger is not pruned.
 */
function hasPurchase(accountId, learningId) {
    if (!accountId || !learningId) return false;
    const map = loadLedger();
    const entry = map[ledgerKey(accountId, learningId)];
    return !!(entry && typeof entry === 'object' && (entry.count || 0) > 0);
}

module.exports = {
    recordPurchase,
    hasPurchase,
    // Exported for testing only:
    loadLedger,
    saveLedger,
    LEDGER_FILE,
};
