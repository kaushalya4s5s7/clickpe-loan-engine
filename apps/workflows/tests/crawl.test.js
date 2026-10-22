const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");
const { htmlToText, relevantSection, validateProducts, numberAppears } = require("../src/code/crawl.js");

const page = (name) => zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "../../../tests/fixtures/html", `${name}.html.gz`))).toString();

test("real bank pages shrink to the eligibility facts (keyword windowing)", () => {
  const expectations = {
    hdfc: ["minimum net monthly income of ₹25,000", "21 to 60 years"],
    icici: ["Minimum monthly income of ₹30,000"],
    kotak: ["21 years and 60 years"],
    kotak_rates: ["10.99%"],
    icici_rates: ["9.99% and 16.50%"],
    hdfc_rates: ["9.99% p.a."],
  };
  for (const [name, needles] of Object.entries(expectations)) {
    const html = page(name);
    const section = relevantSection(htmlToText(html));
    assert.ok(section.length < 6100 && section.length < html.length / 50, `${name}: ${section.length} chars`);
    for (const n of needles) assert.ok(section.includes(n), `${name} should keep "${n}"`);
    assert.ok(!/<[a-z]/i.test(section), `${name}: no tags left`);
  }
});

test("validation keeps only facts backed by verbatim quotes", () => {
  const text = "Age: 21 to 60 years\nMinimum net monthly income of ₹25,000.\nRates from 10.99% p.a.";
  const { products, warnings } = validateProducts({ products: [{
    product_name: "Personal Loan", min_monthly_income: 25000, min_age: 21, max_age: 60,
    interest_rate_min: 10.99, min_credit_score: 750,                         // 750 is invented
    evidence: { min_monthly_income: "Minimum net monthly income of ₹25,000", age: "Age: 21 to 60 years",
                interest_rate: "Rates from 10.99% p.a.", min_credit_score: "CIBIL score of 750 or above" },
  }] }, { lender: "Test Bank", sourceText: text, sourceUrl: "https://x" });
  const p = products[0];
  assert.equal(p.min_monthly_income, 25000);
  assert.equal(p.min_age, 21); assert.equal(p.max_age, 60);
  assert.equal(p.interest_rate_min, 10.99); assert.equal(p.interest_rate_max, 10.99);
  assert.equal(p.min_credit_score, null, "unsupported quote → dropped");
  assert.ok(warnings.some((w) => w.includes("min_credit_score")));
  assert.equal(p.product_key.length, 32);
});

test("quote must contain the number (a real quote with a different number is rejected)", () => {
  const text = "Minimum net monthly income of ₹25,000.";
  const { products } = validateProducts({ products: [{ product_name: "PL", min_monthly_income: 15000,
    evidence: { min_monthly_income: "Minimum net monthly income of ₹25,000" } }] },
  { lender: "B", sourceText: text, sourceUrl: "u" });
  assert.equal(products[0].min_monthly_income, null);
});

test("implausible values and bad employment types are dropped", () => {
  const { products } = validateProducts({ products: [{ product_name: "PL", min_credit_score: 1200,
    employment_types: ["Salaried", "Astronaut"], evidence: { min_credit_score: "score 1200" } }] },
  { lender: "B", sourceText: "score 1200", sourceUrl: "u" });
  assert.equal(products[0].min_credit_score, null);
  assert.deepEqual(products[0].employment_types, ["Salaried"]);
});

test("criteria_hash changes only when eligibility changes", () => {
  const base = { product_name: "PL", min_age: 21, evidence: { age: "aged 21" } };
  const opts = { lender: "B", sourceText: "aged 21 and 23", sourceUrl: "u" };
  const a = validateProducts({ products: [base] }, opts).products[0];
  const b = validateProducts({ products: [{ ...base, product_name: "PL" }] }, opts).products[0];
  const c = validateProducts({ products: [{ ...base, min_age: 23, evidence: { age: "and 23" } }] }, opts).products[0];
  assert.equal(a.criteria_hash, b.criteria_hash);
  assert.notEqual(a.criteria_hash, c.criteria_hash);
});

test("numberAppears handles Indian formats", () => {
  assert.ok(numberAppears(25000, "₹25,000"));
  assert.ok(numberAppears(4000000, "up to ₹40 lakh"));
  assert.ok(numberAppears(10000000, "loans up to 1 crore"));
  assert.ok(!numberAppears(30000, "₹25,000"));
});

test("soft rules keep applicant requirements and drop notes about the loan", () => {
  const { isApplicantRule } = require("../src/code/crawl.js");
  for (const keep of ["Should have completed minimum 2 years in employment",
                      "You must already be an HSBC customer",
                      "The applicant should be 80 years or younger at the end of the loan tenure.",
                      "Employed with an MNC, public limited company, or private limited company"]) {
    assert.ok(isApplicantRule(keep), keep);
  }
  for (const drop of ["The minimum amount of personal loan varies by location from Rs. 50,000 to Rs. 1 lakh.",
                      "It varies by location from Rs. 2 lakhs to Rs. 20 lakhs.",
                      "Insurance is mandatory under the scheme.",
                      "Ownership of property affects eligibility calculation",
                      "Only for indian resident customers",
                      "You should have a steady income, meet minimum salary requirements",
                      "Applicants with stable monthly income may qualify for faster approvals and attractive loan terms.",
                      "A CIBIL score above 700 is ideal for Personal Loans."]) {
    assert.ok(!isApplicantRule(drop), drop);
  }
  const page = "Maximum age of 60 years at the time of maturity of the Personal Loan";
  assert.ok(isApplicantRule("Maximum age of 60 years at the time of maturity of the Personal Loan", page));
  assert.ok(!isApplicantRule("Maximum age of 60 years at the time of maturity of животного Personal Loan", page));
});
