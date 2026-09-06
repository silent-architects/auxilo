'use strict';

/**
 * test/wave-e3.test.js — Wave E3 builder verification (2026-09-06).
 *
 * SITE-PM's final wave sheet (FINAL-WAVE-SHEET-2026-09-06.md) markup items
 * 2, 3, 4, 6, 7, 16, built against pm/integ-g tip 2785dbe:
 *
 *   2. /api unlock envelopes (search + unlock response blocks): a
 *      max-height + fade + keyboard-operable expand control, page-scoped
 *      CSS/JS in api.html's own <style>/<script> (no shared styles.css
 *      edit — that file is a parallel builder's).
 *   3. /about and /writing/index.html moved off the legacy zero-height
 *      #status-nav onto the shared #main-nav; /terms, /privacy and
 *      /legal/supported-clients gained the same #main-nav through the
 *      legal shell (serveLegalPage in server.js).
 *   4. /terms and /privacy: the legal shell now emits <hr> for a markdown
 *      line that is exactly "---", instead of a literal "<p>---</p>".
 *   6. PlexMono500 preload added to /, /how-it-works, /pricing, /api (the
 *      four pages Lighthouse named as missing it; /for-agents and
 *      /for-builders already had it).
 *   7. The DR-4 reveal failsafe (head <script> + setInterval watchdog),
 *      the scroll-reveal IntersectionObserver initializers, and every
 *      `class="reveal"` / reveal-in-a-class-list attribute removed from
 *      /, /for-agents, /for-builders, /pricing, /api. (earnings.html and
 *      how-it-works.html still carry reveal code — out of scope for this
 *      wave, named but not built; see the delivery report.)
 *  16. public/og-image.png was NOT regenerated — no available renderer
 *      (rsvg-convert, qlmanage, sips; no sharp/@resvg/resvg-js in
 *      node_modules) could load public/fonts/ArchivoVariable.*.woff2 in
 *      the real Archivo face, and shipping a fallback-face render is
 *      explicitly prohibited by the build sheet. No file-level assertion
 *      here since nothing changed; the reason is in the delivery report.
 *
 * Legal-shell live checks (item 3's three server-rendered routes, item 4's
 * <hr> rendering) reuse the staged-server harness already established by
 * test/legal-shell-footer.test.js — same boot, same graceful skip under a
 * sandbox that denies loopback bind.
 *
 * Runner: node --test test/wave-e3.test.js
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

// ═══════════════════════════════════════════════════════════════════════
// Item 6: PlexMono500 preload
// ═══════════════════════════════════════════════════════════════════════

describe('WAVE-E3 item 6: PlexMono500 preload on the four Lighthouse-named pages', () => {
  const PAGES = ['index.html', 'how-it-works.html', 'pricing.html', 'api.html'];
  const LINK = '<link rel="preload" href="/fonts/PlexMono500.0ecb6352.woff2" as="font" type="font/woff2" crossorigin />';

  for (const page of PAGES) {
    it(`${page} preloads PlexMono500 exactly once`, () => {
      const html = readPublic(page);
      const count = html.split(LINK).length - 1;
      assert.equal(count, 1, `expected exactly one PlexMono500 preload link in ${page}, found ${count}`);
    });

    it(`${page} still preloads ArchivoVariable and PlexMono400 (unchanged)`, () => {
      const html = readPublic(page);
      assert.match(html, /PlexMono500\.0ecb6352\.woff2/);
      assert.match(html, /ArchivoVariable\.1b4d984f\.woff2/);
      assert.match(html, /PlexMono400\.0698749e\.woff2/);
    });
  }

  it('for-agents.html and for-builders.html already carried the preload (untouched, sanity check)', () => {
    for (const page of ['for-agents.html', 'for-builders.html']) {
      const html = readPublic(page);
      assert.match(html, /PlexMono500\.0ecb6352\.woff2/, `${page} should still preload PlexMono500`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Item 7: reveal system removal
// ═══════════════════════════════════════════════════════════════════════

describe('WAVE-E3 item 7: reveal system code removed from the seven named pages', () => {
  // Wave E4 extended this list: earnings.html (retired, packet 15
  // rev 3a — folded into /pricing, v97 assembly) and how-it-works.html had
  // the reveal system (and how-it-works.html's dead leftover observer)
  // removed the same way the original five pages were in wave E3.
  const PAGES = ['index.html', 'for-agents.html', 'for-builders.html', 'pricing.html', 'api.html', 'how-it-works.html'];

  for (const page of PAGES) {
    it(`${page} carries no class="reveal" / reveal-in-class-list attribute`, () => {
      const html = readPublic(page);
      assert.doesNotMatch(html, /class="[^"]*\breveal\b[^"]*"/, `${page} still has a class carrying "reveal"`);
    });

    it(`${page} carries no js-reveal / DR-4 watchdog / IntersectionObserver reveal code`, () => {
      const html = readPublic(page);
      assert.doesNotMatch(html, /js-reveal/, `${page} still references js-reveal`);
      assert.doesNotMatch(html, /DR-4/, `${page} still carries the DR-4 comment block`);
      assert.doesNotMatch(html, /IntersectionObserver/, `${page} still constructs an IntersectionObserver`);
      assert.doesNotMatch(html, /querySelectorAll\('\.reveal/, `${page} still queries .reveal elements`);
    });
  }

  it('how-it-works.html carries zero "reveal" substring occurrences (Wave E4; earnings.html retired under packet 15)', () => {
    const howItWorks = readPublic('how-it-works.html');
    assert.doesNotMatch(howItWorks, /reveal/, 'how-it-works.html should carry no "reveal" substring at all');
  });

  it('the shared styles.css .reveal rule is untouched (CSS builder\'s file, not this wave\'s)', () => {
    const css = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
    assert.match(css, /\.reveal\s*\{\s*transition:\s*opacity[^}]*\}/, 'styles.css should still carry the now-inert .reveal rule for the PM to strip after merge');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Item 2: /api unlock envelope expand control
// ═══════════════════════════════════════════════════════════════════════

describe('WAVE-E3 item 2: /api response envelopes have a keyboard-operable expand control', () => {
  const API_HTML = readPublic('api.html');

  it('both envelope blocks (search + unlock) carry the code-block--envelope class', () => {
    assert.match(API_HTML, /<div class="code-block code-block--envelope" id="search-snippet">/);
    assert.match(API_HTML, /<div class="code-block code-block--envelope" id="unlock-snippet">/);
  });

  it('both expand controls are real <button> elements with aria-expanded + aria-controls', () => {
    const searchBtn = API_HTML.match(/<button type="button" class="code-block-expand" id="search-expand"[^>]*>/);
    const unlockBtn = API_HTML.match(/<button type="button" class="code-block-expand" id="unlock-expand"[^>]*>/);
    assert.ok(searchBtn, 'search-expand button not found');
    assert.ok(unlockBtn, 'unlock-expand button not found');
    for (const tag of [searchBtn[0], unlockBtn[0]]) {
      assert.match(tag, /aria-expanded="false"/);
      assert.match(tag, /aria-controls="(search|unlock)-scroll"/);
    }
  });

  it('the expand buttons wire to toggleEnvelope(), a real function defined in api.html', () => {
    assert.match(API_HTML, /onclick="toggleEnvelope\('search-scroll','search-expand'\)"/);
    assert.match(API_HTML, /onclick="toggleEnvelope\('unlock-scroll','unlock-expand'\)"/);
    assert.match(API_HTML, /function toggleEnvelope\(scrollId, btnId\)/);
  });

  it('toggleEnvelope flips aria-expanded and toggles the is-expanded class (no separate reveal system)', () => {
    const fnStart = API_HTML.indexOf('function toggleEnvelope(scrollId, btnId)');
    assert.notEqual(fnStart, -1);
    const fnBody = API_HTML.slice(fnStart, fnStart + 700);
    assert.match(fnBody, /aria-expanded/);
    assert.match(fnBody, /is-expanded/);
  });

  it('CSS for the envelope collapse/fade/expand lives in api.html\'s own <style> block, not styles.css', () => {
    assert.match(API_HTML, /\.code-block--envelope \.code-block-scroll \{/);
    assert.match(API_HTML, /max-height:\s*360px/);
    const css = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
    assert.doesNotMatch(css, /code-block--envelope/, 'styles.css must not gain envelope rules — that file belongs to the CSS builder');
  });

  it('the expand button carries the real SITE-PM copy for its accessible name (collapsed state in the static markup)', () => {
    // Wave E4: SITE-PM supplied real strings replacing the placeholder
    // "Toggle navigation" aria-label — "Show the full response" when
    // collapsed (the initial markup state) and "Show less of the response"
    // when expanded (set by the script at runtime).
    const matches = API_HTML.match(/id="(search|unlock)-expand"[^>]*aria-label="Show the full response"/g) || [];
    assert.equal(matches.length, 2, 'both expand buttons should carry the collapsed-state aria-label in their static markup');
  });

  it('toggleEnvelope() switches the aria-label between the collapsed and expanded strings', () => {
    const fnStart = API_HTML.indexOf('function toggleEnvelope(scrollId, btnId)');
    assert.notEqual(fnStart, -1);
    const fnBody = API_HTML.slice(fnStart, fnStart + 500);
    assert.match(fnBody, /Show the full response/);
    assert.match(fnBody, /Show less of the response/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Item 3 (static half): /about and /writing/index.html on #main-nav
// ═══════════════════════════════════════════════════════════════════════

describe('WAVE-E3 item 3: /about and /writing/index.html moved onto the shared #main-nav', () => {
  for (const page of ['about.html', path.join('writing', 'index.html')]) {
    it(`${page} carries <nav id="main-nav"> with the shared .nav-links list`, () => {
      const html = readPublic(page);
      assert.match(html, /<nav id="main-nav" aria-label="Main navigation">/);
      assert.match(html, /<ul class="nav-links" role="list">/);
      assert.match(html, /class="hamburger" id="hamburger"/);
    });

    it(`${page} no longer carries the legacy #status-nav`, () => {
      const html = readPublic(page);
      assert.doesNotMatch(html, /id="status-nav"/);
      assert.doesNotMatch(html, /class="status-nav"/);
    });

    it(`${page}'s hamburger script targets .nav-links / #hamburger (the shared pattern), not #status-nav`, () => {
      const html = readPublic(page);
      assert.match(html, /document\.querySelector\('\.nav-links'\)/);
      assert.doesNotMatch(html, /getElementById\('status-nav'\)/);
    });
  }

  it('about.html and writing/index.html carry no orphaned legacy nav CSS (Wave E fix, F1)', () => {
    // Superseded by the Wave E fix pass: the dead .status-nav/.hamburger/
    // header rules named above (once left in place deliberately, "dead now
    // that the markup moved") were found to actually override the shared
    // #main-nav .hamburger rule in styles.css by source order, hiding the
    // nav affordance from 721-1057px. F1 deleted them; see
    // test/wave-e-fix.test.js for the full assertion.
    for (const page of ['about.html', path.join('writing', 'index.html')]) {
      const html = readPublic(page);
      const styleBlocks = (html.match(/<style>[\s\S]*?<\/style>/g) || []).join('\n');
      assert.doesNotMatch(styleBlocks, /\.status-nav\s*\{/, `${page}'s <style> block should no longer define .status-nav`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Item 3 (static half) + item 4: legal shell source (server.js)
// ═══════════════════════════════════════════════════════════════════════

describe('WAVE-E3 items 3+4: legal shell (serveLegalPage) source carries the nav and the <hr> rule', () => {
  it('serveLegalPage emits the shared #main-nav markup', () => {
    const start = SERVER_SRC.indexOf('function serveLegalPage(');
    assert.notEqual(start, -1);
    const end = SERVER_SRC.indexOf('\napp.get(', start);
    const fnSrc = SERVER_SRC.slice(start, end === -1 ? undefined : end);
    assert.match(fnSrc, /<nav id="main-nav" aria-label="Main navigation">/);
    assert.match(fnSrc, /<ul class="nav-links" role="list">/);
    assert.match(fnSrc, /class="hamburger" id="hamburger"/);
    assert.match(fnSrc, /function toggleNav\(\)/);
  });

  it('serveLegalPage converts a bare "---" line to <hr>, ahead of the paragraph-wrap rule', () => {
    const start = SERVER_SRC.indexOf('function serveLegalPage(');
    const hrIdx = SERVER_SRC.indexOf(".replace(/^---$/gm, '<hr>')", start);
    const pIdx = SERVER_SRC.indexOf('.replace(/^(?!<[hul])(.*\\S.*)$/gm', start);
    assert.notEqual(hrIdx, -1, 'serveLegalPage should replace a bare --- line with <hr>');
    assert.notEqual(pIdx, -1, 'serveLegalPage should still have its catch-all paragraph-wrap rule');
    assert.ok(hrIdx < pIdx, 'the --- -> <hr> rule must run before the catch-all paragraph wrap');
  });

  it('the source markdown docs are untouched (34 total --- rule lines, matching the AD count)', () => {
    const terms = fs.readFileSync(path.join(REPO, 'docs', 'TERMS-OF-SERVICE.md'), 'utf8');
    const privacy = fs.readFileSync(path.join(REPO, 'docs', 'PRIVACY-POLICY.md'), 'utf8');
    const count = (md) => (md.match(/^---$/gm) || []).length;
    assert.equal(count(terms), 21, 'TERMS-OF-SERVICE.md should still have 21 --- rule lines (source untouched)');
    assert.equal(count(privacy), 13, 'PRIVACY-POLICY.md should still have 13 --- rule lines (source untouched)');
    assert.equal(count(terms) + count(privacy), 34, 'combined --- count should match the AD sheet\'s 34');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Items 3 + 4 (live half): /terms, /privacy, /legal/supported-clients
// ═══════════════════════════════════════════════════════════════════════

describe('WAVE-E3 items 3+4 (live): legal routes render the nav and no literal --- paragraphs', { timeout: 180_000 }, () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-wave-e3-'));
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
        SESSION_SECRET: 'wave-e3-test-session-secret-0123456789ab',
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

  for (const route of ['/terms', '/privacy', '/legal/supported-clients']) {
    it(`GET ${route} renders <nav id="main-nav"> with .nav-links`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      const res = await fetch(`${baseUrl}${route}`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /<nav id="main-nav" aria-label="Main navigation">/);
      assert.match(body, /<ul class="nav-links" role="list">/);
    });
  }

  for (const route of ['/terms', '/privacy']) {
    it(`GET ${route} carries no literal "---" paragraph and at least one <hr>`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      const res = await fetch(`${baseUrl}${route}`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.doesNotMatch(body, /<p>---<\/p>/, `${route} should not render a literal --- paragraph`);
      const hrCount = (body.match(/<hr>/g) || []).length;
      assert.ok(hrCount > 0, `${route} should render at least one <hr> in place of a markdown rule`);
    });
  }

  it('GET /terms renders exactly 21 <hr> elements (matches the source doc\'s --- count)', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/terms`);
    const body = await res.text();
    const hrCount = (body.match(/<hr>/g) || []).length;
    assert.equal(hrCount, 21);
  });

  it('GET /privacy renders exactly 13 <hr> elements (matches the source doc\'s --- count)', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/privacy`);
    const body = await res.text();
    const hrCount = (body.match(/<hr>/g) || []).length;
    assert.equal(hrCount, 13);
  });

  it('GET /legal/supported-clients carries the TRUST-PAGE-WHAT-RUNS-WHERE-RIDER-2026-09-06.md rev 2e extractor paragraph (both stages, published 0.9.13) and drops "on your own subscription"', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/legal/supported-clients`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Today the runner drafts learnings for every client it captures through the first model client you are signed in to on your machine, Claude Code first and then Codex\. Without one, captured sessions are held and nothing is submitted\. Or set a provider key of your own with auxilo provider set\. It stays on your machine and Auxilo never receives it\. Per-client model paths are being built\./);
    assert.doesNotMatch(body, /on your own subscription/);
  });

  it('GET /legal/supported-clients step 4 ("Local extraction") carries the rev 2e provider-order sentence', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/legal/supported-clients`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Local extraction<\/strong>\s*:\s*the first model client you are signed in to on your machine, Claude Code first and then Codex, or a provider key you set yourself, drafts learnings from the scrubbed text\./);
  });
});
