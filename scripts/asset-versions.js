#!/usr/bin/env node
'use strict';

/*
 * scripts/asset-versions.js — content-hash cache-busting (ASSET-CACHE-BUST)
 *
 * PROBLEM
 * -------
 * server.js serves /styles.css (and other static assets) with
 *   Cache-Control: public, max-age=31536000, immutable
 * and its route matching is on the PATH only — the `?v=N` query string is
 * never inspected or used to pick a file (see server.js's static routes,
 * e.g. the `/styles.css` route and the generic static catch-all). That means
 * `/styles.css?v=13` is, to a browser, one specific immutable URL: once a
 * returning visitor has fetched it, the browser will never re-request it —
 * for up to a year — no matter how many times the underlying file changes,
 * because the file always changes at the same URL. Before this script the
 * `?v=` value was a hand-maintained integer that frequently did not get
 * bumped when styles.css changed, so returning visitors kept rendering a
 * stale stylesheet.
 *
 * FIX
 * ---
 * Replace the hand-maintained integer with a deterministic 8-hex-char sha256
 * prefix of the asset's actual current bytes. A reference is correct if and
 * only if its `?v=` value equals the current content hash of the file it
 * points at — so any content change automatically invalidates every cached
 * copy on the next deploy, and an unchanged asset never needlessly bumps.
 *
 * This script does NOT rename any file, does NOT touch any cache-control
 * header, and does NOT change the path portion of a reference — only the
 * `?v=` query value.
 *
 * DISCOVERY
 * ---------
 * The asset set is not a hardcoded list. Every file tracked under public/
 * (via `git ls-files public`, so untracked/build output is never scanned)
 * is searched for `href="/path?v=value"` / `src="/path?v=value"` references
 * (HTML) and `@import "/path?v=value"` / `url(/path?v=value)` references
 * (CSS/JS — reported even though none exist in the tree today). Every
 * distinct local path referenced this way becomes a tracked "versioned
 * asset"; its hash is computed from the file at public/<path>.
 *
 * server.js is ALSO scanned (same `href="/path?v=value"` pattern) even
 * though it lives outside public/: `serveLegalPage()` builds its own <head>
 * as a JS template string and embeds a literal `href="/styles.css?v=N"` —
 * the exact same immutable-cached URL, so the exact same bug applies to
 * every legal page (/terms, /privacy, /legal/*, /dmca) if this literal ever
 * drifts from the shipped pages' value (see test/legal-page-styles-version
 * .test.js, which pins server.js and public/index.html to the identical
 * ?v=). Including it here means a styles.css change can never leave that
 * one site unbumped by accident.
 *
 * USAGE
 * -----
 *   node scripts/asset-versions.js            # report: discovered assets + hashes + references
 *   node scripts/asset-versions.js --check    # exit 1 and list every stale reference
 *   node scripts/asset-versions.js --write    # rewrite every stale reference to the current hash
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ASSET_VERSIONS_ROOT lets tests point this script at an isolated fixture
// repo instead of the real tree (see test/asset-cache-bust.test.js). Unset
// in normal use (CLI, predeploy-check.sh) — defaults to this file's real repo.
const REPO_ROOT = process.env.ASSET_VERSIONS_ROOT
  ? path.resolve(process.env.ASSET_VERSIONS_ROOT)
  : path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

const MODE = process.argv.includes('--write')
  ? 'write'
  : process.argv.includes('--check')
  ? 'check'
  : 'report';

// ─── Discovery ────────────────────────────────────────────────────────────

function gitLsFiles(dir) {
  const out = execFileSync('git', ['ls-files', dir], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .map((rel) => ({ rel, abs: path.join(REPO_ROOT, rel) }));
}

function gitIsTracked(rel) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', rel], { cwd: REPO_ROOT, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const trackedPublic = gitLsFiles('public');
const htmlFiles = trackedPublic.filter((f) => f.rel.endsWith('.html'));
const cssJsFiles = trackedPublic.filter((f) => f.rel.endsWith('.css') || f.rel.endsWith('.js'));

// Known non-public file(s) that embed a `?v=` reference to a public/ asset
// (see the DISCOVERY note above re: serveLegalPage). Scanned with the same
// HTML-attribute pattern as htmlFiles; only included if actually tracked, so
// a fixture repo without a server.js (see test/asset-cache-bust.test.js)
// doesn't error out.
const EXTRA_HTML_LIKE_FILES = ['server.js']
  .filter((rel) => fs.existsSync(path.join(REPO_ROOT, rel)) && gitIsTracked(rel))
  .map((rel) => ({ rel, abs: path.join(REPO_ROOT, rel) }));

// href="/path?v=value" or src="/path?v=value" — path has no quote/?/# chars.
const HTML_REF_RE = /\b(?:href|src)="(\/[^"?#]+)\?v=([^"&]*)"/g;
// @import "/path?v=value"  or  @import url(/path?v=value)
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?["']?(\/[^"')?#]+)\?v=([^"'&)]*)["']?\)?/g;
// url(/path?v=value) — generic (covers CSS url() and any JS string form the
// same regex happens to match).
const URL_REF_RE = /url\(\s*["']?(\/[^"')?#]+)\?v=([^"'&)]*)["']?\s*\)/g;

/**
 * Scan one file's text for every `?v=`-style reference.
 * Returns [{ assetPath, value, index, matchLength }]
 */
function findRefs(text, regexes) {
  const refs = [];
  for (const re of regexes) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      refs.push({ assetPath: m[1], value: m[2], index: m.index, matchLength: m[0].length, raw: m[0] });
    }
  }
  // Sort by position so line-number reporting and in-place rewriting stay stable.
  refs.sort((a, b) => a.index - b.index);
  return refs;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

// file -> { text, refs }
const fileScans = new Map();
for (const f of [...htmlFiles, ...EXTRA_HTML_LIKE_FILES]) {
  const text = fs.readFileSync(f.abs, 'utf8');
  const refs = findRefs(text, [HTML_REF_RE]);
  if (refs.length) fileScans.set(f.rel, { abs: f.abs, text, refs });
}
for (const f of cssJsFiles) {
  const text = fs.readFileSync(f.abs, 'utf8');
  const refs = findRefs(text, [CSS_IMPORT_RE, URL_REF_RE]);
  if (refs.length) fileScans.set(f.rel, { abs: f.abs, text, refs });
}

// Distinct asset paths referenced anywhere.
const assetPaths = new Set();
for (const { refs } of fileScans.values()) {
  for (const r of refs) assetPaths.add(r.assetPath);
}

// ─── Hashing ──────────────────────────────────────────────────────────────

function currentHash(assetPath) {
  const rel = assetPath.replace(/^\//, '');
  const abs = path.join(PUBLIC_DIR, rel);
  if (!abs.startsWith(PUBLIC_DIR + path.sep) && abs !== PUBLIC_DIR) {
    throw new Error(`refused to hash outside public/: ${assetPath}`);
  }
  if (!fs.existsSync(abs)) return null; // referenced asset missing on disk
  const bytes = fs.readFileSync(abs);
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8);
}

const hashes = new Map(); // assetPath -> hash (or null if missing)
for (const assetPath of assetPaths) hashes.set(assetPath, currentHash(assetPath));

// ─── Modes ────────────────────────────────────────────────────────────────

function report() {
  console.log(`Discovered ${assetPaths.size} versioned asset(s) from ${fileScans.size} tracked file(s) (public/ + server.js's legal-page shell):\n`);
  for (const assetPath of [...assetPaths].sort()) {
    const hash = hashes.get(assetPath);
    const refCount = [...fileScans.values()].reduce(
      (n, { refs }) => n + refs.filter((r) => r.assetPath === assetPath).length,
      0
    );
    console.log(`  ${assetPath}\t?v=${hash || 'MISSING-ON-DISK'}\t(${refCount} reference${refCount === 1 ? '' : 's'})`);
  }
  const cssJsRefCount = [...cssJsFiles].filter((f) => fileScans.has(f.rel)).length;
  console.log(
    `\nCSS/JS @import / url(...) references to versioned assets: ${cssJsRefCount === 0 ? 'none found' : cssJsRefCount + ' file(s)'}.`
  );
}

function check() {
  let staleCount = 0;
  for (const [rel, { text, refs }] of fileScans) {
    for (const r of refs) {
      const expected = hashes.get(r.assetPath);
      if (expected === null) {
        console.log(`MISSING  ${rel}:${lineOf(text, r.index)}  ${r.assetPath} — referenced asset does not exist on disk`);
        staleCount++;
      } else if (r.value !== expected) {
        console.log(`STALE    ${rel}:${lineOf(text, r.index)}  ${r.assetPath}?v=${r.value} — asset's current content hash is ?v=${expected}`);
        staleCount++;
      }
    }
  }
  if (staleCount === 0) {
    console.log('All ?v= references match their asset\'s current content hash.');
    return 0;
  }
  console.log(`\n${staleCount} stale reference(s). Run \`node scripts/asset-versions.js --write\` to fix.`);
  return 1;
}

function write() {
  let changedFiles = 0;
  let changedRefs = 0;
  for (const [rel, { abs, text, refs }] of fileScans) {
    if (refs.length === 0) continue;
    // Rewrite back-to-front so earlier indices stay valid as the string shrinks/grows.
    let newText = text;
    const toRewrite = refs.filter((r) => hashes.get(r.assetPath) !== null && r.value !== hashes.get(r.assetPath));
    if (toRewrite.length === 0) continue;
    for (let i = toRewrite.length - 1; i >= 0; i--) {
      const r = toRewrite[i];
      const expected = hashes.get(r.assetPath);
      const before = newText.slice(0, r.index);
      const after = newText.slice(r.index + r.matchLength);
      const rewritten = r.raw.replace(`?v=${r.value}`, `?v=${expected}`);
      newText = before + rewritten + after;
      changedRefs++;
    }
    fs.writeFileSync(abs, newText, 'utf8');
    changedFiles++;
    console.log(`wrote ${rel} (${toRewrite.length} reference(s) updated)`);
  }
  console.log(`\n${changedRefs} reference(s) rewritten across ${changedFiles} file(s).`);
  return 0;
}

let exitCode = 0;
if (MODE === 'report') report();
else if (MODE === 'check') exitCode = check();
else if (MODE === 'write') exitCode = write();

process.exit(exitCode);
