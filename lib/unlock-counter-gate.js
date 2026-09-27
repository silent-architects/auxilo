'use strict';

/**
 * lib/unlock-counter-gate.js — ruling M9.
 *
 * The ranking counter (learning.quality.unlocks, which feeds search ranking
 * and the public leaderboard) and the demand counter
 * (learning.demand.unlocks_7d / unlocks_30d, which feeds the price
 * multiplier) count an unlock only when it drew paid dollars, and at most
 * once per buyer account per learning per 30 days.
 *
 * This gates the COUNTERS ONLY. It is never consulted by the charge or by
 * the Builder Share: a repeat unlock is always charged the Listed Price in
 * full and always earns the Builder Share in full (server.js's unlock
 * handler calls deductCredit / computes contributorEarned unconditionally,
 * before this gate is ever read). This module owns nothing about money —
 * only whether THIS unlock is allowed to move a public signal a second time
 * within the window.
 *
 * Own data file, created on first use. A missing file reads as an empty
 * gate (nothing yet counted for anyone) — the same "missing file is handled"
 * idiom as lib/credits.js and lib/account-holds.js.
 */

const fs = require('fs');
const path = require('path');

// AUXILO_UNLOCK_COUNTER_GATE_FILE override: test isolation only (unset in production).
const GATE_FILE = process.env.AUXILO_UNLOCK_COUNTER_GATE_FILE
    || path.join(__dirname, '..', 'data', 'unlock-counter-gate.json');

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function load() {
    try { return JSON.parse(fs.readFileSync(GATE_FILE, 'utf8')); }
    catch { return {}; }
}

function save(state) {
    const tmp = GATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, GATE_FILE);
}

function gateKey(buyerAccountId, learningId) {
    return `${buyerAccountId}:${learningId}`;
}

/**
 * Check-and-record, atomically (single-threaded Node, no await between read
 * and write): returns true and records `now` for this (buyer, learning)
 * pair ONLY IF it has not already counted within the trailing 30 days.
 * Returns false, and records nothing, when it counted inside the window.
 *
 * An unlock with no buyer account (every x402 / router settlement — there
 * is no signed-in account to key a 30-day window on) always counts; there
 * is nothing to dedupe against, and each is real, distinct paid money.
 */
function shouldCountAndRecord(buyerAccountId, learningId, now = Date.now()) {
    if (!buyerAccountId || !learningId) return true;
    const state = load();
    const key = gateKey(buyerAccountId, learningId);
    const last = state[key];
    if (typeof last === 'number' && (now - last) < WINDOW_MS) {
        return false;
    }
    state[key] = now;
    save(state);
    return true;
}

/**
 * Best-effort compensation for a delivery failure: a request that just
 * recorded a NEW count (shouldCountAndRecord returned true) but then failed
 * to deliver must not permanently burn that buyer+learning's 30-day slot --
 * the retry that actually delivers should still count. Never throws.
 */
function unrecord(buyerAccountId, learningId) {
    if (!buyerAccountId || !learningId) return;
    try {
        const state = load();
        const key = gateKey(buyerAccountId, learningId);
        if (key in state) {
            delete state[key];
            save(state);
        }
    } catch (e) {
        console.error('[unlock-counter-gate] unrecord failed (non-fatal):', e && e.message);
    }
}

module.exports = {
    shouldCountAndRecord,
    unrecord,
    GATE_FILE,
    // Exported for testing only:
    WINDOW_MS,
    load,
    save,
};
