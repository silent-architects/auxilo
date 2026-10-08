'use strict';

const crypto = require('crypto');
const { collectChargeCost, validateRefundCostContract, centsToMicros } = require('./money-cost-evidence');
const API_VERSION = '2025-02-24.acacia';
const EVENT_VERSIONS = new Set([API_VERSION, '2025-09-30.clover']);
function fail(code) { const error = new Error(code); error.code = code; return error; }
function copy(value) { return structuredClone(value); }
function stable(value) { if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'; if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}'; return JSON.stringify(value); }
function hash(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }
function objectId(value) { return typeof value === 'string' ? value : value?.id; }
function time(value) { return typeof value === 'number' ? value : Date.parse(value); }
function checkFields(value, allowed) { if (!value || Object.keys(value).some(k => !allowed.includes(k))) throw fail('RETURN_INVALID_REQUEST'); }
function requiredString(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
function refundFacts(refund){return {id:refund.id,object:refund.object,charge:objectId(refund.charge),payment_intent:objectId(refund.payment_intent),amount:refund.amount,currency:refund.currency,status:refund.status,balance_transaction:objectId(refund.balance_transaction)||null,failure_balance_transaction:objectId(refund.failure_balance_transaction)||null,...(refund.livemode===undefined?{}:{livemode:refund.livemode}),metadata:Object.fromEntries(['auxilo_operation_id','auxilo_request_digest','auxilo_epoch_id'].filter(k=>typeof refund.metadata?.[k]==='string').map(k=>[k,refund.metadata[k]]))};}

function assertEligibleReturnSource(source, epoch, accountId, {allowUnresolvedCharge=false}={}) {
 if (!source || source.accountId !== accountId || source.kind === 'promo' || source.frozen || source.currency !== 'usd' || !Number.isSafeInteger(source.amountMicros) || source.amountMicros <= 0 || (!(allowUnresolvedCharge&&source.charge_id===null)&&!/^ch_\w+$/.test(source.charge_id || '')) || !/^pi_\w+$/.test(source.payment_intent_id || '')) throw fail('RETURN_SOURCE_UNAVAILABLE');
 for (const key of ['epoch_id', 'binding_digest', 'platform', 'platform_account_id', 'livemode']) if (source[key] !== epoch[key] || source[key] === undefined) throw fail('RETURN_SOURCE_UNAVAILABLE');
 if (source.platform !== 'auxilo_llc') throw fail('RETURN_SOURCE_UNAVAILABLE');
 const policy = source.policy; const provenance = source.provenance;
 if (!policy?.acknowledged || !requiredString(policy.version) || !requiredString(policy.evidence_ref) || !Number.isFinite(time(source.created_at)) || !Number.isFinite(time(policy.effective_at)) || !Number.isFinite(time(policy.accepted_at)) || time(policy.effective_at) > time(source.created_at) || time(policy.accepted_at) > time(source.created_at) || !provenance?.verified || ['intent_id','origin_id','purchase_id','lot_id','receipt_digest'].some(k => !requiredString(provenance[k]))) throw fail('RETURN_SOURCE_UNAVAILABLE');
 return source;
}

/** SDK17.7 uses refund.create(params, requestOptions). The registry supplies an
 * opaque account capability. No caller-controlled URL, destination or platform
 * reaches the SDK. Reads and writes happen outside the journal coordinator. */
function createStripeRefundProvider({ registry, epoch, store, coordinator, clock = Date.now, originalCostContract, refundCostContract, maxPagesPerBatch = 5 }) {
 if (!registry || !epoch || !Number.isInteger(maxPagesPerBatch) || maxPagesPerBatch < 1 || maxPagesPerBatch > 20) throw fail('RETURN_PROVIDER_UNAVAILABLE');
 function indexedRuntime(){
  const runtime=store?{store,epoch,withMoneyControl:coordinator?.withMoneyControl?.bind(coordinator),failureControl:coordinator?.failureControl,recoveryAnchors:coordinator?.recoveryAnchors}:require('./money-control').getMoneyRuntime();
  if(runtime?.store?.descriptor?.schema!==2)return null;
  if(runtime.epoch?.epoch_id!==epoch.epoch_id||runtime.epoch?.binding_digest!==epoch.binding_digest||typeof runtime.withMoneyControl!=='function')throw fail('RETURN_IDENTITY_CONFLICT');
  return runtime;
 }
 async function verified() {
  const { client, context } = await registry.getVerifiedClient('auxilo_llc');
  if (context.stripe_platform !== epoch.platform || context.stripe_platform_account_id !== epoch.platform_account_id || context.livemode !== epoch.livemode || registry.assertVerifiedContext(context) !== client) throw fail('RETURN_PROVIDER_UNAVAILABLE');
  return { client, context };
 }
 function assertSource(source) {
  if (!source || ['epoch_id','binding_digest','platform','platform_account_id','livemode'].some(k => source[k] !== epoch[k]) || source.currency !== 'usd' || !/^ch_\w+$/.test(source.charge_id || '')) throw fail('RETURN_IDENTITY_CONFLICT');
 }
 async function verifyCharge(client,context,source){
  registry.assertVerifiedContext(context);
  const charge=await client.charges.retrieve(source.charge_id,{}, {apiVersion:API_VERSION});
  if(registry.assertVerifiedContext(context)!==client)throw fail('RETURN_PROVIDER_UNAVAILABLE');
  if(charge?.object!=='charge'||charge.id!==source.charge_id||charge.currency!=='usd'||charge.livemode!==source.livemode||objectId(charge.payment_intent)!==source.payment_intent_id||centsToMicros(charge.amount)!==source.amountMicros||charge.paid!==true||charge.captured!==true||charge.payment_method_details?.type!=='card')throw fail('RETURN_IDENTITY_CONFLICT');
 }
 function prepare({ source, operation }) {
  assertSource(source);
  if (!operation || operation.sourceId !== source.id || operation.accountId !== source.accountId || !requiredString(operation.id) || !requiredString(operation.quoteHash) || !Number.isSafeInteger(operation.N) || operation.N <= 0 || operation.N % 10000 !== 0 || !Number.isSafeInteger(operation.D) || operation.D < operation.N || operation.D > source.amountMicros) throw fail('RETURN_IDENTITY_CONFLICT');
  const request_digest = hash({epoch:epoch.epoch_id,binding:epoch.binding_digest,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,operationId:operation.id,accountId:operation.accountId,sourceId:source.id,charge:source.charge_id,payment_intent:source.payment_intent_id,quoteHash:operation.quoteHash,G:operation.G,D:operation.D,N:operation.N,C:operation.C,r:operation.r});
  const provider_payload = { charge: source.charge_id, amount: operation.N / 10000, metadata: { auxilo_operation_id: operation.id, auxilo_request_digest: request_digest, auxilo_epoch_id: epoch.epoch_id } };
  return {provider_payload,request_digest,payload_digest:hash(provider_payload),idempotency_key:`auxilo-return-${hash({epoch_id:epoch.epoch_id,operationId:operation.id})}`};
 }
 function assertPrepared(source, operation) {
  const expected = prepare({ source, operation });
  if (stable(operation.provider_payload) !== stable(expected.provider_payload) || (operation.provider_payload_digest||operation.payload_digest) !== expected.payload_digest || (operation.provider_request_digest||operation.request_digest) !== expected.request_digest || operation.idempotency_key !== expected.idempotency_key) throw fail('RETURN_IDENTITY_CONFLICT');
  return expected;
 }
 function refundIdentity(refund, source, operation, allowAmountMismatch=false) {
  // SDK17.7 Refund has no livemode. Its mode comes from the verified client
  // and canonical Charge, not a fabricated refund field.
  return refund?.object === 'refund' && /^re_\w+$/.test(refund.id || '') && objectId(refund.charge) === source.charge_id && (!source.payment_intent_id || objectId(refund.payment_intent) === source.payment_intent_id) && (allowAmountMismatch||refund.amount === operation.N / 10000) && refund.currency === 'usd' && (refund.livemode === undefined || refund.livemode === source.livemode) && refund.metadata?.auxilo_operation_id === operation.id && refund.metadata?.auxilo_request_digest === (operation.provider_request_digest||operation.request_digest) && refund.metadata?.auxilo_epoch_id === epoch.epoch_id;
 }
 function observation(refund, source, operation) {
  if (!refundIdentity(refund, source, operation)) {
   if(refundIdentity(refund,source,operation,true)&&Number.isSafeInteger(refund.amount)&&refund.amount>0&&Number.isSafeInteger(refund.amount*10000))return {state:'submission_unknown',canonical:true,verified:true,complete:true,reason:'RETURN_AMOUNT_MISMATCH',confirmedFundsReturned:false,refund_id:refund.id,provider_status:refund.status,observedRefundAmountMicros:refund.amount*10000,expectedCashMicros:operation.N,charge_id:source.charge_id,payment_intent_id:source.payment_intent_id,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,currency:'usd',evidence_ref:`stripe:${epoch.platform_account_id}:${epoch.livemode}:${refund.id}`,digest:hash(refundFacts(refund)),observed_at:clock()};
   return {state:'submission_unknown',canonical:true,verified:true,complete:true,reason:'RETURN_IDENTITY_CONFLICT',confirmedFundsReturned:false};
  }
  const state = {succeeded:'succeeded_projection_pending',pending:'external_pending',requires_action:'requires_action',failed:'external_pending',canceled:'external_pending'}[refund.status] || 'submission_unknown';
  // A status of failed/canceled alone proves neither returned cash nor the
  // final incurred cost. Keep the hold for explicit cost/return reconciliation.
  return {state,canonical:true,verified:true,complete:true,refund_id:refund.id,provider_status:refund.status,cashMicros:centsToMicros(refund.amount),grossRetirementMicros:operation.D,charge_id:source.charge_id,payment_intent_id:source.payment_intent_id,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,currency:'usd',balance_transaction_id:objectId(refund.balance_transaction)||null,...(objectId(refund.balance_transaction)?{balance_effect_id:objectId(refund.balance_transaction)}:{}),failure_balance_transaction_id:objectId(refund.failure_balance_transaction)||null,confirmedFundsReturned:false,observed_at:clock(),evidence_ref:`stripe:${epoch.platform_account_id}:${epoch.livemode}:${refund.id}`,digest:hash(refundFacts(refund))};
 }
 async function completeObservation(refund,source,operation,client,context){
  const result=observation(refund,source,operation);
  if(!['failed','canceled'].includes(refund.status)||result.reason)return result;
  const debitId=objectId(refund.balance_transaction),returnId=objectId(refund.failure_balance_transaction);
  if(!/^txn_\w+$/.test(debitId||'')||!/^txn_\w+$/.test(returnId||'')||debitId===returnId||!client.balanceTransactions?.retrieve)return result;
  try{
   const transactions=[];
   for(const id of [debitId,returnId]){
    registry.assertVerifiedContext(context);
    const t=await client.balanceTransactions.retrieve(id,{}, {apiVersion:API_VERSION});
    if(registry.assertVerifiedContext(context)!==client)throw fail('RETURN_PROVIDER_UNAVAILABLE');
    if(t?.id!==id||t.object!=='balance_transaction'||objectId(t.source)!==refund.id||t.currency!=='usd'||t.status!=='available'||!Number.isSafeInteger(t.amount)||!Number.isSafeInteger(t.fee)||!Number.isSafeInteger(t.net)||t.net!==t.amount-t.fee||!Array.isArray(t.fee_details))return result;
    let fees=0;for(const part of t.fee_details){if(!Number.isSafeInteger(part.amount)||part.currency!=='usd'||!requiredString(part.type))return result;fees+=part.amount;}
    if(!Number.isSafeInteger(fees)||fees!==t.fee)return result;
    transactions.push(t);
   }
   if(transactions[0].amount!==-refund.amount||transactions[1].amount!==refund.amount||transactions[0].fee<0||transactions[0].fee+transactions[1].fee<0)return result;
   const incurredCostMicros=centsToMicros(transactions[0].fee+transactions[1].fee);
   return {...result,state:refund.status,terminal:true,cashPaidMicros:0,confirmedFundsReturned:true,incurredCostMicros,feeRefundMicros:centsToMicros(Math.max(0,-transactions[1].fee)),returnedFundsEvidence:{debit_id:debitId,return_id:returnId,debitFeeMicros:centsToMicros(transactions[0].fee),transactions:transactions.map(t=>({id:t.id,source:objectId(t.source),currency:t.currency,amount:t.amount,fee:t.fee,net:t.net,status:t.status})),digest:hash(transactions.map(t=>({id:t.id,source:objectId(t.source),currency:t.currency,amount:t.amount,fee:t.fee,net:t.net,status:t.status}))),complete:true,final:true}};
  }catch(error){return {...result,reason:'RETURN_FAILURE_EVIDENCE_INCOMPLETE'};}
 }
 async function collectCosts(source) {
  if(source?.charge_id===null)source=await resolveFundingCharge(source);
  assertSource(source); const {context}=await verified();
  const originalContract=typeof originalCostContract==='function'?await originalCostContract(copy(source)):originalCostContract;
  const original=await collectChargeCost({registry,context,source,clock,contract:originalContract});
  const contract=typeof refundCostContract==='function'?await refundCostContract(copy(source)):refundCostContract;
  registry.assertVerifiedContext(context);
  const incremental=validateRefundCostContract({source,context,contract,now:clock()});
  return {source,original,incremental};
 }
 async function resolveFundingCharge(source){
  source=copy(source);
  if(['epoch_id','binding_digest','platform','platform_account_id','livemode'].some(k=>source[k]!==epoch[k])||!/^pi_\w+$/.test(source.payment_intent_id||''))throw fail('RETURN_IDENTITY_CONFLICT');
  const {client,context}=await verified();
  const payment=await client.paymentIntents.retrieve(source.payment_intent_id,{expand:['latest_charge']},{apiVersion:API_VERSION});
  if(registry.assertVerifiedContext(context)!==client)throw fail('RETURN_PROVIDER_UNAVAILABLE');
  const charge=payment?.latest_charge;
  if(payment?.object!=='payment_intent'||payment.id!==source.payment_intent_id||payment.status!=='succeeded'||payment.currency!=='usd'||payment.livemode!==source.livemode||centsToMicros(payment.amount_received)!==source.amountMicros||charge?.object!=='charge'||!/^ch_\w+$/.test(charge.id||'')||charge.livemode!==source.livemode||objectId(charge.payment_intent)!==source.payment_intent_id||charge.currency!=='usd'||centsToMicros(charge.amount)!==source.amountMicros||charge.paid!==true||charge.captured!==true)throw fail('RETURN_IDENTITY_CONFLICT');
  if(source.charge_id&&source.charge_id!==charge.id)throw fail('RETURN_IDENTITY_CONFLICT');
  return {...source,charge_id:charge.id,charge_evidence_ref:`stripe:${epoch.platform_account_id}:${epoch.livemode}:${payment.id}:${charge.id}`};
 }
 async function submit({source,operation,beforeSend,recoveryAnchor}) {
  // Copy before the first await so concurrent caller mutation cannot redirect a
  // prepared operation after its journal authority was checked.
  source=copy(source);operation=copy(operation);const prepared=assertPrepared(source,operation);
  const {client,context}=await verified();
  await verifyCharge(client,context,source);
  registry.assertVerifiedContext(context);
  try {
   if(beforeSend)await beforeSend();
   registry.assertVerifiedContext(context);
   const runtime=indexedRuntime(),manager=coordinator?.failureControl||runtime?.failureControl;
   if(manager){
    const descriptor=(coordinator?.recoveryAnchors||runtime?.recoveryAnchors).revalidate(recoveryAnchor),durable=runtime?.store.getOperation(operation.id);
    if(descriptor.kind!=='dispatch_operation'||descriptor.id!==operation.id||descriptor.accountDigest!==hash(operation.accountId)||descriptor.sourceDigest!==hash(source.id)||!durable||durable.accountId!==operation.accountId||durable.sourceId!==source.id||durable.provider_payload_digest!==prepared.payload_digest||durable.provider_request_digest!==prepared.request_digest||durable.idempotency_key!==prepared.idempotency_key)throw fail('RETURN_IDENTITY_CONFLICT');
    manager.assertNewEffectAllowed({action:'provider_submit'});
   }
   const refund=await client.refunds.create(prepared.provider_payload,{idempotencyKey:prepared.idempotency_key,maxNetworkRetries:0,apiVersion:API_VERSION});
   if(registry.assertVerifiedContext(context)!==client)throw fail('RETURN_PROVIDER_UNAVAILABLE');
   return await completeObservation(refund,source,operation,client,context);
  }catch(error){return {state:'submission_unknown',canonical:false,complete:false,reason:error.code==='RETURN_PROVIDER_UNAVAILABLE'?'PROVIDER_CONTEXT_CHANGED':'PROVIDER_OUTCOME_UNKNOWN',confirmedFundsReturned:false,observed_at:clock()};}
 }
 async function reconcile({source,operation,cursor,recoveryAnchor}) {
  source=copy(source);operation=copy(operation);assertPrepared(source,operation);
  const {client,context}=await verified();
  await verifyCharge(client,context,source);
  // An already durable provider identity needs an exact canonical GET. This
  // establishes this refund only; it does not certify the charge's inventory.
  if(operation.refund_id){
   if(!/^re_\w+$/.test(operation.refund_id)||!client.refunds?.retrieve)throw fail('RETURN_IDENTITY_CONFLICT');
   registry.assertVerifiedContext(context);const current=await client.refunds.retrieve(operation.refund_id,{}, {apiVersion:API_VERSION});
   if(registry.assertVerifiedContext(context)!==client)throw fail('RETURN_PROVIDER_UNAVAILABLE');
   if(current?.id!==operation.refund_id)return {state:'submission_unknown',canonical:true,verified:true,complete:true,reason:'RETURN_IDENTITY_CONFLICT',confirmedFundsReturned:false,scope:'refund',chargeInventoryComplete:false};
   return {...await completeObservation(current,source,operation,client,context),scope:'refund',chargeInventoryComplete:false};
  }
  const requestDigest=operation.provider_request_digest||operation.request_digest;
  const runtime=indexedRuntime();
  if(runtime){
   const inventory=require('./provider-inventory').createRefundInventory({store:runtime.store,coordinator:runtime,epoch,client,context,registry,source,operation,recoveryAnchor,clock,maxPagesPerBatch,validateRefund:refund=>{
    if(refund?.object!=='refund'||!/^re_\w+$/.test(refund.id||''))throw fail('RETURN_PROVIDER_EVIDENCE_INCOMPLETE');
    const mine=refund.metadata?.auxilo_operation_id===operation.id||refund.metadata?.auxilo_request_digest===requestDigest;
    if(mine)return {refund:refundFacts(refund),classification:refundIdentity(refund,source,operation)?'match':'conflict',amountConflict:refundIdentity(refund,source,operation,true)&&!refundIdentity(refund,source,operation)};
    const valid=objectId(refund.charge)===source.charge_id&&(refund.livemode===undefined||refund.livemode===source.livemode)&&refund.currency==='usd'&&Number.isSafeInteger(refund.amount)&&refund.amount>0;
    return {refund:refundFacts(refund),classification:valid?'external':'conflict',amountConflict:false};
   }});
   const scan=await inventory.scan({cursor});
   if(!scan.complete)return {state:'submission_unknown',canonical:true,verified:true,complete:false,reason:scan.reason,cursor:scan.cursor,confirmedFundsReturned:false};
   const common={complete:true,cursor:null,externalRefundInventoryRef:scan.inventory_ref,scanDigest:scan.scanDigest};
   let target=scan.conflictCount===1&&scan.amountConflictCount===1&&!scan.matchCount?scan.amountConflictId:!scan.conflictCount&&scan.matchCount===1?scan.matched.id:null;
   if(!target)return {...common,state:'submission_unknown',canonical:true,verified:true,confirmedFundsReturned:false,reason:scan.conflictCount?'RETURN_IDENTITY_CONFLICT':scan.matchCount?'RETURN_MULTIPLE_MATCHES':'RETURN_NO_MATCH'};
   registry.assertVerifiedContext(context);const matched=await client.refunds.retrieve(target,{}, {apiVersion:API_VERSION});if(registry.assertVerifiedContext(context)!==client)throw fail('RETURN_PROVIDER_UNAVAILABLE');if(matched?.id!==target)throw fail('RETURN_IDENTITY_CONFLICT');
   return {...await completeObservation(matched,source,operation,client,context),...common};
  }
  const scan=cursor?copy(cursor):{starting_after:null,matches:[],external:[],conflicts:[],seen:[],operation_id:operation.id,request_digest:requestDigest};
  if(scan.operation_id!==operation.id||scan.request_digest!==requestDigest||!Array.isArray(scan.seen)||scan.seen.length>10000)throw fail('RETURN_IDENTITY_CONFLICT');
  scan.amount_conflicts??=[];
  for(let page=0;page<maxPagesPerBatch;page++){
   const params={charge:source.charge_id,limit:100};if(scan.starting_after)params.starting_after=scan.starting_after;
   registry.assertVerifiedContext(context);
   const result=await client.refunds.list(params,{apiVersion:API_VERSION});
   if(registry.assertVerifiedContext(context)!==client)throw fail('RETURN_PROVIDER_UNAVAILABLE');
   if(!result||!Array.isArray(result.data)||typeof result.has_more!=='boolean'||(result.has_more&&result.data.length===0))throw fail('RETURN_PROVIDER_EVIDENCE_INCOMPLETE');
   for(const refund of result.data){
    if(!refund||!/^re_\w+$/.test(refund.id||'')||scan.seen.includes(refund.id))throw fail('RETURN_PROVIDER_EVIDENCE_INCOMPLETE');
    scan.seen.push(refund.id);if(scan.seen.length>10000)throw fail('RETURN_PROVIDER_EVIDENCE_INCOMPLETE');
    if(refund.metadata?.auxilo_operation_id===operation.id||refund.metadata?.auxilo_request_digest===requestDigest){if(refundIdentity(refund,source,operation))scan.matches.push(refundFacts(refund));else{scan.conflicts.push(refund.id);if(refundIdentity(refund,source,operation,true))scan.amount_conflicts.push(refund.id);}}
    else {
     if(refund.object!=='refund'||objectId(refund.charge)!==source.charge_id||(refund.livemode!==undefined&&refund.livemode!==source.livemode)||refund.currency!=='usd'||!Number.isSafeInteger(refund.amount)||refund.amount<=0)scan.conflicts.push(refund.id);
     else scan.external.push({id:refund.id,charge_id:source.charge_id,cashMicros:centsToMicros(refund.amount),status:refund.status,operation_id:refund.metadata?.auxilo_operation_id||null,request_digest:refund.metadata?.auxilo_request_digest||null,balance_transaction_id:objectId(refund.balance_transaction)||null,digest:hash(refund)});
    }
   }
   if(!result.has_more){
    const common={complete:true,cursor:null,externalRefunds:scan.external,scanDigest:hash(scan.seen)};
    if(scan.conflicts.length===1&&scan.amount_conflicts.length===1&&!scan.matches.length&&client.refunds.retrieve){
     registry.assertVerifiedContext(context);const current=await client.refunds.retrieve(scan.amount_conflicts[0],{}, {apiVersion:API_VERSION});
     if(registry.assertVerifiedContext(context)!==client)throw fail('RETURN_PROVIDER_UNAVAILABLE');
     if(current.id===scan.amount_conflicts[0])return {...common,...await completeObservation(current,source,operation,client,context)};
    }
    if(scan.conflicts.length||scan.matches.length!==1)return {...common,state:'submission_unknown',canonical:true,verified:true,confirmedFundsReturned:false,reason:scan.conflicts.length?'RETURN_IDENTITY_CONFLICT':scan.matches.length?'RETURN_MULTIPLE_MATCHES':'RETURN_NO_MATCH'};
    let matched=scan.matches[0];
    if(operation.refund_id){
     if(matched.id!==operation.refund_id)return {...common,state:'submission_unknown',canonical:true,verified:true,confirmedFundsReturned:false,reason:'RETURN_IDENTITY_CONFLICT'};
     registry.assertVerifiedContext(context);matched=await client.refunds.retrieve(operation.refund_id,{}, {apiVersion:API_VERSION});
     if(registry.assertVerifiedContext(context)!==client)throw fail('RETURN_PROVIDER_UNAVAILABLE');
    }
    return {...await completeObservation(matched,source,operation,client,context),...common};
   }
   scan.starting_after=result.data[result.data.length-1].id;
  }
  return {state:'submission_unknown',canonical:true,verified:true,complete:false,reason:'RETURN_SCAN_INCOMPLETE',cursor:scan,confirmedFundsReturned:false};
 }
 async function inspectChargeRefunds({source,cursor,demand,recoveryAnchor}){
  source=copy(source);assertSource(source);const {client,context}=await verified();await verifyCharge(client,context,source);
  const runtime=indexedRuntime();
  if(runtime){
   const inventory=require('./provider-inventory').createRefundInventory({store:runtime.store,coordinator:runtime,epoch,client,context,registry,source,demand,recoveryAnchor,clock,maxPagesPerBatch,validateRefund:refund=>{
    if(refund?.object!=='refund'||!/^re_\w+$/.test(refund.id||'')||objectId(refund.charge)!==source.charge_id||objectId(refund.payment_intent)!==source.payment_intent_id||refund.currency!=='usd'||(refund.livemode!==undefined&&refund.livemode!==source.livemode)||!Number.isSafeInteger(refund.amount)||refund.amount<=0)throw fail('RETURN_IDENTITY_CONFLICT');
    return {refund:refundFacts(refund),classification:'charge_refund'};
   }});
   const scan=await inventory.scan({cursor});return {canonical:true,verified:true,...scan,source_id:source.id,charge_id:source.charge_id,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,currency:'usd',observed_at:clock()};
  }
  const scan=cursor?copy(cursor):{source_id:source.id,charge_id:source.charge_id,starting_after:null,refunds:[],seen:[]};
  if(scan.source_id!==source.id||scan.charge_id!==source.charge_id||!Array.isArray(scan.refunds)||!Array.isArray(scan.seen))throw fail('RETURN_IDENTITY_CONFLICT');
  for(let page=0;page<maxPagesPerBatch;page++){
   registry.assertVerifiedContext(context);const result=await client.refunds.list({charge:source.charge_id,limit:100,...(scan.starting_after?{starting_after:scan.starting_after}:{})},{apiVersion:API_VERSION});
   if(registry.assertVerifiedContext(context)!==client||!Array.isArray(result?.data)||typeof result.has_more!=='boolean'||(result.has_more&&!result.data.length))throw fail('RETURN_PROVIDER_EVIDENCE_INCOMPLETE');
   for(const refund of result.data){
    if(refund?.object!=='refund'||!/^re_\w+$/.test(refund.id||'')||scan.seen.includes(refund.id)||objectId(refund.charge)!==source.charge_id||objectId(refund.payment_intent)!==source.payment_intent_id||refund.currency!=='usd'||(refund.livemode!==undefined&&refund.livemode!==source.livemode)||!Number.isSafeInteger(refund.amount)||refund.amount<=0)throw fail('RETURN_IDENTITY_CONFLICT');
    scan.seen.push(refund.id);scan.refunds.push(refundFacts(refund));if(scan.seen.length>10000)throw fail('RETURN_PROVIDER_EVIDENCE_INCOMPLETE');
   }
   if(!result.has_more)return {canonical:true,verified:true,complete:true,cursor:null,source_id:source.id,charge_id:source.charge_id,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,currency:'usd',refunds:scan.refunds,digest:hash(scan.refunds),observed_at:clock()};
   scan.starting_after=result.data[result.data.length-1].id;
  }
  return {canonical:true,verified:true,complete:false,cursor:scan,source_id:source.id,charge_id:source.charge_id,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,currency:'usd',observed_at:clock()};
 }
 async function inspectDispute({source,disputeId}){
  source=copy(source);assertSource(source);if(!/^dp_\w+$/.test(disputeId||''))throw fail('RETURN_IDENTITY_CONFLICT');
  const {client,context}=await verified();await verifyCharge(client,context,source);
  const dispute=await client.disputes.retrieve(disputeId,{}, {apiVersion:API_VERSION});
  if(registry.assertVerifiedContext(context)!==client||dispute?.object!=='dispute'||dispute.id!==disputeId||objectId(dispute.charge)!==source.charge_id||objectId(dispute.payment_intent)!==source.payment_intent_id||dispute.livemode!==source.livemode||dispute.currency!=='usd'||!Number.isSafeInteger(dispute.amount)||dispute.amount<=0||centsToMicros(dispute.amount)>source.amountMicros)throw fail('RETURN_IDENTITY_CONFLICT');
  return {canonical:true,verified:true,complete:true,source_id:source.id,dispute_id:dispute.id,status:dispute.status,cashMicros:centsToMicros(dispute.amount),platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,currency:'usd',evidence_ref:`stripe:${epoch.platform_account_id}:${epoch.livemode}:${dispute.id}`,digest:hash(dispute),observed_at:clock()};
 }
 function parseSignedEvent(raw,signature){
  const {event,context}=registry.verifyPlatformEvent('auxilo_llc',raw,signature);
  if(!EVENT_VERSIONS.has(event.api_version))throw fail('RETURN_EVENT_VERSION_UNSUPPORTED');
  if(context.stripe_platform_account_id!==epoch.platform_account_id||context.livemode!==epoch.livemode||event.livemode!==epoch.livemode||event.account)throw fail('RETURN_IDENTITY_CONFLICT');
  const object=event.data?.object;
  if(!['refund.created','refund.updated','refund.failed','charge.refunded'].includes(event.type)||!requiredString(event.id)||!object)throw fail('RETURN_EVENT_UNSUPPORTED');
  return {canonical:false,event_id:event.id,api_version:event.api_version,charge_id:object.object==='charge'?object.id:objectId(object.charge),refund_id:object.object==='refund'?object.id:null};
 }
 return {prepare,collectCosts,submit,reconcile,parseSignedEvent,resolveFundingCharge,inspectChargeRefunds,inspectDispute};
}

function createFundsReturnService({epoch,store,coordinator,provider,clock=Date.now,authorize,collectLiquidity}){
 const indexed=store.descriptor?.schema===2;
 const readSource=(id)=>indexed?store.getSource(id):store.read().sources[id];
 const readOperation=(id)=>indexed?store.getOperation(id):store.read().operations[id];
 const readQuote=(id)=>indexed?store.getQuote(id):store.read().quotes[id];
 const permission=authorize||((request)=>{const source=request.source;return require('./financial-epoch').assertProspectiveAllowed({...request,epoch,...(source?{source:{...source,account_id:source.accountId,checkout_intent_id:source.provenance.intent_id,purchase_id:source.provenance.purchase_id,lot_id:source.provenance.lot_id,stripe_payment_intent:source.payment_intent_id,policy_version:source.policy.version,policy_consent_id:source.policy.consent_id,created_at:new Date(source.created_at).toISOString()}}:{})});});
 function sourceFor(accountId,sourceId){const source=readSource(sourceId);return assertEligibleReturnSource(source,epoch,accountId,{allowUnresolvedCharge:true});}
 function publicOperation(op){const reason=op.observation?.reason;return {id:op.id,sourceId:op.sourceId,quoteId:op.quoteId,state:op.state,G:op.G,D:op.D,N:op.N,C:op.C,r:op.r,coverageMicros:op.coverageMicros,refundId:op.refund_id||op.observation?.refund_id||null,...(['failed','canceled','failed_projection_pending'].includes(op.state)?{failureCustomerCostMicros:0,failedCostMicros:op.failedCostMicros??op.failure?.incurredCostMicros,failedCostReversedMicros:op.failedCostReversedMicros??0,failedCostExposureMicros:op.failedCostExposureMicros}:{}),...(typeof reason==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(reason)?{code:reason}:{})};}
 async function allow(accountId,source,action='buyer_return'){return permission({action,epoch,expectedRevision:epoch.activation_revision,accountId,source});}
 async function sourcePage({accountId,after,limit=100}){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw fail('RETURN_INVALID_REQUEST');
  if(!requiredString(accountId))throw fail('RETURN_INVALID_REQUEST');
  const results=[];
  const snapshot=indexed?null:store.read();
  const page=indexed?store.listSources({accountId,after,limit}):{items:Object.values(snapshot.sources).filter(s=>s.accountId===accountId).slice(0,limit),nextCursor:null};
  for(const source of page.items){
   if(source.accountId!==accountId)continue;
   let unavailableReason=null;try{assertEligibleReturnSource(source,epoch,accountId,{allowUnresolvedCharge:true});await allow(accountId,source);}catch(error){unavailableReason=error.code||'RETURN_SOURCE_UNAVAILABLE';}
   const held=indexed?[store.sourceReturnBalances(source.id).heldMicros]:Object.values(snapshot.operations).filter(o=>o.sourceId===source.id&&!o.principalRetired&&!['settled','failed','canceled','requote_required'].includes(o.state)).map(o=>o.D);
   if(!indexed)held.push(...Object.values(snapshot.spends||{}).filter(s=>s.state==='prepared').flatMap(s=>s.draws.filter(d=>d.sourceId===source.id).map(d=>d.amountMicros)));
   const heldMicros=Number(held.reduce((sum,n)=>sum+BigInt(n),0n));if(!Number.isSafeInteger(heldMicros))throw fail('MONEY_OVERFLOW');
   const availableMicros=unavailableReason?0:Math.max(source.amountMicros-source.spentMicros-source.retiredMicros-heldMicros,0);
   if(!unavailableReason&&!availableMicros)unavailableReason=heldMicros?'RETURN_PRINCIPAL_HELD':'RETURN_NO_UNUSED_PRINCIPAL';
   results.push({id:source.id,currency:source.currency,amountMicros:source.amountMicros,spentMicros:source.spentMicros,retiredMicros:source.retiredMicros,availableMicros,heldMicros,available:!unavailableReason,unavailableReason});
  }
  return {items:results,nextCursor:page.nextCursor};
 }
 async function sources(input){return (await sourcePage(input)).items;}
 async function quote(input){
  if(input?.rail&&input.rail!=='stripe_buyer')throw fail('RETURN_RAIL_UNAVAILABLE');
  checkFields(input,['accountId','sourceId','maxGrossMicros','rail']);
  const {accountId,sourceId,maxGrossMicros}=input;
  if(!requiredString(accountId)||!requiredString(sourceId)||!Number.isSafeInteger(maxGrossMicros)||maxGrossMicros<=0)throw fail('RETURN_INVALID_REQUEST');
  const source=sourceFor(accountId,sourceId);await allow(accountId,source);
  const costs=await provider.collectCosts(copy(source));
  const quoted=await coordinator.withMoneyControl({kind:'quote',accounts:[accountId],epochRevision:epoch.activation_revision},async ctx=>{
   const fresh=sourceFor(accountId,sourceId);await allow(accountId,fresh);
   if(costs.source?.charge_id&&!fresh.charge_id)ctx.attachFundingCharge({sourceId,charge_id:costs.source.charge_id,evidence_ref:costs.source.charge_evidence_ref,verified:true});
   ctx.recordCost(costs.original);ctx.recordCost(costs.incremental);
   return ctx.quoteReturn({accountId,sourceId,maxGrossMicros,costEvidenceId:costs.original.id,incrementalCostEvidenceId:costs.incremental.id,incrementalCostMicros:costs.incremental.amountMicros,now:clock()});
  });
  return {id:quoted.id,hash:quoted.hash,sourceId:quoted.sourceId,G:quoted.G,D:quoted.D,N:quoted.N,C:quoted.C,r:quoted.r,coverageMicros:quoted.coverageMicros,createdAt:quoted.createdAt,expiresAt:quoted.expiresAt,costEvidenceStatus:'verified'};
 }
 function replay(accountId,key,quoteId,quoteHash){const op=indexed?store.findOperationByRequestKey(accountId,key):Object.values(store.read().operations).find(o=>o.accountId===accountId&&o.clientRequestKey===key);if(op&&(op.quoteId!==quoteId||op.quoteHash!==quoteHash))throw fail('IDEMPOTENCY_CONFLICT');return op;}
 async function confirm(input){
  checkFields(input,['accountId','quoteId','quoteHash','clientRequestKey']);
  const {accountId,quoteId,quoteHash,clientRequestKey}=input;
  if(!requiredString(accountId)||!requiredString(quoteId)||!requiredString(quoteHash)||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientRequestKey||''))throw fail('RETURN_INVALID_REQUEST');
  const existing=replay(accountId,clientRequestKey,quoteId,quoteHash);if(existing)return publicOperation(existing);
  coordinator.failureControl?.assertNewEffectAllowed({action:'provider_submit'});
  const quote=readQuote(quoteId);if(!quote||quote.accountId!==accountId)throw fail('RETURN_NOT_FOUND');
  const source=sourceFor(accountId,quote.sourceId);await allow(accountId,source);
  if(typeof collectLiquidity!=='function')throw fail('RETURN_LIQUIDITY_UNAVAILABLE');
  const [costs,liquidity]=await Promise.all([provider.collectCosts(copy(source)),collectLiquidity({source:copy(source),epoch,demand:{quoteId,quoteHash,clientRequestKey,accountId,sourceId:source.id}})]);
  const dispatch=await coordinator.withMoneyControl({kind:'return',accounts:[accountId],epochRevision:epoch.activation_revision},async ctx=>{
   const concurrent=replay(accountId,clientRequestKey,quoteId,quoteHash);if(concurrent)return {operation:concurrent,send:false};
   const fresh=sourceFor(accountId,quote.sourceId);await allow(accountId,fresh);
   ctx.recordCost(costs.original);ctx.recordCost(costs.incremental);ctx.recordLiquidity(liquidity);
   const reserved=ctx.reserveReturn({accountId,quoteId,quoteHash,clientRequestKey,now:clock()});
   const prepared=provider.prepare({source:fresh,operation:reserved});
   const operation=ctx.markDispatch({operationId:reserved.id,payload:prepared.provider_payload,idempotencyKey:prepared.idempotency_key,payloadDigest:prepared.payload_digest,requestDigest:prepared.request_digest});
   return {operation,source:fresh,send:true};
  });
  if(!dispatch.send)return publicOperation(dispatch.operation);
  const recoveryAnchor=coordinator.failureControl?coordinator.recoveryAnchors.resolveCommittedAnchor({kind:'dispatch_operation',id:dispatch.operation.id,accountId,sourceId:dispatch.operation.sourceId}):undefined;
  coordinator.failureControl?.assertNewEffectAllowed({action:'provider_submit'});
  let observation;
  try{observation=await provider.submit({source:dispatch.source,operation:dispatch.operation,recoveryAnchor,beforeSend:()=>coordinator.withMoneyControl({kind:'return',accounts:[accountId],epochRevision:epoch.activation_revision,...(recoveryAnchor?{recoveryAnchor,action:'provider_submit'}:{})},async ctx=>{await allow(accountId,sourceFor(accountId,dispatch.operation.sourceId));ctx.assertDispatchAuthority({operationId:dispatch.operation.id});coordinator.failureControl?.assertNewEffectAllowed({action:'provider_submit'});})});}
  catch(error){observation={state:'submission_unknown',canonical:false,complete:false,reason:'PROVIDER_OUTCOME_UNKNOWN',confirmedFundsReturned:false};}
  await recordObservation(dispatch.operation,observation,recoveryAnchor);
  return publicOperation(readOperation(dispatch.operation.id));
 }
 async function recordObservation(operation,observation,recoveryAnchor){
  return coordinator.withMoneyControl({kind:'reconcile',accounts:[operation.accountId],epochRevision:epoch.activation_revision,...(recoveryAnchor?{recoveryAnchor,action:'persist_result'}:{})},ctx=>{
   if(!observation.canonical||!observation.complete)return ctx.noteSubmissionUnknown({operationId:operation.id,observation});
   const current=ctx.getOperation?ctx.getOperation({operationId:operation.id}):operation;
   if(['failed','canceled'].includes(current.state)&&observation.state===current.state&&observation.terminal===true&&observation.cashPaidMicros===0&&observation.confirmedFundsReturned===true){
    const remaining=current.failedCostMicros-(current.failedCostReversedMicros||0),prior=current.failure?.observation,proof=observation.returnedFundsEvidence;
    if(observation.incurredCostMicros===remaining)return current;
    if(Number.isSafeInteger(remaining)&&observation.incurredCostMicros<remaining&&proof?.complete&&proof.final&&prior?.returnedFundsEvidence?.debit_id===proof.debit_id&&prior.returnedFundsEvidence.return_id===proof.return_id&&prior.returnedFundsEvidence.debitFeeMicros===proof.debitFeeMicros&&observation.feeRefundMicros-(prior.feeRefundMicros||0)-(current.failedCostReversedMicros||0)===remaining-observation.incurredCostMicros){
     const amountMicros=remaining-observation.incurredCostMicros;
     return ctx.reverseFailedCost({operationId:current.id,reversalId:proof.digest,amountMicros,observation:{canonical:true,verified:true,complete:true,feeRefundMicros:amountMicros,refund_id:observation.refund_id,platform_account_id:observation.platform_account_id,livemode:observation.livemode,currency:'usd',returnedFundsEvidence:proof,evidence_ref:observation.evidence_ref+':fee-correction:'+proof.digest}});
    }
   }
   return ctx.observeOperation({operationId:operation.id,state:observation.state,observation,confirmedFundsReturned:observation.confirmedFundsReturned===true,incurredCostMicros:observation.incurredCostMicros});
  });
 }
 async function status({accountId,operationId}){const op=readOperation(operationId);if(!op||op.accountId!==accountId)throw fail('RETURN_NOT_FOUND');return publicOperation(op);}
 async function reconcile({operationId}){
  const op=readOperation(operationId);if(!op)throw fail('RETURN_NOT_FOUND');
  const source=readSource(op.sourceId);if(!source)throw fail('RETURN_SOURCE_UNAVAILABLE');
  await allow(op.accountId,source,'reconcile');
  const recoveryAnchor=coordinator.failureControl?coordinator.recoveryAnchors.resolveCommittedAnchor({kind:'dispatch_operation',id:op.id,accountId:op.accountId,sourceId:op.sourceId}):undefined;
  if(recoveryAnchor)coordinator.failureControl.assertRecoveryAllowed(recoveryAnchor,{action:'provider_reconcile'});
  // A webhook is merely a trigger. A caller-supplied status never settles money.
  const observation=await provider.reconcile({source:copy(source),operation:copy(op),cursor:op.observation?.cursor||op.providerObservation?.cursor,recoveryAnchor});
  await recordObservation(op,observation,recoveryAnchor);return publicOperation(readOperation(operationId));
 }
 return {sources,sourcePage,quote,confirm,status,reconcile};
}
/** A balance alone cannot establish cash admission. This collector requires a
 * complete canonical USD effect inventory and a separately approved scope for
 * obligations not represented by the epoch journal. No flag invents a zero. */
function createStripeLiquidityCollector({registry,epoch,store,coordinator,readEvidence,clock=Date.now,maxPagesPerBatch=20}){
 if(store?.descriptor?.schema===2)return createIndexedLiquidityCollector({registry,epoch,store,coordinator:coordinator||require('./money-control').getMoneyRuntime(),readEvidence,clock,maxPagesPerBatch});
 if(!registry||!epoch||!store||typeof readEvidence!=='function'||!Number.isInteger(maxPagesPerBatch)||maxPagesPerBatch<1||maxPagesPerBatch>100)throw fail('RETURN_LIQUIDITY_UNAVAILABLE');
 function nonnegative(value){return Number.isSafeInteger(value)&&value>=0;}
 function exactTotal(values){let total=0n;for(const value of values){if(!nonnegative(value))throw fail('RETURN_LIQUIDITY_UNAVAILABLE');total+=BigInt(value);}if(total>BigInt(Number.MAX_SAFE_INTEGER))throw fail('RETURN_LIQUIDITY_UNAVAILABLE');return Number(total);}
 return async function collectLiquidity(){
  const began=clock(),e=await readEvidence();
  if(!e||e.epoch_id!==epoch.epoch_id||e.binding_digest!==epoch.binding_digest||e.platform_account_id!==epoch.platform_account_id||e.livemode!==epoch.livemode||e.currency!=='usd'||e.approved!==true||e.obligations_complete!==true||e.inventory_complete!==true||!requiredString(e.evidence_ref)||!requiredString(e.cutoff_ref)||!Array.isArray(e.external_effects)||!nonnegative(e.otherProtectedLiabilityMicros)||!nonnegative(e.restrictedCashMicros)||!nonnegative(e.exposureLimitMicros)||!Number.isSafeInteger(e.valid_from)||!Number.isSafeInteger(e.valid_until)||began<e.valid_from||began>=e.valid_until)throw fail('RETURN_LIQUIDITY_UNAVAILABLE');
  const {client,context}=await registry.getVerifiedClient('auxilo_llc');
  if(context.stripe_platform_account_id!==epoch.platform_account_id||context.stripe_platform!==epoch.platform||context.livemode!==epoch.livemode||registry.assertVerifiedContext(context)!==client)throw fail('RETURN_PROVIDER_UNAVAILABLE');
  async function read(fn){registry.assertVerifiedContext(context);const result=await fn();if(registry.assertVerifiedContext(context)!==client)throw fail('RETURN_PROVIDER_UNAVAILABLE');return result;}
  const before=await read(()=>client.balance.retrieve({}, {apiVersion:API_VERSION}));
  if(before?.object!=='balance'||before.livemode!==epoch.livemode||!Array.isArray(before.available)||!Array.isArray(before.pending))throw fail('RETURN_LIQUIDITY_UNAVAILABLE');
  const snapshot=store.read(),sources=Object.values(snapshot.sources),operations=Object.values(snapshot.operations),reflectedEffectIds=[],seen=new Set(),observations=[];
  const expected=new Map();
  for(const proof of e.external_effects){if(!proof||!/^txn_\w+$/.test(proof.id||'')||!proof.source||!Number.isSafeInteger(proof.amount)||!Number.isSafeInteger(proof.fee)||!Number.isSafeInteger(proof.net)||proof.net!==proof.amount-proof.fee||!proof.evidence_ref||expected.has(proof.id))throw fail('RETURN_LIQUIDITY_UNAVAILABLE');expected.set(proof.id,proof);}
  const canonicalReturns = [];
  function includeReturnEvidence(observation,operation) {
    const proof = observation?.returnedFundsEvidence;
    if (!observation?.canonical || !observation.verified || !observation.complete || observation.platform_account_id !== epoch.platform_account_id || observation.livemode !== epoch.livemode || observation.currency !== 'usd' || !proof?.complete || !proof.final || !Array.isArray(proof.transactions) || proof.transactions.length !== 2 || hash(proof.transactions) !== proof.digest) return;
    const source=operation&&snapshot.sources[operation.sourceId];
    if(!source||operation.type!=='buyer_return'||operation.accountId!==source.accountId||operation.refund_id!==observation.refund_id||!/^re_\w+$/.test(observation.refund_id||'')||['epoch_id','binding_digest','platform','platform_account_id','livemode'].some(k=>operation[k]!==epoch[k]||source[k]!==epoch[k])||source.currency!=='usd'||!Number.isSafeInteger(operation.N)||operation.N<=0||operation.N%10000!==0||(observation.charge_id&&observation.charge_id!==source.charge_id)||(observation.payment_intent_id&&observation.payment_intent_id!==source.payment_intent_id))return;
    const [debit,returned]=proof.transactions;
    if(!/^txn_\w+$/.test(proof.debit_id||'')||!/^txn_\w+$/.test(proof.return_id||'')||proof.debit_id===proof.return_id||debit.id!==proof.debit_id||returned.id!==proof.return_id||debit.amount!==-operation.N/10000||returned.amount!==operation.N/10000||debit.fee<0||debit.fee+returned.fee<0||proof.debitFeeMicros!==debit.fee*10000)return;
    if(proof.transactions.some(t=>t.source!==operation.refund_id||t.currency!=='usd'||t.status!=='available'||!Number.isSafeInteger(t.amount)||!Number.isSafeInteger(t.fee)||!Number.isSafeInteger(t.net)||t.net!==t.amount-t.fee))return;
    canonicalReturns.push(...proof.transactions);
  }
  for (const operation of operations) { includeReturnEvidence(operation.failure?.observation,operation); includeReturnEvidence(operation.observation,operation); }
  for (const row of Object.values(snapshot.provider_observations || {})) includeReturnEvidence(row.record?.observation,snapshot.operations[row.record?.operationId]);
  let cursor,firstId=null,complete=false;
  for(let page=0;page<maxPagesPerBatch;page++){
   const list=await read(()=>client.balanceTransactions.list({limit:100,...(cursor?{starting_after:cursor}:{})},{apiVersion:API_VERSION}));
   if(!list||!Array.isArray(list.data)||typeof list.has_more!=='boolean'||(list.has_more&&!list.data.length))throw fail('RETURN_LIQUIDITY_UNAVAILABLE');
   if(page===0)firstId=list.data[0]?.id||null;
   for(const tx of list.data){
    if(!/^txn_\w+$/.test(tx?.id||'')||seen.has(tx.id))throw fail('RETURN_LIQUIDITY_UNAVAILABLE');seen.add(tx.id);
    if(tx.currency!=='usd')continue;
    if(tx.object!=='balance_transaction'||!Number.isSafeInteger(tx.amount)||!Number.isSafeInteger(tx.fee)||!Number.isSafeInteger(tx.net)||tx.net!==tx.amount-tx.fee||!['available','pending'].includes(tx.status))throw fail('RETURN_LIQUIDITY_UNAVAILABLE');
    const sourceId=objectId(tx.source),proof=expected.get(tx.id);
    const funding=tx.fee>=0&&sources.find(s=>s.charge_id===sourceId&&s.platform_account_id===epoch.platform_account_id&&s.livemode===epoch.livemode&&s.currency==='usd'&&s.amountMicros===tx.amount*10000);
    const operation=tx.fee>=0&&operations.find(o=>(o.refund_id===sourceId||o.cashEffectId===tx.id)&&o.N===-tx.amount*10000&&o.incrementalCostMicros===tx.fee*10000);
    const exact=proof&&proof.source===sourceId&&proof.amount===tx.amount&&proof.fee===tx.fee&&proof.net===tx.net;
    const returned = canonicalReturns.some(p=>p.id===tx.id&&p.source===sourceId&&p.currency===tx.currency&&p.amount===tx.amount&&p.fee===tx.fee&&p.net===tx.net&&p.status===tx.status);
    if(!funding&&!operation&&!exact&&!returned)throw fail('RETURN_UNKNOWN_BALANCE_MOVEMENT');
    if(tx.status==='available')reflectedEffectIds.push(tx.id);
    observations.push({id:tx.id,source:sourceId,amount:tx.amount,fee:tx.fee,net:tx.net,status:tx.status});
   }
   if(!list.has_more){complete=true;break;}cursor=list.data[list.data.length-1].id;
  }
  if(!complete)throw fail('RETURN_LIQUIDITY_SCAN_INCOMPLETE');
  const head=await read(()=>client.balanceTransactions.list({limit:1},{apiVersion:API_VERSION}));
  const after=await read(()=>client.balance.retrieve({}, {apiVersion:API_VERSION}));
  if(!Array.isArray(head?.data)||(head.data[0]?.id||null)!==firstId||hash(before)!==hash(after)||clock()-began>30000||clock()<began)throw fail('RETURN_LIQUIDITY_CUT_CHANGED');
  const availableMicros=exactTotal(before.available.filter(x=>x.currency==='usd').map(x=>centsToMicros(x.amount)));
  const local=exactTotal([...sources.map(s=>s.amountMicros-s.spentMicros-s.retiredMicros),...Object.values(snapshot.pools).map(p=>p.contributorShareMicros-(p.contributorReversedMicros||0))]);
  const revision=Math.max(-1,...Object.values(snapshot.liquidity_evidence).map(x=>x.revision))+1;
  const facts={balance:before,head:firstId,transactions:observations,evidence_ref:e.evidence_ref,cutoff_ref:e.cutoff_ref,journal_revision:snapshot.revision};
  return {id:'liquidity_'+hash({...facts,revision,observed_at:began}),revision,epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,currency:'usd',journal_revision:snapshot.revision,otherProtectedLiabilityMicros:e.otherProtectedLiabilityMicros,availableMicros,protectedLiabilityMicros:exactTotal([local,e.otherProtectedLiabilityMicros]),restrictedCashMicros:e.restrictedCashMicros,exposureLimitMicros:e.exposureLimitMicros,complete:true,canonical:true,observed_at:began,cutoff:e.cutoff_ref+':'+(firstId||'empty'),digest:hash(facts),reflectedEffectIds,capitalApproved:true,evidence_ref:e.evidence_ref};
 };
}
function exactReturnEvidence(observation,operation,source,epoch){
 const proof=observation?.returnedFundsEvidence;
 if(!observation?.canonical||!observation.verified||!observation.complete||observation.platform_account_id!==epoch.platform_account_id||observation.livemode!==epoch.livemode||observation.currency!=='usd'||!proof?.complete||!proof.final||!Array.isArray(proof.transactions)||proof.transactions.length!==2||hash(proof.transactions)!==proof.digest)return [];
 if(!source||operation?.type!=='buyer_return'||operation.accountId!==source.accountId||operation.refund_id!==observation.refund_id||!/^re_\w+$/.test(observation.refund_id||'')||['epoch_id','binding_digest','platform','platform_account_id','livemode'].some(k=>operation[k]!==epoch[k]||source[k]!==epoch[k])||source.currency!=='usd'||!Number.isSafeInteger(operation.N)||operation.N<=0||operation.N%10000!==0||(observation.charge_id&&observation.charge_id!==source.charge_id)||(observation.payment_intent_id&&observation.payment_intent_id!==source.payment_intent_id))return [];
 const [debit,returned]=proof.transactions;
 if(!/^txn_\w+$/.test(proof.debit_id||'')||!/^txn_\w+$/.test(proof.return_id||'')||proof.debit_id===proof.return_id||debit.id!==proof.debit_id||returned.id!==proof.return_id||debit.amount!==-operation.N/10000||returned.amount!==operation.N/10000||debit.fee<0||debit.fee+returned.fee<0||proof.debitFeeMicros!==debit.fee*10000)return [];
 if(proof.transactions.some(t=>t.source!==operation.refund_id||t.currency!=='usd'||t.status!=='available'||!Number.isSafeInteger(t.amount)||!Number.isSafeInteger(t.fee)||!Number.isSafeInteger(t.net)||t.net!==t.amount-t.fee))return [];
 return proof.transactions;
}
function createIndexedLiquidityCollector({registry,epoch,store,coordinator,readEvidence,clock,maxPagesPerBatch}){
 if(typeof readEvidence!=='function')throw fail('RETURN_LIQUIDITY_UNAVAILABLE');
 const nonnegative=v=>Number.isSafeInteger(v)&&v>=0;
 const total=values=>{if(values.some(v=>!nonnegative(v)))throw fail('RETURN_LIQUIDITY_UNAVAILABLE');const n=values.reduce((a,b)=>a+BigInt(b),0n);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw fail('MONEY_OVERFLOW');return Number(n);};
 return async function collectLiquidity({source,operation,demand,recoveryAnchor}={}){
  const capacity=Object.freeze({purpose:'provider_inventory',mandatory:!!(demand||operation?.id),...(source?.id?{sourceId:source.id}:{}),...(operation?.id?{operationId:operation.id}:{})});
  const began=clock(),e=await readEvidence();
  if(!e||e.epoch_id!==epoch.epoch_id||e.binding_digest!==epoch.binding_digest||e.platform_account_id!==epoch.platform_account_id||e.livemode!==epoch.livemode||e.currency!=='usd'||e.approved!==true||e.obligations_complete!==true||e.inventory_complete!==true||!requiredString(e.evidence_ref)||!requiredString(e.cutoff_ref)||!Array.isArray(e.external_effects)||!nonnegative(e.otherProtectedLiabilityMicros)||!nonnegative(e.restrictedCashMicros)||!nonnegative(e.exposureLimitMicros)||!Number.isSafeInteger(e.valid_from)||!Number.isSafeInteger(e.valid_until)||began<e.valid_from||began>=e.valid_until)throw fail('RETURN_LIQUIDITY_UNAVAILABLE');
  const expected=new Map();for(const proof of e.external_effects){if(!proof||!/^txn_\w+$/.test(proof.id||'')||!proof.source||!Number.isSafeInteger(proof.amount)||!Number.isSafeInteger(proof.fee)||!Number.isSafeInteger(proof.net)||proof.net!==proof.amount-proof.fee||!proof.evidence_ref||expected.has(proof.id))throw fail('RETURN_LIQUIDITY_UNAVAILABLE');expected.set(proof.id,proof);}
  async function verifyEffect(tx){
   if(tx.currency!=='usd')return true;
   const proof=expected.get(tx.id);if(proof&&proof.source===tx.source&&proof.amount===tx.amount&&proof.fee===tx.fee&&proof.net===tx.net)return true;
   const source=store.findSourceByProviderIdentity({platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,chargeId:tx.source});
   if(tx.fee>=0&&source&&source.currency==='usd'&&source.amountMicros===tx.amount*10000)return true;
   const operation=store.findOperationByRefund({platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,refundId:tx.source});
   if(!operation)return false;
   if(tx.fee>=0&&operation.N===-tx.amount*10000&&operation.incrementalCostMicros===tx.fee*10000)return true;
   const owner=store.getSource(operation.sourceId),same=p=>p.id===tx.id&&p.source===tx.source&&p.currency===tx.currency&&p.amount===tx.amount&&p.fee===tx.fee&&p.net===tx.net&&p.status===tx.status;
   if(exactReturnEvidence(operation.failure?.observation,operation,owner,epoch).some(same)||exactReturnEvidence(operation.observation,operation,owner,epoch).some(same))return true;
   if(store.listProviderObservations){let after;do{const page=store.listProviderObservations({operationId:operation.id,after,limit:100});for(const row of page.items)if(exactReturnEvidence(row.record?.observation,operation,owner,epoch).some(same))return true;after=page.nextCursor;}while(after);}
   return false;
  }
  const inventory=require('./provider-inventory').createProviderInventory({registry,epoch,store,coordinator,clock,maxPagesPerBatch:Math.min(maxPagesPerBatch,20),verifyEffect});
  const scan=await inventory.scan({recoveryAnchor,demand:demand||(operation?{operationId:operation.id,sourceId:operation.sourceId,accountId:operation.accountId}:undefined),capacity});if(!scan.complete)throw fail(scan.reason||'RETURN_LIQUIDITY_SCAN_INCOMPLETE');
  const now=clock();if(now<began||now-began>30000||now>=e.valid_until)throw fail('RETURN_LIQUIDITY_CUT_CHANGED');
  const basis=store.readLiquidityBasis(),revision=basis.latestLiquidityRevision+1;
  const facts={capacity,provider_inventory_ref:scan.provider_inventory_ref,inventory_digest:scan.evidenceDigest,balance:scan.balance,head:scan.headId,evidence_ref:e.evidence_ref,cutoff_ref:e.cutoff_ref,journal_revision:basis.revision};
  return {id:'liquidity_'+hash({...facts,revision,observed_at:now}),capacity:copy(capacity),revision,epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,currency:'usd',journal_revision:basis.revision,otherProtectedLiabilityMicros:e.otherProtectedLiabilityMicros,availableMicros:total(scan.balance.available.filter(x=>x.currency==='usd').map(x=>centsToMicros(x.amount))),protectedLiabilityMicros:total([basis.localLiabilityMicros,e.otherProtectedLiabilityMicros]),restrictedCashMicros:e.restrictedCashMicros,exposureLimitMicros:e.exposureLimitMicros,complete:true,canonical:true,observed_at:now,cutoff:e.cutoff_ref+':'+(scan.headId||'empty'),digest:hash(facts),provider_inventory_ref:scan.provider_inventory_ref,capitalApproved:true,evidence_ref:e.evidence_ref};
 };
}
module.exports={createFundsReturnService,createStripeRefundProvider,createStripeLiquidityCollector,assertEligibleReturnSource,API_VERSION};
