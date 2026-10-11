'use strict';
// TEST-ONLY: materializes the pinned pre-A2 baseline (`git archive 6653298 lib`) into a temp directory so a test can
// load the OLD modules and prove they refuse A2 artifacts. It never skips: a missing git binary or object fails loudly,
// and every extracted file used by a test is hashed against the value recorded from 6653298.
const { execFileSync } = require('node:child_process'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const BASELINE = '6653298', REPO = path.resolve(__dirname, '..', '..');
const HASHES = Object.freeze({
  'financial-epoch.js': '50facebc77c4cc45a3f65a3d8d4703d282d97c52a17942cbb4123f6bc9e4e1fb',
  'money-failure-control.js': 'b4b0370b873788486a58145c191f500999be6712fdef7f799d656ecb087d1bc1',
  'money-control-store.js': 'ac827e61254cbf5d84fcdff10e852b3ab0156f78cc74c0a7701ee2e14ab35872',
  'money-recovery-anchor.js': 'd4aa931398dfd222292b246fda15a44d45154c3fb60cfc27b6a899e7e83bf098',
  'money-writer-lock.js': '25ef7198eb494b654c169e0ffc1c2f4219d8baf23ad56f1ddd700386a65c9afa'
});
// Whole-tree digest of `git archive 6653298 lib` (110 files): sha256 over the sorted "path\0sha256" rows. A wrong, partial or extended baseline is refused.
const TREE = Object.freeze({ files: 110, digest: 'f9b9202153ad7d204246f88005ef99b34765effaa5737cdb09c0e80b0ce55207' });
function treeRows(lib) {
  const rows = [];
  (function walk(dir, rel) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name), name = rel ? rel + '/' + entry.name : entry.name; if (entry.isDirectory()) walk(file, name); else rows.push(name + '\0' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')); } })(lib, '');
  return rows.sort();
}
function assertBaseline(lib) {
  const rows = treeRows(lib), digest = crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
  if (rows.length !== TREE.files || digest !== TREE.digest) throw new Error('BASELINE_HASH_MISMATCH tree ' + rows.length + ' files ' + digest);
  for (const [name, expected] of Object.entries(HASHES)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(lib, name))).digest('hex');
    if (actual !== expected) throw new Error('BASELINE_HASH_MISMATCH ' + name + ' ' + actual);
  }
}
function materializeBaseline(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-6653298-')));
  t?.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const override = process.env.EMFR_BASELINE_LIB_DIR;
  if (override) {
    // A runner without git mounts the host-extracted `git archive 6653298 lib` read-only; it is verified, then copied so the copy can link node_modules.
    if (!fs.existsSync(path.join(override, 'financial-epoch.js'))) throw new Error('BASELINE_UNAVAILABLE: EMFR_BASELINE_LIB_DIR has no financial-epoch.js: ' + override);
    assertBaseline(override);
    fs.cpSync(override, path.join(dir, 'lib'), { recursive: true });
  } else {
    let archive;
    try {
      execFileSync('git', ['cat-file', '-e', BASELINE + '^{commit}'], { cwd: REPO, stdio: 'pipe' });
      archive = execFileSync('git', ['archive', BASELINE, 'lib'], { cwd: REPO, maxBuffer: 256 * 1024 * 1024 });
    } catch (error) {
      throw new Error('BASELINE_UNAVAILABLE: git or commit ' + BASELINE + ' is missing (CI must fetch full history, or set EMFR_BASELINE_LIB_DIR): ' + (error.stderr?.toString() || error.message));
    }
    execFileSync('tar', ['-x', '-C', dir], { input: archive });
    assertBaseline(path.join(dir, 'lib'));
  }
  // The extracted modules resolve their npm dependencies through the repository's install.
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
  return { dir, lib: path.join(dir, 'lib'), load: name => require(path.join(dir, 'lib', name)) };
}
module.exports = { BASELINE, HASHES, TREE, materializeBaseline };
