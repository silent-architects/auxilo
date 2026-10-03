'use strict';

const fs = require('node:fs');

// Amendment 2: establish probe support using the real adapter's FS seams.
// Other files (including billing-helper settings) still use the real fixture FS.
const supportedClaude = Object.freeze({
  realpathSyncImpl: () => '/fixture/epc2-claude/cli.js',
  readFileSyncImpl: (file, ...args) => file === '/fixture/epc2-claude/package.json'
    ? JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.41' })
    : fs.readFileSync(file, ...args),
});

module.exports = { supportedClaude };
