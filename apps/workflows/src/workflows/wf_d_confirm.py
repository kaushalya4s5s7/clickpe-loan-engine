"""Workflow D — Confirm conditions: the person answers the questions C's email asked, and their
"to confirm" (LIKELY) matches are re-checked with those answers.

GET  webhook/confirm?t=…   Form link opened ─► Verify link ─► Valid link? ─yes─► Load person ─► Render form ─► Show form
                                                            └no (expired page) ────────────────────────────────┘
POST webhook/confirm-submit  Answers submitted ─► Verify submission ─► Valid? ─no─► Show expired page
  ─yes─► Load answers context ─► Check answers ─► Readable? ─no (form + errors)─► Show answers page
  ─yes─► Save declaration ─► Flagged? ─yes (contradictions: ops review)─► Show answers page
  ─no──► Build judge items ─► Anything to judge? ─yes─► LLM judge ─┐
                                                └no───────────────┴─► Decide matches ─► Apply decisions
  ─► Prepare reply ─► Email to send? ─yes─► Send via SES ─ok─► Mark notified ─┐
                                    │                    └err────────────────┤
                                    └no──────────────────────────────────────┴─► Show result page

Answers are self-declared: unlocked matches are "pre-qualified based on your answers", never "approved".
"""

from .nodes import CREDENTIALS, Workflow, include

_HTML_HEADERS = {"entries": [
    {"name": "Content-Type", "value": "text/html; charset=utf-8"},
    {"name": "Cache-Control", "value": "no-store"},
    {"name": "Referrer-Policy", "value": "no-referrer"},   # the signed token is in the URL
    {"name": "X-Robots-Tag", "value": "noindex"},
    {"name": "X-Content-Type-Options", "value": "nosniff"},
]}
_MODULES = include("email") + include("questions") + include("confirm")
_FORM_ACTION = "`${String($env.WEBHOOK_URL ?? '').replace(/\\/?$/, '/')}webhook/confirm-submit`"


def _respond(w: Workflow, name: str, body_expr: str, pos: tuple[int, int]) -> str:
    return w.add(name, "n8n-nodes-base.respondToWebhook", 1.1, {
        "respondWith": "text", "responseBody": body_expr,
        "options": {"responseCode": 200, "responseHeaders": _HTML_HEADERS}}, pos)


def _if(w: Workflow, name: str, cond_id: str, left: str, operator: dict, pos: tuple[int, int], right=0) -> str:
    return w.add(name, "n8n-nodes-base.if", 2.2, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [{"id": cond_id, "leftValue": left, "rightValue": right, "operator": operator}],
            "combinator": "and"},
        "options": {}}, pos)


_IS_TRUE = {"type": "boolean", "operation": "true", "singleValue": True}
_GT = {"type": "number", "operation": "gt"}


def build() -> dict:
    w = Workflow("D", "D · Confirm conditions")

    # ---- GET: show the form -------------------------------------------------------------
    w.add("Form link opened", "n8n-nodes-base.webhook", 2,
          {"httpMethod": "GET", "path": "confirm", "responseMode": "responseNode", "options": {}},
          (0, 0), webhookId="b1e7c0de-0000-4000-8000-00000000d001")
    w.code("Verify link", _MODULES + """
// Signed, expiring link (no PII in it). A bad or expired token gets a friendly page, no detail.
const t = $input.first().json.query?.t;
const check = questions.verifyConfirmToken(t, $env.UNSUBSCRIBE_SECRET, Math.floor(Date.now() / 1000));
if (!check.ok) {
  console.log(`confirm link rejected: ${check.reason}`);
  return [{ json: { ok: false, html: confirm.expiredPage() } }];
}
return [{ json: { ok: true, user_id: check.userId } }];
""", (220, 0))
    _if(w, "Valid link?", "6a1f2c3e-0b1d-4c8e-9f00-00000000d0a1", "={{ $json.ok }}", _IS_TRUE, (440, 0), right="")
    w.postgres("Load person", "d_load_person", (660, -80), params_expr="={{ [$json.user_id] }}", alwaysOutputData=True)
    w.code("Render form", _MODULES + f"""
// Only this person's planned questions (≤ 3), each labelled with the lender rules behind it.
const person = $input.first().json;
if (!person.user_id) return [{{ json: {{ html: confirm.expiredPage() }} }}];   // user since deleted
const inp = confirm.planInputs(person);
const plan = questions.planQuestions(inp.user, inp.matches, inp.productsById, {{ maxQuestions: 3, maxCards: 5 }});
const html = confirm.renderForm(person, plan, {{ action: {_FORM_ACTION}, token: $('Form link opened').first().json.query.t }});
return [{{ json: {{ html, questions: plan.questions, unlockable: plan.unlockable }} }}];
""", (880, -80))
    _respond(w, "Show form", "={{ $json.html }}", (1100, 0))

    # ---- POST: answers ------------------------------------------------------------------
    w.add("Answers submitted", "n8n-nodes-base.webhook", 2,
          {"httpMethod": "POST", "path": "confirm-submit", "responseMode": "responseNode", "options": {}},
          (0, 400), webhookId="b1e7c0de-0000-4000-8000-00000000d002")
    w.code("Verify submission", _MODULES + """
const t = $input.first().json.body?.t;
const check = questions.verifyConfirmToken(t, $env.UNSUBSCRIBE_SECRET, Math.floor(Date.now() / 1000));
if (!check.ok) {
  console.log(`confirm submission rejected: ${check.reason}`);
  return [{ json: { ok: false, html: confirm.expiredPage() } }];
}
return [{ json: { ok: true, user_id: check.userId } }];
""", (220, 400))
    _if(w, "Valid submission?", "6a1f2c3e-0b1d-4c8e-9f00-00000000d0a2", "={{ $json.ok }}", _IS_TRUE, (440, 400), right="")
    _respond(w, "Show expired page", "={{ $json.html }}", (660, 580))
    w.postgres("Load answers context", "d_load_person", (660, 400), params_expr="={{ [$json.user_id] }}",
               alwaysOutputData=True)
    w.code("Check answers", _MODULES + f"""
// Sanity checks before anything is used. Unreadable input → the form again with errors (nothing
// stored). Contradictions (more experience than age allows, salaried employer for a self-employed
// person...) → stored but flagged for ops, and not used.
const person = $input.first().json;
const body = $('Answers submitted').first().json.body || {{}};
if (!person.user_id) return [{{ json: {{ usable: false, html: confirm.expiredPage() }} }}];
const inp = confirm.planInputs(person);
const plan = questions.planQuestions(inp.user, inp.matches, inp.productsById, {{ maxQuestions: 3, maxCards: 5 }});
const parsed = confirm.parseAnswers(body, person, plan);
if (Object.keys(parsed.errors).length) {{
  const html = confirm.renderForm(person, confirm.retryPlan(plan, parsed),
    {{ action: {_FORM_ACTION}, token: String(body.t), values: parsed.values, errors: parsed.errors }});
  return [{{ json: {{ usable: false, html }} }}];
}}
const answers = confirm.mergeAnswers(person.declared, parsed.answers);
const reasons = confirm.sanityCheck(answers, person);
return [{{ json: {{ usable: true, user_id: person.user_id, batch_id: person.batch_id ?? '', answers,
  flagged: reasons.length > 0, flag_reasons: reasons, html: reasons.length ? confirm.reviewPage(person) : '' }} }}];
""", (880, 400))
    _if(w, "Answers readable?", "6a1f2c3e-0b1d-4c8e-9f00-00000000d0a3", "={{ $json.usable }}", _IS_TRUE, (1100, 400),
        right="")
    _respond(w, "Show answers page", "={{ $('Check answers').first().json.html }}", (1540, 580))
    w.postgres("Save declaration", "d_save_declaration", (1320, 400), params_expr=(
        "={{ [$json.user_id, $json.batch_id, JSON.stringify($json.answers), String($json.flagged), "
        "JSON.stringify($json.flag_reasons)] }}"))
    _if(w, "Flagged?", "6a1f2c3e-0b1d-4c8e-9f00-00000000d0a4", "={{ $('Check answers').first().json.flagged }}",
        _IS_TRUE, (1540, 400), right="")
    w.code("Build judge items", _MODULES + include("llm") + """
// Only this person's LIKELY matches, only rules their answers now cover, with their exact CSV
// values + declared answers. All items go to the judge in ONE request.
const person = $('Load answers context').first().json;
const { answers } = $('Check answers').first().json;
const enabled = String($env.LLM_ENABLED ?? "true") === "true";
const items = enabled ? confirm.judgeItems(person, answers) : [];
return [{ json: { items, request: items.length ? llm.judgmentRequest($env.LLM_MODEL, items) : null } }];
""", (1760, 400))
    _if(w, "Anything to judge?", "6a1f2c3e-0b1d-4c8e-9f00-00000000d0a5", "={{ $json.items.length }}", _GT, (1980, 400))
    w.add("LLM judge", "n8n-nodes-base.httpRequest", 4.2, {
        "method": "POST", "url": "={{ $env.LLM_BASE_URL.replace(/\\/$/, '') }}/chat/completions",
        "authentication": "genericCredentialType", "genericAuthType": "httpHeaderAuth",
        "sendBody": True, "specifyBody": "json", "jsonBody": "={{ JSON.stringify($json.request) }}",
        "options": {"timeout": 60000, "response": {"response": {"neverError": True}}}},
        (2200, 300), credentials={"httpHeaderAuth": CREDENTIALS["httpHeaderAuth"]},
        retryOnFail=True, maxTries=3, waitBetweenTries=3000, onError="continueRegularOutput")
    w.code("Decide matches", _MODULES + include("llm") + """
// All rules PASS → pre-qualified (ELIGIBLE, DECLARED). Any FAIL → match removed. Otherwise still
// LIKELY with what's left. A failed or garbled LLM reply = no verdicts = nothing changes.
const person = $('Load answers context').first().json;
const { items } = $('Build judge items').first().json;
let judgments = [];
try { judgments = llm.parseJudgments($('LLM judge').first().json, items, $env.LLM_MODEL); } catch (e) { /* nothing to judge */ }
const d = confirm.decide(person, items, judgments);
return [{ json: { user_id: person.user_id, updates: d.updates, unlocked: d.unlocked, judged: items.length,
                  verdicts: judgments.length } }];
""", (2420, 400))
    w.postgres("Apply decisions", "d_apply_decisions", (2640, 400),
               params_expr="={{ [$json.user_id, JSON.stringify($json.updates)] }}")
    w.code("Prepare reply", _MODULES + """
// Page + email list only what the database actually unlocked (a double submit unlocks nothing twice).
// Email goes to the address C last used for this person (test-mode safe), never users.email.
const person = $('Load answers context').first().json;
const applied = $input.first().json;
const ids = new Set((applied.unlocked_ids || []).map(Number));
const unlocked = $('Decide matches').first().json.unlocked.filter((m) => ids.has(Number(m.product_id)));
const send = unlocked.length > 0 && Boolean(person.recipient);
const page = confirm.resultPage(person, unlocked, { narrowed: applied.narrowed, rejected: applied.removed, emailed: send });
const out = { user_id: person.user_id, unlocked_ids: [...ids], send, page };
if (send) {
  const mail = confirm.renderUnlockedEmail(person, unlocked, { unsubscribeBase: $env.UNSUBSCRIBE_BASE_URL,
    secret: $env.UNSUBSCRIBE_SECRET, now: Math.floor(Date.now() / 1000), maxCards: 5 });
  Object.assign(out, { recipient: person.recipient, subject: mail.subject, email_html: mail.html });
}
return [{ json: out }];
""", (2860, 400))
    _if(w, "Email to send?", "6a1f2c3e-0b1d-4c8e-9f00-00000000d0a6", "={{ $json.send }}", _IS_TRUE, (3080, 400),
        right="")
    w.add("Send via SES", "n8n-nodes-base.awsSes", 1, {
        "operation": "send", "isBodyHtml": True,
        "subject": "={{ $json.subject }}", "body": "={{ $json.email_html }}",
        "fromEmail": "={{ $env.SES_FROM_EMAIL }}", "toAddresses": ["={{ $json.recipient }}"],
        "additionalFields": {}},
        (3300, 300), credentials={"aws": CREDENTIALS["aws"]},
        retryOnFail=True, maxTries=3, waitBetweenTries=2000, onError="continueErrorOutput")
    w.postgres("Mark notified", "d_mark_notified", (3520, 220), alwaysOutputData=True, params_expr=(
        "={{ [$('Prepare reply').first().json.user_id, JSON.stringify($('Prepare reply').first().json.unlocked_ids)] }}"))
    _respond(w, "Show result page", "={{ $('Prepare reply').first().json.page }}", (3740, 400))

    w.chain("Form link opened", "Verify link", "Valid link?")
    w.connect("Valid link?", "Load person", 0)
    w.connect("Valid link?", "Show form", 1)
    w.chain("Load person", "Render form", "Show form")

    w.chain("Answers submitted", "Verify submission", "Valid submission?")
    w.connect("Valid submission?", "Load answers context", 0)
    w.connect("Valid submission?", "Show expired page", 1)
    w.chain("Load answers context", "Check answers", "Answers readable?")
    w.connect("Answers readable?", "Save declaration", 0)
    w.connect("Answers readable?", "Show answers page", 1)
    w.chain("Save declaration", "Flagged?")
    w.connect("Flagged?", "Show answers page", 0)
    w.connect("Flagged?", "Build judge items", 1)
    w.chain("Build judge items", "Anything to judge?")
    w.connect("Anything to judge?", "LLM judge", 0)
    w.connect("Anything to judge?", "Decide matches", 1)
    w.chain("LLM judge", "Decide matches", "Apply decisions", "Prepare reply", "Email to send?")
    w.connect("Email to send?", "Send via SES", 0)
    w.connect("Email to send?", "Show result page", 1)
    w.connect("Send via SES", "Mark notified", 0)
    w.connect("Send via SES", "Show result page", 1)      # error output: the page still answers
    w.connect("Mark notified", "Show result page")
    return w.to_json()
