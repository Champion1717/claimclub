// Member emails through Resend (https://resend.com). Needs RESEND_API_KEY in Vercel.
// Sender domain claimclub.io is the one verified in Resend (Nov 19 2026: mail.claimclub.io is not, which broke every email). Change FROM with the EMAIL_FROM env var.
const { db } = require('./_db');

const FROM = () => process.env.EMAIL_FROM || 'Claimclub <updates@claimclub.io>';
const SITE = 'https://claimclub.io';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// One template per claim status a member hears about.
const COPY = {
  requested: (t) => ({ subject: 'We\'re filing your ' + t.title + ' claim', head: 'Your claim is in our filing queue', body: 'We\'re preparing your ' + t.title + ' claim with the details you saved. We\'ll email you the claim ID as soon as it\'s submitted.' }),
  filed: (t) => ({ subject: 'Your ' + t.title + ' claim was filed', head: 'Filed with the settlement administrator', body: 'We submitted your ' + t.title + ' claim' + (t.ref ? '. Your claim ID is <b>' + esc(t.ref) + '</b>. Keep it for your records.' : '.') + ' Administrators review claims after the deadline, then pay after the court gives final approval.' }),
  needs_info: (t) => ({ subject: 'Action needed on your ' + t.title + ' claim', head: 'We need one more thing', body: 'Before we can file your ' + t.title + ' claim, we need a little more from you' + (t.note ? ': ' + esc(t.note) : '.') + ' Open your dashboard to finish it.' }),
  review: (t) => ({ subject: 'Your ' + t.title + ' claim is being reviewed', head: 'In review', body: 'The administrator is reviewing claims for ' + t.title + '. Nothing to do on your end. We\'ll let you know when it\'s approved.' }),
  approved: (t) => ({ subject: 'Good news: your ' + t.title + ' claim was approved', head: 'Approved', body: 'Your ' + t.title + ' claim was approved. Payouts usually go out after the court\'s final approval. We\'ll tell you the moment it\'s paid.' }),
  paid: (t) => ({ subject: 'You got paid' + (t.amount ? ' ' + t.amount : '') + ' from ' + t.title, head: 'Payout sent', body: 'The ' + t.title + ' settlement sent your payout' + (t.amount ? ' of <b>' + esc(t.amount) + '</b>' : '') + (t.method ? ' by ' + esc(t.method) : '') + '. Claimclub never takes a cut.' }),
  denied: (t) => ({ subject: 'Update on your ' + t.title + ' claim', head: 'Claim not approved', body: 'The administrator did not approve your ' + t.title + ' claim' + (t.note ? ': ' + esc(t.note) : '.') + ' Reply to this email if you have questions.' })
};

function html(c) {
  return '<!doctype html><html><body style="margin:0;background:#F3F6F4;font-family:Arial,Helvetica,sans-serif;color:#0A0F0D">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F6F4;padding:28px 12px"><tr><td align="center">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:18px;overflow:hidden">'
    + '<tr><td style="background:#0F3B2E;padding:20px 28px;color:#FFFFFF;font-size:20px;font-weight:bold">claim<span style="font-weight:normal">club</span><span style="color:#3DDC97;font-size:14px">.io</span></td></tr>'
    + '<tr><td style="padding:28px">'
    + '<div style="font-size:22px;font-weight:bold;line-height:1.25;margin:0 0 12px">' + esc(c.head) + '</div>'
    + '<div style="font-size:15px;line-height:1.6;color:#2B3530">' + c.body + '</div>'
    + '<div style="margin:24px 0 4px"><a href="' + SITE + '/login" style="display:inline-block;background:#3DDC97;color:#0A0F0D;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 22px;border-radius:999px">Open your dashboard</a></div>'
    + '</td></tr>'
    + '<tr><td style="padding:16px 28px 24px;font-size:12px;line-height:1.5;color:#8A968F;border-top:1px solid #E8EEEA">Claimclub is not a law firm. Payouts come straight from each settlement administrator. You get these emails because you asked us to file claims for you. Turn them off in Settings on your dashboard.</td></tr>'
    + '</table></td></tr></table></body></html>';
}

// Sends one status email and logs it. Never throws: a failed email must not fail the status change.
async function sendClaimEmail({ to, userId, status, title, ref, note, amount, method }) {
  const make = COPY[status];
  if (!make || !to) return { skipped: true };
  const c = make({ title: title || 'settlement', ref, note, amount, method });
  const log = { user_id: userId || null, to_email: to, kind: 'claim_' + status, subject: c.subject };
  if (!process.env.RESEND_API_KEY) { log.error = 'RESEND_API_KEY not set'; try { await db().from('email_log').insert(log); } catch (e) {} return { skipped: true, reason: log.error }; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM(), to: [to], subject: c.subject, html: html(c), reply_to: process.env.EMAIL_REPLY_TO || 'support@mail.claimclub.io' })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || ('Resend ' + r.status));
    log.provider_id = j.id || null;
    try { await db().from('email_log').insert(log); } catch (e) {}
    return { sent: true, id: j.id };
  } catch (e) {
    log.error = String(e.message || e).slice(0, 300);
    try { await db().from('email_log').insert(log); } catch (e2) {}
    return { sent: false, error: log.error };
  }
}

// Any other member email (billing and the like). c = { subject, head, body (HTML), cta, ctaUrl }. Never throws.
async function sendNotice({ to, userId, kind, c }) {
  const log = { user_id: userId || null, to_email: to, kind, subject: c.subject };
  if (!to) return { skipped: true };
  if (!process.env.RESEND_API_KEY) { log.error = 'RESEND_API_KEY not set'; try { await db().from('email_log').insert(log); } catch (e) {} return { skipped: true, reason: 'RESEND_API_KEY not set' }; }
  try {
    const page = html(c).replace(SITE + '/login', c.ctaUrl || SITE + '/login').replace(/>Open your dashboard</, '>' + esc(c.cta || 'Open your dashboard') + '<');
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM(), to: [to], reply_to: process.env.EMAIL_REPLY_TO || 'support@mail.claimclub.io', subject: c.subject, html: page }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || 'Resend error ' + r.status);
    log.provider_id = j.id; try { await db().from('email_log').insert(log); } catch (e) {}
    return { sent: true, id: j.id };
  } catch (e) { log.error = String(e.message || e).slice(0, 300); try { await db().from('email_log').insert(log); } catch (x) {} return { sent: false, error: log.error }; }
}

module.exports = { sendClaimEmail, sendNotice, COPY, html };
