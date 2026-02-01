const rateLimits = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 30;
const MAX_FAILED_AUTH = 5;
const BLOCK_DURATION_MS = 5 * 60 * 1000;

function getRateState(ip) {
  if (!rateLimits.has(ip)) {
    rateLimits.set(ip, { requests: [], failedAuth: [], blockedUntil: null });
  }
  return rateLimits.get(ip);
}

function trackFailedAuth(req, getClientIP) {
  const ip = getClientIP(req);
  const state = getRateState(ip);
  const now = Date.now();
  state.failedAuth.push(now);
  state.failedAuth = state.failedAuth.filter(t => now - t < RATE_WINDOW_MS);

  if (state.failedAuth.length >= MAX_FAILED_AUTH) {
    state.blockedUntil = now + BLOCK_DURATION_MS;
  }
}

function checkRateLimit(req, res, getClientIP, auditLog) {
  const ip = getClientIP(req);
  const state = getRateState(ip);
  const now = Date.now();

  if (state.blockedUntil && now < state.blockedUntil) {
    const retryAfter = Math.ceil((state.blockedUntil - now) / 1000);
    auditLog(ip, req.url, 'rate_blocked', `Still blocked, retry in ${retryAfter}s`);
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
    res.end(JSON.stringify({ error: 'Too many requests.', retryAfterSeconds: retryAfter }));
    return false;
  }

  if (state.blockedUntil && now >= state.blockedUntil) {
    state.blockedUntil = null;
    state.failedAuth = [];
  }

  state.requests.push(now);
  state.requests = state.requests.filter(t => now - t < RATE_WINDOW_MS);

  if (state.requests.length > MAX_REQUESTS) {
    auditLog(ip, req.url, 'rate_exceeded', `${state.requests.length} requests in window`);
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
    res.end(JSON.stringify({ error: 'Rate limit exceeded', retryAfterSeconds: 60 }));
    return false;
  }

  return true;
}

module.exports = {
  checkRateLimit,
  trackFailedAuth,
  MAX_REQUESTS,
  BLOCK_DURATION_MS,
};
