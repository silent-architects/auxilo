'use strict';

/**
 * test/review-table-phone-width.test.js — FIX-UNIT-TERMS-3.md, V-1;
 * revised per Round 4 R4-6.
 *
 * R4-6 (ruling): the pending review table at phone width is NOT fixed and
 * is not part of this release -- the title column still sits outside the
 * view at 375. Only the checkbox tap-target fix (44x44, scoped to narrow
 * widths) ships. This file proves ONLY what that fix delivers, and claims
 * nothing more:
 *   - the group labels and a ready item's score are present in the
 *     rendered content
 *   - every row's checkbox sits fully inside the viewport and is at least
 *     44x44 at 375 and 320
 *   - select-all and a row checkbox both work, by click AND by keyboard
 *   - the page has no horizontal scroll
 *   - at 1280 the table is unchanged
 * It makes NO claim that every row -- or any row's title -- is readable at
 * phone width; the words "every row readable" do not belong in this file.
 *
 * Seeds an account with four pending items across the three lanes (ready
 * to publish x2, needs a score, needs your eyes), one 120-character title,
 * one long tag -- the oversized content that originally proved the title
 * column overflows is still seeded, since the checkbox/scroll claims still
 * need to hold in its presence, even though this file no longer asserts
 * anything about that title being readable.
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
const LONG_TITLE = 'A'.repeat(60) + ' review title that keeps going and going ' + 'B'.repeat(56); // 120 chars
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

describe('V-1: pending review table at phone width', { timeout: 240_000 }, () => {
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
      learning('lrn_ready_a', { quality_self_assessment: { total: 19 }, title: LONG_TITLE }),
      learning('lrn_ready_b', { quality_self_assessment: { total: 18 }, tags: [LONG_TAG] }),
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
    return page;
  }

  it('at 375 and 320: group labels and a score are present, row checkboxes are inside the viewport and >= 44x44, select-all and a row checkbox work by click and by keyboard, no horizontal scroll', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      for (const viewport of [{ width: 375, height: 812 }, { width: 320, height: 700 }]) {
        const page = await openDashboard(browser, viewport);

        const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
        assert.ok(noHScroll, `no page-level horizontal scroll at ${viewport.width}`);

        // The group labels and a ready item's score are present in the
        // rendered content. textContent, not innerText: .triage-group-row
        // td is all-caps by CSS (text-transform), and this must compare
        // the underlying content, not the rendered presentation. This is
        // NOT a claim that titles, or every row, are readable at this
        // width -- R4-6: the title column is known to sit outside the
        // view at 375, and that is out of scope for this release.
        const text = await page.evaluate(() => document.getElementById('pending-content').textContent.replace(/\s+/g, ' '));
        assert.ok(text.includes('Ready to publish'), 'the ready group label renders');
        assert.ok(text.includes('Needs a score'), 'the needs-a-score group label renders');
        assert.ok(text.includes('Needs your eyes'), 'the needs-your-eyes group label renders');
        assert.ok(text.includes('19/20') || text.includes('18/20'), 'a ready item\'s score renders');

        // Every row's checkbox tap target (the per-row action control,
        // .triage-check-label -- the checkbox itself stays small and
        // native-looking; the LABEL is the full clickable region) is fully
        // inside the viewport and at least 44x44 -- not clipped, not
        // undersized.
        const boxes = await page.evaluate(() => Array.from(document.querySelectorAll('.triage-table .triage-check-label')).map((b) => {
          const r = b.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
        }));
        assert.ok(boxes.length >= 4, 'sanity: all four seeded rows render a checkbox');
        for (const box of boxes) {
          assert.ok(box.left >= 0 && box.right <= viewport.width, `a row's checkbox stays inside the ${viewport.width}-wide viewport`);
          assert.ok(box.width >= 44 && box.height >= 44, `a row's checkbox control is at least 44x44 at ${viewport.width} (got ${box.width}x${box.height})`);
        }

        // R4-6: select-all works by click -- the approve-bar count is the
        // application-level signal that the click actually registered a
        // selection, not just that the button itself received an event.
        await page.click('.bulk-bar button:has-text("Select all")');
        await page.waitForFunction(() => document.getElementById('bulk-approve-btn').textContent === 'Approve selected (4)', { timeout: 10_000 });

        // Clear, then the same control works by keyboard alone: focus it
        // directly and press Enter, the standard way a native <button>
        // activates from the keyboard.
        await page.click('.bulk-bar button:has-text("Clear")');
        await page.waitForFunction(() => document.getElementById('bulk-approve-btn').textContent === 'Approve selected (0)', { timeout: 10_000 });
        await page.focus('.bulk-bar button:has-text("Select all")');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.getElementById('bulk-approve-btn').textContent === 'Approve selected (4)', { timeout: 10_000 });

        // Clear, then a single row checkbox works by click.
        await page.click('.bulk-bar button:has-text("Clear")');
        await page.waitForFunction(() => document.getElementById('bulk-approve-btn').textContent === 'Approve selected (0)', { timeout: 10_000 });
        await page.click('#triage-check-lrn_ready_a');
        await page.waitForFunction(() => document.getElementById('bulk-approve-btn').textContent === 'Approve selected (1)', { timeout: 10_000 });
        const checkedByClick = await page.evaluate(() => document.getElementById('triage-check-lrn_ready_a').checked);
        assert.equal(checkedByClick, true, `a row checkbox reflects checked=true after a click at ${viewport.width}`);

        // Clear, then the same row checkbox works by keyboard alone: focus
        // it directly and press Space, the standard way a native checkbox
        // toggles from the keyboard.
        await page.click('.bulk-bar button:has-text("Clear")');
        await page.waitForFunction(() => document.getElementById('bulk-approve-btn').textContent === 'Approve selected (0)', { timeout: 10_000 });
        await page.focus('#triage-check-lrn_ready_a');
        await page.keyboard.press('Space');
        await page.waitForFunction(() => document.getElementById('bulk-approve-btn').textContent === 'Approve selected (1)', { timeout: 10_000 });
        const checkedByKeyboard = await page.evaluate(() => document.getElementById('triage-check-lrn_ready_a').checked);
        assert.equal(checkedByKeyboard, true, `a row checkbox reflects checked=true after a Space keypress at ${viewport.width}`);

        await page.close();
      }
    } finally {
      await browser.close();
    }
  });

  it('at 1280 the table looks as it does today (unaffected by the phone-width fix)', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page = await openDashboard(browser, { width: 1280, height: 900 });
      const cols = await page.evaluate(() => Array.from(document.querySelectorAll('.triage-table thead th')).map((th) => th.textContent));
      assert.deepEqual(cols, ['', 'Quality', 'Category', 'Lane / signals', 'Title', 'Submitted']);
      const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      assert.ok(noHScroll, 'no page-level horizontal scroll at 1280');
      // V-1's 44x44 tap-target floor is scoped to phone width -- at 1280
      // the checkbox's own footprint is unchanged from before this fix.
      const checkSize = await page.evaluate(() => document.querySelector('.triage-check-label').getBoundingClientRect());
      assert.ok(checkSize.width < 30 && checkSize.height < 30, `the checkbox tap target is NOT enlarged at 1280 (got ${checkSize.width}x${checkSize.height})`);
      await page.close();
    } finally {
      await browser.close();
    }
  });
});
