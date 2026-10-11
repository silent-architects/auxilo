'use strict';
// A2 provider lane, restore side (v3 8.3-8.4, Addendum 1 A2/A3, Addendum 2 D1.5/D2): the source identity check, the
// single claim at the source control, the resume predicate and the claim state machine, with crash cuts at every hook.
// Pure JS against a synthetic retired source directory; the physical restore itself is covered by the native tests.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const R = require('../lib/money-atomic-restore'), A = require('../lib/money-continuation-authority'), op = require('../lib/financial-epoch-operator'), e = require('../lib/financial-epoch'), p = require('../lib/stripe-transfer-persistence'), lock = require('../lib/money-writer-lock');
const { HEX, syntheticEpoch } = require('./helpers/money-synthetic-epoch');
const hash = p.digestJSON, code = c => error => error.code === c;
const META = { database_id: 'db-synthetic-0001', revision: 9 };

function sourceWorld(t, { finalize = true } = {}) {
  const x = syntheticEpoch(t);
  fs.writeFileSync(path.join(x.dir, 'money-control.sqlite'), Buffer.alloc(4096, 1), { mode: 0o600 });
  const phys = file => { const s = fs.lstatSync(file); return { dev: s.dev, ino: s.ino }; };
  const identity = {
    schema: 1, generationId: crypto.createHash('sha256').update('generation-' + x.root).digest('hex'), approvalRef: 'approval:retire-1', retiredAt: '2026-10-11T12:00:00.000Z', retiredAtGeneration: 1,
    sourceIdentity: { root: phys(x.root), lock: phys(path.join(x.root, '.money-writer.lock')), sqlite: phys(path.join(x.dir, 'money-control.sqlite')), databaseId: META.database_id, bindingDigest: x.binding.binding_digest, epochId: x.binding.identity.epoch_id, journalRevision: 9 }
  };
  op.retireEpochControl({ root: x.root, writer: x.writer, expectedRevision: 0, identity });
  if (finalize) op.finalizeRetirementControl({ root: x.root, writer: x.writer, expectedRevision: 1, publishedCheckpointDigest: HEX('9') });
  const manifestFor = (checksum = HEX('c')) => ({ checksum, financial_epoch: identity.sourceIdentity.epochId, binding_digest: x.binding.binding_digest, journal_revision: 9, sourceRetirement: { identity, identityDigest: hash(identity) } });
  return { ...x, identity, manifestFor, readMetadata: () => ({ ...META }), input: () => ({ sourceRoot: x.root, sourceWriter: x.writer }) };
}
const allowanceFor = n => ({ requestId: HEX(n) });
function targetFor(world, n = 'a', checkpoint = HEX('c')) {
  const manifest = world.manifestFor(checkpoint), allowance = allowanceFor(n), initializationDigest = HEX(n === 'a' ? '5' : '6');
  return { manifest, allowance, initializationDigest };
}
// An in-memory restore-control claim slot: persistClaim validates exactly as the restore does.
function slot(initial = null) {
  const s = { claim: initial, writes: [] };
  s.persist = claim => { A.validateClaimTransition(s.claim, claim); s.claim = claim; s.writes.push(claim.state); };
  return s;
}
function resolve(world, target, claimSlot, { afterStep, input = world.input() } = {}) {
  return R.resolveSuccessor({ ...target, claimInput: input, existingClaim: claimSlot.claim, persistClaim: claimSlot.persist, afterStep, readMetadata: world.readMetadata });
}

test('a genuine retired source verifies; every identity facet is a positive-evidence refusal', t => {
  const w = sourceWorld(t), m = w.manifestFor();
  const pair = R.verifySourceForClaim({ sourceRoot: w.root, sourceWriter: w.writer, manifest: m, readMetadata: w.readMetadata });
  assert.equal(pair.control.retirement.state, 'retired');
  const mismatch = (manifest, check, options = {}) => assert.throws(() => R.verifySourceForClaim({ sourceRoot: w.root, sourceWriter: w.writer, manifest, readMetadata: w.readMetadata, ...options }), error => error.code === 'SOURCE_IDENTITY_MISMATCH' && error.check === check && !Object.keys(error).includes('check'), check);
  const withP = patch => { const identity = { ...m.sourceRetirement.identity, sourceIdentity: { ...m.sourceRetirement.identity.sourceIdentity, ...patch } }; return { ...m, sourceRetirement: { identity, identityDigest: hash(identity) } }; };
  mismatch(withP({ root: { dev: 1, ino: 1 } }), 'ROOT');
  mismatch(withP({ lock: { dev: 1, ino: 1 } }), 'LOCK');
  mismatch(withP({ sqlite: { dev: 1, ino: 1 } }), 'SQLITE');
  mismatch(withP({ bindingDigest: HEX('0') }), 'BINDING');
  mismatch(withP({ epochId: 'other' }), 'BINDING');
  mismatch(m, 'DATABASE', { readMetadata: () => ({ database_id: 'someone-else', revision: 9 }) });
  mismatch(m, 'REVISION', { readMetadata: () => ({ ...META, revision: 8 }) });
  mismatch({ ...m, sourceRetirement: { ...m.sourceRetirement, identityDigest: HEX('0') } }, 'PROJECTION');
  const other = { ...m.sourceRetirement.identity, generationId: HEX('0') };
  mismatch({ ...m, sourceRetirement: { identity: other, identityDigest: hash(other) } }, 'PROJECTION');
});
test('state and generation regressions of the source control are refused (retiring source, control rolled back below the cut)', t => {
  const retiring = sourceWorld(t, { finalize: false });
  assert.throws(() => R.verifySourceForClaim({ sourceRoot: retiring.root, sourceWriter: retiring.writer, manifest: retiring.manifestFor(), readMetadata: retiring.readMetadata }), error => error.code === 'SOURCE_IDENTITY_MISMATCH' && error.check === 'STATE');
  const w = sourceWorld(t), control = w.readControl();
  fs.writeFileSync(w.controlFile, p.canonicalJSON(e.seal({ ...control, generation: 0 })) + '\n');
  assert.throws(() => R.verifySourceForClaim({ sourceRoot: w.root, sourceWriter: w.writer, manifest: w.manifestFor(), readMetadata: w.readMetadata }), error => error.code === 'SOURCE_IDENTITY_MISMATCH' && error.check === 'GENERATION');
  const plain = sourceWorld(t);
  const { retirement, ...rest } = plain.readControl();
  fs.writeFileSync(plain.controlFile, p.canonicalJSON(e.seal({ ...rest, schema_version: 1 })) + '\n');
  assert.throws(() => R.verifySourceForClaim({ sourceRoot: plain.root, sourceWriter: plain.writer, manifest: plain.manifestFor(), readMetadata: plain.readMetadata }), error => error.code === 'SOURCE_IDENTITY_MISMATCH' && error.check === 'NOT_RETIRED');
});
test('tamper: a re-sealed control with a changed projection but the old digest is a mismatch at the claim and invalid on read (D1.7d)', t => {
  const w = sourceWorld(t), control = w.readControl();
  const tampered = e.seal({ ...control, retirement: { ...control.retirement, identity: { ...control.retirement.identity, approvalRef: 'approval:other' } } });
  fs.writeFileSync(w.controlFile, p.canonicalJSON(tampered) + '\n');
  assert.throws(() => e.readEpochControl(w.root), code('RETIREMENT_IDENTITY_INVALID'));
  assert.throws(() => R.verifySourceForClaim({ sourceRoot: w.root, sourceWriter: w.writer, manifest: w.manifestFor(), readMetadata: w.readMetadata }), error => error.code === 'SOURCE_IDENTITY_MISMATCH' && error.check === 'CONTROL');
  const identity = { ...control.retirement.identity, approvalRef: 'approval:other' };
  const recomputed = e.seal({ ...control, retirement: { ...control.retirement, identity, identityDigest: hash(identity) } });
  fs.writeFileSync(w.controlFile, p.canonicalJSON(recomputed) + '\n');
  assert.throws(() => R.verifySourceForClaim({ sourceRoot: w.root, sourceWriter: w.writer, manifest: w.manifestFor(), readMetadata: w.readMetadata }), error => error.code === 'SOURCE_IDENTITY_MISMATCH' && error.check === 'PROJECTION', 'a recomputed digest that differs from the manifest projection');
});
test('copy rejection: a file-level copy of the retired source is SOURCE_IDENTITY_MISMATCH, nothing is written, the genuine claim still succeeds once (A3.4a)', t => {
  const w = sourceWorld(t), copy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'source-copy-')));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.cpSync(w.root, copy, { recursive: true });
  const copyWriter = lock.injectMoneyWriter({ root: copy, assertOwned: () => true }), originalBytes = fs.readFileSync(w.controlFile), copyBytes = fs.readFileSync(path.join(copy, 'financial-epochs', 'epoch-a2', e.CONTROL_FILE));
  const target = targetFor(w);
  assert.throws(() => R.claimSuccessor({ sourceRoot: copy, sourceWriter: copyWriter, manifest: target.manifest, tuple: { restoreId: HEX('a'), initializationDigest: HEX('5'), checkpointDigest: HEX('c') }, readMetadata: w.readMetadata }), code('SOURCE_IDENTITY_MISMATCH'));
  assert.deepEqual(fs.readFileSync(path.join(copy, 'financial-epochs', 'epoch-a2', e.CONTROL_FILE)), copyBytes);
  assert.deepEqual(fs.readFileSync(w.controlFile), originalBytes, 'neither copy nor original gained a successor');
  const s = slot(), refused = resolve(w, target, s, { input: { sourceRoot: copy, sourceWriter: copyWriter } });
  assert.deepEqual(refused, { state: 'refused', code: 'SOURCE_IDENTITY_MISMATCH' });
  assert.deepEqual(s.writes, [], 'no claim intent is recorded for a refused source');
  const genuine = resolve(w, target, slot());
  assert.equal(genuine.state, 'claimed');
  assert.equal(w.readControl().retirement.successor.restoreId, HEX('a'));
});
test('a source that cannot be reached or whose writer is lost HOLDS: RESTORE_SUCCESSOR_HELD, never SOURCE_IDENTITY_MISMATCH', t => {
  const w = sourceWorld(t), target = targetFor(w), aside = w.root + '-aside';
  t.after(() => { try { fs.renameSync(aside, w.root); } catch {} });
  const closed = lock.injectMoneyWriter({ root: w.root, assertOwned: () => { throw Object.assign(Error('MONEY_WRITER_OWNERSHIP_LOST'), { code: 'MONEY_WRITER_OWNERSHIP_LOST' }); } });
  assert.throws(() => resolve(w, target, slot(), { input: { sourceRoot: w.root, sourceWriter: closed } }), code('RESTORE_SUCCESSOR_HELD'));
  fs.renameSync(w.root, aside);
  assert.throws(() => resolve(w, target, slot()), code('RESTORE_SUCCESSOR_HELD'));
  assert.throws(() => resolve(w, target, slot(), { input: { sourceRoot: w.root + '-nowhere', sourceWriter: lock.injectMoneyWriter({ root: w.root + '-nowhere', assertOwned: () => true }) } }), code('RESTORE_SUCCESSOR_HELD'));
  fs.renameSync(aside, w.root);
  assert.throws(() => R.verifySourceForClaim({ sourceRoot: w.root, sourceWriter: w.writer, manifest: target.manifest, readMetadata: () => { throw Object.assign(Error('SQLITE_BUSY'), { code: 'SQLITE_BUSY' }); } }), code('RESTORE_SUCCESSOR_HELD'));
});
test('the claim is one compare-and-set: an identical tuple is an idempotent resume, another tuple is SUCCESSOR_ALREADY_CLAIMED, the digest never moves (D1.7c)', t => {
  const w = sourceWorld(t), target = targetFor(w), tuple = { restoreId: HEX('a'), initializationDigest: HEX('5'), checkpointDigest: HEX('c') };
  const before = w.readControl().retirement.identityDigest;
  const first = R.claimSuccessor({ sourceRoot: w.root, sourceWriter: w.writer, manifest: target.manifest, tuple, readMetadata: w.readMetadata });
  assert.equal(first.written, true);
  assert.deepEqual(first.successor, { ...tuple, claimedAtGeneration: 3 });
  const bytes = fs.readFileSync(w.controlFile);
  const again = R.claimSuccessor({ sourceRoot: w.root, sourceWriter: w.writer, manifest: target.manifest, tuple, readMetadata: w.readMetadata });
  assert.equal(again.written, false);
  assert.deepEqual(fs.readFileSync(w.controlFile), bytes, 'idempotent: no byte moved');
  for (const other of [{ ...tuple, restoreId: HEX('b') }, { ...tuple, initializationDigest: HEX('6') }, { ...tuple, checkpointDigest: HEX('d') }]) {
    assert.throws(() => R.claimSuccessor({ sourceRoot: w.root, sourceWriter: w.writer, manifest: target.manifest, tuple: other, readMetadata: w.readMetadata }), code('SUCCESSOR_ALREADY_CLAIMED'));
  }
  assert.deepEqual(fs.readFileSync(w.controlFile), bytes);
  const control = w.readControl();
  assert.equal(control.retirement.identityDigest, before);
  assert.equal(e.retirementIdentityDigest(control.retirement.identity), before, 'identityDigest is byte-equal before S3, after S3 and after S4');
});
test('resolveSuccessor: no input and no intent is ABSENT; ordinary manifests are not retiring; an intent without an offered source HOLDS', t => {
  const w = sourceWorld(t), target = targetFor(w);
  assert.deepEqual(R.resolveSuccessor({ ...target, claimInput: undefined, existingClaim: null, persistClaim: () => assert.fail('no write') }), { state: 'absent' });
  const { sourceRetirement, ...ordinary } = target.manifest;
  assert.deepEqual(R.resolveSuccessor({ manifest: ordinary, allowance: target.allowance, initializationDigest: target.initializationDigest, claimInput: w.input(), existingClaim: undefined, persistClaim: () => assert.fail('no write') }), { state: 'not_retiring' });
  const intent = { schema: 1, state: 'intent', restoreId: HEX('a'), generationId: w.identity.generationId, initializationDigest: HEX('5'), checkpointDigest: HEX('c'), successorDigest: null };
  assert.throws(() => R.resolveSuccessor({ ...target, claimInput: undefined, existingClaim: intent, persistClaim: () => assert.fail('no write') }), code('RESTORE_SUCCESSOR_HELD'), 'an intent without a source is HELD, never ABSENT (A2.5d variant)');
  assert.equal(w.readControl().retirement.successor, null);
});
test('resolveSuccessor writes intent, then the source CAS, then recorded, in that order, and returns the successor digest', t => {
  const w = sourceWorld(t), target = targetFor(w), s = slot(), steps = [];
  const out = resolve(w, target, s, { afterStep: n => steps.push(n) });
  assert.deepEqual(steps, ['claim:intent-durable', 'claim:cas-durable', 'claim:recorded-durable']);
  assert.deepEqual(s.writes, ['intent', 'recorded']);
  assert.equal(out.state, 'claimed');
  assert.equal(out.successorDigest, hash(w.readControl().retirement.successor));
  assert.equal(s.claim.successorDigest, out.successorDigest);
  for (const k of ['restoreId', 'generationId', 'initializationDigest', 'checkpointDigest']) assert.equal(s.claim[k], { restoreId: HEX('a'), generationId: w.identity.generationId, initializationDigest: HEX('5'), checkpointDigest: HEX('c') }[k], 'identity fields survive the intent -> recorded write');
  assert.equal(A.generationOf(target.manifest), s.claim.generationId);
});
for (const cut of ['claim:intent-durable', 'claim:cas-durable', 'claim:recorded-durable']) {
  test('crash cut ' + cut + ': the same target resumes, the CAS is idempotent, the claim is complete exactly once, the source successor is byte-stable (A2.5a/b, D2.4a/d)', t => {
    const w = sourceWorld(t), target = targetFor(w), s = slot(), crash = new Error('CRASH');
    assert.throws(() => resolve(w, target, s, { afterStep: n => { if (n === cut) throw crash; } }), error => error === crash);
    const sourceAfterCrash = fs.readFileSync(w.controlFile), claimAtCrash = structuredClone(s.claim);
    const resumed = resolve(w, target, s);
    assert.equal(resumed.state, 'claimed');
    assert.equal(s.claim.state, 'recorded');
    for (const k of ['restoreId', 'generationId', 'initializationDigest', 'checkpointDigest']) assert.equal(s.claim[k], claimAtCrash[k], k + ' byte-equal across the crash');
    if (cut !== 'claim:intent-durable') assert.deepEqual(fs.readFileSync(w.controlFile), sourceAfterCrash, 'the source was not rewritten on resume');
    if (cut === 'claim:recorded-durable') assert.deepEqual(s.claim, claimAtCrash, 'the recorded claim is byte-equal to the pre-crash value');
    const second = resolve(w, target, s);
    assert.deepEqual(second.successor, resumed.successor, 'a second restart is a no-op');
    assert.equal(w.readControl().retirement.successor.restoreId, HEX('a'));
    assert.equal(w.readControl().generation, 3, 'exactly one claim write');
  });
}
test('two targets from two checkpoints of one generation: exactly one claims, the other is refused and records no intent; either order (6.11b)', t => {
  for (const order of [['a', 'b'], ['b', 'a']]) {
    const w = sourceWorld(t), firstCheckpoint = HEX('c'), secondCheckpoint = HEX('d');
    const t1 = targetFor(w, order[0], order[0] === 'a' ? firstCheckpoint : secondCheckpoint), t2 = targetFor(w, order[1], order[1] === 'a' ? firstCheckpoint : secondCheckpoint);
    assert.equal(A.generationOf(t1.manifest), A.generationOf(t2.manifest), 'same generation across checkpoints');
    const s1 = slot(), s2 = slot();
    assert.equal(resolve(w, t1, s1).state, 'claimed');
    const bytes = fs.readFileSync(w.controlFile);
    assert.deepEqual(resolve(w, t2, s2), { state: 'refused', code: 'SUCCESSOR_ALREADY_CLAIMED' });
    assert.deepEqual(s2.writes, [], 'the loser records no intent');
    assert.deepEqual(fs.readFileSync(w.controlFile), bytes, 'the source successor names exactly one restoreId, byte-unchanged');
    assert.equal(w.readControl().retirement.successor.restoreId, HEX(order[0]));
    assert.equal(resolve(w, t1, s1).state, 'claimed', 'the winner stays resumable');
  }
});
test('replay on a second target: T1 evidence presented for T2 is a claim conflict; T2 own restore against a replacement checkpoint is refused (D2.4b)', t => {
  const w = sourceWorld(t), t1 = targetFor(w, 'a'), t2 = targetFor(w, 'b', HEX('d')), s1 = slot();
  resolve(w, t1, s1);
  assert.throws(() => A.validateClaim(s1.claim, { allowance: t2.allowance, manifest: t2.manifest, initDigest: t2.initializationDigest }), code('RESTORE_CLAIM_CONFLICT'), "T1's restore control (with its claim) copied into T2");
  assert.throws(() => R.resolveSuccessor({ ...t2, claimInput: w.input(), existingClaim: s1.claim, persistClaim: () => assert.fail('no write'), readMetadata: w.readMetadata }), code('RESTORE_CLAIM_CONFLICT'));
  const s2 = slot(), refused = resolve(w, t2, s2);
  assert.deepEqual(refused, { state: 'refused', code: 'SUCCESSOR_ALREADY_CLAIMED' });
  assert.equal(w.readControl().retirement.successor.restoreId, HEX('a'));
  assert.equal(resolve(w, t1, s1).state, 'claimed');
});
test('after the claim the source goes unreachable: a re-run HOLDS with the phase untouched, then completes once the source returns (A2.5d)', t => {
  const w = sourceWorld(t), target = targetFor(w), s = slot(), aside = w.root + '-aside';
  t.after(() => { try { fs.renameSync(aside, w.root); } catch {} });
  assert.throws(() => resolve(w, target, s, { afterStep: n => { if (n === 'claim:cas-durable') { fs.renameSync(w.root, aside); throw Object.assign(Error('CRASH'), { code: 'CRASH' }); } } }), code('CRASH'));
  assert.equal(s.claim.state, 'intent');
  const writesBefore = s.writes.length;
  assert.throws(() => resolve(w, target, s), code('RESTORE_SUCCESSOR_HELD'));
  assert.equal(s.writes.length, writesBefore, 'HELD finalizes nothing and writes nothing');
  fs.renameSync(aside, w.root);
  assert.equal(resolve(w, target, s).state, 'claimed');
});

function initFixture(t, { n = 'a', nonce = HEX('7') } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'init-auth-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  const st = fs.lstatSync(dir), allowance = { requestId: HEX(n), x: 1 }, manifest = { checksum: HEX('c') }, barrier = HEX('d');
  const value = { schema: 1, restoreId: HEX(n), target: { path: dir, dev: st.dev, ino: st.ino }, checkpointDigest: HEX('c'), barrierDigest: barrier, allowanceDigest: hash(allowance), predecessor: null, roles: [], controlTemporary: 'x', successorNonce: nonce };
  const initPath = path.join(dir, 'money-atomic-restore-initialization.json'), bytes = Buffer.from(p.canonicalJSON({ ...value, checksum: hash(value) }) + '\n');
  fs.writeFileSync(initPath, bytes, { mode: 0o600 });
  return { dir, initPath, allowance, manifest, barrier, targetIdentity: st, value, bytes, sha: crypto.createHash('sha256').update(bytes).digest('hex') };
}
test('initialization nonce: an existing file is authenticated and its nonce reused, never regenerated or adopted (A2.2)', t => {
  const f = initFixture(t), args = { initPath: f.initPath, allowance: f.allowance, targetRoot: f.dir, targetIdentity: f.targetIdentity, manifest: f.manifest, expectedBarrierDigest: f.barrier, body: null };
  assert.equal(R.authenticateInitialization(args).successorNonce, HEX('7'));
  assert.equal(R.authenticateInitialization({ ...args, body: { initializationDigest: f.sha } }).successorNonce, HEX('7'));
  const quarantined = patch => assert.throws(() => R.authenticateInitialization({ ...args, ...patch }), code('RESTORE_INITIALIZATION_QUARANTINED'));
  quarantined({ allowance: { requestId: HEX('b'), x: 1 } });
  quarantined({ manifest: { checksum: HEX('0') } });
  quarantined({ expectedBarrierDigest: HEX('0') });
  quarantined({ targetRoot: f.dir + '-other' });
  quarantined({ targetIdentity: { dev: f.targetIdentity.dev, ino: f.targetIdentity.ino + 1 } });
  quarantined({ allowance: { requestId: HEX('a'), x: 2 } });
  assert.throws(() => R.authenticateInitialization({ ...args, body: { initializationDigest: HEX('0') } }), code('RESTORE_INITIALIZATION_CONFLICT'));
  fs.chmodSync(f.initPath, 0o644);
  quarantined({});
  fs.chmodSync(f.initPath, 0o600);
  fs.writeFileSync(f.initPath, f.bytes.toString().replace(HEX('7'), 'notahexnonce'), { mode: 0o600 });
  quarantined({});
  fs.writeFileSync(f.initPath, '{}');
  quarantined({});
});
test('a nonce-less or foreign-target initialization file never yields a nonce: a copy from another target is quarantined (A2.5c)', t => {
  const mine = initFixture(t, { n: 'a' }), foreign = initFixture(t, { n: 'b', nonce: HEX('8') });
  fs.copyFileSync(foreign.initPath, mine.initPath);
  fs.chmodSync(mine.initPath, 0o600);
  assert.throws(() => R.authenticateInitialization({ initPath: mine.initPath, allowance: mine.allowance, targetRoot: mine.dir, targetIdentity: mine.targetIdentity, manifest: mine.manifest, expectedBarrierDigest: mine.barrier, body: null }), code('RESTORE_INITIALIZATION_QUARANTINED'));
  const { successorNonce, ...legacy } = foreign.value;
  const bytes = Buffer.from(p.canonicalJSON({ ...legacy, checksum: hash(legacy) }) + '\n');
  fs.writeFileSync(foreign.initPath, bytes, { mode: 0o600 });
  assert.throws(() => R.authenticateInitialization({ initPath: foreign.initPath, allowance: foreign.allowance, targetRoot: foreign.dir, targetIdentity: foreign.targetIdentity, manifest: foreign.manifest, expectedBarrierDigest: foreign.barrier, body: null }), code('RESTORE_INITIALIZATION_QUARANTINED'), 'no adoption of a file without a nonce');
});
test('successor status: none without successorOf, claimed only with a matching plan claim, unclaimed otherwise and on any read error', () => {
  const control = { checksum: HEX('2'), successorOf: { generationId: HEX('3') } };
  const status = (n, read, root = { restoreBinding: { planDigest: HEX('1') } }) => R.successorStatus({ epoch: { financial_dir: '/x/' + n + Math.random() }, writer: {}, root, control, read });
  const read = claim => () => ({ plan: { successorClaim: claim } });
  assert.equal(R.successorStatus({ epoch: { financial_dir: '/x/none' }, writer: {}, root: {}, control: { checksum: HEX('9') } }), 'none');
  assert.equal(status('norestore', undefined, {}), 'unclaimed', 'no completed restore');
  assert.equal(status('other', read({ generationId: HEX('4') })), 'unclaimed', 'a claim for another generation');
  assert.equal(status('withheld', read(null)), 'unclaimed', 'plan finalized withheld');
  assert.equal(status('error', () => { throw Error('RESTORE_COMPLETION_REQUIRED'); }), 'unclaimed', 'read error fails closed');
  assert.equal(status('claimed', read({ generationId: HEX('3') })), 'claimed');
  let reads = 0;
  const counted = () => { reads++; return { plan: { successorClaim: { generationId: HEX('3') } } }; };
  const epoch = { financial_dir: '/y/' + Math.random() }, root = { restoreBinding: { planDigest: HEX('1') } };
  R.successorStatus({ epoch, writer: {}, root, control, read: counted });
  R.successorStatus({ epoch, writer: {}, root, control, read: counted });
  assert.equal(reads, 1, 'memoized by control checksum and plan digest');
  R.successorStatus({ epoch, writer: {}, root: { restoreBinding: { planDigest: HEX('5') } }, control, read: counted });
  assert.equal(reads, 2, 'a new plan digest re-reads');
  let failures = 0;
  const flaky = () => { if (failures++ === 0) throw Error('transient'); return { plan: { successorClaim: { generationId: HEX('3') } } }; };
  const epoch3 = { financial_dir: '/z/' + Math.random() };
  assert.equal(R.successorStatus({ epoch: epoch3, writer: {}, root, control, read: flaky }), 'unclaimed');
  assert.equal(R.successorStatus({ epoch: epoch3, writer: {}, root, control, read: flaky }), 'claimed', 'a read error is not memoized');
});
test('assertRestoredContinuationIdentity: no restore binding or an unreadable restore is NO_RESTORE_BINDING under the unchanged accrual-conflict code', () => {
  for (const root of [{}, null, { restoreBinding: { planDigest: HEX('1') } }]) {
    assert.throws(() => R.assertRestoredContinuationIdentity({ epoch: { financial_dir: '/nonexistent', legacy_root: '/nonexistent' }, writer: {}, root }), error => error.code === 'COMPENSATION_ACCRUAL_CONFLICT' && error.check === 'NO_RESTORE_BINDING' && !Object.keys(error).includes('check'));
  }
});

function controlFile(t, { restoreId, claim, sequence = 0 }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-claim-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'money-atomic-restore-control.bin'), body = { schema: 1, protocol: 'atomic_restore_v1', sequence, restoreId, phase: 'initializing', control: { dev: 1, ino: 1 }, ...(claim ? { claim } : {}) };
  const bytes = Buffer.alloc(R.SLOT * 2);
  R.encodeControl(body).copy(bytes, (sequence % 2) * R.SLOT);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return { dir, file, digest: crypto.createHash('sha256').update(bytes).digest('hex') };
}
test('a foreign restore control carrying a claim is RESTORE_CLAIM_CONFLICT even when its physical identity does not match (a copied file); own, claim-less, predecessor and unreadable files pass (D2.2)', t => {
  const claim = { schema: 1, state: 'recorded', restoreId: HEX('b'), generationId: HEX('1'), initializationDigest: HEX('5'), checkpointDigest: HEX('c'), successorDigest: HEX('6') };
  const mine = { requestId: HEX('a') }, check = (f, archived = {}) => R.assertNoForeignClaim({ files: [f.file], allowance: mine, archived });
  const foreign = controlFile(t, { restoreId: HEX('b'), claim });
  assert.throws(() => check(foreign), code('RESTORE_CLAIM_CONFLICT'));
  assert.throws(() => check(foreign, {}), code('RESTORE_CLAIM_CONFLICT'));
  assert.doesNotThrow(() => check(controlFile(t, { restoreId: HEX('a'), claim })), 'this restore\'s own control is not foreign');
  assert.doesNotThrow(() => check(controlFile(t, { restoreId: HEX('b') })), 'a foreign control without a claim keeps today\'s behaviour (ignored)');
  const predecessor = controlFile(t, { restoreId: HEX('b'), claim });
  assert.doesNotThrow(() => check(predecessor, { [path.basename(predecessor.file)]: undefined, 'money-atomic-restore-control.bin': { digest: predecessor.digest } }), 'a predecessor copied from the checkpoint archive is exempt');
  assert.doesNotThrow(() => R.assertNoForeignClaim({ files: [path.join(foreign.dir, 'absent.bin')], allowance: mine, archived: {} }));
  fs.writeFileSync(foreign.file, Buffer.alloc(R.SLOT * 2), { mode: 0o600 });
  assert.doesNotThrow(() => check(foreign), 'unreadable bytes are not evidence of a claim');
});

// ---- review fix 2: the refusal code survives a completed retry ------------------------------------------------
test('successorSummary carries a known refusal code; refusalOutcome re-derives it read-only on a retry from the source record', t => {
  const w = sourceWorld(t), t1 = targetFor(w, 'a'), t2 = targetFor(w, 'b', HEX('d'));
  resolve(w, t1, slot());
  const refusedPlan = { continuationWithheld: 'SUCCESSOR_REFUSED', successorClaim: null };
  assert.deepEqual(R.successorSummary(refusedPlan, t2.manifest, { code: 'SUCCESSOR_ALREADY_CLAIMED' }), { successor: { state: 'refused', code: 'SUCCESSOR_ALREADY_CLAIMED' } });
  assert.deepEqual(R.successorSummary(refusedPlan, t2.manifest), { successor: { state: 'refused' } }, 'the plan alone does not store the code');
  const bytes = fs.readFileSync(w.controlFile);
  const base = { plan: refusedPlan, manifest: t2.manifest, claimInput: w.input(), allowance: t2.allowance, initializationDigest: t2.initializationDigest, readMetadata: w.readMetadata };
  assert.deepEqual(R.refusalOutcome(base), { code: 'SUCCESSOR_ALREADY_CLAIMED' });
  assert.deepEqual(fs.readFileSync(w.controlFile), bytes, 'read-only');
  assert.equal(R.refusalOutcome({ ...base, claimInput: undefined }), null, 'no source offered on the retry: no code, no guess');
  assert.equal(R.refusalOutcome({ ...base, plan: { ...refusedPlan, continuationWithheld: 'SUCCESSOR_ABSENT' } }), null);
  assert.equal(R.refusalOutcome({ ...base, readMetadata: () => { throw Error('busy'); } }), null, 'an unreadable source yields no code');
  const winner = { ...base, manifest: t1.manifest, allowance: t1.allowance, initializationDigest: t1.initializationDigest };
  assert.equal(R.refusalOutcome(winner), null, 'the winner is not refused');
  const copy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'refusal-copy-')));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.cpSync(w.root, copy, { recursive: true });
  assert.deepEqual(R.refusalOutcome({ ...base, claimInput: { sourceRoot: copy, sourceWriter: lock.injectMoneyWriter({ root: copy, assertOwned: () => true }) } }), { code: 'SOURCE_IDENTITY_MISMATCH' });
});

// ---- review fix 3: readCompletedRestore audits the stored claim (Addendum 2 D2.2) -------------------------------
test('auditCompletedClaim: no claim is fine; a valid claim agrees with the plan; an invalid, foreign or disagreeing stored claim is reported', () => {
  const claim = { schema: 1, state: 'recorded', restoreId: HEX('a'), generationId: HEX('1'), initializationDigest: HEX('5'), checkpointDigest: HEX('c'), successorDigest: HEX('6') };
  const plan = { checkpointDigest: HEX('c'), successorClaim: { generationId: HEX('1'), restoreId: HEX('a'), initializationDigest: HEX('5'), successorDigest: HEX('6') } };
  const body = { restoreId: HEX('a'), initializationDigest: HEX('5'), plan, claim };
  assert.equal(R.auditCompletedClaim({ ...body, claim: undefined }), true, 'ordinary restores carry no claim');
  assert.equal(R.auditCompletedClaim(body), true);
  assert.equal(R.auditCompletedClaim({ ...body, plan: { ...plan, successorClaim: null }, claim: { ...claim, state: 'intent', successorDigest: null } }), true, 'a refused plan may keep its intent record');
  const bad = (patch, expected, planPatch = {}) => assert.throws(() => R.auditCompletedClaim({ ...body, plan: { ...plan, ...planPatch }, claim: patch === null ? null : { ...claim, ...patch } }), error => error.code === expected, JSON.stringify(patch));
  const { initializationDigest, ...missing } = claim;
  assert.throws(() => R.auditCompletedClaim({ ...body, claim: missing }), error => error.code === 'RESTORE_CLAIM_INVALID', 'the exact A2.3 defect: a recorded claim missing initializationDigest');
  bad({ extra: 1 }, 'RESTORE_CLAIM_INVALID');
  bad({ state: 'other' }, 'RESTORE_CLAIM_INVALID');
  bad({ restoreId: HEX('b') }, 'RESTORE_CLAIM_CONFLICT');
  bad({ initializationDigest: HEX('0') }, 'RESTORE_CLAIM_CONFLICT');
  bad({ checkpointDigest: HEX('0') }, 'RESTORE_CLAIM_CONFLICT');
  bad({ generationId: HEX('0') }, 'RESTORE_CLAIM_CONFLICT');
  bad({ state: 'intent', successorDigest: null }, 'RESTORE_CLAIM_CONFLICT');
  bad({ successorDigest: HEX('0') }, 'RESTORE_CLAIM_CONFLICT');
  bad(null, 'RESTORE_CLAIM_INVALID');
});
