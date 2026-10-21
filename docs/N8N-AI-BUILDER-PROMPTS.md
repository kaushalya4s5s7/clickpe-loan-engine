# n8n AI Builder Prompts

Prompts for n8n's AI workflow builder that reproduce our four workflows exactly as designed: same node names, settings, error handling and wiring.

## Read this first (2 minutes)

1. **The exact path is to import, not prompt.** n8n → *Workflows* → ⋯ → **Import from File** → `apps/workflows/dist/E_errors.json`, then `C_notify.json`, `B_match.json`, `A_crawl.json`. These are the tested versions.
   - Use the prompts below if you want the AI to build the canvas.
   - Or use them to understand and explain every node.
2. **What the AI builds, and what you paste.** The AI builds the **graph**: nodes, names, settings, retries, error branches, connections. It must **not** write logic. Code and SQL nodes get a placeholder, and you paste the tested code in afterwards (§5 checklist).
   - **Code nodes:** paste from `apps/workflows/dist/<file>.json` → the node with the same name → `parameters.jsCode`.
   - **SQL:** paste from `apps/workflows/src/sql/<name>.sql`.
3. **Cloud trial vs the brief.** The brief requires **self-hosted n8n (Docker)**. Build or try things on Cloud, then **export the JSON and run it self-hosted** for the submission.
   - Cloud has no `$env`, so these prompts use **n8n Variables** (`$vars.NAME`, set under *Overview → Variables*).
   - The self-hosted versions in `dist/` use `$env.NAME` instead (`docker-compose.yml` sets those).
4. **Build in this order:** **E → C → B → A**. Every workflow points at E for errors, and B calls C.
5. **One prompt per workflow.** If the AI box limits length, send the "Nodes" list in two messages ("continue building the same workflow: …").

### Before you start, on n8n Cloud
- **Credentials** (exact names; the workflows reference them by name):
  - **Loan DB**: Postgres, pointing at RDS, SSL on.
  - **AWS SES**: AWS, the send-only IAM user, region `ap-south-1`.
  - **LLM API**: Header Auth, `Authorization` = `Bearer <your key>`.
- **Variables:** `N8N_WEBHOOK_SECRET`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_ENABLED` (`true`), `TEST_MODE` (`true`), `TEST_RECIPIENTS` (`you+one@gmail.com,you+two@gmail.com`), `MAX_EMAILS_PER_RUN` (`3`), `SES_FROM_EMAIL`, `UNSUBSCRIBE_BASE_URL`, `UNSUBSCRIBE_SECRET`.
- If your plan has **no Variables**, add one **Set** node named `Settings` right after each trigger, holding those fields. Then replace `$vars.` with `$('Settings').first().json.` in every expression.

---

## Prompt 1 — Workflow E: error handler

```text
Build an n8n workflow named "E · Error handler". Build ONLY the graph and node settings exactly as specified. Do not invent extra nodes, do not write custom logic. Workflow settings: timezone Asia/Kolkata.

Purpose: whenever another workflow fails, record the failure in Postgres so the operations console timeline shows it.

Nodes, in order:
1. "On workflow error" — Error Trigger node.
2. "Record failure" — Postgres node, credential "Loan DB", operation "Execute Query".
   Query: a single placeholder line exactly:  -- PASTE apps/workflows/src/sql/record_event.sql
   Options → Query Parameters (expression, as an array):
   {{ ['', 'workflow', 'failed', JSON.stringify({ workflow: $json.workflow?.name, node: $json.execution?.lastNodeExecuted, message: String($json.execution?.error?.message ?? '').slice(0, 500), execution: $json.execution?.url }) ] }}

Connections: "On workflow error" → "Record failure".
```

---

## Prompt 2 — Workflow C: notify matched users

```text
Build an n8n workflow named "C · Notify matched users". Build ONLY the graph and node settings exactly as specified; do not invent nodes or write custom logic. Where I say "placeholder", put exactly that one comment line and nothing else (I will paste tested code later). Workflow settings: timezone Asia/Kolkata; Error workflow = "E · Error handler".

Purpose: called by workflow B after matching. For users with NEW matches, queue one notification each (consent, suppression, 7-day cap and a race-free weekly cap are enforced in SQL), render a personalised HTML email, send it with the AWS SES node one at a time (SES sandbox = 1 email/second), record SENT or FAILED, then close the batch. Duplicate emails must be impossible: the database enforces it; the workflow must never skip the bookkeeping steps.

Nodes, in order:
1. "Called by workflow B" — Execute Workflow Trigger ("When Executed by Another Workflow"), input data mode: accept all data (passthrough). Input has field batch_id.
2. "Claim batch" — Postgres, credential "Loan DB", Execute Query.
   Query placeholder:  -- PASTE apps/workflows/src/sql/c_claim_batch.sql
   Query Parameters: {{ [$json.batch_id] }}
   (Compare-and-set MATCHED→NOTIFYING. Zero rows returned = another run owns it, so the workflow stops naturally.)
3. "Queue notifications" — Postgres, "Loan DB", Execute Query.
   Query placeholder:  -- PASTE apps/workflows/src/sql/c_queue_notifications.sql
   Query Parameters: {{ [$('Claim batch').first().json.batch_id, String($vars.TEST_MODE ?? 'true'), JSON.stringify(String($vars.TEST_RECIPIENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)), String($vars.MAX_EMAILS_PER_RUN ?? '5')] }}
4. "Load pending" — Postgres, "Loan DB", Execute Query. Settings: Always Output Data = ON.
   Query placeholder:  -- PASTE apps/workflows/src/sql/c_load_pending.sql
   Query Parameters: {{ [$('Claim batch').first().json.batch_id] }}
5. "Render emails" — Code node, JavaScript, mode "Run Once for All Items".
   Code placeholder:  // PASTE jsCode of node "Render emails" from apps/workflows/dist/C_notify.json
   (Contract: outputs items {notification_id, recipient, subject, html, text, send:true}; if nobody needs an email it outputs one item {send:false}.)
6. "Any email?" — If node. Condition: Boolean {{ $json.send }} is true.
7. "Loop one at a time" — Loop Over Items (Split in Batches), batch size 1.
8. "Send via SES" — AWS SES node, credential "AWS SES", resource Email, operation Send.
   Is Body HTML = true; Subject = {{ $json.subject }}; Body = {{ $json.html }}; From Email = {{ $vars.SES_FROM_EMAIL }}; To Addresses = {{ $json.recipient }}.
   Settings: Retry On Fail = ON, Max Tries = 3, Wait Between Tries = 2000 ms; On Error = "Continue (using error output)".
9. "Mark sent" — Postgres, "Loan DB", Execute Query. Settings: Always Output Data = ON.
   Query placeholder:  -- PASTE apps/workflows/src/sql/c_mark_sent.sql
   Query Parameters: {{ [String($('Loop one at a time').item.json.notification_id), String($json.MessageId ?? $json.SendEmailResult?.MessageId ?? $json.messageId ?? 'unknown')] }}
10. "Mark failed" — Postgres, "Loan DB", Execute Query. Settings: Always Output Data = ON.
   Query placeholder:  -- PASTE apps/workflows/src/sql/c_mark_failed.sql
   Query Parameters: {{ [String($('Loop one at a time').item.json.notification_id), String($json.error?.message ?? $json.error ?? 'SES error')] }}
11. "Throttle 1 s" — Wait node, resume after time interval: 1 second.
12. "Finish" — Postgres, "Loan DB", Execute Query. Settings: Execute Once = ON.
   Query placeholder:  -- PASTE apps/workflows/src/sql/c_finish.sql
   Query Parameters: {{ [$('Claim batch').first().json.batch_id] }}

Connections (exact):
- "Called by workflow B" → "Claim batch" → "Queue notifications" → "Load pending" → "Render emails" → "Any email?"
- "Any email?" TRUE output → "Loop one at a time"
- "Any email?" FALSE output → "Finish"
- "Loop one at a time" DONE output → "Finish"
- "Loop one at a time" LOOP output → "Send via SES"
- "Send via SES" SUCCESS output → "Mark sent"
- "Send via SES" ERROR output → "Mark failed"
- "Mark sent" → "Throttle 1 s"
- "Mark failed" → "Throttle 1 s"
- "Throttle 1 s" → "Loop one at a time"
```

---

## Prompt 3 — Workflow B: match users to loans (the Treasure Hunt)

```text
Build an n8n workflow named "B · Match users to loans". Build ONLY the graph and node settings exactly as specified; do not invent nodes or write custom logic. Where I say "placeholder", put exactly that one comment line (I will paste tested code later). Workflow settings: timezone Asia/Kolkata; Error workflow = "E · Error handler".

Purpose: when a CSV batch is loaded, match its new users to loan products with a multi-stage pipeline that minimises LLM calls:
stage 1 SQL groups users into classes (width_bucket on product thresholds),
stage 2 a bitset matcher in a Code node,
stage 3 an LLM only for soft rules never judged before (cached in Postgres),
stage 4 one set-based SQL statement writes the matches table.
It is triggered two ways: a signed webhook ("doorbell") from the ingest Lambda, and a 2-minute sweeper as the safety net if the webhook is lost. A compare-and-set claim with a lease guarantees each batch is matched once. If the LLM fails, matching still completes (those offers stay "LIKELY"), so the LLM step must never stop the workflow.

Nodes, in order:
1. "Doorbell webhook" — Webhook node, HTTP Method POST, Path "batch-loaded", Respond "Immediately" (on received).
2. "Verify signature" — Code node, JavaScript, Run Once for All Items.
   Code placeholder:  // PASTE jsCode of node "Verify signature" from apps/workflows/dist/B_match.json
   (Contract: checks HMAC-SHA256 of "timestamp.batch_id" with the shared secret and a 5-minute window; outputs {batch_id} or no items to stop.)
3. "Sweeper every 2 min" — Schedule Trigger, every 2 minutes.
4. "Find stalled batch" — Postgres, credential "Loan DB", Execute Query.
   Query placeholder:  -- PASTE apps/workflows/src/sql/b_find_stalled.sql
5. "Claim batch" — Postgres, "Loan DB", Execute Query.
   Query placeholder:  -- PASTE apps/workflows/src/sql/b_claim_batch.sql
   Query Parameters: {{ [$json.batch_id] }}
6. "Load products" — Postgres, "Loan DB", Execute Query. Settings: Execute Once = ON.
   Query placeholder:  -- PASTE apps/workflows/src/sql/b_load_products.sql
7. "Plan classes" — Code node, Run Once for All Items.
   Code placeholder:  // PASTE jsCode of node "Plan classes" from apps/workflows/dist/B_match.json
8. "Load user classes" — Postgres, "Loan DB", Execute Query.
   Query placeholder:  -- PASTE apps/workflows/src/sql/b_load_classes.sql
   Query Parameters: {{ [$json.batch_id, $json.pg.income, $json.pg.credit, $json.pg.age] }}
9. "Match (bitset)" — Code node, Run Once for All Items.
   Code placeholder:  // PASTE jsCode of node "Match (bitset)" from apps/workflows/dist/B_match.json
10. "Lookup LLM cache" — Postgres, "Loan DB", Execute Query.
   Query placeholder:  -- PASTE apps/workflows/src/sql/b_lookup_judgments.sql
   Query Parameters: {{ [JSON.stringify($json.keys)] }}
11. "Uncached questions" — Code node, Run Once for All Items.
   Code placeholder:  // PASTE jsCode of node "Uncached questions" from apps/workflows/dist/B_match.json
12. "Need LLM?" — If node. Condition: Number {{ $json.uncached.length }} is greater than 0.
13. "Build LLM batches" — Code node, Run Once for All Items.
   Code placeholder:  // PASTE jsCode of node "Build LLM batches" from apps/workflows/dist/B_match.json
14. "LLM judge" — HTTP Request node, POST, URL {{ $vars.LLM_BASE_URL.replace(/\/$/, '') }}/chat/completions
   Authentication: Generic Credential Type → Header Auth → credential "LLM API".
   Send Body: JSON, body = {{ JSON.stringify($json.request) }}
   Options: Timeout 60000 ms; Response → Never Error = ON.
   Settings: Retry On Fail = ON, Max Tries = 3, Wait Between Tries = 3000 ms; On Error = "Continue (regular output)".
15. "Parse judgments" — Code node, Run Once for All Items.
   Code placeholder:  // PASTE jsCode of node "Parse judgments" from apps/workflows/dist/B_match.json
16. "Save judgments" — Postgres, "Loan DB", Execute Query. Settings: Always Output Data = ON.
   Query placeholder:  -- PASTE apps/workflows/src/sql/b_save_judgments.sql
   Query Parameters: {{ [JSON.stringify($json.judgments)] }}
17. "Final match" — Code node, Run Once for All Items.
   Code placeholder:  // PASTE jsCode of node "Final match" from apps/workflows/dist/B_match.json
18. "Save matches" — Postgres, "Loan DB", Execute Query.
   Query placeholder:  -- PASTE apps/workflows/src/sql/b_save_matches.sql
   Query Parameters: {{ [$json.batch_id, JSON.stringify($json.rows), $('Plan classes').first().json.pg.income, $('Plan classes').first().json.pg.credit, $('Plan classes').first().json.pg.age, JSON.stringify($json.funnel)] }}
19. "Run workflow C (notify)" — Execute Workflow node, source Database, workflow "C · Notify matched users", Wait For Sub-Workflow Completion = OFF.

Connections (exact):
- "Doorbell webhook" → "Verify signature" → "Claim batch"
- "Sweeper every 2 min" → "Find stalled batch" → "Claim batch"
- "Claim batch" → "Load products" → "Plan classes" → "Load user classes" → "Match (bitset)" → "Lookup LLM cache" → "Uncached questions" → "Need LLM?"
- "Need LLM?" TRUE → "Build LLM batches" → "LLM judge" → "Parse judgments" → "Save judgments" → "Final match"
- "Need LLM?" FALSE → "Final match"
- "Final match" → "Save matches" → "Run workflow C (notify)"
```

---

## Prompt 4 — Workflow A: discover loan products (daily crawler)

```text
Build an n8n workflow named "A · Discover loan products (crawler)". Build ONLY the graph and node settings exactly as specified; do not invent nodes or write custom logic. Where I say "placeholder", put exactly that one comment line (I will paste tested code later). Workflow settings: timezone Asia/Kolkata; Error workflow = "E · Error handler".

Purpose: once a day, read each lender's eligibility and rates pages, and call the LLM ONLY when a lender's eligibility text actually changed. The cheapest check comes first: HTTP 304 Not Modified, then a hash of the keyword-windowed text, then the LLM. The LLM output is accepted only where every number has a verbatim quote from the page. Layout changes are handled by reading visible text (no CSS selectors). An empty extraction counts as a failure, keeps yesterday's products, and forgets the page validators so the next run retries. Politeness: one request per second, honest User-Agent.

Nodes, in order:
1. "Daily 02:00 IST" — Schedule Trigger, cron expression "0 2 * * *".
2. "Run now" — Manual Trigger.
3. "Load sources" — Postgres, credential "Loan DB", Execute Query. Settings: Execute Once = ON.
   Query placeholder:  -- PASTE apps/workflows/src/sql/a_load_sources.sql
4. "Fetch page" — HTTP Request, GET, URL {{ $json.url }}.
   Send Headers ON: "User-Agent" = "ClickPeLoanEngine/1.0 (loan comparison research; daily)"; "Accept-Encoding" = "gzip, br"; "If-None-Match" = {{ $json.etag }}; "If-Modified-Since" = {{ $json.last_modified }}.
   Options: Timeout 20000 ms; Redirects: follow, max 5; Response: Include Response Headers and Status (full response) ON, Never Error ON, Response Format = Text; Batching: 1 item per batch, 1000 ms interval.
   Settings: Retry On Fail ON, Max Tries 2, Wait Between Tries 5000 ms; On Error = "Continue (regular output)".
5. "Extract section" — Code node, Run Once for All Items.
   Code placeholder:  // PASTE jsCode of node "Extract section" from apps/workflows/dist/A_crawl.json
6. "Group by lender" — Code node, Run Once for All Items.
   Code placeholder:  // PASTE jsCode of node "Group by lender" from apps/workflows/dist/A_crawl.json
7. "Changed?" — If node. Condition: Boolean {{ $json.changed }} is true.
8. "Build extraction request" — Code node, mode "Run Once for Each Item".
   Code placeholder:  // PASTE jsCode of node "Build extraction request" from apps/workflows/dist/A_crawl.json
9. "LLM extract" — HTTP Request, POST, URL {{ $vars.LLM_BASE_URL.replace(/\/$/, '') }}/chat/completions
   Authentication: Generic Credential Type → Header Auth → credential "LLM API".
   Send Body: JSON, body = {{ JSON.stringify($json.request) }}
   Options: Timeout 90000 ms; Response → Never Error ON.
   Settings: Retry On Fail ON, Max Tries 3, Wait Between Tries 5000 ms; On Error = "Continue (regular output)".
10. "Validate products" — Code node, mode "Run Once for Each Item".
   Code placeholder:  // PASTE jsCode of node "Validate products" from apps/workflows/dist/A_crawl.json
11. "Save products" — Postgres, "Loan DB", Execute Query. Settings: Always Output Data ON.
   Query placeholder:  -- PASTE apps/workflows/src/sql/a_save_products.sql
   Query Parameters: {{ [$json.lender, JSON.stringify($json.products), 'llm'] }}
12. "Join branches" — Merge node, mode Append (2 inputs).
13. "Page states" — Code node, Run Once for All Items. Settings: Execute Once ON.
   Code placeholder:  // PASTE jsCode of node "Page states" from apps/workflows/dist/A_crawl.json
14. "Save page state" — Postgres, "Loan DB", Execute Query.
   Query placeholder:  -- PASTE apps/workflows/src/sql/a_save_page_state.sql
   Query Parameters: {{ [$json.url, $json.outcome, $json.etag, $json.last_modified, $json.section_hash, $json.bytes, $json.error] }}

Connections (exact):
- "Daily 02:00 IST" → "Load sources"
- "Run now" → "Load sources"
- "Load sources" → "Fetch page" → "Extract section" → "Group by lender" → "Changed?"
- "Changed?" TRUE → "Build extraction request" → "LLM extract" → "Validate products" → "Save products" → "Join branches" INPUT 1
- "Changed?" FALSE → "Join branches" INPUT 2
- "Join branches" → "Page states" → "Save page state"
```

---

## 5. After the AI builds each workflow: paste checklist

1. **SQL:** for every Postgres node, replace the `-- PASTE …` line with the full contents of that `.sql` file.
2. **Code:** open `apps/workflows/dist/<file>.json`, find the node with the **same name**, and copy its `parameters.jsCode` (the whole thing) into the Code node.
3. **Cloud only:** in the pasted code, find and replace **`$env.` → `$vars.`** (the `dist/` files are the self-hosted versions).
4. **Check the details the AI most often gets wrong:**
   - **If / Loop wiring:** each output goes where §Connections says. In particular, Loop's **done** goes to Finish and **loop** goes to Send via SES.
   - **Merge** in workflow A goes into **two different inputs**.
   - **Settings:** retry and on-error on the HTTP and SES nodes; Always Output Data and Execute Once where listed.
   - **Error workflow** set in each workflow's settings.
5. **If Cloud blocks `require('crypto')`** in Code nodes (signature check, unsubscribe token), that's a Cloud sandbox limit. Run self-hosted, where `docker-compose.yml` enables it with `NODE_FUNCTION_ALLOW_BUILTIN=crypto`.
6. **Activate in this order:** E, C, B, A. Test:
   - **A:** click *Run now*. `loan_products` fills.
   - **B and C:** run `go run ./apps/ingest_local data/demo_users.csv` with `N8N_WEBHOOK_URL` = your n8n webhook URL. The upload page timeline should walk through matched → emails sent.

## 6. Why each workflow is shaped this way (for the video)

- **Every Postgres node only calls a tested SQL file.** All set logic runs inside the database in one round trip.
- **Every Code node only calls tested JS modules.** They are unit-tested with `node --test`, and checked against a brute-force oracle on 10,000 real rows.
- **Claims are compare-and-set**, so duplicate triggers are harmless.
  - The sweeper reclaims a crashed run after its lease expires.
  - The LLM can fail without stopping matching.
  - The database makes duplicate emails impossible.
- **Details:** DESIGN §7 (flows), §9.5–9.10, §9.14 (races).
