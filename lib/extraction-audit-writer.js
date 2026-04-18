/**
 * lib/extraction-audit-writer.js — Hash-Chained Audit Log Writer (P2.1a §9.1)
 *
 * Append-only, hash-chained audit log with monthly rotation.
 *
 * Design choices:
 *   - B7: cachedLastHash (module-level) initialized to null, populated on first
 *     readLastHash() call, updated in-memory on every append. Disk reads only
 *     on process boot — no O(n) reads per append.
 *   - B7: Time-based rollover: file is data/audit-extractions.YYYY-MM.jsonl.
 *     On rollover, the new file's first row's prev_hash = last hash of previous
 *     month. Chain continues across files.
 *   - appendAuditRow() atomically appends the row under a promise-chain mutex.
 *   - Genesis hash: "sha256:genesis" when no prior row exists.
 *   - Never stores raw transcript, raw learning body, or raw matched values.
 *
 * @module extraction-audit-writer
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUDIT_DIR = path.join(__dirname, '..', 'data');
const GENESIS_HASH = 'sha256:genesis';

// ─── B7: In-memory hash cache ───────────────────────────────────────────────
// Populated on first read from disk, updated on every append.
// Eliminates O(n) disk reads per append after boot.

/** @type {string|null} */
let cachedLastHash = null;

// ─── B7: Monthly file rotation ──────────────────────────────────────────────

/**
 * Compute the audit file path for a given date.
 * Format: data/audit-extractions.YYYY-MM.jsonl
 *
 * @param {Date} [date] - defaults to now
 * @returns {string} Absolute path to the audit file
 */
function getAuditFilePath(date) {
  const d = date || new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return path.join(AUDIT_DIR, `audit-extractions.${yyyy}-${mm}.jsonl`);
}

/**
 * List all audit files in chronological order.
 * @returns {string[]} Sorted array of absolute paths
 */
function listAuditFiles() {
  try {
    return fs.readdirSync(AUDIT_DIR)
      .filter(f => f.startsWith('audit-extractions.') && f.endsWith('.jsonl'))
      .sort()
      .map(f => path.join(AUDIT_DIR, f));
  } catch {
    return [];
  }
}

// ─── Write Mutex ────────────────────────────────────────────────────────────
// Promise-chain mutex: each append waits for the previous to complete.
// This ensures hash chain integrity under concurrent /extract requests.

let writeLock = Promise.resolve();

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Read the entry_hash of the last row across all audit files.
 * Uses cachedLastHash if available; only reads disk on first call.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.forceRead=false] - Force disk read (used by audit:verify)
 * @returns {string}
 */
function readLastHash(opts = {}) {
  // Return cached value if available (B7: no disk read after boot)
  if (cachedLastHash !== null && !opts.forceRead) {
    return cachedLastHash;
  }

  // Read from the most recent audit file on disk
  const files = listAuditFiles();
  if (files.length === 0) {
    cachedLastHash = GENESIS_HASH;
    return GENESIS_HASH;
  }

  // Read last non-empty line from the most recent file
  for (let fi = files.length - 1; fi >= 0; fi--) {
    const content = fs.readFileSync(files[fi], 'utf-8').trim();
    if (!content) continue;

    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.length > 0) {
        try {
          const row = JSON.parse(line);
          if (row.entry_hash) {
            cachedLastHash = row.entry_hash;
            return row.entry_hash;
          }
        } catch {
          continue;
        }
      }
    }
  }

  cachedLastHash = GENESIS_HASH;
  return GENESIS_HASH;
}

/**
 * Compute the hash for an audit row.
 * entry_hash = sha256(JSON.stringify(row_without_entry_hash) + prev_hash)
 *
 * @param {object} row - The audit row (without entry_hash set)
 * @param {string} prevHash - The previous row's entry_hash
 * @returns {string} "sha256:<hex>"
 */
function computeEntryHash(row, prevHash) {
  const payload = JSON.stringify(row) + prevHash;
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  return `sha256:${hash}`;
}

/**
 * Generate a unique audit ID.
 * @returns {string} "audit_<random>"
 */
function generateAuditId() {
  return 'audit_' + crypto.randomBytes(12).toString('hex');
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Append a hash-chained audit row to the audit log.
 *
 * Concurrency-safe: uses a write mutex so only one append is in-flight at a time.
 * The hash chain is maintained across concurrent /extract requests.
 * B7: Uses in-memory cachedLastHash and monthly file rotation.
 *
 * @param {object} rowData - Audit row data (without audit_id, prev_hash, entry_hash, ts).
 * @returns {Promise<{audit_id: string, entry_hash: string}>}
 */
function appendAuditRow(rowData) {
  // B1/B19: consent_version hard assertion — required for every action except
  // kill_switch_reset, consent_grant, consent_revoke.
  // consent_grant/consent_revoke are exempt because the row IS the consent stamp,
  // not something that stamps an existing consent version.
  const CONSENT_VERSION_EXEMPT = ['kill_switch_reset', 'consent_grant', 'consent_revoke'];
  if (!rowData.consent_version && !CONSENT_VERSION_EXEMPT.includes(rowData.action)) {
    throw new Error(`consent_version is required for action: ${rowData.action}`);
  }

  // Queue behind the mutex
  const op = writeLock.then(() => {
    const prevHash = readLastHash();

    const row = {
      audit_id: generateAuditId(),
      prev_hash: prevHash,
      ts: new Date().toISOString(),
      ...rowData,
    };

    // Compute entry hash (over the row without entry_hash, plus prev_hash)
    row.entry_hash = computeEntryHash(row, prevHash);

    // B7: Write to the current month's file (rotation)
    const auditFile = getAuditFilePath();
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.appendFileSync(auditFile, JSON.stringify(row) + '\n', 'utf-8');

    // B7: Update in-memory cache — no disk read needed for next append
    cachedLastHash = row.entry_hash;

    return { audit_id: row.audit_id, entry_hash: row.entry_hash };
  });

  // Update the mutex to wait for this operation
  writeLock = op.catch(() => {}); // swallow errors in the chain so future writes aren't blocked

  return op;
}

/**
 * B7: Verify the integrity of the entire audit chain across all files.
 * Walks all monthly files in chronological order, recomputes hashes,
 * and reports any break.
 *
 * @returns {{ valid: boolean, total: number, errors: Array<{file: string, line: number, error: string}> }}
 */
function verifyAuditChain() {
  const files = listAuditFiles();
  let expectedPrevHash = GENESIS_HASH;
  let total = 0;
  const errors = [];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);

    for (let i = 0; i < lines.length; i++) {
      total++;
      let row;
      try {
        row = JSON.parse(lines[i]);
      } catch (e) {
        errors.push({ file: path.basename(file), line: i + 1, error: `Malformed JSON: ${e.message}` });
        continue;
      }

      // Verify prev_hash chain
      if (row.prev_hash !== expectedPrevHash) {
        errors.push({
          file: path.basename(file),
          line: i + 1,
          error: `Chain break: expected prev_hash=${expectedPrevHash}, got prev_hash=${row.prev_hash}`,
        });
      }

      // Recompute entry_hash
      const storedHash = row.entry_hash;
      const rowWithoutHash = { ...row };
      delete rowWithoutHash.entry_hash;
      const recomputed = computeEntryHash(rowWithoutHash, row.prev_hash);

      if (storedHash !== recomputed) {
        errors.push({
          file: path.basename(file),
          line: i + 1,
          error: `Hash mismatch: stored=${storedHash}, recomputed=${recomputed}`,
        });
      }

      expectedPrevHash = storedHash;
    }
  }

  return { valid: errors.length === 0, total, errors };
}

/**
 * Reset the in-memory hash cache. Used by tests for isolation.
 */
function resetCache() {
  cachedLastHash = null;
}

/**
 * Get the current cached hash value. Used by tests to verify cache behavior.
 * @returns {string|null}
 */
function getCachedHash() {
  return cachedLastHash;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  appendAuditRow,
  readLastHash,
  GENESIS_HASH,
  getAuditFilePath,
  listAuditFiles,
  verifyAuditChain,
  resetCache,
  getCachedHash,
  computeEntryHash,
};
