// Verifies the ingest Lambda's webhook "doorbell" (packages/orchestration/orchestration.go).
// signature = hex(HMAC-SHA256(secret, `${timestamp}.${batch_id}`)), timestamp within ±5 minutes.

const crypto = require("crypto");

const MAX_SKEW_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function verifyDoorbell(headers, body, secret, nowSeconds) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const ts = h["x-timestamp"], sig = h["x-signature"] || "";
  const batchId = String(body?.batch_id ?? "");
  if (!secret) return { ok: false, reason: "webhook secret not configured" };
  if (!UUID.test(batchId)) return { ok: false, reason: "batch_id is not a UUID" };
  if (!ts || Math.abs(nowSeconds - Number(ts)) > MAX_SKEW_SECONDS) return { ok: false, reason: "stale or missing timestamp" };
  const expected = crypto.createHmac("sha256", secret).update(`${ts}.${batchId}`).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(sig);
  // constant-time compare: no timing side channel on the signature
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };
  return { ok: true, batchId };
}

if (typeof module !== "undefined") module.exports = { verifyDoorbell };
