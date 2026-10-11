'use strict';
// A2 rollback and old-binary refusal (v3 4.5, Addendum 1 A3.3-A3.4b): the pre-A2 modules, extracted with
// `git archive 6653298 lib`, must refuse what the A2 code writes. Never skips.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { materializeBaseline, BASELINE, HASHES } = require('./helpers/money-baseline');
const e = require('../lib/financial-epoch'), op = require('../lib/financial-epoch-operator'), p = require('../lib/stripe-transfer-persistence'), fmod = () => require('../lib/money-failure-control');
const { HEX, syntheticBinding, syntheticEpoch, retirementIdentity } = require('./helpers/money-synthetic-epoch');
const digest = require('../lib/money-control-store').digest;

test('the baseline is materialized from the pinned commit and every file used is hash-equal to the recorded value', t => {
  const base = materializeBaseline(t);
  assert.equal(BASELINE, '6653298');
  for (const [name, expected] of Object.entries(HASHES)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(base.lib, name))).digest('hex'), expected, name);
});
test('old validateControl refuses a retired source control and a successor control, and ACCEPTS the same control at schema_version 1 (negative control)', t => {
  const base = materializeBaseline(t), old = base.load('financial-epoch.js'), binding = syntheticBinding();
  assert.equal(old.validateBinding(binding), binding, 'the baseline reads the same binding');
  const plain = e.seal({ schema_version: 1, binding_digest: binding.binding_digest, epoch_id: binding.identity.epoch_id, generation: 0, state: 'paused', capabilities: Object.fromEntries(e.CAPABILITIES.map(k => [k, false])), evidence: {} });
  assert.equal(old.validateControl(plain, binding), plain, 'negative control: the baseline accepts a schema 1 control, so the refusals below are not vacuous');
  const retired = e.seal({ ...plain, schema_version: 2, retirement: e.buildRetirement(retirementIdentity()) }), successor = e.seal({ ...plain, schema_version: 2, successorOf: { generationId: HEX('1') } });
  for (const control of [retired, successor]) {
    assert.equal(e.validateControl(control, binding), control, 'the A2 validator accepts it');
    assert.throws(() => old.validateControl(control, binding), { code: 'EPOCH_CONTROL_INVALID' });
  }
  const edited = { ...retired, schema_version: 1 };
  assert.throws(() => old.validateControl(edited, binding), { code: 'EPOCH_CONTROL_INVALID' }, 'editing the version back breaks the seal');
  assert.throws(() => e.validateControl(edited, binding), { code: 'EPOCH_CONTROL_INVALID' });
  const resealed = e.seal({ ...edited });
  assert.throws(() => e.validateControl(resealed, binding), { code: 'EPOCH_CONTROL_INVALID' }, 'a version 1 control carrying the A2 fields is refused by the A2 validator too (A0.6)');
});
test('the controls the A2 operator writes are exactly the ones the old binary cannot read', t => {
  const base = materializeBaseline(t), old = base.load('financial-epoch.js'), x = syntheticEpoch(t);
  const binding = x.binding, before = old.validateControl(x.readControl(), binding);
  assert.equal(before.schema_version, 1);
  const written = op.retireEpochControl({ root: x.root, writer: x.writer, expectedRevision: 0, identity: retirementIdentity() });
  assert.equal(written.schema_version, 2);
  assert.throws(() => old.validateControl(x.readControl(), binding), { code: 'EPOCH_CONTROL_INVALID' });
});
function failureFixture(t, mods) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-failure-')));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const epoch = { epoch_id: 'failure-test', binding_digest: 'a'.repeat(64), financial_dir: dir, legacy_root: dir, platform_account_id: 'acct_test', livemode: false };
  let root; const operations = new Map();
  const store = { epoch, descriptor: { database_id: 'db-test' }, readMetadata: () => ({ database_id: 'db-test', revision: 0 }), getCapacityRecord: id => id === 'capacity:root' ? root : undefined, getOperation: id => operations.get(id), getSource: () => ({ id: 's', accountId: 'buyer', input_digest: 'b'.repeat(64), epoch_id: epoch.epoch_id, binding_digest: epoch.binding_digest, platform_account_id: epoch.platform_account_id, livemode: false }), atomicCapacityStatus: () => ({ ready: true }) };
  const writer = mods.lock.injectMoneyWriter({ root: dir, assertOwned: () => true });
  root = { id: 'capacity:root', failureControl: mods.fc.initializeFailureControl({ epoch, writer, store }) };
  const anchors = mods.anchor.createRecoveryAnchors({ epoch, writer, store });
  operations.set('a', { id: 'a', sourceId: 's', accountId: 'buyer', epoch_id: epoch.epoch_id, binding_digest: epoch.binding_digest, platform_account_id: epoch.platform_account_id, livemode: false, state: 'dispatch_intent', clientRequestKey: 'a', provider_payload: { amount: 1 }, provider_payload_digest: digest({ amount: 1 }), provider_request_digest: 'c'.repeat(64), idempotency_key: 'ka', quoteHash: 'd'.repeat(64) });
  const cap = anchors.resolveCommittedAnchor({ kind: 'dispatch_operation', id: 'a' });
  return { dir, epoch, writer, store, anchors, cap, open: () => mods.fc.openFailureControl({ epoch, writer, store, anchors }) };
}
test('rollback: pre-A2 failure control rejects a slot carrying CONTINUATION_AUTHORITY_REQUIRED with FAILURE_CONTROL_SCHEMA and cannot open the epoch (v3 4.5)', t => {
  const base = materializeBaseline(t);
  const current = failureFixture(t, { lock: require('../lib/money-writer-lock'), fc: fmod(), anchor: require('../lib/money-recovery-anchor') });
  const manager = current.open();
  manager.noteFailure({ anchor: current.cap, reason: 'CONTINUATION_AUTHORITY_REQUIRED', phase: 'boot_recovery', cutStatus: 'verified' });
  assert.equal(manager.statusDetail().reason, 'CONTINUATION_AUTHORITY_REQUIRED');
  const bytes = fs.readFileSync(path.join(current.dir, fmod().FILE));
  const old = failureFixture(t, { lock: base.load('money-writer-lock.js'), fc: base.load('money-failure-control.js'), anchor: base.load('money-recovery-anchor.js') });
  assert.equal(old.open().status().state, 'idle', 'negative control: the baseline opens an ordinary slot');
  fs.writeFileSync(path.join(old.dir, fmod().FILE), bytes);
  // Same epoch identity in both fixtures, so only the reason can differ.
  assert.throws(() => old.open(), { code: 'FAILURE_CONTROL_SCHEMA' });
  const oldManager = failureFixture(t, { lock: base.load('money-writer-lock.js'), fc: base.load('money-failure-control.js'), anchor: base.load('money-recovery-anchor.js') });
  assert.throws(() => oldManager.open().noteFailure({ anchor: oldManager.cap, reason: 'CONTINUATION_AUTHORITY_REQUIRED', phase: 'boot_recovery', cutStatus: 'verified' }), { code: 'FAILURE_CONTROL_SCHEMA' }, 'the baseline does not know the reason at all');
});
