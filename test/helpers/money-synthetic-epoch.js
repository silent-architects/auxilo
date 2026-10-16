'use strict';
// TEST-ONLY synthetic epoch directory: a sealed binding and a sealed control with no
// database. It lets pure-JS tests exercise the control-file transitions on hosts that
// have no patched SQLite. It never grants money authority and is not a bootstrap.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const e = require('../../lib/financial-epoch'), p = require('../../lib/stripe-transfer-persistence'), lock = require('../../lib/money-writer-lock');
const HEX = c => c.repeat(64);
function syntheticBinding(epochId = 'epoch-a2') {
  const identity = {
    epoch_id: epochId, platform: 'auxilo_llc', platform_account_id: 'acct_1UMsxYLVAUzbAOHI', livemode: false, coverage_checksum: HEX('a'), capture_head: HEX('b'),
    capture_sequence: 0, bootstrap_operation_id: 'synthetic-op', candidate_sha: 'c'.repeat(40), observed: {}, policy_ref: 'policy-v1', approval_ref: 'synthetic',
    interval_evidence_ref: 'synthetic', not_before: '2026-01-01T00:00:00.000Z'
  };
  const participants = Object.fromEntries(Object.entries(e.PARTICIPANTS).map(([name, file]) => [name, { file, disposition: 'copy', sha256: HEX('d'), schema: 'synthetic' }]));
  return e.seal({ schema_version: 1, identity, binding_digest: p.digestJSON(identity), participants });
}
function syntheticControl(binding, patch = {}) {
  return e.seal({
    schema_version: 1, binding_digest: binding.binding_digest, epoch_id: binding.identity.epoch_id, generation: 0, state: 'reconcile_only',
    capabilities: Object.fromEntries(e.CAPABILITIES.map(k => [k, k === 'reconcile'])), evidence: { reconcile: HEX('e') }, ...patch
  });
}
function syntheticEpoch(t, { epochId = 'epoch-a2', control } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-epoch-')));
  t?.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  const binding = syntheticBinding(epochId), dir = path.join(root, 'financial-epochs', epochId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, e.BINDING_FILE), p.canonicalJSON(binding) + '\n', { mode: 0o600 });
  const first = control || syntheticControl(binding);
  fs.writeFileSync(path.join(dir, e.CONTROL_FILE), p.canonicalJSON(first) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(root, '.money-writer.lock'), '', { mode: 0o600 });
  const writer = lock.injectMoneyWriter({ root, assertOwned: () => true });
  return { root, dir, binding, writer, controlFile: path.join(dir, e.CONTROL_FILE), readControl: () => JSON.parse(fs.readFileSync(path.join(dir, e.CONTROL_FILE), 'utf8')) };
}
function sourceIdentity(overrides = {}) {
  return {
    root: { dev: 11, ino: 22 }, lock: { dev: 11, ino: 33 }, sqlite: { dev: 11, ino: 44 }, databaseId: 'db-synthetic-0001', bindingDigest: syntheticBinding().binding_digest,
    epochId: 'epoch-a2', journalRevision: 9, ...overrides
  };
}
function retirementIdentity(overrides = {}) {
  return {
    schema: 1, generationId: HEX('1'), approvalRef: 'approval:retire-1', retiredAt: '2026-10-11T12:00:00.000Z', retiredAtGeneration: 1, sourceIdentity: sourceIdentity(), ...overrides
  };
}
module.exports = { HEX, syntheticBinding, syntheticControl, syntheticEpoch, sourceIdentity, retirementIdentity };
