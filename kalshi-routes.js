// ─────────────────────────────────────────────────────────────
//  KALSHI OPEN DESK — add-on routes for the DESK/TRACK server
//  Paste into server.js (or `require`/import this file and call
//  mountKalshi(app)). Needs Node 18+ (built-in fetch) — Render
//  default runtimes qualify. No new dependencies, no new disk.
// ─────────────────────────────────────────────────────────────

const path = require("path");

const KALSHI_BASES = {
  demo: "https://external-api.demo.kalshi.co",
  prod: "https://external-api.kalshi.com",
};

function mountKalshi(app) {
  // 1) Serve the app itself at /kalshi
  //    (put kalshi.html next to server.js, same folder as index.html)
  app.get("/kalshi", (_req, res) => {
    res.sendFile(path.join(__dirname, "kalshi.html"));
  });

  // 2) CORS-free proxy for Kalshi API calls.
  //    The browser signs the request (RSA-PSS) and sends the three
  //    KALSHI-ACCESS-* headers here; we forward them verbatim to
  //    Kalshi. The signature covers timestamp+method+path, so the
  //    path after /kalshi-api must match what was signed — it does,
  //    because we strip only our own prefix.
  //    NOTE: this server never sees your private key — only the
  //    already-signed headers, which are valid for one request path
  //    at one timestamp.
  app.all(/^\/kalshi-api\/(demo|prod)\/(.*)/, async (req, res) => {
    try {
      const env = req.params[0];
      const upstreamPath = "/" + req.params[1]; // e.g. /trade-api/v2/portfolio/balance
      const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      const url = KALSHI_BASES[env] + upstreamPath + qs;

      const headers = { "Content-Type": "application/json" };
      for (const h of ["kalshi-access-key", "kalshi-access-timestamp", "kalshi-access-signature"]) {
        if (req.headers[h]) headers[h] = req.headers[h];
      }

      const init = { method: req.method, headers };
      if (!["GET", "HEAD"].includes(req.method)) {
        init.body = JSON.stringify(req.body ?? {});
      }

      const upstream = await fetch(url, init);
      const text = await upstream.text();
      res.status(upstream.status).type("application/json").send(text);
    } catch (err) {
      res.status(502).json({ error: { message: "Kalshi proxy error: " + err.message } });
    }
  });

  // 3) ES futures + prior SPX close for the gap panel (no key needed).
  //    Yahoo Finance chart endpoint: ES=F (front-month e-mini) and ^GSPC.
  app.get("/kalshi-futures", async (_req, res) => {
    try {
      const yh = async (sym) => {
        const r = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1m`,
          { headers: { "User-Agent": "Mozilla/5.0" } }
        );
        const j = await r.json();
        const meta = j?.chart?.result?.[0]?.meta || {};
        return {
          price: meta.regularMarketPrice ?? null,
          prevClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
        };
      };
      const [es, spx] = await Promise.all([yh("ES=F"), yh("^GSPC")]);
      res.json({
        esFuture: es.price,
        spxPriorClose: spx.prevClose ?? spx.price,
        impliedOpen: es.price, // simple: use ES as the implied level; refine with fair value if you want
        asOf: new Date().toISOString(),
      });
    } catch (err) {
      res.status(502).json({ error: { message: "Futures fetch error: " + err.message } });
    }
  });
}

module.exports = { mountKalshi };

// If pasting directly into server.js instead of requiring this file:
//   const { mountKalshi } = require("./kalshi-routes");
//   mountKalshi(app);            // after app = express() and app.use(express.json())
// Make sure express.json() middleware is active (DESK/TRACK already uses it).
