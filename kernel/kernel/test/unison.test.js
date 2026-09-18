import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const u = require("../src/unison.js");

const { FIELDS } = u;

/** In-memory fake of the Airtable bridge — same interface, no network. */
function fakeBridge(initialNotes = "", initialStatus = "queued") {
  const rec = { fields: { [FIELDS.notes]: initialNotes, [FIELDS.status]: initialStatus } };
  return {
    rec,
    async get() {
      return JSON.parse(JSON.stringify(rec));
    },
    async update(_id, fields) {
      Object.assign(rec.fields, fields);
      return JSON.parse(JSON.stringify(rec));
    },
  };
}

describe("envelope", () => {
  it("round-trips through the notes field without clobbering prose", () => {
    const notes = "Charter ref blah blah.\nHuman context here.";
    const withEnv = u.writeEnvelope(notes, { claimed_by: "staci" });
    expect(withEnv).toContain("Human context here.");
    expect(u.parseEnvelope(withEnv)).toEqual({ claimed_by: "staci" });
    const updated = u.writeEnvelope(withEnv, { claimed_by: "nimbus" });
    expect(u.parseEnvelope(updated).claimed_by).toBe("nimbus");
    expect((updated.match(/\[UNISON\]/g) || []).length).toBe(1); // replaced, not appended
  });
});

describe("U2 — claim/lease: no double work", () => {
  it("first claimant wins; second is refused while lease is live", async () => {
    const b = fakeBridge();
    const t0 = 1_000_000;
    const r1 = await u.claimTask(b, "rec1", "staci", { now: () => t0 });
    expect(r1.claimed).toBe(true);
    const r2 = await u.claimTask(b, "rec1", "nimbus", { now: () => t0 + 60_000 });
    expect(r2.claimed).toBe(false);
    expect(r2.holder).toBe("staci");
  });

  it("an EXPIRED lease can be taken over — dead executors never wedge the queue", async () => {
    const b = fakeBridge();
    const t0 = 1_000_000;
    await u.claimTask(b, "rec1", "nimbus", { leaseMs: 1000, now: () => t0 });
    const takeover = await u.claimTask(b, "rec1", "staci", { now: () => t0 + 5000 });
    expect(takeover.claimed).toBe(true);
    expect(takeover.holder).toBe("staci");
  });

  it("renewLease extends only for the holder", async () => {
    const b = fakeBridge();
    const t0 = 1_000_000;
    await u.claimTask(b, "rec1", "staci", { now: () => t0 });
    const ok = await u.renewLease(b, "rec1", "staci", { leaseMs: 9999, now: () => t0 + 100 });
    expect(ok.renewed).toBe(true);
    const no = await u.renewLease(b, "rec1", "nimbus", { now: () => t0 + 100 });
    expect(no.renewed).toBe(false);
  });
});

describe("U3 — builder ≠ verifier", () => {
  it("completeTask requires the claim + a real URL and stops at 'deploying'", async () => {
    const b = fakeBridge();
    await u.claimTask(b, "rec1", "staci", { now: () => 1 });
    await expect(u.completeTask(b, "rec1", "staci", "not-a-url")).rejects.toThrow(/verification URL/);
    await expect(u.completeTask(b, "rec1", "nimbus", "https://x.fly.dev/health")).rejects.toThrow(/claim/);
    const done = await u.completeTask(b, "rec1", "staci", "https://x.fly.dev/health");
    expect(done.status).toBe("deploying");
    expect(b.rec.fields[FIELDS.status]).toBe("deploying"); // NOT done
  });

  it("the builder is structurally barred from verifying their own work", async () => {
    const b = fakeBridge();
    await u.claimTask(b, "rec1", "staci", { now: () => 1 });
    await u.completeTask(b, "rec1", "staci", "https://x.fly.dev/health");
    await expect(u.verifyTask(b, "rec1", "staci")).rejects.toThrow(/may not verify their own/);
  });

  it("verification flips 'done' ONLY on a real 2xx fetch of the evidence", async () => {
    const b = fakeBridge();
    await u.claimTask(b, "rec1", "staci", { now: () => 1 });
    await u.completeTask(b, "rec1", "staci", "https://x.fly.dev/health");

    const ok = await u.verifyTask(b, "rec1", "nimbus", {
      fetchImpl: vi.fn().mockResolvedValue({ status: 200 }),
    });
    expect(ok.done).toBe(true);
    expect(b.rec.fields[FIELDS.status]).toBe("done");
    expect(u.parseEnvelope(b.rec.fields[FIELDS.notes]).verified_by).toBe("nimbus");
  });

  it("a dead evidence URL bounces the task back to 'building' — false-done is impossible", async () => {
    const b = fakeBridge();
    await u.claimTask(b, "rec1", "staci", { now: () => 1 });
    await u.completeTask(b, "rec1", "staci", "https://x.fly.dev/health");
    const bad = await u.verifyTask(b, "rec1", "nimbus", {
      fetchImpl: vi.fn().mockResolvedValue({ status: 503 }),
    });
    expect(bad.done).toBe(false);
    expect(b.rec.fields[FIELDS.status]).toBe("building");
  });
});

describe("U3b — content assertion (red-team fix #1)", () => {
  it("a 2xx from the WRONG page no longer verifies when expect_content is set", async () => {
    const b = fakeBridge();
    await u.claimTask(b, "rec1", "staci", { now: () => 1 });
    await u.completeTask(b, "rec1", "staci", "https://google.com");
    // builder (or planner) pins the expected evidence content in the envelope:
    const env = u.parseEnvelope(b.rec.fields[FIELDS.notes]);
    env.expect_content = "tradingagents";
    b.rec.fields[FIELDS.notes] = u.writeEnvelope(b.rec.fields[FIELDS.notes], env);

    const bad = await u.verifyTask(b, "rec1", "nimbus", {
      fetchImpl: vi.fn().mockResolvedValue({ status: 200, text: async () => "<html>search engine</html>" }),
    });
    expect(bad.done).toBe(false);
    expect(bad.detail).toMatch(/lacks expected content/);

    const good = await u.verifyTask(b, "rec1", "chronicler", {
      fetchImpl: vi.fn().mockResolvedValue({ status: 200, text: async () => '{"status":"ok","service":"tradingagents"}' }),
    });
    expect(good.done).toBe(true);
  });
});

describe("U4 — heartbeat election (failover)", () => {
  it("elects the highest-priority fresh executor", () => {
    const now = () => 10_000_000;
    const r = u.electExecutor(
      { staci: 10_000_000 - 60_000, nimbus: 10_000_000 - 120_000 },
      { now }
    );
    expect(r.elected).toBe("staci");
  });

  it("fails over to nimbus when staci goes stale", () => {
    const now = () => 10_000_000;
    const r = u.electExecutor(
      { staci: 10_000_000 - 60 * 60 * 1000, nimbus: 10_000_000 - 60_000 },
      { now }
    );
    expect(r.elected).toBe("nimbus");
  });

  it("escalates to human when everything is stale", () => {
    const now = () => 10_000_000;
    const r = u.electExecutor({ staci: 0, nimbus: 0 }, { now });
    expect(r.elected).toBeNull();
    expect(r.reason).toMatch(/human/i);
  });
});

describe("U5 — routing", () => {
  it("routes deploys/CI/kernel work to staci", () => {
    expect(u.routeTask("APPLY patches + fly deploy tradingagents").to).toBe("staci");
  });
  it("routes distribution/content to the v1 fleet roles", () => {
    expect(u.routeTask("Distribution burst: Blotato drafts, OpenSea listing").to).toBe(
      "fleet:hermes-tiffany"
    );
  });
  it("routes human-only work to blocked, never to an executor", () => {
    const r = u.routeTask("SWARM-04 [BRYANT DECISIONS] Charter ratification + approval tap");
    expect(r.to).toBe("human");
    expect(r.status).toBe("blocked");
  });
});

describe("bridge construction", () => {
  it("refuses to build without credentials rather than failing silently later", () => {
    expect(() => u.createAirtableBridge({})).toThrow(/required/);
  });
});
