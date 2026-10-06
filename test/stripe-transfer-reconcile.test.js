"use strict";
const test=require('node:test');const assert=require('node:assert/strict');
const {verifyTransferEvidence,proposeReconciliation,applyReconciliation}=require('../lib/stripe-transfer-reconcile');
const a={attempt_id:'attempt-fixture',generation:2,state:'unknown',account_id:'acc_one',stripe_platform:'legacy',stripe_platform_account_id:'acct_fixture_old',configuration_generation:'generation',livemode:false,stripe_connect_id:'acct_destination',net_amount_cents:975,currency:'usd',request_digest:'a'.repeat(64)};
const context={stripe_platform:a.stripe_platform,stripe_platform_account_id:a.stripe_platform_account_id,configuration_generation:a.configuration_generation,livemode:false};
const transfer={id:'tr_fixture',object:'transfer',amount:975,currency:'usd',destination:'acct_destination',livemode:false,metadata:{auxilo_transfer_attempt_id:a.attempt_id,auxilo_request_digest:a.request_digest}};
test('D09 exact authenticated context and financial correlation yield sanitized proof',()=>{
 const result=verifyTransferEvidence(a,{...transfer,secret:'must-not-persist'},context);assert.equal(result.stripe_transfer_id,'tr_fixture');assert.equal(result.secret,undefined);assert.ok(result.evidence_ref);
});
for(const [field,value] of [['amount',974],['currency','eur'],['destination','acct_other'],['livemode',true],['metadata',{}]])test('D09 mismatched '+field+' cannot confirm',()=>assert.throws(()=>verifyTransferEvidence(a,{...transfer,[field]:value},context),/mismatch|evidence/i));
test('D09 wrong authenticated platform refuses provider read',async()=>{
 let reads=0;const proposal=await proposeReconciliation(a,{getContext:async()=>({...context,stripe_platform_account_id:'acct_wrong'}),retrieveTransfer:async()=>{reads++;return transfer;}});assert.equal(proposal.kind,'hold');assert.equal(reads,0);
});
test('D09 known transfer retrieval is read-only; not-found never proves no send',async()=>{
 let reads=0;const p=await proposeReconciliation({...a,stripe_transfer_id:'tr_fixture'},{getContext:async()=>context,retrieveTransfer:async()=>{reads++;return null;}});assert.equal(p.kind,'hold');assert.equal(reads,1);
});
test('D09 unknown ID requires unique externally collected evidence',async()=>{
 const provider={getContext:async()=>context};assert.equal((await proposeReconciliation(a,provider)).kind,'hold');assert.equal((await proposeReconciliation(a,provider,{correlationEvidence:[transfer,transfer]})).kind,'hold');
 assert.equal((await proposeReconciliation(a,provider,{correlationEvidence:[transfer],evidenceReference:'fixture-evidence'})).kind,'confirmed');
});
test('D09 prepared state and unsupported negative claims cannot authorize not-sent',async()=>{
 const p=await proposeReconciliation({...a,state:'prepared'},{getContext:async()=>context},{notSentEvidence:{supported:true,reason:'prepared'}});assert.equal(p.kind,'hold');
});
test('D09 fabricated or stale proposal cannot mutate local state',async()=>{
 let changes=0;const store={get:()=>({...a,generation:3}),transition:()=>{changes++;}};
 await assert.rejects(()=>applyReconciliation({store,attemptId:a.attempt_id,proposal:{kind:'confirmed',attempt_id:a.attempt_id,generation:2,evidence:{}},withLocks:async(_a,fn)=>fn(),complete:async()=>{changes++;}}),/proposal|generation|stale/i);assert.equal(changes,0);
});
test('D10 confirmed local completion executes within lock and preserves insufficient-balance hold',async()=>{
 let current={...a};let locked=false;let changes=0;
 const store={get:()=>({...current}),transition:(_id,_generation,state,patch)=>{assert.equal(locked,true);current={...current,...patch,state,generation:current.generation+1};changes++;return current;}};
 const proposal=await proposeReconciliation(a,{getContext:async()=>context},{correlationEvidence:[transfer],evidenceReference:'fixture-evidence'});
 const result=await applyReconciliation({store,attemptId:a.attempt_id,proposal,withLocks:async(_a,fn)=>{locked=true;try{return await fn();}finally{locked=false;}},complete:async()=>{assert.equal(locked,true);return {status:'confirmed',reason:'INSUFFICIENT_BALANCE'};}});
 assert.equal(current.state,'confirmed');assert.equal(changes,1);assert.equal(result.reason,'INSUFFICIENT_BALANCE');assert.equal(locked,false);
});

test('D09 restarted read-only client can verify same platform without reviving old send context',async()=>{
 const restarted={...context,configuration_generation:'new-process-generation'};
 assert.throws(()=>verifyTransferEvidence(a,transfer,restarted),/context.*mismatch/i);
 const p=await proposeReconciliation(a,{getContext:async()=>restarted},{correlationEvidence:[transfer],evidenceReference:'independent-history-fixture'});
 assert.equal(p.kind,'confirmed');assert.equal(p.evidence.configuration_generation,a.configuration_generation);assert.equal(p.evidence.observed_configuration_generation,restarted.configuration_generation);
});

test('D09 authoritative negative proposal cannot override a persisted debit marker',async()=>{
 const provider={getContext:async()=>context,determineNotSent:async()=>({authoritative:true,reviewed:true,supported_provider_determination:true,attempt_id:a.attempt_id,request_digest:a.request_digest,stripe_platform_account_id:a.stripe_platform_account_id,evidence_ref:'reviewed-provider-negative-fixture'})};
 const proof=await proposeReconciliation(a,provider);assert.equal(proof.kind,'confirmed_not_sent');let changes=0;
 await assert.rejects(()=>applyReconciliation({store:{get:()=>({...a}),transition:()=>{changes++;}},attemptId:a.attempt_id,proposal:proof,withLocks:async(_a,fn)=>fn(),complete:async()=>{changes++;},getContradictions:async()=>({marker:true,receipt:false,transfer:false})}),/contradict/i);assert.equal(changes,0);
});

test('D10 real confirmed-unapplied store resumes local completion after client generation restart',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
 const {createAttemptStore,initializeAttemptStore}=require('../lib/stripe-transfer-attempts');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'d0-confirmed-restart-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'attempts.json');
 initializeAttemptStore(file,{sha256:'a'.repeat(64),inventory_complete:true,positive_history_attestation:true,history_interval:{start:'2026-01-01',end:'2026-10-01'},platforms:[{stripe_platform:'legacy',stripe_platform_account_id:'acct_fixture_old',livemode:false},{stripe_platform:'auxilo_llc',stripe_platform_account_id:'acct_fixture_new',livemode:false}]});
 let store=createAttemptStore({file}),attempt=store.prepare({...context,account_id:'acc_one',earnings_key_at_creation:'acc_one',wallet_at_creation:null,client_request_key:crypto.randomUUID(),stripe_connect_id:'acct_destination',amount_usd:10,net_amount_cents:975,currency:'usd'});
 attempt=store.transition(attempt.attempt_id,attempt.generation,'submitted');const sameTransfer={...transfer,metadata:{auxilo_transfer_attempt_id:attempt.attempt_id,auxilo_request_digest:attempt.request_digest}};
 const originalEvidence=verifyTransferEvidence(attempt,sameTransfer,context);attempt=store.transition(attempt.attempt_id,attempt.generation,'confirmed',{stripe_transfer_id:originalEvidence.stripe_transfer_id,provider_evidence:originalEvidence});
 attempt=store.transition(attempt.attempt_id,attempt.generation,'confirmed',{reconciliation_reason:'insufficient_current_earnings'});
 store=createAttemptStore({file});const originalBytes=fs.readFileSync(file,'utf8');const restartedContext={...context,configuration_generation:'restarted-client-generation'};
 const proof=await proposeReconciliation(attempt,{getContext:async()=>restartedContext,retrieveTransfer:async()=>sameTransfer});assert.equal(proof.kind,'confirmed');let completed=0,locked=false;
 const result=await applyReconciliation({store,attemptId:attempt.attempt_id,proposal:proof,withLocks:async(_a,fn)=>{locked=true;try{return await fn();}finally{locked=false;}},complete:async current=>{assert.equal(locked,true);assert.deepEqual(current.provider_evidence,originalEvidence);assert.equal(current.generation,attempt.generation);completed++;return {local_completion_invoked:true};}});
 assert.equal(result.local_completion_invoked,true);assert.equal(completed,1);assert.equal(locked,false);assert.equal(fs.readFileSync(file,'utf8'),originalBytes);
});
