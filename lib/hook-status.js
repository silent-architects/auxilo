'use strict';

/** Recognize only the generated node command under Auxilo's scripts directory. */
function isAuxiloNodeHook(command, script, source = null) {
  if (typeof command !== 'string') return false;
  const match = /^node "([^"\r\n]+)"(?: --source ([a-z0-9-]+))?$/.exec(command);
  if (!match) return false;
  const windows = process.platform === 'win32' || /^[a-z]:[\\/]/i.test(match[1]) || match[1].includes('\\');
  const target = windows ? match[1].replace(/\\/g, '/').toLowerCase() : match[1];
  if (!target.endsWith(`/.auxilo/bin/scripts/${script}`)) return false;
  return source === true ? Boolean(match[2]) : (match[2] || null) === source;
}

/**
 * True when a Claude Code SessionEnd collection contains an Auxilo extraction
 * hook. Accepts both the legacy bare-command string and the current matcher
 * group shape ({ hooks: [{ type: 'command', command }] }).
 *
 * @param {unknown} sessionEnd
 * @returns {boolean}
 */
function hasAuxiloSessionEndHook(sessionEnd) {
  const ours = command => command.includes('auxilo-extract') || isAuxiloNodeHook(command, 'capture-core.js', 'claude-code');
  if (!Array.isArray(sessionEnd)) return false;

  return sessionEnd.some((entry) => {
    if (typeof entry === 'string') return ours(entry);
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) return false;
    return entry.hooks.some((hook) =>
      hook && typeof hook === 'object' &&
      typeof hook.command === 'string' &&
      ours(hook.command));
  });
}

module.exports = { hasAuxiloSessionEndHook, isAuxiloNodeHook };
