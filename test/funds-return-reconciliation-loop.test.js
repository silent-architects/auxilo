'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function fixture({uncertain=false}={}){
 const text=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8'),start=text.indexOf('let moneyReconcileRunning = false;'),end=text.indexOf('if (prospectiveEpoch) {',start);assert.ok(start>=0&&end>start);
 const calls=[],pages=[],errors=[];let n=0;
 const context={prospectiveEpoch:{capabilities:{reconcile:true}},prospectiveMoney:{store:{uncertain,listPendingOperations:options=>{pages.push(options);return{items:n++?[]:[{id:'blocked',type:'buyer_return'},{id:'healthy',type:'buyer_return'}],nextCursor:n===1?'next':null};}}},fundsReturnService:{reconcile:async({operationId})=>{calls.push(operationId);if(operationId==='blocked')throw Object.assign(new Error('scoped error'),{code:'RETURN_PROVIDER_UNAVAILABLE'});}},reconcileEpochFinancialEvent:{reconcilePending:async()=>calls.push('events')},applyPendingMoneyProjections:async()=>calls.push('projections'),console:{error:(...args)=>errors.push(args)}};
 vm.createContext(context);vm.runInContext(text.slice(start,end),context);return{context,calls,pages,errors};
}
test('one scoped return failure does not starve later operations or the next page',async()=>{
 const f=fixture();await f.context.reconcileProspectiveMoney();await f.context.reconcileProspectiveMoney();
 assert.deepEqual(f.calls,['blocked','healthy','events','projections','events','projections']);assert.equal(f.pages[0].after,null);assert.equal(f.pages[1].after,'next');assert.equal(f.errors.length,1);
});
test('uncertain money store halts the reconciliation batch',async()=>{
 const f=fixture({uncertain:true});await assert.rejects(f.context.reconcileProspectiveMoney(),{code:'RETURN_PROVIDER_UNAVAILABLE'});assert.deepEqual(f.calls,['blocked']);
});
