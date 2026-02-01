const fs = require('fs');
const path = require('path');
const { run } = require('../utils');

function checkExposedCredentials(config) {
  const results = [];
  for (const dir of ['skills', 'plans']) {
    const fullDir = path.join(config.workspace, dir);
    if (!fs.existsSync(fullDir)) continue;
    const output = run(`grep -ril --include="*.md" --include="*.json" --include="*.js" -E "(password|auth_token|api_key|secret)\\s*[:=]\\s*['\"][^'\"]{8,}" "${fullDir}" 2>/dev/null`, '');
    results.push({
      name: `Credentials scan: ${dir}/`,
      status: output ? 'warn' : 'pass',
      detail: output ? output.split('\n').map(f => path.basename(f)).join(', ') : 'No hardcoded credentials found'
    });
  }
  for (const file of ['TOOLS.md', 'MEMORY.md']) {
    const fp = path.join(config.workspace, file);
    if (!fs.existsSync(fp)) continue;
    const content = fs.readFileSync(fp, 'utf8');
    const hasCredentials = /(?:password|token|secret|key)\s*[:=]\s*['"A-Za-z0-9+/]{16,}/i.test(content);
    results.push({ name: `${file} credential leak`, status: hasCredentials ? 'warn' : 'pass', detail: hasCredentials ? 'Possible credentials — review manually' : 'Clean' });
  }
  return results;
}

module.exports = { checkExposedCredentials };
