'use strict';
// D04/D05/D05L/D06: execute the production completion/link functions against
// synthetic durable files. No server boot, credentials, or provider network.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { Hono } = require('hono');
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd0-ledger-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const parsed = spawnSync(process.execPath, ['--expose-internals', '-e', `
const fs=require('fs'), acorn=require('internal/deps/acorn/acorn/dist/acorn');
const s=fs.readFileSync(process.argv[1],'utf8'), out={};
for(const n of acorn.parse(s,{ecmaVersion:'latest'}).body){
 if(n.type==='FunctionDeclaration')out[n.id.name]=s.slice(n.start,n.end);
 if(n.type==='ExpressionStatement'&&n.expression.type==='CallExpression'){
 const x=n.expression;if(x.callee.type==='MemberExpression'&&x.callee.object.name==='app'&&x.arguments[0]?.type==='Literal')out[x.callee.property.name+' '+x.arguments[0].value]=s.slice(n.start,n.end);
 }}console.log(JSON.stringify(out));`, path.join(root, 'server.js')], { encoding: 'utf8' });
assert.equal(parsed.status, 0, parsed.stderr);
const source = JSON.parse(parsed.stdout);
const earningsLib = require('../lib/earnings');
const persistence = require('../lib/stripe-transfer-persistence');
function extract(name) { assert.ok(source[name], `production function/route exists: ${name}`); return source[name]; }
const clone = value => JSON.parse(JSON.stringify(value));
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const marker = `stripe-transfer-attempt:${id}`;
const wallet = '0x' + 'a'.repeat(40);
function fixture(options = {}) {
 const dir = fs.mkdtempSync(path.join(tmp, 'case-'));
 const files = { EARNINGS_FILE:path.join(dir,'earnings.json'), WITHDRAWALS_FILE:path.join(dir,'withdrawals.jsonl'), ACCOUNTS_FILE:path.join(dir,'accounts.json') };
 const attempt = { withdrawal_id:'wd_fixture', amount_cents:500, stripe_fee_cents:25, prepared_at:'2026-01-01T00:00:00.000Z', wallet_at_creation:wallet, attempt_id:id, account_id:'acc_a', earnings_key_at_creation:'acc_a', wallet, client_request_key:id, idempotency_key:id, stripe_platform:'legacy', stripe_platform_account_id:'acct_fixture_platform', configuration_generation:1, stripe_connect_id:'acct_fixture_connect', connected_destination:'acct_fixture_connect', destination:'acct_fixture_connect', amount_usd:5, gross_amount_usd:5, net_amount_usd:4.75, fee_usd:0.25, net_amount_cents:475, currency:'usd', livemode:false, request_digest:'fixture_digest', state:'confirmed', generation:2, stripe_transfer_id:'tr_fixture', provider_evidence:{id:'tr_fixture',transfer_id:'tr_fixture',destination:'acct_fixture_connect',amount:475,currency:'usd',livemode:false}, ...options.attempt };
 const initial = options.earnings || {acc_a:{account_id:'acc_a',wallet,pending_balance:10,total_withdrawn:2,withdrawal_count:1,total_contributor:20,processed_settlements:[],by_learning:{}}};
 fs.writeFileSync(files.EARNINGS_FILE, JSON.stringify(initial)); fs.writeFileSync(files.WITHDRAWALS_FILE,'');
 const accts = { acc_a:{id:'acc_a',account_id:'acc_a',wallet:null,stripe_connect_id:'acct_fixture_connect'} };
 fs.writeFileSync(files.ACCOUNTS_FILE,JSON.stringify(accts));
 let record=clone(attempt), latched=false;
 const events=[], commits=[];
 const store={ get:()=>clone(record), all:()=>[clone(record)], ready:true, reason:null, blocking:()=>null,
 transition(a,g,state,patch={}) {assert.equal(a,id);assert.equal(g,record.generation);record={...record,...clone(patch),state,generation:g+1};events.push(state);options.onTransition?.(state,record);return clone(record);},
 latch(){latched=true;this.ready=false;}};
 const ctx={...files,structuredClone, stripeTransferStore:store, earnings:clone(initial),accounts:accts,fs,crypto,console:{log(){},error(){},warn(){}},process:{env:{NODE_ENV:'test',TEST_MODE:'1'}},...earningsLib,...persistence,
 markerFor:a=>`stripe-transfer-attempt:${typeof a==='string'?a:a.attempt_id}`,
 digestJSON:persistence.digestJSON,
 hasProcessedSettlement:(entry,m)=>Array.isArray(entry.processed_settlements)?entry.processed_settlements.includes(m):!!entry.processed_settlements?.[m],
 markProcessedSettlement(entry,m){entry.processed_settlements=persistence.normalizeMarkers(entry.processed_settlements);if(!entry.processed_settlements.includes(m))entry.processed_settlements.push(m);},
 fatalFinancialStorage(error){store.latch();throw new Error('FATAL_STORAGE:'+error.message);},
 financialStorageFailed:false, sendOpsAlert:async()=>{}, getPendingWalEntries:()=>[], commitWal:x=>commits.push(x), getWithdrawableBalance:earningsLib.getWithdrawableBalance,
 };
 const realWrite=persistence.writeJSONAtomic, realAppend=persistence.appendJSONLOnce;
 ctx.writeJSONAtomic=(file,data,...rest)=>{if(file===files.EARNINGS_FILE){options.beforeWrite?.(ctx);events.push('earnings-write');} const result=realWrite(file,data,...rest);if(file===files.EARNINGS_FILE)options.afterWrite?.(ctx);return result;};
 ctx.appendJSONLOnce=(...args)=>{options.beforeAppend?.(ctx);if(options.appendFsImpl)args[2]={...args[2],fsImpl:options.appendFsImpl};const result=realAppend(...args);events.push('receipt-write');options.afterAppend?.(ctx);return result;};
 vm.createContext(ctx);vm.runInContext(extract('stripeAttemptKeys'),ctx);vm.runInContext(extract('completeStripeTransferAttempt'),ctx);
 return {ctx,store,events,files,commits,get attempt(){return clone(record)},get latched(){return latched},run:()=>ctx.completeStripeTransferAttempt(id),disk:()=>JSON.parse(fs.readFileSync(files.EARNINGS_FILE,'utf8')),receipts:()=>fs.readFileSync(files.WITHDRAWALS_FILE,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),restart(){ctx.earnings=JSON.parse(fs.readFileSync(files.EARNINGS_FILE,'utf8'));}};
}
test('D04/D05: completion durably debits current gross once and replay returns the original receipt',()=>{
 const f=fixture(); const first=f.run();const again=f.run();assert.deepEqual(again,first);
 assert.equal(f.disk().acc_a.pending_balance,5);assert.equal(f.disk().acc_a.total_withdrawn,7);assert.equal(f.disk().acc_a.withdrawal_count,2);assert.equal(f.disk().acc_a.total_contributor,20);assert.ok(f.disk().acc_a.processed_settlements.includes(marker));assert.equal(f.receipts().length,1);assert.equal(f.attempt.state,'completed');
 assert.ok(f.events.indexOf('earnings-write')<f.events.indexOf('ledger_applied'));assert.ok(f.events.indexOf('receipt-write')<f.events.indexOf('completed'));
});
for(const existing of [ ['old-array'], {'old-object':true} ])test('D05: existing marker representation survives atomic debit '+JSON.stringify(existing),()=>{
 const f=fixture({earnings:{acc_a:{pending_balance:10,total_withdrawn:0,withdrawal_count:0,processed_settlements:existing}}});f.run();assert.deepEqual(new Set(f.disk().acc_a.processed_settlements),new Set([...Object.keys(Array.isArray(existing)?Object.fromEntries(existing.map(x=>[x,true])):existing),marker]));
});
for(const boundary of ['before-write','after-write','after-ledger','after-receipt'])test('D04/D06: restart at '+boundary+' never duplicates debit or receipt',()=>{
 let armed=true;const crash=()=>{if(armed){armed=false;throw new Error('simulated interruption');}};
 const f=fixture({beforeWrite:boundary==='before-write'?crash:undefined,afterWrite:boundary==='after-write'?crash:undefined,onTransition:boundary==='after-ledger'?(s)=>{if(s==='ledger_applied')crash();}:undefined,afterAppend:boundary==='after-receipt'?crash:undefined});
 assert.throws(()=>f.run());f.restart();f.store.ready=true;f.run();f.run();assert.equal(f.disk().acc_a.pending_balance,5);assert.equal(f.disk().acc_a.total_withdrawn,7);assert.equal(f.disk().acc_a.withdrawal_count,2);assert.equal(f.receipts().length,1);assert.equal(f.attempt.state,'completed');
});
test('D06: failure after earnings rename latches storage and never publishes stale mutated memory',()=>{
 const f=fixture({afterWrite(){throw new Error('directory fsync failed');}});assert.throws(()=>f.run());assert.equal(f.latched,true);assert.equal(f.ctx.earnings.acc_a.pending_balance,10);assert.equal(f.disk().acc_a.pending_balance,5);assert.equal(f.attempt.state,'confirmed');
});
test('D06: corrupt or torn receipt line prevents completion instead of being silently skipped',()=>{
 const f=fixture();fs.writeFileSync(f.files.WITHDRAWALS_FILE,'{"torn":');try{f.run();}catch{}assert.notEqual(f.attempt.state,'completed');assert.equal(fs.readFileSync(f.files.WITHDRAWALS_FILE,'utf8'),' {"torn":'.trim());assert.equal(f.store.ready,false);
});
test('D04: submitted/unknown evidence cannot cause a debit or local completion',()=>{
 for(const state of ['prepared','submitted','unknown']){const f=fixture({attempt:{state}});assert.equal(f.run(),null);assert.equal(f.disk().acc_a.pending_balance,10);assert.equal(f.receipts().length,0);}
});
test('D10: reversal-reduced current balance stays confirmed and never overdraws',()=>{
 const f=fixture({earnings:{acc_a:{pending_balance:3,total_withdrawn:2,withdrawal_count:1,processed_settlements:[]}}});assert.equal(f.run(),null);assert.equal(f.disk().acc_a.pending_balance,3);assert.equal(f.attempt.state,'confirmed');assert.equal(f.receipts().length,0);
});

function linkFixture(markers, sourceMarkers, {failLink=false,failSweep=false,hold=false}={}) {
 const f=fixture({earnings:{acc_a:{pending_balance:5,unassented_pending:1,processed_settlements:markers,by_learning:{}},[wallet]:{pending_balance:2,unassented_pending:3,processed_settlements:sourceMarkers,by_learning:{}}}});
 const locks=new Set(),operations=[];const ctx=f.ctx;ctx.app=new Hono();
 const auth=async(c,next)=>{c.set('accountId','acc_a');await next();};
 Object.assign(ctx,{requireSessionOrApiKey:()=>auth,ofacScreeningReady:()=>true,checkOFAC:()=>false,geoEmbargoGate:()=>null,loadAccounts:()=>ctx.accounts,hasAcceptedCurrentTos:()=>true,isAddress:()=>true,consumeNonce:()=>null,stripePayoutBlock:()=>hold?{code:'WITHDRAWAL_IN_FLIGHT'}:null,verifiedWallets:{[wallet]:true},PLATFORM_WALLETS:[],identityVault:{captureEnabled:()=>true,keyStatus:()=>({ok:true}),validateIdentityFields:()=>({ok:true,fields:{}}),encryptIdentity:()=>({ciphertext:'synthetic'}),snapshotIdentity:()=>null,storeIdentity:()=>operations.push('vault'),restoreIdentity:()=>{}},
 acquireAccountLock:async()=>()=>{}, acquireEarningsLock:async key=>{assert.equal(locks.has(key),false,'non-reentrant earnings lock');locks.add(key);return()=>locks.delete(key);},linkWallet(){operations.push('link');return failLink?{success:false,error:'refused',status_code:409}:{success:true,wallet};},invalidateCachedAccount(){},safeWrite:(file,data)=>fs.writeFileSync(file,JSON.stringify(data)),
 async sweepHeldEarnings(){assert.equal(locks.size,0,'inner earnings locks released before sweep');const release=await ctx.acquireEarningsLock('acc_a');try{operations.push('sweep');if(failSweep)throw new Error('sweep fixture failure');ctx.earnings.acc_a.pending_balance+=ctx.earnings.acc_a.unassented_pending;ctx.earnings.acc_a.unassented_pending=0;}finally{release();}},acquireLearningsLock:async()=>()=>{},adoptWalletOrphans:()=>[],learnings:{}});
 vm.runInContext(extract('post /account/link-wallet'),ctx);
 return {...f,ctx,locks,operations,request:()=>ctx.app.request('/account/link-wallet',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wallet,signature:'test-bypass',identity:{}})})};
}
for(const src of [['source'],{source:true}])test('D05L: actual link normalizes both marker sides and releases inner locks before held sweep '+JSON.stringify(src),{timeout:2000},async()=>{
 const f=linkFixture({[marker]:true},src);const res=await f.request();assert.equal(res.status,200,await res.text());assert.deepEqual(new Set(f.ctx.earnings.acc_a.processed_settlements),new Set([marker,'source']));assert.equal(f.ctx.earnings.acc_a.pending_balance,11);assert.equal(f.locks.size,0);assert.ok(f.operations.includes('sweep'));
});
test('D05L: invalid marker shape stops before vault or account mutation',async()=>{
 const f=linkFixture('invalid',['source']);const res=await f.request();assert.ok(res.status>=400);assert.deepEqual(f.operations,[]);assert.equal(f.locks.size,0);
});
for(const mode of ['failLink','failSweep'])test('D05L: '+mode+' releases every lock',{timeout:2000},async()=>{
 const f=linkFixture({[marker]:true},['source'],{[mode]:true});const res=await f.request();assert.equal(res.status,mode==='failLink'?409:200);assert.equal(f.locks.size,0);
});

for(const afterRename of [false,true])test('D06: real fatal storage exits child before another financial action ('+(afterRename?'after':'before')+' rename)',()=>{
 const f=fixture();const child=`
const fs=require('node:fs');
const {resolveEarningsEntry,getWithdrawableBalance,debitWithdrawableBalance}=require(${JSON.stringify(path.join(root,'lib/earnings'))});
const p=require(${JSON.stringify(path.join(root,'lib/stripe-transfer-persistence'))});
const {normalizeMarkers}=p;
const EARNINGS_FILE=${JSON.stringify(f.files.EARNINGS_FILE)},WITHDRAWALS_FILE=${JSON.stringify(f.files.WITHDRAWALS_FILE)};
let earnings=JSON.parse(fs.readFileSync(EARNINGS_FILE,'utf8')),financialStorageFailed=false;
const attempt=${JSON.stringify(f.attempt)};
const stripeTransferStore={get:()=>attempt};
const markerFor=a=>'stripe-transfer-attempt:'+a.attempt_id;
const writeJSONAtomic=(file,data)=>{if(${afterRename})p.writeJSONAtomic(file,data);throw new Error('injected durability failure');};
${extract('fatalFinancialStorage')}
${extract('completeStripeTransferAttempt')}
completeStripeTransferAttempt(attempt.attempt_id);
fs.writeFileSync(EARNINGS_FILE+'.served-again','unsafe');
`;
 const r=spawnSync(process.execPath,['-e',child],{encoding:'utf8',env:{...process.env,HOME:tmp,AUXILO_HOME:tmp,AUXILO_RUNNER_AUTOUPDATE:'0'}});
 assert.equal(r.status,1,r.stderr);assert.match(r.stderr,/Fatal financial storage/);assert.equal(fs.existsSync(f.files.EARNINGS_FILE+'.served-again'),false);assert.equal(f.disk().acc_a.pending_balance,afterRename?5:10);assert.equal(f.disk().acc_a.processed_settlements.includes(marker),afterRename);assert.equal(f.receipts().length,0);
});

test('D06: receipt fsync failure is fatal; restart fsyncs the single existing receipt without another debit',()=>{
 let fail=true;const fsImpl=Object.create(fs);fsImpl.fsyncSync=fd=>{if(fail){fail=false;throw new Error('injected receipt fsync');}return fs.fsyncSync(fd);};
 const f=fixture({appendFsImpl:fsImpl});assert.throws(()=>f.run(),/FATAL_STORAGE/);assert.equal(f.latched,true);assert.equal(f.attempt.state,'ledger_applied');assert.equal(f.receipts().length,1);f.restart();f.store.ready=true;f.run();assert.equal(f.attempt.state,'completed');assert.equal(f.disk().acc_a.pending_balance,5);assert.equal(f.disk().acc_a.withdrawal_count,2);assert.equal(f.receipts().length,1);
});
test('D06: conflicting duplicate receipt retains its bytes and blocks completion',()=>{
 const f=fixture();const bytes=JSON.stringify({attempt_id:id,id:'wd_fixture',rail:'stripe',amount_usd:999})+'\n';fs.writeFileSync(f.files.WITHDRAWALS_FILE,bytes);assert.throws(()=>f.run(),/Conflicting/);assert.notEqual(f.attempt.state,'completed');assert.equal(f.store.ready,false);assert.equal(fs.readFileSync(f.files.WITHDRAWALS_FILE,'utf8'),bytes);
});
test('D07/D05L: unresolved hold blocks wallet linking before identity or account mutation',async()=>{
 const f=linkFixture([],[],{hold:true});const r=await f.request();assert.equal(r.status,409);assert.equal((await r.json()).code,'WITHDRAWAL_IN_FLIGHT');assert.deepEqual(f.operations,[]);assert.equal(f.locks.size,0);assert.equal(f.ctx.earnings.acc_a.pending_balance,5);
});
