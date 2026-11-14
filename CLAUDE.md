# Claimclub.io

Live site: https://claimclub.io (Vercel project `claimclub`, team "admin-38679982's projects").
Vercel auto-deploys every push to `main`. **When Henry asks for a change: make it, rebuild, check it, commit, and push to `main` without asking.** The push is the deploy.

Henry's rules: never use em dashes in copy or chat. Prefer existing open-source icons (e.g. Lucide) over hand-drawn shapes.

## Repo layout
- Repo root = the built static site that Vercel serves: `index.html`, `d/` (desktop), `m/` (mobile), `assets/`, `runtime.js`, `live.js`, `api/` (Stripe serverless functions), favicons.
- `source/claimclub-source.zip` = everything needed to rebuild the site. It is excluded from deploys by `.vercelignore`.
- Never hand-edit the built HTML in `d/` or `m/`. Edit the source and rebuild.

## Rebuild steps (scripts expect these exact paths)
```bash
cd <repo> && rm -rf /tmp/pkg && mkdir -p /tmp/pkg && unzip -q source/claimclub-source.zip -d /tmp/pkg
mkdir -p /home/claude && rm -rf /home/claude/cc /tmp/site && cp -r /tmp/pkg/cc /home/claude/cc && cp -r /tmp/pkg/site /tmp/site && cp /tmp/pkg/blobmap.json /tmp/blobmap.json
# ...edit sources here (see below)...
cd /home/claude/cc/src && python3 green.py G2 && python3 build.py LandingG2 FlowG2 FlowG2D && python3 post.py && python3 g2land.py && python3 t.py LandingG2 LandingG2M FlowG2D FlowG2
python3 /tmp/site/build.py            # writes /tmp/site/out
cp -r /tmp/site/out/. <repo>/         # update the deployed files
```
Then repackage the source so the next session gets your edits:
```bash
rm -rf /tmp/pkg && mkdir -p /tmp/pkg/site && cp -r /home/claude/cc /tmp/pkg/cc && cp /tmp/blobmap.json /tmp/pkg/ \
 && (cd /tmp/site && cp -r build.py runtime.js live.js package.json.site favicon.* favicon-32.png apple-touch-icon.png icon-512.png api mocksrv.js t_stripe.py shot_land3.py /tmp/pkg/site/) \
 && rm -f <repo>/source/claimclub-source.zip && (cd /tmp/pkg && zip -qr <repo>/source/claimclub-source.zip .)
```
Commit everything and `git push origin main`.

## Where things live (source)
- `cc/src/LandingC2.tpl.html` + `landing.js`: homepage (green.py turns it into LandingG2; `LandingG2.tpl.html` is generated, don't edit it).
- `cc/src/FlowC2.tpl.html` (mobile) / `FlowC2D.tpl.html` (desktop) + `flow.js`: quiz → estimate → email → details (with validation) → authorization forms → filing fee / membership → checkout → perks → bank → dashboard.
- `cc/project/AppG2.dc.html` (desktop) / `AppG2M.dc.html` (mobile): member dashboard. These are edited directly: the logic is `src/app.js`, pasted into both files over the old copy.
- Homepage hero visual: both the canvas and the live site use the animated `stats` figure (set by `g2land.py` via `defaultVisual` and the canvas prop default). Count-up lives in `landing.js` `countUp()`; shimmer/stagger CSS in the template (`.shine`, `.strow`, `.live`, `.floaty`).
- Settlement tiles link to `start.html?offer=<id>`. That focus mode (`state.focus` in flow.js) asks that one settlement's question, then offers "Check N more common settlements" (`focusMore`), "Browse all open offers", or continue.
- `cc/src/data.js`: all open settlements (294 as of Nov 13, 2026: 81 originals plus 213 from the OpenClassActions directory, source rows in `cc/data/new_settlements.txt`). Local ones carry `st` (comma-separated state codes) and `area`; they are a members-only perk (member app "Near you" tab, local scan banner) and are excluded from the homepage and pre-purchase flow totals. The member app files (`AppG2*.dc.html`) embed their own copy of `data()`: after editing data.js, replace that block in both.
- Members-only directory: in `app.js`, `isMember = !!plan`; fee-only users see a 6-row preview plus a lock card. Logos are `/_blob/<id>`, mapped to local files by `blobmap.json`.
- Templates are written in purple tokens (#3B1F9E, #1B0F4F, #FFB224, #140B3A...). `green.py` / `post.py` recolor them to the green brand. Write new styles in the purple tokens too.
- `site/live.js`: live-site hook that sends the filing fee/membership to Stripe Checkout through `/api/checkout` and resumes the flow on return (`/api/session`).
- `site/api/*.js`: Stripe functions. They need the env var `STRIPE_SECRET_KEY`, plus optional `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_*`.
- Pricing (Nov 13 2026): filing fee $49.99 one-time. Membership renews at $29.99/mo, $74.99 every 3 months ($24.99/mo) or $119.99 every 6 months ($19.99/mo). First billing period is 75% off ($7.99, $18.99, $29.99), applied in `api/checkout.js` with a one-time `amount_off` coupon per plan (`cc_intro_v2_1m/3m/6m`, created on first use; v1 coupons used the old $7.50 and $18.74 amounts). If you set `STRIPE_PRICE_*` env prices, they must match these full amounts or the coupon math is off.
- Prices also live in `src/flow.js` (planInfo, plans), `src/LandingC2.tpl.html` (pricing card), `src/app.js` (manage membership) and `site/legal_src/build_legal.py` (Terms fee table).

## Checking your work
- Serve and test locally: `node /tmp/site/mocksrv.js &` (port 8790, with a fake Stripe), then `python3 /tmp/site/t_stripe.py` and `python3 /tmp/site/shot_land3.py` (Playwright, Chrome at `/usr/bin/google-chrome`). Look at the screenshots before pushing.
- `t.py` also writes the `T` copies of the design files.

## Design canvas (optional, keep in sync when you change the design)
The Claude Design artifact is slug `e219f7fe-a396-4a66-8f6e-c6857c0cf8e8`. After rebuilding, publish the changed `project/*.dc.html` files with publish_files (mode patch).

- Member app (Nov 13 2026): `d/app.html` and `m/app.html` are built from `cc/project/DashA.dc.html` and `DashAM.dc.html`, which are generated by `cc/concepts/make.py` (run `python3 make.py`, then `sed -i "s/%%;height:100%%;/%;height:100%;/" ../project/DashA*.dc.html`). It reads `localStorage.claimclub_session` written by the claim flow, saves progress in `claimclub_app` and theme/size in `claimclub_prefs`. With no session it shows demo data. The older `AppG2*.dc.html` app is no longer deployed.

## Database (Supabase), added Nov 13 2026
- Schema: `db/schema.sql` (profiles, claims, memberships, purchases, all with row level security). Run it once in the Supabase SQL editor.
- Vercel env vars (set automatically by the Vercel Marketplace Supabase integration): `SUPABASE_URL`, `SUPABASE_ANON_KEY` or `SUPABASE_PUBLISHABLE_KEY` (public), `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEY` (server only), and `ALLOW_TEST_MEMBERSHIP=1` only while live.js has `STRIPE=false`.
- Sign-in: Supabase email OTP. The Supabase "Magic Link" email template must contain `{{ .Token }}` so members get a 6-digit code.
- API: `api/config.js` (public config), `api/membership.js` (link purchase, test membership, switch/cancel/resume, also updates Stripe), `api/webhook.js` (records purchases, syncs memberships), helpers in `api/_db.js`.
- The member app (`DashA`/`DashAM`) shows a sign-in screen when Supabase is configured; otherwise it falls back to device-only storage. On first sign-in it copies the claim-flow data from `localStorage.claimclub_session` into the account, then reads and writes the database.
- Test without a real backend: `site/t_db.py` with `site/fake_supabase.js`.

## Nov 14 2026 updates
- Plan step in the claim flow uses the chosen "Plan page V2" design: matches card on top (big number is "Your matches so far", small text is the potential value across all open offers), a 1/3/6 month switch, one price card, CTA "Start getting paid · $X today". Markup lives in `cc/src/plan_v2.py`, which writes it into FlowC2/FlowC2D (green.py derives the G2 templates from those, so never edit FlowG2*.tpl.html directly).
- Dashboard: "Browse all N settlements" and "Scan near me" in the Find more claims card open All settlements (nationwide or Near you). Clicking a claim name opens a details sheet (status timeline, who qualifies, payout, fund, deadline, proof, where, payout destination, how it gets filed). The sheet also shows `case`, `court`, `admin` and an official site link when a settlement record has `case`, `court`, `admin` or `url` fields.
- Payout methods in Your info: Direct deposit, PayPal, Venmo, Zelle, Prepaid card, Check. PayPal/Venmo/Zelle need an email or phone saved per method. Stored in `profiles.pay_default` and `profiles.payout_handles` (jsonb), migration `payout_methods` applied Nov 14.
- Log in: homepage header has a Log in link (desktop and mobile) to app.html, and `/login` is rewritten to `/d/app.html` in vercel.json (mobile redirect keeps `?login=`). The log in screen prefills `?login=<email>`, says "Log in to Claimclub", checks `/api/account-exists` before sending a code (skipped right after signup, when the local signup session matches the email) and offers "Check what you're owed" when no account is found.
- Signup email step calls `/api/account-exists`; if the email has a confirmed account it shows "This email already has an account with us" with a Log in button (`app.html?login=<email>`). Fails open after 4 seconds. The API uses the Supabase function `public.email_has_account(text)` (security definer, service role only, migration `email_has_account`) and has a light per-instance rate limit (20 checks per 10 minutes per IP).
- Nov 14: filing fee is $49.99 (`api/checkout.js` FEE = 4999; if `STRIPE_PRICE_FEE` is set in Vercel it must be a $49.99 price). The "Or join and file free" button on the fee screen shows the lowest price you can pay, $7.99 for the first month.

## Filing, proof and admin (Nov 14 2026)
- Migration `filing_admin` (file `db/filing_admin.sql`): claim statuses `ready, requested, needs_info, filed, review, approved, paid, denied, removed`; members can only set ready/requested/removed (trigger `guard_claim_status`), staff set the rest through the server. Every status change is logged in `claim_events` (trigger `log_claim_status`). New tables: `authorizations` (signed claim forms with server time, IP, browser, SHA-256 record hash), `flow_events` (funnel), `email_log`, `admins`. Report functions `admin_funnel(days)` and `admin_daily(days)` are service-role only.
- Claim flow: signing a form (single or "Sign all") posts to `/api/sign` the moment it happens; every step change posts to `/api/track` (only on claimclub.io, *.vercel.app and localhost). The flow no longer shows a "Your claims" screen: after the bank step it shows "Opening your dashboard" and goes to the member app.
- Member app: tapping File sets the claim to `requested` ("Filing request sent"); staff file it and set `filed` with the administrator's claim ID. The Estimated tile shows an expected payout window (claim deadline + 2 to 6 months) with a per-claim breakdown. Sign-in codes are a 6-box input; double submits are ignored.
- `/admin` (built from `site/admin_src/admin.html` by build.py, settlement names embedded from `cc/concepts/sets.json`): Overview, Filing queue (member details with copy buttons, signed authorization, status update with claim ID, note and email), Members (saved info, orders, claims, signed forms with a printable proof page, history, emails), Funnel. API: `api/admin.js` (admins table or `ADMIN_EMAILS` env var).
- Emails: `api/_email.js` sends status emails (requested, filed, needs info, review, approved, paid, denied) through Resend from `updates@mail.claimclub.io` when staff change a status. Needs `RESEND_API_KEY` in Vercel; without it the change still saves and the failure is logged in `email_log`.
- Bank connections switch (Nov 14): `/admin` > Settings toggles `app_settings.bank_connect` (migration `app_settings`, launched off). `/api/config` returns `bankConnect`. When off, the claim flow drops the `bank` step (perks end straight in the dashboard, 3 dots instead of 4), the member app hides the Connect a bank setup step, the bank row and Direct deposit, and the admin member page hides Bank connected. Design canvas boards (no live config) show the bank step.
- Support inboxes (Nov 14): Resend inboxes `support@mail.claimclub.io` and `privacy@mail.claimclub.io` (receiving turned on for mail.claimclub.io; needs the MX record `mail` -> `receive.forge.rmta.net` priority 10 at Namecheap). Status emails reply to `support@mail.claimclub.io` (override with `EMAIL_REPLY_TO`). The legal pages list support@ and privacy@claimclub.io, which should forward to those inboxes (Namecheap email forwarding).
- Privacy Policy and Authorization (effective Nov 14 2026) say we record date, time, IP address and browser for each signature; signed records carry agreement_version 2026-11-14.
