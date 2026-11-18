// Case finder (Nov 18 2026). Runs daily from Vercel Cron and on demand from /admin > New cases > Run now.
// Reads settlement directories (RSS feeds and listing pages), skips anything already in our catalog or already found,
// and saves the rest to case_candidates for staff review. Nothing goes live until someone approves it.
const { db, send } = require('./_db');
let CATALOG = [];
try { CATALOG = require('./_catalog.json'); } catch (e) {}

const SOURCES = [
  { name: 'Top Class Actions', kind: 'rss', url: 'https://topclassactions.com/category/lawsuit-settlements/open-lawsuit-settlements/feed/' },
  { name: 'ClaimDepot', kind: 'rss', url: 'https://www.claimdepot.com/feed' },
  { name: 'Open Class Actions', kind: 'html', url: 'https://www.openclassactions.com/settlements.php', link: /\/settlements\/[a-z0-9-]+\.php/i },
  { name: 'ClassAction.org', kind: 'html', url: 'https://www.classaction.org/settlements', link: /\/settlements?\/[a-z0-9-]{6,}/i }
];
const UA = 'Mozilla/5.0 (compatible; ClaimclubCaseFinder/1.0; +https://www.claimclub.io)';
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';
const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'for', 'to', 'in', 'on', 'settlement', 'class', 'action', 'lawsuit', 'claim', 'claims', 'inc', 'llc', 'co', 'corp', 'company', 'data', 'breach', 'privacy', 'open', 'payout', 'payment', 'file', 'up', 'get', 'you', 'your', 'may', 'can', 'from', 'with', 'by', 'at', 'is', 'are', 'if']);

const decode = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&#8217;|&rsquo;/g, "'").replace(/&#8220;|&#8221;|&quot;/g, '"').replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, '-').replace(/&amp;/g, '&').replace(/&nbsp;|&#160;/g, ' ').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/\s+/g, ' ').trim();
const words = (s) => decode(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter((w) => w.length > 1 && !STOP.has(w));

function parseRss(xml) {
  return (xml.match(/<item[\s\S]*?<\/item>/g) || []).map((it) => {
    const tag = (t) => { const m = new RegExp('<' + t + '[^>]*>([\\s\\S]*?)<\\/' + t + '>').exec(it); return m ? m[1] : ''; };
    return { title: decode(tag('title')), url: decode(tag('link')), text: decode(tag('description') + ' ' + tag('content:encoded')).slice(0, 4000), date: tag('pubDate') };
  }).filter((x) => x.title && x.url);
}
function parseHtml(html, base, re) {
  const out = [], seen = new Set();
  const A = /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi; let m;
  while ((m = A.exec(html))) {
    const href = m[1], text = decode(m[2]);
    if (!re.test(href) || text.length < 12 || text.length > 160) continue;
    const url = new URL(href, base).toString().split('#')[0];
    if (seen.has(url)) continue; seen.add(url);
    out.push({ title: text, url, text: '' });
  }
  return out.slice(0, 80);
}
function deadlineOf(text) {
  const m = new RegExp('(?:deadline|by|before|until)[^.]{0,40}?((?:' + MONTHS + ')\\.? \\d{1,2},? \\d{4})', 'i').exec(text) || new RegExp('((?:' + MONTHS + ')\\.? \\d{1,2},? \\d{4})').exec(text);
  if (!m) return null;
  const d = new Date(m[1].replace('Sept', 'Sep') + ' 12:00 UTC');
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
function payoutOf(text) { const m = /(up to |about |approximately )?\$[\d,]+(\.\d\d)?( million| billion)?/i.exec(text); return m ? m[0].trim() : null; }
function typeOf(text) {
  const t = text.toLowerCase();
  if (/arbitration/.test(t)) return 'self';
  if (/(automatic(ally)? (payment|receive|paid)|no claim form (is )?(needed|required)|do not need to (file|submit))/.test(t)) return 'auto';
  if (/(securities|shareholder|stock|brokerage)/.test(t)) return 'self';
  return 'we';
}
function companyOf(title) {
  const m = /^(.+?)\s+(?:settlement|class action|data breach|agrees|to pay|pays|\$)/i.exec(title);
  return m ? m[1].replace(/^(the)\s+/i, '').slice(0, 80) : null;
}
// A found case is "known" when it shares the company and most title words with something we already list.
function known(title, cat) {
  const w = new Set(words(title));
  return cat.some((c) => {
    const cw = words(c.co), tw = words(c.title);
    const coHit = cw.length && cw.every((x) => w.has(x));
    const overlap = tw.filter((x) => w.has(x)).length / Math.max(1, tw.length);
    return coHit && overlap >= 0.34;
  });
}

async function fetchText(url) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8' }, signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function run() {
  const sb = db(), started = new Date().toISOString(), report = [];
  const { data: extra } = await sb.from('catalog_extra').select('id, data');
  const cat = CATALOG.concat((extra || []).filter((x) => x.data && x.data.co).map((x) => ({ id: x.id, co: x.data.co, title: x.data.title || '' })));
  const { data: prev } = await sb.from('case_candidates').select('url, title').limit(5000);
  const seenUrl = new Set((prev || []).map((p) => p.url)), seenTitle = new Set((prev || []).map((p) => words(p.title).join(' ')));
  let added = 0;
  for (const s of SOURCES) {
    const rep = { source: s.name, url: s.url, found: 0, added: 0, error: null };
    try {
      const body = await fetchText(s.url);
      const items = s.kind === 'rss' ? parseRss(body) : parseHtml(body, s.url, s.link);
      rep.found = items.length;
      for (const it of items) {
        const key = words(it.title).join(' ');
        if (seenUrl.has(it.url) || seenTitle.has(key) || known(it.title, cat)) continue;
        if (/(lawsuit filed|sues|alleges|investigation|recall)/i.test(it.title) && !/settlement/i.test(it.title)) continue;
        const text = it.title + '. ' + it.text, dl = deadlineOf(text);
        if (dl && dl < started.slice(0, 10)) continue;
        const row = { kind: 'new', title: it.title.slice(0, 300), company: companyOf(it.title), url: it.url.slice(0, 600), source: s.name, payout: payoutOf(text), deadline: dl,
          summary: it.text ? it.text.slice(0, 600) : null, suggested_type: typeOf(text), details: { published: it.date || null } };
        const { error } = await sb.from('case_candidates').insert(row);
        if (!error) { added++; rep.added++; seenUrl.add(it.url); seenTitle.add(key); }
      }
    } catch (e) { rep.error = e.name === 'AbortError' ? 'Timed out' : e.message; }
    report.push(rep);
  }
  const last = { at: started, added, sources: report };
  await sb.from('app_settings').upsert({ key: 'finder_last', value: last, updated_by: 'case finder', updated_at: new Date().toISOString() });
  return last;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET, auth = req.headers.authorization || '', ua = String(req.headers['user-agent'] || '');
  const ok = secret ? auth === 'Bearer ' + secret : /vercel-cron/i.test(ua);
  if (!ok) return send(res, 401, { error: 'Not allowed' });
  try { return send(res, 200, await run()); } catch (e) { return send(res, 500, { error: e.message }); }
};
module.exports.run = run;
