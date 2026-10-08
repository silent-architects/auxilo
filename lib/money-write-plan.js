'use strict';
// Pure description of the exact normalized mutation families. Counts are quotas,
// not a claim about SQLite's maximum dirty-page or rollback-journal footprint.
const database=require('./money-database');
const {fail,safe,EDGES,cashEffectIds}=database;
function describeWritePlan({epoch,changes=[],evidence=[],capacities=[],scans=[],operational=null,cashReflectionChanged=false,databaseSchema,profile,profileDigest,lookup,lookupCommitted=lookup,getCapacity,getStagedCapacity=()=>undefined,indexCount,scanCount,scanHasMember=()=>false,scanCurrentChanges=()=>0,evidenceCapacity=()=>undefined}){
 if(!profile?.grouped)throw fail('CAPACITY_GROUP_PROFILE_REQUIRED');
 const quoteChanges=changes.filter(c=>c.name==='quotes'),quoteMode=quoteChanges.length>0&&profile.grouped.commitProtocol==='single_sql_v1';
 if(quoteMode){if(databaseSchema!==3||profile.workspace?.schema!==2)throw fail('QUOTE_STORAGE_UPGRADE_REQUIRED');if(scans.length)throw fail('ATOMIC_OPERATIONAL_SCOPE_CONFLICT');if(!operational||operational.kind!=='quotes'||operational.generation!==operational.priorGeneration+1)throw fail('OPERATIONAL_CONTROL_INVALID');if(quoteChanges.length>profile.workspace.maxQuoteChangesPerCommit)throw fail('CAPACITY_OPTIONAL_QUOTE_LIMIT');}
 const quoteOnly=quoteMode&&quoteChanges.length===changes.length&&!evidence.length&&!capacities.length&&!cashReflectionChanged;
 const units=[];
 const hash=require('./stripe-transfer-persistence').digestJSON;
 const count=value=>{if(!Number.isSafeInteger(value)||value<0)throw fail('CAPACITY_PLAN_COUNT_INVALID');return value;};
 function add(key,table,owner,oldRows,newRows,payload,kind='permanent'){
  count(oldRows);count(newRows);const indexes=count(indexCount(table));
  units.push({key,table,owner,kind,oldRows,newRows,indexEntries:safe(BigInt(oldRows+newRows)*BigInt(indexes)),encodedBytes:Buffer.byteLength(JSON.stringify(payload??null))});
 }
 function funding(sourceId,admission){
  const source=lookup('sources',sourceId)||admission;if(!source||source.id!==sourceId)throw fail('CAPACITY_SOURCE_REQUIRED');
  const binding=getCapacity('source:'+sourceId),id=binding?.reservationId||source.capacityReservationId||'funding:'+source.provenance?.intent_id;
  const r=getCapacity(id);if(!r||r.state!=='reserved'||r.profileDigest!==profileDigest||r.accountId!==source.accountId||r.amountMicros!==source.amountMicros||r.sourceId&&r.sourceId!==sourceId||!r.sourceId&&r.intentId!==source.provenance?.intent_id)throw fail('CAPACITY_OWNER_CONFLICT');
  return id;
 }
 function spendBinding(name,row,id){
  if(profile.grouped.commitProtocol!=='single_sql_v1')throw fail('CAPACITY_FRAGMENT_ROUTING_REQUIRED');
  const hash=require('./stripe-transfer-persistence').digestJSON,key=row.capacityReservationId||'spend:'+id,committed=getCapacity(key),r=committed||getStagedCapacity(key),fresh=!committed;
  const bad=()=>{throw fail('CAPACITY_SPEND_BINDING_REQUIRED');};
  if(!r||r.id!==key||key!=='spend:'+r.spendId||r.state!=='reserved'||r.profileDigest!==profileDigest||!Array.isArray(r.fragments)||!r.fragments.length)bad();
  const spend=name==='spends'?row:lookup('spends',r.spendId),priorSpend=lookupCommitted('spends',r.spendId);
  if(!spend||spend.id!==r.spendId||spend.accountId!==r.accountId||!Array.isArray(spend.draws)||!spend.draws.length||!spend.intent||r.requestDigest!==spend.digest)bad();
  const hasVector=Object.hasOwn(spend.intent,'participantDraws')||Object.hasOwn(spend.intent,'participantDrawsDigest')||Object.hasOwn(spend,'participantDraws')||Object.hasOwn(spend,'participantDrawsDigest');
  const canonicalIntent={id:spend.id,accountId:spend.accountId,draws:spend.draws};
  if(hasVector){
   if(!Array.isArray(spend.participantDraws)||spend.participantDrawsDigest!==hash(spend.participantDraws))bad();
   try{require('./money-control').validateParticipantDraws({participantDraws:spend.participantDraws,draws:spend.draws,accountId:spend.accountId,getSource:id=>lookup('sources',id),getProjection:id=>lookup('projections',id)});}catch{bad();}
   canonicalIntent.participantDraws=spend.participantDraws;canonicalIntent.participantDrawsDigest=spend.participantDrawsDigest;
  }else if(fresh||!priorSpend)bad(); // Retained legacy authority never admits a new vectorless spend.
  if(hash(canonicalIntent)!==spend.digest||hash(spend.intent)!==spend.digest)bad();
  if(fresh){if(name!=='spends'||priorSpend||spend.state!=='prepared')bad();}
  else if(!priorSpend||priorSpend.digest!==spend.digest||hash(priorSpend.draws)!==hash(spend.draws)||priorSpend.accountId!==r.accountId)bad();
  const grouped=new Map();for(const draw of spend.draws){if(!draw.sourceId||!Number.isSafeInteger(draw.amountMicros)||draw.amountMicros<=0)bad();const item=grouped.get(draw.sourceId)||{amount:0n,count:0};item.amount+=BigInt(draw.amountMicros);item.count++;grouped.set(draw.sourceId,item);}
  if(grouped.size!==r.fragments.length)bad();const seen=new Set();let remaining=0n;
  for(const f of r.fragments){const expected=grouped.get(f.sourceId);if(seen.has(f.sourceId)||!expected||BigInt(f.amountMicros)!==expected.amount||f.fragmentCount!==expected.count||!Number.isSafeInteger(f.remainingBytes)||f.remainingBytes<0||!Number.isSafeInteger(f.bytes)||f.remainingBytes>f.bytes||f.reservationId!==funding(f.sourceId))bad();seen.add(f.sourceId);remaining+=BigInt(f.remainingBytes);}
  if(remaining!==BigInt(r.remainingBytes))bad();
  if(name==='pools'){if(fresh||row.buyerId!==r.accountId||r.realizationId&&r.realizationId!==id||!['acknowledged','realized'].includes(spend.state)||!Array.isArray(row.fragments)||row.fragments.length!==spend.draws.length)bad();for(let i=0;i<row.fragments.length;i++){const f=row.fragments[i],draw=spend.draws[i];if(f.sourceId!==draw.sourceId||f.paidMicros!==draw.amountMicros)bad();}}
  return{reservation:r,fresh,common:fresh?'@admission':'shared-hold:'+require('./money-capacity').sharedIdentity(epoch,'spend',r.spendId).obligationId,fragment:sourceId=>{if(!seen.has(sourceId))bad();return fresh?'@admission':JSON.stringify([r.id,sourceId]);}};
 }
 function recordOwner(name,row,id){
  if(name==='quotes')return quoteMode?'@quote_workspace':'@optional';
  if(['liquidity_evidence','lifecycle'].includes(name))return'@shared';
  if(['spends','pools'].includes(name))return spendBinding(name,row,id).common;
  let sourceId=name==='sources'?id:row.sourceId||row.source_id||row.record?.sourceId||row.record?.source_id;
  const opId=row.operationId||row.record?.operationId;
  if(opId){const op=lookup('operations',opId);if(!op)throw fail('CAPACITY_OPERATION_REQUIRED');if(sourceId&&sourceId!==op.sourceId)throw fail('CAPACITY_OWNER_CONFLICT');sourceId=op.sourceId;}
  const costId=row.costId||row.record?.costId;if(costId){const c=lookup('costs',costId);if(!c||sourceId&&sourceId!==c.sourceId)throw fail('CAPACITY_OWNER_CONFLICT');sourceId=c.sourceId;}
  if(!sourceId)throw fail('CAPACITY_OWNER_REQUIRED');return funding(sourceId,name==='sources'?row:undefined);
 }
 for(const c of changes){
  const row=c.value||c.prior;if(!row)continue;
  const owner=recordOwner(c.name,row,c.id);add(c.name+':'+c.id,c.name,owner,c.prior?1:0,c.value?1:0,row,owner==='@quote_workspace'?'operational_quotes':'permanent');
  for(const field of EDGES[c.name]||[]){const before=c.prior?.[field],after=c.value?.[field],oldRows=before?Object.keys(before).length:0,newRows=after?Object.keys(after).length:0;
   if(['spends','pools'].includes(c.name)&&oldRows+newRows){const binding=spendBinding(c.name,row,c.id);for(const key of new Set([...Object.keys(before||{}),...Object.keys(after||{})])){const a=before?.[key],b=after?.[key],sourceId=(b||a)?.sourceId||(b||a)?.source_id;if(a&&b&&(a.sourceId||a.source_id)!==(b.sourceId||b.source_id))throw fail('CAPACITY_SPEND_BINDING_REQUIRED');const edgeOwner=['draws','fragments'].includes(field)?binding.fragment(sourceId):sourceId?binding.fragment(sourceId):binding.common;add(c.name+':'+c.id+':'+field+':'+key,'money_edges',edgeOwner,a===undefined?0:1,b===undefined?0:1,{before:a,after:b});}}
   else if(oldRows||newRows)add(c.name+':'+c.id+':'+field,'money_edges',owner,oldRows,newRows,{before,after});} 
  if(c.name==='operations'){
   add('cash:'+c.id,'cash_commitments',owner,c.prior?1:0,c.value?1:0,row);
   add('effects:'+c.id,'cash_effects',owner,c.prior?cashEffectIds(c.prior).length:0,c.value?cashEffectIds(c.value).length:0,row);
  }
 }
 function evidenceBinding(e,selector){
  const payload=e.payload;
  if(payload.epoch_id!==epoch.epoch_id||payload.binding_digest!==epoch.binding_digest||(payload.platform_account_id||payload.stripe_platform_account_id)!==epoch.platform_account_id||payload.livemode!==epoch.livemode)throw fail('CAPACITY_EVIDENCE_BINDING_REQUIRED');
  let object;
  if(e.namespace==='verified_capture'){
   if(typeof payload.raw_body!=='string'||require('node:crypto').createHash('sha256').update(payload.raw_body).digest('hex')!==payload.raw_digest)throw fail('CAPACITY_EVIDENCE_BINDING_REQUIRED');
   let event;try{event=JSON.parse(payload.raw_body);}catch{throw fail('CAPACITY_EVIDENCE_BINDING_REQUIRED');}
   object=event.data?.object;if(!object||event.id!==payload.event_id||event.livemode!==epoch.livemode||event.account||object.id!==payload.object_id||payload.event_type!==undefined&&event.type!==payload.event_type)throw fail('CAPACITY_EVIDENCE_BINDING_REQUIRED');
  }else if(e.namespace==='checkout_intents'){
   if(payload.intent_id!==selector.checkoutIntentId)throw fail('CAPACITY_EVIDENCE_BINDING_REQUIRED');
  }else if(e.namespace==='object_origins'){
   if(selector.checkoutIntentId&&payload.evidence_ref!=='checkout-intent:'+selector.checkoutIntentId)throw fail('CAPACITY_EVIDENCE_BINDING_REQUIRED');
  }else if(e.namespace==='event_dispositions'){
   const id=require('./stripe-transfer-persistence').digestJSON([payload.stripe_platform_account_id,payload.livemode,payload.event_id,payload.raw_digest]),captured=lookup('verified_capture',id);
   if(!captured||captured.event_id!==payload.event_id||captured.object_id!==payload.object_id||captured.raw_digest!==payload.raw_digest)throw fail('CAPACITY_EVENT_RECEIPT_BINDING_REQUIRED');
   evidenceBinding({namespace:'verified_capture',payload:captured},selector);return;
  }else if(e.namespace==='event_receipts'){
   const id=require('./stripe-transfer-persistence').digestJSON([payload.stripe_platform_account_id,payload.livemode,payload.event_id,payload.payload_digest]);
   const captured=lookup('verified_capture',id);
   if(!captured||captured.event_id!==payload.event_id||captured.object_id!==payload.object_id||captured.event_type!==payload.event_type||captured.raw_digest!==payload.payload_digest)throw fail('CAPACITY_EVENT_RECEIPT_BINDING_REQUIRED');
   evidenceBinding({namespace:'verified_capture',payload:captured},selector);return;
  }
  else throw fail('CAPACITY_EVIDENCE_BINDING_REQUIRED');
  if(selector.checkoutIntentId){const intent=lookup('checkout_intents',selector.checkoutIntentId);if(!intent)throw fail('CAPACITY_EVIDENCE_BINDING_REQUIRED');if(object){if(object.metadata?.auxilo_checkout_intent_id!==selector.checkoutIntentId||object.metadata.account_id!==intent.account_id||object.amount_total!==intent.amount_cents||object.currency!==intent.currency||intent.session_id&&intent.session_id!==object.id)throw fail('CAPACITY_EVIDENCE_BINDING_REQUIRED');}else if(payload.account_id!==intent.account_id)throw fail('CAPACITY_EVIDENCE_BINDING_REQUIRED');}
  if(selector.sourceId||selector.operationId){const operation=selector.operationId&&lookup('operations',selector.operationId),source=lookup('sources',selector.sourceId||operation?.sourceId);if(!source)throw fail('CAPACITY_EVIDENCE_BINDING_REQUIRED');const id=value=>typeof value==='string'?value:value?.id;const same=(a,b)=>typeof a==='string'&&a.length>0&&typeof b==='string'&&a===b;const providerId=payload.provider_id||payload.object_id;if(object){const charge=object.object==='charge'?object.id:id(object.charge),pi=object.object==='payment_intent'?object.id:id(object.payment_intent);if((charge&&source.charge_id&&charge!==source.charge_id)||(pi&&source.payment_intent_id&&pi!==source.payment_intent_id))throw fail('CAPACITY_EVIDENCE_BINDING_REQUIRED');}const matches=object?object.object==='charge'&&same(object.id,source.charge_id)||same(id(object.charge),source.charge_id)||same(id(object.payment_intent),source.payment_intent_id):same(providerId,source.charge_id)||same(providerId,source.payment_intent_id)||operation&&same(providerId,operation.refund_id);if(!matches)throw fail('CAPACITY_EVIDENCE_BINDING_REQUIRED');}
 }
 function capturePair(id){
  const body=evidence.find(x=>x.namespace==='verified_capture'&&x.id===id),head=evidence.find(x=>x.namespace==='capture_heads'&&x.id==='capture_suffix_v2'),prior=lookupCommitted('capture_heads','capture_suffix_v2');
  const bad=()=>{throw fail('CAPACITY_CAPTURE_HEAD_BINDING_REQUIRED');};
  if(!body||!head||!prior)bad();const b=body.payload,h=head.payload,bs=evidenceCapacity(body.namespace,body.id),hs=evidenceCapacity(head.namespace,head.id);
  const category=x=>x&&Object.fromEntries(['mandatory','captureId','sourceId','operationId','checkoutIntentId'].filter(k=>x[k]!==undefined).map(k=>[k,x[k]]));
  if(typeof bs?.mandatory!=='boolean'||bs.captureId!==id||hs?.captureId!==id||hash(category(bs))!==hash(category(hs))||id!==hash([b.stripe_platform_account_id,b.livemode,b.event_id,b.raw_digest]))bad();
  const {record_hash,...unsigned}=b;if(record_hash!==hash(unsigned)||!Number.isSafeInteger(prior.lastSequence)||b.sequence!==prior.lastSequence+1||b.previous_hash!==prior.headHash||h.lastSequence!==b.sequence||h.headHash!==record_hash)bad();
  const immutable=x=>Object.fromEntries(Object.entries(x).filter(([k])=>!['lastSequence','headHash'].includes(k)));
  if(hash(immutable(h))!==hash(immutable(prior)))bad();evidenceBinding(body,bs);return bs;
 }
 function restrictedDisposition(e){
  const p=e.payload,keys=['receipt_id','epoch_id','binding_digest','stripe_platform','stripe_platform_account_id','livemode','event_id','object_id','raw_digest','capture_sequence','disposition','effect_receipt_id'];
  if(Object.keys(p).length!==keys.length||Object.keys(p).some(k=>!keys.includes(k))||p.disposition!=='restricted'||p.effect_receipt_id!==null||p.stripe_platform!==epoch.platform||p.receipt_id!==e.id||e.id!==hash([p.stripe_platform,p.event_id,p.raw_digest,p.disposition]))throw fail('CAPACITY_OWNER_REQUIRED');
  const captured=lookupCommitted('verified_capture',hash([p.stripe_platform_account_id,p.livemode,p.event_id,p.raw_digest]));
  if(!captured||captured.sequence!==p.capture_sequence)throw fail('CAPACITY_EVENT_RECEIPT_BINDING_REQUIRED');evidenceBinding(e,{});
 }
 const sharedEvidence=new Set(['provider_effects','provider_inventory','capture_heads']);
 for(const e of evidence){
  let owner;
  if(e.namespace==='checkout_intents'&&e.payload.state==='prepared'&&profile.grouped.commitProtocol==='single_sql_v1'&&!getCapacity('funding:'+e.id)){const r=getStagedCapacity('funding:'+e.id),p=e.payload;if(!r||r.state!=='reserved'||r.intentId!==e.id||p.intent_id!==e.id||r.accountId!==p.account_id||r.profileDigest!==profileDigest||!Number.isSafeInteger(p.amount_cents)||BigInt(p.amount_cents)*10000n!==BigInt(r.amountMicros)||p.currency!=='usd'||p.epoch_id!==epoch.epoch_id||p.binding_digest!==epoch.binding_digest||(p.platform_account_id||p.stripe_platform_account_id)!==epoch.platform_account_id||p.livemode!==epoch.livemode)throw fail('CAPACITY_OWNER_CONFLICT');owner='@admission';}
  else if(e.namespace==='capture_heads'){const selector=capturePair(evidenceCapacity(e.namespace,e.id)?.captureId);owner=selector.mandatory?'@shared':'@optional';}
  else if(sharedEvidence.has(e.namespace)){
   for(const k of ['epoch_id','binding_digest'])if(e.payload[k]!==epoch[k])throw fail('CAPACITY_OWNER_CONFLICT');
   if(e.namespace!=='capture_heads')for(const k of ['platform_account_id','livemode'])if(e.payload[k]!==epoch[k])throw fail('CAPACITY_OWNER_CONFLICT');
   owner='@shared';
  }else if(e.namespace==='cash_reflections')owner=recordOwner('operations',e.payload,e.id);
  else if(e.namespace==='applied_effects'){
   const p=lookup('projections',e.payload.id),hash=require('./stripe-transfer-persistence').digestJSON;
   if(!p){const v=e.payload,restore=typeof v.id==='string'&&v.id.endsWith(':restore'),id=restore?v.id.slice(0,-8):v.id,spend=lookup('spends',id),receipt=restore?spend?.restoreReceipt:spend?.receipt;
    if(!spend||v.participant!=='credits'||v.owner!==spend.accountId||v.epoch_id!==epoch.epoch_id||v.binding_digest!==epoch.binding_digest||e.id!==hash([epoch.epoch_id,epoch.binding_digest,v.participant,v.owner,v.id])||v.effect_digest!==spend.digest||receipt?.projection_id!==v.id||receipt?.digest!==spend.digest||hash(receipt)!==hash(v.receipt)||(restore?spend.state!=='returned':!['acknowledged','realized','returned'].includes(spend.state)))throw fail('CAPACITY_APPLIED_EFFECT_ROUTING_REQUIRED');
    const binding=spendBinding('spends',spend,id);if(binding.fresh)throw fail('CAPACITY_APPLIED_EFFECT_ROUTING_REQUIRED');owner=binding.common;
   }else{if(e.payload.epoch_id!==epoch.epoch_id||e.payload.binding_digest!==epoch.binding_digest||e.id!==hash([epoch.epoch_id,epoch.binding_digest,e.payload.participant,e.payload.owner,e.payload.id])||p.state!=='acknowledged'||p.owner!==e.payload.owner||p.participant!==e.payload.participant||p.digest!==e.payload.effect_digest||hash(p.receipt)!==hash(e.payload.receipt))throw fail('CAPACITY_APPLIED_EFFECT_ROUTING_REQUIRED');owner=recordOwner('projections',p,p.id);}
  }
  else if(['verified_capture','object_origins','checkout_intents','event_receipts','event_dispositions','enrollment_proofs'].includes(e.namespace)){
   const selector=evidenceCapacity(e.namespace,e.id);
   if(!selector)throw fail('CAPACITY_OWNER_REQUIRED');
   if(selector.mandatory!==true){if(e.namespace==='verified_capture'){evidenceBinding(e,{});capturePair(e.id);}else if(e.namespace==='event_dispositions')restrictedDisposition(e);else throw fail('CAPACITY_OWNER_REQUIRED');owner='@optional';}
   else {
    evidenceBinding(e,selector);if(e.namespace==='verified_capture')capturePair(e.id);
    if(selector.operationId||selector.sourceId)owner=recordOwner('evidence',{operationId:selector.operationId,sourceId:selector.sourceId},e.id);
   else if(selector.checkoutIntentId){const r=getCapacity('funding:'+selector.checkoutIntentId);if(!r||r.state!=='reserved'||r.profileDigest!==profileDigest)throw fail('CAPACITY_OWNER_CONFLICT');const intent=lookup('checkout_intents',selector.checkoutIntentId);if(!intent||intent.account_id!==r.accountId&&intent.accountId!==r.accountId)throw fail('CAPACITY_OWNER_CONFLICT');owner=r.id;}
    else throw fail('CAPACITY_OWNER_REQUIRED');
   }
  }else throw fail('CAPACITY_OWNER_REQUIRED');
  add('evidence:'+e.namespace+':'+e.id,'evidence',owner,e.revision>1?1:0,1,e);
 }
 for(const r of capacities){add('capacity:'+r.id,'capacity_reservations','@shared',getCapacity(r.id)?1:0,1,r);}
 for(const[scope,change]of scans){
  const generation=change.value?.generation||change.clearGeneration;
  if(!Number.isSafeInteger(generation)||generation<1)throw fail('PROVIDER_SCAN_GENERATION_CONFLICT');
  const existing=count(scanCount(scope,generation));
  if(change.clearGeneration){
   const current=change.complete?scanCurrentChanges(scope,generation):{oldRows:0,newRows:0};
   const currentRows=typeof current==='number'?{oldRows:count(current),newRows:count(current)}:current;
   add('scan:'+scope+':current','provider_scan_current','@shared',count(currentRows.oldRows),count(currentRows.newRows),{generation});
   add('scan:'+scope+':members','provider_scan_members','@workspace',existing,0,{generation},'workspace');
   add('scan:'+scope+':control','provider_scan_controls','@workspace',1,0,{generation},'workspace');
  }else{
   const unique=new Set();let added=0,updated=0;
   for(const row of change.rows||[]){if(unique.has(row.providerId))throw fail('PROVIDER_INVENTORY_CURSOR_CONFLICT');unique.add(row.providerId);if(scanHasMember(scope,generation,row.providerId))updated++;else added++;}
   const limit=profile.workspace?.maxWorkspaceMembers;if(!Number.isSafeInteger(limit)||limit<1)throw fail('WORKSPACE_PROFILE_REQUIRED');
   if(existing+added>limit)throw fail('WORKSPACE_MEMBER_LIMIT');
   add('scan:'+scope+':members','provider_scan_members','@workspace',updated,updated+added,change.rows,'workspace');
   add('scan:'+scope+':control','provider_scan_controls','@workspace',change.value.revision>1?1:0,1,change.value,'workspace');
  }
 }
 if(quoteMode)add('operational:quotes','operational_controls','@quote_workspace',1,1,operational,'operational_quotes');
 add('metadata','metadata',quoteOnly?'@quote_workspace':'@shared',1,1,null,quoteOnly?'operational_quotes':'permanent');
 if(!quoteOnly)add('audit','audit_events','@shared',0,1,null);
 const normalizedRows=safe(units.reduce((n,x)=>n+BigInt(x.oldRows)+BigInt(x.newRows),0n)),indexEntries=safe(units.reduce((n,x)=>n+BigInt(x.indexEntries),0n));
 if(normalizedRows>profile.grouped.maxGroupRows)throw fail('CAPACITY_GROUP_ROW_LIMIT');
 const owners=[...new Set(units.filter(x=>!['@workspace','@quote_workspace'].includes(x.owner)).map(x=>x.owner))].sort();if(owners.length>profile.grouped.maxGroupOwners)throw fail('CAPACITY_GROUP_OWNER_LIMIT');
 const quota=profile.grouped.sqlite;let ownerPageQuotas;
 if(quota){
  if(!Number.isSafeInteger(quota.maxPagesPerMutation)||quota.maxPagesPerMutation<1)throw fail('CAPACITY_SQLITE_MUTATION_QUOTA_REQUIRED');
  const pages=new Map();for(const unit of units){const n=BigInt(unit.oldRows)+BigInt(unit.newRows)+BigInt(unit.indexEntries);pages.set(unit.owner,(pages.get(unit.owner)||0n)+n*BigInt(quota.maxPagesPerMutation));}
  const total=[...pages.values()].reduce((n,x)=>n+x,0n);
  if(total>BigInt(quota.maxGrowthPages)||total>BigInt(quota.maxNetOccupiedPages))throw fail('CAPACITY_SQLITE_PLAN_LIMIT');
  ownerPageQuotas=[...pages].sort(([a],[b])=>a.localeCompare(b)).map(([reservationId,value])=>({reservationId,pages:safe(value)}));
 }
 return{schema:1,units:units.sort((a,b)=>a.key.localeCompare(b.key)),owners,normalizedRows,indexEntries,...(ownerPageQuotas?{ownerPageQuotas}:{})};
}
module.exports={describeWritePlan};
