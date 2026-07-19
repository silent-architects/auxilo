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

const os = require('os');
const path = require('path');
const readline = require('readline');
const { exec } = require('child_process');
const installer = require('../lib/installer.js');
const review = require('../lib/review.js');

const HOME = os.homedir();

// ─── Prompt helpers ─────────────────────────────────────────────────────────

// LW-17: ONE shared readline interface for the whole run. Creating a fresh
// interface per question loses any input readline already buffered when the
// previous interface closed — with piped/scripted stdin the answer to
// question N+1 arrives with question N's buffer and the next prompt hangs
// on EOF (the 0.8.1 consent step silently never completed).
let sharedRl = null;
function getRl() {
  if (!sharedRl) {
    sharedRl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return sharedRl;
}
function closeRl() {
  if (sharedRl) { sharedRl.close(); sharedRl = null; }
}

function ask(question) {
  return new Promise((resolve) => {
    getRl().question(question, (answer) => resolve(answer.trim()));
  });
}

/** Yes/no prompt. defaultYes=false → consent-grade default-No (spec §LW-12 step 5). */
async function askYesNo(question, defaultYes = false) {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const answer = (await ask(question + suffix)).toLowerCase();
  if (answer === '') return defaultYes;
  return answer === 'y' || answer === 'yes';
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
    • EXTRACTS reusable learnings locally using your own claude CLI (your
      existing subscription). For this step your transcript is processed
      only by your own model provider the same way your normal sessions
      are, and is never sent to Auxilo, raw or scrubbed.
    • UPLOADS only the finished learning drafts (title, body, category,
      tags, task context, outcome) to Auxilo (${'POST /learn'}). A draft
      that passes every screen publishes to the marketplace immediately
      under your account, and you can retract it for 7 days. A draft that
      any screen flags (sensitive, duplicate, uncertain quality) waits in
      your private queue for \`auxilo review\`. Manual mode (approve first,
      for everything) is available in your account settings. You earn 70%
      of sales.
  You can stop any time with \`auxilo disable\` (local kill-switch) and review
  every run in ~/.auxilo/extract.log. Saying No installs the MCP server only —
  no session-end capture hook is written into any client config unless you say
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
  console.log(`SessionEnd hook: ${s.hookInstalled ? 'installed' : 'not installed'}${s.hookRegistered ? ', registered in Claude Code settings' : ''}`);
  for (const c of s.clients.filter((c) => c.captureHook)) {
    console.log(`Capture hooks: ${c.name} (${c.captureEvent}, ${c.captureRegistered ? 'registered' : 'not registered'})`);
  }
  console.log(`Last extraction sweep: ${s.lastSweep || 'never'}`);
  console.log(`Pending upload queue: ${s.pendingCount} file(s)\n`);
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
// (quality desc, clean before flagged), with bulk modes that batch through
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

/** Short flag codes for a summary row: 'clean' or e.g. 'inj+sens'. */
function shortFlags(row) {
  if (row.screens_passed) return 'clean';
  const map = { injection: 'inj', content_sensitivity: 'sens', near_duplicate: 'dup' };
  return (row.flags || []).map((f) => map[f] || f).join('+') || 'flagged';
}

/** One compact triage line (shared by the table and rapid mode). */
function triageLine(row, n, total) {
  const q = row.quality == null ? ' --' : String(row.quality).padStart(3);
  return `  ${String(n).padStart(String(total).length)}. q=${q}  ${fit(shortFlags(row), 9)} ${fit(row.category || '', 20)} ${fit(row.title || '(no title)', 52)}`;
}

/** Print the triage summary: counts, then clean rows, then flagged rows. */
function printSummaryTable(summary) {
  const items = summary.items || [];
  const clean = items.filter((r) => r.screens_passed);
  const flagged = items.filter((r) => !r.screens_passed);

  console.log(`\n${summary.pending_count} learning(s) pending your review: ${clean.length} passed every platform screen, ${flagged.length} flagged.`);
  const bands = summary.counts && summary.counts.by_quality_band;
  if (bands) {
    console.log(`Quality bands: 18-20: ${bands['18-20'] || 0} · 14-17: ${bands['14-17'] || 0} · 10-13: ${bands['10-13'] || 0} · below 10: ${bands.below_10 || 0} · unscored: ${bands.unscored || 0}`);
  }
  if (Array.isArray(summary.near_dup_clusters) && summary.near_dup_clusters.length > 0) {
    console.log(`Near-duplicate clusters among your pending items: ${summary.near_dup_clusters.length} (review these together)`);
  }

  if (clean.length > 0) {
    console.log(`\nCLEAN (passed every screen) - sorted by quality:`);
    clean.forEach((r, i) => console.log(triageLine(r, i + 1, clean.length)));
  }
  if (flagged.length > 0) {
    console.log(`\nFLAGGED (a platform screen raised a signal) - review individually:`);
    flagged.forEach((r, i) => console.log(triageLine(r, i + 1, flagged.length)));
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
      console.log(`  chunk ${chunkIndex + 1}/${chunkCount}: approved ${response.approved || 0}, rejected ${response.rejected || 0}, already done ${response.idempotent || 0}, failed ${response.failed || 0}`);
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

  // ── --approve-clean: bulk-approve items that passed EVERY platform screen
  //    AND clear the quality threshold. Typed-count confirmation, no bypass. ──
  if (flags['approve-clean']) {
    const minQuality = parseMinQuality(flags);
    const sel = review.selectForBulkApprove(rows, { mode: 'clean', minQuality });
    console.log(`approve-clean selection: ${sel.selected.length} of ${rows.length} pending (threshold: quality >= ${minQuality}).`);
    if (sel.excluded_flagged.length) console.log(`  excluded ${sel.excluded_flagged.length} screen-flagged item(s) (review those individually).`);
    if (sel.excluded_low_quality.length) console.log(`  excluded ${sel.excluded_low_quality.length} below the quality threshold.`);
    if (sel.excluded_unscored.length) console.log(`  excluded ${sel.excluded_unscored.length} with no quality score (pass --min-quality 0 to include).`);
    if (sel.selected.length === 0) { console.log('Nothing qualifies. No changes made.'); return; }

    if (!await confirmByTypedCount(sel.selected, 'APPROVE and PUBLISH')) return;
    const totals = await runBulk({ apiKey, baseUrl, rows: sel.selected, decision: 'approve' });
    console.log(`\nDone. Approved ${totals.approved} (already approved earlier: ${totals.idempotent}, failed: ${totals.failed}). Flagged and below-threshold items stay pending.`);
    return;
  }

  // ── --all: bulk-approve everything EXCEPT screen-flagged items unless
  //    --include-flagged. Typed-count confirmation, no bypass. ───────────────
  if (flags.all) {
    const includeFlagged = flags['include-flagged'] === true;
    const sel = review.selectForBulkApprove(rows, { mode: 'all', includeFlagged });
    if (includeFlagged && sel.selected.some((r) => !r.screens_passed)) {
      console.log('WARNING: --include-flagged is set. This selection INCLUDES items a platform screen flagged (possible injection, sensitive content, or near-duplicates). Approving publishes them publicly.');
    } else if (sel.excluded_flagged.length) {
      console.log(`Excluding ${sel.excluded_flagged.length} screen-flagged item(s) (pass --include-flagged to include them; safer to review those individually).`);
    }
    if (sel.selected.length === 0) { console.log('Nothing qualifies. No changes made.'); return; }

    if (!await confirmByTypedCount(sel.selected, 'APPROVE and PUBLISH')) return;
    const totals = await runBulk({ apiKey, baseUrl, rows: sel.selected, decision: 'approve' });
    console.log(`\nDone. Approved ${totals.approved} (already approved earlier: ${totals.idempotent}, failed: ${totals.failed}).`);
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

  console.log('Rapid review. Per item: [y] approve (goes live) · [n] reject (stays private) · [v] view full body · [s] skip · [q] quit\n');

  let approved = 0, rejected = 0, skipped = 0;
  const ordered = rows; // clean-first, quality desc (server order preserved by printSummaryTable groups)
  for (let i = 0; i < ordered.length; i++) {
    const row = ordered[i];
    console.log(triageLine(row, i + 1, ordered.length));
    let choice = '';
    for (;;) {
      choice = (await ask('    [y/n/v/s/q]? ')).toLowerCase().slice(0, 1);
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
      if (['y', 'n', 's', 'q'].includes(choice)) break;
    }
    if (choice === 'q') { console.log('  Stopping. Remaining items left pending.'); break; }
    if (choice === 's') { skipped += 1; continue; }
    try {
      if (choice === 'y') {
        await review.submitDecision({ apiKey, baseUrl, id: row.id, decision: 'approve' });
        approved += 1; console.log('    ✓ approved, now live');
      } else {
        await review.submitDecision({ apiKey, baseUrl, id: row.id, decision: 'reject' });
        rejected += 1; console.log('    ✗ rejected, stays private');
      }
    } catch (err) {
      console.error(`    ! decision failed: ${err.message} (item left pending)`);
    }
  }

  console.log(`\nReview complete: approved ${approved}, rejected ${rejected}, skipped ${skipped} of ${ordered.length}.`);
}

// ─── Entry point ────────────────────────────────────────────────────────────

function usage() {
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
            summary table first (quality desc, clean vs flagged), then rapid
            y/n/s review.
            Flags:
              --list            summary table only, no changes
              --approve-clean   bulk-approve items that passed EVERY platform
                                screen AND quality >= threshold (default 14;
                                tune with --min-quality N). Prints the exact
                                list, then requires typing the count.
              --all             bulk-approve everything EXCEPT screen-flagged
                                items (add --include-flagged to include them).
                                Same typed-count confirmation.
              --min-quality N   quality threshold for --approve-clean (0-20)
              --all-reject      reject the whole batch [--yes for scripted
                                incident response; rejects stay private]
              --base-url <url>
            Bulk approvals ALWAYS require typing the exact count. No flag
            skips that step.
  disable   Turn off background extraction (local kill-switch; optional
            server-side consent revoke).

Docs: https://auxilo.io · API: ${installer.DEFAULT_BASE_URL}
`);
}

async function main() {
  const cmd = process.argv[2];
  const flags = parseFlags(process.argv);
  switch (cmd) {
    case 'setup': return cmdSetup(flags);
    case 'init': return cmdInit(flags);
    case 'status': return cmdStatus(flags);
    case 'review': return cmdReview(flags);
    case 'disable': return cmdDisable(flags);
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

module.exports = { parseFlags, resolveBaseUrl, run };
