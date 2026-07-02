/**
 * lib/injection-screen.js — LW-13 (implements LW-3 design (b))
 *
 * Prompt-injection pattern screening for learning submissions.
 * Pattern approach mirrors lib/sensitivity-filter.js.
 *
 * FLAG, DON'T BLOCK: a flagged submission is not rejected — it lands in the
 * moderation queue with `injection_flags` attached as a reviewer signal.
 * False-positive risk is high (legitimate learnings discuss prompts), so this
 * is advisory for human review and a hard gate ONLY for the auto-approve
 * valve (MODERATION_AUTO_APPROVE).
 *
 * Fail-closed (SF-M1 convention): use screenLearningSafe() in request paths —
 * if screening throws, the submission is treated as flagged.
 */

'use strict';

const INJECTION_SCREEN_VERSION = '0.1.0';

// Each pattern: id, regex, description. Regexes are intentionally broad —
// flagging is cheap (queue review), missing is expensive (payload served to
// buyer agents as trusted content).
const INJECTION_PATTERNS = [
  {
    id: 'instruction_override',
    regex: /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(previous|prior|above|earlier|your)\s+(instructions?|prompts?|rules|directives|context|system\s+prompt)/gi,
    description: 'Instruction-override phrasing ("ignore previous instructions")',
  },
  {
    id: 'role_hijack',
    regex: /\b(you\s+are\s+now\s+(a|an|the|in)\b|new\s+system\s+prompt\s*:|act\s+as\s+if\s+you\s+have\s+no\s+(restrictions|rules|guidelines)|pretend\s+(you\s+are|to\s+be)\s+(an?\s+)?(unrestricted|jailbroken|developer\s+mode))/gi,
    description: 'Role-hijack phrasing ("you are now...", "new system prompt:")',
  },
  {
    id: 'exfiltration_lure',
    regex: /\b(send|post|forward|transmit|upload|email|exfiltrate|reveal|output|paste)\b[^.\n]{0,60}\b(api[\s_-]?keys?|credentials?|secrets?|passwords?|tokens?|private\s+keys?|\.?env(\s+(file|vars?|variables?))?|environment\s+variables?)\b/gi,
    description: 'Credential-exfiltration lure ("post your API key/env to ...")',
  },
  {
    id: 'tool_abuse_lure',
    regex: /\b(run|execute|eval)\s+(the\s+following|this)\s+(command|code|script|shell|bash)\b|\bimmediately\s+(run|execute)\b|\bcurl\s+[^\s]+\s*\|\s*(ba)?sh\b/gi,
    description: 'Tool-abuse lure ("run the following command immediately")',
  },
  {
    id: 'markup_smuggling',
    regex: /<\/?\s*(system|assistant|human)\s*>|\[\/?INST\]|<\|im_(start|end)\|>|"(tool_use|function_call|tool_calls)"\s*:/gi,
    description: 'Conversation/markup smuggling (<system>, [INST], fake tool-call JSON)',
  },
];

const EXCERPT_RADIUS = 40;

/**
 * Screen contributor-authored free-text fields for injection patterns.
 * @param {{title?:string, body?:string, task_context?:string}} learning
 * @returns {{flagged: boolean, matches: Array<{pattern_id:string, field:string, excerpt:string}>}}
 */
function screenLearning(learning = {}) {
  const fields = {
    title: learning.title || '',
    body: learning.body || '',
    task_context: learning.task_context || '',
  };
  const matches = [];
  for (const [field, text] of Object.entries(fields)) {
    if (!text || typeof text !== 'string') continue;
    for (const pattern of INJECTION_PATTERNS) {
      pattern.regex.lastIndex = 0;
      const m = pattern.regex.exec(text);
      if (m) {
        const start = Math.max(0, m.index - EXCERPT_RADIUS);
        const end = Math.min(text.length, m.index + m[0].length + EXCERPT_RADIUS);
        matches.push({
          pattern_id: pattern.id,
          field,
          excerpt: text.slice(start, end),
        });
      }
    }
  }
  return { flagged: matches.length > 0, matches };
}

/**
 * Fail-closed wrapper: a screening error is treated as flagged so a broken
 * screen never silently waves submissions through the auto-approve valve.
 */
function screenLearningSafe(learning) {
  try {
    return screenLearning(learning);
  } catch (err) {
    console.error('[INJECTION-SCREEN] Screen threw — treating as flagged:', err && err.message);
    return {
      flagged: true,
      matches: [{ pattern_id: 'screen_error', field: 'n/a', excerpt: String(err && err.message).slice(0, 120) }],
    };
  }
}

module.exports = {
  screenLearning,
  screenLearningSafe,
  INJECTION_PATTERNS,
  INJECTION_SCREEN_VERSION,
};
