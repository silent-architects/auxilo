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
  w.write(w.encode(w.body(5)), w.encode(w.body(5, { state: 'recovery_scan' })));
  assert.throws(() => h.persistedFailureControl(w.root), error => /chain/.test(error.message), 'same sequence, different content');
});
test('missing or short evidence fails the snapshot with a clear code, and nothing is written', t => {
  const w = world(t);
  assert.throws(() => h.persistedFailureControl(w.root), code('FAILURE_CONTROL_EVIDENCE_MISSING'));
  fs.writeFileSync(w.file, Buffer.alloc(4096));
  assert.throws(() => h.persistedFailureControl(w.root), code('FAILURE_CONTROL_EVIDENCE_INVALID'));
  assert.equal(fs.statSync(w.file).size, 4096, 'read-only');
});
