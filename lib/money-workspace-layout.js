'use strict';
const database=require('./money-database');
const {fail,safe}=database;
const BASE=['workspaceRetainedBytes','workspaceScratchBytes','maxWorkspaceMembers','maxConcurrentScans'];
function validateWorkspaceProfile(p){
 if(!p||typeof p!=='object')throw fail('WORKSPACE_PROFILE_REQUIRED');
 const descriptors=Object.getOwnPropertyDescriptors(p),schema=descriptors.schema;
 if(schema&&(!schema.enumerable||!Object.hasOwn(schema,'value')))throw fail('WORKSPACE_PROFILE_INVALID');
 if(schema&&![1,2].includes(schema.value))throw fail('WORKSPACE_PROFILE_INVALID');
 if(schema?.value===2){
  const keys=['schema',...BASE,'scanRetainedBytes','quoteRetainedBytes','controlRetainedBytes','maxQuoteChangesPerCommit'];
  if(Reflect.ownKeys(p).length!==keys.length||keys.some(k=>!descriptors[k]?.enumerable||!Object.hasOwn(descriptors[k],'value')))throw fail('WORKSPACE_PROFILE_INVALID');
  for(const k of keys.filter(k=>k!=='schema'))if(!Number.isSafeInteger(descriptors[k].value)||descriptors[k].value<=0)throw fail('WORKSPACE_PROFILE_INVALID');
  for(const k of ['workspaceRetainedBytes','workspaceScratchBytes','scanRetainedBytes','quoteRetainedBytes','controlRetainedBytes'])if(p[k]%4096)throw fail('WORKSPACE_PROFILE_INVALID');
  if(p.maxConcurrentScans>64||p.maxQuoteChangesPerCommit<2||BigInt(p.workspaceRetainedBytes)!==BigInt(p.scanRetainedBytes)+BigInt(p.quoteRetainedBytes)+BigInt(p.controlRetainedBytes))throw fail('WORKSPACE_PROFILE_INVALID');
 }else{
  for(const k of BASE)if(!Number.isSafeInteger(p[k])||p[k]<=0)throw fail('WORKSPACE_PROFILE_REQUIRED');
  if(p.workspaceRetainedBytes%4096||p.workspaceScratchBytes%4096||p.maxConcurrentScans>64)throw fail('WORKSPACE_PROFILE_INVALID');
 }
 return p;
}
function validateWorkspacePartitions(p,m){
 validateWorkspaceProfile(p);
 if(p.schema!==2)return;
 const classes=m.workspaceClassBytes;
 if(m.workspaceLayoutVersion!==2||!classes||Object.keys(classes).sort().join(',')!=='control,quotes,scan')throw fail('WORKSPACE_METRICS_INVALID');
 let total=0n;
 for(const [name,key]of [['scan','scanRetainedBytes'],['quotes','quoteRetainedBytes'],['control','controlRetainedBytes']]){
  const value=classes[name];if(!Number.isSafeInteger(value)||value<0||!Number.isSafeInteger(m.pageSize)||m.pageSize<=0||value%m.pageSize)throw fail('WORKSPACE_METRICS_INVALID');
  if(value>p[key])throw fail('WORKSPACE_PARTITION_LIMIT');total+=BigInt(value);
 }
 if(safe(total)!==m.workspaceAllocatedBytes)throw fail('WORKSPACE_METRICS_INVALID');
}
const COLUMNS={provider_scan_controls:['scope','generation','payload','revision'],provider_scan_members:['scope','generation','provider_id','fact_id','state'],quotes:['id','payload','owner','source_id','pool_id','operation_id','state','sequence','request_key','provider_account','livemode','provider_id','lot_id'],metadata:['id','payload'],operational_controls:['kind','generation','payload','revision']};
const INDEXES={provider_scan_controls:{sqlite_autoindex_provider_scan_controls_1:null},provider_scan_members:{provider_scan_members_state:'CREATE INDEX provider_scan_members_state ON provider_scan_members(scope,generation,state,provider_id)'},quotes:{sqlite_autoindex_quotes_1:null,quotes_sequence_id:'CREATE INDEX quotes_sequence_id ON quotes(sequence,id)',quotes_owner:'CREATE INDEX quotes_owner ON quotes(owner,sequence,id)',quotes_source:'CREATE INDEX quotes_source ON quotes(source_id,sequence,id)',quotes_state:'CREATE INDEX quotes_state ON quotes(state,sequence,id)',quote_expiry:"CREATE INDEX quote_expiry ON quotes(json_extract(payload,'$.expiresAt'),id)"},metadata:{},operational_controls:{sqlite_autoindex_operational_controls_1:null}};
const TABLE_SQL={
 provider_scan_controls:'CREATE TABLE provider_scan_controls(scope TEXT PRIMARY KEY,generation INTEGER NOT NULL,payload TEXT NOT NULL,revision INTEGER NOT NULL) STRICT',
 provider_scan_members:'CREATE TABLE provider_scan_members(scope TEXT NOT NULL,generation INTEGER NOT NULL,provider_id TEXT NOT NULL,fact_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(scope,generation,provider_id)) WITHOUT ROWID',
 quotes:'CREATE TABLE quotes(id TEXT PRIMARY KEY,payload TEXT NOT NULL,owner TEXT,source_id TEXT,pool_id TEXT,operation_id TEXT,state TEXT,sequence INTEGER NOT NULL DEFAULT 0,request_key TEXT,provider_account TEXT,livemode INTEGER,provider_id TEXT,lot_id TEXT) STRICT',
 metadata:'CREATE TABLE metadata(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL) STRICT',
 operational_controls:"CREATE TABLE operational_controls(kind TEXT PRIMARY KEY CHECK(kind='quotes'),generation INTEGER NOT NULL CHECK(generation>=0),payload TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=0)) STRICT"
};
// Normalize formatting only; SQL string literals remain byte-for-byte significant.
const normalize=sql=>sql===null?null:sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\s+/g,token=>/^\s/.test(token)?'':token).replace(/;$/,'');
function readWorkspaceLayout(db,{layoutVersion=1}={}){
 if(![1,2].includes(layoutVersion))throw fail('WORKSPACE_SCHEMA_UNRECOGNIZED');
 if(layoutVersion===2&&database.readMetadata(db).database_schema!==3)throw fail('QUOTE_STORAGE_UPGRADE_REQUIRED');
 const groups={scan:['provider_scan_controls','provider_scan_members'],quotes:layoutVersion===2?['quotes']:[],control:layoutVersion===2?['metadata','operational_controls']:[]},workspaceClassBytes={scan:0,quotes:0,control:0};
 const workspaceTables=Object.values(groups).flat();
 for(const [kind,tables]of Object.entries(groups)){
  const names=[];
  for(const table of tables){
   const rows=db.prepare('SELECT type,name,sql FROM sqlite_schema WHERE tbl_name=?').all(table),expected=[table,...Object.keys(INDEXES[table])];
   if(rows.length!==expected.length||rows.some(r=>!expected.includes(r.name)||(r.name===table?r.type!=='table':r.type!=='index')))throw fail('WORKSPACE_SCHEMA_UNRECOGNIZED');
   if(db.prepare('PRAGMA table_xinfo('+table+')').all().map(r=>r.name).join(',')!==COLUMNS[table].join(','))throw fail('WORKSPACE_SCHEMA_UNRECOGNIZED');
   if(layoutVersion===2&&normalize(rows.find(r=>r.name===table).sql)!==normalize(TABLE_SQL[table]))throw fail('WORKSPACE_SCHEMA_UNRECOGNIZED');
   for(const row of rows)if(row.name!==table&&normalize(row.sql)!==normalize(INDEXES[table][row.name]))throw fail('WORKSPACE_SCHEMA_UNRECOGNIZED');
   names.push(...expected);
  }
  try{workspaceClassBytes[kind]=names.length?database.workspaceTreeBytes(db,names):0;}catch(error){throw Object.assign(fail('WORKSPACE_DBSTAT_REQUIRED'),{cause:error});}
 }
 return{workspaceAllocatedBytes:safe(Object.values(workspaceClassBytes).reduce((sum,value)=>sum+BigInt(value),0n)),workspaceClassBytes,workspaceLayoutVersion:layoutVersion,workspaceSchemaVerified:true,workspaceTables};
}
module.exports={validateWorkspaceProfile,validateWorkspacePartitions,readWorkspaceLayout};
