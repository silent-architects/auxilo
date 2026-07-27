# Auxilo — Agent Rules

Standing rules for any coding agent working in this repo (Codex, Claude Code, or other).
Per-build instructions arrive as a BUILD-SPEC from the PM; this file holds only the
standing rules that never change between builds. Where a BUILD-SPEC and this file
conflict, STOP and return the question — do not pick one.

## Environment — canonical base, verified every session

- The canonical repo is `https://github.com/silent-architects/auxilo`; the canonical
  base for all work is `origin/main`. No other clone, mirror, or local lineage is
  authoritative.
- Repo history was reconciled on 2026-07-01. Commits that exist only in checkouts made
  before that date are NOT canonical, even if the worktree looks clean. A clean
  `git status` proves nothing about lineage.
- **Session-start ritual (mandatory, before any edit).** Run all of these and paste the
  output into the build thread:

      git fetch origin
      git log --oneline -1 origin/main
      git branch -r --contains HEAD    # fresh build: must list origin/main
      git status
      npm test
      bash scripts/check-test-count.sh

- Fresh build: if `git branch -r --contains HEAD` does not list `origin/main`, your
  base does not exist on the canonical remote. **STOP.** Do not build, do not push, do
  not "fix" it by merging or rebasing. Report the exact sha and wait for PM
  authorization to reset to `origin/main`.
- Resumed build: `git merge-base HEAD origin/main` must print a sha (shared history),
  and `git log --oneline origin/main..HEAD` must show only your own build commits. If
  either fails, STOP and report.

## Branch and push rules

- Branch naming: `codex/<spec-id>` (e.g. `codex/spec3-a3`), created from the freshly
  fetched base: `git switch -c codex/<spec-id> origin/main`.
- Never commit to `main`. Never push `main`. Never force-push anything. Direct pushes
  of `main` are additionally blocked machine-side and repo-side; do not attempt to
  work around either block.
- Hand off by pushing ONLY your current `codex/<spec-id>` branch (draft PR to `main`
  when instructed), and only after the ritual above has proven its base canonical.
  This repo is PUBLIC — a pushed ref is published. Never push a ref whose lineage you
  have not verified against `origin/main`.
- Do not add, remove, or re-point git remotes.
- The PM merges after Gate-A review. Agents never merge to `main`.

## Repo hygiene — hard rules

- `docs/*` is deliberately untracked (see `.gitignore`). Never `git add` anything under
  it; never weaken that ignore rule. Read those docs freely; commit them never.
- **Never run `git stash -u`** (or `--include-untracked`) in this repo. Untracked files
  here include material that must never enter git objects.
- CI pins the discovered-test count via `scripts/check-test-count.sh`. Any commit that
  adds or removes tests must bump the pin **in the same commit**.
- One build in flight at a time. If you find evidence of another in-flight build (an
  unexpected branch, a dirty worktree you didn't create), STOP and report.

## Standing product locks

- **Never modify `lib/earnings.js`** or the instant-credit flow unless the BUILD-SPEC
  names them explicitly. The earnings flow is locked.
- **No platform-side per-item inference.** Semantic work routes to the client's own
  LLM; the sole platform-side exception is the safety screen. Never add a new model
  subprocessor.
- **Never invent product promises.** Every user-facing promise must already exist in
  canonical sources (public site copy, ToS/Privacy, README); if you cannot find it,
  stop and return the question.

## Build discipline

- The BUILD-SPEC decides architecture. If a decision is not in the spec, return the
  question — do not improvise.
- If a test cannot pass because of a spec defect (not a code defect), flag it — do not
  delete or weaken the test.
- Scope is the spec. No opportunistic refactors, dependency bumps, or drive-by fixes.

## Source discipline — MANDATORY

Every technical assertion in your plan, commit messages, and delivery report must be
backed by a code read. No plausible-sounding inference.

- Before claiming a test passes, run it by exact filename and cite the file path and
  pass count from that run — never match an aggregate count to a spec number.
- Before claiming a field/route/behavior exists, open the file and cite the line, or
  grep and cite the match.
- If a claim is unverified, say "I have not verified this" — do not hedge and move on.

## Delivery report contract

One row per spec item:

| Spec/Rework item | File:line that implements it | Verification command you ran | Result |

- Every row cites a real file:line and a concrete command (`node --test
  test/<file>.test.js`, `grep -n "…" file.js`, `curl …`, `read file.js:100-120`).
  "Reviewed manually" is rejected.
- If a verification first failed and then passed, cite both runs — do not silently
  retry until green.
- Unimplemented items are marked ❌ with a one-sentence reason — never omitted.
- The reviewer spot-checks rows by re-running them; any failed spot-check rejects the
  entire delivery.

## Escalation

- Blocking ambiguity → return the question. A decision the spec didn't anticipate →
  return it to Tyler. Never improvise on either.
- Anything touching payments, wallets, keys, published packages, or deployment requires
  explicit spec instruction; absent that, STOP.
