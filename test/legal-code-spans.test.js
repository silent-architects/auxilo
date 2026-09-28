'use strict';

/**
 * test/legal-code-spans.test.js — BUILD-BRIEF-TERMS-SCROLL.md R2-4, revised
 * under R3-2.
 *
 * serveLegalPage() (server.js) renders a single-backtick pair on ONE line as
 * <code>escaped content</code>, pulled into a placeholder before the bold/
 * italic/link transforms run (both the paragraph pipeline and inlineMd()'s
 * table-cell pass) and restored last, so an asterisk/underscore/bracket
 * inside a span is never transformed, a lone unpaired backtick is left
 * alone, and a span inside a table cell survives.
 *
 * R3-2: the prior version of this file proved "nothing else moved" by
 * comparing against `git show HEAD:server.js` -- once this change is
 * committed that revision IS the new renderer, and the comparison test
 * would fail in CI forever after. This version reads no git history at all.
 * Every construct (bold, italic, link, list, table, fenced block, a code
 * span alone, a code span in a table cell, a code span in a heading, a code
 * span holding an asterisk, one holding "<", a lone backtick) is proved by
 * running synthetic Markdown through the real serveLegalPage on a staged
 * server -- a throwaway COPY of docs/ (stageServer's copyDirs, never
 * linkDirs; the real docs/ tree is never opened for writing) -- and
 * asserting the result against expected HTML written out here.
 *
 * The two checks that need no fixture at all (no backtick anywhere in the
 * four served pages; the /terms amendment id lives in a <code> element) run
 * against the real docs/ tree, read-only.
 *
 * Runner: node --test test/legal-code-spans.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  reservePort,
  stageServer,
  bootServer,
  stopServer,
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const PAGES = [
  { path: '/terms', label: 'terms' },
  { path: '/privacy', label: 'privacy' },
  { path: '/legal/subprocessors', label: 'subprocessors' },
  { path: '/legal/supported-clients', label: 'supported-clients' },
];

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+([.,;:!?)])/g, '$1')
    .trim();
}

// Only the .legal-wrap content -- the shared nav/footer never changes here
// and carries its own unrelated text that is not this fix's concern.
function legalWrap(html) {
  const start = html.indexOf('<div class="legal-wrap">');
  const end = html.indexOf('</div>\n\n<!-- Wave C.3b', start);
  return html.slice(start, end === -1 ? undefined : end);
}

// The synthetic Markdown this file runs through the real renderer, covering
// every construct R3-2 names. Kept as one fixture so the expected-HTML
// assertions below read straight off of it.
const SYNTHETIC_MD = `# Synthetic Test Document

## 1. Numbered Heading

Some **bold text** and some *italic text* and a [real link](https://example.com/page).

- item one
- item two

| Col A | Col B |
|---|---|
| plain | \`code in cell\` |
| x | y |

\`\`\`
fenced block line one
fenced block line two
\`\`\`

A code span alone: \`plain code\`.

## Heading With \`inline code\` Inside

A code span holding an asterisk: \`a*b\`. One holding a less-than sign: \`a<b\`. A lone backtick stays as it is: \` right here and nothing closes it.

A link whose url holds a code span: [broken](/api/\`id\`/details).

## Heading With \`a<b>&c\` Chars
`;

async function bootWithSyntheticDocs({ tmpDir, port, nodeModulesDir }) {
  stageServer({
    repoRoot: REPO,
    tmpDir,
    nodeModulesDir,
    port,
    rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
    linkDirs: [],
    copyDirs: ['lib', 'public', 'prompts', 'config', 'docs'], // a real, independent COPY -- never linkDirs
  });
  // Overwrite the staged COPY only -- the real repo's docs/ is never touched.
  fs.writeFileSync(path.join(tmpDir, 'docs', 'TERMS-OF-SERVICE.md'), SYNTHETIC_MD);
  fs.writeFileSync(path.join(tmpDir, 'data', 'learnings.json'), '[]');
  fs.writeFileSync(path.join(tmpDir, 'data', 'accounts.json'), '{}');
  fs.writeFileSync(path.join(tmpDir, 'data', 'earnings.json'), '{}');
  fs.writeFileSync(path.join(tmpDir, 'data', 'magic_links.json'), '{}');
  fs.writeFileSync(path.join(tmpDir, 'data', 'credits.json'), '{}');
  return bootServer({
    tmpDir,
    port,
    env: {
      NODE_ENV: 'test',
      SESSION_SECRET: 'legal-code-spans-synth-session-secret-32b',
      RESEND_API_KEY: '',
      LLM_SENSITIVITY_ENABLED: 'false',
      WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32),
    },
    timeoutMs: 60_000,
    maxAttempts: 3,
  });
}

describe('legal renderer: code spans (R2-4/R3-2/R3-7)', { timeout: 240_000 }, () => {
  let nodeModulesDir;
  let bootSkipReason = null;
  let realTmp; let realBoot;
  let synthTmp; let synthBoot;

  before(async () => {
    try {
      nodeModulesDir = require.resolve('hono', { paths: [REPO] });
      nodeModulesDir = nodeModulesDir.slice(0, nodeModulesDir.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    } catch (e) {
      bootSkipReason = 'hono not resolvable from repo root: ' + e.message;
      return;
    }

    // Server REAL: current server.js, the real docs/ tree, read-only use --
    // the two checks that need no fixture and no history.
    {
      const r = await reservePort();
      if (r.skipReason) { bootSkipReason = r.skipReason; return; }
      realTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-legal-spans-real-'));
      const staged = stageServer({
        repoRoot: REPO, tmpDir: realTmp, nodeModulesDir, port: r.port,
        rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
        linkDirs: ['docs'], copyDirs: ['lib', 'public', 'prompts', 'config'],
      });
      void staged;
      fs.writeFileSync(path.join(realTmp, 'data', 'learnings.json'), '[]');
      fs.writeFileSync(path.join(realTmp, 'data', 'accounts.json'), '{}');
      fs.writeFileSync(path.join(realTmp, 'data', 'earnings.json'), '{}');
      fs.writeFileSync(path.join(realTmp, 'data', 'magic_links.json'), '{}');
      fs.writeFileSync(path.join(realTmp, 'data', 'credits.json'), '{}');
      realBoot = await bootServer({
        tmpDir: realTmp, port: r.port,
        env: { NODE_ENV: 'test', SESSION_SECRET: 'legal-code-spans-real-session-secret-32', RESEND_API_KEY: '', LLM_SENSITIVITY_ENABLED: 'false', WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32) },
        timeoutMs: 60_000, maxAttempts: 3,
      });
      if (realBoot.skipReason) { bootSkipReason = realBoot.skipReason; return; }
    }
    // Server SYNTH: current server.js, a THROWAWAY COPY of docs/ whose
    // staged TERMS-OF-SERVICE.md is overwritten with SYNTHETIC_MD.
    {
      const r = await reservePort();
      if (r.skipReason) { bootSkipReason = r.skipReason; return; }
      synthTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-legal-spans-synth-'));
      synthBoot = await bootWithSyntheticDocs({ tmpDir: synthTmp, port: r.port, nodeModulesDir });
      if (synthBoot.skipReason) { bootSkipReason = synthBoot.skipReason; return; }
    }
  });

  after(async () => {
    if (realBoot && realBoot.child) await stopServer(realBoot.child);
    if (synthBoot && synthBoot.child) await stopServer(synthBoot.child);
    for (const dir of [realTmp, synthTmp]) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('none of the four pages carries a backtick in its visible text (real docs/, no history)', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    for (const page of PAGES) {
      const html = await fetch(`${realBoot.baseUrl}${page.path}`).then((r) => r.text());
      const text = stripTags(legalWrap(html));
      assert.ok(text.length > 100, `sanity: ${page.label} serves real content`);
      assert.ok(!text.includes('`'), `${page.label}: no backtick in visible text`);
    }
  });

  it('the amendment id on /terms renders inside a <code> element (real docs/, no history)', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const html = await fetch(`${realBoot.baseUrl}/terms`).then((r) => r.text());
    const m = html.match(/Current Amendment:\s*<code>([^<]+)<\/code>/);
    assert.ok(m, 'expected "Current Amendment: <code>...</code>" in the served HTML');
    assert.ok(/^[\w.-]+$/.test(m[1]), 'the code element carries the bare amendment id, e.g. 2026-09-27-credit-balance-a2');
  });

  it('R3-7: every heading id on /terms is unchanged from what production serves (real docs/, no history)', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const html = await fetch(`${realBoot.baseUrl}/terms`).then((r) => r.text());
    const ids = [...html.matchAll(/<h[1-6] id="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, [
      'section-1', 'section-2', 'section-3', 'section-4', 'section-5',
      'section-6', 'section-7', 'section-8', 'section-9', 'section-10',
      'section-11', 'section-12', 'section-13', 'section-14', 'section-15',
      'section-16', 'section-17', 'section-18', 'section-19', 'section-20',
    ], 'the code-span feature must never change a real heading id');
  });

  it('synthetic Markdown through the real renderer produces the expected HTML for every construct (no history, no docs/ mutated)', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const html = await fetch(`${synthBoot.baseUrl}/terms`).then((r) => r.text());
    const wrap = legalWrap(html);

    // bold, italic, link
    assert.ok(wrap.includes('<p>Some <strong>bold text</strong> and some <em>italic text</em> and a <a href="https://example.com/page">real link</a>.</p>'),
      'bold, italic and a real link render exactly as before');

    // list
    assert.ok(wrap.includes('<ul><li>item one</li>'), 'the list opens correctly');
    assert.ok(wrap.includes('<li>item two</li>'), 'the second item renders');

    // table with a code span in one of its cells (R2-4 regression: this
    // exact case once rendered as the literal placeholder text, never
    // restored, because splitTableRow() trims the delimiters away)
    assert.ok(wrap.includes('<table><thead><tr><th>Col A</th><th>Col B</th></tr></thead><tbody><tr><td>plain</td><td><code>code in cell</code></td></tr><tr><td>x</td><td>y</td></tr></tbody></table>'),
      'the table renders with a code span inside one of its cells, fully restored');

    // fenced block, unaffected by the code-span extraction
    assert.ok(wrap.includes('<pre class="legal-pre">fenced block line one\nfenced block line two</pre>'),
      'the fenced block renders exactly as before');

    // a code span alone
    assert.ok(wrap.includes('<p>A code span alone: <code>plain code</code>.</p>'),
      'a standalone code span renders as <code>');

    // a code span inside an unnumbered heading -- R3-7: the id is built
    // from the heading's raw text with the span's own plain text, so it is
    // what it was before inline code was rendered, not built from the
    // \\u0001-wrapped placeholder.
    assert.ok(wrap.includes('<h2 id="heading-with-inline-code-inside">Heading With <code>inline code</code> Inside</h2>'),
      'a code span inside an unnumbered heading renders as <code> AND leaves the heading id unchanged');

    // a code span holding an asterisk -- never emphasis
    assert.ok(wrap.includes('<code>a*b</code>'), 'an asterisk inside a code span renders literally, not as emphasis');
    assert.ok(!/<code>a<em>/.test(wrap), 'the asterisk must never be read as emphasis markup');

    // a code span holding "<" -- HTML-escaped, never a raw tag-open
    assert.ok(wrap.includes('<code>a&lt;b</code>'), 'a less-than sign inside a code span is HTML-escaped');
    assert.ok(!wrap.includes('<code>a<b</code>') && !wrap.includes('<code>a<b>'), 'a less-than sign must never open a raw tag');

    // a lone, unpaired backtick -- left exactly as written
    const text = stripTags(wrap);
    assert.ok(text.includes('A lone backtick stays as it is: ` right here and nothing closes it'),
      'a lone unpaired backtick on its line is left untouched');

    // R4-4: a code span holding "<", ">" and "&" in an unnumbered heading --
    // the id is built from the span's RAW characters, before escaping, so
    // it is exactly what the heading's id was before inline code was
    // rendered at all. Using the escaped HTML ("a&lt;b&gt;&amp;c") instead
    // would wrongly produce "heading-with-a-lt-b-gt-amp-c-chars".
    assert.ok(wrap.includes('<h2 id="heading-with-a-b-c-chars">Heading With <code>a&lt;b&gt;&amp;c</code> Chars</h2>'),
      'a code span holding <, > and & in a heading renders escaped, AND the heading id is built from its raw characters');

    // R3-7: a link whose URL holds a code span is left alone -- no broken
    // href attribute, and the placeholder never leaks into the output.
    assert.ok(wrap.includes('<p>A link whose url holds a code span: broken.</p>'),
      'a link whose url holds a code span degrades to plain text, not a broken href');
    assert.ok(!/href="[^"]*\u0001/.test(wrap), 'no href attribute ever carries a code-span placeholder');
    assert.ok(!wrap.includes('SPAN0') && !wrap.includes('\u0001'), 'no raw placeholder token survives anywhere in the output');
  });
});
