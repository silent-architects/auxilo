'use strict';
const path = require('path');
const { plainObject, readJSONStrict } = require('./stripe-transfer-persistence');
const { seal, PLATFORMS } = require('./stripe-checkout-intents');
const platformLocks = new Map();
function fault() { const error = new Error('PAYOUT_ASSIGNMENT_REQUIRED'); error.code = 'PAYOUT_ASSIGNMENT_REQUIRED'; return error; }
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }
function safeCents(value) { return Number.isSafeInteger(value) && value >= 0; }
function validTime(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function validateEvidence(entry) {
    if (!plainObject(entry) || entry.schema_version !== 1 || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || !['approved', 'disabled'].includes(entry.disposition) || !nonempty(entry.reason) || !nonempty(entry.earnings_key)) throw fault();
    if (entry.disposition === 'disabled') return entry;
    const strings = ['checkpoint_id', 'account_id', 'assent_evidence_ref', 'obligation_entity', 'stripe_connect_id', 'capability_evidence_ref', 'servicing_evidence_ref', 'execution_approval_ref'];
    if (strings.some(field => !nonempty(entry[field])) || !validTime(entry.checkpoint_at) || !validTime(entry.cash_checkpoint_at) || !validTime(entry.servicing_effective_at) || !plainObject(entry.source_hashes) || !Object.keys(entry.source_hashes).length || Object.values(entry.source_hashes).some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw fault();
    if (entry.local_owner_resolved !== true || entry.currency !== 'usd' || entry.unit_precision !== 2 || entry.assent_status !== 'accepted' || entry.destination_verified !== true || entry.unresolved_attempts !== 0 || !Array.isArray(entry.holds) || entry.holds.length || typeof entry.livemode !== 'boolean') throw fault();
    if (PLATFORMS[entry.stripe_platform] !== entry.stripe_platform_account_id || !Object.hasOwn(PLATFORMS, entry.obligation_origin) || !Array.isArray(entry.transaction_refs) || !entry.transaction_refs.length || entry.transaction_refs.some(value => !nonempty(value))) throw fault();
    if (entry.livemode && entry.transaction_refs.some(value => /^cs_test_/.test(value))) throw fault();
    // A source different from the obligation's origin needs explicit evidence of an assignment.
    if (entry.obligation_origin !== entry.stripe_platform && (!nonempty(entry.assignment_evidence_ref) || !validTime(entry.assignment_effective_at))) throw fault();
    if (!Number.isSafeInteger(entry.money_pm_approval_revision) || entry.money_pm_approval_revision < 1 || !Number.isFinite(entry.amount_usd) || entry.amount_usd <= 0 || !Number.isFinite(entry.ledger_balance_usd) || entry.ledger_balance_usd < entry.amount_usd) throw fault();
    if (['reserved_cents', 'available_cents', 'pending_cents', 'restricted_cents', 'gross_amount_cents', 'net_amount_cents', 'fee_cents'].some(field => !safeCents(entry[field])) || entry.net_amount_cents <= 0 || entry.gross_amount_cents !== Math.round(entry.amount_usd * 100) || entry.gross_amount_cents !== entry.net_amount_cents + entry.fee_cents || entry.available_cents - entry.reserved_cents < entry.net_amount_cents) throw fault();
    return entry;
}
function loadPayoutAssignment(earningsKey, { file = process.env.AUXILO_STRIPE_PAYOUT_ASSIGNMENTS_FILE || path.join(process.env.AUXILO_DATA_DIR || path.join(__dirname, '..', 'data'), 'stripe-payout-assignments.json') } = {}) {
    let state; try { state = readJSONStrict(file); } catch { throw fault(); }
    if (!plainObject(state) || state.schema_version !== 1 || !plainObject(state.entries) || seal(state).checksum !== state.checksum) throw fault();
    for (const [key, entry] of Object.entries(state.entries)) { validateEvidence(entry); if (key !== entry.earnings_key) throw fault(); }
    if (!Object.hasOwn(state.entries, earningsKey)) throw fault(); return state.entries[earningsKey];
}
function validatePayoutAssignment(entry, current = {}) {
    validateEvidence(entry); const context = current.context || {}, mapping = current.mapping || {};
    if (entry.disposition !== 'approved' || current.accountId !== entry.account_id || current.earningsKey !== entry.earnings_key || context.stripe_platform !== entry.stripe_platform || context.stripe_platform_account_id !== entry.stripe_platform_account_id || context.livemode !== entry.livemode || (mapping.connected_id || mapping.stripe_connect_id) !== entry.stripe_connect_id || (mapping.stripe_platform_account_id !== undefined && mapping.stripe_platform_account_id !== entry.stripe_platform_account_id)) throw fault();
    if (current.amountUsd !== entry.amount_usd || current.netCents !== entry.net_amount_cents || current.assent !== true || current.currentLedgerBalance !== entry.ledger_balance_usd || current.checkpointId !== entry.checkpoint_id || current.approvalRevision !== entry.money_pm_approval_revision || current.executionApprovalRef !== entry.execution_approval_ref || current.unknownAttempts !== false || !Array.isArray(current.holds) || current.holds.length) throw fault();
    if (!safeCents(current.availableCents) || !safeCents(current.reservedCents) || current.availableCents - current.reservedCents < entry.net_amount_cents) throw fault();
    return entry;
}
async function acquirePlatformAdmissionLock(alias) {
    if (!Object.hasOwn(PLATFORMS, alias)) throw fault();
    const prior = platformLocks.get(alias) || Promise.resolve(); let resolve;
    const turn = new Promise(r => { resolve = r; }); const tail = prior.then(() => turn); platformLocks.set(alias, tail); await prior;
    let released = false; return () => { if (released) return; released = true; resolve(); if (platformLocks.get(alias) === tail) platformLocks.delete(alias); };
}
module.exports = { loadPayoutAssignment, validatePayoutAssignment, acquirePlatformAdmissionLock, sealAssignments: seal, validatePayoutAssignmentEvidence: validateEvidence };
