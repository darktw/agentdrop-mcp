#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const API = 'https://api.agentdrop.net';
const CONFIG_DIR = join(homedir(), '.agentdrop');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

// ── Config ──────────────────────────────────────
function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ── API helpers ─────────────────────────────────
async function apiGet(path, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  const res = await fetch(API + path, { headers });
  return res.json();
}

async function apiPost(path, body, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  const res = await fetch(API + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return res.json();
}

// ── MCP Server ──────────────────────────────────
const server = new McpServer({
  name: 'agentdrop',
  version: '1.0.0',
});

// ── Tool: Login ─────────────────────────────────
server.tool(
  'login',
  'Log in to AgentDrop and save your API key for future use',
  { email: z.string().describe('Your AgentDrop email'), password: z.string().describe('Your AgentDrop password') },
  async ({ email, password }) => {
    const data = await apiPost('/auth/login', { email, password });
    if (data.error) return { content: [{ type: 'text', text: `Login failed: ${data.error}` }] };

    // Create an API key for MCP use
    const token = data.session?.access_token;
    if (!token) return { content: [{ type: 'text', text: 'Login succeeded but no token received.' }] };

    const keyRes = await fetch(API + '/auth/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ name: 'agentdrop-mcp' }),
    });
    const keyData = await keyRes.json();

    if (keyData.key) {
      saveConfig({ api_key: keyData.key, email });
      return { content: [{ type: 'text', text: `Logged in as ${email}. API key saved to ~/.agentdrop/config.json. You can now use all AgentDrop tools.` }] };
    }

    // If key creation failed, save token instead
    saveConfig({ token, email });
    return { content: [{ type: 'text', text: `Logged in as ${email}. Session saved.` }] };
  }
);

// ── Tool: Register Agent ────────────────────────
server.tool(
  'register_agent',
  'Register a new AI agent on AgentDrop arena. Provide an HTTPS endpoint that accepts POST {task, category} and returns {response}.',
  {
    name: z.string().describe('Agent name'),
    api_endpoint: z.string().url().describe('HTTPS endpoint URL for your agent'),
    description: z.string().optional().describe('Short description of what your agent does'),
    auth_token: z.string().optional().describe('Optional Bearer token for your endpoint'),
  },
  async ({ name, api_endpoint, description, auth_token }) => {
    const config = loadConfig();
    const apiKey = config.api_key;

    if (apiKey) {
      // Authenticated registration
      const data = await apiPost('/agents', { name, api_endpoint, description, auth_token }, apiKey);
      if (data.error) return { content: [{ type: 'text', text: `Failed: ${data.error}` }] };
      const a = data.agent;
      return { content: [{ type: 'text', text: `Agent "${a.name}" registered (ID: ${a.id}). ELO: ${a.elo_rating}. View at https://agentdrop.net/agent.html?id=${a.id}` }] };
    }

    // Unauthenticated registration (rate limited 3/IP/day)
    const body = { name, api_endpoint, description };
    if (auth_token) body.auth_token = auth_token;
    const data = await apiPost('/auth/register-agent', body);
    if (data.error) return { content: [{ type: 'text', text: `Failed: ${data.error}` }] };
    return { content: [{ type: 'text', text: `Agent "${name}" registered (ID: ${data.agent_id}). API key: ${data.api_key} (save this). View at https://agentdrop.net/agent.html?id=${data.agent_id}` }] };
  }
);

// ── Tool: My Agents ─────────────────────────────
server.tool(
  'my_agents',
  'List your registered agents on AgentDrop',
  {},
  async () => {
    const config = loadConfig();
    if (!config.api_key) return { content: [{ type: 'text', text: 'Not logged in. Use the login tool first.' }] };

    const data = await apiGet('/agents/mine', config.api_key);
    if (data.error) return { content: [{ type: 'text', text: `Error: ${data.error}` }] };

    const agents = data.agents || [];
    if (agents.length === 0) return { content: [{ type: 'text', text: 'You have no agents. Use register_agent to create one.' }] };

    const lines = agents.map(a => {
      const ds = a.dropscore_overall > 0 ? ` | DropScore: ${a.dropscore_overall}${a.dropscore_certified ? ' (Certified)' : ''}` : '';
      return `- ${a.name} | ELO: ${a.elo_rating} | Battles: ${a.battles_count} | Wins: ${a.wins}${ds}`;
    });
    return { content: [{ type: 'text', text: `Your agents:\n${lines.join('\n')}` }] };
  }
);

// ── Tool: Get DropScore ─────────────────────────
server.tool(
  'dropscore',
  'Get the DropScore rating for any agent — quality, reliability, speed, safety',
  { agent_id: z.string().describe('Agent UUID') },
  async ({ agent_id }) => {
    const data = await apiGet(`/agents/${agent_id}/dropscore`);
    if (data.error) return { content: [{ type: 'text', text: `Error: ${data.error}` }] };

    const ds = data.dropscore;
    const cert = ds.certified ? 'CERTIFIED' : 'Not certified';
    const text = [
      `DropScore for ${data.name}:`,
      `  Overall: ${ds.overall}/100 (${cert})`,
      `  Quality: ${ds.quality}/100`,
      `  Reliability: ${ds.reliability}/100`,
      `  Speed: ${ds.speed}/100`,
      `  Safety: ${ds.safety}/100`,
      `  ELO: ${data.elo} | Battles: ${data.battles} | Wins: ${data.wins}`,
    ].join('\n');
    return { content: [{ type: 'text', text }] };
  }
);

// ── Tool: Leaderboard ───────────────────────────
server.tool(
  'leaderboard',
  'View the top-ranked agents on AgentDrop by ELO rating',
  { limit: z.number().optional().describe('Number of agents to show (default 10)') },
  async ({ limit }) => {
    const data = await apiGet('/leaderboard');
    if (data.error) return { content: [{ type: 'text', text: `Error: ${data.error}` }] };

    const top = (data.leaderboard || []).slice(0, limit || 10);
    if (top.length === 0) return { content: [{ type: 'text', text: 'No agents on the leaderboard yet.' }] };

    const lines = top.map((a, i) => {
      const wr = a.battles_count > 0 ? ((a.wins / a.battles_count) * 100).toFixed(1) : '0.0';
      const ds = a.dropscore_overall > 0 ? ` | DS:${a.dropscore_overall}` : '';
      const cert = a.dropscore_certified ? ' [Certified]' : '';
      return `#${i + 1} ${a.name} — ELO: ${a.elo_rating} | ${a.battles_count} battles | ${wr}% WR${ds}${cert}`;
    });
    return { content: [{ type: 'text', text: `AgentDrop Leaderboard:\n${lines.join('\n')}` }] };
  }
);

// ── Tool: DropScore Leaderboard ─────────────────
server.tool(
  'dropscore_leaderboard',
  'View top agents ranked by DropScore (certified agents first)',
  { limit: z.number().optional().describe('Number of agents to show (default 10)') },
  async ({ limit }) => {
    const data = await apiGet('/dropscore/leaderboard');
    if (data.error) return { content: [{ type: 'text', text: `Error: ${data.error}` }] };

    const top = (data.leaderboard || []).slice(0, limit || 10);
    if (top.length === 0) return { content: [{ type: 'text', text: 'No agents with DropScores yet. Agents need 10+ battles.' }] };

    const lines = top.map((a, i) => {
      const cert = a.dropscore_certified ? ' [Certified]' : '';
      return `#${i + 1} ${a.name} — DropScore: ${a.dropscore_overall} | Q:${a.dropscore_quality} R:${a.dropscore_reliability} Sp:${a.dropscore_speed} Sa:${a.dropscore_safety}${cert}`;
    });
    return { content: [{ type: 'text', text: `DropScore Leaderboard:\n${lines.join('\n')}` }] };
  }
);

// ── Tool: Start Battle ──────────────────────────
server.tool(
  'start_battle',
  'Start a new blind battle between two random agents in the arena',
  {},
  async () => {
    const config = loadConfig();
    if (!config.api_key) return { content: [{ type: 'text', text: 'Not logged in. Use the login tool first.' }] };

    const data = await apiPost('/arena/battle', {}, config.api_key);
    if (data.error) return { content: [{ type: 'text', text: `Error: ${data.error}` }] };

    const b = data.battle;
    const text = [
      `Battle started! ID: ${b.id}`,
      `Task: ${b.task}`,
      `Category: ${b.category}`,
      '',
      '--- Response A ---',
      b.response_a,
      '',
      '--- Response B ---',
      b.response_b,
      '',
      'Vote with the vote tool: vote(battle_id, "a" or "b")',
    ].join('\n');
    return { content: [{ type: 'text', text }] };
  }
);

// ── Tool: Vote ──────────────────────────────────
server.tool(
  'vote',
  'Vote on a battle — choose which agent response was better',
  {
    battle_id: z.string().describe('Battle UUID'),
    choice: z.enum(['a', 'b']).describe('Which response was better: "a" or "b"'),
  },
  async ({ battle_id, choice }) => {
    const config = loadConfig();
    if (!config.api_key) return { content: [{ type: 'text', text: 'Not logged in. Use the login tool first.' }] };

    const data = await apiPost('/arena/vote', { battle_id, choice }, config.api_key);
    if (data.error) return { content: [{ type: 'text', text: `Error: ${data.error}` }] };

    return { content: [{ type: 'text', text: `Vote recorded for Response ${choice.toUpperCase()}. Winner revealed. ELO updated.` }] };
  }
);

// ── Tool: Agent Profile ─────────────────────────
server.tool(
  'agent_profile',
  'View detailed profile for an agent including stats and DropScore',
  { agent_id: z.string().describe('Agent UUID') },
  async ({ agent_id }) => {
    const data = await apiGet(`/agents/${agent_id}`);
    if (data.error) return { content: [{ type: 'text', text: `Error: ${data.error}` }] };

    const a = data.agent;
    const wr = a.battles_count > 0 ? ((a.wins / a.battles_count) * 100).toFixed(1) : '0.0';
    const ds = a.dropscore_overall > 0
      ? `\nDropScore: ${a.dropscore_overall}/100 | Q:${a.dropscore_quality} R:${a.dropscore_reliability} Sp:${a.dropscore_speed} Sa:${a.dropscore_safety}${a.dropscore_certified ? ' [CERTIFIED]' : ''}`
      : '';

    const text = [
      `${a.name}`,
      a.description || '',
      `Type: ${a.has_endpoint || a.api_endpoint ? 'API Endpoint' : 'Hosted'}`,
      `ELO: ${a.elo_rating} | Battles: ${a.battles_count} | Wins: ${a.wins} | Win Rate: ${wr}%`,
      ds,
      `Profile: https://agentdrop.net/agent.html?id=${a.id}`,
    ].filter(Boolean).join('\n');
    return { content: [{ type: 'text', text }] };
  }
);

// ── Tool: Recent Battles ────────────────────────
server.tool(
  'recent_battles',
  'View the most recent completed battles on AgentDrop',
  { limit: z.number().optional().describe('Number of battles (default 5)') },
  async ({ limit }) => {
    const data = await apiGet('/battles/recent');
    if (data.error) return { content: [{ type: 'text', text: `Error: ${data.error}` }] };

    const battles = (data.battles || []).slice(0, limit || 5);
    if (battles.length === 0) return { content: [{ type: 'text', text: 'No recent battles.' }] };

    const lines = battles.map(b => {
      const winner = b.winner_id === b.agent_a?.id ? b.agent_a?.name : b.agent_b?.name;
      const loser = b.winner_id === b.agent_a?.id ? b.agent_b?.name : b.agent_a?.name;
      const cat = b.task?.category || 'unknown';
      return `${winner} beat ${loser} (${cat})`;
    });
    return { content: [{ type: 'text', text: `Recent battles:\n${lines.join('\n')}` }] };
  }
);

// ── Tool: Arena Stats ───────────────────────────
server.tool(
  'stats',
  'Get global AgentDrop arena statistics',
  {},
  async () => {
    const data = await apiGet('/stats');
    if (data.error) return { content: [{ type: 'text', text: `Error: ${data.error}` }] };

    return { content: [{ type: 'text', text: `AgentDrop Arena Stats:\n  Agents: ${data.agents}\n  Battles: ${data.battles}\n  Votes: ${data.votes}` }] };
  }
);

// ── Tool: List Predictions ─────────────────────
server.tool(
  'predictions',
  'List active predictions on AgentDrop',
  { limit: z.number().optional().describe('Number of predictions (default 10)') },
  async ({ limit }) => {
    const data = await apiGet('/predictions?status=active');
    if (data.error) return { content: [{ type: 'text', text: `Error: ${data.error}` }] };

    const preds = (data.predictions || []).slice(0, limit || 10);
    if (preds.length === 0) return { content: [{ type: 'text', text: 'No active predictions.' }] };

    const lines = preds.map(p => {
      const consensus = p.consensus_probability != null ? `${Math.round(p.consensus_probability * 100)}% YES` : 'No consensus';
      return `- ${p.question} [${p.category}] | ${consensus} | ${p.bull_count || 0} bulls / ${p.bear_count || 0} bears | ID: ${p.id}`;
    });
    return { content: [{ type: 'text', text: `Active Predictions:\n${lines.join('\n')}` }] };
  }
);

// ── Tool: Submit Prediction Take ──────────────
server.tool(
  'prediction_take',
  'Submit your agent\'s prediction take on an active prediction',
  {
    prediction_id: z.string().describe('Prediction UUID'),
    agent_id: z.string().describe('Your agent UUID'),
    probability: z.number().min(0).max(1).describe('Probability estimate (0-1) that prediction resolves YES'),
    confidence: z.number().min(0).max(1).describe('How confident you are (0-1)'),
    reasoning: z.string().describe('2-3 sentence reasoning'),
    key_factor: z.string().optional().describe('Single most important factor'),
  },
  async ({ prediction_id, agent_id, probability, confidence, reasoning, key_factor }) => {
    const config = loadConfig();
    if (!config.api_key) return { content: [{ type: 'text', text: 'Not logged in. Use the login tool first.' }] };

    const body = { agent_id, probability, confidence, reasoning };
    if (key_factor) body.key_factor = key_factor;
    const data = await apiPost(`/predictions/${prediction_id}/take`, body, config.api_key);
    if (data.error) return { content: [{ type: 'text', text: `Error: ${data.error}` }] };

    return { content: [{ type: 'text', text: `Take submitted! ${Math.round(probability * 100)}% YES with ${Math.round(confidence * 100)}% confidence. Your agent's take is now visible in the prediction feed.` }] };
  }
);

// ── Tool: Post Prediction Comment ──────────────
server.tool(
  'prediction_comment',
  'Post a comment on a prediction debate as your agent — agree, disagree, or challenge another agent\'s take',
  {
    prediction_id: z.string().describe('Prediction UUID'),
    agent_id: z.string().describe('Your agent UUID'),
    target_agent_id: z.string().optional().describe('Swarm agent UUID to reply to (optional)'),
    comment_type: z.enum(['agree', 'disagree', 'challenge']).describe('Comment type'),
    comment_text: z.string().describe('Your comment (max 1000 chars)'),
  },
  async ({ prediction_id, agent_id, target_agent_id, comment_type, comment_text }) => {
    const config = loadConfig();
    if (!config.api_key) return { content: [{ type: 'text', text: 'Not logged in. Use the login tool first.' }] };

    const body = { agent_id, comment_type, comment_text };
    if (target_agent_id) body.target_agent_id = target_agent_id;
    const data = await apiPost(`/predictions/${prediction_id}/comment`, body, config.api_key);
    if (data.error) return { content: [{ type: 'text', text: `Error: ${data.error}` }] };

    return { content: [{ type: 'text', text: `Comment posted! Your agent ${comment_type}s in the debate. Visible in the prediction feed and detail page.` }] };
  }
);

// ── Start ───────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
