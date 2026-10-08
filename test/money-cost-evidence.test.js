'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collectChargeCost, validateRefundCostContract, validateChargeCost } = require('../lib/money-cost-evidence');
const source = { id:'source1', charge_id:'ch_original', amountMicros:100000000, currency:'usd', platform:'auxilo_llc', platform_account_id:'acct_llc', livemode:false };
const context = {stripe_platform:'auxilo_llc',stripe_platform_account_id:'acct_llc',livemode:false};
const contract={id:'original1',sourceId:'source1',provider:'stripe',platform_account_id:'acct_llc',livemode:false,currency:'usd',pricing_model:'blended',all_components_in_balance_transaction:true,approved:true,complete:true,final:true,evidence_ref:'contract/completeness',valid_from:0,valid_until:2000};
function charge(){return {id:'ch_original',object:'charge',paid:true,captured:true,status:'succeeded',livemode:false,currency:'usd',amount:10000,balance_transaction:{id:'txn_charge',object:'balance_transaction',source:'ch_original',currency:'usd',amount:10000,fee:320,net:9680,fee_details:[{type:'stripe_fee',amount:320,currency:'usd'}]}};}
test('original charge fee is exact integer provider evidence, separate from incremental exact-zero contract',()=>{
 const evidence=validateChargeCost({source,context,charge:charge(),contract,observedAt:1000});
 assert.equal(evidence.amountMicros,3200000); assert.equal(evidence.kind,'original');
 const refund=validateRefundCostContract({source,context,contract:{id:'zero1',sourceId:'source1',provider:'stripe',platform_account_id:'acct_llc',livemode:false,currency:'usd',amountMicros:0,complete:true,final:true,approved:true,evidence_ref:'contract/llc/refund',valid_from:0,valid_until:2000},now:1000});
 assert.equal(refund.amountMicros,0);assert.equal(refund.kind,'incremental');
});
test('null/missing fee, inconsistent amount/net/components and wrong charge/mode/currency fail closed',()=>{
 for(const change of [c=>c.balance_transaction.fee=null,c=>c.balance_transaction.fee_details=[],c=>c.balance_transaction.net++,c=>c.balance_transaction.fee_details[0].amount--,c=>c.currency='eur',c=>c.livemode=true,c=>c.id='ch_other',c=>c.captured=false,c=>c.balance_transaction.currency='eur']){const c=charge();change(c);assert.throws(()=>validateChargeCost({source,context,charge:c,contract,observedAt:1000}),{code:'COST_EVIDENCE_UNAVAILABLE'});}
});
test('tariff, missing/expired/unapproved/wrong-account contract is unavailable, never implicit zero',()=>{
 const contract={id:'c1',provider:'stripe',sourceId:'source1',platform_account_id:'acct_llc',livemode:false,currency:'usd',amountMicros:0,complete:true,final:true,approved:true,evidence_ref:'signed-contract',valid_from:0,valid_until:2000};
 for(const bad of [null,{...contract,tariff:true},{...contract,approved:false},{...contract,valid_until:999},{...contract,platform_account_id:'acct_legacy'},{...contract,amountMicros:null}])assert.throws(()=>validateRefundCostContract({source,context,contract:bad,now:1000}),{code:'COST_EVIDENCE_UNAVAILABLE'});
});
test('collector uses allowlisted SDK expansion and verifies opaque capability before and after await',async()=>{
 let calls=0,checks=0;const client={charges:{retrieve:async(id,params)=>{calls++;assert.equal(id,'ch_original');assert.deepEqual(params,{expand:['balance_transaction']});return charge();}}};
 const registry={assertVerifiedContext:c=>{assert.equal(c,context);checks++;return client;}};
 const evidence=await collectChargeCost({registry,context,source,contract,clock:()=>1000});assert.equal(evidence.amountMicros,3200000);assert.equal(calls,1);assert.equal(checks,2);
});
test('IC+ and unproved original-cost completeness stay unavailable despite balanced charge arithmetic',()=>{
 for(const bad of [undefined,{...contract,pricing_model:'ic_plus'},{...contract,all_components_in_balance_transaction:false},{...contract,tariff:true}])assert.throws(()=>validateChargeCost({source,context,charge:charge(),contract:bad,observedAt:1000}),{code:'COST_EVIDENCE_UNAVAILABLE'});
});
function liquidityFixture({unknown=false,incomplete=false,changed=false}={}){
 const {createStripeLiquidityCollector}=require('../lib/funds-return');const epoch={epoch_id:'e1',binding_digest:'a'.repeat(64),platform:'auxilo_llc',platform_account_id:'acct_llc',livemode:false};
 const snapshot={revision:1,sources:{s1:{...source,spentMicros:0,retiredMicros:0}},operations:{},pools:{},liquidity_evidence:{}};
 const evidence={...epoch,currency:'usd',approved:true,obligations_complete:true,inventory_complete:true,evidence_ref:'money/capital',cutoff_ref:'inventory/cut1',external_effects:[],otherProtectedLiabilityMicros:0,restrictedCashMicros:0,exposureLimitMicros:3200000,valid_from:0,valid_until:2000};let balances=0;
 const client={balance:{retrieve:async()=>({object:'balance',livemode:false,available:[{currency:'usd',amount:changed&&balances++?1:9680}],pending:[]})},balanceTransactions:{list:async()=>({data:[{id:'txn_charge',object:'balance_transaction',source:unknown?'ch_unowned':'ch_original',currency:'usd',amount:10000,fee:320,net:9680,status:'available'}],has_more:incomplete})}};
 const registry={getVerifiedClient:async()=>({context,client}),assertVerifiedContext:()=>client};
 return createStripeLiquidityCollector({registry,epoch,store:{read:()=>snapshot},readEvidence:()=>evidence,clock:()=>1000,maxPagesPerBatch:1});
}
test('canonical liquidity cut uses available assets only and conserves principal liabilities',async()=>{const value=await liquidityFixture()();assert.equal(value.availableMicros,96800000);assert.equal(value.protectedLiabilityMicros,100000000);assert.deepEqual(value.reflectedEffectIds,['txn_charge']);assert.equal(value.complete,true);});
test('unknown movement, incomplete enumeration, or changing balance refuses cash admission',async()=>{for(const opts of [{unknown:true},{incomplete:true},{changed:true}])await assert.rejects(liquidityFixture(opts)(),error=>/^RETURN_/.test(error.code));});

function returnedLiquidityFixture({placement='operation',mutateProof,unknown=false,negativeFunding=false}={}){
 const {createStripeLiquidityCollector}=require('../lib/funds-return'),{digestJSON}=require('../lib/stripe-transfer-persistence');
 const epoch={epoch_id:'e1',binding_digest:'a'.repeat(64),platform:'auxilo_llc',platform_account_id:'acct_llc',livemode:false};
 const transactions=[{id:'txn_debit',source:'re_failed',currency:'usd',amount:-5000,fee:30,net:-5030,status:'available'},{id:'txn_return',source:'re_failed',currency:'usd',amount:5000,fee:-20,net:5020,status:'available'}];
 const observation={canonical:true,verified:true,complete:true,platform_account_id:epoch.platform_account_id,livemode:false,currency:'usd',refund_id:'re_failed',charge_id:'ch_original',payment_intent_id:'pi_original',confirmedFundsReturned:true,incurredCostMicros:100000,returnedFundsEvidence:{debit_id:'txn_debit',return_id:'txn_return',debitFeeMicros:300000,transactions,complete:true,final:true,digest:digestJSON(transactions)}};
 if(mutateProof)mutateProof(observation,digestJSON);
 const operation={...epoch,id:'op',type:'buyer_return',sourceId:'source1',accountId:'buyer',N:50000000,incrementalCostMicros:0,state:'failed',refund_id:'re_failed'};
 const snapshot={revision:7,sources:{source1:{...source,...epoch,accountId:'buyer',payment_intent_id:'pi_original',spentMicros:0,retiredMicros:0}},operations:{op:operation},pools:{p1:{contributorShareMicros:40000000,contributorReversedMicros:10000000}},liquidity_evidence:{},provider_observations:{}};
 if(!unknown){if(placement==='operation')operation.failure={observation};else snapshot.provider_observations.correction={record:{operationId:placement==='orphan'?'missing-operation':'op',observation}};}
 const charge={id:'txn_charge',source:'ch_original',currency:'usd',amount:10000,fee:negativeFunding?-20:320,net:negativeFunding?10020:9680,status:'available'};
 const rows=negativeFunding?[charge]:[charge,...transactions];
 const client={balance:{retrieve:async()=>({object:'balance',livemode:false,available:[{currency:'usd',amount:9670}],pending:[]})},balanceTransactions:{list:async()=>({data:rows.map(x=>({...x,object:'balance_transaction'})),has_more:false})}};
 const registry={getVerifiedClient:async()=>({context,client}),assertVerifiedContext:()=>client};
 const evidence={...epoch,currency:'usd',approved:true,obligations_complete:true,inventory_complete:true,evidence_ref:'approved-capital',cutoff_ref:'complete-cut',external_effects:[],otherProtectedLiabilityMicros:0,restrictedCashMicros:0,exposureLimitMicros:100000000,valid_from:0,valid_until:2000};
 return createStripeLiquidityCollector({registry,epoch,store:{read:()=>snapshot},readEvidence:()=>evidence,clock:()=>1000,maxPagesPerBatch:1});
}
test('canonical failed-return cash and negative fee rebate enter liquidity from exact operation or correction proof',async()=>{
 for(const placement of ['operation','correction']){const cash=await returnedLiquidityFixture({placement})();assert.equal(cash.availableMicros,96700000);assert.equal(cash.protectedLiabilityMicros,130000000);assert.equal(cash.journal_revision,7);assert.deepEqual(cash.reflectedEffectIds,['txn_charge','txn_debit','txn_return']);}
});
test('unknown negative fees and spoofed failure proof cannot become available cash evidence',async()=>{
 const attacks=[{unknown:true},{negativeFunding:true},{placement:'orphan'},...[
  o=>o.returnedFundsEvidence.digest='f'.repeat(64),o=>o.platform_account_id='acct_foreign',
  (o,digest)=>{o.refund_id='re_foreign';},
  (o,digest)=>{o.returnedFundsEvidence.debit_id='txn_unrelated';},
  (o,digest)=>{const row=o.returnedFundsEvidence.transactions[1];row.amount--;row.net--;o.returnedFundsEvidence.digest=digest(o.returnedFundsEvidence.transactions);},
 ].map(mutateProof=>({mutateProof}))];
 for(const attack of attacks)await assert.rejects(returnedLiquidityFixture(attack)(),{code:'RETURN_UNKNOWN_BALANCE_MOVEMENT'});
});
test('actual initialized runtime rejects a stale collector journal generation before recording cash',async t=>{
 const fixture=require('./helpers/financial-epoch-fixture'),f=fixture.boot(t),capacityEvidence=fixture.capacityEvidence(f.epoch);
 f.epoch=require('../lib/financial-epoch-operator').transitionEpoch({epoch:f.epoch,writer:f.writer,expectedRevision:0,patch:{reconcile:true},evidence:{approval_ref:'synthetic-cash-generation-proof',reconcile:'a'.repeat(64)},financialEvidence:capacityEvidence});
 const money=require('../lib/money-control').initializeMoneyRuntime(f),{createStripeLiquidityCollector}=require('../lib/funds-return');
 // Explicit legacy-compatible reconciliation reserve, physically initialized.
 // New funding remains unavailable: this fixture does not accept an atomic profile.
 await require('../lib/money-capacity').initializeCapacityReserve({epoch:f.epoch,writer:f.writer,store:money.store,profile:capacityEvidence.capacity_profile});
 t.after(()=>{try{money.store.close();}catch{}});
 assert.equal(money.capacityStatus().newAdmissionAvailable,false);
 const scoped={stripe_platform:f.epoch.platform,stripe_platform_account_id:f.epoch.platform_account_id,livemode:false};
 const client={balance:{retrieve:async()=>({object:'balance',livemode:false,available:[],pending:[]})},balanceTransactions:{list:async()=>({data:[],has_more:false})}};
 const evidence={...f.epoch,currency:'usd',approved:true,obligations_complete:true,inventory_complete:true,evidence_ref:'approved-empty-epoch-cut',cutoff_ref:'cut',external_effects:[],otherProtectedLiabilityMicros:0,restrictedCashMicros:0,exposureLimitMicros:0,valid_from:0,valid_until:Number.MAX_SAFE_INTEGER};
 const collect=createStripeLiquidityCollector({registry:{getVerifiedClient:async()=>({client,context:scoped}),assertVerifiedContext:()=>client},epoch:f.epoch,store:money.store,readEvidence:()=>evidence});
 const observed=await collect();await assert.rejects(money.withMoneyControl({},ctx=>ctx.recordLiquidity({...observed,journal_revision:undefined})),{code:'LIQUIDITY_JOURNAL_GENERATION_REQUIRED'});
 await money.withMoneyControl({},ctx=>ctx.recordLiquidity(observed));
 await assert.rejects(money.withMoneyControl({},ctx=>ctx.recordLiquidity({...observed,id:'stale',revision:observed.revision+1})),{code:'LIQUIDITY_JOURNAL_GENERATION_CHANGED'});
 const fresh=await collect();await money.withMoneyControl({},ctx=>ctx.recordLiquidity(fresh));assert.equal(Object.keys(money.store.read().liquidity_evidence).length,2);
});
