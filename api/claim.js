// POST /api/claim (signed-in members). Filing from the member app, Nov 15 2026.
// Actions:
//   state   -> which settlements this member has signed, and their uploaded proof files
//   file    { settlement_id, title, co, cat, answers, payout_method, signature: { name, agree }, lang }
//           Saves the claim details, records a signed authorization (unless one is already on file, e.g. from the
//           claim flow), puts the claim in the filing queue and emails "We're filing your claim".
//   attach  { settlement_id, path, name, size, mime } -> records a proof file the member uploaded to their folder
//   detach  { id } -> removes a proof file while the claim is not filed yet
//   reply   { settlement_id, note } -> answers "Action needed": saves the reply and sends the claim back to the queue
//   start   { settlement_id } -> auto pay and you-file claims (type from settlement_filing): status 'auto' or 'self', no filing by us
//   progress { settlement_id, progress } -> saves checklist ticks, the guide step and the confirmation number
//   selfDone { settlement_id, conf } -> member filed it themselves: back to staff as 'requested' to verify and mark filed
//   gotPaid { settlement_id, amount } -> member says the payout arrived (any status from auto onward)
const crypto = require('crypto');
const { db, userFrom, readJson, send } = require('./_db');
const { sendClaimEmail } = require('./_email');
const { ipOf } = require('./_limit');
const { getSpec } = require('./_spec');

const BUCKET = 'claim-files';
const VERSION = '2026-11-14';
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const OPEN = ['ready', 'needs_info', 'removed'];   // a member can (re)file from these
const UNFILED = ['ready', 'requested', 'needs_info', 'self'];
const PAYABLE = ['auto', 'self', 'requested', 'filed', 'review', 'approved'];

function attest(co, cat, es) {
  if (cat === 'arb') return es
    ? 'Revisé la información de arriba y es verdadera y correcta. Autorizo a Claimclub a enviarla a un bufete asociado para que evalúe un posible reclamo de arbitraje individual contra ' + co + ' en mi nombre. Entiendo que no se presenta nada hasta que firme un acuerdo aparte con el bufete, que indicará cualquier honorario. Claimclub no recibe ninguna parte de lo que se otorgue.'
    : 'I have reviewed the information above and it is true and correct. I authorize Claimclub to send it to a partner law firm so the firm can review a possible individual arbitration claim against ' + co + ' for me. I understand no claim is filed until I sign a separate agreement with the firm, which will disclose any fees. Claimclub takes no part of any award.';
  return es
    ? 'Revisé las respuestas de arriba y son verdaderas y correctas. Autorizo a Claimclub a presentar este reclamo al administrador del acuerdo ' + co + ' a mi nombre, usando mi firma electrónica de abajo, y a recibir actualizaciones, según el Acuerdo de Autorización de Presentación de Reclamos. Cualquier pago se me enviará directamente. Claimclub no recibe ninguna parte. Puedo revocar esta autorización antes de que se presente el reclamo.'
    : 'I have reviewed the answers above and they are true and correct. I authorize Claimclub to submit this claim to the ' + co + ' settlement administrator under my name, using my electronic signature below, and to receive updates about it, as described in the Claim Filing Authorization Agreement. Any payment will be sent directly to me. Claimclub takes no part of it. I can revoke this authorization at any time before the claim is submitted.';
}
const perjury = (es) => es
  ? 'Declaro bajo pena de perjurio, conforme a las leyes de los Estados Unidos, que la información de este formulario es verdadera y correcta según mi leal saber, y que soy miembro del grupo del acuerdo descrito en el aviso.'
  : 'I declare under penalty of perjury under the laws of the United States that the information in this claim form is true and correct to the best of my knowledge, and that I am a member of the Settlement Class described in the notice.';
const consent = (es) => es ? 'Acepto firmar electrónicamente y he leído el Acuerdo de Autorización de Presentación de Reclamos' : 'I agree to sign electronically and have read the Claim Filing Authorization Agreement';

async function signedIds(uid, email) {
  const { data } = await db().from('authorizations').select('settlement_id, created_at').or('user_id.eq.' + uid + (email ? ',email.ilike.' + email.replace(/[,()]/g, '') : ''));
  const out = {}; (data || []).forEach((a) => { if (!out[a.settlement_id] || a.created_at < out[a.settlement_id]) out[a.settlement_id] = a.created_at; });
  return out;
}
function cleanAnswers(a) {
  const out = {};
  if (!a || typeof a !== 'object') return out;
  Object.keys(a).slice(0, 30).forEach((k) => {
    const v = a[k], key = clip(k, 40);
    if (Array.isArray(v)) out[key] = v.slice(0, 20).map((x) => clip(x, 200));
    else if (v != null && typeof v !== 'object') out[key] = clip(v, 1000);
  });
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  let user; try { user = await userFrom(req); } catch (e) { return send(res, 500, { error: e.message }); }
  if (!user) return send(res, 401, { error: 'Sign in first' });
  const b = await readJson(req), sb = db(), uid = user.id, email = String(user.email || '').toLowerCase();
  try {
    if (b.action === 'state') {
      const [signed, { data: files }] = await Promise.all([signedIds(uid, email), sb.from('claim_files').select('id, settlement_id, name, size, mime, created_at').eq('user_id', uid).order('created_at')]);
      return send(res, 200, { signed, files: files || [] });
    }

    const sid = clip(b.settlement_id, 80);
    if (!sid) return send(res, 400, { error: 'Missing settlement' });
    const { data: cur } = await sb.from('claims').select('*').eq('user_id', uid).eq('settlement_id', sid).maybeSingle();

    if (b.action === 'file') {
      if (cur && !OPEN.includes(cur.status)) return send(res, 200, { claim: cur, already: true });
      const signed = await signedIds(uid, email);
      let signedNow = false;
      if (!signed[sid]) {
        const sig = b.signature || {}, name = clip(sig.name, 200).trim().replace(/\s+/g, ' ');
        if (!sig.agree || name.length < 3 || !/\s/.test(name)) return send(res, 409, { error: 'Type your full name to sign', needSign: true });
        const { data: prof } = await sb.from('profiles').select('name, email, phone, dob, address, state').eq('id', uid).maybeSingle();
        const es = b.lang === 'es', co = clip(b.co || b.title || sid, 120), now = new Date().toISOString(), ip = ipOf(req);
        const row = {
          email, user_id: uid, settlement_id: sid, settlement_title: clip(b.title || co, 300), signer_name: name, signature_text: name, method: 'single',
          details: Object.assign({ email }, prof || {}), answers: Object.entries(cleanAnswers(b.answers)).map(([q, a]) => ({ q, a })),
          statements: { attestation: attest(co, b.cat, es), perjury: b.cat === 'arb' ? '' : perjury(es), consent: consent(es), agreement_url: 'https://claimclub.io/authorization' },
          agreement_version: VERSION, lang: es ? 'es' : 'en', client_signed_at: b.signed_at && !isNaN(Date.parse(b.signed_at)) ? new Date(b.signed_at).toISOString() : null,
          ip, user_agent: clip(req.headers['user-agent'], 400), page: '/dashboard'
        };
        row.record_hash = crypto.createHash('sha256').update(JSON.stringify([row.email, row.settlement_id, row.signer_name, row.signature_text, row.details, row.answers, row.statements, row.agreement_version, now, ip])).digest('hex');
        const { error } = await sb.from('authorizations').insert(row);
        if (error) throw error;
        signedNow = true;
      }
      const patch = { user_id: uid, settlement_id: sid, status: 'requested', requested_at: new Date().toISOString(),
        answers: Object.assign({}, (cur && cur.answers) || {}, cleanAnswers(b.answers)), payout_method: b.payout_method ? clip(b.payout_method, 40) : (cur && cur.payout_method) || null,
        source: (cur && cur.source) || 'added' };
      const { data: claim, error } = await sb.from('claims').upsert(patch, { onConflict: 'user_id,settlement_id' }).select().maybeSingle();
      if (error) throw error;
      let mail = { skipped: true };
      try { mail = await sendClaimEmail({ to: email, userId: uid, status: 'requested', title: clip(b.title || sid, 200) }); } catch (e) {}
      return send(res, 200, { claim, signedNow, email: !!mail.sent });
    }

    if (b.action === 'attach') {
      const path = clip(b.path, 400);
      if (!path.startsWith(uid + '/' + sid + '/')) return send(res, 400, { error: 'Bad file path' });
      if (cur && !UNFILED.includes(cur.status)) return send(res, 400, { error: 'This claim is already filed' });
      const { count } = await sb.from('claim_files').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('settlement_id', sid);
      if ((count || 0) >= 10) return send(res, 400, { error: 'You can add up to 10 files to a claim' });
      const dir = path.slice(0, path.lastIndexOf('/')), base = path.slice(path.lastIndexOf('/') + 1);
      const { data: found } = await sb.storage.from(BUCKET).list(dir, { search: base });
      if (!(found || []).some((f) => f.name === base)) return send(res, 400, { error: 'Upload not found. Try again.' });
      const { data: file, error } = await sb.from('claim_files').insert({ user_id: uid, settlement_id: sid, path, name: clip(b.name || base, 200), size: parseInt(b.size, 10) || null, mime: clip(b.mime, 80) || null }).select('id, settlement_id, name, size, mime, created_at').maybeSingle();
      if (error) throw error;
      return send(res, 200, { file });
    }

    if (b.action === 'detach') {
      const { data: f } = await sb.from('claim_files').select('*').eq('user_id', uid).eq('id', parseInt(b.id, 10) || 0).maybeSingle();
      if (!f) return send(res, 404, { error: 'File not found' });
      const { data: c2 } = await sb.from('claims').select('status').eq('user_id', uid).eq('settlement_id', f.settlement_id).maybeSingle();
      if (c2 && !UNFILED.includes(c2.status)) return send(res, 400, { error: 'This claim is already filed' });
      await sb.storage.from(BUCKET).remove([f.path]);
      await sb.from('claim_files').delete().eq('id', f.id);
      return send(res, 200, { ok: true });
    }

    if (b.action === 'start') {
      const spec = await getSpec(sid);
      const type = spec && spec.type;
      if (type !== 'auto' && type !== 'self') return send(res, 400, { error: 'This claim is filed by our team. Use File.' });
      if (cur && !OPEN.includes(cur.status) && cur.status !== 'ready') return send(res, 200, { claim: cur, already: true });
      const status = type === 'auto' ? 'auto' : 'self';
      const { data: claim, error } = await sb.from('claims').upsert({ user_id: uid, settlement_id: sid, status, requested_at: new Date().toISOString(), source: (cur && cur.source) || 'added',
        progress: (cur && cur.progress) || {} }, { onConflict: 'user_id,settlement_id' }).select().maybeSingle();
      if (error) throw error;
      return send(res, 200, { claim });
    }

    if (b.action === 'progress') {
      if (!cur) return send(res, 404, { error: 'Claim not found' });
      const p = b.progress && typeof b.progress === 'object' ? b.progress : {}, out = Object.assign({}, cur.progress || {});
      if (p.checks && typeof p.checks === 'object') { out.checks = {}; Object.keys(p.checks).slice(0, 20).forEach((k) => { out.checks[clip(k, 10)] = !!p.checks[k]; }); }
      if (p.step != null) out.step = Math.max(0, Math.min(60, parseInt(p.step, 10) || 0));
      if (p.conf != null) out.conf = clip(p.conf, 120);
      const { data: claim, error } = await sb.from('claims').update({ progress: out }).eq('id', cur.id).select().maybeSingle();
      if (error) throw error;
      return send(res, 200, { claim });
    }

    if (b.action === 'selfDone') {
      if (!cur || !['self', 'needs_info'].includes(cur.status)) return send(res, 400, { error: 'Start this claim first' });
      const conf = clip(b.conf, 120).trim();
      const { count } = await sb.from('claim_files').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('settlement_id', sid);
      if (!conf && !count) return send(res, 400, { error: 'Add a screenshot or type the confirmation number' });
      const progress = Object.assign({}, cur.progress || {}, { conf: conf || (cur.progress || {}).conf || '', sent: new Date().toISOString() });
      const { data: claim, error } = await sb.from('claims').update({ status: 'requested', progress, member_note: 'Filed it myself.' + (conf ? ' Confirmation: ' + conf : ' Screenshot attached.'), member_replied_at: new Date().toISOString() }).eq('id', cur.id).select().maybeSingle();
      if (error) throw error;
      const { data: ev } = await sb.from('claim_events').select('id').eq('claim_id', cur.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (ev) await sb.from('claim_events').update({ note: 'Member filed it themselves' + (conf ? ', confirmation ' + conf : ''), actor: 'member' }).eq('id', ev.id);
      return send(res, 200, { claim });
    }

    if (b.action === 'gotPaid') {
      if (!cur || !PAYABLE.includes(cur.status)) return send(res, 400, { error: 'This claim is not waiting for a payout' });
      const amt = Math.round(parseFloat(String(b.amount || '').replace(/[^0-9.]/g, '')) * 100);
      if (!isFinite(amt) || amt <= 0 || amt > 10000000) return send(res, 400, { error: 'Enter the amount you got' });
      const { data: claim, error } = await sb.from('claims').update({ status: 'paid', paid_amount_cents: amt, paid_at: new Date().toISOString(), paid_by_member: true }).eq('id', cur.id).select().maybeSingle();
      if (error) throw error;
      const { data: ev } = await sb.from('claim_events').select('id').eq('claim_id', cur.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (ev) await sb.from('claim_events').update({ note: 'Member reported the payout: $' + (amt / 100).toFixed(2), actor: 'member' }).eq('id', ev.id);
      return send(res, 200, { claim });
    }

    if (b.action === 'reply') {
      if (!cur || cur.status !== 'needs_info') return send(res, 400, { error: 'This claim is not waiting on you' });
      const note = clip(b.note, 2000).trim();
      const { count } = await sb.from('claim_files').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('settlement_id', sid);
      if (!note && !count) return send(res, 400, { error: 'Write a reply or add a file' });
      const { data: claim, error } = await sb.from('claims').update({ member_note: note || null, member_replied_at: new Date().toISOString(), status: 'requested' }).eq('id', cur.id).select().maybeSingle();
      if (error) throw error;
      const { data: ev } = await sb.from('claim_events').select('id').eq('claim_id', cur.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (ev) await sb.from('claim_events').update({ note: 'Member replied' + (note ? ': ' + note.slice(0, 300) : ''), actor: 'member' }).eq('id', ev.id);
      return send(res, 200, { claim });
    }
    return send(res, 400, { error: 'Unknown action' });
  } catch (e) {
    return send(res, 500, { error: 'Something went wrong. Try again.', detail: e.message });
  }
};
