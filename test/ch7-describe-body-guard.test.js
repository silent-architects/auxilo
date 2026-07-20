'use strict';

/**
 * test/ch7-describe-body-guard.test.js — CH-7 meta-guard (PUNCH-LIST §30 CH-7)
 *
 * THE CLASS: an assert placed in a describe() BODY (instead of a test()/it()
 * body) runs at collection time. On Node v24 under the exact npm-test flags
 * (`node --test --test-force-exit test/*.test.js`) it prints ✖ but reports
 * **fail 0 / exit 0** — CI-green silent failure. Verified empirically
 * 2026-07-19: describe-body assert ⇒ exit 0 / fail 0; the SAME assert in a
 * before() hook ⇒ exit 1; in test() ⇒ fail 1 / exit 1. The M5 search-chain
 * mutation (r01-launch-blockers:342) was "caught" only by this class until
 * CH-4 F1 added loud pins.
 *
 * THE GUARD: a lexer-grade scanner (strings / template literals / comments /
 * regex literals incl. char classes; `it('x', {timeout}, fn)` options-object
 * braces; hook callbacks treated as safe) that flags BOTH:
 *   1. literal `assert` usage whose innermost test-harness frame is describe;
 *   2. describe-scope CALLS to file-local functions whose body asserts —
 *      the sliceHandler class, which is the same silent failure one hop away.
 * The scanner is self-tested against known-bad and known-good fixtures below
 * (proving detection), then the repo sweep asserts ZERO findings across
 * test/*.test.js — the class cannot re-enter.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// ─── The scanner ─────────────────────────────────────────────────────────────

/**
 * Pass 1: names of file-local `function NAME(...)` declarations whose body
 * contains an assert call — calling one of these at describe scope is the
 * same silent class as a literal describe-body assert.
 */
function assertBearingHelpers(src) {
  const names = new Set();
  const re = /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const body = src.slice(re.lastIndex, i);
    if (/\bassert\s*[.(]/.test(body)) names.add(m[1]);
  }
  return names;
}

/**
 * Pass 2: lexer walk. Returns findings [{line, word}] — each an assert (or
 * assert-bearing helper call) whose innermost enclosing harness callback is
 * describe().
 */
function scanSource(src) {
  const helperNames = assertBearingHelpers(src);
  const findings = [];
  const stack = []; // { kind: 'describe'|'test', depth }
  let depth = 0;
  let line = 1;
  let pending = null; // opener waiting for its callback-body brace
  let prevWord = '';
  let i = 0;
  const n = src.length;
  let lastSig = '';

  const isRegexContext = () => {
    if (lastSig === '') return true;
    return '(,=:;!&|?{}[+-*%~^<>'.includes(lastSig) || /\breturn$/.test(lastSig);
  };

  while (i < n) {
    const ch = src[i];
    const two = src.slice(i, i + 2);
    if (ch === '\n') { line++; i++; continue; }
    if (two === '//') { while (i < n && src[i] !== '\n') i++; continue; }
    if (two === '/*') {
      i += 2;
      while (i < n && src.slice(i, i + 2) !== '*/') { if (src[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      const q = ch; i++;
      while (i < n && src[i] !== q) { if (src[i] === '\\') i++; if (src[i] === '\n') line++; i++; }
      i++; lastSig = q; continue;
    }
    if (ch === '`') {
      i++;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') i++;
        else if (src[i] === '\n') line++;
        i++;
      }
      i++; lastSig = '`'; continue;
    }
    if (ch === '/' && isRegexContext()) {
      i++;
      let inClass = false;
      while (i < n && (inClass || src[i] !== '/')) {
        if (src[i] === '\\') i++;
        else if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        if (src[i] === '\n') { line++; break; } // regex literals never span lines
        i++;
      }
      i++;
      while (i < n && /[a-z]/i.test(src[i])) i++;
      lastSig = '/';
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      let k = j;
      while (k < n && /\s/.test(src[k])) k++;
      const callish = src[k] === '(';
      if (callish && (word === 'describe' || word === 'suite')) pending = 'describe';
      else if (callish && (word === 'test' || word === 'it' ||
                           word === 'before' || word === 'beforeEach' ||
                           word === 'after' || word === 'afterEach')) {
        // Hook callbacks run at test time and fail LOUD (exit 1, verified on
        // Node 24 + --test-force-exit) — safe like test().
        pending = 'test';
      } else if (word === 'assert' ||
                 (callish && helperNames.has(word) && prevWord !== 'function')) {
        const innermost = stack.length ? stack[stack.length - 1].kind : 'top';
        if (innermost === 'describe') findings.push({ line, word });
      }
      prevWord = word;
      lastSig = word[word.length - 1];
      i = j;
      continue;
    }
    if (ch === '{') {
      depth++;
      // Only a callback BODY brace consumes the pending opener: it follows
      // `=>` (arrow) or `)` (function expr). An options-object brace
      // (`it('x', { timeout: N }, fn)`) follows `(` or `,` — must NOT.
      if (pending && (lastSig === '>' || lastSig === ')')) {
        stack.push({ kind: pending, depth });
        pending = null;
      }
      lastSig = '{'; i++; continue;
    }
    if (ch === '}') {
      while (stack.length && stack[stack.length - 1].depth === depth) stack.pop();
      depth--;
      lastSig = '}'; i++; continue;
    }
    if (ch === ';') { pending = null; lastSig = ';'; i++; continue; }
    if (!/\s/.test(ch)) lastSig = ch;
    i++;
  }
  return findings;
}

// ─── Fixtures: the scanner must CATCH the bad class… ─────────────────────────

const BAD_LITERAL = [
  "describe('x', () => {",
  "  assert.ok(SRC.includes('marker'), 'silent');",
  "  it('t', () => { assert.ok(true); });",
  '});',
].join('\n');

const BAD_HELPER_CALL = [
  'function sliceHandler(marker) {',
  "  const i = SRC.indexOf(marker);",
  "  assert.notEqual(i, -1, 'not found');",
  '  return SRC.slice(i, i + 100);',
  '}',
  "describe('x', () => {",
  "  const h = sliceHandler('app.get');",
  "  it('t', () => { assert.ok(h.includes('y')); });",
  '});',
].join('\n');

const BAD_OPTIONS_OBJECT = [
  "describe('x', () => {",
  "  it('t', { timeout: 60000 }, async () => { assert.ok(true); });",
  '  assert.equal(1, 1);',
  '});',
].join('\n');

// …and must NOT flag the good idioms.

const GOOD = [
  'function sliceHandler(marker) {',
  "  const i = SRC.indexOf(marker);",
  "  assert.notEqual(i, -1, 'not found');",
  '  return SRC.slice(i, i + 100);',
  '}',
  "describe('x', () => {",
  '  let h;',
  "  before(() => { h = sliceHandler('app.get'); });",
  "  it('regex braces are not blocks', () => {",
  "    assert.ok(/\\}, 503\\)/.test(h), 'brace-in-regex');",
  '    assert.ok(/[^}]+/.test(h));',
  '  });',
  "  it('options object', { timeout: 60000 }, async () => {",
  '    assert.equal(`${h.length}`.length >= 1, true);',
  '  });',
  '});',
].join('\n');

// ─── Self-tests (prove detection before trusting the sweep) ──────────────────

describe('CH-7 scanner self-test', () => {
  it('catches a literal describe-body assert', () => {
    const f = scanSource(BAD_LITERAL);
    assert.equal(f.length, 1, JSON.stringify(f));
    assert.equal(f[0].word, 'assert');
  });

  it('catches a describe-scope call to an assert-bearing helper (the sliceHandler class)', () => {
    const f = scanSource(BAD_HELPER_CALL);
    assert.equal(f.length, 1, JSON.stringify(f));
    assert.equal(f[0].word, 'sliceHandler');
  });

  it('an options-object it() does not shield a later describe-body assert', () => {
    const f = scanSource(BAD_OPTIONS_OBJECT);
    assert.equal(f.length, 1, JSON.stringify(f));
  });

  it('does not flag test bodies, before() hooks, regex braces, or template braces', () => {
    const f = scanSource(GOOD);
    assert.deepEqual(f, []);
  });
});

// ─── The sweep: zero describe-body asserts across test/ ──────────────────────

describe('CH-7 repo sweep', () => {
  it('no test file contains a describe-body assert (fail-0/exit-0 silent class)', () => {
    const dir = path.join(__dirname);
    const offenders = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.test.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const hit of scanSource(src)) {
        offenders.push(`${f}:${hit.line} (${hit.word})`);
      }
    }
    assert.deepEqual(offenders, [],
      'Describe-body asserts report fail 0 / exit 0 under the npm-test flags (CI-green silent failure). ' +
      'Move each into a test()/it() body or a before() hook: ' + offenders.join(', '));
  });
});
