'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {envelope,percentile,benchmark}=require('../scripts/benchmark-money-control');
test('capacity has no discretionary admission before an explicitly accepted measured profile',()=>{
 assert.equal(envelope({databaseBytes:0}).new_admission_available,false);
 assert.equal(envelope({databaseBytes:0},{accepted:false,limits:{databaseBytes:100}}).reason,'CAPACITY_PROFILE_REQUIRED');
});
test('measured profile warns at75percent and closes discretionary admission at every exact bound',()=>{
 const profile={accepted:true,limits:{databaseBytes:1000,activeSources:10}};
 assert.deepEqual(envelope({databaseBytes:750,activeSources:2},profile).warnings,['databaseBytes']);
 assert.equal(envelope({databaseBytes:0,activeSources:10},profile).new_admission_available,false);
 assert.deepEqual(envelope({databaseBytes:1001,activeSources:2},profile).exceeded,['databaseBytes']);
 assert.throws(()=>envelope({databaseBytes:0},profile),/INVALID_CAPACITY_MEASUREMENT/);
});
test('percentile reports tail observations and rejects invalid measurements',()=>{
 assert.equal(percentile([1,2,3,4,100],.99),100);assert.throws(()=>percentile([],.95),/EMPTY/);assert.throws(()=>percentile([NaN],.95),/INVALID/);assert.throws(()=>percentile([1],0),/INVALID/);
});
test('non-Linux benchmark refuses to claim deployment proof',{skip:process.platform==='linux'},async()=>{await assert.rejects(benchmark(),/LINUX_PERFORMANCE_PROOF_REQUIRED/);});
