'use strict';
// TEST-ONLY C2 characterization: real original manager, one private paid fixture at a time.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const cases=['busy-first','publication-before-write','publication-short-write','publication-fsync','oversized-learning','vector-extra','vector-amount','realized-refusal'];
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function location(f){const e=require('../lib/financial-epoch');return{root:f.root,dir:f.epoch.financial_dir,credits:e.pathFor('credits',f.epoch),earnings:e.pathFor('earnings',f.epoch),wal:e.pathFor('wal',f.epoch),control:path.join(f.epoch.financial_dir,require('../lib/money-failure-control').FILE)};}
function stable(f){
 const x=location(f),d=require('../lib/money-database'),descriptor=JSON.parse(fs.readFileSync(path.join(x.dir,'money-control.json'))),opened=d.openDatabase(path.join(x.dir,'money-control.sqlite'),descriptor,{readonly:true});
 try{return{credits:fs.readFileSync(x.credits).toString('base64'),earnings:fs.readFileSync(x.earnings).toString('base64'),wal:fs.readdirSync(x.wal).sort().map(name=>[name,fs.readFileSync(path.join(x.wal,name)).toString('base64')]),metadata:d.readMetadata(opened.db),financial:d.readAtomicRestoreDigests(opened.db),capacity:opened.db.prepare('SELECT id,payload FROM capacity_reservations ORDER BY id').all()};}finally{opened.db.close();}
}
function installPublicationFault(file,kind){
 const identity=fs.lstatSync(file),originalWrite=fs.writeSync,originalSync=fs.fsyncSync;let hit=0,prefixBytes=0;
 const exact=fd=>{const s=fs.fstatSync(fd);return s.dev===identity.dev&&s.ino===identity.ino;};
 function fault(){hit++;process.stderr.write('EXACT_C2_PUBLICATION_FAULT:'+kind+'\n');return Object.assign(Error('exact C2 publication fault'),{code:'EIO',c2Fault:kind});}
 fs.writeSync=function(fd,buffer,offset,length,position){
  if(!hit&&kind!=='publication-fsync'&&exact(fd)){
   assert.ok(Buffer.isBuffer(buffer));assert.equal(length,4096);assert.ok(position===0||position===4096);
   if(kind==='publication-before-write')throw fault();
   fault();prefixBytes=originalWrite.call(fs,fd,buffer,offset,31,position);assert.equal(prefixBytes,31);return prefixBytes;
  }
  return originalWrite.apply(fs,arguments);
 };
 fs.fsyncSync=function(fd){if(!hit&&kind==='publication-fsync'&&exact(fd))throw fault();return originalSync.apply(fs,arguments);};
 return{restore(){fs.writeSync=originalWrite;fs.fsyncSync=originalSync;},proof(){return{hit,prefixBytes,dev:identity.dev,ino:identity.ino};}};
}
function assertReturned(f,id){const store=f.coordinator.store,spend=store.getSpend(id),buyer=f.credits.loadCredits().buyer;assert.equal(spend.state,'returned');assert.equal(buyer.dollar_lots[0].remaining_usd,0.02);assert.equal(buyer.dollar_lots[0].inflight_usd,0);assert.equal(store.getSource('fund').spentMicros,0);assert.equal(buyer.money_receipts[id+':restore'].digest,spend.digest);assert.equal(store.getAppliedEffect({participant:'credits',owner:'buyer',id:id+':restore'}).effect_digest,spend.digest);}
async function create(request){
 const helper=require('./helpers/money-compensation-native-fixture'),f=await helper.setup({onRoot:root=>fs.writeFileSync(request.locator,JSON.stringify({root}))}),m=f.coordinator.failureControl,x=location(f),initialEarnings=digest(fs.readFileSync(x.earnings));let spendId,walId=null,outcome,selectedSlot=null,publicationProof=null;
 try{
  assert.equal(m,require('../lib/money-control').getMoneyRuntime().failureControl,'must exercise original runtime manager');
  await f.coordinator.withMoneyControl({accounts:['buyer']},async ctx=>{
   const debit=await f.credits.deductCredit('buyer','unlock',0.02);assert.equal(debit.success,true);spendId=debit.draws[0].spend_id;assert.equal(f.coordinator.store.getSpend(spendId).state,'acknowledged');
   const anchor=f.coordinator.recoveryAnchors.resolveCommittedAnchor({kind:'spend',id:spendId});
   if(request.kind==='oversized-learning'){
    const before=stable(f),slot=m.checkpointProof().slotDigest,large={...f.after,earnings:{large:'x'.repeat(f.profile.maxRowBytes+1)}};
    assert.throws(()=>f.wal.createLearningRecovery('learning',f.wal.captureLearningState(f.before),large),{code:'COMPENSATION_LEARNING_BOUND'});
    assert.deepEqual(stable(f),before);assert.equal(m.checkpointProof().slotDigest,slot);assert.equal(f.wal.getPendingWalEntries().length,0);
    const cap=m.requestCompensation({spendCapability:anchor,preWalCapability:debit.preWalCapability});f.wal.completeCompensationSync(cap);assertReturned(f,spendId);outcome='returned';return;
   }
   walId=f.wal.createWalEntry('unlock',{funding_source:'credit_pack',purchaser_account_id:'buyer',contributor_account_id:'maker',platform_earned:0.01,contributor_earned:0.01,dollar_draws:debit.draws},{preWalCapability:debit.preWalCapability});
   assert.equal(f.wal.readRecoveryWal(walId).accrualFence.state,'not_started');
   if(request.kind==='realized-refusal'){
    const cap=f.wal.beginEarningsWrite(walId),entry=require('../lib/earnings').initEarningsEntry('maker',null);Object.assign(entry,{total_gross:0.02,total_contributor:0.01,total_platform:0.01,pending_balance:0.01});
    f.wal.writeEarnings(walId,cap,()=>require('../lib/stripe-transfer-persistence').writeJSONAtomic(x.earnings,{maker:entry}));f.wal.markStepComplete(walId,'update_earnings');f.wal.commitWal(walId);ctx.flush();
    assert.equal(f.coordinator.store.getSpend(spendId).state,'realized');assert.equal(f.coordinator.store.getPool('unlock:'+walId).platformShareMicros,10000);
    const before=stable(f),slot=m.checkpointProof().slotDigest;
    assert.throws(()=>m.requestCompensation({spendCapability:anchor}),{code:'SPEND_RECONCILIATION_REQUIRED'});assert.throws(()=>f.wal.abortWal(walId,{}),{code:'COMPENSATION_AUTHORITY_REQUIRED'});
    assert.deepEqual(stable(f),before);assert.equal(m.checkpointProof().slotDigest,slot);outcome='realized';return;
   }
   const walCapability=f.wal.resolveWalCapability(walId);
   if(request.kind==='busy-first'){
    m.noteFailure({anchor,reason:'RECOVERY_REQUIRED',phase:'boot_recovery',cutStatus:'verified'});const before=stable(f),slot=m.checkpointProof();let cap;
    assert.throws(()=>{cap=m.requestCompensation({spendCapability:anchor,walCapability});},{code:'FINANCIAL_RECOVERY_REQUIRED'});assert.equal(cap,undefined);assert.deepEqual(stable(f),before);assert.equal(m.checkpointProof().slotDigest,slot.slotDigest);assert.equal(m.status().anchor.id,spendId);selectedSlot=slot.slotDigest;outcome='held';return;
   }
   if(request.kind.startsWith('publication-')){
    const before=stable(f),fault=installPublicationFault(x.control,request.kind);let cap,caught;
    try{cap=m.requestCompensation({spendCapability:anchor,walCapability});}catch(error){caught=error;}finally{fault.restore();}
    publicationProof=fault.proof();assert.equal(publicationProof.hit,1);assert.equal(cap,undefined);assert.ok(caught);
    if(request.kind==='publication-short-write'){assert.equal(publicationProof.prefixBytes,31);assert.equal(caught.code,'FAILURE_CONTROL_SHORT_WRITE');}else{assert.equal(caught.code,'EIO');assert.equal(caught.c2Fault,request.kind);}
    assert.throws(()=>m.assertNewEffectAllowed({action:'new_spend'}),{code:'FINANCIAL_RECOVERY_REQUIRED'});
    assert.throws(()=>f.credits.refundDollarDrawSync('buyer',debit.draws,{compensationCapability:{}}),{code:'COMPENSATION_AUTHORITY_REQUIRED'});
    assert.deepEqual(stable(f),before);const selected=m.status();assert.ok(['idle','compensation_requested'].includes(selected.state));if(request.kind==='publication-short-write'||request.kind==='publication-before-write')assert.equal(selected.state,'idle');
    outcome=selected.state==='compensation_requested'?'pending-marker':'held';return;
   }
   const cap=m.requestCompensation({spendCapability:anchor,walCapability});ctx.registerRecoveryAnchor(anchor,{action:'compensate'});const before=stable(f),slot=m.checkpointProof().slotDigest,wrong=structuredClone(debit.draws);
   if(request.kind==='vector-extra')wrong.push({...wrong[0]});else wrong[0].amount+=0.01;
   assert.throws(()=>f.credits.refundDollarDrawSync('buyer',wrong,{compensationCapability:cap}),{code:'COMPENSATION_DRAW_AUTHORITY_REQUIRED'});assert.deepEqual(stable(f),before);assert.equal(m.checkpointProof().slotDigest,slot);
   f.credits.refundDollarDrawSync('buyer',debit.draws,{compensationCapability:cap});ctx.flush();const revision=f.coordinator.store.readMetadata().revision;
   f.credits.refundDollarDrawSync('buyer',debit.draws,{compensationCapability:cap});ctx.flush();assert.equal(f.coordinator.store.readMetadata().revision,revision);f.wal.completeCompensationSync(cap);assertReturned(f,spendId);outcome='returned';
  });
  if(outcome==='returned')helper.scan(f.coordinator);
  const final=stable(f);if(outcome!=='realized')assert.equal(digest(fs.readFileSync(x.earnings)),initialEarnings);
  const saved={root:f.root,kind:request.kind,spendId,walId,outcome,selectedSlot,publicationProof,expectedEarningsDigest:digest(fs.readFileSync(x.earnings)),postAttempt:final};fs.writeFileSync(request.locator,JSON.stringify(saved));
  process.stdout.write('C2_ADMISSION_RESULT '+JSON.stringify({kind:request.kind,outcome,publicationProof,revision:final.metadata.revision})+'\n');
 }finally{try{f.coordinator.store.close();}catch(error){if(!f.coordinator.uncertain)throw error;}f.writer.close();}
}
function recover(request){
 const saved=JSON.parse(fs.readFileSync(request.locator)),helper=require('./helpers/money-compensation-native-fixture'),f=helper.reopen(saved.root),m=f.coordinator.failureControl;
 try{
  if(m.status().state==='compensation_requested'){assert.equal(saved.outcome,'pending-marker');const anchor=f.coordinator.recoveryAnchors.restore(m.status().anchor);f.coordinator.withMoneyBootControl({recoveryAnchor:anchor,action:'compensate'},()=>f.wal.completeCompensationSync(m.resumeCompensation()));}
  helper.scan(f.coordinator);const spend=f.coordinator.store.getSpend(saved.spendId),buyer=f.credits.loadCredits().buyer;
  if(saved.outcome==='held'){
   assert.equal(m.status().state,'failure_pending');assert.equal(m.status().anchor.kind,'spend');assert.equal(m.status().anchor.id,saved.spendId);assert.equal(spend.state,'acknowledged');assert.equal(buyer.dollar_lots[0].remaining_usd,0);assert.equal(buyer.dollar_lots[0].inflight_usd,0.02);assert.equal(buyer.money_receipts[saved.spendId+':restore'],undefined);assert.equal(f.wal.getPendingWalEntries().length,1);assert.equal(f.wal.readRecoveryWal(saved.walId).accrualFence.state,'not_started');assert.throws(()=>m.assertNewEffectAllowed({action:'new_spend'}),{code:'FINANCIAL_RECOVERY_REQUIRED'});assert.deepEqual(stable(f),saved.postAttempt);
  }else if(saved.outcome==='realized'){
   assert.equal(m.status().state,'idle');assert.equal(spend.state,'realized');assert.equal(buyer.dollar_lots[0].remaining_usd,0);assert.equal(f.coordinator.store.getPool('unlock:'+saved.walId).platformShareMicros,10000);assert.equal(f.wal.getPendingWalEntries().length,0);assert.deepEqual(stable(f),saved.postAttempt);
  }else{assertReturned(f,saved.spendId);assert.equal(m.status().state,'idle');assert.equal(f.wal.getPendingWalEntries().length,0);assert.deepEqual(fs.readdirSync(location(f).wal),[]);}
  assert.equal(digest(fs.readFileSync(location(f).earnings)),saved.expectedEarningsDigest);
  const current=stable(f);if(request.pass===2){const prior=JSON.parse(fs.readFileSync(request.locator));assert.deepEqual(current,prior.afterFirstCold,'second cold recovery cannot duplicate any participant/SQL effect');}else fs.writeFileSync(request.locator,JSON.stringify({...saved,afterFirstCold:current}));
 }finally{f.coordinator.store.close();f.writer.close();}
}
async function worker(request){if(request.mode==='create')await create(request);else recover(request);}
if(process.env.EMFR_C2_REQUEST)worker(JSON.parse(process.env.EMFR_C2_REQUEST)).catch(error=>{console.error(error);process.exitCode=1;});
else for(const kind of cases)test('native compensation admission '+kind,{skip:process.platform!=='linux'?'requires actual patched Linux financial runtime':false,timeout:120000},t=>{
 const box=fs.mkdtempSync(path.join(os.tmpdir(),'compensation-admission-')),locator=path.join(box,'locator.json');
 t.after(()=>{if(fs.existsSync(locator)){const owned=JSON.parse(fs.readFileSync(locator));if(owned.root)fs.rmSync(owned.root,{recursive:true,force:true});}fs.rmSync(box,{recursive:true,force:true});});
 const run=request=>spawnSync(process.execPath,[__filename],{env:{...process.env,NODE_TEST_CONTEXT:'isolated-native-c2',EMFR_C2_REQUEST:JSON.stringify({...request,locator})},encoding:'utf8',timeout:45000});
 for(const request of [{mode:'create',kind},{mode:'recover',kind,pass:1},{mode:'recover',kind,pass:2}]){const result=run(request);assert.equal(result.status,0,result.stdout+result.stderr);if(request.mode==='create'&&kind.startsWith('publication-'))assert.ok(result.stderr.includes('EXACT_C2_PUBLICATION_FAULT:'+kind),'exact original manager publication fault must be hit');}
});
