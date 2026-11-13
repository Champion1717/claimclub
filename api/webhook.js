// POST /api/webhook  Stripe webhook. Verifies the signature and logs paid sessions.
// Add a database write here once you have one (e.g. save the member + their claim ids).
const Stripe = require('stripe');
const raw = (req) => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });
module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try { event = stripe.webhooks.constructEvent(await raw(req), req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
  catch (e) { res.statusCode = 400; return res.end('Bad signature'); }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    console.log('PAID', s.id, s.customer_details && s.customer_details.email, s.metadata);
  } else if (event.type === 'customer.subscription.deleted') {
    console.log('CANCELED', event.data.object.id);
  }
  res.end(JSON.stringify({ received: true }));
};
