'use strict';
/*
 * test/extraction-zero-tool-calls.test.js — TRUST-PAGE control row
 * (SITE-PM: "put the zero-tool-call assertion in the test suite").
 *
 * The trust page tells a builder that extraction runs with zero tool calls —
 * the model only ever sees the transcript on stdin and answers on stdout, it
 * never gets Bash/Read/Edit/MCP access. This file is the test-suite proof
 * behind that claim, in two layers:
 *
 *  (i) STATIC — always runs, no external dependency. Byte-pins the exact
 *      argv scripts/providers/claude-code.js hands to spawnSync for both the
 *      extraction ("finder") and dedup-judge child processes, via the named
 *      EXTRACT_MODE_ARGV / JUDGE_MODE_ARGV constants that module now exports
 *      (added in this same commit — the module's two spawnSyncImpl() call
 *      sites were literal inline arrays before; they now reference these
 *      constants instead, with the identical contents, so there is no
 *      behavior change, only a named, exported, frozen single source of
 *      truth this test can byte-pin against). A future flag change to
 *      either spawn is now a conscious edit of THIS test, not a silent
 *      literal tweak buried three files away.
 *
 *  (ii) LIVE — gated, OFF by default, skipped in CI and in ordinary
 *      `npm test` runs. Spawns the REAL `claude` CLI with the shipped finder
 *      argv plus --output-format stream-json --verbose on a tiny fixed
 *      prompt and asserts, from the actual stream the binary produced, that
 *      the child process never saw a tool: an empty tools array on the
 *      system/init event, and zero tool_use / tool_result content blocks
 *      anywhere in the transcript. This is the only layer that proves the
 *      claim against the real, currently-installed CLI rather than against
 *      this repo's own argv literal — a CLI version that silently started
 *      honoring --tools '' differently, or dropped it, would only be caught
 *      here. Runs ONLY when ALL of the following hold, checked in this
 *      order so that when it does NOT run (the default), zero subprocesses
 *      of `claude` are spawned at all:
 *        1. env AUXILO_LIVE_CLI_TESTS=1
 *        2. a `claude` binary actually resolves, via the module's own
 *           resolveClaudeBin()
 *        3. the module's own auth detection (detect(), which folds in
 *           checkAuthStatus() — 'claude auth status') reports the binary
 *           usable
 *      Otherwise the test calls t.skip() with a reason string naming which
 *      gate failed.
 *
 *      Design note on the auth gate: this repo's `checkAuthStatus()` invokes
 *      `claude auth status` without -p. On the CLI build this was written
 *      against, `auth status` is not a real subcommand (`claude --help`'s
 *      Commands: list is doctor/install/mcp/plugin/setup-token/update — no
 *      `auth`) — the child falls through into a single-shot prompt-answering
 *      reply instead of a structured status line, so checkAuthStatus()'s
 *      JSON.parse always fails and it reports 'unknown', never a clean
 *      'logged-in'. That is exactly why detect() (not checkAuthStatus()
 *      directly) is used as the gate here, per the task's documented "(or
 *      the module's own detect())" alternative — detect() treats 'unknown'
 *      as usable (it can prove logged-out, it cannot prove logged-in), which
 *      matches how the rest of this codebase already gates on it (see
 *      claude-code.js's own detect()/runModel()). A stricter literal "auth
 *      status must say logged-in" gate would never open on this CLI build.
 *
 *      HOME is never overridden here: --no-session-persistence (already in
 *      the finder argv) is what keeps this spawn from writing a session
 *      file under the operator's real ~/.claude, and a temp `cwd` (not HOME)
 *      is what keeps this spawn from writing anything into the repo
 *      worktree — deliberately NOT touching HOME, since this operator's
 *      Claude Code auth on this platform is keychain-backed, not a HOME-
 *      relative credential file, and remapping HOME would risk breaking the
 *      very auth this test is trying to exercise for no isolation benefit.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claudeCode = require('../scripts/providers/claude-code.js');

// ─── (i) STATIC — byte-pinned spawn argv ────────────────────────────────────

describe('extraction-zero-tool-calls — STATIC: byte-pinned spawn argv (scripts/providers/claude-code.js)', () => {
  it("finder (extract mode) argv is exactly ['-p','--no-session-persistence','--tools','','--setting-sources','']", () => {
    assert.deepEqual(
      claudeCode.EXTRACT_MODE_ARGV,
      ['-p', '--no-session-persistence', '--tools', '', '--setting-sources', ''],
    );
  });

  it("judge (dedup) argv is exactly ['-p','--output-format','json','--no-session-persistence','--tools','','--setting-sources','']", () => {
    assert.deepEqual(
      claudeCode.JUDGE_MODE_ARGV,
      ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--setting-sources', ''],
    );
  });

  it("both argvs contain the literal pair --tools '' (the flag that disables all tools) — checked by value, not just by array length", () => {
    const finder = claudeCode.EXTRACT_MODE_ARGV;
    const judge = claudeCode.JUDGE_MODE_ARGV;
    const toolsIdx = (a) => a.indexOf('--tools');
    assert.equal(finder[toolsIdx(finder)], '--tools');
    assert.equal(finder[toolsIdx(finder) + 1], '');
    assert.equal(judge[toolsIdx(judge)], '--tools');
    assert.equal(judge[toolsIdx(judge) + 1], '');
  });

  it("both argvs end in the literal pair --setting-sources '' (0.9.15 EXTRACTION-CHILD-HOOKS isolation — the child loads no user/project/local settings)", () => {
    const finder = claudeCode.EXTRACT_MODE_ARGV;
    const judge = claudeCode.JUDGE_MODE_ARGV;
    assert.equal(finder[finder.length - 2], '--setting-sources');
    assert.equal(finder[finder.length - 1], '');
    assert.equal(judge[judge.length - 2], '--setting-sources');
    assert.equal(judge[judge.length - 1], '');
  });

  it('both argv constants are frozen (Object.freeze) — a mutation attempt is a no-op, not a silent drift vector', () => {
    assert.ok(Object.isFrozen(claudeCode.EXTRACT_MODE_ARGV), 'EXTRACT_MODE_ARGV should be frozen');
    assert.ok(Object.isFrozen(claudeCode.JUDGE_MODE_ARGV), 'JUDGE_MODE_ARGV should be frozen');
  });
});

// ─── (ii) LIVE — gated real-CLI trace ───────────────────────────────────────

/**
 * Decide whether the live trace test may run. Order matters: the cheapest,
 * least-consequential check runs first, so the common case (env var unset —
 * every CI run, every ordinary `npm test`) returns a skip reason WITHOUT
 * ever calling resolveClaudeBin() or touching the `claude` binary at all.
 */
function liveGateSkipReason() {
  if (process.env.AUXILO_LIVE_CLI_TESTS !== '1') {
    return 'AUXILO_LIVE_CLI_TESTS!==1 — live CLI trace test is opt-in only (set AUXILO_LIVE_CLI_TESTS=1 to run it against a real installed + authenticated claude binary)';
  }

  const bin = claudeCode.resolveClaudeBin();
  const binResolvesToRealFile = bin !== 'claude' && fs.existsSync(bin);
  const binResolvesOnPath = bin === 'claude'
    && (() => {
      try {
        const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
        return Boolean(which && which.status === 0 && which.stdout && which.stdout.trim());
      } catch {
        return false;
      }
    })();
  if (!binResolvesToRealFile && !binResolvesOnPath) {
    return `no claude binary resolved (resolveClaudeBin() returned "${bin}", not found on disk or on PATH) — skipping live CLI trace test`;
  }

  // detect() (not checkAuthStatus() directly) per the design note above —
  // 'unknown' auth status reads as usable, matching the rest of this module.
  let usable = false;
  try {
    usable = claudeCode.detect({ claudeBin: bin });
  } catch {
    usable = false;
  }
  if (!usable) {
    return `claude binary at "${bin}" resolved but the module's own detect() reports it unusable (foreign-billing helper configured, or auth status reads logged-out) — skipping live CLI trace test`;
  }

  return null;
}

function parseStreamJsonEvents(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event !== null);
}

function countToolContentBlocks(events) {
  let toolUse = 0;
  let toolResult = 0;
  for (const event of events) {
    const content = event && event.message && Array.isArray(event.message.content)
      ? event.message.content
      : [];
    for (const block of content) {
      if (block && block.type === 'tool_use') toolUse += 1;
      if (block && block.type === 'tool_result') toolResult += 1;
    }
  }
  return { toolUse, toolResult };
}

describe('extraction-zero-tool-calls — LIVE: real claude CLI trace (gated, opt-in)', () => {
  it(
    'the finder argv, run for real with --output-format stream-json --verbose, produces tools:[] on init and zero tool_use/tool_result blocks',
    { timeout: 65000 },
    (t) => {
      const skipReason = liveGateSkipReason();
      if (skipReason) {
        t.skip(skipReason);
        return;
      }

      const bin = claudeCode.resolveClaudeBin();
      const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-zero-tool-calls-'));
      const argv = [...claudeCode.EXTRACT_MODE_ARGV, '--output-format', 'stream-json', '--verbose'];
      const prompt = 'Reply with the single word OK.';

      let res;
      try {
        res = spawnSync(bin, argv, {
          input: prompt,
          cwd: tmpCwd,
          env: claudeCode.claudeChildEnv(),
          encoding: 'utf8',
          timeout: 60000,
          maxBuffer: 20 * 1024 * 1024,
        });
      } finally {
        fs.rmSync(tmpCwd, { recursive: true, force: true });
      }

      assert.ok(res, 'expected a spawnSync result');
      assert.ok(!res.error, `spawn failed: ${res.error && res.error.message}`);
      assert.equal(res.status, 0, `claude exited ${res.status} — stderr: ${String(res.stderr || '').slice(0, 500)}`);

      const events = parseStreamJsonEvents(res.stdout);
      assert.ok(events.length > 0, 'expected at least one parsed stream-json event on stdout');

      const initEvent = events.find((e) => e.type === 'system' && e.subtype === 'init');
      assert.ok(initEvent, 'expected a type:"system", subtype:"init" event in the stream');
      assert.deepEqual(
        initEvent.tools,
        [],
        `expected tools:[] on the system/init event, got ${JSON.stringify(initEvent.tools)}`,
      );

      const { toolUse, toolResult } = countToolContentBlocks(events);
      assert.equal(toolUse, 0, `expected zero tool_use content blocks across the stream, found ${toolUse}`);
      assert.equal(toolResult, 0, `expected zero tool_result content blocks across the stream, found ${toolResult}`);

      const resultEvent = events.find((e) => e.type === 'result');
      if (resultEvent && typeof resultEvent.num_turns === 'number') {
        assert.ok(resultEvent.num_turns <= 2, `expected num_turns <= 2, got ${resultEvent.num_turns}`);
      }

      // Record-not-assert per the task: log, don't gate on, these two.
      const mcpServersLen = Array.isArray(initEvent.mcp_servers) ? initEvent.mcp_servers.length : null;
      const claudeCodeVersion = initEvent.claude_code_version
        || initEvent.version
        || (resultEvent && (resultEvent.claude_code_version || resultEvent.version))
        || '(not present on any parsed event)';
      // eslint-disable-next-line no-console
      console.log(
        `[extraction-zero-tool-calls LIVE] mcp_servers length=${mcpServersLen}, claude_code_version=${claudeCodeVersion}, num_turns=${resultEvent ? resultEvent.num_turns : '(no result event)'}`,
      );
    },
  );
});
