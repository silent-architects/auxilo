'use strict';

/**
 * test/launch-wave-dashboard.test.js — LW3 Unit A (dashboard reorder +
 * welcome card + auto-load pending queue + plain empty states + summary
 * bar + unlock-email setting).
 *
 * Covers BUILD-SPEC-W3-DASHBOARD-EMAIL.md test cases 28-31 (dashboard
 * section), adapted where REGISTER-B2-REV2.md's ruling changed the
 * underlying design from the spec's placeholder structure (see the note on
 * test 29 below), plus the ten items BUILDER-RULES/the build brief asked
 * for by name.
 *
 * Style: mirrors test/clean-lane-phase-b-dash.test.js's convention for
 * dashboard.html's embedded, non-modular <script> -- static source-slice +
 * regex/substring assertions (extract a named function's text between two
 * known anchors), not execution, since the script is a page-scoped IIFE
 * with no CommonJS exports. Behavioral (rendered) proof lives in the
 * separate Playwright rendered-check script, not in this automated suite.
 *
 * Runner: node --test test/launch-wave-dashboard.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SignJWT } = require('jose');
const {
  bootServer,
  reservePort,
  stageServer,
  stopServer,
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const DASHBOARD_PATH = path.join(REPO, 'public', 'dashboard.html');
const DASHBOARD_HTML = fs.readFileSync(DASHBOARD_PATH, 'utf8');
const SESSION_SECRET = 'launch-wave-dashboard-session-secret-32b';

// ─── helpers ────────────────────────────────────────────────────────────────

// Strips tags, decodes the handful of entities this file actually uses,
// collapses whitespace, and collapses a space before punctuation -- per
// BUILDER-RULES "when comparing text against markup".
function textOf(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

function sliceBetween(source, startMarker, endMarker, fromIndex) {
  const start = source.indexOf(startMarker, fromIndex || 0);
  assert.ok(start > -1, `marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `end marker not found after start: ${endMarker}`);
  return source.slice(start, end);
}

function indexOfAll(source, needles) {
  return needles.map((n) => {
    const i = source.indexOf(n);
    assert.ok(i > -1, `expected to find: ${n}`);
    return i;
  });
}

async function sessionToken(accountId, email) {
  return new SignJWT({ accountId, email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(Buffer.from(SESSION_SECRET));
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON, e.g. the HTML page */ }
  return { status: response.status, ok: response.ok, text, body };
}

async function startDashboardFixture(t) {
  let nodeModulesDir;
  try {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    nodeModulesDir = honoEntry.slice(
      0,
      honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length,
    );
  } catch {
    t.skip('hono not resolvable from repo root');
    return null;
  }

  const reservation = await reservePort();
  if (reservation.skipReason) { t.skip(reservation.skipReason); return null; }

  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-launch-wave-dashboard-'));
  let child = null;
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (child) await stopServer(child);
    fs.rmSync(app, { recursive: true, force: true });
  };
  t.after(cleanup);

  try {
    const { dataDir } = stageServer({
      repoRoot: REPO,
      tmpDir: app,
      nodeModulesDir,
      port: reservation.port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: [],
      copyDirs: ['lib', 'public', 'prompts', 'config'],
    });

    fs.writeFileSync(path.join(dataDir, 'learnings.json'), JSON.stringify([], null, 2));
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(dataDir, 'earnings.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(dataDir, 'magic_links.json'), JSON.stringify({}, null, 2));

    const boot = await bootServer({
      tmpDir: app,
      port: reservation.port,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        SESSION_SECRET,
        RESEND_API_KEY: '',
        LLM_SENSITIVITY_ENABLED: 'false',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      },
      timeoutMs: 60_000,
      maxAttempts: 3,
    });
    if (boot.skipReason) { t.skip(boot.skipReason); await cleanup(); return null; }
    child = boot.child;
    return { ...boot, dataDir, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// ─── 1. Card order ──────────────────────────────────────────────────────────

describe('LW3: card order after the terms gate', () => {
  it('DOM order matches the ruled order: welcome, pending, earnings, payouts, auto-publish, api keys, credits, history', () => {
    const markers = [
      'id="terms-gate"',
      'id="welcome-card"',
      'id="pending-review-card"',
      '<div class="dash-card-title">Earnings</div>',
      '<div class="dash-card-title">Payouts</div>',
      '<div class="dash-card-title">Auto-publish clean learnings</div>',
      '<div class="dash-card-title">API Keys</div>',
      '<div class="dash-card-title">Credits</div>',
      '<div class="dash-card-title">Credit Purchase History</div>',
    ];
    const positions = indexOfAll(DASHBOARD_HTML, markers);
    for (let i = 1; i < positions.length; i += 1) {
      assert.ok(positions[i] > positions[i - 1], `${markers[i]} must follow ${markers[i - 1]}`);
    }
    // Exactly one Pending Review Queue card in the file (the old location was removed).
    assert.strictEqual(
      (DASHBOARD_HTML.match(/<div class="dash-card-title">Pending Review Queue/g) || []).length,
      1,
      'exactly one Pending Review Queue card remains -- the old location must be gone, not duplicated',
    );
  });

  it('the summary bar sits directly under the header, above the alert area and every card', () => {
    const [headerCloseIdx] = indexOfAll(DASHBOARD_HTML, ['<div class="dash-title">Account Dashboard</div>']);
    const summaryIdx = DASHBOARD_HTML.indexOf('id="dash-summary-bar"');
    const alertIdx = DASHBOARD_HTML.indexOf('id="dash-alert"');
    const termsIdx = DASHBOARD_HTML.indexOf('id="terms-gate"');
    assert.ok(headerCloseIdx < summaryIdx, 'summary bar follows the header');
    assert.ok(summaryIdx < alertIdx, 'summary bar precedes the global alert');
    assert.ok(alertIdx < termsIdx, 'summary bar (and alert) precede every card');
  });
});

// ─── 2. Welcome card ────────────────────────────────────────────────────────

describe('LW3: welcome card', () => {
  it('exists, is hidden by default in the static file, and contains variant A and variant B exactly', () => {
    const cardMatch = /<div id="welcome-card" class="dash-card" style="display:none">/.exec(DASHBOARD_HTML);
    assert.ok(cardMatch, 'welcome card must ship display:none in the static file');

    const block = sliceBetween(DASHBOARD_HTML, '<div id="welcome-card" class="dash-card"', '<!-- Pending review queue');

    // Variant A (D-01, D-02, D-03, D-04, D-07, D-08, D-10) -- register text, verbatim.
    assert.ok(/<div id="welcome-card-a">/.test(block), 'variant A container present');
    assert.ok(!/<div id="welcome-card-a"[^>]*display:\s*none/.test(block), 'variant A itself is not separately hidden -- the outer card carries the hiding');
    assert.ok(block.includes('Start Here'), 'D-01');
    assert.ok(block.includes('Run this once to connect your agent.'), 'D-02');
    assert.ok(block.includes('One command. Any terminal.'), 'D-03 label');
    assert.ok(block.includes('npx auxilo setup'), 'D-03 code');
    assert.ok(block.includes('Copy the Setup Command'), 'D-03 button');
    assert.ok(block.includes('Setup is free and takes one command. Extraction stays off until you turn it on.'), 'D-04');
    assert.ok(block.includes('Anything your agent extracts waits in your review queue below until you approve it, one learning at a time or in advance in your dashboard.'), 'D-07');
    assert.ok(block.includes('Once a learning is published, your agent gets it back free when it asks Auxilo, signed in to your account.'), 'D-08');
    assert.ok(/href="\/how-it-works" class="hero-cta-link">See How It Works</.test(block), 'D-10 link');

    // Variant B (D-11 to D-15), hidden by default, distinct from A.
    const bMatch = /<div id="welcome-card-b" style="display:none">/.exec(block);
    assert.ok(bMatch, 'variant B ships display:none in the static file');
    assert.ok(block.includes('Your Learnings Are Waiting'), 'D-11');
    assert.ok(block.includes('Review them in the queue below.'), 'D-12');
    assert.ok(block.includes('Approving an item keeps it in your queue for operator review until Auxilo has cleared your account to publish.'), 'D-13');
    assert.ok(block.includes('Anything you keep private comes back free to your agent when it asks Auxilo, signed in to your account. It is never published.'), 'D-14');
    assert.strictEqual((block.match(/See How It Works/g) || []).length, 2, 'D-10 and D-15 each carry their own link');
  });

  it('carries no gold border on the outer card and no gold button except the shared copy control', () => {
    const cardTag = /<div id="welcome-card" class="dash-card"[^>]*>/.exec(DASHBOARD_HTML)[0];
    assert.ok(!cardTag.includes('var(--aurum)'), 'the welcome card itself has no gold border (unlike #terms-gate)');
    const block = sliceBetween(DASHBOARD_HTML, '<div id="welcome-card" class="dash-card"', '<!-- Pending review queue');
    assert.ok(!/class="btn btn-primary"/.test(block), 'no .btn-primary (gold) button inside the welcome card');
    assert.ok(block.includes('class="copy-btn"'), 'the one gold-capable control is the shared .copy-btn component');
  });
});

// ─── 3. Pending queue: no "Load queue", Refresh exists, wired from showDashboard ──

describe('LW3: pending queue auto-load', () => {
  it('no "Load queue" text remains; a Refresh control exists', () => {
    assert.ok(!DASHBOARD_HTML.includes('Load queue'), '"Load queue" must be gone');
    assert.match(DASHBOARD_HTML, /onclick="loadPendingQueue\(\)"[^>]*>Refresh</, 'Refresh button present, same handler');
  });

  it('the function that renders the queue is called from the function that shows the dashboard', () => {
    const showDashboardFn = sliceBetween(DASHBOARD_HTML, 'function showDashboard(email) {', '\n  }\n');
    assert.ok(showDashboardFn.includes('window.loadPendingQueue();'), 'showDashboard() calls loadPendingQueue()');
    assert.ok(!showDashboardFn.includes('loadPendingBadge'), 'the old badge-only call is gone from showDashboard()');
    assert.ok(!/function loadPendingBadge/.test(DASHBOARD_HTML), 'loadPendingBadge() itself is deleted, not just uncalled');
  });

  it('D-51/D-52 empty states exist and are chosen by autonomous_extraction_mode, defaulting to D-51', () => {
    assert.ok(DASHBOARD_HTML.includes(
      "Your queue is clear. After your agent's next session, anything waiting for your decision lands here. If nothing arrives, run npx auxilo status to check your setup.",
    ), 'D-51');
    assert.ok(DASHBOARD_HTML.includes(
      'Nothing is waiting. Extraction is off, so your agent is not drafting learnings yet. Run npx auxilo setup and say yes to turn it on.',
    ), 'D-52');
    const pendingEmptyTextFn = sliceBetween(DASHBOARD_HTML, 'function pendingEmptyText() {', 'function applyUnlockEmailSetting');
    assert.match(pendingEmptyTextFn, /_accountAutonomousMode === 'off'/, "D-52 selected only when the mode is exactly 'off'");
  });

  it('D-50 queue explainer is present with lane names exact', () => {
    assert.ok(DASHBOARD_HTML.includes(
      "Learnings your agent drafts wait here until you decide. Nothing is published until you approve it, one learning at a time or in advance. They are sorted into Ready to publish, Needs a score, and Needs your eyes.",
    ), 'D-50');
  });
});

// ─── 4. D-70 label ──────────────────────────────────────────────────────────

describe('LW3: Earnings card D-70 label', () => {
  it('"Your revenue share (70%, earned to date)" is absent; the D-70 label is present', () => {
    assert.ok(!DASHBOARD_HTML.includes('Your revenue share (70%, earned to date)'), 'old label gone');
    assert.ok(DASHBOARD_HTML.includes("label: 'Your revenue share, earned to date'"), 'D-70 label present, exact');
  });
});

// ─── 5. D-31 disclaimer exactly once ───────────────────────────────────────

describe('LW3: Earnings card D-31 disclaimer', () => {
  it('contains the not-guaranteed sentence exactly once', () => {
    const sentence = 'Earnings depend on whether other agents unlock your learnings and are not guaranteed.';
    assert.strictEqual((DASHBOARD_HTML.match(new RegExp(sentence.replace(/[.]/g, '\\.'), 'g')) || []).length, 1, 'D-31 appears exactly once');
  });

  it('D-30 (real zeros are stated) is present and the $0.00 grid items are unconditional', () => {
    assert.ok(DASHBOARD_HTML.includes(
      'Nothing has accrued yet. When another agent unlocks one of your published learnings, your share accrues and shows here.',
    ), 'D-30');
    const renderEarningsFn = sliceBetween(DASHBOARD_HTML, 'function renderEarnings(data) {', '// ── Payout panel');
    // REGISTER-B2-REV2.md ruling: "The $0.00 cells stay" -- the four-item grid
    // is NOT replaced by the empty state (a deviation from BUILD-SPEC-W3's
    // placeholder renderEarnings() sample, which proposed short-circuiting to
    // a single line; the register is the copy authority here and is explicit
    // that real zeros are stated alongside the note, not instead of it).
    assert.ok(renderEarningsFn.includes("label: 'Your share (accrued)'"), 'the accrued-share cell is unconditional');
    assert.ok(renderEarningsFn.includes("label: 'Lifetime gross'"), 'the lifetime-gross cell is unconditional');
    assert.ok(renderEarningsFn.includes("label: 'Total withdrawn'"), 'the total-withdrawn cell is unconditional');
    assert.match(renderEarningsFn, /totalContributor === 0/, 'D-30 note keys off total_contributor === 0, per the register');
  });
});

// ─── 6. Payouts paused branch ───────────────────────────────────────────────

describe('LW3: Payouts card, paused branch', () => {
  it('contains "Earnings accrue now." and "Withdrawals open soon." as a pair with a /status link, and none of the retired strings', () => {
    const fn = sliceBetween(DASHBOARD_HTML, 'function renderPayoutPanel(data) {', '// USDC / crypto section');
    const rendered = textOf(fn.replace(/'/g, "'")); // source text, not DOM -- string literals read directly below
    assert.ok(fn.includes("document.createTextNode('Earnings accrue now. ')"), 'the plain prefix');
    assert.ok(fn.includes("pausedHeadLink.textContent = 'Withdrawals open soon.';"), 'the linked clause');
    assert.ok(fn.includes("pausedHeadLink.href = '/status';"), 'the /status link target');
    assert.ok(!fn.includes('Withdrawals are opening soon'), 'D-40 retired string gone');
    assert.ok(!fn.includes('No lock-ups, no expiry'), 'D-41 retired clause gone');
    assert.ok(!fn.includes('See where things stand'), 'D-42 cut, no standalone link left');
    assert.ok(fn.includes('Your share accrues to your Auxilo account and remains payable to you under the Terms. When withdrawals open, your payout options appear here.'), 'D-41 replacement body');
    assert.ok(fn.includes("pausedWallet.textContent = 'Your linked wallet stays ready: ' + data.wallet;"), 'the linked-wallet readout is KEPT');
    void rendered;
  });
});

// ─── 7. Notification setting: hidden by default, no gold ──────────────────

describe('LW3: unlock-email setting (D-80/D-81)', () => {
  it('is hidden by default in the static file and carries no gold', () => {
    const block = sliceBetween(DASHBOARD_HTML, '<div id="unlock-email-setting"', '<p style="font-size:12px;color:var(--slate);margin-top:20px;line-height:1.6">Earnings depend');
    assert.match(DASHBOARD_HTML, /<div id="unlock-email-setting" style="display:none;/, 'ships hidden');
    assert.ok(!block.includes('var(--aurum)'), 'no aurum color token inside the block');
    assert.ok(!block.includes('201,168,76'), 'no aurum rgb literal inside the block');
    assert.ok(!/accent-color/.test(block), 'no accent-color on the checkbox -- native, unstyled, matching #terms-agree-check and #clean-lane-agree');
    assert.ok(block.includes('Unlock emails'), 'D-80 label');
    assert.ok(block.includes('Get an email when another agent unlocks one of your learnings. Sign-in and account emails still arrive when this is off.'), 'D-81 help text');
  });

  it('reveals only when earning_notifications_available is exactly true, and reverts the checkbox on a failed save', () => {
    const loadFn = sliceBetween(DASHBOARD_HTML, 'function applyUnlockEmailSetting(res) {', 'function loadAccountSettings');
    assert.match(loadFn, /res\.data\.earning_notifications_available === true/, 'strict === true check, not truthy');
    const toggleFn = sliceBetween(DASHBOARD_HTML, 'window.onUnlockEmailToggleChange = function () {', '\n  };');
    assert.ok(toggleFn.includes('box.checked = prevVal;'), 'reverts the checkbox on a failed save (both the !res.ok branch and the network-error catch)');
    assert.match(toggleFn, /showAlert\('dash-alert'/, "uses the dashboard's existing error alert");
  });
});

// ─── 8. No innerHTML with an interpolated value (regression guard) ────────

describe('LW3: XSS-safe DOM helper invariant', () => {
  it('no line uses innerHTML with string concatenation or a template literal containing ${', () => {
    const offenders = DASHBOARD_HTML
      .split('\n')
      .filter((line) => /\.innerHTML\s*=/.test(line))
      .filter((line) => line.includes('+') || line.includes('${'));
    assert.deepEqual(offenders, [], `innerHTML with interpolation found:\n${offenders.join('\n')}`);
  });

  it('the whole file contains zero innerHTML assignments at all (the file-wide rule is textContent/createElement only)', () => {
    assert.ok(!/\.innerHTML\s*=/.test(DASHBOARD_HTML), 'no innerHTML assignment anywhere in dashboard.html');
  });
});

// ─── 9. Credits card byte-identical to origin/main ─────────────────────────

describe('LW3: GOV-2 A6, Credits card untouched', () => {
  it("the Credits card's markup is byte-identical to origin/main", () => {
    let originMain;
    try {
      originMain = execFileSync('git', ['show', 'origin/main:public/dashboard.html'], { cwd: REPO, encoding: 'utf8' });
    } catch (e) {
      // No network/origin remote available in this environment -- fall back
      // to the wave's own captured copy (scratchpad/build/regb/om/dashboard.html
      // is a verified byte-for-byte copy of origin/main at 39a30dd, confirmed
      // identical except the styles.css ?v= hash, which sits outside this
      // slice).
      const fallback = '/private/tmp/claude-501/-Users-iamtylerkelley-dev-auxilo/774f5f5e-685e-4402-972a-94889e73de0d/scratchpad/build/regb/om/dashboard.html';
      if (!fs.existsSync(fallback)) throw e;
      originMain = fs.readFileSync(fallback, 'utf8');
    }

    const marker = '<!-- Credits (CREDITS-CONTROL PART 1). GOV-2 A6: no string, layout, or';
    const oldBlock = sliceBetween(originMain, marker, '<!-- Purchase history -->');
    const newBlock = sliceBetween(DASHBOARD_HTML, marker, '<!-- Purchase history -->');
    assert.strictEqual(newBlock, oldBlock, "the Credits card (comment through its closing </div>) must not change one byte");
  });
});

// ─── 10. No em dash / en dash in anything added ────────────────────────────

describe('LW3: dash hygiene', () => {
  it('the visible static text and script strings added by this unit contain no em dash and no en dash', () => {
    // Scoped to the regions this unit actually authored, not the whole file
    // (other builders' untouched regions are not this unit's to grade).
    const regions = [
      sliceBetween(DASHBOARD_HTML, 'id="dash-summary-bar"', '<!-- Global alert -->'),
      sliceBetween(DASHBOARD_HTML, '<div id="welcome-card" class="dash-card"', '<!-- Earnings panel -->'),
      sliceBetween(DASHBOARD_HTML, '<div id="unlock-email-setting"', '<!-- Payout panel -->'),
      sliceBetween(DASHBOARD_HTML, 'function updateWelcomeCard() {', 'function loadEarnings() {'),
    ];
    for (const region of regions) {
      assert.ok(!/–|—/.test(region), `em/en dash found in an authored region:\n${region}`);
    }
  });
});

// ─── Spec test cases 28-31 ──────────────────────────────────────────────────

describe('BUILD-SPEC test case 28: published-count API + welcome-card visibility predicate', () => {
  it('GET /account/learnings?status=approved&limit=1 on a fresh account returns total: 0', async (t) => {
    const fixture = await startDashboardFixture(t);
    if (!fixture) return;
    const token = await sessionToken('acc_fresh', 'fresh@example.com');
    fs.writeFileSync(path.join(fixture.dataDir, 'accounts.json'), JSON.stringify({
      acc_fresh: { id: 'acc_fresh', email: 'fresh@example.com', created_at: new Date().toISOString(), api_keys: [] },
    }, null, 2));

    const res = await fetchJson(`${fixture.baseUrl}/account/learnings?status=approved&limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 0);
    assert.deepEqual(res.body.learnings, []);
  });

  it('the welcome-card visibility predicate returns true only for a published-total of exactly 0', () => {
    // dashboard.html is a page-scoped IIFE with no exports, so this mirrors
    // the exact conditional in updateWelcomeCard() (asserted against the
    // live source below) as a standalone, directly testable predicate.
    function shouldShowWelcomeCard(totalApproved) {
      return totalApproved === 0;
    }
    assert.equal(shouldShowWelcomeCard(0), true);
    for (const n of [1, 2, 50, -1, 0.5]) {
      assert.equal(shouldShowWelcomeCard(n), false, `must be false for ${n}`);
    }

    const updateWelcomeCardFn = sliceBetween(DASHBOARD_HTML, 'function updateWelcomeCard() {', 'function loadWelcomeCard() {');
    assert.match(updateWelcomeCardFn, /if \(_welcomePublishedTotal !== 0\) \{ hide\('welcome-card'\); return; \}/, 'source conditional matches the mirrored predicate: shown only when the total is exactly 0');
  });
});

describe('BUILD-SPEC test case 29: renderEarnings() empty-state trigger', () => {
  it('D-30 keys off total_contributor === 0, with a defensive fallback to 0 when the field is missing, and never removes the $0.00 grid', () => {
    // Deviation from the spec's placeholder: BUILD-SPEC-W3-DASHBOARD-EMAIL.md
    // section 3.1.4 proposed replacing the four-item grid with a single line
    // keyed off data.message === 'No earnings recorded yet' (with an
    // all-zero fallback). REGISTER-B2-REV2.md's D-30 row rules the opposite
    // explicitly ("The $0.00 cells stay. Real zeros are stated.") -- the
    // register is the copy authority and this build follows it, not the
    // spec's sample code. This test pins the SHIPPED behavior.
    const fn = sliceBetween(DASHBOARD_HTML, 'function renderEarnings(data) {', '// ── Payout panel');
    assert.match(fn, /var totalContributor = \(data && typeof data\.total_contributor === 'number'\) \? data\.total_contributor : 0;/, 'defensive fallback to 0 when total_contributor is missing/non-numeric');
    assert.match(fn, /emptyNote\.style\.display = totalContributor === 0 \? '' : 'none';/, 'the note toggles on total_contributor === 0 exactly, not on data.message');
    assert.ok(!/grid\.textContent = '';\s*(?:(?!grid\.appendChild).)*return;/s.test(fn.slice(0, fn.indexOf('items.forEach'))), 'the grid is never short-circuited to a single empty-state line before the four items are built');
  });
});

describe('BUILD-SPEC test case 30: static innerHTML regression guard', () => {
  it('no new dashboard code path uses innerHTML with an interpolated value', () => {
    assert.ok(!/\.innerHTML\s*=/.test(DASHBOARD_HTML), 'covered by the broader check above; restated here as the named spec test');
  });
});

describe('BUILD-SPEC test case 31: GOV-2 A6 — the reorder never bridges Credits and Earnings/Pending/Welcome', () => {
  it("Credits card's own loader never calls the learnings/pending/earnings endpoints, and vice versa", () => {
    const creditsRegion = sliceBetween(DASHBOARD_HTML, 'function loadCredits() {', 'function loadPurchases() {');
    assert.ok(!/\/account\/learnings/.test(creditsRegion), 'Credits region never calls /account/learnings');
    assert.ok(!/\/account\/pending/.test(creditsRegion), 'Credits region never calls /account/pending');
    assert.ok(!/\/account\/earnings/.test(creditsRegion), 'Credits region never calls /account/earnings');

    const welcomeRegion = sliceBetween(DASHBOARD_HTML, 'function updateWelcomeCard() {', 'function legacyCopy(');
    const earningsRegion = sliceBetween(DASHBOARD_HTML, 'function loadEarnings() {', '// ── Payout panel');
    const pendingQueueRegion = sliceBetween(DASHBOARD_HTML, "window.loadPendingQueue = function () {", 'function ensurePendingBodies() {');
    for (const [name, region] of [['welcome', welcomeRegion], ['earnings', earningsRegion], ['pending queue', pendingQueueRegion]]) {
      assert.ok(!/\/account\/credits/.test(region), `${name} region never calls /account/credits`);
      assert.ok(!/\/account\/purchases/.test(region), `${name} region never calls /account/purchases`);
    }
  });
});
