// DESK/TRACK backend — syncs data across devices and proxies job feeds.
//
//   PASSPHRASE=yourSecret DATA_DIR=/data node server.js
//
// Zero dependencies. Data is a JSON file. Point DATA_DIR at a Render persistent
// disk (mounted at /data) so data survives restarts and redeploys.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8788;
const PASSPHRASE = (process.env.PASSPHRASE || "changeme").trim();
const DATA_DIR = (process.env.DATA_DIR || __dirname).trim();
const DATA_FILE = path.join(DATA_DIR, "data.json");
const SEED_FILE = path.join(__dirname, "seed.json");
const KEYS = ["contacts", "targets", "templates", "profile", "saved"];

// ---- storage ----
let store = {};
function loadStore() {
  try {
    store = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    console.log(`Loaded existing data from ${DATA_FILE} (${(store.contacts || []).length} contacts)`);
  } catch {
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
    console.log(`No existing data — seeded fresh at ${DATA_FILE}`);
  }
}
function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error("persist failed:", e.message);
  }
}

// ---- automatic backups (write-triggered, on the persistent disk) ----
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const KEEP = { write: 30, daily: 14, prerestore: 5 };
let lastDailyStamp = "";
function snapshot(kind) {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
    const count = (store.contacts || []).length;
    fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, `${kind}_${ts}_c${count}.json`));
    prune();
  } catch (e) { console.error("snapshot failed:", e.message); }
}
function prune() {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith(".json"));
    for (const kind of Object.keys(KEEP)) {
      const group = files.filter(f => f.startsWith(kind + "_")).sort();
      for (const f of group.slice(0, Math.max(0, group.length - KEEP[kind]))) {
        fs.unlinkSync(path.join(BACKUP_DIR, f));
      }
    }
  } catch (e) { console.error("prune failed:", e.message); }
}
function beforeWriteBackups() {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== lastDailyStamp) { snapshot("daily"); lastDailyStamp = day; }
  snapshot("write");
}
const BACKUP_NAME_RE = /^(write|daily|prerestore)_[\dT-]+_c\d+\.json$/;

// ---- auth ----
function authed(req) {
  const h = req.headers["authorization"] || "";
  const token = (h.startsWith("Bearer ") ? h.slice(7) : "").trim();
  const a = Buffer.from(token), b = Buffer.from(PASSPHRASE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- job feed proxy (Greenhouse, Lever, Adzuna, Workday) ----
const ALLOW_HOSTS = new Set(["boards-api.greenhouse.io", "api.lever.co", "api.adzuna.com"]);
function hostAllowed(hostname) {
  if (ALLOW_HOSTS.has(hostname)) return true;
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
    beforeWriteBackups();   // snapshot the state BEFORE this change
    store[key] = body.value;
    persist();
    return send(res, 200, { ok: true, key });
  }

  if (p === "/api/backups" && req.method === "GET") {
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const list = fs.readdirSync(BACKUP_DIR)
        .filter(f => BACKUP_NAME_RE.test(f))
        .map(f => {
          const st = fs.statSync(path.join(BACKUP_DIR, f));
          const m = f.match(/_c(\d+)\.json$/);
          return { file: f, kind: f.split("_")[0], at: st.mtimeMs, contacts: m ? Number(m[1]) : null };
        })
        .sort((a, b) => b.at - a.at);
      return send(res, 200, { backups: list });
    } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
  }

  if (p === "/api/backups/restore" && req.method === "POST") {
    const body = await readBody(req);
    const file = String(body.file || "");
    if (!BACKUP_NAME_RE.test(file)) return send(res, 400, { error: "bad backup name" });
    const src = path.join(BACKUP_DIR, file);
    if (!fs.existsSync(src)) return send(res, 404, { error: "backup not found" });
    try {
      snapshot("prerestore");            // make the restore itself undoable
      fs.copyFileSync(src, DATA_FILE);
      loadStore();
      console.log(`Restored ${file} (${(store.contacts || []).length} contacts)`);
      return send(res, 200, { ok: true, restored: file, contacts: (store.contacts || []).length });
    } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
  }

  send(res, 404, { error: "not found" });
});

loadStore();
server.listen(PORT, () => {
  console.log("=== DESK/TRACK backend starting ===");
  console.log("Port:", PORT);
  console.log("DATA_DIR:", DATA_DIR);
  console.log("Data file:", DATA_FILE);
  console.log("Passphrase length:", PASSPHRASE.length, PASSPHRASE === "changeme" ? "(WARNING: default)" : "(custom set)");
  console.log("Ready.");
});
