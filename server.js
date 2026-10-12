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
  description: `Pay ${PRICE} USDC on Base, POST /api/analyze-ticker, receive a structured BUY/HOLD/SELL with per-agent reports. Not financial advice.`,
};
const routes = {
  "POST /api/analyze-ticker": {
    accepts: { scheme: "exact", price: PRICE, network: NETWORK, payTo: PAY_TO, extra: { facilitator: "https://raen-facilitator.fly.dev/facilitator" } },
    description: serviceInfo.description,
    mimeType: "application/json",
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
