'use strict';
// Stripe documents cursor order and has_more, not a historical snapshot or an
// immutability guarantee. A prior overlap therefore never completes this scan.
const {digestJSON}=require('./stripe-transfer-persistence');
const API_VERSION='2025-02-24.acacia';
function assertRecoveryScope(coordinator,recoveryAnchor,{sourceId,operationId,captureId}={}){
 if(!recoveryAnchor)return;
 if(!coordinator.failureControl||!coordinator.recoveryAnchors)throw fail('RECOVERY_ANCHOR_REQUIRED');
 coordinator.failureControl.assertRecoveryAllowed(recoveryAnchor,{action:'provider_reconcile'});
 const descriptor=coordinator.recoveryAnchors.revalidate(recoveryAnchor);
 const matched=descriptor.kind==='dispatch_operation'&&operationId&&descriptor.id===operationId&&(!sourceId||descriptor.sourceDigest===digestJSON(sourceId))||descriptor.kind==='pending_source_observation'&&sourceId&&descriptor.id===sourceId||descriptor.kind==='verified_capture'&&captureId&&descriptor.id===captureId;
 if(!matched)throw fail('RECOVERY_ANCHOR_SCOPE_MISMATCH');
}

// Financial transactions protect individual commits. This separate queue owns
// each complete provider scan turn across awaits, shared by all factory instances.
const scanTurns=new WeakMap();
function inScanTurn(store,scopeKey,run){
 let scopes=scanTurns.get(store);if(!scopes){scopes=new Map();scanTurns.set(store,scopes);}
 const result=(scopes.get(scopeKey)||Promise.resolve()).then(run);
 const settled=result.then(()=>undefined,()=>undefined);scopes.set(scopeKey,settled);
 settled.then(()=>{if(scopes.get(scopeKey)===settled){scopes.delete(scopeKey);if(!scopes.size)scanTurns.delete(store);}});
 return result;
}
const captureOwner=value=>value&&Object.freeze({...value});
function fail(code){const e=Error(code);e.code=code;return e;}
function canonicalEffect(tx){
 if(tx?.object!=='balance_transaction'||!/^txn_\w+$/.test(tx.id||'')||typeof tx.currency!=='string'||!Number.isSafeInteger(tx.amount)||!Number.isSafeInteger(tx.fee)||!Number.isSafeInteger(tx.net)||tx.net!==tx.amount-tx.fee||!['pending','available'].includes(tx.status))throw fail('PROVIDER_INVENTORY_EVIDENCE_INVALID');
 const source=typeof tx.source==='string'?tx.source:tx.source?.id||null;
 return {id:tx.id,source,currency:tx.currency,amount:tx.amount,fee:tx.fee,net:tx.net,status:tx.status};
}
function requiresWorkspaceDemand(store,coordinator){return coordinator.workspaceRequired===true&&store.getCapacityRecord?.('capacity:root')?.profile?.grouped?.commitProtocol==='single_sql_v1';}
function assertWorkspaceDemand({store,epoch,capacity,demand,clock}){
 if(capacity?.mandatory!==true||!demand||typeof demand!=='object')throw fail('SOURCE_SCAN_DEMAND_REQUIRED');
 const source=store.getSource?.(capacity.sourceId||demand.sourceId);if(!source||source.id!==demand.sourceId||source.accountId!==demand.accountId||source.epoch_id!==epoch.epoch_id||source.binding_digest!==epoch.binding_digest||source.platform_account_id!==epoch.platform_account_id||source.livemode!==epoch.livemode)throw fail('SOURCE_SCAN_DEMAND_REQUIRED');
 if(demand.quoteId){const quote=store.getQuote?.(demand.quoteId);if(!quote||quote.id!==demand.quoteId||quote.sourceId!==source.id||quote.accountId!==source.accountId||quote.hash!==demand.quoteHash||!Number.isFinite(quote.expiresAt)||quote.expiresAt<=clock()||typeof demand.clientRequestKey!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(demand.clientRequestKey))throw fail('SOURCE_SCAN_DEMAND_REQUIRED');return;}
 if(demand.operationId){const op=store.getOperation?.(demand.operationId);if(!op||op.id!==capacity.operationId||op.sourceId!==source.id||op.accountId!==source.accountId||['settled','failed','canceled','requote_required'].includes(op.state))throw fail('SOURCE_SCAN_DEMAND_REQUIRED');return;}
 if(demand.sourceObservationDigest){const observation=source.providerObservation;if(!observation||digestJSON(observation)!==demand.sourceObservationDigest||observation.canonical!==true||observation.verified!==true||!(observation.complete===false||observation.reason==='external_refund_pending'))throw fail('SOURCE_SCAN_DEMAND_REQUIRED');return;}
 if(demand.captureId){const row=store.getEvidence('verified_capture',demand.captureId)?.payload;if(!row||row.conflict||row.epoch_id!==epoch.epoch_id||row.binding_digest!==epoch.binding_digest||row.stripe_platform_account_id!==epoch.platform_account_id||row.livemode!==epoch.livemode||row.event_id!==demand.eventId||row.raw_digest!==demand.rawDigest||typeof row.raw_body!=='string'||require('node:crypto').createHash('sha256').update(row.raw_body).digest('hex')!==row.raw_digest)throw fail('SOURCE_SCAN_DEMAND_REQUIRED');let event;try{event=JSON.parse(row.raw_body);}catch{throw fail('SOURCE_SCAN_DEMAND_REQUIRED');}const object=event.data?.object,id=v=>typeof v==='string'?v:v?.id;if(event.id!==row.event_id||event.livemode!==epoch.livemode||event.account||!['charge.refunded','refund.created','refund.updated','refund.failed'].includes(event.type)||(object?.object==='charge'?object.id:id(object?.charge))!==source.charge_id||id(object?.payment_intent)!==source.payment_intent_id)throw fail('SOURCE_SCAN_DEMAND_REQUIRED');return;}
 throw fail('SOURCE_SCAN_DEMAND_REQUIRED');
}
function acquireDemandLease(ctx,{store,coordinator,epoch,clock,scopeKey,generation,capacity,demand}){
 if(!requiresWorkspaceDemand(store,coordinator))return;
 assertWorkspaceDemand({store,epoch,capacity,demand,clock});
 const status=store.workspaceStatus?.();if(!status?.available)throw fail(status?.reason||'WORKSPACE_MANAGER_REQUIRED');
 const old=Object.values(status.leases||{}).find(x=>x.scopeKey===scopeKey);if(old&&old.generation!==generation)ctx.releaseWorkspaceLease({scopeKey,generation:old.generation});
 ctx.acquireWorkspaceLease({scopeKey,generation,capacity});
}
function createProviderInventory({registry,epoch,store,coordinator,verifyEffect,clock=Date.now,maxPagesPerBatch=5,pageSize=100}){
 if(!registry||!epoch||!store?.getProviderScan||!store.listProviderScanMembers||!store.listOutstandingCashEffects||!coordinator?.withMoneyControl||typeof verifyEffect!=='function'||!Number.isInteger(maxPagesPerBatch)||maxPagesPerBatch<1||maxPagesPerBatch>20||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw fail('PROVIDER_INVENTORY_UNAVAILABLE');
 const scopeKey='stripe:'+epoch.platform_account_id+':'+(epoch.livemode?'live':'test');
 const stamp={epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode};
 const controlId=scopeKey+':control';
 const factId=effect=>scopeKey+':fact:'+effect.id+':'+digestJSON(effect);
 function hasAvailableEffect(ref,id){if(ref?.scopeKey!==scopeKey||!Number.isSafeInteger(ref.generation))return false;const row=store.getEvidence('provider_effects',scopeKey+':'+ref.generation+':'+id),seal=store.getEvidence('provider_effects',scopeKey+':'+ref.generation+':seal');return seal?.payload.complete===true&&row?.payload?.canonical===true&&row.payload.verified===true&&row.payload.complete===true&&row.payload.status==='available'&&row.payload.platform_account_id===epoch.platform_account_id&&row.payload.livemode===epoch.livemode&&row.payload.epoch_id===epoch.epoch_id&&row.payload.binding_digest===epoch.binding_digest&&row.payload.generation===ref.generation&&row.payload.currency==='usd'&&store.getProviderCurrentFact(scopeKey,id)?.factId===row.payload.factId;}
 async function scan({capacity,demand,recoveryAnchor}={}){
  const local=fn=>coordinator.withMoneyControl({kind:'provider_inventory',accounts:[],epochRevision:epoch.activation_revision,...(recoveryAnchor?{recoveryAnchor,action:'provider_reconcile'}:{})},fn);
  assertRecoveryScope(coordinator,recoveryAnchor,{sourceId:demand?.sourceId||capacity?.sourceId,operationId:demand?.operationId||capacity?.operationId,captureId:demand?.captureId});
  const activeCapacity=capacity&&Object.freeze({...capacity});
  if(requiresWorkspaceDemand(store,coordinator)){const existing=store.getProviderScan(scopeKey),prior=store.getEvidence('provider_inventory',controlId);await local(ctx=>acquireDemandLease(ctx,{store,coordinator,epoch,clock,scopeKey,generation:existing?.generation||(prior?.payload.generation||0)+1,capacity:activeCapacity,demand}));}
 function record(ctx,id,payload,indexes={}){return ctx.recordEvidence({namespace:'provider_effects',id,payload:{...stamp,...payload},indexes:{platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,...indexes},capacity:activeCapacity?{...activeCapacity,rawBytes:Buffer.byteLength(JSON.stringify(payload))}:undefined});}
  const {client,context}=await registry.getVerifiedClient('auxilo_llc');
  const check=()=>{if(context.stripe_platform!==epoch.platform||context.stripe_platform_account_id!==epoch.platform_account_id||context.livemode!==epoch.livemode||registry.assertVerifiedContext(context)!==client)throw fail('RETURN_PROVIDER_UNAVAILABLE');};
  async function read(fn){check();const value=await fn();check();return value;}
  check();let workspace=store.getProviderScan(scopeKey);
  if(!workspace){
   const previous=store.getEvidence('provider_inventory',controlId),balance=await read(()=>client.balance.retrieve({}, {apiVersion:API_VERSION}));
   if(balance?.object!=='balance'||balance.livemode!==epoch.livemode||!Array.isArray(balance.available)||!Array.isArray(balance.pending))throw fail('PROVIDER_INVENTORY_BALANCE_INVALID');
   const head=await read(()=>client.balanceTransactions.list({limit:1},{apiVersion:API_VERSION}));if(!Array.isArray(head?.data))throw fail('PROVIDER_INVENTORY_EVIDENCE_INVALID');
   const control={state:'scanning',generation:(previous?.payload.generation||0)+1,headId:head.data[0]?.id||null,balance,balanceDigest:digestJSON(balance),cursor:null,pageNo:0,transactionCount:0,chain:digestJSON(stamp),pendingCursor:null,proofCursor:null,startedAt:clock()};
   await local(ctx=>ctx.advanceProviderScan({capacity:activeCapacity,scopeKey,generation:control.generation,expectedRevision:0,control,rows:[]}));workspace=store.getProviderScan(scopeKey);
  }
  const generation=workspace.generation;
  const advance=async(control,rows=[],resolvedRows=[])=>{await local(ctx=>{for(const effect of [...rows,...resolvedRows])record(ctx,factId(effect),{...effect,canonical:true,verified:true,complete:true},{providerId:effect.id,state:'fact'});ctx.advanceProviderScan({capacity:activeCapacity,scopeKey,generation,expectedRevision:workspace.revision,control,rows:rows.map(effect=>({providerId:effect.id,factId:factId(effect),state:effect.status})),resolvedRows:resolvedRows.map(effect=>({providerId:effect.id,factId:factId(effect),state:effect.status==='pending'?'validated':'available'}))});});workspace=store.getProviderScan(scopeKey);};
  for(let n=0;n<maxPagesPerBatch&&workspace.control.state==='scanning';n++){
   const before=workspace.control,page=await read(()=>client.balanceTransactions.list({limit:pageSize,...(before.cursor?{starting_after:before.cursor}:{})},{apiVersion:API_VERSION}));
   if(!Array.isArray(page?.data)||page.data.length>pageSize||typeof page.has_more!=='boolean'||page.has_more&&!page.data.length)throw fail('PROVIDER_INVENTORY_EVIDENCE_INVALID');
   const effects=page.data.map(canonicalEffect),seen=new Set();for(const effect of effects){if(seen.has(effect.id)||store.getProviderScanMember(scopeKey,generation,effect.id))throw fail('PROVIDER_INVENTORY_CURSOR_CONFLICT');seen.add(effect.id);if(await verifyEffect(effect)!==true)throw fail('PROVIDER_EFFECT_UNRESOLVED');}
   await advance({...before,state:page.has_more?'scanning':'pending_validation',cursor:effects.at(-1)?.id||before.cursor,pageNo:before.pageNo+1,transactionCount:before.transactionCount+effects.length,chain:digestJSON([before.chain,digestJSON(effects)])},effects);
  }
  if(workspace.control.state==='scanning')return {complete:false,reason:'PROVIDER_INVENTORY_SCAN_INCOMPLETE',generation,transactionCount:workspace.control.transactionCount};
  if(workspace.control.state==='pending_validation'){
   const pending=store.listProviderScanMembers({scopeKey,generation,state:'pending',after:workspace.control.pendingCursor||undefined,limit:pageSize}),verified=[];
   for(const row of pending.items){const effect=canonicalEffect(await read(()=>client.balanceTransactions.retrieve(row.providerId,{}, {apiVersion:API_VERSION})));if(effect.id!==row.providerId||await verifyEffect(effect)!==true)throw fail('PROVIDER_EFFECT_UNRESOLVED');verified.push(effect);}
   await advance({...workspace.control,pendingCursor:pending.nextCursor,chain:digestJSON([workspace.control.chain,verified]),state:pending.nextCursor?'pending_validation':'proof_validation'},[],verified);
   if(pending.nextCursor)return {complete:false,reason:'PROVIDER_INVENTORY_PENDING_VALIDATION',generation,transactionCount:workspace.control.transactionCount};
  }
  if(workspace.control.state==='proof_validation'){
   const page=store.listOutstandingCashEffects({after:workspace.control.proofCursor||undefined,limit:100});
   await local(ctx=>{for(const operation of page.items){if(operation.platform_account_id!==epoch.platform_account_id||operation.livemode!==epoch.livemode||operation.currency!=='usd')throw fail('PROVIDER_EFFECT_UNRESOLVED');for(const id of operation.effectIds){const member=store.getProviderScanMember(scopeKey,generation,id),fact=member&&store.getEvidence('provider_effects',member.factId)?.payload;if(fact?.status!=='available')continue;record(ctx,scopeKey+':'+generation+':'+id,{...fact,generation,factId:member.factId,operationId:operation.operationId,obligationVersion:operation.obligationVersion},{providerId:id,state:'available'});}}ctx.advanceProviderScan({capacity:activeCapacity,scopeKey,generation,expectedRevision:workspace.revision,control:{...workspace.control,proofCursor:page.nextCursor,state:page.nextCursor?'proof_validation':'cut_validation'},rows:[]});});workspace=store.getProviderScan(scopeKey);
   if(page.nextCursor)return {complete:false,reason:'PROVIDER_INVENTORY_EFFECT_VALIDATION',generation,transactionCount:workspace.control.transactionCount};
  }
  const head=await read(()=>client.balanceTransactions.list({limit:1},{apiVersion:API_VERSION})),balance=await read(()=>client.balance.retrieve({}, {apiVersion:API_VERSION})),control=workspace.control;
  if(!Array.isArray(head?.data))throw fail('PROVIDER_INVENTORY_EVIDENCE_INVALID');
  if((head.data[0]?.id||null)!==control.headId||digestJSON(balance)!==control.balanceDigest){const reason='PROVIDER_INVENTORY_CUT_CHANGED';await local(ctx=>ctx.sealProviderScan({capacity:activeCapacity,scopeKey,generation,expectedRevision:workspace.revision,control:{...control,state:'invalidated',reason},seal:{complete:false,reason,startCutDigest:digestJSON({head:control.headId,balance:control.balanceDigest}),endCutDigest:digestJSON({head:head.data[0]?.id||null,balance:digestJSON(balance)})}}));if(requiresWorkspaceDemand(store,coordinator))await local(ctx=>ctx.releaseWorkspaceLease({scopeKey,generation}));return {complete:false,reason,generation};}
  const completedAt=clock();await local(ctx=>ctx.sealProviderScan({capacity:activeCapacity,scopeKey,generation,expectedRevision:workspace.revision,control:{...control,state:'complete',completedAt},seal:{complete:true,balanceDigest:control.balanceDigest,evidenceDigest:control.chain,headId:control.headId,transactionCount:control.transactionCount,completedAt}}));
  
  if(requiresWorkspaceDemand(store,coordinator))await local(ctx=>ctx.releaseWorkspaceLease({scopeKey,generation}));
  const provider_inventory_ref={scopeKey,generation};let after;do{const page=store.listOutstandingCashEffects({after,limit:100}),effects=page.items.filter(o=>o.effectIds.length&&o.effectIds.every(id=>{const p=store.getEvidence('provider_effects',scopeKey+':'+generation+':'+id)?.payload;return p?.operationId===o.operationId&&p.obligationVersion===o.obligationVersion&&hasAvailableEffect(provider_inventory_ref,id);})).map(o=>({operationId:o.operationId,obligationVersion:o.obligationVersion}));if(effects.length)await local(ctx=>ctx.acknowledgeReflectedEffects({inventory_ref:provider_inventory_ref,balanceCutDigest:control.balanceDigest,effects}));after=page.nextCursor;}while(after);
  return {complete:true,provider_inventory_ref,generation,headId:control.headId,transactionCount:control.transactionCount,evidenceDigest:control.chain,balance:control.balance,observed_at:completedAt,journal_revision:store.readLiquidityBasis().revision};
 }
 return {scan:({capacity,demand,recoveryAnchor}={})=>{const input={capacity:captureOwner(capacity),demand:captureOwner(demand),recoveryAnchor};return inScanTurn(store,scopeKey,()=>scan(input));},hasAvailableEffect,scopeKey};
}
// Refund discovery has independent immutable generations. The control row and
// caller cursor stay bounded even when a charge has many thousands of refunds.
function createRefundInventory({store,coordinator,epoch,client,context,registry,source,operation,demand:requestedDemand,recoveryAnchor,validateRefund,clock=Date.now,maxPagesPerBatch=5}){
 source=captureOwner(source);operation=captureOwner(operation);requestedDemand=captureOwner(requestedDemand);
 // One retained current membership per charge; operation-specific uniqueness is
 // bound to each sealed scan, never copied into a permanent membership set.
 const scopeKey='stripe_refunds:'+epoch.platform_account_id+':'+epoch.livemode+':'+source.id;
 const controlId=scopeKey+':control',stamp={epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode};
 const demand=requestedDemand||(operation?{operationId:operation.id,sourceId:source.id,accountId:source.accountId}:undefined);
 const capacity={purpose:'refund_inventory',mandatory:true,...(operation?{operationId:operation.id}:{sourceId:source.id})};
 const get=()=>store.getProviderScan(scopeKey),committed=()=>store.getEvidence('provider_inventory',controlId),local=fn=>coordinator.withMoneyControl({kind:'refund_inventory',accounts:[source.accountId],epochRevision:epoch.activation_revision,...(recoveryAnchor?{recoveryAnchor,action:'provider_reconcile'}:{})},fn);
 async function read(fn){if(registry.assertVerifiedContext(context)!==client)throw fail('RETURN_PROVIDER_UNAVAILABLE');const value=await fn();if(registry.assertVerifiedContext(context)!==client)throw fail('RETURN_PROVIDER_UNAVAILABLE');return value;}
 const factId=refund=>'stripe_refund_fact:'+epoch.platform_account_id+':'+epoch.livemode+':'+refund.id+':'+digestJSON(refund);
 function record(ctx,refund){return ctx.recordEvidence({namespace:'provider_effects',id:factId(refund),payload:{...stamp,refund,canonical:true,verified:true,complete:true},indexes:{accountId:source.accountId,providerId:refund.id,state:'refund_fact',platform_account_id:epoch.platform_account_id,livemode:epoch.livemode},capacity:{...capacity,rawBytes:Buffer.byteLength(JSON.stringify(refund))}});}
 async function head(){const page=await read(()=>client.refunds.list({charge:source.charge_id,limit:1},{apiVersion:API_VERSION}));if(!Array.isArray(page?.data)||typeof page.has_more!=='boolean')throw fail('RETURN_PROVIDER_EVIDENCE_INCOMPLETE');return page.data[0]?.id||null;}
 function identity(body){if(body.source_id!==source.id||body.charge_id!==source.charge_id||body.operation_id!==(operation?.id||null)||body.request_digest!==(operation?.provider_request_digest||operation?.request_digest||null))throw fail('RETURN_SCAN_IDENTITY_BUSY');}
 async function scan({cursor}={}){
  assertRecoveryScope(coordinator,recoveryAnchor,{sourceId:source.id,operationId:operation?.id||demand?.operationId,captureId:demand?.captureId});
  let workspace=get(),prior=committed();
  if(requiresWorkspaceDemand(store,coordinator))await local(ctx=>{assertWorkspaceDemand({store,epoch,capacity,demand,clock});if(cursor?.phase!=='consume')acquireDemandLease(ctx,{store,coordinator,epoch,clock,scopeKey,generation:workspace?.generation||(prior?.payload.generation||0)+1,capacity,demand});});
  if(cursor?.inventory_ref&&(cursor.inventory_ref.scopeKey!==scopeKey||cursor.inventory_ref.generation!==(workspace?.generation||prior?.payload.generation))){const ref=cursor.inventory_ref,oldSeal=ref.scopeKey===scopeKey&&store.getEvidence('provider_effects',scopeKey+':'+ref.generation+':seal')?.payload;if(Number.isSafeInteger(ref.generation)&&ref.generation<(workspace?.generation||prior?.payload.generation)&&oldSeal?.complete===true&&oldSeal.operation_id===(operation?.id||null))return{complete:false,cursor:null,inventory_ref:ref,reason:'RETURN_SCAN_SUPERSEDED'};throw fail('RETURN_SCAN_GENERATION_CONFLICT');}
  if(cursor?.phase==='consume'){if(workspace||prior?.payload.state!=='complete')throw fail('RETURN_SCAN_GENERATION_CONFLICT');identity(prior.payload);return consume(prior.payload,cursor.after);}
  if(!workspace){const first=await head(),control={state:'scanning',generation:(prior?.payload.generation||0)+1,source_id:source.id,charge_id:source.charge_id,operation_id:operation?.id||null,request_digest:operation?.provider_request_digest||operation?.request_digest||null,headId:first,starting_after:null,count:0,matchCount:0,matchId:null,conflictCount:0,amountConflictCount:0,amountConflictId:null,chain:digestJSON(stamp),startedAt:clock()};await local(ctx=>ctx.advanceProviderScan({capacity,scopeKey,generation:control.generation,expectedRevision:0,control,rows:[]}));workspace=get();}
  identity(workspace.control);const generation=workspace.generation;
  for(let pageNo=0;pageNo<maxPagesPerBatch&&workspace.control.state==='scanning';pageNo++){
   const before=workspace.control,page=await read(()=>client.refunds.list({charge:source.charge_id,limit:100,...(before.starting_after?{starting_after:before.starting_after}:{})},{apiVersion:API_VERSION}));
   if(!Array.isArray(page?.data)||page.data.length>100||typeof page.has_more!=='boolean'||page.has_more&&!page.data.length)throw fail('RETURN_PROVIDER_EVIDENCE_INCOMPLETE');
   const rows=[],seen=new Set(),next={...before};for(const raw of page.data){const row=validateRefund(raw);if(seen.has(row.refund.id)||store.getProviderScanMember(scopeKey,generation,row.refund.id))throw fail('RETURN_PROVIDER_EVIDENCE_INCOMPLETE');seen.add(row.refund.id);rows.push(row);next.count++;if(row.classification==='match'){next.matchCount++;next.matchId??=row.refund.id;}if(row.classification==='conflict'){next.conflictCount++;if(row.amountConflict){next.amountConflictCount++;next.amountConflictId??=row.refund.id;}}}
   next.chain=digestJSON([before.chain,rows]);next.starting_after=rows.at(-1)?.refund.id||before.starting_after;next.state=page.has_more?'scanning':'cut_validation';
   await local(ctx=>{for(const row of rows)record(ctx,row.refund);ctx.advanceProviderScan({capacity,scopeKey,generation,expectedRevision:workspace.revision,control:next,rows:rows.map(row=>({providerId:row.refund.id,factId:factId(row.refund),state:'available'}))});});workspace=get();
  }
  const inventory_ref={scopeKey,generation};if(workspace.control.state==='scanning')return {complete:false,cursor:{phase:'scan',inventory_ref},inventory_ref,reason:'RETURN_SCAN_INCOMPLETE'};
  const currentHead=await head(),body=workspace.control,balanceDigest=digestJSON({headId:body.headId,source_id:source.id,charge_id:source.charge_id});
  if(currentHead!==body.headId){const reason='RETURN_SCAN_CUT_CHANGED';await local(ctx=>ctx.sealProviderScan({capacity,scopeKey,generation,expectedRevision:workspace.revision,control:{...body,state:'invalidated',reason},seal:{complete:false,reason,startCutDigest:balanceDigest,endCutDigest:digestJSON({headId:currentHead,source_id:source.id,charge_id:source.charge_id})}}));if(requiresWorkspaceDemand(store,coordinator))await local(ctx=>ctx.releaseWorkspaceLease({scopeKey,generation}));return{complete:false,cursor:{phase:'scan',inventory_ref},inventory_ref,reason};}
  await local(ctx=>ctx.sealProviderScan({capacity,scopeKey,generation,expectedRevision:workspace.revision,control:{...body,state:'complete',balanceDigest,completedAt:clock()},seal:{complete:true,balanceDigest,evidenceDigest:body.chain,source_id:source.id,charge_id:source.charge_id,operation_id:operation?.id||null,count:body.count,matchCount:body.matchCount,conflictCount:body.conflictCount}}));
  
  if(requiresWorkspaceDemand(store,coordinator))await local(ctx=>ctx.releaseWorkspaceLease({scopeKey,generation}));
  if(!operation)return consume(committed().payload);
  const matched=body.matchCount===1?store.getEvidence('provider_effects',store.getProviderCurrentFact(scopeKey,body.matchId)?.factId)?.payload.refund:null;
  return{complete:true,cursor:null,inventory_ref,matchCount:body.matchCount,matched,conflictCount:body.conflictCount,amountConflictCount:body.amountConflictCount,amountConflictId:body.amountConflictId,scanDigest:body.chain};
 }
 async function consume(control,after){const inventory_ref={scopeKey,generation:control.generation},page=store.listProviderCurrentFacts({scopeKey,after,limit:100}),refunds=[];for(const row of page.items){const current=await read(()=>client.refunds.retrieve(row.providerId,{}, {apiVersion:API_VERSION})),checked=validateRefund(current);if(checked.refund.id!==row.providerId)throw fail('RETURN_IDENTITY_CONFLICT');refunds.push(checked.refund);}return{complete:!page.nextCursor,inventory_complete:true,inventory_ref,refunds,cursor:page.nextCursor?{phase:'consume',inventory_ref,after:page.nextCursor}:null,digest:control.chain};}
 return{scan:({cursor}={})=>{const input={cursor:cursor&&structuredClone(cursor)};return inScanTurn(store,scopeKey,()=>scan(input));},scopeKey};
}

module.exports={createProviderInventory,createRefundInventory,canonicalEffect};
