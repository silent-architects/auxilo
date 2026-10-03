'use strict';

/**
 * test/launch-wave-bot-surfaces.test.js — guards for the BOT-xx register
 * (REGISTER-BOT-FINAL.md) applied to `.well-known/agent.json` and
 * `public/llms.txt` in the site-launch-0926 wave.
 *
 * Covers:
 *   1. agent.json naming: the card names itself a marketplace exactly once,
 *      in the ratified sentence, with no other bare "marketplace" in the
 *      top-level description.
 *   2. agent.json authentication shape guard: `authentication.methods` is an
 *      array of exactly two objects (x402, api_key_credits), each carrying a
 *      `header`; the old flat `authentication.method` key is gone. This is a
 *      regression guard — nothing else in the suite catches a revert to the
 *      single-method shape.
 *   3. agent.json money-language guard: no skill or endpoint description
 *      reads as settled payment ("goes to the contributor", "Earn 70% of
 *      revenue", "70% to contributor").
 *   4. llms.txt accrual + categories guard: none of the retired universal-
 *      quantifier phrases remain; the BOT-06 sentence appears exactly once;
 *      the BOT-09 two-bullet wallet-only rule, BOT-10, and BOT-15 lines are
 *      present.
 *   5. Dash guard: none of the strings this unit placed contain an em dash
 *      or en dash.
 *
 * Every absence check below carries a positive control proving the
 * detector actually matches when the target text is present.
 *
 * Runner: node --test test/launch-wave-bot-surfaces.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');

let agent;
let agentRaw;
let llmsTxt;
let openapi;

before(() => {
  agentRaw = fs.readFileSync(path.join(REPO, '.well-known', 'agent.json'), 'utf8');
  agent = JSON.parse(agentRaw);
  llmsTxt = fs.readFileSync(path.join(REPO, 'public', 'llms.txt'), 'utf8');
  openapi = JSON.parse(fs.readFileSync(path.join(REPO, 'openapi.json'), 'utf8'));
});

// ─── Dash detector, shared by every section below ──────────────────────────

const DASH_RE = /[–—]/; // en dash, em dash

describe('BOT surfaces: dash detector self-test (positive control)', () => {
  it('catches an em dash and an en dash in a synthetic string', () => {
    assert.ok(DASH_RE.test('a—b'), 'detector must catch an em dash');
    assert.ok(DASH_RE.test('a–b'), 'detector must catch an en dash');
    assert.ok(!DASH_RE.test('a-b, a normal hyphen'), 'detector must not false-positive on a hyphen');
  });
});

// ─── 1 & 3: agent.json naming + money-language guards ──────────────────────

describe('BOT-01: agent.json top-level description naming', () => {
  it('contains the ratified marketplace sentence', () => {
    assert.ok(
      agent.description.includes('Auxilo is a marketplace for what agents learn.'),
      'description must contain the ratified sentence verbatim'
    );
  });

  it('has no bare "marketplace" outside the ratified sentence, "the Auxilo marketplace", or "Auxilo marketplace" (positive control included)', () => {
    function bareMarketplaceCount(text) {
      const stripped = text
        .split('Auxilo is a marketplace for what agents learn.').join('')
        .replace(/the Auxilo marketplace/gi, '')
        .replace(/Auxilo marketplace/gi, '');
      return (stripped.match(/\bmarketplace\b/gi) || []).length;
    }
    // Positive control: the detector must still catch a bare use.
    assert.equal(
      bareMarketplaceCount('This is a marketplace for everyone.'),
      1,
      'positive control: detector must catch an unqualified marketplace claim'
    );
    assert.equal(
      bareMarketplaceCount(agent.description),
      0,
      'agent.json top-level description must carry no bare "marketplace" beyond the ratified forms'
    );
  });

  it('does not have the old two-bare-marketplace opening', () => {
    assert.ok(
      !agent.description.includes('Agent Capability Discovery and Knowledge Marketplace'),
      'the retired title-case pseudo-heading must be gone'
    );
  });
});

// ─── D1: openapi.json info.description matches the agent card, carries the
// disclaimer + paused-rail statement once each, and states the rate basis
// without the old double-70%/60% opening ────────────────────────────────────

describe('D1: openapi.json info.description equals the agent card description', () => {
  it("openapi.json's info.description is byte-for-byte equal to agent.json's description", () => {
    assert.equal(
      openapi.info.description,
      agent.description,
      'openapi.json info.description must equal the agent card description exactly -- they are the same served text'
    );
  });

  it('contains "not guaranteed" exactly once', () => {
    const matches = openapi.info.description.match(/not guaranteed/g) || [];
    assert.equal(matches.length, 1, 'info.description must state "not guaranteed" exactly once');
  });

  it('contains "Withdrawals open soon" exactly once', () => {
    const matches = openapi.info.description.match(/Withdrawals open soon/g) || [];
    assert.equal(matches.length, 1, 'info.description must state "Withdrawals open soon" exactly once');
  });

  it('the word "marketplace" appears only inside "Auxilo is a marketplace for what agents learn" (positive control included)', () => {
    function bareMarketplaceCount(text) {
      const stripped = text.split('Auxilo is a marketplace for what agents learn').join('');
      return (stripped.match(/\bmarketplace\b/gi) || []).length;
    }
    // Positive control: the detector must still catch a bare use.
    assert.equal(
      bareMarketplaceCount('This is a marketplace for everyone.'),
      1,
      'positive control: detector must catch an unqualified marketplace claim'
    );
    assert.equal(
      bareMarketplaceCount(openapi.info.description),
      0,
      'info.description must carry no "marketplace" outside the ratified opening sentence'
    );
  });

  it('does not have the old two-bare-marketplace opening ("Agent Capability Discovery and Knowledge Marketplace")', () => {
    assert.ok(
      !openapi.info.description.includes('Agent Capability Discovery and Knowledge Marketplace'),
      'the retired title-case pseudo-heading must be gone from openapi.json'
    );
  });
});

describe('Register P (P-05): agent.json top-level description carries the disclaimer + paused-rail statement once', () => {
  const NOT_GUARANTEED = 'Earnings depend on whether other agents unlock the builder\'s learnings and are not guaranteed.';

  it('contains "not guaranteed" exactly once', () => {
    const matches = agent.description.match(/not guaranteed/g) || [];
    assert.equal(matches.length, 1, 'description must state "not guaranteed" exactly once');
  });

  it('contains "Withdrawals open soon" exactly once', () => {
    const matches = agent.description.match(/Withdrawals open soon/g) || [];
    assert.equal(matches.length, 1, 'description must state "Withdrawals open soon" exactly once');
  });

  it('does not end with the not-guaranteed sentence (the paused-rail statement follows it)', () => {
    assert.equal(
      agent.description.trim().endsWith(NOT_GUARANTEED),
      false,
      'the disclaimer must not be the last sentence of the description'
    );
  });
});

describe('BOT-02: agent.json authentication shape guard (regression guard)', () => {
  it('authentication.methods is an array of exactly two objects', () => {
    assert.ok(agent.authentication, 'authentication object must exist');
    assert.ok(Array.isArray(agent.authentication.methods), 'authentication.methods must be an array');
    assert.equal(agent.authentication.methods.length, 2, 'authentication.methods must have exactly two entries');
  });

  it('the two methods are x402 and api_key_credits, each with a header', () => {
    const ids = agent.authentication.methods.map((m) => m.id).sort();
    assert.deepStrictEqual(ids, ['api_key_credits', 'x402'], 'method ids must be exactly x402 and api_key_credits');
    for (const m of agent.authentication.methods) {
      assert.ok(m.header, `method ${m.id} must carry a header`);
    }
    const x402 = agent.authentication.methods.find((m) => m.id === 'x402');
    assert.equal(x402.header, 'X-Payment');
    assert.equal(x402.account_required, false);
    // Carried-over x402 fields must survive unchanged.
    assert.equal(x402.network, 'eip155:8453');
    assert.equal(x402.asset, 'USDC');
    assert.equal(x402.asset_contract, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    assert.equal(x402.facilitator, 'https://facilitator.openx402.ai');
    assert.equal(x402.protocol_spec, 'https://www.x402.org');

    const credits = agent.authentication.methods.find((m) => m.id === 'api_key_credits');
    assert.equal(credits.header, 'X-API-Key');
    assert.equal(credits.account_required, true);
    assert.ok(credits.signup, 'api_key_credits must carry a signup field');
  });

  it('the old flat authentication.method key is absent', () => {
    assert.equal(agent.authentication.method, undefined, 'flat authentication.method must be removed');
  });
});

describe('BOT-03/04/04b: agent.json money-language guard (positive controls included)', () => {
  function collectDescriptions() {
    const out = [];
    for (const s of agent.skills) out.push(['skills.' + s.id, s.description]);
    for (const e of agent.endpoints.free) out.push(['endpoints.free ' + e.method + ' ' + e.path, e.description]);
    for (const e of agent.endpoints.paid) out.push(['endpoints.paid ' + e.method + ' ' + e.path, e.description]);
    return out;
  }

  const BANNED = ['goes to the contributor', 'Earn 70% of revenue', '70% to contributor'];

  it('detector catches each banned phrase in a synthetic string (positive control)', () => {
    for (const phrase of BANNED) {
      const synthetic = `Money ${phrase} today.`;
      assert.ok(synthetic.includes(phrase), `positive control: detector must find "${phrase}"`);
    }
  });

  it('no skill or endpoint description contains a banned settled-payment phrase', () => {
    const descriptions = collectDescriptions();
    for (const phrase of BANNED) {
      for (const [where, text] of descriptions) {
        assert.ok(!text.includes(phrase), `${where} must not contain "${phrase}" (found: ${text})`);
      }
    }
  });

  it('knowledge-unlock uses "earns" (tied to the unlock event), not "goes to" (credits-as-cash C-78 unifies the rate sentence on "earns")', () => {
    const skill = agent.skills.find((s) => s.id === 'knowledge-unlock');
    assert.ok(!/\bgoes to\b/.test(skill.description), 'must not use "goes to"');
    assert.ok(/\bearns\b/.test(skill.description), 'must use an accrual-safe verb, never a settled-payment claim');
  });

  it('knowledge-contribute does not carry an unconditioned "earn 70%" rate', () => {
    const skill = agent.skills.find((s) => s.id === 'knowledge-contribute');
    assert.ok(!/\bearn 70%/i.test(skill.description), 'must not carry an unconditioned rate');
  });
});

describe('BOT-05: agent.json autonomous-extraction required substrings survive (re-check)', () => {
  it('still contains extract, auxilo-autonomous-extractor, retraction, and consent tag', () => {
    const skill = agent.skills.find((s) => s.id === 'autonomous-extraction');
    assert.ok(skill.description.includes('extract'));
    assert.ok(skill.description.includes('auxilo-autonomous-extractor'));
    assert.ok(skill.description.includes('retraction'));
    assert.ok(skill.tags.includes('consent'));
  });
});

// ─── 4: llms.txt accrual + categories guard ────────────────────────────────

describe('BOT-06/07: llms.txt accrual guard (positive controls included)', () => {
  const RETIRED = ['every direct unlock', 'every discovery-driven unlock'];

  it('detector catches each retired universal phrase in a synthetic string (positive control)', () => {
    for (const phrase of RETIRED) {
      assert.ok(`text with ${phrase} inside`.includes(phrase), `positive control for "${phrase}"`);
    }
  });

  it('llms.txt contains none of the retired universal-quantifier phrases', () => {
    for (const phrase of RETIRED) {
      assert.ok(!llmsTxt.includes(phrase), `llms.txt must not contain "${phrase}"`);
    }
  });

  it('llms.txt contains the credits-as-cash C-65 sentence exactly once', () => {
    const sentence = "The builder behind a learning earns 70% of its listed price when another agent unlocks it, or 60% when Auxilo search surfaced it.";
    const count = llmsTxt.split(sentence).length - 1;
    assert.equal(count, 1, 'C-65 sentence must appear exactly once');
  });

  it('llms.txt Builder split line uses the conditioned accrual form (credits-as-cash C-68)', () => {
    assert.ok(
      llmsTxt.includes('Builder split: the builder behind a learning earns 70% of its listed price when another agent unlocks it, or 60% when Auxilo search surfaced it.'),
      'C-68 line must be present verbatim'
    );
  });
});

describe('Register P (P-06): llms.txt Pricing section carries the disclaimer exactly once, directly after the Builder split line', () => {
  const DISCLAIMER = 'Earnings depend on whether other agents unlock your learnings and are not guaranteed.';
  const BUILDER_SPLIT = '- Builder split: the builder behind a learning earns 70% of its listed price when another agent unlocks it, or 60% when Auxilo search surfaced it.';
  const ACCRUE_LINE = '- Earnings accrue to your Auxilo account now and remain payable to you under the Terms.';

  it('contains the disclaimer exactly once', () => {
    const count = llmsTxt.split(DISCLAIMER).length - 1;
    assert.equal(count, 1, 'llms.txt must carry the disclaimer exactly once');
  });

  it('the new disclaimer line sits directly after the Builder split line and before the accrue line', () => {
    const iSplit = llmsTxt.indexOf(BUILDER_SPLIT);
    const iDisclaimer = llmsTxt.indexOf('- ' + DISCLAIMER);
    const iAccrue = llmsTxt.indexOf(ACCRUE_LINE);
    assert.ok(iSplit > -1 && iDisclaimer > -1 && iAccrue > -1, 'all three anchor lines must be present');
    assert.ok(iSplit < iDisclaimer, 'disclaimer line must follow the Builder split line');
    assert.ok(iDisclaimer < iAccrue, 'disclaimer line must precede the accrue line');
    const between = llmsTxt.slice(iSplit + BUILDER_SPLIT.length, iDisclaimer).trim();
    assert.equal(between, '', 'the disclaimer line must sit directly after the Builder split line with no other bullet between them');
  });
});

describe('BOT-08/09/10/15/16: llms.txt content guards', () => {
  it('contains the BOT-08 categories-scope clarification', () => {
    assert.ok(
      llmsTxt.includes('- GET /categories: list capability categories (free). POST /learn uses the six learning categories under Catalog scope, not these.'),
      'BOT-08 line must be present verbatim'
    );
  });

  it('contains the BOT-10 relevance line', () => {
    assert.ok(
      llmsTxt.includes('- The `relevance` number ranks results against each other. It is not a confidence score and has no fixed top.'),
      'BOT-10 line must be present verbatim'
    );
  });

  it('contains the BOT-15 quality-fields line, directly after BOT-10', () => {
    const bot10 = '- The `relevance` number ranks results against each other. It is not a confidence score and has no fixed top.';
    const bot15 = '- `value_signal.quality_score` runs from 0 to 1 and is the quality signal. `quality.score` is a ranking number, not a quality rating.';
    assert.ok(llmsTxt.includes(bot15), 'BOT-15 line must be present verbatim');
    const idx10 = llmsTxt.indexOf(bot10);
    const idx15 = llmsTxt.indexOf(bot15);
    assert.ok(idx10 !== -1 && idx15 !== -1 && idx15 > idx10, 'BOT-15 must come after BOT-10');
    const between = llmsTxt.slice(idx10 + bot10.length, idx15).trim();
    assert.equal(between, '', 'BOT-15 must sit directly after BOT-10 with no other bullet between them');
  });

  it('contains the credits-as-cash C-67 credit-pack clarification', () => {
    assert.ok(
      llmsTxt.includes('- Credit packs add $10 (Starter), $25 (Growth) or $100 (Pro) to a balance that pays listed prices and never expires.'),
      'C-67 line must be present verbatim'
    );
  });

  it('does not contain the retired ordinal "account\'s first public learning" (positive control included)', () => {
    const phrase = "account's first public learning";
    assert.ok(`a new ${phrase} always waits`.includes(phrase), 'positive control for the ordinal phrase');
    assert.ok(!llmsTxt.includes(phrase), 'llms.txt must not contain the retired ordinal phrase');
  });

  it('contains both BOT-09 bullets: account-trust rule and wallet-only rule', () => {
    assert.ok(
      llmsTxt.includes("- A public submission waits for Auxilo's review until the account is cleared to publish."),
      'BOT-09 first bullet must be present verbatim'
    );
    assert.ok(
      llmsTxt.includes("- A submission from a wallet with no account is held every time. Linking that wallet to an account moves its held submissions into that account's review queue."),
      'BOT-09 second bullet must be present verbatim'
    );
  });
});

// ─── 5: dash guard over every string this unit placed ──────────────────────

describe('Dash guard: no em dash or en dash in any BOT-xx string placed by this unit', () => {
  const PLACED_STRINGS = [
    // agent.json
    agent && agent.description,
    agent && agent.authentication && agent.authentication.description,
    agent && agent.authentication && agent.authentication.methods && agent.authentication.methods[0] && agent.authentication.methods[0].label,
    agent && agent.authentication && agent.authentication.methods && agent.authentication.methods[1] && agent.authentication.methods[1].label,
    agent && agent.authentication && agent.authentication.methods && agent.authentication.methods[1] && agent.authentication.methods[1].signup,
    agent && agent.skills && agent.skills.find((s) => s.id === 'knowledge-contribute') && agent.skills.find((s) => s.id === 'knowledge-contribute').description,
    agent && agent.skills && agent.skills.find((s) => s.id === 'knowledge-unlock') && agent.skills.find((s) => s.id === 'knowledge-unlock').description,
    agent && agent.skills && agent.skills.find((s) => s.id === 'autonomous-extraction') && agent.skills.find((s) => s.id === 'autonomous-extraction').description,
    agent && agent.endpoints && agent.endpoints.paid && agent.endpoints.paid.find((e) => e.path === '/knowledge/{id}') && agent.endpoints.paid.find((e) => e.path === '/knowledge/{id}').description,
    // llms.txt lines
    "The builder behind the contributing agent earns 70% of what the buyer paid on a direct unlock and 60% when Auxilo search surfaced it.",
    "Builder split: when another agent unlocks a learning, the builder accrues 70% of what that buyer paid, or 60% when Auxilo search surfaced it.",
    "- Credit packs: $10 (Starter), $25 (Growth), $100 (Pro). Credits never expire. One credit unlocks one learning, whatever its listed price.",
    "- GET /categories: list capability categories (free). POST /learn uses the six learning categories under Catalog scope, not these.",
    "- The `relevance` number ranks results against each other. It is not a confidence score and has no fixed top.",
    "- `value_signal.quality_score` runs from 0 to 1 and is the quality signal. `quality.score` is a ranking number, not a quality rating.",
    "- A public submission waits for Auxilo's review until the account is cleared to publish.",
    "- A submission from a wallet with no account is held every time. Linking that wallet to an account moves its held submissions into that account's review queue.",
  ];

  it('none of the placed strings contain an em dash or en dash', () => {
    for (const s of PLACED_STRINGS) {
      assert.ok(typeof s === 'string' && s.length > 0, 'each placed string must have resolved (author error if not)');
      assert.ok(!DASH_RE.test(s), `must contain no em/en dash: ${s}`);
    }
  });
});

// ─── Cross-check: p2-1a-agent-json.test.js's pinned fields are untouched ───

describe('Untouched-surface guard (this unit must not have moved these)', () => {
  it('name, version, url, spec_version are unchanged', () => {
    assert.equal(agent.name, 'Auxilo');
    assert.equal(agent.version, '0.9.28');
    assert.equal(agent.url, 'https://auxilo.io');
    assert.equal(agent.spec_version, 'a2a/0.1');
  });

  it('skills[].id set and mcp.tools are unchanged', () => {
    const ids = agent.skills.map((s) => s.id).sort();
    assert.deepStrictEqual(ids, [
      'autonomous-extraction',
      'contributor-dashboard',
      'discover',
      'knowledge-contribute',
      'knowledge-search',
      'knowledge-unlock',
      'rate-learning',
    ].sort());
    assert.equal(agent.mcp.tools.length, 17);
  });

  it('endpoints entry set (method+path pairs) is unchanged', () => {
    const freePaths = agent.endpoints.free.map((e) => e.method + ' ' + e.path).sort();
    const paidPaths = agent.endpoints.paid.map((e) => e.method + ' ' + e.path).sort();
    assert.deepStrictEqual(freePaths, [
      'GET /',
      'GET /.well-known/agent.json',
      'GET /categories',
      'GET /contributor/{wallet}',
      'GET /health',
      'GET /knowledge/stats',
      'GET /openapi.json',
      'GET /skill/{id}',
      'GET /stats',
      'POST /discover',
      'POST /knowledge',
      'POST /knowledge/{id}/rate',
      'POST /learn',
    ].sort());
    assert.deepStrictEqual(paidPaths, [
      'DELETE /learn/{id}',
      'GET /knowledge/{id}',
      'POST /extract',
      'POST /extract/consent',
    ].sort());
  });
});
