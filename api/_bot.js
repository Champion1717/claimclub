// Filing bot, server side (Nov 19 2026). The bot itself runs on a separate machine (bot/ folder in the repo) and talks
// only to /api/admin with the header x-bot-key = BOT_KEY. It never holds the database key.
// Flow: botNext hands out one claim, botShot gives a private upload link per screenshot, botDone stores the result.
// In practice mode ("dry") the bot fills the form and stops before Submit; staff look at the screenshots in /admin and
// press "Approve and submit", which queues the claim again in submit mode.
const crypto = require('crypto');
const { db } = require('./_db');
const { getSpecs } = require('./_spec');

const PROFILES = ['angeion', 'simpluris', 'kroll', 'epiq', 'verita', 'eisner', 'cpt', 'jnd', 'atticus', 'generic'];
function profileFor(spec) {
  const a = String((spec && spec.admin) || '').toLowerCase();
  if (/angeion/.test(a)) return 'angeion';
  if (/simpluris/.test(a)) return 'simpluris';
  if (/kroll/.test(a)) return 'kroll';
  if (/epiq/.test(a)) return 'epiq';
  if (/verita|kccllc/.test(a)) return 'verita';
  if (/eisner/.test(a)) return 'eisner';
  if (/\bcpt\b/.test(a)) return 'cpt';
  if (/\bjnd\b/.test(a)) return 'jnd';
  if (/atticus/.test(a)) return 'atticus';
  return 'generic';
}
function botKeyOk(req) {
  const want = String(process.env.BOT_KEY || ''), got = String(req.headers['x-bot-key'] || '');
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
async function botSettings() {
  const { data } = await db().from('app_settings').select('value').eq('key', 'filing_bot').maybeSingle();
  const v = (data && data.value) || {};
  return { mode: ['off', 'dry', 'submit'].includes(v.mode) ? v.mode : 'off', profiles: Array.isArray(v.profiles) ? v.profiles.filter((p) => PROFILES.includes(p)) : [] };
}
let CAT = {}; try { (require('./_catalog.json') || []).forEach((c) => { CAT[c.id] = c.title || c.co; }); } catch (e) {}
const titleOf = (id) => CAT[id] || id;
const isPdf = (u) => /\.pdf(\?|$)/i.test(u || '');

// CAPTCHA scans (bot/scan.js). A claim whose path through the form shows a CAPTCHA is filed by a VA, never the bot.
function hasNotice(answers) {
  const A = answers || {};
  return Object.keys(A).some((k) => k.indexOf('n_') === 0 && k !== 'n_got' && /(id|notice|login|claim|unique|number|ref)/.test(k) && !/(pin|code|pass)/.test(k) && typeof A[k] === 'string' && A[k].trim());
}
function captchaFor(scan, answers) {
  if (!scan) return null;
  if (scan.captcha_start) return true;
  if (scan.gate) { const v = hasNotice(answers) ? scan.captcha_notice : scan.captcha_no_notice; return v == null ? !!scan.captcha : !!v; }
  return !!scan.captcha;
}
async function scansFor(ids) {
  if (!ids.length) return {};
  const { data } = await db().from('form_scans').select('*').in('settlement_id', ids);
  const out = {}; (data || []).forEach((r) => { out[r.settlement_id] = r; }); return out;
}

// Everything the bot needs to fill one claim form.
async function jobFor(run, claim, spec) {
  const sb = db();
  const [{ data: prof }, { data: auth }] = await Promise.all([
    sb.from('profiles').select('id, email, name, phone, dob, address, state, past_addresses, pay_default, payout_handles').eq('id', claim.user_id).maybeSingle(),
    sb.from('authorizations').select('signer_name, signature_text, created_at').eq('user_id', claim.user_id).eq('settlement_id', claim.settlement_id).order('created_at', { ascending: false }).limit(1).maybeSingle()
  ]);
  const p = prof || {};
  return {
    run_id: run.id, mode: run.mode, profile: run.profile, title: titleOf(claim.settlement_id),
    claim: { id: claim.id, settlement_id: claim.settlement_id, answers: claim.answers || {}, payout_method: claim.payout_method || p.pay_default || '' },
    spec: { form_url: spec.form_url, admin: spec.admin, form_map: spec.form_map || [], notice: spec.notice || null, needs: spec.needs || [], qualify: spec.qualify || [] },
    member: { name: p.name || '', email: p.email || '', phone: p.phone || '', dob: p.dob || '', address: p.address || '', state: p.state || '', past_addresses: p.past_addresses || [], pay_default: p.pay_default || '', payout_handles: p.payout_handles || {} },
    signed: !!auth, signature: auth ? (auth.signer_name || p.name || '') : ''
  };
}

const bot = {
  // Hands out the next claim, or { job: null }.
  async botNext(b) {
    const sb = db(), set = await botSettings(), worker = String(b.worker || 'bot').slice(0, 60);
    if (set.mode === 'off') return { job: null, mode: 'off' };
    // Runs stuck for 20 minutes count as failed so the claim goes back to staff.
    await sb.from('bot_runs').update({ status: 'failed', error: 'Timed out', finished_at: new Date().toISOString() }).eq('status', 'running').lt('started_at', new Date(Date.now() - 20 * 60000).toISOString());
    // 1. Runs staff approved after a practice fill: submit them for real.
    const { data: ap } = await sb.from('bot_runs').select('*').eq('status', 'approved').order('started_at', { ascending: true }).limit(1);
    if (ap && ap[0]) {
      const old = ap[0];
      const { data: claim } = await sb.from('claims').select('*').eq('id', old.claim_id).maybeSingle();
      await sb.from('bot_runs').update({ status: 'cancelled', finished_at: new Date().toISOString() }).eq('id', old.id).eq('status', 'approved');
      if (claim && claim.status === 'requested') {
        const spec = (await getSpecs([claim.settlement_id]))[claim.settlement_id];
        const { data: run } = await sb.from('bot_runs').insert({ claim_id: claim.id, settlement_id: claim.settlement_id, profile: old.profile, mode: 'submit', status: 'running', worker, approved_by: old.approved_by }).select().single();
        return { job: await jobFor(run, claim, spec) };
      }
    }
    // 2. New filing requests the bot can handle.
    const { data: claims } = await sb.from('claims').select('*').eq('status', 'requested').order('requested_at', { ascending: true, nullsFirst: false }).limit(60);
    if (!claims || !claims.length) return { job: null, mode: set.mode };
    const specs = await getSpecs([...new Set(claims.map((c) => c.settlement_id))]);
    const scans = await scansFor(Object.keys(specs));
    const { data: tried } = await sb.from('bot_runs').select('claim_id').in('claim_id', claims.map((c) => c.id)).neq('status', 'cancelled');
    const done = new Set((tried || []).map((r) => r.claim_id));
    for (const c of claims) {
      const sp = specs[c.settlement_id];
      if (!sp || sp.type !== 'we' || !sp.form_url || isPdf(sp.form_url) || done.has(c.id)) continue;
      if (sp.bot === false) continue;
      if (captchaFor(scans[c.settlement_id], c.answers) !== false) continue; // unscanned or CAPTCHA: VA files it
      const prof = profileFor(sp);
      if (!set.profiles.includes(prof)) continue;
      const { data: run, error } = await sb.from('bot_runs').insert({ claim_id: c.id, settlement_id: c.settlement_id, profile: prof, mode: set.mode, status: 'running', worker }).select().single();
      if (error) throw error;
      return { job: await jobFor(run, c, sp) };
    }
    return { job: null, mode: set.mode };
  },

  // Every web claim form to check for a CAPTCHA (scanned in the last `days` days are skipped unless all).
  async botScanList(b) {
    const { BASE } = require('./_spec');
    const days = Math.max(0, parseInt(b.days, 10) || 7);
    const { data: rows } = await db().from('settlement_filing').select('id');
    const ids = [...new Set(Object.keys(BASE).concat((rows || []).map((r) => r.id)))];
    const specs = await getSpecs(ids), scans = await scansFor(ids), cut = Date.now() - days * 864e5;
    const out = [];
    Object.values(specs).forEach((sp) => {
      if (!sp || sp.type !== 'we' || !sp.form_url || isPdf(sp.form_url) || !/^https?:/i.test(sp.form_url)) return;
      const sc = scans[sp.id];
      if (!b.all && sc && new Date(sc.scanned_at).getTime() > cut && sc.form_url === sp.form_url) return;
      if (b.only && b.only !== sp.id) return;
      out.push({ id: sp.id, form_url: sp.form_url, admin: sp.admin || '', title: titleOf(sp.id) });
    });
    return { forms: out };
  },
  async botScanSave(b) {
    const r = b.result || {}, id = String(r.id || '').slice(0, 80);
    if (!id) return { error: 'id needed' };
    const bool = (v) => (v == null ? null : !!v);
    const row = { settlement_id: id, form_url: String(r.form_url || '').slice(0, 600), scanned_at: new Date().toISOString(), worker: String(b.worker || 'bot').slice(0, 60),
      gate: !!r.gate, captcha_start: bool(r.captcha_start), captcha_notice: bool(r.captcha_notice), captcha_no_notice: bool(r.captcha_no_notice),
      captcha: !!(r.captcha_start || r.captcha_notice || r.captcha_no_notice), kinds: Array.isArray(r.kinds) ? r.kinds.slice(0, 10).map(String) : [],
      note: r.note ? String(r.note).slice(0, 500) : null, error: r.error ? String(r.error).slice(0, 500) : null };
    const { error } = await db().from('form_scans').upsert(row, { onConflict: 'settlement_id' });
    if (error) throw error;
    return { ok: true };
  },

  // A private upload link for one screenshot.
  async botShot(b) {
    const run = parseInt(b.run_id, 10), n = Math.max(0, Math.min(99, parseInt(b.n, 10) || 0));
    if (!run) return { error: 'run_id needed' };
    const path = run + '/' + String(n).padStart(2, '0') + '-' + Date.now() + '.png';
    const { data, error } = await db().storage.from('bot-shots').createSignedUploadUrl(path);
    if (error) throw error;
    return { path, url: data.signedUrl, token: data.token };
  },

  // The bot reports how it went. A real submission with a confirmation number marks the claim filed and emails the member.
  async botDone(b, setStatus) {
    const sb = db(), id = parseInt(b.run_id, 10), status = String(b.status || '');
    if (!id || !['filled', 'submitted', 'needs_va', 'failed'].includes(status)) return { error: 'Bad result' };
    const { data: run } = await sb.from('bot_runs').select('*').eq('id', id).maybeSingle();
    if (!run || run.status !== 'running') return { error: 'Run is not running' };
    const final = status === 'submitted' && run.mode !== 'submit' ? 'filled' : status;
    const patch = { status: final, confirmation: b.confirmation ? String(b.confirmation).slice(0, 120) : null, error: b.error ? String(b.error).slice(0, 1000) : null,
      log: Array.isArray(b.log) ? b.log.slice(0, 300) : [], shots: Array.isArray(b.shots) ? b.shots.filter((s) => typeof s === 'string').slice(0, 60) : [], finished_at: new Date().toISOString() };
    await sb.from('bot_runs').update(patch).eq('id', id);
    let claim = null, email = null;
    if (final === 'submitted') {
      const r = await setStatus({ claim_id: run.claim_id, status: 'filed', claim_ref: patch.confirmation || '', note: 'Filed by the filing bot (run ' + id + ')', title: titleOf(run.settlement_id) }, { email: 'filing bot' });
      claim = r.claim; email = r.email;
    }
    return { ok: true, status: final, claim, email };
  },

  // Staff: every bot run for a claim, screenshots as 10 minute links.
  async botRuns(b) {
    const sb = db(), id = parseInt(b.claim_id, 10);
    const { data: runs } = await sb.from('bot_runs').select('*').eq('claim_id', id).order('started_at', { ascending: false }).limit(10);
    const out = [];
    for (const r of runs || []) {
      let shots = [];
      if (r.shots && r.shots.length) {
        const { data } = await sb.storage.from('bot-shots').createSignedUrls(r.shots, 600);
        shots = (data || []).map((x) => x.signedUrl).filter(Boolean);
      }
      out.push(Object.assign({}, r, { shotUrls: shots }));
    }
    return { runs: out };
  },
  async botApprove(b, user) {
    const id = parseInt(b.run_id, 10);
    const { data, error } = await db().from('bot_runs').update({ status: 'approved', approved_by: user.email || 'staff' }).eq('id', id).eq('status', 'filled').select().maybeSingle();
    if (error) throw error;
    return data ? { ok: true } : { error: 'Only a practice fill can be approved' };
  },
  async botToStaff(b, user) {
    const id = parseInt(b.run_id, 10);
    await db().from('bot_runs').update({ status: 'needs_va', error: 'Sent to staff by ' + (user.email || 'staff'), finished_at: new Date().toISOString() }).eq('id', id).in('status', ['filled', 'approved', 'running']);
    return { ok: true };
  },
  async botRetry(b) {
    const id = parseInt(b.run_id, 10);
    await db().from('bot_runs').update({ status: 'cancelled' }).eq('id', id).in('status', ['needs_va', 'failed']);
    return { ok: true };
  },
  // Overview numbers for the Filing queue.
  async botStats() {
    const sb = db(), since = new Date(Date.now() - 7 * 864e5).toISOString();
    const { data } = await sb.from('bot_runs').select('status, profile').gte('started_at', since).limit(2000);
    const by = {}; (data || []).forEach((r) => { by[r.status] = (by[r.status] || 0) + 1; });
    return { stats: by, settings: await botSettings() };
  }
};

module.exports = { bot, botKeyOk, profileFor, botSettings, PROFILES, captchaFor, scansFor };
