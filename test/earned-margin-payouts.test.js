'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createFundsReturnService}=require('../lib/funds-return');
test('contributor fixed fee and gas estimate never enable a return rail or write/send',async()=>{let writes=0,sends=0;const service=createFundsReturnService({epoch:{},store:{read:()=>({sources:{},operations:{}})},coordinator:{withMoneyControl:()=>{writes++;}},provider:{submit:()=>{sends++;}}});for(const rail of ['stripe_contributor','usdc'])await assert.rejects(service.quote({accountId:'a',sourceId:'s',maxGrossMicros:1000000,rail}),{code:'RETURN_RAIL_UNAVAILABLE'});assert.equal(writes,0);assert.equal(sends,0);});
