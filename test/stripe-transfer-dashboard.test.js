'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '../public/dashboard.html'), 'utf8');
const start = src.indexOf('// D0: durable withdrawal request identity');
const end = src.indexOf('// ── Auto-publish clean learnings', start);
const requestId = '114bb3f8-18af-4ed1-8e34-2474cde75417';
function harness(options = {}) {
  assert.ok(start >= 0 && end > start, 'withdrawal state machine block exists');
  const storage = options.storage || new Map(); const calls = []; const nodes = new Map(); let uuidCount = 0;
  function node(id) { if (!nodes.has(id)) nodes.set(id, { id, value: '5', style: {}, disabled: false, textContent: '', focus() { this.focused = true; }, scrollIntoView() {} }); return nodes.get(id); }
  const ctx = {
    document: { getElementById: node }, window: {}, console, Date, Number, JSON, Promise,
    crypto: options.noCrypto ? {} : { randomUUID() { uuidCount++; return uuidCount === 1 ? requestId : '214bb3f8-18af-4ed1-8e34-2474cde75417'; } },
    localStorage: { getItem: (k) => storage.get(k) || null, setItem(k, v) { if (options.storageFailure) throw Error('denied'); storage.set(k, v); }, removeItem: (k) => storage.delete(k) },
    getToken: () => 'fixture-session', show: (id) => { node(id).style.display = ''; },
    apiFetch: async (url, opts = {}) => { calls.push({ url, opts, stored: [...storage.values()] }); const r = await (options.respond || (() => ({ status: 200, data: { account_id: 'owner-a', attempt: null } })))(url, opts); return { status: r.status, ok: r.status < 300, json: async () => r.data }; },
  };
  vm.createContext(ctx); vm.runInContext(src.slice(start, end), ctx);
  return { ctx, calls, storage, node, uuidCount: () => uuidCount };
}
function attempt(status = 'unknown', extra = {}) { return { attempt_id: 'attempt-fixture', client_request_key: requestId, status, amount_usd: 5, status_url: '/account/stripe-transfer-attempts/attempt-fixture', ...extra }; }
const draft = () => JSON.stringify({ request_id: requestId, account_id: 'owner-a', amount_usd: 5, created_at: new Date().toISOString() });

test('D13 persists UUID owner draft before POST and sends required header', async () => {
  const h = harness({ respond: (u) => u === '/withdraw/stripe' ? { status: 202, data: attempt() } : { status: 200, data: { account_id: 'owner-a', attempt: null } } });
  await h.ctx.initializeStripeWithdrawal(); await h.ctx.doWithdraw();
  const post = h.calls.find(c => c.opts.method === 'POST'); assert.ok(post);
  assert.equal(post.opts.headers['Idempotency-Key'], requestId);
  const persisted = JSON.parse(post.stored[0]);
  assert.equal(persisted.request_id, requestId); assert.equal(persisted.account_id, 'owner-a');
  assert.equal(persisted.amount_usd, 5); assert.ok(Number.isFinite(Date.parse(persisted.created_at)));
  assert.deepEqual(Object.keys(persisted).sort(), ['account_id', 'amount_usd', 'created_at', 'request_id']);
  assert.equal(h.node('withdraw-btn').disabled, true);
  assert.match(h.node('withdraw-alert').textContent, /being checked/);
});
test('D13 202 pending never reports success or arrival time; next action only GETs', async () => {
  const h = harness({ respond: (u) => u === '/withdraw/stripe' ? { status: 202, data: attempt() } : { status: 200, data: { account_id: 'owner-a', attempt: h.calls.some(c => c.opts.method === 'POST') ? attempt() : null } } });
  await h.ctx.initializeStripeWithdrawal(); await h.ctx.doWithdraw(); await h.ctx.checkStripeWithdrawalStatus();
  assert.equal(h.calls.filter(c => c.opts.method === 'POST').length, 1); assert.equal(h.uuidCount(), 1);
  assert.doesNotMatch(h.node('withdraw-alert').textContent, /success|arrive|business days/i);
});
test('D13 response loss preserves key across reload and never automatically POSTs', async () => {
  const storage = new Map();
  const h = harness({ storage, respond: (u) => { if (u === '/withdraw/stripe') throw Error('lost'); return { status: 200, data: { account_id: 'owner-a', attempt: null } }; } });
  await h.ctx.initializeStripeWithdrawal(); await h.ctx.doWithdraw(); assert.equal(storage.size, 1);
  const reload = harness({ storage, respond: () => ({ status: 200, data: { account_id: 'owner-a', attempt: attempt() } }) });
  await reload.ctx.initializeStripeWithdrawal(); assert.equal(reload.calls.filter(c => c.opts.method === 'POST').length, 0);
  assert.equal(reload.node('withdraw-btn').disabled, true); assert.equal(reload.uuidCount(), 0);
});
test('D13 terminal receipt remains until explicit new-withdrawal click', async () => {
  const terminal = attempt('completed', { receipt: { transfer_id: 'tr_fixture', amount_transferred_usd: 4.75, remaining_balance: 0, status: 'completed' } });
  const h = harness({ respond: () => ({ status: 200, data: { account_id: 'owner-a', attempt: terminal } }) });
  await h.ctx.initializeStripeWithdrawal(); assert.equal(h.node('withdraw-btn').disabled, true);
  assert.match(h.node('withdraw-alert').textContent, /tr_fixture/);
  assert.equal(h.node('withdraw-new-btn').style.display, '');
  h.ctx.startNewStripeWithdrawal(); assert.equal(h.node('withdraw-btn').disabled, false); assert.equal(h.uuidCount(), 0);
});
test('D14 unavailable crypto and failed storage prevent send', async () => {
  for (const options of [{ noCrypto: true }, { storageFailure: true }]) {
    const h = harness(options); await h.ctx.initializeStripeWithdrawal(); await h.ctx.doWithdraw();
    assert.equal(h.calls.filter(c => c.opts.method === 'POST').length, 0);
  }
});
test('D14 owner namespace prevents reusing another account request', async () => {
  const storage = new Map([['auxilo_stripe_withdrawal:owner-a', draft()]]);
  const h = harness({ storage, respond: () => ({ status: 200, data: { account_id: 'owner-b', attempt: null } }) });
  await h.ctx.initializeStripeWithdrawal(); await h.ctx.doWithdraw();
  assert.equal(JSON.parse(storage.get('auxilo_stripe_withdrawal:owner-a')).account_id, 'owner-a');
  assert.equal(JSON.parse(storage.get('auxilo_stripe_withdrawal:owner-b')).account_id, 'owner-b');
});
test('D14 ambiguous local/server key disagreement blocks new POST', async () => {
  const h = harness({ storage: new Map([['auxilo_stripe_withdrawal:owner-a', draft()]]), respond: () => ({ status: 200, data: { account_id: 'owner-a', attempt: attempt('completed', { client_request_key: 'different-key' }) } }) });
  await h.ctx.initializeStripeWithdrawal(); await h.ctx.doWithdraw();
  assert.equal(h.calls.filter(c => c.opts.method === 'POST').length, 0); assert.equal(h.node('withdraw-btn').disabled, true);
});
test('D14 server read failure prevents fresh withdrawal', async () => {
  const h = harness({ respond: () => ({ status: 503, data: {} }) });
  await h.ctx.initializeStripeWithdrawal(); await h.ctx.doWithdraw(); assert.equal(h.calls.length, 1);
});
test('D14 409 in-flight remains pending and Terms 403 retains clickwrap behavior', async () => {
  for (const [status, code] of [[409, 'WITHDRAWAL_IN_FLIGHT'], [403, 'TERMS_NOT_ACCEPTED']]) {
    const h = harness({ respond: (u) => u === '/withdraw/stripe' ? { status, data: { ...attempt(), code } } : { status: 200, data: { account_id: 'owner-a', attempt: null } } });
    await h.ctx.initializeStripeWithdrawal(); await h.ctx.doWithdraw();
    if (status === 403) { assert.equal(h.node('terms-gate').style.display, ''); assert.equal(h.node('terms-read-btn').focused, true); }
    else assert.match(h.node('withdraw-alert').textContent, /being checked/);
    assert.equal(h.node('withdraw-btn').disabled, true);
  }
});
test('D13 explicit same-key first-send retry follows null authoritative status only', async () => {
  const h = harness({ storage: new Map([['auxilo_stripe_withdrawal:owner-a', draft()]]) });
  await h.ctx.initializeStripeWithdrawal(); assert.equal(h.calls.filter(c => c.opts.method === 'POST').length, 0);
  await h.ctx.doWithdraw(); const post = h.calls.find(c => c.opts.method === 'POST');
  assert.equal(post.opts.headers['Idempotency-Key'], requestId); assert.equal(h.uuidCount(), 0);
});
test('D14 sign-out only removes session and 401 remains delegated to apiFetch', () => {
  const clear = src.slice(src.indexOf('function clearToken()'), src.indexOf('function clearToken()') + 160);
  assert.match(clear, /removeItem\(SESSION_KEY\)/); assert.doesNotMatch(clear, /localStorage\.clear/);
  const wrapper = src.slice(src.indexOf('function apiFetch'), src.indexOf('function apiFetch') + 1800);
  assert.match(wrapper, /r.status === 401/); assert.match(wrapper, /handleSessionEnded\(\)/);
});
test('D15 OpenAPI documents required key and authenticated private status reads', () => {
  const api = JSON.parse(fs.readFileSync(path.join(__dirname, '../openapi.json'), 'utf8'));
  assert.ok(api.paths['/withdraw/stripe'].post.parameters.some(p => p.name === 'Idempotency-Key' && p.required));
  for (const route of ['/account/stripe-transfer-attempts/current', '/account/stripe-transfer-attempts/{id}']) assert.ok(api.paths[route].get.security.length);
  assert.ok(api.paths['/withdraw/stripe'].post.responses['202']); assert.ok(api.paths['/withdraw/stripe'].post.responses['409']);
});

test('D14 failed fresh status read cannot re-enable new withdrawal from an older terminal receipt', async () => {
  let unavailable = false;
  const h = harness({ respond: () => unavailable ? { status: 503, data: {} } : { status: 200, data: { account_id: 'owner-a', attempt: attempt('completed', { receipt: { transfer_id: 'tr_fixture', amount_transferred_usd: 4.75 } }) } } });
  await h.ctx.initializeStripeWithdrawal(); unavailable = true;
  await h.ctx.checkStripeWithdrawalStatus(); h.ctx.startNewStripeWithdrawal(); await h.ctx.doWithdraw();
  assert.equal(h.node('withdraw-btn').disabled, true);
  assert.equal(h.calls.filter(c => c.opts.method === 'POST').length, 0);
});
test('D14 another tab writing a draft after preflight cannot cause a new-key POST', async () => {
  const storage = new Map(); const h = harness({ storage });
  await h.ctx.initializeStripeWithdrawal(); storage.set('auxilo_stripe_withdrawal:owner-a', draft());
  await h.ctx.doWithdraw(); assert.equal(h.calls.filter(c => c.opts.method === 'POST').length, 0); assert.equal(h.uuidCount(), 0);
});
test('D13 completed POST displays recorded receipt and explicit new action alone permits fresh identity', async () => {
  const h = harness({ respond: (u) => u === '/withdraw/stripe' ? { status: 200, data: { attempt_id: 'attempt-fixture', status: 'completed', transfer_id: 'tr_fixture', amount_transferred_usd: 4.75 } } : { status: 200, data: { account_id: 'owner-a', attempt: null } } });
  await h.ctx.initializeStripeWithdrawal(); await h.ctx.doWithdraw(); await h.ctx.doWithdraw();
  assert.equal(h.calls.filter(c => c.opts.method === 'POST').length, 1);
  assert.match(h.node('withdraw-alert').textContent, /tr_fixture/);
  h.ctx.startNewStripeWithdrawal(); await h.ctx.doWithdraw();
  const posts = h.calls.filter(c => c.opts.method === 'POST'); assert.equal(posts.length, 2);
  assert.notEqual(posts[0].opts.headers['Idempotency-Key'], posts[1].opts.headers['Idempotency-Key']);
});
