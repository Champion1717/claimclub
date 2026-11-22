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
  const { sendMetaEvent } = require('./_meta');
  const { flowFor, trialEndFor, renewFor, TRIAL_DAYS } = require('./_offers');
  const LTV = (plan, flow) => (plan === '1w' ? 4.99 * 8 : plan === '1mt' ? 19.99 * 3 : plan === 'fast' ? 45 : plan === 'pri' ? 90 : renewFor(plan, flow));
  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object, md = s.metadata || {}, email = (s.customer_details && s.customer_details.email) || s.customer_email || '';
      console.log('PAID', s.id, email, md.kind, md.plan, md.flow);
      // Meta Purchase (server copy) = a trial started (offers b, c, d). Value is what was charged today ($2 or $0).
      // Same event_id as the browser pixel, so Meta dedupes the two.
      if ((TRIAL_DAYS[md.plan] || ['fast', 'pri', 'c1', 'c3', 'c6'].includes(md.plan)) && s.mode === 'subscription') {
        await sendMetaEvent({ eventName: 'Purchase', eventId: s.id, eventTime: s.created, value: (s.amount_total || 0) / 100, extraCustom: { predicted_ltv: LTV(md.plan, md.flow) },
          email, phone: s.customer_details && s.customer_details.phone, meta: md });
      }
      if (sb && email) {
        const row = { email, kind: md.kind || (s.mode === 'subscription' ? 'member' : 'fee'), plan: md.plan || null, amount_cents: s.amount_total, stripe_session: s.id, stripe_customer: s.customer || null, stripe_subscription: s.subscription || null, settlement_ids: (md.ids || '').split(',').filter(Boolean), flow: flowFor(md.flow, md.plan), sid: md.sid || null };
        const { data: prof } = await sb.from('profiles').select('id').ilike('email', email).maybeSingle();
        if (prof) row.user_id = prof.id;
        await sb.from('purchases').upsert(row, { onConflict: 'stripe_session' });
        // Trial plans: 1y (offers b, c) ends after 7 days, 1w (offer d) after 3. The first full charge is at the end.
        const trialEnd = row.kind === 'member' ? trialEndFor(row.plan, null, row.flow) : null;
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
      // Meta Subscribe = the first full charge after a trial (server only, once per subscription). Later renewals are not sent.
      if (subId && inv.billing_reason === 'subscription_cycle' && inv.amount_paid > 0) {
        const sub = await stripe.subscriptions.retrieve(subId), smd = sub.metadata || {};
        if (TRIAL_DAYS[smd.plan] && smd.meta_subscribe_sent !== '1') {
          const { m } = await memberFor(sb, subId);
          await sendMetaEvent({ eventName: 'Subscribe', eventId: inv.id, eventTime: (inv.status_transitions && inv.status_transitions.paid_at) || Math.floor(Date.now() / 1000),
            value: inv.amount_paid / 100, extraCustom: { predicted_ltv: LTV(smd.plan, smd.flow) }, email: inv.customer_email, phone: inv.customer_phone, userId: m && m.user_id, meta: smd });
          await stripe.subscriptions.update(subId, { metadata: { meta_subscribe_sent: '1' } });
        }
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
      // Stripe sends this 3 days before a trial ends (day 4 of a 7-day trial): remind them before the $49.99.
      // The weekly plan's 3-day trial gets its reminder from the daily cron instead (api/find-cases.js), since Stripe sends this at signup.
      const sub = event.data.object, plan = sub.metadata && sub.metadata.plan;
      const { m, email } = await memberFor(sb, sub.id);
      const short = plan === '1w' || plan === '1mt' || (m && ['e', 'h', 'j'].includes(m.flow)) || (sub.metadata && ['e', 'h', 'j'].includes(sub.metadata.flow));
      if (!short && m && email && m.status === 'active' && !sub.cancel_at_period_end) {
        const end = new Date((sub.trial_end || 0) * 1000), day = end.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
        await sendNotice({ to: email, userId: m.user_id, kind: 'trial_ending', c: {
          subject: 'Your Claimclub trial ends ' + day, head: 'Your trial ends in 3 days',
          body: 'Thanks for trying Claimclub. Your 7-day trial ends on ' + day + '. On that day your membership renews at $49.99 for the year ($4.17 a month), and we keep filing every claim you qualify for.<br><br>Want to stop? Cancel anytime before then in your dashboard (Settings, then Manage membership) and you will not be charged again. Claims we already filed keep moving either way.',
          cta: 'Open my dashboard', ctaUrl: 'https://claimclub.io/dashboard/settings' } });
      }
    } else if (event.type === 'customer.subscription.deleted' && sb) {
      console.log('CANCELED', event.data.object.id);
      await sb.from('memberships').update({ status: 'ended' }).eq('stripe_subscription', event.data.object.id);
    }
  } catch (e) { console.error('webhook db error', e.message); }
  res.end(JSON.stringify({ received: true }));
};
