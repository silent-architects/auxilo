'use strict';
// The native A2 fixture reads durable state without side effects. These pure-JS tests pin the two shapes the first native
// runs tripped on: the restore control while a restore is still initializing (it lives in the .stage-restore-control-<id> file,
// not in the fixed file), and the failure control as the server left it (the fixture's own open() starts a scan).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const N = require('./helpers/money-continuation-native-fixture'), R = require('../lib/money-atomic-restore'), p = require('../lib/stripe-transfer-persistence');
const { HEX, syntheticEpoch } = require('./helpers/money-synthetic-epoch');
const claim = { schema: 1, state: 'recorded', restoreId: HEX('a'), generationId: HEX('1'), initializationDigest: HEX('5'), checkpointDigest: HEX('c'), successorDigest: HEX('6') };
function writeRestoreControl(file, body) {
  const bytes = Buffer.alloc(R.SLOT * 2);
  R.encodeControl(body).copy(bytes, (body.sequence % 2) * R.SLOT);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
}
const restoreBody = (patch = {}) => ({ schema: 1, protocol: 'atomic_restore_v1', sequence: 3, restoreId: HEX('a'), phase: 'initializing', control: { dev: 1, ino: 1 }, plan: null, ...patch });

test('readControls: while a restore is initializing the control is the staged file, and the staged file wins over a predecessor copy', t => {
  const x = syntheticEpoch(t), staged = path.join(x.dir, '.stage-restore-control-' + HEX('a')), fixed = path.join(x.dir, 'money-atomic-restore-control.bin');
  assert.equal(N.readControls(x.root).restore, undefined, 'no restore control at all');
  writeRestoreControl(staged, restoreBody({ claim }));
  const initializing = N.readControls(x.root).restore;
  assert.equal(initializing.phase, 'initializing');
  assert.deepEqual(initializing.claim, claim, 'the claim is readable from the staged control after a crash cut (the first native runs read undefined here)');
  assert.equal(initializing.plan, null);
  writeRestoreControl(fixed, restoreBody({ restoreId: HEX('9'), phase: 'complete', sequence: 8 }));
  assert.equal(N.readControls(x.root).restore.restoreId, HEX('a'), 'a predecessor copy in the fixed file does not hide the current restore');
  fs.rmSync(staged);
  assert.equal(N.readControls(x.root).restore.restoreId, HEX('9'), 'once published the fixed file is the control');
  assert.equal(N.readControls(x.root).restore.claim, null);
});
test('rawFailureControl: highest valid sequence wins, a torn or corrupt slot is ignored, absence is null', t => {
  const x = syntheticEpoch(t), file = path.join(x.dir, 'money-first-failure-control.bin');
  assert.equal(N.rawFailureControl(x.root), null);
  const slot = body => { const out = Buffer.alloc(4096); Buffer.from(JSON.stringify({ ...body, checksum: p.digestJSON(body) })).copy(out); return out; };
  const idle = { sequence: 4, state: 'idle', reason: null }, scan = { sequence: 5, state: 'recovery_scan', reason: 'RECOVERY_REQUIRED' };
  fs.writeFileSync(file, Buffer.concat([slot(scan), slot(idle)]), { mode: 0o600 });
  assert.equal(N.rawFailureControl(x.root).state, 'recovery_scan');
  const torn = Buffer.concat([slot(scan), slot(idle)]); torn.write('BROKEN', 0);
  assert.equal(N.rawFailureControl(x.root).state === 'recovery_scan', true, 'file not rewritten yet');
  fs.writeFileSync(file, torn);
  assert.equal(N.rawFailureControl(x.root).state, 'idle');
  fs.writeFileSync(file, Buffer.alloc(8192));
  assert.equal(N.rawFailureControl(x.root), null);
});
test('withRawFailure reads the failure control BEFORE the snapshot opens the runtime, so the snapshot\'s own scan start is not reported (strict idle kept)', t => {
  const x = syntheticEpoch(t), file = path.join(x.dir, 'money-first-failure-control.bin');
  const slot = body => { const out = Buffer.alloc(4096); Buffer.from(JSON.stringify({ ...body, checksum: p.digestJSON(body) })).copy(out); return out; };
  fs.writeFileSync(file, Buffer.concat([slot({ sequence: 2, state: 'idle', reason: null }), Buffer.alloc(4096)]), { mode: 0o600 });
  const snapshotOpensRuntime = () => { fs.writeFileSync(file, Buffer.concat([Buffer.alloc(4096), slot({ sequence: 3, state: 'recovery_scan', reason: 'RECOVERY_REQUIRED' })])); return { wals: [], failure: { state: 'recovery_scan' } }; };
  const seen = N.withRawFailure(x.root, snapshotOpensRuntime);
  assert.equal(seen.failure.state, 'idle', 'the state the server left, not the residue');
  assert.deepEqual(seen.wals, []);
  assert.equal(N.rawFailureControl(x.root).state, 'recovery_scan', 'the residue is real on disk; the next read would see it');
});

// ---- second native round: 6.3 forge path, D2.4a restart allowance -----------------------------------------------------
test('forgePlan: a dotted path that starts with "plan." (and may index arrays) rewrites the highest slot under a valid checksum; recompute re-seals planDigest', t => {
  const x = syntheticEpoch(t), fixed = path.join(x.dir, 'money-atomic-restore-control.bin');
  const { planDigest, ...rest } = { schema: 1, checkpointDigest: HEX('1'), restoreId: HEX('a'), successorClaim: { successorDigest: HEX('2') }, continuationEarnings: { entries: [{ spendDigest: HEX('3') }] }, planDigest: HEX('9') };
  writeRestoreControl(fixed, restoreBody({ phase: 'complete', plan: { ...rest, planDigest: p.digestJSON(rest) } }));
  const plan = () => N.readControls(x.root).restore.plan;
  const before = plan();
  N.forgePlan({ target: x.root, field: 'plan.checkpointDigest', value: HEX('b'), recompute: false });
  assert.equal(plan().checkpointDigest, HEX('b'));
  assert.equal(plan().planDigest, before.planDigest, 'stale planDigest: the plan no longer matches its own digest');
  N.forgePlan({ target: x.root, field: 'plan.successorClaim.successorDigest', value: HEX('c'), recompute: true });
  const { planDigest: sealed, ...body } = plan();
  assert.equal(plan().successorClaim.successorDigest, HEX('c'));
  assert.equal(sealed, p.digestJSON(body), 'recomputed planDigest: only the SQL binding can refuse it');
  N.forgePlan({ target: x.root, field: 'plan.continuationEarnings.entries.0.spendDigest', value: HEX('d'), recompute: true });
  assert.equal(plan().continuationEarnings.entries[0].spendDigest, HEX('d'));
  assert.equal(N.restoreControlSlots(x.dir).rows[0].body.phase, 'complete', 'the slot is still valid and current');
});
test('allowanceFor: the request id is a function of the barrier digest, so a restart after completion must reuse the ORIGINAL barrier digest', t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'allowance-')));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifest = { binding_digest: HEX('b'), atomic_capacity_cut: { profileDigest: HEX('c') } };
  const first = N.allowanceFor({ target: dir, manifest, digest: HEX('d'), barrierDigest: HEX('1'), tag: 'x' });
  assert.equal(N.allowanceFor({ target: dir, manifest, digest: HEX('d'), barrierDigest: HEX('1'), tag: 'x' }).restoreAllowance.requestId, first.restoreAllowance.requestId, 'deterministic');
  assert.notEqual(N.allowanceFor({ target: dir, manifest, digest: HEX('d'), barrierDigest: HEX('2'), tag: 'x' }).restoreAllowance.requestId, first.restoreAllowance.requestId, 'the published barrier of a completed restore yields a DIFFERENT request: a foreign claim on that target');
  assert.equal(first.restoreAllowance.barrierDigest, HEX('1'));
  assert.equal(first.executionApprovalRef, 'explicit-test-only-a2-x');
});
