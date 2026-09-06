#!/usr/bin/env bash
# ─── predeploy-check.sh — OPS-1 launch-blocker guard ─────────────────────────
#
# BLOCKS a deploy that would ship legal docs still containing `[[...]]`
# fill-blanks (e.g. the ToS "Last Updated: [[DEPLOY-DATE]]" and the
# "[[LEGAL-ENTITY ...]]" operating-entity placeholder), and asserts the ToS
# "Current Amendment" id string matches the server's CURRENT_TOS_VERSION so a
# published version can never orphan (Gate-B Condition B).
#
# Exit non-zero (fail the build) if any served legal doc still contains `[[`,
# or if the two version strings cannot both be found / do not match.
#
# Usage:   bash scripts/predeploy-check.sh
# Wired as a BLOCKING CI job — see .github/workflows/ci.yml (job: predeploy-guard).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

# Resolve repo root from this script's location so it runs from anywhere
# (CI checkout, local shell, or a git hook) without depending on CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# Served legal docs to scan. Keep this list in sync with the server's
# serveLegalPage() routes (server.js) — every user-served legal doc belongs here.
LEGAL_DOCS=(
  "docs/TERMS-OF-SERVICE.md"
  "docs/PRIVACY-POLICY.md"
  "docs/DMCA-POLICY.md"
  "docs/SUBPROCESSORS.md"
  "docs/SUPPORTED-CLIENTS.md"
)

FAILED=0

echo "── predeploy-check: scanning served legal docs for [[ fill-blanks ──"

for doc in "${LEGAL_DOCS[@]}"; do
  if [ ! -f "${doc}" ]; then
    # A missing optional served doc is not a hard failure, but surface it.
    echo "  ⚠️  skip (not found): ${doc}"
    continue
  fi
  # grep -n for the LITERAL string `[[` (-F fixed-string; no regex escaping).
  # Every offending file:line is printed so the fix is copy-paste locatable.
  matches="$(grep -Fno '[[' "${doc}" || true)"
  if [ -n "${matches}" ]; then
    FAILED=1
    echo "  ❌ ${doc} — unresolved [[ fill-blank(s):"
    # Prefix each hit with the filename so output is grep-friendly (file:line).
    while IFS= read -r line; do
      echo "       ${doc}:${line}"
    done <<< "${matches}"
  else
    echo "  ✅ ${doc} — no [[ markers"
  fi
done

echo ""
echo "── predeploy-check: ToS amendment id vs server CURRENT_TOS_VERSION ──"

TOS_FILE="docs/TERMS-OF-SERVICE.md"
ACCOUNTS_FILE="lib/accounts.js"

# Server-side source of truth: CURRENT_TOS_VERSION = '<id>' in lib/accounts.js.
SERVER_VERSION="$(grep -Eo "CURRENT_TOS_VERSION[[:space:]]*=[[:space:]]*['\"][^'\"]+['\"]" "${ACCOUNTS_FILE}" 2>/dev/null \
  | grep -Eo "['\"][^'\"]+['\"]$" | tr -d "\"'" || true)"

# Doc-side: the "Current Amendment: `<id>`" backtick-quoted id in the ToS header.
TOS_VERSION="$(grep -Eo "Current Amendment: \`[^\`]+\`" "${TOS_FILE}" 2>/dev/null \
  | head -n1 | sed -E 's/.*`([^`]+)`.*/\1/' || true)"

if [ -z "${SERVER_VERSION}" ]; then
  echo "  ❌ could not read CURRENT_TOS_VERSION from ${ACCOUNTS_FILE}"
  FAILED=1
fi
if [ -z "${TOS_VERSION}" ]; then
  echo "  ❌ could not read \"Current Amendment\" id from ${TOS_FILE}"
  FAILED=1
fi

if [ -n "${SERVER_VERSION}" ] && [ -n "${TOS_VERSION}" ]; then
  echo "  server CURRENT_TOS_VERSION : ${SERVER_VERSION}"
  echo "  ToS Current Amendment id   : ${TOS_VERSION}"
  if [ "${SERVER_VERSION}" = "${TOS_VERSION}" ]; then
    echo "  ✅ versions match — no orphan risk"
  else
    echo "  ❌ VERSION MISMATCH — publishing would orphan the ToS version (Gate-B Condition B)"
    FAILED=1
  fi
fi

echo ""
echo "── predeploy-check: internal doc links resolve to a live route ──"
# FB-1 root cause: the ToS incorporates the DMCA policy "into these Terms" and links
# /dmca, but the serving route was missing — a clickwrapped contract linking to a 404.
# Every internal absolute-path markdown link ](/path) in a served legal doc MUST have a
# matching app.get('/path' ...) route in server.js.
SERVER_FILE="server.js"
LINK_FAILED=0
for doc in "${LEGAL_DOCS[@]}"; do
  [ -f "${doc}" ] || continue
  # Extract internal absolute-path link targets (skip #anchors, mailto:, http(s)://).
  links="$(grep -Eo '\]\(/[a-zA-Z0-9/_-]+' "${doc}" 2>/dev/null | sed -E 's/^\]\(//' | sort -u || true)"
  while IFS= read -r link; do
    [ -z "${link}" ] && continue
    if ! grep -Fq "app.get('${link}'" "${SERVER_FILE}" 2>/dev/null; then
      echo "  ❌ ${doc} links ${link} but no app.get('${link}' ...) route exists in ${SERVER_FILE}"
      FAILED=1
      LINK_FAILED=1
    fi
  done <<< "${links}"
done
[ "${LINK_FAILED}" -eq 0 ] && echo "  ✅ all internal legal-doc links resolve to a route"

echo ""
echo "── predeploy-check: machine-surface drift guard ──"
# Tool enumerations on every public surface must exactly match mcp-server.js,
# openapi.json paths must match canonical prefixes, and the four version
# strings must agree. See scripts/check-surface-drift.sh for the full contract.
if bash "${SCRIPT_DIR}/check-surface-drift.sh"; then
  echo "  ✅ machine surfaces agree"
else
  FAILED=1
  echo "  ❌ machine-surface drift detected (see output above)"
fi

echo ""
echo "── predeploy-check: asset cache-bust (?v= hashes current) ──"
# ASSET-CACHE-BUST: styles.css is served with an immutable one-year
# cache-control (its dedicated route in server.js); the two ?v=-referenced
# dashboard scripts use the generic one-hour static handler and ride the same
# scheme for consistency. A styles.css change that doesn't also bump the ?v=
# value ships silently — returning visitors keep the stale bytes for up to a year. scripts/asset-versions.js
# --check compares every ?v= reference in tracked public/ HTML against its
# asset's current sha256 content hash and exits 1 on any mismatch.
if node "${SCRIPT_DIR}/asset-versions.js" --check; then
  echo "  ✅ all ?v= references match their asset's current content hash"
else
  FAILED=1
  echo "  ❌ stale asset ?v= reference(s) detected (see output above) — run: node scripts/asset-versions.js --write"
fi

echo ""
if [ "${FAILED}" -ne 0 ]; then
  echo "🛑 predeploy-check FAILED — do NOT deploy. Resolve the items above first."
  exit 1
fi

echo "✅ predeploy-check PASSED — no [[ fill-blanks, ToS version in sync, surfaces agree, asset hashes current."
exit 0
