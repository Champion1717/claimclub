// Generic claim form filler (Nov 19 2026). Works page by page on any administrator's online claim form:
// reads every visible field with its label, works out the member's value for it, fills it, then moves on with
// Next or Continue. It never solves or works around a CAPTCHA: if one shows up, the claim goes to staff.
const { values, fieldValue, isAttest, qualifyMatch, STATES } = require('./values');

const NEXT = /^(next|continue|save (and|&) continue|proceed|start( my)? claim|begin|log ?in|sign ?in|submit (a|your) claim online|file (a|your) claim( online)?|submit a claim|make a claim|go to claim form|claim form|i agree|accept)\b/i;
const FINAL = /^(submit( my| your| this)?( claim| form)?|file( my)? claim|finish|complete( claim)?|sign and submit|submit claim form)\s*$/i;
const START_LINK = /(file|submit|make|start)\s+(a\s+|your\s+)?claim|claim form|online claim/i;
const CAPTCHA = 'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"], iframe[src*="hcaptcha.com"], iframe[src*="challenges.cloudflare.com"], .h-captcha, .cf-turnstile';

// Every visible form control with the best label we can find, run inside the page.
async function readFields(page) {
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const txt = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const labelOf = (el) => {
      if (el.labels && el.labels.length) return txt([...el.labels].map((l) => l.innerText).join(' '));
      if (el.getAttribute('aria-label')) return txt(el.getAttribute('aria-label'));
      const lb = el.getAttribute('aria-labelledby'); if (lb) return txt(lb.split(/\s+/).map((i) => (document.getElementById(i) || {}).innerText || '').join(' '));
      const wrap = el.closest('label'); if (wrap) return txt(wrap.innerText);
      let p = el.previousElementSibling; for (let i = 0; p && i < 3; i++, p = p.previousElementSibling) if (txt(p.innerText)) return txt(p.innerText).slice(0, 200);
      const par = el.parentElement && el.parentElement.parentElement; if (par) { const t = txt(par.innerText); if (t && t.length < 200) return t; }
      return txt(el.placeholder || el.name || el.id);
    };
    const groupOf = (el) => { const fs = el.closest('fieldset'); if (fs) { const lg = fs.querySelector('legend'); if (lg) return txt(lg.innerText); }
      const rg = el.closest('[role=radiogroup],[role=group]'); if (rg) { const l = rg.getAttribute('aria-label') || (rg.getAttribute('aria-labelledby') && (document.getElementById(rg.getAttribute('aria-labelledby')) || {}).innerText); if (l) return txt(l); }
      let p = el.closest('div'); for (let i = 0; p && i < 5; i++, p = p.parentElement) { const q = [...p.children].find((c) => /^(P|LABEL|SPAN|DIV|H\d|LEGEND)$/.test(c.tagName) && !c.querySelector('input') && txt(c.innerText).length > 3); if (q) return txt(q.innerText).slice(0, 300); }
      return ''; };
    const out = [];
    document.querySelectorAll('input, select, textarea').forEach((el, i) => {
      const type = (el.type || el.tagName).toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes(type)) return;
      if (el.name === 'g-recaptcha-response' || el.closest('.g-recaptcha')) return;
      if (!vis(el) && !(type === 'radio' || type === 'checkbox')) return;
      if ((type === 'radio' || type === 'checkbox') && !vis(el) && !(el.labels && el.labels[0] && vis(el.labels[0]))) return;
      el.setAttribute('data-ccbot', String(i));
      const label = labelOf(el);
      out.push({ k: String(i), tag: el.tagName.toLowerCase(), type, name: el.name || '', label, group: type === 'radio' || type === 'checkbox' ? groupOf(el) : '',
        required: el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label), value: type === 'checkbox' || type === 'radio' ? (el.checked ? 'on' : '') : el.value,
        options: el.tagName === 'SELECT' ? [...el.options].map((o) => ({ v: o.value, t: txt(o.text) })) : null, disabled: el.disabled });
    });
    return out;
  });
}

async function buttons(page) {
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const out = [];
    document.querySelectorAll('button, input[type=submit], input[type=button], a, [role=button]').forEach((el, i) => {
      if (!vis(el) || el.disabled) return;
      const t = String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 60) return;
      el.setAttribute('data-ccbtn', String(i));
      out.push({ k: String(i), t, tag: el.tagName.toLowerCase(), href: el.getAttribute('href') || '' });
    });
    return out;
  });
}

const sel = (k) => '[data-ccbot="' + k + '"]';
async function fillOne(page, f, v, log) {
  const el = page.locator(sel(f.k)).first();
  if (f.tag === 'select') {
    const opt = pickOption(f.options, v) || (STATES[String(v).toUpperCase()] ? pickOption(f.options, STATES[String(v).toUpperCase()]) : null);
    if (!opt) { log('No option matches "' + v + '" for ' + f.label); return false; }
    await el.selectOption(opt.v); return true;
  }
  if (f.type === 'checkbox') { if (v === true && !f.value) await el.check({ force: true }); return true; }
  if (f.type === 'radio') { await el.check({ force: true }); return true; }
  let val = String(v);
  if (f.type === 'date') { const d = new Date(val); if (!isNaN(d)) val = d.toISOString().slice(0, 10); }
  await el.fill(val);
  await el.dispatchEvent('blur').catch(() => {});
  return true;
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function pickOption(options, v) {
  const want = norm(v); if (!want) return null;
  const real = (options || []).filter((o) => o.v !== '' && !/^(select|choose|please)/i.test(o.t));
  return real.find((o) => norm(o.t) === want || norm(o.v) === want) || real.find((o) => norm(o.t).startsWith(want) || want.startsWith(norm(o.t))) || real.find((o) => norm(o.t).includes(want)) || null;
}

// Fills the current page. Returns the required fields we could not fill.
async function fillPage(page, job, V, log) {
  const fields = await readFields(page);
  const missing = [], done = new Set();
  // Radio groups: pick the option whose text matches the value for the group question.
  const groups = {};
  fields.filter((f) => f.type === 'radio').forEach((f) => { const g = f.name || f.group; (groups[g] = groups[g] || []).push(f); });
  for (const g of Object.keys(groups)) {
    const opts = groups[g], q = opts[0].group || g;
    if (opts.some((o) => o.value)) continue;
    let want = fieldValue(q, V, job);
    if (want == null) { const qa = qualifyMatch(q, job); if (qa != null) want = qa ? 'yes' : 'no'; }
    if (want == null) { if (opts.some((o) => o.required)) missing.push(q); continue; }
    const hit = opts.find((o) => norm(o.label) === norm(want)) || opts.find((o) => norm(o.label).includes(norm(want)) || norm(want).includes(norm(o.label)));
    if (hit) { await fillOne(page, hit, true, log); log('Picked "' + hit.label + '" for ' + q.slice(0, 80)); }
    else missing.push(q);
  }
  for (const f of fields) {
    if (f.type === 'radio' || f.disabled || done.has(f.k)) continue;
    if (f.type === 'checkbox') {
      if (isAttest(f.label + ' ' + f.group)) { if (!job.signed) { missing.push(f.label); continue; } await fillOne(page, f, true, log); log('Ticked: ' + f.label.slice(0, 90)); }
      else if (f.required && !f.value) missing.push(f.label);
      continue;
    }
    if (f.value && String(f.value).trim()) continue;
    let v = fieldValue(f.label, V, job);
    if ((v == null || v === '') && f.name) v = fieldValue(f.name.replace(/[._\[\]-]+/g, ' '), V, job);
    if (v == null || v === '') { if (f.required) missing.push(f.label || f.name); continue; }
    if (await fillOne(page, f, v, log)) log('Filled ' + (f.label || f.name).slice(0, 60) + (/(pin|code|password|ssn|social)/i.test(f.label) ? '' : ' = ' + String(v).slice(0, 60)));
    else if (f.required) missing.push(f.label);
  }
  return missing;
}

async function hasCaptcha(page) {
  const n = await page.locator(CAPTCHA).evaluateAll((els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 30; }).length).catch(() => 0);
  return n > 0;
}
async function errorsOnPage(page) {
  return page.evaluate(() => [...document.querySelectorAll('[role=alert], .error, .errors, .field-error, .invalid-feedback, .Mui-error, .text-danger, .validation-message')]
    .map((e) => String(e.innerText || '').trim()).filter((t) => t && t.length < 200).slice(0, 8));
}
const CONF = /(confirmation|claim|reference|submission|tracking)\s*(number|no\.?|#|id|code)\s*(is|:)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,})/i;

// Runs one claim from the start page to the end (or to the final Submit in practice mode).
async function runClaim(page, job, shot, log) {
  const V = values(job), dry = job.mode !== 'submit';
  let lastUrl = '', samePage = 0;
  await page.goto(job.spec.form_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  for (let step = 0; step < 14; step++) {
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(600);
    if (await hasCaptcha(page)) { await shot('captcha'); return { status: 'needs_va', error: 'This form shows a CAPTCHA. A person has to file it.' }; }
    const missing = await fillPage(page, job, V, log);
    await shot('page ' + (step + 1));
    if (missing.length) return { status: 'needs_va', error: 'Could not fill: ' + missing.slice(0, 6).map((m) => '"' + m.slice(0, 70) + '"').join(', ') };
    const btns = await buttons(page);
    const fin = btns.find((b) => FINAL.test(b.t) && b.tag !== 'a');
    const nxt = btns.find((b) => NEXT.test(b.t) && !FINAL.test(b.t));
    const fields = await readFields(page);
    const startLink = !fields.length && btns.find((b) => START_LINK.test(b.t));
    if (fin && !nxt) {
      if (dry) { log('Practice mode: stopped before "' + fin.t + '"'); return { status: 'filled' }; }
      log('Submitting with "' + fin.t + '"');
      await page.locator('[data-ccbtn="' + fin.k + '"]').first().click();
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(2500);
      await shot('after submit');
      if (await hasCaptcha(page)) return { status: 'needs_va', error: 'A CAPTCHA appeared on submit. A person has to finish it.' };
      const errs = await errorsOnPage(page);
      const text = await page.evaluate(() => document.body.innerText);
      const m = text.match(CONF);
      if (m) return { status: 'submitted', confirmation: m[4] };
      if (errs.length) return { status: 'needs_va', error: 'The form said: ' + errs.join(' | ') };
      if (/thank you|has been (submitted|received)|successfully submitted/i.test(text)) return { status: 'submitted', confirmation: '' };
      return { status: 'needs_va', error: 'Submitted, but no confirmation was found on the page. Check the screenshot.' };
    }
    const go = nxt || startLink;
    if (!go) return { status: 'needs_va', error: 'No Next or Submit button found on page ' + (step + 1) + '.' };
    log('Clicking "' + go.t + '"');
    const before = page.url() + (await page.evaluate(() => document.body.innerText.length));
    await page.locator('[data-ccbtn="' + go.k + '"]').first().click();
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const after = page.url() + (await page.evaluate(() => document.body.innerText.length));
    if (after === before) {
      const errs = await errorsOnPage(page);
      if (++samePage >= 2 || errs.length) { await shot('stuck'); return { status: 'needs_va', error: errs.length ? 'The form said: ' + errs.join(' | ') : 'The page did not move on after "' + go.t + '".' }; }
    } else samePage = 0;
    lastUrl = page.url();
  }
  return { status: 'needs_va', error: 'The form had more pages than expected.' };
}

module.exports = { runClaim, readFields, pickOption, CONF };
