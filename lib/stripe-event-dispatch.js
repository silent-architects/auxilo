 'use strict';
// Signature verification and emergency/boot guards stay in the route. This handler
// only accepts that route's trusted platform context; it never selects a provider.
const {digestJSON}=require('./stripe-transfer-persistence');
const {validateContext}=require('./stripe-object-origins');
function createStripeEventDispatcher(deps){
 const {receipts,origins,packs,getAccounts,addDollarLot,appendPurchase,isSessionProcessed,getPurchases,clearPending,postCreditEffects,checkoutIntents,refundHandlers,getEarnings,saveEarnings,sendOpsAlert,onFatalStorage}=deps;
 function quarantine(event,context,reason){receipts.quarantine(context.stripe_platform,event.id,reason);return{status:409,body:{received:true,processed:false,code:'STRIPE_EVENT_RECONCILIATION_REQUIRED',reason}};}
 function originRow(context,kind,id,owner,evidenceRef,observedAt,purchaseId){return{stripe_platform:context.stripe_platform,stripe_platform_account_id:context.stripe_platform_account_id,object_kind:kind,provider_id:id,account_id:owner,evidence_ref:evidenceRef,first_observed_at:observedAt,provenance_version:1,...(purchaseId?{purchase_id:purchaseId}:{})};}
 function samePlatform(row,c){return row&&row.stripe_platform===c.stripe_platform&&row.stripe_platform_account_id===c.stripe_platform_account_id;}
 async function checkout(event,context){
  const session=event.data.object;const metadata=session.metadata||{};const owner=metadata.account_id,packId=metadata.pack_id,pack=packs&&packs[packId];
  const pi=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent&&session.payment_intent.id;
  if(session.object!=='checkout.session'||session.mode!=='payment'||session.payment_status!=='paid'||session.livemode!==context.livemode||session.currency!=='usd'||!pack||!Number.isSafeInteger(session.amount_total)||session.amount_total!==pack.price_cents||pack.price_usd*100!==pack.price_cents||!/^pi_[A-Za-z0-9_]+$/.test(pi||'')||!/^cs_[A-Za-z0-9_]+$/.test(session.id||'')||!owner||!getAccounts()[owner])return quarantine(event,context,'invalid_paid_checkout');
  let origin=origins.find(context,'checkout_session',session.id);
  const allIntents=checkoutIntents?checkoutIntents.all():[];
  const intent=allIntents.find(i=>samePlatform(i,context)&&(i.session_id===session.id||(metadata.auxilo_checkout_intent_id&&i.intent_id===metadata.auxilo_checkout_intent_id)));
  if(intent&&(intent.account_id!==owner||intent.pack_id!==packId||intent.amount_cents!==session.amount_total||intent.currency!=='usd'||intent.livemode!==context.livemode||(intent.session_id&&intent.session_id!==session.id)||['confirmed_not_created','confirmed_expired_unpaid'].includes(intent.state)))return quarantine(event,context,'checkout_intent_identity_conflict');
  if(origin&&origin.account_id!==owner)return quarantine(event,context,'checkout_owner_conflict');
  if(!origin&&!intent)return quarantine(event,context,'unknown_checkout_origin');
  const existingPurchase=(getPurchases?getPurchases(owner,context):[]).find(p=>p.stripe_session_id===session.id);
  if(existingPurchase&&(existingPurchase.account_id!==owner||existingPurchase.pack_id!==packId||existingPurchase.amount_usd!==pack.price_usd||existingPurchase.stripe_payment_intent!==pi))return quarantine(event,context,'purchase_identity_conflict');
  const purchaseId=(origin&&origin.purchase_id)||(existingPurchase&&existingPurchase.id)||'pur_'+digestJSON([context.stripe_platform,session.id]).slice(0,24);
  const observedAt=origin?origin.first_observed_at:new Date().toISOString();
  if(!origin){origin=originRow(context,'checkout_session',session.id,owner,'checkout-intent:'+intent.intent_id,observedAt,purchaseId);origins.record(origin);}
  // A distinct immutable identity row upgrades no existing historical origin.
  let identity=origins.find(context,'purchase_identity',session.id);
  if(identity&&(identity.account_id!==owner||identity.purchase_id!==purchaseId))return quarantine(event,context,'purchase_identity_conflict');
  if(!identity){identity=originRow(context,'purchase_identity',session.id,owner,origin.evidence_ref,observedAt,purchaseId);origins.record(identity);}
  const paymentOrigin=origins.find(context,'payment_intent',pi);
  if(paymentOrigin&&(paymentOrigin.account_id!==owner||(paymentOrigin.purchase_id&&paymentOrigin.purchase_id!==purchaseId)))return quarantine(event,context,'payment_intent_owner_conflict');
  if(!paymentOrigin)origins.record(originRow(context,'payment_intent',pi,owner,origin.evidence_ref,observedAt,purchaseId));
  if(intent&&!['paid_pending_credit','paid_credited'].includes(intent.state)) {
   checkoutIntents.transition(intent.intent_id,intent.generation,'paid_pending_credit',{session_id:session.id,payment_intent_id:pi,purchase_id:purchaseId,evidence:{verified:true,authoritative:true,evidence_ref:'signed-event:'+event.id,intent_id:intent.intent_id,account_id:owner,amount_cents:session.amount_total,currency:'usd',session_id:session.id,stripe_platform:context.stripe_platform,stripe_platform_account_id:context.stripe_platform_account_id,livemode:context.livemode}});
  }
  const alreadyProcessed=isSessionProcessed(session.id,context);
  const purchase=existingPurchase||{id:purchaseId,account_id:owner,pack_id:packId,amount_usd:pack.price_usd,stripe_session_id:session.id,stripe_payment_intent:pi,timestamp:identity.first_observed_at,stripe_platform:context.stripe_platform,stripe_platform_account_id:context.stripe_platform_account_id};
  if(!alreadyProcessed){
   const result=await addDollarLot(owner,'dollar_paid',pack.price_usd,{purchase_id:purchaseId,stripe_payment_intent:pi,stripe_platform:context.stripe_platform,stripe_platform_account_id:context.stripe_platform_account_id});
   if(!result||result.success!==true)throw Error('Mandatory credit write failed');
   await appendPurchase(purchase);
  }
  // No admission hold is released until both required financial records exist.
  if(intent)checkoutIntents.recordPaid(context,session.id,purchaseId);
  if(clearPending){try{await clearPending(session.id,context);}catch{/* Existing post-credit cache bookkeeping is nonfatal. */}}
  if(postCreditEffects&&!alreadyProcessed){try{await postCreditEffects({account_id:owner,pack_id:packId,session,purchase,context,alreadyProcessed});}catch{/* Preserve existing cap/referral nonfatal contract. */}}
  receipts.complete(context.stripe_platform,event.id,{disposition:alreadyProcessed?'already_processed':'credited'});
  return{status:200,body:{received:true,processed:true,purchase_id:purchaseId,...(alreadyProcessed?{already_processed:true}:{})}};
 }
 async function dispatch(event,context,rawDigest){
  try{validateContext(context);}catch{return{status:400,body:{error:'Invalid Stripe platform context'}};}
  if(!event||!event.id||!event.type||!event.data||!event.data.object||!event.data.object.id||typeof event.livemode!=='boolean'||event.livemode!==context.livemode||event.account||!/^[a-f0-9]{64}$/.test(rawDigest||''))return{status:400,body:{error:'Invalid Stripe event context'}};
  const object=event.data.object;const financialHandlers={'charge.dispute.created':'handleDisputeCreated','charge.dispute.closed':'handleDisputeClosed','charge.refunded':'handleChargeRefunded'};
  const pi=typeof object.payment_intent==='string'?object.payment_intent:object.payment_intent&&object.payment_intent.id;
  const semanticEvent={...event,object_id:financialHandlers[event.type]&&pi?'payment_intent:'+pi:'object:'+object.id};
  try{return await receipts.withLocks(context,semanticEvent,async()=>{
   const receipt=receipts.begin({stripe_platform:context.stripe_platform,stripe_platform_account_id:context.stripe_platform_account_id,event_id:event.id,event_type:event.type,object_id:object.id,payload_digest:rawDigest});
   if(receipt.state==='completed')return{status:200,body:{received:true,already_processed:true}};
   if(event.type==='checkout.session.completed')return checkout(event,context);
   const handler=financialHandlers[event.type];
   if(handler){const result=await refundHandlers[handler](event,{stripeContext:context,earnings:getEarnings?getEarnings():undefined,saveEarnings,sendOpsAlert});if(!result||!result.matched||result.hold_conflict)return quarantine(event,context,result&&result.hold_conflict?'dispute_hold_conflict':'unknown_financial_origin');receipts.complete(context.stripe_platform,event.id,{disposition:'financial_event_applied'});return{status:200,body:{received:true,processed:true}};}
   receipts.complete(context.stripe_platform,event.id,{disposition:'ignored'});return{status:200,body:{received:true,processed:false}};
  });}catch(error){
   if(['EVENT_RECEIPT_CONFLICT','EVENT_PURCHASE_IDENTITY_CONFLICT'].includes(error.code)&&sendOpsAlert){try{Promise.resolve(sendOpsAlert('Stripe event receipt identity conflict','platform='+context.stripe_platform+' event='+event.id,{category:'stripe-event-conflict'})).catch(()=>{});}catch{/* Alert failure cannot acknowledge a conflicting event. */}}
   if(error.financialStorageFailure&&onFatalStorage)onFatalStorage(error);
   return{status:503,body:{received:true,processed:false,code:'STRIPE_EVENT_RETRY_REQUIRED'}};
  }
 }
 return{dispatch};
}
module.exports={createStripeEventDispatcher};
