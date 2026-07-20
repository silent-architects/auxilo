// lib/wal.js
//
// Write-Ahead Log (WAL) for crash-safe dual-write operations.
// Provides atomicity guarantees for multi-step disk writes (e.g., the
// unlock handler writing both learnings.json and earnings.json).
//
// Protocol:
//   1. createWalEntry(operation, payload)  — write WAL file before doing anything
//   2. markStepComplete(id, step)          — record each step as it completes
//   3. commitWal(id)                       — delete WAL file (operation done)
//
// On startup, any surviving WAL files represent interrupted operations.
// The caller is responsible for replaying them via getPendingWalEntries().
//
// Addresses: C3 (non-atomic dual write on unlock)

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WAL_DIR = path.join(__dirname, '..', 'data', 'wal');

// Ensure WAL directory exists on first require
if (!fs.existsSync(WAL_DIR)) {
    fs.mkdirSync(WAL_DIR, { recursive: true });
}

/**
 * Create a WAL entry and persists it to disk before any writes begin.
 *
 * @param {string} operation - e.g. 'unlock'
 * @param {object} payload   - all data needed to replay the operation
 * @returns {string}          the WAL entry ID
 */
function createWalEntry(operation, payload) {
    const id = crypto.randomUUID();
    const entry = {
        id,
        operation,
        payload,
        steps_completed: [],
        created_at: Date.now(),
    };
    _writeWalFile(id, entry);
    return id;
}

/**
 * Mark a named step as completed within a WAL entry.
 * Call this immediately after each sub-write succeeds.
 *
 * @param {string} id   - WAL entry ID
 * @param {string} step - step name, e.g. 'update_learnings'
 */
function markStepComplete(id, step) {
    const entry = _readWalFile(id);
    if (!entry) {
        console.warn(`[wal] markStepComplete: entry ${id} not found`);
        return;
    }
    if (!entry.steps_completed.includes(step)) {
        entry.steps_completed.push(step);
    }
    _writeWalFile(id, entry);
}

/**
 * AUD19-16: Merge additional fields into a WAL entry's payload after creation.
 * Used by the /withdraw timeout branch to record the broadcast disposition
 * (and tx_hash) BEFORE the debit lands, so startup recovery can replay the
 * correct completion (a timeout settlement record, not a 'settled' one) even
 * when the crash hit between broadcast and the first ledger write.
 *
 * @param {string} id    - WAL entry ID
 * @param {object} patch - fields merged (shallow) into entry.payload
 */
function updateWalPayload(id, patch) {
    const entry = _readWalFile(id);
    if (!entry) {
        console.warn(`[wal] updateWalPayload: entry ${id} not found`);
        return;
    }
    entry.payload = { ...(entry.payload || {}), ...(patch || {}) };
    _writeWalFile(id, entry);
}

/**
 * Commit a WAL entry by deleting its file.
 * Only call this after ALL steps have succeeded.
 *
 * @param {string} id - WAL entry ID
 */
function commitWal(id) {
    const filePath = _walPath(id);
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (err) {
        console.error(`[wal] Failed to commit (delete) WAL entry ${id}:`, err.message);
    }
}

/**
 * AUD19-10: Abort a WAL entry — the operation was compensated in-request (e.g.
 * a credit-funded unlock whose delivery failed and whose credit was refunded),
 * so the entry must NOT survive to be replayed at startup: a replay would
 * re-land an accrual whose funding was already returned to the buyer.
 *
 * Returns true when the entry is guaranteed gone (deleted now, or already
 * absent — either way nothing can replay). Returns false ONLY when the file
 * could not be removed; in that case the caller must NOT refund (the accrual
 * will land on replay, and refunding too would double-pay).
 *
 * @param {string} id - WAL entry ID
 * @returns {boolean} true when nothing can replay for this id
 */
function abortWal(id) {
    const filePath = _walPath(id);
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        return true;
    } catch (err) {
        console.error(`[wal] Failed to abort WAL entry ${id}:`, err.message);
        return false;
    }
}

/**
 * Return all pending (uncommitted) WAL entries.
 * Used at startup to replay interrupted operations.
 *
 * @returns {Array<object>}
 */
function getPendingWalEntries() {
    let files;
    try {
        files = fs.readdirSync(WAL_DIR).filter(f => f.endsWith('.wal.json'));
    } catch (err) {
        console.error('[wal] Failed to read WAL directory:', err.message);
        return [];
    }

    const entries = [];
    for (const file of files) {
        try {
            const raw = fs.readFileSync(path.join(WAL_DIR, file), 'utf8');
            entries.push(JSON.parse(raw));
        } catch (err) {
            console.error(`[wal] Could not parse WAL file ${file}:`, err.message);
            // Intentionally leave corrupt file on disk for manual inspection
        }
    }
    return entries;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function _walPath(id) {
    return path.join(WAL_DIR, `${id}.wal.json`);
}

function _writeWalFile(id, entry) {
    const filePath = _walPath(id);
    const tmp = filePath + '.tmp';
    // S26-2: fsync before rename — ensures WAL entry survives power loss.
    // Matching the writeAndSync() pattern used by server.js for financial files.
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeSync(fd, JSON.stringify(entry, null, 2));
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
}

function _readWalFile(id) {
    try {
        const raw = fs.readFileSync(_walPath(id), 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

module.exports = {
    createWalEntry,
    markStepComplete,
    updateWalPayload,
    commitWal,
    abortWal,
    getPendingWalEntries,
};
