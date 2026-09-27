'use strict';

/**
 * lib/earnings-reversal.js — AUD-CAC builder-share reversal (spec §0, §4).
 *
 * lib/earnings.js is NOT modified for this build (ruling L11). This module
 * answers spec section 0's question — "can a share be reversed using only
 * what lib/earnings.js already exports?" — with the same mechanism the spec
 * itself describes:
 *
 *   - resolveEarningsEntry(earnings, { account_id, wallet }) finds the
 *     builder's earnings entry, the SAME way server.js already finds it
 *     before crediting a share.
 *   - getWithdrawableBalance(entry) reads the entry's current pending
 *     balance, read-only.
 *
 * The actual debit is inline subtraction here, mirroring exactly how a
 * share is credited today: server.js writes
 * `activeEntry.pending_balance += contributorEarned` directly, inline —
 * lib/earnings.js has no exported "add to balance" function at all, so
 * reversal writes the mirror image, `entry.pending_balance -= amount`,
 * directly, inline, here.
 *
 * `debitWithdrawableBalance` is deliberately NOT used for this. It exists
 * for a real withdrawal payout: it refuses to let the balance go below
 * zero, and it bumps total_withdrawn/withdrawal_count, both of which would
 * misstate a reversal as a payout the builder actually received. A
 * reversal is allowed to take pending_balance below zero — getWithdrawableBalance
 * already treats a negative pending_balance as zero, so both payout rails
 * already refuse to pay anything while a builder's balance sits negative
 * from a reversal, using code that exists today, unmodified.
 */

const { resolveEarningsEntry, getWithdrawableBalance } = require('./earnings.js');

function round6(v) {
    return Math.round((v + Number.EPSILON) * 1e6) / 1e6;
}

/**
 * Reverse one funded-unlock record (as returned by
 * lib/credits.js removeDollarLotRemainder's `funded_unlocks` array) against
 * the live earnings map. Mutates `earnings` in place; the caller persists.
 *
 * @param {object} earnings — the full earnings map (mutated in place).
 * @param {object} funding — one entry from a dollar lot's funded_unlocks:
 *        { contributor_account_id, contributor_wallet, contributor_amount, learning_id }.
 * @returns {{ reversed: number, key: string|null, found: boolean }}
 */
function reverseOneFundedUnlock(earnings, funding) {
    const amount = round6(funding && funding.contributor_amount || 0);
    if (amount <= 0) {
        return { reversed: 0, key: null, found: false };
    }

    const { key, entry, source } = resolveEarningsEntry(earnings, {
        account_id: funding.contributor_account_id || null,
        wallet: funding.contributor_wallet || null,
    });

    if (source === 'new') {
        // The entry MUST already exist — it was credited when this unlock
        // happened. If it genuinely doesn't (data loss elsewhere), there is
        // nothing on-ledger to debit; report it rather than silently
        // fabricating a negative entry for an identity with no history.
        return { reversed: 0, key: null, found: false };
    }

    // Read-only, per spec §0 — used here only to report the balance a
    // caller may want to log, not to gate the write itself (a reversal is
    // allowed to go negative).
    void getWithdrawableBalance(entry);

    entry.pending_balance   = round6((entry.pending_balance   || 0) - amount);
    entry.total_contributor = round6((entry.total_contributor || 0) - amount);
    entry.total_gross       = round6((entry.total_gross       || 0) - amount);
    if (funding.learning_id && entry.by_learning && entry.by_learning[funding.learning_id]) {
        const bl = entry.by_learning[funding.learning_id];
        bl.contributor = round6((bl.contributor || 0) - amount);
        bl.gross       = round6((bl.gross       || 0) - amount);
    }
    entry.last_updated = new Date().toISOString();

    if (!Array.isArray(entry.reversals)) entry.reversals = [];
    entry.reversals.push({
        amount,
        learning_id: funding.learning_id || null,
        reason: 'dollar_lot_reversal',
        ts: new Date().toISOString(),
    });

    return { reversed: amount, key, found: true };
}

/**
 * Reverse an entire dollar lot's funded-unlock history (spec test 22/23/27).
 * Idempotent by construction: the caller (lib/credits.js
 * removeDollarLotRemainder) hands back only entries not previously marked
 * reversed, so replaying this against the same set twice is harmless (an
 * empty array reverses nothing).
 *
 * @param {object} earnings — the full earnings map (mutated in place).
 * @param {Array}  fundedUnlocks — entries from removeDollarLotRemainder.
 * @returns {{ totalReversed: number, perEntry: Array }}
 */
function reverseLotFunding(earnings, fundedUnlocks) {
    let totalReversed = 0;
    const perEntry = [];
    for (const funding of (fundedUnlocks || [])) {
        const result = reverseOneFundedUnlock(earnings, funding);
        totalReversed = round6(totalReversed + result.reversed);
        perEntry.push(result);
    }
    return { totalReversed, perEntry };
}

module.exports = {
    reverseOneFundedUnlock,
    reverseLotFunding,
};
