// Filing specs: the base set ships with the site (api/_specs.json, built from cc/data/filing_specs.json, Nov 18 2026 research);
// rows in settlement_filing (staff edits, approved new cases) override it.
const { db } = require('./_db');
let BASE = {};
try { (require('./_specs.json') || []).forEach((s) => { BASE[s.id] = s; }); } catch (e) {}

async function getSpecs(ids) {
  const out = {};
  ids.forEach((id) => { if (BASE[id]) out[id] = Object.assign({}, BASE[id]); });
  if (ids.length) {
    const { data } = await db().from('settlement_filing').select('*').in('id', ids);
    (data || []).forEach((r) => { out[r.id] = Object.assign({}, out[r.id] || {}, Object.fromEntries(Object.entries(r).filter(([, v]) => v != null))); });
  }
  return out;
}
async function getSpec(id) { return (await getSpecs([id]))[id] || null; }
module.exports = { getSpec, getSpecs, BASE };
