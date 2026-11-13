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
- Homepage hero visual: the design canvas shows the `stats` figure (set by `g2land.py` via `defaultVisual`). The live site forces the `tracker` card through the `livevis` patch in `site/build.py`.
- Settlement tiles link to `start.html?offer=<id>`. That focus mode (`state.focus` in flow.js) asks that one settlement's question, then offers "Check N more common settlements" (`focusMore`), "Browse all open offers", or continue.
- `cc/src/data.js`: the 81 settlements/offers. Logos are `/_blob/<id>`, mapped to local files by `blobmap.json`.
- Templates are written in purple tokens (#3B1F9E, #1B0F4F, #FFB224, #140B3A...). `green.py` / `post.py` recolor them to the green brand. Write new styles in the purple tokens too.
- `site/live.js`: live-site hook that sends the filing fee/membership to Stripe Checkout through `/api/checkout` and resumes the flow on return (`/api/session`).
- `site/api/*.js`: Stripe functions. They need the env var `STRIPE_SECRET_KEY`, plus optional `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_*`.

## Checking your work
- Serve and test locally: `node /tmp/site/mocksrv.js &` (port 8790, with a fake Stripe), then `python3 /tmp/site/t_stripe.py` and `python3 /tmp/site/shot_land3.py` (Playwright, Chrome at `/usr/bin/google-chrome`). Look at the screenshots before pushing.
- `t.py` also writes the `T` copies of the design files.

## Design canvas (optional, keep in sync when you change the design)
The Claude Design artifact is slug `e219f7fe-a396-4a66-8f6e-c6857c0cf8e8`. After rebuilding, publish the changed `project/*.dc.html` files with publish_files (mode patch).
