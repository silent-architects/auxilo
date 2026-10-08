"use strict";
const d=require('./money-database');
const crypto=require('node:crypto');
const clone=v=>v===undefined?undefined:structuredClone(v);
const stable=v=>JSON.stringify(v);
const TERMINAL=new Set(['settled','failed','canceled','requote_required']);
function checkedSum(values){let n=0n;for(const v of values){if(!Number.isSafeInteger(v)||v<0)throw d.fail('INVALID_MONEY_INTEGER');n+=BigInt(v);}return d.safe(n);}
function rowPage(items,limit){const more=items.length>limit;const list=items.slice(0,limit);return{items:list,nextCursor:more&&list.length?Buffer.from(JSON.stringify([list.at(-1).sequence||0,list.at(-1).id])).toString('base64url'):null};}
function cursor(after){if(!after)return null;try{const x=JSON.parse(Buffer.from(after,'base64url'));if(!Array.isArray(x)||!Number.isSafeInteger(x[0])||typeof x[1]!=='string')throw 0;return x;}catch{throw d.fail('MONEY_CURSOR_INVALID');}}
function createRepository({db,epoch,readOnly=false,beforeWrite,beforeCommit,afterWrite,testFault,atomicRouter}){
 if(testFault&&!process.env.NODE_TEST_CONTEXT)throw d.fail('TEST_FAULT_FORBIDDEN');const fault=phase=>{if(testFault)testFault(phase,{inTransaction:db.inTransaction});};
 const metadata=d.readMetadata(db), cache=new Map(), original=new Map(), evidenceChanges=new Map(),evidenceCapacity=new Map(),capacityChanges=new Map(),capacityOriginal=new Map(),scanChanges=new Map();
 function key(name,id){return name+'\0'+id;}
 function get(name,id){if(typeof id!=='string')return undefined;const k=key(name,id);if(cache.has(k))return cache.get(k);const row=d.get(db,name,id);cache.set(k,row);original.set(k,clone(row));return row;}
 function set(name,id,value){if(readOnly)throw d.fail('MONEY_READ_ONLY');get(name,id);cache.set(key(name,id),value);return value;}
 const state={schema:1,epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,revision:metadata.revision,sequence:metadata.sequence,bootstrap:clone(metadata.bootstrap)};
 for(const name of d.COLLECTIONS)state[name]=new Proxy(Object.create(null),{get(_,id){if(typeof id==='symbol')return undefined;return get(name,id);},set(_,id,v){set(name,id,v);return true;},deleteProperty(_,id){set(name,id,undefined);return true;},ownKeys(){throw d.fail('MONEY_FULL_SNAPSHOT_FORBIDDEN');},getOwnPropertyDescriptor(){return{enumerable:true,configurable:true};}});
 function rows(name,filters={}){
   const cols={owner:'owner',sourceId:'source_id',poolId:'pool_id',operationId:'operation_id',state:'state',platform_account_id:'provider_account',livemode:'livemode',providerId:'provider_id',lotId:'lot_id',requestKey:'request_key'};
   const clauses=[],params=[];
   for(const[k,v]of Object.entries(filters)){if(cols[k]&&v!==undefined){clauses.push(cols[k]+'=?');params.push(k==='livemode'?Number(v):v);}}
   if(filters.ids){if(!filters.ids.length)return[];clauses.push('(CASE id '+filters.ids.map(()=> 'WHEN ? THEN 1').join(' ')+' ELSE 0 END)=1');params.push(...filters.ids);}
   if(filters.states){clauses.push(filters.states.length?'(CASE state '+filters.states.map(()=> 'WHEN ? THEN 1').join(' ')+' ELSE 0 END)=1':'0');params.push(...filters.states);}
   if(filters.nonterminal)clauses.push("state!='settled' AND state!='failed' AND state!='canceled' AND state!='requote_required'");
   const after=cursor(filters.after);if(after){clauses.push('(sequence>? OR (sequence=? AND id>?))');params.push(after[0],after[0],after[1]);}
   if(filters.cashPending)clauses.push("CAST(json_extract(payload,'$.cashReservedMicros') AS INTEGER)>0");
   const suffix=filters.limit?' LIMIT ?':'';if(filters.limit)params.push(filters.limit);
   const ids=new Set(db.prepare(`SELECT id FROM ${name} INDEXED BY ${name}_sequence_id${clauses.length?' WHERE '+clauses.join(' AND '):''} ORDER BY sequence,id${suffix}`).all(...params).map(x=>x.id));
   for(const k of cache.keys())if(k.startsWith(name+'\0'))ids.add(k.slice(name.length+1));
   return [...ids].map(id=>get(name,id)).filter(Boolean).filter(v=>{
     const index=d.identity(name,v);for(const[k,x]of Object.entries(filters))if(cols[k]&&x!==undefined&&index[cols[k]]!==(k==='livemode'?Number(x):x))return false;
     return(!after||(v.sequence||0)>after[0]||((v.sequence||0)===after[0]&&v.id>after[1]))&&(!filters.cashPending||v.cashReservedMicros>0)&&(!filters.ids||filters.ids.includes(v.id))&&(!filters.states||filters.states.includes(v.state))&&(!filters.nonterminal||!TERMINAL.has(v.state));
   }).sort((a,b)=>(a.sequence||0)-(b.sequence||0)||(a.id||'').localeCompare(b.id||''));
 }
 function relatedPools({accountId,sourceId}={}){
   const clauses=["collection='pools'"],args=[];if(accountId){clauses.push("field='parties' AND owner=?");args.push(accountId);}if(sourceId){clauses.push("field='fragments' AND source_id=?");args.push(sourceId);}
   const ids=new Set(db.prepare('SELECT DISTINCT parent_id FROM money_edges INDEXED BY sqlite_autoindex_money_edges_1 WHERE '+clauses.join(' AND ')).all(...args).map(x=>x.parent_id));
   for(const[k,p]of cache)if(k.startsWith('pools\0')&&p)ids.add(p.id);
   return [...ids].map(id=>get('pools',id)).filter(p=>p&&(!accountId||p.parties.includes(accountId))&&(!sourceId||p.fragments.some(f=>f.sourceId===sourceId))).sort((a,b)=>a.sequence-b.sequence||a.id.localeCompare(b.id));
 }
 function sourceSpends(sourceId){const ids=new Set(db.prepare("SELECT e.parent_id FROM money_edges e JOIN spends v ON v.id=e.parent_id WHERE e.collection='spends' AND e.field='draws' AND e.source_id=? AND v.state='prepared'").all(sourceId).map(x=>x.parent_id));for(const[k,v]of cache)if(k.startsWith('spends\0')&&v)ids.add(v.id);return [...ids].map(id=>get('spends',id)).filter(x=>x?.draws.some(v=>v.sourceId===sourceId));}
 function affectedPools(){const ids=new Set();for(const[k,v]of cache){if(k.startsWith('pools\0')&&v)ids.add(v.id);if(k.startsWith('sources\0')&&v)for(const p of relatedPools({sourceId:v.id}))ids.add(p.id);if(k.startsWith('costs\0')&&v)for(const p of relatedPools({sourceId:v.sourceId}))ids.add(p.id);}return [...ids].map(id=>get('pools',id)).sort((a,b)=>a.sequence-b.sequence||a.id.localeCompare(b.id));}
 function changed(){return [...cache].filter(([k,v])=>stable(v)!==stable(original.get(k))).map(([k,value])=>{const i=k.indexOf('\0');return{name:k.slice(0,i),id:k.slice(i+1),value,prior:original.get(k)};});}
 function totals(){let local=BigInt(metadata.totals?.localLiabilityMicros||0),exposure=BigInt(metadata.totals?.exposureMicros||0);for(const c of changed()){
   const contribution=v=>!v?0:c.name==='sources'?v.amountMicros-v.spentMicros-v.retiredMicros:c.name==='pools'?v.contributorShareMicros-(v.contributorReversedMicros||0):0;
   local+=BigInt(contribution(c.value)-contribution(c.prior));
   const risk=v=>!v?0:c.name==='pools'?(v.exposureMicros||0):c.name==='operations'?(v.failedCostExposureMicros||0):c.name==='sources'?(v.originalExposureMicros||0):0;
   exposure+=BigInt(risk(c.value)-risk(c.prior));
 }if(local<0n||exposure<0n)throw d.fail('MONEY_TOTAL_CONSERVATION');return{localLiabilityMicros:d.safe(local),exposureMicros:d.safe(exposure)};}
 let reflectionGeneration=metadata.cashReflectionGeneration||0;
 function advanceCashReflectionGeneration(generation){if(!Number.isSafeInteger(generation)||generation<0)throw d.fail('CASH_REFLECTION_PROOF_REQUIRED');reflectionGeneration=Math.max(reflectionGeneration,generation);}
 function cashReflectionGeneration(){return reflectionGeneration;}
 function cashObligations(){const ids=new Set(db.prepare("SELECT operation_id FROM cash_commitments WHERE (cash_micros>0 AND (reflected_version IS NULL OR reflected_version!=version)) OR state!='settled' AND state!='failed' AND state!='canceled' AND state!='requote_required'").all().map(r=>r.operation_id));for(const[k,v]of cache)if(k.startsWith('operations\0')&&v)ids.add(v.id);return[...ids].map(id=>get('operations',id)).filter(o=>o&&((o.cashReservedMicros>0&&o.cashReflectionVersion!==d.cashVersion(o))||!TERMINAL.has(o.state)));}
 function listOutstandingCashEffects({after,limit=100}={}){if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw d.fail('MONEY_PAGE_INVALID');const c=cursor(after),args=[],clause=c?' AND (sequence>? OR (sequence=? AND operation_id>?))':'';if(c)args.push(c[0],c[0],c[1]);const rs=db.prepare('SELECT operation_id FROM cash_commitments INDEXED BY cash_sequence_id WHERE cash_micros>0 AND (reflected_version IS NULL OR reflected_version!=version)'+clause+' ORDER BY sequence,operation_id LIMIT ?').all(...args,limit+1);return rowPage(rs.map(r=>{const o=get('operations',r.operation_id);return{id:o.id,sequence:o.sequence,operationId:o.id,sourceId:o.sourceId,accountId:o.accountId,platform_account_id:o.platform_account_id,livemode:o.livemode,currency:o.currency,effectIds:d.cashEffectIds(o),cashReservedMicros:o.cashReservedMicros,obligationVersion:d.cashVersion(o)};}),limit);}
 function invalidateCashReflection(effectId,priorFactId){for(const row of db.prepare('SELECT operation_id FROM cash_effects WHERE effect_id=? AND ack_fact_id=?').all(effectId,priorFactId)){const o=get('operations',row.operation_id);if(o){o.cashReflectionVersion=null;o.cashReflectionProofId=null;o.cashReflectionFacts={};}}}
 function getCapacity(id){if(capacityChanges.has(id))return clone(capacityChanges.get(id));const r=db.prepare('SELECT payload FROM capacity_reservations WHERE id=?').get(id);return r?JSON.parse(r.payload):undefined;}
 function setCapacity(value){if(readOnly)throw d.fail('MONEY_READ_ONLY');if(!value||typeof value.id!=='string'||typeof value.state!=='string')throw d.fail('CAPACITY_RECORD_INVALID');if(!capacityOriginal.has(value.id))capacityOriginal.set(value.id,getCapacity(value.id));capacityChanges.set(value.id,clone(value));return clone(value);}
 function flushCapacity(){for(const value of capacityChanges.values())db.prepare('INSERT INTO capacity_reservations(id,payload,state,source_id,operation_id) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,state=excluded.state,source_id=excluded.source_id,operation_id=excluded.operation_id').run(value.id,JSON.stringify(value),value.state,value.sourceId||null,value.operationId||null);}
 function getEvidence(namespace,id){const k=key(namespace,id);if(evidenceChanges.has(k))return clone(evidenceChanges.get(k));const r=db.prepare('SELECT payload,indexes,revision FROM evidence WHERE namespace=? AND id=?').get(namespace,id);return r?{namespace,id,payload:JSON.parse(r.payload),indexes:JSON.parse(r.indexes),revision:d.safe(r.revision)}:undefined;}
 const IMMUTABLE=new Set(['verified_capture','object_origins','enrollment_proofs','provider_effects','event_dispositions','applied_effects','cash_reflections']);const MUTABLE=new Set(['provider_inventory','checkout_intents','event_receipts','capture_heads']);
 function recordEvidence(input){if(readOnly)throw d.fail('MONEY_READ_ONLY');const{namespace,id,payload,expectedRevision}=input;if(!IMMUTABLE.has(namespace)&&!MUTABLE.has(namespace)||typeof id!=='string'||!payload||typeof payload!=='object')throw d.fail('MONEY_EVIDENCE_INVALID');const old=getEvidence(namespace,id),indexes={...(input.indexes||{})};if(indexes.sequence===undefined)indexes.sequence=old?.indexes.sequence??++state.sequence;if(!Number.isSafeInteger(indexes.sequence)||indexes.sequence<0)throw d.fail('MONEY_EVIDENCE_INVALID');if(old&&stable(old.payload)===stable(payload)&&stable(old.indexes)===stable(indexes))return old;if(old&&(IMMUTABLE.has(namespace)||expectedRevision!==old.revision))throw d.fail('MONEY_EVIDENCE_CONFLICT');if(!old&&expectedRevision!==undefined&&expectedRevision!==null&&expectedRevision!==0)throw d.fail('MONEY_EVIDENCE_CONFLICT');const row={namespace,id,payload:clone(payload),indexes,revision:(old?.revision||0)+1};evidenceChanges.set(key(namespace,id),row);if(input.capacity)evidenceCapacity.set(key(namespace,id),clone(input.capacity));return clone(row);}
 function listEvidence(options){const{namespace,accountId,providerId,state:status,platform_account_id,livemode,prefix,after,limit=100}=options;if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw d.fail('MONEY_PAGE_INVALID');const clauses=['namespace=?'],args=[namespace];for(const[col,v]of [['owner',accountId],['provider_id',providerId],['state',status],['provider_account',platform_account_id],['livemode',livemode===undefined?undefined:Number(livemode)]])if(v!==undefined){clauses.push(col+'=?');args.push(v);}if(prefix!==undefined){clauses.push('substr(id,1,?)=?');args.push(prefix.length,prefix);}const c=cursor(after);if(c){clauses.push('(sequence>? OR (sequence=? AND id>?))');args.push(c[0],c[0],c[1]);}const rs=db.prepare('SELECT id,sequence FROM evidence INDEXED BY evidence_sequence_id WHERE '+clauses.join(' AND ')+' ORDER BY sequence,id LIMIT ?').all(...args,limit+1);const selected=new Map(rs.map(r=>[r.id,getEvidence(namespace,r.id)]));for(const r of evidenceChanges.values())if(r.namespace===namespace)selected.set(r.id,clone(r));const result=[...selected.values()].filter(r=>{const i=r.indexes;return(accountId===undefined||i.accountId===accountId)&&(providerId===undefined||i.providerId===providerId)&&(status===undefined||i.state===status)&&(platform_account_id===undefined||i.platform_account_id===platform_account_id)&&(livemode===undefined||i.livemode===livemode)&&(prefix===undefined||r.id.startsWith(prefix))&&(!c||i.sequence>c[0]||(i.sequence===c[0]&&r.id>c[1]));}).map(r=>({...r,sequence:r.indexes.sequence||0})).sort((a,b)=>a.sequence-b.sequence||a.id.localeCompare(b.id));return rowPage(result,limit);}

 // Provider scan membership is resumable working state. Only terminal cut seals
 // and changed canonical facts enter the permanent financial audit.
 function getProviderScan(scopeKey){if(scanChanges.has(scopeKey))return clone(scanChanges.get(scopeKey).value);const r=db.prepare('SELECT generation,payload,revision FROM provider_scan_controls WHERE scope=?').get(scopeKey);return r?{scopeKey,generation:d.safe(r.generation),control:JSON.parse(r.payload),revision:d.safe(r.revision)}:undefined;}
 function scanIdentity(scopeKey,generation){if(typeof scopeKey!=='string'||scopeKey.length>512||!(scopeKey==='stripe:'+epoch.platform_account_id+':'+(epoch.livemode?'live':'test')||scopeKey.startsWith('stripe_refunds:'+epoch.platform_account_id+':'+epoch.livemode+':'))||!Number.isSafeInteger(generation)||generation<1)throw d.fail('PROVIDER_SCAN_GENERATION_CONFLICT');}
 function getProviderCurrentFact(scopeKey,providerId){const r=db.prepare('SELECT fact_id factId,cut_digest cutDigest FROM provider_scan_current WHERE scope=? AND provider_id=?').get(scopeKey,providerId);return r?{providerId,...r}:undefined;}
 function listProviderCurrentFacts({scopeKey,after,limit=100}){if(typeof scopeKey!=='string'||!Number.isSafeInteger(limit)||limit<1||limit>100)throw d.fail('MONEY_PAGE_INVALID');const rows=db.prepare('SELECT provider_id providerId,fact_id factId,cut_digest cutDigest FROM provider_scan_current WHERE scope=?'+(after?' AND provider_id>?':'')+' ORDER BY provider_id LIMIT ?').all(scopeKey,...(after?[after]:[]),limit+1);return{items:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].providerId:null};}
 function getProviderScanMember(scopeKey,generation,providerId){const r=db.prepare('SELECT provider_id providerId,fact_id factId,state FROM provider_scan_members WHERE scope=? AND generation=? AND provider_id=?').get(scopeKey,generation,providerId);return r||undefined;}
 function listProviderScanMembers({scopeKey,generation,state:status,after,limit=100}){scanIdentity(scopeKey,generation);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw d.fail('MONEY_PAGE_INVALID');const clauses=['scope=?','generation=?'],args=[scopeKey,generation];if(status){clauses.push('state=?');args.push(status);}if(after){clauses.push('provider_id>?');args.push(after);}const rows=db.prepare('SELECT provider_id providerId,fact_id factId,state FROM provider_scan_members WHERE '+clauses.join(' AND ')+' ORDER BY provider_id LIMIT ?').all(...args,limit+1);const items=rows.slice(0,limit);return{items,nextCursor:rows.length>limit?items.at(-1).providerId:null};}
 function advanceProviderScan({scopeKey,generation,expectedRevision,control,rows=[],resolvedRows=[],capacity}){if(control)control=Object.fromEntries(Object.entries(control).filter(([k])=>k!=='lastWrite'));if(readOnly)throw d.fail('MONEY_READ_ONLY');scanIdentity(scopeKey,generation);const old=getProviderScan(scopeKey);if(old&&old.generation!==generation||expectedRevision!==(old?.revision||0)||control?.generation!==generation||!['scanning','pending_validation','proof_validation','cut_validation'].includes(control.state)||Buffer.byteLength(JSON.stringify(control))>8192||!Array.isArray(rows)||rows.length>100)throw d.fail('PROVIDER_SCAN_GENERATION_CONFLICT');const change=scanChanges.get(scopeKey)||{rows:[]};const seen=new Set(change.rows.map(x=>x.providerId));for(const row of rows){if(typeof row.providerId!=='string'||row.providerId.length>256||typeof row.factId!=='string'||row.factId.length>1024||!['pending','available'].includes(row.state))throw d.fail('PROVIDER_SCAN_MEMBER_INVALID');if(seen.has(row.providerId)||db.prepare('SELECT 1 FROM provider_scan_members WHERE scope=? AND generation=? AND provider_id=?').get(scopeKey,generation,row.providerId))throw d.fail('PROVIDER_INVENTORY_CURSOR_CONFLICT');seen.add(row.providerId);}for(const row of resolvedRows){const prior=getProviderScanMember(scopeKey,generation,row.providerId);if(!prior||prior.state!=='pending'||!['available','validated'].includes(row.state)||typeof row.factId!=='string')throw d.fail('PROVIDER_SCAN_MEMBER_INVALID');}if(change.capacity&&stable(change.capacity)!==stable(capacity))throw d.fail('WORKSPACE_LEASE_CONFLICT');change.capacity=clone(capacity);change.rows.push(...clone(rows),...clone(resolvedRows));change.value={scopeKey,generation,control:clone(control),revision:(old?.revision||0)+1};scanChanges.set(scopeKey,change);return clone(change.value);}
 function sealProviderScan({scopeKey,generation,expectedRevision,control,seal,capacity}){if(readOnly)throw d.fail('MONEY_READ_ONLY');scanIdentity(scopeKey,generation);const old=getProviderScan(scopeKey);if(!old||old.generation!==generation||old.revision!==expectedRevision||control?.generation!==generation||!['complete','invalidated'].includes(control.state)||typeof seal?.complete!=='boolean'||seal.complete!==(control.state==='complete')||seal.complete&&seal.balanceDigest!==control.balanceDigest||!seal.complete&&(!seal.reason||!seal.startCutDigest||!seal.endCutDigest))throw d.fail('PROVIDER_SCAN_GENERATION_CONFLICT');const prior=getEvidence('provider_inventory',scopeKey+':control');if(seal.complete){if(db.prepare('SELECT 1 FROM provider_scan_current c LEFT JOIN provider_scan_members m ON m.scope=c.scope AND m.generation=? AND m.provider_id=c.provider_id WHERE c.scope=? AND m.provider_id IS NULL LIMIT 1').get(generation,scopeKey))throw d.fail('PROVIDER_INVENTORY_LINEAGE_MISSING');for(const row of db.prepare('SELECT c.provider_id,c.fact_id FROM provider_scan_current c JOIN provider_scan_members m ON m.scope=c.scope AND m.provider_id=c.provider_id AND m.generation=? WHERE c.scope=? AND c.fact_id<>m.fact_id').iterate(generation,scopeKey)){if(typeof invalidateCashReflection!=='function')throw d.fail('PROVIDER_FACT_CHANGE_REQUIRES_REPROOF');invalidateCashReflection(row.provider_id,row.fact_id);}}seal={...clone(seal),previousCutDigest:prior?.payload?.cutDigest||null};const cutDigest=require('./stripe-transfer-persistence').digestJSON(seal);control={...clone(control),cutDigest};const stamp={epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode};const indexes={platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,state:control.state};recordEvidence({namespace:'provider_effects',id:scopeKey+':'+generation+':seal',payload:{...stamp,...clone(seal),scopeKey,generation,cutDigest},indexes,capacity});recordEvidence({namespace:'provider_inventory',id:scopeKey+':control',payload:{...stamp,...clone(control)},indexes,expectedRevision:prior?.revision||0,capacity});scanChanges.set(scopeKey,{capacity:clone(capacity),value:undefined,rows:[],clearGeneration:generation,complete:seal.complete,cutDigest});}
 function flushProviderScans(){for(const[scopeKey,change]of scanChanges){if(change.clearGeneration){if(change.complete)db.prepare('INSERT INTO provider_scan_current(scope,provider_id,fact_id,cut_digest) SELECT scope,provider_id,fact_id,? FROM provider_scan_members WHERE scope=? AND generation=? ON CONFLICT(scope,provider_id) DO UPDATE SET fact_id=excluded.fact_id,cut_digest=excluded.cut_digest WHERE provider_scan_current.fact_id<>excluded.fact_id').run(change.cutDigest,scopeKey,change.clearGeneration);db.prepare('DELETE FROM provider_scan_members WHERE scope=? AND generation=?').run(scopeKey,change.clearGeneration);db.prepare('DELETE FROM provider_scan_controls WHERE scope=? AND generation=?').run(scopeKey,change.clearGeneration);continue;}const v=change.value;db.prepare('INSERT INTO provider_scan_controls(scope,generation,payload,revision) VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET generation=excluded.generation,payload=excluded.payload,revision=excluded.revision').run(scopeKey,v.generation,JSON.stringify(scanControlPayload(v)),v.revision);for(const row of change.rows)db.prepare('INSERT INTO provider_scan_members(scope,generation,provider_id,fact_id,state) VALUES(?,?,?,?,?) ON CONFLICT(scope,generation,provider_id) DO UPDATE SET fact_id=excluded.fact_id,state=excluded.state').run(scopeKey,v.generation,row.providerId,row.factId,row.state);}}
 function flushEvidence(){for(const r of evidenceChanges.values()){const i=r.indexes;db.prepare('INSERT INTO evidence(namespace,id,payload,indexes,revision,owner,provider_id,state,provider_account,livemode,sequence) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET payload=excluded.payload,indexes=excluded.indexes,revision=excluded.revision,owner=excluded.owner,provider_id=excluded.provider_id,state=excluded.state,provider_account=excluded.provider_account,livemode=excluded.livemode,sequence=excluded.sequence').run(r.namespace,r.id,JSON.stringify(r.payload),JSON.stringify(i),r.revision,i.accountId||null,i.providerId||null,i.state||null,i.platform_account_id||null,i.livemode===undefined?null:Number(i.livemode),i.sequence);}}
 function refreshOriginalExposure(){const sources=new Set();for(const c of changed()){if(c.name==='sources')sources.add(c.id);if(c.name==='costs'&&c.value?.kind==='original')sources.add(c.value.sourceId);}for(const id of sources){const s=get('sources',id);if(!s)continue;const c=get('costs',s.originalCostId);s.originalExposureMicros=c&&!s.originalCostSettled?c.amountMicros-c.coveredMicros-c.recoveredMicros:0;}}
 // Publication bookkeeping runs in an independent staging view. It may advance
 // the journal revision, but cannot publish the caller's financial drafts.
 function rebaseCapacityRevision(current,{mergeDrafts=false}={}){
   if(capacityChanges.size&&!mergeDrafts)throw d.fail('CAPACITY_DRAFT_REQUIRES_BOUNDARY');
   if(stable(current.totals)!==stable(metadata.totals)||(current.cashReflectionGeneration||0)!==(metadata.cashReflectionGeneration||0))throw d.fail('CAPACITY_ISOLATION_CONFLICT');
   for(const[id,draft]of capacityChanges){
    const row=db.prepare('SELECT payload FROM capacity_reservations WHERE id=?').get(id),latest=row?JSON.parse(row.payload):undefined,prior=capacityOriginal.get(id);
    if(stable(latest)===stable(prior))continue;
    if(!prior||!latest)throw d.fail('CAPACITY_DRAFT_REBASE_CONFLICT');
    const next=clone(latest);
    for(const field of new Set([...Object.keys(prior),...Object.keys(draft)]))if(stable(prior[field])!==stable(draft[field])){
     if(id==='capacity:root'&&['unassignedBytes','activeSources','activeFragments','generation'].includes(field)){
      const value=BigInt(latest[field])+BigInt(draft[field])-BigInt(prior[field]);if(value<0n)throw d.fail('CAPACITY_DRAFT_REBASE_CONFLICT');next[field]=d.safe(value);
     }else{if(stable(latest[field])!==stable(prior[field]))throw d.fail('CAPACITY_DRAFT_REBASE_CONFLICT');next[field]=clone(draft[field]);}
    }
    capacityChanges.set(id,next);capacityOriginal.set(id,clone(latest));
   }
   Object.assign(metadata,current);state.revision=current.revision;state.sequence=Math.max(state.sequence,current.sequence);
 }
 let operationalChange=null;
 function getOperationalControl(kind='quotes'){if(kind!=='quotes')throw d.fail('OPERATIONAL_CONTROL_INVALID');if(metadata.database_schema!==3)return undefined;const row=db.prepare('SELECT * FROM operational_controls WHERE kind=?').get(kind);return row?{...row,generation:d.safe(row.generation),revision:d.safe(row.revision),payload:JSON.parse(row.payload)}:undefined;}
 function describeQuoteChanges(){const changes=changed().filter(c=>c.name==='quotes');if(!changes.length)return null;const old=getOperationalControl();if(!old)throw d.fail('QUOTE_STORAGE_UPGRADE_REQUIRED');return{kind:'quotes',controlId:'quotes',priorGeneration:operationalChange?.priorGeneration??old.generation,generation:(operationalChange?.priorGeneration??old.generation)+1,quoteChangeCount:changes.length,quoteChangesDigest:require('./stripe-transfer-persistence').digestJSON(changes.map(c=>({id:c.id,before:c.prior??null,after:c.value??null})).sort((a,b)=>a.id.localeCompare(b.id)))};}
 function stageOperationalControl(summary){if(readOnly)throw d.fail('MONEY_READ_ONLY');const actual=describeQuoteChanges();if(!actual||stable(summary)!==stable(actual))throw d.fail('OPERATIONAL_CONTROL_INVALID');operationalChange={kind:'quotes',generation:actual.generation,priorGeneration:actual.priorGeneration};return clone(operationalChange);}
 function operationalPayload(){if(!operationalChange)return null;const core=writeAuthority?.atomic?.workspaceIntentCore;if(!core?.operational||core.operational.generation!==operationalChange.generation||core.operational.quoteChangesDigest!==describeQuoteChanges().quoteChangesDigest)throw d.fail('OPERATIONAL_CONTROL_INVALID');return{schema:1,lastWrite:{core:clone(core),writeSetDigest:writeSetDigest()}};}
 function atomicChanges(){return{changes:changed(),evidence:[...evidenceChanges.values()],capacities:[...capacityChanges.values()],scans:[...scanChanges.entries()],operational:clone(operationalChange),cashReflectionChanged:reflectionGeneration!==(metadata.cashReflectionGeneration||0)};}
 function dropCapacityDraft(id){capacityChanges.delete(id);capacityOriginal.delete(id);}
 function scanControlPayload(v){return{...v.control,...(writeAuthority?.atomic?.transient?{lastWrite:{core:clone(writeAuthority.atomic.workspaceIntentCore),writeSetDigest:writeSetDigest()}}:{})};}
 function validateQuotePreflight(){const p=getCapacity('capacity:root')?.profile;if(p)validateQuoteLimits(changed(),p);}
 function validateAtomicEncoded(){const root=getCapacity('capacity:root');for(const change of scanChanges.values())if(change.value&&Buffer.byteLength(JSON.stringify(scanControlPayload(change.value)))>root.profile.maxRowBytes)throw d.fail('CAPACITY_ENCODED_ROW_LIMIT');const changes=changed();validateEncodedLimits(changes,auditEvent(changes,writeSetDigest()));}
 const sorted=(values,id)=>values.sort((a,b)=>id(a).localeCompare(id(b)));
 function semanticIntent(){refreshOriginalExposure();return JSON.parse(JSON.stringify({
  changes:sorted(changed().map(c=>({collection:c.name,id:c.id,before:c.prior??null,after:c.value??null})),x=>x.collection+'\0'+x.id),
  evidence:sorted([...evidenceChanges.values()],x=>x.namespace+'\0'+x.id),
  capacity:sorted([...capacityChanges.values()].filter(x=>!x.id.startsWith('allowance:')).map(row=>{
   const prior=capacityOriginal.get(row.id);
   if(row.id==='capacity:root'){const delta={id:row.id,unassignedDelta:row.unassignedBytes-(prior?.unassignedBytes??row.unassignedBytes),activeSourcesDelta:row.activeSources-(prior?.activeSources??row.activeSources),activeFragmentsDelta:row.activeFragments-(prior?.activeFragments??row.activeFragments)};return delta.unassignedDelta||delta.activeSourcesDelta||delta.activeFragmentsDelta?delta:null;}
   if(!prior)return row;
   const delta={id:row.id};for(const field of new Set([...Object.keys(prior),...Object.keys(row)]))if(!['generation','remainingBytes'].includes(field)&&stable(prior[field])!==stable(row[field]))delta[field]=row[field]??null;
   return Object.keys(delta).length>1?delta:null;
  }).filter(Boolean),x=>x.id),
  scans:sorted([...scanChanges.entries()],x=>x[0]),operational:clone(operationalChange),cashReflectionGeneration:reflectionGeneration
 }));}
 function semanticIntentDigest(){return require('./stripe-transfer-persistence').digestJSON(semanticIntent());}
 function writeSetDigest(){
   refreshOriginalExposure();
   const changes=sorted(changed().map(c=>({collection:c.name,id:c.id,before:c.prior??null,after:c.value??null})),x=>x.collection+'\0'+x.id);
   const capacity=sorted([...capacityChanges.values()].map(value=>{const row=clone(value);if(row.id.startsWith('allowance:')&&row.state==='consumed')row.effect={collection:'write_set'};return row;}),x=>x.id);
   const encoded=JSON.stringify({changes,evidence:sorted([...evidenceChanges.values()],x=>x.namespace+'\0'+x.id),capacity,scans:sorted([...scanChanges.entries()],x=>x[0]),operational:clone(operationalChange),sequence:state.sequence,cashReflectionGeneration:reflectionGeneration});
   return require('./stripe-transfer-persistence').digestJSON(JSON.parse(encoded));
 }
 let writeAuthority=null;
 function authorizeWrite(authority){if(readOnly)throw d.fail('MONEY_READ_ONLY');writeAuthority=clone(authority);}
 function auditEvent(changes,writeDigest){return{...(writeAuthority?{workspaceWrite:clone(writeAuthority)}:{}),writeSetDigest:writeDigest,changes:changes.filter(c=>c.name!=='quotes').map(c=>({collection:c.name,id:c.id,before:c.prior?crypto.createHash('sha256').update(JSON.stringify(c.prior)).digest('hex'):null,after:c.value||null})),evidence:[...evidenceChanges.values()],capacity:[...capacityChanges.values()]};}
 function expireQuotes(now,{limit:requestedLimit}={}){
  const root=getCapacity('capacity:root');if(!root)return;
  const limit=requestedLimit===undefined?root.profile.maxQuoteRows:Math.min(root.profile.maxQuoteRows,requestedLimit);if(!Number.isSafeInteger(limit)||limit<0)throw d.fail('CAPACITY_OPTIONAL_QUOTE_LIMIT');
  const expired=db.prepare("SELECT q.id FROM quotes q WHERE json_extract(q.payload,'$.expiresAt')<=? AND NOT EXISTS(SELECT 1 FROM operations o WHERE json_extract(o.payload,'$.quoteId')=q.id) ORDER BY json_extract(q.payload,'$.expiresAt'),q.id LIMIT ?").all(now,limit);
  const acceptedDrafts=new Set(changed().filter(c=>c.name==='operations'&&c.value?.quoteId).map(c=>c.value.quoteId));
  const accepted=db.prepare("SELECT 1 FROM operations WHERE json_extract(payload,'$.quoteId')=? LIMIT 1");
  const candidates=new Map(expired.map(row=>[row.id,get('quotes',row.id)]));
  for(const[k,value]of cache)if(k.startsWith('quotes\0')&&value&&value.expiresAt<=now)candidates.set(value.id,value);
  let removed=0;
  for(const[id,value]of [...candidates].filter(([,value])=>value).sort((a,b)=>a[1].expiresAt-b[1].expiresAt||a[0].localeCompare(b[0]))){
   if(removed>=limit)break;
   if(value&&!acceptedDrafts.has(id)&&!accepted.get(id)){set('quotes',id,undefined);removed++;}
  }
 }
 function validateQuoteLimits(changes,p){
  const quotes=changes.filter(c=>c.name==='quotes');if(!quotes.length)return;
  if(p.grouped?.commitProtocol==='single_sql_v1'&&(metadata.database_schema!==3||p.workspace?.schema!==2))throw d.fail('QUOTE_STORAGE_UPGRADE_REQUIRED');
  if(p.workspace?.schema===2&&quotes.length>p.workspace.maxQuoteChangesPerCommit)throw d.fail('CAPACITY_OPTIONAL_QUOTE_LIMIT');
  const current=db.prepare('SELECT count(*) n,coalesce(sum(length(CAST(payload AS BLOB))),0) bytes FROM quotes').get();let count=d.safe(current.n),bytes=d.safe(current.bytes);const owners=new Map();
  const contribution=value=>value?Buffer.byteLength(JSON.stringify(value),'utf8'):0;
  for(const change of quotes){count+=Number(!!change.value)-Number(!!change.prior);bytes+=contribution(change.value)-contribution(change.prior);for(const[value,delta]of[[change.prior,-1],[change.value,1]])if(value)owners.set(value.accountId,(owners.get(value.accountId)||0)+delta);}
  if(count>p.maxQuoteRows||bytes>p.maxQuoteBytes)throw d.fail('CAPACITY_OPTIONAL_QUOTE_LIMIT');
  for(const[owner,delta]of owners){const prior=d.safe(db.prepare('SELECT count(*) n FROM quotes WHERE owner=?').get(owner).n);if(prior+delta>p.maxQuoteRowsPerOwner)throw d.fail('CAPACITY_OPTIONAL_QUOTE_LIMIT');}
 }
 function validateEncodedLimits(changes,event){
  const root=getCapacity('capacity:root');if(!root)return;
  const p=require('./money-capacity').validateCapacityProfile(root.profile,epoch);
  validateQuoteLimits(changes,p);
  const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
  const row=value=>{if(bytes(value)>p.maxRowBytes)throw d.fail('CAPACITY_ENCODED_ROW_LIMIT');};
  for(const change of changes){if(change.value===undefined)continue;const payload=clone(change.value);
   for(const field of d.EDGES[change.name]||[]){const values=payload[field];delete payload[field];if(values===undefined)continue;for(const[key,value]of(Array.isArray(values)?values.map((v,i)=>[String(i),v]):Object.entries(values)))row({collection:change.name,parent_id:change.id,field,edge_key:key,payload:value});payload['__edge_'+field]=Array.isArray(values)?'array':'object';}
   row({id:change.id,payload,...d.identity(change.name,change.value)});
  }
  for(const value of evidenceChanges.values()){
   if(value.namespace==='verified_capture'&&typeof value.payload.raw_body==='string'&&Buffer.byteLength(value.payload.raw_body,'utf8')>p.maxRawEventBytes)throw d.fail('CAPACITY_RAW_EVENT_LIMIT');
   row(value);
  }
  for(const value of capacityChanges.values())row(value);
  for(const[scopeKey,change]of scanChanges){if(change.value)row({scopeKey,...change.value});for(const value of change.rows||[])row({scopeKey,...value});}
  if(operationalChange)row({kind:'quotes',generation:operationalChange.generation,revision:state.revision+1,payload:operationalPayload()});
  if(!writeAuthority?.atomic?.transient&&bytes(event)>p.maxRowBytes)throw d.fail('CAPACITY_ENCODED_AUDIT_LIMIT');
 }
 let atomicExecuting=false;
 function commit(expectedRevision){
  if(getCapacity('capacity:root')?.profile?.grouped?.commitProtocol==='single_sql_v1'&&!atomicExecuting){if(!require('./money-atomic-router').isAtomicRouter(atomicRouter))throw d.fail('ATOMIC_ROUTER_REQUIRED');atomicExecuting=true;try{return atomicRouter.execute(api,expectedRevision,()=>commit(expectedRevision));}finally{atomicExecuting=false;}}
  if(readOnly)throw d.fail('MONEY_READ_ONLY');
  refreshOriginalExposure();
  const changes=changed(),nextTotals=totals(),writeDigest=writeSetDigest();
  for(const row of capacityChanges.values())if(row.state==='consumed'&&row.effect?.collection==='write_set'&&row.effect.digest!==writeDigest)throw d.fail('CAPACITY_WRITE_SET_CHANGED');
  const event=auditEvent(changes,writeDigest);validateEncodedLimits(changes,event);
  const root=getCapacity('capacity:root'),quota=root?.profile?.grouped?.sqlite,quotaEnabled=quota!==undefined;
  if(quotaEnabled){require('./money-sqlite-quota').validateQuota(quota);if(typeof beforeCommit!=='function')throw d.fail('WORKSPACE_PRECOMMIT_PROOF_REQUIRED');if(!writeAuthority||stable(writeAuthority.sqliteQuota)!==stable(quota))throw d.fail('CAPACITY_SQLITE_AUTHORITY_REQUIRED');describeWritePlan();}
  const physicalProof=beforeWrite?.(writeAuthority);
  fault('before-transaction');
  const write=()=>{
   const current=d.readMetadata(db);if(current.revision!==expectedRevision)throw d.fail('MONEY_REVISION_CONFLICT');
   for(const c of changes){if(c.value===undefined)d.remove(db,c.name,c.id);else d.put(db,c.name,c.id,c.value);}
   fault('after-financial-rows');
   flushEvidence();flushCapacity();flushProviderScans();
   if(operationalChange)db.prepare('UPDATE operational_controls SET generation=?,payload=?,revision=? WHERE kind=?').run(operationalChange.generation,JSON.stringify(operationalPayload()),expectedRevision+1,'quotes');
   fault('after-evidence-capacity');
   const next={...current,revision:expectedRevision+1,sequence:state.sequence,totals:nextTotals,cashReflectionGeneration:reflectionGeneration};
   d.writeMetadata(db,next);
   fault('after-metadata');
   if(!writeAuthority?.atomic?.transient&&(writeAuthority||event.changes.length||event.evidence.length||event.capacity.length))db.prepare('INSERT INTO audit_events(revision,sequence,payload) VALUES(?,?,?)').run(next.revision,next.sequence,JSON.stringify(event));
   fault('before-commit');
   return next;
  };
  const result=quotaEnabled?require('./money-sqlite-quota').runGuardedTransaction({db,quota,physicalProof,workspaceLimitBytes:root.profile.workspace?.workspaceRetainedBytes,workspaceProfile:root.profile.workspace,precommit:metrics=>beforeCommit(writeAuthority,metrics)},write):db.transaction(write).immediate();
  fault('after-commit');
  afterWrite?.({...writeAuthority,committedRevision:result.revision,writeSetDigest:writeDigest});writeAuthority=null;
  Object.assign(metadata,result);state.revision=result.revision;
  for(const[k,v]of cache)original.set(k,clone(v));
  evidenceChanges.clear();evidenceCapacity.clear();capacityChanges.clear();capacityOriginal.clear();scanChanges.clear();operationalChange=null;
  return result.revision;
 }
 function describeWritePlan(){
  const root=getCapacity('capacity:root');if(!root)throw d.fail('CAPACITY_RESERVE_REQUIRED');
  return require('./money-write-plan').describeWritePlan({epoch,changes:changed(),evidence:[...evidenceChanges.values()],capacities:[...capacityChanges.values()],scans:[...scanChanges.entries()],operational:operationalChange,cashReflectionChanged:reflectionGeneration!==(metadata.cashReflectionGeneration||0),databaseSchema:metadata.database_schema,profile:root.profile,profileDigest:root.profileDigest,
   lookup:(name,id)=>d.COLLECTIONS.includes(name)?get(name,id):getEvidence(name,id)?.payload,lookupCommitted:(name,id)=>{if(d.COLLECTIONS.includes(name))return d.get(db,name,id);const row=db.prepare('SELECT payload FROM evidence WHERE namespace=? AND id=?').get(name,id);return row?JSON.parse(row.payload):undefined;},getStagedCapacity:id=>capacityChanges.get(id),
   getCapacity:id=>{const row=db.prepare('SELECT payload FROM capacity_reservations WHERE id=?').get(id);return row?JSON.parse(row.payload):undefined;},
   indexCount:table=>d.safe(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='index' AND tbl_name=?").get(table).n),
   scanCount:(scope,generation)=>d.safe(db.prepare('SELECT count(*) n FROM provider_scan_members WHERE scope=? AND generation=?').get(scope,generation).n),
   scanHasMember:(scope,generation,id)=>!!db.prepare('SELECT 1 FROM provider_scan_members WHERE scope=? AND generation=? AND provider_id=?').get(scope,generation,id),
   scanCurrentChanges:(scope,generation)=>{const row=db.prepare('SELECT COUNT(c.provider_id) oldRows,COUNT(*) newRows FROM provider_scan_members m LEFT JOIN provider_scan_current c ON c.scope=m.scope AND c.provider_id=m.provider_id WHERE m.scope=? AND m.generation=? AND (c.provider_id IS NULL OR c.fact_id<>m.fact_id)').get(scope,generation);return{oldRows:d.safe(row.oldRows),newRows:d.safe(row.newRows)};},
   evidenceCapacity:(namespace,id)=>evidenceCapacity.get(key(namespace,id))});
 }
 function latest(name){const r=db.prepare(`SELECT id FROM ${name} INDEXED BY ${name}_sequence_id ORDER BY sequence DESC,id DESC LIMIT 1`).get();const candidates=r?[get(name,r.id)]:[];for(const[k,v]of cache)if(k.startsWith(name+'\0')&&v)candidates.push(v);return candidates.sort((a,b)=>(b.sequence||0)-(a.sequence||0))[0];}
 function counts(){return Object.fromEntries(d.COLLECTIONS.map(n=>[n,d.safe(db.prepare(`SELECT count(*) AS n FROM ${n}`).get().n)]));}
 function exportSnapshot(){const out={schema:1,epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,revision:state.revision,sequence:state.sequence,bootstrap:clone(state.bootstrap)};for(const name of d.COLLECTIONS){const ids=new Set(db.prepare(`SELECT id FROM ${name}`).all().map(x=>x.id));for(const k of cache.keys())if(k.startsWith(name+'\0'))ids.add(k.slice(name.length+1));out[name]=Object.fromEntries([...ids].map(id=>[id,get(name,id)]).filter(([,v])=>v!==undefined));}return out;}

 const api={validateQuotePreflight,getOperationalControl,describeQuoteChanges,stageOperationalControl,atomicChanges,dropCapacityDraft,validateAtomicEncoded,evidenceCapacity:(namespace,id)=>evidenceCapacity.get(key(namespace,id)),state,metadata,describeWritePlan,authorizeWrite,semanticIntent,semanticIntentDigest,get,set,rows,expireQuotes,rebaseCapacityRevision,writeSetDigest,hasCapacityChanges:()=>capacityChanges.size>0,advanceCashReflectionGeneration,cashReflectionGeneration,cashObligations,listOutstandingCashEffects,invalidateCashReflection,getCapacity,setCapacity,latest,counts,refreshOriginalExposure,relatedPools,sourceSpends,affectedPools,totals,getEvidence,recordEvidence,listEvidence,getProviderScan,getProviderCurrentFact,listProviderCurrentFacts,getProviderScanMember,listProviderScanMembers,advanceProviderScan,sealProviderScan,commit,exportSnapshot,changed,hasChanges:()=>changed().length>0||evidenceChanges.size>0||capacityChanges.size>0||scanChanges.size>0};return api;
}
module.exports={createRepository,rowPage,cursor,checkedSum};
