const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCuts, matchClasses, popcount } = require("../src/code/matcher.js");

const EMP = ["Salaried", "Self-Employed", "Business"];

// Deterministic PRNG so failures are reproducible.
function rng(seed) { return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31); }

function randomProducts(r, n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1, criteria_hash: `h${i}`, interest_rate_min: 10 + Math.floor(r() * 10),
    min_monthly_income: r() < 0.2 ? null : 15000 + Math.floor(r() * 10) * 5000,
    min_credit_score: r() < 0.2 ? null : 650 + Math.floor(r() * 7) * 25,
    accepts_ntc: r() < 0.3,
    min_age: r() < 0.2 ? null : 21 + Math.floor(r() * 5),
    max_age: r() < 0.2 ? null : 45 + Math.floor(r() * 15),
    employment_types: r() < 0.4 ? null : EMP.filter(() => r() < 0.6),
    soft_rules: [],
  }));
}

function randomUsers(r, n) {
  return Array.from({ length: n }, () => ({
    monthly_income: 10000 + Math.floor(r() * 140000), credit_score: r() < 0.1 ? null : 600 + Math.floor(r() * 250),
    age: 18 + Math.floor(r() * 50), employment_status: EMP[Math.floor(r() * 3)],
  }));
}

// The oracle: the obvious per-pair check, exactly as a human would read the rules.
function bruteForce(u, p) {
  if (p.min_monthly_income != null && u.monthly_income < p.min_monthly_income) return false;
  if (u.credit_score == null) { if (!p.accepts_ntc) return false; }
  else if (p.min_credit_score != null && u.credit_score < p.min_credit_score) return false;
  if (p.min_age != null && u.age < p.min_age) return false;
  if (p.max_age != null && u.age > p.max_age) return false;
  if (p.employment_types && p.employment_types.length && !p.employment_types.includes(u.employment_status)) return false;
  return true;
}

// JS twin of SQL width_bucket(v, cuts): number of cuts <= v.
const widthBucket = (v, cuts) => cuts.filter((c) => c <= v).length;

function classesFor(users, cuts) {
  const map = new Map();
  for (const u of users) {
    const k = [widthBucket(u.monthly_income, cuts.income), u.credit_score == null ? 0 : widthBucket(u.credit_score, cuts.credit),
               widthBucket(u.age, cuts.age), u.employment_status];
    const key = k.join("|");
    if (!map.has(key)) map.set(key, { ib: k[0], cb: k[1], ab: k[2], emp: k[3], n: 0, users: [] });
    map.get(key).n++; map.get(key).users.push(u);
  }
  return [...map.values()];
}

test("bitset class matcher == brute force on random catalogues (differential)", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const r = rng(seed);
    const products = randomProducts(r, 1 + Math.floor(r() * 70));  // >64 exercises BigInt width
    const users = randomUsers(r, 400);
    const cuts = buildCuts(products);
    const classes = classesFor(users, cuts);
    const { rows, funnel } = matchClasses(classes, products, cuts);
    const got = new Set();
    for (const c of classes) for (const row of rows.filter((x) => x.ib === c.ib && x.cb === c.cb && x.ab === c.ab && x.emp === c.emp))
      for (let ui = 0; ui < c.users.length; ui++) got.add(`${JSON.stringify(c.users[ui])}#${ui}#${c.ib}${c.cb}${c.ab}${c.emp}|${row.product_id}`);
    let expected = 0;
    for (const c of classes) c.users.forEach((u, ui) => products.forEach((p) => {
      if (bruteForce(u, p)) { expected++; assert.ok(got.has(`${JSON.stringify(u)}#${ui}#${c.ib}${c.cb}${c.ab}${c.emp}|${p.id}`), `seed ${seed}: missing ${p.id}`); }
    }));
    assert.equal(funnel.matches, expected, `seed ${seed}`);
    assert.equal(got.size, expected, `seed ${seed}: extra matches`);
  }
});

test("boundary values pass: income exactly at the minimum, age exactly at max", () => {
  const products = [{ id: 1, criteria_hash: "h", min_monthly_income: 25000, min_age: 21, max_age: 60, soft_rules: [] }];
  const cuts = buildCuts(products);
  const at = classesFor([{ monthly_income: 25000, credit_score: 700, age: 60, employment_status: "Salaried" }], cuts);
  const below = classesFor([{ monthly_income: 24999, credit_score: 700, age: 61, employment_status: "Salaried" }], cuts);
  assert.equal(matchClasses(at, products, cuts).rows.length, 1);
  assert.equal(matchClasses(below, products, cuts).rows.length, 0);
});

test("metamorphic: raising income never removes an offer", () => {
  const r = rng(99);
  const products = randomProducts(r, 30);
  const cuts = buildCuts(products);
  for (const u of randomUsers(r, 200)) {
    const before = new Set(matchClasses(classesFor([u], cuts), products, cuts).rows.map((x) => x.product_id));
    const richer = { ...u, monthly_income: u.monthly_income + 50000 };
    const after = new Set(matchClasses(classesFor([richer], cuts), products, cuts).rows.map((x) => x.product_id));
    for (const id of before) assert.ok(after.has(id));
  }
});

test("soft rules: unknown data → LIKELY without LLM; known data → one cached question per projected key", () => {
  const other = { id: 8, criteria_hash: "x", min_monthly_income: 50000, soft_rules: [] };  // splits income into 2 classes
  const products = [other, { id: 7, criteria_hash: "abc", min_monthly_income: 20000, soft_rules: [
    { text: "2 years work experience", depends_on: ["work_experience"] },
    { text: "Self-employed professionals such as doctors or CAs", depends_on: ["employment_status"] },
  ] }];
  const p7 = (rows) => rows.filter((r) => r.product_id === 7);
  const cuts = buildCuts(products);
  const users = [
    { monthly_income: 30000, credit_score: 700, age: 30, employment_status: "Self-Employed" },
    { monthly_income: 90000, credit_score: 800, age: 45, employment_status: "Self-Employed" },  // other class, same projection
    { monthly_income: 30000, credit_score: 700, age: 30, employment_status: "Salaried" },
  ];
  const classes = classesFor(users, cuts);
  const first = matchClasses(classes, products, cuts);
  assert.equal(first.pending.length, 2, "Self-Employed and Salaried projections, not 3 classes");
  assert.ok(p7(first.rows).every((r) => r.status === "LIKELY" && r.unverified.includes("2 years work experience")));

  const judgments = Object.fromEntries(first.pending.map((p) => [p.cache_key, p.features.employment_status === "Salaried" ? "FAIL" : "PASS"]));
  const second = matchClasses(classes, products, cuts, judgments);
  assert.equal(second.pending.length, 0);
  assert.deepEqual(p7(second.rows).map((r) => r.emp).sort(), ["Self-Employed", "Self-Employed"]);
  assert.ok(p7(second.rows).every((r) => r.decided_by === "LLM"));
});

test("new-to-credit users only match products that accept them", () => {
  const products = [{ id: 1, criteria_hash: "a", soft_rules: [] }, { id: 2, criteria_hash: "b", accepts_ntc: true, soft_rules: [] }];
  const cuts = buildCuts(products);
  const ntc = classesFor([{ monthly_income: 50000, credit_score: null, age: 30, employment_status: "Business" }], cuts);
  assert.deepEqual(matchClasses(ntc, products, cuts).rows.map((r) => r.product_id), [2]);
});

test("popcount", () => assert.equal(popcount((1n << 70n) | 5n), 3));
