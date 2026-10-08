"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {digestJSON}=require('../lib/stripe-transfer-persistence');
test('indexed adapter transactions and signed capture preserve durability without rewriting legacy prefix',async t=>{
 const f=require('./helpers/financial-epoch-fixture').boot(t),api=require('../lib/money-control'),storeFixture=require('../lib/money-control-store').openMoneyStore(f),money=api.createMoneyControl({...f,store:storeFixture});
 // Portable adapter transaction proof; real initialized capacity gates remain
 // covered by native signed-flow tests and explicit missing-reserve tests.
 const priorRuntime=api.getMoneyRuntime;api.getMoneyRuntime=()=>money;t.after(()=>{api.getMoneyRuntime=priorRuntime;try{storeFixture.close();}catch{}});
 const {epoch,root}=f,store=money.store,history=require('../lib/stripe-history-coverage'),before=fs.readFileSync(path.join(root,history.CAPTURE));
 const context={stripe_platform:epoch.platform,stripe_platform_account_id:epoch.platform_account_id,livemode:epoch.livemode};
 const stamp={...context,epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest};
 const intents=require('../lib/stripe-checkout-intents').createCheckoutIntentStore(),origins=require('../lib/stripe-object-origins').createOriginStore(),receipts=require('../lib/stripe-event-receipts').createEventReceiptStore();
 store.read=()=>{throw Error('full historical read forbidden');};
 let intent;
 await t.test('prepare and transition read the staged checkout row under one opaque transaction',async()=>{
  await money.withMoneyControl({accounts:['buyer']},()=>{intent=intents.prepare({...stamp,configuration_generation:'fixture',account_id:'buyer',pack_id:'starter',currency:'usd',amount_cents:1000,base_url:'https://example.invalid',policy_version:'v1',policy_consent_id:'consent'});intent=intents.transition(intent.intent_id,intent.generation,'submitted');assert.equal(intents.get(intent.intent_id).state,'submitted');});
  assert.equal(intents.get(intent.intent_id).generation,2);assert.equal(intents.blocking('buyer').intent_id,intent.intent_id);assert.throws(()=>intents.all(),{code:'BOUNDED_PROVENANCE_QUERY_REQUIRED'});
 });
 await t.test('immutable origin replay and event receipts use indexed ownership',async()=>{
  const origin={...stamp,object_kind:'payment_intent',provider_id:'pi_indexed',account_id:'buyer',evidence_ref:'fixture',first_observed_at:'2026-10-07T00:00:00Z',provenance_version:1};
  await money.withMoneyControl({accounts:['buyer']},()=>{origins.record(origin);origins.record(origin);receipts.begin({...stamp,event_id:'evt_receipt',event_type:'checkout.session.completed',object_id:'cs_indexed',payload_digest:'a'.repeat(64)});receipts.complete(epoch.platform,'evt_receipt',{disposition:'credited'});});
  assert.equal(origins.find(context,'payment_intent','pi_indexed').account_id,'buyer');assert.equal(receipts.get(epoch.platform,'evt_receipt').state,'completed');
  await assert.rejects(money.withMoneyControl({accounts:['buyer']},()=>origins.record({...origin,account_id:'other'})),/Conflicting immutable origin/);
 });
 await t.test('capture raw bytes commits before acknowledgement and duplicate does not write',async()=>{
  const event={id:'evt_indexed',type:'payment_intent.updated',livemode:epoch.livemode,data:{object:{id:'pi_indexed',object:'payment_intent'}}},rawBody=JSON.stringify(event);
  const first=await history.captureVerifiedEvent({rawBody,event,context});assert.equal(first.durably_recorded,true);const revision=store.readMetadata().revision;
  const again=await history.captureVerifiedEvent({rawBody,event,context});assert.equal(again.duplicate,true);assert.equal(store.readMetadata().revision,revision);
  const changed={...event,created:123};const conflict=await history.captureVerifiedEvent({rawBody:JSON.stringify(changed),event:changed,context});assert.equal(conflict.conflict,true);assert.equal((await history.captureVerifiedEvent({rawBody,event,context})).conflict,true);
  assert.deepEqual(fs.readFileSync(path.join(root,history.CAPTURE)),before);
 });
 await t.test('capture and head update rollback together before durable acknowledgement',async()=>{
  const original=money.withMoneyControl;money.withMoneyControl=(options,fn)=>original(options,ctx=>{const record=ctx.recordEvidence;ctx.recordEvidence=input=>{if(input.namespace==='capture_heads')throw Error('injected head failure');return record(input);};return fn(ctx);});
  const event={id:'evt_rollback',type:'payment_intent.updated',livemode:epoch.livemode,data:{object:{id:'pi_rollback',object:'payment_intent'}}},rawBody=JSON.stringify(event),digest=require('node:crypto').createHash('sha256').update(rawBody).digest('hex');
  try{await assert.rejects(history.captureVerifiedEvent({rawBody,event,context}),/injected head failure/);}finally{money.withMoneyControl=original;}
  assert.equal(history.indexedCaptureLookup(store,context,event.id,digest),undefined);
  const result=await history.captureVerifiedEvent({rawBody,event,context});assert.equal(result.duplicate,false);
 });
 await t.test('suffix can exceed old capture file cap without rewriting immutable root',async()=>{
  const filler='x'.repeat(490000);for(let i=0;i<35;i++){const event={id:'evt_large_'+i,type:'payment_intent.updated',livemode:epoch.livemode,data:{object:{id:'pi_large_'+i,object:'payment_intent',description:filler}}};await history.captureVerifiedEvent({rawBody:JSON.stringify(event),event,context});}
  assert.ok(fs.statSync(store.file).size>16*1024*1024);assert.deepEqual(fs.readFileSync(path.join(root,history.CAPTURE)),before);assert.equal(store.getEvidence('capture_heads','capture_suffix_v2').payload.historical_coverage,'unknown');
 });
 store.close();
});
