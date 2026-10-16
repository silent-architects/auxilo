'use strict';
// Exact same path at smoke/scale sizes. Run 10k with
// AUXILO_CAPACITY_RETURN_COUNT=10000 node --test test/provider-returns-capacity.test.js
// Ten-minute load: AUXILO_CAPACITY_DURATION_SECONDS=600 AUXILO_CAPACITY_CONTENDERS=10
// Short load: AUXILO_CAPACITY_DURATION_SECONDS=2 (4 confirmations at2/sec).
// Optional overlap stress: AUXILO_CAPACITY_PROVIDER_DELAY_MS=750.
// Provider responses are synthetic; measured provider intervals are excluded from local timings.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const durationSeconds=Number(process.env.AUXILO_CAPACITY_DURATION_SECONDS||0),rate=durationSeconds?2:0;
const compactOriginalShare=process.env.AUXILO_CAPACITY_ORIGINAL_SHARE_COMPACT==='1';
const quotePartitionFull=process.env.AUXILO_CAPACITY_QUOTE_PARTITION_FULL==='1';
const normalPathDiagnostic=process.env.AUXILO_CAPACITY_NORMAL_PATH_DIAGNOSTIC==='1';
const count=Number(process.env.AUXILO_CAPACITY_RETURN_COUNT||(durationSeconds?durationSeconds*rate:3)),realizedShareCase=compactOriginalShare||process.env.AUXILO_CAPACITY_ORIGINAL_SHARE==='1';
const contenders=Number(process.env.AUXILO_CAPACITY_CONTENDERS||(durationSeconds?10:1)),providerDelayMs=Number(process.env.AUXILO_CAPACITY_PROVIDER_DELAY_MS||0);
const {runWorkload,createMeter,sleep,originalShareAmounts}=require('./helpers/provider-return-workload');
const shareFixture=originalShareAmounts(compactOriginalShare);
const fundingCents=Number(process.env.AUXILO_CAPACITY_SOURCE_CENTS||(realizedShareCase?shareFixture.fundingCents:count>100?10000:100)),fundingUsd=fundingCents/100,fundingMicros=fundingCents*10000;
test('full authorized source, signed events and participant projections complete one-cent returns with replay and correction',{skip:process.platform!=='linux'?'requires actual patched Linux financial runtime':false,timeout:durationSeconds?durationSeconds*1000+90000:count>100?1830000:60000},async t=>{
 assert.ok(Number.isFinite(durationSeconds)&&durationSeconds>=0&&durationSeconds<=600&&(!durationSeconds||durationSeconds>=2&&count===durationSeconds*2),'paced mode requires exact2/sec target');
 assert.ok(!quotePartitionFull||(count===3&&contenders===1&&durationSeconds===0&&!realizedShareCase&&!normalPathDiagnostic&&fundingCents===100),'QUOTE_PARTITION_FULL_DEFAULT_FLOW_ONLY');
 assert.ok(Number.isInteger(contenders)&&contenders>=1&&contenders<=10);assert.ok(Number.isFinite(providerDelayMs)&&providerDelayMs>=0&&providerDelayMs<=5000);
 assert.ok(Number.isInteger(fundingCents)&&fundingCents>=count&&fundingCents<=10000,'synthetic source amount invalid');
 assert.ok(Number.isInteger(count)&&count>=3&&count<=(realizedShareCase?shareFixture.fundingCents*8/10:10000),'return count outside source principal');
 const fixture=require('./helpers/financial-epoch-fixture'),f=fixture.bootAtomic(t),e=require('../lib/financial-epoch'),operator=require('../lib/financial-epoch-operator'),p=require('../lib/stripe-transfer-persistence');
 let {epoch}=f;const {root,writer}=f,oldData=process.env.AUXILO_DATA_DIR;process.env.AUXILO_DATA_DIR=root;t.after(()=>{if(oldData===undefined)delete process.env.AUXILO_DATA_DIR;else process.env.AUXILO_DATA_DIR=oldData;});
 const original=fs.readFileSync(path.join(root,'credits.json')),captureOriginal=fs.readFileSync(path.join(root,'stripe-quarantined-events.json'));
 const sourceId='funding:auxilo_llc:pi_scale',now=Date.now(),stamp={epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,platform_account_id:epoch.platform_account_id,livemode:false,currency:'usd'};
 const contract={...stamp,sourceId,provider:'stripe',complete:true,final:true,approved:true,evidence_ref:'synthetic-scale-contract',valid_from:0,valid_until:Number.MAX_SAFE_INTEGER};
 const capital={id:'txn_capital',source:'synthetic_approved_capital',amount:100000,fee:0,net:100000,evidence_ref:'synthetic-capital-evidence'};
 const liquidity={...stamp,approved:true,obligations_complete:true,inventory_complete:true,evidence_ref:'synthetic-scale-cut',cutoff_ref:'synthetic-provider-complete-history',external_effects:[capital],otherProtectedLiabilityMicros:0,restrictedCashMicros:0,exposureLimitMicros:100000000,valid_from:0,valid_until:Number.MAX_SAFE_INTEGER};
 const financialEvidence={original_cost_contract:{...contract,id:'original_zero',pricing_model:'blended',all_components_in_balance_transaction:true},refund_cost_contract:{...contract,id:'refund_zero',amountMicros:0},liquidity};
 const atomicEvidence=fixture.atomicCapacityEvidence(epoch,{fundingCents,spendFragments:realizedShareCase?1:0,returnCount:count,normalPathDiagnostic,...(quotePartitionFull?{quotePartitionBytes:7*4096}:{})}),capacityProfile=atomicEvidence.capacity_profile;
 Object.assign(financialEvidence,atomicEvidence);
 epoch=operator.transitionEpoch({epoch,writer,expectedRevision:0,patch:{funding:true,buyer_return:true,reconcile:true,spend:realizedShareCase},evidence:{approval_ref:'synthetic-scale-proof',funding:'a'.repeat(64),buyer_return:'b'.repeat(64),reconcile:'c'.repeat(64),spend:'f'.repeat(64)},policyEvidence:{policy_version:epoch.policy_ref,published:true,effective_at:epoch.not_before,disclosure_sha256:'d'.repeat(64),evidence_ref:'e'.repeat(64)},financialEvidence});
 fixture.consent(epoch,'buyer');
 let quoteClockOffset=0;const quoteClock=()=>Date.now()+quoteClockOffset,clockOptions=quotePartitionFull?{clock:quoteClock}:{};
 const money=require('../lib/money-control').initializeMoneyRuntime({epoch,writer,...clockOptions}),store=money.store;
 await fixture.initializeAtomicFixture(t,{epoch,writer,money,profile:capacityProfile});
 const credits=require('../lib/credits'),caps=require('../lib/credit-caps'),sessions=require('../lib/checkout-sessions');
 const os=require('node:os');const meter=createMeter(),timings={},metrics={quote_partition_pressure:quotePartitionFull,quote_partition_refusals:0,quote_partition_expiry_advances:0,platform:process.platform,arch:process.arch,node:process.version,cpu:os.cpus()[0]?.model,cpu_count:os.cpus().length,total_memory:os.totalmem(),available_memory:os.freemem(),samples:count,false_refusals:null,confirmation_attempts:0,failed_confirmation_attempts:0,inventory_continuations:0,retries_by_code:{},requotes:0,original_share_fixture_mode:realizedShareCase?shareFixture.name:'none',original_share_reversal_proven:false,original_share_reversal_reason:realizedShareCase?'Pending real spend/realization correction execution.':'Run AUXILO_CAPACITY_ORIGINAL_SHARE=1 for the separate nonzero fee/spend/reversal case.',count,fundingCents,contenders,providerDelayMs,capacity_reserved_bytes:capacityProfile.reserveBytes,capacity_profile_kind:normalPathDiagnostic?'NORMAL-PATH-DIAGNOSTIC-NOT-ACCEPTED':'synthetic fixture only',normal_path_diagnostic_limit:normalPathDiagnostic?'40 of 100 normal-path slots; correction capacity and full lifecycle unproved':null,provider_posts:0,refund_list_rows:0,inventory_rows:0,inventory_calls:0,refund_gets:0,peak_rss:0,peak_heap:0};
 function readFailureCapacityDiagnostic(){
  let reader;
  try{
   const Driver=require('../server-runtime/node_modules/better-sqlite3');reader=new Driver(store.file,{readonly:true,fileMustExist:true,timeout:1000});reader.pragma('query_only = ON');reader.exec('BEGIN');
   const select=(value,keys)=>Object.fromEntries(keys.filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));
   const capacity=reader.prepare("SELECT id,payload FROM capacity_reservations WHERE id IN ('capacity:root','shared-root',?) OR id LIKE 'shared-hold:%' ORDER BY id LIMIT 33").all(sourceId);
   const rows=capacity.slice(0,32).map(row=>{const v=JSON.parse(row.payload);return row.id==='shared-root'?{id:row.id,ledger:v.ledger}:select(v,['id','state','generation','publicationGeneration','availableBytes','optionalRemainingBytes','sharedRemainingBytes','unassignedBytes','bytes','remainingBytes','consumedBytes','obligationId','sourceId','profileDigest']);});
   const audit=reader.prepare('SELECT revision,payload FROM audit_events ORDER BY revision DESC LIMIT 256').all().reverse().map(row=>{
    const event=JSON.parse(row.payload),groups=(event.capacity||[]).filter(x=>x.protocol==='single_sql_v1'&&x.state==='consumed').map(x=>({id:x.id,bytes:x.bytes,shares:x.shares,sharedShares:x.shares?.filter(y=>y.reservationId.startsWith('shared-hold:'))}));
    const collections={},namespaces={},encodedBytesByKind={};let largest={bytes:0};
    function record(kind,id,value){const encoded=JSON.stringify(value??null),bytes=Buffer.byteLength(encoded);encodedBytesByKind[kind]=(encodedBytesByKind[kind]||0)+bytes;if(bytes>largest.bytes)largest={kind,id,bytes,sha256:crypto.createHash('sha256').update(encoded).digest('hex')};}
    for(const c of event.changes||[]){collections[c.collection]=(collections[c.collection]||0)+1;record('collection:'+c.collection,c.id,c.after);}
    for(const v of event.evidence||[]){namespaces[v.namespace]=(namespaces[v.namespace]||0)+1;record('evidence:'+v.namespace,v.id,v);}
    for(const v of event.capacity||[])record('capacity',v.id,v);
    return{revision:row.revision,auditBytes:Buffer.byteLength(row.payload),groups,changedCollectionCounts:collections,evidenceNamespaceCounts:namespaces,capacityRows:(event.capacity||[]).length,encodedBytesByKind,largestEncodedRecord:largest};
   });
   return{capacityRows:rows,capacityRowsTruncated:capacity.length>32,auditRows:audit,limit:256};
  }catch(error){return{diagnostic_error:{code:error.code,message:error.message,stack:error.stack}};}
  finally{if(reader)try{reader.close();}catch{}}
 }
 const originalControl=money.withMoneyControl,observedControl=meter.wrapMoney(originalControl);money.withMoneyControl=(options,fn)=>observedControl(options,fn).catch(error=>{
  if(quotePartitionFull&&error.code==='WORKSPACE_PARTITION_LIMIT'){metrics.quote_partition_refusals++;throw error;}
  const detail={code:error.code,message:error.message,stack:error.stack,cause_chain:require('node:util').inspect(error,{depth:12,colors:false})};
  if(!metrics.first_local_error){metrics.first_local_error=detail;metrics.first_failure_capacity=readFailureCapacityDiagnostic();process.stderr.write('AUXILO_CAPACITY_FIRST_LOCAL_ERROR '+JSON.stringify(detail)+'\n');process.stderr.write('AUXILO_CAPACITY_FIRST_FAILURE_LEDGER '+JSON.stringify(metrics.first_failure_capacity)+'\n');}
  if(error.cause&&!metrics.first_local_error_with_cause){metrics.first_local_error_with_cause=detail;process.stderr.write('AUXILO_CAPACITY_FIRST_LOCAL_CAUSE '+JSON.stringify(detail)+'\n');}
  metrics.last_local_error=detail;throw error;
 });
 async function stage(name,fn){const start=performance.now();try{return await meter.stage(name,fn);}finally{(timings[name]??=[]).push(performance.now()-start);const memory=process.memoryUsage();metrics.peak_rss=Math.max(metrics.peak_rss,memory.rss);metrics.peak_heap=Math.max(metrics.peak_heap,memory.heapUsed);}}
 const refunds=[],refundMap=new Map(),transactions=[{...capital,object:'balance_transaction',currency:'usd',status:'available',fee_details:[]}];let rebate=0;
 const chargeTx={id:'txn_funding',object:'balance_transaction',source:'ch_scale',currency:'usd',amount:fundingCents,fee:realizedShareCase?shareFixture.feeCents:0,net:fundingCents-(realizedShareCase?shareFixture.feeCents:0),status:'available',fee_details:realizedShareCase?[{type:'stripe_fee',amount:shareFixture.feeCents,currency:'usd'}]:[]};transactions.unshift(chargeTx);
 const charge={object:'charge',id:'ch_scale',payment_intent:'pi_scale',currency:'usd',livemode:false,amount:fundingCents,paid:true,captured:true,status:'succeeded',payment_method_details:{type:'card'},balance_transaction:chargeTx};
 const Stripe=require('stripe'),secret='whsec_synthetic_capacity_scale_12345678901234567890';
 function page(rows,params){const start=params.starting_after?rows.findIndex(x=>x.id===params.starting_after)+1:0;if(params.starting_after&&start===0)throw Error('invalid fake cursor');return {data:structuredClone(rows.slice(start,start+(params.limit||100))),has_more:start+(params.limit||100)<rows.length};}
 const client={webhooks:Stripe.webhooks,accounts:{retrieve:async()=>({id:epoch.platform_account_id})},balance:{retrieve:async()=>({object:'balance',livemode:false,available:[{currency:'usd',amount:transactions.reduce((n,x)=>n+x.net,0)}],pending:[]})},charges:{retrieve:async id=>{assert.equal(id,'ch_scale');return structuredClone(charge);}},paymentIntents:{retrieve:async id=>{assert.equal(id,'pi_scale');return {object:'payment_intent',id,status:'succeeded',currency:'usd',livemode:false,amount_received:fundingCents,latest_charge:structuredClone(charge)};}},refunds:{create:async(payload,options)=>{assert.equal(require('../lib/money-control').getActiveMoneyContext(),null);assert.equal(payload.amount,1);assert.equal(options.maxNetworkRetries,0);metrics.provider_posts++;const id='re_scale_'+metrics.provider_posts,refund={object:'refund',id,charge:'ch_scale',payment_intent:'pi_scale',currency:'usd',amount:1,status:'succeeded',metadata:payload.metadata,balance_transaction:'txn_'+id};refunds.unshift(refund);refundMap.set(id,refund);transactions.unshift({id:refund.balance_transaction,object:'balance_transaction',source:id,currency:'usd',amount:-1,fee:0,net:-1,status:'available',fee_details:[]});return structuredClone(refund);},retrieve:async id=>{metrics.refund_gets++;return structuredClone(refundMap.get(id));},list:async params=>{const result=page(refunds,params);metrics.refund_list_rows+=result.data.length;return result;}},balanceTransactions:{list:async params=>{metrics.inventory_calls++;const result=page(transactions,params);metrics.inventory_rows+=result.data.length;return result;},retrieve:async id=>structuredClone(transactions.find(x=>x.id===id))}};
 for(const family of ['accounts','balance','charges','paymentIntents','refunds','balanceTransactions'])for(const [method,fn]of Object.entries(client[family])){client[family][method]=(...args)=>{assert.equal(require('../lib/money-control').getActiveMoneyContext(),null,'provider IO inside coordinator');return meter.provider(family+'.'+method,()=>fn(...args),{delayMs:family==='refunds'&&method==='create'?providerDelayMs:0});};}
 const registry=require('../lib/stripe-platforms').createPlatformRegistry({env:{STRIPE_AUXILO_LLC_SECRET_KEY:'sk_test_synthetic_capacity_scale_123456789',STRIPE_AUXILO_LLC_WEBHOOK_SECRET:secret},clientFactory:()=>client});
 const intents=require('../lib/stripe-checkout-intents').createCheckoutIntentStore(),origins=require('../lib/stripe-object-origins').createOriginStore(),receipts=require('../lib/stripe-event-receipts').createEventReceiptStore();
 let intentId;
 const admission=require('../lib/stripe-checkout-admission').createCheckoutAdmission({epoch,coordinator:money,intents,getContext:async()=> (await registry.getVerifiedClient(epoch.platform)).context,checkCaps:(id,amount)=>{for(const check of [caps.checkBalanceCap,caps.checkDailyCap])assert.equal(check(id,amount).ok,true);},reserve:sessions.reservePendingSession,promote:sessions.promoteReservation,createSession:async(id,pack,base,options)=>{intentId=options.intentId;return {session_id:'cs_scale',url:'https://checkout.stripe.test/synthetic',expires_at:Math.floor(Date.now()/1000)+3600};}});
 await stage('funding_admission',()=>admission({accountId:'buyer',packId:'scale',amountUsd:fundingUsd,baseUrl:'https://example.invalid'}));
 const purchasesFile=e.pathFor('purchases',epoch),purchases=()=>p.readJSONLStrict(purchasesFile);
 const provider=require('../lib/funds-return').createStripeRefundProvider({epoch,registry,originalCostContract:financialEvidence.original_cost_contract,refundCostContract:financialEvidence.refund_cost_contract,...clockOptions});
 const collect=require('../lib/funds-return').createStripeLiquidityCollector({epoch,registry,store,coordinator:money,readEvidence:()=>e.requireEpoch(e.resolveRuntimeEpoch({root})).control.financial_evidence.liquidity,...clockOptions});
 const service=require('../lib/funds-return').createFundsReturnService({epoch,store,coordinator:money,provider,collectLiquidity:collect,...clockOptions});
 const reconcile=require('../lib/stripe-refund-handlers').createEpochFinancialEventHandler({epoch,store,coordinator:money,provider,returnService:service,applyProjection:projection=>credits.applyMoneyProjectionSync(projection)});
 const dispatcher=require('../lib/stripe-event-dispatch').createStripeEventDispatcher({epoch,coordinator:money,receipts,origins,checkoutIntents:intents,reconcileFinancialEvent:reconcile,packs:{scale:{price_usd:fundingUsd,price_cents:fundingCents}},getAccounts:()=>({buyer:{}}),getPurchases:purchases,isSessionProcessed:id=>purchases().some(x=>x.stripe_session_id===id),addDollarLot:credits.addDollarLot,appendPurchase:row=>p.appendJSONLOnce(purchasesFile,row,{key:'id'}),clearPending:sessions.clearPendingSession});
 async function deliver(event){const rawBody=JSON.stringify(event);assert.ok(Buffer.byteLength(rawBody)<=capacityProfile.maxRawEventBytes,'fixture raw event envelope exceeded');const signature=Stripe.webhooks.generateTestHeaderString({payload:rawBody,secret}),verified=registry.verifyPlatformEvent(epoch.platform,rawBody,signature),rawDigest=crypto.createHash('sha256').update(rawBody).digest('hex');await stage('capture',()=>require('../lib/stripe-history-coverage').captureVerifiedEvent({rawBody,event:verified.event,context:verified.context}));const result=await stage('dispatch_projection',()=>dispatcher.dispatch(verified.event,verified.context,rawDigest));assert.equal(result.status,200,JSON.stringify({result,last_local_error:metrics.last_local_error}));const receipt=receipts.get(epoch.platform,event.id);assert.equal(receipt.state,'completed');await stage('disposition',()=>e.recordEpochEventDisposition({epoch,writer,event:verified.event,context:verified.context,rawDigest,disposition:'applied',effectReceiptId:receipt.receipt_id}));return result;}
 await deliver({id:'evt_funding_scale',type:'checkout.session.completed',api_version:'2025-02-24.acacia',livemode:false,data:{object:{object:'checkout.session',id:'cs_scale',created:Math.floor(Date.now()/1000),mode:'payment',payment_status:'paid',livemode:false,currency:'usd',amount_total:fundingCents,payment_intent:'pi_scale',metadata:{account_id:'buyer',pack_id:'scale',auxilo_checkout_intent_id:intentId}}}});
 assert.equal(store.getSource(sourceId).amountMicros,fundingMicros);store.read=()=>{throw Error('full runtime snapshot forbidden');};
 let realizedPool,spentMicros=0;
 if(realizedShareCase){
  const costs=await provider.collectCosts(store.getSource(sourceId));
  await money.withMoneyControl({accounts:['buyer']},ctx=>{ctx.attachFundingCharge({sourceId,charge_id:costs.source.charge_id,evidence_ref:costs.source.charge_evidence_ref,verified:true});ctx.recordCost(costs.original);ctx.recordCost(costs.incremental);});
  const spent=await stage('actual_spend',()=>credits.deductCredit('buyer','unlock',shareFixture.spendUsd));assert.equal(spent.success,true);
  const spendIds=[...new Set(spent.draws.map(x=>x.spend_id))];assert.equal(spendIds.length,1);const spend=store.getSpend(spendIds[0]);assert.equal(spend.state,'acknowledged');spentMicros=shareFixture.spendMicros;
  const input={id:'scale_realization',spend_id:spend.id,buyerId:'buyer',contributorId:'maker',platformShareMicros:shareFixture.platformShareMicros,contributorShareMicros:shareFixture.contributorShareMicros,draws:spend.draws,epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,verified:true,otherCosts:{complete:true,costIds:[],evidence_ref:'synthetic-scale-exact-no-other-cost'},receipt_digest:p.digestJSON({spendId:spend.id,spendDigest:spend.digest,platformShareMicros:shareFixture.platformShareMicros,contributorShareMicros:shareFixture.contributorShareMicros})};
  realizedPool=await stage('actual_realization',()=>money.withMoneyControl({accounts:['buyer','maker']},ctx=>ctx.recordRealization(input)));
  assert.equal(realizedPool.coveredMicros,shareFixture.coveredMicros);assert.equal(realizedPool.availableMicros,shareFixture.availableMicros);
 }

 const replayCases=new Map(),replayIndices=new Set([0,Math.floor(count/2),count-1]);
 const paginationCodes=new Set(['PROVIDER_INVENTORY_SCAN_INCOMPLETE','PROVIDER_INVENTORY_PENDING_VALIDATION','PROVIDER_INVENTORY_EFFECT_VALIDATION']);
 const contentionCodes=new Set(['PROVIDER_SCAN_GENERATION_CONFLICT','LIQUIDITY_JOURNAL_GENERATION_CHANGED','LIQUIDITY_GENERATION_CONFLICT','PROVIDER_INVENTORY_CUT_CHANGED','RETURN_LIQUIDITY_CUT_CHANGED']);
 let lastProgress=0;
 const workload=await runWorkload({count,workers:contenders,durationMs:durationSeconds*1000,rate,claimTimeoutMs:30000,onProgress:result=>{if(count>100&&result.completed_claims>=lastProgress+1000){lastProgress=result.completed_claims;process.stdout.write(JSON.stringify({phase:'progress',completed:result.completed_claims,confirmed:result.confirmed_total,failed:result.failed_claims,inventory_rows:metrics.inventory_rows,rss:metrics.peak_rss})+'\n');}},job:async({index:i,signal,markConfirmed})=>meter.runClaim(signal,async()=>{
  if(quotePartitionFull&&i>0){quoteClockOffset+=300001;metrics.quote_partition_expiry_advances++;}
  const quote=await stage('quote',()=>service.quote({accountId:'buyer',sourceId,maxGrossMicros:10000}));
  if(quotePartitionFull){
   let refusal;for(let refresh=0;refresh<100;refresh++){const before={revision:store.readMetadata().revision,root:p.digestJSON(store.getCapacityRecord('capacity:root')),operational:p.digestJSON(store.getOperationalControl('quotes'))};try{await service.quote({accountId:'buyer',sourceId,maxGrossMicros:10000});}catch(error){assert.equal(error.code,'WORKSPACE_PARTITION_LIMIT');assert.equal(store.readMetadata().revision,before.revision);assert.equal(p.digestJSON(store.getCapacityRecord('capacity:root')),before.root);assert.equal(p.digestJSON(store.getOperationalControl('quotes')),before.operational);assert.equal(store.atomicCapacityStatus().ready,true);refusal=error;break;}}
   assert.ok(refusal,'expected exact physical quote partition exhaustion before return');assert.equal(store.getQuote(quote.id).hash,quote.hash);
  }
  let request={accountId:'buyer',quoteId:quote.id,quoteHash:quote.hash,clientRequestKey:crypto.randomUUID()},operation;
  for(let retry=0;retry<1000;retry++){
   if(signal.aborted)throw signal.reason;
   metrics.confirmation_attempts++;
   try{operation=await stage('confirm_inventory',()=>service.confirm(request));break;}catch(error){
    metrics.failed_confirmation_attempts++;metrics.retries_by_code[error.code||error.name]=(metrics.retries_by_code[error.code||error.name]||0)+1;
    if(paginationCodes.has(error.code)){metrics.inventory_continuations++;continue;}
    if(error.code==='REQUOTE_REQUIRED'&&!store.findOperationByRequestKey('buyer',request.clientRequestKey)){metrics.requotes++;const next=await stage('quote',()=>service.quote({accountId:'buyer',sourceId,maxGrossMicros:10000}));request={...request,quoteId:next.id,quoteHash:next.hash};await sleep(10,signal);continue;}
    if(contentionCodes.has(error.code)){await sleep(10,signal);continue;}
    throw error;
   }
  }
  assert.ok(operation,'bounded inventory/retry budget did not finish');assert.equal(operation.N,10000);
  const durable=store.getOperation(operation.id);if(!['succeeded_projection_pending','settled'].includes(durable.state)||!durable.refund_id)throw Object.assign(Error('confirmation did not establish canonical successful refund: '+durable.state),{code:'CONFIRMATION_NOT_CANONICALLY_SUCCEEDED'});
  markConfirmed();
  const refund=refundMap.get(operation.refundId),event={id:'evt_return_'+i,type:'refund.updated',api_version:'2025-02-24.acacia',livemode:false,data:{object:structuredClone(refund)}};
  await deliver(event);assert.equal(store.getOperation(operation.id).state,'settled');
  const balance=await stage('typed_balance',()=>service.sourcePage({accountId:'buyer',limit:1}));assert.ok(balance.items[0].availableMicros>=0&&balance.items[0].availableMicros<=fundingMicros-spentMicros);
  if(replayIndices.has(i))replayCases.set(i,{request,event,operationId:operation.id});
 })});
 metrics.workload=workload;metrics.measured_timing=meter.read();
 process.stdout.write('AUXILO_CAPACITY_WORKLOAD '+JSON.stringify({workload,capacity_profile_kind:metrics.capacity_profile_kind,normal_path_diagnostic_limit:metrics.normal_path_diagnostic_limit,first_failure_capacity:metrics.first_failure_capacity,first_local_error:metrics.first_local_error,first_local_error_with_cause:metrics.first_local_error_with_cause,last_local_error:metrics.last_local_error,confirmation_attempts:metrics.confirmation_attempts,failed_confirmation_attempts:metrics.failed_confirmation_attempts,inventory_continuations:metrics.inventory_continuations,retries_by_code:metrics.retries_by_code,requotes:metrics.requotes,measured_timing:metrics.measured_timing})+'\n');
 if(quotePartitionFull){assert.equal(metrics.quote_partition_refusals,count);assert.equal(metrics.quote_partition_expiry_advances,count-1);}
 assert.equal(workload.success,true,'workload failed its actual successful-confirmation target; see emitted metrics');
 assert.equal(store.getSource(sourceId).retiredMicros,count*10000);
 const afterWorkload=await service.sourcePage({accountId:'buyer',limit:1});assert.equal(afterWorkload.items[0].availableMicros,fundingMicros-spentMicros-count*10000);
 for(const entry of replayCases.values()){const sends=metrics.provider_posts;await stage('replay',()=>service.confirm(entry.request));await deliver(entry.event);assert.equal(metrics.provider_posts,sends);assert.equal(store.getOperation(entry.operationId).state,'settled');}
 if(realizedShareCase){
  const reversed=await stage('original_share_reversal',()=>money.withMoneyControl({accounts:['buyer','maker']},ctx=>ctx.reverseRealization({poolId:realizedPool.id,id:'scale_original_share_reversal',amountMicros:shareFixture.reversalMicros,evidence_ref:'synthetic-exact-realization-reversal'})));
  assert.equal(reversed.availableMicros,0);assert.equal(reversed.exposureMicros,shareFixture.reversalExposureMicros);assert.equal(reversed.coveredMicros,shareFixture.coveredMicros);
  assert.equal(store.getSource(sourceId).originalCostSettled,true);metrics.original_share_reversal_proven=true;metrics.original_share_reversal_reason='Actual acknowledged participant spend and bound realization; original covered cost retained after share reversal.';
 }
 // A late canonical failure restores exactly one cent. The platform bears its
 // proven two-cent cost; a later one-cent fee rebate reverses it once.
 const first=replayCases.get(0),operation=store.getOperation(first.operationId),refund=refundMap.get(operation.refund_id),debit=transactions.find(x=>x.id===refund.balance_transaction);
 refund.status='failed';refund.failure_balance_transaction='txn_failure_return';debit.fee=2;debit.net=debit.amount-2;debit.fee_details=[{type:'stripe_fee',amount:2,currency:'usd'}];
 const returned={id:refund.failure_balance_transaction,object:'balance_transaction',source:refund.id,currency:'usd',status:'available',amount:1,fee:0,net:1,fee_details:[]};transactions.unshift(returned);
 await deliver({id:'evt_failure_correction',type:'refund.failed',api_version:'2025-02-24.acacia',livemode:false,data:{object:structuredClone(refund)}});
 assert.equal(store.getOperation(operation.id).failedCostMicros,20000);assert.equal(store.getSource(sourceId).retiredMicros,(count-1)*10000);
 rebate=1;returned.fee=-rebate;returned.net=returned.amount+rebate;returned.fee_details=[{type:'stripe_fee',amount:-rebate,currency:'usd'}];
 const correction={id:'evt_fee_correction',type:'refund.updated',api_version:'2025-02-24.acacia',livemode:false,data:{object:structuredClone(refund)}};await deliver(correction);await deliver(correction);
 assert.equal(store.getOperation(operation.id).failedCostReversedMicros,10000);assert.equal(store.getOperation(operation.id).failedCostExposureMicros,10000);
 assert.equal(metrics.provider_posts,count);assert.deepEqual(fs.readFileSync(path.join(root,'credits.json')),original);assert.deepEqual(fs.readFileSync(path.join(root,'stripe-quarantined-events.json')),captureOriginal);
 const final=await service.sourcePage({accountId:'buyer',limit:1});assert.equal(final.items[0].availableMicros,fundingMicros-spentMicros-(count-1)*10000);
 if(quotePartitionFull){
  const checkpoint=require('../lib/money-checkpoint'),database=require('../lib/money-database'),control=store.getOperationalControl('quotes'),reader=store.validationReader(),quoteRows=[...reader.values(reader.state.quotes)],revision=store.readMetadata().revision;
  assert.ok(control.generation>0);assert.ok(quoteRows.length>0);
  const lifecycleControl={schema_version:1,rule_version:'synthetic-quote-proof-v1',approval_ref:'synthetic-fixture-only',deletion_barrier:{sequence:0,hash:'a'.repeat(64)},seals:[],records:[],holds:[]};
  const cut=await checkpoint.createMoneyCheckpoint({epoch,writer,coordinator:money,sourceSha:e.requireEpoch(epoch).binding.identity.candidate_sha,lifecycleControl}),directory=checkpoint.checkpointDirectory(root,cut.checkpoint_id),manifest=checkpoint.validateCheckpoint(directory);
  assert.equal(manifest.journal_revision,revision);
  checkpoint.withCheckpointContents(directory,manifest,restored=>{const financialDir=path.join(restored,path.relative(root,epoch.financial_dir)),descriptor=JSON.parse(fs.readFileSync(path.join(financialDir,'money-control.json'))),opened=database.openDatabase(path.join(financialDir,'money-control.sqlite'),descriptor,{readonly:true});try{const restoredReader=database.validateDatabaseHandle(opened.db,epoch);assert.equal(descriptor.database_schema,3);assert.deepEqual(database.exportDatabaseAuxiliary(opened.db).operationalSeeds,[control]);const view=database.createValidationReader(opened.db,epoch);assert.deepEqual([...view.values(view.state.quotes)],quoteRows);assert.equal(restoredReader.metadata.revision,revision);}finally{opened.db.close();}});
  metrics.quote_checkpoint={validated:true,revision,operational_generation:control.generation,unaccepted_quotes:quoteRows.length,archive_bytes:manifest.archive.archive_bytes};
 }
 metrics.stages=Object.fromEntries(Object.entries(timings).map(([name,values])=>{values.sort((a,b)=>a-b);return [name,{calls:values.length,total_ms:values.reduce((a,b)=>a+b,0),p50_ms:values[Math.floor(values.length*.5)],p95_ms:values[Math.floor(values.length*.95)],p99_ms:values[Math.floor(values.length*.99)],max_ms:values.at(-1)}];}));
 const Driver=require('../server-runtime/node_modules/better-sqlite3'),reader=new Driver(store.file,{readonly:true,fileMustExist:true});try{const maxima={normalized_row:0,evidence_row:0,audit_batch:0};for(const table of reader.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()){if(!/^[a-z_]+$/.test(table.name)||!reader.prepare('PRAGMA table_info('+table.name+')').all().some(x=>x.name==='payload'))continue;const bytes=Number(reader.prepare('SELECT coalesce(max(length(CAST(payload AS BLOB))),0) n FROM '+table.name).get().n);const key=table.name==='audit_events'?'audit_batch':table.name==='evidence'?'evidence_row':'normalized_row';maxima[key]=Math.max(maxima[key],bytes);}metrics.fixture_encoded_maxima=maxima;assert.ok(maxima.normalized_row<=capacityProfile.maxRowBytes&&maxima.evidence_row<=capacityProfile.maxRowBytes,'fixture encoded row envelope exceeded');assert.ok(maxima.audit_batch<=32768,'fixture audit batch envelope exceeded');}finally{reader.close();}
 metrics.database_bytes=fs.statSync(store.file).size;metrics.journal_revision=store.readMetadata().revision;metrics.finalAvailableMicros=final.items[0].availableMicros;metrics.provider_latency='synthetic intervals separately measured; local timing excludes their union';metrics.measured_timing=meter.read();
 process.stdout.write('AUXILO_CAPACITY_RESULT '+JSON.stringify(metrics)+'\n');store.close();
});

test('workload runner launches ten real waiters and counts only completed claims',async()=>{const {runWorkload,sleep}=require('./helpers/provider-return-workload');const result=await runWorkload({count:4,workers:10,durationMs:80,rate:50,claimTimeoutMs:100,job:async({index,signal,markConfirmed})=>{await sleep(1,signal);if(index===1)throw Object.assign(Error('fixture refusal'),{code:'FIXTURE_REFUSAL'});markConfirmed();}});assert.equal(result.workers_started,10);assert.equal(result.peak_waiting_workers,10);assert.equal(result.offered_claims,4);assert.equal(result.confirmed_total,3);assert.equal(result.failed_claims,1);assert.equal(result.success,false);assert.equal(result.failures_by_code.FIXTURE_REFUSAL,1);});
test('workload runner enforces a bounded claim timeout without inventing confirmation',async()=>{const {runWorkload,sleep}=require('./helpers/provider-return-workload');const result=await runWorkload({count:1,workers:10,durationMs:30,rate:1000/30,claimTimeoutMs:10,job:async({signal,markConfirmed})=>{await sleep(1000,signal);markConfirmed();}});assert.equal(result.confirmed_total,0);assert.equal(result.failed_claims,1);assert.equal(result.timed_out_claims,1);assert.equal(result.undrained_claims,0);assert.equal(result.success,false);assert.ok(result.elapsed_ms<1000);});

test('compact original-share fixture scales exact integers while retaining original hundred-dollar expectations',()=>{
 const {originalShareAmounts}=require('./helpers/provider-return-workload');
 assert.deepEqual(originalShareAmounts(false),{name:'original-100-dollar',fundingCents:10000,feeCents:320,spendUsd:20,spendMicros:20000000,platformShareMicros:6000000,contributorShareMicros:14000000,coveredMicros:3200000,availableMicros:2800000,reversalMicros:3000000,reversalExposureMicros:200000});
 assert.deepEqual(originalShareAmounts(true),{name:'compact-10-dollar',fundingCents:1000,feeCents:32,spendUsd:2,spendMicros:2000000,platformShareMicros:600000,contributorShareMicros:1400000,coveredMicros:320000,availableMicros:280000,reversalMicros:300000,reversalExposureMicros:20000});
});

// Test-only measured normal-path sizing; no lifecycle or production acceptance.
test('normal-path diagnostic profile has exact bounded math and rejects other fixture combinations',t=>{
 const fixture=require('./helpers/financial-epoch-fixture'),{epoch}=fixture.boot(t);
 const baseline=fixture.atomicCapacityEvidence(epoch,{fundingCents:100,returnCount:40}).capacity_profile;
 assert.equal(baseline.slotBytes,270336);assert.equal(baseline.optionalBytes,4194304);assert.equal(baseline.grouped.sharedLiability.fundingCentSlotBytes,131072);
 const {capacity_profile:p,capacity_acceptance:a}=fixture.atomicCapacityEvidence(epoch,{fundingCents:100,spendFragments:0,returnCount:40,normalPathDiagnostic:true});
 assert.equal(p.id,'NORMAL-PATH-DIAGNOSTIC-NOT-ACCEPTED');assert.equal(p.evidence_ref,p.id);assert.equal(a.evidence_ref,p.id);
 assert.equal(p.slotBytes,349*4096);assert.equal(p.grouped.sharedLiability.fundingCentSlotBytes,293*4096);
 assert.equal(p.sourceClosureBytes,1048576);assert.equal(p.grouped.sharedLiability.fundingClosureBytes,1048576);
 assert.equal(p.optionalBytes,100*34*4096+8192);assert.equal(p.grouped.sharedBytes,126304256);assert.equal(p.reserveBytes,284237824);
 const physical=p.reserveBytes+p.publicationBytes+p.workspace.workspaceRetainedBytes+p.workspace.workspaceScratchBytes+8192+131072;
 assert.equal(physical,359940096);assert.equal(physical+4096*p.grouped.sqlite.maxDatabasePages,376717312);assert.ok(physical+4096*p.grouped.sqlite.maxDatabasePages<600*1048576);
 for(const invalid of [{fundingCents:99},{fundingCents:101},{spendFragments:1},{returnCount:39},{returnCount:41},{normalPathDiagnostic:'true'}])assert.throws(()=>fixture.atomicCapacityEvidence(epoch,{fundingCents:100,spendFragments:0,returnCount:40,normalPathDiagnostic:true,...invalid}),/NORMAL_PATH_DIAGNOSTIC_FIXTURE_ONLY/);
});

test('quote partition pressure profile is explicit and preserves financial capacity and default partitions',t=>{
 const fixture=require('./helpers/financial-epoch-fixture'),{epoch}=fixture.boot(t),args={fundingCents:100,returnCount:3};
 const baseline=fixture.atomicCapacityEvidence(epoch,args).capacity_profile,p=fixture.atomicCapacityEvidence(epoch,{...args,quotePartitionBytes:7*4096}).capacity_profile;
 assert.equal(baseline.workspace.quoteRetainedBytes,2*1048576);assert.equal(p.workspace.quoteRetainedBytes,7*4096);assert.equal(p.workspace.workspaceRetainedBytes,5*1048576+7*4096);
 for(const key of ['reserveBytes','slotBytes','sourceClosureBytes','spendBytes','optionalBytes','grouped'])assert.deepEqual(p[key],baseline[key]);
 for(const value of [0,-4096,1,28673,'28672'])assert.throws(()=>fixture.atomicCapacityEvidence(epoch,{...args,quotePartitionBytes:value}),/QUOTE_PARTITION_FIXTURE_INVALID/);
});
