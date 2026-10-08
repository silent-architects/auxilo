'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');const {boot}=require('./helpers/financial-epoch-fixture');const cp=require('../lib/money-checkpoint'),c=cp,fs=require('fs'),path=require('path');
test('checkpoint validates records without a full snapshot export',async t=>{const x=boot(t),store=require('../lib/money-control-store').openMoneyStore(x);store.exportSnapshot=()=>{throw Error('full snapshot export forbidden');};const result=await cp.createMoneyCheckpoint({...x,coordinator:{maintenanceLease:fn=>store.maintenanceLease(fn)},sourceSha:'a'.repeat(40),lifecycleControl:{schema_version:1,rule_version:'v1',approval_ref:'fixture',deletion_barrier:{sequence:0,hash:'a'.repeat(64)},seals:[],records:[],holds:[]}});assert.equal(result.revision,0);store.close();});
test('streaming and snapshot validation both reject noninteger lifecycle generations',t=>{const x=boot(t),m=require('../lib/money-control-store'),s=m.initialSnapshot(x.epoch);s.lifecycle.compaction_epoch=0.5;assert.throws(()=>m.validateSnapshot(s,x.epoch),/MONEY_SCHEMA_INVALID/);const d=require('../lib/money-database'),e=require('../lib/financial-epoch'),opened=d.openDatabase(e.pathFor('money_database',x.epoch),e.readParticipant('money_control',x.epoch));d.put(opened.db,'lifecycle','compaction_epoch',0.5);opened.db.close();assert.throws(()=>d.validateMoneyDatabase({file:e.pathFor('money_database',x.epoch),epoch:x.epoch,descriptor:e.readParticipant('money_control',x.epoch)}),/MONEY_SCHEMA_INVALID/);});

test('checkpoint reports disjoint stage timings without altering sealed manifest',async t=>{
 const x=boot(t),store=require('../lib/money-control-store').openMoneyStore(x),stages=[];
 const cut=await c.createMoneyCheckpoint({...x,coordinator:{maintenanceLease:fn=>store.maintenanceLease(fn)},sourceSha:'a'.repeat(40),lifecycleControl:{schema_version:1,rule_version:'synthetic',approval_ref:'synthetic',deletion_barrier:{sequence:0,hash:'a'.repeat(64)},seals:[],records:[],holds:[]},onStage:row=>stages.push(row)});
 for(const name of ['semantic','capacity','database_close','tree','stage_durability','pack','archive_fsync','manifest','manifest_durability','publish_durability','database_reopen'])assert.ok(Number.isFinite(cut.timings[name])&&cut.timings[name]>=0,name);
 assert.equal(stages.length,11);assert.ok(cut.timings.total>=Object.values(cut.timings).filter((_,i)=>i<11).reduce((a,b)=>a+b,0));
 const manifest=JSON.parse(fs.readFileSync(path.join(c.checkpointDirectory(x.root,cut.checkpoint_id),c.MANIFEST)));assert.equal(manifest.timings,undefined);
 store.close();
});

test('checkpoint performs conservation and participant checks in one validated database cut',async t=>{
 const x=boot(t),m=require('../lib/money-control-store'),store=m.openMoneyStore(x),original=m.validateRecords;let validations=0;
 m.validateRecords=function(...args){validations++;return original.apply(this,args);};
 try{await cp.createMoneyCheckpoint({...x,coordinator:{maintenanceLease:fn=>store.maintenanceLease(fn)},sourceSha:'a'.repeat(40),lifecycleControl:{schema_version:1,rule_version:'synthetic',approval_ref:'synthetic',deletion_barrier:{sequence:0,hash:'a'.repeat(64)},seals:[],records:[],holds:[]}});}finally{m.validateRecords=original;store.close();}
 assert.equal(validations,1);
});

function cutOptions(x,store){return{...x,coordinator:{maintenanceLease:fn=>store.maintenanceLease(fn)},sourceSha:'a'.repeat(40),lifecycleControl:{schema_version:1,rule_version:'synthetic',approval_ref:'synthetic',deletion_barrier:{sequence:0,hash:'a'.repeat(64)},seals:[],records:[],holds:[]}};}
test('single-pass checkpoint reads small file once and matches strict prehashed archive bytes',async t=>{
 const x=boot(t),store=require('../lib/money-control-store').openMoneyStore(x),small=path.join(x.root,'small.bin');fs.writeFileSync(small,Buffer.alloc(1234,91));fs.writeFileSync(path.join(x.root,'large.bin'),Buffer.alloc(600000,33));
 const open=fs.openSync,read=fs.readSync,close=fs.closeSync;const targets=new Set();let reads=0;
 fs.openSync=function(file,...args){const fd=open.call(this,file,...args);if(file===small)targets.add(fd);return fd;};fs.closeSync=function(fd){targets.delete(fd);return close.call(this,fd);};fs.readSync=function(fd,...args){if(targets.has(fd))reads++;return read.call(this,fd,...args);};
 let cut;try{cut=await cp.createMoneyCheckpoint(cutOptions(x,store));}finally{fs.openSync=open;fs.readSync=read;fs.closeSync=close;store.close();}
 assert.equal(reads,1);const tree=cp.listTree(x.root),expected=path.join(x.root,'expected.pack');cp.packCheckpointTree(x.root,expected,tree);assert.deepEqual(fs.readFileSync(expected),fs.readFileSync(path.join(cp.checkpointDirectory(x.root,cut.checkpoint_id),cp.ARCHIVE)));
});
test('single-pass checkpoint rejects a source changed during its exact read',async t=>{
 const x=boot(t),store=require('../lib/money-control-store').openMoneyStore(x),small=path.join(x.root,'small.bin');fs.writeFileSync(small,Buffer.alloc(1234,91));const open=fs.openSync,read=fs.readSync,close=fs.closeSync,targets=new Set();let changed=false;
 fs.openSync=function(file,...args){const fd=open.call(this,file,...args);if(file===small)targets.add(fd);return fd;};fs.closeSync=function(fd){targets.delete(fd);return close.call(this,fd);};fs.readSync=function(fd,...args){const n=read.call(this,fd,...args);if(targets.has(fd)&&!changed){changed=true;fs.writeFileSync(small,Buffer.alloc(1234,92));fs.utimesSync(small,new Date(),new Date(Date.now()+1000));}return n;};
 try{await assert.rejects(cp.createMoneyCheckpoint(cutOptions(x,store)),/CHECKPOINT_SOURCE_CHANGED/);}finally{fs.openSync=open;fs.readSync=read;fs.closeSync=close;store.close();}
});

test('single-pass checkpoint handles short reads without losing previously read bytes',async t=>{
 const x=boot(t),store=require('../lib/money-control-store').openMoneyStore(x),small=path.join(x.root,'short-read.bin'),bytes=Buffer.from(Array.from({length:1234},(_,i)=>i%251));fs.writeFileSync(small,bytes);
 const open=fs.openSync,read=fs.readSync,close=fs.closeSync,targets=new Set();
 fs.openSync=function(file,...args){const fd=open.call(this,file,...args);if(file===small)targets.add(fd);return fd;};fs.closeSync=function(fd){targets.delete(fd);return close.call(this,fd);};fs.readSync=function(fd,buffer,offset,length,position){return read.call(this,fd,buffer,offset,targets.has(fd)?Math.min(length,77):length,position);};
 let cut;try{cut=await cp.createMoneyCheckpoint(cutOptions(x,store));}finally{fs.openSync=open;fs.readSync=read;fs.closeSync=close;store.close();}
 const dir=cp.checkpointDirectory(x.root,cut.checkpoint_id),manifest=cp.validateCheckpoint(dir);cp.withCheckpointContents(dir,manifest,root=>assert.deepEqual(fs.readFileSync(path.join(root,'short-read.bin')),bytes));
});
