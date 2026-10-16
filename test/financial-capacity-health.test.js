'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {Hono}=require('hono');
async function health(capacity,prospective=true){
 const text=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8'),start=text.indexOf("app.get('/health',"),end=text.indexOf('// GET /ready:',start);assert.ok(start>0&&end>start);
 const app=new Hono();vm.runInNewContext(text.slice(start,end),{app,process:{uptime:()=>1},getMigrationControl:()=>({ready:true,allow_checkout:true}),stripePlatforms:{getPlatformStatus:()=>({configured:true})},prospectiveEpoch:prospective?{platform:'auxilo_llc',policy_evidence:{published:true,policy_version:'policy'}}:null,prospectiveMoney:{capacityStatus:input=>{assert.equal(input.amountMicros,10000000,'readiness must reserve the smallest offered pack');return capacity;}},PACKS:{starter:{price_usd:10},largest:{price_usd:100}},moneyControl:{toMicros:n=>n*1000000},CURRENT_TOS_VERSION:'policy',paymentsEnabled:()=>true,checkoutIntents:{ready:true},visibleLearningsList:()=>[],skills:[],stripeTransferStore:{ready:false,all:()=>[]},financialStorageFailed:false,historyCoverage:{historyFinancialBlocked:()=>false}});
 return (await app.request('/health')).json();
}
test('health with configured Stripe still refuses funding without measured physical capacity',async()=>{
 for(const reason of ['CAPACITY_MEASUREMENT_ACCEPTANCE_REQUIRED','CAPACITY_RESERVE_REQUIRED','CAPACITY_DISK_HEADROOM_REQUIRED','CAPACITY_FUNDING_UNAVAILABLE']){
  const value=await health({newAdmissionAvailable:false,reason});assert.equal(value.status,'ok');assert.equal(value.financial_epoch.funding_available,false);assert.equal(value.financial_epoch.capacity_reason,reason);assert.equal(value.financial_epoch.buyer_return_available,true,'owed return availability is not disabled by new-funding headroom');
 }
 const value=await health({newAdmissionAvailable:true,reason:null});assert.equal(value.financial_epoch.funding_available,true);assert.equal(value.financial_epoch.capacity_available,true);
});
test('legacy health remains independent of prospective capacity',async()=>{const value=await health(null,false);assert.equal(value.financial_epoch,null);assert.equal(value.stripe_configured,true);});
