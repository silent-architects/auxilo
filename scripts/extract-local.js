'use strict';
/*
 * scripts/extract-local.js — CLIENT-SIDE learning extraction using the user's OWN model.
 *
 * Auxilo does not pay to extract. At session end, the agent that just did the work
 * (itself an LLM) extracts reusable learnings AND self-screens them for sensitivity,
 * using the local client's model (`claude -p` for Claude Code). Finished learnings are
 * then submitted to POST /learn by the runner. Zero cost to Auxilo.
 *
 * RECURSION SAFETY: `claude -p` starts a headless Claude Code turn, which will itself
 * fire the SessionEnd hook. We set AUXILO_EXTRACTING=1 on the child env so that child's
 * runner no-ops immediately (runner.js checks it). runner.js also sets it in-process
 * before we're called; we set it on the child explicitly as belt-and-suspenders.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CATEGORIES = ['data-processing', 'web-interaction', 'code-execution', 'communication', 'storage-state', 'content-generation', 'payment-financial', 'monitoring'];

const EXTRACTION_PROMPT = `You are extracting reusable OPERATIONAL LEARNINGS from an AI agent's session transcript, to publish to a PUBLIC knowledge marketplace read by other AI agents.

Extract 0 to 5 GENUINE learnings: non-obvious solutions, workarounds, API quirks, error root-causes, integration gotchas — the kind of thing that cost real debugging or combined multiple sources. SKIP trivial lookups, well-documented standard approaches, opinions, and conversation.

MANDATORY SENSITIVITY SELF-SCREEN (the marketplace is PUBLIC): NEVER include secrets, credentials, API keys, tokens, private keys, or seed phrases; personal data (real people's names, emails, phone numbers, wallet addresses); private filesystem paths, internal hostnames, or infrastructure identifiers; proprietary, confidential, or client-specific business content. Rewrite specifics into generic placeholders (/Users/USER/..., API_KEY, "a client") or omit them. If a learning cannot be generalized without leaking private material, DROP it entirely.

Output STRICT JSON ONLY — an array (possibly empty []) of objects with these keys:
  "title": concise, >= 10 chars
  "body": >= 50 chars — what was tried, what worked, what failed
  "category": one of ${JSON.stringify(CATEGORIES)}
  "tags": array of lowercase keyword strings
  "task_context": one sentence describing the task
  "outcome": one of "success","partial","failure","workaround"
No prose, no explanation, no markdown code fences — just the raw JSON array.

TRANSCRIPT:
`;

/** Resolve the `claude` binary — hook/launchd env may have a minimal PATH. */
function resolveClaudeBin() {
  const candidates = [
    'claude',
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(os.homedir(), '.local', 'bin', 'claude'),
  ];
  for (const c of candidates) {
    try {
      if (c === 'claude') return c; // let PATH resolve it; spawn will ENOENT if absent
      if (fs.existsSync(c)) return c;
    } catch (_) { /* ignore */ }
  }
  return 'claude';
}

/**
 * Invoke the local Claude Code model headlessly (uses the USER's subscription auth).
 * Prompt+transcript go via stdin. Returns { ok, out, reason } — never throws, so the
 * SessionEnd hook degrades gracefully (the proactive auxilo_contribute path is the
 * reliable primary; this deterministic hook is best-effort).
 */
function extractWithClaudeCode(transcript) {
  const bin = resolveClaudeBin();
  const input = EXTRACTION_PROMPT + String(transcript).slice(0, 200000);
  // Do NOT pass ANTHROPIC_API_KEY through — we want the user's logged-in Claude
  // subscription (OAuth), not an API key (which would bill someone). Delete it.
  const childEnv = { ...process.env, AUXILO_EXTRACTING: '1' };
  delete childEnv.ANTHROPIC_API_KEY;
  const res = spawnSync(bin, ['-p'], { input, encoding: 'utf-8', env: childEnv, timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
  const out = String(res.stdout || '');
  if (res.error) return { ok: false, out: '', reason: `spawn failed (${bin}): ${res.error.message}` };
  // Claude prints auth failures ("API Error: 401 ... Please run /login") to stdout.
  if (/Please run \/login|authentication_error|401/i.test(out) || /Please run \/login|authentication_error/i.test(String(res.stderr || ''))) {
    return { ok: false, out, reason: 'local model not authenticated in this context (run `claude` and /login once); skipping deterministic extraction' };
  }
  if (res.status !== 0) return { ok: false, out, reason: `local model exited ${res.status}: ${(out || String(res.stderr || '')).slice(0, 160)}` };
  return { ok: true, out, reason: null };
}

/** Defensively parse a JSON array of learnings out of model output. */
function parseLearnings(raw) {
  let s = String(raw || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  let arr;
  try { arr = JSON.parse(s.slice(start, end + 1)); } catch (_) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(l => l && typeof l.title === 'string' && typeof l.body === 'string' && l.title.length >= 10 && l.body.length >= 50)
    .map(l => ({
      title: l.title,
      body: l.body,
      category: CATEGORIES.includes(l.category) ? l.category : 'code-execution',
      tags: Array.isArray(l.tags) ? l.tags.slice(0, 8).map(String) : [],
      task_context: typeof l.task_context === 'string' ? l.task_context : '',
      outcome: ['success', 'partial', 'failure', 'workaround'].includes(l.outcome) ? l.outcome : 'success',
    }));
}

/**
 * Extract learnings locally. Returns { learnings: [...] } or { learnings: [], skipped }.
 * Only claude-code has a local extractor today; other clients rely on the agent's
 * proactive auxilo_contribute (MCP) call.
 */
async function extractLocally(transcript, sourceType) {
  if (sourceType && sourceType !== 'claude-code') {
    return { learnings: [], skipped: `local extraction not implemented for "${sourceType}" — agent contributes via auxilo_contribute` };
  }
  const { ok, out, reason } = extractWithClaudeCode(transcript);
  if (!ok) return { learnings: [], skipped: reason };
  return { learnings: parseLearnings(out) };
}

module.exports = { extractLocally, parseLearnings, resolveClaudeBin, EXTRACTION_PROMPT, CATEGORIES };
