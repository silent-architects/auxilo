// lib/payments-switch.js
// PAYMENTS_ENABLED — global money-movement kill switch (Wave 2b, RUNBOOK §5
// SHOULD-FIX: "No global Stripe/x402 payment kill switch yet").
//
// One env flag that 503s EVERY money-movement surface — Stripe checkout
// session minting, Stripe webhook side effects, x402 settlement + cold 402
// challenge minting, credit deduction, and both withdraw rails — WITHOUT
// touching free reads/search/stats/discovery.
//
// Semantics: DEFAULT ON. Payments are disabled only when the env var is
// explicitly set to a recognized "off" value ('false' / '0' / 'off' / 'no',
// case-insensitive). Absent, empty, or any other value → enabled. This is
// operator-forgiving in the direction that matters: a typo can never silently
// take payments down; only a deliberate off-value can.
//
// Layering: this switch sits ABOVE (is checked before) the rail-specific
// CUSTODIAL_WITHDRAW_ENABLED sentinel — it must hold even when the custodial
// rails are individually enabled.
//
// Ops: set via `flyctl secrets set PAYMENTS_ENABLED=false` (restarts the
// machine). Re-enable by unsetting or setting 'true'. The Stripe webhook gate
// is deliberately a 503: Stripe retries non-2xx deliveries with backoff for
// days, so packs paid during an outage credit themselves when the switch
// re-enables — no event is lost, no manual replay needed.

'use strict';

const OFF_VALUES = new Set(['false', '0', 'off', 'no']);

/**
 * True when money movement is allowed (default; env var absent = enabled).
 * @returns {boolean}
 */
function paymentsEnabled() {
    const raw = process.env.PAYMENTS_ENABLED;
    if (raw === undefined || raw === null) return true;
    return !OFF_VALUES.has(String(raw).trim().toLowerCase());
}

/**
 * Machine-readable 503 body for every gated surface. Self-healing message:
 * tells the caller nothing was charged or consumed, which surfaces remain
 * available, and to retry later.
 * @returns {object}
 */
function paymentsDisabledBody() {
    return {
        error: 'Payments are temporarily disabled by the operator. No money moved: ' +
            'nothing was charged, no credits were consumed, and no payout was initiated. ' +
            'Free endpoints (search, discovery, stats, account reads) remain available. ' +
            'Retry later — this is a temporary operational pause, not an account problem.',
        code: 'PAYMENTS_DISABLED',
        retry_after: 300,
    };
}

module.exports = { paymentsEnabled, paymentsDisabledBody };
