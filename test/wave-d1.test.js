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
  // extension, e.g. ArchivoVariable.1b4d984f.woff2) so server.js can cache
  // them immutably for a year — a byte change forces a new URL. Matchers
  // below are hash-agnostic ([0-9a-f]{8}) so a legitimate future re-hash
  // (the font bytes changing) doesn't require touching this test.
  const HASH = '[0-9a-f]{8}';

  it('three real-font @font-face rules exist (Archivo variable 100-900, IBM Plex Mono 400 and 500 statics), each on a content-hashed woff2 URL, plus two size-adjust fallback faces (Wave E2 item 11)', () => {
    const faceBlocks = [...STYLES.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
    // Wave E2 item 11: two synthetic local()-only fallback faces
    // ('Archivo Fallback', 'IBM Plex Mono Fallback') were added alongside
    // the original three, each carrying a size-adjust metric override —
    // 5 total, not 3. The three real-font assertions below are unchanged.
    assert.equal(faceBlocks.length, 5, `expected 5 @font-face rules (3 real fonts + 2 size-adjust fallbacks), found ${faceBlocks.length}`);

    const archivo = faceBlocks.find((b) => /font-family:\s*'Archivo'/.test(b));
    assert.ok(archivo, 'an Archivo @font-face rule exists');
    assert.match(archivo, /font-weight:\s*100 900/);
    assert.match(archivo, new RegExp(`url\\('\\/fonts\\/ArchivoVariable\\.${HASH}\\.woff2'\\)\\s*format\\('woff2'\\)`));

    const plex400 = faceBlocks.find((b) => /font-family:\s*'IBM Plex Mono'/.test(b) && /font-weight:\s*400\b/.test(b));
    assert.ok(plex400, 'an IBM Plex Mono 400 @font-face rule exists');
    assert.match(plex400, new RegExp(`url\\('\\/fonts\\/PlexMono400\\.${HASH}\\.woff2'\\)\\s*format\\('woff2'\\)`));

    const plex500 = faceBlocks.find((b) => /font-family:\s*'IBM Plex Mono'/.test(b) && /font-weight:\s*500\b/.test(b));
    assert.ok(plex500, 'an IBM Plex Mono 500 @font-face rule exists');
    assert.match(plex500, new RegExp(`url\\('\\/fonts\\/PlexMono500\\.${HASH}\\.woff2'\\)\\s*format\\('woff2'\\)`));
  });

  it('the three self-hosted font files exist on disk (content-hashed names) within the byte ceilings', () => {
    const prefixes = [
      ['ArchivoVariable', 70 * 1024],
      ['PlexMono400', 28 * 1024],
      ['PlexMono500', 28 * 1024],
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

  it('how-it-works.html: all 20 inline SVG label texts use the IBM Plex Mono stack, not bare "monospace"', () => {
    const html = readPage('how-it-works.html');
    const bare = [...html.matchAll(/font-family="monospace"/g)];
    assert.equal(bare.length, 0, 'no inline SVG text should carry bare font-family="monospace"');
    const plex = [...html.matchAll(/font-family="'IBM Plex Mono', monospace"/g)];
    assert.equal(plex.length, 20, `expected 20 inline SVG labels on the IBM Plex Mono stack, found ${plex.length}`);
  });

  it('og-image.svg names Archivo (not Inter), keeping the Helvetica/Arial fallback', () => {
    const svg = fs.readFileSync(path.join(PUBLIC_DIR, 'og-image.svg'), 'utf8');
    const matches = [...svg.matchAll(/font-family="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(matches.length > 0, 'og-image.svg should carry font-family attributes');
    for (const m of matches) {
      assert.match(m, /^Archivo, Helvetica, Arial, sans-serif$/, `og-image.svg font-family should read Archivo first, got: ${m}`);
    }
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

  it('tell 8 — .section-ground carries no decorative background-image (background-color only)', () => {
    const body = STYLES.match(/\.section-ground,\s*\n#how-it-works,\s*\n#footer-cta\s*\{([^}]*)\}/);
    assert.ok(body, '.section-ground shared rule exists');
    assert.doesNotMatch(body[1], /background-image/, '.section-ground should carry no background-image');
    assert.match(body[1], /background-color:\s*var\(--obsidian\)/, '.section-ground should keep background-color');
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

  it('the five .dive-arrow row-affordance spans on index.html survive untouched (explicit keep; was 6 before the Earnings dive-row was removed when /earnings folded into /pricing, packet 15 rev 3a, v97 assembly)', () => {
    const html = readPage('index.html');
    const matches = [...html.matchAll(/<span class="dive-arrow">→<\/span>/g)];
    assert.equal(matches.length, 5, `expected 5 .dive-arrow spans on index.html, found ${matches.length}`);
  });

  // Tell 5: card wall + border-radius normalization.
  it('tell 5 — .moat-card is flattened (border-top ruled row, no background/border-radius/hover)', () => {
    const body = STYLES.match(/\.moat-card\s*\{([^}]*)\}/);
    assert.ok(body, '.moat-card rule exists');
    assert.match(body[1], /border-top:/);
    assert.doesNotMatch(body[1], /background:/);
    assert.doesNotMatch(body[1], /border-radius:/);
    assert.doesNotMatch(STYLES, /^\.moat-card:hover\s*\{/m, '.moat-card:hover should be gone');
  });

  it('tell 5 (P3a) — border-radius sitewide in styles.css collapses to 4px controls / 0 surfaces (plus the named exceptions)', () => {
    const radii = [...STYLES.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1].trim());
    const allowed = new Set(['4px', '0']);
    // Named, counted exceptions never swept: the email-capture split-corner
    // pair (desktop L/R-only rounding + its mobile all-corner variant),
    // the skip-to-content a11y control's bottom-only rounding, and
    // .legend-swatch's 2px micro-decoration. (The 50% avatar-circle idiom
    // lives in each page's own <style> block, not styles.css — untouched,
    // out of this sitewide-sheet's scope, not checked here.)
    const exceptions = {
      '6px 0 0 6px': 1, // .email-input, desktop
      '0 6px 6px 0': 1, // .footer-email-capture .btn-primary, desktop
      '0 0 6px 6px': 1, // .skip-to-content
      '6px': 2,         // .email-input + .btn-primary, mobile (<=600px), all corners
      '2px': 1,         // .legend-swatch
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
    assert.equal(woff2Files.length, 3, `expected 3 woff2 files in ${fontsDir}, found ${woff2Files.length}`);
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
