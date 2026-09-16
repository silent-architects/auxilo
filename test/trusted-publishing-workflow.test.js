'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'publish.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');

function stepScript(name) {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `missing step: ${name}`);
  assert.equal(lines[start + 1], '        run: |');
  const script = [];
  for (let i = start + 2; i < lines.length && !lines[i].startsWith('      - name: '); i += 1) {
    if (lines[i].startsWith('          ')) script.push(lines[i].slice(10));
  }
  return script.join('\n');
}

test('T8: workflow_dispatch is the only trigger and version is required', () => {
  const trigger = workflow.match(/^on:\n([\s\S]*?)^permissions:/m);
  assert.ok(trigger);
  assert.match(trigger[1], /^  workflow_dispatch:$/m);
  assert.match(trigger[1], /^      version:$/m);
  assert.match(trigger[1], /^        required: true$/m);
  assert.match(trigger[1], /^        type: string$/m);
  assert.deepEqual([...trigger[1].matchAll(/^  ([\w-]+):$/gm)].map((match) => match[1]), ['workflow_dispatch']);
});

test('T9: OIDC and read-only contents permissions are top-level', () => {
  assert.match(workflow, /^permissions:\n  contents: read\n  id-token: write\n/m);
});

test('T10: workflow has no stored-token, secret, or OTP reference', () => {
  assert.doesNotMatch(workflow, /secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN|--otp/);
});

test('T11: hosted runner, setup-node v7, uncached Node 22, and npm floor', () => {
  assert.match(workflow, /^    runs-on: ubuntu-latest$/m);
  assert.match(workflow, /^        uses: actions\/setup-node@v7$/m);
  assert.doesNotMatch(workflow, /actions\/setup-node@v[456]/);
  assert.match(workflow, /^          node-version: '22'$/m);
  assert.match(workflow, /^          package-manager-cache: false$/m);
  assert.doesNotMatch(workflow, /^\s+(?:registry-url|cache|scope):/m);
  assert.match(workflow, /npm install -g npm@\^11\.6\.0/);
  assert.match(workflow, /npm >= 11\.5\.1 required/);
});

test('T12: release checks and auth assertion precede publish in order', () => {
  const markers = [
    'uses: actions/checkout@v4',
    'fetch-depth: 0',
    'uses: actions/setup-node@v7',
    'npm install -g npm@^11.6.0',
    'run: npm ci',
    '- name: Require the requested package version',
    'run: bash scripts/check-test-count.sh',
    'run: bash scripts/predeploy-check.sh',
    '- name: Assert no injected registry auth',
    'run: npm publish',
  ];
  let previous = -1;
  for (const marker of markers) {
    const position = workflow.indexOf(marker);
    assert.ok(position > previous, `${marker} missing or out of order`);
    previous = position;
  }
  const assertStep = workflow.indexOf('      - name: Assert no injected registry auth');
  const publishStep = workflow.indexOf('      - name: Publish to npm with OIDC');
  assert.ok(assertStep < publishStep);
  assert.doesNotMatch(workflow.slice(assertStep + '      - name: Assert no injected registry auth'.length, publishStep), /^      - name: /m);
});

test('T13: publish job is gated to refs/heads/main', () => {
  assert.match(workflow, /^  publish:\n    if: github\.ref == 'refs\/heads\/main'$/m);
});

test('T14: npm-configured publish.yml filename exists', () => {
  assert.equal(path.basename(workflowPath), 'publish.yml');
  assert.equal(fs.existsSync(workflowPath), true);
});

test('T15: resolved user/global and repository auth files fail closed without disclosure', () => {
  const script = stepScript('Assert no injected registry auth');
  assert.match(script, /npm config get userconfig/);
  assert.match(script, /npm config get globalconfig/);
  assert.match(script, /for config in \.npmrc "\$userconfig" "\$globalconfig"/);
  assert.match(script, /grep -Fq '_authToken'/);
  assert.doesNotMatch(script, /\$HOME\/\.npmrc|grep -l|cat /);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-publish-test-'));
  try {
    const repo = path.join(root, 'repo');
    const home = path.join(root, 'home');
    const runnerTemp = path.join(root, 'runner-temp');
    const bin = path.join(root, 'bin');
    for (const dir of [repo, home, runnerTemp, bin]) fs.mkdirSync(dir);
    const userconfig = path.join(runnerTemp, '.npmrc');
    const globalconfig = path.join(root, 'global.npmrc');
    const repoConfig = path.join(repo, '.npmrc');
    const npmStub = path.join(bin, 'npm');
    fs.writeFileSync(npmStub,
      '#!/bin/sh\n' +
      'case "$1 $2 $3" in\n' +
      '  "config get userconfig") printf "%s\\n" "$TEST_USERCONFIG" ;;\n' +
      '  "config get globalconfig") printf "%s\\n" "$TEST_GLOBALCONFIG" ;;\n' +
      '  *) exit 2 ;;\n' +
      'esac\n',
      { mode: 0o755 });
    const invoke = () => spawnSync('bash', ['-e', '-c', script], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        HOME: home,
        PATH: `${bin}:${process.env.PATH || ''}`,
        TEST_USERCONFIG: userconfig,
        TEST_GLOBALCONFIG: globalconfig,
      },
    });
    assert.equal(invoke().status, 0, 'clean configuration must pass');
    for (const config of [userconfig, globalconfig, repoConfig]) {
      fs.writeFileSync(config, '//registry.npmjs.org/:_authToken=fixture-secret\n');
      const result = invoke();
      assert.equal(result.status, 1, `auth in ${path.basename(config)} must refuse`);
      assert.equal(result.stdout.trim(), 'refusing to publish: injected registry auth detected');
      assert.equal(result.stderr, '');
      assert.doesNotMatch(result.stdout, /fixture-secret|runner-temp|global\.npmrc|repo/);
      fs.unlinkSync(config);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
