/**
 * Auto-discover agents from ~/.clawdbot/clawdbot.json
 * Fallback when agents.json doesn't exist.
 *
 * Reads the gateway config to find:
 *  - Gateway loopback port + auth token
 *  - Agent list with workspaces
 *  - Default workspace for agents without explicit workspace
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export function discoverAgents() {
  const clawdbotDir = join(homedir(), '.clawdbot');
  const configPath = join(clawdbotDir, 'clawdbot.json');

  if (!existsSync(configPath)) {
    console.log('ℹ️  No ~/.clawdbot/clawdbot.json found. Create agents.json manually.');
    return { agents: [], pollIntervalMs: 15000, hostMetricsIntervalMs: 30000 };
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.warn(`⚠️  Failed to parse ${configPath}: ${e.message}`);
    return { agents: [], pollIntervalMs: 15000, hostMetricsIntervalMs: 30000 };
  }

  // Gateway connection
  const port = config.gateway?.loopback?.port || 18789;
  const token = config.gateway?.auth?.token || '';
  if (!token) {
    console.warn('⚠️  No gateway auth token found in config.');
    return { agents: [], pollIntervalMs: 15000, hostMetricsIntervalMs: 30000 };
  }
  console.log(`📡 Gateway: localhost:${port}`);

  // Default workspace (used for agents without explicit workspace)
  const agentsConfig = config.agents || {};
  const defaults = agentsConfig.defaults || {};
  const defaultWorkspace = defaults.workspace || join(homedir(), 'clawd');

  // Agent list from config (can be under .agents or .list depending on version)
  const agentList = agentsConfig.agents || agentsConfig.list || [];
  const discovered = [];

  for (const agentCfg of agentList) {
    const id = agentCfg.id;
    if (!id) continue;

    const workspace = agentCfg.workspace || defaultWorkspace;
    let name = agentCfg.name || id.charAt(0).toUpperCase() + id.slice(1);
    let emoji = '🤖';

    // Try to read SOUL.md from workspace for name/emoji
    const soulPath = join(workspace, 'SOUL.md');
    if (existsSync(soulPath)) {
      try {
        const soul = readFileSync(soulPath, 'utf8').slice(0, 500);
        const nameMatch = soul.match(/You are (\w+)/i);
        if (nameMatch) name = nameMatch[1];
      } catch {}
    }

    // Try IDENTITY.md for emoji
    const idPath = join(workspace, 'IDENTITY.md');
    if (existsSync(idPath)) {
      try {
        const identity = readFileSync(idPath, 'utf8').slice(0, 500);
        const emojiMatch = identity.match(/\*\*Emoji:\*\*\s*(.+)/);
        if (emojiMatch) {
          const e = emojiMatch[1].trim();
          // Only use if it's an actual emoji (1-4 chars, not placeholder text)
          if (e && e.length <= 4 && !e.startsWith('*')) emoji = e;
        }
      } catch {}
    }

    discovered.push({
      id,
      gatewayAgentId: id,
      name,
      emoji,
      host: '127.0.0.1',
      port,
      token,
      workspace,
    });

    console.log(`  ✓ ${emoji} ${name} (${id}) → ${workspace}`);
  }

  if (discovered.length === 0) {
    // Fallback: scan ~/.clawdbot/agents/ directory for agent subdirs
    const agentsDir = join(clawdbotDir, 'agents');
    if (existsSync(agentsDir)) {
      const subdirs = readdirSync(agentsDir).filter(name => {
        try { return statSync(join(agentsDir, name)).isDirectory(); }
        catch { return false; }
      });
      for (const agentId of subdirs) {
        discovered.push({
          id: agentId,
          gatewayAgentId: agentId,
          name: agentId.charAt(0).toUpperCase() + agentId.slice(1),
          emoji: '🤖',
          host: '127.0.0.1',
          port,
          token,
          workspace: agentId === 'main' ? defaultWorkspace : join(defaultWorkspace, '..', 'clawd-agents', agentId),
        });
        console.log(`  ✓ 🤖 ${agentId} (directory scan)`);
      }
    }
  }

  console.log(`📋 Discovered ${discovered.length} agent(s)`);

  return {
    agents: discovered,
    pollIntervalMs: 15000,
    hostMetricsIntervalMs: 30000,
  };
}
