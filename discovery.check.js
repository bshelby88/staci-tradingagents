"use strict";
// Dependency-free unit check for public-discovery.js: fake the express app,
// capture handlers, invoke with mock req/res, assert content invariants.
const assert = require("assert");
const { registerPublicDiscovery } = require("./public-discovery");

const routes = {
  "POST /api/analyze-ticker": {
    accepts: { scheme: "exact", price: "$0.25", network: "eip155:84532", payTo: "0x9b8a2786a3df7a7837ccfc4e792e9eb90a36f72f" },
    description: "structured BUY/HOLD/SELL", mimeType: "application/json",
  },
};
const serviceInfo = { name: "tradingagents", description: "Pay $0.25 USDC on Base, POST /api/analyze-ticker." };

const handlers = {};
const app = { get: (p, fn) => { handlers[p] = fn; } };
registerPublicDiscovery(app, {
  routes, serviceInfo, network: "eip155:84532",
  payTo: "0x9b8a2786a3df7a7837ccfc4e792e9eb90a36f72f",
  manifest: () => ({ version: "2.0.0", endpoints: Object.keys(routes) }),
});

assert.deepStrictEqual(Object.keys(handlers).sort(), ["/llms.txt", "/pricing.md", "/x402.json"]);

function call(path, req, res) { handlers[path](req, res); return res; }
function mockRes() {
  const r = { body: null, type(v) { this.ctype = v; return this; }, send(b) { this.body = b; return this; }, json(j) { this.body = j; return this; }, status(c) { this.code = c; return this; }, redirect() { this.redirected = true; return this; } };
  return r;
}
const req = { headers: { host: "staci-tradingagents.fly.dev" } };

const llms = call("/llms.txt", req, mockRes()).body;
assert.ok(llms.includes("# tradingagents"));
assert.ok(llms.includes("POST https://staci-tradingagents.fly.dev/api/analyze-ticker: $0.25"));
assert.ok(llms.includes("eip155:84532"));
assert.ok(llms.includes("0x9b8a2786a3df7a7837ccfc4e792e9eb90a36f72f"));
const pricing = call("/pricing.md", req, mockRes()).body;
assert.ok(pricing.includes("**$0.25 USDC per request**") || pricing.includes("$0.25 USDC"));
assert.ok(pricing.includes("`POST /api/analyze-ticker`"));
const alias = call("/x402.json", req, mockRes()).body;
assert.strictEqual(alias.version, "2.0.0");

console.log("DISCOVERY UNIT CHECKS: ALL PASS");
