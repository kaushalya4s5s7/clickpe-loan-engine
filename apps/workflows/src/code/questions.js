// Workflow C/D helpers: which "to confirm" questions to ask a person, and the signed link to ask them.
//
// A LIKELY match is blocked by soft rules about data the CSV doesn't have (work experience,
// employer type, bank relationship...). Across 10,000 real users only ~5 unknown facts block
// tens of thousands of matches, so a few well-chosen questions unlock most of them. The planner
// picks, per person, the ≤ 3 questions that unlock the most offers worth showing.
// Answers are SELF-DECLARED: the lender still verifies documents at application.

const crypto = require("crypto");

const EMPLOYER_TYPES = [
  ["central_state_govt", "Central / State Government"], ["psu", "Public sector undertaking (PSU)"],
  ["mnc", "Multinational company (MNC)"], ["public_ltd", "Public limited company"],
  ["private_ltd", "Private limited company"], ["partnership_proprietorship", "Partnership / Proprietorship"],
  ["other", "Other"],
];

/** Canonical question ids (shared with Workflow D's form and the console). Order = display order. */
const QUESTIONS = [
  { id: "work_experience", label: "How long have you been working?", answers: ["work_experience"],
    input: { type: "numbers", fields: [
      { name: "total_experience_years", label: "Total work experience (years)", min: 0, max: 60 },
      { name: "current_job_years", label: "Years with your current employer", min: 0, max: 60 }] } },
  { id: "employer_type", label: "Who do you work for?", answers: ["employer_type"],
    input: { type: "select", name: "employer_type", options: EMPLOYER_TYPES.map(([value, label]) => ({ value, label })) } },
  { id: "bank_accounts", label: "Do you have a savings or salary account with any of these banks?", answers: ["bank_relationship"],
    input: { type: "multiselect", name: "bank_accounts", options: "relevant_lenders", none: "none" } },
  { id: "city", label: "Which city do you live in?", answers: ["city"],
    input: { type: "text", name: "city", maxLength: 80 } },
  { id: "business_vintage", label: "How many years has your business been running?", answers: ["business_vintage"],
    input: { type: "number", name: "business_years", min: 0, max: 100 } },
  { id: "existing_emi", label: "How much do you pay in EMIs each month today?", answers: ["emi"],
    input: { type: "number", name: "existing_emi_monthly", min: 0, unit: "₹" } },
];
const QUESTION_BY_ID = Object.fromEntries(QUESTIONS.map((q) => [q.id, q]));
const ORDER = Object.fromEntries(QUESTIONS.map((q, i) => [q.id, i]));

const KNOWN_FEATURES = new Set(["monthly_income", "credit_score", "age", "employment_status"]);  // = matcher.js
const FEATURE_QUESTION = { work_experience: "work_experience", employer_type: "employer_type",
  bank_relationship: "bank_accounts", city: "city", business_vintage: "business_vintage" };
const EMI_RULE = /\bEMI|repay|obligation/i;

/**
 * Question ids that would let us re-check one soft rule, or null if no question can (stays LIKELY).
 * @param rule           {text, depends_on:[feature]}
 * @param verdictUnknown true when the rule only uses data we hold but the judge said UNKNOWN —
 *                       e.g. "income should be sufficient to repay the EMI": askable via existing EMIs.
 */
function askableQuestions(rule, verdictUnknown = false) {
  const deps = Array.isArray(rule?.depends_on) ? rule.depends_on : [];
  const emi = EMI_RULE.test(String(rule?.text ?? ""));
  const ids = new Set();
  for (const d of deps) {
    if (KNOWN_FEATURES.has(d)) continue;  // we already hold it
    if (FEATURE_QUESTION[d]) ids.add(FEATURE_QUESTION[d]);
    else if (d === "other" && emi) ids.add("existing_emi");
    else return null;  // "other" (non-EMI) or a feature we have no question for
  }
  if (!ids.size) {
    if (deps.length && verdictUnknown && emi) ids.add("existing_emi");
    else return null;  // nothing a person could tell us would change the verdict
  }
  return [...ids].sort((a, b) => ORDER[a] - ORDER[b]);
}

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const productOf = (productsById, id) => (productsById instanceof Map ? productsById.get(Number(id)) ?? productsById.get(String(id))
  : productsById?.[id]) ?? null;
/** matcher.score() with nothing left unverified — what the offer would rank at once unlocked. */
const unlockedScore = (p) => Math.round((100 - (num(p?.interest_rate_min) ?? 30) * 2) * 100) / 100;

/**
 * Blocking question set for one LIKELY match, or null if any unverified rule can't be asked about.
 * Rule texts are looked up in the product's soft_rules; an unknown text (catalogue changed) → null.
 */
function blockingSet(match, product) {
  const rules = Array.isArray(product?.soft_rules) ? product.soft_rules : [];
  const unverified = Array.isArray(match.unverified) ? match.unverified : [];
  if (!unverified.length) return null;
  const ids = new Set();
  for (const text of unverified) {
    const rule = rules.find((r) => r.text === text);
    if (!rule) return null;
    // An unverified rule built only from known features means the judge couldn't decide (or never ran).
    const deps = Array.isArray(rule.depends_on) ? rule.depends_on : [];
    const asks = askableQuestions(rule, deps.length > 0 && deps.every((d) => KNOWN_FEATURES.has(d)));
    if (!asks) return null;
    asks.forEach((q) => ids.add(q));
  }
  return ids;
}

function* subsets(ids, max) {
  const n = ids.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const s = ids.filter((_, i) => mask & (1 << i));
    if (s.length <= max) yield s;
  }
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * Choose the questions to ask one person.
 * @param user          {user_id, ...} (unused today; kept so callers don't change if rules need it)
 * @param matches       [{product_id, status, score, unverified:[rule text]}]
 * @param productsById  {id: {id, lender_name, interest_rate_min, soft_rules}} or a Map
 * @returns {questions:[id], unlockable, lenders:[name], mentions:[{question, text}],
 *           bank_options:[lender name], product_ids:[id]}
 */
function planQuestions(user, matches, productsById, opts = {}) {
  const maxQuestions = opts.maxQuestions ?? 3, maxCards = opts.maxCards ?? 5;
  // Never ask twice: an offer still blocked by a question the person already answered can't be
  // helped by asking again (their answer was judged unclear, or it is waiting for the next re-check).
  const answered = new Set(opts.answered || []);
  const eligibleScores = (matches || []).filter((m) => m.status === "ELIGIBLE").map((m) => num(m.score) ?? 0);

  const candidates = [];
  for (const m of matches || []) {
    if (m.status !== "LIKELY") continue;
    const p = productOf(productsById, m.product_id);
    if (!p) continue;
    const blocking = blockingSet(m, p);
    if (!blocking || [...blocking].some((q) => answered.has(q))) continue;
    // Worth asking only if the unlocked offer would make the top cards; otherwise we'd ask for nothing.
    const s = unlockedScore(p);
    if (eligibleScores.filter((e) => e >= s).length >= maxCards) continue;
    candidates.push({ m, p, blocking, score: s });
  }
  const empty = { questions: [], unlockable: 0, lenders: [], mentions: [], bank_options: [], product_ids: [] };
  if (!candidates.length) return empty;

  // ≤ 6 ids → ≤ 63 subsets: exhaustive search is exact and cheap.
  const ids = [...new Set(candidates.flatMap((c) => [...c.blocking]))].sort((a, b) => ORDER[a] - ORDER[b]);
  let best = null;
  for (const s of subsets(ids, maxQuestions)) {
    const set = new Set(s);
    const unlocked = candidates.filter((c) => [...c.blocking].every((q) => set.has(q)));
    const value = unlocked.reduce((t, c) => t + c.score, 0);
    if (!best || unlocked.length > best.unlocked.length
        || (unlocked.length === best.unlocked.length && (s.length < best.s.length
            || (s.length === best.s.length && value > best.value)))) best = { s, unlocked, value };
  }
  if (!best.unlocked.length) return empty;

  const unlocked = [...best.unlocked].sort((a, b) => b.score - a.score);
  const lenders = [...new Set(unlocked.map((c) => c.p.lender_name))];
  const mentions = best.s.map((q) => {
    const c = unlocked.find((x) => x.blocking.has(q));
    const rule = c.m.unverified.find((t) => (askableQuestions(c.p.soft_rules.find((r) => r.text === t), true) || []).includes(q));
    return { question: q, text: clip(`${c.p.lender_name}: ${rule}`, 140) };
  });
  return {
    questions: best.s, unlockable: unlocked.length, lenders, mentions,
    bank_options: best.s.includes("bank_accounts") ? bankOptions(unlocked) : [],
    product_ids: unlocked.map((c) => Number(c.m.product_id)),
  };
}

/** Only lenders whose own rule asks about a banking relationship — not every bank we know of. */
function bankOptions(unlocked) {
  return [...new Set(unlocked.filter((c) => c.blocking.has("bank_accounts")).map((c) => c.p.lender_name))];
}

/**
 * Console aggregate over Workflow B's class × product rows. Every user in a class has the same
 * matches, so plan once per class and multiply by its size: O(classes), not O(users).
 * @param classRows  matcher.matchClasses().rows — {ib, cb, ab, emp, product_id, status, score, unverified}
 * @param opts       {maxQuestions, maxCards, classes:[{ib, cb, ab, emp, n}]} (row.n also accepted)
 * @returns {users_to_ask, unlockable_matches, by_question:[{id, label, users, unlockable}]}
 */
function planForClasses(classRows, productsById, opts = {}) {
  const key = (r) => `${r.ib}|${r.cb}|${r.ab}|${r.emp}`;
  const sizes = new Map((opts.classes || []).map((c) => [key(c), Number(c.n)]));
  const groups = new Map();
  for (const r of classRows || []) (groups.get(key(r)) ?? groups.set(key(r), []).get(key(r))).push(r);

  const out = { users_to_ask: 0, unlockable_matches: 0, by_question: [] };
  const byQ = new Map();
  for (const [k, rows] of groups) {
    const n = sizes.get(k) ?? Number(rows[0].n ?? 1);
    const plan = planQuestions(null, rows, productsById, opts);
    if (!plan.questions.length) continue;
    out.users_to_ask += n;
    out.unlockable_matches += n * plan.unlockable;
    for (const q of plan.questions) {
      const agg = byQ.get(q) ?? byQ.set(q, { id: q, label: QUESTION_BY_ID[q].label, users: 0, unlockable: 0 }).get(q);
      agg.users += n;
      // Matches that needed this question (a match needing two questions counts under both).
      agg.unlockable += n * plan.product_ids.filter((pid) => {
        const row = rows.find((r) => Number(r.product_id) === pid);
        return blockingSet(row, productOf(productsById, pid))?.has(q);
      }).length;
    }
  }
  out.by_question = [...byQ.values()].sort((a, b) => b.users - a.users || ORDER[a.id] - ORDER[b.id]);
  return out;
}

// ---- signed link -------------------------------------------------------------------------------
// Same secret as the unsubscribe token, domain-separated by the "c." prefix inside the MAC'd
// payload: an unsubscribe token can't open the form, and a confirm token can't unsubscribe.
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const mac = (payload, secret) => crypto.createHmac("sha256", String(secret)).update(payload).digest().subarray(0, 16);

function confirmToken(userId, secret, nowSeconds, ttl = 14 * 24 * 3600) {
  const payload = `c.${b64url(Buffer.from(String(userId), "utf8"))}.${nowSeconds + ttl}`;
  return `${payload}.${b64url(mac(payload, secret))}`;
}

/** `${WEBHOOK_URL}webhook/confirm?t=…`, tolerant of a missing trailing slash; null when unconfigured. */
function confirmLink(webhookBase, userId, secret, nowSeconds) {
  const base = String(webhookBase ?? "").trim();
  if (!base || !secret) return null;
  return `${base.replace(/\/*$/, "/")}webhook/confirm?t=${encodeURIComponent(confirmToken(userId, secret, nowSeconds))}`;
}

/** → {ok: true, userId} | {ok: false, reason}. The reason is for logs, never for the page. */
function verifyConfirmToken(token, secret, nowSeconds) {
  if (!secret) return { ok: false, reason: "no secret" };
  const parts = String(token ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== "c" || !/^\d+$/.test(parts[2])) return { ok: false, reason: "malformed" };
  const expected = mac(parts.slice(0, 3).join("."), secret);
  const given = Buffer.from(parts[3].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: "bad signature" };
  if (Number(parts[2]) <= nowSeconds) return { ok: false, reason: "expired" };
  const userId = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return userId ? { ok: true, userId } : { ok: false, reason: "malformed" };
}

if (typeof module !== "undefined") {
  module.exports = { QUESTIONS, EMPLOYER_TYPES, askableQuestions, planQuestions, planForClasses,
                     unlockedScore, confirmToken, verifyConfirmToken, confirmLink };
}
