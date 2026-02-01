const fs = require('fs');

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

function auditLog(config, ip, endpoint, action, detail = '') {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    ip,
    endpoint,
    action,
    detail,
  }) + '\n';

  try {
    if (fs.existsSync(config.auditLog)) {
      const stat = fs.statSync(config.auditLog);
      if (stat.size > MAX_LOG_SIZE) {
        const archivePath = config.auditLog.replace('.log', `.${Date.now()}.log`);
        fs.renameSync(config.auditLog, archivePath);
      }
    }
    fs.appendFileSync(config.auditLog, entry);
  } catch (e) {
    console.error(`[audit] Failed to write log: ${e.message}`);
  }
}

module.exports = { auditLog, MAX_LOG_SIZE };
