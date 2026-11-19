# Claimclub filing bot

Fills official settlement claim forms for members. It runs on our own always-on computer (the Mac mini is a good fit,
since a home connection looks like a normal person), never on Vercel. It only talks to `https://www.claimclub.io/api/admin`
with its own key, so the computer never holds the database password.

## How it works
1. A member taps File in the dashboard. The claim becomes "requested" and shows in /admin > Filing queue.
2. The bot asks Claimclub for the next requested claim whose administrator is turned on in /admin > Settings > Filing bot.
3. It opens the official form in Chrome, fills every field it can work out (name, address, email, phone, notice ID and
   PIN, payout method, the qualifying yes/no questions the member already answered, the attestation box only when the
   member signed our authorization, and their typed signature), screenshots every page, and:
   - **Practice mode**: stops before the final Submit. Staff open the claim in /admin, check the screenshots and press
     "Approve and submit". The bot then files it for real on its next pass.
   - **Submit automatically**: submits, reads the confirmation number off the page, marks the claim filed and emails
     the member.
4. Anything it is unsure about comes back to staff with a screenshot and the reason: a CAPTCHA (the bot never solves
   or works around one), a field it cannot fill, a form error, or no confirmation number.

One claim at a time, with a 20 to 60 second pause between claims.

## Set up (once)
1. Make a key: `openssl rand -hex 24`
2. In Vercel > claimclub > Settings > Environment Variables add `BOT_KEY` with that value (Production), then redeploy.
3. On the bot computer (needs Node 20+):
   ```bash
   git clone https://github.com/Champion1717/claimclub.git && cd claimclub/bot
   npm install && npx playwright install chromium
   export BOT_KEY=the-same-key
   node worker.js --once --show   # one claim, with the browser visible, to watch it work
   node worker.js                 # keeps running
   ```
   On a Mac, keep it running with `pm2` (`npm i -g pm2 && pm2 start worker.js --name claimclub-bot && pm2 save`)
   or a LaunchAgent.
4. In /admin > Settings > Filing bot pick Practice and tick the administrators to try (Angeion first).

Options: `BOT_NAME` (shown in /admin), `BOT_IDLE_MS` (wait when nothing is queued, default 90000),
`BOT_CHROME=chrome` to use installed Google Chrome, `CC_API` to point at a preview deployment.

## Test
`node bot/test/run.js` runs the real /api/admin code on an in-memory database against a fake Angeion-style
form (practice fill, approve, real submit with confirmation and member email) and a fake CAPTCHA form.
It needs the unpacked site source at /tmp/site (see CLAUDE.md, Rebuild steps).

## CAPTCHA scan

The bot only files claims whose claim form was scanned and showed no CAPTCHA on the member's path. Everything else stays with a VA.

```bash
BOT_KEY='...' node scan.js            # forms not scanned in the last 7 days
BOT_KEY='...' node scan.js --all      # every form again
BOT_KEY='...' node scan.js --only realpage --show
```

Forms that first ask "Do you have a Notice ID?" are checked down both paths, so a member with a notice ID can still go to the bot when only the no-notice path has a CAPTCHA. Results are saved in the `form_scans` table and shown as "CAPTCHA · VA files" in the Filing queue.
