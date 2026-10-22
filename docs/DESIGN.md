# Loan Eligibility Engine — System Design

> Derived from first principles: **requirements → numbers → interfaces → architecture → deep dives → failure analysis.**
> Companion docs: [`SCALE.md`](./SCALE.md) (ClickPe context and capacity tiers), [`OPTIMIZATION.md`](./OPTIMIZATION.md) (per-component optimization), [`REQUIREMENTS.md`](./REQUIREMENTS.md) (brief → build mapping), [`REPO-ARCHITECTURE.md`](./REPO-ARCHITECTURE.md) (code layout and boundaries).
> Every decision lists the alternative we rejected and why, so it can be defended at a whiteboard.

---

## 1. Problem statement

ClickPe receives lists of potential borrowers (from partners, campaigns, its own app). Lenders publish loan products with eligibility rules on their websites.
Build an **embedded engine** that ingests borrower data at any size, keeps a live catalogue of loan products, decides who is eligible for what (cheaply and explainably), and notifies borrowers reliably, safely and compliantly.

---

## 2. Functional requirements (FR)

| ID | Requirement | Actor |
|---|---|---|
| FR1 | Upload a user file (CSV; XLSX as a stretch) of **any size up to 1 GB**, with progress and **resume after a network drop** | Ops user / partner |
| FR2 | Preview and validate the file **before** upload (header check, first rows), and map unfamiliar column names | Ops user |
| FR3 | Parse, normalize and validate every row. Store valid rows; produce a **downloadable error report** with line numbers and reasons | System |
| FR4 | Track and display batch status end to end (uploaded → validated → matched → awaiting approval → notified) | Ops user |
| FR5 | Daily crawl of 2–3 lender websites; extract and normalize product name, interest rate, income / credit / age / employment rules; keep history | System (n8n WF-A) |
| FR6 | Match each newly ingested user to eligible products, store matches, rank top offers | System (n8n WF-B) |
| FR7 | Multi-stage filtering that minimizes LLM usage | System |
| FR8 *(optional)* | Human approval before outbound messages. **Off by default:** the brief says WF-C runs after WF-B completes, so the default chain is automatic | Ops user |
| FR9 | Send one personalized email per user with new matches via SES; never to sample addresses; no unintended duplicates | System (n8n WF-C) |
| FR10 | Process bounces, complaints and unsubscribes; never email a suppressed address again | System |
| FR11 | Re-match when the product catalogue changes; notify only on *new* offers | System |
| FR12 *(embed)* | Online eligibility lookup for a single user (ClickPe app) | ClickPe services |
| FR13 *(beyond the brief)* | Ask a user the few facts that would turn their "to confirm" offers into pre-qualified ones, and re-check only their matches | User (n8n WF-D) |

**Out of scope:** loan application, KYC, credit bureau pulls, disbursal.

---

## 3. Non-functional requirements (NFR) — with numbers

| Quality | Target | How we meet it |
|---|---|---|
| **Availability** (sync APIs: upload init, status, offers) | 99.9% monthly | Managed, multi-AZ services (API Gateway, Lambda, S3); stateless handlers |
| **Pipeline freshness** (async) | 95% of ≤100k-row batches matched **≤ 5 min** after upload completes; 1M rows **≤ 15 min** | Streaming ingest + COPY, set-based matching |
| **Upload resilience** | A 1 GB upload on a flaky 4G link survives disconnects and resumes without re-sending finished parts | S3 multipart, per-part retry, resume via ListParts (§9.1) |
| **Durability** | No accepted row or file lost. Uploaded file: S3 (11 nines). DB: point-in-time recovery, RPO ≤ 5 min | S3; RDS automated backups (Multi-AZ in production) |
| **Correctness** | Zero false-eligible on hard rules (deterministic). Every LLM-derived field has verbatim evidence | Rules engine + evidence check + eval suite (§12) |
| **Delivery semantics** | Every batch processed effectively once. Emails at-least-once, with dedup leaving only a crash-window duplicate | Outbox + lease + idempotent writes (§9.4, §9.9) |
| **Deliverability** | Bounce < 2%, complaint < 0.1%, inbox (not spam) placement for test sends | SPF/DKIM/DMARC, suppression, consent, one-click unsubscribe (§9.8) |
| **Latency** (online offers) | p99 < 100 ms | Class lookup: 2 indexed reads (§9.5) |
| **Scalability** | Tier 2 (10M users, 1M-row uploads, 500 products) without redesign | Class-based storage, paged n8n work, SQS buffering |
| **Cost** | Tier 1 ≈ free tier. **LLM spend independent of user count** | Compile-once + projected cache |
| **Security & privacy** | Encryption in transit and at rest; least privilege; LLM never sees PII; data stays in India region | §9.12 |
| **Compliance** | DPDP Act consent and erasure; lender named in every offer (RBI digital lending) | consent filter, templates |
| **Operability** | One-command local stack; IaC; alarms; runbook per failure mode | §10, §11 |

---

## 4. Capacity estimation (Tier 2 design point; details in SCALE.md)

| Quantity | Estimate |
|---|---|
| Users | 10M × ~600 B (row + indexes) ≈ **6 GB** |
| Uploads | 50/day × up to 100 MB ≈ **5 GB/day ingress**; S3 with 7-day lifecycle ≈ 35 GB |
| Ingest throughput | 1M rows ÷ ~50–100k rows/s (COPY) ≈ **10–20 s** of DB time |
| Naive matches | 10M × 150 ≈ 1.5B rows ❌ → class storage: 10M `user_class` + ~10³–10⁴ `class_matches` + 100M top-K `matches` (partitioned) |
| Emails | ~500k/day ≈ **6/s average**, peaks capped by the SES send rate |
| LLM | ~10–50 compile calls/day (on change) + ≤ a few hundred cached judgments **total**, not per batch |
| Online lookups | ~100 req/s peak → Lambda + 2 indexed reads; fits comfortably on one DB instance |

---

## 5. API design (REST, versioned, JSON)

All mutating endpoints accept an **`Idempotency-Key`** header (the client retries safely). Auth: Cognito JWT for ops users (with a `tenant_id` claim); API key + usage plan for partners. Demo: a single API key.

| Method & path | Purpose | Notes |
|---|---|---|
| `POST /v1/uploads` | Start an upload | Body `{filename, size_bytes, content_type, sha256?}` → `{batch_id, upload_id, part_size, part_count, expires_at}`. Rejects if `size_bytes` > limit or tenant quota exceeded |
| `POST /v1/uploads/{batch_id}/part-urls` | Get presigned URLs for parts | Body `{part_numbers:[…]}` → URLs valid 1 h, each **signed with the part's SHA-256 checksum**. Lazily requested, so URLs never go stale on big files |
| `GET /v1/uploads/{batch_id}/parts` | Resume: which parts S3 already has | Wraps `ListParts` |
| `POST /v1/uploads/{batch_id}/complete` | Finish | Body `{parts:[{n, etag}]}` → server calls `CompleteMultipartUpload`, re-checks total size, status `UPLOADED` |
| `DELETE /v1/uploads/{batch_id}` | Abort | `AbortMultipartUpload` |
| `GET /v1/batches/{batch_id}` | Status + timeline + funnel | Polled by the UI with backoff. Includes `confirmations: {asked, answered, flagged, unlocked}` (§9.16) |
| `GET /v1/batches/{batch_id}/errors.csv` | Error report | 302 redirect to a short-lived presigned GET |
| `POST /v1/batches/{batch_id}/approve` | Release notifications | Resumes the n8n Wait node via its resume URL (server-side; the UI never sees it) |
| `GET /v1/users/{user_id}/offers` | Online eligibility (FR12) | Stretch |
| `GET /v1/unsubscribe?t=<signed token>` + `POST` (RFC 8058 one-click) | Unsubscribe | Token = HMAC(user_id, tenant, expiry); no PII in the URL |
| `GET webhook/confirm?t=<signed token>` · `POST webhook/confirm-submit` (n8n, not API Gateway) | Confirmation form and its submit (FR13) | HTML in, HTML out. Token domain-separated from the unsubscribe token (§9.16) |

**Error model:** `{error:{code, message, details}}` with stable codes (`FILE_TOO_LARGE`, `QUOTA_EXCEEDED`, `BATCH_NOT_FOUND`, `INVALID_STATE`).

---

## 6. High-level architecture and the request path

```
                         ┌───────────────────────── AWS ap-south-1 (Mumbai) ─────────────────────────┐
 Browser ──HTTPS──► CloudFront ──► S3 (static UI)                                                      │
    │                                                                                                  │
    │ JSON (metadata only)                                                                             │
    └──► API Gateway (REST) ─ authorizer (JWT / API key) ─ throttling ─ request validation             │
             │                                                                                         │
             ├─► λ uploads   (create/complete multipart, presign parts)   ──► RDS: ingest_batches       │
             ├─► λ status    (batch timeline, error report URL)           ──► RDS                       │
             ├─► λ approve   (calls n8n resume URL, HMAC)                                               │
             └─► λ offers    (online eligibility)                          ──► RDS                       │
    │                                                                                                  │
    │ file bytes: PUT each part directly (presigned, checksummed)                                      │
    └──► S3 uploads/ ──ObjectCreated(CompleteMultipartUpload)──► SQS ingest-q ──► λ ingest ──► RDS     │
                                                              └─(3 fails)─► SQS DLQ ─► alarm           │
                                                         λ ingest ── doorbell (HMAC) ──┐               │
 SES ◄── n8n SES node                                                                  │               │
  └─ config set events (bounce/complaint/delivery) ─► SNS ─► SQS events-q ─► λ events ─► RDS suppression│
                         └──────────────────────────────────────────────────────────────┼──────────────┘
                                                                                        ▼
                          Cloudflare Tunnel (no open ports) ──► n8n (Docker) + its own Postgres
                              WF-A crawl (cron) · WF-B match · WF-C notify · WF-D confirm · WF-S sweeper · WF-E errors
```

### Hop by hop, and why each hop exists
1. **CloudFront + S3 (UI):** static files, global caching, HTTPS. *Rejected:* a server-rendered app (a server to run for a single page).
2. **API Gateway REST API:**
   - It provides auth (JWT or API key), **per-tenant usage plans and quotas**, request schema validation, throttling, and WAF support.
   - *Rejected:* **HTTP API.** It's cheaper and simpler, but has **no usage plans and no direct WAF support**, and partner quotas are a requirement. *Also rejected:* Lambda function URLs (no auth, quotas or routing).
   - Only **metadata** passes through it. File bytes never do (payload and timeout limits).
3. **Lambdas, one per concern:** small blast radius, independent scaling and permissions.
4. **S3 multipart:** the bytes path (§9.1).
5. **SQS between S3 and ingest:**
   - It gives buffering, retries with a visibility timeout, a DLQ and replay.
   - *Rejected:* S3 → Lambda direct (opaque retries, no replay, no buffering); EventBridge (routing we don't need).
6. **RDS PostgreSQL:** the source of truth and the set-based compute engine.
7. **Cloudflare Tunnel → n8n:**
   - The self-hosted n8n gets an HTTPS endpoint without opening inbound ports.
   - *Rejected:* exposing a port (attack surface); ngrok's free static domain is an acceptable fallback.
8. **SES + configuration set → SNS → SQS → λ events:** the deliverability feedback loop. It's at-least-once and buffered, so a burst of bounces can't overload us.

**Region: ap-south-1 (Mumbai).** Lowest latency for Indian users. Keeps borrower data in India, in line with RBI's data-localization direction. SES is available there.

---

## 7. Detailed flows

### 7.1 Upload (FR1, FR2)
```
UI: user drops file
 ├─ (client) sniff encoding + delimiter, parse header + first 50 rows (Papa Parse)
 │    → header mapping screen if columns don't match aliases → preview table with row issues highlighted
 ├─ (client, optional) gzip via CompressionStream (CSV compresses ~5–10×)
 ├─ POST /v1/uploads {size, sha256}            → batch_id, upload_id, part_size=8 MB, part_count
 ├─ for parts (4 in parallel): compute SHA-256 (WebCrypto) → POST part-urls → PUT part (retry w/ jittered backoff)
 │    progress saved to localStorage keyed by file fingerprint (name+size+lastModified+sha256)
 ├─ on refresh/disconnect: GET parts → skip finished parts → continue
 └─ POST complete → S3 assembles object → ObjectCreated → SQS
```

### 7.2 Ingest (FR3, FR4)
```
λ ingest (SQS batch size 1, max concurrency 5)
 ├─ CAS batch UPLOADED→PARSING (else exit: duplicate event)
 ├─ stream S3 object (gunzip if magic bytes 1f 8b; XLSX → read-only row iterator)
 ├─ per row: normalize → validate → good rows buffered → COPY into staging (per batch, every 10k rows)
 │           bad rows → ingest_errors
 ├─ circuit breaker: >20% bad → FAILED (nothing merged)
 ├─ ONE TRANSACTION: MERGE staging→users (only changed rows; stamp last_batch_id)
 │                   recompute user_class for touched users
 │                   batch→LOADED, outbox('batch_loaded'), pipeline_event
 └─ doorbell POST to n8n (HMAC, 3 s timeout, failure ignored; the sweeper is the safety net)
```

### 7.3 Match (FR6, FR7) — n8n WF-B
```
Webhook (verify HMAC) | Sweeper (every 2 min)
 ├─ claim: UPDATE … SET status='MATCHING', lease_until=now()+15m WHERE id=$1 AND (status='LOADED' OR lease expired) RETURNING
 ├─ load catalogue snapshot (active products, criteria_hash) → build cut points
 ├─ SQL: distinct classes touched by this batch (one item with arrays)
 ├─ Code node: bitset matching per class (+ soft-rule detection)
 ├─ LLM sub-step: only uncached projected keys, batched, breaker-protected
 ├─ SQL: upsert class_matches; compute top-K matches for batch users; diff vs previously offered → new_offers
 ├─ pipeline_event(funnel counts, tokens, ms); batch→AWAITING_APPROVAL
 └─ Wait node (resume on approval) → Execute WF-C
```

### 7.4 Notify (FR9, FR10) — n8n WF-C (dispatcher)
```
 ├─ INSERT notifications (PENDING) for users with new_offers
 │     filters: consent_marketing = true, not suppressed, not sent in last 7 days, (test mode → allowlisted alias)
 │     UNIQUE(user_id, digest_key) blocks duplicates
 ├─ loop: claim page of 500 PENDING (FOR UPDATE SKIP LOCKED) → sub-workflow:
 │     render HTML + text → token bucket (≤ SES rate) → SES send (configuration set, List-Unsubscribe headers)
 │     → SENT + message_id | retryable → backoff | permanent → FAILED
 └─ SES events → SNS → SQS → λ events: bounce(permanent)/complaint → suppression; delivery → delivered_at
```

### 7.5 Crawl (FR5, FR11) — n8n WF-A
```
Cron 02:00 IST → per site (isolated branch, continue-on-fail):
 conditional GET (ETag/Last-Modified) → 304 stop
 → extract product section → SHA-256 → unchanged stop
 → structured parse (selectors / JSON-LD) → LLM compile (only on change) → validate (schema, ranges, verbatim evidence)
 → upsert loan_products + loan_product_versions → crawl_runs
 → if criteria changed: recompute class_matches → diff → users who gained offers → notification queue (FR11)
 → drift alarm: product count drop > 50% or null-rate spike
```

### 7.6 Confirm (FR13) — n8n WF-D (beyond the brief)
```
WF-B: planForClasses (per class × class size) → question_plan in the funnel event (console)
WF-C: planQuestions for each user emailed → email gets a signed link (≤ 3 questions) → notifications.questions = ids asked
User clicks → GET webhook/confirm?t=… → verify token → HTML form with only that person's questions
User submits → POST webhook/confirm-submit
 ├─ verify token again; sanity checks on the answers
 ├─ contradictory → user_declarations.flagged = true + reasons → ops; answers NOT used
 ├─ upsert user_declarations (self-declared answers, batch_id)
 ├─ re-check only this user's LIKELY matches (same rule + LLM-judge path as WF-B)
 ├─ unlocked → matches: status ELIGIBLE, unverified [], decided_by DECLARED; user_declarations.unlocked = n
 └─ SES email "you now pre-qualify (self-declared)" to the address C last used → HTML result page
```

---

## 8. Data model (PostgreSQL)

```sql
tenants(id, name, plan_weight, daily_row_quota)
ingest_batches(id uuid PK, tenant_id, s3_key, upload_id, size_bytes, status, lease_until,
               rows_total, rows_valid, rows_rejected, created_at, updated_at)
ingest_errors(batch_id, line_no, column, code, message, raw_value)
users(user_id PK, tenant_id, name, email, email_domain_ok bool, monthly_income numeric(12,2),
      credit_score int NULL /* NULL = new-to-credit */, employment_status employment_t, age int,
      consent_marketing bool, last_batch_id, updated_at)
user_class(user_id PK, class_id, catalog_version)
loan_products(id PK, product_key UNIQUE, lender_name, lender_regulated_entity, product_name, source_url,
              rate_min, rate_max, min_income, min_credit NULL, accepts_ntc bool, age_min, age_max,
              employment employment_t[], repayment_frequency, max_amount, tenure_months_max,
              soft_rules jsonb, evidence jsonb, criteria_hash, prompt_version, is_active, last_seen_at)
loan_product_versions(product_id, criteria_hash, snapshot jsonb, valid_from)
class_matches(class_id PK, product_mask bit varying, catalog_version, computed_at)
matches(user_id, product_id, rank, score, status ELIGIBLE|LIKELY, reasons jsonb, unverified jsonb,
        batch_id, decided_by SQL|RULE|LLM|DECLARED, first_matched_at, notified_at,
        PRIMARY KEY(user_id, product_id))   -- name exactly as the brief says; Tier 1 stores every pair (~32k rows)
llm_judgments(cache_key PK, verdict, rationale, model, prompt_version, tokens_in, tokens_out, created_at)
notifications(id, user_id, tenant_id, channel, digest_key, recipient, status, ses_message_id,
              attempts, last_error, sent_at, delivered_at, questions jsonb NULL /* ids asked; NULL = no link */,
              UNIQUE(user_id, digest_key))
user_declarations(user_id PK, batch_id, answers jsonb, flagged bool, flag_reasons jsonb, unlocked int,
                  declared_at, updated_at)   -- WF-D, self-declared answers (migration 007)
suppression(email_hash PK, reason bounce|complaint|unsubscribe, created_at)
outbox(id, batch_id, event, created_at, processed_at) · pipeline_events(batch_id, stage, status, counts jsonb, ms, at)
crawl_runs(id, site, status, products_found, changed, error, at)
```
**Indexes:** `users(last_batch_id)`, `users(tenant_id)`, `notifications(user_id, sent_at)`, `ingest_batches(status, lease_until)`, `matches(user_id, rank)`.
**Why `email_hash` in the suppression table:** we can suppress an address without keeping it after the user is erased (DPDP).

---

## 9. Deep dives

### 9.1 Large-file upload: S3 multipart, resumable
**First principles:** the risks are (a) API size and time limits, (b) a dropped connection at 95% of a 1 GB file, (c) corrupted bytes, (d) abuse (huge files), (e) orphaned partial uploads costing money.

| Option | (a) limits | (b) resume | (c) integrity | (d) size cap | Verdict |
|---|---|---|---|---|---|
| Upload through API Gateway → Lambda | ❌ ~10 MB / ~30 s | ❌ | — | ✅ | Rejected |
| Single presigned PUT | ✅ (≤ 5 GB) | ❌ restart from 0 | ⚠️ | ❌ cannot cap size | Rejected |
| Single presigned POST | ✅ | ❌ restart from 0 | ⚠️ | ✅ `content-length-range` | Fine for small files only |
| tus protocol | ✅ | ✅ | ✅ | ✅ | Needs a stateful tus server; not serverless-friendly. Rejected |
| **S3 multipart + presigned part URLs** | ✅ | ✅ part-level | ✅ per-part SHA-256 | ✅ server controls part count and verifies at complete | **Chosen** |

**Design details:**
- **One code path for every size.** A 1 MB file is a 1-part multipart upload (the last part may be under the 5 MB minimum), so there are no dual-path bugs.
- **Part size 8 MB:**
  - 1 GB = 128 parts, well under S3's 10,000-part limit.
  - Small enough that a retry on 4G is cheap.
  - **4 parallel parts:** saturates a typical uplink without starving the browser.
- **Checksums:**
  - The client computes SHA-256 per part.
  - The presigned URL is signed **with `x-amz-checksum-sha256`**, so S3 rejects any part whose bytes don't match.
  - The whole-file hash is kept for duplicate-upload detection.
- **Size enforcement:**
  - The server issues URLs only for `ceil(size/part_size)` parts.
  - On complete, it sums the sizes from `ListParts` and aborts if the total exceeds the declared size or the cap.
- **Resume:**
  - Progress is stored client-side (localStorage) and is authoritative server-side (`ListParts`).
  - Refreshing the page or switching networks continues from the last finished part.
- **Orphans:** an S3 lifecycle rule `AbortIncompleteMultipartUpload` after 1 day. Without it, abandoned parts are stored and billed forever.
- **Compression:** an optional browser gzip (`CompressionStream`). CSV shrinks about 5–10×, so a 100 MB file is about 15 MB on the wire. The ingest Lambda detects gzip by its magic bytes.
- **Duplicate file:** the same whole-file SHA-256 from the same tenant within 24 h → the UI warns "this exact file was uploaded at 10:42 — upload again?"
- **Transfer Acceleration:** rejected for now. Mumbai is already close to the users, and it costs extra. It's a toggle for distant partners.

### 9.2 Spreadsheet reality: what ops users actually upload
The sample CSV is perfectly clean. Real files exported from Excel or Google Sheets are not. Validation is split:
- **Client side, shift-left:** instant feedback before any upload.
- **Server side:** the authority, because the client can be bypassed.

**Encoding and format problems:**
| Problem | Handling |
|---|---|
| UTF-8 with BOM (Excel "CSV UTF-8") | Strip the BOM |
| Windows-1252 (Excel's plain "CSV"), UTF-16 ("Unicode text") | Detect from BOM / byte heuristics, decode, or reject with a clear message |
| `;` or tab delimiters (European locale, TSV) | Delimiter sniffing on the first 64 KB |
| XLSX instead of CSV | Stretch: stream rows with openpyxl read-only mode; first sheet only, with the sheet name shown in the preview |
| Trailing empty rows/columns, a title row above the header | Skip blank rows; detect the header row by alias match |
| Embedded newlines/quotes in names | RFC 4180 quoting via the csv module |

**Header problems:** headers are normalized (lowercase, trim, strip `(₹)`, spaces → `_`) and matched against an **alias map** (`income`, `monthly salary`, `net_monthly_income` → `monthly_income`).
Unknown headers → a **column-mapping screen** in the UI. The mapping is saved per tenant, so a partner maps once.

**Value problems (Indian-specific included):**
| Raw | Normalized | Rule |
|---|---|---|
| `₹1,20,000` / `1,20,000.00` (Indian digit grouping) | 120000 | Strip currency and separators |
| `1.2L`, `1.2 lakh`, `50k` | 120000, 50000 | Unit suffixes |
| `1.2E+05` (Excel scientific notation) | 120000 | Parse as float; flag if it was the `user_id` column (ID corrupted by Excel) |
| `self employed`, `SELF-EMPLOYED`, `Business Owner` | `Self-Employed` / `Business` | Enum alias table |
| `35 yrs` | 35 | Extract the integer; range check |
| Credit score `NA`, `-1`, `0`, blank | `NULL` = **new-to-credit (NTC)** | Common in India. NTC users only match products with `accepts_ntc` |
| Email with spaces/uppercase | trimmed, lowercased | Syntax check + **MX lookup per distinct domain** (cached); reserved domains (`example.com`, per RFC 2606) flagged undeliverable |
| Duplicate `user_id` within the file | Last row wins, reported | — |

**What we give back (the error report):**
- UTF-8 **with BOM**, so Excel shows `₹` and Hindi/Gujarati names correctly.
- Columns: `line_no` (matches what the user sees in their spreadsheet), `column`, `code`, human message, original value, suggested fix.
- **CSV formula-injection safe:** cells beginning with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'`.
- Delivered via a presigned GET with 15-minute expiry.
- **Fix-and-reupload loop:** the user fixes only the bad rows and uploads them. The upsert is idempotent, so this is safe.

### 9.3 Ingest pipeline
- Streaming iterator → bounded buffer (10k rows) → `COPY` into a per-batch staging table → one `MERGE` transaction.
- Constant memory. 1M rows in about 10–20 s of DB time.
- **Merge semantics:** insert new users; update existing ones only if a value changed (`IS DISTINCT FROM`); stamp `last_batch_id`. "New users of this batch" = `last_batch_id = :batch`.
- **Circuit breaker:** more than 20% invalid → FAILED, nothing merged.
- **Backpressure:** SQS maximum concurrency 5 caps DB connections.
- **Tier 3:** a splitter Lambda creates byte-range chunks aligned to newlines → SQS → N workers → a final merge (documented).

### 9.4 Reliable triggering of n8n
- **Outbox** (written in the same transaction as the data) + **doorbell** webhook (HMAC; best-effort) + **sweeper** (every 2 min) + **lease** (claim with an expiry).
- At-least-once delivery × idempotent consumer = **effectively-once processing**.
- *Rejected:*
  - plain webhook (lost if n8n is down)
  - synchronous wait (cascading timeouts)
  - SQS read by n8n (no native trigger, so we'd poll anyway)

### 9.5 Matching
- **Geometry:** a user is a point; a product's hard rules are an axis-aligned box. This is an orthogonal range query.
- **Algorithm:** **coordinate compression** (cut points from product thresholds; `width_bucket`) → **equivalence classes** → **bitset AND** per attribute.
  - Real CSV, 10 illustrative products: **10,000 users → 378 classes**.
  - Identical results to brute force (32,325 matches).
- **Storage:** `user_class` + `class_matches` + top-K `matches`. This avoids the 1.5B-row explosion at Tier 2, and **a product change touches only class rows**.
- **Arbitrary-width masks** for more than 64 products (`bit varying`, JS BigInt in the n8n matcher).
- **n8n receives classes as one item of arrays.** Per-item overhead is the n8n bottleneck.
- `NULL` criterion = "not stated" (passes). `NULL` credit = NTC (matches only NTC-accepting products).
- *Rejected:*
  - LLM per pair
  - per-pair loops in n8n
  - k-d / range trees (P is small)
  - embeddings (constraints are not similarity)
- **Plain SQL join kept as the test oracle.**

### 9.6 LLM usage
1. **Compile, don't judge:** at crawl time the LLM converts eligibility prose → typed rules + `soft_rules[{text, applies_to, depends_on}]` + evidence quotes. Cached by `criteria_hash`.
2. **Projected cache:** a soft-rule judgment is keyed by `(product, criteria_hash, values of depends_on features only)`. The number of keys is bounded by feature cardinality, not users. Simulation: 100,000 naive calls → 113.
3. **Never guess missing data:** a rule needing data we lack → status `LIKELY` + `unverified` list shown to the user.
4. **Model routing:** a cheap model for compilation (form-filling); a stronger model only if validation fails twice. Provider fallback on errors.
5. **Circuit breaker:** after N consecutive failures, skip the LLM. Matching completes with hard rules; affected offers are marked `LIKELY (pending review)`.
6. **Safety:**
   - temperature 0
   - strict JSON schema
   - no tools
   - output validated (plausible ranges + **evidence must appear verbatim in the page**)
   - **no PII in prompts**
7. **Cost math:** naive ≈ 100k calls × ~500 tokens ≈ 50M tokens (and days of free-tier rate limits) vs ≈ 50k tokens. About 1,000× less.

### 9.7 Crawler
- **Cheapest check first:**
  1. conditional GET (304)
  2. section hash
  3. structured parse
  4. LLM only on change
- Stable `product_key = hash(lender + normalized name)`; version history.
- Per-site isolation (continue-on-fail).
- **Politeness:** robots.txt, an honest User-Agent, one request at a time per host, backoff on 429/5xx.
- **Drift alarms** catch silent breakage.
- **Source priority:** lender partner feed > lender website > aggregator. Cross-source dedupe by trigram similarity (`pg_trgm`).
- Prompt injection from page text is neutralized by the safety rules in §9.6.

### 9.8 Email deliverability (getting into the inbox, not spam)
**First principles:** mailbox providers decide inbox vs spam from **authentication**, **sender reputation** (bounces, complaints, engagement), **list quality** and **content**.

**Authentication:**
| Control | What we do | Why |
|---|---|---|
| **Sender (demo, per the brief)** | **Our own Gmail, verified as an SES identity. Recipients are our `+alias` addresses.** No custom domain; the brief explicitly allows our own inbox | Mail "from gmail.com" sent via Amazon may fail DMARC alignment and land in Spam. **Zero-cost fix:** a Gmail filter "From: <our address> → Never send to Spam". The video shows the email in the inbox |
| **Sending domain (production only, documented)** | A domain we control with DKIM / SPF / DMARC as below | Needed at real volume; not needed for the brief |
| **DKIM** | SES Easy DKIM (2048-bit) | Proves the message wasn't altered and the domain authorized it |
| **SPF + custom MAIL FROM** | `bounce.offers.<domain>` with an SPF record including amazonses.com | SPF alignment with the From domain (needed for DMARC) |
| **DMARC** | Start with `p=none; rua=mailto:…` → move to `quarantine` once reports are clean | Required by Gmail/Yahoo for bulk senders (Feb 2024 rules); protects against spoofing of our domain |
| **TLS** | SES uses TLS by default; set the configuration set's TLS policy to Require | Provider expectations; privacy |

**Reputation and list quality:**
| Control | What we do |
|---|---|
| **Pre-send validation** | Syntax + MX per domain at ingest. Reserved/test domains (the sample uses `example.com`) are flagged and never sent to. Optional disposable-domain list |
| **Consent** | Send only where `consent_marketing = true` (DPDP; also cuts complaints) |
| **Suppression** | SES account-level suppression list **plus** our own `suppression` table (hard bounces, complaints, unsubscribes), checked before queueing |
| **Feedback loop** | Configuration set → SNS → SQS → λ events; hard bounce or complaint → suppress immediately |
| **Thresholds to watch** | SES puts accounts under review at roughly **5% bounce / 0.1% complaint** and may pause sending at higher levels; Gmail requires spam rate **< 0.3%**. Our alarms fire well below these: bounce > 2%, complaint > 0.05% → **auto-pause WF-C** (circuit breaker) |
| **Warm-up** | A new domain or IP starts small and ramps (roughly doubling daily). Stay on SES shared IPs until volume justifies a dedicated IP with managed warm-up |
| **Frequency cap** | At most 1 offer email per user per 7 days |
| **Send window** | 09:00–20:00 IST; spread over the window instead of a single burst |
| **Sandbox** | 200/day, 1/s; only verified recipients. The test-mode rewrite to `<you>+u<id>@gmail.com` + allowlist (each alias verified if SES requires it) |

**Content and headers:**
- `List-Unsubscribe: <https://…/unsubscribe?t=…>, <mailto:…>` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). This is **mandatory for bulk senders at Gmail/Yahoo** and gives a native "Unsubscribe" button.
- Multipart/alternative: **HTML + plain text**. Keep HTML **under ~100 KB**: Gmail clips messages around 102 KB, and clipping hides the unsubscribe footer.
- Consistent From name ("ClickPe Offers"), a monitored Reply-To, honest subject lines (no "Congratulations! Pre-approved!" — that's misleading and a spam signal).
- Links on our own domain (a custom click-tracking domain if tracking is enabled); no URL shorteners; no tracking pixels in the demo (Apple Mail Privacy Protection makes opens unreliable anyway).
- An inbox-placement test (seed addresses at Gmail/Outlook/Yahoo) before any real send.

### 9.9 What the recipient actually receives
```
From:    ClickPe Offers <offers@offers.<domain>>
Subject: Rahul, 3 business loans you may qualify for
Preheader: Based on your profile: rates from 13.5% p.a. — no impact on your credit score to view.

Hi Rahul,
Based on the details shared with us, you may be eligible for these loans:

┌ Daily Business Loan — <Lender NBFC Pvt Ltd (RBI-registered)>
│ Interest: 18–24% p.a. (as published on lender site, 19 Oct 2026)
│ Repayment: Daily · Up to ₹1,50,000 (estimated for your income)
│ ✓ Why you qualify: income ₹62,000/month ≥ ₹25,000 minimum · business owner accepted · age 34 within 21–60
│ ⚠ Still to confirm: 2 years of business continuity
│ [ Check this offer ]  ← link to ClickPe with a signed, PII-free token
└
(2 more cards…)

💡 If your credit score reaches 750, 2 more lenders become available.

These are indicative matches, not loan offers or approvals. Final eligibility, rates and amounts are decided by the lender.
Why am I getting this? You consented to loan offers via <partner/ClickPe> on <date>.
Unsubscribe (one click) · Privacy policy · ClickPe, Surat, India
```
**UX rules:**
- Mobile-first single column (most Indian users read on phones).
- Dark-mode-safe colours.
- Amounts in Indian digit grouping (₹1,50,000).
- **Lender legal name on every card.**
- The rate shown exactly as published, with the source date.
- No PII in URLs.
- Plain-text twin.
- Localization-ready templates (Hindi/Gujarati later; the template keys are already separate from the copy).

### 9.10 Notification reliability
- **Order:** `PENDING` row (unique `user_id + digest_key`) → send → `SENT` with `message_id`.
- **Crash window:** a crash between send and mark can cause a duplicate; the alternative order can silently lose emails. **Exactly-once email is impossible.**
- **Retries:**
  - throttling / 5xx → exponential backoff with full jitter, max 5 attempts
  - permanent errors → `FAILED`
- **Token bucket** shared across workers keeps us at or below the SES max send rate.
- **Dispatcher + paged sub-workflows** (500 per page, `SKIP LOCKED`), so n8n memory stays flat at 500k/day.
- **Auto-pause breaker** on bounce or complaint spikes (§9.8).

### 9.11 Multi-tenancy and fair scheduling
- `tenant_id` on all data; per-tenant quotas (API Gateway usage plans + DB checks).
- **Weighted fair queuing:**
  - matcher and dispatcher claims are ordered by `(tenant_last_served_at, created_at)`
  - big batches are chunked
  - so a 5M-row partner can't block a 2k-row partner (no head-of-line blocking)
- Per-tenant suppression and sender identity.

### 9.12 Security and threat model
| Actor | Attack | Mitigation |
|---|---|---|
| Uploader | Huge file / zip bomb | Declared size + server-issued part count + size check at complete; gzip expansion ratio cap; streaming |
| Uploader | Corrupted or tampered parts | Per-part SHA-256 signed into the URL |
| Uploader | Formula injection | Neutralized in all exported CSVs |
| Uploader | SQL injection | COPY + parameterized SQL only |
| Partner | Exceeding fair share | Usage plans, quotas, fair scheduling |
| Internet | Forged doorbell / approval | HMAC + timestamp (±5 min); state checks in the DB; the n8n resume URL is never exposed to the browser |
| Internet | Unsubscribe-link tampering | HMAC-signed token with expiry; no PII in links |
| Internet | Confirmation-link tampering or reuse as an unsubscribe token | HMAC-SHA256 token, 14-day expiry, constant-time compare, `c.` prefix domain-separates it from the unsubscribe token; an invalid link shows "this link has expired" and leaks nothing |
| User | False answers on the confirmation form | Sanity checks; contradictions flagged for ops and not used; offers labelled "self-declared"; the lender verifies documents |
| Crawled site | Prompt injection | No tools, schema, verbatim evidence, plausibility |
| LLM vendor | PII exposure | Only projected features leave our system |
| Leaked n8n creds | Mass email | SES IAM policy restricted to `ses:SendEmail` + `ses:FromAddress` condition; approval gate; complaint breaker |
| Network | Snooping | TLS everywhere; `rds.force_ssl=1`; demo RDS is publicly reachable but TLS-only (`rds.force_ssl=1`) with a random 32-char password from SSM. It can't be IP-allowlisted, because Lambdas outside a VPC have changing IPs and putting them in a VPC needs a ~$32/mo NAT for the n8n webhook. Production: private subnets + NAT/VPC endpoints + RDS Proxy |
| Repo | Secret leak | SSM Parameter Store SecureString; `.env.example` only; `N8N_ENCRYPTION_KEY` pinned outside git |
| Data subject | Erasure request (DPDP) | Delete cascade to offers/notifications; suppression keeps only a hash |

### 9.13 Observability and SLOs
- **Correlation:** `batch_id` across Lambda JSON logs (Powertools), n8n executions and DB rows.
- `pipeline_events` drives the UI timeline and the funnel metrics.
- **Metrics:**
  - rows/s
  - % rejected
  - classes
  - pairs per stage
  - LLM calls/tokens
  - emails sent/delivered/bounced/complained
  - cost per 1k users
- **Alarms:**
  - DLQ depth > 0
  - freshness SLO breach
  - bounce > 2%
  - complaint > 0.05%
  - LLM breaker open
  - crawler drift
  - batch stuck in a state > 2× expected

### 9.14 Concurrency, races, and the scale we assume
**Assumptions, stated plainly (Tier 2 design point):**

| Quantity | Assumed | Consequence |
|---|---|---|
| People in the database | 10M | One Postgres instance; no sharding (SCALE.md §3) |
| Largest single upload | 1M rows (~66–100 MB) | Ingest measured at 15.0 s (§9.15); 10M rows ≈ 2.5 min, inside Lambda's 15 min |
| Uploads in flight at once | up to 5 (SQS `maximumConcurrency: 5`) | Bounds DB connections from ingest; more uploads queue in SQS instead of overloading Postgres |
| Uploads per day | ~50 | Merge capacity (~1M rows per ~6 s, serialised) is ~600M rows/hour: far above need |
| Loan products | 200–500 | Bitmask width; class count stays in the thousands |
| Offer emails per day | ~500k | Paged dispatcher + shared token bucket under the SES rate (§9.10) |
| Live "what can I get?" lookups | 100–1,000 req/s | **Not this pipeline.** A separate online API reading `user_class`/`class_matches` (SCALE.md §4), the place where §9.15's language trade-off changes |

**What "a million people at the same time" means here, and how each case is handled:**
1. **One file with 1M people.** Streamed (constant memory apart from the duplicate map, 217 MB peak), `COPY`, then one serialised merge: 15 s.
2. **Several large uploads at once.** Up to 5 parse and validate in parallel; their merges take turns under an advisory lock. Parallel merges were measured no faster (one WAL), so taking turns costs nothing.
3. **A million emails.** Bounded by the SES send rate, not by our compute; queued as PENDING rows and sent in pages.
4. **A million borrowers clicking at once.** The online API's problem (cache the small class table; read replica), not the batch pipeline's.

**Every race we know of, and what stops it:**

| # | Race | What happens without protection | Protection | Proven by |
|---|---|---|---|---|
| 1 | S3 event delivered twice / SQS redelivery | Same file ingested twice | Compare-and-set claim `CREATED/UPLOADED → PARSING` | `test_duplicate_delivery_is_skipped` |
| 2 | S3 event arrives before `complete()` commits `UPLOADED` | Worker sees `CREATED`, skips, file never ingested | Claim accepts `CREATED` too | covered by design; `uploads.complete` comment |
| 3 | Ingest Lambda dies mid-file | Batch stuck in `PARSING` | Lease (16 min) + SQS redelivery after visibility timeout (6× Lambda timeout) reclaims; merge is one transaction, so nothing partial is visible | `test_claim_reclaims_only_expired_leases` |
| 4 | Two uploads containing the same people merge at once | Deadlock (rows locked in different orders) or duplicate-key failure on a new person | Merges serialised with `pg_advisory_xact_lock`; the batch that commits last owns the person | `test_parallel_uploads_with_overlapping_people…`: 4 processes; **fails without the lock** |
| 5 | Same person twice in one file | Which row counts? | Last row wins; earlier rows reported as `DUPLICATE_USER_ID` | `test_duplicate_user_id_last_row_wins` |
| 6 | A newer upload changes a person while the older batch is being matched | Person matched twice, or by stale data | Matching expands classes to users **at save time** (`last_batch_id = batch`); a person who moved to the newer batch is matched only by it | `b_save_matches.sql` design; `test_rematching_is_idempotent…` |
| 7 | Webhook and sweeper both trigger workflow B | Batch matched twice | CAS claim `LOADED → MATCHING` with a 15-min lease; zero rows = stop | `test_sweeper_finds_stalled_batches`, claim assertions in e2e |
| 8 | Matcher crashes mid-run | Batch stuck in `MATCHING` | Lease expires; sweeper reclaims; `b_save_matches` is idempotent (upsert, keeps `notified_at`) | `test_rematching_is_idempotent…` |
| 9 | Two notifiers queue the same person with different offers | Two emails in one week (the 7-day check is a read; both pass) | Partial unique index `(user_id, cap_week) WHERE status IN (PENDING, SENT)` | `test_two_notifiers_racing…`: **fails without the index** |
| 10 | Same offer queued twice (re-run, replay) | Duplicate email | `UNIQUE(user_id, digest_key)` | `test_no_duplicate_email_for_the_same_offer` |
| 11 | Crash after SES accepted but before `SENT` was saved | Retry sends again | **Accepted:** at-least-once. Exactly-once email is impossible; a duplicate beats a lost offer (§9.10) | documented |
| 12 | Catalogue updated while matching | Half old, half new rules | Products loaded once per run (snapshot); LLM cache keys include `criteria_hash` | `b_load_products` → `Plan classes` |
| 13 | Unsubscribe lands after an email was queued | One more email | Suppression checked at queue time. **Known gap:** the window is the queue-to-send time (seconds to minutes). Closing it fully means re-checking in the send loop (Tier 2) | documented |
| 14 | Two deploys run migrations at once | Double-applied DDL | Advisory lock in `database.Migrate` | `packages/database/migrate.go` |
| 15 | User aborts while the upload completes | Object exists but batch `ABORTED` (or vice versa) | Both are CAS from `CREATED`; only one wins | `batches.transition` semantics |
| 16 | Hundreds of API Lambdas open DB connections in a spike | Postgres runs out of connections (db.t4g.micro ≈ 80) | Tier 1: API Gateway throttling (10 rps / burst 20) bounds it. Tier 2: RDS Proxy + reserved concurrency | §6, OPTIMIZATION §1.6 |

### 9.15 Backend language: Go, decided by measurement
The brief allows Python or Go. We built the backend in Python first, then decided from first principles and measurement, not habit.

**Step 1: find where the time goes (Python, 1M rows, before tuning: 27.4 s).**
- 35% language-bound: decode + parse 1.8 s, validate 7.6 s.
- 65% Postgres: `COPY` 1.2 s, merge 12.8 s, bookkeeping ~4 s.

**Step 2: optimise what dominates, language-independent first.** The FK check, the split UPDATE/INSERT, the streaming duplicate check and `work_mem` brought the Postgres part down (OPTIMIZATION §1.1). Python fast paths followed. **Python: 15.0 s (−45%).**

**Step 3: compare the same pipeline in both languages** (same rules, same SQL, same 1M-row file, same Postgres):

| | Python (tuned) | **Go** |
|---|---|---|
| Parse + normalise + validate | 6.1 s | **1.25 s** (4.9×) |
| Full ingest, end to end | 15.0 s (66.6k rows/s) | **6.0–6.8 s (147–166k rows/s)**, 2.2–2.5× |
| Peak memory (1M rows) | 217 MB | 217–224 MB (both dominated by the duplicate-detection map) |
| Lambda cold start | interpreter + imports, typically several hundred ms | static binary, typically tens of ms (not measured on Lambda yet) |
| Deployment | a Linux-wheel layer for psycopg | one ~4 MB static binary per function |

Why Go beat its own projection (a 32% gain was expected from the parse share alone): pgx streams a binary `COPY` **while** rows are still being parsed, so parsing overlaps the database work, and binary numeric encoding is cheaper than text.

**Step 4: weigh what each language costs us here.**
- **Go:** more lines of code. The AI and eval ecosystem is thinner, but our backend calls no LLM (n8n does), and official OpenAI and Anthropic Go SDKs exist.
- **Python:** faster to write, and the strongest AI and data tooling. We keep it exactly where that matters: the **test and eval harness** (n8n SQL/JS chains, the brute-force oracle, LLM extraction evals, the AWS smoke test).

**Decision: the backend is Go.**
- **Ingest:** 2.2–2.5× faster.
- **API:** faster cold starts and smaller deployments.
- **Boundaries:** the compiler enforces them. `internal/` replaces our hand-checked `private/` convention.
- **Future fit:** this is the language we would want for the Tier-2 online eligibility API at 100–1,000 req/s.

The decision rests on measurements anyone can rerun (OPTIMIZATION §12).

### 9.16 Asking instead of guessing (WF-D, beyond the brief)
**The problem.** A match is LIKELY ("to confirm") when a lender rule depends on data the CSV doesn't have. On `users.csv` (10,000 people) that is **56,963 LIKELY matches**. They look like 57k separate problems, but they are blocked by only **~5 unknown facts**: work experience, bank relationship, employer type, city, business vintage. Plus Bank of Baroda's "income should be sufficient to repay the EMI", which the judge answers UNKNOWN.

**The planner** (`planQuestions` in `apps/workflows/src/code/questions.js`, pure functions, `node --test`):
- **Per fact, not per lender.** Each unverified rule maps to a question id through the product's `soft_rules[].depends_on`: `work_experience`, `employer_type`, `bank_accounts`, `city`, `business_vintage`, and `existing_emi` for EMI/repayment rules. A rule in `other` (non-EMI) can't be asked, so that match stays LIKELY.
- **Worth asking.** An unlocked match would score `100 − 2 × rate` (the matcher's own formula with nothing unverified). If the user already has ≥ 5 ELIGIBLE matches scoring at least that, we don't ask about it.
- **≤ 3 questions.** Choose the subset of question ids that unlocks the most matches; on a tie, fewer questions. With ≤ 6 ids, exhaustive search is trivial. Nothing to unlock → no questions.
- **Per profile.** For the console, `planForClasses` runs once per class × class size, so cost is O(classes), not O(users). The result goes into WF-B's funnel event as `question_plan: {users_to_ask, unlockable_matches, by_question}`.

**The link.** `c.<b64url(user_id)>.<exp>.<b64url(hmac16)>`: HMAC-SHA256 with `UNSUBSCRIBE_SECRET`, first 16 bytes, 14-day expiry. The `c.` prefix means an unsubscribe token can't be used here, and the reverse. No PII in the URL.

**Reuse.** Answers are stored per person, apart from the CSV data. After every match run, B loads the batch's people who already answered and re-checks their new LIKELY matches with those answers (same `confirm.js` judge path, ≤25 questions per LLM call, skipped when nobody answered), and C's planner never asks an answered question again. So a new lender's experience rule is resolved without a second question. A GIN index (`jsonb_path_ops`) supports searches over the answers.

**The answer.** Sanity checks → store in `user_declarations` → re-check only that user's LIKELY matches through the existing LLM judge → unlocked matches become `ELIGIBLE` with `decided_by = 'DECLARED'` → one email listing them as *pre-qualified (self-declared)*. The email goes to the recipient of that user's latest SENT notification (already test-mode rewritten), never `users.email` directly.

**Honesty rules.** Copy never says "approved". Contradictory answers are flagged for ops (`flagged`, `flag_reasons`) and not used. The lender still verifies documents at application.

**Production path.** Self-declaration is the demo. In production the same facts come from consented data: Account Aggregator bank statements (income, salary account, existing EMIs), a bureau soft pull, EPFO (work history). The planner stays the same; only the source of the answer changes.

*Rejected:*
- **Leaving "to confirm" as is.** 56,963 of 93,031 matches (61%) never become actionable.
- **One question per unverified rule or per lender.** Dozens of questions; most people would stop.
- **Asking everyone everything.** Many answers would unlock offers worse than ones the person already has.
- **A separate "please answer" email.** One more email per user; the link rides in the existing weekly email.

---

## 10. Failure mode analysis (FMEA)

| Failure | Detection | Impact | Recovery |
|---|---|---|---|
| Network drops mid-upload | Client part error | None | Retry the part; resume via ListParts |
| User abandons upload | — | Orphan parts | Lifecycle abort after 1 day |
| Duplicate S3 event | CAS fails | None | Exit |
| Ingest Lambda crash | SQS redelivery | Delay | Retry ×3 → DLQ → alarm; staging discarded, merge atomic |
| Wrong file uploaded | > 20% invalid | None merged | FAILED with reason + error report |
| n8n down at doorbell | Doorbell timeout | Delay ≤ 2 min after recovery | Sweeper claims the batch |
| Matcher crash mid-run | Lease expiry | Delay ≤ 15 min | Sweeper reclaims; idempotent writes |
| LLM outage / rate limit | Breaker | Some offers LIKELY-pending | Auto-resume; re-evaluate pending later |
| Crawler site down / redesign | crawl_runs error, drift alarm | Stale catalogue for that site | Other sites continue; LLM fallback reads the text |
| SES throttle | Throttling error | Delay | Token bucket + jittered backoff |
| Bounce/complaint spike | Event metrics | Reputation risk | Auto-pause WF-C, alert a human |
| DB failover (production Multi-AZ) | Connection errors | ~1–2 min | Retries with backoff; SQS buffers ingest |
| Region outage | — | Pipeline paused | Out of scope; S3 cross-region replication + snapshot restore documented |

---

## 11. Scale ladder

| Tier | First bottleneck | Change |
|---|---|---|
| 1 (100k users) | None | — |
| 2 (10M) | Match storage, n8n memory, email volume | Class storage, one-item arrays, paged dispatcher, n8n queue mode, SES production quotas |
| 3 (70M+) | 15-min Lambda limit, single-node merge | Chunked ingest fan-out, hash partitioning of users/offers, read replica for online lookups |

---

## 12. Testing, evals and the harness
- **Differential testing:** the bitset matcher must equal the SQL/brute-force oracle on randomized inputs.
- **Metamorphic properties:**
  - income↑ never removes an offer
  - adding a product never removes others
  - values exactly at a boundary pass
- **Upload tests:** part retry, resume after a simulated drop, checksum mismatch rejected, oversize rejected at complete.
- **Nasty-spreadsheet corpus:** every row of the §9.2 tables, as fixtures.
- **Idempotency and crash drills:** double upload, double event, matcher killed mid-run.
- **LLM extraction eval:** golden HTML snapshots + labelled JSON. Numeric exact-match ≥ 95%; unsupported-evidence fields = 0; prompt versioning.
- **Judgment eval:** labelled set; ≥ 90% agreement; abstains when data is missing; deterministic at temperature 0.
- **Deliverability check:** SPF/DKIM/DMARC pass verified in the received message's headers (`Authentication-Results`); shown in the demo.
- **CI:** Postgres service; `go test ./...` (each test gets its own database; S3 behind an interface with an in-memory fake, plus an offline check of the real SDK's presigned URLs); the Python harness runs n8n's SQL + JS against the Go binaries with recorded LLM responses. Deterministic, free, runs on every push.
- **Load test:** a synthetic 1M-row CSV to measure ingest and match times against the NFRs.

---

## 13. Trade-offs we chose consciously
| Chose | Over | Because |
|---|---|---|
| REST API Gateway | HTTP API | Usage plans, WAF, validation; the cost difference is negligible at our volume |
| Multipart for every file size | POST for small + multipart for large | One code path; resume and integrity everywhere |
| Postgres outbox + sweeper | Kafka / SQS-to-n8n | Same guarantees here, far fewer moving parts |
| Class-level match storage | Full pair table | 1.5B rows → thousands + top-K |
| At-least-once email | At-most-once | A lost loan offer is worse than a rare duplicate |
| Public RDS (TLS-only, strong password) for the demo | Private RDS + NAT | ~$32/mo avoided; Lambda IPs can't be allowlisted; production path documented |
| Polling for status | WebSockets / SSE | Minute-long jobs; simplest reliable option |
| Self-declared answers for "to confirm" facts (WF-D) | Consented data (Account Aggregator, bureau, EPFO) | Works today with no partner integration; labelled self-declared; the lender verifies. Consented data is the documented production path |
| Own Gmail as sender + `+alias` recipients (demo) | Custom domain | The brief allows it; zero cost; a Gmail filter handles spam placement. A domain with DKIM/SPF/DMARC is the documented production path |

---

## 14. 72-hour build scope (aligned to the brief; see REQUIREMENTS.md for the line-by-line mapping)
| Required by the brief | Bonus the brief names (we do these) | Our additions that score on the rubric | Documented only (not built) |
|---|---|---|---|
| Event-driven scalable CSV ingest → RDS `users`; n8n in Docker; WF-A scheduled crawl → `loan_products`; WF-B webhook → fetch new users + all products → matching **in n8n** → `matches`; multi-stage Treasure Hunt; WF-C after WF-B → personalized email via **the n8n AWS SES node** to Gmail `+aliases`; minimal upload UI; `serverless.yml`; `docker-compose.yml`; workflow JSONs; README (diagram, setup incl. n8n credentials, design decisions); 5–10 min video; private repo + 4 collaborators | **Public AWS deployment** · **layout-change handling** in the crawler · API Gateway (optional; we use it for presign/status) | Multipart resumable upload · S3→SQS→Lambda + DLQ · outbox/sweeper/lease · class + bitset matching · LLM compile-once + projected cache + breaker · "new matches only" diff + no-duplicate emails · n8n Error workflow + node retries · WF-D: ask ≤ 3 questions to confirm "to confirm" offers (§9.16) · status timeline in the UI · tests (differential, nasty CSVs, idempotency) · 1M-row load test | Custom sending domain (DKIM/SPF/DMARC), bounce/complaint pipeline, multi-tenancy, approval gate (toggle only), online offers API, XLSX + column mapping, queue-mode n8n, chunked ingest fan-out, WhatsApp |
