'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const stripe = require('../lib/stripe');
const definitions = { ...require('../lib/stripe-platforms').PLATFORM_DEFINITIONS, legacy: { ...require('../lib/stripe-platforms').PLATFORM_DEFINITIONS.legacy, account_id: 'acct_fixture_platform' } };
const inject = client => stripe.__setStripeClientForTest(client, definitions);
const saved = { key: process.env.STRIPE_SECRET_KEY, account: process.env.STRIPE_PLATFORM_ACCOUNT_ID };
const metadata = { auxilo_transfer_attempt_id: '1caea589-25f4-4c0d-88a1-a074aa456701', auxilo_request_digest: 'a'.repeat(64) };
let calls;
function client(overrides = {}) {
  return {
    accounts: { retrieve: async (...args) => { calls.identity.push(args); return { id: 'acct_fixture_platform' }; } },
    balance: { retrieve: async () => ({ livemode: false }) },
    transfers: { create: async (params, options) => { calls.create.push({ params, options }); return { id: 'tr_fixture', object: 'transfer', amount: params.amount, currency: params.currency, destination: params.destination, livemode: false, metadata: params.metadata }; } },
    ...overrides,
  };
}
beforeEach(() => {
  stripe.__resetStripeStatusForTest();
  process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'f'.repeat(40);
  process.env.STRIPE_PLATFORM_ACCOUNT_ID = 'acct_fixture_platform';
  calls = { identity: [], create: [] };
  inject(client());
});
afterEach(() => {
  stripe.__resetStripeStatusForTest();
  for (const [name, value] of [['STRIPE_SECRET_KEY', saved.key], ['STRIPE_PLATFORM_ACCOUNT_ID', saved.account]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
const verify = () => stripe.verifyStripeTransferContext({ expectedAccountId: 'acct_fixture_platform', platform: 'legacy' });
const send = (context, meta = metadata, key = 'auxilo-fixture-key') => stripe.createTransferToConnect('acct_fixture_destination', 475, 'Fixture withdrawal', key, context, meta);

test('D16 authenticates current platform and binds immutable mode/client generation', async () => {
  const ctx = await verify();
  assert.deepEqual(calls.identity, [[]]);
  assert.equal(ctx.stripe_platform_account_id, 'acct_fixture_platform');
  assert.equal(ctx.stripe_platform, 'legacy');
  assert.equal(ctx.mode, 'test'); assert.equal(ctx.livemode, false);
  assert.equal(Object.isFrozen(ctx), true); assert.equal(typeof ctx.configuration_generation, 'string');
  assert.equal(calls.create.length, 0);
});
test('D16 wrong authenticated identity blocks create', async () => {
  inject(client({ accounts: { retrieve: async () => ({ id: 'acct_other_fixture' }) } }));
  await assert.rejects(verify(), /identity/i); assert.equal(calls.create.length, 0);
});
test('D16 failed authenticated identity read blocks create', async () => {
  inject(client({ accounts: { retrieve: async () => { throw new Error('fixture unavailable'); } } }));
  await assert.rejects(verify()); assert.equal(calls.create.length, 0);
});
test('D16 test/live balance mismatch blocks create', async () => {
  inject(client({ balance: { retrieve: async () => ({ livemode: true }) } }));
  await assert.rejects(verify(), /mode/i); assert.equal(calls.create.length, 0);
});
test('D16 unknown platform alias and missing expected identity fail closed', async () => {
  await assert.rejects(stripe.verifyStripeTransferContext({ platform: 'unknown', expectedAccountId: 'acct_fixture_platform' }));
  await assert.rejects(stripe.verifyStripeTransferContext({ platform: 'legacy', expectedAccountId: 'acct_unknown_fixture' }));
  assert.equal(calls.create.length, 0);
});
test('D16 credential drift after preparation blocks send on original and replacement client', async () => {
  const ctx = await verify();
  process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'g'.repeat(40);
  await assert.rejects(send(ctx), /context|configuration/i);
  inject(client());
  await assert.rejects(send(ctx), /context|configuration/i);
  assert.equal(calls.create.length, 0);
});
test('D16 drift during identity read fails closed before prepared context exists', async () => {
  inject(client({ accounts: { retrieve: async () => { process.env.STRIPE_SECRET_KEY += 'changed'; return { id: 'acct_fixture_platform' }; } } }));
  await assert.rejects(verify(), /context|configuration/i); assert.equal(calls.create.length, 0);
});
test('D16 serialized/forged context cannot authorize a transfer', async () => {
  const ctx = await verify();
  await assert.rejects(send({ ...ctx }), /context/i); assert.equal(calls.create.length, 0);
});
test('D01 fixed key, metadata, verified fields and zero SDK retries accompany exactly one create', async () => {
  const ctx = await verify(); const result = await send(ctx);
  assert.equal(calls.create.length, 1);
  assert.deepEqual(calls.create[0].options, { idempotencyKey: 'auxilo-fixture-key', maxNetworkRetries: 0 });
  assert.deepEqual(calls.create[0].params.metadata, metadata);
  assert.equal(result.transfer_id, 'tr_fixture'); assert.equal(result.amount_cents, 475);
  assert.equal(result.destination, 'acct_fixture_destination'); assert.equal(result.currency, 'usd');
  assert.equal(result.livemode, false); assert.deepEqual(result.metadata, metadata);
  assert.equal(result.stripe_platform_account_id, ctx.stripe_platform_account_id);
});
test('D01 missing stable key or correlation refuses provider invocation', async () => {
  const ctx = await verify();
  await assert.rejects(send(ctx, metadata, '')); await assert.rejects(send(ctx, {}));
  assert.equal(calls.create.length, 0);
});
test('D02 partial response cannot become confirmed evidence and create is never retried', async () => {
  inject(client({ transfers: { create: async () => { calls.create.push({}); return { id: 'tr_fixture', object: 'transfer' }; } } }));
  await assert.rejects(send(await verify()), /evidence/i); assert.equal(calls.create.length, 1);
});
test('D02 mismatched financial fields, mode or correlation cannot become confirmed evidence', async () => {
  for (const patch of [{ amount: 999 }, { destination: 'acct_wrong_fixture' }, { currency: 'eur' }, { livemode: true }, { metadata: {} }]) {
    inject(client({ transfers: { create: async (p) => { calls.create.push({}); return { id: 'tr_fixture', object: 'transfer', amount: p.amount, destination: p.destination, currency: p.currency, livemode: false, metadata: p.metadata, ...patch }; } } }));
    await assert.rejects(send(await verify()), /evidence/i);
  }
  assert.equal(calls.create.length, 5);
});
