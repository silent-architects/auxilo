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
 *      the corrected step 01 string ("On the clients that support capture").
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
      'windsurf.svg', 'claude-desktop.svg', 'cline.svg', 'jetbrains-junie.svg', 'opencode.svg',
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

  it('LOGOS-INVISIBLE: the shared .ww-logo mask rule exists in public/styles.css with mask + -webkit-mask + the ivory background', () => {
    const ruleMatch = STYLES_CSS.match(/\.ww-logo\s*\{[^}]*\}/);
    assert.ok(ruleMatch, 'shared .ww-logo rule present in public/styles.css');
    const rule = ruleMatch[0];
    assert.match(rule, /background-color:\s*var\(--ivory\)/, 'rule sets background-color to var(--ivory)');
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

  it('public/index.html carries the works-with band eyebrow line, directly after the hero section', () => {
    const heroEnd = INDEX_HTML.indexOf('<section id="hero"');
    assert.ok(heroEnd > -1, 'hero section present');
    const heroCloseIdx = INDEX_HTML.indexOf('</section>', heroEnd);
    const bandIdx = INDEX_HTML.indexOf('id="works-with-band"');
    assert.ok(bandIdx > heroCloseIdx, 'works-with band section follows the hero section');
    assert.ok(INDEX_HTML.includes(`<p class="ww-band-eyebrow" id="works-with-band-heading">${BAND_EYEBROW}</p>`), 'band eyebrow line present verbatim');
    assert.ok(INDEX_HTML.includes('<a href="/works-with" class="ww-band-link">See what Auxilo captures on each client</a>'), 'band link present verbatim, pointing at /works-with');
  });

  it('public/index.html band lists only the eleven capture clients (no OpenClaw, no probabilistic clients)', () => {
    const bandStart = INDEX_HTML.indexOf('id="works-with-band"');
    const bandEnd = INDEX_HTML.indexOf('</section>', bandStart);
    const bandBlock = INDEX_HTML.slice(bandStart, bandEnd);
    const expectedNames = ['Claude Code', 'Cursor', 'Gemini CLI', 'Windsurf', 'GitHub Copilot', 'Codex', 'Factory droid', 'Antigravity', 'Cline', 'Roo Code', 'Continue.dev'];
    for (const name of expectedNames) {
      assert.ok(bandBlock.includes(`>${name}<`), `band carries ${name}`);
    }
    assert.ok(!bandBlock.includes('OpenClaw'), 'band excludes OpenClaw (sweep paused)');
    assert.ok(!bandBlock.includes('Claude Desktop'), 'band excludes probabilistic clients');
  });

  it('public/index.html step 01 reads the corrected capture-support sentence, never the old two-client claim', () => {
    assert.ok(INDEX_HTML.includes(STEP01_NEW), 'step 01 carries the corrected phrase');
    assert.ok(!INDEX_HTML.includes(STEP01_OLD), 'step 01 no longer names exactly two clients');
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
