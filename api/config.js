// GET /api/config -> public settings the browser needs. The anon key is safe to expose; row level security protects the data.
const { URL_, PUBLIC_KEY } = require('./_db');
module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.end(JSON.stringify({
    supabaseUrl: URL_(),
    supabaseAnonKey: PUBLIC_KEY(),
    testMode: process.env.ALLOW_TEST_MEMBERSHIP === '1'
  }));
};
