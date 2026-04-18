> ⚠️ **SUPERSEDED** — This early build spec has been completed. Current specifications are in `specs/` directory. Kept for historical reference.

# Auxilo v0.2.0 Build Spec — Knowledge Marketplace

## CRITICAL: Read Before Changing Anything

This is an **additive build**. Auxilo v0.1.0 is live in production on a Conway Cloud VM. Every existing endpoint, MCP tool, and payment flow must continue working exactly as-is after this build.

### DO NOT modify these existing components:
- The `x402Gate()` function (lines 25-84 of server.js) — working in production
- The `matchSkills()` function (lines 87-130) — used by /discover
- The existing 6 HTTP routes: `GET /`, `GET /health`, `GET /categories`, `GET /stats`, `POST /discover`, `GET /skill/:id`
- The existing 4 MCP tools: `auxilo_discover`, `auxilo_skill`, `auxilo_categories`, `auxilo_stats`
- The skills.json file — do not touch
- The WALLET, USDC_BASE, FACILITATOR constants
- The server startup/listen block (but you'll add startup logic BEFORE it)

### You MAY make these small modifications to existing code:
- Update `VERSION` from `'0.1.0'` to `'0.2.0'`
- Add new entries to the `endpoints` object in the `GET /` handler
- Add a `knowledge_hint` field to the `POST /discover` response JSON
- Update the MCP server version from `'0.1.0'` to `'0.2.0'`

---

## What You're Building

A knowledge marketplace layer where agents submit operational learnings (tips, shortcuts, trial-and-error results), other agents pay to unlock them, and contributors earn revenue share.

### The User Flow

```
1. CONTRIBUTE (free): Agent submits a learning → stored in data/learnings.json
2. SEARCH (free): Agent searches → gets titles, snippets, quality scores (no full body)
3. UNLOCK ($0.005): Agent pays to read full learning → contributor earns 70% ($0.0035)
4. RATE (free): Agent rates helpfulness 1-5 → updates quality ranking
```

---

## Architecture

### Current file structure (DO NOT DELETE ANY OF THESE):
```
auxilo/
├── package.json         ← bump version only
├── server.js            ← add new routes and utilities AFTER existing code sections
├── mcp-server.js        ← add new tools to existing arrays
├── skills.json          ← DO NOT TOUCH
└── node_modules/
```

### After build:
```
auxilo/
├── package.json         ← v0.2.0
├── server.js            ← expanded with knowledge marketplace routes
├── mcp-server.js        ← expanded with 5 new MCP tools
├── skills.json          ← unchanged
├── seed-knowledge.json  ← NEW: initial learnings to bootstrap marketplace
├── openapi.json         ← NEW: OpenAPI 3.0 spec for all endpoints
├── data/                ← NEW: persistent storage directory
│   ├── learnings.json   ← created on first startup
│   ├── ratings.jsonl    ← created on first rating
│   └── earnings.json    ← created on first unlock
└── node_modules/
```

---

## Detailed Implementation

### server.js Changes

#### 1. Add after line 22 (after `const queryLog = ...`): Data directory + persistence

```js
// ─── Persistent Storage ─────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const LEARNINGS_FILE = path.join(DATA_DIR, 'learnings.json');
const RATINGS_FILE = path.join(DATA_DIR, 'ratings.jsonl');
const EARNINGS_FILE = path.join(DATA_DIR, 'earnings.json');

let learnings = [];
try {
  learnings = JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf8'));
} catch { learnings = []; }

let earnings = {};
try {
  earnings = JSON.parse(fs.readFileSync(EARNINGS_FILE, 'utf8'));
} catch { earnings = {}; }

// On first startup, seed from seed-knowledge.json if learnings is empty
if (learnings.length === 0) {
  try {
    const seedFile = path.join(__dirname, 'seed-knowledge.json');
    if (fs.existsSync(seedFile)) {
      learnings = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
      safeWrite(LEARNINGS_FILE, learnings);
      console.log(`Seeded ${learnings.length} initial learnings`);
    }
  } catch (e) {
    console.error('Failed to load seed knowledge:', e.message);
  }
}

function safeWrite(filepath, data) {
  const tmp = filepath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filepath);
}

function generateId() {
  return 'lrn_' + Math.random().toString(36).substring(2, 10);
}
```

#### 2. Add after the existing `matchSkills()` function: Knowledge search + scoring

```js
// ─── Knowledge Search/Match Engine ──────────────────────────────────
function computeScore(learning) {
  const q = learning.quality;
  const ageDays = (Date.now() - new Date(learning.created_at).getTime()) / 86400000;
  const unlockSignal = Math.min((q.unlocks || 0) * 2, 40);
  const helpScores = q.helpfulness_scores || [];
  const avgHelp = helpScores.length > 0
    ? helpScores.reduce((a, b) => a + b, 0) / helpScores.length
    : 2.5;
  const helpSignal = avgHelp * 8;
  const ratingVolume = Math.min((q.ratings || 0), 20);
  const recencyPenalty = Math.min(ageDays * 0.05, 10);
  return unlockSignal + helpSignal + ratingVolume - recencyPenalty;
}

function matchLearnings(query, filters = {}) {
  const q = query.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(t => t.length > 1);

  let results = learnings.map(learning => {
    let textScore = 0;
    const searchable = [
      learning.title,
      learning.body,
      ...learning.tags,
      learning.category,
      learning.task_context
    ].join(' ').toLowerCase();

    if (searchable.includes(q)) textScore += 10;
    for (const token of tokens) {
      if (learning.title.toLowerCase().includes(token)) textScore += 5;
      if (learning.body.toLowerCase().includes(token)) textScore += 3;
      if (learning.tags.some(t => t.toLowerCase().includes(token))) textScore += 4;
      if (learning.task_context.toLowerCase().includes(token)) textScore += 3;
    }

    const qualityScore = computeScore(learning);
    return { ...learning, _score: (textScore * 10) + qualityScore, _textScore: textScore };
  });

  if (filters.category) results = results.filter(r => r.category === filters.category);
  if (filters.outcome) results = results.filter(r => r.outcome === filters.outcome);
  if (filters.related_skill) results = results.filter(r =>
    r.related_skills && r.related_skills.includes(filters.related_skill)
  );

  return results
    .filter(r => r._textScore > 0)
    .sort((a, b) => b._score - a._score)
    .map(({ _score, _textScore, body, ...rest }) => ({
      ...rest,
      relevance: _score
      // NOTE: body is intentionally excluded — agents must unlock to read it
    }));
}
```

#### 3. Add AFTER the existing paid endpoints section (after line 245): New knowledge routes

```js
// ─── Knowledge Marketplace Endpoints ────────────────────────────────

// Submit a learning (FREE — encourages contributions)
app.post('/learn', async (c) => {
  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { title, body: content, category, tags, task_context, outcome,
          contributor_wallet, contributor_agent, related_skills } = body;

  // Validation
  if (!title || title.length < 10) return c.json({ error: 'Title must be at least 10 characters' }, 400);
  if (!content || content.length < 50) return c.json({ error: 'Body must be at least 50 characters' }, 400);
  if (!category) return c.json({ error: 'Category is required' }, 400);
  if (!tags || !Array.isArray(tags) || tags.length === 0) return c.json({ error: 'At least one tag required' }, 400);
  if (!task_context) return c.json({ error: 'task_context is required' }, 400);
  if (!outcome || !['success', 'partial', 'failure', 'workaround'].includes(outcome)) {
    return c.json({ error: 'outcome must be success, partial, failure, or workaround' }, 400);
  }
  if (!contributor_wallet || !contributor_wallet.startsWith('0x')) {
    return c.json({ error: 'Valid contributor_wallet (0x...) required for revenue sharing' }, 400);
  }

  const learning = {
    id: generateId(),
    title,
    snippet: content.substring(0, 120) + (content.length > 120 ? '...' : ''),
    body: content,
    category,
    tags,
    task_context,
    outcome,
    contributor_wallet,
    contributor_agent: contributor_agent || 'unknown',
    related_skills: related_skills || [],
    quality: { unlocks: 0, ratings: 0, avg_helpfulness: 0, helpfulness_scores: [], score: 0 },
    earnings: { gross_usd: 0, contributor_share_usd: 0, platform_share_usd: 0 },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  learnings.push(learning);
  safeWrite(LEARNINGS_FILE, learnings);

  return c.json({
    id: learning.id,
    message: 'Learning submitted successfully',
    contributor_wallet: learning.contributor_wallet,
    timestamp: new Date().toISOString()
  }, 201);
});

// Search knowledge (FREE — returns snippets, no full body)
app.post('/knowledge', async (c) => {
  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body. Expected: { "query": "what you need help with" }' }, 400);
  }

  const { query, category, outcome, related_skill, limit = 5 } = body;
  if (!query || typeof query !== 'string') {
    return c.json({ error: 'Missing or invalid "query" field' }, 400);
  }

  const results = matchLearnings(query, { category, outcome, related_skill })
    .slice(0, Math.min(limit, 15));

  // Track usage
  results.forEach(r => {
    const idx = learnings.findIndex(l => l.id === r.id);
    if (idx !== -1) learnings[idx].quality.unlocks = (learnings[idx].quality.unlocks || 0);
    // Note: this tracks search appearances, not unlocks — unlocks happen at GET /knowledge/:id
  });

  return c.json({
    query,
    results_count: results.length,
    results: results.map(r => ({
      id: r.id,
      title: r.title,
      snippet: r.snippet,
      category: r.category,
      task_context: r.task_context,
      outcome: r.outcome,
      tags: r.tags,
      quality: { score: computeScore(r), unlocks: r.quality.unlocks, ratings: r.quality.ratings, avg_helpfulness: r.quality.avg_helpfulness },
      relevance: r.relevance
    })),
    unlock_price: '$0.005 USDC per learning via GET /knowledge/:id',
    timestamp: new Date().toISOString()
  });
});

// Unlock full learning (PAID $0.005 — this is where revenue is generated)
app.get('/knowledge/:id', x402Gate(0.005, 'Unlock full learning content. 70% goes to the contributor.'), (c) => {
  const id = c.req.param('id');
  const idx = learnings.findIndex(l => l.id === id);

  if (idx === -1) return c.json({ error: 'Learning not found', id }, 404);

  const learning = learnings[idx];
  const UNLOCK_PRICE = 0.005;
  const CONTRIBUTOR_SHARE = 0.7;

  // Track unlock
  learning.quality.unlocks = (learning.quality.unlocks || 0) + 1;

  // Track earnings
  const contributorEarned = UNLOCK_PRICE * CONTRIBUTOR_SHARE;
  const platformEarned = UNLOCK_PRICE * (1 - CONTRIBUTOR_SHARE);

  learning.earnings.gross_usd = (learning.earnings.gross_usd || 0) + UNLOCK_PRICE;
  learning.earnings.contributor_share_usd = (learning.earnings.contributor_share_usd || 0) + contributorEarned;
  learning.earnings.platform_share_usd = (learning.earnings.platform_share_usd || 0) + platformEarned;

  // Update contributor ledger
  const wallet = learning.contributor_wallet;
  if (!earnings[wallet]) {
    earnings[wallet] = { total_gross: 0, total_contributor: 0, total_platform: 0, by_learning: {}, last_updated: null };
  }
  earnings[wallet].total_gross += UNLOCK_PRICE;
  earnings[wallet].total_contributor += contributorEarned;
  earnings[wallet].total_platform += platformEarned;
  if (!earnings[wallet].by_learning[id]) {
    earnings[wallet].by_learning[id] = { gross: 0, contributor: 0, platform: 0, unlocks: 0 };
  }
  earnings[wallet].by_learning[id].gross += UNLOCK_PRICE;
  earnings[wallet].by_learning[id].contributor += contributorEarned;
  earnings[wallet].by_learning[id].platform += platformEarned;
  earnings[wallet].by_learning[id].unlocks += 1;
  earnings[wallet].last_updated = new Date().toISOString();

  // Persist
  safeWrite(LEARNINGS_FILE, learnings);
  safeWrite(EARNINGS_FILE, earnings);

  return c.json({
    ...learning,
    _revenue: {
      unlock_price_usd: UNLOCK_PRICE,
      contributor_earned_usd: contributorEarned,
      platform_earned_usd: platformEarned
    },
    timestamp: new Date().toISOString()
  });
});

// Rate a learning (FREE — quality signal)
app.post('/knowledge/:id/rate', async (c) => {
  const id = c.req.param('id');
  const idx = learnings.findIndex(l => l.id === id);

  if (idx === -1) return c.json({ error: 'Learning not found', id }, 404);

  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { helpfulness, notes } = body;
  if (!helpfulness || helpfulness < 1 || helpfulness > 5) {
    return c.json({ error: 'helpfulness must be 1-5' }, 400);
  }

  const learning = learnings[idx];
  learning.quality.ratings = (learning.quality.ratings || 0) + 1;
  learning.quality.helpfulness_scores = learning.quality.helpfulness_scores || [];
  learning.quality.helpfulness_scores.push(helpfulness);
  learning.quality.avg_helpfulness = learning.quality.helpfulness_scores.reduce((a, b) => a + b, 0) / learning.quality.helpfulness_scores.length;
  learning.updated_at = new Date().toISOString();

  safeWrite(LEARNINGS_FILE, learnings);

  // Append to ratings log
  const ratingEntry = { learning_id: id, helpfulness, notes: notes || null, timestamp: new Date().toISOString() };
  fs.appendFileSync(RATINGS_FILE, JSON.stringify(ratingEntry) + '\n');

  return c.json({
    recorded: true,
    learning_id: id,
    new_avg_helpfulness: learning.quality.avg_helpfulness,
    total_ratings: learning.quality.ratings
  });
});

// Knowledge marketplace stats (FREE)
app.get('/knowledge/stats', (c) => {
  const totalEarnings = Object.values(earnings).reduce((sum, w) => sum + w.total_gross, 0);
  const totalContributors = Object.keys(earnings).length;

  return c.json({
    learnings_count: learnings.length,
    categories: [...new Set(learnings.map(l => l.category))],
    total_unlocks: learnings.reduce((sum, l) => sum + (l.quality.unlocks || 0), 0),
    total_ratings: learnings.reduce((sum, l) => sum + (l.quality.ratings || 0), 0),
    total_earnings_usd: totalEarnings,
    total_contributors: totalContributors,
    top_learnings: learnings
      .map(l => ({ id: l.id, title: l.title, score: computeScore(l), unlocks: l.quality.unlocks || 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5),
    timestamp: new Date().toISOString()
  });
});

// Contributor earnings dashboard (FREE)
app.get('/contributor/:wallet', (c) => {
  const wallet = c.req.param('wallet');
  const data = earnings[wallet];

  if (!data) {
    return c.json({
      wallet,
      message: 'No earnings found for this wallet',
      total_contributor_usd: 0,
      learnings_submitted: learnings.filter(l => l.contributor_wallet === wallet).length
    });
  }

  return c.json({
    wallet,
    total_gross_usd: data.total_gross,
    total_contributor_usd: data.total_contributor,
    total_platform_usd: data.total_platform,
    by_learning: data.by_learning,
    learnings_submitted: learnings.filter(l => l.contributor_wallet === wallet).length,
    last_updated: data.last_updated
  });
});
```

#### 4. Small modifications to existing code

**Update VERSION (line 11):**
```js
const VERSION = '0.2.0';
```

**Add to the endpoints object in `GET /` handler (inside the existing endpoints object):**
```js
'/learn': { price: 'free', method: 'POST', description: 'Submit operational knowledge. Body: { title, body, category, tags, task_context, outcome, contributor_wallet }' },
'/knowledge': { price: 'free', method: 'POST', description: 'Search knowledge. Returns snippets. Body: { "query": "what you need" }' },
'/knowledge/:id': { price: '$0.005', method: 'GET', description: 'Unlock full learning. 70% goes to contributor.' },
'/knowledge/:id/rate': { price: 'free', method: 'POST', description: 'Rate a learning 1-5 after using it.' },
'/knowledge/stats': { price: 'free', method: 'GET', description: 'Knowledge marketplace statistics' },
'/contributor/:wallet': { price: 'free', method: 'GET', description: 'Contributor earnings dashboard' },
```

**Add to the /discover response (inside the return c.json block, after `timestamp`):**
```js
knowledge_hint: learnings.length > 0
  ? `Auxilo also has ${learnings.length} operational learnings from other agents. Try POST /knowledge to find tips before using these tools.`
  : null,
```

---

### mcp-server.js Changes

#### Add 5 new tools to the `tools` array (after the existing 4 tools):

```js
{
  name: 'auxilo_contribute',
  description: 'Submit operational knowledge to the Auxilo marketplace. Share what you learned from trial-and-error so other agents benefit. Free to submit — you earn 70% revenue when others unlock your knowledge.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Concise title (min 10 chars)' },
      body: { type: 'string', description: 'Detailed explanation — what you tried, what worked, what failed (min 50 chars)' },
      category: { type: 'string', enum: ['data-processing','web-interaction','code-execution','communication','storage-state','content-generation','payment-financial','monitoring'] },
      tags: { type: 'array', items: { type: 'string' }, description: 'Relevant keywords' },
      task_context: { type: 'string', description: 'What task were you performing?' },
      outcome: { type: 'string', enum: ['success','partial','failure','workaround'] },
      contributor_wallet: { type: 'string', description: 'Your Base wallet (0x...) for revenue share' },
      contributor_agent: { type: 'string', description: 'Optional: identify yourself' },
      related_skills: { type: 'array', items: { type: 'string' }, description: 'Optional: related Auxilo skill IDs' },
    },
    required: ['title', 'body', 'category', 'tags', 'task_context', 'outcome', 'contributor_wallet'],
  },
},
{
  name: 'auxilo_knowledge',
  description: 'Search for operational knowledge from other agents. Find tips and shortcuts BEFORE attempting a task. Returns ranked snippets — unlock full content with auxilo_unlock. Free — no cost to search.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What you need help with' },
      category: { type: 'string', enum: ['data-processing','web-interaction','code-execution','communication','storage-state','content-generation','payment-financial','monitoring'] },
      outcome: { type: 'string', enum: ['success','partial','failure','workaround'] },
      related_skill: { type: 'string', description: 'Filter by Auxilo skill ID' },
      limit: { type: 'number', description: 'Max results (default 5, max 15)' },
      x_payment: { type: 'string', description: 'x402 payment header' },
    },
    required: ['query'],
  },
},
{
  name: 'auxilo_unlock',
  description: 'Unlock full learning content by ID. Costs $0.005 USDC — 70% goes to the contributor who shared this knowledge.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Learning ID (e.g. "lrn_a1b2c3d4")' },
      x_payment: { type: 'string', description: 'x402 payment header' },
    },
    required: ['id'],
  },
},
{
  name: 'auxilo_rate',
  description: 'Rate a learning after using it. Free — your rating helps other agents find the best knowledge. Higher-rated learnings rank higher in search.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Learning ID to rate' },
      helpfulness: { type: 'number', description: 'Rating 1-5 (1=useless, 5=saved massive effort)' },
      notes: { type: 'string', description: 'Optional: brief note on how it helped' },
    },
    required: ['id', 'helpfulness'],
  },
},
{
  name: 'auxilo_contributor',
  description: 'Check earnings for a contributor wallet. Shows total earned, per-learning breakdown. Free.',
  inputSchema: {
    type: 'object',
    properties: {
      wallet: { type: 'string', description: 'Contributor wallet address (0x...)' },
    },
    required: ['wallet'],
  },
},
```

#### Add 5 new cases to the switch statement (after `case 'auxilo_stats':`):

```js
case 'auxilo_contribute': {
  const resp = await fetch(`${AUXILO_BASE}/learn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: args.title,
      body: args.body,
      category: args.category,
      tags: args.tags,
      task_context: args.task_context,
      outcome: args.outcome,
      contributor_wallet: args.contributor_wallet,
      contributor_agent: args.contributor_agent,
      related_skills: args.related_skills,
    }),
  });
  return text(await resp.json());
}

case 'auxilo_knowledge': {
  const headers = { 'Content-Type': 'application/json' };
  if (args.x_payment) headers['X-Payment'] = args.x_payment;

  const body = { query: args.query };
  if (args.category) body.category = args.category;
  if (args.outcome) body.outcome = args.outcome;
  if (args.related_skill) body.related_skill = args.related_skill;
  if (args.limit) body.limit = args.limit;

  const resp = await fetch(`${AUXILO_BASE}/knowledge`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const data = await resp.json();
  return text(data);
}

case 'auxilo_unlock': {
  const headers = {};
  if (args.x_payment) headers['X-Payment'] = args.x_payment;

  const resp = await fetch(`${AUXILO_BASE}/knowledge/${args.id}`, { headers });
  const data = await resp.json();
  if (resp.status === 402) {
    return text({ status: 'payment_required', cost: '$0.005 USDC on Base', http_endpoint: `${AUXILO_BASE}/knowledge/${args.id}`, payment_details: data });
  }
  return text(data);
}

case 'auxilo_rate': {
  const resp = await fetch(`${AUXILO_BASE}/knowledge/${args.id}/rate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ helpfulness: args.helpfulness, notes: args.notes }),
  });
  return text(await resp.json());
}

case 'auxilo_contributor': {
  const resp = await fetch(`${AUXILO_BASE}/contributor/${args.wallet}`);
  return text(await resp.json());
}
```

---

### New Files to Create

#### `seed-knowledge.json`
Create 20-30 learning objects using the data model above. Source from real operational experience with:
- Tool quirks (Firecrawl, E2B, Conway API, x402 payment flows)
- MCP debugging patterns
- Hono framework tips
- Conway VM deployment gotchas
- JSON persistence patterns on minimal VMs

Use platform wallet `0x1BE960313c93b3aA0AA62BF33B300CAB48c36Ca6` as `contributor_wallet` for all seeds. All quality scores start at zero.

#### `openapi.json`
Generate an OpenAPI 3.0 spec describing ALL endpoints (existing + new). Include:
- x402 payment headers as security scheme
- Request/response schemas for every endpoint
- Serve at `GET /openapi.json` (free endpoint, add to server.js)

#### `.well-known/agent.json` (A2A agent card)
Create a Google A2A-compatible agent card. Serve at `GET /.well-known/agent.json` (free endpoint). Include:
- Agent name, description, capabilities
- Endpoint URLs
- Authentication method (x402)
- Supported protocols (HTTP, MCP)

---

### package.json
Only change: bump version to `0.2.0`. No new dependencies.

---

## Regression Checklist

After the build, ALL of these must still work:

- [ ] `GET /` returns service info with all endpoints listed
- [ ] `GET /health` returns status ok
- [ ] `GET /categories` returns skill category counts
- [ ] `GET /stats` returns registry stats
- [ ] `POST /discover` without X-Payment returns 402 challenge
- [ ] `POST /discover` with valid payment returns skill results
- [ ] `GET /skill/:id` without payment returns 402
- [ ] `GET /skill/:id` with payment returns full skill
- [ ] MCP tool `auxilo_discover` works
- [ ] MCP tool `auxilo_skill` works
- [ ] MCP tool `auxilo_categories` works
- [ ] MCP tool `auxilo_stats` works
- [ ] skills.json is loaded correctly on startup
- [ ] Server starts on port 3000
- [ ] x402 payment verification against facilitator.openx402.ai works

## New Feature Checklist

- [ ] `POST /learn` accepts and persists a learning
- [ ] `POST /knowledge` returns snippets (no full body) with x402 gate
- [ ] `GET /knowledge/:id` returns full learning with x402 gate, tracks earnings
- [ ] `POST /knowledge/:id/rate` updates quality scores
- [ ] `GET /knowledge/stats` returns marketplace stats
- [ ] `GET /contributor/:wallet` returns earnings
- [ ] `GET /openapi.json` returns valid OpenAPI 3.0 spec
- [ ] `GET /.well-known/agent.json` returns valid A2A agent card
- [ ] data/ directory created on startup
- [ ] learnings persist across server restarts
- [ ] earnings persist across server restarts
- [ ] ratings append to JSONL file
- [ ] Seed knowledge loads on first startup
- [ ] `/discover` response includes knowledge_hint
- [ ] MCP tools: auxilo_contribute, auxilo_knowledge, auxilo_unlock, auxilo_rate, auxilo_contributor all work

## Deployment

After local testing passes:
1. Copy updated files to Conway VM (sandbox ID: `725fa3fea775ba39db5a2e3703fa4557`)
2. Restart the server on the VM
3. Verify live endpoint: `https://3000-725fa3fea775ba39db5a2e3703fa4557.life.conway.tech/`
4. Verify `/knowledge/stats` returns on live
5. Update Claude Desktop MCP config if mcp-server.js path changed (it shouldn't)
