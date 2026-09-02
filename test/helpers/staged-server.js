'use strict';

/**
 * Shared staged-server test harness.
 *
 * Boot triage: fast + EPERM = environmental sandbox; ~20s + partial log =
 * starvation; anything else = real failure.
 */

const fs = require('node:fs');
const net = require('node:net');
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

function listenError(error, code) {
  return Boolean(error && error.code === code && error.syscall === 'listen');
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let settled = false;

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    server.once('error', (error) => {
      if (listenError(error, 'EPERM')) {
        settle(resolve, {
          type: 'skip',
          skipReason: BOOT_SANDBOX_SKIP_REASON,
        });
        return;
      }
      settle(reject, error);
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => settle(reject, new Error('reserved server did not expose a TCP port')));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          settle(reject, error);
          return;
        }
        settle(resolve, { port });
      });
    });
  });
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

  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir);
  return { dataDir, serverPath };
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

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runBootAttempt({ tmpDir, port, env, timeoutMs });
    if (result.ready) {
      return {
        child: result.child,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
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
      continue;
    }

    throw bootError(classification, attempt, result.output, result.error);
  }

  throw new Error('unreachable staged-server boot state');
}

module.exports = {
  BOOT_SANDBOX_SKIP_REASON,
  bootServer,
  classifyBootFailure,
  reservePort,
  stageServer,
  stopServer,
};
