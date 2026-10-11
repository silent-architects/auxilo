'use strict';
// Closure item 2: a reconciled restore barrier ALONE grants no financial capability.
//
// TRACE (source-backed). What `barrierLifted(root)` (lib/money-atomic-restore.js) feeds:
//   1. lib/money-continuation-authority.js createSuccessorGate().assertAllows: when status is 'claimed' and lifted() is true it returns true.
//      That removes ONLY the successor restriction at the four money-control points (E1 context entry, E2 registerRecoveryAnchor, E3 assertFinancialEffect,
//      E4 commit gate). It is not a capability authority and money-control never reads epoch.capabilities.
//   2. lib/financial-epoch-operator.js transitionEpoch: for a claimed successor, enabling any non-reconcile capability is refused with
//      EPOCH_SUCCESSOR_ACTIVATION_REQUIRED unless lifted. Lifted only lets the request CONTINUE into the ordinary transition path.
// What still governs every action a lifted claimed successor could take:
//   a. Capability patch (the only writer of control.capabilities): transitionEpoch requires evidence.approval_ref and, per enabled capability, a 64-hex
//      evidence digest (EPOCH_CAPABILITY_EVIDENCE_REQUIRED, operator lines "if (!evidence?.approval_ref)" and "if (v && !/^[a-f0-9]{64}$/...)"), then
//      e.validateControl (capacity acceptance and a published policy for funding/spend/buyer_return) and the RESTORE_RECONCILIATION_REQUIRED barrier test.
//      restoreCheckpoint leaves ONLY reconcile on; nothing else turns a capability on.
//   b. Routes and domain handlers: financial-epoch.js assertProspectiveAllowed reads the FRESH control: capabilities[action] false ->
//      EPOCH_CAPABILITY_DISABLED, revision mismatch -> EPOCH_CONTROL_CONFLICT (server.js requireProspectiveAction, 213-229; stripe handlers; funds-return;
//      payments-switch). The spend route additionally runs in a money context, so the failure control (gate -> assertNewEffectAllowed) must be idle
//      (FINANCIAL_RECOVERY_REQUIRED) and the source chain checks (assertEpochSource) apply.
//   c. resolveRuntimeEpoch: with a reconciled barrier the admission test no longer constrains capabilities; it never enables one.
//   d. Reconcile is the one capability a successor keeps. After lift, `reconcileProspectiveMoney` (server.js 14857) may run reconciliation contexts;
//      that is the intended meaning of "activation lifts the claimed restriction", not a grant of funding, spend or buyer_return.
//   e. Nothing in lib/ or scripts/ writes barrier state 'reconciled' (see the A1.5e fixture); a forged sealed barrier shares the trust root of any control file.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const proxyquire = require('proxyquire').noCallThru(), real = require('../lib/financial-epoch'), p = require('../lib/stripe-transfer-persistence'), A = require('../lib/money-continuation-authority');
const fixture = require('./helpers/financial-epoch-fixture'), { HEX, syntheticEpoch, syntheticBinding } = require('./helpers/money-synthetic-epoch');
const code = c => error => error.code === c;
const reconciledBarrier = () => real.seal({ schema_version: 1, state: 'reconciled', checkpoint_id: 'c', checkpoint_digest: HEX('1'), capacity_recreation_required: false, provider_reconciliation_complete: true });

test('b/c: with a reconciled barrier on disk and every capability off, each capability route check is EPOCH_CAPABILITY_DISABLED (real epoch)', t => {
  const x = fixture.boot(t);
  p.writeJSONAtomic(path.join(x.root, 'money-restore-barrier.json'), reconciledBarrier());
  real.invalidateEpochRuntime(x.root);
  const epoch = real.resolveRuntimeEpoch({ root: x.root });
  assert.ok(Object.values(epoch.capabilities).every(v => v === false), 'a bootstrapped epoch starts with every capability off');
  for (const action of ['funding', 'spend', 'buyer_return', 'reconcile', 'identity']) {
    assert.throws(() => real.assertProspectiveAllowed({ action, epoch, expectedRevision: epoch.activation_revision }), code('EPOCH_CAPABILITY_DISABLED'), action);
  }
  assert.throws(() => real.assertProspectiveAllowed({ action: 'spend', epoch, expectedRevision: epoch.activation_revision + 1 }), code('EPOCH_CONTROL_CONFLICT'), 'a stale revision is refused first');
});
test('a: a lifted claimed successor still needs transition evidence: no approval_ref, no per-capability digest, and still no capability', t => {
  const binding = syntheticBinding();
  const control = real.seal({ schema_version: 2, binding_digest: binding.binding_digest, epoch_id: binding.identity.epoch_id, generation: 5, state: 'reconcile_only', capabilities: Object.fromEntries(real.CAPABILITIES.map(k => [k, k === 'reconcile'])), evidence: { reconcile: HEX('e') }, successorOf: { generationId: HEX('1') } });
  const x = syntheticEpoch(t, { control }), current = { binding_digest: binding.binding_digest, financial_dir: x.dir, legacy_root: x.root, activation_revision: 5 };
  fs.writeFileSync(path.join(x.root, 'money-restore-barrier.json'), JSON.stringify(reconciledBarrier()));
  const op = proxyquire('../lib/financial-epoch-operator', { './financial-epoch': { ...real, resolveRuntimeEpoch: () => current, requireEpoch: () => ({ binding: x.binding, control }) }, './money-atomic-restore': { successorStatusFor: () => 'claimed', barrierLifted: () => true } });
  const before = fs.readFileSync(x.controlFile), go = (patch, evidence) => op.transitionEpoch({ epoch: current, writer: x.writer, expectedRevision: 5, patch, evidence });
  assert.throws(() => go({ spend: true }, undefined), code('EPOCH_CAPABILITY_EVIDENCE_REQUIRED'), 'no evidence object');
  assert.throws(() => go({ spend: true }, {}), code('EPOCH_CAPABILITY_EVIDENCE_REQUIRED'), 'no approval_ref');
  assert.throws(() => go({ spend: true }, { approval_ref: 'a' }), code('EPOCH_CAPABILITY_EVIDENCE_REQUIRED'), 'no spend digest');
  assert.throws(() => go({ funding: true, spend: true }, { approval_ref: 'a', spend: HEX('f') }), code('EPOCH_CAPABILITY_EVIDENCE_REQUIRED'), 'one digest missing');
  assert.throws(() => go({ spend: true }, { approval_ref: 'a', spend: 'not-hex' }), code('EPOCH_CAPABILITY_EVIDENCE_REQUIRED'), 'malformed digest');
  assert.throws(() => go({ spend: true }, { approval_ref: 'a', spend: HEX('f') }), error => ['EPOCH_CAPACITY_ACCEPTANCE_REQUIRED', 'EPOCH_PUBLISHED_POLICY_REQUIRED'].includes(error.code), 'even complete evidence still needs the control\'s capacity acceptance');
  assert.deepEqual(fs.readFileSync(x.controlFile), before, 'no refused transition touched the control: capabilities are unchanged');
  assert.equal(JSON.parse(before).capabilities.spend, false);
});
test('1/d: the lifted successor gate passes a context but is not a capability authority; the epoch\'s capabilities decide, and are off', () => {
  const gate = A.createSuccessorGate({ epoch: { financial_dir: '/x', capabilities: { spend: false, funding: false, buyer_return: false, reconcile: true } }, writer: {}, store: { getCapacityRecord: () => ({}) }, recoveryAnchors: { describe: c => c.descriptor },
    controlOf: () => ({ checksum: HEX('2'), successorOf: { generationId: HEX('1') } }), successorState: () => ({ status: 'claimed', authority: null, lifted: () => true }) });
  assert.equal(gate.assertAllows({ action: 'new_spend', anchor: null }), true, 'the successor restriction is gone');
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'money-control.js'), 'utf8');
  assert.equal(/\.capabilities\b/.test(source), false, 'money-control never reads epoch capabilities: they are enforced at the route/handler boundary and by transitionEpoch');
});
