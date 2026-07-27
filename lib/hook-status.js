'use strict';

/**
 * True when a Claude Code SessionEnd collection contains an Auxilo extraction
 * hook. Accepts both the legacy bare-command string and the current matcher
 * group shape ({ hooks: [{ type: 'command', command }] }).
 *
 * @param {unknown} sessionEnd
 * @returns {boolean}
 */
function hasAuxiloSessionEndHook(sessionEnd) {
  if (!Array.isArray(sessionEnd)) return false;

  return sessionEnd.some((entry) => {
    if (typeof entry === 'string') return entry.includes('auxilo-extract');
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) return false;
    return entry.hooks.some((hook) =>
      hook && typeof hook === 'object' &&
      typeof hook.command === 'string' &&
      hook.command.includes('auxilo-extract'));
  });
}

module.exports = { hasAuxiloSessionEndHook };
