// POST /api/webhook  Stripe webhook. Verifies the signature, records the purchase and keeps the membership in sync.
// Events to send from Stripe: checkout.session.completed, invoice.paid, invoice.payment_failed,
// customer.subscription.updated, customer.subscription.deleted.
const Stripe = require('stripe');
const raw = (req) => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });
// Newer Stripe API versions moved invoice.subscription under invoice.parent.
const subOf = (inv) => inv.subscription || (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription) || null;
const money = (c) => '$' + (Number(c || 0) / 100).toFixed(2);

async function memberFor(sb, subId) {
  const { data: m } = await sb.from('memberships').select('*').eq('stripe_subscription', subId).maybeSingle();
  if (!m) return {};
  const { data: p } = await sb.from('profiles').select('email').eq('id', m.user_id).maybeSingle();
  return { m, email: p && p.email };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try { event = stripe.webhooks.constructEvent(await raw(req), req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
  catch (e) { res.statusCode = 400; return res.end('Bad signature'); }
  let sb = null;
  try { sb = require('./_db').db(); } catch (e) { console.log('No database configured; logging only.'); }
  const { renewsAt } = require('./_db');
  const { sendNotice } = require('./_email');
  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object, md = s.metadata || {}, email = (s.customer_details && s.customer_details.email) || s.customer_email || '';
      console.log('PAID', s.id, email, md);
      if (sb && email) {
        const row = { email, kind: md.kind || (s.mode === 'subscription' ? 'member' : 'fee'), plan: md.plan || null, amount_cents: s.amount_total, stripe_session: s.id, stripe_customer: s.customer || null, stripe_subscription: s.subscription || null, settlement_ids: (md.ids || '').split(',').filter(Boolean), flow: md.flow === 'b' ? 'b' : 'a' };
        const { data: prof } = await sb.from('profiles').select('id').ilike('email', email).maybeSingle();
        if (prof) row.user_id = prof.id;
        await sb.from('purchases').upsert(row, { onConflict: 'stripe_session' });
        // Flow B's trial (plan 1y): the first $49 is charged when the 7-day trial ends.
        const trialEnd = row.kind === 'member' && row.plan === '1y' ? new Date(Date.now() + 7 * 864e5).toISOString() : null;
        if (prof) await sb.from('memberships').upsert({ user_id: prof.id, kind: row.kind, plan: row.kind === 'member' ? row.plan : null, status: 'active', flow: row.flow, trial_ends_at: trialEnd, renews_at: row.kind === 'member' ? (trialEnd || renewsAt(row.plan)) : null, stripe_customer: row.stripe_customer, stripe_subscription: row.stripe_subscription });
      }
    } else if (event.type === 'invoice.paid' && sb) {
      const inv = event.data.object, subId = subOf(inv);
      if (subId) {
        const sub = await stripe.subscriptions.retrieve(subId);
        const plan = sub.metadata && sub.metadata.plan;
        const upd = { renews_at: new Date((sub.current_period_end || (sub.items && sub.items.data[0] && sub.items.data[0].current_period_end)) * 1000).toISOString() };
        if (plan) { upd.plan = plan; upd.pending_plan = null; }
        const { m } = await memberFor(sb, subId);
        if (m && m.status === 'past_due') { upd.status = sub.cancel_at_period_end ? 'cancelling' : 'active'; upd.payment_failed_at = null; }
        await sb.from('memberships').update(upd).eq('stripe_subscription', subId);
      }
    } else if (event.type === 'invoice.payment_failed' && sb) {
      const inv = event.data.object, subId = subOf(inv);
      if (subId) {
        const { m, email } = await memberFor(sb, subId);
        if (m && m.status !== 'ended') {
          const first = m.status !== 'past_due';
          await sb.from('memberships').update({ status: 'past_due', payment_failed_at: new Date().toISOString() }).eq('stripe_subscription', subId);
          if (first && email) await sendNotice({ to: email, userId: m.user_id, kind: 'billing_failed', c: {
            subject: 'Your Claimclub payment did not go through', head: 'Update your card to keep your membership',
            body: 'We tried to charge ' + money(inv.amount_due) + ' for your Claimclub membership and your bank declined it. Member features are paused until the payment goes through. Your filed claims keep moving either way.<br><br>Open your dashboard, then Settings, then Manage membership, and choose Update card. We will try the charge again automatically.',
            cta: 'Update my card', ctaUrl: 'https://claimclub.io/dashboard/settings' } });
        }
      }
    } else if (event.type === 'customer.subscription.updated' && sb) {
      const sub = event.data.object;
      const map = { active: sub.cancel_at_period_end ? 'cancelling' : 'active', trialing: sub.cancel_at_period_end ? 'cancelling' : 'active', past_due: 'past_due', unpaid: 'past_due', incomplete_expired: 'ended', canceled: 'ended' };
      const status = map[sub.status];
      if (status) {
        const { m } = await memberFor(sb, sub.id);
        if (m && m.status !== 'test' && m.status !== status) await sb.from('memberships').update({ status }).eq('stripe_subscription', sub.id);
      }
    } else if (event.type === 'customer.subscription.trial_will_end' && sb) {
      // Stripe sends this 3 days before a trial ends (day 4 of flow B's 7-day trial): remind them before the $49.
      const sub = event.data.object;
      const { m, email } = await memberFor(sb, sub.id);
      if (m && email && m.status === 'active' && !sub.cancel_at_period_end) {
        const end = new Date((sub.trial_end || 0) * 1000), day = end.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
        await sendNotice({ to: email, userId: m.user_id, kind: 'trial_ending', c: {
          subject: 'Your Claimclub trial ends ' + day, head: 'Your trial ends in 3 days',
          body: 'Thanks for trying Claimclub. Your 7-day trial ends on ' + day + '. On that day your membership renews at $49 for the year ($4.08 a month), and we keep filing every claim you qualify for.<br><br>Want to stop? Cancel anytime before then in your dashboard (Settings, then Manage membership) and you will not be charged again. Claims we already filed keep moving either way.',
          cta: 'Open my dashboard', ctaUrl: 'https://claimclub.io/dashboard/settings' } });
      }
    } else if (event.type === 'customer.subscription.deleted' && sb) {
      console.log('CANCELED', event.data.object.id);
      await sb.from('memberships').update({ status: 'ended' }).eq('stripe_subscription', event.data.object.id);
    }
  } catch (e) { console.error('webhook db error', e.message); }
  res.end(JSON.stringify({ received: true }));
};
