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
const STYLES_CSS = fs.readFileSync(path.join(REPO, 'public', 'styles.css'), 'utf8');
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

async function startDashboardFixture(t, seed) {
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

    // Optional seed (FIX-UNIT M2's private-learning fixture): written BEFORE
    // boot, since the server loads these files into memory at startup and a
    // post-boot fs.writeFileSync is never picked up. Defaults reproduce the
    // pre-existing empty-state behavior every other test in this file relies on.
    fs.writeFileSync(path.join(dataDir, 'learnings.json'), JSON.stringify((seed && seed.learnings) || [], null, 2));
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify((seed && seed.accounts) || {}, null, 2));
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
      // FIX-UNIT A5b: every .dash-card-title is now an <h2> (was a <div>).
      // The class is unchanged, so these markers are updated to the new
      // element name per BUILDER-RULES.
      '<h2 class="dash-card-title">Earnings</h2>',
      '<h2 class="dash-card-title">Payouts</h2>',
      '<h2 class="dash-card-title">Auto-publish clean learnings</h2>',
      '<h2 class="dash-card-title">API Keys</h2>',
      // credits-as-cash C-38/C-46: "Credits" -> "Balance", "Credit Purchase
      // History" -> "Purchase History" (one balance, in dollars).
      '<h2 class="dash-card-title">Balance</h2>',
      '<h2 class="dash-card-title">Purchase History</h2>',
    ];
    const positions = indexOfAll(DASHBOARD_HTML, markers);
    for (let i = 1; i < positions.length; i += 1) {
      assert.ok(positions[i] > positions[i - 1], `${markers[i]} must follow ${markers[i - 1]}`);
    }
    // Exactly one Pending Review Queue card in the file (the old location was removed).
    assert.strictEqual(
      (DASHBOARD_HTML.match(/<h2 class="dash-card-title">Pending Review Queue/g) || []).length,
      1,
      'exactly one Pending Review Queue card remains -- the old location must be gone, not duplicated',
    );
  });

  it('the summary bar sits directly under the header, above the alert area and every card', () => {
    // FIX-UNIT A5b: .dash-title is now an <h1> (was a <div>); text/class unchanged.
    const [headerCloseIdx] = indexOfAll(DASHBOARD_HTML, ['<h1 class="dash-title">Account Dashboard</h1>']);
    const summaryIdx = DASHBOARD_HTML.indexOf('id="dash-summary-bar"');
    const alertIdx = DASHBOARD_HTML.indexOf('id="dash-alert"');
    const termsIdx = DASHBOARD_HTML.indexOf('id="terms-gate"');
    assert.ok(headerCloseIdx < summaryIdx, 'summary bar follows the header');
    assert.ok(summaryIdx < alertIdx, 'summary bar precedes the global alert');
    assert.ok(alertIdx < termsIdx, 'summary bar (and alert) precede every card');
  });
});

// ─── FIX-UNIT L11: summary bar never starts with a stray separator ─────────
//
// REVIEW-CODE-SECURITY.md L11: the " · " separator lived as static leading
// text inside the pending/earnings segment spans. If the Published segment
// (the first one, loaded by loadWelcomeCard()) failed to load while a later
// segment succeeded, the bar rendered " · Pending review N" -- a stray
// leading separator. Fix: each separator is its own hidden span
// (summary-pending-sep / summary-earnings-sep), shown only when a segment
// earlier in the fixed order is already visible.

describe('FIX-UNIT L11: summary bar never starts with a stray separator', () => {
  it('the markup gives the 2nd and 3rd segments their own separator span, hidden by default, ahead of the segment it separates', () => {
    const bar = sliceBetween(DASHBOARD_HTML, 'id="dash-summary-bar"', '<!-- Global alert -->');
    const order = indexOfAll(bar, [
      'id="summary-published"',
      'id="summary-pending-sep"',
      'id="summary-pending"',
      'id="summary-earnings-sep"',
      'id="summary-earnings"',
    ]);
    for (let i = 1; i < order.length; i += 1) {
      assert.ok(order[i] > order[i - 1], 'summary bar elements must appear in fixed order');
    }
    assert.match(bar, /<span id="summary-pending-sep" style="display:none"> · <\/span>/, 'pending separator ships hidden');
    assert.match(bar, /<span id="summary-earnings-sep" style="display:none"> · <\/span>/, 'earnings separator ships hidden');
    // The old bug: a separator baked as static leading text inside the
    // segment span itself, so it could render before the segment's own
    // figure had ever loaded successfully.
    assert.ok(!/id="summary-pending" style="display:none"> ·/.test(bar), 'the pending segment must not carry its own baked-in leading separator');
    assert.ok(!/id="summary-earnings" style="display:none"> ·/.test(bar), 'the earnings segment must not carry its own baked-in leading separator');
  });

  it("updateSummarySeparators()'s algorithm matches a standalone mirror across every load-order combination, including the bug's exact repro (first segment fails, a later one loads)", () => {
    // Mirror of public/dashboard.html's updateSummarySeparators().
    function mirrorSeparators(visibility) {
      const order = ['published', 'pending', 'earnings'];
      let seenVisible = false;
      const seps = {};
      for (let i = 0; i < order.length; i += 1) {
        const visible = !!visibility[order[i]];
        if (i > 0) seps[order[i]] = visible && seenVisible;
        if (visible) seenVisible = true;
      }
      return seps;
    }

    // The exact bug this fixes: the first segment (published) never loads,
    // a later one does -- its separator must stay hidden (no stray leading " · ").
    assert.deepEqual(mirrorSeparators({ published: false, pending: true, earnings: false }), { pending: false, earnings: false });
    assert.deepEqual(mirrorSeparators({ published: false, pending: false, earnings: true }), { pending: false, earnings: false });
    // All three load -- both separators show.
    assert.deepEqual(mirrorSeparators({ published: true, pending: true, earnings: true }), { pending: true, earnings: true });
    // First and last load, middle fails -- earnings still gets a separator (something visible precedes it).
    assert.deepEqual(mirrorSeparators({ published: true, pending: false, earnings: true }), { pending: false, earnings: true });
    // Only the first loads -- no separator needed at all.
    assert.deepEqual(mirrorSeparators({ published: true, pending: false, earnings: false }), { pending: false, earnings: false });

    const fn = sliceBetween(DASHBOARD_HTML, 'function updateSummarySeparators() {', 'function setSummarySegment(');
    assert.match(fn, /var seenVisible = false;/, 'source tracks whether an earlier segment has been seen visible');
    assert.match(fn, /sep\.style\.display = \(visible && seenVisible\) \? '' : 'none';/, 'source shows a separator only when its own segment is visible AND an earlier one already is');

    const setSummarySegmentFn = sliceBetween(DASHBOARD_HTML, 'function setSummarySegment(wrapId, figureId, text) {', '\n  }');
    assert.match(setSummarySegmentFn, /updateSummarySeparators\(\);/, 'setSummarySegment must recompute separators every time a segment is shown');
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
    assert.ok(DASHBOARD_HTML.includes("label: 'Your earnings to date'"), 'D-70 label present, exact');
  });
});

// ─── 5. D-31 disclaimer exactly once ───────────────────────────────────────

describe('LW3: Earnings card D-31 disclaimer', () => {
  it('contains the not-guaranteed sentence exactly once', () => {
    const sentence = 'Earnings depend on whether other agents unlock your learnings and are not guaranteed.';
    assert.strictEqual((DASHBOARD_HTML.match(new RegExp(sentence.replace(/[.]/g, '\\.'), 'g')) || []).length, 1, 'D-31 appears exactly once');
  });

  it('D-30 (real zeros are stated) is present and the $0.00 grid items are unconditional (VISION PASS row V-26 cut the "Nothing has accrued yet." excuse; the rest of the sentence stands alone)', () => {
    assert.ok(!DASHBOARD_HTML.includes('Nothing has accrued yet. When another agent unlocks'), 'V-26: the old excuse-prefixed sentence must not survive');
    assert.ok(DASHBOARD_HTML.includes(
      'id="earnings-empty-note" style="display:none;font-size:13px;color:var(--slate);margin-top:16px;line-height:1.6">When another agent unlocks one of your published learnings, your earnings accrue and show here.<',
    ), 'D-30, V-26: the note now opens directly on "When another agent unlocks..."');
    const renderEarningsFn = sliceBetween(DASHBOARD_HTML, 'function renderEarnings(data) {', '// ── Payout panel');
    // REGISTER-B2-REV2.md ruling: "The $0.00 cells stay" -- the four-item grid
    // is NOT replaced by the empty state (a deviation from BUILD-SPEC-W3's
    // placeholder renderEarnings() sample, which proposed short-circuiting to
    // a single line; the register is the copy authority here and is explicit
    // that real zeros are stated alongside the note, not instead of it).
    assert.ok(renderEarningsFn.includes("label: 'Your earnings (accrued)'"), 'the accrued-share cell is unconditional');
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
    assert.ok(fn.includes('Your earnings accrue to your Auxilo account and remain payable to you under the Terms. When withdrawals open, your payout options appear here.'), 'D-41 replacement body');
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

// ─── FIX-UNIT A3: notification checkbox help text is associated ───────────
//
// REVIEW-ACCESSIBILITY.md #3: #unlock-email-toggle's clarifying <p> was a
// plain sibling with no id/aria-describedby link. Fix: the <p> gets an id
// and the checkbox points at it.

describe('FIX-UNIT A3: notification checkbox help text is associated via aria-describedby', () => {
  it('#unlock-email-help exists on the clarifying paragraph and #unlock-email-toggle points at it', () => {
    assert.match(DASHBOARD_HTML, /<p id="unlock-email-help"[^>]*>Get an email when another agent unlocks one of your learnings\. Sign-in and account emails still arrive when this is off\.<\/p>/, 'the help text keeps its exact wording and gains an id');
    assert.match(DASHBOARD_HTML, /<input type="checkbox" id="unlock-email-toggle" aria-describedby="unlock-email-help"/, 'the checkbox references the help text by id');
  });
});

// ─── FIX-UNIT A2: dashboard alert areas announce errors ────────────────────
//
// REVIEW-ACCESSIBILITY.md #2: #dash-alert and its siblings carried neither
// role="alert"/role="status" nor aria-live, so showAlert()'s text was never
// announced to a screen reader. Fix: role="alert" on all five.

describe('FIX-UNIT A2: dashboard alert areas get role="alert"', () => {
  it('all five alert containers carry role="alert"', () => {
    const alertIds = ['login-alert', 'dash-alert', 'terms-gate-alert', 'pending-alert', 'clean-lane-alert'];
    assert.ok(alertIds.length === 5, 'sanity: 5 alert ids expected');
    for (const id of alertIds) {
      const re = new RegExp(`<div id="${id}" class="alert" role="alert"`);
      assert.match(DASHBOARD_HTML, re, `#${id} must carry role="alert"`);
    }
  });
});

// ─── FIX-UNIT A5b: dashboard card titles are real headings ─────────────────
//
// REVIEW-ACCESSIBILITY.md #5b: every .dash-card-title shipped as a <div>,
// so a screen-reader user could not jump between cards by heading
// navigation, and the signed-in view had no <h1>. Fix: every
// .dash-card-title becomes an <h2> (class kept, text unchanged), and the
// signed-in page title becomes an <h1>.

describe('FIX-UNIT A5b: dashboard card titles are headings', () => {
  it('every .dash-card-title is an <h2>, with the class kept and no <div class="dash-card-title"> left', () => {
    const count = (DASHBOARD_HTML.match(/<h2 class="dash-card-title">/g) || []).length;
    assert.equal(count, 10, 'expected 10 dash-card-title headings (terms gate, welcome A, welcome B, pending, earnings, payouts, auto-publish, api keys, credits, purchase history)');
    assert.ok(!/<div class="dash-card-title">/.test(DASHBOARD_HTML), 'no dash-card-title div should remain');
  });

  it('the signed-in dashboard has an <h1> page title ("Account Dashboard")', () => {
    assert.match(DASHBOARD_HTML, /<h1 class="dash-title">Account Dashboard<\/h1>/);
  });

  it('.dash-title and .dash-card-title reset their new heading-level default margins so they still look identical to the old div', () => {
    const titleRule = sliceBetween(DASHBOARD_HTML, '.dash-title {', '.dash-email {');
    assert.match(titleRule, /margin:\s*0;/, '.dash-title must reset the default h1 margin');
    const cardTitleRule = sliceBetween(DASHBOARD_HTML, '.dash-card-title {', '/* ── Earnings grid');
    assert.match(cardTitleRule, /margin-top:\s*0;/, '.dash-card-title must reset the default h2 top margin');
    // Design pass: card title to content is 24 -- this 8 plus the card's own 16 stack gap.
    assert.match(cardTitleRule, /margin-bottom:\s*8px;/, '.dash-card-title carries the 8px that, with the 16px card stack gap, makes title to content 24');
  });

  it('heading order, signed-out view (#login-view): exactly one <h1>, no <h2>-<h6>', () => {
    const view = sliceBetween(DASHBOARD_HTML, '<div id="login-view"', '<!-- ── Dashboard view');
    const headings = [...view.matchAll(/<h([1-6])[^>]*>/g)].map((m) => Number(m[1]));
    assert.deepEqual(headings, [1], 'signed-out view must have exactly one heading, an h1, and nothing deeper');
  });

  it('heading order, signed-in view (#dash-view): exactly one <h1> followed only by <h2>s, no skipped level, in DOM order', () => {
    const view = sliceBetween(DASHBOARD_HTML, '<div id="dash-view"', '<!-- AD sheet 9 / packet 3 rev 2: site footer link row');
    const headings = [...view.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({
      level: Number(m[1]),
      text: m[2].replace(/<[^>]*>/g, '').trim(),
    }));
    assert.ok(headings.length > 1, 'sanity: expected more than one heading in the signed-in view');
    assert.equal(headings.filter((h) => h.level === 1).length, 1, 'exactly one h1 in the signed-in view');
    assert.equal(headings[0].level, 1, 'the first heading must be the h1 (page title)');
    for (let i = 1; i < headings.length; i += 1) {
      assert.equal(headings[i].level, 2, `heading #${i} ("${headings[i].text}") must be an h2 -- no h3+ used, no skipped level`);
    }
    // Confirms the DOM order this fix ships, in the reader's own words.
    assert.deepEqual(headings.map((h) => `h${h.level}: ${h.text}`), [
      'h1: Account Dashboard',
      'h2: Accept the Terms',
      'h2: Start Here',
      'h2: Your Learnings Are Waiting',
      'h2: Pending Review Queue 0',
      'h2: Earnings',
      'h2: Payouts',
      'h2: Auto-publish clean learnings',
      'h2: API Keys',
      'h2: Balance',
      'h2: Purchase History',
      // R3-11: the Terms dialog now sits as a body-level sibling of
      // #dash-view (never inside it), so everything else while the
      // background is inert stays reachable and correctly excluded --
      // its own title heading lands here, textually after the view closes,
      // not among #dash-view's own cards.
      'h2: Terms of Service',
    ]);
  });
});

// ─── FIX-UNIT A6+L8 (dashboard half): 44px touch targets ───────────────────
//
// REVIEW-ACCESSIBILITY.md #6/L8: the welcome-card link (116x24), the
// Refresh button (76x28), and the notification checkbox's label row were
// under the site's own 44px intent. Fix: min-height:44px + inline-flex
// alignment on each, so the text does not move.

describe('FIX-UNIT A6+L8: dashboard 44px touch targets', () => {
  it('.hero-cta-link (the welcome-card "See How It Works" link) carries min-height:44px, inline-flex, centered', () => {
    // .hero-cta-link is defined once, in the shared stylesheet, and reused
    // here (dashboard.html) and on the homepage hero.
    const sharedRule = sliceBetween(STYLES_CSS, '.hero-cta-link {', '}');
    assert.match(sharedRule, /display:\s*inline-flex;/);
    assert.match(sharedRule, /align-items:\s*center;/);
    assert.match(sharedRule, /min-height:\s*44px;/);
    assert.ok(DASHBOARD_HTML.includes('class="hero-cta-link"'), 'sanity: dashboard.html still consumes this shared class');
  });

  it('#pending-refresh-btn (the Pending Review Queue "Refresh" button) has its own scoped 44px rule, and no other .btn-sm instance is touched', () => {
    assert.match(DASHBOARD_HTML, /<button class="btn btn-ghost btn-sm" id="pending-refresh-btn" onclick="loadPendingQueue\(\)"/, 'the button gains an id to target it specifically');
    const rule = sliceBetween(DASHBOARD_HTML, '#pending-refresh-btn {', '}');
    assert.match(rule, /display:\s*inline-flex;/);
    assert.match(rule, /align-items:\s*center;/);
    assert.match(rule, /min-height:\s*44px;/);
    // Sign out / Turn off / I've reviewed these -- not named in the brief -- keep plain .btn-sm, no id, no override.
    assert.ok(!/<button class="btn btn-ghost btn-sm" onclick="signOut\(\)"[^>]*id=/.test(DASHBOARD_HTML), 'Sign out must not have gained an id/override');
  });

  it('the notification checkbox\'s label row carries min-height:44px', () => {
    const label = sliceBetween(DASHBOARD_HTML, '<div id="unlock-email-setting"', '<span>Unlock emails</span>');
    assert.match(label, /min-height:44px;/, 'the label row (checkbox + "Unlock emails" text) must reach 44px');
    assert.match(label, /display:flex;align-items:flex-start;/, 'alignment is unchanged (flex-start, matching the checkbox\'s own top offset) so the text does not move');
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

// ─── 9. (retired) ───────────────────────────────────────────────────────────
// LW3 "the Credits card's markup is byte-identical to origin/main" retired
// (2026-09-27): pins a state the product no longer has -- the Credits card
// it protected was rebuilt on purpose into the Balance card, and origin/main
// itself now carries that rebuild.

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

// ─── FIX-UNIT M2: private learnings must not count as "Published" ──────────
//
// REVIEW-CODE-SECURITY.md M2: the dashboard's published-count call used
// status=approved with no visibility filter, and a learning kept private is
// also status: 'approved' (server.js resolves visibility on recall/private
// submissions to 'private' while leaving status 'approved'). A builder whose
// only learning was kept private therefore saw "Published 1" and never saw
// the welcome card, even though the card's own copy says private items are
// "never published". Fix: loadWelcomeCard() now calls
// /account/learnings?status=approved&visibility=public&limit=1.

describe('FIX-UNIT M2: dashboard published-count excludes private learnings', () => {
  it("loadWelcomeCard() source calls the endpoint with visibility=public", () => {
    const fn = sliceBetween(DASHBOARD_HTML, 'function loadWelcomeCard() {', 'window.copyDashSetupCode');
    assert.match(
      fn,
      /apiFetch\('\/account\/learnings\?status=approved&visibility=public&limit=1'\)/,
      'loadWelcomeCard must request visibility=public so private learnings are excluded from the Published figure',
    );
  });

  it('a private-only account gets total: 0 from the dashboard\'s own (visibility=public) call, though the old status-only call would have miscounted it as 1', async (t) => {
    // Seeded BEFORE boot (see startDashboardFixture's seed param) -- the
    // server loads learnings.json/accounts.json into memory at startup, so
    // writing them after the fixture is already running is never observed.
    const fixture = await startDashboardFixture(t, {
      accounts: {
        acc_priv: { id: 'acc_priv', email: 'priv@example.com', created_at: new Date().toISOString(), api_keys: [] },
      },
      learnings: [{
        id: 'L_PRIV',
        title: 'kept private',
        body: 'body text',
        category: 'code-execution',
        tags: [],
        status: 'approved',
        visibility: 'private',
        contributor_account_id: 'acc_priv',
        quality: { unlocks: 0 },
        created_at: new Date().toISOString(),
      }],
    });
    if (!fixture) return;
    const token = await sessionToken('acc_priv', 'priv@example.com');

    const withoutVisibilityFilter = await fetchJson(`${fixture.baseUrl}/account/learnings?status=approved&limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(withoutVisibilityFilter.status, 200);
    assert.equal(withoutVisibilityFilter.body.total, 1, 'sanity control: the private learning is status=approved, so the pre-fix call would have counted it as Published');

    const dashboardCall = await fetchJson(`${fixture.baseUrl}/account/learnings?status=approved&visibility=public&limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(dashboardCall.status, 200);
    assert.equal(dashboardCall.body.total, 0, 'Published must read 0 for an account whose only learning is private');
    assert.deepEqual(dashboardCall.body.learnings, []);
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

// ─── Design pass: grounds, head and the look hooks ──────────────────────────
//
// The dashboard was rebuilt to the new look without a script change: a dark
// sign-in screen, a dark header band over a tint body of white cards. These
// pin the static facts the look hangs on (the head, the grounds, the order of
// the wrappers). Behaviour and strings are pinned by the tests above.

describe('Design pass: dashboard head, grounds and style hooks', () => {
  const styleBlock = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf('<style>'), DASHBOARD_HTML.indexOf('</style>'));

  it('preloads the Newsreader display face once and never the retired Plex Mono 500 (positive control: the 400 face is still preloaded)', () => {
    const link = '<link rel="preload" href="/fonts/NewsreaderDisplay300.a07d3c5c.woff2" as="font" type="font/woff2" crossorigin />';
    assert.equal(DASHBOARD_HTML.split(link).length - 1, 1, 'one Newsreader preload');
    assert.ok(!DASHBOARD_HTML.includes('PlexMono500'), 'the retired weight 500 face is not named');
    assert.ok(DASHBOARD_HTML.includes('PlexMono400.0698749e.woff2'), 'positive control: the 400 face is still preloaded');
  });

  it('the sign-in screen is a dark ground with the form in a 400 column wrapper', () => {
    assert.match(DASHBOARD_HTML, /<div id="login-view" class="on-dark" style="display:none">\s*<div class="login-col">/);
    assert.match(styleBlock, /\.login-col\s*\{[^}]*max-width:\s*400px;/, 'the column is 400 wide');
  });

  it('the signed-in view is a dark header band, then the tint body, with the title in the band and every card in the body', () => {
    const view = sliceBetween(DASHBOARD_HTML, '<div id="dash-view"', '<!-- AD sheet 9 / packet 3 rev 2: site footer link row');
    const band = view.indexOf('class="dash-band on-dark"');
    const body = view.indexOf('class="dash-body on-tint"');
    const title = view.indexOf('<h1 class="dash-title">');
    const firstCard = view.indexOf('class="dash-card"');
    const gate = view.indexOf('id="terms-gate"');
    assert.ok(band > -1 && body > band, 'the band comes first, the body after it');
    assert.ok(title > band && title < body, 'the page title sits in the band');
    assert.ok(gate > body && firstCard > body, 'every card sits in the tint body');
  });

  it('the page block carries no uppercase label, no animation and no gold left border (positive control: it does carry the card rule)', () => {
    assert.match(styleBlock, /\.dash-card\s*\{/, 'positive control: the card rule is in the page block');
    assert.ok(!/text-transform:\s*uppercase/.test(styleBlock), 'no uppercase label');
    assert.ok(!/@keyframes|animation:/.test(styleBlock), 'the spinner is a still ring: motion belongs to the drawings');
    assert.ok(!/border-left:\s*[23]px/.test(styleBlock), 'no coloured left border');
  });
});
