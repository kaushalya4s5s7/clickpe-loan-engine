import assert from "node:assert/strict";
import test from "node:test";
import { inr, inrShort, num, percent, rateRange, relativeTime } from "./format.ts";

test("Indian digit grouping and units", () => {
  assert.equal(num(150000), "1,50,000");
  assert.equal(inr(12345678), "₹1,23,45,678");
  assert.equal(inrShort(4000000), "₹40 lakh");
  assert.equal(inrShort(10000000), "₹1 crore");
  assert.equal(num(null), "—");
});

test("relative time, percent, rate range", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  assert.equal(relativeTime("2026-10-20T11:59:50Z", now), "just now");
  assert.equal(relativeTime("2026-10-20T09:00:00Z", now), "3 hours ago");
  assert.equal(relativeTime(null, now), "never");
  assert.equal(percent(1, 4), "25%");
  assert.equal(rateRange(9.99, 16.5), "9.99–16.5% p.a.");
  assert.equal(rateRange(10.99, null), "from 10.99% p.a.");
});
