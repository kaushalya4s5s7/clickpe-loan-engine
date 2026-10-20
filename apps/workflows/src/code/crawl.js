// Workflow A helpers: page → relevant text → validated, normalised loan products.
// Pure functions (plus node's crypto). Unit-tested in tests/crawl.test.js against real page snapshots.
//
// Layout-change strategy (the brief's optional enhancement): we never depend on CSS selectors
// or page structure. We read visible text, keep only windows around eligibility keywords, and
// let the LLM read prose. A redesign that moves or restyles the section doesn't break us.
// The guard rails catch what layout-agnostic extraction can get wrong:
// verbatim evidence, plausibility ranges, and "empty result = failure, keep old data".

const crypto = require("crypto");

const DROP_BLOCKS = /<(script|style|noscript|svg|template|iframe|header|nav|footer|form|select)\b[^>]*>[\s\S]*?<\/\1>/gi;
const BLOCK_TAGS = /<\/?(p|div|section|article|h[1-6]|li|ul|ol|tr|table|br|td|th|dd|dt)\b[^>]*>/gi;
const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "'", lsquo: "'",
                   rdquo: '"', ldquo: '"', ndash: "-", mdash: "-", hellip: "...", bull: "•", rupee: "₹" };

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

const stripTags = (html) => html
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(DROP_BLOCKS, " ")
  .replace(BLOCK_TAGS, "\n")
  .replace(/<[^>]+>/g, " ");

/** Visible text, one logical block per line. Navigation, menus and footers are dropped. */
function htmlToText(html) {
  // Two passes: some CMSs (HDFC's, for one) ship content as entity-encoded HTML inside an
  // attribute, so after decoding once the text still contains tags.
  const text = decodeEntities(stripTags(decodeEntities(stripTags(html))));
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line && line !== out[out.length - 1]) out.push(line);
  }
  return out.join("\n");
}

const KEYWORDS = /eligib|\bincome\b|salar|self[- ]employed|\bage\b|\byears?\b|cibil|credit score|interest|% ?p\.?a|per annum|\brates?\b|tenure|loan amount|lakh|crore|minimum|maximum|employ|experience|vintage|turnover/i;

/** Inline widget config (calculator JSON etc.) leaks into text on some CMSs. It isn't prose. */
const looksLikeData = (line) => line.length > 1500 || (line.match(/"\s*:\s*["\[{\d]/g) || []).length >= 3;

/**
 * Keyword windowing: keep each matching line plus `radius` lines around it.
 * A 1.2 MB bank page becomes ~2-6 KB — roughly 10-50x fewer LLM tokens, and the model
 * isn't distracted by menus. Lines repeated across the page (mega-menus) are kept once.
 */
function relevantSection(text, { radius = 1, maxChars = 6000 } = {}) {
  const lines = text.split("\n");
  const keep = new Set();
  lines.forEach((line, i) => {
    if (line.length >= 12 && KEYWORDS.test(line)) {
      for (let j = Math.max(0, i - radius); j <= Math.min(lines.length - 1, i + radius); j++) keep.add(j);
    }
  });
  const seen = new Set();
  const out = [];
  let size = 0;
  for (const i of [...keep].sort((a, b) => a - b)) {
    const line = lines[i];
    if (seen.has(line) || looksLikeData(line)) continue;  // menus repeat; config JSON isn't prose
    seen.add(line);
    if (size + line.length > maxChars) break;
    out.push(line);
    size += line.length + 1;
  }
  return out.join("\n");
}

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

// ------------------------------------------------------------------ validation of LLM output

const EMPLOYMENT = ["Salaried", "Self-Employed", "Business"];
const RANGES = {
  interest_rate_min: [1, 60], interest_rate_max: [1, 60], min_monthly_income: [1000, 10_000_000],
  min_credit_score: [300, 900], min_age: [18, 80], max_age: [18, 80], max_loan_amount: [1000, 1e9],
  max_tenure_months: [1, 480],
};
// Which evidence quote supports which field (one quote may support a min/max pair).
const EVIDENCE_KEY = { interest_rate_min: "interest_rate", interest_rate_max: "interest_rate",
                       min_age: "age", max_age: "age" };

const norm = (s) => String(s ?? "").toLowerCase().replace(/rs\.?|inr/g, "₹").replace(/[\s,]+/g, " ").trim();

const UNITS = { lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, crore: 1e7, crores: 1e7, cr: 1e7, k: 1e3 };

/** Every number written in a quote, as a value: "₹25,000" → 25000, "₹40 lakh" → 4000000, "9.99%" → 9.99. */
function numbersIn(quote) {
  const out = [];
  for (const m of String(quote).matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr\b|k\b)?/gi)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n * (UNITS[(m[2] || "").toLowerCase()] ?? 1));
  }
  return out;
}

/** Is `value` one of the quote's numbers (allowing an annual ↔ monthly conversion)? */
function numberAppears(value, quote) {
  const close = (a, b) => Math.abs(a - b) <= 0.005 * Math.max(1, Math.abs(b));
  return numbersIn(quote).some((n) => close(n, value) || close(n / 12, value) || close(n * 12, value));
}

function toNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,₹%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Turn the LLM's JSON into rows we trust. Every typed field must be backed by a quote that
 * appears VERBATIM in the page text and contains the number; otherwise the field is dropped
 * (null = "not stated" = passes). This is what makes prompt injection or hallucination on a
 * crawled page unable to invent eligibility rules.
 */
function validateProducts(extracted, { lender, sourceText, sourceUrl }) {
  const page = norm(sourceText);
  const warnings = [];
  const products = [];
  for (const raw of Array.isArray(extracted?.products) ? extracted.products : []) {
    const name = String(raw.product_name ?? "").trim().slice(0, 120);
    if (!name) continue;
    const evidence = raw.evidence && typeof raw.evidence === "object" ? raw.evidence : {};
    const p = { lender_name: lender, product_name: name, source_url: sourceUrl, evidence: {} };

    for (const [field, [lo, hi]] of Object.entries(RANGES)) {
      const value = toNumber(raw[field]);
      if (value === null) { p[field] = null; continue; }
      const key = EVIDENCE_KEY[field] ?? field;
      const quote = String(evidence[key] ?? evidence[field] ?? "");
      if (value < lo || value > hi) {
        warnings.push(`${name}.${field}=${value} outside ${lo}-${hi}`);
        p[field] = null;
      } else if (!quote || !page.includes(norm(quote)) || !numberAppears(value, quote)) {
        warnings.push(`${name}.${field}=${value} has no verbatim supporting quote`);
        p[field] = null;
      } else {
        p[field] = value;
        p.evidence[key] = quote.slice(0, 300);
      }
    }
    if (p.min_age !== null && p.max_age !== null && p.min_age > p.max_age) [p.min_age, p.max_age] = [null, null];
    if (p.interest_rate_min !== null && p.interest_rate_max !== null && p.interest_rate_min > p.interest_rate_max) {
      [p.interest_rate_min, p.interest_rate_max] = [p.interest_rate_max, p.interest_rate_min];
    }
    if (p.interest_rate_max === null) p.interest_rate_max = p.interest_rate_min;

    const types = (Array.isArray(raw.employment_types) ? raw.employment_types : []).filter((t) => EMPLOYMENT.includes(t));
    p.employment_types = types.length ? [...new Set(types)].sort() : null;  // null = any
    p.accepts_ntc = raw.accepts_ntc === true && page.includes(norm(evidence.accepts_ntc ?? "\u0000"));
    p.soft_rules = (Array.isArray(raw.soft_rules) ? raw.soft_rules : [])
      .filter((r) => r && typeof r.text === "string" && r.text.trim())
      .slice(0, 8)
      .map((r) => ({ text: r.text.trim().slice(0, 300),
                     depends_on: (Array.isArray(r.depends_on) ? r.depends_on : []).map(String).slice(0, 4) }));

    p.product_key = sha256(`${lender.toLowerCase()}|${name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`).slice(0, 32);
    p.criteria_hash = sha256(JSON.stringify([p.min_monthly_income, p.min_credit_score, p.accepts_ntc, p.min_age,
      p.max_age, p.employment_types, p.soft_rules])).slice(0, 32);
    products.push(p);
  }
  // Same product named twice (e.g. once per page): keep the one with more facts.
  const byKey = new Map();
  for (const p of products) {
    const facts = Object.keys(RANGES).filter((f) => p[f] !== null).length;
    if (!byKey.has(p.product_key) || facts > byKey.get(p.product_key).facts) byKey.set(p.product_key, { p, facts });
  }
  return { products: [...byKey.values()].map((v) => v.p), warnings };
}

if (typeof module !== "undefined") {
  module.exports = { htmlToText, relevantSection, sha256, validateProducts, numberAppears, decodeEntities };
}
