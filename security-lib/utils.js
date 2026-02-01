const { execSync } = require('child_process');

function run(cmd, fallback = '') {
  try { return execSync(cmd, { timeout: 5000 }).toString().trim(); }
  catch { return fallback; }
}

module.exports = { run };
