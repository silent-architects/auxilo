// lib/wal.js
//
// Write-Ahead Log (WAL) for crash-safe dual-write operations.
// Provides atomicity guarantees for multi-step disk writes (e.g., the
// unlock handler writing both learnings.json and earnings.json).
//
// Protocol:
//   1. createWalEntry(operation, payload)  — write WAL file before doing anything
//   2. markStepComplete(id, step)          — record each step as it completes
//   3. commitWal(id)                       — delete WAL file (operation done)
//
// On startup, any surviving WAL files represent interrupted operations.
// The caller is responsible for replaying them via getPendingWalEntries().
//
// Addresses: C3 (non-atomic dual write on unlock)

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WAL_DIR = require('./financial-epoch').resolveParticipantPath('wal', { envOverride: process.env.AUXILO_WAL_DIR, legacyPath: path.join(process.env.AUXILO_DATA_DIR || path.join(__dirname, '..', 'data'), 'wal') });

// Ensure WAL directory exists on first require
if (!fs.existsSync(WAL_DIR)) {
    fs.mkdirSync(WAL_DIR, { recursive: true });
}

/**
 * Create a WAL entry and persists it to disk before any writes begin.
 *
 * @param {string} operation - e.g. 'unlock'
 * @param {object} payload   - all data needed to replay the operation
 * @returns {string}          the WAL entry ID
 */
function createWalEntry(operation, payload, {preWalCapability} = {}) {
    let recovery;
    if(require('./money-control').getMoneyRuntime()?.failureControl && operation==='unlock' && payload?.funding_source==='credit_pack'){
        const {ctx,runtime}=recoveryContext(),a=preWalAuthorities.get(preWalCapability);
        if(!a||!a.valid||a.ctx!==ctx)throw recoveryFail('COMPENSATION_PREWAL_AUTHORITY_REQUIRED');
        a.valid=false; // Invalidate before any WAL creation attempt.
        const spend=runtime.store.getSpend(a.spendId);assertDrawVector(spend,payload.dollar_draws);
        recovery={schema:1,state:'not_started',spendId:spend.id,spendDigest:spend.digest,earningsBeforeDigest:a.before.digest,earningsFileIdentity:a.before.identity};
    }
    const id = crypto.randomUUID();
    const entry = {
        id,
        operation,
        payload,
        ...(recovery ? {accrualFence:recovery} : {}),
        steps_completed: [],
        created_at: Date.now(),
    };
    _writeWalFile(id, entry);
    if(recovery)accrualContexts.set(require('./money-control').assertMoneyContext(),{state:'not_started',id});
    return id;
}

/**
 * Mark a named step as completed within a WAL entry.
 * Call this immediately after each sub-write succeeds.
 *
 * @param {string} id   - WAL entry ID
 * @param {string} step - step name, e.g. 'update_learnings'
 */
function markStepComplete(id, step) {
    const entry = _readWalFile(id);
    if (!entry) {
        console.warn(`[wal] markStepComplete: entry ${id} not found`);
        return;
    }
    if (!entry.steps_completed.includes(step)) {
        entry.steps_completed.push(step);
    }
    _writeWalFile(id, entry);
}

/**
 * AUD19-16: Merge additional fields into a WAL entry's payload after creation.
 * Used by the /withdraw timeout branch to record the broadcast disposition
 * (and tx_hash) BEFORE the debit lands, so startup recovery can replay the
 * correct completion (a timeout settlement record, not a 'settled' one) even
 * when the crash hit between broadcast and the first ledger write.
 *
 * @param {string} id    - WAL entry ID
 * @param {object} patch - fields merged (shallow) into entry.payload
 */
function updateWalPayload(id, patch) {
    const entry = _readWalFile(id);
    if (!entry) {
        console.warn(`[wal] updateWalPayload: entry ${id} not found`);
        return;
    }
    if(entry.accrualFence)throw recoveryFail('COMPENSATION_IMMUTABLE_WAL');
    entry.payload = { ...(entry.payload || {}), ...(patch || {}) };
    _writeWalFile(id, entry);
}

/**
 * Commit a WAL entry by deleting its file.
 * Only call this after ALL steps have succeeded.
 *
 * @param {string} id - WAL entry ID
 */
function commitWal(id) {
    const filePath = _walPath(id);
    const runtime=require('./money-control').getMoneyRuntime();
    if(runtime){require('./money-control').assertParticipantWrite(filePath);handoffFinancialSource(id);}
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            if(runtime)require('./stripe-transfer-persistence').syncDirectory(WAL_DIR);
        }
    } catch (err) {
        if(runtime){require('./money-control').poisonMoneyRuntime(err);throw err;}
        console.error(`[wal] Failed to commit (delete) WAL entry ${id}:`, err.message);
    }
}

/**
 * AUD19-10: Abort a WAL entry — the operation was compensated in-request (e.g.
 * a credit-funded unlock whose delivery failed and whose credit was refunded),
 * so the entry must NOT survive to be replayed at startup: a replay would
 * re-land an accrual whose funding was already returned to the buyer.
 *
 * Returns true when the entry is guaranteed gone (deleted now, or already
 * absent — either way nothing can replay). Returns false ONLY when the file
 * could not be removed; in that case the caller must NOT refund (the accrual
 * will land on replay, and refunding too would double-pay).
 *
 * @param {string} id - WAL entry ID
 * @returns {boolean} true when nothing can replay for this id
 */
function abortWal(id, compensationCapability) {
    const filePath = _walPath(id);
    const runtime=require('./money-control').getMoneyRuntime();
    if(runtime?.failureControl){
        const c=runtime.failureControl.assertCompensation(compensationCapability,{});
        if(c.walId!==id)throw recoveryFail('COMPENSATION_WAL_AUTHORITY_REQUIRED');
        const spend=runtime.store.getSpend(c.spendId);verifyPendingCompensation({spend,compensation:c});
        require('./money-control').assertParticipantWrite(filePath);
        const target=filePath.replace(/\.wal\.json$/,'.compensation.json'),old=_readWalFile(id),canceled=readCanceled(id);
        if(canceled){if(old||recoveryHash(canceled.payload)!==c.walPayloadDigest)throw recoveryFail('COMPENSATION_WAL_AUTHORITY_REQUIRED');return true;}
        if(!old)throw recoveryFail('COMPENSATION_WAL_AUTHORITY_REQUIRED');
        fs.renameSync(filePath,target);require('./stripe-transfer-persistence').syncDirectory(WAL_DIR);return true;
    }
    if(runtime){require('./money-control').assertParticipantWrite(filePath);if(require('./money-control').assertMoneyContext().getPool('unlock:'+id))return false;}
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            if(runtime)require('./stripe-transfer-persistence').syncDirectory(WAL_DIR);
        }
        return true;
    } catch (err) {
        if(runtime)require('./money-control').poisonMoneyRuntime(err);
        console.error(`[wal] Failed to abort WAL entry ${id}:`, err.message);
        return false;
    }
}

/**
 * Return all pending (uncommitted) WAL entries.
 * Used at startup to replay interrupted operations.
 *
 * @returns {Array<object>}
 */
function getPendingWalEntries() {
    let files;
    try {
        files = fs.readdirSync(WAL_DIR).filter(f => f.endsWith('.wal.json'));
    } catch (err) {
        if(require('./financial-epoch').getRuntimeEpoch())throw err;
        console.error('[wal] Failed to read WAL directory:', err.message);
        return [];
    }

    const entries = [];
    for (const file of files) {
        try {
            const raw = fs.readFileSync(path.join(WAL_DIR, file), 'utf8');
            entries.push(JSON.parse(raw));
        } catch (err) {
            if(require('./financial-epoch').getRuntimeEpoch())throw err;
            console.error(`[wal] Could not parse WAL file ${file}:`, err.message);
            // Intentionally leave corrupt file on disk for manual inspection
        }
    }
    return entries;
}

function walDir() {
    return WAL_DIR;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function _walPath(id) {
    if(typeof id!=='string'||! /^[a-zA-Z0-9_-]+$/.test(id))throw Object.assign(Error('INVALID_WAL_ID'),{code:'INVALID_WAL_ID'});
    return path.join(WAL_DIR, `${id}.wal.json`);
}

function _writeWalFile(id, entry) {
    const filePath = _walPath(id);
    const money=require('./money-control');money.assertParticipantWrite(filePath);
    try{require('./stripe-transfer-persistence').writeJSONAtomic(filePath,entry);}
    catch(error){money.poisonMoneyRuntime(error);throw error;}
}

function _readWalFile(id) {
    try {
        const file=_walPath(id),st=fs.lstatSync(file);
        if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw recoveryFail('COMPENSATION_WAL_AUTHORITY_REQUIRED');
        const raw = fs.readFileSync(file, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        if(require('./financial-epoch').getRuntimeEpoch()&&error.code!=='ENOENT')throw error;
        return null;
    }
}


// Transfer actual paid attribution to the permanent journal before deleting WAL.
// Unknown original/other cost keeps margin waiting; it never loses the source.
function handoffFinancialSource(id) {
  const entry = _readWalFile(id);
  if (! entry) return null;
  const money = require('./money-control'), ctx = money.assertMoneyContext(), p = entry.payload || {
  };
  if (entry.operation !== 'unlock' || p.funding_source !== 'credit_pack') return null;
  const paid =(p.dollar_draws ||[]).filter(d => d.kind === 'dollar_paid' && d.amount > 0);
  if (! paid.length) return null;
  if (! entry.steps_completed.includes('update_earnings')) throw Object.assign(Error('SOURCE_EARNINGS_NOT_DURABLE'), {
    code: 'SOURCE_EARNINGS_NOT_DURABLE'
  });
  const ids =[... new Set(paid.map(d => d.spend_id).filter(Boolean))];
  if (ids.length !== 1) throw Object.assign(Error('SPEND_RECEIPT_REQUIRED'), {
    code: 'SPEND_RECEIPT_REQUIRED'
  });
  const input = financialSourceInput(entry,ctx);
  const receipt = ctx.recordRealization(input);
  ctx.flush();
  if (! entry.steps_completed.includes('money_source_handoff')) {
    entry.steps_completed.push('money_source_handoff');
    _writeWalFile(id, entry);
  }
  return receipt;
}
function financialSourceInput(entry,ctx) {
  const money=require('./money-control'),p=entry.payload,paid=(p.dollar_draws||[]).filter(d=>d.kind==='dollar_paid'&&d.amount>0),ids=[...new Set(paid.map(d=>d.spend_id).filter(Boolean))];
  if(ids.length!==1)throw recoveryFail('SPEND_RECEIPT_REQUIRED');
  const draws = paid.map(d => {
    const source = ctx.getSourceByLot(p.purchaser_account_id,d.lot_id);
    if (! source) throw Object.assign(Error('SOURCE_PROVENANCE_INVALID'), {
      code: 'SOURCE_PROVENANCE_INVALID'
    });
    return {
      sourceId: source.id, amountMicros: money.toMicros(d.amount)
    };
  });
  const input = {
    id: 'unlock:' + entry.id, spend_id: ids[0], buyerId: p.purchaser_account_id, contributorId: p.contributor_account_id || null,
    platformShareMicros: p.platform_earned_micros === undefined ? money.toMicros(p.platform_earned): p.platform_earned_micros,
    contributorShareMicros: p.contributor_earned_micros === undefined ? money.toMicros(p.contributor_earned): p.contributor_earned_micros,
    draws, epoch_id: ctx.epoch.epoch_id, binding_digest: ctx.epoch.binding_digest, verified: true, ...(p.money_other_costs ? {
      otherCosts: p.money_other_costs
    }: {
    })
  };
  input.receipt_digest = require('./money-control-store').digest(input);
  return input;
}

// Recovery authority is process-local; durable markers are revalidated independently.
const preWalAuthorities = new WeakMap(), walAuthorities = new WeakMap(), earningsAuthorities = new WeakMap(), accrualContexts = new WeakMap();
const recoveryFail = code => Object.assign(new Error(code), {code});
const recoveryHash = value => require('./stripe-transfer-persistence').digestJSON(value);
function recoveryContext() {
    const money=require('./money-control'), runtime=money.getMoneyRuntime();
    if(!runtime?.failureControl)throw recoveryFail('COMPENSATION_AUTHORITY_REQUIRED');
    return {money,runtime,ctx:money.assertMoneyContext()};
}
function durableParticipant(name) {
    const {runtime}=recoveryContext(),file=require('./financial-epoch').pathFor(name,runtime.epoch);
    const before=fs.lstatSync(file);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)throw recoveryFail('COMPENSATION_PARTICIPANT_IDENTITY');
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try {const opened=fs.fstatSync(fd);if(opened.dev!==before.dev||opened.ino!==before.ino)throw recoveryFail('COMPENSATION_PARTICIPANT_IDENTITY');
        const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd),named=fs.lstatSync(file);
        if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||named.ino!==opened.ino||named.dev!==opened.dev)throw recoveryFail('COMPENSATION_PARTICIPANT_IDENTITY');
        return {value:JSON.parse(bytes),digest:crypto.createHash('sha256').update(bytes).digest('hex'),identity:{dev:opened.dev,ino:opened.ino},file};
    } finally {fs.closeSync(fd);}
}
function assertSpendDebit(spend) {
    if(!spend||!['acknowledged','returned'].includes(spend.state)||!spend.intent||recoveryHash(spend.intent)!==spend.digest||!Array.isArray(spend.intent.participantDraws)||!spend.intent.participantDraws.length)throw recoveryFail('COMPENSATION_SPEND_AUTHORITY_REQUIRED');
    const credits=durableParticipant('credits').value,receipt=credits[spend.accountId]?.money_receipts?.[spend.id];
    const central=require('./money-control').assertMoneyContext().getAppliedEffect?.({participant:'credits',owner:spend.accountId,id:spend.id});
    const actual=receipt||central?.receipt;
    if(actual?.projection_id!==spend.id||actual?.digest!==spend.digest)throw recoveryFail('COMPENSATION_DEBIT_RECEIPT_REQUIRED');
    return spend.intent.participantDraws;
}
function runtimeDraws(spend) {
    return assertSpendDebit(spend).map(d=>({lot_id:d.lotId,kind:d.kind,amount:d.amountMicros/1e6,spend_id:spend.id,inflight_marked:true}));
}
function assertDrawVector(spend,draws) {
    const expected=runtimeDraws(spend);
    if(!Array.isArray(draws)||draws.length!==expected.length)throw recoveryFail('COMPENSATION_DRAW_AUTHORITY_REQUIRED');
    for(let i=0;i<expected.length;i++){const d=draws[i],x=expected[i];if(!d||d.lot_id!==x.lot_id||d.kind!==x.kind||d.amount!==x.amount||d.spend_id!==x.spend_id||d.inflight_marked!==true)throw recoveryFail('COMPENSATION_DRAW_AUTHORITY_REQUIRED');}
    return expected;
}
function createPreWalPhase({spendId}={}) {
    const {runtime,ctx}=recoveryContext();ctx.flush();
    const spend=runtime.store.getSpend(spendId);assertSpendDebit(spend);
    if(spend.state!=='acknowledged')throw recoveryFail('COMPENSATION_SPEND_AUTHORITY_REQUIRED');
    const before=durableParticipant('earnings'),token=Object.freeze({});
    const state={ctx,spendId,spendDigest:spend.digest,before,valid:true};preWalAuthorities.set(token,state);accrualContexts.set(ctx,{state:'pre_wal',spendId});return token;
}
function resolveWalCapability(id) {
    const {ctx}=recoveryContext(),entry=_readWalFile(id);
    if(!entry)throw recoveryFail('COMPENSATION_WAL_AUTHORITY_REQUIRED');
    const token=Object.freeze({});walAuthorities.set(token,{ctx,id,payloadDigest:recoveryHash(entry.payload)});return token;
}
function proofFor(spend,entry,before) {
    const {ctx}=recoveryContext();assertSpendDebit(spend);
    if(spend.state==='realized'||entry&&ctx.getPool('unlock:'+entry.id))throw recoveryFail('COMPENSATION_ACCRUAL_CONFLICT');
    if(entry){const f=entry.accrualFence;if(entry.operation!=='unlock'||entry.payload?.funding_source!=='credit_pack'||entry.payload.purchaser_account_id!==spend.accountId||!f||f.state!=='not_started'||f.spendId!==spend.id||f.spendDigest!==spend.digest||entry.steps_completed.includes('update_earnings'))throw recoveryFail('COMPENSATION_ACCRUAL_CONFLICT');assertDrawVector(spend,entry.payload.dollar_draws);before={digest:f.earningsBeforeDigest,identity:f.earningsFileIdentity};}
    const current=durableParticipant('earnings');if(!before||current.digest!==before.digest)throw recoveryFail('COMPENSATION_ACCRUAL_CONFLICT');
    if(recoveryHash(current.identity)!==recoveryHash(before.identity)){const {runtime}=recoveryContext(),selected=runtime.failureControl.status().compensation;if(!selected||selected.spendId!==spend.id||selected.spendDigest!==spend.digest||selected.walId!==(entry?.id||null)||recoveryHash(selected.earningsFileIdentity)!==recoveryHash(before.identity))throw recoveryFail('COMPENSATION_ACCRUAL_CONFLICT');require('./money-atomic-restore').assertRestoredEarningsIdentity({epoch:runtime.epoch,writer:runtime.writer,root:runtime.store.getCapacityRecord('capacity:root'),compensation:selected,actual:{...current.identity,sha256:current.digest,bytes:fs.lstatSync(current.file).size}});}
    const proof={walId:entry?.id||null,walPayloadDigest:entry?recoveryHash(entry.payload):null,earningsBeforeDigest:before.digest,earningsFileIdentity:before.identity,drawVectorDigest:recoveryHash({accountId:spend.accountId,spendId:spend.id,participantDraws:spend.intent.participantDraws})};
    proof.noAccrualProofDigest=recoveryHash({...proof,spendDigest:spend.digest});return proof;
}
function verifyCompensationAuthority({spend,walCapability,preWalCapability}={}) {
    const {ctx,runtime}=recoveryContext();if(runtime.uncertain)throw recoveryFail('COMPENSATION_ACCRUAL_CONFLICT');
    if(walCapability&&preWalCapability)throw recoveryFail('COMPENSATION_AUTHORITY_REQUIRED');
    if(walCapability){const a=walAuthorities.get(walCapability),entry=a&&_readWalFile(a.id);if(!a||a.ctx!==ctx||!entry||recoveryHash(entry.payload)!==a.payloadDigest)throw recoveryFail('COMPENSATION_WAL_AUTHORITY_REQUIRED');return proofFor(spend,entry);}
    const a=preWalAuthorities.get(preWalCapability);if(!a||!a.valid||a.ctx!==ctx||a.spendId!==spend.id||a.spendDigest!==spend.digest)throw recoveryFail('COMPENSATION_PREWAL_AUTHORITY_REQUIRED');return proofFor(spend,null,a.before);
}
function readCanceled(id){const file=_walPath(id).replace(/\.wal\.json$/,'.compensation.json');try{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw recoveryFail('COMPENSATION_WAL_AUTHORITY_REQUIRED');return JSON.parse(fs.readFileSync(file));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function verifyPendingCompensation({spend,compensation:c}={}) {
    if(!c||c.spendId!==spend?.id||c.spendDigest!==spend.digest)throw recoveryFail('COMPENSATION_AUTHORITY_REQUIRED');
    let entry=null;if(c.walId){entry=_readWalFile(c.walId)||readCanceled(c.walId);if(!entry){
        const receipt=durableParticipant('credits').value[spend.accountId]?.money_receipts?.[spend.id+':restore'];
        if(spend.state!=='returned'||receipt?.projection_id!==spend.id+':restore'||receipt.digest!==spend.digest)throw recoveryFail('COMPENSATION_WAL_AUTHORITY_REQUIRED');
        // Cleanup already completed; the durable marker plus exact returned receipt
        // permits only final gate resolution, never a second participant restoration.
        return {...c};
    }if(recoveryHash(entry.payload)!==c.walPayloadDigest)throw recoveryFail('COMPENSATION_WAL_AUTHORITY_REQUIRED');}
    const proof=proofFor(spend,entry,{digest:c.earningsBeforeDigest,identity:c.earningsFileIdentity});
    for(const key of Object.keys(proof))if(recoveryHash(proof[key])!==recoveryHash(c[key]))throw recoveryFail('COMPENSATION_AUTHORITY_REQUIRED');return proof;
}
function beginEarningsWrite(id) {
    const {ctx}=recoveryContext(),entry=_readWalFile(id),f=entry?.accrualFence;
    if(!f||f.state!=='not_started'||entry.steps_completed.includes('update_earnings'))throw recoveryFail('COMPENSATION_ACCRUAL_CONFLICT');
    const current=durableParticipant('earnings');if(current.digest!==f.earningsBeforeDigest||recoveryHash(current.identity)!==recoveryHash(f.earningsFileIdentity))throw recoveryFail('COMPENSATION_ACCRUAL_CONFLICT');
    entry.accrualFence={...f,state:'write_started'};_writeWalFile(id,entry);
    const token=Object.freeze({});earningsAuthorities.set(token,{ctx,id,valid:true});accrualContexts.set(ctx,{state:'write_started',id,active:false});return token;
}
function beginEarningsContinuation(id,reversals) {
    const {ctx}=recoveryContext(),entry=_readWalFile(id);
    if(!entry?.accrualFence||entry.accrualFence.state!=='write_started'||!entry.steps_completed.includes('update_earnings')||!Array.isArray(reversals)||!reversals.length)throw recoveryFail('EARNINGS_CONTINUATION_AUTHORITY_REQUIRED');
    const credits=durableParticipant('credits').value,owner=entry.payload.purchaser_account_id,seen=new Set();
    for(const request of reversals){
      const lot=credits[owner]?.dollar_lots?.find(x=>x.lot_id===request.lot_id),actual=lot?.funded_unlocks?.find(x=>x.id===request.id);
      if(!actual||actual.unlock_id!==id||actual.pending_reversal!==true||seen.has(actual.id)||recoveryHash({...actual,lot_id:lot.lot_id})!==recoveryHash(request))throw recoveryFail('EARNINGS_CONTINUATION_AUTHORITY_REQUIRED');seen.add(actual.id);
    }
    entry.earningsContinuation={kind:'funding_reversal',state:'write_started',inputsDigest:recoveryHash(reversals)};_writeWalFile(id,entry);
    const token=Object.freeze({});earningsAuthorities.set(token,{ctx,id,valid:true});accrualContexts.set(ctx,{state:'write_started',id,active:false});return token;
}

function writeEarnings(id,capability,write) {
    const {ctx}=recoveryContext(),a=earningsAuthorities.get(capability);if(!a||!a.valid||a.ctx!==ctx||a.id!==id||typeof write!=='function')throw recoveryFail('EARNINGS_WRITE_AUTHORITY_REQUIRED');
    a.valid=false;const phase=accrualContexts.get(ctx);phase.active=true;
    try {return write();} finally {phase.active=false;}
}
function assertEarningsWrite(file) {
    const money=require('./money-control'),runtime=money.getMoneyRuntime();if(!runtime?.failureControl)return;
    if(file!==require('./financial-epoch').pathFor('earnings',runtime.epoch))return;
    const phase=accrualContexts.get(money.assertMoneyContext());if(phase&&!phase.active)throw recoveryFail('EARNINGS_WRITE_FENCE_REQUIRED');
}
function captureLearningState(learning) {
    const field=(object,key)=>Object.hasOwn(object||{},key)?{present:true,value:structuredClone(object[key])}:{present:false,value:null};
    return {qualityUnlocks:field(learning.quality,'unlocks'),unlocksTotal:field(learning.quality,'unlocks_total'),demand:field(learning,'demand'),learningEarnings:field(learning,'earnings')};
}
function createLearningRecovery(learningId,before,learning) {
    const {runtime}=recoveryContext(),after=captureLearningState(learning);
    if(learning.id!==learningId)throw recoveryFail('COMPENSATION_LEARNING_IDENTITY');
    const value={schema:1,learningId,before:structuredClone(before),after,beforeDigest:recoveryHash(before),afterDigest:recoveryHash(after)};
    const max=runtime.store.getCapacityRecord('capacity:root')?.profile.maxRowBytes;
    if(!Number.isSafeInteger(max)||Buffer.byteLength(JSON.stringify(value))>max)throw recoveryFail('COMPENSATION_LEARNING_BOUND');return value;
}
function learningInput(capability) {
    const {runtime}=recoveryContext(),c=runtime.failureControl.assertCompensation(capability,{});
    if(!c.walId)return null;
    const entry=readCanceled(c.walId)||_readWalFile(c.walId);
    if(!entry||recoveryHash(entry.payload)!==c.walPayloadDigest)throw recoveryFail('COMPENSATION_WAL_AUTHORITY_REQUIRED');
    const value=entry.payload.learningRecovery;
    if(!entry.payload.learning_id&&!value)return null; // Non-catalog isolated/compatibility operations.
    if(!value||value.schema!==1||value.learningId!==entry.payload.learning_id||recoveryHash(value.before)!==value.beforeDigest||recoveryHash(value.after)!==value.afterDigest)throw recoveryFail('COMPENSATION_LEARNING_IDENTITY');
    return value;
}
function readLearningCatalog() {
    const {runtime}=recoveryContext(),file=path.join(runtime.epoch.legacy_root,'learnings.json'),st=fs.lstatSync(file);
    if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw recoveryFail('COMPENSATION_LEARNING_IDENTITY');
    const data=JSON.parse(fs.readFileSync(file));if(!Array.isArray(data))throw recoveryFail('COMPENSATION_LEARNING_IDENTITY');return{file,data};
}
// Live caller holds the catalog lock; synchronous boot runs before any requests.
function restoreLearningCompensation(capability) {
    const value=learningInput(capability);if(!value)return {changed:false};
    const {file,data}=readLearningCatalog(),rows=data.filter(x=>x.id===value.learningId);if(rows.length!==1)throw recoveryFail('COMPENSATION_LEARNING_IDENTITY');
    const learning=rows[0],current=recoveryHash(captureLearningState(learning));if(current===value.beforeDigest)return {changed:false};
    if(current!==value.afterDigest)throw recoveryFail('COMPENSATION_LEARNING_CONFLICT');
    const assign=(object,key,f)=>{if(f.present)object[key]=structuredClone(f.value);else delete object[key];};
    learning.quality=learning.quality||{};assign(learning.quality,'unlocks',value.before.qualityUnlocks);assign(learning.quality,'unlocks_total',value.before.unlocksTotal);assign(learning,'demand',value.before.demand);assign(learning,'earnings',value.before.learningEarnings);
    if(recoveryHash(captureLearningState(learning))!==value.beforeDigest)throw recoveryFail('COMPENSATION_LEARNING_CONFLICT');
    require('./stripe-transfer-persistence').writeJSONAtomic(file,data);return{changed:true};
}
function verifyLearningRestored(capability) {
    const value=learningInput(capability);if(!value)return;
    const rows=readLearningCatalog().data.filter(x=>x.id===value.learningId);if(rows.length!==1||recoveryHash(captureLearningState(rows[0]))!==value.beforeDigest)throw recoveryFail('COMPENSATION_LEARNING_RESTORE_REQUIRED');
}
function scanRecoveryWals({afterId=null,limit=100}={}) {
    recoveryContext();if(!Number.isSafeInteger(limit)||limit<1||limit>1000||afterId!==null&&typeof afterId!=='string')throw recoveryFail('COMPENSATION_WAL_SCAN_INVALID');
    const names=fs.readdirSync(WAL_DIR).filter(x=>/\.(wal|compensation)\.json$/.test(x)).sort(),hash=crypto.createHash('sha256'),items=[];
    for(const name of names){const file=path.join(WAL_DIR,name),st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw recoveryFail('COMPENSATION_WAL_AUTHORITY_REQUIRED');const bytes=fs.readFileSync(file);hash.update(JSON.stringify([name,st.dev,st.ino,bytes.length,crypto.createHash('sha256').update(bytes).digest('hex')]));if((afterId===null||name>afterId)&&items.length<=limit){const entry=JSON.parse(bytes);if(!entry.id||name!==entry.id+'.wal.json'&&name!==entry.id+'.compensation.json')throw recoveryFail('COMPENSATION_WAL_AUTHORITY_REQUIRED');items.push({id:entry.id,kind:'unlock_wal',cursor:name});}}
    const more=items.length>limit;if(more)items.pop();return{items,nextCursor:more?items.at(-1).cursor:null,manifestDigest:hash.digest('hex')};
}
function readRecoveryWal(id){return _readWalFile(id)||readCanceled(id);}
function readRecoveryProof(id,{store,epoch}={}) {
    if(!store||!epoch)throw recoveryFail('COMPENSATION_WAL_AUTHORITY_REQUIRED');
    const entry=readRecoveryWal(id);if(!entry)return null;
    const spendId=entry.accrualFence?.spendId||entry.payload?.dollar_draws?.[0]?.spend_id;
    if(entry.operation!=='unlock'||!spendId||!entry.payload?.purchaser_account_id)throw recoveryFail('COMPENSATION_WAL_AUTHORITY_REQUIRED');
    const spend=store.getSpend(spendId),input=financialSourceInput(entry,{epoch,getSourceByLot:(accountId,lotId)=>store.getSourceByLot(accountId,lotId)});
    if(!spend)throw recoveryFail('COMPENSATION_WAL_AUTHORITY_REQUIRED');
    return{digest:recoveryHash(entry.payload),accountId:entry.payload.purchaser_account_id,spendId,spendDigest:spend.digest,realizationReceiptDigest:input.receipt_digest};
}
function completeCompensationSync(capability,{afterStep}={}) {
    if(afterStep&&!process.env.NODE_TEST_CONTEXT)throw recoveryFail('TEST_FAULT_FORBIDDEN');
    const {runtime,ctx}=recoveryContext(),c=runtime.failureControl.assertCompensation(capability,{}),anchor=runtime.recoveryAnchors.resolveCommittedAnchor({kind:'spend',id:c.spendId});
    ctx.registerRecoveryAnchor(anchor,{action:'compensate'});
    let spend=runtime.store.getSpend(c.spendId);
    if(c.walId&&readRecoveryWal(c.walId)){abortWal(c.walId,capability);afterStep?.('wal-canceled');restoreLearningCompensation(capability);afterStep?.('learning-restored');}
    if(spend.state!=='returned'){
        require('./credits').refundDollarDrawSync(spend.accountId,runtimeDraws(spend),{compensationCapability:capability});afterStep?.('participant-restored');ctx.flush();afterStep?.('restore-acknowledged');
    }
    cleanupCompensation(capability);afterStep?.('wal-cleaned');runtime.failureControl.resolveFirst({anchor});afterStep?.('recovery-scan');return{restored:true,spendId:c.spendId};
}

function cleanupCompensation(capability) {
    const {runtime,ctx}=recoveryContext(),c=runtime.failureControl.assertCompensation(capability,{}),spend=runtime.store.getSpend(c.spendId);
    const receipt=durableParticipant('credits').value[spend?.accountId]?.money_receipts?.[c.spendId+':restore']||ctx.getAppliedEffect?.({participant:'credits',owner:spend?.accountId,id:c.spendId+':restore'})?.receipt;
    if(spend?.state!=='returned'||receipt?.projection_id!==c.spendId+':restore'||receipt.digest!==spend.digest)throw recoveryFail('COMPENSATION_RESTORE_RECEIPT_REQUIRED');
    if(c.walId){const entry=readCanceled(c.walId);if(entry)verifyLearningRestored(capability);if(entry&&recoveryHash(entry.payload)!==c.walPayloadDigest)throw recoveryFail('COMPENSATION_WAL_AUTHORITY_REQUIRED');if(entry){fs.unlinkSync(_walPath(c.walId).replace(/\.wal\.json$/,'.compensation.json'));require('./stripe-transfer-persistence').syncDirectory(WAL_DIR);}if(_readWalFile(c.walId))throw recoveryFail('COMPENSATION_WAL_AUTHORITY_REQUIRED');}
    accrualContexts.delete(ctx);return true;
}

module.exports = {
    readRecoveryProof, completeCompensationSync, beginEarningsContinuation,
    captureLearningState, createLearningRecovery, restoreLearningCompensation, scanRecoveryWals, readRecoveryWal,
    createPreWalPhase, resolveWalCapability, verifyCompensationAuthority, verifyPendingCompensation, beginEarningsWrite, writeEarnings, assertEarningsWrite, cleanupCompensation, runtimeDraws, assertDrawVector,
    handoffFinancialSource,
    createWalEntry,
    markStepComplete,
    updateWalPayload,
    commitWal,
    abortWal,
    getPendingWalEntries,
    walDir,
};
