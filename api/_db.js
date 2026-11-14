// Shared server helpers for Supabase. Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server only, never sent to browsers).
const { createClient } = require('@supabase/supabase-js');
let admin = null;
// Accepts both the classic key names and the ones the Vercel Marketplace Supabase integration creates.
const env = (...names) => names.map((n) => process.env[n]).find(Boolean) || '';
const URL_ = () => env('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
const SECRET = () => env('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY');
const PUBLIC_KEY = () => env('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
function db() {
  if (!URL_() || !SECRET()) throw new Error('Supabase env vars are not set');
  if (!admin) admin = createClient(URL_(), SECRET(), { auth: { persistSession: false, autoRefreshToken: false } });
  return admin;
}
// Returns the signed-in user for a request carrying "Authorization: Bearer <access token>", or null.
async function userFrom(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const { data, error } = await db().auth.getUser(m[1]);
  return error ? null : data.user;
}
function readJson(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } }); });
}
const MONTHS = { '1m': 1, '3m': 3, '6m': 6 };
function renewsAt(plan, from) { const d = new Date(from || Date.now()); d.setMonth(d.getMonth() + (MONTHS[plan] || 1)); return d.toISOString(); }
function send(res, code, obj) { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); }
module.exports = { db, userFrom, readJson, renewsAt, send, MONTHS, URL_, PUBLIC_KEY };
