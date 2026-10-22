const test = require("node:test");
const assert = require("node:assert/strict");
const q = require("../src/code/questions.js");
const { unsubscribeToken } = require("../src/code/email.js");

const R = (text, ...depends_on) => ({ text, depends_on });
const WORK = R("Minimum of 2 years of total work experience", "work_experience");
const EMPLOYER = R("Employed with an MNC or public limited company", "employer_type");
const BANK = R("Salary account holders with the bank get a lower minimum income", "monthly_income", "bank_relationship");
const CITY = R("Available in select cities only", "city");
const VINTAGE = R("Business running for at least 3 years", "business_vintage");
const OTHER = R("Ownership of property affects eligibility", "other");
const EMI_OTHER = R("Monthly obligation should not exceed 50% of income", "other");
const EMI_KNOWN = R("Income should be sufficient to repay the EMI", "monthly_income");

const products = {
  1: { id: 1, lender_name: "HDFC Bank", interest_rate_min: 10, soft_rules: [WORK] },
  2: { id: 2, lender_name: "Axis Bank", interest_rate_min: 11, soft_rules: [WORK, EMPLOYER] },
  3: { id: 3, lender_name: "ICICI Bank", interest_rate_min: 10.5, soft_rules: [BANK] },
  4: { id: 4, lender_name: "Tata Capital", interest_rate_min: 12, soft_rules: [CITY] },
  5: { id: 5, lender_name: "Bajaj Finance", interest_rate_min: 13, soft_rules: [OTHER, WORK] },
  6: { id: 6, lender_name: "Bank of Baroda", interest_rate_min: 10.4, soft_rules: [EMI_KNOWN] },
  7: { id: 7, lender_name: "Kotak", interest_rate_min: 11, soft_rules: [VINTAGE] },
  8: { id: 8, lender_name: "SBI", interest_rate_min: 11, soft_rules: [BANK] },
};
const likely = (product_id, ...unverified) => ({ product_id, status: "LIKELY", score: 70, unverified: unverified.map((r) => r.text) });
const eligible = (product_id, score) => ({ product_id, status: "ELIGIBLE", score, unverified: [] });

test("askableQuestions maps features to canonical question ids", () => {
  assert.deepEqual(q.askableQuestions(WORK), ["work_experience"]);
  assert.deepEqual(q.askableQuestions(R("x", "employer_type", "bank_relationship")), ["employer_type", "bank_accounts"]);
  assert.deepEqual(q.askableQuestions(BANK), ["bank_accounts"], "known features need no question");
  assert.deepEqual(q.askableQuestions(R("x", "business_vintage", "work_experience")), ["work_experience", "business_vintage"]);
  assert.deepEqual(q.askableQuestions(CITY), ["city"]);
});

test("'other' rules are unaskable unless they are about EMIs", () => {
  assert.equal(q.askableQuestions(OTHER), null);
  assert.equal(q.askableQuestions(R("Ownership of property", "other", "work_experience")), null, "one unaskable feature blocks the rule");
  assert.deepEqual(q.askableQuestions(EMI_OTHER), ["existing_emi"]);
  assert.equal(q.askableQuestions(R("No deps")), null);
});

test("EMI heuristic only for known-feature rules the judge couldn't decide", () => {
  assert.equal(q.askableQuestions(EMI_KNOWN, false), null, "not judged UNKNOWN → nothing to ask");
  assert.deepEqual(q.askableQuestions(EMI_KNOWN, true), ["existing_emi"]);
  assert.equal(q.askableQuestions(R("Must be over 21", "age"), true), null, "UNKNOWN but not about EMIs");
  assert.deepEqual(q.askableQuestions(R("Has outstanding EMIs within limits", "monthly_income"), true), ["existing_emi"]);
});

test("catalogue: unique ids, every id has a label and an input", () => {
  const ids = q.QUESTIONS.map((x) => x.id);
  assert.deepEqual(ids, ["work_experience", "employer_type", "bank_accounts", "city", "business_vintage", "existing_emi"]);
  for (const x of q.QUESTIONS) assert.ok(x.label && x.input && x.input.type, x.id);
  const emp = q.QUESTIONS.find((x) => x.id === "employer_type").input.options.map((o) => o.value);
  assert.deepEqual(emp, ["central_state_govt", "psu", "mnc", "public_ltd", "private_ltd", "partnership_proprietorship", "other"]);
});

test("planner picks the subset that unlocks the most matches", () => {
  const matches = [likely(1, WORK), likely(2, WORK, EMPLOYER), likely(3, BANK), likely(4, CITY), likely(7, VINTAGE)];
  const one = q.planQuestions({}, matches, products, { maxQuestions: 1 });
  assert.deepEqual(one.questions, ["work_experience"], "work experience alone unlocks 1 (2 needs employer too)");
  assert.equal(one.unlockable, 1);
  const two = q.planQuestions({}, matches.filter((m) => m.product_id !== 3), products, { maxQuestions: 2 });
  assert.deepEqual(two.questions, ["work_experience", "employer_type"], "a pair beats any single + another single");
  assert.equal(two.unlockable, 2);
  assert.deepEqual(two.product_ids.sort(), [1, 2]);
  // Equal counts → the pair whose unlocked offers rank higher (ICICI 10.5% beats Axis 11%).
  assert.deepEqual(q.planQuestions({}, matches, products, { maxQuestions: 2 }).questions, ["work_experience", "bank_accounts"]);
  const three = q.planQuestions({}, matches, products);
  assert.equal(three.questions.length, 3);
  assert.equal(three.unlockable, 3);
  assert.ok(three.questions.includes("work_experience") && three.questions.includes("employer_type"));
});

test("planner prefers fewer questions on a tie and never asks for nothing", () => {
  const plan = q.planQuestions({}, [likely(1, WORK)], products, { maxQuestions: 3 });
  assert.deepEqual(plan.questions, ["work_experience"]);
  const none = q.planQuestions({}, [likely(5, OTHER, WORK), eligible(1, 80)], products);
  assert.deepEqual(none, { questions: [], unlockable: 0, lenders: [], mentions: [], bank_options: [], product_ids: [] },
    "an unaskable rule keeps the match LIKELY → nothing to ask");
  assert.equal(q.planQuestions({}, [], products).questions.length, 0);
  assert.equal(q.planQuestions({}, [likely(99, WORK)], products).questions.length, 0, "unknown product is skipped");
  assert.equal(q.planQuestions({}, [{ product_id: 1, status: "LIKELY", unverified: ["catalogue changed"] }], products).questions.length, 0);
});

test("worth-asking filter: skip offers that wouldn't make the top cards", () => {
  // Unlocked HDFC (rate 10) would score 80. Five ELIGIBLE offers already ≥ 80 → not worth asking.
  const full = [80, 81, 85, 90, 80].map((s, i) => eligible(100 + i, s));
  assert.equal(q.planQuestions({}, [...full, likely(1, WORK)], products).questions.length, 0);
  // Four of them → one card free → ask.
  assert.deepEqual(q.planQuestions({}, [...full.slice(0, 4), likely(1, WORK)], products).questions, ["work_experience"]);
  // Lower-scoring eligible offers don't count.
  const weak = [70, 71, 72, 73, 74].map((s, i) => eligible(100 + i, s));
  assert.deepEqual(q.planQuestions({}, [...weak, likely(1, WORK)], products).questions, ["work_experience"]);
  assert.equal(q.unlockedScore({ interest_rate_min: null }), 40);
});

test("EMI rule judged UNKNOWN is askable through existing EMIs", () => {
  const plan = q.planQuestions({}, [likely(6, EMI_KNOWN)], products);
  assert.deepEqual(plan.questions, ["existing_emi"]);
  assert.deepEqual(plan.lenders, ["Bank of Baroda"]);
  assert.match(plan.mentions[0].text, /^Bank of Baroda: Income should be sufficient to repay the EMI/);
});

test("bank list holds only the lenders whose rule asks about a bank relationship", () => {
  const plan = q.planQuestions({}, [likely(1, WORK), likely(3, BANK), likely(8, BANK)], products);
  assert.ok(plan.questions.includes("bank_accounts"));
  assert.deepEqual(plan.bank_options.sort(), ["ICICI Bank", "SBI"]);
  assert.deepEqual(q.planQuestions({}, [likely(1, WORK)], products).bank_options, []);
});

test("lenders and mentions follow the unlocked offers, best first", () => {
  const plan = q.planQuestions({}, [likely(2, WORK, EMPLOYER), likely(1, WORK)], products);
  assert.deepEqual(plan.lenders, ["HDFC Bank", "Axis Bank"]);
  assert.deepEqual(plan.mentions.map((m) => m.question), plan.questions);
  for (const m of plan.mentions) assert.ok(m.text.length <= 140);
  const long = { 9: { id: 9, lender_name: "L", interest_rate_min: 10, soft_rules: [R("x".repeat(300), "city")] } };
  assert.ok(q.planQuestions({}, [likely(9, long[9].soft_rules[0])], long).mentions[0].text.endsWith("…"));
});

test("productsById may be a Map", () => {
  const map = new Map(Object.values(products).map((p) => [p.id, p]));
  assert.deepEqual(q.planQuestions({}, [likely(1, WORK)], map).questions, ["work_experience"]);
});

test("planForClasses aggregates per class × class size", () => {
  const cls = (ib, n) => ({ ib, cb: 1, ab: 1, emp: "Salaried", n });
  const row = (c, m) => ({ ib: c.ib, cb: c.cb, ab: c.ab, emp: c.emp, ...m });
  const a = cls(1, 10), b = cls(2, 5), c = cls(3, 7);
  const rows = [
    row(a, likely(1, WORK)), row(a, likely(2, WORK, EMPLOYER)),  // a: asks work+employer, unlocks 2
    row(b, likely(3, BANK)),                                       // b: asks bank, unlocks 1
    row(c, likely(5, OTHER)), row(c, eligible(1, 80)),             // c: nothing askable
  ];
  const agg = q.planForClasses(rows, products, { classes: [a, b, c] });
  assert.equal(agg.users_to_ask, 15);
  assert.equal(agg.unlockable_matches, 10 * 2 + 5 * 1);
  assert.deepEqual(agg.by_question, [
    { id: "work_experience", label: "How long have you been working?", users: 10, unlockable: 20 },
    { id: "employer_type", label: "Who do you work for?", users: 10, unlockable: 10 },
    { id: "bank_accounts", label: "Do you have a savings or salary account with any of these banks?", users: 5, unlockable: 5 },
  ]);
  assert.deepEqual(q.planForClasses([], products), { users_to_ask: 0, unlockable_matches: 0, by_question: [] });
});

const SECRET = "test-unsubscribe-secret-0123456789";

test("confirm token round-trips and is URL-safe", () => {
  const t = q.confirmToken("U-42/ü", SECRET, 1000);
  assert.match(t, /^c\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(q.verifyConfirmToken(t, SECRET, 1001), { ok: true, userId: "U-42/ü" });
  assert.equal(t.split(".")[2], String(1000 + 14 * 24 * 3600), "default TTL is 14 days");
});

test("confirm token: tampered, wrong secret, expired, malformed", () => {
  const t = q.confirmToken("U1", SECRET, 1000, 60);
  const [c, id, exp, sig] = t.split(".");
  const other = Buffer.from("U2").toString("base64").replace(/=+$/, "");
  assert.equal(q.verifyConfirmToken([c, other, exp, sig].join("."), SECRET, 1001).reason, "bad signature");
  assert.equal(q.verifyConfirmToken([c, id, String(Number(exp) + 1000), sig].join("."), SECRET, 1001).reason, "bad signature");
  assert.equal(q.verifyConfirmToken([c, id, exp, sig.slice(0, -2) + "AA"].join("."), SECRET, 1001).ok, false);
  assert.equal(q.verifyConfirmToken(t, "another-secret-0123456789", 1001).reason, "bad signature");
  assert.equal(q.verifyConfirmToken(t, SECRET, 1060).reason, "expired");
  for (const bad of [undefined, "", "c..1.x", "x.a.1.b", "c.a.notanumber.b", "a.b.c"]) {
    assert.equal(q.verifyConfirmToken(bad, SECRET, 1001).ok, false, String(bad));
  }
  assert.equal(q.verifyConfirmToken(t, "", 1001).ok, false, "no secret configured → never valid");
});

test("confirm link tolerates a missing trailing slash and needs configuration", () => {
  const a = q.confirmLink("https://hooks.example/", "U1", SECRET, 1000);
  assert.equal(a, q.confirmLink("https://hooks.example", "U1", SECRET, 1000));
  assert.ok(a.startsWith("https://hooks.example/webhook/confirm?t=c."));
  const t = decodeURIComponent(new URL(a).searchParams.get("t"));
  assert.deepEqual(q.verifyConfirmToken(t, SECRET, 1001), { ok: true, userId: "U1" });
  assert.equal(q.confirmLink("", "U1", SECRET, 1000), null);
  assert.equal(q.confirmLink(undefined, "U1", SECRET, 1000), null);
  assert.equal(q.confirmLink("https://h/", "U1", "", 1000), null);
});

test("an unsubscribe token can't open the form (and vice versa)", () => {
  const unsub = unsubscribeToken("U1", SECRET, 1000);
  assert.equal(q.verifyConfirmToken(unsub, SECRET, 1001).ok, false);
  assert.equal(q.verifyConfirmToken(`c.${unsub}`, SECRET, 1001).ok, false, "prefixing doesn't forge a MAC");
  // A confirm token has four parts; the unsubscribe format is payload.exp.sig with a MAC over a different payload.
  assert.equal(q.confirmToken("U1", SECRET, 1000).split(".").length, 4);
  assert.notEqual(q.confirmToken("U1", SECRET, 1000).slice(2), unsub);
});
