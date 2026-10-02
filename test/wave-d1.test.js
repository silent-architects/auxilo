'use strict';

/**
 * test/wave-d1.test.js — Wave D1 builder verification (2026-09-06).
 *
 * Two AD sheets, one branch:
 *   1. AD-TYPE-PAIRING-2026-09-06.md — Archivo (sans) + IBM Plex Mono (mono),
 *      self-hosted, replacing the Google Fonts Inter + JetBrains Mono load.
 *   2. AD-DESIGN-TELLS-SWEEP-2026-09-06.md — remove the "AI web slop" tells
 *      (eyebrows, hairline section dividers, scroll-reveal gating, icon
 *      glyphs used as list/step markers, decorative hero texture/glow, CTA
 *      arrows) sitewide.
 *
 * Both sheets were audited against an older sha and undercounted their own
 * scope (several instances existed on pages/sections the sheets never
 * sampled — earnings.html in particular was omitted from nearly every tell
 * in the sweep's own audit). This file's assertions are re-derived against
 * the CURRENT tip across every public page, not copied from the sheets'
 * stale line numbers.
 *
 * Wave D1 FIX PASS (2026-09-06, Gate-A FAIL remediation): the wave failed
 * review on one blocker + five should-fix findings. The final describe
 * block below (WAVE-D1 fix pass) covers three of those structurally —
 * the fingerprinted-font immutable-cache route, the CSP no longer
 * allowing fonts.googleapis.com/fonts.gstatic.com, and for-agents.html
 * carrying no ungated .reveal opacity rule. The font-filename and
 * @font-face assertions above were also updated in the fix pass to match
 * the now-content-hashed filenames (see the HASH-aware matchers).
 *
 * Purely structural / file-level: every assertion is checkable from the
 * served bytes on disk, no live server needed (same convention as
 * test/site-system.test.js). The fix pass's cache-header claim was also
 * hand-verified live (PORT=4179 node server.js + curl -I) — see the
 * delivery report; that live check is not repeated here as a standing
 * test to keep this file boot-free.
 *
 * Runner: node --test test/wave-d1.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildContentSecurityPolicy } = require('../lib/analytics.js');

const REPO_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const STYLES_PATH = path.join(PUBLIC_DIR, 'styles.css');
const STYLES = fs.readFileSync(STYLES_PATH, 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');

// Every public page this wave touched. public/writing/index.html (the /writing
// hub) is a real, separate, footer-bearing page distinct from
// public/writing-agents-message-board.html (the essay) — both are in scope.
const ALL_PAGES = [
  'about.html',
  'api.html',
  'dashboard.html',
  'for-agents.html',
  'for-builders.html',
  'how-it-works.html',
  'index.html',
  'pricing.html',
  'status.html',
  'writing-agents-message-board.html',
  path.join('writing', 'index.html'),
];

// The pages the AD-TYPE-PAIRING sheet names explicitly for the font
// preload swap (earnings.html retired under packet 15, v97 assembly;
// about.html and writing/index.html carried the same Google Fonts pattern
// but were not named by the sheet — fixed anyway, tracked separately below
// since they're a builder-found gap, not a sheet item).
const PAIRING_SHEET_PAGES = [
  'api.html',
  'dashboard.html',
  'for-agents.html',
  'for-builders.html',
  'how-it-works.html',
  'index.html',
  'pricing.html',
  'status.html',
];

// Gap-fill pages: same Google-Fonts-link + hardcoded-face pattern, not named
// by the pairing sheet's page list, fixed for sitewide consistency.
const GAP_FILL_FONT_PAGES = ['about.html', path.join('writing', 'index.html')];

function readPage(relPath) {
  return fs.readFileSync(path.join(PUBLIC_DIR, relPath), 'utf8');
}

// ═══════════════════════════════════════════════════════════════════════
// Sheet 1: AD type pairing
// ═══════════════════════════════════════════════════════════════════════

describe('WAVE-D1 type pairing: tokens + @font-face', () => {
  it('--sans and --mono are each defined exactly once in styles.css, in :root', () => {
    const sansDefs = [...STYLES.matchAll(/^\s*--sans:/gm)];
    const monoDefs = [...STYLES.matchAll(/^\s*--mono:/gm)];
    assert.equal(sansDefs.length, 1, `--sans should be defined exactly once, found ${sansDefs.length}`);
    assert.equal(monoDefs.length, 1, `--mono should be defined exactly once, found ${monoDefs.length}`);
  });

  it('--sans resolves to Archivo and --mono resolves to IBM Plex Mono', () => {
    const sansLine = STYLES.match(/--sans:\s*([^;]+);/);
    const monoLine = STYLES.match(/--mono:\s*([^;]+);/);
    assert.ok(sansLine, '--sans token exists');
    assert.ok(monoLine, '--mono token exists');
    assert.match(sansLine[1], /^'Archivo'/, `--sans should start with 'Archivo', got: ${sansLine[1]}`);
    assert.match(monoLine[1], /^'IBM Plex Mono'/, `--mono should start with 'IBM Plex Mono', got: ${monoLine[1]}`);
    // Geist / Geist Mono must not survive anywhere in the fallback stacks —
    // the pairing sheet explicitly kills the generator-default tell.
    assert.doesNotMatch(sansLine[1], /Geist/);
    assert.doesNotMatch(monoLine[1], /Geist/);
  });

  // Wave D1 fix pass (F3, 2026-09-06): the three font files now ship
  // content-hashed (an 8-hex-char sha256 short-sum inserted before the
  // extension, e.g. ArchivoVariable.cfd841fc.woff2) so server.js can cache
  // them immutably for a year — a byte change forces a new URL. Matchers
  // below are hash-agnostic ([0-9a-f]{8}) so a legitimate future re-hash
  // (the font bytes changing) doesn't require touching this test.
  const HASH = '[0-9a-f]{8}';

  it('four real-font @font-face rules exist (Archivo core and Archivo Ext, both variable 400-600, IBM Plex Mono 400, Newsreader 300), each on a content-hashed woff2 URL, plus three size-adjust fallback faces; the Plex Mono 500 face is retired', () => {
    const faceBlocks = [...STYLES.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
    // Wave E2 item 11: two synthetic local()-only fallback faces
    // ('Archivo Fallback', 'IBM Plex Mono Fallback') were added alongside
    // the original three, each carrying a size-adjust metric override —
    // 5 total, not 3. The three real-font assertions below are unchanged.
    // Design system pass: Newsreader (display, weight 300) and its fallback join; the Plex Mono 500
    // face leaves. 3 real fonts + 3 size-adjust fallbacks (Archivo, Plex Mono, Newsreader) = 6.
    // Sweep: Archivo ships as two files (core Latin, and a second file for the rarer characters of the
    // original, split by unicode-range), so 4 real faces + 3 fallbacks = 7.
    assert.equal(faceBlocks.length, 7, `expected 7 @font-face rules (4 real fonts + 3 size-adjust fallbacks), found ${faceBlocks.length}`);

    const archivoFaces = faceBlocks.filter((b) => /font-family:\s*'Archivo'/.test(b));
    assert.equal(archivoFaces.length, 2, 'Archivo has exactly two faces, core and Ext');
    const archivo = archivoFaces.find((b) => /ArchivoVariable\.[0-9a-f]{8}\.woff2/.test(b));
    assert.ok(archivo, 'an Archivo core @font-face rule exists');
    // The shipped file is the variable font instanced to weights 400 to 600 and subset to Latin plus
    // Latin Extended-A, so the face declares exactly that range (a request outside it is a defect).
    assert.match(archivo, /font-weight:\s*400 600\s*;/);
    assert.doesNotMatch(archivo, /font-weight:\s*100 900/);
    assert.match(archivo, new RegExp(`url\\('\\/fonts\\/ArchivoVariable\\.${HASH}\\.woff2'\\)\\s*format\\('woff2'\\)`));
    assert.match(archivo, /font-display:\s*swap/);
    assert.match(archivo, /unicode-range:\s*U\+0020-007E, U\+00A0-017F,/, 'the core face covers basic Latin and Latin Extended-A');

    const archivoExt = archivoFaces.find((b) => /ArchivoVariableExt\.[0-9a-f]{8}\.woff2/.test(b));
    assert.ok(archivoExt, 'an Archivo Ext @font-face rule exists');
    assert.match(archivoExt, /font-weight:\s*400 600\s*;/);
    assert.match(archivoExt, /font-display:\s*swap/);
    assert.match(archivoExt, new RegExp(`url\\('\\/fonts\\/ArchivoVariableExt\\.${HASH}\\.woff2'\\)\\s*format\\('woff2'\\)`));
    const extRange = archivoExt.match(/unicode-range:\s*([^;]+);/);
    assert.ok(extRange, 'the Ext face carries a unicode-range');
    assert.match(extRange[1], /U\+1EA0-1EF9/, 'the Ext face covers the Vietnamese block');
    assert.match(extRange[1], /U\+0218|U\+01FA-021B/, 'the Ext face covers the Romanian comma-below letters');
    // The two ranges never overlap, so a character has exactly one source.
    const expand = (list) => list.split(',').map((t) => t.trim().replace(/^U\+/, '')).flatMap((t) => {
      const [a, b] = t.split('-').map((h) => parseInt(h, 16));
      return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, i) => a + i);
    });
    const coreSet = new Set(expand(archivo.match(/unicode-range:\s*([^;]+);/)[1]));
    const overlap = expand(extRange[1]).filter((cp) => coreSet.has(cp));
    assert.deepEqual(overlap, [], 'the core and Ext unicode-ranges do not overlap');
    // Positive control for the overlap check: the expander sees a shared code point.
    assert.deepEqual(expand('U+0041-0043').filter((cp) => new Set(expand('U+0042')).has(cp)), [0x42]);

    const plex400 = faceBlocks.find((b) => /font-family:\s*'IBM Plex Mono'/.test(b) && /font-weight:\s*400\b/.test(b));
    assert.ok(plex400, 'an IBM Plex Mono 400 @font-face rule exists');
    assert.match(plex400, new RegExp(`url\\('\\/fonts\\/PlexMono400\\.${HASH}\\.woff2'\\)\\s*format\\('woff2'\\)`));

    // Design system pass: weight 500 is retired (every mono use is 400). The 400 face asserted
    // above is the positive control that the mono family still ships.
    const plex500 = faceBlocks.find((b) => /font-family:\s*'IBM Plex Mono'/.test(b) && /font-weight:\s*500\b/.test(b));
    assert.equal(plex500, undefined, 'the IBM Plex Mono 500 @font-face rule is retired');
    assert.doesNotMatch(STYLES, /url\('\/fonts\/PlexMono500/, 'styles.css no longer references the PlexMono500 file');

    const newsreader = faceBlocks.find((b) => /font-family:\s*'Newsreader'/.test(b));
    assert.ok(newsreader, 'a Newsreader @font-face rule exists');
    assert.match(newsreader, /font-weight:\s*300/);
    assert.match(newsreader, /font-display:\s*swap/);
    assert.match(newsreader, new RegExp(`url\\('\\/fonts\\/NewsreaderDisplay300\\.${HASH}\\.woff2'\\)\\s*format\\('woff2'\\)`));

    const newsFallback = faceBlocks.find((b) => /font-family:\s*'Newsreader Fallback'/.test(b));
    assert.ok(newsFallback, 'a Newsreader Fallback @font-face rule exists');
    assert.match(newsFallback, /src:\s*local\('Georgia'\)/);
    assert.match(newsFallback, /size-adjust:\s*\d+(\.\d+)?%/);
    assert.match(newsFallback, /ascent-override:\s*\d+(\.\d+)?%/);
    assert.match(newsFallback, /descent-override:\s*\d+(\.\d+)?%/);
  });

  it('the four self-hosted font files exist on disk (content-hashed names) within the byte ceilings, and the retired Plex Mono 500 file is gone', () => {
    const prefixes = [
      ['ArchivoVariable', 40 * 1024],
      ['ArchivoVariableExt', 20 * 1024],
      ['PlexMono400', 28 * 1024],
      ['NewsreaderDisplay300', 30 * 1024],
    ];
    const fontsDir = path.join(PUBLIC_DIR, 'fonts');
    const onDisk = fs.readdirSync(fontsDir);
    for (const [prefix, ceiling] of prefixes) {
      const re = new RegExp(`^${prefix}\\.${HASH}\\.woff2$`);
      const match = onDisk.find((f) => re.test(f));
      assert.ok(match, `a ${prefix}.<hash>.woff2 file should exist in ${fontsDir}, found: ${onDisk.join(', ')}`);
      const size = fs.statSync(path.join(fontsDir, match)).size;
      assert.ok(size <= ceiling, `${match} is ${size} bytes, over its ${ceiling}-byte ceiling`);
      assert.ok(size > 1000, `${match} is suspiciously small (${size} bytes) — likely not a real font`);
    }
    // The Plex Mono 500 face is retired, and its file with it.
    assert.equal(onDisk.filter((f) => /^PlexMono500\./.test(f)).length, 0, 'no PlexMono500 file remains in the fonts folder');
  });

  for (const page of [...PAIRING_SHEET_PAGES, ...GAP_FILL_FONT_PAGES]) {
    it(`${page} links both font preloads (content-hashed) and carries no Google Fonts reference`, () => {
      const html = readPage(page);
      assert.match(html, new RegExp(`<link rel="preload" href="\\/fonts\\/ArchivoVariable\\.${HASH}\\.woff2" as="font" type="font\\/woff2" crossorigin \\/>`),
        `${page} should preload the content-hashed ArchivoVariable.woff2`);
      assert.match(html, new RegExp(`<link rel="preload" href="\\/fonts\\/PlexMono400\\.${HASH}\\.woff2" as="font" type="font\\/woff2" crossorigin \\/>`),
        `${page} should preload the content-hashed PlexMono400.woff2`);
      assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/,
        `${page} should carry no Google Fonts reference`);
    });
  }

  it('no shipped page or the stylesheet hardcodes Inter, JetBrains Mono, or Geist anywhere', () => {
    for (const page of ALL_PAGES) {
      const html = readPage(page);
      assert.doesNotMatch(html, /'Inter'|"Inter"|JetBrains|'Geist'|"Geist"|Fira Mono/,
        `${page} should carry no hardcoded legacy font-family reference`);
    }
    assert.doesNotMatch(STYLES, /'Inter'|"Inter"|JetBrains|'Geist'|"Geist"|Fira Mono/,
      'styles.css should carry no hardcoded legacy font-family reference');
  });

  // Design rebuild round 3: the step diagrams are panels in the homepage kit, not inline SVG
  // wireframes, so their mono labels take the shared --mono token (IBM Plex Mono first) from
  // the page's own classes. Before: 20 SVG labels pinned on the "'IBM Plex Mono', monospace"
  // attribute. Now: no SVG label text and no bare "monospace" attribute remain, and the mono
  // label classes read var(--mono) (positive control: the classes exist and are used).
  it('how-it-works.html: the diagram labels are HTML set in the shared --mono token, not bare "monospace" SVG text', () => {
    const html = readPage('how-it-works.html');
    const bare = [...html.matchAll(/font-family="monospace"/g)];
    assert.equal(bare.length, 0, 'no inline SVG text should carry bare font-family="monospace"');
    assert.equal([...html.matchAll(/<text[ >]/g)].length, 0, 'the diagrams carry no SVG text nodes');
    for (const cls of ['hiw-mono', 'hiw-chip']) {
      const rule = html.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`));
      assert.ok(rule, `.${cls} rule exists`);
      assert.match(rule[1], /font-family:\s*var\(--mono\)/, `.${cls} sets the shared --mono token`);
      assert.ok(html.includes(`class="${cls}`) || html.includes(` ${cls}`), `positive control: ${cls} is used in the markup`);
    }
  });

  it('og-image.svg headline names Newsreader (Georgia, serif fallback) and the wordmark stays on Archivo with the Helvetica/Arial fallback', () => {
    const svg = fs.readFileSync(path.join(PUBLIC_DIR, 'og-image.svg'), 'utf8');
    const matches = [...svg.matchAll(/font-family="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(matches.length > 0, 'og-image.svg should carry font-family attributes');
    const headline = matches.filter((m) => m === 'Newsreader, Georgia, serif');
    const wordmark = matches.filter((m) => m === 'Archivo, Helvetica, Arial, sans-serif');
    assert.equal(headline.length, 2, 'both headline lines name Newsreader first');
    assert.equal(wordmark.length, 1, 'the wordmark names Archivo first');
    assert.equal(headline.length + wordmark.length, matches.length, 'no other font-family appears (no Inter, no bare generic)');
    for (const line of ['A marketplace for', 'what agents learn']) {
      assert.match(svg, new RegExp(`font-family="Newsreader, Georgia, serif"[^>]*>${line}</text>`), `"${line}" is set in Newsreader`);
    }
    assert.match(svg, /font-family="Archivo, Helvetica, Arial, sans-serif" font-weight="500"[^>]*>auxilo<\/text>/, 'the wordmark is Archivo weight 500');
  });

  it('og-image.svg look: near-black ground, two light-serif headline lines at x=72, the mark as a faint device running off the right edge, no tile pattern or glow', () => {
    const svg = fs.readFileSync(path.join(PUBLIC_DIR, 'og-image.svg'), 'utf8');
    // positive controls: the new look is present
    assert.ok(svg.includes('<rect width="1200" height="630" fill="#0A0A0A"/>'), 'ground is #0A0A0A, full frame');
    const headlines = [...svg.matchAll(/<text x="72" y="(\d+)" font-family="Newsreader, Georgia, serif" font-weight="300" font-size="84" fill="#FAFAF8" letter-spacing="-1\.68">([^<]*)<\/text>/g)];
    assert.deepEqual(headlines.map((m) => m[2]), ['A marketplace for', 'what agents learn'], 'two headline lines, left aligned at x=72, weight 300 at 84px, tracking -0.02em');
    assert.ok(Number(headlines[1][1]) > Number(headlines[0][1]), 'the second line sits below the first');
    // the device: the mark's own geometry, scaled up, faint, crossbar in gold leaving the frame
    const device = svg.match(/<g transform="translate\(([-\d.]+),([-\d.]+)\) scale\(([\d.]+)\)">\s*<polygon points="256,88 434,404 78,404" fill="none" stroke="#FAFAF8" stroke-opacity="0\.08"[^>]*\/>\s*<line x1="256" y1="272" x2="([\d.]+)" y2="272" stroke="#C9A84C" stroke-opacity="0\.4"[^>]*\/>\s*<\/g>/);
    assert.ok(device, 'the device group carries the mark geometry, ivory outline at 0.08 and gold crossbar at 0.4');
    const [, tx, , k, barEnd] = device;
    assert.ok(Number(k) >= 2, 'the device is drawn large (at least twice the mark geometry)');
    assert.ok(Number(tx) + Number(barEnd) * Number(k) > 1200, 'the crossbar runs off the right edge of the 1200 frame');
    // the corner wordmark is exactly as it was drawn
    assert.ok(svg.includes(`<g transform="translate(72,534) scale(1.600)">
  <polygon points="22,4 40,36 4,36" fill="none" stroke="#C9A84C" stroke-width="3" stroke-linejoin="round"/>
  <line x1="22" y1="22.5" x2="40" y2="22.5" stroke="#C9A84C" stroke-width="2.4"/>
  <text x="54" y="31" font-family="Archivo, Helvetica, Arial, sans-serif" font-weight="500" font-size="24" fill="#FAFAF8" letter-spacing="-0.01">auxilo</text>
</g>`), 'mark and wordmark unchanged in geometry, gold stroke and Archivo 500');
    // retired: the tile pattern and the radial glow (and any gradient)
    assert.doesNotMatch(svg, /<pattern|<radialGradient|<linearGradient|url\(#/, 'no tile pattern, glow or gradient');
  });

  it('og-image.png is a 1200 by 630 PNG under 120KB', () => {
    const png = fs.readFileSync(path.join(PUBLIC_DIR, 'og-image.png'));
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG', 'PNG signature');
    assert.equal(png.readUInt32BE(16), 1200, 'width');
    assert.equal(png.readUInt32BE(20), 630, 'height');
    assert.ok(png.length < 120 * 1024, `the share image stays under 120KB, got ${png.length} bytes`);
  });

  it('every numeral/figure-bearing class sitewide renders on var(--mono) (inherently tabular — no sans element carries a figure)', () => {
    // The site's own convention: every price/stat/ledger class uses
    // font-family: var(--mono). Spot-check the pull-stat / math-stat /
    // stats-strip families the AD sheets call out for the mono column
    // alignment check.
    const figureSelectors = ['pull-stat-num', 'pull-stat-secondary'];
    for (const sel of figureSelectors) {
      const body = STYLES.match(new RegExp(`\\.${sel}[^{]*\\{([^}]*)\\}`));
      assert.ok(body, `.${sel} rule exists in styles.css`);
      assert.match(body[1], /font-family:\s*var\(--mono\)/, `.${sel} should render on var(--mono)`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Sheet 2: AD design-tells sweep
// ═══════════════════════════════════════════════════════════════════════

describe('WAVE-D1 design-tells sweep: removed markup + CSS carry no residue', () => {
  // Tell 1: eyebrows / uppercase tracked labels.
  it('tell 1 — no page carries a section-label/hero-eyebrow/page-eyebrow class anywhere', () => {
    const classPattern = /class="[^"]*\b(section-label|hero-eyebrow|page-hero-eyebrow|hiw-section-label|page-eyebrow)\b[^"]*"/;
    for (const page of ALL_PAGES) {
      const html = readPage(page);
      assert.doesNotMatch(html, classPattern, `${page} should carry no eyebrow-class element`);
    }
    assert.doesNotMatch(STYLES, /^\.section-label\s*\{|^\.hero-eyebrow\s*\{/m,
      'styles.css should carry no base .section-label / .hero-eyebrow rule');
  });

  // Tell 3 + 8: hero-glow / hero-bg (gradient glow + decorative triangle
  // texture), in every page-scoped naming variant found (hero-*, builders-
  // hero-*, earnings-hero-*, hiw-hero-*).
  it('tell 3 + 8 — no page renders a hero-glow or hero-bg element in any naming variant', () => {
    const pattern = /class="[\w-]*hero-(?:bg|glow)"/;
    for (const page of ALL_PAGES) {
      const html = readPage(page);
      assert.doesNotMatch(html, pattern, `${page} should carry no *-hero-bg / *-hero-glow element`);
    }
  });

  it('tell 8 — the ground scopes carry no decorative background-image (background colour only), and .section-ground is retired', () => {
    // Design system pass: a section declares its ground with .on-dark / .on-tint, or sits on paper.
    // .section-ground (the old paper ground) is retired: no page carries it.
    assert.doesNotMatch(STYLES, /\.section-ground\b/, '.section-ground is retired from styles.css');
    const dark = STYLES.match(/^\.on-dark\s*\{([^}]*)\}/m);
    assert.ok(dark, '.on-dark ground rule exists');
    assert.match(dark[1], /background:\s*var\(--bg\)/, '.on-dark keeps its background colour');
    assert.doesNotMatch(dark[1], /background-image/, '.on-dark should carry no background-image');
    const tint = STYLES.match(/^\.on-tint\s*\{([^}]*)\}/m);
    assert.ok(tint, '.on-tint ground rule exists');
    assert.match(tint[1], /background:\s*var\(--bg\)/, '.on-tint keeps its background colour');
    assert.doesNotMatch(tint[1], /background-image/, '.on-tint should carry no background-image');
  });

  // Tell 4: hairline section-divider ornament.
  it('tell 4 — no page renders a .section-divider element; the rule is gone from styles.css', () => {
    for (const page of ALL_PAGES) {
      const html = readPage(page);
      assert.doesNotMatch(html, /class="section-divider"/, `${page} should carry no .section-divider element`);
    }
    assert.doesNotMatch(STYLES, /^\.section-divider\s*\{/m, 'styles.css should carry no .section-divider rule');
  });

  // Tell 6: icon/symbol glyphs used as list or step markers.
  it('tell 6 — no page renders a step-icon / moat-icon / flow-step-icon / feature-icon / compound-factor-icon marker', () => {
    const pattern = /class="(?:step-icon|moat-icon|flow-step-icon|feature-icon|compound-factor-icon)"/;
    for (const page of ALL_PAGES) {
      const html = readPage(page);
      assert.doesNotMatch(html, pattern, `${page} should carry no icon-as-marker element`);
    }
  });

  it('tell 6 — no page renders a .check glyph span (star/diamond bullet markers, pricing + for-agents)', () => {
    for (const page of ALL_PAGES) {
      const html = readPage(page);
      assert.doesNotMatch(html, /class="check"/, `${page} should carry no .check glyph span`);
    }
  });

  it('tell 6 — no page renders a .prc-icon / .ft-icon dotted-circle note marker', () => {
    for (const page of ALL_PAGES) {
      const html = readPage(page);
      assert.doesNotMatch(html, /class="(?:prc-icon|ft-icon)"/, `${page} should carry no note-marker glyph span`);
    }
  });

  // Tell 11: scroll-reveal gating.
  it('tell 11 — no page carries the html.js-reveal opt-in script line; the CSS hiding rule is gone', () => {
    for (const page of ALL_PAGES) {
      const html = readPage(page);
      assert.doesNotMatch(html, /document\.documentElement\.className \+= ' js-reveal'/,
        `${page} should carry no js-reveal opt-in line`);
    }
    // Match the selector usage only (html.js-reveal followed by a space or
    // combinator into a rule) — not the word appearing inside a comment
    // explaining that the rule is gone.
    assert.doesNotMatch(STYLES, /html\.js-reveal\s*[.{]/, 'styles.css should carry no html.js-reveal selector');
    // .reveal itself (the transition rule) survives — the class attributes
    // stay in markup, inert, per the sheet's explicit instruction.
    assert.match(STYLES, /^\.reveal\s*\{/m, '.reveal base transition rule should still exist');
  });

  // Tell 12: CTA arrow glyphs (button/link labels only — narrative sentence
  // arrows and the .dive-arrow row affordance are explicit keeps).
  it('tell 12 — no <a> tag closes on a trailing arrow glyph (literal or entity)', () => {
    const pattern = /[ \t]*(?:→|&#8594;|&rarr;)[ \t]*<\/a>/;
    for (const page of ALL_PAGES) {
      const html = readPage(page);
      assert.doesNotMatch(html, pattern, `${page} should carry no arrow-suffixed <a> label`);
    }
  });

  // Design rebuild: the index of pages on the homepage drops its numerals (01 to 05) and its
  // row arrows (owner ruling: no arrows, no numerals as decoration). The five rows stay, with
  // their titles and descriptions; only the two decorative spans go.
  it('the five homepage dive rows carry no .dive-arrow span and no .dive-num numeral (the rows themselves, with title and description, stay)', () => {
    const html = readPage('index.html');
    const rows = [...html.matchAll(/<a href="[^"]+" class="dive-row">([\s\S]*?)<\/a>/g)];
    assert.equal(rows.length, 5, `positive control: expected 5 .dive-row anchors on index.html, found ${rows.length}`);
    for (const [, inner] of rows) {
      assert.match(inner, /<span class="dive-title">[^<]+<\/span>/, 'each row keeps its title span');
      assert.match(inner, /<span class="dive-desc">[^<]+<\/span>/, 'each row keeps its description span');
    }
    assert.equal([...html.matchAll(/class="dive-arrow"/g)].length, 0, 'no .dive-arrow span on index.html');
    assert.equal([...html.matchAll(/class="dive-num"/g)].length, 0, 'no .dive-num span on index.html');
    assert.ok(!/<span class="dive-[a-z]+">(?:→|0[1-9])<\/span>/.test(html), 'no arrow glyph or 01..09 numeral inside a dive span');
  });

  // Tell 5: card wall + border-radius normalization.
  it('tell 5 — the card wall stays flat: .moat-card is retired (no page uses it), and the ruled-row component that remains has no radius or hover lift', () => {
    assert.doesNotMatch(STYLES, /\.moat-(?:card|grid)\b/, '.moat-card and .moat-grid are retired from styles.css');
    // Positive control: a ruled row (border-top, no background, no radius) is what the shared sheet draws now.
    const row = STYLES.match(/^\.dive-row\s*\{([^}]*)\}/m);
    assert.ok(row, '.dive-row rule exists');
    assert.match(row[1], /border-top:/);
    assert.doesNotMatch(row[1], /background:/);
    assert.doesNotMatch(row[1], /border-radius:/);
    assert.doesNotMatch(STYLES, /^\.dive-row:hover\s*\{/m, '.dive-row:hover should lift nothing');
  });

  it('tell 5 (P3a) — border-radius sitewide in styles.css follows the shape scale: controls 6px, panels 10px, stages and cards 14px (tokens), plus 4px chips, 0, and the named exceptions', () => {
    // Design system pass: this used to collapse every radius to 4px controls / 0 surfaces.
    const radii = [...STYLES.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1].trim());
    const allowed = new Set(['var(--r-control)', 'var(--r-panel)', 'var(--r-stage)', '4px', '0']);
    // Named, counted exceptions never swept: the skip-to-content a11y control's
    // bottom-only rounding, the drawing kit's 5px button and the ledger drawing's
    // 50% dot. (The email-capture split-corner pair, .legend-swatch's 2px and the
    // 999px queue count pill left with their components.) The 50% avatar-circle idiom
    // lives in each page's own <style> block, not styles.css — untouched,
    // out of this sitewide-sheet's scope, not checked here.
    const exceptions = {
      '0 0 var(--r-control) var(--r-control)': 1, // .skip-to-content
      '5px': 1,         // .dw-btn, the drawing kit's button
      '50%': 1,         // .dw-tick, the ledger drawing's dot
    };
    const seen = Object.fromEntries(Object.keys(exceptions).map((k) => [k, 0]));
    for (const r of radii) {
      if (allowed.has(r)) continue;
      assert.ok(Object.prototype.hasOwnProperty.call(exceptions, r),
        `unexpected border-radius value "${r}" — should be 4px, 0, or a named exception`);
      seen[r] += 1;
    }
    for (const [value, count] of Object.entries(exceptions)) {
      assert.equal(seen[value], count,
        `expected exactly ${count} border-radius: ${value} declaration(s), found ${seen[value]}`);
    }
    // Positive control: the three scale tokens are defined at 6 / 10 / 14 and each one is used.
    assert.match(STYLES, /--r-control:\s*6px/);
    assert.match(STYLES, /--r-panel:\s*10px/);
    assert.match(STYLES, /--r-stage:\s*14px/);
    for (const token of ['var(--r-control)', 'var(--r-panel)', 'var(--r-stage)']) {
      assert.ok(radii.includes(token), `${token} is used by at least one rule`);
    }
  });

  it('dead CSS components removed by the sweep stay removed (.bar-chart family, .learning-card family, .hiw-step family, .compound-factor(s) dead duplicate)', () => {
    for (const sel of ['.bar-chart', '.bar-chart-label', '.bar-power', '.learning-card', '.learning-category',
      '.hiw-step-icon', '.hiw-step-number']) {
      const re = new RegExp('^' + sel.replace('.', '\\.') + '\\s*\\{', 'm');
      assert.doesNotMatch(STYLES, re, `styles.css should carry no ${sel} rule (dead, unreferenced by any page)`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Cache-bust consistency (standing rule)
// ═══════════════════════════════════════════════════════════════════════

describe('WAVE-D1: styles.css ?v= bump rides in this commit, consistent across every public page', () => {
  it('every page in ALL_PAGES links /styles.css with the identical ?v=N', () => {
    const versions = new Map();
    for (const page of ALL_PAGES) {
      const html = readPage(page);
      const m = html.match(/href="\/styles\.css\?v=([0-9a-f]+)"/);
      assert.ok(m, `${page} should link /styles.css?v=N`);
      versions.set(page, m[1]);
    }
    const values = new Set(versions.values());
    assert.equal(values.size, 1,
      `all pages should share one ?v= value, found: ${JSON.stringify([...versions.entries()])}`);
  });

  // The legal-page shell's own ?v= (server.js, serveLegalPage) is checked
  // by the dedicated test/legal-page-styles-version.test.js, not here.
  // server.js is off-limits to this build (BUILD-SPEC), so that shell's
  // ?v= could NOT be bumped alongside this commit's styles.css changes —
  // that test is EXPECTED to fail until a server.js change lands. See the
  // wave D1 delivery report for the exact line (server.js:12203).
});

// ═══════════════════════════════════════════════════════════════════════
// WAVE-D1 fix pass (2026-09-06): Gate-A FAIL remediation, F2/F3/F4
// ═══════════════════════════════════════════════════════════════════════

describe('WAVE-D1 fix pass: font cache immutability, CSP tightened, for-agents reveal gate', () => {
  // F3 — the font files ship content-hashed and server.js must give them an
  // immutable year-long cache via a dedicated /fonts/ route, registered
  // before the generic static catch-all (which only grants the default
  // 1-hour cache). Static-analysis check on server.js source, mirroring
  // this repo's existing convention (test/geo-embargo.test.js) of reading
  // server.js as text rather than booting it — server.js starts listening
  // as a side effect of require(), so it isn't import-safe for a plain
  // unit test (the staged-server harness in test/helpers/staged-server.js
  // exists precisely to work around that for tests that need a live
  // socket; this one doesn't need to reach that far).
  it('server.js registers an immutable-cache /fonts/ route for hashed woff2 files, ahead of the generic static catch-all', () => {
    const fontsRouteRe = /app\.get\('\/fonts\/:file\{[\s\S]{0,80}?\}',\s*\(c\)\s*=>\s*\{[\s\S]{0,400}?\}\);/;
    const fontsRouteMatch = SERVER_SRC.match(fontsRouteRe);
    assert.ok(fontsRouteMatch, 'server.js should define a /fonts/:file{...woff2...} route');
    assert.match(fontsRouteMatch[0], /public,\s*max-age=31536000,\s*immutable/,
      'the /fonts/ route should serve woff2 files with an immutable, one-year Cache-Control');

    const genericCatchAllRe = /app\.get\('\/:file\{[^}]*woff2[^}]*\}'/;
    const genericMatch = SERVER_SRC.match(genericCatchAllRe);
    assert.ok(genericMatch, 'server.js should still define the generic static catch-all covering woff2');
    assert.ok(fontsRouteMatch.index < genericMatch.index,
      'the /fonts/ immutable-cache route must be registered before the generic static catch-all, or the catch-all would shadow it');
  });

  it('every shipped font filename under public/fonts/ matches the immutable route\'s hash pattern', () => {
    const fontsDir = path.join(PUBLIC_DIR, 'fonts');
    const woff2Files = fs.readdirSync(fontsDir).filter((f) => f.endsWith('.woff2'));
    assert.equal(woff2Files.length, 4, `expected 4 woff2 files in ${fontsDir}, found ${woff2Files.length}`);
    for (const f of woff2Files) {
      assert.match(f, /^[A-Za-z0-9]+\.[0-9a-f]{8}\.woff2$/,
        `${f} should be named <name>.<8-hex-hash>.woff2 to match the immutable /fonts/ cache route`);
    }
  });

  // F4 — style-src/font-src no longer allow fonts.googleapis.com /
  // fonts.gstatic.com now that Archivo + IBM Plex Mono are self-hosted.
  // Exercised through the real helper (not a copied string) so a future
  // edit to lib/analytics.js can't silently regress this un-caught.
  it('the CSP (both the unset-domain baseline and the analytics-on variant) carries no Google Fonts allowance', () => {
    const baselineCsp = buildContentSecurityPolicy('');
    const analyticsCsp = buildContentSecurityPolicy('example.plausible.io');
    for (const [label, csp] of [['baseline', baselineCsp], ['analytics-on', analyticsCsp]]) {
      assert.doesNotMatch(csp, /fonts\.googleapis\.com|fonts\.gstatic\.com/,
        `${label} CSP should carry no fonts.googleapis.com/fonts.gstatic.com allowance`);
      assert.match(csp, /font-src 'self'(?:;| )/, `${label} CSP's font-src should be exactly 'self'`);
    }
  });

  // F2 — for-agents.html was the one page still carrying an ungated
  // `.reveal { opacity: 0; ... }` / `.reveal.visible {...}` pair in its own
  // inline <style> block (the html.js-reveal opt-in that used to gate it
  // sitewide was already removed, so this rule hid the element by default
  // with nothing left to ever un-hide it). Guards against that regressing.
  it('for-agents.html carries no page-local .reveal opacity rule and no js-reveal reference', () => {
    const html = readPage('for-agents.html');
    assert.doesNotMatch(html, /\.reveal\s*\{[^}]*opacity\s*:\s*0/,
      'for-agents.html should carry no .reveal rule that sets opacity: 0');
    assert.doesNotMatch(html, /\.reveal\.visible\s*\{/,
      'for-agents.html should carry no page-local .reveal.visible rule');
    assert.doesNotMatch(html, /js-reveal/i,
      'for-agents.html should carry no js-reveal reference (markup, CSS, or comment)');
    // The shared sitewide rule (styles.css) only sets a transition, never
    // opacity — so with the page-local override gone, no .reveal element
    // on this page is opacity:0 by default. Belt-and-suspenders: confirm
    // the shared rule itself still carries no opacity/hiding declaration.
    const sharedRevealRule = STYLES.match(/^\.reveal\s*\{([^}]*)\}/m);
    assert.ok(sharedRevealRule, 'styles.css should still define the shared .reveal transition rule');
    assert.doesNotMatch(sharedRevealRule[1], /opacity\s*:\s*0/,
      'the shared .reveal rule should not set opacity: 0');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Integration pass: the drawing kit's own face, and the helpers every page shares
// ═══════════════════════════════════════════════════════════════════════

describe('integration: .dw-title sets its own face, and the shared drawing helpers live once in the sheet', () => {
  // A learning title inside a dark terminal stage inherits the mono face from .dw-term. A title is
  // Archivo 500 wherever it sits, so the rule names its own family instead of inheriting one.
  it('.dw-title is Archivo 500 by its own rule (it holds inside a mono .dw-term)', () => {
    const rule = STYLES.match(/^\.dw-title\s*\{([^}]*)\}/m);
    assert.ok(rule, '.dw-title rule exists');
    assert.match(rule[1], /font-family:\s*var\(--sans\)/, '.dw-title names the sans face itself');
    assert.match(rule[1], /font-weight:\s*500\b/, '.dw-title is weight 500');
    // Positive control: the container it must beat really does set the mono face.
    const term = STYLES.match(/^\.dw-term\s*\{([^}]*)\}/m);
    assert.ok(term, '.dw-term rule exists');
    assert.match(term[1], /font-family:\s*var\(--mono\)/, '.dw-term sets the mono face that .dw-title must not inherit');
  });

  // The homepage and /for-builders each carried a copy of the device's clipping wrapper and the
  // review-queue drawing's kill-switch helpers. The kill-switch helpers live in the shared sheet now, once.
  // The device itself is no longer markup: the shared sheet paints it as a background image on the first
  // dark section, so no page carries a device svg or the old clipping wrapper, and the sheet has no rule
  // left for that wrapper.
  it('.dw-hang and .dw-kill are defined once in styles.css and in no page; no page or sheet carries the old .dw-device-clip', () => {
    for (const selector of ['.dw-hang', '.dw-kill']) {
      const defs = [...STYLES.matchAll(new RegExp(`^${selector.replace('.', '\\.')}\\s*\\{`, 'gm'))];
      assert.equal(defs.length, 1, `${selector} is defined exactly once in styles.css, found ${defs.length}`);
    }
    for (const page of ['index.html', 'for-builders.html']) {
      const html = readPage(page);
      const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
      for (const selector of ['.dw-device-clip', '.dw-hang', '.dw-kill']) {
        assert.ok(!style.includes(`${selector} {`) && !style.includes(`${selector}{`), `${page} carries no copy of ${selector}`);
      }
      // Positive control: the markup still uses the shared kill-switch panel.
      assert.match(html, /dw-kill/, `${page} still uses the shared kill-switch panel`);
    }
    // No page carries the device as markup, and the sheet has no rule for the old wrapper.
    for (const page of ALL_PAGES) {
      assert.ok(!/dw-device/.test(readPage(page)), `${page} carries no device markup`);
    }
    assert.ok(!/dw-device-clip/.test(STYLES), 'styles.css carries no rule for the old inline device wrapper');
    // Positive control: the shared sheet does paint the device, so the absence above is about the markup.
    assert.match(STYLES, /--device:\s*url\(/, 'the sheet defines the device image');
  });

  it('the homepage style block carries no second .hero-grid (the shared sheet has it)', () => {
    const style = readPage('index.html').match(/<style>([\s\S]*?)<\/style>/)[1];
    assert.ok(!/^\s*\.hero-grid\s*\{/m.test(style), 'index.html defines no .hero-grid of its own');
    assert.match(STYLES, /^\.hero-grid\s*\{/m, 'positive control: styles.css defines .hero-grid');
  });
});
