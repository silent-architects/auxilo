'use strict';

/**
 * lib/stripe-refund-handlers.js — refunds and disputes on a purchased dollar
 * balance. Each exported function takes a constructed Stripe event object
 * (or, for tests, just the fields it reads) and does exactly one thing.
 * server.js's POST /webhook/stripe route is a thin dispatcher: verify the
 * signature, then call the matching function by event.type, passing its own
 * live `earnings` object + a save callback. Tests call these functions
 * directly with a constructed event object — no Stripe SDK, no signature,
 * no network socket.
 *
 * A dispute or refund event names a payment intent, which every purchase's
 * dollar lot carries. Every function here is a clean "not matched" result
 * (never a throw) when the payment intent doesn't match any dollar lot on
 * any account — unrelated Stripe activity is simply outside scope.
 *
 * Earnings mutation mirrors the SAME pattern the unlock-crediting path
 * already uses (server.js: `activeEntry.pending_balance += ...` directly on
 * the live, in-memory `earnings` object, no per-entry lock at the time of
 * writing) — lib/earnings-reversal.js's reverseOneFundedUnlock now takes the
 * SAME acquireEarningsLock the withdrawal rails take (ruling M8), because a
 * reversal subtracts, and subtracting is exactly the half of a read-modify-
 * write a lock exists to protect (crediting only ever adds).
 */

const {
    findAccountAndLotByPaymentIntent,
    freezeDollarLot,
    unfreezeDollarLot,
    stampAndRemoveDollarLotRemainder,
    finalizePendingReversals,
    stampDisputeStatus,
} = require('./credits.js');
const { placeDisputeHoldIfCompatible, clearDisputeHoldIfMatches } = require('./account-holds.js');
const { reverseLotFunding } = require('./earnings-reversal.js');

// Ruling M5/H2: the only statuses a real Stripe dispute closes into. Any
// other status Stripe might ever send (or a status a created event should
// never itself carry) is logged and changes nothing.
const DISPUTE_TERMINAL_STATUSES = new Set(['won', 'lost', 'warning_closed']);

function extractPaymentIntent(stripeObject) {
    if (!stripeObject) return null;
    if (typeof stripeObject.payment_intent === 'string') return stripeObject.payment_intent;
    if (stripeObject.payment_intent && typeof stripeObject.payment_intent.id === 'string') return stripeObject.payment_intent.id;
    return null;
}

/**
 * Reverses every entry in `removal.funded_unlocks` (each currently marked
 * pending_reversal — ruling L6) against `ctx.earnings`, persists earnings
 * FIRST, and only once that succeeds marks them durably reversed on the lot
 * (finalizePendingReversals). A crash between the two leaves the durable
 * pending_reversal marker in place; the next delivery of the SAME Stripe
 * event (Stripe retries a non-2xx response) finds it again — removeDollar-
 * LotRemainder's own pending-entry scan returns it even when there is
 * nothing NEW to remove — and this function completes it, rather than
 * losing the reversal for good.
 *
 * N15: the save happens BEFORE anything is marked durably reversed, on
 * EVERY path through here — including when THIS call's own reverseLotFunding
 * found every entry's id already present in the builder's earnings
 * (`reversed === 0`: an earlier attempt in this same process already
 * mutated memory, but ITS OWN save never reached disk). Skipping the save
 * whenever nothing new was reversed (the old behavior) let
 * finalizePendingReversals mark the entry durably done in credits.json
 * while earnings.json never actually received the change — the next
 * restart reloaded the stale, unreversed balance from disk with no pending
 * marker left anywhere to retry it from. Awaiting the save means a failure
 * here throws, finalizePendingReversals is never reached, and the webhook
 * returns an error so Stripe retries.
 */
async function _reverseAndAlert(found, removal, ctx, alertTitle, alertCategory) {
    let totalReversed = 0;
    if (removal.funded_unlocks.length > 0 && ctx && ctx.earnings) {
        const { totalReversed: reversed } = await reverseLotFunding(ctx.earnings, removal.funded_unlocks);
        totalReversed = reversed;
        if (typeof ctx.saveEarnings === 'function') {
            await ctx.saveEarnings();
        }
        await finalizePendingReversals(found.accountId, removal.lot_id);
    }
    if (ctx && typeof ctx.sendOpsAlert === 'function') {
        ctx.sendOpsAlert(
            alertTitle,
            `account=${found.accountId} lot=${removal.lot_id} removed_usd=${removal.removed_usd.toFixed(6)} ` +
            `reversed_usd=${totalReversed.toFixed(6)} builders_affected=${removal.funded_unlocks.length}`,
            { category: alertCategory }
        ).catch(() => {});
    }
    return totalReversed;
}

/**
 * charge.dispute.created (spec test 21, 26; ruling M5): freeze the affected
 * lot. Nothing about it is removed or reversed yet — the dispute has not
 * been decided. Terms 7.6 item 1 freezes the Balance while ANY dispute
 * about the payment is open, including a card-network inquiry that has not
 * become a chargeback — so this fires (and freezes) regardless of the
 * created event's own opening status, exactly as it always has; the only
 * new guard is against a STALE/retried created event for a dispute already
 * recorded as closed (below). When the lot was already more than half
 * spent, place an account hold (spec test 26): the buyer's account is
 * refused any further NEW purchase until the dispute resolves.
 */
async function handleDisputeCreated(event, ctx = {}) {
    if (require('./financial-epoch').getRuntimeEpoch()) return { matched: false, reason: 'epoch_canonical_reconciliation_required' };
    const dispute = event && event.data && event.data.object;
    const paymentIntent = extractPaymentIntent(dispute);
    if (!paymentIntent) return { matched: false };
    const status = dispute && dispute.status;
    const disputeId = (dispute && dispute.id) || null;

    // M5: a created event should never itself carry an already-terminal
    // status — defend anyway; there is nothing open to freeze.
    if (DISPUTE_TERMINAL_STATUSES.has(status)) {
        return { matched: false, reason: 'already_terminal' };
    }

    const found = findAccountAndLotByPaymentIntent(paymentIntent, ctx.stripeContext);
    if (!found) return { matched: false };

    // M5: ignore a created event for a dispute this lot already recorded as
    // closed — a late/retried delivery of an OLD created event (or one for
    // the same already-decided dispute) must never re-freeze the lot
    // forever. Matched conservatively: only skip when we cannot tell this
    // is a genuinely DIFFERENT dispute (no id on either side, or the same
    // id on both).
    const existingLot = found.lot;
    if (existingLot && DISPUTE_TERMINAL_STATUSES.has(existingLot.dispute_status)
        && (!disputeId || !existingLot.dispute_id || disputeId === existingLot.dispute_id)) {
        return { matched: false, reason: 'dispute_already_closed' };
    }

    const result = await freezeDollarLot(found.accountId, paymentIntent, 'dispute', ctx.stripeContext);
    if (!result.success) return { matched: false };

    await stampDisputeStatus(found.accountId, paymentIntent, disputeId, status || 'needs_response', ctx.stripeContext);

    let holdConflict = false;
    if (result.half_spent) {
        const holdResult = placeDisputeHoldIfCompatible(found.accountId, {
            ...(ctx.stripeContext ? {stripe_platform:ctx.stripeContext.stripe_platform,stripe_platform_account_id:ctx.stripeContext.stripe_platform_account_id} : {}),
            dispute_id: disputeId,
            payment_intent: paymentIntent,
            remaining_usd: result.remaining_usd,
            original_usd: result.original_usd,
        });
        holdConflict = holdResult.conflict;
    }

    return {
        matched: true,
        accountId: found.accountId,
        lot_id: result.lot_id,
        half_spent: !!result.half_spent,
        hold_conflict: holdConflict,
    };
}

/**
 * charge.dispute.closed (spec test 22, 24; ruling H2): only status 'lost' is
 * a loss. 'won' and 'warning_closed' (an inquiry that closed without
 * becoming a chargeback — Terms 7.6 item 2) both unfreeze the lot, reverse
 * nothing, and clear a dispute_hold this same dispute placed. Any other
 * status is logged and changes nothing — Stripe's dispute statuses this
 * event can ever carry are exactly 'won', 'lost', and 'warning_closed'; a
 * future or unrecognized value must never be treated as a loss by default.
 *
 * @param {object} event — a Stripe event, real or constructed.
 * @param {object} ctx — { earnings, saveEarnings, sendOpsAlert } from the caller.
 */
async function handleDisputeClosed(event, ctx = {}) {
    if (require('./financial-epoch').getRuntimeEpoch()) return { matched: false, reason: 'epoch_canonical_reconciliation_required' };
    const dispute = event && event.data && event.data.object;
    const paymentIntent = extractPaymentIntent(dispute);
    const status = dispute && dispute.status;
    if (!paymentIntent) return { matched: false };

    const found = findAccountAndLotByPaymentIntent(paymentIntent, ctx.stripeContext);
    if (!found) return { matched: false };

    if (status === 'won' || status === 'warning_closed') {
        const result = await unfreezeDollarLot(found.accountId, paymentIntent, ctx.stripeContext);
        if (!result.success) return { matched: false };
        await stampDisputeStatus(found.accountId, paymentIntent, (dispute && dispute.id) || null, status, ctx.stripeContext);
        // H2: the ONLY automatic hold-clearance — a dispute resolved in
        // Auxilo's favor (or an inquiry that never became a chargeback)
        // releases the stop IT placed. Any other hold (cap_overage, or a
        // dispute_hold placed by a DIFFERENT, still-open dispute on this
        // same account) needs the admin route (ruling M4) — ruling N6:
        // clear only when the hold's own payment_intent matches the
        // dispute that just closed, never any dispute_hold found on the
        // account.
        clearDisputeHoldIfMatches(found.accountId, {
            ...(ctx.stripeContext ? {stripe_platform:ctx.stripeContext.stripe_platform,stripe_platform_account_id:ctx.stripeContext.stripe_platform_account_id} : {}),
            payment_intent: paymentIntent, dispute_id: (dispute && dispute.id) || null,
        });
        return { matched: true, status, accountId: found.accountId, lot_id: result.lot_id };
    }

    if (status !== 'lost') {
        console.warn(`[stripe-refund-handlers] charge.dispute.closed with an unrecognized status '${status}' — no action taken (payment_intent=${paymentIntent})`);
        return { matched: false, status, reason: 'unrecognized_status' };
    }

    // status === 'lost': the money left Auxilo. Amount-aware exactly like a
    // refund (ruling H1 / N13) — Stripe's `dispute.amount` is the disputed
    // amount, which can be LESS than the full charge when only part of the
    // order is disputed. N14: a refund and a lost dispute on the SAME
    // payment are two SEPARATE running totals, not one shared cumulative
    // figure — stampAndRemoveDollarLotRemainder keeps this dispute's own
    // amount (keyed by its id, so a retried event overwrites rather than
    // adds again) alongside whatever has already been refunded, and removes
    // /reverses against the COMBINED total. A dispute with no `amount`
    // field (or one naming the full charge) behaves exactly as before — the
    // same cap-at-original_usd math the default (Infinity) already gave
    // every existing caller that never populated it.
    const disputedAmountUsd = (dispute && typeof dispute.amount === 'number' && Number.isFinite(dispute.amount))
        ? dispute.amount / 100
        : Infinity;
    const removal = await stampAndRemoveDollarLotRemainder(found.accountId, paymentIntent, {
        type: 'dispute',
        disputeId: (dispute && dispute.id) || null,
        amountUsd: disputedAmountUsd,
    }, ctx.stripeContext);
    if (!removal.success) return { matched: false };
    await stampDisputeStatus(found.accountId, paymentIntent, (dispute && dispute.id) || null, 'lost', ctx.stripeContext);
    // N5: a refund never touches whether a lot is frozen (removeDollarLot-
    // Remainder above no longer does either) -- but THIS dispute is now
    // CLOSED, lost or not, so the freeze IT placed lifts here, explicitly,
    // exactly like the 'won' / 'warning_closed' branches above. What was
    // spent stays removed; the account is simply no longer under an open
    // dispute for this payment.
    await unfreezeDollarLot(found.accountId, paymentIntent, ctx.stripeContext);

    const reversed_usd = await _reverseAndAlert(found, removal, ctx,
        'Dispute lost — dollar lot reversed', 'credits-dispute-lost');

    return {
        matched: true,
        status: 'lost',
        accountId: found.accountId,
        lot_id: removal.lot_id,
        removed_usd: removal.removed_usd,
        reversed_usd,
    };
}

/**
 * charge.refunded (spec test 23; ruling H1): removes the lot's remainder up
 * to the amount refunded and reverses builder shares only for the amount
 * beyond what remained. Stripe's `charge.amount_refunded` is cumulative (in
 * cents) — when present, it drives exactly how much of the pack this event
 * accounts for; a constructed/legacy event with no amount_refunded field is
 * treated as a full refund (the same cap-at-original_usd math makes "full"
 * and "no data" identical), matching today's behavior for every existing
 * caller that never populated Stripe's amount fields.
 *
 * N14: this refund's own cumulative amount is kept as its own running total
 * (`lot.refunded_usd`), separate from any dispute lost on the same payment
 * — stampAndRemoveDollarLotRemainder combines the two before removing or
 * reversing anything, so a dispute lost before or after this refund is
 * never lost from the total and never double counted.
 */
async function handleChargeRefunded(event, ctx = {}) {
    if (require('./financial-epoch').getRuntimeEpoch()) return { matched: false, reason: 'epoch_canonical_reconciliation_required' };
    const charge = event && event.data && event.data.object;
    const paymentIntent = extractPaymentIntent(charge);
    if (!paymentIntent) return { matched: false };

    const found = findAccountAndLotByPaymentIntent(paymentIntent, ctx.stripeContext);
    if (!found) return { matched: false };

    const amountUsd = (charge && typeof charge.amount_refunded === 'number' && Number.isFinite(charge.amount_refunded))
        ? charge.amount_refunded / 100
        : Infinity;

    const removal = await stampAndRemoveDollarLotRemainder(found.accountId, paymentIntent, {
        type: 'refund',
        amountUsd,
    }, ctx.stripeContext);
    if (!removal.success) return { matched: false };

    const reversed_usd = await _reverseAndAlert(found, removal, ctx,
        'Refund — dollar lot reversed', 'credits-refund');

    return {
        matched: true,
        accountId: found.accountId,
        lot_id: removal.lot_id,
        removed_usd: removal.removed_usd,
        reversed_usd,
    };
}

/** Canonical prospective events are reconciled individually. A known voluntary
 * return retires its quoted gross principal; external refunds get independent
 * receipts, so neither the known cash portion nor a later mandatory event is
 * lost in a charge's cumulative amount_refunded counter. */
function createEpochFinancialEventHandler({epoch,store,coordinator,provider,returnService,applyProjection,authorize}) {
    const indexed=store.descriptor?.schema===2;
    const strictWorkspace=()=>coordinator.workspaceRequired===true&&store.getCapacityRecord?.('capacity:root')?.profile?.grouped?.commitProtocol==='single_sql_v1';
    const pendingSourceDemand=source=>source.providerObservation?.canonical===true&&source.providerObservation?.verified===true&&(source.providerObservation.complete===false||source.providerObservation.reason==='external_refund_pending');
    const getOperation=id=>indexed?store.getOperation(id):store.read().operations[id];
    const getSource=id=>indexed?store.getSource(id):store.read().sources[id];
    const getProjection=id=>indexed?store.getProjection(id):store.read().projections[id];
    const permission=authorize||(input=>require('./financial-epoch').assertProspectiveAllowed(input));
    const id=value=>typeof value==='string'?value:value?.id;
    const localFor=(source,fn,recoveryAnchor)=>coordinator.withMoneyControl({kind:'reconcile',accounts:[source.accountId],credits:[source.accountId],epochRevision:epoch.activation_revision,...(recoveryAnchor?{recoveryAnchor,action:'persist_result'}:{})},fn);
    async function project(operationId,source){
        const operation=getOperation(operationId);if(!operation)return false;
        const pending=operation.projectionIds.map(key=>getProjection(key)).filter(p=>p.state==='pending');
        const accounts=[...new Set([source.accountId,...pending.map(p=>p.owner)])].sort();
        const earnings=[...new Set(pending.filter(p=>p.participant==='earnings').map(p=>p.owner))].sort();
        for(const projectionId of operation.projectionIds){
            const projection=getProjection(projectionId);if(['acknowledged','superseded'].includes(projection.state))continue;
            if(typeof applyProjection!=='function')return false;
            const recoveryAnchor=coordinator.failureControl?coordinator.recoveryAnchors.resolveCommittedAnchor({kind:'projection',id:projectionId,accountId:projection.owner,sourceId:source.id}):undefined;
            if(recoveryAnchor)coordinator.failureControl.assertRecoveryAllowed(recoveryAnchor,{action:'participant_effect'});
            await coordinator.withMoneyControl({kind:'reconcile',accounts,credits:[source.accountId],earnings,epochRevision:epoch.activation_revision,...(recoveryAnchor?{recoveryAnchor,action:'participant_effect'}:{})},async ctx=>{
                const current=indexed?ctx.getProjection(projectionId):ctx.snapshot().projections[projectionId];if(['acknowledged','superseded'].includes(current.state))return;
                const receipt=await applyProjection(current,{operation:ctx.getOperation({operationId}),source,context:ctx});
                ctx.ackProjection({id:current.id,digest:current.digest,receipt});
            });
        }
        return ['settled','failed','canceled'].includes(getOperation(operationId).state);
    }
    async function reconcileFinancialEvent({event,context,rawDigest,recoveryAnchor}) {
        const local=(source,fn)=>localFor(source,fn,recoveryAnchor);
        if(!event||!['2025-02-24.acacia','2025-09-30.clover'].includes(event.api_version)||context?.stripe_platform!==epoch.platform||context.stripe_platform_account_id!==epoch.platform_account_id||context.livemode!==epoch.livemode||event.livemode!==epoch.livemode||event.account)return {matched:false,complete:false,reason:'epoch_event_identity_unverified'};
        permission({action:'reconcile',epoch,expectedRevision:epoch.activation_revision});
        const object=event.data?.object;if(!object)return {matched:false,complete:false};
        const chargeId=object.object==='charge'?object.id:id(object.charge),pi=id(object.payment_intent);
        const scoped={platform_account_id:epoch.platform_account_id,livemode:epoch.livemode};
        const byCharge=indexed&&chargeId?store.findSourceByProviderIdentity({...scoped,chargeId}):null,byIntent=indexed&&pi?store.findSourceByProviderIdentity({...scoped,paymentIntentId:pi}):null;
        if(indexed&&byCharge&&byIntent&&byCharge.id!==byIntent.id)return {matched:false,complete:false,reason:'unknown_epoch_financial_source'};
        const resolved=[byCharge,byIntent].filter(Boolean);
        if(indexed&&resolved.some(s=>s.epoch_id!==epoch.epoch_id||s.binding_digest!==epoch.binding_digest||s.platform_account_id!==epoch.platform_account_id||s.livemode!==epoch.livemode||chargeId&&s.charge_id&&s.charge_id!==chargeId||pi&&s.payment_intent_id!==pi||!((chargeId&&s.charge_id===chargeId)||(pi&&s.payment_intent_id===pi))))return {matched:false,complete:false,reason:'unknown_epoch_financial_source'};
        const candidates=indexed?[...new Map(resolved.map(s=>[s.id,s])).values()]:Object.values(store.read().sources).filter(s=>s.epoch_id===epoch.epoch_id&&s.binding_digest===epoch.binding_digest&&s.platform_account_id===epoch.platform_account_id&&s.livemode===epoch.livemode&&((chargeId&&s.charge_id===chargeId)||(pi&&s.payment_intent_id===pi)));
        if(candidates.length!==1)return {matched:false,complete:false,reason:'unknown_epoch_financial_source'};
        let source=candidates[0];
        if(coordinator.failureControl){
            if(!recoveryAnchor)recoveryAnchor=coordinator.recoveryAnchors.resolveCommittedAnchor(rawDigest&&event.id?{kind:'verified_capture',id:require('./stripe-history-coverage').captureIdentity(context,event.id,rawDigest)}:{kind:'pending_source_observation',id:source.id,accountId:source.accountId,sourceId:source.id});
            coordinator.failureControl.assertRecoveryAllowed(recoveryAnchor,{action:'provider_reconcile'});
            const descriptor=coordinator.recoveryAnchors.revalidate(recoveryAnchor),expectedCapture=rawDigest&&event.id?require('./stripe-history-coverage').captureIdentity(context,event.id,rawDigest):null;
            if(!(descriptor.kind==='verified_capture'&&expectedCapture&&descriptor.id===expectedCapture)&&!(descriptor.kind==='pending_source_observation'&&descriptor.id===source.id))throw Object.assign(Error('RECOVERY_ANCHOR_SCOPE_MISMATCH'),{code:'RECOVERY_ANCHOR_SCOPE_MISMATCH'});
        }
        if(!source.charge_id){source=await provider.resolveFundingCharge(source);await local(source,ctx=>ctx.attachFundingCharge({sourceId:source.id,charge_id:source.charge_id,evidence_ref:source.charge_evidence_ref,verified:true}));}
        if(event.type.startsWith('charge.dispute.')){
            const observation=await provider.inspectDispute({source,disputeId:object.id,recoveryAnchor});
            const result=await local(source,ctx=>ctx.recordSourceDispute({sourceId:source.id,providerObservation:observation}));
            const operationId=result.operationId||result.operation_id||result.id;
            return {matched:true,complete:operationId?await project(operationId,source):result.complete===true,reason:result.reason||'dispute_reconciliation_pending'};
        }
        if(object.object==='refund'){
            const known=indexed?store.findOperationByRefund({platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,refundId:object.id}):Object.values(store.read().operations).find(o=>o.refund_id===object.id);
            if(known?.type==='buyer_return'&&known.sourceId===source.id&&known.refund_id===object.id){
                await returnService.reconcile({operationId:known.id});
                const complete=await project(known.id,source);
                return {matched:true,complete,reason:complete?undefined:'refund_reconciliation_pending'};
            }
        }
        const demand=rawDigest&&event.id?{captureId:require('./stripe-history-coverage').captureIdentity(context,event.id,rawDigest),eventId:event.id,rawDigest,sourceId:source.id,accountId:source.accountId}:pendingSourceDemand(source)?{sourceObservationDigest:require('./stripe-transfer-persistence').digestJSON(source.providerObservation),sourceId:source.id,accountId:source.accountId}:undefined;
        const scan=await provider.inspectChargeRefunds({source,cursor:source.refund_scan_cursor||undefined,demand,recoveryAnchor});
        if(!scan.complete&&!scan.inventory_complete){await local(source,ctx=>ctx.recordSourceObservation({sourceId:source.id,observation:scan}));return {matched:true,complete:false,reason:'refund_scan_incomplete'};}
        let complete=scan.complete;
        for(const refund of scan.refunds){
            if(['succeeded','failed','canceled'].includes(refund.status))await local(source,ctx=>ctx.recordSourceObservation({sourceId:source.id,observation:{canonical:true,verified:true,complete:true,source_id:source.id,charge_id:source.charge_id,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,currency:'usd',resolvedRefundIds:[refund.id]}}));
            const known=indexed?store.findOperationByRefund({platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,refundId:refund.id}):null,marked=indexed&&refund.metadata?.auxilo_operation_id?getOperation(refund.metadata.auxilo_operation_id):null;
            const operations=indexed?[...new Map([known,marked].filter(o=>o?.type==='buyer_return').map(o=>[o.id,o])).values()]:Object.values(store.read().operations).filter(o=>o.type==='buyer_return'&&(o.refund_id===refund.id||o.id===refund.metadata?.auxilo_operation_id));
            if(operations.length>1||(operations.length===1&&operations[0].sourceId!==source.id)){complete=false;continue;}
            if(operations.length===1){
                const operation=operations[0];await returnService.reconcile({operationId:operation.id});
                if(!await project(operation.id,source))complete=false;
                continue;
            }
            if(refund.metadata?.auxilo_operation_id||refund.metadata?.auxilo_request_digest){
                await local(source,ctx=>ctx.recordSourceObservation({sourceId:source.id,freezeSource:true,observation:{canonical:true,verified:true,complete:true,source_id:source.id,charge_id:source.charge_id,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,currency:'usd',refund_id:refund.id,reason:'unknown_voluntary_refund_identity'}}));complete=false;continue;
            }
            if(refund.status!=='succeeded'){
                if(!['failed','canceled'].includes(refund.status)){
                    await local(source,ctx=>ctx.recordSourceObservation({sourceId:source.id,freezeSource:true,freezeReason:'refund_pending',refundId:refund.id,observation:{canonical:true,verified:true,complete:true,source_id:source.id,charge_id:source.charge_id,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,currency:'usd',refund_id:refund.id,reason:'external_refund_pending'}}));complete=false;
                }
                continue;
            }
            const cashMicros=refund.amount*10000;
            const observation={canonical:true,verified:true,complete:true,refund_id:refund.id,cashMicros,charge_id:source.charge_id,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,currency:'usd',evidence_ref:`stripe:${epoch.platform_account_id}:${epoch.livemode}:${refund.id}`,...(id(refund.balance_transaction)?{balance_effect_id:id(refund.balance_transaction)}:{})};
            const operation=await local(source,ctx=>ctx.recordExternalRefund({sourceId:source.id,refundId:refund.id,cashMicros,providerObservation:observation}));
            if(!await project(operation.id,source))complete=false;
        }
        // Advance the durable consumption cursor only after every effect in the
        // bounded page has been processed; replay is safe after a crash.
        await local(source,ctx=>{
            // Inventory completion does not resolve an earlier page's pending
            // refund. Keep that durable demand until its exact exception closes.
            let pending;
            if(indexed&&typeof store.hasPendingSourceRefund==='function')pending=store.hasPendingSourceRefund({sourceId:source.id});
            else if(strictWorkspace())throw Object.assign(Error('PENDING_REFUND_QUERY_REQUIRED'),{code:'PENDING_REFUND_QUERY_REQUIRED'});
            else pending=!indexed&&Object.values(store.read().exceptions||{}).some(e=>e.sourceId===source.id&&e.kind==='SOURCE_REFUND_PENDING'&&e.state!=='resolved');
            if(typeof pending!=='boolean')throw Object.assign(Error('PENDING_REFUND_QUERY_REQUIRED'),{code:'PENDING_REFUND_QUERY_REQUIRED'});
            if(pending)complete=false;
            ctx.recordSourceObservation({sourceId:source.id,observation:pending?{...scan,reason:'external_refund_pending'}:scan});
        });
        return {matched:true,complete,reason:complete?undefined:'refund_reconciliation_pending'};
    }
    // Restart/timer reconciliation uses durable identities as read triggers. It
    // never manufactures a signed event or replays a provider POST.
    let lastReconciledKey='',operationCursor,sourceCursor,sourceTurn=false;
    reconcileFinancialEvent.reconcilePending=async function({limit=25}={}){
        if(!Number.isInteger(limit)||limit<1||limit>100)throw Object.assign(Error('INVALID_RECONCILIATION_LIMIT'),{code:'INVALID_RECONCILIATION_LIMIT'});
        permission({action:'reconcile',epoch,expectedRevision:epoch.activation_revision});
        if(indexed){
            let processed=0;const errors=[],context={stripe_platform:epoch.platform,stripe_platform_account_id:epoch.platform_account_id,livemode:epoch.livemode};
            // Alternate bounded source and operation pages, so unknown operations
            // cannot starve source-only pending refunds or disputes.
            const opLimit=limit===1?(sourceTurn?0:1):Math.ceil(limit/2),sourceLimit=limit-opLimit;sourceTurn=!sourceTurn;
            if(opLimit){const page=store.listPendingOperations({after:operationCursor,limit:opLimit});operationCursor=page.nextCursor||undefined;for(const operation of page.items){const source=getSource(operation.sourceId);if(!source)continue;try{if(operation.type==='buyer_return')await returnService.reconcile({operationId:operation.id});await project(operation.id,source);}catch(error){if(error.financialStorageFailure||store.uncertain)throw error;errors.push({operationId:operation.id,code:error.code||'RECONCILIATION_FAILED'});}processed++;}}
            if(sourceLimit){const page=store.listSources({after:sourceCursor,limit:sourceLimit});sourceCursor=page.nextCursor||undefined;for(const source of page.items){if(!source.charge_id)continue;try{if(!strictWorkspace()||pendingSourceDemand(source))await reconcileFinancialEvent({context,event:{type:'charge.refunded',api_version:'2025-02-24.acacia',livemode:epoch.livemode,data:{object:{object:'charge',id:source.charge_id,payment_intent:source.payment_intent_id}}}});for(const dispute of Object.values(source.disputes||{})){if(['won','lost','warning_closed'].includes(dispute.status))continue;await reconcileFinancialEvent({context,event:{type:'charge.dispute.closed',api_version:'2025-02-24.acacia',livemode:epoch.livemode,data:{object:{object:'dispute',id:dispute.dispute_id,charge:source.charge_id,payment_intent:source.payment_intent_id}}}});}}catch(error){if(error.financialStorageFailure||store.uncertain)throw error;errors.push({sourceId:source.id,code:error.code||'RECONCILIATION_FAILED'});}processed++;}}
            return {processed,errors};
        }
        let processed=0;const errors=[],jobs=[];
        const snapshot=store.read();
        for(const operation of Object.values(snapshot.operations)){
            if(['settled','failed','canceled','requote_required'].includes(operation.state))continue;
            const source=snapshot.sources[operation.sourceId];if(!source)continue;
            jobs.push({key:'operation:'+operation.id,operationId:operation.id,run:async()=>{if(operation.type==='buyer_return')await returnService.reconcile({operationId:operation.id});await project(operation.id,source);}});
        }
        const sourceIds=new Set(Object.values(snapshot.exceptions).filter(x=>x.sourceId&&x.state!=='resolved'&&['SOURCE_REFUND_PENDING','SOURCE_PROVIDER_RECONCILIATION_REQUIRED'].includes(x.kind)).map(x=>x.sourceId));
        for(const source of Object.values(snapshot.sources))if(source.refund_scan_cursor)sourceIds.add(source.id);
        const context={stripe_platform:epoch.platform,stripe_platform_account_id:epoch.platform_account_id,livemode:epoch.livemode};
        for(const sourceId of sourceIds){const source=snapshot.sources[sourceId];if(!source)continue;jobs.push({key:'source:'+sourceId,sourceId,run:()=>reconcileFinancialEvent({context,event:{type:'charge.refunded',api_version:'2025-02-24.acacia',livemode:epoch.livemode,data:{object:{object:'charge',id:source.charge_id,payment_intent:source.payment_intent_id}}}})});}
        for(const source of Object.values(snapshot.sources))for(const dispute of Object.values(source.disputes||{})){if(['won','lost','warning_closed'].includes(dispute.status))continue;jobs.push({key:'dispute:'+source.id+':'+dispute.dispute_id,sourceId:source.id,run:()=>reconcileFinancialEvent({context,event:{type:'charge.dispute.closed',api_version:'2025-02-24.acacia',livemode:epoch.livemode,data:{object:{object:'dispute',id:dispute.dispute_id,charge:source.charge_id,payment_intent:source.payment_intent_id}}}})});}
        // A persistent unknown must not starve later sources or disputes. The
        // journal holds durable work; this cursor only schedules fair batches.
        jobs.sort((a,b)=>a.key.localeCompare(b.key));
        let start=jobs.findIndex(job=>job.key>lastReconciledKey);if(start<0)start=0;
        for(let i=0;i<Math.min(limit,jobs.length);i++){
            const job=jobs[(start+i)%jobs.length];lastReconciledKey=job.key;
            try{await job.run();}catch(error){errors.push({...job.operationId?{operationId:job.operationId}:{sourceId:job.sourceId},code:error.code||'RECONCILIATION_FAILED'});}processed++;
        }
        return {processed,errors};
    };
    return reconcileFinancialEvent;
}

module.exports = {
    handleDisputeCreated,
    handleDisputeClosed,
    handleChargeRefunded,
    extractPaymentIntent,
    createEpochFinancialEventHandler,
};
