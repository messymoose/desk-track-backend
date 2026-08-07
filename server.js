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
const KEYS = ["contacts", "targets", "templates", "profile", "saved", "resume", "letters"];

// ---- Kalshi Open Desk config (page served at /kalshi, gated by its own passphrase) ----
const KALSHI_PASS = (process.env.KALSHI_PASS || "deskpass").trim();
const KALSHI_BASES = {
  demo: "https://external-api.demo.kalshi.co",
  prod: "https://external-api.kalshi.com",
};
const KALSHI_HTML = path.join(__dirname, "kalshi.html");
function kalshiAuthed(req) {
  const a = Buffer.from(String(req.headers["x-kalshi-pass"] || ""));
  const b = Buffer.from(KALSHI_PASS);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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

// ---- Anthropic API config ----
// Key precedence: Render env var (most secure) -> key saved from the app UI.
const ANTHROPIC_BASE = (process.env.ANTHROPIC_BASE || "https://api.anthropic.com").replace(/\/$/, "");
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
function anthropicKey() {
  const fromEnv = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const fromStore = store.profile && store.profile.anthropicKey;
  return (fromStore || "").trim() || null;
}

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Kalshi-Pass, Kalshi-Access-Key, Kalshi-Access-Timestamp, Kalshi-Access-Signature");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (p === "/" || p === "/health") return send(res, 200, { ok: true, service: "desk-track-backend" });
  if (p === "/api/login") return send(res, authed(req) ? 200 : 401, { ok: authed(req) });

  // ═══════════════ KALSHI OPEN DESK (own passphrase gate: x-kalshi-pass) ═══════════════

  // The trading page itself (public shell — shows a lock screen until unlocked)
  if (p === "/kalshi" && req.method === "GET") {
    try {
      const html = fs.readFileSync(KALSHI_HTML);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch {
      return send(res, 404, { error: "kalshi.html not found next to server.js" });
    }
  }

  // Lock-screen unlock check
  if (p === "/kalshi-auth-check") {
    return kalshiAuthed(req)
      ? send(res, 200, { ok: true })
      : send(res, 401, { error: { message: "unauthorized" } });
  }

  // ES futures + prior SPX close for the gap panel (Yahoo Finance, no key needed)
  if (p === "/kalshi-futures" && req.method === "GET") {
    if (!kalshiAuthed(req)) return send(res, 401, { error: { message: "unauthorized" } });
    try {
      const yh = async (sym) => {
        const r = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1m`,
          { headers: { "User-Agent": "Mozilla/5.0" } }
        );
        const j = await r.json();
        const meta = (j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta) || {};
        return { price: meta.regularMarketPrice ?? null, prevClose: meta.chartPreviousClose ?? meta.previousClose ?? null };
      };
      const [es, spx] = await Promise.all([yh("ES=F"), yh("^GSPC")]);
      return send(res, 200, {
        esFuture: es.price,
        spxPriorClose: spx.prevClose ?? spx.price,
        impliedOpen: es.price,
        asOf: new Date().toISOString(),
      });
    } catch (e) {
      return send(res, 502, { error: { message: "Futures fetch error: " + String(e.message || e) } });
    }
  }

  // Proxy for Kalshi Trade API. The browser signs each request (RSA-PSS) and
  // sends the three KALSHI-ACCESS-* headers; we forward them verbatim. The
  // private key never touches this server — only single-use signed headers.
  const km = p.match(/^\/kalshi-api\/(demo|prod)(\/.*)$/);
  if (km) {
    if (!kalshiAuthed(req)) return send(res, 401, { error: { message: "unauthorized" } });
    try {
      const target = KALSHI_BASES[km[1]] + km[2] + (url.search || "");
      const headers = { "Content-Type": "application/json" };
      for (const h of ["kalshi-access-key", "kalshi-access-timestamp", "kalshi-access-signature"]) {
        if (req.headers[h]) headers[h] = req.headers[h];
      }
      const init = { method: req.method, headers };
      if (req.method !== "GET" && req.method !== "HEAD") {
        init.body = JSON.stringify(await readBody(req));
      }
      const up = await fetch(target, init);
      const text = await up.text();
      return send(res, up.status, text);
    } catch (e) {
      return send(res, 502, { error: { message: "Kalshi proxy error: " + String(e.message || e) } });
    }
  }

  // ═══════════════ end Kalshi section — DESK/TRACK continues unchanged ═══════════════

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

  // ---- Claude (Anthropic API) proxy: key never leaves the server ----
  if (p === "/api/ai/key" && req.method === "GET") {
    return send(res, 200, { configured: !!anthropicKey(), source: process.env.ANTHROPIC_API_KEY ? "env" : (store.profile && store.profile.anthropicKey ? "app" : null) });
  }

  if (p === "/api/ai/models" && req.method === "GET") {
    const key = anthropicKey();
    if (!key) return send(res, 400, { error: "No Anthropic API key set. Add one in the app under Letters → Setup." });
    try {
      const r = await fetch(ANTHROPIC_BASE + "/v1/models?limit=40", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      const j = await r.json();
      if (!r.ok) return send(res, r.status, { error: (j.error && j.error.message) || "model list failed" });
      return send(res, 200, { models: (j.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id })) });
    } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
  }

  if (p === "/api/ai/generate" && req.method === "POST") {
    const key = anthropicKey();
    if (!key) return send(res, 400, { error: "No Anthropic API key set. Add one in the app under Letters → Setup." });
    const body = await readBody(req);
    const content = Array.isArray(body.content) ? body.content : null;
    if (!content || !content.length) return send(res, 400, { error: "missing content" });
    const payload = {
      model: body.model || DEFAULT_MODEL,
      max_tokens: Math.min(Number(body.max_tokens) || 2000, 8000),
      messages: [{ role: "user", content }],
    };
    if (body.system) payload.system = String(body.system);
    try {
      const r = await fetch(ANTHROPIC_BASE + "/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok) {
        const msg = (j.error && j.error.message) || `Anthropic error ${r.status}`;
        return send(res, r.status, { error: msg });
      }
      const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      return send(res, 200, { text, model: j.model, usage: j.usage || null });
    } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
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
  console.log("Kalshi desk: /kalshi", KALSHI_PASS === "deskpass" ? "(default passphrase)" : "(custom passphrase set)");
  console.log("Ready.");
});
