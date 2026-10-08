"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const {boot,capacityEvidence}=require('./helpers/financial-epoch-fixture'),e=require('../lib/financial-epoch'),op=require('../lib/financial-epoch-operator'),c=require('../lib/money-checkpoint'),cap=require('../lib/money-capacity');
const lifecycle={schema_version:1,rule_version:'synthetic',approval_ref:'synthetic',deletion_barrier:{sequence:0,hash:'a'.repeat(64)},seals:[],records:[],holds:[]};
async function fixture(t){const cleanup=[];const x=boot({after:fn=>cleanup.push(fn)});t.after(()=>{try{x.store?.close();}finally{for(const fn of cleanup)fn();}});x.epoch=op.transitionEpoch({...x,expectedRevision:0,patch:{},evidence:{approval_ref:'synthetic'},financialEvidence:capacityEvidence(x.epoch)});x.store=require('../lib/money-control-store').openMoneyStore(x);x.profile=capacityEvidence(x.epoch).capacity_profile;await cap.initializeCapacityReserve(x);x.coordinator={maintenanceLease:fn=>x.store.maintenanceLease(fn)};return x;}
test('checkpoint omits only verified capacity padding and restore requires physical recreation',async t=>{
 const x=await fixture(t);fs.writeFileSync(path.join(x.root,cap.RESERVE_FILE),'unrelated same name');
 const cut=await c.createMoneyCheckpoint({...x,sourceSha:'a'.repeat(40),lifecycleControl:lifecycle}),dir=c.checkpointDirectory(x.root,cut.checkpoint_id),m=c.validateCheckpoint(dir);
 assert.ok(m.files.some(row=>row.path===cap.RESERVE_FILE));
 for(const name of [cap.RESERVE_FILE,cap.PUBLICATION_FILE])assert.ok(!m.files.some(row=>row.path===path.relative(x.root,path.join(x.epoch.financial_dir,name))));
 const target=x.root+'-capacity-restore';t.after(()=>fs.rmSync(target,{recursive:true,force:true}));const writer=require('../lib/money-writer-lock').injectMoneyWriter({root:target,assertOwned:()=>true});t.after(()=>writer.close());
 const result=c.restoreCheckpoint({checkpointDir:dir,targetRoot:target,writer,authoritativeLifecycle:lifecycle});assert.equal(result.capacity_recreation_required,true);
 const barrier=JSON.parse(fs.readFileSync(path.join(target,c.RESTORE)));assert.equal(barrier.capacity_recreation_required,true);assert.equal(fs.existsSync(path.join(target,'financial-epochs',x.epoch.epoch_id,cap.RESERVE_FILE)),false);
 barrier.state='reconciled';require('../lib/stripe-transfer-persistence').writeJSONAtomic(path.join(target,c.RESTORE),e.seal(barrier));const restored=e.resolveRuntimeEpoch({root:target});assert.throws(()=>op.transitionEpoch({epoch:restored,writer,expectedRevision:restored.activation_revision,patch:{spend:true},evidence:{spend:'a'.repeat(64),approval_ref:'synthetic'}}),/RESTORE_RECONCILIATION_REQUIRED/);
});
test('changed padding inode cannot be silently omitted from checkpoint',async t=>{
 const x=await fixture(t),file=path.join(x.epoch.financial_dir,cap.RESERVE_FILE);fs.renameSync(file,file+'.replaced');fs.copyFileSync(file+'.replaced',file);
 await assert.rejects(c.createMoneyCheckpoint({...x,sourceSha:'a'.repeat(40),lifecycleControl:lifecycle}),/CAPACITY_PHYSICAL_MISMATCH/);
});

async function restoredFixture(t){const x=await fixture(t),cut=await c.createMoneyCheckpoint({...x,sourceSha:'a'.repeat(40),lifecycleControl:lifecycle}),targetRoot=x.root+'-restore-operator';t.after(()=>fs.rmSync(targetRoot,{recursive:true,force:true}));const writer=require('../lib/money-writer-lock').injectMoneyWriter({root:targetRoot,assertOwned:()=>true});t.after(()=>writer.close());c.restoreCheckpoint({checkpointDir:c.checkpointDirectory(x.root,cut.checkpoint_id),targetRoot,writer,authoritativeLifecycle:lifecycle});const barrier=JSON.parse(fs.readFileSync(path.join(targetRoot,c.RESTORE)));return{targetRoot,writer,expectedBarrierDigest:barrier.checksum,executionApprovalRef:'synthetic-explicit-restore-capacity-approval',barrier};}
test('explicit restore-capacity rebind clears only its own marker after physical proof',async t=>{
 const input=await restoredFixture(t);await assert.rejects(c.restoreCheckpointCapacity({...input,executionApprovalRef:''}),/RESTORE_CAPACITY_APPROVAL_REQUIRED/);await assert.rejects(c.restoreCheckpointCapacity({...input,expectedBarrierDigest:'0'.repeat(64)}),/RESTORE_CAPACITY_BARRIER_CONFLICT/);
 const result=await c.restoreCheckpointCapacity(input);assert.equal(result.capacity_recreation_required,false);const after=JSON.parse(fs.readFileSync(path.join(input.targetRoot,c.RESTORE)));assert.equal(after.state,'reconcile_only');assert.equal(after.provider_reconciliation_complete,false);assert.deepEqual(after.deletion_barrier,input.barrier.deletion_barrier);assert.equal(after.lifecycle_reapplication_required,input.barrier.lifecycle_reapplication_required);assert.equal(e.resolveRuntimeEpoch({root:input.targetRoot}).capabilities.funding,false);
});
test('incomplete rebind never clears restore marker and verified crash resumes safely',async t=>{
 const input=await restoredFixture(t),original=cap.recreateCapacityReserve;cap.recreateCapacityReserve=async()=>({verified:true,requiresRebind:true});try{await assert.rejects(c.restoreCheckpointCapacity(input),/RESTORE_CAPACITY_REBIND_REQUIRED/);}finally{cap.recreateCapacityReserve=original;}
 assert.equal(JSON.parse(fs.readFileSync(path.join(input.targetRoot,c.RESTORE))).checksum,input.expectedBarrierDigest);
 await assert.rejects(c.restoreCheckpointCapacity({...input,afterStep:()=>{throw Error('synthetic crash after verified rebind');}}),/synthetic crash/);assert.equal(JSON.parse(fs.readFileSync(path.join(input.targetRoot,c.RESTORE))).capacity_recreation_required,true);
 const result=await c.restoreCheckpointCapacity(input);assert.equal(result.capacity_recreation_required,false);
});
