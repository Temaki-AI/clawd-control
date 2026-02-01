#!/usr/bin/env node
/**
 * Health History Collector
 * Stores daily snapshots of agent health reports for trend analysis
 * 
 * Usage:
 *   node collect-history.mjs [--agent <name>] [--all]
 * 
 * Creates: reports/history/{agent}/{YYYY-MM-DD}.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.join(__dirname, 'reports');
const HISTORY_DIR = path.join(REPORTS_DIR, 'history');

// Parse CLI args
const args = process.argv.slice(2);
const agentName = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : null;
const collectAll = args.includes('--all');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getDateStamp() {
  const now = new Date();
  return now.toISOString().split('T')[0]; // YYYY-MM-DD
}

function collectAgentHistory(agent) {
  const reportPath = path.join(REPORTS_DIR, `${agent}.json`);
  
  if (!fs.existsSync(reportPath)) {
    console.error(`❌ Report not found: ${reportPath}`);
    return false;
  }
  
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    
    // Extract key metrics
    const snapshot = {
      timestamp: report.timestamp || new Date().toISOString(),
      agent: report.agent,
      summary: report.summary,
      score: Math.round((report.summary.pass / report.summary.total) * 100),
      categories: {}
    };
    
    // Category breakdown
    const categories = [...new Set(report.checks.map(c => c.category))];
    for (const cat of categories) {
      const catChecks = report.checks.filter(c => c.category === cat);
      const catPass = catChecks.filter(c => c.status === 'pass').length;
      const catTotal = catChecks.length;
      
      snapshot.categories[cat] = {
        pass: catPass,
        total: catTotal,
        score: Math.round((catPass / catTotal) * 100)
      };
    }
    
    // Save snapshot
    const agentHistoryDir = path.join(HISTORY_DIR, agent);
    ensureDir(agentHistoryDir);
    
    const dateStamp = getDateStamp();
    const snapshotPath = path.join(agentHistoryDir, `${dateStamp}.json`);
    
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    console.log(`✅ ${agent}: Snapshot saved → ${dateStamp}.json (${snapshot.score}%)`);
    
    return true;
  } catch (err) {
    console.error(`❌ Error processing ${agent}:`, err.message);
    return false;
  }
}

function collectAllAgents() {
  if (!fs.existsSync(REPORTS_DIR)) {
    console.error(`❌ Reports directory not found: ${REPORTS_DIR}`);
    process.exit(1);
  }
  
  const files = fs.readdirSync(REPORTS_DIR);
  const reports = files.filter(f => f.endsWith('.json') && f !== 'meta.json');
  
  if (reports.length === 0) {
    console.error('❌ No agent reports found');
    process.exit(1);
  }
  
  let collected = 0;
  for (const file of reports) {
    const agent = file.replace('.json', '');
    if (collectAgentHistory(agent)) {
      collected++;
    }
  }
  
  console.log(`\n📊 Collected ${collected}/${reports.length} snapshots`);
}

// Main
ensureDir(HISTORY_DIR);

if (collectAll) {
  collectAllAgents();
} else if (agentName) {
  collectAgentHistory(agentName);
} else {
  console.log(`
Health History Collector

Usage:
  node collect-history.mjs --all              Collect all agents
  node collect-history.mjs --agent gandalf    Collect specific agent

Snapshots saved to: reports/history/{agent}/{YYYY-MM-DD}.json

💡 Tip: Run this daily via cron to build trend history
  `);
  process.exit(1);
}
