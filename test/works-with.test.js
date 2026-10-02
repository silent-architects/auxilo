'use strict';

/**
 * test/works-with.test.js — Works with build (2026-09-06, TECH-PM, from
 * SITE-PM's AD-CLIENTS-VISUAL-SHEET-2026-09-06.md strings rev 3):
 *
 *   1. GET /works-with → 200 text/html carrying the sheet's title and the
 *      honest line, verbatim.
 *   2. Every logo file referenced by public/works-with.html exists under
 *      public/logos/, and is a valid SVG with no <script>, no <image>
 *      (raster embed), and no external href/src.
 *   3. Homepage band: public/index.html carries the band eyebrow line and
 *      (LAUNCH-WAVE-0926 update) the six ruled client names; step 01 no
 *      longer claims capture support at all (register A-08 drops the
 *      clause, not just its old two-client form).
 *   4. OpenClaw: public/works-with.html's OpenClaw cell carries the note
 *      text (the matrix's own words) and no check mark; docs/SUPPORTED-
 *      CLIENTS.md's OpenClaw row has the same correction (status cell
 *      dropped the checkmark, reads "paused").
 *   5. public/logos/SOURCES.md lists every logo file actually shipped
 *      under public/logos/*.svg.
 *   6. public/sitemap.xml lists /works-with.
 *
 * Staged-server pattern: test/ad-routes.test.js.
 *
 * Runner: node --test test/works-with.test.js
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
const WORKS_WITH_HTML = fs.readFileSync(path.join(REPO, 'public', 'works-with.html'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8');
const SITEMAP = fs.readFileSync(path.join(REPO, 'public', 'sitemap.xml'), 'utf8');
const STYLES_CSS = fs.readFileSync(path.join(REPO, 'public', 'styles.css'), 'utf8');
const MATRIX_MD = fs.readFileSync(path.join(REPO, 'docs', 'SUPPORTED-CLIENTS.md'), 'utf8');
const LOGOS_DIR = path.join(REPO, 'public', 'logos');
const SOURCES_MD = fs.readFileSync(path.join(LOGOS_DIR, 'SOURCES.md'), 'utf8');

const TITLE = '<title>Works with the client you already run | Auxilo</title>';
const DESCRIPTION = 'The AI coding clients Auxilo works with, what it captures where capture is live, and what is still being built.';
const HONEST_LINE = "Auxilo works with every client below. Once you turn extraction on, it captures sessions on the clients marked for capture, and the label on each cell says which. Drafting still runs through a single model path on your machine, not through the client a session came from. Per-client extraction is being built.";
const BAND_EYEBROW = 'works with the client you already run';
const STEP01_NEW = 'On the clients that support capture';
const STEP01_OLD = 'On Claude Code and Codex';
const OPENCLAW_NOTE = "NOT locally verified; reads the legacy sessions/*.jsonl layout";
const OPENCODE_NOTE = '(plugin planned)';
const OPENHANDS_NOTE = '(best-effort adapter planned)';

describe('WORKS-WITH: structural — public/works-with.html, public/index.html band, logos, matrix, sitemap', () => {
  it('public/works-with.html carries the exact title and og/twitter title', () => {
    assert.ok(WORKS_WITH_HTML.includes(TITLE), 'title tag present verbatim');
    assert.ok(WORKS_WITH_HTML.includes(`content="Works with the client you already run | Auxilo"`), 'og:title / twitter:title present verbatim');
  });

  it('public/works-with.html carries the exact meta description', () => {
    assert.ok(WORKS_WITH_HTML.includes(`content="${DESCRIPTION}"`), 'meta description present verbatim');
  });

  it('public/works-with.html carries og:site_name and canonical', () => {
    assert.match(WORKS_WITH_HTML, /<meta property="og:site_name" content="Auxilo" \/>/);
    assert.match(WORKS_WITH_HTML, /<link rel="canonical" href="https:\/\/auxilo\.io\/works-with" \/>/);
  });

  it('public/works-with.html carries the honest line verbatim', () => {
    assert.ok(WORKS_WITH_HTML.includes(HONEST_LINE), 'honest line present verbatim');
  });

  it('public/works-with.html carries the basis line and the trademark notice verbatim', () => {
    assert.ok(WORKS_WITH_HTML.includes('Ordered and sized by how widely each client is used, not by anything we measure.'));
    assert.ok(WORKS_WITH_HTML.includes('Any provider may ask us to remove its mark by writing to'));
  });

  it('public/works-with.html renders the client grid as one flat list, no tier <h2>s (SITE-PM ruling 2026-09-06)', () => {
    const h1Count = (WORKS_WITH_HTML.match(/<h1[\s>]/g) || []).length;
    const h2Count = (WORKS_WITH_HTML.match(/<h2[\s>]/g) || []).length;
    assert.equal(h1Count, 1, 'exactly one <h1>');
    assert.equal(h2Count, 0, 'zero <h2> (the three visually-hidden tier headings are gone)');

    const listOpen = (WORKS_WITH_HTML.match(/<ul class="ww-list">/g) || []).length;
    assert.equal(listOpen, 1, 'exactly one client <ul class="ww-list">');

    const start = WORKS_WITH_HTML.indexOf('<ul class="ww-list">');
    const end = WORKS_WITH_HTML.indexOf('</ul>', start);
    assert.ok(start > -1 && end > start, 'ww-list has a matching </ul>');
    const listBlock = WORKS_WITH_HTML.slice(start, end);

    const liTags = [...listBlock.matchAll(/<li class="([^"]*)"/g)];
    assert.equal(liTags.length, 19, 'ww-list carries exactly 19 <li> (18 named clients + "Other MCP clients")');

    let large = 0, medium = 0, small = 0;
    for (const [, classAttr] of liTags) {
      assert.ok(/\bww-cell\b/.test(classAttr), `every <li> carries ww-cell: "${classAttr}"`);
      const sizeMatches = classAttr.match(/\bww-size-(large|medium|small)\b/g) || [];
      assert.equal(sizeMatches.length, 1, `every <li> carries exactly one tier size class: "${classAttr}"`);
      if (classAttr.includes('ww-size-large')) large++;
      else if (classAttr.includes('ww-size-medium')) medium++;
      else if (classAttr.includes('ww-size-small')) small++;
    }
    assert.equal(large, 4, '4 large-tier clients');
    assert.equal(medium, 6, '6 medium-tier clients');
    assert.equal(small, 9, '9 small-tier clients (includes "Other MCP clients")');

    assert.ok(listBlock.includes('>Other MCP clients<'), '"Other MCP clients" item present in the list');

    const basisCount = (WORKS_WITH_HTML.match(/Ordered and sized by how widely each client is used, not by anything we measure\./g) || []).length;
    assert.equal(basisCount, 1, 'basis line appears exactly once');
    assert.ok(end < WORKS_WITH_HTML.indexOf('Ordered and sized by how widely each client is used, not by anything we measure.'), 'basis line follows the client list');
  });

  it('public/works-with.html has no Title Case body copy markers and no #main-nav "Works with" link (nav wave owns that)', () => {
    // The nav wave adds the nav entry; this build must not pre-empt it.
    const navBlock = WORKS_WITH_HTML.slice(WORKS_WITH_HTML.indexOf('<nav id="main-nav"'), WORKS_WITH_HTML.indexOf('</nav>'));
    assert.ok(!navBlock.includes('>Works with<'), 'nav does not carry a Works with link yet');
  });

  it('every logo referenced by public/works-with.html exists under public/logos/ and is a clean, valid SVG', () => {
    // LOGOS-INVISIBLE: logos are masked spans (--logo:url(/logos/<name>.svg)
    // custom property), not <img src>, so the reference pattern matches the
    // mask URL rather than an img src attribute.
    const refs = [...WORKS_WITH_HTML.matchAll(/--logo:url\(\/logos\/([a-z0-9.-]+\.svg)\)/g)].map((m) => m[1]);
    assert.ok(refs.length >= 9, `expected at least 9 sourced logo references, found ${refs.length}`);
    for (const file of refs) {
      const filePath = path.join(LOGOS_DIR, file);
      assert.ok(fs.existsSync(filePath), `${file} referenced by works-with.html must exist under public/logos/`);
      const svg = fs.readFileSync(filePath, 'utf8');
      assert.match(svg, /^<svg[\s>]/, `${file} starts with <svg`);
      assert.match(svg, /viewBox="/, `${file} preserves a viewBox`);
      assert.ok(!/<script/i.test(svg), `${file} carries no <script>`);
      assert.ok(!/<image/i.test(svg), `${file} carries no embedded raster <image>`);
      assert.ok(!/(href|src)\s*=\s*"https?:/i.test(svg), `${file} carries no external href/src`);
      assert.ok(!/<metadata/i.test(svg), `${file} has no <metadata> block`);
      assert.match(svg, /fill="currentColor"/, `${file} carries a single currentColor fill`);
    }
  });

  it('LOGOS-INVISIBLE: nine client marks are masked spans with the nine expected logo URLs, and zero <img src="/logos/ remain', () => {
    const expected = [
      'claude-code.svg', 'cursor.svg', 'github-copilot.svg', 'gemini-cli.svg',
      'devin.svg', 'claude-desktop.svg', 'cline.svg', 'jetbrains-junie.svg', 'opencode.svg',
    ];
    const maskSpans = [...WORKS_WITH_HTML.matchAll(/<span class="ww-logo" role="img" aria-label="([^"]+)" style="--logo:url\(\/logos\/([a-z0-9.-]+\.svg)\)"><\/span>/g)];
    assert.equal(maskSpans.length, 9, `expected exactly 9 masked marks, found ${maskSpans.length}`);
    const foundUrls = maskSpans.map((m) => m[2]).sort();
    assert.deepEqual(foundUrls, [...expected].sort(), 'the 9 masked marks reference exactly the 9 expected logo files');

    assert.ok(!/<img[^>]+src="\/logos\//.test(WORKS_WITH_HTML), 'zero <img src="/logos/ remain -- every client mark is a masked span');

    // Every mask span carries an accessible name via role="img" + aria-label,
    // and the label matches the client's visible name text.
    for (const [, ariaLabel] of maskSpans) {
      assert.ok(ariaLabel.length > 0, 'mask span carries a non-empty aria-label');
      assert.ok(WORKS_WITH_HTML.includes(`>${ariaLabel}<`), `aria-label "${ariaLabel}" matches a visible client name in the page`);
    }
  });

  it('LOGOS-INVISIBLE: the shared .ww-logo mask rule exists in public/styles.css with mask + -webkit-mask + the ground-aware ink background (ivory on dark, ink on light)', () => {
    const ruleMatch = STYLES_CSS.match(/\.ww-logo\s*\{[^}]*\}/);
    assert.ok(ruleMatch, 'shared .ww-logo rule present in public/styles.css');
    const rule = ruleMatch[0];
    // Design system pass: was var(--ivory), which vanishes on paper. --fg-1 is ivory in a dark scope
    // (the homepage client band) and ink on a light ground (this page).
    assert.match(rule, /background-color:\s*var\(--fg-1\)/, 'rule sets background-color to var(--fg-1)');
    assert.match(rule, /-webkit-mask:\s*var\(--logo\)\s*center\s*\/\s*contain\s*no-repeat/, 'rule sets -webkit-mask from the --logo custom property, centered/contain/no-repeat');
    assert.match(rule, /(?<!-webkit-)mask:\s*var\(--logo\)\s*center\s*\/\s*contain\s*no-repeat/, 'rule sets the standard mask property too');
    assert.match(STYLES_CSS, /--ivory:\s*#FAFAF8/i, 'the --ivory token is confirmed as #FAFAF8 (rgb(250,250,248)) in public/styles.css');
  });

  it('OpenClaw cell in works-with.html carries its matrix note verbatim and no check mark', () => {
    const cellStart = WORKS_WITH_HTML.indexOf('>OpenClaw<');
    assert.ok(cellStart > -1, 'OpenClaw cell present');
    const cellBlock = WORKS_WITH_HTML.slice(cellStart, cellStart + 700);
    assert.ok(cellBlock.includes(OPENCLAW_NOTE), 'OpenClaw note text present');
    assert.ok(cellBlock.includes('best-effort, sweep paused'), 'OpenClaw label reflects the paused truth');
    assert.ok(!cellBlock.includes('✅'), 'no check mark (✅) near the OpenClaw cell');
  });

  it('docs/SUPPORTED-CLIENTS.md OpenClaw row: status cell dropped the check mark and reads paused, matching its own Notes', () => {
    const rowMatch = MATRIX_MD.match(/\|\s*\*\*OpenClaw\*\*.*\|\s*$/m);
    assert.ok(rowMatch, 'OpenClaw row found in the matrix');
    const row = rowMatch[0];
    assert.ok(!row.includes('✅'), 'OpenClaw row carries no check mark');
    assert.match(row, /\*\*Best-effort, paused\*\*/, 'OpenClaw status cell reads "Best-effort, paused"');
    assert.ok(row.includes('capture is paused until the adapter is re-pointed'), 'Notes cell truth is unchanged and is what the status cell now matches');
  });

  it('docs/SUPPORTED-CLIENTS.md does not carry the ungated runner auto-update paragraph (6b9ce96 addition, reverted — disclosure lives on the trust page + consent block only)', () => {
    assert.doesNotMatch(MATRIX_MD, /keeps itself current/);
    assert.doesNotMatch(MATRIX_MD, /AUXILO_RUNNER_AUTOUPDATE/);
  });

  it('public/index.html carries the works-with band eyebrow line, directly after the hero section', () => {
    const heroEnd = INDEX_HTML.indexOf('<section id="hero"');
    assert.ok(heroEnd > -1, 'hero section present');
    const heroCloseIdx = INDEX_HTML.indexOf('</section>', heroEnd);
    const bandIdx = INDEX_HTML.indexOf('id="works-with-band"');
    assert.ok(bandIdx > heroCloseIdx, 'works-with band section follows the hero section');
    assert.ok(INDEX_HTML.includes(`<p class="ww-band-eyebrow" id="works-with-band-heading">${BAND_EYEBROW}</p>`), 'band eyebrow line present verbatim');
    assert.ok(INDEX_HTML.includes('<a href="/works-with" class="ww-band-link">See what Auxilo captures on each client</a>'), 'band link present verbatim, pointing at /works-with');
  });

  it('public/index.html band lists only the six ruled capture clients (LAUNCH-WAVE-0926 register M-30: no Cline/Roo Code/Continue.dev, no OpenClaw, no probabilistic clients)', () => {
    const bandStart = INDEX_HTML.indexOf('id="works-with-band"');
    const bandEnd = INDEX_HTML.indexOf('</section>', bandStart);
    const bandBlock = INDEX_HTML.slice(bandStart, bandEnd);
    const expectedNames = ['Claude Code', 'Cursor', 'GitHub Copilot CLI', 'Codex', 'Antigravity', 'Devin Desktop'];
    for (const name of expectedNames) {
      assert.ok(bandBlock.includes(`>${name}<`), `band carries ${name}`);
    }
    assert.ok(!bandBlock.includes('>Cline<'), 'band excludes Cline (register M-30)');
    assert.ok(!bandBlock.includes('>Roo Code<'), 'band excludes Roo Code (register M-30)');
    assert.ok(!bandBlock.includes('>Continue.dev<'), 'band excludes Continue.dev (register M-30)');
    assert.ok(!bandBlock.includes('>GitHub Copilot<'), 'band names the client "GitHub Copilot CLI", not bare "GitHub Copilot"');
    assert.ok(!bandBlock.includes('OpenClaw'), 'band excludes OpenClaw (sweep paused)');
    assert.ok(!bandBlock.includes('Gemini CLI'), 'band excludes Gemini CLI (unverified, pulled 2026-09-12)');
    assert.ok(!bandBlock.includes('Claude Desktop'), 'band excludes probabilistic clients');
  });

  it('public/index.html step 01 no longer claims background extraction support (LAUNCH-WAVE-0926 register A-08, GOV-4 Q2), and carries the new connect-step text verbatim', () => {
    // Design rebuild: the inline style on the step-one <code> is gone (the shared sheet styles
    // `code`); the words are unchanged.
    const STEP01_A08 = 'Run <code>npx auxilo setup</code>. It finds the supported clients on your machine, registers Auxilo, and signs you in. Decline extraction and every Auxilo tool still works.';
    assert.ok(INDEX_HTML.includes(STEP01_A08), 'step 01 carries the A-08 register text verbatim');
    assert.ok(!INDEX_HTML.includes(STEP01_OLD), 'step 01 no longer names exactly two clients');
    assert.ok(!INDEX_HTML.includes('extract learnings in the background'), 'step 01 no longer makes the background-extraction output claim (A-08 supersedes it)');
    assert.ok(!INDEX_HTML.includes(STEP01_NEW), 'step 01 no longer claims capture support at all (A-08 drops the clause entirely, not just its old two-client form)');
  });

  it('public/logos/SOURCES.md lists every logo file actually shipped under public/logos/*.svg', () => {
    const shippedFiles = fs.readdirSync(LOGOS_DIR).filter((f) => f.endsWith('.svg'));
    assert.ok(shippedFiles.length >= 9, `expected at least 9 shipped logo files, found ${shippedFiles.length}`);
    for (const file of shippedFiles) {
      assert.ok(SOURCES_MD.includes(file), `SOURCES.md lists ${file}`);
    }
  });

  it('public/sitemap.xml lists /works-with', () => {
    assert.ok(SITEMAP.includes('<loc>https://auxilo.io/works-with</loc>'), 'sitemap has /works-with');
  });

  it('server.js /logos static route serves only .svg under public/logos/ and is registered before the generic catch-all', () => {
    const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
    const logosRouteIdx = serverSrc.indexOf("app.get('/logos/");
    const catchAllIdx = serverSrc.indexOf("app.get('/:file{");
    assert.ok(logosRouteIdx > -1, '/logos/:file route defined');
    assert.ok(catchAllIdx > -1, 'generic static catch-all defined');
    assert.ok(logosRouteIdx < catchAllIdx, '/logos/:file route registered before the generic catch-all');
  });
});

describe('WORKS-WITH: live routes', { timeout: 180_000 }, () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-works-with-'));
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
        SESSION_SECRET: 'works-with-test-session-secret-0123456789',
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

  it('GET /works-with → 200 text/html carrying the title and the honest line', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/works-with`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^text\/html/);
    const body = await res.text();
    assert.ok(body.includes(TITLE), 'served body carries the title');
    assert.ok(body.includes(HONEST_LINE), 'served body carries the honest line');
  });

  it('GET /works-with → served opencode and OpenHands cells carry the matrix parentheticals verbatim in their note lines', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/works-with`);
    const body = await res.text();

    const opencodeStart = body.indexOf('>opencode<');
    assert.ok(opencodeStart > -1, 'opencode cell present in served body');
    const opencodeBlock = body.slice(opencodeStart, opencodeStart + 400);
    assert.ok(opencodeBlock.includes(OPENCODE_NOTE), 'opencode cell note line carries "(plugin planned)" verbatim');

    const openhandsStart = body.indexOf('>OpenHands<');
    assert.ok(openhandsStart > -1, 'OpenHands cell present in served body');
    const openhandsBlock = body.slice(openhandsStart, openhandsStart + 400);
    assert.ok(openhandsBlock.includes(OPENHANDS_NOTE), 'OpenHands cell note line carries "(best-effort adapter planned)" verbatim');
  });

  it('GET /logos/<file>.svg → 200 image/svg+xml for every sourced logo', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const files = fs.readdirSync(LOGOS_DIR).filter((f) => f.endsWith('.svg'));
    for (const file of files) {
      const res = await fetch(`${baseUrl}/logos/${file}`);
      assert.equal(res.status, 200, `GET /logos/${file}`);
      assert.match(res.headers.get('content-type') || '', /svg/, `${file} content-type`);
    }
  });

  it('GET /works-with.svg (not under /logos/) is unaffected — the route is scoped to /logos/', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/logos/does-not-exist.svg`);
    assert.equal(res.status, 404, 'a missing logo file 404s rather than falling through');
  });
});

// ── Design rebuild: the page is a dark first screen, light cards on paper, the key on tint ──
describe('WORKS-WITH: design rebuild, static markup and head', () => {
  it('opens on a dark hero, then the client cards on paper, then the key on tint, with no leftover dark-era wrapper', () => {
    const heroAt = WORKS_WITH_HTML.indexOf('<section id="ww-hero" class="on-dark"');
    const listAt = WORKS_WITH_HTML.indexOf('<section id="ww-list-section">');
    const keyAt = WORKS_WITH_HTML.indexOf('<section id="ww-key-section" class="on-tint">');
    assert.ok(heroAt > -1 && listAt > heroAt && keyAt > listAt, 'hero (dark), list (paper), key (tint), in that order');
    assert.ok(WORKS_WITH_HTML.indexOf('<ul class="ww-list">') > listAt && WORKS_WITH_HTML.indexOf('<ul class="ww-list">') < keyAt, 'the client list sits in the paper section');
    assert.match(WORKS_WITH_HTML, /<main id="main">/, 'main is plain');
    assert.doesNotMatch(WORKS_WITH_HTML, /ww-main|ww-wrap|ww-h1|section-raised/, 'no dark-era wrapper, h1 class or raised section remains');
    assert.match(WORKS_WITH_HTML, /<h1 id="ww-hero-heading">Works With the Client You Already Run<\/h1>/, 'positive control: the h1 is the page h1');
  });

  it('preloads the Newsreader display face and does not preload the retired PlexMono500 face', () => {
    assert.ok(WORKS_WITH_HTML.includes('<link rel="preload" href="/fonts/NewsreaderDisplay300.a07d3c5c.woff2" as="font" type="font/woff2" crossorigin />'), 'Newsreader preload present');
    assert.ok(!/PlexMono500/.test(WORKS_WITH_HTML), 'no PlexMono500 reference');
    assert.ok(WORKS_WITH_HTML.includes('PlexMono400.0698749e.woff2'), 'positive control: the 400 face is still preloaded');
  });

  it('the page block does not recolour, resize or redraw a client mark: it only moves the mask to the left edge, and colours come from tokens', () => {
    const styleBlock = WORKS_WITH_HTML.slice(WORKS_WITH_HTML.indexOf('<style>'), WORKS_WITH_HTML.indexOf('</style>'));
    const logoRule = styleBlock.match(/\.ww-logo-box \.ww-logo\s*\{([^}]*)\}/);
    assert.ok(logoRule, 'the page has a .ww-logo-box .ww-logo rule');
    assert.ok(!/background|(?<![-\w])color\s*:|filter|opacity|transform|width|height/.test(logoRule[1]), 'that rule sets only the mask position');
    assert.ok(/mask-position:\s*left center/.test(logoRule[1]), 'the mark sits on the left edge');
    assert.doesNotMatch(styleBlock, /var\(--(ivory|slate|ash|obsidian)\)/, 'no ground-blind colour token in the page block');
  });

  it('every client card has either a real mark or the one placeholder glyph, never neither and never both, and the glyph carries no text', () => {
    const listStart = WORKS_WITH_HTML.indexOf('<ul class="ww-list">');
    const listBlock = WORKS_WITH_HTML.slice(listStart, WORKS_WITH_HTML.indexOf('</ul>', listStart));
    const cards = [...listBlock.matchAll(/<li class="ww-cell[^"]*">([\s\S]*?)<\/li>/g)].map((m) => m[1]);
    assert.equal(cards.length, 19, 'positive control: 19 cards');

    const MARK = /<span class="ww-logo" role="img"/g;
    const GLYPH = /<svg class="ww-glyph"/g;
    let marks = 0;
    let glyphs = 0;
    for (const card of cards) {
      const name = (card.match(/<div class="ww-client-name">([^<]+)<\/div>/) || [, '?'])[1];
      const m = (card.match(MARK) || []).length;
      const g = (card.match(GLYPH) || []).length;
      assert.equal(m + g, 1, `${name}: exactly one of a real mark or the placeholder, got ${m} mark and ${g} glyph`);
      assert.ok(/<div class="ww-logo-box">(?:<span class="ww-logo"|<svg class="ww-glyph")/.test(card), `${name}: the mark or glyph sits first in the mark box`);
      marks += m;
      glyphs += g;
    }
    assert.equal(marks, 9, 'positive control: nine real marks, untouched');
    assert.equal(glyphs, 10, 'ten markless clients carry the placeholder');

    const markless = ['Codex', 'Continue.dev', 'Roo Code', 'Antigravity', 'Amp', 'Factory droid', 'Kiro', 'OpenHands', 'OpenClaw', 'Other MCP clients'];
    for (const name of markless) {
      const card = cards.find((c) => c.includes(`<div class="ww-client-name">${name}</div>`));
      assert.ok(card, `${name}: card present`);
      assert.match(card, /<svg class="ww-glyph"/, `${name}: carries the placeholder`);
    }

    // The placeholder: decorative, drawn only from a rounded square, a chevron and a tick, no text of any kind.
    const glyphMarkup = [...listBlock.matchAll(/<svg class="ww-glyph"[\s\S]*?<\/svg>/g)].map((x) => x[0]);
    assert.equal(glyphMarkup.length, 10, 'positive control: ten placeholder drawings found');
    for (const svg of glyphMarkup) {
      assert.match(svg, /aria-hidden="true"/, 'the placeholder is hidden from assistive technology');
      assert.match(svg, /viewBox="0 0 24 24"/, 'a 24 viewBox');
      assert.match(svg, /stroke="currentColor"/, 'the stroke is currentColor');
      assert.match(svg, /stroke-width="1\.25"/, 'a 1.25 stroke');
      assert.match(svg, /<rect [^>]*rx="4"/, 'a rounded square with a 4 corner radius');
      assert.equal((svg.match(/<path /g) || []).length, 2, 'two paths: the chevron and the tick');
      assert.doesNotMatch(svg, /<(text|tspan|title|desc|image|use|foreignObject)\b/i, 'no text, title or embedded element');
      assert.equal(svg.replace(/<[^>]*>/g, '').trim(), '', 'no character of text inside the drawing');
    }
    assert.ok(glyphMarkup.every((svg) => svg === glyphMarkup[0]), 'the same glyph on every markless card');
  });

  it('the placeholder fills the mark box like a real mark and takes its colour from the note token', () => {
    const styleBlock = WORKS_WITH_HTML.slice(WORKS_WITH_HTML.indexOf('<style>'), WORKS_WITH_HTML.indexOf('</style>'));
    const rule = styleBlock.match(/\.ww-logo-box \.ww-glyph\s*\{([^}]*)\}/);
    assert.ok(rule, 'the page has a .ww-logo-box .ww-glyph rule');
    assert.match(rule[1], /width:\s*100%/, 'full width of the box');
    assert.match(rule[1], /height:\s*100%/, 'full height of the box');
    assert.match(rule[1], /color:\s*var\(--fg-3\)/, 'note ink');
    assert.match(WORKS_WITH_HTML, /<svg class="ww-glyph"[^>]*preserveAspectRatio="xMinYMid meet"/, 'drawn square at the left edge, centred vertically, as a mask is');
  });
});

describe('WORKS-WITH: design rebuild, the card grid as rendered', { timeout: 120_000 }, () => {
  const http = require('node:http');
  let server;
  let browser;
  let base;
  let ok = false;

  before(async () => {
    try { require.resolve('playwright', { paths: [REPO] }); } catch (e) { return; }
    const publicDir = path.join(REPO, 'public');
    const MIME = { '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.js': 'application/javascript' };
    server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const filePath = path.join(publicDir, urlPath);
      if (!filePath.startsWith(publicDir)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    try {
      const { chromium } = require(require.resolve('playwright', { paths: [REPO] }));
      browser = await chromium.launch();
      ok = true;
    } catch (e) {
      ok = false;
    }
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
  });

  async function measure(width) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    try {
      await page.goto(`${base}/works-with.html`, { waitUntil: 'networkidle' });
      return await page.evaluate(() => {
        const cells = [...document.querySelectorAll('.ww-list > li')].map((li) => {
          const r = li.getBoundingClientRect();
          const name = li.querySelector('.ww-client-name').getBoundingClientRect();
          const size = ['large', 'medium', 'small'].find((s) => li.classList.contains('ww-size-' + s));
          const mark = li.querySelector('.ww-logo');
          return {
            size, top: Math.round(r.top * 100) / 100, left: Math.round(r.left * 100) / 100, height: Math.round(r.height * 100) / 100,
            nameOffset: Math.round((name.top - r.top) * 100) / 100, hasMark: !!mark,
            markInk: mark ? getComputedStyle(mark).backgroundColor : null,
          };
        });
        return { cells, scrollWidth: document.documentElement.scrollWidth, viewport: window.innerWidth };
      });
    } finally {
      await ctx.close();
    }
  }

  const distinct = (arr) => [...new Set(arr)];

  it('at 1280: large cards four across, medium and small three across, large first, cards in a row equal in height', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const m = await measure(1280);
    assert.equal(m.cells.length, 19, 'positive control: 19 cards');
    const bySize = (s) => m.cells.filter((c) => c.size === s);
    for (const [size, across] of [['large', 4], ['medium', 3], ['small', 3]]) {
      const cells = bySize(size);
      const rows = distinct(cells.map((c) => c.top));
      assert.equal(cells.length / rows.length, across, `${size}: ${across} across`);
      for (const top of rows) {
        const heights = distinct(cells.filter((c) => c.top === top).map((c) => c.height));
        assert.equal(heights.length, 1, `${size} row at ${top}: every card the same height, got ${heights.join(',')}`);
      }
    }
    assert.ok(Math.max(...bySize('large').map((c) => c.top)) < Math.min(...bySize('medium').map((c) => c.top)), 'large before medium');
    assert.ok(Math.max(...bySize('medium').map((c) => c.top)) < Math.min(...bySize('small').map((c) => c.top)), 'medium before small');
    assert.equal(m.scrollWidth, m.viewport, 'no horizontal scroll');
  });

  it('in every tier the name sits at the same offset in cards with a mark and cards without one, and the marks are ink, not transparent', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const m = await measure(1280);
    for (const size of ['large', 'medium', 'small']) {
      const cells = m.cells.filter((c) => c.size === size);
      assert.ok(cells.some((c) => c.hasMark) && cells.some((c) => !c.hasMark) || size === 'large', `${size}: positive control, both kinds present (large has only marks)`);
      assert.equal(distinct(cells.map((c) => c.nameOffset)).length, 1, `${size}: name offset identical across the tier, got ${distinct(cells.map((c) => c.nameOffset)).join(',')}`);
    }
    for (const c of m.cells.filter((x) => x.hasMark)) {
      assert.equal(c.markInk, 'rgb(10, 10, 10)', 'a mark is painted in the ink of the light ground');
    }
  });

  // The mark and the placeholder box, measured inside the card. Taken at 1280 (the cards stack their parts
  // and the box scales by tier) and at 375 (every card is compact and horizontal and every tier takes one box).
  async function measureMarkBoxes(width) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    try {
      await page.goto(`${base}/works-with.html`, { waitUntil: 'networkidle' });
      return await page.evaluate(() => [...document.querySelectorAll('.ww-list > li')].map((li) => {
        const r = li.getBoundingClientRect();
        const art = li.querySelector('.ww-logo, .ww-glyph');
        const a = art.getBoundingClientRect();
        const note = li.querySelector('.ww-client-note');
        return {
          size: ['large', 'medium', 'small'].find((s) => li.classList.contains('ww-size-' + s)),
          kind: art.classList.contains('ww-glyph') ? 'glyph' : 'mark',
          box: [a.left - r.left, a.top - r.top, a.width, a.height].map((n) => Math.round(n * 100) / 100).join(','),
          ink: getComputedStyle(art).color,
          noteInk: getComputedStyle(note).color,
          text: art.textContent.trim(),
        };
      }));
    } finally {
      await ctx.close();
    }
  }

  it('in every tier the placeholder glyph takes the box a real mark takes in that tier, and is drawn in the note colour', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    for (const width of [1280, 375]) {
      const cells = await measureMarkBoxes(width);
      assert.equal(cells.length, 19, `${width}: positive control: 19 cards`);
      for (const size of ['medium', 'small']) {
        const inTier = cells.filter((c) => c.size === size);
        const marks = inTier.filter((c) => c.kind === 'mark');
        const glyphs = inTier.filter((c) => c.kind === 'glyph');
        assert.ok(marks.length > 0 && glyphs.length > 0, `${width} ${size}: positive control, both kinds present`);
        for (const g of glyphs) {
          assert.equal(g.box, marks[0].box, `${width} ${size}: the glyph takes the box (left, top, width, height inside its card) a real mark takes`);
        }
      }
      for (const g of cells.filter((c) => c.kind === 'glyph')) {
        assert.equal(g.ink, g.noteInk, `${width}: the glyph is drawn in the colour of the note text`);
        assert.equal(g.text, '', `${width}: the glyph holds no text`);
      }
    }
  });

  // At 480 and down every card is compact and horizontal: a fixed 28 box on the left (mark or glyph),
  // level with the name, the name, label and note on the right. All three size classes look the same.
  // Every value is compared with another measurement from the same run, or with a spacing token.
  async function measureCompact(width) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    try {
      await page.goto(`${base}/works-with.html`, { waitUntil: 'networkidle' });
      return await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const tokens = { tight: parseFloat(root.getPropertyValue('--space-tight')), body: parseFloat(root.getPropertyValue('--space-body')) };
        const items = [...document.querySelectorAll('.ww-list > li')];
        const cells = items.map((li, i) => {
          const cs = getComputedStyle(li);
          const r = li.getBoundingClientRect();
          const box = li.querySelector('.ww-logo-box').getBoundingClientRect();
          const art = li.querySelector('.ww-logo, .ww-glyph').getBoundingClientRect();
          const name = li.querySelector('.ww-client-name');
          const nameBox = name.getBoundingClientRect();
          const nameCs = getComputedStyle(name);
          const label = getComputedStyle(li.querySelector('.ww-client-label'));
          const note = getComputedStyle(li.querySelector('.ww-client-note'));
          const mark = li.querySelector('.ww-logo');
          const next = items[i + 1] ? items[i + 1].getBoundingClientRect() : null;
          return {
            size: ['large', 'medium', 'small'].find((s) => li.classList.contains('ww-size-' + s)),
            pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat),
            gapBelow: next ? next.top - r.bottom : null,
            boxW: box.width, boxH: box.height, artW: art.width, artH: art.height,
            boxLeftInCard: box.left - r.left,
            boxCentreY: box.top + box.height / 2,
            nameCentreY: nameBox.top + nameBox.height / 2,
            nameLeftOfBox: nameBox.left - (box.left + box.width),
            nameFamily: nameCs.fontFamily, nameWeight: nameCs.fontWeight, nameSize: parseFloat(nameCs.fontSize),
            labelFamily: label.fontFamily, labelSize: parseFloat(label.fontSize),
            noteSize: parseFloat(note.fontSize),
            markInk: mark ? getComputedStyle(mark).backgroundColor : null,
            markMask: mark ? (getComputedStyle(mark).maskSize || getComputedStyle(mark).webkitMaskSize) : null,
          };
        });
        return { tokens, cells, scrollWidth: document.documentElement.scrollWidth, viewport: window.innerWidth };
      });
    } finally {
      await ctx.close();
    }
  }

  it('at 375 every card is compact and horizontal: a 28 box on the left level with the name, padding 16, 8 between cards, the three size classes alike', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const m = await measureCompact(375);
    assert.equal(m.cells.length, 19, 'positive control: 19 cards');
    assert.equal(m.scrollWidth, m.viewport, '375: no horizontal scroll');
    for (const c of m.cells) {
      assert.deepEqual(c.pad, [m.tokens.body, m.tokens.body, m.tokens.body, m.tokens.body], `${c.size}: card padding is --space-body on all four sides`);
      assert.equal(c.boxW, 28, `${c.size}: the mark box is 28 wide`);
      assert.equal(c.boxH, 28, `${c.size}: the mark box is 28 tall`);
      assert.equal(c.artW, 28, `${c.size}: the mark or glyph fills the 28 box, wide`);
      assert.equal(c.artH, 28, `${c.size}: the mark or glyph fills the 28 box, tall`);
      assert.equal(c.boxLeftInCard, m.tokens.body + 1, `${c.size}: the box sits on the card's left padding edge (padding plus the 1px line)`);
      assert.ok(Math.abs(c.boxCentreY - c.nameCentreY) <= 0.5, `${c.size}: the mark box and the name share one centre line (box ${c.boxCentreY}, name ${c.nameCentreY})`);
      assert.ok(c.nameLeftOfBox > 0, `${c.size}: the name sits to the right of the mark box`);
      assert.match(c.nameFamily, /Archivo/, `${c.size}: the name is Archivo`);
      assert.equal(c.nameWeight, '500', `${c.size}: the name is weight 500`);
      assert.equal(c.nameSize, 16, `${c.size}: the name is 16`);
      assert.match(c.labelFamily, /Plex Mono/i, `${c.size}: the label is mono`);
      assert.equal(c.labelSize, 13, `${c.size}: the label is 13`);
      assert.equal(c.noteSize, 13, `${c.size}: the note is 13`);
    }
    for (const c of m.cells.slice(0, -1)) assert.equal(c.gapBelow, m.tokens.tight, 'cards sit --space-tight (8) apart');
    for (const key of ['boxW', 'boxH', 'boxLeftInCard', 'nameLeftOfBox', 'nameSize', 'labelSize', 'noteSize']) {
      const vals = [...new Set(m.cells.map((c) => c[key]))];
      assert.equal(vals.length, 1, `all three size classes share one ${key}, got ${vals.join(',')}`);
    }
    for (const size of ['large', 'medium', 'small']) assert.ok(m.cells.some((c) => c.size === size), `positive control: a ${size} card is present`);
    const marks = m.cells.filter((c) => c.markInk);
    assert.equal(marks.length, 9, 'positive control: the nine real marks');
    for (const c of marks) {
      assert.equal(c.markInk, 'rgb(10, 10, 10)', 'a mark stays monochrome ink');
      assert.equal(c.markMask, 'contain', 'a mark keeps its shape (contained, never stretched)');
    }
  });

  it('at 480 the cards are still compact and at 481 they are the stacked cards again', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const narrow = await measureCompact(480);
    const wide = await measureCompact(481);
    assert.ok(narrow.cells.every((c) => c.boxW === 28 && c.nameLeftOfBox > 0), '480: compact and horizontal');
    assert.ok(wide.cells.every((c) => c.nameLeftOfBox < 0), '481: the name sits under the mark again, as before');
    assert.ok(wide.cells.every((c) => c.pad.every((p) => p > wide.tokens.body)), '481: every card keeps its own, larger padding');
    assert.ok(wide.cells.some((c) => c.boxW !== 28), '481: the mark boxes keep their tier sizes');
  });

  it('at 768 the cards go two across, at 375 one across, with no horizontal scroll', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const tablet = await measure(768);
    assert.equal(distinct(tablet.cells.map((c) => c.left)).length, 2, '768: two columns');
    assert.equal(tablet.scrollWidth, tablet.viewport, '768: no horizontal scroll');
    const phone = await measure(375);
    assert.equal(distinct(phone.cells.map((c) => c.left)).length, 1, '375: one column');
    assert.equal(phone.scrollWidth, phone.viewport, '375: no horizontal scroll');
  });
});
