'use strict';
// Single final SQL protocol. Physical recovery never creates SQL abort records.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {digestJSON:hash}=require('./stripe-transfer-persistence');
const {fail,safe}=require('./money-database');
const cap=require('./money-capacity'),shared=require('./money-shared-liability'),workspaceFiles=require('./money-workspace');
const branded=new WeakSet(),provedRefusals=new WeakSet(),refusedDrafts=new WeakMap();
function isProvedUncommittedRefusal(error){return !!error&&provedRefusals.has(error);}
const PROTOCOL='single_sql_v1';
function isAtomicRouter(value){return !!value&&branded.has(value);}
function createAtomicCapacityRouter({epoch,writer,store,workspaceManager,testFault}={}){
 require('./money-writer-lock').assertMoneyWriter(writer,{root:epoch?.legacy_root});
 if(testFault&&!process.env.NODE_TEST_CONTEXT)throw fail('TEST_FAULT_FORBIDDEN');
 const hit=phase=>{if(testFault)testFault(phase);};
 const owned=()=>{writer.assertOwned();if(!store||!workspaceManager)throw fail('ATOMIC_WORKSPACE_REQUIRED');};
 const current=()=>{owned();const root=store.getCapacityRecord('capacity:root');if(!root||root.profile.grouped?.commitProtocol!==PROTOCOL)throw fail('ATOMIC_PROFILE_REQUIRED');cap.atomicProfile(root.profile);return root;};
 const holdId=(type,id)=>'shared-hold:'+cap.sharedIdentity(epoch,type,id).obligationId;
 function peer(){const root=current(),c=cap.atomicIO.readControl(epoch,root);return{state:c.state,protocol:c.protocol,groupId:c.groupId,capacityIntentChecksum:hash(c),workspaceIntentCoreDigest:c.workspaceIntentCoreDigest,priorWorkspaceSequence:c.priorWorkspaceSequence,priorWorkspaceControlDigest:c.priorWorkspaceControlDigest,lastCompleted:c.lastCompleted};}
 // Fresh read-only cut for the staging refusal proof: committed metadata, capacity and shared roots, SQL page
 // geometry, both controls (decoded and raw bytes) and every reserve inode. Never recovers or writes.
 function stagingCut(){const root=current(),files={};for(const name of [cap.RESERVE_FILE,cap.PUBLICATION_FILE,cap.CONTROL_FILE,workspaceFiles.PADDING,workspaceFiles.SCRATCH,workspaceFiles.CONTROL]){const file=path.join(epoch.financial_dir,name),st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink())throw fail('CAPACITY_PHYSICAL_MISMATCH');files[name]={dev:st.dev,ino:st.ino,nlink:st.nlink,size:st.size,blocks:st.blocks,...(name===cap.CONTROL_FILE||name===workspaceFiles.CONTROL?{sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}:{})};}
  return hash({metadata:store.readMetadata(),root,sharedRoot:store.getCapacityRecord('shared-root')||null,sqlGeometry:store.readWorkspaceMetrics(),capacityControl:cap.atomicIO.readControl(epoch,root),workspacePeer:workspaceManager.inspectAtomicPeer(),files});}
 function unchangedSince(baseline){try{if(baseline!==stagingCut())return false;const root=current();cap.verifyCapacityReserve({epoch,writer,store,profile:root.profile});workspaceManager.status();return baseline===stagingCut();}catch{return false;}}
 function resizeCompletion(root,target,min,max){const file=path.join(epoch.financial_dir,cap.RESERVE_FILE),st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.dev!==root.completion.dev||st.ino!==root.completion.ino||st.size<min||st.size>max)throw fail('CAPACITY_PHYSICAL_MISMATCH');const fd=fs.openSync(file,'r+');try{if(st.size>target)fs.ftruncateSync(fd,target);else{const b=Buffer.alloc(Math.min(target||1,1048576));for(let at=st.size;at<target;){const n=fs.writeSync(fd,b,0,Math.min(b.length,target-at),at);if(!n)throw fail('CAPACITY_SHORT_ALLOCATION');at+=n;hit('atomic-refill-write');}}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}cap.atomicIO.fileProof(file,target,root.completion);}
 function verify(intent,disposition){intent=intent.workspaceIntentCore||intent;const root=current(),m=store.readMetadata(),receipt=store.getCapacityRecord('allowance:'+intent.groupId);const op=intent.operational,control=op?store.getOperationalControl('quotes'):null,last=control?.payload?.lastWrite;
  if(disposition==='abort')return m.revision===intent.priorRevision&&hash(root)===intent.priorRootDigest&&!receipt&&(!op||control?.generation===op.generation-1&&last?.core?.groupId!==intent.groupId);
  const operationalMatch=!op||control?.generation===op.generation&&control.revision===intent.finalRevision&&last?.writeSetDigest===intent.fullWriteSetDigest&&hash(last.core)===hash(intent);
  if(!operationalMatch)return false;
  if(op&&intent.transient===true)return m.revision===intent.finalRevision&&hash(root)===intent.nextRootDigest&&intent.priorRootDigest===intent.nextRootDigest;
  if(intent.transient===true){const scan=store.getProviderScan(intent.workspace?.scopeKey),last=scan?.control?.lastWrite;return m.revision===intent.finalRevision&&scan?.generation===intent.workspace?.generation&&hash(root)===intent.nextRootDigest&&last?.core?.groupId===intent.groupId&&last.core.groupPlanDigest===intent.groupPlanDigest&&last.core.fullWriteSetDigest===intent.fullWriteSetDigest&&last.writeSetDigest===intent.fullWriteSetDigest&&last.core.priorRootDigest===intent.priorRootDigest;}
  return m.revision===intent.finalRevision&&hash(root)===intent.nextRootDigest&&receipt?.state==='consumed'&&receipt.groupPlanDigest===intent.groupPlanDigest&&receipt.semanticIntentDigest===intent.semanticIntentDigest&&receipt.effect?.digest===intent.fullWriteSetDigest&&receipt.priorRootDigest===intent.priorRootDigest&&receipt.nextRootDigest===intent.nextRootDigest&&store.verifyCapacityEffect(receipt)===true;
 }
 function recover(){const root=current(),control=cap.atomicIO.readControl(epoch,root);if(control.state==='idle'){cap.verifyCapacityReserve({epoch,writer,store,profile:root.profile});return{state:'ready'};}if(control.protocol!==PROTOCOL)throw fail('ATOMIC_RECOVERY_PROTOCOL');
  const disposition=verify(control,'abort')?'abort':verify(control,'committed')?'committed':null;if(!disposition)throw fail('ATOMIC_RECOVERY_CONFLICT');
  const result=workspaceManager.recoverAtomic({authority:authorityFor(control.workspaceIntentCore,root,hash(control)),groupId:control.groupId,capacityIntentChecksum:hash(control),disposition,committedRevision:disposition==='committed'?control.finalRevision:control.priorRevision,writeSetDigest:disposition==='committed'?control.fullWriteSetDigest:null});
  if(!result?.verified||!result.completion)throw fail('ATOMIC_WORKSPACE_RECOVERY_REQUIRED');
  const target=disposition==='abort'?control.beforeBytes:control.afterBytes;
  resizeCompletion(root,target,control.afterBytes,control.beforeBytes);cap.atomicIO.resizePublication(epoch,root,root.profile.publicationBytes,{resumeBound:true});
  cap.atomicIO.writeControl(epoch,root,{state:'idle',protocol:PROTOCOL,generation:control.generation+1,preparedGeneration:root.publicationGeneration,allowanceId:null,lastCompleted:result.completion});hit('atomic-idle');return{state:'ready',disposition};
 }
 function buildPlan(r,root){
  const description=r.describeWritePlan(),data=r.atomicChanges(),q=root.profile.grouped.sqlite;
  const ownerPages=new Map(),common=new Set(),overhead=[];if(data.capacities.some(row=>(row.id.startsWith('funding:')||row.id.startsWith('spend:'))&&!store.getCapacityRecord(row.id)))common.add(holdId('admission','global'));
  const add=(id,pages)=>ownerPages.set(id,(ownerPages.get(id)||0n)+pages);
  const fundingCommon=id=>holdId('funding',id.slice('funding:'.length));
  function selected(input){if(!input||input.mandatory!==true)throw fail('ATOMIC_SHARED_OWNER_REQUIRED');let intentId=input.checkoutIntentId;if(input.operationId){const o=r.get('operations',input.operationId);if(!o||input.sourceId&&input.sourceId!==o.sourceId)throw fail('ATOMIC_SHARED_OWNER_REQUIRED');input={...input,sourceId:o.sourceId};}if(input.sourceId){const s=r.get('sources',input.sourceId);if(!s)throw fail('ATOMIC_SHARED_OWNER_REQUIRED');intentId=s.provenance?.intent_id;}if(!intentId)throw fail('ATOMIC_SHARED_OWNER_REQUIRED');return holdId('funding',intentId);}
  for(const unit of description.units){const pages=BigInt(unit.oldRows+unit.newRows+unit.indexEntries)*BigInt(q.maxPagesPerMutation);let owner=unit.owner;if(owner==='@workspace'||owner==='@quote_workspace')continue;
   if(owner==='@shared'){
    const evidence=data.evidence.find(e=>unit.key==='evidence:'+e.namespace+':'+e.id);
    if(evidence){owner=selected(r.evidenceCapacity(evidence.namespace,evidence.id));}
    else if(unit.key.startsWith('liquidity_evidence:')){const c=data.changes.find(c=>unit.key===c.name+':'+c.id);owner=selected(c?.value?.capacity);}
    else if(unit.key.startsWith('scan:')){const entry=data.scans.find(([scope])=>unit.key.startsWith('scan:'+scope+':'));owner=selected(entry?.[1]?.capacity);}
    else{overhead.push(pages);continue;}
   }
   if(owner==='@admission')owner=holdId('admission','global');
   if(owner==='@optional'){add(owner,pages);common.add(owner);continue;}
   if(owner.startsWith('funding:'))common.add(fundingCommon(owner));else if(owner.startsWith('shared-hold:'))common.add(owner);
   else if(owner.startsWith('[')){const [id]=JSON.parse(owner);common.add(holdId('spend',id.slice('spend:'.length)));}
   else throw fail('ATOMIC_OWNER_UNSUPPORTED');
   add(owner,pages);
  }
  if(!common.size)throw fail('ATOMIC_SHARED_OWNER_REQUIRED');
  const overheadPages=overhead.reduce((a,b)=>a+b,0n),each=(overheadPages+BigInt(common.size)-1n)/BigInt(common.size);
  for(const id of [...common].sort())if(each)add(id,each);
  const shares=[...ownerPages].filter(([,pages])=>pages>0n).sort(([a],[b])=>a.localeCompare(b)).map(([id,pages])=>{const fragment=id.startsWith('[')?JSON.parse(id):null;return{reservationId:fragment?fragment[0]:id,fragmentSourceId:fragment?fragment[1]:null,bytes:safe(pages*4096n)};});
  if(shares.length>root.profile.grouped.maxGroupOwners)throw fail('CAPACITY_GROUP_OWNER_LIMIT');
  return shares;
 }
 function stage(r,prior,control){
  const semanticIntentDigest=r.semanticIntentDigest(),placeholder='allowance:atomic-envelope';
  // Final envelope has one root, one receipt, selected owner rows and one audit.
  r.setCapacity({...r.getCapacity('capacity:root')});r.setCapacity({id:placeholder,state:'consumed',effect:{collection:'write_set'},shares:[]});
  let shares=buildPlan(r,prior);
  for(const share of shares){const row=r.getCapacity(share.reservationId==='@optional'?'capacity:root':share.reservationId);if(!row)throw fail('ATOMIC_OWNER_REQUIRED');r.setCapacity(row);if(share.reservationId.startsWith('shared-hold:'))r.setCapacity(r.getCapacity('shared-root'));}
  shares=buildPlan(r,prior);r.dropCapacityDraft(placeholder);
  const total=safe(shares.reduce((n,x)=>n+BigInt(x.bytes),0n));let root=r.getCapacity('capacity:root'),ledgerRow=r.getCapacity('shared-root');
  for(const share of shares){if(share.reservationId==='@optional'){if(root.optionalRemainingBytes<share.bytes)throw fail('CAPACITY_OPTIONAL_EXHAUSTED');root.optionalRemainingBytes-=share.bytes;continue;}
   const committed=store.getCapacityRecord(share.reservationId);if(!committed)throw fail('ATOMIC_COMMITTED_OWNER_REQUIRED');
   if(share.reservationId.startsWith('shared-hold:')){const result=shared.consumeSharedLiability(ledgerRow.ledger,r.getCapacity(committed.id),{obligationId:committed.obligationId,bytes:share.bytes});ledgerRow={...ledgerRow,ledger:result.root};r.setCapacity(result.hold);root.sharedRemainingBytes=ledgerRow.ledger.capacityBytes-ledgerRow.ledger.consumedBytes;}
   else{const row=r.getCapacity(committed.id);if(share.fragmentSourceId){const f=row.fragments?.find(x=>x.sourceId===share.fragmentSourceId);if(!f||f.remainingBytes<share.bytes)throw fail('CAPACITY_PROTECTED_ALLOWANCE_EXHAUSTED');f.remainingBytes-=share.bytes;}if(row.remainingBytes<share.bytes)throw fail('CAPACITY_PROTECTED_ALLOWANCE_EXHAUSTED');row.remainingBytes-=share.bytes;r.setCapacity(row);}
  }
  if(ledgerRow)r.setCapacity(ledgerRow);root.availableBytes-=total;if(root.availableBytes<0)throw fail('CAPACITY_PHYSICAL_MISMATCH');root.generation++;root.publicationGeneration=control.generation+1;r.setCapacity(root);
  const groupPlanDigest=hash({semanticIntentDigest,shares,priorRootDigest:hash(prior),profileDigest:prior.profileDigest}),groupId=hash({epoch:epoch.binding_digest,priorRevision:r.state.revision,groupPlanDigest});
  const receipt={id:'allowance:'+groupId,state:'consumed',protocol:PROTOCOL,semanticIntentDigest,groupPlanDigest,shares,bytes:total,beforeBytes:prior.availableBytes,afterBytes:root.availableBytes,priorRootDigest:hash(prior),nextRootDigest:hash(root),requestDigest:groupPlanDigest,predecessorGeneration:prior.generation,consumedRevision:r.state.revision+1,effect:{collection:'write_set'}};
  r.setCapacity(receipt);receipt.effect.digest=r.writeSetDigest();r.setCapacity(receipt);
  return{receipt,root,groupId,semanticIntentDigest,groupPlanDigest,fullWriteSetDigest:receipt.effect.digest,total};
 }
 function authorityFor(core,root,checksum){const bytes=core.completionBeforeBytes-core.completionAfterBytes,w=core.workspace||core.operational;return{id:core.groupId,kind:w?(core.transient?'workspace':'mixed'):'permanent',boundBytes:bytes+(w?.boundBytes||0),permanentBoundBytes:bytes,workspaceBoundBytes:w?.boundBytes||0,...(core.operational?{operational:core.operational}:w?{scopeKey:w.scopeKey,generation:w.generation}:{}),ownerPlanDigest:core.groupPlanDigest,priorRevision:core.priorRevision,sqliteQuota:root.profile.grouped.sqlite,atomic:{...core,capacityIntentChecksum:checksum,workspaceIntentCoreDigest:hash(core),workspaceIntentCore:core,priorPeerSequence:core.priorWorkspaceControlGeneration,priorPeerControlDigest:core.priorWorkspaceControlHash,completionDebitBytes:bytes,retainedNonDatabaseOutputBytes:0}};}
 function execute(r,expectedRevision,commit){
  const refused=refusedDrafts.get(r);if(refused)throw refused;
  owned();recover();if(store.readMetadata().revision!==expectedRevision)throw fail('MONEY_REVISION_CONFLICT');r.state.revision=expectedRevision;if(!r.hasChanges())return expectedRevision;
  const prior=current(),c=cap.atomicIO.readControl(epoch,prior),w=workspaceManager.inspectAtomicPeer();if(c.state!=='idle'||w.state!=='idle')throw fail('ATOMIC_RECOVERY_REQUIRED');
  const initial=r.atomicChanges(),hasQuotes=initial.changes.some(x=>x.name==='quotes');
  // Publication is marked before writeControl: a throwing write may have partially persisted.
  let phase='preflight',baseline=null;
  try{
   let operational,quoteSummary;
   if(hasQuotes){if(store.readMetadata().database_schema!==3||prior.profile.workspace?.schema!==2)throw fail('QUOTE_STORAGE_UPGRADE_REQUIRED');if(initial.scans.length)throw fail('ATOMIC_OPERATIONAL_SCOPE_CONFLICT');r.validateQuotePreflight();quoteSummary=r.describeQuoteChanges();r.stageOperationalControl(quoteSummary);}
   const data=r.atomicChanges(),scans=data.scans,q=prior.profile.grouped.sqlite;
   const quoteOnly=hasQuotes&&data.changes.every(x=>x.name==='quotes')&&!data.evidence.length&&!data.capacities.length&&!data.cashReflectionChanged;
   const transient=quoteOnly||scans.length>0&&!data.changes.length&&!data.evidence.length&&!data.capacities.length;
   let workspace;
   const bound=units=>safe(units.reduce((n,u)=>n+BigInt(u.oldRows+u.newRows+u.indexEntries)*BigInt(q.maxPagesPerMutation)*4096n,0n));
   if(scans.length){if(scans.length!==1)throw fail('ATOMIC_WORKSPACE_SCOPE_REQUIRED');const [scopeKey,change]=scans[0],generation=change.value?.generation||change.clearGeneration,description=r.describeWritePlan();workspace={scopeKey,generation,boundBytes:bound(description.units.filter(u=>u.kind==='workspace'||transient))};}
   if(hasQuotes){const description=r.describeWritePlan();operational={kind:'quotes',generation:quoteSummary.generation,quoteChangesDigest:quoteSummary.quoteChangesDigest,boundBytes:bound(description.units.filter(u=>u.owner==='@quote_workspace'))};}
   let plan;if(transient){const semanticIntentDigest=r.semanticIntentDigest(),fullWriteSetDigest=r.writeSetDigest(),groupPlanDigest=hash({semanticIntentDigest,...(workspace?{workspace}:{}),...(operational?{operational}:{}),priorRootDigest:hash(prior),profileDigest:prior.profileDigest}),groupId=hash({epoch:epoch.binding_digest,priorRevision:expectedRevision,groupPlanDigest});plan={root:prior,groupId,semanticIntentDigest,groupPlanDigest,fullWriteSetDigest,total:0};}else{baseline=stagingCut();phase='staging';plan=stage(r,prior,c);phase='staged';}
   const core={schema:operational?2:1,protocol:PROTOCOL,...(transient?{transient:true}:{}),...(workspace?{workspace}:{}),...(operational?{operational}:{}),groupId:plan.groupId,semanticIntentDigest:plan.semanticIntentDigest,groupPlanDigest:plan.groupPlanDigest,fullWriteSetDigest:plan.fullWriteSetDigest,priorRevision:expectedRevision,finalRevision:expectedRevision+1,priorRootDigest:hash(prior),nextRootDigest:hash(plan.root),priorCapacityControlGeneration:c.generation,priorCapacityControlHash:hash(c),priorWorkspaceControlGeneration:w.sequence,priorWorkspaceControlHash:w.controlDigest,completionBeforeBytes:prior.availableBytes,completionAfterBytes:plan.root.availableBytes,priorPaddingBytes:w.geometry.P,releasePaddingBytes:Math.min(w.geometry.P,(workspace||operational)?.boundBytes||0),priorScratchBytes:w.geometry.R,sqliteQuotaDigest:hash(q)};
   const control={workspaceIntentCore:core,state:'active',protocol:PROTOCOL,generation:c.generation+1,preparedGeneration:prior.publicationGeneration,groupId:plan.groupId,allowanceId:plan.receipt?.id||null,...(transient?{transient:true}:{}),semanticIntentDigest:plan.semanticIntentDigest,groupPlanDigest:plan.groupPlanDigest,fullWriteSetDigest:plan.fullWriteSetDigest,priorRevision:expectedRevision,finalRevision:expectedRevision+1,priorRootDigest:hash(prior),nextRootDigest:hash(plan.root),beforeBytes:prior.availableBytes,afterBytes:plan.root.availableBytes,workspaceIntentCoreDigest:hash(core),priorWorkspaceSequence:w.sequence,priorWorkspaceControlDigest:w.controlDigest};
   const body={...control,epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,profileDigest:prior.profileDigest};if(Buffer.byteLength(JSON.stringify({...body,checksum:hash(body)}))>=4096)throw fail('CAPACITY_PUBLICATION_CONTROL_OVERSIZE');
   const authority=authorityFor(core,prior,hash(body));workspaceManager.previewAtomicWrite(authority);r.authorizeWrite(authority);r.validateAtomicEncoded();
   phase='publishing';cap.atomicIO.writeControl(epoch,prior,control);hit('atomic-intent');cap.atomicIO.resizePublication(epoch,prior,0);hit('atomic-publication-release');resizeCompletion(prior,plan.root.availableBytes,prior.availableBytes,prior.availableBytes);hit('atomic-completion-release');
   try{const revision=commit();hit('atomic-after-commit');recover();return revision;}catch(error){try{recover();}catch(recovery){error.atomicRecoveryError=recovery;}throw error;}
  }catch(error){
   const expected=new Set(['QUOTE_STORAGE_UPGRADE_REQUIRED','ATOMIC_OPERATIONAL_SCOPE_CONFLICT','CAPACITY_OPTIONAL_QUOTE_LIMIT','CAPACITY_ENCODED_ROW_LIMIT','CAPACITY_ENCODED_AUDIT_LIMIT','CAPACITY_SQLITE_PLAN_LIMIT','CAPACITY_SQLITE_PAGE_LIMIT','CAPACITY_SQLITE_NET_PAGE_LIMIT','WORKSPACE_RETAINED_LIMIT','WORKSPACE_PARTITION_LIMIT','QUOTE_WORKSPACE_UNAVAILABLE','SQLITE_FULL']);
   if(hasQuotes&&expected.has(error.code)&&!error.atomicRecoveryError)try{recover();const peer=workspaceManager.inspectAtomicPeer();workspaceManager.status();if(store.readMetadata().revision===expectedRevision&&hash(current())===hash(prior)&&cap.atomicIO.readControl(epoch,prior).state==='idle'&&peer.state==='idle')provedRefusals.add(error);}catch{}
   // A non-quote shared hold exhausted while staging is an uncommitted refusal only when fresh reads match the pre-staging cut.
   // The brand stays on this Error and the failed draft can never be committed or acknowledged.
   if(!hasQuotes&&phase==='staging'&&baseline&&error?.code==='SHARED_HOLD_EXHAUSTED'&&!error.atomicRecoveryError&&unchangedSince(baseline)){provedRefusals.add(error);refusedDrafts.set(r,error);}
   throw error;
  }
 }
 const api={execute,recover,peer,verify};branded.add(api);return api;
}
module.exports={isProvedUncommittedRefusal,createAtomicCapacityRouter,isAtomicRouter};
