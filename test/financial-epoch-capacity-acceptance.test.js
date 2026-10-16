"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict');
const {boot,capacityEvidence}=require('./helpers/financial-epoch-fixture');
const e=require('../lib/financial-epoch'),op=require('../lib/financial-epoch-operator');
function options(epoch,writer,action,financialEvidence){return{epoch,writer,expectedRevision:0,patch:{[action]:true},evidence:{[action]:'a'.repeat(64),approval_ref:'synthetic-fixture'},financialEvidence,policyEvidence:{policy_version:epoch.policy_ref,effective_at:epoch.not_before,published:true,disclosure_sha256:'a'.repeat(64),evidence_ref:'b'.repeat(64)}};}
test('declared capacity alone cannot enable funding, spend, or buyer return',t=>{
 const {epoch,writer}=boot(t),{capacity_profile}=capacityEvidence(epoch);
 for(const action of ['funding','spend','buyer_return'])assert.throws(()=>op.transitionEpoch(options(epoch,writer,action,{capacity_profile})),/EPOCH_CAPACITY_ACCEPTANCE_REQUIRED/);
});
test('capacity acceptance is exact and bound to the profile and candidate',t=>{
 const {epoch,writer}=boot(t);
 for(const mutation of [x=>x.capacity_acceptance.profile_sha256='0'.repeat(64),x=>x.capacity_acceptance.candidate_sha='0'.repeat(40),x=>x.capacity_acceptance.report_sha256='X'.repeat(64),x=>x.capacity_acceptance.extra=true,x=>x.capacity_acceptance.evidence_ref='x'.repeat(513),x=>delete x.capacity_profile]){
  const value=capacityEvidence(epoch);mutation(value);assert.throws(()=>op.transitionEpoch(options(epoch,writer,'spend',value)),/EPOCH_CAPACITY_ACCEPTANCE_INVALID/);
 }
});
test('explicit synthetic accepted pair permits the fixture transition',t=>{
 const {epoch,writer}=boot(t);const next=op.transitionEpoch(options(epoch,writer,'funding',capacityEvidence(epoch)));assert.equal(next.capabilities.funding,true);
 const {binding,control}=e.requireEpoch(next),forged=structuredClone(control);delete forged.financial_evidence.capacity_acceptance;assert.throws(()=>e.validateControl(e.seal(forged),binding),/EPOCH_CAPACITY_ACCEPTANCE_REQUIRED/);
});
test('reconciliation remains independent of new admission acceptance',t=>{
 const {epoch,writer}=boot(t);const next=op.transitionEpoch(options(epoch,writer,'reconcile'));assert.equal(next.capabilities.reconcile,true);assert.equal(next.capabilities.funding,false);
});
