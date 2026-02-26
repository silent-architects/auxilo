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
    fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
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
    commitWal,
    getPendingWalEntries,
};
