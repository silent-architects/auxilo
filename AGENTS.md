# Auxilo — Agent Rules

## Active build: P2.1a Autonomous Learning Extraction

Your primary task in this workspace is implementing **BUILD-SPEC-P2.1a**. Before doing anything else, read these three files in order and treat them as authoritative:

1. `specs/ANTIGRAVITY-HANDOFF-P2.1a.md` — your mission, scope boundaries, acceptance criteria, and escalation rules. **Read this first.**
2. `specs/BUILD-SPEC-P2.1a-AUTONOMOUS-EXTRACTION.md` — the full build spec. Do not deviate from it. If the spec is ambiguous on a point, **STOP and return the question**; do not improvise.
3. `specs/TEST-P2.1a.md` — 114 test cases. Every one must pass. **T-109 is the gating Tyler-pilot acceptance test.**

## Hard rules — do not violate

- **Never modify `lib/earnings.js`** or the instant-credit line at `server.js:725`. The earnings flow is locked.
- **Never add a new subprocessor** beyond Anthropic. No Bedrock, Vertex, OpenAI, Gemini, or any other model provider.
- **Never invent product promises.** Consult `docs/PROMISE-VERIFICATION-REGISTER.md` — every user-facing promise must already exist in canonical sources. If the spec references a promise that isn't in the register, stop and return the question.
- **Never skip the test suite.** All 114 cases in `specs/TEST-P2.1a.md` must pass. T-109 (Tyler pilot E2E) is the gating acceptance test.
- **Do not decide architecture.** The spec decides. If a decision is not in the spec, return the question — do not improvise.
- **Do not modify existing `/learn` validation or OFAC screening** in `server.js`.

## Source discipline — MANDATORY

Every technical assertion in your plan, commit messages, and delivery report must be backed by a code read. No plausible-sounding inference. No "I implemented X" without a file:line you can point at.

**Concretely:**
- Before you claim a test passes, run it by exact filename (`node --test test/p2-1a-<name>.test.js`) and cite the file path and the pass count from that run. Do **not** run `node --test test/*.test.js` and match the aggregate count to the spec — that coincidence is how the last build falsely claimed "114/114 pass" when zero P2.1a test files existed.
- Before you claim a field is stamped, open the file and cite the line that stamps it.
- Before you claim an interface conforms to spec §X.Y, re-read spec §X.Y and the interface side-by-side and paste both in the report.
- Before you claim a route is wired, `grep` for the route string and cite the match.
- If a claim is uncertain, say so explicitly ("I have not verified this") instead of hedging and moving on.

"I think it works like X" is not allowed as a load-bearing claim. Violating this rule wastes reviewer cycles and breaks trust with the human on the other end.

## Delivery report contract

When you finish, your delivery report MUST be structured as a table with one row per spec item or rework item. Each row has four columns:

| Spec/Rework item | File:line that implements it | Verification step you ran | Result |

**Rules:**
- Every row must cite a real file:line. "Implemented in multiple files" is not acceptable — pick the canonical line.
- Every row's verification step must be a concrete command: `node --test test/p2-1a-foo.test.js`, `grep -n "pattern" file.js`, `curl -X POST /extract ...`, or `read file.js:100-120`. Not "reviewed manually."
- If a verification step you ran surfaced a failure you then fixed, cite both the failing run and the passing run. Do not silently retry until green.
- If an item is not implemented, mark it ❌ with a one-sentence reason — do not omit rows to make the report look complete.
- Test claims must name the exact test file(s), not a glob. "`test/*.test.js`: 114 pass" is rejected. "`test/p2-1a-extract-handler.test.js`: 14 pass" is accepted.

The reviewer that reads your delivery report will spot-check rows at random by opening the cited file:line and re-running the cited verification step. If any spot-check fails, the entire delivery is rejected and a rework round is fired.

## Default model for extraction

The spec (§6.3) defaults to `claude-haiku-4-5` with `claude-sonnet-4-5` as fallback. These are configuration values in `config/model_config.json` — not code constants. Do not hardcode model names.

## Project governance

- Full project rules live in `CLAUDE.md` (project root) and `docs/INDEX.md` (doc map).
- **Source discipline:** every technical assertion you make must be backed by a code read (Read/Grep) or a doc cite with file:line. No plausible-sounding inference.
- **Documentation governance:** every new feature must update its domain's source-of-truth doc. The build is not done until the docs are updated. The spec's §11 ("Legal Prose") contains pre-written prose for ToS, Privacy Policy, and RUNBOOK amendments — apply them to the live files as part of your delivery.
- **Review gates:** after you deliver, the code will go through a four-gate concurrent review (BUILD-1, BUILD-4, GOV-3, GOV-1, plus GOV-2, SPEC-2, SPEC-3 for compliance and UX). Do not wait for those reviews — deliver cleanly and let them run.

## Escalation

- If you hit a **blocking ambiguity**, return a question. Do not improvise.
- If you hit a **decision the spec didn't anticipate**, return the decision for Tyler to make. Do not make it yourself.
- If a test in TEST-P2.1a.md cannot pass because of a spec defect (not a code defect), flag it — do not delete or weaken the test.
