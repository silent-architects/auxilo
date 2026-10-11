'use strict';
// A2 pure helpers: schema bounds, exact keys, escape rejection, absent == null compatibility,
// eligibility reasons, target construction, claim validators and the consumption check.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const A = require('../lib/money-continuation-authority'), p = require('../lib/stripe-transfer-persistence');
const { HEX, retirementIdentity } = require('./helpers/money-synthetic-epoch');
const hash = p.digestJSON, M = Number.MAX_SAFE_INTEGER, len = A.bytesOf, code = c => error => error.code === c;
const EPOCH = 'epoch-a2';

function spendFor(id = 'spend_1') {
  const participantDraws = [{ lotId: 'lot_1', kind: 'dollar_paid', amountMicros: 50000, sourceId: 'source_1', promoReceiptId: null }];
  const intent = { id, accountId: 'buyer', draws: [{ sourceId: 'source_1', amountMicros: 50000 }], participantDraws };
  return { ...intent, intent, digest: hash(intent), state: 'acknowledged' };
}
function walFor(id, spend, patch = {}) {
  const payload = { funding_source: 'credit_pack', purchaser_account_id: 'buyer', dollar_draws: [{ lot_id: 'lot_1', kind: 'dollar_paid', amount: 0.05, spend_id: spend.id, inflight_marked: true }] };
  return { id, operation: 'unlock', payload, accrualFence: { schema: 1, state: 'not_started', spendId: spend.id, spendDigest: spend.digest, earningsBeforeDigest: HEX('e'), earningsFileIdentity: { dev: 7, ino: 70 } }, steps_completed: ['update_learnings'], created_at: 1, ...patch };
}
function world(t, { wals = [['wal_1', 'spend_1']], retiring = true, pools = [], compensationWalId = null, identity = { dev: 7, ino: 70, uid: 1000, mode: 0o600, nlink: 1 }, restored = () => null } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-authority-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spends = new Map();
  for (const [walId, spendId, patch] of wals) {
    const spend = spends.get(spendId) || spendFor(spendId);
    spends.set(spendId, spend);
    fs.writeFileSync(path.join(dir, walId + '.wal.json'), JSON.stringify(walFor(walId, spend, patch)));
  }
  const ctx = { getSpend: id => spends.get(id), hasPool: id => pools.includes(id), earnings: () => ({ sha256: HEX('e'), bytes: 4096, identity }), compensationWalId, restoredEntryFor: restored };
  const evaluate = () => A.evaluateObligations({ wals: A.readWalFiles(dir), retiring, ctx, epochId: EPOCH });
  return { dir, ctx, spends, evaluate };
}
const entry = (patch = {}) => ({ walId: 'wal_1', walFileSha256: HEX('1'), walPayloadDigest: HEX('2'), fenceDigest: HEX('3'), spendId: 'spend_1', spendDigest: HEX('4'), drawVectorDigest: HEX('5'), earningsBeforeDigest: HEX('e'), originalIdentity: { dev: 7, ino: 70 }, predecessorEquivalenceDigest: null, ...patch });
const source = (patch = {}) => ({ schema: 1, participant: 'earnings', relativePath: 'financial-epochs/' + EPOCH + '/earnings.json', sha256: HEX('e'), bytes: 4096, sourceIdentity: { dev: 7, ino: 70, uid: 1000, mode: 0o600, nlink: 1 }, entries: [entry()], ...patch });

test('declared maxima: E 1,024 B, S 1,536 B, T 2,304 B, role 512 B, claim 512 B, unresolved 2,304 B, plan add 4,096 B (v3 2.8, D2.1)', () => {
  const id = 'a'.repeat(64), epoch = 'e'.repeat(64), maxId = { dev: M, ino: M };
  const E = entry({ walId: id, spendId: id, walFileSha256: HEX('a'), walPayloadDigest: HEX('b'), fenceDigest: HEX('c'), spendDigest: HEX('d'), drawVectorDigest: HEX('e'), earningsBeforeDigest: HEX('f'), originalIdentity: maxId, predecessorEquivalenceDigest: HEX('1') });
  const S = { schema: 1, participant: 'earnings', relativePath: 'financial-epochs/' + epoch + '/earnings.json', sha256: HEX('f'), bytes: M, sourceIdentity: { dev: M - 1, ino: M, uid: M, mode: 0o600, nlink: 1 }, entries: [E] };
  const T = { schema: 1, kind: 'continuation_earnings_v1', cutDigest: HEX('a'), lineage: { checkpointDigest: HEX('b'), restoreId: HEX('c'), barrierDigest: HEX('d'), epochId: epoch, bindingDigest: HEX('e'), successorDigest: HEX('f') }, earnings: { relativePath: 'earnings.json', sha256: HEX('f'), bytes: M, targetIdentity: maxId }, entries: [E] };
  const role = { dev: M, ino: M, bytes: M, allocatedBytes: M, uid: M, mode: 0o600, nlink: 1, relativePath: 'earnings.json', sha256: HEX('a'), entryDigest: HEX('b') };
  const claim = { schema: 1, state: 'recorded', restoreId: HEX('a'), generationId: HEX('b'), initializationDigest: HEX('c'), checkpointDigest: HEX('d'), successorDigest: HEX('e') };
  const successorClaim = { generationId: HEX('a'), restoreId: HEX('b'), initializationDigest: HEX('c'), successorDigest: HEX('d') };
  const items = Array.from({ length: 8 }, () => ({ walId: id, spendId: id, fenceState: 'write_started', continuation: 'none', reason: 'AMBIGUOUS_SHARED_PRE_IMAGE' }));
  const unresolved = { count: M, truncated: true, items };
  const measured = { entry: len(E), continuationEarnings: len(S), target: len(T), role: len(role), claim: len(claim), successorClaim: len(successorClaim), unresolvedObligations: len(unresolved) };
  for (const [name, bytes] of Object.entries(measured)) assert.ok(bytes <= A.BOUNDS[name], name + ' ' + bytes + ' > ' + A.BOUNDS[name]);
  assert.doesNotThrow(() => A.validateContinuationEarnings(S, { epochId: epoch }));
  assert.doesNotThrow(() => A.validateTarget(T));
  assert.doesNotThrow(() => A.validateRole(role));
  assert.doesNotThrow(() => A.validateUnresolvedObligations(unresolved));
  const plan = { continuationEarnings: T, continuationWithheld: 'SUCCESSOR_ABSENT', successorClaim, roles: { continuation_earnings: role } };
  const added = A.planAddBytes(plan, claim);
  assert.ok(added <= A.BOUNDS.planAdd, 'plan add ' + added);
  t_report('measured', { ...measured, planAdd: added });
});
function t_report(name, value) { if (process.env.A2_REPORT) process.stdout.write(name + ' ' + JSON.stringify(value) + '\n'); }

test('S and E reject extra, missing and mistyped keys, escape-needing strings, a second entry and an inconsistent predecessor', () => {
  assert.equal(A.validateContinuationEarnings(source(), { epochId: EPOCH }).entries.length, 1);
  assert.equal(A.validateContinuationEarnings(null, { epochId: EPOCH }), null);
  const bad = [
    source({ extra: 1 }), (({ bytes, ...rest }) => rest)(source()), source({ schema: 2 }), source({ participant: 'credits' }), source({ relativePath: 'financial-epochs/other/earnings.json' }), source({ sha256: 'x' }),
    source({ bytes: -1 }), source({ sourceIdentity: { dev: 7, ino: 70, uid: 1000, mode: 0o644, nlink: 1 } }), source({ sourceIdentity: { dev: 7, ino: 70, uid: 1000, mode: 0o600, nlink: 2 } }),
    source({ entries: [] }), source({ entries: [entry(), entry({ walId: 'wal_2' })] }), source({ entries: [entry({ extra: 1 })] }), source({ entries: [entry({ walId: 'a"b' })] }), source({ entries: [entry({ walId: 'a b' })] }),
    source({ entries: [entry({ walId: 'x'.repeat(65) })] }), source({ entries: [entry({ earningsBeforeDigest: HEX('0') })] }), source({ entries: [entry({ drawVectorDigest: 'ABC' })] }),
    source({ entries: [entry({ originalIdentity: { dev: 7 } })] }), source({ entries: [entry({ originalIdentity: { dev: 9, ino: 70 } })] }), source({ entries: [entry({ predecessorEquivalenceDigest: HEX('7') })] }),
    source({ sourceIdentity: { dev: 8, ino: 80, uid: 1000, mode: 0o600, nlink: 1 } })
  ];
  for (const value of bad) assert.throws(() => A.validateContinuationEarnings(value, { epochId: EPOCH }), code('CHECKPOINT_CONTINUATION_EARNINGS_INVALID'));
  assert.doesNotThrow(() => A.validateContinuationEarnings(source({ sourceIdentity: { dev: 8, ino: 80, uid: 1000, mode: 0o600, nlink: 1 }, entries: [entry({ predecessorEquivalenceDigest: HEX('7') })] }), { epochId: EPOCH }), 'a restored source names its predecessor');
});

test('unresolvedObligations: exact keys, enum reasons, count and truncation consistency, record only for ELIGIBLE', () => {
  const item = (patch = {}) => ({ walId: 'wal_1', spendId: 'spend_1', fenceState: 'not_started', continuation: 'none', reason: 'SOURCE_NOT_RETIRING', ...patch });
  assert.doesNotThrow(() => A.validateUnresolvedObligations({ count: 0, truncated: false, items: [] }));
  assert.doesNotThrow(() => A.validateUnresolvedObligations({ count: 1, truncated: false, items: [item()] }));
  assert.doesNotThrow(() => A.validateUnresolvedObligations({ count: 1, truncated: false, items: [item({ continuation: 'record', reason: 'ELIGIBLE' })] }));
  assert.doesNotThrow(() => A.validateUnresolvedObligations({ count: 9, truncated: true, items: Array.from({ length: 8 }, (_, i) => item({ walId: 'wal_' + i })) }));
  assert.doesNotThrow(() => A.validateUnresolvedObligations({ count: 1, truncated: false, items: [item({ spendId: null, fenceState: null, reason: 'NO_FENCE' })] }));
  for (const value of [
    { count: 1, truncated: false, items: [item({ reason: 'MADE_UP' })] }, { count: 1, truncated: false, items: [item({ continuation: 'record' })] }, { count: 1, truncated: false, items: [item({ reason: 'ELIGIBLE' })] },
    { count: 1, truncated: true, items: [item()] }, { count: 9, truncated: false, items: Array.from({ length: 8 }, () => item()) }, { count: 9, truncated: true, items: Array.from({ length: 9 }, () => item()) },
    { count: 0, truncated: false, items: [item()] }, { count: 1, truncated: false, items: [item({ extra: 1 })] }, { count: 1, truncated: false, items: [item({ walId: 'a"b' })] }, { count: 1, truncated: false, items: [item({ fenceState: 'Not Started' })] }, { count: 1, truncated: false }
  ]) assert.throws(() => A.validateUnresolvedObligations(value), code('CHECKPOINT_CONTINUATION_EARNINGS_INVALID'), JSON.stringify(value).slice(0, 80));
});

function manifestFor({ cut, sourceRetirement, files, financial_epoch = EPOCH, first_failure_control } = {}) {
  const P = retirementIdentity();
  const m = { financial_epoch, binding_digest: P.sourceIdentity.bindingDigest, journal_revision: P.sourceIdentity.journalRevision, files: files || [{ path: 'financial-epochs/' + EPOCH + '/earnings.json', bytes: 4096, sha256: HEX('e') }, { path: 'financial-epochs/' + EPOCH + '/wal/wal_1.wal.json', bytes: 300, sha256: HEX('1') }] };
  if (cut !== undefined) m.atomic_capacity_cut = cut;
  if (sourceRetirement !== undefined) m.sourceRetirement = sourceRetirement;
  if (first_failure_control) m.first_failure_control = first_failure_control;
  return m;
}
const retirementRecord = (patch = {}) => { const identity = retirementIdentity(patch); return { identity, identityDigest: hash(identity) }; };
const noObligations = { count: 0, truncated: false, items: [] };

test('absent == null: pre-A2 manifests and cuts validate as before; a partial A2 cut or an unauthenticated S is rejected', () => {
  assert.equal(A.validateCheckpointContinuation({ financial_epoch: EPOCH }), true, 'no atomic cut');
  assert.equal(A.validateCheckpointContinuation(manifestFor({ cut: { compensationEarnings: null } })), true, 'pre-A2 cut: none of the three keys');
  assert.equal(A.validateCheckpointContinuation(manifestFor({ cut: { compensationEarnings: null, continuationEarnings: null, unresolvedObligations: noObligations, completionGuaranteed: false } })), true);
  const bad = () => ({ code: 'CHECKPOINT_CONTINUATION_EARNINGS_INVALID' });
  assert.throws(() => A.validateCheckpointContinuation(manifestFor({ cut: { continuationEarnings: null } })), bad(), 'partial');
  assert.throws(() => A.validateCheckpointContinuation(manifestFor({ cut: { continuationEarnings: null, unresolvedObligations: noObligations, completionGuaranteed: true } })), bad(), 'completionGuaranteed is the literal false');
  assert.throws(() => A.validateCheckpointContinuation(manifestFor({ cut: { continuationEarnings: null, unresolvedObligations: noObligations, completionGuaranteed: 0 } })), bad());
  assert.throws(() => A.validateCheckpointContinuation(manifestFor({ cut: { continuationEarnings: source(), unresolvedObligations: noObligations, completionGuaranteed: false } })), bad(), 'S without a retiring cut');
  assert.throws(() => A.validateCheckpointContinuation(manifestFor({ cut: { compensationEarnings: null }, sourceRetirement: retirementRecord() })), bad(), 'a retiring cut carries all three keys');
});
test('sourceRetirement record: exact keys, digest equals digestJSON(P), bound to the manifest epoch, binding and revision', () => {
  const record = retirementRecord();
  assert.equal(A.validateSourceRetirement(record, manifestFor()), record);
  assert.ok(len(record) <= 1408);
  const bad = c => assert.throws(() => A.validateSourceRetirement(...c), code('CHECKPOINT_SOURCE_RETIREMENT_INVALID'));
  bad([{ ...record, identityDigest: HEX('0') }, manifestFor()]);
  bad([{ ...record, extra: 1 }, manifestFor()]);
  bad([{ identity: record.identity }, manifestFor()]);
  bad([record, manifestFor({ financial_epoch: 'other' })]);
  bad([{ identity: { ...record.identity, generationId: 'x' }, identityDigest: record.identityDigest }, manifestFor()]);
  const moved = retirementRecord({ sourceIdentity: { ...retirementIdentity().sourceIdentity, journalRevision: 10 } });
  bad([moved, manifestFor()]);
  assert.throws(() => A.validateCheckpointContinuation(manifestFor({ cut: { continuationEarnings: null, unresolvedObligations: noObligations, completionGuaranteed: false }, sourceRetirement: { ...record, identityDigest: HEX('0') } })), code('CHECKPOINT_SOURCE_RETIREMENT_INVALID'));
});
test('a retiring cut with S ties S to the manifest rows, the retirement record and the unresolved list', () => {
  const S = source(), record = retirementRecord(), unresolved = { count: 1, truncated: false, items: [{ walId: 'wal_1', spendId: 'spend_1', fenceState: 'not_started', continuation: 'record', reason: 'ELIGIBLE' }] };
  const cut = { continuationEarnings: S, unresolvedObligations: unresolved, completionGuaranteed: false };
  assert.equal(A.validateCheckpointContinuation(manifestFor({ cut, sourceRetirement: record })), true);
  const bad = m => assert.throws(() => A.validateCheckpointContinuation(m), code('CHECKPOINT_CONTINUATION_EARNINGS_INVALID'));
  bad(manifestFor({ cut, sourceRetirement: record, files: [{ path: 'financial-epochs/' + EPOCH + '/earnings.json', bytes: 4096, sha256: HEX('0') }, { path: 'financial-epochs/' + EPOCH + '/wal/wal_1.wal.json', bytes: 300, sha256: HEX('1') }] }));
  bad(manifestFor({ cut, sourceRetirement: record, files: [{ path: 'financial-epochs/' + EPOCH + '/earnings.json', bytes: 4096, sha256: HEX('e') }, { path: 'financial-epochs/' + EPOCH + '/wal/wal_1.wal.json', bytes: 300, sha256: HEX('9') }] }));
  bad(manifestFor({ cut, sourceRetirement: record, files: [{ path: 'financial-epochs/' + EPOCH + '/earnings.json', bytes: 4096, sha256: HEX('e') }] }));
  bad(manifestFor({ cut: { ...cut, unresolvedObligations: noObligations }, sourceRetirement: record }));
  bad(manifestFor({ cut: { ...cut, unresolvedObligations: { count: 1, truncated: false, items: [{ ...unresolved.items[0], walId: 'wal_2' }] } }, sourceRetirement: record }));
  bad(manifestFor({ cut, sourceRetirement: record, first_failure_control: { state: 'compensation_requested', compensation: { walId: 'wal_1' } } }));
});

test('eligibility: one fenced, unstarted, acknowledged, pool-free unlock on a retiring cut yields exactly one entry', t => {
  const x = world(t), result = x.evaluate();
  assert.equal(result.completionGuaranteed, false);
  assert.equal(result.continuationEarnings.entries.length, 1);
  const E = result.continuationEarnings.entries[0], wal = A.readWalFiles(x.dir)[0];
  assert.equal(E.walFileSha256, wal.sha256);
  assert.equal(E.walPayloadDigest, hash(wal.entry.payload));
  assert.equal(E.fenceDigest, hash(wal.entry.accrualFence));
  assert.equal(E.drawVectorDigest, A.drawVectorDigest(x.spends.get('spend_1')));
  assert.equal(E.predecessorEquivalenceDigest, null);
  assert.deepEqual(result.unresolvedObligations, { count: 1, truncated: false, items: [{ walId: 'wal_1', spendId: 'spend_1', fenceState: 'not_started', continuation: 'record', reason: 'ELIGIBLE' }] });
  assert.doesNotThrow(() => A.validateContinuationEarnings(result.continuationEarnings, { epochId: EPOCH }));
});
test('an ordinary (non-retiring) cut records no entry and lists the otherwise eligible WAL as SOURCE_NOT_RETIRING', t => {
  const result = world(t, { retiring: false }).evaluate();
  assert.equal(result.continuationEarnings, null);
  assert.equal(result.unresolvedObligations.items[0].reason, 'SOURCE_NOT_RETIRING');
  assert.equal(result.unresolvedObligations.items[0].continuation, 'none');
});
test('two eligible WALs share one pre-image: no entry, both listed AMBIGUOUS_SHARED_PRE_IMAGE', t => {
  const result = world(t, { wals: [['wal_1', 'spend_1'], ['wal_2', 'spend_2']] }).evaluate();
  assert.equal(result.continuationEarnings, null);
  assert.deepEqual(result.unresolvedObligations.items.map(i => [i.walId, i.reason, i.continuation]), [['wal_1', 'AMBIGUOUS_SHARED_PRE_IMAGE', 'none'], ['wal_2', 'AMBIGUOUS_SHARED_PRE_IMAGE', 'none']]);
  assert.equal(result.unresolvedObligations.count, 2);
});
for (const [reason, build] of [
  ['NO_FENCE', t => world(t, { wals: [['wal_1', 'spend_1', { accrualFence: undefined }]] })],
  ['WRITE_STARTED', t => world(t, { wals: [['wal_1', 'spend_1', { accrualFence: { ...walFor('x', spendFor()).accrualFence, state: 'write_started' } }]] })],
  ['WRITE_STARTED', t => world(t, { wals: [['wal_1', 'spend_1', { steps_completed: ['update_learnings', 'update_earnings'] }]] })],
  ['STEP_PREREQUISITE', t => world(t, { wals: [['wal_1', 'spend_1', { steps_completed: [] }]] })],
  ['COMPENSATION_SELECTED', t => world(t, { compensationWalId: 'wal_1' })],
  ['POOL_PRESENT', t => world(t, { pools: ['wal_1'] })],
  ['SOURCE_IDENTITY_UNPROVEN', t => world(t, { identity: { dev: 7, ino: 71, uid: 1000, mode: 0o600, nlink: 1 } })]
]) {
  test('ineligible WAL is listed with reason ' + reason + ' and never recorded', t => {
    const x = build(t), result = x.evaluate();
    assert.equal(result.continuationEarnings, null);
    assert.equal(result.unresolvedObligations.items[0].reason, reason);
    assert.equal(result.unresolvedObligations.items[0].continuation, 'none');
  });
}
test('spend state and draw vector must match: SPEND_STATE for an unacknowledged spend, a digest mismatch or a changed draw', t => {
  const x = world(t);
  x.spends.get('spend_1').state = 'prepared';
  assert.equal(x.evaluate().unresolvedObligations.items[0].reason, 'SPEND_STATE');
  x.spends.get('spend_1').state = 'acknowledged';
  const wal = path.join(x.dir, 'wal_1.wal.json'), body = JSON.parse(fs.readFileSync(wal));
  body.payload.dollar_draws[0].amount = 0.06;
  fs.writeFileSync(wal, JSON.stringify(body));
  assert.equal(x.evaluate().unresolvedObligations.items[0].reason, 'SPEND_STATE');
  body.payload.dollar_draws[0].amount = 0.05; body.accrualFence.spendDigest = HEX('0');
  fs.writeFileSync(wal, JSON.stringify(body));
  assert.equal(x.evaluate().unresolvedObligations.items[0].reason, 'SPEND_STATE');
});
test('a restored source needs its completed plan entry: matching entry gives a predecessor digest, anything else is unproven', t => {
  const identity = { dev: 8, ino: 80, uid: 1000, mode: 0o600, nlink: 1 }, base = world(t, { identity });
  assert.equal(base.evaluate().unresolvedObligations.items[0].reason, 'SOURCE_IDENTITY_UNPROVEN');
  const wal = A.readWalFiles(base.dir)[0], prior = entry({ walFileSha256: wal.sha256, fenceDigest: hash(wal.entry.accrualFence), originalIdentity: { dev: 7, ino: 70 } });
  const ok = world(t, { identity, restored: id => id === 'wal_1' ? { entry: prior, role: { dev: 8, ino: 80 } } : null });
  const walOk = A.readWalFiles(ok.dir)[0], priorOk = entry({ walFileSha256: walOk.sha256, fenceDigest: hash(walOk.entry.accrualFence) });
  ok.ctx.restoredEntryFor = id => id === 'wal_1' ? { entry: priorOk, role: { dev: 8, ino: 80 } } : null;
  const result = ok.evaluate();
  assert.equal(result.continuationEarnings.entries[0].predecessorEquivalenceDigest, hash(priorOk));
  assert.deepEqual(result.continuationEarnings.sourceIdentity, { dev: 8, ino: 80, uid: 1000, mode: 0o600, nlink: 1 });
  for (const patch of [{ role: { dev: 8, ino: 81 } }, { entry: { ...priorOk, walFileSha256: HEX('0') } }, { entry: { ...priorOk, fenceDigest: HEX('0') } }, { entry: { ...priorOk, walId: 'wal_x' } }, { entry: { ...priorOk, originalIdentity: { dev: 1, ino: 1 } } }]) {
    ok.ctx.restoredEntryFor = () => ({ entry: priorOk, role: { dev: 8, ino: 80 }, ...patch });
    assert.equal(ok.evaluate().unresolvedObligations.items[0].reason, 'SOURCE_IDENTITY_UNPROVEN', JSON.stringify(Object.keys(patch)));
  }
});
test('more than eight pending unlock WALs are counted, truncated and sorted', t => {
  const wals = Array.from({ length: 10 }, (_, i) => ['wal_' + String(i).padStart(2, '0'), 'spend_' + i, { accrualFence: undefined }]);
  const result = world(t, { wals }).evaluate();
  assert.equal(result.unresolvedObligations.count, 10);
  assert.equal(result.unresolvedObligations.truncated, true);
  assert.deepEqual(result.unresolvedObligations.items.map(i => i.walId), wals.slice(0, 8).map(w => w[0]));
});
test('WAL reading refuses symlinks, hard links and a file whose name is not its id; other operations are not listed', t => {
  const x = world(t);
  fs.writeFileSync(path.join(x.dir, 'withdraw_1.wal.json'), JSON.stringify({ id: 'withdraw_1', operation: 'withdraw', payload: {}, steps_completed: [] }));
  assert.equal(x.evaluate().unresolvedObligations.count, 1);
  fs.writeFileSync(path.join(x.dir, 'wrong.wal.json'), JSON.stringify({ id: 'other', operation: 'unlock' }));
  assert.throws(() => A.readWalFiles(x.dir), code('CHECKPOINT_WAL_UNREADABLE'));
  fs.rmSync(path.join(x.dir, 'wrong.wal.json'));
  fs.linkSync(path.join(x.dir, 'wal_1.wal.json'), path.join(x.dir, 'wal_1.link'));
  assert.throws(() => A.readWalFiles(x.dir), code('CHECKPOINT_WAL_UNREADABLE'));
});

function targetWorld() {
  const S = source(), lineage = { checkpointDigest: HEX('b'), restoreId: HEX('c'), barrierDigest: HEX('d'), epochId: EPOCH, bindingDigest: HEX('9'), successorDigest: HEX('f') };
  const earnings = { digest: S.sha256, bytes: Buffer.alloc(S.bytes), identity: { dev: 9, ino: 90, bytes: S.bytes, allocatedBytes: 4096, uid: 1000, mode: 0o600, nlink: 1 } };
  return { S, lineage, earnings, ...A.buildTarget({ source: S, earnings, lineage }) };
}
test('buildTarget binds the new inode and the cut digest; the role carries the entry digest', () => {
  const w = targetWorld();
  assert.equal(w.target.cutDigest, hash(w.S));
  assert.deepEqual(w.target.earnings.targetIdentity, { dev: 9, ino: 90 });
  assert.equal(w.role.entryDigest, hash(w.target));
  assert.deepEqual(w.target.lineage, w.lineage);
  assert.deepEqual(Object.keys(w.target.lineage).sort(), ['barrierDigest', 'bindingDigest', 'checkpointDigest', 'epochId', 'restoreId', 'successorDigest'], 'no competing flat generation field');
  assert.equal(Object.hasOwn(w.S, 'generationId'), false);
  assert.throws(() => A.buildTarget({ source: w.S, earnings: { ...w.earnings, digest: HEX('0') }, lineage: w.lineage }), code('RESTORE_CONTINUATION_IDENTITY'));
  assert.throws(() => A.buildTarget({ source: null, earnings: w.earnings, lineage: w.lineage }), code('RESTORE_CONTINUATION_INVALID'));
});

function claimWorld() {
  const record = retirementRecord(), manifest = { ...manifestFor({ sourceRetirement: record }), checksum: HEX('c') }, allowance = { requestId: HEX('a') };
  const claim = { schema: 1, state: 'intent', restoreId: HEX('a'), generationId: record.identity.generationId, initializationDigest: HEX('5'), checkpointDigest: HEX('c'), successorDigest: null };
  return { manifest, allowance, claim, initDigest: HEX('5'), recorded: { ...claim, state: 'recorded', successorDigest: HEX('6') } };
}
test('body.claim keeps all four identity fields in BOTH states (D2.1) and validateClaim refuses invalid shape, conflict and regression', () => {
  const w = claimWorld();
  assert.equal(A.generationOf(w.manifest), w.claim.generationId);
  for (const claim of [w.claim, w.recorded]) {
    assert.deepEqual(Object.keys(claim).sort(), ['checkpointDigest', 'generationId', 'initializationDigest', 'restoreId', 'schema', 'state', 'successorDigest']);
    assert.equal(A.validateClaim(claim, w), claim);
    assert.ok(len(claim) <= 512);
  }
  const { initializationDigest, ...missing } = w.recorded;
  for (const bad of [missing, { ...w.claim, extra: 1 }, { ...w.claim, state: 'other' }, { ...w.claim, successorDigest: HEX('6') }, { ...w.recorded, successorDigest: null }, { ...w.claim, restoreId: 'x' }, { ...w.claim, schema: 2 }]) {
    assert.throws(() => A.validateClaim(bad, w), code('RESTORE_CLAIM_INVALID'), JSON.stringify(Object.keys(bad)));
  }
  assert.throws(() => A.validateClaim({ ...w.claim, restoreId: HEX('b') }, w), code('RESTORE_CLAIM_CONFLICT'));
  assert.throws(() => A.validateClaim({ ...w.claim, generationId: HEX('b') }, w), code('RESTORE_CLAIM_CONFLICT'));
  assert.throws(() => A.validateClaim({ ...w.claim, initializationDigest: HEX('b') }, w), code('RESTORE_CLAIM_CONFLICT'));
  assert.throws(() => A.validateClaim({ ...w.claim, checkpointDigest: HEX('b') }, w), code('RESTORE_CLAIM_CONFLICT'));
  assert.throws(() => A.validateClaim(w.claim, { ...w, allowance: { requestId: HEX('b') } }), code('RESTORE_CLAIM_CONFLICT'));
});
test('claim write transitions: intent then recorded, never back, no identity change, successorDigest fixed once set', () => {
  const w = claimWorld(), regress = (a, b) => assert.throws(() => A.validateClaimTransition(a, b), code('RESTORE_CLAIM_REGRESSION'));
  assert.equal(A.validateClaimTransition(null, w.claim), true);
  assert.equal(A.validateClaimTransition(w.claim, w.claim), true);
  assert.equal(A.validateClaimTransition(w.claim, w.recorded), true);
  assert.equal(A.validateClaimTransition(w.recorded, w.recorded), true);
  regress(null, w.recorded);
  regress(w.recorded, w.claim);
  regress(w.recorded, { ...w.recorded, successorDigest: HEX('7') });
  for (const key of ['restoreId', 'generationId', 'initializationDigest', 'checkpointDigest']) regress(w.claim, { ...w.recorded, [key]: HEX('0') });
  assert.throws(() => A.validateClaimTransition(w.claim, { ...w.recorded, extra: 1 }), code('RESTORE_CLAIM_INVALID'));
});
test('successorClaim: exact four keys, at most 512 B', () => {
  const sc = { generationId: HEX('a'), restoreId: HEX('b'), initializationDigest: HEX('c'), successorDigest: HEX('d') };
  assert.equal(A.validateSuccessorClaim(sc), sc);
  assert.equal(A.validateSuccessorClaim(null), null);
  for (const bad of [{ ...sc, extra: 1 }, { ...sc, successorDigest: 'x' }, (({ restoreId, ...rest }) => rest)(sc)]) assert.throws(() => A.validateSuccessorClaim(bad), code('RESTORE_CLAIM_INVALID'));
});
test('authorized recovery set RS is the continuation entry plus any inherited selected compensation, nothing else', () => {
  const w = targetWorld(), plan = { continuationEarnings: w.target, compensationEarnings: { spendId: 'spend_c', walId: 'wal_c' } };
  const rs = A.recoveryAuthoritySet(plan);
  assert.deepEqual([...rs.spendIds].sort(), ['spend_1', 'spend_c']);
  assert.deepEqual([...rs.walIds].sort(), ['wal_1', 'wal_c']);
  assert.equal(A.anchorInRecoverySet({ kind: 'spend', id: 'spend_1' }, rs), true);
  assert.equal(A.anchorInRecoverySet({ kind: 'unlock_wal', id: 'wal_c' }, rs), true);
  assert.equal(A.anchorInRecoverySet({ kind: 'spend', id: 'wal_1' }, rs), false, 'kinds do not cross namespaces');
  assert.equal(A.anchorInRecoverySet({ kind: 'spend', id: 'spend_2' }, rs), false);
  assert.equal(A.anchorInRecoverySet({ kind: 'projection', id: 'spend_1' }, rs), false);
  assert.equal(A.recoveryAuthoritySet({ continuationEarnings: null, compensationEarnings: null }).spendIds.size, 0);
  assert.equal(A.recoveryAuthoritySet({}).walIds.size, 0, 'pre-A2 plan');
  assert.equal(A.recoveryAuthoritySet({ compensationEarnings: { spendId: 's', walId: null } }).walIds.size, 0);
});

function consumption(patch = {}) {
  const w = targetWorld(), spend = spendFor(), walEntry = walFor('wal_1', spend), walBytes = Buffer.from(JSON.stringify(walEntry));
  const E = { ...w.target.entries[0], walId: 'wal_1', walFileSha256: A.sha256(walBytes), walPayloadDigest: hash(walEntry.payload), fenceDigest: hash(walEntry.accrualFence), spendId: spend.id, spendDigest: spend.digest, drawVectorDigest: A.drawVectorDigest(spend), earningsBeforeDigest: w.S.sha256, originalIdentity: walEntry.accrualFence.earningsFileIdentity };
  const target = { ...w.target, entries: [E] }, role = { ...w.role, entryDigest: hash(target) };
  const epoch = { epoch_id: EPOCH, binding_digest: HEX('9') };
  const plan = { checkpointDigest: w.lineage.checkpointDigest, restoreId: w.lineage.restoreId, barrierDigest: w.lineage.barrierDigest, continuationEarnings: target, successorClaim: { generationId: HEX('1'), restoreId: w.lineage.restoreId, initializationDigest: HEX('5'), successorDigest: w.lineage.successorDigest }, roles: { continuation_earnings: role } };
  return { body: { plan }, epoch, entry: walEntry, walBytes, fence: walEntry.accrualFence, spend, actual: { dev: 9, ino: 90, sha256: w.S.sha256, bytes: w.S.bytes }, failure: { state: 'failure_pending' }, ...patch };
}
test('consumption accepts exactly the minted target, and every failed check names its closed-enum check', () => {
  assert.equal(A.verifyRestoredContinuation(consumption()), true);
  const refused = (name, input) => assert.throws(() => A.verifyRestoredContinuation(input), error => error.code === 'COMPENSATION_ACCRUAL_CONFLICT' && error.check === name && !Object.keys(error).includes('check'), name);
  const c = consumption(), plan = c.body.plan;
  refused('NO_RESTORE_BINDING', consumption({ body: {} }));
  refused('RECORD_ABSENT', consumption({ body: { plan: { ...plan, continuationEarnings: undefined } } }));
  refused('RECORD_ABSENT', consumption({ body: { plan: { ...plan, continuationEarnings: null } } }));
  refused('ENTRY_MISSING', consumption({ body: { plan: { ...plan, continuationEarnings: { ...plan.continuationEarnings, entries: [] } } } }));
  refused('ENTRY_DUPLICATE', consumption({ body: { plan: { ...plan, continuationEarnings: { ...plan.continuationEarnings, entries: [plan.continuationEarnings.entries[0], plan.continuationEarnings.entries[0]] } } } }));
  refused('LINEAGE', consumption({ body: { plan: { ...plan, checkpointDigest: HEX('0') } } }));
  refused('LINEAGE', consumption({ body: { plan: { ...plan, restoreId: HEX('0') } } }));
  refused('LINEAGE', consumption({ body: { plan: { ...plan, barrierDigest: HEX('0') } } }));
  refused('LINEAGE', consumption({ epoch: { epoch_id: 'other', binding_digest: HEX('9') } }));
  refused('LINEAGE', consumption({ epoch: { epoch_id: EPOCH, binding_digest: HEX('0') } }));
  refused('LINEAGE', consumption({ body: { plan: { ...plan, successorClaim: null } } }));
  refused('LINEAGE', consumption({ body: { plan: { ...plan, successorClaim: { ...plan.successorClaim, successorDigest: HEX('0') } } } }));
  refused('LINEAGE', consumption({ body: { plan: { ...plan, roles: { continuation_earnings: { ...plan.roles.continuation_earnings, entryDigest: HEX('0') } } } } }));
  refused('ENTRY_MISSING', consumption({ entry: { ...c.entry, id: 'wal_other' } }));
  refused('WAL_FILE', consumption({ walBytes: Buffer.from('{}') }));
  refused('WAL_FILE', consumption({ entry: { ...c.entry, payload: { ...c.entry.payload, extra: 1 } } }));
  refused('FENCE', consumption({ fence: { ...c.fence, state: 'write_started' } }));
  refused('FENCE', consumption({ fence: { ...c.fence, earningsBeforeDigest: HEX('0') } }));
  refused('SPEND', consumption({ spend: { ...c.spend, digest: HEX('0') } }));
  refused('SPEND', consumption({ spend: null }));
  refused('DRAW_VECTOR', consumption({ spend: { ...c.spend, intent: { ...c.spend.intent, participantDraws: [{ ...c.spend.intent.participantDraws[0], amountMicros: 49999 }] } } }));
  refused('EARNINGS_DIGEST', consumption({ actual: { ...c.actual, sha256: HEX('0') } }));
  refused('EARNINGS_DIGEST', consumption({ actual: { ...c.actual, bytes: c.actual.bytes + 1 } }));
  refused('TARGET_IDENTITY', consumption({ actual: { ...c.actual, ino: 91 } }));
  refused('TARGET_IDENTITY', consumption({ actual: { ...c.actual, dev: 10 } }));
  refused('FAILURE_STATE', consumption({ failure: { state: 'compensation_requested' } }));
});
