'use strict';

/**
 * test/helpers/type-metrics.js — SPACING-0927 Round 5 (rule 9 / B-7)
 *
 * A page's TYPE fingerprint at 1280: for every heading (h1-h6), paragraph,
 * list item, link and button in the page's main content, a stable key
 * (which top-level section it's in, its tag, and its order among same-tag
 * elements within that section -- NOT its position in the DOM tree, which
 * an added wrapper or an unrelated markup change elsewhere on the page can
 * shift) paired with the seven CSS-computed properties a font/colour
 * change would show up in: font-size, font-weight, line-height,
 * font-family, letter-spacing, text-transform, color. No text content, no
 * position, no size of any box -- a copy change or a different font
 * rasterizer cannot move this fixture.
 *
 * Used both to build the committed baseline (from a staged origin/main
 * copy, build-time only) and by the live test (from the staged built
 * tree) -- the SAME function, so the two sides are captured the same way.
 */

const TRACKED_TAGS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'A', 'BUTTON'];

// Self-contained: page.evaluate() serializes this function's source and
// runs it in an isolated browser context, so it cannot close over
// TRACKED_TAGS (or anything else) from module scope -- the tag list is
// declared again, inline, as the function's own first statement.
function extractTypeMetrics() {
  const TRACKED_TAGS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'A', 'BUTTON'];
  function cs(el) { return getComputedStyle(el); }
  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const s = cs(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (parseFloat(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // "The page's main content": <main> when the page has one; the legal
  // template (.legal-wrap sits directly in <body>, no <main>) falls back
  // to <body> with nav/footer excluded, the same convention this build's
  // other measurement code already uses.
  const mainRoot = document.querySelector('main') || document.body;
  const skipTags = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'NAV', 'FOOTER']);

  // Round 5 R5-4: the signed-in dashboard's review/pending-queue card is
  // excluded (production's own review-table markup differs from this
  // build's, unrelated to spacing or type work in scope here).
  const EXCLUDED_SELECTOR = '#pending-review-card';

  function isExcluded(el) {
    return !!el.closest(EXCLUDED_SELECTOR);
  }

  // Top-level sections: direct <section> children of mainRoot, in document
  // order. A page with none (a single-column prose page, or a page whose
  // real content sits directly in mainRoot with no <section> wrapper at
  // all) is treated as ONE implicit section (mainRoot itself) -- this
  // keeps "which section" stable even when a page's own top-level
  // structure isn't a <section> stack, matching every other measurement
  // helper in this build.
  const directSections = Array.from(mainRoot.children).filter(
    (el) => el.tagName === 'SECTION' && isVisible(el) && !isExcluded(el)
  );
  const sections = directSections.length > 0 ? directSections : [mainRoot];

  const headingCounts = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
  const elements = [];

  sections.forEach((section, sectionIdx) => {
    // Per-tag running order WITHIN this section, so an added wrapper
    // anywhere inside it (which changes DOM depth/position but not which
    // section an element belongs to, nor its order among same-tag
    // siblings) can't shift the key.
    const perTagOrder = {};
    const all = section.matches('h1,h2,h3,h4,h5,h6,p,li,a,button')
      ? [section, ...section.querySelectorAll('*')]
      : [...section.querySelectorAll('*')];
    for (const el of all) {
      if (!TRACKED_TAGS.includes(el.tagName)) continue;
      if (!isVisible(el)) continue;
      if (isExcluded(el)) continue;
      const tag = el.tagName.toLowerCase();
      const ordinal = perTagOrder[tag] || 0;
      perTagOrder[tag] = ordinal + 1;
      if (headingCounts[tag] !== undefined) headingCounts[tag]++;
      const s = cs(el);
      elements.push({
        key: `s${sectionIdx}.${tag}[${ordinal}]`,
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        lineHeight: s.lineHeight,
        fontFamily: s.fontFamily,
        letterSpacing: s.letterSpacing,
        textTransform: s.textTransform,
        color: s.color,
      });
    }
  });

  return {
    sectionCount: sections.length,
    headingCounts,
    elements,
  };
}

module.exports = { extractTypeMetrics, TRACKED_TAGS };
