'use strict';
// EMFR A2 authenticated continuation, native proofs (Linux only; owned diagnostic volume; one fixture at a time).
// Rows follow BUILD-SPEC v3 section 6 and the two addenda. The stamped F-WAL test stays the positive proof; this file
// proves what must STAY refused, what a real fork cannot do, and that the A2 record fits its slot.
// Each test builds its own fixture because retirement is one-way. NOT RUN on the author's macOS host (node --check only).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const N = require('./helpers/money-continuation-native-fixture');
const skip = N.SKIP, T = { skip, timeout: 240000 };

function checkpointOf(cut) { return { checkpointDir: cut.directory, digest: cut.digest }; }
const manifestOf = cut => N.json(path.join(cut.directory, 'money-checkpoint-manifest.json'));

test('6.1 happy path anchor for this suite: retire, claim and restore, then two cold boots realize the owed unlock exactly once', T, async t => {
  const f = await N.crashedSource(t), cut = f.retire(), target = f.targetPath('main');
  const outcome = f.restore({ target, ...checkpointOf(cut) });
  assert.equal(outcome.successor.state, 'claimed');
  assert.equal(outcome.successor.continuation, 'minted');
  const boots = [];
  for (let i = 0; i < 2; i++) boots.push(await f.coldBoot(target, 'boot-' + i));
  assert.deepEqual(boots.map(b => b.booted), [true, true], boots.map(b => b.output).join('\n'));
  const final = f.snapshot(target);
  N.assertRealizedOnce(final, f.retained);
  const detail = f.control(target);
  assert.equal(detail.control.retirement, undefined, 'a target never inherits retirement');
  assert.equal(detail.control.schema_version, 2);
  assert.ok(detail.control.successorOf.generationId);
  assert.equal(detail.restore.plan.continuationEarnings.entries.length, 1);
});

test('6.3 forged lineage: a plan rewritten under a valid slot checksum is refused at boot and nothing realizes (stale planDigest, then recomputed planDigest against SQL)', T, async t => {
  const f = await N.crashedSource(t), cut = f.retire(), target = f.targetPath('main');
  f.restore({ target, ...checkpointOf(cut) });
  const controlFile = path.join(f.control(target).financialDir, 'money-atomic-restore-control.bin'), original = fs.readFileSync(controlFile), before = f.snapshot(target);
  N.assertHeldUnrealized(before, f.retained);
  for (const [field, recompute] of [['checkpointDigest', false], ['restoreId', true], ['successorClaim.successorDigest', true], ['continuationEarnings.entries.0.spendDigest', true]]) {
    N.workerOk({ mode: 'forge', target, field: 'plan.' + field, value: 'b'.repeat(64), recompute });
    const boot = await f.coldBoot(target, 'forged-' + field.replace(/\W/g, '_'));
    assert.equal(boot.booted, false, field + ' must refuse boot');
    // The restore binding is refused by the failure control itself (planDigest vs SQL) before the continuation branch is reached, so the refusal code is the restore's.
    assert.match(boot.output, /RESTORE_(PLAN_INVALID|COMPLETION_REQUIRED|REQUEST_CONFLICT|AUTHORITY_CHANGED)|COMPENSATION_ACCRUAL_CONFLICT/, field);
    fs.writeFileSync(controlFile, original); // same inode: restore the authentic slot bytes
    assert.deepEqual(N.withoutIdentity(f.snapshot(target)), N.withoutIdentity(before), field + ': no participant or SQL effect');
  }
  const after = await f.coldBoot(target, 'authentic');
  assert.equal(after.booted, true, 'the authentic record still completes the owed unlock: ' + after.output);
  N.assertRealizedOnce(f.snapshot(target), f.retained);
});

test('6.4 second use: a stale WAL put back after the earnings write is refused on the digest clause, and no second accrual happens', T, async t => {
  const f = await N.crashedSource(t), cut = f.retire(), target = f.targetPath('main');
  f.restore({ target, ...checkpointOf(cut) });
  const walFile = path.join(f.control(target).financialDir, 'wal', f.wal.id + '.wal.json'), staleWal = fs.readFileSync(walFile);
  assert.equal((await f.coldBoot(target, 'first')).booted, true);
  const once = f.snapshot(target);
  N.assertRealizedOnce(once, f.retained);
  fs.writeFileSync(walFile, staleWal, { mode: 0o600 });
  const second = await f.coldBoot(target, 'stale');
  assert.equal(N.gateLine(second.output), null, 'a digest mismatch is not the continuation gate');
  assert.equal(f.snapshot(target, f.wal.id).earnings.maker.total_gross, once.earnings.maker.total_gross, 'no duplicate accrual');
  assert.deepEqual(f.snapshot(target, f.wal.id).earnings, once.earnings);
});

for (const [name, check, mutate] of [
  ['altered WAL bytes (6.5)', 'WAL_FILE', (f, target) => { const file = path.join(f.control(target).financialDir, 'wal', f.wal.id + '.wal.json'), entry = N.json(file); entry.created_at += 1; fs.writeFileSync(file, JSON.stringify(entry), { mode: 0o600 }); }],
  ['an equal-byte new earnings inode on the restored target (6.6)', 'TARGET_IDENTITY', (f, target) => N.workerOk({ mode: 'swap', target, name: 'earnings.json' })]
]) {
  test('6.5/6.6 ' + name + ' is refused with check ' + check + ', the failure control carries the specific reason, repeat boots add no write, and nothing is realized', T, async t => {
    const f = await N.crashedSource(t), cut = f.retire(), target = f.targetPath('main');
    f.restore({ target, ...checkpointOf(cut) });
    const before = f.snapshot(target);
    mutate(f, target);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const boot = await f.coldBoot(target, 'refused-' + attempt);
      assert.equal(boot.booted, false, 'must refuse boot');
      assert.match(boot.output, /COMPENSATION_ACCRUAL_CONFLICT/);
      assert.match(N.gateLine(boot.output) || '', new RegExp('check=' + check));
      const detail = f.control(target).failure;
      assert.equal(detail.state, 'failure_pending');
      assert.equal(detail.reason, 'CONTINUATION_AUTHORITY_REQUIRED');
      assert.equal(detail.anchor.kind, 'spend');
    }
    const sequence = f.control(target).failure.sequence;
    assert.equal((await f.coldBoot(target, 'refused-3')).booted, false);
    assert.equal(f.control(target).failure.sequence, sequence, 'repeat boots add no failure-control writes');
    const held = f.snapshot(target);
    assert.equal(held.pools.length, 0);
    assert.equal(held.earningsDigest, before.earningsDigest);
    assert.equal(held.wals[0].accrualFence.state, 'not_started');
    assert.notEqual(held.failure.state, 'compensation_requested');
  });
}

test('6.7 chain: retire R1 (no boot), then a retiring checkpoint of the R1 target lets R2 complete once; with the R1 earnings inode swapped first there is no entry', T, async t => {
  const f = await N.crashedSource(t), first = f.retire(), r1 = f.targetPath('r1'), firstGeneration = manifestOf(first).sourceRetirement.identity.generationId;
  assert.equal(f.restore({ target: r1, ...checkpointOf(first) }).successor.state, 'claimed');
  f.drop(f.root); // the source has been claimed; the volume holds about four estates
  const second = N.workerOk({ mode: 'retire', root: r1, approvalRef: 'approval:a2-retire-r1' });
  const m2 = N.json(path.join(second.directory, 'money-checkpoint-manifest.json'));
  const S = m2.atomic_capacity_cut.continuationEarnings;
  assert.equal(S.entries.length, 1);
  assert.match(S.entries[0].predecessorEquivalenceDigest, /^[a-f0-9]{64}$/, 'the R1 entry is chained by digest');
  assert.notEqual(m2.sourceRetirement.identity.generationId, firstGeneration, 'the R1 target has its own generation');
  const r2 = f.targetPath('r2');
  assert.equal(N.workerOk({ mode: 'restore', root: r1, target: r2, checkpointDir: second.directory, digest: second.digest, claimRoot: r1 }).successor.state, 'claimed');
  assert.equal((await f.coldBoot(r2, 'r2-boot')).booted, true);
  N.assertRealizedOnce(f.snapshot(r2), f.retained);
});
test('6.7 chain negative: an earnings inode swapped on the R1 target before its retiring checkpoint yields no entry and R2 stays gated', T, async t => {
  const f = await N.crashedSource(t), first = f.retire(), r1 = f.targetPath('r1');
  f.restore({ target: r1, ...checkpointOf(first) });
  N.workerOk({ mode: 'swap', target: r1, name: 'earnings.json' });
  const second = N.workerOk({ mode: 'retire', root: r1, approvalRef: 'approval:a2-retire-r1' }), m2 = N.json(path.join(second.directory, 'money-checkpoint-manifest.json'));
  assert.equal(m2.atomic_capacity_cut.continuationEarnings, null);
  assert.equal(m2.atomic_capacity_cut.unresolvedObligations.items[0].reason, 'SOURCE_IDENTITY_UNPROVEN');
  assert.equal(m2.atomic_capacity_cut.completionGuaranteed, false);
  const r2 = f.targetPath('r2');
  N.workerOk({ mode: 'restore', root: r1, target: r2, checkpointDir: second.directory, digest: second.digest, claimRoot: r1 });
  const boot = await f.coldBoot(r2, 'r2-boot');
  assert.equal(boot.booted, false);
  assert.match(boot.output, /RECORD_ABSENT|EPOCH_SUCCESSOR_ACTIVATION_REQUIRED/);
  N.assertHeldUnrealized(f.snapshot(r2), f.retained);
});

test('6.8 gate matrix, cold: the unclaimed target stays gated with the specific reason and repeat boots add no write (D); rollback incompatibility is covered by test/money-preA2-refusal.test.js', T, async t => {
  const f = await N.crashedSource(t), cut = f.retire(), target = f.targetPath('main');
  const outcome = f.restore({ target, ...checkpointOf(cut), claim: 'none' });
  assert.equal(outcome.successor.state, 'absent');
  const plan = f.control(target).restore.plan;
  assert.equal(plan.continuationEarnings, null);
  assert.equal(plan.continuationWithheld, 'SUCCESSOR_ABSENT');
  assert.equal(plan.successorClaim, null);
  const sequences = [];
  for (let i = 0; i < 2; i++) {
    const boot = await f.coldBoot(target, 'unclaimed-' + i);
    assert.equal(boot.booted, false);
    assert.match(N.gateLine(boot.output) || '', /check=RECORD_ABSENT/);
    sequences.push(f.control(target).failure.sequence);
    assert.equal(f.control(target).failure.reason, 'CONTINUATION_AUTHORITY_REQUIRED');
  }
  assert.equal(sequences[0], sequences[1], 'sequence stable over two boots');
  N.assertHeldUnrealized(f.snapshot(target), f.retained);
});

test('6.9 headroom: the real restore control of a claimed target fits its slot, and the A2 additions stay inside the 4,096 B plan-add bound', T, async t => {
  const f = await N.crashedSource(t), cut = f.retire(), target = f.targetPath('main');
  f.restore({ target, ...checkpointOf(cut) });
  const api = require('../lib/money-atomic-restore'), A = require('../lib/money-continuation-authority'), p = require('../lib/stripe-transfer-persistence'), detail = f.control(target);
  const slots = fs.readFileSync(path.join(detail.financialDir, 'money-atomic-restore-control.bin'));
  const rows = [0, 1].map(i => { const raw = slots.subarray(i * api.SLOT, (i + 1) * api.SLOT), end = raw.indexOf(0); if (end < 1) return null; const { checksum, ...body } = JSON.parse(raw.subarray(0, end)); return p.digestJSON(body) === checksum ? body : null; }).filter(Boolean).sort((a, b) => b.sequence - a.sequence);
  const body = rows[0], { plan } = body, encoded = api.encodeControl(body);
  const { continuationEarnings, continuationWithheld, successorClaim, ...planBase } = plan;
  const { continuation_earnings, ...rolesBase } = plan.roles;
  const baseBody = { ...body, plan: { ...planBase, roles: rolesBase } };
  delete baseBody.claim;
  const bytes = x => Buffer.byteLength(p.canonicalJSON(x)), withChecksum = x => ({ ...x, checksum: 'c'.repeat(64) });
  const added = bytes(body) - bytes(baseBody), baseBytes = bytes(withChecksum(baseBody)), fullBytes = bytes(withChecksum(body));
  const report = { slotBytes: api.SLOT, phase: body.phase, bodyBytesWithChecksum: fullBytes, baseBytesWithoutA2: baseBytes, headroomWithoutA2: api.SLOT - 1 - baseBytes, headroomWithA2: api.SLOT - 1 - fullBytes, planAddBytes: added, declaredBound: A.BOUNDS.planAdd, priorRootBytes: bytes(body.priorRoot) };
  t.diagnostic('A2_HEADROOM ' + JSON.stringify(report));
  assert.equal(encoded.length, api.SLOT, 'encodeControl accepts the real body');
  assert.ok(added <= A.BOUNDS.planAdd, 'plan-add ' + added + ' exceeds the declared bound ' + A.BOUNDS.planAdd + ': STOP and re-stamp');
  assert.ok(baseBytes + A.BOUNDS.planAdd <= api.SLOT - 1, 'the full 4,096 B bound does not fit this slot (base ' + baseBytes + '): STOP and re-stamp');
  assert.ok(A.planAddBytes(plan, body.claim) <= A.BOUNDS.planAdd);
});
test('2.8(4) a three-restore chain does not accumulate: the continuation record holds only the current hop', T, async t => {
  const f = await N.crashedSource(t), first = f.retire(), r1 = f.targetPath('r1'), r2 = f.targetPath('r2'), r3 = f.targetPath('r3');
  const p = require('../lib/stripe-transfer-persistence'), size = x => Buffer.byteLength(p.canonicalJSON(x)), A = require('../lib/money-continuation-authority'), sizes = [];
  f.restore({ target: r1, ...checkpointOf(first) });
  sizes.push(size(f.control(r1).restore.plan.continuationEarnings));
  f.drop(f.root);
  const second = N.workerOk({ mode: 'retire', root: r1, approvalRef: 'approval:a2-retire-r1' });
  N.workerOk({ mode: 'restore', root: r1, target: r2, checkpointDir: second.directory, digest: second.digest });
  sizes.push(size(f.control(r2).restore.plan.continuationEarnings));
  f.drop(r1);
  const third = N.workerOk({ mode: 'retire', root: r2, approvalRef: 'approval:a2-retire-r2' });
  N.workerOk({ mode: 'restore', root: r2, target: r3, checkpointDir: third.directory, digest: third.digest });
  const last = f.control(r3).restore.plan.continuationEarnings;
  sizes.push(size(last));
  t.diagnostic('A2_CHAIN_T_BYTES ' + JSON.stringify(sizes));
  assert.ok(Math.abs(sizes[2] - sizes[1]) <= 16, 'R2 and R3 each carry exactly one predecessor digest: only inode digit counts may differ');
  assert.ok(sizes[2] - sizes[0] <= 62 + 16, 'R3 differs from R1 only by the predecessor digest replacing null');
  assert.ok(sizes[2] <= A.BOUNDS.target);
  assert.equal(last.entries.length, 1);
  assert.match(last.entries[0].predecessorEquivalenceDigest, /^[a-f0-9]{64}$/);
});

test('6.10 invariant pin: two overlapping money contexts are serialized by the lease (the second starts after the first ends)', T, async t => {
  // An ordinary (non-successor) runtime: a claimed successor refuses every ordinary context by design, so it cannot carry this pin.
  const owned = N.admitted.ownership();
  assert.deepEqual(fs.readdirSync(owned.root).sort(), ['.probe-owner', 'lost+found'].sort(), 'one fixture at a time');
  const box = fs.mkdtempSync(path.join(owned.root, 'a2-native-')), locator = path.join(box, 'locator.json');
  t.after(() => { if (fs.existsSync(locator)) { const x = N.json(locator); for (const k of ['root', 'target']) if (x[k]) fs.rmSync(x[k], { recursive: true, force: true }); } fs.rmSync(box, { recursive: true, force: true }); });
  N.admittedWorker({ mode: 'setup', locator });
  const events = N.workerOk({ mode: 'lease', root: N.json(locator).root }), at = (id, phase) => BigInt(events.find(e => e.id === id && e.phase === phase).at);
  const [firstId, secondId] = at('first', 'start') < at('second', 'start') ? ['first', 'second'] : ['second', 'first'];
  assert.ok(at(secondId, 'start') >= at(firstId, 'end'), 'the second context starts after the first ends');
});

test('6.10b exact fallback: with a planted not_started WAL the admitted unlock is refused at WAL creation, the real catch path restores the debit exactly, and two cold reads agree', T, async t => {
  const owned = N.admitted.ownership();
  assert.deepEqual(fs.readdirSync(owned.root).sort(), ['.probe-owner', 'lost+found'].sort(), 'one fixture at a time');
  const box = fs.mkdtempSync(path.join(owned.root, 'a2-native-')), locator = path.join(box, 'locator.json');
  let child;
  t.after(async () => { await N.stopServer(child); if (fs.existsSync(locator)) { const x = N.json(locator); for (const k of ['root', 'target']) if (x[k]) fs.rmSync(x[k], { recursive: true, force: true }); } fs.rmSync(box, { recursive: true, force: true }); });
  N.admittedWorker({ mode: 'setup', locator });
  const located = N.json(locator), initial = N.snapshot(located.root), stage = await N.stage(box, 'fallback-server', located.root), started = await N.boot(stage);
  child = started.child;
  const walDir = path.join(located.root, 'financial-epochs', located.epochId, 'wal'), earnings = fs.statSync(path.join(located.root, 'financial-epochs', located.epochId, 'earnings.json'));
  const planted = { id: 'planted_open_1', operation: 'unlock', payload: { funding_source: 'credit_pack' }, accrualFence: { schema: 1, state: 'not_started', spendId: 'spend_planted', spendDigest: '0'.repeat(64), earningsBeforeDigest: initial.earningsDigest, earningsFileIdentity: { dev: earnings.dev, ino: earnings.ino } }, steps_completed: ['update_learnings'], created_at: 1 };
  fs.writeFileSync(path.join(walDir, 'planted_open_1.wal.json'), JSON.stringify(planted), { mode: 0o600 });
  const response = await fetch('http://127.0.0.1:' + stage.port + '/knowledge/' + N.admitted.LEARNING_ID, { headers: { 'X-API-Key': N.admitted.API_KEY }, signal: AbortSignal.timeout(15000) }), body = await response.json();
  // v3 6.10b names two outcomes. The refusal at WAL creation reaches the real catch path; the exact restore then runs. The planted WAL
  // is a pending obligation no recovery anchor can resolve (see test/money-continuation-wal.test.js), so the scan that follows the
  // restore cannot go idle and the route answers 503 FINANCIAL_RECOVERY_REQUIRED (server.js 10500) with credit_refunded true: the debit
  // IS restored exactly, the failure control stays held. Either answer is accepted; the STATE must match the answer exactly.
  t.diagnostic('A2_FALLBACK ' + JSON.stringify({ status: response.status, body }));
  if (response.status === 500) assert.equal(body.code, 'DELIVERY_FAILED_CREDIT_REFUNDED');
  else { assert.equal(response.status, 503); assert.equal(body.code, 'FINANCIAL_RECOVERY_REQUIRED'); }
  const refunded = body.credit_refunded === true;
  await N.stopServer(child); child = null;
  const reads = [N.snapshot(located.root), N.snapshot(located.root)].map(s => ({ ...s, wals: s.wals.filter(w => w.id !== 'planted_open_1') }));
  for (const state of reads) {
    assert.equal(state.wals.length, 0, 'no WAL was created for the refused unlock');
    assert.equal(state.spends.length, 1);
    assert.equal(state.pools.length, 0);
    const receipts = state.credits.buyer.money_receipts, lot = state.credits.buyer.dollar_lots[0], spendId = state.spends[0].id;
    assert.ok(receipts[spendId], 'the debit receipt');
    if (refunded) {
      assert.equal(lot.remaining_usd, 0.06, 'buyer principal is exactly restored');
      assert.equal(lot.inflight_usd, 0);
      assert.equal(state.spends[0].state, 'returned');
      assert.ok(receipts[spendId + ':restore'], 'the restore receipt');
    } else {
      assert.equal(lot.remaining_usd, 0.01, 'the debit is held exactly');
      assert.equal(lot.inflight_usd, 0.05);
      assert.equal(state.spends[0].state, 'acknowledged');
      assert.equal(receipts[spendId + ':restore'], undefined);
    }
  }
  assert.deepEqual(N.withoutIdentity(reads[0]), N.withoutIdentity(reads[1]), 'two cold reads are identical');
});

test('6.11a retirement is explicit only: the ordinary checkpoint leaves the source control bytes identical and retiring without an approvalRef refuses', T, async t => {
  const owned = N.admitted.ownership();
  assert.deepEqual(fs.readdirSync(owned.root).sort(), ['.probe-owner', 'lost+found'].sort(), 'one fixture at a time');
  const box = fs.mkdtempSync(path.join(owned.root, 'a2-native-')), locator = path.join(box, 'locator.json');
  t.after(() => { if (fs.existsSync(locator)) { const x = N.json(locator); for (const k of ['root', 'target']) if (x[k]) fs.rmSync(x[k], { recursive: true, force: true }); } fs.rmSync(box, { recursive: true, force: true }); });
  N.admittedWorker({ mode: 'setup', locator });
  const located = N.json(locator), before = N.workerOk({ mode: 'control', root: located.root }).control;
  const ordinary = N.workerOk({ mode: 'retire', root: located.root, via: 'ordinary' });
  assert.equal(Object.hasOwn(N.json(path.join(ordinary.directory, 'money-checkpoint-manifest.json')), 'sourceRetirement'), false);
  assert.equal(ordinary.completion_guaranteed, false);
  assert.deepEqual(N.workerOk({ mode: 'control', root: located.root }).control, before, 'no R, no schema change');
  const refused = N.worker({ mode: 'retire', root: located.root, approvalRef: '' });
  assert.equal(refused.error.code, 'CHECKPOINT_RETIRE_APPROVAL_REQUIRED');
  assert.deepEqual(N.workerOk({ mode: 'control', root: located.root }).control, before);
  // The socket op never retires either: its strict key set refuses extra keys and other ops, and a granted checkpoint is ordinary.
  const viaSocket = N.workerOk({ mode: 'socket', root: located.root });
  assert.equal(viaSocket.retired, false);
  assert.equal(viaSocket.completionGuaranteed, false);
  assert.equal(viaSocket.extra.error, 'CHECKPOINT_REQUEST_INVALID', 'a retire key on the socket is refused');
  assert.equal(viaSocket.wrongOp.error, 'CHECKPOINT_REQUEST_INVALID');
  assert.deepEqual(N.workerOk({ mode: 'control', root: located.root }).control, before, 'the socket op left the control bytes identical');
});

test('6.11b/d/f/g and D1.7b/c: two actual targets from two checkpoints of one generation resolve to exactly one successor; replay and the withheld variants stay gated', T, async t => {
  const f = await N.crashedSource(t), c1 = f.retire(), c2 = f.retire({ via: 'tool' });
  const m1 = manifestOf(c1), m2 = manifestOf(c2);
  assert.notEqual(c1.checkpoint_id, c2.checkpoint_id);
  assert.notEqual(m1.checksum, m2.checksum);
  assert.equal(m1.sourceRetirement.identity.generationId, m2.sourceRetirement.identity.generationId);
  assert.deepEqual(m1.sourceRetirement, m2.sourceRetirement, 'a replacement copies P and identityDigest verbatim (D1.7b)');
  const retiredControl = f.control(f.root).control;
  assert.equal(retiredControl.retirement.state, 'retired');
  assert.equal(retiredControl.retirement.identityDigest, m1.sourceRetirement.identityDigest, 'identityDigest is byte-equal after S3 (D1.7c)');
  const t1 = f.targetPath('t1');
  assert.equal(f.restore({ target: t1, ...checkpointOf(c1) }).successor.state, 'claimed');
  const claimed = f.control(f.root).control.retirement;
  assert.equal(claimed.identityDigest, m1.sourceRetirement.identityDigest, 'identityDigest is byte-equal after S4 (D1.7c)');
  assert.equal(claimed.successor.restoreId, f.control(t1).restore.restoreId);
  const g = f.control(t1).control;
  assert.equal(g.retirement, undefined, '6.11g: the target carries no retirement');
  assert.deepEqual(g.successorOf, { generationId: m1.sourceRetirement.identity.generationId });
  const boots = [await f.coldBoot(t1, 't1-a'), await f.coldBoot(t1, 't1-b')];
  assert.deepEqual(boots.map(b => b.booted), [true, true], boots.map(b => b.output).join('\n'));
  N.assertRealizedOnce(f.snapshot(t1), f.retained);
  // Each loser is restored, checked and dropped in turn: the owned volume holds about four estates.
  for (const [tag, checkpoint, claim, expected, withheld] of [
    ['t2', c2, 'source', { state: 'refused', code: 'SUCCESSOR_ALREADY_CLAIMED' }, 'SUCCESSOR_REFUSED'],
    ['t3', c1, 'source', { state: 'refused', code: 'SUCCESSOR_ALREADY_CLAIMED' }, 'SUCCESSOR_REFUSED'],
    ['t4', c2, 'none', { state: 'absent' }, 'SUCCESSOR_ABSENT']
  ]) {
    const target = f.targetPath(tag);
    assert.deepEqual(f.restore({ target, ...checkpointOf(checkpoint), claim }).successor, expected, tag);
    assert.deepEqual(f.control(f.root).control.retirement, claimed, tag + ': the source successor names exactly one restoreId and is byte-unchanged by every loser');
    assert.equal(f.control(target).restore.plan.continuationWithheld, withheld, tag);
    const boot = await f.coldBoot(target, tag + '-boot');
    assert.equal(boot.booted, false, tag + ' must stay gated');
    assert.match(N.gateLine(boot.output) || '', /check=RECORD_ABSENT/, tag);
    N.assertHeldUnrealized(f.snapshot(target), f.retained);
    f.drop(target);
  }
});

test('6.11c race: two real processes restore to two targets at once; exactly one claims, the loser ends SUCCESSOR_ALREADY_CLAIMED (directly or after MONEY_WRITER_ALREADY_HELD and a retry)', T, async t => {
  const f = await N.crashedSource(t), c1 = f.retire(), c2 = f.retire({ via: 'tool' });
  const a = f.targetPath('ra'), b = f.targetPath('rb');
  const [ra, rb] = await Promise.all([
    N.workerAsync({ mode: 'restore', root: f.root, target: a, ...checkpointOf(c1), tag: 'ra' }),
    N.workerAsync({ mode: 'restore', root: f.root, target: b, ...checkpointOf(c2), tag: 'rb' })
  ]);
  const settle = async (result, request, failed) => {
    if (result.status === 0) return result.result.successor;
    assert.equal(result.error?.code, 'MONEY_WRITER_ALREADY_HELD', JSON.stringify(result.error) + result.stderr);
    f.drop(failed); // a restore that never reached the claim leaves a staged copy: free the volume, then retry on a fresh target
    return N.workerOk({ mode: 'restore', root: f.root, target: f.targetPath(request.tag + '-retry'), checkpointDir: request.checkpointDir, digest: request.digest, tag: request.tag + '-retry' }).successor;
  };
  const outcomes = [await settle(ra, { tag: 'ra', ...checkpointOf(c1) }, a), await settle(rb, { tag: 'rb', ...checkpointOf(c2) }, b)];
  assert.equal(outcomes.filter(o => o.state === 'claimed').length, 1, JSON.stringify(outcomes));
  assert.deepEqual(outcomes.filter(o => o.state === 'refused'), [{ state: 'refused', code: 'SUCCESSOR_ALREADY_CLAIMED' }]);
  const successor = f.control(f.root).control.retirement.successor;
  assert.ok(successor && /^[a-f0-9]{64}$/.test(successor.restoreId));
});

for (const cut of ['retire:published', 'claim:cas-durable', 'continuation:minted']) {
  test('6.11e crash cut ' + cut + ' with cold recovery: no second generation, no second successor, the owed unlock completes once', T, async t => {
    const f = await N.crashedSource(t), target = f.targetPath('main');
    let checkpoint;
    if (cut === 'retire:published') {
      const crashed = f.retireRaw({ crashAfter: cut });
      assert.equal(crashed.crashed, true, crashed.stdout + crashed.stderr);
      const mid = f.control(f.root).control.retirement;
      assert.equal(mid.state, 'retiring');
      const refusedBoot = await f.coldBoot(f.root, 'source-boot');
      assert.equal(refusedBoot.booted, false, 'a retiring source never boots');
      assert.match(refusedBoot.output, /EPOCH_RETIRED/);
      const walFile = path.join(f.control(f.root).financialDir, 'wal', f.wal.id + '.wal.json');
      assert.equal(N.json(walFile).accrualFence.state, 'not_started', 'the retired source never completed its own WAL');
      const orphans = fs.readdirSync(path.join(f.root, '.money-checkpoints')).filter(n => !n.endsWith('.tmp'));
      assert.equal(orphans.length, 1, 'exactly one orphan checkpoint was published before S3');
      const rerun = f.retire({ via: 'tool' });
      const done = f.control(f.root).control.retirement;
      assert.equal(done.state, 'retired');
      assert.equal(done.identity.generationId, mid.identity.generationId, 'the same generation: never a second one');
      assert.deepEqual(done.identity, mid.identity);
      assert.equal(done.publishedCheckpointDigest, rerun.digest);
      // D1.7a: the orphan checkpoint taken BEFORE finalization still claims after finalization.
      checkpoint = { checkpointDir: path.join(f.root, '.money-checkpoints', orphans[0]), digest: N.json(path.join(f.root, '.money-checkpoints', orphans[0], 'money-checkpoint-manifest.json')).checksum };
      assert.equal(f.restore({ target, ...checkpoint }).successor.state, 'claimed');
    } else {
      const cutResult = f.retire();
      checkpoint = checkpointOf(cutResult);
      const crashed = N.worker({ mode: 'restore', root: f.root, target, ...checkpoint, crashAfter: cut });
      assert.equal(crashed.crashed, true, crashed.stdout + crashed.stderr);
      const sourceAfterCrash = f.control(f.root).control.retirement;
      if (cut === 'claim:cas-durable') assert.ok(sourceAfterCrash.successor, 'the CAS is durable at this cut');
      const resumed = N.workerOk({ mode: 'restore', root: f.root, target, ...checkpoint, resume: true });
      assert.equal(resumed.successor.state, 'claimed');
      if (sourceAfterCrash.successor) assert.deepEqual(f.control(f.root).control.retirement.successor, sourceAfterCrash.successor, 'the successor is byte-stable across the resume');
      assert.equal(f.control(target).restore.plan.continuationEarnings.entries.length, 1, 'T minted exactly once');
    }
    const boots = [await f.coldBoot(target, 'boot-a'), await f.coldBoot(target, 'boot-b')];
    assert.deepEqual(boots.map(b => b.booted), [true, true], boots.map(b => b.output).join('\n'));
    N.assertRealizedOnce(f.snapshot(target), f.retained);
  });
}
