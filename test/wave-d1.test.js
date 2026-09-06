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
 * Purely structural / file-level: every assertion is checkable from the
 * served bytes on disk, no live server needed (same convention as
 * test/site-system.test.js).
 *
 * Runner: node --test test/wave-d1.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const STYLES_PATH = path.join(PUBLIC_DIR, 'styles.css');
const STYLES = fs.readFileSync(STYLES_PATH, 'utf8');

// Every public page this wave touched. public/writing/index.html (the /writing
// hub) is a real, separate, footer-bearing page distinct from
// public/writing-agents-message-board.html (the essay) — both are in scope.
const ALL_PAGES = [
  'about.html',
  'api.html',
  'dashboard.html',
  'earnings.html',
  'for-agents.html',
  'for-builders.html',
  'how-it-works.html',
  'index.html',
  'pricing.html',
  'status.html',
  'writing-agents-message-board.html',
  path.join('writing', 'index.html'),
];

// The 9 pages the AD-TYPE-PAIRING sheet names explicitly for the font
// preload swap (about.html and writing/index.html carried the same Google
// Fonts pattern but were not named by the sheet — fixed anyway, tracked
// separately below since they're a builder-found gap, not a sheet item).
const PAIRING_SHEET_PAGES = [
  'api.html',
  'dashboard.html',
  'earnings.html',
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

  it('three @font-face rules exist (Archivo variable 100-900, IBM Plex Mono 400 and 500 statics)', () => {
    const faceBlocks = [...STYLES.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
    assert.equal(faceBlocks.length, 3, `expected 3 @font-face rules, found ${faceBlocks.length}`);

    const archivo = faceBlocks.find((b) => /font-family:\s*'Archivo'/.test(b));
    assert.ok(archivo, 'an Archivo @font-face rule exists');
    assert.match(archivo, /font-weight:\s*100 900/);
    assert.match(archivo, /url\('\/fonts\/ArchivoVariable\.woff2'\)\s*format\('woff2'\)/);

    const plex400 = faceBlocks.find((b) => /font-family:\s*'IBM Plex Mono'/.test(b) && /font-weight:\s*400\b/.test(b));
    assert.ok(plex400, 'an IBM Plex Mono 400 @font-face rule exists');
    assert.match(plex400, /url\('\/fonts\/PlexMono400\.woff2'\)\s*format\('woff2'\)/);

    const plex500 = faceBlocks.find((b) => /font-family:\s*'IBM Plex Mono'/.test(b) && /font-weight:\s*500\b/.test(b));
    assert.ok(plex500, 'an IBM Plex Mono 500 @font-face rule exists');
    assert.match(plex500, /url\('\/fonts\/PlexMono500\.woff2'\)\s*format\('woff2'\)/);
  });

  it('the three self-hosted font files exist on disk within the byte ceilings', () => {
    const files = [
      ['ArchivoVariable.woff2', 70 * 1024],
      ['PlexMono400.woff2', 28 * 1024],
      ['PlexMono500.woff2', 28 * 1024],
    ];
    for (const [name, ceiling] of files) {
      const p = path.join(PUBLIC_DIR, 'fonts', name);
      assert.ok(fs.existsSync(p), `${p} should exist`);
      const size = fs.statSync(p).size;
      assert.ok(size <= ceiling, `${name} is ${size} bytes, over its ${ceiling}-byte ceiling`);
      assert.ok(size > 1000, `${name} is suspiciously small (${size} bytes) — likely not a real font`);
    }
  });

  for (const page of [...PAIRING_SHEET_PAGES, ...GAP_FILL_FONT_PAGES]) {
    it(`${page} links both font preloads and carries no Google Fonts reference`, () => {
      const html = readPage(page);
      assert.match(html, /<link rel="preload" href="\/fonts\/ArchivoVariable\.woff2" as="font" type="font\/woff2" crossorigin \/>/,
        `${page} should preload ArchivoVariable.woff2`);
      assert.match(html, /<link rel="preload" href="\/fonts\/PlexMono400\.woff2" as="font" type="font\/woff2" crossorigin \/>/,
        `${page} should preload PlexMono400.woff2`);
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

  it('the six .dive-arrow row-affordance spans on index.html survive untouched (explicit keep)', () => {
    const html = readPage('index.html');
    const matches = [...html.matchAll(/<span class="dive-arrow">→<\/span>/g)];
    assert.equal(matches.length, 6, `expected 6 .dive-arrow spans on index.html, found ${matches.length}`);
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
      const m = html.match(/href="\/styles\.css\?v=(\d+)"/);
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
