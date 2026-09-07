'use strict';

/**
 * test/status-credit-purchases.test.js — STATUS-CREDIT-PURCHASES
 *
 * Covers the new "Credit Purchases" row on public/status.html's Service
 * Components list (Tyler-approved copy via SITE-PM, verbatim, PUNCH-LIST
 * row STATUS-CREDIT-PURCHASES):
 *
 *   1. Served /status carries the label once, the description once, and the
 *      row sits immediately after the x402 Payments row in DOM order.
 *   2. The status-cell state mapping (creditPurchasesStatus, a pure
 *      DOM-free function in status.html's inline script) yields
 *      'Operational' for {stripe_configured:true}, 'Unavailable' for
 *      stripe_configured false/missing, and '' (renders nothing) for no
 *      data at all -- mirroring the fetch-failure path, where the page
 *      never calls the mapping and the cell is left with no text. Extracted
 *      via brace-balanced source-slice + new Function, the same pattern as
 *      test/credits-e2e-findings.test.js.
 *   3. stripe_reason (and stripe_mode) never appear in status.html --
 *      neither is ever rendered on the page.
 *
 * Staged-server pattern for the served-page test: test/status-version.test.js.
 *
 * Runner: node --test test/status-credit-purchases.test.js
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
  BOOT_SANDBOX_SKIP_REASON,
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const STATUS_HTML = fs.readFileSync(path.join(REPO, 'public', 'status.html'), 'utf8');

const LABEL = 'Credit Purchases';
const DESC = 'Prepaid credit packs bought through Stripe checkout. One credit unlocks one learning.';

// ─── Helpers (mirrors test/credits-e2e-findings.test.js) ──────────────────

function extractFunctionSource(src, startMarker) {
  const start = src.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const braceStart = src.indexOf('{', start);
  assert.notEqual(braceStart, -1, `no opening brace after marker: ${startMarker}`);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  assert.ok(depth === 0, `unbalanced braces extracting: ${startMarker}`);
  return src.slice(start, i);
}

function loadPureFunction(startMarker, fnName) {
  const src = extractFunctionSource(STATUS_HTML, startMarker);
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn ${fnName};`)();
}

// ─── 1. creditPurchasesStatus (pure state mapping, DOM-free unit tests) ───

describe('STATUS-CREDIT-PURCHASES 1: creditPurchasesStatus state mapping', () => {
  const creditPurchasesStatus = loadPureFunction('function creditPurchasesStatus(data) {', 'creditPurchasesStatus');

  it('yields Operational when stripe_configured === true (strict)', () => {
    assert.equal(creditPurchasesStatus({ stripe_configured: true }), 'Operational');
  });

  it('yields Unavailable when stripe_configured is false', () => {
    assert.equal(creditPurchasesStatus({ stripe_configured: false }), 'Unavailable');
  });

  it('yields Unavailable when stripe_configured is missing', () => {
    assert.equal(creditPurchasesStatus({}), 'Unavailable');
  });

  it('yields Unavailable for a truthy-but-not-strictly-true stripe_configured (strict check, not truthy)', () => {
    assert.equal(creditPurchasesStatus({ stripe_configured: 1 }), 'Unavailable');
    assert.equal(creditPurchasesStatus({ stripe_configured: 'true' }), 'Unavailable');
  });

  it('yields "" (renders nothing) when there is no data at all, matching the fetch-failure path', () => {
    assert.equal(creditPurchasesStatus(null), '');
    assert.equal(creditPurchasesStatus(undefined), '');
  });
});

// ─── 2. Static source checks on public/status.html ────────────────────────

describe('STATUS-CREDIT-PURCHASES 2: static source checks', () => {
  it('the label appears exactly once', () => {
    const count = STATUS_HTML.split(`<span class="component-name">${LABEL}</span>`).length - 1;
    assert.equal(count, 1, 'Credit Purchases label appears exactly once');
  });

  it('the description appears exactly once', () => {
    const count = STATUS_HTML.split(DESC).length - 1;
    assert.equal(count, 1, 'Credit Purchases description appears exactly once');
  });

  it('the new row sits immediately after the x402 Payments row in source order', () => {
    const x402Idx = STATUS_HTML.indexOf('Micropayment processing on Base (USDC)');
    const creditsIdx = STATUS_HTML.indexOf(`<span class="component-name">${LABEL}</span>`);
    const payoutsIdx = STATUS_HTML.indexOf('<span class="component-name">Builder Payouts</span>');
    assert.notEqual(x402Idx, -1);
    assert.notEqual(creditsIdx, -1);
    assert.notEqual(payoutsIdx, -1);
    assert.ok(x402Idx < creditsIdx, 'x402 row precedes the Credit Purchases row');
    assert.ok(creditsIdx < payoutsIdx, 'Credit Purchases row precedes the Builder Payouts row');
    // No other component-row boundary between x402's row and the new row.
    const between = STATUS_HTML.slice(x402Idx, creditsIdx);
    assert.equal((between.match(/<div class="component-row">/g) || []).length, 1,
      'exactly one component-row div opens between the x402 description and the Credit Purchases label (the new row itself, immediately after x402 closes)');
  });

  it('stripe_reason never appears in status.html', () => {
    assert.ok(!STATUS_HTML.includes('stripe_reason'), 'stripe_reason string must never render on the status page');
  });

  it('stripe_mode never appears in status.html', () => {
    assert.ok(!STATUS_HTML.includes('stripe_mode'), 'stripe_mode string must never render on the status page');
  });

  it('the header strip literal is untouched and not composed from component states', () => {
    // The overall-status label is a static literal in the markup, only ever
    // overwritten by the pre-existing total-fetch-failure catch branch
    // (unrelated to any individual component's state, including the new
    // Credit Purchases row) -- see the script's catch block, which sets
    // statusLabel.textContent = 'Partial Degradation Detected' and nothing
    // else touches it.
    assert.ok(STATUS_HTML.includes('Operational: USDC withdrawals migrating'),
      'header strip copy is unchanged by the new row');
  });
});

// ─── 3. Served /status (staged server) ─────────────────────────────────────

describe('STATUS-CREDIT-PURCHASES 3: served /status carries the row', { timeout: 180_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;
  let bootSkipReason = null;

  before(async () => {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(
      0,
      honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length
    );
    const reservation = await reservePort();
    if ('skipReason' in reservation) {
      assert.equal(reservation.skipReason, BOOT_SANDBOX_SKIP_REASON);
      bootSkipReason = BOOT_SANDBOX_SKIP_REASON;
      return;
    }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-status-credit-purchases-'));
    stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [],
    });

    const boot = await bootServer({
      tmpDir,
      port,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        LLM_SENSITIVITY_ENABLED: 'false',
        SESSION_SECRET: 'status-credit-purchases-test-session-secret-0123456789',
        AUXILO_DATA_DIR: path.join(tmpDir, 'data'),
      },
      timeoutMs: 60_000,
      maxAttempts: 3,
    });
    if ('skipReason' in boot) {
      assert.equal(boot.skipReason, BOOT_SANDBOX_SKIP_REASON);
      bootSkipReason = BOOT_SANDBOX_SKIP_REASON;
      return;
    }
    child = boot.child;
    baseUrl = boot.baseUrl;
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /status → 200 text/html, label once, description once, row immediately after x402', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/status`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^text\/html/);
    const body = await res.text();

    const labelCount = body.split(`<span class="component-name">${LABEL}</span>`).length - 1;
    assert.equal(labelCount, 1, 'served page: Credit Purchases label appears exactly once');

    const descCount = body.split(DESC).length - 1;
    assert.equal(descCount, 1, 'served page: Credit Purchases description appears exactly once');

    const x402Idx = body.indexOf('Micropayment processing on Base (USDC)');
    const creditsIdx = body.indexOf(`<span class="component-name">${LABEL}</span>`);
    const payoutsIdx = body.indexOf('<span class="component-name">Builder Payouts</span>');
    assert.ok(x402Idx > -1 && x402Idx < creditsIdx && creditsIdx < payoutsIdx,
      'served page: row order is x402 -> Credit Purchases -> Builder Payouts');

    assert.ok(!body.includes('stripe_reason'), 'served page never renders stripe_reason');
    assert.ok(!body.includes('stripe_mode'), 'served page never renders stripe_mode');
  });
});
