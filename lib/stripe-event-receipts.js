'use strict';
const fs = require('fs');
const path = require('path');
const { digestJSON, plainObject, readJSONStrict, writeJSONAtomic } = require('./stripe-transfer-persistence');
const { validateManifest, seal, PLATFORMS } = require('./stripe-checkout-intents');
const clone = value => JSON.parse(JSON.stringify(value));
const locks = new Map();
function fault(message) { const error = new Error(message); error.code = message; return error; }
function key(alias, id) { return digestJSON([alias, id]); }
async function lock(id) { const prior = locks.get(id) || Promise.resolve(); let release; const turn = new Promise(resolve => { release = resolve; }); const tail = prior.then(() => turn); locks.set(id, tail); await prior; let done = false; return () => { if (done) return; done = true; release(); if (locks.get(id) === tail) locks.delete(id); }; }
function validateReceipt(row) {
    if (!plainObject(row) || PLATFORMS[row.stripe_platform] !== row.stripe_platform_account_id || !row.event_id || !row.event_type || !row.object_id || !/^[a-f0-9]{64}$/.test(row.payload_digest || '') || !['processing', 'completed', 'quarantined'].includes(row.state) || row.receipt_id !== key(row.stripe_platform, row.event_id)) throw fault('INVALID_EVENT_RECEIPT');
}
function validateStore(state) {
    if (!plainObject(state) || state.schema_version !== 1 || !plainObject(state.receipts) || seal(state).checksum !== state.checksum) throw fault('INVALID_EVENT_RECEIPT_STORE');
    validateManifest(state.initialization_manifest);
    for (const [id, row] of Object.entries(state.receipts)) { validateReceipt(row); if (id !== row.receipt_id) throw fault('INVALID_EVENT_RECEIPT_STORE'); }
    return state;
}
function initializeEventReceipts(file, manifestRef) {
    validateManifest(manifestRef); if (fs.existsSync(file)) throw fault('EVENT_RECEIPTS_ALREADY_INITIALIZED');
    const state = seal({ schema_version: 1, initialization_manifest: clone(manifestRef), receipts: {} }); writeJSONAtomic(file, state); return state;
}
function createEventReceiptStore({ file = process.env.AUXILO_STRIPE_EVENT_RECEIPTS_FILE || path.join(process.env.AUXILO_DATA_DIR || path.join(__dirname, '..', 'data'), 'stripe-event-receipts.json') } = {}) {
    let state, ready = true, reason = null;
    try { state = validateStore(readJSONStrict(file)); } catch (error) { ready = false; reason = error.code === 'ENOENT' ? 'event_receipts_uninitialized' : 'event_receipts_corrupt'; }
    function requireReady() { if (!ready) throw fault('EVENT_RECONCILIATION_REQUIRED'); }
    function save(next) { requireReady(); const sealed = seal(next); validateStore(sealed); try { writeJSONAtomic(file, sealed); } catch (error) { ready = false; reason = 'financial_storage_failure'; throw error; } state = sealed; }
    function get(alias, eventId) { requireReady(); const row = state.receipts[key(alias, eventId)]; return row ? clone(row) : null; }
    function begin(input) {
        requireReady(); const row = { ...clone(input), receipt_id: key(input.stripe_platform, input.event_id), state: 'processing', created_at: new Date().toISOString() };
        const allowed = new Set(['stripe_platform', 'stripe_platform_account_id', 'event_id', 'event_type', 'object_id', 'payload_digest', 'purchase_id']);
        if (Object.keys(input).some(field => !allowed.has(field))) throw fault('UNEXPECTED_EVENT_RECEIPT_FIELD');
        validateReceipt(row);
        if (row.purchase_id && Object.values(state.receipts).some(prior => prior.stripe_platform === row.stripe_platform && prior.object_id === row.object_id && prior.purchase_id && prior.purchase_id !== row.purchase_id)) throw fault('EVENT_PURCHASE_IDENTITY_CONFLICT');
        const before = get(input.stripe_platform, input.event_id);
        if (before) {
            for (const field of allowed) if (field !== 'purchase_id' && before[field] !== row[field]) throw fault('EVENT_RECEIPT_CONFLICT');
            if (before.purchase_id && before.purchase_id !== row.purchase_id) throw fault('EVENT_RECEIPT_CONFLICT');
            if (!before.purchase_id && row.purchase_id) {
                if (before.state === 'completed') throw fault('EVENT_RECEIPT_CONFLICT');
                const next = clone(state); next.receipts[before.receipt_id] = { ...before, purchase_id: row.purchase_id }; save(next); return clone(next.receipts[before.receipt_id]);
            }
            return before;
        }
        const next = clone(state); next.receipts[row.receipt_id] = row; save(next); return clone(row);
    }
    function update(alias, eventId, newState, patch) {
        requireReady(); const before = get(alias, eventId); if (!before) throw fault('UNKNOWN_EVENT_RECEIPT');
        if (before.state === 'completed') { if (newState !== 'completed') throw fault('EVENT_ALREADY_COMPLETED'); return before; }
        if (Object.keys(patch).some(field => !['reason', 'disposition', 'evidence_ref'].includes(field))) throw fault('IMMUTABLE_EVENT_RECEIPT_FIELD');
        if (Object.values(patch).some(value => typeof value !== 'string' || !/^[A-Za-z0-9_.:/-]{1,200}$/.test(value))) throw fault('INVALID_EVENT_RECEIPT_CODE');
        const row = { ...before, ...patch, state: newState, updated_at: new Date().toISOString() }; const next = clone(state); next.receipts[row.receipt_id] = row; save(next); return clone(row);
    }
    async function withLocks(context, event, fn) {
        if (PLATFORMS[context.stripe_platform] !== context.stripe_platform_account_id) throw fault('INVALID_STRIPE_CONTEXT');
        const eventId = event.id || event.event_id; const object = event.data && event.data.object;
        const pi = object && (typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent && object.payment_intent.id);
        const objectId = object && object.object === 'checkout.session' ? object.id : pi ? 'payment_intent:' + pi : event.object_id || object && object.id;
        if (!eventId || !objectId) throw fault('INVALID_EVENT_IDENTITY');
        const releaseEvent = await lock('event:' + key(context.stripe_platform, eventId));
        let releaseObject; try { releaseObject = await lock('object:' + key(context.stripe_platform, objectId)); return await fn(); } finally { if (releaseObject) releaseObject(); releaseEvent(); }
    }
    return { get ready() { return ready; }, get reason() { return reason; }, get, all: () => state ? Object.values(state.receipts).map(clone) : [], begin, complete: (alias, id, patch = {}) => update(alias, id, 'completed', patch), quarantine: (alias, id, reason) => update(alias, id, 'quarantined', { reason }), withLocks };
}
module.exports = { initializeEventReceipts, createEventReceiptStore };
