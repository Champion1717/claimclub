// GET /api/config -> public settings the browser needs. The anon key is safe to expose; row level security protects the data.
// Feature switches (set in /admin > Settings) come from the app_settings table.
const { URL_, PUBLIC_KEY, db } = require('./_db');
module.exports = async (req, res) => {
  let bankConnect = false;
  try {
    const { data } = await db().from('app_settings').select('key, value').in('key', ['bank_connect']);
    (data || []).forEach((r) => { if (r.key === 'bank_connect') bankConnect = r.value === true; });
  } catch (e) {}
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=30');
  res.end(JSON.stringify({
    supabaseUrl: URL_(),
    supabaseAnonKey: PUBLIC_KEY(),
    testMode: process.env.ALLOW_TEST_MEMBERSHIP === '1',
    bankConnect
  }));
};
