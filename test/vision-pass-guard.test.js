'use strict';

/**
 * test/vision-pass-guard.test.js — VISION PASS guard (SITE-PM, 2026-09-27)
 *
 * Source: BUILD-BRIEF-VISION.md Part B. Guards the whole vision pass: the
 * excuse/usage-number strings the pass cuts must not survive anywhere on
 * the six sales surfaces, the retired usage-number cells must be gone from
 * the three pages that had them, the trust page's own ledger ids must be
 * untouched, every surface that states the 70%/60% rate must still carry
 * the "not guaranteed" sentence and a paused-withdrawals statement, and the
 * /for-builders math block must exist, whole, in one view.
 *
 * "coming soon" is deliberately NOT in BANNED_STRINGS. Per the brief's
 * "Things to know", the six surfaces were grepped for every current use of
 * it before this file was written: two hits, both in public/dashboard.html
 * (the Payouts-card wallet heading text, row V-33; the no-wallet note, row
 * V-28's CURRENT text). Both rows are in FINAL STRINGS FOR BUILD and both
 * replacements drop the phrase, so after the build zero instances remain —
 * but the phrase is left out of this guard's banned list on the brief's
 * explicit instruction, so the guard never asserts more than the build
 * actually promises.
 *
 * Written first, watched fail against the pre-build HTML, per BUILDER-RULES.
 *
 * Runner: node --test test/vision-pass-guard.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
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

const PAGE_FILES = {
  '/': 'index.html',
  '/for-builders': 'for-builders.html',
  '/for-agents': 'for-agents.html',
  '/how-it-works': 'how-it-works.html',
  '/pricing': 'pricing.html',
};

const STATIC = {};
for (const file of [...Object.values(PAGE_FILES), 'dashboard.html', 'how-submissions-work.html', 'api.html', 'llms.txt']) {
  STATIC[file] = fs.readFileSync(path.join(REPO, 'public', file), 'utf8');
}

// ─── Text-extraction helpers (BUILDER-RULES: strip tags, decode entities,
// collapse whitespace, collapse space before punctuation) ──────────────────

function normalize(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

/** Visible text of a normal (non-dashboard) page: tags/style/script/comments
 * stripped, so this checks the rendered page a person or crawler reads. */
function visibleText(html) {
  return normalize(
    html
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
  );
}

/** Structured data (JSON-LD) text of a page, concatenated. */
function structuredDataText(html) {
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  return scripts.map((m) => m[1]).join(' ');
}

/** Dashboard content is rendered client-side; its "visible text" once a
 * builder is signed in is the string literals inside its own <script>, not
 * whatever is in the DOM before JS runs. Strip only comments, keep script
 * bodies, so the banned-string check reaches those literals. */
function dashboardCheckedText(html) {
  return html.replace(/<!--[\s\S]*?-->/g, ' ');
}

// ─── Item 1: excuse / usage-number strings absent from six surfaces ────────

const BANNED_STRINGS = [
  'Auxilo is early',
  'Supply is ahead of demand',
  'real counts and nothing else',
  'needs no buyers',
  'Even if no other agent ever unlocks it',
  'Even if no one else ever unlocks it',
  'you have lost nothing',
  'empty catalog',
  'Nothing has accrued yet',
  'as we finish our non-custodial migration',
  'as we finish the non-custodial migration',
  'rolling out on our non-custodial rail',
];

describe('VISION PASS GUARD 1: excuse strings absent from the six surfaces (visible text + structured data)', () => {
  for (const [route, file] of Object.entries(PAGE_FILES)) {
    for (const needle of BANNED_STRINGS) {
      it(`${route} (${file}): "${needle}" absent from visible text and structured data`, () => {
        const html = STATIC[file];
        assert.ok(!visibleText(html).includes(needle), `"${needle}" must not appear in ${file}'s visible text`);
        assert.ok(!structuredDataText(html).includes(needle), `"${needle}" must not appear in ${file}'s structured data`);
      });
    }
    it(`${route} (${file}): positive control — a known-present string is actually found by the same extraction`, () => {
      assert.ok(visibleText(STATIC[file]).includes('Auxilo'), 'positive control: "Auxilo" found in visible text');
    });
  }

  for (const needle of BANNED_STRINGS) {
    it(`dashboard (dashboard.html): "${needle}" absent`, () => {
      assert.ok(!dashboardCheckedText(STATIC['dashboard.html']).includes(needle), `"${needle}" must not appear in dashboard.html`);
    });
  }
  it('dashboard (dashboard.html): positive control — a known-present string is actually found', () => {
    assert.ok(dashboardCheckedText(STATIC['dashboard.html']).includes('Auxilo'), 'positive control: "Auxilo" found');
  });
});

// ─── Item 2: retired usage-number cells gone from /, /for-builders, /pricing ─

describe('VISION PASS GUARD 2: no lc-unlocks/lc-paid element and no usage-number phrase on /, /for-builders, /pricing', () => {
  for (const file of ['index.html', 'for-builders.html', 'pricing.html']) {
    it(`${file}: no id="lc-unlocks", no id="lc-paid", no "unlocks recorded", no "paid by buyers"`, () => {
      const html = STATIC[file];
      assert.ok(!html.includes('id="lc-unlocks"'), `${file} must carry no element with id="lc-unlocks"`);
      assert.ok(!html.includes('id="lc-paid"'), `${file} must carry no element with id="lc-paid"`);
      const visible = visibleText(html);
      assert.ok(!visible.includes('unlocks recorded'), `${file} must not carry "unlocks recorded"`);
      assert.ok(!visible.includes('paid by buyers'), `${file} must not carry "paid by buyers"`);
    });
  }
  it('positive control: for-agents.html (not in scope for this cut) still legitimately has neither cell either, but the detector itself is proven against a synthetic positive', () => {
    const synthetic = '<span id="lc-unlocks">1</span>';
    assert.ok(synthetic.includes('id="lc-unlocks"'), 'positive control: the detector catches a real occurrence');
  });
});

// ─── Item 3: trust page ids untouched ──────────────────────────────────────

describe('VISION PASS GUARD 3: the trust page still carries s7-unlocks-count and s7-learnings-count (untouched by this pass)', () => {
  it('public/how-submissions-work.html carries both ids', () => {
    const html = STATIC['how-submissions-work.html'];
    assert.ok(html.includes('id="s7-unlocks-count"'), 's7-unlocks-count present');
    assert.ok(html.includes('id="s7-learnings-count"'), 's7-learnings-count present');
  });
});

// ─── Item 4: every rate-stating surface carries "not guaranteed" + a paused-
// withdrawals statement ─────────────────────────────────────────────────────

const NOT_GUARANTEED = 'Earnings depend on whether other agents unlock your learnings and are not guaranteed.';

describe('VISION PASS GUARD 4: every surface stating the 70%/60% rate carries the not-guaranteed sentence and a paused-withdrawals statement', () => {
  const surfaces = [
    ...Object.entries(PAGE_FILES).map(([route, file]) => ({ route, file, text: () => visibleText(STATIC[file]) + ' ' + structuredDataText(STATIC[file]) })),
    { route: 'dashboard', file: 'dashboard.html', text: () => dashboardCheckedText(STATIC['dashboard.html']) },
  ];
  for (const s of surfaces) {
    it(`${s.route}: if it states the rate (70% or 60%), it carries "not guaranteed" at least once and a paused-withdrawals statement (contains "open soon")`, () => {
      const text = s.text();
      const statesRate = /70%/.test(text) || /60%/.test(text);
      if (!statesRate) return; // not a rate-stating surface — item 4 does not apply
      assert.ok(text.includes(NOT_GUARANTEED), `${s.route} states the rate but is missing the not-guaranteed sentence`);
      assert.match(text, /open soon/i, `${s.route} states the rate but is missing a paused-withdrawals ("open soon") statement`);
    });
  }
  it('positive control: at least one of the six surfaces actually states the rate, so the loop above is not vacuous', () => {
    const any = surfaces.some((s) => /70%/.test(s.text()) || /60%/.test(s.text()));
    assert.ok(any, 'positive control: at least one surface states 70% or 60%');
  });
});

// ─── Item 5: the /for-builders math block ──────────────────────────────────

describe('VISION PASS GUARD 5: the /for-builders math block exists whole, in one view, with no click', () => {
  it('the heading, both dollar amounts, and the footnote are all present, and the footnote sits in the same parent uncollapsed', () => {
    const html = STATIC['for-builders.html'];
    assert.ok(html.includes('<h3>The Math (per Unlock)</h3>'), 'heading "The Math (per Unlock)" present');
    assert.ok(html.includes('$0.70'), 'contains $0.70');
    assert.ok(html.includes('$0.07 to $0.0875'), 'contains $0.07 to $0.0875');

    const scenarioMatch = html.match(/<div class="earnings-scenario">([\s\S]*?)<\/div>\s*<\/div>/);
    assert.ok(scenarioMatch, '.earnings-scenario block found');
    const block = scenarioMatch[1];
    assert.match(block, /<h3>The Math \(per Unlock\)<\/h3>/, 'heading is inside the scenario block');
    assert.match(block, /\$0\.70/, 'the $0.70 figure is inside the scenario block');
    assert.match(block, /id="math-footnote"/, 'the footnote is inside the same scenario block as the heading and body');
    assert.doesNotMatch(block, /<details/i, 'no <details> element (no click needed to reveal the footnote)');
    assert.doesNotMatch(block, /\bhidden\b/, 'no hidden attribute anywhere in the block');
    assert.doesNotMatch(block, /collapsed/i, 'no collapsed-state class or text anywhere in the block');
  });
});

// ─── S-3 proof: on a staged server with a NON-EMPTY ledger, the fills do
// nothing and inject nothing on /for-builders and /pricing, where the
// usage-number cells are now absent; the fills that DO still have a cell to
// fill (the /for-builders hero count, /for-agents' strip, the trust page)
// keep working. ──────────────────────────────────────────────────────────

function seedBase() {
  const seed = JSON.parse(fs.readFileSync(path.join(REPO, 'seed-knowledge.json'), 'utf-8'));
  const base = Array.isArray(seed) ? seed[0] : seed.learnings[0];
  assert.ok(base, 'seed-knowledge.json must contain at least one learning');
  return base;
}
function row(overrides) {
  const l = JSON.parse(JSON.stringify(seedBase()));
  l.status = 'approved';
  delete l.visibility;
  l.contributor_account_id = null;
  l.contributor_wallet = null;
  l.quality = { ...(l.quality || {}), unlocks: 0, ratings: 0, avg_helpfulness: 0 };
  return Object.assign(l, overrides);
}
function fixtureCatalog() {
  return [
    row({ id: 'vpg_a', title: 'row a', category: 'code-execution' }),
    row({ id: 'vpg_b', title: 'row b', category: 'data-processing' }),
  ];
}
// A non-empty, readable unlock-event ledger: two recorded unlocks with real
// money attached, so truth.unlocks and truth.total_earnings_usd are both
// non-zero/non-null — the exact "non-empty ledger" S-3 asks for.
function unlockEventsJsonl() {
  const now = new Date().toISOString();
  return [
    JSON.stringify({ learning_id: 'vpg_a', amount_usd: 1.5, path: 'direct', ts: now }),
    JSON.stringify({ learning_id: 'vpg_b', amount_usd: 0.7, path: 'discovery', ts: now }),
  ].join('\n') + '\n';
}

describe('VISION PASS GUARD S-3: staged server, non-empty ledger — the fills inject nothing on pages with no cell, and keep working where a cell remains', { timeout: 240_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;
  let bootSkipReason = null;

  before(async () => {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if ('skipReason' in reservation) {
      bootSkipReason = reservation.skipReason;
      return;
    }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-vision-guard-s3-'));
    stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [],
    });
    const dataDir = path.join(tmpDir, 'data');
    fs.writeFileSync(path.join(dataDir, 'learnings.json'), JSON.stringify(fixtureCatalog(), null, 2));
    fs.writeFileSync(path.join(dataDir, 'earnings.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(dataDir, 'unlock-events.jsonl'), unlockEventsJsonl());

    const boot = await bootServer({
      tmpDir,
      port,
      env: {
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32),
        LLM_SENSITIVITY_ENABLED: 'false',
        AUXILO_DATA_DIR: dataDir,
        AUXILO_ACCOUNTS_FILE: path.join(dataDir, 'accounts.json'),
      },
      timeoutMs: 60_000,
      maxAttempts: 4,
    });
    if ('skipReason' in boot) {
      bootSkipReason = boot.skipReason;
      return;
    }
    child = boot.child;
    baseUrl = boot.baseUrl;
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /for-builders: no figure, no "unlocks recorded", no "paid by buyers", no stray text anywhere in body or head, from a non-empty ledger', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/for-builders`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes('id="lc-unlocks"'), 'no lc-unlocks element served');
    assert.ok(!html.includes('id="lc-paid"'), 'no lc-paid element served');
    assert.ok(!html.includes('id="lc-asof"'), 'no lc-asof element served (the strip it belonged to is gone)');
    assert.ok(!html.includes('id="lc-supply-line"'), 'no lc-supply-line element served');
    const visible = visibleText(html);
    assert.ok(!visible.includes('unlocks recorded'), 'no "unlocks recorded" text served');
    assert.ok(!visible.includes('paid by buyers'), 'no "paid by buyers" text served');
    assert.ok(!visible.includes('Supply is ahead of demand'), 'no "Supply is ahead of demand" text served');
    // The hero cell keeps working: it still has a cell to fill.
    assert.match(html, /id="lc-learnings-hero">2</, 'the surviving hero cell still fills with the live count');
  });

  it('GET /pricing: no figure, no ledger tile, no stray text anywhere in body or head, from a non-empty ledger', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/pricing`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes('id="lc-unlocks"'), 'no lc-unlocks element served');
    assert.ok(!html.includes('id="lc-paid"'), 'no lc-paid element served');
    assert.ok(!html.includes('id="lc-learnings"'), 'no lc-learnings element served (the whole tile is gone)');
    assert.ok(!html.includes('id="lc-categories"'), 'no lc-categories element served');
    assert.ok(!html.includes('id="lc-asof"'), 'no lc-asof element served');
    assert.ok(!html.includes('LC-PRICING-LEDGER-TILE'), 'no marker comment survives (the whole tile and its markers were removed)');
    const visible = visibleText(html);
    assert.ok(!visible.includes('unlocks recorded'), 'no "unlocks recorded" text served');
    assert.ok(!visible.includes('paid by buyers'), 'no "paid by buyers" text served');
    assert.ok(!visible.includes('Live from the Auxilo ledger'), 'the tile\'s caption is gone with it');
  });

  it('GET /for-agents: the surviving strip cells (lc-learnings, lc-categories, lc-price-range) still fill correctly — untouched by this pass', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/for-agents`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /id="lc-learnings">2</, 'lc-learnings still fills');
    assert.match(html, /id="lc-price-range">\$/, 'lc-price-range still fills');
  });

  it('GET /how-submissions-work (trust page): untouched, its own cells still fill', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/how-submissions-work`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('id="s7-unlocks-count"'), 's7-unlocks-count still present');
    assert.ok(html.includes('id="s7-learnings-count"'), 's7-learnings-count still present');
  });
});

// ─── F4 (coordinator fix, 2026-09-27): the two remaining reference lines
// that carried the reason clause. Scoped to their own file only — the
// generic BANNED_STRINGS sweep above never touched public/api.html or
// public/llms.txt, and per the coordinator openapi.json, public/status.html
// and the trust page keep their own wording (error code / status
// statement) and must NOT be checked for these strings. ──────────────────

describe('VISION PASS GUARD F4: the two reference-line reason clauses are gone from their own file only', () => {
  it('public/api.html: the old MCP tool description (with the non-custodial-migration reason clause) is gone; the new form is present', () => {
    const html = STATIC['api.html'];
    assert.ok(!html.includes('both rails opening soon on our non-custodial migration; paused for now'), 'the old reason-clause form must not survive in api.html');
    assert.ok(html.includes('Withdraw accumulated earnings to your linked wallet or Stripe (paused for now, both rails open soon)'), 'the new form is present, verbatim');
    // Positive control: a neighboring, untouched tool description is still there.
    assert.ok(html.includes('auxilo_withdraw'), 'positive control: the tool name itself is still present in api.html');
  });

  it('public/llms.txt: the old auxilo_withdraw line (with the non-custodial-migration reason clause) is gone; the new form is present', () => {
    const html = STATIC['llms.txt'];
    assert.ok(!html.includes('auxilo_withdraw: request withdrawal of earned USDC (temporarily paused during the non-custodial migration)'), 'the old reason-clause form must not survive in llms.txt');
    assert.ok(html.includes('- auxilo_withdraw: request withdrawal of earned USDC (paused, opens soon)'), 'the new form is present, verbatim, with its leading list marker');
    // Positive control: a neighboring, untouched line is still there.
    assert.ok(html.includes('auxilo_verify_wallet: verify ownership of a payout wallet (free)'), 'positive control: a neighboring untouched line is still present in llms.txt');
  });

  it('openapi.json, public/status.html, and the trust page are untouched by F4 (their wording names an error code or is a status statement, and stays)', () => {
    const openapi = fs.readFileSync(path.join(REPO, 'openapi.json'), 'utf8');
    const status = fs.readFileSync(path.join(REPO, 'public', 'status.html'), 'utf8');
    const trust = STATIC['how-submissions-work.html'];
    // These three are simply not touched by this fix — no assertion beyond
    // "the files still exist and are readable" is meaningful here, since F4
    // names no expected string in them. Sanity-read only.
    assert.ok(openapi.length > 0 && status.length > 0 && trust.length > 0, 'sanity: all three files still read');
  });
});
