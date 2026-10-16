'use strict';
// Capabilities are minted from committed indexes, never a transaction overlay.
const {digest,fail}=require('./money-control-store');
const ACTIONS=Object.freeze(['provider_submit','provider_reconcile','persist_result','participant_effect','compensate','new_funding','new_spend','optional','boot_recovery']);
const HEX=/^[0-9a-f]{64}$/;
function key(value){if(typeof value!=='string'||!value||value.includes('\0')||Buffer.byteLength(value)>256)throw fail('RECOVERY_ANCHOR_INVALID');return value;}
function scope(row,epoch){if(!row||row.epoch_id!==epoch.epoch_id||row.binding_digest!==epoch.binding_digest)throw fail('RECOVERY_ANCHOR_INVALID');const account=row.platform_account_id??row.stripe_platform_account_id;if(account!==undefined&&account!==epoch.platform_account_id||row.livemode!==undefined&&row.livemode!==epoch.livemode)throw fail('RECOVERY_ANCHOR_INVALID');}
function createRecoveryAnchors({epoch,writer,store}){
 const caps=new WeakMap();
 function owned(){require('./money-writer-lock').assertMoneyWriter(writer,{root:epoch.legacy_root});}
 function captureRecord(id){
  const r=store.getEvidence('verified_capture',id)?.payload;scope(r,epoch);
  if(r.stripe_platform!==epoch.platform||r.stripe_platform_account_id!==epoch.platform_account_id||r.livemode!==epoch.livemode||typeof r.raw_body!=='string'||require('node:crypto').createHash('sha256').update(r.raw_body).digest('hex')!==r.raw_digest)throw fail('RECOVERY_ANCHOR_INVALID');
  const {record_hash,...body}=r;if(digest(body)!==record_hash||id!==digest([epoch.platform_account_id,epoch.livemode,r.event_id,r.raw_digest]))throw fail('RECOVERY_ANCHOR_INVALID');
  let event;try{event=JSON.parse(r.raw_body);}catch{throw fail('RECOVERY_ANCHOR_INVALID');}
  if(event.id!==r.event_id||event.type!==r.event_type||event.livemode!==r.livemode||event.account||event.data?.object?.id!==r.object_id)throw fail('RECOVERY_ANCHOR_INVALID');
  return{r,event,context:{stripe_platform:epoch.platform,stripe_platform_account_id:epoch.platform_account_id,livemode:epoch.livemode}};
 }
 function inspectCapturedEvent({id}){
  owned();key(id);const raw=store.getEvidence('verified_capture',id)?.payload;
  if(raw?.storage==='legacy_prefix')return{selection:'excluded',reason:'legacy_prefix'};
  if(raw&&typeof raw.epoch_id==='string'&&typeof raw.binding_digest==='string'&&(raw.epoch_id!==epoch.epoch_id||raw.binding_digest!==epoch.binding_digest))return{selection:'excluded',reason:'foreign_epoch'};
  const {r,event,context}=captureRecord(id),receiptId=digest([epoch.platform,r.event_id]),receipt=store.getEvidence('event_receipts',receiptId)?.payload;
  const matching=(v)=>v&&v.epoch_id===epoch.epoch_id&&v.binding_digest===epoch.binding_digest&&v.stripe_platform===epoch.platform&&v.stripe_platform_account_id===epoch.platform_account_id&&v.livemode===epoch.livemode&&v.event_id===r.event_id&&v.object_id===r.object_id;
  if(receipt&&(!matching(receipt)||receipt.receipt_id!==receiptId||receipt.event_type!==r.event_type||receipt.payload_digest!==r.raw_digest||!['processing','quarantined','completed'].includes(receipt.state)))throw fail('RECOVERY_ANCHOR_INVALID');
  let admitted=!!receipt;
  for(const disposition of ['eligible','applied']){
   const dispositionId=digest([epoch.platform,r.event_id,r.raw_digest,disposition]),row=store.getEvidence('event_dispositions',dispositionId)?.payload;
   if(row){if(!matching(row)||row.receipt_id!==dispositionId||row.raw_digest!==r.raw_digest||row.capture_sequence!==r.sequence||row.disposition!==disposition)throw fail('RECOVERY_ANCHOR_INVALID');admitted=true;}
  }
  if(!admitted)admitted=require('./financial-epoch').classifyEpochEvent({event,context,rawDigest:r.raw_digest,epoch,store}).eligible===true;
  if(!admitted)return{selection:'excluded',reason:'unmatched_optional'};
  const matches=store.listEvidence({namespace:'verified_capture',providerId:r.event_id,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,limit:2});
  if(r.conflict||matches.items.some(x=>x.payload.raw_digest!==r.raw_digest))throw fail('RECOVERY_ANCHOR_INVALID');
  const supported=['checkout.session.completed','refund.created','refund.updated','refund.failed','charge.refunded','charge.dispute.created','charge.dispute.closed'];
  if(receipt?.state==='completed'||receipt?.state==='quarantined'&&receipt.reason==='unmatched_epoch_event'&&!supported.includes(event.type))return{selection:'terminal',reason:receipt.state};
  return{selection:'pending',selector:{kind:'verified_capture',id},reason:'incomplete_event_receipt'};
 }
 function read(selector,{terminalAuthority=false}={}){
  owned();const {kind,id}=selector;key(id);let identity,accountId,sourceId=null,observationId=null,continuation=null;
  if(kind==='submitted_checkout'){
   const r=store.getEvidence('checkout_intents',id)?.payload,f=store.getCapacityRecord('funding:'+id);scope(r,epoch);
   if(!f||f.intentId!==id||f.accountId!==r.account_id||f.amountMicros!==r.amount_cents*10000||r.state==='prepared'||!r.idempotency_key||!r.fingerprint||r.fingerprint!==require('./stripe-checkout-intents').checkoutFingerprint(r))throw fail('RECOVERY_ANCHOR_INVALID');
   accountId=r.account_id;identity={id,accountId,fingerprint:r.fingerprint,idempotencyKey:r.idempotency_key,amountMicros:f.amountMicros};
  }else if(kind==='dispatch_operation'){
   const r=store.getOperation(id);scope(r,epoch);const s=r&&store.getSource(r.sourceId);scope(s,epoch);
   if(!r.provider_payload||digest(r.provider_payload)!==r.provider_payload_digest||!r.idempotency_key||!r.provider_request_digest||r.accountId!==s.accountId)throw fail('RECOVERY_ANCHOR_INVALID');
   accountId=r.accountId;sourceId=r.sourceId;identity={id,accountId,sourceId,sourceDigest:s.input_digest,requestKey:r.clientRequestKey,payloadDigest:r.provider_payload_digest,requestDigest:r.provider_request_digest,idempotencyKey:r.idempotency_key,quoteHash:r.quoteHash||null};
  }else if(kind==='verified_capture'){
   const {r}=captureRecord(id),record_hash=r.record_hash;
   accountId=null;identity={id,rawDigest:r.raw_digest,recordHash:record_hash,eventId:r.event_id,sequence:r.sequence};
  }else if(kind==='pending_source_observation'){
   const r=store.getSource(id);scope(r,epoch);sourceId=id;accountId=r.accountId;
   observationId=selector.observationId||'source-observation:'+digest({sourceId:id,observation:r.providerObservation});key(observationId);
   const observation=store.getProviderObservation(observationId);if(!observation||observation.record?.sourceId!==id)throw fail('RECOVERY_ANCHOR_INVALID');
   identity={id,sourceDigest:r.input_digest,observationId,observationDigest:digest(observation.record)};
  }else if(kind==='spend'){
   const r=store.getSpend(id);if(!r||r.digest!==digest(r.intent)||!['prepared','acknowledged','returned','realized'].includes(r.state))throw fail('RECOVERY_ANCHOR_INVALID');
   for(const d of r.draws){const s=store.getSource(d.sourceId);scope(s,epoch);if(s.accountId!==r.accountId)throw fail('RECOVERY_ANCHOR_INVALID');}
   accountId=r.accountId;identity={id,digest:r.digest,accountId};
  }else if(kind==='projection'){
   const r=store.getProjection(id);if(!r||r.digest!==digest(r.intent))throw fail('RECOVERY_ANCHOR_INVALID');const op=store.getOperation(r.operationId);scope(op,epoch);
   accountId=r.owner;sourceId=r.sourceId;identity={id,digest:r.digest,owner:r.owner,operationId:r.operationId,participant:r.participant};
  }else if(kind==='unlock_wal'){
   const r=require('./wal').readRecoveryProof(id,{store,epoch});
   if(r){
    if(!HEX.test(r.digest||'')||!HEX.test(r.spendDigest||'')||!HEX.test(r.realizationReceiptDigest||''))throw fail('RECOVERY_ANCHOR_INVALID');
    key(r.spendId);accountId=r.accountId;continuation={spendId:r.spendId,spendDigest:r.spendDigest,walPayloadDigest:r.digest,realizationReceiptDigest:r.realizationReceiptDigest};
   }else{
    continuation=selector.continuation&&structuredClone(selector.continuation);
    if(!terminalAuthority||!continuation)throw fail('RECOVERY_ANCHOR_INVALID');
    const spend=store.getSpend(continuation.spendId),pool=store.getPool('unlock:'+id);
    if(!spend||spend.digest!==continuation.spendDigest||spend.state!=='realized'||spend.realizationId!=='unlock:'+id||pool?.receipt_digest!==continuation.realizationReceiptDigest||pool.buyerId!==spend.accountId)throw fail('RECOVERY_ANCHOR_INVALID');
    accountId=spend.accountId;
   }
   identity={id,...continuation,accountId};
  }else throw fail('RECOVERY_ANCHOR_INVALID');
  if(selector.accountId!==undefined&&selector.accountId!==accountId||selector.sourceId!==undefined&&selector.sourceId!==sourceId)throw fail('RECOVERY_ANCHOR_INVALID');
  return{schema:1,kind,id,continuation,namespace:kind==='verified_capture'?'verified_capture':kind==='submitted_checkout'?'checkout_intents':null,observationId,immutableDigest:digest(identity),accountDigest:accountId?digest(accountId):null,sourceDigest:sourceId?digest(sourceId):null,epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,database_id:store.descriptor.database_id};
 }
 function resolveCommittedAnchor(selector){const descriptor=read(selector),cap=Object.freeze({});caps.set(cap,Object.freeze(descriptor));return cap;}
 function describe(cap){owned();const d=caps.get(cap);if(!d)throw fail('RECOVERY_ANCHOR_REQUIRED');return structuredClone(d);}
 function restore(d){if(!d||d.epoch_id!==epoch.epoch_id||d.binding_digest!==epoch.binding_digest||d.database_id!==store.descriptor.database_id)throw fail('RECOVERY_ANCHOR_INVALID');const persisted=d.kind==='unlock_wal'?store.failureControlProof?.()?.anchor:null;const terminalAuthority=!!persisted&&digest(persisted)===digest(d),actual=read(d,{terminalAuthority});if(digest(actual)!==digest(d))throw fail('RECOVERY_ANCHOR_INVALID');const cap=Object.freeze({});caps.set(cap,Object.freeze(actual));return cap;}
 function revalidate(cap){const d=describe(cap);if(digest(read(d,{terminalAuthority:true}))!==digest(d))throw fail('RECOVERY_ANCHOR_INVALID');return d;}
 function isResolved(cap){const d=revalidate(cap);if(d.kind==='spend'){const s=store.getSpend(d.id);return s.state==='realized'||s.state==='returned'&&s.restoreReceipt?.projection_id===s.id+':restore'&&s.restoreReceipt.digest===s.digest&&store.getAppliedEffect({participant:'credits',owner:s.accountId,id:s.id+':restore'})?.effect_digest===s.digest;}
  if(d.kind==='projection'){const p=store.getProjection(d.id);return p.state==='acknowledged'&&p.receipt?.digest===p.digest;}
  if(d.kind==='dispatch_operation'){const o=store.getOperation(d.id);return ['settled','failed','canceled','requote_required'].includes(o.state)&&o.projectionIds.every(id=>['acknowledged','superseded'].includes(store.getProjection(id)?.state));}
  if(d.kind==='submitted_checkout'){const r=store.getEvidence('checkout_intents',d.id).payload;return ['confirmed_open','paid_credited','confirmed_expired_unpaid','confirmed_not_created'].includes(r.state)&&r.evidence?.verified===true&&r.evidence.authoritative===true;}
  if(d.kind==='verified_capture')return inspectCapturedEvent({id:d.id}).selection==='terminal';
  if(d.kind==='pending_source_observation'){const s=store.getSource(d.id);return !s.frozen&&!s.refund_scan_cursor&&s.providerObservation?.complete===true&&!store.hasPendingSourceRefund({sourceId:d.id});}
  if(d.kind==='unlock_wal'){const p=store.getPool('unlock:'+d.id),v=store.getSpend(d.continuation.spendId);return !!p&&p.receipt_digest===d.continuation.realizationReceiptDigest&&v?.state==='realized'&&v.realizationId===p.id&&v.digest===d.continuation.spendDigest;}
  return false;
 }
 return Object.freeze({resolveCommittedAnchor,describe,restore,revalidate,isResolved,inspectCapturedEvent});
}
module.exports={ACTIONS,createRecoveryAnchors};
