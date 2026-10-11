'use strict';
// A2 MONEY lane (Addendum 1 A1, test 1.5): the successor gate predicate, its four wiring points in lib/money-control.js,
// EPOCH_RETIRED ahead of everything, the specific durable gate with its stderr line, and the operator's transition gate.
// Pure JS: the epoch control, the successor state and the failure control are stubs; the physical restore is native.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const proxyquire = require('proxyquire').noCallThru(), real = require('../lib/financial-epoch'), A = require('../lib/money-continuation-authority'), lock = require('../lib/money-writer-lock');
const { HEX, syntheticEpoch, retirementIdentity } = require('./helpers/money-synthetic-epoch');
const code = c => error => error.code === c;

const plan = { continuationEarnings: { entries: [{ spendId: 'spend_1', walId: 'wal_1' }] }, compensationEarnings: { spendId: 'spend_c', walId: 'wal_c' } };
const AUTHORITY = A.recoveryAuthoritySet(plan);
const anchorsFor = () => ({ describe: cap => cap.descriptor });
const cap = (kind, id) => ({ descriptor: { kind, id } });
function gateWith({ control = null, status = 'none', lifted = false } = {}) {
  const calls = [];
  const gate = A.createSuccessorGate({
    epoch: { financial_dir: '/x' }, writer: {}, store: { getCapacityRecord: () => ({ id: 'capacity:root' }) }, recoveryAnchors: anchorsFor(),
    controlOf: () => control, successorState: args => { calls.push(args); return { status, authority: status === 'claimed' ? AUTHORITY : null, lifted: () => lifted }; }
  });
  return { gate, calls };
}
const successorControl = { checksum: HEX('2'), successorOf: { generationId: HEX('1') } };

test('retired: EPOCH_RETIRED regardless of anything else; an ordinary or successor control is not retired', () => {
  assert.throws(() => gateWith({ control: { retirement: {} } }).gate.assertNotRetired(), code('EPOCH_RETIRED'));
  assert.doesNotThrow(() => gateWith({ control: null }).gate.assertNotRetired());
  assert.doesNotThrow(() => gateWith({ control: successorControl }).gate.assertNotRetired());
  assert.doesNotThrow(() => gateWith({ control: { checksum: HEX('3') } }).gate.assertNotRetired());
});
test('status none (every existing path): passes and never even reads the restore', () => {
  const x = gateWith({ control: { checksum: HEX('3') } });
  assert.equal(x.gate.assertAllows({ action: 'persist_result' }), true);
  assert.equal(x.calls.length, 0, 'an ordinary epoch pays only the control read');
  assert.equal(gateWith({ control: null }).gate.assertAllows({ action: 'new_spend' }), true);
});
test('unclaimed refuses every action, including reconciliation, compensation and provider submission', () => {
  const x = gateWith({ control: successorControl, status: 'unclaimed' });
  for (const action of ['optional', 'persist_result', 'participant_effect', 'provider_submit', 'provider_reconcile', 'compensate', 'boot_recovery', 'new_funding', 'new_spend']) {
    assert.throws(() => x.gate.assertAllows({ action, anchor: cap('spend', 'spend_1') }), code('EPOCH_SUCCESSOR_UNCLAIMED'), action);
  }
});
test('claimed passes only boot_recovery or compensate on a spend/unlock_wal anchor inside RS; everything else needs activation', () => {
  const x = gateWith({ control: successorControl, status: 'claimed' }), ok = (action, anchor) => assert.equal(x.gate.assertAllows({ action, anchor }), true, action + ' ' + JSON.stringify(anchor?.descriptor));
  ok('boot_recovery', cap('spend', 'spend_1'));
  ok('boot_recovery', cap('unlock_wal', 'wal_1'));
  ok('compensate', cap('spend', 'spend_c'));
  ok('compensate', cap('unlock_wal', 'wal_c'));
  const refuse = (action, anchor) => assert.throws(() => x.gate.assertAllows({ action, anchor }), code('EPOCH_SUCCESSOR_ACTIVATION_REQUIRED'), action + ' ' + JSON.stringify(anchor?.descriptor));
  refuse('boot_recovery', cap('spend', 'spend_2'));
  refuse('boot_recovery', cap('unlock_wal', 'wal_2'));
  refuse('boot_recovery', cap('projection', 'spend_1'));
  refuse('boot_recovery', cap('spend', 'wal_1'));
  refuse('persist_result', cap('spend', 'spend_1'));
  refuse('participant_effect', cap('spend', 'spend_1'));
  refuse('provider_reconcile', cap('spend', 'spend_1'));
  refuse('provider_submit', cap('spend', 'spend_1'));
  refuse('new_spend', undefined);
  refuse('boot_recovery', null);
  refuse('optional', null);
});
test('claimed is lifted only when the activation reports lifted (reconciled barrier); then ordinary rules apply', () => {
  const x = gateWith({ control: successorControl, status: 'claimed', lifted: true });
  assert.equal(x.gate.assertAllows({ action: 'new_spend', anchor: null }), true);
});

// ---- wiring inside lib/money-control.js -----------------------------------------------------------------------
function harness(t, { status = 'none', retired = false, retiredAfter = Infinity, failure = {} } = {}) {
  const x = syntheticEpoch(t), epoch = { epoch_id: 'epoch-a2', binding_digest: x.binding.binding_digest, financial_dir: x.dir, legacy_root: x.root, activation_revision: 0 };
  const log = [], state = { status, retired, step: 0 };
  const gate = {
    assertNotRetired() { log.push('retired?'); if (state.retired) throw Object.assign(Error('EPOCH_RETIRED'), { code: 'EPOCH_RETIRED' }); },
    assertAllows(input) { log.push(['allows', input.action, input.anchor?.descriptor?.id ?? null]); if (state.status === 'unclaimed') throw Object.assign(Error('EPOCH_SUCCESSOR_UNCLAIMED'), { code: 'EPOCH_SUCCESSOR_UNCLAIMED' }); if (state.status === 'claimed' && !(['boot_recovery', 'compensate'].includes(input.action) && input.anchor?.descriptor?.id === 'spend_1')) throw Object.assign(Error('EPOCH_SUCCESSOR_ACTIVATION_REQUIRED'), { code: 'EPOCH_SUCCESSOR_ACTIVATION_REQUIRED' }); return true; }
  };
  const noted = [];
  const manager = {
    assertNewEffectAllowed() {}, assertRecoveryAllowed() { return true; }, status: () => ({ state: 'idle' }), statusDetail: () => ({ anchor: { kind: 'spend', id: 'spend_1' } }), resolveCompletedFailure() {}, scanRecoveryPage() {}, beginRecoveryScan() {},
    noteFailure(input) { noted.push(input); return failure.result ?? { state: 'failure_pending' }; }
  };
  const anchors = { revalidate: c => c, describe: c => c.descriptor, restore: c => c, isResolved: () => false };
  const store = {
    epoch, descriptor: { database_id: 'db-synthetic-0001' }, uncertain: false, getCapacityRecord: id => id === 'capacity:root' ? { profile: { grouped: { commitProtocol: 'single_sql_v1' } } } : undefined,
    transaction: async fn => fn({ repository: {} }, { revision: 0, sequence: 0 }), transactionSync: fn => fn({ repository: {} }, { revision: 0, sequence: 0 })
  };
  const mod = proxyquire('../lib/money-control', {
    './money-continuation-authority': { createSuccessorGate: () => gate },
    './money-recovery-anchor': { createRecoveryAnchors: () => anchors },
    './money-failure-control': { openFailureControl: () => manager },
    './money-capacity': { createCapacityManager: () => ({}) }
  });
  const control = mod.createMoneyControl({ store, epoch, writer: x.writer, capacityRequired: false });
  return { control, log, noted, state, cap: id => ({ descriptor: { kind: 'spend', id } }), epoch };
}
test('wiring E1: withMoneyControl checks retirement then the successor gate with the context action and anchor', async t => {
  const h = harness(t);
  await h.control.withMoneyControl({ kind: 'spend', action: 'persist_result', recoveryAnchor: h.cap('spend_1') }, () => 1);
  assert.deepEqual(h.log.slice(0, 2), ['retired?', ['allows', 'persist_result', 'spend_1']]);
  h.log.length = 0;
  await h.control.withMoneyControl({ kind: 'funding' }, () => 1);
  assert.deepEqual(h.log[0], 'retired?');
  assert.deepEqual(h.log[1], ['allows', 'optional', null]);
});
test('wiring: a boot context checks retirement at ENTRY but not the successor gate (its effects hit E2-E4)', t => {
  const h = harness(t, { status: 'unclaimed' });
  assert.equal(h.control.withMoneyBootControl({ recoveryAnchor: h.cap('spend_1'), action: 'boot_recovery' }, () => 'booted'), 'booted', 'an unclaimed successor with nothing to recover still boots');
  assert.deepEqual(h.log, ['retired?']);
  h.log.length = 0;
  h.state.retired = true;
  assert.throws(() => h.control.withMoneyBootControl({}, () => 'never'), code('EPOCH_RETIRED'));
});
test('wiring E1: an unclaimed or claimed successor is refused at context entry before fn runs', async t => {
  for (const [status, expected] of [['unclaimed', 'EPOCH_SUCCESSOR_UNCLAIMED'], ['claimed', 'EPOCH_SUCCESSOR_ACTIVATION_REQUIRED']]) {
    const h = harness(t, { status });
    let ran = false;
    await assert.rejects(h.control.withMoneyControl({ kind: 'reconcile' }, () => { ran = true; }), code(expected), status);
    assert.equal(ran, false);
  }
});
test('wiring E2/E3/E4: registerRecoveryAnchor, assertFinancialEffect and the commit gate each consult the gate', async t => {
  const h = harness(t, { status: 'claimed' });
  await h.control.withMoneyBootControl({ recoveryAnchor: h.cap('spend_1'), action: 'boot_recovery' }, ctx => {
    h.log.length = 0;
    assert.equal(ctx.registerRecoveryAnchor(h.cap('spend_1'), { action: 'boot_recovery' }), true);
    assert.deepEqual(h.log.slice(0, 2), ['retired?', ['allows', 'boot_recovery', 'spend_1']], 'E2');
    h.log.length = 0;
    ctx.assertFinancialEffect('participant_effect');
    assert.deepEqual(h.log.slice(0, 2), ['retired?', ['allows', 'boot_recovery', 'spend_1']], 'E3 uses the registered action and anchor');
    h.log.length = 0;
    ctx.assertFinancialGate();
    assert.deepEqual(h.log.slice(0, 2), ['retired?', ['allows', 'boot_recovery', 'spend_1']], 'E4');
    assert.throws(() => ctx.registerRecoveryAnchor(h.cap('spend_2'), { action: 'boot_recovery' }), code('EPOCH_SUCCESSOR_ACTIVATION_REQUIRED'));
    assert.throws(() => ctx.registerRecoveryAnchor(h.cap('spend_1'), { action: 'persist_result' }), code('EPOCH_SUCCESSOR_ACTIVATION_REQUIRED'));
  });
});
test('wiring: an unclaimed successor refuses every financial effect even from a boot context', t => {
  const h = harness(t, { status: 'unclaimed' });
  h.control.withMoneyBootControl({ recoveryAnchor: h.cap('spend_1'), action: 'boot_recovery' }, ctx => {
    assert.throws(() => ctx.assertFinancialEffect('participant_effect'), code('EPOCH_SUCCESSOR_UNCLAIMED'));
    assert.throws(() => ctx.registerRecoveryAnchor(h.cap('spend_1'), { action: 'compensate' }), code('EPOCH_SUCCESSOR_UNCLAIMED'));
    assert.throws(() => ctx.assertFinancialGate(), code('EPOCH_SUCCESSOR_UNCLAIMED'));
  });
});
test('wiring: retirement is refused at the commit gate too, so a context open when R lands cannot commit', async t => {
  const h = harness(t);
  await assert.rejects(h.control.withMoneyControl({ kind: 'spend' }, ctx => { h.state.retired = true; ctx.assertFinancialGate(); }), code('EPOCH_RETIRED'));
});
test('specific durable gate: a CONTINUATION_AUTHORITY error records the specific reason and prints one diagnostic line; other errors keep the generic reason', t => {
  const writes = [], realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = chunk => { writes.push(String(chunk)); return true; };
  t.after(() => { process.stderr.write = realWrite; });
  const h = harness(t, { failure: { result: { retained_first: true, state: 'failure_pending' } } });
  const gateError = Object.assign(new Error('COMPENSATION_ACCRUAL_CONFLICT'), { code: 'COMPENSATION_ACCRUAL_CONFLICT' });
  for (const [key, value] of Object.entries({ gate: 'CONTINUATION_AUTHORITY', check: 'TARGET_IDENTITY', walId: 'wal_1', spendId: 'spend_1' })) Object.defineProperty(gateError, key, { value, enumerable: false });
  assert.throws(() => h.control.withMoneyBootControl({ recoveryAnchor: h.cap('spend_1'), action: 'boot_recovery' }, () => { throw gateError; }), error => error === gateError);
  assert.equal(h.noted.length, 1);
  assert.deepEqual({ reason: h.noted[0].reason, phase: h.noted[0].phase, cutStatus: h.noted[0].cutStatus }, { reason: 'CONTINUATION_AUTHORITY_REQUIRED', phase: 'boot_recovery', cutStatus: 'unverified' });
  assert.deepEqual(writes, ['[money-recovery] gate=CONTINUATION_AUTHORITY_REQUIRED wal=wal_1 spend=spend_1 check=TARGET_IDENTITY retained_first=true held_anchor=spend:spend_1\n']);
  writes.length = 0;
  const plain = Object.assign(new Error('COMPENSATION_ACCRUAL_CONFLICT'), { code: 'COMPENSATION_ACCRUAL_CONFLICT' });
  assert.throws(() => h.control.withMoneyBootControl({ recoveryAnchor: h.cap('spend_1'), action: 'boot_recovery' }, () => { throw plain; }), error => error === plain);
  assert.equal(h.noted[1].reason, 'MANDATORY_WRITE_FAILED', 'C3-D1/D2 style failures without the continuation gate keep the generic reason');
  assert.deepEqual(writes, []);
});

// ---- operator transition gate (Addendum 1 A1.3) ----------------------------------------------------------------------
function operatorFor(t, { control, status = 'none', lifted = false, barrier = null }) {
  const x = syntheticEpoch(t, { control });
  const current = { binding_digest: x.binding.binding_digest, financial_dir: x.dir, legacy_root: x.root, activation_revision: control.generation };
  if (barrier) fs.writeFileSync(path.join(x.root, 'money-restore-barrier.json'), JSON.stringify(real.seal(barrier)));
  const seen = [];
  const op = proxyquire('../lib/financial-epoch-operator', {
    './financial-epoch': { ...real, resolveRuntimeEpoch: () => current, requireEpoch: () => ({ binding: x.binding, control }) },
    './money-atomic-restore': { successorStatusFor: args => { seen.push(args); return status; }, barrierLifted: () => lifted }
  });
  return { x, op, seen, epoch: current };
}
const baseControl = (patch = {}) => { const { binding } = { binding: require('./helpers/money-synthetic-epoch').syntheticBinding() }; return real.seal({ schema_version: 2, binding_digest: binding.binding_digest, epoch_id: binding.identity.epoch_id, generation: 5, state: 'reconcile_only', capabilities: Object.fromEntries(real.CAPABILITIES.map(k => [k, k === 'reconcile'])), evidence: { reconcile: HEX('e') }, successorOf: { generationId: HEX('1') }, ...patch }); };
const transition = (o, patch) => o.op.transitionEpoch({ epoch: o.epoch, writer: o.x.writer, expectedRevision: 5, patch, evidence: { approval_ref: 'approval', reconcile: HEX('e'), funding: HEX('f'), spend: HEX('a') } });
test('operator gate: an unclaimed successor enables nothing, not even reconcile; disabling is still allowed', t => {
  const o = operatorFor(t, { control: baseControl(), status: 'unclaimed' }), before = fs.readFileSync(o.x.controlFile);
  for (const patch of [{ funding: true }, { spend: true }, { reconcile: true }]) assert.throws(() => transition(o, patch), code('EPOCH_SUCCESSOR_UNCLAIMED'), JSON.stringify(patch));
  assert.deepEqual(fs.readFileSync(o.x.controlFile), before, 'control bytes identical');
  assert.equal(o.seen.length, 3);
  assert.throws(() => transition(o, { reconcile: false }), code('EPOCH_RECONCILIATION_CANNOT_BE_DISABLED'), 'disabling reconcile keeps its own refusal');
  assert.equal(o.seen.length, 3, 'no read for a patch that enables nothing');
  assert.doesNotThrow(() => transition(o, { funding: false }), 'false values pass the successor gate');
  assert.equal(o.seen.length, 3);
});
test('operator gate: a claimed successor refuses non-recovery capabilities until the barrier is reconciled; ordinary controls never open the store', t => {
  const claimed = operatorFor(t, { control: baseControl(), status: 'claimed', lifted: false });
  assert.throws(() => transition(claimed, { spend: true }), code('EPOCH_SUCCESSOR_ACTIVATION_REQUIRED'));
  assert.throws(() => transition(claimed, { funding: true, reconcile: true }), code('EPOCH_SUCCESSOR_ACTIVATION_REQUIRED'));
  const lifted = operatorFor(t, { control: baseControl(), status: 'claimed', lifted: true, barrier: { schema_version: 1, state: 'reconciled', capacity_recreation_required: false } });
  assert.doesNotThrow(() => transition(lifted, { funding: false }));
  const { successorOf, ...rest } = baseControl(), plain = operatorFor(t, { control: real.seal({ ...rest, schema_version: 1 }) });
  assert.throws(() => transition(plain, { funding: true }), error => !['EPOCH_SUCCESSOR_UNCLAIMED', 'EPOCH_SUCCESSOR_ACTIVATION_REQUIRED'].includes(error.code));
  assert.equal(plain.seen.length, 0, 'no successorOf, no store, no restore read');
});
test('operator gate: a retired source refuses every capability transition', t => {
  const { syntheticBinding } = require('./helpers/money-synthetic-epoch');
  const binding = syntheticBinding(), paused = { schema_version: 2, binding_digest: binding.binding_digest, epoch_id: binding.identity.epoch_id, generation: 5, state: 'paused', capabilities: Object.fromEntries(real.CAPABILITIES.map(k => [k, false])), evidence: {}, retirement: real.buildRetirement(retirementIdentity({ retiredAtGeneration: 5 })) };
  const o = operatorFor(t, { control: real.seal(paused) });
  for (const patch of [{ funding: true }, { reconcile: true }, { funding: false }]) assert.throws(() => transition(o, patch), code('EPOCH_RETIRED'), JSON.stringify(patch));
});
