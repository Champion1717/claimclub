// POST /api/account-exists  { email }  ->  { exists: boolean }
// Used by the signup flow to send returning members to Log in, and by the Log in screen to catch typos.
// Only confirmed accounts count. A small per-instance rate limit slows down anyone probing emails.
const { db, readJson, send } = require('./_db');

const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, max = 20;
  const list = (hits.get(ip) || []).filter((t) => now - t < win);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return send(res, 429, { error: 'Too many checks. Try again in a few minutes.' });
  const b = await readJson(req);
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return send(res, 400, { error: 'Enter a valid email' });
  try {
    const { data, error } = await db().rpc('email_has_account', { p_email: email });
    if (error) throw error;
    return send(res, 200, { exists: !!data });
  } catch (e) {
    return send(res, 500, { error: 'Could not check that email right now' });
  }
};
