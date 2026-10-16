"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {createCheckoutAdmission}=require('../lib/stripe-checkout-admission');
const {createStripeEventDispatcher}=require('../lib/stripe-event-dispatch');
const epoch={epoch_id:'e',binding_digest:'b'.repeat(64),activation_revision:1,platform:'auxilo_llc',platform_account_id:'acct_1UMsxYLVAUzbAOHI',livemode:false};
const context={stripe_platform:epoch.platform,stripe_platform_account_id:epoch.platform_account_id,livemode:false};
const error=code=>Object.assign(Error(code),{code});
// Explicit synthetic opaque manager adapter; core tests verify real capabilities.
function checkoutFixture({deny=false,failResult=false}={}){
 let row,committed,posts=0,locked=false;const log=[],anchor=Object.freeze({fixture:'committed-anchor'});
 const manager={assertNewEffectAllowed({action}){log.push('gate:'+action);if(deny)throw error('FINANCIAL_RECOVERY_REQUIRED');},assertRecoveryAllowed(a,{action}){assert.equal(a,anchor);log.push('recovery:'+action);},noteFailure(){log.push('failure');}};
 const coordinator={failureControl:manager,recoveryAnchors:{resolveCommittedAnchor(s){assert.equal(s.kind,'submitted_checkout');assert.equal(s.id,'i');assert.equal(committed.state,'submitted');log.push('mint');return anchor;}},withMoneyControl:async(opts,fn)=>{locked=true;try{if(opts.action==='persist_result'){assert.equal(opts.recoveryAnchor,anchor);if(failResult)throw error('FIXTURE_RESULT_WRITE_FAILED');}return await fn({assertFundingCapacity(){},reserveFundingCapacity(){},flush(){committed=structuredClone(row);log.push('flush');},registerRecoveryAnchor(a){assert.equal(a,anchor);}});}finally{locked=false;}}};
 const intents={ready:true,blocking:()=>null,findOpen:()=>null,get:()=>row,prepare:x=>row={...x,intent_id:'i',idempotency_key:'key',generation:1,state:'prepared'},transition:(id,generation,state,patch)=>row={...row,...patch,state,generation:generation+1}};
 const admission=createCheckoutAdmission({epoch,coordinator,intents,authorize:()=>true,policyConsent:()=>({policy_version:'v',consent_id:'c'}),getContext:async()=>context,checkCaps(){},reserve:()=>1,promote(){},createSession:async()=>{assert.equal(locked,false);assert.equal(committed.state,'submitted');assert.ok(log.includes('mint'));assert.ok(log.includes('gate:provider_submit'));posts++;return {session_id:'cs_x',url:'https://example.test',expires_at:2e9};}});
 return {admission,log,anchor,coordinator,get posts(){return posts;}};
}
const request={accountId:'buyer',packId:'starter',amountUsd:10,baseUrl:'https://example.test'};
test('checkout mints only committed submission and retains its capability for result segment',async()=>{const f=checkoutFixture();assert.equal((await f.admission(request)).session_id,'cs_x');assert.equal(f.posts,1);assert.ok(f.log.indexOf('mint')>f.log.lastIndexOf('flush'));});
test('first-failure gate denies checkout provider effect even without HTTP middleware',async()=>{const f=checkoutFixture({deny:true});await assert.rejects(f.admission(request));assert.equal(f.posts,0);});
test('result persistence refusal retains submitted anchor and never retries provider POST',async()=>{const f=checkoutFixture({failResult:true});await assert.rejects(f.admission(request));assert.equal(f.posts,1);assert.equal(f.log.filter(x=>x==='mint').length,1);});
test('direct epoch dispatch cannot effect before exact committed raw capture exists',async()=>{
 let begins=0,reads=0;
 const coordinator={failureControl:{assertRecoveryAllowed(){throw Error('must not reach recovery');}},recoveryAnchors:{resolveCommittedAnchor(s){assert.equal(s.kind,'verified_capture');throw error('RECOVERY_ANCHOR_NOT_COMMITTED');}},withMoneyControl:async(o,fn)=>fn({})};
 const dispatcher=createStripeEventDispatcher({epoch,coordinator,authorize:()=>true,receipts:{withLocks:async(c,e,fn)=>fn(),begin(){begins++;return {state:'processing'};},complete(){},quarantine(){}},reconcileFinancialEvent:async()=>{reads++;return{matched:true,complete:true};}});
 const event={id:'evt_missing',type:'charge.refunded',livemode:false,data:{object:{id:'ch_x',object:'charge'}}};
 const result=await dispatcher.dispatch(event,context,'a'.repeat(64));assert.equal(result.status,503);assert.equal(begins,0);assert.equal(reads,0);
});

test('pending-source recovery retains one demand anchor across canonical reads and result writes',async()=>{
 const {createEpochFinancialEventHandler}=require('../lib/stripe-refund-handlers');const capability=Object.freeze({synthetic:'source-demand'}),segments=[],kinds=[];
 const source={id:'s',accountId:'buyer',epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,platform_account_id:epoch.platform_account_id,livemode:false,charge_id:'ch_x',payment_intent_id:'pi_x',providerObservation:{canonical:true,verified:true,complete:false,cursor:{page:1}}};
 const coordinator={failureControl:{assertRecoveryAllowed(a,{action}){assert.equal(a,capability);assert.equal(action,'provider_reconcile');}},recoveryAnchors:{resolveCommittedAnchor(s){kinds.push(s.kind);assert.equal(s.id,'s');return capability;},revalidate:()=>({kind:'pending_source_observation',id:'s'})},withMoneyControl:async(o,fn)=>{segments.push(o);return fn({recordSourceObservation(){}});}};
 const store={descriptor:{schema:2},findSourceByProviderIdentity:()=>source,hasPendingSourceRefund:()=>false};let reads=0;
 const handler=createEpochFinancialEventHandler({epoch,store,coordinator,authorize(){},provider:{inspectChargeRefunds:async input=>{assert.equal(input.recoveryAnchor,capability);reads++;return{canonical:true,verified:true,complete:true,refunds:[]};}}});
 const result=await handler({context,event:{type:'charge.refunded',api_version:'2025-02-24.acacia',livemode:false,data:{object:{object:'charge',id:'ch_x',payment_intent:'pi_x'}}}});
 assert.equal(result.complete,true);assert.equal(reads,1);assert.deepEqual(kinds,['pending_source_observation']);assert.ok(segments.length>0);assert.ok(segments.every(o=>o.recoveryAnchor===capability&&o.action==='persist_result'));
});

test('failed raw capture carries original committed funding anchor and never claims raw payload retained',async()=>{
 const money=require('../lib/money-control'),prior=money.getMoneyRuntime,capability=Object.freeze({synthetic:'funding'}),history=require('../lib/stripe-history-coverage');let minted;
 const intent={epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,stripe_platform_account_id:epoch.platform_account_id,livemode:false,account_id:'buyer',amount_cents:1000,currency:'usd'};
 const runtime={epoch,store:{descriptor:{schema:2},getEvidence:(ns,id)=>ns==='checkout_intents'?{payload:intent}:null,findSourceByProviderIdentity:()=>null},failureControl:{},recoveryAnchors:{resolveCommittedAnchor(selector){minted=selector;return capability;}},withMoneyControl:async opts=>{assert.equal(opts.recoveryAnchor,capability);assert.equal(opts.action,'persist_result');throw error('FIXTURE_CAPTURE_DISK_FAILURE');}};
 money.getMoneyRuntime=()=>runtime;
 try{const event={id:'evt_uncaptured',type:'checkout.session.completed',livemode:false,data:{object:{id:'cs_capture',object:'checkout.session',livemode:false,amount_total:1000,currency:'usd',metadata:{account_id:'buyer',auxilo_checkout_intent_id:'intent'}}}};await assert.rejects(history.captureVerifiedEvent({rawBody:JSON.stringify(event),event,context}),{code:'FIXTURE_CAPTURE_DISK_FAILURE'});assert.deepEqual(minted,{kind:'submitted_checkout',id:'intent',accountId:'buyer'});}finally{money.getMoneyRuntime=prior;}
});

test('direct refund POST rejects a valid capability belonging to another durable operation',async()=>{
 const api=require('../lib/funds-return'),source={...epoch,id:'s',accountId:'buyer',charge_id:'ch_x',payment_intent_id:'pi_x',currency:'usd',amountMicros:1000000},operation={...epoch,id:'op_b',sourceId:'s',accountId:'buyer',quoteHash:'hash',G:1000000,D:1000000,N:1000000,C:0,r:0};let posts=0;
 const client={charges:{retrieve:async()=>({object:'charge',id:'ch_x',payment_intent:'pi_x',currency:'usd',livemode:false,amount:100,paid:true,captured:true,payment_method_details:{type:'card'}})},refunds:{create:async()=>{posts++;throw Error('unexpected');}}};
 const store={descriptor:{schema:2},getOperation:()=>operation};
 const coordinator={withMoneyControl(){},failureControl:{assertNewEffectAllowed(){}},recoveryAnchors:{revalidate:()=>({kind:'dispatch_operation',id:'op_a'})}};
 const provider=api.createStripeRefundProvider({epoch,store,coordinator,registry:{getVerifiedClient:async()=>({client,context}),assertVerifiedContext:()=>client}});const prepared=provider.prepare({source,operation});Object.assign(operation,{provider_payload:prepared.provider_payload,provider_payload_digest:prepared.payload_digest,provider_request_digest:prepared.request_digest,idempotency_key:prepared.idempotency_key});
 const result=await provider.submit({source,operation,recoveryAnchor:Object.freeze({synthetic:'other-operation'})});assert.equal(posts,0);assert.equal(result.state,'submission_unknown');
});

test('financial handler rejects foreign capture capability before dispute GET or participant effects',async()=>{
 const source={id:'s',accountId:'buyer',epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,platform_account_id:epoch.platform_account_id,livemode:false,charge_id:'ch_x',payment_intent_id:'pi_x'};let reads=0,writes=0;
 const coordinator={failureControl:{assertRecoveryAllowed(){}},recoveryAnchors:{revalidate:()=>({kind:'verified_capture',id:'foreign'})},withMoneyControl:async()=>{writes++;}};
 const handler=require('../lib/stripe-refund-handlers').createEpochFinancialEventHandler({epoch,coordinator,store:{descriptor:{schema:2},findSourceByProviderIdentity:()=>source},authorize(){},provider:{inspectDispute:async()=>{reads++;return{};}}});
 await assert.rejects(handler({context,rawDigest:'a'.repeat(64),recoveryAnchor:Object.freeze({synthetic:'foreign'}),event:{id:'evt_exact',type:'charge.dispute.created',api_version:'2025-02-24.acacia',livemode:false,data:{object:{id:'dp_x',object:'dispute',charge:'ch_x',payment_intent:'pi_x'}}}}),{code:'RECOVERY_ANCHOR_SCOPE_MISMATCH'});assert.equal(reads,0);assert.equal(writes,0);
});
