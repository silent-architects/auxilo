/**
 * lib/ledger-merge.js — lock-protected, merge-on-write ledger save
 * (INCREMENTAL-SWEEP D5).
 *
 * The sweep loads ledger.json once and saved its stale in-memory object after
 * every success, so a mark written meanwhile by a hook-fired runner could be
 * overwritten. saveLedgerMerged re-reads the file under a lock, merges, and
 * writes atomically:
 *   - per source: highWater = max(ISO strings), sessions = union of marks
 *   - lastSweep / lastRealExtractionAt = max
 *   - any other top-level key: this writer's value wins (last-writer-wins)
 * All marks are boolean true and only ever added, so a union loses nothing.
 * fs, clock, sleep and file removal are injectable.
 *
 * @module lib/ledger-merge
 */

'use strict';

const fs = require('fs');
const { withFileLock, atomicWriteJson } = require('./session-offsets');

function maxIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a >= b ? a : b;
}

function mergeLedgers(disk, mine) {
  const d = disk && typeof disk === 'object' ? disk : {};
  const m = mine && typeof mine === 'object' ? mine : {};
  const out = { ...d, ...m };
  const sources = {};
  const ids = new Set([...Object.keys(d.sources || {}), ...Object.keys(m.sources || {})]);
  for (const id of ids) {
    const ds = (d.sources && d.sources[id]) || {};
    const ms = (m.sources && m.sources[id]) || {};
    sources[id] = {
      ...ds,
      ...ms,
      highWater: maxIso(ds.highWater, ms.highWater),
      sessions: { ...(ds.sessions || {}), ...(ms.sessions || {}) },
    };
  }
  out.sources = sources;
  for (const key of ['lastSweep', 'lastRealExtractionAt']) {
    const v = maxIso(d[key], m[key]);
    if (v) out[key] = v;
  }
  return out;
}

/**
 * Save `ledger` to `ledgerPath`, merged with what is on disk. Also folds the
 * merged result back into the caller's object so later saves in the same
 * process stay a superset. Returns the merged ledger.
 *
 * deps: { fsImpl, now, removeFile, sleep, staleMs, waitMs, pollMs, pid, log }
 */
function saveLedgerMerged(ledgerPath, ledger, deps = {}) {
  const fsImpl = deps.fsImpl || fs;
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});

  const run = () => {
    let disk = null;
    try { disk = JSON.parse(fsImpl.readFileSync(ledgerPath, 'utf-8')); } catch { /* absent or corrupt */ }
    const merged = mergeLedgers(disk, ledger);
    atomicWriteJson(fsImpl, ledgerPath, merged, { now, pid: deps.pid });
    return merged;
  };

  let merged;
  try {
    merged = withFileLock(`${ledgerPath}.lock`, run, {
      fsImpl,
      now,
      removeFile: deps.removeFile,
      sleep: deps.sleep,
      staleMs: deps.staleMs,
      waitMs: deps.waitMs,
      pollMs: deps.pollMs,
      pid: deps.pid,
    });
  } catch (err) {
    if (!err || err.code !== 'LOCK_TIMEOUT') throw err;
    log(`[ledger] lock not acquired (${err.message}); saving merged without the lock`);
    merged = run();
  }
  if (ledger && typeof ledger === 'object') {
    ledger.sources = merged.sources;
    for (const key of ['lastSweep', 'lastRealExtractionAt']) {
      if (merged[key]) ledger[key] = merged[key];
    }
  }
  return merged;
}

/**
 * Fold the on-disk ledger into the caller's object WITHOUT writing, so a mark
 * another process wrote since this process loaded is visible to ledgerHas.
 * No lock is needed to read: writes are atomic renames.
 */
function refreshLedgerFromDisk(ledgerPath, ledger, deps = {}) {
  const fsImpl = deps.fsImpl || fs;
  let disk = null;
  try { disk = JSON.parse(fsImpl.readFileSync(ledgerPath, 'utf-8')); } catch { return ledger; }
  const merged = mergeLedgers(disk, ledger);
  if (ledger && typeof ledger === 'object') {
    ledger.sources = merged.sources;
    for (const key of ['lastSweep', 'lastRealExtractionAt']) {
      if (merged[key]) ledger[key] = merged[key];
    }
  }
  return ledger;
}

module.exports = { mergeLedgers, saveLedgerMerged, refreshLedgerFromDisk };
