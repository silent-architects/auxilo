'use strict';
const {checkoutFingerprint}=require('./stripe-checkout-intents');
function failure(code){const e=new Error(code);e.code=code;return e;}
// One account lock spans durable admission and the sole provider create. A lost
// response retains its reservation and intent; neither time nor retries resend.
function createCheckoutAdmission(d){return async function({accountId,packId,amountUsd,baseUrl}){
 if(!d.intents.ready)throw failure('CHECKOUT_RECONCILIATION_REQUIRED');
 const release=await d.lock(accountId);let intent;
 try{
  const control=d.control();
  const blocked=d.intents.blocking(accountId);
  if(blocked){const e=failure('CHECKOUT_RECONCILIATION_REQUIRED');e.attempt_id=blocked.intent_id;throw e;}
  const context=await d.getContext(control.intake_platform);
  const current=d.control();
  if(current.intake_platform!==context.stripe_platform||current.generation!==control.generation)throw failure('MIGRATION_STATE_CHANGED');
  const input={...context,account_id:accountId,pack_id:packId,amount_cents:Math.round(amountUsd*100),currency:'usd',base_url:baseUrl};
  const open=d.intents.findOpen(accountId,checkoutFingerprint(input));
  if(open)return {url:open.session_url,session_id:open.session_id};
  d.checkCaps(accountId,amountUsd);
  intent=d.intents.prepare(input);
  const reservation=d.reserve(accountId,amountUsd,Date.now(),context);
  intent=d.intents.transition(intent.intent_id,intent.generation,'submitted');
  const session=await d.createSession(accountId,packId,baseUrl,{context,idempotencyKey:intent.idempotency_key,intentId:intent.intent_id});
  const latest=d.intents.get(intent.intent_id);
  if(['paid_pending_credit','paid_credited'].includes(latest.state))throw failure('CHECKOUT_PAYMENT_PROCESSING');
  d.promote(reservation,session.session_id,accountId,amountUsd,session.expires_at,Date.now(),context);
  intent=d.intents.transition(intent.intent_id,latest.generation,'confirmed_open',{
   session_id:session.session_id,session_url:session.url,expires_at:session.expires_at*1000,cap_state_durable:true,
   evidence:{verified:true,authoritative:true,evidence_ref:'checkout-create:'+session.session_id,intent_id:intent.intent_id,account_id:accountId,amount_cents:input.amount_cents,currency:'usd',session_id:session.session_id,stripe_platform:context.stripe_platform,stripe_platform_account_id:context.stripe_platform_account_id,livemode:context.livemode}
  });
  return {url:session.url,session_id:session.session_id};
 }catch(error){
  if(intent&&d.intents.ready){const latest=d.intents.get(intent.intent_id);if(latest.state==='submitted')d.intents.transition(latest.intent_id,latest.generation,'unknown',{last_error_code:'PROVIDER_OUTCOME_UNKNOWN'});}
  if(intent){const blocked=failure('CHECKOUT_RECONCILIATION_REQUIRED');blocked.attempt_id=intent.intent_id;throw blocked;}
  throw error;
 }finally{release();}
};}
module.exports={createCheckoutAdmission};
