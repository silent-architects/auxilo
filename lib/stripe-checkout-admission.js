'use strict';
const {checkoutFingerprint}=require('./stripe-checkout-intents');
function failure(code){const e=new Error(code);e.code=code;return e;}
// One account lock spans durable admission and the sole provider create. A lost
// response retains its reservation and intent; neither time nor retries resend.
function createCheckoutAdmission(d){if(d.epoch)return createProspectiveCheckoutAdmission(d);return async function({accountId,packId,amountUsd,baseUrl}){
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
function createProspectiveCheckoutAdmission(d){
 const epoch=d.epoch;
 if(!d.coordinator?.withMoneyControl)throw failure('MONEY_RUNTIME_REQUIRED');
 const authorize=d.authorize||(input=>require('./financial-epoch').assertProspectiveAllowed(input));
 const consent=d.policyConsent||((accountId)=>require('./financial-epoch').policyConsent(accountId,epoch));
 const local=(accountId,fn,recoveryAnchor)=>d.coordinator.withMoneyControl({kind:'checkout',accounts:[accountId],credits:[accountId],epochRevision:epoch.activation_revision,...(recoveryAnchor?{recoveryAnchor,action:'persist_result'}:{action:'new_funding'})},fn);
 function permission(accountId){authorize({action:'funding',epoch,expectedRevision:epoch.activation_revision,accountId});}
 return async function({accountId,packId,amountUsd,baseUrl}){
  const manager=d.coordinator.failureControl,anchors=d.coordinator.recoveryAnchors;
  if(!d.intents.ready)throw failure('CHECKOUT_RECONCILIATION_REQUIRED');
  permission(accountId);manager?.assertNewEffectAllowed({action:'new_funding'});
  // Registry identity probing may use the provider. It precedes all money and
  // participant guards; prepare/submitted is durable before the sole POST.
  const context=await d.getContext(epoch.platform);
  if(context.stripe_platform!==epoch.platform||context.stripe_platform_account_id!==epoch.platform_account_id||context.livemode!==epoch.livemode)throw failure('INVALID_STRIPE_CONTEXT');
  let intent,reservation,recoveryAnchor;
  try{
   const prepared=await local(accountId,ctx=>{
    permission(accountId);const policy=consent(accountId);
    if(!policy?.policy_version||!policy.consent_id)throw failure('EPOCH_POLICY_CONSENT_REQUIRED');
    const input={...context,account_id:accountId,pack_id:packId,amount_cents:Math.round(amountUsd*100),currency:'usd',base_url:baseUrl,epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,policy_version:policy.policy_version,policy_consent_id:policy.consent_id};
    const blocked=d.intents.blocking(accountId);if(blocked){const e=failure('CHECKOUT_RECONCILIATION_REQUIRED');e.attempt_id=blocked.intent_id;throw e;}
    const open=d.intents.findOpen(accountId,checkoutFingerprint(input));if(open)return {open};
    d.checkCaps(accountId,amountUsd);
    const amountMicros=require('./money-control').toMicros(amountUsd);
    ctx.assertFundingCapacity({accountId,amountMicros});
    intent=d.intents.prepare(input);
    ctx.reserveFundingCapacity({intentId:intent.intent_id,accountId,amountMicros});
    ctx.flush(); // Protected completion space must be durable before provider funding.
    reservation=d.reserve(accountId,amountUsd,Date.now(),{...context,epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest});
    intent=d.intents.transition(intent.intent_id,intent.generation,'submitted');ctx.flush();return {intent};
   });
   if(prepared.open)return {url:prepared.open.session_url,session_id:prepared.open.session_id};
   if(manager){recoveryAnchor=anchors.resolveCommittedAnchor({kind:'submitted_checkout',id:intent.intent_id,accountId});manager.assertNewEffectAllowed({action:'provider_submit'});}
   const session=await d.createSession(accountId,packId,baseUrl,{context,idempotencyKey:intent.idempotency_key,intentId:intent.intent_id,epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,policy_version:intent.policy_version,policy_consent_id:intent.policy_consent_id});
   return await local(accountId,()=>{
    const latest=d.intents.get(intent.intent_id);
    if(['paid_pending_credit','paid_credited'].includes(latest.state))throw failure('CHECKOUT_PAYMENT_PROCESSING');
    // A generation change closes admission; it cannot release a possibly sent
    // operation. Recovery/verified webhook remains independently available.
    permission(accountId);
    d.promote(reservation,session.session_id,accountId,amountUsd,session.expires_at,Date.now(),context);
    intent=d.intents.transition(intent.intent_id,latest.generation,'confirmed_open',{session_id:session.session_id,session_url:session.url,expires_at:session.expires_at*1000,cap_state_durable:true,evidence:{verified:true,authoritative:true,evidence_ref:'checkout-create:'+session.session_id,intent_id:intent.intent_id,account_id:accountId,amount_cents:intent.amount_cents,currency:'usd',session_id:session.session_id,stripe_platform:context.stripe_platform,stripe_platform_account_id:context.stripe_platform_account_id,livemode:context.livemode}});
    return {url:session.url,session_id:session.session_id};
   },recoveryAnchor);
  }catch(error){
   if(intent&&d.intents.ready)await local(accountId,()=>{const latest=d.intents.get(intent.intent_id);if(latest.state==='submitted')d.intents.transition(intent.intent_id,latest.generation,'unknown',{last_error_code:'PROVIDER_OUTCOME_UNKNOWN'});},recoveryAnchor);
   if(intent){const blocked=failure('CHECKOUT_RECONCILIATION_REQUIRED');blocked.attempt_id=intent.intent_id;throw blocked;}throw error;
  }
 };
}
module.exports={createCheckoutAdmission,createProspectiveCheckoutAdmission};
