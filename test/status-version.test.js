'use strict';

/**
 * test/status-version.test.js — AD sheet 7 (status): GET /status server-
 * renders the running package.json version into the footer badge and the
 * OpenAPI card; the old hardcoded `v0.9.4` literal is gone from both the
 * source file and the served response.
 *
 *   1. GET /status → 200 text/html carrying the CURRENT package.json version
 *      (id="app-version" and id="openapi-version" both filled), and the
 *      response body never contains the literal "0.9.4".
 *   2. Structural: public/status.html itself carries no "0.9.4" literal, and
 *      server.js defines renderLiveStatusVersion (the substitution helper)
 *      exactly once and wires it into the /status route.
 *
 * Staged-server pattern: test/ad-routes.test.js.
 *
 * Runner: node --test test/status-version.test.js
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
const SERVER_SRC = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const STATUS_HTML = fs.readFileSync(path.join(REPO, 'public', 'status.html'), 'utf8');
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const STALE_LITERAL = '0.9.4';

// Dev comments (HTML <!-- --> and CSS /* */) are allowed to name the old
// literal or the old <h2> tag for historical/rationale context — they are
// not served content. Strip both comment forms before asserting on what a
// visitor or crawler actually receives.
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('STATUS-VERSION: GET /status carries the live package version, never the stale v0.9.4 literal', { timeout: 180_000 }, () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-status-version-'));
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
        SESSION_SECRET: 'status-version-test-session-secret-0123456789',
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

  it('GET /status → 200 text/html carrying the current package version in both spans, never the stale v0.9.4 literal', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/status`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^text\/html/);
    const body = await res.text();
    assert.ok(!stripComments(body).includes(STALE_LITERAL), 'served /status never carries the stale 0.9.4 literal outside a dev comment');
    const appVersionMatch = body.match(/id="app-version"[^>]*>([^<]*)</);
    assert.ok(appVersionMatch, 'footer app-version span present');
    assert.equal(appVersionMatch[1], PACKAGE_VERSION, 'footer badge carries the current package.json version');
    const openapiVersionMatch = body.match(/id="openapi-version"[^>]*>([^<]*)</);
    assert.ok(openapiVersionMatch, 'OpenAPI card version span present');
    assert.equal(openapiVersionMatch[1], PACKAGE_VERSION, 'OpenAPI card carries the current package.json version');
  });

  it('GET /status footer carries /terms and /privacy', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/status`);
    const body = await res.text();
    // AD sheet 9: the footer link set moved to packet 3 rev 2's sentence-case
    // labels ("Terms"/"Privacy", not "terms"/"privacy") as part of the
    // site-wide byte-identical footer.
    assert.match(body, /<footer>[\s\S]*<a href="\/terms">Terms<\/a>[\s\S]*<\/footer>/);
    assert.match(body, /<footer>[\s\S]*<a href="\/privacy">Privacy<\/a>[\s\S]*<\/footer>/);
  });

  it('GET /status has no <h2> heading left (the four component labels are not headings) and its h1 is not the old fixed 28px', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/status`);
    const body = stripComments(await res.text());
    assert.ok(!/<h2\b/.test(body), 'no <h2> elements remain on /status');
    assert.equal((body.match(/class="component-label"/g) || []).length, 4, 'four component labels present');
    assert.match(body, /\.page-title\s*\{[^}]*font-size:\s*clamp\(38px,\s*5vw,\s*56px\)/, 'h1 uses the page-hero spec size');
  });
});

describe('STATUS-VERSION: structural — public/status.html source and server.js wiring', () => {
  it('public/status.html carries no 0.9.4 literal outside a dev comment', () => {
    assert.ok(!stripComments(STATUS_HTML).includes(STALE_LITERAL), 'source file is free of the stale literal outside a comment');
  });

  it('server.js defines renderLiveStatusVersion exactly once and the /status route calls it', () => {
    const defs = SERVER_SRC.match(/^function renderLiveStatusVersion\(html\) \{/gm) || [];
    assert.equal(defs.length, 1, 'exactly one renderLiveStatusVersion definition');

    const statusStart = SERVER_SRC.indexOf("app.get('/status'");
    const statusEnd = SERVER_SRC.indexOf('app.get(', statusStart + 1);
    assert.ok(statusStart > 0 && statusEnd > statusStart, '/status handler located');
    const statusRoute = SERVER_SRC.slice(statusStart, statusEnd);
    assert.ok(statusRoute.includes('renderLiveStatusVersion(html)'), '/status route calls the substitution helper');
    assert.ok(statusRoute.includes("serveStatic(c, 'status.html')"), '/status still falls back to serveStatic on render failure');
  });
});
