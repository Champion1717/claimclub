// CAPTCHA scan (Nov 19 2026). Opens every web claim form the team files ("we" specs) and records whether a CAPTCHA
// shows up on the way in. Forms that ask "Do you have a Notice ID?" first are checked down both paths.
// Results go to /api/admin (botScanSave, table form_scans). The filing bot only takes claims whose path was scanned
// and showed no CAPTCHA; everything else stays with a VA. It never solves or touches a CAPTCHA, it only looks.
//
// Run:  BOT_KEY='...' node scan.js            (forms not scanned in the last 7 days)
//       BOT_KEY='...' node scan.js --all      (every form again)
//       BOT_KEY='...' node scan.js --only realpage --show
const os = require('os');
const { chromium } = require('playwright');
const { buttons, NEXT, START_LINK } = require('./fill');

const API = (process.env.CC_API || 'https://www.claimclub.io') + '/api/admin';
const KEY = process.env.BOT_KEY || '';
const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const ALL = process.argv.includes('--all'), SHOW = process.argv.includes('--show'), ONLY = arg('--only');
const PAR = Math.max(1, Math.min(6, +(arg('--parallel') || 3)));
const WORKER = process.env.BOT_NAME || os.hostname();
if (KEY.length < 24) { console.error('Set BOT_KEY (same value as BOT_KEY in Vercel).'); process.exit(1); }

async function call(action, body) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bot-key': KEY }, body: JSON.stringify(Object.assign({ action }, body || {})) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(action + ': ' + (j.error || r.status));
  return j;
}

// CAPTCHA widgets that are actually on screen (a loaded script alone does not count), plus Cloudflare's
// "checking your browser" page. The reCAPTCHA badge means invisible reCAPTCHA, which can still challenge on submit.
async function captchaKinds(page) {
  return page.evaluate(() => {
    const seen = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 10 && r.height > 10 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const any = (q) => [...document.querySelectorAll(q)].some(seen);
    const out = [];
    if (any('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"], .g-recaptcha')) out.push('recaptcha');
    if (any('.grecaptcha-badge')) out.push('recaptcha-invisible');
    if (any('iframe[src*="hcaptcha.com"], .h-captcha')) out.push('hcaptcha');
    if (any('iframe[src*="challenges.cloudflare.com"], .cf-turnstile')) out.push('turnstile');
    if (/just a moment|checking your browser|verify you are human/i.test(document.title + ' ' + (document.body ? document.body.innerText.slice(0, 400) : ''))) out.push('cloudflare');
    if (any('iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]')) out.push('arkose');
    return out;
  }).catch(() => []);
}
const settle = async (page) => { await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {}); await page.waitForTimeout(1200); };
const hasFields = (page) => page.evaluate(() => [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=search]), select, textarea')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })).catch(() => false);

async function gateOf(page) {
  const btns = await buttons(page);
  const yes = btns.find((b) => /^yes$/i.test(b.t) && b.tag !== 'a'), no = btns.find((b) => /^no$/i.test(b.t) && b.tag !== 'a');
  if (!yes || !no) return null;
  const q = await page.evaluate((k) => { let n = document.querySelector('[data-ccbtn="' + k + '"]'); for (let i = 0; i < 6 && n; i++) { n = n.parentElement; const t = (n && n.innerText) || ''; if (/\?/.test(t)) return t.split('\n').find((l) => /\?/.test(l)) || t; } return ''; }, yes.k);
  return /notice|confirmation code|unique id|claim id|login id/i.test(q) ? { yes, no, q } : null;
}

// Follows the path through the first few pages and returns the CAPTCHA kinds seen.
async function walk(page, url, answer, hops) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await settle(page);
  let kinds = await captchaKinds(page);
  if (kinds.length) return kinds;
  if (answer != null) {
    const g = await gateOf(page);
    if (!g) return kinds;
    await page.locator('[data-ccbtn="' + (answer ? g.yes : g.no).k + '"]').first().click();
    await page.waitForTimeout(600);
  }
  for (let i = 0; i < hops; i++) {
    if (i > 0 || answer == null) { if (await hasFields(page)) break; }
    const btns = (await buttons(page)).filter((b) => !/^(yes|no)$/i.test(b.t));
    const go = btns.find((b) => NEXT.test(b.t)) || btns.find((b) => START_LINK.test(b.t));
    if (!go) break;
    await page.locator('[data-ccbtn="' + go.k + '"]').first().click().catch(() => {});
    await settle(page);
    kinds = kinds.concat(await captchaKinds(page));
    if (kinds.length) break;
  }
  return [...new Set(kinds)];
}

async function scanOne(browser, f) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'America/Los_Angeles' });
  const page = await ctx.newPage();
  const r = { id: f.id, form_url: f.form_url, gate: false, captcha_start: null, captcha_notice: null, captcha_no_notice: null, kinds: [] };
  try {
    await page.goto(f.form_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await settle(page);
    const k0 = await captchaKinds(page);
    const g = k0.length ? null : await gateOf(page);
    if (k0.length) { r.captcha_start = true; r.kinds = k0; r.note = 'CAPTCHA on the first page'; }
    else if (g) {
      r.gate = true; r.captcha_start = false;
      const ky = await walk(page, f.form_url, true, 2), kn = await walk(page, f.form_url, false, 2);
      r.captcha_notice = ky.length > 0; r.captcha_no_notice = kn.length > 0; r.kinds = [...new Set(ky.concat(kn))];
      r.note = 'Notice ID question: with notice ' + (ky.length ? 'CAPTCHA' : 'clear') + ', without ' + (kn.length ? 'CAPTCHA' : 'clear');
    } else {
      const k = await walk(page, f.form_url, null, 3);
      r.captcha_start = k.length > 0; r.kinds = k; r.note = k.length ? 'CAPTCHA on the way in' : 'No CAPTCHA seen';
    }
  } catch (e) { r.error = String(e.message || e).slice(0, 300); r.captcha_start = true; r.note = 'Could not open the form, left with a VA'; }
  await ctx.close().catch(() => {});
  return r;
}

(async () => {
  const { forms } = await call('botScanList', { all: ALL, only: ONLY || '' });
  console.log('CAPTCHA scan on ' + WORKER + ': ' + forms.length + ' claim forms to check');
  if (!forms.length) return;
  const browser = await chromium.launch({ headless: !SHOW, executablePath: process.env.BOT_EXEC || undefined });
  const tally = { va: 0, bot: 0, split: 0, err: 0 }; let i = 0;
  const lane = async () => {
    while (i < forms.length) {
      const f = forms[i++];
      const r = await scanOne(browser, f);
      const cap = !!(r.captcha_start || r.captcha_notice || r.captcha_no_notice), split = r.gate && r.captcha_notice !== r.captcha_no_notice;
      const tag = r.error ? 'err' : split ? 'split' : cap ? 'va' : 'bot'; tally[tag]++;
      console.log({ err: '  VA   ', split: '  split', va: '  VA   ', bot: '  bot  ' }[tag] + ' ' + f.id.padEnd(22) + ' ' + (r.error ? 'error: ' + r.error.slice(0, 80) : r.note + (r.kinds.length ? ' (' + r.kinds.join(', ') + ')' : '')));
      await call('botScanSave', { result: r, worker: WORKER }).catch((e) => console.log('    save failed: ' + e.message));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAR, forms.length) }, lane));
  await browser.close();
  console.log('Done. Bot can try: ' + tally.bot + ' · bot only with a notice ID: ' + tally.split + ' · VA files (CAPTCHA): ' + tally.va + ' · could not open (VA): ' + tally.err);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
