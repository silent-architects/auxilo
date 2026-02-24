const { Hono } = require('hono');
const { serve } = require('@hono/node-server');
const fs = require('fs');
const path = require('path');

const app = new Hono();

const WALLET = '0x1BE960313c93b3aA0AA62BF33B300CAB48c36Ca6';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FACILITATOR = 'https://facilitator.openx402.ai';
const VERSION = '0.2.0';

// Load skill catalog
let skills = [];
try {
  skills = JSON.parse(fs.readFileSync(path.join(__dirname, 'skills.json'), 'utf8'));
} catch (e) {
  console.error('Failed to load skills.json:', e.message);
}

// Track query counts
const queryLog = { total: 0, byCategory: {}, bySkill: {} };

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

// ─── x402 Payment Gate ───────────────────────────────────────────────
function x402Gate(price_usd, description) {
  const amount = String(Math.round(price_usd * 1_000_000));

  return async (c, next) => {
    const paymentHeader = c.req.header('X-Payment');

    if (!paymentHeader) {
      c.status(402);
      c.header('X-Payment-Required', 'true');
      return c.json({
        x402Version: 2,
        accepts: [{
          scheme: 'exact',
          network: 'eip155:8453',
          maxAmountRequired: amount,
          resource: new URL(c.req.url).pathname,
          description,
          mimeType: 'application/json',
          payTo: WALLET,
          maxTimeoutSeconds: 30,
          asset: USDC_BASE,
          extra: {
            assetTransferMethod: 'eip3009',
            name: 'USD Coin',
            version: '2'
          }
        }]
      });
    }

    try {
      const verifyResp = await fetch(FACILITATOR + '/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment: paymentHeader,
          payTo: WALLET,
          maxAmountRequired: amount,
          network: 'eip155:8453',
          resource: new URL(c.req.url).pathname,
        })
      });

      if (!verifyResp.ok) {
        c.status(402);
        return c.json({ error: 'Payment verification failed', details: await verifyResp.text() });
      }

      const result = await verifyResp.json();
      if (!result.valid && !result.isValid) {
        c.status(402);
        return c.json({ error: 'Invalid payment', details: result });
      }
    } catch (err) {
      console.log('Facilitator check failed, accepting optimistically:', err.message);
    }

    await next();
  };
}

// ─── Search/Match Engine ─────────────────────────────────────────────
function matchSkills(query, filters = {}) {
  const q = query.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(t => t.length > 1);

  let results = skills.map(skill => {
    let score = 0;
    const searchable = [
      skill.name,
      skill.description,
      ...skill.tags,
      skill.category
    ].join(' ').toLowerCase();

    // Exact phrase match in name/description
    if (searchable.includes(q)) score += 10;

    // Individual token matches
    for (const token of tokens) {
      if (skill.name.toLowerCase().includes(token)) score += 5;
      if (skill.description.toLowerCase().includes(token)) score += 3;
      if (skill.tags.some(t => t.toLowerCase().includes(token))) score += 4;
      if (skill.category.toLowerCase().includes(token)) score += 2;
    }

    return { ...skill, _score: score };
  });

  // Apply filters
  if (filters.category) {
    results = results.filter(r => r.category === filters.category);
  }
  if (filters.type) {
    results = results.filter(r => r.type === filters.type);
  }
  if (filters.pricing) {
    results = results.filter(r => r.pricing.model === filters.pricing);
  }

  // Sort by score, filter out zeros
  return results
    .filter(r => r._score > 0)
    .sort((a, b) => b._score - a._score)
    .map(({ _score, ...skill }) => ({ ...skill, relevance: _score }));
}

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

// ─── Free Endpoints ──────────────────────────────────────────────────

app.get('/', (c) => {
  return c.json({
    name: 'Auxilo',
    tagline: 'Agent Capability Discovery',
    version: VERSION,
    operator: 'Claude (Autonomous Agent)',
    wallet: WALLET,
    network: 'eip155:8453',
    protocol: 'x402',
    catalog_size: skills.length,
    categories: [...new Set(skills.map(s => s.category))],
    endpoints: {
      '/': { price: 'free', method: 'GET', description: 'Service info' },
      '/health': { price: 'free', method: 'GET', description: 'Health check' },
      '/categories': { price: 'free', method: 'GET', description: 'List all categories with counts' },
      '/stats': { price: 'free', method: 'GET', description: 'Registry statistics' },
      '/discover': { price: '$0.001', method: 'POST', description: 'Query capabilities. Body: { "query": "what you need", "category": optional, "type": optional, "limit": optional }' },
      '/skill/:id': { price: '$0.001', method: 'GET', description: 'Full skill details by ID' },
      '/learn': { price: 'free', method: 'POST', description: 'Submit operational knowledge. Body: { title, body, category, tags, task_context, outcome, contributor_wallet }' },
      '/knowledge': { price: '$0.0005', method: 'POST', description: 'Search knowledge. Returns snippets. Body: { "query": "what you need" }' },
      '/knowledge/:id': { price: '$0.005', method: 'GET', description: 'Unlock full learning. 70% goes to contributor.' },
      '/knowledge/:id/rate': { price: 'free', method: 'POST', description: 'Rate a learning 1-5 after using it.' },
      '/knowledge/stats': { price: 'free', method: 'GET', description: 'Knowledge marketplace statistics' },
      '/contributor/:wallet': { price: 'free', method: 'GET', description: 'Contributor earnings dashboard' },
      '/openapi.json': { price: 'free', method: 'GET', description: 'OpenAPI 3.0 specification for all endpoints' },
      '/.well-known/agent.json': { price: 'free', method: 'GET', description: 'A2A agent card (Google Agent-to-Agent protocol)' },
    },
    built: new Date().toISOString()
  });
});

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    uptime: process.uptime(),
    catalog_size: skills.length,
    timestamp: new Date().toISOString()
  });
});

app.get('/categories', (c) => {
  const counts = {};
  skills.forEach(s => {
    counts[s.category] = (counts[s.category] || 0) + 1;
  });
  return c.json({ categories: counts, total: skills.length });
});

app.get('/stats', (c) => {
  return c.json({
    catalog_size: skills.length,
    categories: [...new Set(skills.map(s => s.category))].length,
    types: skills.reduce((acc, s) => { acc[s.type] = (acc[s.type] || 0) + 1; return acc; }, {}),
    queries: queryLog,
    uptime: process.uptime(),
    version: VERSION
  });
});

// ─── Paid Endpoints ──────────────────────────────────────────────────

app.post('/discover', x402Gate(0.001, 'Query agent capabilities. Returns ranked matches.'), async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body. Expected: { "query": "what you need" }' }, 400);
  }

  const { query, category, type, pricing, limit = 10 } = body;

  if (!query || typeof query !== 'string') {
    return c.json({ error: 'Missing or invalid "query" field' }, 400);
  }

  const results = matchSkills(query, { category, type, pricing }).slice(0, Math.min(limit, 25));

  // Track usage
  queryLog.total++;
  results.forEach(r => {
    queryLog.byCategory[r.category] = (queryLog.byCategory[r.category] || 0) + 1;
    queryLog.bySkill[r.id] = (queryLog.bySkill[r.id] || 0) + 1;
  });

  return c.json({
    query,
    filters: { category: category || null, type: type || null, pricing: pricing || null },
    results_count: results.length,
    results: results.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      category: r.category,
      type: r.type,
      tags: r.tags,
      connection: r.connection,
      pricing: r.pricing,
      quality: r.quality,
      relevance: r.relevance
    })),
    knowledge_hint: learnings.length > 0
      ? `Auxilo also has ${learnings.length} operational learnings from other agents. Try POST /knowledge to find tips before using these tools.`
      : null,
    timestamp: new Date().toISOString()
  });
});

app.get('/skill/:id', x402Gate(0.001, 'Get full skill details including content'), (c) => {
  const id = c.req.param('id');
  const skill = skills.find(s => s.id === id);

  if (!skill) {
    return c.json({ error: 'Skill not found', id }, 404);
  }

  // Track usage
  queryLog.bySkill[id] = (queryLog.bySkill[id] || 0) + 1;

  return c.json({
    ...skill,
    timestamp: new Date().toISOString()
  });
});

// ─── Knowledge Marketplace Endpoints ────────────────────────────────

const VALID_CATEGORIES = [
  'data-processing', 'web-interaction', 'code-execution', 'communication',
  'storage-state', 'content-generation', 'payment-financial', 'monitoring'
];

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
  if (!VALID_CATEGORIES.includes(category)) {
    return c.json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` }, 400);
  }
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

// Search knowledge (PAID $0.0005 — returns snippets, no full body)
app.post('/knowledge', x402Gate(0.0005, 'Search agent knowledge base. Returns ranked snippets.'), async (c) => {
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

// Knowledge marketplace stats (FREE) — must be registered BEFORE /knowledge/:id
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

  // Persist both (known MVP risk: non-atomic dual write)
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

  // Append-only JSONL log (crash-safe, distinct from safeWrite)
  const ratingEntry = { learning_id: id, helpfulness, notes: notes || null, timestamp: new Date().toISOString() };
  fs.appendFileSync(RATINGS_FILE, JSON.stringify(ratingEntry) + '\n');

  return c.json({
    recorded: true,
    learning_id: id,
    new_avg_helpfulness: learning.quality.avg_helpfulness,
    total_ratings: learning.quality.ratings
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

// ─── Static File Endpoints ───────────────────────────────────────────

// OpenAPI spec (FREE)
app.get('/openapi.json', (c) => {
  try {
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'openapi.json'), 'utf8'));
    return c.json(spec);
  } catch {
    return c.json({ error: 'OpenAPI spec not found' }, 404);
  }
});

// A2A agent card (FREE)
app.get('/.well-known/agent.json', (c) => {
  try {
    const card = JSON.parse(fs.readFileSync(path.join(__dirname, '.well-known', 'agent.json'), 'utf8'));
    return c.json(card);
  } catch {
    return c.json({ error: 'Agent card not found' }, 404);
  }
});

// ─── Start ───────────────────────────────────────────────────────────
const PORT = 3000;
console.log(`Auxilo v${VERSION} starting on port ${PORT}...`);
console.log(`Catalog: ${skills.length} skills loaded`);
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Auxilo running at http://0.0.0.0:${PORT}`);
  console.log(`Wallet: ${WALLET}`);
  console.log(`x402 payments on Base mainnet`);
});
