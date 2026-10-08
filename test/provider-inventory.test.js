'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createProviderInventory}=require('../lib/provider-inventory');
function fixture(count=2201){
 const epoch={epoch_id:'e',binding_digest:'b'.repeat(64),platform:'auxilo_llc',platform_account_id:'acct_llc',livemode:false};
 const rows=Array.from({length:count},(_,i)=>({id:'txn_'+(count-i),object:'balance_transaction',source:'ch_'+i,currency:'usd',amount:100,fee:0,net:100,status:'available'}));
 const records=new Map();let revision=0,locked=false,listCalls=0;const context={stripe_platform:'auxilo_llc',stripe_platform_account_id:'acct_llc',livemode:false};
 const store={read(){throw Error('full history read forbidden');},readLiquidityBasis:()=>({revision,localLiabilityMicros:0,latestLiquidityRevision:0}),getEvidence:(ns,id)=>structuredClone(records.get(ns+':'+id)||null),listEvidence:({namespace,prefix='',state,after,limit=100})=>{const found=[...records.values()].filter(r=>r.namespace===namespace&&r.id.startsWith(prefix)&&(!state||r.indexes.state===state)).sort((a,b)=>a.id.localeCompare(b.id));const start=after?found.findIndex(r=>r.id===after)+1:0,items=found.slice(start,start+limit);return {items:structuredClone(items),nextCursor:start+items.length<found.length?items.at(-1).id:null};}};
 const coordinator={withMoneyControl:async(_opts,fn)=>{assert.equal(locked,false);locked=true;try{return await fn({recordEvidence:({namespace,id,payload,indexes={},expectedRevision})=>{const key=namespace+':'+id,old=records.get(key);if(old&&JSON.stringify(old.payload)===JSON.stringify(payload))return structuredClone(old);if(old&&old.revision!==expectedRevision)throw Error('EVIDENCE_REVISION_CONFLICT');const value={namespace,id,payload:structuredClone(payload),indexes,revision:(old?.revision||0)+1};records.set(key,value);revision++;return structuredClone(value);}});}finally{locked=false;}}};
 const scans=new Map(),members=new Map(),current=new Map();let acknowledged=false;
 const memberKey=(scope,generation,id)=>scope+':'+generation+':'+id;
 store.getProviderScan=scope=>structuredClone(scans.get(scope));store.getProviderScanMember=(scope,generation,id)=>structuredClone(members.get(memberKey(scope,generation,id)));
 store.getProviderCurrentFact=(scope,id)=>structuredClone(current.get(scope+':'+id));
 store.listProviderCurrentFacts=({scopeKey,after,limit=100})=>{const found=[...current.entries()].filter(([k])=>k.startsWith(scopeKey+':')).map(([k,v])=>({providerId:k.slice(scopeKey.length+1),...v})).filter(x=>!after||x.providerId>after).sort((a,b)=>a.providerId.localeCompare(b.providerId));return{items:found.slice(0,limit),nextCursor:found.length>limit?found[limit-1].providerId:null};};
 store.listOutstandingCashEffects=()=>({items:count&&!acknowledged?[{operationId:'operation',sourceId:'source',accountId:'buyer',platform_account_id:epoch.platform_account_id,livemode:false,currency:'usd',effectIds:['txn_1'],obligationVersion:'version'}]:[],nextCursor:null});
 store.listProviderScanMembers=({scopeKey,generation,state,after,limit})=>{const found=[...members.values()].filter(x=>x.scopeKey===scopeKey&&x.generation===generation&&(!state||x.state===state)&&(!after||x.providerId>after)).sort((a,b)=>a.providerId.localeCompare(b.providerId));return{items:structuredClone(found.slice(0,limit)),nextCursor:found.length>limit?found[limit-1].providerId:null};};
 const originalLocal=coordinator.withMoneyControl;coordinator.withMoneyControl=(opts,fn)=>originalLocal(opts,ctx=>{ctx.advanceProviderScan=({scopeKey,generation,expectedRevision,control,rows=[],resolvedRows=[]})=>{const old=scans.get(scopeKey);assert.equal(expectedRevision,old?.revision||0);for(const row of rows){const key=memberKey(scopeKey,generation,row.providerId);if(members.has(key))throw Object.assign(Error('duplicate'),{code:'PROVIDER_INVENTORY_CURSOR_CONFLICT'});members.set(key,{scopeKey,generation,...row});}for(const row of resolvedRows)members.set(memberKey(scopeKey,generation,row.providerId),{scopeKey,generation,...row});scans.set(scopeKey,{generation,revision:(old?.revision||0)+1,control:structuredClone(control)});};ctx.sealProviderScan=({scopeKey,generation,control,seal})=>{ctx.recordEvidence({namespace:'provider_effects',id:scopeKey+':'+generation+':seal',payload:{...seal,generation}});const prior=store.getEvidence('provider_inventory',scopeKey+':control');ctx.recordEvidence({namespace:'provider_inventory',id:scopeKey+':control',payload:{...control},expectedRevision:prior?.revision||0});for(const[key,row]of members){if(row.scopeKey===scopeKey&&row.generation===generation){if(seal.complete)current.set(scopeKey+':'+row.providerId,{factId:row.factId});members.delete(key);}}scans.delete(scopeKey);};ctx.acknowledgeReflectedEffects=()=>{acknowledged=true;};return fn(ctx);});
 const client={balance:{retrieve:async()=>{assert.equal(locked,false);return {object:'balance',livemode:false,available:[{currency:'usd',amount:count*100}],pending:[]};}},balanceTransactions:{list:async({limit,starting_after})=>{assert.equal(locked,false);listCalls++;const start=starting_after?rows.findIndex(r=>r.id===starting_after)+1:0;return {data:structuredClone(rows.slice(start,start+limit)),has_more:start+limit<rows.length};},retrieve:async id=>({...rows.find(r=>r.id===id),status:'available'})}};
 const registry={getVerifiedClient:async()=>({client,context}),assertVerifiedContext:c=>{assert.equal(c,context);return client;}};
 const options={epoch,store,coordinator,registry,maxPagesPerBatch:2,clock:()=>1000,verifyEffect:async()=>true};return {epoch,store,coordinator,client,rows,records,options,create:()=>createProviderInventory(options),get listCalls(){return listCalls;}};
}
test('full inventory above2000 pauses durably and resumes after restart without premature completeness',async()=>{const f=fixture();let result,steps=0;do{result=await f.create().scan();steps++;assert.ok(steps<20);if(steps<12)assert.equal(result.complete,false);}while(!result.complete);assert.equal(result.transactionCount,2201);assert.equal(steps,12);assert.equal(f.create().hasAvailableEffect(result.provider_inventory_ref,'txn_1'),true);});
test('unknown movements never produce complete inventory and snapshot fallback is forbidden',async()=>{const f=fixture(3);f.options.verifyEffect=async row=>row.id!=='txn_2';await assert.rejects(f.create().scan(),{code:'PROVIDER_EFFECT_UNRESOLVED'});});
test('head change invalidates a finished scan rather than inferring completeness from equal balance',async()=>{const f=fixture(3),list=f.client.balanceTransactions.list;let calls=0;f.client.balanceTransactions.list=async args=>{calls++;if(calls===3)f.rows.unshift({...f.rows[0],id:'txn_new'});return list(args);};const result=await f.create().scan();assert.equal(result.complete,false);assert.equal(result.reason,'PROVIDER_INVENTORY_CUT_CHANGED');});
test('pending transactions are canonically retrieved and recorded before generation becomes complete',async()=>{const f=fixture(2);f.rows[1].status='pending';let reads=0;f.client.balanceTransactions.retrieve=async id=>{reads++;return {...f.rows.find(r=>r.id===id),status:'available'};};const result=await f.create().scan();assert.equal(result.complete,true);assert.equal(reads,1);assert.equal(f.create().hasAvailableEffect(result.provider_inventory_ref,'txn_1'),true);});

test('refund discovery above10000 resumes with bounded durable cursor and exact uniqueness after restart',async()=>{
 const f=fixture(0),source={id:'source',accountId:'buyer',charge_id:'ch_refund'},operation={id:'operation',request_digest:'digest'};
 const rows=Array.from({length:10201},(_,i)=>({id:'re_'+(10201-i),object:'refund',charge:'ch_refund',amount:1,currency:'usd',metadata:{}}));
 const context={stripe_platform:f.epoch.platform,stripe_platform_account_id:f.epoch.platform_account_id,livemode:false};
 f.client.refunds={list:async({starting_after,limit})=>{const start=starting_after?rows.findIndex(r=>r.id===starting_after)+1:0;return {data:rows.slice(start,start+limit),has_more:start+limit<rows.length};},retrieve:async id=>rows.find(r=>r.id===id)};
 const registry={assertVerifiedContext:c=>{assert.equal(c,context);return f.client;}};
 const options={store:f.store,coordinator:f.coordinator,epoch:f.epoch,client:f.client,context,registry,source,operation,maxPagesPerBatch:2,validateRefund:refund=>({refund,classification:refund.id==='re_1'?'match':'external',amountConflict:false})};
 const {createRefundInventory}=require('../lib/provider-inventory');let result,cursor,calls=0;
 do{result=await createRefundInventory(options).scan({cursor});cursor=result.cursor;calls++;assert.ok(calls<60);if(cursor)assert.ok(JSON.stringify(cursor).length<300);}while(!result.complete);
 assert.equal(calls,52);assert.equal(result.matchCount,1);assert.equal(result.matched.id,'re_1');assert.equal(result.conflictCount,0);const control=f.store.getEvidence('provider_inventory',createRefundInventory(options).scopeKey+':control');assert.equal(control.payload.count,10201);assert.ok(JSON.stringify(control.payload).length<2000);assert.equal(control.payload.seen,undefined);assert.equal(control.payload.refunds,undefined);
});
test('refund generation mismatch is refused and bounded charge consumption preserves all external rows',async()=>{
 const f=fixture(0),source={id:'source',accountId:'buyer',charge_id:'ch_refund'},context={stripe_platform:f.epoch.platform,stripe_platform_account_id:f.epoch.platform_account_id,livemode:false};
 const rows=Array.from({length:201},(_,i)=>({id:'re_'+i,object:'refund',charge:'ch_refund',amount:1,currency:'usd',metadata:{}}));f.client.refunds={list:async({starting_after,limit})=>{const start=starting_after?rows.findIndex(r=>r.id===starting_after)+1:0;return {data:rows.slice(start,start+limit),has_more:start+limit<rows.length};},retrieve:async id=>rows.find(r=>r.id===id)};
 const options={store:f.store,coordinator:f.coordinator,epoch:f.epoch,client:f.client,context,registry:{assertVerifiedContext:()=>f.client},source,maxPagesPerBatch:5,validateRefund:refund=>({refund,classification:'charge_refund'})},create=()=>require('../lib/provider-inventory').createRefundInventory(options);
 let result=await create().scan(),seen=[];assert.equal(result.inventory_complete,true);while(true){assert.ok(result.refunds.length<=100);seen.push(...result.refunds.map(r=>r.id));if(result.complete)break;result=await create().scan({cursor:result.cursor});}assert.equal(seen.length,201);assert.equal(new Set(seen).size,201);
 await assert.rejects(create().scan({cursor:{phase:'consume',inventory_ref:{scopeKey:create().scopeKey,generation:999},after:'bad'}}),{code:'RETURN_SCAN_GENERATION_CONFLICT'});
});
test('refund scan refuses duplicate IDs and a changed head rather than asserting false completeness',async()=>{
 for(const mode of ['duplicate','head']){
  const f=fixture(0),source={id:'s',accountId:'buyer',charge_id:'ch_s'},operation={id:'o',request_digest:'d'},context={stripe_platform:f.epoch.platform,stripe_platform_account_id:f.epoch.platform_account_id,livemode:false};
  const rows=Array.from({length:201},(_,i)=>({id:'re_'+i,object:'refund',charge:'ch_s',amount:1,currency:'usd'}));if(mode==='duplicate')rows[150].id=rows[1].id;let heads=0;
  f.client.refunds={list:async({limit,starting_after})=>{if(limit===1&&++heads===2&&mode==='head')rows.unshift({...rows[0],id:'re_new'});const start=starting_after?rows.findIndex(r=>r.id===starting_after)+1:0;return {data:rows.slice(start,start+limit),has_more:start+limit<rows.length};},retrieve:async id=>rows.find(r=>r.id===id)};
  const inventory=require('../lib/provider-inventory').createRefundInventory({store:f.store,coordinator:f.coordinator,epoch:f.epoch,client:f.client,context,registry:{assertVerifiedContext:()=>f.client},source,operation,maxPagesPerBatch:5,validateRefund:refund=>({refund,classification:'external'})});
  if(mode==='duplicate')await assert.rejects(inventory.scan(),{code:'RETURN_PROVIDER_EVIDENCE_INCOMPLETE'});else{const result=await inventory.scan();assert.equal(result.complete,false);assert.equal(result.reason,'RETURN_SCAN_CUT_CHANGED');}
 }
});

test('unchanged canonical fact versions are retained once across complete generations',async()=>{const f=fixture(101);for(let generation=1;generation<=10;generation++){let result;do{result=await f.create().scan();}while(!result.complete);assert.equal(result.generation,generation);}const facts=[...f.records.values()].filter(r=>r.namespace==='provider_effects'&&r.id.includes(':fact:'));assert.equal(facts.length,101);const seals=[...f.records.values()].filter(r=>r.id.endsWith(':seal'));assert.equal(seals.length,10);assert.ok(f.listCalls>=40,'each generation still performs a full canonical listing');});

test('interleaved charge scans restart stale consumption with holds and retain each refund fact once',async()=>{const f=fixture(0),source={id:'source',accountId:'buyer',charge_id:'ch_refund'},context={stripe_platform:f.epoch.platform,stripe_platform_account_id:f.epoch.platform_account_id,livemode:false},rows=Array.from({length:201},(_,i)=>({object:'refund',id:'re_'+i,charge:'ch_refund',amount:1,currency:'usd'}));f.client.refunds={list:async({limit,starting_after})=>{const start=starting_after?rows.findIndex(x=>x.id===starting_after)+1:0;return{data:rows.slice(start,start+limit),has_more:start+limit<rows.length};},retrieve:async id=>rows.find(x=>x.id===id)};const create=()=>require('../lib/provider-inventory').createRefundInventory({store:f.store,coordinator:f.coordinator,epoch:f.epoch,source,context,client:f.client,registry:{assertVerifiedContext:()=>f.client},maxPagesPerBatch:5,validateRefund:refund=>({refund,classification:'charge_refund'})});const first=await create().scan();assert.equal(first.refunds.length,100);const applied=new Set(first.refunds.map(x=>x.id));await create().scan();const stale=await create().scan({cursor:first.cursor});assert.equal(stale.complete,false);assert.equal(stale.cursor,null);assert.equal(stale.reason,'RETURN_SCAN_SUPERSEDED');assert.equal(applied.size,100,'restart does not discard previously applied effects');let result=await create().scan();while(true){for(const refund of result.refunds)applied.add(refund.id);if(result.complete)break;result=await create().scan({cursor:result.cursor});}assert.equal(applied.size,201);assert.equal([...f.records.values()].filter(r=>r.id.startsWith('stripe_refund_fact:')).length,201);});


test('overlapping inventory calls keep capacity ownership lexical across provider awaits',async()=>{
 const f=fixture(1),original=f.options.registry.getVerifiedClient;let release,first=true;const gate=new Promise(resolve=>{release=resolve;});
 f.options.registry={...f.options.registry,getVerifiedClient:async()=>{if(first){first=false;await gate;}return original();}};
 const seen=[],local=f.coordinator.withMoneyControl;f.coordinator.withMoneyControl=(options,fn)=>local(options,ctx=>{const record=ctx.recordEvidence;ctx.recordEvidence=input=>{if(input.id.includes(':fact:'))seen.push(input.capacity?.sourceId);return record(input);};return fn(ctx);});
 const inventory=f.create(),pending=inventory.scan({capacity:{mandatory:true,sourceId:'source_A'}}),next=inventory.scan({capacity:{mandatory:true,sourceId:'source_B'}});await new Promise(resolve=>setImmediate(resolve));release();const results=await Promise.allSettled([pending,next]);assert.ok(results.every(x=>x.status==='fulfilled'),JSON.stringify(results));assert.deepEqual(seen,['source_A','source_B']);
});


function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
for(const phase of ['initial','page'])test('separate factories serialize same-scope '+phase+' provider awaits through complete generation',async()=>{
 const f=fixture(1),entered=deferred(),gate=deferred();let starts=0;
 const object=phase==='initial'?f.client.balance:f.client.balanceTransactions,key=phase==='initial'?'retrieve':'list',original=object[key];
 object[key]=async args=>{if(phase==='initial'||args.limit===100){starts++;if(starts===1){entered.resolve();await gate.promise;}}return original(args);};
 const first=f.create().scan();await entered.promise;const second=f.create().scan();
 let blocked;try{await tick();blocked=starts===1;}finally{gate.resolve();}
 const results=await Promise.allSettled([first,second]);assert.equal(blocked,true,'successor must not enter provider turn before predecessor releases');assert.ok(results.every(r=>r.status==='fulfilled'),JSON.stringify(results));assert.deepEqual(results.map(r=>r.value.generation),[1,2]);assert.ok(results.every(r=>r.value.complete));
});
test('failed scan releases queue and successor resumes durable page without losing guards',async()=>{
 const f=fixture(1),entered=deferred(),gate=deferred(),original=f.client.balanceTransactions.list;let pages=0;
 f.client.balanceTransactions.list=async args=>{if(args.limit===100&&++pages===1){entered.resolve();await gate.promise;throw Object.assign(Error('synthetic provider failure'),{code:'SYNTHETIC_PROVIDER_FAILURE'});}return original(args);};
 const first=f.create().scan();await entered.promise;const second=f.create().scan();await tick();gate.resolve();const results=await Promise.allSettled([first,second]);assert.equal(results[0].reason.code,'SYNTHETIC_PROVIDER_FAILURE');assert.equal(results[1].status,'fulfilled');assert.equal(results[1].value.generation,1);assert.equal(results[1].value.complete,true);assert.equal((await f.create().scan()).generation,2,'completed queue must cleanly admit a later generation');
});
test('queued provider demand and capacity are captured before caller mutation',async()=>{
 const f=fixture(1),entered=deferred(),gate=deferred(),original=f.options.registry.getVerifiedClient;let starts=0;
 f.options.registry={...f.options.registry,getVerifiedClient:async()=>{if(++starts===1){entered.resolve();await gate.promise;}return original();}};
 const seen=[],local=f.coordinator.withMoneyControl;f.coordinator.withMoneyControl=(options,fn)=>local(options,ctx=>{const record=ctx.recordEvidence;ctx.recordEvidence=input=>{if(input.id.includes(':fact:'))seen.push(input.capacity?.sourceId);return record(input);};return fn(ctx);});
 const first=f.create().scan({capacity:{mandatory:true,sourceId:'first'}});await entered.promise;const capacity={mandatory:true,sourceId:'second'},second=f.create().scan({capacity});capacity.sourceId='mutated';gate.resolve();await Promise.all([first,second]);assert.deepEqual(seen,['first','second']);
});
test('different stores and different scopes progress while one scope awaits provider',async()=>{
 const f=fixture(0),entered=deferred(),gate=deferred(),original=f.options.registry.getVerifiedClient;
 f.options.registry={...f.options.registry,getVerifiedClient:async()=>{entered.resolve();await gate.promise;return original();}};
 const first=f.create().scan();await entered.promise;
 const other=fixture(0),context={stripe_platform:f.epoch.platform,stripe_platform_account_id:'acct_other',livemode:false};
 const distinct=createProviderInventory({...f.options,epoch:{...f.epoch,platform_account_id:'acct_other'},registry:{getVerifiedClient:async()=>({client:f.client,context}),assertVerifiedContext:()=>f.client}});
 try{assert.equal((await other.create().scan()).complete,true);assert.equal((await distinct.scan()).complete,true);}finally{gate.resolve();}await first;
});
function refundFixture(){const f=fixture(0),source={id:'source',accountId:'buyer',charge_id:'ch_refund'},context={stripe_platform:f.epoch.platform,stripe_platform_account_id:f.epoch.platform_account_id,livemode:false},rows=[{id:'re_1',object:'refund',charge:'ch_refund',amount:1,currency:'usd'}];f.client.refunds={list:async({limit})=>({data:rows.slice(0,limit),has_more:false}),retrieve:async id=>rows.find(r=>r.id===id)};const options={store:f.store,coordinator:f.coordinator,epoch:f.epoch,source,context,client:f.client,registry:{assertVerifiedContext:()=>f.client},maxPagesPerBatch:5,validateRefund:refund=>({refund,classification:'charge_refund'})};return{...f,source,options,create:()=>require('../lib/provider-inventory').createRefundInventory(options)};}
for(const phase of ['initial','page','consume'])test('refund '+phase+' turn stays serialized across separate factories through consumption',async()=>{
 const f=refundFixture(),entered=deferred(),gate=deferred(),method=phase==='consume'?'retrieve':'list',original=f.client.refunds[method];let starts=0;
 f.client.refunds[method]=async args=>{if(phase==='consume'||args.limit===(phase==='initial'?1:100)){starts++;if(starts===1){entered.resolve();await gate.promise;}}return original(args);};
 const first=f.create().scan();await entered.promise;const second=f.create().scan();let blocked;try{await tick();blocked=starts===1;}finally{gate.resolve();}const results=await Promise.allSettled([first,second]);assert.equal(blocked,true,'successor must wait until consumption is complete');assert.ok(results.every(r=>r.status==='fulfilled'),JSON.stringify(results));assert.deepEqual(results.map(r=>r.value.inventory_ref.generation),[1,2]);assert.ok(results.every(r=>r.value.refunds.length===1));
});

test('balance scan queue retains ownership through reflected-effect acknowledgment',async()=>{
 const f=fixture(1),entered=deferred(),gate=deferred(),local=f.coordinator.withMoneyControl,original=f.options.registry.getVerifiedClient;let providerStarts=0,blockedOnce=false;
 f.options.registry={...f.options.registry,getVerifiedClient:async()=>{providerStarts++;return original();}};
 f.coordinator.withMoneyControl=(options,fn)=>local(options,async ctx=>{let acknowledged=false;const ack=ctx.acknowledgeReflectedEffects;ctx.acknowledgeReflectedEffects=input=>{acknowledged=true;return ack(input);};const result=await fn(ctx);if(acknowledged&&!blockedOnce){blockedOnce=true;entered.resolve();await gate.promise;}return result;});
 const first=f.create().scan();await entered.promise;const second=f.create().scan();let blocked;try{await tick();blocked=providerStarts===1;}finally{gate.resolve();}const results=await Promise.all([first,second]);assert.equal(blocked,true);assert.deepEqual(results.map(r=>r.generation),[1,2]);
});
test('queued refund request cannot take over an unfinished other-operation generation',async()=>{
 const f=refundFixture(),rows=Array.from({length:201},(_,i)=>({id:'re_'+i,object:'refund',charge:f.source.charge_id,amount:1,currency:'usd'})),entered=deferred(),gate=deferred();let pages=0;
 f.client.refunds.list=async({limit,starting_after})=>{if(limit===100&&++pages===1){entered.resolve();await gate.promise;}const start=starting_after?rows.findIndex(x=>x.id===starting_after)+1:0;return{data:rows.slice(start,start+limit),has_more:start+limit<rows.length};};
 const create=operation=>require('../lib/provider-inventory').createRefundInventory({...f.options,operation,maxPagesPerBatch:1});
 const operation={id:'first-operation',request_digest:'first-digest'},first=create(operation).scan();await entered.promise;const other=create({id:'foreign-operation',request_digest:'foreign-digest'}).scan();await tick();gate.resolve();const results=await Promise.allSettled([first,other]);assert.equal(results[0].status,'fulfilled');assert.equal(results[0].value.complete,false);assert.equal(results[1].reason.code,'RETURN_SCAN_IDENTITY_BUSY');assert.equal(pages,1,'foreign owner never fetches an unfinished generation page');
 const scope=create(operation).scopeKey;assert.equal(f.store.getProviderScan(scope).control.operation_id,operation.id);const next=await create(operation).scan({cursor:results[0].value.cursor});assert.equal(next.inventory_ref.generation,results[0].value.inventory_ref.generation);assert.equal(f.store.getProviderScan(scope).control.count,200);
});

test('anchored inventory recovery passes its opaque capability through every write while unanchored scan stays gated',async()=>{
 const f=fixture(2),anchor=Object.freeze({synthetic:'committed-operation'}),original=f.coordinator.withMoneyControl,segments=[];
 f.coordinator.failureControl={assertRecoveryAllowed(a,{action}){assert.equal(a,anchor);assert.equal(action,'provider_reconcile');}};
 f.coordinator.withMoneyControl=(opts,fn)=>{if(opts.recoveryAnchor!==anchor)throw Object.assign(Error('FINANCIAL_RECOVERY_REQUIRED'),{code:'FINANCIAL_RECOVERY_REQUIRED'});assert.equal(opts.action,'provider_reconcile');segments.push(opts);return original(opts,fn);};
 await assert.rejects(f.create().scan(),{code:'FINANCIAL_RECOVERY_REQUIRED'});
 f.coordinator.recoveryAnchors={revalidate:()=>({kind:'dispatch_operation',id:'owed'})};
 const result=await f.create().scan({recoveryAnchor:anchor,demand:{operationId:'owed'}});assert.equal(result.complete,true);assert.ok(segments.length>=4);
});

test('unrelated valid recovery capability cannot authorize inventory of another operation',async()=>{
 const f=fixture(2),anchor=Object.freeze({synthetic:'other'});f.coordinator.failureControl={assertRecoveryAllowed(){}};f.coordinator.recoveryAnchors={revalidate:()=>({kind:'dispatch_operation',id:'other'})};
 await assert.rejects(f.create().scan({recoveryAnchor:anchor,demand:{operationId:'owed'}}),{code:'RECOVERY_ANCHOR_SCOPE_MISMATCH'});assert.equal(f.listCalls,0);assert.equal(f.records.size,0);
});
