#!/usr/bin/env node

/**
 * scripts/capture-core.js — Shared hook capture core (UC-1)
 *
 * The single entry point invoked by every per-client generated hook shim:
 *
 *   <client session-end hook> | node capture-core.js --source <id>
 *
 * Reads the client's session-end JSON from stdin, extracts the transcript
 * path tolerantly across hook dialects (Claude Code / Cursor / Gemini CLI
 * send `transcript_path`; Antigravity sends `transcriptPath`; Windsurf nests
 * it as `tool_info.transcript_path`; others use `transcript` or `chat_file`),
 * enforces the same guards as the proven
 * LW-12/LW-17 Claude Code hook script (lib/installer.js renderHookScript):
 *
 *   1. Consent sentinel  <home>/.auxilo/autonomous-enabled must exist
 *   2. Recursion guard   AUXILO_EXTRACTING must not be "1" — and is NEVER
 *                        exported into the spawned runner (P1-13 lesson:
 *                        exporting it trips the runner's own guard and
 *                        silently no-ops every run)
 *   3. Transcript file must exist
 *
 * then spawns the extraction runner detached so the host client's session
 * teardown is never blocked:
 *
 *   node <dir-of-this-file>/runner.js --transcript <path> --source <id>
 *
 * The runner path resolves relative to THIS file's __dirname (P1-13:
 * installed copies under ~/.auxilo/bin/scripts/ must run the installed
 * runner, never reach back into ~/Documents).
 *
 * stdout of the runner goes to /dev/null (LW-17: runner.js log() already
 * appends every line to extract.log itself — redirecting stdout there too
 * double-wrote each line and the daily digest double-counted). stderr is
 * appended to <home>/.auxilo/extract.log to capture crashes.
 *
 * FAIL-SILENT CONTRACT: a broken hook must never break the host client.
 * Every non-happy path exits 0 with no output. No exceptions escape main().
 *
 * Flags:
 *   --source <id>    source type forwarded to the runner (default claude-code)
 *   --home <dir>     home dir override (tests; default env HOME / os.homedir())
 *   --runner <path>  runner script override (tests; default __dirname/runner.js)
 *
 * @module capture-core
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

/**
 * Flat transcript-path keys tried in order, covering known hook dialects.
 * One NESTED dialect exists too: Windsurf wraps the path as
 * `tool_info.transcript_path` — extractTranscriptPath probes it after
 * `transcriptPath` and before `transcript` (UC-1).
 */
const TRANSCRIPT_KEYS = ['transcript_path', 'transcriptPath', 'transcript', 'chat_file'];

/**
 * GOV-3 M3: refuse to hand the runner anything implausibly large — the
 * adapters read the whole file into memory, so an untrusted hook payload
 * naming a multi-GB file is a trivial local OOM. Real transcripts top out
 * in the single-digit MB.
 */
const MAX_TRANSCRIPT_BYTES = 25 * 1024 * 1024;

/** GOV-3 M4: transcripts are text artifacts — gate on plausible extensions. */
const TRANSCRIPT_EXTS = Object.freeze(['.jsonl', '.json', '.md', '.txt']);

/**
 * GOV-3 M4: the hook payload is UNTRUSTED third-party input, and this process
 * will read+upload whatever file it names. Constrain the (symlink-resolved)
 * path to known client transcript roots instead of "any file on disk" —
 * otherwise a malicious payload exfiltrates arbitrary JSONL-shaped files and
 * the only defenses left are the format probe and the scrubber (defense in
 * depth, not a boundary).
 */
function transcriptRoots(homeDir) {
  return [
    path.join(homeDir, '.claude'),
    path.join(homeDir, '.cursor'),
    path.join(homeDir, '.gemini'),
    path.join(homeDir, '.codex'),
    path.join(homeDir, '.factory'),
    path.join(homeDir, '.copilot'),
    path.join(homeDir, '.codeium'),
    path.join(homeDir, '.windsurf'),
    path.join(homeDir, '.openclaw'),
    path.join(homeDir, '.auxilo'),
    path.join(homeDir, 'Library', 'Application Support'),
  ];
}

/** True iff realPath sits under a known transcript root AND has a text extension.
 *  Roots are symlink-resolved too, so the comparison is realpath-vs-realpath
 *  (macOS /var → /private/var would otherwise defeat a correct path). */
function transcriptPathAllowed(realPath, homeDir) {
  if (!TRANSCRIPT_EXTS.includes(path.extname(realPath).toLowerCase())) return false;
  return transcriptRoots(homeDir).some((root) => {
    let realRoot = root;
    try { realRoot = fs.realpathSync(root); } catch { /* root may not exist yet */ }
    return realPath === realRoot || realPath.startsWith(realRoot + path.sep);
  });
}

function parseArgs(argv) {
  const args = { source: 'claude-code', home: null, runner: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--source' && argv[i + 1]) args.source = argv[++i];
    else if (argv[i] === '--home' && argv[i + 1]) args.home = argv[++i];
    else if (argv[i] === '--runner' && argv[i + 1]) args.runner = argv[++i];
  }
  return args;
}

/** Extract a transcript path from a parsed hook payload. Returns null if absent. */
function extractTranscriptPath(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const nested = payload.tool_info && typeof payload.tool_info === 'object' &&
    !Array.isArray(payload.tool_info) ? payload.tool_info.transcript_path : undefined;
  const candidates = [
    payload.transcript_path,
    payload.transcriptPath,
    nested, // Windsurf nests it under tool_info (UC-1)
    payload.transcript,
    payload.chat_file,
  ];
  for (const v of candidates) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const homeDir = args.home || process.env.HOME || os.homedir();
  const auxiloDir = path.join(homeDir, '.auxilo');

  // 1. Consent sentinel — kill-switch shared by every capture class (UC §6).
  if (!fs.existsSync(path.join(auxiloDir, 'autonomous-enabled'))) return;

  // 2. Recursion guard — bail if we're already inside an extraction chain.
  if (process.env.AUXILO_EXTRACTING === '1') return;

  // 3. Hook payload → transcript path (tolerant across dialects).
  const raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }
  const namedPath = extractTranscriptPath(payload);
  if (!namedPath) return;

  // GOV-3 M4: resolve symlinks BEFORE validating, and use the resolved path
  // from here on — a symlink under an allowed root must not reach outside it.
  let transcriptPath;
  try { transcriptPath = fs.realpathSync(namedPath); } catch { return; }
  if (!transcriptPathAllowed(transcriptPath, homeDir)) return;

  let stat;
  try { stat = fs.statSync(transcriptPath); } catch { return; }
  if (!stat.isFile()) return;
  if (stat.size > MAX_TRANSCRIPT_BYTES) return; // GOV-3 M3: local-OOM guard

  // 4. Runner resolution — relative to OUR location (P1-13).
  const runnerPath = args.runner || path.join(__dirname, 'runner.js');
  if (!fs.existsSync(runnerPath)) return;

  // 5. Spawn detached. stdout → /dev/null (LW-17 double-write), stderr →
  //    extract.log for crash capture. Never export AUXILO_EXTRACTING.
  const env = { ...process.env };
  delete env.AUXILO_EXTRACTING;
  if (args.home) env.HOME = args.home; // keep test homes hermetic

  let stderrFd = 'ignore';
  try {
    fs.mkdirSync(auxiloDir, { recursive: true });
    stderrFd = fs.openSync(path.join(auxiloDir, 'extract.log'), 'a');
  } catch { /* fall back to ignore — fail-silent */ }

  const child = spawn(process.execPath,
    [runnerPath, '--transcript', transcriptPath, '--source', args.source],
    { detached: true, stdio: ['ignore', 'ignore', stderrFd], env });
  child.on('error', () => { /* fail-silent */ });
  child.unref();

  if (typeof stderrFd === 'number') {
    try { fs.closeSync(stderrFd); } catch { /* already closed */ }
  }
}

module.exports = {
  parseArgs,
  extractTranscriptPath,
  transcriptPathAllowed,
  transcriptRoots,
  TRANSCRIPT_KEYS,
  TRANSCRIPT_EXTS,
  MAX_TRANSCRIPT_BYTES,
};

if (require.main === module) {
  // Fail-silent: exit 0 on every path, swallow everything.
  main().then(() => process.exit(0)).catch(() => process.exit(0));
}
