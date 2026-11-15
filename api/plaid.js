// POST /api/plaid (signed-in members). Actions: status, link_token, exchange, sync, choose, sub_choice, remove.
// Card connections are live for everyone when /admin > Settings > Card connections is on; admins can always use them (for testing).
const { db, userFrom, readJson, send } = require('./_db');
const P = require('./_plaid');

async function isMember(uid) {
  const { data } = await db().from('memberships').select('kind, status').eq('user_id', uid).maybeSingle();
  return !!data && data.kind === 'member' && ['active', 'cancelling', 'test'].includes(data.status);
}
async function itemFor(uid, itemId) {
  const { data } = await db().from('plaid_items').select('*').eq('user_id', uid).eq('item_id', itemId).maybeSingle();
  return data;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  let user; try { user = await userFrom(req); } catch (e) { return send(res, 500, { error: e.message }); }
  if (!user) return send(res, 401, { error: 'Sign in first' });
  const b = await readJson(req), sb = db();
  try {
    const admin = await P.isAdmin(user), on = P.configured() && (admin || await P.cardsOn());
    if (b.action === 'status') {
      if (!on) return send(res, 200, { enabled: false });
      return send(res, 200, Object.assign({ enabled: true, env: P.ENV(), member: admin || await isMember(user.id) }, await P.state(user.id)));
    }
    if (!on) return send(res, 403, { error: 'Card connections are not open yet' });
    if (!admin && !(await isMember(user.id))) return send(res, 403, { error: 'Card connections are part of membership' });

    if (b.action === 'link_token') {
      const body = { client_name: 'Claimclub', user: { client_user_id: user.id }, country_codes: ['US'], language: 'en',
        webhook: 'https://' + (req.headers['x-forwarded-host'] || req.headers.host) + '/api/plaid-webhook' };
      if (process.env.PLAID_REDIRECT_URI) body.redirect_uri = process.env.PLAID_REDIRECT_URI;
      if (b.item_id) { const it = await itemFor(user.id, b.item_id); if (!it) return send(res, 404, { error: 'Card not found' }); body.access_token = P.open(it.access_token_enc); }
      else { body.products = ['transactions']; body.transactions = { days_requested: 180 }; }
      const j = await P.plaid('/link/token/create', body);
      return send(res, 200, { link_token: j.link_token });
    }
    if (b.action === 'exchange') {
      if (!b.public_token) return send(res, 400, { error: 'Missing public_token' });
      const { count } = await sb.from('plaid_items').select('id', { count: 'exact', head: true }).eq('user_id', user.id);
      if ((count || 0) >= 8) return send(res, 400, { error: 'You can connect up to 8 banks or cards' });
      const ex = await P.plaid('/item/public_token/exchange', { public_token: b.public_token });
      const inst = b.institution || {};
      const item = { user_id: user.id, item_id: ex.item_id, access_token_enc: P.seal(ex.access_token), institution_id: inst.institution_id || inst.id || null,
        institution_name: String(inst.name || 'Your bank').slice(0, 80), env: P.ENV() };
      const { error } = await sb.from('plaid_items').upsert(item, { onConflict: 'item_id' }); if (error) throw error;
      try {
        const a = await P.plaid('/accounts/get', { access_token: ex.access_token });
        const rows = (a.accounts || []).map((x) => ({ account_id: x.account_id, item_id: ex.item_id, user_id: user.id, name: x.name, mask: x.mask, type: x.type, subtype: x.subtype }));
        if (rows.length) await sb.from('plaid_accounts').upsert(rows, { onConflict: 'account_id' });
      } catch (e) {}
      try { await P.syncItem(Object.assign({}, item, { cursor: null })); } catch (e) {}
      return send(res, 200, Object.assign({ enabled: true, env: P.ENV(), member: true }, await P.state(user.id)));
    }
    if (b.action === 'sync') {
      const { data: items } = await sb.from('plaid_items').select('*').eq('user_id', user.id);
      for (const it of items || []) { try { await P.syncItem(it); } catch (e) {} }
      return send(res, 200, Object.assign({ enabled: true, env: P.ENV(), member: true }, await P.state(user.id)));
    }
    if (b.action === 'choose') {
      if (!['fight', 'fine', 'unknown'].includes(b.choice)) return send(res, 400, { error: 'Pick fight, fine or unknown' });
      const { data: t } = await sb.from('bank_transactions').select('*').eq('user_id', user.id).eq('transaction_id', b.transaction_id).maybeSingle();
      if (!t) return send(res, 404, { error: 'Charge not found' });
      await sb.from('bank_transactions').update({ user_choice: b.choice }).eq('transaction_id', t.transaction_id);
      let request = null;
      if (b.choice !== 'fine') {
        const { data: dup } = await sb.from('refund_requests').select('*').eq('user_id', user.id).eq('source_transaction_id', t.transaction_id).maybeSingle();
        if (dup) request = dup;
        else {
          const what = b.choice === 'unknown' ? 'I do not recognize this charge (' + (t.descriptor || t.name) + ' on ' + t.date + ').' : ((t.reasons || [])[0] || 'Please get this charge refunded.') + ' Charged ' + t.date + '.';
          const { data, error } = await sb.from('refund_requests').insert({ user_id: user.id, company: String(t.merchant_name || t.name || 'Unknown company').slice(0, 80), amount: Number(t.amount), what: what.slice(0, 500), kind: 'refund', source_transaction_id: t.transaction_id }).select().maybeSingle();
          if (error) throw error; request = data;
        }
      }
      return send(res, 200, { ok: true, request });
    }
    if (b.action === 'sub_choice') {
      if (!['keep', 'cancel'].includes(b.choice)) return send(res, 400, { error: 'Pick keep or cancel' });
      const { data: s } = await sb.from('bank_recurring').select('*').eq('user_id', user.id).eq('stream_id', b.stream_id).maybeSingle();
      if (!s) return send(res, 404, { error: 'Subscription not found' });
      await sb.from('bank_recurring').update({ user_choice: b.choice }).eq('stream_id', s.stream_id);
      let request = null;
      if (b.choice === 'cancel') {
        const { data: dup } = await sb.from('refund_requests').select('*').eq('user_id', user.id).eq('source_stream_id', s.stream_id).neq('status', 'removed').maybeSingle();
        if (dup) request = dup;
        else {
          const { data, error } = await sb.from('refund_requests').insert({ user_id: user.id, company: String(s.merchant || s.description || 'Subscription').slice(0, 80), amount: s.last_amount ? Number(s.last_amount) : null,
            what: 'Cancel my subscription (' + (s.frequency || '').toLowerCase().replace(/_/g, ' ') + ', last charged ' + (s.last_date || '') + ').', kind: 'cancel', source_stream_id: s.stream_id }).select().maybeSingle();
          if (error) throw error; request = data;
        }
      }
      return send(res, 200, { ok: true, request });
    }
    if (b.action === 'remove') {
      const it = await itemFor(user.id, b.item_id); if (!it) return send(res, 404, { error: 'Card not found' });
      try { await P.plaid('/item/remove', { access_token: P.open(it.access_token_enc) }); } catch (e) {}
      await sb.from('plaid_items').delete().eq('item_id', it.item_id);
      return send(res, 200, Object.assign({ enabled: true, env: P.ENV(), member: true }, await P.state(user.id)));
    }
    return send(res, 400, { error: 'Unknown action' });
  } catch (e) {
    return send(res, 500, { error: e.message, code: e.code });
  }
};
