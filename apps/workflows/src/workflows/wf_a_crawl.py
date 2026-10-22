"""Workflow A — Loan Product Discovery (daily crawler).

Daily 02:00 IST ─┐
Run now ─────────┴─► Load sources ─► Fetch page (conditional GET, 1 req/s) ─► Extract section ─► Group by lender ─► Changed? ─yes─► Build extraction request
  ─► LLM extract ─► Validate products ─► Save products ─┐
                                    (no) ───────────────┴─► Join branches ─► Page states ─► Save page state

Cheapest check first: 304 Not Modified → section hash unchanged → only then the LLM.
Layout changes: text-keyword windowing (no CSS selectors) + verbatim-evidence validation;
an empty extraction is treated as a failure that keeps yesterday's products.
"""

from .nodes import CREDENTIALS, Workflow, include


def build() -> dict:
    w = Workflow("A", "A · Discover loan products (crawler)")
    w.add("Daily 02:00 IST", "n8n-nodes-base.scheduleTrigger", 1.2,
          {"rule": {"interval": [{"field": "cronExpression", "expression": "0 2 * * *"}]}}, (0, 0))
    w.add("Run now", "n8n-nodes-base.manualTrigger", 1, {}, (0, 200))
    w.postgres("Load sources", "a_load_sources", (220, 100), executeOnce=True)
    w.add("Fetch page", "n8n-nodes-base.httpRequest", 4.2, {
        "url": "={{ $json.url }}",
        "sendHeaders": True,
        "headerParameters": {"parameters": [
            {"name": "User-Agent", "value": "ClickPeLoanEngine/1.0 (loan comparison research; daily)"},
            {"name": "Accept-Encoding", "value": "gzip, br"},
            {"name": "If-None-Match", "value": "={{ $json.etag }}"},
            {"name": "If-Modified-Since", "value": "={{ $json.last_modified }}"}]},
        "options": {
            "timeout": 20000,
            "redirect": {"redirect": {"followRedirects": True, "maxRedirects": 5}},
            "response": {"response": {"fullResponse": True, "neverError": True, "responseFormat": "text"}},
            "batching": {"batch": {"batchSize": 1, "batchInterval": 1000}}}},  # politeness: 1 request/second
        (440, 100), retryOnFail=True, maxTries=2, waitBetweenTries=5000, onError="continueRegularOutput")
    w.code("Extract section", include("crawl") + include("llm") + """
// Per page: 304 → not_modified; otherwise visible text → keyword windows → hash.
// The hash covers ONLY the eligibility text, so ads, dates and menus changing don't trigger the LLM.
// The prompt version is part of it, so a better extraction prompt re-reads every page once.
const sources = $('Load sources').all();
return $input.all().map((item, i) => {
  const src = sources[i].json;
  const r = item.json;
  const status = Number(r.statusCode ?? 0);
  const headers = r.headers ?? {};
  const body = typeof r.data === "string" ? r.data : r.body;   // n8n 2.x full response: text lives in .data
  const base = { url: src.url, lender_name: src.lender_name, page_role: src.page_role, old_hash: src.section_hash,
                 etag: headers.etag ?? "", last_modified: headers["last-modified"] ?? "" };
  if (status === 304) return { json: { ...base, outcome: "not_modified", etag: src.etag, last_modified: src.last_modified, bytes: 0 } };
  if (status < 200 || status >= 300 || typeof body !== "string") {
    return { json: { ...base, outcome: "failed", error: `HTTP ${status || "error"}: ${String(r.error?.message ?? "").slice(0, 200)}`, bytes: 0 } };
  }
  const section = crawl.relevantSection(crawl.htmlToText(body));
  const hash = crawl.sha256(`${llm.PROMPT_VERSION}\n${section}`);
  return { json: { ...base, outcome: hash === src.section_hash ? "unchanged" : "changed", section, section_hash: hash,
                   bytes: body.length } };
});
""", (660, 100))
    w.code("Group by lender", """
// A lender's products come from its eligibility + rates pages together. Re-extract the lender
// if ANY of its pages changed; a failed fetch blocks extraction (we'd be reading half the facts).
const groups = {};
for (const { json: p } of $input.all()) (groups[p.lender_name] ??= []).push(p);
return Object.entries(groups).map(([lender, pages]) => ({ json: {
  lender, pages,
  changed: pages.some((p) => p.outcome === "changed") && !pages.some((p) => p.outcome === "failed"),
} }));
""", (880, 100))
    w.add("Changed?", "n8n-nodes-base.if", 2.2, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [{"id": "6a1f2c3e-0b1d-4c8e-9f00-00000000a0a1", "leftValue": "={{ $json.changed }}",
                            "rightValue": "", "operator": {"type": "boolean", "operation": "true", "singleValue": True}}],
            "combinator": "and"},
        "options": {}}, (1100, 100))
    w.code("Build extraction request", include("llm") + """
// Only the windowed text goes to the LLM (a few KB per page, not 1 MB of HTML).
const g = $json;
const sections = g.pages.filter((p) => p.section).map((p) => ({ role: p.page_role, url: p.url, text: p.section }));
return { json: { ...g, request: llm.extractionRequest($env.LLM_MODEL, g.lender, sections) } };
""", (1320, 0), per_item=True)
    w.add("LLM extract", "n8n-nodes-base.httpRequest", 4.2, {
        "method": "POST", "url": "={{ $env.LLM_BASE_URL.replace(/\\/$/, '') }}/chat/completions",
        "authentication": "genericCredentialType", "genericAuthType": "httpHeaderAuth",
        "sendBody": True, "specifyBody": "json", "jsonBody": "={{ JSON.stringify($json.request) }}",
        # Bounded fan-out: 4 lenders in flight, then a 2 s pause. 15+ lenders fired at once trips the
        # provider's per-minute limit (429) and burns retries; this stays under it at any lender count.
        "options": {"timeout": 90000, "response": {"response": {"neverError": True}},
                    "batching": {"batch": {"batchSize": 4, "batchInterval": 2000}}}},
        (1540, 0), credentials={"httpHeaderAuth": CREDENTIALS["httpHeaderAuth"]},
        retryOnFail=True, maxTries=3, waitBetweenTries=5000, onError="continueRegularOutput")
    w.code("Validate products", include("crawl") + include("llm") + """
// Trust nothing the LLM says without a verbatim quote from the page (see crawl.validateProducts).
const g = $('Build extraction request').item.json;
const parsed = llm.parseJsonContent($json);
const sourceText = g.pages.map((p) => p.section ?? "").join("\\n");
const { products, warnings } = crawl.validateProducts(parsed, { lender: g.lender, sourceText, sourceUrl: g.pages[0].url });
const ok = products.length > 0;
// Drift alarm: zero products from a lender that had some = the page changed shape or the LLM failed.
return { json: { lender: g.lender, pages: g.pages, products, ok, warnings, tokens: llm.tokensUsed($json),
                 error: ok ? "" : `extraction returned 0 products${$json.error ? ": " + JSON.stringify($json.error).slice(0, 200) : ""}` } };
""", (1760, 0), per_item=True)
    w.postgres("Save products", "a_save_products", (1980, 0), alwaysOutputData=True,
               params_expr="={{ [$json.lender, JSON.stringify($json.products), 'llm'] }}")
    # Both IF branches meet here, so "Page states" runs once per crawl, not once per branch.
    w.add("Join branches", "n8n-nodes-base.merge", 3, {"mode": "append"}, (2090, 100))
    w.code("Page states", """
// Remember validators + section hash — but after a FAILED extraction, forget them, so the next
// run re-fetches and retries instead of seeing "not modified" and skipping forever.
const out = [];
let validated = [];
try { validated = $('Validate products').all().map((i) => i.json); } catch (e) { /* nothing changed today */ }
const result = Object.fromEntries(validated.map((v) => [v.lender, v]));
for (const g of $('Group by lender').all().map((i) => i.json)) {
  const v = result[g.lender];
  for (const p of g.pages) {
    const failed = p.outcome === "failed" || (v && !v.ok);
    const outcome = p.outcome === "changed" ? (v?.ok ? "extracted" : "failed") : p.outcome;
    out.push({ json: { url: p.url, outcome, etag: failed ? "" : p.etag, last_modified: failed ? "" : p.last_modified,
                       section_hash: failed ? "" : (p.section_hash ?? ""), bytes: String(p.bytes ?? 0),
                       error: p.error || (v && !v.ok ? v.error : "") } });
  }
}
return out;
""", (2280, 100), executeOnce=True)
    w.postgres("Save page state", "a_save_page_state", (2420, 100), params_expr=(
        "={{ [$json.url, $json.outcome, $json.etag, $json.last_modified, $json.section_hash, $json.bytes, $json.error] }}"))

    w.chain("Daily 02:00 IST", "Load sources")
    w.chain("Run now", "Load sources")
    w.chain("Load sources", "Fetch page", "Extract section", "Group by lender", "Changed?")
    w.connect("Changed?", "Build extraction request", 0)
    w.connect("Changed?", "Join branches", 1, dst_input=1)
    w.chain("Build extraction request", "LLM extract", "Validate products", "Save products")
    w.connect("Save products", "Join branches", 0, dst_input=0)
    w.chain("Join branches", "Page states", "Save page state")
    return w.to_json()
