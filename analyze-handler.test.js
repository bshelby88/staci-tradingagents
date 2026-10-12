"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createAnalyzeHandler } = require("./analyze-handler");
const k = require("./kernel/src");

function run(runAnalyze, body = { ticker: "AAPL" }) {
  const recorded = [];
  const receipts = { lookup: () => null, record: (...a) => { recorded.push(a); return "rcpt"; } };
  const h = createAnalyzeHandler({ runAnalyze, k, receipts, receiptSecret: "s" });
  const out = { status: 200, body: undefined };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  const req = { body, get: (n) => (n === "PAYMENT-SIGNATURE" ? "sig" : "") };
  return h(req, res).then(() => ({ ...out, recorded }));
}
const quiet = (fn) => async () => { const e = console.error; console.error = () => {}; try { await fn(); } finally { console.error = e; } };

test("engine failure -> 503, no simulated fallback, no receipt", quiet(async () => {
  const o = await run(async () => { throw new Error("tradingagents import failed"); });
  assert.equal(o.status, 503);
  assert.equal(o.body.ok, false);
  assert.equal(o.body.delivered, false);
  assert.equal(o.body.decision, undefined);
  assert.equal(o.recorded.length, 0);
}));

test("analyzer simulated payload -> 503", async () => {
  const o = await run(async () => ({ ticker: "AAPL", decision: "BUY", simulated: true }));
  assert.equal(o.status, 503);
  assert.equal(o.body.decision, undefined);
});

test("analyzer {error} payload -> 503", async () => {
  assert.equal((await run(async () => ({ error: "x" }))).status, 503);
});

test("live payload -> 200, simulated:false, receipt recorded", async () => {
  const o = await run(async () => ({ ticker: "AAPL", decision: "HOLD", confidence: "medium" }));
  assert.equal(o.status, 200);
  assert.equal(o.body.ok, true);
  assert.equal(o.body.simulated, false);
  assert.equal(o.recorded.length, 1);
});

test("bad ticker stays 400", async () => {
  assert.equal((await run(async () => ({}), { ticker: "bad ticker!" })).status, 400);
});
