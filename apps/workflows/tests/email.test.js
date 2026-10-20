const test = require("node:test");
const assert = require("node:assert/strict");
const { renderEmail, unsubscribeToken, formatINR, escapeHtml } = require("../src/code/email.js");
const { verifyDoorbell } = require("../src/code/signature.js");
const { parseJsonContent, parseJudgments } = require("../src/code/llm.js");
const crypto = require("crypto");

const user = { user_id: "U1", name: "<script>alert(1)</script> Rahul", monthly_income: "62000.00", credit_score: 760,
  employment_status: "Salaried", age: 34, products: [
    { product_name: "Personal Loan", lender_name: "HDFC Bank", interest_rate_min: "9.99", interest_rate_max: "24.00",
      min_monthly_income: "25000", min_age: 21, max_age: 60, source_url: "https://www.hdfc.bank.in/personal-loan",
      unverified: ["Minimum 2 years of work experience"], status: "LIKELY" },
    { product_name: "PL", lender_name: "B", interest_rate_min: null, source_url: "https://b", unverified: [] },
    { product_name: "PL2", lender_name: "C", interest_rate_min: 11, source_url: "https://c", unverified: [] },
    { product_name: "PL3", lender_name: "D", interest_rate_min: 12, source_url: "https://d", unverified: [] },
  ] };

test("personalised, escaped, honest email", () => {
  const e = renderEmail(user, { unsubscribeBase: "https://api/dev/v1/unsubscribe", secret: "s".repeat(20), now: 1000 });
  assert.match(e.subject, /4 personal loans/);
  assert.ok(!e.html.includes("<script>alert"), "names are HTML-escaped");
  assert.ok(e.html.includes("₹62,000/month ≥ ₹25,000 minimum"));
  assert.ok(e.html.includes("Interest 9.99–24% p.a."));
  assert.ok(e.html.includes("Minimum 2 years of work experience"));
  assert.ok(e.html.includes("+ 1 more option"));
  assert.ok(e.html.includes("not loan offers"));
  assert.ok(e.text.includes("Unsubscribe: https://api/dev/v1/unsubscribe?t="));
  assert.ok(!e.html.includes("U1@") && !e.html.includes("62000.00"), "no raw PII dumps");
  assert.ok(Buffer.byteLength(e.html) < 100 * 1024, "under Gmail's clipping limit");
});

test("INR formatting and escaping", () => {
  assert.equal(formatINR(150000), "₹1,50,000");
  assert.equal(formatINR(12345678), "₹1,23,45,678");
  assert.equal(formatINR(999), "₹999");
  assert.equal(escapeHtml(`"<&>'`), "&quot;&lt;&amp;&gt;&#39;");
});

test("unsubscribe token format", () => {
  const t = unsubscribeToken("U-42", "test-unsubscribe-secret-0123456789", 1000);
  assert.match(t, /^[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+$/);
});

test("doorbell signature: valid, tampered, stale", () => {
  const secret = "doorbell-secret-0123456789", id = "0b6f2a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", ts = "1000";
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${id}`).digest("hex");
  assert.deepEqual(verifyDoorbell({ "X-Timestamp": ts, "X-Signature": sig }, { batch_id: id }, secret, 1100), { ok: true, batchId: id });
  assert.equal(verifyDoorbell({ "X-Timestamp": ts, "X-Signature": sig }, { batch_id: id.replace("0b", "0c") }, secret, 1100).ok, false);
  assert.equal(verifyDoorbell({ "X-Timestamp": ts, "X-Signature": sig }, { batch_id: id }, secret, 5000).ok, false);
  assert.equal(verifyDoorbell({}, { batch_id: "'; DROP TABLE users;--" }, secret, 1000).ok, false);
});

test("LLM output parsing tolerates fences and drops unknown keys", () => {
  const resp = (content) => ({ choices: [{ message: { content } }] });
  assert.deepEqual(parseJsonContent(resp('```json\n{"a":1}\n```')), { a: 1 });
  assert.deepEqual(parseJsonContent(resp('Sure! {"a":2} hope that helps')), { a: 2 });
  assert.equal(parseJsonContent(resp("nope")), null);
  // gpt-oss on Bedrock: reasoning first, and it can quote braces of its own
  assert.deepEqual(parseJsonContent(resp('<reasoning>They want {"ok":true}. Output it.</reasoning>{"ok":true}')), { ok: true });
  const pending = [{ cache_key: "k1", product_id: 1 }];
  const out = parseJudgments(resp('{"judgments":[{"key":"k1","verdict":"PASS","reason":"ok"},{"key":"evil","verdict":"PASS"}]}'), pending, "m");
  assert.deepEqual(out, [{ cache_key: "k1", product_id: 1, verdict: "PASS", rationale: "ok", model: "m" }]);
});
