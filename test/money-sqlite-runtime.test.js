'use strict';
// These injected tests verify inspector branches. They are not native spill proof.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const runtime = require('../lib/money-sqlite-runtime');

function fixture() {
  const file = '/financial/money-control.sqlite', tempDirectory = '/financial/sqlite-temp';
  const facts = new Map([
    ['/', {dev:1,ino:1,mode:0o40755,uid:1000,nlink:1,type:'directory'}],
    ['/financial', {dev:1,ino:2,mode:0o40700,uid:1000,nlink:1,type:'directory'}],
    [file, {dev:1,ino:3,mode:0o100600,uid:1000,nlink:1,type:'file'}],
    [tempDirectory, {dev:1,ino:4,mode:0o40700,uid:1000,nlink:1,type:'directory'}],
  ]);
  const stat = p => {const s=facts.get(p);if(!s)throw Object.assign(Error('missing'),{code:'ENOENT'});return {...s,isFile:()=>s.type==='file',isDirectory:()=>s.type==='directory',isSymbolicLink:()=>s.type==='symlink'};};
  const fs = {lstatSync:stat,realpathSync:p=>p};
  const host = {platform:'linux',getuid:()=>1000,env:{AUXILO_SQLITE_TMPDIR:tempDirectory}};
  const settings = {page_size:4096,journal_mode:'delete',synchronous:3,auto_vacuum:0,schema_version:7,page_count:20};
  const state = {version:'3.53.2',compile:['AUXILO_STRICT_TEMP=1','DEFAULT_SECTOR_SIZE=4096'],databases:[{name:'main',file},{name:'temp',file:''}],schema:[]};
  const db = {
    inTransaction:false,
    pragma(name) {if(name==='compile_options')return state.compile.map(compile_options=>({compile_options}));if(name==='database_list')return state.databases;return settings[name];},
    prepare(sql) {if(sql.includes('sqlite_version()'))return {get:()=>({version:state.version})};return {all:()=>state.schema};},
  };
  const quota = {maxDatabasePages:100,maxRollbackBytes:2*1024*1024};
  quota.rollbackProofDigest=runtime.deriveRollbackProof(quota).rollbackProofDigest;
  return {file,tempDirectory,facts,fs,host,db,state,settings,quota,create(){return runtime.createUnitRuntimeInspector({db,file,tempDirectory,quota},{fs,runtime:host});}};
}

test('UNIT independent rollback descriptor is deterministic and does not echo supplied digest',()=>{
  const q={maxDatabasePages:10,maxRollbackBytes:1048576};
  const a=runtime.deriveRollbackProof(q), b=runtime.deriveRollbackProof({...q,rollbackProofDigest:'caller-untrusted'});
  assert.deepEqual(a,b);assert.equal(a.requiredRollbackBytes,184320);
  assert.equal(a.descriptor.patched_source_sha256,'dcd0fcf647169cdcac0c9c9447de52eeeb909aa5b075adeaff32b7e2d5892ad3');
  assert.notEqual(runtime.deriveRollbackProof({...q,maxRollbackBytes:2097152}).rollbackProofDigest,a.rollbackProofDigest);
  assert.match(a.rollbackProofDigest,/^[a-f0-9]{64}$/);
});
test('UNIT independent floor rejects insufficient allowance and unsafe integer inputs',()=>{
  assert.throws(()=>runtime.deriveRollbackProof({maxDatabasePages:10,maxRollbackBytes:184319}),{code:'SQLITE_ROLLBACK_BOUND_INSUFFICIENT'});
  for(const value of [0,-1,1.5,NaN,Infinity,'100',Number.MAX_SAFE_INTEGER+1,1n]){
    assert.throws(()=>runtime.deriveRollbackProof({maxDatabasePages:value,maxRollbackBytes:2097152}),{code:'SQLITE_QUOTA_INVALID'});
    assert.throws(()=>runtime.deriveRollbackProof({maxDatabasePages:10,maxRollbackBytes:value}),{code:'SQLITE_QUOTA_INVALID'});
  }
  assert.throws(()=>runtime.deriveRollbackProof({maxDatabasePages:0xffffffff,maxRollbackBytes:Number.MAX_SAFE_INTEGER}),{code:'SQLITE_QUOTA_INVALID'});
});
test('UNIT valid inspection returns independent proof, canonical inode facts and schema',()=>{
  const f=fixture(),inspect=f.create(),proof=inspect();
  assert.equal(proof.proofKind,'unit');assert.equal(proof.schemaVersion,7);
  assert.deepEqual(proof.file,{path:f.file,dev:1,ino:3});
  assert.deepEqual(proof.tempDirectory,{path:f.tempDirectory,dev:1,ino:4});
  assert.equal(proof.rollbackProofDigest,runtime.deriveRollbackProof(f.quota).rollbackProofDigest);
  proof.descriptor.assumptions.push('untrusted-change');
  assert.equal(inspect().descriptor.assumptions.includes('untrusted-change'),false);
});
test('UNIT runtime rejects wrong platform, version and missing or conflicting compile marker',()=>{
  const f=fixture();f.host.platform='darwin';assert.throws(()=>f.create(),{code:'SQLITE_LINUX_REQUIRED'});
  f.host.platform='linux';f.state.version='3.53.1';assert.throws(()=>f.create(),{code:'SQLITE_RUNTIME_VERSION'});
  f.state.version='3.53.2';
  for(const options of [[],['AUXILO_STRICT_TEMP=0','DEFAULT_SECTOR_SIZE=4096'],['AUXILO_STRICT_TEMP=1','DEFAULT_SECTOR_SIZE=8192'],['AUXILO_STRICT_TEMP=1','AUXILO_STRICT_TEMP=0','DEFAULT_SECTOR_SIZE=4096']]){
    f.state.compile=options;assert.throws(()=>f.create(),{code:'SQLITE_COMPILE_PROTECTION'});
  }
});
test('UNIT inspector refuses caller digest and freezes quota independently of later caller mutation',()=>{
  const f=fixture();f.quota.rollbackProofDigest='a'.repeat(64);assert.throws(()=>f.create(),{code:'SQLITE_ROLLBACK_PROOF_MISMATCH'});
  f.quota.rollbackProofDigest=runtime.deriveRollbackProof(f.quota).rollbackProofDigest;const inspect=f.create();
  f.quota.maxDatabasePages=200;assert.equal(inspect().descriptor.max_database_pages,100);
});
test('UNIT every inspection checks current native protections and required pragmas',()=>{
  for(const[key,value]of Object.entries({page_size:8192,journal_mode:'wal',synchronous:2,auto_vacuum:1})){
    const f=fixture(),inspect=f.create();f.settings[key]=value;assert.throws(()=>inspect(),{code:'SQLITE_RUNTIME_PRAGMA'});
  }
  const f=fixture(),inspect=f.create();f.state.compile=[];assert.throws(()=>inspect(),{code:'SQLITE_COMPILE_PROTECTION'});
});
test('UNIT initial transaction is refused and only explicit beforeCommit phase allows owned transaction',()=>{
  const f=fixture();f.db.inTransaction=true;assert.throws(()=>f.create(),{code:'SQLITE_TRANSACTION_STATE'});
  f.db.inTransaction=false;const inspect=f.create();f.db.inTransaction=true;
  assert.throws(()=>inspect(),{code:'SQLITE_TRANSACTION_STATE'});assert.equal(inspect({phase:'beforeCommit'}).schemaVersion,7);
  assert.throws(()=>inspect({phase:'other'}),{code:'SQLITE_INSPECTION_PHASE'});
});
test('UNIT changed schema, attachments and trigger or virtual schema are refused',()=>{
  const f=fixture(),inspect=f.create();f.settings.schema_version=8;assert.throws(()=>inspect(),{code:'SQLITE_SCHEMA_CHANGED'});f.settings.schema_version=7;
  f.state.databases.push({name:'other',file:'/financial/other.sqlite'});assert.throws(()=>inspect(),{code:'SQLITE_DATABASE_ATTACHMENTS'});f.state.databases.pop();
  for(const row of [{type:'trigger',sql:'CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END'},{type:'table',sql:'CREATE VIRTUAL TABLE x USING fts5(y)'}]){
    f.state.schema=[row];assert.throws(()=>inspect(),{code:'SQLITE_UNSAFE_SCHEMA'});
  }
});
test('UNIT database path and physical page ceiling must match the admitted file',()=>{
  const f=fixture(),inspect=f.create();f.state.databases[0].file='/other.sqlite';assert.throws(()=>inspect(),{code:'SQLITE_DATABASE_FILE_MISMATCH'});
  f.state.databases[0].file=f.file;f.settings.page_count=101;assert.throws(()=>inspect(),{code:'SQLITE_DATABASE_PAGE_LIMIT'});
});
test('UNIT missing, relative or changed strict environment is refused',()=>{
  const f=fixture();delete f.host.env.AUXILO_SQLITE_TMPDIR;assert.throws(()=>f.create(),{code:'SQLITE_TEMP_ENVIRONMENT'});
  f.host.env.AUXILO_SQLITE_TMPDIR='relative';assert.throws(()=>f.create(),{code:'SQLITE_TEMP_ENVIRONMENT'});
  f.host.env.AUXILO_SQLITE_TMPDIR=f.tempDirectory;const inspect=f.create();f.host.env.AUXILO_SQLITE_TMPDIR='/other';assert.throws(()=>inspect(),{code:'SQLITE_TEMP_ENVIRONMENT'});
});
test('UNIT same-name directory or database inode replacement is refused',()=>{
  for(const target of ['tempDirectory','file']){const f=fixture(),inspect=f.create();f.facts.get(f[target]).ino++;assert.throws(()=>inspect(),{code:'SQLITE_PATH_IDENTITY_CHANGED'});}
});
test('UNIT cross-device, symlink, ownership, mode, disappearance and hardlink branches refuse',()=>{
  for(const[target,field,value,code]of [
    ['tempDirectory','dev',2,'SQLITE_TEMP_FILESYSTEM'],['tempDirectory','type','symlink','SQLITE_PATH_INVALID'],
    ['tempDirectory','uid',1001,'SQLITE_TEMP_OWNERSHIP'],['tempDirectory','mode',0o40750,'SQLITE_TEMP_MODE'],
    ['file','nlink',2,'SQLITE_DATABASE_FILE_INVALID'],['file','type','directory','SQLITE_DATABASE_FILE_INVALID'],
  ]){const f=fixture(),inspect=f.create();f.facts.get(f[target])[field]=value;assert.throws(()=>inspect(),{code});}
  const f=fixture(),inspect=f.create();f.facts.delete(f.tempDirectory);assert.throws(()=>inspect(),{code:'SQLITE_PATH_INVALID'});
  const g=fixture();g.facts.get('/financial').type='symlink';assert.throws(()=>g.create(),{code:'SQLITE_PATH_INVALID'});
});
test('UNIT test injection is unavailable outside the node test runner',()=>{
  const {spawnSync}=require('node:child_process'),env={...process.env};delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,['-e',`const m=require(${JSON.stringify(require.resolve('../lib/money-sqlite-runtime'))});try{m.createUnitRuntimeInspector({},{});process.exit(2)}catch(e){if(e.code!=='SQLITE_UNIT_INJECTION_FORBIDDEN')throw e}`],{env,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
test('real host cannot claim Linux strict-native proof when host or binary is unsupported',()=>{
  const Database=require('../server-runtime/node_modules/better-sqlite3'),db=new Database(':memory:');
  try{
    if(process.platform!=='linux')assert.throws(()=>runtime.createRuntimeInspector({db,file:'/unavailable',tempDirectory:'/unavailable',quota:fixture().quota}),{code:'SQLITE_LINUX_REQUIRED'});
    else if(!db.prepare("SELECT sqlite_compileoption_used('AUXILO_STRICT_TEMP') n").get().n)assert.throws(()=>runtime.createRuntimeInspector({db,file:'/unavailable',tempDirectory:'/unavailable',quota:fixture().quota}),{code:'SQLITE_COMPILE_PROTECTION'});
    else assert.equal(db.prepare('SELECT sqlite_version() version').get().version,'3.53.2');
  }finally{db.close();}
});

test('NATIVE patched Linux inspector validates real SQLite and filesystem continuity',t=>{
  if(process.platform!=='linux'){t.skip('Requires actual Linux strict-temp native addon; unit checks are not native proof.');return;}
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'emfr-runtime-native-')));
  const tempDirectory=path.join(root,'sqlite-temp'),file=path.join(root,'money-control.sqlite');
  fs.mkdirSync(tempDirectory,{mode:0o700});
  const previous=process.env.AUXILO_SQLITE_TMPDIR;
  let db;
  try{
    process.env.AUXILO_SQLITE_TMPDIR=tempDirectory;
    const Database=require('../server-runtime/node_modules/better-sqlite3');
    db=new Database(file);
    if(!db.prepare("SELECT sqlite_compileoption_used('AUXILO_STRICT_TEMP') n").get().n){
      t.skip('Native addon lacks AUXILO_STRICT_TEMP; refusal is not a native success proof.');return;
    }
    db.exec('PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA auto_vacuum=0; CREATE TABLE probe(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL); INSERT INTO probe VALUES(1,1);');
    const quota={maxDatabasePages:64,maxRollbackBytes:2*1024*1024};
    quota.rollbackProofDigest=runtime.deriveRollbackProof(quota).rollbackProofDigest;
    const inspect=runtime.createRuntimeInspector({db,file,tempDirectory,quota}),proof=inspect();
    const fileStat=fs.statSync(file),tempStat=fs.statSync(tempDirectory);
    assert.equal(proof.proofKind,'native-runtime-inspection');
    assert.deepEqual(proof.file,{path:file,dev:fileStat.dev,ino:fileStat.ino});
    assert.deepEqual(proof.tempDirectory,{path:tempDirectory,dev:tempStat.dev,ino:tempStat.ino});
    assert.equal(proof.rollbackProofDigest,quota.rollbackProofDigest);
    assert.equal(proof.requiredRollbackBytes,runtime.deriveRollbackProof(quota).requiredRollbackBytes);
    db.exec('BEGIN IMMEDIATE; UPDATE probe SET amount=2 WHERE id=1;');
    assert.throws(()=>inspect(),{code:'SQLITE_TRANSACTION_STATE'});
    assert.equal(inspect({phase:'beforeCommit'}).proofKind,'native-runtime-inspection');
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT amount FROM probe WHERE id=1').get().amount,1);
    process.env.AUXILO_SQLITE_TMPDIR=path.join(root,'wrong');
    assert.throws(()=>inspect(),{code:'SQLITE_TEMP_ENVIRONMENT'});
    process.env.AUXILO_SQLITE_TMPDIR=tempDirectory;
    fs.renameSync(tempDirectory,tempDirectory+'.retained');
    fs.mkdirSync(tempDirectory,{mode:0o700});
    assert.throws(()=>inspect(),{code:'SQLITE_PATH_IDENTITY_CHANGED'});
  }finally{
    if(db){if(db.inTransaction)db.exec('ROLLBACK');db.close();}
    if(previous===undefined)delete process.env.AUXILO_SQLITE_TMPDIR;else process.env.AUXILO_SQLITE_TMPDIR=previous;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
