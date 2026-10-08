'use strict';
// Native-only synthetic fixture. No production acceptance or live records.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const fixture=require('./financial-epoch-fixture'),boundary=require('../../lib/financial-epoch'),operator=require('../../lib/financial-epoch-operator'),persistence=require('../../lib/stripe-transfer-persistence'),money=require('../../lib/money-control');
const write=(file,value)=>persistence.writeJSONAtomic(file,value);
async function setup({onRoot,testFault}={}){
 const cleanup=[],t={after:fn=>cleanup.push(fn)},f=fixture.bootAtomic(t,{onRoot});process.env.AUXILO_DATA_DIR=f.root;
 const evidence=fixture.atomicCapacityEvidence(f.epoch,{fundingCents:2,spendFragments:1,returnCount:1});
 const epoch=operator.transitionEpoch({epoch:f.epoch,writer:f.writer,expectedRevision:0,patch:{funding:true,spend:true,buyer_return:true,reconcile:true},evidence:{approval_ref:'synthetic-compensation-native',funding:'a'.repeat(64),spend:'b'.repeat(64),buyer_return:'c'.repeat(64),reconcile:'d'.repeat(64)},policyEvidence:{policy_version:f.epoch.policy_ref,published:true,effective_at:f.epoch.not_before,disclosure_sha256:'e'.repeat(64),evidence_ref:'f'.repeat(64)},financialEvidence:evidence});
 const store=require('../../lib/money-control-store').openMoneyStore({epoch,writer:f.writer,testFault});const coordinator=money.initializeMoneyRuntime({epoch,writer:f.writer,store});await fixture.initializeAtomicFixture(t,{epoch,writer:f.writer,money:coordinator,profile:evidence.capacity_profile});
 const wal=require('../../lib/wal');coordinator.failureControl.beginRecoveryScan();scan(coordinator);
 const lot=fixture.source(epoch,'buyer');delete lot.account_id; // addDollarLot/stampLotProvenance bind ownership through the credits account key.
 assert.equal(Object.hasOwn(lot,'account_id'),false);lot.remaining_usd=0.02;lot.original_usd=0.02;lot.inflight_usd=0;lot.funded_unlocks=[];
 write(boundary.pathFor('credits',epoch),{buyer:{period_start:'2026-01-01',period_end:'2099-01-01',dollar_lots:[lot]}});
 const intentState=boundary.readParticipant('stripe_checkout_intents',epoch),intent=intentState.intents[lot.checkout_intent_id];intent.amount_cents=2;write(boundary.pathFor('stripe_checkout_intents',epoch),boundary.seal(intentState));
 const purchase={...persistence.readJSONLStrict(boundary.pathFor('purchases',epoch))[0],amount_usd:0.02};fs.writeFileSync(boundary.pathFor('purchases',epoch),JSON.stringify(purchase)+'\n');
 const origin={...boundary.readParticipant('stripe_object_origins',epoch).records.find(x=>x.provider_id===lot.stripe_payment_intent),evidence_ref:'checkout-intent:'+lot.checkout_intent_id},stamp=Date.parse(epoch.not_before),capacity={mandatory:true,checkoutIntentId:lot.checkout_intent_id,purpose:'provenance'};
 await coordinator.withMoneyControl({},ctx=>ctx.reserveFundingCapacity({intentId:lot.checkout_intent_id,accountId:'buyer',amountMicros:20000}));
 await coordinator.withMoneyControl({},ctx=>{
  ctx.recordEvidence({namespace:'checkout_intents',id:intent.intent_id,payload:intent,capacity,indexes:{accountId:'buyer',providerId:intent.session_id,platform_account_id:epoch.platform_account_id,livemode:false}});
  ctx.recordEvidence({namespace:'object_origins',id:persistence.digestJSON([epoch.platform_account_id,false,'payment_intent',lot.stripe_payment_intent]),payload:origin,capacity,indexes:{accountId:'buyer',providerId:lot.stripe_payment_intent,platform_account_id:epoch.platform_account_id,livemode:false}});
  ctx.recordFundingSource({id:'fund',accountId:'buyer',charge_id:'ch_buyer',payment_intent_id:lot.stripe_payment_intent,currency:'usd',amountMicros:20000,epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,platform:epoch.platform,platform_account_id:epoch.platform_account_id,livemode:false,policy:{version:epoch.policy_ref,effective_at:stamp,accepted_at:stamp,acknowledged:true,evidence_ref:'fixture-assent',consent_id:lot.policy_consent_id},created_at:stamp,canonical_created_at:epoch.not_before,provenance:{verified:true,intent_id:lot.checkout_intent_id,origin_id:'origin-buyer',purchase_id:lot.purchase_id,lot_id:lot.lot_id,receipt_digest:'b'.repeat(64)}});
 });
 const before={id:'learning',quality:{unlocks:1,unlocks_total:1},demand:2,earnings:{total:0},unrelated:'keep'},after={...before,quality:{unlocks:2,unlocks_total:2},demand:3,earnings:{total:0.02}};
 write(path.join(f.root,'learnings.json'),[before,{id:'unrelated',value:'keep'}]);
 return{root:f.root,epoch,writer:f.writer,coordinator,wal,credits:require('../../lib/credits'),before,after,profile:evidence.capacity_profile};
}
function scan(coordinator){for(let count=0;coordinator.failureControl.status().state==='recovery_scan';count++){assert.ok(count<100,'bounded fixture scan failed to progress');coordinator.scanFailureRecoveryPageSync({limit:100});}}
function reopen(root){process.env.AUXILO_DATA_DIR=root;process.env.AUXILO_SQLITE_TMPDIR=path.join(root,'sqlite-runtime-temp');const writer=require('../../lib/money-writer-lock').injectMoneyWriter({root,assertOwned:()=>true}),epoch=boundary.resolveRuntimeEpoch({root,writer}),coordinator=money.initializeMoneyRuntime({epoch,writer});return{root,epoch,writer,coordinator,wal:require('../../lib/wal'),credits:require('../../lib/credits')};}
module.exports={setup,reopen,scan};
