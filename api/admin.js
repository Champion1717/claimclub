// POST /api/admin  { action, ... }  Staff-only API behind /admin.
// The caller must be signed in (Bearer token) and listed in the admins table or in the ADMIN_EMAILS env var.
const { db, userFrom, readJson, send } = require('./_db');
const { sendClaimEmail, sendNotice, COPY } = require('./_email');
const { bot, botKeyOk, profileFor, botSettings, PROFILES, captchaFor, scansFor } = require('./_bot');
const { getSpec, getSpecs } = require('./_spec');

const { tierFor, paidEmails, TIERS, tierOf, fileBlock } = require('./_tiers');
const STATUSES = ['ready', 'requested', 'needs_info', 'filed', 'review', 'approved', 'paid', 'denied', 'removed', 'auto', 'self'];
const SPEC_KEYS = ['type', 'filer', 'form_url', 'admin', 'deadline', 'minutes', 'about', 'who', 'qualify', 'notice', 'needs', 'why_self', 'gather', 'steps', 'form_map', 'va_notes', 'member_note', 'start_note'];
const money = (c) => '$' + (Math.round(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function isAdmin(user) {
  const list = String(process.env.ADMIN_EMAILS || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (user.email && list.includes(user.email.toLowerCase())) return true;
  const { data } = await db().from('admins').select('user_id').eq('user_id', user.id).maybeSingle();
  return !!data;
}
// Feature switches shown in /admin > Settings. Each entry turns the posted value into what we store.
const { OFFERS, DEFAULT_ON, FLOWS, SOURCES } = require('./_offers');
const SETTINGS = { bank_connect: (v) => v === true, card_connect: (v) => v === true,
  // Offer test (Nov 21 2026): which offers new visitors can get. At least one stays on.
  offer_test: (v) => { const o = {}; FLOWS.forEach((k) => { o[k] = !!(v && v[k] === true); }); if (!FLOWS.some((k) => o[k])) o.b = true; return o; },
  filing_bot: (v) => ({ mode: ['off', 'dry', 'submit'].includes(v && v.mode) ? v.mode : 'off', profiles: Array.isArray(v && v.profiles) ? v.profiles.filter((x) => PROFILES.includes(x)) : [] }) };
async function readSettings() {
  const out = { bank_connect: false, card_connect: false, filing_bot: { mode: 'off', profiles: [] }, offer_test: Object.assign({}, DEFAULT_ON) };
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

  // Funnel (Nov 21 2026): date range (Pacific days, from..to inclusive), offer, traffic source and device type.
  // Returns the step funnel plus rows for each offer, source, device and day (admin_report in db/offer_test.sql).
  async funnel(b) {
    const okDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
    const pac = (d) => { const x = new Date(d + 'T12:00:00Z'); const off = new Date(x.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })) - new Date(x.toLocaleString('en-US', { timeZone: 'UTC' })); return new Date(Date.parse(d + 'T00:00:00Z') - off); };
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const to = okDay(b.to) ? b.to : today, from = okDay(b.from) ? b.from : new Date(Date.parse(to) - 29 * 864e5).toISOString().slice(0, 10);
    const end = new Date(pac(to).getTime() + 864e5);
    const flow = FLOWS.includes(b.flow) ? b.flow : null, source = SOURCES.concat(['unknown']).includes(b.source) ? b.source : null;
    const dtype = ['iphone', 'android', 'tablet', 'mac', 'windows', 'other', 'unknown'].includes(b.dtype) ? b.dtype : null;
    const { data, error } = await db().rpc('admin_report', { p_from: pac(from).toISOString(), p_to: end.toISOString(), p_flow: flow, p_source: source, p_dtype: dtype });
    if (error) throw error;
    const offers = {}; FLOWS.forEach((k) => { offers[k] = OFFERS[k].name; });
    return { from, to, flow, source, dtype, steps: (data && data.steps) || [], rows: (data && data.rows) || [], offers, on: (await readSettings()).offer_test };
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
    const [{ data: profiles }, { data: auths }, { data: mems }] = ids.length ? await Promise.all([
      sb.from('profiles').select('id, email, name, phone, dob, address, state, pay_default, payout_handles').in('id', ids),
      sb.from('authorizations').select('id, user_id, settlement_id, created_at').in('user_id', ids),
      sb.from('memberships').select('user_id, kind, plan, status').in('user_id', ids)
    ]) : [{ data: [] }, { data: [] }, { data: [] }];
    // Offer G tiers (Nov 21): file-by time from the plan (Standard 30 days, Fast 3 days, Priority 24 hours), Priority first.
    const TIER = {}; (mems || []).forEach((m) => { TIER[m.user_id] = tierOf(m); });
    const sids = [...new Set((claims || []).map((c) => c.settlement_id))];
    const specs = await getSpecs(sids);
    const cids = (claims || []).map((c) => c.id);
    const { data: runs } = cids.length ? await sb.from('bot_runs').select('id, claim_id, status, mode, error, confirmation, started_at').in('claim_id', cids).order('started_at', { ascending: false }) : { data: [] };
    const RUN = {}; (runs || []).forEach((r) => { if (!RUN[r.claim_id]) RUN[r.claim_id] = r; });
    const SCAN = await scansFor(sids);
    const RANK = { pri: 0, all: 1, fast: 2, fee: 3, std: 4 };
    const out = [];
    for (const c of claims || []) {
      const t = TIER[c.user_id] || null, T = TIERS[t], since = Date.parse(c.requested_at || c.updated_at || c.created_at) || Date.now();
      out.push(Object.assign({}, c, { tier: t, tierName: T ? T.name : t === 'all' ? 'Member' : t === 'fee' ? 'Filing fee' : '', dueAt: T ? new Date(since + T.hours * 3600e3).toISOString() : null,
        notInPlan: t ? await fileBlock(t, c.settlement_id) : '' }));
    }
    out.sort((a, b) => ((RANK[a.tier] ?? 5) - (RANK[b.tier] ?? 5)) || ((Date.parse(a.dueAt || '') || 9e15) - (Date.parse(b.dueAt || '') || 9e15)));
    return {
      claims: out.map((c) => Object.assign({}, c, {
        spec: specs[c.settlement_id] || null, bot: RUN[c.id] || null, botProfile: profileFor(specs[c.settlement_id]), captcha: captchaFor(SCAN[c.settlement_id], c.answers),
        profile: (profiles || []).find((p) => p.id === c.user_id) || null,
        authorization: (auths || []).find((a) => a.user_id === c.user_id && a.settlement_id === c.settlement_id) || null
      }))
    };
  },

  // Proof files a member uploaded for one claim, as links that work for 10 minutes.
  async files(b) {
    const sb = db();
    const { data: rows, error } = await sb.from('claim_files').select('*').eq('user_id', String(b.user_id || '')).eq('settlement_id', String(b.settlement_id || '')).order('created_at');
    if (error) throw error;
    const out = [];
    for (const f of rows || []) {
      const { data: u } = await sb.storage.from('claim-files').createSignedUrl(f.path, 600);
      out.push({ id: f.id, name: f.name, size: f.size, mime: f.mime, created_at: f.created_at, url: u ? u.signedUrl : null });
    }
    return { files: out };
  },

  // ---------- filing specs and the case finder (Nov 18 2026) ----------
  async spec(b) {
    return { spec: await getSpec(String(b.id || '')) };
  },

  async saveSpec(b, user) {
    const id = String(b.id || '').trim().slice(0, 80), x = b.spec || {};
    if (!id || !['auto', 'we', 'self', 'closed'].includes(x.type)) return { error: 'Pick a filing type' };
    const row = { id, updated_at: new Date().toISOString(), updated_by: user.email || 'staff', source: 'staff' };
    SPEC_KEYS.forEach((k) => { if (x[k] !== undefined) row[k] = x[k] === '' ? null : x[k]; });
    if (!row.filer) row.filer = x.type === 'self' ? 'member' : x.type === 'we' ? 'va' : 'none';
    const { data, error } = await db().from('settlement_filing').upsert(row).select().maybeSingle();
    if (error) throw error;
    return { spec: data };
  },

  async cases(b) {
    const sb = db(), status = ['new', 'approved', 'ignored'].includes(b.status) ? b.status : 'new';
    let q = sb.from('case_candidates').select('*').eq('status', status).order('found_at', { ascending: false }).limit(300);
    if (b.kind === 'new' || b.kind === 'change') q = q.eq('kind', b.kind);
    const [{ data: rows, error }, { data: last }, { data: counts }] = await Promise.all([q, sb.from('app_settings').select('value').eq('key', 'finder_last').maybeSingle(), sb.from('case_candidates').select('kind').eq('status', 'new').limit(5000)]);
    if (error) throw error;
    const n = { new: 0, change: 0 }; (counts || []).forEach((r) => { n[r.kind] = (n[r.kind] || 0) + 1; });
    return { cases: rows || [], last: last ? last.value : null, counts: n };
  },

  async runFinder() { return { last: await require('./find-cases').run() }; },

  // Approve a new case (adds it to the catalog with its filing spec) or a change (hides a closed case, moves a deadline...), or ignore it.
  async caseAction(b, user) {
    const sb = db(), id = parseInt(b.id, 10) || 0, by = user.email || 'staff', now = new Date().toISOString();
    const { data: c } = await sb.from('case_candidates').select('*').eq('id', id).maybeSingle();
    if (!c) return { error: 'Case not found' };
    if (b.op === 'ignore') {
      await sb.from('case_candidates').update({ status: 'ignored', reviewed_by: by, reviewed_at: now }).eq('id', id);
      return { ok: true };
    }
    if (b.op !== 'approve') return { error: 'Unknown action' };
    if (c.kind === 'change') {
      const sid = c.settlement_id, patch = (c.details && c.details.patch) || {};
      if (!sid) return { error: 'This change has no settlement' };
      const { data: ex } = await sb.from('catalog_extra').select('*').eq('id', sid).maybeSingle();
      const row = { id: sid, data: Object.assign({}, (ex && ex.data) || {}, patch.data || {}), is_new: !!(ex && ex.is_new), hidden: patch.hidden != null ? !!patch.hidden : !!(ex && ex.hidden), updated_at: now, updated_by: by };
      const { error } = await sb.from('catalog_extra').upsert(row);
      if (error) throw error;
      const cur = await getSpec(sid);
      if (cur && ((patch.data && patch.data.dl) || patch.hidden)) {
        const up = Object.assign({}, cur, { id: sid, updated_at: now, updated_by: by, source: 'staff' });
        if (patch.data && patch.data.dl) up.deadline = patch.data.dl;
        if (patch.hidden) { up.type = 'closed'; up.filer = 'none'; }
        delete up.confidence;
        await sb.from('settlement_filing').upsert(Object.fromEntries(['id', 'type', 'filer', 'form_url', 'admin', 'deadline', 'minutes', 'needs', 'why_self', 'gather', 'steps', 'form_map', 'va_notes', 'member_note', 'source', 'updated_at', 'updated_by'].filter((k) => up[k] !== undefined).map((k) => [k, up[k] === '' ? null : up[k]])));
      }
    } else {
      const f = b.fields || {}, clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
      const sid = clean(f.id, 60).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
      const co = clean(f.co, 80), title = clean(f.title, 160);
      if (!sid || !co || !title) return { error: 'Add an ID, company and title' };
      const type = ['auto', 'we', 'self'].includes(f.type) ? f.type : 'we';
      const dl = /^\d{4}-\d{2}-\d{2}$/.test(f.dl || '') ? f.dl : null;
      const data = { id: sid, co, title, cat: clean(f.cat, 20) || 'products', pay: clean(f.pay, 80) || 'Varies', amt: parseFloat(f.amt) || 0, max: parseFloat(f.max) || 0,
        proof: clean(f.proof, 40) || 'No proof', mode: type === 'auto' ? 'auto' : 'here', dl, who: clean(f.who, 300), fund: clean(f.fund, 40), st: clean(f.st, 40), area: clean(f.area, 60), url: clean(f.url || c.url, 600), added: now.slice(0, 10) };
      const { error } = await sb.from('catalog_extra').upsert({ id: sid, data, is_new: true, hidden: false, updated_at: now, updated_by: by });
      if (error) throw error;
      const ex = await getSpec(sid);
      if (!ex) await sb.from('settlement_filing').insert({ id: sid, type, filer: type === 'self' ? 'member' : type === 'we' ? 'va' : 'none', form_url: clean(f.form_url, 600) || null, deadline: dl, source: 'case finder', updated_by: by });
      await sb.from('case_candidates').update({ settlement_id: sid }).eq('id', id);
    }
    await sb.from('case_candidates').update({ status: 'approved', reviewed_by: by, reviewed_at: now }).eq('id', id);
    return { ok: true };
  },

  botRuns: (b) => bot.botRuns(b),
  botApprove: (b, user) => bot.botApprove(b, user),
  botToStaff: (b, user) => bot.botToStaff(b, user),
  botRetry: (b) => bot.botRetry(b),
  botStats: () => bot.botStats(),

  // Sends a sample email to the signed-in staff member, to check that email works.
  async testEmail(b, user) {
    const r = await sendNotice({ to: user.email, userId: null, kind: 'test', c: { subject: 'Claimclub test email', head: 'Email works', body: '<p>This is a test from /admin. If you can read it, member emails are going out.</p>', cta: 'Open the admin', ctaUrl: 'https://www.claimclub.io/admin' } });
    return { email: r, to: user.email };
  },
  // Sends the email for a claim's current status again (for example after fixing the email setup).
  async resendEmail(b) {
    const sb = db(), id = parseInt(b.claim_id, 10);
    const { data: c } = await sb.from('claims').select('*').eq('id', id).maybeSingle();
    if (!c) return { error: 'Claim not found' };
    if (!COPY[c.status]) return { error: 'There is no member email for this status' };
    const { data: prof } = await sb.from('profiles').select('email, pay_default').eq('id', c.user_id).maybeSingle();
    if (!prof || !prof.email) return { error: 'This member has no email' };
    const email = await sendClaimEmail({ to: prof.email, userId: c.user_id, status: c.status, title: b.title || c.settlement_id, ref: c.claim_ref, note: c.admin_note, amount: c.paid_amount_cents ? money(c.paid_amount_cents) : '', method: c.payout_method || prof.pay_default });
    return { email };
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
    // Offer G: payout emails are a Fast and Priority perk; Standard members see the payout in their dashboard only.
    const noPaidMail = status === 'paid' && !paidEmails(await tierFor(cur.user_id));
    if (b.notify !== false && status !== cur.status && !noPaidMail) {
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
  // The filing bot signs its calls with BOT_KEY instead of a staff sign-in, and may only use its own three actions.
  if (req.headers['x-bot-key']) {
    if (!botKeyOk(req)) return send(res, 401, { error: 'Bad bot key' });
    const bb = await readJson(req);
    const fns = { botNext: (x) => bot.botNext(x), botScanList: (x) => bot.botScanList(x), botScanSave: (x) => bot.botScanSave(x), botShot: (x) => bot.botShot(x), botDone: (x) => bot.botDone(x, (y, u) => actions.setStatus(y, u)) };
    if (!fns[bb.action]) return send(res, 400, { error: 'Unknown bot action' });
    try { return send(res, 200, await fns[bb.action](bb)); } catch (e) { return send(res, 500, { error: e.message || 'Server error' }); }
  }
  let user;
  try { user = await userFrom(req); } catch (e) { return send(res, 500, { error: e.message }); }
  if (!user) return send(res, 401, { error: 'Sign in first' });
  try { if (!(await isAdmin(user))) return send(res, 403, { error: 'This account is not an admin' }); } catch (e) { return send(res, 500, { error: e.message }); }
  const b = await readJson(req), fn = actions[b.action];
  if (!fn) return send(res, 400, { error: 'Unknown action' });
  try { return send(res, 200, await fn(b, user)); } catch (e) { return send(res, 500, { error: e.message || 'Server error' }); }
};
