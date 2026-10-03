'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SignJWT } = require('jose');
const { chromium } = require('playwright');
const { reservePort, stageServer, bootServer, stopServer } = require('./helpers/staged-server');
const { grantPublicationTrust } = require('../lib/publication-authority');
const REPO = path.join(__dirname, '..');
const SECRET = 'slw-six-planted-session-secret-32bytes';
const ADMIN = 'slw-six-planted-admin-token';
const KEY = 'axl_c_slw_six_planted_api_key';
const KEY_HASH = crypto.createHash('sha256').update(KEY).digest('hex');
const MIXED_KEY = 'axl_c_slw_six_mixed_auth_fixture';
const MIXED_HASH = crypto.createHash('sha256').update(MIXED_KEY).digest('hex');
const SESSION_MESSAGE = 'Your approval is saved. Auxilo checks a new account before it is cleared to publish, and you do not need to approve this learning again.';
const KEY_MESSAGE = 'Your approval is saved. Auxilo checks a new account before it is cleared to publish. Once your account is cleared, approve this learning again to publish it.';
const OLD = new Date(Date.now() - 10 * 86400000).toISOString();
function approval(account, extra = {}) { return { by: account, at: OLD, flagged: false, auth: 'session', batch: null, client: 'dashboard', ...extra }; }
function learning(id, account, extra = {}) {
  return { id, title: 'Technical observation ' + id, body: 'A generic technical fact about Node streams and bounded buffers.', category: 'code-execution', tags: ['node'], created_at: OLD, status: 'pending_review', visibility: 'public', contributor_account_id: account, submission_channel: 'extraction', quality_self_assessment: { specificity: 4, actionability: 4, novelty: 4, completeness: 4, total: 16 }, ...extra };
}

describe('SLW-6: saved approval, publication and provenance', { timeout: 120000 }, () => {
  let tmp, dataDir, boot, base, browser;
  const accountNames = ['session', 'key', 'mixed', 'freshflag', 'vocab', 'malicious', 'bulk', 'brake', 'operator', 'wrong', 'withdraw', 'direct', 'legacy', 'trusted', 'r8', 'retry', 'lateflag', 'failone', 'failbulk', 'failr8', 'decisions', 'signal', 'sanitize', 'ui', 'uitrust'];
  const accounts = Object.fromEntries(accountNames.map(name => { const id = 'acc_' + name; return [id, { id, email: name + '@example.com', created_at: OLD }]; }));
  accounts.acc_key.api_keys = [{ id: 'key_fixture', hash: KEY_HASH, label: 'Fixture key', name: 'Fixture key', scope: 'contribute', scope_version: 2, active: true, created_at: OLD }];
  accounts.acc_mixed.api_keys = [{ id: 'key_mixed', hash: MIXED_HASH, label: 'Mixed key', scope: 'contribute', scope_version: 2, active: true, created_at: OLD }];
  grantPublicationTrust(accounts.acc_trusted, { source: 'operator_grant', ref: 'fixture', grantedAt: OLD });
  grantPublicationTrust(accounts.acc_uitrust, { source: 'operator_grant', ref: 'fixture', grantedAt: OLD });
  const initial = [
    learning('mixed-api-first', 'acc_mixed', { contributor_approval: approval('acc_mixed', { auth: 'api_key', key_id: 'key_mixed', label: 'Mixed key' }) }),
    learning('mixed-session-first', 'acc_mixed', { contributor_approval: approval('acc_mixed') }),
    learning('mixed-clear', 'acc_mixed', { contributor_approval: approval('acc_mixed') }),
    learning('freshflag', 'acc_freshflag', { contributor_approval: approval('acc_freshflag'), sensitivity_signals: ['proprietary_context'] }),
    learning('one', 'acc_session'), learning('key', 'acc_key'), learning('key-stays', 'acc_key', { contributor_approval: approval('acc_key', { auth: 'api_key', key_id: 'key_fixture', label: 'Fixture key' }) }),
    learning('vocab', 'acc_vocab', { body: 'Use private-widget for this operation.' }), learning('vocab-peer', 'acc_vocab', { body: 'Retry private-widget after a failed operation.' }),
    learning('malicious', 'acc_malicious', { platform_hold_reasons: ['malicious_content'] }),
    ...['b1', 'b2', 'b3'].map(id => learning(id, 'acc_bulk')),
    learning('brake', 'acc_brake'), learning('operator', 'acc_operator'), learning('wrong', 'acc_wrong', { contributor_approval: approval('acc_someone_else') }),
    learning('withdraw-reject', 'acc_withdraw'), learning('withdraw-private', 'acc_withdraw'),
    learning('direct', 'acc_direct', { submission_channel: 'direct' }), learning('legacy', 'acc_legacy', { submission_channel: undefined }),
    learning('no-account', null), learning('deleted-account', 'acc_deleted'),
    learning('trusted', 'acc_trusted', { injection_flags: [{ pattern_id: 'p1' }] }), learning('trusted-hold', 'acc_trusted', { platform_hold_reasons: ['malicious_content'] }),
    learning('r8-a', 'acc_r8'), learning('r8-b', 'acc_r8', { contributor_approval: approval('acc_r8') }),
    learning('r8-c', 'acc_r8', { body: 'Use secret-widget for this operation.' }), learning('r8-peer', 'acc_r8', { body: 'Retry secret-widget after this operation.' }), learning('r8-d', 'acc_r8'),
    learning('retry-a', 'acc_retry', { status: 'approved', moderation: 'manual', moderation_action: { action: 'approved', at: OLD } }), learning('retry-b', 'acc_retry', { contributor_approval: approval('acc_retry') }),
    learning('late-a', 'acc_lateflag', { contributor_approval: approval('acc_lateflag') }), learning('late-b', 'acc_lateflag', { contributor_approval: approval('acc_lateflag'), sensitivity_signals: ['proprietary_context'] }),
    learning('failone', 'acc_failone'), learning('failbulk', 'acc_failbulk'),
    learning('failr8-a', 'acc_failr8', { contributor_approval: approval('acc_failr8') }), learning('failr8-b', 'acc_failr8', { contributor_approval: approval('acc_failr8') }),
    ...['reject', 'private', 'bulk-reject', 'bulk-private'].map(id => learning('decision-' + id, 'acc_decisions')),
    ...Array.from({ length: 101 }, (_, i) => learning('signal-' + i, 'acc_signal', { sensitivity_signals: ['proprietary_context'] })),
    learning('sanitize', 'acc_sanitize', { contributor_approval: approval('acc_sanitize') }),
    learning('ui-bulk1', 'acc_ui'), learning('ui-bulk2', 'acc_ui'), learning('ui-bulkflag', 'acc_ui', { sensitivity_signals: ['person_name'] }), learning('bad-client', 'acc_decisions'), learning('long-client', 'acc_decisions'), learning('ui', 'acc_ui'), learning('ui-flag', 'acc_ui', { sensitivity_signals: ['proprietary_context'] }), learning('uitrust', 'acc_uitrust'),
    learning('key-reject', 'acc_key'), learning('key-private', 'acc_key'), learning('key-bulk', 'acc_key'), learning('key-signal', 'acc_key', { sensitivity_signals: ['person_name'] }), learning('key-sanitize', 'acc_key'),
  ];
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-slw-six-'));
    const reservation = await reservePort(); assert.ok(reservation.port);
    const hono = require.resolve('hono', { paths: [REPO] });
    const staged = stageServer({ repoRoot: REPO, tmpDir: tmp,
      nodeModulesDir: hono.slice(0, hono.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length), port: reservation.port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'], linkDirs: ['docs'], copyDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [
        { name: 'catalog-save fault injection', search: 'function safeWrite(filepath, data) {', replace: `function safeWrite(filepath, data) {
          const faultFile = path.join(DATA_DIR, 'test-save-fault.json');
          if (filepath === LEARNINGS_FILE && fs.existsSync(faultFile)) {
            const fault = JSON.parse(fs.readFileSync(faultFile, 'utf8'));
            if (data.some(l => l.id === fault.id && (!fault.via || l.self_review_action?.via === fault.via))) throw new Error('injected catalog save failure');
          }` },
        { name: 'six-days-later retraction clock', search: 'const daysSincePublish = (Date.now() - publishedAt) / 86400000;', replace: "const daysSincePublish = (Date.now() + (fs.existsSync(path.join(DATA_DIR, 'test-six-days-later')) ? 6 * 86400000 : 0) - publishedAt) / 86400000;" },
      ],
    });
    dataDir = staged.dataDir;
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify(accounts));
    fs.writeFileSync(path.join(dataDir, 'learnings.json'), JSON.stringify(initial));
    for (const file of ['earnings', 'magic_links', 'credits']) fs.writeFileSync(path.join(dataDir, file + '.json'), '{}');
    boot = await bootServer({ tmpDir: tmp, port: reservation.port, env: { NODE_ENV: 'test', SESSION_SECRET: SECRET, AUXILO_ADMIN_TOKEN: ADMIN, RESEND_API_KEY: '', LLM_SENSITIVITY_ENABLED: 'false', WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32) } });
    assert.ok(boot.child); base = boot.baseUrl; browser = await chromium.launch();
  });
  after(async () => { if (browser) await browser.close(); if (boot?.child) await stopServer(boot.child); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });
  function disk() { return JSON.parse(fs.readFileSync(path.join(dataDir, 'learnings.json'))); }
  function row(id) { return disk().find(l => l.id === id); }
  async function token(name) { return new SignJWT({ accountId: 'acc_' + name, email: name + '@example.com' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('10m').sign(Buffer.from(SECRET)); }
  async function request(route, name, body, method = 'POST', extraHeaders = {}) {
    const headers = { 'Content-Type': 'application/json', ...(name === 'admin' ? { Authorization: 'Bearer ' + ADMIN } : name === 'api' ? { 'X-API-Key': KEY } : name === 'mixed-api' ? { 'X-API-Key': MIXED_KEY } : { Authorization: 'Bearer ' + await token(name) }), ...extraHeaders };
    const r = await fetch(base + route, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = { text }; }
    return { status: r.status, data };
  }
  const approve = (id, name, headers = {}) => request('/account/pending/' + id + '/approve', name, undefined, 'POST', headers);
  const operator = id => request('/admin/moderation/' + id + '/approve', 'admin');
  const bulk = (ids, name, decision = 'approve', headers = {}) => request('/account/pending/bulk', name, { decisions: ids.map(id => ({ id, decision })), confirm_count: ids.length }, 'POST', headers);
  function fault(value) { const f = path.join(dataDir, 'test-save-fault.json'); if (value) fs.writeFileSync(f, JSON.stringify(value)); else fs.rmSync(f, { force: true }); }

  it('t1: session approval is saved on disk without publication', async () => {
    const r = await approve('one', 'session', { 'X-Auxilo-Client': 'dashboard' });
    assert.equal(r.status, 409); assert.equal(r.data.code, 'operator_review_required'); assert.equal(r.data.approval_recorded, true); assert.equal(r.data.error, SESSION_MESSAGE);
    assert.equal(row('one').status, 'pending_review'); assert.equal(row('one').self_review_action.action, 'approval_recorded'); assert.equal(row('one').self_review_action.auth, 'session'); assert.deepEqual({ ...row('one').contributor_approval, at: 'time' }, { by: 'acc_session', at: 'time', flagged: false, auth: 'session', batch: null, client: 'dashboard' });
  });
  it('t2: API-key approval records id and label, with the key-specific message', async () => {
    const r = await approve('key', 'api', { 'X-Auxilo-Client': 'cli' }); assert.equal(r.status, 409); assert.equal(r.data.error, KEY_MESSAGE);
    assert.deepEqual({ ...row('key').contributor_approval, at: 'time' }, { by: 'acc_key', at: 'time', flagged: false, auth: 'api_key', key_id: 'key_fixture', label: 'Fixture key', batch: null, client: 'cli' });
  });
  it('t3: account vocabulary alone records a flagged approval', async () => {
    const r = await approve('vocab', 'vocab'); assert.equal(r.status, 409); assert.equal(r.data.code, 'platform_review_required'); assert.equal(row('vocab').contributor_approval.flagged, true); assert.equal(row('vocab').status, 'pending_review');
  });
  it('t4: malicious-content holds record approval but stay pending', async () => {
    const r = await approve('malicious', 'malicious'); assert.equal(r.data.code, 'platform_review_required'); assert.equal(row('malicious').contributor_approval.flagged, true);
  });
  it('t5: bulk records three on disk while retaining failed=3', async () => {
    const r = await bulk(['b1', 'b2', 'b3'], 'bulk'); assert.equal(r.status, 200); assert.equal(r.data.recorded, 3); assert.equal(r.data.failed, 3);
    const records = ['b1', 'b2', 'b3'].map(id => row(id).contributor_approval); assert.equal(new Set(records.map(r => r.batch.id)).size, 1); assert.equal(records[0].batch.size, 3);
  });
  it('t6: operator cannot publish unapproved extraction; files are unchanged', async () => {
    const before = fs.readFileSync(path.join(dataDir, 'learnings.json'), 'utf8'); const beforeAccounts = fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8');
    const r = await operator('brake'); assert.equal(r.status, 409); assert.equal(r.data.code, 'BUILDER_APPROVAL_REQUIRED'); assert.equal(r.data.error, 'Its builder has not approved this learning yet, so it cannot be published.');
    assert.equal(fs.readFileSync(path.join(dataDir, 'learnings.json'), 'utf8'), before); assert.equal(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'), beforeAccounts);
  });
  it('t7: operator can publish recorded consent and grants trust', async () => {
    await approve('operator', 'operator'); const r = await operator('operator'); assert.equal(r.status, 200); assert.equal(r.data.publication_trust_granted, true); assert.equal(row('operator').status, 'approved'); assert.equal(row('operator').moderation_action.auth, 'admin_token'); assert.equal(row('operator').moderation_action.scope, 'admin');
  });
  it('t8: another account approval does not satisfy the operator brake', async () => { assert.equal((await operator('wrong')).data.code, 'BUILDER_APPROVAL_REQUIRED'); assert.equal(row('wrong').status, 'pending_review'); });
  it('t9: reject and keep-private withdraw recorded consent', async () => {
    for (const [id, action] of [['withdraw-reject', 'reject'], ['withdraw-private', 'keep-private']]) { await approve(id, 'withdraw'); assert.equal((await request('/account/pending/' + id + '/' + action, 'withdraw', {})).status, 200); assert.equal(row(id).contributor_approval, undefined); }
  });
  it('t10: direct, channel-less, account-less and deleted-account exceptions remain', async () => {
    for (const id of ['direct', 'legacy', 'no-account', 'deleted-account']) { assert.equal((await operator(id)).status, 200, id); assert.equal(row(id).status, 'approved'); }
  });
  it('t11: cleared flow and non-bypassable holds retain their prior behavior', async () => {
    assert.equal((await approve('trusted', 'trusted')).status, 200); assert.equal(row('trusted').status, 'approved');
    const held = await approve('trusted-hold', 'trusted'); assert.equal(held.status, 409); assert.equal(held.data.approval_recorded, undefined); assert.equal(row('trusted-hold').contributor_approval, undefined);
  });
  it('t12: queue projections and summary expose approval and trust state', async () => {
    const queue = await request('/admin/moderation/queue', 'admin', undefined, 'GET'); const entry = queue.data.learnings.find(l => l.id === 'one');
    assert.equal(entry.contributor_approval_at, row('one').contributor_approval.at); assert.equal(entry.contributor_approval_flagged, false); assert.equal(entry.submission_channel, 'extraction'); assert.equal(entry.contributor_approval.auth, 'session');
    assert.equal((await request('/account/pending/summary', 'session', undefined, 'GET')).data.cleared_to_publish, false);
    assert.equal((await request('/account/pending/summary', 'operator', undefined, 'GET')).data.cleared_to_publish, true);
    const own = await request('/account/pending', 'session', undefined, 'GET'); assert.equal(own.data.learnings[0].contributor_approval_at, entry.contributor_approval_at);
  });
  it('t13: repeated approval preserves the first record and instant', async () => { const first = row('one').contributor_approval; await approve('one', 'session'); assert.deepEqual(row('one').contributor_approval, first); });
  it('review M1: API then dashboard records the qualifying human time and publishes at clearing', async () => {
    const original = row('mixed-api-first').contributor_approval;
    assert.equal(original.auth, 'api_key'); const before = Date.now();
    const result = await approve('mixed-api-first', 'mixed', { 'X-Auxilo-Client': 'dashboard' });
    assert.equal(result.data.error, SESSION_MESSAGE);
    const recorded = row('mixed-api-first').contributor_approval;
    assert.equal(recorded.auth, 'session'); assert.ok(Date.parse(recorded.at) >= before); assert.notEqual(recorded.at, original.at); assert.equal(recorded.key_id, undefined);
    assert.equal(row('mixed-api-first').self_review_action.action, 'approval_recorded');
    const repeated = await approve('mixed-api-first', 'mixed', { 'X-Auxilo-Client': 'dashboard' });
    assert.equal(repeated.status, 409); assert.deepEqual(row('mixed-api-first').contributor_approval, recorded);
  });
  it('review M2: later API requests retain session authority and record their own current provenance', async () => {
    const first = row('mixed-session-first').contributor_approval;
    const result = await approve('mixed-session-first', 'mixed-api', { 'X-Auxilo-Client': 'cli' });
    assert.equal(result.data.error, KEY_MESSAGE); assert.deepEqual(row('mixed-session-first').contributor_approval, first);
    const action = row('mixed-session-first').self_review_action;
    assert.equal(action.action, 'approval_recorded'); assert.equal(action.auth, 'api_key'); assert.equal(action.key_id, 'key_mixed'); assert.equal(action.client, 'cli');
    const humanAt = row('mixed-api-first').contributor_approval.at;
    const cleared = await operator('mixed-clear'); assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.data.recorded_approval_ids.sort(), ['mixed-api-first', 'mixed-session-first']);
    assert.equal(row('mixed-api-first').self_review_action.approved_at, humanAt);
    assert.equal(row('mixed-session-first').self_review_action.approved_at, first.at);
    assert.equal(row('mixed-api-first').self_review_action.auth, 'session');
  });
  it('review M3: repeat approval reports fresh flags and dashboard shows the flagged result', async () => {
    const first = row('freshflag').contributor_approval;
    assert.equal(first.flagged, false);
    const result = await approve('freshflag', 'freshflag', { 'X-Auxilo-Client': 'dashboard' });
    assert.equal(result.data.code, 'platform_review_required'); assert.equal(result.data.approval_flagged, true); assert.deepEqual(row('freshflag').contributor_approval, first);
    const page = await browser.newPage(); await page.addInitScript(t => localStorage.setItem('auxilo_session', t), await token('freshflag'));
    page.on('dialog', d => d.accept()); await page.goto(base + '/dashboard', { waitUntil: 'networkidle' });
    await page.locator('#triage-title-freshflag').click(); await page.locator('#triage-detail-freshflag').getByRole('button', { name: 'Approve', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('pending-result-freshflag').style.display !== 'none');
    assert.equal(await page.locator('#pending-result-freshflag').textContent(), 'Your approval is saved. A screen flagged this learning, so it stays in your queue for you to decide again once your account is cleared to publish.');
    assert.equal(await page.getByText('Approved, waiting on Auxilo', { exact: true }).count(), 0); await page.close();
  });
  it('t14: clearing publishes only a saved unflagged dashboard approval with fresh publication time', async () => {
    await approve('r8-a', 'r8'); await approve('r8-c', 'r8'); const before = Date.now(); const r = await operator('r8-a');
    assert.deepEqual(r.data.recorded_approval_ids, ['r8-b']); const b = row('r8-b'); assert.equal(b.status, 'approved'); assert.equal(b.self_review_action.action, 'self_approve'); assert.equal(b.self_review_action.via, 'recorded_approval'); assert.equal(b.self_review_action.approved_at, OLD); assert.ok(Date.parse(b.self_review_action.at) >= before);
    for (const id of ['r8-c', 'r8-d']) assert.equal(row(id).status, 'pending_review');
  });
  it('t15: API approvals remain pending when the account is cleared', async () => { const r = await operator('key'); assert.equal(r.status, 200); assert.equal(row('key-stays').status, 'pending_review'); assert.deepEqual(r.data.recorded_approval_ids, []); });
  it('t16: idempotent operator retry applies saved dashboard approvals', async () => { const r = await operator('retry-a'); assert.equal(r.status, 200); assert.equal(r.data.idempotent, true); assert.ok(r.data.recorded_approval_ids.includes('retry-b')); assert.equal(row('retry-b').status, 'approved'); });
  it('t17: a flag arising after recorded approval prevents publication at clearing', async () => { const r = await operator('late-a'); assert.equal(r.status, 200); assert.equal(row('late-b').contributor_approval.flagged, false); assert.equal(row('late-b').status, 'pending_review'); assert.deepEqual(r.data.recorded_approval_ids, []); });
  it('t18: retraction six days after clearing ignores a ten-day-old approval', async () => {
    fs.writeFileSync(path.join(dataDir, 'test-six-days-later'), '1');
    try { const r = await request('/learn/r8-b?reason=retract', 'r8', undefined, 'DELETE'); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.notEqual(row('r8-b').status, 'approved'); }
    finally { fs.rmSync(path.join(dataDir, 'test-six-days-later')); }
  });
  it('t19a: reject, private and bulk persist session audit fields', async () => {
    for (const [id, action] of [['decision-reject', 'reject'], ['decision-private', 'keep-private']]) {
      assert.equal((await request('/account/pending/' + id + '/' + action, 'decisions', {}, 'POST', { 'X-Auxilo-Client': 'dashboard' })).status, 200); assert.equal(row(id).self_review_action.auth, 'session'); assert.equal(row(id).self_review_action.batch, null); assert.equal(row(id).self_review_action.client, 'dashboard');
    }
    await bulk(['decision-bulk-reject', 'decision-bulk-private'], 'decisions', 'reject'); assert.equal(row('decision-bulk-reject').self_review_action.batch.id, row('decision-bulk-private').self_review_action.batch.id);
  });
  it('t19b: reject-by-signal shares one batch id across 101 items and both chunks', async () => {
    const r = await request('/account/pending/reject-by-signal', 'signal', { signal: 'proprietary_context', expected_count: 101 }); assert.equal(r.status, 200); assert.equal(r.data.rejected, 101);
    const first = row('signal-0').self_review_action, last = row('signal-100').self_review_action; assert.equal(first.batch.id, last.batch.id); assert.equal(first.batch.size, 101); assert.equal(first.auth, 'session');
  });
  it('t19c: sanitize stamps the original and replacement inherits no approval', async () => {
    const r = await request('/account/pending/sanitize/sanitize', 'sanitize', { title: 'Node stream buffers apply backpressure at the configured high water mark', body: 'Node streams stop requesting additional chunks when their internal buffer reaches the configured high water mark. A writable stream signals backpressure by returning false from write. Producers must wait for the drain event before writing again. This prevents an unbounded buffer from consuming memory when a producer is faster than its destination.', tags: ['node-streams'] });
    assert.equal(r.status, 200, JSON.stringify(r.data)); const old = row('sanitize'); assert.equal(old.self_review_action.auth, 'session'); assert.equal(old.contributor_approval, undefined); assert.equal(row(old.sanitized_to).contributor_approval, undefined);
  });
  it('t19d: bad and overlong client hints become null', async () => {
    for (const [id, value] of [['bad-client', 'bad hint!'], ['long-client', 'x'.repeat(41)]]) { await approve(id, 'decisions', { 'X-Auxilo-Client': value }); assert.equal(row(id).contributor_approval.client, null); }
  });
  it('R1 save failure reports no saved approval and restores in-memory state', async () => {
    fault({ id: 'failbulk' }); try { const r = await approve('failbulk', 'failbulk'); assert.equal(r.status, 500); assert.equal(r.data.approval_recorded, undefined); assert.equal(row('failbulk').contributor_approval, undefined); assert.equal(row('failbulk').self_review_action, undefined); const pending = await request('/account/pending', 'failbulk', undefined, 'GET'); assert.equal(pending.data.learnings[0].contributor_approval, undefined); assert.equal(pending.data.learnings[0].self_review_action, undefined); } finally { fault(null); }
  });
  it('R1 bulk save failure restores records and counts are not reported as saved', async () => {
    fault({ id: 'failbulk' }); try { const r = await bulk(['failbulk'], 'failbulk'); assert.equal(r.status, 500); assert.equal(r.data.recorded, undefined); assert.equal(row('failbulk').contributor_approval, undefined); } finally { fault(null); }
  });
  it('R8 save failure leaves operator approval standing and publishes no sibling in memory or on disk', async () => {
    fault({ id: 'failr8-b', via: 'recorded_approval' }); try { const r = await operator('failr8-a'); assert.equal(r.status, 200); assert.deepEqual(r.data.recorded_approval_ids, []); assert.equal(r.data.recorded_approvals_applied, false); assert.equal(row('failr8-a').status, 'approved'); assert.equal(row('failr8-b').status, 'pending_review'); assert.equal((await request('/account/pending', 'failr8', undefined, 'GET')).data.pending_count, 1); } finally { fault(null); }
  });
  it('t19e: every decision site also stamps API key id and label', async () => {
    for (const [id, action] of [['key-reject', 'reject'], ['key-private', 'keep-private']]) assert.equal((await request('/account/pending/' + id + '/' + action, 'api', {}, 'POST', { 'X-Auxilo-Client': 'mcp' })).status, 200);
    assert.equal((await bulk(['key-bulk'], 'api', 'reject', { 'X-Auxilo-Client': 'mcp' })).status, 200);
    assert.equal((await request('/account/pending/reject-by-signal', 'api', { signal: 'person_name', expected_count: 1 }, 'POST', { 'X-Auxilo-Client': 'mcp' })).status, 200);
    const sanitized = await request('/account/pending/key-sanitize/sanitize', 'api', { title: 'HTTP conditional requests use entity tags to avoid transferring unchanged resources', body: 'HTTP clients can store the entity tag received in a response and send it back using the If-None-Match request header. The server compares that validator with the current representation. When the values match, it returns status 304 without a representation body. The client keeps using its cached representation and updates its cache metadata from the response headers.', tags: ['http-cache'] }, 'POST', { 'X-Auxilo-Client': 'mcp' });
    assert.equal(sanitized.status, 200, JSON.stringify(sanitized.data));
    for (const id of ['key-reject', 'key-private', 'key-bulk', 'key-signal', 'key-sanitize']) {
      const audit = row(id).self_review_action; assert.equal(audit.auth, 'api_key'); assert.equal(audit.key_id, 'key_fixture'); assert.equal(audit.label, 'Fixture key'); assert.equal(audit.client, 'mcp'); assert.equal(audit.batch, null);
    }
  });
  it('PM review: provenance projections omit planted unknown fields, reasons and nested secrets', () => {
    const { projectReviewProvenance } = require('../lib/self-review');
    const projected = projectReviewProvenance({ action: 'self_reject', auth: 'session', by: 'acc_fixture', at: OLD,
      reason: 'private body', key_hash: KEY_HASH, token: SECRET,
      batch: { id: 'batch_fixture', size: 2, cookie: ADMIN } });
    assert.deepEqual(projected, { action: 'self_reject', auth: 'session', by: 'acc_fixture', at: OLD, batch: { id: 'batch_fixture', size: 2 } });
    for (const secret of [KEY_HASH, SECRET, ADMIN, 'private body']) assert.equal(JSON.stringify(projected).includes(secret), false);
    const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'openapi.json'))).components.schemas.ReviewDecisionProvenance;
    assert.equal(schema.additionalProperties, false); assert.equal(schema.properties.batch.additionalProperties, false);
  });
  it('t20: stored records, projections and logs carry no planted credentials or hashes', async () => {
    const own = await request('/account/learnings', 'api', undefined, 'GET'); const stored = JSON.stringify(disk()); const output = stored + JSON.stringify(own.data) + boot.getOutput();
    for (const marker of [KEY, KEY_HASH, MIXED_KEY, MIXED_HASH, ADMIN, SECRET, await token('session')]) assert.equal(output.includes(marker), false);
    const operatorRows = await request('/account/learnings', 'operator', undefined, 'GET'); assert.equal(operatorRows.data.learnings[0].moderation_action.auth, 'admin_token');
    const trustedRows = await request('/account/learnings', 'trusted', undefined, 'GET'); assert.equal(trustedRows.data.learnings.find(l => l.id === 'trusted').self_review_action.auth, 'session');
  });
  it('t21: dashboard picks the correct dialog, sends its hint, and styles saved approval as success', async () => {
    for (const [name, id, trusted] of [['ui', 'ui', false], ['uitrust', 'uitrust', true]]) {
      const page = await browser.newPage(); await page.addInitScript(t => localStorage.setItem('auxilo_session', t), await token(name));
      let dialogText, clientHeader; page.on('dialog', async d => { dialogText = d.message(); await d.accept(); });
      page.on('request', r => { if (r.url().endsWith('/' + id + '/approve')) clientHeader = r.headers()['x-auxilo-client']; });
      await page.goto(base + '/dashboard', { waitUntil: 'networkidle' }); await page.locator('#triage-title-' + id).click();
      await page.locator('#triage-detail-' + id).getByRole('button', { name: 'Approve', exact: true }).click();
      await page.waitForFunction(id => document.getElementById('pending-result-' + id).style.display !== 'none', id);
      assert.ok(dialogText.startsWith('Approve 1 learning?')); assert.ok(dialogText.endsWith('This confirmation is your approval of every learning you selected.')); assert.equal(clientHeader, 'dashboard');
      if (trusted) { assert.ok(dialogText.includes('Approving publishes each one to the public catalog unless Auxilo has it held.')); assert.equal(dialogText.includes('Your approval is saved.'), false); }
      else { assert.ok(dialogText.includes('Your approval is saved.')); assert.equal(await page.locator('#pending-result-ui').textContent(), "Your approval is saved. This learning now waits for Auxilo's check, and nothing else is needed from you."); assert.ok((await page.locator('#pending-result-ui').getAttribute('class')).includes('alert-success')); assert.equal(await page.getByText('Approved, waiting on Auxilo', { exact: true }).count(), 1); }
      await page.close();
    }
    assert.equal(row('ui').contributor_approval.auth, 'session'); assert.equal(row('uitrust').status, 'approved');
  });
  it('t21b: mixed bulk uses plural confirmation and exact unflagged then flagged result copy', async () => {
    const page = await browser.newPage(); await page.addInitScript(t => localStorage.setItem('auxilo_session', t), await token('ui'));
    let dialog; page.on('dialog', async d => { dialog = d.message(); await d.accept(); });
    await page.goto(base + '/dashboard', { waitUntil: 'networkidle' });
    for (const id of ['ui-bulk1', 'ui-bulk2', 'ui-bulkflag']) await page.locator('#triage-check-' + id).check();
    await page.locator('#bulk-approve-btn').click();
    await page.waitForFunction(() => document.getElementById('bulk-result').style.display !== 'none');
    assert.ok(dialog.startsWith('Approve 3 learnings?')); assert.ok(dialog.includes('Your approvals are saved.'));
    assert.equal(await page.locator('#bulk-result').textContent(), "Your approvals are saved. These 2 learnings now wait for Auxilo's check, and nothing else is needed from you. A screen flagged 1 of them. Those stay in your queue for you to decide again once your account is cleared to publish.");
    assert.ok((await page.locator('#bulk-result').getAttribute('class')).includes('alert-success')); await page.close();
    for (const id of ['ui-bulk1', 'ui-bulk2', 'ui-bulkflag']) assert.equal(row(id).contributor_approval.auth, 'session');
  });

});
