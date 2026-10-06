'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { plainObject, digestJSON, readJSONStrict, writeJSONAtomic } = require('./stripe-transfer-persistence');
const PLATFORMS = { legacy: 'acct_1TCbMe0Jj0R41QQV', auxilo_llc: 'acct_1UMsxYLVAUzbAOHI' };
const clone = value => JSON.parse(JSON.stringify(value));
function fault(message = 'CHECKOUT_RECONCILIATION_REQUIRED') { const error = new Error(message); error.code = message; return error; }
function validateManifest(ref) {
    if (!plainObject(ref) || !ref.checkpoint_id || !ref.approval_ref || ref.inventory_complete !== true || !/^[a-f0-9]{64}$/.test(ref.manifest_sha256 || '')) throw fault('MIGRATION_INVENTORY_REQUIRED');
}
function seal(value) { const next = clone(value); delete next.checksum; next.checksum = digestJSON(next); return next; }
function validateContext(row) {
    if (!plainObject(row) || PLATFORMS[row.stripe_platform] !== row.stripe_platform_account_id || typeof row.livemode !== 'boolean') throw fault('INVALID_STRIPE_CONTEXT');
}
function checkoutFingerprint(input) {
    if (typeof input.account_id !== 'string' || !input.account_id || typeof input.pack_id !== 'string' || !input.pack_id || input.currency !== 'usd' || !Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) throw fault('INVALID_CHECKOUT_REQUEST');
    let base; try { base = new URL(input.base_url); } catch { throw fault('INVALID_CHECKOUT_REQUEST'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw fault('INVALID_CHECKOUT_REQUEST');
    return digestJSON({ account_id: input.account_id, pack_id: input.pack_id, currency: input.currency, amount_cents: input.amount_cents, base_url: input.base_url, stripe_platform: input.stripe_platform, stripe_platform_account_id: input.stripe_platform_account_id, livemode: input.livemode });
}
const TRANSITIONS = {
    prepared: ['submitted', 'confirmed_not_created'], submitted: ['unknown', 'confirmed_open', 'paid_pending_credit', 'confirmed_expired_unpaid'],
    unknown: ['unknown', 'confirmed_open', 'paid_pending_credit', 'confirmed_expired_unpaid', 'confirmed_not_created'],
    confirmed_open: ['paid_pending_credit', 'confirmed_expired_unpaid'], paid_pending_credit: ['paid_credited'], paid_credited: [], confirmed_expired_unpaid: [], confirmed_not_created: []
};
const PATCH = new Set(['session_id', 'payment_intent_id', 'session_url', 'expires_at', 'evidence', 'cap_state_durable', 'credit_state_durable', 'purchase_id', 'last_error_code']);
function validateIntent(row) {
    validateContext(row);
    if (!TRANSITIONS[row.state] || !Number.isSafeInteger(row.generation) || row.generation < 1 || !row.intent_id || !row.idempotency_key || !Number.isFinite(Date.parse(row.prepared_at)) || row.configuration_generation === undefined || row.fingerprint !== checkoutFingerprint(row)) throw fault('INVALID_CHECKOUT_INTENT');
    if (['confirmed_open', 'paid_pending_credit', 'paid_credited', 'confirmed_expired_unpaid', 'confirmed_not_created'].includes(row.state)) {
        const e = row.evidence;
        if (!plainObject(e) || e.verified !== true || e.authoritative !== true || !e.evidence_ref || e.stripe_platform !== row.stripe_platform || e.stripe_platform_account_id !== row.stripe_platform_account_id || e.livemode !== row.livemode) throw fault('AUTHORITATIVE_CHECKOUT_EVIDENCE_REQUIRED');
        if (e.intent_id !== row.intent_id || e.account_id !== row.account_id || e.amount_cents !== row.amount_cents || e.currency !== row.currency || (row.state !== 'confirmed_not_created' && e.session_id !== row.session_id)) throw fault('CHECKOUT_EVIDENCE_BINDING_CONFLICT');
        if (row.state === 'confirmed_not_created' && (e.definitive_not_created !== true || row.cap_state_durable !== true)) throw fault('AUTHORITATIVE_CHECKOUT_EVIDENCE_REQUIRED');
        if (row.state !== 'confirmed_not_created' && !/^cs_[A-Za-z0-9_]+$/.test(row.session_id || '')) throw fault('INVALID_CHECKOUT_SESSION');
    }
    if (row.state === 'confirmed_open' && (row.cap_state_durable !== true || !Number.isFinite(row.expires_at) || !/^https:\/\//.test(row.session_url || ''))) throw fault('CHECKOUT_CAP_RECEIPT_REQUIRED');
    if (row.state === 'confirmed_expired_unpaid' && (row.evidence.expired_unpaid !== true || row.cap_state_durable !== true)) throw fault('CHECKOUT_TERMINAL_EVIDENCE_REQUIRED');
    if (row.state === 'paid_credited' && (row.credit_state_durable !== true || !row.purchase_id)) throw fault('CHECKOUT_CREDIT_RECEIPT_REQUIRED');
}
function validateState(state) {
    if (!plainObject(state) || state.schema_version !== 1 || !Number.isSafeInteger(state.generation) || state.generation < 0 || !plainObject(state.intents) || seal(state).checksum !== state.checksum) throw fault('INVALID_CHECKOUT_STORE');
    validateManifest(state.initialization_manifest);
    const sessions = new Set();
    for (const [id, row] of Object.entries(state.intents)) {
        validateIntent(row); if (id !== row.intent_id) throw fault('INVALID_CHECKOUT_STORE');
        if (row.session_id) { const key = row.stripe_platform + ':' + row.session_id; if (sessions.has(key)) throw fault('DUPLICATE_CHECKOUT_SESSION'); sessions.add(key); }
    }
    return state;
}
function buildCheckoutIntentState(manifestRef) {
    validateManifest(manifestRef);
    return validateState(seal({ schema_version: 1, generation: 0, initialization_manifest: clone(manifestRef), intents: {} }));
}
function initializeCheckoutIntents(file, manifestRef) {
    validateManifest(manifestRef); if (fs.existsSync(file)) throw fault('CHECKOUT_STORE_ALREADY_INITIALIZED');
    const state = buildCheckoutIntentState(manifestRef); writeJSONAtomic(file, state); return state;
}
function createCheckoutIntentStore({ file = process.env.AUXILO_STRIPE_CHECKOUT_INTENTS_FILE || path.join(process.env.AUXILO_DATA_DIR || path.join(__dirname, '..', 'data'), 'stripe-checkout-intents.json') } = {}) {
    let state, ready = true, reason = null;
    try { state = validateState(readJSONStrict(file)); } catch (error) { ready = false; reason = error.code === 'ENOENT' ? 'checkout_store_uninitialized' : 'checkout_store_corrupt'; }
    function requireReady() { if (!ready) throw fault(); }
    function save(next) { requireReady(); const sealed = seal(next); validateState(sealed); try { writeJSONAtomic(file, sealed); } catch (error) { ready = false; reason = 'financial_storage_failure'; throw error; } state = sealed; }
    function all() { return state ? Object.values(state.intents).map(clone) : []; }
    function get(id) { return state && state.intents[id] ? clone(state.intents[id]) : null; }
    function blocking(accountId, nowMs = Date.now()) { requireReady(); return all().find(row => row.account_id === accountId && (['prepared', 'submitted', 'unknown', 'paid_pending_credit'].includes(row.state) || (row.state === 'confirmed_open' && row.expires_at <= nowMs))) || null; }
    function findOpen(accountId, fingerprint, nowMs = Date.now()) { requireReady(); return all().find(row => row.account_id === accountId && row.fingerprint === fingerprint && row.state === 'confirmed_open' && row.expires_at > nowMs) || null; }
    function prepare(input) {
        requireReady(); validateContext(input); if (blocking(input.account_id)) throw fault();
        const id = crypto.randomUUID();
        const row = { intent_id: id, idempotency_key: 'auxilo-checkout:' + id, account_id: input.account_id, stripe_platform: input.stripe_platform, stripe_platform_account_id: input.stripe_platform_account_id, configuration_generation: input.configuration_generation, livemode: input.livemode, pack_id: input.pack_id, currency: input.currency, amount_cents: input.amount_cents, base_url: input.base_url, fingerprint: checkoutFingerprint(input), prepared_at: new Date().toISOString(), state: 'prepared', generation: 1 };
        validateIntent(row); const next = clone(state); next.generation++; next.intents[id] = row; save(next); return clone(row);
    }
    function transition(id, generation, to, patch = {}) {
        requireReady(); const before = get(id);
        if (!before || before.generation !== generation || !TRANSITIONS[before.state].includes(to)) throw fault('CHECKOUT_STATE_CONFLICT');
        for (const key of Object.keys(patch)) if (!PATCH.has(key)) throw fault('IMMUTABLE_CHECKOUT_FIELD');
        for (const key of ['session_id', 'payment_intent_id', 'purchase_id']) if (before[key] && patch[key] && before[key] !== patch[key]) throw fault('CHECKOUT_IDENTITY_CONFLICT');
        if (patch.last_error_code !== undefined && !/^[a-zA-Z0-9_:-]{1,120}$/.test(patch.last_error_code)) throw fault('INVALID_OUTCOME_CODE');
        const row = { ...before, ...clone(patch), state: to, generation: generation + 1, updated_at: new Date().toISOString() };
        validateIntent(row); const next = clone(state); next.generation++; next.intents[id] = row; save(next); return clone(row);
    }
    function recordPaid(context, sessionId, purchaseId) {
        requireReady(); validateContext(context);
        const before = all().find(row => row.stripe_platform === context.stripe_platform && row.stripe_platform_account_id === context.stripe_platform_account_id && row.livemode === context.livemode && row.session_id === sessionId);
        if (!before || !purchaseId) throw fault('UNKNOWN_CHECKOUT_ORIGIN');
        if (before.state === 'paid_credited') { if (before.purchase_id !== purchaseId) throw fault('CHECKOUT_IDENTITY_CONFLICT'); return before; }
        let pending = before;
        if (pending.state !== 'paid_pending_credit') pending = transition(before.intent_id, before.generation, 'paid_pending_credit', { purchase_id: purchaseId, evidence: { verified: true, authoritative: true, evidence_ref: 'verified-paid:' + sessionId, intent_id: before.intent_id, account_id: before.account_id, amount_cents: before.amount_cents, currency: before.currency, session_id: sessionId, stripe_platform: context.stripe_platform, stripe_platform_account_id: context.stripe_platform_account_id, livemode: context.livemode } });
        return transition(pending.intent_id, pending.generation, 'paid_credited', { credit_state_durable: true, purchase_id: purchaseId });
    }
    return { get ready() { return ready; }, get reason() { return reason; }, all, get, blocking, findOpen, prepare, transition, recordPaid };
}
module.exports = { buildCheckoutIntentState, validateCheckoutIntentState: validateState, initializeCheckoutIntents, createCheckoutIntentStore, checkoutFingerprint, validateManifest, validateContext, seal, PLATFORMS };
