const { run } = require('../utils');

function checkSystem() {
  const results = [];
  const fv = run('fdesetup status 2>/dev/null', 'unknown');
  results.push({ name: 'FileVault (disk encryption)', status: fv.includes('On') ? 'pass' : 'fail', detail: fv });
  const fw = run('/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null', 'unknown');
  results.push({ name: 'macOS Firewall', status: fw.includes('enabled') ? 'pass' : 'warn', detail: fw });
  const sip = run('csrutil status 2>/dev/null', 'unknown');
  results.push({ name: 'System Integrity Protection', status: sip.includes('enabled') ? 'pass' : 'warn', detail: sip });
  const gk = run('spctl --status 2>/dev/null', 'unknown');
  results.push({ name: 'Gatekeeper', status: gk.includes('assessments enabled') ? 'pass' : 'warn', detail: gk });
  const batt = run('pmset -g batt', '');
  const battMatch = batt.match(/(\d+)%/);
  const charging = batt.includes('AC Power') || batt.includes('charging');
  results.push({ name: 'Battery', status: battMatch && parseInt(battMatch[1]) < 30 && !charging ? 'warn' : 'info', detail: batt.split('\n').slice(1).join(' ').trim() || batt });
  return results;
}

module.exports = { checkSystem };
