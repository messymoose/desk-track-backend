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
const KEYS = ["contacts", "targets", "templates", "profile", "saved", "resume", "letters", "inboxJobs", "inboxSeen", "jobSummaries"];

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

// ---- Minimal IMAP client (zero dependencies) ----------------------------
// Reads recent mail from Gmail over TLS using an app password. We only ever
// read: LOGIN, SELECT, SEARCH, FETCH (BODY.PEEK, so messages stay unread).
function imapClient(opts) {
  const tls = require("tls");
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: opts.host, port: opts.port || 993, servername: opts.host }, () => {});
    let buf = "";
    let pending = null; // { tag, resolve, reject }
    let greeted = false;
    const settle = () => {
      if (!pending) return;
      // A command is done when we see a line starting with its tag.
      const re = new RegExp("^" + pending.tag + " (OK|NO|BAD)([^\\r\\n]*)", "m");
      const m = buf.match(re);
      if (!m) return;
      const payload = buf.slice(0, m.index);
      const status = m[1];
      const detail = (m[2] || "").trim();
      buf = buf.slice(m.index + m[0].length);
      const p = pending;
      pending = null;
      if (status === "OK") p.resolve(payload);
      else p.reject(new Error(`IMAP ${status}: ${detail || "command failed"}`));
    };
    sock.setEncoding("binary");
    sock.on("data", (d) => {
      buf += d;
      if (!greeted) {
        if (/^\* (OK|PREAUTH)/m.test(buf)) { greeted = true; buf = ""; resolve(api); }
        else if (/^\* BYE/m.test(buf)) { reject(new Error("IMAP server refused the connection")); }
        return;
      }
      settle();
    });
    sock.on("error", (e) => { if (pending) { pending.reject(e); pending = null; } else reject(e); });
    sock.on("close", () => { if (pending) { pending.reject(new Error("IMAP connection closed")); pending = null; } });
    sock.setTimeout(25000, () => { sock.destroy(new Error("IMAP timed out")); });

    let n = 0;
    const api = {
      cmd(line) {
        return new Promise((res, rej) => {
          if (pending) return rej(new Error("IMAP busy"));
          const tag = "a" + (++n);
          pending = { tag, resolve: res, reject: rej };
          sock.write(tag + " " + line + "\r\n", "binary");
        });
      },
      close() { try { sock.write("aZ LOGOUT\r\n"); sock.end(); } catch {} },
    };
  });
}

function decodeTransfer(body, encoding) {
  const enc = (encoding || "").toLowerCase();
  if (enc === "base64") {
    try { return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8"); } catch { return body; }
  }
  if (enc === "quoted-printable") {
    return body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

function decodeHeaderWord(s) {
  // RFC 2047: =?utf-8?B?....?= / =?utf-8?Q?....?=
  return String(s || "").replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, kind, data) => {
    try {
      if (kind.toUpperCase() === "B") return Buffer.from(data, "base64").toString("utf8");
      return data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (__, h) => String.fromCharCode(parseInt(h, 16)));
    } catch { return data; }
  });
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&rsquo;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

// Parse a raw RFC822 message into { from, subject, date, text }
function parseMessage(raw) {
  const split = raw.indexOf("\r\n\r\n") >= 0 ? raw.indexOf("\r\n\r\n") : raw.indexOf("\n\n");
  const headText = split >= 0 ? raw.slice(0, split) : raw;
  let body = split >= 0 ? raw.slice(split + (raw.indexOf("\r\n\r\n") >= 0 ? 4 : 2)) : "";
  // unfold headers
  const unfolded = headText.replace(/\r?\n[ \t]+/g, " ");
  const head = {};
  unfolded.split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(":");
    if (i > 0) {
      const k = line.slice(0, i).trim().toLowerCase();
      if (!(k in head)) head[k] = line.slice(i + 1).trim();
    }
  });
  const ctype = head["content-type"] || "";
  let text = "";
  const bm = ctype.match(/boundary="?([^";]+)"?/i);
  if (/multipart\//i.test(ctype) && bm) {
    const boundary = "--" + bm[1];
    const parts = body.split(boundary).slice(1, -1);
    const decoded = parts.map((part) => {
      const ps = part.indexOf("\r\n\r\n") >= 0 ? part.indexOf("\r\n\r\n") : part.indexOf("\n\n");
      if (ps < 0) return { type: "", text: "" };
      const ph = part.slice(0, ps).replace(/\r?\n[ \t]+/g, " ");
      const pb = part.slice(ps + (part.indexOf("\r\n\r\n") >= 0 ? 4 : 2));
      const ptype = (ph.match(/content-type:\s*([^;\r\n]+)/i) || [, ""])[1].toLowerCase();
      const penc = (ph.match(/content-transfer-encoding:\s*([^\r\n;]+)/i) || [, ""])[1];
      return { type: ptype, text: decodeTransfer(pb, penc) };
    });
    const plain = decoded.find((p) => p.type === "text/plain");
    const html = decoded.find((p) => p.type === "text/html");
    text = plain ? plain.text : html ? stripHtml(html.text) : "";
    if (!text) {
      // nested multipart: fall back to any decoded chunk that has words
      const any = decoded.find((p) => (p.text || "").trim().length > 40);
      text = any ? stripHtml(any.text) : "";
    }
  } else {
    const dec = decodeTransfer(body, head["content-transfer-encoding"]);
    text = /text\/html/i.test(ctype) ? stripHtml(dec) : dec;
  }
  return {
    from: decodeHeaderWord(head.from || ""),
    subject: decodeHeaderWord(head.subject || "(no subject)"),
    date: head.date || "",
    messageId: (head["message-id"] || "").trim(),
    text: String(text || "").replace(/\r/g, "").trim().slice(0, 12000),
  };
}

// Fetch recent messages. Uses BODY.PEEK so nothing is marked read.
async function fetchRecentMail({ user, pass, sinceDays = 14, limit = 15 }) {
  const c = await imapClient({ host: process.env.IMAP_HOST || "imap.gmail.com", port: Number(process.env.IMAP_PORT) || 993 });
  try {
    await c.cmd(`LOGIN "${user.replace(/"/g, '\\"')}" "${pass.replace(/"/g, '\\"')}"`);
    await c.cmd("SELECT INBOX");
    const since = new Date(Date.now() - sinceDays * 86400000);
    const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][since.getUTCMonth()];
    const sinceStr = `${since.getUTCDate()}-${mon}-${since.getUTCFullYear()}`;
    const searchRes = await c.cmd(`UID SEARCH SINCE ${sinceStr}`);
    const line = (searchRes.match(/^\* SEARCH([^\r\n]*)/m) || [, ""])[1];
    const uids = line.trim().split(/\s+/).filter(Boolean).map(Number).filter((x) => !isNaN(x));
    const take = uids.slice(-limit).reverse();
    const out = [];
    for (const uid of take) {
      try {
        const res = await c.cmd(`UID FETCH ${uid} (BODY.PEEK[])`);
        const lit = res.match(/\{(\d+)\}\r?\n/);
        let raw = "";
        if (lit) {
          const start = res.indexOf(lit[0]) + lit[0].length;
          raw = res.substr(start, Number(lit[1]));
        } else {
          raw = res;
        }
        const msg = parseMessage(Buffer.from(raw, "binary").toString("utf8"));
        out.push({ uid, ...msg });
      } catch (e) { /* skip unreadable message */ }
    }
    return out;
  } finally { c.close(); }
}

// ---- shared Anthropic call ----
async function callClaude({ system, content, model, max_tokens }) {
  const key = anthropicKey();
  if (!key) throw new Error("No Anthropic API key set.");
  const r = await fetch(ANTHROPIC_BASE + "/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: Math.min(Number(max_tokens) || 2000, 8000),
      ...(system ? { system } : {}),
      messages: [{ role: "user", content }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || `Anthropic error ${r.status}`);
  return {
    text: (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim(),
    usage: j.usage || null,
  };
}

function gmailCreds() {
  const user = (process.env.GMAIL_USER || "").trim();
  const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  return user && pass ? { user, pass } : null;
}

const EXTRACT_SYSTEM = [
  "You extract job postings from forwarded emails for a fixed-income sales & trading job search.",
  "Return ONLY a JSON array, no prose and no markdown fences.",
  "Each element: {\"title\": string, \"firm\": string, \"location\": string, \"url\": string, \"summary\": string, \"deadline\": string}.",
  "summary: 2-3 plain sentences covering the desk/product, seniority, and what they want. No marketing language.",
  "Use \"\" for anything genuinely absent — never invent a firm, URL, or location.",
  "One email may contain several distinct roles: return one element per role.",
  "If the email contains no job posting at all, return exactly []."
].join(" ");

async function callClaude({ system, content, model, max_tokens }) {
  const key = anthropicKey();
  if (!key) throw new Error("No Anthropic API key set.");
  const r = await fetch(ANTHROPIC_BASE + "/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: Math.min(Number(max_tokens) || 2000, 8000),
      ...(system ? { system } : {}),
      messages: [{ role: "user", content }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || `Anthropic error ${r.status}`);
  return {
    text: (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim(),
    usage: j.usage || null,
  };
}

// Pull the real job description: Workday's JSON detail API when we have it,
// otherwise the posting page's own HTML.
async function fetchJobDescription({ detailUrl, url }) {
  const ua = { "User-Agent": "Mozilla/5.0 (compatible; DeskTrack/1.0)", Accept: "application/json,text/html" };
  if (detailUrl && /^https:\/\/[\w.-]+\.myworkdayjobs\.com\//i.test(detailUrl)) {
    try {
      const r = await fetch(detailUrl, { headers: ua });
      if (r.ok) {
        const j = await r.json();
        const info = j.jobPostingInfo || {};
        const body = [info.jobDescription || "", info.jobRequisitionLocation && info.jobRequisitionLocation.descriptor || ""].join("\n");
        const text = stripHtml(body);
        if (text.length > 120) return text.slice(0, 18000);
      }
    } catch (e) { /* fall through to the page */ }
  }
  if (url && /^https?:\/\//i.test(url)) {
    try {
      const r = await fetch(url, { headers: ua, redirect: "follow" });
      if (r.ok) {
        const html = await r.text();
        // drop site chrome so we pay tokens for the posting, not the menu
        const body = html
          .replace(/<(nav|header|footer|aside|form|noscript)[\s\S]*?<\/\1>/gi, " ")
          .replace(/<!--[\s\S]*?-->/g, " ");
        const text = stripHtml(body);
        if (text.length > 200) return text.slice(0, 18000);
      }
    } catch (e) { /* nothing more to try */ }
  }
  return "";
}

const JOB_SUMMARY_SYSTEM = [
  "You brief a candidate targeting fixed income sales & trading roles on a job posting.",
  "Output GitHub-flavoured markdown with these sections, in order, omitting any section you have no real information for:",
  "**The role** — 2 to 4 bullets: desk/product, what they'd actually do day to day, seniority, comp if stated.",
  "**They want** — 3 to 5 bullets: required experience, licences, technical skills. Mark anything non-negotiable.",
  "**Worth knowing** — 1 to 3 bullets: location/hybrid, deadlines, team size, anything unusual or a red flag.",
  "Rules: never copy sentences from the posting — compress into your own words.",
  "Keep every bullet under 20 words. No preamble, no closing commentary, no invented details.",
  "If the text provided is not actually a job description, reply exactly: NO_DESCRIPTION"
].join(" ");

// ============ CardDAV (read-only): DESK/TRACK contacts -> Apple Contacts ============
// Apple's Contacts app subscribes to this like any CardDAV account. One address book,
// one-way: DESK/TRACK stays the source of truth, edits made on the phone are refused.
const DAV_ROOT = "/dav/";
const DAV_PRINCIPAL = "/dav/principal/";
const DAV_HOME = "/dav/addressbooks/";
const DAV_BOOK = "/dav/addressbooks/desktrack/";

function davAuthed(req) {
  const h = req.headers["authorization"] || "";
  let pass = "";
  if (h.startsWith("Basic ")) {
    const raw = Buffer.from(h.slice(6).trim(), "base64").toString("utf8");
    const i = raw.indexOf(":");
    pass = i >= 0 ? raw.slice(i + 1) : "";
  } else if (h.startsWith("Bearer ")) {
    pass = h.slice(7);
  }
  const a = Buffer.from(pass.trim()), b = Buffer.from(PASSPHRASE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readRaw(req, limit = 2e6) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > limit) req.destroy(); });
    req.on("end", () => resolve(d));
    req.on("error", () => resolve(""));
  });
}

function xmlEsc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- vCard 3.0 (the version Apple's CardDAV client handles most reliably) ---
function vEsc(s) {
  return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
function vFold(line) {
  // RFC 6350/2426: lines over 75 octets are folded with CRLF + space
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, "utf8") > (out.length ? 74 : 75)) { out.push(cur); cur = ""; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out.join("\r\n ");
}
function cardUid(c) { return "desktrack-" + String(c.id).replace(/[^\w-]/g, ""); }
function cardFile(c) { return cardUid(c) + ".vcf"; }

function contactToVCard(c) {
  const name = String(c.name || "Unnamed").trim();
  const parts = name.split(/\s+/);
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  const first = parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0];
  const L = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "PRODID:-//DESK-TRACK//CardDAV//EN",
    "UID:" + cardUid(c),
    "FN:" + vEsc(name),
    "N:" + [vEsc(last), vEsc(first), "", "", ""].join(";"),
  ];
  if (c.firm) L.push("ORG:" + vEsc(c.firm) + (c.desk ? ";" + vEsc(c.desk) : ""));
  const title = [c.note, !c.firm && c.desk ? c.desk : ""].filter(Boolean).join(" · ");
  if (title) L.push("TITLE:" + vEsc(title));
  if (c.phone) L.push("TEL;TYPE=CELL,VOICE:" + vEsc(c.phone));
  if (c.email) L.push("EMAIL;TYPE=INTERNET,WORK:" + vEsc(String(c.email).trim()));
  if (c.linkedin) {
    const url = /^https?:\/\//i.test(c.linkedin) ? c.linkedin : "https://" + c.linkedin;
    L.push("item1.URL:" + vEsc(url));
    L.push("item1.X-ABLabel:LinkedIn");
  }
  const noteBits = [];
  if (c.referredBy) noteBits.push("Introduced via " + c.referredBy);
  if (c.status) noteBits.push("Status: " + c.status);
  if ((c.tags || []).length) noteBits.push("Tags: " + c.tags.map((t) => "#" + t).join(" "));
  const last3 = (c.log || []).slice(0, 3);
  if (last3.length) {
    noteBits.push("Recent:\n" + last3.map((l) => `${new Date(l.at).toISOString().slice(0, 10)} ${l.text || ""}`).join("\n"));
  }
  if (c.followUpDate) noteBits.push("Follow up " + c.followUpDate);
  noteBits.push("Managed by DESK/TRACK — edit there, not here.");
  L.push("NOTE:" + vEsc(noteBits.join("\n")));
  L.push("CATEGORIES:" + ["DESK/TRACK", ...(c.tags || [])].map(vEsc).join(","));
  const rev = c.lastContacted || c.addedAt || Date.now();
  L.push("REV:" + new Date(rev).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, ""));
  L.push("END:VCARD");
  return L.map(vFold).join("\r\n") + "\r\n";
}

function etagOf(text) {
  return '"' + crypto.createHash("sha1").update(text).digest("hex").slice(0, 20) + '"';
}
function davCards() {
  return (store.contacts || [])
    .filter((c) => c && c.id != null && (c.name || "").trim())
    .map((c) => { const vcard = contactToVCard(c); return { c, file: cardFile(c), vcard, etag: etagOf(vcard) }; });
}
function bookCtag(cards) {
  return etagOf(cards.map((x) => x.file + x.etag).join("|")).replace(/"/g, "");
}

// --- multistatus builders ---
function msResponse(href, props) {
  return `<d:response><d:href>${xmlEsc(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}
function multistatus(responses) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/">${responses.join("")}</d:multistatus>`;
}
const READ_ONLY_PRIVS = "<d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:read-current-user-privilege-set/></d:privilege></d:current-user-privilege-set>";
function principalProps() {
  return `<d:current-user-principal><d:href>${DAV_PRINCIPAL}</d:href></d:current-user-principal>` +
    `<d:principal-URL><d:href>${DAV_PRINCIPAL}</d:href></d:principal-URL>` +
    `<card:addressbook-home-set><d:href>${DAV_HOME}</d:href></card:addressbook-home-set>`;
}
function bookProps(cards) {
  return `<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>` +
    `<d:displayname>DESK/TRACK</d:displayname>` +
    `<card:addressbook-description>Contacts from DESK/TRACK (read-only)</card:addressbook-description>` +
    `<cs:getctag>${bookCtag(cards)}</cs:getctag>` +
    `<card:supported-address-data><card:address-data-type content-type="text/vcard" version="3.0"/></card:supported-address-data>` +
    `<d:supported-report-set>` +
      `<d:supported-report><d:report><card:addressbook-multiget/></d:report></d:supported-report>` +
      `<d:supported-report><d:report><card:addressbook-query/></d:report></d:supported-report>` +
    `</d:supported-report-set>` +
    READ_ONLY_PRIVS +
    `<d:owner><d:href>${DAV_PRINCIPAL}</d:href></d:owner>` +
    `<d:current-user-principal><d:href>${DAV_PRINCIPAL}</d:href></d:current-user-principal>`;
}
function cardProps(x, withData) {
  return `<d:getetag>${xmlEsc(x.etag)}</d:getetag><d:getcontenttype>text/vcard; charset=utf-8</d:getcontenttype>` +
    `<d:resourcetype/>` + (withData ? `<card:address-data>${xmlEsc(x.vcard)}</card:address-data>` : "");
}

function davSend(res, code, body, extra = {}) {
  res.writeHead(code, {
    "Content-Type": "application/xml; charset=utf-8",
    DAV: "1, 3, addressbook",
    ...extra,
  });
  res.end(body || "");
}

// Returns true if it handled the request.
async function handleDav(req, res, p) {
  const isDavPath = p === "/.well-known/carddav" || p === "/dav" || p.startsWith("/dav/");
  const isRootDiscovery = p === "/" && ["PROPFIND", "REPORT"].includes(req.method);
  if (!isDavPath && !isRootDiscovery) return false;

  // Apple checks OPTIONS for the "addressbook" capability before anything else
  if (req.method === "OPTIONS") {
    res.writeHead(200, {
      DAV: "1, 3, addressbook",
      Allow: "OPTIONS, GET, HEAD, PROPFIND, REPORT",
      "Content-Length": "0",
    });
    return res.end(), true;
  }
  if (p === "/.well-known/carddav") {
    res.writeHead(301, { Location: DAV_ROOT });
    return res.end(), true;
  }
  if (!davAuthed(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="DESK/TRACK"', "Content-Type": "text/plain" });
    return res.end("Use your DESK/TRACK passphrase as the password."), true;
  }

  const path = p.endsWith("/") || p.endsWith(".vcf") ? p : p + "/";
  const depth = String(req.headers["depth"] || "0");
  const cards = davCards();

  if (req.method === "PROPFIND") {
    await readRaw(req);
    if (path === "/" || path === DAV_ROOT || path === DAV_PRINCIPAL) {
      const rt = path === DAV_PRINCIPAL ? "<d:resourcetype><d:principal/><d:collection/></d:resourcetype>" : "<d:resourcetype><d:collection/></d:resourcetype>";
      return davSend(res, 207, multistatus([
        msResponse(path, rt + `<d:displayname>DESK/TRACK</d:displayname>` + principalProps()),
      ])), true;
    }
    if (path === DAV_HOME) {
      const out = [msResponse(DAV_HOME, "<d:resourcetype><d:collection/></d:resourcetype>" + principalProps() + READ_ONLY_PRIVS)];
      if (depth !== "0") out.push(msResponse(DAV_BOOK, bookProps(cards)));
      return davSend(res, 207, multistatus(out)), true;
    }
    if (path === DAV_BOOK) {
      const out = [msResponse(DAV_BOOK, bookProps(cards))];
      if (depth !== "0") cards.forEach((x) => out.push(msResponse(DAV_BOOK + x.file, cardProps(x, false))));
      return davSend(res, 207, multistatus(out)), true;
    }
    if (path.startsWith(DAV_BOOK) && path.endsWith(".vcf")) {
      const x = cards.find((y) => DAV_BOOK + y.file === path);
      if (!x) return davSend(res, 404, ""), true;
      return davSend(res, 207, multistatus([msResponse(path, cardProps(x, false))])), true;
    }
    return davSend(res, 404, ""), true;
  }

  if (req.method === "REPORT") {
    const body = await readRaw(req);
    if (path !== DAV_BOOK) return davSend(res, 404, ""), true;
    let pick = cards;
    if (/addressbook-multiget/i.test(body)) {
      const hrefs = [...body.matchAll(/<(?:[\w-]+:)?href[^>]*>\s*([^<\s]+)\s*<\/(?:[\w-]+:)?href>/gi)]
        .map((m) => { try { return decodeURIComponent(m[1]); } catch { return m[1]; } })
        .map((h) => h.replace(/^https?:\/\/[^/]+/i, ""));
      pick = cards.filter((x) => hrefs.includes(DAV_BOOK + x.file));
      const missing = hrefs.filter((h) => !cards.some((x) => DAV_BOOK + x.file === h));
      const out = pick.map((x) => msResponse(DAV_BOOK + x.file, cardProps(x, true)));
      missing.forEach((h) => out.push(`<d:response><d:href>${xmlEsc(h)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`));
      return davSend(res, 207, multistatus(out)), true;
    }
    // addressbook-query (and anything else): return everything
    return davSend(res, 207, multistatus(pick.map((x) => msResponse(DAV_BOOK + x.file, cardProps(x, true))))), true;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    if (path.startsWith(DAV_BOOK) && path.endsWith(".vcf")) {
      const x = cards.find((y) => DAV_BOOK + y.file === path);
      if (!x) { res.writeHead(404); return res.end(), true; }
      res.writeHead(200, { "Content-Type": "text/vcard; charset=utf-8", ETag: x.etag });
      return res.end(req.method === "HEAD" ? "" : x.vcard), true;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("DESK/TRACK CardDAV. Add this server as a CardDAV account in Apple Contacts."), true;
  }

  // PUT / DELETE / MKCOL / PROPPATCH / MOVE / COPY: read-only
  res.writeHead(403, { "Content-Type": "text/plain" });
  return res.end("DESK/TRACK contacts are read-only here. Edit them in the app."), true;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  {
    const u0 = new URL(req.url, "http://x");
    if (await handleDav(req, res, u0.pathname)) return;
  }
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

  if (p === "/api/inbox/status" && req.method === "GET") {
    const c = gmailCreds();
    return send(res, 200, {
      configured: !!c,
      user: c ? c.user : null,
      imported: (store.inboxJobs || []).length,
      aiReady: !!anthropicKey(),
    });
  }

  if (p === "/api/inbox/scan" && req.method === "POST") {
    const creds = gmailCreds();
    if (!creds) return send(res, 400, { error: "Gmail not connected. Set GMAIL_USER and GMAIL_APP_PASSWORD on the backend." });
    if (!anthropicKey()) return send(res, 400, { error: "Set your Anthropic API key first (Letters tab)." });
    const body = await readBody(req);
    const days = Math.min(Math.max(Number(body.days) || 14, 1), 90);
    try {
      const mail = await fetchRecentMail({ user: creds.user, pass: creds.pass, sinceDays: days, limit: 20 });
      const seen = new Set(store.inboxSeen || []);
      const fresh = mail.filter((m) => !seen.has(m.messageId || `uid:${m.uid}`));
      if (!fresh.length) {
        return send(res, 200, { scanned: mail.length, newMail: 0, added: 0, jobs: [] });
      }
      const existing = store.inboxJobs || [];
      const added = [];
      for (const m of fresh) {
        let parsed = [];
        try {
          const r = await callClaude({
            system: EXTRACT_SYSTEM,
            max_tokens: 1500,
            content: [{ type: "text", text: `FROM: ${m.from}\nSUBJECT: ${m.subject}\nDATE: ${m.date}\n\n${m.text}` }],
          });
          const cleaned = r.text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
          parsed = JSON.parse(cleaned);
          if (!Array.isArray(parsed)) parsed = [];
        } catch (e) { parsed = []; }
        parsed.forEach((jb, i) => {
          const title = String(jb.title || "").trim();
          if (!title) return;
          added.push({
            id: `mail-${m.uid}-${i}`,
            title,
            firm: String(jb.firm || "").trim() || "(from email)",
            location: String(jb.location || "").trim() || "—",
            url: String(jb.url || "").trim(),
            summary: String(jb.summary || "").trim(),
            deadline: String(jb.deadline || "").trim(),
            source: "inbox",
            subject: m.subject,
            receivedAt: Date.parse(m.date) || Date.now(),
            addedAt: Date.now(),
          });
        });
        seen.add(m.messageId || `uid:${m.uid}`);
      }
      const byId = new Map(existing.map((j) => [j.id, j]));
      added.forEach((j) => byId.set(j.id, j));
      store.inboxJobs = [...byId.values()].sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 300);
      store.inboxSeen = [...seen].slice(-500);
      beforeWriteBackups();
      persist();
      return send(res, 200, { scanned: mail.length, newMail: fresh.length, added: added.length, jobs: added });
    } catch (e) {
      return send(res, 502, { error: String(e.message || e) });
    }
  }

  if (p === "/api/ai/jobsummary" && req.method === "POST") {
    const body = await readBody(req);
    const id = String(body.id || "").slice(0, 200);
    if (!id) return send(res, 400, { error: "missing job id" });
    const cache = store.jobSummaries || {};
    if (cache[id] && !body.force) return send(res, 200, { ...cache[id], cached: true });
    if (!anthropicKey()) return send(res, 400, { error: "Add your Anthropic API key in the Letters tab first." });
    try {
      let desc = String(body.text || "").trim();
      if (desc.length < 200) {
        const fetched = await fetchJobDescription({ detailUrl: body.detailUrl, url: body.url });
        if (fetched.length > desc.length) desc = fetched;
      }
      if (desc.length < 120) {
        return send(res, 200, {
          summary: "",
          note: "Couldn't read this posting's description automatically — the site blocks it or needs a login. Open the posting to read it.",
          at: Date.now(),
        });
      }
      const head = [body.title, body.firm, body.location].filter(Boolean).join(" · ");
      const r = await callClaude({
        system: JOB_SUMMARY_SYSTEM,
        max_tokens: 1200,
        content: [{ type: "text", text: `POSTING: ${head}\n\n${desc}` }],
      });
      const text = (r.text || "").trim();
      if (!text || /^NO_DESCRIPTION$/i.test(text)) {
        return send(res, 200, { summary: "", note: "That page didn't contain a readable job description.", at: Date.now() });
      }
      const rec = { summary: text, at: Date.now(), usage: r.usage || null };
      cache[id] = rec;
      // keep the cache from growing without bound
      const keys = Object.keys(cache);
      if (keys.length > 400) {
        keys.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0)).slice(0, keys.length - 400).forEach((k) => delete cache[k]);
      }
      store.jobSummaries = cache;
      persist();
      return send(res, 200, { ...rec, cached: false });
    } catch (e) {
      return send(res, 502, { error: String(e.message || e) });
    }
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
  console.log("CardDAV: /dav/ (Apple Contacts, read-only)");
  console.log("Ready.");
});
