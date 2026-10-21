# n8n, explained through our own workflows

You don't need to know n8n before reading this. It covers:
- what n8n is
- the handful of ideas everything else is built on
- the "shapes" of workflow people build again and again
- how each of our four workflows is made of those shapes
- how to build things in the UI (no-code)
- how we build them from files (code)

At the end there are exercises to build by hand, from easy to hard.

Our n8n runs at http://localhost:5678 (`docker compose up -d`).

---

## 1. The five ideas everything rests on

### 1.1 Workflow = a graph of nodes
A **workflow** is a picture: boxes (**nodes**) joined by arrows (**connections**). Each node does one job and passes data to the next. Every workflow starts with exactly one kind of node, a **trigger**, which answers *"when does this run?"*

```
[Trigger] ──► [Do something] ──► [Decide] ──► [Do A]
                                        └───► [Do B]
```

### 1.2 Data flows as a list of *items*
This is the idea people trip on most. Between two nodes n8n doesn't pass "a value"; it always passes a **list of items**. Each item looks like `{ json: {...} }`.

```js
[ { json: { user_id: "U1", email: "a@x.com" } },
  { json: { user_id: "U2", email: "b@x.com" } } ]
```

**Most nodes run once per item.** If "Load pending" returns 3 rows, the next node receives 3 items. A "Send email" node after it sends 3 emails. You don't write a loop; the item list *is* the loop.

### 1.3 Expressions: `{{ ... }}`
Any field in any node can be a JavaScript expression in `{{ }}`. Expressions read data from earlier nodes:

| Expression | Means |
|---|---|
| `{{ $json.email }}` | field `email` of *the current item* (from the node directly before) |
| `{{ $('Claim batch').first().json.batch_id }}` | the first item that node "Claim batch" produced, anywhere earlier in the graph |
| `{{ $('Loop one at a time').item.json.notification_id }}` | the item in "Loop…" that *this* item came from (n8n tracks this "paired item" link) |
| `{{ $env.SES_FROM_EMAIL }}` | an environment variable of the n8n container |
| `{{ $now }}` | the current time (Luxon DateTime) |

We use all of these. See `C_notify.json` → nodes "Finish" and "Mark failed".

### 1.4 Credentials live outside the workflow
Passwords and API keys are stored **encrypted** by n8n under a name ("Loan DB", "AWS SES", "LLM API"). A workflow only stores *the credential's name/id*, never the secret. That's why `dist/*.json` is safe to commit.

### 1.5 Executions
Every run is saved as an **execution**: the input and output of every node, so you can click through it afterwards. In the UI this is the **Executions** tab of each workflow, and it's the first place to look when debugging.

**Publish** (called "Activate" before n8n 2.x) turns a workflow's automatic triggers on: schedule, webhook and so on. An unpublished workflow only runs when you click **Execute workflow**.

---

## 2. The node families (what's in the toolbox)

| Family | Common nodes | What they're for | Used by us in |
|---|---|---|---|
| **Triggers** | Manual, Schedule, Webhook, Form, Chat, Execute Workflow Trigger, Error Trigger, app triggers (Gmail, Slack, Stripe…) | *When* it runs | A (Schedule + Manual), B (Webhook + Schedule), C (Execute Workflow Trigger), E (Error Trigger) |
| **App / action nodes** | Postgres, AWS SES, Gmail, Slack, Google Sheets, Notion… (500+) | Talk to one service without writing API code | Postgres everywhere, AWS SES in C |
| **HTTP Request** | (one node) | Talk to *any* API that doesn't have its own node | A (fetch bank pages, call LLM), B (LLM judge) |
| **Flow / logic** | IF, Switch, Merge, Loop Over Items, Wait, Filter, Execute Workflow, Stop and Error | Branch, join, loop, pause, call another workflow | IF in A/B/C, Merge in A, Loop + Wait in C, Execute Workflow in B |
| **Data shaping** | Edit Fields (Set), Aggregate, Split Out, Sort, Limit, Remove Duplicates, Summarize | Reshape items without code | (we do this in Code nodes; see §5) |
| **Code** | Code (JavaScript or Python) | Anything the other nodes can't express | Signature check, matcher, email rendering, crawl parsing |
| **AI** | AI Agent, Basic LLM Chain, Information Extractor, Vector stores, Chat models | LLM features as nodes | We call the LLM via HTTP Request instead (§5) |

---

## 3. The workflow "shapes" people build over and over

Almost every n8n workflow you'll ever see is one of these patterns, or a few chained together. Learn the patterns, not the 500 nodes.

### P1. Scheduled sync / ETL: "every night, copy X into Y"
```
[Schedule] → [Read source] → [Transform] → [Write destination]
```
Examples: nightly CRM → spreadsheet export, daily price scrape.
**Ours:** Workflow **A** (daily 02:00 IST crawl of bank pages → `loan_products`).

### P2. Webhook API: "when someone calls this URL, do X"
```
[Webhook] → [Validate] → [Do work] → (optional) [Respond to Webhook]
```
Examples: Stripe payment events, form submissions, a GitHub push.
**Ours:** Workflow **B**'s doorbell. Our Go ingest service POSTs `{batch_id}` to `/webhook/batch-loaded`.

*Security rule:* a webhook URL is public, so **always verify the caller**. We check an HMAC signature plus a timestamp in "Verify signature" (`src/code/signature.js`).

### P3. Event → notify: "when X happens, tell someone"
```
[Trigger] → [Load who to tell] → [Render message] → [Send email/Slack/SMS]
```
**Ours:** Workflow **C** (matches → SES emails).

### P4. Polling / sweeper: "every N minutes, check whether something got stuck"
```
[Schedule] → [Query: anything waiting too long?] → [Process it]
```
This is the safety net behind P2: if a webhook call is lost, the poller finds the work anyway.
**Ours:** B's "Sweeper every 2 min" → "Find stalled batch". It's the reason a lost doorbell can never lose a batch.

### P5. Loop with rate limit: "do this per item, slowly"
```
[Items] → [Loop Over Items (batch 1)] → [Call API] → [Wait 1s] ─┐
                ▲                                            │
                └────────────────────────────────────────────┘
          (loop's "done" output) → [Summary]
```
You use this when an API has a rate limit (SES sandbox: 1 email/second) or when you need per-item error handling.
**Ours:** C's "Loop one at a time" → "Send via SES" → "Mark sent/failed" → "Throttle 1 s" → back to the loop.

### P6. Branch + merge: "do extra work only when needed, then continue together"
```
[Data] → [IF changed?] ─true─► [Expensive step] ─► [Merge] → [Continue]
                       └false──────────────────────►┘
```
**Ours:** A's "Changed?". The LLM is only called if the bank page's content hash changed, and "Join branches" re-unites both paths. B's "Need LLM?" works the same way: it skips the LLM when everything is answered from cache.

### P7. Sub-workflow: "split a big flow into callable pieces"
```
Workflow 1: … → [Execute Workflow: "Workflow 2"]
Workflow 2: [Execute Workflow Trigger] → …
```
Like calling a function: each piece can be tested, re-run and owned separately.
**Ours:** B ends with "Run workflow C (notify)"; C starts with "Called by workflow B".

### P8. Error workflow: "when anything fails, record or alert"
```
[Error Trigger] → [Log to DB / Slack / email]
```
In each workflow's **Settings → Error workflow** you point at it. n8n then runs it whenever that workflow's execution fails.
**Ours:** Workflow **E** writes the failure into `pipeline_events`, which the console's batch timeline shows.

### P9. Retry and fallback per node
This lives in the node's **Settings** tab rather than in the graph:
- **Retry On Fail** (max tries, wait between). Ours: HTTP and SES nodes retry 3× with a 2 s wait.
- **On Error**: *Stop workflow* (default) / *Continue* / **Continue (using error output)**. The last option gives the node a second, red output for failures.
  Ours: "Send via SES" uses the error output → "Mark failed", so one bad address never kills the whole run.
- **Always Output Data**: emit an empty item instead of nothing, so the chain continues.

### P10. Human-in-the-loop
```
[…] → [Send approval email with link] → [Wait: until webhook/form is called] → [continue]
```
Examples: expense approvals, content review. *(Not used by us.)*

### P11. AI agent / RAG
```
[Chat Trigger] → [AI Agent] ←tools— [HTTP / DB / Calculator]
                       ←memory— [Postgres chat memory]
                       ←model—  [OpenAI / Claude / Gemini]
```
```
RAG ingest: [Trigger] → [Load docs] → [Split text] → [Embeddings] → [Vector store]
```
These are the "AI" flows people build most with n8n today. We deliberately use *structured extraction via HTTP Request* instead (§5).

### P12. Scrape + LLM extraction
```
[Fetch page] → [Clean HTML → text] → [LLM: "return JSON with these fields"] → [Validate JSON] → [Save]
```
**Ours:** Workflow A from "Fetch page" to "Save products". The **Validate** step matters: never trust an LLM's JSON without checking it.

---

## 4. Our four workflows, node by node

Open each one at http://localhost:5678 while reading.

### E · Error handler (P8)
| Node | Type | Does |
|---|---|---|
| On workflow error | Error Trigger | n8n hands over: which workflow, which node, the error message |
| Record failure | Postgres | `INSERT INTO pipeline_events …` with `$1..$4` parameters |

### C · Notify matched users (P7 + P3 + P5 + P9)
| Node | Type | Does |
|---|---|---|
| Called by workflow B | Execute Workflow Trigger | Receives `{batch_id}` from B |
| Claim batch | Postgres | `MATCHED → NOTIFYING` with a compare-and-set, so two runs can't both send |
| Queue notifications | Postgres | One `PENDING` row per user, enforcing the "max 1 email per user per week" cap with a unique index |
| Load pending | Postgres | Rows to send now (capped by `MAX_EMAILS_PER_RUN`) |
| Render emails | Code | HTML email + signed unsubscribe link; TEST_MODE rewrites recipients to your Gmail `+aliases` |
| Any email? | IF | Nothing to send → go straight to Finish |
| Loop one at a time | Loop Over Items | Output 1 = "next item", output 0 = "all done" |
| Send via SES | AWS SES | Retries 3×; failures go out of the red error output |
| Mark sent / Mark failed | Postgres | Record the outcome (failed 3× → `FAILED` for good) |
| Throttle 1 s | Wait | Stay under SES's 1 email/s sandbox limit |
| Finish | Postgres | Count SENT/FAILED/PENDING, batch → `DONE` |

### B · Match users to loans (P2 + P4 + P6 + P7)
| Node | Type | Does |
|---|---|---|
| Doorbell webhook | Webhook | `POST /webhook/batch-loaded` from the Go ingest |
| Verify signature | Code | HMAC + timestamp check; bad calls produce 0 items, so nothing after it runs |
| Sweeper every 2 min / Find stalled batch | Schedule + Postgres | P4 safety net |
| Claim batch | Postgres | `LOADED → MATCHING` compare-and-set: only one run wins even if the doorbell and sweeper fire together |
| Load products | Postgres | The loan catalogue |
| Plan classes | Code | Turns product thresholds into "buckets" (the Optimization Treasure Hunt) |
| Load user classes | Postgres | `GROUP BY` users into ~229 classes instead of 10,000 rows |
| Match (bitset) | Code | Each class × product checked once, with bitsets |
| Lookup LLM cache → Uncached questions → Need LLM? | Postgres, Code, IF | Ask the LLM only about soft rules it hasn't answered before |
| Build LLM batches → LLM judge → Parse judgments → Save judgments | Code, HTTP, Code, Postgres | Batched LLM calls; the replies are validated and cached |
| Final match → Save matches | Code + Postgres | Expand classes back into user×product rows, set-based |
| Run workflow C (notify) | Execute Workflow | P7 |

### A · Discover loan products (P1 + P6 + P12)
| Node | Type | Does |
|---|---|---|
| Daily 02:00 IST / Run now | Schedule + Manual | Two ways to start |
| Load sources | Postgres | Which bank URLs to crawl (`crawl_sources` table) |
| Fetch page | HTTP Request | Download the HTML (retry; don't stop on failure) |
| Extract section | Code | HTML → just the eligibility/rates text, plus a content hash |
| Group by lender | Code | One LLM call per lender, not per page |
| Changed? | IF | Hash same as last time → skip the LLM (saves money) |
| Build extraction request → LLM extract → Validate products | Code, HTTP, Code | P12 |
| Save products | Postgres | Upsert into `loan_products` |
| Join branches | Merge | Changed and unchanged paths meet again |
| Page states → Save page state | Code + Postgres | Remember ETag, content hash and outcome per page, so tomorrow's run can skip unchanged pages (conditional GET + hash) |

---

## 5. No-code vs code: when we used which, and why

n8n lets you do most things with native nodes (no code) **or** in a Code node. Our rule:

| Use a **native node** when… | Use a **Code node** when… |
|---|---|
| It talks to a service (Postgres, SES, HTTP) | The logic is an *algorithm* (bitset matching, HMAC check) |
| It's control flow you want *visible* on the canvas (IF, Loop, Wait, Merge) | You need unit tests (Code nodes' logic lives in `src/code/*.js`, tested with `node --test`) |
| A non-developer must be able to change it | The same logic would take 10 Set/IF nodes and be unreadable |

So the **graph shows the business process**: trigger, claim, match, notify, error. The **hard parts are tested code**.

The same reasoning applies to the LLM. We use plain **HTTP Request** to any OpenAI-compatible API rather than the AI Agent nodes, for three reasons:
- the request is fully visible
- recorded replies can be replayed in tests
- you can switch provider by changing `LLM_BASE_URL`

The AI Agent nodes are great for *chat* (P11). For one-shot "return this JSON" extraction they add hidden prompts you can't test.

**SQL** follows the same idea. Every query lives in `src/sql/*.sql` and runs through the Postgres node's **Query Parameters** (`$1`, `$2`). Values are never pasted into the SQL string, so SQL injection is impossible.

---

## 6. Workflows as code (how our repo builds them)

Under the hood, a workflow is just JSON:

```json
{ "name": "E · Error handler",
  "nodes": [ { "name": "Record failure", "type": "n8n-nodes-base.postgres", "typeVersion": 2.5,
               "parameters": { "operation": "executeQuery", "query": "INSERT …",
                               "options": { "queryReplacement": "={{ [ … ] }}" } },
               "credentials": { "postgres": { "id": "loanEngineDbCred", "name": "Loan DB" } } } ],
  "connections": { "On workflow error": { "main": [[ { "node": "Record failure", "type": "main", "index": 0 } ]] } },
  "settings": { "timezone": "Asia/Kolkata", "errorWorkflow": "…" } }
```

`connections[node].main[i]` is the list of nodes wired to **output i**. For an IF node, i=0 is the *true* output and i=1 is *false*. For Loop Over Items, i=0 is *done* and i=1 is *loop*.

**Our pipeline:**
```
src/code/*.js     (tested JS)  ─┐
src/sql/*.sql     (tested SQL) ─┼─► build.py ─► dist/*.json ─► docker/init.sh:
src/workflows/*.py (the graphs)─┘                               n8n import:credentials
                                                                n8n import:workflow
                                                                n8n publish:workflow
```
`src/workflows/wf_error.py` is the whole of workflow E in 10 lines. Read it next to the canvas.

**Ways to move workflows in and out of n8n** (all standard):
- **UI:** workflow menu (⋯) → *Download* / *Import from File* / *Import from URL*. You can also select nodes, Ctrl+C, and paste into a text editor: it's this JSON.
- **CLI:** `n8n export:workflow --all --separate --output=dir/`, and `n8n import:workflow --input=file.json`.
- **REST API:** `/api/v1/workflows` with an API key (Settings → n8n API).

**Editing loop for this repo:**
1. Change `src/…`.
2. Run `python apps/workflows/build.py`.
3. Run `docker compose up -d --force-recreate n8n`. It re-imports with the same ids, so nothing is duplicated.

If you edit on the canvas instead, export it back and port the change into `src/`, or the next import overwrites it. `dist/` is generated: never hand-edit it.

---

## 7. Gotchas that bite everyone

1. **"My node ran 10,000 times."** Nodes run per item. Use *Settings → Execute Once* (first item only), or aggregate first.
2. **"Node returned nothing, and everything after it silently didn't run."** Zero items means downstream doesn't run. That's how our signature check rejects a request. If you *do* want to continue, turn on *Always Output Data*.
3. **`.item` vs `.first()`.** Use `.item` inside per-item logic: it follows the paired-item link. Use `.first()` for "the one value of this run", like a batch_id.
4. **Test vs production webhook URL.** `/webhook-test/…` works only while you click *Listen for test event* in the editor. `/webhook/…` works only when the workflow is **published**.
5. **Pinned data.** You can pin a node's output so you can test later nodes without calling the API again. Unpin before publishing, or production will reuse the fake data.
6. **Timezone.** Schedules use the workflow's timezone setting. Ours are pinned to `Asia/Kolkata`.
7. **Webhook replies "Workflow was started" even for bad calls.** That's the "respond immediately" mode, and it's intentional: a caller can't learn anything from the reply. Rejection happens inside the run.
8. **`$env` on n8n Cloud.** It's blocked there. Cloud uses `$vars` (Variables) instead. That's why the Cloud prompts in `N8N-AI-BUILDER-PROMPTS.md` differ from `dist/`.
9. **Error workflow is per workflow**, not global: set it in each workflow's Settings.
10. **Loop Over Items outputs are "backwards"**: output 0 = done, output 1 = loop body.

---

## 8. Learn by building (exercises, in order)

Do these on your local n8n in a **new** workflow; don't edit A/B/C/E. Each takes 5–15 minutes.

**Ex 1: Hello items (Manual + Code + Edit Fields).**
1. Manual Trigger → Code node: `return [{json:{n:1}},{json:{n:2}},{json:{n:3}}];`
2. Add **Edit Fields**: field `double` = `{{ $json.n * 2 }}`.
3. Execute. You'll see 3 items in and 3 out, without writing a loop. (§1.2)

**Ex 2: Read our database (Postgres node).**
Manual → Postgres (*Execute Query*, credential **Loan DB**). Query `SELECT stage, status, at FROM pipeline_events ORDER BY id DESC LIMIT $1`, Query Parameters `{{ [5] }}`. You'll see our real pipeline log.

**Ex 3: Branch (IF).**
After Ex 2, add an IF with `{{ $json.status }}` *is equal to* `completed`. Run it and watch the items split across the true/false outputs. (P6)

**Ex 4: Your own webhook (P2).**
1. Webhook node, POST, path `hello`.
2. Add a **Respond to Webhook** node returning `{{ { you_sent: $json.body } }}`, and set the Webhook's *Respond* option to "Using 'Respond to Webhook' node".
3. Click *Listen for test event*, then run:
   `curl -X POST localhost:5678/webhook-test/hello -H 'Content-Type: application/json' -d '{"hi":1}'`
4. Then publish the workflow and call `/webhook/hello` instead. (Gotcha 4)

**Ex 5: Schedule + loop + wait (P1 + P5).**
Schedule (every minute) → Code returning 3 items → Loop Over Items (batch 1) → Wait 2 s → back into the loop. Wire the loop's *done* output to an Edit Fields "finished". Publish, wait a minute, and read the execution. (Gotcha 10)

**Ex 6: Error workflow (P8).**
Make a workflow with Manual → Code `throw new Error("boom")`. In its Settings, set Error workflow = **E · Error handler**. Run it, then `SELECT * FROM pipeline_events ORDER BY id DESC LIMIT 1;`. Your "boom" is there.

**Ex 7: Sub-workflow (P7).**
1. Workflow "Child": Execute Workflow Trigger → Edit Fields `greeting = Hello {{ $json.name }}`.
2. Workflow "Parent": Manual → Edit Fields `name = Asha` → Execute Workflow (pick "Child").
3. Run Parent. The Child's output comes back to Parent.

**Ex 8: Rebuild E by hand, then compare.**
Build E from scratch on the canvas (§4). Then download it and diff it against `apps/workflows/dist/E_errors.json`. This shows you UI and code are the same thing.

**Ex 9: Read C's last execution.**
Open C → Executions → click the latest run. Follow one email through Loop → SES → Mark failed → Throttle → back to the loop. This is how you debug any real flow.

**Ex 10 (optional, AI): Information Extractor.**
Manual → Edit Fields with a paragraph of loan text → **Information Extractor** node (attach a chat model with your LLM key), with attributes `min_income`, `min_credit_score`. Compare its output with what A's "Validate products" accepts, and think about why we validate.

When you can explain Ex 1–9 without looking, you can defend every node in A/B/C/E on the whiteboard.
