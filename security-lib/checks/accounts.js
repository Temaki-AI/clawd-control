const fs = require('fs');
const path = require('path');

function checkAccounts(config) {
  const results = [];
  
  if (!fs.existsSync(config.secretsDir)) {
    results.push({ name: 'Account inventory', status: 'warn', detail: 'No secrets directory found' });
    return results;
  }

  const envFiles = fs.readdirSync(config.secretsDir).filter(f => f.endsWith('.env'));
  
  if (envFiles.length === 0) {
    results.push({ name: 'Configured accounts', status: 'warn', detail: 'No .env files found in secrets/' });
    return results;
  }

  // Inventory each service
  for (const file of envFiles) {
    const serviceName = file.replace('.env', '');
    const filePath = path.join(config.secretsDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.includes('=') && !l.startsWith('#'));
    const keys = lines.map(l => l.split('=')[0].trim());
    const values = lines.map(l => l.split('=').slice(1).join('=').trim());
    
    // Check for empty credentials
    const emptyKeys = keys.filter((k, i) => !values[i] || values[i].length === 0);
    const hasEmpty = emptyKeys.length > 0;
    
    // Check for plaintext vs encrypted/encoded
    const plaintextKeys = keys.filter((k, i) => {
      const val = values[i] || '';
      // Simple heuristic: plaintext if it's a short string without special chars, or contains spaces/common words
      return val.length > 0 && val.length < 50 && !val.match(/^[A-Za-z0-9+/=_-]{20,}$/) && val.match(/[a-z]{3,}/i);
    });
    
    const status = hasEmpty ? 'warn' : 'pass';
    const detail = hasEmpty 
      ? `${keys.length} credential(s), ${emptyKeys.length} empty: ${emptyKeys.join(', ')}`
      : `${keys.length} credential(s): ${keys.join(', ')}`;
    
    results.push({ 
      name: `${serviceName} account`, 
      status, 
      detail,
      extra: plaintextKeys.length > 0 ? `Potential plaintext: ${plaintextKeys.join(', ')}` : undefined
    });
  }

  return results;
}

module.exports = { checkAccounts };
