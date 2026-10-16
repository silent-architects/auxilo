'use strict';
// Synthetic real-API retention/replay proof; no provider network or release acceptance.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const lifecycle={schema_version:1,rule_version:'restore-flow-v1',approval_ref:'synthetic',deletion_barrier:{sequence:0,hash:'a'.repeat(64)},seals:[],records:[],holds:[]};
async function run(kind,locator){
 const h=require('./helpers/money-compensation-native-fixture'),e=require('../lib/financial-epoch'),cp=require('../lib/money-checkpoint'),p=require('../lib/stripe-transfer-persistence'),restore=require('../lib/money-atomic-restore'),lock=require('../lib/money-writer-lock');
 const f=await h.setup({onRoot:root=>fs.writeFileSync(locator,JSON.stringify({root,target:root+'-restored'}))}),scopeKey='stripe:'+f.epoch.platform_account_id+':test',capacity={mandatory:true,sourceId:'fund'};
 let quote,accepted,signed,receipt;
 if(kind!=='quote-replay'){
  await f.coordinator.withMoneyControl({},ctx=>ctx.acquireWorkspaceLease({scopeKey,generation:1,capacity}));
  await f.coordinator.withMoneyControl({},ctx=>ctx.advanceProviderScan({scopeKey,generation:1,expectedRevision:0,control:{generation:1,state:'scanning',cursor:'txn_restore',transactionCount:1},rows:[{providerId:'txn_restore',factId:'fact_restore',state:'available'}],capacity}));
  if(kind==='sealed-lease')await f.coordinator.withMoneyControl({},ctx=>ctx.sealProviderScan({scopeKey,generation:1,expectedRevision:1,control:{generation:1,state:'complete',balanceDigest:'b'.repeat(64)},seal:{complete:true,balanceDigest:'b'.repeat(64)},capacity}));
 }else{
  const {cost}=require('./helpers/money-quote-operational-fixture');
  await f.coordinator.withMoneyControl({},ctx=>{ctx.recordCost({...cost(f.epoch),sourceId:'fund'});ctx.recordCost({...cost(f.epoch,'incremental'),sourceId:'fund'});ctx.recordLiquidity({id:'cash',capacity:{...capacity,purpose:'provider_inventory'},revision:1,journal_revision:f.coordinator.store.readMetadata().revision,platform_account_id:f.epoch.platform_account_id,livemode:false,currency:'usd',availableMicros:20000,protectedLiabilityMicros:20000,restrictedCashMicros:0,exposureLimitMicros:0,complete:true,canonical:true,capitalApproved:true,observed_at:Date.now(),cutoff:'synthetic',digest:p.digestJSON({fixture:'restore-flow'}),reflectedEffectIds:[]});});
  quote=await f.coordinator.withMoneyControl({},ctx=>ctx.quoteReturn({accountId:'buyer',sourceId:'fund',maxGrossMicros:10000,costEvidenceId:'fee',incrementalCostEvidenceId:'refund-fee',incrementalCostMicros:0}));
  const input={accountId:'buyer',quoteId:quote.id,quoteHash:quote.hash,clientRequestKey:'11111111-1111-4111-8111-111111111111',operationId:'return-restore'};
  accepted=await f.coordinator.withMoneyControl({},ctx=>ctx.reserveReturn(input));assert.deepEqual(accepted.acceptedQuote,quote);
  const priorIntent=f.coordinator.store.getEvidence('checkout_intents','intent-buyer'),intent={...priorIntent.payload,pack_id:'synthetic',base_url:'https://auxilo.test',generation:3,prepared_at:f.epoch.not_before,configuration_generation:'synthetic',idempotency_key:'synthetic-restore-checkout'};intent.fingerprint=require('../lib/stripe-checkout-intents').checkoutFingerprint(intent);
  await f.coordinator.withMoneyControl({},ctx=>ctx.recordEvidence({namespace:'checkout_intents',id:intent.intent_id,payload:intent,expectedRevision:priorIntent.revision,capacity:{mandatory:true,checkoutIntentId:intent.intent_id,purpose:'provenance'},indexes:{accountId:'buyer',providerId:'cs_buyer',platform_account_id:f.epoch.platform_account_id,livemode:false}}));
  const Stripe=require('stripe'),secret='whsec_restore_fixture_123456789012345678',event={id:'evt_restore_retained',object:'event',type:'checkout.session.completed',livemode:false,data:{object:{id:'cs_buyer',object:'checkout.session',amount_total:2,currency:'usd',payment_intent:'pi_buyer',metadata:{account_id:'buyer',auxilo_checkout_intent_id:'intent-buyer'}}}},raw=JSON.stringify(event),signature=Stripe.webhooks.generateTestHeaderString({payload:raw,secret});
  const registry=require('../lib/stripe-platforms').createPlatformRegistry({env:{STRIPE_AUXILO_LLC_SECRET_KEY:'sk_test_fixture_12345678901234567890',STRIPE_AUXILO_LLC_WEBHOOK_SECRET:secret},clientFactory:()=>({webhooks:Stripe.webhooks})});
  const verified=registry.verifyPlatformEvent('auxilo_llc',raw,signature);signed={event:verified.event,context:verified.context,digest:require('node:crypto').createHash('sha256').update(raw).digest('hex')};
  await require('../lib/stripe-history-coverage').captureVerifiedEvent({rawBody:raw,event:signed.event,context:signed.context});
  // Explicit completed-receipt fixture. Funding itself is established by setup;
  // this case exercises unchanged completed-event replay, not new funding.
  const receipts=require('../lib/stripe-event-receipts').createEventReceiptStore();
  await f.coordinator.withMoneyControl({},()=>{receipts.begin({stripe_platform:f.epoch.platform,stripe_platform_account_id:f.epoch.platform_account_id,event_id:event.id,event_type:event.type,object_id:event.data.object.id,payload_digest:signed.digest,epoch_id:f.epoch.epoch_id,binding_digest:f.epoch.binding_digest,livemode:false});receipts.complete(f.epoch.platform,event.id,{disposition:'fixture_completed'});});receipt=receipts.get(f.epoch.platform,event.id);
 }
 if(kind.startsWith('invalid-')){
  if(kind==='invalid-orphan-member'||kind==='invalid-foreign-member'){
   const opened=require('../lib/money-database').openDatabase(f.coordinator.store.file,f.coordinator.store.descriptor);
   try{opened.db.prepare('INSERT INTO provider_scan_members(scope,generation,provider_id,fact_id,state) VALUES(?,?,?,?,?)').run(kind==='invalid-orphan-member'?'orphan-scope':scopeKey,kind==='invalid-orphan-member'?1:2,'txn_orphan','fact_orphan','available');}finally{opened.db.close();}
  }
  const file=path.join(f.epoch.financial_dir,require('../lib/money-workspace').CONTROL),bytes=fs.readFileSync(file),slot=65536,rows=[];
  for(let i=0;i<2;i++){const raw=bytes.subarray(i*slot,(i+1)*slot);try{const {checksum,...body}=JSON.parse(raw.subarray(0,raw.indexOf(0)));if(checksum===p.digestJSON(body))rows.push(body);}catch{}}
  rows.sort((a,b)=>b.sequence-a.sequence);const body=rows[0],lease=Object.values(body.leases)[0];
  if(kind==='invalid-owner'){lease.capacity.sourceId='foreign-source';lease.capacityDigest=p.digestJSON(lease.capacity);}
  if(kind==='invalid-cursor')lease.cursor='different-cursor';
  if(kind==='invalid-unowned')body.leases={};
  const out=Buffer.alloc(slot);Buffer.from(JSON.stringify({...body,checksum:p.digestJSON(body)})).copy(out);const fd=fs.openSync(file,'r+');try{fs.writeSync(fd,out,0,out.length,(body.sequence%2)*slot);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const revision=f.coordinator.store.readMetadata().revision;
  await assert.rejects(cp.createMoneyCheckpoint({epoch:f.epoch,writer:f.writer,coordinator:f.coordinator,sourceSha:'a'.repeat(40),lifecycleControl:lifecycle}),error=>{assert.equal(error.code,{'invalid-owner':'WORKSPACE_PROTECTED_OWNER_REQUIRED','invalid-cursor':'CHECKPOINT_LEASE_INVALID','invalid-unowned':'CHECKPOINT_UNOWNED_WORKSPACE','invalid-orphan-member':'RESTORE_SCAN_LEASE_REQUIRED','invalid-foreign-member':'RESTORE_SCAN_LEASE_REQUIRED'}[kind]);return true;});
  assert.equal(f.coordinator.store.readMetadata().revision,revision);f.coordinator.store.close();f.writer.close();return;
 }
 const before={leases:f.coordinator.store.workspaceStatus().leases,scan:f.coordinator.store.getProviderScan(scopeKey),members:f.coordinator.store.listProviderScanMembers({scopeKey,generation:1,limit:10}),seal:f.coordinator.store.getEvidence('provider_effects',scopeKey+':1:seal'),source:f.coordinator.store.getSource('fund'),operation:accepted};
 const cut=await cp.createMoneyCheckpoint({epoch:f.epoch,writer:f.writer,coordinator:f.coordinator,sourceSha:'a'.repeat(40),lifecycleControl:lifecycle}),checkpointDir=cp.checkpointDirectory(f.root,cut.checkpoint_id),targetRoot=f.root+'-restored';
 fs.mkdirSync(targetRoot,{mode:0o700});const writer=lock.acquireMoneyWriter({root:targetRoot});
 try{cp.restoreCheckpoint({checkpointDir,targetRoot,writer,authoritativeLifecycle:lifecycle,expectedCheckpointDigest:cut.digest});const barrier=p.readJSONStrict(path.join(targetRoot,cp.RESTORE)),base={schema:1,checkpointDigest:cut.digest,bindingDigest:f.epoch.binding_digest,profileDigest:p.digestJSON(f.profile),databaseSchema:3,barrierDigest:barrier.checksum,permanentBoundBytes:4*1048576,publicationBoundBytes:1048576,maxGrowthPages:64,maxNetOccupiedPages:64,evidenceRef:'synthetic lease and retained receipt flow'},executionApprovalRef='explicit-native-fixture';await cp.restoreCheckpointCapacity({targetRoot,writer,checkpointDir,expectedCheckpointDigest:cut.digest,expectedBarrierDigest:barrier.checksum,authoritativeLifecycle:lifecycle,executionApprovalRef,restoreAllowance:{...base,requestId:restore.deriveRestoreRequestId({targetRoot,executionApprovalRef,restoreAllowance:base})}});
 }finally{writer.close();f.coordinator.store.close();f.writer.close();}
 const child=spawnSync(process.execPath,[__filename],{env:{...process.env,EMFR_RESTORE_FLOW_CASE:'',EMFR_RESTORE_FLOW_VERIFY:JSON.stringify({targetRoot,kind,scopeKey,before,quote,signed,receipt})},encoding:'utf8',timeout:60000});assert.equal(child.status,0,child.stdout+child.stderr);
}
async function verify(x){
 const e=require('../lib/financial-epoch'),p=require('../lib/stripe-transfer-persistence'),cp=require('../lib/money-checkpoint');process.env.AUXILO_DATA_DIR=x.targetRoot;process.env.AUXILO_SQLITE_TMPDIR=path.join(x.targetRoot,'sqlite-runtime-temp');const writer=require('../lib/money-writer-lock').acquireMoneyWriter({root:x.targetRoot});
 try{const epoch=e.resolveRuntimeEpoch({root:x.targetRoot,writer}),money=require('../lib/money-control').initializeMoneyRuntime({epoch,writer}),store=money.store;require('./helpers/money-compensation-native-fixture').scan(money);
 assert.deepEqual(store.workspaceStatus().leases,x.before.leases);assert.deepEqual(store.getProviderScan(x.scopeKey),x.before.scan);assert.deepEqual(store.listProviderScanMembers({scopeKey:x.scopeKey,generation:1,limit:10}),x.before.members);assert.deepEqual(store.getEvidence('provider_effects',x.scopeKey+':1:seal'),x.before.seal);assert.deepEqual(store.getSource('fund'),x.before.source);
 if(x.kind==='quote-replay'){
  assert.deepEqual(store.getOperation(x.before.operation.id),x.before.operation);const revision=store.readMetadata().revision;
  const again=await money.withMoneyControl({},ctx=>ctx.reserveReturn({accountId:'buyer',quoteId:x.quote.id,quoteHash:x.quote.hash,clientRequestKey:'11111111-1111-4111-8111-111111111111',operationId:'return-restore'}));assert.deepEqual(again,x.before.operation);
  const receipts=require('../lib/stripe-event-receipts').createEventReceiptStore(),dispatcher=require('../lib/stripe-event-dispatch').createStripeEventDispatcher({epoch,coordinator:money,receipts});
  const result=await dispatcher.dispatch(x.signed.event,x.signed.context,x.signed.digest);assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.already_processed,true);assert.deepEqual(receipts.get(epoch.platform,x.signed.event.id),x.receipt);assert.equal(store.readMetadata().revision,revision);assert.deepEqual(store.getSource('fund'),x.before.source);
 }
 const cut=await cp.createMoneyCheckpoint({epoch,writer,coordinator:money,sourceSha:'a'.repeat(40),lifecycleControl:lifecycle});assert.ok(cut.digest);const barrier=p.readJSONStrict(path.join(x.targetRoot,cp.RESTORE));assert.equal(barrier.state,'reconcile_only');assert.equal(barrier.provider_reconciliation_complete,false);store.close();
 }finally{writer.close();}
}
if(process.env.EMFR_RESTORE_FLOW_VERIFY)verify(JSON.parse(process.env.EMFR_RESTORE_FLOW_VERIFY)).catch(error=>{console.error(error);process.exitCode=1;});
else if(process.env.EMFR_RESTORE_FLOW_CASE){const x=JSON.parse(process.env.EMFR_RESTORE_FLOW_CASE);run(x.kind,x.locator).catch(error=>{console.error(error);process.exitCode=1;});}
else for(const kind of ['live-lease','sealed-lease','quote-replay','invalid-owner','invalid-cursor','invalid-unowned','invalid-orphan-member','invalid-foreign-member'])test('native physical restore flow '+kind,{skip:process.platform!=='linux'?'requires patched Linux SQLite':false,timeout:120000},t=>{const box=fs.mkdtempSync(path.join(os.tmpdir(),'restore-flow-')),locator=path.join(box,'locator.json');t.after(()=>{if(fs.existsSync(locator)){const x=JSON.parse(fs.readFileSync(locator));for(const k of ['root','target'])fs.rmSync(x[k],{recursive:true,force:true});}fs.rmSync(box,{recursive:true,force:true});});const child=spawnSync(process.execPath,[__filename],{env:{...process.env,EMFR_RESTORE_FLOW_CASE:JSON.stringify({kind,locator})},encoding:'utf8',timeout:100000});assert.equal(child.status,0,child.stdout+child.stderr);});
