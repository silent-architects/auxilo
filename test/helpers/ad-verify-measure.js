'use strict';

/**
 * test/helpers/ad-verify-measure.js — SPACING-0927 Round 3 (FIX-UNIT-SPACING-3.md)
 *
 * The Art Director's own independent measurement, copied in per M-1
 * ("Copy the Art Director's verify-measure.js and rules-check.js into
 * test/helpers/, and build your spacing tests on them. Where your own
 * helper measured the same rule differently, the Art Director's
 * measurement replaces it.") and adapted from a standalone script into an
 * importable module: `main()`/file-staging/screenshot code is stripped
 * (the test files already have their own staged-server.js boot sequence),
 * `extractPageMetrics` and `foldCheck` are exported directly for
 * `page.evaluate()`.
 *
 * The verbatim original (as delivered) is reference-only and does not
 * live in the repository (per the coordinator's Round 3 resume note); this
 * file is the one the spacing tests actually import.
 *
 * Two rule extensions on top of the Art Director's own method, both
 * required by FIX-UNIT-SPACING-3.md:
 *
 *   M-3 (box-edge extension): "The gap under a heading is measured from
 *   the heading's bottom to the first visible thing that follows it in
 *   reading order, through any wrapper. The first visible thing is
 *   whichever comes first: a line of text, an image or a drawing, or the
 *   visible edge of a box. A box has a visible edge when it has a border
 *   with a width above 0 and a colour that is not transparent, or a
 *   background that differs from the background behind it. Extend the
 *   prober to find a box edge. The Art Director's prober looks for text
 *   only, which is why a heading above a row of bordered cards read as
 *   48." `firstVisibleThingAfter` (renamed from the original's
 *   `firstTextLineAfter` to reflect the widened contract) now checks, for
 *   every element visited during the forward walk, whether it qualifies
 *   as a bordered/backgrounded box BEFORE checking whether it has its own
 *   text -- so the walk stops at the box's own top edge instead of
 *   descending into it and returning a deeper, unrelated text leaf (which
 *   is what inflated a heading-to-card-row gap by the card's own internal
 *   padding, e.g. 16 + 32 = 48).
 *
 *   M-4: "A scrollable code block is measured by its visible box, not by
 *   the full height of what it holds." The Art Director's own unionBox()
 *   (used for section content-box / gutter measurement) did not exclude a
 *   horizontally- or vertically-scrollable descendant's un-clipped natural
 *   size -- confirmed by the Art Director's own report as the cause of an
 *   apparent overlap on /api (investigated directly, ruled a measurement
 *   artifact, not a rendering defect). Ported in from this build's prior
 *   round unionBox (test/helpers/spacing-metrics.js), which already
 *   excluded overflow:auto/scroll boxes and their descendants for exactly
 *   this reason.
 */

const WIDTHS = [1280, 768, 375];

function extractPageMetrics() {
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

  // M-3 (extended to section/seam measurement, not just heading gaps): "a
  // box has a visible edge when it has a border with a width above 0 and a
  // colour that is not transparent, or a background that differs from the
  // background behind it." A bordered/backgrounded card (e.g. .code-block)
  // is not itself "leaf content" (isLeafContent above requires a direct
  // text node or no children at all) -- without this, unionBox() below
  // would ignore the card's own real, visible edge entirely and instead
  // hunt for a leaf text node inside it, which for a card whose inner
  // <pre> is a scrollable code block (M-4's own exclusion) means the union
  // finds NOTHING for that card at all: the section's measured bottom
  // silently skips over a whole visible card, understating the content
  // box by however tall that card is (the root cause of the worst seam
  // outliers: a card the reader plainly sees, that the measurement never
  // counted).
  function parseColor(str) {
    if (!str) return null;
    const m = str.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  function isBoxWithVisibleEdge(el) {
    if (el.tagName === 'IMG' || el.tagName === 'SVG' || el.tagName === 'CANVAS' || el.tagName === 'VIDEO') return true;
    const s = cs(el);
    const bw = [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].map((v) => parseFloat(v) || 0);
    const bc = [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor];
    const hasBorder = bw.some((w, i) => {
      if (w <= 0) return false;
      const c = parseColor(bc[i]);
      return c && c.a > 0;
    });
    if (hasBorder) return true;
    const own = parseColor(s.backgroundColor);
    if (!own || own.a === 0) return false;
    let p = el.parentElement;
    let behind = null;
    while (p) {
      const pc = parseColor(cs(p).backgroundColor);
      if (pc && pc.a > 0) { behind = pc; break; }
      p = p.parentElement;
    }
    if (!behind) return true;
    return !(own.r === behind.r && own.g === behind.g && own.b === behind.b && Math.abs(own.a - behind.a) < 0.02);
  }

  // M-4: a scrollable code block is measured by its own visible box, not
  // by the full un-clipped HEIGHT of what it holds. The real test is
  // whether the box actually clips vertically -- scrollHeight exceeding
  // clientHeight -- not merely the CSS overflow-y value. A box with
  // overflow-x:auto and no explicit height (e.g. .trust-table-wrap, which
  // only wants a sideways scroll on a narrow viewport for a wide table)
  // computes overflow-y to 'auto' too, per the CSS overflow spec's own
  // auto-correction rule for a box with only one axis set explicitly --
  // but with no height constraint, nothing is ever actually clipped
  // vertically: the box's own height simply grows to fit its content, and
  // every row stays fully visible top to bottom. Checking the computed
  // overflow-y value alone (as the first version of this check did)
  // treated that inert 'auto' the same as a real fixed-height scroll box,
  // silently dropping the whole table's height from the union and
  // inflating the seam to the next section by however tall the table
  // was -- the actual root cause of this build's largest seam outliers.
  // A "peek, then expand" code block (this codebase's own collapsed-
  // response pattern, e.g. #unlock-code's wrapper .code-block-scroll:
  // overflow-y:hidden, max-height:360px, toggled off by its own "Show the
  // full response" button) clips vertically exactly like a native
  // overflow-y:auto scrollbar does -- 'hidden' is included alongside
  // 'auto'/'scroll' here for that reason. 'visible' (the only value that
  // never clips) is excluded by name instead of enumerating every clipping
  // keyword, so 'clip' is covered too.
  function clipsAxis(value) {
    return value !== 'visible';
  }
  function clipsVertically(el) {
    return el.scrollHeight > el.clientHeight + 1;
  }
  // The same real-clipping test on the horizontal axis: a <pre> with a
  // long unwrapped line is exactly what overflow-x:auto is FOR -- its
  // true un-scrolled content width can run far past the viewport, and
  // that full width is not "visible" (M-4), only its own clientWidth is.
  // Checked independently of clipsVertically: a box can clip on one axis
  // and not the other (.trust-table-wrap clips X, never Y).
  function clipsHorizontally(el) {
    return el.scrollWidth > el.clientWidth + 1;
  }
  // Per-axis: an ancestor that clips only horizontally (.trust-table-wrap
  // on a narrow viewport) must not also hide its descendants' real
  // vertical position -- every row is still exactly where it visually
  // sits, just some of its width needs a sideways scroll to see. The two
  // axes are walked and returned independently so a descendant can be
  // trusted on Y while distrusted on X (or vice versa).
  function scrollExclusion(el, root) {
    let excludeX = false, excludeY = false;
    let p = el.parentElement;
    while (p) {
      const ps = cs(p);
      if (!excludeY && clipsAxis(ps.overflowY) && clipsVertically(p)) excludeY = true;
      if (!excludeX && clipsAxis(ps.overflowX) && clipsHorizontally(p)) excludeX = true;
      if (excludeX && excludeY) break;
      if (p === root) break;
      p = p.parentElement;
    }
    return { excludeX, excludeY };
  }

  function unionBox(root) {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity, count = 0;
    const all = [root, ...root.querySelectorAll('*')];
    for (const el of all) {
      if (!isVisible(el)) continue;
      const s = cs(el);
      if (s.position === 'fixed') continue;
      let excludeX = el !== root && clipsAxis(s.overflowX) && clipsHorizontally(el);
      let excludeY = el !== root && clipsAxis(s.overflowY) && clipsVertically(el);
      if (el !== root) {
        const anc = scrollExclusion(el, root);
        excludeX = excludeX || anc.excludeX;
        excludeY = excludeY || anc.excludeY;
      }
      if (excludeX && excludeY) continue;
      // A bordered/backgrounded box counts at its OWN edge (M-3, extended);
      // otherwise fall back to true leaf text content. The root itself is
      // excluded from the box-edge check -- every section trivially has a
      // visible edge against the page behind it, which would swallow the
      // whole union (content.top/bottom would just equal the section's own
      // box) and defeat the point of measuring content vs. padding at all.
      if (!(el !== root && isBoxWithVisibleEdge(el)) && !isLeafContent(el)) continue;
      const rc = rect(el);
      if (rc.width === 0 && rc.height === 0) continue;
      if (!excludeX) { l = Math.min(l, rc.left); r = Math.max(r, rc.right); }
      if (!excludeY) { t = Math.min(t, rc.top); b = Math.max(b, rc.bottom); }
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

  // R4-4 (RULING-SEAMS-2026-09-28.md): "A hairline is 1 pixel and sits
  // inside the block that draws it." unionBox() deliberately never treats
  // a SECTION's own border as a box-edge (only a non-root descendant's
  // border/background qualifies -- otherwise every section would trivially
  // "draw its own edge" against the page behind it and contentBox would
  // just equal the section's own outer box, defeating the point of
  // measuring content vs. padding). That means a section's own hairline
  // border sits OUTSIDE what contentBox measures -- captured here
  // separately so the seam check (rule 4) can add each side's own border,
  // the real visible pixels between one section's content and the next.
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
    const navContent = unionBox(nav);
    const navLogo = document.getElementById('nav-logo') || nav.querySelector('a, .nav-logo');
    const navLogoRect = navLogo ? rect(navLogo) : null;
    out.nav = {
      selector: shortSelector(nav),
      rect: { top: round(navRect.top), bottom: round(navRect.bottom), left: round(navRect.left), right: round(navRect.right), height: round(navRect.height) },
      padding: paddingOf(nav),
      contentLeft: navContent ? round(navContent.left) : null,
      contentRight: navContent ? round(viewportW - navContent.right) : null,
      logoLeft: navLogoRect ? round(navLogoRect.left) : null,
    };
  } else {
    out.nav = null;
  }

  // ── Main root + top-level blocks ────────────────────────────────────
  const mainRoot = document.querySelector('main') || document.body;
  const skipTags = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
  const blocks = Array.from(mainRoot.children).filter((el) => isVisible(el) && !skipTags.has(el.tagName));

  out.sections = blocks.map((el, idx) => {
    const secRect = rect(el);
    const content = unionBox(el);
    const pad = paddingOf(el);
    const bg = cs(el).backgroundColor;
    const wrapper = contentWrapper(el);
    const wRect = rect(wrapper);
    const wPad = paddingOf(wrapper);
    return {
      index: idx,
      selector: shortSelector(el),
      rect: { top: round(secRect.top), bottom: round(secRect.bottom), left: round(secRect.left), right: round(secRect.right), height: round(secRect.height) },
      padding: pad,
      border: borderOf(el),
      background: bg,
      contentBox: content,
      gutterLeft: content ? round(content.left - 0) : null,
      gutterRight: content ? round(viewportW - content.right) : null,
      wrapperSelector: shortSelector(wrapper),
      boxGutterLeft: round(wRect.left + wPad.left),
      boxGutterRight: round(viewportW - (wRect.right - wPad.right)),
      spaceAboveFirst: content ? round(content.top - secRect.top) : null,
      spaceBelowLast: content ? round(secRect.bottom - content.bottom) : null,
      navClearance: (idx === 0 && nav) ? round(content.top - rect(nav).bottom) : null,
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
        contentGap: round(cur.contentBox.top - prev.contentBox.bottom),
        boxGap: round(cur.rect.top - prev.rect.bottom),
      });
    }
  }

  // ── Footer ───────────────────────────────────────────────────────────
  const footer = document.querySelector('footer');
  if (footer) {
    const fRect = rect(footer);
    const fContent = unionBox(footer);
    out.footer = {
      selector: shortSelector(footer),
      rect: { top: round(fRect.top), bottom: round(fRect.bottom) },
      padding: paddingOf(footer),
      gutterLeft: fContent ? round(fContent.left - 0) : null,
      gutterRight: fContent ? round(viewportW - fContent.right) : null,
    };
  } else {
    out.footer = null;
  }

  // ── Repeated sibling groups (cards / list items / faq items / etc.) ──
  const groups = new Map();
  function pathOf(el) {
    let p = el, parts = [];
    for (let i = 0; i < 4 && p && p !== document.body; i++) {
      parts.unshift(shortSelector(p));
      p = p.parentElement;
    }
    return parts.join('>');
  }
  const allEls = mainRoot.querySelectorAll('*');
  for (const el of allEls) {
    if (!isVisible(el)) continue;
    const cls = (el.className && typeof el.className === 'string') ? el.className.trim() : '';
    if (!cls) continue;
    if (!el.parentElement) continue;
    const key = pathOf(el.parentElement) + ' > .' + cls.split(/\s+/).join('.');
    if (!groups.has(key)) groups.set(key, { className: cls, parentSelector: shortSelector(el.parentElement), els: [] });
    groups.get(key).els.push(el);
  }

  out.repeatedGroups = [];
  for (const [key, g] of groups) {
    if (g.els.length < 2) continue;
    const parent = g.els[0].parentElement;
    const parentCs = cs(parent);
    const paddings = g.els.map(paddingOf);
    const rects = g.els.map(rect);
    const heights = rects.map((r) => round(r.height));
    let rowGap = null, colGap = null;
    if (['flex', 'grid', 'inline-flex', 'inline-grid'].includes(parentCs.display)) {
      rowGap = parseFloat(parentCs.rowGap) || 0;
      colGap = parseFloat(parentCs.columnGap) || 0;
    }
    const vGaps = [];
    const hGaps = [];
    const rowTops = [];
    for (let i = 1; i < rects.length; i++) {
      const a = rects[i - 1], b = rects[i];
      const sameCol = Math.abs(a.left - b.left) <= 2;
      const sameRow = Math.abs(a.top - b.top) <= 2;
      if (sameRow) rowTops.push([round(a.top), round(b.top)]);
      if (sameCol && b.top > a.bottom - 1) vGaps.push(round(b.top - a.bottom));
      else if (sameRow && b.left > a.right - 1) hGaps.push(round(b.left - a.right));
    }
    out.repeatedGroups.push({
      key,
      className: g.className,
      parentSelector: g.parentSelector,
      parentDisplay: parentCs.display,
      parentBg: parentCs.backgroundColor,
      count: g.els.length,
      padding: paddings[0],
      paddingUniform: paddings.every((p) => p.top === paddings[0].top && p.right === paddings[0].right && p.bottom === paddings[0].bottom && p.left === paddings[0].left),
      heights,
      heightsUniform: heights.every((h) => Math.abs(h - heights[0]) <= 1),
      computedRowGap: rowGap,
      computedColGap: colGap,
      measuredVerticalGaps: vGaps,
      measuredHorizontalGaps: hGaps,
      rowTopsMatch: rowTops.every(([a, b]) => a === b),
      cardBg: cs(g.els[0]).backgroundColor,
    });
  }

  // ── Generic sibling vertical gaps, tagged by (prevKind -> nextKind) ──
  out.siblingGaps = [];
  function kindOf(el) {
    const tag = el.tagName.toLowerCase();
    const cls = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\s+/)[0] : '';
    return cls ? `${tag}.${cls}` : tag;
  }
  const allParents = new Set();
  for (const el of mainRoot.querySelectorAll('*')) allParents.add(el);
  allParents.add(mainRoot);
  for (const parent of allParents) {
    const kids = Array.from(parent.children).filter(isVisible);
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1], b = kids[i];
      const ra = rect(a), rb = rect(b);
      if (Math.abs(ra.left - rb.left) > 4) continue;
      if (rb.top < ra.bottom - 1) continue;
      out.siblingGaps.push({
        parent: shortSelector(parent),
        from: kindOf(a),
        to: kindOf(b),
        gap: round(rb.top - ra.bottom),
      });
    }
  }

  // ── Heading-to-first-visible-thing gaps (reading-order, ignores wrappers) ──
  // M-3: "the first visible thing" is text, an image/drawing, OR the
  // visible edge of a box (border width>0 + non-transparent colour, or a
  // background that differs from the background behind it) -- checked
  // BEFORE descending into an element's own children, so the walk stops at
  // a card row's own top edge instead of the first text leaf buried inside
  // the first card (which double-counts that card's own internal padding
  // as if it were heading-to-content space).
  function parseColor(str) {
    // "rgba(r, g, b, a)" / "rgb(r, g, b)" -> {r,g,b,a}; anything else (e.g.
    // a keyword the browser never actually returns from getComputedStyle)
    // treated as fully transparent/absent.
    if (!str) return null;
    const m = str.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  function isBoxWithVisibleEdge(el) {
    if (el.tagName === 'IMG' || el.tagName === 'SVG' || el.tagName === 'CANVAS' || el.tagName === 'VIDEO') return true;
    const s = cs(el);
    const bw = [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].map((v) => parseFloat(v) || 0);
    const bc = [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor];
    const hasBorder = bw.some((w, i) => {
      if (w <= 0) return false;
      const c = parseColor(bc[i]);
      return c && c.a > 0;
    });
    if (hasBorder) return true;
    const own = parseColor(s.backgroundColor);
    if (!own || own.a === 0) return false;
    // "differs from the background behind it" -- the nearest ancestor's
    // own resolved background (walk up past transparent ancestors, same
    // way a browser paints).
    let p = el.parentElement;
    let behind = null;
    while (p) {
      const pc = parseColor(cs(p).backgroundColor);
      if (pc && pc.a > 0) { behind = pc; break; }
      p = p.parentElement;
    }
    if (!behind) return true; // painted on the page background, own colour is a real fill
    return !(own.r === behind.r && own.g === behind.g && own.b === behind.b && Math.abs(own.a - behind.a) < 0.02);
  }
  function firstVisibleThingAfter(startEl) {
    const all = Array.from(mainRoot.querySelectorAll('*'));
    const idx = all.indexOf(startEl);
    if (idx === -1) return null;
    for (let i = idx + 1; i < all.length; i++) {
      const el = all[i];
      if (!isVisible(el)) continue;
      if (el.contains(startEl) || startEl.contains(el)) continue;
      const r = rect(el);
      if (r.top < rect(startEl).bottom - 2) continue; // still overlapping/above, skip

      // M-3 box-edge check FIRST: a bordered/backgrounded box is itself
      // "the first visible thing" -- stop here, do not descend into it.
      if (isBoxWithVisibleEdge(el)) {
        return { el, rect: r, kind: 'box' };
      }

      // Otherwise, a genuine text leaf (has its own direct non-empty text).
      let hasOwnText = false;
      for (const node of el.childNodes) {
        if (node.nodeType === 3 && node.textContent.trim().length > 0) { hasOwnText = true; break; }
      }
      if (!hasOwnText) {
        // No direct text node of its own -- but when a block's ENTIRE
        // content is wrapped in a single inline child (e.g. `<p><strong>All
        // bold</strong></p>`, common in the legal pages' "Effective Date"
        // line and elsewhere), the walk would otherwise skip the block and
        // match that inline child instead. An inline element's own
        // getBoundingClientRect() sits inside the block's line box, offset
        // by roughly half the line-height's leading from the block's own
        // top edge -- a font-metrics artifact, not a real spacing value,
        // and the reader sees the paragraph's line starting at the block's
        // edge either way. A block whose children are all inline is still
        // a single visual text leaf; measure it there; a block with a
        // BLOCK-level child is not a leaf (there's a real nested block to
        // find), so it is correctly left unmatched and the walk continues.
        const cs2 = getComputedStyle(el);
        const isInline = cs2.display === 'inline' || cs2.display === 'inline-block' || cs2.display === 'inline-flex' || cs2.display === 'inline-grid';
        const hasBlockKid = Array.from(el.children).some((k) => {
          const kd = getComputedStyle(k).display;
          const kInline = kd === 'inline' || kd === 'inline-block' || kd === 'inline-flex' || kd === 'inline-grid';
          return !kInline && isVisible(k);
        });
        if (!isInline && !hasBlockKid && el.textContent.trim().length > 0) hasOwnText = true;
      }
      if (!hasOwnText) continue;
      return { el, rect: r, kind: 'text' };
    }
    return null;
  }
  out.headingGaps = [];
  const headings = Array.from(mainRoot.querySelectorAll('h1, h2, h3'));
  for (const h of headings) {
    if (!isVisible(h)) continue;
    const hRect = rect(h);
    const found = firstVisibleThingAfter(h);
    out.headingGaps.push({
      heading: shortSelector(h),
      headingText: h.textContent.trim().slice(0, 60),
      headingBottom: round(hRect.bottom),
      firstThingSelector: found ? shortSelector(found.el) : null,
      firstThingKind: found ? found.kind : null,
      firstThingText: found ? found.el.textContent.trim().slice(0, 60) : null,
      firstThingTop: found ? round(found.rect.top) : null,
      gap: found ? round(found.rect.top - hRect.bottom) : null,
    });
  }

  return out;
}

function foldCheck({ vw, vh }) {
  function rect(el) { return el.getBoundingClientRect(); }
  function round(n) { return Math.round(n * 100) / 100; }
  const h1 = document.querySelector('h1');
  const nav = document.getElementById('main-nav');
  const mainRoot = document.querySelector('main') || document.body;
  const skip = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
  function vis(el) {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  const firstBlock = Array.from(mainRoot.children).find((el) => vis(el) && !skip.has(el.tagName)) || mainRoot;
  const codeBlock = firstBlock.querySelector('.hero-install, .code-block, pre');
  const primaryBtn = firstBlock.querySelector('.btn-primary, #hero-cta-secondary, .hero-cta-link');
  function safeRect(el) { return el ? rect(el) : null; }
  const h1r = safeRect(h1);
  const cbr = safeRect(codeBlock);
  const btnr = safeRect(primaryBtn);
  const navr = safeRect(nav);
  return {
    viewport: `${vw}x${vh}`,
    navBottom: navr ? round(navr.bottom) : null,
    h1Bottom: h1r ? round(h1r.bottom) : null,
    commandBlockBottom: cbr ? round(cbr.bottom) : null,
    primaryBtnBottom: btnr ? round(btnr.bottom) : null,
    lowestOf: round(Math.max(h1r ? h1r.bottom : 0, cbr ? cbr.bottom : 0, btnr ? btnr.bottom : 0)),
    fits: Math.max(h1r ? h1r.bottom : 0, cbr ? cbr.bottom : 0, btnr ? btnr.bottom : 0) <= vh,
  };
}

module.exports = { extractPageMetrics, foldCheck, WIDTHS };
