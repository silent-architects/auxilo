'use strict';
// D07/D07D/D08/D15: execute production Hono handlers and daemon with synthetic
// durable state and fake providers. Every payout test counts provider calls.
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {Hono}=require('hono');
const root=path.join(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'d0-routes-'));
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
const parsed=spawnSync(process.execPath,['--expose-internals','-e',`
const fs=require('fs'),acorn=require('internal/deps/acorn/acorn/dist/acorn'),s=fs.readFileSync(process.argv[1],'utf8'),out={};
for(const n of acorn.parse(s,{ecmaVersion:'latest'}).body){if(n.type==='FunctionDeclaration')out[n.id.name]=s.slice(n.start,n.end);if(n.type==='ExpressionStatement'&&n.expression.type==='CallExpression'){const x=n.expression;if(x.callee.type==='MemberExpression'&&x.callee.object.name==='app'&&x.arguments[0]?.type==='Literal')out[x.callee.property.name+' '+x.arguments[0].value]=s.slice(n.start,n.end);}}console.log(JSON.stringify(out));`,path.join(root,'server.js')],{encoding:'utf8'});
assert.equal(parsed.status,0,parsed.stderr);const sources=JSON.parse(parsed.stdout);
function extract(name){assert.ok(sources[name],`production function/route exists: ${name}`);return sources[name];}
const reconcile=require('../lib/stripe-transfer-reconcile');
const states=require('../lib/stripe-transfer-attempts'),persist=require('../lib/stripe-transfer-persistence'),earningsLib=require('../lib/earnings');
const key='11111111-1111-4111-8111-111111111111',key2='22222222-2222-4222-8222-222222222222',wallet='0x'+'a'.repeat(40);
const manifest={sha256:'a'.repeat(64),inventory_complete:true,positive_history_attestation:true,history_interval:{start:'2026-01-01',end:'2026-10-01'},platforms:[{stripe_platform:'legacy',stripe_platform_account_id:'acct_fixture_old',livemode:false},{stripe_platform:'auxilo_llc',stripe_platform_account_id:'acct_fixture_new',livemode:false}]};
function fixture(options={}){
 const dir=fs.mkdtempSync(path.join(tmp,'case-')),file=path.join(dir,'attempts.json');
 states.initializeAttemptStore(file,manifest);const store=states.createAttemptStore({file});
 const accts={acc_a:{id:'acc_a',wallet,stripe_connect_id:'acct_fixture_connect'},acc_b:{id:'acc_b',wallet:'0x'+'b'.repeat(40),stripe_connect_id:'acct_fixture_other'}};
 const earnings={acc_a:{account_id:'acc_a',wallet,pending_balance:10,total_withdrawn:0,withdrawal_count:0,processed_settlements:[]},acc_b:{account_id:'acc_b',wallet:accts.acc_b.wallet,pending_balance:10,total_withdrawn:0,withdrawal_count:0,processed_settlements:[]},__wallet_index:{[wallet]:'acc_a',[accts.acc_b.wallet]:'acc_b'}};
 const files={ACCOUNTS_FILE:path.join(dir,'accounts.json'),EARNINGS_FILE:path.join(dir,'earnings.json'),WITHDRAWALS_FILE:path.join(dir,'withdrawals.jsonl'),SETTLEMENTS_FILE:path.join(dir,'settlements.jsonl')};
 fs.writeFileSync(files.ACCOUNTS_FILE,JSON.stringify(accts));fs.writeFileSync(files.EARNINGS_FILE,JSON.stringify(earnings));fs.writeFileSync(files.WITHDRAWALS_FILE,'');
 const counts={stripe:0,usdc:0,nonce:0,rate:0,vault:0},locks=new Set(),tails=new Map(),lockLog=[],wal=[];
 async function lock(type,id){const k=type+':'+id,prior=tails.get(k)||Promise.resolve();let release;const done=new Promise(r=>release=r);tails.set(k,prior.then(()=>done));await prior;assert.equal(locks.has(k),false);locks.add(k);lockLog.push('acquire:'+k);return()=>{locks.delete(k);lockLog.push('release:'+k);release();};}
 const auth=async(c,next)=>{if(c.req.header('X-Test-Unauthenticated'))return c.json({error:'unauthorized'},401);c.set('accountId',c.req.header('X-Test-Account')||'acc_a');await next();};
 const stripeContext={stripe_platform:'legacy',stripe_platform_account_id:'acct_fixture_old',configuration_generation:'fixture-generation',livemode:false};
 const ctx={...files,...earningsLib,...persist,...states,...reconcile,app:new Hono(),fs,path,crypto,structuredClone,console:{log(){},warn(){},error(){}},process:{env:{STRIPE_PLATFORM_ACCOUNT_ID:'acct_fixture_old',CUSTODIAL_WITHDRAW_ENABLED:options.custodial===false?'false':'true'}},financialStorageFailed:false,stripeTransferStore:store,accounts:accts,earnings,requireAuth:auth,requireSessionOrApiKey:()=>auth,paymentsEnabled:()=>options.payments!==false,paymentsDisabledBody:()=>({code:'PAYMENTS_DISABLED'}),ofacScreeningReady:()=>options.sanctions!==false,hasAcceptedCurrentTos:()=>options.terms!==false,termsNotAcceptedResponse:c=>c.json({code:'TERMS_NOT_ACCEPTED'},403),getConnectAccountStatus:async()=>({charges_enabled:true}),require:name=>name==='./lib/stripe.js'?{getStripeStatus:()=>({configured:true}),verifyTransferContext:async()=>stripeContext}:require(path.resolve(root,name)),
 acquireAccountLock:id=>lock('account',id),acquireWalletLock:id=>lock('wallet',id),acquireEarningsLock:id=>lock('earnings',id),verifyStripeTransferContext:async()=>stripeContext, walDir:()=>dir, syncDirectory(){}, getVerifiedTransferContext:async()=>stripeContext,verifyTransferContext:async()=>stripeContext,
 createTransferToConnect:async(...args)=>{counts.stripe++;if(options.send)return options.send(...args);throw new Error('simulated provider timeout');},createWalEntry:(operation,payload)=>{const row={id:'wal_'+wal.length,operation,payload};wal.push(row);return row.id;},getPendingWalEntries:()=>wal,commitWal:id=>{const i=wal.findIndex(w=>w.id===id);if(i>=0)wal.splice(i,1);},markStepComplete(){},sendOpsAlert:async()=>{},
 isAddress:()=>true,verifiedWallets:{[wallet]:true},checkOFAC:()=>false,logOFACBlock(){},loadAccounts:()=>accts,GAS_ESTIMATE_USD:0.01,findUnresolvedSettlement:()=>null,consumeNonce:()=>{counts.nonce++;return{action:'withdrawal',nonce:'synthetic',timestamp:Date.now()};},verifyWithdrawalSignature:async()=>true,lastWithdrawalAttempt:{},markRateLimitsDirty:()=>counts.rate++,WITHDRAWAL_RATE_LIMIT_MS:1000,
 sendUSDC:async()=>{counts.usdc++;assert.ok(locks.has('wallet:'+wallet),'wallet lock covers provider call');assert.ok(locks.has('earnings:acc_a'),'earnings lock covers provider call');return options.usdcResult||{status:'confirmed',hash:'0xfixture'};},safeWrite:(f,v)=>fs.writeFileSync(f,JSON.stringify(v)),markProcessedSettlement:(e,m)=>{e.processed_settlements=[...new Set([...(e.processed_settlements||[]),m])];},hasProcessedSettlement:(e,m)=>(e.processed_settlements||[]).includes(m),settlementDaemonRunning:false,SETTLEMENT_MAX_RETRIES:3,SETTLEMENT_REFUND_AGE_MS:86400000,appendSettlement:s=>fs.appendFileSync(files.SETTLEMENTS_FILE,JSON.stringify(s)+'\n'),runConsistencyCheck(){},resolveProcessingSettlements:async()=>{},fatalFinancialStorage:e=>{store.latch('fatal');throw e;}};
 vm.createContext(ctx);
 for(const n of ['stripePayoutBlock','stripeAttemptReply','stripeAttemptKeys','completeStripeTransferAttempt'])vm.runInContext(extract(n),ctx);
 for(const r of ['post /withdraw/stripe','post /withdraw','get /account/stripe-transfer-attempts/current','get /account/stripe-transfer-attempts/:id'])vm.runInContext(extract(r),ctx);
 vm.runInContext(extract('resolveStuckSettlements'),ctx);
 function pending(account='acc_a') {const a=store.prepare({account_id:account,earnings_key_at_creation:account,wallet_at_creation:accts[account].wallet,client_request_key:key,idempotency_key:key,stripe_platform:'legacy',stripe_platform_account_id:'acct_fixture_old',configuration_generation:'fixture-generation',stripe_connect_id:accts[account].stripe_connect_id,amount_usd:5,gross_amount_usd:5,net_amount_usd:4.75,fee_usd:0.25,net_amount_cents:475,currency:'usd',livemode:false,request_digest:states.requestDigest(5)});const b=store.transition(a.attempt_id,a.generation,'submitted');return store.transition(b.attempt_id,b.generation,'unknown',{last_error_code:'PROVIDER_OUTCOME_UNKNOWN'});}
 async function post(route='/withdraw/stripe',body={amount_usd:5},headers={}){return ctx.app.request(route,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key,...headers},body:JSON.stringify(body)});}
 return{ctx,store,counts,locks,lockLog,wal,files,pending,post,async daemon(){fs.writeFileSync(files.SETTLEMENTS_FILE,JSON.stringify({id:'wd_fixture',wallet,amount:2,status:'pending',retry_count:0,created_at:Date.now()})+'\n');await ctx.resolveStuckSettlements();return fs.readFileSync(files.SETTLEMENTS_FILE,'utf8').trim().split('\n').map(JSON.parse);}};
}
for(const invalid of ['', 'not-a-uuid','11111111-1111-1111-8111-111111111111'])test('D15: invalid request identity fails before provider action '+JSON.stringify(invalid),async()=>{const f=fixture();const r=await f.post(undefined,undefined,{'Idempotency-Key':invalid});assert.equal(r.status,400);assert.equal((await r.json()).code,'WITHDRAWAL_REQUEST_ID_REQUIRED');assert.equal(f.counts.stripe,0);assert.equal(f.store.all().length,0);});
for(const amount of [0,-1,0.49,'5',null])test('D15: invalid existing amount rejected '+JSON.stringify(amount),async()=>{const f=fixture();const r=await f.post(undefined,{amount_usd:amount});assert.equal(r.status,400);assert.equal(f.counts.stripe,0);});
test('D07: provider timeout preserves WAL and repeat key returns status without another send',async()=>{const f=fixture();const r=await f.post();assert.equal(r.status,202,await r.text());assert.equal(f.counts.stripe,1);assert.equal(f.store.all()[0].state,'unknown');assert.equal(f.wal.length,1);const again=await f.post();assert.equal(again.status,202);assert.equal(f.counts.stripe,1);const newKey=await f.post(undefined,undefined,{'Idempotency-Key':key2});assert.equal(newKey.status,409);assert.equal(f.counts.stripe,1);});
test('D07/D15: changed amount on known request returns conflict without sending',async()=>{const f=fixture();f.pending();const r=await f.post(undefined,{amount_usd:6});assert.equal(r.status,409);assert.equal((await r.json()).code,'WITHDRAWAL_REQUEST_CONFLICT');assert.equal(f.counts.stripe,0);});
test('D07: unknown Stripe outcome blocks USDC before nonce and rate counter',async()=>{const f=fixture();f.pending();const r=await f.post('/withdraw',{wallet,signature:'synthetic'});assert.equal(r.status,409,await r.text());assert.deepEqual(f.counts,{stripe:0,usdc:0,nonce:0,rate:0,vault:0});assert.equal(f.ctx.earnings.acc_a.pending_balance,10);});
test('D07: another owner remains admissible with a healthy store',async()=>{const f=fixture();f.pending();assert.equal(f.ctx.stripePayoutBlock({accountId:'acc_b',wallet:f.ctx.accounts.acc_b.wallet,earningsKey:'acc_b'}),null);});
for(const gate of ['payments','custodial','sanctions','terms'])test('D08: existing '+gate+' gate prevents provider action on both rails',async()=>{const f=fixture({[gate]:false});const a=await f.post(),b=await f.post('/withdraw',{wallet,signature:'synthetic'});assert.ok(a.status>=400);assert.ok(b.status>=400);assert.equal(f.counts.stripe,0);assert.equal(f.counts.usdc,0);});
for(const reason of ['missing_store','corrupt_store','unowned_history'])test('D08: global readiness '+reason+' blocks both payout rails',async()=>{const f=fixture();f.store.latch(reason);const a=await f.post(),b=await f.post('/withdraw',{wallet,signature:'synthetic'});assert.ok(a.status>=400);assert.ok(b.status>=400);assert.equal(f.counts.stripe,0);assert.equal(f.counts.usdc,0);assert.equal(f.counts.nonce,0);assert.equal(f.counts.rate,0);});
test('D15: status reads stay private, owner-scoped, authenticated and available with payments off',async()=>{const f=fixture({payments:false,custodial:false});const a=f.pending();const r=await f.ctx.app.request('/account/stripe-transfer-attempts/current');assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/private/);assert.match(r.headers.get('cache-control'),/no-store/);const body=await r.json();assert.equal(body.account_id,'acc_a');assert.equal(body.attempt.attempt_id,a.attempt_id);assert.equal(JSON.stringify(body).includes('acct_fixture'),false);assert.equal((await f.ctx.app.request('/account/stripe-transfer-attempts/'+a.attempt_id,{headers:{'X-Test-Account':'acc_b'}})).status,404);assert.equal((await f.ctx.app.request('/account/stripe-transfer-attempts/current',{headers:{'X-Test-Unauthenticated':'1'}})).status,401);assert.equal(f.counts.stripe,0);});
for(const gate of ['pending','payments','custodial','unready'])test('D07D: daemon '+gate+' hold preserves candidate with zero broadcasts or financial mutations',async()=>{const f=fixture(gate==='payments'?{payments:false}:gate==='custodial'?{custodial:false}:{});if(gate==='pending')f.pending();if(gate==='unready')f.store.latch('fixture');const before=JSON.stringify(f.ctx.earnings);const rows=await f.daemon();assert.equal(rows.length,1);assert.equal(rows[0].retry_count,0);assert.equal(f.counts.usdc,0);assert.equal(JSON.stringify(f.ctx.earnings),before);assert.equal(f.locks.size,0);});
for(const status of ['confirmed','timeout','failed'])test('D07D: healthy '+status+' daemon retains original arithmetic and releases both locks',async()=>{const f=fixture({usdcResult:{status,hash:'0xfixture'}});const rows=await f.daemon();assert.equal(f.counts.usdc,1);assert.equal(rows.length,2);assert.equal(f.ctx.earnings.acc_a.pending_balance,status==='confirmed'?8:10);assert.equal(f.ctx.earnings.acc_a.total_withdrawn,status==='confirmed'?2:0);assert.equal(rows[1].status,status==='confirmed'?'settled':'retry');assert.equal(f.locks.size,0);assert.ok(f.lockLog.indexOf('acquire:wallet:'+wallet)<f.lockLog.indexOf('acquire:earnings:acc_a'));});

test('D01/D07: simultaneous same-key requests perform one provider invocation',{timeout:2000},async()=>{
 let started,release;const entered=new Promise(r=>started=r),wait=new Promise(r=>release=r);
 const f=fixture({send:async()=>{started();await wait;throw new Error('timeout');}});
 const first=f.post();await entered;const second=f.post();release();const replies=await Promise.all([first,second]);assert.deepEqual(replies.map(r=>r.status),[202,202]);assert.equal(f.counts.stripe,1);assert.equal(f.store.all().length,1);assert.equal(f.locks.size,0);
});
test('D07D: daemon waiting on earnings rechecks newly persisted Stripe hold before sending',{timeout:2000},async()=>{
 const f=fixture();const release=await f.ctx.acquireEarningsLock('acc_a');const work=f.daemon();
 for(let i=0;i<20&&!f.locks.has('wallet:'+wallet);i++)await new Promise(r=>setImmediate(r));
 assert.ok(f.locks.has('wallet:'+wallet));f.pending();release();const rows=await work;assert.equal(f.counts.usdc,0);assert.equal(rows.length,1);assert.equal(f.ctx.earnings.acc_a.pending_balance,10);assert.equal(f.locks.size,0);
});
test('D07D: daemon rechecks current candidate after waiting and does not send a settled row',{timeout:2000},async()=>{
 const f=fixture();const release=await f.ctx.acquireEarningsLock('acc_a');const work=f.daemon();
 for(let i=0;i<20&&!f.locks.has('wallet:'+wallet);i++)await new Promise(r=>setImmediate(r));
 f.ctx.appendSettlement({id:'wd_fixture',wallet,amount:2,status:'settled',retry_count:0});release();await work;assert.equal(f.counts.usdc,0);assert.equal(f.locks.size,0);
});

function successfulTransfer(destination,amount,_description,_key,_context,metadata){return{id:'tr_fixture',object:'transfer',destination,amount,currency:'usd',livemode:false,metadata};}
test('D03/D15: completed key returns its recorded receipt after balance/configuration changes with no provider send',async()=>{
 const f=fixture({send:successfulTransfer});const first=await f.post();assert.equal(first.status,200,await first.clone().text());const receipt=await first.json();assert.equal(receipt.remaining_balance,5);assert.equal(f.counts.stripe,1);
 f.ctx.earnings.acc_a.pending_balance=9;f.ctx.paymentsEnabled=()=>false;f.ctx.process.env.CUSTODIAL_WITHDRAW_ENABLED='false';f.ctx.accounts.acc_a.stripe_connect_id='acct_changed';
 const second=await f.post();assert.equal(second.status,200);assert.deepEqual(await second.json(),receipt);assert.equal(f.counts.stripe,1);
});
test('D14: queued different key cannot send after the first request completes',{timeout:2000},async()=>{
 let started,release;const entered=new Promise(r=>started=r),wait=new Promise(r=>release=r);
 const f=fixture({send:async(...args)=>{started();await wait;return successfulTransfer(...args);}});
 const first=f.post();await entered;const second=f.post(undefined,undefined,{'Idempotency-Key':key2});await new Promise(r=>setImmediate(r));release();
 const [a,b]=await Promise.all([first,second]);assert.equal(a.status,200,await a.clone().text());assert.equal(b.status,409);assert.equal((await b.json()).code,'WITHDRAWAL_STATE_CHANGED');assert.equal(f.counts.stripe,1);assert.equal(f.store.all().length,1);assert.equal(f.locks.size,0);
});

test('D07: current wallet mapping cannot evade an immutable owner hold',async()=>{
 const f=fixture();const a=f.pending();const nextWallet='0x'+'c'.repeat(40);f.ctx.accounts.acc_a.wallet=nextWallet;f.ctx.earnings.__wallet_index[nextWallet]='acc_a';f.ctx.earnings.acc_a.wallet=nextWallet;f.ctx.verifiedWallets[nextWallet]=true;
 const block=f.ctx.stripePayoutBlock({accountId:'acc_a',wallet:nextWallet,earningsKey:'acc_a'});assert.equal(block.attempt_id,a.attempt_id);const r=await f.post('/withdraw',{wallet:nextWallet,signature:'synthetic'});assert.equal(r.status,409);assert.equal(f.counts.usdc,0);assert.equal(f.counts.nonce,0);assert.equal(f.counts.rate,0);
});

test('D07D: legitimate append-only pending and retry history still broadcasts once', async () => {
  const f = fixture();
  const initial = { id: 'wd_history', wallet, amount: 2, status: 'pending', retry_count: 0, created_at: Date.now() };
  const retry = { ...initial, status: 'retry', retry_count: 1 };
  fs.writeFileSync(f.files.SETTLEMENTS_FILE, [initial, retry].map(JSON.stringify).join('\n') + '\n');
  await f.ctx.resolveStuckSettlements();
  const rows = fs.readFileSync(f.files.SETTLEMENTS_FILE, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(f.counts.usdc, 1);
  assert.equal(rows.length, 3);
  assert.equal(rows[2].status, 'settled');
  assert.equal(f.ctx.earnings.acc_a.pending_balance, 8);
  assert.equal(f.ctx.earnings.acc_a.total_withdrawn, 2);
  assert.equal(f.locks.size, 0);
});
