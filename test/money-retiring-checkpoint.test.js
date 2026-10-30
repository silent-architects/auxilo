'use strict';
// A2 provider lane, checkpoint side (v3 8.1-8.2, Addendum 2 D1.5/D1.7): explicit retirement, the S0-S3 sequence,
// crash cuts and re-runs, replacement checkpoints. Pure JS: the SQL snapshot and the atomic cut are replaced by
// stubs that keep the one property that constrains ordering (the disk control must still equal the runtime's
// control when the cut is taken, money-atomic-restore.js inspectCheckpointEpoch).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const proxyquire = require('proxyquire').noCallThru();
const real = require('../lib/financial-epoch'), p = require('../lib/stripe-transfer-persistence'), A = require('../lib/money-continuation-authority');
const { HEX, syntheticEpoch } = require('./helpers/money-synthetic-epoch');
const EPOCH = 'epoch-a2', hash = p.digestJSON, sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex'), code = c => error => error.code === c;
const lifecycle = { schema_version: 1, rule_version: 'synthetic', approval_ref: 'synthetic', deletion_barrier: { sequence: 0, hash: 'a'.repeat(64) }, seals: [], records: [], holds: [] };
const SOURCE_SHA = 'c'.repeat(40);

function spendFor() {
  const participantDraws = [{ lotId: 'lot_1', kind: 'dollar_paid', amountMicros: 50000, sourceId: 'source_1', promoReceiptId: null }];
  const intent = { id: 'spend_1', accountId: 'buyer', draws: [{ sourceId: 'source_1', amountMicros: 50000 }], participantDraws };
  return { ...intent, intent, digest: hash(intent), state: 'acknowledged' };
}
const NOW = Date.parse('2026-10-11T12:00:00.000Z'); // fixed test clock: checkpoint expiry is judged against it, never the real clock
function fixture(t, { atomic = true, withWal = true, compensationStage = false } = {}) {
  const x = syntheticEpoch(t);
  const spend = spendFor(), earningsBytes = Buffer.from('{"maker":{}}\n');
  fs.writeFileSync(path.join(x.dir, 'earnings.json'), earningsBytes, { mode: 0o600 });
  fs.writeFileSync(path.join(x.dir, 'money-control.sqlite'), Buffer.alloc(4096, 1), { mode: 0o600 });
  fs.mkdirSync(path.join(x.dir, 'wal'), { mode: 0o700 });
  const earningsStat = fs.statSync(path.join(x.dir, 'earnings.json'));
  if (withWal) {
    const wal = { id: 'wal_1', operation: 'unlock', payload: { funding_source: 'credit_pack', purchaser_account_id: 'buyer', dollar_draws: [{ lot_id: 'lot_1', kind: 'dollar_paid', amount: 0.05, spend_id: spend.id, inflight_marked: true }] },
      accrualFence: { schema: 1, state: 'not_started', spendId: spend.id, spendDigest: spend.digest, earningsBeforeDigest: sha(earningsBytes), earningsFileIdentity: { dev: earningsStat.dev, ino: earningsStat.ino } }, steps_completed: ['update_learnings'], created_at: 1 };
    fs.writeFileSync(path.join(x.dir, 'wal', 'wal_1.wal.json'), JSON.stringify(wal), { mode: 0o600 });
  }
  const epoch = { epoch_id: EPOCH, binding_digest: x.binding.binding_digest, financial_dir: x.dir, legacy_root: x.root, activation_revision: 0 };
  const spends = [];
  const state = { calls: [], runtimeControl: hash(real.readEpochControl(x.root).control), spends, atomic, compensationStage };
  const store = {
    epoch, readMetadata: () => ({ database_id: 'db-synthetic-0001', revision: 9, sequence: 4 }), getCapacityRecord: () => undefined, closeForMaintenance: () => state.calls.push('closeForMaintenance'), reopenAfterMaintenance: () => state.calls.push('reopen'),
    listSpends: () => ({ items: spends, nextCursor: null }), getSpend: id => id === spend.id ? spend : undefined, getPool: () => undefined
  };
  const fe = { ...real, pathFor: (name, ep) => path.join(ep.financial_dir, real.PARTICIPANTS[name]), requireEpoch: () => ({ binding: x.binding, control: real.readEpochControl(x.root).control }) };
  const restoreStub = {
    inspectCheckpointEpoch({ root, sourceEpoch }) {
      state.calls.push('semantic');
      if (hash(real.readEpochControl(root).control) !== state.runtimeControl) throw Object.assign(new Error('CHECKPOINT_STORE_IDENTITY'), { code: 'CHECKPOINT_STORE_IDENTITY' });
      return { epoch: sourceEpoch, snapshot: { schema: 1, revision: 9, sequence: 4, lifecycle: { compaction_epoch: 0 } }, unresolved: [], receiptHighwater: [], pendingSpends: [], pendingProjections: [], ...(state.compensationStage ? { stageAuthority: {}, compensationStage: { relativePath: 'x', sha256: HEX('0'), bytes: 1 } } : {}) };
    },
    checkpointAtomicCut({ epoch: current, retiring }) {
      state.calls.push('cut:' + (retiring ? 'retiring' : 'ordinary'));
      if (!state.atomic) return null;
      const walDir = path.join(current.financial_dir, 'wal'), owned = fs.statSync(path.join(current.financial_dir, 'earnings.json'));
      const ctx = { getSpend: id => store.getSpend(id), hasPool: () => false, earnings: () => ({ sha256: sha(earningsBytes), bytes: earningsBytes.length, identity: { dev: owned.dev, ino: owned.ino, uid: owned.uid, mode: 0o600, nlink: 1 } }), compensationWalId: null, restoredEntryFor: () => null };
      return { cut: { compensationEarnings: null, ...A.evaluateObligations({ wals: A.readWalFiles(walDir), retiring, ctx, epochId: EPOCH }) }, padding: [] };
    }
  };
  const cp = proxyquire('../lib/money-checkpoint', { './financial-epoch': fe, './money-atomic-restore': restoreStub });
  const coordinator = { maintenanceLease: fn => fn({ store }) };
  const boot = () => { state.runtimeControl = hash(real.readEpochControl(x.root).control); };
  const base = () => ({ epoch, writer: x.writer, coordinator, sourceSha: SOURCE_SHA, lifecycleControl: lifecycle, clock: () => NOW });
  const manifestOf = result => p.readJSONStrict(path.join(x.root, '.money-checkpoints', result.checkpoint_id, 'money-checkpoint-manifest.json'));
  const archivedControl = result => {
    const dir = path.join(x.root, '.money-checkpoints', result.checkpoint_id), manifest = manifestOf(result);
    let parts = null, found = null;
    cp.scanCheckpointArchive(path.join(dir, cp.ARCHIVE), manifest, { start(row) { parts = row.path === 'financial-epochs/' + EPOCH + '/epoch-control.json' ? [] : null; }, chunk(_r, bytes) { parts?.push(Buffer.from(bytes)); }, end() { if (parts) found = JSON.parse(Buffer.concat(parts)); parts = null; } });
    return found;
  };
  const controlBytes = () => fs.readFileSync(x.controlFile);
  return { ...x, epoch, spend, state, store, cp, now: NOW, base, boot, manifestOf, archivedControl, controlBytes, spends, earningsStat, walRow: () => 'financial-epochs/' + EPOCH + '/wal/wal_1.wal.json' };
}

test('the ordinary entry point never retires: control bytes identical, no sourceRetirement, WAL listed SOURCE_NOT_RETIRING, result reports the open obligation', async t => {
  const f = fixture(t), before = f.controlBytes();
  const result = await f.cp.createMoneyCheckpoint(f.base());
  assert.deepEqual(f.controlBytes(), before);
  const m = f.manifestOf(result);
  assert.equal(Object.hasOwn(m, 'sourceRetirement'), false);
  assert.equal(m.atomic_capacity_cut.continuationEarnings, null);
  assert.equal(m.atomic_capacity_cut.completionGuaranteed, false);
  assert.deepEqual(m.atomic_capacity_cut.unresolvedObligations, { count: 1, truncated: false, items: [{ walId: 'wal_1', spendId: 'spend_1', fenceState: 'not_started', continuation: 'none', reason: 'SOURCE_NOT_RETIRING' }] });
  assert.equal(result.unresolved_obligations, 1);
  assert.equal(result.completion_guaranteed, false);
  assert.equal(f.cp.validateCheckpointEnvelope(path.join(f.root, '.money-checkpoints', result.checkpoint_id), { now: f.now }).checksum, m.checksum);
  assert.ok(f.state.calls.includes('cut:ordinary'));
});
test('createRetiringCheckpoint without a valid approvalRef refuses before any write', async t => {
  const f = fixture(t), before = f.controlBytes();
  for (const approvalRef of [undefined, '', 'has space', 'a'.repeat(257), 5, 'a"b']) await assert.rejects(f.cp.createRetiringCheckpoint({ ...f.base(), approvalRef }), code('CHECKPOINT_RETIRE_APPROVAL_REQUIRED'));
  assert.deepEqual(f.controlBytes(), before);
  assert.equal(fs.existsSync(path.join(f.root, '.money-checkpoints')), false);
});
test('public options cannot smuggle retirement into the ordinary entry point', async t => {
  const f = fixture(t), before = f.controlBytes();
  await f.cp.createMoneyCheckpoint({ ...f.base(), retire: { approvalRef: 'approval:x' }, approvalRef: 'approval:x', retiring: true });
  assert.deepEqual(f.controlBytes(), before);
});
test('S0-S3 in order: retire after the semantic snapshot and cut, the archive carries R retiring, the final control is retired and published', async t => {
  const f = fixture(t), steps = [];
  const result = await f.cp.createRetiringCheckpoint({ ...f.base(), approvalRef: 'approval:retire-1', afterStep: s => steps.push(s) });
  assert.deepEqual(steps.filter(s => s.startsWith('retire:') || s === 'checkpoint:published' || s === 'files:durable'), ['retire:written', 'files:durable', 'checkpoint:published', 'retire:published', 'retire:finalized']);
  assert.ok(f.state.calls.indexOf('semantic') < f.state.calls.indexOf('cut:retiring'), 'snapshot then cut');
  const m = f.manifestOf(result), control = f.readControl(), R = control.retirement;
  assert.equal(control.schema_version, 2);
  assert.equal(control.state, 'paused');
  assert.ok(Object.values(control.capabilities).every(v => v === false));
  assert.equal(control.generation, 2, 'S1 and S3 each advance the revision');
  assert.equal(R.state, 'retired');
  assert.equal(R.publishedCheckpointDigest, m.checksum);
  assert.equal(R.successor, null);
  assert.deepEqual(m.sourceRetirement, { identity: R.identity, identityDigest: R.identityDigest });
  assert.equal(R.identityDigest, hash(R.identity));
  const P = R.identity, rootStat = fs.statSync(f.root), lockStat = fs.statSync(path.join(f.root, '.money-writer.lock')), dbStat = fs.statSync(path.join(f.dir, 'money-control.sqlite'));
  assert.deepEqual(P.sourceIdentity.root, { dev: rootStat.dev, ino: rootStat.ino });
  assert.deepEqual(P.sourceIdentity.lock, { dev: lockStat.dev, ino: lockStat.ino });
  assert.deepEqual(P.sourceIdentity.sqlite, { dev: dbStat.dev, ino: dbStat.ino });
  assert.equal(P.sourceIdentity.databaseId, 'db-synthetic-0001');
  assert.equal(P.sourceIdentity.journalRevision, 9);
  assert.equal(P.sourceIdentity.epochId, EPOCH);
  assert.equal(P.sourceIdentity.bindingDigest, f.binding.binding_digest);
  assert.equal(P.retiredAtGeneration, 1);
  assert.equal(P.retiredAt, '2026-10-11T12:00:00.000Z');
  assert.equal(P.approvalRef, 'approval:retire-1');
  assert.match(P.generationId, /^[a-f0-9]{64}$/);
  const archived = f.archivedControl(result);
  assert.equal(archived.retirement.state, 'retiring', 'the archive was packed after S1 and before S3');
  assert.equal(archived.retirement.identityDigest, R.identityDigest);
  const S = m.atomic_capacity_cut.continuationEarnings, E = S.entries[0];
  assert.equal(E.walId, 'wal_1');
  assert.equal(E.walFileSha256, m.files.find(r => r.path === f.walRow()).sha256);
  assert.equal(S.sha256, m.files.find(r => r.path === S.relativePath).sha256);
  assert.equal(m.atomic_capacity_cut.completionGuaranteed, false);
  assert.equal(result.retirement.generation_id, P.generationId);
  assert.equal(result.unresolved_obligations, 1);
  assert.equal(f.cp.validateCheckpointEnvelope(path.join(f.root, '.money-checkpoints', result.checkpoint_id), { now: f.now }).checksum, m.checksum);
  assert.deepEqual(real.validateRetirement(R), R);
});
test('an ordinary checkpoint of a retired source is refused, and a mismatching approvalRef cannot re-run it', async t => {
  const f = fixture(t);
  await f.cp.createRetiringCheckpoint({ ...f.base(), approvalRef: 'approval:retire-1' });
  f.boot();
  const before = f.controlBytes();
  await assert.rejects(f.cp.createMoneyCheckpoint(f.base()), code('EPOCH_RETIRED'));
  await assert.rejects(f.cp.createRetiringCheckpoint({ ...f.base(), approvalRef: 'approval:other' }), code('CHECKPOINT_RETIRE_APPROVAL_MISMATCH'));
  assert.deepEqual(f.controlBytes(), before);
});
test('refusals that precede S1 leave the source live: non-atomic epoch, compensation stage', async t => {
  for (const [name, options, expected] of [['non-atomic', { atomic: false }, 'CHECKPOINT_RETIRE_ATOMIC_REQUIRED'], ['stage', { compensationStage: true }, 'CHECKPOINT_RETIRE_COMPENSATION_STAGE_UNSUPPORTED']]) {
    const f = fixture(t, options), before = f.controlBytes();
    await assert.rejects(f.cp.createRetiringCheckpoint({ ...f.base(), approvalRef: 'approval:retire-1' }), code(expected), name);
    assert.deepEqual(f.controlBytes(), before, name);
    assert.equal(f.readControl().retirement, undefined, name);
  }
});
test('retirement is only an explicit operation: a failure at the semantic step retires nothing', async t => {
  const f = fixture(t), before = f.controlBytes();
  f.state.runtimeControl = HEX('0');
  await assert.rejects(f.cp.createRetiringCheckpoint({ ...f.base(), approvalRef: 'approval:retire-1' }), code('CHECKPOINT_STORE_IDENTITY'));
  assert.deepEqual(f.controlBytes(), before);
});
for (const cutName of ['retire:written', 'retire:published', 'retire:finalized']) {
  test('crash cut ' + cutName + ': a cold re-run reuses P byte for byte, never a second generation, and ends retired with a published checkpoint (D1.7e)', async t => {
    const f = fixture(t), crash = new Error('CRASH_' + cutName);
    await assert.rejects(f.cp.createRetiringCheckpoint({ ...f.base(), approvalRef: 'approval:retire-1', afterStep: s => { if (s === cutName) throw crash; } }), error => error === crash);
    const middle = f.readControl(), P = middle.retirement.identity, expectedStateAfterCrash = cutName === 'retire:finalized' ? 'retired' : 'retiring';
    assert.equal(middle.retirement.state, expectedStateAfterCrash);
    f.boot(); // a fresh source process, started from the retiring control
    const again = await f.cp.createRetiringCheckpoint({ ...f.base(), approvalRef: 'approval:retire-1', clock: () => Date.parse('2027-01-01T00:00:00.000Z') });
    const final = f.readControl(), m = f.manifestOf(again);
    assert.deepEqual(final.retirement.identity, P, 'identity untouched, including retiredAt');
    assert.equal(final.retirement.identityDigest, hash(P));
    assert.equal(final.retirement.state, 'retired');
    assert.deepEqual(m.sourceRetirement, { identity: P, identityDigest: hash(P) });
    assert.equal(P.retiredAt, '2026-10-11T12:00:00.000Z');
    if (cutName === 'retire:finalized') assert.deepEqual(final, middle, 'after S3 the re-run is a replacement and writes no control byte');
    else {
      assert.equal(final.retirement.publishedCheckpointDigest, m.checksum);
      assert.equal(final.generation, 2);
    }
    assert.equal(A.generationOf(m), P.generationId);
    assert.equal(m.atomic_capacity_cut.continuationEarnings.entries.length, 1, 'S is rebuilt from durable state');
  });
}
test('replacement checkpoints of a retired source copy P verbatim: same generation and identityDigest, different checkpoint', async t => {
  const f = fixture(t), first = await f.cp.createRetiringCheckpoint({ ...f.base(), approvalRef: 'approval:retire-1' });
  f.boot();
  const frozen = f.controlBytes(), second = await f.cp.createRetiringCheckpoint({ ...f.base(), approvalRef: 'approval:retire-1' });
  assert.deepEqual(f.controlBytes(), frozen, 'a replacement changes no control byte');
  const a = f.manifestOf(first), b = f.manifestOf(second);
  assert.notEqual(first.checkpoint_id, second.checkpoint_id);
  assert.notEqual(a.checksum, b.checksum);
  assert.deepEqual(a.sourceRetirement, b.sourceRetirement);
  assert.equal(A.generationOf(a), A.generationOf(b));
  assert.equal(f.readControl().retirement.publishedCheckpointDigest, a.checksum, 'published digest is set once, by S3');
});
test('a re-run or replacement refuses to publish a record for a source that moved', async t => {
  const f = fixture(t);
  await f.cp.createRetiringCheckpoint({ ...f.base(), approvalRef: 'approval:retire-1' });
  f.boot();
  const db = path.join(f.dir, 'money-control.sqlite'), bytes = fs.readFileSync(db), inoBefore = fs.statSync(db).ino;
  // Same bytes on a NEW inode: write the replacement beside the original and rename it over, so both inodes exist together (remove-then-write lets Linux
  // reuse the freed inode number, which left the source unmoved).
  fs.writeFileSync(db + '.moved', bytes, { mode: 0o600 }); fs.renameSync(db + '.moved', db);
  assert.notEqual(fs.statSync(db).ino, inoBefore, 'the fixture must really present a moved source');
  await assert.rejects(f.cp.createRetiringCheckpoint({ ...f.base(), approvalRef: 'approval:retire-1' }), code('CHECKPOINT_RETIRE_IDENTITY_CHANGED'));
});
test('a retired source runs maintenance only: a prepared spend with a receipt refuses CHECKPOINT_RETIRED_PENDING_ACK and nothing is acknowledged', async t => {
  const f = fixture(t);
  await f.cp.createRetiringCheckpoint({ ...f.base(), approvalRef: 'approval:retire-1' });
  f.boot();
  const spend = { ...f.spend, state: 'prepared' };
  f.spends.push(spend);
  fs.writeFileSync(path.join(f.dir, 'credits.json'), JSON.stringify({ buyer: { money_receipts: { [spend.id]: { projection_id: spend.id, digest: spend.digest } } } }));
  await assert.rejects(f.cp.createRetiringCheckpoint({ ...f.base(), approvalRef: 'approval:retire-1' }), code('CHECKPOINT_RETIRED_PENDING_ACK'));
});
