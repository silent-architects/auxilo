'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── Pack Definitions ─────────────────────────────────────────────────────────
//
// Ruling L8: a pack adds dollars, one dollar of Balance for each dollar
// paid. There is no unit-credit count left to grant or to serve.

const PACKS = {
    starter: {
        id: 'starter',
        name: 'Starter Pack',
        price_cents: 1000,    // $10.00
        price_usd: 10,
    },
    growth: {
        id: 'growth',
        name: 'Growth Pack',
        price_cents: 2500,    // $25.00
        price_usd: 25,
    },
    pro: {
        id: 'pro',
        name: 'Pro Pack',
        price_cents: 10000,   // $100.00
        price_usd: 100,
    },
};

// ─── Purchase Log ─────────────────────────────────────────────────────────────

// AUXILO_PURCHASES_FILE override: test isolation only (unset in production),
// same idiom as lib/credits.js's AUXILO_CREDITS_FILE.
const PURCHASES_FILE = process.env.AUXILO_PURCHASES_FILE
    || path.join(process.env.AUXILO_DATA_DIR || path.join(__dirname, '..', 'data'), 'purchases.jsonl');

const persistence = require('./stripe-transfer-persistence');
function normalizedPurchase(row) {
    if (row.stripe_platform && row.stripe_platform_account_id) return row;
    const origin = require('./stripe-object-origins').resolveOrigin('checkout_session', row.stripe_session_id, row.account_id);
    return origin ? { ...row, stripe_platform: origin.stripe_platform, stripe_platform_account_id: origin.stripe_platform_account_id } : row;
}
function loadPurchases(context) {
    const rows = persistence.readJSONLStrict(PURCHASES_FILE, { validateDuplicateIds: false });
    if (!context) return rows;
    return rows.map(normalizedPurchase).filter(p => p.stripe_platform === context.stripe_platform && p.stripe_platform_account_id === context.stripe_platform_account_id);
}
function appendPurchase(record) {
    if (!record?.stripe_platform || !record.stripe_platform_account_id || !record.stripe_session_id || !record.account_id) throw new Error('Immutable purchase provenance required');
    const rows = persistence.readJSONLStrict(PURCHASES_FILE, { validateDuplicateIds: false });
    const normalized = rows.map(normalizedPurchase);
    if (normalized.some(p => !p.stripe_platform && p.stripe_session_id === record.stripe_session_id && p.account_id === record.account_id)) throw new Error('Unresolved historical purchase identity');
    const matches = normalized.filter(p => p.stripe_platform === record.stripe_platform && p.stripe_session_id === record.stripe_session_id);
    if (matches.some(p => persistence.canonicalJSON(p) !== persistence.canonicalJSON(record))) throw new Error('Conflicting composite purchase duplicate');
    let fd; try { fd = fs.openSync(PURCHASES_FILE, 'a', 0o600); if (!matches.length) fs.writeFileSync(fd, persistence.canonicalJSON(record) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; persistence.syncDirectory(path.dirname(PURCHASES_FILE)); } catch (e) { if (fd !== undefined) try { fs.closeSync(fd); } catch {} e.financialStorageFailure = true; throw e; }
    return { appended: !matches.length, record };
}
function isSessionProcessed(sessionId, context) { return loadPurchases(context).some(p => p.stripe_session_id === sessionId); }
function getPurchasesForAccount(accountId, context) { return loadPurchases(context).filter(p => p.account_id === accountId); }

// ─── Stripe Client ────────────────────────────────────────────────────────────

const platforms = require('./stripe-platforms');
let _stripeProbeInterval = null;
let _stripeProbeInFlight = null;
let _stripeReprobeArmedAfterFailure = false;
function getStripe(alias) { if (!alias) throw new Error('Explicit Stripe platform required'); return platforms.getClient(alias); }
function getStripeConfigIssue() { return platforms.getConfigIssue('legacy') || platforms.getConfigIssue('legacy', true); }
function getStripeStatus() { const issue = getStripeConfigIssue(); const status = platforms.getPlatformStatus('legacy'); return issue ? { ...status, configured: false, reason: issue } : status; }
async function probeStripeNow(clientOverride) {
    if (clientOverride) __setStripeClientForTest(clientOverride);
    const issue = getStripeConfigIssue();
    if (issue) return getStripeStatus();
    if (_stripeProbeInFlight) return _stripeProbeInFlight;
    _stripeProbeInFlight = platforms.probePlatform('legacy').then(s => { _stripeReprobeArmedAfterFailure = ['secret-key-rejected','stripe-unreachable','probe-pending'].includes(s.reason); return s; }).finally(() => { _stripeProbeInFlight = null; });
    return _stripeProbeInFlight;
}
function initStripeStatusProbing() { if (_stripeProbeInterval) return; probeStripeNow().catch(() => {}); platforms.probePlatform('auxilo_llc').catch(() => {}); _stripeProbeInterval = setInterval(() => { probeStripeNow().catch(() => {}); platforms.probePlatform('auxilo_llc').catch(() => {}); }, 600000); _stripeProbeInterval.unref?.(); }
function notifyStripeCheckoutAttempt() { if (_stripeReprobeArmedAfterFailure && !_stripeProbeInFlight) { _stripeReprobeArmedAfterFailure = false; probeStripeNow().catch(() => {}); } }
function __setStripeClientForTest(client, definitions) { platforms.__setRegistryForTest(platforms.createPlatformRegistry({ definitions, clientFactory: () => client })); }
function __resetStripeStatusForTest() { platforms.__setRegistryForTest(); _stripeProbeInFlight = null; _stripeReprobeArmedAfterFailure = false; clearInterval(_stripeProbeInterval); _stripeProbeInterval = null; }

// ─── Checkout Session ─────────────────────────────────────────────────────────

// A pack purchase always adds dollars to the buyer's balance. The
// description below is what Stripe's own Checkout page and receipt show the
// buyer, and it always states the dollar amount — there is one model.
//
// Ruling N2: 35 minutes, a five-minute margin above Stripe's own documented
// floor ("The value must be between 30 minutes and 24 hours after the
// current time") -- the exact minimum risks landing under it once clock
// skew and the network round trip to Stripe are counted, which would fail
// every purchase. The caller counts a pending session until the expires_at
// THIS FUNCTION RETURNS (Stripe's own confirmed value), never a fixed local
// window assumed to match it.
async function createCheckoutSession(accountId, packId, baseUrl, { context, idempotencyKey, intentId } = {}) {
    const stripe = platforms.assertVerifiedContext(context);
    if (!accountId || typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 255 || typeof intentId !== 'string' || !intentId || !/^https?:\/\//.test(baseUrl || '')) throw new Error('Immutable Checkout request required');

    const pack = PACKS[packId];
    if (!pack) throw new Error(`Unknown pack: ${packId}`);

    const description = `$${pack.price_usd.toFixed(2)} added to your Auxilo balance`;

    const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{
            price_data: {
                currency: 'usd',
                unit_amount: pack.price_cents,
                product_data: {
                    name: `Auxilo ${pack.name}`,
                    description,
                },
            },
            quantity: 1,
        }],
        metadata: {
            account_id: accountId,
            pack_id: pack.id,
            auxilo_checkout_intent_id: intentId,
        },
        // GOV-2 A3 (blocking): point-of-purchase assent — Stripe requires a Terms
        // of Service URL configured in Checkout Settings for this to take effect
        // (PART 2 item 3); the parameter ships now so PART 2's flip needs no code
        // change.
        consent_collection: { terms_of_service: 'required' },
        success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/checkout/cancel`,
        // Ruling N2: 35 minutes — five minutes clear of Stripe's documented
        // 30-minute floor.
        expires_at: Math.floor(Date.now() / 1000) + 35 * 60,
    }, { idempotencyKey, maxNetworkRetries: 0 });
    platforms.assertVerifiedContext(context);
    if (!session || !/^cs_[A-Za-z0-9_]+$/.test(session.id || '') || session.object !== 'checkout.session' || session.mode !== 'payment' || session.livemode !== context.livemode || session.amount_total !== pack.price_cents || session.currency !== 'usd' || session.metadata?.account_id !== accountId || session.metadata?.pack_id !== pack.id || session.metadata?.auxilo_checkout_intent_id !== intentId || !Number.isSafeInteger(session.expires_at) || session.expires_at <= Date.now() / 1000 || !/^https:\/\//.test(session.url || '')) throw new Error('Stripe Checkout response evidence mismatch');

    // Ruling N2: expires_at is Stripe's OWN confirmed value (seconds since
    // epoch), not simply echoing what was requested above — the caller
    // counts a pending session against the purchase caps only until this.
    return { url: session.url, session_id: session.id, expires_at: session.expires_at };
}

// ─── Webhook Verification ─────────────────────────────────────────────────────

function verifyWebhookSignature(rawBody, signatureHeader) { return platforms.verifyPlatformEvent('legacy', rawBody, signatureHeader).event; }

// ─── Generate Purchase ID ─────────────────────────────────────────────────────

function generatePurchaseId() {
    return 'pur_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

// ─── Stripe Connect (Change 6) ───────────────────────────────────────────────

async function createConnectAccount(accountId, { context, idempotencyKey, intentId } = {}) {
    const stripe = platforms.assertVerifiedContext(context);
    if (!accountId || !idempotencyKey || idempotencyKey.length > 255 || !intentId) throw new Error('Immutable Connect request required');
    const metadata = { auxilo_account_id: accountId, auxilo_connect_intent_id: intentId };
    const account = await stripe.accounts.create({ type: 'express', metadata }, { idempotencyKey, maxNetworkRetries: 0 });
    platforms.assertVerifiedContext(context);
    if (!/^acct_\w+$/.test(account?.id || '') || account.object !== 'account' || account.type !== 'express' || account.metadata?.auxilo_account_id !== accountId || account.metadata?.auxilo_connect_intent_id !== intentId) throw new Error('Stripe Connect response evidence mismatch');
    return { account_id: account.id };
}
async function createConnectOnboardingLink(id, returnUrl, refreshUrl, context) {
    const stripe = platforms.assertVerifiedContext(context);
    if (!/^acct_\w+$/.test(id || '') || !/^https?:\/\//.test(returnUrl || '') || !/^https?:\/\//.test(refreshUrl || '')) throw new Error('Invalid Connect onboarding request');
    await getConnectAccountStatus(id, context);
    const result = await stripe.accountLinks.create({ account: id, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding' }, { maxNetworkRetries: 0 });
    platforms.assertVerifiedContext(context);
    if (!/^https:\/\//.test(result?.url || '')) throw new Error('Invalid Connect onboarding response');
    return { account_id: id, url: result.url };
}
// Account creation must be journaled separately from link creation.
async function createConnectAccountLink() { throw new Error('Use durable Connect intent and explicit platform APIs'); }
function transferContextError(message) { const error = new Error(message); error.code = 'STRIPE_TRANSFER_CONTEXT_UNVERIFIED'; return error; }
const assertFixedTransferContext = context => platforms.assertVerifiedContext(context);
async function verifyStripeTransferContext({ expectedAccountId, platform } = {}) {
    const expected = platforms.getPlatform(platform).account_id;
    if (expectedAccountId !== undefined && expectedAccountId !== expected) throw transferContextError('Stripe expected platform identity mismatch');
    return (await platforms.getVerifiedClient(platform)).context;
}

async function createTransferToConnect(stripeConnectId, amountCents, description, idempotencyKey, context, metadata) {
    const stripe = assertFixedTransferContext(context);
    if (!/^acct_[A-Za-z0-9_]+$/.test(stripeConnectId || '') || !Number.isSafeInteger(amountCents) || amountCents <= 0
        || typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 255
        || !metadata || typeof metadata.auxilo_transfer_attempt_id !== 'string' || !metadata.auxilo_transfer_attempt_id
        || !/^[a-f0-9]{64}$/.test(metadata.auxilo_request_digest || '')) {
        throw transferContextError('Stripe transfer requires immutable request key, amount and correlation');
    }
    const correlation = Object.freeze({
        auxilo_transfer_attempt_id: metadata.auxilo_transfer_attempt_id,
        auxilo_request_digest: metadata.auxilo_request_digest,
    });
    const transfer = await stripe.transfers.create({
        amount: amountCents,
        currency: 'usd',
        destination: stripeConnectId,
        description,
        metadata: correlation,
    }, { idempotencyKey, maxNetworkRetries: 0 });
    // Any exception after invocation remains unknown to the calling protocol.
    assertFixedTransferContext(context);
    const destination = transfer && (typeof transfer.destination === 'string' ? transfer.destination : transfer.destination && transfer.destination.id);
    if (!transfer || !/^tr_[A-Za-z0-9_]+$/.test(transfer.id || '') || transfer.object !== 'transfer'
        || transfer.amount !== amountCents || transfer.currency !== 'usd' || destination !== stripeConnectId
        || transfer.livemode !== context.livemode || !transfer.metadata
        || transfer.metadata.auxilo_transfer_attempt_id !== correlation.auxilo_transfer_attempt_id
        || transfer.metadata.auxilo_request_digest !== correlation.auxilo_request_digest) {
        const error = new Error('Stripe transfer evidence is incomplete or mismatched');
        error.code = 'STRIPE_TRANSFER_EVIDENCE_INVALID';
        throw error;
    }
    return {
        transfer_id: transfer.id, amount_cents: transfer.amount, destination,
        currency: transfer.currency, livemode: transfer.livemode, metadata: correlation,
        stripe_platform: context.stripe_platform,
        stripe_platform_account_id: context.stripe_platform_account_id,
        configuration_generation: context.configuration_generation,
        status: transfer.object,
    };
}

async function getConnectAccountStatus(stripeConnectId, context) {
    const stripe = platforms.assertVerifiedContext(context);
    if (!/^acct_\w+$/.test(stripeConnectId || '')) throw new Error('Invalid connected account');

    const account = await stripe.accounts.retrieve(stripeConnectId);
    platforms.assertVerifiedContext(context);
    if (account?.id !== stripeConnectId || account.object !== 'account') throw new Error('Stripe connected account evidence mismatch');
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
    createConnectAccount,
    createConnectOnboardingLink,
    createTransferToConnect,
    verifyStripeTransferContext,
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
