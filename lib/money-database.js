"use strict";
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const COLLECTIONS = ['sources','costs','spends','pools','operations','allocations','quotes','projections','provider_observations','exceptions','liquidity_evidence','lifecycle'];
const EDGES = {spends:['draws'], pools:['fragments','parties','reversals','recoveries'], operations:['allocationIds','projectionIds','providerObservations','fundedShareReversals','failedCostAllocationIds'], sources:['disputes']};
function fail(code){return Object.assign(new Error(code),{code});}
function driver(){return require('../server-runtime/node_modules/better-sqlite3');}
function safe(n){if(typeof n!=='bigint')return n;if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw fail('MONEY_OVERFLOW');return Number(n);}
function syncDirectory(dir){const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function configure(db,{readonly=false}={}){
  if(db.pragma(readonly?'journal_mode':'journal_mode = DELETE',{simple:true})!=='delete')throw fail('MONEY_SQLITE_PRAGMA');
  db.pragma('synchronous = EXTRA'); db.pragma('foreign_keys = ON'); db.pragma('cache_size = -8192');db.pragma('trusted_schema = OFF');
  if(safe(db.pragma('synchronous',{simple:true}))!==3||safe(db.pragma('foreign_keys',{simple:true}))!==1)throw fail('MONEY_SQLITE_PRAGMA');
  db.defaultSafeIntegers(true);
}
function schema(db,databaseSchema){
  if(databaseSchema===3)db.exec("CREATE TABLE operational_controls(kind TEXT PRIMARY KEY CHECK(kind='quotes'),generation INTEGER NOT NULL CHECK(generation>=0),payload TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=0)) STRICT;");
  db.exec(`CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL) STRICT;
  CREATE TABLE audit_events (revision INTEGER PRIMARY KEY, sequence INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
  CREATE TABLE money_edges(collection TEXT NOT NULL,parent_id TEXT NOT NULL,field TEXT NOT NULL,edge_key TEXT NOT NULL,payload TEXT NOT NULL,source_id TEXT,pool_id TEXT,operation_id TEXT,owner TEXT,sequence INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(collection,parent_id,field,edge_key)) WITHOUT ROWID;
  CREATE INDEX edges_numeric_order ON money_edges(collection,parent_id,field,CAST(edge_key AS INTEGER),edge_key);
  CREATE INDEX edges_source ON money_edges(source_id,sequence,parent_id);
  CREATE INDEX edges_owner ON money_edges(owner,sequence,parent_id);
  CREATE INDEX edges_pool ON money_edges(pool_id,operation_id);
  CREATE TABLE evidence(namespace TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,indexes TEXT NOT NULL,revision INTEGER NOT NULL,owner TEXT,provider_id TEXT,state TEXT,provider_account TEXT,livemode INTEGER,sequence INTEGER NOT NULL,PRIMARY KEY(namespace,id)) WITHOUT ROWID;
  CREATE INDEX evidence_sequence_id ON evidence(namespace,sequence,id);
  CREATE INDEX evidence_scope ON evidence(namespace,provider_account,livemode,state,sequence,id);
  CREATE INDEX evidence_owner ON evidence(namespace,owner,sequence,id);
  CREATE INDEX evidence_provider ON evidence(namespace,provider_id,sequence,id);
  CREATE TABLE provider_scan_controls(scope TEXT PRIMARY KEY,generation INTEGER NOT NULL,payload TEXT NOT NULL,revision INTEGER NOT NULL) STRICT;
  CREATE TABLE provider_scan_members(scope TEXT NOT NULL,generation INTEGER NOT NULL,provider_id TEXT NOT NULL,fact_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(scope,generation,provider_id)) WITHOUT ROWID;
  CREATE TABLE provider_scan_current(scope TEXT NOT NULL,provider_id TEXT NOT NULL,fact_id TEXT NOT NULL,cut_digest TEXT NOT NULL,PRIMARY KEY(scope,provider_id)) WITHOUT ROWID;
  CREATE INDEX provider_scan_members_state ON provider_scan_members(scope,generation,state,provider_id);
  CREATE TABLE cash_commitments(operation_id TEXT PRIMARY KEY,source_id TEXT,version TEXT NOT NULL,cash_micros INTEGER NOT NULL,reflected_version TEXT,state TEXT,sequence INTEGER NOT NULL) STRICT;
  CREATE INDEX cash_sequence_id ON cash_commitments(sequence,operation_id);
  CREATE INDEX cash_unresolved ON cash_commitments(reflected_version,sequence,operation_id);
  CREATE INDEX cash_state ON cash_commitments(state,sequence,operation_id);
  CREATE TABLE cash_effects(operation_id TEXT NOT NULL,effect_id TEXT NOT NULL,version TEXT NOT NULL,ack_fact_id TEXT,PRIMARY KEY(operation_id,effect_id)) WITHOUT ROWID;
  CREATE INDEX cash_effect_fact ON cash_effects(effect_id,ack_fact_id,operation_id);
  CREATE TABLE capacity_reservations(id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL,source_id TEXT,operation_id TEXT) STRICT;`);
  for(const name of COLLECTIONS){
    db.exec(`CREATE TABLE ${name}(id TEXT PRIMARY KEY,payload TEXT NOT NULL,owner TEXT,source_id TEXT,pool_id TEXT,operation_id TEXT,state TEXT,sequence INTEGER NOT NULL DEFAULT 0,request_key TEXT,provider_account TEXT,livemode INTEGER,provider_id TEXT,lot_id TEXT) STRICT;
    CREATE INDEX ${name}_sequence_id ON ${name}(sequence,id);
    CREATE INDEX ${name}_owner ON ${name}(owner,sequence,id);
    CREATE INDEX ${name}_source ON ${name}(source_id,sequence,id);
    CREATE INDEX ${name}_state ON ${name}(state,sequence,id);`);
  }
  db.exec(`CREATE UNIQUE INDEX operation_request ON operations(owner,request_key) WHERE request_key IS NOT NULL;
    CREATE UNIQUE INDEX operation_refund ON operations(provider_account,livemode,provider_id) WHERE provider_id IS NOT NULL;
    CREATE INDEX allocation_pool ON allocations(pool_id,state,sequence,id);
    CREATE INDEX projection_operation ON projections(operation_id,state,sequence,id);
    CREATE INDEX source_lot ON sources(owner,lot_id);
    CREATE INDEX source_provider ON sources(provider_account,livemode,provider_id);
    CREATE INDEX exception_operation ON exceptions(operation_id,state);
    CREATE INDEX source_payment_intent ON sources(provider_account,livemode,json_extract(payload,'$.payment_intent_id'));
    CREATE INDEX quote_expiry ON quotes(json_extract(payload,'$.expiresAt'),id);
    CREATE INDEX operation_quote ON operations(json_extract(payload,'$.quoteId'));`);
}
function identity(name,row){return {owner:row.accountId||row.owner||row.buyerId||null,source_id:row.sourceId||null,pool_id:row.poolId||null,operation_id:row.operationId||row.record?.operationId||null,state:row.state||null,sequence:row.sequence||0,request_key:row.clientRequestKey||null,provider_account:row.platform_account_id||null,livemode:typeof row.livemode==='boolean'?Number(row.livemode):null,provider_id:name==='sources'?(row.charge_id||null):(row.refund_id||null),lot_id:row.provenance?.lot_id||null};}
function cashEffectIds(row){return row.cashEffectIds?.length?row.cashEffectIds:row.cashEffectId?[row.cashEffectId]:[];}
function cashVersion(row){return crypto.createHash('sha256').update(JSON.stringify([row.cashReservedMicros||0,cashEffectIds(row)])).digest('hex');}
function put(db,name,id,row){
  if(!COLLECTIONS.includes(name)||typeof id!=='string')throw fail('MONEY_COLLECTION_INVALID');
  const payload=structuredClone(row), columns=identity(name,row);
  for(const field of EDGES[name]||[]){
    const values=payload[field];delete payload[field];
    db.prepare('DELETE FROM money_edges WHERE collection=? AND parent_id=? AND field=?').run(name,id,field);
    if(values===undefined)continue;
    const entries=Array.isArray(values)?values.map((v,i)=>[String(i),v]):Object.entries(values);
    for(const [key,value] of entries){db.prepare('INSERT INTO money_edges(collection,parent_id,field,edge_key,payload,source_id,pool_id,operation_id,owner,sequence) VALUES(?,?,?,?,?,?,?,?,?,?)').run(name,id,field,key,JSON.stringify(value),value?.sourceId||null,name==='pools'?id:(value?.poolId||null),value?.operationId||null,field==='parties'?value:null,row.sequence||0);}
    payload['__edge_'+field]=Array.isArray(values)?'array':'object';
  }
  if(name==='operations'){const version=cashVersion(row);db.prepare('INSERT INTO cash_commitments(operation_id,source_id,version,cash_micros,reflected_version,state,sequence) VALUES(?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET source_id=excluded.source_id,version=excluded.version,cash_micros=excluded.cash_micros,reflected_version=excluded.reflected_version,state=excluded.state,sequence=excluded.sequence').run(id,row.sourceId||null,version,row.cashReservedMicros||0,row.cashReflectionVersion||null,row.state||null,row.sequence||0);db.prepare('DELETE FROM cash_effects WHERE operation_id=?').run(id);for(const effectId of cashEffectIds(row))db.prepare('INSERT INTO cash_effects(operation_id,effect_id,version,ack_fact_id) VALUES(?,?,?,?)').run(id,effectId,version,row.cashReflectionFacts?.[effectId]||null);}
  const keys=Object.keys(columns);db.prepare(`INSERT INTO ${name}(id,payload,${keys.join(',')}) VALUES(?,?,${keys.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,${keys.map(k=>`${k}=excluded.${k}`).join(',')}`).run(id,JSON.stringify(payload),...keys.map(k=>columns[k]));
}
// Static read statements live only as long as their database handle. Payloads are
// never cached: point reads and every validation pass see the current exact row.
const readStatements=new WeakMap();
function readStatement(db,sql){let cache=readStatements.get(db);if(!cache){cache=new Map();readStatements.set(db,cache);}let statement=cache.get(sql);if(!statement){statement=db.prepare(sql);cache.set(sql,statement);}return statement;}
function decodeRecord(db,name,r){
  if(!r)return undefined;
  const v=JSON.parse(r.payload);
  for(const field of EDGES[name]||[]){const marker=v['__edge_'+field];delete v['__edge_'+field];if(!marker)continue;const es=readStatement(db,'SELECT edge_key,payload FROM money_edges INDEXED BY edges_numeric_order WHERE collection=? AND parent_id=? AND field=? ORDER BY CAST(edge_key AS INTEGER),edge_key').all(name,r.id,field);v[field]=marker==='array'?es.map(x=>JSON.parse(x.payload)):Object.fromEntries(es.map(x=>[x.edge_key,JSON.parse(x.payload)]));}
  const expected=identity(name,v);for(const [k,value] of Object.entries(expected))if(safe(r[k])!==value)throw fail('MONEY_INDEX_PAYLOAD_CONFLICT');return v;
}
function get(db,name,id){
  if(!COLLECTIONS.includes(name))throw fail('MONEY_COLLECTION_INVALID');
  return decodeRecord(db,name,readStatement(db,`SELECT * FROM ${name} WHERE id=?`).get(id));
}
function remove(db,name,id){if(name==='operations'){db.prepare('DELETE FROM cash_commitments WHERE operation_id=?').run(id);db.prepare('DELETE FROM cash_effects WHERE operation_id=?').run(id);}db.prepare(`DELETE FROM ${name} WHERE id=?`).run(id);db.prepare('DELETE FROM money_edges WHERE collection=? AND parent_id=?').run(name,id);}
function readMetadata(db){const row=db.prepare('SELECT payload FROM metadata WHERE id=1').get();if(!row)throw fail('MONEY_METADATA_MISSING');return JSON.parse(row.payload);}
function writeMetadata(db,value){db.prepare('INSERT INTO metadata(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(value));}
function createMoneyDatabase({file,epoch,snapshot,evidenceSeeds=[],auditSeeds=[],capacitySeeds=[],providerScanSeeds={controls:[],members:[],current:[]},metadataSeed={},databaseId,databaseSchema=3,operationalSeeds}){
  if(![2,3].includes(databaseSchema))throw fail('MONEY_DATABASE_SCHEMA_UNSUPPORTED');
  if(databaseSchema===2&&operationalSeeds?.length)throw fail('OPERATIONAL_CONTROL_INVALID');
  if(!epoch?.epoch_id||!epoch.binding_digest)throw fail('MONEY_EPOCH_REQUIRED');
  const dir=fs.realpathSync(path.dirname(file));if(dir!==path.resolve(path.dirname(file)))throw fail('MONEY_PATH_INVALID');
  const fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY,0o600);fs.closeSync(fd);
  const Database=driver();let db;
  const descriptor={schema:2,epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,database_id:databaseId||crypto.randomUUID(),database_file:'money-control.sqlite',database_schema:databaseSchema,bootstrap:{id:'bootstrap:'+epoch.epoch_id}};
  try{db=new Database(file,{fileMustExist:true});configure(db);schema(db,databaseSchema);
    const s=snapshot||{schema:1,epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,revision:0,sequence:0,bootstrap:descriptor.bootstrap,...Object.fromEntries(COLLECTIONS.map(n=>[n,{}]))};
    db.transaction(()=>{for(const name of COLLECTIONS)for(const [id,row]of Object.entries(s[name]||{}))put(db,name,id,row);writeMetadata(db,{...metadataSeed,...descriptor,revision:s.revision,sequence:s.sequence,totals:{localLiabilityMicros:Object.values(s.sources||{}).reduce((n,x)=>n+x.amountMicros-x.spentMicros-x.retiredMicros,0)+Object.values(s.pools||{}).reduce((n,p)=>n+p.contributorShareMicros-(p.contributorReversedMicros||0),0),exposureMicros:Object.values(s.pools||{}).reduce((n,p)=>n+(p.exposureMicros||0),0)+Object.values(s.sources||{}).reduce((n,x)=>n+(x.originalExposureMicros||0),0)+Object.values(s.operations||{}).reduce((n,o)=>n+(o.failedCostExposureMicros||0),0)},diagnostic_schema:1});}).immediate();
    for(const row of evidenceSeeds){const i=row.indexes||{};db.prepare('INSERT INTO evidence(namespace,id,payload,indexes,revision,owner,provider_id,state,provider_account,livemode,sequence) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(row.namespace,row.id,JSON.stringify(row.payload),JSON.stringify(i),row.revision||1,i.accountId||null,i.providerId||null,i.state||null,i.platform_account_id||null,i.livemode===undefined?null:Number(i.livemode),i.sequence||0);}
    db.transaction(()=>{
      if(databaseSchema===3)for(const row of operationalSeeds===undefined?[{kind:'quotes',generation:0,revision:s.revision,payload:{schema:1,lastWrite:null}}]:operationalSeeds)db.prepare('INSERT INTO operational_controls(kind,generation,payload,revision) VALUES(?,?,?,?)').run(row.kind,row.generation,JSON.stringify(row.payload),row.revision);
      for(const row of auditSeeds){if(!Number.isSafeInteger(row.revision)||row.revision<1||row.revision>s.revision||!Number.isSafeInteger(row.sequence)||row.sequence>s.sequence)throw fail('MONEY_AUDIT_SEED_INVALID');db.prepare('INSERT INTO audit_events(revision,sequence,payload) VALUES(?,?,?)').run(row.revision,row.sequence,JSON.stringify(row.payload));}
      for(const row of providerScanSeeds.controls||[])db.prepare('INSERT INTO provider_scan_controls(scope,generation,payload,revision) VALUES(?,?,?,?)').run(row.scope,row.generation,JSON.stringify(row.payload),row.revision);
      for(const row of providerScanSeeds.members||[])db.prepare('INSERT INTO provider_scan_members(scope,generation,provider_id,fact_id,state) VALUES(?,?,?,?,?)').run(row.scope,row.generation,row.provider_id,row.fact_id,row.state);
      for(const row of providerScanSeeds.current||[])db.prepare('INSERT INTO provider_scan_current(scope,provider_id,fact_id,cut_digest) VALUES(?,?,?,?)').run(row.scope,row.provider_id,row.fact_id,row.cut_digest);
      for(const row of capacitySeeds){if(typeof row.id!=='string'||!row.payload||typeof row.state!=='string')throw fail('MONEY_CAPACITY_SEED_INVALID');db.prepare('INSERT INTO capacity_reservations(id,payload,state,source_id,operation_id) VALUES(?,?,?,?,?)').run(row.id,JSON.stringify(row.payload),row.state,row.source_id||null,row.operation_id||null);}
    }).immediate();
    validateOperationalControls(db);
    db.close();db=null;const f=fs.openSync(file,'r');try{fs.fsyncSync(f);}finally{fs.closeSync(f);}syncDirectory(dir);return descriptor;
  }catch(error){if(db)db.close();throw error;}
}
function openDatabase(file,descriptor,{readonly=false}={}){
  if(![2,3].includes(descriptor?.database_schema))throw fail('MONEY_DATABASE_SCHEMA_UNSUPPORTED');
  const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink())throw fail('MONEY_PATH_INVALID');
  const Database=driver(),db=new Database(file,{fileMustExist:true,readonly});try{configure(db,{readonly});const m=readMetadata(db);for(const k of ['epoch_id','binding_digest','database_id','database_schema'])if(m[k]!==descriptor[k])throw fail('MONEY_DATABASE_IDENTITY_CONFLICT');return {db,inode:st.ino,dev:st.dev};}catch(e){db.close();throw e;}
}
module.exports={COLLECTIONS,EDGES,identity,cashVersion,cashEffectIds,createMoneyDatabase,openDatabase,readMetadata,writeMetadata,get,put,remove,safe,fail,syncDirectory};

function exportMoneyDatabase({file,epoch,descriptor}){const opened=openDatabase(file,descriptor,{readonly:true});try{return require('./money-repository').createRepository({db:opened.db,epoch,readOnly:true}).exportSnapshot();}finally{opened.db.close();}}
function validateMoneyDatabase({file,epoch,descriptor,writer,inspect}){if(writer){if(!epoch.legacy_root||path.resolve(file)!==path.join(epoch.financial_dir,'money-control.sqlite'))throw fail('MONEY_RECOVERY_ROOT_REQUIRED');require('./money-writer-lock').assertMoneyWriter(writer,{root:epoch.legacy_root});}const opened=openDatabase(file,descriptor,{readonly:!writer});try{const result=validateDatabaseHandle(opened.db,epoch,{full:true});inspect?.(result.reader);return {metadata:result.metadata};}finally{opened.db.close();}}
module.exports.exportMoneyDatabase=exportMoneyDatabase;module.exports.validateMoneyDatabase=validateMoneyDatabase;

// Explicit offline successor/checkpoint export, never a request-time query.
function exportDatabaseAuxiliary(db) {
  return {
    databaseSchema:readMetadata(db).database_schema,
    operationalSeeds:readMetadata(db).database_schema===3?db.prepare('SELECT * FROM operational_controls ORDER BY kind').all().map(row=>({...row,generation:safe(row.generation),revision:safe(row.revision),payload:JSON.parse(row.payload)})):[],
    metadataSeed:readMetadata(db),
    providerScanSeeds:{controls:db.prepare('SELECT * FROM provider_scan_controls').all().map(r=>({...r,generation:safe(r.generation),revision:safe(r.revision),payload:JSON.parse(r.payload)})),members:db.prepare('SELECT * FROM provider_scan_members').all().map(r=>({...r,generation:safe(r.generation)})),current:db.prepare('SELECT * FROM provider_scan_current').all()},
    evidenceSeeds:db.prepare('SELECT namespace,id,payload,indexes,revision FROM evidence ORDER BY namespace,id').all().map(r=>({namespace:r.namespace,id:r.id,payload:JSON.parse(r.payload),indexes:JSON.parse(r.indexes),revision:safe(r.revision)})),
    auditSeeds:db.prepare('SELECT revision,sequence,payload FROM audit_events ORDER BY revision').all().map(r=>({revision:safe(r.revision),sequence:safe(r.sequence),payload:JSON.parse(r.payload)})),
    capacitySeeds:db.prepare('SELECT * FROM capacity_reservations ORDER BY id').all().map(r=>({...r,payload:JSON.parse(r.payload)}))
  };
}
module.exports.exportDatabaseAuxiliary=exportDatabaseAuxiliary;
const validatedReaders = new WeakMap();
function assertValidatedReader(reader,epoch) {
  const proof=validatedReaders.get(reader);
  if(!proof||proof.epoch_id!==epoch.epoch_id||proof.binding_digest!==epoch.binding_digest||proof.financial_dir!==epoch.financial_dir||proof.legacy_root!==epoch.legacy_root)throw fail('MONEY_VALIDATED_READER_REQUIRED');
  const now=reader.readCurrentMetadata();
  if(now.database_id!==proof.database_id||now.epoch_id!==proof.epoch_id||now.binding_digest!==proof.binding_digest||now.revision!==proof.revision)throw fail('MONEY_VALIDATED_CUT_CHANGED');
  return true;
}
module.exports.assertValidatedReader=assertValidatedReader;
function createValidationReader(db,epoch) {
  const metadata=readMetadata(db), names=new WeakMap();
  const state={schema:1,epoch_id:metadata.epoch_id,binding_digest:metadata.binding_digest,revision:metadata.revision,sequence:metadata.sequence,bootstrap:metadata.bootstrap};
  for(const name of COLLECTIONS){const records=new Proxy({}, {get(_,id){return typeof id==='string'?get(db,name,id):undefined;},ownKeys(){throw fail('MONEY_FULL_SNAPSHOT_FORBIDDEN');}});names.set(records,name);state[name]=records;}
  function* entries(records){const name=names.get(records);if(!name){yield*Object.entries(records);return;}for(const row of readStatement(db,`SELECT * FROM ${name} ORDER BY id`).iterate())yield [row.id,decodeRecord(db,name,row)];}
  function* values(records){for(const[,value]of entries(records))yield value;}
  return Object.freeze({state:Object.freeze(state),metadata:Object.freeze(metadata),entries,values,
    readCurrentMetadata:()=>readMetadata(db),
    getCapacityRecord:id=>{const row=readStatement(db,'SELECT payload FROM capacity_reservations WHERE id=?').get(id);return row?JSON.parse(row.payload):undefined;},
    getAppliedEffect:({participant,owner,id})=>{const key=require('./money-control-store').appliedEffectId({epoch,participant,owner,id}),row=readStatement(db,"SELECT payload FROM evidence WHERE namespace='applied_effects' AND id=?").get(key);return row?JSON.parse(row.payload):undefined;}
  });
}
function validateDatabaseHandle(db,epoch,{full=true}={}) {
  if(db.pragma(full?'integrity_check':'quick_check').some(r=>Object.values(r)[0]!=='ok')||db.pragma('foreign_key_check').length)throw fail('MONEY_DATABASE_CORRUPT');
  validateOperationalControls(db);
  const reader=createValidationReader(db,epoch);
  if(full){
    require('./money-control-store').validateRecords(reader.state,epoch,reader);
    validateCashReflections(db,epoch);
    require('./money-capacity').validateCapacityAccounting(db,epoch);
    let liability=0n,exposure=0n;
    for(const source of reader.values(reader.state.sources)){liability+=BigInt(source.amountMicros)-BigInt(source.spentMicros)-BigInt(source.retiredMicros);exposure+=BigInt(source.originalExposureMicros||0);}
    for(const pool of reader.values(reader.state.pools)){liability+=BigInt(pool.contributorShareMicros)-BigInt(pool.contributorReversedMicros||0);exposure+=BigInt(pool.exposureMicros||0);}
    for(const operation of reader.values(reader.state.operations))exposure+=BigInt(operation.failedCostExposureMicros||0);
    if(liability<0n||exposure<0n||safe(liability)!==reader.metadata.totals.localLiabilityMicros||safe(exposure)!==reader.metadata.totals.exposureMicros)throw fail('MONEY_TOTAL_CONSERVATION');
  }
  if(full)validatedReaders.set(reader,{epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,financial_dir:epoch.financial_dir,legacy_root:epoch.legacy_root,database_id:reader.metadata.database_id,revision:reader.metadata.revision});
  return {metadata:reader.metadata,reader};
}
function withMoneyDatabaseReader({file,epoch,descriptor},fn){const opened=openDatabase(file,descriptor,{readonly:true});try{const result=validateDatabaseHandle(opened.db,epoch,{full:true});return fn(result.reader);}finally{opened.db.close();}}
module.exports.createValidationReader=createValidationReader;
module.exports.validateDatabaseHandle=validateDatabaseHandle;
module.exports.withMoneyDatabaseReader=withMoneyDatabaseReader;

// Offline/maintenance verification: indexes never grant cash release authority.
function validateCashReflections(db,epoch){
 const stamp=v=>v&&['epoch_id','binding_digest','platform_account_id','livemode'].every(k=>v[k]===epoch[k]);
 const digest=require('./money-control-store').digest,scope='stripe:'+epoch.platform_account_id+':'+(epoch.livemode?'live':'test');
 const evidence=db.prepare('SELECT payload FROM evidence WHERE namespace=? AND id=?');
 const read=(namespace,id)=>{const row=evidence.get(namespace,id);return row?JSON.parse(row.payload):undefined;};
 let previous=null,lastGeneration=0,lastComplete=0;
 for(const row of db.prepare("SELECT payload FROM evidence INDEXED BY evidence_sequence_id WHERE namespace='provider_effects' AND id LIKE ? ORDER BY sequence,id").iterate(scope+':%:seal')){
  const seal=JSON.parse(row.payload),{epoch_id,binding_digest,platform_account_id,livemode,scopeKey,generation,cutDigest,...body}=seal;
  if(!stamp(seal)||scopeKey!==scope||!Number.isSafeInteger(generation)||generation<=lastGeneration||body.previousCutDigest!==previous||digest(body)!==cutDigest)throw fail('CASH_CUT_LINEAGE_INVALID');
  lastGeneration=generation;previous=cutDigest;if(seal.complete)lastComplete=generation;
 }
 const control=read('provider_inventory',scope+':control');
 if(lastGeneration&&(!stamp(control)||control.generation!==lastGeneration||control.cutDigest!==previous))throw fail('CASH_CUT_LINEAGE_INVALID');
 const cash=db.prepare('SELECT * FROM cash_commitments WHERE operation_id=?'),effects=db.prepare('SELECT effect_id,version,ack_fact_id FROM cash_effects WHERE operation_id=? ORDER BY effect_id'),current=db.prepare('SELECT fact_id FROM provider_scan_current WHERE scope=? AND provider_id=?');
 let operations=0,maxAcknowledgedGeneration=0;
 for(const row of db.prepare('SELECT id FROM operations ORDER BY id').iterate()){
  operations++;const o=get(db,'operations',row.id),v=cashVersion(o),index=cash.get(o.id),ids=cashEffectIds(o);
  if(!index||index.version!==v||safe(index.cash_micros)!==(o.cashReservedMicros||0)||index.reflected_version!==(o.cashReflectionVersion||null)||index.source_id!==(o.sourceId||null)||index.state!==(o.state||null)||safe(index.sequence)!==(o.sequence||0))throw fail('CASH_INDEX_CONSERVATION');
  const indexed=effects.all(o.id);if(indexed.length!==ids.length||indexed.some(e=>!ids.includes(e.effect_id)||e.version!==v||e.ack_fact_id!==(o.cashReflectionFacts?.[e.effect_id]||null)))throw fail('CASH_INDEX_CONSERVATION');
  if(o.cashReflectionVersion!==v)continue;
  const proof=read('cash_reflections',o.cashReflectionProofId),seal=proof&&read('provider_effects',scope+':'+proof.generation+':seal');
  if(!stamp(proof)||proof.operationId!==o.id||proof.sourceId!==o.sourceId||proof.accountId!==o.accountId||proof.currency!==o.currency||proof.obligationVersion!==v||proof.cashReservedMicros!==o.cashReservedMicros||proof.scopeKey!==scope||proof.generation>lastComplete||!seal?.complete||seal.cutDigest!==proof.cutDigest||seal.balanceDigest!==proof.balanceCutDigest||digest(proof)!==o.cashReflectionProofId||digest(proof.effectIds)!==digest(ids)||digest(proof.facts)!==digest(o.cashReflectionFacts))throw fail('CASH_REFLECTION_PROOF_REQUIRED');
  let net=0n;for(const id of ids){const fact=read('provider_effects',proof.facts[id]),now=current.get(scope,id);if(!stamp(fact)||!now||now.fact_id!==proof.facts[id]||fact.id!==id||fact.source!==o.refund_id||fact.currency!==o.currency||fact.status!=='available'||!Number.isSafeInteger(fact.net)||!Number.isSafeInteger(fact.fee)||!Number.isSafeInteger(fact.amount)||fact.net!==fact.amount-fact.fee)throw fail('CASH_REFLECTION_FACT_CHANGED');net+=BigInt(fact.net)*10000n;}
  if(-net!==BigInt(o.cashReservedMicros))throw fail('CASH_REFLECTION_AMOUNT_CHANGED');maxAcknowledgedGeneration=Math.max(maxAcknowledgedGeneration,proof.generation);
 }
 if(safe(db.prepare('SELECT count(*) AS n FROM cash_commitments').get().n)!==operations||db.prepare('SELECT 1 FROM cash_effects e LEFT JOIN operations o ON o.id=e.operation_id WHERE o.id IS NULL LIMIT 1').get())throw fail('CASH_INDEX_CONSERVATION');
 if((readMetadata(db).cashReflectionGeneration||0)<maxAcknowledgedGeneration)throw fail('CASH_CUT_OLDER_THAN_REFLECTION');
 return{operations,lastGeneration,maxAcknowledgedGeneration};
}
module.exports.validateCashReflections=validateCashReflections;

// DBSTAT aggregate mode counts each selected btree and its overflow pages once.
// The caller supplies exact validated schema names; duplicates cannot add claims.
function workspaceTreeBytes(db,names){
  if(!Array.isArray(names)||new Set(names).size!==names.length||names.some(name=>typeof name!=='string'||!name))throw fail('WORKSPACE_SCHEMA_UNRECOGNIZED');
  const read=db.prepare('SELECT pgsize,pagetype FROM dbstat WHERE name=? AND aggregate=1');let total=0n;
  for(const name of names){const rows=read.all(name);if(rows.length!==1||rows[0].pagetype==='corrupted')throw fail('WORKSPACE_DBSTAT_REQUIRED');const n=BigInt(rows[0].pgsize);if(n<=0n)throw fail('WORKSPACE_DBSTAT_REQUIRED');total+=n;}
  return safe(total);
}
module.exports.workspaceTreeBytes=workspaceTreeBytes;

function validateOperationalControls(db){
 const m=readMetadata(db);if(![2,3].includes(m.database_schema))throw fail('MONEY_DATABASE_SCHEMA_UNSUPPORTED');if(m.database_schema===2)return;
 const rows=db.prepare('SELECT * FROM operational_controls').all();if(rows.length!==1)throw fail('OPERATIONAL_CONTROL_INVALID');
 const row=rows[0],p=JSON.parse(row.payload),g=safe(row.generation),revision=safe(row.revision),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
 if(row.kind!=='quotes'||!Number.isSafeInteger(g)||g<0||!Number.isSafeInteger(revision)||revision<0||revision>m.revision||!p||p.schema!==1||Object.keys(p).sort().join(',')!=='lastWrite,schema')throw fail('OPERATIONAL_CONTROL_INVALID');
 if(g===0){if(p.lastWrite!==null)throw fail('OPERATIONAL_CONTROL_INVALID');return;}
 const last=p.lastWrite,c=last?.core,o=c?.operational;
 if(!last||Object.keys(last).sort().join(',')!=='core,writeSetDigest'||c?.schema!==2||c.protocol!=='single_sql_v1'||c.workspace||o?.kind!=='quotes'||o.generation!==g||!hex(o.quoteChangesDigest)||!Number.isSafeInteger(o.boundBytes)||o.boundBytes<4096||o.boundBytes%4096||c.finalRevision!==revision||c.priorRevision+1!==revision||last.writeSetDigest!==c.fullWriteSetDigest||['groupId','semanticIntentDigest','groupPlanDigest','fullWriteSetDigest','priorRootDigest','nextRootDigest'].some(k=>!hex(c[k])))throw fail('OPERATIONAL_CONTROL_INVALID');
 if(c.transient===true&&(c.priorRootDigest!==c.nextRootDigest||c.completionBeforeBytes!==c.completionAfterBytes))throw fail('OPERATIONAL_CONTROL_INVALID');
 if(c.transient!==true){const audit=db.prepare('SELECT payload FROM audit_events WHERE revision=?').get(revision),event=audit&&JSON.parse(audit.payload);if(event?.writeSetDigest!==last.writeSetDigest||event.workspaceWrite?.atomic?.groupId!==c.groupId)throw fail('OPERATIONAL_CONTROL_INVALID');}
}
module.exports.validateOperationalControls=validateOperationalControls;

// Offline restore preservation: stream exact typed SQL bytes, not reconstructed
// financial objects. Root payload and metadata have separately scoped digests.
function readAtomicRestoreDigests(db){
 const core=require('./money-atomic-restore-core'),hash=crypto.createHash('sha256'),scan=crypto.createHash('sha256');
 const feed=(h,v)=>{const text=JSON.stringify(v,(_,x)=>typeof x==='bigint'?{sqliteInteger:x.toString()}:x);h.update(String(Buffer.byteLength(text))+':'+text);};
 const schemaRows=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all().sort((a,b)=>a.name.localeCompare(b.name));feed(hash,schemaRows);
 for(const table of schemaRows.filter(r=>r.type==='table')){
  if(!/^[a-z_]+$/.test(table.name))throw fail('ATOMIC_RESTORE_SCHEMA_INVALID');
  if(table.name==='metadata')continue;
  const columns=db.prepare('PRAGMA table_info("'+table.name+'")').all(),primary=columns.filter(c=>safe(c.pk)>0).sort((a,b)=>safe(a.pk)-safe(b.pk)).map(c=>'"'+c.name+'"'),order=primary.length?primary.join(','):'rowid';
  feed(hash,table.name);const isScan=table.name.startsWith('provider_scan_');if(isScan)feed(scan,table.name);
  for(const row of db.prepare('SELECT * FROM "'+table.name+'" ORDER BY '+order).iterate()){
   // Root index columns are immutable even though its payload may be rebound.
   const value=table.name==='capacity_reservations'&&row.id==='capacity:root'?{...row,payload:'<restore-root-payload>'}:row;
   feed(hash,value);if(isScan)feed(scan,row);
  }
 }
 const metadata=readMetadata(db),r=db.prepare("SELECT payload FROM capacity_reservations WHERE id='capacity:root'").get(),root=r?JSON.parse(r.payload):null;
 const quote=metadata.database_schema===3?db.prepare("SELECT * FROM operational_controls WHERE kind='quotes'").get():null;
 const quoteControl=quote?{kind:quote.kind,generation:safe(quote.generation),payload:JSON.parse(quote.payload),revision:safe(quote.revision)}:null;
 return{financialStateDigest:hash.digest('hex'),scanStateDigest:scan.digest('hex'),metadataIdentityDigest:core.digest(core.metadataIdentityProjection(metadata)),rootEconomicDigest:core.digest(root?core.rootEconomicProjection(root):null),quoteControlDigest:core.digest(quoteControl)};
}
module.exports.readAtomicRestoreDigests=readAtomicRestoreDigests;
