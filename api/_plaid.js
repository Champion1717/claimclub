// Plaid helpers (Nov 15 2026): API calls, access-token encryption, transaction sync, the charge review rules and
// recurring (subscription) streams. Env: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox | production),
// PLAID_TOKEN_KEY (any long random string, used to encrypt access tokens at rest), optional PLAID_REDIRECT_URI
// (must also be listed in the Plaid dashboard) and PLAID_BASE_URL (tests only).
const crypto = require('crypto');
const { db } = require('./_db');

const ENV = () => (process.env.PLAID_ENV || 'sandbox').toLowerCase();
const norm = (e) => (String(e || '').toLowerCase() === 'production' ? 'production' : 'sandbox');
const BASE = (env) => process.env.PLAID_BASE_URL || ('https://' + norm(env || ENV()) + '.plaid.com');
// Each mode has its own secret: PLAID_SECRET_SANDBOX and PLAID_SECRET_PRODUCTION (PLAID_SECRET still works as a fallback).
const SECRET = (env) => (norm(env || ENV()) === 'production' ? process.env.PLAID_SECRET_PRODUCTION : process.env.PLAID_SECRET_SANDBOX) || process.env.PLAID_SECRET;
const configured = () => !!(process.env.PLAID_CLIENT_ID && SECRET() && process.env.PLAID_TOKEN_KEY);

// env: which Plaid mode to call. Saved connections pass their own env so sandbox ones keep working after the switch to production.
async function plaid(path, body, env) {
  const r = await fetch(BASE(env) + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ client_id: process.env.PLAID_CLIENT_ID, secret: SECRET(env) }, body || {})) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error_code) { const e = new Error(j.error_message || j.display_message || 'Plaid request failed'); e.code = j.error_code || 'HTTP_' + r.status; e.type = j.error_type; throw e; }
  return j;
}

// AES-256-GCM with a key derived from PLAID_TOKEN_KEY. Stored as base64(iv|tag|ciphertext).
const key = () => crypto.createHash('sha256').update(String(process.env.PLAID_TOKEN_KEY || '')).digest();
function seal(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function open(blob) {
  const b = Buffer.from(blob, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

const nice = (s) => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
function txRow(t, item) {
  const pfc = t.personal_finance_category || {};
  return {
    transaction_id: t.transaction_id, user_id: item.user_id, item_id: item.item_id, account_id: t.account_id,
    date: t.authorized_date || t.date, amount: Math.round(Number(t.amount || 0) * 100) / 100,
    name: t.name || '', merchant_name: t.merchant_name || null, descriptor: t.original_description || t.name || '',
    category: pfc.primary || null, category_detail: pfc.detailed || null, website: t.website || null, logo_url: t.logo_url || null,
    pending: !!t.pending
  };
}

// Charge review rules. Positive amounts are money out. Returns { verdict, reasons, back }.
const FEE = /(overdraft|nsf|insufficient funds|late fee|late charge|returned item|service charge|maintenance fee|monthly fee|foreign transaction|atm fee|paper statement)/i;
function review(rows, streams) {
  const out = {}, byKey = {};
  const label = (t) => (t.merchant_name || t.name || '').trim();
  rows.forEach((t) => { if (t.amount > 0 && !t.pending) { const k = label(t).toLowerCase() + '|' + t.amount; (byKey[k] = byKey[k] || []).push(t); } });
  const streamOf = {};
  (streams || []).forEach((s) => { const m = (s.merchant || s.description || '').toLowerCase(); if (m) streamOf[m] = s; });
  rows.forEach((t) => {
    if (t.amount <= 0) { out[t.transaction_id] = { verdict: 'ok', reasons: ['Money coming in.'], back: null }; return; }
    const name = label(t), reasons = []; let verdict = 'ok', back = null;
    // 1. Same company, same amount, within 2 days.
    const twins = (byKey[name.toLowerCase() + '|' + t.amount] || []).filter((o) => o.transaction_id !== t.transaction_id && Math.abs(new Date(o.date) - new Date(t.date)) <= 2 * 864e5);
    if (twins.length && !t.pending) { verdict = 'fight'; back = t.amount; reasons.push('Charged ' + (twins.length + 1) + ' times for $' + t.amount.toFixed(2) + ' within 2 days.', 'If you only bought this once, the extra charge should come back.'); }
    // 2. Bank or card fees.
    else if (FEE.test(t.name + ' ' + (t.descriptor || '')) || t.category === 'BANK_FEES') { verdict = 'fight'; back = t.amount; reasons.push('This looks like a ' + (/(overdraft|nsf|insufficient)/i.test(t.name) ? 'overdraft fee' : 'bank or card fee') + '.', 'Banks often refund fees when you ask, especially the first one.'); }
    else {
      const s = streamOf[name.toLowerCase()];
      // 3. A subscription whose price went up.
      if (s && s.average_amount && t.amount > Number(s.average_amount) * 1.1 + 0.5) { verdict = 'look'; reasons.push('Usually $' + Number(s.average_amount).toFixed(2) + ', this time $' + t.amount.toFixed(2) + '.', 'Price went up. Did you agree to the new price?'); }
      // 4. A subscription that only just started.
      else if (s && (s.status === 'EARLY_DETECTION' || (s.first_date && Date.now() - new Date(s.first_date) < 40 * 864e5))) { verdict = 'look'; reasons.push('A new repeating charge that started ' + s.first_date + '.', 'Did you mean to sign up, or was it a free trial?'); }
      // 5. Bigger charges we cannot name.
      else if (!t.merchant_name && t.amount >= 50 && !/transfer|payment|deposit|zelle|venmo|paypal/i.test(t.name)) { verdict = 'look'; reasons.push('We could not tell which company this is.', 'Do you recognize this charge?'); }
      else reasons.push('Looks like a normal purchase.');
    }
    out[t.transaction_id] = { verdict, reasons, back };
  });
  return out;
}

const PER_MONTH = { WEEKLY: 52 / 12, BIWEEKLY: 26 / 12, SEMI_MONTHLY: 2, MONTHLY: 1, ANNUALLY: 1 / 12 };
const NOT_SUBS = ['LOAN_PAYMENTS', 'TRANSFER_OUT', 'TRANSFER_IN', 'RENT_AND_UTILITIES', 'INCOME', 'BANK_FEES'];

// Pull new transactions for one item (cursor based), refresh recurring streams, rerun the review rules.
async function syncItem(item) {
  const sb = db(), token = open(item.access_token_enc);
  let cursor = item.cursor || undefined, more = true, n = 0, guard = 0;
  try {
    while (more && guard++ < 20) {
      const j = await plaid('/transactions/sync', { access_token: token, cursor, count: 500, options: { include_original_description: true } }, item.env);
      const up = (j.added || []).concat(j.modified || []).map((t) => txRow(t, item));
      if (up.length) { const { error } = await sb.from('bank_transactions').upsert(up, { onConflict: 'transaction_id' }); if (error) throw error; }
      const gone = (j.removed || []).map((r) => r.transaction_id);
      if (gone.length) await sb.from('bank_transactions').delete().in('transaction_id', gone);
      n += up.length; cursor = j.next_cursor; more = !!j.has_more;
    }
  } catch (e) {
    if (e.code === 'ITEM_LOGIN_REQUIRED') { await sb.from('plaid_items').update({ status: 'login_required', error_code: e.code }).eq('item_id', item.item_id); return { added: 0, login: true }; }
    throw e;
  }
  // Recurring streams (needs the Recurring Transactions add-on; skipped quietly when not enabled yet).
  try {
    const r = await plaid('/transactions/recurring/get', { access_token: token }, item.env);
    const rows = (r.outflow_streams || []).filter((s) => !NOT_SUBS.includes((s.personal_finance_category || {}).primary)).map((s) => ({
      stream_id: s.stream_id, user_id: item.user_id, item_id: item.item_id, merchant: s.merchant_name || s.description, description: s.description,
      category: (s.personal_finance_category || {}).primary || null, frequency: s.frequency, first_date: s.first_date || null, last_date: s.last_date || null,
      next_date: s.predicted_next_date || null, last_amount: (s.last_amount || {}).amount ?? null, average_amount: (s.average_amount || {}).amount ?? null,
      status: s.status, is_active: s.is_active !== false, updated_at: new Date().toISOString() }));
    if (rows.length) await sb.from('bank_recurring').upsert(rows, { onConflict: 'stream_id' });
  } catch (e) {}
  await sb.from('plaid_items').update({ cursor, synced_at: new Date().toISOString(), status: 'ok', error_code: null }).eq('item_id', item.item_id);
  await rereview(item.user_id);
  return { added: n };
}

async function rereview(uid) {
  const sb = db(), since = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  const { data: tx } = await sb.from('bank_transactions').select('transaction_id, amount, date, name, merchant_name, descriptor, category, category_detail, pending').eq('user_id', uid).gte('date', since);
  const { data: st } = await sb.from('bank_recurring').select('merchant, description, average_amount, first_date, status').eq('user_id', uid);
  const v = review((tx || []).map((t) => Object.assign({}, t, { amount: Number(t.amount) })), st || []);
  const rows = Object.entries(v).map(([id, r]) => ({ transaction_id: id, verdict: r.verdict, reasons: r.reasons, back: r.back }));
  for (const r of rows) await sb.from('bank_transactions').update({ verdict: r.verdict, reasons: r.reasons, back: r.back }).eq('transaction_id', r.transaction_id);
}

// What the member app shows: cards, last 90 days of charges, active subscriptions.
async function state(uid) {
  const sb = db(), since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const [{ data: items }, { data: accts }, { data: tx }, { data: subs }] = await Promise.all([
    sb.from('plaid_items').select('item_id, institution_name, status, synced_at, created_at').eq('user_id', uid),
    sb.from('plaid_accounts').select('account_id, item_id, name, mask, subtype').eq('user_id', uid),
    sb.from('bank_transactions').select('transaction_id, item_id, account_id, date, amount, name, merchant_name, descriptor, category, category_detail, website, logo_url, pending, verdict, reasons, back, user_choice').eq('user_id', uid).gte('date', since).order('date', { ascending: false }).limit(600),
    sb.from('bank_recurring').select('stream_id, item_id, merchant, description, category, frequency, first_date, last_date, next_date, last_amount, average_amount, status, is_active, user_choice').eq('user_id', uid)
  ]);
  const A = {}; (accts || []).forEach((a) => { A[a.account_id] = a; });
  return {
    items: (items || []).map((i) => Object.assign({}, i, { accounts: (accts || []).filter((a) => a.item_id === i.item_id).map((a) => ({ name: a.name, mask: a.mask, subtype: a.subtype })) })),
    tx: (tx || []).filter((t) => Number(t.amount) > 0).map((t) => Object.assign({}, t, { amount: Number(t.amount), back: t.back == null ? null : Number(t.back), card: A[t.account_id] ? (A[t.account_id].name + ' ' + (A[t.account_id].mask || '')).trim() : '' })),
    subs: (subs || []).filter((s) => s.is_active).map((s) => Object.assign({}, s, { last_amount: Number(s.last_amount || 0), average_amount: Number(s.average_amount || 0), per_month: Math.round(Number(s.last_amount || 0) * (PER_MONTH[s.frequency] || 1) * 100) / 100 }))
  };
}

async function isAdmin(user) {
  const list = String(process.env.ADMIN_EMAILS || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (user.email && list.includes(user.email.toLowerCase())) return true;
  const { data } = await db().from('admins').select('user_id').eq('user_id', user.id).maybeSingle();
  return !!data;
}
async function cardsOn() {
  try { const { data } = await db().from('app_settings').select('value').eq('key', 'card_connect').maybeSingle(); return !!data && data.value === true; } catch (e) { return false; }
}

module.exports = { norm, plaid, seal, open, syncItem, rereview, state, review, isAdmin, cardsOn, configured, ENV };
