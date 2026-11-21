// GET /api/filing?id=<settlement>   -> that settlement's member-facing filing spec (how it gets filed, what we need, the steps)
// GET /api/filing?catalog=1          -> settlements added or changed since the site was built (new cases, hidden, moved deadlines)
// Public and cached for 5 minutes. Staff-only fields (form_map, va_notes) never leave the server here.
const { db, send } = require('./_db');
const { getSpec, getSpecs } = require('./_spec');

const PUBLIC = 'id, type, filer, form_url, admin, deadline, minutes, about, who, qualify, notice, needs, why_self, gather, steps, member_note, start_note';

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  try {
    if (q.standard) {
      // Offer G: the claims the free Standard plan covers (bot-fileable, nationwide, open).
      const ids = await require('./_tiers').standardIds();
      return send(res, 200, { ids, count: ids.length });
    }
    if (q.catalog) {
      const { data, error } = await db().from('catalog_extra').select('id, data, is_new, hidden');
      if (error) throw error;
      return send(res, 200, { extra: data || [] });
    }
    const pick = (full) => { if (!full) return null; const o = Object.fromEntries(PUBLIC.split(', ').map((k) => [k, full[k] == null ? null : full[k]])); o.filer = o.filer === 'member' ? 'member' : o.filer === 'none' ? 'none' : 'us'; return o; };
    if (q.ids) {
      const ids = String(q.ids).split(',').map((x) => x.trim().slice(0, 80)).filter(Boolean).slice(0, 150);
      const all = await getSpecs(ids), specs = {};
      ids.forEach((id) => { if (all[id]) specs[id] = pick(all[id]); });
      return send(res, 200, { specs });
    }
    const id = String(q.id || '').slice(0, 80);
    if (!id) return send(res, 400, { error: 'Missing id' });
    const full = await getSpec(id), data = full ? Object.fromEntries(PUBLIC.split(', ').map((k) => [k, full[k] == null ? null : full[k]])) : null;
    // Who files is all a member needs to know: bot and team both show as "we file it".
    if (data) data.filer = data.filer === 'member' ? 'member' : data.filer === 'none' ? 'none' : 'us';
    return send(res, 200, { spec: data || null });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return send(res, 500, { error: 'Could not load filing details', detail: e.message });
  }
};
