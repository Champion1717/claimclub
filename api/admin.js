// POST /api/admin  { action, ... }  Staff-only API behind /admin.
// The caller must be signed in (Bearer token) and listed in the admins table or in the ADMIN_EMAILS env var.
const { db, userFrom, readJson, send } = require('./_db');
const { sendClaimEmail } = require('./_email');

const STATUSES = ['ready', 'requested', 'needs_info', 'filed', 'review', 'approved', 'paid', 'denied', 'removed'];
const money = (c) => '$' + (Math.round(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function isAdmin(user) {
  const list = String(process.env.ADMIN_EMAILS || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (user.email && list.includes(user.email.toLowerCase())) return true;
  const { data } = await db().from('admins').select('user_id').eq('user_id', user.id).maybeSingle();
  return !!data;
}
// Feature switches shown in /admin > Settings. Each entry turns the posted value into what we store.
const SETTINGS = { bank_connect: (v) => v === true, card_connect: (v) => v === true };
async function readSettings() {
  const out = { bank_connect: false, card_connect: false };
  const { data } = await db().from('app_settings').select('key, value, updated_by, updated_at');
  (data || []).forEach((r) => { out[r.key] = r.value; out[r.key + '_meta'] = { by: r.updated_by, at: r.updated_at }; });
  return out;
}
const count = async (q) => { const { count: n } = await q; return n || 0; };

const actions = {

  async refunds(b) {
    const sb = db(), want = Array.isArray(b.statuses) && b.statuses.length ? b.statuses : ['requested', 'replied'];
    const { data: rows, error } = await sb.from('refund_requests').select('*').in('status', want).order('created_at', { ascending: true }).limit(500);
    if (error) throw error;
    const ids = [...new Set((rows || []).map((r) => r.user_id))];
    const { data: profs } = ids.length ? await sb.from('profiles').select('id, name, email, phone, address').in('id', ids) : { data: [] };
    const P = {}; (profs || []).forEach((p) => { P[p.id] = p; });
    const { count: open } = await sb.from('refund_requests').select('id', { count: 'exact', head: true }).in('status', ['requested', 'replied']);
    return { refunds: (rows || []).map((r) => Object.assign({}, r, { profile: P[r.user_id] || null })), open: open || 0 };
  },

  async setRefund(b) {
    const ok = ['requested', 'replied', 'refunded', 'denied', 'removed'];
    if (!b.id || !ok.includes(b.status)) return { error: 'Pick a status' };
    const { data, error } = await db().from('refund_requests').update({ status: b.status, admin_note: b.note ? String(b.note).slice(0, 500) : null }).eq('id', b.id).select().maybeSingle();
    if (error) throw error;
    return { refund: data };
  },
  async me(b, user) { return { admin: true, email: user.email, settings: await readSettings() }; },

  async settings() { return { settings: await readSettings() }; },

  async setSetting(b, user) {
    if (!SETTINGS[b.key]) return { error: 'Unknown setting' };
    const value = SETTINGS[b.key](b.value);
    const { error } = await db().from('app_settings').upsert({ key: b.key, value, updated_by: user.email || 'staff', updated_at: new Date().toISOString() });
    if (error) throw error;
    return { settings: await readSettings() };
  },

  async overview() {
    const sb = db(), since7 = new Date(Date.now() - 7 * 864e5).toISOString();
    const [members, members7, orders, auths, emailsFailed] = await Promise.all([
      count(sb.from('profiles').select('id', { count: 'exact', head: true })),
      count(sb.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', since7)),
      count(sb.from('purchases').select('id', { count: 'exact', head: true })),
      count(sb.from('authorizations').select('id', { count: 'exact', head: true })),
      count(sb.from('email_log').select('id', { count: 'exact', head: true }).not('error', 'is', null).gte('created_at', since7))
    ]);
    const [{ data: buys }, { data: mems }, { data: claims }, { data: daily }, { data: funnel }] = await Promise.all([
      sb.from('purchases').select('kind, plan, amount_cents, created_at').order('created_at', { ascending: false }).limit(5000),
      sb.from('memberships').select('kind, plan, status').limit(10000),
      sb.from('claims').select('status').limit(50000),
      sb.rpc('admin_daily', { p_days: 30 }),
      sb.rpc('admin_funnel', { p_days: 30 })
    ]);
    const revenue = (buys || []).reduce((t, p) => t + (p.amount_cents || 0), 0);
    const by = (arr, k) => (arr || []).reduce((m, r) => { const v = r[k] || 'none'; m[v] = (m[v] || 0) + 1; return m; }, {});
    const activeMem = (mems || []).filter((m) => m.kind === 'member' && (m.status === 'active' || m.status === 'cancelling'));
    const visitors = (funnel || []).reduce((m, r) => Math.max(m, Number(r.visitors) || 0), 0);
    return {
      members, members7, orders, revenue: money(revenue), revenueCents: revenue, authorizations: auths, emailsFailed,
      ordersByKind: by(buys, 'kind'), activeMembers: activeMem.length, activeByPlan: by(activeMem, 'plan'),
      claimsByStatus: by(claims, 'status'), queue: ((by(claims, 'status').requested) || 0) + ((by(claims, 'status').needs_info) || 0),
      visitors30: visitors, daily: daily || []
    };
  },

  async funnel(b) {
    const days = Math.min(365, Math.max(1, parseInt(b.days, 10) || 30));
    const { data, error } = await db().rpc('admin_funnel', { p_days: days });
    if (error) throw error;
    return { days, steps: data || [] };
  },

  async users(b) {
    const sb = db(), from = Math.max(0, parseInt(b.offset, 10) || 0);
    let q = sb.from('profiles').select('id, email, name, phone, state, address, created_at, pay_default', { count: 'exact' }).order('created_at', { ascending: false }).range(from, from + 49);
    const term = String(b.q || '').trim().replace(/[,%()]/g, ' ');
    if (term) q = q.or('email.ilike.%' + term + '%,name.ilike.%' + term + '%,phone.ilike.%' + term + '%');
    const { data: users, count: total, error } = await q;
    if (error) throw error;
    const ids = (users || []).map((u) => u.id);
    const [{ data: claims }, { data: mems }, { data: auths }] = ids.length ? await Promise.all([
      sb.from('claims').select('user_id, status').in('user_id', ids),
      sb.from('memberships').select('user_id, kind, plan, status').in('user_id', ids),
      sb.from('authorizations').select('user_id').in('user_id', ids)
    ]) : [{ data: [] }, { data: [] }, { data: [] }];
    return {
      total, offset: from,
      users: (users || []).map((u) => {
        const c = (claims || []).filter((x) => x.user_id === u.id), m = (mems || []).find((x) => x.user_id === u.id);
        return Object.assign({}, u, { claims: c.length, requested: c.filter((x) => x.status === 'requested').length, signed: (auths || []).filter((x) => x.user_id === u.id).length, membership: m || null });
      })
    };
  },

  async user(b) {
    const sb = db(), id = String(b.id || '');
    const { data: profile } = await sb.from('profiles').select('*').eq('id', id).maybeSingle();
    if (!profile) return { error: 'Not found' };
    const em = (profile.email || '').toLowerCase();
    const [{ data: claims }, { data: membership }, { data: purchases }, { data: auths }, { data: events }, { data: emails }] = await Promise.all([
      sb.from('claims').select('*').eq('user_id', id).order('created_at'),
      sb.from('memberships').select('*').eq('user_id', id).maybeSingle(),
      sb.from('purchases').select('*').or('user_id.eq.' + id + (em ? ',email.ilike.' + em : '')).order('created_at', { ascending: false }),
      sb.from('authorizations').select('id, settlement_id, settlement_title, signer_name, signature_text, method, ip, user_agent, created_at, client_signed_at, record_hash').or('user_id.eq.' + id + (em ? ',email.ilike.' + em : '')).order('created_at'),
      sb.from('claim_events').select('*').eq('user_id', id).order('created_at', { ascending: false }).limit(200),
      sb.from('email_log').select('*').eq('user_id', id).order('created_at', { ascending: false }).limit(50)
    ]);
    return { profile, claims: claims || [], membership, purchases: purchases || [], authorizations: auths || [], events: events || [], emails: emails || [] };
  },

  async authorization(b) {
    const { data } = await db().from('authorizations').select('*').eq('id', parseInt(b.id, 10) || 0).maybeSingle();
    return data ? { authorization: data } : { error: 'Not found' };
  },

  async queue(b) {
    const sb = db(), want = (Array.isArray(b.statuses) ? b.statuses : ['requested', 'needs_info']).filter((s) => STATUSES.includes(s));
    const { data: claims, error } = await sb.from('claims').select('*').in('status', want).order('requested_at', { ascending: true, nullsFirst: false }).limit(500);
    if (error) throw error;
    const ids = [...new Set((claims || []).map((c) => c.user_id))];
    const [{ data: profiles }, { data: auths }] = ids.length ? await Promise.all([
      sb.from('profiles').select('id, email, name, phone, dob, address, state, pay_default, payout_handles').in('id', ids),
      sb.from('authorizations').select('id, user_id, settlement_id, created_at').in('user_id', ids)
    ]) : [{ data: [] }, { data: [] }];
    return {
      claims: (claims || []).map((c) => Object.assign({}, c, {
        profile: (profiles || []).find((p) => p.id === c.user_id) || null,
        authorization: (auths || []).find((a) => a.user_id === c.user_id && a.settlement_id === c.settlement_id) || null
      }))
    };
  },

  async setStatus(b, user) {
    const sb = db(), id = parseInt(b.claim_id, 10), status = String(b.status || '');
    if (!id || !STATUSES.includes(status)) return { error: 'Pick a valid status' };
    const { data: cur } = await sb.from('claims').select('*').eq('id', id).maybeSingle();
    if (!cur) return { error: 'Claim not found' };
    const patch = { status };
    if (b.claim_ref !== undefined) patch.claim_ref = String(b.claim_ref || '').slice(0, 120) || null;
    if (b.note !== undefined) patch.admin_note = String(b.note || '').slice(0, 1000) || null;
    if (status === 'filed' && !cur.filed_at) patch.filed_at = new Date().toISOString();
    if (status === 'paid') { patch.paid_at = cur.paid_at || new Date().toISOString(); if (b.amount_cents) patch.paid_amount_cents = Math.round(+b.amount_cents) || null; }
    const { data: row, error } = await sb.from('claims').update(patch).eq('id', id).select().maybeSingle();
    if (error) throw error;
    // The status trigger wrote a claim_events row; add the note and who did it.
    const { data: ev } = await sb.from('claim_events').select('id').eq('claim_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    let mail = { skipped: true };
    if (b.notify !== false && status !== cur.status) {
      const { data: prof } = await sb.from('profiles').select('email, email_receipts, pay_default').eq('id', cur.user_id).maybeSingle();
      if (prof && prof.email && prof.email_receipts !== false) {
        mail = await sendClaimEmail({ to: prof.email, userId: cur.user_id, status, title: b.title || cur.settlement_id, ref: patch.claim_ref || cur.claim_ref, note: patch.admin_note, amount: row && row.paid_amount_cents ? money(row.paid_amount_cents) : '', method: prof.pay_default });
      }
    }
    if (ev) await sb.from('claim_events').update({ note: [b.note ? String(b.note).slice(0, 500) : '', 'by ' + (user.email || 'staff')].filter(Boolean).join(' · '), emailed: !!mail.sent, actor: 'staff' }).eq('id', ev.id);
    return { claim: row, email: mail };
  }
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  let user;
  try { user = await userFrom(req); } catch (e) { return send(res, 500, { error: e.message }); }
  if (!user) return send(res, 401, { error: 'Sign in first' });
  try { if (!(await isAdmin(user))) return send(res, 403, { error: 'This account is not an admin' }); } catch (e) { return send(res, 500, { error: e.message }); }
  const b = await readJson(req), fn = actions[b.action];
  if (!fn) return send(res, 400, { error: 'Unknown action' });
  try { return send(res, 200, await fn(b, user)); } catch (e) { return send(res, 500, { error: e.message || 'Server error' }); }
};
