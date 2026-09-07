'use strict';

/**
 * test/fb-accrual-sentence.test.js — SITE-PM given (v101 wave closure): the
 * /for-builders accrual sentence moves from the flat-repeat form to the
 * ruled conditioned form —
 *
 *   OLD: "You earn on the same learning every time it unlocks, with no cap
 *        and no expiry."
 *   NEW: "You earn again on the same learning when another agent unlocks
 *        it, and nothing you publish expires while it stays in the
 *        catalog."
 *
 * Both halves were already-ruled strings (SITE-PM given, no gate) — this
 * suite is the mechanical swap-verification: old sentence gone, new
 * sentence present, exactly once each, both on the static file and on the
 * served /for-builders route (staged server, real boot — the sentence is
 * plain static markup, not server-templated, so this also proves the
 * static swap survives the serveStatic path unmodified).
 *
 * SITE-PERFECT-W2 item D (2026-09-06) gave the "again" in this sentence a
 * superscript footnote link (the Math block's asterisk marker), so the
 * checked string below now carries that inline markup between "again" and
 * "on the same learning" — the prose itself is unchanged.
 *
 * Staged-server pattern: test/ad-routes.test.js.
 *
 * Runner: node --test test/fb-accrual-sentence.test.js
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
const STATIC_HTML = fs.readFileSync(path.join(REPO, 'public', 'for-builders.html'), 'utf8');

const OLD_SENTENCE = 'You earn on the same learning every time it unlocks, with no cap and no expiry.';
const NEW_SENTENCE = 'You earn again<sup><a href="#math-footnote" aria-label="footnote">*</a></sup> on the same learning when another agent unlocks it, and nothing you publish expires while it stays in the catalog.';

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

describe('FB-ACCRUAL-GIVEN: /for-builders accrual sentence — ruled conditioned form', { timeout: 180_000 }, () => {
  describe('static file', () => {
    it('public/for-builders.html: old sentence absent, new sentence present exactly once', () => {
      assert.equal(countOccurrences(STATIC_HTML, OLD_SENTENCE), 0, 'old accrual sentence must not survive in the static file');
      assert.equal(countOccurrences(STATIC_HTML, NEW_SENTENCE), 1, 'new accrual sentence must appear exactly once in the static file');
    });
  });

  describe('served route (staged server)', () => {
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
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-fb-accrual-sentence-'));
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
          SESSION_SECRET: 'fb-accrual-sentence-test-session-secret-0123456789',
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

    it('GET /for-builders → 200 text/html, old sentence absent, new sentence present exactly once', async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      const res = await fetch(`${baseUrl}/for-builders`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /^text\/html/);
      const body = await res.text();
      assert.equal(countOccurrences(body, OLD_SENTENCE), 0, 'old accrual sentence must not survive on the served page');
      assert.equal(countOccurrences(body, NEW_SENTENCE), 1, 'new accrual sentence must appear exactly once on the served page');
    });
  });
});
