"use strict";
const assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const e=require('../../lib/financial-epoch'),op=require('../../lib/financial-epoch-operator'),lock=require('../../lib/money-writer-lock');
const {digestJSON,writeJSONAtomic}=require('../../lib/stripe-transfer-persistence');
function setup(t){ const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'epoch-foundation-'))); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(path.join(root,'accounts.json'),JSON.stringify({old:{email:'old@example.invalid'}}),{mode:0o600});fs.writeFileSync(path.join(root,'credits.json'),JSON.stringify({old:{balance:400,dollar_lots:[{remaining_usd:10}]}}),{mode:0o600});fs.mkdirSync(path.join(root,'wal')); const h=require('../../lib/stripe-history-coverage'); const source={observed:{'accounts.json':{state:'present',sha256:op.hash(fs.readFileSync(path.join(root,'accounts.json')))},'credits.json':{state:'present',sha256:op.hash(fs.readFileSync(path.join(root,'credits.json')))},'earnings.json':{state:'absent',errno:'ENOENT'}}};const plan={manifest:{checkpoint_id:'checkpoint',approval_ref:'approval'},source_fingerprint:'a'.repeat(64),checksum:'b'.repeat(64),candidate_sha:'c'.repeat(40),source}; for(const[n,v] of [[h.COVERAGE,h.buildCoverage(plan)],[h.JOURNAL,h.buildCoverageJournal(plan,'completed')],[h.CAPTURE,h.buildCaptureStore(plan)]])writeJSONAtomic(path.join(root,n),v);const writer=lock.injectMoneyWriter({root,assertOwned:()=>true});t.after(()=>writer.close());return{root,writer}; }
function planFor(root){return op.createEpochPlan({root,epochId:'fresh-1',candidateSha:'d'.repeat(40),livemode:false,evidence:{approval_ref:'fixture',policy_ref:'policy-v1',inventory_ref:'inventory',provider_identity_ref:'verified-account',capital_ref:'capital',not_before:'2026-10-07T00:00:00.000Z'}});}

function boot(t){const x=setup(t);return{...x,epoch:op.bootstrapEpoch({...x,plan:planFor(x.root),stoppedWriterEvidence:{stopped:true,evidence_ref:'stop'}})};}
function consent(epoch,accountId='new'){const file=e.pathFor('policy_consents',epoch),s=JSON.parse(fs.readFileSync(file));const row={consent_id:'consent-'+accountId,account_id:accountId,state:'acknowledged',policy_version:epoch.policy_ref,epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,effective_at:epoch.not_before,accepted_at:epoch.not_before,evidence_ref:'fixture-assent'};s.consents[row.consent_id]=row;writeJSONAtomic(file,s);return row;}
function source(epoch,accountId='new'){const c=consent(epoch,accountId);const stamp={epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,stripe_platform:epoch.platform,stripe_platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,policy_version:epoch.policy_ref,policy_consent_id:c.consent_id,created_at:epoch.not_before};const lot={...stamp,account_id:accountId,lot_id:'lot-'+accountId,kind:'dollar_paid',purchase_id:'pur-'+accountId,stripe_payment_intent:'pi_'+accountId,checkout_intent_id:'intent-'+accountId,remaining_usd:10};const intent={...stamp,intent_id:lot.checkout_intent_id,account_id:accountId,state:'paid_credited',purchase_id:lot.purchase_id,payment_intent_id:lot.stripe_payment_intent,session_id:'cs_'+accountId,amount_cents:1000,currency:'usd',evidence:{verified:true,authoritative:true,livemode:epoch.livemode}};const purchase={...stamp,id:lot.purchase_id,account_id:accountId,amount_usd:10,stripe_payment_intent:lot.stripe_payment_intent,stripe_session_id:intent.session_id};const origin={...stamp,object_kind:'payment_intent',provider_id:lot.stripe_payment_intent,purchase_id:lot.purchase_id,account_id:accountId};for(const[name,apply]of [['stripe_checkout_intents',s=>{s.intents[intent.intent_id]=intent}],['stripe_object_origins',s=>s.records.push(origin)],['credits',s=>{s[accountId]={dollar_lots:[lot]}}]]){const file=e.pathFor(name,epoch),v=JSON.parse(fs.readFileSync(file));apply(v);writeJSONAtomic(file,v.checksum?e.seal(v):v);}fs.appendFileSync(e.pathFor('purchases',epoch),JSON.stringify(purchase)+'\n');return lot;}

// Explicit synthetic approval evidence; never a measured production acceptance.
function capacityEvidence(epoch){
 const capacity_profile={schema:1,id:'synthetic-fixture-profile',approved:true,evidence_ref:'synthetic-fixture-only-no-measured-acceptance',epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,currency:'usd',blockBytes:4096,reserveBytes:16777216,publicationBytes:131072,slotBytes:65536,sourceClosureBytes:4096,spendBytes:4096,optionalBytes:4096,maxRowBytes:4096,maxRawEventBytes:4096,maxActiveSources:10,maxActiveFragments:10,maxQuoteRows:20,maxQuoteRowsPerOwner:10,maxQuoteBytes:65536};
 const capacity_acceptance={schema:1,approved:true,profile_sha256:digestJSON(capacity_profile),candidate_sha:e.requireEpoch(epoch).binding.identity.candidate_sha,report_sha256:'f'.repeat(64),evidence_ref:'synthetic-fixture-only-no-measured-acceptance'};
 return{capacity_profile,capacity_acceptance};
}
module.exports={setup,planFor,boot,consent,source,capacityEvidence};

// Explicit atomic/native fixture. Existing boot/capacityEvidence callers retain
// their legacy test contract; these helpers require the actual Linux inspector.
function bootAtomic(t,{onRoot}={}){
 const x=setup(t);onRoot?.(x.root);const prior=process.env.AUXILO_SQLITE_TMPDIR,tempDirectory=path.join(x.root,'sqlite-runtime-temp');
 fs.mkdirSync(tempDirectory,{mode:0o700});process.env.AUXILO_SQLITE_TMPDIR=tempDirectory;
 t.after(()=>{if(prior===undefined)delete process.env.AUXILO_SQLITE_TMPDIR;else process.env.AUXILO_SQLITE_TMPDIR=prior;});
 return{...x,tempDirectory,epoch:op.bootstrapEpoch({...x,plan:planFor(x.root),stoppedWriterEvidence:{stopped:true,evidence_ref:'stop'}})};
}
function atomicCapacityEvidence(epoch,{fundingCents,spendFragments=0,returnCount=3,normalPathDiagnostic=false,quotePartitionBytes=2*1048576}={}){
 assert.ok(typeof normalPathDiagnostic==='boolean'&&(!normalPathDiagnostic||(fundingCents===100&&spendFragments===0&&returnCount===40)),'NORMAL_PATH_DIAGNOSTIC_FIXTURE_ONLY');
 assert.ok(Number.isSafeInteger(quotePartitionBytes)&&quotePartitionBytes>0&&quotePartitionBytes%4096===0&&quotePartitionBytes<=2*1048576,'QUOTE_PARTITION_FIXTURE_INVALID');
 assert.ok(Number.isSafeInteger(fundingCents)&&fundingCents>0&&fundingCents<=10000);
 assert.ok(Number.isSafeInteger(spendFragments)&&spendFragments>=0&&spendFragments<=100);
 assert.ok(Number.isSafeInteger(returnCount)&&returnCount>0&&returnCount<=10000);
 const MiB=1048576,proof=require('../../lib/money-sqlite-runtime');
 // Every cent is reserved even when the fixture returns only a few cents.
 // The quotas remain fail-closed; these values certify no production envelope.
 const sqlite={schema:1,maxDatabasePages:4096,maxGrowthPages:2048,maxNetOccupiedPages:2048,maxPagesPerMutation:1};
 sqlite.maxRollbackBytes=proof.deriveRollbackProof({...sqlite,maxRollbackBytes:Number.MAX_SAFE_INTEGER}).requiredRollbackBytes;
 sqlite.rollbackProofDigest=proof.deriveRollbackProof(sqlite).rollbackProofDigest;
 const sharedLiability={schema:1,systemBytes:MiB,optionalBytes:0,admissionBytes:4*MiB,fundingClosureBytes:MiB,fundingCentSlotBytes:normalPathDiagnostic?293*4096:131072,spendFragmentBytes:131072,spendCommonBytes:MiB};
 sharedLiability.capacityBytes=sharedLiability.systemBytes+sharedLiability.admissionBytes+sharedLiability.fundingClosureBytes+fundingCents*sharedLiability.fundingCentSlotBytes+spendFragments*sharedLiability.spendFragmentBytes+(spendFragments?sharedLiability.spendCommonBytes:0);
 const p={...capacityEvidence(epoch).capacity_profile,id:normalPathDiagnostic?'NORMAL-PATH-DIAGNOSTIC-NOT-ACCEPTED':'synthetic-native-flow-'+fundingCents+'-cent-slots',evidence_ref:normalPathDiagnostic?'NORMAL-PATH-DIAGNOSTIC-NOT-ACCEPTED':'synthetic-fixture-only-no-production-acceptance',maxRowBytes:32768,maxRawEventBytes:1024,slotBytes:normalPathDiagnostic?349*4096:270336,sourceClosureBytes:MiB,spendBytes:MiB,optionalBytes:normalPathDiagnostic?100*34*4096+8192:4*MiB,publicationBytes:MiB,maxActiveSources:2,maxActiveFragments:100,maxQuoteRows:100,maxQuoteRowsPerOwner:100,maxQuoteBytes:MiB,
 grouped:{schema:1,commitProtocol:'single_sql_v1',sharedBytes:sharedLiability.capacityBytes,maxGroupOwners:16,maxGroupRows:1000,sqlite,sharedLiability},
 workspace:{schema:2,scanRetainedBytes:4*MiB,quoteRetainedBytes:quotePartitionBytes,controlRetainedBytes:MiB,maxQuoteChangesPerCommit:101,workspaceRetainedBytes:5*MiB+quotePartitionBytes,workspaceScratchBytes:sqlite.maxRollbackBytes,maxWorkspaceMembers:Math.max(100,returnCount*2+10),maxConcurrentScans:1}};
 p.reserveBytes=fundingCents*p.slotBytes+p.sourceClosureBytes+p.optionalBytes+p.grouped.sharedBytes+spendFragments*p.spendBytes;
 require('../../lib/money-capacity').validateCapacityProfile(p,epoch);
 const capacity_acceptance={schema:1,approved:true,profile_sha256:digestJSON(p),candidate_sha:e.requireEpoch(epoch).binding.identity.candidate_sha,report_sha256:digestJSON({fixture:normalPathDiagnostic?'NORMAL-PATH-DIAGNOSTIC-NOT-ACCEPTED':'synthetic-native-flow',fundingCents,spendFragments,returnCount}),evidence_ref:normalPathDiagnostic?'NORMAL-PATH-DIAGNOSTIC-NOT-ACCEPTED':'synthetic-fixture-only-no-production-acceptance'};
 return{capacity_profile:p,capacity_acceptance};
}
async function initializeAtomicFixture(t,{epoch,writer,money,profile}){
 const store=money.store;
 t.after(()=>{try{store.close();}catch{}});
 await require('../../lib/money-capacity').initializeCapacityReserve({epoch,writer,store,profile});
 await require('../../lib/money-workspace').initializeWorkspaceCapacity({epoch,writer,store,profile:profile.workspace});
 assert.equal(store.initializeAtomicCapacityRuntime().state,'ready');
 assert.equal(store.atomicCapacityStatus().ready,true);
 return store;
}
module.exports.bootAtomic=bootAtomic;
module.exports.atomicCapacityEvidence=atomicCapacityEvidence;
module.exports.initializeAtomicFixture=initializeAtomicFixture;
