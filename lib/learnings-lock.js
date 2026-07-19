// lib/learnings-lock.js
// Store-level async mutex for the learnings catalog (Wave 2b, RUNBOOK §9
// SHOULD-FIX: "learnings.json writes have no cross-request mutex").
//
// ONE key — the catalog is a single JSON file and every persist
// (safeWrite(LEARNINGS_FILE, learnings)) rewrites the whole array, so
// per-learning granularity cannot prevent a whole-file lost update.
//
// What this protects: any mutation section of `learnings` that spans an
// `await` (the retraction handler holds its ownership/window decision across
// the awaited audit append; the unlock handler's AUD19-10 compensation path
// awaits refundCredit mid-catch), plus every future await someone introduces
// inside a today-synchronous mutation block. Synchronous blocks are
// event-loop-atomic on their own, but with no serialization CONTRACT — this
// module is that contract: every runtime writer of the catalog acquires it.
//
// Deliberately NOT acquired by boot-time writers (startup migration/seed and
// WAL replay run single-threaded before the server accepts traffic) or by the
// retired cross-process retraction-sunset job (LaunchAgent removed 2026-06-10,
// PUNCH-LIST P1-13a — there are no out-of-process writers left).
//
// ── LOCK-ORDER RULE (deadlock safety; extends the Wave-1 map) ───────────────
//   account-lock  →  earnings-lock  →  learnings-lock
// The learnings lock is the INNERMOST (leaf) lock. While holding it:
//   - never acquire an account lock or an earnings lock;
//   - never await a helper that does (sweepHeldEarnings, the withdraw rails).
// Lib-internal mutexes (extraction-audit writeLock, lib/wallet-lock.js,
// lib/purchase-ledger.js's write lock) are self-contained leaves that never
// call back into server locks — safe to await while holding this lock.
// The only dual-acquisition site today is link-wallet's orphan adoption,
// which acquires account-lock first, then this lock: rule order.
//
// Same promise-chaining pattern as lib/earnings-lock.js.

'use strict';

const state = { chain: Promise.resolve(), count: 0 };

/**
 * Acquire the exclusive catalog write lock. Concurrent callers queue FIFO.
 * @returns {Promise<Function>} release function — call in a finally block
 */
function acquireLearningsLock() {
    let release;

    const newChain = new Promise((resolve) => {
        release = () => {
            state.count--;
            resolve();
        };
    });

    const acquire = state.chain.then(() => release);
    state.chain = newChain;
    state.count++;

    return acquire;
}

/**
 * Number of holders+waiters currently queued. For health/debugging/tests.
 * @returns {number}
 */
function getLearningsLockDepth() {
    return state.count;
}

module.exports = { acquireLearningsLock, getLearningsLockDepth };
