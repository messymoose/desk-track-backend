// DESK/TRACK backend — syncs your data across devices and proxies job feeds.
//
//   npm install
//   PASSPHRASE=yourSecret node server.js
//
// Deploys on Render as a Web Service. Set PASSPHRASE in the environment.
// Data is stored in SQLite (data.db). No third-party data leaves this server
// except outbound calls to public job-board APIs.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 8788;
const PASSPHRASE = process.env.PASSPHRASE || "changeme";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");

// ---- DB setup ----
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated INTEGER NOT NULL)`);

// Seed on first run
const seedPath = path.join(__dirname, "seed.json");
function seedIfEmpty() {
  const count = db.prepare("SELECT COUNT(*) n FROM kv").get().n;
  if (count > 0 || !fs.existsSync(seedPath)) return;
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const now = Date.now();
  const put = db.prepare("INSERT OR REPLACE INTO kv (k, v, updated) VALUES (?,?,?)");
  // give contacts/targets stable ids
  const withIds = (arr) => arr.map((x, i) => ({ id: x.id ?? i + 1, ...x }));
  put.run("contacts", JSON.stringify(withIds(seed.contacts || [])), now);
  put.run("targets", JSON.stringify(withIds(seed.targets || [])), now);
  put.run("templates", JSON.stringify(seed.templates || []), now);
  put.run("profile", JSON.stringify(seed.profile || {}), now);
  put.run("saved", JSON.stringify([]), now);
  console.log("Seeded database from seed.json");
}
seedIfEmpty();

const getKV = db.prepare("SELECT v, updated FROM kv WHERE k = ?");
const setKV = db.prepare("INSERT OR REPLACE INTO kv (k, v, updated) VALUES (?,?,?)");

// ---- auth: constant-time passphrase check via bearer token ----
function authed(req) {
  const h = req.headers["authorization"] || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(PASSPHRASE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- job feed proxy (target + S&T firms) ----
const ALLOW_HOSTS = new Set(["boards-api.greenhouse.io", "api.lever.co"]);
function fetchUpstream(target) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch { return reject(new Error("bad url")); }
    if (!ALLOW_HOSTS.has(u.hostname)) return reject(new Error("host not allowed"));
    https.get(u, { timeout: 15000, headers: { "User-Agent": "desk-track" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d }));
    }).on("error", reject).on("timeout", function () { this.destroy(); reject(new Error("timeout")); });
  });
}

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

const KEYS = new Set(["contacts", "targets", "templates", "profile", "saved"]);

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://x`);
  const p = url.pathname;

  if (p === "/" || p === "/health") return send(res, 200, { ok: true, service: "desk-track-backend" });

  // login check: returns ok if passphrase valid
  if (p === "/api/login") {
    return send(res, authed(req) ? 200 : 401, { ok: authed(req) });
  }

  // job feed proxy (no auth needed — it only relays public data)
  if (p === "/fetch") {
    const target = url.searchParams.get("url");
    if (!target) return send(res, 400, { error: "missing url" });
    try { const up = await fetchUpstream(target); return send(res, up.status, up.body); }
    catch (e) { return send(res, 502, { error: String(e.message || e) }); }
  }

  // everything below requires auth
  if (!authed(req)) return send(res, 401, { error: "unauthorized" });

  // GET /api/data -> all keys at once (one round trip on launch)
  if (p === "/api/data" && req.method === "GET") {
    const out = {};
    for (const k of KEYS) { const row = getKV.get(k); out[k] = row ? JSON.parse(row.v) : null; }
    return send(res, 200, out);
  }

  // POST /api/data/:key -> replace a collection
  if (p.startsWith("/api/data/") && req.method === "POST") {
    const key = p.slice("/api/data/".length);
    if (!KEYS.has(key)) return send(res, 400, { error: "unknown key" });
    const body = await readBody(req);
    if (!("value" in body)) return send(res, 400, { error: "missing value" });
    setKV.run(key, JSON.stringify(body.value), Date.now());
    return send(res, 200, { ok: true, key });
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`DESK/TRACK backend on ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}`);
  if (PASSPHRASE === "changeme") console.log("WARNING: using default passphrase. Set PASSPHRASE in the environment.");
});
