'use strict';

/**
 * test/clean-lane-phase-b-dash.test.js — CLEAN-LANE-FLIP Phase B (dashboard leg):
 * WAVE-0905-RESIDUALS (1) + (2).
 *
 *   1. GET /account/learnings gains `?published_via=<value>` (exact-match row
 *      filter, applied with account/status/visibility BEFORE the page slice so
 *      `total` counts matches only) and `?sort=desc` (newest first by
 *      created_at). Both additive: absent → stored order, existing callers
 *      byte-identical.
 *   2. public/dashboard-clean-lane.js standingConsentListQuery builds the
 *      card's request with the limit interpolated (no `limit=500` literal in
 *      loadStandingConsentList), and dashboard.html calls it with PAGE_LIMIT.
 *   3. openapi.json documents the two params on the /account/learnings path.
 *   4. N2 follow-up: `status=retracted` is an accepted EXPLICIT value (never in
 *      the default set); the card pages a second query for it and merges both
 *      lists newest-first in the pure builder (mergeStandingConsentRows).
 *
 * Staged-server pattern: test/clean-lane-phase-a2.test.js.
 *
 * Runner: node --test test/clean-lane-phase-b-dash.test.js
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
const OPENAPI = require('../openapi.json');
const view = require('../public/dashboard-clean-lane.js');
const cleanLane = require('../lib/clean-lane.js');
const DASHBOARD_HTML = fs.readFileSync(path.join(REPO, 'public', 'dashboard.html'), 'utf8');

const OWNER = 'acc_clean_lane_b_owner';
const OTHER = 'acc_clean_lane_b_other';
const OWNER_READ_KEY = `axl_${'d'.repeat(40)}`;
const FIXED_AT = '2026-07-26T12:00:00.000Z';
const STAMP_VERSION = cleanLane.CLEAN_LANE_CONSENT_VERSION;
const PUBLISHED_VIA = cleanLane.PUBLISHED_VIA_CLEAN_LANE;
const UNTIL = new Date(Date.now() + 6 * 86400_000).toISOString();

// Stored order is deliberately NOT chronological so `sort=desc` is observable
// and the default path is provably untouched.
const T = {
  old: '2026-01-01T00:00:00.000Z',
  mid: '2026-03-01T00:00:00.000Z',
  new: '2026-06-01T00:00:00.000Z',
  newest: '2026-08-01T00:00:00.000Z',
};

function fixtureLearning(id, overrides = {}) {
  return {
    id,
    title: `B fixture ${id}`,
    body: `Private body for ${id}; never in the listing projection.`,
    category: 'code-execution',
    tags: ['b', id],
    task_context: 'Phase B dashboard listing fixture.',
    outcome: 'success',
    status: 'approved',
    visibility: 'public',
    contributor_account_id: OWNER,
    created_at: FIXED_AT,
    ...overrides,
  };
}

function stamped(id, overrides = {}) {
  return fixtureLearning(id, {
    published_via: PUBLISHED_VIA,
    standing_consent_version: STAMP_VERSION,
    retractable_until: UNTIL,
    ...overrides,
  });
}

// Stored order: plain_mid, stamped_old, stamped_newest, plain_new, stamped_mid,
// then rows the filters must drop (private stamped, pending stamped, retracted
// stamped, other account stamped, a different published_via value). Gate-A N2:
// the dashboard query carries no status filter, so the pending stamped row is
// IN there; the retracted row is out of the default set and reached only by
// the second, explicit status=retracted query.
function fixtureCatalog() {
  return [
    fixtureLearning('lrn_b_plain_mid', { created_at: T.mid }),
    stamped('lrn_b_stamped_old', { created_at: T.old }),
    stamped('lrn_b_stamped_newest', { created_at: T.newest }),
    fixtureLearning('lrn_b_plain_new', { created_at: T.new }),
    stamped('lrn_b_stamped_mid', { created_at: T.mid }),
    stamped('lrn_b_stamped_private', { created_at: T.newest, visibility: 'private' }),
    stamped('lrn_b_stamped_pending', { created_at: T.newest, status: 'pending_review' }),
    // N2: a retracted stamped row — OUT of every default-status listing, IN
    // only when the caller asks for status=retracted explicitly.
    stamped('lrn_b_stamped_retracted', { created_at: T.new, status: 'retracted', retracted_at: T.newest }),
    stamped('lrn_b_stamped_other', { created_at: T.newest, contributor_account_id: OTHER }),
    fixtureLearning('lrn_b_via_other', { created_at: T.newest, published_via: 'chat_pipeline' }),
  ];
}

const STORED_OWNER_ORDER = [
  'lrn_b_plain_mid',
  'lrn_b_stamped_old',
  'lrn_b_stamped_newest',
  'lrn_b_plain_new',
  'lrn_b_stamped_mid',
  'lrn_b_stamped_private',
  'lrn_b_stamped_pending',
  'lrn_b_via_other',
];

function fixtureAccounts() {
  return {
    [OWNER]: {
      id: OWNER,
      email: 'b-owner@test.local',
      created_at: FIXED_AT,
      api_keys: [{
        id: 'key_b_owner_read',
        hash: crypto.createHash('sha256').update(OWNER_READ_KEY).digest('hex'),
        label: 'key_b_owner_read',
        scope: 'read',
        scope_version: 2,
        created_at: FIXED_AT,
        active: true,
      }],
    },
    [OTHER]: { id: OTHER, email: 'b-other@test.local', created_at: FIXED_AT, api_keys: [] },
  };
}

// ─── A. Pure query builder + dashboard wiring (no server) ────────────────────

describe('dashboard-clean-lane.js standingConsentListQuery', () => {
  it('builds the filtered, newest-first request with limit and offset interpolated', () => {
    assert.equal(
      view.standingConsentListQuery(500, 0),
      '/account/learnings?visibility=public' +
        `&published_via=${PUBLISHED_VIA}&sort=desc&limit=500&offset=0`
    );
    assert.ok(!/status=/.test(view.standingConsentListQuery(500, 0)),
      'Gate-A N2: no status filter — every stamped row the server returns is listed, labelled');
    assert.equal(
      view.standingConsentListQuery(200, 400),
      '/account/learnings?visibility=public' +
        `&published_via=${PUBLISHED_VIA}&sort=desc&limit=200&offset=400`
    );
    assert.equal(view.PUBLISHED_VIA_CLEAN_LANE, PUBLISHED_VIA, 'stamp stays pinned to lib/clean-lane.js');
  });

  it('falls back to limit 500 / offset 0 on missing or invalid arguments', () => {
    const expected = '/account/learnings?visibility=public' +
      `&published_via=${PUBLISHED_VIA}&sort=desc&limit=500&offset=0`;
    assert.equal(view.standingConsentListQuery(), expected);
    assert.equal(view.standingConsentListQuery('x', -3), expected);
    assert.equal(view.standingConsentListQuery(0, NaN), expected);
  });

  it('N2: standingConsentRetractedListQuery is the same request plus an explicit status=retracted', () => {
    const base = view.standingConsentListQuery(500, 0);
    assert.equal(view.standingConsentRetractedListQuery(500, 0), `${base}&status=retracted`);
    assert.equal(
      view.standingConsentRetractedListQuery(200, 400),
      `${view.standingConsentListQuery(200, 400)}&status=retracted`
    );
    assert.equal(view.standingConsentRetractedListQuery(), `${base}&status=retracted`);
    assert.equal(view.standingConsentRetractedListQuery('x', -3), `${base}&status=retracted`);
    // The default-set query is byte-identical to before: still no status filter.
    assert.ok(!/status=/.test(base), 'the default query still carries no status');
  });

  it('N2: mergeStandingConsentRows joins both lists newest-first, dedupes by id, tolerates junk', () => {
    const row = (id, created_at, status = 'approved') => ({ id, created_at, status });
    const defaults = [row('n', T.newest), row('p', T.newest, 'pending_review'), row('m', T.mid), row('o', T.old)];
    const retracted = [row('r', T.new, 'retracted')];
    const merged = view.mergeStandingConsentRows(defaults, retracted);
    assert.deepEqual(merged.map((r) => r.id), ['n', 'p', 'r', 'm', 'o'], 'created_at desc; ties keep arrival order');
    assert.deepEqual(merged.map((r) => r.status), ['approved', 'pending_review', 'retracted', 'approved', 'approved']);
    // Inputs are not mutated.
    assert.deepEqual(defaults.map((r) => r.id), ['n', 'p', 'm', 'o']);
    // A row in both responses (retraction landed between the two requests) is listed once; first wins.
    const dup = view.mergeStandingConsentRows([row('x', T.mid)], [row('x', T.mid, 'retracted'), row('y', T.old, 'retracted')]);
    assert.deepEqual(dup.map((r) => [r.id, r.status]), [['x', 'approved'], ['y', 'retracted']]);
    // Unparseable dates sink to the end in arrival order; junk is dropped; non-arrays are empty.
    const junk = view.mergeStandingConsentRows([row('a', 'nope'), null, 'str', row('b', T.old)], [row('c', undefined), 7]);
    assert.deepEqual(junk.map((r) => r.id), ['b', 'a', 'c']);
    assert.deepEqual(view.mergeStandingConsentRows(undefined, null), []);
    assert.deepEqual(view.mergeStandingConsentRows('x', { id: 'obj' }), []);
    // Empty + retracted-only and defaults-only both work.
    assert.deepEqual(view.mergeStandingConsentRows([], retracted).map((r) => r.id), ['r']);
    assert.deepEqual(view.mergeStandingConsentRows(defaults, []).map((r) => r.id), ['n', 'p', 'm', 'o']);
  });

  it('dashboard.html loadStandingConsentList pages both builder queries with PAGE_LIMIT, merges them, and carries no limit=500 literal', () => {
    const start = DASHBOARD_HTML.indexOf('function loadStandingConsentList()');
    assert.ok(start > 0, 'loadStandingConsentList present');
    const end = DASHBOARD_HTML.indexOf('function renderStandingConsentList', start);
    assert.ok(end > start, 'renderStandingConsentList follows');
    const fn = DASHBOARD_HTML.slice(start, end);
    assert.match(fn, /var PAGE_LIMIT = \d+;/, 'PAGE_LIMIT still declared');
    assert.match(fn, /var MAX_PAGES = 4;/, 'the 4-page cap is kept while paging is kept');
    assert.ok(
      fn.includes('apiFetch(buildQuery(PAGE_LIMIT, offset))'),
      'the request comes from a builder with PAGE_LIMIT, not an inline string'
    );
    // N2: the default-set query AND the explicit retracted query are both paged.
    assert.ok(fn.includes('pageAll(AuxiloCleanLane.standingConsentListQuery)'), 'default-set list paged');
    assert.ok(fn.includes('pageAll(AuxiloCleanLane.standingConsentRetractedListQuery)'), 'retracted list paged');
    assert.ok(fn.includes('AuxiloCleanLane.mergeStandingConsentRows(pages[0], pages[1])'), 'merged in the pure builder');
    assert.ok(!/limit=500/.test(fn), 'no limit literal in loadStandingConsentList');
    assert.ok(!/\/account\/learnings\?/.test(fn), 'no inline /account/learnings query string');
    assert.ok(!/status=/.test(fn), 'no inline status literal — the retracted opt-in lives in the builder');
    // The defensive second filter stays in place.
    assert.ok(fn.includes('AuxiloCleanLane.selectStandingConsentItems(rows, Date.now())'));
  });
});

// ─── B. openapi.json ─────────────────────────────────────────────────────────

describe('openapi.json /account/learnings documents published_via and sort', () => {
  it('both params are listed as optional query params with the right shapes', () => {
    const params = OPENAPI.paths['/account/learnings'].get.parameters;
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));
    assert.deepEqual(Object.keys(byName).sort(), ['limit', 'offset', 'published_via', 'sort', 'status', 'visibility']);
    assert.equal(byName.published_via.in, 'query');
    assert.equal(byName.published_via.schema.type, 'string');
    assert.equal(byName.published_via.required, undefined, 'additive: never required');
    assert.equal(byName.sort.in, 'query');
    assert.deepEqual(byName.sort.schema, { type: 'string', enum: ['desc'] });
    assert.equal(byName.sort.required, undefined, 'additive: never required');
  });
});

// ─── C. Staged server ────────────────────────────────────────────────────────

describe('CLEAN-LANE-FLIP Phase B: GET /account/learnings published_via + sort', { timeout: 180_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;
  let bootSkipReason;

  // No asserts in describe-scope helpers (CH-7 guard): callers check status.
  const listing = async (query) => {
    const res = await fetch(`${baseUrl}/account/learnings${query}`, {
      headers: { 'X-API-Key': OWNER_READ_KEY },
    });
    return { status: res.status, payload: await res.json() };
  };
  const ids = (payload) => payload.learnings.map((row) => row.id);

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-clean-lane-b-dash-'));
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
        AUXILO_DATA_DIR: path.join(tmpDir, 'data'),
        AUXILO_ACCOUNTS_FILE: path.join(tmpDir, 'data', 'accounts.json'),
        // Flag stays OFF: the listing params are additive and flag-independent.
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
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('default (no new params) keeps the stored order and existing total — existing callers unchanged', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { status, payload } = await listing('');
    assert.equal(status, 200);
    assert.equal(payload.total, STORED_OWNER_ORDER.length);
    assert.deepEqual(ids(payload), STORED_OWNER_ORDER);
  });

  it('published_via is an exact-match filter applied with status/visibility before the slice (total counts matches only)', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { status, payload } = await listing(`?status=approved&visibility=public&published_via=${PUBLISHED_VIA}`);
    assert.equal(status, 200);
    assert.equal(payload.total, 3, 'private, pending, other-account and other-stamp rows excluded from total');
    assert.deepEqual(ids(payload), ['lrn_b_stamped_old', 'lrn_b_stamped_newest', 'lrn_b_stamped_mid'], 'stored order without sort');
    for (const row of payload.learnings) assert.equal(row.published_via, PUBLISHED_VIA);

    // Without status/visibility narrowing the filter still matches only the stamp value.
    const all = await listing(`?published_via=${PUBLISHED_VIA}`);
    assert.equal(all.status, 200);
    assert.deepEqual(ids(all.payload), [
      'lrn_b_stamped_old', 'lrn_b_stamped_newest', 'lrn_b_stamped_mid', 'lrn_b_stamped_private', 'lrn_b_stamped_pending',
    ]);

    const other = await listing('?published_via=chat_pipeline');
    assert.equal(other.status, 200);
    assert.deepEqual(ids(other.payload), ['lrn_b_via_other']);

    // Exact match: a prefix/case variant matches nothing; unstamped rows never match.
    const none = await listing('?published_via=clean_lane');
    assert.equal(none.status, 200);
    assert.equal(none.payload.total, 0);
    assert.deepEqual(none.payload.learnings, []);
  });

  it('sort=desc orders newest first by created_at without changing the row set', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { status, payload } = await listing('?sort=desc');
    assert.equal(status, 200);
    assert.equal(payload.total, STORED_OWNER_ORDER.length);
    const times = payload.learnings.map((row) => Date.parse(row.created_at));
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i - 1] >= times[i], `row ${i} is not older-or-equal to row ${i - 1}`);
    }
    assert.deepEqual([...ids(payload)].sort(), [...STORED_OWNER_ORDER].sort(), 'same rows, reordered');
    assert.equal(ids(payload)[ids(payload).length - 1], 'lrn_b_stamped_old');
  });

  it('filter + sort + limit/offset: the slice is taken AFTER filtering and ordering (the dashboard query)', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    // Gate-A N2: the dashboard query carries no status filter, so the stamped
    // pending row is IN (badge and list agree); private and other-account rows
    // stay out.
    const first = await listing(view.standingConsentListQuery(1, 0).replace('/account/learnings', ''));
    assert.equal(first.status, 200);
    assert.equal(first.payload.total, 4);
    assert.equal(first.payload.limit, 1);
    assert.equal(first.payload.offset, 0);
    assert.deepEqual(ids(first.payload), ['lrn_b_stamped_newest']);

    const second = await listing(view.standingConsentListQuery(1, 1).replace('/account/learnings', ''));
    assert.equal(second.status, 200);
    assert.deepEqual(ids(second.payload), ['lrn_b_stamped_pending']);

    const page = await listing(view.standingConsentListQuery(500, 0).replace('/account/learnings', ''));
    assert.equal(page.status, 200);
    assert.deepEqual(ids(page.payload), ['lrn_b_stamped_newest', 'lrn_b_stamped_pending', 'lrn_b_stamped_mid', 'lrn_b_stamped_old']);
    assert.deepEqual(page.payload.learnings.map((r) => r.status),
      ['approved', 'pending_review', 'approved', 'approved'], 'status rides on every row for the label');
    // The projection is unchanged: the seven keys + the three optional stamps only.
    for (const row of page.payload.learnings) {
      assert.deepEqual(Object.keys(row).sort(), [
        'category', 'created_at', 'id', 'published_via', 'retractable_until',
        'standing_consent_version', 'status', 'tags', 'title', 'visibility',
      ]);
    }
    // The client-side second filter agrees with the server's set.
    const selected = view.selectStandingConsentItems(page.payload.learnings, Date.now());
    assert.deepEqual(selected.map((item) => item.id), ['lrn_b_stamped_newest', 'lrn_b_stamped_pending', 'lrn_b_stamped_mid', 'lrn_b_stamped_old']);
    assert.deepEqual(selected.map((item) => item.status), ['approved', 'pending_review', 'approved', 'approved']);
  });

  it('N2: status=retracted lists the stamped retracted row only when asked; the default query never carries it', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    // Explicit opt-in: exactly the caller's retracted stamped row, labelled.
    const only = await listing(`?published_via=${PUBLISHED_VIA}&status=retracted`);
    assert.equal(only.status, 200);
    assert.equal(only.payload.total, 1);
    assert.deepEqual(ids(only.payload), ['lrn_b_stamped_retracted']);
    assert.equal(only.payload.learnings[0].status, 'retracted');
    assert.equal(only.payload.learnings[0].published_via, PUBLISHED_VIA);

    // Without `status` the default set is unchanged: the retracted row is absent
    // from the plain stamp filter AND from the dashboard's default-set query.
    const plain = await listing(`?published_via=${PUBLISHED_VIA}`);
    assert.equal(plain.status, 200);
    assert.ok(!ids(plain.payload).includes('lrn_b_stamped_retracted'), 'not in the default status set');
    const defaults = await listing(view.standingConsentListQuery(500, 0).replace('/account/learnings', ''));
    assert.equal(defaults.status, 200);
    assert.equal(defaults.payload.total, 4, 'default-set total unchanged by the retracted row');
    assert.ok(!ids(defaults.payload).includes('lrn_b_stamped_retracted'));

    // The card's second query is the retracted opt-in, and the pure merge
    // yields the one newest-first list the card renders (created_at desc:
    // newest, pending@newest, retracted@new, mid, old).
    const retracted = await listing(view.standingConsentRetractedListQuery(500, 0).replace('/account/learnings', ''));
    assert.equal(retracted.status, 200);
    assert.deepEqual(ids(retracted.payload), ['lrn_b_stamped_retracted']);
    const merged = view.mergeStandingConsentRows(defaults.payload.learnings, retracted.payload.learnings);
    assert.deepEqual(merged.map((r) => r.id), [
      'lrn_b_stamped_newest', 'lrn_b_stamped_pending', 'lrn_b_stamped_retracted', 'lrn_b_stamped_mid', 'lrn_b_stamped_old',
    ]);
    const selected = view.selectStandingConsentItems(merged, Date.now());
    assert.deepEqual(selected.map((item) => item.status),
      ['approved', 'pending_review', 'retracted', 'approved', 'approved'], 'the retracted row carries its label');

    // A value outside the allow-list is still a 400 with the updated string.
    const bogus = await listing('?status=bogus');
    assert.equal(bogus.status, 400);
    assert.deepEqual(bogus.payload, {
      error: 'status must be a comma-list containing only approved,rejected,pending_review,retracted',
    });
  });

  it('rejects an empty published_via and any sort other than desc with 400', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const empty = await listing('?published_via=');
    assert.equal(empty.status, 400);
    assert.deepEqual(empty.payload, { error: 'published_via must be a non-empty exact-match value' });

    const blank = await listing('?published_via=%20%20');
    assert.equal(blank.status, 400);

    for (const bad of ['asc', 'DESC', 'created_at', '']) {
      const res = await listing(`?sort=${bad}`);
      assert.equal(res.status, 400, `sort=${bad}`);
      assert.deepEqual(res.payload, { error: 'sort must be one of: desc' });
    }
  });
});
