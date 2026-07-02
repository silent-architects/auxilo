// lib/stripe-ledger-reconcile.js
// M-1 one-time reconciliation for LEGACY Stripe withdrawals.
//
// Before the M-1 fix, the Stripe rail tracked withdrawals ONLY in
// withdrawals.jsonl and computed available balance as
// `total_contributor − sum(withdrawals)`; it never debited `pending_balance`.
// The USDC rail, meanwhile, debited `pending_balance`. The M-1 fix unifies both
// rails on `pending_balance`.
//
// For data created under the OLD code, a contributor's `pending_balance` was
// never reduced by their past Stripe withdrawals. If we simply switched the
// Stripe rail to read `pending_balance`, those contributors could re-withdraw
// funds they already took. This migration closes that gap: for every LEGACY
// Stripe withdrawal record (one written WITHOUT the new `rail` marker), it debits
// the contributor's `pending_balance` (and bumps total_withdrawn / counters)
// once, idempotently.
//
// Money-safety: this can only REDUCE a balance, never increase one — so it can
// never cause an overpay. It is the conservative choice.

'use strict';

const fs = require('fs');
const { resolveEarningsEntry } = require('./earnings.js');

/**
 * Reconcile legacy Stripe withdrawals into the unified pending_balance ledger.
 * Mutates `earnings` in place. Idempotent: each withdrawal id is reconciled at
 * most once (tracked per earnings entry in `reconciled_stripe_withdrawals`).
 *
 * @param {object} earnings           The live earnings map.
 * @param {string} withdrawalsFile    Absolute path to withdrawals.jsonl.
 * @returns {{ reconciled: number, totalDebited: number, skipped: number }}
 */
function reconcileLegacyStripeWithdrawals(earnings, withdrawalsFile) {
    let reconciled = 0;
    let totalDebited = 0;
    let skipped = 0;

    let lines;
    try {
        if (!fs.existsSync(withdrawalsFile)) return { reconciled, totalDebited, skipped };
        lines = fs.readFileSync(withdrawalsFile, 'utf8').split('\n').filter(Boolean);
    } catch {
        return { reconciled, totalDebited, skipped };
    }

    for (const line of lines) {
        let w;
        try { w = JSON.parse(line); } catch { continue; }

        // New records carry `rail: 'stripe'` and were already debited at write
        // time — skip them. Only LEGACY records (no rail marker) need backfill.
        if (w.rail) { skipped++; continue; }
        if (!w.account_id || typeof w.amount_usd !== 'number' || w.amount_usd <= 0) { skipped++; continue; }

        const { key, entry, source } = resolveEarningsEntry(earnings, { account_id: w.account_id });
        if (source === 'new') { skipped++; continue; } // no entry to debit

        if (!Array.isArray(entry.reconciled_stripe_withdrawals)) {
            entry.reconciled_stripe_withdrawals = [];
        }
        if (w.id && entry.reconciled_stripe_withdrawals.includes(w.id)) {
            continue; // already reconciled (idempotent)
        }

        // Debit pending_balance, clamped at zero (never go negative). Track the
        // amount we actually removed so total_withdrawn stays consistent.
        const before = (typeof entry.pending_balance === 'number' && isFinite(entry.pending_balance))
            ? entry.pending_balance : 0;
        const debit = Math.min(before, w.amount_usd);
        entry.pending_balance = parseFloat((before - debit).toFixed(6));
        if (entry.pending_balance < 0) entry.pending_balance = 0;
        entry.total_withdrawn = parseFloat(((entry.total_withdrawn || 0) + debit).toFixed(6));
        entry.withdrawal_count = (entry.withdrawal_count || 0) + 1;
        if (w.id) entry.reconciled_stripe_withdrawals.push(w.id);

        reconciled++;
        totalDebited += debit;
    }

    return { reconciled, totalDebited, skipped };
}

module.exports = { reconcileLegacyStripeWithdrawals };
