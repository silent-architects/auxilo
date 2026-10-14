'use strict';
const crypto = require('node:crypto');
const {
  AsyncLocalStorage
}
= require('node:async_hooks');
const {
  openMoneyStore, digest, integer, sum, fail
}
= require('./money-control-store');
const active = new AsyncLocalStorage(), liveContexts = new WeakSet();
let runtime = null;
const clone = v => structuredClone(v);
const TERMINAL = new Set(['settled', 'failed', 'canceled', 'requote_required']);
function toMicros(value) {
  const s = String(value);
  if (! /^(0|[1-9]\d*)(\.\d{1,6})?$/.test(s)) throw fail('INVALID_DECIMAL_MONEY');
  const[whole, fraction = ''] = s.split('.');
  const n = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('MONEY_OVERFLOW');
  return Number(n);
}
function returnFigures(G, C, unit = 10000, minimum = 10000) {
  integer(G);
  integer(C);
  integer(unit);
  integer(minimum);
  if (unit !== 10000 || C >= G) throw fail('RETURN_BELOW_MINIMUM');
  const N = Number((BigInt(G) - BigInt(C)) / BigInt(unit) * BigInt(unit));
  if (N < minimum || ! N) throw fail('RETURN_BELOW_MINIMUM');
  const D = sum([N, C]);
  return {
    G, C, N, D, r: G - D
  };
}
function validateParticipantDraws({participantDraws,draws,accountId,getSource,getProjection}) {
  const keys=['lotId','kind','amountMicros','sourceId','promoReceiptId'],seen=new Set(),paid=[];
  if(!Array.isArray(participantDraws)||!participantDraws.length)throw fail('PARTICIPANT_DRAW_VECTOR_INVALID');
  let total=0n;
  for(const row of participantDraws){
    if(!row||Object.getPrototypeOf(row)!==Object.prototype||Reflect.ownKeys(row).length!==keys.length||keys.some(k=>{const d=Object.getOwnPropertyDescriptor(row,k);return !d||!d.enumerable||!Object.hasOwn(d,'value');}))throw fail('PARTICIPANT_DRAW_VECTOR_INVALID');
    const identifier=v=>typeof v==='string'&&!!v&&!v.includes('\0');
    if(!identifier(row.lotId)||seen.has(row.lotId)||!Number.isSafeInteger(row.amountMicros)||row.amountMicros<=0)throw fail('PARTICIPANT_DRAW_VECTOR_INVALID');
    seen.add(row.lotId);total+=BigInt(row.amountMicros);if(total>BigInt(Number.MAX_SAFE_INTEGER))throw fail('MONEY_OVERFLOW');
    if(row.kind==='dollar_paid'){
      if(!identifier(row.sourceId)||row.promoReceiptId!==null)throw fail('PARTICIPANT_DRAW_VECTOR_INVALID');
      const source=getSource(row.sourceId);if(!source||source.accountId!==accountId||source.provenance.lot_id!==row.lotId)throw fail('PARTICIPANT_DRAW_VECTOR_INVALID');
      paid.push({sourceId:row.sourceId,amountMicros:row.amountMicros});
    }else if(row.kind==='dollar_promo'){
      if(row.sourceId!==null||!identifier(row.promoReceiptId))throw fail('PARTICIPANT_DRAW_VECTOR_INVALID');
      const grant=getProjection(row.promoReceiptId);if(!grant||grant.state!=='acknowledged'||grant.owner!==accountId||grant.effect!=='promo_grant'||grant.payload?.lot_id!==row.lotId)throw fail('PARTICIPANT_DRAW_VECTOR_INVALID');
    }else throw fail('PARTICIPANT_DRAW_VECTOR_INVALID');
  }
  if(digest(paid)!==digest(draws))throw fail('PARTICIPANT_DRAW_VECTOR_INVALID');
  return Number(total);
}
function getActiveMoneyContext() {
  const c = active.getStore();
  return c && liveContexts.has(c) ? c: null;
}
function assertMoneyContext( {
  epoch, accountId
}
= {
}) {
  const c = getActiveMoneyContext();
  if (! c ||(epoch && c.epoch.epoch_id !== epoch.epoch_id) ||(accountId && c.accounts.length && ! c.accounts.includes(accountId))) throw fail('MONEY_CONTEXT_REQUIRED');
  c.writer.assertOwned();
  return c;
}
// One diagnostic line per durable specific gate (v3 4.3): which WAL/spend, which check, whether the first failure was retained.
function reportContinuationGate(control,error,result) {
  let held='none';
  try {const detail=control.statusDetail();held=detail.anchor?detail.anchor.kind+':'+detail.anchor.id:'none';} catch {}
  process.stderr.write('[money-recovery] gate=CONTINUATION_AUTHORITY_REQUIRED wal='+(error.walId??'')+' spend='+(error.spendId??'')+' check='+(error.check??'')+' retained_first='+(result?.retained_first===true)+' held_anchor='+held+'\n');
}
function createMoneyControl( {
  store, epoch = store?.epoch, writer, clock = Date.now, acquireGuards, validateSource, strictLiquidityRevision = false, getCapacityAuthority, capacityRequired = false
}
= {
}) {
  if (! store || ! epoch || ! writer?.assertOwned) throw fail('MONEY_RUNTIME_REQUIRED');
  require('./money-writer-lock').assertMoneyWriter(writer, {
    root: epoch.legacy_root
  });
  let poisoned = null;
  let failureControl = null;
  const recoveryAnchors = require('./money-recovery-anchor').createRecoveryAnchors({epoch,writer,store});
  function currentFailureControl() {
    if (failureControl) return failureControl;
    const root=store.getCapacityRecord('capacity:root');
    if(root?.profile.grouped?.commitProtocol==='single_sql_v1') failureControl=require('./money-failure-control').openFailureControl({epoch,writer,store,anchors:recoveryAnchors});
    return failureControl;
  }
  currentFailureControl();
  const successor=require('./money-continuation-authority').createSuccessorGate({epoch,writer,store,recoveryAnchors});
  // A2: EPOCH_RETIRED precedes everything (a retired source never serves, scans or commits); the successor gate applies
  // at context entry (E1), anchor registration (E2), every financial effect (E3) and commit (E4), never at boot ENTRY.
  function gate(options={},{successorGate=false}={}) {
    successor.assertNotRetired();
    if(successorGate)successor.assertAllows({action:options.action||'optional',anchor:options.recoveryAnchor||null});
    const control=currentFailureControl();
    if(!control){if(capacityRequired&&!store.getCapacityRecord('capacity:root'))throw fail('CAPACITY_RESERVE_REQUIRED');return;}
    if(options.recoveryAnchor){if(options.action==='provider_submit'){recoveryAnchors.revalidate(options.recoveryAnchor);control.assertNewEffectAllowed({action:'provider_submit'});}else control.assertRecoveryAllowed(options.recoveryAnchor,{action:options.action||'persist_result'});}
    else control.assertNewEffectAllowed({action:options.action||'optional'});
  }

  const capacityManager=require('./money-capacity').createCapacityManager({epoch,writer,store,requireGrouped:capacityRequired,getAuthority:getCapacityAuthority||(()=>epoch)});
  function makeContext(s, options, repository, transaction) {
    let dirty = false;
    const accounts =[... new Set(options.accounts ||[])].sort();
    const ctx = {
      epoch, writer, accounts, kind: options.kind || 'money'
    };
    let registeredAnchor=options.recoveryAnchor||null, recoveryAction=options.action||'persist_result';
    ctx.registerRecoveryAnchor=(capability,{action='persist_result'}={})=>{check();successor.assertNotRetired();successor.assertAllows({action,anchor:capability});recoveryAnchors.revalidate(capability);const control=currentFailureControl();if(control){if(action==='provider_submit')control.assertNewEffectAllowed({action});else control.assertRecoveryAllowed(capability,{action});}registeredAnchor=capability;recoveryAction=action;return true;};
    ctx.assertFinancialEffect=(action='participant_effect')=>{check();successor.assertNotRetired();successor.assertAllows({action:recoveryAction,anchor:registeredAnchor});const control=currentFailureControl();if(!control)return true;if(!registeredAnchor)throw fail('RECOVERY_ANCHOR_REQUIRED');return control.assertRecoveryAllowed(registeredAnchor,{action});};
    ctx.failureAnchor=()=>registeredAnchor;
    ctx.failureAction=()=>recoveryAction==='compensate'?'compensate':'participant_effect';
    ctx.noteRecoveryFailure=(error)=>{const control=failureControl;if(control&&registeredAnchor){const specific=error?.gate==='CONTINUATION_AUTHORITY',result=control.noteFailure({anchor:registeredAnchor,reason:specific?'CONTINUATION_AUTHORITY_REQUIRED':'MANDATORY_WRITE_FAILED',phase:recoveryAction,cutStatus:'unverified'});if(specific)reportContinuationGate(control,error,result);}};
    ctx.assertFinancialGate=()=>gate({recoveryAnchor:registeredAnchor,action:recoveryAction},{successorGate:true});

    ctx.acquireWorkspaceLease=input=>{check();return store.workspaceLease(transaction,'acquire',input);};
    ctx.releaseWorkspaceLease=input=>{check();return store.workspaceLease(transaction,'release',input);};
    ctx._capacityIsolate=fn=>{check();return store.withCapacityView(transaction,fn);};
    ctx._capacityWriteSetDigest=()=>{check();return repository.writeSetDigest();};
    ctx._capacityGet=id=>{check();return repository.getCapacity(id);};
    ctx._capacitySet=value=>{touch();return repository.setCapacity(value);};
    ctx._capacityRevision=()=>{check();return s.revision;};
    ctx._capacityReadEffect=effect=>{check();return effect.collection==='evidence'?repository.getEvidence(effect.namespace,effect.id)?.payload:repository.get(effect.collection,effect.id);};
    ctx.assertFundingCapacity=input=>{check();currentFailureControl()?.assertNewEffectAllowed({action:'new_funding'});return capacityManager.preflight(ctx,input);};
    ctx.reserveFundingCapacity=input=>{check();currentFailureControl()?.assertNewEffectAllowed({action:'new_funding'});return capacityManager.reserveFunding(ctx,input);};
    ctx.prepareCapacityAllowance=input=>{check();return capacityManager.prepare(ctx,input);};
    ctx.consumeCapacityAllowance=(allowance,effect)=>{check();return capacityManager.consume(ctx,allowance,effect);};
    ctx.recoverCapacityReserve=()=>{check();return capacityManager.recover(ctx);};
    function check() {
      if (getActiveMoneyContext() !== ctx) throw fail('MONEY_CONTEXT_REQUIRED');
      writer.assertOwned();
    }
    function touch() {
      check();
      ctx.assertFinancialGate();
      dirty = true;
    }
    function next() {
      touch();
      s.sequence = integer(s.sequence + 1);
      return s.sequence;
    }
    function source(id, owner) {
      const x = s.sources[id];
      if (! x ||(owner && x.accountId !== owner)) throw fail('SOURCE_NOT_FOUND');
      return x;
    }
    function operation(id) {
      const o = s.operations[id];
      if (! o) throw fail('OPERATION_NOT_FOUND');
      return o;
    }
    function principal(x) {
      const pending = sum(repository.sourceSpends(x.id).filter(v => v.state === 'prepared').flatMap(v => v.draws.filter(d => d.sourceId === x.id).map(d => d.amountMicros)));
      return x.amountMicros - x.spentMicros - x.retiredMicros - pending - sum(repository.rows('operations',{sourceId:x.id,nonterminal:true}).filter(o => ! TERMINAL.has(o.state) && ! o.principalRetired).map(o => o.D));
    }
    function poolRecompute(p, allocated) {
      const A = p.platformShareMicros - p.reversedMicros + p.recoveredMicros;
      const O = sum([p.coveredMicros, allocated === undefined ? sum(repository.rows('allocations',{poolId:p.id}).filter(a => a.poolId === p.id && a.state !== 'canceled').map(a => a.amountMicros)): allocated]);
      const fragmentWaiting = sum(p.fragments.map(f => f.waitingMicros));
      p.waitingMicros = p.otherCosts?.complete === true ? fragmentWaiting: Math.max(A - O, fragmentWaiting);
      p.availableMicros = Math.max(A - O - p.waitingMicros, 0);
      p.exposureMicros = Math.max(O - A, 0);
    }
    function waterfall() {
      const allocatedByPool = {
      };
      const affectedPools=repository.affectedPools();
      for (const a of affectedPools.flatMap(p=>repository.rows('allocations',{poolId:p.id}))) if (a.state !== 'canceled') allocatedByPool[a.poolId] = sum([allocatedByPool[a.poolId] || 0,
      a.amountMicros]);
      for (const p of affectedPools) {
        for (const f of p.fragments) {
          const src = source(f.sourceId), cost = s.costs[src.originalCostId];
          if (! f.remainingMicros) {
            f.waitingMicros = 0;
            continue;
          }
          if (! cost || src.originalClaim) {
            f.waitingMicros = f.remainingMicros;
            continue;
          }
          const outstanding = src.originalCostSettled ? 0: cost.amountMicros - cost.coveredMicros - cost.recoveredMicros - cost.reservedMicros;
          // A reversed realization cannot newly promise original-fee coverage.
          const backing = Math.max(p.platformShareMicros - p.reversedMicros + p.recoveredMicros - p.coveredMicros -(allocatedByPool[p.id] || 0),
          0);
          const use = Math.min(f.remainingMicros, outstanding, backing);
          if (use) {
            cost.coveredMicros = sum([cost.coveredMicros, use]);
            p.coveredMicros = sum([p.coveredMicros, use]);
            f.coveredMicros = sum([f.coveredMicros, use]);
            f.remainingMicros -= use;
          }
          // Known original costs are fully serviced before residual becomes eligible.
          f.waitingMicros = outstanding > use ? f.remainingMicros: 0;
          if (! f.waitingMicros) f.remainingMicros = 0;
        }
        if (p.otherCosts?.complete === true) {
          const costs = p.otherCosts.costIds.map(id => s.costs[id]);
          if (costs.some(c => ! c || c.kind !== 'source' || c.poolId !== p.id)) throw fail('SOURCE_COST_EVIDENCE_REQUIRED');
          const waiting = sum(p.fragments.map(f => f.waitingMicros));
          for (const cost of costs) {
            const free = Math.max(p.platformShareMicros - p.reversedMicros + p.recoveredMicros - p.coveredMicros - waiting -(allocatedByPool[p.id] || 0),
            0);
            const use = Math.min(free, cost.amountMicros - cost.coveredMicros - cost.recoveredMicros);
            cost.coveredMicros = sum([cost.coveredMicros, use]);
            p.coveredMicros = sum([p.coveredMicros, use]);
          }
        }
        poolRecompute(p, allocatedByPool[p.id] || 0);
      }
    }
    function newAdmission() {
      if ((accounts.length?accounts.flatMap(owner=>repository.rows('projections',{owner,state:'pending',limit:1})):repository.rows('projections',{state:'pending',limit:1})).length) throw fail('PROJECTION_RECOVERY_REQUIRED');
    }
    function policyValid(x) {
      const p = x.policy;
      if (! p || ! p.version || p.acknowledged !== true || ! p.evidence_ref || ! Number.isSafeInteger(p.effective_at) || ! Number.isSafeInteger(p.accepted_at) || ! Number.isSafeInteger(x.created_at) || p.accepted_at < p.effective_at || x.created_at < p.accepted_at) throw fail('POLICY_COHORT_INELIGIBLE');
    }
    function verifySource(x) {
      if (x.epoch_id !== epoch.epoch_id || x.binding_digest !== epoch.binding_digest || x.platform !== epoch.platform || x.platform_account_id !== epoch.platform_account_id || x.livemode !== epoch.livemode || x.currency !== 'usd' || ! x.payment_intent_id || ! x.accountId || ! x.id || ! x.provenance?.verified || !['intent_id',
      'origin_id', 'purchase_id', 'lot_id', 'receipt_digest'].every(k => typeof x.provenance[k] === 'string' && x.provenance[k])) throw fail('SOURCE_PROVENANCE_INVALID');
      policyValid(x);
      if (validateSource) validateSource(x, epoch);
    }
    ctx.recordFundingSource = input => {
      check();
      verifySource(input);
      integer(input.amountMicros);
      if (! input.amountMicros) throw fail('INVALID_MONEY_INTEGER');
      const immutable = clone(input), fingerprint = digest(immutable);
      if (s.sources[input.id]) {
        if (s.sources[input.id].input_digest !== fingerprint) throw fail('SOURCE_RECEIPT_CONFLICT');
        return clone(s.sources[input.id]);
      }
      newAdmission();
      if (s.lifecycle.source_seals?.length) require('./money-lifecycle').assertSourceEpochOpen( {
        namespace: epoch.platform + ':' +(epoch.livemode ? 'live': 'test'), canonical_created_at: input.canonical_created_at,
        seals: s.lifecycle.source_seals
      });
      const x = {
        ... immutable, admission: clone(immutable), charge_id: input.charge_id || null, spentMicros: 0, retiredMicros: 0, originalCostId: null,
        originalCostSettled: false, originalClaim: null, frozen: false, input_digest: fingerprint, sequence: next()
      };
      if(capacityRequired||repository.getCapacity('capacity:root'))x.capacityReservationId=capacityManager.attachSource(ctx,x).id;
      s.sources[x.id] = x;
      return clone(x);
    };
    ctx.attachFundingCharge =( {
      sourceId, charge_id, evidence_ref, verified
    }) => {
      check();
      const x = source(sourceId);
      if (! verified || ! evidence_ref || typeof charge_id !== 'string' || ! charge_id) throw fail('SOURCE_PROVENANCE_INVALID');
      if (x.charge_id && x.charge_id !== charge_id) throw fail('SOURCE_RECEIPT_CONFLICT');
      touch();
      x.charge_id = charge_id;
      x.charge_evidence_ref = evidence_ref;
      return clone(x);
    };
    ctx.recordCost = input => {
      check();
      const x = source(input.sourceId);
      integer(input.amountMicros);
      if (! input.id || !['original', 'incremental', 'source'].includes(input.kind) || input.provider !== 'stripe' || input.platform_account_id !== epoch.platform_account_id || input.livemode !== epoch.livemode || input.currency !== 'usd' || input.complete !== true || input.final !== true || ! input.evidence_ref) throw fail('COST_EVIDENCE_REQUIRED');
      const fingerprint = digest(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'observed_at'))), old = s.costs[input.id];
      if (old) {
        if (old.input_digest !== fingerprint) throw fail('COST_EVIDENCE_CONFLICT');
        return clone(old);
      }
      if (input.kind === 'original' && x.originalCostId && x.originalCostId !== input.id) throw fail('ORIGINAL_COST_ALREADY_RECORDED');
      const c = {
        ... clone(input), coveredMicros: 0, recoveredMicros: 0, reservedMicros: 0, input_digest: fingerprint, sequence: next()
      };
      s.costs[c.id] = c;
      if (c.kind === 'original') x.originalCostId = c.id;
      waterfall();
      return clone(c);
    };
    ctx.recordCostCorrection =( {
      id, costId, amountMicros, evidence_ref
    }) => {
      check();
      integer(amountMicros);
      const cost = s.costs[costId];
      if (! cost || ! id || ! evidence_ref) throw fail('COST_EVIDENCE_REQUIRED');
      const record = {
        id, costId, amountMicros, evidence_ref, type: 'cost_correction'
      };
      const old = s.provider_observations[id];
      if (old) {
        if (digest(old.record) !== digest(record)) throw fail('COST_EVIDENCE_CONFLICT');
        return clone(old);
      }
      const item = {
        record, sequence: next()
      };
      s.provider_observations[id] = item;
      s.exceptions['cost:' + id] = {
        id: 'cost:' + id, kind: 'COST_CORRECTION_RECONCILIATION_REQUIRED', sourceId: cost.sourceId, costId, originalMicros: cost.amountMicros,
        correctedMicros: amountMicros, evidence_ref
      };
      source(cost.sourceId).frozen = true;
      return clone(item);
    };
    ctx.prepareSpend =( {
      id, accountId, draws, participantDraws
    }) => {
      check();
      if (! id || ! accountId || ! Array.isArray(draws) || ! draws.length) throw fail('SPEND_RECEIPT_INVALID');
      if(!s.spends[id])currentFailureControl()?.assertNewEffectAllowed({action:'new_spend'});
      const root=repository.getCapacity('capacity:root'), requiresVector=root?.profile.grouped?.commitProtocol==='single_sql_v1';
      if(requiresVector&&!participantDraws)throw fail('PARTICIPANT_DRAW_VECTOR_REQUIRED');
      if(participantDraws)validateParticipantDraws({participantDraws,draws,accountId,getSource:id=>source(id,accountId),getProjection:id=>s.projections[id]});
      const intent = {
        id, accountId, draws: clone(draws),...(participantDraws?{participantDraws:clone(participantDraws),participantDrawsDigest:digest(participantDraws)}:{})
      }, hash = digest(intent);
      if(root&&Buffer.byteLength(JSON.stringify(intent))>root.profile.maxRowBytes)throw fail('CAPACITY_ENCODED_ROW_LIMIT');
      if (s.spends[id]) {
        if (s.spends[id].digest !== hash) throw fail('SPEND_RECEIPT_CONFLICT');
        return clone(s.spends[id]);
      }
      newAdmission();
      const totals = {
      };
      for (const d of draws) {
        integer(d.amountMicros);
        totals[d.sourceId] = sum([totals[d.sourceId] || 0, d.amountMicros]);
      }
      for (const[sid, amount] of Object.entries(totals)) {
        const x = source(sid, accountId);
        verifySource(x);
        if (x.frozen || principal(x) < amount) throw fail('INSUFFICIENT_PRINCIPAL');
      }
      const value = {
        ... intent, intent, digest: hash, state: 'prepared', sequence: next()
      };
      if(capacityRequired||repository.getCapacity('capacity:root'))value.capacityReservationId=capacityManager.reserveSpend(ctx,intent).id;
      s.spends[id] = value;
      return clone(value);
    };
    function preserveAppliedEffect({participant,owner,id,effectDigest,receipt}){const key=require('./money-control-store').appliedEffectId({epoch,participant,owner,id}),old=repository.getEvidence('applied_effects',key);if(old){if(old.payload.effect_digest!==effectDigest||digest(old.payload.receipt)!==digest(receipt))throw fail('APPLIED_EFFECT_CONFLICT');return old.payload;}const payload={epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,participant,owner,id,effect_digest:effectDigest,receipt:clone(receipt),acknowledged_revision:s.revision+1,retirement_generation:0};repository.recordEvidence({namespace:'applied_effects',id:key,payload,indexes:{accountId:owner,providerId:id,state:'acknowledged'}});return payload;}
    ctx.getAppliedEffect=({participant,owner,id})=>{check();return clone(repository.getEvidence('applied_effects',require('./money-control-store').appliedEffectId({epoch,participant,owner,id}))?.payload);};
    ctx.ackSpend =( {
      id, digest: hash, receipt
    }) => {
      check();
      const x = s.spends[id];
      if (! x || x.digest !== hash || receipt?.projection_id !== id || receipt?.digest !== hash) throw fail('SPEND_RECEIPT_CONFLICT');
      if (x.state !== 'prepared') return clone(x);
      touch();
      for (const d of x.draws) {
        const src = source(d.sourceId, x.accountId);
        src.spentMicros = sum([src.spentMicros, d.amountMicros]);
      }
      x.state = 'acknowledged';
      x.receipt = clone(receipt);
      preserveAppliedEffect({participant:"credits",owner:x.accountId,id:x.id,effectDigest:x.digest,receipt});
      return clone(x);
    };
    ctx.releaseSpend =( {
      id, receipt
    }) => {
      check();
      const x = s.spends[id];
      if (! x || receipt?.projection_id !== id + ':restore' || receipt?.digest !== x.digest) throw fail('SPEND_RECEIPT_CONFLICT');
      if (x.state === 'returned') return clone(x);
      if (x.state !== 'acknowledged') throw fail('SPEND_RECONCILIATION_REQUIRED');
      touch();
      for (const d of x.draws) source(d.sourceId, x.accountId).spentMicros -= d.amountMicros;
      x.state = 'returned';
      x.restoreReceipt = clone(receipt);
      preserveAppliedEffect({participant:"credits",owner:x.accountId,id:x.id+":restore",effectDigest:x.digest,receipt});
      return clone(x);
    };
    ctx.recordRealization = input => {
      check();
      if (! input.id || input.verified !== true || input.epoch_id !== epoch.epoch_id || input.binding_digest !== epoch.binding_digest || ! input.receipt_digest || ! Array.isArray(input.draws) || ! input.draws.length) throw fail('REALIZATION_PROVENANCE_INVALID');
      integer(input.platformShareMicros);
      integer(input.contributorShareMicros);
      const fingerprint = digest(input);
      if (s.pools[input.id]) {
        if (s.pools[input.id].input_digest !== fingerprint) throw fail('SOURCE_RECEIPT_CONFLICT');
        return clone(s.pools[input.id]);
      }
      const draws = input.draws.map(d =>( {
        ... d, amountMicros: integer(d.amountMicros)
      }));
      const total = sum(draws.map(d => d.amountMicros));
      if (sum([input.platformShareMicros, input.contributorShareMicros]) !== total) throw fail('REALIZATION_CONSERVATION_FAILED');
      const spend = input.spend_id ? s.spends[input.spend_id]: null;
      if (input.spend_id &&(! spend || spend.state !== 'acknowledged' || spend.accountId !== input.buyerId || digest(spend.draws) !== digest(draws))) throw fail('SPEND_RECEIPT_CONFLICT');
      let realizationCapacity;
      if(capacityRequired||repository.getCapacity('capacity:root')){
        if(spend){realizationCapacity=repository.getCapacity(spend.capacityReservationId);if(!realizationCapacity||realizationCapacity.spendId!==spend.id||realizationCapacity.accountId!==input.buyerId)throw fail('CAPACITY_SPEND_RESERVATION_REQUIRED');}
        else realizationCapacity=capacityManager.reserveSpend(ctx,{id:'realization:'+input.id,accountId:input.buyerId,draws});
        if(realizationCapacity.realizationId&&realizationCapacity.realizationId!==input.id)throw fail('CAPACITY_RESERVATION_CONFLICT');
      }
      let allocated = 0;
      const fragments =[];
      for (let i = 0; i < draws.length; i++) {
        const d = draws[i];
        if (d.kind === 'promo') throw fail('PROMO_NOT_MARGIN');
        const src = source(d.sourceId, input.buyerId);
        if (src.frozen ||(! spend && principal(src) < d.amountMicros)) throw fail('INSUFFICIENT_PRINCIPAL');
        const part = i === draws.length - 1 ? input.platformShareMicros - allocated: Number(BigInt(input.platformShareMicros) * BigInt(d.amountMicros) / BigInt(total));
        allocated += part;
        if (! spend) src.spentMicros = sum([src.spentMicros, d.amountMicros]);
        fragments.push( {
          sourceId: d.sourceId, paidMicros: d.amountMicros, platformShareMicros: part, coveredMicros: 0, remainingMicros: part,
          waitingMicros: part
        });
      }
      if (input.otherCosts &&(! input.otherCosts.evidence_ref || ! Array.isArray(input.otherCosts.costIds))) throw fail('SOURCE_COST_EVIDENCE_REQUIRED');
      const p = {
        id: input.id, buyerId: input.buyerId, contributorId: input.contributorId || null, learning_id: input.learning_id || null,
        otherCosts: clone(input.otherCosts || {
          complete: false, costIds: []
        }), platformShareMicros: input.platformShareMicros, contributorShareMicros: input.contributorShareMicros, parties: [... new Set([input.buyerId,
        input.contributorId].filter(Boolean))], fragments, sequence: next(), coveredMicros: 0, waitingMicros: input.platformShareMicros,
        availableMicros: 0, exposureMicros: 0, reversedMicros: 0, recoveredMicros: 0, reversals: {
        }, recoveries: {
        }, receipt_digest: input.receipt_digest, input_digest: fingerprint
      };
      if(realizationCapacity){realizationCapacity.realizationId=p.id;ctx._capacitySet(realizationCapacity);p.capacityReservationId=realizationCapacity.id;}
      s.pools[p.id] = p;
      if (spend) {
        spend.state = 'realized';
        spend.realizationId = p.id;
      }
      waterfall();
      return clone(p);
    };
    ctx.completeRealizationCosts =( {
      poolId, costIds, evidence_ref
    }) => {
      check();
      const p = s.pools[poolId];
      if (! p || ! evidence_ref || ! Array.isArray(costIds)) throw fail('SOURCE_COST_EVIDENCE_REQUIRED');
      const proof = {
        complete: true, costIds: [... new Set(costIds)].sort(), evidence_ref
      };
      if (p.otherCosts.complete && digest(p.otherCosts) !== digest(proof)) throw fail('SOURCE_COST_EVIDENCE_CONFLICT');
      touch();
      p.otherCosts = proof;
      waterfall();
      return clone(p);
    };
    ctx.availablePrincipal =( {
      sourceId, accountId
    }) => {
      check();
      return principal(source(sourceId, accountId));
    };
    ctx.availablePool =( {
      accountId
    }) => {
      check();
      return sum(repository.relatedPools({accountId}).map(p => p.availableMicros));
    };
    function quoteEconomics( {
      accountId, sourceId, maxGrossMicros, costEvidenceId, incrementalCostEvidenceId, incrementalCostMicros, railMinimumMicros = 10000
    }) {
      const x = source(sourceId, accountId);
      verifySource(x);
      if (x.frozen) throw fail('SOURCE_RESTRICTED');
      if (! x.charge_id) throw fail('CHARGE_EVIDENCE_REQUIRED');
      if (x.originalClaim) throw fail('ORIGINAL_COST_RESERVED');
      const orig = s.costs[x.originalCostId], extra = s.costs[incrementalCostEvidenceId];
      if (extra?.valid_until !== undefined && clock() >= extra.valid_until) throw fail('COST_EVIDENCE_EXPIRED');
      if (! orig || orig.id !== costEvidenceId || ! extra || extra.kind !== 'incremental' || extra.sourceId !== x.id || extra.amountMicros !== incrementalCostMicros) throw fail('COST_EVIDENCE_REQUIRED');
      integer(maxGrossMicros);
      if (! maxGrossMicros || maxGrossMicros > principal(x)) throw fail('INSUFFICIENT_PRINCIPAL');
      const originalOutstandingMicros = x.originalCostSettled ? 0: orig.amountMicros - orig.coveredMicros - orig.recoveredMicros - orig.reservedMicros;
      const needed = sum([originalOutstandingMicros, extra.amountMicros]);
      let remaining = needed;
      const coverageAllocations =[];
      for (const p of repository.relatedPools({accountId}).filter(p=>p.availableMicros>0).sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))) {
        const take = Math.min(remaining, p.availableMicros);
        if (take) coverageAllocations.push( {
          poolId: p.id, amountMicros: take
        });
        remaining -= take;
        if (! remaining) break;
      }
      return {
        accountId, sourceId, rail: 'stripe_card', type: 'buyer_return', ... returnFigures(maxGrossMicros, remaining, 10000, railMinimumMicros),
        originalOutstandingMicros, incrementalCostMicros: extra.amountMicros, coverageMicros: needed - remaining, coverageAllocations,
        costEvidenceId: orig.id, incrementalCostEvidenceId: extra.id, originalEvidenceDigest: orig.input_digest, incrementalEvidenceDigest: extra.input_digest,
        policyDigest: digest(x.policy), sourceDigest: x.input_digest, railMinimumMicros
      };
    }
    ctx.quoteReturn = input => {
      check();
      newAdmission();
      const economics = quoteEconomics(input), now = clock();
      const quoteProfile=repository.getCapacity('capacity:root')?.profile;
      repository.expireQuotes(now,{limit:quoteProfile?.workspace?.schema===2?quoteProfile.workspace.maxQuoteChangesPerCommit-1:undefined});
      const q = {
        ... economics, id: 'quote_' + crypto.randomUUID(), createdAt: now, expiresAt: now + 300000, revision: s.revision, economicsDigest: digest(economics)
      };
      q.hash = digest(q);
      s.quotes[q.id] = q;
      next();
      return clone(q);
    };
    function localLiabilities() {
      return repository.totals().localLiabilityMicros;
    }
    ctx.recordLiquidity = input => {
      check();
      if (strictLiquidityRevision && ! Number.isSafeInteger(input.journal_revision)) throw fail('LIQUIDITY_JOURNAL_GENERATION_REQUIRED');
      if (input.journal_revision !== undefined && input.journal_revision !== s.revision) throw fail('LIQUIDITY_JOURNAL_GENERATION_CHANGED');
      if (! input.id || ! Number.isSafeInteger(input.revision) || input.revision < 0 || input.platform_account_id !== epoch.platform_account_id || input.livemode !== epoch.livemode || input.currency !== 'usd' || input.complete !== true || input.canonical !== true || ! input.cutoff || ! input.digest || (!Array.isArray(input.reflectedEffectIds)&&!input.provider_inventory_ref) || input.capitalApproved !== true || ! Number.isSafeInteger(input.observed_at)) throw fail('LIQUIDITY_EVIDENCE_REQUIRED');
      for (const k of['availableMicros', 'protectedLiabilityMicros', 'restrictedCashMicros', 'exposureLimitMicros']) integer(input[k]);
      if (input.reflectedEffectIds && new Set(input.reflectedEffectIds).size !== input.reflectedEffectIds.length) throw fail('LIQUIDITY_EVIDENCE_REQUIRED');
      if(repository.cashReflectionGeneration()>(input.provider_inventory_ref?.generation||0))throw fail('CASH_CUT_OLDER_THAN_REFLECTION');
      const latest = repository.latest('liquidity_evidence');
      if (latest && input.revision <= latest.revision) {
        if (latest.input_digest === digest(input)) return clone(latest);
        throw fail('LIQUIDITY_GENERATION_CONFLICT');
      }
      if (input.protectedLiabilityMicros < localLiabilities()) throw fail('LIQUIDITY_LIABILITY_OMISSION');
      const value = {
        ... clone(input), input_digest: digest(input), localLiabilityMicros: localLiabilities(), sequence: next()
      };
      s.liquidity_evidence[input.id] = value;
      return clone(value);
    };
    function effectReflected(b,id,o){if(b.provider_inventory_ref){const ref=b.provider_inventory_ref;const e=repository.getEvidence('provider_effects',ref.scopeKey+':'+ref.generation+':'+id)?.payload;return !!(e&&e.id===id&&e.status==='available'&&e.canonical===true&&e.verified===true&&e.complete===true&&e.platform_account_id===epoch.platform_account_id&&e.livemode===epoch.livemode&&e.currency==='usd'&&(!o||(e.operationId===o.id&&e.obligationVersion===require('./money-database').cashVersion(o))));}return b.reflectedEffectIds?.includes(id)||false;}
    ctx.acknowledgeReflectedEffects=({inventory_ref,balanceCutDigest,effects})=>{
      check();if(!inventory_ref||!Array.isArray(effects)||effects.length>100)throw fail('CASH_REFLECTION_PROOF_REQUIRED');
      const{scopeKey,generation}=inventory_ref,expectedScope='stripe:'+epoch.platform_account_id+':'+(epoch.livemode?'live':'test');
      const control=repository.getEvidence('provider_inventory',scopeKey+':control')?.payload,seal=repository.getEvidence('provider_effects',scopeKey+':'+generation+':seal')?.payload;
      const stamp=v=>v&&['epoch_id','binding_digest','platform_account_id','livemode'].every(k=>v[k]===epoch[k]);
      if(scopeKey!==expectedScope||!Number.isSafeInteger(generation)||generation<1||!stamp(control)||!stamp(seal)||control.state!=='complete'||control.generation!==generation||control.balanceDigest!==balanceCutDigest||!seal.complete||seal.balanceDigest!==balanceCutDigest||seal.scopeKey!==scopeKey||seal.generation!==generation||!seal.cutDigest||seal.cutDigest!==control.cutDigest||!Number.isSafeInteger(control.completedAt)||clock()<control.completedAt||clock()-control.completedAt>30000)throw fail('CASH_REFLECTION_PROOF_REQUIRED');
      const result=[];for(const item of effects){const o=operation(item.operationId),version=require('./money-database').cashVersion(o),ids=require('./money-database').cashEffectIds(o);if(version!==item.obligationVersion||!ids.length||new Set(ids).size!==ids.length||o.cashReservedMicros<=0)throw fail('CASH_OBLIGATION_VERSION_CHANGED');const facts={};let netMicros=0n;
        for(const id of ids){const proof=repository.getEvidence('provider_effects',scopeKey+':'+generation+':'+id)?.payload;if(!stamp(proof)||proof.operationId!==o.id||proof.obligationVersion!==version||proof.id!==id||proof.source!==o.refund_id||proof.status!=='available'||proof.currency!==o.currency||proof.generation!==generation||proof.canonical!==true||proof.verified!==true||proof.complete!==true||!proof.factId||!Number.isSafeInteger(proof.net)||!Number.isSafeInteger(proof.amount)||!Number.isSafeInteger(proof.fee)||proof.net!==proof.amount-proof.fee)throw fail('CASH_REFLECTION_PROOF_REQUIRED');const current=repository.getProviderCurrentFact(scopeKey,id),fact=repository.getEvidence('provider_effects',proof.factId)?.payload;if(!current||current.factId!==proof.factId||!fact||['id','source','currency','amount','fee','net','status'].some(k=>fact[k]!==proof[k]))throw fail('CASH_REFLECTION_FACT_CHANGED');netMicros+=BigInt(proof.net)*10000n;facts[id]=proof.factId;}
        if(-netMicros!==BigInt(o.cashReservedMicros))throw fail('CASH_REFLECTION_AMOUNT_CHANGED');
        const payload={epoch_id:epoch.epoch_id,binding_digest:epoch.binding_digest,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,currency:o.currency,operationId:o.id,sourceId:o.sourceId,accountId:o.accountId,obligationVersion:version,cashReservedMicros:o.cashReservedMicros,effectIds:ids,facts,scopeKey,generation,balanceCutDigest,cutDigest:seal.cutDigest,previousCutDigest:seal.previousCutDigest||null};const id=digest(payload);repository.recordEvidence({namespace:'cash_reflections',id,payload,indexes:{accountId:o.accountId,providerId:o.id,state:'acknowledged'}});touch();o.cashReflectionVersion=version;o.cashReflectionProofId=id;o.cashReflectionFacts=facts;repository.advanceCashReflectionGeneration(generation);result.push({operationId:o.id,proofId:id});
      }return result;
    };

    function liquidity(figures, excludeId) {
      const b = repository.latest('liquidity_evidence');
      if (! b) throw fail('LIQUIDITY_EVIDENCE_REQUIRED');
      if(repository.cashReflectionGeneration()>(b.provider_inventory_ref?.generation||0))throw fail('CASH_CUT_OLDER_THAN_REFLECTION');
      const age = clock() - b.observed_at;
      if (age < 0 || age > 30000) throw fail('LIQUIDITY_EVIDENCE_STALE');
      const existing = repository.cashObligations().filter(o => o.id !== excludeId &&(!['failed', 'canceled', 'requote_required'].includes(o.state) || o.failedCostMicros >(o.failedCostReversedMicros || 0)));
      let U = 0, H = 0;
      for (const o of existing) {
        const reflected = o.cashEffectIds?.length ? o.cashEffectIds.every(id => effectReflected(b,id,o)): o.cashEffectId && effectReflected(b,o.cashEffectId,o);
        if (! reflected && o.cashReflectionVersion!==require('./money-database').cashVersion(o)) U = sum([U, o.cashReservedMicros]);
        if (! TERMINAL.has(o.state) && ! o.principalRetired) H = sum([H, o.D]);
      }
      const L = b.protectedLiabilityMicros + localLiabilities() - b.localLiabilityMicros;
      if (! Number.isSafeInteger(L) || L < 0) throw fail('LIQUIDITY_LIABILITY_OMISSION');
      const R = sum([figures.N, figures.incrementalCostMicros]);
      repository.refreshOriginalExposure();
      const exposure=repository.totals().exposureMicros;
      if (exposure > b.exposureLimitMicros) throw fail('EXPOSURE_LIMIT_EXCEEDED');
      if (sum([H, figures.D]) > L || b.availableMicros < sum([U, R]) || b.availableMicros - U - R < sum([Math.max(L - H - figures.D,
      0), b.restrictedCashMicros])) throw fail('INSUFFICIENT_LIQUIDITY');
      return {
        cashReservedMicros: R, liquidityObservationId: b.id, liquidityRevision: b.revision, liabilityReservedMicros: figures.D,
        exposureAtReservationMicros: exposure
      };
    }
    ctx.reserveReturn =( {
      accountId, quoteId, quoteHash, clientRequestKey, operationId
    }) => {
      check();
      if (! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientRequestKey || '')) throw fail('INVALID_REQUEST_KEY');
      const existing = repository.rows('operations',{owner:accountId,requestKey:clientRequestKey,limit:1})[0];
      if (existing) {
        if (existing.quoteId !== quoteId || existing.quoteHash !== quoteHash) throw fail('REQUEST_KEY_CONFLICT');
        return clone(existing);
      }
      newAdmission();
      const q = s.quotes[quoteId];
      if (! q || q.accountId !== accountId || q.hash !== quoteHash) throw fail('QUOTE_NOT_FOUND');
      if (clock() >= q.expiresAt) throw fail('REQUOTE_REQUIRED');
      let current;
      try {
        current = quoteEconomics( {
          ... q, maxGrossMicros: q.G
        });
      } catch (e) {
        if (['INSUFFICIENT_PRINCIPAL', 'ORIGINAL_COST_RESERVED'].includes(e.code)) throw fail('REQUOTE_REQUIRED');
        throw e;
      }
      if (digest(current) !== q.economicsDigest) throw fail('REQUOTE_REQUIRED');
      const envelope = liquidity(q);
      const id = operationId || 'return_' + crypto.randomUUID();
      if (s.operations[id]) throw fail('OPERATION_ID_CONFLICT');
      const op = {
        ... clone(current), ... envelope, epoch_id: epoch.epoch_id, binding_digest: epoch.binding_digest, platform: epoch.platform,
        platform_account_id: epoch.platform_account_id, livemode: epoch.livemode, currency: 'usd', id, quoteId, quoteHash, clientRequestKey, acceptedQuote:clone(q),
        state: 'reserved', sequence: next(), createdAt: clock(), projectionIds: [], allocationIds: [], providerObservations: [],
        cashEffectId: null
      };
      s.operations[id] = op;
      delete s.quotes[q.id];
      for (const a of q.coverageAllocations) {
        const aid = id + ':pool:' + a.poolId;
        s.allocations[aid] = {
          id: aid, poolId: a.poolId, operationId: id, amountMicros: a.amountMicros, state: 'reserved'
        };
        op.allocationIds.push(aid);
        poolRecompute(s.pools[a.poolId]);
      }
      const src = source(op.sourceId), cost = s.costs[src.originalCostId];
      if (op.originalOutstandingMicros) {
        src.originalClaim = id;
        cost.reservedMicros = sum([cost.reservedMicros, op.originalOutstandingMicros]);
      }
      return clone(op);
    };
    ctx.markDispatch =( {
      operationId, payload, idempotencyKey, payloadDigest, requestDigest
    }) => {
      check();
      const o = operation(operationId);
      if (o.state !== 'reserved') throw fail('ALREADY_DISPATCHED');
      const pd = digest(payload);
      if (! idempotencyKey ||(payloadDigest && payloadDigest !== pd)) throw fail('PROVIDER_PAYLOAD_CONFLICT');
      const envelope = liquidity(o, o.id);
      touch();
      Object.assign(o, envelope, {
        state: 'dispatch_intent', provider_payload: clone(payload), provider_payload_digest: pd, provider_request_digest: requestDigest || pd,
        idempotency_key: idempotencyKey, dispatchAt: clock()
      });
      return clone(o);
    };
    ctx.assertDispatchAuthority =( {
      operationId
    }) => {
      check();
      const o = operation(operationId), src = source(o.sourceId, o.accountId);
      if (o.state !== 'dispatch_intent') throw fail('DISPATCH_AUTHORITY_CHANGED');
      verifySource(src);
      if (src.frozen) throw fail('SOURCE_RESTRICTED');
      const original = s.costs[o.costEvidenceId], incremental = s.costs[o.incrementalCostEvidenceId];
      if (! original || ! incremental || original.input_digest !== o.originalEvidenceDigest || incremental.input_digest !== o.incrementalEvidenceDigest ||(incremental.valid_until !== undefined && clock() >= incremental.valid_until)) throw fail('COST_EVIDENCE_CHANGED');
      if (o.allocationIds.some(id => s.allocations[id]?.state !== 'reserved')) throw fail('DISPATCH_AUTHORITY_CHANGED');
      const envelope = liquidity(o, o.id);
      touch();
      Object.assign(o, envelope, {
        dispatchValidatedAt: clock()
      });
      return clone(o);
    };
    ctx.recordProjection = input => {
      check();
      const o = operation(input.operationId);
      const intent = {
        id: input.id, operationId: input.operationId, participant: input.participant, owner: input.owner, sourceId: input.sourceId,
        effect: input.effect, amountMicros: integer(input.amountMicros), ...(input.payload ? {
          payload: clone(input.payload)
        }: {
        })
      };
      if (! input.id || ! input.participant ||(input.owner !== o.accountId && !(o.type === 'external_refund' && input.effect === 'reverse_funded_share' && o.fundedShareReversals.some(x => x.contributorId === input.owner))) || input.sourceId !== o.sourceId) throw fail('PROJECTION_CONFLICT');
      const hash = digest(intent), old = s.projections[input.id];
      if (old) {
        if (old.digest !== hash) throw fail('PROJECTION_CONFLICT');
        return clone(old);
      }
      touch();
      const p = {
        ... intent, intent, digest: hash, state: 'pending'
      };
      s.projections[p.id] = p;
      o.projectionIds.push(p.id);
      return clone(p);
    };
    function settle(o) {
      if (o.state === 'failed_projection_pending') {
        const p = s.projections[o.id + ':restore'];
        if (p?.state === 'acknowledged') {
          if (o.principalRetired && p.receipt.applied !== true) throw fail('FAILED_RETURN_RECONCILIATION_REQUIRED');
          completeFailure(o);
        }
        return;
      }
      if (o.state !== 'succeeded_projection_pending' || ! o.projectionIds.length || o.projectionIds.some(id => s.projections[id].state !== 'acknowledged')) return;
      const x = source(o.sourceId), cost = s.costs[x.originalCostId];
      if (o.type === 'external_refund' || o.type === 'source_dispute') {
        x.retiredMicros = sum([x.retiredMicros, o.D]);
        if (o.type === 'external_refund') for (const v of o.fundedShareReversals) {
          const p = s.pools[v.poolId];
          p.contributorReversedMicros = sum([p.contributorReversedMicros || 0, v.contributorShareMicros]);
        }
        o.state = 'settled';
        o.settledAt = clock();
        return;
      }
      x.retiredMicros = sum([x.retiredMicros, o.D]);
      o.principalRetired = true;
      if (o.originalOutstandingMicros) {
        cost.reservedMicros -= o.originalOutstandingMicros;
        const coverage = Math.min(o.coverageMicros, o.originalOutstandingMicros);
        cost.coveredMicros = sum([cost.coveredMicros, coverage]);
        cost.recoveredMicros = sum([cost.recoveredMicros, o.originalOutstandingMicros - coverage]);
        x.originalClaim = null;
      }
      x.originalCostSettled = true;
      for (const id of o.allocationIds) s.allocations[id].state = 'settled';
      o.state = 'settled';
      o.settledAt = clock();
      waterfall();
    }
    ctx.ackProjection =( {
      id, digest: hash, receipt
    }) => {
      check();
      const p = s.projections[id];
      if (! p || p.state === 'superseded' || p.digest !== hash || receipt?.projection_id !== id || receipt?.digest !== hash) throw fail('PROJECTION_CONFLICT');
      touch();
      p.state = 'acknowledged';
      p.receipt = clone(receipt);
      preserveAppliedEffect({participant:p.participant,owner:p.owner,id:p.id,effectDigest:p.digest,receipt});
      settle(operation(p.operationId));
      return clone(p);
    };
    function release(o, state) {
      const x = source(o.sourceId), cost = s.costs[x.originalCostId];
      if (x.originalClaim === o.id) {
        cost.reservedMicros -= o.originalOutstandingMicros;
        x.originalClaim = null;
      }
      for (const id of o.allocationIds) s.allocations[id].state = 'canceled';
      o.state = state;
      waterfall();
    }
    function completeFailure(o) {
      const x = source(o.sourceId), original = s.costs[x.originalCostId];
      if (o.principalRetired) {
        x.retiredMicros -= o.D;
        const subsidy = Math.min(o.coverageMicros, o.originalOutstandingMicros);
        original.coveredMicros -= subsidy;
        original.recoveredMicros -= o.originalOutstandingMicros - subsidy;
        o.principalRetired = false;
      }
      if (x.originalClaim === o.id) {
        original.reservedMicros -= o.originalOutstandingMicros;
        x.originalClaim = null;
      }
      x.originalCostSettled = original.coveredMicros + original.recoveredMicros >= original.amountMicros;
      for (const id of o.allocationIds) s.allocations[id].state = 'canceled';
      for (const p of repository.affectedPools()) poolRecompute(p);
      // Reopened original fees can use only still-backed, uncommitted source share.
      if (! x.originalCostSettled) for (const p of repository.relatedPools({sourceId:x.id})) {
        let free = Math.max(p.platformShareMicros - p.reversedMicros + p.recoveredMicros - p.coveredMicros - sum(repository.rows('allocations',{poolId:p.id}).filter(a => a.poolId === p.id && a.state !== 'canceled').map(a => a.amountMicros)),
        0);
        for (const fragment of p.fragments.filter(f => f.sourceId === x.id)) {
          const available = Math.min(free, fragment.platformShareMicros - fragment.coveredMicros);
          fragment.remainingMicros = Math.max(fragment.remainingMicros, available);
          free -= available;
        }
      }
      waterfall();
      let remaining = o.failure.incurredCostMicros;
      o.failedCostAllocationIds =[];
      for (const p of repository.relatedPools({accountId:o.accountId}).sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))) {
        const amount = Math.min(remaining, p.availableMicros);
        if (! amount) continue;
        const id = o.id + ':failed-cost:' + p.id;
        s.allocations[id] = {
          id, poolId: p.id, operationId: o.id, amountMicros: amount, state: 'settled', purpose: 'actual_failed_return_cost'
        };
        o.failedCostAllocationIds.push(id);
        o.allocationIds.push(id);
        remaining -= amount;
        poolRecompute(p);
        if (! remaining) break;
      }
      o.failedCostMicros = o.failure.incurredCostMicros;
      o.failedCostCoverageMicros = o.failedCostMicros - remaining;
      o.failedCostExposureMicros = remaining;
      o.failedCostReversedMicros = 0;
      o.failureCustomerCostMicros = 0;
      o.cashReservedMicros = o.failedCostMicros;
      o.cashEffectIds =[o.failure.observation.balance_transaction_id, o.failure.observation.failure_balance_transaction_id].filter(Boolean);
      if (remaining) s.exceptions[o.id + ':failure-cost'] = {
        id: o.id + ':failure-cost', kind: 'PLATFORM_FAILED_RETURN_COST_EXPOSURE', operationId: o.id, amountMicros: remaining
      };
      for (const e of repository.rows('exceptions',{operationId:o.id})) if (e.operationId === o.id && e.kind === 'FAILED_RETURN_RECONCILIATION_REQUIRED') e.state = 'resolved';
      o.state = o.failure.state;
      o.failureCompletedAt = clock();
    }
    ctx.reverseFailedCost =( {
      operationId, reversalId, amountMicros, observation
    }) => {
      check();
      const o = operation(operationId);
      integer(amountMicros);
      if (!['failed', 'canceled'].includes(o.state) || ! reversalId || observation?.canonical !== true || observation.verified !== true || observation.complete !== true || observation.feeRefundMicros !== amountMicros || ! observation.evidence_ref) throw fail('FAILED_COST_REVERSAL_EVIDENCE_REQUIRED');
      const id = 'failed-cost-reversal:' + reversalId, record = {
        operationId, amountMicros, observation: clone(observation)
      };
      if (s.provider_observations[id]) {
        if (s.provider_observations[id].digest !== digest(record)) throw fail('PROVIDER_OBSERVATION_CONFLICT');
        return clone(o);
      }
      if (amountMicros > o.failedCostMicros - o.failedCostReversedMicros) throw fail('FAILED_COST_REVERSAL_EXCEEDS_COST');
      touch();
      s.provider_observations[id] = {
        id, digest: digest(record), record, sequence: next()
      };
      const cured = Math.min(amountMicros, o.failedCostExposureMicros);
      o.failedCostExposureMicros -= cured;
      let remainder = amountMicros - cured;
      for (const aid of[... o.failedCostAllocationIds].reverse()) {
        if (! remainder) break;
        const a = s.allocations[aid];
        if (a.state === 'canceled') continue;
        const returned = Math.min(remainder, a.amountMicros);
        a.state = 'canceled';
        if (a.amountMicros > returned) {
          const residualId = aid + ':after:' + reversalId;
          s.allocations[residualId] = {
            ... a, id: residualId, amountMicros: a.amountMicros - returned, state: 'settled', supersedes: aid
          };
          o.failedCostAllocationIds.push(residualId);
          o.allocationIds.push(residualId);
        }
        remainder -= returned;
        poolRecompute(s.pools[a.poolId]);
      }
      if (remainder) throw fail('FAILED_COST_REVERSAL_CONSERVATION');
      o.failedCostReversedMicros = sum([o.failedCostReversedMicros, amountMicros]);
      o.failedCostCoverageMicros -= amountMicros - cured;
      o.cashReservedMicros = o.failedCostMicros - o.failedCostReversedMicros;
      if (s.exceptions[o.id + ':failure-cost']) {
        s.exceptions[o.id + ':failure-cost'].amountMicros = o.failedCostExposureMicros;
        if (! o.failedCostExposureMicros) s.exceptions[o.id + ':failure-cost'].state = 'resolved';
      }
      return clone(o);
    };
    ctx.observeOperation =( {
      operationId, state, observation, confirmedFundsReturned = false, incurredCostMicros
    }) => {
      check();
      const o = operation(operationId);
      if (! observation?.canonical || ! observation.verified || ! observation.complete) throw fail('PROVIDER_OBSERVATION_REQUIRED');
      const oid = observation.id || digest(observation), record = {
        operationId, state, observation: clone(observation), confirmedFundsReturned, ...(incurredCostMicros !== undefined ? {
          incurredCostMicros
        }: {
        })
      };
      const old = s.provider_observations[oid];
      if (old) {
        if (old.digest !== digest(record)) throw fail('PROVIDER_OBSERVATION_CONFLICT');
        return clone(o);
      }
      if (observation.reason === 'RETURN_AMOUNT_MISMATCH') {
        integer(observation.observedRefundAmountMicros);
        integer(observation.expectedCashMicros);
        if (observation.expectedCashMicros !== o.N) throw fail('PROVIDER_IDENTITY_CONFLICT');
        touch();
        s.provider_observations[oid] = {
          id: oid, digest: digest(record), record, sequence: next()
        };
        o.providerObservations.push(oid);
        o.observation = clone(observation);
        s.exceptions['failed:' + oid] = {
          id: 'failed:' + oid, kind: 'FAILED_RETURN_RECONCILIATION_REQUIRED', operationId, sourceId: o.sourceId, observationId: oid,
          observedRefundAmountMicros: observation.observedRefundAmountMicros, expectedCashMicros: observation.expectedCashMicros
        };
        source(o.sourceId).frozen = true;
        if (! TERMINAL.has(o.state) && ! o.principalRetired && !['succeeded_projection_pending', 'failed_projection_pending'].includes(o.state)) o.state = 'submission_unknown';
        return clone(o);
      }
      if (['succeeded_projection_pending', 'settled', 'failed_projection_pending', 'failed', 'canceled'].includes(o.state) &&['submission_unknown',
      'external_pending', 'requires_action'].includes(state)) {
        return clone(o);
      }
      if (o.state === 'settled' &&['succeeded', 'succeeded_projection_pending'].includes(state) &&(! observation.refund_id || observation.refund_id === o.refund_id)) {
        return clone(o);
      }
      if (['failed', 'canceled'].includes(o.state) && state === o.state && observation.terminal === true && observation.cashPaidMicros === 0 && incurredCostMicros === o.failedCostMicros) return clone(o);
      if (['settled', 'failed', 'canceled', 'requote_required'].includes(o.state) && !(o.state === 'settled' &&['failed', 'canceled'].includes(state) && confirmedFundsReturned && observation.terminal === true && observation.cashPaidMicros === 0 && Number.isSafeInteger(incurredCostMicros))) {
        touch();
        s.provider_observations[oid] = {
          id: oid, digest: digest(record), record, sequence: next()
        };
        s.exceptions['correction:' + oid] = {
          id: 'correction:' + oid, kind: 'TERMINAL_PROVIDER_CORRECTION', operationId, observationId: oid
        };
        source(o.sourceId).frozen = true;
        return clone(o);
      }
      touch();
      s.provider_observations[oid] = {
        id: oid, digest: digest(record), record, sequence: next()
      };
      o.providerObservations.push(oid);
      o.observation = clone(observation);
      if (observation.refund_id) {
        if (o.refund_id && o.refund_id !== observation.refund_id) throw fail('PROVIDER_IDENTITY_CONFLICT');
        o.refund_id = observation.refund_id;
      }
      if (observation.balance_effect_id) {
        if (o.cashEffectId && o.cashEffectId !== observation.balance_effect_id) throw fail('PROVIDER_IDENTITY_CONFLICT');
        o.cashEffectId = observation.balance_effect_id;
      }
      if (['external_pending', 'submission_unknown', 'requires_action'].includes(state)) {
        if (o.state === 'reserved') throw fail('DISPATCH_INTENT_REQUIRED');
        o.state = state;
        return clone(o);
      }
      if (state === 'succeeded_projection_pending' || state === 'succeeded') {
        if (o.state === 'failed_projection_pending') return clone(o);
        if (o.state === 'reserved') throw fail('DISPATCH_INTENT_REQUIRED');
        o.state = 'succeeded_projection_pending';
        ctx.recordProjection( {
          id: o.id + ':principal', operationId: o.id, participant: 'credits', owner: o.accountId, sourceId: o.sourceId, effect: 'retire_principal',
          amountMicros: o.D, payload: {
            lot_id: source(o.sourceId).provenance.lot_id, cashMicros: o.N, customerCostMicros: o.C, retainedMicros: o.r
          }
        });
        return clone(o);
      }
      if (state === 'failed' || state === 'canceled') {
        if (! confirmedFundsReturned || incurredCostMicros === undefined || observation.terminal !== true || observation.cashPaidMicros !== 0) {
          s.exceptions['failed:' + oid] = {
            id: 'failed:' + oid, kind: 'FAILED_RETURN_RECONCILIATION_REQUIRED', operationId, sourceId: o.sourceId
          };
          o.state = 'external_pending';
          return clone(o);
        }
        integer(incurredCostMicros);
        o.failure = {
          state, observation: clone(observation), observationId: oid, incurredCostMicros
        };
        const original = s.projections[o.id + ':principal'];
        if (original) {
          original.state = 'superseded';
          original.supersededBy = o.id + ':restore';
          o.state = 'failed_projection_pending';
          ctx.recordProjection( {
            id: o.id + ':restore', operationId: o.id, participant: 'credits', owner: o.accountId, sourceId: o.sourceId, effect: 'restore_principal',
            amountMicros: o.D, payload: {
              lot_id: source(o.sourceId).provenance.lot_id, originalProjectionId: original.id, originalDigest: original.digest
            }
          });
        } else completeFailure(o);
        return clone(o);
      }
      throw fail('OPERATION_STATE_INVALID');
    };
    ctx.recordSourceObservation =( {
      sourceId, observation, freezeSource = false, freezeReason, refundId
    }) => {
      check();
      const x = source(sourceId);
      if (! observation || typeof observation !== 'object') throw fail('PROVIDER_OBSERVATION_REQUIRED');
      if (freezeSource && observation.canonical !== true) throw fail('PROVIDER_OBSERVATION_REQUIRED');
      const id = 'source-observation:' + digest( {
        sourceId, observation
      });
      if (! s.provider_observations[id]) s.provider_observations[id] = {
        id, record: {
          sourceId, observation: clone(observation)
        }, sequence: next()
      };
      touch();
      x.providerObservation = clone(observation);
      if (observation.cursor !== undefined) x.refund_scan_cursor = observation.cursor;
      if (observation.resolvedRefundIds) {
        if (observation.canonical !== true || observation.verified !== true || observation.complete !== true || ! Array.isArray(observation.resolvedRefundIds)) throw fail('PROVIDER_OBSERVATION_REQUIRED');
        for (const e of repository.rows('exceptions',{sourceId})) {
          if (e.sourceId === sourceId && e.kind === 'SOURCE_REFUND_PENDING' && observation.resolvedRefundIds.includes(e.refundId)) {
            e.state = 'resolved';
            e.resolutionObservationId = id;
          }
        }
        x.frozen = repository.rows('exceptions',{sourceId}).some(e => e.sourceId === sourceId && e.state !== 'resolved') || Object.values(x.disputes || {
        }).some(d => !['won', 'warning_closed'].includes(d.status));
      }
      if (freezeSource) {
        x.frozen = true;
        const pending = freezeReason === 'refund_pending' && refundId, exceptionId = pending ? 'source-refund:' + sourceId + ':' + refundId: id;
        s.exceptions[exceptionId] = {
          id: exceptionId, kind: pending ? 'SOURCE_REFUND_PENDING': 'SOURCE_PROVIDER_RECONCILIATION_REQUIRED', sourceId, ...(pending ? {
            refundId
          }: {
          }), state: 'unresolved'
        };
      }
      return clone(x);
    };
    ctx.recordSourceDispute =( {
      sourceId, providerObservation
    }) => {
      check();
      const x = source(sourceId), v = providerObservation;
      if (v?.canonical !== true || v.verified !== true || v.complete !== true || ! v.dispute_id || v.platform_account_id !== epoch.platform_account_id || v.livemode !== epoch.livemode || v.currency !== 'usd' || ! v.evidence_ref) throw fail('DISPUTE_EVIDENCE_REQUIRED');
      integer(v.cashMicros);
      if (!['warning_needs_response', 'warning_under_review', 'warning_closed', 'needs_response', 'under_review', 'won', 'lost'].includes(v.status)) throw fail('DISPUTE_EVIDENCE_REQUIRED');
      const prior = x.disputes?.[v.dispute_id];
      if (prior?.status === v.status) {
        const op = repository.rows('operations',{sourceId}).find(o => o.dispute_id === v.dispute_id && o.dispute_status === v.status);
        if (op) return clone(op);
      }
      if (prior &&['won', 'lost', 'warning_closed'].includes(prior.status) && prior.status !== v.status) {
        ctx.recordSourceObservation( {
          sourceId, observation: v, freezeSource: true
        });
        return {
          state: 'reconciliation_required'
        };
      }
      touch();
      x.disputes = {
        ...(x.disputes || {
        }), [v.dispute_id]: clone(v)
      };
      if (v.status === 'lost') {
        const op = ctx.recordExternalRefund( {
          sourceId, refundId: 'dispute_' + v.dispute_id, cashMicros: v.cashMicros, providerObservation: {
            ... v, refund_id: 'dispute_' + v.dispute_id, charge_id: x.charge_id
          }
        });
        x.frozen = true;
        const stored = s.operations[op.id];
        stored.dispute_id = v.dispute_id;
        stored.dispute_status = 'lost';
        return clone(stored);
      }
      const closed =['won', 'warning_closed'].includes(v.status), open = Object.values(x.disputes).some(d => !['won', 'warning_closed'].includes(d.status));
      const otherRestriction = repository.rows('exceptions',{sourceId}).some(e => e.sourceId === sourceId && e.state !== 'resolved');
      x.frozen = ! closed || open || otherRestriction;
      const id = 'source-dispute:' + v.dispute_id + ':' + v.status;
      const o = {
        id, type: 'source_dispute', accountId: x.accountId, sourceId, epoch_id: epoch.epoch_id, binding_digest: epoch.binding_digest,
        platform: epoch.platform, platform_account_id: epoch.platform_account_id, livemode: epoch.livemode, currency: 'usd',
        clientRequestKey: 'provider:' + id, dispute_id: v.dispute_id, dispute_status: v.status, state: 'succeeded_projection_pending',
        G: 0, D: 0, N: 0, C: 0, r: 0, cashReservedMicros: 0, incrementalCostMicros: 0, originalOutstandingMicros: 0, coverageMicros: 0,
        allocationIds: [], projectionIds: [], providerObservations: [], sequence: next(), createdAt: clock()
      };
      s.operations[id] = o;
      ctx.recordSourceObservation( {
        sourceId, observation: v
      });
      ctx.recordProjection( {
        id: id + ':credits', operationId: id, participant: 'credits', owner: x.accountId, sourceId, effect: 'source_dispute_state',
        amountMicros: 0, payload: {
          lot_id: x.provenance.lot_id, frozen: x.frozen, disputeId: v.dispute_id, status: v.status
        }
      });
      return clone(o);
    };
    ctx.recordExternalRefund =( {
      sourceId, refundId, cashMicros, providerObservation
    }) => {
      check();
      const x = source(sourceId);
      integer(cashMicros);
      if (! cashMicros || cashMicros % 10000 || ! refundId || providerObservation?.canonical !== true || providerObservation.verified !== true || providerObservation.complete !== true || providerObservation.refund_id !== refundId || providerObservation.cashMicros !== cashMicros || providerObservation.platform_account_id !== epoch.platform_account_id || providerObservation.livemode !== epoch.livemode || providerObservation.currency !== 'usd' || providerObservation.charge_id !== x.charge_id) throw fail('EXTERNAL_REFUND_EVIDENCE_REQUIRED');
      const known = repository.rows('operations',{providerId:refundId,limit:1})[0];
      if (known) {
        if (known.type !== 'external_refund') throw fail('EXISTING_VOLUNTARY_OPERATION');
        if (known.N !== cashMicros || known.sourceId !== sourceId) throw fail('PROVIDER_OBSERVATION_CONFLICT');
        return clone(known);
      }
      const id = 'external_refund:' + refundId, remaining = x.amountMicros - x.spentMicros - x.retiredMicros;
      // Admission freezes do not erase a mandatory cash reversal. principal()
      // already excludes independently reserved or possibly submitted amounts.
      const D = Math.min(cashMicros, principal(x));
      let overlapMicros = Math.min(cashMicros - D, remaining - D), spent = cashMicros - D - overlapMicros;
      const fundedShareReversals =[];
      for (const p of repository.relatedPools({sourceId}).sort((a,b)=>b.sequence-a.sequence||a.id.localeCompare(b.id))) {
        for (const f of p.fragments.filter(f => f.sourceId === sourceId)) {
          if (! spent) break;
          const prior = f.externalReversedPaidMicros || 0, take = Math.min(spent, f.paidMicros - prior);
          if (! take) continue;
          const cumulative = Number(BigInt(f.platformShareMicros) * BigInt(prior + take) / BigInt(f.paidMicros)), before = Number(BigInt(f.platformShareMicros) * BigInt(prior) / BigInt(f.paidMicros));
          const platformShareMicros = cumulative - before;
          if (platformShareMicros > p.platformShareMicros - p.reversedMicros) {
            overlapMicros = sum([overlapMicros, take]);
            spent -= take;
            continue;
          }
          f.externalReversedPaidMicros = prior + take;
          fundedShareReversals.push( {
            id: id + ':' + p.id, poolId: p.id, paidMicros: take, platformShareMicros, contributorShareMicros: take - platformShareMicros,
            contributorId: p.contributorId, learning_id: p.learning_id, buyerId: x.accountId, lot_id: x.provenance.lot_id
          });
          ctx.reverseRealization( {
            poolId: p.id, id: id + ':' + sourceId, amountMicros: platformShareMicros, evidence_ref: providerObservation.evidence_ref || refundId
          });
          spent -= take;
        }
      }
      overlapMicros = sum([overlapMicros, spent]);
      const spentReversalMicros = sum(fundedShareReversals.map(v => v.paidMicros));
      const o = {
        id, type: 'external_refund', rail: 'stripe_card', accountId: x.accountId, sourceId, epoch_id: epoch.epoch_id, binding_digest: epoch.binding_digest,
        platform: epoch.platform, platform_account_id: epoch.platform_account_id, livemode: epoch.livemode, currency: 'usd',
        clientRequestKey: 'provider:' + refundId, refund_id: refundId, state: 'succeeded_projection_pending', G: cashMicros,
        D, N: cashMicros, C: 0, r: 0, spentReversalMicros, overlapMicros, fundedShareReversals, cashReservedMicros: cashMicros,
        cashEffectId: providerObservation.balance_effect_id || providerObservation.balance_transaction_id || null, incrementalCostMicros: 0,
        originalOutstandingMicros: 0, coverageMicros: 0, allocationIds: [], projectionIds: [], providerObservations: [], createdAt: clock(),
        sequence: next()
      };
      s.operations[id] = o;
      const oid = 'external:' + refundId;
      s.provider_observations[oid] = {
        id: oid, sourceId, operationId: id, record: clone(providerObservation), sequence: next()
      };
      o.providerObservations.push(oid);
      o.observation = clone(providerObservation);
      if (overlapMicros || fundedShareReversals.some(v => ! v.contributorId)) {
        x.frozen = true;
        s.exceptions[id] = {
          id, kind: 'EXTERNAL_REFUND_OVERLAP_RECONCILIATION_REQUIRED', sourceId, operationId: id, overlapMicros, unknownContributor: fundedShareReversals.some(v => ! v.contributorId)
        };
      }
      ctx.recordProjection( {
        id: id + ':principal', operationId: id, participant: 'credits', owner: x.accountId, sourceId, effect: 'external_refund_principal',
        amountMicros: D, payload: {
          lot_id: x.provenance.lot_id, cashMicros, refundId, overlapMicros, fundedShareReversals
        }
      });
      for (const reversal of fundedShareReversals) {
        if (! reversal.contributorId) continue;
        ctx.recordProjection( {
          id: reversal.id + ':earnings', operationId: id, participant: 'earnings', owner: reversal.contributorId, sourceId, effect: 'reverse_funded_share',
          amountMicros: reversal.contributorShareMicros, payload: reversal
        });
      }
      return clone(o);
    };
    ctx.noteSubmissionUnknown =( {
      operationId, observation
    }) => {
      check();
      const o = operation(operationId);
      if (o.state === 'reserved') throw fail('DISPATCH_INTENT_REQUIRED');
      if (TERMINAL.has(o.state) ||['succeeded_projection_pending', 'failed_projection_pending'].includes(o.state)) return clone(o);
      if (! observation || typeof observation !== 'object') throw fail('PROVIDER_OBSERVATION_REQUIRED');
      const record = {
        operationId, observation: clone(observation), type: 'transport_or_incomplete'
      }, id = 'unknown:' + digest(record);
      if (! s.provider_observations[id]) {
        s.provider_observations[id] = {
          id, record, sequence: next()
        };
        o.providerObservations.push(id);
      }
      touch();
      o.observation = clone(observation);
      o.state = 'submission_unknown';
      return clone(o);
    };
    function adjustPool( {
      poolId, id, amountMicros, evidence_ref
    }, recover) {
      check();
      const p = s.pools[poolId];
      integer(amountMicros);
      if (! p || ! id || ! evidence_ref) throw fail('REVERSAL_EVIDENCE_REQUIRED');
      const records = recover ? p.recoveries: p.reversals, record = {
        id, amountMicros, evidence_ref
      };
      if (records[id]) {
        if (digest(records[id]) !== digest(record)) throw fail('REVERSAL_CONFLICT');
        return clone(p);
      }
      const field = recover ? 'recoveredMicros': 'reversedMicros';
      const total = sum([p[field], amountMicros]);
      if (total >(recover ? p.reversedMicros: p.platformShareMicros)) throw fail('REVERSAL_CONSERVATION_FAILED');
      touch();
      records[id] = record;
      p[field] = total;
      poolRecompute(p);
      if (! recover) {
        const ops = repository.rows('operations',{state:'reserved'}).filter(o => o.state === 'reserved' && o.allocationIds.some(aid => s.allocations[aid].poolId === poolId)).sort((a,
        b) => b.sequence - a.sequence || a.id.localeCompare(b.id));
        for (const o of ops) {
          if (! p.exposureMicros) break;
          release(o, 'requote_required');
          poolRecompute(p);
        }
      }
      waterfall();
      return clone(p);
    }
    ctx.reverseRealization = input => adjustPool(input, false);
    ctx.recoverRealization = input => adjustPool(input, true);
    ctx.getSource =( {
      sourceId, accountId
    }) => {
      check();
      return clone(source(sourceId, accountId));
    };
    ctx.getOperation =( {
      operationId, accountId
    }) => {
      check();
      const o = operation(operationId);
      if (accountId && o.accountId !== accountId) throw fail('OPERATION_NOT_FOUND');
      return clone(o);
    };
    ctx.capacity =() => {
      check();
      const counts=repository.counts();return{sources:counts.sources,operations:counts.operations,warning:false,profileRequired:true};
    };
    ctx.snapshot=()=>{check();return clone(repository.exportSnapshot());};
    ctx.pendingProjections=({accountId}={})=>{check();return clone(repository.rows('projections',{owner:accountId,state:'pending'}));};
    ctx.listProviderCurrentFacts=o=>{check();return repository.listProviderCurrentFacts(o);};
    ctx.getProviderCurrentFact=(scope,id)=>{check();return repository.getProviderCurrentFact(scope,id);};
    ctx.getProviderScanMember=(scope,generation,id)=>{check();return repository.getProviderScanMember(scope,generation,id);};
    ctx.getProviderScan=scopeKey=>{check();return repository.getProviderScan(scopeKey);};
    ctx.listProviderScanMembers=o=>{check();return repository.listProviderScanMembers(o);};
    ctx.advanceProviderScan=input=>{touch();return repository.advanceProviderScan(input);};
    ctx.sealProviderScan=input=>{touch();return repository.sealProviderScan(input);};
    ctx.getEvidence=(n,id)=>{check();return repository.getEvidence(n,id);};
    ctx.listEvidence=o=>{check();return repository.listEvidence(o);};
    ctx.recordEvidence=input=>{touch();return repository.recordEvidence(input);};
    ctx.getQuote=id=>{check();return clone(s.quotes[id]);};
    ctx.getProjection=id=>{check();return clone(s.projections[id]);};
    ctx.getSpend=id=>{check();return clone(s.spends[id]);};
    ctx.getPool=id=>{check();return clone(s.pools[id]);};
    ctx.getSourceByLot=(accountId,lotId)=>{check();return clone(repository.rows('sources',{owner:accountId,lotId,limit:1})[0]);};
    ctx.sourceReturnBalances=id=>{check();const x=source(id),availableMicros=principal(x);return{availableMicros,heldMicros:x.amountMicros-x.spentMicros-x.retiredMicros-availableMicros};};
    ctx.listSpends=o=>{check();const limit=o?.limit||100;return require('./money-repository').rowPage(repository.rows('spends',{owner:o?.accountId,state:o?.state,after:o?.after,limit:limit+1}),limit);};

    ctx.recordException =( {
      id, kind, ... rest
    }) => {
      check();
      if (! id || ! kind) throw fail('EXCEPTION_INVALID');
      const record = {
        id, kind, ... clone(rest)
      };
      if (s.exceptions[id] && digest(s.exceptions[id]) !== digest(record)) throw fail('EXCEPTION_CONFLICT');
      touch();
      s.exceptions[id] = record;
      return clone(record);
    };
    return {
      ctx, dirty: () => dirty, clean: () => {
        dirty = false;
      }
    };
  }
  let pendingFailureInspection=null;
  async function inspectAfterFailure(error){
    if(failureControl&&(store.uncertain||poisoned||error.code==='MONEY_STORE_UNCERTAIN')){
      try{pendingFailureInspection=failureControl.inspectRecoveryCut();error.failureInspection=await pendingFailureInspection;}
      catch(inspectionError){error.failureInspectionError=inspectionError.code||'FAILURE_INSPECTION_FAILED';}
    }
    throw error;
  }
  async function withMoneyControl(options, fn) {
    if (typeof options === 'function') {
      fn = options;
      options = {
      };
    }
    options = options || {
    };
    if (poisoned) throw fail('MONEY_RUNTIME_UNCERTAIN');
    if (getActiveMoneyContext()) throw fail('MONEY_CONTEXT_REENTRY');
    if (options.epochRevision !== undefined && options.epochRevision !== epoch.activation_revision) throw fail('EPOCH_REVISION_CHANGED');
    return store.transaction(async(tx, s) => {
      writer.assertOwned();
      gate(options,{successorGate:true});
      let release;
      const m = makeContext(s, options, tx.repository, tx);
      m.ctx.flush =() => {
        assertMoneyContext();
        if (m.dirty()) {
          m.ctx.assertFinancialGate();
          s.revision++;
          store.commitRevision(tx, s.revision - 1, s);
          m.clean();
        }
        return s.revision;
      };
      liveContexts.add(m.ctx);
      try {
        return await active.run(m.ctx, async() => {
          if (acquireGuards) release = await acquireGuards( {
            ... options, accounts: [... new Set(options.accounts ||[])].sort(), wallets: [... new Set((options.wallets ||[]).map(x => x.toLowerCase()))].sort(),
            credits: [... new Set(options.credits ||[])].sort(), earnings: [... new Set(options.earnings ||[])].sort()
          });
          const value = await fn(m.ctx);
          if (m.dirty()) {
            m.ctx.assertFinancialGate();
            s.revision++;
            store.commitRevision(tx, s.revision - 1, s);
          }
          if(failureControl&&m.ctx.failureAnchor()){failureControl.resolveCompletedFailure();if(failureControl.status().state==='recovery_scan')failureControl.scanRecoveryPage({limit:100});}
          return clone(value);
        });
      } catch(error) {
        try { m.ctx.noteRecoveryFailure(error); } catch(controlError) { poisoned=controlError; error.failureControlError=controlError; }
        throw error;
      } finally {
        liveContexts.delete(m.ctx);
        if (release) await release();
      }
    }).catch(inspectAfterFailure);
  }
  function withMoneyBootControl(options, fn) {
    if(typeof options==='function'){fn=options;options={};}
    options=options||{};
    if (poisoned) throw fail('MONEY_RUNTIME_UNCERTAIN');
    if (getActiveMoneyContext()) throw fail('MONEY_CONTEXT_REENTRY');
    return store.transactionSync((tx, s) => {
      gate(options);
      const m = makeContext(s, {kind:'boot',...options},tx.repository,tx);
      m.ctx.flush =() => {
        assertMoneyContext();
        if (m.dirty()) {
          m.ctx.assertFinancialGate();
          s.revision++;
          store.commitRevision(tx, s.revision - 1, s);
          m.clean();
        }
        return s.revision;
      };
      liveContexts.add(m.ctx);
      try {
        return active.run(m.ctx, () => {
          const value = fn(m.ctx);
          if (value?.then) throw fail('ASYNC_BOOT_FORBIDDEN');
          if (m.dirty()) {
            m.ctx.assertFinancialGate();
            s.revision++;
            store.commitRevision(tx, s.revision - 1, s);
          }
          return value;
        });
      } catch(error) {
        try { m.ctx.noteRecoveryFailure(error); } catch(controlError) { poisoned=controlError; error.failureControlError=controlError; }
        throw error;
      } finally {
        liveContexts.delete(m.ctx);
      }
    });
  }
  function scanWithinContext(tx,s,options){
    const control=currentFailureControl();if(!control)throw fail('FAILURE_CONTROL_REQUIRED');
    const m=makeContext(s,{kind:'recovery_scan'},tx.repository,tx);
    liveContexts.add(m.ctx);
    try{return active.run(m.ctx,()=>control.scanRecoveryPage(options));}finally{liveContexts.delete(m.ctx);}
  }
  return {
    store, epoch, writer, recoveryAnchors, get pendingFailureInspection(){return pendingFailureInspection;}, get failureControl(){return currentFailureControl();},
    scanFailureRecoveryPageSync:options=>store.transactionSync((tx,s)=>scanWithinContext(tx,s,options)),
    scanFailureRecoveryPage:options=>store.transaction((tx,s)=>scanWithinContext(tx,s,options)),
    workspaceRequired:capacityRequired, capacityStatus:options=>{try{const control=currentFailureControl();if(control&&!control.status().available)return{newAdmissionAvailable:false,reason:'FINANCIAL_RECOVERY_REQUIRED'};return capacityManager.status(options);}catch(error){return{newAdmissionAvailable:false,reason:error.code||'FINANCIAL_RECOVERY_REQUIRED'};}}, withMoneyControl, withMoneyBootControl, maintenanceLease:fn=>store.maintenanceLease(fn), markUncertain(error) {
      poisoned = error || true;
    }, get uncertain() {
      return ! ! poisoned || store.uncertain;
    }
  };
}
function initializeMoneyRuntime( {
  epoch, writer, store, ... options
}) {
  if (runtime) throw fail('MONEY_RUNTIME_ALREADY_INITIALIZED');
  const boundary = require('./financial-epoch');
  boundary.requireEpoch(epoch);
  boundary.assertEpochNotRetired(epoch); // a retired source exits here and never realizes its own WAL
  store=store||openMoneyStore({epoch,writer});
  const bootCapacityRoot=store.getCapacityRecord('capacity:root');
  if(bootCapacityRoot?.profile.grouped?.commitProtocol==='single_sql_v1')require('./money-failure-control').openFailureControl({epoch,writer,store});
  store.initializeAtomicCapacityRuntime();
  const validateSource =(x) => boundary.assertEpochSource( {
    ... x, kind: 'dollar_paid', account_id: x.accountId, checkout_intent_id: x.provenance.intent_id, purchase_id: x.provenance.purchase_id,
    lot_id: x.provenance.lot_id, stripe_payment_intent: x.payment_intent_id, policy_version: x.policy.version, policy_consent_id: x.policy.consent_id,
    created_at: new Date(x.created_at).toISOString()
  }, epoch, 'buyer_return');
  const candidate = createMoneyControl( {
    epoch, writer, store: store || openMoneyStore( {
      epoch, writer
    }), ... options, validateSource, strictLiquidityRevision: true, capacityRequired:true, getCapacityAuthority:()=>{const current=boundary.resolveRuntimeEpoch({root:epoch.legacy_root});if(!current||current.epoch_id!==epoch.epoch_id||current.binding_digest!==epoch.binding_digest)throw fail('EPOCH_REVISION_CHANGED');return {...current,...boundary.requireEpoch(current)};}
  });
  candidate.failureControl?.beginRecoveryScan();
  runtime=candidate;
  return runtime;
}
function getMoneyRuntime() {
  return runtime;
}
function withMoneyControl(options, fn) {
  if (! runtime) throw fail('MONEY_RUNTIME_REQUIRED');
  return runtime.withMoneyControl(options, fn);
}
function withMoneyBootControl(options,fn) {
  if (! runtime) throw fail('MONEY_RUNTIME_REQUIRED');
  return runtime.withMoneyBootControl(options,fn);
}
function runInMoneyContext(fn, options = {
}) {
  const ctx = getActiveMoneyContext();
  if (ctx) return fn(ctx);
  return runtime ? runtime.withMoneyControl(options, fn): fn(null);
}
function assertParticipantWrite(file) {
  const boundary = require('./financial-epoch');
  const epoch = boundary.getRuntimeEpoch();
  if (! epoch) return;
  if (! runtime) throw fail('MONEY_RUNTIME_REQUIRED');
  if (runtime.uncertain) throw fail('MONEY_RUNTIME_UNCERTAIN');
  const context=assertMoneyContext({epoch});
  if(['credits.json','earnings.json','purchase-ledger.json','purchases.jsonl','reservations.json','settlements.jsonl'].includes(require('node:path').basename(file)))context.assertFinancialEffect(context.failureAction());
  boundary.assertEpochWritePath(file, runtime.writer);
}
function poisonMoneyRuntime(error) {
  if (runtime) runtime.markUncertain(error);
}
module.exports = {
  validateParticipantDraws, assertParticipantWrite, poisonMoneyRuntime, createMoneyControl, initializeMoneyRuntime, getMoneyRuntime, withMoneyControl,
  withMoneyBootControl, runInMoneyContext, getActiveMoneyContext, assertMoneyContext, toMicros, returnFigures
};
