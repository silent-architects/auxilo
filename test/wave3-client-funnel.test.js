'use strict';

/**
 * test/wave3-client-funnel.test.js — Wave 3 client subset
 * (BUILD-SPEC-WAVE3-CLIENT-2026-07-19)
 *
 * Covers:
 *   A1  — score-at-extraction, env-gated DARK (extract-local + runner channel)
 *   A2  — truthful digest (runner /learn classification + held= tokens + lanes)
 *   LW-18 — SessionStart held-count notice + macOS notification plumbing
 *   UC-1a — consent-ordering fix (removal functions, shim quoting, CLI order)
 *   UC-3  — Cline / Roo Code / Continue adapters + dynamic SOURCES registry
 *          + manifest closure (the d8c7099 bug class)
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const extractLocal = require('../scripts/extract-local.js');
const runner = require('../scripts/runner.js');
const installer = require('../lib/installer.js');
const digest = require('../jobs/daily-digest.js');
const notice = require('../scripts/review-notice.js');
const { ClineSource } = require('../scripts/sources/cline.js');
const { RooCodeSource } = require('../scripts/sources/roo-code.js');
const { ContinueSource } = require('../scripts/sources/continue.js');
const { TranscriptSource } = require('../scripts/sources/source.interface.js');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ─── A1: score-at-extraction, gated dark ────────────────────────────────────

describe('A1 — score-at-extraction gate (AUXILO_SCORE_EXTRACTION)', () => {
  const VALID_QA = { specificity: 4, actionability: 4, novelty: 3, completeness: 3, total: 14 };
  const learningWith = (qa) => JSON.stringify([{
    title: 'A learning title long enough',
    body: 'B'.repeat(60),
    category: 'code-execution',
    tags: ['x'],
    task_context: 'ctx',
    outcome: 'success',
    ...(qa !== undefined && { quality_self_assessment: qa }),
  }]);

  it('gate defaults OFF and the default prompt carries no rubric', () => {
    assert.strictEqual(extractLocal.scoreExtractionEnabled({}), false);
    assert.strictEqual(extractLocal.scoreExtractionEnabled({ AUXILO_SCORE_EXTRACTION: '0' }), false);
    assert.strictEqual(extractLocal.scoreExtractionEnabled({ AUXILO_SCORE_EXTRACTION: '1' }), true);
    const dark = extractLocal.buildExtractionPrompt({ scoreExtraction: false });
    assert.ok(!dark.includes('quality_self_assessment'));
    const armed = extractLocal.buildExtractionPrompt({ scoreExtraction: true });
    assert.ok(armed.includes('quality_self_assessment'));
    assert.ok(armed.includes('14/20'));
  });

  it('gate OFF strips a model-emitted assessment (dark client can never arm seamless)', () => {
    const parsed = extractLocal.parseLearnings(learningWith(VALID_QA), { scoreExtraction: false });
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].quality_self_assessment, undefined);
  });

  it('gate ON attaches a VALID assessment', () => {
    const parsed = extractLocal.parseLearnings(learningWith(VALID_QA), { scoreExtraction: true });
    assert.deepStrictEqual(parsed[0].quality_self_assessment, VALID_QA);
  });

  it('malformed assessments are OMITTED, never fabricated (awaiting_quality fallback)', () => {
    const bad = [
      { ...VALID_QA, total: 15 },                       // total ≠ sum
      { ...VALID_QA, specificity: 0 },                  // out of range low
      { ...VALID_QA, novelty: 6, total: 17 },           // out of range high
      { ...VALID_QA, actionability: 3.5, total: 13.5 }, // non-integer
      { specificity: 4, actionability: 4, novelty: 3, total: 11 }, // missing dim
      'not-an-object',
      null,
    ];
    for (const qa of bad) {
      const parsed = extractLocal.parseLearnings(learningWith(qa), { scoreExtraction: true });
      assert.strictEqual(parsed.length, 1, `learning survives qa=${JSON.stringify(qa)}`);
      assert.strictEqual(parsed[0].quality_self_assessment, undefined,
        `assessment omitted for qa=${JSON.stringify(qa)}`);
    }
  });

  it('validateQualityAssessment accepts exactly the floor shape', () => {
    assert.deepStrictEqual(extractLocal.validateQualityAssessment(VALID_QA), VALID_QA);
    assert.strictEqual(extractLocal.validateQualityAssessment({ ...VALID_QA, total: 13 }), null);
  });
});

// ─── A1+A2: runner submission channel + truthful classification ─────────────

describe('A1/A2 — submitLearnings (channel stamp + truthful /learn classification)', () => {
  const LEARNING = {
    title: 'A learning title long enough', body: 'B'.repeat(60),
    category: 'code-execution', tags: ['x'], task_context: 'ctx', outcome: 'success',
  };

  function fetchReturning(bodies) {
    const calls = [];
    let i = 0;
    const impl = async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      const spec = bodies[Math.min(i++, bodies.length - 1)];
      if (spec === 'network') throw new Error('ECONNREFUSED');
      return {
        ok: spec.ok !== false,
        json: async () => spec.json || {},
      };
    };
    return { impl, calls };
  }

  it('every submission carries submission_channel:"extraction" (the brake ships dark)', async () => {
    const { impl, calls } = fetchReturning([{ json: { status: 'pending_review' } }]);
    await runner.submitLearnings([LEARNING], 'claude-code',
      { fetchImpl: impl, baseUrl: 'http://x', apiKey: 'k' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].body.submission_channel, 'extraction');
    assert.strictEqual(calls[0].body.quality_self_assessment, undefined);
  });

  it('quality_self_assessment passes through spread-if-present', async () => {
    const qa = { specificity: 4, actionability: 4, novelty: 3, completeness: 3, total: 14 };
    const { impl, calls } = fetchReturning([{ json: { status: 'pending_review' } }]);
    await runner.submitLearnings([{ ...LEARNING, quality_self_assessment: qa }], 'claude-code',
      { fetchImpl: impl, baseUrl: 'http://x', apiKey: 'k' });
    assert.deepStrictEqual(calls[0].body.quality_self_assessment, qa);
  });

  it('classifies approved → published, pending_review → held, errors → rejected', async () => {
    const { impl } = fetchReturning([
      { json: { status: 'approved' } },
      { json: { status: 'pending_review' } },
      { ok: false, json: {} },
      'network',
    ]);
    const totals = await runner.submitLearnings(
      [LEARNING, LEARNING, LEARNING, LEARNING], 'claude-code',
      { fetchImpl: impl, baseUrl: 'http://x', apiKey: 'k' });
    assert.deepStrictEqual(totals, { published: 1, held: 1, rejected: 2 });
  });

  it('a 2xx without a parseable body counts as published (server contract: only pending_review holds)', async () => {
    const impl = async () => ({ ok: true, json: async () => { throw new Error('empty'); } });
    const totals = await runner.submitLearnings([LEARNING], 'claude-code',
      { fetchImpl: impl, baseUrl: 'http://x', apiKey: 'k' });
    assert.deepStrictEqual(totals, { published: 1, held: 0, rejected: 0 });
  });
});

describe('LW-18(b) — notifyHeld plumbing', () => {
  it('is exported, fail-silent on zero/negative counts and honors AUXILO_NO_NOTIFY', () => {
    const prev = process.env.AUXILO_NO_NOTIFY;
    process.env.AUXILO_NO_NOTIFY = '1';
    try {
      assert.strictEqual(typeof runner.notifyHeld, 'function');
      // Must never throw regardless of input.
      runner.notifyHeld(0);
      runner.notifyHeld(-1);
      runner.notifyHeld(null);
      runner.notifyHeld(3); // disabled by env — still must not throw
    } finally {
      if (prev === undefined) delete process.env.AUXILO_NO_NOTIFY;
      else process.env.AUXILO_NO_NOTIFY = prev;
    }
  });

  it('runner source contains count-only notification text (no titles/content)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'runner.js'), 'utf-8');
    assert.ok(src.includes('held for your review'));
    // The osascript line must interpolate only the count — never learning fields.
    const notifyBlock = src.slice(src.indexOf('function notifyHeld'), src.indexOf('async function postExtract') > 0 ? undefined : undefined);
    assert.ok(!/notifyHeld[\s\S]{0,600}\.title/.test(src.slice(src.indexOf('function notifyHeld'), src.indexOf('function notifyHeld') + 900)));
    assert.ok(notifyBlock !== null);
  });
});

// ─── A2: digest parser + lanes ──────────────────────────────────────────────

describe('A2 — truthful digest', () => {
  let dir;
  beforeEach(() => { dir = tmpdir('aux-digest-'); });
  afterEach(() => rmrf(dir));

  function writeLog(lines) {
    const p = path.join(dir, 'extract.log');
    fs.writeFileSync(p, lines.join('\n') + '\n');
    return p;
  }

  it('parses held= tokens alongside published=/rejected=', () => {
    const now = new Date().toISOString();
    const p = writeLog([
      `[${now}] [runner] ✓ published=1 held=2 rejected=1 account=acct_1 (extraction: client-x)`,
    ]);
    const rows = digest.readLogRows(p, 24);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].published, 1);
    assert.strictEqual(rows[0].held, 2);
    assert.strictEqual(rows[0].rejected, 1);
    assert.strictEqual(rows[0].builder, 'acct_1');
    const agg = digest.aggregatePerBuilder(rows).get('acct_1');
    assert.strictEqual(agg.heldCount, 2);
  });

  it('token lines without held= still parse (pre-0.9.3 logs)', () => {
    const now = new Date().toISOString();
    const p = writeLog([
      `[${now}] [runner] ✓ published=3 rejected=0 account=acct_1 (extraction: client-y)`,
    ]);
    const rows = digest.readLogRows(p, 24);
    assert.strictEqual(rows[0].published, 3);
    assert.strictEqual(rows[0].held, 0);
  });

  it('the inner postExtract line carries no tokens (double-count killed)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'runner.js'), 'utf-8');
    const inner = src.match(/client-side extraction[^`]*/);
    assert.ok(inner, 'inner log line exists');
    assert.ok(!inner[0].includes('published='), 'inner line must not carry published= tokens');
  });

  it('laneOf: three lanes per SPEC3 §2.2, server lane field preferred', () => {
    assert.strictEqual(digest.laneOf({ screens_passed: true, quality: 14 }), 'ready');
    assert.strictEqual(digest.laneOf({ screens_passed: true, quality: 20 }), 'ready');
    assert.strictEqual(digest.laneOf({ screens_passed: true, quality: null }), 'needs_score');
    assert.strictEqual(digest.laneOf({ screens_passed: true, quality: 13 }), 'needs_score');
    assert.strictEqual(digest.laneOf({ screens_passed: false, quality: 20, flags: ['injection'] }), 'needs_eyes');
    // B1 forward-compat: an explicit server lane wins.
    assert.strictEqual(digest.laneOf({ lane: 'needs_eyes', screens_passed: true, quality: 20 }), 'needs_eyes');
  });

  it('digest renders lane names and NEVER the word "clean" (SPEC3 naming rule)', () => {
    const summary = {
      pending_count: 3,
      items: [
        { id: 'a', screens_passed: true, quality: 18, created_at: new Date(Date.now() - 3 * 86400000).toISOString() },
        { id: 'b', screens_passed: true, quality: null, created_at: new Date().toISOString() },
        { id: 'c', screens_passed: false, quality: 18, flags: ['content_sensitivity'], created_at: new Date().toISOString() },
      ],
    };
    const text = digest.formatDigest(new Map(), 24, summary);
    assert.ok(text.includes('Ready to publish:  1'));
    assert.ok(text.includes('Needs a score:     1'));
    assert.ok(text.includes('Needs your eyes:   1'));
    assert.ok(text.includes('Oldest waiting:    3 day(s)'));
    assert.ok(text.includes('https://auxilo.io/dashboard'));
    assert.ok(!/\bclean\b/i.test(text), 'the word "clean" must never render');
  });

  it('no summary → log-only digest (fail-silent degradation)', () => {
    const text = digest.formatDigest(new Map(), 24, null);
    assert.ok(text.includes('No extraction activity'));
    assert.ok(!text.includes('Review queue'));
  });

  it('fetchPendingSummary returns null on unreachable server (never throws)', async () => {
    const result = await digest.fetchPendingSummary(
      { api_key: 'k', base_url: 'http://127.0.0.1:1' });
    assert.strictEqual(result, null);
  });
});

// ─── LW-18(a): SessionStart review notice ───────────────────────────────────

describe('LW-18(a) — SessionStart held-count notice', () => {
  let home;
  beforeEach(() => { home = tmpdir('aux-notice-'); });
  afterEach(() => rmrf(home));

  it('shouldNotify: 4h suppression window', () => {
    const now = Date.now();
    assert.strictEqual(notice.shouldNotify({}, now), true);
    assert.strictEqual(notice.shouldNotify({ last_notice_at: 'garbage' }, now), true);
    assert.strictEqual(
      notice.shouldNotify({ last_notice_at: new Date(now - 1000).toISOString() }, now), false);
    assert.strictEqual(
      notice.shouldNotify({ last_notice_at: new Date(now - notice.NOTICE_SUPPRESSION_MS - 1).toISOString() }, now), true);
  });

  it('renderNotice is count-only with both command names', () => {
    const line = notice.renderNotice(7);
    assert.ok(line.includes('7 learning(s) held for your review'));
    assert.ok(line.includes('auxilo_review'));
    assert.ok(line.includes('npx auxilo review'));
  });

  it('script spawned with no credentials exits 0 with NO output (fail-silent)', () => {
    const { spawnSync } = require('child_process');
    const res = spawnSync(process.execPath,
      [path.join(__dirname, '..', 'scripts', 'review-notice.js')],
      { env: { ...process.env, HOME: home }, encoding: 'utf-8', timeout: 10000 });
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stdout, '');
  });

  it('script under AUXILO_EXTRACTING=1 exits 0 silently (recursion guard)', () => {
    const { spawnSync } = require('child_process');
    // Even with credentials present, the extraction child must stay silent.
    fs.mkdirSync(path.join(home, '.auxilo'), { recursive: true });
    fs.writeFileSync(path.join(home, '.auxilo', 'credentials.json'),
      JSON.stringify({ api_key: 'k', base_url: 'http://127.0.0.1:1' }));
    const res = spawnSync(process.execPath,
      [path.join(__dirname, '..', 'scripts', 'review-notice.js')],
      { env: { ...process.env, HOME: home, AUXILO_EXTRACTING: '1' }, encoding: 'utf-8', timeout: 10000 });
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stdout, '');
  });

  it('registerClaudeCodeSessionStartNotice writes a STRUCTURED entry + shim, idempotently', () => {
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/other/tool.sh' }] }] },
    }));

    const first = installer.registerClaudeCodeSessionStartNotice(home);
    assert.strictEqual(first.changed, true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(settings.hooks.SessionStart.length, 2, 'foreign hook preserved');
    const ours = settings.hooks.SessionStart[1];
    assert.deepStrictEqual(ours, { hooks: [{ type: 'command', command: first.hookCmd }] },
      'structured form — bare strings are silently ignored by Claude Code (LW-17)');
    assert.ok(fs.existsSync(first.hookCmd), 'shim written');
    assert.ok((fs.statSync(first.hookCmd).mode & 0o111) !== 0, 'shim executable');
    const shim = fs.readFileSync(first.hookCmd, 'utf-8');
    assert.ok(shim.includes('review-notice.js'));
    assert.ok(shim.trimEnd().endsWith('exit 0'), 'shim fail-silent');

    const second = installer.registerClaudeCodeSessionStartNotice(home);
    assert.strictEqual(second.changed, false, 'idempotent re-run');
    assert.strictEqual(installer.sessionStartNoticeRegistered(home), true);
  });

  it('stale notice entries are replaced, not duplicated', () => {
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { SessionStart: [
        '/old/auxilo-review-notice.sh', // dead bare-string form
        { hooks: [{ type: 'command', command: '/stale/auxilo-review-notice.sh' }] },
      ] },
    }));
    installer.registerClaudeCodeSessionStartNotice(home);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const flat = JSON.stringify(settings.hooks.SessionStart);
    assert.strictEqual(settings.hooks.SessionStart.length, 1);
    assert.ok(!flat.includes('/old/'));
    assert.ok(!flat.includes('/stale/'));
  });
});

// ─── UC-1a: consent ordering + cleanup ──────────────────────────────────────

describe('UC-1a — consent-ordering fix', () => {
  let home;
  beforeEach(() => { home = tmpdir('aux-uc1a-'); });
  afterEach(() => rmrf(home));

  it('cmdSetup source: consent prompt precedes every capture-hook call site', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'auxilo-cli.js'), 'utf-8');
    const consentAt = src.indexOf('Enable background extraction?');
    assert.ok(consentAt > 0);
    for (const call of ['installer.registerClaudeCodeHook(', 'installer.installCaptureHooks(']) {
      const at = src.indexOf(call);
      assert.ok(at > consentAt,
        `${call} must appear AFTER the consent prompt (found at ${at}, consent at ${consentAt})`);
    }
  });

  it('removeClaudeCodeHook strips legacy string + structured entries, preserves others', () => {
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      other: true,
      hooks: {
        SessionEnd: [
          '/legacy/auxilo-extract.sh',
          { hooks: [
            { type: 'command', command: path.join(home, '.auxilo', 'bin', 'auxilo-extract.sh') },
            { type: 'command', command: '/keep/me.sh' },
          ] },
          { hooks: [{ type: 'command', command: '/unrelated.sh' }] },
        ],
        SessionStart: ['keep'],
      },
    }));

    const res = installer.removeClaudeCodeHook(home);
    assert.strictEqual(res.changed, true);
    assert.strictEqual(res.removed.length, 2);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const flat = JSON.stringify(settings);
    assert.ok(!flat.includes('auxilo-extract'), 'no auxilo capture artifact remains');
    assert.ok(flat.includes('/keep/me.sh'), 'non-Auxilo command sharing the group preserved');
    assert.ok(flat.includes('/unrelated.sh'));
    assert.strictEqual(settings.other, true);

    const again = installer.removeClaudeCodeHook(home);
    assert.strictEqual(again.changed, false, 'idempotent');
  });

  it('removeCaptureHooks strips configs + deletes shims across dialects, preserves foreign entries', () => {
    const clients = installer.clientRegistry(home, { platform: 'darwin', env: {} });
    const byId = Object.fromEntries(clients.map((c) => [c.id, c]));

    // cursor (flat array) with a foreign entry
    const cursor = byId.cursor;
    fs.mkdirSync(path.dirname(cursor.captureConfigPath), { recursive: true });
    const cursorShim = installer.captureShimPath(home, 'cursor');
    fs.writeFileSync(cursor.captureConfigPath, JSON.stringify({
      version: 1,
      hooks: { sessionEnd: [{ command: cursorShim }, { command: '/foreign/hook.sh' }] },
    }));
    fs.mkdirSync(path.dirname(cursorShim), { recursive: true });
    fs.writeFileSync(cursorShim, '#!/bin/bash\n');

    // gemini-cli (matcher groups inside settings.json with unrelated keys)
    const gemini = byId['gemini-cli'];
    fs.mkdirSync(path.dirname(gemini.captureConfigPath), { recursive: true });
    const geminiShim = installer.captureShimPath(home, 'gemini-cli');
    fs.writeFileSync(gemini.captureConfigPath, JSON.stringify({
      mcpServers: { auxilo: { command: 'npx' } },
      hooks: { SessionEnd: [{ hooks: [{ name: 'auxilo-capture', type: 'command', command: geminiShim }] }] },
    }));

    // copilot-cli (drop-in file we own)
    const copilot = byId['copilot-cli'];
    fs.mkdirSync(path.dirname(copilot.captureConfigPath), { recursive: true });
    fs.writeFileSync(copilot.captureConfigPath, JSON.stringify({
      hooks: { Stop: [{ type: 'command', command: installer.captureShimPath(home, 'copilot') }] },
    }));

    // antigravity (top-level group key we own)
    const anti = byId.antigravity;
    fs.mkdirSync(path.dirname(anti.captureConfigPath), { recursive: true });
    fs.writeFileSync(anti.captureConfigPath, JSON.stringify({
      'auxilo-capture': { Stop: [{ hooks: [{ type: 'command', command: installer.captureShimPath(home, 'antigravity') }] }] },
      'user-group': { Stop: [] },
    }));

    const results = installer.removeCaptureHooks(home, [cursor, gemini, copilot, anti]);
    assert.strictEqual(results.filter((r) => r.error).length, 0, JSON.stringify(results));
    assert.strictEqual(results.filter((r) => r.changed).length, 4);

    const cursorCfg = JSON.parse(fs.readFileSync(cursor.captureConfigPath, 'utf-8'));
    assert.deepStrictEqual(cursorCfg.hooks.sessionEnd, [{ command: '/foreign/hook.sh' }]);
    assert.ok(!fs.existsSync(cursorShim), 'cursor shim deleted');

    const geminiCfg = JSON.parse(fs.readFileSync(gemini.captureConfigPath, 'utf-8'));
    assert.ok(!JSON.stringify(geminiCfg).includes('auxilo-capture'));
    assert.deepStrictEqual(geminiCfg.mcpServers, { auxilo: { command: 'npx' } },
      'MCP registration untouched (only capture hooks are consent-gated)');

    assert.ok(!fs.existsSync(copilot.captureConfigPath), 'copilot drop-in deleted');

    const antiCfg = JSON.parse(fs.readFileSync(anti.captureConfigPath, 'utf-8'));
    assert.strictEqual(antiCfg['auxilo-capture'], undefined);
    assert.ok(antiCfg['user-group'], 'foreign top-level group preserved');

    // Idempotent second pass.
    const again = installer.removeCaptureHooks(home, [cursor, gemini, copilot, anti]);
    assert.strictEqual(again.filter((r) => r.changed).length, 0);
  });

  it('renderCaptureShim single-quotes paths (hostile homeDir cannot break or expand)', () => {
    const hostile = "/tmp/o'brien \"$(rm -rf x)\" home";
    const shim = installer.renderCaptureShim(hostile, 'cursor');
    assert.ok(shim.includes("'/tmp/o'\\''brien \"$(rm -rf x)\" home/.auxilo/bin/scripts/capture-core.js'"));
    assert.ok(!shim.includes(`node "${hostile}`), 'no double-quoted interpolation');
  });
});

// ─── UC-3: adapters + dynamic registry + manifest closure ───────────────────

describe('UC-3 — Cline / Roo Code / Continue adapters', () => {
  let home;
  beforeEach(() => { home = tmpdir('aux-uc3-'); });
  afterEach(() => rmrf(home));

  const CLINE_HISTORY = [
    { role: 'user', content: 'How do I fix the flaky test?' },
    { role: 'assistant', content: [{ type: 'text', text: 'Pin the clock in beforeEach.' }, { type: 'tool_use', id: 'x' }] },
  ];

  function seedClineTask(root, taskId, history) {
    const dir = path.join(root, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'api_conversation_history.json'), JSON.stringify(history));
    fs.writeFileSync(path.join(dir, 'ui_messages.json'), '[]');
  }

  it('detect() is false + discover empty on a machine without the client (fail-silent)', async () => {
    for (const S of [ClineSource, RooCodeSource]) {
      const s = new S({ homeDir: home, platform: 'darwin', env: {} });
      assert.strictEqual(await s.detect(), false);
      assert.deepStrictEqual(await s.discoverSessions({}), []);
    }
    const c = new ContinueSource({ homeDir: home });
    assert.strictEqual(await c.detect(), false);
    assert.deepStrictEqual(await c.discoverSessions({}), []);
  });

  it('ClineSource discovers + normalizes an Anthropic-format task history', async () => {
    const root = path.join(home, 'Library', 'Application Support', 'Code', 'User',
      'globalStorage', 'saoudrizwan.claude-dev', 'tasks');
    seedClineTask(root, '1721400000000', CLINE_HISTORY);

    const s = new ClineSource({ homeDir: home, platform: 'darwin', env: {} });
    assert.strictEqual(await s.detect(), true);
    const sessions = await s.discoverSessions({});
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].sessionId, 'cline-1721400000000');

    const read = await s.readSession(sessions[0]);
    assert.ok(read.transcript.includes('[user]: How do I fix the flaky test?'));
    assert.ok(read.transcript.includes('[assistant]: Pin the clock in beforeEach.'));
    assert.ok(!read.transcript.includes('tool_use'));
  });

  it('RooCodeSource probes both publisher ids', async () => {
    const root = path.join(home, 'Library', 'Application Support', 'Code', 'User',
      'globalStorage', 'rooveterinaryinc.roo-code', 'tasks');
    seedClineTask(root, '42', CLINE_HISTORY);
    const s = new RooCodeSource({ homeDir: home, platform: 'darwin', env: {} });
    assert.strictEqual(await s.detect(), true);
    const sessions = await s.discoverSessions({});
    assert.strictEqual(sessions[0].sessionId, 'roo-code-42');
  });

  it('ClineSource refuses non-matching shapes with null (probe, never mis-parse)', async () => {
    const root = path.join(home, 'Library', 'Application Support', 'Code', 'User',
      'globalStorage', 'saoudrizwan.claude-dev', 'tasks');
    seedClineTask(root, 'bad1', { not: 'an array' });
    const dir2 = path.join(root, 'bad2');
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, 'api_conversation_history.json'), 'not json at all');

    const s = new ClineSource({ homeDir: home, platform: 'darwin', env: {} });
    for (const ref of await s.discoverSessions({})) {
      assert.strictEqual(await s.readSession(ref), null, `${ref.sessionId} must refuse`);
    }
  });

  it('ContinueSource reads both history item shapes and skips the index file', async () => {
    const sessionsDir = path.join(home, '.continue', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'sessions.json'), JSON.stringify([{ sessionId: 'abc' }]));
    fs.writeFileSync(path.join(sessionsDir, 'abc.json'), JSON.stringify({
      title: 'T',
      history: [
        { message: { role: 'user', content: 'New shape question' } },
        { role: 'assistant', content: 'Old shape answer text here' },
        { message: { role: 'tool', content: 'skip me' } },
      ],
    }));
    fs.writeFileSync(path.join(sessionsDir, 'garbage.json'), JSON.stringify({ nope: true }));

    const s = new ContinueSource({ homeDir: home });
    assert.strictEqual(await s.detect(), true);
    const sessions = await s.discoverSessions({});
    assert.strictEqual(sessions.length, 2, 'index excluded');

    const good = sessions.find((r) => r.sessionId === 'abc');
    const read = await s.readSession(good);
    assert.ok(read.transcript.includes('[user]: New shape question'));
    assert.ok(read.transcript.includes('[assistant]: Old shape answer text here'));
    assert.ok(!read.transcript.includes('skip me'));

    const bad = sessions.find((r) => r.sessionId === 'garbage');
    assert.strictEqual(await s.readSession(bad), null);
  });
});

describe('UC-3 — dynamic SOURCES registry', () => {
  it('registers all seven adapters, excludes generic/interface, unique ids', () => {
    const ids = runner.SOURCES.map((S) => S.id).sort();
    assert.deepStrictEqual(ids,
      ['antigravity', 'claude-code', 'cline', 'continue', 'gemini-cli', 'openclaw', 'roo-code']);
    assert.strictEqual(new Set(ids).size, ids.length);
    for (const S of runner.SOURCES) {
      assert.ok(S.prototype instanceof TranscriptSource, `${S.id} extends TranscriptSource`);
    }
  });

  it('loadSources is resilient: result matches the sources dir minus exclusions', () => {
    const dir = path.join(__dirname, '..', 'scripts', 'sources');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    const excluded = ['source.interface.js', 'generic-jsonl.js'];
    assert.strictEqual(runner.loadSources().length, files.length - excluded.length);
  });
});

describe('UC-3 — manifest closure (the d8c7099 bug class)', () => {
  const repoRoot = path.join(__dirname, '..');
  const sourceFiles = fs.readdirSync(path.join(repoRoot, 'scripts', 'sources'))
    .filter((f) => f.endsWith('.js'));

  it('every scripts/sources/*.js has a RUNNER_STACK row (installer copies it)', () => {
    const stackSrcs = new Set(installer.RUNNER_STACK.map(([src]) => src));
    for (const f of sourceFiles) {
      assert.ok(stackSrcs.has(`scripts/sources/${f}`),
        `scripts/sources/${f} missing from RUNNER_STACK — installed runners would MODULE_NOT_FOUND`);
    }
  });

  it('every scripts/sources/*.js has a sweeper manifest row (installSweeper copies it)', () => {
    const sweeperSrcs = new Set(runner.sweeperManifest(repoRoot).map(([src]) => src));
    for (const f of sourceFiles) {
      assert.ok(sweeperSrcs.has(`scripts/sources/${f}`),
        `scripts/sources/${f} missing from the sweeper manifest`);
    }
  });

  it('every static require("./sources/…") in runner.js has a manifest row', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'scripts', 'runner.js'), 'utf-8');
    const stackSrcs = new Set(installer.RUNNER_STACK.map(([s]) => s));
    const sweeperSrcs = new Set(runner.sweeperManifest(repoRoot).map(([s]) => s));
    // Quote chars only — backtick template requires are the DYNAMIC registry
    // loader (covered by the enumerate-the-dir tests above).
    for (const m of src.matchAll(/require\(['"]\.\/sources\/([^'")]+)['"]\)/g)) {
      const rel = `scripts/sources/${m[1].endsWith('.js') ? m[1] : m[1] + '.js'}`;
      assert.ok(stackSrcs.has(rel), `${rel} required by runner.js but missing from RUNNER_STACK`);
      assert.ok(sweeperSrcs.has(rel), `${rel} required by runner.js but missing from sweeper manifest`);
    }
  });

  it('review-notice.js ships: RUNNER_STACK row + package.json files[]', () => {
    const stackSrcs = new Set(installer.RUNNER_STACK.map(([src]) => src));
    assert.ok(stackSrcs.has('scripts/review-notice.js'));
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
    assert.ok(pkg.files.includes('scripts/review-notice.js'),
      'notice script must ship in the npm tarball');
  });
});
