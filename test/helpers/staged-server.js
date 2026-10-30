'use strict';

/**
 * Shared staged-server test harness.
 *
 * Boot triage: fast + EPERM = environmental sandbox; ~20s + partial log =
 * starvation; anything else = real failure.
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BOOT_SANDBOX_SKIP_REASON = 'sandbox denies loopback bind';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 3_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const WALLET_SOURCE = /^const WALLET = '0x[0-9a-fA-F]{40}';$/m;
const WALLET_STAGED = "const WALLET = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';";
const PORT_SOURCE = 'const PORT = 3000;';
const CLOSED_CHILDREN = new WeakSet();
const PORT_SOURCE_LINE = /^const PORT = \d+;$/m;
const PORT_CLAIM_DIR = path.join(os.tmpdir(), 'auxilo-staged-server-ports');
const PORT_CLAIM_TTL_MS = 30 * 60_000;
const MAX_RESERVE_ATTEMPTS = 50;
const PORT_CLAIM_WRITE_WINDOW_MS = 10_000;
const OWN_PORT_CLAIMS = new Set();
let claimExitHookInstalled = false;

function listenError(error, code) {
  return Boolean(error && error.code === code && error.syscall === 'listen');
}

// Binds the port the way the staged server does (no host, so all interfaces)
// and also on 127.0.0.1, because the tests reach the server there and a
// loopback-only listener (a mock server) would otherwise answer in its place.
// A 127.0.0.1-only probe cannot see a live `::` listener, which is what every
// other staged server is.
function listenOnce(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve({ error }));
    const onListening = () => resolve({ server, port: server.address().port });
    if (host === undefined) server.listen(port, onListening);
    else server.listen(port, host, onListening);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// The two binds run one after the other. On Linux a dual-stack `::` listener
// also holds the IPv4 port, so binding 127.0.0.1 while it is open always fails
// with EADDRINUSE; macOS allows both at once. Claim files, not the probe, keep
// concurrent test files apart, so the gap between the two binds is acceptable.
async function probePort(port = 0) {
  const wide = await listenOnce(port);
  if (wide.error) return { error: wide.error };
  await closeServer(wide.server);

  const loopback = await listenOnce(wide.port, '127.0.0.1');
  if (loopback.error) return { error: loopback.error };
  await closeServer(loopback.server);
  return { port: wide.port };
}

async function isPortFree(port) {
  const result = await probePort(port);
  if (!result.error) return true;
  if (listenError(result.error, 'EADDRINUSE')) return false;
  throw result.error;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function releaseOwnPortClaims() {
  for (const file of OWN_PORT_CLAIMS) {
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone
    }
  }
  OWN_PORT_CLAIMS.clear();
}

// The OS hands the same free port to whichever process asks next, and a test
// file may wait seconds between reserving a port and the server binding it.
// A claim file per port, owned by the reserving process, keeps concurrent test
// files off each other's ports. It is best effort: if the claim directory is
// unusable the reservation still stands on the probe alone.
function claimPort(port) {
  const file = path.join(PORT_CLAIM_DIR, String(port));
  try {
    fs.mkdirSync(PORT_CLAIM_DIR, { recursive: true });
  } catch {
    return true;
  }

  for (let pass = 0; pass < 2; pass += 1) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      OWN_PORT_CLAIMS.add(file);
      if (!claimExitHookInstalled) {
        claimExitHookInstalled = true;
        process.on('exit', releaseOwnPortClaims);
      }
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') return true;
    }

    let owner;
    let ageMs;
    try {
      owner = Number(fs.readFileSync(file, 'utf8'));
      ageMs = Date.now() - fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    // `wx` creates the file before the pid is written, so a claim whose pid is
    // not readable yet is a live claim in that window, not a stale one.
    const ownerKnown = Number.isInteger(owner) && owner > 0;
    if (!ownerKnown && ageMs < PORT_CLAIM_WRITE_WINDOW_MS) return false;
    if (ownerKnown && pidAlive(owner) && ageMs < PORT_CLAIM_TTL_MS) return false;
    try {
      fs.unlinkSync(file);
    } catch {
      // another process reclaimed it first
    }
  }
  return false;
}

async function reservePort() {
  for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS; attempt += 1) {
    const result = await probePort(0);
    if (result.error) {
      if (listenError(result.error, 'EPERM')) {
        return { type: 'skip', skipReason: BOOT_SANDBOX_SKIP_REASON };
      }
      if (listenError(result.error, 'EADDRINUSE')) continue;
      throw result.error;
    }
    if (claimPort(result.port)) return { port: result.port };
  }
  throw new Error(`could not reserve a free port after ${MAX_RESERVE_ATTEMPTS} attempts`);
}

function countMatches(source, search) {
  if (typeof search === 'string') {
    if (search.length === 0) throw new TypeError('replacement search must not be empty');
    return source.split(search).length - 1;
  }

  if (search instanceof RegExp) {
    const flags = search.flags.includes('g') ? search.flags : `${search.flags}g`;
    return Array.from(source.matchAll(new RegExp(search.source, flags))).length;
  }

  throw new TypeError('replacement search must be a string or RegExp');
}

function replaceExactlyOnce(source, { name, search, replace }) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('replacement name must be a non-empty string');
  }

  const matchCount = countMatches(source, search);
  if (matchCount !== 1) {
    throw new Error(`${name}: expected exactly one match, found ${matchCount}`);
  }

  return source.replace(search, replace);
}

function stageServer({
  repoRoot,
  tmpDir,
  nodeModulesDir,
  port,
  rootFiles,
  linkDirs,
  copyDirs = [],
  replacements = [],
}) {
  if (
    !Array.isArray(rootFiles) ||
    !Array.isArray(linkDirs) ||
    !Array.isArray(copyDirs) ||
    !Array.isArray(replacements)
  ) {
    throw new TypeError('rootFiles, linkDirs, copyDirs, and replacements must be arrays');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('port must be an integer between 1 and 65535');
  }

  fs.mkdirSync(tmpDir, { recursive: true });
  for (const file of rootFiles) {
    fs.copyFileSync(path.join(repoRoot, file), path.join(tmpDir, file));
  }

  const serverPath = path.join(tmpDir, 'server.js');
  let staged = fs.readFileSync(serverPath, 'utf8');
  staged = replaceExactlyOnce(staged, {
    name: 'staged WALLET constant',
    search: WALLET_SOURCE,
    replace: WALLET_STAGED,
  });
  staged = replaceExactlyOnce(staged, {
    name: 'staged server port',
    search: PORT_SOURCE,
    replace: `const PORT = ${port};`,
  });
  for (const replacement of replacements) {
    staged = replaceExactlyOnce(staged, replacement);
  }
  fs.writeFileSync(serverPath, staged);

  for (const directory of linkDirs) {
    const source = path.join(repoRoot, directory);
    fs.symlinkSync(source, path.join(tmpDir, directory));
  }
  for (const directory of copyDirs) {
    const source = path.join(repoRoot, directory);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, path.join(tmpDir, directory), { recursive: true });
  }
  fs.statSync(nodeModulesDir);
  fs.symlinkSync(nodeModulesDir, path.join(tmpDir, 'node_modules'));
  // The server-only native runtime is excluded from the MCP package. Fixtures
  // use the current host's built addon; container proofs build their own ABI.
  const serverRuntime = path.join(repoRoot, 'server-runtime');
  if (fs.existsSync(serverRuntime) && !fs.existsSync(path.join(tmpDir, 'server-runtime'))) {
    fs.symlinkSync(serverRuntime, path.join(tmpDir, 'server-runtime'));
  }

  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir);
  // D0 fixtures explicitly initialize an authoritative primary. Corruption/missing
  // primary tests remove or replace this before boot; production never creates it.
  fs.writeFileSync(path.join(dataDir, 'earnings.json'), '{}\n', { flag: 'wx' });
  const walDir = path.join(dataDir, 'wal');
  fs.mkdirSync(walDir);
  return { dataDir, walDir, serverPath };
}

function classifyBootFailure({ output = '', error = null, timedOut = false } = {}) {
  if (
    listenError(error, 'EADDRINUSE') ||
    /\blisten EADDRINUSE\b/.test(output)
  ) {
    return { type: 'retry', code: 'EADDRINUSE' };
  }

  if (
    listenError(error, 'EPERM') ||
    /\blisten EPERM\b/.test(output)
  ) {
    return {
      type: 'skip',
      code: 'EPERM',
      skipReason: BOOT_SANDBOX_SKIP_REASON,
    };
  }

  if (timedOut) {
    return { type: 'failure', code: 'BOOT_TIMEOUT' };
  }

  if (/\bMODULE_NOT_FOUND\b|Cannot find module/.test(output)) {
    return { type: 'failure', code: 'MODULE_NOT_FOUND' };
  }

  return {
    type: 'failure',
    code: error && error.code ? error.code : 'BOOT_FAILED',
  };
}

function runBootAttempt({ tmpDir, port, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    let timer;
    let output = '';
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        child,
        output,
        getOutput: () => output,
        ...result,
      });
    };

    try {
      child = spawn(process.execPath, ['server.js'], {
        cwd: tmpDir,
        env: {
          ...process.env,
          AUXILO_WAL_DIR: path.join(tmpDir, 'data', 'wal'),
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      settle({ error, ready: false, timedOut: false });
      return;
    }

    child.once('close', (code, signal) => {
      CLOSED_CHILDREN.add(child);
      settle({ code, signal, ready: false, timedOut: false });
    });
    child.once('error', (error) => {
      settle({ error, ready: false, timedOut: false });
    });

    const readyMarker = `Auxilo running at http://0.0.0.0:${port}`;
    const onData = (buffer) => {
      output += buffer.toString();
      if (output.includes(readyMarker)) {
        settle({ ready: true, timedOut: false });
        return;
      }

      const classification = classifyBootFailure({ output });
      if (
        classification.type !== 'failure' ||
        classification.code === 'MODULE_NOT_FOUND'
      ) {
        settle({ ready: false, timedOut: false });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    timer = setTimeout(() => {
      settle({ ready: false, timedOut: true });
    }, timeoutMs);
  });
}

function stopServer(child, signal = 'SIGKILL') {
  if (!child || CLOSED_CHILDREN.has(child)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const onClose = () => {
      CLOSED_CHILDREN.add(child);
      resolve();
    };
    child.once('close', onClose);

    if (child.exitCode !== null || child.signalCode !== null) return;

    try {
      child.kill(signal);
    } catch (error) {
      child.removeListener('close', onClose);
      reject(error);
    }
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bootError(classification, attempt, output, cause) {
  const tail = output.slice(-2_000);
  const error = new Error(
    `staged server boot failed on attempt ${attempt} (${classification.code}).` +
    `${tail ? ` Output tail:\n${tail}` : ''}`,
    cause ? { cause } : undefined,
  );
  error.code = classification.code;
  error.output = output;
  return error;
}

// A retry after EADDRINUSE must not reuse the port: whatever holds it (usually
// another test's live server) is not going away. Re-stage the server on a
// fresh port; callers must read the port from the returned `port`/`baseUrl`.
async function restageOnFreshPort({ tmpDir, port, env }) {
  const reservation = await reservePort();
  if (reservation.skipReason) return reservation;

  const serverPath = path.join(tmpDir, 'server.js');
  const staged = replaceExactlyOnce(fs.readFileSync(serverPath, 'utf8'), {
    name: 'staged server port',
    search: PORT_SOURCE_LINE,
    replace: `const PORT = ${reservation.port};`,
  });
  fs.writeFileSync(serverPath, staged);

  const oldPort = new RegExp(`(?<![0-9])${port}(?![0-9])`, 'g');
  const nextEnv = {};
  for (const [key, value] of Object.entries(env)) {
    nextEnv[key] = typeof value === 'string'
      ? value.replace(oldPort, String(reservation.port))
      : value;
  }
  return { port: reservation.port, env: nextEnv };
}

async function bootServer({
  tmpDir,
  port,
  env = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('port must be an integer between 1 and 65535');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('maxAttempts must be a positive integer');
  }

  let bootPort = port;
  let bootEnv = env;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runBootAttempt({ tmpDir, port: bootPort, env: bootEnv, timeoutMs });
    if (result.ready) {
      return {
        child: result.child,
        port: bootPort,
        baseUrl: `http://127.0.0.1:${bootPort}`,
        output: result.output,
        getOutput: result.getOutput,
        attempts: attempt,
      };
    }

    const classification = classifyBootFailure(result);
    await stopServer(result.child);

    if (classification.type === 'skip') {
      return {
        type: 'skip',
        skipReason: classification.skipReason,
        output: result.output,
        attempts: attempt,
      };
    }

    if (classification.type === 'retry' && attempt < maxAttempts) {
      await delay(retryDelayMs);
      let fresh;
      try {
        fresh = await restageOnFreshPort({ tmpDir, port: bootPort, env: bootEnv });
      } catch (error) {
        throw bootError(classification, attempt, result.output, error);
      }
      if (fresh.skipReason) {
        return { type: 'skip', skipReason: fresh.skipReason, output: result.output, attempts: attempt };
      }
      bootPort = fresh.port;
      bootEnv = fresh.env;
      continue;
    }

    throw bootError(classification, attempt, result.output, result.error);
  }

  throw new Error('unreachable staged-server boot state');
}

module.exports = {
  BOOT_SANDBOX_SKIP_REASON,
  bootServer,
  claimPort,
  classifyBootFailure,
  isPortFree,
  reservePort,
  stageServer,
  stopServer,
};
