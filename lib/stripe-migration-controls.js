'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { plainObject, readJSONStrict, writeJSONAtomic } = require('./stripe-transfer-persistence');
const { validateManifest, seal } = require('./stripe-checkout-intents');
const BINDING = ['checkpoint_id', 'manifest_sha256', 'journal_id', 'approval_ref'];
const ACTIONS = { checkout: 'allow_checkout', connect_creation: 'allow_connect_creation', builder_transfer: 'allow_builder_transfer', financial: null, webhook: null };
function fault(message = 'STRIPE_MIGRATION_UNAVAILABLE') { const error = new Error(message); error.code = message; return error; }
function paths(options = {}) { const dir = process.env.AUXILO_DATA_DIR || path.join(__dirname, '..', 'data'); return { file: options.file || process.env.AUXILO_STRIPE_MIGRATION_CONTROL_FILE || path.join(dir, 'stripe-migration-control.json'), armedFile: options.armedFile || process.env.AUXILO_STRIPE_MIGRATION_ARMED_FILE || path.join(dir, 'stripe-migration-armed.json'), journalFile: options.journalFile || process.env.AUXILO_STRIPE_MIGRATION_JOURNAL_FILE || path.join(dir, 'stripe-migration-journal.json'), checkoutFile: options.checkoutFile || process.env.AUXILO_STRIPE_CHECKOUT_INTENTS_FILE || path.join(dir, 'stripe-checkout-intents.json'), eventsFile: options.eventsFile || process.env.AUXILO_STRIPE_EVENT_RECEIPTS_FILE || path.join(dir, 'stripe-event-receipts.json'), originsFile: options.originsFile || process.env.AUXILO_STRIPE_OBJECT_ORIGINS_FILE || path.join(dir, 'stripe-object-origins.json') }; }
function validateControl(control) {
    if (!plainObject(control) || control.schema_version !== 1 || !Number.isSafeInteger(control.generation) || control.generation < 1 || BINDING.some(field => typeof control[field] !== 'string' || !control[field]) || !/^[a-f0-9]{64}$/.test(control.manifest_sha256) || seal(control).checksum !== control.checksum) throw fault();
    if (!['legacy_only', 'draining', 'dual_service', 'new_intake', 'paused'].includes(control.phase) || ['allow_checkout', 'allow_connect_creation', 'allow_builder_transfer'].some(field => typeof control[field] !== 'boolean')) throw fault();
    if (control.phase === 'legacy_only' && control.intake_platform !== 'legacy') throw fault();
    if (control.phase === 'dual_service' && !['legacy', null].includes(control.intake_platform)) throw fault();
    if (['draining', 'paused'].includes(control.phase) && (control.intake_platform !== null || control.allow_checkout || control.allow_connect_creation || control.allow_builder_transfer)) throw fault();
    if (control.phase === 'new_intake' && (control.intake_platform !== 'auxilo_llc' || control.unknown_history_count !== 0)) throw fault();
    if (control.allow_checkout && !control.intake_platform) throw fault();
    if (control.allow_builder_transfer && (!Number.isSafeInteger(control.payout_approval_revision) || control.payout_approval_revision < 1 || typeof control.execution_approval_ref !== 'string' || !control.execution_approval_ref)) throw fault();
    return control;
}
// The caller's zero is never evidence: history comes from the completed journal.
function assertNewIntakeHistory(journal) {
    for (const field of ['unknown_origin', 'hold_conflicts', 'unresolved_attempts']) {
        if (!Number.isSafeInteger(journal[field]) || journal[field] !== 0) throw fault('MIGRATION_HISTORY_UNRESOLVED');
    }
}
function assertNewIntakeActivation(journal, p) {
    assertNewIntakeHistory(journal);
    const store = require('./stripe-checkout-intents').createCheckoutIntentStore({ file: p.checkoutFile });
    if (!store.ready) throw fault('CHECKOUT_INVENTORY_UNRESOLVED');
    const raw = readJSONStrict(p.checkoutFile), ref = raw.initialization_manifest;
    if (!ref || ['checkpoint_id', 'manifest_sha256', 'approval_ref'].some(field => ref[field] !== journal[field])) throw fault('CHECKOUT_INVENTORY_BINDING_CONFLICT');
    const now = Date.now();
    if (store.all().some(row => ['prepared', 'submitted', 'unknown', 'paid_pending_credit'].includes(row.state)
        || (row.state === 'confirmed_open' && row.expires_at <= now))) throw fault('CHECKOUT_INVENTORY_UNRESOLVED');
}
function getMigrationControl(options = {}) {
    const history = require('./stripe-history-coverage').inspectHistoryCoverage();
    if (history.present) return { ready: history.ready, armed: true, phase: history.ready ? 'paused' : 'unavailable', intake_platform: null,
        allow_checkout: false, allow_connect_creation: false, allow_builder_transfer: false,
        historical_coverage: 'unknown', reason: 'HISTORICAL_COVERAGE_UNKNOWN', checkpoint: history.coverage || null };
    const p = paths(options);
    const failed = { ready: false, armed: fs.existsSync(p.armedFile), phase: 'unavailable', intake_platform: null, allow_checkout: false, allow_connect_creation: false, allow_builder_transfer: false, reason: 'migration_state_invalid', checkpoint: null };
    try {
        const journal = require('./stripe-migration-journal').assertMigrationJournalComplete({ file: p.journalFile });
        if (!fs.existsSync(p.armedFile)) {
            // A completed apply awaiting arming is maintenance, never a return to legacy defaults.
            if (journal.state !== 'unarmed' || fs.existsSync(p.file)) return failed;
            return { ready: true, armed: false, phase: 'legacy_only', intake_platform: 'legacy', allow_checkout: true, allow_connect_creation: true, allow_builder_transfer: true, generation: 0, reason: null, checkpoint: null };
        }
        const marker = readJSONStrict(p.armedFile), control = validateControl(readJSONStrict(p.file));
        if (!plainObject(marker) || marker.schema_version !== 1 || journal.state !== 'completed' || BINDING.some(field => marker[field] !== control[field] || marker[field] !== journal[field])) return failed;
        if (control.phase === 'new_intake') assertNewIntakeHistory(journal);
        return { ...control, ready: true, armed: true, reason: null, checkpoint: { checkpoint_id: control.checkpoint_id, manifest_sha256: control.manifest_sha256, journal_id: control.journal_id, approval_ref: control.approval_ref } };
    } catch { return failed; }
}
function assertCheckoutFulfillmentReady(control, p) {
    const checkout = require('./stripe-checkout-intents').createCheckoutIntentStore({ file: p.checkoutFile });
    const events = require('./stripe-event-receipts').createEventReceiptStore({ file: p.eventsFile });
    if (!checkout.ready || !events.ready) throw fault('CHECKOUT_FULFILLMENT_UNAVAILABLE');
    require('./stripe-object-origins').createOriginStore({ file: p.originsFile }).all();
    const refs = [readJSONStrict(p.checkoutFile).initialization_manifest,
        readJSONStrict(p.eventsFile).initialization_manifest, readJSONStrict(p.originsFile).manifest];
    const fields = ['checkpoint_id', 'manifest_sha256', 'approval_ref'];
    if (refs.some(ref => !ref || fields.some(field => ref[field] !== refs[0][field]))
        || (control.armed && fields.some(field => refs[0][field] !== control[field]))) throw fault('CHECKOUT_FULFILLMENT_BINDING_CONFLICT');
}
function assertActionAllowed(action, options = {}) {
    if (!Object.hasOwn(ACTIONS, action)) throw fault('UNKNOWN_MIGRATION_ACTION');
    const control = getMigrationControl(options); if (!control.ready || control.historical_coverage === 'unknown' || (ACTIONS[action] && !control[ACTIONS[action]])) throw fault();
    if (action === 'checkout') assertCheckoutFulfillmentReady(control, paths(options));
    return control;
}
function requireFixturePaths(options) {
    const root = fs.realpathSync(os.tmpdir());
    for (const field of ['file', 'armedFile', 'journalFile']) {
        if (!options[field] || !path.isAbsolute(options[field])) throw fault('EXPLICIT_FIXTURE_PATHS_REQUIRED');
        const parent = fs.realpathSync(path.dirname(options[field]));
        if (parent !== root && !parent.startsWith(root + path.sep)) throw fault('ISOLATED_FIXTURE_PATH_REQUIRED');
        if (fs.existsSync(options[field]) && fs.lstatSync(options[field]).isSymbolicLink()) throw fault('ISOLATED_FIXTURE_PATH_REQUIRED');
    }
}
function initializeMigrationControl(options) {
    const { manifestRef, journalId, control, isolatedFixture, approved } = options;
    if (isolatedFixture !== true || approved !== true) throw fault('OFFLINE_INITIALIZATION_REQUIRED');
    if (require('./stripe-history-coverage').historyFinancialBlocked()) throw fault('HISTORICAL_COVERAGE_UNKNOWN');
    requireFixturePaths(options); validateManifest(manifestRef); const p = paths(options);
    if (fs.existsSync(p.file) || fs.existsSync(p.armedFile)) throw fault('MIGRATION_ALREADY_ARMED');
    const journal = require('./stripe-migration-journal').assertMigrationJournalComplete({ file: p.journalFile });
    const binding = { checkpoint_id: manifestRef.checkpoint_id, manifest_sha256: manifestRef.manifest_sha256, approval_ref: manifestRef.approval_ref, journal_id: journalId };
    if (journal.state !== 'completed' || BINDING.some(field => binding[field] !== journal[field])) throw fault('MIGRATION_JOURNAL_BINDING_CONFLICT');
    const value = seal({ ...control, ...binding, schema_version: 1, generation: 1 }); validateControl(value);
    if (value.phase === 'new_intake') { requireFixturePaths({ ...p, file: p.checkoutFile }); assertNewIntakeActivation(journal, p); }
    writeJSONAtomic(p.file, value); writeJSONAtomic(p.armedFile, { schema_version: 1, ...binding }); return getMigrationControl(p);
}
function transitionMigrationControl(expectedGeneration, patch, options = {}) {
    if (options.isolatedFixture !== true || options.approved !== true) throw fault('OFFLINE_TRANSITION_REQUIRED');
    if (require('./stripe-history-coverage').historyFinancialBlocked()) throw fault('HISTORICAL_COVERAGE_UNKNOWN');
    requireFixturePaths(options); const current = getMigrationControl(options); if (!current.ready || !current.armed || current.generation !== expectedGeneration) throw fault('MIGRATION_GENERATION_CONFLICT');
    if (Object.keys(patch).some(field => !['phase', 'intake_platform', 'allow_checkout', 'allow_connect_creation', 'allow_builder_transfer', 'unknown_history_count', 'payout_approval_revision', 'execution_approval_ref'].includes(field))) throw fault('IMMUTABLE_MIGRATION_BINDING');
    const p = paths(options), stored = readJSONStrict(p.file); const next = seal({ ...stored, ...patch, generation: expectedGeneration + 1 }); validateControl(next);
    const enabling = next.phase === 'new_intake' && (current.phase !== 'new_intake'
        || ['allow_checkout', 'allow_connect_creation', 'allow_builder_transfer'].some(field => !current[field] && next[field]));
    if (enabling) { requireFixturePaths({ ...p, file: p.checkoutFile }); assertNewIntakeActivation(require('./stripe-migration-journal').assertMigrationJournalComplete({ file: p.journalFile }), p); }
    writeJSONAtomic(p.file, next); return getMigrationControl(p);
}
module.exports = { getMigrationControl, assertActionAllowed, initializeMigrationControl, transitionMigrationControl, validateControl };
