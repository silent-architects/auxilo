'use strict';

/**
 * test/clean-lane-phase-a2.test.js — CLEAN-LANE-FLIP Phase A2: the server-side
 * enablers the Phase A dashboard card (public/dashboard-clean-lane.js) needs.
 *
 *   1. GET /account/learnings exposes the SPEC3 C1 standing-consent stamps
 *      (published_via / standing_consent_version / retractable_until) ONLY when
 *      present on the row, and never any screen/ops field.
 *   2. DELETE /learn/:id accepts the owner's session JWT (dashboard Retract),
 *      refuses a non-owner session, and leaves the API-key path unchanged.
 *   3. lib/extraction-index.js localIndexRow persists the three stamps from the
 *      /learn response so scripts/review-notice.js can count them locally.
 *
 * Staged-server pattern: test/spec3-f2-account-learnings.test.js. Session JWTs
 * are minted with jose against the staged SESSION_SECRET (ci5 pattern).
 *
 * Runner: node --test test/clean-lane-phase-a2.test.js
 */

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

const REPO = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const indexLib = require('../lib/extraction-index.js');
const notice = require('../scripts/review-notice.js');
const cleanLane = require('../lib/clean-lane.js');

const SESSION_SECRET = 'clean-lane-a2-test-session-secret-0123456789';
const OWNER = 'acc_clean_lane_a2_owner';
const OTHER = 'acc_clean_lane_a2_other';
const OWNER_KEY = `axl_${'a'.repeat(40)}`;
const OWNER_READ_KEY = `axl_${'b'.repeat(40)}`;
const OTHER_KEY = `axl_${'c'.repeat(40)}`;
const FIXED_AT = '2026-07-26T12:00:00.000Z';
const STAMP_VERSION = cleanLane.CLEAN_LANE_CONSENT_VERSION;
const PUBLISHED_VIA = cleanLane.PUBLISHED_VIA_CLEAN_LANE;

// Retraction window is 7 days from created_at (no approval stamp) — stamped
// rows are created "one hour ago" so they are retractable during the run.
const RECENT_AT = new Date(Date.now() - 3600_000).toISOString();
const UNTIL = new Date(Date.now() + 6 * 86400_000).toISOString();

const SCREEN_FIELDS = [
  'platform_hold_reasons',
  'sensitivity_signals',
  'sensitivity_source',
  'sensitivity_evidence',
  'injection_flags',
  'body',
  'evidence',
  'quality',
  'quality_self_assessment',
];

function fixtureLearning(id, overrides = {}) {
  return {
    id,
    title: `A2 fixture ${id}`,
    body: `Private body for ${id}; never in the listing projection.`,
    category: 'code-execution',
    tags: ['a2', id],
    task_context: 'Phase A2 listing/retract fixture.',
    outcome: 'success',
    status: 'approved',
    visibility: 'public',
    contributor_account_id: OWNER,
    created_at: RECENT_AT,
    // Screen/ops fields that must NEVER reach the listing.
    platform_hold_reasons: [],
    sensitivity_signals: ['person_name'],
    sensitivity_source: 'regex',
    sensitivity_evidence: [{ signal: 'person_name', excerpt: 'x' }],
    injection_flags: [],
    evidence: [{ signal: 'fixture', excerpt: 'strip' }],
    quality: { unlocks: 0, ratings: 0, avg_helpfulness: 0, helpfulness_scores: [], score: 0 },
    quality_self_assessment: { specificity: 4, actionability: 4, novelty: 4, completeness: 4, total: 16 },
    ...overrides,
  };
}

function stamped(id, overrides = {}) {
  return fixtureLearning(id, {
    published_via: PUBLISHED_VIA,
    standing_consent_version: STAMP_VERSION,
    retractable_until: UNTIL,
    submission_channel: 'extraction',
    ...overrides,
  });
}

function fixtureCatalog() {
  return [
    stamped('lrn_a2_stamped'),                 // listing subject
    fixtureLearning('lrn_a2_plain'),           // no stamps → fields omitted
    stamped('lrn_a2_session_retract'),         // owner session DELETE
    stamped('lrn_a2_key_retract'),             // owner API-key DELETE
    stamped('lrn_a2_other', { contributor_account_id: OTHER }),
  ];
}

function keyEntry(id, rawKey, scope) {
  return {
    id,
    hash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    label: id,
    scope,
    scope_version: 2,
    created_at: FIXED_AT,
    active: true,
  };
}

function fixtureAccounts() {
  return {
    [OWNER]: {
      id: OWNER,
      email: 'a2-owner@test.local',
      created_at: FIXED_AT,
      api_keys: [
        keyEntry('key_a2_owner_contribute', OWNER_KEY, 'contribute'),
        keyEntry('key_a2_owner_read', OWNER_READ_KEY, 'read'),
      ],
    },
    [OTHER]: {
      id: OTHER,
      email: 'a2-other@test.local',
      created_at: FIXED_AT,
      api_keys: [keyEntry('key_a2_other_contribute', OTHER_KEY, 'contribute')],
    },
  };
}

async function mintSession(accountId, email) {
  const jose = require(require.resolve('jose', { paths: [REPO] }));
  return new jose.SignJWT({ accountId, email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(Buffer.from(SESSION_SECRET));
}

describe('CLEAN-LANE-FLIP Phase A2: listing stamps + session retract', { timeout: 180_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;
  let bootSkipReason;
  let ownerJwt;
  let otherJwt;

  // No asserts in describe-scope helpers (CH-7 guard): callers check status.
  const listing = async (headers) => {
    const res = await fetch(`${baseUrl}/account/learnings`, { headers });
    return { status: res.status, payload: await res.json() };
  };
  const del = (id, headers) =>
    fetch(`${baseUrl}/learn/${id}?reason=retract`, { method: 'DELETE', headers });
  const persistedRow = (id) =>
    JSON.parse(fs.readFileSync(path.join(tmpDir, 'data', 'learnings.json'), 'utf8'))
      .find((row) => row.id === id);

  before(async () => {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(
      0,
      honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length
    );
    const reservation = await reservePort();
    if ('skipReason' in reservation) {
      assert.equal(reservation.skipReason, BOOT_SANDBOX_SKIP_REASON);
      bootSkipReason = BOOT_SANDBOX_SKIP_REASON;
      return;
    }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-clean-lane-a2-'));
    stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [],
    });
    fs.writeFileSync(path.join(tmpDir, 'data', 'learnings.json'), JSON.stringify(fixtureCatalog(), null, 2));
    fs.writeFileSync(path.join(tmpDir, 'data', 'accounts.json'), JSON.stringify(fixtureAccounts(), null, 2));

    const boot = await bootServer({
      tmpDir,
      port,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        LLM_SENSITIVITY_ENABLED: 'false',
        SESSION_SECRET,
        AUXILO_DATA_DIR: path.join(tmpDir, 'data'),
        AUXILO_ACCOUNTS_FILE: path.join(tmpDir, 'data', 'accounts.json'),
        // Flag stays OFF: A2 is additive and must behave identically dark.
        EXTRACTION_AUTOPUBLISH_CONSENT_ENABLED: 'false',
      },
      timeoutMs: 60_000,
      maxAttempts: 3,
    });
    if ('skipReason' in boot) {
      assert.equal(boot.skipReason, BOOT_SANDBOX_SKIP_REASON);
      bootSkipReason = BOOT_SANDBOX_SKIP_REASON;
      return;
    }
    child = boot.child;
    baseUrl = boot.baseUrl;
    ownerJwt = await mintSession(OWNER, 'a2-owner@test.local');
    otherJwt = await mintSession(OTHER, 'a2-other@test.local');
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Listing ────────────────────────────────────────────────────────────

  it('listing exposes published_via / standing_consent_version / retractable_until when set and omits them when absent (session and key)', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    for (const headers of [{ Authorization: `Bearer ${ownerJwt}` }, { 'X-API-Key': OWNER_READ_KEY }]) {
      const { status, payload } = await listing(headers);
      assert.equal(status, 200);
      assert.equal(payload.account_id, OWNER);
      const stampedRow = payload.learnings.find((row) => row.id === 'lrn_a2_stamped');
      const plainRow = payload.learnings.find((row) => row.id === 'lrn_a2_plain');
      assert.ok(stampedRow && plainRow, 'both owner rows listed');
      assert.deepEqual(stampedRow, {
        id: 'lrn_a2_stamped',
        title: 'A2 fixture lrn_a2_stamped',
        category: 'code-execution',
        tags: ['a2', 'lrn_a2_stamped'],
        status: 'approved',
        visibility: 'public',
        created_at: RECENT_AT,
        published_via: PUBLISHED_VIA,
        standing_consent_version: STAMP_VERSION,
        retractable_until: UNTIL,
      });
      // Absent stamps → absent keys (the SPEC3-F2 seven-key projection holds).
      assert.deepEqual(Object.keys(plainRow).sort(), [
        'category', 'created_at', 'id', 'status', 'tags', 'title', 'visibility',
      ]);
      assert.ok(!payload.learnings.some((row) => row.id === 'lrn_a2_other'), 'other account never listed');
    }
  });

  it('listing never exposes platform_hold_reasons / sensitivity_* / injection_flags (or body) on any row', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { status, payload } = await listing({ Authorization: `Bearer ${ownerJwt}` });
    assert.equal(status, 200);
    assert.ok(payload.learnings.length >= 2);
    for (const row of payload.learnings) {
      for (const forbidden of SCREEN_FIELDS) {
        assert.equal(Object.hasOwn(row, forbidden), false, `${row.id} leaked ${forbidden}`);
      }
      for (const key of Object.keys(row)) {
        assert.ok(!key.startsWith('sensitivity_'), `${row.id} leaked ${key}`);
      }
    }
  });

  // ── 2. DELETE /learn/:id ──────────────────────────────────────────────────

  it('DELETE with the owner session JWT retracts (200, audit_ref) and persists status=retracted', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await del('lrn_a2_session_retract', { Authorization: `Bearer ${ownerJwt}` });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.status, 'retracted');
    assert.equal(body.id, 'lrn_a2_session_retract');
    assert.equal(typeof body.audit_ref, 'string');
    const persisted = persistedRow('lrn_a2_session_retract');
    assert.equal(persisted.status, 'retracted');
    assert.ok(persisted.retracted_at);
    // A retracted row leaves the listing (status filter unchanged).
    const { status, payload } = await listing({ Authorization: `Bearer ${ownerJwt}` });
    assert.equal(status, 200);
    assert.ok(!payload.learnings.some((row) => row.id === 'lrn_a2_session_retract'));
  });

  it('DELETE with a non-owner session JWT is refused (403) and the row is untouched; a bad session bearer is 401', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await del('lrn_a2_key_retract', { Authorization: `Bearer ${otherJwt}` });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'Not authorized to retract this learning' });
    assert.equal(persistedRow('lrn_a2_key_retract').status, 'approved');

    // Owner session against another account's row: same refusal.
    const cross = await del('lrn_a2_other', { Authorization: `Bearer ${ownerJwt}` });
    assert.equal(cross.status, 403);
    assert.equal(persistedRow('lrn_a2_other').status, 'approved');

    // A non-axl_ bearer that is not a valid session: refused, nothing mutated.
    const junk = await del('lrn_a2_key_retract', { Authorization: 'Bearer not.a.jwt' });
    assert.equal(junk.status, 401);
    assert.equal(persistedRow('lrn_a2_key_retract').status, 'approved');
  });

  it('API-key path is unchanged: 401 no creds / 401 invalid key / 403 read scope / 403 other owner / 200 owner contribute key', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const noCreds = await del('lrn_a2_key_retract', {});
    assert.equal(noCreds.status, 401);
    assert.deepEqual(await noCreds.json(), { error: 'Authentication required' });

    const badKey = await del('lrn_a2_key_retract', { 'X-API-Key': `axl_${'f'.repeat(40)}` });
    assert.equal(badKey.status, 401);
    assert.deepEqual(await badKey.json(), { error: 'Invalid API key' });

    const badBearerKey = await del('lrn_a2_key_retract', { Authorization: `Bearer axl_${'f'.repeat(40)}` });
    assert.equal(badBearerKey.status, 401);
    assert.deepEqual(await badBearerKey.json(), { error: 'Invalid API key' });

    const readKey = await del('lrn_a2_key_retract', { 'X-API-Key': OWNER_READ_KEY });
    assert.equal(readKey.status, 403);
    assert.deepEqual(await readKey.json(), { error: "API key scope 'read' is insufficient (requires contribute)" });

    const otherKey = await del('lrn_a2_key_retract', { 'X-API-Key': OTHER_KEY });
    assert.equal(otherKey.status, 403);
    assert.deepEqual(await otherKey.json(), { error: 'Not authorized to retract this learning' });
    assert.equal(persistedRow('lrn_a2_key_retract').status, 'approved');

    const ok = await del('lrn_a2_key_retract', { 'X-API-Key': OWNER_KEY });
    const body = await ok.json();
    assert.equal(ok.status, 200, JSON.stringify(body));
    assert.equal(body.status, 'retracted');
    assert.equal(typeof body.audit_ref, 'string');
    assert.equal(persistedRow('lrn_a2_key_retract').status, 'retracted');
  });

  it('structural: the DELETE route resolves a non-axl_ Bearer through resolveSelfReviewAccount(c, \'contribute\') and keeps the validateApiKey path', () => {
    const start = SERVER_SRC.indexOf("app.delete('/learn/:id'");
    assert.notEqual(start, -1);
    const route = SERVER_SRC.slice(start, start + 3000);
    assert.match(route, /!sessionBearer\.startsWith\('axl_'\)/);
    assert.match(route, /await resolveSelfReviewAccount\(c, 'contribute'\)/);
    assert.match(route, /const keyResult = validateApiKey\(apiKey\);/);
    assert.match(route, /if \(!apiKey\) return c\.json\(\{ error: 'Authentication required' \}, 401\);/);
    assert.match(route, /if \(learning\.contributor_account_id !== accountId\)/);
  });
});

// ── 3. localIndexRow round-trip ─────────────────────────────────────────────

describe('CLEAN-LANE-FLIP Phase A2: localIndexRow persists the standing-consent stamps', () => {
  function tempIndex() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-a2-index-'));
    return { file: path.join(dir, 'extracted-index.jsonl'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }
  const learning = () => ({ title: 'Round trip', category: 'monitoring', tags: ['a2', 'index'], body: 'body text' });

  it('round-trips published_via / standing_consent_version / retractable_until from the /learn response, and omits them when absent', () => {
    const tmp = tempIndex();
    try {
      const cleanLaneResponse = {
        id: 'lrn_a2_rt',
        status: 'approved',
        published_via: PUBLISHED_VIA,
        standing_consent_version: STAMP_VERSION,
        retractable_until: UNTIL,
      };
      assert.equal(indexLib.appendSubmittedLearning(learning(), cleanLaneResponse, { indexPath: tmp.file, now: FIXED_AT }), true);
      assert.equal(indexLib.appendSubmittedLearning(learning(), { id: 'lrn_a2_plain', status: 'pending_review' }, { indexPath: tmp.file, now: FIXED_AT }), true);
      // Non-string / empty stamps are dropped, not persisted as junk.
      assert.equal(indexLib.appendSubmittedLearning(learning(), {
        id: 'lrn_a2_junk', status: 'approved', published_via: '', standing_consent_version: 7, retractable_until: null,
      }, { indexPath: tmp.file, now: FIXED_AT }), true);

      const state = indexLib.readExtractionIndex({ indexPath: tmp.file });
      assert.equal(state.usable, true);
      assert.equal(state.rows.length, 3);
      const bodyHash = crypto.createHash('sha256').update('body text').digest('hex');
      assert.deepEqual(state.rows[0], {
        title: 'Round trip',
        category: 'monitoring',
        tags: ['a2', 'index'],
        body_hash: bodyHash,
        body: 'body text',
        submitted_at: FIXED_AT,
        learning_id: 'lrn_a2_rt',
        status: 'approved',
        published_via: PUBLISHED_VIA,
        standing_consent_version: STAMP_VERSION,
        retractable_until: UNTIL,
      });
      // The SPEC3-F2 pinned shape is unchanged for a non-clean-lane response.
      assert.deepEqual(state.rows[1], {
        title: 'Round trip',
        category: 'monitoring',
        tags: ['a2', 'index'],
        body_hash: bodyHash,
        body: 'body text',
        submitted_at: FIXED_AT,
        learning_id: 'lrn_a2_plain',
        status: 'pending_review',
      });
      for (const field of ['published_via', 'standing_consent_version', 'retractable_until']) {
        assert.equal(Object.hasOwn(state.rows[2], field), false, `junk ${field} persisted`);
      }
      // The SessionStart rollup counts exactly the stamped row.
      assert.equal(notice.countStandingConsentPublishes(state.rows, undefined), 1);
      assert.equal(notice.PUBLISHED_VIA_CLEAN_LANE, PUBLISHED_VIA);
    } finally {
      tmp.cleanup();
    }
  });

  // Gate-A 2026-09-05: PRODUCER-DRIVEN rollup. The fixture above is hand-shaped;
  // this test derives the response shape from the /learn clean-lane branch in
  // server.js itself, so a key dropped from the producer (the standing-consent
  // version was missing from the response until this fix) turns the rollup red
  // instead of the hand fixture silently staying green.
  it('producer-driven: a /learn clean-lane response body appended via appendSubmittedLearning is counted once by countStandingConsentPublishes over the real index file', () => {
    // 1. Extract the /learn response's clean-lane spread block from the producer.
    // EXTRACT-PER-CLIENT W1 PART C added ~800 chars near the top of this route
    // (the extraction_model destructure + its intake normalizer), pushing the
    // response object's closing `}, 201);` past the old 40000-char window —
    // widened with headroom rather than hand-tuned to the current byte count.
    const learnRoute = SERVER_SRC.slice(SERVER_SRC.indexOf("app.post('/learn'"), SERVER_SRC.indexOf("app.post('/learn'") + 45000);
    const responseStart = learnRoute.indexOf('return c.json({\n    id: learning.id,');
    assert.ok(responseStart > 0, '/learn response object not found');
    const responseSrc = learnRoute.slice(responseStart, learnRoute.indexOf('}, 201);', responseStart));
    const blockStart = responseSrc.indexOf('...(cleanLanePublish && {');
    assert.ok(blockStart > 0, '/learn clean-lane spread block not found');
    const blockSrc = responseSrc.slice(blockStart, responseSrc.indexOf('}),', blockStart));
    const producerKeys = [...blockSrc.matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1]).sort();
    assert.deepEqual(producerKeys, ['published_via', 'retractable_until', 'standing_consent_notice', 'standing_consent_version']);
    assert.match(blockSrc, /published_via: PUBLISHED_VIA_CLEAN_LANE,/);
    assert.match(blockSrc, /standing_consent_version: cleanLanePublish\.consent_version,/);
    assert.match(blockSrc, /retractable_until: learning\.retractable_until,/);

    // 2. Build the response body shaped exactly like that branch (every
    //    top-level key the /learn 201 emits for a clean-lane publish).
    const topLevelKeys = [...responseSrc.matchAll(/^    ([a-z_]+):/gm)].map((m) => m[1]);
    for (const k of ['id', 'message', 'status', 'visibility', 'unlock_price', 'pricing', 'contributor_wallet', 'timestamp']) {
      assert.ok(topLevelKeys.includes(k), `/learn response lost top-level key ${k}`);
    }
    const learningId = 'lrn_a2_producer';
    const response = {
      id: learningId,
      message: 'Learning submitted successfully',
      status: 'approved',
      visibility: 'public',
      published_via: PUBLISHED_VIA,
      standing_consent_version: STAMP_VERSION,
      retractable_until: UNTIL,
      standing_consent_notice: `Published under your standing consent (${STAMP_VERSION}). ` +
        `Retractable until ${UNTIL}: DELETE /learn/${learningId}?reason=retract, ` +
        '`auxilo review`, or your dashboard.',
      unlock_price: 0.05,
      pricing: { computed_price: 0.05 },
      contributor_wallet: null,
      timestamp: FIXED_AT,
    };
    for (const k of producerKeys) assert.ok(Object.hasOwn(response, k), `fixture missing producer key ${k}`);

    // 3. Append through the real client path into the real index location for
    //    a temp HOME, then run the rollup over THAT file.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-a2-producer-home-'));
    try {
      const indexPath = notice.submittedIndexPath(home);
      assert.equal(indexLib.appendSubmittedLearning(learning(), response, { indexPath, now: FIXED_AT }), true);
      // A plain (non-clean-lane) /learn response on the same file is NOT counted.
      assert.equal(indexLib.appendSubmittedLearning(learning(), {
        id: 'lrn_a2_producer_plain', message: 'Learning submitted for review. It will be visible after approval.',
        status: 'pending_review', visibility: 'public', unlock_price: 0.05, pricing: {}, contributor_wallet: null, timestamp: FIXED_AT,
      }, { indexPath, now: FIXED_AT }), true);

      const rows = notice.readSubmittedRows(home);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].published_via, PUBLISHED_VIA);
      assert.equal(rows[0].standing_consent_version, STAMP_VERSION);
      assert.equal(rows[0].retractable_until, UNTIL);
      assert.equal(Object.hasOwn(rows[0], 'standing_consent_notice'), false, 'the notice text is not persisted');
      assert.equal(notice.countStandingConsentPublishes(rows, undefined), 1);
      // The notice stamp gates the count: a stamp AFTER the publish → 0, BEFORE → 1.
      assert.equal(notice.countStandingConsentPublishes(rows, '2026-07-26T13:00:00.000Z'), 0);
      assert.equal(notice.countStandingConsentPublishes(rows, '2026-07-26T11:00:00.000Z'), 1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
