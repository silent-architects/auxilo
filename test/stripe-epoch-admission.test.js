'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateManifest,checkoutFingerprint}=require('../lib/stripe-checkout-intents');
const {createCheckoutAdmission}=require('../lib/stripe-checkout-admission');
const manifest={scope:'prospective_epoch',inventory_scope:'fresh_epoch_only',inventory_complete:true,epoch_id:'epoch1',binding_digest:'a'.repeat(64),checkpoint_id:'cp',manifest_sha256:'a'.repeat(64),approval_ref:'approved',interval_evidence_ref:'interval',platform:'auxilo_llc',platform_account_id:'acct_1UMsxYLVAUzbAOHI',livemode:false};
test('prospective manifest never represents complete historical inventory or another platform',()=>{
 assert.doesNotThrow(()=>validateManifest(manifest));for(const change of [{inventory_scope:'all_history'},{binding_digest:'bad'},{platform:'legacy'},{interval_evidence_ref:null},{livemode:undefined}])assert.throws(()=>validateManifest({...manifest,...change}));
});
test('anonymous lifecycle successor requires exact sealed totals and binding without identifier tombstones',()=>{
 const {digestJSON}=require('../lib/stripe-transfer-persistence');
 const totals={currency:'usd',period:'2026',count:5,nonspendable:true,...Object.fromEntries(['source_amount','spent','retired','cost','cost_covered','cost_recovered','platform_share','reversed','recovered','backing','obligation','subsidy'].map(k=>[k+'_micros',0]))};
 const cutoff='2026-01-01T00:00:00.000Z';const seal={namespace:'stripe:auxilo_llc:false',source_created_through:cutoff,closed_epoch:1,aggregate_checkpoint_hash:digestJSON(totals),rule_version:'retention-v1'};
 const body={schema_version:1,binding_digest:manifest.binding_digest,prior_participant_checksum:'b'.repeat(64),source_created_through:cutoff,seal,conserved_totals:totals};
 const valid={...manifest,lifecycle_successor:{...body,receipt_digest:digestJSON(body)}};assert.doesNotThrow(()=>validateManifest(valid));
 for(const patch of [{binding_digest:'c'.repeat(64)},{source_created_through:'bad'},{retired_ids:['pi_private']},{conserved_totals:{...totals,count:1}},{seal:{...seal,aggregate_checkpoint_hash:'d'.repeat(64)}}]){const changed={...body,...patch};assert.throws(()=>validateManifest({...manifest,lifecycle_successor:{...changed,receipt_digest:digestJSON(changed)}}),{code:'EPOCH_LIFECYCLE_SUCCESSOR_INVALID'});}
});
test('Checkout request fingerprint binds new policy and epoch rather than merely same pack',()=>{
 const a={account_id:'a',pack_id:'starter',currency:'usd',amount_cents:1000,base_url:'https://auxilo.io',stripe_platform:'auxilo_llc',stripe_platform_account_id:manifest.platform_account_id,livemode:false,epoch_id:'epoch1',binding_digest:manifest.binding_digest,policy_version:'v1',policy_consent_id:'c1'};
 assert.notEqual(checkoutFingerprint(a),checkoutFingerprint({...a,policy_consent_id:'c2'}));
});
test('prospective Checkout verifies provider outside coordinator and commits submission before one unlocked POST',async()=>{
 let locked=false,calls=0,sequence=[];let row=null;
 const epoch={epoch_id:'e',binding_digest:'b',activation_revision:1,platform:'auxilo_llc',platform_account_id:manifest.platform_account_id,livemode:false};
 const context={stripe_platform:epoch.platform,stripe_platform_account_id:epoch.platform_account_id,livemode:false,configuration_generation:'gen'};
 const intents={ready:true,blocking:()=>row&&['prepared','submitted','unknown'].includes(row.state)?row:null,findOpen:()=>null,prepare:input=>{assert.equal(locked,true);sequence.push('prepare');return row={...input,intent_id:'i',idempotency_key:'key',state:'prepared',generation:1};},get:()=>row,transition:(id,generation,state,patch={})=>{assert.equal(locked,true);row={...row,...patch,state,generation:generation+1};sequence.push(state);return row;}};
 const coordinator={withMoneyControl:async(_opts,fn)=>{assert.equal(locked,false);locked=true;try{return await fn({assertFundingCapacity:input=>{assert.equal(input.amountMicros,10000000);sequence.push('capacity-check');},reserveFundingCapacity:input=>{assert.equal(input.intentId,'i');sequence.push('capacity-reserved');},flush:()=>sequence.push('flush')});}finally{locked=false;}}};
 const admission=createCheckoutAdmission({epoch,coordinator,intents,authorize:()=>true,policyConsent:()=>({policy_version:'v1',consent_id:'c1'}),control:()=>({intake_platform:epoch.platform,generation:1}),getContext:async()=>{assert.equal(locked,false);return context;},checkCaps:()=>{},reserve:()=>{assert.equal(locked,true);return 'reservation';},promote:()=>{assert.equal(locked,true);},createSession:async()=>{assert.equal(locked,false);assert.equal(row.state,'submitted');sequence.push('provider-post');calls++;return {session_id:'cs_1',url:'https://checkout.stripe.test/1',expires_at:2000000000};}});
 const result=await admission({accountId:'a',packId:'starter',amountUsd:10,baseUrl:'https://auxilo.io'});assert.equal(result.session_id,'cs_1');assert.equal(calls,1);assert.deepEqual(sequence,['capacity-check','prepare','capacity-reserved','flush','submitted','flush','provider-post','confirmed_open']);assert.equal(row.policy_consent_id,'c1');assert.equal(row.epoch_id,'e');
});

for(const code of ['CAPACITY_PROFILE_REQUIRED','FUNDING_CAPACITY_EXHAUSTED'])test('prospective Checkout '+code+' refuses before intent, cap reservation or provider dispatch',async()=>{
 const epoch={epoch_id:'e',binding_digest:'b',activation_revision:1,platform:'auxilo_llc',platform_account_id:manifest.platform_account_id,livemode:false};
 let prepared=0,reserved=0,posted=0;
 const admission=createCheckoutAdmission({epoch,
  coordinator:{withMoneyControl:async(_options,fn)=>fn({assertFundingCapacity:()=>{throw Object.assign(new Error(code),{code});},reserveFundingCapacity:()=>{reserved++;},flush:()=>{}})},
  intents:{ready:true,blocking:()=>null,findOpen:()=>null,prepare:()=>{prepared++;}},
  authorize:()=>true,policyConsent:()=>({policy_version:'v1',consent_id:'c1'}),
  getContext:async()=>({stripe_platform:epoch.platform,stripe_platform_account_id:epoch.platform_account_id,livemode:false}),
  checkCaps:()=>{},reserve:()=>{reserved++;},createSession:async()=>{posted++;}
 });
 await assert.rejects(admission({accountId:'a',packId:'starter',amountUsd:10,baseUrl:'https://auxilo.io'}),{code});
 assert.deepEqual({prepared,reserved,posted},{prepared:0,reserved:0,posted:0});
});
