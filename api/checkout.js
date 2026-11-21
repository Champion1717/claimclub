// POST /api/checkout  -> { url } or { clientSecret, publishableKey }  Creates a Stripe Checkout Session.
// With { ui: 'elements' } (Nov 15 2026) it makes a session for the in-page payment sheet in live.js
// (Apple Pay, Google Pay and the card form drawn on claimclub.io). That needs STRIPE_PUBLISHABLE_KEY
// in Vercel, from the same mode as STRIPE_SECRET_KEY; without it, or if Stripe refuses, it returns
// the hosted page URL like before.
const Stripe = require('stripe');
const { attribution } = require('./_meta');
const { OFFERS, flowFor } = require('./_offers');

// Full renewal price per billing period, and the first-period charge (75% off, rounded to the cent).
const FEE = 4999;
const PLANS = {
  '1m': { amount: 2999, first: 799, months: 1, name: 'Claimclub membership (1 month)', env: 'STRIPE_PRICE_1M' },
  '3m': { amount: 7499, first: 1899, months: 3, name: 'Claimclub membership (3 months)', env: 'STRIPE_PRICE_3M' },
  '6m': { amount: 11999, first: 2999, months: 6, name: 'Claimclub membership (6 months)', env: 'STRIPE_PRICE_6M' },
  // Offer test (Nov 21 2026). Trial plans, no intro coupon. What is charged today depends on the offer (OFFERS[flow].first):
  // offer b $2, offers c and d $0. 1y = offers b and c ($49.99 a year after a 7-day trial), 1w = offer d ($4.99 a week after a 3-day trial).
  '1y': { amount: 4999, months: 12, interval: 'year', trialDays: 7, name: 'Claimclub membership (1 year)', env: 'STRIPE_PRICE_1Y' },
  '1w': { amount: 499, interval: 'week', trialDays: 3, name: 'Claimclub membership (weekly)', env: 'STRIPE_PRICE_1W' },
};
const TRIAL_FLOWS = { '1y': ['b', 'c', 'e'], '1w': ['d'] };

// One-time coupon that takes the first invoice down to the intro price. Created on first use.
async function introCoupon(stripe, plan) {
  const p = PLANS[plan], id = 'cc_intro_v2_' + plan;
  try { return (await stripe.coupons.retrieve(id)).id; } catch (e) {
    const c = await stripe.coupons.create({ id, amount_off: p.amount - p.first, currency: 'usd', duration: 'once', name: 'Intro price, first billing period' });
    return c.id;
  }
}

// Stripe.js for the sheet is loaded from js.stripe.com/endive/, so the session is made with that API version.
const ELEMENTS_API = '2026-10-28.endive';
function publishableKey() {
  const k = process.env.STRIPE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '';
  const m = k.match(/^pk_(live|test)_/);
  if (!m) return null;
  const secretLive = /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY || '');
  if ((m[1] === 'live') !== secretLive) { console.warn('[checkout] STRIPE_PUBLISHABLE_KEY and STRIPE_SECRET_KEY are from different modes'); return null; }
  return k;
}

function readJson(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('Method not allowed'); }
  if (!process.env.STRIPE_SECRET_KEY) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'STRIPE_SECRET_KEY is not set' })); }
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const b = await readJson(req);
  const kind = b.kind === 'member' ? 'member' : 'fee';
  const plan = PLANS[b.plan] ? b.plan : '1m';
  let flow = kind === 'member' ? flowFor(b.flow, plan) : flowFor(b.flow, '');
  if (kind === 'member' && TRIAL_FLOWS[plan] && !TRIAL_FLOWS[plan].includes(flow)) flow = TRIAL_FLOWS[plan][0];
  if (kind === 'member' && !TRIAL_FLOWS[plan] && flow !== 'a') flow = 'a';
  const sid = typeof b.sid === 'string' && /^[a-z0-9-]{8,64}$/i.test(b.sid) ? b.sid : '';
  const email = typeof b.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) ? b.email : undefined;
  const ids = Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === 'string').join(',').slice(0, 480) : '';
  const back = b.back === 'dashboard' ? '/dashboard' : '/claim';
  const origin = (req.headers['x-forwarded-proto'] || 'https') + '://' + req.headers.host;

  let line;
  if (kind === 'fee') {
    line = process.env.STRIPE_PRICE_FEE
      ? { price: process.env.STRIPE_PRICE_FEE, quantity: 1 }
      : { quantity: 1, price_data: { currency: 'usd', unit_amount: FEE, product_data: { name: 'Claimclub filing fee', description: 'One-time fee to file your selected claims' } } };
  } else {
    // The offer sets the renewal price and trial length (offer e: $49 a year after 3 free days). A STRIPE_PRICE_* env price is only used when it is the plan's standard amount.
    const o = OFFERS[flow] && OFFERS[flow].plan === plan ? OFFERS[flow] : null;
    const p = Object.assign({}, PLANS[plan], o ? { amount: o.amount, trialDays: o.trialDays } : {});
    line = process.env[p.env] && p.amount === PLANS[plan].amount
      ? { price: process.env[p.env], quantity: 1 }
      : { quantity: 1, price_data: { currency: 'usd', unit_amount: p.amount, recurring: p.interval ? { interval: p.interval } : { interval: 'month', interval_count: p.months }, product_data: { name: p.name, description: p.trialDays ? 'Renews at this price after your free or $2 trial until you cancel.' : 'Intro price for your first billing period, then renews at the full price until you cancel.' } } };
  }

  try {
    const po = OFFERS[flow] && OFFERS[flow].plan === plan ? OFFERS[flow] : {};
    const trial = kind === 'member' && PLANS[plan].trialDays ? (po.trialDays || PLANS[plan].trialDays) : 0;
    const amt = po.amount || PLANS[plan].amount;
    // Meta Conversions API (flow B trial only): fbp/fbc/IP/browser saved on the session and the subscription, so the day-7 Subscribe can be matched.
    const att = trial ? attribution(req, b) : {};
    const discount = kind !== 'member' ? {}
      : trial ? { subscription_data: { trial_period_days: trial, metadata: { plan, flow, sid, ...att } } }
      : { discounts: [{ coupon: await introCoupon(stripe, plan) }], subscription_data: { metadata: { plan, flow } } };
    // Offer b's $2 is a one-time line on the first invoice; the plan price starts when the trial ends. Free trials (c, d) charge nothing today.
    const first = trial ? (OFFERS[flow] && OFFERS[flow].first) || 0 : 0;
    const lines = trial && first > 0 ? [line, { quantity: 1, price_data: { currency: 'usd', unit_amount: first, product_data: { name: 'Claimclub ' + trial + '-day trial', description: 'Then $' + (amt / 100).toFixed(2) + ' a ' + PLANS[plan].interval + ' from the end of your trial until you cancel.' } } }] : [line];
    const base = {
      mode: kind === 'fee' ? 'payment' : 'subscription',
      line_items: lines,
      customer_email: email,
      ...discount,
      metadata: { kind, plan: kind === 'member' ? plan : '', ids, flow, sid, ...(trial ? { consent: b.consent ? 'trial-2026-11-21' : '', ...att } : {}) },
    };
    const done = origin + back + '?paid=' + kind + '&sid={CHECKOUT_SESSION_ID}';
    res.setHeader('Content-Type', 'application/json');
    const pk = b.ui === 'elements' ? publishableKey() : null;
    if (pk) {
      try {
        const s = await stripe.checkout.sessions.create({ ...base, ui_mode: 'elements', return_url: done }, { apiVersion: ELEMENTS_API });
        if (s.client_secret) return res.end(JSON.stringify({ clientSecret: s.client_secret, publishableKey: pk }));
      } catch (e) { console.error('[checkout] in-page session failed, using the hosted page', e.message); }
    }
    const session = await stripe.checkout.sessions.create({
      ...base,
      ...(kind === 'fee' ? { allow_promotion_codes: true } : {}),
      locale: b.lang === 'es' ? 'es' : 'auto',
      success_url: done,
      cancel_url: origin + back + '?canceled=1',
    });
    res.end(JSON.stringify({ url: session.url }));
  } catch (e) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: e.message }));
  }
};
