#!/usr/bin/env node

'use strict';

/**
 * bin/auxilo-cli.js — Turnkey installer CLI (LW-12)
 *
 *   npx auxilo setup     Interactive: detect clients, register MCP, device-code
 *                        login, install extraction runner + hook, record consent.
 *   npx auxilo status    Show clients, auth, consent/mode, sentinel, hook, queue.
 *   npx auxilo disable   Remove the local kill-switch sentinel (+ optional revoke).
 *
 * This file is the thin binding layer: real home directory, real fetch, real
 * stdin. All logic lives in lib/installer.js (testable, fixture-driven).
 * Supersedes `auxilo-mcp setup` and `auxilo-mcp login` (Change 3/4).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { exec } = require('child_process');
const installer = require('../lib/installer.js');
const review = require('../lib/review.js');
const providers = require('../scripts/providers/index.js');
const byoKeyProvider = require('../scripts/providers/byo-key.js');

const HOME = os.homedir();

// ─── Prompt helpers ─────────────────────────────────────────────────────────

// LW-17: ONE shared readline interface for the whole run. Creating a fresh
// interface per question loses any input readline already buffered when the
// previous interface closed — with piped/scripted stdin the answer to
// question N+1 arrives with question N's buffer and the next prompt hangs
// on EOF (the 0.8.1 consent step silently never completed).
let sharedRl = null;
let bufferedLines = [];
let lineWaiters = [];
let readlineEnded = false;
function getRl() {
  if (!sharedRl) {
    readlineEnded = false;
    sharedRl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: !!process.stdin.isTTY,
    });
    sharedRl.on('line', (line) => {
      const answer = line.trim();
      const waiter = lineWaiters.shift();
      if (waiter) waiter(answer);
      else bufferedLines.push(answer);
    });
    sharedRl.on('close', () => {
      readlineEnded = true;
      while (lineWaiters.length) lineWaiters.shift()('');
    });
  }
  return sharedRl;
}
function closeRl() {
  if (sharedRl) sharedRl.close();
  sharedRl = null;
  bufferedLines = [];
  lineWaiters = [];
  readlineEnded = false;
}

function ask(question) {
  getRl();
  process.stdout.write(question);
  if (bufferedLines.length > 0) return Promise.resolve(bufferedLines.shift());
  if (readlineEnded) return Promise.resolve('');
  return new Promise((resolve) => {
    lineWaiters.push(resolve);
  });
}

/** Yes/no prompt. defaultYes=false → consent-grade default-No (spec §LW-12 step 5). */
async function askYesNo(question, defaultYes = false) {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const answer = (await ask(question + suffix)).toLowerCase();
  if (answer === '') return defaultYes;
  return answer === 'y' || answer === 'yes';
}

/**
 * Hidden-input prompt (PART C, `auxilo provider set`'s key entry) — the
 * typed key is never echoed to the terminal. Reuses the SAME shared
 * readline interface / line-buffering scheme as `ask()` (LW-17: a second
 * independent readline interface loses whatever the first already buffered
 * on piped stdin), and suppresses only the per-keystroke echo `_writeToOutput`
 * would otherwise perform — the question text itself is written directly,
 * and the terminating newline is always passed through so the cursor
 * advances normally. `_writeToOutput` is an internal Node readline hook (not
 * a documented public API) — the same technique widely used before a
 * dedicated password-prompt package existed; degrades safely to a normal
 * (echoed) prompt on any Node build where the hook is absent.
 */
function askHidden(question) {
  const rl = getRl();
  process.stdout.write(question);
  let restore = () => {};
  if (process.stdin.isTTY && typeof rl._writeToOutput === 'function') {
    const original = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (stringToWrite) => {
      if (stringToWrite === '\r\n' || stringToWrite === '\n' || stringToWrite === '\r') {
        original(stringToWrite);
      }
      // else: swallow the echoed keystroke.
    };
    restore = () => { rl._writeToOutput = original; };
  }
  if (bufferedLines.length > 0) {
    const line = bufferedLines.shift();
    restore();
    return Promise.resolve(line);
  }
  if (readlineEnded) {
    restore();
    return Promise.resolve('');
  }
  return new Promise((resolve) => {
    lineWaiters.push((answer) => {
      restore();
      resolve(answer);
    });
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start ""'
    : 'xdg-open';
  exec(`${cmd} "${url}"`, () => { /* best-effort; URL is printed regardless */ });
}

function resolveBaseUrl(flags) {
  if (flags['base-url']) return flags['base-url'];
  if (process.env.AUXILO_BASE_URL) return process.env.AUXILO_BASE_URL;
  const creds = installer.readCredentials(HOME);
  if (creds && creds.base_url) return creds.base_url;
  return installer.DEFAULT_BASE_URL;
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 3; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    if (m[2] !== undefined) flags[m[1]] = m[2];
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[m[1]] = argv[++i];
    else flags[m[1]] = true;
  }
  return flags;
}

// ─── auxilo setup ───────────────────────────────────────────────────────────

const CONSENT_TEXT = `
  Background extraction (optional)
  --------------------------------
  If you opt in, a session-end hook runs after each session in your wired
  clients (Claude Code, Cursor, Gemini CLI, …) and a local runner:
    • READS the session transcript on your machine,
    • SCRUBS it locally (sensitivity filter: API keys, tokens, emails, PII
      are redacted first),
    • EXTRACTS reusable learnings locally through the first model client you
      have installed (Claude Code, then Codex) or, when neither is
      available, a provider key you set yourself. For this step your
      scrubbed transcript goes only to that provider, under your own
      account with them, and any use is charged to that account, never to
      Auxilo. It is never sent to Auxilo, raw or scrubbed.
    • UPLOADS only the finished learning drafts (title, body, category,
      tags, task context, outcome) to Auxilo (${'POST /learn'}). Everything
      waits in your review queue until you approve it, one learning at a
      time or in advance in your dashboard. Your first public learning
      waits for operator review. A draft that any screen flags (sensitive,
      duplicate, uncertain quality) waits in your private queue for
      \`auxilo review\`. Auto-publish for learnings that pass every screen is
      off unless you turn it on in your dashboard. Your share of a paid
      unlock by another agent goes to your Auxilo account, 70% of what they
      paid on a direct unlock and 60% via discovery. A repeat unlock by the
      same buyer within 30 days earns nothing. Earnings depend on whether
      other agents unlock your learnings and are not guaranteed. Earnings
      accrue now. Withdrawals open soon, and auxilo.io/status shows where
      things stand.
  You can stop any time with \`auxilo disable\` (local kill-switch) and review
  every run in ~/.auxilo/extract.log. Saying No installs the MCP server only.
  No session-end capture hook is written into any client config unless you say
  Yes, and any capture hooks left by an earlier install are removed.
`;

async function cmdSetup(flags) {
  const baseUrl = resolveBaseUrl(flags);
  console.log('\nAuxilo turnkey setup');
  console.log('====================');
  console.log(`Server: ${baseUrl}\n`);

  // 1. Client detection ------------------------------------------------------
  const detected = installer.detectClients(HOME);
  if (detected.length === 0) {
    console.log('No supported clients detected (Claude Code, Claude Desktop, Cursor, Windsurf,');
    console.log('Codex CLI, Gemini CLI, Antigravity, Factory droid, Copilot CLI, Continue.dev,');
    console.log('opencode, Kiro, Junie, Amp, OpenHands, OpenClaw).');
    console.log('Install one, then re-run `npx auxilo setup`.');
    process.exit(1);
  }

  console.log('Detected clients:');
  detected.forEach((c, i) => {
    const extras = [c.mcp ? 'MCP' : 'poll-based source', c.hooks ? 'background extraction' : null]
      .filter(Boolean).join(', ');
    console.log(`  ${i + 1}. ${c.name} (${extras})`);
  });

  let chosen = detected;
  const pick = await ask(`\nConfigure which clients? [all] (e.g. "1,3" or "all") `);
  if (pick && pick.toLowerCase() !== 'all') {
    const idx = pick.split(',').map((s) => parseInt(s.trim(), 10) - 1);
    chosen = detected.filter((_, i) => idx.includes(i));
    if (chosen.length === 0) {
      console.log('Nothing selected — exiting without changes.');
      process.exit(0);
    }
  }

  // 2. MCP registration ------------------------------------------------------
  console.log('');
  for (const client of chosen.filter((c) => c.mcp)) {
    try {
      const result = installer.registerMcp(client);
      console.log(result.changed
        ? `  ✓ ${client.name}: registered Auxilo MCP server (${result.configPath})`
        : `  ✓ ${client.name}: already registered (no changes)`);
    } catch (err) {
      // B15: malformed config — skip loudly, never overwrite.
      console.error(`  ✗ ${client.name}: SKIPPED — ${err.message}`);
    }
  }
  const openclaw = chosen.find((c) => c.id === 'openclaw');
  if (openclaw) {
    console.log('  ✓ OpenClaw: no MCP config needed — covered by the poll-based source adapter.');
  }

  // 3. Device-code auth ------------------------------------------------------
  console.log('');
  let creds = installer.readCredentials(HOME);
  if (creds && creds.api_key && !flags['re-auth']) {
    console.log(`  ✓ Already authenticated as ${creds.email || creds.account_id || 'existing account'}`);
    console.log('    (use `auxilo setup --re-auth` to log in again)');
  } else {
    console.log('  Logging in to Auxilo (device code flow)...');
    try {
      const result = await installer.deviceLogin({
        baseUrl,
        onCode: (code, url) => {
          console.log(`\n  Your device code: ${code}`);
          console.log(`  Verify at: ${url}\n  Waiting for authorization (Ctrl-C to abort)...`);
          openBrowser(url);
        },
      });
      installer.writeCredentials(HOME, {
        api_key: result.api_key,
        base_url: result.base_url,
        email: result.email,
        account_id: result.account_id,
      });
      creds = installer.readCredentials(HOME);
      console.log(`  ✓ Logged in as ${result.email || result.account_id}`);
      console.log(`  ✓ Credentials saved to ~/.auxilo/credentials.json (mode 0600)`);
    } catch (err) {
      console.error(`  ✗ Login failed: ${err.message}`);
      console.error('    MCP registration (above) is still in place. Re-run `auxilo setup` to retry login.');
      process.exit(1);
    }
  }

  // 4. Runner install + review notice -----------------------------------------
  // UC-1a (GOV-3): NO capture hook is written into any third-party client
  // config here — only files under our own ~/.auxilo/bin, plus the
  // SessionStart review notice (a count-only account-status surface, not a
  // capture hook). Capture hooks are written ONLY after consent=Yes (step 5).
  console.log('');
  try {
    const { binRoot } = installer.installRunner(HOME);
    console.log(`  ✓ Extraction runner installed to ${binRoot}`);
  } catch (err) {
    console.error(`  ✗ Runner install failed: ${err.message}`);
    process.exit(1);
  }

  const claudeCode = chosen.find((c) => c.id === 'claude-code');
  if (claudeCode) {
    // LW-18: SessionStart held-count notice ("N learnings held for your
    // review") — fail-silent, ≤1 per 4h, count-only. Installed regardless of
    // extraction consent: the review queue also holds MCP contributions.
    try {
      const notice = installer.registerClaudeCodeSessionStartNotice(HOME);
      console.log(notice.changed
        ? `  ✓ Claude Code SessionStart review notice registered (${notice.hookCmd})`
        : '  ✓ Claude Code SessionStart review notice already registered (no changes)');
    } catch (err) {
      console.error(`  ✗ Review notice SKIPPED — ${err.message}`);
    }
  }

  // 5. Explicit consent (default No), THEN capture hooks ----------------------
  console.log(CONSENT_TEXT);
  const consented = await askYesNo('  Enable background extraction?', false);
  let extractionArmed = false;
  if (consented) {
    try {
      await installer.recordConsent({ action: 'grant', apiKey: creds.api_key, baseUrl });
      installer.enableSentinel(HOME);
      extractionArmed = true;
      console.log('  ✓ Consent recorded; background extraction ENABLED (~/.auxilo/autonomous-enabled)');
    } catch (err) {
      console.error(`  ✗ Could not record consent on server: ${err.message}`);
      console.error('    Background extraction NOT enabled (no sentinel created, no hooks written). Re-run `auxilo setup` to retry.');
    }
  } else {
    console.log('  ✓ Background extraction left OFF (MCP-only install). Enable later by re-running `auxilo setup`.');
  }

  if (extractionArmed) {
    // Consent recorded — NOW write the capture hooks (UC-1a ordering).
    if (claudeCode) {
      try {
        const hook = installer.registerClaudeCodeHook(HOME);
        if (hook.changed) {
          console.log(`  ✓ Claude Code SessionEnd hook registered (${hook.hookCmd})`);
          if (hook.removedLegacy.length > 0) {
            console.log(`    (replaced legacy hook entr${hook.removedLegacy.length === 1 ? 'y' : 'ies'}: ${hook.removedLegacy.join(', ')})`);
          }
        } else {
          console.log('  ✓ Claude Code SessionEnd hook already registered (no changes)');
        }
      } catch (err) {
        console.error(`  ✗ Hook registration SKIPPED — ${err.message}`);
      }
    }

    // UC-1: capture hooks for every other chosen client that supports one.
    try {
      for (const r of installer.installCaptureHooks(HOME, chosen)) {
        if (r.error) {
          console.error(`  ✗ ${r.name}: SKIPPED — ${r.error}`);
        } else if (r.changed) {
          console.log(`  ✓ ${r.name}: capture hook registered (${r.event})`);
          if (r.notes) console.log(`    ${r.notes}`);
        } else {
          console.log(`  ✓ ${r.name}: capture hook already registered`);
          if (r.notes) console.log(`    ${r.notes}`);
        }
      }
    } catch (err) {
      console.error(`  ✗ Capture hooks SKIPPED — ${err.message}`);
    }
  } else {
    // UC-1a: consent not granted (No, or consent record failed) — ensure NO
    // capture-hook artifact remains in any client config, including ones a
    // pre-UC-1a install wrote before the consent step.
    try {
      const removedHook = installer.removeClaudeCodeHook(HOME);
      if (removedHook.changed) {
        console.log(`  ✓ Removed pre-existing Claude Code SessionEnd capture hook (${removedHook.removed.join(', ')})`);
      }
    } catch (err) {
      console.error(`  ✗ Claude Code hook cleanup SKIPPED — ${err.message}`);
    }
    try {
      const allClients = installer.detectClients(HOME); // clean beyond the chosen set
      for (const r of installer.removeCaptureHooks(HOME, allClients)) {
        if (r.error) console.error(`  ✗ ${r.name}: capture-hook cleanup SKIPPED — ${r.error}`);
        else if (r.changed) console.log(`  ✓ ${r.name}: removed pre-existing capture hook`);
      }
    } catch (err) {
      console.error(`  ✗ Capture-hook cleanup SKIPPED — ${err.message}`);
    }
    console.log('  ✓ No capture hooks are present in any client config.');
  }

  // 6. Rules-file snippet (UC-0 agent-prompted contribution; opt-in, default No)
  const rulesClients = chosen.filter((c) => c.rulesPath);
  if (rulesClients.length > 0) {
    console.log('');
    const addRules = await askYesNo(
      "  Add a one-paragraph note to your agents' global rules files suggesting they contribute learnings?",
      false
    );
    if (addRules) {
      try {
        const results = installer.installRulesSnippet(HOME, {
          targets: rulesClients.map((c) => c.rulesPath),
        });
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          console.log(r.changed
            ? `  ✓ ${rulesClients[i].name}: contribution note written to ${r.path}`
            : `  ✓ ${rulesClients[i].name}: contribution note already present in ${r.path} (no changes)`);
        }
      } catch (err) {
        console.error(`  ✗ Rules snippet SKIPPED — ${err.message}`);
      }
    } else {
      console.log('  ✓ Rules files left untouched.');
    }
  }

  console.log('\nDone. Check `npx auxilo status` any time. Restart your client(s) to pick up the MCP server.\n');
}

// ─── auxilo init (NF-3, Wave 3.4) ───────────────────────────────────────────
//
// Non-interactive builder onboarding: mint a SCOPED key for CI or a second
// machine WITHOUT re-running full setup (no client detection, no hooks, no
// consent flow, and — unless --save — no touch of ~/.auxilo/credentials.json).
// ZERO prompts by design: every input is a flag with a default, so piped/
// scripted stdin can never hang (LW-17 lesson class; init never opens the
// shared readline at all). The only human step is the device-code approval
// in a browser, which can happen on any machine.

const INIT_SCOPES = ['read', 'earnings-read', 'contribute'];

async function cmdInit(flags) {
  const baseUrl = resolveBaseUrl(flags);

  const scope = flags.scope === undefined ? 'contribute' : String(flags.scope);
  if (!INIT_SCOPES.includes(scope)) {
    console.error(`Invalid --scope '${scope}'. Must be one of: ${INIT_SCOPES.join(', ')}.`);
    console.error('(admin keys cannot be created via the API or device flow.)');
    process.exit(1);
  }
  const label = (flags.label === undefined || flags.label === true
    ? `init-${os.hostname()}`
    : String(flags.label)).trim().slice(0, 50);

  if (!flags.json) {
    console.log('\nAuxilo init — mint a scoped API key');
    console.log('===================================');
    console.log(`Server: ${baseUrl}`);
    console.log(`Scope:  ${scope}   Label: ${label}\n`);
  }

  let result;
  try {
    result = await installer.deviceLogin({
      baseUrl,
      scope,
      label,
      onCode: (code, url) => {
        if (!flags.json) {
          console.log(`  Your device code: ${code}`);
          console.log(`  Approve at: ${url}`);
          console.log('  Waiting for authorization (Ctrl-C to abort)...\n');
        } else {
          // --json keeps stdout machine-readable; the human-step info goes to stderr.
          console.error(`device_code=${code} approve_at=${url}`);
        }
        if (!flags['no-browser']) openBrowser(url);
      },
    });
  } catch (err) {
    console.error(`✗ init failed: ${err.message}`);
    process.exit(1);
  }

  // Pre-Wave-3.4 servers ignore the requested scope and mint 'contribute'
  // (and don't echo). Detect and WARN — never silently mislabel a credential.
  const grantedScope = result.scope || 'contribute';
  const grantedLabel = result.label || label;
  if (grantedScope !== scope) {
    console.error(`  ! Server granted scope '${grantedScope}' (requested '${scope}') — older server version. The key below carries '${grantedScope}'.`);
  }

  if (flags['env-file']) {
    const envPath = String(flags['env-file']);
    try {
      const w = installer.writeEnvFile(envPath, { api_key: result.api_key, base_url: baseUrl });
      if (!flags.json) {
        console.log(`  ✓ ${w.created ? 'Created' : 'Updated'} ${w.path} (AUXILO_API_KEY, mode 0600)`);
      }
    } catch (err) {
      // The key was already minted — surface it rather than losing it.
      console.error(`  ✗ Could not write ${envPath}: ${err.message}`);
      console.error('    Your key (shown once — store it now):');
      console.error(`    ${result.api_key}`);
      process.exit(1);
    }
  }

  if (flags.save) {
    installer.writeCredentials(HOME, {
      api_key: result.api_key,
      base_url: baseUrl,
      email: result.email,
      account_id: result.account_id,
    });
    if (!flags.json) console.log('  ✓ Saved to ~/.auxilo/credentials.json (mode 0600) — this machine now uses this key.');
  }

  if (flags.json) {
    console.log(JSON.stringify({
      api_key: result.api_key,
      scope: grantedScope,
      label: grantedLabel,
      account_id: result.account_id,
      email: result.email,
      base_url: baseUrl,
      env_file: flags['env-file'] ? String(flags['env-file']) : null,
      saved_credentials: !!flags.save,
    }));
    return;
  }

  console.log(`  ✓ Key minted for ${result.email || result.account_id} (scope: ${grantedScope}, label: ${grantedLabel})`);
  if (!flags['env-file']) {
    console.log('\n  Your API key (shown ONCE — store it now, e.g. in your CI secret store):');
    console.log(`    ${result.api_key}\n`);
    console.log('  Use it as the X-API-Key header, or write it to an env file next time with --env-file <path>.');
  }
  console.log('  Rotate later: POST /account/api-keys/rotate with this key (self-rotate).');
  console.log('  Revoke later: from the dashboard, or DELETE /account/api-keys/:label with this key.\n');
}

// ─── auxilo status ──────────────────────────────────────────────────────────

async function cmdStatus() {
  const s = await installer.getStatus(HOME);

  console.log('\nAuxilo status');
  console.log('=============');

  console.log('Clients:');
  if (s.clients.length === 0) console.log('  (none detected)');
  for (const c of s.clients) {
    const reg = c.mcp
      ? (c.registered ? 'MCP registered' : 'detected, MCP NOT registered')
      : 'poll-based source (no MCP config)';
    console.log(`  ${c.name}: ${reg}`);
  }

  console.log(`Auth: ${s.auth.credentialsFile
    ? `credentials present (key ${s.auth.keyPrefix || 'unreadable'}${s.auth.email ? `, ${s.auth.email}` : ''})`
    : 'NOT logged in (run `npx auxilo setup`)'}`);
  console.log(`Account mode: ${s.accountMode}`);
  console.log(`Kill-switch sentinel: ${s.sentinel ? 'present (extraction enabled)' : 'absent (extraction disabled)'}`);
  console.log(`Runner installed: ${s.runnerInstalled ? 'yes (~/.auxilo/bin)' : 'no'}`);
  if (s.runnerInstalled) {
    const line = runnerSkewLine(installer.runnerVersionSkew(HOME));
    if (line) console.log(line);
  }
  console.log(extractionProviderLine(await providers.resolveProvider({})));
  // Lazy require: scripts/runner.js is a heavier module (sources, sensitivity
  // filter, ops-alert) than this one status line needs at require-time for
  // every CLI invocation.
  let skipState = null;
  try {
    skipState = require('../scripts/runner.js').loadExtractionSkipState();
  } catch { /* status must never throw on a missing/corrupt skip-state file */ }
  const skipLine = extractionSkipReasonLine(skipState);
  if (skipLine) console.log(skipLine);
  console.log(`SessionEnd hook: ${s.hookInstalled ? 'installed' : 'not installed'}${s.hookRegistered ? ', registered in Claude Code settings' : ''}`);
  for (const c of s.clients.filter((c) => c.captureHook)) {
    console.log(`Capture hooks: ${c.name} (${c.captureEvent}, ${c.captureRegistered ? 'registered' : 'not registered'})`);
  }
  console.log(`Last extraction sweep: ${s.lastSweep || 'never'}`);
  console.log(`Pending upload queue: ${s.pendingCount} file(s)\n`);
}

/**
 * CLEAN-LANE-FLIP Phase B: ONE line when ~/.auxilo/bin/VERSION is missing or
 * differs from this CLI's package version; null when the stack is current.
 * `setup` is idempotent and re-copies the stack, so that is the remedy.
 */
function runnerSkewLine(skew) {
  if (!skew || !skew.skew) return null;
  const installed = skew.installed ? `v${skew.installed}` : 'unstamped (pre-0.9.12)';
  return `  ⚠ Installed runner is ${installed} (package v${skew.package}) — run: npx auxilo setup`;
}

/**
 * Mirrors lib/clean-lane.js's CLEAN_LANE_CALIBRATED_PROVIDERS — that module
 * is server-side and not in the published package's files[] (same reason
 * CLEAN_LANE_AFFIRMATION below is a literal mirror, not an import; see
 * test/clean-lane-phase-a.test.js's "the CLI must not require the unshipped
 * server module" pin). test/clean-lane-calibration.test.js pins the two
 * arrays equal.
 */
const CLI_CLEAN_LANE_CALIBRATED_PROVIDERS = ['claude-code'];

/**
 * EXTRACT-PER-CLIENT W1 PART A/C — one unconditional line naming which
 * extraction model provider resolves, why (env override vs auto-detected),
 * and (PART C) whether that provider's submissions can reach the clean-lane
 * auto-publish path at all (server-side gate: lib/clean-lane.js's
 * CLEAN_LANE_CALIBRATED_PROVIDERS, mirrored above).
 */
function extractionProviderLine(resolution) {
  if (resolution && resolution.ok) {
    const via = process.env.AUXILO_EXTRACTION_PROVIDER
      ? 'env override AUXILO_EXTRACTION_PROVIDER'
      : 'auto-detected';
    const calibration = CLI_CLEAN_LANE_CALIBRATED_PROVIDERS.includes(resolution.id)
      ? 'clean-lane calibrated'
      : 'review-lane only';
    return `Extraction model provider: ${resolution.id} (${via}, ${calibration})`;
  }
  const reason = (resolution && resolution.reason) || 'no provider available';
  return `Extraction model provider: none (${reason})`;
}

/**
 * EXTRACT-PER-CLIENT W1 PART C — the companion conditional line PART A left
 * unimplemented (see its report): printed ONLY when the last recorded
 * extraction skip reasonCode (runner.js's normalizeExtractionSkipState,
 * last_reason_code field, added in this part) is one of the names below;
 * null (nothing printed) for every other state, including "no state file
 * yet" and "last outcome was a real success."
 *
 * 'no-usable-provider' added in the W1 P1 fix (PUNCH-LIST): distinct from
 * 'no-model-provider-available' (nothing even LOOKED usable at the detect()
 * stage) — this is the selection-fall-through exhaustion code from
 * scripts/providers/index.js's runModel(), where every provider in
 * PROVIDER_ORDER was actually tried and each failed for its own reason.
 */
const STATUS_WORTHY_SKIP_REASON_CODES = Object.freeze([
  'cli-billing-helper-configured',
  'cli-unauthenticated',
  'no-model-provider-available',
  'no-usable-provider',
]);

/** Pure render, mirroring runnerSkewLine(skew) above — the caller loads the
 * state; this only decides whether/what to print. */
function extractionSkipReasonLine(state) {
  if (!state || !STATUS_WORTHY_SKIP_REASON_CODES.includes(state.last_reason_code)) return null;
  return `  ⚠ Last extraction attempt: ${state.last_reason_code}`;
}

// ─── auxilo disable ─────────────────────────────────────────────────────────

async function cmdDisable(flags) {
  const removed = installer.disableSentinel(HOME);
  console.log(removed
    ? '✓ Kill-switch sentinel removed — background extraction is now DISABLED locally.'
    : '✓ Sentinel already absent — background extraction was not enabled.');

  const creds = installer.readCredentials(HOME);
  if (creds && creds.api_key) {
    const revoke = await askYesNo('Also revoke extraction consent on the server?', false);
    if (revoke) {
      try {
        await installer.recordConsent({
          action: 'revoke',
          apiKey: creds.api_key,
          baseUrl: resolveBaseUrl(flags),
        });
        console.log('✓ Consent revoked on server (account mode set to off).');
      } catch (err) {
        console.error(`✗ Server revoke failed: ${err.message} — local kill-switch is still in effect.`);
      }
    }
  }
  console.log('Note: MCP server registrations are left in place (remove manually from client configs if desired).');
}

// ─── auxilo review ──────────────────────────────────────────────────────────
//
// The human gate that makes background extraction safe to re-enable:
//   extract -> pending_review -> `auxilo review` -> approve the safe ones.
// Operates ONLY on the caller's own pending learnings (account-scoped API key).
//
// Review-seamless (2026-07-18): the default view is now a triage summary table
// (quality-desc rows grouped into the server's three lanes), with bulk modes that batch through
// POST /account/pending/bulk. HARD RULE for every bulk APPROVE path: print the
// exact list and count first, then require the operator to TYPE THE COUNT.
// There is no --yes bypass on any approve path; publishing always costs one
// typed number (2026-06-10 mass-publish lesson).

/** Truncate + pad a string to an exact width (for the triage table). */
function fit(s, width) {
  const str = String(s == null ? '' : s);
  if (str.length > width) return str.slice(0, Math.max(0, width - 1)) + '…';
  return str.padEnd(width);
}

/** Short lane/flag codes for a summary row, e.g. 'ready' or 'inj+sens'. */
function shortFlags(row) {
  const resolved = review.reviewLane(row);
  const visibility = row.visibility === 'private' ? ['priv'] : [];
  if (resolved.lane === 'ready_to_publish') return visibility.concat('ready').join('+');
  if (resolved.lane === 'needs_score') return visibility.concat('score').join('+');
  const map = {
    injection: 'inj',
    content_sensitivity: 'sens',
    near_duplicate: 'dup',
    process_advice: 'advice',
    account_vocab: 'vocab',
  };
  return visibility.concat((row.flags || []).map((f) => map[f] || f)).join('+') || 'flagged';
}

/** One compact triage line (shared by the table and rapid mode). */
function triageLine(row, n, total) {
  const q = row.quality == null ? ' --' : String(row.quality).padStart(3);
  return `  ${String(n).padStart(String(total).length)}. q=${q}  ${fit(shortFlags(row), 9)} ${fit(row.category || '', 20)} ${fit(row.title || '(no title)', 52)}`;
}

function groupSummaryRows(summary) {
  const groups = {
    ready_to_publish: [],
    needs_score: [],
    needs_your_eyes: [],
  };
  let versionSkew = false;
  for (const row of summary.items || []) {
    const resolved = review.reviewLane(row);
    versionSkew = versionSkew || resolved.version_skew;
    groups[resolved.lane].push(row);
  }
  const serverCounts = summary.counts && summary.counts.by_lane;
  const counts = !versionSkew && serverCounts
    ? {
        ready_to_publish: serverCounts.ready_to_publish || 0,
        needs_score: serverCounts.needs_score || 0,
        needs_your_eyes: serverCounts.needs_your_eyes || 0,
      }
    : {
        ready_to_publish: groups.ready_to_publish.length,
        needs_score: groups.needs_score.length,
        needs_your_eyes: groups.needs_your_eyes.length,
      };
  return { groups, counts, versionSkew };
}

/** Print the triage summary in the server's three-lane order. */
function printSummaryTable(summary) {
  const { groups, counts, versionSkew } = groupSummaryRows(summary);

  console.log(`\n${summary.pending_count} learning(s) pending your review: ${counts.ready_to_publish} ready to publish, ${counts.needs_score} need a score, ${counts.needs_your_eyes} need your eyes.`);
  if (versionSkew) {
    console.log('VERSION SKEW: this server did not return lane on every row; using the legacy screens-and-quality fallback.');
  }
  const bands = summary.counts && summary.counts.by_quality_band;
  if (bands) {
    console.log(`Quality bands: 18-20: ${bands['18-20'] || 0} · 14-17: ${bands['14-17'] || 0} · 10-13: ${bands['10-13'] || 0} · below 10: ${bands.below_10 || 0} · unscored: ${bands.unscored || 0}`);
  }
  if (Array.isArray(summary.near_dup_clusters) && summary.near_dup_clusters.length > 0) {
    console.log(`Near-duplicate clusters among your pending items: ${summary.near_dup_clusters.length} (review these together)`);
  }

  if (groups.ready_to_publish.length > 0) {
    console.log(`\nREADY TO PUBLISH (${counts.ready_to_publish}) - sorted by quality:`);
    groups.ready_to_publish.forEach((r, i) => console.log(triageLine(r, i + 1, groups.ready_to_publish.length)));
  }
  if (groups.needs_score.length > 0) {
    console.log(`\nNEEDS A SCORE (${counts.needs_score}) - score or review individually:`);
    groups.needs_score.forEach((r, i) => console.log(triageLine(r, i + 1, groups.needs_score.length)));
  }
  if (groups.needs_your_eyes.length > 0) {
    console.log(`\nNEEDS YOUR EYES (${counts.needs_your_eyes}) - review individually:`);
    groups.needs_your_eyes.forEach((r, i) => {
      console.log(triageLine(r, i + 1, groups.needs_your_eyes.length));
      if (r.why) console.log(`     why: ${r.why}`);
    });
  }
  console.log('');
}

/**
 * The counted confirmation: print the exact selection, then require the
 * operator to type the exact count. Returns true ONLY on an exact match.
 * No flag bypasses this for approve paths.
 */
async function confirmByTypedCount(rows, actionLabel) {
  console.log(`\n${actionLabel} the following ${rows.length} learning(s):`);
  rows.forEach((r) => {
    const q = r.quality == null ? '--' : r.quality;
    console.log(`  ${r.id}  q=${q}  [${shortFlags(r)}]  ${r.title || '(no title)'}`);
  });
  console.log(`\nCount: ${rows.length}.`);
  const answer = await ask(`Type the count (${rows.length}) to confirm, anything else aborts: `);
  if (answer !== String(rows.length)) {
    console.log('Aborted. Nothing changed.');
    return false;
  }
  return true;
}

/** Run a confirmed selection through the bulk endpoint in chunks, with progress. */
async function runBulk({ apiKey, baseUrl, rows, decision, reason }) {
  const decisions = rows.map((r) => (decision === 'reject' && reason)
    ? { id: r.id, decision, reason }
    : { id: r.id, decision });
  const totals = await review.submitBulkChunked({
    apiKey,
    baseUrl,
    decisions,
    onChunk: ({ chunkIndex, chunkCount, response }) => {
      console.log(`  chunk ${chunkIndex + 1}/${chunkCount}: approved ${response.approved || 0}, kept private ${response.kept_private || 0}, rejected ${response.rejected || 0}, already done ${response.idempotent || 0}, failed ${response.failed || 0}`);
    },
  });
  for (const r of totals.results) {
    if (!r.ok) console.error(`  ! ${r.id || `entry #${r.index}`}: ${r.error || r.code}`);
  }
  return totals;
}

/** Parse --min-quality into an integer 0-20 (default DEFAULT_QUALITY_THRESHOLD). */
function parseMinQuality(flags) {
  if (flags['min-quality'] === undefined) return review.DEFAULT_QUALITY_THRESHOLD;
  const n = parseInt(flags['min-quality'], 10);
  if (!Number.isFinite(n) || n < 0 || n > 20) {
    console.error('Invalid --min-quality (expected an integer 0-20).');
    process.exit(1);
  }
  return n;
}

async function cmdReview(flags) {
  const creds = installer.readCredentials(HOME);
  if (!creds || !creds.api_key) {
    console.error('Not logged in. Run `npx auxilo setup` first.');
    process.exit(1);
  }
  const baseUrl = resolveBaseUrl(flags);
  const apiKey = creds.api_key;

  // ── Summary FIRST, always (triage before any decision surface) ────────────
  let summary;
  try {
    summary = await review.fetchPendingSummary({ apiKey, baseUrl });
  } catch (err) {
    console.error(`Could not fetch pending review summary: ${err.message}`);
    process.exit(1);
  }

  const rows = summary.items || [];
  if (rows.length === 0) {
    console.log('No learnings pending your review. Nothing to do.');
    return;
  }

  printSummaryTable(summary);

  // ── --list: summary only, no mutations ────────────────────────────────────
  if (flags.list) return;

  // ── --approve-ready: consume the server's ready_to_publish verdict.
  //    --approve-clean remains a hidden compatibility alias. A stricter
  //    threshold narrows the ready lane; a lower one explicitly reaches into
  //    needs_score. Typed-count confirmation, no bypass. ─────────────────────
  if (flags['approve-ready'] || flags['approve-clean']) {
    if (flags['approve-clean']) {
      console.log('Note: --approve-clean was renamed to --approve-ready; the old flag remains a compatibility alias.');
    }
    const minQuality = parseMinQuality(flags);
    const sel = review.selectForBulkApprove(rows, { mode: 'ready', minQuality });
    console.log(`approve-ready selection: ${sel.selected.length} of ${rows.length} pending (threshold: quality >= ${minQuality}).`);
    if (sel.excluded_private.length) {
      console.log(`  excluded ${sel.excluded_private.length} private-destined item(s); use [p]/--keep-private to keep them owner-only, or sanitize-promote them for public review.`);
    }
    if (minQuality < review.DEFAULT_QUALITY_THRESHOLD) {
      const approvableCount = Number.isFinite(summary.approvable_count)
        ? summary.approvable_count
        : review.selectForBulkApprove(rows, { mode: 'ready' }).selected.length;
      console.log(`WARNING: selection goes beyond the server's approvable verdict (approvable_count=${approvableCount}); including ${sel.included_beyond_verdict.length} items from needs_score.`);
    }
    if (sel.excluded_flagged.length) console.log(`  excluded ${sel.excluded_flagged.length} needs_your_eyes item(s) (review those individually).`);
    if (sel.excluded_low_quality.length) console.log(`  excluded ${sel.excluded_low_quality.length} below the quality threshold.`);
    if (sel.excluded_unscored.length) console.log(`  excluded ${sel.excluded_unscored.length} with no quality score (pass --min-quality 0 to include).`);
    if (sel.selected.length === 0) { console.log('Nothing qualifies. No changes made.'); return; }

    if (!await confirmByTypedCount(sel.selected, 'APPROVE and PUBLISH')) return;
    const totals = await runBulk({ apiKey, baseUrl, rows: sel.selected, decision: 'approve' });
    console.log(`\nDone. Approved ${totals.approved} (already approved earlier: ${totals.idempotent}, failed: ${totals.failed}). Items outside the selection stay pending.`);
    return;
  }

  // ── --all: bulk-approve everything EXCEPT needs_your_eyes items unless
  //    --include-flagged. Typed-count confirmation, no bypass. ───────────────
  if (flags.all) {
    const includeFlagged = flags['include-flagged'] === true;
    const sel = review.selectForBulkApprove(rows, { mode: 'all', includeFlagged });
    if (sel.excluded_private.length) {
      console.log(`Excluded ${sel.excluded_private.length} private-destined item(s); use [p]/--keep-private to keep them owner-only, or sanitize-promote them for public review.`);
    }
    if (includeFlagged && sel.selected.some((r) => review.reviewLane(r).lane === 'needs_your_eyes')) {
      console.log('WARNING: --include-flagged is set. This selection INCLUDES needs_your_eyes items (possible injection, sensitive content, process advice, account vocabulary, or near-duplicates). Approving publishes them publicly.');
    } else if (sel.excluded_flagged.length) {
      console.log(`Excluding ${sel.excluded_flagged.length} needs_your_eyes item(s) (pass --include-flagged to include them; safer to review those individually).`);
    }
    if (sel.selected.length === 0) { console.log('Nothing qualifies. No changes made.'); return; }

    if (!await confirmByTypedCount(sel.selected, 'APPROVE and PUBLISH')) return;
    const totals = await runBulk({ apiKey, baseUrl, rows: sel.selected, decision: 'approve' });
    console.log(`\nDone. Approved ${totals.approved} (already approved earlier: ${totals.idempotent}, failed: ${totals.failed}).`);
    return;
  }

  // ── --keep-private: finalize one explicit server lane as owner-only.
  //    Defaults to needs_your_eyes. Because this never publishes, --yes may
  //    bypass its counted confirmation; all approve paths retain the rail. ───
  if (flags['keep-private']) {
    let sel;
    try {
      sel = review.selectForKeepPrivate(rows, { lane: flags.lane });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    console.log(`keep-private selection: ${sel.selected.length} of ${rows.length} pending (lane: ${sel.lane}).`);
    for (const lane of ['ready_to_publish', 'needs_score', 'needs_your_eyes']) {
      const excluded = sel.excluded_by_lane[lane];
      if (excluded.length) console.log(`  excluded ${excluded.length} ${lane} item(s).`);
    }
    if (sel.selected.length === 0) { console.log('Nothing qualifies. No changes made.'); return; }
    const ok = flags.yes || await confirmByTypedCount(sel.selected, 'KEEP PRIVATE (owner-only, $0 recall)');
    if (!ok) return;
    const totals = await runBulk({ apiKey, baseUrl, rows: sel.selected, decision: 'keep_private' });
    console.log(`\nDone. Kept private ${totals.kept_private} of ${sel.selected.length} (already done earlier: ${totals.idempotent}, failed: ${totals.failed}).`);
    return;
  }

  // ── --all-reject: bulk reject the whole batch (incident escape hatch).
  //    Now batched through the bulk endpoint. --yes keeps its scripted-incident
  //    bypass because rejection is the SAFE direction (nothing goes public). ──
  if (flags['all-reject']) {
    const ok = flags.yes || await confirmByTypedCount(rows, 'REJECT (keep private)');
    if (!ok) return;
    const totals = await runBulk({ apiKey, baseUrl, rows, decision: 'reject' });
    console.log(`\nDone. Rejected ${totals.rejected} of ${rows.length} (already rejected earlier: ${totals.idempotent}, failed: ${totals.failed}).`);
    return;
  }

  // ── interactive rapid mode (default): y/n/s per item, one line each.
  //    [v] shows the full body before deciding; decisions post one at a time
  //    through the same single-item endpoints as before. ──────────────────────
  const bodies = new Map();
  try {
    let offset = 0;
    const pageLimit = 200;
    for (;;) {
      const page = await review.fetchPending({ apiKey, baseUrl, limit: pageLimit, offset });
      for (const l of page.learnings || []) bodies.set(l.id, l);
      offset += (page.learnings || []).length;
      if (!page.learnings || page.learnings.length === 0 || offset >= (page.pending_count || 0)) break;
    }
  } catch (err) {
    console.error(`Could not fetch pending bodies: ${err.message}`);
    process.exit(1);
  }

  console.log('Rapid review. Per item: [y] approve (goes public) · [n] reject · [p] keep private (owner-only, $0 recall) · [v] view · [s] skip · [q] quit\n');

  let approved = 0, keptPrivate = 0, rejected = 0, skipped = 0;
  const ordered = rows; // quality-desc server order; the summary above groups lanes
  for (let i = 0; i < ordered.length; i++) {
    const row = ordered[i];
    console.log(triageLine(row, i + 1, ordered.length));
    let choice = '';
    for (;;) {
      choice = (await ask('    [y/n/p/v/s/q]? ')).toLowerCase().slice(0, 1);
      if (!choice && readlineEnded) choice = 'q';
      if (choice === 'v') {
        const full = bodies.get(row.id);
        console.log('    ------------------------------------------------------------');
        console.log(full && full.body ? full.body : '(body not loaded)');
        if (full) {
          const flagStr = review.formatFlags(full);
          if (flagStr) console.log(`    ⚠ flags: ${flagStr}`);
        }
        console.log('    ------------------------------------------------------------');
        continue;
      }
      if (['y', 'n', 'p', 's', 'q'].includes(choice)) break;
    }
    if (choice === 'q') { console.log('  Stopping. Remaining items left pending.'); break; }
    if (choice === 's') { skipped += 1; continue; }
    try {
      if (choice === 'y') {
        await review.submitDecision({ apiKey, baseUrl, id: row.id, decision: 'approve' });
        approved += 1; console.log('    ✓ approved, now live');
      } else if (choice === 'p') {
        await review.submitDecision({ apiKey, baseUrl, id: row.id, decision: 'keep_private' });
        keptPrivate += 1; console.log('    ✓ kept private (owner-only)');
      } else {
        await review.submitDecision({ apiKey, baseUrl, id: row.id, decision: 'reject' });
        rejected += 1; console.log('    ✗ rejected, stays private');
      }
    } catch (err) {
      console.error(`    ! decision failed: ${err.message} (item left pending)`);
    }
  }

  console.log(`\nReview complete: approved ${approved}, kept private ${keptPrivate}, rejected ${rejected}, skipped ${skipped} of ${ordered.length}.`);
}

// ─── auxilo clean-lane (SPEC3-C1 standing consent; CLEAN-LANE-FLIP Phase A) ──
//
// GOV-3 (ratified language, Gate-A 2026-09-05): `grant` runs ONLY on a TTY and
// requires the human to TYPE the affirmation sentence verbatim — no --yes, no
// flag. The TTY gate + verbatim affirmation prevent ACCIDENTAL enrollment and
// create a hash-chained record of a DELIBERATE act by the credential holder.
// That record is EVIDENTIARY, not preventive: it is not a defense against a
// holder of the account's contribute-scoped key, who can reach the same routes
// directly. `status` / `revoke` are non-interactive.
// While the server flag is off the routes answer the catch-all 404 and every
// subcommand prints "not yet available" (exit 0).
//
// The sentence below MIRRORS lib/clean-lane.js CLEAN_LANE_AFFIRMATION. It is
// a literal here only because lib/clean-lane.js is server-side and not in the
// published package's files[]; test/clean-lane-phase-a.test.js pins the two
// byte-equal. The consent VERSION is never a client literal — it always comes
// from GET /account/clean-lane (consent_version_current).
const CLEAN_LANE_AFFIRMATION = 'I understand and choose auto-publish for qualifying extracted learnings.';

/**
 * EXTRACT-PER-CLIENT W1 PART C — `auxilo provider set`'s consent sentence.
 * SITE-PM-authored, verbatim. States: this is the builder's OWN key; where
 * it lives on disk and at what permission (~/.auxilo/providers.json, owner-
 * read-only); that Auxilo never receives it; what it is used for (drafting
 * learnings from the builder's own scrubbed sessions); that drafting sends
 * sessions to the builder's chosen provider under the builder's own account,
 * billed to that account and never to Auxilo; and how to remove it
 * (`auxilo provider clear`). `cmdProvider('set')` refuses to run at all
 * (reasonCode 'consent-sentence-missing') were this ever empty again — see
 * the test asserting that refusal — and, before ever printing this sentence
 * or storing anything, verifies any existing providers.json is actually
 * owner-read-only (reasonCode 'providers-file-mode-unsafe' if not), so the
 * "readable only by your user account" claim below is never printed false.
 */
const PROVIDER_KEY_CONSENT_SENTENCE = 'This key is yours. It stays on this machine in ~/.auxilo/providers.json, readable only by your user account, and Auxilo never receives it. It is used for one thing, drafting learnings from your own scrubbed sessions. Drafting sends those sessions to that provider under your own account, and any use is charged to that account, never to Auxilo. Run auxilo provider clear to remove it.';
const CLEAN_LANE_UNAVAILABLE = 'Auto-publish for clean learnings is not yet available on this account.';
// CLEAN-LANE-FLIP Phase B (legal; DRAFT pending Tyler): the full text of ToS
// §5.9.3(g) (plus its ratchet paragraph) prints ABOVE the affirmation prompt —
// counsel condition: the enrollment surface must show what "qualifying",
// revocation and the 7-day retraction mean, on both the dashboard and CLI
// paths. Same package-boundary reason as the affirmation: these literals are
// pinned byte-equal to docs/TERMS-OF-SERVICE.md and public/dashboard.html by
// test/clean-lane-phase-b-legal.test.js. Edit the Terms first, then mirror.
const CLEAN_LANE_TERMS_G = '(g) Standing publication consent (optional). Standing publication consent is off by default. A Builder may turn it on by an affirmative act — a dashboard setting, or a terminal command that requires typing the affirmation sentence shown on that screen. Auxilo records that act, the affirmation, and the consent-text version in a durable, hash-chained consent log, retained for the life of the account plus three (3) years under subsection (b). While it is on, a Learning submitted through Autonomous Extraction is published without separate per-item approval only if it passes every Platform screen and the quality threshold the Builder chose at activation. An account\'s first public Learning is never published this way; it is held for operator review under Section 4.1. Auxilo records each such publication in the Builder\'s dashboard and returns a notice in the response to the submission that produced it; each is retractable for seven (7) days under Section 5.9.4. If more than five percent (5%) of a Builder\'s Learnings published this way in any thirty (30) day period are retracted, Auxilo freezes the feature for that account until the Builder turns it on again. A Builder may turn it off at any time, effective immediately for later submissions; doing so does not affect Learnings already published. Subsection (c) applies in full to every Learning so published.';
const CLEAN_LANE_TERMS_G2 = 'The quality threshold in effect for a Builder is the one that Builder selected, and Auxilo will not broaden the conditions under which a Learning qualifies for publication under this subsection without recording a new consent; Auxilo may make those conditions stricter at any time.';
// CLEAN-LANE-FLIP Phase B (notice hardening): the no-email enrollment line —
// GOV-2 counsel draft §6 read #2 "move 3" — printed verbatim before the
// affirmation prompt on every enrollment surface. Byte-equal to the dashboard's
// #clean-lane-no-email-line (test/clean-lane-phase-b-notice.test.js).
const CLEAN_LANE_NO_EMAIL_LINE = 'You will not receive an email for these. Publications appear in your dashboard and in the response to the session that submitted them. The 7-day retraction window runs from publication.';
const CLEAN_LANE_MIN_QUALITY_MIN = 14;
const CLEAN_LANE_MIN_QUALITY_MAX = 20;
const CLEAN_LANE_MIN_QUALITY_DEFAULT = 16;

const CLEAN_LANE_EXPLAINER = `
Auto-publish clean learnings

When this is on, a learning is published without waiting for your review
only when all three hold: it was extracted by your own model, every server
screen came back clean, and its quality score is at or above the threshold
you set.

What is never auto-published: your first public learning (it waits for
operator review), anything a screen flags, anything below your threshold,
and anything after an auto-freeze. Every auto-published learning can be
retracted for 7 days (\`npx auxilo review\` or your dashboard).
`;

/** Word-wrap a single paragraph at `width` columns (whitespace only; no word is altered). */
function wrapForTerminal(paragraph, width = 78) {
  const lines = [];
  let line = '';
  for (const word of paragraph.split(' ')) {
    if (line && (line.length + 1 + word.length) > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map((l) => `  ${l}`).join('\n');
}

async function cleanLaneRequest({ apiKey, baseUrl, method, route, body }) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}${route}`;
  const headers = { 'X-API-Key': apiKey };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, ok: res.ok, data: data || {} };
}

function printCleanLaneStatus(data) {
  const active = data.clean_lane_active === true;
  console.log(`Auto-publish clean learnings: ${active ? 'ON' : 'OFF'}`);
  if (active) {
    console.log(`  since:            ${data.last_action_at || 'unknown'}`);
    console.log(`  quality at least: ${data.min_auto_publish_quality}`);
    console.log(`  consent version:  ${data.consent_version_recorded || data.consent_version_current}`);
  } else if (data.last_action === 'freeze') {
    console.log(`  FROZEN: ${data.freeze_reason || 'unknown reason'} (${data.last_action_at || 'unknown time'})`);
    console.log('  Nothing auto-publishes until you grant consent again: npx auxilo clean-lane grant');
  } else if (data.last_action === 'revoke') {
    console.log(`  revoked at: ${data.last_action_at || 'unknown'}`);
  } else if (data.last_action === 'grant') {
    console.log(`  a grant exists under consent version ${data.consent_version_recorded} but the current version is ${data.consent_version_current}; re-grant to re-activate.`);
  }
  console.log(`  current consent version: ${data.consent_version_current}`);
  // CLEAN-LANE-FLIP Phase B (notice hardening): the unread count, printed only
  // when > 0. Nothing here acknowledges it — only the dashboard button does.
  const unread = data.unacknowledged_publications;
  if (Number.isInteger(unread) && unread > 0) {
    console.log(`  auto-published since you last checked: ${unread} (review and acknowledge them in your dashboard)`);
  }
}

async function cmdCleanLane(flags) {
  const sub = process.argv[3];
  if (!['status', 'grant', 'revoke'].includes(sub)) {
    if (sub) console.error(`Unknown clean-lane subcommand: ${sub}`);
    usage('clean-lane');
    process.exit(sub ? 1 : 0);
  }

  // The TTY gate runs BEFORE credentials and BEFORE any network call: a
  // piped or scripted stdin can never reach the grant.
  if (sub === 'grant' && !process.stdin.isTTY) {
    console.error('auxilo clean-lane grant must be run by a person in an interactive terminal. It does not accept piped input, and there is no flag that skips typing the consent sentence.');
    process.exit(1);
  }

  const creds = installer.readCredentials(HOME);
  if (!creds || !creds.api_key) {
    console.error('Not logged in. Run `npx auxilo setup` first.');
    process.exit(1);
  }
  const baseUrl = resolveBaseUrl(flags);
  const apiKey = creds.api_key;

  let status;
  try {
    status = await cleanLaneRequest({ apiKey, baseUrl, method: 'GET', route: '/account/clean-lane' });
  } catch (err) {
    console.error(`Could not reach the server: ${err.message}`);
    process.exit(1);
  }
  if (status.status === 404) {
    console.log(CLEAN_LANE_UNAVAILABLE);
    return;
  }
  if (!status.ok) {
    console.error(`Could not read auto-publish status (HTTP ${status.status}): ${status.data.error || 'unknown error'}`);
    process.exit(1);
  }

  if (sub === 'status') {
    printCleanLaneStatus(status.data);
    return;
  }

  if (sub === 'revoke') {
    let res;
    try {
      res = await cleanLaneRequest({ apiKey, baseUrl, method: 'POST', route: '/account/clean-lane/revoke', body: {} });
    } catch (err) {
      console.error(`Could not reach the server: ${err.message}`);
      process.exit(1);
    }
    if (res.status === 404) { console.log(CLEAN_LANE_UNAVAILABLE); return; }
    if (!res.ok) {
      console.error(`Revoke failed (HTTP ${res.status}): ${res.data.error || 'unknown error'}`);
      process.exit(1);
    }
    console.log(res.data.message || 'Auto-publish is now OFF.');
    return;
  }

  // ── grant: explainer → threshold → the sentence, typed verbatim ──────────
  console.log(CLEAN_LANE_EXPLAINER);
  if (status.data.clean_lane_active === true) {
    console.log(`Auto-publish is already ON (quality at least ${status.data.min_auto_publish_quality}, since ${status.data.last_action_at}). Granting again records a fresh consent row with the threshold you choose now.\n`);
  } else if (status.data.last_action === 'freeze') {
    console.log(`Auto-publish is FROZEN: ${status.data.freeze_reason || 'unknown reason'}. Granting again re-activates it.\n`);
  }

  let minQuality = CLEAN_LANE_MIN_QUALITY_DEFAULT;
  for (;;) {
    const answer = await ask(`Publish only when the quality score is at least [${CLEAN_LANE_MIN_QUALITY_MIN}-${CLEAN_LANE_MIN_QUALITY_MAX}, default ${CLEAN_LANE_MIN_QUALITY_DEFAULT}]: `);
    if (answer === '') break;
    const n = parseInt(answer, 10);
    if (Number.isInteger(n) && String(n) === answer && n >= CLEAN_LANE_MIN_QUALITY_MIN && n <= CLEAN_LANE_MIN_QUALITY_MAX) {
      minQuality = n;
      break;
    }
    if (readlineEnded) { console.log('Aborted. Nothing changed.'); return; }
    console.log(`Enter a whole number from ${CLEAN_LANE_MIN_QUALITY_MIN} to ${CLEAN_LANE_MIN_QUALITY_MAX}.`);
  }

  // The consent text itself, verbatim (word-wrapped for the terminal only), before the sentence.
  console.log('\nTerms of Service, Section 5.9.3(g): the consent you are giving\n');
  console.log(wrapForTerminal(CLEAN_LANE_TERMS_G));
  console.log('');
  console.log(wrapForTerminal(CLEAN_LANE_TERMS_G2));
  console.log(`\nFull Terms: ${baseUrl}/terms`);
  // The no-email line, verbatim, directly before the affirmation prompt.
  console.log(`\n${wrapForTerminal(CLEAN_LANE_NO_EMAIL_LINE)}`);
  console.log('\nTo turn on auto-publish, type this sentence exactly as written, then press Enter:');
  console.log(`\n  ${CLEAN_LANE_AFFIRMATION}\n`);
  const typed = await ask('> ');
  if (typed !== CLEAN_LANE_AFFIRMATION) {
    console.log('The sentence did not match. Aborted. Nothing changed.');
    return;
  }

  let res;
  try {
    res = await cleanLaneRequest({
      apiKey,
      baseUrl,
      method: 'POST',
      route: '/account/clean-lane/grant',
      body: {
        consent_version: status.data.consent_version_current,
        agree: true,
        affirmation: typed, // what the human typed, transmitted verbatim
        min_auto_publish_quality: minQuality,
      },
    });
  } catch (err) {
    console.error(`Could not reach the server: ${err.message}`);
    process.exit(1);
  }
  if (res.status === 404) { console.log(CLEAN_LANE_UNAVAILABLE); return; }
  if (res.status === 409) {
    console.error('The consent version changed on the server while you were reading. Run `npx auxilo clean-lane grant` again.');
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Grant failed (HTTP ${res.status}): ${res.data.error || 'unknown error'}`);
    process.exit(1);
  }
  console.log(`\n${res.data.message || 'Auto-publish is now ON.'}`);
  console.log(`  quality at least: ${res.data.min_auto_publish_quality}`);
  console.log(`  consent version:  ${res.data.consent_version}`);
  console.log('  Turn it off any time: npx auxilo clean-lane revoke');
}

// ─── auxilo provider (EXTRACT-PER-CLIENT W1 PART C: BYO provider key) ───────
//
// Mirrors cmdCleanLane's grant discipline exactly: `set` runs ONLY on a TTY,
// refuses piped input, and requires typing the consent sentence verbatim —
// no confirmation flag, no bypass. Unlike clean-lane, nothing here ever reaches
// the Auxilo server: the key is the builder's own, read from a hidden
// prompt (never argv, never env), and written straight to
// ~/.auxilo/providers.json (0600) via scripts/providers/byo-key.js.
//
// PROVIDER_KEY_CONSENT_SENTENCE is a SITE-PM string slot (see the module
// comment on its declaration below) — `set` refuses to run at all while it
// is empty, with reasonCode 'consent-sentence-missing'. This keeps the path
// disabled end-to-end until that copy is written, rather than shipping a
// silent placeholder sentence nobody actually reviewed.
const PROVIDER_VENDORS = ['openai', 'anthropic', 'gemini'];

/**
 * PROVIDER_KEY_CONSENT_SENTENCE promises the stored key is "readable only
 * by your user account." Before `set` ever prints that sentence, or stores
 * anything, verify the promise is actually true of any providers.json
 * already on disk. Owner-read-only means no group/other bits at all
 * (mode & 0o077 === 0); a file that fails this predates this discipline
 * (e.g. survived an umask that widened it) and must be fixed or removed
 * before `set` is allowed to run — never fail open on a false claim.
 * No file yet is not unsafe: writeByoConfig always writes 0600 itself.
 */
/**
 * (EXTRACT-PER-CLIENT W1 FIX, GOV-3 should-fix item 10): a stat error other
 * than ENOENT (e.g. EACCES) now fails CLOSED — returns true (unsafe) — the
 * same "cannot verify, so don't trust it" discipline
 * byo-key.js's own isProvidersFileModeUnsafe documents and follows. The old
 * rethrow here let a raw fs error propagate out of cmdProvider uncaught,
 * printing whatever bubbled to run()'s generic catch instead of a clean
 * reason. Never throws now.
 */
function providersFileModeUnsafe(target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    return true; // cannot verify permissions — fail closed, not open
  }
  return (stat.mode & 0o077) !== 0;
}

async function cmdProvider(flags) {
  const sub = process.argv[3];
  if (!['status', 'set', 'clear'].includes(sub)) {
    if (sub) console.error(`Unknown provider subcommand: ${sub}`);
    usage('provider');
    process.exit(sub ? 1 : 0);
  }

  if (sub === 'status') {
    const config = byoKeyProvider.readByoConfig();
    if (!config) {
      console.log('BYO provider key: none configured');
      return;
    }
    console.log(`BYO provider key: configured (vendor: ${config.provider}, model: ${config.model}, key: present)`);
    return;
  }

  if (sub === 'clear') {
    // clearProvidersFile() never throws (GOV-3 should-fix item 10) — every
    // outcome is a plain string, handled explicitly below rather than
    // falling into the generic success message for a case that isn't one.
    const result = byoKeyProvider.clearProvidersFile();
    if (result === 'removed-file') {
      console.log('✓ ~/.auxilo/providers.json removed (nothing left to keep).');
    } else if (result === 'removed-byo') {
      console.log('✓ BYO provider key cleared. providers.json kept (your auto-detected provider selection, if any, is unchanged).');
    } else if (result === 'unreadable') {
      console.error('auxilo provider clear could not read ~/.auxilo/providers.json (reasonCode: providers-file-unreadable). Check its permissions and try again.');
      process.exit(1);
    } else if (result === 'unresolved') {
      console.error('auxilo provider clear could not resolve your home directory (reasonCode: provider-home-unresolved).');
      process.exit(1);
    } else {
      console.log('✓ Nothing to remove (no BYO provider key configured).');
    }
    return;
  }

  // sub === 'set' below.
  if (PROVIDER_KEY_CONSENT_SENTENCE === '') {
    console.error('auxilo provider set is not available yet: the operator has not configured the consent sentence for this build (reasonCode: consent-sentence-missing).');
    process.exit(1);
  }

  // Fail closed BEFORE printing the sentence or storing anything: an
  // existing providers.json that is not owner-read-only would make the
  // sentence's "readable only by your user account" claim false.
  if (providersFileModeUnsafe(byoKeyProvider.DEFAULT_PROVIDERS_STATE_PATH)) {
    console.error('auxilo provider set refuses to continue: ~/.auxilo/providers.json exists and is not owner-read-only, so this build cannot truthfully make the consent promise (reasonCode: providers-file-mode-unsafe). Fix its permissions (chmod 600 ~/.auxilo/providers.json) or remove the file, then try again.');
    process.exit(1);
  }

  // The TTY gate runs BEFORE any prompt: a piped or scripted stdin can never
  // reach the hidden key prompt or the typed affirmation.
  if (!process.stdin.isTTY) {
    console.error('auxilo provider set must be run by a person in an interactive terminal. It does not accept piped input, and there is no flag that skips typing the consent sentence or the key.');
    process.exit(1);
  }

  let vendor = String(flags.vendor || '').toLowerCase();
  while (!PROVIDER_VENDORS.includes(vendor)) {
    vendor = (await ask(`Vendor [${PROVIDER_VENDORS.join('|')}]: `)).toLowerCase();
    if (readlineEnded) { console.log('Aborted. Nothing changed.'); return; }
  }

  // GOV-3 item 3: base_url must be https:// — a plaintext endpoint would
  // send the transcript, and for two of the three vendors the key itself,
  // in cleartext. Checked here (set time) AND again at read time inside
  // byo-key.js's runModel/detect (reasonCode provider-base-url-insecure) —
  // a hand-edited providers.json can't bypass either.
  let baseUrl = flags['base-url'] ? String(flags['base-url']) : '';
  if (baseUrl && byoKeyProvider.isBaseUrlInsecure(baseUrl)) {
    console.error(`auxilo provider set refuses --base-url "${baseUrl}": it must be https:// (reasonCode: provider-base-url-insecure).`);
    process.exit(1);
  }
  if (!flags['base-url']) {
    for (;;) {
      baseUrl = await ask(`Base URL (optional — press Enter for the ${vendor} default; must be https:// if given): `);
      if (readlineEnded) { console.log('Aborted. Nothing changed.'); return; }
      if (!baseUrl || !byoKeyProvider.isBaseUrlInsecure(baseUrl)) break;
      console.log(`"${baseUrl}" is not https:// — try again, or press Enter for the ${vendor} default.`);
    }
  }

  let model = flags.model ? String(flags.model) : '';
  while (!model) {
    model = await ask('Model (e.g. gpt-4o-mini, claude-sonnet-4-5, gemini-2.5-flash): ');
    if (readlineEnded) { console.log('Aborted. Nothing changed.'); return; }
  }

  // Printed in FULL, word-wrapped to the terminal width — never truncated —
  // before the (hidden) key prompt further below.
  console.log(`\n${wrapForTerminal(PROVIDER_KEY_CONSENT_SENTENCE)}\n`);
  console.log('To continue, type this sentence exactly as written, then press Enter:');
  console.log(`\n${wrapForTerminal(PROVIDER_KEY_CONSENT_SENTENCE)}\n`);
  const typed = await ask('> ');
  if (typed !== PROVIDER_KEY_CONSENT_SENTENCE) {
    console.log('The sentence did not match. Aborted. Nothing changed.');
    return;
  }

  const apiKey = await askHidden('API key (input hidden): ');
  if (readlineEnded || !apiKey) {
    console.log('Aborted. Nothing changed.');
    return;
  }

  // writeByoConfig throws ONLY on an unresolved home directory (GOV-3 item
  // 13) — caught here so that reaches a clean reason + exit(1), never a raw
  // stack (should-fix item 10), matching the fail-closed contract every
  // other providers.json entry point in this file now follows.
  let written;
  try {
    written = byoKeyProvider.writeByoConfig({
      provider: vendor,
      ...(baseUrl && { base_url: baseUrl }),
      model,
      api_key: apiKey,
    });
  } catch (err) {
    if (err && err.reasonCode === 'provider-home-unresolved') {
      console.error(`auxilo provider set could not resolve your home directory (reasonCode: provider-home-unresolved). ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  console.log(`\n✓ Saved to ${written} (mode 0600). This machine will use your own ${vendor} key for extraction when no earlier provider in the order is available.`);
}

// ─── Entry point ────────────────────────────────────────────────────────────

function usage(command) {
  const blocks = {
    setup: `Usage: auxilo setup [--re-auth] [--base-url <url>]

Interactively detect clients, register Auxilo, sign in, install the optional
extraction runner and SessionEnd hook, and record the extraction choice.`,
    init: `Usage: auxilo init [--scope <read|earnings-read|contribute>] [--label <name>]
                   [--env-file <path>] [--save] [--json] [--no-browser]
                   [--base-url <url>]

Mint a scoped API key for CI or a second machine without running full setup.`,
    status: `Usage: auxilo status

Show detected clients, auth, extraction mode, kill switch, SessionEnd hook,
last sweep, and pending queue depth.`,
    review: `Usage: auxilo review [flags]

Render YOUR pending-review learnings in three server-defined lanes:
Ready to publish, Needs a score, and Needs your eyes.

Flags:
  --list            show the three-lane summary only; make no changes
  --approve-ready   select the server's ready_to_publish lane (default quality
                    floor 14; a higher --min-quality narrows it, while a lower
                    value explicitly reaches into needs_score)
  --min-quality N   quality threshold for --approve-ready (0-20)
  --all             approve everything except needs_your_eyes items
  --include-flagged include needs_your_eyes with --all
  --keep-private    keep one lane owner-only (default: needs_your_eyes)
  --lane <lane>     lane for --keep-private: ready_to_publish, needs_score,
                    or needs_your_eyes
  --all-reject      reject the whole batch [--yes for scripted incident use]
  --yes             bypass count only for --keep-private or --all-reject
  --base-url <url>

Every bulk path prints the exact list and requires typing its count. Approval
never accepts --yes. Private-destined rows are excluded from approval; keep
them private or sanitize-promote a corrected replacement.`,
    disable: `Usage: auxilo disable [--base-url <url>]

Disable background extraction locally and optionally revoke server consent.`,
    'clean-lane': `Usage: auxilo clean-lane <status|grant|revoke> [--base-url <url>]

Auto-publish clean learnings (standing consent). While the feature is not yet
available on your account every subcommand says so and changes nothing.

  status   Show whether auto-publish is on, the quality threshold, and the
           consent version.
  grant    Turn it on. Interactive ONLY: you choose the threshold and then
           TYPE the consent sentence exactly. No flag or piped input can do
           this for you.
  revoke   Turn it off (one step, no confirmation). Already-published
           learnings keep their 7-day retraction window.`,
    provider: `Usage: auxilo provider <status|set|clear>

Configure a bring-your-own (BYO) model provider key for local extraction —
used only when no earlier provider in the fixed order (claude-code,
codex-cli) is available. Auxilo never sees or bills this key.

  status   Show the configured vendor and model (never the key itself).
  set      Configure a vendor, model, and key. Interactive ONLY: the key is
           read from a hidden prompt (never a flag, never an env var), and
           you must type the consent sentence exactly. No flag skips this.
  clear    Remove your BYO key. Keeps your auto-detected provider selection
           (\`selected\`), if any — only deletes the file outright when
           nothing but the key was in it.`,
  };
  if (command && blocks[command]) {
    console.log(`\n${blocks[command]}\n`);
    return;
  }
  console.log(`
Usage: auxilo <command>

Commands:
  setup     Interactive install: client detection, MCP registration,
            device-code login, extraction runner + hook, consent.
            Flags: --re-auth, --base-url <url>
  init      Mint a SCOPED API key for CI or a second machine — no full setup,
            no prompts (device-code approval in a browser is the only human
            step). Does NOT touch ~/.auxilo/credentials.json unless --save.
            Flags:
              --scope <s>       read | earnings-read | contribute (default:
                                contribute; admin is never issuable)
              --label <name>    key label (default: init-<hostname>)
              --env-file <path> write AUXILO_API_KEY to an env file (0600,
                                updated in place) instead of printing the key
              --save            also write ~/.auxilo/credentials.json
              --json            machine-readable result on stdout
              --no-browser      don't try to open the approval URL
              --base-url <url>
  status    Show install/auth/extraction status.
  review    Review YOUR pending-review learnings (from background extraction)
            and approve/reject before anything goes public. Default: triage
            summary first in the server's Ready to publish / Needs a score /
            Needs your eyes lanes, then rapid y/n/s review.
            Flags:
              --list            summary table only, no changes
              --approve-ready   select the server's ready_to_publish lane
                                (default floor 14; tune with --min-quality N).
                                Prints the exact list, then requires its count.
              --all             bulk-approve everything EXCEPT needs_your_eyes
                                (add --include-flagged to include that lane).
                                Same typed-count confirmation.
              --min-quality N   quality threshold for --approve-ready (0-20)
              --keep-private    keep needs_your_eyes owner-only by default
              --lane <lane>     choose a server lane for --keep-private
              --all-reject      reject the whole batch [--yes for scripted
                                incident response; rejects stay private]
              --base-url <url>
            Bulk approvals ALWAYS require typing the exact count. No flag
            skips that step.
  disable   Turn off background extraction (local kill-switch; optional
            server-side consent revoke).
  clean-lane <status|grant|revoke>
            Auto-publish clean learnings (standing consent). grant is
            interactive only: you type the consent sentence yourself.
  provider <status|set|clear>
            Configure a bring-your-own model provider key for local
            extraction. set is interactive only: hidden key prompt, typed
            consent sentence.

Docs: https://auxilo.io · API: ${installer.DEFAULT_BASE_URL}
`);
}

async function main() {
  const cmd = process.argv[2];
  const subcommandHelp = ['help', '--help', '-h'].includes(process.argv[3]);
  if (['setup', 'init', 'status', 'review', 'disable', 'clean-lane', 'provider'].includes(cmd) && subcommandHelp) {
    return usage(cmd);
  }
  const flags = parseFlags(process.argv);
  switch (cmd) {
    case 'setup': return cmdSetup(flags);
    case 'init': return cmdInit(flags);
    case 'status': return cmdStatus(flags);
    case 'review': return cmdReview(flags);
    case 'disable': return cmdDisable(flags);
    case 'clean-lane': return cmdCleanLane(flags);
    case 'provider': return cmdProvider(flags);
    case 'help': case '--help': case '-h': case undefined: return usage();
    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
      process.exit(1);
  }
}

/** Run the CLI: used by require.main below AND by mcp-server.js delegation
 *  (LW-17: `npx auxilo-mcp setup` — the `auxilo` bin alias is unreachable via
 *  npx until the `auxilo` npm package name is claimed). */
function run() {
  main().then(() => {
    closeRl(); // an open readline interface keeps the process alive
  }).catch((err) => {
    closeRl();
    console.error(`auxilo: ${err.message}`);
    process.exit(1);
  });
}

if (require.main === module) {
  run();
}

module.exports = {
  parseFlags,
  runnerSkewLine,
  extractionProviderLine,
  resolveBaseUrl,
  shortFlags,
  groupSummaryRows,
  printSummaryTable,
  usage,
  run,
  CLEAN_LANE_AFFIRMATION,
  CLEAN_LANE_UNAVAILABLE,
  CLEAN_LANE_TERMS_G,
  CLEAN_LANE_TERMS_G2,
  CLEAN_LANE_NO_EMAIL_LINE,
  wrapForTerminal,
  PROVIDER_KEY_CONSENT_SENTENCE,
  CLI_CLEAN_LANE_CALIBRATED_PROVIDERS,
  STATUS_WORTHY_SKIP_REASON_CODES,
  extractionSkipReasonLine,
  cmdProvider,
  providersFileModeUnsafe,
};
