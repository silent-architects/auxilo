'use strict';

/**
 * test/launch-wave-ssr-markers.test.js — LAUNCH-WAVE-0926 register P, row
 * P-07 (SITE-PM, 2026-09-26).
 *
 * THE BUG (confirmed live on production): renderLiveCatalogStats in
 * server.js fills server-side stat cells with a comment-blind regex, e.g.
 * `.replace(/(id="lc-price-range"[^>]*>)[^<]*</g, ...)`. If the literal
 * string `id="lc-price-range"` (or any other lc-* id the function fills)
 * appears anywhere in the page OTHER than the real element's opening tag —
 * for example inside a CSS comment in a <style> block — the regex's
 * `[^>]*>` runs forward to the NEXT `>` character in the document (which
 * can be arbitrarily far away, e.g. the `>` of `</style>` itself) and
 * injects the filled value as bare text at that point. When that point
 * lands between `</style>` and `<body>`, the browser foster-parents the
 * stray text to the start of <body>, ahead of the skip link, where screen
 * readers and crawlers read it first.
 *
 * public/for-agents.html carried exactly this trap (two CSS comments in its
 * <style> block spelled out `id="lc-price-range"` literally) and is fixed
 * in this unit by rewording the comments so the literal id-attribute string
 * no longer appears outside the real element. Server.js is NOT touched by
 * this unit — the fix is page-side only.
 *
 * This file:
 *   1. Static: for public/for-agents.html, public/pricing.html,
 *      public/for-builders.html, public/how-it-works.html — every
 *      server-filled id literal (id="lc-...") occurs the same number of
 *      times as it occurs inside a genuine element's opening tag. A
 *      positive control (synthetic markup with the id duplicated inside an
 *      HTML comment) proves the detector actually catches a mismatch.
 *   2. Served: boot the staged server, fetch /for-agents, and confirm (a)
 *      the text between the last </style> in <head> and the next tag is
 *      empty/whitespace only, and (b) the first non-whitespace text inside
 *      <body> is the skip link's own text, not stray injected content.
 *
 * Runner: node --test test/launch-wave-ssr-markers.test.js
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

const PAGE_FILES = ['for-agents.html', 'pricing.html', 'for-builders.html', 'how-it-works.html'];

// Every id renderLiveCatalogStats fills or removes by regex (BUILDER-RULES.md
// "Things the server depends on" + the fill list read directly from server.js).
const SERVER_FILLED_IDS = [
  'lc-learnings',
  'lc-learnings-hero',
  'lc-categories',
  'lc-asof',
  'lc-unlocks',
  'lc-paid',
  'lc-price-range',
  'lc-supply-line',
];

function countLiteral(html, id) {
  return html.split(`id="${id}"`).length - 1;
}

/** Counts occurrences of id="ID" that sit inside a genuine element's opening
 * tag (a `<letter...>` span that is not a comment/closing tag). */
function countElementTags(html, id) {
  const tagRe = /<[a-zA-Z][^>]*>/g;
  let m;
  let n = 0;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0].includes(`id="${id}"`)) n++;
  }
  return n;
}

// ─── Test 1: static id-literal-vs-element-tag parity ───────────────────────

describe('LAUNCH-WAVE-0926 register P (P-07): server-filled id literals occur only in a real opening tag (test 1)', () => {
  it('positive control: the detector catches a literal duplicated inside an HTML comment', () => {
    const synthetic = '<!-- warning: id="lc-test" appears here too --><span id="lc-test"></span>';
    assert.equal(countLiteral(synthetic, 'lc-test'), 2, 'positive control: literal count must be 2');
    assert.equal(countElementTags(synthetic, 'lc-test'), 1, 'positive control: element-tag count must be 1 (comment excluded)');
    assert.notEqual(
      countLiteral(synthetic, 'lc-test'),
      countElementTags(synthetic, 'lc-test'),
      'positive control: the two counts must differ when a literal hides in a comment'
    );
  });

  for (const page of PAGE_FILES) {
    const html = fs.readFileSync(path.join(REPO, 'public', page), 'utf8');

    for (const id of SERVER_FILLED_IDS) {
      const literalCount = countLiteral(html, id);
      if (literalCount === 0) continue; // this page doesn't carry this cell at all
      it(`${page}: id="${id}" — literal count equals element-tag count (no comment-hidden copy)`, () => {
        const elementCount = countElementTags(html, id);
        assert.equal(
          elementCount,
          literalCount,
          `${page}: id="${id}" appears ${literalCount} time(s) as a literal but only ${elementCount} time(s) inside a real opening tag — a copy is hiding in a comment or script string`
        );
      });
    }
  }
});

// ─── Test 2: /for-agents serves no stray text ahead of the skip link ───────

describe('LAUNCH-WAVE-0926 register P (P-07): /for-agents serves no stray SSR text before the skip link (test 2)', { timeout: 120_000 }, () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-ssr-markers-'));
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
        SESSION_SECRET: 'ssr-markers-test-session-secret-0123456789',
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

  it('positive control: GET /for-agents serves 200 text/html carrying the skip link markup', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/for-agents`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^text\/html/);
    const body = await res.text();
    assert.ok(body.includes('class="skip-to-content"'), 'positive control: skip link markup is present in the served page');
  });

  it('nothing but whitespace sits between the last </style> in <head> and the next tag', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/for-agents`);
    const html = await res.text();
    const closes = [...html.matchAll(/<\/style>/g)];
    assert.ok(closes.length > 0, '/for-agents must carry at least one </style> close');
    const last = closes[closes.length - 1];
    const afterIdx = last.index + '</style>'.length;
    const nextLt = html.indexOf('<', afterIdx);
    assert.notEqual(nextLt, -1, 'a tag must follow </style>');
    const between = html.slice(afterIdx, nextLt);
    assert.equal(between.trim(), '', `text found between </style> and the next tag: ${JSON.stringify(between)}`);
  });

  it('the first non-whitespace text inside <body> is the skip link\'s own text', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/for-agents`);
    const html = await res.text();
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/);
    assert.ok(bodyMatch, '<body>...</body> found');
    const textOnly = bodyMatch[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    assert.ok(
      textOnly.startsWith('Skip to content'),
      `first visible text inside <body> must be the skip link's text, got: ${JSON.stringify(textOnly.slice(0, 80))}`
    );
  });
});
