// Workflow B — the Optimization Treasure Hunt, stages 2 and 3.
//
// Stage 1 (SQL, before this code): users are grouped into CLASSES. A product's hard rules only
// ever compare a user's value with a few thresholds, so two users that fall between the same
// thresholds on every attribute are indistinguishable to every product. "Coordinate
// compression": the thresholds become cut points, Postgres' width_bucket() maps each value to
// its interval, and GROUP BY collapses users → classes (sample: 10,000 users → ~hundreds).
//
// Stage 2 (here): per class, eligibility = AND of one precomputed bitmask per attribute.
//   inc[b] = products whose income rule passes for income-bucket b   (likewise credit, age, job)
//   classMask = inc[ib] & cred[cb] & age[ab] & job[emp]
// BigInt masks have no 64-product limit. Cost: O(classes × attributes) mask ANDs plus
// O(matches) bit walks, instead of O(users × products) rule checks.
//
// Stage 3 (selective LLM): only soft rules that depend on data we HAVE need judging, and only
// once per (product, criteria version, rule, projected class features) — a cache key bounded by
// feature cardinality, not by user count. Rules about data we DON'T have (work experience,
// employer type...) are never sent to an LLM: the match is LIKELY with an "unverified" list.

const KNOWN_FEATURES = new Set(["monthly_income", "credit_score", "age", "employment_status"]);
const EMPLOYMENT = ["Salaried", "Self-Employed", "Business"];
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

/** Sorted unique cut points per attribute. Index 0 is a floor sentinel so arrays are never empty. */
function buildCuts(products) {
  const uniq = (xs) => [...new Set(xs)].sort((a, b) => a - b);
  const income = [0], credit = [300], age = [0];
  for (const p of products) {
    if (num(p.min_monthly_income) !== null) income.push(num(p.min_monthly_income));
    if (num(p.min_credit_score) !== null) credit.push(num(p.min_credit_score));
    if (num(p.min_age) !== null) age.push(num(p.min_age));
    if (num(p.max_age) !== null) age.push(num(p.max_age) + 1);  // age <= max  ⇔  age < max+1
  }
  return { income: uniq(income), credit: uniq(credit), age: uniq(age) };
}

/** Postgres array literal for width_bucket(): numbers only, so no injection surface. */
const pgArray = (xs) => `{${xs.map(Number).join(",")}}`;

// width_bucket(v, cuts) = b  means  cuts[b-1] <= v < cuts[b]   (b = 0 below the first cut).
// So "v >= threshold t" where t = cuts[k]  ⇔  b >= k + 1, and "v < cuts[j]" ⇔ b <= j.
function attributeMasks(products, cuts) {
  const buckets = (arr) => arr.length + 1;  // b ∈ [0, len]
  const inc = Array(buckets(cuts.income)).fill(0n);
  const cred = Array(buckets(cuts.credit)).fill(0n);  // bucket 0 = new-to-credit (NULL score)
  const age = Array(buckets(cuts.age)).fill(0n);
  const job = Object.fromEntries(EMPLOYMENT.map((e) => [e, 0n]));

  products.forEach((p, i) => {
    const bit = 1n << BigInt(i);
    const minInc = num(p.min_monthly_income), minCs = num(p.min_credit_score);
    const minAge = num(p.min_age), maxAge = num(p.max_age);
    const kInc = minInc === null ? -1 : cuts.income.indexOf(minInc);
    const kCs = minCs === null ? -1 : cuts.credit.indexOf(minCs);
    const kMin = minAge === null ? -1 : cuts.age.indexOf(minAge);
    const kMax = maxAge === null ? Infinity : cuts.age.indexOf(maxAge + 1);
    for (let b = 0; b < inc.length; b++) if (b >= kInc + 1) inc[b] |= bit;
    for (let b = 1; b < cred.length; b++) if (b >= kCs + 1) cred[b] |= bit;
    if (p.accepts_ntc === true) cred[0] |= bit;  // NTC users only match products that accept them
    for (let b = 0; b < age.length; b++) if (b >= kMin + 1 && b <= kMax) age[b] |= bit;
    const types = Array.isArray(p.employment_types) && p.employment_types.length ? p.employment_types : EMPLOYMENT;
    for (const e of types) if (e in job) job[e] |= bit;
  });
  return { inc, cred, age, job };
}

function popcount(x) {
  let n = 0;
  for (; x; x &= x - 1n) n++;
  return n;
}

/** The value range a bucket stands for — what the LLM sees instead of any real person's data. */
function bucketRange(cuts, b) {
  if (b <= 0) return { min: null, max: cuts[0] };
  return { min: cuts[b - 1], max: b < cuts.length ? cuts[b] : null };  // [min, max)
}

function classFeatures(cls, cuts) {
  return {
    monthly_income: bucketRange(cuts.income, cls.ib),
    credit_score: cls.cb === 0 ? "no credit history" : bucketRange(cuts.credit, cls.cb),
    age: bucketRange(cuts.age, cls.ab),
    employment_status: cls.emp,
  };
}

function cacheKey(product, ruleIndex, rule, cls, cuts) {
  // Project onto ONLY the features this rule depends on: classes that differ elsewhere share a key.
  const f = classFeatures(cls, cuts);
  const projected = [...rule.depends_on].sort().map((d) => `${d}=${JSON.stringify(f[d])}`).join("|");
  return `${product.id}:${String(product.criteria_hash).slice(0, 12)}:${ruleIndex}:${projected}`;
}

/**
 * Match every class against every product.
 * @param classes   [{ib, cb, ab, emp, n}] from SQL (n = users in the class)
 * @param products  active loan_products rows
 * @param judgments {cache_key: "PASS"|"FAIL"|"UNKNOWN"} — LLM verdicts known so far
 * @returns rows (class × product results for SQL), pending (uncached LLM questions), funnel metrics
 */
function matchClasses(classes, products, cuts, judgments = {}) {
  const masks = attributeMasks(products, cuts);
  const rows = [];
  const pending = new Map();
  const funnel = { users: 0, products: products.length, classes: classes.length, naive_pairs: 0,
                   after_hard_rules: 0, needing_soft_rules: 0, llm_keys: 0, llm_cache_hits: 0, matches: 0, likely: 0 };

  for (const raw of classes) {
    const cls = { ib: Number(raw.ib), cb: Number(raw.cb), ab: Number(raw.ab), emp: raw.emp, n: Number(raw.n) };
    funnel.users += cls.n;
    let mask = masks.inc[cls.ib] & masks.cred[cls.cb] & masks.age[cls.ab] & (masks.job[cls.emp] ?? 0n);
    funnel.after_hard_rules += cls.n * popcount(mask);

    for (let i = 0; mask; i++, mask >>= 1n) {
      if (!(mask & 1n)) continue;
      const p = products[i];
      const unverified = [];
      let rejected = false, usedLlm = false;
      const rules = Array.isArray(p.soft_rules) ? p.soft_rules : [];
      if (rules.length) funnel.needing_soft_rules += cls.n;

      rules.forEach((rule, ri) => {
        const deps = Array.isArray(rule.depends_on) ? rule.depends_on : [];
        if (!deps.length || !deps.every((d) => KNOWN_FEATURES.has(d))) {
          unverified.push(rule.text);  // needs data we don't hold: never guess
          return;
        }
        const key = cacheKey(p, ri, rule, cls, cuts);
        const verdict = judgments[key];
        if (verdict === undefined) {
          if (!pending.has(key)) pending.set(key, { cache_key: key, product_id: Number(p.id), rule: rule.text,
                                                    features: Object.fromEntries(deps.map((d) => [d, classFeatures(cls, cuts)[d]])) });
          unverified.push(rule.text);
        } else {
          funnel.llm_cache_hits += 1;
          usedLlm = true;
          if (verdict === "FAIL") rejected = true;
          else if (verdict === "UNKNOWN") unverified.push(rule.text);
        }
      });
      if (rejected) continue;

      const status = unverified.length ? "LIKELY" : "ELIGIBLE";
      rows.push({ ib: cls.ib, cb: cls.cb, ab: cls.ab, emp: cls.emp, product_id: Number(p.id), status,
                  score: score(p, unverified.length), unverified, decided_by: usedLlm ? "LLM" : "RULES" });
      funnel.matches += cls.n;
      if (status === "LIKELY") funnel.likely += cls.n;
    }
  }
  funnel.naive_pairs = funnel.users * products.length;
  funnel.llm_keys = pending.size;
  return { rows, pending: [...pending.values()], funnel };
}

/** Ranking: cheaper credit first; each unverifiable condition costs a little confidence. */
function score(product, unverifiedCount) {
  const rate = num(product.interest_rate_min);
  return Math.round((100 - (rate === null ? 30 : rate) * 2 - unverifiedCount * 5) * 100) / 100;
}

if (typeof module !== "undefined") {
  module.exports = { buildCuts, pgArray, attributeMasks, matchClasses, classFeatures, popcount, score };
}
