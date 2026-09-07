'use strict';

/**
 * test/fb-control-rev2.test.js — FB-CONTROL-REV2 (2026-09-07): the
 * /for-builders "why builders" section's Sensitivity Protection sub-block
 * is rewritten and its label promoted to the section h2 (copy from
 * SITE-PM's brand-gated rev 2, after Tyler's pushback on v119).
 *
 * Before this change, section#why-builders carried its own h2
 * ("Your Agents Work. You Earn.") plus a single moat-card sub-block
 * labeled with an h3 ("Sensitivity Protection"). This change deletes the
 * section h2 and the h3 label, and promotes the h3's replacement text
 * ("You Control What Publishes") to be the section's own h2 — mirroring
 * the page's other section-heading pattern, e.g. public/for-builders.html
 * `<h2 id="faq-heading" >Common Questions</h2>`. The section keeps its id
 * ("why-builders") and background-alternation class ("section-raised"),
 * so /for-builders' total <h2> count is unchanged at 7 (one heading
 * removed, one promoted in its place).
 *
 * The moat-card body copy is also replaced in full — old sentence gone,
 * new sentence present exactly once, with "the submissions page" keeping
 * its /how-submissions-work page link (not an anchor).
 *
 * Staged-server pattern: test/fb-accrual-sentence.test.js.
 *
 * Runner: node --test test/fb-control-rev2.test.js
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

const OLD_LABEL = 'Sensitivity Protection';
const NEW_LABEL = 'You Control What Publishes';
const OLD_HEADING = 'Your Agents Work. You Earn.';
const OLD_BODY_LEAD = 'Before anything reaches the catalog';
const NEW_BODY = 'Raw transcripts never leave your machine. A local filter scans for credentials, secrets, and private data. It fails closed. How each screen works, and what it can miss, is on <a href="/how-submissions-work">the submissions page</a>. Nothing publishes until you approve it, one learning at a time or in advance in your dashboard. You can retract anything for 7 days.';
const NEW_H2 = `<h2 id="why-builders-heading" >${NEW_LABEL}</h2>`;

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function h2Count(html) {
  return (html.match(/<h2\b[^>]*>/g) || []).length;
}

describe('FB-CONTROL-REV2: /for-builders why-builders section — label promoted to section h2', { timeout: 180_000 }, () => {
  describe('static file', () => {
    it('new label appears exactly once, as the section h2', () => {
      assert.equal(countOccurrences(STATIC_HTML, NEW_H2), 1, 'new label must appear exactly once, as <h2 id="why-builders-heading">');
      assert.equal(countOccurrences(STATIC_HTML, NEW_LABEL), 1, 'new label text must appear exactly once total (no duplicated sub-block label)');
    });

    it('old label ("Sensitivity Protection") is gone', () => {
      assert.equal(countOccurrences(STATIC_HTML, OLD_LABEL), 0, 'old label must not survive');
    });

    it('old heading ("Your Agents Work. You Earn.") is gone', () => {
      assert.equal(countOccurrences(STATIC_HTML, OLD_HEADING), 0, 'old section h2 must not survive');
      assert.equal(countOccurrences(STATIC_HTML, 'Your Agents Work'), 0, 'no fragment of the old heading may survive');
    });

    it('old body copy is gone, new body copy present exactly once with its page link', () => {
      assert.equal(countOccurrences(STATIC_HTML, OLD_BODY_LEAD), 0, 'old body opening must not survive');
      assert.equal(countOccurrences(STATIC_HTML, NEW_BODY), 1, 'new body copy must appear exactly once, with the /how-submissions-work page link intact');
    });

    it('section#why-builders keeps its id and background-alternation class', () => {
      assert.match(STATIC_HTML, /<section id="why-builders" class="section-raised"/, 'section must keep its id and section-raised background slot');
    });

    it('/for-builders total <h2> count is unchanged at 7', () => {
      assert.equal(h2Count(STATIC_HTML), 7, 'total h2 count on the page must remain 7');
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
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-fb-control-rev2-'));
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
          SESSION_SECRET: 'fb-control-rev2-test-session-secret-0123456789',
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

    it('GET /for-builders → 200 text/html, new label/body present once, old label/heading/body absent', async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      const res = await fetch(`${baseUrl}/for-builders`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /^text\/html/);
      const body = await res.text();
      assert.equal(countOccurrences(body, NEW_H2), 1, 'new label must be served exactly once, as the section h2');
      assert.equal(countOccurrences(body, NEW_BODY), 1, 'new body copy must be served exactly once');
      assert.equal(countOccurrences(body, OLD_LABEL), 0, 'old label must not be served');
      assert.equal(countOccurrences(body, OLD_HEADING), 0, 'old section h2 must not be served');
      assert.equal(countOccurrences(body, OLD_BODY_LEAD), 0, 'old body opening must not be served');
      assert.equal(h2Count(body), 7, 'served page total h2 count must remain 7');
    });
  });
});
