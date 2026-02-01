/**
 * Create Agent — Backend logic
 * 
 * Handles the full flow:
 *   1. Scaffold workspace files
 *   2. Register agent with clawdbot gateway
 *   3. Bind Telegram channel (if token provided)
 *   4. Update agents.json for the dashboard
 *   5. Return step-by-step log
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const DIR = new URL('.', import.meta.url).pathname;

// Read configuration from agents.json if it exists
let agentsConfig = {};
const agentsJsonPath = join(DIR, 'agents.json');
if (existsSync(agentsJsonPath)) {
  try {
    agentsConfig = JSON.parse(readFileSync(agentsJsonPath, 'utf8'));
  } catch {}
}

// Configurable base directory and default workspace
const BASE_DIR = process.env.CLAWD_AGENTS_DIR || 
                 agentsConfig.agentsBaseDir || 
                 join(process.env.HOME, 'clawd-agents');

const DEFAULT_WORKSPACE = process.env.CLAWD_DEFAULT_WORKSPACE ||
                          agentsConfig.agents?.[0]?.workspace ||
                          join(process.env.HOME, 'clawd');

function writeIfMissing(path, content) {
  if (!existsSync(path)) {
    writeFileSync(path, content, 'utf8');
    return true;
  }
  return false;
}

export async function createAgent({ name, emoji, soul, model, telegramToken }) {
  const steps = [];
  const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const displayName = name.charAt(0).toUpperCase() + name.slice(1);
  const workspace = join(BASE_DIR, id);
  const today = new Date().toISOString().split('T')[0];

  if (!id) {
    return { ok: false, error: 'Invalid name', steps: ['❌ Name is invalid'] };
  }

  // Check if agent already exists
  try {
    const existing = execSync('clawdbot agents list --json 2>/dev/null', { encoding: 'utf8' });
    const agents = JSON.parse(existing);
    if (agents.some(a => a.id === id)) {
      return { ok: false, error: 'Agent already exists', steps: [`❌ Agent "${id}" already exists`] };
    }
  } catch {}

  // 1. Create workspace
  steps.push(`📁 Creating workspace at ~/clawd-agents/${id}`);
  try {
    mkdirSync(join(workspace, 'memory'), { recursive: true });
    mkdirSync(join(workspace, 'skills'), { recursive: true });
    mkdirSync(join(workspace, 'scripts'), { recursive: true });
    mkdirSync(join(workspace, '.credentials'), { recursive: true });
  } catch (e) {
    return { ok: false, error: `Failed to create workspace: ${e.message}`, steps };
  }

  // 2. Scaffold files
  steps.push('📝 Writing identity files');

  const soulContent = soul
    ? `# SOUL.md - Who You Are

*You are ${displayName}. ${soul}*

## Core Truths

**Be direct.** No filler. No corporate speak. Just help.
**Have opinions.** You're allowed to disagree, recommend, and push back.
**Be resourceful.** Figure it out before asking.
**Earn trust through competence.** Be careful with external actions, bold with internal ones.

## Vibe

${soul}

## Continuity

Each session, you wake up fresh. Your files *are* your memory. Read them. Update them.`
    : `# SOUL.md - Who You Are

*You are ${displayName}. Define your personality here.*

## Core Truths

**Be direct.** No filler. No corporate speak. Just help.
**Have opinions.** You're allowed to disagree, recommend, and push back.
**Be resourceful.** Figure it out before asking.
**Earn trust through competence.** Be careful with external actions, bold with internal ones.

## Vibe

*(Define your personality, tone, and style here)*

## Continuity

Each session, you wake up fresh. Your files *are* your memory. Read them. Update them.`;

  writeIfMissing(join(workspace, 'SOUL.md'), soulContent);

  writeIfMissing(join(workspace, 'IDENTITY.md'), `# IDENTITY.md - Who Am I?

- **Name:** ${displayName}
- **Creature:** AI in your Clawdbot fleet
- **Vibe:** ${soul || '(customize me)'}
- **Emoji:** ${emoji}
- **Avatar:** *(set a workspace-relative path or URL)*`);

  writeIfMissing(join(workspace, 'MEMORY.md'), `# MEMORY.md - Long-Term Memory

*${displayName}'s curated memories. Updated over time.*

## Born
- Created on ${today} via Clawd Control
- Model: ${model}
- Workspace: ~/clawd-agents/${id}`);

  writeIfMissing(join(workspace, 'TASKS.md'), `# TASKS.md

## Inbox
- [ ] Introduce yourself to Miguel
- [ ] Customize SOUL.md with your personality
- [ ] Explore your workspace and tools

## In Progress

## Done`);

  writeIfMissing(join(workspace, 'TOOLS.md'), `# TOOLS.md - Local Notes

> Environment-specific details. Update as you discover things.

## Host
- **Machine:** ${execSync('hostname', { encoding: 'utf8' }).trim()}

---
*Updated: ${today}*`);

  writeIfMissing(join(workspace, 'HEARTBEAT.md'), `# HEARTBEAT.md

## Periodic Checks
- Review TASKS.md inbox — anything to triage?
- Check memory files — anything to update?

## Rule
Only HEARTBEAT_OK when genuinely nothing needs attention.`);

  writeIfMissing(join(workspace, 'BOOTSTRAP.md'), `# BOOTSTRAP.md - First Run

Welcome to existence, ${displayName}! ${emoji}

1. Read SOUL.md — customize it to be truly YOU
2. Read USER.md — this is Miguel, your human
3. Fill in IDENTITY.md with your details
4. Check TASKS.md — your first tasks are there
5. Delete this file when you're done

Created: ${today} via Clawd Control
Model: ${model}`);

  writeIfMissing(join(workspace, '.gitignore'), `.credentials/
*.pid
*.log
node_modules/`);

  // Copy shared files from default workspace
  const sharedFiles = ['AGENTS.md', 'USER.md'];
  for (const file of sharedFiles) {
    const src = join(DEFAULT_WORKSPACE, file);
    const dst = join(workspace, file);
    if (existsSync(src) && !existsSync(dst)) {
      copyFileSync(src, dst);
    }
  }

  // 3. Register with Clawdbot
  steps.push('🔗 Registering with gateway');
  try {
    const cmd = `clawdbot agents add "${id}" --workspace "${workspace}" --model "${model}" --non-interactive --json 2>&1`;
    const output = execSync(cmd, { encoding: 'utf8' });
    steps.push('✅ Agent registered');
  } catch (e) {
    steps.push(`⚠️ Registration warning: ${e.message.substring(0, 100)}`);
  }

  // 4. Set identity
  steps.push(`${emoji} Setting identity`);
  try {
    execSync(`clawdbot agents set-identity "${id}" --name "${displayName}" --emoji "${emoji}" 2>&1`, { encoding: 'utf8' });
  } catch {}

  // 5. Configure cross-agent spawning + Telegram binding (single config read/write)
  steps.push('🔄 Configuring agent permissions');
  
  let telegramVerified = false;
  let botUsername = '';
  
  // Verify Telegram token BEFORE touching config
  if (telegramToken) {
    steps.push('📱 Verifying Telegram bot token');
    try {
      const verify = execSync(`curl -s "https://api.telegram.org/bot${telegramToken}/getMe"`, { encoding: 'utf8' });
      const botInfo = JSON.parse(verify);
      if (!botInfo.ok) {
        steps.push('❌ Telegram token is invalid');
        return { ok: false, error: 'Invalid Telegram bot token', steps };
      }
      botUsername = botInfo.result.username;
      telegramVerified = true;
      steps.push(`✅ Verified: @${botUsername}`);
    } catch (e) {
      steps.push(`⚠️ Telegram verification failed: ${e.message.substring(0, 80)}`);
    }
  }

  // Single atomic config update — read once, modify, write once
  try {
    const configPath = join(process.env.HOME, '.clawdbot', 'clawdbot.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));

    // Cross-agent: main can spawn this agent
    const mainAgent = config.agents?.list?.find(a => a.id === 'main');
    if (mainAgent) {
      if (!mainAgent.subagents) mainAgent.subagents = {};
      if (!mainAgent.subagents.allowAgents) mainAgent.subagents.allowAgents = [];
      if (!mainAgent.subagents.allowAgents.includes(id)) {
        mainAgent.subagents.allowAgents.push(id);
      }
    }

    // Cross-agent: new agent can spawn back to main
    const newAgent = config.agents?.list?.find(a => a.id === id);
    if (newAgent) {
      if (!newAgent.subagents) newAgent.subagents = {};
      newAgent.subagents.allowAgents = ['main'];

      // Bind Telegram channel if verified
      if (telegramVerified) {
        newAgent.channels = {
          telegram: { botToken: telegramToken, dmPolicy: 'pairing' }
        };
      }
    }

    // Enable agent-to-agent messaging
    if (!config.tools) config.tools = {};
    if (!config.tools.agentToAgent) config.tools.agentToAgent = {};
    config.tools.agentToAgent.enabled = true;

    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    steps.push('✅ Cross-agent permissions configured');
    if (telegramVerified) steps.push('📱 Telegram channel bound');
    else if (telegramToken) steps.push('⏭️ Telegram binding skipped (verification failed)');
    else steps.push('⏭️ Telegram skipped');
  } catch (e) {
    steps.push(`⚠️ Config update: ${e.message.substring(0, 80)}`);
  }

  // 6. Update dashboard agents.json
  steps.push('🏰 Adding to Clawd Control');
  try {
    const dashConfig = JSON.parse(readFileSync(join(DIR, 'agents.json'), 'utf8'));
    if (!dashConfig.agents.some(a => a.id === id)) {
      const configPath = join(process.env.HOME, '.clawdbot', 'clawdbot.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));

      dashConfig.agents.push({
        id,
        name: displayName,
        emoji,
        host: '127.0.0.1',
        port: config.gateway?.port || 18789,
        token: config.gateway?.auth?.token || '',
        workspace,
        machine: execSync('hostname', { encoding: 'utf8' }).trim(),
      });
      writeFileSync(join(DIR, 'agents.json'), JSON.stringify(dashConfig, null, 2), 'utf8');
    }
    steps.push('✅ Dashboard updated');
  } catch (e) {
    steps.push(`⚠️ Dashboard: ${e.message.substring(0, 80)}`);
  }

  // 7. Hot-reload gateway config (SIGUSR1 preserves sessions, no restart)
  steps.push('🔄 Reloading gateway config');
  try {
    // Find gateway PID and send SIGUSR1 for hot reload
    const pid = execSync("pgrep -f 'clawdbot.*gateway' 2>/dev/null || pgrep -f 'node.*clawdbot' 2>/dev/null", {
      encoding: 'utf8'
    }).trim().split('\n')[0];

    if (pid && /^\d+$/.test(pid)) {
      execSync(`kill -USR1 ${pid} 2>&1`, { encoding: 'utf8' });
      steps.push('✅ Config reloaded (sessions preserved)');
    } else {
      throw new Error('Gateway PID not found');
    }
  } catch {
    // Fallback: try clawdbot system event to nudge the gateway
    try {
      execSync('clawdbot system event --mode now --text "New agent created — config reloaded" 2>&1', {
        encoding: 'utf8', timeout: 5000
      });
      steps.push('⚠️ Config reload signal sent — gateway will pick up changes on next cycle');
    } catch {
      steps.push('⚠️ Could not signal gateway — restart manually: clawdbot gateway restart');
    }
  }

  steps.push(`🎉 ${displayName} is ready!`);

  return {
    ok: true,
    id,
    name: displayName,
    emoji,
    workspace,
    model,
    hasTelegram: !!telegramToken,
    message: telegramToken
      ? `${displayName} is live! Open Telegram and message the bot to start chatting.`
      : `${displayName} is live! Add a Telegram bot later to chat directly.`,
    steps,
  };
}
