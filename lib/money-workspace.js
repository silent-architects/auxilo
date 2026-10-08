'use strict';
const fs=require('node:fs'),path=require('node:path');
const {digestJSON:hash}=require('./stripe-transfer-persistence');
const {fail,safe,syncDirectory}=require('./money-database');
const PADDING='money-workspace-deficit.bin',SCRATCH='money-workspace-scratch.bin',CONTROL='money-workspace-control.bin',INIT_MANIFEST='money-workspace-initialization.json',SLOT=65536;
const {validateWorkspaceProfile:profile,validateWorkspacePartitions}=require('./money-workspace-layout');
function owner(epoch,writer){require('./money-writer-lock').assertMoneyWriter(writer,{root:epoch.legacy_root});writer.assertOwned();}
function proof(file,bytes,identity){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size!==bytes||s.blocks*512<bytes||identity&&(s.dev!==identity.dev||s.ino!==identity.ino))throw fail('WORKSPACE_PHYSICAL_MISMATCH');return{dev:s.dev,ino:s.ino,bytes:s.size,allocatedBytes:s.blocks*512,nlink:s.nlink};}
function fill(file,bytes,identity,{create=false,minimum,maximum}={}){if(!Number.isSafeInteger(bytes)||bytes<0)throw fail('WORKSPACE_BOUND_INVALID');const fd=fs.openSync(file,create?'wx':'r+',0o600);try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||identity&&(s.dev!==identity.dev||s.ino!==identity.ino))throw fail('WORKSPACE_PHYSICAL_MISMATCH');if(identity&&(s.size<(minimum??Math.min(identity.bytes,bytes))||s.size>(maximum??Math.max(identity.bytes,bytes))))throw fail('WORKSPACE_PHYSICAL_MISMATCH');if(bytes<s.size)fs.ftruncateSync(fd,bytes);else{const b=Buffer.alloc(Math.min(bytes||1,1048576));for(let offset=s.size;offset<bytes;){const n=fs.writeSync(fd,b,0,Math.min(bytes-offset,b.length),offset);if(!n)throw fail('WORKSPACE_SHORT_ALLOCATION');offset+=n;}}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return proof(file,bytes,identity);}
function geometry(p,m){profile(p);for(const k of ['pageSize','pageCount','freelistCount','workspaceAllocatedBytes','allocatedBytes','fileBytes','revision'])if(!Number.isSafeInteger(m?.[k])||m[k]<0)throw fail('WORKSPACE_METRICS_INVALID');if(!m.pageSize||m.freelistCount>m.pageCount||m.workspaceAllocatedBytes%m.pageSize||m.workspaceAllocatedBytes>m.fileBytes||m.fileBytes!==safe(BigInt(m.pageCount)*BigInt(m.pageSize))||m.allocatedBytes<m.fileBytes||m.workspaceSchemaVerified!==true)throw fail('WORKSPACE_METRICS_INVALID');validateWorkspacePartitions(p,m);const A=m.workspaceAllocatedBytes,W=p.workspaceRetainedBytes;if(A>W)throw fail('WORKSPACE_RETAINED_LIMIT');const F=Math.min(W-A,safe(BigInt(m.freelistCount)*BigInt(m.pageSize)));return{A,F,P:W-A-F,R:p.workspaceScratchBytes};}
function read(epoch,p){if(fs.existsSync(path.join(epoch.financial_dir,INIT_MANIFEST)))throw fail('WORKSPACE_INITIALIZATION_QUARANTINED');const f=path.join(epoch.financial_dir,CONTROL);proof(f,SLOT*2);const b=fs.readFileSync(f),rows=[];for(let i=0;i<2;i++)try{const z=b.subarray(i*SLOT,(i+1)*SLOT),end=z.indexOf(0),x=JSON.parse(z.subarray(0,end<0?z.length:end).toString()),{checksum,...body}=x;if(hash(body)!==checksum||body.epoch_id!==epoch.epoch_id||body.binding_digest!==epoch.binding_digest||body.profileDigest!==hash(p)||!Number.isSafeInteger(body.sequence)||body.sequence<0)continue;rows.push(body);}catch{}if(!rows.length)throw fail('WORKSPACE_CONTROL_INVALID');rows.sort((a,b)=>b.sequence-a.sequence);if(rows[1]?.sequence===rows[0].sequence&&hash(rows[1])!==hash(rows[0]))throw fail('WORKSPACE_CONTROL_AMBIGUOUS');proof(f,SLOT*2,rows[0].control);return rows[0];}
function write(epoch,p,state){const body={...state,epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,profileDigest:hash(p)},encoded=Buffer.from(JSON.stringify({...body,checksum:hash(body)}));if(encoded.length>=SLOT)throw fail('WORKSPACE_CONTROL_LIMIT');const b=Buffer.alloc(SLOT);encoded.copy(b);const f=path.join(epoch.financial_dir,CONTROL);proof(f,SLOT*2,state.control);const fd=fs.openSync(f,'r+');try{if(fs.writeSync(fd,b,0,b.length,(body.sequence%2)*SLOT)!==b.length)throw fail('WORKSPACE_SHORT_WRITE');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return body;}
async function initializeWorkspaceCapacity({epoch,writer,store,profile:p}){owner(epoch,writer);profile(p);return store.maintenanceLease(()=>{const m=store.readWorkspaceMetrics(),g=geometry(p,m),control=path.join(epoch.financial_dir,CONTROL);if(fs.existsSync(path.join(epoch.financial_dir,INIT_MANIFEST)))throw fail('WORKSPACE_INITIALIZATION_QUARANTINED');if(fs.existsSync(control))throw fail('WORKSPACE_ALREADY_INITIALIZED');const manifest=path.join(epoch.financial_dir,INIT_MANIFEST),fd=fs.openSync(manifest,'wx',0o600);try{const body=Buffer.from(JSON.stringify({schema:1,state:'preparing',epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,profileDigest:hash(p),files:[PADDING,SCRATCH,CONTROL]}));if(fs.writeSync(fd,body)!==body.length)throw fail('WORKSPACE_SHORT_WRITE');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory(epoch.financial_dir);const padding=fill(path.join(epoch.financial_dir,PADDING),g.P,null,{create:true}),scratch=fill(path.join(epoch.financial_dir,SCRATCH),g.R,null,{create:true}),controlProof=fill(control,SLOT*2,null,{create:true});syncDirectory(epoch.financial_dir);const initial=write(epoch,p,{sequence:0,state:'idle',padding,scratch,control:controlProof,metrics:m,geometry:g,leases:{},intent:null});fs.unlinkSync(manifest);syncDirectory(epoch.financial_dir);return initial;});}
function createWorkspaceManager({epoch,writer,store,getProfile,getRollbackProof,getCapacityPeer,allocationMode='zero-fill'}){
 require('./money-scratch-allocation').assertAllocationMode(allocationMode);
 const p=profile(getProfile());const load=()=>{owner(epoch,writer);return read(epoch,p);};
 function persist(s){s.sequence++;return write(epoch,p,s);}
 function check(s,{allowPeerActive=false}={}){if(!allowPeerActive)assertPeerIdle(s);if(s.state!=='idle'||s.intent)throw fail('WORKSPACE_RECOVERY_REQUIRED');const m=store.readWorkspaceMetrics(),g=geometry(p,m);proof(path.join(epoch.financial_dir,PADDING),s.padding.bytes,s.padding);proof(path.join(epoch.financial_dir,SCRATCH),g.R,s.scratch);if(g.A+g.F+s.padding.bytes<p.workspaceRetainedBytes||m.revision!==s.metrics.revision)throw fail('WORKSPACE_ACCOUNTING_MISMATCH');return{m,g};}
 function capacityPeer(){if(typeof getCapacityPeer!=='function')throw fail('WORKSPACE_ATOMIC_PEER_REQUIRED');const peer=getCapacityPeer();if(!peer||peer.then)throw fail('WORKSPACE_ATOMIC_PEER_REQUIRED');return peer;}
 function assertPeerIdle(s){if(!getCapacityPeer)return;const peer=capacityPeer();if(peer.state!=='idle'||hash(peer.lastCompleted||null)!==hash(s.lastCompleted||null))throw fail('WORKSPACE_ATOMIC_PEER_PENDING');}
 function inspectAtomicPeer(){const s=load();return{sequence:s.sequence,controlDigest:hash(s),state:s.state,metrics:structuredClone(s.metrics),geometry:structuredClone(s.geometry),intent:structuredClone(s.intent),lastCompleted:structuredClone(s.lastCompleted||null)};}
 function assertAtomicPeer(a){const peer=capacityPeer();if(peer.state!=='active'||peer.protocol!==a.protocol||peer.groupId!==a.groupId||peer.capacityIntentChecksum!==a.capacityIntentChecksum||peer.workspaceIntentCoreDigest!==a.workspaceIntentCoreDigest||peer.priorWorkspaceSequence!==a.priorPeerSequence||peer.priorWorkspaceControlDigest!==a.priorPeerControlDigest)throw fail('WORKSPACE_ATOMIC_PEER_MISMATCH');}
 function atomicIntent(input,s,g,release,{requireActivePeer=true}={}){
  const a=input.atomic;if(!a)return;
  const c=a.workspaceIntentCore,hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),number=v=>Number.isSafeInteger(v)&&v>=0;
  if(a.protocol!=='single_sql_v1'||!input.sqliteQuota||!c||![1,2].includes(c.schema)||c.protocol!==a.protocol||hash(c)!==a.workspaceIntentCoreDigest)throw fail('WORKSPACE_ATOMIC_INTENT_INVALID');
  for(const k of ['groupId','semanticIntentDigest','groupPlanDigest','fullWriteSetDigest','priorRootDigest','nextRootDigest'])if(!hex(a[k])||c[k]!==a[k])throw fail('WORKSPACE_ATOMIC_INTENT_INVALID');
  if(!hex(a.capacityIntentChecksum)||!hex(c.priorCapacityControlHash)||!number(c.priorCapacityControlGeneration)||input.id!==a.groupId||input.ownerPlanDigest!==a.groupPlanDigest||c.priorRevision!==input.priorRevision||c.finalRevision!==input.priorRevision+1||c.priorWorkspaceControlGeneration!==s.sequence||c.priorWorkspaceControlHash!==hash(s)||a.priorPeerSequence!==s.sequence||a.priorPeerControlDigest!==hash(s)||c.priorPaddingBytes!==s.padding.bytes||c.priorScratchBytes!==g.R||c.releasePaddingBytes!==release||c.sqliteQuotaDigest!==hash(input.sqliteQuota))throw fail('WORKSPACE_ATOMIC_INTENT_INVALID');
  for(const n of [c.completionBeforeBytes,c.completionAfterBytes,a.completionDebitBytes,a.retainedNonDatabaseOutputBytes])if(!number(n)||n%4096)throw fail('WORKSPACE_ATOMIC_INTENT_INVALID');
  if(c.completionBeforeBytes-c.completionAfterBytes!==a.completionDebitBytes)throw fail('WORKSPACE_ATOMIC_INTENT_INVALID');
  if(c.schema===2){
   const o=c.operational;
   if(p.schema!==2||c.workspace!==undefined||!o||Object.keys(o).sort().join(',')!=='boundBytes,generation,kind,quoteChangesDigest'||o.kind!=='quotes'||!number(o.generation)||o.generation<1||!hex(o.quoteChangesDigest)||!number(o.boundBytes)||o.boundBytes<4096||o.boundBytes%4096||!input.operational||hash(input.operational)!==hash(o)||input.scopeKey!==undefined||input.generation!==undefined||o.boundBytes!==(input.workspaceBoundBytes||input.boundBytes)||input.boundBytes!==o.boundBytes+a.completionDebitBytes||input.kind!==(a.completionDebitBytes?'mixed':'workspace')||input.kind==='mixed'&&input.permanentBoundBytes!==a.completionDebitBytes||a.retainedNonDatabaseOutputBytes!==0)throw fail('WORKSPACE_ATOMIC_INTENT_INVALID');
   if(input.kind==='workspace'&&(c.transient!==true||c.priorRootDigest!==c.nextRootDigest||c.completionBeforeBytes!==c.completionAfterBytes)||input.kind==='mixed'&&c.transient===true)throw fail('WORKSPACE_ATOMIC_INTENT_INVALID');
  }else if(c.operational!==undefined||input.operational!==undefined)throw fail('WORKSPACE_ATOMIC_INTENT_INVALID');
  else if(input.kind==='permanent'){if(c.workspace!==undefined)throw fail('WORKSPACE_ATOMIC_INTENT_INVALID');}else{const w=c.workspace;if(!w||Object.keys(w).sort().join(',')!=='boundBytes,generation,scopeKey'||typeof w.scopeKey!=='string'||!w.scopeKey||w.scopeKey.length>512||!Number.isSafeInteger(w.generation)||w.generation<1||!number(w.boundBytes)||w.boundBytes<4096||w.boundBytes%4096||w.scopeKey!==input.scopeKey||w.generation!==input.generation||w.boundBytes!==(input.workspaceBoundBytes||input.boundBytes)||input.boundBytes!==w.boundBytes+a.completionDebitBytes||input.kind!==(a.completionDebitBytes?'mixed':'workspace')||input.kind==='mixed'&&input.permanentBoundBytes!==a.completionDebitBytes)throw fail('WORKSPACE_ATOMIC_INTENT_INVALID');}
  if(requireActivePeer)assertAtomicPeer(a);
 }
 function assertOperationalAuthority(input){
  if(input.operational===undefined)return;
  if(!input.atomic||input.atomic.workspaceIntentCore?.schema!==2||p.schema!==2)throw fail('WORKSPACE_ATOMIC_INTENT_INVALID');
  if(typeof store.verifyOperationalQuoteAuthority!=='function'||store.verifyOperationalQuoteAuthority(input)!==true)throw fail('WORKSPACE_QUOTE_AUTHORITY_REQUIRED');
 }
 function assertWorkspaceDemand(input,s,g){
  if(input.kind==='permanent')return;
  if(input.operational!==undefined){assertOperationalAuthority(input);if((input.workspaceBoundBytes||input.boundBytes)>safe(BigInt(p.quoteRetainedBytes)+BigInt(p.controlRetainedBytes)))throw fail('WORKSPACE_RETAINED_LIMIT');}
  else{const lease=s.leases[hash({scopeKey:input.scopeKey,generation:input.generation})];if(!lease||lease.state!=='active')throw fail('WORKSPACE_LEASE_REQUIRED');}
  if((input.workspaceBoundBytes||input.boundBytes)>p.workspaceRetainedBytes-g.A)throw fail('WORKSPACE_RETAINED_LIMIT');
 }
 function atomicConservation(intent){
  const m=store.readWorkspaceMetrics(),before=intent.priorMetrics,a=intent.atomic;
  for(const k of ['pageSize','pageCount','freelistCount','workspaceAllocatedBytes'])if(!Number.isSafeInteger(m[k])||m[k]<0)throw fail('WORKSPACE_METRICS_INVALID');
  if(m.workspaceSchemaVerified!==true||m.pageSize!==before.pageSize||m.pageSize<=0||m.freelistCount>m.pageCount||m.workspaceAllocatedBytes%m.pageSize||m.workspaceAllocatedBytes>p.workspaceRetainedBytes)throw fail('WORKSPACE_METRICS_INVALID');
  validateWorkspacePartitions(p,m);
  const A=m.workspaceAllocatedBytes,F=Math.min(p.workspaceRetainedBytes-A,safe(BigInt(m.freelistCount)*BigInt(m.pageSize))),P=p.workspaceRetainedBytes-A-F,G=safe((BigInt(m.pageCount)-BigInt(before.pageCount))*BigInt(m.pageSize)),net=BigInt(G)+BigInt(P)-BigInt(intent.priorGeometry.P),required=safe((net>0n?net:0n)+BigInt(a.retainedNonDatabaseOutputBytes));
  if(a.completionDebitBytes<required)throw fail('WORKSPACE_ATOMIC_CONSERVATION');
  return{completionDebitBytes:a.completionDebitBytes,requiredBytes:required,growthBytes:G,paddingBeforeBytes:intent.priorGeometry.P,paddingAfterBytes:P};
 }
 function previewAtomicWrite(input){
  const s=load(),{m,g}=check(s);if(!input?.atomic||!['workspace','permanent','mixed'].includes(input.kind)||input.priorRevision!==m.revision||!Number.isSafeInteger(input.boundBytes)||input.boundBytes<4096||input.boundBytes%4096)throw fail('WORKSPACE_ATOMIC_INTENT_INVALID');
  const release=input.kind!=='permanent'?Math.min(s.padding.bytes,input.workspaceBoundBytes||input.boundBytes):0;
  assertWorkspaceDemand(input,s,g);
  atomicIntent(input,s,g,release,{requireActivePeer:false});const rollback=rollbackProofFor(input,s),intent={...input,priorMetrics:m,priorGeometry:g,releasePaddingBytes:release,rollbackProofBinding:rollbackIdentity(rollback.proof)};
  const completion={groupId:input.atomic.groupId,capacityIntentChecksum:input.atomic.capacityIntentChecksum,disposition:'committed',revision:input.priorRevision+1,writeSetDigest:input.atomic.fullWriteSetDigest};
  const prepared={...s,sequence:s.sequence+2,state:'writing',intent},completed={...s,sequence:s.sequence+5,state:'idle',intent:null,lastCompleted:completion,lastAtomicIntent:{...intent,committedRevision:input.priorRevision+1,writeSetDigest:input.atomic.fullWriteSetDigest}};
  const encodedBytes=Math.max(...[prepared,completed].map(body=>Buffer.byteLength(JSON.stringify({...body,checksum:hash(body)}))));if(encodedBytes>=SLOT)throw fail('WORKSPACE_CONTROL_LIMIT');
  return{verified:true,workspaceIntentCoreDigest:input.atomic.workspaceIntentCoreDigest,encodedBytes,rollbackProofDigest:rollback.proof.rollbackProofDigest};
 }
 function recoverAtomic(input){
  const s=load();let i=s.intent||s.lastAtomicIntent,unprepared=false;if(input?.authority&&s.state==='idle'&&s.sequence===input.authority.atomic?.priorPeerSequence&&hash(s)===input.authority.atomic?.priorPeerControlDigest){const m=store.readWorkspaceMetrics(),g=geometry(p,m),release=input.authority.kind!=='permanent'?Math.min(s.padding.bytes,input.authority.workspaceBoundBytes||input.authority.boundBytes):0;if(input.disposition!=='abort')throw fail('WORKSPACE_ATOMIC_SQL_PROOF_REQUIRED');atomicIntent(input.authority,s,g,release);i={...input.authority,priorMetrics:m,priorGeometry:g,releasePaddingBytes:release};unprepared=true;}const a=i?.atomic;
  if(!a||!input||input.groupId!==a.groupId||input.capacityIntentChecksum!==a.capacityIntentChecksum||!['abort','committed'].includes(input.disposition))throw fail('WORKSPACE_ATOMIC_INTENT_INVALID');
  const completion={groupId:a.groupId,capacityIntentChecksum:a.capacityIntentChecksum,disposition:input.disposition,revision:input.disposition==='abort'?i.priorRevision:input.committedRevision,writeSetDigest:input.disposition==='abort'?null:input.writeSetDigest};
  if(input.disposition==='committed'&&(input.committedRevision!==i.priorRevision+1||input.writeSetDigest!==a.fullWriteSetDigest))throw fail('WORKSPACE_ATOMIC_SQL_PROOF_REQUIRED');
  const peer=capacityPeer();if(peer.state==='idle'&&s.state==='idle'&&hash(s.lastCompleted||null)===hash(completion)&&hash(peer.lastCompleted||null)===hash(completion)){check(s);return{verified:true,completion};}
  assertAtomicPeer(a);
  if(typeof store.verifyAtomicWorkspaceTransition!=='function'||store.verifyAtomicWorkspaceTransition({intent:structuredClone(i),...input})!==true)throw fail('WORKSPACE_ATOMIC_SQL_PROOF_REQUIRED');
  const m=store.readWorkspaceMetrics(),g=geometry(p,m);
  if(m.revision!==completion.revision||input.disposition==='abort'&&(m.pageCount!==i.priorMetrics.pageCount||g.A!==i.priorGeometry.A||g.F!==i.priorGeometry.F))throw fail('WORKSPACE_ATOMIC_SQL_PROOF_REQUIRED');
  if(unprepared){proof(path.join(epoch.financial_dir,PADDING),g.P,s.padding);proof(path.join(epoch.financial_dir,SCRATCH),g.R,s.scratch);s.lastCompleted=completion;s.lastAtomicIntent=structuredClone(i);persist(s);check(s,{allowPeerActive:true});return{verified:true,completion};}
  if(s.state==='idle'){if(hash(s.lastCompleted||null)!==hash(completion))throw fail('WORKSPACE_ATOMIC_SQL_PROOF_REQUIRED');check(s,{allowPeerActive:true});return{verified:true,completion};}
  if(input.disposition==='committed')atomicConservation(i);
  s.state='refilling';s.intent={...i,...(input.disposition==='committed'?{committedRevision:input.committedRevision,writeSetDigest:input.writeSetDigest}:{})};persist(s);
  const result=refill(s,m,g,{atomicCompletion:completion});return{...result,completion};
 }
 function acquire({scopeKey,generation,capacity}){const s=load();check(s);if(typeof scopeKey!=='string'||!scopeKey||scopeKey.length>512||!Number.isSafeInteger(generation)||generation<1)throw fail('WORKSPACE_LEASE_INVALID');if(capacity?.mandatory!==true)throw fail('WORKSPACE_OPTIONAL_LEASE_UNAVAILABLE');store.assertWorkspaceOwner(capacity);const id=hash({scopeKey,generation}),old=s.leases[id];if(old){if(old.capacityDigest!==hash(capacity||{}))throw fail('WORKSPACE_LEASE_OWNER_CONFLICT');return structuredClone(old);}if(Object.values(s.leases).some(x=>x.scopeKey===scopeKey)||Object.keys(s.leases).length>=p.maxConcurrentScans)throw fail('WORKSPACE_LEASE_BUSY');const encodedCapacity=JSON.stringify(capacity);if(!encodedCapacity||Buffer.byteLength(encodedCapacity)>4096||hash(JSON.parse(encodedCapacity))!==hash(capacity))throw fail('WORKSPACE_LEASE_INVALID');const lease={id,scopeKey,generation,state:'active',cursor:null,memberCount:0,capacity:JSON.parse(encodedCapacity),capacityDigest:hash(capacity||{})};s.leases[id]=lease;persist(s);return structuredClone(lease);}
 // Runtime proof is obtained independently; a write authority's digest alone is not an attestation.
 function rollbackIdentity(observed){
  if(!Number.isSafeInteger(observed.schemaVersion)||observed.schemaVersion<0)throw fail('WORKSPACE_ROLLBACK_PROOF_INVALID');
  for(const name of ['file','tempDirectory']){const value=observed[name];if(!value||typeof value.path!=='string'||!path.isAbsolute(value.path)||path.resolve(value.path)!==value.path||!Number.isSafeInteger(value.dev)||value.dev<0||!Number.isSafeInteger(value.ino)||value.ino<0)throw fail('WORKSPACE_ROLLBACK_PROOF_INVALID');}
  if(observed.file.dev!==observed.tempDirectory.dev)throw fail('WORKSPACE_ROLLBACK_PROOF_INVALID');
  return{rollbackProofDigest:observed.rollbackProofDigest,descriptorDigest:hash(observed.descriptor),requiredRollbackBytes:observed.requiredRollbackBytes,schemaVersion:observed.schemaVersion,file:{path:observed.file.path,dev:observed.file.dev,ino:observed.file.ino},tempDirectory:{path:observed.tempDirectory.path,dev:observed.tempDirectory.dev,ino:observed.tempDirectory.ino}};
 }
 function assertRollbackScope(observed,s){
  const file=path.join(epoch.financial_dir,'money-control.sqlite'),actual=fs.lstatSync(file);
  const scratch=proof(path.join(epoch.financial_dir,SCRATCH),s.scratch.bytes,s.scratch);
  if(observed.file.path!==file||observed.file.dev!==actual.dev||observed.file.ino!==actual.ino||observed.tempDirectory.dev!==scratch.dev)throw fail('WORKSPACE_ROLLBACK_IDENTITY_CHANGED');
 }
 function inspectRollback(quota,options){
  if(typeof getRollbackProof!=='function')throw fail('WORKSPACE_ROLLBACK_PROOF_REQUIRED');
  const observed=options?getRollbackProof(options):getRollbackProof();
  if(!observed||typeof observed!=='object'||typeof observed.then==='function'||observed.proofKind!=='native-runtime-inspection'||!observed.descriptor||typeof observed.descriptor!=='object'||!/^([0-9a-f]{64})$/.test(observed.rollbackProofDigest||'')||!Number.isSafeInteger(observed.requiredRollbackBytes)||observed.requiredRollbackBytes<=0)throw fail('WORKSPACE_ROLLBACK_PROOF_INVALID');
  rollbackIdentity(observed);
  const expected=require('./money-sqlite-runtime').deriveRollbackProof(quota);
  if(observed.rollbackProofDigest!==expected.rollbackProofDigest||observed.rollbackProofDigest!==quota.rollbackProofDigest||observed.requiredRollbackBytes!==expected.requiredRollbackBytes||hash(observed.descriptor)!==hash(expected.descriptor))throw fail('WORKSPACE_ROLLBACK_PROOF_INVALID');
  return structuredClone(observed);
 }
 function rollbackProofFor(input,s){
  if(input.sqliteQuota===undefined)return null;
  const observed=inspectRollback(input.sqliteQuota);
  assertRollbackScope(observed,s);
  const actual=proof(path.join(epoch.financial_dir,SCRATCH),p.workspaceScratchBytes,s.scratch);
  if(actual.bytes<input.sqliteQuota.maxRollbackBytes||actual.allocatedBytes<input.sqliteQuota.maxRollbackBytes)throw fail('WORKSPACE_ROLLBACK_SCRATCH_INSUFFICIENT');
  return{proof:observed,releasedScratchBytes:actual.bytes};
 }
 function beforeCommit(input){
  const s=load(),intent=s.intent;
  if(s.state!=='writing'||!intent||!input||input.id!==intent.id||input.ownerPlanDigest!==intent.ownerPlanDigest||input.priorRevision!==intent.priorRevision)throw fail('WORKSPACE_WRITE_INTENT_MISMATCH');
  if(intent.sqliteQuota===undefined)return{verified:true,quota:false};
  if(intent.atomic)assertAtomicPeer(intent.atomic);
  assertOperationalAuthority(intent);
  const observed=inspectRollback(intent.sqliteQuota,{phase:'beforeCommit'});
  assertRollbackScope(observed,s);
  if(!intent.rollbackProofBinding||hash(rollbackIdentity(observed))!==hash(intent.rollbackProofBinding))throw fail('WORKSPACE_ROLLBACK_IDENTITY_CHANGED');
  const conservation=intent.atomic?atomicConservation(intent):undefined;
  return{verified:true,quota:true,rollbackProof:observed,rollbackProofDigest:observed.rollbackProofDigest,...(conservation?{conservation}:{})};
 }
 function prepareWrite(input){if(input?.kind==='mixed'){if(!Number.isSafeInteger(input.permanentBoundBytes)||input.permanentBoundBytes<4096||!Number.isSafeInteger(input.workspaceBoundBytes)||input.workspaceBoundBytes<4096)throw fail('WORKSPACE_WRITE_INVALID');input={...input,boundBytes:safe(BigInt(input.permanentBoundBytes)+BigInt(input.workspaceBoundBytes))};}const s=load(),{m,g}=check(s,{allowPeerActive:!!input.atomic});if(!input?.id||!['workspace','permanent','mixed'].includes(input.kind)||!Number.isSafeInteger(input.boundBytes)||input.boundBytes<4096||input.boundBytes%4096||input.priorRevision!==m.revision||!/^([0-9a-f]{64})$/.test(input.ownerPlanDigest||''))throw fail('WORKSPACE_WRITE_INVALID');assertWorkspaceDemand(input,s,g);
 const release=input.kind!=='permanent'?Math.min(s.padding.bytes,input.workspaceBoundBytes||input.boundBytes):0;atomicIntent(input,s,g,release);
 const rollback=rollbackProofFor(input,s);
 s.state='writing';s.intent={...input,priorMetrics:m,priorGeometry:g,releasePaddingBytes:release,...(rollback?{rollbackProofBinding:rollbackIdentity(rollback.proof)}:{})};persist(s);s.padding=fill(path.join(epoch.financial_dir,PADDING),s.padding.bytes-release,s.padding);s.scratch=fill(path.join(epoch.financial_dir,SCRATCH),0,s.scratch);persist(s);return{releasedPaddingBytes:release,releasedScratchBytes:rollback?.releasedScratchBytes??g.R,...(rollback?{rollbackProof:rollback.proof,rollbackProofDigest:rollback.proof.rollbackProofDigest}:{})};}
 function finishWrite({id,committedRevision,writeSetDigest}){const s=load(),intent=s.intent;if(intent?.atomic)throw fail('WORKSPACE_ATOMIC_RECOVERY_REQUIRED');if(s.state!=='writing'||intent?.id!==id||!Number.isSafeInteger(committedRevision)||committedRevision<=intent.priorRevision||!/^([0-9a-f]{64})$/.test(writeSetDigest||''))throw fail('WORKSPACE_RECOVERY_REQUIRED');const m=store.readWorkspaceMetrics(),g=geometry(p,m);if(m.revision!==committedRevision||store.verifyWorkspaceWrite({...intent,committedRevision,writeSetDigest})!==true)throw fail('WORKSPACE_COMMIT_PROOF_REQUIRED');const growth=Math.max(0,m.fileBytes-intent.priorMetrics.fileBytes),replacement=Math.max(0,g.P-intent.priorGeometry.P);if(growth>intent.boundBytes||intent.kind==='permanent'&&growth+replacement>intent.boundBytes)throw fail('WORKSPACE_WRITE_BOUND_EXCEEDED');s.state='refilling';s.intent={...intent,committedRevision,writeSetDigest};persist(s);return refill(s,m,g);}
 function refill(s,m,g,{atomicCompletion}={}){const paddingMinimum=Math.max(0,(s.intent?.priorGeometry.P??s.padding.bytes)-(s.intent?.releasePaddingBytes||0)),paddingMaximum=Math.max(s.intent?.priorGeometry.P??s.padding.bytes,g.P);for(const lease of Object.values(s.leases)){const scan=store.getProviderScan(lease.scopeKey);if(scan){if(scan.generation!==lease.generation)throw fail('WORKSPACE_LEASE_GENERATION_CONFLICT');const body=scan.control,memberCount=body.transactionCount??body.count??0;if(!Number.isSafeInteger(memberCount)||memberCount<0||memberCount>p.maxWorkspaceMembers)throw fail('WORKSPACE_MEMBER_LIMIT');lease.cursor=body.cursor??body.starting_after??null;lease.memberCount=memberCount;}}s.padding=fill(path.join(epoch.financial_dir,PADDING),g.P,s.padding,{minimum:Math.min(paddingMinimum,g.P),maximum:paddingMaximum});s.scratch=allocationMode==='linux-fallocate'?require('./money-scratch-allocation').allocateScratch({file:path.join(epoch.financial_dir,SCRATCH),bytes:g.R,identity:s.scratch,minimum:0,maximum:g.R}):fill(path.join(epoch.financial_dir,SCRATCH),g.R,s.scratch,{minimum:0,maximum:g.R});s.metrics=m;s.geometry=g;s.state='idle';if(atomicCompletion){s.lastCompleted=atomicCompletion;s.lastAtomicIntent=structuredClone(s.intent);}s.intent=null;persist(s);check(s,{allowPeerActive:!!atomicCompletion});return{verified:true,geometry:g};}
 function recover(){const s=load();if(s.intent?.atomic)throw fail('WORKSPACE_ATOMIC_RECOVERY_REQUIRED');if(s.state==='idle'){check(s);return{verified:true};}const i=s.intent,m=store.readWorkspaceMetrics(),g=geometry(p,m);if(!i)throw fail('WORKSPACE_RECOVERY_REQUIRED');if(s.state==='writing'&&m.revision===i.priorRevision)return refill(s,m,g);if(s.state==='writing'&&m.revision===i.priorRevision+1){const receipt=store.getWorkspaceWrite?.({id:i.id,priorRevision:i.priorRevision});if(receipt&&receipt.ownerPlanDigest===i.ownerPlanDigest)return finishWrite(receipt);}if(s.state==='refilling'&&m.revision===i.committedRevision&&store.verifyWorkspaceWrite({...i,committedRevision:i.committedRevision,writeSetDigest:i.writeSetDigest})===true)return refill(s,m,g);throw fail('WORKSPACE_COMMIT_PROOF_REQUIRED');}
 function release({scopeKey,generation}){const s=load();check(s);const id=hash({scopeKey,generation}),lease=s.leases[id];if(!lease)throw fail('WORKSPACE_LEASE_REQUIRED');const seal=store.getEvidence('provider_effects',scopeKey+':'+generation+':seal')?.payload;if(!seal||seal.generation!==generation||!(seal.complete===true||seal.complete===false&&seal.reason)||store.getProviderScan(scopeKey)||store.listProviderScanMembers({scopeKey,generation,limit:1}).items.length)throw fail('WORKSPACE_SEAL_CLEANUP_REQUIRED');delete s.leases[id];persist(s);return{released:true};}
 function verifiedPadding(){const s=load();check(s);return[{path:PADDING,role:'workspace-deficit',profileDigest:hash(p),...proof(path.join(epoch.financial_dir,PADDING),s.padding.bytes,s.padding)},{path:SCRATCH,role:'workspace-scratch',profileDigest:hash(p),...proof(path.join(epoch.financial_dir,SCRATCH),p.workspaceScratchBytes,s.scratch)}];}
 return{acquire,inspectAtomicPeer,previewAtomicWrite,recoverAtomic,prepareWrite,beforeCommit,finishWrite,recover,release,verifiedPadding,status:()=>{const s=load();check(s);return structuredClone(s);}};
}
module.exports={PADDING,SCRATCH,CONTROL,INIT_MANIFEST,geometry,initializeWorkspaceCapacity,createWorkspaceManager};

// Pure archived-control decoder: expectedDigest is authenticated by the selected
// checkpoint. It deliberately does not adopt copied physical inode identities.
function decodeRestoreControl({bytes,epoch,profile:p,expectedDigest}){
 if(!Buffer.isBuffer(bytes)||bytes.length!==SLOT*2||require('node:crypto').createHash('sha256').update(bytes).digest('hex')!==expectedDigest)throw fail('RESTORE_WORKSPACE_CONTROL_INVALID');
 const valid=[];for(let i=0;i<2;i++){try{const raw=bytes.subarray(i*SLOT,(i+1)*SLOT),end=raw.indexOf(0);if(end<1||raw.subarray(end).some(x=>x!==0))continue;const {checksum,...body}=JSON.parse(raw.subarray(0,end));if(hash(body)!==checksum||body.epoch_id!==epoch.epoch_id||body.binding_digest!==epoch.binding_digest||body.profileDigest!==hash(p)||!Number.isSafeInteger(body.sequence)||body.sequence<0)continue;valid.push(body);}catch{}}
 valid.sort((a,b)=>b.sequence-a.sequence);if(!valid.length||valid[1]?.sequence===valid[0].sequence&&hash(valid[1])!==hash(valid[0])||valid[0].state!=='idle'||valid[0].intent)throw fail('RESTORE_WORKSPACE_CONTROL_INVALID');return valid[0];
}
module.exports.decodeRestoreControl=decodeRestoreControl;

function inspectCheckpointWorkspace({epoch,writer,store,profile:p}){
 owner(epoch,writer);const state=read(epoch,p),metrics=store.readWorkspaceMetrics(),g=geometry(p,metrics),peer=store.getAtomicCapacityPeer();
 if(state.state!=='idle'||state.intent||peer.state!=='idle'||hash(peer.lastCompleted||null)!==hash(state.lastCompleted||null)||hash(state.metrics)!==hash(metrics)||hash(state.geometry)!==hash(g))throw fail('CHECKPOINT_ATOMIC_CUT_REQUIRED');
 const leases=Object.values(state.leases||{});if(leases.length>p.maxConcurrentScans)throw fail('CHECKPOINT_LEASE_INVALID');
 const scans=store.listProviderScans({limit:65});if(scans.nextCursor||scans.items.length>64)throw fail('CHECKPOINT_LEASE_INVALID');
 const ownedScopes=new Set();
 for(const lease of leases){
  if(!lease.capacity||hash(lease.capacity)!==lease.capacityDigest||lease.id!==hash({scopeKey:lease.scopeKey,generation:lease.generation}))throw fail('CHECKPOINT_LEASE_OWNER_UNPROVEN');
  store.assertWorkspaceOwner(lease.capacity);if(ownedScopes.has(lease.scopeKey))throw fail('CHECKPOINT_LEASE_INVALID');ownedScopes.add(lease.scopeKey);
  const scan=store.getProviderScan(lease.scopeKey);let count=0,after=null;do{const page=store.listProviderScanMembers({scopeKey:lease.scopeKey,generation:lease.generation,after,limit:100});count+=page.items.length;if(count>p.maxWorkspaceMembers)throw fail('CHECKPOINT_LEASE_INVALID');after=page.nextCursor;}while(after);
  if(scan){if(scan.generation!==lease.generation||lease.memberCount!==count||hash(lease.cursor)!==hash(scan.control.cursor??scan.control.starting_after??null))throw fail('CHECKPOINT_LEASE_INVALID');}
  else{const seal=store.getEvidence('provider_effects',lease.scopeKey+':'+lease.generation+':seal')?.payload;if(count||!seal||seal.generation!==lease.generation||!(seal.complete===true||seal.complete===false&&seal.reason))throw fail('CHECKPOINT_LEASE_INVALID');}
 }
 if(scans.items.some(row=>!ownedScopes.has(row.scopeKey)))throw fail('CHECKPOINT_UNOWNED_WORKSPACE');
 store.assertProviderScanMembershipCoverage({leases:leases.map(({scopeKey,generation})=>({scopeKey,generation}))});
 const padding=[{path:PADDING,role:'workspace-deficit',...proof(path.join(epoch.financial_dir,PADDING),g.P,state.padding)},{path:SCRATCH,role:'workspace-scratch',...proof(path.join(epoch.financial_dir,SCRATCH),g.R,state.scratch)}];
 return{state,metrics,geometry:g,controlDigest:hash(state),fileDigest:require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(epoch.financial_dir,CONTROL))).digest('hex'),leaseStateDigest:hash(state.leases||{}),jointCompletionDigest:hash(state.lastCompleted||null),padding};
}
function encodeRestoredWorkspace({authority,store,epoch,writer,priorState,outcome}){
 const {plan}=require('./money-atomic-restore').inspectRestoreAuthority(authority,{store,epoch,writer,phase:'outcome'});
 if(hash(priorState)!==plan.workspaceControlDigest||outcome.state!=='committed'||outcome.receiptDigest!==hash(outcome.receipt)||outcome.receipt.restoreId!==plan.restoreId)throw fail('RESTORE_WORKSPACE_CONTROL_INVALID');
 const geometryNow=geometry(store.getCapacityRecord('capacity:root').profile.workspace,outcome.metrics),completion={protocol:'atomic_restore_v1',restoreId:plan.restoreId,planDigest:plan.planDigest,revision:outcome.revision,receiptDigest:outcome.receiptDigest,priorJointCompletionDigest:plan.priorJointCompletionDigest};
 if(!Number.isSafeInteger(priorState.sequence+1))throw fail('RESTORE_GENERATION_OVERFLOW');
 const role=name=>{const r=plan.roles[name];return{dev:r.dev,ino:r.ino,bytes:name==='workspaceDeficit'?geometryNow.P:r.bytes,allocatedBytes:name==='workspaceDeficit'?geometryNow.P:r.allocatedBytes,nlink:1};};
 const body={...priorState,sequence:priorState.sequence+1,state:'idle',intent:null,padding:role('workspaceDeficit'),scratch:role('workspaceScratch'),control:role('workspaceControl'),metrics:outcome.metrics,geometry:geometryNow,lastCompleted:completion};
 const encoded=Buffer.from(JSON.stringify({...body,checksum:hash(body)}));if(encoded.length>=SLOT)throw fail('WORKSPACE_CONTROL_LIMIT');const bytes=Buffer.alloc(SLOT);encoded.copy(bytes);return{body,bytes,offset:body.sequence%2*SLOT,completion};
}
module.exports.inspectCheckpointWorkspace=inspectCheckpointWorkspace;
module.exports.encodeRestoredWorkspace=encodeRestoredWorkspace;
