// End-to-end test for the filing bot: a fake Angeion-style claim form, a fake CAPTCHA form, and the real /api/admin
// code on an in-memory database. Run: node bot/test/run.js   (needs /tmp/site/api and /tmp/site/fake_db.js)
const http = require('http'), path = require('path'), { spawnSync } = require('child_process'), assert = require('assert');
const API = process.env.API_DIR || '/tmp/site/api/';
const fake = require(process.env.FAKE_DB || '/tmp/site/fake_db.js');
const STAFF = { id: 'staff1', email: 'henry@example.com' };
require.cache[require.resolve(API + '_db')] = { exports: { db: fake.db, userFrom: async () => STAFF, send: (res, c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); }, readJson: async (req) => req.body } };
const SPECS = {
  amazon: { id: 'amazon', type: 'we', admin: 'Angeion Group', form_url: 'http://localhost:8797/angeion/', qualify: [{ q: 'Did you return an item to Amazon and not get a full refund?' }],
    form_map: [{ field: 'ID', src: 'need:notice_id' }, { field: 'Confirmation Code', src: 'need:conf_code' }, { field: 'Signature', src: 'signature' }] },
  boxed: { id: 'boxed', type: 'we', admin: 'Angeion Group', form_url: 'http://localhost:8797/captcha/', form_map: [] }
};
require.cache[require.resolve(API + '_spec')] = { exports: { getSpecs: async (ids) => Object.fromEntries(ids.filter((i) => SPECS[i]).map((i) => [i, SPECS[i]])), getSpec: async (i) => SPECS[i] || null, BASE: SPECS } };
const KEY = 'test-bot-key-0123456789abcdef';
Object.assign(process.env, { BOT_KEY: KEY, ADMIN_EMAILS: STAFF.email, RESEND_API_KEY: 're_test' });
const mails = [];
const realFetch = global.fetch;
global.fetch = async (url, o) => { if (String(url).includes('api.resend.com')) { mails.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ id: 'em_' + mails.length }) }; } return realFetch(url, o); };
const admin = require(API + 'admin.js');

fake.T.claims = [
  { id: 1, user_id: 'u1', settlement_id: 'amazon', status: 'requested', requested_at: '2026-11-19T10:00:00Z', answers: { n_notice_id: 'ABC123', n_conf_code: '9999', q_0: 'yes' }, payout_method: 'PayPal' },
  { id: 2, user_id: 'u1', settlement_id: 'boxed', status: 'requested', requested_at: '2026-11-19T11:00:00Z', answers: {} },
  { id: 3, user_id: 'u1', settlement_id: 'amazon', status: 'requested', requested_at: '2026-11-19T12:00:00Z', answers: { q_0: 'yes' } }];
fake.T.profiles = [{ id: 'u1', name: 'Maria Lopez', email: 'maria@example.com', phone: '(206) 555-0199', address: '88 Pine St, Apt 4B, Seattle, WA 98101', state: 'WA', pay_default: 'PayPal', payout_handles: { PayPal: 'maria@example.com' }, email_receipts: true }];
fake.T.authorizations = [{ user_id: 'u1', settlement_id: 'amazon', signer_name: 'Maria Lopez', created_at: '2026-11-19T09:00:00Z' }];
fake.T.app_settings = [{ key: 'filing_bot', value: { mode: 'dry', profiles: ['angeion'] } }];
fake.T.form_scans = []; fake.T.bot_runs = []; fake.T.claim_events = []; fake.T.email_log = [];

const page = (title, body) => '<!doctype html><html><head><title>' + title + '</title></head><body style="font-family:sans-serif">' + body + '</body></html>';
const STATES = '<option value="">Select a state</option><option value="CA">California</option><option value="OR">Oregon</option><option value="WA">Washington</option>';
let submitted = null;
const site = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), q = Object.fromEntries(u.searchParams);
  const send = (h) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(h); };
  if (u.pathname === '/angeion/') return send(page('Amazon Return Policy Litigation', '<nav><a href="/">Home</a> <a href="/angeion/">Submit a Claim</a></nav><h1>Amazon Return Policy Litigation</h1><p>Deadline Dec 1.</p><a href="/angeion/">Submit a Claim</a><p>Do you have a Notice ID and Confirmation Code?</p><button type="button" onclick="window.ans=\'y\'">Yes</button><button type="button" onclick="window.ans=\'n\'">No</button><button type="button" onclick="if(window.ans===\'y\')location.href=\'/angeion/submit-claim\';else if(window.ans===\'n\')location.href=\'/angeion/nonotice\'">Continue</button><a href="/docs/Claim_Form.pdf">Claim Form</a>'));
  if (u.pathname === '/angeion/submit-claim') return send(page('Login', (q.err ? '<div role="alert">ID or code is wrong</div>' : '') + '<form action="/angeion/check"><label for="i">ID</label><input id="i" name="demographics.zero_zero_id" required><label for="c">Confirmation Code</label><input id="c" type="password" name="demographics.confirmation_code" required><button type="submit">Login</button></form>'));
  if (u.pathname === '/angeion/check') { res.writeHead(302, { Location: q['demographics.zero_zero_id'] === 'ABC123' && q['demographics.confirmation_code'] === '9999' ? '/angeion/claim' : '/angeion/submit-claim?err=1' }); return res.end(); }
  if (u.pathname === '/angeion/claim') return send(page('Claim form', '<form action="/angeion/claim2"><h2>Your information</h2>'
    + '<label for="f">First Name *</label><input id="f" name="first" required><label for="l">Last Name *</label><input id="l" name="last" required>'
    + '<label for="a1">Street Address *</label><input id="a1" name="a1" required><label for="a2">Address Line 2</label><input id="a2" name="a2">'
    + '<label for="ci">City *</label><input id="ci" name="city" required><label for="st">State *</label><select id="st" name="state" required>' + STATES + '</select>'
    + '<label for="z">ZIP Code *</label><input id="z" name="zip" required><label for="e">Email Address *</label><input id="e" type="email" name="email" required><label for="e2">Confirm Email Address *</label><input id="e2" type="email" name="email2" required>'
    + '<label for="ph">Phone Number</label><input id="ph" name="phone">'
    + '<fieldset><legend>How would you like to receive your payment?</legend><label><input type="radio" name="pay" value="pp" required> PayPal</label><label><input type="radio" name="pay" value="v"> Venmo</label><label><input type="radio" name="pay" value="ck"> Check</label></fieldset>'
    + '<label for="pe">PayPal email</label><input id="pe" name="ppemail">'
    + '<button type="submit">Next</button></form>'));
  if (u.pathname === '/angeion/claim2') return send(page('Claim form 2', '<form action="/angeion/done"><input type="hidden" name="p1" value="' + encodeURIComponent(JSON.stringify(q)) + '">'
    + '<fieldset><legend>Did you return an item to Amazon and not get a full refund?</legend><label><input type="radio" name="q1" value="y" required> Yes</label><label><input type="radio" name="q1" value="n"> No</label></fieldset>'
    + '<label><input type="checkbox" name="att" required> I declare under penalty of perjury that the information in this claim form is true and correct.</label>'
    + '<label for="sg">Signature *</label><input id="sg" name="sig" required><label for="dt">Date</label><input id="dt" name="date">'
    + '<button type="submit">Submit Claim</button></form>'));
  if (u.pathname === '/angeion/done') { submitted = Object.assign(JSON.parse(decodeURIComponent(q.p1)), q); delete submitted.p1; return send(page('Thanks', '<h1>Thank you</h1><p>Your claim has been received. Your Confirmation Number is AMZ-77812.</p>')); }
  if (u.pathname === '/angeion/nonotice') return send(page('No notice', '<form><label for="n">Full name *</label><input id="n" name="n" required><iframe src="/fake/recaptcha/api2/anchor?k=1" width="304" height="78" title="reCAPTCHA"></iframe><button type="submit">Next</button></form>'));
  if (u.pathname === '/captcha/') return send(page('Captcha form', '<form><label for="n">Full name *</label><input id="n" name="n" required><iframe src="/fake/recaptcha/api2/anchor?k=1" width="304" height="78" title="reCAPTCHA"></iframe><button type="submit">Submit</button></form>'));
  send(page('Fake', 'ok'));
});
const store = {};
const api = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  if (req.url.startsWith('/store/')) { store[req.url] = raw.length; res.writeHead(200); return res.end('{}'); }
  req.body = raw ? JSON.parse(raw) : {};
  try { await admin(req, res); } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
});
const staff = async (action, body) => { const out = {}; await admin({ method: 'POST', headers: { authorization: 'Bearer x' }, body: Object.assign({ action }, body) }, { setHeader() {}, writeHead(c) { out.code = c; }, end(s) { out.body = JSON.parse(s); } }); return out.body; };

function worker() {
  const r = spawnSync('node', [path.join(__dirname, '..', 'worker.js'), '--once'], { env: Object.assign({}, process.env, { CC_API: 'http://localhost:8798', BOT_KEY: KEY, BOT_EXEC: process.env.BOT_EXEC || '/usr/bin/google-chrome', BOT_NAME: 'test' }), encoding: 'utf8', timeout: 120000 });
  process.stdout.write(r.stdout.split('\n').map((l) => '    | ' + l).join('\n') + '\n'); if (r.stderr) process.stdout.write(r.stderr.slice(0, 2000));
}
(async () => {
  await new Promise((r) => site.listen(8797, r)); await new Promise((r) => api.listen(8798, r));
  // Bad key is refused.
  const bad = await fetch('http://localhost:8798/', { method: 'POST', headers: { 'x-bot-key': 'nope', 'Content-Type': 'application/json' }, body: '{"action":"botNext"}' });
  assert.strictEqual(bad.status, 401); console.log('bad key refused');
  await new Promise((r) => setImmediate(r));
  // Run the worker in another process (async so this server keeps answering).
  const runW = () => new Promise((resolve) => { const { spawn } = require('child_process'); const p = spawn('node', [path.join(__dirname, '..', 'worker.js'), '--once'], { env: Object.assign({}, process.env, { CC_API: 'http://localhost:8798', BOT_KEY: KEY, BOT_EXEC: process.env.BOT_EXEC || '/usr/bin/google-chrome', BOT_NAME: 'test' }) });
    p.stdout.on('data', (d) => process.stdout.write(String(d).replace(/^/gm, '    | '))); p.stderr.on('data', (d) => process.stdout.write(String(d))); p.on('close', resolve); });
  console.log('0. nothing scanned yet: the bot takes nothing'); await runW(); assert.strictEqual(fake.T.bot_runs.length, 0);
  console.log('0b. CAPTCHA scan');
  await new Promise((resolve) => { const { spawn } = require('child_process'); const p = spawn('node', [path.join(__dirname, '..', 'scan.js'), '--all'], { env: Object.assign({}, process.env, { CC_API: 'http://localhost:8798' }) });
    p.stdout.on('data', (d) => process.stdout.write(String(d).replace(/^/gm, '    | '))); p.stderr.on('data', (d) => process.stdout.write(String(d))); p.on('close', resolve); });
  const sc = Object.fromEntries(fake.T.form_scans.map((x) => [x.settlement_id, x]));
  assert.strictEqual(sc.amazon.gate, true); assert.strictEqual(sc.amazon.captcha_notice, false); assert.strictEqual(sc.amazon.captcha_no_notice, true); assert.strictEqual(sc.boxed.captcha, true);
  const q = await staff('queue', {}); const cap = Object.fromEntries((q.claims || []).map((c) => [c.id, c.captcha]));
  console.log('queue captcha flags', JSON.stringify(cap)); assert.strictEqual(cap[1], false); assert.strictEqual(cap[2], true); assert.strictEqual(cap[3], true);
  console.log('1. practice fill'); await runW();
  let r1 = fake.T.bot_runs[0];
  console.log('run 1:', r1.status, r1.error || '', 'shots', r1.shots.length, 'claim', fake.T.claims[0].status);
  assert.strictEqual(r1.status, 'filled'); assert.strictEqual(fake.T.claims[0].status, 'requested'); assert.ok(r1.shots.length >= 3); assert.strictEqual(submitted, null);
  const runs = await staff('botRuns', { claim_id: 1 }); assert.ok(runs.runs[0].shotUrls.length >= 3);
  console.log('2. staff approves'); assert.ok((await staff('botApprove', { run_id: r1.id })).ok);
  await runW();
  const r2 = fake.T.bot_runs.find((r) => r.mode === 'submit');
  console.log('email_log', JSON.stringify(fake.T.email_log), JSON.stringify(fake.T.claim_events));console.log('run 2:', r2.status, r2.confirmation, '| claim', fake.T.claims[0].status, fake.T.claims[0].claim_ref, '| emails', mails.map((m) => m.subject));
  assert.strictEqual(r2.status, 'submitted'); assert.strictEqual(fake.T.claims[0].status, 'filed'); assert.strictEqual(fake.T.claims[0].claim_ref, 'AMZ-77812'); assert.ok(mails.length === 1);
  console.log('form got:', JSON.stringify(submitted));
  assert.strictEqual(submitted.first, 'Maria'); assert.strictEqual(submitted.last, 'Lopez'); assert.strictEqual(submitted.a1, '88 Pine St'); assert.strictEqual(submitted.a2, 'Apt 4B'); assert.strictEqual(submitted.city, 'Seattle');
  assert.strictEqual(submitted.state, 'WA'); assert.strictEqual(submitted.zip, '98101'); assert.strictEqual(submitted.email2, 'maria@example.com'); assert.strictEqual(submitted.pay, 'pp'); assert.strictEqual(submitted.ppemail, 'maria@example.com');
  assert.strictEqual(submitted.q1, 'y'); assert.strictEqual(submitted.att, 'on'); assert.strictEqual(submitted.sig, 'Maria Lopez');
  console.log('3. CAPTCHA claims are never handed to the bot'); await runW();
  assert.ok(!fake.T.bot_runs.some((r) => r.claim_id === 2 || r.claim_id === 3)); assert.strictEqual(fake.T.bot_runs.length, 2);
  console.log('5. mode off'); fake.T.app_settings[0].value = { mode: 'off', profiles: ['angeion'] };
  const off = await fetch('http://localhost:8798/', { method: 'POST', headers: { 'x-bot-key': KEY, 'Content-Type': 'application/json' }, body: '{"action":"botNext"}' }).then((x) => x.json()); assert.strictEqual(off.job, null);
  console.log('ALL BOT TESTS PASSED'); site.close(); api.close(); process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
