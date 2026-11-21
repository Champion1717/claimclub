// POST /api/sign  { email, lang, page, method, records: [{ settlement_id, settlement_title, signer_name, signature_text, details, answers, statements, agreement_version, client_signed_at }] }
// Stores each signed claim authorization the moment the member signs it, with the server's own timestamp,
// the request IP and browser. This is the proof that the member asked Claimclub to file for them.
// Rows are linked to the member's account by email when they sign up (see handle_new_user in db/).
const crypto = require('crypto');
const { db, readJson, send } = require('./_db');
const { limited, ipOf } = require('./_limit');

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  const ip = ipOf(req);
  if (limited('sign:' + ip, 60, 60 * 60 * 1000)) return send(res, 429, { error: 'Too many requests' });
  const b = await readJson(req);
  const email = clip(b.email, 254).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'Missing email' });
  const recs = Array.isArray(b.records) ? b.records.slice(0, 60) : [];
  if (!recs.length) return send(res, 400, { error: 'Nothing to sign' });
  const ua = clip(req.headers['user-agent'], 400), now = new Date().toISOString();
  const rows = recs.filter((r) => r && r.settlement_id && r.signer_name).map((r) => {
    const row = {
      email, settlement_id: clip(r.settlement_id, 80), settlement_title: clip(r.settlement_title, 300),
      signer_name: clip(r.signer_name, 200), signature_text: clip(r.signature_text || r.signer_name, 200),
      method: ['bulk', 'blanket'].includes(b.method) ? b.method : 'single',
      details: r.details && typeof r.details === 'object' ? r.details : {},
      answers: Array.isArray(r.answers) ? r.answers.slice(0, 20) : [],
      statements: r.statements && typeof r.statements === 'object' ? r.statements : {},
      agreement_version: clip(r.agreement_version || '2026-11-14', 40), lang: clip(b.lang, 5),
      client_signed_at: r.client_signed_at && !isNaN(Date.parse(r.client_signed_at)) ? new Date(r.client_signed_at).toISOString() : null,
      ip, user_agent: ua, page: clip(b.page, 300)
    };
    // Tamper evidence: a hash of exactly what was signed, plus when and from where.
    row.record_hash = crypto.createHash('sha256').update(JSON.stringify([row.email, row.settlement_id, row.signer_name, row.signature_text, row.details, row.answers, row.statements, row.agreement_version, now, ip])).digest('hex');
    return row;
  });
  if (!rows.length) return send(res, 400, { error: 'Nothing to sign' });
  try {
    const { data: users } = await db().from('profiles').select('id').ilike('email', email).limit(1);
    const uid = users && users[0] && users[0].id;
    if (uid) rows.forEach((r) => { r.user_id = uid; });
    const { error } = await db().from('authorizations').insert(rows);
    if (error) throw error;
    return send(res, 200, { ok: true, saved: rows.length });
  } catch (e) {
    return send(res, 500, { error: 'Could not save the signature' });
  }
};
