/**
 * scripts/sources/roo-code.js — Roo Code (VS Code extension) Transcript Source (UC-3)
 *
 * Roo Code is a maintained fork of Cline and preserves its storage layout:
 *
 *   <vscode-user-dir>/globalStorage/<publisher>/tasks/<taskId>/
 *     api_conversation_history.json
 *
 * Publisher dirs probed (the extension id changed across releases):
 *   rooveterinaryinc.roo-cline   (original "Roo Cline" id, still used)
 *   rooveterinaryinc.roo-code    (post-rename id)
 *
 * Everything else — discovery, the Anthropic-messages format probe,
 * normalization, fail-silent refusal — is inherited from ClineSource.
 *
 * NOTE (2026-07-19): like cline.js, built from the documented fork layout;
 * no Roo Code installation existed on the build machine to verify against.
 * Strict probe + fail-silent (UC §5). Publicly labeled best-effort (UC-3).
 *
 * @module sources/roo-code
 */

'use strict';

const { ClineSource } = require('./cline');

class RooCodeSource extends ClineSource {
  static id = 'roo-code';
  static displayName = 'Roo Code (VS Code)';
  static version = '1.0.0';

  static publisherDirs = ['rooveterinaryinc.roo-cline', 'rooveterinaryinc.roo-code'];
}

module.exports = { RooCodeSource };
