const fs = require('fs');
const path = require('path');
const os = require('os');

function checkSecrets(config) {
  const results = [];
  const secretsDir = config.secretsDir;

  // Check 1: Directory existence
  if (!fs.existsSync(secretsDir)) {
    results.push({ name: 'Secrets directory', status: 'fail', detail: 'No secrets/ directory found' });
    return results;
  }

  // Check 2: Directory permissions
  const dirStat = fs.statSync(secretsDir);
  const dirMode = '0' + (dirStat.mode & 0o777).toString(8);
  results.push({ name: 'Secrets directory permissions', status: dirMode === '0700' ? 'pass' : 'warn', detail: `${dirMode} (should be 0700)` });

  // Check 3: Directory ownership (should be current user)
  const currentUid = process.getuid ? process.getuid() : null;
  if (currentUid !== null) {
    results.push({ 
      name: 'Secrets directory ownership', 
      status: dirStat.uid === currentUid ? 'pass' : 'warn', 
      detail: dirStat.uid === currentUid ? `Owned by current user (${os.userInfo().username})` : `Owned by UID ${dirStat.uid} (current: ${currentUid})` 
    });
  }

  const secretFiles = fs.readdirSync(secretsDir).filter(f => f.endsWith('.env'));
  
  // Check 4: File permissions
  let filePermIssues = 0;
  for (const file of secretFiles) {
    const stat = fs.statSync(path.join(secretsDir, file));
    const mode = '0' + (stat.mode & 0o777).toString(8);
    if (mode !== '0600' && mode !== '0400') {
      filePermIssues++;
    }
  }
  results.push({ 
    name: 'Secret file permissions', 
    status: filePermIssues === 0 ? 'pass' : 'warn', 
    detail: filePermIssues === 0 
      ? `All ${secretFiles.length} file(s) have secure permissions (600/400)` 
      : `${filePermIssues} of ${secretFiles.length} file(s) have loose permissions` 
  });

  // Check 5: .gitignore coverage
  const gitignorePath = path.join(config.workspace, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gitignore = fs.readFileSync(gitignorePath, 'utf8');
    results.push({ 
      name: 'Secrets in .gitignore', 
      status: gitignore.includes('secrets') ? 'pass' : 'fail', 
      detail: gitignore.includes('secrets') ? 'secrets/ is gitignored' : 'secrets/ NOT in .gitignore!' 
    });
  } else {
    results.push({ name: 'Secrets in .gitignore', status: 'warn', detail: 'No .gitignore file found' });
  }

  // Check 6: Plaintext vs encrypted detection
  let plaintextCount = 0;
  for (const file of secretFiles) {
    const content = fs.readFileSync(path.join(secretsDir, file), 'utf8');
    const lines = content.split('\n').filter(l => l.includes('=') && !l.startsWith('#'));
    
    for (const line of lines) {
      const value = line.split('=').slice(1).join('=').trim();
      // Heuristic: plaintext if contains common words, spaces, or is too short
      if (value && value.length < 50 && !value.match(/^[A-Za-z0-9+/=_-]{20,}$/) && value.match(/[a-z]{3,}/i)) {
        plaintextCount++;
      }
    }
  }
  results.push({ 
    name: 'Plaintext credential detection', 
    status: plaintextCount > 0 ? 'warn' : 'pass', 
    detail: plaintextCount > 0 
      ? `${plaintextCount} potential plaintext value(s) detected` 
      : 'All values appear encoded/hashed' 
  });

  // Check 7: Credential sprawl (secrets outside secrets/)
  const sprawlPatterns = ['**/*.env', '**/.env*', '**/config.json'];
  let sprawlFiles = [];
  try {
    const { execSync } = require('child_process');
    // Look for .env files outside secrets/
    const findCmd = `find "${config.workspace}" -type f \\( -name "*.env" -o -name ".env*" \\) ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/secrets/*" 2>/dev/null | head -20`;
    const output = execSync(findCmd, { encoding: 'utf8', timeout: 5000 }).trim();
    sprawlFiles = output ? output.split('\n').filter(f => f) : [];
  } catch {}
  
  results.push({ 
    name: 'Credential sprawl check', 
    status: sprawlFiles.length > 0 ? 'warn' : 'pass', 
    detail: sprawlFiles.length > 0 
      ? `${sprawlFiles.length} .env file(s) found outside secrets/` 
      : 'No stray .env files detected',
    extra: sprawlFiles.length > 0 ? sprawlFiles.slice(0, 5).join('\n') : undefined
  });

  return results;
}

module.exports = { checkSecrets };
