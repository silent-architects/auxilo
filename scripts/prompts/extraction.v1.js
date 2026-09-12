'use strict';

const PROMPT_BUNDLE_VERSION = '1';
const ASSEMBLY_CONTRACT_VERSION = '1';

const CATEGORIES = Object.freeze([
  'data-processing',
  'web-interaction',
  'code-execution',
  'storage-state',
  'payment-financial',
  'monitoring',
]);
const PRIVATE_CATEGORIES = Object.freeze([
  'data-processing',
  'web-interaction',
  'code-execution',
  'storage-state',
  'payment-financial',
  'monitoring',
  'non-technical',
]);
const RETIRED_CATEGORIES = Object.freeze(['communication', 'content-generation']);

const EXTRACTION_PROMPT_BASE = `You are extracting reusable OPERATIONAL LEARNINGS from an AI agent's session transcript, to publish to a PUBLIC knowledge marketplace read by other AI agents.

Extract 0 to 5 GENUINE learnings: non-obvious solutions, workarounds, API quirks, error root-causes, integration gotchas — the kind of thing that cost real debugging or combined multiple sources. SKIP trivial lookups, well-documented standard approaches, opinions, and conversation.

HARD SCOPE RULE — TECHNICAL LEARNINGS ONLY (the marketplace accepts nothing else): extract ONLY technical/operational learnings — APIs, developer tools, code, infrastructure, data pipelines, monitoring/observability, payment/crypto TECHNOLOGY, debugging. NEVER extract interpersonal or communication strategy, copywriting/content/marketing insights, business or negotiation strategy, personal matters, or creative-writing technique — DROP such candidates entirely, do not relabel them. A technical learning about a messaging/email/notification API belongs under "web-interaction" or "code-execution"; content/data pipeline TECH belongs under "data-processing".

SYSTEM-FACT TEST (CI-7): Extract ONLY when a system and a symptom are at the core — an error, an undocumented limitation, a reproducible behavior of an external tool/API/OS. If the candidate is advice about how to work (process, workflow, methodology, decision practice), do NOT extract it. "Odesli cannot resolve Tidal artist URLs" is a learning; "use a two-phase consultation workflow" is not, no matter how well it would score.

MANDATORY SENSITIVITY SELF-SCREEN (the marketplace is PUBLIC): NEVER include secrets, credentials, API keys, tokens, private keys, or seed phrases; personal data (real people's names, emails, phone numbers, wallet addresses); private filesystem paths, internal hostnames, or infrastructure identifiers; proprietary, confidential, or client-specific business content. Rewrite specifics into generic placeholders (/Users/USER/..., API_KEY, "a client") or omit them. If a learning cannot be generalized without leaking private material, DROP it entirely.

Output STRICT JSON ONLY — an object with:
  "learnings": an array (possibly empty []) of objects with these keys:
  "title": concise, >= 10 chars
  "body": >= 50 chars — what was tried, what worked, what failed
  "category": one of ["data-processing","web-interaction","code-execution","storage-state","payment-financial","monitoring"]
  "tags": array of lowercase keyword strings
  "task_context": one sentence describing the task
  "outcome": one of "success","partial","failure","workaround"
  "dedup_drops": an array (possibly empty []) used ONLY for candidates dropped
  because they match PREVIOUSLY CAPTURED LESSONS. Each entry must be:
    {"candidate": <the complete learning object above>,
     "matched_index_id": "<exact id from the memory list>",
     "matched_title": "<exact matched title>"}
  Scope/quality/sensitivity skips are not dedup_drops.`;

const PUBLIC_SCOPE_BLOCK = `HARD SCOPE RULE — TECHNICAL LEARNINGS ONLY (the marketplace accepts nothing else): extract ONLY technical/operational learnings — APIs, developer tools, code, infrastructure, data pipelines, monitoring/observability, payment/crypto TECHNOLOGY, debugging. NEVER extract interpersonal or communication strategy, copywriting/content/marketing insights, business or negotiation strategy, personal matters, or creative-writing technique — DROP such candidates entirely, do not relabel them. A technical learning about a messaging/email/notification API belongs under "web-interaction" or "code-execution"; content/data pipeline TECH belongs under "data-processing".

SYSTEM-FACT TEST (CI-7): Extract ONLY when a system and a symptom are at the core — an error, an undocumented limitation, a reproducible behavior of an external tool/API/OS. If the candidate is advice about how to work (process, workflow, methodology, decision practice), do NOT extract it. "Odesli cannot resolve Tidal artist URLs" is a learning; "use a two-phase consultation workflow" is not, no matter how well it would score.`;

const PRIVATE_SCOPE_BLOCK = `PRIVATE CAPTURE SCOPE — OWNER-ONLY: extract reusable technical OR non-technical operational learnings. Non-technical process, workflow, communication, content, business, or creative learnings may use category "non-technical"; do not drop a genuine reusable candidate solely because it is non-technical. This private lane is never published unless the owner later sanitizes and promotes an item through public review. The mandatory sensitivity screen still applies without exception.`;

const QUALITY_RUBRIC_ADDENDUM = `
  "quality_self_assessment": an object scoring the learning honestly on four
  dimensions, each an INTEGER 1-5: "specificity" (precise and detailed, not
  vague), "actionability" (another agent can directly use it), "novelty"
  (non-obvious; an LLM would likely get it wrong), "completeness" (context,
  reproduction steps, caveats), plus "total" (the exact sum of the four).
  A learning worth publishing scores at least 14/20 with no dimension below 3.
  High scores REQUIRE a system+symptom anchor — a named external system and a
  concrete error/limitation/behavior; process or workflow advice cannot score
  high no matter how polished (CI-7 system-fact test).
  If a learning honestly scores below that bar, DROP it from learnings rather
  than inflating the numbers.`;

const PROMPT_SUFFIX = `
No prose, no explanation, no markdown code fences — just the raw JSON object
{"learnings":[...],"dedup_drops":[...]}.

TRANSCRIPT:
`;

const ANCHORED_JUDGE_PROMPT_BASE = `You are a binary deduplication judge for operational learnings.
For each candidate, decide whether it is a re-statement of ANY listed previously
captured lesson. The same operational insight in different words is YES.
A genuinely new fact is NO only when it would change what another agent does.

Return STRICT JSON ONLY:
{"decisions":[{"candidate_index":0,"duplicate":true,"matched_index_id":"..."}]}
Return exactly one decision for every candidate_index. When duplicate=false,
omit matched_index_id. When duplicate=true, matched_index_id MUST be one of that
candidate's listed ids. No prose and no markdown.`;

module.exports = Object.freeze({
  PROMPT_BUNDLE_VERSION,
  ASSEMBLY_CONTRACT_VERSION,
  CATEGORIES,
  PRIVATE_CATEGORIES,
  RETIRED_CATEGORIES,
  EXTRACTION_PROMPT_BASE,
  PUBLIC_SCOPE_BLOCK,
  PRIVATE_SCOPE_BLOCK,
  QUALITY_RUBRIC_ADDENDUM,
  PROMPT_SUFFIX,
  ANCHORED_JUDGE_PROMPT_BASE,
});
