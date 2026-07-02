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
    • READS the session transcript from your machine,
    • SCRUBS it locally (sensitivity filter: API keys, tokens, emails, PII —
      redacted BEFORE anything leaves your machine),
    • UPLOADS only the scrubbed transcript to Auxilo (${'POST /extract'}),
      where reusable learnings are extracted, quality-gated, moderated, and
      published to the marketplace under your account. You earn 70% of sales.
  You can stop any time with \`auxilo disable\` (local kill-switch) and review
  every run in ~/.auxilo/extract.log. Saying No installs the MCP server only.
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

  // 4. Runner install + Claude Code hook --------------------------------------
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

  // 5. Explicit consent (default No) ------------------------------------------
  console.log(CONSENT_TEXT);
  const consented = await askYesNo('  Enable background extraction?', false);
  if (consented) {
    try {
      await installer.recordConsent({ action: 'grant', apiKey: creds.api_key, baseUrl });
      installer.enableSentinel(HOME);
      console.log('  ✓ Consent recorded; background extraction ENABLED (~/.auxilo/autonomous-enabled)');
    } catch (err) {
      console.error(`  ✗ Could not record consent on server: ${err.message}`);
      console.error('    Background extraction NOT enabled (no sentinel created). Re-run `auxilo setup` to retry.');
    }
  } else {
    console.log('  ✓ Background extraction left OFF (MCP-only install). Enable later by re-running `auxilo setup`.');
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

/** Print one candidate's full detail for the interactive reviewer. */
function printCandidate(l, n, total) {
  console.log(`\n──────────────────────────────────────────────────────────────`);
  console.log(`[${n}/${total}] ${l.title}`);
  console.log(`  id:       ${l.id}`);
  console.log(`  category: ${l.category}${l.outcome ? `   outcome: ${l.outcome}` : ''}`);
  if (l.tags && l.tags.length) console.log(`  tags:     ${l.tags.join(', ')}`);
  if (l.created_at) console.log(`  created:  ${l.created_at}`);
  const flags = review.formatFlags(l);
  if (flags) console.log(`  ⚠ flags:  ${flags}`);
  console.log(`  ----------------------------------------------------------`);
  console.log(l.body || '(no body)');
  console.log(`  ----------------------------------------------------------`);
}

async function cmdReview(flags) {
  const creds = installer.readCredentials(HOME);
  if (!creds || !creds.api_key) {
    console.error('Not logged in. Run `npx auxilo setup` first.');
    process.exit(1);
  }
  const baseUrl = resolveBaseUrl(flags);
  const apiKey = creds.api_key;

  let res;
  try {
    res = await review.fetchPending({ apiKey, baseUrl, limit: 200 });
  } catch (err) {
    console.error(`Could not fetch pending review queue: ${err.message}`);
    process.exit(1);
  }

  const items = res.learnings || [];
  const total = res.pending_count != null ? res.pending_count : items.length;

  if (items.length === 0) {
    console.log('No learnings pending your review. Nothing to do.');
    return;
  }

  // ── --list: non-interactive inspection, no mutations ──────────────────────
  if (flags.list) {
    console.log(`\n${total} learning(s) pending your review:\n`);
    items.forEach((l, i) => {
      const flagStr = review.formatFlags(l);
      console.log(`  ${i + 1}. ${l.title}  [${l.id}]${flagStr ? `  ⚠ ${flagStr}` : ''}`);
    });
    console.log('');
    return;
  }

  // ── --all-reject: bulk reject the whole batch (incident escape hatch) ─────
  if (flags['all-reject']) {
    const ok = flags.yes || await askYesNo(`Reject ALL ${items.length} pending learning(s)? This cannot be undone`, false);
    if (!ok) { console.log('Aborted — nothing changed.'); return; }
    let rejected = 0;
    for (const l of items) {
      try {
        await review.submitDecision({ apiKey, baseUrl, id: l.id, decision: 'reject' });
        rejected += 1;
        console.log(`  ✗ rejected (${rejected}/${items.length}): ${l.title}`);
      } catch (err) {
        console.error(`  ! failed to reject ${l.id}: ${err.message}`);
      }
    }
    console.log(`\nDone. Rejected ${rejected} of ${items.length}.`);
    return;
  }

  // ── interactive (default) ─────────────────────────────────────────────────
  console.log(`\n${total} learning(s) pending your review.`);
  console.log('For each: [a]pprove (go live) · [r]eject (stays private) · [s]kip · [q]uit\n');

  let approved = 0, rejected = 0, skipped = 0, seen = 0;
  for (const l of items) {
    seen += 1;
    printCandidate(l, seen, items.length);
    let choice = '';
    while (!['a', 'r', 's', 'q'].includes(choice)) {
      choice = (await ask('  approve / reject / skip / quit [a/r/s/q]? ')).toLowerCase().slice(0, 1);
    }
    if (choice === 'q') { console.log('  Stopping. Remaining items left pending.'); break; }
    if (choice === 's') { skipped += 1; console.log('  → skipped (still pending)'); continue; }
    try {
      if (choice === 'a') {
        await review.submitDecision({ apiKey, baseUrl, id: l.id, decision: 'approve' });
        approved += 1; console.log('  ✓ approved — now live');
      } else {
        const reason = await ask('  reason (optional, Enter to skip): ');
        await review.submitDecision({ apiKey, baseUrl, id: l.id, decision: 'reject', reason: reason || undefined });
        rejected += 1; console.log('  ✗ rejected — stays private');
      }
    } catch (err) {
      console.error(`  ! decision failed: ${err.message} (item left pending)`);
    }
  }

  console.log(`\nReview complete: approved ${approved}, rejected ${rejected}, skipped ${skipped} of ${items.length}.`);
}

// ─── Entry point ────────────────────────────────────────────────────────────

function usage() {
  console.log(`
Usage: auxilo <command>

Commands:
  setup     Interactive install: client detection, MCP registration,
            device-code login, extraction runner + hook, consent.
            Flags: --re-auth, --base-url <url>
  status    Show install/auth/extraction status.
  review    Review YOUR pending-review learnings (from background extraction)
            and approve/reject each before it goes public.
            Flags: --list (inspect only), --all-reject [--yes], --base-url <url>
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
