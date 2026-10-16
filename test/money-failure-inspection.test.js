'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openMoneyStore}=require('../lib/money-control-store'),{createMoneyControl}=require('../lib/money-control');
for(const phase of ['before-transaction','after-metadata','after-commit'])test('private failure inspection proves fresh cut after '+phase+' without reopening poisoned getters',async t=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'failure-inspection-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const epoch={epoch_id:'inspect',binding_digest:'a'.repeat(64),legacy_root:dir,financial_dir:dir,platform:'auxilo_llc',platform_account_id:'acct_test',livemode:false};const writer=require('../lib/money-writer-lock').injectMoneyWriter({root:dir,assertOwned:()=>true});const descriptor=require('../lib/money-database').createMoneyDatabase({file:path.join(dir,'money-control.sqlite'),epoch});fs.writeFileSync(path.join(dir,'money-control.json'),JSON.stringify(descriptor),{mode:0o600});let armed=false;
 const store=openMoneyStore({epoch,writer,testFault:p=>{if(armed&&p===phase){armed=false;throw Error('injected-'+phase);}}}),coordinator=createMoneyControl({epoch,writer,store});
 await coordinator.withMoneyControl({},ctx=>{ctx.recordFundingSource({id:'source',accountId:'buyer',charge_id:'ch',payment_intent_id:'pi',currency:'usd',amountMicros:1000000,epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,platform:epoch.platform,platform_account_id:epoch.platform_account_id,livemode:false,policy:{version:'v1',effective_at:1,accepted_at:2,acknowledged:true,evidence_ref:'consent'},created_at:3,provenance:{verified:true,intent_id:'intent',origin_id:'origin',purchase_id:'purchase',lot_id:'lot',receipt_digest:'b'.repeat(64)}});ctx.prepareSpend({id:'spend',accountId:'buyer',draws:[{sourceId:'source',amountMicros:10000}]});});
 const anchors=require('../lib/money-recovery-anchor').createRecoveryAnchors({epoch,writer,store}),anchor=anchors.resolveCommittedAnchor({kind:'spend',id:'spend'}),role=require('../lib/money-failure-control').initializeFailureControl({epoch,writer,store});
 // File primitive uses a synthetic external role; financial SQL remains the real
 // database and ordinary poison guard. Atomic native recovery has separate tests.
 const manager=require('../lib/money-failure-control').openFailureControl({epoch,writer,anchors,store:{...store,getCapacityRecord:id=>id==='capacity:root'?{failureControl:role}:store.getCapacityRecord(id)}});
 armed=true;await assert.rejects(()=>coordinator.withMoneyControl({},ctx=>ctx.recordException({id:'fault',kind:'synthetic'})),{code:'MONEY_STORE_UNCERTAIN'});
 manager.noteFailure({anchor,reason:'MANDATORY_WRITE_FAILED',phase:'persist_result',cutStatus:'unverified'});
 const proof=await manager.inspectRecoveryCut();assert.equal(proof.revision,phase==='after-commit'?2:1);assert.equal(proof.resolvedPhysical,true);assert.throws(()=>store.readMetadata(),{code:'MONEY_STORE_UNCERTAIN'});
 const again=await manager.inspectRecoveryCut();assert.equal(again.revision,proof.revision);assert.equal(again.rootDigest,proof.rootDigest);
 const fresh=openMoneyStore({epoch,writer});try{assert.equal(fresh.readMetadata().revision,proof.revision);assert.equal(fresh.getSpend('spend').state,'prepared');}finally{fresh.close();}
});
