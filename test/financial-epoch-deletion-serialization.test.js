'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
const start=source.indexOf('async function executeAccountDeletion('),end=source.indexOf('async function executeAccountDeletionInner(',start);
assert.ok(start>=0&&end>start);
test('deletion dependency decision and account removal share one money ownership interval',async t=>{
 const {epoch,writer}=require('./helpers/financial-epoch-fixture').boot(t);
 const store=require('../lib/money-control-store').openMoneyStore({epoch,writer});
 const control=require('../lib/money-control').createMoneyControl({store,epoch,writer});
 const sequence=[];let accountExists=true;let signalInspected;const inspected=new Promise(r=>signalInspected=r);
 const competing=inspected.then(()=>control.withMoneyControl({},()=>{sequence.push('competing admission');assert.equal(accountExists,false,'admission cannot enter between inspection and deletion');}));
 const runtime={runInMoneyContext:(fn,opts)=>control.withMoneyControl(opts,fn)};
 const context={prospectiveEpoch:epoch,moneyWriter:writer,moneyControl:runtime,Date,currentLifecycleControl:()=>({}),
  require:id=>{assert.equal(id,'./lib/money-lifecycle');return{requestAccountDeletion:async({coordinator})=>coordinator.withMoneyControl({},async ctx=>{
   assert.ok(ctx);sequence.push('inspect');
   signalInspected();
   await Promise.resolve();return{allowed:true};
  })};},
  executeAccountDeletionInner:async()=>{sequence.push('delete');accountExists=false;return{deleted:true};}
 };
 const run=vm.runInNewContext(source.slice(start,end)+';executeAccountDeletion',context);
 assert.equal((await run({accountId:'owner',method:'email'})).deleted,true);await competing;
 assert.deepEqual(sequence,['inspect','delete','competing admission']);
});
