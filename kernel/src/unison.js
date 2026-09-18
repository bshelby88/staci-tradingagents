/*
 * @staci/kernel — unison.js
 * ---------------------------------------------------------------
 * The protocol that lets the v1 fleet (nimbus/brain-poller) and
 * Staci work IN UNISON on one shared board (Airtable during the
 * strangler migration; the bridge is injected so Postgres can
 * replace it without touching this logic).
 *
 * Guarantees engineered here:
 *   U1. SINGLE BOARD  — both minds read/write the same task table.
 *   U2. NO DOUBLE WORK — claim/lease: a task has at most one live
 *       executor; leases expire so a dead executor never wedges work.
 *   U3. BUILDER ≠ VERIFIER — completion posts evidence and stops at
 *       'deploying'; only a DIFFERENT executor can flip 'done', and
 *       only after independently fetching the acceptance URL.
 *   U4. PRESENCE — heartbeats; if the primary goes stale the
 *       secondary is elected and drains the queue (no sole-executor
 *       blocker class, ever again).
 *   U5. ROUTING — task families map to the mind best suited: deploys
 *       to Staci/CI, legacy roles to the v1 fleet, human-only to
 *       'blocked' + escalation.
 *
 * The envelope lives as a single [UNISON]{...json...} line inside the
 * task's notes field, so the protocol needs no schema change on the
 * existing table (fields: title fldr0jpxBhdDdZ1Ap, status
 * fldsewYVWYmEp1VVd, instructions fldIfuEo7OMF7TTKG, notes
 * fldZBVk3FKtaGzkOC). All writes typecast:true.
 */
"use strict";

const FIELDS = {
  title: "fldr0jpxBhdDdZ1Ap",
  status: "fldsewYVWYmEp1VVd",
  instructions: "fldIfuEo7OMF7TTKG",
  notes: "fldZBVk3FKtaGzkOC",
};

const ENVELOPE_RE = /\[UNISON\](\{.*\})/;

/* ------------------------------------------------------------------ *
 * Envelope: parse/format the [UNISON] line in notes
 * ------------------------------------------------------------------ */

function parseEnvelope(notes) {
  const m = ENVELOPE_RE.exec(String(notes || ""));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function writeEnvelope(notes, envelope) {
  const line = `[UNISON]${JSON.stringify(envelope)}`;
  const base = String(notes || "");
  return ENVELOPE_RE.test(base) ? base.replace(ENVELOPE_RE, line) : `${line}\n${base}`.trim();
}

/* ------------------------------------------------------------------ *
 * Airtable bridge (fetch-injected; swap for Postgres later)
 * ------------------------------------------------------------------ */

function createAirtableBridge({ token, baseId, tableId, fetchImpl = fetch }) {
  if (!token || !baseId || !tableId) throw new TypeError("token, baseId, tableId required");
  const root = `https://api.airtable.com/v0/${baseId}/${tableId}`;
  const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  return {
    async get(recordId) {
      const res = await fetchImpl(`${root}/${recordId}`, { headers });
      const body = await res.json();
      if (body.error) throw new Error(`airtable get: ${body.error.message || body.error}`);
      return body;
    },
    async update(recordId, fields) {
      const res = await fetchImpl(`${root}/${recordId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ fields, typecast: true }),
      });
      const body = await res.json();
      if (body.error) throw new Error(`airtable update: ${body.error.message || body.error}`);
      return body;
    },
    async list(maxRecords = 50) {
      const res = await fetchImpl(`${root}?maxRecords=${maxRecords}`, { headers });
      const body = await res.json();
      if (body.error) throw new Error(`airtable list: ${body.error.message || body.error}`);
      return body.records || [];
    },
  };
}

/* ------------------------------------------------------------------ *
 * U2 — Claim / lease
 * ------------------------------------------------------------------ */

/**
 * Claim a task for `executor`. Refuses if another executor holds an
 * unexpired lease. Airtable has no transactions, so we claim and then
 * re-read to confirm we won (last-writer-wins detection).
 */
async function claimTask(bridge, recordId, executor, { leaseMs = 30 * 60 * 1000, now = Date.now } = {}) {
  const rec = await bridge.get(recordId);
  const notes = rec.fields ? rec.fields[FIELDS.notes] : rec.fields;
  const env = parseEnvelope(notes) || {};
  const t = now();
  if (env.claimed_by && env.claimed_by !== executor && (env.lease_until || 0) > t) {
    return { claimed: false, holder: env.claimed_by, lease_until: env.lease_until };
  }
  const claim = {
    ...env,
    claimed_by: executor,
    claimed_at: t,
    lease_until: t + leaseMs,
  };
  await bridge.update(recordId, { [FIELDS.notes]: writeEnvelope(notes, claim) });
  // confirm we won (another writer may have raced us)
  const confirm = await bridge.get(recordId);
  const after = parseEnvelope(confirm.fields[FIELDS.notes]) || {};
  const won = after.claimed_by === executor;
  return { claimed: won, holder: after.claimed_by, lease_until: after.lease_until };
}

/** Renew a held lease (call from long-running work). */
async function renewLease(bridge, recordId, executor, { leaseMs = 30 * 60 * 1000, now = Date.now } = {}) {
  const rec = await bridge.get(recordId);
  const env = parseEnvelope(rec.fields[FIELDS.notes]) || {};
  if (env.claimed_by !== executor) return { renewed: false, holder: env.claimed_by };
  env.lease_until = now() + leaseMs;
  await bridge.update(recordId, { [FIELDS.notes]: writeEnvelope(rec.fields[FIELDS.notes], env) });
  return { renewed: true, lease_until: env.lease_until };
}

/* ------------------------------------------------------------------ *
 * U3 — Builder ≠ Verifier completion flow
 * ------------------------------------------------------------------ */

/**
 * The BUILDER finishes: posts the acceptance evidence and moves the
 * task to 'deploying'. Structurally cannot set 'done'.
 */
async function completeTask(bridge, recordId, executor, verificationUrl, { now = Date.now } = {}) {
  if (!/^https?:\/\//.test(String(verificationUrl || ""))) {
    throw new TypeError("completeTask requires a public verification URL (charter §4 D2)");
  }
  const rec = await bridge.get(recordId);
  const env = parseEnvelope(rec.fields[FIELDS.notes]) || {};
  if (env.claimed_by !== executor) {
    throw new Error(`executor ${executor} does not hold the claim (holder: ${env.claimed_by || "none"})`);
  }
  const next = { ...env, built_by: executor, verification_url: verificationUrl, built_at: now() };
  delete next.claimed_by;
  delete next.lease_until;
  await bridge.update(recordId, {
    [FIELDS.status]: "deploying",
    [FIELDS.notes]: writeEnvelope(rec.fields[FIELDS.notes], next),
  });
  return { status: "deploying", awaiting: "independent verification" };
}

/**
 * A VERIFIER (must differ from builder) independently fetches the
 * acceptance URL. Only a 2xx flips the task to 'done'; anything else
 * bounces it back to 'building' with the failure recorded.
 */
async function verifyTask(bridge, recordId, verifier, { fetchImpl = fetch, now = Date.now } = {}) {
  const rec = await bridge.get(recordId);
  const env = parseEnvelope(rec.fields[FIELDS.notes]) || {};
  if (!env.verification_url) throw new Error("nothing to verify: no verification_url posted");
  if (env.built_by === verifier) {
    throw new Error(`charter §4 D1: builder '${verifier}' may not verify their own work`);
  }
  let ok = false;
  let detail = "";
  try {
    const res = await fetchImpl(env.verification_url, { method: "GET" });
    ok = res.status >= 200 && res.status < 300;
    detail = `HTTP ${res.status}`;
    // Red-team finding #1: a bare 2xx is gameable (any live URL passes).
    // If the envelope names expected content, the evidence must contain it.
    if (ok && env.expect_content) {
      const body = typeof res.text === "function" ? await res.text() : "";
      if (!body.includes(env.expect_content)) {
        ok = false;
        detail = `HTTP ${res.status} but evidence lacks expected content '${String(env.expect_content).slice(0, 60)}'`;
      }
    }
  } catch (e) {
    detail = `fetch failed: ${e.message}`;
  }
  const next = { ...env, verified_by: verifier, verified_at: now(), verification_result: detail };
  await bridge.update(recordId, {
    [FIELDS.status]: ok ? "done" : "building",
    [FIELDS.notes]: writeEnvelope(rec.fields[FIELDS.notes], next),
  });
  return { done: ok, detail };
}

/* ------------------------------------------------------------------ *
 * U4 — Heartbeats + executor election (failover)
 * ------------------------------------------------------------------ */

/**
 * Pure election: given { executor: lastHeartbeatMs } and a priority
 * order, pick the highest-priority executor whose heartbeat is fresh.
 * If none are fresh, escalate to human.
 */
function electExecutor(heartbeats, { priority = ["staci", "nimbus"], staleMs = 30 * 60 * 1000, now = Date.now } = {}) {
  const t = now();
  for (const name of priority) {
    const last = heartbeats[name];
    if (typeof last === "number" && t - last < staleMs) {
      return { elected: name, reason: "fresh heartbeat" };
    }
  }
  return { elected: null, reason: "all executors stale — escalate to human (Telegram)" };
}

/* ------------------------------------------------------------------ *
 * U5 — Task-family routing
 * ------------------------------------------------------------------ */

const ROUTES = [
  { re: /\b(HUMAN|BRYANT|LAPTOP|wallet-gated|approval tap|ratif)/i, to: "human", status: "blocked" },
  { re: /\b(deploy|fly\.toml|flyctl|CI|actions|dockerfile|migrate|kernel|staci)/i, to: "staci" },
  { re: /\b(blotato|opensea|listing|register|bazaar|agent\.market|post|publish|copy|email|content)/i, to: "fleet:hermes-tiffany" },
  { re: /\b(audit|extract|test|verify|grep)/i, to: "staci" },
];

function routeTask(title, instructions = "") {
  const hay = `${title}\n${instructions}`;
  for (const r of ROUTES) {
    if (r.re.test(hay)) return { to: r.to, status: r.status || "queued" };
  }
  return { to: "staci", status: "queued" }; // default: the new mind triages
}

module.exports = {
  FIELDS,
  parseEnvelope,
  writeEnvelope,
  createAirtableBridge,
  claimTask,
  renewLease,
  completeTask,
  verifyTask,
  electExecutor,
  routeTask,
};
