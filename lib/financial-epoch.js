"use strict";
// This module has no side-effecting participant imports. Merely locating a
// prospective epoch never creates a participant or upgrades historical money.
const fs = require('fs'), path = require('path');
const {
  digestJSON, readJSONStrict, plainObject
}
= require('./stripe-transfer-persistence');
const {
  assertMoneyWriter
}
= require('./money-writer-lock');
const BINDING_FILE = 'financial-epoch.json', CONTROL_FILE = 'epoch-control.json';
const PARTICIPANTS = Object.freeze( {
  accounts: 'accounts.json', magic_links: 'magic_links.json', identity: 'identity.json', verified_wallets: 'verified-wallets.json',
  credits: 'credits.json', earnings: 'earnings.json', purchases: 'purchases.jsonl', withdrawals: 'withdrawals.jsonl', purchase_ledger: 'purchase-ledger.json',
  settlements: 'settlements.jsonl', settlement_archives: 'settlement-archives', settlement_markers: 'settlement-markers.json',
  reservations: 'reservations.json', checkout_sessions: 'checkout-sessions.json', account_holds: 'account-holds.json',
  hold_clear_log: 'hold-clear-log.jsonl', stripe_checkout_intents: 'stripe-checkout-intents.json', stripe_object_origins: 'stripe-object-origins.json',
  stripe_event_receipts: 'stripe-event-receipts.json', stripe_connect_intents: 'stripe-connect-intents.json', stripe_transfer_attempts: 'stripe-transfer-attempts.json',
  stripe_payout_assignments: 'stripe-payout-assignments.json', money_control: 'money-control.json', money_database: 'money-control.sqlite', wal: 'wal', deletion_log: 'deletion-log.jsonl',
  policy_consents: 'policy-consents.json', tos_acceptance: 'tos-acceptance.jsonl', extraction_audit: 'extraction-audit',
  earning_notifications: 'earning-notifications.json', event_dispositions: 'event-dispositions.json', lifecycle: 'financial-lifecycle.json',
  unlock_events: 'unlock-events.jsonl', tx_hashes: 'tx-hashes.log', staged_key: 'staged-key.json'
});
const DIRECTORIES = new Set(['wal', 'settlement_archives', 'extraction_audit']);
const IDENTITY_PARTICIPANTS = new Set(['accounts', 'magic_links', 'identity', 'verified_wallets', 'account_holds', 'staged_key']);
const ENV_MAP = Object.freeze( {
  accounts: 'AUXILO_ACCOUNTS_FILE', magic_links: 'AUXILO_MAGIC_LINKS_FILE', identity: 'AUXILO_IDENTITY_FILE', credits: 'AUXILO_CREDITS_FILE',
  purchase_ledger: 'AUXILO_PURCHASE_LEDGER_FILE', account_holds: 'AUXILO_ACCOUNT_HOLDS_FILE', hold_clear_log: 'AUXILO_HOLD_CLEAR_LOG_FILE',
  stripe_checkout_intents: 'AUXILO_STRIPE_CHECKOUT_INTENTS_FILE', stripe_object_origins: 'AUXILO_STRIPE_OBJECT_ORIGINS_FILE',
  stripe_event_receipts: 'AUXILO_STRIPE_EVENT_RECEIPTS_FILE', stripe_connect_intents: 'AUXILO_STRIPE_CONNECT_INTENTS_FILE',
  stripe_transfer_attempts: 'AUXILO_STRIPE_TRANSFER_ATTEMPTS_FILE', stripe_payout_assignments: 'AUXILO_STRIPE_PAYOUT_ASSIGNMENTS_FILE',
  wal: 'AUXILO_WAL_DIR', earning_notifications: 'AUXILO_EARNING_NOTIFICATIONS_FILE'
});
const CAPABILITIES = Object.freeze(['identity', 'funding', 'spend', 'buyer_return', 'reconcile']);
const runtimes = new WeakMap();
const maintenanceEpochs = new WeakMap();
const ownedEpochs = new Map();
const HEX = /^[a-f0-9]{64}$/;
function fail(code) {
  throw Object.assign(new Error(code), {
    code
  });
}
function seal(value) {
  const copy = {
    ... value
  };
  delete copy.checksum;
  return {
    ... copy, checksum: digestJSON(copy)
  };
}
function confined(file, kind) {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let s;
    try {
      s = fs.lstatSync(current);
    } catch (e) {
      if (e.code === 'ENOENT') fail('EPOCH_PARTICIPANT_MISSING');
      throw e;
    }
    if (s.isSymbolicLink()) fail('EPOCH_SYMLINK');
    if (current === absolute && kind &&(kind === 'directory' ? ! s.isDirectory(): ! s.isFile())) fail('EPOCH_PATH_TYPE');
  }
  return absolute;
}
function validateBinding(binding) {
  if (! plainObject(binding) || binding.schema_version !== 1 || binding.checksum !== seal(binding).checksum || ! plainObject(binding.identity) || binding.binding_digest !== digestJSON(binding.identity) || ! plainObject(binding.participants)) fail('EPOCH_BINDING_INVALID');
  const i = binding.identity;
  if (! /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(i.epoch_id) || i.platform !== 'auxilo_llc' || i.platform_account_id !== 'acct_1UMsxYLVAUzbAOHI' || typeof i.livemode !== 'boolean' || ! HEX.test(i.coverage_checksum) || ! HEX.test(i.capture_head) || ! Number.isSafeInteger(i.capture_sequence) || i.capture_sequence < 0 || ! i.bootstrap_operation_id || ! /^[a-f0-9]{40}$/.test(i.candidate_sha) || ! plainObject(i.observed) || ! i.policy_ref || ! i.approval_ref || ! i.interval_evidence_ref || ! Number.isFinite(Date.parse(i.not_before))) fail('EPOCH_IDENTITY_INVALID');
  if (Object.keys(binding.participants).sort().join() !== Object.keys(PARTICIPANTS).sort().join()) fail('EPOCH_PARTICIPANT_INVENTORY_INVALID');
  for (const[name, row] of Object.entries(binding.participants)) if (! plainObject(row) || row.file !== PARTICIPANTS[name] || !['copy',
  'initialize', 'directory', 'unavailable'].includes(row.disposition) || ! HEX.test(row.sha256) || ! row.schema) fail('EPOCH_PARTICIPANT_INVENTORY_INVALID');
  return binding;
}
function validateControl(control, binding) {
  if (! plainObject(control) || control.schema_version !== 1 || control.binding_digest !== binding.binding_digest || control.epoch_id !== binding.identity.epoch_id || control.checksum !== seal(control).checksum || ! Number.isSafeInteger(control.generation) || control.generation < 0 || !['prepared',
  'active', 'paused', 'reconcile_only'].includes(control.state) || ! plainObject(control.capabilities) || Object.keys(control.capabilities).sort().join() !==[... CAPABILITIES].sort().join() || CAPABILITIES.some(k => typeof control.capabilities[k] !== 'boolean') || ! plainObject(control.evidence)) fail('EPOCH_CONTROL_INVALID');
  if (control.financial_evidence) {
    if (! plainObject(control.financial_evidence) || Object.keys(control.financial_evidence).some(k => !['original_cost_contract',
    'refund_cost_contract', 'liquidity', 'capacity_profile', 'capacity_acceptance'].includes(k))) fail('EPOCH_FINANCIAL_EVIDENCE_INVALID');
    for (const [key, row] of Object.entries(control.financial_evidence)) if (key !== 'capacity_acceptance') if (! plainObject(row) || row.platform_account_id !== binding.identity.platform_account_id || row.livemode !== binding.identity.livemode || row.currency !== 'usd' || row.approved !== true || ! row.evidence_ref) fail('EPOCH_FINANCIAL_EVIDENCE_INVALID');
    if(control.financial_evidence.capacity_profile)require('./money-capacity').validateCapacityProfile(control.financial_evidence.capacity_profile,{...binding.identity,binding_digest:binding.binding_digest});
  }
  const acceptance = control.financial_evidence?.capacity_acceptance;
  if (acceptance !== undefined) {
    const keys = ['schema', 'approved', 'profile_sha256', 'candidate_sha', 'report_sha256', 'evidence_ref'];
    if (!plainObject(acceptance) || Object.keys(acceptance).sort().join() !== keys.sort().join() || acceptance.schema !== 1 || acceptance.approved !== true || !HEX.test(acceptance.profile_sha256 || '') || !HEX.test(acceptance.report_sha256 || '') || acceptance.candidate_sha !== binding.identity.candidate_sha || typeof acceptance.evidence_ref !== 'string' || !acceptance.evidence_ref.trim() || acceptance.evidence_ref.length > 512 || !control.financial_evidence.capacity_profile || acceptance.profile_sha256 !== digestJSON(control.financial_evidence.capacity_profile)) fail('EPOCH_CAPACITY_ACCEPTANCE_INVALID');
  }
  if (['funding', 'spend', 'buyer_return'].some(key => control.capabilities[key]) && !acceptance) fail('EPOCH_CAPACITY_ACCEPTANCE_REQUIRED');
  if (control.policy_evidence) {
    const x = control.policy_evidence;
    if (x.policy_version !== binding.identity.policy_ref || x.published !== true || ! Number.isFinite(Date.parse(x.effective_at)) || ! HEX.test(x.disclosure_sha256 || '') || ! HEX.test(x.evidence_ref || '')) fail('EPOCH_PUBLISHED_POLICY_REQUIRED');
  }
  if ((control.capabilities.funding || control.capabilities.buyer_return) && ! control.policy_evidence) fail('EPOCH_PUBLISHED_POLICY_REQUIRED');
  for (const key of CAPABILITIES) if (control.capabilities[key] && ! HEX.test(control.evidence[key] || '')) fail('EPOCH_CAPABILITY_EVIDENCE_REQUIRED');
  return control;
}
function verifyLegacy(root, binding) {
  const h = require('./stripe-history-coverage');
  const status = h.inspectHistoryCoverage( {
    dir: root
  });
  if (! status.ready || ! status.active) fail('HISTORY_COVERAGE_REQUIRED');
  const coverage = h.validateCoverage(readJSONStrict(confined(path.join(root, h.COVERAGE), 'file')));
  if (coverage.checksum !== binding.identity.coverage_checksum || digestJSON(coverage.observed) !== digestJSON(binding.identity.observed)) fail('EPOCH_LEGACY_BINDING_CHANGED');
  for (const[name, row] of Object.entries(binding.identity.additional_observed || coverage.observed)) {
    const f = path.join(root, name);
    if (row.state === 'absent') {
      if (fs.existsSync(f)) fail('LEGACY_SOURCE_CHANGED');
      continue;
    }
    confined(f, 'file');
    const digest = require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    if (digest !== row.sha256) fail('LEGACY_SOURCE_CHANGED');
  }
  const wal = path.join(root, 'wal');
  if (fs.existsSync(wal) && fs.readdirSync(confined(wal, 'directory')).length) fail('LEGACY_WAL_CHANGED');
  const capture = h.validateCaptureStore(readJSONStrict(confined(path.join(root, h.CAPTURE), 'file')));
  if (capture.records.length < binding.identity.capture_sequence) fail('EPOCH_CAPTURE_PREFIX_CHANGED');
  const head = binding.identity.capture_sequence ? capture.records[binding.identity.capture_sequence - 1].record_hash: h.buildCaptureStore( {
    manifest: {
      checkpoint_id: capture.checkpoint_id, approval_ref: capture.approval_ref
    }, source_fingerprint: capture.source_fingerprint, checksum: capture.plan_checksum, candidate_sha: capture.candidate_sha
  }).head_hash;
  if (head !== binding.identity.capture_head) fail('EPOCH_CAPTURE_PREFIX_CHANGED');
  return true;
}
function checkStages(dir) {
  if (fs.readdirSync(dir).some(n => n.endsWith('.tmp') || n.includes('.stage-'))) fail('EPOCH_STAGE_INCOMPLETE');
}
function fileIdentity(file) {const s=fs.lstatSync(confined(file,'file'));if(s.isSymbolicLink()||!s.isFile())fail('EPOCH_PATH_TYPE');return [s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');}
function activeStore(epoch) {
  const runtime=require('./money-control').getMoneyRuntime?.();
  if(!runtime || runtime.epoch.binding_digest!==epoch.binding_digest || runtime.epoch.legacy_root!==epoch.legacy_root)return null;
  assertMoneyWriter(runtime.writer,{root:epoch.legacy_root});
  if(runtime.uncertain)fail('MONEY_RUNTIME_UNCERTAIN');
  return runtime.store;
}
function invalidateEpochRuntime(root) {ownedEpochs.delete(path.resolve(root));}
function resolveRuntimeEpoch( {
  root = process.env.AUXILO_DATA_DIR || path.join(__dirname, '..', 'data'), writer, inspectValidatedDatabase, restoreAuthority
}
= {
}) {
  root = path.resolve(root);
  const restoreInspection=restoreAuthority?require('./money-atomic-restore').inspectRestoreMaintenanceAuthority(restoreAuthority,{root,writer}):null;
  if (! fs.existsSync(root)) return null;
  const earlyRestore = path.join(root, 'money-restore-barrier.json');
  const restoreBarrier=fs.existsSync(earlyRestore)?readJSONStrict(confined(earlyRestore,'file')):null;
  if (restoreBarrier && (restoreBarrier.checksum !== seal(restoreBarrier).checksum || restoreBarrier.state === 'installing')) fail('MONEY_RESTORE_REQUIRED');
  const file = path.join(root, BINDING_FILE);
  const cached=ownedEpochs.get(root);
  if(!restoreInspection && cached && activeStore(cached.epoch)) {
    checkStages(cached.epoch.financial_dir);
    if(restoreBarrier && (restoreBarrier.state!=='reconciled' || restoreBarrier.capacity_recreation_required!==false) && Object.entries(cached.epoch.capabilities).some(([k,v])=>k!=='reconcile'&&v))fail('RESTORE_ADMISSION_BARRIER_CONFLICT');
    if(require('./money-lifecycle').lifecycleBarrier(root))fail('LIFECYCLE_RECOVERY_REQUIRED');
    const lifecycleStage=path.join(root,'.money-lifecycle');
    if(fs.existsSync(lifecycleStage)&&fs.readdirSync(lifecycleStage).length)fail('LIFECYCLE_STAGE_INCOMPLETE');
    if(fileIdentity(file)!==cached.bindingIdentity || fileIdentity(path.join(cached.epoch.financial_dir,CONTROL_FILE))!==cached.controlIdentity || fileIdentity(path.join(cached.epoch.financial_dir,PARTICIPANTS.money_control))!==cached.descriptorIdentity)fail('EPOCH_CONTROL_CONFLICT');
    const database=fs.lstatSync(path.join(cached.epoch.financial_dir,PARTICIPANTS.money_database));
    if(database.isSymbolicLink() || !database.isFile() || database.ino!==cached.databaseInode || database.dev!==cached.databaseDevice)fail('EPOCH_DATABASE_INODE_CHANGED');
    if(inspectValidatedDatabase)inspectValidatedDatabase(cached.epoch,activeStore(cached.epoch).validateDatabase({full:true}).reader);
    return cached.epoch;
  }
  if (! fs.existsSync(file)) {
    if (fs.readdirSync(root).some(n => n.startsWith('financial-epoch.') && n !== BINDING_FILE) || fs.existsSync(path.join(root,
    'financial-epochs'))) fail('EPOCH_STAGE_INCOMPLETE');
    return null;
  }
  confined(root, 'directory');
  if (require('./money-lifecycle').lifecycleBarrier(root)) fail('LIFECYCLE_RECOVERY_REQUIRED');
  const lifecycleStage = path.join(root, '.money-lifecycle');
  if (fs.existsSync(lifecycleStage) && fs.readdirSync(confined(lifecycleStage, 'directory')).length) fail('LIFECYCLE_STAGE_INCOMPLETE');
  if (fs.readdirSync(root).some(n => n.startsWith(BINDING_FILE + '.'))) fail('EPOCH_STAGE_INCOMPLETE');
  const binding = validateBinding(readJSONStrict(confined(file, 'file')));
  if (fs.readdirSync(confined(path.join(root, 'financial-epochs'), 'directory')).some(n => n !== binding.identity.epoch_id)) fail('EPOCH_STAGE_INCOMPLETE');
  const financial_dir = confined(path.join(root, 'financial-epochs', binding.identity.epoch_id), 'directory');
  const stagedNames=fs.readdirSync(financial_dir).filter(n=>n.endsWith('.tmp')||n.includes('.stage-'));
  const compensationStage=stagedNames.length===1&&/^credits\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.test(stagedNames[0])?stagedNames[0]:null;
  if(restoreInspection){if(stagedNames.some(name=>!restoreInspection.stageNames.includes(name)&&!restoreInspection.ownedStages.includes(name)))fail('EPOCH_STAGE_INCOMPLETE');}
  else if(stagedNames.length&&(!compensationStage||!writer))fail('EPOCH_STAGE_INCOMPLETE');
  verifyLegacy(root, binding);
  const control = validateControl(readJSONStrict(confined(path.join(financial_dir, CONTROL_FILE), 'file')), binding);
  const restoreFile = path.join(root, 'money-restore-barrier.json');
  if (fs.existsSync(restoreFile)) {
    const barrier = readJSONStrict(confined(restoreFile, 'file'));
    if (barrier.checksum !== seal(barrier).checksum || barrier.state === 'installing') fail('MONEY_RESTORE_REQUIRED');
    if ((barrier.state !== 'reconciled' || barrier.capacity_recreation_required !== false) &&(control.state !== 'reconcile_only' || Object.entries(control.capabilities).some(([k,
    v]) => k !== 'reconcile' && v))) fail('RESTORE_ADMISSION_BARRIER_CONFLICT');
  }
  const epoch = Object.freeze( {
    mode: 'prospective_llc', epoch_id: binding.identity.epoch_id, financial_dir, legacy_root: root, platform: binding.identity.platform,
    platform_account_id: binding.identity.platform_account_id, livemode: binding.identity.livemode, activation_revision: control.generation,
    not_before: binding.identity.not_before, binding_digest: binding.binding_digest, capabilities: Object.freeze( {
      ... control.capabilities
    }), policy_ref: binding.identity.policy_ref, policy_evidence: control.policy_evidence ? Object.freeze( {
      ... control.policy_evidence
    }): null
  });
  (restoreInspection?maintenanceEpochs:runtimes).set(epoch, {
    binding, control
  });
  for (const name of Object.keys(PARTICIPANTS)) {
    const f = pathFor(name, epoch), env = ENV_MAP[name];
    if (! DIRECTORIES.has(name)) {
      try {
        if (f.endsWith('.json')) {
          const v = readJSONStrict(f);
          if (! plainObject(v) && !(name === 'reservations' && Array.isArray(v))) fail('EPOCH_PARTICIPANT_SCHEMA_INVALID');
          if (v.checksum !== undefined && v.checksum !== seal(v).checksum) fail('EPOCH_PARTICIPANT_SCHEMA_INVALID');
        } else if (f.endsWith('.jsonl')) require('./stripe-transfer-persistence').readJSONLStrict(f);
      } catch (err) {
        fail('EPOCH_PARTICIPANT_SCHEMA_INVALID');
      }
    }
    if (env && process.env[env] && path.resolve(process.env[env]) !== f) fail('EPOCH_ENV_OVERRIDE_CONFLICT');
  }
  const descriptorFile=pathFor('money_control',epoch),descriptorRaw=fs.readFileSync(descriptorFile);
  if(require('crypto').createHash('sha256').update(descriptorRaw).digest('hex')!==binding.participants.money_control.sha256)fail('EPOCH_DATABASE_DESCRIPTOR_CHANGED');
  const descriptor = JSON.parse(descriptorRaw);
  if (descriptor.schema !== 2 || descriptor.epoch_id !== epoch.epoch_id || descriptor.binding_digest !== epoch.binding_digest || descriptor.database_file !== PARTICIPANTS.money_database || ![2,3].includes(descriptor.database_schema) || !descriptor.database_id || Object.hasOwn(descriptor,'revision')) fail('EPOCH_DATABASE_DESCRIPTOR_INVALID');
  const database = pathFor('money_database', epoch), fd = fs.openSync(database,'r');
  try {const header=Buffer.alloc(16);if(fs.readSync(fd,header,0,16,0)!==16 || header.toString()!=='SQLite format 3\0')fail('EPOCH_DATABASE_HEADER_INVALID');}finally{fs.closeSync(fd);}
  const liveStore=restoreInspection?null:activeStore(epoch);
  if(compensationStage&&liveStore)fail('EPOCH_STAGE_INCOMPLETE');
  const inspectCold=reader=>{
    if(compensationStage&&!restoreInspection){const helper=require('./money-compensation-stage');const proof=helper.inspectCreditsCompensationStage({epochIdentity:epoch,writer,reader,stageName:compensationStage});helper.abortCreditsCompensationStage(proof);checkStages(financial_dir);}
    inspectValidatedDatabase?.(epoch,reader);
  };
  if(liveStore){const metadata=liveStore.readMetadata();if(metadata.database_id!==descriptor.database_id||metadata.epoch_id!==epoch.epoch_id||metadata.binding_digest!==epoch.binding_digest)fail('MONEY_DATABASE_IDENTITY_CONFLICT');const validated=liveStore.validateDatabase({full:true});inspectValidatedDatabase?.(epoch,validated.reader);}
  else require('./money-database').validateMoneyDatabase({file:database,epoch,descriptor,writer,inspect:inspectCold});
  const databaseStat=fs.lstatSync(database);
  if(!restoreInspection)ownedEpochs.set(root,{epoch,bindingIdentity:fileIdentity(file),controlIdentity:fileIdentity(path.join(financial_dir,CONTROL_FILE)),descriptorIdentity:fileIdentity(pathFor('money_control',epoch)),databaseInode:databaseStat.ino,databaseDevice:databaseStat.dev});
  return epoch;
}
function getRuntimeEpoch() {
  return resolveRuntimeEpoch( {
  });
}
function requireEpoch(epoch) {
  const r = runtimes.get(epoch);
  if (! r) fail('RESOLVED_EPOCH_REQUIRED');
  return r;
}
function pathFor(name, epoch) {
  const {
    binding
  }
  = maintenanceEpochs.get(epoch)||requireEpoch(epoch);
  if (! Object.hasOwn(PARTICIPANTS, name)) fail('UNKNOWN_EPOCH_PARTICIPANT');
  if (! binding.participants[name]) fail('EPOCH_PARTICIPANT_MISSING');
  return confined(path.join(epoch.financial_dir, PARTICIPANTS[name]), DIRECTORIES.has(name) ? 'directory': 'file');
}
function resolveParticipantPath(name, {
  legacyPath, envOverride
}
= {
}) {
  const epoch = getRuntimeEpoch();
  if (! epoch) return envOverride || legacyPath;
  const file = pathFor(name, epoch);
  if (envOverride && path.resolve(envOverride) !== file) fail('EPOCH_ENV_OVERRIDE_CONFLICT');
  return file;
}
function assertEpochWritePath(file, writer) {
  assertMoneyWriter(writer);
  const epoch = resolveRuntimeEpoch( {
    root: writer.root
  });
  if (! epoch) fail('RESOLVED_EPOCH_REQUIRED');
  const target = path.resolve(file);
  const allowed = Object.keys(PARTICIPANTS).some(name => {
    const f = pathFor(name, epoch);
    if (target === f) return true;
    return DIRECTORIES.has(name) && target.startsWith(f + path.sep) && ! path.relative(f, target).split(path.sep).includes('..');
  });
  if (! allowed) fail('EPOCH_WRITE_OUTSIDE_PARTICIPANTS');
  if (fs.existsSync(target)) confined(target);
  else confined(path.dirname(target), 'directory');
  return true;
}
function readParticipant(name, epoch) {
  const file = pathFor(name, epoch);
  if (file.endsWith('.jsonl')) return require('./stripe-transfer-persistence').readJSONLStrict(file);
  const v = readJSONStrict(file);
  if (v.checksum !== undefined && v.checksum !== seal(v).checksum) fail('EPOCH_PARTICIPANT_SCHEMA_INVALID');
  return v;
}
function sameStamp(row, epoch) {
  return row && row.epoch_id === epoch.epoch_id && row.binding_digest === epoch.binding_digest &&(row.stripe_platform || row.platform) === epoch.platform &&(row.stripe_platform_account_id || row.platform_account_id) === epoch.platform_account_id && row.livemode === epoch.livemode;
}
function policyConsent(accountId, epoch, source) {
  const store = readParticipant('policy_consents', epoch);
  const rows = Object.values(store.consents || store);
  const row = rows.find(x => x && x.account_id === accountId && x.state === 'acknowledged' && x.policy_version === epoch.policy_ref && x.epoch_id === epoch.epoch_id && x.binding_digest === epoch.binding_digest);
  if (! row || ! row.evidence_ref || ! Number.isFinite(Date.parse(row.effective_at)) || ! Number.isFinite(Date.parse(row.accepted_at))) fail('EPOCH_POLICY_CONSENT_REQUIRED');
  if (source &&(source.policy_version !== row.policy_version || source.policy_consent_id !== row.consent_id || ! Number.isFinite(Date.parse(source.created_at)) || Date.parse(source.created_at) < Math.max(Date.parse(row.effective_at),
  Date.parse(row.accepted_at), Date.parse(epoch.not_before)))) fail('EPOCH_POLICY_COHORT_MISMATCH');
  return row;
}
function assertEpochSource(source, epoch, purpose = 'spend') {
  requireEpoch(epoch);
  if (!['spend', 'buyer_return', 'reconcile'].includes(purpose)) fail('EPOCH_SOURCE_PURPOSE_INVALID');
  if (! sameStamp(source, epoch) || ! source.account_id) fail('EPOCH_SOURCE_MISMATCH');
  const indexed=activeStore(epoch)?.getSourceByLot(source.account_id,source.lot_id);
  if(indexed) {
    if(indexed.input_digest!==digestJSON(indexed.admission) || indexed.frozen || indexed.epoch_id!==epoch.epoch_id || indexed.binding_digest!==epoch.binding_digest || indexed.accountId!==source.account_id || indexed.payment_intent_id!==source.stripe_payment_intent || indexed.provenance?.intent_id!==source.checkout_intent_id || indexed.provenance?.purchase_id!==source.purchase_id || indexed.provenance?.lot_id!==source.lot_id || indexed.policy?.version!==source.policy_version || indexed.policy?.consent_id!==source.policy_consent_id || new Date(indexed.created_at).toISOString()!==source.created_at)fail('EPOCH_SOURCE_CHAIN_REQUIRED');
    const seals=activeStore(epoch).getLifecycle('source_seals') || [];
    require('./money-lifecycle').assertSourceEpochOpen({namespace:epoch.platform+':'+(epoch.livemode?'live':'test'),canonical_created_at:indexed.canonical_created_at,seals});
    return true;
  }
  policyConsent(source.account_id, epoch, source);
  if (source.kind === 'dollar_promo') {
    if (purpose !== 'spend' || ! source.promo_receipt_id) fail('EPOCH_PROMO_NOT_CASH');
    const context=require('./money-control').getActiveMoneyContext();
    const evidence=context?.epoch?.binding_digest===epoch.binding_digest&&context.epoch.legacy_root===epoch.legacy_root?context:activeStore(epoch);
    const receipt=evidence?evidence.getProjection(source.promo_receipt_id):(readParticipant('money_control',epoch).projections||{})[source.promo_receipt_id];
    if (!receipt || receipt.state!=='acknowledged' || receipt.owner!==source.account_id || receipt.effect!=='promo_grant' || receipt.payload?.lot_id!==source.lot_id) fail('EPOCH_SOURCE_CHAIN_REQUIRED');
    return true;
  }
  const context=require('./money-control').getActiveMoneyContext();
  const evidence=context?.epoch?.binding_digest===epoch.binding_digest?context:activeStore(epoch);
  const intent=evidence?evidence.getEvidence('checkout_intents',source.checkout_intent_id)?.payload:(readParticipant('stripe_checkout_intents',epoch).intents||{})[source.checkout_intent_id];
  const originId=digestJSON([epoch.platform_account_id,epoch.livemode,'payment_intent',source.stripe_payment_intent]);
  const indexedOrigin=evidence?.getEvidence('object_origins',originId)?.payload;
  const origins=evidence?(indexedOrigin?[indexedOrigin]:[]):readParticipant('stripe_object_origins',epoch).records||[];
  const purchases = readParticipant('purchases',epoch), credits = readParticipant('credits', epoch);
  const purchase = purchases.find(p => p.id === source.purchase_id);
  const lot =(credits[source.account_id]?.dollar_lots ||[]).find(l => l.lot_id === source.lot_id);
  const origin = origins.find(o => o.object_kind === 'payment_intent' && o.provider_id === source.stripe_payment_intent && o.purchase_id === source.purchase_id);
  if (! intent || ! purchase || ! lot || ! origin ||[intent, purchase, lot, origin].some(x => ! sameStamp(x, epoch)) || intent.state !== 'paid_credited' || intent.account_id !== source.account_id || purchase.account_id !== source.account_id || origin.account_id !== source.account_id || intent.purchase_id !== purchase.id || purchase.stripe_payment_intent !== source.stripe_payment_intent || intent.payment_intent_id !== source.stripe_payment_intent || lot.purchase_id !== purchase.id || lot.stripe_payment_intent !== source.stripe_payment_intent || lot.checkout_intent_id !== intent.intent_id || lot.policy_version !== source.policy_version || lot.policy_consent_id !== source.policy_consent_id || lot.created_at !== source.created_at || intent.policy_version !== source.policy_version || intent.policy_consent_id !== source.policy_consent_id || intent.currency !== 'usd' || ! Number.isSafeInteger(intent.amount_cents) || purchase.amount_usd * 100 !== intent.amount_cents || purchase.stripe_session_id !== intent.session_id || source.checkout_intent_id !== intent.intent_id || ! intent.evidence?.verified || ! intent.evidence?.authoritative || intent.evidence.livemode !== epoch.livemode || lot.frozen) fail('EPOCH_SOURCE_CHAIN_REQUIRED');
  return true;
}
function assertProspectiveAllowed( {
  action, epoch, expectedRevision, accountId, source
}
= {
}) {
  requireEpoch(epoch);
  if (! CAPABILITIES.includes(action)) fail('LEGACY_FINANCIAL_ROUTE_DISABLED');
  const current = resolveRuntimeEpoch( {
    root: epoch.legacy_root
  });
  if (current.binding_digest !== epoch.binding_digest || ! Number.isSafeInteger(expectedRevision) || current.activation_revision !== expectedRevision) fail('EPOCH_CONTROL_CONFLICT');
  if (! current.capabilities[action]) fail('EPOCH_CAPABILITY_DISABLED');
  if (accountId && action !== 'reconcile') {
    const l = readParticipant('lifecycle', current);
    if (l.blocked_accounts?.[accountId]) fail('LEGACY_LIFECYCLE_TRANSITION_REQUIRED');
    if (action === 'funding') {
      require('./legacy-financial-view').assertLegacyAdmission(accountId, current);
      policyConsent(accountId, current);
    }
    if (source) {
      if (source.account_id !== accountId) fail('EPOCH_SOURCE_OWNER_MISMATCH');
      assertEpochSource(source, current, action);
    }
  }
  return true;
}
function eligibleEpochLots( {
  accountId, lots, epoch, heldMicros = {
  }
}) {
  return lots.filter(l => {
    try {
      assertEpochSource( {
        ... l, account_id: accountId
      }, epoch, 'spend');
      return ! l.frozen && Number.isFinite(l.remaining_usd) && Math.round(l.remaining_usd * 1e6) >(heldMicros[l.lot_id] || 0);
    } catch {
      return false;
    }
  }).sort((a, b) =>(a.kind === 'dollar_paid' ? 0: 1) -(b.kind === 'dollar_paid' ? 0: 1) || Date.parse(a.created_at) - Date.parse(b.created_at));
}
function classifyEpochEvent({event,context,rawDigest,epoch,store=activeStore(epoch)}) {
  if(!HEX.test(rawDigest||'')||!event?.id||!event.data?.object?.id||event.account||context?.stripe_platform!==epoch.platform||context?.stripe_platform_account_id!==epoch.platform_account_id||context?.livemode!==epoch.livemode||event.livemode!==epoch.livemode)return {eligible:false,reason:'event_identity_mismatch'};
  if(!store)fail('MONEY_RUNTIME_REQUIRED');
  const obj=event.data.object;
  const intentId=obj.metadata?.auxilo_checkout_intent_id;
  const candidates=intentId?[store.getEvidence('checkout_intents',intentId)].filter(Boolean):store.listEvidence({namespace:'checkout_intents',providerId:obj.id,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,limit:2}).items;
  const intent=candidates.length===1?candidates[0].payload:null;
  if(intent&&sameStamp(intent,epoch)&&intent.account_id===obj.metadata?.account_id&&!['confirmed_not_created','confirmed_expired_unpaid'].includes(intent.state)&&(!intent.session_id||intent.session_id===obj.id))return {eligible:true,kind:'checkout',intent_id:intent.intent_id};
  const operation=obj.metadata?.auxilo_operation_id?store.getOperation(obj.metadata.auxilo_operation_id):store.findOperationByRefund({platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,refundId:obj.id});
  const source=operation&&store.getSource(operation.sourceId);
  if(operation&&source&&source.binding_digest===epoch.binding_digest&&source.epoch_id===epoch.epoch_id&&source.platform_account_id===epoch.platform_account_id&&source.livemode===epoch.livemode&&(!obj.metadata?.auxilo_request_digest||obj.metadata.auxilo_request_digest===operation.provider_request_digest))return {eligible:true,kind:'return',operation_id:operation.id};
  const paymentIntentId=typeof obj.payment_intent==='string'?obj.payment_intent:obj.payment_intent?.id,chargeId=obj.object==='charge'?obj.id:typeof obj.charge==='string'?obj.charge:obj.charge?.id;
  const scoped={platform_account_id:epoch.platform_account_id,livemode:epoch.livemode},byCharge=chargeId&&store.findSourceByProviderIdentity({...scoped,chargeId}),byIntent=paymentIntentId&&store.findSourceByProviderIdentity({...scoped,paymentIntentId});
  const resolved=[byCharge,byIntent].filter(Boolean);
  if(byCharge&&byIntent&&byCharge.id!==byIntent.id||resolved.some(s=>s.epoch_id!==epoch.epoch_id||s.binding_digest!==epoch.binding_digest||s.platform_account_id!==epoch.platform_account_id||s.livemode!==epoch.livemode||chargeId&&s.charge_id&&s.charge_id!==chargeId||paymentIntentId&&s.payment_intent_id!==paymentIntentId||!((chargeId&&s.charge_id===chargeId)||(paymentIntentId&&s.payment_intent_id===paymentIntentId))))return {eligible:false,reason:'unmatched_epoch_identity'};
  const known=byCharge||byIntent;
  if(known)return {eligible:true,kind:'source',source_id:known.id};
  return {eligible:false,reason:'unmatched_epoch_identity'};
}
function recordEpochEventDisposition( {
  epoch, writer, event, context, rawDigest, disposition, effectReceiptId = null
}
= {
}) {
  assertMoneyWriter(writer, {
    root: epoch.legacy_root
  });
  const current = resolveRuntimeEpoch( {
    root: epoch.legacy_root
  });
  if (current.binding_digest !== epoch.binding_digest) fail('EPOCH_BINDING_CONFLICT');
  if (!['restricted', 'eligible', 'applied'].includes(disposition)) fail('EPOCH_EVENT_DISPOSITION_INVALID');
  const runtime=require('./money-control').getMoneyRuntime();
  if(runtime?.store?.descriptor?.schema===2){
    const store=runtime.store,history=require('./stripe-history-coverage');
    const captured=history.indexedCaptureLookup(store,context,event?.id,rawDigest),row=captured?.payload;
    if(!row||row.object_id!==event?.data?.object?.id||row.livemode!==context.livemode||row.stripe_platform_account_id!==context.stripe_platform_account_id)fail('EPOCH_CAPTURE_RECORD_REQUIRED');
    const classification=classifyEpochEvent({epoch:current,event,context,rawDigest});
    const matches=store.listEvidence({namespace:'verified_capture',providerId:event.id,platform_account_id:context.stripe_platform_account_id,livemode:context.livemode,limit:2});
    if(disposition!=='restricted'&&(!classification.eligible||row.conflict||matches.items.some(r=>r.payload.raw_digest!==rawDigest)))fail('EPOCH_EVENT_NOT_ELIGIBLE');
    const id=digestJSON([context.stripe_platform,event.id,rawDigest,disposition]);
    const receipt={receipt_id:id,epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,stripe_platform:context.stripe_platform,stripe_platform_account_id:context.stripe_platform_account_id,livemode:context.livemode,event_id:event.id,object_id:row.object_id,raw_digest:rawDigest,capture_sequence:row.sequence,disposition,effect_receipt_id:effectReceiptId};
    return runtime.withMoneyControl({kind:'event_disposition',accounts:[],epochRevision:epoch.activation_revision},ctx=>{
      const get=ctx.getEvidence.bind(ctx);
      if(disposition==='applied'){const effect=get('event_receipts',effectReceiptId)?.payload;if(!effect||effect.state!=='completed'||effect.event_id!==event.id||effect.payload_digest!==rawDigest||effect.stripe_platform!==epoch.platform)fail('EPOCH_EVENT_EFFECT_RECEIPT_REQUIRED');}
      const prior=get('event_dispositions',id);if(prior){if(digestJSON(prior.payload)!==digestJSON(receipt))fail('EPOCH_EVENT_DISPOSITION_CONFLICT');return {duplicate:true,receipt:prior.payload};}
      ctx.recordEvidence({namespace:'event_dispositions',id,payload:receipt,indexes:{providerId:event.id,state:disposition,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode},capacity:{purpose:'event_disposition',mandatory:classification.eligible,rawBytes:0,...(classification.source_id?{sourceId:classification.source_id}:{}),...(classification.operation_id?{operationId:classification.operation_id}:{}),...(classification.intent_id?{checkoutIntentId:classification.intent_id}:{})}});
      return {duplicate:false,receipt};
    });
  }
  const capture = require('./stripe-history-coverage').validateCaptureStore(readJSONStrict(confined(path.join(epoch.legacy_root,
  'stripe-quarantined-events.json'), 'file')));
  const row = capture.records.find(r => r.event_id === event?.id && r.stripe_platform === context?.stripe_platform && r.raw_digest === rawDigest);
  if (! row || row.object_id !== event?.data?.object?.id || row.livemode !== context.livemode || row.stripe_platform_account_id !== context.stripe_platform_account_id) fail('EPOCH_CAPTURE_RECORD_REQUIRED');
  const classification = classifyEpochEvent( {
    epoch: current, event, context, rawDigest
  });
  if (disposition !== 'restricted' &&(! classification.eligible || row.conflict || capture.records.some(r => r.event_id === row.event_id && r.stripe_platform === row.stripe_platform && r.raw_digest !== rawDigest))) fail('EPOCH_EVENT_NOT_ELIGIBLE');
  if (disposition === 'applied') {
    const receipt = Object.values(readParticipant('stripe_event_receipts', current).receipts || {
    }).find(r => r.receipt_id === effectReceiptId);
    if (! receipt || receipt.state !== 'completed' || receipt.event_id !== event.id || receipt.payload_digest !== rawDigest || receipt.stripe_platform !== epoch.platform) fail('EPOCH_EVENT_EFFECT_RECEIPT_REQUIRED');
  }
  const file = pathFor('event_dispositions', current), state = readJSONStrict(file);
  if (state.checksum !== seal(state).checksum || state.binding_digest !== epoch.binding_digest || ! plainObject(state.receipts)) fail('EPOCH_EVENT_DISPOSITION_CORRUPT');
  const id = digestJSON([context.stripe_platform, event.id, rawDigest, disposition]);
  const receipt = {
    receipt_id: id, epoch_id: epoch.epoch_id, binding_digest: epoch.binding_digest, stripe_platform: context.stripe_platform,
    stripe_platform_account_id: context.stripe_platform_account_id, livemode: context.livemode, event_id: event.id, object_id: row.object_id,
    raw_digest: rawDigest, capture_sequence: row.sequence, disposition, effect_receipt_id: effectReceiptId
  };
  if (state.receipts[id]) {
    if (digestJSON(state.receipts[id]) !== digestJSON(receipt)) fail('EPOCH_EVENT_DISPOSITION_CONFLICT');
    return {
      duplicate: true, receipt: state.receipts[id]
    };
  }
  state.receipts[id] = receipt;
  require('./stripe-transfer-persistence').writeJSONAtomic(file, seal(state));
  return {
    duplicate: false, receipt
  };
}
module.exports = {
  BINDING_FILE, CONTROL_FILE, PARTICIPANTS, DIRECTORIES, IDENTITY_PARTICIPANTS, ENV_MAP, CAPABILITIES, seal, confined,
  validateBinding, validateControl, verifyLegacy, resolveRuntimeEpoch, getRuntimeEpoch, pathFor, resolveParticipantPath,
  assertEpochWritePath, assertEpochSource, assertProspectiveAllowed, eligibleEpochLots, classifyEpochEvent, recordEpochEventDisposition,
  invalidateEpochRuntime, activeStore, policyConsent, readParticipant, requireEpoch
};
