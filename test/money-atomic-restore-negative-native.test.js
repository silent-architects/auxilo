'use strict';
// Full public restore-entry negatives over generated authenticated checkpoints.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const kinds=['trusted-digest','self-consistent-manifest','wrong-request','missing-allowance','malformed-allowance','undersized-allowance','barrier-before-sql','barrier-before-publication','lifecycle-before-sql','lifecycle-before-publication','failure-inode','earnings-inode','completion-symlink','completion-hardlink','completion-sparse','completion-oversize','scratch-fsync','final-scratch-truncated','final-deficit-truncated','final-engineering-truncated','final-publication-truncated'];
function childEnv(values){return{...process.env,NODE_TEST_CONTEXT:'isolated-native-restore-negative',...values};}
async function run(kind,locator){
 const helpers=require('./helpers/financial-epoch-fixture'),e=require('../lib/financial-epoch'),op=require('../lib/financial-epoch-operator'),cp=require('../lib/money-checkpoint'),lock=require('../lib/money-writer-lock'),restore=require('../lib/money-atomic-restore'),p=require('../lib/stripe-transfer-persistence'),dbModule=require('../lib/money-database'),core=require('../lib/money-atomic-restore-core');
 const cleanup=[],t={after:fn=>cleanup.push(fn)},onRoot=root=>fs.writeFileSync(locator,JSON.stringify({root,target:root+'-restored'}));let epoch,sourceWriter,money,profile,root;
 if(kind==='earnings-inode'){
  const f=await require('./helpers/money-compensation-native-fixture').setup({onRoot});({epoch,profile,root}=f);sourceWriter=f.writer;money=f.coordinator;
  await money.withMoneyControl({kind:'unlock',accounts:['buyer'],credits:['buyer'],action:'new_spend'},async()=>{const debit=await f.credits.deductCredit('buyer','unlock',0.02);assert.equal(debit.success,true);const spend=money.store.listSpends({limit:10}).items[0],anchor=money.recoveryAnchors.resolveCommittedAnchor({kind:'spend',id:spend.id});money.failureControl.requestCompensation({spendCapability:anchor,preWalCapability:debit.preWalCapability});});
 }else{
  const f=helpers.bootAtomic(t,{onRoot});root=f.root;f.writer.close();sourceWriter=lock.acquireMoneyWriter({root});process.env.AUXILO_DATA_DIR=root;
  const evidence=helpers.atomicCapacityEvidence(f.epoch,{fundingCents:1,returnCount:1});profile=evidence.capacity_profile;epoch=op.transitionEpoch({epoch:f.epoch,writer:sourceWriter,expectedRevision:0,patch:{reconcile:true},evidence:{reconcile:'a'.repeat(64),approval_ref:'synthetic-native-negative'},financialEvidence:evidence});
  money=require('../lib/money-control').initializeMoneyRuntime({epoch,writer:sourceWriter});await helpers.initializeAtomicFixture(t,{epoch,writer:sourceWriter,money,profile});
 }
 const lifecycle={schema_version:1,rule_version:'restore-negative-v1',approval_ref:'synthetic',deletion_barrier:{sequence:0,hash:'a'.repeat(64)},seals:[],records:[],holds:[]};
 let writer,restoreFsync;
 try{
  const cut=await cp.createMoneyCheckpoint({epoch,writer:sourceWriter,coordinator:money,sourceSha:'a'.repeat(40),lifecycleControl:lifecycle}),checkpointDir=cp.checkpointDirectory(root,cut.checkpoint_id),manifest=cp.validateCheckpoint(checkpointDir),targetRoot=root+'-restored';
  fs.mkdirSync(targetRoot,{mode:0o700});writer=lock.acquireMoneyWriter({root:targetRoot});
  if(kind==='trusted-digest'||kind==='self-consistent-manifest'){
   if(kind==='self-consistent-manifest'){const changed=e.seal({...manifest,source_sha:'f'.repeat(40)});p.writeJSONAtomic(path.join(checkpointDir,cp.MANIFEST),changed);assert.equal(cp.validateCheckpoint(checkpointDir).checksum,changed.checksum);assert.notEqual(changed.checksum,cut.digest);}
   assert.throws(()=>cp.restoreCheckpoint({checkpointDir,targetRoot,writer,authoritativeLifecycle:lifecycle,expectedCheckpointDigest:kind==='trusted-digest'?'0'.repeat(64):cut.digest}),{code:'RESTORE_TRUSTED_CHECKPOINT_REQUIRED'});assert.deepEqual(fs.readdirSync(targetRoot),['.money-writer.lock']);return;
  }
  cp.restoreCheckpoint({checkpointDir,targetRoot,writer,authoritativeLifecycle:lifecycle,expectedCheckpointDigest:cut.digest});
  const barrierFile=path.join(targetRoot,cp.RESTORE),barrier=p.readJSONStrict(barrierFile),dir=path.join(targetRoot,'financial-epochs',epoch.epoch_id),descriptor=p.readJSONStrict(path.join(dir,'money-control.json'));
  function sqlCut(){const opened=dbModule.openDatabase(path.join(dir,'money-control.sqlite'),descriptor,{readonly:true});try{const m=dbModule.readMetadata(opened.db),row=JSON.parse(opened.db.prepare("SELECT payload FROM capacity_reservations WHERE id='capacity:root'").get().payload);return{revision:m.revision,sequence:m.sequence,rootDigest:p.digestJSON(row),economic:p.digestJSON(core.rootEconomicProjection(row)),...dbModule.readAtomicRestoreDigests(opened.db)};}finally{opened.db.close();}}
  const before=sqlCut(),failureFile=path.join(dir,require('../lib/money-failure-control').FILE),failureBefore=fs.readFileSync(failureFile),creditsBefore=fs.readFileSync(path.join(dir,'credits.json'));
  const base={schema:1,checkpointDigest:cut.digest,bindingDigest:epoch.binding_digest,profileDigest:p.digestJSON(profile),databaseSchema:3,barrierDigest:barrier.checksum,permanentBoundBytes:4*1048576,publicationBoundBytes:1048576,maxGrowthPages:64,maxNetOccupiedPages:64,evidenceRef:'synthetic full-entry negative'},executionApprovalRef='explicit-negative-fixture';
  if(kind==='undersized-allowance')base.permanentBoundBytes=4096;
  const restoreAllowance={...base,requestId:restore.deriveRestoreRequestId({targetRoot,executionApprovalRef,restoreAllowance:base})};
  const input={targetRoot,writer,checkpointDir,expectedCheckpointDigest:cut.digest,expectedBarrierDigest:barrier.checksum,authoritativeLifecycle:lifecycle,executionApprovalRef,restoreAllowance};
  if(kind==='wrong-request')restoreAllowance.requestId='0'.repeat(64);
  if(kind==='missing-allowance')delete input.restoreAllowance;
  if(kind==='malformed-allowance')restoreAllowance.permanentBoundBytes=1;
  let hit=false,barrierPublished=false;
  const finalPhysicalCase=kind.startsWith('final-');
  if(finalPhysicalCase)input.afterStep=step=>{
   if(step==='barrier:published')barrierPublished=true;
   if(step!=='padding:refilled'||hit)return;hit=true;
   const workspace=require('../lib/money-workspace'),names={'final-scratch-truncated':workspace.SCRATCH,'final-deficit-truncated':workspace.PADDING,'final-engineering-truncated':restore.ENGINEERING,'final-publication-truncated':restore.PUBLICATION},file=path.join(dir,names[kind]),owned=fs.lstatSync(file);
   assert.ok(owned.size>=4096,'fixture role has one allocated page to truncate');
   const fd=fs.openSync(file,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW);try{assert.equal(fs.fstatSync(fd).ino,owned.ino);fs.ftruncateSync(fd,owned.size-4096);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   assert.equal(fs.lstatSync(file).ino,owned.ino);assert.equal(fs.lstatSync(file).size,owned.size-4096);p.syncDirectory(dir);
  };
  if(kind.startsWith('barrier-')||kind.startsWith('lifecycle-'))input.afterStep=step=>{const selected=kind.endsWith('before-sql')?'scratch:released':kind.startsWith('barrier-')?'publication:released':'capacity:published';if(step!==selected||hit)return;hit=true;if(kind.startsWith('barrier-'))p.writeJSONAtomic(barrierFile,e.seal({...p.readJSONStrict(barrierFile),external_fixture_revision:1}));else lifecycle.deletion_barrier={sequence:1,hash:'b'.repeat(64)};};
  let foreign;
  const physicalCase=kind.startsWith('completion-')||kind==='scratch-fsync';
  if(physicalCase)input.afterStep=step=>{
   if(step!=='intent:prepared'||hit)return;hit=true;
   const completion=path.join(dir,require('../lib/money-capacity').RESERVE_FILE),owned=fs.statSync(completion);
   if(kind==='completion-symlink'||kind==='completion-hardlink'){
    const backup=completion+'.owned-fixture-backup',file=path.join(targetRoot,'fixture-foreign-padding');fs.renameSync(completion,backup);
    if(kind==='completion-symlink'){fs.writeFileSync(file,'foreign fixture bytes',{mode:0o600});fs.symlinkSync(file,completion);}else{fs.copyFileSync(backup,file);fs.chmodSync(file,0o600);fs.linkSync(file,completion);}
    foreign={file,digest:require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'),nlink:fs.lstatSync(file).nlink,target:completion,targetInode:fs.lstatSync(completion).ino};
   }else if(kind==='completion-sparse'){
    const fd=fs.openSync(completion,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW);try{fs.ftruncateSync(fd,0);fs.ftruncateSync(fd,owned.size);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}assert.equal(fs.statSync(completion).ino,owned.ino);assert.equal(fs.statSync(completion).size,owned.size);assert.ok(fs.statSync(completion).blocks*512<owned.size);
   }else if(kind==='completion-oversize'){
    const fd=fs.openSync(completion,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW);try{fs.writeSync(fd,Buffer.alloc(4096),0,4096,owned.size);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}assert.equal(fs.statSync(completion).ino,owned.ino);assert.equal(fs.statSync(completion).size,owned.size+4096);
   }else{
    const scratch=fs.statSync(path.join(dir,require('../lib/money-workspace').SCRATCH)),original=fs.fsyncSync;restoreFsync=()=>{fs.fsyncSync=original;};let fired=false;
    fs.fsyncSync=function(fd){const st=fs.fstatSync(fd);if(!fired&&st.dev===scratch.dev&&st.ino===scratch.ino){fired=true;process.stderr.write('EXACT_SCRATCH_FSYNC_FAULT\n');throw Object.assign(Error('exact synthetic scratch fsync failure'),{code:'EIO',exactScratchFsync:true});}return original.call(fs,fd);};
   }
   p.syncDirectory(dir);
  };
  if(kind==='failure-inode'||kind==='earnings-inode'){
   await cp.restoreCheckpointCapacity(input);writer.close();writer=null;
   const selected=kind==='failure-inode'?failureFile:path.join(dir,'earnings.json'),bytes=fs.readFileSync(selected),old=fs.statSync(selected),temporary=selected+'.replacement';fs.writeFileSync(temporary,bytes,{mode:0o600});const fd=fs.openSync(temporary,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,selected);p.syncDirectory(dir);assert.notEqual(fs.statSync(selected).ino,old.ino);assert.deepEqual(fs.readFileSync(selected),bytes);
   const saved=sqlCut(),probe=spawnSync(process.execPath,[__filename],{env:childEnv({EMFR_RESTORE_NEGATIVE_CASE:'',EMFR_RESTORE_NEGATIVE_PROBE:JSON.stringify({targetRoot,kind})}),encoding:'utf8',timeout:60000});assert.equal(probe.status,0,probe.stdout+probe.stderr);assert.match(probe.stderr,/EXPECTED_IDENTITY_REFUSAL/);assert.deepEqual(sqlCut(),saved);assert.deepEqual(fs.readFileSync(failureFile),failureBefore);assert.deepEqual(fs.readFileSync(path.join(dir,'credits.json')),creditsBefore);return;
  }
  let caught;try{await cp.restoreCheckpointCapacity(input);}catch(error){caught=error;}
  assert.ok(caught,'full restore must refuse '+kind);if(kind.startsWith('barrier-')||kind.startsWith('lifecycle-')||physicalCase||finalPhysicalCase)assert.equal(hit,true,'critical hook reached');
  if(['wrong-request','missing-allowance','malformed-allowance'].includes(kind))assert.equal(caught.code,'RESTORE_ALLOWANCE_INVALID');
  else if(kind==='undersized-allowance')assert.equal(caught.code,'ATOMIC_RESTORE_ALLOWANCE_EXHAUSTED');
  else if(finalPhysicalCase)assert.match(caught.code,/RESTORE_PHYSICAL_|RESTORE_FINAL_|RESTORE_PUBLICATION_|WORKSPACE_|ATOMIC_RESTORE_ROLE_INVALID/);
  else if(physicalCase){if(kind==='scratch-fsync'){assert.equal(caught.code,'EIO');assert.equal(caught.exactScratchFsync,true);}else assert.match(caught.code,/RESTORE_PHYSICAL_|ATOMIC_RESTORE_ROLE_INVALID|ELOOP/);}
  else if(kind.startsWith('barrier-'))assert.equal(caught.code,'RESTORE_CAPACITY_BARRIER_CONFLICT');
  else assert.match(caught.code,/LIFECYCLE|AUTHORITY|DELETION|BARRIER/);
  const after=sqlCut();assert.equal(after.financialStateDigest,before.financialStateDigest);assert.equal(after.economic,before.economic);assert.deepEqual(fs.readFileSync(failureFile),failureBefore);assert.deepEqual(fs.readFileSync(path.join(dir,'credits.json')),creditsBefore);assert.equal(p.readJSONStrict(barrierFile).capacity_recreation_required,true);
  if(finalPhysicalCase){assert.equal(barrierPublished,false,'barrier CAS must not publish after truncated refill');assert.equal(after.revision,before.revision+1,'exact physical successor already committed');}
  else if(!kind.endsWith('before-publication')){assert.equal(after.revision,before.revision);assert.equal(after.rootDigest,before.rootDigest);}
  if(foreign){assert.ok(fs.existsSync(foreign.file));assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(foreign.file)).digest('hex'),foreign.digest);assert.equal(fs.lstatSync(foreign.file).nlink,foreign.nlink);assert.equal(fs.lstatSync(foreign.target).ino,foreign.targetInode);}
  console.log('RESTORE_NEGATIVE_REFUSAL',kind,caught.code);
 }finally{restoreFsync?.();writer?.close();try{money.store.close();}catch{}sourceWriter.close();for(const fn of cleanup.reverse())try{await fn();}catch{}}
}
async function probe({targetRoot,kind}){
 process.env.AUXILO_DATA_DIR=targetRoot;process.env.AUXILO_SQLITE_TMPDIR=path.join(targetRoot,'sqlite-runtime-temp');const writer=require('../lib/money-writer-lock').acquireMoneyWriter({root:targetRoot});let money,caught;
 try{const epoch=require('../lib/financial-epoch').resolveRuntimeEpoch({root:targetRoot,writer});money=require('../lib/money-control').initializeMoneyRuntime({epoch,writer});if(kind==='earnings-inode'){const selected=money.failureControl.status(),anchor=money.recoveryAnchors.restore(selected.anchor);money.withMoneyBootControl({recoveryAnchor:anchor,action:'compensate'},()=>money.failureControl.resumeCompensation());}}catch(error){caught=error;}finally{try{money?.store.close();}catch{}writer.close();}
 assert.ok(caught,'mapped equal-byte foreign inode must refuse');if(kind==='earnings-inode')assert.equal(caught.code,'COMPENSATION_ACCRUAL_CONFLICT');else assert.match(caught.code,/RESTORE_PHYSICAL_IDENTITY|FAILURE_CONTROL/);process.stderr.write('EXPECTED_IDENTITY_REFUSAL '+caught.code+'\n');
}
if(process.env.EMFR_RESTORE_NEGATIVE_PROBE)probe(JSON.parse(process.env.EMFR_RESTORE_NEGATIVE_PROBE)).catch(error=>{console.error(error);process.exitCode=1;});
else if(process.env.EMFR_RESTORE_NEGATIVE_CASE){const x=JSON.parse(process.env.EMFR_RESTORE_NEGATIVE_CASE);run(x.kind,x.locator).catch(error=>{console.error(error);process.exitCode=1;});}
else for(const kind of kinds)test('native full restore refuses '+kind,{skip:process.platform!=='linux'?'requires actual patched Linux SQLite runtime':false,timeout:120000},t=>{const box=fs.mkdtempSync(path.join(os.tmpdir(),'restore-negative-parent-')),locator=path.join(box,'locator.json');t.after(()=>{if(fs.existsSync(locator)){const row=JSON.parse(fs.readFileSync(locator));for(const key of ['root','target'])fs.rmSync(row[key],{recursive:true,force:true});}fs.rmSync(box,{recursive:true,force:true});});const result=spawnSync(process.execPath,[__filename],{env:childEnv({EMFR_RESTORE_NEGATIVE_CASE:JSON.stringify({kind,locator}),EMFR_RESTORE_NEGATIVE_PROBE:''}),encoding:'utf8',timeout:100000});assert.equal(result.status,0,result.stdout+result.stderr);});
