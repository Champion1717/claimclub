// POST /api/checkout  -> { url }  Creates a Stripe Checkout Session.
const Stripe = require('stripe');

// Full renewal price per billing period, and the first-period charge (75% off, rounded to the cent).
const FEE = 9900;
const PLANS = {
  '1m': { amount: 2999, first: 750, months: 1, name: 'Claimclub membership (1 month)', env: 'STRIPE_PRICE_1M' },
  '3m': { amount: 7497, first: 1874, months: 3, name: 'Claimclub membership (3 months)', env: 'STRIPE_PRICE_3M' },
  '6m': { amount: 11994, first: 2999, months: 6, name: 'Claimclub membership (6 months)', env: 'STRIPE_PRICE_6M' },
};

// One-time coupon that takes the first invoice down to the intro price. Created on first use.
async function introCoupon(stripe, plan) {
  const p = PLANS[plan], id = 'cc_intro75_' + plan;
  try { return (await stripe.coupons.retrieve(id)).id; } catch (e) {
    const c = await stripe.coupons.create({ id, amount_off: p.amount - p.first, currency: 'usd', duration: 'once', name: '75% off your first billing period' });
    return c.id;
  }
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
  const email = typeof b.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) ? b.email : undefined;
  const ids = Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === 'string').join(',').slice(0, 480) : '';
  const back = typeof b.path === 'string' && /^\/[dm]\/start\.html$/.test(b.path) ? b.path : '/d/start.html';
  const origin = (req.headers['x-forwarded-proto'] || 'https') + '://' + req.headers.host;

  let line;
  if (kind === 'fee') {
    line = process.env.STRIPE_PRICE_FEE
      ? { price: process.env.STRIPE_PRICE_FEE, quantity: 1 }
      : { quantity: 1, price_data: { currency: 'usd', unit_amount: FEE, product_data: { name: 'Claimclub filing fee', description: 'One-time fee to file your selected claims' } } };
  } else {
    const p = PLANS[plan];
    line = process.env[p.env]
      ? { price: process.env[p.env], quantity: 1 }
      : { quantity: 1, price_data: { currency: 'usd', unit_amount: p.amount, recurring: { interval: 'month', interval_count: p.months }, product_data: { name: p.name, description: '75% off your first billing period, then renews at the full price until you cancel.' } } };
  }

  try {
    const extra = kind === 'member' ? { discounts: [{ coupon: await introCoupon(stripe, plan) }], subscription_data: { metadata: { plan } } } : { allow_promotion_codes: true };
    const session = await stripe.checkout.sessions.create({
      mode: kind === 'fee' ? 'payment' : 'subscription',
      line_items: [line],
      customer_email: email,
      locale: b.lang === 'es' ? 'es' : 'auto',
      ...extra,
      metadata: { kind, plan: kind === 'member' ? plan : '', ids },
      success_url: origin + back + '?paid=' + kind + '&sid={CHECKOUT_SESSION_ID}',
      cancel_url: origin + back + '?canceled=1',
    });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ url: session.url }));
  } catch (e) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: e.message }));
  }
};
