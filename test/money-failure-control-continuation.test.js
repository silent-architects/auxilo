'use strict';
// A2 MONEY lane, lib/money-failure-control.js (v3 4.2-4.4, test 6.8): the specific durable gate and its precedence.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { digest } = require('../lib/money-control-store'), fmod = () => require('../lib/money-failure-control');
const SPECIFIC = 'CONTINUATION_AUTHORITY_REQUIRED';
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'failure-continuation-'))); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const epoch = { epoch_id: 'failure-test', binding_digest: 'a'.repeat(64), financial_dir: dir, legacy_root: dir, platform_account_id: 'acct_test', livemode: false };
  const writer = require('../lib/money-writer-lock').injectMoneyWriter({ root: dir, assertOwned: () => true });
  let root; const operations = new Map(), spends = new Map();
  const source = { id: 's', accountId: 'buyer', input_digest: 'b'.repeat(64), epoch_id: epoch.epoch_id, binding_digest: epoch.binding_digest, platform_account_id: epoch.platform_account_id, livemode: false };
  const store = { epoch, descriptor: { database_id: 'db-test' }, readMetadata: () => ({ database_id: 'db-test', revision: 0 }), getCapacityRecord: id => id === 'capacity:root' ? root : undefined, getOperation: id => operations.get(id), getSource: () => source, getSpend: id => spends.get(id), atomicCapacityStatus: () => ({ ready: true }) };
  root = { id: 'capacity:root', failureControl: fmod().initializeFailureControl({ epoch, writer, store }) };
  const anchors = require('../lib/money-recovery-anchor').createRecoveryAnchors({ epoch, writer, store });
  const op = id => { operations.set(id, { id, sourceId: 's', accountId: 'buyer', epoch_id: epoch.epoch_id, binding_digest: epoch.binding_digest, platform_account_id: epoch.platform_account_id, livemode: false, state: 'dispatch_intent', clientRequestKey: id, provider_payload: { amount: 1 }, provider_payload_digest: digest({ amount: 1 }), provider_request_digest: 'c'.repeat(64), idempotency_key: 'k' + id, quoteHash: 'd'.repeat(64) }); return anchors.resolveCommittedAnchor({ kind: 'dispatch_operation', id }); };
  const spendAnchor = id => { const intent = { id, accountId: 'buyer', draws: [{ sourceId: 's', amountMicros: 1 }] }; spends.set(id, { id, accountId: 'buyer', intent, digest: digest(intent), draws: [{ sourceId: 's' }], state: 'acknowledged' }); return anchors.resolveCommittedAnchor({ kind: 'spend', id, accountId: 'buyer' }); };
  return { dir, epoch, op, spendAnchor, anchors, open: () => fmod().openFailureControl({ epoch, writer, store, anchors }), file: path.join(dir, fmod().FILE) };
}
const note = (m, anchor, reason, extra = {}) => m.noteFailure({ anchor, reason, phase: 'boot_recovery', cutStatus: 'verified', ...extra });

test('A: idle -> the specific gate is recorded as the first failure with its reason', t => {
  const f = fixture(t), m = f.open(), a = f.op('a');
  assert.equal(m.statusDetail().state, 'idle');
  note(m, a, SPECIFIC);
  const d = m.statusDetail();
  assert.deepEqual({ state: d.state, reason: d.reason, phase: d.phase, cutStatus: d.cutStatus, kind: d.anchor.kind, id: d.anchor.id }, { state: 'failure_pending', reason: SPECIFIC, phase: 'boot_recovery', cutStatus: 'verified', kind: 'dispatch_operation', id: 'a' });
  assert.equal(m.status().available, false);
  assert.deepEqual(Object.keys(m.status()).sort(), ['anchor', 'available', 'compensation', 'scan', 'sequence', 'state'], 'status() keeps its shape (Q8)');
  assert.equal(fs.statSync(f.file).size, 8192);
});
test('B: failure_pending RECOVERY_REQUIRED / verified on the same anchor is upgraded in place; phase, cut status and anchor are untouched', t => {
  const f = fixture(t), m = f.open(), a = f.op('a');
  note(m, a, 'RECOVERY_REQUIRED');
  const before = m.statusDetail();
  note(m, a, SPECIFIC, { cutStatus: 'unverified' });
  const after = m.statusDetail();
  assert.equal(after.reason, SPECIFIC);
  assert.equal(after.sequence, before.sequence + 1);
  assert.equal(after.cutStatus, before.cutStatus);
  assert.equal(after.phase, before.phase);
  assert.deepEqual(after.anchor, before.anchor);
});
test('C: the same anchor held as unverified MANDATORY_WRITE_FAILED is upgraded even when the cut status is equal', t => {
  const f = fixture(t), m = f.open(), a = f.op('a');
  note(m, a, 'MANDATORY_WRITE_FAILED', { cutStatus: 'unverified', phase: 'persist_result' });
  const before = m.statusDetail();
  note(m, a, SPECIFIC, { cutStatus: 'unverified', phase: 'persist_result' });
  assert.equal(m.statusDetail().reason, SPECIFIC);
  assert.equal(m.statusDetail().sequence, before.sequence + 1);
});
test('D: a present specific gate is never downgraded or rewritten: repeat boots add no writes and the sequence is stable', t => {
  const f = fixture(t), m = f.open(), a = f.op('a');
  note(m, a, SPECIFIC);
  const sequence = m.statusDetail().sequence, bytes = fs.readFileSync(f.file);
  for (const [reason, cutStatus] of [[SPECIFIC, 'verified'], [SPECIFIC, 'unverified'], ['MANDATORY_WRITE_FAILED', 'unverified'], ['MANDATORY_WRITE_FAILED', 'verified'], ['RECOVERY_REQUIRED', 'verified']]) {
    const result = note(m, a, reason, { cutStatus });
    assert.equal(result.retained_first, true, reason + '/' + cutStatus);
  }
  assert.equal(m.statusDetail().sequence, sequence);
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  const reopened = f.open();
  assert.equal(reopened.statusDetail().sequence, sequence, 'a cold re-open and a second boot write nothing');
  note(reopened, a, SPECIFIC);
  assert.equal(reopened.statusDetail().sequence, sequence);
});
test('a specific request never overwrites another specific meaning of the same anchor (PROVIDER_OUTCOME_UNKNOWN, FAILED_DELIVERY...)', t => {
  const f = fixture(t), m = f.open(), a = f.op('a');
  note(m, a, 'PROVIDER_OUTCOME_UNKNOWN', { cutStatus: 'unverified' });
  const sequence = m.statusDetail().sequence;
  assert.equal(note(m, a, SPECIFIC, { cutStatus: 'verified' }).retained_first, true);
  assert.equal(m.statusDetail().reason, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(m.statusDetail().sequence, sequence);
});
test('E: a different held anchor keeps first-failure retention untouched; the diagnostic is carried by statusDetail', t => {
  const f = fixture(t), m = f.open(), a = f.op('a'), b = f.op('b');
  note(m, a, 'MANDATORY_WRITE_FAILED', { cutStatus: 'verified' });
  const before = m.checkpointProof();
  const result = note(m, b, SPECIFIC);
  assert.equal(result.retained_first, true);
  assert.equal(m.checkpointProof().slotDigest, before.slotDigest);
  assert.equal(m.statusDetail().anchor.id, 'a');
  assert.equal(m.statusDetail().reason, 'MANDATORY_WRITE_FAILED');
});
test('F: compensation_requested is retained for every request, same anchor or not', t => {
  const f = fixture(t), m = f.open(), spend = f.spendAnchor('spend-1'), descriptor = f.anchors.describe(spend);
  const file = f.file, bytes = fs.readFileSync(file), part = bytes.subarray(0, 4096), row = JSON.parse(part.subarray(0, part.indexOf(0))), { checksum, ...body } = row;
  const crafted = { ...body, sequence: 1, previousSlotDigest: checksum, state: 'compensation_requested', reason: 'FAILED_DELIVERY_RECONCILIATION_REQUIRED', phase: 'compensate', anchor: descriptor, cutStatus: 'verified',
    compensation: { spendId: 'spend-1', spendDigest: digest({ id: 'spend-1', accountId: 'buyer', draws: [{ sourceId: 's', amountMicros: 1 }] }), walId: null, walPayloadDigest: null, earningsBeforeDigest: 'e'.repeat(64), earningsFileIdentity: { dev: 1, ino: 2 }, drawVectorDigest: 'd'.repeat(64), noAccrualProofDigest: 'f'.repeat(64) } };
  const encoded = Buffer.from(JSON.stringify({ ...crafted, checksum: digest(crafted) }));
  const out = Buffer.alloc(4096); encoded.copy(out);
  const fd = fs.openSync(file, 'r+'); try { fs.writeSync(fd, out, 0, 4096, 4096); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const held = f.open(), sequence = held.statusDetail().sequence;
  assert.equal(held.statusDetail().state, 'compensation_requested');
  assert.equal(note(held, spend, SPECIFIC).retained_first, true);
  assert.equal(note(held, f.op('c'), SPECIFIC).retained_first, true);
  assert.equal(held.statusDetail().sequence, sequence);
  assert.equal(held.statusDetail().reason, 'FAILED_DELIVERY_RECONCILIATION_REQUIRED');
});
test('the reason list is closed: an unlisted reason is still refused, and a recovery_scan slot cannot carry the specific reason', t => {
  const f = fixture(t), m = f.open(), a = f.op('a');
  assert.throws(() => note(m, a, 'caller invented'), { code: 'FAILURE_CONTROL_SCHEMA' });
  assert.throws(() => note(m, a, undefined, { reason: 'NOT_A_REASON' }), { code: 'FAILURE_CONTROL_SCHEMA' });
  m.beginRecoveryScan();
  assert.equal(m.statusDetail().state, 'recovery_scan');
  assert.equal(m.statusDetail().reason, 'RECOVERY_REQUIRED');
  note(m, a, SPECIFIC);
  assert.equal(m.statusDetail().state, 'failure_pending', 'a scan hands over to a failure_pending slot that may carry the specific reason');
  assert.equal(m.statusDetail().reason, SPECIFIC);
});
