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
                    description: `${pack.queries} queries + ${pack.unlocks} unlocks`,
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

async function createTransferToConnect(stripeConnectId, amountCents, description) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const transfer = await stripe.transfers.create({
        amount: amountCents,
        currency: 'usd',
        destination: stripeConnectId,
        description,
    });

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
};
