'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {
  BOOT_SANDBOX_SKIP_REASON,
  bootServer,
  claimPort,
  classifyBootFailure,
  isPortFree,
  reservePort,
  stopServer,
} = require('./helpers/staged-server');

function hold(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    const onListening = () => resolve(server);
    if (host === undefined) server.listen(0, onListening);
    else server.listen(0, host, onListening);
  });
}

const release = (server) => new Promise((resolve) => server.close(resolve));

it('classifies staged-server boot outcomes without hiding real failures', async () => {
  const cases = [
    {
      name: 'an occupied listen socket is retryable',
      input: { output: 'Error: listen EADDRINUSE: address already in use 0.0.0.0:49152' },
      expected: { type: 'retry', code: 'EADDRINUSE' },
    },
    {
      name: 'listen EPERM is the one environmental skip',
      input: { output: 'Error: listen EPERM: operation not permitted 0.0.0.0:49152' },
      expected: {
        type: 'skip',
        code: 'EPERM',
        skipReason: BOOT_SANDBOX_SKIP_REASON,
      },
    },
    {
      name: 'an unrelated EPERM is a real failure',
      input: {
        output: 'Error: open EPERM: operation not permitted',
        error: Object.assign(new Error('open EPERM'), { code: 'EPERM', syscall: 'open' }),
      },
      expected: { type: 'failure', code: 'EPERM' },
    },
    {
      name: 'a missing staged module is a real failure',
      input: { output: "Error: Cannot find module './config/account-vocab.json'\ncode: 'MODULE_NOT_FOUND'" },
      expected: { type: 'failure', code: 'MODULE_NOT_FOUND' },
    },
    {
      name: 'a timeout with partial startup output is a real failure',
      input: { output: 'Auxilo v0.9.10 starting on port 49152...\nCatalog loaded', timedOut: true },
      expected: { type: 'failure', code: 'BOOT_TIMEOUT' },
    },
  ];

  for (const testCase of cases) {
    assert.deepEqual(
      classifyBootFailure(testCase.input),
      testCase.expected,
      testCase.name,
    );
  }

  // Reservations probe the family the staged server binds (`::`) as well as the
  // 127.0.0.1 address the tests dial, and never hand one port out twice.
  for (const host of [undefined, '127.0.0.1']) {
    const holder = await hold(host);
    const { port } = holder.address();
    assert.equal(await isPortFree(port), false, `a listener on ${host || '::'} occupies the port`);
    await release(holder);
    assert.equal(await isPortFree(port), true, 'the port is free once released');
  }

  const reservations = [];
  for (let i = 0; i < 25; i += 1) reservations.push(await reservePort());
  if (reservations[0].skipReason) {
    assert.equal(reservations[0].skipReason, BOOT_SANDBOX_SKIP_REASON);
    return;
  }
  const ports = reservations.map((reservation) => reservation.port);
  assert.equal(new Set(ports).size, ports.length, 'reserved ports are distinct');

  const claimed = ports[0];
  assert.equal(claimPort(claimed), false, 'a port claimed by a live process cannot be claimed again');

  // A retry after EADDRINUSE moves to a fresh port instead of repeating the
  // collision (the first holder never goes away).
  const busy = await hold();
  const busyPort = busy.address().port;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-server-helper-'));
  let boot;
  try {
    fs.writeFileSync(path.join(tmpDir, 'server.js'), [
      `const PORT = ${busyPort};`,
      "const server = require('node:net').createServer();",
      "server.once('error', (error) => { console.error(String(error)); process.exit(1); });",
      "server.listen(PORT, () => console.log(`Auxilo running at http://0.0.0.0:${PORT} ${process.env.STAGED_BASE_URL}`));",
    ].join('\n'));
    boot = await bootServer({
      tmpDir,
      port: busyPort,
      env: { STAGED_BASE_URL: `http://127.0.0.1:${busyPort}` },
      timeoutMs: 15_000,
      maxAttempts: 2,
      retryDelayMs: 0,
    });
    if (boot.skipReason) {
      assert.equal(boot.skipReason, BOOT_SANDBOX_SKIP_REASON);
      return;
    }
    assert.equal(boot.attempts, 2);
    assert.notEqual(boot.port, busyPort);
    assert.equal(boot.baseUrl, `http://127.0.0.1:${boot.port}`);
    assert.ok(boot.output.includes(`${boot.baseUrl}`), 'port-bearing env values follow the fresh port');
    assert.match(fs.readFileSync(path.join(tmpDir, 'server.js'), 'utf8'), new RegExp(`^const PORT = ${boot.port};$`, 'm'));
  } finally {
    if (boot && boot.child) await stopServer(boot.child);
    await release(busy);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
