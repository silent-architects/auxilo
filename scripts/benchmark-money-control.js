#!/usr/bin/env node
'use strict';
// Synthetic storage measurements only. Seeded history is not evidence that the
// full return, event, participant and recovery paths completed that history.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const cp=require('../lib/money-checkpoint');
function envelope(measurements,profile){
 if(!profile||profile.accepted!==true||!profile.limits||!Object.keys(profile.limits).length)return{warnings:[],exceeded:[],new_admission_available:false,reason:'CAPACITY_PROFILE_REQUIRED'};
 const warnings=[],exceeded=[];
 for(const [key,max]of Object.entries(profile.limits)){
  const actual=measurements[key];if(!Number.isSafeInteger(max)||max<=0||!Number.isSafeInteger(actual)||actual<0)throw Error('INVALID_CAPACITY_MEASUREMENT');
  if(actual>=max*.75)warnings.push(key);if(actual>max)exceeded.push(key);
 }
 return{warnings,exceeded,new_admission_available:Object.entries(profile.limits).every(([k,max])=>measurements[k]<max)};
}
function percentile(samples,p){if(!samples.length)throw Error('EMPTY_PERFORMANCE_SAMPLE');if(!(p>0&&p<=1)||samples.some(n=>!Number.isFinite(n)||n<0))throw Error('INVALID_PERFORMANCE_SAMPLE');return [...samples].sort((a,b)=>a-b)[Math.ceil(samples.length*p)-1];}
async function benchmark({samples=20,full=false,operations=20}={}){
 if(process.platform!=='linux')throw Error('LINUX_PERFORMANCE_PROOF_REQUIRED');
 if(!Number.isSafeInteger(samples)||samples<1||!Number.isSafeInteger(operations)||operations<0)throw Error('INVALID_BENCHMARK_DIMENSIONS');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'auxilo-money-benchmark-')));
 const p=require('../lib/stripe-transfer-persistence'),h=require('../lib/stripe-history-coverage'),e=require('../lib/financial-epoch'),operator=require('../lib/financial-epoch-operator'),m=require('../lib/money-control-store');
 let writer,store;
 try{
  for(const name of ['accounts.json','credits.json'])fs.writeFileSync(path.join(root,name),'{}\n',{mode:0o600});
  fs.mkdirSync(path.join(root,'wal'),{mode:0o700});
  const observed=Object.fromEntries(['accounts.json','credits.json'].map(name=>[name,{state:'present',sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')}]));
  const legacy={manifest:{checkpoint_id:'benchmark',approval_ref:'synthetic-only'},source_fingerprint:'a'.repeat(64),checksum:'b'.repeat(64),candidate_sha:'c'.repeat(40),source:{observed}};
  for(const[name,value]of [[h.COVERAGE,h.buildCoverage(legacy)],[h.JOURNAL,h.buildCoverageJournal(legacy,'completed')],[h.CAPTURE,h.buildCaptureStore(legacy)]])p.writeJSONAtomic(path.join(root,name),value);
  writer=require('../lib/money-writer-lock').acquireMoneyWriter({root});
  const plan=operator.createEpochPlan({root,epochId:'benchmark',candidateSha:'d'.repeat(40),livemode:false,evidence:{approval_ref:'synthetic-only',policy_ref:'synthetic-only',inventory_ref:'synthetic-only',provider_identity_ref:'synthetic-only',capital_ref:'synthetic-only',not_before:'2026-01-01T00:00:00Z'}});
  const epoch=operator.bootstrapEpoch({root,writer,plan,stoppedWriterEvidence:{stopped:true,evidence_ref:'isolated-generated-fixture'}});
  store=m.openMoneyStore({epoch,writer});
  const operationCount=full?10000:operations;
  // One explicit fixture import, outside the measured production transaction.
  await store.transaction((tx,s)=>{
   const amountMicros=Math.max(10000,operationCount*10000),admission={id:'synthetic-source',accountId:'synthetic-owner',amountMicros,payment_intent_id:'pi_synthetic',policy:{},provenance:{}};
   s.sources[admission.id]={...admission,currency:'usd',epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,spentMicros:0,retiredMicros:operationCount*10000,admission,input_digest:m.digest(admission)};
   for(let i=0;i<operationCount;i++)s.operations['synthetic-'+i]={id:'synthetic-'+i,type:'buyer_return',accountId:admission.accountId,sourceId:admission.id,clientRequestKey:'fixture-'+i,state:'settled',sequence:++s.sequence,G:10000,D:10000,N:10000,C:0,r:0,principalRetired:true,allocationIds:[],projectionIds:[]};
   store.commitRevision(tx,s.revision,s);
  });
  const coordinator=require('../lib/money-control').createMoneyControl({epoch,writer,store}),times=[];
  let evidenceRevision;
  for(let i=0;i<samples;i++){
   const start=performance.now();
   await coordinator.withMoneyControl({kind:'synthetic-storage-probe'},ctx=>{const row=ctx.recordEvidence({namespace:'capture_heads',id:'synthetic-storage-probe',payload:{sample:i},expectedRevision:evidenceRevision});evidenceRevision=row.revision;});
   times.push(performance.now()-start);
   if(full&&i+1<samples)await new Promise(resolve=>setTimeout(resolve,Math.max(0,500-(performance.now()-start))));
  }
  const databaseBytes=fs.statSync(e.pathFor('money_database',epoch)).size;
  if(full){
   const before=cp.listTree(root),count=cp.LIMITS.files-before.files.length;
   let remaining=cp.LIMITS.bytes-before.total_bytes-4096;
   if(count<1||remaining<0)throw Error('FIXTURE_EXCEEDS_CHECKPOINT_ENVELOPE');
   const files=path.join(root,'benchmark-files');fs.mkdirSync(files,{mode:0o700});
   for(let i=0;i<count;i++){const bytes=Math.floor(remaining/(count-i));fs.writeFileSync(path.join(files,String(i)+'.bin'),Buffer.alloc(bytes,120),{mode:0o600});remaining-=bytes;}
  }
  const lifecycleControl={schema_version:1,rule_version:'synthetic',approval_ref:'synthetic-only',deletion_barrier:{sequence:0,hash:'e'.repeat(64)},seals:[],records:[],holds:[]};
  let checkpointMs=null,validationMs=null,manifest=null,checkpointError=null,checkpointStages=null;
  const cutStart=performance.now();
  try{const cut=await cp.createMoneyCheckpoint({epoch,writer,coordinator,sourceSha:'d'.repeat(40),lifecycleControl});checkpointMs=performance.now()-cutStart;checkpointStages=cut.timings||null;const validateStart=performance.now();manifest=cp.validateCheckpoint(cp.checkpointDirectory(root,cut.checkpoint_id));validationMs=performance.now()-validateStart;}catch(error){checkpointMs=performance.now()-cutStart;checkpointError=error.code||error.message;}
  return{kind:'synthetic-storage-only',platform:process.platform,node:process.version,arch:process.arch,cpus:os.availableParallelism?.()||os.cpus().length,total_memory_bytes:os.totalmem(),filesystem:fs.statfsSync(root),samples:times.length,journal_p95_ms:percentile(times,.95),journal_p99_ms:percentile(times,.99),checkpoint_ms:checkpointMs,checkpoint_stages:checkpointStages,restore_validation_ms:validationMs,checkpoint_error:checkpointError,rss_bytes:process.memoryUsage().rss,max_rss_bytes:process.resourceUsage().maxRSS*1024,dimensions:{databaseBytes,sourceCount:1,seededOperationCount:operationCount,checkpointBytes:manifest?.total_bytes??null,fileCount:manifest?.files.length??null},acceptance_complete:false,unmeasured:['10000 actual authorized return/event/participant paths','concurrent confirmation workload','physical near-full completion reserve','live launch-volume growth forecast',...(full?[]:['128MiB/20000-file checkpoint maximum'])],storage_targets_pass:!checkpointError&&percentile(times,.95)<=50&&percentile(times,.99)<=100&&checkpointMs<=2000&&validationMs<=30000};
 }finally{try{store?.close();}finally{writer?.close();fs.rmSync(root,{recursive:true,force:true});}}
}
if(require.main===module)benchmark({full:process.argv.includes('--full'),samples:process.argv.includes('--full')?1200:20}).then(value=>console.log(JSON.stringify(value)),error=>{console.error(error.stack);process.exitCode=1;});
module.exports={envelope,percentile,benchmark};
