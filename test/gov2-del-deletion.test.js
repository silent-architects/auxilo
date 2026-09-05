'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  reservePort,
  stageServer,
  bootServer,
  stopServer,
  BOOT_SANDBOX_SKIP_REASON,
} = require('./helpers/staged-server');
const { planTosPruning, TOS_RETENTION_MS } = require('../lib/deletion-cleanup');

const REPO = path.join(__dirname, '..');
const ACCOUNT_ID = 'acc_gov2_del';
const OTHER_ACCOUNT_ID = 'acc_gov2_other';
const WALLET = '0x2222222222222222222222222222222222222222';
const API_KEY = `axl_${'4'.repeat(40)}`;

function writeFixture(dataDir) {
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
    [ACCOUNT_ID]: {
      id: ACCOUNT_ID,
      email: 'delete-me@example.test',
      wallet: WALLET,
      tos_version: '2026-07-01',
      accepted_at: Date.parse('2026-07-01T00:00:00.000Z'),
      accepted_ip: '198.51.100.22',
      accepted_ua: 'GOV2 test',
      accepted_affirmed: true,
      api_keys: [{
        id: 'key_delete_me',
        hash: crypto.createHash('sha256').update(API_KEY).digest('hex'),
        scope: 'contribute',
        scope_version: 2,
        active: true,
      }],
    },
    [OTHER_ACCOUNT_ID]: { id: OTHER_ACCOUNT_ID, email: 'other@example.test', api_keys: [] },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'learnings.json'), JSON.stringify([
    { id: 'own', title: 'own', contributor_account_id: ACCOUNT_ID, status: 'approved', visibility: 'private' },
    { id: 'wallet-only', title: 'wallet-only', contributor_wallet: WALLET, status: 'rejected', visibility: 'private' },
    { id: 'other', title: 'other', contributor_account_id: OTHER_ACCOUNT_ID, status: 'approved', visibility: 'private' },
  ], null, 2));
  fs.writeFileSync(path.join(dataDir, 'verified-wallets.json'), JSON.stringify({ [WALLET.toLowerCase()]: true }));
  fs.writeFileSync(path.join(dataDir, 'extraction-review.jsonl'), `${JSON.stringify({ account_id: ACCOUNT_ID, candidates: [{ body: 'delete this' }] })}\n${JSON.stringify({ account_id: OTHER_ACCOUNT_ID })}\n`);
  fs.writeFileSync(path.join(dataDir, 'extractions.jsonl'), `${JSON.stringify({ account_id: ACCOUNT_ID, response_cache: { body: 'delete this' }, transcript_sha256: 'abc' })}\n${JSON.stringify({ account_id: OTHER_ACCOUNT_ID, response_cache: { body: 'keep' } })}\n`);
  fs.writeFileSync(path.join(dataDir, 'rate-limits.json'), JSON.stringify({
    'delete-me@example.test': { count: 1 }, [WALLET.toLowerCase()]: { count: 1 }, unrelated: { count: 1 },
  }));
  fs.writeFileSync(path.join(dataDir, 'waitlist.json'), JSON.stringify([
    { email: 'delete-me@example.test' }, { email: 'other@example.test' },
  ]));
}

describe('GOV2-DEL deletion routes', { timeout: 180_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;
  let skipReason;

  before(async () => {
    const reservation = await reservePort();
    if ('skipReason' in reservation) { skipReason = reservation.skipReason; return; }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-gov2-del-'));
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const staged = stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port: reservation.port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['lib', 'public', 'prompts', 'config'],
    });
    writeFixture(staged.dataDir);
    const boot = await bootServer({
      tmpDir,
      port: reservation.port,
      env: {
        NODE_ENV: 'test', TEST_MODE: '1', WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        LLM_SENSITIVITY_ENABLED: 'false', AUXILO_DATA_DIR: staged.dataDir,
        AUXILO_ACCOUNTS_FILE: path.join(staged.dataDir, 'accounts.json'),
        AUXILO_MAGIC_LINKS_FILE: path.join(staged.dataDir, 'magic-links.json'),
        AUXILO_IDENTITY_FILE: path.join(staged.dataDir, 'identity.json'),
      },
      timeoutMs: 60_000,
    });
    if ('skipReason' in boot) { skipReason = boot.skipReason; return; }
    child = boot.child;
    baseUrl = boot.baseUrl;
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts the confirmation page\'s own form encoding (the human path), not only JSON', async () => {
    // The GET page posts application/x-www-form-urlencoded. The S-3 body-cap
    // middleware has already consumed the body once; the route must still parse
    // the form. A dummy token proves parsing without consuming a real one:
    // parse OK -> 401 (invalid token); parse failure -> 400.
    const dummy = 'A'.repeat(43);
    const form = await fetch(`${baseUrl}/account/delete-confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ method: 'email', token: dummy }).toString(),
    });
    assert.equal(form.status, 401, `form-encoded confirm must parse (got ${form.status}: ${await form.text()})`);
    const json = await fetch(`${baseUrl}/account/delete-confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'email', token: dummy }),
    });
    assert.equal(json.status, 401);
  });

  it('keeps wallet-only requests non-enumerating until a delete-account proof', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const response = await fetch(`${baseUrl}/account/delete-request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'wallet', wallet: WALLET }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.proof_required, true);
    assert.equal(Object.hasOwn(payload, 'preview'), false);
    assert.equal(payload.eip712.message.action, 'delete-account');
  });

  it('deletes Class A live records and redacts only the extraction response cache', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const challengeResponse = await fetch(`${baseUrl}/account/delete-request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
      body: JSON.stringify({ method: 'wallet', wallet: WALLET }),
    });
    assert.equal(challengeResponse.status, 200);
    const requestPayload = await challengeResponse.json();
    assert.deepEqual(requestPayload.preview.learning_buckets, {
      'approved:private': 1,
      'rejected:private': 1,
    });
    const confirm = await fetch(`${baseUrl}/account/delete-confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'wallet', wallet: WALLET, signature: 'test-bypass' }),
    });
    assert.equal(confirm.status, 200);
    const payload = await confirm.json();
    assert.equal(payload.deleted.learnings, 2);
    assert.equal(payload.deleted.account_record, true);
    assert.equal(payload.deleted.extraction_review_rows, 1);
    assert.equal(payload.deleted.extractions_redacted, 1);
    assert.ok(payload.backups_expire_by > payload.completed_at);
    assert.ok(payload.tos_record_retained_until > payload.completed_at);

    const dataDir = path.join(tmpDir, 'data');
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'))), ACCOUNT_ID), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'learnings.json'))).map((row) => row.id), ['other']);
    assert.equal(fs.readFileSync(path.join(dataDir, 'extraction-review.jsonl'), 'utf8').includes(ACCOUNT_ID), false);
    const extractionRows = fs.readFileSync(path.join(dataDir, 'extractions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(extractionRows.find((row) => row.account_id === ACCOUNT_ID).response_cache, { redacted: 'account_deleted' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'waitlist.json'))).some((row) => row.email === 'delete-me@example.test'), false);
    assert.equal(fs.readFileSync(path.join(dataDir, 'tos-acceptance.jsonl'), 'utf8').includes('delete-me@example.test'), false);
    const audit = JSON.parse(fs.readFileSync(path.join(dataDir, 'deletion-log.jsonl'), 'utf8'));
    assert.deepEqual(Object.keys(audit).sort(), ['account_id', 'completed_at', 'deleted', 'method', 'removed', 'sla_deadline', 'ts', 'wallet']);
    assert.equal(JSON.stringify(audit).includes('delete-me@example.test'), false);
  });

  it('makes a consumed wallet proof and deleted API key fail closed', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const replay = await fetch(`${baseUrl}/account/delete-confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'wallet', wallet: WALLET, signature: 'test-bypass' }),
    });
    assert.equal(replay.status, 401);
    const oldKey = await fetch(`${baseUrl}/account/delete-request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
      body: JSON.stringify({ method: 'email' }),
    });
    assert.equal(oldKey.status, 401);
  });
});

it('keeps deletion tokens purpose-bound and plans ToS pruning from an injected clock', () => {
  const completed = new Date('2026-01-01T00:00:00.000Z');
  const now = new Date(completed.getTime() + TOS_RETENTION_MS);
  assert.deepEqual(planTosPruning([{ account_id: ACCOUNT_ID, completed_at: completed.toISOString() }], now).map((row) => row.account_id), [ACCOUNT_ID]);
  assert.deepEqual(planTosPruning([{ account_id: ACCOUNT_ID, completed_at: completed.toISOString(), tos_pruned_at: now.toISOString() }], now), []);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-gov2-del-unit-'));
  const accountsPath = require.resolve('../lib/accounts');
  const tosPath = require.resolve('../lib/tos-acceptance-log');
  const priorMagicPath = process.env.AUXILO_MAGIC_LINKS_FILE;
  const priorDataDir = process.env.AUXILO_DATA_DIR;
  try {
    process.env.AUXILO_MAGIC_LINKS_FILE = path.join(dataDir, 'magic-links.json');
    process.env.AUXILO_DATA_DIR = dataDir;
    delete require.cache[accountsPath];
    delete require.cache[tosPath];
    const magic = require('../lib/accounts');
    const token = magic.issuePurposeMagicLink('delete-me@example.test', 'delete-account');
    assert.equal(magic.consumePurposeMagicLink(token, 'login'), null);
    assert.equal(magic.consumePurposeMagicLink(token, 'delete-account').email, 'delete-me@example.test');

    const tos = require('../lib/tos-acceptance-log');
    fs.writeFileSync(tos.TOS_LOG_FILE, `${JSON.stringify({ account_id: ACCOUNT_ID })}\n${JSON.stringify({ account_id: OTHER_ACCOUNT_ID })}\n`);
    assert.equal(tos.pruneTosAcceptanceRows(ACCOUNT_ID), 1);
    assert.equal(fs.readFileSync(tos.TOS_LOG_FILE, 'utf8').includes(OTHER_ACCOUNT_ID), true);
  } finally {
    if (priorMagicPath === undefined) delete process.env.AUXILO_MAGIC_LINKS_FILE;
    else process.env.AUXILO_MAGIC_LINKS_FILE = priorMagicPath;
    if (priorDataDir === undefined) delete process.env.AUXILO_DATA_DIR;
    else process.env.AUXILO_DATA_DIR = priorDataDir;
    delete require.cache[accountsPath];
    delete require.cache[tosPath];
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
