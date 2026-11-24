/**
 * lib/session-offsets.js — per-session incremental-extraction state store
 * (INCREMENTAL-SWEEP D1 + ERRATUM-1 D3b).
 *
 * File: $AUXILO_HOME|HOME/.auxilo/offsets.json
 *   { version: 1,
 *     sources: { <source>: { <sessionId>: {
 *       state: <opaque adapter state>,   // {kind:'offset'|'hashes'|'rowid', ...}
 *       size, path, mtime,               // file facts at the last read
 *       more,                            // true = unhandled backlog remains
 *       tailPendingSize,                 // size at which a too-short tail was left unconsumed
 *       updatedAt } } } }
 *
 * The store never interprets `state`; each adapter kind owns its own shape:
 *   kind 'offset' : { offset, headSha, headLen, codec }      (append-only JSONL)
 *   kind 'hashes' : { seen:[16-hex...], docSha, truncated }  (rewritten JSON documents)
 *   kind 'rowid'  : { highWater }                            (SQLite)
 *
 * Writes are atomic (tmp + rename, mode 0600) and serialized by an O_EXCL lock
 * file with a stale timeout. fs, clock, sleep and the file-removal primitive are
 * injectable so tests never touch disk.
 *
 * @module lib/session-offsets
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const STORE_VERSION = 1;
const DEFAULT_LOCK_STALE_MS = 10 * 1000;
const DEFAULT_LOCK_WAIT_MS = 15 * 1000;
const DEFAULT_LOCK_POLL_MS = 50;
const STATE_KINDS = Object.freeze(['offset', 'hashes', 'rowid']);

function defaultSleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* busy-return; the caller loop re-checks the clock */ }
}

/**
 * Run fn() while holding an O_EXCL lock file. A lock older than staleMs is
 * broken. Throws {code:'LOCK_TIMEOUT'} when the lock cannot be taken within
 * waitMs (the caller decides whether to proceed unlocked). Synchronous.
 *
 * deps: { fsImpl, removeFile(path), now() -> ms, sleep(ms), staleMs, waitMs, pollMs, pid }
 */
function withFileLock(lockPath, fn, deps = {}) {
  const fsImpl = deps.fsImpl || fs;
  const removeFile = deps.removeFile || ((p) => fsImpl.unlinkSync(p));
  const now = deps.now || Date.now;
  const sleep = deps.sleep || defaultSleep;
  const staleMs = deps.staleMs !== undefined ? deps.staleMs : DEFAULT_LOCK_STALE_MS;
  const waitMs = deps.waitMs !== undefined ? deps.waitMs : DEFAULT_LOCK_WAIT_MS;
  const pollMs = deps.pollMs !== undefined ? deps.pollMs : DEFAULT_LOCK_POLL_MS;
  const pid = deps.pid !== undefined ? deps.pid : process.pid;

  try { fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 }); } catch { /* best-effort */ }

  const started = now();
  for (;;) {
    try {
      fsImpl.writeFileSync(lockPath, JSON.stringify({ pid, t: now() }), { flag: 'wx', mode: 0o600 });
      break;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      let mtimeMs = null;
      try { mtimeMs = fsImpl.statSync(lockPath).mtimeMs; } catch { /* vanished: retry at once */ continue; }
      if (now() - mtimeMs > staleMs) {
        // Re-stat so a lock refreshed between the two reads is not stolen.
        let again = null;
        try { again = fsImpl.statSync(lockPath).mtimeMs; } catch { continue; }
        if (again === mtimeMs) {
          try { removeFile(lockPath); } catch { /* another process broke it first */ }
          continue;
        }
      }
      if (now() - started >= waitMs) {
        const e = new Error(`lock ${lockPath} not acquired within ${waitMs}ms`);
        e.code = 'LOCK_TIMEOUT';
        throw e;
      }
      sleep(pollMs);
    }
  }
  try {
    return fn();
  } finally {
    try { removeFile(lockPath); } catch { /* already gone */ }
  }
}

/** Atomic write: unique tmp name, mode 0600, rename over the target. */
function atomicWriteJson(fsImpl, filePath, value, { now = Date.now, pid = process.pid } = {}) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${pid}.${now()}.tmp`;
  fsImpl.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fsImpl.renameSync(tmp, filePath);
}

function isValidState(state) {
  return Boolean(state && typeof state === 'object' && STATE_KINDS.includes(state.kind));
}

function emptyDoc() {
  return { version: STORE_VERSION, sources: {} };
}

function createOffsetStore(opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const now = opts.now || Date.now;
  const env = opts.env || process.env;
  const home = opts.home || env.AUXILO_HOME || os.homedir();
  const filePath = opts.filePath || path.join(home, '.auxilo', 'offsets.json');
  const lockPath = `${filePath}.lock`;
  const lockDeps = {
    fsImpl,
    now,
    removeFile: opts.removeFile,
    sleep: opts.sleep,
    staleMs: opts.staleMs,
    waitMs: opts.waitMs,
    pollMs: opts.pollMs,
    pid: opts.pid,
  };
  const counters = { offset_reset: 0, writes: 0, lock_timeouts: 0 };

  function readDoc() {
    try {
      const doc = JSON.parse(fsImpl.readFileSync(filePath, 'utf-8'));
      if (doc && doc.version === STORE_VERSION && doc.sources && typeof doc.sources === 'object') return doc;
    } catch { /* absent or corrupt: start empty */ }
    return emptyDoc();
  }

  function get(source, sessionId) {
    const entry = readDoc().sources[source] && readDoc().sources[source][sessionId];
    return entry && typeof entry === 'object' ? entry : null;
  }

  /** Merge `patch` into the entry under the lock (re-read inside the lock). */
  function update(source, sessionId, patch) {
    const run = () => {
      const doc = readDoc();
      if (!doc.sources[source]) doc.sources[source] = {};
      const prev = doc.sources[source][sessionId] || {};
      doc.sources[source][sessionId] = { ...prev, ...patch, updatedAt: new Date(now()).toISOString() };
      atomicWriteJson(fsImpl, filePath, doc, { now, pid: opts.pid });
      counters.writes += 1;
      return doc.sources[source][sessionId];
    };
    try {
      return withFileLock(lockPath, run, lockDeps);
    } catch (err) {
      if (err && err.code === 'LOCK_TIMEOUT') {
        counters.lock_timeouts += 1;
        return run(); // merge-on-write above still keeps other sessions' entries
      }
      throw err;
    }
  }

  /** Session ids of `source` flagged as having unhandled backlog. */
  function backlog(source) {
    const bucket = readDoc().sources[source] || {};
    return Object.keys(bucket)
      .filter((id) => bucket[id] && bucket[id].more === true)
      .map((id) => ({ sessionId: id, entry: bucket[id] }));
  }

  function noteReset() { counters.offset_reset += 1; }

  return { filePath, lockPath, counters, get, update, backlog, noteReset, readDoc };
}

module.exports = {
  createOffsetStore,
  withFileLock,
  atomicWriteJson,
  isValidState,
  STATE_KINDS,
  STORE_VERSION,
  DEFAULT_LOCK_STALE_MS,
};
