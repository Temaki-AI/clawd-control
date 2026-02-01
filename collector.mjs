#!/usr/bin/env node
/**
 * Clawd Control — Agent Collector
 * 
 * Connects to each agent's Clawdbot gateway via the native WS protocol,
 * polls status data, and exposes an event emitter for the server.
 * 
 * Supports multiple agents on the same gateway: connects once per
 * unique host:port:token and splits data per-agent using gatewayAgentId.
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const DIR = new URL('.', import.meta.url).pathname;

export class AgentCollector extends EventEmitter {
  constructor(configPath) {
    super();
    this.configPath = configPath || join(DIR, 'agents.json');
    this.config = null;
    this.agents = new Map();          // id → agent config
    this.gateways = new Map();        // gatewayKey → { ws, state, agents[], ... }
    this.agentGateway = new Map();    // agentId → gatewayKey
    this.state = new Map();           // agentId → display state
    this.hostMetrics = {};
    this._pollTimer = null;
    this._metricsTimer = null;
    this._reqCounter = 0;
    this._pending = new Map();
  }

  loadConfig() {
    this.config = JSON.parse(readFileSync(this.configPath, 'utf8'));
    for (const agent of this.config.agents) {
      this.agents.set(agent.id, agent);
      const gwKey = `${agent.host}:${agent.port}:${agent.token.slice(0, 8)}`;
      this.agentGateway.set(agent.id, gwKey);
      if (!this.gateways.has(gwKey)) {
        this.gateways.set(gwKey, {
          key: gwKey, host: agent.host, port: agent.port, token: agent.token,
          ws: null, state: 'disconnected', reconnectTimer: null,
          agents: [], rawData: {},
        });
      }
      this.gateways.get(gwKey).agents.push(agent);

      if (!this.state.has(agent.id)) {
        this.state.set(agent.id, {
          id: agent.id, gatewayAgentId: agent.gatewayAgentId || agent.id,
          name: agent.name, emoji: agent.emoji,
          machine: agent.machine, online: false, lastSeen: null,
          health: null, sessions: null, usage: null, heartbeat: null,
          presence: null, channels: null, cron: null, error: null,
        });
      }
    }
  }

  start() {
    this.loadConfig();
    // Connect once per unique gateway
    for (const [key] of this.gateways) this._connect(key);
    this._pollTimer = setInterval(() => this._pollAll(), this.config.pollIntervalMs || 15000);
    this._metricsTimer = setInterval(() => this._collectHostMetrics(), this.config.hostMetricsIntervalMs || 30000);
    this._collectHostMetrics();
  }

  stop() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._metricsTimer) clearInterval(this._metricsTimer);
    for (const [, gw] of this.gateways) {
      if (gw.reconnectTimer) clearTimeout(gw.reconnectTimer);
      if (gw.ws) gw.ws.close();
    }
  }

  getSnapshot() {
    return { ts: Date.now(), agents: Object.fromEntries(this.state), host: this.hostMetrics };
  }

  // ── WebSocket Connection (per gateway) ──

  _connect(gwKey) {
    const gw = this.gateways.get(gwKey);
    if (!gw) return;
    if (gw.ws) { try { gw.ws.close(); } catch {} }

    const url = `ws://${gw.host}:${gw.port}`;
    let ws;
    try { ws = new WebSocket(url); }
    catch (e) {
      for (const agent of gw.agents) this._updateState(agent.id, { online: false, error: e.message });
      this._scheduleReconnect(gwKey);
      return;
    }

    gw.ws = ws;
    gw.state = 'connecting';

    ws.on('open', () => { gw.state = 'waiting-challenge'; });

    ws.on('message', (data) => {
      try { this._handleMessage(gwKey, JSON.parse(data.toString())); } catch {}
    });

    ws.on('close', (code) => {
      gw.state = 'disconnected';
      for (const agent of gw.agents) this._updateState(agent.id, { online: false, error: `disconnected (code ${code})` });
      this._scheduleReconnect(gwKey);
    });

    ws.on('error', (err) => {
      gw.state = 'error';
      for (const agent of gw.agents) this._updateState(agent.id, { online: false, error: err.message });
    });
  }

  _scheduleReconnect(gwKey) {
    const gw = this.gateways.get(gwKey);
    if (!gw) return;
    if (gw.reconnectTimer) clearTimeout(gw.reconnectTimer);
    gw.reconnectTimer = setTimeout(() => this._connect(gwKey), 10000);
  }

  _sendFrame(gwKey, frame) {
    const gw = this.gateways.get(gwKey);
    if (!gw?.ws || gw.ws.readyState !== WebSocket.OPEN) return;
    gw.ws.send(JSON.stringify(frame));
  }

  _call(gwKey, method, params) {
    return new Promise((resolve) => {
      const gw = this.gateways.get(gwKey);
      if (!gw?.ws || gw.ws.readyState !== WebSocket.OPEN || gw.state !== 'connected') {
        resolve(null); return;
      }
      const reqId = String(++this._reqCounter);
      this._sendFrame(gwKey, { type: 'req', id: reqId, method, params: params || {} });
      const timer = setTimeout(() => { this._pending.delete(reqId); resolve(null); }, 10000);
      this._pending.set(reqId, { resolve, timer });
    });
  }

  _handleMessage(gwKey, msg) {
    const gw = this.gateways.get(gwKey);

    if (msg.type === 'event') {
      if (msg.event === 'connect.challenge') {
        this._sendFrame(gwKey, {
          type: 'req', id: String(++this._reqCounter), method: 'connect',
          params: {
            minProtocol: 3, maxProtocol: 3,
            client: { id: 'clawdbot-probe', version: '2.0.0', platform: 'linux', mode: 'backend' },
            auth: { token: gw.token },
          },
        });
        return;
      }
      if (msg.event === 'health') {
        for (const agent of gw.agents) this._updateState(agent.id, { health: msg.payload, lastSeen: Date.now() });
      } else if (msg.event === 'presence') {
        for (const agent of gw.agents) this._updateState(agent.id, { presence: msg.payload?.presence, lastSeen: Date.now() });
      } else if (msg.event === 'tick') {
        for (const agent of gw.agents) this._updateState(agent.id, { lastSeen: Date.now() });
      }
      return;
    }

    if (msg.type === 'res') {
      if (msg.ok && msg.payload?.type === 'hello-ok') {
        gw.state = 'connected';
        const snap = msg.payload.snapshot || {};
        for (const agent of gw.agents) {
          this._updateState(agent.id, { online: true, error: null, lastSeen: Date.now(), health: snap });
        }
        setTimeout(() => this._pollGateway(gwKey), 500);
        return;
      }
      if (!msg.ok && msg.error) {
        console.error(`[${gwKey}] connect error:`, msg.error.message);
        for (const agent of gw.agents) this._updateState(agent.id, { online: false, error: msg.error.message });
        return;
      }
      if (msg.id && this._pending.has(msg.id)) {
        const { resolve, timer } = this._pending.get(msg.id);
        clearTimeout(timer);
        this._pending.delete(msg.id);
        resolve(msg.ok ? msg.payload : null);
        return;
      }
    }
  }

  // ── Polling ──

  _pollAll() {
    for (const [gwKey] of this.gateways) this._pollGateway(gwKey);
  }

  async _pollGateway(gwKey) {
    const gw = this.gateways.get(gwKey);
    if (!gw || gw.state !== 'connected') return;

    const [health, sessions, usage, heartbeat, channels, cron] = await Promise.all([
      this._call(gwKey, 'health', {}),
      this._call(gwKey, 'sessions.list', { activeMinutes: 1440, limit: 50 }),
      this._call(gwKey, 'usage.cost', { days: 7 }),
      this._call(gwKey, 'last-heartbeat', {}),
      this._call(gwKey, 'channels.status', {}),
      this._call(gwKey, 'cron.list', {}),
    ]);

    // Store raw gateway data
    gw.rawData = { health, sessions, usage, heartbeat, channels, cron };

    // Split data per agent
    for (const agent of gw.agents) {
      const agentKey = agent.gatewayAgentId || agent.id;
      const update = { lastSeen: Date.now() };

      // Health: filter agents array
      if (health) {
        update.health = { ...health };
        if (Array.isArray(health.agents)) {
          const agentHealth = health.agents.find(a => a.agentId === agentKey);
          if (agentHealth) update.health._agentHealth = agentHealth;
        }
      }

      // Sessions: filter by agent key prefix
      if (sessions) {
        const allSessions = sessions.sessions || sessions;
        if (Array.isArray(allSessions)) {
          const filtered = allSessions.filter(s => {
            const key = s.key || '';
            return key.startsWith(`agent:${agentKey}:`);
          });
          update.sessions = { ...sessions, sessions: filtered };
        } else {
          update.sessions = sessions;
        }
      }

      // Usage: gateway-level (mark as shared when multiple agents)
      if (usage) {
        update.usage = { ...usage, shared: gw.agents.length > 1 };
      }

      // Heartbeat: agent-specific if available
      if (heartbeat) update.heartbeat = heartbeat;

      // Channels: gateway-level for now
      if (channels) update.channels = channels;

      // Cron: filter by agent if possible
      if (cron) {
        const allJobs = Array.isArray(cron) ? cron : (cron.jobs || []);
        // Cron jobs don't always have agentId, so show all for now
        update.cron = cron;
      }

      this._updateState(agent.id, update);
    }
  }

  // ── State ──

  _updateState(id, partial) {
    const current = this.state.get(id) || {};
    this.state.set(id, { ...current, ...partial });
    this.emit('update', { id, state: this.state.get(id) });
  }

  // ── Host Metrics ──

  _collectHostMetrics() {
    try {
      const loadavg = readFileSync('/proc/loadavg', 'utf8').trim().split(' ');
      const meminfo = readFileSync('/proc/meminfo', 'utf8');
      const memTotal = parseInt(meminfo.match(/MemTotal:\s+(\d+)/)?.[1] || '0') * 1024;
      const memAvail = parseInt(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1] || '0') * 1024;

      let diskTotal = 0, diskUsed = 0;
      try {
        const df = execSync('df -B1 / 2>/dev/null', { encoding: 'utf8' });
        const parts = df.split('\n')[1]?.split(/\s+/);
        if (parts) { diskTotal = parseInt(parts[1]) || 0; diskUsed = parseInt(parts[2]) || 0; }
      } catch {}

      const uptime = parseFloat(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);

      this.hostMetrics = {
        ts: Date.now(), hostname: execSync('hostname', { encoding: 'utf8' }).trim(),
        loadAvg: loadavg.slice(0, 3).map(Number),
        memory: { total: memTotal, used: memTotal - memAvail, available: memAvail },
        disk: { total: diskTotal, used: diskUsed },
        uptime: Math.floor(uptime),
      };
      this.emit('hostMetrics', this.hostMetrics);
    } catch {}
  }
}
