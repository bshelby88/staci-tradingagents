import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const k = require("../src/index.js");

/* ---------- 1. Honesty by construction ---------- */
describe("result constructors", () => {
  it("liveResult marks simulated:false and freezes", () => {
    const r = k.liveResult({ decision: "BUY", price: 42 });
    expect(r.simulated).toBe(false);
    expect(Object.isFrozen(r)).toBe(true);
  });

  it("liveResult REFUSES payloads smuggling a simulated key", () => {
    expect(() => k.liveResult({ decision: "BUY", simulated: false })).toThrow();
    expect(() => k.liveResult({ decision: "BUY", simulated: true })).toThrow();
  });

  it("simulatedResult ALWAYS carries the label + disclaimer, uncensorable", () => {
    const r = k.simulatedResult({ decision: "BUY", disclaimer: "haha none" }, "engine down");
    expect(r.simulated).toBe(true);
    expect(r.disclaimer).toMatch(/SIMULATED OUTPUT/);
    expect(r.disclaimer).toMatch(/engine down/);
    expect(Object.isFrozen(r)).toBe(true);
  });

  it("the v1 P0 (unlabeled fake BUY) is unconstructable", () => {
    // The only two ways to produce a result:
    const live = k.liveResult({ decision: "BUY" });
    const sim = k.simulatedResult({ decision: "BUY" });
    // Every result is labeled, one way or the other.
    expect(typeof live.simulated).toBe("boolean");
    expect(sim.simulated).toBe(true);
  });
});

/* ---------- 2. Chain-derived ledger ---------- */
describe("revenueFromChain", () => {
  const treasury = "0x6bDea25c368c32eeCb31054dd4766Fc8125e4e02";

  it("sums USDC transfer logs into the treasury (6 decimals)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({
        result: [
          {
            topics: [
              "0xddf2...",
              "0x000000000000000000000000" + "ab".repeat(20),
              "0x000000000000000000000000" + treasury.slice(2).toLowerCase(),
            ],
            data: "0x" + (250000).toString(16), // 0.25 USDC
            transactionHash: "0xt1",
            blockNumber: "0x10",
          },
          {
            topics: ["0xddf2...", "0x0", "0x0"],
            data: "0x" + (5000000).toString(16), // 5.00 USDC
            transactionHash: "0xt2",
            blockNumber: "0x11",
          },
        ],
      }),
    });
    const out = await k.revenueFromChain({ treasury, rpcUrl: "https://rpc", fetchImpl });
    expect(out.totalUsdc).toBeCloseTo(5.25, 6);
    expect(out.transfers).toHaveLength(2);
    expect(out.transfers[0].txHash).toBe("0xt1");
  });

  it("queries with the treasury as the indexed 'to' topic", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ result: [] }) });
    await k.revenueFromChain({ treasury, rpcUrl: "https://rpc", fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.params[0].address).toBe(k.USDC_BASE);
    expect(body.params[0].topics[2]).toBe(
      "0x000000000000000000000000" + treasury.slice(2).toLowerCase()
    );
  });

  it("surfaces RPC errors loudly instead of returning zero", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({ error: { message: "rate limited" } }),
    });
    await expect(
      k.revenueFromChain({ treasury, rpcUrl: "https://rpc", fetchImpl })
    ).rejects.toThrow(/rate limited/);
  });
});

/* ---------- 3. Receipts / idempotency ---------- */
describe("receipt store", () => {
  it("re-serves a cached delivery for a settled nonce (no double work)", () => {
    const store = k.createReceiptStore();
    const resp = k.liveResult({ answer: 7 });
    store.record("nonce-1", resp, "secret");
    expect(store.lookup("nonce-1").response.answer).toBe(7);
    expect(store.lookup("nonce-2")).toBeNull();
  });

  it("mints receipts that verify, and rejects tampered ones", () => {
    const store = k.createReceiptStore();
    const receipt = store.record("nonce-9", { ok: 1 }, "secret");
    expect(store.verify(receipt, "secret")).toBe(true);
    expect(store.verify({ ...receipt, responseHash: "f".repeat(64) }, "secret")).toBe(false);
    expect(store.verify(receipt, "wrong-secret")).toBe(false);
  });

  it("evicts oldest entries past maxEntries", () => {
    const store = k.createReceiptStore({ maxEntries: 2 });
    store.record("a", { i: 1 }, "s");
    store.record("b", { i: 2 }, "s");
    store.record("c", { i: 3 }, "s");
    expect(store.size()).toBe(2);
    expect(store.lookup("a")).toBeNull();
  });
});

/* ---------- 4. Discovery generation ---------- */
describe("discovery + landing from one routes config", () => {
  const routes = {
    "POST /api/analyze-ticker": {
      accepts: { scheme: "exact", price: "$0.25", network: "eip155:8453", payTo: "0x6bDe" },
      description: "Multi-agent ticker analysis. Not financial advice.",
      mimeType: "application/json",
    },
  };
  const info = { name: "tradingagents", description: "Ticker consensus via x402." };

  it("manifest, openapi, and landing all derive from the same config", () => {
    const { manifest, openapi } = k.buildDiscovery(routes, info);
    expect(manifest.endpoints["/api/analyze-ticker"].accepts.price).toBe("$0.25");
    expect(openapi.paths["/api/analyze-ticker"].post["x-payment"].price).toBe("$0.25");
    const html = k.landingHtml(routes, info, "https://x.fly.dev");
    expect(html).toContain("$0.25");
    expect(html).toContain("/.well-known/x402");
  });

  it("mountService wires the four public endpoints", () => {
    const got = {};
    const app = { get: (p) => (got[p] = true), type: () => ({ send: () => {} }) };
    k.mountService(app, { routes, serviceInfo: info });
    for (const p of ["/.well-known/x402", "/openapi.json", "/health", "/"]) {
      expect(got[p]).toBe(true);
    }
  });
});

/* ---------- 5. Facilitator failover ---------- */
describe("initFacilitators", () => {
  it("falls through to the first facilitator that initializes", async () => {
    const bad = { name: "cdp", initialize: vi.fn().mockRejectedValue(new Error("down")) };
    const good = { name: "x402org", initialize: vi.fn().mockResolvedValue(true) };
    const { active, errors } = await k.initFacilitators([bad, good], { sleep: async () => {} });
    expect(active).toBe(good);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("never throws at boot even if all facilitators are down", async () => {
    const bad = { initialize: vi.fn().mockRejectedValue(new Error("down")) };
    const { active, errors } = await k.initFacilitators([bad], {
      attempts: 2,
      sleep: async () => {},
    });
    expect(active).toBeNull();
    expect(errors).toHaveLength(2);
  });
});
