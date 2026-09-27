'use strict';

/**
 * test/launch-wave-fixes-frontend.test.js — FIX-UNIT (FRONT END BUILDER),
 * site/launch-wave-0926, 2026-09-26.
 *
 * Covers the fixes assigned to the front-end builder in FIX-UNIT.md that
 * span multiple pages or don't already have a natural home in an existing
 * per-page test file:
 *   A1  — copy buttons announce their result (all 5 in-scope pages)
 *   A7  — review-queue scrolling region is keyboard reachable
 *   L9  — /for-agents five-step grid, no empty tile at 601-1099px
 *   L10 — dead CSS removed, stale comments fixed
 *
 * A2, A3, A5b, and A6+L8 (dashboard-only, or dashboard+homepage) live in
 * test/launch-wave-dashboard.test.js / test/launch-wave-home.test.js
 * instead, alongside the existing tests for the same markup.
 *
 * Style: static source-slice + regex/substring assertions against the
 * files on disk, per BUILDER-RULES and the convention already used in
 * test/launch-wave-dashboard.test.js. Every assertion lives inside an
 * it()/before(), and every loop carrying a test's only assertions is
 * guarded by an assertion that the list being iterated is not empty (repo
 * CH-7 guard).
 *
 * Runner: node --test test/launch-wave-fixes-frontend.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO, 'public');

function read(file) {
  return fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
}

const INDEX_HTML = read('index.html');
const CONNECT_HTML = read('connect.html');
const FOR_AGENTS_HTML = read('for-agents.html');
const FOR_BUILDERS_HTML = read('for-builders.html');
const DASHBOARD_HTML = read('dashboard.html');
const STYLES_CSS = read('styles.css');
const PRICING_HTML = read('pricing.html');

function sliceBetween(source, startMarker, endMarker, fromIndex) {
  const start = source.indexOf(startMarker, fromIndex || 0);
  assert.ok(start > -1, `marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `end marker not found after start: ${endMarker}`);
  return source.slice(start, end);
}

// ─── A1: copy buttons announce their result ────────────────────────────────
//
// REVIEW-ACCESSIBILITY.md #1: a static aria-label froze the accessible name
// while the visible text changed to "copied!", so the status was invisible
// to a screen reader (zero aria-live regions sitewide). Fix, applied
// identically everywhere the copy function exists in this unit's file
// scope: the aria-label now updates together with the visible text, and a
// shared polite live region (#copy-status) announces the change once. The
// reset after the timeout clears the live region (never re-announced).
// api.html and how-it-works.html carry the identical pre-existing pattern
// but are NOT in this builder's file scope (see FIX-UNIT.md) and are left
// unfixed; reported separately.

describe('FIX-UNIT A1: copy buttons announce their result', () => {
  const pages = [
    {
      name: 'index.html',
      html: INDEX_HTML,
      fnStartMarker: 'function copyCode(preId, btnId) {',
      fnEndMarker: '// ── FAQ toggle (AD sheet 9: shared accordion component) ─────────────',
    },
    {
      name: 'connect.html',
      html: CONNECT_HTML,
      fnStartMarker: 'function copyCode(preId, btnId) {',
      fnEndMarker: '</script>',
    },
    {
      name: 'for-agents.html',
      html: FOR_AGENTS_HTML,
      fnStartMarker: 'function copyCode(preId, btnId) {',
      fnEndMarker: '// FAQ toggle (AD sheet 9: shared accordion component)',
    },
    {
      name: 'for-builders.html',
      html: FOR_BUILDERS_HTML,
      fnStartMarker: 'function copyCode(preId, btnId) {',
      fnEndMarker: '// FAQ toggle (AD sheet 9: shared accordion component)',
    },
    {
      name: 'dashboard.html',
      html: DASHBOARD_HTML,
      fnStartMarker: 'window.copyDashSetupCode = function () {',
      fnEndMarker: 'function legacyCopy(text, done) {',
    },
  ];

  it('sanity: the page list under test is not empty', () => {
    assert.ok(pages.length === 5, `expected 5 pages in scope, got ${pages.length}`);
  });

  it('every in-scope page carries the shared #copy-status polite live region, off-screen via .visually-hidden', () => {
    for (const p of pages) {
      assert.match(
        p.html,
        /<span id="copy-status" role="status" aria-live="polite" class="visually-hidden"><\/span>/,
        `${p.name}: missing the #copy-status live region`,
      );
    }
    assert.match(STYLES_CSS, /\.visually-hidden\s*\{[^}]*clip:\s*rect\(0,\s*0,\s*0,\s*0\)/, 'styles.css must define .visually-hidden as an off-screen (not display:none) clip region, so it stays in the accessibility tree');
  });

  it('every in-scope page\'s copy function updates aria-label together with the visible "copied!" text, writes the live region once, and clears (never re-announces) the reset', () => {
    for (const p of pages) {
      const fn = sliceBetween(p.html, p.fnStartMarker, p.fnEndMarker);
      assert.match(fn, /textContent = 'copied!'/, `${p.name}: visible text must still become "copied!"`);
      assert.match(fn, /setAttribute\('aria-label', 'copied!'\)/, `${p.name}: aria-label must be set to "copied!" alongside the visible text, so the accessible name and visible text agree`);
      assert.match(fn, /status(?:\.textContent| && status\.textContent) = 'copied!'/, `${p.name}: the live region must receive the "copied!" announcement exactly once on success`);
      assert.match(fn, /status\.textContent = '';?\s*$/m, `${p.name}: the live region must be cleared (not re-announced) when the label resets`);
      assert.match(fn, /originalLabel/, `${p.name}: the original aria-label must be captured so it can be restored on reset`);
    }
  });

  it('api.html and how-it-works.html (out of this builder\'s file scope) still carry the pre-fix pattern -- confirms the defect is real and unfixed there, not silently fine', () => {
    const outOfScope = [
      fs.readFileSync(path.join(PUBLIC_DIR, 'api.html'), 'utf8'),
      fs.readFileSync(path.join(PUBLIC_DIR, 'how-it-works.html'), 'utf8'),
    ];
    for (const html of outOfScope) {
      assert.ok(!/id="copy-status"/.test(html), 'expected no live region yet on the out-of-scope pages (documents current state, not a request to leave it broken)');
    }
  });
});

// ─── A7: review-queue scrolling region is keyboard reachable ───────────────
//
// REVIEW-ACCESSIBILITY.md #7: .triage-table-wrap (built in JS with only a
// className) has no tabindex, so a keyboard-only user cannot scroll it to
// reach the Lane/signals, Title, and Submitted columns. Fix: tabindex="0",
// role="region", and a short accessible name.

describe('FIX-UNIT A7: review-queue scroll region is keyboard reachable', () => {
  it('the wrap element created in JS carries tabindex="0", role="region", and an aria-label', () => {
    const fn = sliceBetween(DASHBOARD_HTML, '// Triage table', 'var table = document.createElement');
    assert.match(fn, /wrap\.className = 'triage-table-wrap';/, 'sanity: still the right element');
    assert.match(fn, /wrap\.setAttribute\('tabindex', '0'\)/, 'tabindex="0" makes the wrapper a Tab stop');
    assert.match(fn, /wrap\.setAttribute\('role', 'region'\)/, 'role="region" gives assistive tech a landmark to announce');
    assert.match(fn, /wrap\.setAttribute\('aria-label', '[^']+'\)/, 'a short accessible name is set');
  });
});

// ─── L9: /for-agents five-step grid, no empty tile at 601-1099px ───────────
//
// REVIEW-CODE-SECURITY.md L9: at 3 columns (601-1099px), row 2 holds only
// steps 04-05, leaving the 6th cell an empty tinted tile
// (scratchpad/review/flow-track-1000.png). Fix: step 05 spans the row's
// last two columns at that width, and is reset to auto at <=600px so it
// never spans beyond the single column that exists there.

describe('FIX-UNIT L9: /for-agents five-step grid has no empty tile between 601 and 1099px', () => {
  it('the 1099px tier gives .flow-step:last-child grid-column: span 2, and the 600px tier resets it to auto', () => {
    const tier1099 = sliceBetween(FOR_AGENTS_HTML, '@media (max-width: 1099px) {', '@media (max-width: 900px) {');
    assert.match(tier1099, /\.flow-track\s*\{\s*grid-template-columns:\s*repeat\(3,\s*1fr\);\s*\}/, 'sanity: still 3 columns at this tier');
    assert.match(tier1099, /\.flow-step:last-child\s*\{\s*grid-column:\s*span 2;\s*\}/, 'step 05 must span the last two columns so row 2 has no empty cell');

    const tier600 = sliceBetween(FOR_AGENTS_HTML, '@media (max-width: 600px) {', '.page-hero { padding: var(--hero-pad-mobile); }');
    assert.match(tier600, /\.flow-track\s*\{\s*grid-template-columns:\s*1fr;\s*\}/, 'sanity: still 1 column at this tier');
    assert.match(tier600, /\.flow-step:last-child\s*\{\s*grid-column:\s*auto;\s*\}/, 'the span must be reset to auto in the single-column tier, so it never requests a 2nd column that does not exist');
  });

  it('there are exactly 5 .flow-step elements (01-05), so ":last-child" unambiguously targets step 05', () => {
    const matches = FOR_AGENTS_HTML.match(/<div class="flow-step">/g) || [];
    assert.equal(matches.length, 5, 'expected exactly 5 .flow-step elements');
  });
});

// ─── L10: dead CSS removed, stale comments fixed ───────────────────────────
//
// REVIEW-CODE-SECURITY.md L10: .hero-trust, .how-intro, and .feature-list
// have no markup consumer anywhere in public/ or server.js (confirmed by
// search below, reproducing the reviewer's corpus scan). Also: the
// .hero-ledger.is-live comment claimed centering when the rule is
// flex-start, and a pricing.html comment described a .pricing-hero-stats
// base rule that no longer exists.

describe('FIX-UNIT L10: dead CSS removed, stale comments fixed', () => {
  const deadClasses = ['hero-trust', 'how-intro', 'feature-list'];
  // Classes with an overlapping substring in deadClasses that must NOT be
  // caught by a naive .includes() search (false-positive guard).
  const stillLiveLookalikes = ['agent-feature-list', 'builder-feature-list'];

  it('sanity: the dead-class and lookalike lists are not empty', () => {
    assert.ok(deadClasses.length === 3 && stillLiveLookalikes.length === 2);
  });

  it('none of the three dead classes are still declared in styles.css', () => {
    for (const cls of deadClasses) {
      assert.ok(!new RegExp(`\\.${cls}\\b`).test(STYLES_CSS), `.${cls} must have no rule left in styles.css`);
    }
  });

  it('none of the three dead classes are referenced by any markup or script in public/ or server.js', () => {
    const serverJs = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
    const htmlFiles = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));
    assert.ok(htmlFiles.length > 0, 'sanity: found public html files to scan');
    for (const cls of deadClasses) {
      const needle = `"${cls}` ; // covers class="hero-trust ..." and class="hero-trust"
      assert.ok(!serverJs.includes(needle), `server.js must not reference ${cls}`);
      for (const file of htmlFiles) {
        const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
        assert.ok(!html.includes(needle), `${file} must not reference ${cls} in markup`);
      }
    }
  });

  it('the lookalike classes (agent-feature-list, builder-feature-list) are untouched -- proves the removal was scoped to the exact dead class, not a broad substring match', () => {
    // These two live in pricing.html's own page-scoped <style>, not styles.css.
    for (const cls of stillLiveLookalikes) {
      assert.ok(new RegExp(`\\.${cls}\\b`).test(PRICING_HTML), `.${cls} should still be a live rule in pricing.html`);
    }
  });

  it('the .hero-ledger.is-live comment no longer claims the rule centers the ledger', () => {
    const region = sliceBetween(STYLES_CSS, '.hero-ledger {', '.hero-ledger .hero-ledger-num {');
    assert.match(region, /justify-content:\s*flex-start;/, 'sanity: the rule itself is still flex-start');
    assert.ok(!/centers it/.test(region), 'the comment must no longer claim the rule centers the ledger (it left-aligns)');
  });

  it('the pricing.html comment above the max-width:600px .pricing-hero-stats override no longer describes a deleted base rule as if it still exists', () => {
    const region = sliceBetween(PRICING_HTML, '/* FIX-UNIT L10:', '.pricing-hero-stats { max-width: 320px; }');
    assert.match(region, /removed outright/i, 'comment must say the base rule was removed, not describe it as current behavior');
    assert.ok(!/text-align: left is a no-op/.test(region), 'the old stale wording must be gone');
  });
});
