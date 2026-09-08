'use strict';
/*
 * test/extraction-model-provenance.test.js — EXTRACTION-MODEL-PROVENANCE
 * (PUNCH-LIST P1).
 *
 * Covers the fix for the defect confirmed in
 * ~/.auxilo/handoffs/EXTRACTION-MODEL-PROVENANCE-2026-09-08.md:
 * resolveExtractionModelIdentity() (scripts/extract-local.js) used to
 * RE-DETECT a provider via a fresh, independent providers.resolveProvider()
 * call whenever a runModel() result carried no `identity` — decoupled from
 * which provider's runModel() actually produced that result, and capable of
 * silently rewriting ~/.auxilo/providers.json as a side effect of what
 * should have been a read-only lookup. The danger this closes: a provider
 * `ok:true` return that forgot to attach `identity` used to fall through to
 * that re-detect and silently become `provider:'claude-code'` (the CLI's
 * detect() only checks the billing-helper gate + auth, not whether the
 * earlier attempt actually spawned) — which would let an uncalibrated
 * provider's output through lib/clean-lane.js's auto-publish gate
 * (CLEAN_LANE_CALIBRATED_PROVIDERS = ['claude-code']) mislabeled as the one
 * calibrated provider.
 *
 * The fix, per the investigation's recommended shape:
 *   1. scripts/providers/index.js's runModel() now enforces `identity`
 *      CENTRALLY on every result it returns (success or failure) — it alone
 *      knows which module it actually invoked for a given attempt. No
 *      re-detect anywhere.
 *   2. The re-detect's side-effect write to providers.json is gone (removed
 *      entirely, not merely relocated) — see "no write" below.
 *   3. lib/clean-lane.js holds (never auto-publishes, never refuses) on an
 *      unknown OR missing stamp, under one distinct reason code.
 *   4. server.js normalizes a malformed-but-present stamp to an explicit
 *      'unknown' provider, distinct from a genuinely absent one, so it also
 *      reaches the hold path deterministically.
 *
 * Deliberately does NOT force AUXILO_EXTRACTION_PROVIDER in the
 * providers/index.js fixtures below — an env override short-circuits
 * resolveProvider() before any detect()/fall-through logic runs at all
 * (scripts/providers/index.js:~272-285), which is exactly why the original
 * defect went untested: test/extraction-model-stamp.test.js and
 * test/extract-w1-fix2.test.js's identity coverage all force the provider,
 * bypassing fall-through entirely.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const providers = require('../scripts/providers/index.js');
const claudeCode = require('../scripts/providers/claude-code.js');
const codexCli = require('../scripts/providers/codex-cli.js');
const byoKey = require('../scripts/providers/byo-key.js');
const extractLocal = require('../scripts/extract-local.js');
const cleanLane = require('../lib/clean-lane.js');

const REPO_ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');

const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function cleanupTempDirs() {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Monkeypatch one or more functions on a provider module (the SAME cached
 * module object providers/index.js's PROVIDERS map holds, since Node caches
 * `require()` by resolved path) for the duration of `fn`, then restore the
 * originals unconditionally. This exercises providers/index.js's OWN
 * fall-through/identity logic directly, without needing a real claude/codex
 * binary or real auth state on the machine running the test.
 */
async function withPatched(moduleObj, patches, fn) {
  const originals = {};
  for (const key of Object.keys(patches)) originals[key] = moduleObj[key];
  Object.assign(moduleObj, patches);
  try {
    return await fn();
  } finally {
    Object.assign(moduleObj, originals);
  }
}

function authJson(loggedIn) {
  return { status: 0, stdout: JSON.stringify({ loggedIn }), stderr: '' };
}
function extractionStdout(learnings) {
  return { status: 0, stdout: JSON.stringify({ learnings }), stderr: '' };
}
function spawnQueue(responses) {
  const calls = [];
  const spawnSyncImpl = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    assert.ok(responses.length, `unexpected spawn: ${bin} ${args.join(' ')}`);
    return responses.shift();
  };
  return { calls, spawnSyncImpl };
}

// ─── (1) fall-through to codex-cli success stamps codex-cli, never claude-code ──

describe('providers/index.js runModel(): fall-through SUCCESS names the provider that actually ran', () => {
  it('claude-code fails non-retryable, codex-cli runs and self-stamps its own identity — the result names codex-cli, never claude-code', async () => {
    const statePath = path.join(tempDir('auxilo-provenance-a-'), 'providers.json');
    await withPatched(claudeCode, {
      detect: async () => true,
      runModel: async () => ({
        ok: false, text: '', usage: null,
        reasonCode: 'cli-unauthenticated', reason: 'not authenticated', authStatus: 'logged-out',
      }),
    }, () => withPatched(codexCli, {
      runModel: async () => ({
        ok: true, text: '{"learnings":[]}', usage: null, reason: null,
        identity: { provider: 'codex-cli', model: null, version: '0.144.5', vendor: null },
      }),
    }, async () => {
      const result = await providers.runModel({
        env: {}, providerCache: {}, mode: 'extract', prompt: 'P', input: 'T',
        providersStatePath: statePath,
      });
      assert.equal(result.ok, true);
      assert.equal(result.identity.provider, 'codex-cli');
      assert.notEqual(result.identity.provider, 'claude-code');
    }));
  });
});

// ─── (2) fall-through where the winning result carries no identity ──────────

describe('providers/index.js runModel(): fall-through SUCCESS with no self-stamped identity stamps unknown, never a guess', () => {
  it('claude-code fails non-retryable; codex-cli runs and succeeds but its result omits `identity` (contract violation) — stamped unknown, NOT claude-code and NOT a confident codex-cli guess', async () => {
    const statePath = path.join(tempDir('auxilo-provenance-b-'), 'providers.json');
    await withPatched(claudeCode, {
      detect: async () => true,
      runModel: async () => ({
        ok: false, text: '', usage: null,
        reasonCode: 'cli-unauthenticated', reason: 'not authenticated', authStatus: 'logged-out',
      }),
    }, () => withPatched(codexCli, {
      // Deliberately no `identity` field — simulates the contract violation
      // the investigation flagged as "latent, not open... opens the moment
      // any provider's success return omits identity."
      runModel: async () => ({ ok: true, text: '{"learnings":[]}', usage: null, reason: null }),
    }, async () => {
      const result = await providers.runModel({
        env: {}, providerCache: {}, mode: 'extract', prompt: 'P', input: 'T',
        providersStatePath: statePath,
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.identity, { provider: 'unknown', model: null, version: null, vendor: null });
    }));
  });

  it('resolveExtractionModelIdentity() (extract-local.js): given a result with no identity at all, returns the honest unknown triple — never re-derives, never guesses', () => {
    assert.deepEqual(
      extractLocal.resolveExtractionModelIdentity({ ok: true, text: '{}', usage: null }),
      { provider: 'unknown', model: null, version: null, vendor: null }
    );
    assert.deepEqual(
      extractLocal.resolveExtractionModelIdentity({ ok: false, reasonCode: 'no-usable-provider', reason: 'x' }),
      { provider: 'unknown', model: null, version: null, vendor: null }
    );
    // A well-formed identity is passed through verbatim, never touched.
    const real = { provider: 'byo-key', model: 'gpt-4o-mini', version: null, vendor: 'openai-compatible' };
    assert.deepEqual(extractLocal.resolveExtractionModelIdentity({ ok: true, identity: real }), real);
  });
});

// ─── (3) no-usable-provider stamps nothing and publishes nothing ────────────

describe('providers/index.js runModel(): every provider exhausted (no-usable-provider) never fabricates an identity', () => {
  it('claude-code, codex-cli, and byo-key all fail non-retryable — ok:false, reasonCode no-usable-provider, no identity attached to the aggregate failure', async () => {
    const statePath = path.join(tempDir('auxilo-provenance-c-'), 'providers.json');
    await withPatched(claudeCode, {
      detect: async () => false,
      runModel: async () => ({ ok: false, text: '', usage: null, reasonCode: 'cli-unauthenticated', reason: 'claude not authed', authStatus: 'logged-out' }),
    }, () => withPatched(codexCli, {
      detect: async () => false,
      runModel: async () => ({ ok: false, text: '', usage: null, reasonCode: 'cli-unauthenticated', reason: 'codex not authed', authStatus: 'unknown' }),
    }, () => withPatched(byoKey, {
      detect: async () => false,
      runModel: async () => ({ ok: false, text: '', usage: null, reasonCode: 'provider-not-configured', reason: 'no key configured', authStatus: 'unknown' }),
    }, async () => {
      const result = await providers.runModel({
        env: {}, providerCache: {}, mode: 'extract', prompt: 'P', input: 'T',
        providersStatePath: statePath,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'no-usable-provider');
      assert.equal(result.identity, undefined, 'nothing actually ran to completion — this registry must not fabricate an identity for it');
    })));
  });

  it('extract-local.js extractLocally(): the same full exhaustion, through the REAL default (non-forced) path, stamps NO extraction_model on any candidate and publishes nothing', async () => {
    const dir = tempDir('auxilo-provenance-c-extract-');
    const indexPath = path.join(dir, 'extracted-index.jsonl');
    fs.writeFileSync(indexPath, '');
    const statePath = path.join(dir, 'providers.json');
    await withPatched(claudeCode, {
      detect: async () => false,
      runModel: async () => ({ ok: false, text: '', usage: null, reasonCode: 'cli-unauthenticated', reason: 'claude not authed', authStatus: 'logged-out' }),
    }, () => withPatched(codexCli, {
      detect: async () => false,
      runModel: async () => ({ ok: false, text: '', usage: null, reasonCode: 'cli-unauthenticated', reason: 'codex not authed', authStatus: 'unknown' }),
    }, () => withPatched(byoKey, {
      detect: async () => false,
      runModel: async () => ({ ok: false, text: '', usage: null, reasonCode: 'provider-not-configured', reason: 'no key configured', authStatus: 'unknown' }),
    }, async () => {
      const result = await extractLocal.extractLocally('a synthetic transcript, long enough for the extractor', 'claude-code', {
        indexPath, log: () => {}, providersStatePath: statePath, providerCache: {},
      });
      assert.deepEqual(result.learnings, [], 'no candidates were ever produced — nothing to stamp or publish');
      assert.equal(result.reasonCode, 'no-usable-provider');
    })));
  });
});

// ─── (4) clean-lane holds on unknown AND on missing, with the reason code,
//         and still passes a genuinely calibrated claude-code stamp ─────────

describe('lib/clean-lane.js evaluateExtractionPublish(): unknown/missing hold, calibrated still passes', () => {
  const GRANT = { action: 'grant', consent_version: cleanLane.CLEAN_LANE_CONSENT_VERSION, min_auto_publish_quality: 16 };

  it('holds on an explicit unknown stamp and on a genuinely missing one, under the SAME distinct reason code', () => {
    const unknownStamp = cleanLane.evaluateExtractionPublish({
      flagEnabled: true, consentState: GRANT, qualityTotal: 20,
      extractionModel: { provider: 'unknown', model: null, version: null, vendor: null },
    });
    const missingStamp = cleanLane.evaluateExtractionPublish({
      flagEnabled: true, consentState: GRANT, qualityTotal: 20,
    });
    assert.deepEqual(unknownStamp, { decision: 'hold', reason: cleanLane.HOLD_UNKNOWN_EXTRACTION_PROVIDER });
    assert.deepEqual(missingStamp, { decision: 'hold', reason: cleanLane.HOLD_UNKNOWN_EXTRACTION_PROVIDER });
  });

  it('still auto-publishes a genuinely calibrated claude-code stamp — the unknown/missing hold does not regress the real calibrated path', () => {
    const v = cleanLane.evaluateExtractionPublish({
      flagEnabled: true, consentState: GRANT, qualityTotal: 20,
      extractionModel: { provider: 'claude-code', model: null, version: '2.1.12', vendor: 'anthropic' },
    });
    assert.deepEqual(v, { decision: 'auto_publish', consent_version: cleanLane.CLEAN_LANE_CONSENT_VERSION, min_quality: 16 });
  });

  it('a named-but-uncalibrated provider (codex-cli) holds under the DIFFERENT, pre-existing reason — never conflated with unknown/missing', () => {
    const v = cleanLane.evaluateExtractionPublish({
      flagEnabled: true, consentState: GRANT, qualityTotal: 20,
      extractionModel: { provider: 'codex-cli', model: null, version: '0.144.5', vendor: null },
    });
    assert.deepEqual(v, { decision: 'hold', reason: cleanLane.HOLD_UNCALIBRATED_PROVIDER });
  });
});

// ─── (5) the server maps a malformed stamp to unknown ────────────────────────

describe('server.js normalizeExtractionModel: malformed-but-present stamp normalizes to unknown, distinct from genuinely absent', () => {
  it('source carries the EXTRACTION-MODEL-PROVENANCE normalization: absent stays null, malformed becomes {provider:"unknown"}', () => {
    assert.match(
      SERVER_SRC,
      /function normalizeExtractionModel\(value\) \{\s*if \(value === undefined \|\| value === null\) return null;/,
      'a genuinely absent extraction_model must still normalize to null (feeds the "missing" hold path)'
    );
    assert.match(
      SERVER_SRC,
      /return \{ provider: 'unknown', model: null, version: null, vendor: null \};/,
      'a present-but-malformed extraction_model must normalize to an explicit unknown stamp, never null'
    );
  });

  // Full behavioral proof (never a 400, stored as {provider:'unknown',...},
  // holds via HOLD_UNKNOWN_EXTRACTION_PROVIDER, and a genuinely missing
  // stamp holds the same way but stores no key at all) lives in the real
  // staged-server round trip: test/extraction-model-stamp.test.js, cases
  // (3) and (4) of "EXTRACT-PER-CLIENT W1 PART C: real staged-server round
  // trip" — kept there rather than duplicated here to amortize one server
  // boot across both the pre-existing calibration assertions and this row's.
});

// ─── (6) the identity path performs no write to providers.json ──────────────

describe('EXTRACTION-MODEL-PROVENANCE side-effect removal: identity resolution never writes providers.json', () => {
  it('a full extraction run (fast-path selection, real claude-code success) leaves providers.json byte-identical and its mtime untouched', async () => {
    const dir = tempDir('auxilo-provenance-nowrite-');
    const indexPath = path.join(dir, 'extracted-index.jsonl');
    fs.writeFileSync(indexPath, '');
    const statePath = path.join(dir, 'providers.json');
    const seeded = JSON.stringify({ selected: 'claude-code' }, null, 2);
    fs.writeFileSync(statePath, seeded);
    fs.chmodSync(statePath, 0o600);
    const beforeContent = fs.readFileSync(statePath, 'utf8');
    const beforeStat = fs.statSync(statePath);

    // Fast-path selection (persisted `selected` re-verified via detect(),
    // never a full scan) — one auth-check spawn for detect(), one for
    // runExtractMode's own internal pre-spawn check, then the extraction
    // spawn itself. The fast path never calls persistSelected; neither does
    // the (now-deleted) identity re-resolve.
    const { spawnSyncImpl } = spawnQueue([authJson(true), authJson(true), extractionStdout([])]);
    const result = await extractLocal.extractLocally('a synthetic transcript, long enough for the extractor', 'claude-code', {
      indexPath, log: () => {}, spawnSyncImpl, claudeBin: 'claude', homeDir: dir, cwd: dir,
      providersStatePath: statePath, providerCache: {},
    });
    assert.equal(result.learnings.length, 0);

    const afterContent = fs.readFileSync(statePath, 'utf8');
    const afterStat = fs.statSync(statePath);
    assert.equal(afterContent, beforeContent, 'providers.json bytes must be untouched by identity resolution');
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, 'providers.json mtime must be untouched by identity resolution');
  });

  it('resolveExtractionModelIdentity() itself takes only the result object — it has no opts/path parameter to write through, structurally incapable of touching providers.json', () => {
    assert.equal(extractLocal.resolveExtractionModelIdentity.length, 1,
      'a one-argument function cannot thread a providersStatePath anywhere; the old two-argument (result, opts) re-detect signature is gone for good');
  });
});

// ─── (7) the fall-through FAILURE identity — the exact mislabeled-log-line
//         shape observed 2026-09-08: claude-code fails non-retryable, the
//         walk moves on, codex-cli then fails RETRYABLE (cli-timeout is NOT
//         in NON_RETRYABLE_FOR_THIS_PROVIDER, so the walk STOPS there and
//         never reaches byo-key), and codex-cli's own failure return
//         carries no identity of its own (it only self-stamps on its SINGLE
//         success return) — this is the untested gap: every fixture above
//         covers a winning SUCCESS or full exhaustion, never a STOPPING
//         failure mid-walk. Deliberately does not force
//         AUXILO_EXTRACTION_PROVIDER (bypasses fall-through entirely, which
//         is why this shape went untested in the first place) ────────────

describe('providers/index.js runModel() + extract-local.js extractLocally(): the fall-through FAILURE identity (claude-code skipped, codex-cli ran and failed, no identity of its own)', () => {
  it('providers.runModel(): names codex-cli on the returned failure, never claude-code and never a guess; byo-key is never tried', async () => {
    const statePath = path.join(tempDir('auxilo-provenance-g-'), 'providers.json');
    let byoKeyCalled = false;
    await withPatched(claudeCode, {
      detect: async () => true,
      runModel: async () => ({
        ok: false, text: '', usage: null,
        reasonCode: 'cli-unauthenticated', reason: 'not authenticated', authStatus: 'logged-out',
      }),
    }, () => withPatched(codexCli, {
      runModel: async () => ({
        ok: false, text: '', usage: null,
        reasonCode: 'cli-timeout', reason: 'codex exec timed out', authStatus: 'unknown',
      }),
    }, () => withPatched(byoKey, {
      runModel: async () => {
        byoKeyCalled = true;
        return { ok: false, text: '', usage: null, reasonCode: 'provider-not-configured', reason: 'no key configured', authStatus: 'unknown' };
      },
    }, async () => {
      const result = await providers.runModel({
        env: {}, providerCache: {}, mode: 'extract', prompt: 'P', input: 'T',
        providersStatePath: statePath,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'cli-timeout', 'a RETRYABLE failure must be returned as-is, never aggregated into no-usable-provider');
      assert.equal(result.identity && result.identity.provider, 'codex-cli', 'the module actually invoked, derived centrally by providers/index.js — never claude-code (skipped) and never a guess');
      assert.equal(byoKeyCalled, false, 'a RETRYABLE failure stops the walk right there — byo-key must never be tried');
    })));
  });

  it('extract-local.js extractLocally(): the same fall-through-then-stop through the REAL default (non-forced) path — the per-run [providers] log line names codex-cli, and nothing is stamped or published from the failed run', async () => {
    const dir = tempDir('auxilo-provenance-g-extract-');
    const indexPath = path.join(dir, 'extracted-index.jsonl');
    fs.writeFileSync(indexPath, '');
    const statePath = path.join(dir, 'providers.json');
    const logLines = [];
    let byoKeyCalled = false;
    await withPatched(claudeCode, {
      detect: async () => true,
      runModel: async () => ({
        ok: false, text: '', usage: null,
        reasonCode: 'cli-unauthenticated', reason: 'not authenticated', authStatus: 'logged-out',
      }),
    }, () => withPatched(codexCli, {
      // codex-cli's own failure return, deliberately carrying NO `identity`
      // — its real contract (see providers/index.js's deriveIdentity
      // docblock: codex-cli and byo-key only self-stamp on their single
      // success return). This is the exact shape that used to be
      // mislabeled: the log line named the LAST provider whose runModel()
      // was actually invoked, but with no identity of its own to trust.
      runModel: async () => ({
        ok: false, text: '', usage: null,
        reasonCode: 'cli-timeout', reason: 'codex exec timed out', authStatus: 'unknown',
      }),
    }, () => withPatched(byoKey, {
      runModel: async () => {
        byoKeyCalled = true;
        return { ok: false, text: '', usage: null, reasonCode: 'provider-not-configured', reason: 'no key configured', authStatus: 'unknown' };
      },
    }, async () => {
      const result = await extractLocal.extractLocally(
        'a synthetic transcript, long enough for the extractor',
        'claude-code',
        { indexPath, log: (msg) => logLines.push(msg), providersStatePath: statePath, providerCache: {} }
      );
      assert.deepEqual(result.learnings, [], 'the candidate path (extract-local.js ~:823-834) must return before the stamp spread (~:848) — nothing published from a failed run');
      assert.equal(result.reasonCode, 'cli-timeout');
      assert.equal(byoKeyCalled, false, 'a RETRYABLE failure stops the walk before byo-key is ever tried');
      assert.ok(
        logLines.some((l) => /^\[providers\] run=\S+ provider=codex-cli /.test(l)),
        `the per-run [providers] log line must name codex-cli (the module that actually ran), got: ${JSON.stringify(logLines)}`
      );
      assert.ok(
        !logLines.some((l) => /provider=claude-code/.test(l)),
        'must never mislabel the fall-through failure as claude-code — the exact defect this row fixes'
      );
    })));
  });
});

after(cleanupTempDirs);
