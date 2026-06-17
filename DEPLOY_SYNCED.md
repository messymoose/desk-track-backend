# DESK/TRACK — synced version (backend + app)

This version syncs your contacts, targets, and templates across every device
(phone, laptop, any network) through a backend you control. You deploy two
things on Render: the **backend** (stores + syncs data, proxies jobs) and the
**app** (the interface you add to your home screen).

## Files
Backend: server.js, package.json, render.yaml, seed.json
App: index.html, manifest.webmanifest, icon-180/192/512.png

---

## Step 1 — Deploy the BACKEND

1. New GitHub repo (e.g. `desk-track-backend`). Upload: server.js, package.json,
   render.yaml, seed.json.
2. Render > New > **Web Service** > connect that repo.
3. Settings (or let render.yaml fill them via Blueprint):
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Instance Type: Free (see the data-persistence note below)
4. Under **Environment**, add a variable:
   - Key: `PASSPHRASE`   Value: a passphrase you choose (this is your login).
5. Create. When "Live", copy the backend URL, e.g.
   `https://desk-track-backend.onrender.com`.

### IMPORTANT — data persistence on Render's free tier
The free tier has **no persistent disk**, so the database resets if the service
restarts (which it does after ~15 min idle, and on redeploys). Your edits sync
across devices fine *while it's running*, but a cold restart reloads the seed
data and loses changes made since.

Two honest options:
- **Free, with this limitation:** fine for trying it out; don't rely on it to
  keep weeks of edits.
- **Persistent (recommended if you'll use it for real):** on Render, upgrade the
  service to a paid instance and add a Disk (mount at `/data`). The included
  render.yaml already points the database at `/data/data.db` for this case. This
  is the only way your data truly survives long-term on Render.

(If you'd rather not pay, tell me — I can switch the backend to a free hosted
database like Turso or Supabase instead of a disk. That keeps it free AND
persistent, but is a different setup.)

## Step 2 — Configure + deploy the APP

1. Open `index.html` in a text editor. Near the top find:
       const BACKEND_URL = "__BACKEND_URL__";
   Replace `__BACKEND_URL__` with your backend URL from Step 1. Save.
2. New GitHub repo (e.g. `desk-track-app`). Upload: the edited index.html,
   manifest.webmanifest, and the three icons.
3. Render > New > **Static Site** > connect that repo.
   - Build Command: blank
   - Publish Directory: `.`
4. Create. Copy the app URL.

## Step 3 — Use it

1. Open the app URL in Safari on your iPhone.
2. Enter your passphrase (the PASSPHRASE you set in Step 1). It's remembered on
   that device after the first login.
3. Share > Add to Home Screen.

Repeat Step 3 on any other device (laptop browser, etc.) with the same
passphrase — they all see and edit the same synced data.

## How jobs work now
- **Postings** shows jobs from your target firms that have a live feed (Clear
  Street, Trumid, CastleOak, Hennion & Walsh, Tower Research) at the top, then a
  broader pool of S&T trading firms below.
- The other ~114 targets don't publish a machine-readable job feed (banks,
  brokers, wealth managers don't), so on the **Targets** tab they're marked
  MANUAL with a link to search their careers page. This is a real limitation of
  those firms, not the app.

## Managing your data
- **Targets tab:** add/remove target firms; each shows LIVE or MANUAL.
- **Network tab:** add/remove contacts.
- **Templates tab:** add/edit/delete email templates; placeholders {first},
  {firm}, {desk}, {me}, {background}, {via} auto-fill per contact.
All changes sync to every device.
