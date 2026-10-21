# Loan Eligibility Engine

Upload a CSV of users → the system discovers personal-loan products on lender websites daily → matches every user to the loans they may qualify for → emails each user a personalised list.
**Go Lambdas + API Gateway + S3/SQS + RDS PostgreSQL + SES, orchestrated by self-hosted n8n.**

| | |
|---|---|
| Tests | 39 Go tests (`go test ./...`, real Postgres, one fresh DB per test) · 33 Python harness tests (n8n SQL + JS against the Go binaries) · 17 workflow JS · 15 console TS |
| Design docs | [Go guide (read first)](docs/GO-GUIDE.md) · [n8n guide](docs/N8N-GUIDE.md) · [DESIGN](docs/DESIGN.md) · [plain-English guide](docs/EXPLAINED.md) · [optimisation](docs/OPTIMIZATION.md) · [scale](docs/SCALE.md) · [brief → build map](docs/REQUIREMENTS.md) · [repo architecture](docs/REPO-ARCHITECTURE.md) |

---

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    UI[Next.js console<br/>CloudFront + S3]
  end
  subgraph AWS["AWS · ap-south-1"]
    APIGW[API Gateway REST<br/>API key + throttling]
    LUP[λ uploads / batches<br/>reporting / unsubscribe]
    S3[(S3 uploads/<br/>multipart, SHA-256 per part)]
    SQS[[SQS ingest queue]]
    DLQ[[DLQ + alarm]]
    LIN[λ ingest<br/>stream → validate → COPY → merge]
    RDS[(RDS PostgreSQL)]
    SES[SES]
  end
  subgraph Docker["Docker (local)"]
    N8N{{n8n}}
    A[WF-A crawler<br/>daily]
    B[WF-B matcher]
    C[WF-C notifier]
  end
  LLM[(Any OpenAI-compatible LLM)]
  Banks[(HDFC · ICICI · Kotak pages)]
  Inbox[(Gmail +aliases)]

  UI -- JSON --> APIGW --> LUP --> RDS
  UI -- file parts, presigned PUT --> S3
  S3 -- ObjectCreated --> SQS --> LIN --> RDS
  SQS -. 3 failures .-> DLQ
  LIN -- signed doorbell via tunnel --> B
  B -- sweeper every 2 min --> RDS
  A --> Banks
  A --> LLM
  B --> LLM
  A & B & C --> RDS
  B -- Execute Workflow --> C --> SES --> Inbox
  N8N --- A & B & C
```

**The request path, hop by hop**
1. **Upload (no file bytes through our API).** The page asks `POST /v1/uploads` for a session, then PUTs the file **directly to S3** in 8 MB parts. Up to 4 parts go in parallel, each signed with its SHA-256, and an interrupted upload resumes from the parts S3 already has. This avoids API Gateway's 10 MB / 29 s limits entirely.
2. **Event-driven ingest.** S3 emits *ObjectCreated* → SQS → the ingest Lambda. The Lambda streams the file (constant memory), fixes real-spreadsheet problems (BOM, UTF-16, `₹1,20,000`, `1.2L`, `NA` credit score = new-to-credit), and validates every row. It streams rows through binary `COPY` into a temp table and merges into `users` in **one transaction** (1M rows ≈ 6 s, measured). If more than 20% of rows are invalid, nothing is saved. Failures retry 3× and then land in a DLQ with an alarm.
3. **Trigger matching.** In the same transaction the batch becomes `LOADED`. The Lambda then rings n8n's webhook with an HMAC-signed, timestamped request. If that call is lost, n8n's 2-minute sweeper finds the batch anyway.
4. **Match (Workflow B).** It claims the batch (compare-and-set + lease), then runs the multi-stage Treasure Hunt below and writes `matches`.
5. **Notify (Workflow C).** It queues one notification per user with *new* matches and renders a personalised email. It sends through the **n8n AWS SES node** at 1 msg/s and records SENT/FAILED, so a duplicate send can't happen.
6. **Discover (Workflow A).** Runs daily: conditional GET → keyword-windowed text → hash. The LLM is called only when a lender's eligibility text actually changed. Every extracted number must be backed by a verbatim quote from the page.

**The console** (`apps/web`, Next.js static export on S3 + CloudFront):
- **Overview:** what the engine does, how it works, live numbers.
- **Upload:** a guided flow. 1 choose the file → 2 the browser checks your columns using the server's own alias table, and shows the first rows as they'll be read → 3 resumable upload.
- **Upload details:** a pipeline tracker, validation numbers with the first errors and a full report download, the matching funnel, matches per lender product, and email results. Polled live.
- **Uploads:** history of all uploads.
- **Loan catalogue:** every product the crawler found, with the verbatim quotes it was read from.

---

## The Optimisation Treasure Hunt (Workflow B)

Evaluating every user × product pair with an LLM is slow and expensive. Instead, each stage removes work before the next, more expensive one:

| Stage | Where | What it does | Cost |
|---|---|---|---|
| **1. SQL classes** | Postgres | Every product threshold becomes a cut point. `width_bucket()` puts each user's income, credit score and age into an interval, and `GROUP BY` collapses users that no product can tell apart. **10,000 sample users → 229 classes** | One indexed scan |
| **2. Bitset rules** | n8n Code node | Per class: `income[b] & credit[b] & age[b] & employment[e]`, one precomputed **bitmask** per attribute (BigInt, so no 64-product limit) | classes × 4 ANDs |
| **3. Selective LLM** | n8n → LLM | Only soft rules about data we **have**, never judged before. The cache key is *(product, criteria version, rule, the class features that rule depends on)*, so its size is bounded by feature combinations, not users. Rules about data we **don't** have (work experience, employer, salary account) are never sent to an LLM. The match becomes **LIKELY** and the email lists them under "still to confirm" | Usually 0 calls |
| **4. Set-based write** | Postgres | n8n sends one row per *(class, product)*; one SQL statement expands them back to users, upserts `matches`, drops stale ones, and records the funnel | One round trip |

- **Correctness is proven, not assumed.** A test runs this exact SQL + JS chain on the 10,000-row sample and asserts the result equals a brute-force O(users × products) oracle. Randomised differential tests (25 catalogues of up to 70 products) and metamorphic tests ("more income never removes an offer") back it up.
- **Trade-offs.**
  - Classes are approximations only for the LLM. The LLM sees a value *range*, never a person, so it answers UNKNOWN when the range straddles a rule, and the match stays LIKELY.
  - LLM verdicts are cached forever per criteria version. A product change creates a new `criteria_hash` and so fresh questions.

---

## Repository layout

```text
apps/      api/ (λ HTTP handlers) · ingest_worker/ (λ SQS) · web/ (Next.js console) · workflows/ (n8n)
packages/  database · batches · uploads · ingestion · orchestration · notifications · reporting   ← capability packages
tests/     architecture (import-boundary rules) · e2e (SQL + JS chains) · oracle · fixtures (bank pages, LLM replies)
```

- Each Go package exposes a small public API; vendor code (the AWS SDK) sits in its `internal/` folder, which **the Go compiler** forbids anyone else to import. `internal/archtest` enforces the rest (dependency table, driver never in apps, env reads only in `keys.go`).
- n8n Code-node logic lives in `apps/workflows/src/code/*.js` and every query in `src/sql/*.sql`, both tested.
- `python apps/workflows/build.py` assembles them into `apps/workflows/dist/*.json`. Don't edit `dist/` by hand.
- Details: [REPO-ARCHITECTURE](docs/REPO-ARCHITECTURE.md).

---

## Setup

### 0. Prerequisites
Docker, **Go 1.25+**, Node 22+, Python 3.12 (test/eval harness only), and for AWS: AWS CLI v2 with credentials, plus `npx` for the Serverless Framework v3.

```bash
cp .env.example .env               # fill it in as you go (each variable is documented there)
python3 -m venv .venv && .venv/bin/pip install "psycopg[binary]>=3.2,<3.3" pytest ruff   # harness only
```

### 1. Run n8n (and a local Postgres) with Docker
```bash
python apps/workflows/build.py     # regenerate workflow JSON from tested sources
docker compose up -d               # n8n → http://localhost:5678
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/loan_engine go run ./apps/migrate
```
On start, the n8n container ([`apps/workflows/docker/init.sh`](apps/workflows/docker/init.sh)) does three things:
1. **Creates the three credentials from `.env`.** No clicking through the UI. Secrets never go into workflow JSON.

   | n8n credential | Type | Filled from |
   |---|---|---|
   | **Loan DB** | Postgres | `APP_DATABASE_URL` (host, port, db, user, password; SSL "require" when `sslmode=require`) |
   | **AWS SES** | AWS | `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` (the send-only IAM user) |
   | **LLM API** | Header Auth | `Authorization: Bearer $LLM_API_KEY` |
2. **Imports workflows A, B, C and the error workflow.**
3. **Publishes them.**

To set credentials **manually** instead, open n8n → *Credentials* → edit **Loan DB / AWS SES / LLM API** with the values above. The workflows reference credentials by these names.

### 2a. Local mode (no AWS needed for ingestion)
```bash
.venv/bin/python scripts/make_demo_csv.py 200 > data/demo_users.csv
set -a; source .env; set +a
go run ./apps/ingest_local data/demo_users.csv   # the same Go ingestion pipeline; rings n8n's webhook
```
In n8n, run **A · Discover loan products → Run now** once first, so `loan_products` has data.

### 2b. Deploy to AWS (public, the brief's bonus)
```bash
aws ssm put-parameter --region ap-south-1 --name /loan-engine/db-password       --type SecureString --value "$(openssl rand -hex 24)"
aws ssm put-parameter --region ap-south-1 --name /loan-engine/webhook-secret    --type SecureString --value "<N8N_WEBHOOK_SECRET from .env>"
aws ssm put-parameter --region ap-south-1 --name /loan-engine/unsubscribe-secret --type SecureString --value "<UNSUBSCRIBE_SECRET from .env>"

docker compose --profile tunnel up -d          # public HTTPS URL for n8n, no inbound ports
docker compose logs cloudflared | grep trycloudflare.com
#   → put "<url>/webhook/batch-loaded" in .env as N8N_WEBHOOK_URL, and "<url>/" as N8N_PUBLIC_URL

bash scripts/build_lambdas.sh                  # static Go binaries for Lambda (linux/arm64, ~4 MB each)
npx serverless@3 deploy                        # API Gateway, Lambdas, S3, SQS+DLQ, RDS, CloudFront, IAM (~10 min: RDS)
bash scripts/deploy_web.sh                     # builds the console against the API URL → S3 + CloudFront
npx serverless@3 info --verbose                # API URL, API key, DatabaseHost
DATABASE_URL="postgresql://loanadmin:<db-password>@<DatabaseHost>:5432/loan_engine?sslmode=require" go run ./apps/migrate
```
Then point n8n at RDS: in `.env`, set `APP_DATABASE_URL` to the same RDS URL and `UNSUBSCRIBE_BASE_URL=<API URL>/v1/unsubscribe`, then run `docker compose up -d` (the credentials are re-created).

Open the `WebUrl` output (CloudFront) and paste the API key once (**Connect**).

Console development: `cd apps/web && cp .env.example .env.local && npm install && npm run dev` (it points at the deployed API).

Post-deploy check (it includes S3 rejecting a tampered part, which local fakes can't verify):
```bash
API_URL=<API URL> API_KEY=<key> .venv/bin/python scripts/smoke_aws.py data/demo_users.csv
```
Tear down: `npx serverless@3 remove` (the RDS instance has `DeletionPolicy: Delete`, so nothing keeps billing).

### 3. Email (SES) without a domain, as the brief allows
1. **SES → Identities:** verify your Gmail address (`SES_FROM_EMAIL`).
2. **Verify each test alias** (`you+one@gmail.com`, …). They all land in the same inbox. In the SES sandbox only verified recipients can receive.
3. **IAM:** create an access key for the stack's `SesSenderUser`. It can only `ses:SendEmail` from your address. Put the key in `.env`.
4. `TEST_MODE=true`: every recipient is rewritten to your `TEST_RECIPIENTS`, one alias per user, capped at `MAX_EMAILS_PER_RUN`. **Sample-CSV addresses are never emailed.** They're all `@example.com` and flagged undeliverable at ingest anyway.
5. Gmail may file mail "from gmail.com sent via Amazon" as spam because DMARC alignment fails without a domain. Add a Gmail filter `from:<you>@gmail.com → Never send it to Spam`. With a real domain we'd use DKIM, SPF and DMARC instead ([DESIGN §9.8](docs/DESIGN.md)).

### 4. LLM (any provider)
Set `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY` (examples for OpenAI, Gemini, Anthropic and Groq are in `.env.example`). Measure extraction quality on the saved bank pages:
```bash
set -a; source .env; set +a; .venv/bin/python scripts/eval_extraction.py   # target ≥ 95% numeric exact match
```

### 5. Tests
```bash
docker compose up -d postgres
go test ./...                # Go backend: each test gets its own fresh database (TEST_DATABASE_URL, must be *_test)
.venv/bin/pytest             # harness: builds the Go binaries, then runs n8n's SQL + JS against them
node --test apps/workflows/tests/*.test.js
cd apps/web && npm test && npm run typecheck && npm run build
```
CI (`.github/workflows/ci.yml`) runs all of the above on every push and PR against a real Postgres service, plus a gitleaks secret scan, `gofmt`/`go vet`, the arm64 Lambda build, a check that `apps/workflows/dist/` matches its sources, and shellcheck on the deploy scripts. The **Deploy ready** job turns green only when every check passes.

---

## Design decisions (and what we rejected)

| Decision | Instead of | Why |
|---|---|---|
| **S3 multipart + presigned part URLs** for every file size | Upload through API Gateway; single presigned PUT | No 10 MB/29 s limit. Resumable per part. Per-part SHA-256 enforced by S3. The server verifies the total size at completion. One code path for every file size |
| **S3 → SQS → Lambda** | S3 → Lambda directly | Buffering, visible retries, a DLQ and replay. `maximumConcurrency: 5` protects the database |
| **Postgres `COPY` + one merge transaction** | Row-by-row INSERTs | ~10–50× faster. All-or-nothing. Unchanged rows aren't rewritten, so "newly added users" = only real inserts and changes |
| **Signed webhook + 2-minute sweeper + lease** | Plain webhook | A lost webhook only delays matching; a crashed matcher's lease expires and the batch is reclaimed. At-least-once delivery × idempotent steps = effectively once |
| **Classes + bitsets + selective LLM** | LLM or loops per user × product | See the Treasure Hunt. Proven equal to brute force by tests |
| **LLM compiles page text into rules once a day; never judges a person** | LLM per user | Cost stays flat as users grow. No PII ever reaches the LLM |
| **Text windowing + verbatim-evidence validation** in the crawler | CSS selectors | A redesign doesn't break extraction (layout-change handling, a brief bonus). Hallucinated or injected numbers are dropped. An empty extraction keeps yesterday's data |
| **`UNIQUE(user_id, digest_key)` + `notified_at`** | "Remember not to resend" | Duplicate emails are impossible at the database level. A failed send retries up to 3×, then it's marked FAILED |
| **API Gateway REST (API key, usage plan)** | HTTP API | Quotas and throttling per client; HTTP APIs have no usage plans |
| **Next.js static export on S3 + CloudFront** | Next.js server (SSR) on Lambda; Vercel | The console only calls our API from the browser, so a server would add cost and patching for nothing. CloudFront serves from Indian edge locations |
| **Public RDS, TLS-only, strong password** (demo) | Private RDS + NAT (~$32/mo) | Lambdas outside a VPC have changing IPs, so allowlisting isn't possible. Production: private subnets + RDS Proxy |
| **Capability packages with enforced boundaries** | One flat package | Vendor isolation (AWS SDK only in `internal/`, compiler-enforced). A test fails the build on any other boundary violation |
| **Go for the backend** | Python (our first implementation) | Measured on 1M rows: Python (tuned) 15.0 s, Go 6.0–6.8 s (2.2–2.5× faster), with faster cold starts and a single static binary. Full analysis: [DESIGN §9.15](docs/DESIGN.md) |

Known limitations (intentionally out of scope):
- The SES node sends HTML only. There's no `List-Unsubscribe` header, because the n8n SES node can't set custom headers. The email body has a signed unsubscribe link instead.
- Bounce/complaint webhooks aren't wired.
- One batch is matched per sweeper tick.

Full analysis: [DESIGN §13–14](docs/DESIGN.md).
