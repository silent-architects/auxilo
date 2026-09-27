'use strict';

/**
 * lib/credits-flag.js — CREDITS_AS_CASH_ENABLED (ruling L4 / spec §3, R-B).
 *
 * The ONE switch this build adds for money purposes. It is read in exactly
 * ONE place in the whole server: POST /checkout/session, at the moment a
 * brand-new Checkout session is created, to decide whether that purchase
 * will become a unit lot or a dollar lot. That decision is then stamped into
 * the session's own metadata (lib/stripe.js createCheckoutSession) — the
 * Stripe webhook reads ONLY that metadata when it later fires, never this
 * flag. Spending, refunds, disputes, caps and reporting never call this
 * function at all.
 *
 * Semantics: off by default. On ONLY when the environment variable is the
 * exact string 'true'. Read fresh on every call — never cached — so an
 * operator's env change takes effect on the very next Checkout session with
 * no redeploy.
 */

function creditsAsCashEnabled() {
    return process.env.CREDITS_AS_CASH_ENABLED === 'true';
}

module.exports = { creditsAsCashEnabled };
