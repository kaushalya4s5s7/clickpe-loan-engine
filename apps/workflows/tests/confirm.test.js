const test = require("node:test");
const assert = require("node:assert/strict");
const confirm = require("../src/code/confirm.js");
const questions = require("../src/code/questions.js");
const { judgmentRequest, parseJudgments } = require("../src/code/llm.js");

const RULES = {
  exp: "Minimum of 2 years of total work experience",
  salary: "Salary account with Kotak Mahindra Bank",
  emi: "Income should be sufficient to repay the EMI",
  doctor: "Applicant must be a practising doctor",
  employer: "Employed with a reputed MNC or public limited company",
};
const match = (id, lender, status, rate, unverified, soft, extra = {}) => ({
  product_id: id, status, score: 100 - rate * 2 - unverified.length * 5, unverified, decided_by: "RULES",
  lender_name: lender, product_name: `Personal Loan ${id}`, source_url: `https://lender${id}.example/pl`,
  interest_rate_min: String(rate), interest_rate_max: String(rate + 8), max_loan_amount: "2500000",
  min_monthly_income: "25000", min_credit_score: 700, min_age: 21, max_age: 60, employment_types: null,
  soft_rules: soft, ...extra });

function person(overrides = {}) {
  return {
    user_id: "U-1", name: "<b>Asha</b> Rao", age: 30, employment_status: "Salaried", monthly_income: "60000.00",
    credit_score: 760, batch_id: "b-1", declared: null, flagged: false, recipient: "me+one@gmail.com",
    matches: [
      match(1, "HDFC Bank", "LIKELY", 10, [RULES.exp], [{ text: RULES.exp, depends_on: ["work_experience"] }]),
      match(2, "Kotak Mahindra Bank", "LIKELY", 11, [RULES.salary], [{ text: RULES.salary, depends_on: ["bank_relationship"] }]),
      match(3, "Bank of Baroda", "LIKELY", 12, [RULES.emi], [{ text: RULES.emi, depends_on: ["monthly_income"] }]),
      match(4, "Doctor Bank", "LIKELY", 9, [RULES.doctor], [{ text: RULES.doctor, depends_on: ["other"] }]),
      match(5, "SBI", "ELIGIBLE", 13, [], []),
      match(6, "ICICI Bank", "LIKELY", 10.5, [RULES.exp, RULES.employer],
            [{ text: RULES.exp, depends_on: ["work_experience"] }, { text: RULES.employer, depends_on: ["employer_type"] }]),
    ],
    ...overrides,
  };
}

const plan = (p) => {
  const i = confirm.planInputs(p);
  return questions.planQuestions(i.user, i.matches, i.productsById, { maxQuestions: 3, maxCards: 5 });
};

// ---- parsing -----------------------------------------------------------------------------------

test("planInputs feeds the planner: only askable LIKELY matches are planned", () => {
  const p = person();
  const pl = plan(p);
  assert.ok(pl.questions.length > 0 && pl.questions.length <= 3);
  assert.ok(pl.questions.includes("work_experience"));
  assert.ok(!pl.product_ids.includes(4), "the 'other' rule can't be asked about");
  assert.ok(!pl.product_ids.includes(5), "ELIGIBLE matches are not re-asked");
});

test("parseAnswers reads every question type, tolerating commas, ₹ and array-style keys", () => {
  const p = person();
  const { answers, errors } = confirm.parseAnswers({
    t: "x", total_experience_years: "5", current_job_years: "2.5", employer_type: "mnc",
    "bank_accounts[]": ["Kotak Mahindra Bank", "HDFC Bank"], city: "  Navi   Mumbai ", business_years: "",
    existing_emi_monthly: "₹12,000",
  }, p, plan(p));
  assert.deepEqual(errors, {});
  assert.deepEqual(answers, {
    work_experience: { total_experience_years: 5, current_job_years: 2.5 }, employer_type: "mnc",
    bank_accounts: ["Kotak Mahindra Bank", "HDFC Bank"], city: "Navi Mumbai", existing_emi: { existing_emi_monthly: 12000 },
  });
});

test("parseAnswers: 'none of these' is an answer (no accounts); a single checkbox arrives as a string", () => {
  const p = person();
  assert.deepEqual(confirm.parseAnswers({ bank_accounts: "none" }, p, plan(p)).answers, { bank_accounts: [] });
  assert.deepEqual(confirm.parseAnswers({ bank_accounts: "Kotak Mahindra Bank" }, p, plan(p)).answers,
    { bank_accounts: ["Kotak Mahindra Bank"] });
});

test("parseAnswers rejects unreadable input per question (nothing is stored)", () => {
  const p = person();
  const cases = [
    [{ total_experience_years: "five", current_job_years: "1" }, "work_experience"],
    [{ total_experience_years: "5" }, "work_experience"],                       // only one of the two numbers
    [{ total_experience_years: "-1", current_job_years: "0" }, "work_experience"],
    [{ total_experience_years: "61", current_job_years: "0" }, "work_experience"],  // beyond the question's max
    [{ employer_type: "<script>" }, "employer_type"],
    [{ bank_accounts: ["Evil Bank"] }, "bank_accounts"],                         // not offered to this person
    [{ bank_accounts: ["none", "HDFC Bank"] }, "bank_accounts"],
    [{ city: "12345" }, "city"],
    [{ city: "x".repeat(81) }, "city"],
    [{ business_years: "101" }, "business_vintage"],
    [{ existing_emi_monthly: "1500.50" }, "existing_emi"],                       // whole rupees
    [{ existing_emi_monthly: "999999999" }, "existing_emi"],
  ];
  for (const [body, key] of cases) {
    const r = confirm.parseAnswers(body, p, plan(p));
    assert.ok(r.errors[key], `${JSON.stringify(body)} → error on ${key}`);
    assert.equal(r.answers[key], undefined);
  }
  assert.ok(confirm.parseAnswers({ t: "x" }, p, plan(p)).errors.form, "at least one answer is required");
  assert.ok(confirm.parseAnswers(null, p, plan(p)).errors.form);
});

test("retryPlan re-shows planned questions plus anything the person filled in, in canonical order", () => {
  const p = person();
  const parsed = confirm.parseAnswers({ city: "123", existing_emi_monthly: "5000" }, p, plan(p));
  const r = confirm.retryPlan({ questions: ["work_experience"], unlockable: 2, mentions: [] }, parsed);
  assert.deepEqual(r.questions, ["work_experience", "city", "existing_emi"]);
  assert.equal(r.unlockable, 2);
});

// ---- sanity checks -----------------------------------------------------------------------------

test("sanityCheck flags contradictions with age and between answers", () => {
  const p = person({ age: 25 });
  const flags = (a, who = p) => confirm.sanityCheck(a, who);
  assert.deepEqual(flags({ work_experience: { total_experience_years: 7, current_job_years: 2 } }), []);  // = age − 18: fine
  assert.equal(flags({ work_experience: { total_experience_years: 8, current_job_years: 2 } }).length, 1);
  assert.match(flags({ work_experience: { total_experience_years: 3, current_job_years: 4 } })[0], /current job/);
  assert.match(flags({ business_vintage: { business_years: 10 } })[0], /business/);
  assert.deepEqual(flags({ business_vintage: { business_years: 7 } }), []);
});

test("sanityCheck: employer type must fit the CSV employment status (both directions)", () => {
  const selfEmployed = person({ employment_status: "Self-Employed" });
  const business = person({ employment_status: "Business" });
  for (const et of ["central_state_govt", "psu", "mnc", "public_ltd", "private_ltd"]) {
    assert.equal(confirm.sanityCheck({ employer_type: et }, selfEmployed).length, 1, et);
    assert.equal(confirm.sanityCheck({ employer_type: et }, business).length, 1, et);
    assert.deepEqual(confirm.sanityCheck({ employer_type: et }, person()), [], et);
  }
  assert.deepEqual(confirm.sanityCheck({ employer_type: "partnership_proprietorship" }, person()), []);  // employees of a firm
  assert.deepEqual(confirm.sanityCheck({ employer_type: "partnership_proprietorship" }, selfEmployed), []);
  assert.deepEqual(confirm.sanityCheck({ employer_type: "other" }, selfEmployed), []);
});

test("sanityCheck: existing EMIs above the CSV income are flagged", () => {
  assert.equal(confirm.sanityCheck({ existing_emi: { existing_emi_monthly: 70000 } }, person()).length, 1);
  assert.deepEqual(confirm.sanityCheck({ existing_emi: { existing_emi_monthly: 0 } }, person()), []);
});

test("mergeAnswers: newer answers replace older ones; earlier questions are kept", () => {
  assert.deepEqual(confirm.mergeAnswers({ city: "Pune", employer_type: "psu" }, { employer_type: "mnc" }),
    { city: "Pune", employer_type: "mnc" });
  assert.deepEqual(confirm.mergeAnswers(null, { city: "Pune" }), { city: "Pune" });
});

// ---- judge items + verdicts --------------------------------------------------------------------

const ANSWERS = { work_experience: { total_experience_years: 6, current_job_years: 3 }, bank_accounts: ["Kotak Mahindra Bank"],
  existing_emi: { existing_emi_monthly: 8000 } };

test("judgeItems: only rules the answers cover, with exact CSV values + declared facts", () => {
  const items = confirm.judgeItems(person(), ANSWERS);
  const keys = items.map((i) => i.cache_key);
  assert.deepEqual(keys, ["1:0", "2:0", "3:0", "6:0"], "Doctor Bank ('other') and ICICI's employer rule are not covered");
  const hdfc = items[0];
  assert.equal(hdfc.rule, RULES.exp);
  assert.deepEqual(hdfc.features.work_experience, { total_years: 6, years_in_current_job: 3 });
  assert.equal(hdfc.features.name, undefined, "no PII beyond the facts the rule needs");
  assert.match(items[1].features.bank_relationship, /Kotak Mahindra Bank/);
  assert.deepEqual([items[2].features.monthly_income, items[2].features.existing_emi_monthly_inr], [60000, 8000]);
  assert.match(items[2].features.source, /declaration/);
  // The request is the same shape Workflow B sends (one batch for all items).
  const req = judgmentRequest("m", items);
  assert.equal(JSON.parse(req.messages[1].content).items.length, 4);
});

test("judgeItems: 'none of these' banks is a real answer; no answers → nothing to judge", () => {
  const [item] = confirm.judgeItems(person(), { bank_accounts: [] });
  assert.match(item.features.bank_relationship, /no savings or salary account/);
  assert.deepEqual(confirm.judgeItems(person(), {}), []);
  assert.deepEqual(confirm.judgeItems(person({ matches: [] }), ANSWERS), []);
});

test("judgeItems skips rule texts no longer in the catalogue", () => {
  const p = person();
  p.matches[0].soft_rules = [{ text: "changed wording", depends_on: ["work_experience"] }];
  assert.ok(!confirm.judgeItems(p, ANSWERS).some((i) => i.product_id === 1));
});

test("decide: all PASS → unlock, any FAIL → reject, partial → narrow, UNKNOWN/missing → unchanged", () => {
  const p = person();
  const items = confirm.judgeItems(p, ANSWERS);
  const reply = { choices: [{ message: { content: JSON.stringify({ judgments: [
    { key: "1:0", verdict: "PASS", reason: "6 ≥ 2" }, { key: "2:0", verdict: "FAIL", reason: "no" },
    { key: "3:0", verdict: "UNKNOWN", reason: "?" }, { key: "6:0", verdict: "PASS", reason: "ok" },
    { key: "4:0", verdict: "PASS", reason: "not asked → ignored" }] }) } }] };
  const judgments = parseJudgments(reply, items, "m");
  const d = confirm.decide(p, items, judgments);
  const byId = Object.fromEntries(d.updates.map((u) => [u.product_id, u]));
  assert.deepEqual(byId[1], { product_id: 1, action: "unlock", score: 80, unverified: [] });
  assert.equal(byId[2].action, "reject");
  assert.equal(byId[3], undefined, "UNKNOWN: still to confirm, no write");
  assert.deepEqual(byId[6], { product_id: 6, action: "narrow", score: 74, unverified: [RULES.employer] });
  assert.equal(byId[4], undefined, "a verdict for an item we never asked about is ignored");
  assert.deepEqual(d.unlocked.map((m) => [m.product_id, m.status, m.score]), [[1, "ELIGIBLE", 80]]);
  assert.equal(d.narrowed, 1);
  assert.equal(d.rejected, 1);
});

test("decide: a failed LLM call (no verdicts) changes nothing", () => {
  const p = person();
  const items = confirm.judgeItems(p, ANSWERS);
  assert.deepEqual(confirm.decide(p, items, parseJudgments({ error: "timeout" }, items, "m")).updates, []);
  assert.deepEqual(confirm.decide(p, [], []).updates, []);
});

test("decide: unlocked offers are ranked by their new score", () => {
  const p = person();
  const items = confirm.judgeItems(p, ANSWERS);
  const d = confirm.decide(p, items, items.map((i) => ({ cache_key: i.cache_key, verdict: "PASS" })));
  assert.deepEqual(d.unlocked.map((m) => m.product_id), [1, 2, 3]);
  assert.equal(confirm.score({ interest_rate_min: null }, 0), 40);
});

// ---- pages + email -----------------------------------------------------------------------------

test("form: only the planned questions, escaped, labelled with lender quotes, posts the token", () => {
  const p = person();
  const pl = { questions: ["work_experience", "bank_accounts"], unlockable: 2, lenders: ["HDFC Bank", "Kotak Mahindra Bank"],
    mentions: [{ question: "work_experience", text: "HDFC Bank: <i>2 years</i> of work experience" }],
    bank_options: ["Kotak Mahindra Bank"] };
  const html = confirm.renderForm(p, pl, { action: "https://n8n.example/webhook/confirm-submit", token: 'c.abc"><x' });
  assert.ok(!html.includes("<b>Asha</b>") && html.includes("&lt;b&gt;Asha&lt;/b&gt;"), "name escaped");
  assert.ok(html.includes("HDFC Bank: &lt;i&gt;2 years&lt;/i&gt;"), "lender quote shown and escaped");
  assert.ok(html.includes('action="https://n8n.example/webhook/confirm-submit"'));
  assert.ok(html.includes('name="t" value="c.abc&quot;&gt;&lt;x"'), "token escaped in the hidden field");
  assert.ok(html.includes('name="total_experience_years"') && html.includes('name="current_job_years"'));
  assert.ok(html.includes('value="Kotak Mahindra Bank"') && !html.includes('value="HDFC Bank"'), "only relevant banks");
  assert.ok(html.includes('value="none"'));
  assert.ok(!html.includes('name="city"') && !html.includes('name="employer_type"'), "unplanned questions not shown");
  assert.match(html, /self-declared/);
  assert.match(html, /lender will verify/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /name="viewport"/);
  assert.ok(html.includes("<legend>") && html.includes('<label for="total_experience_years">'), "accessible labels");
  assert.ok(!/approved/i.test(html));
});

test("form: pre-filled from earlier answers; errors are announced and tied to their fields", () => {
  const p = person({ declared: { work_experience: { total_experience_years: 4, current_job_years: 1 }, employer_type: "psu" } });
  const pl = { questions: ["work_experience", "employer_type"], unlockable: 1, mentions: [] };
  const html = confirm.renderForm(p, pl, { action: "/x", token: "t" });
  assert.ok(html.includes('name="total_experience_years" inputmode="decimal" min="0" max="60" step="0.5" value="4"'));
  assert.ok(html.includes('<option value="psu" selected>'));
  const bad = confirm.renderForm(p, pl, { action: "/x", token: "t", values: { employer_type: "" },
    errors: { work_experience: "Please fill in both numbers." } });
  assert.match(bad, /role="alert"/);
  assert.match(bad, /aria-invalid="true"/);
  assert.match(bad, /aria-describedby="err-work_experience"/);
});

test("no questions → friendly page; expired page leaks nothing", () => {
  const p = person();
  assert.match(confirm.renderForm(p, { questions: [] }, { action: "/x", token: "t" }), /nothing to confirm/i);
  const expired = confirm.expiredPage();
  assert.match(expired, /expired/);
  assert.ok(!/signature|malformed|U-1/.test(expired));
  assert.match(confirm.reviewPage(p), /team will review/);
});

test("result page lists what unlocked, honestly worded", () => {
  const p = person();
  const unlocked = [{ ...p.matches[0], status: "ELIGIBLE", unverified: [], score: 80, product_name: "<PL>" }];
  const html = confirm.resultPage(p, unlocked, { narrowed: 1, rejected: 2, emailed: true });
  assert.match(html, /pre-qualify for 1 more personal loan\b/);
  assert.match(html, /Pre-qualified based on your answers — the lender will verify/);
  assert.match(html, /emailed you this list/);
  assert.match(html, /2 offers don&#39;t fit your profile/);
  assert.ok(html.includes("&lt;PL&gt;"));
  assert.ok(!/\bapproved\b/i.test(html));
  const none = confirm.resultPage(p, [], {});
  assert.match(none, /didn't unlock new offers/);
});

test("'you now pre-qualify' email: escaped, honest, unsubscribe, text twin, small", () => {
  const p = person();
  const unlocked = [1, 2, 3, 6, 4, 5].map((i) => ({ ...p.matches.find((m) => m.product_id === i), status: "ELIGIBLE" }));
  const e = confirm.renderUnlockedEmail(p, unlocked, { unsubscribeBase: "https://api/v1/unsubscribe", secret: "s".repeat(32),
    now: 1000, maxCards: 5 });
  assert.equal(e.subject, "<b>Asha</b>, you now pre-qualify for 6 more personal loans");  // subject is plain text
  assert.ok(!e.html.includes("<b>Asha</b>") && e.html.includes("&lt;b&gt;Asha&lt;/b&gt;"));
  assert.match(e.html, /Pre-qualified based on your answers — the lender will verify them when you apply/);
  assert.match(e.html, /\+ 1 more option unlocked/);
  assert.match(e.html, /income ₹60,000\/month ≥ ₹25,000 minimum/);
  assert.match(e.html, /not a loan offer or approval/);
  assert.ok(e.html.includes("https://api/v1/unsubscribe?t="));
  assert.ok(e.text.includes("Unsubscribe: https://api/v1/unsubscribe?t="));
  assert.ok(e.text.includes("• Personal Loan 1 — HDFC Bank"));
  assert.ok(Buffer.byteLength(e.html) < 100 * 1024);
  const one = confirm.renderUnlockedEmail(p, unlocked.slice(0, 1), { unsubscribeBase: "u", secret: "s", now: 1 });
  assert.match(one.subject, /1 more personal loan$/);
});

test("answersToValues round-trips stored answers into form values", () => {
  assert.deepEqual(confirm.answersToValues({ bank_accounts: [], existing_emi: { existing_emi_monthly: 0 }, business_vintage: { business_years: 3 } }),
    { bank_accounts: ["none"], existing_emi_monthly: "0", business_years: "3" });
  assert.deepEqual(confirm.answersToValues(null), {});
});

test("batchJudgeItems/batchDecide re-check many people in one request without mixing them up", () => {
  const rule = { text: "Minimum 2 years of work experience", depends_on: ["work_experience"] };
  const person = (user_id, years) => ({
    user_id, age: 35, employment_status: "Salaried", monthly_income: 60000, credit_score: 760,
    declared: { work_experience: { total_experience_years: years, current_job_years: 1 } },
    matches: [{ product_id: 7, status: "LIKELY", score: 75, unverified: [rule.text], lender_name: "HDFC Bank",
                interest_rate_min: 10, soft_rules: [rule] }],
  });
  const people = [person("U1", 10), person("U2", 1), { ...person("U3", 5), declared: {} }];
  const items = confirm.batchJudgeItems(people);
  assert.deepEqual(items.map((i) => i.cache_key), ["U1|7:0", "U2|7:0"]);  // U3 answered nothing relevant
  const verdicts = [{ cache_key: "U1|7:0", verdict: "PASS" }, { cache_key: "U2|7:0", verdict: "FAIL" }];
  const d = confirm.batchDecide(people, items, verdicts);
  assert.deepEqual(d.updates.map((u) => [u.user_id, u.product_id, u.action]), [["U1", 7, "unlock"], ["U2", 7, "reject"]]);
  assert.equal(d.unlocked, 1);
  assert.equal(d.rejected, 1);
});
