'use strict';
// EMFR A2 serialization and headroom measurement (v3 2.8, Addendum 1 A4, Addendum 2 D2.1; test 6.9). Pure JS.
// Method: build the largest restore-control body the code can write from FIELD MAXIMA (16-digit integers, maximum-length
// strings, a maximal capacity profile and a restored prior root), add the A2 fields at their maxima, and run the production
// encodeControl (the slot limit is < 65,536 B). This is a MODEL: the authoritative measurement splices the A2 fields into the
// REAL plan of a native restore (test/money-continuation-authority-native.test.js, row 6.9). If the bound does not fit, the
// spec requires STOP and re-stamp; nothing here shrinks or grows any field.
const test = require('node:test'), assert = require('node:assert/strict');
const R = require('../lib/money-atomic-restore'), A = require('../lib/money-continuation-authority'), p = require('../lib/stripe-transfer-persistence');
const M = Number.MAX_SAFE_INTEGER, hex = c => c.repeat(64), bytes = x => Buffer.byteLength(p.canonicalJSON(x));
const phys = (extra = {}) => ({ dev: M, ino: M, bytes: M, allocatedBytes: M, uid: M, mode: 0o600, nlink: 1, ...extra });
const role = (relativePath, extra = {}) => phys({ relativePath, ...extra });
const ID = 'a'.repeat(64);

function worstCase() {
  const profile = {
    schema: 1, id: ID, approved: true, evidence_ref: 'e'.repeat(512), epoch_id: ID, binding_digest: hex('b'), platform_account_id: 'acct_' + 'x'.repeat(40), livemode: false, currency: 'usd',
    blockBytes: M, reserveBytes: M, publicationBytes: M, slotBytes: M, sourceClosureBytes: M, spendBytes: M, optionalBytes: M, maxRowBytes: M, maxRawEventBytes: M, maxActiveSources: M, maxActiveFragments: M, maxQuoteRows: M, maxQuoteRowsPerOwner: M, maxQuoteBytes: M,
    grouped: { schema: 1, commitProtocol: 'single_sql_v1', sharedBytes: M, maxGroupOwners: M, maxGroupRows: M, sqlite: { schema: 1, maxDatabasePages: M, maxGrowthPages: M, maxNetOccupiedPages: M, maxPagesPerMutation: M, maxRollbackBytes: M, rollbackProofDigest: hex('c') },
      sharedLiability: { schema: 1, systemBytes: M, optionalBytes: M, admissionBytes: M, fundingClosureBytes: M, fundingCentSlotBytes: M, spendFragmentBytes: M, spendCommonBytes: M, capacityBytes: M } },
    workspace: { schema: 2, scanRetainedBytes: M, quoteRetainedBytes: M, controlRetainedBytes: M, maxQuoteChangesPerCommit: M, workspaceRetainedBytes: M, workspaceScratchBytes: M, maxWorkspaceMembers: M, maxConcurrentScans: M }
  };
  const restoreBinding = { schema: 1, protocol: 'atomic_restore_v1', restoreId: hex('1'), planDigest: hex('2'), checkpointDigest: hex('3'), barrierDigest: hex('4'), previousBindingDigest: hex('5'), allowanceDigest: hex('6'), allowanceBoundBytes: '9'.repeat(20), consumedBytes: '9'.repeat(20), rolePlanDigest: hex('7'), priorRevision: M, finalRevision: M };
  const priorRoot = { id: 'capacity:root', state: 'ready', epoch_id: ID, binding_digest: hex('b'), profileDigest: hex('d'), profile, availableBytes: M, unassignedBytes: M, optionalRemainingBytes: M, sharedRemainingBytes: M, activeSources: M, activeFragments: M, generation: M, activeAllowance: null, publicationGeneration: M,
    completion: phys(), publication: phys(), publicationControl: phys(), failureControl: { role: 'first_failure_control', dev: M, ino: M, bytes: 8192, allocatedBytes: M, uid: M, mode: 0o600 }, restoreGeneration: M, restoreBinding };
  const metrics = Object.fromEntries(['pageSize', 'pageCount', 'freelistCount', 'workspaceAllocatedBytes', 'allocatedBytes', 'fileBytes', 'revision', 'sequence', 'members', 'scans', 'quoteRows', 'leases'].map(k => [k, M]));
  const geometry = { P: M, R: M, S: M, Q: M, C: M, W: M };
  const names = ['completion', 'publication', 'workspaceDeficit', 'workspaceScratch', 'engineeringReserve', 'engineeringPublication'];
  const allocationRoles = Object.fromEntries(names.map(n => [n, role('money-restore-' + n + '-reserve.bin', { temporary: '.stage-restore-' + n + '-' + hex('9') })]));
  const compensation = { schema: 1, participant: 'earnings', relativePath: 'financial-epochs/' + ID + '/earnings.json', compensationDigest: hex('1'), spendId: ID, spendDigest: hex('2'), walId: ID, walPayloadDigest: hex('3'), originalIdentity: { dev: M, ino: M }, sha256: hex('4'), bytes: M, sourceIdentity: { dev: M, ino: M, uid: M, mode: 0o600, nlink: 1 }, predecessorEquivalenceDigest: hex('5') };
  const E = { walId: ID, walFileSha256: hex('a'), walPayloadDigest: hex('b'), fenceDigest: hex('c'), spendId: ID, spendDigest: hex('d'), drawVectorDigest: hex('e'), earningsBeforeDigest: hex('f'), originalIdentity: { dev: M, ino: M }, predecessorEquivalenceDigest: hex('1') };
  const T = { schema: 1, kind: 'continuation_earnings_v1', cutDigest: hex('a'), lineage: { checkpointDigest: hex('b'), restoreId: hex('c'), barrierDigest: hex('d'), epochId: ID, bindingDigest: hex('e'), successorDigest: hex('f') }, earnings: { relativePath: 'earnings.json', sha256: hex('f'), bytes: M, targetIdentity: { dev: M, ino: M } }, entries: [E] };
  const planRoles = { ...allocationRoles, publicationControl: role('money-capacity-publication-control.bin'), workspaceControl: role('money-workspace-control.bin'), first_failure_control: role('money-first-failure-control.bin', { sha256: hex('8') }), restoreControl: role('money-atomic-restore-control.bin'), initialization: role('money-atomic-restore-initialization.next.json'),
    compensation_earnings: role('earnings.json', { sha256: hex('9'), entryDigest: hex('a') }) };
  const planBase = {
    schema: 1, protocol: 'atomic_restore_v1', restoreId: hex('1'), checkpointDigest: hex('2'), barrierDigest: hex('3'), lifecycleDigest: hex('4'), profileDigest: hex('5'), databaseSchema: 3, workspaceSchema: 2, priorRevision: M, priorSequence: M, priorRootDigest: hex('6'), priorRestoreGeneration: M, previousBindingDigest: hex('7'),
    priorJointCompletionDigest: hex('8'), capacityControlDigest: hex('9'), workspaceControlDigest: hex('a'), quoteControlDigest: hex('b'), leaseStateDigest: hex('c'), scanStateDigest: hex('d'), financialStateDigest: hex('e'), metadataIdentityDigest: hex('f'), rootEconomicDigest: hex('0'), allowanceDigest: hex('1'),
    allowanceBoundBytes: M, publicationBoundBytes: M, maxGrowthPages: M, maxNetOccupiedPages: M, retainedNonDatabaseOutputBytes: M, priorOutputAllocation: { control: M, initialization: M, barrier: M }, publicationGeometry: { allocationUnit: M, priorTargetAllocatedBytes: M, expectedTargetAllocatedBytes: M, maximumTemporaryBytes: M },
    rolePlanDigest: hex('2'), roles: planRoles, priorMetrics: metrics, priorGeometry: geometry, compensationEarnings: compensation
  };
  const a2Plan = { continuationEarnings: T, continuationWithheld: 'SUCCESSOR_ABSENT', successorClaim: { generationId: hex('1'), restoreId: hex('2'), initializationDigest: hex('3'), successorDigest: hex('4') } };
  const claim = { schema: 1, state: 'recorded', restoreId: hex('1'), generationId: hex('2'), initializationDigest: hex('3'), checkpointDigest: hex('4'), successorDigest: hex('5') };
  const roleContinuation = role('earnings.json', { sha256: hex('b'), entryDigest: hex('c') });
  const outcome = { state: 'committed', revision: M, rootDigest: hex('1'), restoreBinding, receipt: { schema: 1, protocol: 'atomic_restore_v1', restoreId: hex('1'), planDigest: hex('2'), priorRootDigest: hex('3'), nextRootDigest: hex('4'), revision: M, bindingDigest: hex('5') }, receiptDigest: hex('6'), metrics, requiredBytes: M, geometry };
  const publication = { role: 'barrier', priorTargetDigest: hex('1'), nextTargetDigest: hex('2'), temporaryBasename: '.stage-atomic-restore-barrier-' + hex('3'), maximumTemporaryBytes: M, K: M, priorOSize: M, nextOSize: M, temporaryIdentity: phys() };
  const body = (withA2) => {
    const plan = { ...planBase, ...(withA2 ? { ...a2Plan, roles: { ...planRoles, continuation_earnings: roleContinuation } } : {}), planDigest: hex('9') };
    return { schema: 1, protocol: 'atomic_restore_v1', sequence: M, restoreId: hex('1'), phase: 'workspace_published', control: phys(), initializationDigest: hex('2'), roles: allocationRoles, plan, outcome, priorRoot, priorOutputAllocation: { control: M, initialization: M, barrier: M }, databaseId: ID, publication, ...(withA2 ? { claim } : {}) };
  };
  return { body, a2Plan, claim, roleContinuation, priorRoot, planBase };
}

test('model: the worst-case restore control body fits the 65,536 B slot with and without the A2 fields, and the A2 additions are inside the 4,096 B bound', t => {
  const w = worstCase(), base = w.body(false), full = w.body(true);
  const baseBytes = bytes({ ...base, checksum: hex('c') }), fullBytes = bytes({ ...full, checksum: hex('c') }), added = fullBytes - baseBytes;
  const report = { slot: R.SLOT, worstCaseBaseBytes: baseBytes, worstCaseWithA2Bytes: fullBytes, a2AddedBytes: added, declaredBound: A.BOUNDS.planAdd, headroomAfterA2: R.SLOT - 1 - fullBytes, priorRootBytes: bytes(w.priorRoot), planBytes: bytes(full.plan) };
  t.diagnostic('A2_HEADROOM_MODEL ' + JSON.stringify(report));
  if (process.env.A2_REPORT) process.stdout.write('A2_HEADROOM_MODEL ' + JSON.stringify(report) + '\n');
  assert.doesNotThrow(() => R.encodeControl(base), 'the worst-case body without A2 fits');
  assert.doesNotThrow(() => R.encodeControl(full), 'the worst-case body with A2 fits: otherwise STOP and re-stamp');
  assert.ok(added <= A.BOUNDS.planAdd, 'A2 added ' + added + ' B, declared bound ' + A.BOUNDS.planAdd + ': STOP and re-stamp');
  assert.ok(baseBytes + A.BOUNDS.planAdd < R.SLOT, 'the full declared bound must fit above the worst-case base: STOP and re-stamp');
  assert.equal(A.planAddBytes({ ...w.a2Plan, roles: { continuation_earnings: w.roleContinuation } }, w.claim) <= A.BOUNDS.planAdd, true);
});
test('the A2 plan-add bound is the declared 3,072 + 512 + 512 = 4,096 B of Addendum 2 D2.1, and every component is inside its own declared maximum', () => {
  assert.equal(A.BOUNDS.planAdd, 3072 + 512 + 512);
  assert.deepEqual({ entry: A.BOUNDS.entry, S: A.BOUNDS.continuationEarnings, T: A.BOUNDS.target, role: A.BOUNDS.role, unresolved: A.BOUNDS.unresolvedObligations, retirement: A.BOUNDS.sourceRetirement, successorClaim: A.BOUNDS.successorClaim, claim: A.BOUNDS.claim }, { entry: 1024, S: 1536, T: 2304, role: 512, unresolved: 2304, retirement: 1408, successorClaim: 512, claim: 512 });
  const w = worstCase();
  assert.ok(bytes(w.a2Plan.continuationEarnings) <= A.BOUNDS.target);
  assert.ok(bytes(w.roleContinuation) <= A.BOUNDS.role);
  assert.ok(bytes(w.claim) <= A.BOUNDS.claim);
  assert.ok(bytes(w.a2Plan.successorClaim) <= A.BOUNDS.successorClaim);
});
test('a control body that would overflow the slot is refused by the production encoder (the limit is real)', () => {
  const w = worstCase(), body = w.body(true);
  body.filler = 'x'.repeat(R.SLOT);
  assert.throws(() => R.encodeControl(body), { code: 'RESTORE_CONTROL_LIMIT' });
});
