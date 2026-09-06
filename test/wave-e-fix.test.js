'use strict';

/**
 * test/wave-e-fix.test.js — Wave E fix pass (Gate-A findings, 2026-09-06).
 *
 * Structural, file-level guards for F1-F5 (checkable from the served bytes
 * on disk, matching the convention in test/wave-e2.test.js /
 * test/site-system.test.js) plus a live-server section for F6/F7, reusing
 * the staged-server harness already established by test/wave-e3.test.js /
 * test/legal-shell-footer.test.js.
 *
 * Findings fixed:
 *   F1. public/about.html + public/writing/index.html: orphaned inline
 *       .hamburger/.status-nav/header nav CSS deleted (it overrode the
 *       shared #main-nav .hamburger rule in styles.css by source order,
 *       hiding the nav affordance from 721-1057px).
 *   F2. public/styles.css #builders-hero item-5 rule re-scoped from
 *       `.builders-hero-stats:not(.reveal)` (both hero strips match now
 *       that Wave E3 stripped every .reveal class) to `#builders-hero
 *       .builders-hero-stats` (the top strip's own section).
 *   F3. public/how-it-works.html: the "your API key" SVG label's x moved
 *       264 -> 250 so its bbox stays inside the 300-wide viewBox once
 *       promoted to 12px font-size.
 *   F4. public/api.html, public/for-agents.html, public/for-builders.html:
 *       the inline #nav-<page>-page { color: var(--aurum) !important; }
 *       overrides are deleted so the shared .nav-links a.active rule
 *       applies; for-agents.html and for-builders.html's current-page nav
 *       links gained class="active" (they'd relied on the ID override
 *       alone and the shared rule keys only on the class).
 *   F5. public/earnings.html: #earnings-cta h2 font-size points at
 *       var(--h2-cta) instead of a hardcoded clamp.
 *   F6. server.js: /dmca and /legal/subprocessors now pass a minimal seo
 *       object (canonical + og:type + og:url + og:site_name) to
 *       serveLegalPage.
 *   F7. server.js serveLegalPage(): minimal GitHub-flavoured table
 *       support (header row + separator row + body rows -> <table>).
 *
 * Runner: node --test test/wave-e-fix.test.js
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
const PUBLIC_DIR = path.join(REPO, 'public');
const SERVER_SRC = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

function readPublic(rel) {
  return fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8');
}

function inlineStyleBlocks(html) {
  return (html.match(/<style>[\s\S]*?<\/style>/g) || []).join('\n');
}

// ═══════════════════════════════════════════════════════════════════════
// F1: about.html / writing/index.html — orphaned nav CSS removed
// ═══════════════════════════════════════════════════════════════════════

describe('Wave E fix F1: about.html and writing/index.html carry no orphaned inline nav CSS', () => {
  for (const page of ['about.html', path.join('writing', 'index.html')]) {
    it(`${page} inline <style> blocks define no .hamburger rule`, () => {
      const css = inlineStyleBlocks(readPublic(page));
      assert.doesNotMatch(css, /\.hamburger[\s,{[]/, `${page} should carry no inline .hamburger rule`);
    });

    it(`${page} inline <style> blocks define no .status-nav rule`, () => {
      const css = inlineStyleBlocks(readPublic(page));
      assert.doesNotMatch(css, /\.status-nav[\s,.{]/, `${page} should carry no inline .status-nav rule`);
    });

    it(`${page} inline <style> blocks define no header selector rule`, () => {
      const css = inlineStyleBlocks(readPublic(page));
      assert.doesNotMatch(css, /(^|[};\n])\s*header(\s|\{|\bnav\b|\ba\b)/, `${page} should carry no inline header-selector rule`);
    });

    it(`${page} still links the shared stylesheet and renders the real #main-nav/.hamburger markup`, () => {
      const html = readPublic(page);
      assert.match(html, /<link rel="stylesheet" href="\/styles\.css/);
      assert.match(html, /<nav id="main-nav" aria-label="Main navigation">/);
      assert.match(html, /class="hamburger" id="hamburger"/);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// F2: for-builders hero stat row scoping
// ═══════════════════════════════════════════════════════════════════════

describe('Wave E fix F2: for-builders hero stat rule scoped to #builders-hero, not :not(.reveal)', () => {
  const STYLES = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');

  it('the item-5 rules no longer use the :not(.reveal) scope', () => {
    assert.doesNotMatch(
      STYLES,
      /\.builders-hero-stats:not\(\.reveal\)/,
      'styles.css should no longer scope the hero-stat rules with :not(.reveal)'
    );
  });

  it('the item-5 rules are scoped to #builders-hero instead', () => {
    assert.match(
      STYLES,
      /#builders-hero \.builders-hero-stats \.builders-hero-stat \.stat-num\.pull-stat-caption\s*\{/,
      'the pull-stat-caption promotion should be scoped to #builders-hero'
    );
    assert.match(
      STYLES,
      /#builders-hero \.builders-hero-stats \.builders-hero-stat \.stat-num\s*\{\s*min-height:\s*clamp\(48px,\s*7vw,\s*88px\);/,
      'the min-height baseline rule should be scoped to #builders-hero'
    );
  });

  it('for-builders.html: the top hero strip lives inside #builders-hero and the second strip does not', () => {
    const html = readPublic('for-builders.html');
    const heroSection = html.match(/<section id="builders-hero"[\s\S]*?<\/section>/);
    assert.ok(heroSection, '#builders-hero section found');
    assert.match(heroSection[0], /class="builders-hero-stats"/, 'the top strip is inside #builders-hero');
    const secondStripIdx = html.indexOf('id="lc-unlocks"');
    const heroSectionEndIdx = html.indexOf(heroSection[0]) + heroSection[0].length;
    assert.ok(secondStripIdx > heroSectionEndIdx, 'the second (ledger) strip with lc-unlocks lives after #builders-hero closes');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// F3: how-it-works.html SVG label repositioned
// ═══════════════════════════════════════════════════════════════════════

describe('Wave E fix F3: how-it-works.html "your API key" label stays inside its 300-wide viewBox', () => {
  const HIW = readPublic('how-it-works.html');

  it('the label\'s x moved off 264 (the value that overflowed at 12px)', () => {
    assert.doesNotMatch(
      HIW,
      /x="264" y="58"[^>]*>your API key</,
      'the "your API key" text should no longer sit at x="264"'
    );
  });

  it('the label now sits at x="250", inside the 0 0 300 64 viewBox with margin at 12px font-size', () => {
    assert.match(HIW, /<text x="250" y="58"[^>]*>your API key<\/text>/);
    // Same width math the promoted font-size rule uses: chars * 0.6 * 12px,
    // text-anchor="middle" so the box straddles x. "your API key" is 12
    // characters (incl. spaces) -> ~86.4px wide, half-width ~43.2px.
    const text = 'your API key';
    const halfWidth = (text.length * 0.6 * 12) / 2;
    const x = 250;
    const viewBoxWidth = 300;
    assert.ok(x + halfWidth <= viewBoxWidth - 3, `right edge (${x + halfWidth}) should sit at least 3px inside ${viewBoxWidth}`);
    assert.ok(x - halfWidth >= 0, `left edge (${x - halfWidth}) should not go negative`);
  });

  it('the diagram still ships all 29 <text> nodes (nothing else moved)', () => {
    const count = (HIW.match(/<text /g) || []).length;
    assert.equal(count, 29);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// F4: nav accent overrides removed, shared .active rule takes over
// ═══════════════════════════════════════════════════════════════════════

describe('Wave E fix F4: #nav-<page>-page !important overrides removed; class="active" carries the accent', () => {
  // NAV-WAVE (2026-09-06): the shared #main-nav component standardized
  // every link id (no more per-page "-page" suffix) and API left the top
  // nav entirely (footer-only now), so api.html no longer has any active
  // link to check here -- that case is dropped rather than renamed.
  const CASES = [
    { file: 'for-agents.html', id: 'nav-agents' },
    { file: 'for-builders.html', id: 'nav-builders' },
  ];

  for (const { file, id } of CASES) {
    it(`${file} no longer carries an inline #${id} !important color override`, () => {
      const html = readPublic(file);
      assert.doesNotMatch(
        html,
        new RegExp(`#${id}\\s*\\{\\s*color:\\s*var\\(--aurum\\)\\s*!important`),
        `${file} should no longer inline-override #${id}`
      );
    });

    it(`${file} current-page nav link (#${id}) carries class="active"`, () => {
      const html = readPublic(file);
      const linkMatch = html.match(new RegExp(`<a href="[^"]*" id="${id}"[^>]*>`));
      assert.ok(linkMatch, `#${id} link found`);
      assert.match(linkMatch[0], /class="active"/, `#${id} should carry class="active"`);
    });
  }

  it('the shared .nav-links a.active rule still exists in styles.css (E2\'s rule this fix relies on)', () => {
    const styles = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
    assert.match(styles, /\.nav-links a\.active\s*\{\s*color:\s*var\(--ash\);\s*\}/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// F5: earnings.html closing CTA h2 on the shared token — RETIRED. earnings.html
// itself was deleted under AD strings packet 15 rev 3a (/earnings folds into
// /pricing, v97 assembly, 2026-09-06); the page and this token check no
// longer exist to test.
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// F6 (source half) + F7 (source half): server.js
// ═══════════════════════════════════════════════════════════════════════

describe('Wave E fix F6 (source): /dmca and /legal/subprocessors pass a minimal seo object', () => {
  it('/legal/subprocessors route passes { path: \'/legal/subprocessors\' } to serveLegalPage', () => {
    const m = SERVER_SRC.match(/app\.get\('\/legal\/subprocessors',[\s\S]{0,220}?\}\)\);/);
    assert.ok(m, "/legal/subprocessors route found");
    assert.match(m[0], /path:\s*'\/legal\/subprocessors'/);
    assert.doesNotMatch(m[0], /description:/, 'no description should be composed for this route');
  });

  it('/dmca route passes { path: \'/dmca\' } to serveLegalPage', () => {
    const m = SERVER_SRC.match(/app\.get\('\/dmca',[\s\S]{0,160}?\}\)\);/);
    assert.ok(m, '/dmca route found');
    assert.match(m[0], /path:\s*'\/dmca'/);
    assert.doesNotMatch(m[0], /description:/, 'no description should be composed for this route');
  });
});

describe('Wave E fix F7 (source): serveLegalPage renders GFM-lite tables', () => {
  it('serveLegalPage extracts table blocks into <table> HTML before the paragraph-wrap pass', () => {
    const start = SERVER_SRC.indexOf('function serveLegalPage(');
    const end = SERVER_SRC.indexOf('\napp.get(', start);
    const fnSrc = SERVER_SRC.slice(start, end === -1 ? undefined : end);
    assert.match(fnSrc, /<table><thead><tr>/);
    assert.match(fnSrc, /<\/thead><tbody>/);
    const tableExtractIdx = fnSrc.indexOf('protectedMd2');
    const paragraphWrapIdx = fnSrc.indexOf("replace(/^(?!<[hul])(.*\\S.*)$/gm, '<p>$1</p>')");
    assert.notEqual(tableExtractIdx, -1);
    assert.notEqual(paragraphWrapIdx, -1);
    assert.ok(tableExtractIdx < paragraphWrapIdx, 'table extraction must run before the catch-all paragraph wrap');
  });

  it('table cell text goes through the same bold/link inline formatter as paragraphs', () => {
    const start = SERVER_SRC.indexOf('function serveLegalPage(');
    const end = SERVER_SRC.indexOf('\napp.get(', start);
    const fnSrc = SERVER_SRC.slice(start, end === -1 ? undefined : end);
    assert.match(fnSrc, /const inlineMd = \(text\) => text/);
    assert.match(fnSrc, /<strong>\$1<\/strong>/);
  });

  it('table placeholders are restored alongside the code-block placeholders', () => {
    const start = SERVER_SRC.indexOf('function serveLegalPage(');
    const end = SERVER_SRC.indexOf('\napp.get(', start);
    const fnSrc = SERVER_SRC.slice(start, end === -1 ? undefined : end);
    assert.match(fnSrc, /Restore protected tables/);
    assert.match(fnSrc, /tables\[a !== undefined \? a : b\]/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// F6 (live) + F7 (live): staged-server checks
// ═══════════════════════════════════════════════════════════════════════

describe('Wave E fix F6/F7 (live): legal routes render og:site_name and real tables', { timeout: 180_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;
  let bootSkipReason = null;

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-wave-e-fix-'));
    stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['lib', 'public', 'prompts', 'config', 'docs'],
      replacements: [],
    });

    const boot = await bootServer({
      tmpDir,
      port,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        LLM_SENSITIVITY_ENABLED: 'false',
        SESSION_SECRET: 'wave-e-fix-test-session-secret-0123456789ab',
        AUXILO_DATA_DIR: path.join(tmpDir, 'data'),
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

  const LEGAL_ROUTES = ['/terms', '/privacy', '/dmca', '/legal/subprocessors', '/legal/supported-clients'];

  for (const route of LEGAL_ROUTES) {
    it(`GET ${route} renders og:site_name exactly once`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      const res = await fetch(`${baseUrl}${route}`);
      assert.equal(res.status, 200);
      const body = await res.text();
      const count = (body.match(/og:site_name/g) || []).length;
      assert.equal(count, 1, `${route} should render og:site_name exactly once`);
    });
  }

  it('GET /legal/supported-clients renders a <table> with 19 body rows and no literal | lines', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/legal/supported-clients`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<table>/);
    const m = body.match(/<table><thead>[\s\S]*?<\/thead><tbody>([\s\S]*?)<\/tbody><\/table>/);
    assert.ok(m, 'a full table with thead/tbody renders');
    const rowCount = (m[1].match(/<tr>/g) || []).length;
    assert.equal(rowCount, 19, 'the client matrix table should render exactly 19 body rows');
    const pipeLines = body.split('\n').filter((l) => l.trim().startsWith('|'));
    assert.equal(pipeLines.length, 0, 'no served line should start with a literal |');
  });

  it('GET /legal/supported-clients table cells carry emoji and rendered bold', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/legal/supported-clients`);
    const body = await res.text();
    assert.match(body, /✅/, 'emoji should survive into the rendered table');
    assert.match(body, /<td><strong>Claude Code<\/strong><\/td>/, '**bold** cell text should render as <strong>');
  });

  it('GET /privacy carries no literal |---| separator text and renders its two tables', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/privacy`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.doesNotMatch(body, /\|---\|/, '/privacy should carry no literal |---| text');
    const tableCount = (body.match(/<table>/g) || []).length;
    assert.equal(tableCount, 2, '/privacy should render its two source tables');
  });

  it('GET /terms is unchanged: still exactly 21 <hr> elements', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/terms`);
    assert.equal(res.status, 200);
    const body = await res.text();
    const hrCount = (body.match(/<hr>/g) || []).length;
    assert.equal(hrCount, 21);
  });
});
