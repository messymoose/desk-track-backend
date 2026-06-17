# DESK/TRACK — synced version (backend + app)

Syncs your contacts, targets, and templates across every device through a
backend you control. The backend has ZERO dependencies (no compilation), so it
won't hit Node-version build errors. Data persists on a Render disk.

## Files
Backend: server.js, package.json, render.yaml, .nvmrc, seed.json
App: index.html, manifest.webmanifest, icon-180/192/512.png

---

## Step 1 — Deploy the BACKEND

1. New GitHub repo (e.g. `desk-track-backend`). Upload: server.js, package.json,
   render.yaml, .nvmrc, seed.json.
   (If you already made this repo and it failed to build, just upload these new
   versions over the old ones and commit — Render will redeploy.)
2. Render > New > **Web Service** > connect the repo.
3. Settings:
   - Build Command: leave **blank** (there's nothing to install)
   - Start Command: `node server.js`
4. **Add a disk** (this is what makes data durable): in the service settings,
   Disks > Add Disk > Name `data`, Mount Path `/data`, Size 1 GB.
5. **Environment** > add variables:
   - `PASSPHRASE` = a password you choose (your login on every device)
   - `DATA_DIR` = `/data`
6. Create. When "Live", open the URL — you should see
   `{"ok":true,"service":"desk-track-backend"}`. Copy that URL.

### About the disk / cost
A Render disk requires a paid instance (Starter, a few dollars/month). This is
what guarantees your contacts survive restarts. render.yaml already requests
`plan: starter` with the disk.

If you want to stay FREE: skip the disk and set no DATA_DIR. It will work and
sync while running, but data resets to the seed when the service restarts
(~15 min idle or on redeploy). For real use, the disk is worth it — or tell me
and I'll switch storage to a free hosted database (Turso) instead.

## Step 2 — Configure + deploy the APP

1. Open `index.html` in a text editor. Near the top:
       const BACKEND_URL = "__BACKEND_URL__";
   Replace `__BACKEND_URL__` with your backend URL from Step 1. Save.
2. New GitHub repo (e.g. `desk-track-app`). Upload edited index.html,
   manifest.webmanifest, and the three icons.
3. Render > New > **Static Site** > connect it. Build Command blank,
   Publish Directory `.`. Create. Copy the app URL.

## Step 3 — Use it

1. Open the app URL in Safari on iPhone. Enter your passphrase (remembered after
   first login). Share > Add to Home Screen.
2. Repeat on any device with the same passphrase — all synced.

## What changed from the version that failed to build
The backend no longer uses better-sqlite3 (a native module that failed to
compile on Render's Node 26). It now uses a plain JSON file on the disk — no
dependencies, no build step, no Node-version sensitivity. Same features.

## Jobs
Postings shows your target firms that have a live feed (Clear Street, Trumid,
CastleOak, Hennion & Walsh, Tower Research) first, then a broader S&T pool. The
other ~114 targets have no machine-readable feed and appear on Targets as MANUAL
with a careers-page link.
