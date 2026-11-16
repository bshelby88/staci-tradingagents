/* tradingagents on @staci/kernel — the whole service in ~80 lines. */
"use strict";
const express = require("express");
const { spawn } = require("node:child_process");
const { paymentMiddleware } = require("@x402/express");
const { x402ResourceServer, HTTPFacilitatorClient } = require("@x402/core/server");
const { ExactEvmScheme } = require("@x402/evm/exact/server");
const k = require("@staci/kernel");
const { createAnalyzeHandler } = require("./analyze-handler");
const NETWORK = process.env.X402_NETWORK || "eip155:84532";

const PAY_TO = process.env.X402_PAY_TO; // charter R2: treasury, not operational
if (!PAY_TO) { console.error("FATAL: X402_PAY_TO required"); process.exit(1); }
const PRICE = process.env.X402_PRICE ? `$${(Number(process.env.X402_PRICE) / 1e6).toFixed(2)}` : "$0.25";

const RECEIPT_SECRET = process.env.RECEIPT_SECRET || "staci-dev";

const candidates = [];
candidates.push(Object.assign(new HTTPFacilitatorClient({ url: "https://raen-facilitator.fly.dev/facilitator" }), { name: "x402org" }));
if (process.env.X402_CDP_ENABLED === "true") {
  const { facilitator } = require("@coinbase/x402");
  candidates.push(Object.assign(new HTTPFacilitatorClient(facilitator), { name: "cdp" }));
}


const x402Server = new x402ResourceServer(candidates[0]);
x402Server.register(NETWORK, new ExactEvmScheme());
k.initFacilitators([x402Server]).then(({ active, errors }) => {
  if (!active) console.warn("facilitators cold at boot (lazy init):", errors.slice(-1));
});

const serviceInfo = {
  name: "tradingagents",
  title: "TradingAgents x402 — multi-agent ticker consensus",
  description: `Pay ${PRICE} USDC on Base, POST /api/analyze-ticker, receive a structured BUY/HOLD/SELL with per-agent reports. OUTPUT QUALITY (current deployment): the analysis engine is NOT installed in this container — every response is SIMULATED (response carries simulated:true + a reason field): the decision defaults to HOLD and each per-agent report is marked "simulated — no market data analyzed". You are paying for the pipeline shape + verifiable receipt, not live market analysis. Not financial advice.`,
};
const routes = {
  "POST /api/analyze-ticker": {
    accepts: { scheme: "exact", price: PRICE, network: NETWORK, payTo: PAY_TO, extra: { facilitator: "https://raen-facilitator.fly.dev/facilitator" } },
    description: serviceInfo.description,
    mimeType: "application/json",
    requestBody: {
      type: "object",
      properties: { ticker: { type: "string", description: "Stock ticker symbol, e.g. AAPL" } },
      required: ["ticker"],
    },
  },
};

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
const { manifest: discoveryManifest } = k.mountService(app, { routes, serviceInfo });
// EXEC-22: machine-readable surfaces from the SAME runtime constants that
// build the live 402 challenge (routes/serviceInfo/NETWORK/PAY_TO).
require("./public-discovery").registerPublicDiscovery(app, {
  routes, serviceInfo, network: NETWORK, payTo: PAY_TO,
  manifest: () => discoveryManifest,
});
// [QUOTE-FIX] Port of royal-ruby a22a1d3: decode the payment-required header into
// every 402 body (the lib sends an empty `{}` body; trust checkers read the body).
app.use((req, res, next) => {
  const origEnd = res.end.bind(res);
  res.end = function (chunk, encoding, cb) {
    if (res.statusCode === 402) {
      const text = chunk == null ? "" : String(chunk).trim();
      const hasBody = text !== "" && text !== "{}";
      const tok = res.getHeader("payment-required");
      if (!hasBody && tok) {
        try {
          let b64 = String(tok).replace(/-/g, "+").replace(/_/g, "/");
          while (b64.length % 4) b64 += "=";
          const challenge = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
          const body = JSON.stringify(challenge);
          if (!res.headersSent) {
            if (!res.getHeader("content-type")) res.setHeader("content-type", "application/json");
            const cl = res.getHeader("content-length");
            if (cl) res.setHeader("content-length", Buffer.byteLength(body));
          }
          chunk = body;
          if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
          else if (typeof chunk === "string" && encoding == null) encoding = "utf8";
        } catch (_) { /* keep original body on any decode failure */ }
      }
    }
    return origEnd(chunk, encoding, cb);
  };
  next();
});

// [402-INSTRUCTIONS] Bean 2026-11-15 (TEN-PLANS Plan 1): every 402 body must tell
// the buyer how to complete the settle -> retry -> claim flow. Root cause: the only
// external payer settled on-chain and never retried - the 402 body told them nothing.
// Registered BEFORE paymentMiddleware (and after the quote-fix header-decode wrapper)
// so this res.end hook runs LAST on every 402, incl. the middleware's own emission.
const PAYMENT_INSTRUCTIONS_402 = {
  step_1: "Settle on-chain: send the exact USDC amount to payTo on eip155:8453 (EIP-3009 transferWithAuthorization, x402 'exact' scheme).",
  step_2: "REPEAT your original request with header 'x-payment' set to the base64 settlement payload from your x402 client. You will then receive the paid response.",
  already_settled: "If you already settled on-chain but never got your result, claim it at https://settlement-collector.fly.dev/storefront/claims with your tx hash.",
  docs: "https://bshelby88.github.io/x402-cookbook/",
};
app.use((req, res, next) => {
  const origEnd = res.end.bind(res);
  res.end = function (chunk, encoding, cb) {
    if (res.statusCode === 402) {
      try {
        let text = chunk == null ? "" : String(chunk).trim();
        const tok = res.getHeader("payment-required");
        if ((text === "" || text === "{}") && tok) {
          let b64 = String(tok).replace(/-/g, "+").replace(/_/g, "/");
          while (b64.length % 4) b64 += "=";
          text = JSON.stringify(JSON.parse(Buffer.from(b64, "base64").toString("utf8")));
        }
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && !parsed.payment_instructions) {
          parsed.payment_instructions = PAYMENT_INSTRUCTIONS_402;
          const body = JSON.stringify(parsed);
          if (!res.headersSent) {
            if (!res.getHeader("content-type")) res.setHeader("content-type", "application/json");
            const cl = res.getHeader("content-length");
            if (cl) res.setHeader("content-length", Buffer.byteLength(body));
          }
          chunk = body;
          if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
          else if (encoding == null) encoding = "utf8";
        }
      } catch (_) { /* non-JSON or headerless 402: leave untouched */ }
    }
    return origEnd(chunk, encoding, cb);
  };
  next();
});

// [QUOTE-FIX] GET on the paid route returns a machine-readable quote, not 404 HTML.
app.get("/api/analyze-ticker", (_req, res) => {
  res.status(402).json({
    ok: false,
    error: "This x402 resource is paid and read via POST.",
    quote: { method: "POST", path: "/api/analyze-ticker", scheme: "exact", price: `${PRICE} USDC`, asset: "USDC", network: NETWORK, payTo: PAY_TO },
    how_to_pay: "POST JSON {ticker} WITHOUT payment to receive the 402 challenge (payment-required header AND body), then resend with the PAYMENT-SIGNATURE header (x402 scheme 'exact').",
    manifest: "/.well-known/x402.json",
    note: "OUTPUT QUALITY (current): engine not installed in this deployment — every response is SIMULATED (simulated:true, decision defaults to HOLD, per-agent reports marked 'simulated'). Not live market analysis. Not financial advice.",
  });
});

app.use(paymentMiddleware(routes, x402Server, undefined, undefined, false));

const receipts = k.createReceiptStore();
app.get("/api/receipts/verify", (req, res) => {
  try { res.json({ valid: receipts.verify(JSON.parse(req.query.receipt || "{}"), RECEIPT_SECRET) }); }
  catch { res.json({ valid: false }); }
});

function runAnalyze({ ticker, date }) {
  return new Promise((resolve, reject) => {
    const args = ["analyze.py", "--ticker", ticker];
    if (date) args.push("--date", date);
    const child = spawn(process.env.PYTHON_BIN || "python3", args, { cwd: __dirname });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("timeout")); }, Number(process.env.ANALYSIS_TIMEOUT_MS || 90000));
    child.on("close", (code) => {
      clearTimeout(t);
      const line = out.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
      if (code !== 0 || !line) return reject(new Error(`analyzer exit ${code}: ${err.slice(-500)}`));
      try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
    });
  });
}

app.post("/api/analyze-ticker", createAnalyzeHandler({ runAnalyze, k, receipts, receiptSecret: RECEIPT_SECRET }));

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`staci/tradingagents on :${PORT} (${NETWORK}, ${PRICE})`));
