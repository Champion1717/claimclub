// GET /api/session?id=cs_...  -> { paid, kind, plan, email }  Confirms a payment after redirect.
const Stripe = require('stripe');
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) { res.statusCode = 400; return res.end(JSON.stringify({ paid: false })); }
  try {
    const s = await Stripe(process.env.STRIPE_SECRET_KEY).checkout.sessions.retrieve(id);
    const paid = s.status === 'complete' && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required');
    res.end(JSON.stringify({ paid, kind: s.metadata && s.metadata.kind, plan: s.metadata && s.metadata.plan, email: s.customer_details && s.customer_details.email }));
  } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ paid: false })); }
};
