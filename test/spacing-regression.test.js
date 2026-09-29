'use strict';

/**
 * test/spacing-regression.test.js — SPACING-0927 rule 9 / B-7, Round 5
 *
 * Proves type did not change: for every page in the sheet at 1280, every
 * heading/paragraph/list-item/link/button's computed font-size,
 * font-weight, line-height, font-family, letter-spacing, text-transform
 * and colour equals what production (origin/main) serves today.
 *
 * The baseline is committed (test/fixtures/spacing-type-baseline.json,
 * built from a staged origin/main copy -- see
 * test/helpers/capture-type-baseline.js, a build-time tool this test
 * never invokes) and read here by a path relative to this file. No
 * environment variable, no absolute path, no
 * skip for a missing file: if the fixture is missing, `before()` throws
 * and every test in this file fails, not skips -- a test that only runs
 * where it was written proves nothing to anyone else (CI included).
 *
 * Elements are matched by role and order WITHIN THEIR TOP-LEVEL SECTION
 * (test/helpers/type-metrics.js's key scheme: `s{sectionIndex}.{tag}
 * [{ordinalWithinSectionForThatTag}]`), not by a wrapper's position in the
 * DOM tree -- production and this build's markup differ in ways unrelated
 * to type (this build added one wrapper on /how-it-works; production
 * changed the dashboard's review table and the homepage lede's copy), and
 * matching by section+role+order survives all of that. Every element
 * present on one side and not the other is listed with a reason, not
 * silently dropped. The signed-in dashboard's review/pending-queue card
 * (#pending-review-card) is excluded on both sides (type-metrics.js).
 * /status compares no text and needs no time/uptime mask -- this fixture
 * never held any text to begin with (R5-2).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  reservePort,
  stageServer,
  bootServer,
  stopServer,
} = require('./helpers/staged-server');
const { extractTypeMetrics } = require('./helpers/type-metrics');

const REPO = path.join(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'fixtures', 'spacing-type-baseline.json');

const PAGES = [
  '/', '/for-builders', '/for-agents', '/how-it-works', '/pricing',
  '/works-with', '/about', '/connect', '/how-submissions-work',
  '/status', '/api', '/terms', '/privacy',
  '/legal/subprocessors', '/legal/supported-clients', '/dashboard',
];

describe('SPACING-0927 rule 9 / B-7: type matches production (origin/main), element by element', { timeout: 180_000 }, () => {
  let bootSkipReason = null;
  let tmpDir;
  let child;
  let baseUrl;
  let browser;
  let playwrightOk = false;
  let baseline;

  before(async () => {
    // No try/catch: a missing or unreadable fixture must fail every test
    // in this file, not skip it (R5-1).
    baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

    try {
      require.resolve('playwright', { paths: [REPO] });
    } catch (e) {
      return;
    }
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if ('skipReason' in reservation) {
      bootSkipReason = reservation.skipReason;
      return;
    }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-spacing-regression-'));
    stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: [],
      copyDirs: ['lib', 'public', 'prompts', 'config', 'docs'],
    });
    const boot = await bootServer({
      tmpDir,
      port,
      env: {
        NODE_ENV: 'test',
        SESSION_SECRET: 'spacing-regression-test-session-secret-01234',
        RESEND_API_KEY: '',
        LLM_SENSITIVITY_ENABLED: 'false',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      },
      timeoutMs: 60_000,
      maxAttempts: 3,
    });
    if ('skipReason' in boot) {
      bootSkipReason = boot.skipReason;
      return;
    }
    child = boot.child;
    baseUrl = boot.baseUrl;
    const { chromium } = require(path.join(nodeModulesDir, 'playwright'));
    browser = await chromium.launch();
    playwrightOk = true;
  });

  after(async () => {
    if (browser) await browser.close();
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  for (const route of PAGES) {
    it(`${route} @ 1280: type matches production, element by element (section+role+order)`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
      const before1280 = baseline[route];
      assert.ok(before1280 && !before1280.error, `baseline has usable data for ${route}`);

      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      try {
        await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle', timeout: 30_000 });
        await page.addStyleTag({ content: '.reveal { opacity: 1 !important; transform: none !important; }' });
        await page.waitForTimeout(120);
        const after1280 = await page.evaluate(extractTypeMetrics);

        assert.equal(after1280.sectionCount, before1280.sectionCount, `${route}: top-level section count changed (${before1280.sectionCount} -> ${after1280.sectionCount})`);
        assert.deepEqual(after1280.headingCounts, before1280.headingCounts, `${route}: heading-level counts changed`);

        const beforeByKey = new Map(before1280.elements.map((el) => [el.key, el]));
        const afterByKey = new Map(after1280.elements.map((el) => [el.key, el]));

        const unmatched = [];
        const mismatches = [];

        for (const [key, b] of beforeByKey) {
          const a = afterByKey.get(key);
          if (!a) {
            unmatched.push(`${key}: in production, not in this build (markup changed -- element removed or its section/order shifted)`);
            continue;
          }
          const bVal = { fontSize: b.fontSize, fontWeight: b.fontWeight, lineHeight: b.lineHeight, fontFamily: b.fontFamily, letterSpacing: b.letterSpacing, textTransform: b.textTransform, color: b.color };
          const aVal = { fontSize: a.fontSize, fontWeight: a.fontWeight, lineHeight: a.lineHeight, fontFamily: a.fontFamily, letterSpacing: a.letterSpacing, textTransform: a.textTransform, color: a.color };
          if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
            mismatches.push(`${key}: production=${JSON.stringify(bVal)} built=${JSON.stringify(aVal)}`);
          }
        }
        for (const key of afterByKey.keys()) {
          if (!beforeByKey.has(key)) {
            unmatched.push(`${key}: in this build, not in production (markup changed -- element added or its section/order shifted)`);
          }
        }

        assert.equal(unmatched.length, 0, `${route}: ${unmatched.length} element(s) could not be matched by section+role+order:\n  ${unmatched.join('\n  ')}`);
        assert.equal(mismatches.length, 0, `${route}: ${mismatches.length} type difference(s) from production:\n  ${mismatches.join('\n  ')}`);
      } finally {
        await ctx.close();
      }
    });
  }
});
