"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAttemptStore, initializeAttemptStore, requestDigest, publicStatus } = require('../lib/stripe-transfer-attempts');
const { digestJSON, readJSONStrict, writeJSONAtomic, appendJSONLOnce, readJSONLStrict, normalizeMarkers } = require('../lib/stripe-transfer-persistence');
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stripe-attempt-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'attempts.json');
  const manifest={sha256:'a'.repeat(64), inventory_complete:true, positive_history_attestation:true, history_interval:{start:'2026-01-01',end:'2026-10-01'},platforms:[{stripe_platform:'legacy',stripe_platform_account_id:'acct_fixture_old',livemode:false},{stripe_platform:'auxilo_llc',stripe_platform_account_id:'acct_fixture_new',livemode:false}]};
  initializeAttemptStore(file,manifest);
  return {dir,file,store:createAttemptStore({file}),manifest};
}
function input(overrides={}) {return {account_id:'acc_one',earnings_key_at_creation:'acc_one',wallet_at_creation:'0xabc',client_request_key:crypto.randomUUID(),stripe_platform:'legacy',stripe_platform_account_id:'acct_fixture_old',configuration_generation:'fixture-generation',livemode:false,stripe_connect_id:'acct_destination',amount_usd:10,net_amount_cents:975,currency:'usd',...overrides};}
function evidence(a){return {stripe_transfer_id:'tr_fixture',amount_cents:a.net_amount_cents,currency:a.currency,destination:a.stripe_connect_id,livemode:a.livemode,stripe_platform:a.stripe_platform,stripe_platform_account_id:a.stripe_platform_account_id,configuration_generation:a.configuration_generation,attempt_id:a.attempt_id,request_digest:a.request_digest,evidence_ref:'sha256:'+ 'b'.repeat(64)};}
test('D01 prepared identity survives restart and same request cannot create twice',t=>{
 const {store,file}=fixture(t);const data=input(); const a=store.prepare(data);
 assert.equal(a.request_digest,requestDigest(10));assert.equal(a.state,'prepared');assert.equal(a.generation,1);
 assert.deepEqual(createAttemptStore({file}).findByRequest('acc_one',data.client_request_key),a);
 assert.throws(()=>store.prepare(data),/REQUEST|binding/i);
 assert.throws(()=>store.prepare({...data,amount_usd:11}),/REQUEST|binding/i);
 assert.equal(store.all().length,1);
});
test('D01 immutable fields and stale transition generations fail without writes',t=>{
 const {store,file}=fixture(t);const a=store.prepare(input());const bytes=fs.readFileSync(file,'utf8');
 assert.throws(()=>store.transition(a.attempt_id,a.generation,'submitted',{stripe_connect_id:'acct_other'}),/immutable|field/i);
 assert.equal(fs.readFileSync(file,'utf8'),bytes);
 const submitted=store.transition(a.attempt_id,a.generation,'submitted');
 assert.ok(submitted.submitted_at);assert.throws(()=>store.transition(a.attempt_id,a.generation,'unknown'),/generation/i);
});
test('D02 submitted and unknown survive arbitrary elapsed time and block aliases',t=>{
 const {store,file}=fixture(t);let a=store.prepare(input());a=store.transition(a.attempt_id,a.generation,'submitted');a=store.transition(a.attempt_id,a.generation,'unknown',{last_error_code:'PROVIDER_OUTCOME_UNKNOWN'});
 const restarted=createAttemptStore({file}); assert.equal(restarted.current('acc_one').state,'unknown');
 assert.equal(restarted.blocking({wallet:'0xabc'},{acc_one:{wallet:'0xnew'}},{__wallet_index:{'0xabc':'acc_one'}}).attempt_id,a.attempt_id);
 assert.throws(()=>restarted.prepare(input({stripe_platform:'auxilo_llc',stripe_platform_account_id:'acct_fixture_new',stripe_connect_id:'acct_other'})),/IN_FLIGHT/);
 assert.throws(()=>restarted.transition(a.attempt_id,a.generation,'submitted'),/transition/i);
});
test('D03 owner-scoped keys and recorded receipt remain stable after restart',t=>{
 const {store,file}=fixture(t);const data=input();let a=store.prepare(data);
 store.prepare(input({account_id:'acc_two',earnings_key_at_creation:'acc_two',wallet_at_creation:null,client_request_key:data.client_request_key}));
 a=store.transition(a.attempt_id,a.generation,'submitted');a=store.transition(a.attempt_id,a.generation,'confirmed',{stripe_transfer_id:'tr_fixture',provider_evidence:evidence(a)});
 const record={attempt_id:a.attempt_id,request_digest:a.request_digest,account_id:a.account_id,rail:'stripe',amount_usd:10,amount_cents:1000,net_amount_cents:975,net_amount_usd:9.75,stripe_fee_cents:25,stripe_transfer_id:'tr_fixture',stripe_connect_id:a.stripe_connect_id,stripe_platform:a.stripe_platform,stripe_platform_account_id:a.stripe_platform_account_id};
 const receipt={transfer_id:'tr_fixture',remaining_balance:7,attempt_id:a.attempt_id,status:'completed'};
 a=store.transition(a.attempt_id,a.generation,'ledger_applied',{receipt_record:record,receipt_digest:digestJSON(record),receipt});a=store.transition(a.attempt_id,a.generation,'completed');
 const r=createAttemptStore({file});assert.deepEqual(r.findByRequest('acc_one',data.client_request_key).receipt,receipt);assert.equal(r.get(a.attempt_id,'acc_two'),null);
 assert.equal(publicStatus(a).client_request_key,data.client_request_key);assert.equal(publicStatus(a).stripe_connect_id,undefined);
});
test('D01 owner generation rejects a queued new request after first completes',t=>{
 const {store}=fixture(t);const admitted=store.ownerGeneration('acc_one');store.prepare(input());
 assert.throws(()=>store.prepare(input(),{expectedOwnerGeneration:admitted}),/STATE_CHANGED/);
});
test('D08 missing corrupt and checksum-tampered stores never initialize themselves',t=>{
 const {file}=fixture(t);const state=readJSONStrict(file);state.generation++;fs.writeFileSync(file,JSON.stringify(state));
 assert.equal(createAttemptStore({file}).ready,false);fs.writeFileSync(file,'{');assert.equal(createAttemptStore({file}).ready,false);
 fs.unlinkSync(file);assert.equal(createAttemptStore({file}).ready,false);assert.equal(fs.existsSync(file),false);
 assert.throws(()=>initializeAttemptStore(file,{}),/manifest|inventory/i);
});
test('D08 unresolved missing owner globally disables store readiness',t=>{
 const {store}=fixture(t);store.prepare(input());assert.equal(store.checkIdentities({},{}),false);assert.equal(store.ready,false);
});
test('D06 atomic failures are surfaced and synchronous publication never occurs',t=>{
 const {dir}=fixture(t);const file=path.join(dir,'atomic.json');fs.writeFileSync(file,'{"old":true}');
 const io=Object.create(fs);io.renameSync=()=>{throw new Error('injected rename failure');};
 assert.throws(()=>writeJSONAtomic(file,{new:true},{fsImpl:io}),e=>e.financialStorageFailure===true);
 assert.deepEqual(readJSONStrict(file),{old:true});
});
test('D06 receipts deduplicate exact matches and reject conflicting or torn logs',t=>{
 const {dir}=fixture(t);const file=path.join(dir,'receipts.jsonl');const r={attempt_id:'one',amount:10};
 assert.equal(appendJSONLOnce(file,r).appended,true);assert.equal(appendJSONLOnce(file,r).appended,false);
 assert.throws(()=>appendJSONLOnce(file,{...r,amount:11}),/conflict/i);assert.equal(readJSONLStrict(file).length,1);
 fs.appendFileSync(file,'{"attempt_id":');assert.throws(()=>appendJSONLOnce(file,{attempt_id:'two'}),/torn|JSON|line/i);
});
test('D05 legacy marker forms preserve every unique ID and invalid shapes reject',()=>{
 assert.deepEqual(normalizeMarkers(undefined),[]);assert.deepEqual(normalizeMarkers(['a','a','b']),['a','b']);assert.deepEqual(normalizeMarkers({a:false,b:true}),['a','b']);
 for(const bad of [null,1,'x',[null]])assert.throws(()=>normalizeMarkers(bad),/marker/i);
});

test('D07D settlement status history can retain same-ID transitions without weakening receipt validation',t=>{
 const {dir}=fixture(t);const file=path.join(dir,'history.jsonl');fs.writeFileSync(file,'{"id":"s1","status":"pending"}\n{"id":"s1","status":"retry"}\n');
 assert.throws(()=>readJSONLStrict(file),/conflict/i);assert.equal(readJSONLStrict(file,{validateDuplicateIds:false}).length,2);fs.appendFileSync(file,'{');assert.throws(()=>readJSONLStrict(file,{validateDuplicateIds:false}),/torn/i);
});
