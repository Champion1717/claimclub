// Works out the member's answer for a claim form field from its label (Nov 19 2026).
// Order: the settlement's own form map (labels the researchers wrote down), then common labels every form uses.
const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// "88 Pine St, Apt 4B, Seattle, WA 98101" -> parts
function addrParts(a) {
  const parts = String(a || '').split(',').map((x) => x.trim()).filter(Boolean);
  const out = { street: '', unit: '', city: '', state: '', zip: '' };
  if (!parts.length) return out;
  const last = parts[parts.length - 1], m = last.match(/^([A-Za-z]{2})\s+(\d{5})(-\d{4})?$/);
  if (m) { out.state = m[1].toUpperCase(); out.zip = m[2]; parts.pop(); }
  if (parts.length >= 2) out.city = parts.pop();
  out.street = parts.shift() || '';
  out.unit = parts.join(', ');
  return out;
}

function values(job) {
  const m = job.member || {}, A = (job.claim && job.claim.answers) || {}, ad = addrParts(m.address);
  const nm = String(m.name || '').trim().split(/\s+/).filter(Boolean);
  const pay = (job.claim && job.claim.payout_method) || m.pay_default || '';
  const handles = m.payout_handles || {};
  const ansKeys = Object.keys(A).filter((k) => k.indexOf('n_') === 0 && k !== 'n_got' && A[k] && typeof A[k] === 'string');
  const idKey = ansKeys.find((k) => /(id|notice|login|claim|unique|number|ref)/.test(k) && !/(pin|code|pass)/.test(k));
  const pinKey = ansKeys.find((k) => /(pin|code|pass)/.test(k));
  const dob = m.dob ? new Date(m.dob + 'T12:00:00') : null;
  return {
    name: m.name, first: nm[0] || '', last: nm.length > 1 ? nm[nm.length - 1] : '', middle: nm.length > 2 ? nm.slice(1, -1).join(' ') : '',
    email: m.email, phone: String(m.phone || '').replace(/[^\d]/g, '').replace(/^1(\d{10})$/, '$1'),
    dob: dob && !isNaN(dob) ? (dob.getMonth() + 1 + '').padStart(2, '0') + '/' + (dob.getDate() + '').padStart(2, '0') + '/' + dob.getFullYear() : '', dobIso: m.dob || '',
    address: m.address, street: ad.street, unit: ad.unit, city: ad.city, state: ad.state || m.state, stateName: STATES[ad.state || m.state] || '', zip: ad.zip, country: 'United States',
    past_addresses: (m.past_addresses || []).join(' | '), payout: pay, payout_handle: handles[pay] || '',
    signature: job.signed ? (job.signature || m.name) : '', today: new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }),
    noticeId: idKey ? A[idKey] : '', noticePin: pinKey ? A[pinKey] : '', answers: A
  };
}

function srcValue(src, V) {
  const s = String(src || '');
  if (s.indexOf('need:') === 0) { const v = V.answers['n_' + s.slice(5)]; return Array.isArray(v) ? v.join(', ') : (v || ''); }
  if (s.indexOf('fixed:') === 0) return null; // written for people; the bot never guesses these
  return { name: V.name, first: V.first, last: V.last, email: V.email, phone: V.phone, dob: V.dob, address: V.address, street: V.street, city: V.city, state: V.state, zip: V.zip, past_addresses: V.past_addresses, payout: V.payout, payout_handle: V.payout_handle, signature: V.signature, today: V.today }[s];
}

// The common labels. First match wins, so the specific ones come first.
const RULES = [
  [/confirm (your )?e ?mail|e ?mail.*(again|confirm)|re ?enter.*e ?mail/, (V) => V.email],
  [/e ?mail/, (V) => V.email],
  [/first name|given name/, (V) => V.first],
  [/middle (name|initial)/, (V) => V.middle || ''],
  [/last name|surname|family name/, (V) => V.last],
  [/(login|notice|unique|claimant|class member|participant|claim) ?id\b|^id$|claim number|notice number|unique identifier|reference (number|code)/, (V) => V.noticeId],
  [/\bpin\b|confirmation code|pass ?code|access code|password/, (V) => V.noticePin],
  [/date of birth|birth ?date|\bdob\b/, (V) => V.dob],
  [/(address|street).*(2|two)|apartment|apt|suite|unit/, (V) => V.unit],
  [/(street|mailing|home|current)? ?address( line)? ?(1|one)?$|street|mailing address/, (V) => V.street],
  [/\bcity\b|\btown\b/, (V) => V.city],
  [/\bstate\b|province/, (V) => V.state],
  [/zip|postal/, (V) => V.zip],
  [/country/, (V) => V.country],
  [/phone|telephone|mobile|cell/, (V) => V.phone],
  [/paypal|venmo|zelle/, (V) => V.payout_handle],
  [/payment (method|type|option|preference)|how (would|do) you (like|want) to (be paid|receive)|select.*payment/, (V) => V.payout],
  [/signature|sign (your )?name|typed name|electronic(ally)? sign|e ?sign/, (V) => V.signature],
  [/^date$|date signed|today s date|signature date|^date of signature/, (V) => V.today],
  [/full name|^name$|^your name|claimant name|class member name|name of (claimant|class member)/, (V) => V.name]
];

// Label words that mean "the settlement form map entry is about this field".
function mapMatch(label, map) {
  const L = norm(label); if (!L) return null;
  let best = null, score = 0;
  for (const f of map || []) {
    const F = norm(f.field); if (!F) continue;
    const a = new Set(F.split(' ')), b = new Set(L.split(' '));
    const inter = [...a].filter((w) => b.has(w)).length, s = inter / Math.max(a.size, 1);
    if (L === F) return f;
    if (s > score && s >= 0.75 && inter >= 1) { score = s; best = f; }
  }
  return best;
}

function fieldValue(label, V, job) {
  const L = norm(label);
  if (!L) return null;
  const f = mapMatch(label, job.spec && job.spec.form_map);
  if (f) { const v = srcValue(f.src, V); if (v != null && v !== '' && !/^(name|address)$/.test(f.src)) return v; }
  if (/state/.test(L) && V.state) return V.state;
  for (const [re, get] of RULES) if (re.test(L)) { const v = get(V); return v == null || v === '' ? null : v; }
  return null;
}

const isAttest = (t) => /(certify|declare|attest|affirm|penalty of perjury|true and correct|i agree|i acknowledge|i confirm|i have read)/i.test(String(t || ''));

// Yes/no questions on the form that match a qualifying question the member already answered in Claimclub.
function qualifyMatch(question, job) {
  const Q = norm(question), qs = (job.spec && job.spec.qualify) || [], A = (job.claim && job.claim.answers) || {};
  for (let i = 0; i < qs.length; i++) {
    const a = new Set(norm(qs[i].q).split(' ').filter((w) => w.length > 3)), b = new Set(Q.split(' '));
    const hit = [...a].filter((w) => b.has(w)).length;
    if (a.size && hit / a.size >= 0.6) { const v = A['q_' + i]; if (v === true || v === 'yes') return true; if (v === false || v === 'no') return false; }
  }
  return null;
}

module.exports = { values, fieldValue, srcValue, isAttest, qualifyMatch, addrParts, STATES };
