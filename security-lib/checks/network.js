const fs = require('fs');
const { run } = require('../utils');

function checkNetwork(config, getTokenInfo) {
  const results = [];
  
  // Try lsof first, fall back to netstat if it fails or returns nothing
  let ports = run("lsof -iTCP -sTCP:LISTEN -nP 2>/dev/null | awk 'NR>1 {print $1, $9}' | sort -u", '');
  let portLines = ports.split('\n').filter(l => l.trim());
  
  // If lsof returned nothing or failed, try netstat
  if (portLines.length === 0) {
    const netstat = run("netstat -an 2>/dev/null | grep LISTEN | grep -E '\\.(tcp|TCP)' | awk '{print $4}'", '');
    portLines = netstat.split('\n').filter(l => l.trim() && l.includes('.'));
    // Format netstat output to be more readable
    portLines = portLines.map(line => {
      const match = line.match(/:(\d+)$/);
      return match ? `port ${match[1]}` : line;
    });
  }
  
  results.push({ 
    name: 'Listening TCP ports', 
    status: portLines.length > 10 ? 'warn' : 'info', 
    detail: portLines.length + ' services listening', 
    extra: portLines.slice(0, 20).join('\n') 
  });

  const gwPort = run("lsof -iTCP:18791 -sTCP:LISTEN -nP 2>/dev/null | awk 'NR>1 {print $9}'", '');
  if (gwPort) {
    results.push({ name: 'Gateway binding', status: gwPort.includes('127.0.0.1') ? 'pass' : 'warn', detail: gwPort || 'Not running' });
  }

  const ssh = run("lsof -iTCP:22 -sTCP:LISTEN -nP 2>/dev/null | head -2", '');
  results.push({ name: 'SSH daemon', status: ssh ? 'info' : 'pass', detail: ssh ? 'SSH is listening' : 'SSH not active' });

  const tokenInfo = getTokenInfo(config);
  results.push({
    name: 'Dashboard authentication',
    status: tokenInfo ? (tokenInfo.expired ? 'fail' : 'pass') : 'warn',
    detail: tokenInfo
      ? (tokenInfo.expired
        ? `Token EXPIRED (${tokenInfo.ageHours}h old, max ${tokenInfo.maxAgeDays}d)`
        : `Token valid (${tokenInfo.remainingHours}h remaining)`)
      : 'No auth configured'
  });

  // Check audit log status
  let logSize = 0;
  let logEntries = 0;
  try {
    if (fs.existsSync(config.auditLog)) {
      logSize = fs.statSync(config.auditLog).size;
      logEntries = fs.readFileSync(config.auditLog, 'utf8').split('\n').filter(l => l.trim()).length;
    }
  } catch {}
  results.push({
    name: 'Audit logging',
    status: logEntries > 0 ? 'pass' : 'info',
    detail: `${logEntries} entries (${(logSize / 1024).toFixed(1)} KB), max ${config.maxLogSizeMB}MB`
  });

  return results;
}

module.exports = { checkNetwork };
