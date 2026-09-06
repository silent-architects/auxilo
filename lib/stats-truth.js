'use strict';

// ─── STATS-TRUTH: /knowledge/stats derivations ───────────────────────────────
//
// GET /knowledge/stats is a machine-read public surface (agents, the trust
// page, GTM's register). Before this module it served three numbers that were
// not derived from anything checkable:
//
//   total_earnings_usd  — the sum of EVERY earnings.json entry, so test-fixture
//                         entries that own no visible learning were served as
//                         marketplace revenue;
//   total_unlocks       — the sum of the stored quality.unlocks counter, which
//                         can be set by seeding/migration and is not a ledger;
//   total_contributors  — a case-SENSITIVE Set over contributor_wallet, blind to
//                         account-holding contributors with no wallet
//                         (PUNCH-LIST CONTRIB-STAT).
//
// This module derives each of them from the catalog and the ledgers, and
// FAILS CLOSED: what cannot be attributed is not served.
//
//   * contributorIdentity(row) — the ONE identity helper CONTRIB-STAT and
//     PARTITION-GUARD ask for: `contributor_account_id` when present, else the
//     lowercased `contributor_wallet`, else the platform identity (a
//     null-account / null-wallet row is platform-owned, the same reading
//     lib/accounts.js isPlatformContributor gives it).
//   * attributableEarningsUsd — sums `total_gross` ONLY over earnings entries
//     whose KEY is an identity present in the visible catalog (account-id
//     match, or lowercased-wallet match). `__`-prefixed metadata keys and
//     entries with no visible learning contribute nothing.
//   * readUnlockLedger / ledgerUnlockCounts — unlock counts come from the
//     per-unlock event ledger (data/unlock-events.jsonl, written at the
//     WAL-protected commit point of a credited unlock; row shape at
//     server.js appendUnlockEvent: {id, ts, learning_id, amount_paid_usd,
//     funding_source, contributor_account_id, contributor_wallet,
//     settled_onchain}). Rows dedupe on `id` (the WAL id — the reader dedupe
//     key the writer documents). An ABSENT file is an empty ledger (the
//     writer creates it on first append); any other read failure is
//     UNREADABLE and the caller omits the unlock fields instead of serving a
//     counter.
//
// The stored quality.unlocks counter is untouched — computeScore and the
// search projection still read it; only this public surface stops.

const fs = require('fs');

// The first-class platform account id (lib/accounts.js PLATFORM_ACCOUNT_IDS).
// A null-account / null-wallet row resolves here so it and an explicit
// acc_platform row are the same single identity.
const PLATFORM_IDENTITY = 'acc_platform';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The shared contributor-identity key for a catalog row.
 *   contributor_account_id (trimmed)         when present
 *   String(contributor_wallet).toLowerCase() otherwise, when present
 *   PLATFORM_IDENTITY                        for a null-account / null-wallet row
 */
function contributorIdentity(row) {
  if (!row || typeof row !== 'object') return PLATFORM_IDENTITY;
  if (nonEmptyString(row.contributor_account_id)) return row.contributor_account_id.trim();
  if (row.contributor_wallet !== null && row.contributor_wallet !== undefined &&
      String(row.contributor_wallet).trim().length > 0) {
    return String(row.contributor_wallet).trim().toLowerCase();
  }
  return PLATFORM_IDENTITY;
}

function countDistinctContributors(rows) {
  const ids = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    ids.add(contributorIdentity(row));
  }
  return ids.size;
}

/** Account ids and lowercased wallets that appear on visible rows. */
function visibleIdentityIndex(rows) {
  const accountIds = new Set();
  const wallets = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    if (nonEmptyString(row.contributor_account_id)) accountIds.add(row.contributor_account_id.trim());
    if (row.contributor_wallet !== null && row.contributor_wallet !== undefined &&
        String(row.contributor_wallet).trim().length > 0) {
      wallets.add(String(row.contributor_wallet).trim().toLowerCase());
    }
  }
  return { accountIds, wallets };
}

/**
 * Sum of `total_gross` over earnings entries whose KEY is an identity that
 * appears in the visible catalog. Rounded to 2 dp.
 */
function attributableEarningsUsd(earnings, rows) {
  const index = visibleIdentityIndex(rows);
  let sum = 0;
  for (const [key, entry] of Object.entries(earnings && typeof earnings === 'object' ? earnings : {})) {
    if (key.startsWith('__')) continue;
    if (!entry || typeof entry !== 'object') continue;
    const attributable = index.accountIds.has(key) || index.wallets.has(key.toLowerCase());
    if (!attributable) continue;
    const gross = Number(entry.total_gross);
    if (Number.isFinite(gross)) sum += gross;
  }
  return Number(sum.toFixed(2));
}

/**
 * Read the per-unlock event ledger.
 *   { readable: true,  events: [{ id, learning_id }], malformed }  — file read
 *     (ENOENT counts as an EMPTY ledger: the writer creates the file on first
 *     append, so absence means no credited unlock has been recorded);
 *   { readable: false, error }                                     — any other
 *     read failure; callers must OMIT ledger-derived fields.
 * Rows dedupe on `id`; rows without a string learning_id and lines that do
 * not parse are skipped (counted in `malformed`) — undercounting is the safe
 * direction on this surface.
 */
function readUnlockLedger(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { readable: true, events: [], malformed: 0, absent: true };
    return { readable: false, error: err };
  }
  const seen = new Set();
  const events = [];
  let malformed = 0;
  for (const line of String(raw).split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { malformed++; continue; }
    if (!row || typeof row !== 'object' || !nonEmptyString(row.learning_id)) { malformed++; continue; }
    if (row.id !== null && row.id !== undefined) {
      const key = String(row.id);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    events.push({ id: row.id === undefined ? null : row.id, learning_id: row.learning_id });
  }
  return { readable: true, events, malformed, absent: false };
}

/**
 * Unlock counts over a ledger read, filtered to visible learning ids.
 *   null                          — ledger unreadable (omit the fields)
 *   { total, byId: Map<id,count> } otherwise
 */
function ledgerUnlockCounts(ledger, visibleIds) {
  if (!ledger || !ledger.readable) return null;
  const ids = visibleIds instanceof Set ? visibleIds : new Set(visibleIds || []);
  const byId = new Map();
  let total = 0;
  for (const event of ledger.events) {
    if (!ids.has(event.learning_id)) continue;
    byId.set(event.learning_id, (byId.get(event.learning_id) || 0) + 1);
    total++;
  }
  return { total, byId };
}

/**
 * Everything /knowledge/stats needs, in one call.
 * @param {object[]} visibleRows      visibleCatalog()
 * @param {object}   earnings         the earnings.json map
 * @param {string}   unlockEventsFile path to data/unlock-events.jsonl
 */
function computeStatsTruth({ visibleRows, earnings, unlockEventsFile }) {
  const rows = (Array.isArray(visibleRows) ? visibleRows : []).filter(Boolean);
  const ledger = readUnlockLedger(unlockEventsFile);
  const unlocks = ledgerUnlockCounts(ledger, new Set(rows.map((r) => r.id)));
  return {
    total_contributors: countDistinctContributors(rows),
    total_earnings_usd: attributableEarningsUsd(earnings, rows),
    unlocks,
    ledger_readable: ledger.readable,
    ledger_error: ledger.readable ? null : (ledger.error && ledger.error.message) || 'unreadable',
  };
}

module.exports = {
  PLATFORM_IDENTITY,
  contributorIdentity,
  countDistinctContributors,
  visibleIdentityIndex,
  attributableEarningsUsd,
  readUnlockLedger,
  ledgerUnlockCounts,
  computeStatsTruth,
};
