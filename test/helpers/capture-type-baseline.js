'use strict';
/**
 * test/helpers/capture-type-baseline.js — SPACING-0927 Round 5 (R5-1/R5-3)
 *
 * Builds test/fixtures/spacing-type-baseline.json from origin/main
 * (production), NOT this worktree. `git archive origin/main` extracts
 * that commit's tree to a temp folder OUTSIDE the repo; a server is
 * staged from THAT copy (never the live worktree) and the type-only
 * fingerprint (./type-metrics.js) is captured from it for every page in
 * the sheet at 1280.
 *
 * This is a BUILD-TIME tool, run by hand when the baseline needs
 * regenerating (e.g. against a newer origin/main) -- it is never invoked
 * by the test suite itself. spacing-regression.test.js reads only the
 * committed JSON this script produces, by a path relative to itself; it
 * never runs git and never reads an absolute path.
 *
 * Usage: node test/helpers/capture-type-baseline.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const OUT_PATH = path.join(REPO, 'test', 'fixtures', 'spacing-type-baseline.json');
const {
  reservePort,
  stageServer,
  bootServer,
  stopServer,
} = require('./staged-server');
const { extractTypeMetrics } = require('./type-metrics');

const PAGES = [
  '/', '/for-builders', '/for-agents', '/how-it-works', '/pricing',
  '/works-with', '/about', '/connect', '/how-submissions-work',
  '/status', '/api', '/terms', '/privacy',
  '/legal/subprocessors', '/legal/supported-clients', '/dashboard',
];

async function main() {
  // git archive origin/main | tar -x -C <temp, outside the repo>. Reading
  // git is this BUILD-TIME script's own job (R5-3); the test that reads
  // the JSON this produces never does.
  const prodDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-origin-main-'));
  console.log('extracting origin/main to', prodDir);
  const archive = execFileSync('git', ['archive', 'origin/main'], { cwd: REPO, maxBuffer: 1024 * 1024 * 256 });
  execFileSync('tar', ['-x', '-C', prodDir], { input: archive });

  const honoEntry = require.resolve('hono', { paths: [REPO] });
  const nodeModulesDir = honoEntry.slice(
    0,
    honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length
  );
  const reservation = await reservePort();
  if ('skipReason' in reservation) throw new Error(`port reservation skipped: ${reservation.skipReason}`);
  const { port } = reservation;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-type-baseline-stage-'));
  console.log('staged tmpDir:', tmpDir);

  stageServer({
    repoRoot: prodDir, // stage FROM the extracted origin/main tree, not the live worktree
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
      SESSION_SECRET: 'type-baseline-capture-session-secret-0123456789',
      RESEND_API_KEY: '',
      LLM_SENSITIVITY_ENABLED: 'false',
      WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
    },
    timeoutMs: 60_000,
    maxAttempts: 3,
  });
  if ('skipReason' in boot) throw new Error(`boot skipped: ${boot.skipReason}`);
  const { child, baseUrl } = boot;
  console.log('staged origin/main server up at', baseUrl);

  const { chromium } = require(path.join(nodeModulesDir, 'playwright'));
  const browser = await chromium.launch();
  const baseline = {};

  try {
    for (const route of PAGES) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      try {
        await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle', timeout: 30_000 });
        await page.addStyleTag({ content: '.reveal { opacity: 1 !important; transform: none !important; }' });
        await page.waitForTimeout(150);
        baseline[route] = await page.evaluate(extractTypeMetrics);
        console.log(`captured ${route}: ${baseline[route].elements.length} elements, ${baseline[route].sectionCount} sections`);
      } catch (err) {
        console.error(`FAILED ${route}:`, err.message);
        baseline[route] = { error: err.message };
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    await stopServer(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(prodDir, { recursive: true, force: true });
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(baseline, null, 2) + '\n');
  console.log('wrote', OUT_PATH);
  console.log('size:', fs.statSync(OUT_PATH).size, 'bytes');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
