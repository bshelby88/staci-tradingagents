"use strict";
// POST /api/analyze-ticker handler.
// Delivery rule: a SIMULATED / engine-unavailable result is never returned with HTTP 200,
// because @x402/express settles payment on any status < 400. If no live analysis was
// produced we answer 503 {ok:false, delivered:false} and the buyer is not charged.
// A result is only delivered when the analyzer returns a live (non-simulated) payload.

function createAnalyzeHandler({ runAnalyze, k, receipts, receiptSecret }) {
  return async function analyzeTicker(req, res) {
    const { ticker, date } = req.body || {};
    if (!ticker || !/^[A-Za-z0-9.\-]{1,10}$/.test(String(ticker)))
      return res.status(400).json({ ok: false, error: "invalid ticker" });
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.status(400).json({ ok: false, error: "date must be YYYY-MM-DD" });

    const nonce = req.get("PAYMENT-SIGNATURE") || req.get("X-Payment") || "";
    const cached = nonce && receipts.lookup(nonce);
    if (cached) return res.json({ ok: true, replay: true, receipt: cached.receipt, ...cached.response });

    const unavailable = (why) =>
      res.status(503).json({
        ok: false,
        delivered: false,
        synthetic: false,
        error: "live analysis engine unavailable; no output delivered, payment not settled",
        reason: String(why || "unknown").slice(0, 200),
        retryable: true,
      });

    let raw;
    try {
      raw = await runAnalyze({ ticker: String(ticker).toUpperCase(), date });
    } catch (e) {
      console.error("analyze-ticker: engine error", e && e.message ? e.message : e);
      return unavailable(e && e.message);
    }
    if (!raw || raw.simulated === true || raw.error) {
      return unavailable(raw && raw.simulated ? "analyzer returned simulated output" : raw && raw.error);
    }
    const result = k.liveResult(raw);
    const receipt = nonce ? receipts.record(nonce, result, receiptSecret) : undefined;
    return res.json({ ok: true, receipt, ...result });
  };
}

module.exports = { createAnalyzeHandler };
