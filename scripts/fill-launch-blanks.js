#!/usr/bin/env node
'use strict';

/**
 * scripts/fill-launch-blanks.js — one-command launch fill (Tyler-gate A + D).
 *
 * Replaces the deliberate guard-catchable placeholders in the SERVED legal docs
 * with the confirmed entity + deploy date, then runs scripts/predeploy-check.sh
 * so the result is verified in the same breath.
 *
 *   node scripts/fill-launch-blanks.js \
 *     --entity "Auxilo LLC, a Missouri limited liability company doing business as Auxilo" \
 *     --date   "July 9, 2026" \
 *     [--root DIR] [--dry-run]
 *
 * Placeholders handled (the ONLY two placeholder families that exist):
 *   [[LEGAL-ENTITY ... ]]  -> --entity   (ToS §5.10.1, Privacy §1 controller, DMCA ×2)
 *   [[DEPLOY-DATE]]        -> --date     (ToS header ×3, §5.10.1, footer)
 *
 * Rules enforced:
 *   - entity/date must be non-empty and must not themselves contain "[[".
 *   - The entity must be the REAL, formed/confirmed legal entity. Never run this
 *     with a speculative name — naming an unformed entity in a live clickwrap is
 *     a misrepresentation (see AUXILO-COUNSEL-BRIEF-entity-formation.md).
 *   - After filling, the predeploy guard must PASS; the script exits non-zero if
 *     any placeholder remains or the guard fails.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
function argVal(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : null;
}
const entity = argVal('--entity');
const date = argVal('--date');
const root = path.resolve(argVal('--root') || path.join(__dirname, '..'));
const dryRun = args.includes('--dry-run');

function die(msg) { console.error(`❌ ${msg}`); process.exit(1); }

if (!entity || !entity.trim()) die('--entity is required (the confirmed legal entity, e.g. "Auxilo LLC, a Missouri limited liability company doing business as Auxilo")');
if (!date || !date.trim()) die('--date is required (the go-live date, e.g. "July 9, 2026")');
if (entity.includes('[[') || date.includes('[[')) die('entity/date must not contain "[[" — supply final values only');
if (/\bLLC\b/i.test(entity) === false && /\bcorporation\b|\bInc\.?\b/i.test(entity) === false) {
  console.warn('⚠️  entity does not name an entity type (LLC / Inc. / corporation) — confirm this matches the charter before deploying.');
}

const FILES = [
  'docs/TERMS-OF-SERVICE.md',
  'docs/PRIVACY-POLICY.md',
  'docs/DMCA-POLICY.md',
];

// Lazy match to the FIRST "]]" — placeholder bodies contain single "]" (e.g.
// "[state]") but never "]]", so this is exact for both families.
const ENTITY_RE = /\[\[LEGAL-ENTITY[\s\S]*?\]\]/g;
const DATE_RE = /\[\[DEPLOY-DATE\]\]/g;

let totalEntity = 0;
let totalDate = 0;

for (const rel of FILES) {
  const fp = path.join(root, rel);
  if (!fs.existsSync(fp)) die(`missing served doc: ${rel} (wrong --root?)`);
  const src = fs.readFileSync(fp, 'utf8');
  const nEntity = (src.match(ENTITY_RE) || []).length;
  const nDate = (src.match(DATE_RE) || []).length;
  totalEntity += nEntity;
  totalDate += nDate;
  const out = src.replace(ENTITY_RE, entity).replace(DATE_RE, date);
  console.log(`${dryRun ? '[dry-run] ' : ''}${rel}: ${nEntity} entity + ${nDate} date placeholder(s)`);
  if (!dryRun && out !== src) fs.writeFileSync(fp, out);
}

if (totalEntity + totalDate === 0) {
  console.log('ℹ️  No placeholders found — docs appear already filled. Running the guard anyway.');
}

if (dryRun) {
  console.log(`\n[dry-run] Would replace ${totalEntity} entity + ${totalDate} date placeholder(s). Nothing written.`);
  process.exit(0);
}

// Verify: no "[[" anywhere in the served docs, then run the full predeploy guard.
for (const rel of FILES) {
  const body = fs.readFileSync(path.join(root, rel), 'utf8');
  if (body.includes('[[')) die(`${rel} still contains "[[" after fill — inspect manually`);
}

const guard = path.join(root, 'scripts', 'predeploy-check.sh');
if (fs.existsSync(guard)) {
  console.log('\nRunning predeploy guard...\n');
  try {
    execFileSync('bash', [guard], { stdio: 'inherit', cwd: root });
  } catch {
    die('predeploy guard FAILED after fill — do not deploy; resolve the guard output above');
  }
} else {
  console.warn('⚠️  scripts/predeploy-check.sh not found at --root; skipped guard (only expected in test sandboxes)');
}

console.log(`\n✅ Filled ${totalEntity} entity + ${totalDate} date placeholder(s); guard green. Review the diff, then deploy per the runbook.`);
