// DESK/TRACK backend — syncs your data across devices and proxies job feeds.
//
//   PASSPHRASE=yourSecret node server.js
//
// Zero dependencies (no native modules, no compilation — avoids Node-version
// build failures). Data is stored as a JSON file. Point DATA_DIR at a Render
// persistent disk so it survives restarts. No third-party data leaves this
// server except outbound calls to public job-board APIs.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8788;
const PASSPHRASE = (process.env.PASSPHRASE || "changeme").trim();
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "data.json");
const SEED_FILE = path.join(__dirname, "seed.json");
const KEYS = ["contacts", "targets", "templates", "profile", "saved"];

// ---- storage: in-memory cache backed by an atomic JSON file write ----
let store = {};
function loadStore() {
  try {
    store = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    // first run: seed from seed.json
    let seed = { contacts: [], targets: [], templates: [], profile: {}, saved: [] };
    try { seed = JSON.parse(fs.readFileSync(SEED_FILE, "utf8")); } catch {}
    const withIds = (arr) => (arr || []).map((x, i) => ({ id: x.id ?? i + 1, ...x }));
    store = {
      contacts: withIds(seed.contacts),
      targets: withIds(seed.targets),
      templates: seed.templates || [],
      profile: seed.profile || {},
      saved: [],
    };
    persist();
    console.log("Seeded data from seed.json");
  }
}
function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, DATA_FILE); // atomic on same filesystem
  } catch (e) {
    console.error("persist failed:", e.message);
  }
}
loadStore();

// ---- auth: constant-time passphrase check via bearer token ----
function authed(req) {
  const h = req.headers["authorization"] || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const a = Buffer.from(token), b = Buffer.from(PASSPHRASE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- job feed proxy ----
const ALLOW_HOSTS = new Set(["boards-api.greenhouse.io", "api.lever.co", "api.adzuna.com"]);
function hostAllowed(hostname) {
  if (ALLOW_HOSTS.has(hostname)) return true;
  // Workday tenants: <tenant>.<dc>.myworkdayjobs.com
  if (/\.myworkdayjobs\.com$/.test(hostname)) return true;
  return false;
}
function fetchUpstream(target, method, postBody) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch { return reject(new Error("bad url")); }
    if (!hostAllowed(u.hostname)) return reject(new Error("host not allowed"));
    const isPost = method === "POST";
    const payload = isPost ? Buffer.from(JSON.stringify(postBody || {})) : null;
    const opts = {
      method: isPost ? "POST" : "GET",
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (desk-track)",
        "Accept": "application/json",
        ...(isPost ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
      },
    };
    const r = https.request(u, opts, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    r.on("error", reject);
    r.on("timeout", function () { this.destroy(); reject(new Error("timeout")); });
    if (payload) r.write(payload);
    r.end();
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

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (p === "/" || p === "/health") return send(res, 200, { ok: true, service: "desk-track-backend" });
  if (p === "/api/login") return send(res, authed(req) ? 200 : 401, { ok: authed(req) });

  if (p === "/fetch") {
    const target = url.searchParams.get("url");
    if (!target) return send(res, 400, { error: "missing url" });
    try {
      if (req.method === "POST") {
        const body = await readBody(req);
        const up = await fetchUpstream(target, "POST", body);
        return send(res, up.status, up.body);
      }
      const up = await fetchUpstream(target, "GET");
      return send(res, up.status, up.body);
    } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
  }

  if (!authed(req)) return send(res, 401, { error: "unauthorized" });

  if (p === "/api/data" && req.method === "GET") {
    const out = {};
    for (const k of KEYS) out[k] = store[k] ?? null;
    return send(res, 200, out);
  }

  if (p.startsWith("/api/data/") && req.method === "POST") {
    const key = p.slice("/api/data/".length);
    if (!KEYS.includes(key)) return send(res, 400, { error: "unknown key" });
    const body = await readBody(req);
    if (!("value" in body)) return send(res, 400, { error: "missing value" });
    store[key] = body.value;
    persist();
    return send(res, 200, { ok: true, key });
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`DESK/TRACK backend on ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}`);
  console.log(`Data file: ${DATA_FILE}`);
  if (PASSPHRASE === "changeme") console.log("WARNING: default passphrase. Set PASSPHRASE in the environment.");
});
