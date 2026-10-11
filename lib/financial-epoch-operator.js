"use strict";
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const e = require('./financial-epoch'), {
  assertMoneyWriter
}
= require('./money-writer-lock');
const p = require('./stripe-transfer-persistence');
const h = require('./stripe-history-coverage');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bytes = v => Buffer.from(p.canonicalJSON(v) + '\n');
function fail(code) {
  throw Object.assign(new Error(code), {
    code
  });
}
function captureLegacy(root) {
  const status = h.inspectHistoryCoverage( {
    dir: root
  });
  if (! status.active || ! status.ready) fail('HISTORY_COVERAGE_REQUIRED');
  const coverage = h.validateCoverage(p.readJSONStrict(e.confined(path.join(root, h.COVERAGE), 'file'))), capture = h.validateCaptureStore(p.readJSONStrict(e.confined(path.join(root,
  h.CAPTURE), 'file')));
  const observed = structuredClone(coverage.observed);
  for (const name of Object.values(e.PARTICIPANTS)) {
    if (Object.hasOwn(observed, name)) continue;
    const f = path.join(root, name);
    if (! fs.existsSync(f)) {
      observed[name] = {
        state: 'absent', errno: 'ENOENT'
      };
      continue;
    }
    e.confined(f);
    const st = fs.lstatSync(f);
    if (st.isDirectory()) continue;
    observed[name] = {
      state: 'present', sha256: hash(fs.readFileSync(f))
    };
  }
  const wal = path.join(root, 'wal');
  if (fs.existsSync(wal) && fs.readdirSync(e.confined(wal, 'directory')).length) fail('LEGACY_WAL_NOT_EMPTY');
  return {
    coverage, capture, observed
  };
}
function scopedManifest(identity, binding_digest) {
  return {
    scope: 'prospective_epoch', epoch_id: identity.epoch_id, binding_digest, checkpoint_id: identity.checkpoint_id, manifest_sha256: binding_digest,
    inventory_complete: true, inventory_scope: 'fresh_epoch_only', approval_ref: identity.approval_ref, interval_evidence_ref: identity.interval_evidence_ref,
    platform: identity.platform, platform_account_id: identity.platform_account_id, livemode: identity.livemode
  };
}
function initialParticipant(name, identity, binding_digest, manifest, custom) {
  const base = {
    schema_version: 1, epoch_id: identity.epoch_id, binding_digest
  };
  if (custom !== undefined) {
    if (name !== 'money_control') fail('CUSTOM_PARTICIPANT_NOT_ALLOWED');
    return typeof custom === 'function' ? custom( {
      ... identity, binding_digest
    }): custom;
  }
  if (name === 'money_control') return require('./money-control-store').initialSnapshot( {
    ... identity, binding_digest
  });
  if (name === 'stripe_checkout_intents') return e.seal( {
    schema_version: 1, generation: 0, initialization_manifest: manifest, intents: {
    }
  });
  if (name === 'stripe_object_origins') return e.seal( {
    schema_version: 1, manifest, records: []
  });
  if (name === 'stripe_event_receipts') return e.seal( {
    schema_version: 1, initialization_manifest: manifest, receipts: {
    }
  });
  if (['stripe_connect_intents', 'stripe_transfer_attempts', 'stripe_payout_assignments'].includes(name)) return {
    ... base, state: 'unavailable', reason: 'CONTRIBUTOR_RAIL_UNAVAILABLE'
  };
  if (name === 'policy_consents') return {
    ... base, consents: {
    }
  };
  if (name === 'event_dispositions') return e.seal( {
    ... base, receipts: {
    }
  });
  if (name === 'lifecycle') return {
    ... base, blocked_accounts: {
    }, conflicts: {
    }
  };
  if (name === 'reservations') return[];
  return {
  };
}
function createEpochPlan( {
  root, epochId, candidateSha, livemode, evidence, participants = {
  }
}
= {
}) {
  root = path.resolve(root);
  if (fs.existsSync(path.join(root, e.BINDING_FILE))) fail('EPOCH_ALREADY_BOUND');
  if (! evidence?.approval_ref || ! evidence.policy_ref || ! evidence.inventory_ref || ! evidence.provider_identity_ref || ! evidence.capital_ref || ! Number.isFinite(Date.parse(evidence.not_before))) fail('EPOCH_PLAN_EVIDENCE_REQUIRED');
  const legacy = captureLegacy(root);
  const identity = {
    epoch_id: epochId, platform: 'auxilo_llc', platform_account_id: 'acct_1UMsxYLVAUzbAOHI', livemode, candidate_sha: candidateSha,
    coverage_checksum: legacy.coverage.checksum, checkpoint_id: legacy.coverage.checkpoint_id, observed: legacy.coverage.observed,
    additional_observed: legacy.observed, wal_entries: [], capture_sequence: legacy.capture.records.length, capture_head: legacy.capture.head_hash,
    bootstrap_operation_id: 'bootstrap:' + epochId, policy_ref: evidence.policy_ref, approval_ref: evidence.approval_ref,
    interval_evidence_ref: evidence.inventory_ref, provider_identity_ref: evidence.provider_identity_ref, capital_ref: evidence.capital_ref,
    not_before: evidence.not_before
  };
  const binding_digest = p.digestJSON(identity), manifest = scopedManifest(identity, binding_digest), rows = {
  }, contents = {
  };
  const preparation = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(),'auxilo-epoch-genesis-')));
  let databaseBytes, descriptor;
  try {
    const epochIdentity = {...identity,binding_digest};
    const snapshot = initialParticipant('money_control',identity,binding_digest,manifest,participants.money_control);
    const evidenceSeeds = h.initialCaptureSuffix({root,epoch:epochIdentity});
    descriptor = require('./money-database').createMoneyDatabase({file:path.join(preparation,e.PARTICIPANTS.money_database),epoch:epochIdentity,snapshot,evidenceSeeds});
    databaseBytes = fs.readFileSync(path.join(preparation,e.PARTICIPANTS.money_database));
  } finally {fs.rmSync(preparation,{recursive:true,force:true});}
  for (const[name, file] of Object.entries(e.PARTICIPANTS)) {
    if (e.DIRECTORIES.has(name)) {
      rows[name] = {
        file, disposition: 'directory', schema: 'empty-directory-v1', sha256: hash(Buffer.alloc(0))
      };
      continue;
    }
    let raw, disposition = 'initialize';
    if (name === 'money_database') raw = databaseBytes;
    else if (name === 'money_control') raw = bytes(descriptor);
    else if (e.IDENTITY_PARTICIPANTS.has(name) && legacy.observed[file]?.state === 'present') {
      raw = fs.readFileSync(e.confined(path.join(root, file), 'file'));
      JSON.parse(raw);
      disposition = 'copy';
    } else if (file.endsWith('.jsonl') || file.endsWith('.log')) raw = Buffer.alloc(0);
    else {
      const value = initialParticipant(name, identity, binding_digest, manifest, participants[name]);
      raw = bytes(value);
      if (value.state === 'unavailable') disposition = 'unavailable';
    }
    rows[name] = {
      file, disposition, schema: name === 'money_database' ? 'sqlite-v2' : name === 'money_control' ? 'money-descriptor-v2' : file.endsWith('.jsonl') ? 'jsonl-v1': file.endsWith('.log') ? 'empty-log-v1': 'json-v1', sha256: hash(raw)
    };
    contents[name] = raw.toString('base64');
  }
  const binding = e.seal( {
    schema_version: 1, identity, binding_digest, participants: rows
  });
  e.validateBinding(binding);
  return e.seal( {
    schema_version: 1, mode: 'prospective_epoch_plan', binding, contents
  });
}
function validatePlan(plan) {
  if (! p.plainObject(plan) || plan.schema_version !== 1 || plan.mode !== 'prospective_epoch_plan' || plan.checksum !== e.seal(plan).checksum) fail('EPOCH_PLAN_INVALID');
  e.validateBinding(plan.binding);
  for (const[name, row] of Object.entries(plan.binding.participants)) {
    if (row.disposition === 'directory') continue;
    const raw = Buffer.from(plan.contents[name] || '', 'base64');
    if (raw.toString('base64') !== plan.contents[name] || hash(raw) !== row.sha256) fail('EPOCH_PLAN_PARTICIPANT_CHANGED');
  }
  return plan;
}
function verifyOriginals(root, binding) {
  e.verifyLegacy(root, binding);
  for (const[name, row] of Object.entries(binding.identity.additional_observed || {
  })) {
    const f = path.join(root, name);
    if (row.state === 'absent') {
      if (fs.existsSync(f)) fail('LEGACY_SOURCE_CHANGED');
    } else if (hash(fs.readFileSync(e.confined(f, 'file'))) !== row.sha256) fail('LEGACY_SOURCE_CHANGED');
  }
  const wal = path.join(root, 'wal');
  if (fs.existsSync(wal) && fs.readdirSync(e.confined(wal, 'directory')).length) fail('LEGACY_WAL_CHANGED');
}
function assertOperator(root, writer, stopped) {
  assertMoneyWriter(writer, {
    root
  });
  if (stopped?.stopped !== true || ! stopped.evidence_ref) fail('STOPPED_WRITER_EVIDENCE_REQUIRED');
}
function durableFile(file, raw, afterStep, label) {
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, raw);
    afterStep?.(label + ':write');
    fs.fsyncSync(fd);
    afterStep?.(label + ':fsync');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  p.syncDirectory(path.dirname(file));
  afterStep?.(label + ':directory-fsync');
}
function execute( {
  root, plan, writer, stoppedWriterEvidence, afterStep, recover = false
}) {
  root = path.resolve(root);
  validatePlan(plan);
  assertOperator(root, writer, stoppedWriterEvidence);
  verifyOriginals(root, plan.binding);
  const bindingFile = path.join(root, e.BINDING_FILE), epochs = path.join(root, 'financial-epochs'), final = path.join(epochs,
  plan.binding.identity.epoch_id), stage = path.join(epochs, '.stage-' + plan.checksum);
  if (fs.existsSync(bindingFile)) {
    const current = e.validateBinding(p.readJSONStrict(e.confined(bindingFile, 'file')));
    if (current.checksum !== plan.binding.checksum) fail('EPOCH_BINDING_CONFLICT');
    const fd = fs.openSync(bindingFile, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    p.syncDirectory(root);
    return e.resolveRuntimeEpoch( {
      root
    });
  }
  if (! fs.existsSync(epochs)) {
    fs.mkdirSync(epochs, {
      mode: 0o700
    });
    p.syncDirectory(root);
  } else e.confined(epochs, 'directory');
  const entries = fs.readdirSync(epochs);
  if (entries.some(n => n !== path.basename(stage) && n !== path.basename(final))) fail('EPOCH_UNEXPECTED_STAGE');
  if (! recover &&(fs.existsSync(stage) || fs.existsSync(final))) fail('EPOCH_STAGE_EXISTS');
  if (! fs.existsSync(final)) {
    if (! fs.existsSync(stage)) {
      fs.mkdirSync(stage, {
        mode: 0o700
      });
      p.syncDirectory(epochs);
    }
    for (const[name, row] of Object.entries(plan.binding.participants)) {
      writer.assertOwned();
      const dest = path.join(stage, row.file);
      if (row.disposition === 'directory') {
        if (! fs.existsSync(dest)) {
          fs.mkdirSync(dest, {
            mode: 0o700
          });
          p.syncDirectory(stage);
        } else if (fs.readdirSync(e.confined(dest, 'directory')).length) fail('EPOCH_STAGE_CONFLICT');
        continue;
      }
      const raw = Buffer.from(plan.contents[name], 'base64');
      if (fs.existsSync(dest)) {
        if (hash(fs.readFileSync(e.confined(dest, 'file'))) !== row.sha256) fail('EPOCH_STAGE_CONFLICT');
        const fd = fs.openSync(dest, 'r');
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        p.syncDirectory(stage);
      } else durableFile(dest, raw, afterStep, 'participant:' + name);
    }
    const control = e.seal( {
      schema_version: 1, epoch_id: plan.binding.identity.epoch_id, binding_digest: plan.binding.binding_digest, generation: 0,
      state: 'prepared', capabilities: Object.fromEntries(e.CAPABILITIES.map(k =>[k, false])), evidence: {
        approval_ref: plan.binding.identity.approval_ref
      }
    });
    const controlFile = path.join(stage, e.CONTROL_FILE);
    if (! fs.existsSync(controlFile)) durableFile(controlFile, bytes(control), afterStep, 'control');
    else if (p.digestJSON(p.readJSONStrict(controlFile)) !== p.digestJSON(control)) fail('EPOCH_STAGE_CONFLICT');
    p.syncDirectory(stage);
    afterStep?.('stage:complete');
    verifyOriginals(root, plan.binding);
    fs.renameSync(stage, final);
    p.syncDirectory(epochs);
    afterStep?.('stage:published');
  }
  for (const[name, row] of Object.entries(plan.binding.participants)) {
    const f = path.join(final, row.file);
    if (row.disposition === 'directory') {
      if (fs.readdirSync(e.confined(f, 'directory')).length) fail('EPOCH_STAGE_CONFLICT');
    } else if (hash(fs.readFileSync(e.confined(f, 'file'))) !== row.sha256) fail('EPOCH_STAGE_CONFLICT');
  }
  const initial = e.validateControl(p.readJSONStrict(e.confined(path.join(final, e.CONTROL_FILE), 'file')), plan.binding);
  if (initial.generation !== 0 || initial.state !== 'prepared' || Object.values(initial.capabilities).some(Boolean)) fail('EPOCH_STAGE_CONTROL_CONFLICT');
  verifyOriginals(root, plan.binding);
  writer.assertOwned();
  const bindingStage = bindingFile + '.stage-' + plan.checksum;
  if (fs.existsSync(bindingStage)) {
    if (! recover || hash(fs.readFileSync(e.confined(bindingStage, 'file'))) !== hash(bytes(plan.binding))) fail('EPOCH_BINDING_STAGE_CONFLICT');
    const fd = fs.openSync(bindingStage, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } else durableFile(bindingStage, bytes(plan.binding), afterStep, 'binding');
  fs.renameSync(bindingStage, bindingFile);
  p.syncDirectory(root);
  afterStep?.('binding:published');
  return e.resolveRuntimeEpoch( {
    root
  });
}
function bootstrapEpoch(args) {
  return execute(args);
}
function recoverEpoch(args) {
  return execute( {
    ... args, recover: true
  });
}
function transitionEpoch( {
  epoch, writer, expectedRevision, patch, evidence, policyEvidence, lifecycleEvidence, financialEvidence
}
= {
}) {
  assertMoneyWriter(writer, {
    root: epoch.legacy_root
  });
  const current = e.resolveRuntimeEpoch( {
    root: epoch.legacy_root
  }), {
    binding, control
  }
  = e.requireEpoch(current);
  if (current.binding_digest !== epoch.binding_digest || expectedRevision !== control.generation) fail('EPOCH_CONTROL_CONFLICT');
  if (fs.existsSync(path.join(epoch.legacy_root, 'money-restore-barrier.json'))) {
    const barrier = p.readJSONStrict(path.join(epoch.legacy_root, 'money-restore-barrier.json'));
    if ((barrier.state !== 'reconciled' || barrier.capacity_recreation_required !== false) && Object.entries(patch || {
    }).some(([k, v]) => k !== 'reconcile' && v === true)) fail('RESTORE_RECONCILIATION_REQUIRED');
  }
  if (! p.plainObject(patch) || Object.keys(patch).some(k => ! e.CAPABILITIES.includes(k) || typeof patch[k] !== 'boolean')) fail('EPOCH_CAPABILITY_PATCH_INVALID');
  if (! evidence?.approval_ref) fail('EPOCH_CAPABILITY_EVIDENCE_REQUIRED');
  if (lifecycleEvidence) {
    require('./money-lifecycle').validateLifecycleControl(lifecycleEvidence);
    const file = e.pathFor('lifecycle', current), state = p.readJSONStrict(file);
    if (state.authoritative_control && state.authoritative_control.deletion_barrier.sequence > lifecycleEvidence.deletion_barrier.sequence) fail('RESTORE_DELETION_BARRIER_REGRESSION');
    state.authoritative_control = structuredClone(lifecycleEvidence);
    p.writeJSONAtomic(file, state);
  }
  const next = structuredClone(control);
  if (financialEvidence) next.financial_evidence = structuredClone(financialEvidence);
  if (lifecycleEvidence) next.evidence.lifecycle = p.digestJSON(lifecycleEvidence);
  if (policyEvidence) {
    if (control.policy_evidence && p.digestJSON(control.policy_evidence) !== p.digestJSON(policyEvidence)) fail('EPOCH_POLICY_EVIDENCE_IMMUTABLE');
    next.policy_evidence = structuredClone(policyEvidence);
  }
  for (const[k, v] of Object.entries(patch)) {
    if (v && ! /^[a-f0-9]{64}$/.test(evidence[k] || '')) fail('EPOCH_CAPABILITY_EVIDENCE_REQUIRED');
    if (k === 'reconcile' && ! v && control.capabilities.reconcile) fail('EPOCH_RECONCILIATION_CANNOT_BE_DISABLED');
    next.capabilities[k] = v;
    if (v) next.evidence[k] = evidence[k];
  }
  next.evidence.approval_ref = evidence.approval_ref;
  next.generation++;
  next.state = Object.entries(next.capabilities).some(([k, v]) => k !== 'reconcile' && v) ? 'active': next.capabilities.reconcile ? 'reconcile_only': 'paused';
  const value = e.seal(next);
  e.validateControl(value, binding);
  p.writeJSONAtomic(path.join(epoch.financial_dir, e.CONTROL_FILE), value);
  e.invalidateEpochRuntime(epoch.legacy_root);
  return e.resolveRuntimeEpoch( {
    root: epoch.legacy_root
  });
}
// A2 retirement (v3 8.1-8.3, Addendum 2 D1.4). Every control rewrite below runs under the
// exclusive writer of the root it changes, re-reads the sealed control, and is a
// compare-and-set on its generation. Nothing here ever clears R: there is no un-retire.
function readControlPair(root) {
  root = path.resolve(root);
  const binding = e.validateBinding(p.readJSONStrict(e.confined(path.join(root, e.BINDING_FILE), 'file')));
  const dir = e.confined(path.join(root, 'financial-epochs', binding.identity.epoch_id), 'directory');
  const file = e.confined(path.join(dir, e.CONTROL_FILE), 'file');
  return {
    root, binding, dir, file, control: e.validateControl(p.readJSONStrict(file), binding)
  };
}
function writeRetirementControl( {
  root, writer, expectedRevision, build
}) {
  assertMoneyWriter(writer, {
    root
  });
  const current = readControlPair(root);
  if (! Number.isSafeInteger(expectedRevision) || current.control.generation !== expectedRevision) fail('EPOCH_CONTROL_CONFLICT');
  const next = build(structuredClone(current.control), current.binding);
  next.generation = current.control.generation + 1;
  const value = e.seal(next);
  e.validateControl(value, current.binding);
  e.validateRetirementTransition(current.control.retirement ?? null, value.retirement);
  p.writeJSONAtomic(current.file, value);
  e.invalidateEpochRuntime(root);
  return value;
}
// S1: forced paused, every capability (reconcile included) off, schema_version 2.
function retireEpochControl( {
  root, writer, expectedRevision, identity
}
= {
}) {
  return writeRetirementControl( {
    root, writer, expectedRevision, build(control, binding) {
      e.validateRetirementIdentity(identity);
      if (identity.retiredAtGeneration !== control.generation + 1 || identity.sourceIdentity.epochId !== control.epoch_id || identity.sourceIdentity.bindingDigest !== binding.binding_digest) fail('RETIREMENT_IDENTITY_INVALID');
      return {
        ... control, schema_version: 2, state: 'paused', capabilities: Object.fromEntries(e.CAPABILITIES.map(k =>[k, false])), retirement: e.buildRetirement(identity)
      };
    }
  });
}
// S3: state retiring -> retired and the one published checkpoint digest; identity untouched.
function finalizeRetirementControl( {
  root, writer, expectedRevision, publishedCheckpointDigest
}
= {
}) {
  return writeRetirementControl( {
    root, writer, expectedRevision, build(control) {
      if (! control.retirement) fail('RETIREMENT_IDENTITY_INVALID');
      return {
        ... control, retirement: {
          ... control.retirement, state: 'retired', publishedCheckpointDigest
        }
      };
    }
  });
}
// S4: the single successor tuple. The compare-and-set and the transition validator are the arbiter.
function claimRetirementSuccessor( {
  root, writer, expectedRevision, successor
}
= {
}) {
  return writeRetirementControl( {
    root, writer, expectedRevision, build(control) {
      if (! control.retirement) fail('RETIREMENT_IDENTITY_INVALID');
      return {
        ... control, retirement: {
          ... control.retirement, successor
        }
      };
    }
  });
}
function rehearseEpoch( {
  root, outputRoot, plan, writer, afterStep
}
= {
}) {
  root = path.resolve(root);
  if (! outputRoot) fail('EXPLICIT_REHEARSAL_OUTPUT_REQUIRED');
  outputRoot = path.resolve(outputRoot);
  if (outputRoot === root || outputRoot.startsWith(root + path.sep) || root.startsWith(outputRoot + path.sep)) fail('REHEARSAL_ROOT_OVERLAP');
  validatePlan(plan);
  verifyOriginals(root, plan.binding);
  if (fs.existsSync(outputRoot)) fail('REHEARSAL_OUTPUT_EXISTS');
  e.confined(path.dirname(outputRoot), 'directory');
  fs.mkdirSync(outputRoot, {
    mode: 0o700
  });
  p.syncDirectory(path.dirname(outputRoot));
  const originals = new Set([... h.ARTIFACTS, ... Object.entries(plan.binding.identity.additional_observed).filter(([,
  r]) => r.state === 'present').map(([name]) => name)]);
  for (const name of originals) durableFile(path.join(outputRoot, name), fs.readFileSync(e.confined(path.join(root, name),
  'file')), afterStep, 'rehearsal:' + name);
  fs.mkdirSync(path.join(outputRoot, 'wal'), {
    mode: 0o700
  });
  p.syncDirectory(outputRoot);
  const owned = writer || require('./money-writer-lock').acquireMoneyWriter( {
    root: outputRoot
  });
  try {
    return bootstrapEpoch( {
      root: outputRoot, plan, writer: owned, stoppedWriterEvidence: {
        stopped: true, evidence_ref: 'isolated-rehearsal:' + plan.checksum
      }, afterStep
    });
  } finally {
    if (! writer) owned.close();
  }
}
module.exports = {
  hash, scopedManifest, createEpochPlan, validatePlan, bootstrapEpoch, recoverEpoch, rehearseEpoch, transitionEpoch, verifyOriginals, readControlPair, retireEpochControl, finalizeRetirementControl, claimRetirementSuccessor
};
