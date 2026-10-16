'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {stageServer,reservePort,bootServer,stopServer}=require('./helpers/staged-server');
const ROOT=path.join(__dirname,'..');
test('real Linux epoch server owns the volume before imports and serves separated status without provider calls',{skip:process.platform!=='linux',timeout:60000},async t=>{
 const fixtures=require('./helpers/financial-epoch-fixture'),fixture=fixtures.bootAtomic(t);
 // A prospective epoch cannot boot without its capacity reserve (money-control.js initializeMoneyRuntime requires it; gate() throws CAPACITY_RESERVE_REQUIRED).
 // The reserve is an explicit operator step, so provision it through the same supported recipe the other native fixtures use (profile and acceptance evidence,
 // initializeCapacityReserve, initializeWorkspaceCapacity, atomic capacity runtime) BEFORE releasing the writer. Only the identity capability is activated.
 const capacityEvidence=fixtures.atomicCapacityEvidence(fixture.epoch,{fundingCents:1});
 const epoch=require('../lib/financial-epoch-operator').transitionEpoch({epoch:fixture.epoch,writer:fixture.writer,expectedRevision:0,patch:{identity:true},evidence:{approval_ref:'synthetic-runtime',identity:'a'.repeat(64)},financialEvidence:capacityEvidence});
 const money=require('../lib/money-control').initializeMoneyRuntime({epoch,writer:fixture.writer});
 await fixtures.initializeAtomicFixture(t,{epoch,writer:fixture.writer,money,profile:capacityEvidence.capacity_profile});
 money.store.close();
 fixture.writer.close();
 const apiKey='axl_synthetic_owner';
 const epochPaths=require('../lib/financial-epoch');
 fs.writeFileSync(epochPaths.pathFor('accounts',epoch),JSON.stringify({owner:{id:'owner',email:'owner@example.invalid',api_key_hash:require('node:crypto').createHash('sha256').update(apiKey).digest('hex')}}));
 fs.writeFileSync(path.join(fixture.root,'learnings.json'),JSON.stringify([
  {id:'owner-public',title:'Owned public fixture',body:'synthetic content',status:'approved',visibility:'public',contributor_account_id:'owner',unlock_price:0.05},
  {id:'owner-private',title:'Owned private fixture',body:'synthetic private content',status:'approved',visibility:'private',contributor_account_id:'owner',unlock_price:0.05},
  {id:'platform-paid',title:'Paid fixture',body:'synthetic paid content',status:'approved',visibility:'public',contributor_account_id:'acc_platform',unlock_price:0.05}
 ]));
 const originals=Object.fromEntries(['accounts.json','credits.json','stripe-history-coverage.json'].filter(n=>fs.existsSync(path.join(fixture.root,n))).map(n=>[n,fs.readFileSync(path.join(fixture.root,n),'utf8')]));
 const stage=fs.mkdtempSync(path.join(os.tmpdir(),'emfr-server-'));t.after(()=>fs.rmSync(stage,{recursive:true,force:true}));
 const {port}=await reservePort();assert.ok(port);
 stageServer({repoRoot:ROOT,tmpDir:stage,nodeModulesDir:path.join(ROOT,'node_modules'),port,rootFiles:['server.js','skills.json','openapi.json','package.json','model_config.json'],linkDirs:['public','prompts'],copyDirs:['lib','config']});
 fs.writeFileSync(path.join(stage,'deny-network.cjs'),"const deny=()=>{throw Error('SYNTHETIC_NETWORK_DENIED')};require('http').request=deny;require('https').request=deny;global.fetch=deny;");
 const boot=await bootServer({tmpDir:stage,port,env:{HOME:stage,AUXILO_HOME:stage,AUXILO_DATA_DIR:fixture.root,AUXILO_WAL_DIR:'',AUXILO_SQLITE_TMPDIR:fixture.tempDirectory,NODE_ENV:'test',NODE_OPTIONS:'--require='+path.join(stage,'deny-network.cjs'),SESSION_SECRET:'synthetic-only-'.repeat(5),WALLET_PRIVATE_KEY:'0x'+'11'.repeat(32),LLM_SENSITIVITY_ENABLED:'false',PAYMENTS_ENABLED:'true',AUXILO_RUNNER_AUTOUPDATE:'0'},timeoutMs:20000,maxAttempts:1});
 assert.ok(boot.child);t.after(()=>stopServer(boot.child));
 const health=await(await fetch('http://127.0.0.1:'+port+'/health')).json();assert.equal(health.payments_enabled,false);assert.equal(health.financial_epoch.funding_available,false);assert.equal(health.financial_epoch.buyer_return_available,false);
 const moneyBefore=fs.readFileSync(epochPaths.pathFor('money_control',epoch),'utf8');
 for(const id of ['owner-public','owner-private']) {
  const response=await fetch('http://127.0.0.1:'+port+'/knowledge/'+id,{headers:{'X-API-Key':apiKey}});
  assert.equal(response.status,200,id);const body=await response.json();assert.equal(body._revenue.owner_recall_free,true);assert.equal(body._revenue.amount_paid_usd,0);
 }
 const hidden=await fetch('http://127.0.0.1:'+port+'/knowledge/owner-private');assert.equal(hidden.status,404);
 const paid=await fetch('http://127.0.0.1:'+port+'/knowledge/platform-paid',{headers:{'X-API-Key':apiKey}});assert.equal(paid.status,503);
 assert.equal(fs.readFileSync(epochPaths.pathFor('money_control',epoch),'utf8'),moneyBefore,'free recall and denied paid reads leave financial journal unchanged');
 const magic=await fetch('http://127.0.0.1:'+port+'/auth/magic-link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'new@example.invalid'})});assert.equal(magic.status,200);
 const stored=JSON.parse(fs.readFileSync(require('../lib/financial-epoch').pathFor('magic_links',epoch)));assert.equal(Object.values(stored).length,1);
 for(const[n,bytes]of Object.entries(originals))assert.equal(fs.readFileSync(path.join(fixture.root,n),'utf8'),bytes,n);
 const paused=await fetch('http://127.0.0.1:'+port+'/withdraw/stripe',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(paused.status,503);
});
