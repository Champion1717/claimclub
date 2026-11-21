// Offer test (Nov 21 2026). Shared by checkout, webhook, membership, config, track and admin.
// Each offer is switched on or off in /admin > Settings > Offer test (app_settings.offer_test = { a, b, c, d }).
// New visitors get one of the offers that are on, at random, kept in the cc_offer cookie.
//   a: old flow A, the choice page ($7.99 first month membership or a $49.99 filing fee)
//   b: $2 today for a 7-day trial, then $49.99 a year
//   c: free 7-day trial, then $49.99 a year
//   d: free 3-day trial, then $4.99 a week
const OFFERS = {
  a: { name: 'Choice page ($7.99 first month or $49.99 fee)' },
  b: { name: '$2 for 7 days, then $49.99 a year', plan: '1y', trialDays: 7, first: 200, amount: 4999, interval: 'year' },
  c: { name: 'Free for 7 days, then $49.99 a year', plan: '1y', trialDays: 7, first: 0, amount: 4999, interval: 'year' },
  d: { name: 'Free for 3 days, then $4.99 a week', plan: '1w', trialDays: 3, first: 0, amount: 499, interval: 'week' },
};
const DEFAULT_ON = { a: false, b: true, c: true, d: true };
const FLOWS = Object.keys(OFFERS);
const isFlow = (f) => FLOWS.includes(f);
// Trial plans: 1y (offers b and c) and 1w (offer d).
const TRIAL_DAYS = { '1y': 7, '1w': 3 };
const trialEndFor = (plan, from) => (TRIAL_DAYS[plan] ? new Date(new Date(from || Date.now()).getTime() + TRIAL_DAYS[plan] * 864e5).toISOString() : null);
// Which flow a purchase belongs to when the browser did not say (old sessions).
function flowFor(flow, plan) {
  if (isFlow(flow)) return flow;
  if (plan === '1w') return 'd';
  if (plan === '1y') return 'b';
  return 'a';
}
function offersOn(v) {
  const o = Object.assign({}, DEFAULT_ON, v && typeof v === 'object' ? v : {});
  const on = FLOWS.filter((k) => o[k] === true);
  return on.length ? on : ['b'];
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
module.exports = { OFFERS, DEFAULT_ON, FLOWS, isFlow, TRIAL_DAYS, trialEndFor, flowFor, offersOn, deviceType, SOURCES };
