#!/usr/bin/env node

/**
 * scripts/review-notice.js — SessionStart held-count notice (LW-18 layer 1b)
 *
 * Invoked by the Claude Code SessionStart hook (structured entry written by
 * `auxilo setup` → lib/installer.js registerClaudeCodeSessionStartNotice via
 * the ~/.auxilo/bin/auxilo-review-notice.sh shim). Whatever this prints to
 * stdout is added to the session's context — so the contract is strict:
 *
 *   COUNT ONLY. Never titles, never bodies, never flags. Pending bodies are
 *   adversarial by assumption (some are held BECAUSE injection-flagged —
 *   LW-18 threat model); surfacing content to a live agent at session start
 *   would be a confused-deputy channel. One count + two command names, that
 *   is all.
 *
 * Behavior:
 *   - FAIL-SILENT: every non-happy path exits 0 with NO output. A broken
 *     notice must never break (or noise up) a session.
 *   - Recursion guard: AUXILO_EXTRACTING=1 (the headless `claude -p`
 *     extraction child fires SessionStart too) → silent exit.
 *   - Suppression: at most ONE notice per 4 hours, tracked in
 *     ~/.auxilo/review-notice-state.json (LW-18 spec).
 *   - Count source: GET /account/pending/summary with the credentials from
 *     ~/.auxilo/credentials.json; 3.5s abort so session start is never held
 *     hostage by a slow network.
 *
 * Self-contained (fs/path/os + global fetch) — ships in RUNNER_STACK to
 * ~/.auxilo/bin/scripts/ and must not require anything outside that layout
 * except node builtins.
 *
 * @module review-notice
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/** ≤ 1 notice per 4h (LW-18 spec). */
const NOTICE_SUPPRESSION_MS = 4 * 60 * 60 * 1000;

/** Network budget: SessionStart hooks block session start. */
const FETCH_TIMEOUT_MS = 3500;

function auxiloDir(homeDir) {
  return path.join(homeDir || os.homedir(), '.auxilo');
}

function statePath(homeDir) {
  return path.join(auxiloDir(homeDir), 'review-notice-state.json');
}

/** Read suppression state; malformed/absent → {} (fail-open to notifying). */
function readState(homeDir) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(homeDir), 'utf-8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

/**
 * Pure suppression decision: notify iff no prior notice, or the last one is
 * older than the suppression window (bad timestamps read as "no prior").
 */
function shouldNotify(state, now = Date.now(), suppressionMs = NOTICE_SUPPRESSION_MS) {
  const last = state && state.last_notice_at ? Date.parse(state.last_notice_at) : NaN;
  if (!Number.isFinite(last)) return true;
  return now - last >= suppressionMs;
}

/** Persist the suppression stamp (best-effort — failure must not throw). */
function writeState(homeDir, now = Date.now()) {
  try {
    const p = statePath(homeDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ last_notice_at: new Date(now).toISOString() }, null, 2) + '\n');
  } catch { /* fail-silent */ }
}

/** The one line. Count only — see the header contract. */
function renderNotice(count) {
  return `Auxilo: ${count} learning(s) held for your review — run auxilo_review (MCP) or \`npx auxilo review\`.`;
}

/** Load credentials; null when absent/malformed/keyless. */
function readCredentials(homeDir) {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(auxiloDir(homeDir), 'credentials.json'), 'utf-8'));
    return creds && typeof creds === 'object' && creds.api_key ? creds : null;
  } catch {
    return null;
  }
}

async function fetchPendingCount(creds, fetchImpl = fetch) {
  const baseUrl = String(creds.base_url || 'https://auxilo.io').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${baseUrl}/account/pending/summary`, {
      headers: { 'X-API-Key': creds.api_key },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    const n = body && body.pending_count;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  // Recursion guard: extraction children must never notice (or burn the
  // suppression window).
  if (process.env.AUXILO_EXTRACTING === '1') return;

  const homeDir = os.homedir();
  const creds = readCredentials(homeDir);
  if (!creds) return;

  if (!shouldNotify(readState(homeDir))) return;

  const count = await fetchPendingCount(creds);
  if (count == null || count <= 0) return;

  process.stdout.write(renderNotice(count) + '\n');
  writeState(homeDir);
}

module.exports = {
  shouldNotify, renderNotice, readState, writeState, readCredentials,
  fetchPendingCount, NOTICE_SUPPRESSION_MS, FETCH_TIMEOUT_MS,
};

if (require.main === module) {
  // FAIL-SILENT: exit 0 on every path, including internal errors.
  main().then(() => process.exit(0)).catch(() => process.exit(0));
}
