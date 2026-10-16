'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createFixture,optionalCapture}=require('./helpers/money-quote-operational-fixture');
test('explicit bounded ext4 full-disk proof: retained fixed first failure without SQL growth',{
 skip:process.platform!=='linux'?'requires actual patched Linux SQLite runtime':process.env.AUXILO_QUOTE_ENOSPC_PROOF!=='1'?'requires explicit isolated 64–160MiB ext4 proof volume':false
},async t=>{
 const os=require('node:os'),proofRoot=process.env.AUXILO_QUOTE_ENOSPC_ROOT,markerName='.auxilo-emfr-proof-owner.json';
 assert.equal(proofRoot,'/capacity-proof');assert.equal(process.env.TMPDIR,proofRoot);assert.equal(os.tmpdir(),proofRoot);assert.equal(fs.realpathSync(proofRoot),proofRoot);assert.equal(process.getuid(),1000);
 const rootIdentity=fs.lstatSync(proofRoot),markerPath=path.join(proofRoot,markerName),markerIdentity=fs.lstatSync(markerPath);
 assert.ok(rootIdentity.isDirectory()&&!rootIdentity.isSymbolicLink());assert.equal(rootIdentity.uid,1000);assert.equal(rootIdentity.mode&0o777,0o700);assert.equal(rootIdentity.ino,2);assert.notEqual(rootIdentity.dev,fs.statSync('/').dev);
 assert.ok(markerIdentity.isFile()&&!markerIdentity.isSymbolicLink());assert.equal(markerIdentity.nlink,1);assert.equal(markerIdentity.uid,1000);assert.equal(markerIdentity.mode&0o777,0o600);
 const marker=JSON.parse(fs.readFileSync(markerPath,'utf8')),volume=fs.statfsSync(proofRoot),total=volume.blocks*volume.bsize;
 assert.equal(marker.schema,1);assert.equal(marker.purpose,'auxilo-emfr-disposable-enospc');assert.match(process.env.AUXILO_QUOTE_ENOSPC_PROOF_ID||'',/^[a-f0-9-]{36}$/);assert.equal(marker.proofId,process.env.AUXILO_QUOTE_ENOSPC_PROOF_ID);assert.equal(marker.mountTarget,proofRoot);assert.equal(marker.device,rootIdentity.dev);assert.equal(marker.rootInode,rootIdentity.ino);assert.equal(marker.volumeBytes,total);
 const mount=fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').map(line=>line.split(' ')).find(row=>row[4]===proofRoot);assert.ok(mount,'explicit disposable filesystem is not mounted');const separator=mount.indexOf('-');assert.equal(mount[separator+1],'ext4');assert.match(mount[separator+2],/^\/dev\/loop[0-9]+$/);
 assert.deepEqual(fs.readdirSync(proofRoot).sort(),[markerName,'lost+found'].sort(),'disposable proof volume contains unexpected files');
 assert.equal(volume.type,0xef53,'full-disk proof requires ext4');assert.ok(total>=64*1048576&&total<=160*1048576,'refuse filling a general-purpose or oversized filesystem');
 let debit;
 await t.test('measure exact optional capture debit on isolated proof volume',async sub=>{const f=await createFixture(sub),before=f.store.getCapacityRecord('capacity:root').optionalRemainingBytes;await optionalCapture(f);debit=before-f.store.getCapacityRecord('capacity:root').optionalRemainingBytes;assert.ok(debit>0&&debit%4096===0);});
 await t.test('full volume retains the first of two real committed anchors across reopen',async sub=>{
  const f=await createFixture(sub,{optionalBytes:debit,liquidity:true}),captureId=await optionalCapture(f);
  assert.equal(f.store.getCapacityRecord('capacity:root').optionalRemainingBytes,0);
  const q=await f.quote(),op=await f.accept(q);await f.coordinator.withMoneyControl({},ctx=>ctx.markDispatch({operationId:op.id,payload:{amount:1},idempotencyKey:'synthetic-never-sent'}));
  const anchors=f.coordinator.recoveryAnchors,first=anchors.resolveCommittedAnchor({kind:'verified_capture',id:captureId}),second=anchors.resolveCommittedAnchor({kind:'dispatch_operation',id:op.id}),manager=f.coordinator.failureControl;
  const revision=f.store.readMetadata().revision,dbSize=fs.statSync(f.store.file).size;
  const filler=path.join(f.dir,'exclusive-enospc-fixture.bin');let full=false,bytes=0,identity;
  for(let pass=0;pass<4;pass++){
   const flags=fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW|(pass?fs.constants.O_APPEND:fs.constants.O_CREAT|fs.constants.O_EXCL),fd=fs.openSync(filler,flags,0o600),opened=fs.fstatSync(fd);
   if(identity){assert.equal(opened.ino,identity.ino);assert.equal(opened.dev,identity.dev);}else identity=opened;assert.equal(opened.nlink,1);assert.ok(opened.isFile());
   try{for(const size of pass?[4096]:[1048576,4096]){const chunk=Buffer.alloc(size);while(bytes<total){try{const written=fs.writeSync(fd,chunk,0,Math.min(size,total-bytes));assert.ok(written>0);bytes+=written;if(size===4096)fs.fsyncSync(fd);}catch(error){if(error.code!=='ENOSPC')throw error;full=true;break;}}}try{fs.fsyncSync(fd);}catch(error){if(error.code!=='ENOSPC')throw error;full=true;}}finally{fs.closeSync(fd);}
   if(fs.statfsSync(f.dir).bavail*volume.bsize<4096)break;
  }
  assert.equal(full,true,'bounded own filler did not reach ENOSPC');assert.ok(fs.statfsSync(f.dir).bavail*volume.bsize<4096,'proof volume still had a complete free block');
  manager.noteFailure({anchor:first,reason:'MANDATORY_WRITE_FAILED',phase:'persist_result',cutStatus:'verified'});const proof=manager.checkpointProof();
  assert.equal(manager.noteFailure({anchor:second,reason:'MANDATORY_WRITE_FAILED',phase:'persist_result',cutStatus:'verified'}).retained_first,true);
  assert.equal(manager.checkpointProof().slotDigest,proof.slotDigest);assert.equal(f.store.readMetadata().revision,revision);assert.equal(fs.statSync(f.store.file).size,dbSize);
  assert.throws(()=>manager.assertNewEffectAllowed({action:'provider_submit'}),{code:'FINANCIAL_RECOVERY_REQUIRED'});
  f.reopen();assert.equal(f.coordinator.failureControl.checkpointProof().slotDigest,proof.slotDigest);assert.equal(f.store.getOperation(op.id).state,'dispatch_intent');assert.ok(f.store.getEvidence('verified_capture',captureId));
  sub.diagnostic(JSON.stringify({filesystem:'ext4',totalBytes:total,fillerBytes:bytes,freeBytes:fs.statfsSync(f.dir).bavail*volume.bsize,optionalRemainingBytes:0,firstFailurePersisted:true,secondAnchorRetained:true,unchangedRevision:revision,unchangedDatabaseBytes:dbSize}));
 });
});
