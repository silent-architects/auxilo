'use strict';

/**
 * test/clean-lane-phase-a.test.js — CLEAN-LANE-FLIP Phase A (the "dashboard
 * option" for SPEC3-C1 standing consent; flag stays OFF, zero behaviour change
 * while dark).
 *
 *   A. Affirmation parity — every client surface that carries the sentence
 *      (dashboard label, CLI literal) is byte-equal to lib/clean-lane.js
 *      CLEAN_LANE_AFFIRMATION; the published_via stamp mirrors match too.
 *   B. Dashboard card markup: placed directly above the Pending Review Queue,
 *      never pre-checked, button disabled until ticked, 14-20 select default
 *      16, the affirmation read from the DOM at submit, session-JWT apiFetch,
 *      one-click revoke, the dark-state line.
 *   C. public/dashboard-clean-lane.js pure view logic.
 *   D. CLI `clean-lane`: grant refuses non-TTY before any network call; no
 *      bypass flag; status/revoke print "not yet available" on the dark 404.
 *   E. scripts/review-notice.js standing-consent rollup line.
 *   F. No client surface hard-codes the consent version.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const DASHBOARD_HTML = fs.readFileSync(path.join(REPO, 'public', 'dashboard.html'), 'utf8');
const CLI_PATH = path.join(REPO, 'bin', 'auxilo-cli.js');
const CLI_SRC = fs.readFileSync(CLI_PATH, 'utf8');
const NOTICE_PATH = path.join(REPO, 'scripts', 'review-notice.js');

const cleanLane = require('../lib/clean-lane.js');
const cli = require('../bin/auxilo-cli.js');
const view = require('../public/dashboard-clean-lane.js');
const notice = require('../scripts/review-notice.js');

function sliceAt(src, marker, len) {
  const i = src.indexOf(marker);
  assert.ok(i > -1, `marker not found: ${marker}`);
  return src.slice(i, i + len);
}

// ─── Stub server: every /account/clean-lane* route answers the catch-all 404
// (the dark posture) so the CLI can be exercised without the real server. ───
let server;
let baseUrl;
const requests = [];
before(async () => {
  server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, apiKey: req.headers['x-api-key'] || null });
    if (req.url.startsWith('/account/clean-lane')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', message: `No endpoint at ${req.method} ${req.url}`, help: 'See GET /api for all available endpoints' }));
      return;
    }
    if (req.url.startsWith('/account/pending/summary')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pending_count: 0, items: [] }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

function makeHome(withCreds) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-clean-lane-a-'));
  if (withCreds) {
    fs.mkdirSync(path.join(home, '.auxilo'), { recursive: true });
    fs.writeFileSync(path.join(home, '.auxilo', 'credentials.json'),
      JSON.stringify({ api_key: 'test-key', base_url: baseUrl }));
  }
  return home;
}

function runCli(args, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timed out: ${args.join(' ')}`)); }, 10000);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Affirmation parity
// ─────────────────────────────────────────────────────────────────────────────
describe('affirmation sentence parity with lib/clean-lane.js', () => {
  it('the dashboard checkbox label IS the affirmation, byte-equal to CLEAN_LANE_AFFIRMATION', () => {
    const m = /<span id="clean-lane-affirmation">([^<]*)<\/span>/.exec(DASHBOARD_HTML);
    assert.ok(m, 'dashboard must carry the affirmation as the label text of #clean-lane-affirmation');
    assert.strictEqual(m[1], cleanLane.CLEAN_LANE_AFFIRMATION);
    assert.strictEqual((DASHBOARD_HTML.match(/id="clean-lane-affirmation"/g) || []).length, 1, 'exactly one label carries the sentence');
  });

  it('the CLI literal (package boundary: lib/clean-lane.js is not shipped) equals CLEAN_LANE_AFFIRMATION', () => {
    assert.strictEqual(cli.CLEAN_LANE_AFFIRMATION, cleanLane.CLEAN_LANE_AFFIRMATION);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    assert.ok(!pkg.files.includes('lib/clean-lane.js'), 'if lib/clean-lane.js ever ships, import it in the CLI instead of mirroring');
    assert.ok(!CLI_SRC.includes("require('../lib/clean-lane.js')"), 'the CLI must not require the unshipped server module');
  });

  it('published_via stamp mirrors (review-notice + dashboard view) equal PUBLISHED_VIA_CLEAN_LANE', () => {
    assert.strictEqual(notice.PUBLISHED_VIA_CLEAN_LANE, cleanLane.PUBLISHED_VIA_CLEAN_LANE);
    assert.strictEqual(view.PUBLISHED_VIA_CLEAN_LANE, cleanLane.PUBLISHED_VIA_CLEAN_LANE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Dashboard card markup + inline script (structural)
// ─────────────────────────────────────────────────────────────────────────────
describe('dashboard card: Auto-publish clean learnings', () => {
  it('sits directly ABOVE the Pending Review Queue card (no other card between)', () => {
    const cardTitle = '<div class="dash-card-title">Auto-publish clean learnings</div>';
    const cardIdx = DASHBOARD_HTML.indexOf(cardTitle);
    const pendingIdx = DASHBOARD_HTML.indexOf('<div class="dash-card-title">Pending Review Queue');
    assert.ok(cardIdx > -1 && pendingIdx > -1);
    assert.ok(cardIdx < pendingIdx, 'card must precede the pending queue');
    const between = DASHBOARD_HTML.slice(cardIdx + cardTitle.length, pendingIdx);
    assert.ok(!between.includes('dash-card-title'), 'no other card between the two');
  });

  it('the checkbox is never pre-checked and the button is disabled until ticked', () => {
    const box = /<input type="checkbox" id="clean-lane-agree"[^>]*>/.exec(DASHBOARD_HTML);
    assert.ok(box);
    assert.ok(!/\schecked/.test(box[0]), 'never pre-checked in markup');
    assert.match(box[0], /onchange="onCleanLaneAgreeChange\(\)"/);
    assert.ok(/id="clean-lane-grant-btn"[^>]*onclick="grantCleanLane\(\)"[^>]*disabled/.test(DASHBOARD_HTML),
      'grant button disabled in markup');
    assert.match(DASHBOARD_HTML, /Turn on auto-publish<\/button>/);
    const script = sliceAt(DASHBOARD_HTML, 'function cleanLaneResetGrantForm', 400);
    assert.match(script, /box\.checked = false/, 'every render clears the tick (never remembered)');
    assert.match(script, /btn\.disabled = true/);
    assert.ok(!/clean-lane-agree[\s\S]{0,200}localStorage/.test(DASHBOARD_HTML), 'the tick is never persisted');
    const toggle = sliceAt(DASHBOARD_HTML, 'window.onCleanLaneAgreeChange', 300);
    assert.match(toggle, /btn\.disabled = !\(box && box\.checked\)/);
  });

  it('quality select is 14-20, default 16, labelled per spec', () => {
    assert.match(DASHBOARD_HTML, /<label for="clean-lane-min-quality"[^>]*>Publish only when the quality score is at least<\/label>/);
    const sel = sliceAt(DASHBOARD_HTML, '<select id="clean-lane-min-quality"', 900);
    for (let v = 14; v <= 20; v += 1) assert.ok(sel.includes(`<option value="${v}"`), `option ${v}`);
    assert.ok(!sel.includes('<option value="13"') && !sel.includes('<option value="21"'));
    assert.match(sel, /<option value="16" selected>/);
    assert.strictEqual((sel.match(/ selected>/g) || []).length, 1);
    assert.strictEqual(view.DEFAULT_MIN_QUALITY, cleanLane.MIN_AUTO_PUBLISH_QUALITY_DEFAULT);
    assert.strictEqual(view.MIN_QUALITY_MIN, cleanLane.MIN_AUTO_PUBLISH_QUALITY_MIN);
    assert.strictEqual(view.MIN_QUALITY_MAX, cleanLane.MIN_AUTO_PUBLISH_QUALITY_MAX);
  });

  it('script: session-JWT apiFetch on all three routes; grant reads the sentence from the DOM; revoke is one click', () => {
    assert.ok(DASHBOARD_HTML.includes("apiFetch('/account/clean-lane')"), 'status via apiFetch (Bearer session JWT)');
    assert.ok(DASHBOARD_HTML.includes("apiFetch('/account/clean-lane/grant'"), 'grant via apiFetch');
    assert.ok(DASHBOARD_HTML.includes("apiFetch('/account/clean-lane/revoke'"), 'revoke via apiFetch');
    const grant = sliceAt(DASHBOARD_HTML, 'window.grantCleanLane', 1800);
    assert.match(grant, /if \(!box \|\| !box\.checked \|\| !affEl \|\| !_cleanLane\) return/, 'requires the tick before POSTing');
    assert.match(grant, /getElementById\('clean-lane-affirmation'\)/);
    assert.match(grant, /affirmationText: affEl\.textContent/, 'the sentence is read from the DOM label, never retyped');
    assert.match(grant, /consentVersion: _cleanLane\.consent_version_current/, 'consent version from the GET, never a literal');
    assert.match(grant, /res\.status === 409[\s\S]{0,200}loadCleanLane\(\)/, '409 → reload and re-render');
    assert.match(grant, /res\.data\.error \|\| 'Could not turn on auto-publish\.'/, '400 shows the server message');
    const revoke = sliceAt(DASHBOARD_HTML, 'window.revokeCleanLane', 900);
    assert.ok(!/confirm\(/.test(revoke), 'revoke must be ONE click — no confirm dialog');
    assert.match(DASHBOARD_HTML, /loadCleanLane\(\);\s*\/\/ standing-consent card/, 'loaded on dashboard boot like the pending badge');
    assert.doesNotMatch(DASHBOARD_HTML, /\.innerHTML\s*=/);
    assert.ok(DASHBOARD_HTML.includes('<script src="/dashboard-clean-lane.js?v=2"></script>'));
  });

  it('dark state renders the one plain line, never an error or a control', () => {
    assert.strictEqual(view.NOT_AVAILABLE_TEXT, 'Not yet available on this account.');
    const render = sliceAt(DASHBOARD_HTML, 'function renderCleanLane', 1400);
    assert.match(render, /STATE_UNAVAILABLE[\s\S]{0,120}setText\('clean-lane-unavailable', AuxiloCleanLane\.NOT_AVAILABLE_TEXT\)/);
    // the unavailable branch returns before any form/control is shown
    const fromBranch = sliceAt(render, 'STATE_UNAVAILABLE', 400);
    const unavailableBranch = fromBranch.slice(0, fromBranch.indexOf('return;') + 'return;'.length);
    assert.match(unavailableBranch, /return;/);
    assert.ok(!/show\('clean-lane-grant-form'\)/.test(unavailableBranch));
    assert.ok(!/showAlert/.test(unavailableBranch));
  });

  it('ON state lists standing-consent items with retractable_until and a Retract (DELETE /learn/:id) button', () => {
    const list = sliceAt(DASHBOARD_HTML, 'function renderStandingConsentList', 2200);
    assert.match(list, /Retractable until /);
    assert.match(list, /btn\.textContent = 'Retract'/);
    assert.match(list, /if \(item\.retractable\)/, 'Retract only inside the window');
    const retract = sliceAt(DASHBOARD_HTML, 'function retractStandingConsentItem', 900);
    assert.match(retract, /apiFetch\('\/learn\/' \+ encodeURIComponent\(item\.id\) \+ '\?reason=retract', \{ method: 'DELETE' \}\)/);
    const on = sliceAt(DASHBOARD_HTML, 'id="clean-lane-on"', 700);
    assert.match(on, /Published under standing consent/);
    assert.match(on, /onclick="revokeCleanLane\(\)"[^>]*>Turn off<\/button>/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Pure view logic (public/dashboard-clean-lane.js)
// ─────────────────────────────────────────────────────────────────────────────
describe('dashboard-clean-lane.js pure view logic', () => {
  it('viewState: 404 → unavailable; other non-2xx → error; 2xx → on / frozen / off', () => {
    assert.deepStrictEqual(view.viewState(404, { error: 'Not found' }),
      { state: 'unavailable', message: 'Not yet available on this account.' });
    assert.deepStrictEqual(view.viewState(401, { error: 'Authentication required' }),
      { state: 'error', message: 'Authentication required' });
    assert.strictEqual(view.viewState(500, null).state, 'error');
    assert.deepStrictEqual(view.viewState(200, { clean_lane_active: true, last_action: 'grant' }), { state: 'on' });
    assert.deepStrictEqual(view.viewState(200, { clean_lane_active: false, last_action: 'freeze', freeze_reason: 'retraction_rate_exceeded' }),
      { state: 'frozen', freezeReason: 'retraction_rate_exceeded' });
    assert.deepStrictEqual(view.viewState(200, { clean_lane_active: false }), { state: 'off' });
    assert.deepStrictEqual(view.viewState(200, { clean_lane_active: false, last_action: 'revoke' }), { state: 'off' });
  });

  it('buildGrantBody: agree:true + the caller-supplied sentence + version + clamped integer threshold', () => {
    const body = view.buildGrantBody({ consentVersion: 'v-from-server', affirmationText: 'SENTENCE', minQuality: '18' });
    assert.deepStrictEqual(body, { consent_version: 'v-from-server', agree: true, affirmation: 'SENTENCE', min_auto_publish_quality: 18 });
    assert.strictEqual(view.buildGrantBody({ minQuality: 'x' }).min_auto_publish_quality, 16);
    assert.strictEqual(view.buildGrantBody({ minQuality: 9 }).min_auto_publish_quality, 16);
    assert.strictEqual(view.buildGrantBody({ minQuality: 20 }).min_auto_publish_quality, 20);
    assert.strictEqual(view.buildGrantBody({}).affirmation, undefined, 'the module never supplies the sentence itself');
  });

  it('qualityOptions: 14..20 with 16 selected by default', () => {
    const opts = view.qualityOptions();
    assert.deepStrictEqual(opts.map((o) => o.value), [14, 15, 16, 17, 18, 19, 20]);
    assert.deepStrictEqual(opts.filter((o) => o.selected).map((o) => o.value), [16]);
    assert.deepStrictEqual(view.qualityOptions(19).filter((o) => o.selected).map((o) => o.value), [19]);
  });

  it('onStateLine + frozenLine render the spec sentences', () => {
    const line = view.onStateLine({
      clean_lane_active: true, last_action_at: '2026-09-05T12:34:56.000Z',
      min_auto_publish_quality: 17, consent_version_recorded: '2026-07-19-clean-lane-a1',
    });
    assert.strictEqual(line, 'Auto-publish is ON since 2026-09-05 at quality ≥ 17 (consent 2026-07-19-clean-lane-a1)');
    assert.strictEqual(view.frozenLine('retraction_rate_exceeded'),
      'Auto-publish is FROZEN (retraction_rate_exceeded). Nothing auto-publishes until you grant consent again below.');
  });

  it('selectStandingConsentItems: only stamped rows, newest first, retractable inside the window', () => {
    const now = Date.parse('2026-09-05T00:00:00Z');
    const rows = [
      { id: 'a', title: 'old', created_at: '2026-08-20T00:00:00Z', standing_consent_version: 'v', retractable_until: '2026-08-27T00:00:00Z' },
      { id: 'b', title: 'plain', created_at: '2026-09-04T00:00:00Z' },
      { id: 'c', title: 'fresh', created_at: '2026-09-03T00:00:00Z', standing_consent_version: 'v', retractable_until: '2026-09-10T00:00:00Z' },
      null,
    ];
    const items = view.selectStandingConsentItems(rows, now);
    assert.deepStrictEqual(items.map((i) => i.id), ['c', 'a']);
    assert.strictEqual(items[0].retractable, true);
    assert.strictEqual(items[1].retractable, false);
    assert.deepStrictEqual(view.selectStandingConsentItems([], now), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. CLI clean-lane
// ─────────────────────────────────────────────────────────────────────────────
describe('CLI: auxilo clean-lane', () => {
  it('grant REFUSES a non-TTY stdin before credentials and before any network call', async () => {
    const home = makeHome(true);
    const before = requests.length;
    const res = await runCli(['clean-lane', 'grant'], { HOME: home, AUXILO_BASE_URL: baseUrl },
      `16\n${cleanLane.CLEAN_LANE_AFFIRMATION}\n`);
    assert.strictEqual(res.code, 1);
    assert.match(res.stderr, /interactive terminal/);
    assert.match(res.stderr, /no flag/);
    assert.strictEqual(requests.length, before, 'zero requests: the TTY gate runs first');
    // Even with no credentials at all the answer is the same (gate precedes creds).
    const bare = await runCli(['clean-lane', 'grant', '--yes'], { HOME: makeHome(false), AUXILO_BASE_URL: baseUrl });
    assert.strictEqual(bare.code, 1);
    assert.match(bare.stderr, /interactive terminal/);
    assert.strictEqual(requests.length, before);
  });

  it('structural: the TTY gate + typed-verbatim compare exist; no --yes / bypass in cmdCleanLane', () => {
    const fn = sliceAt(CLI_SRC, 'async function cmdCleanLane', 6000);
    assert.match(fn, /sub === 'grant' && !process\.stdin\.isTTY/);
    assert.match(fn, /if \(typed !== CLEAN_LANE_AFFIRMATION\)/, 'the human-typed sentence is compared verbatim');
    assert.match(fn, /affirmation: typed/, 'what was typed is what is transmitted');
    assert.ok(!/flags\.yes|flags\['yes'\]|--yes|flags\.force|flags\.agree/.test(fn), 'no flag can stand in for the typed sentence');
    assert.match(fn, /consent_version: status\.data\.consent_version_current/, 'version from the server');
    const help = sliceAt(CLI_SRC, "'clean-lane': `Usage: auxilo clean-lane", 700);
    assert.ok(!/--yes/.test(help));
  });

  it('status on the dark 404 prints "not yet available", exit 0, one authenticated GET', async () => {
    const home = makeHome(true);
    const before = requests.length;
    const res = await runCli(['clean-lane', 'status'], { HOME: home, AUXILO_BASE_URL: baseUrl });
    assert.strictEqual(res.code, 0, res.stderr);
    assert.match(res.stdout, /not yet available on this account/);
    assert.strictEqual(res.stdout.trim(), cli.CLEAN_LANE_UNAVAILABLE);
    const mine = requests.slice(before);
    assert.deepStrictEqual(mine.map((r) => [r.method, r.url]), [['GET', '/account/clean-lane']]);
    assert.strictEqual(mine[0].apiKey, 'test-key');
  });

  it('revoke on the dark 404 prints "not yet available", exit 0, and never POSTs', async () => {
    const home = makeHome(true);
    const before = requests.length;
    const res = await runCli(['clean-lane', 'revoke'], { HOME: home, AUXILO_BASE_URL: baseUrl });
    assert.strictEqual(res.code, 0, res.stderr);
    assert.strictEqual(res.stdout.trim(), cli.CLEAN_LANE_UNAVAILABLE);
    assert.deepStrictEqual(requests.slice(before).map((r) => r.method), ['GET']);
  });

  it('help + argument handling: --help exits 0 with no network; unknown subcommand exits 1; not logged in exits 1', async () => {
    const before = requests.length;
    const help = await runCli(['clean-lane', '--help'], { HOME: makeHome(false), AUXILO_BASE_URL: baseUrl });
    assert.strictEqual(help.code, 0, help.stderr);
    assert.match(help.stdout, /Usage: auxilo clean-lane <status\|grant\|revoke>/);
    const bad = await runCli(['clean-lane', 'enable'], { HOME: makeHome(true), AUXILO_BASE_URL: baseUrl });
    assert.strictEqual(bad.code, 1);
    assert.match(bad.stderr, /Unknown clean-lane subcommand: enable/);
    const noCreds = await runCli(['clean-lane', 'status'], { HOME: makeHome(false), AUXILO_BASE_URL: baseUrl });
    assert.strictEqual(noCreds.code, 1);
    assert.match(noCreds.stderr, /Not logged in/);
    assert.strictEqual(requests.length, before, 'none of these reach the network');
    const top = await runCli(['--help'], { HOME: makeHome(false) });
    assert.match(top.stdout, /clean-lane <status\|grant\|revoke>/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. review-notice rollup line
// ─────────────────────────────────────────────────────────────────────────────
describe('review-notice: standing-consent rollup line', () => {
  it('countStandingConsentPublishes: stamped rows only, after the last notice', () => {
    const rows = [
      { title: 'a', published_via: 'clean_lane_standing_consent', submitted_at: '2026-09-05T10:00:00Z' },
      { title: 'b', published_via: 'clean_lane_standing_consent', submitted_at: '2026-09-05T08:00:00Z' },
      { title: 'c', submitted_at: '2026-09-05T11:00:00Z' },
      { title: 'd', published_via: 'clean_lane_standing_consent' }, // no timestamp
      null,
    ];
    assert.strictEqual(notice.countStandingConsentPublishes(rows, undefined), 3, 'no prior notice → every stamped row');
    assert.strictEqual(notice.countStandingConsentPublishes(rows, '2026-09-05T09:00:00Z'), 1, 'only rows after the stamp');
    assert.strictEqual(notice.countStandingConsentPublishes(rows, 'garbage'), 3, 'unreadable stamp → no prior');
    assert.strictEqual(notice.countStandingConsentPublishes([], undefined), 0);
  });

  it('renderStandingConsentNotice is count-only with the retraction window and the command', () => {
    const line = notice.renderStandingConsentNotice(3);
    assert.strictEqual(line, 'Auxilo: 3 learning(s) auto-published under your standing consent (retract within 7 days: npx auxilo review).');
    assert.ok(!/title|body/i.test(line));
  });

  // Async spawn (not spawnSync): the stub server lives in THIS process, and a
  // blocking spawn would starve it — the child's fetch would then abort at
  // 3.5s and the pending-count path would never actually be exercised.
  function runNotice(home) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [NOTICE_PATH], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('review-notice timed out')); }, 10000);
      child.stdout.on('data', (c) => { stdout += c; });
      child.on('error', reject);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout }); });
    });
  }

  it('spawned: rollup line prints alone when nothing is held (stub reached), then the notice stamp suppresses it', async () => {
    const home = makeHome(true);
    const idx = notice.submittedIndexPath(home);
    const now = Date.now();
    fs.writeFileSync(idx, [
      JSON.stringify({ title: 'x', category: 'code-execution', published_via: 'clean_lane_standing_consent', submitted_at: new Date(now - 3600e3).toISOString() }),
      JSON.stringify({ title: 'y', category: 'code-execution', published_via: 'clean_lane_standing_consent', submitted_at: new Date(now - 1800e3).toISOString() }),
      JSON.stringify({ title: 'z', category: 'code-execution', submitted_at: new Date(now - 600e3).toISOString() }),
      'not json',
    ].join('\n') + '\n');
    const before = requests.length;
    const started = Date.now();
    const res = await runNotice(home);
    assert.ok(Date.now() - started < notice.FETCH_TIMEOUT_MS, 'the stub answered; no abort-timeout path');
    assert.strictEqual(res.code, 0);
    assert.deepStrictEqual(requests.slice(before).map((r) => r.url), ['/account/pending/summary'], 'held count fetched from the stub');
    assert.strictEqual(res.stdout, notice.renderStandingConsentNotice(2) + '\n');
    const state = notice.readState(home);
    assert.ok(state.last_notice_at, 'the rollup writes the notice stamp');
    // Second run inside the 4h window: suppressed, nothing printed, no fetch.
    const again = await runNotice(home);
    assert.strictEqual(again.stdout, '');
    assert.strictEqual(requests.length, before + 1);
  });

  it('spawned: rows older than the last notice do not count; no credentials stays silent', async () => {
    const home = makeHome(true);
    const now = Date.now();
    fs.writeFileSync(notice.submittedIndexPath(home),
      JSON.stringify({ title: 'x', category: 'code-execution', published_via: 'clean_lane_standing_consent', submitted_at: new Date(now - 6 * 3600e3).toISOString() }) + '\n');
    notice.writeState(home, now - 5 * 3600e3); // last notice 5h ago (outside suppression, after the row)
    const res = await runNotice(home);
    assert.strictEqual(res.code, 0);
    assert.strictEqual(res.stdout, '');

    const noCreds = makeHome(false);
    fs.mkdirSync(path.join(noCreds, '.auxilo'), { recursive: true });
    fs.writeFileSync(notice.submittedIndexPath(noCreds),
      JSON.stringify({ title: 'x', category: 'code-execution', published_via: 'clean_lane_standing_consent', submitted_at: new Date(now - 60e3).toISOString() }) + '\n');
    const silent = await runNotice(noCreds);
    assert.strictEqual(silent.code, 0);
    assert.strictEqual(silent.stdout, '', 'fail-silent contract unchanged');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. No client surface hard-codes the consent version
// ─────────────────────────────────────────────────────────────────────────────
describe('consent version is server-supplied on every client surface', () => {
  it('dashboard, dashboard-clean-lane.js, CLI and review-notice contain no consent-version literal', () => {
    const viewSrc = fs.readFileSync(path.join(REPO, 'public', 'dashboard-clean-lane.js'), 'utf8');
    const noticeSrc = fs.readFileSync(NOTICE_PATH, 'utf8');
    for (const [name, src] of [['dashboard.html', DASHBOARD_HTML], ['dashboard-clean-lane.js', viewSrc], ['auxilo-cli.js', CLI_SRC], ['review-notice.js', noticeSrc]]) {
      assert.ok(!src.includes(cleanLane.CLEAN_LANE_CONSENT_VERSION), `${name} must not hard-code the consent version`);
    }
  });
});
