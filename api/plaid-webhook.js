// POST /api/plaid-webhook. Plaid calls this when new transactions are ready or a bank needs the member to sign in again.
// Every call is checked: the Plaid-Verification JWT (ES256) must be signed by a Plaid key, be under 5 minutes old and
// carry the SHA-256 of the exact body.
const crypto = require('crypto');
const { db, send } = require('./_db');
const P = require('./_plaid');
const KEYS = {};

function raw(req) {
  return new Promise((resolve) => { let d = ''; req.setEncoding('utf8'); req.on('data', (c) => (d += c)); req.on('end', () => resolve(d)); });
}
const b64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
async function verify(body, jwt) {
  if (!jwt) return false;
  const [h, p, sig] = jwt.split('.'); if (!sig) return false;
  const head = JSON.parse(b64(h).toString()); if (head.alg !== 'ES256' || !head.kid) return false;
  let jwk = KEYS[head.kid];
  if (!jwk) { const r = await P.plaid('/webhook_verification_key/get', { key_id: head.kid }); jwk = KEYS[head.kid] = r.key; }
  if (jwk.expired_at) return false;
  const pub = crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(h + '.' + p), { key: pub, dsaEncoding: 'ieee-p1363' }, b64(sig));
  if (!ok) return false;
  const claims = JSON.parse(b64(p).toString());
  if (!claims.iat || Math.abs(Date.now() / 1000 - claims.iat) > 300) return false;
  const hash = crypto.createHash('sha256').update(body).digest('hex'), want = String(claims.request_body_sha256 || '');
  return want.length === hash.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(want));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const body = await raw(req); // read the raw stream before anything touches req.body (Vercel parses it lazily), so the hash matches
  try { if (!(await verify(body, req.headers['plaid-verification']))) return send(res, 401, { error: 'Bad signature' }); }
  catch (e) { return send(res, 401, { error: 'Bad signature' }); }
  let ev = {}; try { ev = JSON.parse(body); } catch (e) {}
  const sb = db();
  const { data: item } = await sb.from('plaid_items').select('*').eq('item_id', ev.item_id || '').maybeSingle();
  if (!item) return send(res, 200, { ok: true });
  try {
    if (ev.webhook_type === 'TRANSACTIONS' && ['SYNC_UPDATES_AVAILABLE', 'RECURRING_TRANSACTIONS_UPDATE', 'DEFAULT_UPDATE', 'INITIAL_UPDATE', 'HISTORICAL_UPDATE'].includes(ev.webhook_code)) await P.syncItem(item);
    else if (ev.webhook_type === 'ITEM' && ['ERROR', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT'].includes(ev.webhook_code)) {
      const code = (ev.error && ev.error.error_code) || ev.webhook_code;
      await sb.from('plaid_items').update({ status: code === 'ITEM_LOGIN_REQUIRED' || ev.webhook_code !== 'ERROR' ? 'login_required' : 'error', error_code: code }).eq('item_id', item.item_id);
    } else if (ev.webhook_type === 'ITEM' && ev.webhook_code === 'USER_PERMISSION_REVOKED') await sb.from('plaid_items').delete().eq('item_id', item.item_id);
  } catch (e) { return send(res, 500, { error: e.message }); }
  return send(res, 200, { ok: true });
};
