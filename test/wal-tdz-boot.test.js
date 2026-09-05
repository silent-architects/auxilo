'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');

// Parse with the Acorn copy bundled inside the Node 20 runtime used by CI. The
// child flag exposes Node internals only to this read-only analyzer process;
// production code and the server process never rely on an internal module.
const ANALYZER = String.raw`
const acorn = require('internal/deps/acorn/acorn/dist/acorn');
const fs = require('node:fs');

const serverPath = process.argv[1];
const source = fs.readFileSync(serverPath, 'utf8');
const ast = acorn.parse(source, {
  ecmaVersion: 'latest',
  sourceType: 'script',
  locations: true,
});

const startupCall = source.indexOf('recoverWalEntries();');
const phaseTwo = source.indexOf('// Phase 2: Independent async startup tasks', startupCall);
if (startupCall < 0 || phaseTwo < 0) {
  throw new Error('startup recovery boundaries not found');
}
const bootEndLine = source.slice(0, phaseTwo).split('\n').length;

function patternNames(pattern, names = []) {
  if (!pattern) return names;
  if (pattern.type === 'Identifier') names.push(pattern.name);
  else if (pattern.type === 'RestElement') patternNames(pattern.argument, names);
  else if (pattern.type === 'AssignmentPattern') patternNames(pattern.left, names);
  else if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) patternNames(element, names);
  } else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      patternNames(property.type === 'RestElement' ? property.argument : property.value, names);
    }
  }
  return names;
}

const topLevelBindings = new Map();
const callableBodies = new Map();
for (const statement of ast.body) {
  if (statement.type === 'VariableDeclaration' && (statement.kind === 'const' || statement.kind === 'let')) {
    for (const declaration of statement.declarations) {
      for (const name of patternNames(declaration.id)) {
        topLevelBindings.set(name, {
          name,
          kind: statement.kind,
          line: declaration.loc.start.line,
        });
      }
      if (
        declaration.id.type === 'Identifier' &&
        declaration.init &&
        (declaration.init.type === 'ArrowFunctionExpression' || declaration.init.type === 'FunctionExpression')
      ) {
        callableBodies.set(declaration.id.name, declaration.init.body);
      }
    }
  } else if (statement.type === 'FunctionDeclaration' && statement.id) {
    callableBodies.set(statement.id.name, statement.body);
  }
}

function isReferenceIdentifier(node, parent, key) {
  if (!parent) return true;
  if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return false;
  if (parent.type === 'Property' && key === 'key' && !parent.computed && parent.value !== node) return false;
  if (parent.type === 'MethodDefinition' && key === 'key' && !parent.computed) return false;
  if (parent.type === 'VariableDeclarator' && key === 'id') return false;
  if (
    (parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ArrowFunctionExpression') &&
    (key === 'id' || key === 'params')
  ) return false;
  if ((parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') && key === 'label') return false;
  if (parent.type === 'CatchClause' && key === 'param') return false;
  return true;
}

function walk(node, visitor, parent = null, key = null) {
  if (!node || typeof node !== 'object') return;
  visitor(node, parent, key);
  for (const [childKey, child] of Object.entries(node)) {
    if (childKey === 'loc' || childKey === 'start' || childKey === 'end') continue;
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visitor, node, childKey);
    } else if (child && typeof child.type === 'string') {
      walk(child, visitor, node, childKey);
    }
  }
}

const referenced = new Set();
const queued = [];
const reachable = new Set();
function collect(node) {
  walk(node, (current, parent, key) => {
    if (current.type === 'Identifier' && isReferenceIdentifier(current, parent, key)) {
      referenced.add(current.name);
    }
    if (
      current.type === 'CallExpression' &&
      current.callee.type === 'Identifier' &&
      callableBodies.has(current.callee.name) &&
      !reachable.has(current.callee.name)
    ) {
      reachable.add(current.callee.name);
      queued.push(current.callee.name);
    }
  });
}

for (const statement of ast.body) {
  if (statement.end <= startupCall || statement.start >= phaseTwo) continue;
  collect(statement);
}
while (queued.length > 0) {
  collect(callableBodies.get(queued.shift()));
}

const late = [...referenced]
  .map((name) => topLevelBindings.get(name))
  .filter((binding) => binding && binding.line > bootEndLine)
  .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));

process.stdout.write(JSON.stringify({ late, reachable: [...reachable].sort() }));
`;

function analyzeStartupBindings() {
  const result = spawnSync(
    process.execPath,
    ['--expose-internals', '-e', ANALYZER, SERVER_PATH],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('startup recovery has no transitive top-level const/let dependency declared after it', () => {
  const analysis = analyzeStartupBindings();
  for (const expectedCallable of [
    'recoverWalEntries',
    'appendSettlement',
    'invalidateCachedSettlement',
    'commitReservation',
    'releaseReservation',
    'loadReservations',
    'saveReservations',
  ]) {
    assert.ok(
      analysis.reachable.includes(expectedCallable),
      `transitive call graph did not reach ${expectedCallable}`,
    );
  }
  assert.deepEqual(
    analysis.late,
    [],
    `startup recovery references top-level bindings declared after it:\n${analysis.late
      .map((binding) => `${binding.name} (${binding.kind}, line ${binding.line})`)
      .join('\n')}`,
  );
});
