'use strict';
// A2 epoch lane (Addendum 2 D1.1-D1.4, Addendum 1 A0.6 and A3.3): the immutable retirement
// identity projection, the R layout, the transition validator and the control schema rule.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const e = require('../lib/financial-epoch'), op = require('../lib/financial-epoch-operator'), p = require('../lib/stripe-transfer-persistence');
const { HEX, syntheticBinding, syntheticControl, syntheticEpoch, retirementIdentity } = require('./helpers/money-synthetic-epoch');
const digest = p.digestJSON, size = value => Buffer.byteLength(p.canonicalJSON(value));
const retiring = (identity = retirementIdentity()) => e.buildRetirement(identity);
const code = expected => error => error.code === expected;

test('D1.1 identity projection has exactly its key set, constrained charsets, and a declared maximum canonical size', () => {
  const P = retirementIdentity();
  assert.equal(e.validateRetirementIdentity(P), P);
  assert.deepEqual(Object.keys(P).sort(), ['approvalRef', 'generationId', 'retiredAt', 'retiredAtGeneration', 'schema', 'sourceIdentity']);
  assert.deepEqual(Object.keys(P.sourceIdentity).sort(), ['bindingDigest', 'databaseId', 'epochId', 'journalRevision', 'lock', 'root', 'sqlite']);
  const max = retirementIdentity({
    approvalRef: 'A'.repeat(256), retiredAtGeneration: Number.MAX_SAFE_INTEGER,
    sourceIdentity: { root: { dev: Number.MAX_SAFE_INTEGER, ino: Number.MAX_SAFE_INTEGER }, lock: { dev: Number.MAX_SAFE_INTEGER, ino: Number.MAX_SAFE_INTEGER }, sqlite: { dev: Number.MAX_SAFE_INTEGER, ino: Number.MAX_SAFE_INTEGER }, databaseId: 'd'.repeat(64), bindingDigest: HEX('f'), epochId: 'e'.repeat(64), journalRevision: Number.MAX_SAFE_INTEGER }
  });
  assert.ok(size(max) <= 1280, 'declared D1.1 maximum 1,280 B, measured ' + size(max));
  assert.equal(JSON.stringify(max), JSON.stringify(JSON.parse(JSON.stringify(max))), 'no escaping');
});
for (const [name, change] of [
  ['extra key', P => { P.extra = 1; }], ['missing key', P => { delete P.approvalRef; }], ['undefined value', P => { P.approvalRef = undefined; }], ['bad schema', P => { P.schema = 2; }],
  ['short generation', P => { P.generationId = 'a'.repeat(63); }], ['uppercase generation', P => { P.generationId = 'A'.repeat(64); }],
  ['approval needs escaping', P => { P.approvalRef = 'a"b'; }], ['approval whitespace', P => { P.approvalRef = 'a b'; }], ['approval too long', P => { P.approvalRef = 'a'.repeat(257); }],
  ['retiredAt not ISO ms', P => { P.retiredAt = '2026-10-11T12:00:00Z'; }], ['retiredAt not UTC', P => { P.retiredAt = '2026-10-11T12:00:00.000+01:00'; }], ['retiredAt impossible date', P => { P.retiredAt = '2026-02-31T12:00:00.000Z'; }],
  ['unsafe generation', P => { P.retiredAtGeneration = Number.MAX_SAFE_INTEGER + 1; }], ['negative generation', P => { P.retiredAtGeneration = -1; }], ['fractional generation', P => { P.retiredAtGeneration = 1.5; }],
  ['source extra key', P => { P.sourceIdentity.extra = 1; }], ['source missing key', P => { delete P.sourceIdentity.lock; }], ['inode string', P => { P.sourceIdentity.root.ino = '22'; }],
  ['database id charset', P => { P.sourceIdentity.databaseId = 'db/../x'; }], ['database id empty', P => { P.sourceIdentity.databaseId = ''; }], ['binding digest', P => { P.sourceIdentity.bindingDigest = 'x'; }],
  ['epoch id charset', P => { P.sourceIdentity.epochId = '-bad'; }], ['journal revision', P => { P.sourceIdentity.journalRevision = -1; }]
]) {
  test('D1.1 rejects ' + name, () => {
    const P = retirementIdentity(); change(P);
    assert.throws(() => e.validateRetirementIdentity(P), code('RETIREMENT_IDENTITY_INVALID'));
  });
}

test('D1.2/D1.4 R layout carries identity and its digest; validator refuses mismatch, extra and missing keys', () => {
  const R = retiring();
  assert.deepEqual(Object.keys(R).sort(), ['identity', 'identityDigest', 'publishedCheckpointDigest', 'schema', 'state', 'successor']);
  assert.equal(R.identityDigest, digest(R.identity));
  assert.equal(e.retirementIdentityDigest(R.identity), R.identityDigest);
  assert.equal(R.state, 'retiring');
  assert.equal(e.validateRetirement(R), R);
  assert.ok(size({ ...R, state: 'retired', publishedCheckpointDigest: HEX('9'), successor: { restoreId: HEX('a'), initializationDigest: HEX('b'), checkpointDigest: HEX('c'), claimedAtGeneration: Number.MAX_SAFE_INTEGER } }) <= 2048);
  for (const bad of [
    { ...R, identityDigest: HEX('0') }, { ...R, identity: { ...R.identity, approvalRef: 'changed' } }, { ...R, extra: 1 }, (({ successor, ...rest }) => rest)(R),
    { ...R, state: 'paused' }, { ...R, publishedCheckpointDigest: HEX('9') }, { ...R, state: 'retired', publishedCheckpointDigest: null },
    { ...R, successor: { restoreId: HEX('a'), initializationDigest: HEX('b'), checkpointDigest: HEX('c'), claimedAtGeneration: 2 } },
    { ...R, state: 'retired', publishedCheckpointDigest: HEX('9'), successor: { restoreId: HEX('a') } }
  ]) assert.throws(() => e.validateRetirement(bad), code('RETIREMENT_IDENTITY_INVALID'));
});

test('D1.4 transition validator allows exactly retire, finalize and one claim, nothing else', () => {
  const a = retiring(), b = { ...a, state: 'retired', publishedCheckpointDigest: HEX('9') };
  const tuple = { restoreId: HEX('a'), initializationDigest: HEX('b'), checkpointDigest: HEX('c'), claimedAtGeneration: 3 }, c = { ...b, successor: tuple };
  assert.doesNotThrow(() => e.validateRetirementTransition(null, a));
  assert.doesNotThrow(() => e.validateRetirementTransition(a, b));
  assert.doesNotThrow(() => e.validateRetirementTransition(b, c));
  assert.doesNotThrow(() => e.validateRetirementTransition(c, c), 'an identical rewrite is not a move');
  const refuse = (x, y) => assert.throws(() => e.validateRetirementTransition(x, y), code('RETIREMENT_IDENTITY_MUTATED'));
  refuse(b, a);
  refuse(c, a);
  refuse(null, b);
  refuse(a, c);
  refuse(b, { ...b, publishedCheckpointDigest: HEX('8') });
  refuse(c, { ...c, publishedCheckpointDigest: HEX('8') });
  refuse(c, { ...c, successor: { ...tuple, restoreId: HEX('d') } });
  refuse(c, b);
  refuse(a, { ...a, state: 'retired', publishedCheckpointDigest: HEX('9'), successor: tuple });
  const other = retiring(retirementIdentity({ approvalRef: 'approval:other' }));
  refuse(a, { ...other, state: 'retired', publishedCheckpointDigest: HEX('9') });
  const recomputed = { ...b, identity: { ...b.identity, retiredAt: '2026-10-11T12:00:01.000Z' } };
  recomputed.identityDigest = digest(recomputed.identity);
  refuse(a, recomputed);
});

test('A0.6 control schema: version 1 carries neither field, version 2 carries at least one, retirement forces paused and no capabilities', () => {
  const binding = syntheticBinding(), R = retiring();
  const base = syntheticControl(binding);
  assert.equal(e.validateControl(base, binding), base);
  const paused = { ...base, state: 'paused', capabilities: Object.fromEntries(e.CAPABILITIES.map(k => [k, false])), evidence: {} };
  const retired = e.seal({ ...paused, schema_version: 2, retirement: R }), successor = e.seal({ ...base, schema_version: 2, successorOf: { generationId: HEX('1') } });
  assert.equal(e.validateControl(retired, binding), retired);
  assert.equal(e.validateControl(successor, binding), successor);
  assert.equal(e.validateControl(e.seal({ ...paused, schema_version: 2, retirement: R, successorOf: { generationId: HEX('2') } }), binding).schema_version, 2);
  const invalid = [
    e.seal({ ...base, retirement: R }), e.seal({ ...base, successorOf: { generationId: HEX('1') } }), e.seal({ ...base, schema_version: 2 }), e.seal({ ...base, schema_version: 3 }),
    e.seal({ ...paused, schema_version: 2, retirement: { ...R, identityDigest: HEX('0') } }), e.seal({ ...base, schema_version: 2, retirement: R }),
    e.seal({ ...paused, schema_version: 2, retirement: R, capabilities: { ...paused.capabilities, reconcile: true } }),
    e.seal({ ...base, schema_version: 2, successorOf: { generationId: HEX('1'), claimed: false } }), e.seal({ ...base, schema_version: 2, successorOf: { generationId: 'x' } }), e.seal({ ...base, schema_version: 2, successorOf: {} })
  ];
  for (const control of invalid) assert.throws(() => e.validateControl(control, binding), error => ['EPOCH_CONTROL_INVALID', 'RETIREMENT_IDENTITY_INVALID'].includes(error.code), JSON.stringify(Object.keys(control)));
  const edited = { ...retired, schema_version: 1 };
  assert.throws(() => e.validateControl(edited, binding), code('EPOCH_CONTROL_INVALID'), 'editing the version back invalidates the seal');
  assert.throws(() => e.validateControl(e.seal({ ...paused, schema_version: 2, retirement: { ...R, identity: { ...R.identity, sourceIdentity: { ...R.identity.sourceIdentity, epochId: 'other-epoch' } }, identityDigest: digest({ ...R.identity, sourceIdentity: { ...R.identity.sourceIdentity, epochId: 'other-epoch' } }) } }), binding), code('RETIREMENT_IDENTITY_INVALID'), 'identity must belong to this epoch');
});

test('S1, S3, S4 control writes: CAS by revision, identity digest byte-stable, generation advances each time', t => {
  const x = syntheticEpoch(t), P = retirementIdentity({ retiredAtGeneration: 1 });
  const first = op.retireEpochControl({ root: x.root, writer: x.writer, expectedRevision: 0, identity: P });
  assert.equal(first.generation, 1);
  assert.equal(first.state, 'paused');
  assert.ok(Object.values(first.capabilities).every(v => v === false), 'reconcile included');
  assert.equal(first.schema_version, 2);
  assert.equal(first.retirement.state, 'retiring');
  const digestAfterS1 = first.retirement.identityDigest;
  assert.equal(digestAfterS1, digest(P));
  assert.deepEqual(x.readControl(), first);
  assert.throws(() => op.retireEpochControl({ root: x.root, writer: x.writer, expectedRevision: 0, identity: P }), code('EPOCH_CONTROL_CONFLICT'));
  const second = op.finalizeRetirementControl({ root: x.root, writer: x.writer, expectedRevision: 1, publishedCheckpointDigest: HEX('9') });
  assert.equal(second.generation, 2);
  assert.equal(second.retirement.state, 'retired');
  assert.equal(second.retirement.identityDigest, digestAfterS1);
  assert.deepEqual(second.retirement.identity, P);
  const tuple = { restoreId: HEX('a'), initializationDigest: HEX('b'), checkpointDigest: HEX('9'), claimedAtGeneration: 3 };
  assert.throws(() => op.claimRetirementSuccessor({ root: x.root, writer: x.writer, expectedRevision: 1, successor: tuple }), code('EPOCH_CONTROL_CONFLICT'), 'a stale read is rejected by the CAS');
  const third = op.claimRetirementSuccessor({ root: x.root, writer: x.writer, expectedRevision: 2, successor: { ...tuple, claimedAtGeneration: 3 } });
  assert.equal(third.generation, 3);
  assert.equal(third.retirement.identityDigest, digestAfterS1);
  assert.equal(e.retirementIdentityDigest(third.retirement.identity), digestAfterS1);
  assert.deepEqual(third.retirement.successor, tuple);
  const before = fs.readFileSync(x.controlFile);
  assert.throws(() => op.claimRetirementSuccessor({ root: x.root, writer: x.writer, expectedRevision: 3, successor: { ...tuple, restoreId: HEX('c') } }), code('RETIREMENT_IDENTITY_MUTATED'));
  assert.deepEqual(fs.readFileSync(x.controlFile), before, 'a refused transition leaves the control bytes unchanged');
});

test('S1 refuses a stale or foreign identity and an already retired control', t => {
  const x = syntheticEpoch(t);
  assert.throws(() => op.retireEpochControl({ root: x.root, writer: x.writer, expectedRevision: 0, identity: retirementIdentity({ retiredAtGeneration: 5 }) }), code('RETIREMENT_IDENTITY_INVALID'), 'retiredAtGeneration must be current generation + 1');
  assert.throws(() => op.retireEpochControl({ root: x.root, writer: x.writer, expectedRevision: 0, identity: retirementIdentity({ sourceIdentity: { ...retirementIdentity().sourceIdentity, epochId: 'other-epoch' } }) }), code('RETIREMENT_IDENTITY_INVALID'));
  assert.throws(() => op.retireEpochControl({ root: x.root, writer: x.writer, expectedRevision: 0, identity: retirementIdentity({ sourceIdentity: { ...retirementIdentity().sourceIdentity, bindingDigest: HEX('0') } }) }), code('RETIREMENT_IDENTITY_INVALID'));
  op.retireEpochControl({ root: x.root, writer: x.writer, expectedRevision: 0, identity: retirementIdentity() });
  assert.throws(() => op.retireEpochControl({ root: x.root, writer: x.writer, expectedRevision: 1, identity: retirementIdentity({ retiredAtGeneration: 2 }) }), code('RETIREMENT_IDENTITY_MUTATED'), 'a second generation can never be minted');
});

test('assertControlNotRetired refuses exactly a control that carries R (a successor control is not retired)', t => {
  const x = syntheticEpoch(t);
  op.retireEpochControl({ root: x.root, writer: x.writer, expectedRevision: 0, identity: retirementIdentity() });
  const control = x.readControl();
  assert.throws(() => e.assertControlNotRetired(control), code('EPOCH_RETIRED'));
  const { retirement, ...rest } = control;
  assert.doesNotThrow(() => e.assertControlNotRetired(e.seal({ ...rest, successorOf: { generationId: HEX('1') } })));
});
