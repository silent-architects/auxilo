'use strict';
// Read-only provider evidence collection is separated from locked local apply.
// There is deliberately no provider-create interface in this module.
const { digestJSON, plainObject } = require('./stripe-transfer-persistence');
const proposals = new WeakSet();
function sameContext(attempt, context, readOnly = false) {
    return !!context && ['stripe_platform','stripe_platform_account_id','livemode'].every(key => context[key] === attempt[key]) && context.configuration_generation !== undefined && (readOnly || context.configuration_generation === attempt.configuration_generation);
}
function verifyTransferEvidence(attempt, result, context, { readOnly = false } = {}) {
    if (!sameContext(attempt,context,readOnly) || !plainObject(result)) throw new Error('Provider context/evidence mismatch');
    const id=result.transfer_id||result.id, amount=result.amount_cents===undefined?result.amount:result.amount_cents;
    const destination=typeof result.destination==='string'?result.destination:result.destination&&result.destination.id;
    const type=result.status||result.object;
    if (type!=='transfer' || !/^tr_[A-Za-z0-9_]+$/.test(id||'') || (attempt.stripe_transfer_id&&attempt.stripe_transfer_id!==id) || amount!==attempt.net_amount_cents || result.currency!==attempt.currency || destination!==attempt.stripe_connect_id || result.livemode!==attempt.livemode || !result.metadata || result.metadata.auxilo_transfer_attempt_id!==attempt.attempt_id || result.metadata.auxilo_request_digest!==attempt.request_digest) throw new Error('Provider financial/correlation evidence mismatch');
    for(const field of ['stripe_platform','stripe_platform_account_id','configuration_generation'])if(result[field]!==undefined&&result[field]!==context[field])throw new Error('Provider account evidence mismatch');
    const proof={stripe_transfer_id:id,amount_cents:amount,currency:result.currency,destination,livemode:result.livemode,stripe_platform:context.stripe_platform,stripe_platform_account_id:context.stripe_platform_account_id,configuration_generation:attempt.configuration_generation,observed_configuration_generation:context.configuration_generation,attempt_id:attempt.attempt_id,request_digest:attempt.request_digest};
    return {...proof,evidence_ref:'sha256:'+digestJSON(proof)};
}
function proposal(value) { const result=Object.freeze(value);proposals.add(result);return result; }
function hold(attempt,reason){return proposal({kind:'hold',attempt_id:attempt.attempt_id,generation:attempt.generation,reason});}
async function proposeReconciliation(attempt, provider, options={}) {
    if(attempt.historical)return hold(attempt,'HISTORICAL_DISPOSITION_REQUIRED');
    let context;
    try{context=await provider.getContext();}catch{return hold(attempt,'PROVIDER_CONTEXT_UNAVAILABLE');}
    if(!sameContext(attempt,context,true))return hold(attempt,'PROVIDER_CONTEXT_MISMATCH');
    if(!['unknown','submitted','prepared','confirmed'].includes(attempt.state))return hold(attempt,'LOCAL_STATE_REQUIRES_REVIEW');
    try{
        let result;
        if(attempt.stripe_transfer_id){
            if(typeof provider.retrieveTransfer!=='function')return hold(attempt,'READ_ADAPTER_UNAVAILABLE');
            result=await provider.retrieveTransfer(attempt.stripe_transfer_id,context);
        }else if(options.correlationEvidence!==undefined){
            if(!Array.isArray(options.correlationEvidence)||options.correlationEvidence.length!==1||typeof options.evidenceReference!=='string'||!options.evidenceReference)return hold(attempt,'NONUNIQUE_OR_UNATTESTED_CORRELATION');
            result=options.correlationEvidence[0];
        }
        if(result){
            if(attempt.state==='prepared')return hold(attempt,'PREPARED_TRANSFER_REQUIRES_REVIEW');
            return proposal({kind:'confirmed',attempt_id:attempt.attempt_id,generation:attempt.generation,request_digest:attempt.request_digest,evidence:Object.freeze(verifyTransferEvidence(attempt,result,context,{readOnly:true}))});
        }
        // Only an injected, supported provider determination can supply negative
        // proof. An absent lookup or persisted prepared state never supplies it.
        if(typeof provider.determineNotSent==='function'&&['prepared','unknown'].includes(attempt.state)){
            const evidence=await provider.determineNotSent(attempt,context);
            if(plainObject(evidence)&&evidence.authoritative===true&&evidence.reviewed===true&&evidence.supported_provider_determination===true&&evidence.attempt_id===attempt.attempt_id&&evidence.request_digest===attempt.request_digest&&evidence.stripe_platform_account_id===attempt.stripe_platform_account_id&&typeof evidence.evidence_ref==='string'&&evidence.evidence_ref&&!attempt.stripe_transfer_id&&!attempt.provider_evidence){
                const safe={authoritative:true,reviewed:true,supported_provider_determination:true,attempt_id:attempt.attempt_id,request_digest:attempt.request_digest,stripe_platform_account_id:attempt.stripe_platform_account_id,evidence_ref:evidence.evidence_ref};
                return proposal({kind:'confirmed_not_sent',attempt_id:attempt.attempt_id,generation:attempt.generation,request_digest:attempt.request_digest,evidence:Object.freeze(safe)});
            }
        }
    }catch{return hold(attempt,'PROVIDER_EVIDENCE_UNVERIFIED');}
    return hold(attempt,'AUTHORITATIVE_EVIDENCE_UNAVAILABLE');
}
async function applyReconciliation({store,attemptId,proposal:proof,withLocks,complete,getContradictions}={}) {
    if(!proof||!proposals.has(proof)||proof.attempt_id!==attemptId)throw new Error('Unverified reconciliation proposal');
    if(proof.kind==='hold')return proof;
    if(typeof withLocks!=='function'||typeof complete!=='function')throw new Error('Locked local completion contract required');
    const initial=store.get(attemptId);if(!initial||initial.historical)throw new Error('Historical disposition requires separate instruction');
    return withLocks(initial,async()=>{
        let attempt=store.get(attemptId);
        if(!attempt||attempt.generation!==proof.generation||attempt.request_digest!==proof.request_digest)throw new Error('Stale proposal generation');
        if(proof.kind==='confirmed_not_sent'){
            if(typeof getContradictions!=='function')throw new Error('Authoritative financial contradiction check required');
            const contradictions=await getContradictions(attempt);
            if(!contradictions||contradictions.marker!==false||contradictions.receipt!==false||contradictions.transfer!==false||attempt.stripe_transfer_id||attempt.provider_evidence)throw new Error('Not-sent evidence contradicts or lacks financial inventory');
            // A contradiction read may await; generation must still match.
            attempt=store.get(attemptId);if(attempt.generation!==proof.generation)throw new Error('Stale proposal generation');
            return store.transition(attemptId,attempt.generation,'confirmed_not_sent',{not_sent_evidence:proof.evidence});
        }
        if (attempt.state === 'confirmed') {
            // A new read-only client can corroborate an already durable transfer.
            // Preserve the original evidence (including its observation generation)
            // and finish locally; corroboration is not a new confirmation write.
            const fields = ['stripe_transfer_id', 'amount_cents', 'currency', 'destination',
                'livemode', 'stripe_platform', 'stripe_platform_account_id',
                'configuration_generation', 'attempt_id', 'request_digest'];
            if (!attempt.provider_evidence || fields.some(key =>
                attempt.provider_evidence[key] !== proof.evidence[key])) {
                throw new Error('Confirmed transfer evidence conflict');
            }
            return complete(attempt);
        }
        attempt=store.transition(attemptId,attempt.generation,'confirmed',{stripe_transfer_id:proof.evidence.stripe_transfer_id,provider_evidence:proof.evidence});
        return complete(attempt);
    });
}
module.exports={verifyTransferEvidence,proposeReconciliation,applyReconciliation};
