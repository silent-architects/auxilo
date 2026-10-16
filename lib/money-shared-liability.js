'use strict';

/**
 * Pure storage-budget accounting: one aggregate root plus separate exact holds.
 * This is not physical allocation proof, a production capacity envelope, or
 * runtime integration. It makes no promise of unlimited corrections. Consumed
 * storage is never refunded by retry. Consumption is deliberately NOT idempotent:
 * the caller must commit its returned rows and exact business receipt in one SQL
 * transaction, and deduplicate that receipt before calling consumption again.
 * A selected hold is supplied by the caller's committed-row lookup; validating
 * it does not reconcile or authenticate the entire ledger.
 */
const BLOCK = 4096n;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const ROOT_KEYS = ['schema','bindingDigest','profileDigest','capacityBytes',
  'systemRemainingBytes','workspaceReservedBytes','optionalRemainingBytes',
  'freeBytes','heldRemainingBytes','heldCount','consumedBytes'];
const HOLD_KEYS = ['id','obligationId','inputDigest','bindingDigest','profileDigest',
  'bytes','remainingBytes','consumedBytes','state'];
const CATEGORIES = ['systemRemainingBytes','workspaceReservedBytes',
  'optionalRemainingBytes','freeBytes','heldRemainingBytes','consumedBytes'];
const SYSTEM_PURPOSES = new Set(['publication','crash-recovery','checkpoint','restore']);
const AMBIGUOUS_IDS = new Set(['__proto__','constructor','prototype']);

function fail(code) { throw Object.assign(new Error(code), {code}); }
function shape(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(value))) fail('SHARED_SCHEMA_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || actual.some(key =>
      typeof key !== 'string' || !keys.includes(key) || !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], 'value'))) fail('SHARED_SCHEMA_INVALID');
}
function bytes(value, positive = false) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) ||
      BigInt(value) % BLOCK !== 0n) fail('SHARED_BYTES_INVALID');
  return BigInt(value);
}
function number(value) {
  if (value < 0n || value > MAX) fail('SHARED_INTEGER_OVERFLOW');
  return Number(value);
}
function digest(value) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) fail('SHARED_DIGEST_INVALID');
}
function obligation(value) {
  if (typeof value !== 'string' || value.length === 0 ||
      Buffer.byteLength(value, 'utf8') > 256 ||
      Buffer.byteLength('shared-hold:' + value, 'utf8') > 256 || AMBIGUOUS_IDS.has(value)) fail('SHARED_OBLIGATION_INVALID');
}

function validateSharedRoot(root) {
  shape(root, ROOT_KEYS);
  if (root.schema !== 1) fail('SHARED_SCHEMA_INVALID');
  digest(root.bindingDigest); digest(root.profileDigest);
  const capacity = bytes(root.capacityBytes, true);
  const accounted = CATEGORIES.reduce((sum, key) => sum + bytes(root[key]), 0n);
  if (accounted > MAX || accounted !== capacity) fail('SHARED_CONSERVATION_INVALID');
  if (!Number.isSafeInteger(root.heldCount) || root.heldCount < 0 ||
      root.heldCount === 0 && root.heldRemainingBytes !== 0 ||
      BigInt(root.heldCount) * BLOCK > BigInt(root.heldRemainingBytes) + BigInt(root.consumedBytes)) {
    fail('SHARED_HOLD_COUNT_INVALID');
  }
  return {verified:true, capacityBytes:root.capacityBytes,
    accountedBytes:number(accounted), heldRemainingBytes:root.heldRemainingBytes,
    heldCount:root.heldCount};
}

function createSharedRoot(input) {
  shape(input, ['capacityBytes','systemBytes','workspaceBytes','optionalBytes','bindingDigest','profileDigest']);
  digest(input.bindingDigest); digest(input.profileDigest);
  const capacity = bytes(input.capacityBytes, true);
  const system = bytes(input.systemBytes), workspace = bytes(input.workspaceBytes), optional = bytes(input.optionalBytes);
  const allocated = system + workspace + optional;
  if (allocated > capacity) fail('SHARED_CAPACITY_EXCEEDED');
  const root = {schema:1,bindingDigest:input.bindingDigest,profileDigest:input.profileDigest,
    capacityBytes:input.capacityBytes,systemRemainingBytes:input.systemBytes,
    workspaceReservedBytes:input.workspaceBytes,optionalRemainingBytes:input.optionalBytes,
    freeBytes:number(capacity-allocated),heldRemainingBytes:0,heldCount:0,consumedBytes:0};
  validateSharedRoot(root);
  return root;
}

function validateSharedHold(hold, root) {
  validateSharedRoot(root);
  shape(hold, HOLD_KEYS);
  obligation(hold.obligationId);
  digest(hold.inputDigest); digest(hold.bindingDigest); digest(hold.profileDigest);
  if (hold.id !== 'shared-hold:' + hold.obligationId || hold.state !== 'held' ||
      hold.bindingDigest !== root.bindingDigest || hold.profileDigest !== root.profileDigest) fail('SHARED_HOLD_BINDING_INVALID');
  const original = bytes(hold.bytes, true), remaining = bytes(hold.remainingBytes), consumed = bytes(hold.consumedBytes);
  if (original !== remaining + consumed || original > BigInt(root.capacityBytes) ||
      remaining > BigInt(root.heldRemainingBytes) || consumed > BigInt(root.consumedBytes) ||
      root.heldCount < 1) fail('SHARED_HOLD_CONSERVATION_INVALID');
  return {verified:true,id:hold.id,bytes:hold.bytes,remainingBytes:hold.remainingBytes,consumedBytes:hold.consumedBytes};
}

function reserveSharedLiability(root, existingHold, input) {
  validateSharedRoot(root);
  shape(input, ['obligationId','inputDigest','bytes']);
  obligation(input.obligationId); digest(input.inputDigest);
  const amount = bytes(input.bytes, true);
  if (existingHold !== undefined) {
    validateSharedHold(existingHold, root);
    if (existingHold.obligationId !== input.obligationId ||
        existingHold.inputDigest !== input.inputDigest || existingHold.bytes !== input.bytes) fail('SHARED_RESERVATION_CONFLICT');
    return {root:{...root},hold:{...existingHold},duplicate:true};
  }
  if (amount > BigInt(root.freeBytes)) fail('SHARED_FREE_EXHAUSTED');
  const next = {...root,freeBytes:number(BigInt(root.freeBytes)-amount),
    heldRemainingBytes:number(BigInt(root.heldRemainingBytes)+amount),
    heldCount:number(BigInt(root.heldCount)+1n)};
  const hold = {id:'shared-hold:'+input.obligationId,obligationId:input.obligationId,
    inputDigest:input.inputDigest,bindingDigest:root.bindingDigest,profileDigest:root.profileDigest,
    bytes:input.bytes,remainingBytes:input.bytes,consumedBytes:0,state:'held'};
  validateSharedHold(hold,next);
  return {root:next,hold,duplicate:false};
}

function consumeSharedLiability(root, hold, input) {
  validateSharedHold(hold,root);
  shape(input, ['obligationId','bytes']);
  obligation(input.obligationId);
  const amount = bytes(input.bytes,true);
  if (input.obligationId !== hold.obligationId) fail('SHARED_HOLD_OWNER_CONFLICT');
  if (amount > BigInt(hold.remainingBytes)) fail('SHARED_HOLD_EXHAUSTED');
  const nextRoot = {...root,heldRemainingBytes:number(BigInt(root.heldRemainingBytes)-amount),
    consumedBytes:number(BigInt(root.consumedBytes)+amount)};
  const nextHold = {...hold,remainingBytes:number(BigInt(hold.remainingBytes)-amount),
    consumedBytes:number(BigInt(hold.consumedBytes)+amount)};
  validateSharedHold(nextHold,nextRoot);
  return {root:nextRoot,hold:nextHold};
}

function consumeCategory(root, value, category) {
  validateSharedRoot(root);
  const amount = bytes(value,true);
  if (amount > BigInt(root[category])) fail('SHARED_CATEGORY_EXHAUSTED');
  const next = {...root,[category]:number(BigInt(root[category])-amount),
    consumedBytes:number(BigInt(root.consumedBytes)+amount)};
  validateSharedRoot(next);
  return next;
}
function consumeDiscretionaryShared(root, input) {
  shape(input,['bytes']);
  return consumeCategory(root,input.bytes,'optionalRemainingBytes');
}
function consumeSystemShared(root, input) {
  shape(input,['bytes','purpose']);
  if (!SYSTEM_PURPOSES.has(input.purpose)) fail('SHARED_SYSTEM_PURPOSE_INVALID');
  return consumeCategory(root,input.bytes,'systemRemainingBytes');
}
module.exports = {createSharedRoot,validateSharedRoot,validateSharedHold,reserveSharedLiability,
  consumeSharedLiability,consumeDiscretionaryShared,consumeSystemShared};
