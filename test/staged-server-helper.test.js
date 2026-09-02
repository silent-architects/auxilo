'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const {
  BOOT_SANDBOX_SKIP_REASON,
  classifyBootFailure,
} = require('./helpers/staged-server');

it('classifies staged-server boot outcomes without hiding real failures', () => {
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
});
