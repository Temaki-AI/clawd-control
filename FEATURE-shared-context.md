# Feature: Shared Context Visibility in Clawd Control

## Goal
Give Miguel full visibility into the Fellowship's operating system — shared context files, workspace files, and cross-agent coordination — directly from the Clawd Control dashboard.

## What needs to happen

### 1. Add missing agents to agents.json
- Gwaihir (gwaihir, port 18789, workspace ~/clawd-agents/gwaihir)
- Beorn (beorn, port 18789, workspace ~/clawd-agents/beorn)

### 2. New API endpoint: GET /api/shared-context
Returns the contents of ~/shared-context/ files:
- THESIS.md (Miguel's priorities)
- FEEDBACK-LOG.md (cross-agent corrections)
- Any future files added to this directory

### 3. New page: shared-context.html (or section in dashboard)
- Renders THESIS.md and FEEDBACK-LOG.md as formatted markdown
- Shows last-modified timestamps
- Read-only view (editing happens via agents)

### 4. Enhance agent detail view
The /config endpoint already reads SOUL.md, AGENTS.md, USER.md, TOOLS.md.
Add:
- HEARTBEAT.md
- MEMORY.md
- IDENTITY.md
- ACTIVE_WORK.md
- TASKS.md (if exists)
- memory/ directory listing (daily logs)
- Show file sizes and last-modified dates

### 5. New page or dashboard section: Fellowship Operations Overview
A single view showing for ALL agents at once:
- Agent name + emoji + model
- Last activity timestamp (from sessions API)
- Current ACTIVE_WORK.md summary (first 3 lines)
- HEARTBEAT.md status
- SOUL.md line count (flag if >60)
- Memory size (total bytes in memory/)
- Cron job count + last run times
- Health indicators: 🟢 active, 🟡 idle >24h, 🔴 idle >48h

### 6. Navigation
Add "Shared Context" and "Operations" to the sidebar nav.

## Technical notes
- Server: server.mjs (single-file Node.js server, no framework)
- Frontend: vanilla HTML + JS, no build step
- Layout: layout.js provides shared sidebar/nav
- Auth: existing auth.json system
- Files: use readFileSync with safeRead pattern already in codebase
- Shared context dir: ~/shared-context/ (or process.env.HOME + '/shared-context')
