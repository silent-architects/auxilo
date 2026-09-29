'use strict';

/**
 * test/helpers/spacing-metrics.js — SPACING-0927 (BUILD-BRIEF-SPACING.md)
 *
 * Shared measurement helpers for the uniform-spacing test suite
 * (test/spacing-frame.test.js, test/spacing-sections.test.js,
 * test/spacing-scale-sweep.test.js). Adapted from the Art Director's own
 * measuring script (scratch build/ad-spacing/measure.js), copied in as the
 * brief instructs ("Copy the script into your tests as the base of your
 * measuring"), trimmed to what these tests read and extended with a
 * heading/paragraph computed-style capture (for the B-7 regression test)
 * and a full spacing sweep (rule 7 / A3-8).
 *
 * The tokens below are the Art Director's ruled system
 * (SPACING-SHEET.md §A1/A1b/A2), not measurements — these are the values a
 * page must produce, checked against what page.evaluate(extractPageMetrics)
 * actually measures in the browser.
 */

// ── A1: layout tier ─────────────────────────────────────────────────────
const GUTTER = { 1280: 90, 768: 20, 375: 16 };
const RHYTHM = { 1280: 120, 768: 80, 375: 64 };
const FOOTER_PAD = { top: 32, bottom: 32 };

// ── A1b: reading-column pages ───────────────────────────────────────────
const READING_GUTTER = { 1280: 304, 768: 44, 375: 16 };
const READING_MAX_W = 720;

// ── A2: content scale (every value a multiple of 4) ─────────────────────
const SCALE_STEPS = [4, 8, 16, 24, 32, 48, 64];
const HAIRLINE = 2;

// Every numeric px value this build's ruled system can legitimately
// produce for a non-zero margin/padding/gap: the content scale, the
// layout tokens (gutter + rhythm at all three widths, reading-column
// gutter), and the reserved hairline. Rule 7 / A3-8.
const NAV_CLEAR = 99;

const ALLOWED_SPACING_VALUES = new Set([
  ...SCALE_STEPS,
  ...Object.values(GUTTER),
  ...Object.values(RHYTHM),
  NAV_CLEAR,
  ...Object.values(READING_GUTTER),
  HAIRLINE,
]);

const READING_PAGES = new Set([
  '/about', '/connect', '/terms', '/privacy',
  '/legal/subprocessors', '/legal/supported-clients',
]);

const TOLERANCE = 0.5;

function within(a, b, tol = TOLERANCE) {
  return Math.abs(a - b) <= tol;
}

// The in-browser extraction function. Passed whole to page.evaluate(), so
// it must be self-contained (no closures over outer scope). `opts.proseMain`
// is true only for the two reading-column pages whose real <main> holds
// prose directly (about/connect) -- <main> itself is then the sole
// section-equivalent block, not one per paragraph. Every other page
// (including the legal template, which has no <main> at all and already
// falls back to <body> with nav/footer excluded) decomposes into its real
// per-child blocks, whatever tag they use (<section> or a plain <div>, as
// status.html's .status-hero/.status-body and works-with's .ww-wrap are).
function extractPageMetrics(opts) {
  const proseMain = !!(opts && opts.proseMain);
  function rect(el) { return el.getBoundingClientRect(); }
  function round(n) { return Math.round(n * 100) / 100; }
  function cs(el) { return getComputedStyle(el); }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const s = cs(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (parseFloat(s.opacity) === 0) return false;
    const r = rect(el);
    return r.width > 0 && r.height > 0;
  }

  function isLeafContent(el) {
    const tag = el.tagName.toUpperCase();
    if (['IMG', 'SVG', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'IFRAME', 'A'].includes(tag)) {
      const hasBlockKid = Array.from(el.children).some((k) => isVisible(k));
      if (tag === 'A' || tag === 'BUTTON') return !hasBlockKid;
      return true;
    }
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && node.textContent.trim().length > 0) return true;
    }
    return el.children.length === 0 && el.textContent.trim().length > 0;
  }

  function shortSelector(el) {
    if (!el) return null;
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = (el.className && typeof el.className === 'string') ? el.className.trim() : '';
    if (cls) s += '.' + cls.split(/\s+/).slice(0, 3).join('.');
    return s;
  }

  function hasScrollableAncestor(el, root) {
    let p = el.parentElement;
    while (p) {
      const ps = cs(p);
      if (ps.overflowX === 'auto' || ps.overflowX === 'scroll') return true;
      if (p === root) return false;
      p = p.parentElement;
    }
    return false;
  }

  function unionBox(root) {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity, count = 0;
    const all = [root, ...root.querySelectorAll('*')];
    for (const el of all) {
      if (!isVisible(el)) continue;
      const s = cs(el);
      if (s.position === 'fixed') continue;
      // A deliberately horizontally-scrollable box (a wide code sample or
      // table inside its own overflow-x:auto wrapper, e.g. .code-block pre,
      // .endpoint-table-wrap, .pricing-table-wrap) can report a natural
      // width and height far larger than what is ever visible -- letting
      // it (or anything inside it) into the union badly distorts both the
      // horizontal AND vertical extent used for gutter/seam measurement.
      // The clipping wrapper itself is usually not a "leaf" (it has block
      // children) so it never contributes its own oversized rect either.
      if (el !== root && (s.overflowX === 'auto' || s.overflowX === 'scroll')) continue;
      if (el !== root && hasScrollableAncestor(el, root)) continue;
      if (!isLeafContent(el)) continue;
      const rc = rect(el);
      if (rc.width === 0 && rc.height === 0) continue;
      l = Math.min(l, rc.left); t = Math.min(t, rc.top);
      r = Math.max(r, rc.right); b = Math.max(b, rc.bottom);
      count++;
    }
    if (count === 0) return null;
    return { left: round(l), top: round(t), right: round(r), bottom: round(b), width: round(r - l), height: round(b - t) };
  }

  function contentWrapper(block) {
    let cur = block;
    for (let i = 0; i < 6; i++) {
      const kids = Array.from(cur.children).filter(isVisible);
      if (kids.length !== 1) break;
      cur = kids[0];
    }
    return cur;
  }

  function paddingOf(el) {
    const s = cs(el);
    return {
      top: parseFloat(s.paddingTop) || 0,
      right: parseFloat(s.paddingRight) || 0,
      bottom: parseFloat(s.paddingBottom) || 0,
      left: parseFloat(s.paddingLeft) || 0,
    };
  }

  function borderOf(el) {
    const s = cs(el);
    return {
      top: parseFloat(s.borderTopWidth) || 0,
      bottom: parseFloat(s.borderBottomWidth) || 0,
    };
  }

  const viewportW = window.innerWidth;
  const out = { viewportW, url: location.pathname };

  // ── Nav ──────────────────────────────────────────────────────────────
  const nav = document.getElementById('main-nav') || document.querySelector('nav');
  if (nav) {
    const navRect = rect(nav);
    const navRow = nav.querySelector('.nav-row');
    const navStrip = nav.querySelector('.nav-strip');
    const navLogo = document.getElementById('nav-logo') || nav.querySelector('a, .nav-logo');
    const navLogoRect = navLogo ? rect(navLogo) : null;
    const navCta = nav.querySelector('.nav-strip a, .nav-row .nav-cta');
    const navCtaRect = navCta ? rect(navCta) : null;
    out.nav = {
      selector: shortSelector(nav),
      rect: { top: round(navRect.top), bottom: round(navRect.bottom), left: round(navRect.left), right: round(navRect.right), height: round(navRect.height) },
      rowPaddingLeft: navRow ? parseFloat(cs(navRow).paddingLeft) : null,
      rowPaddingRight: navRow ? round(viewportW - rect(navRow).right + parseFloat(cs(navRow).paddingRight)) : null,
      stripPaddingLeft: navStrip ? parseFloat(cs(navStrip).paddingLeft) : null,
      logoLeft: navLogoRect ? round(navLogoRect.left) : null,
      ctaRight: navCtaRect ? round(viewportW - navCtaRect.right) : null,
    };
  } else {
    out.nav = null;
  }

  // ── Main root + top-level blocks ────────────────────────────────────
  // A page with no <main> (the legal template: .legal-wrap sits directly
  // in <body>, beside <nav> and <footer>, not inside one) falls back to
  // <body> -- NAV and FOOTER are excluded explicitly so they are never
  // measured as if they were a top-level "section" in the rhythm sense.
  const realMain = document.querySelector('main');
  const mainRoot = realMain || document.body;
  const skipTags = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'NAV', 'FOOTER']);
  const rawChildren = Array.from(mainRoot.children).filter((el) => isVisible(el) && !skipTags.has(el.tagName));
  // works-with.html has no distinct hero wrapper: <main class="ww-main">
  // itself carries the rhythm padding and its single child (.ww-wrap) is
  // the container-equivalent -- <main> IS the section here, same as the
  // proseMain case, just detected structurally (exactly one child) instead
  // of by route.
  const singleChild = rawChildren.length === 1;
  const blocks = (realMain && (proseMain || singleChild)) ? [realMain] : rawChildren;

  out.sections = blocks.map((el, idx) => {
    const secRect = rect(el);
    const pad = paddingOf(el);
    const bord = borderOf(el);
    const wrapper = contentWrapper(el);
    const wRect = rect(wrapper);
    const wPad = paddingOf(wrapper);
    // R2-1 (round 2): the section's content edge, top and bottom, is the
    // content WRAPPER's own border-box (the same single-child-descended
    // element the gutter already uses) -- not a deep union of every leaf
    // text node. A leaf-level union double-counts a first/last block's OWN
    // internal padding (e.g. a status banner's 20px card padding, or a
    // grid cell's own padding) as if it were extra space BETWEEN sections,
    // which it is not (that is rule 6's card-padding scope, not rule 4's
    // seam). The wrapper's own box already accounts for a grid's true
    // multi-row height (a grid container's height is its rows' content,
    // not any one cell's), so this is still exact for grids, not just
    // single-block sections. Wrapper padding is 0 on every conforming
    // section (B0-a: a section's own .container/*-content wrapper never
    // carries its own padding), so the wrapper's border-box top/bottom IS
    // the content edge.
    const content = { top: round(wRect.top), bottom: round(wRect.bottom), left: round(wRect.left + wPad.left), right: round(wRect.right - wPad.right) };
    return {
      index: idx,
      selector: shortSelector(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      rect: { top: round(secRect.top), bottom: round(secRect.bottom), left: round(secRect.left), right: round(secRect.right), height: round(secRect.height) },
      padding: pad,
      contentBox: content,
      wrapperSelector: shortSelector(wrapper),
      boxGutterLeft: round(wRect.left + wPad.left),
      boxGutterRight: round(viewportW - (wRect.right - wPad.right)),
      // A section's own border (a decorative hairline divider, e.g.
      // #api-hero's 1px border-bottom, or the raised/ground alternation's
      // 1px border-top+bottom) sits OUTSIDE the padding box and is not
      // part of the ruled spacing system -- subtracted here so a border
      // doesn't read as an extra 1px of "space."
      spaceAboveFirst: content ? round(content.top - secRect.top - bord.top) : null,
      spaceBelowLast: content ? round(secRect.bottom - bord.bottom - content.bottom) : null,
      navClearance: (idx === 0 && nav) ? round(content.top - rect(nav).bottom) : null,
      border: bord,
    };
  });

  out.seams = [];
  for (let i = 1; i < out.sections.length; i++) {
    const prev = out.sections[i - 1];
    const cur = out.sections[i];
    if (prev.contentBox && cur.contentBox) {
      out.seams.push({
        from: prev.selector,
        to: cur.selector,
        prevPaddingBottom: prev.padding.bottom,
        curPaddingTop: cur.padding.top,
        // A raised/ground section's own 1px border-bottom/border-top (the
        // site's existing visual alternation hairline, styles.css
        // ".section-raised/.section-ground") sits between the two
        // sections' content, outside either one's padding box -- real,
        // visible, deliberate, and not part of the rhythm sum.
        prevBorderBottom: prev.border.bottom,
        curBorderTop: cur.border.top,
        contentGap: round(cur.contentBox.top - prev.contentBox.bottom),
      });
    }
  }

  // ── Footer ───────────────────────────────────────────────────────────
  const footer = document.querySelector('footer');
  if (footer) {
    const fRect = rect(footer);
    const fInner = contentWrapper(footer);
    const fInnerRect = rect(fInner);
    const fInnerPad = paddingOf(fInner);
    out.footer = {
      selector: shortSelector(footer),
      rect: { top: round(fRect.top), bottom: round(fRect.bottom) },
      padding: paddingOf(footer),
      boxGutterLeft: round(fInnerRect.left + fInnerPad.left),
      boxGutterRight: round(viewportW - (fInnerRect.right - fInnerPad.right)),
    };
  } else {
    out.footer = null;
  }

  return out;
}

// Extended extraction for the regression fixture (rule 9 / B-7): page text,
// section count, and every heading/paragraph's computed type metrics.
function extractRegressionFixture() {
  function cs(el) { return getComputedStyle(el); }
  const sectionCount = document.querySelectorAll('section').length;
  const bodyText = document.body.innerText.replace(/\s+/g, ' ').trim();
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((el) => {
    const s = cs(el);
    return {
      tag: el.tagName,
      text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 80),
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      lineHeight: s.lineHeight,
      color: s.color,
    };
  });
  const paragraphs = [...document.querySelectorAll('p')].map((el) => {
    const s = cs(el);
    return {
      text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 80),
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      lineHeight: s.lineHeight,
      color: s.color,
    };
  });
  return { sectionCount, bodyText, headings, paragraphs };
}

// Rule 7 / A3-8: walk every element in <main> (or <body>), collect every
// non-zero margin/padding/gap, skip anything inside a button/badge/input/
// table cell, and report values that are not 0, on the content scale, a
// named layout token, or the hairline.
function sweepSpacingViolations() {
  function cs(el) { return getComputedStyle(el); }
  function shortSelector(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = (el.className && typeof el.className === 'string') ? el.className.trim() : '';
    if (cls) s += '.' + cls.split(/\s+/).slice(0, 3).join('.');
    return s;
  }
  // R2-3 (round 2, coordinator ruling), stated exactly:
  // Out: inside a button, a badge, an input, a table cell, a code block's
  // own header and body, the navigation bar's own vertical padding and the
  // items in it, the footer's own internal layout. The signed in
  // dashboard's cards, the Terms dialog, the review table. Anything a page
  // draws in an SVG.
  const EXCLUDED_SELECTOR = [
    'button', '.btn-primary', '.btn-secondary',                 // a button
    '.badge', '.pricing-pill', '.tool-tag', '.ep-method',        // a badge
    '.auth-badge', '.count-badge', '.flow-step-tag', '.purchase-stripe-badge', // a badge (site-wide inline-block pill labels)
    'input', 'textarea', 'select',                               // an input
    'td', 'th',                                                  // a table cell
    '.code-block',                                               // a code block's own header AND body
    'nav', '#main-nav',                                          // the nav bar's own vertical padding + its items
    'footer',                                                    // the footer's own internal layout
    '.dash-card', '#terms-dialog', '#terms-dialog-overlay',      // dashboard cards, Terms dialog, review table (inside a card)
    'svg',                                                       // anything a page draws in an SVG
  ].join(', ');
  function isInsideExcluded(el) {
    return !!el.closest(EXCLUDED_SELECTOR);
  }
  const root = document.querySelector('main') || document.body;
  // marginLeft/marginRight are deliberately not swept: every horizontal
  // margin in this codebase's patterns is either 0 or the browser-computed
  // remainder of `margin: 0 auto` centering (e.g. a reading column or
  // .faq-list's own max-width) -- an emergent side effect of centering
  // math at a given viewport width, not an authored spacing decision, the
  // same category as the page gutter's own auto-margin component (a
  // layout token, not a content-scale value). The page-gutter rule (rule
  // 1/2, spacing-frame.test.js) already checks horizontal placement.
  const props = ['marginTop', 'marginBottom', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'rowGap', 'columnGap'];
  const violations = [];
  const allowed = new Set(JSON.parse(document.body.getAttribute('data-spacing-allowed') || '[]'));
  const all = [root, ...root.querySelectorAll('*')];
  for (const el of all) {
    if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) continue;
    if (isInsideExcluded(el)) continue;
    const s = cs(el);
    for (const prop of props) {
      const raw = s[prop];
      if (!raw || raw === '0px' || raw === 'normal') continue;
      const v = parseFloat(raw);
      if (!Number.isFinite(v) || v === 0) continue;
      const rounded = Math.round(v * 100) / 100;
      if (allowed.has(rounded)) continue;
      violations.push({ selector: shortSelector(el), prop, value: rounded });
    }
  }
  return violations;
}

module.exports = {
  GUTTER,
  RHYTHM,
  FOOTER_PAD,
  READING_GUTTER,
  READING_MAX_W,
  SCALE_STEPS,
  HAIRLINE,
  NAV_CLEAR,
  ALLOWED_SPACING_VALUES,
  READING_PAGES,
  TOLERANCE,
  within,
  extractPageMetrics,
  extractRegressionFixture,
  sweepSpacingViolations,
};
