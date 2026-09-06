'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── Pack Definitions ─────────────────────────────────────────────────────────

const PACKS = {
    starter: {
        id: 'starter',
        name: 'Starter Pack',
        price_cents: 1000,    // $10.00
        price_usd: 10,
        queries: 400,
        unlocks: 80,
    },
    growth: {
        id: 'growth',
        name: 'Growth Pack',
        price_cents: 2500,    // $25.00
        price_usd: 25,
        queries: 1200,
        unlocks: 250,
    },
    pro: {
        id: 'pro',
        name: 'Pro Pack',
        price_cents: 10000,   // $100.00
        price_usd: 100,
        queries: 5000,
        unlocks: 1000,
    },
};

// ─── Purchase Log ─────────────────────────────────────────────────────────────

const PURCHASES_FILE = path.join(__dirname, '..', 'data', 'purchases.jsonl');

function appendPurchase(record) {
    fs.appendFileSync(PURCHASES_FILE, JSON.stringify(record) + '\n');
}

function loadPurchases() {
    try {
        const lines = fs.readFileSync(PURCHASES_FILE, 'utf8').split('\n').filter(Boolean);
        return lines.map(line => JSON.parse(line));
    } catch {
        return [];
    }
}

function isSessionProcessed(sessionId) {
    const purchases = loadPurchases();
    return purchases.some(p => p.stripe_session_id === sessionId);
}

function getPurchasesForAccount(accountId) {
    const purchases = loadPurchases();
    return purchases.filter(p => p.account_id === accountId);
}

// ─── Stripe Client ────────────────────────────────────────────────────────────

let stripeClient = null;

function getStripe() {
    if (stripeClient) return stripeClient;
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
        console.warn('[stripe] STRIPE_SECRET_KEY not set — checkout disabled');
        return null;
    }
    const Stripe = require('stripe');
    stripeClient = new Stripe(key);
    return stripeClient;
}

// ─── Stripe Usability Status (CREDITS-CONFIG-USABLE) ──────────────────────────
//
// The dark-safe invariant this build ships under is "usable", not "present".
// A pasted STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET can be present and still
// be garbage (truncated paste, a placeholder like "whsec_PASTE_HERE", or a
// key Stripe itself rejects) — /health, the checkout route, and the purchase
// buttons on dashboard/pricing all read getStripeStatus() now, never bare
// presence. Never log or expose any part of the key values below — reasons
// only.
//
// Reason codes:
//   not-configured        — secret key and/or webhook secret unset entirely
//   secret-key-malformed  — secret key present but fails the format rule
//   webhook-secret-malformed — webhook secret present but fails the format rule
//   secret-key-rejected   — format OK, but Stripe's own API returned an auth error
//   stripe-unreachable    — format OK, but the live probe network-failed or timed out
//   probe-pending         — format OK, first live probe hasn't completed yet

const STRIPE_PROBE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const STRIPE_PROBE_TIMEOUT_MS = 5000;

let _stripeStatusCache = null;      // { configured, reason, checked_at, mode }
let _stripeProbeInFlight = null;    // Promise, dedupes concurrent probes
let _stripeProbeInterval = null;
let _stripeBootInitialized = false;
let _stripeReprobeArmedAfterFailure = false;

function _stripeDeriveMode() {
    const key = process.env.STRIPE_SECRET_KEY || '';
    if (/^(sk|rk)_test_/.test(key)) return 'test';
    if (/^(sk|rk)_live_/.test(key)) return 'live';
    return null;
}

// Pure, synchronous format check — no network. Returns a reason string if
// something is wrong, or null if both fields pass format validation (in
// which case a live probe decides the rest).
function getStripeConfigIssue() {
    const key = process.env.STRIPE_SECRET_KEY;
    const whsec = process.env.STRIPE_WEBHOOK_SECRET;

    if (!key || !whsec) return 'not-configured';

    if (/\s/.test(key)) return 'secret-key-malformed';
    const validKeyPrefix = key.startsWith('sk_test_') || key.startsWith('sk_live_') || key.startsWith('rk_');
    if (!validKeyPrefix || key.length < 24 || key.length > 200) return 'secret-key-malformed';

    if (/\s/.test(whsec)) return 'webhook-secret-malformed';
    if (!whsec.startsWith('whsec_') || whsec.length < 30) return 'webhook-secret-malformed';

    return null;
}

function _stripeWithTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error('Stripe probe timed out');
            err.code = 'ETIMEDOUT';
            reject(err);
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function _stripeProbeBalance(stripe) {
    return _stripeWithTimeout(stripe.balance.retrieve(), STRIPE_PROBE_TIMEOUT_MS);
}

function _stripeClassifyProbeError(err) {
    if (err && err.code === 'ETIMEDOUT') return 'stripe-unreachable';
    const type = err && err.type;
    if (type === 'StripeAuthenticationError') return 'secret-key-rejected';
    if (err && (err.statusCode === 401 || err.statusCode === 403)) return 'secret-key-rejected';
    return 'stripe-unreachable';
}

function _stripeIsTransientReason(reason) {
    return reason === 'secret-key-rejected' || reason === 'stripe-unreachable' || reason === 'probe-pending';
}

// Runs one full probe cycle (format check, then — only if format passes — a
// cheap live authenticated call) and updates the cache. `clientOverride` lets
// tests inject a stubbed Stripe client instead of hitting the network.
async function _stripeRunProbe(clientOverride) {
    const issue = getStripeConfigIssue();
    let result;

    if (issue) {
        result = { configured: false, reason: issue, checked_at: new Date().toISOString(), mode: _stripeDeriveMode() };
    } else {
        try {
            const stripe = clientOverride || getStripe();
            if (!stripe) {
                result = { configured: false, reason: 'not-configured', checked_at: new Date().toISOString(), mode: _stripeDeriveMode() };
            } else {
                await _stripeProbeBalance(stripe);
                result = { configured: true, reason: null, checked_at: new Date().toISOString(), mode: _stripeDeriveMode() };
            }
        } catch (err) {
            const reason = _stripeClassifyProbeError(err);
            result = { configured: false, reason, checked_at: new Date().toISOString(), mode: _stripeDeriveMode() };
        }
    }

    _stripeStatusCache = result;
    _stripeReprobeArmedAfterFailure = !result.configured && _stripeIsTransientReason(result.reason);
    return result;
}

function _stripeScheduleProbe(clientOverride) {
    if (_stripeProbeInFlight) return _stripeProbeInFlight;
    _stripeProbeInFlight = _stripeRunProbe(clientOverride).finally(() => { _stripeProbeInFlight = null; });
    return _stripeProbeInFlight;
}

// GET /health and the checkout route both call this synchronously — it never
// makes a network call itself, it just reads the last-cached probe result
// (or, if probing was never initialized, a synchronous format-only snapshot
// so callers never see undefined).
function getStripeStatus() {
    if (_stripeStatusCache) return _stripeStatusCache;
    const issue = getStripeConfigIssue();
    return { configured: false, reason: issue || 'probe-pending', checked_at: new Date().toISOString(), mode: _stripeDeriveMode() };
}

// Called once at server boot. Non-blocking: seeds the cache synchronously
// (a deterministic format failure needs no network round-trip; otherwise the
// cache starts as probe-pending while the first live probe runs), then
// re-probes on a fixed 10-minute interval.
function initStripeStatusProbing() {
    if (_stripeBootInitialized) return;
    _stripeBootInitialized = true;

    const issue = getStripeConfigIssue();
    if (issue) {
        _stripeStatusCache = { configured: false, reason: issue, checked_at: new Date().toISOString(), mode: _stripeDeriveMode() };
    } else {
        _stripeStatusCache = { configured: false, reason: 'probe-pending', checked_at: new Date().toISOString(), mode: _stripeDeriveMode() };
        _stripeScheduleProbe().catch(() => {});
    }

    _stripeProbeInterval = setInterval(() => {
        _stripeScheduleProbe().catch(() => {});
    }, STRIPE_PROBE_INTERVAL_MS);
    if (_stripeProbeInterval.unref) _stripeProbeInterval.unref();
}

// Called by the checkout route on every attempt. Only the FIRST attempt after
// a transient probe failure (or while a probe is still pending) triggers an
// immediate out-of-cycle reprobe — the arm is consumed on trigger, so a burst
// of checkout attempts doesn't hammer Stripe; a failed reprobe still gets
// retried on the normal 10-minute interval either way.
function notifyStripeCheckoutAttempt() {
    if (_stripeReprobeArmedAfterFailure && !_stripeProbeInFlight) {
        _stripeReprobeArmedAfterFailure = false;
        _stripeScheduleProbe().catch(() => {});
    }
}

// Test-only: run one probe cycle immediately (optionally against a stubbed
// client) and await the resulting cached status.
async function probeStripeNow(clientOverride) {
    return _stripeScheduleProbe(clientOverride);
}

// Test-only: force getStripe() to return a stubbed client instead of
// constructing a real one from STRIPE_SECRET_KEY. Needed for paths (like
// notifyStripeCheckoutAttempt's internal reprobe) that call getStripe()
// with no client-override parameter of their own — never construct a real
// `new Stripe(key)` / make a real network call in tests.
function __setStripeClientForTest(client) {
    stripeClient = client;
}

// Test-only: fully reset module-level probing state between test cases.
function __resetStripeStatusForTest() {
    _stripeStatusCache = null;
    _stripeProbeInFlight = null;
    _stripeBootInitialized = false;
    _stripeReprobeArmedAfterFailure = false;
    stripeClient = null;
    if (_stripeProbeInterval) {
        clearInterval(_stripeProbeInterval);
        _stripeProbeInterval = null;
    }
}

// ─── Checkout Session ─────────────────────────────────────────────────────────

async function createCheckoutSession(accountId, packId, baseUrl) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const pack = PACKS[packId];
    if (!pack) throw new Error(`Unknown pack: ${packId}`);

    const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{
            price_data: {
                currency: 'usd',
                unit_amount: pack.price_cents,
                product_data: {
                    name: `Auxilo ${pack.name}`,
                    // CREDITS-CONTROL PART 1 (SPEC-1 A4, GOV-2 A1): display-string fix
                    // only — a buyer must never see a query-credit benefit on Stripe's
                    // own hosted page or receipt (D11). pack_queries plumbing below
                    // (metadata → webhook → purchases.jsonl) is untouched.
                    description: `${pack.unlocks} unlocks`,
                },
            },
            quantity: 1,
        }],
        metadata: {
            account_id: accountId,
            pack_id: pack.id,
            pack_queries: String(pack.queries),
            pack_unlocks: String(pack.unlocks),
        },
        // GOV-2 A3 (blocking): point-of-purchase assent — Stripe requires a Terms
        // of Service URL configured in Checkout Settings for this to take effect
        // (PART 2 item 3); the parameter ships now so PART 2's flip needs no code
        // change.
        consent_collection: { terms_of_service: 'required' },
        success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/checkout/cancel`,
    });

    return { url: session.url, session_id: session.id };
}

// ─── Webhook Verification ─────────────────────────────────────────────────────

function verifyWebhookSignature(rawBody, signatureHeader) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not set');

    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    return stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
}

// ─── Generate Purchase ID ─────────────────────────────────────────────────────

function generatePurchaseId() {
    return 'pur_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

// ─── Stripe Connect (Change 6) ───────────────────────────────────────────────

async function createConnectAccountLink(auxiloAccountId, returnUrl, refreshUrl) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const account = await stripe.accounts.create({
        type: 'express',
        metadata: { auxilo_account_id: auxiloAccountId },
    });

    const accountLink = await stripe.accountLinks.create({
        account: account.id,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: 'account_onboarding',
    });

    return { account_id: account.id, url: accountLink.url };
}

async function createTransferToConnect(stripeConnectId, amountCents, description, idempotencyKey) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    // M-3: pass an idempotency key so a retried/replayed transfer (e.g. after a
    // lost response or crash) never moves money twice. Stripe deduplicates on
    // this key for 24h and returns the original transfer instead of a new one.
    const options = idempotencyKey ? { idempotencyKey } : undefined;

    const transfer = await stripe.transfers.create({
        amount: amountCents,
        currency: 'usd',
        destination: stripeConnectId,
        description,
    }, options);

    return { transfer_id: transfer.id, amount_cents: amountCents, status: transfer.object };
}

async function getConnectAccountStatus(stripeConnectId) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const account = await stripe.accounts.retrieve(stripeConnectId);
    return {
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled,
        details_submitted: account.details_submitted,
    };
}

module.exports = {
    PACKS,
    createCheckoutSession,
    verifyWebhookSignature,
    appendPurchase,
    loadPurchases,
    isSessionProcessed,
    getPurchasesForAccount,
    generatePurchaseId,
    getStripe,
    PURCHASES_FILE,
    createConnectAccountLink,
    createTransferToConnect,
    getConnectAccountStatus,
    // CREDITS-CONFIG-USABLE
    getStripeStatus,
    getStripeConfigIssue,
    initStripeStatusProbing,
    notifyStripeCheckoutAttempt,
    probeStripeNow,
    __resetStripeStatusForTest,
    __setStripeClientForTest,
};
