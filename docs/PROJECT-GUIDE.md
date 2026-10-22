# The Loan Eligibility Engine: The Friendly Guide

> **Who this is for:** anyone seeing this project for the first time, including someone who has never
> touched AWS, n8n or Go. There is no scary code here. Every idea is explained with everyday examples,
> and every technical word is explained the first time it appears (and again in the glossary at the end).
>
> **How to read it:** go top to bottom once. Parts 1–4 give you the whole story in 15 minutes.
> Parts 5–9 go deeper, one piece at a time. Part 10 onwards is reference: the folder tour, the glossary
> and practice interview questions.
>
> **One promise:** nothing in this project is magic. Every piece is a small, simple idea. The project
> looks big only because there are many small ideas sitting next to each other.

---

## Table of contents

1. [The project in 60 seconds](#part-1--the-project-in-60-seconds)
2. [The cast: who does what](#part-2--the-cast-who-does-what)
3. [The one big picture](#part-3--the-one-big-picture)
4. [The single most important idea: the relay baton](#part-4--the-single-most-important-idea-the-relay-baton)
5. [The journey of one CSV file, step by step](#part-5--the-journey-of-one-csv-file-step-by-step)
6. [How we find loan products (the crawler)](#part-6--how-we-find-loan-products-the-crawler)
7. [How we match people to loans (the Treasure Hunt)](#part-7--how-we-match-people-to-loans-the-treasure-hunt)
8. [How the emails go out](#part-8--how-the-emails-go-out)
9. [The database: every table in plain words](#part-9--the-database-every-table-in-plain-words)
10. [Folder tour: every file and why it exists](#part-10--folder-tour-every-file-and-why-it-exists)
11. [When things go wrong: the safety nets](#part-11--when-things-go-wrong-the-safety-nets)
12. [Security in plain words](#part-12--security-in-plain-words)
13. [How we prove it works: tests and CI](#part-13--how-we-prove-it-works-tests-and-ci)
14. [How it gets onto AWS: deployment](#part-14--how-it-gets-onto-aws-deployment)
15. [Numbers worth remembering](#part-15--numbers-worth-remembering)
16. [Glossary: every word, explained simply](#part-16--glossary-every-word-explained-simply)
17. [Practice interview questions (with simple answers)](#part-17--practice-interview-questions-with-simple-answers)
18. [One-page cheat sheet](#part-18--one-page-cheat-sheet)

---

## Part 1: The project in 60 seconds

Imagine you work at a loan-comparison company like ClickPe. Every day, someone from the operations team
has a **spreadsheet of people** (a CSV file): their email, monthly income, credit score, job type and age.

Separately, banks like HDFC, ICICI and SBI publish **loan rules** on their websites: "you need at least
₹25,000 a month and a credit score of 700 to get this loan."

Our system does four things, automatically:

1. **Reads the bank websites every night** and writes down each loan's rules in a neat table.

   *(This is "Workflow A, the crawler".)*
2. **Lets the ops person upload the spreadsheet** through a website, checks every row, and saves the good

   ones. *(This is the "upload" and "ingest" part, written in Go and running on AWS.)*
3. **Works out which person qualifies for which loan.** *(This is "Workflow B, the matcher".)*
4. **Emails each person** a friendly list of loans they may qualify for. *(This is "Workflow C, the notifier".)*

That's it. Everything else in this repo exists to make those four things **fast, cheap, safe, and
impossible to mess up**, even when files are huge, networks fail, or the same thing happens twice.

> 💡 **The assignment brief** is in `task.md`. It asked for exactly this: an event-driven upload, three n8n
> workflows (A, B, C), an "Optimization Treasure Hunt" to avoid wasting AI calls, and SES emails sent only
> to test inboxes.

---

## Part 2: The cast: who does what

Think of the system as a small office. Each "employee" is a technology with one clear job.

| Employee | Real name | Their one job | Everyday comparison |
|---|---|---|---|
| 🖥️ The front desk | **Web console** (Next.js, in `apps/web`) | The website where the ops person uploads files and watches progress | The reception counter |
| 🚪 The security guard | **API Gateway** | Checks the visitor has the right key, then passes the request on | The guard who checks your ID card |
| 🧑‍💼 The clerk | **API Lambda** (Go, in `apps/api`) | Answers questions and hands out upload permission slips | The clerk who stamps forms |
| 📦 The warehouse | **S3** | Stores the uploaded files | A storage room |
| 📬 The inbox tray | **SQS** (a queue) | Holds "a new file arrived" notes until someone is free to handle them | The tray on a desk where letters wait |
| 🧹 The data cleaner | **Ingest Lambda** (Go, in `apps/ingest_worker`) | Reads the file, checks every row, saves good rows | The person who checks and files every form |
| 🗄️ The filing cabinet | **PostgreSQL on RDS** | Stores everything: people, loans, matches, emails, history | The big filing cabinet |
| 🤖 The manager | **n8n** (in Docker, `apps/workflows`) | Runs four workflows: crawl, match, email, and confirm (asks people for missing facts) | The manager who follows a checklist |
| 🧠 The consultant | **LLM** (Gemini, via an OpenAI-style API) | Reads bank web pages and turns them into rules; judges a few fuzzy rules | An expert you call only when needed (they charge per call!) |
| ✉️ The post office | **SES** (Simple Email Service) | Actually delivers the emails | The post office |
| 🔔 The doorbell | **Webhook** (HMAC-signed) | Lets the data cleaner tell the manager "a batch is ready!" | Ringing a bell at the manager's door |
| ⏰ The night watchman | **Sweeper** (runs every 2 minutes) | Checks for any batch that was forgotten, and starts it | A guard doing rounds |

**Three programming languages, three jobs:**

- **Go** for the backend (API and ingest). It's fast, and it starts quickly on Lambda.
- **TypeScript/React** (Next.js) for the website.
- **JavaScript + SQL inside n8n** for the workflows, with the workflow *shapes* written in **Python**
(more on that in Part 10).

Python is also used for the **test harness**, the tool that proves everything works together.

---

## Part 3: The one big picture

```
                 ┌──────────────────── every night at 2 AM ─────────────────────┐
                 │  n8n Workflow A (crawler): bank websites → LLM → loan_products │
                 └────────────────────────────────────────────────────────────────┘

 ① Browser               ② AWS                                    ③ Database (RDS)
 ┌──────────┐  key   ┌────────────┐   permission slips             ┌──────────────┐
 │ Website  │──────► │ API Gateway│──► API Lambda ───────────────► │ ingest_batches│
 │ (upload) │        └────────────┘                                │ users        │
 │          │══ file parts go STRAIGHT to S3 ══► S3 bucket          │ loan_products│
 └──────────┘                                      │               │ matches      │
                                                   │ "file arrived"│ notifications│
                                                   ▼               │ pipeline_events│
                                                  SQS ──► Ingest Lambda ──► saves users
                                                                   │
                                                 🔔 doorbell (signed) │   ⏰ sweeper (every 2 min)
                                                                   ▼
 ④ n8n (Docker)   Workflow B (match) ──► matches ──► Workflow C (notify) ──► SES ──► 📧 inbox
                  Workflow E (errors) writes any crash into the timeline
```

**Who owns what (memorise this table):**

| Stage | Who runs it | Where it runs |
|---|---|---|
| Upload | Browser + API Lambda + S3 | Your browser + AWS |
| Ingest (read and save the CSV) | Ingest Lambda (Go) | AWS |
| Crawl (find loans) | n8n Workflow A | Docker on the laptop |
| Match | n8n Workflow B | Docker on the laptop |
| Notify (email) | n8n Workflow C | Docker on the laptop |
| Errors | n8n Workflow E | Docker on the laptop |

> 💡 **Why is n8n on a laptop and not on AWS?** The brief says "self-hosted n8n in Docker". AWS reaches it
> through a **tunnel** (a public web address that forwards to the laptop). In a real company, n8n would
> run on a server with a fixed address.

---

## Part 4: The single most important idea: the relay baton

If you understand only one thing, understand this.

Every uploaded file becomes a **batch**: one row in the `ingest_batches` table. That row has a
**status**, and the status moves forward like a baton in a relay race:

```
CREATED → UPLOADED → PARSING → LOADED → MATCHING → MATCHED → NOTIFYING → DONE
   │          │         │         │          │          │          │
 upload    upload    ingest    ingest     match      match     notify
 started   finished  started   finished   started    finished  started

 Side exits:  FAILED (something was wrong with the file)   ABORTED (upload cancelled)
```

**The rule:** each worker only picks up the baton if it's at *exactly* the status they expect, and
they do it in **one atomic step**: "change LOADED to MATCHING, **but only if it is still LOADED**."

This trick has a name: **compare-and-set** (CAS). Think of it like grabbing the last seat on a bus.
Two people may reach for it at once, but only one can sit down. The other sees it's taken and walks away.

**Why this matters so much:**

- AWS sometimes delivers the same "file arrived" message **twice**. With CAS, the second delivery
finds the batch already at PARSING and simply stops. No double-processing.
- The doorbell and the sweeper might **both** try to start matching the same batch. Only one wins.
- If a worker crashes halfway, the batch is left at a known status, so we always know where to restart.

**Leases (borrowing the baton for a limited time):** when the matcher takes a batch, it also writes
"I have this until 15 minutes from now" (`lease_until`). If the matcher crashes, the 15 minutes run out
and someone else is allowed to take the batch. It's like borrowing a library book: if you never return it,
the library eventually lets someone else have it.

**The timeline:** every time the baton moves, a line is written to `pipeline_events` ("ingest started",
"users saved", "matching triggered"…). The website reads this to show the live progress. It's the
batch's diary.

> 📍 The code for this lives in `packages/batches/batches.go` (functions `Transition`, `Claim`,
> `RecordEvent`) and in SQL files like `apps/workflows/src/sql/b_claim_batch.sql`.

---

## Part 5: The journey of one CSV file, step by step

Let's follow **one upload** from click to inbox. For each step: what happens, which file does it, and
**why** it's done this way.

### Step 1: The ops person opens the website and enters the API key

- The website is a **static site**: plain HTML/JS files sitting in S3 / AWS Amplify. There's no server
rendering pages.
- The first time, it asks for an **API key**. The key is stored in that browser only (local storage) and
sent with every request. The security guard (API Gateway) rejects requests without it.
- 📍 Files: `apps/web/src/components/ApiProvider.tsx`, `ApiKeyDialog.tsx`, `apps/web/src/lib/config.ts`.
- **Why a key?** Without it, anyone on the internet could flood our API. The key also comes with
**rate limits**: 10 requests/second, bursts of 20, 20,000 per day.

### Step 2: They choose a file, and the browser checks its columns *before* uploading

- The browser reads only the **first 64 KB** of the file and checks: are the required columns there?
Is it really a CSV?
- It uses the **server's own list** of accepted columns and their aliases (fetched from
`GET /v1/uploads/schema`). So if the browser says "looks fine", the server will agree.
- Aliases mean people don't have to rename columns: "salary", "income" and "net_monthly_income" all
count as `monthly_income`. "cibil" counts as `credit_score`.
- 📍 Files: `apps/web/src/lib/csv/inspect.ts`, `components/upload/ColumnCheck.tsx`,
`components/upload/DropZone.tsx`, and on the server `packages/ingestion/spec.go` (the one true list).
- **Why?** So nobody waits two minutes for an upload, only to learn they picked the wrong file.
(The server still checks every row, because a browser can be bypassed.)

### Step 3: The browser asks for an "upload session"

- The browser calls `POST /v1/uploads` with the file name and size.
- The API Lambda checks the size (max **200 MB** by default), creates the batch row (status
**CREATED**), and asks S3 to start a **multipart upload**.
- It replies: "here's your batch id; split the file into **8 MB** parts; send up to **4 at a time**."
- 📍 Files: `apps/api/handlers.go` → `createUpload`, `packages/uploads/uploads.go` → `CreateSession`.

> 🧠 **What is a multipart upload?** Instead of sending one giant file in one go (and starting over if
> the Wi-Fi drops at 99%), you cut it into numbered pieces and send each piece separately. S3 glues them
> back together at the end. If one piece fails, you resend only that piece.

### Step 4: The browser sends each part straight to S3, with a fingerprint

This is the cleverest part of the upload. For **each 8 MB part**:

1. The browser calculates a **SHA-256 fingerprint** of the part. That's a short code that changes

   completely if even one byte changes.
2. It asks the API for a **presigned URL** for that part. A presigned URL is a temporary permission

   slip: "you may upload part 3 to this exact place, for the next hour."
3. **The slip has the fingerprint baked into it.** When the part arrives, S3 recalculates the

   fingerprint. If it doesn't match, **S3 rejects the part**. So a corrupted or tampered byte can
    never get in.
4. The browser sends the part **directly to S3**, not through our API.

Other details:

- Failed parts are retried with **exponential backoff + jitter**: wait a little, then longer, with a
random wobble so many retries don't all hit at the same instant.
- If you **refresh the page or lose internet**, picking the same file again **resumes**: the browser asks
"which parts do you already have?" and sends only the missing ones.
- On plain-HTTP pages, browsers don't offer their built-in SHA-256 tool, so we include a small
JavaScript fallback (`@noble/hashes`).
- 📍 Files: `apps/web/src/lib/upload/multipart.ts` (the upload engine), `packages/uploads/uploads.go`
→ `PresignParts`, `ListParts`, and `packages/uploads/internal/s3store/s3store.go` (the only file that
talks to S3 for uploads).

> ❓ **Why not just upload through the API?** API Gateway has a **10 MB request limit** and a
> **29-second timeout**, and Lambda isn't built to stream big files. Sending bytes straight to S3 avoids
> all of that, and our servers never touch the file bytes. That's the "event-driven ingestion pattern"
> the brief asked for.

### Step 5: The browser says "I'm done": `complete`

- The API asks S3 "which parts do you have?" and checks: are **all** parts there? Does the **total
size** match what was declared? (If not, the upload is cancelled and marked ABORTED.)
- Then it tells S3 to glue the parts together, and moves the batch **CREATED → UPLOADED**.
- 📍 File: `packages/uploads/uploads.go` → `Complete` (and `Abort` for the cancel button).

### Step 6: S3 drops a note in the SQS tray

- As soon as the full file exists, S3 automatically sends an **"object created" event** to **SQS**
(a queue).
- SQS wakes up the **Ingest Lambda**. At most **5 run at once** (`maximumConcurrency: 5`), so the
database is never overwhelmed.
- If processing fails, SQS tries again. After **3 failures**, the note moves to the **DLQ** (dead-letter
queue, a "problem tray"), and a **CloudWatch alarm** goes off.
- 📍 Files: `apps/ingest_worker/main.go`, `serverless.yml` (IngestQueue, IngestDLQ, DlqNotEmptyAlarm).

> ❓ **Why a queue instead of S3 calling the Lambda directly?** The queue gives us buffering (a burst of
> uploads waits politely), visible retries, a problem tray for broken messages, and the ability to replay.

### Step 7: The Ingest Lambda reads, cleans and checks the file

This is `packages/ingestion/pipeline.go` → `Run`. In order:

1. **Claim the batch:** CAS from CREATED/UPLOADED → **PARSING**, with a lease. (CREATED is also

   accepted because S3's note can arrive a split second *before* step 5 finishes writing UPLOADED.)
    If the claim fails, it's a duplicate message, so we stop quietly.
2. **Stream the file from S3.** It's read bit by bit, never loaded fully into memory.

   (`internal/s3reader/s3reader.go`)
3. **Decode it** (`decode.go`): unzip gzip if needed, remove the invisible "BOM" character Excel adds,

   handle odd text encodings. There's also a **zip-bomb guard**: stop if the unzipped size passes 2 GB.
4. **Find the header and columns** (`rows.go` + `spec.go`): find the header row, match aliases,

   detect the delimiter (comma, semicolon, tab…).
5. **Normalise messy values** (`normalize.go`). Indian spreadsheets are messy, so:
   - `₹1,20,000` → 120000; `1.2L` → 120000; `50k` → 50000
   - credit score `NA` or blank → "new to credit" (no credit history, stored as empty)
   - "salaried", "Salaried Employee" → `Salaried`
   - "35 yrs" → 35
6. **Validate each row** (`validate.go`): valid email? age 18–100? credit score 300–900? Every problem in

   a row is recorded (row number, column, what was wrong), not just the first one.
7. **Bulk-load the good rows** using Postgres **COPY**: a super-fast "pour everything in at once" command,

   into a temporary **staging** table.
8. **Circuit breaker:** if **more than 20%** of rows are bad, something is clearly wrong with the

   file. Save **nothing** and mark the batch **FAILED** with a clear reason.
9. **Merge** staging → `users` in **one transaction** (all or nothing) (`repository.go` → `merge`):
   - New `user_id` → **insert**. Existing `user_id` with changed details → **update**.
    Existing with identical details → **leave it alone**.
   - Every changed or new user is stamped with this batch's id (`last_batch_id`). That's how the matcher
   later finds "the users from this upload".
   - Merges are done **one at a time** (a Postgres "advisory lock"). Measured on 1 million rows, running
   merges in parallel was no faster, and doing one at a time removes every possible race between two
   uploads.
10. **In the same transaction**, move the batch PARSING → **LOADED** and save the row counts.

    So "users saved" and "status LOADED" happen together or not at all.
11. **Save the row errors** so the ops person can download `errors.csv` ("row 17: invalid email").

    (`report.go`)

> 📊 **Speed:** about 6 seconds for 1 million rows on Lambda. COPY + one merge is roughly 10–50× faster
> than inserting rows one by one.

### Step 8: Ring the doorbell 🔔

- The Ingest Lambda sends a POST to n8n's webhook: "batch X is LOADED."
- The message is **signed** with a secret (HMAC; think of it as a wax seal only we can make). n8n checks
the seal and rejects anything unsigned or **older than 5 minutes** (so nobody can replay an old message).
- **The doorbell is best-effort.** If it fails (n8n asleep, tunnel down), nothing breaks: the batch is still
LOADED in the database, and the **sweeper** (every 2 minutes) finds it. The timeline will say
"Queued for matching" instead of "Matching triggered".
- 📍 Files: `packages/orchestration/orchestration.go` (`Sign`, `TriggerMatching`),
`apps/workflows/src/code/signature.js` (n8n's side of the check).

> 🧠 **The golden rule here:** the **database is the source of truth**; the doorbell is just a
> speed-up. That's why a lost message can only make things *later*, never *lost*.

### Step 9: n8n matches people to loans (Workflow B)

Covered in detail in **Part 7**. In short: claim the batch (LOADED → MATCHING), group the batch's users
into "classes", check every class against every loan using fast yes/no switches, ask the AI only for the
rare fuzzy rules (and remember its answers), save the results to `matches`, mark the batch **MATCHED**,
and call Workflow C.

### Step 10: n8n emails people (Workflow C)

Covered in detail in **Part 8**. In short: claim the batch (MATCHED → NOTIFYING), decide who should get
an email (consent, unsubscribes, max one per week, no duplicates), build a personal email, send it via
SES one per second, record sent or failed, and mark the batch **DONE**.

### Step 10½: the person answers a few questions (Workflow D)

Covered in **Part 8** ("Asking instead of guessing"). If a lender needs a fact the CSV doesn't have
(work experience, employer type, an existing account with that bank), the email carries a signed link to
a short form. The person's answers re-check only their own "to confirm" offers, and any that now pass
become **pre-qualified (self-declared)**. Later match runs reuse the answers, so nobody is asked twice.

### Step 11: The website shows it all live

- After uploading, you land on the **batch page**. It **polls** the API (asks "any news?") every 1 s,
slowing to every 5 s, until the batch reaches DONE, FAILED or ABORTED.
- It shows a **stepper** (Upload → Validate → Match → Notify), row counts, the error list, the
**match funnel** (how many people and pairs survived each filter), matches per loan, and emails
sent or failed.
- 📍 Files: `components/batch/BatchDetail.tsx`, `hooks/usePolling.ts`, `lib/pipeline.ts` (turns
"MATCHING" into the friendly words "Matching"), `components/PipelineStepper.tsx`,
`components/MatchFunnel.tsx`.

> ❓ **Why polling and not live WebSockets?** A batch takes seconds to minutes. Asking every few seconds
> is perfectly fine, and WebSockets would need extra infrastructure for no visible benefit.

### Step 12: If someone clicks "Unsubscribe"

- The email's unsubscribe link carries a **signed token**: the user id + an expiry (90 days) +
a seal. Nobody can forge one for another person.
- The API checks the seal and adds the email (stored as a **hash**, not the plain address) to the
`suppression` list. Workflow C never emails a suppressed address again.
- 📍 Files: `packages/notifications/notifications.go` (`MakeToken`, `VerifyToken`, `Unsubscribe`),
`apps/workflows/src/code/email.js` (`unsubscribeToken`, which makes the identical token on n8n's side).

---

## Part 6: How we find loan products (the crawler)

**Workflow A** runs **every night at 2:00 AM IST** (and has a "Run now" button).
📍 Graph: `apps/workflows/src/workflows/wf_a_crawl.py`; brains: `apps/workflows/src/code/crawl.js` and
`llm.js`; SQL: `apps/workflows/src/sql/a_*.sql`.

### Which websites?

The list of pages is **data, not code**: rows in the `crawl_sources` table. Each lender has an
"eligibility" page and a "rates" page. It started with HDFC, ICICI and Kotak (`002_seed_crawl_sources.sql`)
and grew to **15 lenders** (`006_more_lenders.sql`): SBI, Axis, Bank of Baroda, Union Bank, IDFC FIRST,
IndusInd, RBL, HSBC, Bajaj Finserv, Tata Capital, Poonawalla Fincorp and L&T Finance.
Adding a lender = adding rows.

### The steps, cheapest check first

1. **Load the pages to visit.**
2. **Download each page politely:** 1 request per second, with an honest "User-Agent" name.

   It sends "**If-None-Match / If-Modified-Since**", which means "only send the page if it changed since
    last time". If the bank answers **304 Not Modified**, we stop right there. Cost: almost nothing.
3. **Cut out the useful text** (`crawl.js` → `htmlToText`, `relevantSection`): turn HTML into plain text,

   then keep only lines near words like *eligibility, income, salary, credit score, age, interest*.
    Menus, ads and footers are thrown away.
4. **Fingerprint that text** (SHA-256). If the fingerprint is the same as last night, the rules haven't

   changed, so **skip the AI**. (Changes in ads or dates don't count, because only the eligibility text
    is fingerprinted.)
5. **Only if something changed:** send the text to the **LLM** with a prompt asking for structured JSON:

   product name, interest rate, minimum income, minimum credit score, age range, job types, and any
    "soft rules" it can't put in a number.
    AI calls are paced **4 at a time with 2-second gaps**, so we don't hit the provider's per-minute limit.
6. **Validate like a strict teacher** (`crawl.js` → `validateProducts`). This is the **anti-hallucination**

   rule: for **every number** the AI gives, it must also give a **quote copied word-for-word from the
    page**, and that quote must really be on the page and really contain that number. If not, the number
    is thrown away. So the AI cannot invent "min income ₹15,000", and a sneaky web page cannot trick it
    ("prompt injection") into inventing rules.
7. **Save the products** to `loan_products`, along with their quotes (`evidence`), a stable id

   (`product_key`, a hash of lender + product name) and a `criteria_hash` (a fingerprint of the rules,
    used later to know when old AI answers are out of date).
8. **Save the page's state** (fingerprint, ETag) for tomorrow's "did it change?" check.

### What if something fails?

- A page fails to download, or the AI is slow? It retries (up to 3 times for AI calls).
- Still failing? **Keep yesterday's products.** A failure must never wipe good data. The page's saved
state is cleared, so tomorrow's run tries again instead of skipping it as "unchanged".
- Every attempt is logged in `crawl_runs` (outcome: not_modified / unchanged / extracted / failed).

> 🧠 **Why we don't use CSS selectors** (like "the number inside the third `<div class="rate">`"):
> banks redesign their sites, and selectors break silently. Keyword windows + verbatim quotes survive
> redesigns. This is the brief's optional "handle website layout changes" bonus.

> 🧠 **The AI is a "rule compiler", not a judge of people.** It reads each bank page **once a day** and
> turns it into rules. It **never** looks at a person's data. So the AI cost stays the same whether you
> have 100 users or 10 million.

---

## Part 7: How we match people to loans (the Treasure Hunt)

**Workflow B.** 📍 Graph: `apps/workflows/src/workflows/wf_b_match.py`; brains:
`apps/workflows/src/code/matcher.js`; SQL: `apps/workflows/src/sql/b_*.sql`.

### The problem

10,000 people × 30 loans = 300,000 checks. If you asked an AI about each pair, it would cost a fortune and
take hours. The brief calls this the **Optimization Treasure Hunt**: find a smarter way.

### How it starts

Two doors into Workflow B:

- 🔔 **Doorbell webhook**: the fast path. It first verifies the signature.
- ⏰ **Sweeper every 2 minutes**: finds batches that are LOADED for more than 1 minute (doorbell
missed) or MATCHING with an expired lease (matcher crashed). One batch per tick.

Both go to **Claim batch**: LOADED → MATCHING with a **15-minute lease**. If zero rows come back,
someone else has it, so stop.

### Stage 1: Group people into "classes" (done in SQL)

Here's the insight, with an analogy:

> 👕 Think of T-shirt sizes. A shop doesn't need your exact chest measurement in millimetres; it only
> needs to know whether you're S, M, L or XL. In the same way, a loan with "min income ₹25,000" doesn't
> care whether you earn ₹31,000 or ₹38,000. It only cares which side of ₹25,000 you're on.

So:

1. Collect every **threshold** any loan uses: incomes (₹15k, ₹25k, ₹40k…), credit scores (650, 700,

   750…), ages (21, 60…). These become **cut points**.
2. Put every user into a **bucket** per attribute using Postgres's `width_bucket` function

   ("you're between ₹25k and ₹40k → bucket 3").
3. **Group by** (income bucket, credit bucket, age bucket, job type). Everyone in the same group is

   **identical in the eyes of every loan**.

**Result:** 10,000 users → just a few hundred **classes**. We now check classes, not people.
(This idea's fancy name is **coordinate compression**.)

People with **no credit history** get their own credit bucket (0), and only match loans that say they
accept new-to-credit applicants (`accepts_ntc`).

📍 `apps/workflows/src/sql/b_load_classes.sql`, `matcher.js` → `buildCuts`.

### Stage 2: Check classes against loans with "bitsets"

> 💡 Imagine each loan has a light switch. For each attribute, we prepare, in advance, a row of switches
> saying which loans are OK for each bucket:
>
> - "Income bucket 3 → loans 1, 2, 5 are OK" → switches `1 1 0 0 1`
> - "Credit bucket 4 → loans 1, 5 are OK" → switches `1 0 0 0 1`
> - "Age bucket 2 → loans 1, 2, 3, 5 are OK" → switches `1 1 1 0 1`
> - "Salaried → all OK" → switches `1 1 1 1 1`
>
> A class's eligible loans = switches that are ON in **all** rows → `1 0 0 0 1` → loans 1 and 5.

Computers do this "AND all the rows" in a single instruction, so it's incredibly fast. These rows of
switches are called **bitmasks** or **bitsets**. We use JavaScript **BigInt**, so there's no limit of
64 loans.

📍 `matcher.js` → `attributeMasks` (prepare the switches), `matchClasses` (AND them per class),
`popcount` (count the ON switches).

### Stage 3: Ask the AI only when truly needed, and remember the answer

Some loan rules don't fit into a number, for example: *"Applicant must be salaried with a minimum income of
₹30,000 if under 25."* These are **soft rules**, each tagged with which facts it depends on (`depends_on`).

- If a soft rule depends on facts **we don't have** (work experience, employer type, city…) we
**never guess**. The match becomes **LIKELY** (not ELIGIBLE), and the rule is listed as
"Still to confirm with the lender" in the email.
- If it depends on facts we **do** have (income, credit score, age, job type), we ask the AI. But:
  - The AI sees only the **bucket ranges** (e.g. "income between ₹25,000 and ₹40,000"), **never a real
  person's data**. No personal information ever leaves to the AI.
  - Answers are **cached** in `llm_judgments`. The cache key = loan + its rules version + the rule +
  only the facts that rule depends on. So the cache size depends on the number of possible buckets,
  **not** the number of users. A million new users usually means **zero** new AI calls.
  - If the bank changes its rules, the `criteria_hash` changes, so the old cached answers no longer match
  and get re-asked.
- Verdicts: PASS → keep, FAIL → drop, UNKNOWN → LIKELY.

📍 `sql/b_lookup_judgments.sql`, `sql/b_save_judgments.sql`, `llm.js` → `judgmentRequest`,
`parseJudgments`, `matcher.js` → `cacheKey`.

### Stage 4: Save matches (one database statement)

n8n sends the few hundred **class results** to Postgres, which **expands them back to users** and saves
them in one go (instead of n8n sending thousands of separate inserts):

- New pairs are added. Existing pairs keep their original `first_matched_at` and `notified_at`, so **nobody
gets emailed twice for the same offer**.
- Pairs a user **no longer** qualifies for (their income dropped, say) are removed.
- Each match gets a **status** (ELIGIBLE or LIKELY), a **score** for ranking, and `decided_by`
(RULES or LLM).
- The **funnel** numbers (users, pairs, after hard rules, AI calls, cache hits, matches) are saved to the
timeline. This is the "Treasure Hunt" proof shown on the batch page.
- The batch moves MATCHING → **MATCHED**, then Workflow B calls **Workflow C**.

**Score (ranking):** start at 100, subtract 2 × the interest rate, subtract 5 for every unverified rule.
Cheaper loans and more certain matches rank higher.

📍 `sql/b_save_matches.sql`, `matcher.js` → `score`.

### Why we know it's correct

`tests/oracle/brute_force.py` is a deliberately **slow but obviously correct** matcher: it checks every
user against every loan with plain `if` statements. The tests run both and prove the fast one gives
**exactly the same answer**. That slow, trusted reference is called an **oracle**.

### The funnel, as you might say it in an interview

> "Naively, it's users × products checks, plus an LLM call per pair. We compress users into classes with
> SQL `width_bucket` and `GROUP BY` (thousands → hundreds), evaluate hard rules with bitmask ANDs
> (microseconds), send only soft rules about data we actually have to the LLM, on anonymous bucket
> ranges, and cache those answers by rule + features. LLM calls scale with rule diversity, not with
> users, and a brute-force oracle test proves the output is identical."

---

## Part 8: How the emails go out

**Workflow C**, called by Workflow B. 📍 Graph: `apps/workflows/src/workflows/wf_c_notify.py`; brains:
`apps/workflows/src/code/email.js`; SQL: `apps/workflows/src/sql/c_*.sql`.

### The steps

1. **Claim batch:** MATCHED → NOTIFYING (CAS). Zero rows back means it's already handled, so stop.
2. **Queue notifications** (`c_queue_notifications.sql`), the "who gets an email?" decision. A person is

   picked only if:
   - they have **new, un-emailed** matches in this batch,
   - they gave **marketing consent**,
   - they were **not emailed in the last 7 days**,
   - their address is **not on the suppression list** (unsubscribed or bounced),
   - their address is deliverable (not `example.com` etc.).

    Each picked person gets one **PENDING** row in `notifications`.
3. **Load pending** + **Render emails** (`email.js` → `renderEmail`). For each person it builds a

   mobile-friendly email:
   - Subject: *"Asha, 4 personal loans you may qualify for"*
   - Up to **5 loan cards**, spread across lenders (each lender's best loan first), then "+N more across
   X lenders"
   - For each loan: lender, product, rate **exactly as published**, "**Why you may qualify**" (your own
   numbers vs the rules) and "**Still to confirm with the lender**" (rules we couldn't check)
   - A clear "these are indicative matches, not offers" note, and an **unsubscribe** link
   - A plain-text version too (some email apps prefer it)
   - All names are **HTML-escaped**, because names come from a spreadsheet and could contain sneaky code.
4. **Send, one at a time:** a loop sends each email through the **n8n AWS SES node** (the brief requires

   this node). SES gets **3 tries** with a 2-second wait.
   - Success → **Mark sent**: status SENT, save SES's message id, mark the matches as `notified_at`.
   - Failure → **Mark failed**: attempts + 1; after **3 attempts** it becomes FAILED.
   - **Throttle 1 second** between emails, because SES's sandbox allows 1 email per second.
5. **Finish** (`c_finish.sql`): count sent / failed / pending, write them to the timeline, NOTIFYING → **DONE**.

### How duplicate emails are made impossible (not just "unlikely")

Three layers, from friendly to bulletproof:

1. **The 7-day check** in the queueing query: "skip anyone emailed recently".
2. `UNIQUE (user_id, digest_key)`: the `digest_key` is a fingerprint of the exact set of loans

   offered. The database **physically refuses** to store the same offer twice for the same person. So
    re-running Workflow C is harmless.
3. **One per person per week** (`005_notification_week_cap.sql`): a unique index on (user, IST calendar

   week). Even if two notifiers run at the *same instant* for different batches, only one email
    per person per week can be queued. (Layer 1 is a *read*, which two runners could pass at the same
    moment. A unique index can't be raced.)

### TEST MODE: why your Gmail gets the emails

The brief says: **never email addresses from the sample CSV.** So with `TEST_MODE=true`:

- every recipient is **rewritten** to one of your own aliases (`yourname+one@gmail.com`,
`+two`, `+three`); Gmail delivers all `+anything` addresses to your normal inbox
- at most `MAX_EMAILS_PER_RUN` (3) people per run

While the AWS account is in the **SES sandbox**, SES only sends to **verified** addresses, which is why
those aliases (and the sender address) had to be verified by clicking a link.

### Asking instead of guessing: Workflow D

Many offers end up "to confirm" because a lender asks for something the CSV doesn't have. On `users.csv`
that's about 57,000 offers, but they're blocked by only about **5 facts**: work experience, employer
type, an existing bank account, city and business age. So we ask the person, like a shop assistant
asking "what size are you?" instead of guessing.

1. **Plan the questions (Workflow C, `questions.js`).** One question per *fact*, not per lender: "how long
   have you been working?" settles HDFC, ICICI and IndusInd at once. At most **3 questions**, and only
   if an answer could confirm an offer good enough for the person's top 5.
2. **Ask inside the email they already get.** A signed link that expires in 14 days. No extra email.
3. **The form (Workflow D, GET `webhook/confirm`).** Shows only that person's questions, quoting each
   lender's own words as the reason.
4. **The answers (Workflow D, POST `webhook/confirm-submit`).** Sanity checks first: answers that
   contradict each other (20 years of experience at age 30) are **flagged for the ops team** and not used.
   Good answers are saved in `user_declarations`. Then the AI judge re-checks **only this person's**
   "to confirm" offers, and offers that now pass become **pre-qualified (self-declared)**. A follow-up
   email lists them.
5. **Answers are reused.** After every match run, Workflow B re-checks new "to confirm" offers of people
   who already answered, and C never asks the same question twice.

**Never "approved".** Answers are self-declared, and the lender checks documents when the person applies.
📍 `wf_d_confirm.py`, `code/questions.js`, `code/confirm.js`, `sql/d_*.sql`, `sql/b_load_answered.sql`,
`sql/b_apply_answers.sql`.

### Workflow E: the error catcher

If **any** step of A, B, C or D crashes, n8n runs **Workflow E**, which writes the failure (which workflow,
which node, the error message) into `pipeline_events`. So errors show up in the website's timeline,
not just inside n8n. 📍 `wf_error.py`, `sql/record_event.sql`.

---

## Part 9: The database: every table in plain words

All in `packages/database/migrations/001_schema.sql` (plus small additions in `002`–`008`).
**Migrations** are numbered SQL files that run in order, each only once, like save points in a game.

| Table | What one row means | Who writes it | Who reads it |
|---|---|---|---|
| `ingest_batches` | One uploaded file, with its **status** (the baton), lease, row counts and error | uploads, ingestion, Workflows B and C | everyone |
| `ingest_errors` | One problem in one cell of a file ("row 17, email, invalid") | ingestion | the website (`errors.csv`) |
| `users` | One person, identified by `user_id` | ingestion | Workflows B and C |
| `crawl_sources` | One bank page to crawl, plus its "did it change?" memory (ETag, fingerprint) | seed migrations, Workflow A | Workflow A |
| `crawl_runs` | One crawl attempt and its outcome | Workflow A | you, for debugging |
| `loan_products` | One loan with its rules, quotes (evidence), rules fingerprint | Workflow A | Workflow B, website catalogue |
| `matches` | "This person may qualify for this loan" (ELIGIBLE / LIKELY, score; `decided_by` = RULES, LLM or DECLARED) | Workflows B and D | Workflow C, website |
| `llm_judgments` | One cached AI verdict for (loan rule × bucket range) | Workflow B | Workflow B |
| `notifications` | One email to one person (PENDING / SENT / FAILED), SES message id, and which questions it asked | Workflow C | Workflow C, website |
| `user_declarations` | One person's self-declared answers (work experience, employer type…), whether they were flagged, and how many offers they confirmed | Workflow D | Workflows B, C and D, website counts |
| `suppression` | One unsubscribed/bounced email, stored as a **hash** | API (unsubscribe) | Workflow C |
| `pipeline_events` | One line in a batch's diary/timeline | everyone | the website |

**Interesting choices worth knowing:**

- **Email is NOT unique.** In the sample file, 9,771 of 10,000 rows share an email with someone else.
Identity is `user_id`.
- **Money is stored as exact numbers** (`numeric(12,2)`), never floating point, so ₹0.10 never becomes
₹0.0999999.
- **Credit score empty (NULL) = new to credit**, which is different from a bad score.
- **Empty rule = "not stated" = passes.** If a bank doesn't state a minimum income, nobody is rejected
for income.
- **Partial indexes** (indexes that cover only some rows), e.g. "un-notified matches only". They stay tiny
because most matches get notified.
- **Suppression stores a hash**, so even if a person asks us to delete their data (India's DPDP law),
we still remember "don't email this address" without keeping the address itself.

---

## Part 10: Folder tour: every file and why it exists

```
Clickpe.ai/
├── apps/          ← things you RUN (programs, website, workflows)
├── packages/      ← the Go business logic (reusable building blocks)
├── internal/      ← Go helpers for tests only
├── tests/         ← Python end-to-end tests + fixtures
├── scripts/       ← build, deploy and demo scripts
├── docs/          ← all documentation (you are here)
├── data/          ← sample CSV files
├── serverless.yml ← the list of AWS resources
├── docker-compose.yml ← what runs on the laptop (Postgres, n8n, tunnel)
└── .github/workflows/ci.yml ← automatic checks on every push
```

### The architecture rule (why `apps` vs `packages`)

- `apps/` **are thin.** They receive a request or event, call a package, and reply. No business rules
inside.
- `packages/` **hold the rules**, and each package owns its own tables and SQL.
- **Each package may only use certain other packages.** For example, `uploads` may use `batches` and
`database`, but not `ingestion`. A test (`internal/archtest`) **fails the build** if anyone breaks this.
- `internal/` **folders inside a package are private.** Go itself forbids outsiders from importing
them. That's where the AWS S3 code lives, so swapping storage providers touches one file.

---

### `apps/api/`: the HTTP backend (one Lambda for all 13 routes)

| File | What it's for |
|---|---|
| `main.go` | The **route table**: "GET /v1/products → products handler", etc. Also turns any crash (panic) into a polite "500, please retry" instead of breaking. **Why one Lambda for 13 routes?** They all need the same things (database connection, S3 client), so one warm Lambda serves all of them: one cold start instead of thirteen. |
| `handlers.go` | The 13 handlers. Each is about 4 lines: read the request → check its shape → call a package → reply. **No SQL and no business rules here, on purpose.** |
| `http.go` | The **one place** where errors become HTTP status codes (400 bad request, 404 not found, 409 conflict, 500…) in a consistent shape: `{"error": {"code", "message"}}`. |
| `main_test.go` | Tests every route against a real test database and a fake S3. |

**The 13 routes, in plain words:**

| Route | What it does | Needs API key? |
|---|---|---|
| `GET /v1/overview` | Big numbers for the home page (users, products, matches, emails) | No (aggregates only) |
| `GET /v1/uploads/schema` | The accepted columns + aliases | No |
| `GET /v1/products` | The loan catalogue | Yes |
| `GET /v1/batches` | Recent uploads (history page) | Yes |
| `POST /v1/uploads` | Start an upload session | Yes |
| `POST /v1/uploads/{id}/part-urls` | Get permission slips for parts | Yes |
| `GET /v1/uploads/{id}/parts` | "Which parts do you already have?" (for resume) | Yes |
| `POST /v1/uploads/{id}/complete` | "I'm done uploading" | Yes |
| `DELETE /v1/uploads/{id}` | Cancel an upload | Yes |
| `GET /v1/batches/{id}` | Status, timeline, counts, funnel, matches, emails | Yes |
| `GET /v1/batches/{id}/errors.csv` | Download the bad-rows report | Yes |
| `GET /v1/unsubscribe` | The "are you sure?" unsubscribe page | No (the token is the proof) |
| `POST /v1/unsubscribe` | Actually unsubscribe | No (the token is the proof) |

### `apps/ingest_worker/`: the SQS-triggered Lambda

| File | What it's for |
|---|---|
| `main.go` | Receives SQS messages, pulls out "which file in S3", calls `ingestion.Run`. Uses **partial batch responses**: if one of several messages fails, only that one is retried. |
| `main_test.go` | Tests message handling, including duplicates and bad messages. |

### `apps/ingest_local/`: the same thing without AWS

| File | What it's for |
|---|---|
| `main.go` | Runs the **exact same** ingestion on a local file, then rings the doorbell. Used for local demos and by the Python tests. Example: `ingest_local data/demo_users.csv`. |

### `apps/migrate/`: set up the database

| File | What it's for |
|---|---|
| `main.go` | Applies the numbered migrations to whatever database `DATABASE_URL` points to (local or RDS). |

### `apps/web/`: the website (Next.js, static export)

**Pages** (`src/app/`), one per screen:

| File | Screen |
|---|---|
| `page.tsx` + `landing.module.css` | Home page: what the product does, live numbers, recent uploads |
| `upload/page.tsx` | The upload screen |
| `batch/page.tsx` | One upload's live progress |
| `history/page.tsx` | All past uploads |
| `catalogue/page.tsx` | All loan products found by the crawler |
| `not-found.tsx` | The 404 page |
| `layout.tsx`, `globals.css` | The shared frame (nav, footer) and global styles |

**Components** (`src/components/`), the building blocks of screens:

| File | What it's for |
|---|---|
| `ApiProvider.tsx` | Holds the API key and the API client for the whole app. If any call says "unauthorised", it opens the key dialog instead of showing a broken page. |
| `ApiKeyDialog.tsx` | The "paste your API key" pop-up |
| `upload/UploadFlow.tsx` | The upload journey: 1 choose → 2 check columns → 3 upload → go to batch page |
| `upload/DropZone.tsx` | Drag-and-drop file box |
| `upload/ColumnCheck.tsx` | Shows which columns were found / missing before upload |
| `upload/FormatGuide.tsx` | "What should my file look like?" help, generated from the server's column list |
| `batch/BatchDetail.tsx` | Everything about one upload, polling until finished |
| `PipelineStepper.tsx` | The Upload → Validate → Match → Notify progress bar |
| `MatchFunnel.tsx` | The Treasure Hunt funnel chart (how many survived each filter) |
| `BatchTable.tsx`, `History.tsx` | Upload history list |
| `Catalogue.tsx` | Loan product cards, with the evidence quotes |
| `landing/LiveStats.tsx`, `RecentUploads.tsx`, `ConsoleMockup.tsx` | Home page sections |
| `Nav.tsx`, `Footer.tsx`, `SetupNotice.tsx`, `ui.tsx` | Navigation, footer, "configure me" notice, small shared UI bits |

**Logic** (`src/lib/` and `src/hooks/`), pure and tested, no screens:

| File | What it's for |
|---|---|
| `lib/api/client.ts` | **The only file that talks to the backend.** Every API call is a typed function here. |
| `lib/api/types.ts` | The shapes of data the API returns (Batch, Product, …) |
| `lib/upload/multipart.ts` | ⭐ The upload engine: split, fingerprint, presign, parallel PUT, retry with backoff, resume |
| `lib/csv/inspect.ts` | Pre-upload column check from the first 64 KB |
| `lib/pipeline.ts` | Turns statuses and events into friendly words and stepper positions |
| `lib/format.ts` | Indian number formatting (₹1,20,000), dates, durations |
| `lib/config.ts` | The one place build-time settings (the API URL) are read |
| `hooks/usePolling.ts` | "Ask every 1 s, slowing to 5 s, until finished" |
| `hooks/useLoad.ts` | Load data once, with loading/error states |
| `*.test.ts` | Unit tests for the logic above |

### `apps/workflows/`: the n8n workflows

**Why are n8n workflows built from Python?** n8n stores workflows as big JSON files. Editing JSON by hand
is error-prone and impossible to test. So:

- `src/code/*.js` = the JavaScript brains of the Code nodes, **unit-tested** on their own
- `src/sql/*.sql` = every SQL query n8n runs, **tested against the real schema**
- `src/workflows/*.py` = the **shape** of each workflow (which nodes, how they connect)
- `build.py` glues them into `dist/*.json`, the files n8n actually imports. **Never edit**
`dist/` **by hand**; CI fails if it's out of date.

| File | What it's for |
|---|---|
| `build.py` | Generates `dist/A_crawl.json`, `B_match.json`, `C_notify.json`, `D_confirm.json`, `E_errors.json` |
| `src/workflows/nodes.py` | Small helpers to create n8n nodes in Python (`w.postgres(...)`, `w.code(...)`, `w.chain(...)`) and embed the JS/SQL files |
| `src/workflows/wf_a_crawl.py` | Workflow A's graph (crawler) |
| `src/workflows/wf_b_match.py` | Workflow B's graph (matcher) |
| `src/workflows/wf_c_notify.py` | Workflow C's graph (notifier) |
| `src/workflows/wf_d_confirm.py` | Workflow D's graph (the confirmation form: two webhooks) |
| `src/workflows/wf_error.py` | Workflow E's graph (error catcher) |
| `src/code/crawl.js` | `htmlToText` (HTML → plain text), `relevantSection` (keep only eligibility lines), `validateProducts` (the verbatim-quote rule), `sha256` |
| `src/code/llm.js` | `extractionRequest` (ask the AI to read a page), `judgmentRequest` (ask about soft rules), `parseJsonContent` (safely read the AI's JSON, even with extra "thinking" text or ```json fences), `parseJudgments` |
| `src/code/matcher.js` | `buildCuts` (thresholds → cut points), `attributeMasks` (prepare the switches), `matchClasses` (AND them per class + soft rules), `cacheKey`, `score` |
| `src/code/email.js` | `renderEmail` (build the HTML + text email), `reasons` ("why you qualify"), `formatINR`, `escapeHtml`, `unsubscribeToken` |
| `src/code/questions.js` | The question planner (`planQuestions`, `planForClasses`) and the signed form link (`confirmToken`, `verifyConfirmToken`, `confirmLink`) |
| `src/code/confirm.js` | Workflow D's brain: the form and result pages, reading and sanity-checking answers, building AI judge items, deciding unlock / narrow / reject (`decide`, and `batchJudgeItems` / `batchDecide` for B) |
| `src/code/signature.js` | `verifyDoorbell`: check the HMAC seal and the 5-minute window |
| `src/sql/a_load_sources.sql`, `a_save_products.sql`, `a_save_page_state.sql` | Crawler: read pages to visit, save products, remember page state |
| `src/sql/b_find_stalled.sql` | Sweeper: find a forgotten or crashed batch |
| `src/sql/b_claim_batch.sql` | LOADED → MATCHING with a 15-minute lease |
| `src/sql/b_load_products.sql`, `b_load_classes.sql` | Load loans; group users into classes |
| `src/sql/b_lookup_judgments.sql`, `b_save_judgments.sql` | AI answer cache |
| `src/sql/b_save_matches.sql` | Expand classes → users, save matches, MATCHED |
| `src/sql/c_claim_batch.sql` | MATCHED → NOTIFYING |
| `src/sql/c_queue_notifications.sql` | Decide who gets an email (all the rules in Part 8) |
| `src/sql/c_load_pending.sql` | Load everything needed to write each email |
| `src/sql/c_mark_sent.sql`, `c_mark_failed.sql` | Record each send result |
| `src/sql/c_finish.sql` | Count results, → DONE |
| `src/sql/b_load_answered.sql`, `b_apply_answers.sql` | After matching: re-check people who already answered, with their stored answers |
| `src/sql/d_load_person.sql`, `d_save_declaration.sql`, `d_apply_decisions.sql`, `d_mark_notified.sql` | Workflow D: load one person, save answers, apply the re-check, mark the follow-up email sent |
| `src/sql/record_event.sql` | Write a timeline line (used by Workflow E) |
| `docker/init.sh` | When the n8n container starts: import credentials + the 5 workflows and switch them on |
| `docker/make_credentials.js` | Builds n8n's credential entries (Postgres, AWS, LLM) from environment variables |
| `docker/create_databases.sql` | Creates n8n's own database and the app database on first boot |
| `tests/*.test.js` | Unit tests for crawl, email, matcher, LLM parsing, questions and confirm |
| `tests/run_module.js` | Lets Python tests call the JS modules |
| `tests/test_workflows.py` | Checks the generated workflows are wired correctly |

### `packages/`: the Go business logic

| Package | Its one job | Main functions (plain words) |
|---|---|---|
| `database` | Connections, transactions, migrations. Knows nothing about loans. | `Open`/`Shared` (connect), `InTx` (run something all-or-nothing), `Migrate` (apply SQL files) |
| `batches` | The batch lifecycle (the baton) | `Create`, `Get`, `Transition` (CAS), `Claim` (CAS + lease), `RecordEvent` (diary line), `Timeline`, `Recent` |
| `uploads` | Upload sessions: permission, never bytes | `CreateSession`, `PresignParts`, `ListParts`, `Complete`, `Abort` |
| `uploads/internal/s3store` | The only upload code that knows S3 exists | `Start`, `PresignPart`, `Parts`, `Finish`, `Cancel` |
| `ingestion` | CSV → clean users | `Run` (from S3), `RunReader` (from any file); inside: decode, rows, normalize, validate, merge; `ErrorReportCSV`, `ErrorPreview`; `Columns` (the accepted format) |
| `ingestion/internal/s3reader` | The only ingestion code that knows S3 exists | `Open` (stream a file) |
| `orchestration` | Ring n8n's doorbell | `Sign` (make the HMAC seal), `TriggerMatching` (send it; never errors, because the sweeper is the backup) |
| `notifications` | The unsubscribe side of email | `MakeToken`, `VerifyToken`, `Unsubscribe` |
| `reporting` | Read-only numbers for the screens. Never writes. | `GetOverview`, `Products`, `GetBatchSummary` |

Every package also has a `keys.go`: **the one place that package reads its settings** from environment
variables (bucket name, part size, limits, secrets), with sensible defaults.

### `internal/`: test helpers

| File | What it's for |
|---|---|
| `testdb/testdb.go` | Gives **each test its own fresh, migrated database** (and deletes it after). Refuses to run unless the database name ends in `_test`, so you can never wipe a real database by accident. |
| `archtest/archtest_test.go` | Reads every Go file's imports and **fails if a package uses something it's not allowed to** (the architecture rule). |

### `tests/`: Python end-to-end harness

| File | What it's for |
|---|---|
| `conftest.py` (repo root) | Builds the Go programs, resets the test database, and gives tests helpers to run n8n's SQL and JS |
| `tests/e2e/test_full_pipeline.py` | The whole story: ingest a CSV → match → queue emails, checked against the oracle |
| `tests/e2e/test_matching_pipeline.py` | Matching edge cases (new-to-credit, age limits, job types, soft rules) |
| `tests/e2e/test_notification_sql.py` | Who gets emailed: consent, suppression, 7-day cap, test mode, no duplicates |
| `tests/e2e/test_crawl_sql.py` | The crawler's SQL: saving products, keeping old data on failure |
| `tests/e2e/test_concurrency.py` | Two workers at once: only one wins each claim |
| `tests/oracle/brute_force.py` | The slow-but-obviously-right matcher used as the answer key |
| `tests/fixtures/html/*.html.gz` | Saved real bank pages (HDFC, ICICI, Kotak), so crawler tests don't need the internet |
| `tests/fixtures/llm/*.json` | Saved real AI answers for those pages |

### `scripts/`

| File | What it's for |
|---|---|
| `build_lambdas.sh` | Compiles the Go Lambdas into small Linux/ARM files named `bootstrap` and zips them |
| `deploy_all.sh` | **The one command** that deploys everything (see Part 14) |
| `deploy_web.sh` | Builds the website pointed at the live API and uploads it to S3 |
| `deploy_amplify.sh` | Publishes the same website to **AWS Amplify** (HTTPS + short URL) |
| `smoke_aws.py` | A live test against AWS: a tampered part is rejected, and an upload reaches DONE |
| `make_demo_csv.py` | Generates a CSV of fresh fake users for demos |
| `eval_extraction.py` | Measures how accurate the AI extraction is on the saved bank pages |

### Root files

| File | What it's for |
|---|---|
| `serverless.yml` | The **list of everything on AWS**: API Gateway (+ key, rate limits), 2 Lambdas, S3 upload bucket (+ lifecycle rule to delete abandoned uploads), SQS + DLQ + alarm, RDS Postgres, website bucket, optional CloudFront |
| `docker-compose.yml` | What runs on the laptop: **Postgres**, **n8n**, and a **tunnel** (Cloudflare or ngrok). Optional "queue mode" adds Redis + an n8n worker for scaling. |
| `.env.example` | Every setting the system needs, with blank values. Copy it to `.env` (which is never committed). |
| `go.mod`, `go.sum` | Go's list of libraries and their exact versions |
| `pyproject.toml` | Python test tools (pytest, ruff, psycopg) |
| `.gitleaks.toml` | Secret-scanner settings (ignores the fake secrets in tests) |
| `.github/workflows/ci.yml` | The automatic checks (see Part 13) |
| `task.md` | The original assignment brief |
| `README.md` | Setup and run instructions |

### `docs/`: the other documents

| File | Read it when you want… |
|---|---|
| `PROJECT-GUIDE.md` | …the friendly full story (this file) |
| `SYSTEM-FLOW.md` | …the one Mermaid diagram of the whole flow |
| `EXPLAINED.md` | …another plain-English walkthrough, feature by feature |
| `DESIGN.md` | …the formal system design (requirements, capacity, failure analysis, trade-offs) |
| `REQUIREMENTS.md` | …the brief mapped line by line to where it's implemented |
| `REPO-ARCHITECTURE.md` | …why the folders and package rules are the way they are |
| `OPTIMIZATION.md` | …the measured speed numbers (ingest, matching) |
| `SCALE.md` | …what changes at 10× / 100× / 1000× the load |
| `GO-GUIDE.md`, `N8N-GUIDE.md` | …a beginner's guide to the Go code or the n8n workflows |
| `ISSUES.md` | …real bugs we hit and how we fixed them (great interview stories) |
| `ui-design.md` | …the website's design decisions |

---

## Part 11: When things go wrong: the safety nets

Interviewers love "what if X fails?". Here's the full list:

| What goes wrong | What happens | Why nothing is lost |
|---|---|---|
| Wi-Fi drops during upload | Pick the same file again and it resumes; only missing parts are sent | Parts already in S3 are listed and skipped |
| A byte gets corrupted or tampered in transit | S3 rejects that part (400) | The SHA-256 fingerprint is baked into the permission slip |
| Someone uploads a 5 GB file | Refused at session start and again at completion | Size cap (200 MB) checked twice |
| Upload abandoned halfway | S3 deletes the orphan parts after a few days | Bucket lifecycle rule |
| S3 sends the "file arrived" note twice | The second worker's claim fails, so it stops | Compare-and-set on the batch status |
| Ingest Lambda crashes mid-file | Nothing is half-saved; SQS retries; the lease expires so the retry can claim it | One transaction; lease |
| Ingest keeps failing | After 3 tries → DLQ + alarm | SQS redrive policy |
| The file is mostly garbage | Nothing saved; batch FAILED with a clear reason + error report | 20% circuit breaker |
| A zip bomb (tiny file that unzips to terabytes) | Stops at 2 GB decompressed | Decompression cap |
| Doorbell fails (n8n down, tunnel changed) | Sweeper starts matching within ~2 minutes | Database is the source of truth |
| Doorbell and sweeper both fire | Only one claim succeeds | CAS |
| n8n crashes during matching | 15-minute lease expires → sweeper reclaims | Lease |
| Workflow B runs twice for a batch | Same matches upserted; nobody re-emailed | `notified_at` is kept; UNIQUE rules |
| The AI is slow or down (crawler) | Retries; then keeps yesterday's products | Failure never deletes good data |
| The AI invents a number | Thrown away | Verbatim-quote validation |
| A bank page hides instructions for the AI | Can't create rules without real quotes on the page | Same validation |
| SES rejects an email | 3 tries; then marked FAILED, the others carry on | Per-email error branch |
| Two notifiers race for the same person | Only one email queued | Unique index per person per week |
| Any workflow crashes | The error appears in the website's timeline | Workflow E |
| Someone forges a doorbell | Rejected | HMAC + 5-minute window |
| Someone forges an unsubscribe link | Rejected | Signed token |

> 🧠 **The two big ideas behind this table:**
>
> 1. **At-least-once delivery + idempotent steps = effectively once.** Messages may arrive twice;
>
>    every step is safe to run twice.
> 2. **The database is the source of truth.** Messages and doorbells only make things faster.

---

## Part 12: Security in plain words

- **API key + rate limits** on API Gateway, so strangers can't flood the API.
- **File bytes never pass through our servers**, and upload permission slips expire after 1 hour and
cover exactly one part with exactly one fingerprint.
- **Least privilege:** the Lambdas can only touch the `uploads/` folder of our own bucket.
- **Secrets live in AWS SSM Parameter Store** (encrypted), not in code. `.env` is never committed, and
CI scans every commit for leaked secrets (gitleaks).
- **Database over TLS** (`sslmode=require`) with a strong random password.
- **Signed doorbell** (HMAC) and **signed unsubscribe tokens**.
- **No personal data goes to the AI.** It sees bucket ranges, never people.
- **AI output is distrusted by default:** every number needs a verbatim quote.
- **Email safety:** names are HTML-escaped; no personal data in links; TEST_MODE stops real customers
from being emailed during testing.
- **Privacy:** the unsubscribe list stores hashes, so "don't email" survives a data-deletion request.
- **Honest limitation:** for the demo, RDS is reachable from the internet (TLS + password only), because
Lambdas outside a private network have changing IP addresses. In production: private subnets + RDS Proxy.

---

## Part 13: How we prove it works: tests and CI

### The layers of testing

| Layer | What it checks | How to run |
|---|---|---|
| Go unit + integration tests | Every package, on a **real Postgres** (each test gets its own database) | `go test ./...` |
| Architecture test | Packages only import what they're allowed to | part of `go test` |
| JS unit tests | Crawler, matcher, email, AI parsing, signature | `node --test apps/workflows/tests/*.test.js` |
| Python end-to-end harness | Go ingest + n8n's exact SQL + JS, together, vs the brute-force oracle | `.venv/bin/pytest` |
| Web tests | Upload engine, CSV check, formatting, pipeline words | `cd apps/web && npm test` |
| Extraction eval | AI accuracy on saved real bank pages | `scripts/eval_extraction.py` |
| Live smoke test | The real AWS deployment, end to end | `scripts/smoke_aws.py` |

**Why test against a real Postgres instead of a fake?** The tricky parts (COPY, ON CONFLICT, advisory
locks, enum types) are exactly where fake databases behave differently from the real one.

### CI: the automatic checklist on every push (`.github/workflows/ci.yml`)

Six jobs run **in parallel** on GitHub's computers, then one final job:

| Job | Checks |
|---|---|
| Secret scan | No passwords or keys anywhere in the full git history |
| Go backend | Formatting (`gofmt`), common mistakes (`go vet`), all tests with the **race detector**, and building the Lambda files |
| Python harness | Lint (`ruff`) + the full end-to-end tests on a real Postgres |
| n8n workflows | JS tests + "is `dist/` up to date with its sources?" |
| Web console | Tests, type-check, full static build, every page exists |
| Deploy scripts | `shellcheck` (finds bugs in shell scripts) |
| **Deploy ready** | Turns green **only if all six pass**. That's the signal it's safe to deploy. |

---

## Part 14: How it gets onto AWS: deployment

### What "deploying" means here

Nothing is pulled from GitHub. The laptop **builds** everything and **uploads only the results**:

- Go code → compiled `bootstrap` files → zipped → Lambda
- Website → built HTML/JS/CSS → S3 and Amplify
- `serverless.yml` → turned into a CloudFormation template → AWS creates or updates every resource

### The one command: `bash scripts/deploy_all.sh` (7 steps, safe to re-run)

1. **Secrets → SSM** (the database password is created once; the webhook and unsubscribe secrets are

   copied from `.env`).
2. **Tunnel to n8n:** if `NGROK_DOMAIN` is set, use the **permanent** ngrok address; otherwise start a

   Cloudflare quick tunnel (whose address changes on every restart). Write the address into `.env`.
3. **Build the Go Lambdas** (`build_lambdas.sh`).
4. `serverless deploy`: create or update API Gateway, Lambdas, S3, SQS, RDS and so on in **ap-south-1

   (Mumbai)**.
5. **Run database migrations on RDS.**
6. **Point n8n at RDS**, restart it, and **run the crawler** once so loans exist.
7. **Publish the website** to S3 and **AWS Amplify**, and save the API key to `build/api-key.txt`.

### Where things live after deployment

| Thing | Where |
|---|---|
| Website | AWS Amplify (`https://main.<id>.amplifyapp.com`) and an S3 website as backup |
| API | API Gateway (`https://<id>.execute-api.ap-south-1.amazonaws.com/dev`) |
| Lambdas | `api` (256 MB, 29 s) and `ingest` (1024 MB, 15 min), on ARM (Graviton, ~20% cheaper) |
| Database | RDS PostgreSQL `db.t4g.micro` |
| n8n | Docker on the laptop, reached through the tunnel |
| Emails | SES (sandbox → verified addresses only) |

**Why CloudFront isn't used (yet):** new AWS accounts must be verified before using CloudFront. The
template supports it (`CDN=true`), and Amplify gives HTTPS + a short URL meanwhile.

**Why Gemini and not AWS Bedrock:** the new AWS account had a Bedrock quota of 0 that couldn't be raised.
The code speaks the standard "OpenAI-compatible" API, so switching AI provider is just changing
`LLM_BASE_URL`, `LLM_MODEL` and the key. No code changes.

**To delete everything on AWS:** `npx serverless@3 remove`.

---

## Part 15: Numbers worth remembering

| Number | What it is |
|---|---|
| **8 MB** | Upload part size (1 GB = 128 parts) |
| **4** | Parts uploaded in parallel |
| **200 MB** | Default max upload size |
| **1 hour** | Lifetime of a part's permission slip |
| **10 MB / 29 s** | API Gateway's limits, the reason uploads go straight to S3 |
| **10 / 20 / 20,000** | API rate limit per second / burst / per day |
| **5** | Max ingest Lambdas running at once |
| **3** | Ingest tries before the DLQ; email tries before FAILED |
| **20%** | Bad-row share that fails the whole file |
| **2 GB** | Zip-bomb cap |
| **~6 s** | Ingest time for 1 million rows |
| **2 min / 1 min** | Sweeper interval / grace period before it acts |
| **15 min** | Matcher lease |
| **5 min** | Doorbell signature validity |
| **10,000 → hundreds** | Users → classes in the sample file |
| **2:00 AM IST** | Daily crawl |
| **1 req/s** | Crawler politeness; also SES sandbox send rate |
| **4 at a time, 2 s gap** | AI call pacing in the crawler |
| **15** | Lenders crawled |
| **5** | Max loan cards per email |
| **7 days / 1 per week** | Email frequency caps |
| **90 days** | Unsubscribe token lifetime |
| **100 − 2×rate − 5×unverified** | Match score |
| **9,771 of 10,000** | Sample rows sharing an email (why email isn't unique) |

---

## Part 16: Glossary: every word, explained simply

**Advisory lock:** a "do not disturb" sign in Postgres that our own code agrees to respect. We use it so
only one merge into `users` runs at a time.

**Alias (column):** another accepted name for a column ("salary" for `monthly_income`).

**Alias (email):** `you+one@gmail.com` goes to `you@gmail.com`. Used for test emails.

**Amplify (AWS Amplify Hosting):** AWS's service for hosting websites, with HTTPS and a short URL.

**API (Application Programming Interface):** a list of addresses a program can call to ask for things
or to do things.

**API Gateway:** AWS's front door for APIs. Checks keys, applies rate limits, forwards to Lambda.

**API key:** a password-like string the website sends with each request.

**ARM / Graviton / arm64:** a type of processor. On AWS it's cheaper per unit of work than Intel/AMD (x86).

**At-least-once delivery:** the system promises a message arrives *at least* once, so sometimes twice.
That's why every step must be idempotent.

**Atomic:** happens completely or not at all; nobody can see it half-done.

**Backoff (exponential) + jitter:** after a failure, wait 0.5 s, then 1 s, 2 s, 4 s… plus a random
wobble so many clients don't retry at the same instant.

**Batch:** one uploaded file and everything that happens to it. One row in `ingest_batches`.

**BigInt:** JavaScript numbers with no size limit. Used for bitsets with any number of loans.

**Bitset / bitmask:** a row of on/off switches stored as one number; "AND"-ing two rows keeps the
switches that are on in both.

**BOM (Byte Order Mark):** an invisible character Excel puts at the start of some CSV files. We strip it.

**Bucket (S3):** a top-level storage folder in S3.

**Bucket (matching):** a range of values ("income ₹25k–₹40k") that users are sorted into.

**Cache:** saved answers, so you don't redo expensive work. Our AI answers are cached.

**CAS (compare-and-set):** "change it to B only if it's still A", in one step. Our relay-baton trick.

**CDN / CloudFront:** servers around the world that keep copies of the website close to visitors.

**CI (Continuous Integration):** automatic checks that run every time code is pushed.

**Circuit breaker:** stop early when too much is going wrong (more than 20% bad rows → save nothing).

**Class (matching):** a group of users who fall in the same buckets on every attribute, so every loan
treats them the same.

**CloudFormation:** AWS's tool that creates resources from a template. Serverless Framework writes this
template for us.

**CloudWatch:** AWS's logs, metrics and alarms.

**Cold start:** the delay when Lambda starts a fresh copy of your program. Go starts fast; one Lambda for
all routes means fewer cold starts.

**Compose / Docker Compose:** a file describing several containers that run together (Postgres, n8n,
tunnel).

**Container / Docker:** a packaged, isolated mini-computer for running a program the same way everywhere.

**Coordinate compression:** replacing exact values with "which interval between thresholds" (the
T-shirt sizes idea).

**COPY (Postgres):** the fastest way to load many rows at once.

**CORS:** browser rule about which websites may call an API. Our API allows the console's calls.

**Credential:** a username/password/key that lets one system use another (n8n's SES credential, etc.).

**Criteria hash:** a fingerprint of a loan's rules. If it changes, old AI answers for that loan stop
matching.

**Cron / schedule trigger:** "run this at these times" (Workflow A at 2 AM; the sweeper every 2 minutes).

**CSV:** a spreadsheet saved as plain text, values separated by commas.

**Digest key:** a fingerprint of the set of loans offered to a person. Same offer → same key → no
duplicate email.

**DLQ (Dead-Letter Queue):** the "problem tray" for messages that failed too many times.

**DPDP:** India's Digital Personal Data Protection Act.

**ELIGIBLE vs LIKELY:** ELIGIBLE = every rule checked and passed. LIKELY = passed everything we could
check, but some rules need info we don't have.

**Enum:** a column that only allows a fixed list of values (e.g. Salaried / Self-Employed / Business).

**Environment variable /** `.env`**:** settings given to a program from outside its code.

**ETag / If-None-Match / 304:** a web page's version tag. We send it back and the server answers
"304 Not Modified" if nothing changed.

**Event-driven:** things happen in reaction to events ("a file arrived") rather than someone waiting
and asking.

**Evidence:** the word-for-word quotes from a bank page that back up each extracted number.

**Fixture:** saved sample data used by tests (saved bank pages, saved AI answers).

**Funnel:** the counts at each filtering stage (users → pairs → after rules → matches), showing how much
work was avoided.

**Handler:** the function that answers one API route.

**Hash / SHA-256 / fingerprint:** a short code calculated from data; any change to the data changes
the code completely. It can't be reversed.

**HMAC:** a hash mixed with a secret key, a "wax seal" only someone with the secret can make.

**Idempotent:** doing it twice has the same effect as doing it once.

**IaC (Infrastructure as Code):** describing servers and services in a file (`serverless.yml`)
instead of clicking around a console.

**Index (database):** a lookup structure that makes searches fast, like a book's index.
**Partial index:** covers only some rows. **Unique index:** forbids duplicates.

**Ingest / ingestion:** reading, cleaning, checking and saving incoming data.

**Lambda:** AWS runs your code only when needed, and you pay per millisecond. No servers to manage.

**Lease:** "I own this until time T". If the owner disappears, the lease runs out and someone else can
take over.

**Lifecycle rule (S3):** automatic clean-up, e.g. delete unfinished uploads after a few days.

**LLM (Large Language Model):** an AI that reads and writes text (Gemini here).

**Merge (upsert):** insert new rows and update changed ones in one operation.

**Migration:** a numbered SQL file that changes the database schema; each runs once, in order.

**Multipart upload:** sending a big file as numbered pieces that S3 joins at the end.

**n8n:** a visual workflow automation tool (boxes connected by arrows). We self-host it in Docker.

**n8n node:** one box in a workflow (HTTP request, Postgres query, Code, SES send, Wait, If…).

**Next.js / static export:** a React website framework; "static export" means it's turned into plain
files that need no server.

**NTC (New To Credit):** someone with no credit history (empty credit score).

**Oracle (testing):** a slow but obviously correct implementation used as the answer key.

**Polling:** asking "any news?" repeatedly.

**Presigned URL:** a temporary link that grants permission to do one specific thing (upload one part).

**Prompt injection:** hidden text on a web page trying to trick the AI. Defeated by verbatim-quote
validation.

**Queue (SQS):** a waiting line of messages that workers take from.

**Race condition:** a bug when two things happen at the same time and the result depends on who's first.
CAS and unique indexes prevent these.

**Rate limit / throttle:** a maximum number of requests allowed per second.

**RDS:** AWS's managed database service (ours runs PostgreSQL).

**Region (ap-south-1):** the AWS data-centre location. Ours is Mumbai.

**S3:** AWS's file storage.

**Sandbox (SES):** a new SES account's safe mode: only verified addresses, 1 email per second.

**Schema:** the structure of the database (tables, columns, rules).

**Serverless Framework:** the tool that deploys `serverless.yml` to AWS.

**SES:** AWS's email-sending service.

**Smoke test:** a quick "does it basically work?" check on a real deployment.

**Soft rule:** a loan condition that isn't a simple number check ("salaried with 2 years' experience").

**SQS:** AWS's message queue service.

**SSM Parameter Store:** AWS's encrypted storage for secrets and settings.

**Staging table:** a temporary table where data lands before being merged into the real table.

**Status / state machine:** the fixed list of statuses and the allowed moves between them.

**Suppression list:** emails we must never send to (unsubscribed, bounced).

**Sweeper:** a timer job that finds work the fast path missed.

**Test mode:** recipients are rewritten to your own test aliases.

**Timeline / pipeline_events:** the batch's diary, shown on the website.

**Transaction:** a group of database changes that all happen or none happen.

**TLS / HTTPS:** encryption for data travelling over the network.

**Tunnel (Cloudflare / ngrok):** a public web address that forwards to a program on your laptop.

**Verbatim:** word for word, exactly.

**Webhook / doorbell:** a web address one system calls to tell another "something happened".

**width_bucket:** a Postgres function: "which interval between these cut points does this value fall in?"

**Workflow A / B / C / E:** crawl / match / notify / error-catcher.

---

## Part 17: Practice interview questions (with simple answers)

**Q: Walk me through what happens when I upload a CSV.**
A: The browser checks the columns, asks the API for an upload session, and sends 8 MB parts straight to S3,
each with a SHA-256 checksum that S3 enforces. On complete, the API verifies all parts and the size. S3
emits an event to SQS, which triggers the ingest Lambda. It claims the batch, streams and cleans the file,
COPYs good rows into staging, merges them into `users` in one transaction, marks the batch LOADED and rings
n8n's signed webhook. Workflow B matches and saves to `matches`, then calls Workflow C, which queues and
sends emails via SES and marks the batch DONE. The website polls the timeline the whole time.

**Q: Why not upload the file through the API?**
A: API Gateway caps requests at 10 MB and 29 seconds. Direct-to-S3 multipart has no such limit, is
resumable per part, and file bytes never touch our servers.

**Q: How do you stop corrupted uploads?**
A: Each part's SHA-256 is signed into its presigned URL, so S3 rejects any part whose bytes differ. Then
complete checks every part number exists and the total size matches.

**Q: What if the same S3 event arrives twice?**
A: The ingest worker claims the batch with compare-and-set. The second delivery finds it no longer
CREATED/UPLOADED and exits. Same for matching and notifying.

**Q: What if the webhook to n8n fails?**
A: Nothing is lost. The batch is LOADED in the database, and a sweeper every 2 minutes picks up LOADED
batches older than 1 minute, plus MATCHING batches whose 15-minute lease expired.

**Q: Explain the Treasure Hunt.**
A: Stage 1: SQL groups users into classes using the products' thresholds as cut points (`width_bucket` +
`GROUP BY`), so thousands of users become hundreds of classes. Stage 2: per class, eligibility is an AND of
precomputed bitmasks per attribute. Stage 3: only soft rules about data we actually have go to the LLM, as
anonymous bucket ranges, cached by product + rules version + rule + projected features. Rules needing data
we don't have make the match LIKELY instead of guessing. A brute-force oracle test proves the results
match exactly.

**Q: How many LLM calls does matching 1 million new users cost?**
A: Usually zero new ones. The cache key depends on buckets, not people, so new users fall into buckets
that were already judged. LLM cost grows with rule variety, not user count.

**Q: How do you stop the LLM from making things up?**
A: For every number it extracts, it must provide a quote that appears verbatim on the page and contains
that number. Otherwise the number is dropped. That also defeats prompt injection from the crawled page.

**Q: How do you handle website layout changes?**
A: We don't depend on HTML structure. We take visible text, keep windows around eligibility keywords, and
fingerprint that text. A redesign doesn't break extraction, and if extraction comes back empty we keep
yesterday's products.

**Q: How do you avoid duplicate emails?**
A: Three layers: a 7-day "recently emailed" check; `UNIQUE(user_id, digest_key)`, so the same offer can't
be queued twice; and a unique index of one live notification per person per IST week, which can't be raced
by two notifiers. Plus matches keep `notified_at`, so re-matching doesn't re-notify.

**Q: How do you make sure you never email real people from the sample file?**
A: TEST_MODE rewrites every recipient to my own Gmail +aliases and caps the number per run. The SES
sandbox also only allows verified addresses.

**Q: Why Go?**
A: Fast streaming CSV parsing and COPY, small static binaries, and quick Lambda cold starts. We measured
it (`docs/DESIGN.md §9.15`): 1M rows ingest in about 6 seconds.

**Q: Why is all the matching logic in n8n and not in Go?**
A: The brief requires core business logic to be orchestrated in n8n. We keep n8n's JS and SQL in
separate, tested files and generate the workflow JSON, so it's still testable code.

**Q: Why one Lambda for all API routes?**
A: All routes share the same dependencies, so one warm container serves them all: one cold start
instead of thirteen.

**Q: Why serialise the merges into** `users`**?**
A: Measured on 1M rows, parallel merges weren't faster (Postgres funnels writes through one log), and
serialising removes deadlocks and duplicate-key races between uploads touching the same people.
Parsing and COPY still run in parallel.

**Q: What would you change for real production?**
A: Host n8n on a server with a fixed address (or n8n queue mode with workers), put RDS in private subnets
behind RDS Proxy, add CloudFront, move SES out of the sandbox with SPF/DKIM/DMARC, and add a retry
sweeper for notifications left PENDING after their batch finished.

**Q: What's a weakness you know about?**
A: Notifications still PENDING after a batch reaches DONE have no automatic retry sweeper yet. n8n
depends on a laptop and a tunnel. The demo RDS is publicly reachable (TLS + strong password only).

**Q: Tell me about a bug you fixed.**
A: (See `docs/ISSUES.md`.) Uploads sat at "Queued for matching" for 2 minutes. The Lambda log showed the
doorbell calling an old tunnel address, because restarting the tunnel container kept old log lines and the
script read the stale address. Fix: recreate the container, then move to a permanent ngrok domain. The
design itself worked: the sweeper picked everything up, and nothing was lost.

---

## Part 18: One-page cheat sheet

```
UPLOAD   browser checks columns → session → 8 MB parts + SHA-256 → straight to S3 → complete (verify)
EVENT    S3 → SQS (≤5 at once, 3 tries → DLQ + alarm)
INGEST   claim (CAS) → stream → decode → aliases → normalise → validate → COPY → >20% bad? FAIL
         → merge (one tx, serialised) → LOADED → errors.csv → 🔔 signed doorbell
MATCH    webhook OR sweeper(2 min) → claim (CAS + 15-min lease)
         → classes (width_bucket + GROUP BY) → bitmask AND → soft rules: unknown data = LIKELY,
           known data = LLM on bucket ranges, cached → save matches (expand in SQL) → MATCHED → call C
NOTIFY   claim → queue (consent, suppression, 7-day, 1/week, UNIQUE digest, TEST_MODE aliases)
         → render (≤5 cards, why-you-qualify, unsubscribe) → SES 1/s, 3 tries → sent/failed → DONE
CRAWL    2 AM daily → 304? skip → keyword text → same hash? skip → LLM → verbatim-quote check → save
ERRORS   Workflow E → timeline

BIG IDEAS  1. Status baton with compare-and-set   2. Database = source of truth; doorbell = speed-up
           3. At-least-once + idempotent = once    4. AI compiles rules, never judges people
           5. Distrust AI output: quotes or it's dropped   6. Duplicates impossible by UNIQUE, not by hope
```

**The 6 files to know cold:**

1. `packages/database/migrations/001_schema.sql`: what data exists
2. `apps/web/src/lib/upload/multipart.ts`: how a file gets to S3 safely
3. `packages/batches/batches.go`: the status baton
4. `packages/ingestion/pipeline.go` + `repository.go`: CSV → users, fast and safe
5. `apps/workflows/src/code/matcher.js` + `src/sql/b_load_classes.sql`: the Treasure Hunt
6. `apps/workflows/src/sql/c_queue_notifications.sql`: who gets an email, and why never twice

You now know this project. Everything else is detail. 🎉
