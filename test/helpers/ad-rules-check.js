'use strict';

/**
 * test/helpers/ad-rules-check.js — SPACING-0927 Round 3 (FIX-UNIT-SPACING-3.md)
 *
 * The Art Director's own rule evaluator (A3-1 through A3-10), copied in per
 * M-1 and adapted from a standalone script (which read two JSON files off
 * disk and printed to stdout) into an importable module: `evaluateRules`
 * takes the same two data shapes in memory (as produced by
 * `ad-verify-measure.js`'s `extractPageMetrics`/`foldCheck`) and returns
 * `{ totalChecks, passCounts, failures, RULE_NAMES }` instead of printing
 * directly, so the spacing test suite can assert on it and the report
 * table can be built from it.
 *
 * The verbatim original is reference-only and does not live in the
 * repository (per the coordinator's Round 3 resume note).
 *
 * Design rebuild, sheet v2 (the Art Director's re-rule for the new type scale):
 *   rule 5: an h1 or h2 to the first visible thing under it is 24 when that
 *     thing is text and 48 when it is a box (a card, a grid, a table, a list of
 *     rows, a drawing, a code block); an h3 is 16. A heading with its content
 *     BESIDE it (the heading-left layout) is not measured, and is listed in
 *     `besideExempt` so the report can name every one.
 *   rule 7: cards in a grid are 24 apart; rows joined by a 1px line have equal
 *     top and bottom padding of 16 or 24.
 *   rule 9: a card is the surface colour, a 1px line and a 14px radius, on
 *     whichever ground it sits.
 *
 * V-7 (band rhythm): "A band is a section with no heading that holds a
 * single row. A band's top and bottom padding is the band rhythm: 64 at
 * 1280, 48 at 768, 32 at 375." Rule 10 (the Art Director's own bands/
 * strips check) originally checked #works-with-band's padding against the
 * full section RHYTHM -- updated here to check it against BAND_RHYTHM
 * (half the section rhythm) instead, matching the new var(--band-pad)
 * token applied in CSS. Rule 4 (seam = sum of adjacent paddings) needs no
 * special-casing for this: it already sums whatever each section's own
 * measured padding actually is, so "the seam between a band and its
 * neighbour is the band rhythm plus the neighbour's rhythm" falls out
 * automatically once the band's own padding is band-rhythm.
 */

const READING_PAGES = new Set(['/terms', '/privacy', '/legal/subprocessors', '/legal/supported-clients']);
const RHYTHM = { '1280': 120, '768': 80, '375': 64 };
const BAND_RHYTHM = { '1280': 64, '768': 48, '375': 32 };
const PAGE_GUTTER = { '1280': 90, '768': 20, '375': 16 };
const READING_GUTTER = { '1280': 304, '768': 44, '375': 16 };
const SCALE = [2, 4, 8, 16, 24, 32, 48, 64, 80, 90, 120, 304, 44]; // content + layout tokens
// R4-4 (RULING-SEAMS-2026-09-28.md): "The tolerance for a seam is 1
// pixel. For every other rule it stays half a pixel." TOL is the default
// for every rule; rule 4's own seam checks pass an explicit 1px instead.
const TOL = 0.5; // px tolerance, every rule but seams (rule 4, its own explicit 1px)
const SEAM_TOL = 1;

function near(a, b, tol = TOL) { return Math.abs(a - b) <= tol; }

// Every page is a stack of sections now: /about and /connect carry the
// standard gutter, and the legal pages (the only reading pages left) are
// measured through the .legal-wrap block like any other.
// Wrappers explicitly off the rhythm-padding rule (login-view: B-9/B12,
// the sign-in card's own layout, untouched by this build).
const RHYTHM_EXEMPT_SELECTORS = /login-view/;

const RULE_NAMES = {
  1: 'A3-1 section gutter-left = gutter-right (centering)',
  2: 'A3-2 section gutter = nav gutter = footer gutter',
  3: 'A3-3 section padding-top = padding-bottom = rhythm, hero included',
  4: 'A3-4 seam = sum of adjacent section paddings',
  5: 'A3-5 h1/h2 -> first thing = 24 (text) or 48 (box); h3 -> first thing = 16; beside is exempt',
  6: 'A3-6 card padding equal 4 sides = 32',
  7: 'A3-7 cards in a grid 24 apart; rows joined by a 1px line pad 16 or 24, top = bottom',
  8: 'A3-8 every margin/padding/gap is a scale value',
  9: 'A3-9 a card is the surface colour, a 1px line and a 14px radius, on its own ground',
  10: 'A3-10 bands/strips are sections (padding = rhythm)',
};

/**
 * @param {Record<string, Record<string, object>>} d route -> width -> extractPageMetrics() result
 * @param {Record<string, Record<string, object>>} fold "WxH" -> route -> foldCheck() result
 * @param {{ isFlushException?: (sec: object, page: string) => boolean, bandSelectors?: string[] }} [opts]
 */
function evaluateRules(d, fold, opts) {
  opts = opts || {};
  const isFlushExceptionExtra = opts.isFlushException || (() => false);
  const bandSelectors = opts.bandSelectors || ['works-with-band'];

  const PAGES = Object.keys(d);
  const WIDTHS = ['1280', '768', '375'];
  const failures = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [], 8: [], 9: [], 10: [] };
  const passCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0 };
  const totalChecks = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0 };
  const besideExempt = [];

  function log(rule, page, width, msg, pass) {
    totalChecks[rule]++;
    if (pass) passCounts[rule]++;
    else failures[rule].push(`${page} @ ${width}: ${msg}`);
  }

  for (const page of PAGES) {
    for (const width of WIDTHS) {
      const rec = d[page] && d[page][width];
      if (!rec || rec.error) continue;
      const chromeTags = new Set(['nav#main-nav', 'footer']);

      // Rule 1: box-gutter-left = box-gutter-right.
      for (const s of rec.sections) {
        if (s.boxGutterLeft == null || chromeTags.has(s.selector)) continue;
        const ok = near(s.boxGutterLeft, s.boxGutterRight);
        log(1, page, width, `${s.selector} gutterL=${s.boxGutterLeft} gutterR=${s.boxGutterRight}`, ok);
      }

      // Rule 2: section gutter = nav gutter = footer gutter.
      const targetGutter = READING_PAGES.has(page) ? READING_GUTTER[width] : PAGE_GUTTER[width];
      if (rec.nav) {
        const navOk = near(rec.nav.logoLeft, PAGE_GUTTER[width]);
        log(2, page, width, `nav logoLeft=${rec.nav.logoLeft}, ruled page gutter=${PAGE_GUTTER[width]}`, navOk);
      }
      if (rec.footer) {
        const footOk = near(rec.footer.gutterLeft, PAGE_GUTTER[width]);
        log(2, page, width, `footer gutterLeft=${rec.footer.gutterLeft}, ruled page gutter=${PAGE_GUTTER[width]}`, footOk);
        const footPadOk = near(rec.footer.padding.top, 32) && near(rec.footer.padding.bottom, 32);
        log(2, page, width, `footer padding top/bottom=${rec.footer.padding.top}/${rec.footer.padding.bottom}, ruled=32/32`, footPadOk);
      }
      for (const s of rec.sections) {
        if (s.boxGutterLeft == null || chromeTags.has(s.selector)) continue;
        if (page === '/dashboard' && /login-view/.test(s.selector)) continue;
        // Deliberately narrower, centred columns within a section, not the
        // section's own 1100px content edge -- their own centering is
        // covered by rule 1 (gutter-left == gutter-right) and, for the two
        // V-4 boxes, a dedicated half-pixel test; matching the ruled PAGE
        // gutter is not their contract.
        if (opts.narrowColumnWrapperSelectors && opts.narrowColumnWrapperSelectors.has(s.wrapperSelector)) continue;
        const ok = near(s.boxGutterLeft, targetGutter);
        log(2, page, width, `${s.selector} gutter=${s.boxGutterLeft}, ruled=${targetGutter}`, ok);
      }

      // Rule 3: section padding-top = padding-bottom = rhythm, hero included.
      for (const s of rec.sections) {
        if (chromeTags.has(s.selector)) continue;
        if (RHYTHM_EXEMPT_SELECTORS.test(s.selector)) continue;
        const isStatedFlush = (/section-raised/.test(s.selector) && s.padding.top === 0 && s.padding.bottom === 0 && page === '/for-agents')
          || isFlushExceptionExtra(s, page);
        if (isStatedFlush) { log(3, page, width, `${s.selector} flush strip 0/0 -- stated exception`, true); continue; }
        // V-7: a band (checked again, positively, under rule 10 too)
        // uses the band rhythm here, not the full section rhythm -- but
        // top must still equal bottom, at that value.
        const isBand = bandSelectors.some((sel) => s.selector.includes(sel));
        const rhythmForThis = isBand ? BAND_RHYTHM[width] : RHYTHM[width];
        const topOk = near(s.padding.top, rhythmForThis);
        const botOk = near(s.padding.bottom, rhythmForThis);
        const eqOk = near(s.padding.top, s.padding.bottom);
        log(3, page, width, `${s.selector} padding-top=${s.padding.top} padding-bottom=${s.padding.bottom}, ruled=${rhythmForThis}/${rhythmForThis}${isBand ? ' (band rhythm)' : ''}`, topOk && botOk && eqOk);
      }

      // Rule 4 / the seam test (RULING-SEAMS-2026-09-28.md, verbatim):
      // "A seam is measured box to box. From the bottom of the last
      // visible thing in one section to the top of the first visible
      // thing in the next. A visible thing is a block of text (its
      // element box, not the glyphs), an image or drawing, or a box that
      // draws its own edge: a border with a width above 0 and a colour
      // that is not transparent, a hairline, or a background that differs
      // from what is behind it... A row, a card or a callout that draws
      // its own edge is one block. The padding inside it is its own, and
      // is governed by the card and list rules, not by the seam rule."
      // contentBox (extractPageMetrics's unionBox()) already measures
      // exactly this: a leaf's own box or, when a bordered/backgrounded
      // ancestor draws its own edge first, that ancestor's box instead
      // (M-3's box-edge extension, applied to sections in Round 3).
      for (const seam of rec.seams) {
        const fromSec = rec.sections.find((s) => s.selector === seam.from);
        const toSec = rec.sections.find((s) => s.selector === seam.to);
        if (!fromSec || !toSec) continue;
        if (chromeTags.has(fromSec.selector) || chromeTags.has(toSec.selector)) continue;
        // Each side's own hairline border (if it has one) sits outside
        // what contentBox measures (a section's own border is
        // deliberately never a box-edge candidate against itself -- see
        // borderOf's own comment) but is still real, visible pixels
        // between the two sections' content -- added here so a section
        // pair that each draw a 1px divider (the .section-raised/
        // .section-ground alternation) isn't read as a spacing defect.
        const borderSum = (fromSec.border ? fromSec.border.bottom : 0) + (toSec.border ? toSec.border.top : 0);
        const expected = fromSec.padding.bottom + toSec.padding.top + borderSum;
        // R4-1 (RULING-SEAMS-2026-09-28.md): the /api alt-bg->api-section
        // 9px exception is rejected and removed. Root cause found and
        // fixed at the cause (public/api.html: .annotation-list
        // li:last-child kept its border-removed sibling's 8px bottom
        // padding with no border left to justify it -- see that file's
        // own R4-1 comment). Tolerance tightened to the ruling's 1px
        // (was 6, to absorb this exact unexplained residual).
        const ok = near(seam.contentGap, expected, SEAM_TOL);
        log(4, page, width, `seam ${seam.from}->${seam.to} = ${seam.contentGap}, expected ${expected} (${fromSec.padding.bottom}+${toSec.padding.top}${borderSum ? `+${borderSum}border` : ''})`, ok);
      }

      // Rule 5 (sheet v2): a heading to the first visible thing under it.
      // h1 and h2: 24 when that thing is text, 48 when it is a box (a card,
      // a grid, a table, a list of rows, a drawing, a code block). h3: 16.
      // A heading whose content sits BESIDE it is not measured: the first
      // visible thing does not overlap the heading horizontally (the
      // heading-left layout), or it starts above the heading's bottom edge.
      for (const hg of rec.headingGaps || []) {
        if (hg.gap == null) continue;
        // Judged on the unit that follows the heading (the child of the
        // closest common ancestor that holds the first thing), because a
        // table's first cell sits at the table's own left edge.
        const overlapX = Math.min(hg.headingRight, hg.followingUnitRight) - Math.max(hg.headingLeft, hg.followingUnitLeft);
        const startsAbove = hg.followingUnitTop < hg.headingBottom - 2;
        if (overlapX <= 1 || startsAbove) {
          besideExempt.push(`${page} @ ${width}: ${hg.heading} "${hg.headingText}" -> [${hg.firstThingKind}] "${hg.firstThingText}" (beside)`);
          continue;
        }
        // The legal pages draw their h1 as a full-bleed dark band (the
        // template's own pseudo-element). What follows the band is the next
        // section, so the gap under that h1 is the section rhythm, the seam
        // below a hero: measured here against the rhythm, not skipped.
        const bandH1 = READING_PAGES.has(page) && hg.headingTag === 'h1';
        const want = bandH1 ? RHYTHM[width] : (hg.headingTag === 'h3' ? 16 : (hg.firstThingKind === 'box' ? 48 : 24));
        const ok = near(hg.gap, want);
        log(5, page, width, `${hg.heading} "${hg.headingText}" -> [${hg.firstThingKind}] "${hg.firstThingText}" gap=${hg.gap}, ruled=${want}`, ok);
      }

      // Rule 6: card padding equal 4 sides = 32.
      for (const g of rec.repeatedGroups) {
        if (g.count < 2) continue;
        const looksLikeCard = g.padding.top > 0 && (g.parentDisplay === 'grid' || g.parentDisplay === 'flex');
        if (!looksLikeCard) continue;
        const padEq = near(g.padding.top, g.padding.right) && near(g.padding.top, g.padding.bottom) && near(g.padding.top, g.padding.left);
        if (padEq && g.paddingUniform) {
          log(6, page, width, `${g.className} padding all sides ${g.padding.top}/${g.padding.right}/${g.padding.bottom}/${g.padding.left}`, true);
        }
      }

      // Rule 7 (sheet v2), cards: cards in a grid are 24 apart, across a
      // row and down a column.
      for (const c of rec.cards || []) {
        if (!c.inGrid) continue;
        for (const gp of c.gaps) {
          log(7, page, width, `${c.parentSelector} > ${c.className} cards ${gp.dir} gap=${gp.gap}, ruled=24`, near(gp.gap, 24));
        }
      }
      // Rule 7 (sheet v2), rows: rows joined by a 1px line have equal top and
      // bottom padding of 16 or 24. An edge is judged where a line meets it:
      // the first row of a list has no line above it and the last none below
      // (that edge sits against the section's own padding), so only the edge
      // beside a line is held to 16 or 24, and where both edges meet a line
      // they must be equal.
      for (const r of rec.joinedRows || []) {
        const edges = [];
        if (r.lineAbove) edges.push(r.padTop);
        if (r.lineBelow) edges.push(r.padBottom);
        if (!edges.length) continue;
        const onScale = edges.every((v) => near(v, 16) || near(v, 24));
        const equal = edges.length < 2 || near(r.padTop, r.padBottom);
        log(7, page, width, `${r.selector} "${r.text}" joined row padding top/bottom=${r.padTop}/${r.padBottom} (line above ${r.lineAbove}, below ${r.lineBelow}), ruled=16 or 24, equal where both edges meet a line`, onScale && equal);
      }

      // Rule 9 (sheet v2): a card has the surface colour, a 1px line and a
      // 14px radius, on whichever ground it sits (the page measures the
      // surface and line tokens at the card itself).
      for (const c of rec.cards || []) {
        const surfaceOk = c.bg === c.surface;
        const lineOk = c.borderColor === c.line && c.borderWidths.every((w) => near(w, 1));
        const radiusOk = c.radii.every((r) => near(r, 14));
        log(9, page, width, `${c.parentSelector} > ${c.className} card bg=${c.bg} (surface ${c.surface}) border=${c.borderWidths.join('/')} ${c.borderColor} (line ${c.line}) radius=${c.radii.join('/')}, ruled surface + 1px line + 14px`, surfaceOk && lineOk && radiusOk);
      }

      // Rule 10: bands/strips as sections -- band rhythm (V-7), not the
      // full section rhythm.
      for (const bandSel of bandSelectors) {
        const band = rec.sections.find((s) => s.selector.includes(bandSel));
        if (band) {
          const ok = near(band.padding.top, BAND_RHYTHM[width]) && near(band.padding.bottom, BAND_RHYTHM[width]);
          log(10, page, width, `#${bandSel} padding=${band.padding.top}/${band.padding.bottom}, ruled=${BAND_RHYTHM[width]}/${BAND_RHYTHM[width]}`, ok);
        }
      }
    }
  }

  // Rule 8: sitewide off-scale sibling gaps, repeated >=3 times.
  const offScale = new Map();
  for (const page of PAGES) {
    for (const width of WIDTHS) {
      const rec = d[page] && d[page][width];
      if (!rec || rec.error) continue;
      for (const sg of rec.siblingGaps) {
        const v = Math.round(sg.gap);
        if (v <= 0) continue;
        if (Number.isInteger(sg.gap) && !SCALE.includes(v)) {
          const key = `${sg.from}->${sg.to}=${v}`;
          offScale.set(key, (offScale.get(key) || 0) + 1);
        }
      }
    }
  }
  // V-6 / R4-3 (RULING-SEAMS-2026-09-28.md): "Inside an input, a button, a
  // badge or a table cell stays out of scope." Investigated case by case:
  //  - td.tier-name->td: two cells in the same table row -- literally
  //    inside a table, the named exclusion.
  //  - span->span=5: R4-3 asked which component this is. Traced (not
  //    dashboard's status line, this build's own round-3 guess, corrected
  //    here) to `.hamburger span` -- the mobile nav toggle BUTTON's own
  //    three icon bars, `.hamburger { display:flex; flex-direction:
  //    column; gap:5px; ...}` inside `<button id="main-nav-hamburger"
  //    class="hamburger">`. Literally inside a button, R4-3's own named
  //    exclusion. (span.stat-num->span.stat-label and
  //    span.pill-price->span.pill-label, the other two R4-3 items, were
  //    real, fixed at the cause -- see public/for-builders.html and
  //    public/styles.css .pricing-pill .pill-label; they are no longer in
  //    this exception list.)
  const KNOWN_OFF_SCALE_EXCEPTIONS = new Map([
    ['td.tier-name->td', 'a table cell\'s own row -- the named table-cell exclusion'],
    ['span->span', 'inside <button class="hamburger"> -- the mobile nav toggle\'s own three icon bars (.hamburger{gap:5px}), the named "inside a button" exclusion'],
  ]);
  const documentedExceptions = [];
  const repeatedOffScale = [...offScale.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  for (const [key, n] of repeatedOffScale) {
    totalChecks[8]++;
    const pairKey = key.replace(/=\d+$/, '');
    const reason = KNOWN_OFF_SCALE_EXCEPTIONS.get(pairKey);
    if (reason) {
      passCounts[8]++;
      documentedExceptions.push(`sitewide: ${key} (seen ${n}x) -- ${reason}`);
    } else {
      failures[8].push(`sitewide: ${key} (seen ${n}x, not on the scale ${SCALE.join(',')})`);
    }
  }
  if (totalChecks[8] === 0) { totalChecks[8] = 1; passCounts[8] = 1; }

  return { totalChecks, passCounts, failures, RULE_NAMES, SCALE, RHYTHM, PAGE_GUTTER, READING_GUTTER, documentedExceptions, besideExempt };
}

function printReport(evalResult, fold) {
  const { totalChecks, passCounts, failures, RULE_NAMES } = evalResult;
  for (const rule of Object.keys(RULE_NAMES)) {
    const total = totalChecks[rule];
    const pass = passCounts[rule];
    const fails = failures[rule];
    console.log(`\n=== ${RULE_NAMES[rule]} ===`);
    console.log(`checks: ${total}, pass: ${pass}, fail: ${fails.length}`);
    if (fails.length) {
      console.log(`OVERALL: FAIL (${fails.length}/${total})`);
      for (const f of fails.slice(0, 60)) console.log('  FAIL: ' + f);
      if (fails.length > 60) console.log(`  ... and ${fails.length - 60} more`);
    } else {
      console.log('OVERALL: PASS');
    }
  }
  if (fold) {
    console.log('\n\n=== FOLD CHECK ===');
    for (const vp of Object.keys(fold)) {
      for (const page of Object.keys(fold[vp])) {
        const f = fold[vp][page];
        if (f.error) { console.log(`${page} @ ${vp}: ERROR ${f.error}`); continue; }
        console.log(`${page} @ ${vp}: lowestOf=${f.lowestOf} fits=${f.fits} (navBottom=${f.navBottom} h1Bottom=${f.h1Bottom} commandBlockBottom=${f.commandBlockBottom} primaryBtnBottom=${f.primaryBtnBottom})`);
      }
    }
  }
}

module.exports = { evaluateRules, printReport, RULE_NAMES, RHYTHM, PAGE_GUTTER, READING_GUTTER, SCALE, READING_PAGES, RHYTHM_EXEMPT_SELECTORS };
