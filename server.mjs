#!/usr/bin/env node
/**
 * Clawd Control — Server
 * 
 * HTTP server with REST API + SSE for live dashboard updates.
 * Aggregates data from AgentCollector.
 */

import http from 'http';
const { createServer } = http;
import { readFileSync, existsSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { gzipSync } from 'zlib';
import { execFileSync } from 'child_process';
import { AgentCollector } from './collector.mjs';
import { createAgent } from './create-agent.mjs';
import { discoverAgents } from './discover.mjs';

import { createHash, randomBytes, timingSafeEqual } from 'crypto';

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '3100');
const DIR = new URL('.', import.meta.url).pathname;

// ── Auth ─────────────────────────────────────────────
// Password stored in auth.json. On first run, generates a random one.
const AUTH_PATH = join(DIR, 'auth.json');
let AUTH = loadAuth();

function loadAuth() {
  if (existsSync(AUTH_PATH)) {
    try { return JSON.parse(readFileSync(AUTH_PATH, 'utf8')); } catch {}
  }
  // Generate default password on first run
  const pw = randomBytes(12).toString('base64url');
  const auth = { password: pw, sessionTtlHours: 24 };
  writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2), 'utf8');
  console.log(`🔐 Generated password: ${pw}`);
  console.log(`   Stored in: ${AUTH_PATH}`);
  return auth;
}

// Session tokens (in-memory, survive until server restart)
const sessions = new Map();

function hashPassword(pw) {
  return createHash('sha256').update(pw).digest('hex');
}

function createSession() {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { created: Date.now() });
  return token;
}

function isValidSession(token) {
  const sess = sessions.get(token);
  if (!sess) return false;
  const maxAge = (AUTH.sessionTtlHours || 24) * 3600000;
  if (Date.now() - sess.created > maxAge) { sessions.delete(token); return false; }
  return true;
}

function getSessionToken(req) {
  // Check cookie first
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/fmc_session=([a-f0-9]+)/);
  if (match) return match[1];
  // Check Authorization header (for API calls)
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  return null;
}

function requireAuth(req, res) {
  const token = getSessionToken(req);
  if (token && isValidSession(token)) return true;

  const url = new URL(req.url, `http://${req.headers.host}`);

  // Allow login page and login API without auth
  if (url.pathname === '/login' || url.pathname === '/api/login') return true;

  // For API calls, return 401
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }

  // For pages, redirect to login
  res.writeHead(302, { Location: '/login' });
  res.end();
  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ── Collector ───────────────────────────────────────

// Auto-discover agents if agents.json doesn't exist
const agentsJsonPath = join(DIR, 'agents.json');
if (!existsSync(agentsJsonPath)) {
  console.log('🔍 agents.json not found, auto-discovering...');
  const discovered = discoverAgents();
  writeFileSync(agentsJsonPath, JSON.stringify(discovered, null, 2), 'utf8');
  console.log(`✅ Created agents.json with ${discovered.agents.length} agent(s)`);
}

const collector = new AgentCollector(agentsJsonPath);
const sseClients = new Set();

collector.on('update', ({ id, state, removed }) => {
  broadcast({ type: 'agent', id, data: state, removed: !!removed });
});

collector.on('hostMetrics', (metrics) => {
  broadcast({ type: 'host', data: metrics });
});

function broadcast(event) {
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

collector.start();
console.log('📡 Collector started');

// ── Agent Actions ──
async function handleAgentAction(agentId, action) {
  try {
    switch (action) {
      case 'heartbeat-enable': {
        // Runtime toggle
        execFileSync('clawdbot', ['system', 'heartbeat', 'enable'], { encoding: 'utf8', stdio: 'pipe' });
        // Also persist via gateway config.patch
        try {
          execFileSync('clawdbot', ['gateway', 'config.patch', '--json', JSON.stringify({
            agents: { defaults: { heartbeat: { every: '55m' } } }
          })], { encoding: 'utf8', stdio: 'pipe' });
        } catch (_) { /* best effort */ }
        return { ok: true, message: `Heartbeat enabled for ${agentId}` };
      }
      case 'heartbeat-disable': {
        // Runtime toggle
        execFileSync('clawdbot', ['system', 'heartbeat', 'disable'], { encoding: 'utf8', stdio: 'pipe' });
        // Also persist via gateway config.patch
        try {
          execFileSync('clawdbot', ['gateway', 'config.patch', '--json', JSON.stringify({
            agents: { defaults: { heartbeat: { every: 'off' } } }
          })], { encoding: 'utf8', stdio: 'pipe' });
        } catch (_) { /* best effort */ }
        return { ok: true, message: `Heartbeat disabled for ${agentId}` };
      }
      case 'heartbeat-trigger': {
        execFileSync('clawdbot', ['system', 'event', '--mode', 'now', '--text', 'Manual heartbeat trigger from Clawd Control'], { encoding: 'utf8', stdio: 'pipe' });
        return { ok: true, message: `Heartbeat triggered for ${agentId}` };
      }
      case 'session-new': {
        // Clear only the main session to start fresh (keeps other sessions)
        const mainAgentId = agentId === 'gandalf' ? 'main' : agentId;
        const sessPath = join(process.env.HOME, '.clawdbot', 'agents', mainAgentId, 'sessions', 'sessions.json');
        if (existsSync(sessPath)) {
          const sessions = JSON.parse(readFileSync(sessPath, 'utf8'));
          const mainKey = `agent:${mainAgentId}:main`;
          if (sessions[mainKey]) {
            // Backup the session transcript before clearing
            const sid = sessions[mainKey].sessionId;
            if (sid) {
              const transcript = join(process.env.HOME, '.clawdbot', 'agents', mainAgentId, 'sessions', `${sid}.jsonl`);
              if (existsSync(transcript)) {
                const bak = transcript.replace('.jsonl', `.archived.${Date.now()}.jsonl`);
                copyFileSync(transcript, bak);
              }
            }
            delete sessions[mainKey];
            writeFileSync(sessPath, JSON.stringify(sessions, null, 2), 'utf8');
          }
        }
        return { ok: true, message: `New session started for ${agentId}. Old conversation archived.` };
      }
      case 'session-reset': {
        // Delete ALL sessions (nuclear option)
        const agentIdForPath = agentId === 'gandalf' ? 'main' : agentId;
        const sessionPath = join(process.env.HOME, '.clawdbot', 'agents', agentIdForPath, 'sessions', 'sessions.json');
        if (existsSync(sessionPath)) {
          const backup = sessionPath + '.bak.' + Date.now();
          copyFileSync(sessionPath, backup);
          writeFileSync(sessionPath, '{}', 'utf8');
        }
        return { ok: true, message: `All sessions reset for ${agentId}. Backup created.` };
      }
      default:
        return { ok: false, error: `Unknown action: ${action}` };
    }
  } catch (e) {
    return { ok: false, error: e.message?.substring(0, 200) };
  }
}

// ── Security Audit (Frodo's checks) ─────────────────
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

function runSecurityAudit() {
  const secDir = join(DIR, 'security-lib', 'checks');
  const os = require('os');
  const config = {
    workspace: join(os.homedir(), 'clawd'),
    secretsDir: join(os.homedir(), 'clawd', 'secrets'),
    logsDir: join(os.homedir(), 'clawd', 'logs'),
    auditLog: join(os.homedir(), 'clawd', 'logs', 'dashboard-access.log'),
    maxLogSizeMB: 5,
  };

  const { checkSecrets } = require(join(secDir, 'secrets.js'));
  const { checkExposedCredentials } = require(join(secDir, 'credentials.js'));
  const { checkNetwork } = require(join(secDir, 'network.js'));
  const { checkSystem } = require(join(secDir, 'system.js'));
  const { checkGatewayConfig } = require(join(secDir, 'gateway.js'));
  const { checkAccounts } = require(join(secDir, 'accounts.js'));

  const dummyTokenInfo = () => ({ expired: false, remainingHours: 24, ageHours: 0, maxAgeDays: 7 });

  return {
    timestamp: new Date().toISOString(),
    sections: [
      { title: '🔐 Secrets Management', checks: safeRun(() => checkSecrets(config)) },
      { title: '🔍 Credential Exposure', checks: safeRun(() => checkExposedCredentials(config)) },
      { title: '🌐 Network & Ports', checks: safeRun(() => checkNetwork(config, dummyTokenInfo)) },
      { title: '🖥️ System Security', checks: safeRun(() => checkSystem()) },
      { title: '⚙️ Gateway Config', checks: safeRun(() => checkGatewayConfig()) },
      { title: '📋 Account Inventory', checks: safeRun(() => checkAccounts(config)) },
    ],
  };
}

function safeRun(fn) {
  try { return fn(); }
  catch (e) { return [{ name: 'Check failed', status: 'fail', detail: e.message }]; }
}

// ── Agent Detail Reader ─────────────────────────────
function getAgentDetail(agentId) {
  const agentConfig = collector.config?.agents?.find(a => a.id === agentId);
  if (!agentConfig) return null;

  const ws = agentConfig.workspace;
  const safeRead = (file, maxBytes = 8192) => {
    const p = join(ws, file);
    if (!existsSync(p)) return null;
    try {
      const content = readFileSync(p, 'utf8');
      return content.length > maxBytes ? content.substring(0, maxBytes) + '\n\n...(truncated)' : content;
    } catch { return null; }
  };

  const listDir = (dir) => {
    const p = join(ws, dir);
    if (!existsSync(p)) return [];
    try {
      const { readdirSync, statSync } = require('fs');
      return readdirSync(p).filter(f => !f.startsWith('.')).map(f => {
        const fp = join(p, f);
        const st = statSync(fp);
        return { name: f, size: st.size, modified: st.mtime.toISOString(), isDir: st.isDirectory() };
      });
    } catch { return []; }
  };

  // Read workspace files
  const soul = safeRead('SOUL.md');
  const identity = safeRead('IDENTITY.md');
  const memory = safeRead('MEMORY.md');
  const tasks = safeRead('TASKS.md');
  const tools = safeRead('TOOLS.md');
  const heartbeat = safeRead('HEARTBEAT.md');
  const agents = safeRead('AGENTS.md');
  const user = safeRead('USER.md');
  const activeWork = safeRead('ACTIVE_WORK.md');
  const bootstrap = safeRead('BOOTSTRAP.md');

  // List skills
  let skills = [];
  const skillsDir = join(ws, 'skills');
  if (existsSync(skillsDir)) {
    try {
      skills = readdirSync(skillsDir).filter(f => {
        return statSync(join(skillsDir, f)).isDirectory();
      }).map(name => {
        const skillMd = join(skillsDir, name, 'SKILL.md');
        let description = null;
        if (existsSync(skillMd)) {
          const content = readFileSync(skillMd, 'utf8');
          const descMatch = content.match(/description:\s*(.+)/);
          if (descMatch) description = descMatch[1].trim();
        }
        return { name, description };
      });
    } catch {}
  }

  // List memory files
  let memoryFiles = [];
  const memDir = join(ws, 'memory');
  if (existsSync(memDir)) {
    try {
      memoryFiles = readdirSync(memDir)
        .filter(f => f.endsWith('.md') || f.endsWith('.json'))
        .map(f => {
          const st = statSync(join(memDir, f));
          return { name: f, size: st.size, modified: st.mtime.toISOString() };
        })
        .sort((a, b) => b.modified.localeCompare(a.modified));
    } catch {}
  }

  // Get recent daily notes (last 3)
  const recentNotes = memoryFiles
    .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f.name))
    .slice(0, 3)
    .map(f => ({ ...f, content: safeRead(`memory/${f.name}`, 4096) }));

  // Gateway state for this agent
  const liveState = collector.state.get(agentId) || {};

  return {
    id: agentId,
    config: agentConfig,
    workspace: {
      path: ws,
      soul, identity, memory, tasks, tools, heartbeat,
      agents, user, activeWork, bootstrap,
    },
    skills,
    memoryFiles,
    recentNotes,
    live: liveState,
  };
}

// ── Analytics Aggregator ────────────────────────────
import { homedir } from 'os';

function getAnalytics(rangeStr, agentFilter) {
  const AGENTS_DIR = join(homedir(), '.clawdbot', 'agents');
  const range = rangeStr === 'all' ? Infinity : parseInt(rangeStr);
  const cutoffDate = rangeStr === 'all' ? 0 : Date.now() - (range * 86400000);

  // Aggregate data structures
  let totalCost = 0;
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let apiCalls = 0;

  const byAgent = new Map(); // agentId -> {cost, tokens}
  const byDate = new Map(); // date -> {cost, tokens}
  const byModel = new Map(); // model -> {cost, tokens}
  const sessions = []; // [{agentId, sessionId, cost, tokens}]

  // Discover all agents
  let agentIds = [];
  try {
    agentIds = readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    // No agents dir
  }

  // Filter agents if needed
  if (agentFilter !== 'all') {
    agentIds = agentIds.filter(id => id === agentFilter);
  }

  // Parse sessions for each agent
  for (const agentId of agentIds) {
    const sessDir = join(AGENTS_DIR, agentId, 'sessions');
    if (!existsSync(sessDir)) continue;

    try {
      const files = readdirSync(sessDir).filter(
        f => f.endsWith('.jsonl') && !f.includes('.deleted.') && !f.includes('.archived.')
      );

      for (const file of files) {
        const sessionId = file.replace('.jsonl', '');
        const sessionPath = join(sessDir, file);
        
        // Check file mtime - skip if too old
        try {
          const stat = statSync(sessionPath);
          if (stat.mtimeMs < cutoffDate) continue;
        } catch {
          continue;
        }

        // Parse session efficiently (read only what we need)
        let sessionCost = 0;
        let sessionTokens = 0;
        let sessionInput = 0;
        let sessionOutput = 0;
        let sessionCache = 0;
        let sessionCalls = 0;
        let sessionModel = null;

        try {
          const content = readFileSync(sessionPath, 'utf8');
          const lines = content.split('\n').filter(l => l.trim());

          for (const line of lines) {
            try {
              const data = JSON.parse(line);

              // Model tracking
              if (data.type === 'model_change' && data.modelId) {
                sessionModel = data.modelId;
              }

              // Message cost extraction
              if (data.type === 'message' && data.message) {
                const msg = data.message;
                const usage = msg.usage || {};

                // Check timestamp
                const ts = data.timestamp || msg.timestamp;
                if (ts && ts < cutoffDate) continue;

                // Track costs
                const cost = usage.cost?.total || 0;
                const input = usage.input || 0;
                const output = usage.output || 0;
                const cache = usage.cacheRead || 0;

                sessionCost += cost;
                sessionTokens += input + output + cache;
                sessionInput += input;
                sessionOutput += output;
                sessionCache += cache;

                if (msg.role === 'user') {
                  sessionCalls++;
                }

                // Track by date
                if (ts) {
                  const date = new Date(ts).toISOString().split('T')[0];
                  if (!byDate.has(date)) {
                    byDate.set(date, { cost: 0, tokens: 0 });
                  }
                  const d = byDate.get(date);
                  d.cost += cost;
                  d.tokens += input + output + cache;
                }

                // Track by model
                if (sessionModel) {
                  if (!byModel.has(sessionModel)) {
                    byModel.set(sessionModel, { cost: 0, tokens: 0 });
                  }
                  const m = byModel.get(sessionModel);
                  m.cost += cost;
                  m.tokens += input + output + cache;
                }
              }
            } catch {
              // Skip malformed lines
            }
          }
        } catch {
          // Skip broken files
        }

        // Aggregate totals
        totalCost += sessionCost;
        totalTokens += sessionTokens;
        inputTokens += sessionInput;
        outputTokens += sessionOutput;
        cacheReadTokens += sessionCache;
        apiCalls += sessionCalls;

        // Track by agent
        if (!byAgent.has(agentId)) {
          byAgent.set(agentId, { cost: 0, tokens: 0 });
        }
        const a = byAgent.get(agentId);
        a.cost += sessionCost;
        a.tokens += sessionTokens;

        // Track session for top list
        if (sessionCost > 0 || sessionTokens > 0) {
          sessions.push({
            agentId,
            sessionId,
            cost: sessionCost,
            tokens: sessionTokens,
          });
        }
      }
    } catch {
      // Skip agent if sessions dir unreadable
    }
  }

  // Sort and format results
  const byAgentArray = Array.from(byAgent.entries())
    .map(([agentId, data]) => ({ agentId, ...data }))
    .sort((a, b) => b.cost - a.cost);

  const byDateArray = Array.from(byDate.entries())
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const byModelArray = Array.from(byModel.entries())
    .map(([model, data]) => ({ model, ...data }))
    .sort((a, b) => b.tokens - a.tokens);

  const topSessions = sessions
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 20);

  return {
    range: rangeStr,
    agentFilter,
    totalCost: Math.round(totalCost * 10000) / 10000,
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    apiCalls,
    byAgent: byAgentArray,
    overTime: byDateArray,
    byModel: byModelArray,
    topSessions,
  };
}

// ── Token Analytics (granular breakdown by day and agent) ──
function getTokenAnalytics(rangeStr, agentFilter) {
  const AGENTS_DIR = join(homedir(), '.clawdbot', 'agents');
  const range = rangeStr === 'all' ? Infinity : parseInt(rangeStr);
  const cutoffDate = rangeStr === 'all' ? 0 : Date.now() - (range * 86400000);

  // Aggregate data structures
  let totalCost = 0;
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let apiCalls = 0;

  const byAgent = new Map(); // agentId -> {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost}
  const byDate = new Map(); // date -> {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost}

  // Discover all agents
  let agentIds = [];
  try {
    agentIds = readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    // No agents dir
  }

  // Filter agents if needed
  if (agentFilter !== 'all') {
    agentIds = agentIds.filter(id => id === agentFilter);
  }

  // Parse sessions for each agent
  for (const agentId of agentIds) {
    const sessDir = join(AGENTS_DIR, agentId, 'sessions');
    if (!existsSync(sessDir)) continue;

    try {
      const files = readdirSync(sessDir).filter(
        f => f.endsWith('.jsonl') && !f.includes('.deleted.') && !f.includes('.archived.')
      );

      for (const file of files) {
        const sessionPath = join(sessDir, file);
        
        // Check file mtime - skip if too old
        try {
          const stat = statSync(sessionPath);
          if (stat.mtimeMs < cutoffDate) continue;
        } catch {
          continue;
        }

        // Parse session
        try {
          const content = readFileSync(sessionPath, 'utf8');
          const lines = content.split('\n').filter(l => l.trim());

          for (const line of lines) {
            try {
              const data = JSON.parse(line);

              // Message cost extraction
              if (data.type === 'message' && data.message) {
                const msg = data.message;
                const usage = msg.usage || {};

                // Check timestamp
                const ts = data.timestamp || msg.timestamp;
                if (ts && ts < cutoffDate) continue;

                // Extract token counts
                const cost = usage.cost?.total || 0;
                const input = usage.input || 0;
                const output = usage.output || 0;
                const cacheRead = usage.cacheRead || 0;
                const cacheWrite = usage.cacheWrite || 0;

                // Aggregate totals
                totalCost += cost;
                totalTokens += input + output + cacheRead;
                inputTokens += input;
                outputTokens += output;
                cacheReadTokens += cacheRead;
                cacheWriteTokens += cacheWrite;

                if (msg.role === 'user') {
                  apiCalls++;
                }

                // Track by date
                if (ts) {
                  const date = new Date(ts).toISOString().split('T')[0];
                  if (!byDate.has(date)) {
                    byDate.set(date, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 });
                  }
                  const d = byDate.get(date);
                  d.inputTokens += input;
                  d.outputTokens += output;
                  d.cacheReadTokens += cacheRead;
                  d.cacheWriteTokens += cacheWrite;
                  d.cost += cost;
                }

                // Track by agent
                if (!byAgent.has(agentId)) {
                  byAgent.set(agentId, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 });
                }
                const a = byAgent.get(agentId);
                a.inputTokens += input;
                a.outputTokens += output;
                a.cacheReadTokens += cacheRead;
                a.cacheWriteTokens += cacheWrite;
                a.cost += cost;
              }
            } catch {
              // Skip malformed lines
            }
          }
        } catch {
          // Skip broken files
        }
      }
    } catch {
      // Skip agent if sessions dir unreadable
    }
  }

  // Sort and format results
  const byAgentArray = Array.from(byAgent.entries())
    .map(([agentId, data]) => ({ agentId, ...data }))
    .sort((a, b) => (b.inputTokens + b.outputTokens + b.cacheReadTokens) - (a.inputTokens + a.outputTokens + a.cacheReadTokens));

  const byDateArray = Array.from(byDate.entries())
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Calculate cache efficiency
  const cacheHitRate = inputTokens > 0 ? (cacheReadTokens / (inputTokens + cacheReadTokens) * 100) : 0;
  const avgTokensPerCall = apiCalls > 0 ? Math.round(totalTokens / apiCalls) : 0;

  return {
    range: rangeStr,
    agentFilter,
    totalCost: Math.round(totalCost * 10000) / 10000,
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    apiCalls,
    cacheHitRate: Math.round(cacheHitRate * 10) / 10,
    avgTokensPerCall,
    byAgent: byAgentArray,
    overTime: byDateArray,
  };
}

// ── Session Trace (for waterfall view) ─────────────

function getAllSessions() {
  const AGENTS_DIR = join(homedir(), '.clawdbot', 'agents');
  const sessions = [];

  try {
    const agentIds = readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const agentId of agentIds) {
      const sessionsPath = join(AGENTS_DIR, agentId, 'sessions', 'sessions.json');
      if (!existsSync(sessionsPath)) continue;

      try {
        const sessData = JSON.parse(readFileSync(sessionsPath, 'utf8'));
        for (const [key, sess] of Object.entries(sessData)) {
          if (!sess.sessionFile) continue;
          
          const agentInfo = collector.state.get(agentId) || {};
          sessions.push({
            key,
            agentId,
            agentName: agentInfo.name || agentId,
            agentEmoji: agentInfo.emoji || '🤖',
            sessionId: sess.sessionId,
            displayName: sess.displayName || key.split(':').pop() || key,
            updatedAt: sess.updatedAt,
            sessionFile: sess.sessionFile,
          });
        }
      } catch {
        // Skip malformed sessions.json
      }
    }
  } catch {
    // No agents dir
  }

  // Sort by most recent first
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return sessions;
}

function getSessionTrace(sessionKey) {
  const AGENTS_DIR = join(homedir(), '.clawdbot', 'agents');
  
  // Find the session file
  let sessionFile = null;
  let agentId = null;

  try {
    const agentIds = readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const aid of agentIds) {
      const sessionsPath = join(AGENTS_DIR, aid, 'sessions', 'sessions.json');
      if (!existsSync(sessionsPath)) continue;

      try {
        const sessData = JSON.parse(readFileSync(sessionsPath, 'utf8'));
        if (sessData[sessionKey]) {
          sessionFile = sessData[sessionKey].sessionFile;
          agentId = aid;
          break;
        }
      } catch {}
    }
  } catch {
    return null;
  }

  if (!sessionFile || !existsSync(sessionFile)) return null;

  // Parse the JSONL file
  const trace = [];
  let totalCost = 0;
  let totalTokens = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let messageCount = 0;
  let currentModel = 'unknown';

  try {
    const content = readFileSync(sessionFile, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Track model changes
        if (entry.type === 'model_change' && entry.modelId) {
          currentModel = entry.modelId.replace('anthropic/', '').replace('openai/', '');
        }

        // Extract message data
        if (entry.type === 'message' && entry.message) {
          const msg = entry.message;
          const timestamp = entry.timestamp;
          const role = msg.role;
          const usage = msg.usage || {};
          const stopReason = msg.stopReason || '';

          // Extract content types
          const content = msg.content || [];
          const contentTypes = [];
          const toolCalls = [];
          let hasThinking = false;
          let textContent = '';

          for (const item of content) {
            if (item.type === 'text') {
              textContent += item.text || '';
            } else if (item.type === 'toolCall') {
              toolCalls.push({
                name: item.name,
                arguments: item.arguments,
                id: item.id,
              });
              if (!contentTypes.includes('toolCall')) contentTypes.push('toolCall');
            } else if (item.type === 'thinking') {
              hasThinking = true;
              if (!contentTypes.includes('thinking')) contentTypes.push('thinking');
            }
          }

          if (textContent && !contentTypes.includes('text')) {
            contentTypes.push('text');
          }

          // Calculate cost and tokens
          const inputTokens = usage.input || 0;
          const outputTokens = usage.output || 0;
          const cacheRead = usage.cacheRead || 0;
          const cost = usage.cost?.total || 0;
          const tokens = inputTokens + outputTokens + cacheRead;

          totalCost += cost;
          totalTokens += tokens;
          totalInput += inputTokens;
          totalOutput += outputTokens;
          totalCacheRead += cacheRead;
          messageCount++;

          trace.push({
            timestamp,
            role,
            contentTypes,
            toolCalls,
            hasThinking,
            textPreview: textContent.substring(0, 200),
            fullText: textContent,
            model: currentModel,
            stopReason,
            usage: {
              input: inputTokens,
              output: outputTokens,
              cacheRead,
              total: tokens,
            },
            cost,
          });
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    return null;
  }

  // Calculate durations (time between messages)
  for (let i = 0; i < trace.length - 1; i++) {
    const current = new Date(trace[i].timestamp).getTime();
    const next = new Date(trace[i + 1].timestamp).getTime();
    trace[i].duration = next - current;
  }
  if (trace.length > 0) {
    trace[trace.length - 1].duration = 0; // Last message has no duration
  }

  const startTime = trace.length > 0 ? new Date(trace[0].timestamp).getTime() : 0;
  const endTime = trace.length > 0 ? new Date(trace[trace.length - 1].timestamp).getTime() : 0;
  const totalDuration = endTime - startTime;

  return {
    sessionKey,
    agentId,
    trace,
    summary: {
      totalCost,
      totalTokens,
      totalInput,
      totalOutput,
      totalCacheRead,
      messageCount,
      totalDuration,
      startTime,
      endTime,
    },
  };
}

// ── Traces (delegation trees) ──────────────────────

function getTraces() {
  const AGENTS_DIR = join(homedir(), '.clawdbot', 'agents');
  const traces = [];
  const sessionMap = new Map(); // sessionKey -> session metadata

  try {
    const agentIds = readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    // First pass: collect all sessions
    for (const agentId of agentIds) {
      const sessionsPath = join(AGENTS_DIR, agentId, 'sessions', 'sessions.json');
      if (!existsSync(sessionsPath)) continue;

      try {
        const sessData = JSON.parse(readFileSync(sessionsPath, 'utf8'));
        for (const [key, sess] of Object.entries(sessData)) {
          if (!sess.sessionFile) continue;

          // Extract session stats from JSONL
          let cost = 0;
          let tokens = 0;
          let messageCount = 0;
          let model = null;
          let startTime = null;
          let endTime = null;

          if (existsSync(sess.sessionFile)) {
            try {
              const content = readFileSync(sess.sessionFile, 'utf8');
              const lines = content.split('\n').filter(l => l.trim());

              for (const line of lines) {
                try {
                  const entry = JSON.parse(line);
                  
                  if (entry.type === 'model_change' && entry.modelId) {
                    model = entry.modelId;
                  }

                  if (entry.type === 'message' && entry.message) {
                    const msg = entry.message;
                    const usage = msg.usage || {};
                    cost += usage.cost?.total || 0;
                    tokens += (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0);
                    if (msg.role === 'user') messageCount++;

                    const ts = entry.timestamp || msg.timestamp;
                    if (ts) {
                      if (!startTime || ts < startTime) startTime = ts;
                      if (!endTime || ts > endTime) endTime = ts;
                    }
                  }
                } catch {}
              }
            } catch {}
          }

          // Determine if this is a main session or subagent
          const isMain = key.endsWith(':main') || !key.includes(':subagent:');
          const label = sess.displayName || sess.origin?.label || key.split(':').pop() || 'unknown';

          // Extract parent key for subagents
          let parentKey = null;
          if (key.includes(':subagent:')) {
            // Parent is the main session of the same agent
            const parts = key.split(':');
            if (parts.length >= 4) {
              parentKey = `${parts[0]}:${parts[1]}:main`;
            }
          }

          const agentInfo = collector.state.get(agentId) || {};
          sessionMap.set(key, {
            key,
            agentId,
            agentName: agentInfo.name || agentId,
            agentEmoji: agentInfo.emoji || '🤖',
            label,
            model: model ? model.replace('anthropic/', '').replace('openai/', '') : 'unknown',
            cost,
            tokens,
            messageCount,
            startTime,
            endTime,
            updatedAt: sess.updatedAt,
            isMain,
            parentKey,
            children: [],
          });
        }
      } catch {}
    }

    // Second pass: build tree structure
    const rootSessions = [];
    for (const [key, sess] of sessionMap.entries()) {
      if (sess.isMain) {
        rootSessions.push(sess);
      } else if (sess.parentKey) {
        const parent = sessionMap.get(sess.parentKey);
        if (parent) {
          parent.children.push(sess);
        } else {
          // Parent not found, treat as orphan root
          rootSessions.push(sess);
        }
      }
    }

    // Sort roots by most recent first
    rootSessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    // Calculate summary stats
    let totalSessions = sessionMap.size;
    let totalSubagents = 0;
    let totalCost = 0;
    let maxDepth = 1;

    function calculateDepth(sess, depth = 1) {
      if (depth > maxDepth) maxDepth = depth;
      totalCost += sess.cost || 0;
      if (!sess.isMain) totalSubagents++;
      for (const child of sess.children) {
        calculateDepth(child, depth + 1);
      }
    }

    for (const root of rootSessions) {
      calculateDepth(root);
    }

    return {
      traces: rootSessions,
      summary: {
        totalSessions,
        totalSubagents,
        totalCost: Math.round(totalCost * 10000) / 10000,
        maxDepth,
      },
    };
  } catch (e) {
    console.error('getTraces error:', e);
    return { traces: [], summary: { totalSessions: 0, totalSubagents: 0, totalCost: 0, maxDepth: 0 } };
  }
}

// ── HTTP Server ─────────────────────────────────────

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // CORS for local network
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Login ──
  if (path === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { password } = JSON.parse(body);
        const pwBuf = Buffer.from(String(password));
        const authBuf = Buffer.from(String(AUTH.password));
        if (pwBuf.length === authBuf.length && timingSafeEqual(pwBuf, authBuf)) {
          const token = createSession();
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `fmc_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${(AUTH.sessionTtlHours || 24) * 3600}`,
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Wrong password' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Bad request' }));
      }
    });
    return;
  }

  if (path === '/api/logout' && req.method === 'POST') {
    const token = getSessionToken(req);
    if (token) sessions.delete(token);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'fmc_session=; Path=/; HttpOnly; Max-Age=0',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Login page ──
  if (path === '/login') {
    // If already logged in, redirect to dashboard
    const token = getSessionToken(req);
    if (token && isValidSession(token)) {
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LOGIN_HTML);
    return;
  }

  // ── Auth gate (everything below requires auth) ──
  if (!requireAuth(req, res)) return;

  // ── API Routes ──

  if (path === '/api/snapshot') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(collector.getSnapshot()));
    return;
  }

  if (path === '/api/agents') {
    const agents = Object.fromEntries(collector.state);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(agents));
    return;
  }

  if (path.startsWith('/api/agents/') && path.split('/').length === 4) {
    const id = path.split('/')[3];
    const state = collector.state.get(id);
    if (!state) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'agent not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
    return;
  }

  // ── Create Agent ──
  if (path === '/api/create-agent' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const result = await createAgent(data);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        // Reload collector config if agent was created
        if (result.ok) {
          setTimeout(() => { try { collector.loadConfig(); } catch {} }, 2000);
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message, steps: [`❌ ${e.message}`] }));
      }
    });
    return;
  }

  // ── Security Audit ──
  if (path === '/api/security-audit' && req.method === 'GET') {
    try {
      const result = runSecurityAudit();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Crons ──
  if (path === '/api/crons' && req.method === 'GET') {
    try {
      const output = execFileSync('clawdbot', ['cron', 'list', '--json'], { encoding: 'utf8', stdio: 'pipe', timeout: 10000 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(output);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Failed to list cron jobs: ${e.message}` }));
    }
    return;
  }

  // ── Analytics ──
  if (path === '/api/analytics' && req.method === 'GET') {
    try {
      const range = url.searchParams.get('range') || '7';
      const agentFilter = url.searchParams.get('agent') || 'all';
      const result = getAnalytics(range, agentFilter);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Token Analytics (granular breakdown) ──
  if (path === '/api/tokens' && req.method === 'GET') {
    try {
      const range = url.searchParams.get('range') || '7';
      const agentFilter = url.searchParams.get('agent') || 'all';
      const result = getTokenAnalytics(range, agentFilter);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Session Trace (Waterfall Data) ──
  if (path.startsWith('/api/session/') && path.endsWith('/trace') && req.method === 'GET') {
    try {
      const sessionKey = decodeURIComponent(path.split('/')[3]);
      const result = getSessionTrace(sessionKey);
      if (!result) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Traces (parent→child delegation trees) ──
  if (path === '/api/traces' && req.method === 'GET') {
    try {
      const result = getTraces();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── List Sessions ──
  if (path === '/api/sessions' && req.method === 'GET') {
    try {
      const result = getAllSessions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Agent Detail ──
  if (path.startsWith('/api/agents/') && path.endsWith('/detail') && req.method === 'GET') {
    const agentId = path.split('/')[3];
    const result = getAgentDetail(agentId);
    if (!result) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // ── Agent Detail page ──
  if (path.startsWith('/agent/')) {
    const fullPath = join(DIR, 'agent-detail.html');
    if (existsSync(fullPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(fullPath));
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // ── Agent Actions (stop/start/reset) ──
  if (path.startsWith('/api/agents/') && path.endsWith('/action') && req.method === 'POST') {
    const agentId = path.split('/')[3];
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { action } = JSON.parse(body);
        const result = await handleAgentAction(agentId, action);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (path === '/api/host') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(collector.hostMetrics));
    return;
  }

  // ── SSE Stream ──

  if (path === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', data: collector.getSnapshot() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ── Static Files ──

  let filePath = path === '/' ? '/dashboard.html' : path;
  const fullPath = join(DIR, filePath);

  if (!fullPath.startsWith(DIR) || !existsSync(fullPath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  try {
    const data = readFileSync(fullPath);
    const ext = extname(fullPath);
    const contentType = MIME[ext] || 'application/octet-stream';

    // Smart caching: cache JS/CSS assets, not HTML
    const isAsset = ['.js', '.mjs', '.css', '.png', '.svg', '.ico'].includes(ext);
    const cacheControl = isAsset ? 'public, max-age=3600' : 'no-cache';

    // Gzip text responses > 1KB
    const isText = ['.html', '.js', '.mjs', '.css', '.json', '.svg'].includes(ext);
    const acceptGzip = (req.headers['accept-encoding'] || '').includes('gzip');
    if (isText && acceptGzip && data.length > 1024) {
      const compressed = gzipSync(data);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Encoding': 'gzip',
        'Cache-Control': cacheControl,
        'Vary': 'Accept-Encoding',
      });
      res.end(compressed);
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': cacheControl,
      });
      res.end(data);
    }
  } catch {
    res.writeHead(500);
    res.end('Error');
  }
});

// ── Login Page HTML ──
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Login — Clawd Control</title>
<style>
  :root { --bg: #0f1117; --card: #1a1d27; --border: #2a2d3a; --text: #e4e4e7; --muted: #71717a; --accent: #c9a44a; --accent-hover: #d4af5a; --red: #ef4444; --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: var(--font); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .login-box { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 40px; width: 100%; max-width: 360px; text-align: center; }
  .login-box h1 { font-size: 2rem; margin-bottom: 8px; }
  .login-box .sub { color: var(--muted); font-size: 0.85rem; margin-bottom: 32px; letter-spacing: 0.02em; }
  .login-box input {
    width: 100%; padding: 12px 16px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 8px; color: var(--text); font-size: 0.95rem; font-family: var(--font);
    outline: none; margin-bottom: 16px; text-align: center; letter-spacing: 1px;
  }
  .login-box input:focus { border-color: var(--accent); }
  .login-box button {
    width: 100%; padding: 12px; background: var(--accent); color: #0f1117; border: none;
    border-radius: 8px; font-size: 0.95rem; font-weight: 600; cursor: pointer; font-family: var(--font);
  }
  .login-box button:hover { background: var(--accent-hover); }
  .login-box button:disabled { opacity: 0.4; }
  .error { color: var(--red); font-size: 0.82rem; margin-bottom: 12px; min-height: 18px; }
</style>
</head>
<body>
<div class="login-box">
  <h1><i data-lucide="castle" style="width:2rem;height:2rem;display:inline-block;vertical-align:middle"></i></h1>
  <p class="sub">Clawd Control</p>
  <form onsubmit="login(event)">
    <input type="password" id="pw" placeholder="Password" autofocus autocomplete="current-password">
    <div class="error" id="err"></div>
    <button type="submit" id="btn">Enter</button>
  </form>
</div>
<script>
async function login(e) {
  e.preventDefault();
  const pw = document.getElementById('pw').value;
  const btn = document.getElementById('btn');
  const err = document.getElementById('err');
  btn.disabled = true; err.textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    const data = await res.json();
    if (data.ok) {
      window.location.href = '/';
    } else {
      err.textContent = data.error || 'Wrong password';
      btn.disabled = false;
    }
  } catch (e) {
    err.textContent = 'Connection error';
    btn.disabled = false;
  }
}
</script>
<script src="https://unpkg.com/lucide@0.462.0/dist/umd/lucide.min.js"></script>
<script>lucide.createIcons();</script>
</body>
</html>`;

const BIND = process.argv.find((_, i, a) => a[i - 1] === '--bind') || '0.0.0.0';

server.listen(PORT, BIND, () => {
  console.log(`🏰 Clawd Control v2.0`);
  console.log(`   http://${BIND}:${PORT}`);
  console.log(`   Agents: ${collector.agents.size}`);
  console.log(`   🔐 Auth: enabled (password in auth.json)`);
  console.log(`   🔒 Bound to ${BIND} (home network only)`);
});
