/**
 * layout.js — Shared layout module for Clawd Control
 *
 * Injects sidebar + topbar + design-system CSS into every page.
 * Manages SSE connection, theme, sidebar collapse, and keyboard shortcuts.
 *
 * Usage: include <script src="/layout.js"></script> after <main class="main">
 *        Each page wraps its content in <main class="main">...</main>
 */
(function () {
  'use strict';

  // ════════════════════════════════════════════════════
  // STATE
  // ════════════════════════════════════════════════════

  const agentState = (window.agentState = window.agentState || {});
  window.hostState = window.hostState || {};
  let evtSource = null;

  // ════════════════════════════════════════════════════
  // PAGE DETECTION
  // ════════════════════════════════════════════════════

  const path = window.location.pathname;
  const activePage =
    path === '/' || path === '/dashboard.html'
      ? 'dashboard'
      : path === '/create.html'
        ? 'create'
        : path.startsWith('/agent/')
          ? 'agent-detail'
          : path === '/gandalf-view.html'
            ? 'gandalf'
            : 'other';
  const activeAgentId =
    activePage === 'agent-detail'
      ? decodeURIComponent(path.split('/').filter(Boolean).pop())
      : null;

  window.layoutActivePage = activePage;
  window.layoutActiveAgentId = activeAgentId;

  // ════════════════════════════════════════════════════
  // THEME — apply before first paint
  // ════════════════════════════════════════════════════

  if (localStorage.getItem('cc-theme') === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  }

  // ════════════════════════════════════════════════════
  // CSS INJECTION
  // ════════════════════════════════════════════════════

  const LAYOUT_CSS = `
/* ═══════════════════════════════════════════
   CLAWD CONTROL — Design System & Layout
   Injected by layout.js
   ═══════════════════════════════════════════ */

:root {
  --bg-primary: #0a0c10;
  --bg-secondary: #13151a;
  --bg-tertiary: #1a1d27;
  --surface: #232732;
  --surface-hover: #2a2f3d;
  --border: #363b4d;
  --border-subtle: #252835;

  --text-primary: #f4f4f5;
  --text-secondary: #a1a1aa;
  --text-tertiary: #71717a;

  --success: #22c55e;
  --success-bg: rgba(34, 197, 94, 0.1);
  --error: #ef4444;
  --error-bg: rgba(239, 68, 68, 0.1);
  --warning: #f59e0b;
  --warning-bg: rgba(245, 158, 11, 0.1);
  --info: #3b82f6;
  --info-bg: rgba(59, 130, 246, 0.1);

  --accent: #c9a44a;
  --accent-hover: #d4b05f;
  --accent-bg: rgba(201, 164, 74, 0.1);

  --success-dim: rgba(34, 197, 94, 0.06);
  --error-dim: rgba(239, 68, 68, 0.06);
  --warning-dim: rgba(245, 158, 11, 0.06);
  --accent-dim: rgba(201, 164, 74, 0.06);

  --sidebar-w: 220px;

  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
  --font-mono: 'SF Mono', 'Consolas', 'Monaco', monospace;
  --font: var(--font-sans);

  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;

  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 12px 40px rgba(0, 0, 0, 0.5);

  --transition-fast: 150ms cubic-bezier(0.4, 0, 0.2, 1);
  --transition-base: 250ms cubic-bezier(0.4, 0, 0.2, 1);
}

/* ── Light Theme ───────────────────────── */

[data-theme="light"] {
  --bg-primary: #f5f2ee;
  --bg-secondary: #fdfbf9;
  --bg-tertiary: #ece8e3;
  --surface: #ffffff;
  --surface-hover: #f7f5f2;
  --border: #ddd8d0;
  --border-subtle: #e8e4de;

  --text-primary: #1a1d23;
  --text-secondary: #5a5d66;
  --text-tertiary: #8a8d96;

  --success: #059669;
  --success-bg: rgba(5, 150, 105, 0.08);
  --error: #dc2626;
  --error-bg: rgba(220, 38, 38, 0.08);
  --warning: #d97706;
  --warning-bg: rgba(217, 119, 6, 0.08);
  --info: #2563eb;
  --info-bg: rgba(37, 99, 235, 0.08);

  --accent: #a07d2e;
  --accent-hover: #8a6b22;
  --accent-bg: rgba(160, 125, 46, 0.08);

  --success-dim: rgba(5, 150, 105, 0.04);
  --error-dim: rgba(220, 38, 38, 0.04);
  --warning-dim: rgba(217, 119, 6, 0.04);
  --accent-dim: rgba(160, 125, 46, 0.04);

  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.06);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.08);
  --shadow-lg: 0 12px 40px rgba(0, 0, 0, 0.1);
}

/* ── Reset & Base ──────────────────────── */

*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html { font-size: 16px; -webkit-font-smoothing: antialiased; color-scheme: dark; }
[data-theme="light"] { color-scheme: light; }

h1, h2, h3 { line-height: 1.2; font-weight: 700; letter-spacing: -0.02em; }

/* ── App Layout (CSS Grid) ─────────────── */

body {
  font-family: var(--font-sans);
  color: var(--text-primary);
  background: var(--bg-primary);
  line-height: 1.5;
  height: 100vh;
  overflow: hidden;
  display: grid;
  grid-template-rows: auto 1fr;
  grid-template-columns: var(--sidebar-w) 1fr;
  transition: background-color 0.35s ease, color 0.35s ease;
}
body.sidebar-collapsed { grid-template-columns: 0px 1fr; }
body.sidebar-collapsed .sidebar { width: 0; padding: 0; overflow: hidden; border: none; }
body.sidebar-collapsed .topbar { grid-column: 1 / -1; }

/* ── Topbar ────────────────────────────── */

.topbar {
  grid-column: 1 / -1;
  padding: 0 20px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  z-index: 100;
}
.topbar-left { display: flex; align-items: center; gap: 10px; }
.topbar-left .status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--text-tertiary); flex-shrink: 0;
  transition: all var(--transition-base);
}
.topbar-left .status-dot.live {
  background: var(--success);
  box-shadow: 0 0 8px var(--success), 0 0 16px rgba(34,197,94,0.15);
  animation: pulse 2s infinite;
}
.topbar-left .status-dot.dead { background: var(--error); box-shadow: 0 0 6px var(--error); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

.topbar-title {
  font-size: 0.9rem; font-weight: 700; color: var(--text-primary);
  letter-spacing: -0.02em;
}
.topbar-time {
  font-size: 0.75rem; color: var(--text-tertiary); margin-left: 8px;
  font-variant-numeric: tabular-nums;
}
.topbar-right { display: flex; align-items: center; gap: 2px; }

/* Fleet health bar in topbar */
.fleet-bar {
  width: 120px; height: 3px; border-radius: 2px; overflow: hidden;
  display: flex; gap: 1px; margin-left: 12px;
}
.fleet-bar .seg { flex: 1; border-radius: 1px; transition: background 0.5s; }
.fleet-bar .seg.ok { background: var(--success); }
.fleet-bar .seg.warn { background: var(--warning); }
.fleet-bar .seg.err { background: var(--error); }
.fleet-bar .seg.off { background: var(--border-subtle); }

/* ── Sidebar ───────────────────────────── */

.sidebar {
  grid-row: 2;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
  transition: width 0.25s ease;
}

.sidebar-section {
  padding: 16px 12px 6px;
  font-size: 0.6rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.1em; color: var(--text-tertiary);
}

.nav-item {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 12px; margin: 1px 8px;
  border-radius: var(--radius-sm);
  font-size: 0.8rem; font-weight: 500; color: var(--text-secondary);
  cursor: pointer; transition: all var(--transition-fast);
  text-decoration: none; position: relative;
}
.nav-item:hover { background: var(--surface); color: var(--text-primary); }
.nav-item.active { background: var(--surface); color: var(--text-primary); font-weight: 600; }
.nav-item .nav-icon { width: 16px; height: 16px; opacity: 0.6; flex-shrink: 0; }
.nav-item .nav-emoji { font-size: 1rem; flex-shrink: 0; width: 20px; text-align: center; }
.nav-item .nav-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Sidebar badges */
.nav-badges { display: flex; gap: 3px; flex-shrink: 0; }
.nav-badge {
  font-size: 0.6rem; font-weight: 700; min-width: 16px; height: 16px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 8px; padding: 0 4px;
}
.nav-badge.pass { background: var(--success-bg); color: var(--success); }
.nav-badge.warn { background: var(--warning-bg); color: var(--warning); }
.nav-badge.fail { background: var(--error-bg); color: var(--error); }
.nav-badge.info { background: var(--info-bg); color: var(--info); }

.sidebar-spacer { flex: 1; }

.sidebar-footer {
  padding: 10px 12px;
  border-top: 1px solid var(--border-subtle);
  display: flex; align-items: center; gap: 4px;
}
.sidebar-footer .sf-btn {
  width: 32px; height: 32px; border: none; border-radius: var(--radius-sm);
  background: none; color: var(--text-tertiary); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all var(--transition-fast); font-size: 0.85rem;
}
.sidebar-footer .sf-btn:hover { background: var(--surface); color: var(--text-primary); }
.sidebar-footer .sf-label {
  flex: 1; text-align: right; font-size: 0.65rem; color: var(--text-tertiary);
  letter-spacing: -0.01em;
}

/* ── Main Content ──────────────────────── */

.main {
  grid-row: 2;
  overflow-y: auto;
  padding: 20px 24px;
  background: var(--bg-primary);
  background-image: radial-gradient(ellipse at 50% 0%, rgba(201, 164, 74, 0.03) 0%, transparent 50%);
}
[data-theme="light"] .main {
  background-image: radial-gradient(ellipse at 50% 0%, rgba(160, 125, 46, 0.04) 0%, transparent 50%);
}

/* ── Toast ─────────────────────────────── */

.toast {
  position: fixed; bottom: 24px; right: 24px; padding: 10px 18px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md);
  font-size: 0.8rem; z-index: 200; box-shadow: var(--shadow-lg);
  animation: slideIn 0.3s ease;
}
.toast.success { border-color: var(--success); color: var(--success); }
.toast.error { border-color: var(--error); color: var(--error); }

/* ── Animations ────────────────────────── */

@keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
@keyframes fadeUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
.fade-up { animation: fadeUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) both; }

/* ── Scrollbar ─────────────────────────── */

::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 10px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.16); }
[data-theme="light"] ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); }
[data-theme="light"] ::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.2); }

/* ── Responsive ────────────────────────── */

@media (max-width: 800px) {
  body { grid-template-columns: 0px 1fr; }
  .sidebar { display: none; }
  .main { padding: 16px; }
}

/* ── Accessibility ─────────────────────── */

.nav-item:focus-visible, .sf-btn:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}
*:focus:not(:focus-visible) { outline: none; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}

/* ── Lucide Icons (base) ───────────────── */

[data-lucide] {
  width: 1em; height: 1em; display: inline-block;
  vertical-align: -0.125em; flex-shrink: 0;
}
`;

  const styleEl = document.createElement('style');
  styleEl.id = 'layout-css';
  styleEl.textContent = LAYOUT_CSS;
  // Prepend so page-specific styles can override
  document.head.insertBefore(styleEl, document.head.firstChild);

  // ════════════════════════════════════════════════════
  // DOM INJECTION
  // ════════════════════════════════════════════════════

  function init() {
    const main = document.querySelector('main.main');
    if (!main) {
      console.warn('[layout.js] No <main class="main"> element found');
      return;
    }

    // Restore sidebar collapse state
    if (localStorage.getItem('cc-sidebar') === 'collapsed') {
      document.body.classList.add('sidebar-collapsed');
    }

    // ── Topbar ──
    const topbar = document.createElement('div');
    topbar.className = 'topbar';
    topbar.innerHTML = `
      <div class="topbar-left">
        <span class="status-dot" id="connDot"></span>
        <span class="topbar-title">Clawd Control</span>
        <span class="topbar-time" id="topbarTime"></span>
        <div class="fleet-bar" id="fleetBar"></div>
      </div>
      <div class="topbar-right"></div>
    `;

    // ── Sidebar ──
    const sidebar = document.createElement('aside');
    sidebar.className = 'sidebar';
    sidebar.id = 'sidebar';
    sidebar.innerHTML = buildSidebarHTML();

    // Insert before main: topbar first, then sidebar
    main.parentNode.insertBefore(topbar, main);
    main.parentNode.insertBefore(sidebar, main);

    // Start SSE
    connectSSE();

    // Start clock
    updateClock();
    setInterval(updateClock, 30000);

    // Update theme icon
    updateThemeIcon();

    // Refresh lucide icons if already loaded
    refreshIcons();
  }

  function buildSidebarHTML() {
    const isActive = (page) => (activePage === page ? ' active' : '');
    return `
      <a href="/" class="nav-item${isActive('dashboard')}">
        <i data-lucide="layout-dashboard" class="nav-icon"></i>
        <span class="nav-label">Overview</span>
      </a>

      <div class="sidebar-section">Agents</div>
      <div id="sidebarAgents">
        <div class="nav-item" style="color:var(--text-tertiary);font-size:0.72rem;cursor:default">
          Connecting…
        </div>
      </div>

      <div class="sidebar-section">Actions</div>
      <a href="/create.html" class="nav-item${isActive('create')}">
        <i data-lucide="plus" class="nav-icon"></i>
        <span class="nav-label">New Agent</span>
      </a>
      <div class="nav-item" onclick="window._layoutLogout()">
        <i data-lucide="log-out" class="nav-icon"></i>
        <span class="nav-label">Logout</span>
      </div>

      <div class="sidebar-spacer"></div>

      <div class="sidebar-footer">
        <button class="sf-btn" onclick="window.toggleSidebar()" title="Collapse sidebar [B]">
          <i data-lucide="panel-left-close" style="width:16px;height:16px"></i>
        </button>
        <button class="sf-btn" onclick="window.toggleTheme()" id="themeBtn" title="Toggle theme [T]">
          <i data-lucide="moon" style="width:16px;height:16px" id="themeIcon"></i>
        </button>
        <span class="sf-label">v3</span>
      </div>
    `;
  }

  // ════════════════════════════════════════════════════
  // SSE CONNECTION
  // ════════════════════════════════════════════════════

  function connectSSE() {
    evtSource = new EventSource('/api/stream');

    evtSource.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'snapshot') {
          if (msg.data.agents) {
            for (const [id, st] of Object.entries(msg.data.agents))
              agentState[id] = st;
          }
          if (msg.data.host) window.hostState = msg.data.host;
          renderSidebar();
          renderFleetBar();
          updateClock();
          document.dispatchEvent(new CustomEvent('layout:snapshot'));
        } else if (msg.type === 'agent') {
          agentState[msg.id] = msg.data;
          renderSidebar();
          renderFleetBar();
          document.dispatchEvent(
            new CustomEvent('layout:agent-update', { detail: { id: msg.id } })
          );
        } else if (msg.type === 'host') {
          window.hostState = msg.data;
          document.dispatchEvent(new CustomEvent('layout:host-update'));
        }
      } catch (err) {
        /* ignore parse errors */
      }
    };

    evtSource.onopen = () => {
      const dot = document.getElementById('connDot');
      if (dot) dot.className = 'status-dot live';
    };

    evtSource.onerror = () => {
      const dot = document.getElementById('connDot');
      if (dot) dot.className = 'status-dot dead';
      setTimeout(() => {
        evtSource?.close();
        connectSSE();
      }, 5000);
    };
  }

  // ════════════════════════════════════════════════════
  // SIDEBAR RENDERING
  // ════════════════════════════════════════════════════

  function renderSidebar() {
    const container = document.getElementById('sidebarAgents');
    if (!container) return;
    const ids = Object.keys(agentState).sort();
    if (ids.length === 0) {
      container.innerHTML =
        '<div class="nav-item" style="color:var(--text-tertiary);font-size:0.72rem;cursor:default">No agents</div>';
      return;
    }
    container.innerHTML = ids
      .map((id) => {
        const a = agentState[id];
        const health = computeHealth(a);
        const checks = health.checks;
        const ok = checks.filter((c) => c.s === 'ok').length;
        const warn = checks.filter((c) => c.s === 'warn').length;
        const fail = checks.filter((c) => c.s === 'err').length;
        const isActive =
          activePage === 'agent-detail' && activeAgentId === id;
        return `<a href="/agent/${encodeURIComponent(id)}" class="nav-item${isActive ? ' active' : ''}" tabindex="0">
        <span class="nav-emoji">${a.emoji || '🤖'}</span>
        <span class="nav-label">${a.name || id}</span>
        <span class="nav-badges">
          ${ok ? `<span class="nav-badge pass">${ok}</span>` : ''}
          ${warn ? `<span class="nav-badge warn">${warn}</span>` : ''}
          ${fail ? `<span class="nav-badge fail">${fail}</span>` : ''}
        </span>
      </a>`;
      })
      .join('');
    refreshIcons();
  }

  function renderFleetBar() {
    const fb = document.getElementById('fleetBar');
    if (!fb) return;
    const ids = Object.keys(agentState).sort();
    fb.innerHTML = '';
    ids.forEach((id) => {
      const h = computeHealth(agentState[id]);
      const s = document.createElement('div');
      s.className = `seg ${h.level === 'healthy' ? 'ok' : h.level === 'degraded' ? 'warn' : h.level === 'down' ? 'err' : 'off'}`;
      fb.appendChild(s);
    });
  }

  // ════════════════════════════════════════════════════
  // HEALTH COMPUTATION (shared across pages)
  // ════════════════════════════════════════════════════

  function computeHealth(a) {
    const checks = [];
    let level = 'healthy';

    // Gateway
    checks.push({
      name: 'Gateway',
      s: a.online ? 'ok' : 'err',
      d: a.online ? 'Connected' : a.error || 'Offline',
    });
    if (!a.online) level = 'down';

    // Channels
    const channels = extractChannels(a);
    if (channels.length > 0) {
      const anyErr = channels.some((c) => c.status === 'error');
      const allOk = channels.every((c) => c.status === 'connected');
      checks.push({
        name: 'Channels',
        s: anyErr ? 'err' : allOk ? 'ok' : 'warn',
        d: `${channels.filter((c) => c.status === 'connected').length}/${channels.length}`,
      });
      if (anyErr && level === 'healthy') level = 'degraded';
    } else {
      checks.push({ name: 'Channels', s: 'off', d: 'None' });
    }

    // Heartbeat
    const hb = getHeartbeatState(a);
    if (hb === 'enabled') {
      const ts = getHeartbeatTs(a);
      const stale = ts && Date.now() - ts > 7200000;
      checks.push({
        name: 'Heartbeat',
        s: stale ? 'warn' : 'ok',
        d: stale ? 'Stale' : 'Active',
      });
      if (stale && level === 'healthy') level = 'degraded';
    } else {
      checks.push({ name: 'Heartbeat', s: 'off', d: 'Disabled' });
      if (level === 'healthy') level = 'idle';
    }

    // Sessions
    const sessions = _extractSessionsBasic(a);
    const recent = sessions.filter((s) => s.ageMs < 3600000);
    checks.push({
      name: 'Sessions',
      s: recent.length > 0 ? 'ok' : 'off',
      d: `${sessions.length} total`,
    });

    // Last poll
    if (a.lastSeen) {
      const ago = Date.now() - a.lastSeen;
      checks.push({
        name: 'Last Poll',
        s: ago < 60000 ? 'ok' : ago < 120000 ? 'warn' : 'err',
        d: timeAgo(a.lastSeen),
      });
    }

    return { level, checks };
  }

  // ── Data extractors ──

  function extractChannels(a) {
    if (!a.channels) return [];
    const ch = a.channels.channels || {};
    if (typeof ch !== 'object') return [];
    return Object.entries(ch).map(([name, info]) => ({
      name,
      status: info?.running
        ? 'connected'
        : info?.lastError
          ? 'error'
          : '',
    }));
  }

  function getHeartbeatState(a) {
    const gwId = a.gatewayAgentId || a.id;
    const agents = a.health?.agents;
    if (Array.isArray(agents)) {
      const m =
        agents.find((ag) => ag.agentId === gwId) ||
        agents.find((ag) => ag.isDefault) ||
        agents[0];
      if (m?.heartbeat?.enabled === true) return 'enabled';
      if (m?.heartbeat?.enabled === false) return 'disabled';
    }
    return 'unknown';
  }

  function getHeartbeatTs(a) {
    if (!a.heartbeat) return null;
    return a.heartbeat.ts || a.heartbeat.sentAt || a.heartbeat.timestamp || null;
  }

  function _extractSessionsBasic(a) {
    if (!a.sessions) return [];
    let list = a.sessions.sessions || a.sessions;
    if (!Array.isArray(list)) {
      if (typeof list === 'object') list = Object.values(list);
      else return [];
    }
    return list
      .filter((s) => s && typeof s === 'object')
      .map((s) => ({
        ageMs: s.ageMs || (s.updatedAt ? Date.now() - s.updatedAt : Infinity),
      }));
  }

  // ── Expose shared functions on window ──
  window.computeHealth = computeHealth;
  window.extractChannels = extractChannels;
  window.getHeartbeatState = getHeartbeatState;
  window.getHeartbeatTs = getHeartbeatTs;

  // ════════════════════════════════════════════════════
  // THEME TOGGLE
  // ════════════════════════════════════════════════════

  window.toggleTheme = function () {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') !== 'light';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    localStorage.setItem('cc-theme', isDark ? 'light' : 'dark');
    updateThemeIcon();
  };

  function updateThemeIcon() {
    const isDark =
      document.documentElement.getAttribute('data-theme') !== 'light';
    const icon = document.getElementById('themeIcon');
    if (icon) icon.setAttribute('data-lucide', isDark ? 'moon' : 'sun');
    refreshIcons();
  }

  // ════════════════════════════════════════════════════
  // SIDEBAR COLLAPSE
  // ════════════════════════════════════════════════════

  window.toggleSidebar = function () {
    document.body.classList.toggle('sidebar-collapsed');
    localStorage.setItem(
      'cc-sidebar',
      document.body.classList.contains('sidebar-collapsed')
        ? 'collapsed'
        : 'open'
    );
  };

  // ════════════════════════════════════════════════════
  // LOGOUT
  // ════════════════════════════════════════════════════

  window._layoutLogout = async function () {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  };

  // ════════════════════════════════════════════════════
  // CLOCK
  // ════════════════════════════════════════════════════

  function updateClock() {
    const el = document.getElementById('topbarTime');
    if (el)
      el.textContent = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
  }

  // ════════════════════════════════════════════════════
  // SHARED UTILITIES (exposed on window)
  // ════════════════════════════════════════════════════

  function timeAgo(ts) {
    const d = Date.now() - ts;
    if (d < 60000) return 'just now';
    if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
    if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
    return Math.floor(d / 86400000) + 'd ago';
  }

  function fmtBytes(b) {
    if (b > 1e9) return (b / 1e9).toFixed(1) + 'GB';
    if (b > 1e6) return (b / 1e6).toFixed(0) + 'MB';
    return (b / 1e3).toFixed(0) + 'KB';
  }

  function formatUptime(s) {
    if (!s) return '—';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  window.timeAgo = timeAgo;
  window.fmtBytes = fmtBytes;
  window.formatUptime = formatUptime;

  window.showToast = function (msg, type = 'success') {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  };

  window.refreshIcons = function () {
    if (window.lucide) lucide.createIcons();
  };

  // ════════════════════════════════════════════════════
  // KEYBOARD SHORTCUTS
  // ════════════════════════════════════════════════════

  document.addEventListener('keydown', (e) => {
    if (
      e.target.tagName === 'INPUT' ||
      e.target.tagName === 'TEXTAREA' ||
      e.target.tagName === 'SELECT'
    )
      return;
    if (e.key === 't' || e.key === 'T') window.toggleTheme();
    if (e.key === 'b' || e.key === 'B') window.toggleSidebar();
    if (e.key === 'r' || e.key === 'R') location.reload();
    if (e.key === 'n' || e.key === 'N') window.location.href = '/create.html';
    // Number keys: jump to agent
    const num = parseInt(e.key);
    if (num >= 1 && num <= 9) {
      const ids = Object.keys(agentState).sort();
      if (ids[num - 1]) {
        // On dashboard, scroll to card if it exists; otherwise navigate
        const card = document.getElementById(`card-${ids[num - 1]}`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          window.location.href = `/agent/${encodeURIComponent(ids[num - 1])}`;
        }
      }
    }
  });

  // ════════════════════════════════════════════════════
  // SPA NAVIGATION — keep layout, swap content
  // ════════════════════════════════════════════════════

  // Internal links: fetch page, swap <main>, keep sidebar/topbar/SSE alive
  const SPA_SELECTOR = 'a[href^="/"]';

  function isSpaNavigation(href) {
    // Only SPA-navigate to app pages, not API or external
    if (!href || href.startsWith('/api/') || href.startsWith('/login')) return false;
    return true;
  }

  async function spaNavigate(href, pushState = true) {
    try {
      const res = await fetch(href, { credentials: 'same-origin' });
      if (!res.ok || res.redirected) { window.location.href = href; return; }
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) { window.location.href = href; return; }

      const html = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const newMain = doc.querySelector('main.main') || doc.querySelector('main');
      const newStyle = doc.querySelector('style');
      const newTitle = doc.querySelector('title')?.textContent;

      if (!newMain) { window.location.href = href; return; }

      // Swap page-specific style
      const oldPageStyle = document.querySelector('style:not(#layout-css)');
      const newPageStyle = newStyle ? newStyle.cloneNode(true) : null;
      if (oldPageStyle && newPageStyle) {
        oldPageStyle.replaceWith(newPageStyle);
      } else if (newPageStyle) {
        document.head.appendChild(newPageStyle);
      }

      // Swap main content
      const currentMain = document.querySelector('main.main') || document.querySelector('main');
      if (currentMain) {
        currentMain.innerHTML = newMain.innerHTML;
      }

      // Update title
      if (newTitle) document.title = newTitle;

      // Update URL
      if (pushState) history.pushState({}, '', href);

      // Execute page-specific scripts from the new page
      const newScripts = doc.querySelectorAll('script:not([src])');
      for (const script of newScripts) {
        const text = script.textContent;
        // Skip if it's just lucide init
        if (text.trim() === 'lucide.createIcons();') continue;
        // Skip layout.js related
        if (text.includes('layout.js')) continue;
        try { new Function(text)(); } catch (e) { console.warn('[SPA] script error:', e); }
      }

      // Re-highlight active sidebar item
      updateSidebarActive(href);

      // Re-render icons
      refreshIcons();

    } catch (e) {
      console.warn('[SPA] navigation failed, falling back:', e);
      window.location.href = href;
    }
  }

  function updateSidebarActive(href) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    sidebar.querySelectorAll('.nav-item').forEach(item => {
      item.classList.remove('active');
      const itemHref = item.getAttribute('href');
      if (!itemHref) return;
      if (href === '/' && (itemHref === '/' || itemHref === '/dashboard.html')) {
        item.classList.add('active');
      } else if (itemHref !== '/' && href.startsWith(itemHref)) {
        item.classList.add('active');
      }
    });
  }

  // Intercept clicks on internal links
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || !href.startsWith('/')) return;
    if (!isSpaNavigation(href)) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) return; // allow open in new tab
    e.preventDefault();
    spaNavigate(href);
  });

  // Handle browser back/forward
  window.addEventListener('popstate', () => {
    spaNavigate(window.location.pathname, false);
  });

  // ════════════════════════════════════════════════════
  // INIT — run immediately (script is placed after <main>)
  // ════════════════════════════════════════════════════

  init();
})();
