'use strict';
// Offline physical restoration. Authority is minted only from an authenticated
// checkpoint and a stopped, request-bound target; public plans grant no rights.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {digestJSON:hash,canonicalJSON}=require('./stripe-transfer-persistence');
const {assertMoneyWriter}=require('./money-writer-lock');
const authorityRecords=new WeakMap(),maintenanceRecords=new WeakMap();
const CONTROL='money-atomic-restore-control.bin',INITIALIZATION='money-atomic-restore-initialization.json',NEXT=INITIALIZATION.replace('.json','.next.json');
const ENGINEERING='money-restore-engineering-reserve.bin',PUBLICATION='money-restore-publication-reserve.bin',SLOT=65536;
const HEX=/^[a-f0-9]{64}$/;
function fail(code){throw Object.assign(Error(code),{code});}
function exact(value,keys){return value&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).length===keys.length&&keys.every(k=>{const d=Object.getOwnPropertyDescriptor(value,k);return d?.enumerable&&Object.hasOwn(d,'value');});}
function text(v,max=512){return typeof v==='string'&&v.trim().length>0&&Buffer.byteLength(v)<=max&&!v.includes('\0');}
function number(v,positive=false){return Number.isSafeInteger(v)&&v>=(positive?1:0);}
function aligned(v,positive=false){return number(v,positive)&&v%4096===0;}
function digestBytes(bytes){return crypto.createHash('sha256').update(bytes).digest('hex');}
function fileIdentity(file,{bytes,identity,allocated=true,directory=false}={}){
 const s=fs.lstatSync(file);if(fs.realpathSync(file)!==path.resolve(file)||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o7777)!==(directory?0o700:0o600)||(directory?!s.isDirectory():!s.isFile()||s.nlink!==1))fail('RESTORE_PHYSICAL_IDENTITY');
 if(!directory&&(bytes!==undefined&&s.size!==bytes||allocated&&s.blocks*512<s.size))fail('RESTORE_PHYSICAL_BACKING');
 if(identity&&(s.dev!==identity.dev||s.ino!==identity.ino))fail('RESTORE_PHYSICAL_IDENTITY');
 return{dev:s.dev,ino:s.ino,bytes:s.size,allocatedBytes:s.blocks*512,uid:s.uid,mode:s.mode&0o7777,nlink:s.nlink};
}
const ALLOWANCE=['schema','checkpointDigest','bindingDigest','profileDigest','databaseSchema','barrierDigest','permanentBoundBytes','publicationBoundBytes','maxGrowthPages','maxNetOccupiedPages','evidenceRef'];
function allowanceBody(input){const {requestId,...body}=input||{};if(!exact(body,ALLOWANCE)||body.schema!==1||body.databaseSchema!==3||!['checkpointDigest','bindingDigest','profileDigest','barrierDigest'].every(k=>HEX.test(body[k]))||!aligned(body.permanentBoundBytes,true)||!aligned(body.publicationBoundBytes,true)||!number(body.maxGrowthPages)||!number(body.maxNetOccupiedPages)||!text(body.evidenceRef))fail('RESTORE_ALLOWANCE_INVALID');return body;}
function deriveRestoreRequestId({targetRoot,executionApprovalRef,restoreAllowance}){
 const body=allowanceBody(restoreAllowance);if(!text(executionApprovalRef)||!path.isAbsolute(targetRoot||'')||path.resolve(targetRoot)!==targetRoot)fail('RESTORE_ALLOWANCE_INVALID');
 const target=fileIdentity(targetRoot,{directory:true});return hash({body,executionApprovalRef,target:{path:targetRoot,dev:target.dev,ino:target.ino}});
}
function validateRestoreAllowance(input){const body=allowanceBody(input.restoreAllowance);if(!exact(input.restoreAllowance,[...ALLOWANCE,'requestId'])||input.restoreAllowance.requestId!==deriveRestoreRequestId(input))fail('RESTORE_ALLOWANCE_INVALID');return Object.freeze({...body,requestId:input.restoreAllowance.requestId});}
function inspectRestoreMaintenanceAuthority(authority,{root,writer}={}){const a=maintenanceRecords.get(authority);if(!a||a.targetRoot!==root||a.writer!==writer)fail('RESTORE_AUTHORITY_REQUIRED');if(!a.readOnlyCheckpoint)assertMoneyWriter(writer,{root});fileIdentity(root,{directory:true,identity:a.targetIdentity});return a;}
function inspectRestoreAuthority(authority,{store,epoch,writer,phase}={}){
 const a=authorityRecords.get(authority);if(!a||a.store!==store||a.epoch!==epoch||a.writer!==writer)fail('RESTORE_AUTHORITY_REQUIRED');assertMoneyWriter(writer,{root:epoch.legacy_root});
 if(!['inspect','prior','released','precommit','outcome'].includes(phase))fail('RESTORE_AUTHORITY_REQUIRED');
 a.verify(phase);return{plan:structuredClone(a.plan),physicalProof:structuredClone(a.physicalProof),temporaryDirectory:a.temporaryDirectory};
}
module.exports={CONTROL,INITIALIZATION,NEXT,ENGINEERING,PUBLICATION,SLOT,deriveRestoreRequestId,validateRestoreAllowance,inspectRestoreAuthority,inspectRestoreMaintenanceAuthority};

function inspectCheckpointEpoch({root,sourceEpoch,writer,manifest,inspect}){
 const e=require('./financial-epoch'),binding=e.validateBinding(require('./stripe-transfer-persistence').readJSONStrict(path.join(root,e.BINDING_FILE))),dir=path.join(root,'financial-epochs',binding.identity.epoch_id),stageNames=fs.readdirSync(dir).filter(n=>n.endsWith('.tmp')||n.includes('.stage-'));
 if(sourceEpoch){assertMoneyWriter(writer,{root});const trusted=e.requireEpoch(sourceEpoch);if(hash(trusted.binding)!==hash(binding)||sourceEpoch.legacy_root!==root)fail('CHECKPOINT_STORE_IDENTITY');const control=e.validateControl(require('./stripe-transfer-persistence').readJSONStrict(path.join(dir,e.CONTROL_FILE)),binding);if(hash(control)!==hash(trusted.control))fail('CHECKPOINT_STORE_IDENTITY');}
 else if(!manifest||manifest.checksum!==e.seal(manifest).checksum||manifest.binding_digest!==binding.binding_digest)fail('CHECKPOINT_MANIFEST_INVALID');
 const stage=stageNames[0];if(stageNames.length>1||stage&&!/^credits\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.test(stage))fail('CHECKPOINT_UNCERTAIN_STAGE');
 if(!sourceEpoch&&stage){const row=manifest.compensation_stage,file=path.join(dir,stage),actual=readOwned(file);if(!row||row.relativePath!==path.relative(root,file)||row.sha256!==actual.digest||row.bytes!==actual.bytes.length||!manifest.files.some(f=>f.path===row.relativePath&&f.sha256===row.sha256&&f.bytes===row.bytes))fail('CHECKPOINT_STAGE_UNPROVEN');}
 const token=Object.freeze({});maintenanceRecords.set(token,{readOnlyCheckpoint:true,targetRoot:root,targetIdentity:fileIdentity(root,{directory:true}),writer,stageNames,ownedStages:[]});let result;
 try{e.resolveRuntimeEpoch({root,writer,restoreAuthority:token,inspectValidatedDatabase(epoch,reader){let candidate=null;if(stage){if(sourceEpoch){const helper=require('./money-compensation-stage'),proof=helper.inspectCreditsCompensationStage({epochIdentity:sourceEpoch,writer,reader,stageName:stage});candidate=helper.discardCreditsCompensationStage(proof);}else{const c=manifest.first_failure_control?.compensation,spend=c&&reader.state.spends[c.spendId];if(!spend||spend.digest!==c.spendDigest)fail('CHECKPOINT_STAGE_UNPROVEN');require('./money-compensation-stage').validateCompensationStageImage({primary:JSON.parse(fs.readFileSync(path.join(dir,'credits.json'))),candidateBytes:fs.readFileSync(path.join(dir,stage)),spend});candidate=manifest.compensation_stage;}}result=inspect(sourceEpoch||epoch,reader,candidate);}});return result;}finally{maintenanceRecords.delete(token);}
}
module.exports.inspectCheckpointEpoch=inspectCheckpointEpoch;
function decodeCapacityControl({bytes,epoch,root,expectedDigest}){
 if(!Buffer.isBuffer(bytes)||bytes.length!==8192||digestBytes(bytes)!==expectedDigest)fail('RESTORE_CAPACITY_CONTROL_INVALID');const rows=[];
 for(let i=0;i<2;i++){try{const b=bytes.subarray(i*4096,(i+1)*4096),end=b.indexOf(0);if(end<1||b.subarray(end).some(x=>x!==0))continue;const{checksum,...body}=JSON.parse(b.subarray(0,end));if(checksum!==hash(body)||body.epoch_id!==epoch.epoch_id||body.binding_digest!==epoch.binding_digest||body.profileDigest!==root.profileDigest||!number(body.generation))continue;rows.push(body);}catch{}}
 rows.sort((a,b)=>b.generation-a.generation);if(!rows.length||rows[1]?.generation===rows[0].generation&&hash(rows[1])!==hash(rows[0])||rows[0].state!=='idle'||rows[0].preparedGeneration!==root.publicationGeneration)fail('RESTORE_CAPACITY_CONTROL_INVALID');return rows[0];
}
function checkpointCompensationEarnings({epoch,writer,store,root}){
 const proof=require('./money-failure-control').openFailureControl({epoch,writer,store}).checkpointProof();if(proof.state!=='compensation_requested')return null;
 const c=proof.compensation,file=path.join(epoch.financial_dir,'earnings.json'),actual=readOwned(file);assertRestoredEarningsIdentity({epoch,writer,root,compensation:c,actual:{...actual.identity,sha256:actual.digest}});
 let predecessorEquivalenceDigest=null;if(actual.identity.dev!==c.earningsFileIdentity.dev||actual.identity.ino!==c.earningsFileIdentity.ino)predecessorEquivalenceDigest=hash(readCompletedRestore({epoch,writer,root}).plan.compensationEarnings);
 const {dev,ino,uid,mode,nlink}=actual.identity;
 return{schema:1,participant:'earnings',relativePath:path.relative(epoch.legacy_root,file),compensationDigest:hash(c),spendId:c.spendId,spendDigest:c.spendDigest,walId:c.walId,walPayloadDigest:c.walPayloadDigest,originalIdentity:c.earningsFileIdentity,sha256:actual.digest,bytes:actual.bytes.length,sourceIdentity:{dev,ino,uid,mode,nlink},predecessorEquivalenceDigest};
}
// A2 (v3 2.1, 2.7): the source half S and the unresolved-obligation list. Pure reads of durable state; the
// checkpoint process never requires lib/wal.js. S exists only on a RETIRING cut.
function checkpointContinuation({epoch,writer,store,root,retiring}){
 const A=require('./money-continuation-authority'),proof=require('./money-failure-control').openFailureControl({epoch,writer,store}).checkpointProof();let owned=null;
 const earnings=()=>{owned??=readOwned(path.join(epoch.financial_dir,'earnings.json'));return{sha256:owned.digest,bytes:owned.bytes.length,identity:owned.identity};};
 const restoredEntryFor=walId=>{if(!root.restoreBinding)return null;const body=readCompletedRestore({epoch,writer,root}),T=body.plan.continuationEarnings,role=body.plan.roles.continuation_earnings;return T&&role&&T.entries[0].walId===walId?{entry:T.entries[0],role}:null;};
 const ctx={getSpend:id=>store.getSpend(id),hasPool:walId=>!!store.getPool('unlock:'+walId),earnings,compensationWalId:proof.state==='compensation_requested'?proof.compensation.walId:null,restoredEntryFor};
 return A.evaluateObligations({wals:A.readWalFiles(require('./financial-epoch').pathFor('wal',epoch)),retiring,ctx,epochId:epoch.epoch_id});
}
function checkpointAtomicCut({epoch,writer,store,retiring=false}){
 assertMoneyWriter(writer,{root:epoch.legacy_root});const root=store.getCapacityRecord('capacity:root');if(root?.profile.grouped?.commitProtocol!=='single_sql_v1')return null;
 if(store.readMetadata().database_schema!==3||root.profile.workspace.schema!==2)fail('RESTORE_STORAGE_UPGRADE_REQUIRED');
 const workspace=require('./money-workspace').inspectCheckpointWorkspace({epoch,writer,store,profile:root.profile.workspace});
 const capacity=require('./money-capacity').atomicIO.readControl(epoch,root),snapshot=store.readAtomicCheckpointDigests();
 if(hash(capacity.lastCompleted||null)!==workspace.jointCompletionDigest)fail('CHECKPOINT_ATOMIC_CUT_REQUIRED');
 const paddingRoles=workspace.padding.map(row=>({...row,relativePath:row.path}));
 if(root.restoreBinding){const prior=readCompletedRestore({epoch,writer,root});for(const role of ['engineeringReserve','engineeringPublication']){const row=prior.plan.roles[role],bytes=role==='engineeringReserve'?Number(prior.outcome.restoreBinding.allowanceBoundBytes)-Number(prior.outcome.restoreBinding.consumedBytes):row.bytes;const physical=fileIdentity(path.join(epoch.financial_dir,row.relativePath),{bytes,identity:row});paddingRoles.push({...physical,relativePath:row.relativePath,role});}}
 return{cut:{databaseSchema:3,workspaceSchema:2,journalRevision:snapshot.metadata.revision,journalSequence:snapshot.metadata.sequence,capacityRootDigest:hash(root),financialStateDigest:snapshot.financialStateDigest,metadataIdentityDigest:snapshot.metadataIdentityDigest,rootEconomicDigest:snapshot.rootEconomicDigest,profileDigest:root.profileDigest,capacityControlDigest:hash(capacity),workspaceControlDigest:workspace.controlDigest,jointCompletionDigest:workspace.jointCompletionDigest,quoteControlDigest:snapshot.quoteControlDigest,leaseStateDigest:workspace.leaseStateDigest,scanStateDigest:snapshot.scanStateDigest,workspaceMetricsDigest:hash(workspace.metrics),previousRestoreBindingDigest:hash(root.restoreBinding||null),paddingRoles,compensationEarnings:checkpointCompensationEarnings({epoch,writer,store,root}),...checkpointContinuation({epoch,writer,store,root,retiring})},padding:paddingRoles};
}
module.exports.checkpointAtomicCut=checkpointAtomicCut;
function syncDir(dir){const fd=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function readOwned(file,expected){const identity=fileIdentity(file,{identity:expected,allocated:false}),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const opened=fs.fstatSync(fd);if(opened.dev!==identity.dev||opened.ino!==identity.ino)fail('RESTORE_PHYSICAL_IDENTITY');const bytes=fs.readFileSync(fd);fileIdentity(file,{identity,allocated:false});return{bytes,identity,digest:digestBytes(bytes)};}finally{fs.closeSync(fd);}}
function allocateOwned(file,bytes){if(!aligned(bytes)||fs.existsSync(file))fail('RESTORE_ALLOCATION_OWNERSHIP_REQUIRED');const fd=fs.openSync(file,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{const b=Buffer.alloc(Math.min(bytes||1,1048576));for(let offset=0;offset<bytes;){const n=fs.writeSync(fd,b,0,Math.min(bytes-offset,b.length),offset);if(!n)fail('RESTORE_SHORT_ALLOCATION');offset+=n;}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDir(path.dirname(file));return fileIdentity(file,{bytes});}
function resizeOwned(file,target,identity,{minimum=0,maximum=identity.bytes}={}){const before=fileIdentity(file,{identity,allocated:false});if(before.bytes<minimum||before.bytes>maximum||target<minimum||target>maximum)fail('RESTORE_PHYSICAL_EXTENT');const fd=fs.openSync(file,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);if(s.dev!==identity.dev||s.ino!==identity.ino)fail('RESTORE_PHYSICAL_IDENTITY');if(target<before.bytes)fs.ftruncateSync(fd,target);else{const b=Buffer.alloc(Math.min(target||1,1048576));for(let at=before.bytes;at<target;){const n=fs.writeSync(fd,b,0,Math.min(target-at,b.length),at);if(!n)fail('RESTORE_SHORT_ALLOCATION');at+=n;}}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return fileIdentity(file,{bytes:target,identity});}
function writeExisting(file,bytes,identity,{offset=0}={}){fileIdentity(file,{identity,allocated:false});const fd=fs.openSync(file,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);if(s.dev!==identity.dev||s.ino!==identity.ino||offset+bytes.length>s.size)fail('RESTORE_PHYSICAL_IDENTITY');let at=0;while(at<bytes.length){const n=fs.writeSync(fd,bytes,at,bytes.length-at,offset+at);if(!n)fail('RESTORE_SHORT_WRITE');at+=n;}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fileIdentity(file,{identity,allocated:false});}
function encodeControl(body){const bytes=Buffer.from(canonicalJSON({...body,checksum:hash(body)}));if(bytes.length>=SLOT)fail('RESTORE_CONTROL_LIMIT');const padded=Buffer.alloc(SLOT);bytes.copy(padded);return padded;}
function readRestoreControl(file,{copiedDigest,lenient=false}={}){const opened=readOwned(file),valid=[];if(copiedDigest!==undefined&&(!HEX.test(copiedDigest)||opened.digest!==copiedDigest))fail('RESTORE_PREDECESSOR_INVALID');if(opened.bytes.length!==SLOT*2)fail('RESTORE_CONTROL_INVALID');for(let i=0;i<2;i++){try{const raw=opened.bytes.subarray(i*SLOT,(i+1)*SLOT),end=raw.indexOf(0);if(end<1||raw.subarray(end).some(x=>x!==0))continue;const{checksum,...body}=JSON.parse(raw.subarray(0,end));if(hash(body)!==checksum||body.schema!==1||body.protocol!=='atomic_restore_v1'||!number(body.sequence)||!HEX.test(body.restoreId)||!['initializing','prepared','released','sql_committed','workspace_published','capacity_published','complete'].includes(body.phase))continue;valid.push(body);}catch{}}
 valid.sort((a,b)=>b.sequence-a.sequence);if(!valid.length||valid[1]?.sequence===valid[0].sequence&&hash(valid[0])!==hash(valid[1]))fail('RESTORE_CONTROL_INVALID');const body=valid[0];if(copiedDigest===undefined&&!lenient&&(body.control.dev!==opened.identity.dev||body.control.ino!==opened.identity.ino))fail('RESTORE_CONTROL_IDENTITY');return body;}
function persistControl(file,body){if(!number(body.sequence+1))fail('RESTORE_GENERATION_OVERFLOW');const next={...body,sequence:body.sequence+1};writeExisting(file,encodeControl(next),body.control,{offset:next.sequence%2*SLOT});return next;}
function completePlan(plan){const{planDigest,...body}=plan;if(planDigest!==hash(body))fail('RESTORE_PLAN_INVALID');return plan;}
function readCompletedRestore({epoch,writer,root}){
 assertMoneyWriter(writer,{root:epoch.legacy_root});const body=readRestoreControl(path.join(epoch.financial_dir,CONTROL)),plan=completePlan(body.plan),binding=root.restoreBinding;
 if(body.phase!=='complete'||!binding||binding.restoreId!==body.restoreId||binding.planDigest!==plan.planDigest||binding.rolePlanDigest!==plan.rolePlanDigest||hash(binding)!==body.outcome?.receipt?.bindingDigest||body.outcome.receiptDigest!==hash(body.outcome.receipt)||body.outcome.receipt.restoreId!==body.restoreId)fail('RESTORE_COMPLETION_REQUIRED');
 const init=readOwned(path.join(epoch.financial_dir,INITIALIZATION));if(init.digest!==body.initializationDigest)fail('RESTORE_INITIALIZATION_CONFLICT');
 auditCompletedClaim(body);
 const barrier=require('./stripe-transfer-persistence').readJSONStrict(path.join(epoch.legacy_root,'money-restore-barrier.json'));if(barrier.checksum!==require('./financial-epoch').seal(barrier).checksum||barrier.capacity_recreation_required!==false||barrier.atomic_restore?.restoreId!==plan.restoreId||barrier.atomic_restore.receiptDigest!==body.outcome.receiptDigest)fail('RESTORE_BARRIER_CONFLICT');
 for(const name of ['publicationControl','workspaceControl']){const r=plan.roles[name];fileIdentity(path.join(epoch.financial_dir,r.relativePath),{bytes:r.bytes,identity:r});}
 return body;
}
// Addendum 2 D2.2: readCompletedRestore audits the stored claim. Absent (every ordinary restore) is fine; a present claim must be
// well formed, name THIS restore, and agree with the plan's successorClaim (a recorded claim iff the plan holds one).
function auditCompletedClaim(body){
 if(body.claim===undefined)return true;
 const A=require('./money-continuation-authority'),plan=body.plan,sc=plan.successorClaim??null,claim=body.claim;
 A.validateClaim(claim,{allowance:{requestId:body.restoreId},manifest:{checksum:plan.checkpointDigest,sourceRetirement:{identity:{generationId:sc?sc.generationId:claim?.generationId}}},initDigest:body.initializationDigest});
 if(sc&&(claim.state!=='recorded'||claim.successorDigest!==sc.successorDigest||sc.restoreId!==claim.restoreId||sc.initializationDigest!==claim.initializationDigest))fail('RESTORE_CLAIM_CONFLICT');
 return true;
}
function resolveRestoredRole({epoch,writer,root,role,original}){if(!root?.restoreBinding)return original;const body=readCompletedRestore({epoch,writer,root}),r=body.plan.roles[role];if(!r)fail('RESTORE_ROLE_UNBOUND');const actual=readOwned(path.join(epoch.financial_dir,r.relativePath),r);if(role!=='first_failure_control'&&r.sha256&&actual.digest!==r.sha256)fail('RESTORE_ROLE_CHANGED');return{...original,...actual.identity,role:original.role};}
function assertRestoredEarningsIdentity({epoch,writer,root,compensation,actual}){
 if(actual.sha256!==compensation.earningsBeforeDigest)fail('COMPENSATION_ACCRUAL_CONFLICT');if(actual.dev===compensation.earningsFileIdentity.dev&&actual.ino===compensation.earningsFileIdentity.ino)return true;
 const body=readCompletedRestore({epoch,writer,root}),entry=body.plan.compensationEarnings,r=body.plan.roles.compensation_earnings;
 if(!entry||!r||entry.compensationDigest!==hash(compensation)||hash(entry.originalIdentity)!==hash(compensation.earningsFileIdentity)||entry.sha256!==actual.sha256||actual.bytes!==entry.bytes||actual.dev!==r.dev||actual.ino!==r.ino)fail('COMPENSATION_ACCRUAL_CONFLICT');
 const failure=readOwned(path.join(epoch.financial_dir,require('./money-failure-control').FILE),body.plan.roles.first_failure_control);if(failure.bytes.length!==8192)fail('COMPENSATION_ACCRUAL_CONFLICT');
 const proof=require('./money-failure-control').inspectFailureControl({epoch,writer,databaseId:body.databaseId,role:{...body.plan.roles.first_failure_control,role:'first_failure_control'}});if(proof.body.state!=='compensation_requested'||hash(proof.body.compensation)!==entry.compensationDigest)fail('COMPENSATION_ACCRUAL_CONFLICT');return true;
}
function verifyFinalPhysicalCut({epoch,writer,store,body,expectedOutcome,expectedCompletion,publicationBytes}){
 const root=store.getCapacityRecord('capacity:root'),plan=completePlan(body.plan),workspace=require('./money-workspace'),capacity=require('./money-capacity');
 if(!root.restoreBinding||root.restoreBinding.planDigest!==plan.planDigest||root.restoreBinding.rolePlanDigest!==plan.rolePlanDigest||hash(root.restoreBinding)!==body.outcome.receipt.bindingDigest)fail('RESTORE_COMPLETION_REQUIRED');
 const check=(name,bytes)=>fileIdentity(path.join(epoch.financial_dir,plan.roles[name].relativePath),{bytes,identity:plan.roles[name]});
 check('completion',root.availableBytes);check('publication',root.profile.publicationBytes);check('publicationControl',8192);check('workspaceControl',131072);check('first_failure_control',8192);
 const peer=capacity.atomicIO.readControl(epoch,root),proof=workspace.inspectCheckpointWorkspace({epoch,writer,store:{...store,getAtomicCapacityPeer:()=>peer},profile:root.profile.workspace});
 check('workspaceDeficit',proof.geometry.P);check('workspaceScratch',proof.geometry.R);check('engineeringReserve',Number(root.restoreBinding.allowanceBoundBytes)-Number(root.restoreBinding.consumedBytes));check('engineeringPublication',publicationBytes===undefined?plan.roles.engineeringPublication.bytes:publicationBytes);
 if(expectedCompletion&&hash(peer.lastCompleted)!==hash(expectedCompletion))fail('RESTORE_JOINT_CUT_CONFLICT');
 if(expectedOutcome){const actual=store.readAtomicRestoreSnapshot();if(actual.rootDigest!==expectedOutcome.rootDigest||actual.metadata.revision!==expectedOutcome.revision||actual.financialStateDigest!==plan.financialStateDigest||actual.metadataIdentityDigest!==plan.metadataIdentityDigest||actual.rootEconomicDigest!==plan.rootEconomicDigest||actual.quoteControlDigest!==plan.quoteControlDigest||actual.scanStateDigest!==plan.scanStateDigest)fail('RESTORE_SQL_CONFLICT');}
 return proof;
}
async function completedRestoreRetry({input,manifest,binding,barrier,allowance,targetIdentity}){
 const {targetRoot,writer}=input,dir=path.join(targetRoot,'financial-epochs',binding.identity.epoch_id),token=Object.freeze({});maintenanceRecords.set(token,{targetRoot,writer,targetIdentity,checkpointDigest:manifest.checksum,stageNames:manifest.compensation_stage?[path.basename(manifest.compensation_stage.relativePath)]:[],ownedStages:[]});let store;
 try{const epoch=require('./financial-epoch').resolveRuntimeEpoch({root:targetRoot,writer,restoreAuthority:token});store=require('./money-control-store').openAtomicRestoreStore({epoch,writer});return await store.maintenanceLease(()=>{const snapshot=store.readAtomicRestoreSnapshot(),body=readCompletedRestore({epoch,writer,root:snapshot.root});if(body.plan.restoreId!==allowance.requestId||body.plan.allowanceDigest!==hash(allowance)||body.plan.checkpointDigest!==manifest.checksum||body.plan.lifecycleDigest!==hash(input.authoritativeLifecycle))fail('RESTORE_REQUEST_CONFLICT');require('./money-checkpoint').validateRestoreAuthority(manifest,input.authoritativeLifecycle);verifyFinalPhysicalCut({epoch,writer,store,body});return{state:'reconcile_only',capacity_recreation_required:false,restore_id:allowance.requestId,sql_revision:body.outcome.revision,barrier_digest:barrier.checksum,...successorSummary(body.plan,manifest,refusalOutcome({plan:body.plan,manifest,claimInput:input.successorClaim,allowance,initializationDigest:body.initializationDigest}))};});}finally{store?.close();maintenanceRecords.delete(token);}
}
function exactPreparedResume({targetRoot,dir,allowance,expectedCheckpointDigest,expectedBarrierDigest,authoritativeLifecycle}){
 for(const name of ['.stage-restore-control-'+allowance.requestId,CONTROL]){const file=path.join(dir,name);if(!fs.existsSync(file))continue;let body;try{body=readRestoreControl(file);}catch(error){if(name!==CONTROL)throw error;continue;}if(body.restoreId!==allowance.requestId||body.phase==='initializing')continue;const plan=completePlan(body.plan);if(plan.restoreId!==allowance.requestId||plan.checkpointDigest!==expectedCheckpointDigest||plan.barrierDigest!==expectedBarrierDigest||plan.allowanceDigest!==hash(allowance)||plan.lifecycleDigest!==hash(authoritativeLifecycle)||plan.rolePlanDigest!==hash(plan.roles))fail('RESTORE_REQUEST_CONFLICT');const init=readOwned(path.join(dir,fs.existsSync(path.join(dir,NEXT))?NEXT:INITIALIZATION));if(init.digest!==body.initializationDigest)fail('RESTORE_INITIALIZATION_CONFLICT');const {checksum,...value}=JSON.parse(init.bytes),target=fileIdentity(targetRoot,{directory:true});if(checksum!==hash(value)||value.restoreId!==allowance.requestId||value.checkpointDigest!==expectedCheckpointDigest||value.barrierDigest!==expectedBarrierDigest||value.allowanceDigest!==hash(allowance)||value.target.path!==targetRoot||value.target.dev!==target.dev||value.target.ino!==target.ino)fail('RESTORE_INITIALIZATION_CONFLICT');return body;}
 return null;
}
// A pre-A2 plan has none of the three fields and reads as null; an A2 plan must agree with its manifest.
// A retry cannot read the refusal code from the plan (only SUCCESSOR_REFUSED is stored), so it is re-derived read-only from the
// source record. Without a reachable, offered source there is no code, never a guess.
function refusalOutcome({plan,manifest,claimInput,allowance,initializationDigest,readMetadata}){
 if(!manifest.sourceRetirement||plan.continuationWithheld!=='SUCCESSOR_REFUSED'||!claimInput)return null;
 try{
  const current=verifySourceForClaim({sourceRoot:claimInput.sourceRoot,sourceWriter:claimInput.sourceWriter,manifest,readMetadata}).control.retirement.successor;
  const same=current&&current.restoreId===allowance.requestId&&current.initializationDigest===initializationDigest&&current.checkpointDigest===manifest.checksum;
  return current!==null&&!same?{code:'SUCCESSOR_ALREADY_CLAIMED'}:null;
 }catch(error){return error.code==='SOURCE_IDENTITY_MISMATCH'?{code:error.code}:null;}
}
// What the caller learns about the successor claim. A refusal is reported (with its code when this run saw it) and the restore still completes withheld.
function successorSummary(plan,manifest,outcome){
 if(!manifest.sourceRetirement)return{};
 if(plan.successorClaim)return{successor:{state:'claimed',continuation:plan.continuationEarnings?'minted':'none_owed'}};
 return{successor:{state:plan.continuationWithheld==='SUCCESSOR_REFUSED'?'refused':plan.continuationWithheld==='SUCCESSOR_ABSENT'?'absent':'withheld',...(outcome?.code?{code:outcome.code}:{})}};
}
function bindPreparedContinuation(plan,manifest){
 const A=require('./money-continuation-authority'),T=plan.continuationEarnings??null,withheld=plan.continuationWithheld??null,claim=plan.successorClaim??null,cut=manifest.atomic_capacity_cut,retiring=manifest.sourceRetirement!==undefined;
 const conflict=()=>fail('RESTORE_PREPARED_CHECKPOINT_CONFLICT');
 if(withheld!==null&&!A.WITHHELD.includes(withheld))conflict();
 if(retiring?withheld==='NOT_RETIRING':!!T||!!claim||withheld!==null&&withheld!=='NOT_RETIRING')conflict();
 if(T&&T.cutDigest!==hash(cut.continuationEarnings??null))conflict();
 if(claim&&claim.generationId!==A.generationOf(manifest))conflict();
 if(!!T&&!claim)conflict();
}
function bindPreparedManifest(body,manifest){
 const plan=body.plan,cut=manifest.atomic_capacity_cut;
 const fields={priorRootDigest:cut.capacityRootDigest,priorRevision:manifest.journal_revision,priorSequence:manifest.journal_sequence,profileDigest:cut.profileDigest,databaseSchema:cut.databaseSchema,workspaceSchema:cut.workspaceSchema,previousBindingDigest:cut.previousRestoreBindingDigest,priorJointCompletionDigest:cut.jointCompletionDigest,capacityControlDigest:cut.capacityControlDigest,workspaceControlDigest:cut.workspaceControlDigest,quoteControlDigest:cut.quoteControlDigest,leaseStateDigest:cut.leaseStateDigest,scanStateDigest:cut.scanStateDigest,financialStateDigest:cut.financialStateDigest,metadataIdentityDigest:cut.metadataIdentityDigest,rootEconomicDigest:cut.rootEconomicDigest};
 if(Object.entries(fields).some(([key,value])=>value===undefined||plan[key]!==value)||hash(plan.priorMetrics)!==cut.workspaceMetricsDigest||hash(plan.compensationEarnings)!==hash(cut.compensationEarnings))fail('RESTORE_PREPARED_CHECKPOINT_CONFLICT');
 bindPreparedContinuation(plan,manifest);
}
function readArchivedControls(cp,checkpointDir,manifest,relative){
 const requested=new Map([require('./money-workspace').CONTROL,require('./money-capacity').CONTROL_FILE,CONTROL,INITIALIZATION].map(name=>[relative(name),name])),archived={};let parts;
 const scanned=cp.scanCheckpointArchive(path.join(checkpointDir,cp.ARCHIVE),manifest,{start(row){parts=null;if(requested.has(row.path)){if(row.bytes>2*SLOT)fail('RESTORE_ARCHIVED_CONTROL_LIMIT');parts=[];}},chunk(_row,bytes){if(parts)parts.push(Buffer.from(bytes));},end(row){if(parts)archived[requested.get(row.path)]={bytes:Buffer.concat(parts),digest:row.sha256};parts=null;}});if(scanned.sha256!==manifest.archive.sha256||scanned.archive_bytes!==manifest.archive.archive_bytes)fail('RESTORE_CHECKPOINT_CHANGED');return archived;
}
// ---- A2 authenticated continuation (v3 8.3-8.4, Addendum 1 A1-A3, Addendum 2 D1.5 and D2) ----------------------
// Everything below that touches the SOURCE does so only through the exclusive source writer, and a source that
// cannot be reached or verified HOLDS the restore (retryable) instead of finalizing it withheld.
function heldError(why){return Object.assign(Error('RESTORE_SUCCESSOR_HELD'),{code:'RESTORE_SUCCESSOR_HELD'},why?{reason:String(why)}:{});}
function sourceMismatch(check){const error=Object.assign(Error('SOURCE_IDENTITY_MISMATCH'),{code:'SOURCE_IDENTITY_MISMATCH'});Object.defineProperty(error,'check',{value:check,enumerable:false});return error;}
function defaultSourceMetadata({sourceRoot,sourceWriter}){
 const live=require('./money-control').getMoneyRuntime();
 if(live&&live.writer===sourceWriter&&live.epoch.legacy_root===sourceRoot)return live.store.readMetadata();
 const e=require('./financial-epoch'),epoch=e.resolveRuntimeEpoch({root:sourceRoot,writer:sourceWriter}),store=require('./money-control-store').openMoneyStore({epoch,writer:sourceWriter});
 try{return store.readMetadata();}finally{store.close();}
}
// Addendum 1 A3.1 with the Addendum 2 D1.5 projection compare. Positive evidence of a different source throws
// SOURCE_IDENTITY_MISMATCH; anything that merely cannot be read throws RESTORE_SUCCESSOR_HELD. No write happens here.
function verifySourceForClaim({sourceRoot,sourceWriter,manifest,readMetadata=defaultSourceMetadata}){
 const A=require('./money-continuation-authority'),e=require('./financial-epoch'),P=manifest.sourceRetirement.identity,S=P.sourceIdentity;
 try{assertMoneyWriter(sourceWriter,{root:sourceRoot});}catch(error){throw heldError(error.code);}
 let real,rootStat,lockStat,dbStat,pair;
 try{real=fs.realpathSync(sourceRoot);rootStat=fs.lstatSync(sourceRoot);lockStat=fs.lstatSync(path.join(sourceRoot,'.money-writer.lock'));}catch(error){throw heldError(error.code);}
 if(real!==path.resolve(sourceRoot))throw sourceMismatch('PATH');
 try{pair=e.readEpochControl(sourceRoot);dbStat=fs.lstatSync(e.confined(path.join(pair.dir,e.PARTICIPANTS.money_database),'file'));}
 catch(error){if(['RETIREMENT_IDENTITY_INVALID','EPOCH_CONTROL_INVALID','EPOCH_BINDING_INVALID','EPOCH_IDENTITY_INVALID'].includes(error.code))throw sourceMismatch('CONTROL');throw heldError(error.code);}
 const same=(stat,id)=>stat.dev===id.dev&&stat.ino===id.ino;
 if(!same(rootStat,S.root))throw sourceMismatch('ROOT');
 if(!same(lockStat,S.lock))throw sourceMismatch('LOCK');
 if(!same(dbStat,S.sqlite))throw sourceMismatch('SQLITE');
 const {control,binding}=pair,R=control.retirement;
 if(binding.binding_digest!==S.bindingDigest||control.epoch_id!==S.epochId)throw sourceMismatch('BINDING');
 if(!R)throw sourceMismatch('NOT_RETIRED');
 if(hash(R.identity)!==R.identityDigest||R.identityDigest!==manifest.sourceRetirement.identityDigest||R.identity.generationId!==A.generationOf(manifest))throw sourceMismatch('PROJECTION');
 if(control.generation<P.retiredAtGeneration)throw sourceMismatch('GENERATION');
 if(R.state!=='retired'||R.publishedCheckpointDigest===null)throw sourceMismatch('STATE');
 let meta;try{meta=readMetadata({sourceRoot,sourceWriter,control,binding});}catch(error){throw heldError(error.code);}
 if(meta.database_id!==S.databaseId)throw sourceMismatch('DATABASE');
 if(!(meta.revision>=S.journalRevision))throw sourceMismatch('REVISION');
 return pair;
}
// The single successor claim: one compare-and-set of R.successor under the source writer.
// An identical tuple is an idempotent resume; any other recorded tuple is SUCCESSOR_ALREADY_CLAIMED.
function claimSuccessor({sourceRoot,sourceWriter,manifest,tuple,afterStep,readMetadata}){
 const pair=verifySourceForClaim({sourceRoot,sourceWriter,manifest,readMetadata}),R=pair.control.retirement;
 const same=s=>!!s&&s.restoreId===tuple.restoreId&&s.initializationDigest===tuple.initializationDigest&&s.checkpointDigest===tuple.checkpointDigest;
 if(R.successor!==null){if(same(R.successor))return{successor:R.successor,written:false};throw Object.assign(Error('SUCCESSOR_ALREADY_CLAIMED'),{code:'SUCCESSOR_ALREADY_CLAIMED'});}
 const written=require('./financial-epoch-operator').claimRetirementSuccessor({root:sourceRoot,writer:sourceWriter,expectedRevision:pair.control.generation,successor:{...tuple,claimedAtGeneration:pair.control.generation+1}});
 afterStep?.('claim:cas-durable');
 return{successor:written.retirement.successor,written:true};
}
// Addendum 1 A2.3/A2.4 and Addendum 2 D2.3 as one state machine over the claim record. `persistClaim` writes
// body.claim into the restore control; nothing here mints a target half.
function resolveSuccessor({manifest,allowance,initializationDigest,claimInput,existingClaim,persistClaim,afterStep,readMetadata}){
 const A=require('./money-continuation-authority');
 if(!manifest.sourceRetirement)return{state:'not_retiring'};
 let claim=existingClaim===undefined||existingClaim===null?null:A.validateClaim(existingClaim,{allowance,manifest,initDigest:initializationDigest});
 if(!claim&&!claimInput)return{state:'absent'};
 if(!claimInput)throw heldError('SOURCE_NOT_OFFERED');
 const tuple={restoreId:allowance.requestId,initializationDigest,checkpointDigest:manifest.checksum};
 try{
  const verified=verifySourceForClaim({sourceRoot:claimInput.sourceRoot,sourceWriter:claimInput.sourceWriter,manifest,readMetadata}),current=verified.control.retirement.successor;
  if(current!==null&&!(current.restoreId===tuple.restoreId&&current.initializationDigest===tuple.initializationDigest&&current.checkpointDigest===tuple.checkpointDigest))return{state:'refused',code:'SUCCESSOR_ALREADY_CLAIMED'};
 }catch(error){if(error.code==='SOURCE_IDENTITY_MISMATCH')return{state:'refused',code:error.code};throw error;}
 if(!claim){claim=A.validateClaim({schema:1,state:'intent',restoreId:tuple.restoreId,generationId:A.generationOf(manifest),initializationDigest,checkpointDigest:tuple.checkpointDigest,successorDigest:null},{allowance,manifest,initDigest:initializationDigest});persistClaim(claim);afterStep?.('claim:intent-durable');}
 let outcome;
 try{outcome=claimSuccessor({sourceRoot:claimInput.sourceRoot,sourceWriter:claimInput.sourceWriter,manifest,tuple,afterStep,readMetadata});}
 catch(error){if(['SUCCESSOR_ALREADY_CLAIMED','SOURCE_IDENTITY_MISMATCH'].includes(error.code))return{state:'refused',code:error.code};throw error;}
 const successorDigest=hash(outcome.successor);
 if(claim.state==='intent'){claim=A.validateClaim({...claim,state:'recorded',successorDigest},{allowance,manifest,initDigest:initializationDigest});persistClaim(claim);afterStep?.('claim:recorded-durable');}
 else if(claim.successorDigest!==successorDigest)throw Object.assign(Error('RESTORE_CLAIM_CONFLICT'),{code:'RESTORE_CLAIM_CONFLICT'});
 return{state:'claimed',claim,successorDigest,successor:outcome.successor};
}
// Addendum 2 D2.2: a restore control that carries a claim for ANOTHER restore must not be silently ignored. A copied file fails
// the physical identity check of its own slot, so it is parsed leniently here; a predecessor copied from the checkpoint archive is exempt.
function assertNoForeignClaim({files,allowance,archived}){
 for(const file of files){
  if(!fs.existsSync(file))continue;let opened,foreign;
  try{opened=readOwned(file);foreign=readRestoreControl(file,{lenient:true});}catch{continue;}
  if(foreign.restoreId!==allowance.requestId&&foreign.claim!==undefined&&!(archived[CONTROL]&&opened.digest===archived[CONTROL].digest))fail('RESTORE_CLAIM_CONFLICT');
 }
}
// The target half T. By now the single claim is recorded at the source, so a fault here is never a reason to clear or reassign it: any failure
// is RESTORE_SUCCESSOR_HELD (retryable, restore left in its phase, claim untouched). The same target resumes and mints the same record; an
// unrecoverable target stays held and is never counted as an owed completion.
function mintContinuation({manifest,targetRoot,dir,allowance,expectedBarrierDigest,epochId,claimResult}){
 const S=manifest.atomic_capacity_cut.continuationEarnings??null;
 if(!S)return null;
 try{
  const A=require('./money-continuation-authority'),entry=S.entries[0],earnings=readOwned(path.join(targetRoot,S.relativePath)),wal=readOwned(path.join(dir,require('./financial-epoch').PARTICIPANTS.wal,entry.walId+'.wal.json'));
  if(digestBytes(wal.bytes)!==entry.walFileSha256)fail('RESTORE_CONTINUATION_IDENTITY');
  return A.buildTarget({source:S,earnings,lineage:{checkpointDigest:manifest.checksum,restoreId:allowance.requestId,barrierDigest:expectedBarrierDigest,epochId,bindingDigest:allowance.bindingDigest,successorDigest:claimResult.successorDigest}});
 }catch(error){throw Object.assign(heldError(error.code||error.message),{cause:error});}
}
// A2.2: generate once, never regenerate, never adopt. An existing initialization file must authenticate completely.
function authenticateInitialization({initPath,allowance,targetRoot,targetIdentity,manifest,expectedBarrierDigest,body}){
 const quarantined=()=>fail('RESTORE_INITIALIZATION_QUARANTINED');let opened,value;
 try{opened=readOwned(initPath);const {checksum,...rest}=JSON.parse(opened.bytes);if(checksum!==hash(rest))quarantined();value=rest;}catch(error){if(error.code==='RESTORE_INITIALIZATION_QUARANTINED')throw error;quarantined();}
 if(value.schema!==1||value.restoreId!==allowance.requestId||value.target?.path!==targetRoot||value.target.dev!==targetIdentity.dev||value.target.ino!==targetIdentity.ino||value.checkpointDigest!==manifest.checksum||value.barrierDigest!==expectedBarrierDigest||value.allowanceDigest!==hash(allowance))quarantined();
 if(typeof value.successorNonce!=='string'||!HEX.test(value.successorNonce))quarantined();
 if(body&&opened.digest!==body.initializationDigest)fail('RESTORE_INITIALIZATION_CONFLICT');
 return value;
}
const successorStates=new Map();
function barrierLifted(root){
 try{const e=require('./financial-epoch'),barrier=require('./stripe-transfer-persistence').readJSONStrict(path.join(root,'money-restore-barrier.json'));return barrier.checksum===e.seal(barrier).checksum&&barrier.state==='reconciled'&&barrier.capacity_recreation_required===false;}catch{return false;}
}
// Addendum 1 A0.3/A0.4: 'none' | 'claimed' | 'unclaimed', plus the authorized recovery set RS of a claimed successor.
// Only successful reads are memoized; any read error fails closed to 'unclaimed'.
function successorState({epoch,writer,root,control,read=readCompletedRestore}){
 if(!control?.successorOf)return{status:'none',authority:null,lifted:()=>true};
 const key=[epoch.financial_dir,control.checksum,root?.restoreBinding?.planDigest||''].join('|');let hit=successorStates.get(key);
 if(!hit){
  try{
   hit={status:'unclaimed',authority:null};
   if(root?.restoreBinding){const plan=read({epoch,writer,root}).plan,claim=plan.successorClaim;if(claim&&claim.generationId===control.successorOf.generationId)hit={status:'claimed',authority:require('./money-continuation-authority').recoveryAuthoritySet(plan)};}
   if(successorStates.size>64)successorStates.clear();
   successorStates.set(key,hit);
  }catch{return{status:'unclaimed',authority:null,lifted:()=>false};}
 }
 // Activation lifts the claimed restriction only once the restore barrier is reconciled (A1.2).
 return{status:hit.status,authority:hit.authority,lifted:()=>hit.status==='claimed'&&barrierLifted(epoch.legacy_root)};
}
function successorStatus(args){return successorState(args).status;}
// For the stopped-process operator path (transitionEpoch): uses the live runtime's store when this process holds one.
function successorStatusFor({epoch,writer,control}){
 if(!control?.successorOf)return'none';
 const live=require('./money-control').getMoneyRuntime();let store=null,opened=false;
 try{
  if(live&&live.epoch.legacy_root===epoch.legacy_root)store=live.store;else{store=require('./money-control-store').openMoneyStore({epoch,writer});opened=true;}
  return successorState({epoch,writer,root:store.getCapacityRecord('capacity:root'),control}).status;
 }catch{return'unclaimed';}finally{if(opened)store.close();}
}
// v3 3.2: the consumption check behind wal.beginEarningsWrite's identity branch.
function assertRestoredContinuationIdentity({epoch,writer,root,entry,walBytes,fence,spend,actual,failure}){
 const A=require('./money-continuation-authority');let body;
 try{if(!root?.restoreBinding)throw Error('NO_RESTORE_BINDING');body=readCompletedRestore({epoch,writer,root});}catch{A.deny('NO_RESTORE_BINDING');}
 return A.verifyRestoredContinuation({body,epoch,entry,walBytes,fence,spend,actual,failure});
}
async function restoreAtomicCheckpointCapacity(input){
 const{targetRoot,writer,checkpointDir,expectedCheckpointDigest,expectedBarrierDigest,authoritativeLifecycle,executionApprovalRef,afterStep,successorClaim:claimInput}=input;
 assertMoneyWriter(writer,{root:targetRoot});
 if(claimInput!==undefined&&(!exact(claimInput,['sourceRoot','sourceWriter'])||!path.isAbsolute(claimInput.sourceRoot||'')||path.resolve(claimInput.sourceRoot)!==claimInput.sourceRoot))fail('RESTORE_CLAIM_INPUT_INVALID');const targetIdentity=fileIdentity(targetRoot,{directory:true}),allowance=validateRestoreAllowance(input),cp=require('./money-checkpoint'),e=require('./financial-epoch'),l=require('./money-lifecycle'),p=require('./stripe-transfer-persistence');
 if(!HEX.test(expectedCheckpointDigest||'')||allowance.checkpointDigest!==expectedCheckpointDigest||allowance.barrierDigest!==expectedBarrierDigest)fail('RESTORE_TRUSTED_CHECKPOINT_REQUIRED');
 const earlyBinding=e.validateBinding(p.readJSONStrict(path.join(targetRoot,e.BINDING_FILE))),earlyDir=e.confined(path.join(targetRoot,'financial-epochs',earlyBinding.identity.epoch_id),'directory'),preparedResume=exactPreparedResume({targetRoot,dir:earlyDir,allowance,expectedCheckpointDigest,expectedBarrierDigest,authoritativeLifecycle});
 let manifest=cp.validateCheckpointEnvelope(checkpointDir,{authoritativeLifecycle,...(preparedResume?{allowExpired:true}:{})});if(manifest.checksum!==expectedCheckpointDigest||!manifest.atomic_capacity_cut)fail('RESTORE_TRUSTED_CHECKPOINT_REQUIRED');
 const barrierFile=path.join(targetRoot,cp.RESTORE),barrier=p.readJSONStrict(barrierFile);if(barrier.checksum!==e.seal(barrier).checksum||barrier.state!=='reconcile_only'||barrier.checkpoint_digest!==manifest.checksum)fail('RESTORE_CAPACITY_BARRIER_CONFLICT');
 const completedRetry=barrier.capacity_recreation_required===false&&barrier.atomic_restore?.restoreId===allowance.requestId;
 if(!completedRetry&&barrier.checksum!==expectedBarrierDigest)fail('RESTORE_CAPACITY_BARRIER_CONFLICT');
 const binding=e.validateBinding(p.readJSONStrict(path.join(targetRoot,e.BINDING_FILE))),dir=e.confined(path.join(targetRoot,'financial-epochs',binding.identity.epoch_id),'directory');if(fileIdentity(dir,{directory:true}).dev!==targetIdentity.dev||fileIdentity(path.join(dir,'money-control.sqlite'),{allocated:false}).dev!==targetIdentity.dev)fail('RESTORE_FILESYSTEM_MISMATCH');
 if(preparedResume)bindPreparedManifest(preparedResume,manifest);
 if(completedRetry&&readRestoreControl(path.join(dir,CONTROL)).phase==='complete')return completedRestoreRetry({input,manifest,binding,barrier,allowance,targetIdentity});
 if(!preparedResume)manifest=cp.validateCheckpoint(checkpointDir,{authoritativeLifecycle});
 const relative=name=>path.relative(targetRoot,path.join(dir,name));
 const initFixed=path.join(dir,INITIALIZATION),initNext=path.join(dir,NEXT),controlFixed=path.join(dir,CONTROL),controlTemporary=path.join(dir,'.stage-restore-control-'+allowance.requestId);
 const archived=readArchivedControls(cp,checkpointDir,manifest,relative);
 const maintenance=Object.freeze({});maintenanceRecords.set(maintenance,{targetRoot,writer,targetIdentity,checkpointDigest:manifest.checksum,stageNames:manifest.files.map(r=>r.path).filter(n=>n.startsWith(path.relative(targetRoot,dir)+'/')&&n.endsWith('.tmp')).map(n=>path.basename(n)),ownedStages:[path.basename(controlTemporary),...['completion','publication','workspaceDeficit','workspaceScratch','engineeringReserve','engineeringPublication'].map(role=>'.stage-restore-'+role+'-'+allowance.requestId)]});
 const epoch=e.resolveRuntimeEpoch({root:targetRoot,writer,restoreAuthority:maintenance});
 const store=require('./money-control-store').openAtomicRestoreStore({epoch,writer,...(afterStep?{testFault:phase=>afterStep('sql:'+phase)}:{})});
 try{return await store.maintenanceLease(async()=>{
  let snapshot=store.readAtomicRestoreSnapshot(),root=snapshot.root,body;
  const existingControl=fs.existsSync(controlTemporary)?controlTemporary:controlFixed;
  if(fs.existsSync(existingControl)){try{const current=readRestoreControl(existingControl);if(current.restoreId===allowance.requestId)body=current;}catch(error){if(existingControl===controlTemporary)throw error;}}
  if(!body&&manifest.sourceRetirement)assertNoForeignClaim({files:[controlFixed,controlTemporary],allowance,archived});
  if(completedRetry&&body?.phase==='complete'){const prior=readCompletedRestore({epoch,writer,root});if(prior.plan.restoreId!==allowance.requestId||prior.plan.allowanceDigest!==hash(allowance))fail('RESTORE_REQUEST_CONFLICT');return{state:'reconcile_only',capacity_recreation_required:false,restore_id:allowance.requestId,sql_revision:prior.outcome.revision,barrier_digest:barrier.checksum,...successorSummary(prior.plan,manifest,refusalOutcome({plan:prior.plan,manifest,claimInput,allowance,initializationDigest:prior.initializationDigest}))};}
  if(!body){
   if(snapshot.rootDigest!==manifest.atomic_capacity_cut.capacityRootDigest||snapshot.metadata.revision!==manifest.journal_revision||snapshot.metadata.sequence!==manifest.journal_sequence||snapshot.scanStateDigest!==manifest.atomic_capacity_cut.scanStateDigest||snapshot.quoteControlDigest!==manifest.atomic_capacity_cut.quoteControlDigest)fail('RESTORE_CHECKPOINT_CUT_CHANGED');
   for(const row of manifest.files){if(row.path===cp.RESTORE||row.path===relative(e.CONTROL_FILE))continue;const actual=readOwned(path.join(targetRoot,row.path));if(actual.identity.dev!==targetIdentity.dev)fail('RESTORE_FILESYSTEM_MISMATCH');if(actual.bytes.length!==row.bytes||actual.digest!==row.sha256)fail('RESTORE_TARGET_CHANGED');}
  }
  if(root.profileDigest!==allowance.profileDigest||epoch.binding_digest!==allowance.bindingDigest||snapshot.metadata.database_schema!==3||root.profile.workspace?.schema!==2||root.activeAllowance||root.state!=='ready')fail('RESTORE_PLAN_INVALID');
  const workspace=require('./money-workspace'),capacity=require('./money-capacity'),priorWorkspace=workspace.decodeRestoreControl({bytes:archived[workspace.CONTROL].bytes,epoch,profile:root.profile.workspace,expectedDigest:archived[workspace.CONTROL].digest}),priorCapacity=decodeCapacityControl({bytes:archived[capacity.CONTROL_FILE].bytes,epoch,root:body?.priorRoot||root,expectedDigest:archived[capacity.CONTROL_FILE].digest});
  if(hash(priorWorkspace)!==manifest.atomic_capacity_cut.workspaceControlDigest||hash(priorCapacity)!==manifest.atomic_capacity_cut.capacityControlDigest||hash(priorWorkspace.lastCompleted||null)!==manifest.atomic_capacity_cut.jointCompletionDigest)fail('RESTORE_CHECKPOINT_CUT_CHANGED');
  const originalGeometry=body?.plan?.priorGeometry||workspace.geometry(root.profile.workspace,snapshot.metrics);
  const names={completion:capacity.RESERVE_FILE,publication:capacity.PUBLICATION_FILE,workspaceDeficit:workspace.PADDING,workspaceScratch:workspace.SCRATCH,engineeringReserve:ENGINEERING,engineeringPublication:PUBLICATION};
  const extents={completion:root.availableBytes,publication:root.profile.publicationBytes,workspaceDeficit:originalGeometry.P,workspaceScratch:originalGeometry.R,engineeringReserve:allowance.permanentBoundBytes,engineeringPublication:allowance.publicationBoundBytes};
  const predecessor=archived[CONTROL]||archived[INITIALIZATION];if(predecessor&&(!archived[CONTROL]||!archived[INITIALIZATION]))fail('RESTORE_PREDECESSOR_INVALID');
  const priorOutputAllocation=body?.priorOutputAllocation||{control:predecessor?fileIdentity(controlFixed,{allocated:false}).allocatedBytes:0,initialization:predecessor?fileIdentity(initFixed,{allocated:false}).allocatedBytes:0,barrier:fileIdentity(barrierFile,{allocated:false}).allocatedBytes};
  const initPath=predecessor?initNext:initFixed;
  // A2.2: a restore from a retiring checkpoint carries a durable single-use nonce. Ordinary restores build the same bytes as before.
  let successorNonce=null,nonceCreated=false;
  if(manifest.sourceRetirement){if(fs.existsSync(initPath))successorNonce=authenticateInitialization({initPath,allowance,targetRoot,targetIdentity,manifest,expectedBarrierDigest,body}).successorNonce;else{successorNonce=crypto.randomBytes(32).toString('hex');nonceCreated=true;}}
  const init={schema:1,restoreId:allowance.requestId,target:{path:targetRoot,dev:targetIdentity.dev,ino:targetIdentity.ino},checkpointDigest:manifest.checksum,barrierDigest:expectedBarrierDigest,allowanceDigest:hash(allowance),predecessor:predecessor?{controlDigest:archived[CONTROL].digest,initializationDigest:archived[INITIALIZATION].digest}:null,roles:Object.entries(names).map(([role,name])=>({role,name,temporary:'.stage-restore-'+role+'-'+allowance.requestId,bytes:extents[role]})),controlTemporary:path.basename(controlTemporary),...(successorNonce?{successorNonce}:{})};
  const initBytes=Buffer.from(canonicalJSON({...init,checksum:hash(init)})+'\n'),initializationDigest=digestBytes(initBytes);
  if(!body){
   if(predecessor){const old=readRestoreControl(controlFixed,{copiedDigest:archived[CONTROL].digest});if(old.phase!=='complete'||readOwned(controlFixed).digest!==archived[CONTROL].digest||readOwned(initFixed).digest!==archived[INITIALIZATION].digest||old.plan.planDigest!==root.restoreBinding?.planDigest)fail('RESTORE_PREDECESSOR_INVALID');}
   if(fs.existsSync(initPath)){if(!readOwned(initPath).bytes.equals(initBytes))fail('RESTORE_INITIALIZATION_QUARANTINED');}else{const fd=fs.openSync(initPath,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,initBytes);afterStep?.('initialization:written');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDir(dir);}const initializationFd=fs.openSync(initPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(initializationFd);}finally{fs.closeSync(initializationFd);}syncDir(dir);afterStep?.('initialization:durable');if(nonceCreated)afterStep?.('nonce:written');
   const control=allocateOwned(controlTemporary,SLOT*2);body={schema:1,protocol:'atomic_restore_v1',sequence:0,restoreId:allowance.requestId,phase:'initializing',control,initializationDigest,roles:{},plan:null,outcome:null,priorRoot:root,priorOutputAllocation};writeExisting(controlTemporary,encodeControl(body),control);afterStep?.('control:initialized');
  }else{const actual=fs.existsSync(initNext)?readOwned(initNext):readOwned(initFixed);if(actual.digest!==body.initializationDigest||body.initializationDigest!==initializationDigest)fail('RESTORE_INITIALIZATION_CONFLICT');}
  let controlFile=fs.existsSync(controlTemporary)?controlTemporary:controlFixed;
  const persist=next=>{body=persistControl(controlFile,{...body,...next});return body;};
  for(const row of init.roles){
   maintenanceRecords.get(maintenance).ownedStages.push(row.temporary);const final=path.join(dir,row.name),temp=path.join(dir,row.temporary);let r=body.roles[row.role];
   if(!r){if(fs.existsSync(final)||fs.existsSync(temp))fail('RESTORE_ALLOCATION_QUARANTINED');const physical=allocateOwned(temp,row.bytes);afterStep?.('allocation:'+row.role);r={...physical,relativePath:row.name,temporary:row.temporary};persist({roles:{...body.roles,[row.role]:r}});}
   if(fs.existsSync(temp)){fileIdentity(temp,{bytes:r.bytes,identity:r});if(fs.existsSync(final))fail('RESTORE_ALLOCATION_CONFLICT');fs.renameSync(temp,final);syncDir(dir);afterStep?.('allocation-published:'+row.role);}else fileIdentity(final,{identity:r,allocated:body.phase==='initializing',...(body.phase==='initializing'?{bytes:r.bytes}:{})});
  }
  let successorOutcome=null;
  if(body.phase==='initializing'){
   const role=(name,file)=>({...fileIdentity(path.join(dir,file)),relativePath:file});
   const roles={...body.roles,publicationControl:role('publicationControl',capacity.CONTROL_FILE),workspaceControl:role('workspaceControl',workspace.CONTROL),first_failure_control:{...role('first_failure_control',require('./money-failure-control').FILE),sha256:readOwned(path.join(dir,require('./money-failure-control').FILE)).digest},restoreControl:{...body.control,relativePath:CONTROL},initialization:{...fileIdentity(initPath),relativePath:INITIALIZATION}};
   const compensationEarnings=manifest.atomic_capacity_cut.compensationEarnings||null;
   if(compensationEarnings){const earnings=readOwned(path.join(targetRoot,compensationEarnings.relativePath));if(earnings.digest!==compensationEarnings.sha256||earnings.bytes.length!==compensationEarnings.bytes)fail('RESTORE_COMPENSATION_IDENTITY');roles.compensation_earnings={...earnings.identity,relativePath:path.relative(dir,path.join(targetRoot,compensationEarnings.relativePath)),sha256:earnings.digest,entryDigest:hash(compensationEarnings)};}
   // A2 (v3 8.3-8.4, Addendum 1 A2, Addendum 2 D2): claim the single successor slot at the source, then mint the target half.
   const A=require('./money-continuation-authority');
   const claimResult=resolveSuccessor({manifest,allowance,initializationDigest,claimInput,existingClaim:body.claim,persistClaim:claim=>{A.validateClaimTransition(body.claim??null,claim);persist({claim});},afterStep});
   successorOutcome=claimResult;
   let continuationEarnings=null,continuationWithheld=null,successorClaimFact=null;
   if(claimResult.state==='not_retiring')continuationWithheld='NOT_RETIRING';
   else if(claimResult.state==='absent')continuationWithheld='SUCCESSOR_ABSENT';
   else if(claimResult.state==='refused')continuationWithheld='SUCCESSOR_REFUSED';
   else{
    successorClaimFact=A.validateSuccessorClaim({generationId:claimResult.claim.generationId,restoreId:allowance.requestId,initializationDigest,successorDigest:claimResult.successorDigest});
    const minted=mintContinuation({manifest,targetRoot,dir,allowance,expectedBarrierDigest,epochId:epoch.epoch_id,claimResult});
    if(minted){continuationEarnings=minted.target;roles.continuation_earnings=minted.role;afterStep?.('continuation:minted');}
   }
   const encodedFinalBarrier=Buffer.from(canonicalJSON(e.seal({...barrier,capacity_recreation_required:false,atomic_restore:{restoreId:allowance.requestId,receiptDigest:'0'.repeat(64),sql_revision:snapshot.metadata.revision+1,execution_approval_ref:executionApprovalRef}}))+'\n'),allocationUnit=fs.statfsSync(targetRoot).bsize;if(!Number.isSafeInteger(allocationUnit)||allocationUnit<512||allocationUnit%512!==0)fail('RESTORE_PUBLICATION_GEOMETRY_UNSUPPORTED');const publicationGeometry={allocationUnit,priorTargetAllocatedBytes:priorOutputAllocation.barrier,expectedTargetAllocatedBytes:Math.ceil(encodedFinalBarrier.length/allocationUnit)*allocationUnit,maximumTemporaryBytes:encodedFinalBarrier.length};
   const retainedNonDatabaseOutputBytes=Math.max(0,body.control.allocatedBytes-priorOutputAllocation.control)+Math.max(0,roles.initialization.allocatedBytes-priorOutputAllocation.initialization)+Math.max(0,publicationGeometry.expectedTargetAllocatedBytes-priorOutputAllocation.barrier);
   if(Object.values(roles).some(role=>role.dev!==targetIdentity.dev))fail('RESTORE_FILESYSTEM_MISMATCH');
   const plan={schema:1,protocol:'atomic_restore_v1',restoreId:allowance.requestId,checkpointDigest:manifest.checksum,barrierDigest:expectedBarrierDigest,lifecycleDigest:hash(authoritativeLifecycle),profileDigest:root.profileDigest,databaseSchema:3,workspaceSchema:2,priorRevision:snapshot.metadata.revision,priorSequence:snapshot.metadata.sequence,priorRootDigest:snapshot.rootDigest,priorRestoreGeneration:root.restoreGeneration===undefined?0:root.restoreGeneration,previousBindingDigest:hash(root.restoreBinding||null),priorJointCompletionDigest:manifest.atomic_capacity_cut.jointCompletionDigest,capacityControlDigest:hash(priorCapacity),workspaceControlDigest:hash(priorWorkspace),quoteControlDigest:snapshot.quoteControlDigest,leaseStateDigest:manifest.atomic_capacity_cut.leaseStateDigest,scanStateDigest:snapshot.scanStateDigest,financialStateDigest:snapshot.financialStateDigest,metadataIdentityDigest:snapshot.metadataIdentityDigest,rootEconomicDigest:snapshot.rootEconomicDigest,allowanceDigest:hash(allowance),allowanceBoundBytes:allowance.permanentBoundBytes,publicationBoundBytes:allowance.publicationBoundBytes,maxGrowthPages:allowance.maxGrowthPages,maxNetOccupiedPages:allowance.maxNetOccupiedPages,retainedNonDatabaseOutputBytes,priorOutputAllocation,publicationGeometry,rolePlanDigest:hash(roles),roles,priorMetrics:snapshot.metrics,priorGeometry:originalGeometry,compensationEarnings,continuationEarnings,continuationWithheld,successorClaim:successorClaimFact};plan.planDigest=hash(plan);persist({phase:'prepared',plan,databaseId:snapshot.metadata.database_id});afterStep?.('intent:prepared');
  }
  const plan=completePlan(body.plan);if(plan.allowanceDigest!==hash(allowance)||plan.lifecycleDigest!==hash(authoritativeLifecycle))fail('RESTORE_REQUEST_CONFLICT');
  if(controlFile!==controlFixed){if(fs.existsSync(controlFixed)&&readOwned(controlFixed).digest!==archived[CONTROL]?.digest)fail('RESTORE_PREDECESSOR_INVALID');fs.renameSync(controlFile,controlFixed);syncDir(dir);controlFile=controlFixed;afterStep?.('restore-control:published');}
  if(fs.existsSync(initNext)){if(readOwned(initFixed).digest!==archived[INITIALIZATION]?.digest)fail('RESTORE_PREDECESSOR_INVALID');fs.renameSync(initNext,initFixed);syncDir(dir);afterStep?.('initialization:published');}
  const temporaryDirectory=require('./money-sqlite-temp').ensureMoneySqliteTemp({epoch,writer}),native=store.createRollbackInspector({tempDirectory:temporaryDirectory,quota:root.profile.grouped.sqlite});
  const authority=Object.freeze({}),physicalProof={releasedScratchBytes:0,rollbackProofDigest:root.profile.grouped.sqlite.rollbackProofDigest};
  const record={store,epoch,writer,plan,temporaryDirectory,physicalProof,verify(phase){if(hash(authoritativeLifecycle)!==plan.lifecycleDigest)fail('RESTORE_LIFECYCLE_CHANGED');if(['released','precommit'].includes(phase)&&p.readJSONStrict(barrierFile).checksum!==plan.barrierDigest)fail('RESTORE_CAPACITY_BARRIER_CONFLICT');const current=readRestoreControl(controlFixed);if(current.restoreId!==plan.restoreId||current.plan.planDigest!==plan.planDigest||hash(current.plan)!==hash(plan)||readOwned(initFixed).digest!==initializationDigest)fail('RESTORE_AUTHORITY_CHANGED');fileIdentity(targetRoot,{directory:true,identity:targetIdentity});if(fileIdentity(dir,{directory:true}).dev!==targetIdentity.dev||fileIdentity(store.file,{allocated:false}).dev!==targetIdentity.dev||Object.values(plan.roles).some(role=>role.dev!==targetIdentity.dev))fail('RESTORE_FILESYSTEM_MISMATCH');for(const name of ['completion','publication','publicationControl','workspaceControl','first_failure_control']){const r=plan.roles[name];fileIdentity(path.join(dir,r.relativePath),{bytes:r.bytes,identity:r});}if(readOwned(path.join(dir,require('./money-failure-control').FILE),plan.roles.first_failure_control).digest!==plan.roles.first_failure_control.sha256)fail('RESTORE_FAILURE_CONTROL_CHANGED');const proof=native(phase==='precommit'?{phase:'beforeCommit'}:{});if(proof.rollbackProofDigest!==physicalProof.rollbackProofDigest)fail('RESTORE_ROLLBACK_PROOF_REQUIRED');if(['released','precommit'].includes(phase)){fileIdentity(path.join(dir,workspace.SCRATCH),{bytes:0,identity:plan.roles.workspaceScratch});fileIdentity(path.join(dir,ENGINEERING),{bytes:0,identity:plan.roles.engineeringReserve});physicalProof.releasedScratchBytes=plan.priorGeometry.R;}else physicalProof.releasedScratchBytes=body.phase==='released'?plan.priorGeometry.R:0;}};authorityRecords.set(authority,record);
  let outcome=store.verifyAtomicRestoreOutcome(authority);
  if(outcome.state==='conflict')fail('RESTORE_SQL_CONFLICT');
  if(outcome.state==='prior'){
   if(hash(authoritativeLifecycle)!==plan.lifecycleDigest)fail('RESTORE_LIFECYCLE_CHANGED');cp.validateRestoreAuthority(manifest,authoritativeLifecycle);native();if(body.phase!=='prepared'&&body.phase!=='released')fail('RESTORE_SQL_CONFLICT');
   persist({phase:'released'});afterStep?.('allowance:intent');resizeOwned(path.join(dir,ENGINEERING),0,plan.roles.engineeringReserve);afterStep?.('allowance:released');resizeOwned(path.join(dir,workspace.SCRATCH),0,plan.roles.workspaceScratch);physicalProof.releasedScratchBytes=plan.priorGeometry.R;afterStep?.('scratch:released');
   try{outcome=store.commitAtomicRestoreBinding(authority);}catch(error){const durable=store.verifyAtomicRestoreOutcome(authority);if(durable.state==='prior'){resizeOwned(path.join(dir,ENGINEERING),plan.allowanceBoundBytes,plan.roles.engineeringReserve);resizeOwned(path.join(dir,workspace.SCRATCH),plan.priorGeometry.R,plan.roles.workspaceScratch);persist({phase:'prepared'});}throw error;}
  }
  if(outcome.state!=='committed')fail('RESTORE_SQL_CONFLICT');persist({phase:'sql_committed',outcome});afterStep?.('sql:committed');
  const finalGeometry=workspace.geometry(root.profile.workspace,outcome.metrics);resizeOwned(path.join(dir,workspace.PADDING),finalGeometry.P,plan.roles.workspaceDeficit,{maximum:Math.max(plan.roles.workspaceDeficit.bytes,finalGeometry.P)});resizeOwned(path.join(dir,workspace.SCRATCH),plan.priorGeometry.R,plan.roles.workspaceScratch);resizeOwned(path.join(dir,ENGINEERING),plan.allowanceBoundBytes-Number(outcome.restoreBinding.consumedBytes),plan.roles.engineeringReserve);afterStep?.('padding:refilled');
  const successor=workspace.encodeRestoredWorkspace({authority,store,epoch,writer,priorState:priorWorkspace,outcome});writeExisting(path.join(dir,workspace.CONTROL),successor.bytes,plan.roles.workspaceControl,{offset:successor.offset});persist({phase:'workspace_published'});afterStep?.('workspace:published');
  const finalRoot=store.getCapacityRecord('capacity:root');capacity.atomicIO.writeControl(epoch,finalRoot,{...priorCapacity,state:'idle',generation:priorCapacity.generation+1,preparedGeneration:root.publicationGeneration,allowanceId:null,lastCompleted:successor.completion});persist({phase:'capacity_published'});afterStep?.('capacity:published');
  verifyFinalPhysicalCut({epoch,writer,store,body,expectedOutcome:outcome,expectedCompletion:successor.completion,publicationBytes:body.publication?(()=>{const size=fileIdentity(path.join(dir,PUBLICATION),{identity:plan.roles.engineeringPublication,allocated:false}).bytes;if(![body.publication.priorOSize,body.publication.nextOSize].includes(size))fail('RESTORE_PUBLICATION_CONFLICT');return size;})():undefined});
  const now=p.readJSONStrict(barrierFile);if(hash(authoritativeLifecycle)!==plan.lifecycleDigest)fail('RESTORE_LIFECYCLE_CHANGED');cp.validateRestoreAuthority(manifest,authoritativeLifecycle);
  const next=e.seal({...barrier,capacity_recreation_required:false,atomic_restore:{restoreId:plan.restoreId,receiptDigest:outcome.receiptDigest,sql_revision:outcome.revision,execution_approval_ref:executionApprovalRef}}),bytes=Buffer.from(canonicalJSON(next)+'\n'),nextDigest=digestBytes(bytes),K=Math.ceil(plan.publicationGeometry.expectedTargetAllocatedBytes/4096)*4096,temp=path.join(targetRoot,'.stage-atomic-restore-barrier-'+plan.restoreId),o=plan.roles.engineeringPublication;
  if(K>o.bytes||K!==Math.ceil(plan.publicationGeometry.expectedTargetAllocatedBytes/4096)*4096||bytes.length!==plan.publicationGeometry.maximumTemporaryBytes)fail('RESTORE_PUBLICATION_BOUND_REQUIRED');
  if(!body.publication){if(now.checksum!==expectedBarrierDigest)fail('RESTORE_CAPACITY_BARRIER_CONFLICT');persist({publication:{role:'barrier',priorTargetDigest:digestBytes(fs.readFileSync(barrierFile)),nextTargetDigest:nextDigest,temporaryBasename:path.basename(temp),maximumTemporaryBytes:bytes.length,K,priorOSize:o.bytes,nextOSize:o.bytes-K,temporaryIdentity:null}});}
  const publication=body.publication;if(publication.role!=='barrier'||publication.nextTargetDigest!==nextDigest||publication.temporaryBasename!==path.basename(temp)||publication.maximumTemporaryBytes!==bytes.length||publication.K!==K||publication.priorOSize!==o.bytes||publication.nextOSize!==o.bytes-K)fail('RESTORE_PUBLICATION_CONFLICT');
  const currentDigest=digestBytes(fs.readFileSync(barrierFile));
  if(currentDigest!==nextDigest){
   if(currentDigest!==publication.priorTargetDigest||now.checksum!==expectedBarrierDigest)fail('RESTORE_CAPACITY_BARRIER_CONFLICT');
   const op=fileIdentity(path.join(dir,PUBLICATION),{identity:o,allocated:false});if(![o.bytes,o.bytes-K].includes(op.bytes))fail('RESTORE_PUBLICATION_CONFLICT');resizeOwned(path.join(dir,PUBLICATION),o.bytes-K,o,{minimum:o.bytes-K,maximum:o.bytes});afterStep?.('publication:released');
   if(!publication.temporaryIdentity){if(fs.existsSync(temp))fail('RESTORE_PUBLICATION_QUARANTINED');const fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDir(targetRoot);persist({publication:{...publication,temporaryIdentity:fileIdentity(temp)}});afterStep?.('publication:temporary-owned');}
   const identity=body.publication.temporaryIdentity,physical=fileIdentity(temp,{identity,allocated:false});if(physical.bytes>bytes.length)fail('RESTORE_PUBLICATION_CONFLICT');
   const fd=fs.openSync(temp,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(st.dev!==identity.dev||st.ino!==identity.ino)fail('RESTORE_PHYSICAL_IDENTITY');let at=0;while(at<bytes.length){const n=fs.writeSync(fd,bytes,at,bytes.length-at,at);if(!n)fail('RESTORE_SHORT_WRITE');at+=n;}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(fileIdentity(temp,{identity,bytes:bytes.length}).allocatedBytes!==plan.publicationGeometry.expectedTargetAllocatedBytes||readOwned(temp,identity).digest!==nextDigest)fail('RESTORE_PUBLICATION_BOUND_REQUIRED');afterStep?.('publication:temporary-durable');
   verifyFinalPhysicalCut({epoch,writer,store,body,expectedOutcome:outcome,expectedCompletion:successor.completion,publicationBytes:o.bytes-K});
   if(digestBytes(fs.readFileSync(barrierFile))!==publication.priorTargetDigest||hash(authoritativeLifecycle)!==plan.lifecycleDigest)fail('RESTORE_CAPACITY_BARRIER_CONFLICT');fs.renameSync(temp,barrierFile);syncDir(targetRoot);afterStep?.('barrier:published');
  }else if(fs.existsSync(temp))fail('RESTORE_PUBLICATION_CONFLICT');
  resizeOwned(path.join(dir,PUBLICATION),o.bytes,o,{minimum:o.bytes-K,maximum:o.bytes});verifyFinalPhysicalCut({epoch,writer,store,body,expectedOutcome:outcome,expectedCompletion:successor.completion});persist({phase:'complete',publication:null});afterStep?.('restore:complete');e.invalidateEpochRuntime(targetRoot);
  readCompletedRestore({epoch,writer,root:finalRoot});return{state:'reconcile_only',capacity_recreation_required:false,restore_id:plan.restoreId,sql_revision:outcome.revision,barrier_digest:next.checksum,...successorSummary(plan,manifest,successorOutcome)};
 });}finally{store.close();maintenanceRecords.delete(maintenance);}
}
module.exports.restoreAtomicCheckpointCapacity=restoreAtomicCheckpointCapacity;
module.exports.resolveRestoredRole=resolveRestoredRole;
module.exports.assertRestoredEarningsIdentity=assertRestoredEarningsIdentity;
Object.assign(module.exports,{mintContinuation,auditCompletedClaim,refusalOutcome,successorSummary,assertNoForeignClaim,encodeControl,assertRestoredContinuationIdentity,successorStatus,successorState,successorStatusFor,barrierLifted,verifySourceForClaim,claimSuccessor,resolveSuccessor,readCompletedRestore,authenticateInitialization});
