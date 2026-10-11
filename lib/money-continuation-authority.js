'use strict';
// Pure helpers for EMFR A2 authenticated continuation (BUILD-SPEC v3 2 and 8, Addendum 1 A0 and A2,
// Addendum 2 D1 and D2). Everything here is data validation and data construction. It requires neither
// lib/wal.js (whose module-level mkdir of WAL_DIR must never run in a checkpoint process) nor
// lib/money-control.js, and it grants no authority: authority is minted only by the restore.
//
// Generation references: the single source of a successor generation is
// sourceRetirement.identity.generationId (build stamp, correction 2). The explicit keys defined by
// the later documents (control.successorOf, body.claim, plan.successorClaim) are compared against it
// and no other flat generation field is carried.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { digestJSON: hash, canonicalJSON } = require('./stripe-transfer-persistence');
const epochModule = require('./financial-epoch');
const HEX = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9_-]{1,64}$/;
// Declared canonical-JSON maxima (v3 2.8, Addendum 1 A4, Addendum 2 D1.5, D2.1). Measured by tests.
const BOUNDS = Object.freeze({ entry: 1024, continuationEarnings: 1536, target: 2304, role: 512, unresolvedObligations: 2304, sourceRetirement: 1408, successorClaim: 512, claim: 512, planAdd: 4096 });
const UNRESOLVED_REASONS = Object.freeze(['ELIGIBLE', 'SOURCE_NOT_RETIRING', 'AMBIGUOUS_SHARED_PRE_IMAGE', 'SOURCE_IDENTITY_UNPROVEN', 'WRITE_STARTED', 'STEP_PREREQUISITE', 'SPEND_STATE', 'POOL_PRESENT', 'COMPENSATION_SELECTED', 'NO_FENCE']);
const WITHHELD = Object.freeze(['NOT_RETIRING', 'SUCCESSOR_ABSENT', 'SUCCESSOR_REFUSED']);
const MAX_UNRESOLVED_ITEMS = 8;
const CHECK_NAMES = Object.freeze(['NO_RESTORE_BINDING', 'RECORD_ABSENT', 'LINEAGE', 'ENTRY_MISSING', 'ENTRY_DUPLICATE', 'WAL_FILE', 'FENCE', 'SPEND', 'DRAW_VECTOR', 'EARNINGS_DIGEST', 'TARGET_IDENTITY', 'FAILURE_STATE']);
function fail(code, check) {
  const error = Object.assign(new Error(code), { code });
  if (check) Object.defineProperty(error, 'check', { value: check, enumerable: false });
  throw error;
}
const bytesOf = value => Buffer.byteLength(canonicalJSON(value));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function exact(value, keys) {
  return !!value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length && keys.every(k => {
    const d = Object.getOwnPropertyDescriptor(value, k);
    return d?.enumerable && Object.hasOwn(d, 'value') && d.value !== undefined;
  });
}
const hex = v => typeof v === 'string' && HEX.test(v), id = v => typeof v === 'string' && ID.test(v), uint = v => Number.isSafeInteger(v) && v >= 0;
const pair = v => exact(v, ['dev', 'ino']) && uint(v.dev) && uint(v.ino);
const generationOf = manifest => manifest?.sourceRetirement?.identity?.generationId;

// ---- source half: manifest.sourceRetirement (Addendum 2 D1.5) -----------------------------------------
function validateSourceRetirement(sourceRetirement, manifest) {
  const bad = () => fail('CHECKPOINT_SOURCE_RETIREMENT_INVALID');
  if (!exact(sourceRetirement, ['identity', 'identityDigest']) || !hex(sourceRetirement.identityDigest)) bad();
  try { epochModule.validateRetirementIdentity(sourceRetirement.identity); } catch { bad(); }
  const P = sourceRetirement.identity;
  if (hash(P) !== sourceRetirement.identityDigest || bytesOf(sourceRetirement) > BOUNDS.sourceRetirement) bad();
  if (manifest && (P.sourceIdentity.epochId !== manifest.financial_epoch || P.sourceIdentity.bindingDigest !== manifest.binding_digest || P.sourceIdentity.journalRevision !== manifest.journal_revision)) bad();
  return sourceRetirement;
}

// ---- continuation record entry E and source half S (v3 2.1) ---------------------------------------------
function validateEntry(E, bad) {
  if (!exact(E, ['walId', 'walFileSha256', 'walPayloadDigest', 'fenceDigest', 'spendId', 'spendDigest', 'drawVectorDigest', 'earningsBeforeDigest', 'originalIdentity', 'predecessorEquivalenceDigest'])
    || !id(E.walId) || !id(E.spendId) || !['walFileSha256', 'walPayloadDigest', 'fenceDigest', 'spendDigest', 'drawVectorDigest', 'earningsBeforeDigest'].every(k => hex(E[k]))
    || !pair(E.originalIdentity) || !(E.predecessorEquivalenceDigest === null || hex(E.predecessorEquivalenceDigest)) || bytesOf(E) > BOUNDS.entry) bad();
  return E;
}
function validateContinuationEarnings(S, { epochId } = {}) {
  const bad = () => fail('CHECKPOINT_CONTINUATION_EARNINGS_INVALID');
  if (S === null) return null;
  if (!exact(S, ['schema', 'participant', 'relativePath', 'sha256', 'bytes', 'sourceIdentity', 'entries']) || S.schema !== 1 || S.participant !== 'earnings' || typeof epochId !== 'string'
    || S.relativePath !== 'financial-epochs/' + epochId + '/earnings.json' || !hex(S.sha256) || !uint(S.bytes)
    || !exact(S.sourceIdentity, ['dev', 'ino', 'uid', 'mode', 'nlink']) || !['dev', 'ino', 'uid'].every(k => uint(S.sourceIdentity[k])) || S.sourceIdentity.mode !== 0o600 || S.sourceIdentity.nlink !== 1
    || !Array.isArray(S.entries) || S.entries.length !== 1 || bytesOf(S) > BOUNDS.continuationEarnings) bad();
  const E = validateEntry(S.entries[0], bad);
  if (E.earningsBeforeDigest !== S.sha256) bad();
  const same = S.sourceIdentity.dev === E.originalIdentity.dev && S.sourceIdentity.ino === E.originalIdentity.ino;
  if (E.predecessorEquivalenceDigest === null ? !same : same) bad();
  return S;
}
function validateUnresolvedObligations(U) {
  const bad = () => fail('CHECKPOINT_CONTINUATION_EARNINGS_INVALID');
  if (!exact(U, ['count', 'truncated', 'items']) || !uint(U.count) || typeof U.truncated !== 'boolean' || !Array.isArray(U.items) || U.items.length > MAX_UNRESOLVED_ITEMS
    || U.truncated !== U.count > U.items.length || U.count < U.items.length || (U.count > 0) !== (U.items.length > 0)) bad();
  for (const item of U.items) {
    if (!exact(item, ['walId', 'spendId', 'fenceState', 'continuation', 'reason']) || !id(item.walId) || !(item.spendId === null || id(item.spendId)) || !(item.fenceState === null || typeof item.fenceState === 'string' && /^[a-z_]{1,32}$/.test(item.fenceState))
      || !['record', 'none'].includes(item.continuation) || !UNRESOLVED_REASONS.includes(item.reason) || (item.continuation === 'record') !== (item.reason === 'ELIGIBLE')) bad();
  }
  if (bytesOf(U) > BOUNDS.unresolvedObligations) bad();
  return U;
}
// Cross-checks the A2 keys of a manifest. Pre-A2 manifests (no A2 key in the cut) are accepted as null.
function validateCheckpointContinuation(manifest) {
  if (!Object.hasOwn(manifest, 'atomic_capacity_cut')) {
    if (manifest.sourceRetirement !== undefined) validateSourceRetirement(manifest.sourceRetirement, manifest);
    return true;
  }
  const bad = () => fail('CHECKPOINT_CONTINUATION_EARNINGS_INVALID');
  const cut = manifest.atomic_capacity_cut, has = ['continuationEarnings', 'unresolvedObligations', 'completionGuaranteed'].map(k => Object.hasOwn(cut, k));
  if (manifest.sourceRetirement !== undefined) validateSourceRetirement(manifest.sourceRetirement, manifest);
  if (!has.some(Boolean)) { if (manifest.sourceRetirement !== undefined) bad(); return true; }
  if (!has.every(Boolean) || cut.completionGuaranteed !== false) bad();
  const S = validateContinuationEarnings(cut.continuationEarnings, { epochId: manifest.financial_epoch });
  const U = validateUnresolvedObligations(cut.unresolvedObligations);
  if (!S) { if (U.items.some(item => item.continuation === 'record')) bad(); return true; }
  if (manifest.sourceRetirement === undefined) bad();
  const E = S.entries[0], rows = Array.isArray(manifest.files) ? manifest.files : [];
  const earnings = rows.filter(row => row.path === S.relativePath), wal = rows.filter(row => row.path === 'financial-epochs/' + manifest.financial_epoch + '/wal/' + E.walId + '.wal.json');
  if (earnings.length !== 1 || earnings[0].sha256 !== S.sha256 || earnings[0].bytes !== S.bytes || wal.length !== 1 || wal[0].sha256 !== E.walFileSha256) bad();
  const proof = manifest.first_failure_control;
  if (proof?.state === 'compensation_requested' && proof.compensation?.walId === E.walId) bad();
  const records = U.items.filter(item => item.continuation === 'record');
  if (records.length > 1 || records.some(item => item.walId !== E.walId) || records.length === 0 && !U.truncated) bad();
  return true;
}

// ---- building S from the durable source (checkpoint process: no wal.js) -----------------------------
function fenceDigest(fence) { return hash(fence); }
function drawVectorDigest(spend) { return hash({ accountId: spend.accountId, spendId: spend.id, participantDraws: spend.intent.participantDraws }); }
function expectedDraws(spend) {
  const draws = spend?.intent?.participantDraws;
  if (!Array.isArray(draws) || !draws.length) return null;
  return draws.map(d => ({ lot_id: d.lotId, kind: d.kind, amount: d.amountMicros / 1e6, spend_id: spend.id, inflight_marked: true }));
}
function drawsMatch(spend, payloadDraws) {
  const expected = expectedDraws(spend);
  if (!expected || !Array.isArray(payloadDraws) || payloadDraws.length !== expected.length) return false;
  return expected.every((x, i) => { const d = payloadDraws[i]; return d && d.lot_id === x.lot_id && d.kind === x.kind && d.amount === x.amount && d.spend_id === x.spend_id && d.inflight_marked === true; });
}
function readWalFiles(walDir) {
  let names;
  try { names = fs.readdirSync(walDir).filter(n => n.endsWith('.wal.json')).sort(); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.map(name => {
    const file = path.join(walDir, name), st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail('CHECKPOINT_WAL_UNREADABLE');
    const bytes = fs.readFileSync(file);
    let entry;
    try { entry = JSON.parse(bytes); } catch { fail('CHECKPOINT_WAL_UNREADABLE'); }
    if (!entry || typeof entry.id !== 'string' || name !== entry.id + '.wal.json') fail('CHECKPOINT_WAL_UNREADABLE');
    return { name, bytes, sha256: sha256(bytes), entry };
  });
}
// ctx: { getSpend(id), hasPool(walId), earnings() -> {sha256,bytes,identity}, compensationWalId, restoredEntryFor(walId) }
// earnings() is lazy: an ordinary checkpoint with no fenced unlock WAL never reads the earnings file.
function classifyWal(w, ctx) {
  const entry = w.entry, f = entry.accrualFence;
  if (entry.operation !== 'unlock') return null;
  if (!f || typeof f !== 'object') return 'NO_FENCE';
  const steps = Array.isArray(entry.steps_completed) ? entry.steps_completed : null;
  if (f.state !== 'not_started' || steps === null || steps.includes('update_earnings')) return 'WRITE_STARTED';
  if (entry.payload?.funding_source !== 'credit_pack' || !steps.includes('update_learnings') || !id(entry.id) || !id(f.spendId) || !hex(f.spendDigest) || !hex(f.earningsBeforeDigest) || !pair(f.earningsFileIdentity)) return 'STEP_PREREQUISITE';
  if (ctx.compensationWalId === entry.id) return 'COMPENSATION_SELECTED';
  let spend;
  try { spend = ctx.getSpend(f.spendId); } catch { spend = null; }
  if (!spend || spend.state !== 'acknowledged' || !spend.intent || hash(spend.intent) !== spend.digest || f.spendDigest !== spend.digest || entry.payload.purchaser_account_id !== spend.accountId || !drawsMatch(spend, entry.payload.dollar_draws)) return 'SPEND_STATE';
  if (ctx.hasPool(entry.id)) return 'POOL_PRESENT';
  let earnings;
  try { earnings = ctx.earnings(); } catch { return 'SOURCE_IDENTITY_UNPROVEN'; }
  if (earnings.sha256 !== f.earningsBeforeDigest) return 'SOURCE_IDENTITY_UNPROVEN';
  if (!(earnings.identity.dev === f.earningsFileIdentity.dev && earnings.identity.ino === f.earningsFileIdentity.ino)) {
    let prior;
    try { prior = ctx.restoredEntryFor(entry.id); } catch { return 'SOURCE_IDENTITY_UNPROVEN'; }
    if (!prior || prior.role.dev !== earnings.identity.dev || prior.role.ino !== earnings.identity.ino || prior.entry.walId !== entry.id || prior.entry.fenceDigest !== fenceDigest(f)
      || prior.entry.walFileSha256 !== w.sha256 || hash(prior.entry.originalIdentity) !== hash(f.earningsFileIdentity)) return 'SOURCE_IDENTITY_UNPROVEN';
  }
  return 'ELIGIBLE';
}
function buildEntry(w, spend, ctx) {
  const f = w.entry.accrualFence, identity = ctx.earnings().identity, same = identity.dev === f.earningsFileIdentity.dev && identity.ino === f.earningsFileIdentity.ino;
  return validateEntry({
    walId: w.entry.id, walFileSha256: w.sha256, walPayloadDigest: hash(w.entry.payload), fenceDigest: fenceDigest(f), spendId: spend.id, spendDigest: spend.digest, drawVectorDigest: drawVectorDigest(spend),
    earningsBeforeDigest: f.earningsBeforeDigest, originalIdentity: { dev: f.earningsFileIdentity.dev, ino: f.earningsFileIdentity.ino }, predecessorEquivalenceDigest: same ? null : hash(ctx.restoredEntryFor(w.entry.id).entry)
  }, () => fail('CHECKPOINT_CONTINUATION_EARNINGS_INVALID'));
}
// Returns { continuationEarnings: S|null, unresolvedObligations, completionGuaranteed:false }.
function evaluateObligations({ wals, retiring, ctx, epochId }) {
  const rows = wals.map(w => ({ w, reason: classifyWal(w, ctx) })).filter(r => r.reason !== null);
  const eligible = rows.filter(r => r.reason === 'ELIGIBLE');
  let candidate = null;
  for (const row of rows) {
    if (row.reason !== 'ELIGIBLE') continue;
    if (!retiring) row.reason = 'SOURCE_NOT_RETIRING';
    else if (eligible.length > 1) row.reason = 'AMBIGUOUS_SHARED_PRE_IMAGE';
    else candidate = row;
  }
  const items = rows.map(row => ({
    walId: row.w.entry.id, spendId: id(row.w.entry.accrualFence?.spendId) ? row.w.entry.accrualFence.spendId : null,
    fenceState: typeof row.w.entry.accrualFence?.state === 'string' && /^[a-z_]{1,32}$/.test(row.w.entry.accrualFence.state) ? row.w.entry.accrualFence.state : null, continuation: row === candidate ? 'record' : 'none', reason: row.reason
  })).sort((a, b) => a.walId < b.walId ? -1 : 1);
  const unresolvedObligations = validateUnresolvedObligations({ count: items.length, truncated: items.length > MAX_UNRESOLVED_ITEMS, items: items.slice(0, MAX_UNRESOLVED_ITEMS) });
  let continuationEarnings = null;
  if (candidate) {
    const spend = ctx.getSpend(candidate.w.entry.accrualFence.spendId), earnings = ctx.earnings(), { identity } = earnings;
    continuationEarnings = validateContinuationEarnings({
      schema: 1, participant: 'earnings', relativePath: 'financial-epochs/' + epochId + '/earnings.json', sha256: earnings.sha256, bytes: earnings.bytes,
      sourceIdentity: { dev: identity.dev, ino: identity.ino, uid: identity.uid, mode: identity.mode, nlink: identity.nlink }, entries: [buildEntry(candidate.w, spend, ctx)]
    }, { epochId });
  }
  return { continuationEarnings, unresolvedObligations, completionGuaranteed: false };
}

// ---- target half T (v3 2.2) ----------------------------------------------------------------------
function validateTarget(T, bad = () => fail('RESTORE_CONTINUATION_INVALID')) {
  if (T === null) return null;
  const lineage = T?.lineage, earnings = T?.earnings;
  if (!exact(T, ['schema', 'kind', 'cutDigest', 'lineage', 'earnings', 'entries']) || T.schema !== 1 || T.kind !== 'continuation_earnings_v1' || !hex(T.cutDigest)
    || !exact(lineage, ['checkpointDigest', 'restoreId', 'barrierDigest', 'epochId', 'bindingDigest', 'successorDigest']) || !['checkpointDigest', 'restoreId', 'barrierDigest', 'bindingDigest', 'successorDigest'].every(k => hex(lineage[k]))
    || typeof lineage.epochId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(lineage.epochId)
    || !exact(earnings, ['relativePath', 'sha256', 'bytes', 'targetIdentity']) || earnings.relativePath !== 'earnings.json' || !hex(earnings.sha256) || !uint(earnings.bytes) || !pair(earnings.targetIdentity)
    || !Array.isArray(T.entries) || T.entries.length !== 1 || bytesOf(T) > BOUNDS.target) bad();
  validateEntry(T.entries[0], bad);
  return T;
}
function validateRole(role, bad = () => fail('RESTORE_CONTINUATION_INVALID')) {
  if (!exact(role, ['dev', 'ino', 'bytes', 'allocatedBytes', 'uid', 'mode', 'nlink', 'relativePath', 'sha256', 'entryDigest']) || !['dev', 'ino', 'bytes', 'allocatedBytes', 'uid'].every(k => uint(role[k])) || role.mode !== 0o600 || role.nlink !== 1
    || role.relativePath !== 'earnings.json' || !hex(role.sha256) || !hex(role.entryDigest) || bytesOf(role) > BOUNDS.role) bad();
  return role;
}
// `earnings` is the owned read of the NEW target earnings file { identity:{dev,ino,bytes,allocatedBytes,uid,mode,nlink}, digest, bytes }.
function buildTarget({ source, earnings, lineage }) {
  const S = validateContinuationEarnings(source, { epochId: lineage.epochId });
  if (!S) fail('RESTORE_CONTINUATION_INVALID');
  if (earnings.digest !== S.sha256 || earnings.bytes.length !== S.bytes) fail('RESTORE_CONTINUATION_IDENTITY');
  const { dev, ino } = earnings.identity;
  const T = validateTarget({
    schema: 1, kind: 'continuation_earnings_v1', cutDigest: hash(S), lineage: { ...lineage }, earnings: { relativePath: 'earnings.json', sha256: earnings.digest, bytes: earnings.bytes.length, targetIdentity: { dev, ino } }, entries: structuredClone(S.entries)
  });
  const role = validateRole({ ...earnings.identity, relativePath: 'earnings.json', sha256: earnings.digest, entryDigest: hash(T) });
  return { target: T, role };
}

// ---- successor claim (Addendum 1 A0.2) and body.claim (Addendum 2 D2.1) -----------------------------
function validateSuccessorClaim(sc, bad = () => fail('RESTORE_CLAIM_INVALID')) {
  if (sc === null) return null;
  if (!exact(sc, ['generationId', 'restoreId', 'initializationDigest', 'successorDigest']) || !Object.values(sc).every(hex) || bytesOf(sc) > BOUNDS.successorClaim) bad();
  return sc;
}
const CLAIM_KEYS = ['schema', 'state', 'restoreId', 'generationId', 'initializationDigest', 'checkpointDigest', 'successorDigest'];
function validateClaim(claim, { allowance, manifest, initDigest } = {}) {
  if (!exact(claim, CLAIM_KEYS) || claim.schema !== 1 || !['intent', 'recorded'].includes(claim.state) || !['restoreId', 'generationId', 'initializationDigest', 'checkpointDigest'].every(k => hex(claim[k]))
    || (claim.state === 'intent' ? claim.successorDigest !== null : !hex(claim.successorDigest)) || bytesOf(claim) > BOUNDS.claim) fail('RESTORE_CLAIM_INVALID');
  if (claim.restoreId !== allowance?.requestId || claim.generationId !== generationOf(manifest) || claim.initializationDigest !== initDigest || claim.checkpointDigest !== manifest?.checksum) fail('RESTORE_CLAIM_CONFLICT');
  return claim;
}
// Write-transition check: intent first, then recorded; identity fields never change; a set successorDigest never changes.
function validateClaimTransition(previous, next) {
  const same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
  if (previous === null || previous === undefined) { if (!exact(next, CLAIM_KEYS) || next.state !== 'intent') fail('RESTORE_CLAIM_REGRESSION'); return true; }
  if (!exact(previous, CLAIM_KEYS) || !exact(next, CLAIM_KEYS)) fail('RESTORE_CLAIM_INVALID');
  if (['schema', 'restoreId', 'generationId', 'initializationDigest', 'checkpointDigest'].some(k => previous[k] !== next[k])) fail('RESTORE_CLAIM_REGRESSION');
  if (previous.state === 'recorded' && (next.state !== 'recorded' || previous.successorDigest !== next.successorDigest)) fail('RESTORE_CLAIM_REGRESSION');
  if (previous.state === 'intent' && next.state === 'intent' && !same(previous, next)) fail('RESTORE_CLAIM_REGRESSION');
  return true;
}

// ---- authorized recovery set RS of a claimed successor (Addendum 1 A0.4) ---------------------------
function recoveryAuthoritySet(plan) {
  const spendIds = new Set(), walIds = new Set(), entry = plan?.continuationEarnings?.entries?.[0], compensation = plan?.compensationEarnings;
  if (entry) { spendIds.add(entry.spendId); walIds.add(entry.walId); }
  if (compensation) { if (compensation.spendId) spendIds.add(compensation.spendId); if (compensation.walId) walIds.add(compensation.walId); }
  return { spendIds, walIds };
}
function anchorInRecoverySet(descriptor, authority) {
  if (!descriptor || typeof descriptor.id !== 'string') return false;
  if (descriptor.kind === 'spend') return authority.spendIds.has(descriptor.id);
  if (descriptor.kind === 'unlock_wal') return authority.walIds.has(descriptor.id);
  return false;
}
// Bytes the A2 plan fields add to the restore control slot (v3 2.8, Addendum 1 A4, Addendum 2 D2.1):
// the three plan keys, the continuation role, and body.claim, each counted with its key and separator.
function planAddBytes(plan, claim) {
  const keyed = (key, value) => Buffer.byteLength(JSON.stringify(key)) + 1 + bytesOf(value) + 1;
  let total = keyed('continuationEarnings', plan.continuationEarnings ?? null) + keyed('continuationWithheld', plan.continuationWithheld ?? null) + keyed('successorClaim', plan.successorClaim ?? null);
  if (plan.roles?.continuation_earnings) total += keyed('continuation_earnings', plan.roles.continuation_earnings);
  if (claim) total += keyed('claim', claim);
  return total;
}
// ---- consumption check (v3 3.2). `body` is a completed restore control body; this is pure. ----------------
// Throws an error whose non-enumerable .check is one of CHECK_NAMES.
function verifyRestoredContinuation({ body, epoch, entry, walBytes, fence, spend, actual, failure }) {
  const deny = check => fail('COMPENSATION_ACCRUAL_CONFLICT', check);
  const plan = body?.plan, T = plan?.continuationEarnings, role = plan?.roles?.continuation_earnings;
  if (!plan) deny('NO_RESTORE_BINDING');
  if (T === undefined || T === null || !role) deny('RECORD_ABSENT');
  if (!Array.isArray(T.entries) || T.entries.length === 0) deny('ENTRY_MISSING');
  if (T.entries.length > 1) deny('ENTRY_DUPLICATE');
  try { validateTarget(T); validateRole(role); } catch { deny('LINEAGE'); }
  const E = T.entries[0], claim = plan.successorClaim, lineage = T.lineage;
  if (hash(T) !== role.entryDigest || !claim || lineage.checkpointDigest !== plan.checkpointDigest || lineage.restoreId !== plan.restoreId || lineage.barrierDigest !== plan.barrierDigest
    || lineage.epochId !== epoch.epoch_id || lineage.bindingDigest !== epoch.binding_digest || lineage.successorDigest !== claim.successorDigest || claim.restoreId !== plan.restoreId) deny('LINEAGE');
  if (E.walId !== entry?.id) deny('ENTRY_MISSING');
  if (!Buffer.isBuffer(walBytes) || sha256(walBytes) !== E.walFileSha256 || hash(entry.payload) !== E.walPayloadDigest) deny('WAL_FILE');
  if (!fence || fence.state !== 'not_started' || hash(fence) !== E.fenceDigest || hash(fence.earningsFileIdentity) !== hash(E.originalIdentity)) deny('FENCE');
  if (!spend || fence.spendId !== E.spendId || fence.spendDigest !== E.spendDigest || spend.id !== E.spendId || spend.digest !== E.spendDigest) deny('SPEND');
  if (!spend.intent || drawVectorDigest(spend) !== E.drawVectorDigest) deny('DRAW_VECTOR');
  if (actual?.sha256 !== T.earnings.sha256 || T.earnings.sha256 !== E.earningsBeforeDigest || actual.bytes !== T.earnings.bytes) deny('EARNINGS_DIGEST');
  if (actual.dev !== role.dev || actual.ino !== role.ino || actual.dev !== T.earnings.targetIdentity.dev || actual.ino !== T.earnings.targetIdentity.ino) deny('TARGET_IDENTITY');
  if (failure?.state === 'compensation_requested') deny('FAILURE_STATE');
  return true;
}
const deny = check => fail('COMPENSATION_ACCRUAL_CONFLICT', check);
module.exports = {
  deny, BOUNDS, UNRESOLVED_REASONS, WITHHELD, CHECK_NAMES, MAX_UNRESOLVED_ITEMS, generationOf, validateSourceRetirement, validateEntry: (E) => validateEntry(E, () => fail('CHECKPOINT_CONTINUATION_EARNINGS_INVALID')), validateContinuationEarnings,
  validateUnresolvedObligations, validateCheckpointContinuation, fenceDigest, drawVectorDigest, expectedDraws, drawsMatch, readWalFiles, classifyWal, evaluateObligations, validateTarget, validateRole, buildTarget,
  validateSuccessorClaim, validateClaim, validateClaimTransition, recoveryAuthoritySet, anchorInRecoverySet, planAddBytes, verifyRestoredContinuation, bytesOf, sha256
};
