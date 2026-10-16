'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {stageServer,reservePort,bootServer,stopServer}=require('./helpers/staged-server'),ROOT=path.resolve(__dirname,'..');
for(const phase of ['marker-durable','prewal-marker','pending-reversal','credits-before-rename'])test('actual server boot handles retained '+phase,{skip:process.platform!=='linux'?'requires actual patched Linux server runtime':false,timeout:60000},async t=>{
 const box=fs.mkdtempSync(path.join(os.tmpdir(),'compensation-server-')),locator=path.join(box,'locator.json');let root,child;
 t.after(async()=>{await stopServer(child);if(root)fs.rmSync(root,{recursive:true,force:true});fs.rmSync(box,{recursive:true,force:true});});
 const created=spawnSync(process.execPath,[path.join(__dirname,'money-compensation-native.test.js')],{env:{...process.env,EMFR_COMPENSATION_REQUEST:JSON.stringify({mode:'create',phase,locator})},encoding:'utf8',timeout:30000});
 if(fs.existsSync(locator))root=JSON.parse(fs.readFileSync(locator)).root;assert.equal(created.status,73,created.stdout+created.stderr);assert.ok(root);
 const location=JSON.parse(fs.readFileSync(locator)),earningsPath=location.earningsPath,beforeEarnings=fs.readFileSync(earningsPath),beforeWal=fs.readdirSync(location.walDirectory);assert.ok(location.financialDirectory.startsWith(root+path.sep));if(phase==='credits-before-rename')assert.equal(fs.readdirSync(location.financialDirectory).filter(n=>n.endsWith('.tmp')).length,1,'server must receive the actual retained candidate');
 const {port}=await reservePort();assert.ok(port,'Linux loopback must be available');const stage=path.join(box,'server');
 stageServer({repoRoot:ROOT,tmpDir:stage,nodeModulesDir:path.join(ROOT,'node_modules'),port,rootFiles:['server.js','skills.json','openapi.json','package.json','model_config.json'],linkDirs:['public','prompts'],copyDirs:['lib','config']});
 fs.writeFileSync(path.join(stage,'deny-network.cjs'),"const deny=()=>{throw Error('SYNTHETIC_NETWORK_DENIED')};require('http').request=deny;require('https').request=deny;global.fetch=deny;");
 const boot=await bootServer({tmpDir:stage,port,env:{HOME:stage,AUXILO_HOME:stage,AUXILO_DATA_DIR:root,AUXILO_WAL_DIR:'',AUXILO_SQLITE_TMPDIR:path.join(root,'sqlite-runtime-temp'),NODE_ENV:'test',NODE_OPTIONS:'--require='+path.join(stage,'deny-network.cjs'),SESSION_SECRET:'synthetic-only-'.repeat(5),WALLET_PRIVATE_KEY:'0x'+'11'.repeat(32),LLM_SENSITIVITY_ENABLED:'false',PAYMENTS_ENABLED:'true',AUXILO_RUNNER_AUTOUPDATE:'0'},timeoutMs:20000,maxAttempts:1});child=boot.child;assert.ok(child,boot.output);
 const healthResponse=await fetch('http://127.0.0.1:'+port+'/health'),health=await healthResponse.json();assert.equal(healthResponse.status,200,JSON.stringify(health));
 const credits=JSON.parse(fs.readFileSync(location.creditsPath));if(phase==='credits-before-rename')assert.equal(fs.readdirSync(location.financialDirectory).filter(n=>n.endsWith('.tmp')).length,0);
 if(phase==='pending-reversal'){
  assert.equal(health.financial_epoch.capacity_available,false);assert.equal(health.financial_epoch.capacity_reason,'FINANCIAL_RECOVERY_REQUIRED');assert.equal(credits.buyer.dollar_lots[0].funded_unlocks[0].pending_reversal,true);assert.equal(credits.buyer.dollar_lots[0].remaining_usd,0);
  assert.deepEqual(fs.readdirSync(location.walDirectory),beforeWal);assert.deepEqual(fs.readFileSync(earningsPath),beforeEarnings,'boot must not duplicate accrual or invent a reversal');
 }else{
  assert.equal(credits.buyer.dollar_lots[0].remaining_usd,0.02);assert.equal(fs.readdirSync(location.walDirectory).filter(x=>/\.(wal|compensation)\.json$/.test(x)).length,0);assert.notEqual(health.financial_epoch.capacity_reason,'FINANCIAL_RECOVERY_REQUIRED');assert.deepEqual(fs.readFileSync(earningsPath),beforeEarnings,'no-accrual compensation must not subtract earnings');
 }
});
