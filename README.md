# Loan Eligibility Engine

**What it does, in one line:** you upload a spreadsheet of people. The system checks which personal loans each person is likely to qualify for, using loan rules it reads from real lender websites every day. Then it emails each person their own list of loans.

It runs on **AWS** (for uploading and storing data) and a **self-hosted n8n** (for crawling, matching and emailing).

| | |
|---|---|
| 🎥 **Demo video** (5–10 min) | https://drive.google.com/drive/folders/1KtFQy6kbc3yavtGPWl6req-0r7M3-Tgo |
| 💻 **Live console** (try a CSV upload) | https://main.d25bd5m5z7i2j8.amplifyapp.com |
| 📦 **Repository** (private) | https://github.com/kaushalya4s5s7/clickpe-loan-engine |
| 🖼️ **Slides used in the video** | https://claude.ai/artifact/33Q3sRHLCF5L5zUzZodn1w |

---

## Contents

1. [Deliverables checklist](#1-deliverables-checklist)
2. [How it works (the short story)](#2-how-it-works-the-short-story)
3. [Architecture diagram](#3-architecture-diagram)
4. [The n8n workflows, node by node](#4-the-n8n-workflows-node-by-node)
5. [Setup and deployment](#5-setup-and-deployment)
6. [Design decisions](#6-design-decisions)
7. [Proof it works](#7-proof-it-works)
8. [Code layout and tests](#8-code-layout-and-tests)
9. [Known limits](#9-known-limits)

---

## 1. Deliverables checklist

Everything the assignment asked for, and where to find it.

| Asked for | Where it is |
|---|---|
| Private GitHub repo with all source code | This repo. Reviewers invited as collaborators |
| `serverless.yml` that deploys all AWS resources | [`serverless.yml`](serverless.yml) — API Gateway, 3 Lambda functions, S3, SQS + dead-letter queue, RDS PostgreSQL, IAM, SES sender user |
| `docker-compose.yml` for self-hosted n8n | [`docker-compose.yml`](docker-compose.yml) — n8n + Postgres, with an optional ngrok or Cloudflare tunnel |
| JSON file for each n8n workflow | [`apps/workflows/dist/`](apps/workflows/dist) — `A_crawl.json`, `B_match.json`, `C_notify.json`, `D_confirm.json`, `E_errors.json` |
| Architecture diagram | [Section 3](#3-architecture-diagram) |
| Setup and deployment steps, **including n8n credentials for AWS and the database** | [Section 5](#5-setup-and-deployment) (credentials in [5.2](#52-start-n8n-and-connect-its-credentials)) |
| Design decisions: workflow design, crawling strategy, **Optimization Treasure Hunt** | [Section 6](#6-design-decisions) |
| Demo video: walkthrough of every node, live end-to-end run, email in a test inbox | [Video link](https://drive.google.com/drive/folders/1KtFQy6kbc3yavtGPWl6req-0r7M3-Tgo) |

---

## 2. How it works (the short story)

Think of it as five steps, one after the other:

1. **Upload.** An operator opens the web console and picks a CSV of users. The file goes straight from the browser to Amazon S3 in small pieces, so even a very large file works and a broken upload can resume.
2. **Read and clean.** S3 tells a queue (SQS) that a file arrived. A Lambda function reads the file, fixes common spreadsheet mess (like `₹1,20,000` or `1.2L`), checks every row, and saves the users into PostgreSQL in one go. If more than 20% of rows are bad, nothing is saved.
3. **Find loans (daily).** Every night at 2 AM, n8n visits 15 lender websites, pulls out the eligibility rules (minimum income, credit score, age, job type) with the help of an LLM, and saves them as loan products.
4. **Match.** As soon as users are saved, the Lambda pings n8n. n8n compares every user with every loan product — quickly and cheaply (see the [Treasure Hunt](#63-the-optimization-treasure-hunt)).
5. **Email.** n8n sends each matched person one email through Amazon SES, listing the loans they may qualify for and why.

**Bonus step — ask instead of guess.** Some lender rules need facts the CSV doesn't have (for example, "2 years of work experience"). Instead of guessing, the email includes a link to answer up to 3 short questions. When the person answers, n8n re-checks only their loans and sends an update.

---

## 3. Architecture diagram

![Architecture: browser console, AWS (API Gateway, Lambdas, S3, SQS, RDS, SES) and self-hosted n8n in Docker](docs/architecture.png)

**Reading the diagram from left to right:**

| Part | What it is | What it does here |
|---|---|---|
| **Browser** | The console (Next.js, hosted on AWS Amplify) | Upload CSVs, watch progress, browse the loan catalogue |
| **API Gateway + API Lambda** | The front door to the backend | Starts uploads, reports progress, handles unsubscribe links. Protected by an API key with rate limits |
| **S3** | File storage | Receives the CSV directly from the browser |
| **SQS + DLQ** | A queue, plus a "failed" queue | Hands each new file to the ingest Lambda. Retries 3 times; after that the file goes to the failed queue and an alarm fires |
| **Ingest Lambda** | The file reader (Go) | Cleans, validates and saves users to the database, then pings n8n |
| **RDS PostgreSQL** | The database | Users, loan products, matches, emails sent, answers |
| **ngrok tunnel** | A fixed public HTTPS address for n8n | Lets AWS reach the n8n running on a laptop, without opening any ports |
| **n8n (Docker)** | Workflow engine | Runs workflows A–E: crawl, match, notify, confirm, error handling |
| **LLM** | Any OpenAI-compatible model (Gemini in the demo) | Reads lender pages into rules; judges a few soft rules |
| **Amazon SES** | Email sending | Sends the emails, through n8n's built-in AWS SES node |

**How AWS and n8n talk to each other securely**

- **AWS → n8n:** the ingest Lambda calls n8n's webhook with a **signed and timestamped** message. n8n rejects anything unsigned or old. If that call is ever lost, n8n checks the database every 2 minutes and picks up the batch anyway.
- **n8n → AWS:** n8n connects to RDS over TLS, and sends email with an IAM user that is **only allowed to send email** from one address — nothing else.
- **Secrets** live in AWS SSM Parameter Store and in `.env`. They never appear in the workflow JSON files.

A more detailed, step-by-step flow is in [docs/SYSTEM-FLOW.md](docs/SYSTEM-FLOW.md).

---

## 4. The n8n workflows, node by node

There are five workflows. Each has **one job**. They pass work to each other through a status field in the database, so if any of them crashes, it can simply run again without doing anything twice.

| Workflow | Starts when | Job |
|---|---|---|
| **A · Discover loan products** | Every day at 02:00 IST, or by hand | Crawl lender websites and save their rules |
| **B · Match users to loans** | Ping from AWS, or a check every 2 minutes | Match every new user to every loan |
| **C · Notify matched users** | Called by B | Send one email per person |
| **D · Confirm missing facts** | Person clicks the link in their email | Ask up to 3 questions, re-check, send an update |
| **E · Error handler** | Any of A–D fails | Log the failure so it shows in the console |

### A · Discover loan products

![Workflow A in n8n](docs/images/n8n-A-discover.png)

| Node | What it does |
|---|---|
| **Daily 02:00 IST** / **Run now** | Two ways to start: on a schedule, or by clicking |
| **Load sources** | Reads the list of 15 lender pages from the database |
| **Fetch page** | Downloads each page. Sends "only if changed since last time" headers, so unchanged pages come back empty and fast |
| **Extract section** | Throws away menus and scripts; keeps only text near words like *income*, *CIBIL*, *age*, *salaried* |
| **Group by lender** | Puts all pages of one lender together, so it costs one LLM call per lender |
| **Changed?** | Compares a fingerprint (hash) of the text with yesterday's. **Same text → skip the LLM entirely** |
| **Build extraction request** → **LLM extract** | Asks the LLM to turn the text into rules: min income, min credit score, age range, job types, interest rate |
| **Validate products** | Every number must come with an **exact quote from the page**. If the quote isn't really on the page, the number is thrown out. This stops made-up numbers |
| **Save products** | Saves the loan products. If extraction failed, yesterday's data is kept |
| **Join branches** → **Page states** → **Save page state** | Remembers each page's fingerprint for tomorrow |

### B · Match users to loans

![Workflow B in n8n, with its list of successful runs](docs/images/n8n-B-match.png)

| Node | What it does |
|---|---|
| **Doorbell webhook** → **Verify signature** | Receives the ping from AWS and checks it's really from our Lambda |
| **Sweeper every 2 min** → **Find stalled batch** | Backup trigger: finds any upload waiting to be matched, in case the ping was lost |
| **Claim batch** | Marks the batch "mine" for 15 minutes, so two runs can never match the same upload |
| **Load products** → **Plan classes** → **Load user classes** | **Stage 1** of the Treasure Hunt: groups users who look the same to every loan |
| **Match (bitset)** | **Stage 2**: checks the hard rules for each group with fast bit operations |
| **Lookup LLM cache** → **Uncached questions** → **Need LLM?** | **Stage 3**: finds soft rules that still need an opinion and haven't been answered before |
| **Build LLM batches** → **LLM judge** → **Parse judgments** → **Save judgments** | Asks the LLM only those new questions, and saves the answers for reuse |
| **Final match** → **Save matches** | **Stage 4**: turns group results back into per-person matches in one database call |
| **Run workflow C (notify)** | Hands over to the email workflow |

The panel on the left of the screenshot shows real runs: each one finished in **about half a second**.

### C · Notify matched users

![Workflow C in n8n](docs/images/n8n-C-notify.png)

| Node | What it does |
|---|---|
| **Called by workflow B** | Starts when B finishes |
| **Claim batch** | Makes sure only one run sends emails for this upload |
| **Queue notifications** | Creates one email row per person with **new** matches. A unique rule in the database makes a duplicate email impossible |
| **Load pending** → **Render emails** | Builds a personal HTML email: their loans, why they may qualify, and (if useful) a link to answer up to 3 questions |
| **Any email?** | Nothing to send → go straight to **Finish** |
| **Loop one at a time** → **Send via SES** | Sends each email through the n8n **AWS SES node** |
| **Mark sent** / **Mark failed** | Records the result. Failed sends are retried, then marked FAILED |
| **Throttle 1 s** | Waits 1 second between emails to stay within SES limits |
| **Finish** | Marks the upload as done |

### D · Confirm missing facts

![Workflow D in n8n](docs/images/n8n-D-confirm.png)

**Top row — the person opens the link:**
**Form link opened** → **Verify link** (signed, expires in 14 days) → **Valid link?** → **Load person** → **Render form** → **Show form**. Only that person's planned questions are shown.

**Bottom row — the person submits answers:**

| Node | What it does |
|---|---|
| **Answers submitted** → **Verify submission** → **Valid submission?** | Checks the link again; expired links get **Show expired page** |
| **Load answers context** → **Check answers** → **Answers readable?** | Sanity checks the answers (e.g. 30 years of experience at age 22 is flagged) |
| **Save declaration** → **Flagged?** | Saves answers as **self-declared**. Contradictions are flagged for a human, not used |
| **Build judge items** → **Anything to judge?** → **LLM judge** | Re-checks only this person's "to confirm" loans with the new facts |
| **Decide matches** → **Apply decisions** | Loans that now pass become **pre-qualified (self-declared)** |
| **Prepare reply** → **Email to send?** → **Send via SES** → **Mark notified** | Emails the person their newly unlocked loans |
| **Show result page** | Shows a thank-you page in the browser |

### E · Error handler

Every other workflow points to this one. When any node fails, E writes the error into a `pipeline_events` table, and it shows up in the console's timeline for that upload.

### How the workflow files are built

The JavaScript inside Code nodes lives in [`apps/workflows/src/code/`](apps/workflows/src/code) and every SQL query in [`apps/workflows/src/sql/`](apps/workflows/src/sql). Both are unit-tested. `python apps/workflows/build.py` stitches them into the JSON files in `apps/workflows/dist/`. That way the logic is tested like normal code, not hidden inside the n8n editor.

---

## 5. Setup and deployment

### 5.1 What you need

- Docker
- Go 1.25+, Node 22+
- Python 3.12 (only for the test harness)
- For AWS: AWS CLI v2 with credentials, and `npx` (for the Serverless Framework v3)

```bash
cp .env.example .env     # every variable is explained inside the file
python3 -m venv .venv && .venv/bin/pip install "psycopg[binary]>=3.2,<3.3" pytest ruff
```

### 5.2 Start n8n and connect its credentials

```bash
python apps/workflows/build.py     # build the workflow JSON files from source
docker compose up -d               # n8n opens at http://localhost:5678
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/loan_engine go run ./apps/migrate   # create tables
```

When the n8n container starts, [`apps/workflows/docker/init.sh`](apps/workflows/docker/init.sh) does three things for you:

1. **Creates the credentials from `.env`** — no clicking needed:

   | n8n credential name | Type | Filled from `.env` |
   |---|---|---|
   | **Loan DB** | Postgres | `APP_DATABASE_URL` (host, port, database, user, password; SSL is turned on when the URL has `sslmode=require`) |
   | **AWS SES** | AWS | `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` (the send-only IAM user) |
   | **LLM API** | Header Auth | `Authorization: Bearer $LLM_API_KEY` |

2. **Imports workflows** A, B, C, D and E.
3. **Publishes them** so they're live.

**Prefer to set credentials by hand?** In n8n go to **Credentials**, open **Loan DB**, **AWS SES** and **LLM API**, and type in the values from the table above. The workflows find credentials by these exact names.

### 5.3 Option A — try it locally (no AWS)

```bash
.venv/bin/python scripts/make_demo_csv.py 200 > data/demo_users.csv
set -a; source .env; set +a
go run ./apps/ingest_local data/demo_users.csv    # same Go code as the Lambda; pings n8n when done
```

Before the first run, open n8n and click **A · Discover loan products → Run now** once, so there are loan products to match against.

### 5.4 Option B — deploy to AWS

**Step 1 — store secrets in AWS SSM:**

```bash
aws ssm put-parameter --region ap-south-1 --name /loan-engine/db-password        --type SecureString --value "$(openssl rand -hex 24)"
aws ssm put-parameter --region ap-south-1 --name /loan-engine/webhook-secret     --type SecureString --value "<N8N_WEBHOOK_SECRET from .env>"
aws ssm put-parameter --region ap-south-1 --name /loan-engine/unsubscribe-secret --type SecureString --value "<UNSUBSCRIBE_SECRET from .env>"
```

**Step 2 — give n8n a public HTTPS address** (so AWS can reach it):

```bash
# Recommended: fixed address. Put NGROK_AUTHTOKEN and NGROK_DOMAIN in .env, then:
docker compose --profile ngrok up -d

# No account? Cloudflare quick tunnel (new random address each time):
docker compose --profile tunnel up -d && docker compose logs cloudflared | grep trycloudflare.com
```

Put `<that address>/webhook/batch-loaded` in `.env` as `N8N_WEBHOOK_URL`, and `<that address>/` as `N8N_PUBLIC_URL`.

**Step 3 — deploy:**

```bash
bash scripts/build_lambdas.sh          # build the Go Lambdas (~4 MB each)
npx serverless@3 deploy                # creates everything in serverless.yml (~10 min, mostly RDS)
bash scripts/deploy_web.sh && bash scripts/deploy_amplify.sh   # publish the console
npx serverless@3 info --verbose        # prints the API URL, API key and database host
DATABASE_URL="postgresql://loanadmin:<db-password>@<DatabaseHost>:5432/loan_engine?sslmode=require" go run ./apps/migrate
```

> **Shortcut:** after Step 1, `bash scripts/deploy_all.sh` runs Steps 2–4 for you, plus a smoke test.

**Step 4 — point n8n at the AWS database.** In `.env`, set `APP_DATABASE_URL` to the RDS URL above and `UNSUBSCRIBE_BASE_URL=<API URL>/v1/unsubscribe`. Run `docker compose up -d` again — the credentials are re-created automatically.

**Step 5 — open the console.** Open the Amplify URL printed by `deploy_amplify.sh`, paste the API key once, and click **Connect**.

**Check it works:**
```bash
API_URL=<API URL> API_KEY=<key> .venv/bin/python scripts/smoke_aws.py data/demo_users.csv
```

**Remove everything:** `npx serverless@3 remove` (nothing is left running or billing).

### 5.5 Email setup (no domain needed)

1. In **SES → Identities**, verify your Gmail address (`SES_FROM_EMAIL`).
2. Verify a few test aliases too (`you+one@gmail.com`, `you+two@gmail.com`…). They all arrive in the same inbox. SES sandbox only delivers to verified addresses.
3. In **IAM**, create an access key for the stack's `SesSenderUser` and put it in `.env`. This user can only send email.
4. Keep `TEST_MODE=true`: every recipient is replaced with one of your `TEST_RECIPIENTS`, up to `MAX_EMAILS_PER_RUN`. The sample CSV's `@example.com` addresses are never emailed.
5. Gmail may put these in spam, because "gmail.com sent via Amazon" fails domain checks. Add a Gmail filter: `from:<you>@gmail.com → Never send to Spam`. With a real domain we'd set up DKIM, SPF and DMARC.

### 5.6 LLM (any provider)

Set `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY`. Examples for OpenAI, Gemini, Anthropic and Groq are in `.env.example`. To measure how well it reads the saved bank pages:

```bash
set -a; source .env; set +a; .venv/bin/python scripts/eval_extraction.py   # target: ≥ 95% of numbers exactly right
```

---

## 6. Design decisions

### 6.1 Workflow design

- **One job per workflow.** Easier to read, test and re-run.
- **The database is the source of truth.** Each upload has a status (`LOADED → MATCHING → MATCHED → NOTIFYING → DONE`). A workflow claims the batch before working on it, so two runs can't collide, and a crashed run is picked up again after 15 minutes.
- **Two ways to start matching.** A signed ping from AWS (fast) plus a 2-minute check (safety net). Losing the ping only delays things; it never loses an upload.
- **No duplicate emails, ever.** Enforced by a unique rule in the database, not by "remembering".
- **n8n's own nodes for the visible steps** (Webhook, Schedule, Postgres, IF, Merge, Loop, Wait, AWS SES, Execute Workflow). Code nodes only for real logic, and that code is unit-tested outside n8n.

### 6.2 Web crawling strategy

The goal: read lender rules reliably, cheaply, and without breaking when a website changes its design.

1. **Be polite and lazy.** Ask each site "has this changed?" first (`ETag` / `Last-Modified`). About 1 request per second.
2. **Read text, not layout.** Instead of CSS selectors (which break on redesign), keep only text near eligibility words.
3. **Skip what hasn't changed.** If today's text has the same fingerprint as yesterday's, the LLM isn't called. On most days this costs **nothing**.
4. **Make the LLM prove it.** Every number it returns must come with an exact quote that really exists on the page. No quote → number dropped. This blocks made-up numbers and prompt-injection tricks hidden in web pages.
5. **Never make things worse.** If extraction fails, yesterday's rules stay.

### 6.3 The Optimization Treasure Hunt

**The problem:** checking every user against every loan with an LLM would mean `users × products` LLM calls — slow and very expensive.

**The idea:** each stage removes work before the next, more expensive stage. The LLM is the **last** resort, not the first.

| Stage | Where | Plain-English version | Cost |
|---|---|---|---|
| **1. Group similar users** | PostgreSQL | Every loan threshold (₹25k income, 700 score, age 21…) becomes a cut line. Users who fall between the same lines on every attribute look **identical to every loan**, so we check them once. **10,000 users → 229 groups** | One database scan |
| **2. Fast rule check** | n8n Code node | For each group, hard rules (income, score, age, job type) are checked with bit masks — a handful of very cheap operations per group | Tiny |
| **3. LLM only when needed** | n8n → LLM | Only soft rules (wording like "stable income") that we can actually judge and **have never judged before** go to the LLM. Answers are cached by *(loan, rule version, rule, group)*, so the cache grows with kinds of people, not number of people | **Usually 0 calls** |
| **4. Save in one go** | PostgreSQL | Group results are expanded back to individual people and saved with one SQL statement | One database call |

**The LLM never sees a person** — only a group's value range (e.g. "income ₹40k–60k"). No personal data reaches it.

**How we know it's correct:** a test runs this exact chain on 10,000 users and compares it with the slow, obvious "check every user against every loan" method. The results must be identical. Random tests (25 catalogues of up to 70 products) and common-sense tests ("earning more never removes an offer") back it up.

### 6.4 Stage 5 — ask, don't guess

After matching the 10,000 sample users, **56,963** matches were still "to confirm", because the lender needs something the CSV doesn't have. But they all depend on only about **5 missing facts**: work experience, bank relationship, employer type, city and business age.

So:
- **Questions are per fact, not per lender.** One question — "How long have you been working?" — answers HDFC, ICICI and Kotak at once.
- **Only ask what matters.** A question is only asked if it could unlock one of the person's top 5 offers. Maximum 3 questions.
- **Never ask twice.** Answers are saved and reused automatically, including for lenders added later.
- **Honest labels.** Unlocked loans are marked *pre-qualified (self-declared)*, never "approved". The lender still checks documents.

**Result:** asking at most 3 questions each could confirm up to **28,381 of the 56,963** "to confirm" offers. Work experience alone covers 18,681.

### 6.5 Other choices, and what we didn't do

| We chose | Instead of | Why |
|---|---|---|
| Browser uploads straight to S3 in parts | Uploading through API Gateway | API Gateway caps at 10 MB / 29 s. Parts can resume and are checksum-checked by S3 |
| S3 → SQS → Lambda | S3 → Lambda directly | Retries you can see, a failed-queue with alarm, and a cap of 5 parallel Lambdas to protect the database |
| Postgres `COPY` + one transaction | Inserting row by row | 10–50× faster (1M rows ≈ 6 s). All or nothing |
| Go for the backend | Python (our first version) | On 1M rows: Python 15 s, Go ~6.5 s. Faster cold starts, one small binary |
| LLM reads lender pages once a day | LLM per user | Cost stays flat as users grow; no personal data to the LLM |
| API Gateway REST with API key | HTTP API | REST supports per-client limits and quotas |
| Public RDS with TLS + strong password (demo only) | Private RDS + NAT (~$32/month) | Cost. Production would use private subnets + RDS Proxy |

Full reasoning: [docs/DESIGN.md](docs/DESIGN.md) · scaling notes: [docs/SCALE.md](docs/SCALE.md) · optimisation deep dive: [docs/OPTIMIZATION.md](docs/OPTIMIZATION.md).

---

## 7. Proof it works

**Emails arriving in the test inbox** after a full run (each alias is a different user from the CSV):

![Test inbox with three personalised emails](docs/images/email-inbox.png)

**A personalised email**, with the "answer 3 quick questions" box from Stage 5:

![Email to Fatima listing 11 loans and a link to answer 3 questions](docs/images/email-with-questions.png)

**Each offer explains why** the person may qualify:

![Email to Kavya with IDFC FIRST and ICICI offers and reasons](docs/images/email-offers.png)

The full live run — CSV upload → database → crawl → match → email — is in the [demo video](https://drive.google.com/drive/folders/1KtFQy6kbc3yavtGPWl6req-0r7M3-Tgo).

---

## 8. Code layout and tests

```text
apps/       api/            Lambda: HTTP endpoints (uploads, progress, unsubscribe)
            ingest_worker/  Lambda: reads CSV from S3, saves users
            web/            Next.js console
            workflows/      n8n: code, SQL, build script, dist/*.json
packages/   database · batches · uploads · ingestion · orchestration · notifications · reporting
tests/      architecture rules · end-to-end · correctness oracle · fixtures (saved bank pages, LLM replies)
```

**Tests:** 40 Go tests (real Postgres, fresh database per test) · 29 Python harness tests (runs n8n's SQL + JS against the real backend) · 60 workflow JavaScript tests · 18 console tests.

```bash
docker compose up -d postgres
go test ./...
.venv/bin/pytest
node --test apps/workflows/tests/*.test.js
cd apps/web && npm test && npm run typecheck && npm run build
```

GitHub Actions runs all of these on every push, plus a secret scan, formatting checks, the Lambda build, and a check that `dist/*.json` matches its sources.

More: [repo architecture](docs/REPO-ARCHITECTURE.md) · [brief → build map](docs/REQUIREMENTS.md) · [problems we hit and how we fixed them](docs/ISSUES.md).

---

## 9. Known limits

Left out on purpose, given the time box:

- No `List-Unsubscribe` email header (the n8n SES node can't set custom headers). Every email has a signed unsubscribe link instead.
- Bounce and complaint notifications from SES aren't wired up.
- One upload is matched per 2-minute check.
- Answers to the 3 questions are self-declared. We sanity-check them but can't verify them. In production we'd use consented data (Account Aggregator, credit bureau soft pull, EPFO).
- Ideas for protecting borrowers further — ranking by true cost instead of headline rate, explaining "almost qualified" — are written up in [docs/BORROWER-PROTECTION.md](docs/BORROWER-PROTECTION.md).
