// POST /api/membership  { action: 'link' | 'test' | 'switch' | 'cancel' | 'resume' | 'portal', plan?, kind? }
// Requires the member's access token. Memberships can only be changed through here (never directly from the browser).
const Stripe = require('stripe');
const { db, userFrom, readJson, renewsAt, send } = require('./_db');
const crypto = require('crypto');
const { flowFor, trialEndFor } = require('./_offers');
function testKeyOk(k) {
  const want = String(process.env.TEST_FLOW_KEY || '').trim();
  if (want.length < 16 || typeof k !== 'string') return false;
  const same = (a) => a.length === want.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(want));
  k = k.trim();
  return same(k) || same(k.replace(/ /g, '+'));
}
const PRICE = { '1m': { amount: 2999, months: 1 }, '3m': { amount: 7499, months: 3 }, '6m': { amount: 11999, months: 6 } };
// Offer test trial plans (Nov 21 2026): 1y (offers b, c) and 1w (offer d). Not offered as switch targets.
const TEST_PLANS = Object.assign({ '1y': { amount: 4999, months: 12 }, '1w': { amount: 499 } }, PRICE);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  let user;
  try { user = await userFrom(req); } catch (e) { return send(res, 500, { error: e.message }); }
  if (!user) return send(res, 401, { error: 'Sign in first' });
  const b = await readJson(req), sb = db();
  const { data: cur } = await sb.from('memberships').select('*').eq('user_id', user.id).maybeSingle();
  const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
  try {
    if (b.action === 'link') {
      // Attach the newest Stripe purchase made with this email.
      const { data: buys } = await sb.from('purchases').select('*').or('user_id.eq.' + user.id + ',email.ilike.' + user.email).order('created_at', { ascending: false }).limit(1);
      const p = buys && buys[0];
      if (p) {
        if (!p.user_id) await sb.from('purchases').update({ user_id: user.id }).eq('id', p.id);
        if (!cur || cur.status === 'test' || cur.status === 'ended') {
          const tr = p.kind === 'member' ? trialEndFor(p.plan, p.created_at, p.flow) : null;
          const row = { user_id: user.id, kind: p.kind, plan: p.kind === 'member' ? p.plan : null, status: 'active', flow: flowFor(p.flow, p.plan), trial_ends_at: tr, renews_at: p.kind === 'member' ? (tr || renewsAt(p.plan, p.created_at)) : null, stripe_customer: p.stripe_customer, stripe_subscription: p.stripe_subscription, started_at: p.created_at };
          await sb.from('memberships').upsert(row);
          return send(res, 200, { membership: row, settlement_ids: p.settlement_ids });
        }
      }
      return send(res, 200, { membership: cur || null });
    }
    if (b.action === 'test') {
      // Only while the built-in test checkout is in use (ALLOW_TEST_MEMBERSHIP=1). Turn this off when Stripe goes live.
      // Test flow link (Nov 15): claimclub.io/claim?test=<TEST_FLOW_KEY> skips payment; the key must match the
      // TEST_FLOW_KEY env var (Henry sets it in Vercel, at least 16 characters). ALLOW_TEST_MEMBERSHIP stays unset.
      if (process.env.ALLOW_TEST_MEMBERSHIP !== '1' && !testKeyOk(b.key)) return send(res, 403, { error: 'Test memberships are off' });
      if (cur && cur.status !== 'test') return send(res, 200, { membership: cur });
      const kind = b.kind === 'member' ? 'member' : 'fee', plan = TEST_PLANS[b.plan] ? b.plan : '1m';
      const tr = kind === 'member' ? trialEndFor(plan, null, flowFor(b.flow, plan)) : null;
      const row = { user_id: user.id, kind, plan: kind === 'member' ? plan : null, status: 'test', flow: kind === 'member' && tr ? flowFor(b.flow, plan) : 'a', trial_ends_at: tr, renews_at: kind === 'member' ? (tr || renewsAt(plan)) : null };
      await sb.from('memberships').upsert(row);
      return send(res, 200, { membership: row });
    }
    if (!cur || cur.kind !== 'member') return send(res, 400, { error: 'No membership to change' });
    if (b.action === 'portal') {
      // Stripe's customer portal: update the card, see receipts. Set it up once in Stripe > Settings > Billing > Customer portal.
      if (!stripe || !cur.stripe_customer) return send(res, 400, { error: 'Billing details open once your membership is paid through Stripe.' });
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'claimclub.io';
      const ps = await stripe.billingPortal.sessions.create({ customer: cur.stripe_customer, return_url: 'https://' + host + '/dashboard/settings' });
      return send(res, 200, { url: ps.url });
    }
    if (b.action === 'switch') {
      if (!PRICE[b.plan] || b.plan === cur.plan) return send(res, 400, { error: 'Pick a different plan' });
      if (cur.plan === '1y' || cur.plan === '1w') return send(res, 400, { error: 'This plan cannot be switched' });
      if (stripe && cur.stripe_subscription) {
        // Change the price from the next renewal on. No charge or proration today.
        const sub = await stripe.subscriptions.retrieve(cur.stripe_subscription);
        const item = sub.items.data[0];
        await stripe.subscriptions.update(sub.id, { proration_behavior: 'none', items: [{ id: item.id, price_data: { currency: 'usd', product: item.price.product, unit_amount: PRICE[b.plan].amount, recurring: { interval: 'month', interval_count: PRICE[b.plan].months } } }], metadata: { plan: b.plan } });
      }
      await sb.from('memberships').update({ pending_plan: b.plan }).eq('user_id', user.id);
      return send(res, 200, { membership: Object.assign({}, cur, { pending_plan: b.plan }) });
    }
    if (b.action === 'cancel' || b.action === 'resume') {
      const cancel = b.action === 'cancel';
      if (stripe && cur.stripe_subscription) await stripe.subscriptions.update(cur.stripe_subscription, { cancel_at_period_end: cancel });
      const status = cancel ? 'cancelling' : (cur.status === 'test' ? 'test' : 'active');
      await sb.from('memberships').update({ status, pending_plan: cancel ? null : cur.pending_plan }).eq('user_id', user.id);
      return send(res, 200, { membership: Object.assign({}, cur, { status }) });
    }
    return send(res, 400, { error: 'Unknown action' });
  } catch (e) { return send(res, 400, { error: e.message }); }
};
