"use strict";
// Planning has no destructive side effects. Missing authority is a recorded
// dependency conflict, never an invented hold or completed deletion.
const {
  digestJSON
}
= require('./stripe-transfer-persistence');
const DAY = 86400000;
function fail(code) {
  throw Object.assign(new Error(code), {
    code
  });
}
function time(s) {
  const n = typeof s === 'number' ? s: Date.parse(s);
  if (! Number.isFinite(n)) fail('LIFECYCLE_TRIGGER_UNRESOLVED');
  return n;
}
function iso(s) {
  return new Date(time(s)).toISOString();
}
function addCalendarYears(s, years) {
  const d = new Date(time(s)), month = d.getUTCMonth(), day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  d.setUTCMonth(month);
  const last = new Date(Date.UTC(d.getUTCFullYear(), month + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString();
}
function copyExpiry( {
  cut_at, inherited_expiry
}) {
  return iso(Math.min(time(cut_at) + 7 * DAY, inherited_expiry ? time(inherited_expiry): Infinity));
}
function nominalExpiry(r) {
  switch (r.class) {
    case 'transaction': case 'deletion_audit': return addCalendarYears(r.source_time, 3);
    case 'credit': return addCalendarYears(r.account_end_time, 3);
    case 'account_identifier': case 'consent_raw': return iso(time(r.deletion_requested_at) + 30 * DAY);
    case 'quote': if (! r.quote_expires_at) fail('LIFECYCLE_RULE_UNRESOLVED');
    return iso(r.quote_expires_at);
    case 'checkpoint': return copyExpiry( {
      cut_at: r.source_time, inherited_expiry: r.inherited_expiry
    });
    case 'projection': case 'dedupe': case 'consent_minimal': case 'pool_association': case 'deletion_replay': if (! r.approved_underlying_expiry || ! r.approved_rule_ref) fail('LIFECYCLE_RULE_UNRESOLVED');
    return iso(r.approved_underlying_expiry);
    default: fail('LIFECYCLE_RULE_UNRESOLVED');
  }
}
function authorizedHold(h, record, now, version, rules) {
  return h && ! h.released_at && h.approved_rule_version === version && rules?.hold_authorities?.includes(h.authority_type) && h.authority_reference && h.reason_code && h.release_trigger && Array.isArray(h.subject_refs) && h.subject_refs.includes(record.id) && time(h.opened_at) <= now && time(h.review_due_at) > now;
}
function planLifecycle( {
  records, holds =[], rules = {
  }, now = Date.now(), ruleVersion
}
= {
}) {
  now = time(now);
  if (! ruleVersion || ! Array.isArray(records)) fail('LIFECYCLE_RULE_VERSION_REQUIRED');
  const byId = new Map(), needed = new Set(), decisions = {
  }, blocked = new Set();
  for (const r of records) {
    if (! r.id || byId.has(r.id) || ! Array.isArray(r.dependency_refs) || ! Array.isArray(r.hold_refs)) fail('LIFECYCLE_RECORD_INVALID');
    byId.set(r.id, r);
    if ((r.active_liability_micros || 0) > 0 || r.pending_dispatch || r.unacknowledged_projection || r.unsettled_cost || r.required_source_eligibility || r.active_claim || r.failure_pending || r.compensation_requested) needed.add(r.id);
  }
  const pending =[... needed];
  while (pending.length) {
    const id = pending.pop();
    for (const ref of byId.get(id)?.dependency_refs ||[]) {
      if (! byId.has(ref)) fail('LIFECYCLE_DEPENDENCY_MISSING');
      if (! needed.has(ref)) {
        needed.add(ref);
        pending.push(ref);
      }
    }
  }
  for (const r of records) {
    let expiry;
    try {
      expiry = nominalExpiry(r);
    } catch (err) {
      decisions[r.id] = {
        action: 'conflict', reason: err.code, dependency_refs: r.dependency_refs
      };
      if (r.account_id) blocked.add(r.account_id);
      continue;
    }
    if (r.nominal_expiry && time(r.nominal_expiry) !== time(expiry)) fail('LIFECYCLE_EXPIRY_REWRITE');
    if (time(expiry) > now && ! r.deletion_requested) {
      decisions[r.id] = {
        action: 'retain', nominal_expiry: expiry
      };
      continue;
    }
    if (r.legacy) {
      decisions[r.id] = {
        action: 'conflict', reason: 'LEGACY_LIFECYCLE_TRANSITION_REQUIRED', nominal_expiry: expiry, deadline: expiry, dependency_refs: r.dependency_refs
      };
      if (r.account_id) blocked.add(r.account_id);
      continue;
    }
    const hold = r.hold_refs.map(id => holds.find(h => h.hold_id === id)).find(h => authorizedHold(h, r, now, ruleVersion,
    rules));
    if (hold) {
      decisions[r.id] = {
        action: 'retain_minimum', hold_id: hold.hold_id, review_due_at: iso(hold.review_due_at), nominal_expiry: expiry
      };
      continue;
    }
    if (needed.has(r.id) || ! r.terminal) {
      decisions[r.id] = {
        action: 'conflict', reason: 'LIFECYCLE_AUTHORITY_REQUIRED', nominal_expiry: expiry, dependency_refs: r.dependency_refs
      };
      if (r.account_id) blocked.add(r.account_id);
      continue;
    }
    decisions[r.id] = {
      action: 'purge', nominal_expiry: expiry
    };
  }
  const result = {
    schema_version: 1, rule_version: ruleVersion, planned_at: iso(now), decisions, blocked_accounts: [... blocked].sort(),
    ready: ! Object.values(decisions).some(x => x.action === 'conflict')
  };
  return {
    ... result, checksum: digestJSON(result)
  };
}
function validateAggregate(a, assessment) {
  const allowed = new Set(['count', 'period', 'currency', 'totalMicros']);
  if (! a || ! Number.isSafeInteger(a.count) || a.count < 5 || Object.keys(a).some(k => ! allowed.has(k)) || ! /^[0-9]{4}(?:-Q[1-4])?$/.test(a.period || '') || a.currency !== 'usd' || ! Number.isSafeInteger(a.totalMicros) || a.totalMicros < 0 || assessment?.approved !== true || assessment.irreversible !== true || ! assessment.evidence_ref) fail('AGGREGATE_PRIVACY_UNPROVEN');
  return true;
}
function assertSourceEpochOpen( {
  namespace, canonical_created_at, seals =[], retainedException
}
= {
}) {
  if (! Number.isFinite(Date.parse(canonical_created_at))) fail('CANONICAL_SOURCE_TIME_REQUIRED');
  const seal = seals.find(s => s.namespace === namespace && Date.parse(canonical_created_at) <= Date.parse(s.source_created_through));
  if (seal && !(retainedException?.authorized === true && retainedException.namespace === namespace && retainedException.canonical_created_at === canonical_created_at && retainedException.effect_id && retainedException.evidence_ref && retainedException.expires_at && Date.parse(retainedException.expires_at) > Date.now())) fail('SOURCE_EPOCH_CLOSED');
  return true;
}
function assertCopyClosure(copies, now = Date.now()) {
  for (const c of copies) if (c.accessible !== false || c.version_inventory_complete !== true || c.replica_inventory_complete !== true || ! c.verified_deleted_at || time(c.verified_deleted_at) > time(now)) fail('COPY_CLOSURE_UNPROVEN');
  return true;
}
function validateLifecycleControl(c) {
  if (! c || c.schema_version !== 1 || ! c.rule_version || ! c.approval_ref || ! Number.isSafeInteger(c.deletion_barrier?.sequence) || c.deletion_barrier.sequence < 0 || ! /^[a-f0-9]{64}$/.test(c.deletion_barrier.hash || '') || ! Array.isArray(c.seals) || ! Array.isArray(c.records) || ! Array.isArray(c.holds)) fail('AUTHORITATIVE_LIFECYCLE_REQUIRED');
  return c;
}
function assertLifecycleForCheckpoint(control, now) {
  validateLifecycleControl(control);
  const plan = planLifecycle( {
    records: control.records, holds: control.holds, rules: control.rules, now, ruleVersion: control.rule_version
  });
  if (! plan.ready) fail(Object.values(plan.decisions).some(d => d.reason === 'LEGACY_LIFECYCLE_TRANSITION_REQUIRED') ? 'LEGACY_LIFECYCLE_TRANSITION_REQUIRED': 'LIFECYCLE_CHECKPOINT_CONFLICT');
  if (Object.values(plan.decisions).some(d => d.action === 'purge')) fail('LIFECYCLE_PURGE_REQUIRED_BEFORE_CHECKPOINT');
  return plan;
}
async function persistLifecyclePlan( {
  epoch, writer, coordinator, plan
}) {
  require('./money-writer-lock').assertMoneyWriter(writer, {
    root: epoch.legacy_root
  });
  const {
    checksum, ... body
  }
  = plan;
  if (checksum !== digestJSON(body)) fail('LIFECYCLE_PLAN_CHANGED');
  return coordinator.withMoneyControl( {
    kind: 'lifecycle', accounts: plan.blocked_accounts
  }, () => {
    const e = require('./financial-epoch'), p = require('./stripe-transfer-persistence'), file = e.pathFor('lifecycle', epoch),
    s = p.readJSONStrict(file);
    s.blocked_accounts ||= {
    };
    s.conflicts ||= {
    };
    for (const[id, d] of Object.entries(plan.decisions)) if (d.action === 'conflict') s.conflicts[id] = {
      ... d, rule_version: plan.rule_version, planned_at: plan.planned_at
    };
    for (const id of plan.blocked_accounts) s.blocked_accounts[id] = {
      plan_checksum: checksum, reason: 'LEGACY_LIFECYCLE_TRANSITION_REQUIRED'
    };
    s.last_plan_checksum = checksum;
    p.writeJSONAtomic(file, s);
    return {
      recorded: true, ready: plan.ready
    };
  });
}
function checkDeletionDependencies( {
  epoch, accountId, requestedAt, authoritativeControl
}
= {
}) {
  const fs = require('fs'), path = require('path'), e = require('./financial-epoch');
  if (typeof accountId !== 'string' || ! accountId) fail('LIFECYCLE_ACCOUNT_REQUIRED');
  const requested = iso(requestedAt || Date.now());
  const deadline = iso(time(requested) + 30 * DAY), refs =[];
  const has =(v) => {
    if (v === accountId) return true;
    if (typeof v === 'string' && /^[\s]*[\[{]/.test(v)) {
      try {
        return has(JSON.parse(v));
      } catch {
        return false;
      }
    }
    if (! v || typeof v !== 'object') return false;
    if (Object.prototype.hasOwnProperty.call(v, accountId)) return true;
    return Object.values(v).some(has);
  };
  function inspect(file, label) {
    if (! fs.existsSync(file)) return;
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) fail('LIFECYCLE_SYMLINK');
    if (! st.isFile()) return;
    const raw = fs.readFileSync(file, 'utf8');
    let values;
    try {
      values = file.endsWith('.jsonl') ? raw.split('\n').filter(Boolean).map(JSON.parse): [JSON.parse(raw)];
    } catch {
      refs.push( {
        scope: label, reason: 'UNVERIFIABLE_IDENTITY_REFERENCE'
      });
      return;
    }
    if (values.some(has)) refs.push( {
      scope: label, reason: 'RETAINED_IDENTITY_REFERENCE'
    });
  }
  const {
    binding
  }
  = e.requireEpoch(epoch);
  for (const[name, row] of Object.entries(binding.identity.additional_observed || binding.identity.observed)) if (row.state === 'present') inspect(path.join(epoch.legacy_root,
  name), 'legacy:' + name);
  inspect(path.join(epoch.legacy_root, 'stripe-quarantined-events.json'), 'legacy:capture');
  for (const name of fs.readdirSync(epoch.legacy_root)) if (name.startsWith('audit-extractions.') || name === 'tos-acceptance.jsonl' || name === 'identity.json') inspect(path.join(epoch.legacy_root,
  name), 'legacy:' + name);
  if (refs.length) return {
    completed: false, allowed: false, reason: 'LEGACY_LIFECYCLE_TRANSITION_REQUIRED', deadline, references: refs
  };
  const runtimeStore=e.activeStore(epoch);
  const failureFile=path.join(epoch.financial_dir,require('./money-failure-control').FILE);
  if(fs.existsSync(failureFile)){
    const proof=runtimeStore?.failureControlProof?.();
    if(!proof||proof.state==='recovery_scan'||proof.state!=='idle'&&(!proof.anchor?.accountDigest||proof.anchor.accountDigest===digestJSON(accountId)))return {completed:false,allowed:false,reason:'LIFECYCLE_FAILURE_RECOVERY_REQUIRED',deadline,references:[{scope:'first_failure_control',count:1}]};
  }
  const walDirectory=e.pathFor('wal',epoch);
  if(fs.existsSync(walDirectory))for(const name of fs.readdirSync(walDirectory)){if(!name.endsWith('.compensation.json'))continue;inspect(path.join(walDirectory,name),'canceled_wal');}
  if(refs.length)return {completed:false,allowed:false,reason:'LIFECYCLE_ACTIVE_FINANCIAL_DEPENDENCY',deadline,references:refs};
  const collect=(method,options)=>{const rows=[];let after;do{const page=runtimeStore[method]({...options,after,limit:1000});rows.push(...page.items);after=page.nextCursor;}while(after);return rows;};
  const journal = runtimeStore ? {sources:collect('listSources',{accountId}),operations:collect('listOperations',{accountId})} : require('./money-database').exportMoneyDatabase({file:e.pathFor('money_database',epoch),epoch,descriptor:e.readParticipant('money_control',epoch)});
  const activeSources = Object.values(journal.sources || {
  }).filter(x => x.accountId === accountId && x.amountMicros - x.spentMicros - x.retiredMicros > 0);
  const pending = Object.values(journal.operations || {
  }).filter(x => x.accountId === accountId && !['settled', 'failed', 'canceled', 'requote_required'].includes(x.state));
  const earnings = e.readParticipant('earnings', epoch)[accountId];
  const credits = e.readParticipant('credits', epoch)[accountId];
  if (activeSources.length || pending.length ||(earnings?.pending_balance || 0) > 0 ||(earnings?.unassented_pending || 0) > 0 ||(credits?.dollar_lots ||[]).some(x =>(x.remaining_usd || 0) > 0)) return {
    completed: false, allowed: false, reason: 'LIFECYCLE_ACTIVE_FINANCIAL_DEPENDENCY', deadline, references: [ {
      scope: 'active_financial', count: activeSources.length + pending.length
    }]
  };
  try {
    validateLifecycleControl(authoritativeControl);
  } catch {
    return {
      completed: false, allowed: false, reason: 'LIFECYCLE_RULE_UNRESOLVED', deadline, references: []
    };
  }
  const owned = authoritativeControl.records.filter(r => r.account_id === accountId);
  if (owned.length) {
    const plan = planLifecycle( {
      records: authoritativeControl.records, holds: authoritativeControl.holds, rules: authoritativeControl.rules, now: requested,
      ruleVersion: authoritativeControl.rule_version
    });
    if (owned.some(r =>['conflict', 'retain_minimum'].includes(plan.decisions[r.id]?.action))) return {
      completed: false, allowed: false, reason: 'LIFECYCLE_ACTIVE_FINANCIAL_DEPENDENCY', deadline, references: [ {
        scope: 'approved_lifecycle', count: owned.length
      }]
    };
  }
  const copies = path.join(epoch.legacy_root, '.money-checkpoints');
  if (fs.existsSync(copies)) for (const name of fs.readdirSync(copies)) {
    const dir = path.join(copies, name);
    if (! fs.lstatSync(dir).isDirectory()) continue;
    const manifest = path.join(dir, 'money-checkpoint-manifest.json');
    if (! fs.existsSync(manifest)) return {
      completed: false, allowed: false, reason: 'LIFECYCLE_COPY_INVENTORY_REQUIRED', deadline, references: [ {
        scope: 'checkpoint', count: 1
      }]
    };
    // Expiry schedules deletion; inspect every still-accessible copy regardless of date.
    const before = refs.length;
    const cp=require('./money-checkpoint'),copyManifest=require('./stripe-transfer-persistence').readJSONStrict(manifest);
    if(copyManifest.schema_version===2) {
      if(copyManifest.checksum!==e.seal(copyManifest).checksum)fail('LIFECYCLE_COPY_INVENTORY_REQUIRED');
      const needles=[Buffer.from(JSON.stringify(accountId)),Buffer.from(JSON.stringify(JSON.stringify(accountId)).slice(1,-1))];let tail=Buffer.alloc(0),found=false;
      const result=cp.scanCheckpointArchive(path.join(dir,cp.ARCHIVE),copyManifest,{start(){tail=Buffer.alloc(0);},chunk(entry,raw){const bytes=Buffer.concat([tail,raw]);if(needles.some(n=>bytes.includes(n)))found=true;tail=bytes.subarray(Math.max(0,bytes.length-Math.max(...needles.map(n=>n.length))));}});
      if(result.sha256!==copyManifest.archive.sha256)fail('LIFECYCLE_COPY_INVENTORY_REQUIRED');
      if(found)return {completed:false,allowed:false,reason:'LIFECYCLE_COPY_DELETION_BARRIER_REQUIRED',deadline,references:[{scope:'checkpoint',count:1}]};
      continue;
    }
    const walkCopy = directory => {
      for (const entry of fs.readdirSync(directory)) {
        const file = path.join(directory,entry), st = fs.lstatSync(file);
        if(st.isSymbolicLink()) fail('LIFECYCLE_SYMLINK');
        if(st.isDirectory()) walkCopy(file);
        else if(st.isFile() && /\.jsonl?$/.test(entry)) inspect(file,'checkpoint');
        else if(st.isFile() && entry.endsWith('.sqlite')) {const raw=fs.readFileSync(file);if(raw.includes(Buffer.from(JSON.stringify(accountId))))refs.push({scope:'checkpoint',reason:'RETAINED_DATABASE_IDENTITY_REFERENCE'});}
        else if(!st.isFile()) fail('LIFECYCLE_COPY_INVENTORY_REQUIRED');
      }
    };
    walkCopy(dir);
    if(refs.length > before) return {completed:false,allowed:false,reason:'LIFECYCLE_COPY_DELETION_BARRIER_REQUIRED',deadline,references:[{scope:'checkpoint',count:refs.length-before}]};
  }

  inspect(path.join(epoch.legacy_root, 'learnings.json'), 'catalog');
  if (refs.length && ! authoritativeControl.rules?.catalog_deletion_rule_ref) return {
    completed: false, allowed: false, reason: 'LIFECYCLE_RULE_UNRESOLVED', deadline, references: refs
  };
  return {
    completed: false, allowed: true, reason: null, deadline, references: refs
  };
}
async function requestAccountDeletion( {
  epoch, writer, coordinator, accountId, requestedAt, authoritativeControl
}
= {
}) {
  require('./money-writer-lock').assertMoneyWriter(writer, {
    root: epoch.legacy_root
  });
  return coordinator.withMoneyControl( {
    kind: 'deletion_dependencies', accounts: [accountId]
  }, () => {
    const result = checkDeletionDependencies( {
      epoch, accountId, requestedAt, authoritativeControl
    });
    if (! result.allowed) {
      const e = require('./financial-epoch'), p = require('./stripe-transfer-persistence'), file = e.pathFor('lifecycle', epoch),
      state = p.readJSONStrict(file);
      state.blocked_accounts ||= {
      };
      state.conflicts ||= {
      };
      const key = digestJSON(['deletion', epoch.epoch_id, accountId]);
      state.blocked_accounts[accountId] = {
        reason: result.reason, deadline: result.deadline
      };
      state.conflicts[key] = {
        account_id: accountId, requested_at: iso(requestedAt || Date.now()), ... result
      };
      p.writeJSONAtomic(file, state);
    }
    return result;
  });
}
function assertCompactionParticipantClosure( {
  epoch, store, snapshot, sourceIds, removed, copyInventory, participantSuccessors =[]
}
= {
}) {
  if (copyInventory?.complete !== true || copyInventory.version_inventory_complete !== true || copyInventory.replica_inventory_complete !== true || copyInventory.unexpired_referencing_copies !== 0 || ! copyInventory.evidence_ref || ! /^[a-f0-9]{64}$/.test(copyInventory.digest || '')) fail('COMPACTION_COPY_CLOSURE_REQUIRED');
  const fs = require('fs'), path = require('path'), identifiers = new Set(sourceIds);
  const failureFile=path.join(epoch.financial_dir,require('./money-failure-control').FILE);
  if(fs.existsSync(failureFile)){const proof=store?.failureControlProof?.();if(!proof||proof.state!=='idle')fail('COMPACTION_FAILURE_RECOVERY_REQUIRED');}
  for (const[collection, ids] of Object.entries(removed)) for (const id of ids) {
    identifiers.add(id);
    const row = snapshot[collection]?.[id];
    const collect = v => {
      if (! v || typeof v !== 'object') return;
      for (const[k, x] of Object.entries(v)) {
        if (typeof x === 'string' &&(/(?:^id$|_id$|Id$|^idempotency_key$)/.test(k)) && !['account_id', 'accountId', 'owner',
        'platform_account_id', 'stripe_platform_account_id', 'epoch_id', 'policy_consent_id'].includes(k)) identifiers.add(x);
        else if (x && typeof x === 'object') collect(x);
      }
    };
    collect(row);
  }
  const contains = v => {
    if (typeof v === 'string') {
      if (identifiers.has(v)) return true;
      if (/^[\s]*[\[{]/.test(v)) {
        try {
          return contains(JSON.parse(v));
        } catch {
          return false;
        }
      }
      return false;
    }
    if (! v || typeof v !== 'object') return false;
    return Object.entries(v).some(([k, x]) => identifiers.has(k) || contains(x));
  };
  for (const[collection, records] of Object.entries(snapshot)) {
    if (collection === 'lifecycle' || ! records || typeof records !== 'object' || Array.isArray(records)) continue;
    for (const[id, row] of Object.entries(records)) if (! removed[collection]?.has(id) && contains(row)) fail('COMPACTION_CROSS_BOUNDARY_REFERENCE');
  }
  const journal = path.join(epoch.financial_dir, 'money-control.json'),database=path.join(epoch.financial_dir,'money-control.sqlite');
  function scan(dir) {
    for (const n of fs.readdirSync(dir)) {
      const file = path.join(dir, n);
      if (file === journal || file === database || n === '.money-writer.lock' || n === '.money-control.sock') continue;
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink()) fail('COMPACTION_PARTICIPANT_REFERENCE_UNVERIFIED');
      if (st.isDirectory()) {
        scan(file);
        continue;
      }
      if(st.isFile()&&n===require('./money-checkpoint').ARCHIVE){
        const cp=require('./money-checkpoint'),e=require('./financial-epoch'),manifest=JSON.parse(fs.readFileSync(path.join(dir,cp.MANIFEST)));
        if(manifest.checksum!==e.seal(manifest).checksum)fail('COMPACTION_PARTICIPANT_REFERENCE_UNVERIFIED');
        const needles=[...identifiers].map(id=>Buffer.from(id)),max=Math.max(0,...needles.map(x=>x.length));let tail=Buffer.alloc(0),found=false;
        const result=cp.scanCheckpointArchive(file,manifest,{start(){tail=Buffer.alloc(0);},chunk(entry,chunk){const raw=Buffer.concat([tail,chunk]);if(needles.some(id=>raw.includes(id)))found=true;tail=raw.subarray(Math.max(0,raw.length-max));}});
        if(result.sha256!==manifest.archive.sha256)fail('COMPACTION_PARTICIPANT_REFERENCE_UNVERIFIED');
        if(found)fail('LEGACY_LIFECYCLE_TRANSITION_REQUIRED');continue;
      }
      if(st.isFile()&&n.endsWith('.sqlite')){const raw=fs.readFileSync(file);if([...identifiers].some(id=>raw.includes(Buffer.from(id))))fail('LEGACY_LIFECYCLE_TRANSITION_REQUIRED');continue;}
      if (! st.isFile() || !(/\.jsonl?$/.test(n))) continue;
      let values;
      try {
        const replacement = participantSuccessors.find(r => path.join(epoch.legacy_root, r.path) === file);
        const raw = fs.readFileSync(file, 'utf8');
        values = replacement ?(replacement.jsonl ? replacement.value: [replacement.value]): (n.endsWith('.jsonl') ? raw.split('\n').filter(Boolean).map(JSON.parse): [JSON.parse(raw)]);
      } catch {
        fail('COMPACTION_PARTICIPANT_REFERENCE_UNVERIFIED');
      }
      if (values.some(contains)) fail(file.startsWith(epoch.financial_dir + path.sep) ? 'COMPACTION_PARTICIPANT_RETIREMENT_REQUIRED': 'LEGACY_LIFECYCLE_TRANSITION_REQUIRED');
    }
  }
  scan(epoch.legacy_root);
  return true;
}
// Explicit typed successor reductions; never accepts arbitrary caller JSON patches.
function planParticipantSuccessors( {
  epoch, snapshot, removed, closure
}) {
  const fs = require('fs'), path = require('path'), e = require('./financial-epoch'), crypto = require('crypto');
  const ids = new Set();
  function collect(v) {
    if (! v || typeof v !== 'object') return;
    for (const[k, x] of Object.entries(v)) {
      if (typeof x === 'string' && /(?:^id$|_id$|Id$|^idempotency_key$)/.test(k) && !['accountId', 'account_id', 'owner', 'platform_account_id',
      'stripe_platform_account_id', 'epoch_id', 'policy_consent_id'].includes(k)) ids.add(x);
      else collect(x);
    }
  }
  for (const[name, set] of Object.entries(removed)) for (const id of set) {
    ids.add(id);
    collect(snapshot[name][id]);
  }
  function matches(v) {
    if (typeof v === 'string') return ids.has(v);
    if (! v || typeof v !== 'object') return false;
    return Object.entries(v).some(([k, x]) => ids.has(k) || matches(x));
  }
  function authorize(name, id) {
    const d = closure.decisions?.['participants/' + name + '/' + id];
    if (! d || d.authorized !== true || d.expired !== true || d.dependency_free !== true || d.rule_version !== closure.rule_version || ! d.evidence_ref || ! Number.isFinite(Date.parse(d.nominal_expiry)) || Date.parse(d.nominal_expiry) > Date.now()) fail('COMPACTION_PARTICIPANT_AUTHORITY_REQUIRED');
  }
  const results =[];
  for (const name of['credits', 'earnings', 'stripe_checkout_intents', 'stripe_object_origins', 'stripe_event_receipts',
  'purchases', 'withdrawals', 'settlements', 'unlock_events', 'event_dispositions']) {
    const file = e.pathFor(name, epoch), raw = fs.readFileSync(file), lines = file.endsWith('.jsonl');
    let value = lines ? raw.toString().split('\n').filter(Boolean).map(JSON.parse): JSON.parse(raw), changed = false;
    function keep(row, id) {
      if (! matches(row) && ! ids.has(id)) return true;
      authorize(name, id);
      changed = true;
      return false;
    }
    if (name === 'credits' || name === 'earnings') {
      for (const[owner, account] of Object.entries(value)) {
        if (! account || typeof account !== 'object') continue;
        if (name === 'credits' && Array.isArray(account.dollar_lots)) account.dollar_lots = account.dollar_lots.filter(lot => {
          if (! matches(lot)) return true;
          if (lot.remaining_usd !== 0 ||(lot.inflight_usd || 0) !== 0 || lot.pending_reversal || lot.disputed || lot.frozen ||(lot.funded_unlocks ||[]).some(u => u.pending_reversal ||(! u.reversed && ! ids.has(u.unlock_id)))) fail('COMPACTION_CREDIT_DEPENDENCY');
          return keep(lot, lot.lot_id);
        });
        for (const[id, receipt] of Object.entries(account.money_receipts || {
        })) if (! keep(receipt, id)) delete account.money_receipts[id];
        // Financial summary balances and by-learning entitlements remain untouched.
      }
    } else if (name === 'stripe_checkout_intents') {
      for (const[id, row] of Object.entries(value.intents || {
      })) {
        if (matches(row) && row.state !== 'credited' && row.state !== 'paid_credited') fail('COMPACTION_CHECKOUT_DEPENDENCY');
        if (! keep(row, id)) delete value.intents[id];
      }
    } else if (name === 'stripe_object_origins') {
      value.records =(value.records ||[]).filter(row => keep(row, row.origin_id || row.id || row.object_id));
    } else if (name === 'stripe_event_receipts') {
      for (const[id, row] of Object.entries(value.receipts || {
      })) {
        if (matches(row) && row.state !== 'applied' && row.state !== 'completed') fail('COMPACTION_EVENT_DEPENDENCY');
        if (! keep(row, id)) delete value.receipts[id];
      }
    } else if (lines) {
      value = value.filter((row, index) => keep(row, row.id || row.event_id || row.unlock_id || row.operation_id || String(index)));
    } else if (name === 'event_dispositions') {
      for (const[id, row] of Object.entries(value.events || value.dispositions || {
      })) {
        if (matches(row) && !['applied', 'legacy_restricted', 'unmatched_restricted'].includes(row.state)) fail('COMPACTION_EVENT_DEPENDENCY');
        if (! keep(row, id)) delete(value.events || value.dispositions)[id];
      }
    }
    if (changed) results.push( {
      name, path: path.relative(epoch.legacy_root, file), prior_sha256: crypto.createHash('sha256').update(raw).digest('hex'),
      value, jsonl: lines
    });
  }
  return results;
}
function sealParticipantSuccessors( {
  epoch, participants, seal, totals
}) {
  const crypto = require('crypto');
  return participants.map(row => {
    const value = structuredClone(row.value);
    const body = {
      schema_version: 1, binding_digest: epoch.binding_digest, prior_participant_checksum: row.prior_sha256, source_created_through: seal.source_created_through,
      seal, conserved_totals: totals
    };
    const receipt = {
      ... body, receipt_digest: digestJSON(body)
    };
    if (['stripe_checkout_intents', 'stripe_event_receipts'].includes(row.name)) value.initialization_manifest.lifecycle_successor = receipt;
    if (row.name === 'stripe_object_origins') value.manifest.lifecycle_successor = receipt;
    if (! row.jsonl && Object.hasOwn(value, 'checksum')) {
      delete value.checksum;
      value.checksum = digestJSON(value);
    }
    const bytes = row.jsonl ? value.map(x => JSON.stringify(x)).join('\n') +(value.length ? '\n': ''): JSON.stringify(value,
    null, 2) + '\n';
    return {
      name: row.name, path: row.path, prior_sha256: row.prior_sha256, next_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes
    };
  });
}
const LIFECYCLE_BARRIER = 'money-lifecycle-barrier.json';
function lifecycleBarrier(root) {
  const fs = require('fs'), path = require('path'), p = require('./stripe-transfer-persistence');
  const file = path.join(root, LIFECYCLE_BARRIER);
  if (! fs.existsSync(file)) return null;
  const b = p.readJSONStrict(file), {
    checksum, ... body
  }
  = b;
  if (checksum !== digestJSON(body) || b.schema_version !== 1 || !['installing', 'restart_required', 'committed'].includes(b.state) || ! /^[-a-f0-9]{36}$/.test(b.id || '')) fail('LIFECYCLE_BARRIER_CORRUPT');
  return b;
}
function planDatabaseSuccessor({prior,next,auxiliary,closure}) {
  const removed=new Set();
  function collect(value){if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){if(typeof item==='string'&&/(?:^id$|_id$|Id$|^idempotency_key$)/.test(key)&&!['account_id','accountId','owner','platform_account_id','epoch_id','binding_digest','policy_consent_id'].includes(key))removed.add(item);else if(item&&typeof item==='object')collect(item);}}
  for(const collection of require('./money-database').COLLECTIONS)if(collection!=='lifecycle')for(const[id,row]of Object.entries(prior[collection]||{}))if(!Object.hasOwn(next[collection]||{},id)){removed.add(id);collect(row);}
  const contains=value=>{if(typeof value==='string'){if(removed.has(value))return true;if(/^[\s]*[\[{]/.test(value)){try{return contains(JSON.parse(value));}catch{}}return false;}return value&&typeof value==='object'&&Object.entries(value).some(([k,v])=>removed.has(k)||contains(v));};
  function permitted(key){const d=closure.decisions?.[key];return d?.authorized===true&&d.expired===true&&d.dependency_free===true&&d.rule_version===closure.rule_version&&d.evidence_ref&&Number.isFinite(Date.parse(d.nominal_expiry));}
  const scans=auxiliary.providerScanSeeds;
  if(scans){
    if(!Array.isArray(scans.controls)||!Array.isArray(scans.members)||!Array.isArray(scans.current))fail('COMPACTION_PROVIDER_SCAN_INVALID');
    if(scans.controls.length||scans.members.length)fail('COMPACTION_PROVIDER_SCAN_UNFINISHED');
    if(scans.current.some(contains))fail('COMPACTION_PROVIDER_CUT_DEPENDENCY');
  }
  const successor=structuredClone(auxiliary);
  successor.evidenceSeeds=auxiliary.evidenceSeeds.filter(row=>{
    if(!contains(row))return true;
    if(!['checkout_intents','object_origins','event_receipts','enrollment_proofs','event_dispositions'].includes(row.namespace))fail('COMPACTION_DATABASE_REFERENCE_REQUIRED');
    const terminal=row.namespace==='object_origins'||row.namespace==='enrollment_proofs'||(row.namespace==='checkout_intents'&&['paid_credited','confirmed_not_created','confirmed_expired_unpaid'].includes(row.payload.state))||(row.namespace==='event_receipts'&&row.payload.state==='completed')||(row.namespace==='event_dispositions'&&row.payload.disposition==='applied');
    if(!terminal||!permitted('database/'+row.namespace+'/'+row.id))fail('COMPACTION_DATABASE_REFERENCE_REQUIRED');
    return false;
  });
  successor.auditSeeds=auxiliary.auditSeeds.filter(row=>{if(!contains(row))return true;const changes=row.payload?.changes||[];if(!changes.length||changes.some(change=>!removed.has(change.id))||(row.payload.evidence||[]).length||!permitted('database/audit_events/'+row.revision))fail('COMPACTION_DATABASE_AUDIT_DEPENDENCY');return false;});
  if(successor.capacitySeeds.some(contains)||contains(successor.metadataSeed))fail('COMPACTION_DATABASE_CAPACITY_DEPENDENCY');
  return {prior_digest:digestJSON(auxiliary),successor,retired_identifiers:[...removed].sort()};
}

function applyLifecycleSuccessor( {
  epoch, writer, store, plan, executionApproval, stoppedWriterEvidence, afterStep =() => {
  }
}) {
  const fs = require('fs'), path = require('path'), crypto = require('crypto'), p = require('./stripe-transfer-persistence'),
  m = require('./money-control-store');
  require('./money-writer-lock').assertMoneyWriter(writer, {
    root: epoch.legacy_root
  });
  if (stoppedWriterEvidence?.stopped !== true || ! stoppedWriterEvidence.evidence_ref) fail('STOPPED_WRITER_EVIDENCE_REQUIRED');
  if (executionApproval?.authorized !== true || executionApproval.plan_digest !== m.digest(plan) || executionApproval.prior_digest !== plan.prior_digest || ! executionApproval.execution_approval_ref) fail('COMPACTION_EXECUTION_AUTHORITY_REQUIRED');
  const verified = store.planCompaction( {
    approval: plan.approval, next: plan.next
  });
  if (m.digest(verified) !== m.digest(plan)) fail('COMPACTION_PLAN_CHANGED');
  if (lifecycleBarrier(epoch.legacy_root)) fail('LIFECYCLE_RECOVERY_REQUIRED');
  const id = crypto.randomUUID(), stage = path.join(epoch.legacy_root, '.money-lifecycle', id);
  fs.mkdirSync(stage, {
    recursive: true, mode: 0o700
  });
  const next = structuredClone(plan.next);
  next.revision = plan.revision + 1;
  if(!plan.database_auxiliary || plan.database_auxiliary.prior_digest!==digestJSON(store.exportDatabaseAuxiliary()))fail('COMPACTION_DATABASE_PLAN_CHANGED');
  const databaseFile=store.file, databaseIndex=(plan.participants||[]).length, stagedDatabase=path.join(stage,String(databaseIndex));
  require('./money-database').createMoneyDatabase({file:stagedDatabase,epoch,snapshot:next,databaseId:store.descriptor.database_id,...plan.database_auxiliary.successor,databaseSchema:store.descriptor.database_schema});
  require('./money-database').validateMoneyDatabase({file:stagedDatabase,epoch,descriptor:store.descriptor});
  const journalBytes=fs.readFileSync(stagedDatabase);
  for(const id of plan.database_auxiliary.retired_identifiers)if(journalBytes.includes(Buffer.from(id)))fail('COMPACTION_IDENTIFIER_RETAINED_IN_DATABASE');
  const rows=[...(plan.participants||[]),{name:'money_database',path:path.relative(epoch.legacy_root,databaseFile),prior_sha256:crypto.createHash('sha256').update(fs.readFileSync(databaseFile)).digest('hex'),next_sha256:crypto.createHash('sha256').update(journalBytes).digest('hex'),bytes:journalBytes}];
  let step = 0;
  const syncDir = dir => {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  for (let i = 0; i < rows.length; i++) {
    const f = path.join(stage, String(i));
    const alreadyDatabase=i===databaseIndex;
    const fd = fs.openSync(f, alreadyDatabase ? 'r' : 'wx', 0o600);
    try {
      if(!alreadyDatabase)fs.writeFileSync(fd, rows[i].bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    afterStep(++ step);
  }
  const body = {
    schema_version: 1, id, epoch_id: epoch.epoch_id, binding_digest: epoch.binding_digest, plan_digest: m.digest(plan), approval_ref: executionApproval.execution_approval_ref,
    rows: rows.map(( {
      bytes, ... r
    }) => r)
  };
  p.writeJSONAtomic(path.join(stage, 'manifest.json'), {
    ... body, checksum: digestJSON(body)
  });
  syncDir(stage);
  syncDir(path.dirname(stage));
  store.close();
  const barrier = {
    schema_version: 1, id, state: 'installing', manifest_digest: digestJSON(body), epoch_id: epoch.epoch_id, binding_digest: epoch.binding_digest
  };
  p.writeJSONAtomic(path.join(epoch.legacy_root, LIFECYCLE_BARRIER), {
    ... barrier, checksum: digestJSON(barrier)
  });
  afterStep(++ step);
  finishLifecycleFiles( {
    root: epoch.legacy_root, writer, afterStep: () => afterStep(++ step)
  });
  writer.close();
  return {
    completed: false, restart_required: true, successor_id: id
  };
}
function finishLifecycleFiles( {
  root, writer, afterStep =() => {
  }
}) {
  const fs = require('fs'), path = require('path'), crypto = require('crypto'), p = require('./stripe-transfer-persistence'),
  e = require('./financial-epoch');
  require('./money-writer-lock').assertMoneyWriter(writer, {
    root
  });
  const b = lifecycleBarrier(root);
  if (! b) fail('LIFECYCLE_BARRIER_REQUIRED');
  const stage = e.confined(path.join(root, '.money-lifecycle', b.id), 'directory'), manifest = p.readJSONStrict(e.confined(path.join(stage,
  'manifest.json'), 'file')), {
    checksum, ... body
  }
  = manifest;
  if (checksum !== digestJSON(body) || b.manifest_digest !== checksum || b.binding_digest !== body.binding_digest || b.epoch_id !== body.epoch_id) fail('LIFECYCLE_SUCCESSOR_CORRUPT');
  const binding = e.validateBinding(p.readJSONStrict(path.join(root, e.BINDING_FILE)));
  if (binding.binding_digest !== b.binding_digest) fail('LIFECYCLE_SUCCESSOR_BINDING_CHANGED');
  const hash = raw => crypto.createHash('sha256').update(raw).digest('hex');
  for (let i = 0; i < body.rows.length; i++) {
    const row = body.rows[i], relative = path.join('financial-epochs', b.epoch_id, e.PARTICIPANTS[row.name] || 'INVALID');
    if (row.path !== relative) fail('LIFECYCLE_SUCCESSOR_PATH_INVALID');
    const source = e.confined(path.join(stage, String(i)), 'file'), destination = e.confined(path.join(root, row.path), 'file'),
    bytes = fs.readFileSync(source), current = hash(fs.readFileSync(destination));
    if (hash(bytes) !== row.next_sha256 || ![row.prior_sha256, row.next_sha256].includes(current)) fail('LIFECYCLE_SUCCESSOR_HASH_CHANGED');
    if (current !== row.next_sha256) {
      const tmp = destination + '.lifecycle-tmp';
      if (fs.existsSync(tmp)) {
        e.confined(tmp, 'file');
        if (hash(fs.readFileSync(tmp)) !== row.next_sha256) fail('LIFECYCLE_SUCCESSOR_HASH_CHANGED');
      } else {
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, bytes);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
      afterStep();
      fs.renameSync(tmp, destination);
      const dirfd = fs.openSync(path.dirname(destination), 'r');
      try {
        fs.fsyncSync(dirfd);
      } finally {
        fs.closeSync(dirfd);
      }
    }
    afterStep();
  }
  const next = {
    ... b, state: 'restart_required'
  };
  delete next.checksum;
  p.writeJSONAtomic(path.join(root, LIFECYCLE_BARRIER), {
    ... next, checksum: digestJSON(next)
  });
  return {
    body, stage
  };
}
function recoverLifecycleSuccessor( {
  root, writer, stoppedWriterEvidence
}) {
  if (stoppedWriterEvidence?.stopped !== true || ! stoppedWriterEvidence.evidence_ref) fail('STOPPED_WRITER_EVIDENCE_REQUIRED');
  require('./money-writer-lock').assertMoneyWriter(writer, {
    root
  });
  const fs = require('fs'), path = require('path'), crypto = require('crypto'), p = require('./stripe-transfer-persistence'),
  e = require('./financial-epoch');
  let b = lifecycleBarrier(root);
  if (! b) {
    const base = path.join(root, '.money-lifecycle');
    if (fs.existsSync(base)) for (const id of fs.readdirSync(e.confined(base, 'directory'))) {
      if (! /^[-a-f0-9]{36}$/.test(id)) fail('LIFECYCLE_SUCCESSOR_PATH_INVALID');
      const stage = e.confined(path.join(base, id), 'directory');
      for (const name of fs.readdirSync(stage)) {
        if (! /^(?:[0-9]+|manifest\.json)$/.test(name)) fail('LIFECYCLE_SUCCESSOR_PATH_INVALID');
        e.confined(path.join(stage, name), 'file');
      }
      fs.rmSync(stage, {
        recursive: true
      });
    }
    return {
      completed: false, discarded_unpublished_stage: true
    };
  }
  let body, stage;
  if (b.state === 'committed') {
    body = b.manifest;
    stage = path.join(root, '.money-lifecycle', b.id);
    if (! body || digestJSON(body) !== b.manifest_digest) fail('LIFECYCLE_SUCCESSOR_CORRUPT');
  } else {
    ( {
      body, stage
    }
    = finishLifecycleFiles( {
      root, writer
    }));
    b = lifecycleBarrier(root);
  }
  for (const row of body.rows) {
    const file = e.confined(path.join(root, row.path), 'file');
    if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== row.next_sha256) fail('LIFECYCLE_SUCCESSOR_HASH_CHANGED');
  }
  const binding = e.validateBinding(p.readJSONStrict(path.join(root, 'financial-epoch.json')));
  const financialDir=path.join(root,'financial-epochs',body.epoch_id);
  require('./money-database').validateMoneyDatabase({file:path.join(financialDir,'money-control.sqlite'),descriptor:p.readJSONStrict(path.join(financialDir,'money-control.json')),epoch:{epoch_id:body.epoch_id,binding_digest:binding.binding_digest}});
  e.invalidateEpochRuntime(root);
  const committed = {
    ... b, state: 'committed', manifest: body
  };
  delete committed.checksum;
  p.writeJSONAtomic(path.join(root, LIFECYCLE_BARRIER), {
    ... committed, checksum: digestJSON(committed)
  });
  if (fs.existsSync(stage)) fs.rmSync(stage, {
    recursive: true
  });
  fs.unlinkSync(path.join(root, LIFECYCLE_BARRIER));
  const fd = fs.openSync(root, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return {
    completed: true, successor_id: body.id
  };
}
module.exports = {
  DAY, addCalendarYears, copyExpiry, nominalExpiry, planLifecycle, validateAggregate, assertSourceEpochOpen, assertCopyClosure,
  validateLifecycleControl, assertLifecycleForCheckpoint, persistLifecyclePlan, checkDeletionDependencies, requestAccountDeletion,
  assertCompactionParticipantClosure, planParticipantSuccessors, sealParticipantSuccessors, lifecycleBarrier, planDatabaseSuccessor, applyLifecycleSuccessor,
  recoverLifecycleSuccessor
};
