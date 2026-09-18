/*
 * @staci/kernel — x402-kernel
 * ---------------------------------------------------------------
 * The shared middleware every Staci service is built on. Encodes the
 * v1 postmortem as architecture:
 *   1. HONESTY BY CONSTRUCTION — there is no code path that returns
 *      simulated output unlabeled. Two constructors, period.
 *   2. LEDGER = THE CHAIN — revenue is read from Base, never written
 *      by services. Fake revenue events are impossible.
 *   3. DEPLOY TRAP IMPOSSIBLE — landing page + discovery manifest +
 *      OpenAPI are all generated from one routes config in git.
 *   4. RECEIPT-BACKED IDEMPOTENCY — a settled payment nonce maps to a
 *      delivered response; retries re-serve, never re-charge.
 *   5. MULTI-FACILITATOR FAILOVER — no single-facilitator dependency.
 */
"use strict";

const crypto = require("node:crypto");

/* ------------------------------------------------------------------ *
 * 1. HONESTY BY CONSTRUCTION
 * ------------------------------------------------------------------ */

/** A result computed by real work against real inputs. Throws if the
 *  payload tries to smuggle a simulated flag — live means live. */
function liveResult(data) {
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError("liveResult requires a plain object payload");
  }
  if ("simulated" in data) {
    throw new TypeError(
      "liveResult payload may not carry a 'simulated' key; use simulatedResult()"
    );
  }
  return Object.freeze({ ...data, simulated: false });
}

/** A simulated/mock/degraded result. The label and disclaimer are
 *  injected here and cannot be omitted or overridden by the caller. */
function simulatedResult(data, reason) {
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError("simulatedResult requires a plain object payload");
  }
  return Object.freeze({
    ...data,
    simulated: true,
    disclaimer:
      "SIMULATED OUTPUT — no live analysis or real data was produced. " +
      (reason ? `Reason: ${String(reason).slice(0, 200)}. ` : "") +
      "Not financial advice.",
  });
}

/* ------------------------------------------------------------------ *
 * 2. LEDGER = THE CHAIN
 *    Revenue is derived by querying Base for USDC Transfer events into
 *    the treasury. Services never write revenue; they can only earn it.
 * ------------------------------------------------------------------ */

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base mainnet
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function pad32(addr) {
  return "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/**
 * Query Base JSON-RPC for USDC transfers into `treasury` between blocks.
 * Returns { totalUsdc, transfers: [{ from, txHash, usdc, blockNumber }] }.
 * This function READS the chain; nothing in the kernel can write revenue.
 */
async function revenueFromChain({
  treasury,
  rpcUrl,
  fromBlock = "0x0",
  toBlock = "latest",
  fetchImpl = fetch,
}) {
  if (!treasury) throw new TypeError("treasury address required");
  if (!rpcUrl) throw new TypeError("rpcUrl required");
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [
        {
          address: USDC_BASE,
          topics: [TRANSFER_TOPIC, null, pad32(treasury)],
          fromBlock,
          toBlock,
        },
      ],
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`rpc error: ${body.error.message || "unknown"}`);
  const logs = Array.isArray(body.result) ? body.result : [];
  const transfers = logs.map((l) => ({
    from: "0x" + String(l.topics[1] || "").slice(-40),
    txHash: l.transactionHash,
    blockNumber: parseInt(l.blockNumber, 16),
    usdc: Number(BigInt(l.data || "0x0")) / 1e6, // USDC has 6 decimals
  }));
  const totalUsdc = transfers.reduce((s, t) => s + t.usdc, 0);
  return { totalUsdc, transfers };
}

/* ------------------------------------------------------------------ *
 * 3. DISCOVERY / LANDING GENERATION — one routes config, in git,
 *    produces the x402 manifest, the OpenAPI spec, and the landing
 *    page. There is no hand-written HTML to strand in a Fly image.
 * ------------------------------------------------------------------ */

function buildDiscovery(routes, serviceInfo) {
  const manifest = {
    version: "2.0.0",
    service: {
      name: serviceInfo.name,
      description: serviceInfo.description,
      contact: serviceInfo.contact || "jadedfocus@gmail.com",
      operator: serviceInfo.operator || "Royal Agentic Enterprises",
    },
    endpoints: {},
  };
  const openapi = {
    openapi: "3.0.0",
    info: {
      title: serviceInfo.title || serviceInfo.name,
      description: serviceInfo.description,
      version: "1.0.0",
      contact: { email: serviceInfo.contact || "jadedfocus@gmail.com" },
    },
    paths: {},
  };
  for (const [routeKey, cfg] of Object.entries(routes)) {
    const parts = routeKey.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const [method, path] = [parts[0].toLowerCase(), parts[1]];
    manifest.endpoints[path] = {
      method: method.toUpperCase(),
      accepts: cfg.accepts,
      description: cfg.description,
      mimeType: cfg.mimeType,
    };
    openapi.paths[path] = openapi.paths[path] || {};
    openapi.paths[path][method] = {
      summary: cfg.description ? cfg.description.split(".")[0] : `Endpoint ${path}`,
      description: cfg.description,
      "x-payment": cfg.accepts,
      responses: {
        200: { description: "Successful response" },
        402: { description: "Payment Required" },
      },
    };
  }
  return { manifest, openapi };
}

function landingHtml(routes, serviceInfo, origin) {
  const first = Object.values(routes)[0] || {};
  const price = first.accepts && first.accepts.price ? first.accepts.price : "";
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const endpoints = Object.keys(buildDiscovery(routes, serviceInfo).manifest.endpoints)
    .map((p) => `<li><code>${esc(p)}</code></li>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(serviceInfo.title || serviceInfo.name)}</title>
<meta name="description" content="${esc(serviceInfo.description)}">
<link rel="alternate" type="application/json" href="/.well-known/x402" title="x402 discovery">
<link rel="alternate" type="application/json" href="/openapi.json" title="OpenAPI 3.0">
<style>body{margin:0;font:16px/1.6 ui-sans-serif,system-ui,sans-serif;background:#141210;color:#d6cfc4}
main{max-width:720px;margin:0 auto;padding:48px 24px}h1{color:#f3ede4}
.price{color:#d9b36a;font-weight:700}code{background:#1b1815;padding:1px 6px;border-radius:4px}
a{color:#e0555f}</style></head><body><main>
<h1>${esc(serviceInfo.title || serviceInfo.name)}</h1>
<p>${esc(serviceInfo.description)}</p>
${price ? `<p>Price: <span class="price">${esc(price)} USDC</span> on Base via x402.</p>` : ""}
<ul>${endpoints}</ul>
<p><a href="/.well-known/x402">x402 manifest</a> · <a href="/openapi.json">OpenAPI</a> · <a href="/health">Health</a></p>
<p style="opacity:.7">Operator: ${esc(serviceInfo.operator || "Royal Agentic Enterprises")}. Not financial advice.</p>
</main></body></html>`;
}

/* ------------------------------------------------------------------ *
 * 4. RECEIPT-BACKED IDEMPOTENCY
 * ------------------------------------------------------------------ */

function createReceiptStore({ maxEntries = 5000 } = {}) {
  const map = new Map(); // paymentNonce -> { responseHash, response, receipt, ts }
  return {
    /** Look up a settled payment nonce. Returns the cached delivery or null. */
    lookup(nonce) {
      return map.get(nonce) || null;
    },
    /** Record a delivery against a payment nonce and mint a signed-shape receipt. */
    record(nonce, response, secret) {
      const responseJson = JSON.stringify(response);
      const responseHash = crypto.createHash("sha256").update(responseJson).digest("hex");
      const receipt = {
        paymentNonce: nonce,
        responseHash,
        deliveredAt: new Date().toISOString(),
        hmac: crypto
          .createHmac("sha256", secret || "staci-dev")
          .update(nonce + responseHash)
          .digest("hex"),
      };
      map.set(nonce, { responseHash, response, receipt, ts: Date.now() });
      if (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
      }
      return receipt;
    },
    /** Verify a receipt someone presents. */
    verify(receipt, secret) {
      if (!receipt || !receipt.paymentNonce || !receipt.responseHash) return false;
      const expect = crypto
        .createHmac("sha256", secret || "staci-dev")
        .update(receipt.paymentNonce + receipt.responseHash)
        .digest("hex");
      return crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(String(receipt.hmac || "")));
    },
    size() {
      return map.size;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 5. MULTI-FACILITATOR FAILOVER
 *    initFacilitators tries each candidate in order with retry/backoff;
 *    resolves with the first that initializes. Boot never crashes.
 * ------------------------------------------------------------------ */

async function initFacilitators(candidates, { attempts = 4, baseDelayMs = 500, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const errors = [];
  for (let round = 1; round <= attempts; round++) {
    for (const c of candidates) {
      try {
        await c.initialize();
        return { active: c, errors };
      } catch (e) {
        errors.push(`${c.name || "facilitator"} round ${round}: ${e.message}`);
      }
    }
    await wait(Math.min(baseDelayMs * round, 8000));
  }
  return { active: null, errors }; // lazy init on first paid request; never crash boot
}

/* ------------------------------------------------------------------ *
 * 6. SERVICE MOUNTING — the ~20 lines every service shares
 * ------------------------------------------------------------------ */

function mountService(app, { routes, serviceInfo }) {
  const { manifest, openapi } = buildDiscovery(routes, serviceInfo);
  app.get("/.well-known/x402", (_req, res) => res.json(manifest));
  app.get("/.well-known/x402.json", (_req, res) => res.json(manifest));
  app.get("/openapi.json", (_req, res) => res.json(openapi));
  app.get("/health", (_req, res) =>
    res.json({ status: "ok", service: serviceInfo.name, ts: new Date().toISOString() })
  );
  app.get("/", (req, res) =>
    res
      .type("html")
      .send(landingHtml(routes, serviceInfo, `${req.protocol}://${req.get("host")}`))
  );
  return { manifest, openapi };
}

module.exports = {
  liveResult,
  simulatedResult,
  revenueFromChain,
  buildDiscovery,
  landingHtml,
  createReceiptStore,
  initFacilitators,
  mountService,
  USDC_BASE,
};
