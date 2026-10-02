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
 *   Sheet v2 (design rebuild): `headingGaps` now returns the first visible
 *   thing wherever it sits (it used to skip anything that started above the
 *   heading's bottom edge) with the heading's and the following unit's edges,
 *   so rule 5 can tell under from beside; out-of-flow elements and the inner
 *   shapes of a drawing are never "the thing under a heading", and an inline
 *   <svg> root is a box. `cards` and `joinedRows` feed rules 7 and 9.
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
  // Sheet v2 (heading gap): the first visible thing is found in reading
  // order, through any wrapper, and is returned wherever it sits. The old
  // version skipped everything that started above the heading's bottom edge
  // and carried on looking, which measured a heading-left layout against
  // some unrelated row further down. Now the caller sees the real first
  // thing and its edges, and rule 5 decides whether it is under the heading
  // or beside it. Two kinds of element are never "the thing under a
  // heading": one that is out of the flow (absolutely positioned or fixed,
  // or inside such a box that does not also hold the heading, e.g. the
  // faint device behind a hero), and a drawing's inner shapes (an inline
  // <svg> is one drawing, a box; its text is not a line of text on the
  // page). An inline <svg> root counts as a box here, which the old
  // upper-case tag check never matched.
  function isOutOfFlow(el, startEl) {
    for (let p = el; p && p !== mainRoot; p = p.parentElement) {
      if (p.contains(startEl)) break;
      const pos = cs(p).position;
      if (pos === 'absolute' || pos === 'fixed') return true;
    }
    return false;
  }
  function isSvgRoot(el) {
    return el.namespaceURI === 'http://www.w3.org/2000/svg' && el.localName === 'svg' && !el.ownerSVGElement;
  }
  function firstVisibleThingAfter(startEl) {
    const all = Array.from(mainRoot.querySelectorAll('*'));
    const idx = all.indexOf(startEl);
    if (idx === -1) return null;
    for (let i = idx + 1; i < all.length; i++) {
      const el = all[i];
      if (!isVisible(el)) continue;
      if (el.contains(startEl) || startEl.contains(el)) continue;
      if (el.ownerSVGElement) continue; // a shape inside a drawing; the drawing itself is found at its root
      if (isOutOfFlow(el, startEl)) continue;
      const r = rect(el);

      // A drawing is a box.
      if (isSvgRoot(el)) {
        return { el, rect: r, kind: 'box' };
      }

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
    // The unit that follows the heading: the child of the closest common
    // ancestor that holds the found thing (a table's first cell sits at the
    // table's own left edge, but it is the table that follows the heading).
    // Beside-or-under is judged on that unit.
    let branch = null;
    if (found) {
      branch = found.el;
      while (branch.parentElement && !branch.parentElement.contains(h)) branch = branch.parentElement;
    }
    const bRect = branch ? rect(branch) : null;
    out.headingGaps.push({
      heading: shortSelector(h),
      headingTag: h.tagName.toLowerCase(),
      headingText: h.textContent.trim().slice(0, 60),
      headingBottom: round(hRect.bottom),
      // Sheet v2: the heading's edges, the found thing's and the following
      // unit's, so rule 5 can tell a thing UNDER the heading from one BESIDE it.
      headingLeft: round(hRect.left),
      headingRight: round(hRect.right),
      firstThingLeft: found ? round(found.rect.left) : null,
      firstThingRight: found ? round(found.rect.right) : null,
      followingUnitLeft: bRect ? round(bRect.left) : null,
      followingUnitRight: bRect ? round(bRect.right) : null,
      followingUnitTop: bRect ? round(bRect.top) : null,
      firstThingSelector: found ? shortSelector(found.el) : null,
      firstThingKind: found ? found.kind : null,
      firstThingText: found ? found.el.textContent.trim().slice(0, 60) : null,
      firstThingTop: found ? round(found.rect.top) : null,
      gap: found ? round(found.rect.top - hRect.bottom) : null,
    });
  }

  // ── Cards in a grid, and rows joined by a hairline (sheet v2) ─────────
  // A drawing is not a card and its panels are not cards: anything inside
  // one of these is left to the drawing rules.
  const DRAWING_SCOPE = '.stage, .panel, .step-art, .code-block, .dw-stage, .dw-stage-dark, .dw-dark, .dw-light, [aria-hidden="true"], svg, nav, footer';
  function px(v) { return parseFloat(v) || 0; }
  function lineBox(el) {
    // Visible border widths, per side (a transparent border is not a line).
    const s = cs(el);
    const vis = (w, c) => (px(w) > 0 && (parseColor(c) || { a: 0 }).a > 0 ? px(w) : 0);
    return {
      top: vis(s.borderTopWidth, s.borderTopColor),
      right: vis(s.borderRightWidth, s.borderRightColor),
      bottom: vis(s.borderBottomWidth, s.borderBottomColor),
      left: vis(s.borderLeftWidth, s.borderLeftColor),
    };
  }
  // The token values a card must take on the ground it sits on: read the
  // computed colour of a throwaway child painted with var(--surface) and
  // var(--line), so the check follows the ground (paper, tint, dark).
  function groundTokens(el) {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;width:0;height:0;background-color:var(--surface);border:1px solid var(--line)';
    el.appendChild(probe);
    const ps = cs(probe);
    const out2 = { surface: ps.backgroundColor, line: ps.borderTopColor };
    el.removeChild(probe);
    return out2;
  }
  // Cards: a repeated element (two or more under one parent) that draws a
  // box of its own, big enough to be a card rather than a pill, tag or
  // button, sitting in a grid or flex parent, outside any drawing.
  out.cards = [];
  for (const [key, g] of groups) {
    if (g.els.length < 2) continue;
    const first = g.els[0];
    if (first.closest(DRAWING_SCOPE)) continue;
    const parent = first.parentElement;
    const pd = cs(parent).display;
    if (!['grid', 'inline-grid', 'flex', 'inline-flex'].includes(pd)) continue;
    const ls = lineBox(first);
    const four = ls.top > 0 && ls.right > 0 && ls.bottom > 0 && ls.left > 0;
    const r0 = rect(first);
    if (!four || r0.width < 140 || r0.height < 96) continue;
    const gt = groundTokens(first);
    const fs0 = cs(first);
    const rads = [fs0.borderTopLeftRadius, fs0.borderTopRightRadius, fs0.borderBottomRightRadius, fs0.borderBottomLeftRadius].map(px);
    // Gaps to the nearest card to the right (same row) and below (same
    // column), measured edge to edge, for every card in the group.
    const rr = g.els.map(rect);
    const gaps = [];
    for (let i = 0; i < rr.length; i++) {
      let right = null, below = null;
      for (let j = 0; j < rr.length; j++) {
        if (i === j) continue;
        const a = rr[i], b = rr[j];
        const overlapV = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 4;
        const overlapH = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 4;
        if (overlapV && b.left >= a.right - 1) { const d = b.left - a.right; if (right === null || d < right) right = d; }
        if (overlapH && b.top >= a.bottom - 1) { const d = b.top - a.bottom; if (below === null || d < below) below = d; }
      }
      if (right !== null) gaps.push({ dir: 'across', gap: round(right) });
      if (below !== null) gaps.push({ dir: 'down', gap: round(below) });
    }
    out.cards.push({
      key,
      className: g.className,
      parentSelector: g.parentSelector,
      parentDisplay: pd,
      count: g.els.length,
      inGrid: pd === 'grid' || pd === 'inline-grid',
      bg: fs0.backgroundColor,
      surface: gt.surface,
      borderColor: fs0.borderTopColor,
      line: gt.line,
      borderWidths: [ls.top, ls.right, ls.bottom, ls.left],
      radii: rads,
      gaps,
    });
  }

  // Rows joined by a 1px line: a run of two or more adjacent siblings of
  // one kind, at least one of which draws a 1px hairline above or below it
  // and no line at either side. A table row is its cells: a table whose
  // cells carry the hairline is one such list, each cell measured by its
  // own padding (a cell's text can sit short of a taller neighbour's, so
  // its inset is not its padding). For every row the probe records whether
  // a line sits above it and below it (its own, or the neighbour's), and
  // its padding on each side. A row's padding is its own plus the padding of
  // the chain of first (or last) in-flow children down to the text, so a
  // row that hands its padding to an inner button still reads right (a
  // question row's button carries the 24).
  out.joinedRows = [];
  const rowSeen = new Set();
  const runsSeen = new Map();
  function hairlineRow(el) {
    const ls = lineBox(el);
    return ls.left === 0 && ls.right === 0 && (ls.top === 1 || ls.bottom === 1);
  }
  function rowKey(el) { return el.tagName + '|' + (typeof el.className === 'string' ? el.className.trim() : ''); }
  function isBlockLevel(el) {
    const d = cs(el).display;
    return !(d === 'inline' || d === 'inline-block' || d === 'inline-flex' || d === 'inline-grid' || d === 'contents');
  }
  function hasOwnText(el) {
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && node.textContent.trim().length > 0) return true;
    }
    return false;
  }
  // Padding a row gives its content on one side: its own, plus that of each
  // wrapper in the chain of first (or last) in-flow children, down to the
  // first element that holds text of its own. That element is the content,
  // so a chip or a label with padding of its own does not count as the row's.
  function chainPadding(row, side) {
    const Side = side === 'top' ? 'Top' : 'Bottom';
    let total = px(cs(row)['padding' + Side]);
    let cur = row;
    for (let depth = 0; depth < 6; depth++) {
      const kids = Array.from(cur.children).filter((k) => isVisible(k) && cs(k).position !== 'absolute' && cs(k).position !== 'fixed' && isBlockLevel(k) && rect(k).height > 0);
      if (!kids.length) break;
      const kid = side === 'top' ? kids[0] : kids[kids.length - 1];
      const ks = cs(kid);
      total += px(ks['margin' + Side]);
      if (hasOwnText(kid)) break;
      total += px(ks['padding' + Side]) + px(ks['border' + Side + 'Width']);
      cur = kid;
    }
    return round(total);
  }
  for (const el of mainRoot.querySelectorAll('*')) {
    if (!isVisible(el) || el.parentElement === mainRoot) continue;
    if (el.closest(DRAWING_SCOPE)) continue;
    const tag = el.tagName;
    if (tag === 'TD' || tag === 'TH') {
      if (cs(el).display !== 'table-cell' || !hairlineRow(el)) continue;
      const table = el.closest('table');
      if (!table || rowSeen.has(table)) continue;
      rowSeen.add(table);
      const trs = Array.from(table.rows).filter(isVisible);
      if (trs.length < 2) continue;
      trs.forEach((tr, ri) => {
        const prev = ri > 0 ? trs[ri - 1] : null;
        Array.from(tr.cells).filter(isVisible).forEach((c, ci) => {
          const ls = lineBox(c);
          const pc = prev && prev.cells[ci] ? lineBox(prev.cells[ci]) : null;
          const pd2 = paddingOf(c);
          out.joinedRows.push({
            kind: 'cell',
            selector: shortSelector(c),
            lineAbove: ls.top > 0 || !!(pc && pc.bottom > 0),
            lineBelow: ls.bottom > 0,
            padTop: pd2.top,
            padBottom: pd2.bottom,
            text: c.textContent.trim().slice(0, 30),
          });
        });
      });
      continue;
    }
    if (['TR', 'THEAD', 'TBODY', 'TFOOT', 'TABLE'].includes(tag)) continue;
    if (!hairlineRow(el)) continue;
    const parent = el.parentElement;
    const kids = Array.from(parent.children).filter(isVisible);
    const k = rowKey(el);
    const idx = kids.indexOf(el);
    // the run of adjacent same-kind siblings this element belongs to
    let a = idx, b = idx;
    while (a > 0 && rowKey(kids[a - 1]) === k) a--;
    while (b < kids.length - 1 && rowKey(kids[b + 1]) === k) b++;
    if (b - a + 1 < 2) continue;
    const marker = k + '@' + a;
    if (!runsSeen.has(parent)) runsSeen.set(parent, new Set());
    if (runsSeen.get(parent).has(marker)) continue;
    runsSeen.get(parent).add(marker);
    for (let i = a; i <= b; i++) {
      const row = kids[i];
      const bd = lineBox(row);
      const prevRow = i > a ? kids[i - 1] : null;
      const nextRow = i < b ? kids[i + 1] : null;
      out.joinedRows.push({
        kind: 'row',
        selector: shortSelector(row),
        parent: shortSelector(parent),
        lineAbove: bd.top > 0 || !!(prevRow && lineBox(prevRow).bottom > 0),
        lineBelow: bd.bottom > 0 || !!(nextRow && lineBox(nextRow).top > 0),
        padTop: chainPadding(row, 'top'),
        padBottom: chainPadding(row, 'bottom'),
        text: row.textContent.trim().slice(0, 30),
      });
    }
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
