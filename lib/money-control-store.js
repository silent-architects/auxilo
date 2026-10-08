'use strict';
// One explicitly initialized epoch journal. No missing-file or backup fallback.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const transactionContexts = new WeakSet();
const INSPECTION = Symbol('failure-cut-inspection');
const RESTORE_ACCESS = Symbol('stopped-atomic-restore');
const failureInspections = new WeakSet();
const queues = new Map();
const MAPS = ['spends', 'sources', 'costs', 'pools', 'allocations', 'quotes', 'operations', 'projections', 'provider_observations',
'exceptions', 'liquidity_evidence', 'lifecycle'];
function fail(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function digest(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}
function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw fail('INVALID_MONEY_INTEGER');
  return value;
}
function sum(values) {
  const n = values.reduce((a, b) => a + BigInt(integer(b)), 0n);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('MONEY_OVERFLOW');
  return Number(n);
}
function initialSnapshot(epoch) {
  if (!epoch || !epoch.epoch_id || !epoch.binding_digest) throw fail('MONEY_EPOCH_REQUIRED');
  return Object.fromEntries([['schema', 1], ['epoch_id', epoch.epoch_id], ['binding_digest', epoch.binding_digest], ['revision',
  0], ['sequence', 0], ['bootstrap', {
    id: 'bootstrap:' + epoch.epoch_id
  }], ... MAPS.map(k =>[k, {
  }])]);
}
function map(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function validateSnapshot(s,epoch){return validateRecords(s,epoch);}
function validateRecords(s, epoch, {entries=Object.entries,values=Object.values}={}) {
  if (!map(s) || s.schema !== 1 || s.epoch_id !== epoch.epoch_id || s.binding_digest !== epoch.binding_digest || !s.bootstrap?.id) throw fail('MONEY_SCHEMA_INVALID');
  integer(s.revision);
  integer(s.sequence);
  for (const k of MAPS) if (!map(s[k])) throw fail('MONEY_SCHEMA_INVALID');
  function walk(v) {
    if (v === null || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (k.endsWith('Micros')) integer(x);
      else if (typeof x === 'number' && !Number.isSafeInteger(x)) throw fail('MONEY_SCHEMA_INVALID');
      walk(x);
    }
  }
  walk({schema:s.schema,epoch_id:s.epoch_id,binding_digest:s.binding_digest,revision:s.revision,sequence:s.sequence,bootstrap:s.bootstrap});
  for(const name of MAPS)for(const [id,row] of entries(s[name])){if(id.endsWith('Micros'))integer(row);else if(typeof row==='number'&&!Number.isSafeInteger(row))throw fail('MONEY_SCHEMA_INVALID');walk(row);}
  const heldBySource = {
  }, spendHeldBySource = {
  }, allocatedByPool = {
  };
  for (const o of values(s.operations)) if (!['settled', 'failed', 'canceled', 'requote_required'].includes(o.state) && !o.principalRetired) heldBySource[o.sourceId] = sum([heldBySource[o.sourceId] || 0,
  o.D]);
  for (const v of values(s.spends)) if (v.state === 'prepared') for (const d of v.draws) spendHeldBySource[d.sourceId] = sum([spendHeldBySource[d.sourceId] || 0,
  d.amountMicros]);
  for (const a of values(s.allocations)) if (a.state !== 'canceled') allocatedByPool[a.poolId] = sum([allocatedByPool[a.poolId] || 0,
  a.amountMicros]);
  for (const [id, x] of entries(s.sources)) {
    if (id !== x.id || !x.accountId || x.currency !== 'usd' || x.epoch_id !== s.epoch_id || x.binding_digest !== s.binding_digest) throw fail('MONEY_SOURCE_INVALID');
    integer(x.amountMicros);
    integer(x.spentMicros);
    integer(x.retiredMicros);
    const spendHeld = spendHeldBySource[id] || 0, held = heldBySource[id] || 0;
    if (!x.admission || x.input_digest !== digest(x.admission) || x.amountMicros !== x.admission.amountMicros || x.accountId !== x.admission.accountId || x.payment_intent_id !== x.admission.payment_intent_id || digest(x.policy) !== digest(x.admission.policy) || digest(x.provenance) !== digest(x.admission.provenance)) throw fail('SOURCE_RECEIPT_CONFLICT');
    if (sum([x.spentMicros, x.retiredMicros, held, spendHeld]) > x.amountMicros) throw fail('PRINCIPAL_CONSERVATION_FAILED');
  }
  for (const [id, x] of entries(s.spends)) {
    if (id !== x.id || !['prepared', 'acknowledged', 'returned', 'realized'].includes(x.state) || !Array.isArray(x.draws) || x.digest !== digest(x.intent)) throw fail('SPEND_RECEIPT_INVALID');
    for (const d of x.draws) if (!s.sources[d.sourceId] || s.sources[d.sourceId].accountId !== x.accountId) throw fail('SPEND_RECEIPT_INVALID');
  }
  const states = new Set(['reserved', 'dispatch_intent', 'external_pending', 'submission_unknown', 'requires_action', 'succeeded_projection_pending',
  'settled', 'failed', 'canceled', 'requote_required', 'failed_projection_pending']);
  for (const [id, o] of entries(s.operations)) {
    if (id !== o.id || !states.has(o.state) || !s.sources[o.sourceId] || o.accountId !== s.sources[o.sourceId].accountId || !o.clientRequestKey || !Array.isArray(o.projectionIds)) throw fail('MONEY_OPERATION_INVALID');
    for (const key of['G', 'D', 'N', 'C', 'r']) integer(o[key]);
    if (o.type === 'source_dispute') {
      if (o.D || o.N || o.C || o.G || o.r) throw fail('OPERATION_CONSERVATION_FAILED');
    } else if (o.type === 'external_refund') {
      if (sum([o.D, o.spentReversalMicros, o.overlapMicros]) !== o.N || o.N !== o.G || o.C !== 0 || o.r !== 0 || o.N % 10000 !== 0) throw fail('OPERATION_CONSERVATION_FAILED');
    } else if (sum([o.N, o.C]) !== o.D || sum([o.D, o.r]) !== o.G || o.r >= 10000 || o.N % 10000 !== 0 || !o.N || o.C >= o.G) throw fail('OPERATION_CONSERVATION_FAILED');
    for (const pid of o.projectionIds) if (s.projections[pid]?.operationId !== id) throw fail('MONEY_PROJECTION_INVALID');
  }
  for (const [id, q] of entries(s.quotes)) {
    const {
      hash, ... body
    }
    = q;
    if (id !== q.id || hash !== digest(body)) throw fail('QUOTE_RECEIPT_CONFLICT');
  }
  for (const [id, c] of entries(s.costs)) {
    if (id !== c.id || !s.sources[c.sourceId] || !['original', 'incremental', 'source'].includes(c.kind) || c.currency !== 'usd' || c.complete !== true || c.final !== true) throw fail('MONEY_COST_INVALID');
    if (sum([c.coveredMicros, c.recoveredMicros, c.reservedMicros]) > c.amountMicros) throw fail('COST_CONSERVATION_FAILED');
  }
  for (const [id, a] of entries(s.allocations)) if (id !== a.id || !s.pools[a.poolId] || !s.operations[a.operationId] || !['reserved',
  'settled', 'canceled'].includes(a.state)) throw fail('MONEY_ALLOCATION_INVALID');
  for (const [id, p] of entries(s.pools)) {
    if (id !== p.id || !Array.isArray(p.fragments) || !Array.isArray(p.parties) || new Set(p.parties).size !== p.parties.length) throw fail('MONEY_POOL_INVALID');
    if (sum(p.fragments.map(f => f.platformShareMicros)) !== p.platformShareMicros || p.reversedMicros > p.platformShareMicros || p.recoveredMicros > p.reversedMicros) throw fail('POOL_CONSERVATION_FAILED');
    const A = p.platformShareMicros - p.reversedMicros + p.recoveredMicros;
    const O = sum([p.coveredMicros, allocatedByPool[id] || 0]);
    if (p.availableMicros !== Math.max(A - O - p.waitingMicros, 0) || p.exposureMicros !== Math.max(O - A, 0)) throw fail('POOL_CONSERVATION_FAILED');
  }
  for (const [id, p] of entries(s.projections)) if (id !== p.id || !s.operations[p.operationId] || !['pending',
  'acknowledged', 'superseded'].includes(p.state) || p.digest !== digest(p.intent)) throw fail('MONEY_PROJECTION_INVALID');
  for (const p of values(s.projections)) {
    if (p.state === 'superseded' && (p.effect !== 'retire_principal' || s.projections[p.supersededBy]?.effect !== 'restore_principal' || s.projections[p.supersededBy]?.payload.originalProjectionId !== p.id)) throw fail('MONEY_PROJECTION_INVALID');
    if (p.effect === 'restore_principal' && p.state === 'acknowledged' && typeof p.receipt?.applied !== 'boolean') throw fail('MONEY_PROJECTION_INVALID');
  }
  return s;
}
function appliedEffectId({epoch,participant,owner,id}){return digest([epoch.epoch_id,epoch.binding_digest,participant,owner,id]);}
function openMoneyStore({epoch,writer,fsImpl=fs,testFault,inspectionToken,restoreAccess}) {
  if(testFault&&!process.env.NODE_TEST_CONTEXT)throw fail('TEST_FAULT_FORBIDDEN');
  const database=require('./money-database'),{createRepository,rowPage,cursor}=require('./money-repository');
  require('./money-writer-lock').assertMoneyWriter(writer,{root:epoch.legacy_root});writer.assertOwned();
  const file=path.join(epoch.financial_dir,'money-control.sqlite'),descriptorFile=path.join(epoch.financial_dir,'money-control.json');
  const descriptor=JSON.parse(fsImpl.readFileSync(descriptorFile,'utf8'));
  if(descriptor.schema!==2||descriptor.epoch_id!==epoch.epoch_id||descriptor.binding_digest!==epoch.binding_digest||descriptor.database_file!==path.basename(file))throw fail('MONEY_DESCRIPTOR_INVALID');
  let opened=database.openDatabase(file,descriptor),uncertain=false,maintenance=false,maintenanceIdentity=null,workspaceManager=null,atomicRouter=null,activeCommitRepository=null;
  function owned(){if(uncertain)throw fail('MONEY_STORE_UNCERTAIN');writer.assertOwned();if(!opened)throw fail('MONEY_DATABASE_CLOSED');const st=fsImpl.lstatSync(file);if(st.isSymbolicLink()||st.ino!==opened.inode||st.dev!==opened.dev)throw fail('MONEY_DATABASE_INODE_CHANGED');}
  function readWorkspaceMetrics(){
    owned();
    const layout=require('./money-workspace-layout').readWorkspaceLayout(opened.db,{layoutVersion:getCapacityRecord('capacity:root')?.profile.workspace?.schema===2?2:1});
    const st=fsImpl.statSync(file);
    return{pageSize:database.safe(opened.db.pragma('page_size',{simple:true})),pageCount:database.safe(opened.db.pragma('page_count',{simple:true})),freelistCount:database.safe(opened.db.pragma('freelist_count',{simple:true})),allocatedBytes:st.blocks*512,fileBytes:st.size,...layout,revision:readMetadata().revision};
  }
  function assertWorkspaceOwner(capacity){
    owned();if(capacity?.mandatory!==true)throw fail('WORKSPACE_PROTECTED_OWNER_REQUIRED');
    let sourceId=capacity.sourceId;
    if(capacity.operationId){const operation=one('operations',capacity.operationId);if(!operation||sourceId&&sourceId!==operation.sourceId)throw fail('CAPACITY_OWNER_CONFLICT');sourceId=operation.sourceId;}
    const reservationId=sourceId?getCapacityRecord('source:'+sourceId)?.reservationId:capacity.checkoutIntentId?'funding:'+capacity.checkoutIntentId:null;
    const reservation=reservationId&&getCapacityRecord(reservationId);
    if(!reservation||reservation.state!=='reserved'||sourceId&&reservation.sourceId!==sourceId)throw fail('WORKSPACE_PROTECTED_OWNER_REQUIRED');
    return{reservationId,profileDigest:reservation.profileDigest};
  }
  function getWorkspaceWrite({id,priorRevision}){owned();const row=opened.db.prepare('SELECT payload FROM audit_events WHERE revision=?').get(priorRevision+1);if(!row)return undefined;const event=JSON.parse(row.payload);if(event.workspaceWrite?.id!==id||event.workspaceWrite.priorRevision!==priorRevision)return undefined;return{...event.workspaceWrite,committedRevision:priorRevision+1,writeSetDigest:event.writeSetDigest};}
  function installWorkspaceManager(manager){owned();if(workspaceManager||!manager||typeof manager.prepareWrite!=='function'||typeof manager.finishWrite!=='function'||typeof manager.recover!=='function')throw fail('WORKSPACE_MANAGER_INVALID');if(opened.db.inTransaction)throw fail('MONEY_SQL_TRANSACTION_ACTIVE');const capacityRoot=getCapacityRecord('capacity:root'),pending=capacityRoot?.profile.grouped?.commitProtocol==='single_sql_v1'&&getAtomicCapacityPeer().state==='active';if(!pending)manager.recover();workspaceManager=manager;}
  function workspaceLease(ctx,action,input){if(!transactionContexts.has(ctx)||ctx.store!==api)throw fail('MONEY_CONTEXT_REQUIRED');owned();if(!workspaceManager)throw fail('WORKSPACE_MANAGER_REQUIRED');return workspaceManager[action](input);}
  function workspaceStatus(){owned();if(!workspaceManager)return{available:false,reason:'WORKSPACE_MANAGER_REQUIRED'};try{return{available:true,...workspaceManager.status()};}catch(error){return{available:false,reason:error.code||'WORKSPACE_UNAVAILABLE'};}}
  function verifyWorkspaceWrite({id,committedRevision,writeSetDigest,ownerPlanDigest}){owned();const row=opened.db.prepare('SELECT payload FROM audit_events WHERE revision=?').get(committedRevision);if(!row)return false;const event=JSON.parse(row.payload);return event.writeSetDigest===writeSetDigest&&event.workspaceWrite?.id===id&&event.workspaceWrite.ownerPlanDigest===ownerPlanDigest&&event.workspaceWrite.priorRevision+1===committedRevision;}
  function workspaceBeforeWrite(authority){if(!workspaceManager)return;owned();if(!authority?.atomic)workspaceManager.recover();if(!authority)throw fail('WORKSPACE_WRITE_AUTHORITY_REQUIRED');const result=workspaceManager.prepareWrite(authority);if(authority.sqliteQuota&&(!result||result.rollbackProofDigest!==authority.sqliteQuota.rollbackProofDigest||!/^([0-9a-f]{64})$/.test(result.rollbackProofDigest||'')))throw fail('CAPACITY_ROLLBACK_PROOF_REQUIRED');return result;}
  function workspaceBeforeCommit(authority,metrics){owned();if(!workspaceManager)throw fail('WORKSPACE_MANAGER_REQUIRED');const st=fsImpl.statSync(file),space=fsImpl.statfsSync(file);if(st.blocks*512<st.size)throw fail('WORKSPACE_PHYSICAL_MISMATCH');if(typeof workspaceManager.beforeCommit!=='function')throw fail('WORKSPACE_PRECOMMIT_PROOF_REQUIRED');const result=workspaceManager.beforeCommit({...authority,metrics,physical:{fileBytes:st.size,allocatedBytes:st.blocks*512,availableBytes:space.bavail*space.bsize}});if(!result||result.then||result.verified!==true||result.quota!==true||result.rollbackProofDigest!==authority.sqliteQuota?.rollbackProofDigest)throw fail('WORKSPACE_PRECOMMIT_PROOF_REQUIRED');return result;}
  function createRollbackInspector({tempDirectory,quota}){owned();const handle=opened.db,inspect=require('./money-sqlite-runtime').createRuntimeInspector({db:handle,file,tempDirectory,quota:structuredClone(quota)});return options=>{owned();if(opened.db!==handle)throw fail('MONEY_SQLITE_HANDLE_CHANGED');return inspect(options);};}
  function workspaceAfterWrite(proof){if(workspaceManager&&!proof.atomic)workspaceManager.finishWrite(proof);}
  function installAtomicRouter({testFault}={}){owned();if(!workspaceManager)throw fail('ATOMIC_WORKSPACE_REQUIRED');atomicRouter=require('./money-atomic-router').createAtomicCapacityRouter({epoch,writer,store:api,workspaceManager,testFault});atomicRouter.recover();return atomicRouter;}
  function initializeAtomicCapacityRuntime(){owned();const root=getCapacityRecord('capacity:root');if(!root||root.profile.grouped?.commitProtocol!=='single_sql_v1')return{ready:false,reason:'ATOMIC_PROFILE_REQUIRED'};if(atomicRouter)return atomicRouter.recover();if(!workspaceManager){const tempDirectory=require('./money-sqlite-temp').ensureMoneySqliteTemp({epoch,writer});const inspect=createRollbackInspector({tempDirectory,quota:root.profile.grouped.sqlite});installWorkspaceManager(require('./money-workspace').createWorkspaceManager({epoch,writer,store:api,allocationMode:process.platform==='linux'?'linux-fallocate':'zero-fill',getProfile:()=>root.profile.workspace,getRollbackProof:inspect,getCapacityPeer:()=>getAtomicCapacityPeer()}));}return installAtomicRouter().recover();}
  function atomicCapacityStatus(){owned();if(!atomicRouter)return{ready:false,reason:'ATOMIC_ROUTER_REQUIRED'};const peer=getAtomicCapacityPeer();if(peer.state!=='idle')return{ready:false,reason:'ATOMIC_RECOVERY_REQUIRED'};const status=workspaceStatus();return status.available?{ready:true}:{ready:false,reason:status.reason};}
  function getAtomicCapacityPeer(){owned();const root=getCapacityRecord('capacity:root');if(!root)throw fail('ATOMIC_PROFILE_REQUIRED');const c=require('./money-capacity').atomicIO.readControl(epoch,root);return{state:c.state,protocol:c.protocol,groupId:c.groupId,capacityIntentChecksum:digest(c),workspaceIntentCoreDigest:c.workspaceIntentCoreDigest,priorWorkspaceSequence:c.priorWorkspaceSequence,priorWorkspaceControlDigest:c.priorWorkspaceControlDigest,lastCompleted:c.lastCompleted};}
  function verifyAtomicWorkspaceTransition({intent,disposition}){owned();if(!atomicRouter)return false;return atomicRouter.verify(intent.atomic?.workspaceIntentCore||intent.atomic||intent,disposition);}
  function bindFailureInspection(manager){
    if(!require('./money-failure-control').isFailureControl(manager))throw fail('FAILURE_INSPECTION_AUTHORITY_REQUIRED');
    const identity={dev:opened.dev,ino:opened.inode};
    return ({expectedAnchorDescriptor})=>lease(async()=>{
      writer.assertOwned();
      const st=fsImpl.lstatSync(file);
      if(st.isSymbolicLink()||st.dev!==identity.dev||st.ino!==identity.ino)throw fail('MONEY_DATABASE_INODE_CHANGED');
      if(opened?.db.inTransaction)throw fail('MONEY_SQL_TRANSACTION_ACTIVE');
      if(opened){opened.db.close();opened=null;}
      uncertain=true; // This handle is never made generally readable again.
      let fresh;
      try{
        fresh=openMoneyStore({epoch,writer,fsImpl,inspectionToken:INSPECTION});
        const root=fresh.getCapacityRecord('capacity:root');
        if(root?.profile.grouped?.commitProtocol==='single_sql_v1')fresh.initializeAtomicCapacityRuntime();
        fresh.validateDatabase({full:true});
        const anchors=require('./money-recovery-anchor').createRecoveryAnchors({epoch,writer,store:fresh});
        anchors.restore(expectedAnchorDescriptor);
        const result=Object.freeze({databaseId:descriptor.database_id,revision:fresh.readMetadata().revision,rootDigest:digest(fresh.getCapacityRecord('capacity:root')||null),anchorDescriptor:structuredClone(expectedAnchorDescriptor),resolvedPhysical:!root||fresh.atomicCapacityStatus().ready===true});
        failureInspections.add(result);return result;
      }finally{if(fresh)fresh.close();}
    });
  }
  function failureControlProof(){owned();const root=getCapacityRecord('capacity:root');if(root?.profile.grouped?.commitProtocol!=='single_sql_v1')return null;return require('./money-failure-control').openFailureControl({epoch,writer,store:api}).checkpointProof();}
  function getOperationalControl(kind='quotes'){return repository().getOperationalControl(kind);}
  function verifyOperationalQuoteAuthority(authority){
    owned();const r=activeCommitRepository,core=authority?.atomic?.workspaceIntentCore;
    if(!r||core?.schema!==2||core.operational?.kind!=='quotes'||readMetadata().database_schema!==3)return false;
    const summary=r.describeQuoteChanges();
    return !!summary&&summary.generation===core.operational.generation&&summary.quoteChangesDigest===core.operational.quoteChangesDigest&&digest(authority.operational)===digest(core.operational)&&r.state.revision===core.priorRevision&&r.writeSetDigest()===core.fullWriteSetDigest;
  }
  function mutableRepository(){return createRepository({db:opened.db,epoch,beforeWrite:workspaceBeforeWrite,beforeCommit:workspaceBeforeCommit,afterWrite:workspaceAfterWrite,testFault,atomicRouter});}
  function repository(){owned();return createRepository({db:opened.db,epoch,readOnly:true});}
  function readMetadata(){owned();return database.readMetadata(opened.db);}
  function exportSnapshot(){return repository().exportSnapshot();}
  function read(){return exportSnapshot();}
  function commitRevision(ctx,expectedRevision,next){
    if(!transactionContexts.has(ctx)||ctx.store!==api)throw fail('MONEY_CONTEXT_REQUIRED');owned();
    if(next!==ctx.repository.state){for(const name of database.COLLECTIONS){const existing=ctx.repository.rows(name);for(const row of existing)if(!(row.id in(next[name]||{})))ctx.repository.set(name,row.id,undefined);for(const[id,row]of Object.entries(next[name]||{}))ctx.repository.set(name,id,row);}ctx.repository.state.sequence=next.sequence;}
    const previousActive=activeCommitRepository;activeCommitRepository=ctx.repository;
    try{const revision=ctx.repository.commit(expectedRevision);next.revision=revision;return next;}catch(error){if(require('./money-atomic-router').isProvedUncommittedRefusal(error))throw error;if(!atomicRouter&&['MONEY_REVISION_CONFLICT','CAPACITY_ENCODED_ROW_LIMIT','CAPACITY_ENCODED_AUDIT_LIMIT','CAPACITY_RAW_EVENT_LIMIT','CAPACITY_OPTIONAL_QUOTE_LIMIT'].includes(error.code))throw error;uncertain=true;throw Object.assign(fail('MONEY_STORE_UNCERTAIN'),{cause:error});}finally{activeCommitRepository=previousActive;}
  }
  function withCapacityView(ctx,fn,{mergeDrafts=false}={}){
    if(!transactionContexts.has(ctx)||ctx.store!==api)throw fail('MONEY_CONTEXT_REQUIRED');owned();
    if(ctx.repository.hasCapacityChanges()&&!mergeDrafts)throw fail('CAPACITY_DRAFT_REQUIRES_BOUNDARY');
    const r=mutableRepository();
    const view={_capacityGet:id=>r.getCapacity(id),_capacitySet:value=>r.setCapacity(value),_capacityRevision:()=>r.state.revision,
      getOperation:({operationId})=>{const row=r.get('operations',operationId);if(!row)throw fail('OPERATION_NOT_FOUND');return row;},
      flush(){owned();try{return r.commit(r.state.revision);}catch(error){if(require('./money-atomic-router').isProvedUncommittedRefusal(error))throw error;if(!atomicRouter&&['CAPACITY_ENCODED_ROW_LIMIT','CAPACITY_ENCODED_AUDIT_LIMIT','CAPACITY_RAW_EVENT_LIMIT','CAPACITY_OPTIONAL_QUOTE_LIMIT'].includes(error.code))throw error;uncertain=true;throw Object.assign(fail('MONEY_STORE_UNCERTAIN'),{cause:error});}}};
    try{const result=fn(view);if(result?.then)throw fail('ASYNC_CAPACITY_VIEW_FORBIDDEN');return result;}
    finally{ctx.repository.rebaseCapacityRevision(database.readMetadata(opened.db),{mergeDrafts});}
  }
  async function lease(fn){const old=queues.get(file)||Promise.resolve();let release;const held=new Promise(r=>release=r),tail=old.then(()=>held);queues.set(file,tail);await old;try{return await fn();}finally{release();if(queues.get(file)===tail)queues.delete(file);}}
  async function transaction(fn){return lease(async()=>{owned();const tx={store:api,repository:mutableRepository()};transactionContexts.add(tx);try{return await fn(tx,tx.repository.state);}finally{transactionContexts.delete(tx);}});}
  function transactionSync(fn){if(queues.has(file))throw fail('MONEY_CONTEXT_BUSY');owned();queues.set(file,Promise.resolve());const tx={store:api,repository:mutableRepository()};transactionContexts.add(tx);try{const result=fn(tx,tx.repository.state);if(result?.then)throw fail('ASYNC_BOOT_FORBIDDEN');return result;}finally{transactionContexts.delete(tx);queues.delete(file);}}
  async function maintenanceLease(fn){return lease(async()=>{owned();maintenance=true;try{return await fn({store:api});}finally{if(!opened)reopenAfterMaintenance();maintenance=false;}});}
  function closeForMaintenance(){if(!maintenance)throw fail('MONEY_MAINTENANCE_REQUIRED');owned();if(opened.db.inTransaction)throw fail('MONEY_SQL_TRANSACTION_ACTIVE');maintenanceIdentity={inode:opened.inode,dev:opened.dev};opened.db.close();opened=null;}
  function reopenAfterMaintenance(){if(!maintenance)throw fail('MONEY_MAINTENANCE_REQUIRED');if(opened)throw fail('MONEY_DATABASE_ALREADY_OPEN');writer.assertOwned();try{const st=fsImpl.lstatSync(file);if(!maintenanceIdentity||st.isSymbolicLink()||st.ino!==maintenanceIdentity.inode||st.dev!==maintenanceIdentity.dev)throw fail('MONEY_DATABASE_INODE_CHANGED');opened=database.openDatabase(file,descriptor);if(atomicRouter){atomicRouter=null;workspaceManager=null;initializeAtomicCapacityRuntime();}}catch(error){uncertain=true;throw error;}}
  function validateDatabase({full=false}={}){owned();return database.validateDatabaseHandle(opened.db,epoch,{full});}
  function validationReader(){owned();return database.createValidationReader(opened.db,epoch);}
  function one(name,id,options={}){const row=repository().get(name,id);if(row&&options.accountId&&(row.accountId||row.owner)!==options.accountId)return undefined;return row&&structuredClone(row);}
  function page(name,options={}){const limit=options.limit??100;if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw fail('MONEY_PAGE_INVALID');return rowPage(repository().rows(name,{owner:options.accountId,sourceId:options.sourceId,operationId:options.operationId,state:options.state,nonterminal:options.nonterminal,after:options.after,limit:limit+1}),limit);}
  function first(name,filters,predicate=()=>true){return repository().rows(name,filters).find(predicate);}
  function findSourceByProviderIdentity({platform_account_id,livemode,chargeId,paymentIntentId}){owned();if(!chargeId&&!paymentIntentId)return undefined;const col=chargeId?'provider_id':"json_extract(payload,'$.payment_intent_id')";const row=opened.db.prepare('SELECT id FROM sources WHERE provider_account=? AND livemode=? AND '+col+'=? LIMIT 1').get(platform_account_id,Number(livemode),chargeId||paymentIntentId);return row?one('sources',row.id):undefined;}

  function hasPendingSourceRefund({sourceId}={}){owned();if(typeof sourceId!=='string'||!sourceId)throw fail('SOURCE_ID_REQUIRED');return !!opened.db.prepare("SELECT 1 FROM exceptions INDEXED BY exceptions_source WHERE source_id=? AND json_extract(payload,'$.kind')='SOURCE_REFUND_PENDING' AND (state IS NULL OR state!='resolved') LIMIT 1").get(sourceId);}
  function readLiquidityBasis(){const m=readMetadata(),latest=opened.db.prepare('SELECT id FROM liquidity_evidence INDEXED BY liquidity_evidence_sequence_id ORDER BY sequence DESC,id DESC LIMIT 1').get();return{revision:m.revision,localLiabilityMicros:m.totals.localLiabilityMicros,exposureMicros:m.totals.exposureMicros,latestLiquidityRevision:latest?one('liquidity_evidence',latest.id).revision:-1};}
  function verifyCapacityEffect(record){owned();if(!record?.effect||!Number.isSafeInteger(record.consumedRevision))return false;const row=opened.db.prepare('SELECT payload FROM audit_events WHERE revision=?').get(record.consumedRevision);if(!row)return false;const event=JSON.parse(row.payload),bound=event.capacity?.find(x=>x.id===record.id&&x.state==='consumed');if(!bound||bound.requestDigest!==record.requestDigest||digest(bound.effect)!==digest(record.effect))return false;const proof=record.effect;if(proof.collection==='write_set')return event.writeSetDigest===proof.digest;if(proof.collection==='evidence'){const item=event.evidence?.find(x=>x.namespace===proof.namespace&&x.id===proof.id);return !!item&&digest(item.payload)===proof.digest;}const item=event.changes?.find(x=>x.collection===proof.collection&&x.id===proof.id);return !!item&&digest(item.after)===proof.digest;}
  function getCapacityRecord(id){owned();const row=opened.db.prepare('SELECT payload FROM capacity_reservations WHERE id=?').get(id);return row?JSON.parse(row.payload):undefined;}
  function rebindCapacityPhysical(expectedDigest,physical){if(!maintenance)throw fail('MONEY_MAINTENANCE_REQUIRED');owned();const prior=getCapacityRecord('capacity:root');if(prior?.profile?.grouped?.commitProtocol==='single_sql_v1')throw fail('ATOMIC_RESTORE_NOT_IMPLEMENTED');if(!prior||prior.activeAllowance||prior.state!=='ready'||digest(prior)!==expectedDigest)throw fail('CAPACITY_REBIND_CONFLICT');const names={completion:'money-completion-reserve.bin',publication:'money-publication-reserve.bin',publicationControl:'money-capacity-publication-control.bin'};for(const[k,name]of Object.entries(names)){const st=fsImpl.lstatSync(path.join(epoch.financial_dir,name)),v=physical[k],bytes=k==='completion'?prior.availableBytes:k==='publication'?prior.profile.publicationBytes:8192;if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size!==bytes||st.blocks*512<bytes||st.ino!==v?.ino||st.dev!==v?.dev)throw fail('CAPACITY_PHYSICAL_MISMATCH');}const next={...prior,...structuredClone(physical),restoreGeneration:(prior.restoreGeneration||0)+1};opened.db.transaction(()=>{const current=database.readMetadata(opened.db);opened.db.prepare('UPDATE capacity_reservations SET payload=? WHERE id=?').run(JSON.stringify(next),'capacity:root');const meta={...current,revision:current.revision+1,sequence:current.sequence+1};database.writeMetadata(opened.db,meta);opened.db.prepare('INSERT INTO audit_events(revision,sequence,payload) VALUES(?,?,?)').run(meta.revision,meta.sequence,JSON.stringify({changes:[],evidence:[],capacity:[next],purpose:'capacity_restore_rebind',prior_digest:expectedDigest}));}).immediate();return next;}
  function installCapacityGenesis(record,additional=[]){if(!maintenance)throw fail('MONEY_MAINTENANCE_REQUIRED');owned();if(getCapacityRecord('capacity:root'))throw fail('CAPACITY_ALREADY_INITIALIZED');opened.db.transaction(()=>{opened.db.prepare('INSERT INTO capacity_reservations(id,payload,state) VALUES(?,?,?)').run(record.id,JSON.stringify(record),record.state);for(const row of additional)opened.db.prepare('INSERT INTO capacity_reservations(id,payload,state) VALUES(?,?,?)').run(row.id,JSON.stringify(row),row.state);}).immediate();}
  function financialSeal(s) {
    return digest(Object.fromEntries(MAPS.filter(k => k !== 'lifecycle').map(k =>[k, s[k]])));
  }
  function planCompaction( {
    next, approval
  }) {
    const prior = read();
    if (!approval?.evidence_ref || approval.authorized !== true) throw fail('COMPACTION_CONSERVATION_REQUIRED');
    const closure = approval.compaction;
    if (!closure) {
      validateSnapshot(next, epoch);
      if (financialSeal(prior) !== financialSeal(next)) throw fail('COMPACTION_CONSERVATION_REQUIRED');
      return {
        schema: 1, revision: prior.revision, prior_digest: digest(prior), next_digest: digest(next), approval: structuredClone(approval),
        next: structuredClone(next)
      };
    }
    if (closure.prior_digest !== digest(prior)) throw fail('COMPACTION_PRIOR_AUTHORITY_REQUIRED');
    const ids = new Set(closure.source_ids ||[]), removed = Object.fromEntries(MAPS.map(k =>[k, new Set()]));
    const seal = closure.seal;
    if (ids.size < 5 || seal?.namespace !== epoch.platform + ':' + (epoch.livemode ? 'live' : 'test') || !seal.evidence_ref || seal.provider_reconciled !== true || !Number.isFinite(Date.parse(seal.source_created_through)) || !Number.isSafeInteger(seal.closed_epoch) || seal.closed_epoch < 1 || !closure.rule_version) throw fail('COMPACTION_CLOSURE_AUTHORITY_REQUIRED');
    const totals = {
      source_amount_micros: 0, spent_micros: 0, retired_micros: 0, cost_micros: 0, cost_covered_micros: 0, cost_recovered_micros: 0,
      platform_share_micros: 0, reversed_micros: 0, recovered_micros: 0, backing_micros: 0, obligation_micros: 0, subsidy_micros: 0
    };
    function add(k, v) {
      totals[k] = sum([totals[k], v]);
    }
    for (const id of ids) {
      const x = prior.sources[id];
      if (!x || x.amountMicros !== sum([x.spentMicros, x.retiredMicros]) || x.originalClaim || x.frozen || !Number.isFinite(Date.parse(x.canonical_created_at)) || Date.parse(x.canonical_created_at) > Date.parse(seal.source_created_through)) throw fail('COMPACTION_LIVE_SOURCE');
      removed.sources.add(id);
      add('source_amount_micros', x.amountMicros);
      add('spent_micros', x.spentMicros);
      add('retired_micros', x.retiredMicros);
    }
    for (const [id, o] of Object.entries(prior.operations)) if (ids.has(o.sourceId)) {
      if (!['settled', 'failed', 'canceled', 'requote_required'].includes(o.state) || o.state === 'settled' && (!o.cashEffectId || closure.reflected_effect_ids?.includes(o.cashEffectId) !== true)) throw fail('COMPACTION_PENDING_OPERATION');
      if ((o.failedCostMicros || 0) > (o.failedCostReversedMicros || 0) || (o.failedCostExposureMicros || 0) || (o.cashReservedMicros || 0)) throw fail('COMPACTION_OPERATION_CASH_DEPENDENCY');
      removed.operations.add(id);
    }
    for (const [id, c] of Object.entries(prior.costs)) if (ids.has(c.sourceId)) {
      if (c.reservedMicros || c.amountMicros !== sum([c.coveredMicros, c.recoveredMicros])) throw fail('COMPACTION_UNSETTLED_COST');
      removed.costs.add(id);
      add('cost_micros', c.amountMicros);
      add('cost_covered_micros', c.coveredMicros);
      add('cost_recovered_micros', c.recoveredMicros);
    }
    for (const [id, pool] of Object.entries(prior.pools)) {
      const selected = pool.fragments.filter(f => ids.has(f.sourceId));
      if (!selected.length) continue;
      if (selected.length !== pool.fragments.length || (pool.contributorShareMicros || 0) > (pool.contributorReversedMicros || 0) || pool.availableMicros || pool.waitingMicros || pool.exposureMicros) throw fail('COMPACTION_POOL_BOUNDARY');
      removed.pools.add(id);
      add('platform_share_micros', pool.platformShareMicros);
      add('reversed_micros', pool.reversedMicros);
      add('recovered_micros', pool.recoveredMicros);
      add('backing_micros', pool.platformShareMicros - pool.reversedMicros + pool.recoveredMicros);
      const allocations = Object.values(prior.allocations).filter(a => a.poolId === id && a.state !== 'canceled');
      add('obligation_micros', sum([pool.coveredMicros, ... allocations.map(a => a.amountMicros)]));
      add('subsidy_micros', sum(allocations.map(a => a.amountMicros)));
    }
    for (const [id, a] of Object.entries(prior.allocations)) {
      if (!removed.operations.has(a.operationId) && !removed.pools.has(a.poolId)) continue;
      if (!removed.operations.has(a.operationId) || !removed.pools.has(a.poolId) || a.state === 'reserved') throw fail('COMPACTION_ALLOCATION_BOUNDARY');
      removed.allocations.add(id);
    }
    for (const [id, q] of Object.entries(prior.quotes)) if (ids.has(q.sourceId)) removed.quotes.add(id);
    for (const [id, v] of Object.entries(prior.projections)) if (removed.operations.has(v.operationId) || ids.has(v.sourceId)) {
      if (!removed.operations.has(v.operationId) || !ids.has(v.sourceId) || (v.state !== 'acknowledged' && !(v.state === 'superseded' && prior.projections[v.supersededBy]?.state === 'acknowledged' && prior.projections[v.supersededBy]?.operationId === v.operationId && prior.projections[v.supersededBy]?.sourceId === v.sourceId))) throw fail('COMPACTION_PROJECTION_BOUNDARY');
      removed.projections.add(id);
    }
    for (const [id, v] of Object.entries(prior.spends)) {
      if (!v.draws.some(d => ids.has(d.sourceId))) continue;
      if (v.draws.some(d => !ids.has(d.sourceId)) || !['returned','realized'].includes(v.state)) throw fail('COMPACTION_SPEND_BOUNDARY');
      removed.spends.add(id);
    }
    for (const [id, v] of Object.entries(prior.provider_observations)) if (removed.operations.has(v.record?.operationId)) removed.provider_observations.add(id);
    for (const v of Object.values(prior.exceptions)) if (removed.operations.has(v.operationId) || ids.has(v.sourceId)) throw fail('COMPACTION_EXCEPTION_BOUNDARY');
    for (const [collection, set] of Object.entries(removed)) for (const id of set) {
      const d = closure.decisions?.[collection + '/' + id];
      if (!d || d.authorized !== true || d.expired !== true || d.dependency_free !== true || !d.evidence_ref || d.rule_version !== closure.rule_version || !Number.isFinite(Date.parse(d.nominal_expiry)) || Date.parse(d.nominal_expiry) > Date.now()) throw fail('COMPACTION_RETENTION_AUTHORITY_REQUIRED');
    }
    const participantSuccessors = closure.participant_retirement === true ? require('./money-lifecycle').planParticipantSuccessors({epoch,snapshot:prior,removed,closure}) : [];
    require('./money-lifecycle').assertCompactionParticipantClosure( {
      epoch, store:api, snapshot: prior, sourceIds: [... ids], removed, copyInventory: closure.copy_inventory, participantSuccessors
    });
    require('./money-lifecycle').validateAggregate( {
      count: ids.size, period: closure.period, currency: 'usd', totalMicros: totals.source_amount_micros
    }, closure.privacy_assessment);
    const successor = structuredClone(prior);
    for (const [collection, set] of Object.entries(removed)) for (const id of set) delete successor[collection][id];
    // This is a nonspendable successor summary, never a new money source.
    const epochKey = seal.namespace + ':' + seal.closed_epoch;
    successor.lifecycle.closed_epoch_totals = {
      ...(prior.lifecycle.closed_epoch_totals || {
      }), [epochKey]: {
        currency: 'usd', period: closure.period, count: ids.size, ... totals, nonspendable: true
      }
    };
    const publicSeal = {
      namespace: seal.namespace, source_created_through: seal.source_created_through, closed_epoch: seal.closed_epoch, aggregate_checkpoint_hash: digest(successor.lifecycle.closed_epoch_totals[epochKey]),
      rule_version: closure.rule_version
    };
    successor.lifecycle.source_seals = [...(prior.lifecycle.source_seals ||[]).filter(s => s.namespace !== seal.namespace),
    publicSeal];
    const oldSeal =(prior.lifecycle.source_seals ||[]).find(s => s.namespace === seal.namespace);
    if (oldSeal && (oldSeal.closed_epoch >= seal.closed_epoch || Date.parse(oldSeal.source_created_through) > Date.parse(seal.source_created_through))) throw fail('COMPACTION_SEAL_REGRESSION');
    successor.lifecycle.compaction_epoch =(prior.lifecycle.compaction_epoch || 0) + 1;
    validateSnapshot(successor, epoch);
    if (next && digest(next) !== digest(successor)) throw fail('COMPACTION_SUCCESSOR_CONFLICT');
    return {
      schema: 1, revision: prior.revision, prior_digest: digest(prior), next_digest: digest(successor), approval: structuredClone(approval),
      database_auxiliary:require('./money-lifecycle').planDatabaseSuccessor({epoch,prior,next:successor,auxiliary:exportDatabaseAuxiliary(),closure}),
      next: successor, participants: require('./money-lifecycle').sealParticipantSuccessors({epoch,participants:participantSuccessors,seal:publicSeal,totals:successor.lifecycle.closed_epoch_totals[epochKey]})
    };
  }
  function commitCompaction(ctx, plan, {
    executionApproval
  }
  = {
  }) {
    if (plan.participants?.length) throw fail('STOPPED_WRITER_SUCCESSOR_REQUIRED');
    const prior = read();
    if (plan.prior_digest !== digest(prior) || plan.next_digest !== digest(plan.next)) throw fail('COMPACTION_PLAN_CHANGED');
    if (plan.approval.compaction && (executionApproval?.authorized !== true || executionApproval.prior_digest !== plan.prior_digest || executionApproval.plan_digest !== digest(plan) || !executionApproval.execution_approval_ref)) throw fail('COMPACTION_EXECUTION_AUTHORITY_REQUIRED');
    if(plan.database_auxiliary?.retired_identifiers?.length)throw fail('STOPPED_WRITER_SUCCESSOR_REQUIRED');
    const verified = planCompaction( {
      next: plan.next, approval: plan.approval
    });
    if (verified.next_digest !== plan.next_digest) throw fail('COMPACTION_PLAN_CHANGED');
    const next = structuredClone(plan.next);
    next.revision = prior.revision + 1;
    return commitRevision(ctx, prior.revision, next);
  }
  function restoreMaintenance(){
    if(restoreAccess?.token!==RESTORE_ACCESS)throw fail('ATOMIC_RESTORE_MAINTENANCE_REQUIRED');
    if(!maintenance)throw fail('MONEY_MAINTENANCE_REQUIRED');owned();
    if(atomicRouter||workspaceManager)throw fail('ATOMIC_RESTORE_DEDICATED_STORE_REQUIRED');
  }
  function readAtomicCheckpointDigests(){if(!maintenance)throw fail('MONEY_MAINTENANCE_REQUIRED');owned();if(opened.db.inTransaction)throw fail('MONEY_SQL_TRANSACTION_ACTIVE');database.validateDatabaseHandle(opened.db,epoch,{full:true});const metadata=readMetadata(),root=getCapacityRecord('capacity:root');return{metadata,root,rootDigest:digest(root||null),...database.readAtomicRestoreDigests(opened.db),metrics:readWorkspaceMetrics()};}
  function readAtomicRestoreSnapshot(){
    restoreMaintenance();if(opened.db.inTransaction)throw fail('MONEY_SQL_TRANSACTION_ACTIVE');
    database.validateDatabaseHandle(opened.db,epoch,{full:true});
    const metadata=readMetadata(),root=getCapacityRecord('capacity:root');
    if(metadata.database_schema!==3||root?.profile.grouped?.commitProtocol!=='single_sql_v1'||root.profile.workspace?.schema!==2)throw fail('ATOMIC_RESTORE_PROFILE_REQUIRED');
    return{metadata,root,rootDigest:digest(root),...database.readAtomicRestoreDigests(opened.db),metrics:readWorkspaceMetrics()};
  }
  function restoreAuthority(authority,phase){
    restoreMaintenance();
    const result=require('./money-atomic-restore').inspectRestoreAuthority(authority,{store:restoreAccess.facade,epoch,writer,phase});
    const plan=result?.plan,core=require('./money-atomic-restore-core');
    if(!plan||plan.schema!==1||plan.protocol!=='atomic_restore_v1'||plan.databaseSchema!==3||plan.workspaceSchema!==2)throw fail('ATOMIC_RESTORE_PLAN_INVALID');
    const {planDigest,...body}=plan;
    if(!core.hex(planDigest)||digest(body)!==planDigest||['restoreId','checkpointDigest','barrierDigest','lifecycleDigest','profileDigest','priorRootDigest','previousBindingDigest','priorJointCompletionDigest','quoteControlDigest','leaseStateDigest','scanStateDigest','financialStateDigest','metadataIdentityDigest','rootEconomicDigest','allowanceDigest','rolePlanDigest'].some(k=>!core.hex(plan[k])))throw fail('ATOMIC_RESTORE_PLAN_INVALID');
    for(const key of ['priorRevision','priorSequence','priorRestoreGeneration','maxGrowthPages','maxNetOccupiedPages','retainedNonDatabaseOutputBytes'])if(!core.uint(plan[key]))throw fail('ATOMIC_RESTORE_PLAN_INVALID');
    if(plan.priorRevision===Number.MAX_SAFE_INTEGER||plan.priorSequence===Number.MAX_SAFE_INTEGER||plan.priorRestoreGeneration===Number.MAX_SAFE_INTEGER)throw fail('ATOMIC_RESTORE_PLAN_INVALID');
    core.encodeRestoreBytes(plan.allowanceBoundBytes);core.encodeRestoreBytes(plan.publicationBoundBytes);
    if(!plan.allowanceBoundBytes||!plan.publicationBoundBytes||!plan.roles)throw fail('ATOMIC_RESTORE_PLAN_INVALID');
    return result;
  }
  function restoreProjectionMatches(snapshot,plan){return snapshot.metadata.database_schema===3&&snapshot.root.profileDigest===plan.profileDigest&&snapshot.financialStateDigest===plan.financialStateDigest&&snapshot.metadataIdentityDigest===plan.metadataIdentityDigest&&snapshot.rootEconomicDigest===plan.rootEconomicDigest&&snapshot.quoteControlDigest===plan.quoteControlDigest&&snapshot.scanStateDigest===plan.scanStateDigest;}
  function restoreRoleProofs(plan,root){
    const names={completion:'money-completion-reserve.bin',publication:'money-publication-reserve.bin',publicationControl:'money-capacity-publication-control.bin'};
    for(const[key,name]of Object.entries(names)){
      const r=plan.roles[key],expected=key==='completion'?root.availableBytes:key==='publication'?root.profile.publicationBytes:8192;
      if(!r||r.relativePath!==name||r.bytes!==expected||r.mode!==0o600||r.uid!==process.getuid()||r.nlink!==1||!Number.isSafeInteger(r.allocatedBytes)||r.allocatedBytes<r.bytes)throw fail('ATOMIC_RESTORE_ROLE_INVALID');
      const pathname=path.join(epoch.financial_dir,name),fd=fsImpl.openSync(pathname,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try {const st=fsImpl.fstatSync(fd),named=fsImpl.lstatSync(pathname);if(!st.isFile()||st.nlink!==1||(st.mode&0o7777)!==0o600||st.uid!==r.uid||st.dev!==r.dev||st.ino!==r.ino||st.size!==r.bytes||st.blocks*512!==r.allocatedBytes||named.isSymbolicLink()||named.dev!==st.dev||named.ino!==st.ino)throw fail('ATOMIC_RESTORE_ROLE_INVALID');}finally{fsImpl.closeSync(fd);}
    }
  }
  function inspectAtomicRestoreCut(authority){
    const {plan}=restoreAuthority(authority,'inspect'),snapshot=readAtomicRestoreSnapshot();
    if(!restoreProjectionMatches(snapshot,plan)||snapshot.metadata.revision!==plan.priorRevision||snapshot.metadata.sequence!==plan.priorSequence||snapshot.rootDigest!==plan.priorRootDigest||(Object.hasOwn(snapshot.root,'restoreGeneration')?snapshot.root.restoreGeneration:0)!==plan.priorRestoreGeneration||digest(snapshot.root.restoreBinding||null)!==plan.previousBindingDigest)throw fail('ATOMIC_RESTORE_CUT_CONFLICT');
    const geometry=require('./money-atomic-restore-core').geometry(snapshot.root.profile.workspace,snapshot.metrics);
    if(digest(geometry)!==digest(plan.priorGeometry)||snapshot.metrics.pageCount!==plan.priorMetrics.pageCount||snapshot.metrics.freelistCount!==plan.priorMetrics.freelistCount||snapshot.metrics.workspaceAllocatedBytes!==plan.priorMetrics.workspaceAllocatedBytes)throw fail('ATOMIC_RESTORE_CUT_CONFLICT');
    return snapshot;
  }
  function verifyAtomicRestoreOutcome(authority){
    const {plan}=restoreAuthority(authority,'outcome'),snapshot=readAtomicRestoreSnapshot(),core=require('./money-atomic-restore-core');
    if(!restoreProjectionMatches(snapshot,plan))return{state:'conflict'};
    if(snapshot.metadata.revision===plan.priorRevision&&snapshot.metadata.sequence===plan.priorSequence&&snapshot.rootDigest===plan.priorRootDigest)return{state:'prior',revision:plan.priorRevision,rootDigest:snapshot.rootDigest,metrics:snapshot.metrics};
    const binding=snapshot.root.restoreBinding;
    try {core.validateRestoreBinding(binding);}catch{return{state:'conflict'};}
    if(snapshot.metadata.revision!==plan.priorRevision+1||snapshot.metadata.sequence!==plan.priorSequence+1||snapshot.root.restoreGeneration!==plan.priorRestoreGeneration+1||digest(binding)!==digest(core.bindingFor(plan,core.decodeRestoreBytes(binding.consumedBytes))))return{state:'conflict'};
    for(const key of ['completion','publication','publicationControl']){const r=plan.roles[key],expected={dev:r.dev,ino:r.ino,bytes:r.bytes,allocatedBytes:r.allocatedBytes};if(digest(snapshot.root[key])!==digest(expected))return{state:'conflict'};}
    const cost=core.requiredRestoreBytes(plan,snapshot.metrics,snapshot.root.profile.workspace);
    if(cost.requiredBytes!==core.decodeRestoreBytes(binding.consumedBytes)||cost.requiredBytes>plan.allowanceBoundBytes)return{state:'conflict'};
    return{state:'committed',revision:snapshot.metadata.revision,rootDigest:snapshot.rootDigest,restoreBinding:binding,...core.receiptFor(plan,snapshot.root),metrics:snapshot.metrics,...cost};
  }
  function commitAtomicRestoreBinding(authority){
    const released=restoreAuthority(authority,'released'),{plan}=released,prior=inspectAtomicRestoreCut(authority),core=require('./money-atomic-restore-core');
    restoreRoleProofs(plan,prior.root);
    const originalQuota=prior.root.profile.grouped.sqlite,quota={...originalQuota,maxGrowthPages:Math.min(originalQuota.maxGrowthPages,plan.maxGrowthPages),maxNetOccupiedPages:Math.min(originalQuota.maxNetOccupiedPages,plan.maxNetOccupiedPages)};
    const inspector=createRollbackInspector({tempDirectory:released.temporaryDirectory,quota}),native=inspector();
    if(native.proofKind!=='native-runtime-inspection'||native.rollbackProofDigest!==quota.rollbackProofDigest||released.physicalProof?.rollbackProofDigest!==native.rollbackProofDigest)throw fail('ATOMIC_RESTORE_NATIVE_PROOF_REQUIRED');
    const hit=phase=>testFault?.(phase);let finalRoot,firstGeometry;
    try {
      require('./money-sqlite-quota').runGuardedTransaction({db:opened.db,quota,physicalProof:released.physicalProof,workspaceProfile:prior.root.profile.workspace,precommit:metrics=>{
        restoreAuthority(authority,'precommit');restoreRoleProofs(plan,prior.root);
        const fresh=inspector({phase:'beforeCommit'});if(fresh.proofKind!=='native-runtime-inspection'||fresh.rollbackProofDigest!==native.rollbackProofDigest||fresh.schemaVersion!==native.schemaVersion)throw fail('ATOMIC_RESTORE_NATIVE_PROOF_REQUIRED');
        const cost=core.requiredRestoreBytes(plan,metrics,prior.root.profile.workspace);
        if(cost.requiredBytes!==core.decodeRestoreBytes(finalRoot.restoreBinding.consumedBytes)||cost.requiredBytes>plan.allowanceBoundBytes||digest(cost.geometry)!==firstGeometry)throw fail('ATOMIC_RESTORE_CONSERVATION_FAILED');
        const nowMeta=database.readMetadata(opened.db),nowRoot=JSON.parse(opened.db.prepare("SELECT payload FROM capacity_reservations WHERE id='capacity:root'").get().payload),digests=database.readAtomicRestoreDigests(opened.db);
        if(digest(nowRoot)!==digest(finalRoot)||nowMeta.revision!==plan.priorRevision+1||nowMeta.sequence!==plan.priorSequence+1||digests.financialStateDigest!==plan.financialStateDigest||digests.metadataIdentityDigest!==plan.metadataIdentityDigest||digests.rootEconomicDigest!==plan.rootEconomicDigest||digests.quoteControlDigest!==plan.quoteControlDigest||digests.scanStateDigest!==plan.scanStateDigest)throw fail('ATOMIC_RESTORE_CONSERVATION_FAILED');
        hit('restore-before-commit');return{verified:true};
      }},()=>{
        const m=database.readMetadata(opened.db),row=opened.db.prepare("SELECT payload FROM capacity_reservations WHERE id='capacity:root'").get(),current=JSON.parse(row.payload);
        if(m.revision!==plan.priorRevision||m.sequence!==plan.priorSequence||digest(current)!==plan.priorRootDigest)throw fail('ATOMIC_RESTORE_CAS_CONFLICT');
        finalRoot=core.rootSuccessor(current,plan,plan.allowanceBoundBytes);
        if(Buffer.byteLength(JSON.stringify(finalRoot))>current.profile.maxRowBytes)throw fail('ATOMIC_RESTORE_ROOT_SIZE_LIMIT');
        const update=opened.db.prepare("UPDATE capacity_reservations SET payload=? WHERE id='capacity:root' AND payload=?");
        if(database.safe(update.run(JSON.stringify(finalRoot),row.payload).changes)!==1)throw fail('ATOMIC_RESTORE_CAS_CONFLICT');hit('restore-after-root');
        database.writeMetadata(opened.db,{...m,revision:m.revision+1,sequence:m.sequence+1});hit('restore-after-metadata');
        const metrics=readWorkspaceMetrics(),cost=core.requiredRestoreBytes(plan,metrics,current.profile.workspace);
        if(cost.requiredBytes>plan.allowanceBoundBytes)throw fail('ATOMIC_RESTORE_ALLOWANCE_EXHAUSTED');
        firstGeometry=digest(cost.geometry);finalRoot.restoreBinding=core.bindingFor(plan,cost.requiredBytes);
        const changes=opened.db.prepare("UPDATE capacity_reservations SET payload=? WHERE id='capacity:root'").run(JSON.stringify(finalRoot));if(database.safe(changes.changes)!==1)throw fail('ATOMIC_RESTORE_CAS_CONFLICT');hit('restore-after-debit');
      });
      hit('restore-after-commit');
    } catch(error){
      if(error.code==='SQLITE_FULL'||error.code==='CAPACITY_SQLITE_PAGE_LIMIT'||error.code==='CAPACITY_SQLITE_NET_PAGE_LIMIT'){
        const outcome=verifyAtomicRestoreOutcome(authority);if(outcome.state==='prior')throw Object.assign(fail('RESTORE_SQL_HEADROOM_REQUIRED'),{cause:error});
      }
      throw error;
    }
    const result=verifyAtomicRestoreOutcome(authority);if(result.state!=='committed')throw fail('ATOMIC_RESTORE_OUTCOME_CONFLICT');return result;
  }
  function assertProviderScanMembershipCoverage({leases}={}){
    if(!maintenance)throw fail('MONEY_MAINTENANCE_REQUIRED');owned();
    if(opened.db.inTransaction)throw fail('MONEY_SQL_TRANSACTION_ACTIVE');
    if(!Array.isArray(leases)||leases.length>64)throw fail('RESTORE_SCAN_LEASE_INVALID');
    const allowed=new Set();
    for(const row of leases){if(!row||typeof row.scopeKey!=='string'||!row.scopeKey||!Number.isSafeInteger(row.generation)||row.generation<1)throw fail('RESTORE_SCAN_LEASE_INVALID');const key=JSON.stringify([row.scopeKey,row.generation]);if(allowed.has(key))throw fail('RESTORE_SCAN_LEASE_INVALID');allowed.add(key);}
    for(const row of opened.db.prepare('SELECT scope,generation FROM provider_scan_members ORDER BY scope,generation,provider_id').iterate())if(!allowed.has(JSON.stringify([row.scope,database.safe(row.generation)])))throw fail('RESTORE_SCAN_LEASE_REQUIRED');
    return true;
  }
  function listProviderScans({after,limit=100}={}){owned();if(!Number.isSafeInteger(limit)||limit<1||limit>1000||after!==undefined&&typeof after!=='string')throw fail('MONEY_PAGE_INVALID');const rows=opened.db.prepare('SELECT scope,generation,payload,revision FROM provider_scan_controls WHERE scope>? ORDER BY scope LIMIT ?').all(after||'',limit+1),items=rows.slice(0,limit).map(row=>({scopeKey:row.scope,generation:database.safe(row.generation),control:JSON.parse(row.payload),revision:database.safe(row.revision)}));return{items,nextCursor:rows.length>limit?items.at(-1).scopeKey:null};}
  function close(){if((queues.has(file)&&inspectionToken!==INSPECTION)||maintenance)throw fail('MONEY_CONTEXT_BUSY');if(opened){owned();if(opened.db.inTransaction)throw fail('MONEY_SQL_TRANSACTION_ACTIVE');opened.db.close();opened=null;}}
  function exportDatabaseAuxiliary(){owned();return database.exportDatabaseAuxiliary(opened.db);}
  const api = {readAtomicCheckpointDigests,readAtomicRestoreSnapshot,inspectAtomicRestoreCut,commitAtomicRestoreBinding,verifyAtomicRestoreOutcome,listProviderScans,assertProviderScanMembershipCoverage,bindFailureInspection,failureControlProof,getOperationalControl,verifyOperationalQuoteAuthority,hasPendingSourceRefund,initializeAtomicCapacityRuntime,atomicCapacityStatus,installAtomicRouter,getAtomicCapacityPeer,verifyAtomicWorkspaceTransition,createRollbackInspector,workspaceLease,workspaceStatus,assertWorkspaceOwner,getWorkspaceWrite,readWorkspaceMetrics,installWorkspaceManager,verifyWorkspaceWrite,withCapacityView,rebindCapacityPhysical,verifyCapacityEffect,getCapacityRecord,installCapacityGenesis,validationReader,close,exportDatabaseAuxiliary,read,exportSnapshot,readMetadata,commitRevision,transaction,transactionSync,maintenanceLease,closeForMaintenance,reopenAfterMaintenance,validateDatabase,planCompaction,commitCompaction,file,descriptorFile,descriptor,epoch,
    getPool:id=>one('pools',id),getProviderObservation:id=>one('provider_observations',id),getSource:(id,o)=>one('sources',id,o),getOperation:(id,o)=>one('operations',id,o),getProjection:id=>one('projections',id),getSpend:id=>one('spends',id),getQuote:(id,o)=>one('quotes',id,o),
    getSourceByLot:(accountId,lotId)=>first('sources',{owner:accountId,lotId}),findSourceByProviderIdentity,
    findOperationByRequestKey:(accountId,key)=>first('operations',{owner:accountId,requestKey:key}),
    findOperationByRefund:({platform_account_id,livemode,refundId})=>first('operations',{platform_account_id,livemode,providerId:refundId}),
    listOutstandingCashEffects:o=>repository().listOutstandingCashEffects(o),listProviderObservations:o=>page('provider_observations',o),listSources:o=>page('sources',o),listOperations:o=>page('operations',o),listSpends:o=>page('spends',o),listProjections:o=>page('projections',o),
    listPendingOperations:o=>page('operations',{...o,nonterminal:true}),listPendingProjections:o=>page('projections',{...o,state:'pending'}),
    getAppliedEffect:({participant,owner,id})=>repository().getEvidence('applied_effects',appliedEffectId({epoch,participant,owner,id}))?.payload,getLifecycle:id=>one('lifecycle',id),sourceReturnBalances:(id)=>{const r=repository(),x=r.get('sources',id);if(!x)return undefined;const held=sum([...r.sourceSpends(id).filter(v=>v.state==='prepared').flatMap(v=>v.draws.filter(d=>d.sourceId===id).map(d=>d.amountMicros)),...r.rows('operations',{sourceId:id,nonterminal:true}).filter(o=>!o.principalRetired).map(o=>o.D)]);return{heldMicros:held,availableMicros:x.amountMicros-x.spentMicros-x.retiredMicros-held};},readLiquidityBasis,getEvidence:(n,id)=>repository().getEvidence(n,id),listEvidence:o=>repository().listEvidence(o),getProviderScan:scope=>repository().getProviderScan(scope),getProviderCurrentFact:(scope,id)=>repository().getProviderCurrentFact(scope,id),listProviderCurrentFacts:o=>repository().listProviderCurrentFacts(o),getProviderScanMember:(scope,generation,id)=>repository().getProviderScanMember(scope,generation,id),listProviderScanMembers:o=>repository().listProviderScanMembers(o),
    get uncertain(){return uncertain;},markUncertain(){uncertain=true;}
  };
  return api;
}
function openAtomicRestoreStore({epoch,writer,testFault}={}){
  const facade={};
  const internal=openMoneyStore({epoch,writer,testFault,restoreAccess:{token:RESTORE_ACCESS,facade}});
  for(const name of ['readAtomicRestoreSnapshot','inspectAtomicRestoreCut','commitAtomicRestoreBinding','verifyAtomicRestoreOutcome','readMetadata','getCapacityRecord','getOperationalControl','readWorkspaceMetrics','getProviderScan','listProviderScans','assertProviderScanMembershipCoverage','listProviderScanMembers','getProviderCurrentFact','getEvidence','assertWorkspaceOwner','createRollbackInspector','close'])facade[name]=internal[name];
  facade.maintenanceLease=fn=>internal.maintenanceLease(()=>fn({store:facade}));
  facade.epoch=epoch;facade.descriptor=Object.freeze(structuredClone(internal.descriptor));facade.file=internal.file;
  return Object.freeze(facade);
}
module.exports = {
  initialSnapshot, appliedEffectId, openMoneyStore, openAtomicRestoreStore, validateRecords, validateSnapshot, canonical, digest, integer, sum, fail
};
