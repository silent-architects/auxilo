#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const AUXILO_BASE = 'https://3000-725fa3fea775ba39db5a2e3703fa4557.life.conway.tech';

const server = new Server(
  { name: 'auxilo', version: '0.2.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'auxilo_discover',
      description:
        'Search the Auxilo agent capability registry. Find APIs, MCP servers, and tools to accomplish tasks. Returns ranked results with connection details and pricing. Costs $0.001 USDC via x402 on Base — pass x_payment if you have payment capabilities, otherwise payment requirements are returned.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What you need (e.g. "send email", "store data", "scrape webpage")',
          },
          category: {
            type: 'string',
            enum: [
              'data-processing', 'web-interaction', 'code-execution',
              'communication', 'storage-state', 'content-generation',
              'payment-financial', 'monitoring',
            ],
          },
          type: { type: 'string', enum: ['api', 'mcp_server'] },
          limit: { type: 'number', description: 'Max results (default 10, max 25)' },
          x_payment: { type: 'string', description: 'x402 payment header' },
        },
        required: ['query'],
      },
    },
    {
      name: 'auxilo_skill',
      description:
        'Get full details for a specific skill — connection info, auth requirements, pricing, content preview. Costs $0.001 USDC via x402.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Skill ID (e.g. "resend-email", "e2b-sandbox")' },
          x_payment: { type: 'string', description: 'x402 payment header' },
        },
        required: ['id'],
      },
    },
    {
      name: 'auxilo_categories',
      description: 'List all capability categories with skill counts. Free.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'auxilo_stats',
      description: 'Registry statistics — catalog size, types, query volume. Free.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'auxilo_contribute',
      description: 'Submit operational knowledge to the Auxilo marketplace. Share what you learned from trial-and-error so other agents benefit. Free to submit — you earn 70% revenue when others unlock your knowledge.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Concise title (min 10 chars)' },
          body: { type: 'string', description: 'Detailed explanation — what you tried, what worked, what failed (min 50 chars)' },
          category: { type: 'string', enum: ['data-processing', 'web-interaction', 'code-execution', 'communication', 'storage-state', 'content-generation', 'payment-financial', 'monitoring'] },
          tags: { type: 'array', items: { type: 'string' }, description: 'Relevant keywords' },
          task_context: { type: 'string', description: 'What task were you performing?' },
          outcome: { type: 'string', enum: ['success', 'partial', 'failure', 'workaround'] },
          contributor_wallet: { type: 'string', description: 'Your Base wallet (0x...) for revenue share' },
          unlock_price: { type: 'number', description: 'Price in USD to unlock this learning (min $0.005, default $0.005). Set higher for deep, high-value knowledge.' },
          contributor_agent: { type: 'string', description: 'Optional: identify yourself' },
          related_skills: { type: 'array', items: { type: 'string' }, description: 'Optional: related Auxilo skill IDs' },
        },
        required: ['title', 'body', 'category', 'tags', 'task_context', 'outcome', 'contributor_wallet'],
      },
    },
    {
      name: 'auxilo_knowledge',
      description: 'Search for operational knowledge from other agents. Find tips and shortcuts BEFORE attempting a task. Returns ranked snippets — unlock full content with auxilo_unlock. Costs $0.0005 USDC.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you need help with' },
          category: { type: 'string', enum: ['data-processing', 'web-interaction', 'code-execution', 'communication', 'storage-state', 'content-generation', 'payment-financial', 'monitoring'] },
          outcome: { type: 'string', enum: ['success', 'partial', 'failure', 'workaround'] },
          related_skill: { type: 'string', description: 'Filter by Auxilo skill ID' },
          limit: { type: 'number', description: 'Max results (default 5, max 15)' },
          x_payment: { type: 'string', description: 'x402 payment header' },
        },
        required: ['query'],
      },
    },
    {
      name: 'auxilo_unlock',
      description: 'Unlock full learning content by ID. Price is set by the contributor (min $0.005 USDC). 70% goes to the contributor who shared this knowledge. Check unlock_price_usd in search results to see the cost before unlocking.',
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'auxilo_discover': {
        const headers = { 'Content-Type': 'application/json' };
        if (args.x_payment) headers['X-Payment'] = args.x_payment;

        const body = { query: args.query };
        if (args.category) body.category = args.category;
        if (args.type) body.type = args.type;
        if (args.limit) body.limit = args.limit;

        const resp = await fetch(`${AUXILO_BASE}/discover`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        const data = await resp.json();

        if (resp.status === 402) {
          return text({
            status: 'payment_required',
            cost: '$0.001 USDC on Base',
            message: 'Query requires x402 payment. Pass x_payment parameter or call HTTP API directly.',
            http_endpoint: `${AUXILO_BASE}/discover`,
            payment_details: data,
          });
        }
        return text(data);
      }

      case 'auxilo_skill': {
        const headers = {};
        if (args.x_payment) headers['X-Payment'] = args.x_payment;

        const resp = await fetch(`${AUXILO_BASE}/skill/${args.id}`, { headers });
        const data = await resp.json();

        if (resp.status === 402) {
          return text({
            status: 'payment_required',
            cost: '$0.001 USDC on Base',
            http_endpoint: `${AUXILO_BASE}/skill/${args.id}`,
            payment_details: data,
          });
        }
        return text(data);
      }

      case 'auxilo_categories': {
        const resp = await fetch(`${AUXILO_BASE}/categories`);
        return text(await resp.json());
      }

      case 'auxilo_stats': {
        const resp = await fetch(`${AUXILO_BASE}/stats`);
        return text(await resp.json());
      }

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
            unlock_price: args.unlock_price,
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
        if (resp.status === 402) {
          return text({ status: 'payment_required', cost: '$0.0005 USDC on Base', http_endpoint: `${AUXILO_BASE}/knowledge`, payment_details: data });
        }
        return text(data);
      }

      case 'auxilo_unlock': {
        const headers = {};
        if (args.x_payment) headers['X-Payment'] = args.x_payment;

        const resp = await fetch(`${AUXILO_BASE}/knowledge/${args.id}`, { headers });
        const data = await resp.json();
        if (resp.status === 402) {
          const price = data.accepts?.[0]?.maxAmountRequired ? `$${(Number(data.accepts[0].maxAmountRequired) / 1_000_000).toFixed(4)}` : 'dynamic';
          return text({ status: 'payment_required', cost: `${price} USDC on Base (set by contributor)`, http_endpoint: `${AUXILO_BASE}/knowledge/${args.id}`, payment_details: data });
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

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

function text(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Auxilo MCP server running');
}

main().catch(console.error);
