#!/usr/bin/env node
// Claimclub filing bot (Nov 19 2026). Runs on any always-on computer (the Mac mini, or a small server), never on Vercel.
// It asks https://www.claimclub.io/api/admin for one claim at a time, fills the official claim form in a real Chrome,
// screenshots every page, and reports back. See README.md.
//   BOT_KEY=... node worker.js            run forever
//   BOT_KEY=... node worker.js --once     one claim, then stop
//   --show                                 show the browser window
const os = require('os');
const { chromium } = require('playwright');
const { runClaim } = require('./fill');

const API = (process.env.CC_API || 'https://www.claimclub.io') + '/api/admin';
const KEY = process.env.BOT_KEY || '';
const ONCE = process.argv.includes('--once'), SHOW = process.argv.includes('--show');
const IDLE_MS = +(process.env.BOT_IDLE_MS || 90000);
const WORKER = process.env.BOT_NAME || os.hostname();
if (KEY.length < 24) { console.error('Set BOT_KEY (same value as BOT_KEY in Vercel).'); process.exit(1); }

async function call(action, body) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bot-key': KEY }, body: JSON.stringify(Object.assign({ action }, body || {})) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(action + ': ' + (j.error || r.status));
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.floor(Math.random() * (b - a));

async function doJob(browser, job) {
  const log = [], shots = [];
  const say = (t) => { const line = new Date().toISOString().slice(11, 19) + ' ' + t; log.push(line); console.log('  ' + line); };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'America/Los_Angeles' });
  const page = await ctx.newPage();
  let n = 0;
  const shot = async (what) => {
    try {
      const png = await page.screenshot({ fullPage: true, type: 'png' });
      const up = await call('botShot', { run_id: job.run_id, n: n++ });
      const r = await fetch(up.url, { method: 'PUT', headers: { 'Content-Type': 'image/png', 'x-upsert': 'true' }, body: png });
      if (r.ok) { shots.push(up.path); say('Screenshot: ' + what); } else say('Screenshot upload failed (' + r.status + ')');
    } catch (e) { say('Screenshot failed: ' + e.message); }
  };
  let res;
  try {
    say((job.mode === 'submit' ? 'Filing' : 'Practice fill') + ' claim ' + job.claim.id + ' (' + job.claim.settlement_id + ') at ' + job.spec.form_url);
    res = await runClaim(page, job, shot, say);
  } catch (e) {
    say('Error: ' + e.message);
    await shot('error');
    res = { status: 'failed', error: String(e.message || e).slice(0, 500) };
  }
  await ctx.close().catch(() => {});
  say('Result: ' + res.status + (res.confirmation ? ' · ' + res.confirmation : '') + (res.error ? ' · ' + res.error : ''));
  return call('botDone', { run_id: job.run_id, status: res.status, confirmation: res.confirmation || '', error: res.error || '', log, shots, title: job.claim.settlement_id });
}

(async () => {
  console.log('Claimclub filing bot on ' + WORKER + ', talking to ' + API);
  const browser = await chromium.launch({ headless: !SHOW, channel: process.env.BOT_CHROME || undefined, executablePath: process.env.BOT_EXEC || undefined });
  for (;;) {
    let job = null;
    try { job = (await call('botNext', { worker: WORKER })).job; } catch (e) { console.log('Could not reach Claimclub: ' + e.message); }
    if (job) {
      try { const r = await doJob(browser, job); console.log('Saved: ' + r.status); } catch (e) { console.log('Could not save result: ' + e.message); }
      if (ONCE) break;
      await sleep(jitter(20000, 60000)); // slow and steady, like a person
    } else {
      if (ONCE) { console.log('Nothing to file.'); break; }
      await sleep(IDLE_MS);
    }
  }
  await browser.close();
})();
