"use strict";

// EXEC-22 machine-readable surfaces for staci/tradingagents.
// Reads the SAME runtime constants (PRICE/PAY_TO/NETWORK) that build the live
// 402 challenge, so the published surface cannot drift from the payment
// contract. Resolves base URL per request host / FLY_APP_NAME.

function registerPublicDiscovery(app, config) {
  function baseUrlOf(req) {
    if (process.env.FLY_APP_NAME) return `https://${process.env.FLY_APP_NAME}.fly.dev`;
    const host = req.headers.host;
    return host ? `https://${host}` : "";
  }
  function networkLabel(network) {
    if (network === "eip155:8453") return "Base mainnet (eip155:8453)";
    if (network === "eip155:84532") return "Base Sepolia (eip155:84532)";
    return network;
  }

  app.get("/llms.txt", (req, res) => {
    const baseUrl = baseUrlOf(req);
    const lines = [
      `# ${config.serviceInfo.name}`,
      "",
      `> ${config.serviceInfo.description}`,
      "",
      "Paid endpoints (x402, USDC, pay-per-call, no API key):",
      ...Object.entries(config.routes).map(([key, route]) => {
        const [method, p] = key.split(" ");
        return `- ${method} ${baseUrl}${p}: ${route.accepts.price} USDC — ${route.description}`;
      }),
      `- Payment network: ${networkLabel(config.network)}, USDC via x402`,
      `- Payout wallet: ${config.payTo}`,
      "- Intended users: agents evaluating the x402 response shape for ticker consensus payloads",
      "",
      "To call: send the request without payment, read the 402 `payment-required` header (base64 x402 v2 challenge), sign a USDC transfer for the exact amount to the challenge payTo, re-send with the payment signature header.",
      `Machine contract: ${baseUrl}/openapi.json and ${baseUrl}/.well-known/x402.json.`,
      "Not financial advice.",
    ];
    res.type("text/plain").send(`${lines.join("\n")}\n`);
  });

  app.get("/pricing.md", (req, res) => {
    const baseUrl = baseUrlOf(req);
    const lines = [
      `# Pricing — ${config.serviceInfo.name}`,
      "",
      "- Billing: pay per request; no account or subscription",
      `- Network: ${networkLabel(config.network)} via x402`,
      `- Payout wallet: ${config.payTo}`,
      ...Object.entries(config.routes).map(([key, route]) => {
        const [method, p] = key.split(" ");
        return `- Paid endpoint: \`${method} ${p}\` — **${route.accepts.price} USDC** (${route.description})`;
      }),
      `- Live payment requirements: [x402 manifest](${baseUrl}/.well-known/x402.json)`,
      "",
      "The live x402 payment challenge is authoritative if the configured price changes.",
      "",
      "> Not financial advice.",
    ];
    res.type("text/markdown").send(`${lines.join("\n")}\n`);
  });

  // Root-path manifest alias (EXEC-22 acceptance: 200 on /x402.json).
  app.get("/x402.json", (req, res) => {
    if (typeof config.manifest === "function") return res.json(config.manifest());
    return res.redirect(307, "/.well-known/x402.json");
  });
}

module.exports = { registerPublicDiscovery };
