'use strict';

/**
 * test/clean-lane-phase-b-notice.test.js — CLEAN-LANE-FLIP Phase B (notice
 * hardening; GOV-2 counsel conditions, draft §6 read #2: "the notice is not
 * notice"). Source: ~/.auxilo/handoffs/CLEAN-LANE-PHASE-B-LEGAL-DRAFT-2026-09-06.md §6.
 *
 *   A. lib/clean-lane.js countUnacknowledgedStandingConsentPublications: no
 *      cursor → every stamped row for the account; with a cursor → only rows
 *      created strictly after it; no stamps → 0; other accounts never count.
 *   B. public/dashboard-clean-lane.js: unacknowledgedCount / unreadBadgeLine /
 *      buildAckBody (the pure logic behind the persistent badge + button).
 *   C. The "move 3" enrollment line is byte-equal across the dashboard
 *      (#clean-lane-no-email-line), the CLI literal (CLEAN_LANE_NO_EMAIL_LINE),
 *      and the counsel draft file (when present on this machine); it sits
 *      directly above the affirmation on both surfaces; the CLI status prints
 *      the unread count only when > 0.
 *   D. openapi.json documents standing_consent_ack_at (PATCH /account/settings
 *      request; GET /account/clean-lane response) and unacknowledged_publications.
 *   E. Staged server (flag on): PATCH validation (type, shape, future) and the
 *      GET count before/after the cursor.
 *
 * Runner: node --test test/clean-lane-phase-b-notice.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  reservePort,
  stageServer,
  bootServer,
  stopServer,
  BOOT_SANDBOX_SKIP_REASON,
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const CLI_PATH = path.join(REPO, 'bin', 'auxilo-cli.js');
const OPENAPI = require('../openapi.json');
const cleanLane = require('../lib/clean-lane.js');
const view = require('../public/dashboard-clean-lane.js');
const cli = require('../bin/auxilo-cli.js');
const DASHBOARD_HTML = fs.readFileSync(path.join(REPO, 'public', 'dashboard.html'), 'utf8');
const CLI_SRC = fs.readFileSync(CLI_PATH, 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

const DRAFT_PATH = path.join(os.homedir(), '.auxilo', 'handoffs', 'CLEAN-LANE-PHASE-B-LEGAL-DRAFT-2026-09-06.md');

/** The §6 read #2 "move 3" enrollment line, as the draft quotes it. */
const MOVE_3_LINE = 'You will not receive an email for these. Publications appear in your dashboard and in the response to the session that submitted them. The 7-day retraction window runs from publication.';

const PUBLISHED_VIA = cleanLane.PUBLISHED_VIA_CLEAN_LANE;
const OWNER = 'acc_notice_owner';
const OTHER = 'acc_notice_other';

function stamped(id, accountId, createdAt, extra = {}) {
  return {
    id,
    contributor_account_id: accountId,
    published_via: PUBLISHED_VIA,
    standing_consent_version: cleanLane.CLEAN_LANE_CONSENT_VERSION,
    created_at: createdAt,
    status: 'approved',
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Count semantics (pure)
// ─────────────────────────────────────────────────────────────────────────────
describe('countUnacknowledgedStandingConsentPublications', () => {
  const count = cleanLane.countUnacknowledgedStandingConsentPublications;
  const rows = [
    stamped('a', OWNER, '2026-01-01T00:00:00.000Z'),
    stamped('b', OWNER, '2026-03-01T00:00:00.000Z', { status: 'retracted' }),
    stamped('c', OWNER, '2026-06-01T00:00:00.000Z'),
    stamped('other', OTHER, '2026-08-01T00:00:00.000Z'),
    { id: 'manual', contributor_account_id: OWNER, created_at: '2026-07-01T00:00:00.000Z', status: 'approved' },
    { id: 'chat', contributor_account_id: OWNER, published_via: 'autonomous_extraction', created_at: '2026-07-02T00:00:00.000Z' },
    null,
  ];

  it('no cursor: every stamped row for the account counts (status ignored); other accounts and unstamped rows never do', () => {
    assert.equal(count(rows, OWNER, null), 3);
    assert.equal(count(rows, OWNER, undefined), 3);
    assert.equal(count(rows, OTHER, null), 1);
  });

  it('with a cursor: only rows created strictly after it count (equal-to-cursor is acknowledged)', () => {
    assert.equal(count(rows, OWNER, '2026-02-01T00:00:00.000Z'), 2);
    assert.equal(count(rows, OWNER, '2026-03-01T00:00:00.000Z'), 1, 'a row AT the cursor is already acknowledged');
    assert.equal(count(rows, OWNER, '2026-12-31T00:00:00.000Z'), 0);
  });

  it('a stamped row with an unparsable created_at counts without a cursor but never against one', () => {
    const odd = [stamped('x', OWNER, 'not-a-date'), stamped('y', OWNER, undefined)];
    assert.equal(count(odd, OWNER, null), 2);
    assert.equal(count(odd, OWNER, '2020-01-01T00:00:00.000Z'), 0);
  });

  it('none without stamps: an account with no clean-lane rows is 0, as is garbage input', () => {
    assert.equal(count(rows.filter((r) => r && !r.published_via), OWNER, null), 0);
    assert.equal(count([], OWNER, null), 0);
    assert.equal(count(undefined, OWNER, null), 0);
    assert.equal(count(rows, '', null), 0);
    assert.equal(count(rows, OWNER, 'garbage-cursor'), 3, 'an unparsable cursor behaves as no cursor (never hides a publication)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Dashboard pure logic
// ─────────────────────────────────────────────────────────────────────────────
describe('dashboard-clean-lane.js: unread badge + ack body', () => {
  it('unacknowledgedCount reads the GET body; anything missing/malformed/negative is 0', () => {
    assert.equal(view.unacknowledgedCount({ unacknowledged_publications: 4 }), 4);
    assert.equal(view.unacknowledgedCount({ unacknowledged_publications: 0 }), 0);
    assert.equal(view.unacknowledgedCount({ unacknowledged_publications: -2 }), 0);
    assert.equal(view.unacknowledgedCount({ unacknowledged_publications: '3' }), 0);
    assert.equal(view.unacknowledgedCount({ unacknowledged_publications: 1.5 }), 0);
    assert.equal(view.unacknowledgedCount({}), 0);
    assert.equal(view.unacknowledgedCount(null), 0);
  });

  it('unreadBadgeLine is "N auto-published since you last checked"', () => {
    assert.equal(view.unreadBadgeLine(1), '1 auto-published since you last checked');
    assert.equal(view.unreadBadgeLine(12), '12 auto-published since you last checked');
    assert.equal(view.unreadBadgeLine(-1), '0 auto-published since you last checked');
  });

  it('buildAckBody is exactly { standing_consent_ack_at: <ISO now> } — the settings PATCH the button sends', () => {
    const body = view.buildAckBody(Date.UTC(2026, 8, 6, 12, 0, 0));
    assert.deepEqual(body, { standing_consent_ack_at: '2026-09-06T12:00:00.000Z' });
    const now = view.buildAckBody();
    assert.deepEqual(Object.keys(now), ['standing_consent_ack_at']);
    assert.ok(Math.abs(Date.parse(now.standing_consent_ack_at) - Date.now()) < 5000);
  });

  it('dashboard.html wires the badge: rendered from the GET body on the ON state, cleared only by the ack button PATCH', () => {
    // Markup: badge + button live inside the ON block, above the standing-consent list.
    const onStart = DASHBOARD_HTML.indexOf('<div id="clean-lane-on"');
    const unread = DASHBOARD_HTML.indexOf('<div id="clean-lane-unread"', onStart);
    const badge = DASHBOARD_HTML.indexOf('<span id="clean-lane-unread-badge"', unread);
    const ackBtn = DASHBOARD_HTML.indexOf('id="clean-lane-ack-btn" onclick="ackCleanLanePublications()">I\'ve reviewed these</button>', unread);
    const listLabel = DASHBOARD_HTML.indexOf('Published under standing consent</div>', onStart);
    assert.ok(onStart > -1 && unread > onStart && badge > unread && ackBtn > badge && listLabel > ackBtn,
      'badge + button sit inside the ON block, above the standing-consent list');
    // Script: ON branch renders the badge; the ack handler PATCHes /account/settings with buildAckBody and reloads.
    assert.match(DASHBOARD_HTML, /if \(view\.state === AuxiloCleanLane\.STATE_ON\) \{[\s\S]*?renderCleanLaneUnread\(data\);[\s\S]*?loadStandingConsentList\(\);/);
    const ack = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf('window.ackCleanLanePublications = function'), DASHBOARD_HTML.indexOf('function loadStandingConsentList()'));
    assert.ok(ack.includes("apiFetch('/account/settings', { method: 'PATCH', body: JSON.stringify(AuxiloCleanLane.buildAckBody(Date.now())) })"));
    assert.ok(ack.includes('loadCleanLane();'), 'reload after the PATCH so the server recount drives the badge');
    // Nothing else PATCHes the cursor: the ack handler is the ONLY writer in the page.
    assert.equal((DASHBOARD_HTML.match(/standing_consent_ack_at/g) || []).length, 0,
      'the page never types the field name — it comes from AuxiloCleanLane.buildAckBody only');
    assert.equal((DASHBOARD_HTML.match(/buildAckBody/g) || []).length, 1);
    // renderCleanLaneUnread only toggles visibility from the count; it never PATCHes.
    const render = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf('function renderCleanLaneUnread(data)'), DASHBOARD_HTML.indexOf('window.ackCleanLanePublications = function'));
    assert.ok(!render.includes('apiFetch('), 'rendering the badge never calls the server');
    assert.match(DASHBOARD_HTML, /<script src="\/dashboard-clean-lane\.js\?v=[0-9a-f]{8}"><\/script>/, 'cache-bust present (content-hash scheme, ASSET-CACHE-BUST)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. The move-3 enrollment line: parity + placement + CLI behaviour
// ─────────────────────────────────────────────────────────────────────────────
describe('move-3 enrollment line (no email): byte-equal across surfaces, placed above the affirmation', () => {
  it('dashboard #clean-lane-no-email-line and the CLI literal are byte-equal to the draft sentence', () => {
    const m = /<p id="clean-lane-no-email-line"[^>]*>([^<]*)<\/p>/.exec(DASHBOARD_HTML);
    assert.ok(m, 'dashboard carries the line as the text of #clean-lane-no-email-line');
    assert.equal(m[1], MOVE_3_LINE);
    assert.equal(cli.CLEAN_LANE_NO_EMAIL_LINE, MOVE_3_LINE);
    assert.equal((DASHBOARD_HTML.match(/id="clean-lane-no-email-line"/g) || []).length, 1);
  });

  it('the counsel draft (§6 read #2, move 3) quotes the same sentence, verbatim (skipped where the draft is not on disk)', (t) => {
    if (!fs.existsSync(DRAFT_PATH)) {
      t.skip(`draft not present at ${DRAFT_PATH}`);
      return;
    }
    const draft = fs.readFileSync(DRAFT_PATH, 'utf8');
    const s6 = draft.slice(draft.indexOf('## 6.'), draft.indexOf('## 7.'));
    assert.ok(s6.includes(`*"${MOVE_3_LINE}"*`), 'draft §6 quotes the line byte-for-byte');
  });

  it('dashboard: the line is its own element directly after the (g) <details> block and directly before the affirmation checkbox', () => {
    const detailsClose = DASHBOARD_HTML.indexOf('</details>', DASHBOARD_HTML.indexOf('<details open id="clean-lane-terms"'));
    const line = DASHBOARD_HTML.indexOf('<p id="clean-lane-no-email-line"');
    const box = DASHBOARD_HTML.indexOf('<input type="checkbox" id="clean-lane-agree"');
    assert.ok(detailsClose > -1 && line > detailsClose && box > line, 'order: </details> → line → checkbox');
    const between = DASHBOARD_HTML.slice(detailsClose + '</details>'.length, line);
    assert.ok(!/<(p|div|label|input|button)\b/.test(between), 'no other element between the (g) block and the line');
    const after = DASHBOARD_HTML.slice(line, box);
    assert.ok(!/<(p|div|input|button)\b/.test(after.slice(after.indexOf('</p>') + 4)), 'only the checkbox label opens between the line and the checkbox');
  });

  it('CLI grant: prints the line (via wrapForTerminal, words untouched) after the Terms and before the "type this sentence" prompt', () => {
    const grant = CLI_SRC.slice(CLI_SRC.indexOf('// ── grant: explainer → threshold → the sentence'), CLI_SRC.indexOf("const typed = await ask('> ');"));
    const terms = grant.indexOf('wrapForTerminal(CLEAN_LANE_TERMS_G2)');
    const line = grant.indexOf('wrapForTerminal(CLEAN_LANE_NO_EMAIL_LINE)');
    const prompt = grant.indexOf('To turn on auto-publish, type this sentence exactly as written');
    assert.ok(terms > -1 && line > terms && prompt > line, 'order: (g)+(g2) → no-email line → affirmation prompt');
    const wrapped = cli.wrapForTerminal(cli.CLEAN_LANE_NO_EMAIL_LINE);
    assert.equal(wrapped.split('\n').map((l) => l.replace(/^ {2}/, '')).join(' '), MOVE_3_LINE, 'wrapping only moves whitespace');
  });

  it('the word "email" appears in the enrollment card only inside the move-3 line (draft §6 move 2)', () => {
    // Rendered text only: HTML comments and the element id are not copy.
    const card = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf('<div id="clean-lane-grant-form"'), DASHBOARD_HTML.indexOf('<div id="clean-lane-on"'));
    const withoutLine = card.replace(MOVE_3_LINE, '').replace(/<!--[\s\S]*?-->/g, '').replace(/clean-lane-no-email-line/g, '');
    assert.doesNotMatch(withoutLine, /email/i);
    const cliGrant = CLI_SRC.slice(CLI_SRC.indexOf('const CLEAN_LANE_TERMS_G ='), CLI_SRC.indexOf('// ─── Entry point'));
    assert.doesNotMatch(cliGrant.replace(MOVE_3_LINE, '').replace(/CLEAN_LANE_NO_EMAIL_LINE|no-email/g, ''), /email/i);
  });
});

describe('CLI `clean-lane status`: prints the unread count only when > 0 (stub server)', () => {
  let server;
  let baseUrl;
  let unread = 0;
  before(async () => {
    server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url.startsWith('/account/clean-lane')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          account_id: OWNER,
          clean_lane_active: true,
          consent_version_current: cleanLane.CLEAN_LANE_CONSENT_VERSION,
          consent_version_recorded: cleanLane.CLEAN_LANE_CONSENT_VERSION,
          last_action: 'grant',
          last_action_at: '2026-09-01T00:00:00.000Z',
          min_auto_publish_quality: 16,
          standing_consent_ack_at: null,
          unacknowledged_publications: unread,
        }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  function runStatus() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-clean-lane-notice-'));
    fs.mkdirSync(path.join(home, '.auxilo'), { recursive: true });
    fs.writeFileSync(path.join(home, '.auxilo', 'credentials.json'), JSON.stringify({ api_key: 'test-key', base_url: baseUrl }));
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_PATH, 'clean-lane', 'status', '--base-url', baseUrl], {
        env: { ...process.env, HOME: home },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI timed out')); }, 10000);
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('error', reject);
      child.on('close', (code) => { clearTimeout(timer); fs.rmSync(home, { recursive: true, force: true }); resolve({ code, stdout, stderr }); });
      child.stdin.end('');
    });
  }

  it('unread > 0: the status output carries the count and points at the dashboard', async () => {
    unread = 3;
    const r = await runStatus();
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('Auto-publish clean learnings: ON'));
    assert.ok(r.stdout.includes('auto-published since you last checked: 3 (review and acknowledge them in your dashboard)'), r.stdout);
  });

  it('unread == 0: no count line at all', async () => {
    unread = 0;
    const r = await runStatus();
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes('since you last checked'), r.stdout);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. OpenAPI
// ─────────────────────────────────────────────────────────────────────────────
describe('openapi.json: ack cursor + unread count documented on exactly the two paths', () => {
  it('PATCH /account/settings request schema accepts standing_consent_ack_at (date-time)', () => {
    const props = OPENAPI.paths['/account/settings'].patch.requestBody.content['application/json'].schema.properties;
    assert.ok(props.autonomous_extraction_mode, 'existing field untouched');
    assert.equal(props.standing_consent_ack_at.type, 'string');
    assert.equal(props.standing_consent_ack_at.format, 'date-time');
    assert.match(props.standing_consent_ack_at.description, /not in the future/);
  });

  it('GET /account/clean-lane 200 schema carries standing_consent_ack_at (nullable date-time) and unacknowledged_publications (integer ≥ 0)', () => {
    const props = OPENAPI.paths['/account/clean-lane'].get.responses['200'].content['application/json'].schema.properties;
    assert.equal(props.standing_consent_ack_at.type, 'string');
    assert.equal(props.standing_consent_ack_at.format, 'date-time');
    assert.equal(props.standing_consent_ack_at.nullable, true);
    assert.equal(props.unacknowledged_publications.type, 'integer');
    assert.equal(props.unacknowledged_publications.minimum, 0);
    assert.match(props.unacknowledged_publications.description, /clean_lane_standing_consent/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Staged server: PATCH validation + GET count before/after the cursor
// ─────────────────────────────────────────────────────────────────────────────
const SESSION_SECRET = 'clean-lane-notice-test-session-secret-0123456789';
const OWNER_READ_KEY = `axl_${'e'.repeat(40)}`;
const FIXED_AT = '2026-07-26T12:00:00.000Z';
const T = {
  old: '2026-01-01T00:00:00.000Z',
  mid: '2026-03-01T00:00:00.000Z',
  new: '2026-06-01T00:00:00.000Z',
};

function fixtureLearning(id, overrides = {}) {
  return {
    id,
    title: `Notice fixture ${id}`,
    body: `Body for ${id}.`,
    category: 'code-execution',
    tags: ['fixture', id],
    task_context: 'notice hardening fixture',
    outcome: 'success',
    status: 'approved',
    visibility: 'public',
    contributor_account_id: OWNER,
    created_at: FIXED_AT,
    quality: { unlocks: 0, ratings: 0, avg_helpfulness: 0, helpfulness_scores: [], score: 0 },
    ...overrides,
  };
}

function fixtureCatalog() {
  const lane = (id, created_at, extra = {}) => fixtureLearning(id, {
    created_at,
    published_via: PUBLISHED_VIA,
    standing_consent_version: cleanLane.CLEAN_LANE_CONSENT_VERSION,
    retractable_until: new Date(Date.now() + 6 * 86400_000).toISOString(),
    ...extra,
  });
  return [
    lane('lrn_lane_old', T.old),
    lane('lrn_lane_mid', T.mid),
    lane('lrn_lane_new', T.new),
    fixtureLearning('lrn_manual', { created_at: T.new }),
    lane('lrn_lane_other', T.new, { contributor_account_id: OTHER }),
  ];
}

function keyEntry(id, raw, scope) {
  return {
    id,
    hash: crypto.createHash('sha256').update(raw).digest('hex'),
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
      email: 'notice-owner@test.local',
      created_at: FIXED_AT,
      tos_version: '2026-07-04-payee-agency-a1',
      accepted_at: FIXED_AT,
      publication_trust: { source: 'operator_grant', granted_at: FIXED_AT, ref: 'operator:notice-fixture' },
      api_keys: [keyEntry('key_notice_owner_read', OWNER_READ_KEY, 'read')],
    },
    [OTHER]: {
      id: OTHER,
      email: 'notice-other@test.local',
      created_at: FIXED_AT,
      api_keys: [],
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

describe('CLEAN-LANE-FLIP Phase B notice hardening: ack cursor + unread count (staged server, flag on)', { timeout: 180_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;
  let bootSkipReason;
  let ownerJwt;
  let otherJwt;

  before(async () => {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if ('skipReason' in reservation) {
      assert.equal(reservation.skipReason, BOOT_SANDBOX_SKIP_REASON);
      bootSkipReason = BOOT_SANDBOX_SKIP_REASON;
      return;
    }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-clean-lane-notice-'));
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
        EXTRACTION_AUTOPUBLISH_CONSENT_ENABLED: 'true',
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
    ownerJwt = await mintSession(OWNER, 'notice-owner@test.local');
    otherJwt = await mintSession(OTHER, 'notice-other@test.local');
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const patchSettings = async (jwt, body) => {
    const res = await fetch(`${baseUrl}/account/settings`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, payload: await res.json() };
  };
  const status = async (headers) => {
    const res = await fetch(`${baseUrl}/account/clean-lane`, { headers });
    return { status: res.status, payload: await res.json() };
  };

  it('before any acknowledgement: cursor null, every stamped row for the account counts (API key and session alike; other rows never)', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    for (const headers of [{ 'X-API-Key': OWNER_READ_KEY }, { Authorization: `Bearer ${ownerJwt}` }]) {
      const r = await status(headers);
      assert.equal(r.status, 200, JSON.stringify(r.payload));
      assert.equal(r.payload.standing_consent_ack_at, null);
      assert.equal(r.payload.unacknowledged_publications, 3);
    }
    const other = await status({ Authorization: `Bearer ${otherJwt}` });
    assert.equal(other.status, 200);
    assert.equal(other.payload.unacknowledged_publications, 1, 'the other account sees only its own stamped row');
  });

  it('PATCH validation: non-string, non-ISO, unparsable, and future stamps are 400 and never move the cursor', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const bad = [
      [1725000000000, /ISO 8601 date-time/],
      [null, /ISO 8601 date-time/],
      ['2026-09-06', /ISO 8601 date-time/],
      ['2026-09-06 12:00:00', /ISO 8601 date-time/],
      ['2026-13-45T99:00:00.000Z', /ISO 8601 date-time/],
      [new Date(Date.now() + 3600_000).toISOString(), /cannot be in the future/],
    ];
    for (const [value, re] of bad) {
      const r = await patchSettings(ownerJwt, { standing_consent_ack_at: value });
      assert.equal(r.status, 400, `${JSON.stringify(value)} → ${r.status} ${JSON.stringify(r.payload)}`);
      assert.match(r.payload.error, re);
    }
    const r = await status({ 'X-API-Key': OWNER_READ_KEY });
    assert.equal(r.payload.standing_consent_ack_at, null, 'no rejected PATCH moved the cursor');
    assert.equal(r.payload.unacknowledged_publications, 3);
    const unauth = await fetch(`${baseUrl}/account/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ standing_consent_ack_at: T.mid }),
    });
    assert.equal(unauth.status, 401);
  });

  it('a valid cursor is accepted, echoed (normalized ISO) in changes/current, and the count drops to rows created after it', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    // Cursor between old and mid (offset form, to prove normalization): old is acknowledged, mid + new are not.
    const r1 = await patchSettings(ownerJwt, { standing_consent_ack_at: '2026-02-01T00:00:00+00:00' });
    assert.equal(r1.status, 200, JSON.stringify(r1.payload));
    assert.deepEqual(r1.payload.changes.standing_consent_ack_at, { from: null, to: '2026-02-01T00:00:00.000Z' });
    assert.equal(r1.payload.current.standing_consent_ack_at, '2026-02-01T00:00:00.000Z');
    assert.equal(r1.payload.current.autonomous_extraction_mode, 'off', 'the mode is untouched by an ack-only PATCH');
    let s = await status({ 'X-API-Key': OWNER_READ_KEY });
    assert.equal(s.payload.standing_consent_ack_at, '2026-02-01T00:00:00.000Z');
    assert.equal(s.payload.unacknowledged_publications, 2);

    // Reading the route again does NOT move the cursor (the badge never clears itself).
    s = await status({ Authorization: `Bearer ${ownerJwt}` });
    assert.equal(s.payload.unacknowledged_publications, 2);

    // Cursor exactly AT mid: mid is acknowledged, only new remains.
    const r2 = await patchSettings(ownerJwt, { standing_consent_ack_at: T.mid });
    assert.equal(r2.status, 200);
    assert.deepEqual(r2.payload.changes.standing_consent_ack_at, { from: '2026-02-01T00:00:00.000Z', to: T.mid });
    s = await status({ 'X-API-Key': OWNER_READ_KEY });
    assert.equal(s.payload.unacknowledged_publications, 1);

    // "I've reviewed these": now → 0, and it stays 0 across reads.
    const r3 = await patchSettings(ownerJwt, view.buildAckBody(Date.now()));
    assert.equal(r3.status, 200, JSON.stringify(r3.payload));
    s = await status({ 'X-API-Key': OWNER_READ_KEY });
    assert.equal(s.payload.unacknowledged_publications, 0);
    assert.equal(s.payload.standing_consent_ack_at, r3.payload.current.standing_consent_ack_at);

    // The other account's cursor was never touched.
    const other = await status({ Authorization: `Bearer ${otherJwt}` });
    assert.equal(other.payload.standing_consent_ack_at, null);
    assert.equal(other.payload.unacknowledged_publications, 1);
  });

  it('a stamp ahead of the server clock inside the skew allowance is accepted but stored clamped to the server now (Gate-A S3)', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const before = Date.now();
    const fast = new Date(before + 3 * 60_000).toISOString();
    const r = await patchSettings(ownerJwt, { standing_consent_ack_at: fast });
    const after = Date.now();
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    const stored = r.payload.current.standing_consent_ack_at;
    assert.notEqual(stored, fast, 'the future stamp is not stored verbatim');
    assert.ok(Date.parse(stored) >= before && Date.parse(stored) <= after,
      `stored ${stored} must be the server now (between ${before} and ${after})`);
    const s = await status({ 'X-API-Key': OWNER_READ_KEY });
    assert.equal(s.payload.standing_consent_ack_at, stored);
    assert.ok(Date.parse(s.payload.standing_consent_ack_at) <= Date.now(), 'GET never reports a future cursor');
  });

  it('server.js: the cursor has exactly one writer (PATCH /account/settings) and the GET never writes', () => {
    const writes = SERVER_SRC.match(/account\.standing_consent_ack_at = /g) || [];
    assert.equal(writes.length, 1, 'exactly one assignment to the cursor in server.js');
    const getRoute = SERVER_SRC.slice(SERVER_SRC.indexOf("app.get('/account/clean-lane'"), SERVER_SRC.indexOf("app.post('/account/clean-lane/grant'"));
    assert.ok(getRoute.includes('countUnacknowledgedStandingConsentPublications('), 'GET computes the count via the lib helper');
    assert.ok(!getRoute.includes('saveAccounts('), 'GET never persists anything');
    assert.ok(!/notify|sendEmail|mailer|resend/i.test(getRoute), 'no email path anywhere near the notice');
  });
});
