'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createFundsReturnService}=require('../lib/funds-return');
function fixture(){
 const epoch={epoch_id:'epoch1',binding_digest:'digest',platform:'auxilo_llc',platform_account_id:'acct_llc',livemode:false,activation_revision:1};
 const source={...epoch,id:'s1',accountId:'buyer',charge_id:'ch_a',payment_intent_id:'pi_a',currency:'usd',amountMicros:10000000,spentMicros:0,retiredMicros:0,created_at:1000,policy:{version:'v1',effective_at:900,accepted_at:950,acknowledged:true,evidence_ref:'consent'},provenance:{verified:true,intent_id:'ci',origin_id:'oi',purchase_id:'p',lot_id:'l',receipt_digest:'hash'}};
 const state={sources:{s1:source},operations:{},quotes:{q1:{id:'q1',accountId:'buyer',sourceId:'s1',hash:'h1'}},costs:{}};let locked=false,sends=0,reserves=0;
 const coordinator={withMoneyControl:async(opts,fn)=>{assert.equal(locked,false);locked=true;try{return await fn({recordCost:e=>{state.costs[e.id]=e;},recordLiquidity:()=>{},quoteReturn:()=>state.quotes.q1,reserveReturn:({accountId,quoteId,quoteHash,clientRequestKey})=>{reserves++;if(quoteHash!=='h1')throw Object.assign(new Error(),{code:'REQUOTE_REQUIRED'});const o={id:'o1',accountId,quoteId,quoteHash,sourceId:'s1',clientRequestKey,N:9000000,D:10000000,G:10000000,C:1000000,r:0,state:'reserved'};state.operations[o.id]=o;return o;},markDispatch:({operationId,payload,idempotencyKey,payloadDigest,requestDigest})=>Object.assign(state.operations[operationId],{state:'dispatch_intent',provider_payload:payload,idempotency_key:idempotencyKey,payload_digest:payloadDigest,request_digest:requestDigest}),noteSubmissionUnknown:({operationId,observation})=>Object.assign(state.operations[operationId],{state:'submission_unknown',observation}),observeOperation:({operationId,state:s,observation})=>Object.assign(state.operations[operationId],{state:s,observation})});}finally{locked=false;}}};
 const provider={collectCosts:async()=>{assert.equal(locked,false);return {original:{id:'c1'},incremental:{id:'c2',amountMicros:0}};},prepare:()=>({provider_payload:{charge:'ch_a',amount:900},idempotency_key:'key',payload_digest:'p',request_digest:'r'}),submit:async()=>{assert.equal(locked,false);sends++;return {state:'submission_unknown',canonical:false,reason:'LOST_RESPONSE'};},reconcile:async()=>({state:'submission_unknown',canonical:true,complete:true,reason:'NO_MATCH'})};
 const service=createFundsReturnService({epoch,store:{read:()=>structuredClone(state)},coordinator,provider,authorize:()=>true,collectLiquidity:async()=>{assert.equal(locked,false);return {};},clock:()=>1100});return {service,state,provider,coordinator,get sends(){return sends;},get reserves(){return reserves;}};
}
const request={accountId:'buyer',quoteId:'q1',quoteHash:'h1',clientRequestKey:'11111111-1111-4111-8111-111111111111'};
test('same confirmation identity returns durable unknown operation without repeat POST, even after reconciliation',async()=>{const f=fixture();const first=await f.service.confirm(request);assert.equal(first.state,'submission_unknown');const repeat=await f.service.confirm(request);assert.equal(repeat.id,first.id);await f.service.reconcile({operationId:first.id});await f.service.confirm(request);assert.equal(f.sends,1);assert.equal(f.reserves,1);});
test('owner scoped status/source/quote plus immutable request-key and quote binding',async()=>{const f=fixture();await assert.rejects(f.service.quote({accountId:'other',sourceId:'s1',maxGrossMicros:100}),{code:'RETURN_SOURCE_UNAVAILABLE'});await f.service.confirm(request);await assert.rejects(f.service.confirm({...request,quoteHash:'changed'}),{code:'IDEMPOTENCY_CONFLICT'});await assert.rejects(f.service.status({accountId:'other',operationId:'o1'}),{code:'RETURN_NOT_FOUND'});assert.equal((await f.service.sources({accountId:'other'})).length,0);assert.equal(f.sends,1);});
test('invalid request identity and client-selected cost/destination fail before reservation',async()=>{const f=fixture();await assert.rejects(f.service.confirm({...request,clientRequestKey:'bad'}),{code:'RETURN_INVALID_REQUEST'});await assert.rejects(f.service.confirm({...request,destination:'bank_other'}),{code:'RETURN_INVALID_REQUEST'});await assert.rejects(f.service.quote({accountId:'buyer',sourceId:'s1',maxGrossMicros:100,cost:0}),{code:'RETURN_INVALID_REQUEST'});assert.equal(f.reserves,0);assert.equal(f.sends,0);});
test('source balances exclude held returns and prepared spend without double counting retired principal',async()=>{
 const f=fixture();f.state.operations.o1={sourceId:'s1',D:3000000,state:'submission_unknown'};f.state.spends={a:{state:'prepared',draws:[{sourceId:'s1',amountMicros:1000000}]}};
 let [source]=await f.service.sources({accountId:'buyer'});assert.equal(source.availableMicros,6000000);assert.equal(source.heldMicros,4000000);
 f.state.operations.o1.principalRetired=true;f.state.operations.o1.state='succeeded_projection_pending';f.state.sources.s1.retiredMicros=3000000;
 [source]=await f.service.sources({accountId:'buyer'});assert.equal(source.availableMicros,6000000);assert.equal(source.heldMicros,1000000);
 f.state.sources.s1.frozen=true;[source]=await f.service.sources({accountId:'buyer'});assert.equal(source.availableMicros,0);assert.equal(source.available,false);
});

async function realFixture(t,{timeout=false}={}){
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const {initialSnapshot,openMoneyStore}=require('../lib/money-control-store');const {createMoneyControl,getActiveMoneyContext}=require('../lib/money-control');const {createStripeRefundProvider}=require('../lib/funds-return');
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'emfr-provider-integration-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const epoch={epoch_id:'epoch1',binding_digest:'a'.repeat(64),platform:'auxilo_llc',platform_account_id:'acct_llc',livemode:false,activation_revision:1,financial_dir:dir,legacy_root:dir};const writer=require('../lib/money-writer-lock').injectMoneyWriter({root:dir,assertOwned:()=>true});
 const descriptor=require('../lib/money-database').createMoneyDatabase({file:path.join(dir,'money-control.sqlite'),epoch,snapshot:initialSnapshot(epoch)});fs.writeFileSync(path.join(dir,'money-control.json'),JSON.stringify(descriptor),{mode:0o600});const store=openMoneyStore({epoch,writer});const coordinator=createMoneyControl({store,epoch,writer,clock:()=>1000000});
 const source={...epoch,id:'s1',accountId:'buyer',charge_id:'ch_original',payment_intent_id:'pi_original',currency:'usd',amountMicros:100000000,created_at:1000,policy:{version:'v1',effective_at:900,accepted_at:950,acknowledged:true,evidence_ref:'consent'},provenance:{verified:true,intent_id:'ci',origin_id:'oi',purchase_id:'p',lot_id:'l',receipt_digest:'hash'}};
 await coordinator.withMoneyControl({},ctx=>ctx.recordFundingSource(source));let sends=0;
 const charge={object:'charge',id:'ch_original',payment_intent:'pi_original',currency:'usd',livemode:false,amount:10000,paid:true,captured:true,status:'succeeded',payment_method_details:{type:'card'},balance_transaction:{object:'balance_transaction',id:'txn_original',source:'ch_original',currency:'usd',amount:10000,fee:320,net:9680,fee_details:[{type:'stripe_fee',amount:320,currency:'usd'}]}};
 const client={charges:{retrieve:async()=>{assert.equal(getActiveMoneyContext(),null);return charge;}},refunds:{create:async payload=>{assert.equal(getActiveMoneyContext(),null);sends++;if(timeout)throw new Error('lost');return {id:'re_ok',object:'refund',charge:'ch_original',payment_intent:'pi_original',amount:payload.amount,currency:'usd',status:'succeeded',metadata:payload.metadata,balance_transaction:'txn_refund'};},list:async()=>({data:[],has_more:false})}};
 const context={stripe_platform:'auxilo_llc',stripe_platform_account_id:'acct_llc',livemode:false};const registry={getVerifiedClient:async()=>({context,client}),assertVerifiedContext:c=>{assert.equal(c,context);return client;}};
 const provider=createStripeRefundProvider({epoch,registry,store,coordinator,clock:()=>1000000,originalCostContract:{id:'original_contract',sourceId:'s1',provider:'stripe',platform_account_id:'acct_llc',livemode:false,currency:'usd',pricing_model:'blended',all_components_in_balance_transaction:true,complete:true,final:true,approved:true,evidence_ref:'approved_completeness',valid_from:0,valid_until:2000000},refundCostContract:{id:'cost_contract',sourceId:'s1',provider:'stripe',platform_account_id:'acct_llc',livemode:false,currency:'usd',amountMicros:0,complete:true,final:true,approved:true,evidence_ref:'approved_exact_zero',valid_from:0,valid_until:2000000}});
 const liquidity={id:'b1',revision:1,platform_account_id:'acct_llc',livemode:false,currency:'usd',availableMicros:96800000,protectedLiabilityMicros:100000000,restrictedCashMicros:0,complete:true,canonical:true,observed_at:1000000,cutoff:'cut',digest:'d'.repeat(64),reflectedEffectIds:[],exposureLimitMicros:100000000,capitalApproved:true};
 const service=createFundsReturnService({epoch,store,coordinator,provider,clock:()=>1000000,authorize:()=>true,collectLiquidity:async()=>{assert.equal(getActiveMoneyContext(),null);return liquidity;}});
 return {service,store,coordinator,client,get sends(){return sends;}};
}
test('real coordinator/provider retires gross100 once for cash96.80 with original cost3.20',async t=>{
 const f=await realFixture(t);const quote=await f.service.quote({accountId:'buyer',sourceId:'s1',maxGrossMicros:100000000});assert.equal(quote.N,96800000);
 const input={...request,quoteId:quote.id,quoteHash:quote.hash};const result=await f.service.confirm(input);assert.equal(result.state,'succeeded_projection_pending');
 const projection=Object.values(f.store.read().projections)[0];assert.equal(projection.amountMicros,100000000);
 await f.coordinator.withMoneyControl({},ctx=>ctx.ackProjection({id:projection.id,digest:projection.digest,receipt:{projection_id:projection.id,digest:projection.digest}}));
 assert.equal((await f.service.status({accountId:'buyer',operationId:result.id})).state,'settled');assert.equal(f.store.read().sources.s1.retiredMicros,100000000);await f.service.confirm(input);assert.equal(f.sends,1);
});
test('real durable coordinator simultaneous duplicate confirms and later no-match keep single POST and held principal',async t=>{
 const f=await realFixture(t,{timeout:true});const quote=await f.service.quote({accountId:'buyer',sourceId:'s1',maxGrossMicros:100000000});const input={...request,quoteId:quote.id,quoteHash:quote.hash};
 const [a,b]=await Promise.all([f.service.confirm(input),f.service.confirm(input)]);assert.equal(a.id,b.id);await f.service.reconcile({operationId:a.id});assert.equal(f.sends,1);assert.equal(f.store.read().operations[a.id].state,'submission_unknown');
 await f.coordinator.withMoneyControl({},ctx=>assert.equal(ctx.availablePrincipal({sourceId:'s1',accountId:'buyer'}),0));
});
test('real provider failure charges no customer fee and later canonical rebate reverses platform exposure once',async t=>{
 const f=await realFixture(t);let refund,rebate=0,sends=0;
 f.client.refunds.create=async payload=>{sends++;return refund={object:'refund',id:'re_failed',charge:'ch_original',payment_intent:'pi_original',amount:payload.amount,currency:'usd',status:'failed',metadata:payload.metadata,balance_transaction:'txn_debit',failure_balance_transaction:'txn_return'};};
 f.client.refunds.list=async()=>({data:[refund],has_more:false});f.client.refunds.retrieve=async()=>refund;
 f.client.balanceTransactions={retrieve:async id=>{const amount=id==='txn_debit'?-refund.amount:refund.amount,fee=id==='txn_debit'?30:-rebate;return {id,object:'balance_transaction',source:refund.id,currency:'usd',status:'available',amount,fee,net:amount-fee,fee_details:fee?[{type:'stripe_fee',amount:fee,currency:'usd'}]:[]};}};
 const quote=await f.service.quote({accountId:'buyer',sourceId:'s1',maxGrossMicros:100000000});const failed=await f.service.confirm({...request,quoteId:quote.id,quoteHash:quote.hash});
 assert.equal(failed.state,'failed');assert.equal(failed.failureCustomerCostMicros,0);assert.equal(failed.failedCostMicros,300000);assert.equal(failed.failedCostExposureMicros,300000);
 const snapshot=f.store.read();assert.equal(snapshot.sources.s1.retiredMicros,0);assert.equal(snapshot.sources.s1.originalCostSettled,false);assert.equal(snapshot.costs[snapshot.sources.s1.originalCostId].recoveredMicros,0);
 rebate=20;const corrected=await f.service.reconcile({operationId:failed.id});assert.equal(corrected.failedCostReversedMicros,200000);assert.equal(corrected.failedCostExposureMicros,100000);
 await f.service.reconcile({operationId:failed.id});assert.equal(f.store.read().operations[failed.id].failedCostReversedMicros,200000);assert.equal(sends,1);
 // The collector consumes the actual persisted failure and correction proofs,
 // including the negative fee, before cash can be admitted again.
 const epoch=f.coordinator.epoch,context={stripe_platform:epoch.platform,stripe_platform_account_id:epoch.platform_account_id,livemode:false};
 f.client.balance={retrieve:async()=>({object:'balance',livemode:false,available:[{currency:'usd',amount:9670}],pending:[]})};
 f.client.balanceTransactions.list=async()=>({data:[{...(await f.client.charges.retrieve()).balance_transaction,status:'available'},await f.client.balanceTransactions.retrieve('txn_debit'),await f.client.balanceTransactions.retrieve('txn_return')],has_more:false});
 const evidence={...epoch,currency:'usd',approved:true,obligations_complete:true,inventory_complete:true,evidence_ref:'approved-fixture-cut',cutoff_ref:'complete-cut',external_effects:[],otherProtectedLiabilityMicros:0,restrictedCashMicros:0,exposureLimitMicros:100000000,valid_from:0,valid_until:2000000};
 const collect=require('../lib/funds-return').createStripeLiquidityCollector({epoch,store:f.store,coordinator:f.coordinator,clock:()=>1000000,registry:{getVerifiedClient:async()=>({context,client:f.client}),assertVerifiedContext:()=>f.client},readEvidence:()=>evidence});
 const cash=await collect();assert.equal(cash.availableMicros,96700000);assert.equal(cash.journal_revision,f.store.read().revision);assert.ok(cash.provider_inventory_ref);for(const id of ['txn_original','txn_debit','txn_return']){const current=f.store.getProviderCurrentFact(cash.provider_inventory_ref.scopeKey,id);assert.ok(current,'complete current cut must contain '+id);const fact=f.store.getEvidence('provider_effects',current.factId).payload;assert.equal(fact.id,id);assert.equal(fact.status,'available');assert.equal(fact.verified,true);}
 await f.coordinator.withMoneyControl({},ctx=>ctx.recordLiquidity(cash));
});
test('canonical partial refund amount records scoped exception and holds quoted principal without resend',async t=>{
 const f=await realFixture(t);let refund,sends=0;
 f.client.refunds.create=async payload=>{sends++;return refund={object:'refund',id:'re_partial',charge:'ch_original',payment_intent:'pi_original',amount:payload.amount-1,currency:'usd',status:'succeeded',metadata:payload.metadata,balance_transaction:'txn_partial'};};
 f.client.refunds.list=async()=>({data:[refund],has_more:false});f.client.refunds.retrieve=async()=>refund;
 const quote=await f.service.quote({accountId:'buyer',sourceId:'s1',maxGrossMicros:100000000});const result=await f.service.confirm({...request,quoteId:quote.id,quoteHash:quote.hash});
 assert.equal(result.state,'submission_unknown');assert.equal(result.code,'RETURN_AMOUNT_MISMATCH');
 await f.service.reconcile({operationId:result.id});const snapshot=f.store.read(),operation=snapshot.operations[result.id];
 assert.equal(operation.observation.observedRefundAmountMicros,quote.N-10000);assert.equal(operation.observation.expectedCashMicros,quote.N);assert.equal(snapshot.sources.s1.retiredMicros,0);assert.equal(snapshot.sources.s1.frozen,true);assert.equal(Object.values(snapshot.exceptions).some(x=>x.operationId===result.id&&x.kind==='FAILED_RETURN_RECONCILIATION_REQUIRED'),true);
 assert.equal(Object.keys(snapshot.projections).length,0);assert.equal(sends,1);
});

test('return service retains committed dispatch capability through result and canonical recovery',async()=>{
 const f=fixture(),anchor=Object.freeze({synthetic:'dispatch'}),actions=[],opts=[],original=f.coordinator.withMoneyControl;
 f.coordinator.failureControl={assertNewEffectAllowed:({action})=>actions.push(action),assertRecoveryAllowed:(a,{action})=>{assert.equal(a,anchor);actions.push(action);}};
 f.coordinator.recoveryAnchors={resolveCommittedAnchor:s=>{assert.equal(s.kind,'dispatch_operation');assert.equal(s.id,'o1');assert.ok(f.state.operations.o1);return anchor;}};
 f.coordinator.withMoneyControl=(o,fn)=>{opts.push(o);return original(o,fn);};
 await f.service.confirm(request);assert.ok(actions.includes('provider_submit'));assert.ok(opts.some(o=>o.recoveryAnchor===anchor&&o.action==='persist_result'));
 await f.service.reconcile({operationId:'o1'});assert.ok(actions.includes('provider_reconcile'));assert.equal(f.sends,1);
});
test('return admission checks durable failure gate before collecting costs or reserving',async()=>{
 const f=fixture();let reads=0;f.provider.collectCosts=async()=>{reads++;throw Error('must not read');};f.coordinator.failureControl={assertNewEffectAllowed:()=>{throw Object.assign(Error('FINANCIAL_RECOVERY_REQUIRED'),{code:'FINANCIAL_RECOVERY_REQUIRED'});}};
 await assert.rejects(f.service.confirm(request),{code:'FINANCIAL_RECOVERY_REQUIRED'});assert.equal(reads,0);assert.equal(f.reserves,0);assert.equal(f.sends,0);
});
