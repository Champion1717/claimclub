// Offer G plan tiers (Nov 21 2026): Standard (free), Fast ($15 a month), Priority ($30 a month).
// What each tier can file and use. Older plans (trials, monthly, yearly, fee) keep full access ('all').
//   std  : only the claims our bot can file (scanned claim form with no CAPTCHA), nationwide, open. Filed within 30 days.
//   fast : every nationwide claim, no local ones. Filed within 3 days. Payout emails.
//   pri  : everything, incl. local claims, Claim refunds and Subscription Manager. Filed within 24 hours.
const { db } = require('./_db');
const TIERS = {
  std: { name: 'Standard', amount: 0, hours: 24 * 30 },
  fast: { name: 'Fast', amount: 1500, hours: 24 * 3 },
  pri: { name: 'Priority', amount: 3000, hours: 24 },
};
const PLAN_TIER = { std: 'std', fast: 'fast', pri: 'pri' };
const ACTIVE = ['active', 'cancelling', 'test'];

// Tier for a membership row: 'std' | 'fast' | 'pri' | 'all' (any other membership plan) | 'fee' (filing fee only) | null (none).
function tierOf(m) {
  if (!m || !ACTIVE.includes(m.status)) return null;
  if (m.kind === 'member' && PLAN_TIER[m.plan]) return PLAN_TIER[m.plan];
  return m.kind === 'member' ? 'all' : 'fee';
}
async function tierFor(uid) {
  const { data } = await db().from('memberships').select('kind, plan, status').eq('user_id', uid).maybeSingle();
  return tierOf(data);
}

let CAT = null;
function catalog() {
  if (!CAT) { CAT = {}; try { require('./_catalog.json').forEach((c) => { CAT[c.id] = c; }); } catch (e) {} }
  return CAT;
}
const isLocal = (id) => !!(catalog()[id] && catalog()[id].st);

// Standard's claims: open, nationwide, filed by us, and the bot's last scan of the claim form found no CAPTCHA.
let STD = null, STD_AT = 0;
async function standardIds() {
  if (STD && Date.now() - STD_AT < 10 * 60e3) return STD;
  const sb = db();
  const [{ data: scans }, { data: extra }] = await Promise.all([
    sb.from('form_scans').select('settlement_id, captcha, captcha_start'),
    sb.from('catalog_extra').select('id, hidden'),
  ]);
  const hidden = new Set((extra || []).filter((x) => x.hidden).map((x) => x.id));
  let specs = {}; try { require('./_specs.json').forEach((s) => { specs[s.id] = s; }); } catch (e) {}
  const cat = catalog();
  STD = (scans || []).filter((r) => !r.captcha && !r.captcha_start).map((r) => r.settlement_id)
    .filter((id) => cat[id] && !cat[id].st && !hidden.has(id) && (!specs[id] || specs[id].type === 'we')).sort();
  STD_AT = Date.now();
  return STD;
}
// Can this tier file this settlement? Returns '' when yes, else the reason to show.
async function fileBlock(tier, id) {
  if (tier === 'std' && !(await standardIds()).includes(id)) return 'Standard covers our auto-filed claims only. Upgrade to Fast to file this one.';
  if ((tier === 'std' || tier === 'fast') && isLocal(id)) return 'Local claims are part of Priority.';
  return '';
}
const canMoneyBack = (tier) => tier === 'pri' || tier === 'all';
const paidEmails = (tier) => tier !== 'std';
module.exports = { TIERS, PLAN_TIER, tierOf, tierFor, standardIds, fileBlock, canMoneyBack, paidEmails, isLocal };
