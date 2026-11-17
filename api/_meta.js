// Meta Conversions API (Nov 16 2026), flow B trial only:
//   Purchase  = $2 trial checkout succeeds (dedupes with the browser pixel through event_id = Stripe Checkout Session ID)
//   Subscribe = the first $49 charge after the 7-day trial (server only, event_id = Stripe Invoice ID)
// Env (Henry sets these in Vercel): META_CAPI_TOKEN (Events Manager > Settings > Conversions API > Generate access token),
// optional META_PIXEL_ID (defaults to the site pixel), META_API_VERSION (default v26.0), META_TEST_CODE (only while testing).
// Without a token nothing is sent. Nothing is sent for people whose browser sent Global Privacy Control (gpc=1 in metadata).
const crypto = require('crypto');
const PIXEL = '1683355120035009';
const sha = (v) => (v ? crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex') : undefined);
const clip = (v, n) => String(v || '').slice(0, n);

// Attribution saved at checkout so the day-7 Subscribe (no browser then) can use it. Stripe metadata values max 500 chars.
function attribution(req, b) {
  let url = clip(b.source_url, 450) || 'https://www.claimclub.io/claim';
  try { const u = new URL(url); u.searchParams.delete('offer'); u.searchParams.delete('test'); u.searchParams.delete('email'); url = u.toString(); } catch (e) { url = 'https://www.claimclub.io/claim'; }
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return {
    fbp: clip(b.fbp, 200), fbc: clip(b.fbc, 300), gpc: b.gpc ? '1' : '',
    ip: clip(fwd || (req.socket && req.socket.remoteAddress) || '', 60), ua: clip(req.headers['user-agent'], 450), source_url: url,
  };
}

async function sendMetaEvent({ eventName, eventId, eventTime, value, extraCustom = {}, email, phone, userId, meta = {} }) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token) return { skipped: 'no token' };
  if (meta.gpc === '1') return { skipped: 'gpc' };
  const payload = {
    data: [{
      event_name: eventName,
      event_time: eventTime || Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: 'website',
      event_source_url: meta.source_url || 'https://www.claimclub.io/claim',
      user_data: {
        em: email ? [sha(email)] : undefined,
        ph: phone ? [sha(String(phone).replace(/\D/g, ''))] : undefined,
        external_id: userId ? [sha(userId)] : undefined,
        fbp: meta.fbp || undefined,
        fbc: meta.fbc || undefined,
        client_ip_address: meta.ip || undefined,
        client_user_agent: meta.ua || undefined,
      },
      custom_data: { currency: 'USD', value, ...extraCustom },
    }],
    ...(process.env.META_TEST_CODE ? { test_event_code: process.env.META_TEST_CODE } : {}),
  };
  const ver = process.env.META_API_VERSION || 'v26.0', pixel = process.env.META_PIXEL_ID || PIXEL;
  try {
    const r = await fetch(`https://graph.facebook.com/${ver}/${pixel}/events?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) console.error('[meta] CAPI error', eventName, eventId, JSON.stringify(j).slice(0, 300));
    return j;
  } catch (e) { console.error('[meta] CAPI failed', eventName, eventId, e.message); return { error: e.message }; }
}

module.exports = { sendMetaEvent, attribution, sha };
