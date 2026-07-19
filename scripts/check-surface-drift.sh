#!/usr/bin/env bash
# ─── check-surface-drift.sh: machine-surface coherence guard ─────────────────
#
# BLOCKS a deploy if:
#   (1) any public tool enumeration (public/llms.txt, .well-known/agent.json,
#       public/for-agents.html, public/api.html) does not EXACTLY match the
#       tool list programmatically enumerated from mcp-server.js
#       (ListToolsRequestSchema). Any surplus tool (named on a public surface
#       but not registered) or missing tool (registered but not named on a
#       public surface) fails the build. Pure set comparison against one
#       source of truth. No stale name needs to be hardcoded here.
#   (2) openapi.json documents a path with no canonical-prefix match (i.e. a
#       route not backed by the registered tool surface or the known
#       non-tool routes).
#   (3) the version string (mcp-server.js server info, package.json,
#       openapi.json info.version, .well-known/agent.json version) is not
#       byte-identical across all four.
#
# Usage:   bash scripts/check-surface-drift.sh
# Wired as a blocking step of scripts/predeploy-check.sh (same pattern as the
# legal-doc fill-blank guard), which CI runs as the predeploy-guard job.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

FAILED=0

echo "── check-surface-drift: canonical tool set (source of truth: mcp-server.js) ──"
TOOLS_BLOCK="$(awk '/server\.setRequestHandler\(ListToolsRequestSchema/,/server\.setRequestHandler\(CallToolRequestSchema/' mcp-server.js)"
CANONICAL_TOOLS="$(echo "${TOOLS_BLOCK}" | grep -Eo "name: '[a-z_]+'" | sed -E "s/name: '([a-z_]+)'/\1/" | sort -u)"
CANONICAL_COUNT="$(echo "${CANONICAL_TOOLS}" | grep -c .)"
echo "  canonical tool count: ${CANONICAL_COUNT}"
echo "${CANONICAL_TOOLS}" | sed 's/^/    - /'

compare_set() {
  local label="$1"
  local listed="$2"
  local missing extra
  missing="$(comm -23 <(echo "${CANONICAL_TOOLS}" | sort -u) <(echo "${listed}" | sort -u))"
  extra="$(comm -13 <(echo "${CANONICAL_TOOLS}" | sort -u) <(echo "${listed}" | sort -u))"
  if [ -n "${missing}" ] || [ -n "${extra}" ]; then
    FAILED=1
    echo "  ❌ ${label} - set mismatch:"
    [ -n "${missing}" ] && echo "${missing}" | sed 's/^/       missing: /'
    [ -n "${extra}"   ] && echo "${extra}"   | sed 's/^/       surplus: /'
  else
    echo "  ✅ ${label} - exact match"
  fi
}

LLMS_TOOLS="$(grep -Eo '^- (auxilo_[a-z_]+|get_[a-z_]+):' public/llms.txt | sed -E 's/^- ([a-z_]+):.*/\1/')"
compare_set "public/llms.txt" "${LLMS_TOOLS}"

FOR_AGENTS_TOOLS="$(grep -Eo '<span class="tool-tag">[a-z_]+</span>' public/for-agents.html | sed -E 's#.*>([a-z_]+)<.*#\1#')"
compare_set "public/for-agents.html" "${FOR_AGENTS_TOOLS}"

API_TOOLS="$(grep -Eo '<span class="mcp-tool-name">[a-z_]+</span>' public/api.html | sed -E 's#.*>([a-z_]+)<.*#\1#')"
compare_set "public/api.html" "${API_TOOLS}"

AGENT_JSON_TOOLS="$(node -e "console.log(JSON.parse(require('fs').readFileSync('.well-known/agent.json','utf8')).mcp.tools.join('\n'))" 2>/dev/null || true)"
compare_set ".well-known/agent.json" "${AGENT_JSON_TOOLS}"

echo ""
echo "── check-surface-drift: openapi.json paths vs canonical prefixes ──"
node -e "
const fs = require('fs');
const spec = JSON.parse(fs.readFileSync('openapi.json', 'utf8'));
const paths = Object.keys(spec.paths || {});
const ALLOWED = ['/','/discover','/skill','/categories','/stats','/learn','/knowledge','/wallet','/withdraw','/contributor','/account','/health','/openapi.json','/.well-known','/terms','/privacy','/admin','/checkout','/webhook','/extract','/openclaw','/auth','/report','/status'];
const orphan = paths.filter(p => !ALLOWED.some(a => p === a || p.startsWith(a + '/')));
if (orphan.length) {
  console.log('  ❌ openapi.json has ' + orphan.length + ' path(s) matching no canonical prefix:');
  orphan.forEach(p => console.log('       ' + p));
  process.exitCode = 1;
} else {
  console.log('  ✅ openapi.json - every path matches a canonical prefix');
}
" || FAILED=1

echo ""
echo "── check-surface-drift: version string consistency ──"
PKG_VERSION="$(node -e "console.log(require('./package.json').version)" 2>/dev/null || true)"
SERVER_VERSION="$(grep -Eo "name: 'auxilo', version: '[^']+'" mcp-server.js | grep -Eo "'[^']+'" | tail -1 | tr -d "'" || true)"
OPENAPI_VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync('openapi.json','utf8')).info.version)" 2>/dev/null || true)"
AGENT_VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync('.well-known/agent.json','utf8')).version)" 2>/dev/null || true)"
echo "  package.json:           ${PKG_VERSION:-MISSING}"
echo "  mcp-server.js:          ${SERVER_VERSION:-MISSING}"
echo "  openapi.json:           ${OPENAPI_VERSION:-MISSING}"
echo "  .well-known/agent.json: ${AGENT_VERSION:-MISSING}"
if [ -z "${PKG_VERSION}" ] || [ "${PKG_VERSION}" != "${SERVER_VERSION}" ] || [ "${PKG_VERSION}" != "${OPENAPI_VERSION}" ] || [ "${PKG_VERSION}" != "${AGENT_VERSION}" ]; then
  FAILED=1
  echo "  ❌ VERSION MISMATCH across surfaces"
else
  echo "  ✅ all four versions match"
fi

echo ""
if [ "${FAILED}" -ne 0 ]; then
  echo "🛑 check-surface-drift FAILED - do NOT deploy. Resolve the items above first."
  exit 1
fi
echo "✅ check-surface-drift PASSED - tool surfaces, API paths, and versions agree."
exit 0
