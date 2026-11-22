// Offer test (Nov 21 2026). Shared by checkout, webhook, membership, config, track and admin.
// Each offer is switched on or off in /admin > Settings > Offer test (app_settings.offer_test = { a, b, c, d }).
// New visitors get one of the offers that are on, at random, kept in the cc_offer cookie.
//   a: old flow A, the choice page ($7.99 first month membership or a $49.99 filing fee)
//   b: $2 today for a 7-day trial, then $49.99 a year
//   c: free 7-day trial, then $49.99 a year
//   d: free 3-day trial, then $4.99 a week
//   e: free 3-day trial, then $49 a year (Nov 21 2026)
//   f: free 3-day trial, then $19.99 a month (Nov 21 2026)
//   h: free 3-day trial, then $49.99 a year (Nov 22 2026)
// Flow C (the /check page, Nov 22 2026), its own A/B/C test:
//   j: Flow C A, free 3-day trial, then $49.99 a year (plan 1y)
//   k: Flow C B, free 3-day trial, then $19.99 a month (plan 1mt)
//   i: Flow C C, plans $19.99 a month (c1), $44.97 every 3 months (c3), $59.94 every 6 months (c6), charged today
const OFFERS = {
  a: { name: 'Choice page ($7.99 first month or $49.99 fee)' },
  b: { name: '$2 for 7 days, then $49.99 a year', plan: '1y', trialDays: 7, first: 200, amount: 4999, interval: 'year' },
  c: { name: 'Free for 7 days, then $49.99 a year', plan: '1y', trialDays: 7, first: 0, amount: 4999, interval: 'year' },
  d: { name: 'Free for 3 days, then $4.99 a week', plan: '1w', trialDays: 3, first: 0, amount: 499, interval: 'week' },
  e: { name: 'Free for 3 days, then $49 a year', plan: '1y', trialDays: 3, first: 0, amount: 4900, interval: 'year' },
  f: { name: 'Free for 3 days, then $19.99 a month', plan: '1mt', trialDays: 3, first: 0, amount: 1999, interval: 'month' },
  h: { name: 'Free for 3 days, then $49.99 a year', plan: '1y', trialDays: 3, first: 0, amount: 4999, interval: 'year' },
  // Offer G (Nov 21 2026): three plans on one page (T3 design): Standard free, Fast $15/mo, Priority $30/mo, charged today, no trial.
  g: { name: 'Plans: Standard free, Fast $15/mo, Priority $30/mo', plans: ['std', 'fast', 'pri'] },
  i: { name: 'Flow C · C: $19.99/mo, $44.97 per 3 months or $59.94 per 6 months', plans: ['c1', 'c3', 'c6'], flowC: 'C' },
  j: { name: 'Flow C · A: free 3 days, then $49.99 a year', plan: '1y', trialDays: 3, first: 0, amount: 4999, interval: 'year', flowC: 'A' },
  k: { name: 'Flow C · B: free 3 days, then $19.99 a month', plan: '1mt', trialDays: 3, first: 0, amount: 1999, interval: 'month', flowC: 'B' },
};
const DEFAULT_ON = { a: false, b: false, c: false, d: false, e: false, f: true, g: false, h: false, i: false, j: false, k: false };
const FLOWS = Object.keys(OFFERS);
const isFlow = (f) => FLOWS.includes(f);
// Trial plans: 1y (offers b and c) and 1w (offer d).
const TRIAL_DAYS = { '1y': 7, '1w': 3, '1mt': 3 };
// The offer's own trial length wins (offer e is a 3-day trial on the yearly plan).
const trialDaysFor = (plan, flow) => (TRIAL_DAYS[plan] ? ((OFFERS[flow] && OFFERS[flow].plan === plan && OFFERS[flow].trialDays) || TRIAL_DAYS[plan]) : 0);
const trialEndFor = (plan, from, flow) => { const d = trialDaysFor(plan, flow); return d ? new Date(new Date(from || Date.now()).getTime() + d * 864e5).toISOString() : null; };
// What the plan renews at for this offer, in dollars (for Meta predicted value and emails).
const renewFor = (plan, flow) => ((OFFERS[flow] && OFFERS[flow].plan === plan && OFFERS[flow].amount) || ({ '1y': 4999, '1w': 499, '1mt': 1999, c1: 1999, c3: 4497, c6: 5994 })[plan] || 0) / 100;
// Which flow a purchase belongs to when the browser did not say (old sessions).
function flowFor(flow, plan) {
  if (isFlow(flow)) return flow;
  if (plan === '1w') return 'd';
  if (plan === '1mt') return 'f';
  if (['std', 'fast', 'pri'].includes(plan)) return 'g';
  if (['c1', 'c3', 'c6'].includes(plan)) return 'i';
  if (plan === '1y') return 'b';
  return 'a';
}
function offersOn(v) {
  const o = Object.assign({}, DEFAULT_ON, v && typeof v === 'object' ? v : {});
  const on = FLOWS.filter((k) => o[k] === true && !OFFERS[k].demoOnly); // demo-only offers (i) never enter the rotation
  return on.length ? on : ['f'];
}
// Device type from the browser's user agent: iphone, android, tablet, mac, windows, other.
function deviceType(ua) {
  ua = String(ua || '');
  if (/iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
  if (/iPhone|iPod/i.test(ua)) return 'iphone';
  if (/Android/i.test(ua)) return 'android';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/Windows/i.test(ua)) return 'windows';
  return 'other';
}
const SOURCES = ['meta', 'google_ads', 'organic', 'other'];
module.exports = { OFFERS, DEFAULT_ON, FLOWS, isFlow, TRIAL_DAYS, trialDaysFor, trialEndFor, renewFor, flowFor, offersOn, deviceType, SOURCES };
