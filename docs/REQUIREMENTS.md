# Brief → Build Traceability

> Every sentence of the assignment, what it obliges or allows, how we satisfy it, which rubric line it scores on, and what could go wrong.
> Rule we follow: **do exactly what the brief says, take every bonus it names, and add only what scores on the rubric.**

Rubric: **n8n 30** · **Cloud 20** · **Backend & code quality 30** · **Docs & video 20**.

---

## 1. Things the brief explicitly ALLOWS (so we don't over-build)

| Brief says | What it frees us from |
|---|---|
| "send the email to a test inbox you control… Use test-inbox aliases such as abcd+one@gmail.com" | **No custom domain needed.** Sender = our Gmail verified in SES; recipients = our `+aliases` |
| "Use an LLM API you have access to… Paid access is not required" | Free tier is fine (e.g. Gemini). Our design needs only a handful of calls |
| "Local deployment is acceptable; public deployment on AWS is a plus" | Must work locally; AWS deploy is a bonus, **which we will do** |
| "You are not expected to incur cloud costs" | Stay inside free tier/credits: no NAT Gateway, smallest RDS, short-lived demo, teardown documented |
| "API Gateway is optional" | We use it anyway, because presign + status endpoints need an HTTPS front door |
| "you can choose 2-3 relevant sites" | 2–3 sites; we pick the ones that crawl reliably |
| "Handling changes in website layouts is optional" | Optional means bonus, **so we do it** (layered extraction + LLM fallback + evidence check) |
| "Design Decisions: A **brief** explanation" | README stays short; the deep material lives in `docs/` and is linked |
| "Provide a **minimal** UI" | Upload + status only. No dashboards |

---

## 2. Line-by-line mapping

### Core technologies
| # | Brief (exact words) | How we satisfy it | Rubric | Risk / to verify |
|---|---|---|---|---|
| T1 | "Backend Language: Python or Go" | **Go** — chosen on measurement: 1M-row ingest 6.0–6.8 s vs 15.0 s for tuned Python (DESIGN §9.15). Python remains as the test/eval harness | Code 30 | — |
| T2 | "AWS (Lambda, RDS for PostgreSQL, SES for email)" | Lambdas: `upload`, `status`, `ingest`. RDS Postgres. SES via the n8n node | Cloud 20 | **RDS cost:** check whether the AWS account has free tier or credits (AWS changed its free-tier model in 2025 for new accounts) |
| T3 | "A self-hosted n8n instance" | `docker-compose.yml`: n8n (pinned version) + Postgres for n8n's own state | n8n 30 | **Disk space** for images |
| T4 | "Use an LLM API… for specific AI tasks" | LLM used for **specific tasks only**: compiling product criteria at crawl time and judging soft rules on cached keys. Never per pair | n8n 30 | Free-tier rate limits; handled by design |
| T5 | "Serverless Framework (for AWS resources) & Docker Compose (for n8n)" | `serverless.yml` defines S3, SQS + DLQ, Lambdas, API Gateway, RDS, IAM, SES identity | Cloud 20 | **Serverless Framework v4 requires a login** (free for individuals/small orgs). Fallback: v3 or the open-source fork. Check at setup |

### 1. Scalable user data ingestion
| # | Brief | How we satisfy it | Rubric | Risk |
|---|---|---|---|---|
| I1 | "robust and scalable mechanism for uploading a CSV file" | **S3 multipart, resumable**, per-part checksums, server-enforced size | Cloud 20 ("Scalability of the data ingestion method") | CORS on the bucket must expose the `ETag` header, or the browser can't read part ETags |
| I2 | "(e.g., user_id, email, monthly_income, credit_score, employment_status, age)" | Exactly these, plus `name` (present in the real CSV; used to personalize emails) | Code 30 | — |
| I3 | "A direct upload through a standard Lambda-backed API Gateway endpoint can hit request size and timeout limits" | File bytes never pass through API Gateway or Lambda; only metadata does | Cloud 20 | — |
| I4 | "a more professional, **event-driven** pattern" | **S3 ObjectCreated → SQS → ingest Lambda**, with DLQ and retries | Cloud 20 | — |
| I5 | "parsed and stored in a **dedicated table** within an Amazon RDS for PostgreSQL database" | Table `users`; streaming parse; COPY into staging → atomic upsert; invalid rows to `ingest_errors` | Code 30 ("Correct implementation of the data ingestion pipeline") | Sample CSV is perfectly clean, so we build a "nasty CSV" to show validation |

### 2. n8n
| # | Brief | How we satisfy it | Rubric | Risk |
|---|---|---|---|---|
| N1 | "set up and configure a self-hosted n8n instance using Docker" | Compose with a pinned image, `N8N_ENCRYPTION_KEY`, timezone `Asia/Kolkata`, healthcheck, volume | n8n 30 | Losing the encryption key makes saved credentials unreadable; documented |
| N2 | "**All core business logic** will be orchestrated through n8n workflows" | Crawling, matching, notifying all live in n8n. Lambda does only ingestion (the brief assigns ingestion to AWS) | n8n 30 | Don't move matching into Lambda, even though it would be easier |
| N3 | "interconnected workflows" | A → (catalogue) → B ← webhook from ingest; B → **Execute Workflow** → C; Error workflow attached to all | n8n 30 | — |

### Workflow A — crawler
| # | Brief | How we satisfy it | Rubric | Risk |
|---|---|---|---|---|
| A1 | "run on a schedule (e.g., once daily)" | **Schedule Trigger**, 02:00 IST, plus a manual trigger for the demo | n8n 30 | — |
| A2 | "Crawl a list of public financial websites (2-3)" | Site list in a config node / DB table → **Loop** → HTTP Request (Retry On Fail) | n8n 30 ("Creative use of n8n nodes for crawling") | **Sites may block bots or render with JavaScript.** Test candidates with curl on day 1 and keep only those returning server-side HTML |
| A3 | "Extract… product_name, interest_rate, and the eligibility criteria (e.g., minimum monthly income, required credit score range)" | **HTML node** (CSS selectors) first → LLM compile into a typed schema on change → validation | n8n 30 | Many banks don't publish a credit score cutoff: store `NULL` = "not stated", never 0 |
| A4 | "Store… in a **new loan_products table**" | Table named exactly `loan_products`; upsert on `product_key` | Code 30 | — |
| A5 | "Handling changes in website layouts is optional" | **Bonus done:** selectors → LLM fallback when selectors fail → verbatim-evidence check → drift alarm | n8n 30 | — |

### Workflow B — matching
| # | Brief | How we satisfy it | Rubric | Risk |
|---|---|---|---|---|
| B1 | "triggered via a **webhook** after a new CSV… successfully processed" | Ingest Lambda POSTs to the n8n **Webhook** node (Header Auth) once the batch is committed. Sweeper as safety net | Cloud 20 ("Seamless and secure integration") | **Lambda in AWS can't reach `localhost`.** Needs a tunnel (Cloudflare / ngrok) for the public deploy. Local mode: Lambda logic runs locally and calls `localhost` directly |
| B2 | "Fetch the **newly added** user records" | Postgres node: `WHERE last_batch_id = {{batch_id}}` | n8n 30 | — |
| B3 | "Fetch the **entire list** of available loan products" | Postgres node: all active products | n8n 30 | — |
| B4 | "Implement the core matching logic **within n8n**" | **Code node**: coordinate compression + bitset matching over classes. SQL pre-filter as stage 1 (the brief's own example) | n8n 30 | Keep the logic visible and commented in the node |
| B5 | "For every successful match, store the result… in a **matches table**" | Table named exactly `matches(user_id, product_id, …)` | Code 30 | — |
| B6 | Treasure Hunt: "multi-stage, optimized filtering pipeline… reduce the number of user-product pairs before using an LLM" | **Stage 0** LLM compiles rules at crawl time → **Stage 1** SQL hard filter → **Stage 2** n8n bitset/rules on equivalence classes → **Stage 3** LLM only on uncached projected keys. Funnel counts logged per run | n8n 30 (**"key factor"**) | Measured on the real CSV: 100,000 naive pairs → 32,325 → 113 LLM keys (10 illustrative products; redo with crawled ones) |

### Workflow C — notification
| # | Brief | How we satisfy it | Rubric | Risk |
|---|---|---|---|---|
| C1 | "run **after** the matching process (Workflow B) is complete" | B's last node: **Execute Workflow → C** | n8n 30 | — |
| C2 | "For each user who has **new matches**" | `matches.notified_at IS NULL` → group per user. Re-runs never resend | n8n 30 | — |
| C3 | "construct a **personalized** email" | Name, top products, rate, why they qualify, what's still to confirm, disclaimer. Plus, when worth it, a signed link to ≤ 3 questions (Workflow D, §4 below) | Docs/video 20 | — |
| C4 | "Using the **AWS SES node in n8n**" | The built-in **AWS SES** node (not HTTP Request), HTML body, Loop + Wait for the 1/s sandbox rate | n8n 30 | **Verify the SES node's fields** (HTML, additional options). Custom headers like List-Unsubscribe are likely unsupported, so those are documented, not built |
| C5 | "send… to a test inbox you control… **Do not email the sample CSV addresses**" | Recipient rewrite `<gmail>+u<n>@gmail.com` + **allowlist guard** that refuses anything else. (The sample emails are `@example.com`, a reserved domain, so they'd bounce anyway) | n8n 30 | **SES sandbox:** sender and each recipient must be verified. Test whether each `+alias` needs its own verification (the link lands in the same inbox) |
| C6 | "Show one received email in the demonstration video" | Gmail filter "never send to Spam" for our sender → the email shows in the inbox | Video 20 | Mail from gmail.com via SES may hit Spam without the filter |

### 3. UI
| # | Brief | How we satisfy it | Rubric | Risk |
|---|---|---|---|---|
| U1 | "**minimal** UI… initial upload of the user data CSV… primary interaction point for starting the entire pipeline" | One static page: choose file → multipart upload with progress → status timeline (validated → matched → emailed) with funnel numbers | Docs/video 20 | Don't over-build |

### Deliverables
| # | Brief | How we satisfy it | Risk |
|---|---|---|---|
| D1 | "**private** repository… collaborators: ujjwalkala-clickpe, HarshSrivastav-Dailype, ManishBiswal-clickpe, tushar-clickpe" | Private GitHub repo; invite all 4 (`gh api` or the web UI) | Check the exact usernames when inviting; invites must be accepted, so send them early |
| D2 | "A serverless.yml file to deploy **all required AWS resources**" | Includes RDS, S3, SQS + DLQ, Lambdas, API Gateway, IAM, SES identity, SSM params | RDS takes about 10 minutes to create; `sls remove` documented to avoid cost |
| D3 | "A docker-compose.yml file for launching your self-hosted n8n" | ✓ (plus an optional local Postgres for local mode) | — |
| D4 | "The JSON files for each of your n8n workflows" | `n8n/workflows/*.json`, exported **without credentials** (n8n exports only credential references) | Re-export after every change; check that no secrets are embedded in Code nodes |
| D5 | README: "Architecture Diagram" | Mermaid diagram (renders on GitHub) + PNG | — |
| D6 | README: "Step-by-step… deploy the AWS stack and launch the n8n container… **how to configure all necessary credentials (AWS, database) within n8n**" | Step-by-step section with screenshots: creating the AWS credential (IAM user limited to SES), the Postgres credential (host/SSL), the LLM credential, Header Auth for the webhook | Explicitly required; easy to forget |
| D7 | README: "Design Decisions: brief explanation of workflow design, web crawling strategy, and especially… Optimization Treasure Hunt" | Short README section + links to `docs/` | — |
| D8 | Video 5–10 min: "walkthrough of your n8n workflows, explaining the logic of **each node**" + "live, end-to-end" + "email received" | Script: architecture (1 min) → each workflow node by node (4 min) → live upload → DB rows → matches → inbox (3 min) → funnel numbers and trade-offs (1 min) | Stay under 10 minutes; rehearse |
| D9 | "within 72 hours" | Started 2026-10-19 → submit by **2026-10-22** | — |

### Evaluation wording → where we push to the max
| Rubric phrase | Our answer |
|---|---|
| "Sophistication, robustness, and efficiency of your n8n workflows" | Node-level Retry On Fail, error outputs, Error Trigger workflow, sweeper, idempotent writes, funnel metrics |
| "Creative use of n8n nodes for crawling, data manipulation, and logic" | Schedule, HTTP Request, HTML extract, Code (bitset), LLM chain with structured output parser, Postgres, Loop Over Items, IF/Switch, Merge, Execute Workflow, Wait, AWS SES, Webhook (Header Auth), Error Trigger |
| "Optimization Treasure Hunt… key factor" | 4-stage funnel with measured numbers in the video |
| "Quality of the AWS serverless design" | Multipart → S3 → SQS → Lambda, DLQ, least-privilege IAM, SSM secrets |
| "Seamless and secure integration between AWS services and the self-hosted n8n instance" | Tunnel (no open ports), webhook Header Auth, SES IAM user limited to sending, RDS TLS-only + strong SSM-stored password (Lambda IPs can't be allowlisted without a NAT) |
| "Scalability of the data ingestion method" | Resumable multipart, streaming parse, COPY; 1M-row load test numbers |
| "Correct implementation… Clean, modular, and well-commented code" | Small modules (`parse`, `validate`, `load`, `notify_n8n`), type hints, docstrings explaining *why*, tests |
| "Clarity of the architecture diagram and README.md" | One clear diagram; README you can follow from a fresh machine |
| "Quality and comprehensiveness of the video" | Scripted, every node explained, real email shown |

---

## 3. Things that could cause problems → check first (day 1)

| # | Risk | How we check | Fallback |
|---|---|---|---|
| R1 | Lending sites block bots or need JavaScript | `curl -A "<UA>"` each candidate; look for the rate/eligibility text in the raw HTML | Pick other lender pages; save HTML snapshots for the eval and as a demo fallback |
| R2 | AWS Lambda can't reach local n8n | Start the tunnel; `curl` the webhook from outside | Local mode for the demo; public deploy uses the tunnel |
| R3 | n8n (local) can't reach RDS | Security group allowing our IP; `psql "sslmode=require"` | Local Postgres in compose (the brief allows local deployment) |
| R4 | RDS not free on this account | Check AWS Billing → Free Tier / credits | Local Postgres for development; RDS only for the public-deploy recording, then `sls remove` |
| R5 | SES sandbox verification of `+aliases` | Verify the sender + 2 aliases in the SES console; send a test | Use 2–3 verified aliases only |
| R6 | Email lands in Spam | Send a test; check the folder | Gmail filter "Never send to Spam" |
| R7 | The n8n AWS SES node lacks a field we want | Build a 1-node test workflow | Keep features within what the node supports |
| R8 | LLM free-tier limits | One test call; note RPM | The cache + breaker keep us functional |
| R9 | Serverless Framework v4 login | `npx serverless --version` + login | Serverless v3 / the open-source fork |
| R10 | Disk space for Docker | `df -h` (1.9 GB free last check) | Free space before pulling images |

---

## 4. Beyond the brief: Workflow D (ask, don't guess)

The brief stops at "email each user their matches". It doesn't say what to do with matches we can't fully decide. This is our own addition.

| What we saw | What we built | Rubric | Risk / limit |
|---|---|---|---|
| On `users.csv`, 56,963 of 93,031 matches are "to confirm". They are blocked by only ~5 unknown facts (work experience, bank relationship, employer type, city, business vintage) | A planner picks ≤ 3 questions per person, per fact not per lender, only if the answer would unlock an offer worth showing. Computed per profile for the console, so it scales with classes, not users | n8n 30 ("creative use of n8n nodes… logic") | A rule in category "other" (apart from EMI affordability) can't be asked; that match stays "to confirm" |
| Asking needs a safe way back in | A signed, expiring link in the existing weekly email → `GET webhook/confirm?t=…` (form) → `POST webhook/confirm-submit`. Two Webhook + Respond to Webhook nodes in `D_confirm.json` | n8n 30, Cloud 20 ("secure integration") | Needs the public n8n URL (the same tunnel as the doorbell) |
| Answers must not become "approvals" | Sanity checks → answers stored as self-declared → re-check only that person's LIKELY matches with the existing LLM judge → "pre-qualified (self-declared)" email. Contradictions flagged for ops, not used. The lender still verifies documents | Code 30 | Self-declared data can be false. Production path: consented data (Account Aggregator bank statements, bureau soft pull, EPFO) instead of a form |
| Ops need to see whether it works | Funnel event `question_plan` (from B) and `confirmations: {asked, answered, flagged, unlocked}` on `GET /v1/batches/{id}` | Docs/video 20 | — |
