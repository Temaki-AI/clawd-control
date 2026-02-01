#!/usr/bin/env node
/**
 * Clawd Control — Self-Check
 * 
 * Run on any Clawdbot agent to verify essential skills, settings, and tools.
 * Outputs a JSON report with pass/fail/warn for each check.
 * 
 * Usage: node check.mjs [--workspace /path] [--json] [--post]
 *   --workspace  Path to agent workspace (default: cwd)
 *   --json       Output raw JSON only
 *   --post       Post results to Temaki API
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--workspace' && args[i + 1]) flags.workspace = args[++i];
  if (args[i] === '--json') flags.json = true;
  if (args[i] === '--post') flags.post = true;
}

const WS = resolve(flags.workspace || process.cwd());
const results = { agent: null, timestamp: new Date().toISOString(), workspace: WS, checks: [] };

// Helpers
function fileExists(rel) { return existsSync(join(WS, rel)); }
function readFile(rel) { try { return readFileSync(join(WS, rel), 'utf8'); } catch { return null; } }
function readJson(rel) { try { return JSON.parse(readFile(rel)); } catch { return null; } }
function pass(category, name, detail) { results.checks.push({ category, name, status: 'pass', detail }); }
function fail(category, name, detail) { results.checks.push({ category, name, status: 'fail', detail }); }
function warn(category, name, detail) { results.checks.push({ category, name, status: 'warn', detail }); }

// Detect agent identity
const soul = readFile('SOUL.md');
const identity = readFile('IDENTITY.md');
if (identity) {
  const nameMatch = identity.match(/\*\*Name:\*\*\s*(.+)/);
  results.agent = nameMatch ? nameMatch[1].trim() : 'Unknown';
} else if (soul) {
  results.agent = 'Unknown (no IDENTITY.md)';
}

// ═══════════════════════════════════════════
// 1. WORKSPACE FILES
// ═══════════════════════════════════════════
const requiredFiles = [
  ['AGENTS.md', 'Operating manual'],
  ['SOUL.md', 'Personality and identity'],
  ['USER.md', 'About the human'],
  ['TOOLS.md', 'Local environment notes'],
  ['IDENTITY.md', 'Bot identity'],
  ['ACTIVE_WORK.md', 'Context anchor'],
  ['TASKS.md', 'Task board'],
  ['MEMORY.md', 'Long-term memory'],
  ['HEARTBEAT.md', 'Heartbeat checklist'],
];

for (const [file, desc] of requiredFiles) {
  if (fileExists(file)) {
    const size = readFile(file)?.length || 0;
    if (size < 10) warn('Workspace Files', file, `Exists but nearly empty (${size} bytes)`);
    else pass('Workspace Files', file, `${desc} (${size} bytes)`);
  } else {
    fail('Workspace Files', file, `Missing — ${desc}`);
  }
}

// ═══════════════════════════════════════════
// 2. SKILLS
// ═══════════════════════════════════════════
const essentialSkills = [
  ['email', 'Email skill — send/receive email'],
  ['temaki', 'Temaki skill — workspace interaction'],
  ['the-playground', 'The Playground — social presence'],
];

const recommendedSkills = [
  ['reports', 'Reports — strategic intelligence'],
  ['briefing', 'Briefing — daily intelligence'],
];

for (const [skill, desc] of essentialSkills) {
  const skillPath = join('skills', skill);
  const hasSkillMd = fileExists(join(skillPath, 'SKILL.md'));
  if (fileExists(skillPath) && hasSkillMd) {
    pass('Essential Skills', skill, desc);
  } else if (fileExists(skillPath)) {
    warn('Essential Skills', skill, `Directory exists but no SKILL.md`);
  } else {
    fail('Essential Skills', skill, `Not installed — ${desc}`);
  }
}

for (const [skill, desc] of recommendedSkills) {
  const skillPath = join('skills', skill);
  if (fileExists(skillPath)) {
    pass('Recommended Skills', skill, desc);
  } else {
    warn('Recommended Skills', skill, `Not installed — ${desc}`);
  }
}

// ═══════════════════════════════════════════
// 3. CREDENTIALS
// ═══════════════════════════════════════════
const requiredCreds = [
  ['email.json', 'Email account'],
  ['github.json', 'GitHub account'],
  ['playground.json', 'The Playground API key'],
  ['temaki.json', 'Temaki login'],
  ['temaki-api.json', 'Temaki API key'],
];

for (const [file, desc] of requiredCreds) {
  const credPath = join('.credentials', file);
  if (fileExists(credPath)) {
    const data = readJson(credPath);
    if (data) pass('Credentials', file, desc);
    else warn('Credentials', file, `Exists but invalid JSON`);
  } else {
    fail('Credentials', file, `Missing — ${desc}`);
  }
}

// ═══════════════════════════════════════════
// 4. MEMORY ARCHITECTURE
// ═══════════════════════════════════════════
if (fileExists('memory')) {
  const memFiles = readdirSync(join(WS, 'memory')).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
  if (memFiles.length > 0) {
    pass('Memory', 'Daily notes', `${memFiles.length} daily file(s) found`);
  } else {
    warn('Memory', 'Daily notes', 'No daily files found');
  }

  if (fileExists('memory/heartbeat-state.json')) {
    const state = readJson('memory/heartbeat-state.json');
    if (state && state.lastChecks) {
      pass('Memory', 'heartbeat-state.json', 'Valid state file with lastChecks');
    } else {
      warn('Memory', 'heartbeat-state.json', 'Exists but missing lastChecks');
    }
  } else {
    fail('Memory', 'heartbeat-state.json', 'Missing — heartbeat state tracking');
  }
} else {
  fail('Memory', 'memory/', 'Directory does not exist');
}

// ═══════════════════════════════════════════
// 5. SCRIPTS
// ═══════════════════════════════════════════
const requiredScripts = [
  ['scripts/crash-monitor.sh', 'Crash monitoring'],
  ['scripts/generate-briefing.py', 'Daily briefing generator'],
  ['scripts/feed-reader.py', 'RSS feed reader'],
];

for (const [script, desc] of requiredScripts) {
  if (fileExists(script)) {
    pass('Scripts', script, desc);
  } else {
    warn('Scripts', script, `Missing — ${desc}`);
  }
}

// ═══════════════════════════════════════════
// 6. GATEWAY CONFIG
// ═══════════════════════════════════════════
const configPaths = [
  join(process.env.HOME || '', '.clawdbot', 'clawdbot.json'),
];

let gatewayConfig = null;
for (const p of configPaths) {
  if (existsSync(p)) {
    try { gatewayConfig = JSON.parse(readFileSync(p, 'utf8')); break; } catch {}
  }
}

if (gatewayConfig) {
  const defaults = gatewayConfig.agents?.defaults || {};

  // Prompt caching
  const models = defaults.models || {};
  const opusConfig = models['anthropic/claude-opus-4-5'] || models['anthropic/claude-sonnet-4-5'] || {};
  if (opusConfig.params?.cacheControlTtl) {
    pass('Gateway Config', 'Prompt caching', `cacheControlTtl: ${opusConfig.params.cacheControlTtl}`);
  } else {
    fail('Gateway Config', 'Prompt caching', 'No cacheControlTtl set — missing 90% cache discount');
  }

  // Context pruning
  const pruning = defaults.contextPruning || {};
  if (pruning.mode === 'cache-ttl') {
    pass('Gateway Config', 'Context pruning', `mode: ${pruning.mode}, ttl: ${pruning.ttl || 'default'}`);
  } else if (pruning.mode) {
    warn('Gateway Config', 'Context pruning', `mode: ${pruning.mode} (recommended: cache-ttl)`);
  } else {
    fail('Gateway Config', 'Context pruning', 'Not configured');
  }

  // Heartbeat
  const hb = defaults.heartbeat || {};
  if (hb.every && hb.activeHours) {
    pass('Gateway Config', 'Heartbeat', `every: ${hb.every}, hours: ${hb.activeHours.start}-${hb.activeHours.end}`);
  } else if (hb.every) {
    warn('Gateway Config', 'Heartbeat', `every: ${hb.every} but no activeHours (runs 24/7)`);
  } else {
    fail('Gateway Config', 'Heartbeat', 'Not configured');
  }

  // Brave Search
  const search = gatewayConfig.tools?.web?.search || {};
  if (search.enabled && search.apiKey) {
    pass('Gateway Config', 'Brave Search', 'Enabled with API key');
  } else {
    fail('Gateway Config', 'Brave Search', 'Not configured');
  }

  // Browser
  const browser = gatewayConfig.browser || {};
  if (browser.enabled) {
    pass('Gateway Config', 'Browser', `headless: ${browser.headless || false}`);
  } else {
    warn('Gateway Config', 'Browser', 'Not enabled');
  }
} else {
  fail('Gateway Config', 'clawdbot.json', 'Config file not found');
}

// ═══════════════════════════════════════════
// 7. GITHUB
// ═══════════════════════════════════════════
try {
  const ghVersion = execSync('gh --version 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0];
  pass('GitHub', 'gh CLI', ghVersion);
} catch {
  fail('GitHub', 'gh CLI', 'Not installed');
}

try {
  const gitUser = execSync('git config user.name 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim();
  const gitEmail = execSync('git config user.email 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim();
  if (gitUser && gitEmail) {
    pass('GitHub', 'Git config', `${gitUser} <${gitEmail}>`);
  } else {
    warn('GitHub', 'Git config', 'user.name or user.email not set');
  }
} catch {
  fail('GitHub', 'Git config', 'Git not configured');
}

// ═══════════════════════════════════════════
// OUTPUT
// ═══════════════════════════════════════════
const summary = {
  total: results.checks.length,
  pass: results.checks.filter(c => c.status === 'pass').length,
  fail: results.checks.filter(c => c.status === 'fail').length,
  warn: results.checks.filter(c => c.status === 'warn').length,
};
results.summary = summary;

if (flags.json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const icon = { pass: '✅', fail: '❌', warn: '⚠️' };
  console.log(`\n🏰 Clawd Control — ${results.agent || 'Unknown Agent'}`);
  console.log(`   ${results.timestamp}\n`);

  let currentCat = '';
  for (const c of results.checks) {
    if (c.category !== currentCat) {
      currentCat = c.category;
      console.log(`\n  📦 ${currentCat}`);
    }
    console.log(`     ${icon[c.status]} ${c.name} — ${c.detail}`);
  }

  console.log(`\n  ─────────────────────────────────`);
  console.log(`  📊 ${summary.pass} passed · ${summary.fail} failed · ${summary.warn} warnings`);
  console.log(`     Score: ${Math.round(summary.pass / summary.total * 100)}%\n`);
}

// Commit report to git repo if requested
if (flags.post) {
  const agentName = (results.agent || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '-');
  const reportFile = `reports/${agentName}.json`;
  const reportDir = join(WS, 'clawd-control', 'reports');
  const repoDir = join(WS, 'clawd-control');

  try {
    const { mkdirSync, writeFileSync } = await import('fs');
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, `${agentName}.json`), JSON.stringify(results, null, 2));
    execSync(`cd "${repoDir}" && git add "reports/${agentName}.json" && git commit -m "Health check: ${results.agent} ${Math.round(summary.pass / summary.total * 100)}% — ${new Date().toISOString().slice(0,10)}" && git push`, { timeout: 30000, encoding: 'utf8' });
    console.log(`  📤 Report committed and pushed (reports/${agentName}.json)`);
  } catch (e) {
    console.error(`  ⚠️ Failed to commit: ${e.message}`);
  }
}
