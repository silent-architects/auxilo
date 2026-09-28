'use strict';

/**
 * test/review-table-phone-width.test.js — BUILD-BRIEF-REVIEW-TABLE-PHONE.md
 * (P-1..P-9), superseding the earlier R4-6 scope-down (FIX-UNIT-TERMS-3.md,
 * V-1) which explicitly shipped ONLY a 44x44 checkbox fix and left the
 * title column off-screen below the phone breakpoint. This revision proves
 * the full fix: below the breakpoint, each learning renders as a stacked
 * block (title, then a score/category/lane/date line, then any reason
 * line) instead of a table row that scrolls sideways with its title off
 * screen; at and above the breakpoint, the table renders exactly as
 * production's own table does (R3-1).
 *
 * The breakpoint is 900 (an EXISTING breakpoint -- styles.css already has
 * "@media (max-width: 900px)"), not the literal number 600 -- see R3-2's
 * test below for the measurement behind that choice.
 *
 * Seeds an account with FIVE pending items across the three lanes (used by
 * every test below EXCEPT the R3-2 describe block, which boots its own
 * server with a realistic, non-pathological seed -- see that block's own
 * comment for why):
 *   - lrn_ready_a    ready, title = 120 chars WITH spaces
 *   - lrn_ready_b    ready, one long (unbroken) tag
 *   - lrn_ready_c    ready, title = 120 chars with NO spaces
 *   - lrn_needs_score  unscored
 *   - lrn_needs_eyes   flagged (injection pattern) -- carries a "why" line
 *
 * Runner: node --test test/review-table-phone-width.test.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-do-not-use-in-prod';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SignJWT } = require('jose');
const {
  reservePort,
  stageServer,
  bootServer,
  stopServer,
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const SESSION_SECRET = 'review-table-phone-width-session-secret-32';
const ME = 'acc_review_phone';
const LONG_TITLE_SPACES = 'A'.repeat(60) + ' review title that keeps going and going ' + 'B'.repeat(56); // 120 chars
const LONG_TITLE_NO_SPACES = 'C'.repeat(120); // 120 chars, not one whitespace break opportunity
const LONG_TAG = 'a-very-long-descriptive-tag-name-that-keeps-going-and-going-and-going';

function learning(id, overrides) {
  return Object.assign({
    id,
    title: `Ordinary title ${id}`,
    body: `body of ${id} with enough words to matter for a reviewer reading it`,
    category: 'code-execution',
    tags: ['x'],
    status: 'pending_review',
    contributor_account_id: ME,
    created_at: '2026-07-01T00:00:00.000Z',
    quality_self_assessment: { total: 15 },
  }, overrides || {});
}

describe('P-1..P-9, R2, R3: pending review table at phone width', { timeout: 240_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;
  let bootSkipReason = null;
  let playwright;
  let dataDir;

  before(async () => {
    try {
      playwright = require(path.join(REPO, 'node_modules', 'playwright'));
    } catch (e) {
      bootSkipReason = 'playwright not resolvable: ' + e.message;
      return;
    }
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if (reservation.skipReason) { bootSkipReason = reservation.skipReason; return; }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-review-phone-'));
    const staged = stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port: reservation.port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['docs'],
      copyDirs: ['lib', 'public', 'prompts', 'config'],
    });
    dataDir = staged.dataDir;
    const learnings = [
      learning('lrn_ready_a', { quality_self_assessment: { total: 19 }, title: LONG_TITLE_SPACES }),
      // The category value is what the UI actually renders as a `.tag`
      // chip (the raw `tags` array on a learning record is never shown by
      // the dashboard's triage row) -- so the long, unbroken "tag" this
      // seed needs is the category string, not `tags`.
      learning('lrn_ready_b', { quality_self_assessment: { total: 18 }, category: LONG_TAG }),
      learning('lrn_ready_c', { quality_self_assessment: { total: 17 }, title: LONG_TITLE_NO_SPACES }),
      learning('lrn_needs_score', { quality_self_assessment: undefined }),
      learning('lrn_needs_eyes', { injection_flags: [{ pattern_id: 'ignore_previous' }], quality_self_assessment: { total: 20 } }),
    ];
    fs.writeFileSync(path.join(dataDir, 'learnings.json'), JSON.stringify(learnings, null, 2));
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
      [ME]: { id: ME, email: 'review-phone@example.com', created_at: new Date().toISOString() },
    }, null, 2));
    fs.writeFileSync(path.join(dataDir, 'earnings.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(dataDir, 'magic_links.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(dataDir, 'credits.json'), JSON.stringify({}, null, 2));

    const bootResult = await bootServer({
      tmpDir,
      port: reservation.port,
      env: {
        NODE_ENV: 'test',
        SESSION_SECRET,
        RESEND_API_KEY: '',
        LLM_SENSITIVITY_ENABLED: 'false',
        WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32),
      },
      timeoutMs: 60_000,
      maxAttempts: 4,
    });
    if (bootResult.skipReason) { bootSkipReason = bootResult.skipReason; return; }
    child = bootResult.child;
    baseUrl = bootResult.baseUrl;
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function jwtFor() {
    return new SignJWT({ accountId: ME, email: 'review-phone@example.com' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(Buffer.from(SESSION_SECRET));
  }

  async function openDashboard(browser, viewport) {
    const token = await jwtFor();
    const page = await browser.newPage({ viewport });
    await page.addInitScript((t) => { localStorage.setItem('auxilo_session', t); }, token);
    await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.triage-table', { state: 'attached' });
    await page.waitForSelector('.triage-data-row', { state: 'attached' });
    return page;
  }

  it('P-5/P-6: at 375 and 320 nothing scrolls sideways and every named control is in view and >= 44x44', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      for (const viewport of [{ width: 375, height: 900 }, { width: 320, height: 900 }]) {
        const page = await openDashboard(browser, viewport);

        const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
        assert.ok(noHScroll, `no page-level horizontal scroll at ${viewport.width}`);

        const wrapScroll = await page.evaluate(() => {
          const w = document.querySelector('.triage-table-wrap');
          return { scrollWidth: w.scrollWidth, clientWidth: w.clientWidth };
        });
        assert.ok(wrapScroll.scrollWidth <= wrapScroll.clientWidth + 1, `the table wrapper does not scroll sideways at ${viewport.width} (scrollWidth ${wrapScroll.scrollWidth} vs clientWidth ${wrapScroll.clientWidth})`);

        // P-6: every named control is fully inside the viewport and >= 44x44.
        const namedButtons = [
          'Refresh',
          'Select ready to publish',
          'Select all',
          'Clear',
          'Approve selected',
          'Keep private',
          'Reject selected',
        ];
        for (const label of namedButtons) {
          const box = await page.evaluate((l) => {
            const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim().indexOf(l) === 0);
            if (!btn) return null;
            const r = btn.getBoundingClientRect();
            return { left: r.left, right: r.right, width: r.width, height: r.height };
          }, label);
          assert.ok(box, `a button starting with "${label}" exists at ${viewport.width}`);
          assert.ok(box.left >= 0 && box.right <= viewport.width, `"${label}" stays inside the ${viewport.width}-wide viewport`);
          assert.ok(box.width >= 44 && box.height >= 44, `"${label}" is at least 44x44 at ${viewport.width} (got ${box.width}x${box.height})`);
        }

        const checkboxBoxes = await page.evaluate(() => Array.from(document.querySelectorAll('.triage-table .triage-check-label')).map((b) => {
          const r = b.getBoundingClientRect();
          return { left: r.left, right: r.right, width: r.width, height: r.height };
        }));
        assert.ok(checkboxBoxes.length === 5, `all five seeded rows render a checkbox at ${viewport.width}`);
        for (const box of checkboxBoxes) {
          assert.ok(box.left >= 0 && box.right <= viewport.width, `a row's checkbox stays inside the ${viewport.width}-wide viewport`);
          assert.ok(box.width >= 44 && box.height >= 44, `a row's checkbox is at least 44x44 at ${viewport.width} (got ${box.width}x${box.height})`);
        }

        const titleBoxes = await page.evaluate(() => Array.from(document.querySelectorAll('.triage-table .triage-title-btn')).map((b) => {
          const r = b.getBoundingClientRect();
          return { left: r.left, right: r.right, height: r.height, scrollWidth: b.scrollWidth, clientWidth: b.clientWidth };
        }));
        assert.ok(titleBoxes.length === 5, `all five titles render at ${viewport.width}`);
        for (const box of titleBoxes) {
          assert.ok(box.left >= 0 && box.right <= viewport.width, `a title control stays inside the ${viewport.width}-wide viewport`);
          assert.ok(box.height >= 44, `a title control is at least 44 high at ${viewport.width} (got ${box.height})`);
          assert.ok(box.scrollWidth <= box.clientWidth + 1, `a title control's text is not clipped at ${viewport.width} (scrollWidth ${box.scrollWidth} vs clientWidth ${box.clientWidth})`);
        }

        await page.close();
      }
    } finally {
      await browser.close();
    }
  });

  it('P-1: below the breakpoint each learning is a stacked block, title then meta line then reason line, checkbox level with the title', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page = await openDashboard(browser, { width: 375, height: 900 });

      const rects = await page.evaluate(() => {
        function rectOf(sel, root) {
          const el = (root || document).querySelector(sel);
          return el ? el.getBoundingClientRect() : null;
        }
        const row = document.getElementById('triage-row-lrn_needs_eyes');
        return {
          check: rectOf('.triage-cell-check', row),
          title: rectOf('.triage-cell-title', row),
          // R2: quality/category/lane/submitted are hidden below the
          // breakpoint -- .triage-cell-meta-mobile is the single visible
          // cell that holds independent copies of all four as a
          // wrapping row of badges.
          meta: rectOf('.triage-cell-meta-mobile', row),
          whyMobile: rectOf('.triage-cell-why-mobile', row),
        };
      });
      for (const key of Object.keys(rects)) {
        assert.ok(rects[key], `.triage-cell-${key} rendered for lrn_needs_eyes`);
      }
      // Checkbox sits at the left of the block, level with the title (top
      // edges close together -- both are line 1).
      assert.ok(Math.abs(rects.check.top - rects.title.top) <= 8, `checkbox top (${rects.check.top}) is level with title top (${rects.title.top})`);
      assert.ok(rects.check.left < rects.title.left, 'checkbox sits to the left of the title');

      // Title, then the meta line (score/category/lane/date badges), then
      // the reason line, in that top-to-bottom order.
      assert.ok(rects.title.top < rects.meta.top, 'title renders above the meta line');
      assert.ok(rects.meta.bottom <= rects.whyMobile.top + 1, 'the reason line renders after the meta line, not before it');

      // The 900+-only copies (nested under the title; the four hidden
      // cells) must not also be visible below the breakpoint -- otherwise
      // content renders twice.
      const desktopCopiesVisible = await page.evaluate(() => {
        const row = document.getElementById('triage-row-lrn_needs_eyes');
        const sels = ['.triage-why--desktop', '.triage-cell-quality', '.triage-cell-category', '.triage-cell-lane', '.triage-cell-submitted'];
        return sels.map((sel) => {
          const el = row.querySelector(sel);
          if (!el) return false;
          return getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
        });
      });
      assert.deepEqual(desktopCopiesVisible, [false, false, false, false, false], 'none of the 900+-only copies are also visible at 375');

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('P-2: title control is fully inside the viewport, wraps, and is not clipped for a title with spaces, without spaces, or a long tag, at 375 and 320', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      for (const viewport of [{ width: 375, height: 900 }, { width: 320, height: 900 }]) {
        const page = await openDashboard(browser, viewport);
        for (const id of ['lrn_ready_a', 'lrn_ready_b', 'lrn_ready_c']) {
          const box = await page.evaluate((rowId) => {
            const btn = document.querySelector('#triage-row-' + rowId + ' .triage-title-btn');
            const r = btn.getBoundingClientRect();
            return { left: r.left, right: r.right, height: r.height, scrollWidth: btn.scrollWidth, clientWidth: btn.clientWidth };
          }, id);
          assert.ok(box.left >= 0 && box.right <= viewport.width, `${id}'s title stays inside the ${viewport.width}-wide viewport`);
          assert.ok(box.height >= 44, `${id}'s title control is at least 44 high at ${viewport.width}`);
          assert.ok(box.scrollWidth <= box.clientWidth + 1, `${id}'s title text is not clipped at ${viewport.width}`);
        }
        // The long-tag row's tag (rendered below the breakpoint inside the
        // visible .triage-cell-meta-mobile cell, R2) also stays inside the
        // viewport -- no sideways overflow from an unbroken tag string.
        const tagRight = await page.evaluate(() => {
          const tag = document.querySelector('#triage-row-lrn_ready_b .triage-cell-meta-mobile .tag');
          return tag ? tag.getBoundingClientRect().right : null;
        });
        assert.ok(tagRight != null, `the long tag renders at ${viewport.width}`);
        assert.ok(tagRight <= viewport.width, `the long tag stays inside the ${viewport.width}-wide viewport`);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  });

  it('P-2 (last sentence, every width): a title with no spaces breaks instead of running off, at 1280 too', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page = await openDashboard(browser, { width: 1280, height: 900 });
      const measured = await page.evaluate(() => {
        const table = document.querySelector('.triage-table');
        const btn = document.querySelector('#triage-row-lrn_ready_c .triage-title-btn');
        return {
          tableRight: table.getBoundingClientRect().right,
          titleRight: btn.getBoundingClientRect().right,
          scrollWidth: btn.scrollWidth,
          clientWidth: btn.clientWidth,
        };
      });
      assert.ok(measured.titleRight <= measured.tableRight + 1, `the no-space title does not extend past the table's right edge (title right ${measured.titleRight} vs table right ${measured.tableRight})`);
      assert.ok(measured.scrollWidth <= measured.clientWidth + 1, "the no-space title's text is not clipped at 1280");
      const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      assert.ok(noHScroll, 'no page-level horizontal scroll at 1280 with a no-space title present');
      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('R3-1: at 1280 every column matches production\'s left edge and width exactly (no column floor)', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page = await openDashboard(browser, { width: 1280, height: 900 });
      const cols = await page.evaluate(() => Array.from(document.querySelectorAll('.triage-table thead th')).map((th) => {
        const r = th.getBoundingClientRect();
        return { label: th.textContent, left: r.left, width: r.width };
      }));

      // Pinned literals -- measured at build time, NOT by this file, from
      // git HEAD:public/dashboard.html (true production, before any round
      // of this fix) staged in a full tree copy OUTSIDE the repo, booted,
      // and rendered at 1280 with this exact seed. This test only reads
      // the live DOM; it never touches git history itself.
      const PRODUCTION_COLUMNS_1280 = [
        { label: '', left: 265, width: 33 },
        { label: 'Quality', left: 298, width: 72.234375 },
        { label: 'Category', left: 370.234375, width: 120.234375 },
        { label: 'Lane / signals', left: 490.46875, width: 115.0625 },
        { label: 'Title', left: 605.53125, width: 1146.59375 },
        { label: 'Submitted', left: 1752.125, width: 90.421875 },
      ];

      assert.equal(cols.length, PRODUCTION_COLUMNS_1280.length, 'same column count as production');
      for (let i = 0; i < cols.length; i++) {
        assert.equal(cols[i].label, PRODUCTION_COLUMNS_1280[i].label, `column ${i} label matches production`);
        assert.ok(Math.abs(cols[i].left - PRODUCTION_COLUMNS_1280[i].left) <= 0.5,
          `column ${i} (${cols[i].label}) left edge matches production (got ${cols[i].left}, production ${PRODUCTION_COLUMNS_1280[i].left})`);
        assert.ok(Math.abs(cols[i].width - PRODUCTION_COLUMNS_1280[i].width) <= 0.5,
          `column ${i} (${cols[i].label}) width matches production (got ${cols[i].width}, production ${PRODUCTION_COLUMNS_1280[i].width})`);
      }
      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('R2-1/R2-2/R2-3: a badge never breaks inside a word, at 320, 375, 899, 900 and 1280', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      for (const width of [320, 375, 899, 900, 1280]) {
        const page = await openDashboard(browser, { width, height: 900 });

        const measured = await page.evaluate(() => {
          // Only actually-rendered tags -- getClientRects().length is 0 for
          // a display:none element, so this naturally picks the right set
          // of duplicates for the current width (the mobile meta cell's
          // copies below the breakpoint, the desktop category/lane cells
          // at the breakpoint and above) without the test needing to
          // branch on width itself.
          const visibleTags = Array.from(document.querySelectorAll('.tag')).filter((el) => el.getClientRects().length > 0);
          const reference = visibleTags.find((el) => el.textContent.trim().toLowerCase() === 'ready');
          const refHeight = reference ? reference.getBoundingClientRect().height : null;
          const oneWordBadges = visibleTags
            .filter((el) => {
              const text = el.textContent.trim();
              return text.length > 0 && text.length <= 20 && !/\s/.test(text);
            })
            .map((el) => ({ text: el.textContent.trim(), height: el.getBoundingClientRect().height }));
          const metaMobile = document.querySelector('.triage-cell-meta-mobile');
          const metaMobileVisible = !!(metaMobile && metaMobile.getClientRects().length > 0);
          return {
            refHeight,
            oneWordBadges,
            metaMobileVisible,
            metaMobileScroll: metaMobileVisible ? { scrollWidth: metaMobile.scrollWidth, clientWidth: metaMobile.clientWidth } : null,
          };
        });

        assert.ok(measured.refHeight != null, `a one-line "READY" badge is visible and measurable at ${width}`);
        assert.ok(measured.oneWordBadges.length > 0, `at least one no-space badge <=20 chars is visible at ${width}`);

        if (width < 900) {
          // Below the breakpoint, each row's badges live in their OWN
          // independent flex-wrap cell (R2-1) -- a badge is never
          // squeezed by another row's content, so every one of them is
          // one line high here regardless of what this seed's pathological
          // rows (the 70-char tag, the 120-char titles) do elsewhere.
          for (const badge of measured.oneWordBadges) {
            assert.ok(Math.abs(badge.height - measured.refHeight) <= 2,
              `badge "${badge.text}" renders as one line (height ${badge.height} vs the READY reference ${measured.refHeight}) at ${width}`);
          }
          assert.ok(measured.metaMobileVisible, `.triage-cell-meta-mobile is the visible badges row at ${width}`);
          assert.ok(measured.metaMobileScroll.scrollWidth <= measured.metaMobileScroll.clientWidth + 1,
            `the badges row does not scroll sideways at ${width} (scrollWidth ${measured.metaMobileScroll.scrollWidth} vs clientWidth ${measured.metaMobileScroll.clientWidth})`);
        } else {
          // At and above the breakpoint this seed's OWN column is shared
          // table-wide (auto table layout), so the 70-char tag row and the
          // 120-char title rows squeeze Category for every row, including
          // this seed's "code-execution" rows -- and R3-1 requires that
          // exact, production-matching behavior to hold, not a one-line
          // guarantee this seed cannot satisfy. "Every real badge is one
          // line at the breakpoint" is proven separately, with realistic
          // content, by the R3-2 describe block below.
          assert.equal(measured.metaMobileVisible, false, `.triage-cell-meta-mobile is hidden at ${width} (R2-3/R3-1: desktop unchanged)`);
        }

        await page.close();
      }
    } finally {
      await browser.close();
    }
  });

  it('R2-2: the long-tag seed breaks only after a hyphen, never inside a run', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page = await openDashboard(browser, { width: 375, height: 900 });

      // Read the actual rendered LINE BOXES via DOM Range + getClientRects,
      // walking character by character: whenever the client rect's top
      // jumps, a new visual line began. This proves where the browser
      // actually broke the text, rather than predicting a line count.
      const result = await page.evaluate(() => {
        const tag = document.querySelector('#triage-row-lrn_ready_b .triage-cell-meta-mobile .tag');
        const textNode = tag.firstChild;
        const full = textNode.textContent;
        const range = document.createRange();
        const lines = [];
        let start = 0;
        let prevTop = null;
        for (let i = 1; i <= full.length; i++) {
          range.setStart(textNode, i - 1);
          range.setEnd(textNode, i);
          const r = range.getClientRects()[0];
          if (!r) continue;
          if (prevTop === null) prevTop = r.top;
          if (Math.abs(r.top - prevTop) > 2) {
            lines.push(full.slice(start, i - 1));
            start = i - 1;
            prevTop = r.top;
          }
        }
        lines.push(full.slice(start));
        return { full, lines };
      });

      assert.ok(result.lines.length > 1, 'the long tag actually wraps onto more than one line at 375 (not a vacuous check)');
      assert.equal(result.lines.join(''), result.full, 'the detected lines reconstruct the original text exactly -- no character lost or duplicated by the line-detection walk');
      for (let i = 0; i < result.lines.length - 1; i++) {
        assert.ok(result.lines[i].endsWith('-'), `line ${i + 1} ("${result.lines[i]}") ends at a hyphen, not mid-word`);
      }
      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('R3-3: stacked-block spacing is 8px within a row, 8px between rows, and one uniform 16px value between blocks (including across a group heading), at 320 and 375', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      for (const viewport of [{ width: 375, height: 900 }, { width: 320, height: 900 }]) {
        const page = await openDashboard(browser, viewport);

        // Within one block (lrn_needs_eyes: title -> meta row -> reason
        // row), and within the meta row, gaps between neighbouring items.
        const gaps = await page.evaluate(() => {
          const row = document.getElementById('triage-row-lrn_needs_eyes');
          const titleRect = row.querySelector('.triage-cell-title').getBoundingClientRect();
          const metaRect = row.querySelector('.triage-cell-meta-mobile').getBoundingClientRect();
          const whyRect = row.querySelector('.triage-cell-why-mobile').getBoundingClientRect();
          const items = Array.from(row.querySelectorAll('.triage-cell-meta-mobile > *')).map((el) => el.getBoundingClientRect());
          // For each neighbouring pair: same line means their vertical
          // ranges overlap (align-items:center means a shorter badge's
          // OWN top can differ from a taller neighbor's top by several
          // pixels even on the same line -- comparing tops directly is
          // not reliable) -- the gap is then the horizontal distance;
          // otherwise the pair straddles a wrap, and the gap is the
          // vertical distance.
          const sameLineGaps = [];
          const lineGaps = [];
          for (let i = 1; i < items.length; i++) {
            const prev = items[i - 1];
            const cur = items[i];
            const sameLine = !(prev.bottom <= cur.top || cur.bottom <= prev.top);
            if (sameLine) {
              sameLineGaps.push(cur.left - prev.right);
            } else {
              lineGaps.push(cur.top - prev.bottom);
            }
          }
          return {
            titleToMeta: metaRect.top - titleRect.bottom,
            metaToWhy: whyRect.top - metaRect.bottom,
            itemCount: items.length,
            sameLineGaps,
            lineGaps,
          };
        });

        assert.ok(gaps.itemCount >= 3, `the meta row has multiple badges to measure gaps between at ${viewport.width}`);
        assert.ok(Math.abs(gaps.titleToMeta - 8) <= 0.5, `title to row is 8px at ${viewport.width} (got ${gaps.titleToMeta})`);
        assert.ok(Math.abs(gaps.metaToWhy - 8) <= 0.5, `row to reason line is 8px at ${viewport.width} (got ${gaps.metaToWhy})`);
        assert.ok(gaps.sameLineGaps.length > 0, `at least one same-line neighbour pair measured at ${viewport.width}`);
        for (const g of gaps.sameLineGaps) {
          assert.ok(Math.abs(g - 8) <= 0.5, `same-line item gap is 8px at ${viewport.width} (got ${g})`);
        }
        assert.ok(gaps.lineGaps.length > 0, `at least one line-wrap gap measured at ${viewport.width}`);
        for (const g of gaps.lineGaps) {
          assert.ok(Math.abs(g - 8) <= 0.5, `row-to-row line gap is 8px at ${viewport.width} (got ${g})`);
        }

        // Between blocks -- ONE uniform value everywhere, group headings
        // included.
        const blockGaps = await page.evaluate(() => {
          const rows = Array.from(document.querySelectorAll('#pending-content .triage-table tbody > tr'));
          const out = [];
          for (let i = 1; i < rows.length; i++) {
            const prevRect = rows[i - 1].getBoundingClientRect();
            const curRect = rows[i].getBoundingClientRect();
            out.push({
              gap: curRect.top - prevRect.bottom,
              isGroupBoundary: rows[i].classList.contains('triage-group-row') || rows[i - 1].classList.contains('triage-group-row'),
            });
          }
          return out;
        });
        assert.ok(blockGaps.length > 1, `multiple block-to-block gaps measured at ${viewport.width}`);
        assert.ok(blockGaps.some((g) => g.isGroupBoundary), `at least one measured gap crosses a group heading at ${viewport.width}`);
        assert.ok(blockGaps.some((g) => !g.isGroupBoundary), `at least one measured gap is between two ordinary blocks at ${viewport.width}`);
        for (const g of blockGaps) {
          assert.ok(Math.abs(g.gap - 16) <= 0.5,
            `every block-to-block gap (group-heading boundary: ${g.isGroupBoundary}) is the SAME 16px value at ${viewport.width} (got ${g.gap})`);
        }

        await page.close();
      }
    } finally {
      await browser.close();
    }
  });

  it('P-3: the table keeps explicit ARIA table semantics at every width, and cells that lose their header carry a name', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      for (const viewport of [{ width: 375, height: 900 }, { width: 1280, height: 900 }]) {
        const page = await openDashboard(browser, viewport);
        const roles = await page.evaluate(() => ({
          table: document.querySelector('.triage-table').getAttribute('role'),
          thead: document.querySelector('.triage-table thead').getAttribute('role'),
          tbody: document.querySelector('.triage-table tbody').getAttribute('role'),
          row: document.querySelector('.triage-data-row').getAttribute('role'),
          th: document.querySelector('.triage-table th').getAttribute('role'),
          cell: document.querySelector('.triage-cell-quality').getAttribute('role'),
        }));
        assert.equal(roles.table, 'table', `table role at ${viewport.width}`);
        assert.equal(roles.thead, 'rowgroup', `thead role at ${viewport.width}`);
        assert.equal(roles.tbody, 'rowgroup', `tbody role at ${viewport.width}`);
        assert.equal(roles.row, 'row', `data row role at ${viewport.width}`);
        assert.equal(roles.th, 'columnheader', `th role at ${viewport.width}`);
        assert.equal(roles.cell, 'cell', `td role at ${viewport.width}`);
        await page.close();
      }

      const page = await openDashboard(browser, { width: 375, height: 900 });
      const headerHidden = await page.evaluate(() => getComputedStyle(document.querySelector('.triage-table thead')).display === 'none');
      assert.equal(headerHidden, true, 'the column header row is not shown below the breakpoint');

      // R2: below the breakpoint the individually-labeled quality/
      // category/lane cells are hidden -- the single visible
      // .triage-cell-meta-mobile cell carries a combined name instead, so
      // this is what a screen reader actually reaches at this width.
      const metaLabel = await page.evaluate(() => {
        const row = document.getElementById('triage-row-lrn_ready_a');
        return row.querySelector('.triage-cell-meta-mobile').getAttribute('aria-label');
      });
      assert.match(metaLabel, /Quality 19\/20/, 'the meta cell names the quality');
      assert.match(metaLabel, /Category /, 'the meta cell names the category');
      assert.match(metaLabel, /Lane and signals: /, 'the meta cell names the lane/signals');
      await page.close();

      // At 1280 the individually-labeled originals are the visible (and
      // accessible) ones, unchanged from the first pass of this fix.
      const page2 = await openDashboard(browser, { width: 1280, height: 900 });
      const labels = await page2.evaluate(() => {
        const row = document.getElementById('triage-row-lrn_ready_a');
        return {
          quality: row.querySelector('.triage-cell-quality').getAttribute('aria-label'),
          category: row.querySelector('.triage-cell-category').getAttribute('aria-label'),
          lane: row.querySelector('.triage-cell-lane').getAttribute('aria-label'),
        };
      });
      assert.equal(labels.quality, 'Quality 19/20', 'the quality cell keeps a name a screen reader announces at 1280');
      assert.match(labels.category, /^Category /, 'the category cell keeps a name a screen reader announces at 1280');
      assert.match(labels.lane, /^Lane and signals: /, 'the lane/signals cell keeps a name a screen reader announces at 1280');
      await page2.close();
    } finally {
      await browser.close();
    }
  });

  it('P-4: group headings (Ready to publish, Needs a score, Needs your eyes) render above their blocks with counts, at 375', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page = await openDashboard(browser, { width: 375, height: 900 });
      const text = await page.evaluate(() => document.getElementById('pending-content').textContent.replace(/\s+/g, ' '));
      assert.ok(text.includes('Ready to publish (3)'), 'the ready group label renders with its count');
      assert.ok(text.includes('Needs a score (1)'), 'the needs-a-score group label renders with its count');
      assert.ok(text.includes('Needs your eyes (1)'), 'the needs-your-eyes group label renders with its count');

      const order = await page.evaluate(() => {
        const groupTop = document.querySelector('.triage-group-row').getBoundingClientRect().top;
        const firstBlockTop = document.querySelector('.triage-data-row').getBoundingClientRect().top;
        return { groupTop, firstBlockTop };
      });
      assert.ok(order.groupTop <= order.firstBlockTop, 'the first group heading renders above its first block');
      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('P-9: select-all, clear, a row checkbox, and opening a learning from its title all work by click and by keyboard at 375, matching 1280', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      for (const viewport of [{ width: 375, height: 900 }, { width: 1280, height: 900 }]) {
        const page = await openDashboard(browser, viewport);

        // select-all by click
        await page.click('.bulk-bar button:has-text("Select all")');
        await page.waitForFunction(() => document.getElementById('bulk-approve-btn').textContent === 'Approve selected (5)', { timeout: 10_000 });

        // clear, then select-all by keyboard
        await page.click('.bulk-bar button:has-text("Clear")');
        await page.waitForFunction(() => document.getElementById('bulk-approve-btn').textContent === 'Approve selected (0)', { timeout: 10_000 });
        await page.focus('.bulk-bar button:has-text("Select all")');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.getElementById('bulk-approve-btn').textContent === 'Approve selected (5)', { timeout: 10_000 });

        // clear, then a single row checkbox by click
        await page.click('.bulk-bar button:has-text("Clear")');
        await page.waitForFunction(() => document.getElementById('bulk-approve-btn').textContent === 'Approve selected (0)', { timeout: 10_000 });
        await page.click('#triage-check-lrn_ready_a');
        await page.waitForFunction(() => document.getElementById('bulk-approve-btn').textContent === 'Approve selected (1)', { timeout: 10_000 });
        const checkedByClick = await page.evaluate(() => document.getElementById('triage-check-lrn_ready_a').checked);
        assert.equal(checkedByClick, true, `a row checkbox reflects checked=true after a click at ${viewport.width}`);

        // same row checkbox by keyboard
        await page.click('.bulk-bar button:has-text("Clear")');
        await page.waitForFunction(() => document.getElementById('bulk-approve-btn').textContent === 'Approve selected (0)', { timeout: 10_000 });
        await page.focus('#triage-check-lrn_ready_a');
        await page.keyboard.press('Space');
        await page.waitForFunction(() => document.getElementById('bulk-approve-btn').textContent === 'Approve selected (1)', { timeout: 10_000 });
        const checkedByKeyboard = await page.evaluate(() => document.getElementById('triage-check-lrn_ready_a').checked);
        assert.equal(checkedByKeyboard, true, `a row checkbox reflects checked=true after a Space keypress at ${viewport.width}`);

        // opening a learning from its title, by click
        await page.click('#triage-row-lrn_ready_a .triage-title-btn');
        await page.waitForSelector('#triage-detail-lrn_ready_a', { state: 'attached' });
        await page.click('#triage-row-lrn_ready_a .triage-title-btn');
        await page.waitForSelector('#triage-detail-lrn_ready_a', { state: 'detached' });

        // opening a learning from its title, by keyboard
        await page.focus('#triage-row-lrn_ready_a .triage-title-btn');
        await page.keyboard.press('Enter');
        await page.waitForSelector('#triage-detail-lrn_ready_a', { state: 'attached' });
        await page.keyboard.press('Enter');
        await page.waitForSelector('#triage-detail-lrn_ready_a', { state: 'detached' });

        await page.close();
      }
    } finally {
      await browser.close();
    }
  });

  it('P-7: at 1280 the table looks as it does today (six columns, header visible, checkbox not enlarged)', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page = await openDashboard(browser, { width: 1280, height: 900 });
      const headerVisible = await page.evaluate(() => getComputedStyle(document.querySelector('.triage-table thead')).display !== 'none');
      assert.equal(headerVisible, true, 'the header row is visible at 1280');
      const cols = await page.evaluate(() => Array.from(document.querySelectorAll('.triage-table thead th')).map((th) => th.textContent));
      assert.deepEqual(cols, ['', 'Quality', 'Category', 'Lane / signals', 'Title', 'Submitted']);
      const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      assert.ok(noHScroll, 'no page-level horizontal scroll at 1280');
      // P-6's 44x44 tap-target floor is scoped to phone width -- at 1280
      // the checkbox's own footprint is unchanged from before this fix.
      const checkSize = await page.evaluate(() => document.querySelector('.triage-check-label').getBoundingClientRect());
      assert.ok(checkSize.width < 30 && checkSize.height < 30, `the checkbox tap target is NOT enlarged at 1280 (got ${checkSize.width}x${checkSize.height})`);
      await page.close();
    } finally {
      await browser.close();
    }
  });
});

describe('R3-2: the table/stack breakpoint is measured, not the literal number 600', { timeout: 120_000 }, () => {
  // A SEPARATE, REALISTIC seed -- not the pathological 120-char-title/
  // 70-char-tag torture seed used by the describe block above. Why: the
  // breakpoint is defined by the narrowest width at which PRODUCTION'S
  // OWN table (no column floor) shows every real no-space badge <=20
  // chars one line high, with no sideways scroll. Auto table layout sizes
  // ONE column width for the WHOLE table, so an extreme value in any row
  // (the synthetic 70-char tag, or a 120-char title's effect on the
  // Title column) squeezes ordinary badges in every OTHER row too --
  // measured at build time, that combination never fits under this
  // card's own 860px max-width (.dash-wrap), not even at 1280. That is a
  // real, R3-1-pinned property of one extreme synthetic combination, not
  // what "the narrowest width where production's table fits everyone"
  // means for ordinary content. So this measurement -- and the test below
  // that exercises it -- uses realistic content: an ordinary title, the
  // longest real category enum value (payment-financial), and the
  // longest real no-space lane/signal label (injection).
  let tmpDir;
  let child;
  let baseUrl;
  let bootSkipReason = null;
  let playwright;

  const ME2 = 'acc_review_breakpoint';
  const SESSION_SECRET2 = 'review-table-breakpoint-session-secret-32';

  function realisticLearning(id, overrides) {
    return Object.assign({
      id,
      title: `Ordinary title for learning ${id}`,
      body: `body of ${id}`,
      category: 'code-execution',
      status: 'pending_review',
      contributor_account_id: ME2,
      created_at: '2026-07-01T00:00:00.000Z',
      quality_self_assessment: { total: 15 },
    }, overrides || {});
  }

  before(async () => {
    try {
      playwright = require(path.join(REPO, 'node_modules', 'playwright'));
    } catch (e) {
      bootSkipReason = 'playwright not resolvable: ' + e.message;
      return;
    }
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if (reservation.skipReason) { bootSkipReason = reservation.skipReason; return; }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-review-breakpoint-'));
    const staged = stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port: reservation.port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['docs'],
      copyDirs: ['lib', 'public', 'prompts', 'config'],
    });
    const dataDir = staged.dataDir;
    const learnings = [
      realisticLearning('lrn_a', { quality_self_assessment: { total: 19 }, category: 'payment-financial' }),
      realisticLearning('lrn_b', { injection_flags: [{ pattern_id: 'ignore_previous' }], quality_self_assessment: { total: 20 }, category: 'data-processing' }),
    ];
    fs.writeFileSync(path.join(dataDir, 'learnings.json'), JSON.stringify(learnings, null, 2));
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
      [ME2]: { id: ME2, email: 'review-breakpoint@example.com', created_at: new Date().toISOString() },
    }, null, 2));
    fs.writeFileSync(path.join(dataDir, 'earnings.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(dataDir, 'magic_links.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(dataDir, 'credits.json'), JSON.stringify({}, null, 2));

    const bootResult = await bootServer({
      tmpDir,
      port: reservation.port,
      env: {
        NODE_ENV: 'test',
        SESSION_SECRET: SESSION_SECRET2,
        RESEND_API_KEY: '',
        LLM_SENSITIVITY_ENABLED: 'false',
        WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32),
      },
      timeoutMs: 60_000,
      maxAttempts: 4,
    });
    if (bootResult.skipReason) { bootSkipReason = bootResult.skipReason; return; }
    child = bootResult.child;
    baseUrl = bootResult.baseUrl;
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function openDashboard(browser, viewport) {
    const token = await new SignJWT({ accountId: ME2, email: 'review-breakpoint@example.com' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(Buffer.from(SESSION_SECRET2));
    const page = await browser.newPage({ viewport });
    await page.addInitScript((t) => { localStorage.setItem('auxilo_session', t); }, token);
    await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.triage-table tbody tr', { state: 'attached' });
    return page;
  }

  it('at 899 the layout is the stack and at 900 it is the table, and every badge <=20 chars is one line high in both', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page899 = await openDashboard(browser, { width: 899, height: 900 });
      const at899 = await page899.evaluate(() => ({
        headerHidden: getComputedStyle(document.querySelector('.triage-table thead')).display === 'none',
        metaMobileVisible: !!document.querySelector('.triage-cell-meta-mobile') && document.querySelector('.triage-cell-meta-mobile').getClientRects().length > 0,
      }));
      assert.equal(at899.headerHidden, true, '899 is stacked: the column header is hidden');
      assert.equal(at899.metaMobileVisible, true, '899 is stacked: the mobile meta cell is visible');

      const page900 = await openDashboard(browser, { width: 900, height: 900 });
      const at900 = await page900.evaluate(() => ({
        headerVisible: getComputedStyle(document.querySelector('.triage-table thead')).display !== 'none',
        metaMobileVisible: !!document.querySelector('.triage-cell-meta-mobile') && document.querySelector('.triage-cell-meta-mobile').getClientRects().length > 0,
      }));
      assert.equal(at900.headerVisible, true, '900 is the table: the column header is visible');
      assert.equal(at900.metaMobileVisible, false, '900 is the table: the mobile meta cell is hidden');

      for (const [page, width] of [[page899, 899], [page900, 900]]) {
        const measured = await page.evaluate(() => {
          const visibleTags = Array.from(document.querySelectorAll('.tag')).filter((el) => el.getClientRects().length > 0);
          const reference = visibleTags.find((el) => el.textContent.trim().toLowerCase() === 'ready');
          const refHeight = reference ? reference.getBoundingClientRect().height : null;
          const oneWordBadges = visibleTags
            .filter((el) => { const t = el.textContent.trim(); return t.length > 0 && t.length <= 20 && !/\s/.test(t); })
            .map((el) => ({ text: el.textContent.trim(), height: el.getBoundingClientRect().height }));
          const wrap = document.querySelector('.triage-table-wrap');
          const noWrapScroll = wrap.scrollWidth <= wrap.clientWidth + 1;
          return { refHeight, oneWordBadges, noWrapScroll };
        });
        assert.ok(measured.refHeight != null, `a one-line reference ("ready") badge is visible at ${width}`);
        assert.ok(measured.oneWordBadges.length >= 3, `every no-space badge <=20 chars is visible at ${width} (got ${measured.oneWordBadges.length})`);
        for (const badge of measured.oneWordBadges) {
          assert.ok(Math.abs(badge.height - measured.refHeight) <= 0.5,
            `badge "${badge.text}" is one line at ${width} (height ${badge.height} vs reference ${measured.refHeight})`);
        }
        assert.ok(measured.noWrapScroll, `no sideways scroll at ${width}`);
      }

      await page899.close();
      await page900.close();
    } finally {
      await browser.close();
    }
  });
});
