#!/usr/bin/env node
'use strict';
/*
 * scripts/reclassify-pending.js — one-time backlog drain for pending_review learnings.
 *
 * Re-runs every pending_review learning through the CURRENT (recalibrated)
 * sensitivity gate, exactly as /extract does:
 *   classifySensitivity (regex) → if clean AND LLM enabled, classifySensitivityLLM → combineSensitivity.
 * Items the gate now clears (regex clean AND LLM says not-sensitive) are approved.
 * Items still flagged (any hard regex signal OR the LLM flags) stay pending_review.
 *
 * DRY-RUN by default (writes nothing). Pass --apply to persist. After --apply,
 * the caller MUST restart the Fly machine so the server reloads the file into
 * memory (the running process holds `learnings` in memory and would otherwise
 * overwrite the edit on its next mutation).
 *
 * Run on the box:  node /tmp/reclassify-pending.js            (dry-run)
 *                  node /tmp/reclassify-pending.js --apply     (then restart machine)
 */
const fs = require('fs');
const path = require('path');
const APP = process.env.APP_DIR || '/app';
const { classifySensitivity } = require(path.join(APP, 'lib/content-sensitivity.js'));
const { classifySensitivityLLM, combineSensitivity, isLlmSensitivityEnabled } = require(path.join(APP, 'lib/content-sensitivity-llm.js'));
const LEARNINGS = path.join(APP, 'data/learnings.json');
const APPLY = process.argv.includes('--apply');
const CONCURRENCY = 5;

async function evaluate(l) {
  const tags = Array.isArray(l.tags) ? l.tags : [];
  const regex = classifySensitivity(l.title, l.body, tags);
  const llmOn = isLlmSensitivityEnabled();
  if (regex.sensitive) return combineSensitivity({ regex, llm: null, llmEnabled: llmOn });
  if (!llmOn) return combineSensitivity({ regex, llm: null, llmEnabled: false });
  const llm = await classifySensitivityLLM(l.title, l.body, tags);
  return combineSensitivity({ regex, llm, llmEnabled: true });
}

(async () => {
  const raw = JSON.parse(fs.readFileSync(LEARNINGS, 'utf8'));
  const arr = Array.isArray(raw) ? raw : (raw.learnings || []);
  const pending = arr.filter(l => l.status === 'pending_review');
  console.log(`pending_review to reclassify: ${pending.length} | LLM enabled: ${isLlmSensitivityEnabled()} | mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const approve = [], hold = [];
  let idx = 0;
  async function worker() {
    while (idx < pending.length) {
      const l = pending[idx++];
      try {
        const r = await evaluate(l);
        (r.sensitive ? hold : approve).push({ l, r });
      } catch (e) {
        hold.push({ l, r: { sensitive: true, sensitivity_signals: ['reclassify_error'] } });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\n=== RESULT ===`);
  console.log(`WOULD APPROVE (gate now clears): ${approve.length}`);
  console.log(`STAY HELD (still flagged):        ${hold.length}`);

  console.log(`\n--- WOULD-APPROVE (id | category | title) ---`);
  for (const { l } of approve) console.log(`  + ${l.id} | ${l.category || '?'} | ${String(l.title || '').slice(0, 68)}`);

  const hb = {};
  for (const { r } of hold) for (const s of (r.sensitivity_signals || ['(none)'])) hb[s] = (hb[s] || 0) + 1;
  console.log(`\n--- STAY-HELD signal breakdown ---`);
  for (const [s, n] of Object.entries(hb).sort((a, b) => b[1] - a[1])) console.log(`  ${s}: ${n}`);

  if (APPLY) {
    const now = new Date().toISOString();
    const ids = new Set(approve.map(a => a.l.id));
    let n = 0;
    for (const l of arr) if (ids.has(l.id)) { l.status = 'approved'; l.updated_at = now; l.reclassified_at = now; n++; }
    fs.writeFileSync(LEARNINGS + '.tmp', JSON.stringify(raw, null, 2));
    fs.renameSync(LEARNINGS + '.tmp', LEARNINGS);
    console.log(`\nAPPLIED: approved ${n} items. NOW RESTART THE MACHINE to reload in-memory state.`);
  } else {
    console.log(`\nDRY-RUN only — nothing written. Re-run with --apply to approve, then restart the machine.`);
  }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
