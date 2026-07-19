'use strict';

/**
 * lib/installer.js — Turnkey installer core (LW-12)
 *
 * Testable core for the `auxilo setup|status|disable` CLI (bin/auxilo-cli.js).
 * Every filesystem-touching function takes an explicit `homeDir` and every
 * network-touching function takes an injectable `fetchImpl`, so unit tests run
 * against fixture directories and mocked fetch — NEVER the real `~/.claude`
 * or `~/.auxilo` (spec: specs/BUILD-SPEC-LAUNCH-WAVE.md §LW-12).
 *
 * Conventions inherited from scripts/runner.js (B15 / P1-13):
 *   - Malformed client config JSON FAILS LOUDLY — never overwritten.
 *   - Config writes are read-modify-write with tmp + rename.
 *   - Executable surface installs to <home>/.auxilo/bin (NEVER ~/Documents — TCC).
 *   - Credentials file is chmod 0600.
 *
 * NOTE: this module must not resolve the real home directory itself (no `os`
 * module at all) — the CLI binding layer (bin/auxilo-cli.js) does that.
 * Enforced by a source guard in test/lw12-installer.test.js.
 *
 * @module installer
 */

const fs = require('fs');
const path = require('path');

// ─── Constants ──────────────────────────────────────────────────────────────

/** MCP registration entry written into every client config (spec §LW-12 step 1). */
const MCP_ENTRY = Object.freeze({ command: 'npx', args: ['auxilo-mcp'] });

/** Default production API base (README.md / openapi.json servers[0]). */
const DEFAULT_BASE_URL = 'https://auxilo.io';

/** Root of the installed npm package (or the repo, when run from a clone). */
const PACKAGE_ROOT = path.resolve(__dirname, '..');

/**
 * Runner stack shipped in the npm tarball and copied into <home>/.auxilo/bin,
 * preserving relative layout so runner.js's requires resolve
 * (bin/scripts/runner.js → bin/lib/sensitivity-filter.js, bin/scripts/sources/).
 * Mirrors the P1-13 sweeper file set (scripts/runner.js installSweeper) minus
 * the launchd wrapper — LW-12 is hook-fired only; P1-13 owns the plist.
 */
const RUNNER_STACK = Object.freeze([
  // [package-relative source, bin-relative dest, mode]
  ['scripts/runner.js', 'scripts/runner.js', 0o755],
  ['scripts/capture-core.js', 'scripts/capture-core.js', 0o755], // UC-1 shim target
  // Client-side extraction module: runner.js postExtract() requires './extract-local.js'
  // at first extraction; omitting it from the installed stack is a MODULE_NOT_FOUND
  // for every npm-installed user (test/runner-packaging-closure.test.js guards this).
  ['scripts/extract-local.js', 'scripts/extract-local.js', 0o644],
  ['scripts/sources/source.interface.js', 'scripts/sources/source.interface.js', 0o644],
  ['scripts/sources/claude-code.js', 'scripts/sources/claude-code.js', 0o644],
  ['scripts/sources/openclaw.js', 'scripts/sources/openclaw.js', 0o644],
  ['scripts/sources/gemini-cli.js', 'scripts/sources/gemini-cli.js', 0o644],
  ['scripts/sources/antigravity.js', 'scripts/sources/antigravity.js', 0o644],
  ['scripts/sources/generic-jsonl.js', 'scripts/sources/generic-jsonl.js', 0o644],
  ['lib/sensitivity-filter.js', 'lib/sensitivity-filter.js', 0o644],
]);

// ─── Client registry + detection (spec §LW-12 step 1; UC-0 expansion) ───────

/**
 * Build the supported-client registry for a given home directory.
 *
 * Each entry's `format` names the config dialect registerMcp writes
 * (UC-0: "MCP registration writers for every Tier-1/2 client config format"):
 *   'json-mcpServers'  — Claude-Desktop-style `mcpServers` object (the default)
 *   'toml-codex'       — Codex CLI config.toml, append-only (no TOML parser)
 *   'json-dropin'      — standalone drop-in file we own entirely (Continue.dev)
 *   'opencode'         — opencode.json `mcp` key, `{type:'local',command:[...]}`
 *   'amp'              — settings.json flat `amp.mcpServers` key
 *   'openhands-stdio'  — mcp.json `stdio_servers` ARRAY keyed by entry name
 *
 * Optional fields: `detectDirs` (any-of detection, e.g. opencode's two roots),
 * `rulesPath` (global rules file for the UC-0 agent-prompted-contribution
 * snippet — see installRulesSnippet), and the UC-1 capture-hook trio:
 * `captureHook` (client supports a session-end hook we can register),
 * `captureEvent` (the client's event name), `captureConfigPath` (the hook
 * config file registerCaptureHook patches), plus `sourceId` when the
 * runner-side source id differs from the registry id (codex → codex-cli,
 * copilot-cli → copilot; must match model_config.json source_allowlist).
 *
 * @param {string} homeDir   Explicit home directory (fixture dir in tests).
 * @param {object} [opts]
 * @param {string} [opts.platform=process.platform]  'darwin' | 'win32' | ...
 * @param {object} [opts.env=process.env]            For %APPDATA% on win32.
 * @returns {Array<object>} registry entries (detected or not)
 */
function clientRegistry(homeDir, opts = {}) {
  if (!homeDir) throw new Error('clientRegistry: homeDir is required');
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;

  const claudeDesktopDir = platform === 'win32'
    ? path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Claude')
    : path.join(homeDir, 'Library', 'Application Support', 'Claude');

  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      detectDir: path.join(homeDir, '.claude'),
      configPath: path.join(homeDir, '.claude', 'settings.json'),
      format: 'json-mcpServers',
      mcp: true,
      hooks: true, // SessionEnd hook (background extraction)
    },
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      detectDir: claudeDesktopDir,
      configPath: path.join(claudeDesktopDir, 'claude_desktop_config.json'),
      format: 'json-mcpServers',
      mcp: true,
      hooks: false,
    },
    {
      id: 'cursor',
      name: 'Cursor',
      detectDir: path.join(homeDir, '.cursor'),
      configPath: path.join(homeDir, '.cursor', 'mcp.json'),
      format: 'json-mcpServers',
      mcp: true,
      hooks: false,
      // UC-1 capture hook (session-end → capture-core shim)
      captureHook: true,
      captureEvent: 'sessionEnd',
      captureConfigPath: path.join(homeDir, '.cursor', 'hooks.json'),
    },
    {
      id: 'openclaw',
      name: 'OpenClaw',
      detectDir: path.join(homeDir, '.openclaw'),
      configPath: null, // no MCP config; poll-based source adapter (scripts/sources/openclaw.js)
      mcp: false,
      hooks: false,
    },
    // ── UC-0 additions (config paths web-verified June 2026, BUILD-SPEC-UNIVERSAL-CLIENTS §5) ──
    {
      id: 'windsurf',
      name: 'Windsurf',
      detectDir: path.join(homeDir, '.codeium', 'windsurf'),
      configPath: path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json'),
      format: 'json-mcpServers',
      mcp: true,
      hooks: false,
      captureHook: true,
      captureEvent: 'post_cascade_response_with_transcript',
      captureConfigPath: path.join(homeDir, '.codeium', 'windsurf', 'hooks.json'),
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      detectDir: path.join(homeDir, '.codex'),
      configPath: path.join(homeDir, '.codex', 'config.toml'),
      format: 'toml-codex',
      mcp: true,
      hooks: false,
      captureHook: true,
      captureEvent: 'Stop',
      captureConfigPath: path.join(homeDir, '.codex', 'hooks.json'),
      // Runner-side source id (model_config.json source_allowlist uses
      // 'codex-cli'; the registry/client id stays 'codex').
      sourceId: 'codex-cli',
    },
    {
      id: 'gemini-cli',
      name: 'Gemini CLI',
      // Bare ~/.gemini is NOT sufficient: Antigravity also creates ~/.gemini
      // (verified on a real machine with Antigravity but no Gemini CLI —
      // phantom detection). Require CLI-specific artifacts: the session tmp
      // dir, or an existing settings.json.
      detectDirs: [path.join(homeDir, '.gemini', 'tmp')],
      detectFiles: [path.join(homeDir, '.gemini', 'settings.json')],
      configPath: path.join(homeDir, '.gemini', 'settings.json'),
      format: 'json-mcpServers',
      mcp: true,
      hooks: false,
      // Global context file — target for the UC-0 rules-snippet opt-in.
      rulesPath: path.join(homeDir, '.gemini', 'GEMINI.md'),
      captureHook: true,
      captureEvent: 'SessionEnd',
      captureConfigPath: path.join(homeDir, '.gemini', 'settings.json'),
    },
    {
      // Separate client from Gemini CLI: detection requires the antigravity
      // SUBDIR (a bare ~/.gemini means Gemini CLI only).
      id: 'antigravity',
      name: 'Antigravity',
      detectDir: path.join(homeDir, '.gemini', 'antigravity'),
      configPath: path.join(homeDir, '.gemini', 'config', 'mcp_config.json'),
      format: 'json-mcpServers',
      mcp: true,
      hooks: false,
      captureHook: true,
      captureEvent: 'Stop',
      captureConfigPath: path.join(homeDir, '.gemini', 'config', 'hooks.json'),
    },
    {
      id: 'factory',
      name: 'Factory droid',
      detectDir: path.join(homeDir, '.factory'),
      configPath: path.join(homeDir, '.factory', 'mcp.json'),
      format: 'json-mcpServers',
      mcp: true,
      hooks: false,
      captureHook: true,
      captureEvent: 'SessionEnd',
      // NOT settings.json — Factory reads hooks from ~/.factory/hooks.json.
      captureConfigPath: path.join(homeDir, '.factory', 'hooks.json'),
    },
    {
      id: 'copilot-cli',
      name: 'GitHub Copilot CLI',
      detectDir: path.join(homeDir, '.copilot'),
      configPath: path.join(homeDir, '.copilot', 'mcp-config.json'),
      format: 'json-mcpServers',
      mcp: true,
      hooks: false,
      captureHook: true,
      captureEvent: 'Stop',
      // Drop-in file we own entirely; the ~/.copilot/hooks dir is shared with
      // VS Code Copilot user-level hooks (same machine config root).
      captureConfigPath: path.join(homeDir, '.copilot', 'hooks', 'auxilo.json'),
      // Runner-side source id (allowlist uses 'copilot', not 'copilot-cli').
      sourceId: 'copilot',
    },
    {
      // Continue auto-loads Claude-style JSON drop-ins from ~/.continue/mcpServers/.
      id: 'continue',
      name: 'Continue.dev',
      detectDir: path.join(homeDir, '.continue'),
      configPath: path.join(homeDir, '.continue', 'mcpServers', 'auxilo.json'),
      format: 'json-dropin',
      mcp: true,
      hooks: false,
    },
    {
      id: 'opencode',
      name: 'opencode',
      detectDir: path.join(homeDir, '.config', 'opencode'),
      detectDirs: [
        path.join(homeDir, '.config', 'opencode'),
        path.join(homeDir, '.local', 'share', 'opencode'),
      ],
      configPath: path.join(homeDir, '.config', 'opencode', 'opencode.json'),
      format: 'opencode',
      mcp: true,
      hooks: false,
    },
    {
      id: 'kiro',
      name: 'Kiro',
      detectDir: path.join(homeDir, '.kiro'),
      configPath: path.join(homeDir, '.kiro', 'settings', 'mcp.json'),
      format: 'json-mcpServers',
      mcp: true,
      hooks: false,
    },
    {
      id: 'junie',
      name: 'JetBrains Junie',
      detectDir: path.join(homeDir, '.junie'),
      configPath: path.join(homeDir, '.junie', 'mcp', 'mcp.json'),
      format: 'json-mcpServers',
      mcp: true,
      hooks: false,
    },
    {
      id: 'amp',
      name: 'Amp',
      detectDir: path.join(homeDir, '.config', 'amp'),
      configPath: path.join(homeDir, '.config', 'amp', 'settings.json'),
      format: 'amp',
      mcp: true,
      hooks: false,
    },
    {
      id: 'openhands',
      name: 'OpenHands',
      detectDir: path.join(homeDir, '.openhands'),
      configPath: path.join(homeDir, '.openhands', 'mcp.json'),
      format: 'openhands-stdio',
      mcp: true,
      hooks: false,
    },
  ];
}

/** True when p exists and is a directory (detection probe). */
function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Detect which supported clients are present under homeDir.
 * @returns {Array<object>} subset of clientRegistry whose detectDir (or any
 *   of detectDirs, when a client has multiple roots) exists, or any of whose
 *   detectFiles exist (clients whose only reliable marker is a file)
 */
function detectClients(homeDir, opts = {}) {
  return clientRegistry(homeDir, opts).filter((c) =>
    (c.detectDirs || [c.detectDir]).some(dirExists) ||
    (c.detectFiles || []).some((p) => fs.existsSync(p)));
}

// ─── MCP registration (spec §LW-12 step 1) ──────────────────────────────────

/** Atomic JSON write: tmp + rename (same convention as mcp-server.js setup). */
function writeJsonAtomic(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

/**
 * Read-parse a client config file. Malformed JSON throws (B15: fail loudly,
 * never overwrite). Missing file returns {}.
 */
function readClientConfig(configPath) {
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (parseErr) {
    throw new Error(
      `Malformed JSON in ${configPath} — refusing to overwrite. ` +
      `Fix the file manually, then re-run \`auxilo setup\`. Parse error: ${parseErr.message}`
    );
  }
}

/** Fresh copy of the standard MCP server entry (never share the frozen one). */
function mcpEntry() {
  return { command: MCP_ENTRY.command, args: [...MCP_ENTRY.args] };
}

/** Result helpers shared by every registerMcp format writer. */
function unchangedResult(configPath) {
  return { changed: false, status: 'already-registered', configPath };
}
function registeredResult(configPath) {
  return { changed: true, status: 'registered', configPath };
}

/** Default writer: Claude-Desktop-style `mcpServers` object (most clients). */
function registerJsonMcpServers(client) {
  const config = readClientConfig(client.configPath);
  if (config.mcpServers && config.mcpServers.auxilo) return unchangedResult(client.configPath);
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers.auxilo = mcpEntry();
  writeJsonAtomic(client.configPath, config);
  return registeredResult(client.configPath);
}

/** TOML section header used for Codex idempotency (substring probe — no TOML dep). */
const CODEX_SECTION_HEADER = '[mcp_servers.auxilo]';

/**
 * Codex CLI writer: APPEND-ONLY into ~/.codex/config.toml. Existing TOML is
 * never parsed, rewritten, or reformatted — we only ever append our own
 * section, and only when the `[mcp_servers.auxilo]` header is absent.
 */
function registerCodexToml(client) {
  const raw = fs.existsSync(client.configPath)
    ? fs.readFileSync(client.configPath, 'utf-8')
    : '';
  if (raw.includes(CODEX_SECTION_HEADER)) return unchangedResult(client.configPath);

  const section = `\n${CODEX_SECTION_HEADER}\n` +
    `command = ${JSON.stringify(MCP_ENTRY.command)}\n` +
    `args = ${JSON.stringify(MCP_ENTRY.args)}\n`;

  const tmp = `${client.configPath}.tmp`;
  fs.mkdirSync(path.dirname(client.configPath), { recursive: true });
  fs.writeFileSync(tmp, raw + section);
  fs.renameSync(tmp, client.configPath);
  return registeredResult(client.configPath);
}

/** Continue.dev writer: standalone drop-in file under ~/.continue/mcpServers/. */
function registerJsonDropin(client) {
  const config = readClientConfig(client.configPath);
  if (config.mcpServers && config.mcpServers.auxilo) return unchangedResult(client.configPath);
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers.auxilo = mcpEntry();
  writeJsonAtomic(client.configPath, config);
  return registeredResult(client.configPath);
}

/** opencode writer: `mcp` key, entry shape {type:'local', command:[bin,...args]}. */
function registerOpencode(client) {
  const config = readClientConfig(client.configPath);
  if (config.mcp && config.mcp.auxilo) return unchangedResult(client.configPath);
  if (!config.mcp) config.mcp = {};
  config.mcp.auxilo = { type: 'local', command: [MCP_ENTRY.command, ...MCP_ENTRY.args] };
  writeJsonAtomic(client.configPath, config);
  return registeredResult(client.configPath);
}

/** Amp writer: settings.json flat `amp.mcpServers` key (an object of servers). */
function registerAmp(client) {
  const config = readClientConfig(client.configPath);
  const servers = config['amp.mcpServers'];
  if (servers && servers.auxilo) return unchangedResult(client.configPath);
  config['amp.mcpServers'] = { ...(servers || {}), auxilo: mcpEntry() };
  writeJsonAtomic(client.configPath, config);
  return registeredResult(client.configPath);
}

/** OpenHands writer: `stdio_servers` ARRAY of {name, command, args}, keyed by name. */
function registerOpenHands(client) {
  const config = readClientConfig(client.configPath);
  // GOV-3 M1: a non-array stdio_servers means the schema isn't what we expect
  // (drift, or an object map) — skip loudly rather than clobbering the user's
  // existing registrations with a coerced array (B15 discipline).
  if (config.stdio_servers !== undefined && !Array.isArray(config.stdio_servers)) {
    throw new Error(`Unexpected stdio_servers shape in ${client.configPath} (not an array) — add the Auxilo entry manually`);
  }
  const servers = config.stdio_servers || [];
  if (servers.some((s) => s && s.name === 'auxilo')) return unchangedResult(client.configPath);
  config.stdio_servers = [...servers, { name: 'auxilo', ...mcpEntry() }];
  writeJsonAtomic(client.configPath, config);
  return registeredResult(client.configPath);
}

/** Format → writer dispatch table (extend here when a new dialect appears). */
const MCP_WRITERS = Object.freeze({
  'json-mcpServers': registerJsonMcpServers,
  'toml-codex': registerCodexToml,
  'json-dropin': registerJsonDropin,
  'opencode': registerOpencode,
  'amp': registerAmp,
  'openhands-stdio': registerOpenHands,
});

/**
 * Register the Auxilo MCP server in one client's config file.
 * Dispatches on the client's `format` (default 'json-mcpServers'). All JSON
 * writers are read-modify-write with tmp+rename; existing keys preserved;
 * no-op (file untouched) when the auxilo entry is already present. The Codex
 * TOML writer is append-only and never touches existing content.
 *
 * @param {object} client  Entry from clientRegistry (must have configPath).
 * @returns {{ changed: boolean, status: 'registered'|'already-registered', configPath: string }}
 * @throws on malformed existing JSON (B15 — caller skips that client loudly)
 */
function registerMcp(client) {
  if (!client || !client.configPath) {
    throw new Error(`registerMcp: client ${client && client.id} has no MCP config path`);
  }
  const writer = MCP_WRITERS[client.format || 'json-mcpServers'];
  if (!writer) {
    throw new Error(`registerMcp: client ${client.id} has unknown config format "${client.format}"`);
  }
  return writer(client);
}

/**
 * True when the auxilo MCP entry is present in a client's config, per the
 * client's format. Read-only probe for `auxilo status` — missing or malformed
 * config reads as "not registered" (status must never throw on local probes).
 */
function mcpRegistrationPresent(client) {
  try {
    if (client.format === 'toml-codex') {
      return fs.readFileSync(client.configPath, 'utf-8').includes(CODEX_SECTION_HEADER);
    }
    const config = JSON.parse(fs.readFileSync(client.configPath, 'utf-8'));
    switch (client.format || 'json-mcpServers') {
      case 'opencode':
        return Boolean(config.mcp && config.mcp.auxilo);
      case 'amp':
        return Boolean(config['amp.mcpServers'] && config['amp.mcpServers'].auxilo);
      case 'openhands-stdio':
        return Array.isArray(config.stdio_servers) &&
          config.stdio_servers.some((s) => s && s.name === 'auxilo');
      default: // json-mcpServers + json-dropin share the mcpServers shape
        return Boolean(config.mcpServers && config.mcpServers.auxilo);
    }
  } catch {
    return false; // missing or malformed config → not registered
  }
}

// ─── Credentials (spec §LW-12 step 2) ───────────────────────────────────────

function credentialsPath(homeDir) {
  return path.join(homeDir, '.auxilo', 'credentials.json');
}

/**
 * Read ~/.auxilo/credentials.json. Returns null when absent/malformed
 * (same tolerance as scripts/runner.js loadCredentials).
 */
function readCredentials(homeDir) {
  try {
    const creds = JSON.parse(fs.readFileSync(credentialsPath(homeDir), 'utf-8'));
    return creds && typeof creds === 'object' ? creds : null;
  } catch {
    return null;
  }
}

/**
 * Write ~/.auxilo/credentials.json with mode 0600.
 * Existing file is chmod 0600 BEFORE rewrite (spec), then replaced via
 * tmp(0600) + rename so the secret never exists world-readable.
 *
 * @param {string} homeDir
 * @param {{ api_key: string, base_url: string, email?: string, account_id?: string }} creds
 * @returns {string} path written
 */
function writeCredentials(homeDir, creds) {
  if (!homeDir) throw new Error('writeCredentials: homeDir is required');
  if (!creds || !creds.api_key) throw new Error('writeCredentials: creds.api_key is required');

  const credPath = credentialsPath(homeDir);
  fs.mkdirSync(path.dirname(credPath), { recursive: true });

  if (fs.existsSync(credPath)) fs.chmodSync(credPath, 0o600);

  const tmp = `${credPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, credPath);
  fs.chmodSync(credPath, 0o600); // belt-and-braces: rename preserves tmp mode, assert anyway
  return credPath;
}

// ─── Device-code auth (spec §LW-12 step 2; server.js /auth/device) ──────────

/**
 * Run the device-code login flow against the Auxilo server.
 * Pure network flow — does NOT write credentials (caller does, so an expired
 * code can never leave a partial credentials file: T-LW12-11).
 *
 * @param {object} opts
 * @param {string}   [opts.baseUrl=DEFAULT_BASE_URL]
 * @param {Function} [opts.fetchImpl=fetch]    Injectable for tests.
 * @param {Function} [opts.onCode]             (userCode, verificationUrl) → void; print/open browser.
 * @param {Function} [opts.sleep]              (ms) → Promise; injectable for tests.
 * @param {number}   [opts.maxWaitMs=600000]   10 min TTL (server DEVICE_CODE_TTL).
 * @returns {Promise<{ api_key: string, account_id: string, email: string, base_url: string }>}
 * @throws Error on expired code, HTTP failure, or timeout.
 */
async function deviceLogin(opts = {}) {
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl || fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxWaitMs = opts.maxWaitMs !== undefined ? opts.maxWaitMs : 600000;

  const res = await fetchImpl(`${baseUrl}/auth/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Device code request failed (HTTP ${res.status})`);
  const device = await res.json();
  // A-1: device_code is the secret polling credential; user_code is the human
  // code shown on the verification page only.
  const { user_code: userCode, device_code: deviceCode, verification_url: verificationUrl } = device;
  if (!userCode) throw new Error('Device code request failed: no user_code in response');
  if (!deviceCode) throw new Error('Device code request failed: no device_code in response');

  // Server returns interval in seconds (default 5 per server.js /auth/device).
  const intervalMs = (device.interval || 5) * 1000;

  if (typeof opts.onCode === 'function') opts.onCode(userCode, verificationUrl);

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() <= deadline) {
    await sleep(intervalMs);
    let status;
    try {
      const poll = await fetchImpl(`${baseUrl}/auth/device/status?device_code=${encodeURIComponent(deviceCode)}`);
      status = await poll.json();
    } catch {
      continue; // transient network error during poll — keep polling
    }
    if (status.status === 'authorized') {
      return {
        api_key: status.api_key,
        account_id: status.account_id,
        email: status.email,
        base_url: baseUrl,
      };
    }
    if (status.status === 'expired') {
      throw new Error('Device code expired — run `auxilo setup` again to get a new code.');
    }
    // pending → keep polling
  }
  throw new Error('Timed out waiting for device authorization (10 minutes).');
}

// ─── Runner install (spec §LW-12 step 3; layout per P1-13) ──────────────────

function binRootFor(homeDir) {
  return path.join(homeDir, '.auxilo', 'bin');
}

function hookScriptPathFor(homeDir) {
  return path.join(binRootFor(homeDir), 'auxilo-extract.sh');
}

/**
 * Generate the SessionEnd hook script body. Paths are embedded ABSOLUTELY
 * (spec: hook references <home>/.auxilo/bin/scripts/runner.js absolutely).
 * Logic mirrors the proven P2.1a hook: sentinel kill-switch, AUXILO_EXTRACTING
 * recursion guard, detached spawn so session teardown is never blocked.
 */
function renderHookScript(homeDir) {
  const auxiloDir = path.join(homeDir, '.auxilo');
  const runnerPath = path.join(auxiloDir, 'bin', 'scripts', 'runner.js');
  return `#!/bin/bash
# Auxilo SessionEnd hook — generated by \`auxilo setup\` (LW-12).
# Reads the Claude Code SessionEnd JSON from stdin, extracts the transcript
# path, and spawns the extraction runner detached so shutdown is not blocked.
# Re-run \`auxilo setup\` after upgrading the auxilo-mcp package.

set -u

# Kill-switch: runner fires only if the consent sentinel exists.
#   enable:  auxilo setup (consent step)   disable: auxilo disable
if [ ! -f "${auxiloDir}/autonomous-enabled" ]; then
  exit 0
fi

# Recursion guard: bail if we're already inside an extraction chain.
if [ "\${AUXILO_EXTRACTING:-0}" = "1" ]; then
  exit 0
fi

input_json=$(cat)

transcript_path=$(printf '%s' "$input_json" | /usr/bin/env node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).transcript_path||"")}catch{}})' 2>/dev/null)

if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
  exit 0
fi

RUNNER="${runnerPath}"
if [ ! -f "$RUNNER" ]; then
  exit 0
fi

mkdir -p "${auxiloDir}"
LOG="${auxiloDir}/extract.log"

# Spawn detached — do not block session teardown.
# P1-13 lesson: do NOT set AUXILO_EXTRACTING here — runner.js's own recursion
# guard would trip and silently no-op every run. The runner sets it itself
# for child processes.
# LW-17: stdout goes to /dev/null — runner.js log() already appends every
# line to extract.log itself; redirecting stdout there too double-wrote each
# line and the daily digest double-counted. stderr still captured for crashes.
nohup /usr/bin/env node "$RUNNER" --transcript "$transcript_path" > /dev/null 2>> "$LOG" &

exit 0
`;
}

/**
 * Install the extraction runner stack into <home>/.auxilo/bin and generate
 * the SessionEnd hook script (0755).
 *
 * Files are COPIED (not symlinked) from the npm package, preserving the
 * relative layout runner.js requires. Missing package files throw — the lib
 * never calls process.exit.
 *
 * @param {string} homeDir
 * @param {object} [opts]
 * @param {string} [opts.packageRoot=PACKAGE_ROOT]
 * @returns {{ binRoot: string, hookPath: string, installed: string[] }}
 */
function installRunner(homeDir, opts = {}) {
  if (!homeDir) throw new Error('installRunner: homeDir is required');
  const packageRoot = opts.packageRoot || PACKAGE_ROOT;
  const binRoot = binRootFor(homeDir);
  const installed = [];

  for (const [src, dest, mode] of RUNNER_STACK) {
    const srcPath = path.join(packageRoot, src);
    const destPath = path.join(binRoot, dest);
    if (!fs.existsSync(srcPath)) {
      throw new Error(`installRunner: missing package file ${srcPath} — reinstall auxilo-mcp`);
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
    fs.chmodSync(destPath, mode);
    installed.push(destPath);
  }

  const hookPath = hookScriptPathFor(homeDir);
  fs.writeFileSync(hookPath, renderHookScript(homeDir));
  fs.chmodSync(hookPath, 0o755);
  installed.push(hookPath);

  return { binRoot, hookPath, installed };
}

// ─── Claude Code hook registration (spec §LW-12 step 4) ─────────────────────

/** True when an inner hook object is an Auxilo extraction command. */
function isAuxiloCommandHook(h) {
  return h && typeof h === 'object' && typeof h.command === 'string' &&
    h.command.includes('auxilo-extract');
}

/**
 * Patch <home>/.claude/settings.json hooks.SessionEnd[] to contain exactly one
 * Auxilo entry: <home>/.auxilo/bin/auxilo-extract.sh, in Claude Code's
 * STRUCTURED form ({ hooks: [{ type: 'command', command }] }).
 *
 * LW-17: 0.8.1 appended the command as a bare string — Claude Code silently
 * ignores string entries, so the hook NEVER fired. It also only removed
 * legacy entries that were strings, missing the pre-LW-12 structured entry
 * (~/.claude/hooks/auxilo-extract.sh nested inside a matcher group).
 *
 * Idempotent. Removes every Auxilo reference (bare strings, and command
 * objects inside matcher groups — preserving any non-Auxilo commands sharing
 * the group), then appends one canonical structured entry. Non-Auxilo entries
 * are preserved untouched. Malformed settings.json throws (B15) — never
 * overwritten.
 *
 * @returns {{ changed: boolean, hookCmd: string, removedLegacy: string[] }}
 */
function registerClaudeCodeHook(homeDir) {
  if (!homeDir) throw new Error('registerClaudeCodeHook: homeDir is required');
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  const hookCmd = hookScriptPathFor(homeDir);

  const settings = readClientConfig(settingsPath);
  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.SessionEnd)) settings.hooks.SessionEnd = [];

  const before = settings.hooks.SessionEnd;
  const removedLegacy = [];
  const kept = [];

  for (const entry of before) {
    if (typeof entry === 'string' && entry.includes('auxilo-extract')) {
      removedLegacy.push(entry); // includes 0.8.1's dead bare-string entry
      continue;
    }
    if (entry && typeof entry === 'object' && Array.isArray(entry.hooks)) {
      const auxilo = entry.hooks.filter(isAuxiloCommandHook);
      if (auxilo.length > 0) {
        removedLegacy.push(...auxilo.map((h) => h.command));
        const rest = entry.hooks.filter((h) => !isAuxiloCommandHook(h));
        if (rest.length > 0) kept.push({ ...entry, hooks: rest });
        continue;
      }
    }
    kept.push(entry);
  }

  const canonical = { hooks: [{ type: 'command', command: hookCmd }] };

  // Idempotency: unchanged iff the only Auxilo reference found was already
  // the canonical command in a structured single-command entry.
  const alreadyExact =
    removedLegacy.length === 1 && removedLegacy[0] === hookCmd &&
    before.some((e) =>
      e && typeof e === 'object' && Array.isArray(e.hooks) &&
      e.hooks.length === 1 && isAuxiloCommandHook(e.hooks[0]) &&
      e.hooks[0].command === hookCmd && e.hooks[0].type === 'command'
    );
  if (alreadyExact) {
    return { changed: false, hookCmd, removedLegacy: [] };
  }

  settings.hooks.SessionEnd = [...kept, canonical];
  writeJsonAtomic(settingsPath, settings);
  return { changed: true, hookCmd, removedLegacy: removedLegacy.filter((c) => c !== hookCmd) };
}

// ─── UC-1 capture-hook registration ─────────────────────────────────────────
//
// Per-client session-end hooks that pipe the client's hook JSON into the
// shared capture core (<home>/.auxilo/bin/scripts/capture-core.js), which owns
// ALL guard logic (consent sentinel, AUXILO_EXTRACTING recursion guard,
// fail-silent). Each client gets its own tiny bash shim so the hook config
// carries a stable absolute path and the right --source id.
//
// Hook config schemas web-verified June 2026 from official docs
// (BUILD-SPEC-UNIVERSAL-CLIENTS §UC-1). All JSON writers: merge-preserve
// unrelated content, idempotent, stale 'auxilo-capture' entries replaced not
// duplicated, malformed JSON throws (B15 — never overwritten).

/** Absolute path of the per-source capture shim. */
function captureShimPath(homeDir, sourceId) {
  return path.join(binRootFor(homeDir), `auxilo-capture-${sourceId}.sh`);
}

/**
 * Generate the capture shim body. stdin (the client's hook JSON) passes
 * straight through `exec` to capture-core.js; the PATH export covers GUI-
 * launched clients whose hooks run without a login shell (no node on PATH).
 */
function renderCaptureShim(homeDir, sourceId) {
  const corePath = path.join(binRootFor(homeDir), 'scripts', 'capture-core.js');
  return `#!/bin/bash
# Auxilo capture shim (${sourceId}) — generated by \`auxilo setup\` (UC-1).
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
exec /usr/bin/env node "${corePath}" --source ${sourceId}
`;
}

/** Write the shim (0755) if missing or stale. Returns true when (re)written. */
function writeCaptureShim(homeDir, sourceId) {
  const shimPath = captureShimPath(homeDir, sourceId);
  const body = renderCaptureShim(homeDir, sourceId);
  if (fs.existsSync(shimPath) && fs.readFileSync(shimPath, 'utf-8') === body) {
    return false;
  }
  fs.mkdirSync(path.dirname(shimPath), { recursive: true });
  fs.writeFileSync(shimPath, body);
  fs.chmodSync(shimPath, 0o755);
  return true;
}

/** True when an entry's command string references an Auxilo capture shim. */
function isAuxiloCaptureCommand(cmd) {
  return typeof cmd === 'string' && cmd.includes('auxilo-capture');
}

/**
 * Flat hook arrays ({command} entries — Cursor, Windsurf): strip stale
 * auxilo-capture entries, append the canonical one.
 */
function patchFlatHookArray(arr, shimPath) {
  const kept = (Array.isArray(arr) ? arr : [])
    .filter((e) => !(e && typeof e === 'object' && isAuxiloCaptureCommand(e.command)));
  return [...kept, { command: shimPath }];
}

/**
 * Matcher-group hook arrays ([{hooks:[{type,command,...}]}] — Gemini CLI,
 * Factory, Codex): strip stale auxilo-capture inner hooks (preserving any
 * non-Auxilo commands sharing a group, dropping groups left empty), then
 * append one canonical group containing `entry`.
 */
function patchGroupHookArray(arr, entry) {
  const kept = [];
  for (const group of Array.isArray(arr) ? arr : []) {
    if (group && typeof group === 'object' && Array.isArray(group.hooks)) {
      const rest = group.hooks.filter((h) => !(h && isAuxiloCaptureCommand(h.command)));
      if (rest.length === 0 && rest.length !== group.hooks.length) continue; // group was all ours
      kept.push(rest.length === group.hooks.length ? group : { ...group, hooks: rest });
      continue;
    }
    kept.push(group);
  }
  return [...kept, { hooks: [entry] }];
}

/**
 * Patch a JSON hook config in place: read (B15: malformed throws), mutate via
 * `mutate(config)`, write atomically ONLY when the result differs (idempotent
 * re-runs leave the file byte-identical).
 * @returns {boolean} changed
 */
function patchJsonHookConfig(configPath, mutate) {
  const config = readClientConfig(configPath);
  const before = JSON.stringify(config);
  mutate(config);
  if (JSON.stringify(config) === before && fs.existsSync(configPath)) return false;
  writeJsonAtomic(configPath, config);
  return true;
}

/**
 * Per-client capture-hook config writers. Each receives (client, homeDir,
 * shimPath) and returns { changed, notes? } for the hook CONFIG only (the
 * shim is handled by registerCaptureHook). Keyed by registry id.
 */
const CAPTURE_WRITERS = Object.freeze({
  // ~/.cursor/hooks.json — {"version":1,"hooks":{"sessionEnd":[{"command":...}]}}
  // version:1 is REQUIRED by Cursor; other events/entries preserved.
  'cursor': (client, homeDir, shimPath) => {
    const changed = patchJsonHookConfig(client.captureConfigPath, (config) => {
      if (config.version === undefined) config.version = 1;
      if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};
      config.hooks.sessionEnd = patchFlatHookArray(config.hooks.sessionEnd, shimPath);
    });
    return { changed };
  },

  // ~/.gemini/settings.json — hooks.SessionEnd: array of matcher groups, each
  // {hooks:[{name,type,command,timeout}]}. Other settings keys (mcpServers,
  // theme, ...) and other hook events preserved.
  'gemini-cli': (client, homeDir, shimPath) => {
    const changed = patchJsonHookConfig(client.captureConfigPath, (config) => {
      if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};
      config.hooks.SessionEnd = patchGroupHookArray(config.hooks.SessionEnd, {
        name: 'auxilo-capture',
        type: 'command',
        command: shimPath,
        timeout: 5000,
      });
    });
    return { changed };
  },

  // ~/.gemini/config/hooks.json — top level keyed by hook-GROUP name (NOT a
  // "hooks" key). We own ONLY the "auxilo-capture" group key; everything else
  // is user content and is never touched.
  'antigravity': (client, homeDir, shimPath) => {
    const changed = patchJsonHookConfig(client.captureConfigPath, (config) => {
      config['auxilo-capture'] = {
        Stop: [{ hooks: [{ type: 'command', command: shimPath, timeout: 15 }] }],
      };
    });
    return { changed, notes: 'schema low-confidence — verify live' };
  },

  // ~/.codeium/windsurf/hooks.json — flat {command} entries, no version field.
  'windsurf': (client, homeDir, shimPath) => {
    const changed = patchJsonHookConfig(client.captureConfigPath, (config) => {
      if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};
      config.hooks.post_cascade_response_with_transcript =
        patchFlatHookArray(config.hooks.post_cascade_response_with_transcript, shimPath);
    });
    return { changed, notes: 'fires per-response; dedupe relies on runner ledger + server idempotency' };
  },

  // ~/.copilot/hooks/auxilo.json — drop-in file we own entirely (the hooks
  // dir is shared with VS Code Copilot user-level hooks).
  'copilot-cli': (client, homeDir, shimPath) => {
    const changed = patchJsonHookConfig(client.captureConfigPath, (config) => {
      for (const key of Object.keys(config)) delete config[key]; // we own the whole file
      config.hooks = { Stop: [{ type: 'command', command: shimPath }] };
    });
    return { changed };
  },

  // ~/.factory/hooks.json (NOT settings.json) — matcher-group SessionEnd.
  'factory': (client, homeDir, shimPath) => {
    const changed = patchJsonHookConfig(client.captureConfigPath, (config) => {
      if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};
      config.hooks.SessionEnd = patchGroupHookArray(config.hooks.SessionEnd,
        { type: 'command', command: shimPath });
    });
    return { changed };
  },

  // ~/.codex/hooks.json — matcher-group Stop with timeout. GOTCHA: when
  // ~/.codex/config.toml already defines a [hooks...] table, writing
  // hooks.json too would double-layer (Codex warns) — skip with a note.
  'codex': (client, homeDir, shimPath) => {
    try {
      const toml = fs.readFileSync(client.configPath, 'utf-8');
      if (toml.includes('[hooks')) {
        return {
          changed: false,
          notes: 'config.toml already defines hooks — add manually to avoid double-layer warning',
        };
      }
    } catch { /* no config.toml — hooks.json is safe */ }
    const changed = patchJsonHookConfig(client.captureConfigPath, (config) => {
      if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};
      config.hooks.Stop = patchGroupHookArray(config.hooks.Stop,
        { type: 'command', command: shimPath, timeout: 30 });
    });
    return { changed, notes: 'requires one-time interactive /hooks trust approval in Codex' };
  },
});

/**
 * Register the UC-1 capture hook for one client: write the per-source shim
 * (0755) and patch the client's hook config. Idempotent — identical re-runs
 * report changed:false and leave both files byte-identical.
 *
 * @param {object} client  Registry entry with captureHook:true.
 * @param {string} homeDir
 * @returns {{ changed: boolean, hookPath: string, configPath: string, notes?: string }}
 * @throws on malformed existing hook config JSON (B15 — caller skips loudly)
 */
function registerCaptureHook(client, homeDir) {
  if (!homeDir) throw new Error('registerCaptureHook: homeDir is required');
  if (!client || !client.captureHook || !client.captureConfigPath) {
    throw new Error(`registerCaptureHook: client ${client && client.id} has no capture-hook support`);
  }
  const writer = CAPTURE_WRITERS[client.id];
  if (!writer) {
    throw new Error(`registerCaptureHook: no capture writer for client "${client.id}"`);
  }
  const sourceId = client.sourceId || client.id;
  const shimPath = captureShimPath(homeDir, sourceId);

  // Codex skip-gotcha must not leave a dangling shim behind — let the writer
  // decide first, then write the shim only when the hook is actually wired.
  const result = writer(client, homeDir, shimPath);
  let shimChanged = false;
  if (!(client.id === 'codex' && result.changed === false &&
        result.notes && result.notes.includes('config.toml already defines hooks'))) {
    shimChanged = writeCaptureShim(homeDir, sourceId);
  }

  return {
    changed: Boolean(result.changed || shimChanged),
    hookPath: shimPath,
    configPath: client.captureConfigPath,
    ...(result.notes ? { notes: result.notes } : {}),
  };
}

/**
 * Read-only probe for `auxilo status`: a client's capture hook counts as
 * registered when the shim file exists AND the hook config references it.
 * Never throws (missing/malformed config reads as "not registered").
 */
function captureHookRegistered(client, homeDir) {
  if (!client || !client.captureHook || !client.captureConfigPath) return false;
  const shimPath = captureShimPath(homeDir, client.sourceId || client.id);
  try {
    return fs.existsSync(shimPath) &&
      fs.readFileSync(client.captureConfigPath, 'utf-8').includes(shimPath);
  } catch {
    return false;
  }
}

/**
 * Register capture hooks for every captureHook-capable client in `clients`.
 * Ensures the capture core is installed under <home>/.auxilo/bin first (it
 * ships via RUNNER_STACK; installRunner normally ran already — this is the
 * belt-and-braces copy for partial installs). Per-client try/catch: one
 * malformed config skips loudly (B15) without stopping the loop.
 *
 * @param {string} homeDir
 * @param {Array<object>} clients  Registry entries (e.g. the user's chosen set).
 * @param {object} [opts] { packageRoot }
 * @returns {Array<{ id, name, event, changed?, hookPath?, configPath?, notes?, error? }>}
 */
function installCaptureHooks(homeDir, clients, opts = {}) {
  if (!homeDir) throw new Error('installCaptureHooks: homeDir is required');
  const packageRoot = opts.packageRoot || PACKAGE_ROOT;
  const results = [];

  const targets = (clients || []).filter((c) => c && c.captureHook);
  if (targets.length === 0) return results;

  // Ensure the shared capture core exists where the shims point.
  const corePath = path.join(binRootFor(homeDir), 'scripts', 'capture-core.js');
  if (!fs.existsSync(corePath)) {
    const src = path.join(packageRoot, 'scripts', 'capture-core.js');
    if (!fs.existsSync(src)) {
      throw new Error(`installCaptureHooks: missing package file ${src} — reinstall auxilo-mcp`);
    }
    fs.mkdirSync(path.dirname(corePath), { recursive: true });
    fs.copyFileSync(src, corePath);
    fs.chmodSync(corePath, 0o755);
  }

  for (const client of targets) {
    try {
      const r = registerCaptureHook(client, homeDir);
      results.push({ id: client.id, name: client.name, event: client.captureEvent, ...r });
    } catch (err) {
      // B15 skip-loudly: collect the error, keep going for the other clients.
      results.push({ id: client.id, name: client.name, event: client.captureEvent, error: err.message });
    }
  }
  return results;
}

// ─── Consent (spec §LW-12 step 5; server.js POST /extract/consent) ──────────

/**
 * Record extraction consent grant/revoke on the server.
 *
 * @param {object} opts
 * @param {'grant'|'revoke'} opts.action
 * @param {string}   opts.apiKey
 * @param {string}   [opts.baseUrl=DEFAULT_BASE_URL]
 * @param {Function} [opts.fetchImpl=fetch]
 * @returns {Promise<object>} server response body
 */
async function recordConsent(opts = {}) {
  const { action, apiKey } = opts;
  if (action !== 'grant' && action !== 'revoke') {
    throw new Error('recordConsent: action must be "grant" or "revoke"');
  }
  if (!apiKey) throw new Error('recordConsent: apiKey is required');
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl || fetch;

  const res = await fetchImpl(`${baseUrl}/extract/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ action }),
  });
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    throw new Error(`Consent ${action} failed (HTTP ${res.status}): ${body.error || 'unknown error'}`);
  }
  return body;
}

// ─── Kill-switch sentinel (spec §LW-12 step 5 / `auxilo disable`) ───────────

function sentinelPath(homeDir) {
  return path.join(homeDir, '.auxilo', 'autonomous-enabled');
}

function sentinelPresent(homeDir) {
  return fs.existsSync(sentinelPath(homeDir));
}

/** Create the autonomous-extraction sentinel. Only called after explicit consent. */
function enableSentinel(homeDir) {
  const p = sentinelPath(homeDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `enabled ${new Date().toISOString()}\n`);
  return p;
}

/** Remove the sentinel (local kill-switch). Returns true if it existed. */
function disableSentinel(homeDir) {
  const p = sentinelPath(homeDir);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

// ─── Status (spec §LW-12 `auxilo status`) ───────────────────────────────────

/**
 * Collect installer/extraction status for `auxilo status`.
 * Network lookups are best-effort; everything else is local file probes.
 *
 * @param {string} homeDir
 * @param {object} [opts]  { platform, env, fetchImpl }
 * @returns {Promise<object>}
 */
async function getStatus(homeDir, opts = {}) {
  if (!homeDir) throw new Error('getStatus: homeDir is required');
  const fetchImpl = opts.fetchImpl || fetch;

  // 1. Clients: detected + whether MCP registration is present
  const clients = detectClients(homeDir, opts).map((c) => {
    // null = not applicable (no MCP config); per-format probe otherwise (UC-0).
    const registered = c.mcp ? mcpRegistrationPresent(c) : null;
    const base = { id: c.id, name: c.name, mcp: c.mcp, registered };
    // UC-1: capture-hook probe (shim exists AND hook config references it).
    if (c.captureHook) {
      base.captureHook = true;
      base.captureEvent = c.captureEvent;
      base.captureRegistered = captureHookRegistered(c, homeDir);
    }
    return base;
  });

  // 2. Auth state
  const creds = readCredentials(homeDir);
  const auth = {
    credentialsFile: fs.existsSync(credentialsPath(homeDir)),
    keyPrefix: creds && creds.api_key ? `${String(creds.api_key).slice(0, 8)}…` : null,
    email: (creds && creds.email) || null,
    baseUrl: (creds && creds.base_url) || null,
  };

  // 3. Account mode (best-effort — server may be unreachable or route absent)
  let accountMode = 'unknown';
  if (creds && creds.api_key) {
    try {
      const res = await fetchImpl(`${(creds.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '')}/account/settings`, {
        headers: { 'X-API-Key': creds.api_key },
      });
      if (res.ok) {
        const data = await res.json();
        accountMode = data.autonomous_extraction_mode || 'off';
      }
    } catch { /* unreachable */ }
  }

  // 4. Sentinel + runner + hook install state
  const hookPath = hookScriptPathFor(homeDir);
  const runnerInstalled = fs.existsSync(path.join(binRootFor(homeDir), 'scripts', 'runner.js'));
  let hookRegistered = false;
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf-8')
    );
    // LW-17: only STRUCTURED entries count — Claude Code silently ignores
    // bare-string entries (the 0.8.1 dead-hook bug), so reporting one as
    // "registered" would mask exactly the failure this status exists to catch.
    hookRegistered = Array.isArray(settings.hooks && settings.hooks.SessionEnd) &&
      settings.hooks.SessionEnd.some((h) =>
        h && typeof h === 'object' && Array.isArray(h.hooks) && h.hooks.some(isAuxiloCommandHook));
  } catch { /* no settings */ }

  // 5. Last extraction + pending queue (ledger conventions from scripts/runner.js)
  let lastSweep = null;
  try {
    lastSweep = JSON.parse(
      fs.readFileSync(path.join(homeDir, '.auxilo', 'ledger.json'), 'utf-8')
    ).lastSweep || null;
  } catch { /* no ledger yet */ }

  let pendingCount = 0;
  try {
    pendingCount = fs.readdirSync(path.join(homeDir, '.auxilo', 'pending-learnings'))
      .filter((f) => f.endsWith('.json')).length;
  } catch { /* no queue dir yet */ }

  return {
    clients,
    auth,
    accountMode,
    sentinel: sentinelPresent(homeDir),
    runnerInstalled,
    hookInstalled: fs.existsSync(hookPath),
    hookRegistered,
    lastSweep,
    pendingCount,
  };
}

// ─── Rules-file snippet (UC-0 "agent-prompted contribution", R-class) ────────

/** Fenced-block markers: everything between them is ours to replace. */
const RULES_MARKER_BEGIN = '<!-- auxilo:begin -->';
const RULES_MARKER_END = '<!-- auxilo:end -->';

/**
 * The instruction written into agents' GLOBAL rules files (R-class fallback,
 * BUILD-SPEC-UNIVERSAL-CLIENTS §3). Mirrors the auxilo_contribute contract:
 * quality gate >= 14/20, no credentials/PII, and the R-class recursion guard
 * (never contribute from an Auxilo-extraction session — §6).
 */
const RULES_SNIPPET = `## Auxilo: contribute what you learn

At the end of a completed task, if you solved a non-trivial problem — one that
required debugging, multiple attempts, a workaround, or undocumented behavior —
submit the learning to the Auxilo marketplace by calling the
\`auxilo_contribute\` MCP tool. Only submit when the learning self-assesses at
14/20 or higher across specificity, actionability, novelty, and completeness.
Never include credentials, API keys, or PII in a submission, and never submit
from an Auxilo-extraction session.`;

/**
 * Write the Auxilo contribution snippet into one or more GLOBAL rules files
 * (UC-0 scope: client-global files only — e.g. ~/.gemini/GEMINI.md — never
 * project-level AGENTS.md). Idempotent replace-between-markers: an existing
 * fenced block is replaced in place; otherwise the block is appended,
 * preserving all surrounding content. Writes are tmp + rename.
 *
 * @param {string} homeDir  Explicit home (consistency guard — paths must live
 *                          under it; tests run on fixture homes only).
 * @param {object} opts
 * @param {string[]} opts.targets  Absolute rules-file paths to write.
 * @returns {Array<{ path: string, changed: boolean }>} one result per target
 */
function installRulesSnippet(homeDir, opts = {}) {
  if (!homeDir) throw new Error('installRulesSnippet: homeDir is required');
  const targets = opts.targets || [];
  const block = `${RULES_MARKER_BEGIN}\n${RULES_SNIPPET}\n${RULES_MARKER_END}`;
  const results = [];

  for (const target of targets) {
    const raw = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
    const begin = raw.indexOf(RULES_MARKER_BEGIN);
    const end = raw.indexOf(RULES_MARKER_END);

    let next;
    if (begin !== -1 && end !== -1 && end > begin) {
      // Replace ONLY between (and including) the markers; surrounding content untouched.
      next = raw.slice(0, begin) + block + raw.slice(end + RULES_MARKER_END.length);
    } else if (raw === '') {
      next = `${block}\n`;
    } else {
      next = raw + (raw.endsWith('\n') ? '' : '\n') + `\n${block}\n`;
    }

    if (next === raw) {
      results.push({ path: target, changed: false });
      continue;
    }
    const tmp = `${target}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, target);
    results.push({ path: target, changed: true });
  }
  return results;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  MCP_ENTRY,
  DEFAULT_BASE_URL,
  PACKAGE_ROOT,
  RUNNER_STACK,
  clientRegistry,
  detectClients,
  registerMcp,
  mcpRegistrationPresent,
  readClientConfig,
  RULES_MARKER_BEGIN,
  RULES_MARKER_END,
  RULES_SNIPPET,
  installRulesSnippet,
  credentialsPath,
  readCredentials,
  writeCredentials,
  deviceLogin,
  binRootFor,
  hookScriptPathFor,
  renderHookScript,
  installRunner,
  registerClaudeCodeHook,
  captureShimPath,
  renderCaptureShim,
  registerCaptureHook,
  captureHookRegistered,
  installCaptureHooks,
  recordConsent,
  sentinelPath,
  sentinelPresent,
  enableSentinel,
  disableSentinel,
  getStatus,
};
