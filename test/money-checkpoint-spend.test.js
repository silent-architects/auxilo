'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { boot, source } = require('./helpers/financial-epoch-fixture');
const boundary = require('../lib/financial-epoch');
const checkpoint = require('../lib/money-checkpoint');
const money = require('../lib/money-control');
const { openMoneyStore } = require('../lib/money-control-store');

function control() {
  return { schema_version: 1, rule_version: 'fixture-v1', approval_ref: 'fixture', deletion_barrier: { sequence: 0, hash: 'a'.repeat(64) }, seals: [], records: [], holds: [] };
}
async function fixture(t) {
  const x = boot(t), lot = source(x.epoch, 'buyer');
  const store = openMoneyStore({ epoch: x.epoch, writer: x.writer });
  const coordinator = money.createMoneyControl({ store, epoch: x.epoch, writer: x.writer });
  const shim = { ...money, getMoneyRuntime: () => coordinator,
    runInMoneyContext(fn, options) { const active = money.getActiveMoneyContext(); return active ? fn(active) : coordinator.withMoneyControl(options, fn); },
    assertParticipantWrite(file) { money.assertMoneyContext(); boundary.assertEpochWritePath(file, x.writer); },
    poisonMoneyRuntime(error) { coordinator.markUncertain(error); }
  };
  const credits = require('proxyquire').noCallThru()('../lib/credits', {
    './money-control': shim,
    './financial-epoch': { ...boundary, getRuntimeEpoch: () => x.epoch, resolveParticipantPath: name => boundary.pathFor(name, x.epoch) }
  });
  const stamp = Date.parse(x.epoch.not_before);
  await coordinator.withMoneyControl({}, ctx => {
    const intent=boundary.readParticipant('stripe_checkout_intents',x.epoch).intents[lot.checkout_intent_id];
    const origin=boundary.readParticipant('stripe_object_origins',x.epoch).records.find(row=>row.provider_id===lot.stripe_payment_intent);
    ctx.recordEvidence({namespace:'checkout_intents',id:intent.intent_id,payload:intent,indexes:{accountId:'buyer',providerId:intent.session_id,platform_account_id:x.epoch.platform_account_id,livemode:x.epoch.livemode}});
    ctx.recordEvidence({namespace:'object_origins',id:require('../lib/stripe-transfer-persistence').digestJSON([x.epoch.platform_account_id,x.epoch.livemode,'payment_intent',lot.stripe_payment_intent]),payload:origin,indexes:{accountId:'buyer',providerId:lot.stripe_payment_intent,platform_account_id:x.epoch.platform_account_id,livemode:x.epoch.livemode}});
    return ctx.recordFundingSource({
    id: 'fund', accountId: 'buyer', charge_id: 'ch_buyer', payment_intent_id: lot.stripe_payment_intent,
    currency: 'usd', amountMicros: 10000000, epoch_id: x.epoch.epoch_id, binding_digest: x.epoch.binding_digest,
    platform: x.epoch.platform, platform_account_id: x.epoch.platform_account_id, livemode: x.epoch.livemode,
    policy: { version: x.epoch.policy_ref, effective_at: stamp, accepted_at: stamp, acknowledged: true, evidence_ref: 'fixture-assent', consent_id: lot.policy_consent_id },
    created_at: stamp, canonical_created_at: x.epoch.not_before,
    provenance: { verified: true, intent_id: lot.checkout_intent_id, origin_id: 'origin-buyer', purchase_id: lot.purchase_id, lot_id: lot.lot_id, receipt_digest: 'b'.repeat(64) }
  });});
  return { ...x, store, coordinator, credits };
}
async function cut(x) {
  return checkpoint.createMoneyCheckpoint({ ...x, sourceSha: 'a'.repeat(40), lifecycleControl: control() });
}
for (const refunded of [false, true]) test(`actual ${refunded ? 'returned' : 'acknowledged'} spend receipt checkpoints and restores with exact participant effect`, async t => {
  const x = await fixture(t);
  const spent = await x.credits.deductCredit('buyer', 'unlock', 2);
  assert.equal(spent.success, true, JSON.stringify(spent));
  if (refunded) await x.credits.refundDollarDraw('buyer', spent.draws);
  const result = await cut(x), target = x.root + '-restore';
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const writer = require('../lib/money-writer-lock').injectMoneyWriter({ root: target, assertOwned: () => true });
  t.after(() => writer.close());
  const restored = checkpoint.restoreCheckpoint({ checkpointDir: checkpoint.checkpointDirectory(x.root, result.checkpoint_id), targetRoot: target, writer, authoritativeLifecycle: control() });
  assert.equal(restored.state, 'reconcile_only');
  const epoch = boundary.resolveRuntimeEpoch({ root: target });
  const credits = JSON.parse(fs.readFileSync(boundary.pathFor('credits', epoch))), journal = readJournal(epoch);
  const id = spent.draws[0].spend_id;
  assert.equal(credits.buyer.dollar_lots[0].remaining_usd, refunded ? 10 : 8);
  assert.equal(journal.spends[id].state, refunded ? 'returned' : 'acknowledged');
  assert.equal(credits.buyer.money_receipts[id].digest, journal.spends[id].digest);
  if (refunded) assert.equal(credits.buyer.money_receipts[id + ':restore'].digest, journal.spends[id].digest);
});
for (const corruption of ['owner', 'digest']) test(`checkpoint rejects actual spend receipt ${corruption} conflict`, async t => {
  const x = await fixture(t), spent = await x.credits.deductCredit('buyer', 'unlock', 2), id = spent.draws[0].spend_id;
  assert.equal(spent.success, true, JSON.stringify(spent));
  const file = boundary.pathFor('credits', x.epoch), record = JSON.parse(fs.readFileSync(file));
  if (corruption === 'digest') record.buyer.money_receipts[id].digest = 'f'.repeat(64);
  else { record.wrongOwner = { money_receipts: { [id]: record.buyer.money_receipts[id] } }; delete record.buyer.money_receipts[id]; }
  fs.writeFileSync(file, JSON.stringify(record));
  await assert.rejects(() => cut(x), /CHECKPOINT_.*(CONFLICT|MISSING|INTENT)/);
});
test('checkpoint completes a local spend acknowledgement lost after the exact participant debit receipt', async t => {
  const x = await fixture(t);
  await assert.rejects(() => x.coordinator.withMoneyControl({}, async ctx => {
    ctx.ackSpend = () => { throw new Error('fixture crash after debit fsync'); };
    await x.credits.deductCredit('buyer', 'unlock', 2);
  }), /fixture crash after debit fsync/);
  const pending = Object.values(x.store.read().spends)[0];
  assert.equal(pending.state, 'prepared');
  assert.equal(x.credits.loadCredits().buyer.dollar_lots[0].remaining_usd, 8);
  const result = await cut(x);
  const directory=checkpoint.checkpointDirectory(x.root,result.checkpoint_id),manifest=checkpoint.validateCheckpoint(directory);
  const cutJournal=checkpoint.withCheckpointContents(directory,manifest,root=>readJournal(boundary.resolveRuntimeEpoch({root})));
  assert.equal(cutJournal.spends[pending.id].state, 'acknowledged');
  assert.equal(cutJournal.sources.fund.spentMicros, 2000000);
  assert.equal(x.credits.loadCredits().buyer.dollar_lots[0].remaining_usd, 8);
});

function readJournal(epoch){return require('../lib/money-database').exportMoneyDatabase({file:boundary.pathFor('money_database',epoch),epoch,descriptor:boundary.readParticipant('money_control',epoch)});}

async function pendingFixture(t) {
 const x=await fixture(t);
 await assert.rejects(()=>x.coordinator.withMoneyControl({},async ctx=>{
  ctx.ackSpend=()=>{throw Error('synthetic lost local ack');};
  await x.credits.deductCredit('buyer','unlock',2);
 }),/synthetic lost local ack/);
 return {...x,pending:Object.values(x.store.read().spends)[0]};
}
function editReceipts(x,fn){const file=boundary.pathFor('credits',x.epoch),record=JSON.parse(fs.readFileSync(file));fn(record);fs.writeFileSync(file,JSON.stringify(record));}
for(const corruption of ['foreign-owner','foreign-id','digest','restore','amount']) test('checkpoint negative pending receipt: '+corruption,async t=>{
 const x=await pendingFixture(t),id=x.pending.id;
 if(corruption==='amount'){
  const Database=require('../server-runtime/node_modules/better-sqlite3'),db=new Database(boundary.pathFor('money_database',x.epoch));
  const row=structuredClone(x.pending);row.draws[0].amountMicros++;
  require('../lib/money-database').put(db,'spends',id,row);db.close();
 }else editReceipts(x,record=>{
  const receipt=record.buyer.money_receipts[id];
  if(corruption==='foreign-owner'){record.wrongOwner={money_receipts:{[id]:receipt}};delete record.buyer.money_receipts[id];}
  if(corruption==='foreign-id')receipt.projection_id='foreign-spend';
  if(corruption==='digest')receipt.digest='f'.repeat(64);
  if(corruption==='restore')record.buyer.money_receipts[id+':restore']={projection_id:id+':restore',digest:x.pending.digest};
 });
 await assert.rejects(()=>cut(x),/CHECKPOINT_|SPEND_RECEIPT_CONFLICT/);
 assert.equal(x.store.getSpend(id).state,'prepared');
 assert.equal(x.store.getSource('fund').spentMicros,0);
 assert.equal(x.credits.loadCredits().buyer.dollar_lots[0].remaining_usd,8);
});
test('checkpoint missing local receipt remains pending rather than assumed applied',async t=>{
 const x=await pendingFixture(t);editReceipts(x,r=>delete r.buyer.money_receipts[x.pending.id]);
 await cut(x);assert.equal(x.store.getSpend(x.pending.id).state,'prepared');assert.equal(x.store.getSource('fund').spentMicros,0);
});
test('checkpoint two checkpoints acknowledge once and preserve participant bytes',async t=>{
 const x=await pendingFixture(t),file=boundary.pathFor('credits',x.epoch),before=fs.readFileSync(file);
 await cut(x);const revision=x.store.readMetadata().revision;
 await cut(x);
 assert.equal(x.store.readMetadata().revision,revision);
 assert.equal(x.store.getSource('fund').spentMicros,2000000);
 assert.deepEqual(fs.readFileSync(file),before);
});
test('checkpoint crash after journal acknowledgement retries without second debit or acknowledgement',async t=>{
 const x=await pendingFixture(t),real=x.coordinator.withMoneyControl.bind(x.coordinator);let once=true;
 const wrapper={...x.coordinator,async withMoneyControl(options,fn){const result=await real(options,fn);if(once){once=false;throw Error('synthetic crash after ack commit');}return result;}};
 await assert.rejects(()=>cut({...x,coordinator:wrapper}),/synthetic crash after ack commit/);
 assert.equal(x.store.getSpend(x.pending.id).state,'acknowledged');
 const revision=x.store.readMetadata().revision;
 await cut(x);assert.equal(x.store.readMetadata().revision,revision);
 assert.equal(x.store.getSource('fund').spentMicros,2000000);
 assert.equal(x.credits.loadCredits().buyer.dollar_lots[0].remaining_usd,8);
});
test('checkpoint receipt changed between candidate lease and acknowledgement fails closed',async t=>{
 const x=await pendingFixture(t),real=x.coordinator.withMoneyControl.bind(x.coordinator);
 const wrapper={...x.coordinator,withMoneyControl(options,fn){editReceipts(x,r=>{r.buyer.money_receipts[x.pending.id].digest='e'.repeat(64);});return real(options,fn);}};
 await assert.rejects(()=>cut({...x,coordinator:wrapper}),/CHECKPOINT_SPEND_RECEIPT_CONFLICT/);
 assert.equal(x.store.getSpend(x.pending.id).state,'prepared');assert.equal(x.store.getSource('fund').spentMicros,0);
});
