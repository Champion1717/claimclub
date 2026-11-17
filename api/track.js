// POST /api/track  { sid, step, idx, device, lang, offer }
// Records that an anonymous visitor reached a step of the claim flow, for the admin funnel.
const { db, readJson, send } = require('./_db');
const { limited, ipOf } = require('./_limit');
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  if (limited('track:' + ipOf(req), 300, 60 * 60 * 1000)) return send(res, 429, { error: 'Too many requests' });
  const b = await readJson(req);
  const sid = clip(b.sid, 64), step = clip(b.step, 40);
  if (!/^[a-z0-9-]{8,64}$/i.test(sid) || !/^[a-z0-9_]+$/i.test(step)) return send(res, 400, { error: 'Bad event' });
  try {
    await db().from('flow_events').insert({ sid, step, step_index: Number.isFinite(+b.idx) ? Math.round(+b.idx) : null, device: clip(b.device, 4), lang: clip(b.lang, 5), offer: clip(b.offer, 60) || null, flow: b.flow === 'b' ? 'b' : 'a' });
  } catch (e) {}
  return send(res, 200, { ok: true });
};
