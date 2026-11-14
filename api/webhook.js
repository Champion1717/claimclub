// POST /api/webhook  Stripe webhook. Verifies the signature, records the purchase and keeps the membership in sync.
const Stripe = require('stripe');
const raw = (req) => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });
module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try { event = stripe.webhooks.constructEvent(await raw(req), req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
  catch (e) { res.statusCode = 400; return res.end('Bad signature'); }
  let sb = null;
  try { sb = require('./_db').db(); } catch (e) { console.log('No database configured; logging only.'); }
  const { renewsAt } = require('./_db');
  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object, md = s.metadata || {}, email = (s.customer_details && s.customer_details.email) || s.customer_email || '';
      console.log('PAID', s.id, email, md);
      if (sb && email) {
        const row = { email, kind: md.kind || (s.mode === 'subscription' ? 'member' : 'fee'), plan: md.plan || null, amount_cents: s.amount_total, stripe_session: s.id, stripe_customer: s.customer || null, stripe_subscription: s.subscription || null, settlement_ids: (md.ids || '').split(',').filter(Boolean) };
        const { data: prof } = await sb.from('profiles').select('id').ilike('email', email).maybeSingle();
        if (prof) row.user_id = prof.id;
        await sb.from('purchases').upsert(row, { onConflict: 'stripe_session' });
        if (prof) await sb.from('memberships').upsert({ user_id: prof.id, kind: row.kind, plan: row.kind === 'member' ? row.plan : null, status: 'active', renews_at: row.kind === 'member' ? renewsAt(row.plan) : null, stripe_customer: row.stripe_customer, stripe_subscription: row.stripe_subscription });
      }
    } else if (event.type === 'invoice.paid' && sb) {
      const inv = event.data.object;
      if (inv.subscription) {
        const sub = await stripe.subscriptions.retrieve(inv.subscription);
        const plan = sub.metadata && sub.metadata.plan;
        const upd = { renews_at: new Date(sub.current_period_end * 1000).toISOString() };
        if (plan) { upd.plan = plan; upd.pending_plan = null; }
        await sb.from('memberships').update(upd).eq('stripe_subscription', inv.subscription);
      }
    } else if (event.type === 'customer.subscription.deleted' && sb) {
      console.log('CANCELED', event.data.object.id);
      await sb.from('memberships').update({ status: 'ended' }).eq('stripe_subscription', event.data.object.id);
    }
  } catch (e) { console.error('webhook db error', e.message); }
  res.end(JSON.stringify({ received: true }));
};
