"""Workflow B — User-Loan Matching (the Treasure Hunt).

Webhook (signed doorbell) ─┐
                           ├─► Claim batch ─► Load products ─► Plan classes ─► Load user classes
Sweeper (every 2 min) ─────┘    (CAS+lease)                     (cut points)    (SQL width_bucket)
 ─► Match (bitset) ─► Lookup LLM cache ─► Uncached? ─yes─► Build LLM batches ─► LLM judge ─► Parse ─► Save judgments ─┐
                                                   └─no──────────────────────────────────────────────────────────────┴─► Final match ─► Save matches ─┐
 ─► Answered people ─► Re-check answers ─► Answers to check? ─yes─► LLM judge (answers) ─► Decide with answers
    (people who already answered D: re-check new        └─no──────────────────────────────┐   ─► Save answer decisions ─┐
     "to confirm" offers with their stored answers)                                       └──────────────────────────┴─► Workflow C
"""

from .nodes import WORKFLOW_IDS, Workflow, include


def build() -> dict:
    w = Workflow("B", "B · Match users to loans")

    w.add("Doorbell webhook", "n8n-nodes-base.webhook", 2,
          {"httpMethod": "POST", "path": "batch-loaded", "responseMode": "onReceived", "options": {}},
          (0, 0), webhookId="b1e7c0de-0000-4000-8000-00000000b001")
    w.code("Verify signature", include("signature") + """
// Reject anything not signed by our ingest Lambda (HMAC + 5-minute replay window).
const req = $input.first().json;
const check = signature.verifyDoorbell(req.headers, req.body, $env.N8N_WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
if (!check.ok) {
  console.log(`doorbell rejected: ${check.reason}`);
  return [];   // no items → the workflow stops here
}
return [{ json: { batch_id: check.batchId, trigger: "webhook" } }];
""", (220, 0))

    w.add("Sweeper every 2 min", "n8n-nodes-base.scheduleTrigger", 1.2,
          {"rule": {"interval": [{"field": "minutes", "minutesInterval": 2}]}}, (0, 220))
    w.postgres("Find stalled batch", "b_find_stalled", (220, 220))

    w.postgres("Claim batch", "b_claim_batch", (460, 100), params_expr="={{ [$json.batch_id] }}")
    w.postgres("Load products", "b_load_products", (680, 100), executeOnce=True)
    w.code("Plan classes", include("matcher") + """
// Cut points = every threshold any product uses. Users between the same cut points on every
// attribute are indistinguishable to every product → one class.
const products = $input.first().json.products || [];
const cuts = matcher.buildCuts(products);
return [{ json: {
  batch_id: $('Claim batch').first().json.batch_id,
  products, cuts,
  pg: { income: matcher.pgArray(cuts.income), credit: matcher.pgArray(cuts.credit), age: matcher.pgArray(cuts.age) },
} }];
""", (900, 100))
    w.postgres("Load user classes", "b_load_classes", (1120, 100),
               params_expr="={{ [$json.batch_id, $json.pg.income, $json.pg.credit, $json.pg.age] }}")
    w.code("Match (bitset)", include("matcher") + """
// Stage 2: one bitmask AND per class. Collects the soft-rule questions an LLM must answer.
const plan = $('Plan classes').first().json;
const started = Date.now();
const result = matcher.matchClasses($input.first().json.classes || [], plan.products, plan.cuts, {});
return [{ json: { pending: result.pending, keys: result.pending.map((p) => p.cache_key), first_pass_ms: Date.now() - started } }];
""", (1340, 100))
    w.postgres("Lookup LLM cache", "b_lookup_judgments", (1560, 100),
               params_expr="={{ [JSON.stringify($json.keys)] }}")
    w.code("Uncached questions", """
// Stage 3 gate: only questions never answered before for this exact (product version, rule,
// projected profile) go to the LLM. Everything else is a cache hit.
const cached = $input.first().json.judgments || {};
const pending = $('Match (bitset)').first().json.pending;
const uncached = pending.filter((p) => !(p.cache_key in cached));
const enabled = String($env.LLM_ENABLED ?? "true") === "true";
return [{ json: { cached, uncached: enabled ? uncached : [], skipped_llm: enabled ? 0 : uncached.length } }];
""", (1780, 100))
    w.add("Need LLM?", "n8n-nodes-base.if", 2.2, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [{"id": "6a1f2c3e-0b1d-4c8e-9f00-00000000b0a1", "leftValue": "={{ $json.uncached.length }}",
                            "rightValue": 0, "operator": {"type": "number", "operation": "gt"}}],
            "combinator": "and"},
        "options": {}}, (2000, 100))
    w.code("Build LLM batches", include("llm") + """
// ~25 questions per request: one system prompt amortised over many answers.
const items = $input.first().json.uncached;
const out = [];
for (let i = 0; i < items.length; i += 25) {
  const chunk = items.slice(i, i + 25);
  out.push({ json: { pending: chunk, request: llm.judgmentRequest($env.LLM_MODEL, chunk) } });
}
return out;
""", (2220, 0))
    w.add("LLM judge", "n8n-nodes-base.httpRequest", 4.2, {
        "method": "POST", "url": "={{ $env.LLM_BASE_URL.replace(/\\/$/, '') }}/chat/completions",
        "authentication": "genericCredentialType", "genericAuthType": "httpHeaderAuth",
        "sendBody": True, "specifyBody": "json", "jsonBody": "={{ JSON.stringify($json.request) }}",
        "options": {"timeout": 60000, "response": {"response": {"neverError": True}}}},
        (2440, 0), credentials={"httpHeaderAuth": {"id": "loanEngineLlmCrd", "name": "LLM API"}},
        retryOnFail=True, maxTries=3, waitBetweenTries=3000, onError="continueRegularOutput")
    w.code("Parse judgments", include("llm") + """
// Circuit breaker by design: a failed or garbled LLM reply yields no verdicts, so those offers
// simply stay LIKELY ("to confirm") — matching never blocks on the LLM.
const batches = $('Build LLM batches').all();
const out = [];
let tokens = 0;
$input.all().forEach((item, i) => {
  tokens += llm.tokensUsed(item.json);
  out.push(...llm.parseJudgments(item.json, batches[i].json.pending, $env.LLM_MODEL));
});
return [{ json: { judgments: out, llm_calls: batches.length, llm_tokens: tokens } }];
""", (2660, 0))
    w.postgres("Save judgments", "b_save_judgments", (2880, 0),
               params_expr="={{ [JSON.stringify($json.judgments)] }}", alwaysOutputData=True)
    w.code("Final match", include("matcher") + include("questions") + """
// Re-run the (millisecond) bitset pass with every verdict known, then hand Postgres one row per
// (class, product); it expands classes back to users in a single set-based statement.
const plan = $('Plan classes').first().json;
const gate = $('Uncached questions').first().json;
let fresh = { judgments: [], llm_calls: 0, llm_tokens: 0 };
try { fresh = $('Parse judgments').first().json; } catch (e) { /* LLM branch not taken */ }
const judgments = { ...gate.cached };
for (const j of fresh.judgments) judgments[j.cache_key] = j.verdict;
const classes = $('Load user classes').first().json.classes || [];
const result = matcher.matchClasses(classes, plan.products, plan.cuts, judgments);
// What Workflow C's "answer a few questions" link could unlock — planned per class, not per user.
const productsById = Object.fromEntries(plan.products.map((p) => [p.id, p]));
const question_plan = questions.planForClasses(result.rows, productsById, { classes, maxQuestions: 3, maxCards: 5 });
const funnel = { ...result.funnel, llm_calls: fresh.llm_calls, llm_tokens: fresh.llm_tokens,
                 llm_new_judgments: fresh.judgments.length, llm_skipped: gate.skipped_llm, question_plan };
return [{ json: { batch_id: plan.batch_id, rows: result.rows, funnel } }];
""", (3100, 100))
    w.postgres("Save matches", "b_save_matches", (3320, 100), params_expr=(
        "={{ [$json.batch_id, JSON.stringify($json.rows), $('Plan classes').first().json.pg.income, "
        "$('Plan classes').first().json.pg.credit, $('Plan classes').first().json.pg.age, JSON.stringify($json.funnel)] }}"))
    # People who already answered Workflow D's questions: re-check their new "to confirm" offers with
    # those stored answers, so nobody is asked the same thing twice (e.g. a new lender wants 2 years).
    w.postgres("Answered people", "b_load_answered", (3540, 100),
               params_expr="={{ [$json.batch_id] }}")
    w.code("Re-check answers", include("email") + include("questions") + include("confirm") + include("llm") + """
// Only rules their stored answers cover; ~25 questions per request. Nobody answered → skip.
const { batch_id, people } = $input.first().json;
const enabled = String($env.LLM_ENABLED ?? "true") === "true";
const items = enabled ? confirm.batchJudgeItems(people || []) : [];
const out = [];
for (let i = 0; i < items.length; i += 25) {
  const chunk = items.slice(i, i + 25);
  out.push({ json: { batch_id, pending: chunk, request: llm.judgmentRequest($env.LLM_MODEL, chunk) } });
}
return out.length ? out : [{ json: { batch_id, pending: [], request: null } }];
""", (3760, 100))
    w.add("Answers to check?", "n8n-nodes-base.if", 2.2, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [{"id": "6a1f2c3e-0b1d-4c8e-9f00-00000000b0a2", "leftValue": "={{ $json.pending.length }}",
                            "rightValue": 0, "operator": {"type": "number", "operation": "gt"}}],
            "combinator": "and"},
        "options": {}}, (3980, 100))
    w.add("LLM judge (answers)", "n8n-nodes-base.httpRequest", 4.2, {
        "method": "POST", "url": "={{ $env.LLM_BASE_URL.replace(/\\/$/, '') }}/chat/completions",
        "authentication": "genericCredentialType", "genericAuthType": "httpHeaderAuth",
        "sendBody": True, "specifyBody": "json", "jsonBody": "={{ JSON.stringify($json.request) }}",
        "options": {"timeout": 60000, "response": {"response": {"neverError": True}}}},
        (4200, 0), credentials={"httpHeaderAuth": {"id": "loanEngineLlmCrd", "name": "LLM API"}},
        retryOnFail=True, maxTries=3, waitBetweenTries=3000, onError="continueRegularOutput")
    w.code("Decide with answers", include("email") + include("questions") + include("confirm") + include("llm") + """
// Same rules as Workflow D: all PASS → pre-qualified (DECLARED), any FAIL → removed, else still
// "to confirm" with fewer conditions. A failed LLM reply = no verdicts = nothing changes.
const people = $('Answered people').first().json.people || [];
const batches = $('Re-check answers').all();
const judgments = [];
$input.all().forEach((item, i) => {
  try { judgments.push(...llm.parseJudgments(item.json, batches[i].json.pending, $env.LLM_MODEL)); } catch (e) { /* no verdicts */ }
});
const d = confirm.batchDecide(people, batches.flatMap((b) => b.json.pending), judgments);
return [{ json: { batch_id: batches[0].json.batch_id, updates: d.updates } }];
""", (4420, 0))
    w.postgres("Save answer decisions", "b_apply_answers", (4640, 0),
               params_expr="={{ [$json.batch_id, JSON.stringify($json.updates)] }}")
    w.add("Run workflow C (notify)", "n8n-nodes-base.executeWorkflow", 1.2, {
        "source": "database", "workflowId": {"__rl": True, "value": WORKFLOW_IDS["C"], "mode": "id"},
        "options": {"waitForSubWorkflow": False}}, (4860, 100))

    w.chain("Doorbell webhook", "Verify signature", "Claim batch")
    w.chain("Sweeper every 2 min", "Find stalled batch", "Claim batch")
    w.chain("Claim batch", "Load products", "Plan classes", "Load user classes", "Match (bitset)", "Lookup LLM cache",
            "Uncached questions", "Need LLM?")
    w.connect("Need LLM?", "Build LLM batches", 0)
    w.connect("Need LLM?", "Final match", 1)
    w.chain("Build LLM batches", "LLM judge", "Parse judgments", "Save judgments", "Final match")
    w.chain("Final match", "Save matches", "Answered people", "Re-check answers", "Answers to check?")
    w.connect("Answers to check?", "LLM judge (answers)", 0)
    w.connect("Answers to check?", "Run workflow C (notify)", 1)
    w.chain("LLM judge (answers)", "Decide with answers", "Save answer decisions", "Run workflow C (notify)")
    return w.to_json()
