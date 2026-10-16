'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs');
const {boot}=require('./helpers/financial-epoch-fixture');const e=require('../lib/financial-epoch');
test('epoch bootstrap publishes explicit immutable schema2 descriptor and real SQLite genesis',t=>{const x=boot(t),descriptor=e.readParticipant('money_control',x.epoch),file=e.pathFor('money_database',x.epoch);assert.equal(descriptor.schema,2);assert.equal(descriptor.database_file,'money-control.sqlite');assert.equal(fs.readFileSync(file).subarray(0,16).toString(),'SQLite format 3\0');assert.equal(descriptor.revision,undefined);const before=fs.readFileSync(file);e.resolveRuntimeEpoch({root:x.root});assert.deepEqual(fs.readFileSync(file),before);});
test('initialized epoch never recovers a missing database as empty genesis',t=>{const x=boot(t),file=e.pathFor('money_database',x.epoch);fs.unlinkSync(file);assert.throws(()=>e.resolveRuntimeEpoch({root:x.root}),/EPOCH_PARTICIPANT_MISSING|MONEY_/);assert.equal(fs.existsSync(file),false);});
test('wrong database identity fails epoch readiness before any admission',t=>{const x=boot(t),file=e.pathFor('money_database',x.epoch),d=require('../lib/money-database'),descriptor=e.readParticipant('money_control',x.epoch),opened=d.openDatabase(file,descriptor),metadata=d.readMetadata(opened.db);d.writeMetadata(opened.db,{...metadata,database_id:'wrong-database'});opened.db.close();assert.throws(()=>e.resolveRuntimeEpoch({root:x.root}),/MONEY_DATABASE_IDENTITY_CONFLICT/);});

test('validation streams payloads and reuses point and edge statements without dropping index checks',t=>{
 const x=boot(t),d=require('../lib/money-database'),opened=d.openDatabase(e.pathFor('money_database',x.epoch),e.readParticipant('money_control',x.epoch)),db=opened.db;
 for(let i=0;i<100;i++)d.put(db,'operations','op'+i,{id:'op'+i,accountId:'buyer',state:'settled',sequence:i,projectionIds:['p'+i],allocationIds:[]});
 const original=db.prepare,queries=[];db.prepare=function(sql){queries.push(sql);return original.call(this,sql);};
 try{
  const reader=d.createValidationReader(db,x.epoch);const rows=[...reader.entries(reader.state.operations)];assert.equal(rows.length,100);assert.deepEqual(rows.find(([id])=>id==='op3')[1].projectionIds,['p3']);
  for(let i=0;i<100;i++)assert.equal(reader.state.operations.op3.id,'op3');
  assert.ok(queries.length<=6,`prepared statements: ${queries.length}`);
  original.call(db,"UPDATE operations SET owner='wrong' WHERE id='op3'").run();assert.throws(()=>d.get(db,'operations','op3'),/MONEY_INDEX_PAYLOAD_CONFLICT/);
 }finally{db.prepare=original;db.close();}
});

test('boot and checkpoint full validation reject an unbacked cash reflection index',t=>{
 const x=boot(t),d=require('../lib/money-database'),descriptor=e.readParticipant('money_control',x.epoch),file=e.pathFor('money_database',x.epoch),opened=d.openDatabase(file,descriptor);
 opened.db.prepare('INSERT INTO cash_commitments(operation_id,version,cash_micros,sequence) VALUES(?,?,?,?)').run('orphan','a'.repeat(64),1,0);opened.db.close();
 assert.throws(()=>e.resolveRuntimeEpoch({root:x.root}),/CASH_INDEX_CONSERVATION/);assert.throws(()=>cpSemantic(x.root),/CASH_INDEX_CONSERVATION/);
});
function cpSemantic(root){return require('../lib/money-checkpoint').semanticSnapshot(root);}
