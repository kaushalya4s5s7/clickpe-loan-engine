// Workflow D helpers: the "confirm a few details" form, answer checks, re-judging a person's
// LIKELY matches with their answers, and the "you now pre-qualify" page + email.
//
// Answers are SELF-DECLARED. Nothing here says "approved": an unlocked match is "pre-qualified
// based on your answers", and the lender verifies documents at application. Answers that
// contradict each other (or the CSV) are flagged for ops and never used.
//
// Depends on questions.js (question metadata, askableQuestions) and email.js (escaping, INR,
// card helpers). In n8n those modules are inlined before this one (build.py include()), so the
// names `questions` / `email` already exist; under node --test they are required.

/* eslint-disable no-undef */
const Q = typeof questions !== "undefined" ? questions : require("./questions.js");
const E = typeof email !== "undefined" ? email : require("./email.js");
/* eslint-enable no-undef */

const { escapeHtml, formatINR } = E;
const KNOWN_FEATURES = new Set(["monthly_income", "credit_score", "age", "employment_status"]);  // = matcher.js
const QUESTION_BY_ID = Object.fromEntries(Q.QUESTIONS.map((q) => [q.id, q]));
const EMPLOYER_LABEL = Object.fromEntries(Q.EMPLOYER_TYPES);
// Employer types only an employee can have. (Not the reverse: a salaried person can work for a
// partnership or proprietorship firm, so that answer is never a contradiction.)
const SALARIED_EMPLOYERS = new Set(["central_state_govt", "psu", "mnc", "public_ltd", "private_ltd"]);
const MAX_EMI = 10_000_000;  // ₹1 crore a month: anything above is a typo, not an answer
const MIN_WORKING_AGE = 18;

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const firstName = (name) => String(name ?? "").trim().split(/\s+/)[0] || "there";
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const years = (n) => `${n} year${Number(n) === 1 ? "" : "s"}`;
const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]).map((x) => String(x));

function rateText(p) {
  const lo = num(p.interest_rate_min), hi = num(p.interest_rate_max);
  if (lo === null) return "Rate: see lender website";
  return hi === null || lo === hi ? `Interest from ${lo}% p.a.` : `Interest ${lo}–${hi}% p.a.`;
}

/** matcher.score(): cheaper credit first, −5 per condition still to confirm. */
function score(product, unverifiedCount) {
  const rate = num(product.interest_rate_min);
  return Math.round((100 - (rate === null ? 30 : rate) * 2 - unverifiedCount * 5) * 100) / 100;
}

// ---- person / plan -----------------------------------------------------------------------------

/**
 * Split the loaded row (d_load_person.sql) into what questions.planQuestions() expects.
 * @returns {user, matches, productsById, likely}
 */
function planInputs(person) {
  const all = Array.isArray(person?.matches) ? person.matches : [];
  const productsById = {};
  for (const m of all) productsById[m.product_id] = { id: m.product_id, lender_name: m.lender_name,
    interest_rate_min: m.interest_rate_min, soft_rules: m.soft_rules || [] };
  const matches = all.map((m) => ({ product_id: m.product_id, status: m.status, score: num(m.score),
    unverified: Array.isArray(m.unverified) ? m.unverified : [] }));
  const user = { user_id: person?.user_id, age: person?.age, employment_status: person?.employment_status };
  return { user, matches, productsById, likely: all.filter((m) => m.status === "LIKELY") };
}

/** Banks a person may tick: the planner's list, else every lender they matched (lenient on re-submits). */
function allowedBanks(person, plan) {
  const fromPlan = Array.isArray(plan?.bank_options) ? plan.bank_options : [];
  const fromMatches = (person?.matches || []).map((m) => m.lender_name).filter(Boolean);
  return [...new Set([...fromPlan, ...fromMatches])];
}

// ---- answers -----------------------------------------------------------------------------------

/** Form field values (strings) from stored answers, for pre-filling the form. */
function answersToValues(answers) {
  const a = answers || {}, v = {};
  if (a.work_experience) {
    v.total_experience_years = String(a.work_experience.total_experience_years ?? "");
    v.current_job_years = String(a.work_experience.current_job_years ?? "");
  }
  if (a.employer_type) v.employer_type = String(a.employer_type);
  if (Array.isArray(a.bank_accounts)) v.bank_accounts = a.bank_accounts.length ? a.bank_accounts.map(String) : ["none"];
  if (a.city) v.city = String(a.city);
  if (a.business_vintage) v.business_years = String(a.business_vintage.business_years ?? "");
  if (a.existing_emi) v.existing_emi_monthly = String(a.existing_emi.existing_emi_monthly ?? "");
  return v;
}

/** Form body → raw field values. Accepts `name` repeated or `name[]` (body parsers differ). */
function formValues(body) {
  const b = body && typeof body === "object" ? body : {};
  const pick = (k) => (b[k] !== undefined ? b[k] : b[`${k}[]`]);
  const one = (k) => { const x = asList(pick(k)); return x.length ? x[0].trim().slice(0, 200) : ""; };
  return {
    total_experience_years: one("total_experience_years"), current_job_years: one("current_job_years"),
    employer_type: one("employer_type"),
    bank_accounts: asList(pick("bank_accounts")).map((s) => s.trim().slice(0, 200)).filter(Boolean),
    city: one("city"), business_years: one("business_years"), existing_emi_monthly: one("existing_emi_monthly"),
  };
}

function parseNumber(raw, { min, max, integer = false }) {
  const s = String(raw).replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return { error: "Please enter a number, like 3 or 2.5." };
  const n = Number(s);
  if (integer && !Number.isInteger(n)) return { error: "Please enter a whole number of rupees." };
  if (n < min || n > max) return { error: `Please enter a number between ${min} and ${max.toLocaleString("en-IN")}.` };
  return { value: n };
}

/**
 * Parse + validate submitted answers. Invalid input (not a number, out of range, unknown option)
 * is returned as `errors` per question so the form can be shown again — nothing is stored.
 * Blank questions are skipped; at least one answer is required.
 * @returns {answers: {question_id: value}, errors: {question_id|"form": message}}
 */
function parseAnswers(body, person, plan) {
  const v = formValues(body);
  const answers = {}, errors = {};
  const range = (qid, field) => {
    const input = QUESTION_BY_ID[qid].input;
    const f = input.fields ? input.fields.find((x) => x.name === field) : input;
    return { min: f.min ?? 0, max: f.max ?? MAX_EMI };
  };

  if (v.total_experience_years || v.current_job_years) {
    if (!v.total_experience_years || !v.current_job_years) errors.work_experience = "Please fill in both numbers.";
    else {
      const t = parseNumber(v.total_experience_years, range("work_experience", "total_experience_years"));
      const c = parseNumber(v.current_job_years, range("work_experience", "current_job_years"));
      if (t.error || c.error) errors.work_experience = t.error || c.error;
      else answers.work_experience = { total_experience_years: t.value, current_job_years: c.value };
    }
  }
  if (v.employer_type) {
    if (EMPLOYER_LABEL[v.employer_type]) answers.employer_type = v.employer_type;
    else errors.employer_type = "Please choose one of the options.";
  }
  if (v.bank_accounts.length) {
    const allowed = new Set(allowedBanks(person, plan));
    const banks = [...new Set(v.bank_accounts)];
    if (banks.includes("none") && banks.length > 1) errors.bank_accounts = "Choose banks, or “None of these” — not both.";
    else if (banks.some((b) => b !== "none" && !allowed.has(b))) errors.bank_accounts = "Please choose from the banks listed.";
    else answers.bank_accounts = banks.filter((b) => b !== "none");
  }
  if (v.city) {
    const city = v.city.replace(/\s+/g, " ").trim();
    if (city.length < 2 || city.length > 80 || !/^[\p{L}][\p{L}\p{M} .'-]*$/u.test(city)) errors.city = "Please enter your city's name.";
    else answers.city = city;
  }
  if (v.business_years) {
    const b = parseNumber(v.business_years, range("business_vintage", "business_years"));
    if (b.error) errors.business_vintage = b.error;
    else answers.business_vintage = { business_years: b.value };
  }
  if (v.existing_emi_monthly) {
    const e = parseNumber(v.existing_emi_monthly, { ...range("existing_emi", "existing_emi_monthly"), integer: true });
    if (e.error) errors.existing_emi = e.error;
    else answers.existing_emi = { existing_emi_monthly: e.value };
  }
  if (!Object.keys(answers).length && !Object.keys(errors).length) errors.form = "Please answer at least one question.";
  return { answers, errors, values: v };
}

/**
 * The plan to re-show the form with after invalid input: the planned questions plus any the
 * person filled in (the plan may have changed since the form was served), in canonical order.
 */
function retryPlan(plan, parsed) {
  const v = parsed.values || {};
  const touched = new Set(Object.keys(parsed.errors || {}).filter((k) => QUESTION_BY_ID[k]));
  Object.keys(parsed.answers || {}).forEach((k) => touched.add(k));
  if (v.total_experience_years || v.current_job_years) touched.add("work_experience");
  if (v.employer_type) touched.add("employer_type");
  if ((v.bank_accounts || []).length) touched.add("bank_accounts");
  if (v.city) touched.add("city");
  if (v.business_years) touched.add("business_vintage");
  if (v.existing_emi_monthly) touched.add("existing_emi");
  (plan?.questions || []).forEach((q) => touched.add(q));
  const questions = Q.QUESTIONS.map((q) => q.id).filter((id) => touched.has(id));
  return { ...(plan || {}), questions, unlockable: plan?.unlockable ?? 0, mentions: plan?.mentions || [], lenders: plan?.lenders || [] };
}

/** Newer answers replace older ones per question; questions not asked this time are kept. */
const mergeAnswers = (previous, fresh) => ({ ...(previous && typeof previous === "object" ? previous : {}), ...fresh });

/**
 * Contradictions between answers, or with the CSV. Any reason → the declaration is flagged for
 * ops review and not used. Reasons are for ops, never shown to the person.
 */
function sanityCheck(answers, person) {
  const reasons = [];
  const age = num(person?.age), emp = person?.employment_status;
  const maxYears = age === null ? null : age - MIN_WORKING_AGE;
  const we = answers.work_experience;
  if (we) {
    if (maxYears !== null && we.total_experience_years > maxYears)
      reasons.push(`total experience ${years(we.total_experience_years)} > age ${age} − ${MIN_WORKING_AGE}`);
    if (we.current_job_years > we.total_experience_years)
      reasons.push(`current job ${years(we.current_job_years)} > total experience ${years(we.total_experience_years)}`);
  }
  const bv = answers.business_vintage;
  if (bv && maxYears !== null && bv.business_years > maxYears)
    reasons.push(`business running ${years(bv.business_years)} > age ${age} − ${MIN_WORKING_AGE}`);
  const et = answers.employer_type;
  if (et && emp && emp !== "Salaried" && SALARIED_EMPLOYERS.has(et))
    reasons.push(`${emp} applicant chose a salaried employer type (${et})`);
  const emi = answers.existing_emi?.existing_emi_monthly, income = num(person?.monthly_income);
  if (emi != null && income !== null && emi > income)
    reasons.push(`existing EMIs ${formatINR(emi)}/month > monthly income ${formatINR(income)}`);
  return reasons;
}

// ---- re-judging --------------------------------------------------------------------------------

const answered = (answers, qid) => answers[qid] !== undefined;

/** What the judge sees for one rule: the person's exact CSV values + their declared answers. */
function judgeFeatures(person, answers, rule, asks) {
  const f = {};
  const deps = Array.isArray(rule.depends_on) ? rule.depends_on : [];
  const known = {
    monthly_income: num(person.monthly_income),
    credit_score: person.credit_score == null ? "no credit history" : num(person.credit_score),
    age: num(person.age), employment_status: person.employment_status,
  };
  for (const d of deps) if (KNOWN_FEATURES.has(d)) f[d] = known[d];
  for (const q of asks) {
    const a = answers[q];
    if (q === "work_experience") f.work_experience = { total_years: a.total_experience_years, years_in_current_job: a.current_job_years };
    if (q === "employer_type") f.employer_type = EMPLOYER_LABEL[a] ?? a;
    if (q === "bank_accounts") f.bank_relationship = a.length
      ? `has a savings or salary account with: ${a.join(", ")}`
      : "has no savings or salary account with any of the banks asked about";
    if (q === "city") f.city = a;
    if (q === "business_vintage") f.business_vintage = { years: a.business_years };
    if (q === "existing_emi") {
      f.existing_emi_monthly_inr = a.existing_emi_monthly;
      f.monthly_income = known.monthly_income;
    }
  }
  f.source = "applicant's own declaration; the lender verifies documents at application";
  return f;
}

/**
 * One judge item per unverified rule of a LIKELY match that the answers now cover.
 * cache_key is per request (`product:index`): personal answers are never written to the shared
 * LLM cache, which is keyed by class ranges.
 * @returns [{cache_key, product_id, rule, features}]  — the shape llm.judgmentRequest() takes
 */
function judgeItems(person, answers) {
  const items = [];
  for (const m of planInputs(person).likely) {
    const rules = Array.isArray(m.soft_rules) ? m.soft_rules : [];
    (Array.isArray(m.unverified) ? m.unverified : []).forEach((text, i) => {
      const rule = rules.find((r) => r.text === text);
      if (!rule) return;  // catalogue changed since matching: leave it for the next match run
      const deps = Array.isArray(rule.depends_on) ? rule.depends_on : [];
      const asks = Q.askableQuestions(rule, deps.length > 0 && deps.every((d) => KNOWN_FEATURES.has(d)));
      if (!asks || !asks.every((q) => answered(answers, q))) return;
      items.push({ cache_key: `${m.product_id}:${i}`, product_id: Number(m.product_id), rule: text,
                   features: judgeFeatures(person, answers, rule, asks) });
    });
  }
  return items;
}

/**
 * Apply verdicts to the person's LIKELY matches.
 *   every unverified rule PASS → "unlock"  (ELIGIBLE, decided_by DECLARED, unverified [])
 *   any FAIL                   → "reject"  (the match is deleted)
 *   some PASS, rest open       → "narrow"  (still LIKELY, fewer conditions, score recomputed)
 *   nothing judged             → no change
 * @param judgments llm.parseJudgments() output [{cache_key, verdict}]
 * @returns {updates:[{product_id, action, score, unverified}], unlocked:[match], narrowed, rejected}
 */
function decide(person, items, judgments) {
  const verdict = new Map((judgments || []).map((j) => [j.cache_key, j.verdict]));
  const judgedKeys = new Set((items || []).map((i) => i.cache_key));
  const updates = [], unlocked = [];
  let narrowed = 0, rejected = 0;
  for (const m of planInputs(person).likely) {
    const texts = Array.isArray(m.unverified) ? m.unverified : [];
    const keys = texts.map((_, i) => `${m.product_id}:${i}`);
    if (!keys.some((k) => judgedKeys.has(k) && verdict.has(k))) continue;
    if (keys.some((k) => judgedKeys.has(k) && verdict.get(k) === "FAIL")) {
      updates.push({ product_id: Number(m.product_id), action: "reject", score: num(m.score), unverified: texts });
      rejected++;
      continue;
    }
    const remaining = texts.filter((_, i) => !(judgedKeys.has(keys[i]) && verdict.get(keys[i]) === "PASS"));
    if (remaining.length === texts.length) continue;  // only UNKNOWNs: nothing changes
    if (!remaining.length) {
      updates.push({ product_id: Number(m.product_id), action: "unlock", score: score(m, 0), unverified: [] });
      unlocked.push({ ...m, status: "ELIGIBLE", unverified: [], score: score(m, 0) });
    } else {
      updates.push({ product_id: Number(m.product_id), action: "narrow", score: score(m, remaining.length), unverified: remaining });
      narrowed++;
    }
  }
  unlocked.sort((a, b) => b.score - a.score);
  return { updates, unlocked, narrowed, rejected };
}

// ---- pages -------------------------------------------------------------------------------------

const STYLE = `:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#f4f4f5;color:#18181b;font:16px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px 40px}
h1{font-size:22px;line-height:1.3;margin:0 0 8px}
p{margin:0 0 12px}
.card{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:20px;margin:0 0 16px}
fieldset{border:0;padding:0;margin:0}
legend{font-size:17px;font-weight:700;padding:0;margin:0 0 4px}
label{display:block;font-size:15px;margin:12px 0 4px}
input[type=text],input[type=number],select{width:100%;min-height:44px;padding:8px 12px;font:inherit;color:inherit;border:1px solid #a1a1aa;border-radius:8px;background:#fff}
.check{display:flex;align-items:center;gap:10px;min-height:44px;margin:0}
.check input{width:22px;height:22px;margin:0;flex:none}
.why{margin:6px 0 0;padding-left:18px;font-size:13px;color:#52525b}
.note{font-size:14px;color:#3f3f46}
.small{font-size:13px;color:#52525b}
.err{color:#b91c1c;font-size:14px;font-weight:600;margin:8px 0 0}
.alert{border-color:#fca5a5;background:#fef2f2}
button{display:block;width:100%;min-height:48px;margin-top:4px;border:0;border-radius:8px;background:#4338ca;color:#fff;font:inherit;font-weight:600;cursor:pointer}
a{color:#4338ca}
.btn{display:inline-block;margin-top:10px;padding:10px 16px;border-radius:8px;background:#4338ca;color:#fff;text-decoration:none;font-size:14px;font-weight:600}
.lender{font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:.04em}
.product{font-size:18px;font-weight:700;margin:2px 0 4px}
.ok{color:#15803d;font-weight:600;font-size:14px;margin-top:8px}
:focus-visible{outline:3px solid #a5b4fc;outline-offset:2px}`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

function expiredPage() {
  return page("Link expired", `<div class="card"><h1>This link has expired</h1>
<p>Links in our emails work for 14 days. Nothing else is needed from you — we'll include a fresh link in our next email if there's anything to confirm.</p></div>`);
}

function noQuestionsPage(person) {
  return page("Nothing to confirm", `<div class="card"><h1>Thanks, ${escapeHtml(firstName(person?.name))} — nothing to confirm</h1>
<p>There's nothing more we need from you right now. Your matches are up to date.</p></div>`);
}

function reviewPage(person) {
  return page("Thanks — we'll take a look", `<div class="card"><h1>Thanks, ${escapeHtml(firstName(person?.name))}</h1>
<p>Some of your answers didn't quite fit together, so our team will review them before we use them. You don't need to do anything else.</p></div>`);
}

/** One <fieldset> per planned question, labelled with the lender rules that prompted it. */
function questionBlock(qid, plan, person, values, errors) {
  const q = QUESTION_BY_ID[qid];
  if (!q) return "";
  const err = errors[qid];
  const errId = `err-${qid}`, whyId = `why-${qid}`;
  const quotes = (plan.mentions || []).filter((m) => m.question === qid).map((m) => `<li>${escapeHtml(m.text)}</li>`).join("");
  const describedBy = [quotes ? whyId : "", err ? errId : ""].filter(Boolean).join(" ");
  const aria = `${describedBy ? ` aria-describedby="${describedBy}"` : ""}${err ? ' aria-invalid="true"' : ""}`;
  const val = (name) => escapeHtml(values[name] ?? "");
  let inputs = "";
  if (qid === "work_experience") {
    inputs = q.input.fields.map((f) => `<label for="${f.name}">${escapeHtml(f.label)}</label>
<input type="number" id="${f.name}" name="${f.name}" inputmode="decimal" min="${f.min}" max="${f.max}" step="0.5" value="${val(f.name)}"${aria}>`).join("\n");
  } else if (qid === "employer_type") {
    const options = q.input.options.map((o) => `<option value="${escapeHtml(o.value)}"${values.employer_type === o.value ? " selected" : ""}>${escapeHtml(o.label)}</option>`).join("");
    inputs = `<label for="employer_type">Type of employer</label>
<select id="employer_type" name="employer_type"${aria}><option value="">Choose one…</option>${options}</select>`;
  } else if (qid === "bank_accounts") {
    const chosen = new Set(values.bank_accounts || []);
    const banks = (plan.bank_options && plan.bank_options.length ? plan.bank_options : allowedBanks(person, plan));
    inputs = [...banks, "none"].map((b, i) => `<label class="check" for="bank-${i}"><input type="checkbox" id="bank-${i}" name="bank_accounts" value="${escapeHtml(b)}"${chosen.has(b) ? " checked" : ""}${aria}> ${b === "none" ? "None of these" : escapeHtml(b)}</label>`).join("\n");
  } else if (qid === "city") {
    inputs = `<label for="city">City</label>
<input type="text" id="city" name="city" maxlength="${q.input.maxLength ?? 80}" autocomplete="address-level2" value="${val("city")}"${aria}>`;
  } else if (qid === "business_vintage") {
    inputs = `<label for="business_years">Years in business</label>
<input type="number" id="business_years" name="business_years" inputmode="decimal" min="${q.input.min}" max="${q.input.max}" step="0.5" value="${val("business_years")}"${aria}>`;
  } else if (qid === "existing_emi") {
    inputs = `<label for="existing_emi_monthly">Total EMIs per month (₹) — enter 0 if none</label>
<input type="number" id="existing_emi_monthly" name="existing_emi_monthly" inputmode="numeric" min="0" step="1" value="${val("existing_emi_monthly")}"${aria}>`;
  }
  return `<fieldset class="card${err ? " alert" : ""}"><legend>${escapeHtml(q.label)}</legend>
${quotes ? `<div id="${whyId}" class="small">Why we ask — what the lender says:<ul class="why">${quotes}</ul></div>` : ""}
${inputs}
${err ? `<p class="err" id="${errId}">${escapeHtml(err)}</p>` : ""}</fieldset>`;
}

/**
 * The form: only this person's planned questions, pre-filled with earlier answers.
 * @param o {action, token, values?, errors?}
 */
function renderForm(person, plan, o) {
  if (!plan?.questions?.length) return noQuestionsPage(person);
  const values = o.values ?? answersToValues(person.declared);
  const errors = o.errors ?? {};
  const n = plan.unlockable;
  const lenders = (plan.lenders || []).length ? ` from ${E.listLenders ? E.listLenders(plan.lenders) : plan.lenders.join(", ")}` : "";
  const errorList = Object.entries(errors).map(([k, m]) => `<li>${k === "form" ? "" : `${escapeHtml(QUESTION_BY_ID[k]?.label ?? k)} `}${escapeHtml(m)}</li>`).join("");
  return page("Confirm a few details", `<div class="card"><h1>Hi ${escapeHtml(firstName(person.name))}, a few quick questions</h1>
<p>Some lenders ask for details we don't have. Your answers could confirm up to ${escapeHtml(plural(n, "offer"))}${escapeHtml(lenders)}.</p>
<p class="note">Your answers are self-declared. If you apply, the lender will verify them with documents. Skip anything you'd rather not answer.</p></div>
${errorList ? `<div class="card alert" role="alert"><p><strong>Please check your answers:</strong></p><ul>${errorList}</ul></div>` : ""}
<form method="post" action="${escapeHtml(o.action)}" novalidate>
<input type="hidden" name="t" value="${escapeHtml(o.token)}">
${plan.questions.map((q) => questionBlock(q, plan, person, values, errors)).join("\n")}
<button type="submit">Check my offers</button>
<p class="small" style="margin-top:12px">We only use these answers to check your loan matches. This isn't a loan application and doesn't affect your credit score.</p>
</form>`);
}

function offerCard(p, recheck = "") {
  return `<div class="card"><div class="lender">${escapeHtml(p.lender_name)}</div>
<div class="product">${escapeHtml(p.product_name)}</div>
<div>${escapeHtml(rateText(p))}${num(p.max_loan_amount) ? ` · up to ${escapeHtml(formatINR(p.max_loan_amount))}` : ""}</div>
<div class="ok">Pre-qualified based on your answers — the lender will verify${recheck}</div>
${p.source_url ? `<a class="btn" href="${escapeHtml(p.source_url)}" rel="noopener noreferrer">View on ${escapeHtml(p.lender_name)}</a>` : ""}</div>`;
}

/** After the answers were applied. `unlocked` = matches that actually became ELIGIBLE. */
function resultPage(person, unlocked, { narrowed = 0, rejected = 0, emailed = false } = {}) {
  const name = escapeHtml(firstName(person?.name));
  const outcome = [];
  if (narrowed) outcome.push(`${plural(narrowed, "offer")} still ${narrowed === 1 ? "has" : "have"} something to confirm with the lender.`);
  if (rejected) outcome.push(`Based on your answers, ${plural(rejected, "offer")} ${rejected === 1 ? "doesn't" : "don't"} fit your profile, so we've removed ${rejected === 1 ? "it" : "them"}.`);
  const extra = outcome.map((s) => `<p class="note">${escapeHtml(s)}</p>`).join("");
  if (!unlocked.length) {
    return page("Thanks for your answers", `<div class="card"><h1>Thanks, ${name} — your answers are saved</h1>
<p>They didn't unlock new offers this time. Your current matches are unchanged unless listed below.</p>${extra}</div>`);
  }
  return page("You now pre-qualify", `<div class="card"><h1>Good news, ${name}</h1>
<p>Based on your answers you now pre-qualify for ${escapeHtml(plural(unlocked.length, "more personal loan"))}.${emailed ? " We've also emailed you this list." : ""}</p>${extra}
<p class="note">Pre-qualified based on your answers — not a loan offer or approval. The lender will verify your details with documents when you apply.</p></div>
${unlocked.map((p) => offerCard(p)).join("\n")}`);
}

// ---- email -------------------------------------------------------------------------------------

/**
 * "You now pre-qualify" email, styled like Workflow C's (email.js): table layout, inline CSS,
 * escaped, plain-text twin, unsubscribe link.
 * @param o {unsubscribeBase, secret, now, maxCards}
 */
function renderUnlockedEmail(person, unlocked, o) {
  const name = firstName(person.name);
  const cards = E.pickCards(unlocked, o.maxCards ?? 5);
  const more = unlocked.length - cards.length;
  const token = E.unsubscribeToken(person.user_id, o.secret, o.now);
  const unsubscribeUrl = `${o.unsubscribeBase}?t=${encodeURIComponent(token)}`;
  const n = unlocked.length;
  const subject = `${name}, you now pre-qualify for ${n} more personal loan${n === 1 ? "" : "s"}`;
  const note = "Pre-qualified based on your answers — the lender will verify them when you apply.";

  const rows = cards.map((p) => {
    const why = E.reasons(person, p).map((r) => `<li>${escapeHtml(r)}</li>`).join("");
    return `<tr><td style="padding:16px;border:1px solid #e4e4e7;border-radius:12px;background:#ffffff">
<div style="font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:.04em">${escapeHtml(p.lender_name)}</div>
<div style="font-size:18px;font-weight:700;color:#18181b;margin:2px 0 6px">${escapeHtml(p.product_name)}</div>
<div style="font-size:15px;color:#18181b">${escapeHtml(rateText(p))}${num(p.max_loan_amount) ? ` · up to ${escapeHtml(formatINR(p.max_loan_amount))}` : ""}</div>
<div style="margin-top:10px;font-size:14px;color:#15803d;font-weight:600">${escapeHtml(note)}</div>
${why ? `<ul style="margin:4px 0 0;padding-left:18px;font-size:14px;color:#3f3f46">${why}</ul>` : ""}
<div style="margin-top:14px"><a href="${escapeHtml(p.source_url)}" style="display:inline-block;background:#4338ca;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:600">View on ${escapeHtml(p.lender_name)}</a></div>
</td></tr><tr><td style="height:12px"></td></tr>`;
  }).join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden">Thanks for confirming your details — these offers are now unlocked.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 16px;font-size:16px;color:#18181b">Hi ${escapeHtml(name)},<br><br>Thanks for answering our questions. Based on your answers, you now pre-qualify for these personal loans:</td></tr>
${rows}
${more > 0 ? `<tr><td style="padding:0 4px 12px;font-size:14px;color:#3f3f46">+ ${more} more option${more === 1 ? "" : "s"} unlocked by your answers.</td></tr>` : ""}
<tr><td style="padding:8px 4px;font-size:12px;line-height:1.5;color:#71717a">Your answers are self-declared. This is not a loan offer or approval: the lender verifies your details with documents and decides final eligibility, rates and amounts.<br><br>
You're receiving this because you answered our questions about your loan matches. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#71717a">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    `Hi ${name},`, "", "Thanks for answering our questions. Based on your answers, you now pre-qualify for these personal loans:", "",
    ...cards.flatMap((p) => [`• ${p.product_name} — ${p.lender_name}`, `  ${rateText(p)}`,
      ...E.reasons(person, p).map((r) => `  ✓ ${r}`), `  ${note}`, `  ${p.source_url}`, ""]),
    more > 0 ? `+ ${more} more option(s) unlocked by your answers.\n` : "",
    "Self-declared answers — not a loan offer or approval. The lender verifies documents and decides final eligibility.",
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");
  return { subject, html, text };
}

if (typeof module !== "undefined") {
  module.exports = { planInputs, allowedBanks, formValues, parseAnswers, retryPlan, mergeAnswers, sanityCheck, answersToValues,
                     judgeFeatures, judgeItems, decide, score, rateText, renderForm, expiredPage, noQuestionsPage,
                     reviewPage, resultPage, renderUnlockedEmail };
}
