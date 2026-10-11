'use strict';
// Ruling 1 (fixture observation correction): the stamped helper's snapshot() reports the failure control as persisted BEFORE it opens the runtime
// (opening starts a recovery scan and would overwrite idle). Invalid or missing evidence fails the snapshot; nothing is drained or written.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const h = require('./helpers/money-admitted-restore-fixture'), p = require('../lib/stripe-transfer-persistence'), lock = require('../lib/money-writer-lock');
const { HEX, syntheticEpoch } = require('./helpers/money-synthetic-epoch');
const code = c => error => error.code === c;

function world(t) {
  const x = syntheticEpoch(t), databaseId = 'db-synthetic-0001', file = path.join(x.dir, 'money-first-failure-control.bin');
  fs.writeFileSync(path.join(x.dir, 'money-control.json'), JSON.stringify({ schema: 2, database_id: databaseId }));
  const body = (sequence, patch = {}) => ({ schema: 1, epoch_id: x.binding.identity.epoch_id, binding_digest: x.binding.binding_digest, database_id: databaseId, sequence, previousSlotDigest: sequence === 0 ? null : HEX('0'), state: 'idle', reason: null, phase: null, anchor: null, cutStatus: null, compensation: null, scan: null, lastResolved: null, ...patch });
  const encode = b => { const out = Buffer.alloc(4096); Buffer.from(JSON.stringify({ ...b, checksum: p.digestJSON(b) })).copy(out); return out; };
  const checksum = b => p.digestJSON(b);
  const write = (a, b) => fs.writeFileSync(file, Buffer.concat([a ?? Buffer.alloc(4096), b ?? Buffer.alloc(4096)]), { mode: 0o600 });
  return { ...x, file, body, encode, checksum, write, databaseId };
}
const scanBody = (w, sequence, previous) => w.body(sequence, { state: 'recovery_scan', reason: 'RECOVERY_REQUIRED', phase: 'boot_recovery', cutStatus: 'verified', scan: { schema: 1, phase: 'submitted_checkout', afterSequence: null, afterId: null, cutRevision: 1, walManifestDigest: null }, previousSlotDigest: previous });

test('the captured state is the persisted pre-open state, with the shape the test reads', t => {
  const w = world(t), idle = w.body(4);
  w.write(null, w.encode(idle));
  const got = h.persistedFailureControl(w.root);
  assert.equal(got.state, 'idle');
  assert.equal(got.sequence, 4);
  for (const key of ['anchor', 'compensation', 'scan']) assert.ok(Object.hasOwn(got, key), key);
  // opening a runtime would now start a scan; the capture is a read and the residue is only what a LATER read sees
  w.write(w.encode(scanBody(w, 5, w.checksum(idle))), w.encode(idle));
  assert.equal(h.persistedFailureControl(w.root).state, 'recovery_scan');
});
test('snapshot() captures the failure control BEFORE it opens the runtime', t => {
  const w = world(t), spy = [], realRead = fs.readFileSync, realAcquire = lock.acquireMoneyWriter;
  w.write(null, w.encode(w.body(2)));
  fs.readFileSync = function (file, ...rest) { if (String(file).endsWith('money-first-failure-control.bin')) spy.push('capture'); return realRead.call(this, file, ...rest); };
  lock.acquireMoneyWriter = () => { spy.push('open'); throw new Error('STOP_AT_OPEN'); };
  try { assert.throws(() => h.snapshot(w.root, 'wal'), /STOP_AT_OPEN/); } finally { fs.readFileSync = realRead; lock.acquireMoneyWriter = realAcquire; }
  assert.deepEqual(spy, ['capture', 'open']);
});
test('sequence selection picks the newer valid slot, in either position', t => {
  const w = world(t), older = w.body(6), newer = scanBody(w, 7, w.checksum(older));
  w.write(w.encode(newer), w.encode(older));
  assert.equal(h.persistedFailureControl(w.root).sequence, 7);
  w.write(w.encode(older), w.encode(newer));
  assert.equal(h.persistedFailureControl(w.root).state, 'recovery_scan');
  w.write(w.encode(older), null);
  assert.equal(h.persistedFailureControl(w.root).sequence, 6, 'a lone valid slot');
});
test('a tampered checksum is refused: both slots torn fails; one torn slot falls back to the other as the runtime does (a body edit never validates)', t => {
  const w = world(t), older = w.body(6), newer = scanBody(w, 7, w.checksum(older)), good = w.encode(older), bad = w.encode(newer);
  bad.write('X', 5);
  w.write(bad, good);
  assert.equal(h.persistedFailureControl(w.root).sequence, 6, 'the torn newest slot is ignored exactly like the runtime ignores it');
  const worse = w.encode(older); worse.write('Y', 7);
  w.write(bad, worse);
  assert.throws(() => h.persistedFailureControl(w.root), code('FAILURE_CONTROL_EVIDENCE_INVALID'));
  w.write(null, null);
  assert.throws(() => h.persistedFailureControl(w.root), code('FAILURE_CONTROL_EVIDENCE_INVALID'));
  const edited = JSON.parse(w.encode(newer).subarray(0, 4096).toString().replace(/\0+$/, '')); edited.state = 'idle';
  const forged = Buffer.alloc(4096); Buffer.from(JSON.stringify(edited)).copy(forged);
  w.write(forged, null);
  assert.throws(() => h.persistedFailureControl(w.root), code('FAILURE_CONTROL_EVIDENCE_INVALID'), 'edited body, stale checksum');
});
test('wrong identity is refused: epoch, binding, database; unknown keys and a broken slot chain too', t => {
  const w = world(t);
  for (const patch of [{ epoch_id: 'other-epoch' }, { binding_digest: HEX('f') }, { database_id: 'someone-else' }]) {
    w.write(null, w.encode(w.body(3, patch)));
    assert.throws(() => h.persistedFailureControl(w.root), error => error.code === 'FAILURE_CONTROL_EVIDENCE_INVALID' && /identity/.test(error.message), JSON.stringify(patch));
  }
  w.write(null, w.encode({ ...w.body(3), extra: 1 }));
  assert.throws(() => h.persistedFailureControl(w.root), error => /schema/.test(error.message));
  const a = w.body(5), b = w.body(6, { previousSlotDigest: HEX('9') });
  w.write(w.encode(b), w.encode(a));
  assert.throws(() => h.persistedFailureControl(w.root), error => /chain/.test(error.message), 'slot 6 does not chain to slot 5');
  w.write(w.encode(w.body(5)), w.encode(scanBody(w, 5, HEX('1'))));
  assert.throws(() => h.persistedFailureControl(w.root), error => /chain/.test(error.message), 'same sequence, different content');
});
test('missing or short evidence fails the snapshot with a clear code, and nothing is written', t => {
  const w = world(t);
  assert.throws(() => h.persistedFailureControl(w.root), code('FAILURE_CONTROL_EVIDENCE_MISSING'));
  fs.writeFileSync(w.file, Buffer.alloc(4096));
  assert.throws(() => h.persistedFailureControl(w.root), code('FAILURE_CONTROL_EVIDENCE_INVALID'));
  assert.equal(fs.statSync(w.file).size, 4096, 'read-only');
});

// ---- closure item 1: a checksum-VALID but semantically INVALID slot is refused, never skipped for an older slot ----------------
const fc = require('../lib/money-failure-control');
function states(w) {
  const anchor = { schema: 1, kind: 'spend', id: 'spend_1', continuation: null, namespace: null, observationId: null, immutableDigest: HEX('a'), accountDigest: null, sourceDigest: null, epoch_id: w.x.binding.identity.epoch_id, binding_digest: w.x.binding.binding_digest, database_id: w.databaseId };
  const scan = { schema: 1, phase: 'submitted_checkout', afterSequence: null, afterId: null, cutRevision: 1, walManifestDigest: null };
  const comp = { spendId: 'spend_1', spendDigest: HEX('b'), walId: null, walPayloadDigest: null, earningsBeforeDigest: HEX('c'), earningsFileIdentity: { dev: 1, ino: 2 }, drawVectorDigest: HEX('d'), noAccrualProofDigest: HEX('e') };
  return {
    valid: {
      idle: {},
      failure_pending: { state: 'failure_pending', reason: 'CONTINUATION_AUTHORITY_REQUIRED', phase: 'boot_recovery', anchor, cutStatus: 'verified' },
      recovery_scan: { state: 'recovery_scan', reason: 'RECOVERY_REQUIRED', phase: 'boot_recovery', cutStatus: 'verified', scan },
      compensation_requested: { state: 'compensation_requested', reason: 'FAILED_DELIVERY_RECONCILIATION_REQUIRED', phase: 'compensate', anchor, cutStatus: 'verified', compensation: comp }
    },
    invalid: {
      'idle with a reason': { reason: 'RECOVERY_REQUIRED' },
      'idle with an anchor': { anchor },
      'idle with a scan': { scan },
      'failure_pending without an anchor': { state: 'failure_pending', reason: 'RECOVERY_REQUIRED', phase: 'boot_recovery', cutStatus: 'verified' },
      'failure_pending without a reason': { state: 'failure_pending', phase: 'boot_recovery', anchor, cutStatus: 'verified' },
      'failure_pending carrying a scan': { state: 'failure_pending', reason: 'RECOVERY_REQUIRED', phase: 'boot_recovery', anchor, cutStatus: 'verified', scan },
      'unknown reason': { state: 'failure_pending', reason: 'CALLER_INVENTED', phase: 'boot_recovery', anchor, cutStatus: 'verified' },
      'recovery_scan without a scan': { state: 'recovery_scan', reason: 'RECOVERY_REQUIRED', phase: 'boot_recovery', cutStatus: 'verified' },
      'recovery_scan with an unknown phase': { state: 'recovery_scan', reason: 'RECOVERY_REQUIRED', phase: 'boot_recovery', cutStatus: 'verified', scan: { ...scan, phase: 'elsewhere' } },
      'compensation_requested without a compensation': { state: 'compensation_requested', reason: 'FAILED_DELIVERY_RECONCILIATION_REQUIRED', phase: 'compensate', anchor, cutStatus: 'verified' },
      'compensation_requested for a dispatch anchor': { state: 'compensation_requested', reason: 'FAILED_DELIVERY_RECONCILIATION_REQUIRED', phase: 'compensate', anchor: { ...anchor, kind: 'dispatch_operation' }, cutStatus: 'verified', compensation: comp },
      'unknown state': { state: 'maybe' }
    }
  };
}
test('every runtime-valid state shape is accepted by the capture (the semantic check is not stricter than the runtime)', t => {
  const w = world(t); w.x = w;
  for (const [name, patch] of Object.entries(states(w).valid)) {
    w.write(null, w.encode(w.body(3, patch)));
    assert.equal(h.persistedFailureControl(w.root).state, patch.state || 'idle', name);
    assert.doesNotThrow(() => fc.validateBody(w.body(3, patch)), name);
  }
});
test('a checksum-valid but semantically invalid slot is REFUSED even when an older valid slot exists; it is never skipped', t => {
  const w = world(t); w.x = w;
  const older = w.body(6);
  for (const [name, patch] of Object.entries(states(w).invalid)) {
    const newest = w.body(7, { ...patch, previousSlotDigest: w.checksum(older) });
    assert.notEqual(w.checksum(newest), undefined);
    w.write(w.encode(newest), w.encode(older));
    assert.throws(() => h.persistedFailureControl(w.root), error => error.code === 'FAILURE_CONTROL_EVIDENCE_INVALID', name + ' (newest, older valid)');
    w.write(w.encode(older), w.encode(newest));
    assert.throws(() => h.persistedFailureControl(w.root), error => error.code === 'FAILURE_CONTROL_EVIDENCE_INVALID', name + ' (other position)');
    if (name !== 'unknown state') assert.throws(() => fc.validateBody(newest), name + ' is also refused by the runtime validator itself'); // the state set is checked by select(), mirrored in the capture
  }
});
test('a torn (checksum-invalid) newest slot still falls back to the valid older one, and the older state is reported', t => {
  const w = world(t); w.x = w;
  const older = w.body(6, states(w).valid.failure_pending), newest = w.encode(w.body(7, { ...states(w).valid.recovery_scan, previousSlotDigest: w.checksum(older) }));
  newest.write('TORN', 3);
  w.write(newest, w.encode(older));
  const got = h.persistedFailureControl(w.root);
  assert.equal(got.sequence, 6);
  assert.equal(got.state, 'failure_pending');
});
