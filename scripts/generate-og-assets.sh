#!/usr/bin/env bash
# ─── generate-og-assets.sh — render PNG brand assets from their SVG sources ──
#
# Renders:
#   public/og-image.svg     -> public/og-image.png     (1200x630, social card)
#   public/logo-square.svg  -> public/logo-square.png  (512x512, Organization logo)
#
# Requires librsvg (brew install librsvg). Font note: the SVGs specify
# Inter (headline/wordmark) and JetBrains Mono (proof line) with Helvetica
# and Menlo fallbacks. Install the brand fonts locally before rendering for
# pixel-exact type; without them rsvg falls back to the system faces, which
# are close but not identical.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

command -v rsvg-convert >/dev/null 2>&1 || { echo "rsvg-convert not found (brew install librsvg)"; exit 1; }

rsvg-convert -w 1200 -h 630 public/og-image.svg -o public/og-image.png
rsvg-convert -w 512 -h 512 public/logo-square.svg -o public/logo-square.png

echo "rendered: public/og-image.png (1200x630), public/logo-square.png (512x512)"
