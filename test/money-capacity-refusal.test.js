"use strict";
// R1 of BUILD-SPEC-EMFR-EAP5-REPAIR-2026-10-19: a shared hold exhausted while staging a non-quote atomic write is a typed
// uncommitted refusal only when fresh reads prove nothing moved. Classification only: no hold is resized and no fee,
// balance or earnings rule changes. Every case registers on every platform (count-stable) and runs on the native runtime.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const {createFixture}=require('./helpers/money-quote-operational-fixture');
const persistence=require('../lib/stripe-transfer-persistence'),capacity=require('../lib/money-capacity'),workspace=require('../lib/money-workspace'),shared=require('../lib/money-shared-liability'),router=require('../lib/money-atomic-router');
const skip=process.platform!=='linux'?'requires actual patched Linux SQLite runtime':false;
const native=(name,fn)=>test(name,{skip},fn);
const FILES=[capacity.RESERVE_FILE,capacity.PUBLICATION_FILE,capacity.CONTROL_FILE,workspace.PADDING,workspace.SCRATCH,workspace.CONTROL];
const exhausted=()=>Object.assign(new Error('SHARED_HOLD_EXHAUSTED'),{code:'SHARED_HOLD_EXHAUSTED'});

// One owed provider correction captured against the funded source: a mandatory verified capture plus its head advance.
function writeCapture(f,ctx,n,{capacity:override}={}){
 const event={id:'evt_owed_'+n,type:'charge.refunded',livemode:false,data:{object:{id:'ch_source',object:'charge',payment_intent:'pi_source'}}},raw=JSON.stringify(event),raw_digest=crypto.createHash('sha256').update(raw).digest('hex'),id=persistence.digestJSON([f.epoch.platform_account_id,false,event.id,raw_digest]);
 const head=ctx.getEvidence('capture_heads','capture_suffix_v2'),row={sequence:head.payload.lastSequence+1,previous_hash:head.payload.headHash,epoch_id:f.epoch.epoch_id,binding_digest:f.epoch.binding_digest,suffix_version:2,state:'quarantined',stripe_platform:f.epoch.platform,stripe_platform_account_id:f.epoch.platform_account_id,livemode:false,event_id:event.id,event_type:event.type,object_id:event.data.object.id,raw_digest,raw_body:raw,captured_at:'2026-10-19T00:00:00.000Z',conflict:false};
 row.record_hash=persistence.digestJSON(row);const cap=override||{purpose:'verified_capture',captureId:id,mandatory:true,sourceId:'source',rawBytes:Buffer.byteLength(raw)};
 ctx.recordEvidence({namespace:'verified_capture',id,payload:row,indexes:{providerId:event.id,platform_account_id:f.epoch.platform_account_id,livemode:false,state:'captured',sequence:row.sequence},capacity:cap});
 ctx.recordEvidence({namespace:'capture_heads',id:'capture_suffix_v2',payload:{...head.payload,lastSequence:row.sequence,headHash:row.record_hash},indexes:{state:'capture_head'},expectedRevision:head.revision,capacity:{...cap,rawBytes:0}});
 return id;
}
const capture=(f,n,options)=>f.coordinator.withMoneyControl({},ctx=>writeCapture(f,ctx,n,options));
// Authoritative cut: committed metadata, full financial export, auxiliary rows, both controls and every reserve inode.
function cut(f){
 const files={};for(const name of FILES){const file=path.join(f.dir,name),st=fs.lstatSync(file);files[name]={dev:st.dev,ino:st.ino,nlink:st.nlink,size:st.size,blocks:st.blocks,sha256:name.endsWith('control.bin')?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null};}
 return{metadata:f.store.readMetadata(),snapshot:f.store.exportSnapshot(),auxiliary:f.store.exportDatabaseAuxiliary(),capacityPeer:f.store.getAtomicCapacityPeer(),workspacePeer:f.manager.inspectAtomicPeer(),files};
}
function holdFor(f){try{return f.store.exportDatabaseAuxiliary().capacitySeeds.map(x=>x.payload||x).filter(x=>String(x.id).startsWith('shared-hold:')&&x.consumedBytes>0).map(x=>({bytes:x.bytes,consumedBytes:x.consumedBytes,remainingBytes:x.remainingBytes}));}catch{return null;}}
// Capture owed corrections until the sealed funding hold refuses one. Returns the refused index and the cut just before it.
async function exhaust(f,limit=200){
 for(let n=0;n<limit;n++){const before=cut(f);try{await capture(f,n);}catch(error){return{n,error,before};}}
 assert.fail('shared funding hold never refused within '+limit+' captures');
}
// Run fn with consumeSharedLiability replaced; the router resolves it per call, so the replacement is observed inside stage().
async function withConsume(t,replacement,fn){const original=shared.consumeSharedLiability;shared.consumeSharedLiability=(...a)=>replacement(original,...a);t.after(()=>{shared.consumeSharedLiability=original;});try{return await fn();}finally{shared.consumeSharedLiability=original;}}
function assertUncertainWith(error,code){assert.equal(error.code,'MONEY_STORE_UNCERTAIN');assert.equal(error.cause?.code,code,String(error.cause?.stack||error.cause));assert.equal(router.isProvedUncommittedRefusal(error.cause),false);assert.equal(router.isProvedUncommittedRefusal(error),false);}

// R1-c / R1-d: every case that leaves the store uncertain runs in a child process, because an uncertain store refuses an
// in-process close. The child asserts the classification and exits; the parent cold-opens the same directory.
const cases={};
for(const phase of ['atomic-intent','atomic-publication-release','atomic-completion-release','atomic-after-commit'])cases['phase-'+phase]={committed:phase==='atomic-after-commit',
 label:'R1-c SHARED_HOLD_EXHAUSTED thrown at '+phase+' is never branded and recovers by the existing protocol',
 async run(f){let armed=true,thrown=null;f.store.installAtomicRouter({testFault:p=>{if(armed&&p===phase){armed=false;thrown=exhausted();throw thrown;}}});
  await assert.rejects(capture(f,0),e=>{assertUncertainWith(e,'SHARED_HOLD_EXHAUSTED');return e.cause===thrown;});assert.throws(()=>f.store.readMetadata(),{code:'MONEY_STORE_UNCERTAIN'});}};
// The fault fires only inside the intent-control write, after the router has marked publication.
for(const [label,method] of [['short write','writeSync'],['fsync failure','fsyncSync']])cases['io-'+method]={
 label:'R1-c SHARED_HOLD_EXHAUSTED from a publication '+label+' is never branded and recovers by the existing protocol',
 async run(f){const original=fs[method],io=capacity.atomicIO,writeControl=io.writeControl;let armed=false,thrown=null;
  fs[method]=(...a)=>{if(armed){armed=false;thrown=exhausted();throw thrown;}return original.apply(fs,a);};io.writeControl=(...a)=>{armed=true;try{return writeControl(...a);}finally{armed=false;}};
  try{await assert.rejects(capture(f,0),e=>{assertUncertainWith(e,'SHARED_HOLD_EXHAUSTED');return e.cause===thrown;});}finally{fs[method]=original;io.writeControl=writeControl;}assert.ok(thrown,'fault must fire inside writeControl');}};
// A staging exhaustion whose fresh cut differs from the pre-staging cut, or cannot be read, keeps uncertainty. These
// cases damage the estate on purpose, so the parent does not cold-boot them.
const openSecond=f=>{const database=require('../lib/money-database'),descriptor=JSON.parse(fs.readFileSync(path.join(f.dir,'money-control.json')));return{database,db:database.openDatabase(path.join(f.dir,'money-control.sqlite'),descriptor).db};};
const drift={
 'capacity control bytes':f=>{const file=path.join(f.dir,capacity.CONTROL_FILE),fd=fs.openSync(file,'r+');try{fs.writeSync(fd,Buffer.from('{torn'),0,5,8191-5);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}},
 'completion reserve extent':f=>{const file=path.join(f.dir,capacity.RESERVE_FILE);fs.truncateSync(file,fs.statSync(file).size+4096);},
 'unreadable workspace scratch':f=>{fs.renameSync(path.join(f.dir,workspace.SCRATCH),path.join(f.dir,workspace.SCRATCH+'.moved'));},
 'committed revision':f=>{const {database,db}=openSecond(f);try{const m=database.readMetadata(db);database.writeMetadata(db,{...m,revision:m.revision+1});}finally{db.close();}},
 'capacity root':f=>{const {db}=openSecond(f);try{const root=JSON.parse(db.prepare("SELECT payload FROM capacity_reservations WHERE id='capacity:root'").get().payload);db.prepare("UPDATE capacity_reservations SET payload=? WHERE id='capacity:root'").run(JSON.stringify({...root,generation:root.generation+1}));}finally{db.close();}}
};
for(const [label,mutate] of Object.entries(drift))cases['drift-'+label.replace(/ /g,'-')]={coldBoot:false,
 label:'R1-c staging SHARED_HOLD_EXHAUSTED with changed '+label+' is never branded',
 async run(f,t){let thrown=null;await withConsume(t,()=>{if(!thrown){mutate(f);thrown=exhausted();}throw thrown;},async()=>{await assert.rejects(capture(f,0),e=>{assertUncertainWith(e,'SHARED_HOLD_EXHAUSTED');return e.cause===thrown;});});}};
// R1-d: wrong-owner and malformed-input staging errors are not newly classified as capacity refusals.
cases['owner-conflict']={label:'R1-d staging SHARED_HOLD_OWNER_CONFLICT with an unchanged cut stays uncertain',
 async run(f,t){let thrown=null;await withConsume(t,()=>{thrown=Object.assign(new Error('SHARED_HOLD_OWNER_CONFLICT'),{code:'SHARED_HOLD_OWNER_CONFLICT'});throw thrown;},async()=>{await assert.rejects(capture(f,0),e=>{assertUncertainWith(e,'SHARED_HOLD_OWNER_CONFLICT');return e.cause===thrown;});});}};
cases['malformed-owner']={label:'R1-d malformed mandatory capacity without an owner is never branded',
 async run(f){const before=cut(f);await assert.rejects(capture(f,0,{capacity:{purpose:'verified_capture',captureId:'malformed',mandatory:true,rawBytes:0}}),e=>{const cause=e.cause||e;assert.notEqual(cause.code,'SHARED_HOLD_EXHAUSTED');assert.equal(router.isProvedUncommittedRefusal(cause),false);assert.equal(router.isProvedUncommittedRefusal(e),false);return true;});
  if(!f.store.uncertain)assert.deepEqual(cut(f),before);}};

const childCase=process.env.R1_REFUSAL_CASE;
if(childCase)native('refusal child',async t=>{
 const f=await createFixture(t,{dir:process.env.R1_REFUSAL_DIR,keep:true}),revision=f.store.readMetadata().revision;await cases[childCase].run(f,t);
 fs.writeFileSync(path.join(f.dir,'child.json'),JSON.stringify({revision,uncertain:f.store.uncertain}));process.exit(0);
});
else{
let refusedIndex=null;
native('R1-a real staging SHARED_HOLD_EXHAUSTED is a typed refusal with unchanged committed, physical and control state, cold twice',async t=>{
 const f=await createFixture(t),{n,error,before}=await exhaust(f);refusedIndex=n;
 assert.equal(error.code,'SHARED_HOLD_EXHAUSTED');assert.match(error.stack,/money-shared-liability\.js/);assert.match(error.stack,/money-atomic-router\.js/);
 assert.equal(router.isProvedUncommittedRefusal(error),true);assert.equal(f.store.uncertain,false);assert.ok(n>0,'at least one owed capture must have been admitted first');
 assert.deepEqual(cut(f),before);
 // The failed draft cannot be committed later: a context that swallows the refusal gets the same Error on every commit attempt.
 let first;await assert.rejects(f.coordinator.withMoneyControl({},ctx=>{writeCapture(f,ctx,n);try{ctx.flush();}catch(e){first=e;}assert.equal(router.isProvedUncommittedRefusal(first),true);ctx.flush();}),e=>e===first);
 assert.equal(f.store.uncertain,false);assert.deepEqual(cut(f),before);
 for(let boot=0;boot<2;boot++){f.reopen();assert.equal(f.router.recover().state,'ready');assert.deepEqual(cut(f),before);f.store.validateDatabase({full:true});}
 t.diagnostic(JSON.stringify({refusedIndex:n,admitted:n,revision:before.metadata.revision,hold:holdFor(f)}));
});

native('R1-b a sufficient pre-sealed hold admits the same owed event once; duplicate replay charges nothing and duplicates nothing',async t=>{
 assert.ok(Number.isInteger(refusedIndex),'R1-a must establish the refused event index first');
 const f=await createFixture(t,{sharedClosureBytes:4*1048576});
 for(let n=0;n<refusedIndex;n++)await capture(f,n);
 const before=cut(f),id=await capture(f,refusedIndex),admitted=cut(f);
 assert.equal(admitted.metadata.revision,before.metadata.revision+1);assert.equal(f.store.uncertain,false);
 // Replay the identical committed evidence: no change, no charge, no new row, no new audit.
 const revision=await f.coordinator.withMoneyControl({},ctx=>{const row=ctx.getEvidence('verified_capture',id),head=ctx.getEvidence('capture_heads','capture_suffix_v2');const cap={purpose:'verified_capture',captureId:id,mandatory:true,sourceId:'source',rawBytes:Buffer.byteLength(row.payload.raw_body)};
  ctx.recordEvidence({namespace:'verified_capture',id,payload:row.payload,indexes:row.indexes,capacity:cap});ctx.recordEvidence({namespace:'capture_heads',id:'capture_suffix_v2',payload:head.payload,indexes:head.indexes,expectedRevision:head.revision,capacity:{...cap,rawBytes:0}});return ctx.flush();});
 assert.equal(revision,admitted.metadata.revision);assert.deepEqual(cut(f),admitted);
 f.reopen();assert.equal(f.router.recover().state,'ready');assert.deepEqual(cut(f),admitted);f.store.validateDatabase({full:true});
});


for(const [name,c] of Object.entries(cases))native(c.label,async t=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'capacity-refusal-')));let f;t.after(()=>{if(!f)fs.rmSync(dir,{recursive:true,force:true});});
 const child=spawnSync(process.execPath,[__filename],{env:{...process.env,R1_REFUSAL_CASE:name,R1_REFUSAL_DIR:dir},encoding:'utf8',timeout:60000});assert.equal(child.status,0,child.stdout+child.stderr);
 const result=JSON.parse(fs.readFileSync(path.join(dir,'child.json')));if(c.coldBoot===false)return;
 for(let boot=0;boot<2;boot++){if(f)f.reopen();else f=await createFixture(t,{dir,reopen:true});assert.equal(f.router.recover().state,'ready');assert.equal(f.store.readMetadata().revision,result.revision+Number(!!c.committed));f.store.validateDatabase({full:true});}
});
}
