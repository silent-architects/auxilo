# Auxilo Sprint Orchestrator

> Architecture for automated sprint execution: punchlist → sprint plan → scoped agent prompts → fresh context windows.
> Created: 2026-02-27

---

## The Problem

Each sprint session consumes a full context window. By the time Track 2 finishes, the context is packed with Track 1 artifacts, debug logs, and prior decisions. This leads to:
- Compaction losses (nuance from early decisions gets compressed away)
- Slow tool calls (LLM processes 200K tokens of context before every action)
- Architect carrying implementation details it shouldn't need

**Solution**: An orchestration layer that keeps the Architect thin — it reads the punchlist, generates scoped prompts, and dispatches them to fresh agents that start clean.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR                          │
│                                                         │
│  1. Read PUNCH-LIST.md → identify next unblocked items  │
│  2. Read SPRINT-XX.md → check current sprint state      │
│  3. Generate SPRINT-NEXT.md (sprint plan)               │
│  4. For each sprint item:                               │
│     a. Planner agent → BUILD-SPEC + test plan           │
│     b. Builder agent → implementation (fresh context)   │
│     c. QA agent → test execution (fresh context)        │
│     d. Deploy agent → prod VM push (fresh context)      │
│  5. Update PUNCH-LIST.md + SPRINT-XX.md with results    │
└─────────────────────────────────────────────────────────┘
```

### Core Principle: File-Based Handoff

Agents communicate through **files**, not context. Each agent:
- Reads specific input files at start
- Writes specific output files at end
- Has no access to other agents' context windows

This means the Orchestrator's context stays small — it only holds the punchlist state, sprint plan, and dispatch logic. The heavy lifting happens in disposable agent contexts.

---

## Agent Roles in Orchestration

### 1. Orchestrator (this agent — BUILD-1 Architect level)
**Model**: Opus
**Context load**: Light (~20K tokens)
**Reads**: PUNCH-LIST.md, SPRINT-XX.md, AGENT-TEAM.md
**Writes**: SPRINT-NEXT.md, dispatches agent prompts
**Does NOT**: Write specs, code, tests, or deploy. Only coordinates.

### 2. Planner Agent (spec + test generation)
**Model**: Opus
**Context load**: Medium (~50K tokens)
**Reads**: PUNCH-LIST.md items (scoped), prior SPEC files for patterns, AGENT-TEAM.md
**Writes**: `specs/SPEC-{phase}.md`, `specs/TEST-{phase}.md`, `BUILD-SPEC.md`
**Fresh context**: Yes — starts clean with only the scoped items

### 3. Builder Agent (implementation)
**Model**: Sonnet
**Context load**: Medium-Heavy (~80K tokens)
**Reads**: BUILD-SPEC.md, relevant source files, test file
**Writes**: Production code per BUILD-SPEC scope
**Fresh context**: Yes — never sees planning discussion or prior sprint items

### 4. QA Agent (test execution + regression)
**Model**: Haiku (regression) + Sonnet (complex scenarios)
**Context load**: Medium (~50K tokens)
**Reads**: Test file, BUILD-SPEC regression checklist, source files under test
**Writes**: Test results, pass/fail report
**Fresh context**: Yes — explicitly isolated from build context

### 5. Deploy Agent (prod VM push + live validation)
**Model**: Sonnet
**Context load**: Light (~30K tokens)
**Reads**: DEPLOY-GUIDE.md, source files to upload, live validation checklist
**Writes**: Deployment log, live validation results
**Fresh context**: Yes — uses DEPLOY-GUIDE.md as its operational manual

---

## Orchestrator Decision Logic

### Step 1: Read Punchlist State

```
Read PUNCH-LIST.md
Parse all items into: { id, description, status, dependencies, priority }
Filter: status NOT IN (DONE, VERIFIED, BLOCKED)
Sort by: priority (P0 first), then dependency order
```

### Step 2: Identify Next Sprint Items

```
For each OPEN item (priority-sorted):
  If all dependencies are DONE/VERIFIED → eligible
  If any dependency is OPEN → skip (still blocked)
  If any dependency is BLOCKED → flag for human review

Collect first 3-5 eligible items → sprint candidates
```

### Step 3: Check Sprint Continuity

```
Read current SPRINT-XX.md
If sprint has incomplete items → those take priority over new items
If sprint is complete → increment sprint number, create SPRINT-NEXT.md
```

### Step 4: Generate Sprint Plan

Write `SPRINT-{N+1}.md` with:
- Sprint items (IDs from punchlist)
- Track groupings (parallelizable vs. sequential)
- Agent assignments per item
- Entry criteria (what must be true before each item starts)
- Exit criteria (what "done" means for each item)

### Step 5: Dispatch Agent Prompts

For each sprint item, generate a **self-contained prompt** that includes:

```markdown
# Sprint Item: {item_id} — {description}

## Context
- You are {agent_role} working on Auxilo.
- Read your role instructions: agents/{role}/CLAUDE.md
- This is Sprint {N}, Item {item_id}.

## Input Files (read these first)
- {list of specific files this agent needs}

## Your Task
{scoped, unambiguous description of what to do}

## Output Files (write these when done)
- {list of specific files to create/modify}

## Constraints
- Only modify files listed above
- Do not add unrequested features
- If blocked, write a BLOCKED note to {output_file} and stop

## Definition of Done
- {checklist of exit criteria}

## When Done
Write a summary to: sprints/{sprint_id}/{item_id}-result.md
```

---

## Prompt Templates

### Planner Prompt (SPEC + Test Generation)

```markdown
# Planner: Generate SPEC and Tests for Phase {phase}

## Your Role
You are BUILD-1 (Architect) + BUILD-4 (QA) combined for planning purposes.
Read: agents/architect/CLAUDE.md and agents/qa-integration/CLAUDE.md

## Context
The punchlist item is:
> {punchlist_item_description}

Prior specs to reference for patterns and style:
- specs/SPEC-P0.1.md (most recent, use as template)
- specs/SPEC-A3.md (for security-heavy items)

Current architecture:
- Runtime: Node.js + Hono (server.js ~1500 lines)
- Storage: JSON files in data/
- Auth: Magic link + JWT (Phase 0.1) + x402 (existing)
- Deployment: legacy cloud VM (pre-Fly)

## Dependencies
These items are DONE and available:
{list of completed dependency items with brief description}

## Deliverables
1. `specs/SPEC-{phase}.md` — Full specification following the SPEC-P0.1 pattern
2. Test cases section within the spec (numbered, covering happy path + edge cases + adversarial)
3. `BUILD-SPEC.md` — Implementation plan following the architect CLAUDE.md format

## Constraints
- Test-first methodology: test cases must be concrete enough to implement before code
- Keep scope minimal — the punchlist item defines the boundary
- No scope creep into adjacent items
- If the item depends on something not yet built, note it and stop

## Output
Write all three files. Include a brief summary at the top of BUILD-SPEC.md noting:
- Estimated session count for implementation
- Risk factors
- Files that will be modified (with line count estimates)
```

### Builder Prompt (Implementation)

```markdown
# Builder: Implement {item_id} — {description}

## Your Role
You are BUILD-2 (Builder). Read: agents/builder/CLAUDE.md

## Input (read these first, completely)
1. BUILD-SPEC.md — your implementation plan (AUTHORITATIVE)
2. specs/SPEC-{phase}.md — the specification
3. Source files listed in BUILD-SPEC "YOU MAY modify" section

## Rules
1. Read BUILD-SPEC completely before writing any code
2. Only modify files listed in BUILD-SPEC
3. Run tests after each change: `npx mocha tests/{test_file}`
4. Two-strike rule: 2 failed attempts → stop, document the blocker
5. No drive-by refactors. No unrequested features.

## Exit Criteria
- All test cases from BUILD-SPEC pass
- Regression checklist from BUILD-SPEC passes
- No files modified outside scope
- Write summary to: sprints/{sprint_id}/{item_id}-build-result.md

## If Blocked
Write to sprints/{sprint_id}/{item_id}-BLOCKED.md:
- What you attempted
- What failed (with error output)
- What you think the fix requires
```

### QA Prompt (Test Execution)

```markdown
# QA: Validate {item_id} — {description}

## Your Role
You are BUILD-4 (QA & Integration). Read: agents/qa-integration/CLAUDE.md

## Critical Rule
You are testing in a CLEAN CONTEXT. You did not build this code.
You have no insider knowledge of the implementation.
Test only from the spec and test cases.

## Input
1. specs/SPEC-{phase}.md — what was supposed to be built
2. tests/{test_file} — test cases to run
3. agents/qa-integration/CLAUDE.md — regression checklist

## Tasks
1. Run the spec's test suite: `npx mocha tests/{test_file}`
2. Run full v0.3.0 regression: `npx mocha tests/`
3. Test edge cases from the Edge Case Library in your CLAUDE.md
4. If any test fails, document exactly what failed and the error output

## Output
Write to: sprints/{sprint_id}/{item_id}-qa-result.md
- Test suite results (pass/fail count)
- Regression results (pass/fail count)
- Edge case results
- VERDICT: PASS or FAIL (with reasons if FAIL)
```

### Deploy Prompt (Prod VM Push)

```markdown
# Deploy: Push {item_id} to the prod VM

## Your Role
You are the deployment agent. Read: DEPLOY-GUIDE.md (your complete operational manual)

## Credentials
- API Key: Read from the legacy host CLI's config file in $HOME
- Wallet Key: Read from the legacy host CLI's wallet file in $HOME (if needed for start.sh update)

## Files to Deploy
{list of changed files from BUILD-SPEC}

## Steps
Follow DEPLOY-GUIDE.md exactly:
1. Upload changed files (use chunked method for files >37KB)
2. Run npm install if package.json changed
3. Stop server (separate exec call)
4. Start server (separate exec call via start.sh)
5. Run live validation checklist from DEPLOY-GUIDE.md

## Output
Write to: sprints/{sprint_id}/{item_id}-deploy-result.md
- Files uploaded (with sizes)
- npm install result
- Server restart result (PID)
- Live validation checklist results
- VERDICT: DEPLOYED or FAILED
```

---

## File Structure

```
auxilo/
├── ORCHESTRATOR.md          ← this file (architecture reference)
├── DEPLOY-GUIDE.md          ← operational deployment manual
├── PUNCH-LIST.md            ← master task list (source of truth)
├── SPRINT-01.md             ← completed sprint
├── SPRINT-02.md             ← next sprint (generated by orchestrator)
├── BUILD-SPEC.md            ← current implementation spec
├── sprints/                 ← sprint execution artifacts
│   ├── sprint-01/
│   │   ├── S1-11-deploy-result.md
│   │   └── ...
│   └── sprint-02/
│       ├── S2-01-spec-result.md
│       ├── S2-01-build-result.md
│       ├── S2-01-qa-result.md
│       └── S2-01-deploy-result.md
├── agents/
│   ├── architect/CLAUDE.md
│   ├── builder/CLAUDE.md
│   ├── qa-integration/CLAUDE.md
│   └── ...
├── prompts/
│   ├── A-SERIES-BUILD-PUSH.md
│   ├── AUDITOR-LEARNING-PIPELINE.md
│   ├── orchestrator-planner.md    ← planner prompt template
│   ├── orchestrator-builder.md    ← builder prompt template
│   ├── orchestrator-qa.md         ← QA prompt template
│   └── orchestrator-deploy.md     ← deploy prompt template
└── specs/
    ├── SPEC-P0.1.md
    ├── SPEC-P0.2.md  ← generated by planner
    └── ...
```

---

## Execution Flow (Concrete Example)

**Trigger**: Tyler says "Run the next sprint" or Orchestrator is invoked.

### 1. Orchestrator reads punchlist
```
OPEN items (P0, dependency-satisfied):
  0.2 — Dual Auth Middleware (depends on 0.1 ✅)
  T-2 — Phase 0 test cases (depends on 0.1 ✅)

OPEN items (P0, still blocked):
  0.3 — Credit System (depends on 0.2 — not done yet)
  0.4 — Stripe Integration (depends on 0.3 — not done yet)
```

### 2. Orchestrator generates SPRINT-02.md
```markdown
Sprint 02: Phase 0.2 Dual Auth + Testing Foundation
Items: S2-01 (SPEC-P0.2), S2-02 (test cases), S2-03 (implement), S2-04 (review), S2-05 (deploy)
Track 1: 0.2 Dual Auth (S2-01 → S2-05)
Track 2: T-2 Phase 0 test cases (parallel with Track 1 planning)
```

### 3. Orchestrator dispatches Planner agent
```
→ Fresh context window
→ Input: punchlist item 0.2, SPEC-P0.1 as pattern, current server.js architecture
→ Output: specs/SPEC-P0.2.md, BUILD-SPEC.md
→ Agent exits. Context discarded.
```

### 4. Orchestrator dispatches Builder agent
```
→ Fresh context window
→ Input: BUILD-SPEC.md, SPEC-P0.2.md, server.js, lib/accounts.js
→ Output: modified server.js (dual auth middleware)
→ Agent exits. Context discarded.
```

### 5. Orchestrator dispatches QA agent
```
→ Fresh context window (explicitly isolated from builder)
→ Input: SPEC-P0.2.md, test file, regression checklist
→ Output: qa-result.md with PASS/FAIL
→ Agent exits. Context discarded.
```

### 6. Orchestrator dispatches Deploy agent
```
→ Fresh context window
→ Input: DEPLOY-GUIDE.md, changed files, validation checklist
→ Output: deploy-result.md with DEPLOYED/FAILED
→ Agent exits. Context discarded.
```

### 7. Orchestrator updates punchlist
```
Read all result files from sprints/sprint-02/
If all PASS/DEPLOYED → mark 0.2 DONE in PUNCH-LIST.md
If any FAIL → mark sprint item as blocked, note reason
Update SPRINT-02.md with completion status
```

---

## Implementation via Claude Code

In Claude Code (the environment this runs in), the Orchestrator uses **Task agents** for dispatch:

```
Task(subagent_type="general-purpose", prompt=<planner_prompt>)
  → Planner writes specs to disk

Task(subagent_type="general-purpose", prompt=<builder_prompt>)
  → Builder implements code on disk

Task(subagent_type="general-purpose", prompt=<qa_prompt>)
  → QA runs tests, writes results to disk

Task(subagent_type="general-purpose", prompt=<deploy_prompt>)
  → Deploy agent pushes to the prod VM, writes results to disk
```

Each Task agent:
- Gets a self-contained prompt with all file paths
- Has full tool access (Read, Write, Edit, Bash, Glob, Grep)
- Runs in its own context window
- Returns a summary to the Orchestrator
- The Orchestrator never sees the agent's internal reasoning — only the result files

### Parallel Execution

Independent items can run simultaneously:
```
# These can run in parallel (no dependency)
Task(prompt=<planner_for_0.2>) + Task(prompt=<test_writer_for_T2>)

# These must be sequential (0.2 build depends on 0.2 spec)
await Task(prompt=<planner_for_0.2>)
then Task(prompt=<builder_for_0.2>)
```

---

## Context Budget

| Agent | Estimated Context | Rationale |
|-------|------------------|-----------|
| Orchestrator | ~20K tokens | Only reads punchlist + sprint state + result summaries |
| Planner | ~50K tokens | Reads 2-3 spec files as patterns + current architecture |
| Builder | ~80K tokens | Reads BUILD-SPEC + source files under modification |
| QA | ~50K tokens | Reads spec + test file + runs tests |
| Deploy | ~30K tokens | Reads DEPLOY-GUIDE + uploads files |

**Total per sprint item**: ~230K tokens across 4-5 agent contexts
**vs. monolithic**: ~200K tokens in ONE context (compaction risk, speed degradation)

The orchestrated approach uses slightly more total tokens but keeps each context focused and fast.

---

## Failure Handling

| Failure | Orchestrator Action |
|---------|-------------------|
| Planner produces ambiguous spec | Re-dispatch with clarification prompt |
| Builder fails twice (two-strike) | Read BLOCKED file, decide: re-spec or escalate to Tyler |
| QA fails regression | Do NOT deploy. Read failure details. Re-dispatch builder with fix prompt. |
| Deploy fails | Read deploy-result.md. Common fixes in DEPLOY-GUIDE troubleshooting table. |
| Multiple items fail | Stop sprint. Write summary. Escalate to Tyler. |

---

## Getting Started

To run the Orchestrator for Sprint 02:

1. Open a fresh Claude Code session in the `auxilo/` directory
2. Say: **"Run the Orchestrator. Read ORCHESTRATOR.md, PUNCH-LIST.md, and SPRINT-01.md. Identify next eligible items, generate SPRINT-02.md, and dispatch agents per the orchestration pattern."**
3. The Orchestrator will:
   - Parse the punchlist
   - Identify 0.2 Dual Auth as the next P0 item
   - Generate SPRINT-02.md
   - Dispatch Planner → Builder → QA → Deploy in sequence
   - Update PUNCH-LIST.md when complete
