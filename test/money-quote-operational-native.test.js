"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createFixture,cost,quoteInput}=require('./helpers/money-quote-operational-fixture');
const native=(name,fn)=>test(name,{skip:process.platform!=='linux'?'requires actual patched Linux SQLite runtime':false},fn);
native('1000 native quote refresh/expiry commits retain bounded storage without permanent financial growth',async t=>{
 const f=await createFixture(t),before=f.store.exportDatabaseAuxiliary(),source=f.store.getSource('source'),profile=JSON.stringify(f.profile);let warmBytes=0,maxBytes=0,last;
 for(let i=0;i<1000;i++){if(i)f.advance();last=await f.quote();const bytes=fs.statSync(path.join(f.dir,'money-control.sqlite')).size;if(i===63)warmBytes=bytes;if(i>=63)maxBytes=Math.max(maxBytes,bytes);}
 const after=f.store.exportDatabaseAuxiliary(),control=f.store.getOperationalControl('quotes');
 assert.equal(control.generation,1000);assert.equal(control.revision,f.store.readMetadata().revision);assert.equal(control.payload.lastWrite.core.operational.kind,'quotes');assert.equal(control.payload.lastWrite.core.transient,true);
 assert.deepEqual(after.capacitySeeds,before.capacitySeeds);assert.deepEqual(after.auditSeeds,before.auditSeeds);assert.deepEqual(f.store.getSource('source'),source);assert.equal(JSON.stringify(f.profile),profile);assert.equal(f.store.getQuote(last.id).hash,last.hash);
 assert.ok(maxBytes<=warmBytes,'quote refresh DB highwater grew after 64-cycle warmup: '+JSON.stringify({warmBytes,maxBytes}));
 const metrics=f.store.readWorkspaceMetrics();assert.equal(metrics.workspaceLayoutVersion,2);assert.ok(metrics.workspaceClassBytes.quotes<=f.profile.workspace.quoteRetainedBytes);assert.ok(metrics.workspaceClassBytes.control<=f.profile.workspace.controlRetainedBytes);
 const revision=f.store.readMetadata().revision;for(let i=0;i<20;i++){f.manager.status();f.store.atomicCapacityStatus();}assert.equal(f.store.readMetadata().revision,revision);f.store.validateDatabase({full:true});
 t.diagnostic(JSON.stringify({fixture:f.profile.id,cycles:1000,warmBytes,maxBytes,workspace:metrics.workspaceClassBytes,permanentAuditGrowth:after.auditSeeds.length-before.auditSeeds.length}));
});
native('new cost plus quote is permanent once, cost reread is operational, acceptance preserves exact quote',async t=>{
 const f=await createFixture(t,{costs:false,liquidity:true}),original=cost(f.epoch),incremental=cost(f.epoch,'incremental'),before=f.store.exportDatabaseAuxiliary().auditSeeds.length;
 const q=await f.coordinator.withMoneyControl({},ctx=>{ctx.recordCost(original);ctx.recordCost(incremental);return ctx.quoteReturn(quoteInput);});
 assert.equal(f.store.exportDatabaseAuxiliary().auditSeeds.length,before+1);assert.notEqual(f.store.getOperationalControl('quotes').payload.lastWrite.core.transient,true);
 const afterMixed=f.store.exportDatabaseAuxiliary().capacitySeeds;
 const q2=await f.coordinator.withMoneyControl({},ctx=>{ctx.recordCost(original);ctx.recordCost(incremental);return ctx.quoteReturn(quoteInput);});
 assert.equal(f.store.exportDatabaseAuxiliary().auditSeeds.length,before+1);assert.deepEqual(f.store.exportDatabaseAuxiliary().capacitySeeds,afterMixed);
 await assert.rejects(f.coordinator.withMoneyControl({},ctx=>ctx.reserveReturn({accountId:'foreign',quoteId:q2.id,quoteHash:q2.hash,clientRequestKey:'22222222-2222-4222-8222-222222222222'})),{code:'QUOTE_NOT_FOUND'});
 const accepted=await f.accept(q2);assert.deepEqual(accepted.acceptedQuote,q2);assert.equal(accepted.quoteHash,q2.hash);assert.equal(f.store.getQuote(q2.id),undefined);assert.equal(f.store.getQuote(q.id).hash,q.hash);assert.equal(f.store.exportDatabaseAuxiliary().auditSeeds.length,before+2);assert.notEqual(f.store.getOperationalControl('quotes').payload.lastWrite.core.transient,true);
 const revision=f.store.readMetadata().revision;assert.deepEqual(await f.accept(q2),accepted);assert.equal(f.store.readMetadata().revision,revision);f.store.validateDatabase({full:true});
});
native('native quote operational receipt survives cold reopen and exact auxiliary export',async t=>{
 const f=await createFixture(t),q=await f.quote(),before=f.store.exportDatabaseAuxiliary(),revision=f.store.readMetadata().revision;f.reopen();assert.equal(f.router.recover().state,'ready');assert.equal(f.store.readMetadata().revision,revision);assert.deepEqual(f.store.exportDatabaseAuxiliary().operationalSeeds,before.operationalSeeds);assert.equal(f.store.getQuote(q.id).hash,q.hash);f.store.validateDatabase({full:true});
});

// This test owns two subtests. A skipped parent never runs its body, so on a non-Linux host those subtests were never registered and the discovered count
// differed by platform (7010 on macOS, 7012 on Linux). The parent therefore always runs and each subtest carries the skip, which keeps the count stable.
test('zero optional bytes after one exact measured capture still permits quote and owed acceptance',async t=>{
 const skip=process.platform!=='linux'?'requires actual patched Linux SQLite runtime':false;
 let debit,receipt;
 await t.test('measure committed optional capture owner share',{skip},async sub=>{const f=await createFixture(sub),before=f.store.getCapacityRecord('capacity:root').optionalRemainingBytes;await require('./helpers/money-quote-operational-fixture').optionalCapture(f);debit=before-f.store.getCapacityRecord('capacity:root').optionalRemainingBytes;receipt=f.store.exportDatabaseAuxiliary().capacitySeeds.map(x=>x.payload).find(x=>x.state==='consumed'&&x.consumedRevision===f.store.readMetadata().revision);assert.ok(debit>0&&debit%4096===0);assert.equal(receipt.shares.filter(x=>x.reservationId==='@optional').reduce((n,x)=>n+x.bytes,0),debit);});
 await t.test('same real write drains exact smaller synthetic optional budget',{skip},async sub=>{const f=await createFixture(sub,{optionalBytes:debit,liquidity:true});await require('./helpers/money-quote-operational-fixture').optionalCapture(f);assert.equal(f.store.getCapacityRecord('capacity:root').optionalRemainingBytes,0);const root=f.store.getCapacityRecord('capacity:root'),q=await f.quote();assert.deepEqual(f.store.getCapacityRecord('capacity:root'),root);const accepted=await f.accept(q);assert.deepEqual(accepted.acceptedQuote,q);assert.equal(f.store.getCapacityRecord('capacity:root').optionalRemainingBytes,0);f.store.validateDatabase({full:true});});
});
native('full quote partition refuses with unchanged cut then mandatory scan and owed acceptance complete',async t=>{
 const f=await createFixture(t,{quoteBytes:7*4096,liquidity:true}),quotes=[];let refusal,before;
 for(let i=0;i<10;i++){before={revision:f.store.readMetadata().revision,aux:f.store.exportDatabaseAuxiliary()};try{quotes.push(await f.quote());}catch(error){refusal=error;break;}}
 assert.ok(refusal,'expected physical quote partition refusal');assert.equal(refusal.code,'WORKSPACE_PARTITION_LIMIT');assert.ok(quotes.length>0);assert.equal(f.store.readMetadata().revision,before.revision);assert.deepEqual(f.store.exportDatabaseAuxiliary(),before.aux);
 const scopeKey='stripe:acct_test:test',capacity={mandatory:true,sourceId:'source'};
 await f.coordinator.withMoneyControl({},ctx=>ctx.acquireWorkspaceLease({scopeKey,generation:1,capacity}));
 await f.coordinator.withMoneyControl({},ctx=>ctx.advanceProviderScan({scopeKey,generation:1,expectedRevision:0,control:{generation:1,state:'scanning',cursor:null,transactionCount:0},rows:[],capacity}));
 await f.coordinator.withMoneyControl({},ctx=>ctx.sealProviderScan({scopeKey,generation:1,expectedRevision:1,control:{generation:1,state:'complete',balanceDigest:'synthetic-balance'},seal:{complete:true,balanceDigest:'synthetic-balance'},capacity}));
 await f.coordinator.withMoneyControl({},ctx=>ctx.releaseWorkspaceLease({scopeKey,generation:1}));
 const accepted=await f.accept(quotes[0]);assert.deepEqual(accepted.acceptedQuote,quotes[0]);f.store.validateDatabase({full:true});t.diagnostic(JSON.stringify({refusal:refusal.code,retainedQuotes:quotes.length,quotePartitionBytes:f.profile.workspace.quoteRetainedBytes}));
});

test('explicit bounded ext4 full-disk proof: zero optional bytes quote then protected acceptance',{
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
 await t.test('measure exact optional capture debit on isolated proof volume',async sub=>{const f=await createFixture(sub),before=f.store.getCapacityRecord('capacity:root').optionalRemainingBytes;await require('./helpers/money-quote-operational-fixture').optionalCapture(f);debit=before-f.store.getCapacityRecord('capacity:root').optionalRemainingBytes;assert.ok(debit>0&&debit%4096===0);});
 await t.test('preallocated quote and admitted principal survive real ENOSPC',async sub=>{
  const f=await createFixture(sub,{optionalBytes:debit,liquidity:true});await require('./helpers/money-quote-operational-fixture').optionalCapture(f);assert.equal(f.store.getCapacityRecord('capacity:root').optionalRemainingBytes,0);
  assert.deepEqual(fs.readdirSync(proofRoot).sort(),[markerName,'lost+found',path.basename(f.dir)].sort());assert.equal(fs.lstatSync(markerPath).ino,markerIdentity.ino);
  const filler=path.join(f.dir,'exclusive-enospc-fixture.bin');let full=false,bytes=0,identity;
  for(let pass=0;pass<4;pass++){
   const flags=fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW|(pass?fs.constants.O_APPEND:fs.constants.O_CREAT|fs.constants.O_EXCL),fd=fs.openSync(filler,flags,0o600),opened=fs.fstatSync(fd);
   if(identity){assert.equal(opened.ino,identity.ino);assert.equal(opened.dev,identity.dev);}else identity=opened;assert.equal(opened.nlink,1);assert.ok(opened.isFile());
   try{for(const size of pass?[4096]:[1048576,4096]){const chunk=Buffer.alloc(size);while(bytes<total){try{const written=fs.writeSync(fd,chunk,0,Math.min(size,total-bytes));assert.ok(written>0);bytes+=written;if(size===4096)fs.fsyncSync(fd);}catch(error){if(error.code!=='ENOSPC')throw error;full=true;break;}}}try{fs.fsyncSync(fd);}catch(error){if(error.code!=='ENOSPC')throw error;full=true;}}finally{fs.closeSync(fd);}
   if(fs.statfsSync(f.dir).bavail*volume.bsize<4096)break;
  }
  assert.equal(full,true,'bounded own filler did not reach ENOSPC');assert.ok(fs.statfsSync(f.dir).bavail*volume.bsize<4096,'proof volume still had a complete free block');
  const prior=f.store.getCapacityRecord('capacity:root'),q=await f.quote();assert.deepEqual(f.store.getCapacityRecord('capacity:root'),prior);const accepted=await f.accept(q);assert.deepEqual(accepted.acceptedQuote,q);assert.equal(f.store.getCapacityRecord('capacity:root').optionalRemainingBytes,0);f.store.validateDatabase({full:true});sub.diagnostic(JSON.stringify({filesystem:'ext4',totalBytes:total,fillerBytes:bytes,optionalBytesRemaining:0,quoteCommitted:true,principalReservationCommitted:true}));
 });
});
