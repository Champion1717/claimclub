// GET /api/config -> public settings the browser needs. The anon key is safe to expose; row level security protects the data.
// Feature switches (set in /admin > Settings) come from the app_settings table.
const { URL_, PUBLIC_KEY, db } = require('./_db');
const crypto = require('crypto');
const { offersOn } = require('./_offers');
// ?test=<key> (Nov 15): says whether a claim-flow test link is valid (matches TEST_FLOW_KEY, 16+ characters). The key is never sent back.
function same(a, b) { return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function testOk(k) {
  const want = String(process.env.TEST_FLOW_KEY || '').trim();
  if (want.length < 16 || typeof k !== 'string') return false;
  k = k.trim();
  // a "+" in the link arrives as a space after URL decoding
  return same(k, want) || same(k.replace(/ /g, '+'), want);
}
module.exports = async (req, res) => {
  let bankConnect = false, cardConnect = false, offerVal = null;
  try {
    const { data } = await db().from('app_settings').select('key, value').in('key', ['bank_connect', 'card_connect', 'offer_test']);
    (data || []).forEach((r) => { if (r.key === 'bank_connect') bankConnect = r.value === true; if (r.key === 'card_connect') cardConnect = r.value === true; if (r.key === 'offer_test') offerVal = r.value; });
  } catch (e) {}
  res.setHeader('Content-Type', 'application/json');
  let tq = null; try { tq = new URL(req.url, 'http://x').searchParams.get('test'); } catch (e) {}
  res.setHeader('Cache-Control', tq ? 'private, no-store' : 'public, max-age=30, s-maxage=30');
  res.end(JSON.stringify({
    ...(tq ? { testKey: testOk(tq), testConfigured: String(process.env.TEST_FLOW_KEY || '').trim().length >= 16 } : {}),
    supabaseUrl: URL_(),
    supabaseAnonKey: PUBLIC_KEY(),
    testMode: process.env.ALLOW_TEST_MEMBERSHIP === '1',
    bankConnect,
    // Offer test (Nov 21 2026): the offers switched on in /admin > Settings > Offer test. New visitors get one at random.
    offers: offersOn(offerVal),
    cardConnect: cardConnect && !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_TOKEN_KEY)
  }));
};
