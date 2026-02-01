const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days
const TOKEN_GRACE_MS = 60 * 60 * 1000;               // 1 hour grace after rotation

function loadTokenState(config) {
  const tokenFile = path.join(config.secretsDir, 'dashboard.env');
  try {
    const content = fs.readFileSync(tokenFile, 'utf8');
    const tokenMatch = content.match(/DASHBOARD_TOKEN=(.+)/);
    const createdMatch = content.match(/TOKEN_CREATED=(\d+)/);
    const prevMatch = content.match(/PREVIOUS_TOKEN=(.+)/);
    const prevExpiryMatch = content.match(/PREVIOUS_EXPIRES=(\d+)/);

    return {
      token: tokenMatch ? tokenMatch[1].trim() : null,
      created: createdMatch ? parseInt(createdMatch[1]) : null,
      previousToken: prevMatch ? prevMatch[1].trim() : null,
      previousExpires: prevExpiryMatch ? parseInt(prevExpiryMatch[1]) : null,
    };
  } catch {
    return { token: null, created: null, previousToken: null, previousExpires: null };
  }
}

function saveTokenState(config, state) {
  const tokenFile = path.join(config.secretsDir, 'dashboard.env');
  let content = `# Security Dashboard Token (auto-managed)\n`;
  content += `DASHBOARD_TOKEN=${state.token}\n`;
  content += `TOKEN_CREATED=${state.created}\n`;
  if (state.previousToken) {
    content += `PREVIOUS_TOKEN=${state.previousToken}\n`;
    content += `PREVIOUS_EXPIRES=${state.previousExpires}\n`;
  }
  fs.writeFileSync(tokenFile, content, { mode: 0o600 });
}

function rotateToken(config, auditLog) {
  const oldState = loadTokenState(config);
  const newToken = crypto.randomBytes(32).toString('hex');
  const now = Date.now();

  const newState = {
    token: newToken,
    created: now,
    previousToken: oldState.token,
    previousExpires: oldState.token ? now + TOKEN_GRACE_MS : null,
  };

  saveTokenState(config, newState);
  auditLog('SYSTEM', '/internal', 'token_rotated', `New token created, old token valid for ${TOKEN_GRACE_MS / 1000}s grace period`);

  return newToken;
}

function isTokenValid(config, candidateToken) {
  const state = loadTokenState(config);
  if (!state.token) return { valid: false, reason: 'no_token_configured' };

  const now = Date.now();

  // Check current token
  if (candidateToken === state.token) {
    // Check expiry
    if (state.created && (now - state.created) > TOKEN_MAX_AGE_MS) {
      return { valid: false, reason: 'token_expired', hint: 'Token has expired. Rotate with: curl -X POST localhost:' + config.port + '/api/rotate -H "Authorization: Bearer <current-token>"' };
    }
    return { valid: true };
  }

  // Check previous token (grace period)
  if (state.previousToken && candidateToken === state.previousToken) {
    if (state.previousExpires && now < state.previousExpires) {
      return { valid: true, warning: 'using_previous_token' };
    }
    return { valid: false, reason: 'previous_token_expired' };
  }

  return { valid: false, reason: 'invalid_token' };
}

function getTokenInfo(config) {
  const state = loadTokenState(config);
  if (!state.token || !state.created) return null;
  const now = Date.now();
  const ageMs = now - state.created;
  const remainingMs = TOKEN_MAX_AGE_MS - ageMs;
  return {
    ageHours: Math.round(ageMs / 3600000),
    remainingHours: Math.max(0, Math.round(remainingMs / 3600000)),
    expired: remainingMs <= 0,
    maxAgeDays: TOKEN_MAX_AGE_MS / 86400000,
  };
}

function checkAuth(config, req, res, auditLog, trackFailedAuth) {
  const state = loadTokenState(config);
  if (!state.token) return true; // No token = open (legacy)

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    auditLog(getClientIP(req), req.url, 'auth_missing', 'No Authorization header');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authentication required', hint: 'Send Authorization: Bearer <token>' }));
    return false;
  }

  const candidateToken = authHeader.replace(/^Bearer\s+/i, '');
  const result = isTokenValid(config, candidateToken);

  if (!result.valid) {
    trackFailedAuth(req);
    auditLog(getClientIP(req), req.url, 'auth_failed', result.reason);
    const status = result.reason === 'token_expired' ? 401 : 403;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: result.reason, hint: result.hint || 'Invalid or expired token' }));
    return false;
  }

  if (result.warning) {
    auditLog(getClientIP(req), req.url, 'auth_grace', 'Authenticated with previous token (grace period)');
  }

  return true;
}

function getClientIP(req) {
  return req.socket.remoteAddress || 'unknown';
}

module.exports = {
  loadTokenState,
  saveTokenState,
  rotateToken,
  isTokenValid,
  getTokenInfo,
  checkAuth,
  getClientIP,
  TOKEN_MAX_AGE_MS,
  TOKEN_GRACE_MS,
};
