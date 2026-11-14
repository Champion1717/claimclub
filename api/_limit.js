// Tiny in-memory rate limiter (per serverless instance). Good enough to slow down abuse of public endpoints.
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(), list = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now); buckets.set(key, list);
  if (buckets.size > 10000) buckets.clear();
  return list.length > max;
}
function ipOf(req) { return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || String(req.headers['x-real-ip'] || '') || 'unknown'; }
module.exports = { limited, ipOf };
