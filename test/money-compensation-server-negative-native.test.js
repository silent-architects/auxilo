'use strict';
// C3 characterization only: synthetic paid obligations, real earnings authority,
// stopped corruption inputs, and the actual server startup/recovery path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {stageServer, reservePort, bootServer, stopServer} = require('./helpers/staged-server');
const ROOT = path.resolve(__dirname, '..');
const REQUEST = 'EMFR_COMPENSATION_C3_REQUEST';
const CASES = [
  {id:'C3-A', phase:'legacy-fence', outcome:'held'},
  {id:'C3-B', phase:'write-started', outcome:'held'},
  {id:'C3-C1', phase:'earnings-candidate', outcome:'stage-refused'},
  {id:'C3-C2', phase:'earnings-renamed', outcome:'held'},
  {id:'C3-D1', phase:'earnings-bytes', outcome:'identity-refused'},
  {id:'C3-D2', phase:'earnings-inode', outcome:'identity-refused'},
];
const MAX_OWNED_BYTES = 128 * 1048576;
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function locatorWrite(file, patch) {
  const prior = fs.existsSync(file) ? json(file) : {};
  fs.writeFileSync(file, JSON.stringify({...prior, ...patch}), {mode:0o600});
}
function fdPath(fd) {
  try { return fs.readlinkSync('/proc/self/fd/' + fd); } catch { return null; }
}
function ownedBytes(directory) {
  let total = 0;
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name), s = fs.lstatSync(file);
    if (s.isSymbolicLink()) continue; // Shared immutable runtime/code is not copied.
    total += s.blocks * 512;
    if (s.isDirectory()) total += ownedBytes(file);
  }
  return total;
}
function readControl(location) {
  const p = require('../lib/stripe-transfer-persistence');
  const bytes = fs.readFileSync(path.join(location.financialDirectory, 'money-first-failure-control.bin'));
  assert.equal(bytes.length, 8192);
  const rows = [];
  for (let at = 0; at < 8192; at += 4096) {
    const slot = bytes.subarray(at, at + 4096), end = slot.indexOf(0);
    if (end <= 0 || slot.subarray(end).some(v => v !== 0)) continue;
    const {checksum, ...body} = JSON.parse(slot.subarray(0, end).toString());
    if (p.digestJSON(body) === checksum) rows.push(body);
  }
  rows.sort((a,b) => b.sequence-a.sequence);
  assert.ok(rows.length, 'a durable valid failure-control slot must survive');
  return rows[0];
}
function snapshot(location) {
  const Driver = require('../server-runtime/node_modules/better-sqlite3');
  const database = require('../lib/money-database');
  const db = new Driver(path.join(location.financialDirectory, 'money-control.sqlite'), {readonly:true,fileMustExist:true});
  db.defaultSafeIntegers(true);
  try {
    const spend = database.get(db, 'spends', location.spendId);
    const source = database.get(db, 'sources', 'fund');
    assert.equal(spend.state, 'acknowledged');
    assert.equal(source.spentMicros, 20000);
    assert.equal(database.get(db, 'pools', 'unlock:' + location.walId), undefined);
    const credit = json(location.creditsPath).buyer;
    assert.equal(credit.dollar_lots[0].remaining_usd, 0);
    assert.equal(credit.dollar_lots[0].inflight_usd, 0.02);
    assert.equal(credit.money_receipts[location.spendId].digest, spend.digest);
    assert.equal(credit.money_receipts[location.spendId + ':restore'], undefined);
    const stages = fs.readdirSync(location.financialDirectory).filter(n => n.endsWith('.tmp')).sort();
    return {
      credits:fs.readFileSync(location.creditsPath),
      earnings:fs.readFileSync(location.earningsPath),
      earningsIdentity:{dev:fs.statSync(location.earningsPath).dev,ino:fs.statSync(location.earningsPath).ino},
      wal:fs.readFileSync(path.join(location.walDirectory, location.walId + '.wal.json')),
      learnings:fs.readFileSync(path.join(location.root, 'learnings.json')),
      stageBytes:stages.map(name => [name,fs.readFileSync(path.join(location.financialDirectory,name))]),
      financial:database.readAtomicRestoreDigests(db),
      metadata:database.readMetadata(db),
      capacity:db.prepare('SELECT id,payload FROM capacity_reservations ORDER BY id').all(),
    };
  } finally { db.close(); }
}
async function worker(request) {
  const boundary = require('../lib/financial-epoch');
  const persistence = require('../lib/stripe-transfer-persistence');
  if (request.mode === 'create') {
    const fixture = require('./helpers/money-compensation-native-fixture');
    const f = await fixture.setup({onRoot:root => locatorWrite(request.locator,{root})});
    const earningsPath = boundary.pathFor('earnings', f.epoch);
    locatorWrite(request.locator, {
      financialDirectory:f.epoch.financial_dir,
      creditsPath:boundary.pathFor('credits', f.epoch), earningsPath,
      walDirectory:boundary.pathFor('wal', f.epoch),
      originalEarnings:fs.readFileSync(earningsPath).toString('base64'),
      originalEarningsIdentity:{dev:fs.statSync(earningsPath).dev,ino:fs.statSync(earningsPath).ino},
    });
    const crash = detail => {
      locatorWrite(request.locator,{faultHit:request.phase,detail});
      process.stderr.write('EXACT_C3_FAULT:' + request.phase + ':' + detail + '\n');
      process.exit(73);
    };
    await f.coordinator.withMoneyControl({accounts:['buyer']}, async () => {
      const debit = await f.credits.deductCredit('buyer','unlock',0.02);
      assert.equal(debit.success,true,JSON.stringify(debit));
      const spendId = debit.draws[0].spend_id;
      const learningRecovery = f.wal.createLearningRecovery('learning',f.wal.captureLearningState(f.before),f.after);
      const walId = f.wal.createWalEntry('unlock', {
        funding_source:'credit_pack',purchaser_account_id:'buyer',contributor_account_id:'maker',
        learning_id:'learning',unlock_price:0.02,amount_paid_usd:0.02,
        platform_earned:0.01,contributor_earned:0.01,dollar_draws:debit.draws,learningRecovery,
      }, {preWalCapability:debit.preWalCapability});
      locatorWrite(request.locator,{spendId,walId});
      persistence.writeJSONAtomic(path.join(f.root,'learnings.json'),[f.after,{id:'unrelated',value:'keep'}]);
      f.wal.markStepComplete(walId,'update_learnings');
      assert.equal(f.coordinator.failureControl.status().state,'idle');
      if (['legacy-fence','earnings-bytes','earnings-inode'].includes(request.phase)) crash('stopped-input-prepared');
      const authority = f.wal.beginEarningsWrite(walId);
      if (request.phase === 'write-started') crash('durable-write-started-before-writer');
      const earnings = require('../lib/earnings').initEarningsEntry('maker',null);
      Object.assign(earnings,{total_gross:0.02,total_contributor:0.01,total_platform:0.01,pending_balance:0.01,by_learning:{learning:{gross:0.02,contributor:0.01,platform:0.01,unlocks:1}}});
      const originalSync = fs.fsyncSync, originalRename = fs.renameSync;
      const isCandidate = file => typeof file==='string' && path.dirname(file)===f.epoch.financial_dir && /^earnings\.json\.[a-f0-9-]{36}\.tmp$/.test(path.basename(file));
      fs.fsyncSync = function(fd) {
        const file = fdPath(fd), result = originalSync.apply(this,arguments);
        if (request.phase==='earnings-candidate' && isCandidate(file)) {
          assert.equal(fs.fstatSync(fd).ino,fs.statSync(file).ino);
          assert.deepEqual(json(file),{maker:earnings});
          crash('actual-earnings-candidate-fsync-completed');
        }
        return result;
      };
      fs.renameSync = function(from,to) {
        const match = to===earningsPath && isCandidate(from);
        const result = originalRename.apply(this,arguments);
        if (request.phase==='earnings-renamed' && match) {
          assert.deepEqual(json(earningsPath),{maker:earnings});
          crash('actual-earnings-rename-completed-before-wal-ack');
        }
        return result;
      };
      f.wal.writeEarnings(walId,authority,()=>persistence.writeJSONAtomic(earningsPath,{maker:earnings}));
      throw new Error('requested real earnings crash cut was not reached');
    });
    throw new Error('requested C3 preparation exit was not reached');
  }
  assert.equal(request.mode,'proof');
  const location = json(request.locator);
  process.env.AUXILO_DATA_DIR=location.root;
  process.env.AUXILO_SQLITE_TMPDIR=path.join(location.root,'sqlite-runtime-temp');
  const writer = require('../lib/money-writer-lock').acquireMoneyWriter({root:location.root});
  let runtime;
  try {
    const epoch=boundary.resolveRuntimeEpoch({root:location.root,writer});
    runtime=require('../lib/money-control').initializeMoneyRuntime({epoch,writer});
    const anchor=runtime.recoveryAnchors.resolveCommittedAnchor({kind:'spend',id:location.spendId});
    runtime.withMoneyBootControl({recoveryAnchor:anchor,action:'boot_recovery'},()=>{
      const wal=require('../lib/wal'),spend=runtime.store.getSpend(location.spendId);
      assert.throws(()=>wal.verifyCompensationAuthority({spend,walCapability:wal.resolveWalCapability(location.walId)}),{code:'COMPENSATION_ACCRUAL_CONFLICT'});
    });
    assert.notEqual(runtime.failureControl.status().state,'compensation_requested');
    process.stdout.write('EXACT_C3_COMPENSATION_REFUSAL:COMPENSATION_ACCRUAL_CONFLICT\n');
  } finally { runtime?.store.close(); writer.close(); }
}
function mutateStoppedInput(location,phase) {
  const p=require('../lib/stripe-transfer-persistence');
  if (phase==='legacy-fence') {
    const file=path.join(location.walDirectory,location.walId+'.wal.json'),entry=json(file);
    assert.equal(entry.accrualFence.state,'not_started');delete entry.accrualFence;
    p.writeJSONAtomic(file,entry);
  } else if (phase==='earnings-bytes') {
    const before=fs.statSync(location.earningsPath),fd=fs.openSync(location.earningsPath,'a');
    try { fs.writeSync(fd,' ');fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    assert.equal(fs.statSync(location.earningsPath).ino,before.ino);
  } else if (phase==='earnings-inode') {
    const retained=fs.openSync(location.earningsPath,'r'),before=fs.fstatSync(retained),replacement=location.earningsPath+'.owned-negative-replacement';
    try {
      fs.copyFileSync(location.earningsPath,replacement,fs.constants.COPYFILE_EXCL);
      const fd=fs.openSync(replacement,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(replacement,location.earningsPath);p.syncDirectory(path.dirname(location.earningsPath));
      assert.notEqual(fs.statSync(location.earningsPath).ino,before.ino);
    } finally {fs.closeSync(retained);}
    assert.deepEqual(fs.readFileSync(location.earningsPath),Buffer.from(location.originalEarnings,'base64'));
  }
}
if (process.env[REQUEST]) {
  worker(JSON.parse(process.env[REQUEST])).catch(error=>{console.error(error);process.exitCode=1;});
} else for (const row of CASES) test('actual server preserves admitted obligation at '+row.id+' '+row.phase, {
  skip:process.platform!=='linux'?'requires actual patched Linux server runtime':false,timeout:90000,
}, async t=>{
  const box=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'compensation-server-negative-'))),locator=path.join(box,'locator.json');
  let location,child;
  t.after(async()=>{
    await stopServer(child);
    if(fs.existsSync(locator))location=json(locator);
    if(location?.root)fs.rmSync(location.root,{recursive:true,force:true});
    fs.rmSync(box,{recursive:true,force:true});
  });
  const run=mode=>spawnSync(process.execPath,[__filename],{env:{...process.env,HOME:box,AUXILO_HOME:box,AUXILO_RUNNER_AUTOUPDATE:'0',[REQUEST]:JSON.stringify({mode,phase:row.phase,locator})},encoding:'utf8',timeout:30000});
  const created=run('create');if(fs.existsSync(locator))location=json(locator);
  assert.equal(created.status,73,created.stdout+created.stderr);
  assert.equal(location.faultHit,row.phase);
  assert.ok(created.stderr.includes('EXACT_C3_FAULT:'+row.phase+':'));
  assert.ok(location.root.startsWith(fs.realpathSync(os.tmpdir())+path.sep));
  assert.ok(location.financialDirectory.startsWith(location.root+path.sep));
  mutateStoppedInput(location,row.phase);
  const before=snapshot(location),wal=JSON.parse(before.wal);
  assert.ok(wal.steps_completed.includes('update_learnings'));
  assert.ok(!wal.steps_completed.includes('update_earnings'));
  if(row.phase==='legacy-fence')assert.equal(wal.accrualFence,undefined);
  else assert.equal(wal.accrualFence.state,['write-started','earnings-candidate','earnings-renamed'].includes(row.phase)?'write_started':'not_started');
  assert.equal(readControl(location).state,'idle');
  if(row.phase==='earnings-candidate') {
    assert.equal(before.stageBytes.length,1);
    assert.match(before.stageBytes[0][0],/^earnings\.json\.[a-f0-9-]{36}\.tmp$/);
    assert.deepEqual(before.earnings,Buffer.from(location.originalEarnings,'base64'));
    assert.notDeepEqual(before.stageBytes[0][1],before.earnings);
  } else assert.equal(before.stageBytes.length,0);
  if(row.phase!=='earnings-candidate') {
    const proof=run('proof');assert.equal(proof.status,0,proof.stdout+proof.stderr);
    assert.ok(proof.stdout.includes('EXACT_C3_COMPENSATION_REFUSAL:COMPENSATION_ACCRUAL_CONFLICT'));
    assert.deepEqual(snapshot(location),before,'read-only authority refusal must preserve every participant and SQL obligation');
  }
  const {port}=await reservePort();assert.ok(port,'Linux loopback is a required native prerequisite');
  const stage=path.join(box,'server');
  stageServer({repoRoot:ROOT,tmpDir:stage,nodeModulesDir:path.join(ROOT,'node_modules'),port,rootFiles:['server.js','skills.json','openapi.json','package.json','model_config.json'],linkDirs:['public','prompts'],copyDirs:['lib','config']});
  fs.writeFileSync(path.join(stage,'deny-network.cjs'),"const deny=()=>{throw Error('SYNTHETIC_NETWORK_DENIED')};require('http').request=deny;require('https').request=deny;global.fetch=deny;\n");
  for(let attempt=1;attempt<=2;attempt++) {
    let failure,boot;
    try {
      boot=await bootServer({tmpDir:stage,port,env:{HOME:stage,AUXILO_HOME:stage,AUXILO_DATA_DIR:location.root,AUXILO_WAL_DIR:'',AUXILO_SQLITE_TMPDIR:path.join(location.root,'sqlite-runtime-temp'),NODE_ENV:'test',NODE_OPTIONS:'--require='+path.join(stage,'deny-network.cjs'),SESSION_SECRET:'synthetic-only-'.repeat(5),WALLET_PRIVATE_KEY:'0x'+'11'.repeat(32),LLM_SENSITIVITY_ENABLED:'false',PAYMENTS_ENABLED:'true',AUXILO_RUNNER_AUTOUPDATE:'0'},timeoutMs:20000,maxAttempts:1});
      child=boot.child;
    } catch(error) {failure=error;}
    if(row.outcome==='held') {
      assert.equal(failure,undefined,failure?.output||failure?.stack);
      assert.ok(child,boot?.output||'native server could not bind');
      const response=await fetch('http://127.0.0.1:'+port+'/health'),health=await response.json();
      assert.equal(response.status,200);
      assert.equal(health.financial_epoch.capacity_available,false);
      assert.equal(health.financial_epoch.capacity_reason,'FINANCIAL_RECOVERY_REQUIRED');
      await stopServer(child);child=null;
      const control=readControl(location);
      assert.equal(control.state,'failure_pending');
      assert.equal(control.anchor.kind,'spend');assert.equal(control.anchor.id,location.spendId);
    } else {
      await stopServer(child);child=null;
      assert.ok(failure,'unsafe startup must refuse');
      assert.equal(failure.code,'BOOT_FAILED',failure.output||failure.stack);
      assert.match(failure.output||failure.message,row.outcome==='stage-refused'?/EPOCH_STAGE_INCOMPLETE/:/COMPENSATION_ACCRUAL_CONFLICT/);
    }
    assert.notEqual(readControl(location).state,'compensation_requested');
    assert.deepEqual(snapshot(location),before,'cold startup must not erase or alter admitted debt, candidate, earnings, or SQL');
    const allocated=ownedBytes(location.root)+ownedBytes(box);
    assert.ok(allocated<=MAX_OWNED_BYTES,'serial C3 fixture exceeded its declared 128 MiB physical cap: '+allocated);
    console.log('C3_NATIVE_PRESERVATION',JSON.stringify({id:row.id,phase:row.phase,attempt,allocatedBytes:allocated,financialDigest:before.financial.financialStateDigest,state:readControl(location).state}));
  }
});
