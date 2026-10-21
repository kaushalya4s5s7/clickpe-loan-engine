# Component-by-Component Optimization

> Method: **characterize the workload first** (read/write ratio, access pattern, size, frequency), **then** pick the optimization.
> An optimization that doesn't target the actual bottleneck is just complexity. Amdahl's law: speeding up a step that takes 2% of the time saves at most 2%.
> Each section: workload → bottleneck → chosen optimization → rejected alternatives → when it changes (scale tier).

---

## 0. Workload characterization (this decides everything else)

| Data / path | Writes | Reads | Pattern | Verdict |
|---|---|---|---|---|
| `users` | **Bursty bulk** (10k–1M rows per upload) | Matching reads one batch's rows; future online lookups by PK | Write-heavy bursts, then a scan of the batch | Optimize **bulk load** + batch-scoped reads |
| `loan_products` | ~Dozens/day (crawl) | Whole table read per match run | Tiny, read-mostly | Keep in memory per run; indexes irrelevant |
| `matches` | Bulk set-based insert per batch | WF-C reads "not yet notified" | Write burst, then a narrow read | **Partial index** on the unread slice |
| `notifications` | Insert + status updates | Workers claim PENDING | Queue | `SKIP LOCKED` + partial index |
| `ingest_batches` | A few state updates per batch | **UI polls status every 1–5 s** | Read-heavy on a tiny table | PK lookup; trivially cheap |
| `pipeline_events`, `crawl_runs` | Append-only | Time-range reads | Log | BRIN index on time |
| `llm_judgments` | Rare | PK lookup | Cache | PK only |
| S3 uploads | Bursty large objects | Read once by ingest | Write-once, read-once | Multipart in, streaming out, lifecycle delete |

**Conclusion:** at Tier 1–2 this is a **write-burst + batch-analytics** workload, **not** a read-heavy one.
So read replicas and Redis caches would be cargo cult *now*. They become correct at Tier 2–3, when the **online offers API** creates a read-heavy path (see §1.7, §2).

---

## 1. PostgreSQL (RDS)

### 1.1 Bulk ingest (the dominant write) — measured

**Benchmark:** 1,000,000 rows (66 MB CSV) through the real ingestion code, Postgres 15 on an M-series laptop, single run per step (±0.5 s noise). Reproduce with the scripts referenced in §12.

**Where the time went (before):** 27.4 s total.

| Phase | Time | Language-bound? |
|---|---|---|
| decode + CSV parse | 1.8 s | yes |
| normalise + validate | 7.6 s | yes |
| `COPY` into staging | 1.2 s | barely (libpq does the work) |
| merge into `users` | 12.8 s | **no** — inside Postgres |
| duplicate check, ANALYZE, bookkeeping | ~4 s | no |

**65% of the time was Postgres.** So we optimised that first, because it speeds things up regardless of language:

| Change | Measured effect (1M rows) | Why |
|---|---|---|
| Dropped the `users.last_batch_id` foreign key (migration 004) | −2.7 s | One integrity check per row. Integrity is guaranteed by the single writer instead |
| `UPDATE` changed rows, then plain `INSERT` new rows, instead of `INSERT … ON CONFLICT` | −2 s | `ON CONFLICT` pays a speculative insertion on every row. Safe only because merges are serialised (§1.5) |
| Duplicates detected **while streaming** (hash map of `user_id`), so `DISTINCT ON`'s 1M-row sort runs only when duplicates exist | removes a sort and the separate duplicate-report query | O(1) per row. Costs ~100 MB per 1M rows of Lambda memory (peak 217 MB measured, limit 1,024 MB) |
| `SET LOCAL work_mem = '256MB'` for the merge | −1.5 to 2 s when the sort runs | Sorts stay in memory |
| Unchanged rows not rewritten (`IS DISTINCT FROM`) | re-upload with 5% changes: 5.8 s instead of a full rewrite | Fewer dead tuples, less WAL, and only real changes count as "new users" |
| Sorted `INSERT … ORDER BY user_id` | small | Primary-key B-tree writes stay local |

Then the Python hot path, guarded by the 59 normaliser and ingest tests:

| Change | Effect |
|---|---|
| Precompiled regexes (they were going through `re.sub(pattern_string, …)` on every call) | |
| Fast paths for the common case: plain digits for income, credit score and age; employment already in canonical form | parse + validate **9.4 s → 6.1 s** |
| Per-domain cache for email deliverability; a flat validation loop with no per-row closure | |

**Result: 27.4 s → 15.0 s for 1M rows (66,600 rows/s), −45%, still Python.**

**Considered and rejected (measured):**
- **Parallel merges** (4 or 8 connections on hash partitions). 6.4–6.8 s vs 7.0 s single: no gain, because Postgres serialises writes through one WAL. It would also give up the single-transaction "all or nothing" guarantee.
- **BRIN instead of the B-tree on `last_batch_id`.** It would save the index's ~1.5 s, but updates scatter recent batch values across old pages, so the index stops being selective exactly when a re-upload needs it.
- **Unlogged `users`.** Users must survive a crash.

**What remained (Python):** parse + validate 6.1 s (41%), and Postgres `COPY` + merge ~8.9 s (59%).

**Then the backend moved to Go (DESIGN §9.15): 1M rows in 6.0–6.8 s (147–166k rows/s), 2.2–2.5× faster than the tuned Python**, with the same rules and the same SQL. More than the 32% projected from the parse/validate share alone, because pgx streams binary `COPY` *while* rows are still being parsed, and binary numeric encoding is cheaper than text.

### 1.2 Matching queries (set-based, inside the DB)
**Class grouping:** one indexed scan + hash aggregate. Postgres's `width_bucket(value, sorted_array)` is a binary search, the SQL twin of Python's `bisect_right`.
```sql
SELECT width_bucket(monthly_income, $inc_cuts) AS ib,
       width_bucket(credit_score,   $score_cuts) AS sb,
       width_bucket(age,            $age_cuts)   AS ab,
       employment_status AS emp, count(*) AS n
FROM users WHERE last_batch_id = $1
GROUP BY 1,2,3,4;                       -- 10,000 rows → 378 class rows
```
**Writing matches without shipping rows through n8n:** n8n sends back only the ~378 class results as JSON, and Postgres expands them to 32k match rows **server-side**:
```sql
INSERT INTO matches (user_id, product_id, batch_id, status, decided_by)
SELECT u.user_id, pid, $1, c.status, c.decided_by
FROM users u
JOIN jsonb_to_recordset($2) AS c(ib int, sb int, ab int, emp text, pids int[], status text, decided_by text)
  ON  width_bucket(u.monthly_income, $inc_cuts) = c.ib
  AND width_bucket(u.credit_score,   $score_cuts) = c.sb
  AND width_bucket(u.age,            $age_cuts)   = c.ab
  AND u.employment_status = c.emp
CROSS JOIN LATERAL unnest(c.pids) AS pid
WHERE u.last_batch_id = $1
ON CONFLICT (user_id, product_id) DO NOTHING;
```
**Network:** ~378 small objects instead of 32,325 rows round-tripping through n8n.
**Rejected:** n8n inserting matches item by item. That's 32k statements, slow, and it bloats the execution log.

### 1.3 Indexes: exactly the ones the queries need
| Index | Serves | Why this shape |
|---|---|---|
| `users(last_batch_id)` | "new users of batch X" | Equality on a selective column |
| `matches PK (user_id, product_id)` | Idempotent inserts | Conflict target |
| **`matches(user_id) INCLUDE (product_id) WHERE notified_at IS NULL`** | WF-C "users with new matches" | **Partial + covering:** only un-notified rows are indexed (it shrinks to ~0 after sending); index-only scan |
| `notifications(status, created_at) WHERE status IN ('PENDING','RETRY')` | Queue claims | Partial: the queue slice only |
| `notifications(user_id, sent_at DESC)` | 7-day frequency cap | Newest-first lookup |
| `ingest_batches(status, lease_until) WHERE status IN ('LOADED','MATCHING')` | Sweeper | Partial: in-flight batches only |
| **BRIN** `pipeline_events(at)`, `crawl_runs(at)` | Time-range reads | Append-only data is physically ordered by time → BRIN is ~1000× smaller than a B-tree |
| `loan_products(product_key)` UNIQUE | Upsert | — |
| `pg_trgm` GIN on `loan_products(product_name)` | Cross-source dedupe | Similarity search |

**Rejected:** indexing every column "just in case". Each index slows every write, and this workload is write-burst-heavy.
**Verification:** a test runs `EXPLAIN (ANALYZE, BUFFERS)` on each hot query and asserts there is no sequential scan on large tables.

### 1.4 Session-level tuning (set per query, not globally)
- `SET LOCAL work_mem = '64MB'` inside the match transaction → hash aggregates and sorts stay in memory instead of spilling to disk. Global settings stay small to protect concurrency.
- `SET LOCAL synchronous_commit = off` only for staging loads (unlogged anyway). **Never for the merge transaction**: the doorbell must only ring after the data is durable.
- `statement_timeout` per role → a runaway query can't hold locks forever.

### 1.5 Concurrency and locking
- Claims use `UPDATE … WHERE status = … RETURNING` (compare-and-set) and `FOR UPDATE SKIP LOCKED` for queues. Workers never block each other.
- **Merges into `users` are serialised** with a transaction-scoped advisory lock. Parsing, validation and `COPY` of concurrent uploads still run in parallel; only the ~6 s merge waits its turn.
  - It costs no throughput: parallel merges measured no faster (§1.1).
  - It removes deadlocks, duplicate-key failures and "which batch wins" ambiguity.
  - A test runs four overlapping uploads in separate processes. It passes with the lock and fails without it.
- Full race analysis: DESIGN §9.14.

### 1.6 Connections
- Lambda: one connection **created outside the handler** and reused across warm invocations; SQS max concurrency 5 → at most 5 connections from ingest.
- n8n: its own pool (Postgres credential), queries parameterized (`$1`). That's safe, and lets Postgres reuse plans.
- Tier 2+: **RDS Proxy** (or PgBouncer in transaction mode) when Lambda concurrency grows. Not before: it costs money and adds a hop.

### 1.7 Read replicas: when, honestly
- **Tier 1–2 (now):** not needed. The read paths are a status lookup (one PK read) and batch-scoped analytics on fresh writes. **A replica would actually be wrong for both**: replication lag would show stale status ("still parsing" after it finished) and miss just-written users. These need **read-your-writes**, so they go to the primary.
- **Tier 2–3:** the **online offers API** (~100–1,000 req/s, read-only, tolerant of seconds of lag) and analytics/BI → route to a **read replica**. The status API and matching stay on the primary.
- Routing rule: *needs your own latest write → primary; tolerates seconds of lag → replica.*

### 1.8 Storage growth and vacuum
- `matches` / `notifications` churn → per-table autovacuum tuning (`autovacuum_vacuum_scale_factor = 0.05`), so vacuum runs before bloat builds up.
- Staging tables are dropped after the merge (no vacuum debt).
- Tier 2: hash-partition `matches` by `user_id` (16 partitions) → smaller indexes, parallel vacuum, cheap partition maintenance. Tier 3: same for `users`.

---

## 2. Redis: do we need it? (decided by use case, not by habit)

| Candidate use | Need it? | Reasoning |
|---|---|---|
| **n8n queue mode broker** (main + workers) | **Tier 2: yes. Tier 1: optional** | n8n's horizontal scaling *requires* Redis. We ship it as a compose **profile** (`--profile queue`) and can show 2 workers in the video |
| **Distributed rate limiter** (SES pacing across workers) | Only with more than 1 worker | Atomic counters belong in Redis, not Postgres (no row-lock contention). Algorithm in §4 |
| Cache for online offers | **No** (even at Tier 2) | The class table is a few thousand rows → it lives in Postgres's buffer cache; Redis would add a consistency problem (invalidation) for no latency gain |
| Job queue for notifications | **No** | A Postgres queue is **transactional with `matches`** (outbox semantics). A Redis queue is not durable by default and would split the source of truth |
| Session / idempotency keys for the API | No | Low volume; Postgres table with TTL cleanup |

**Principle:** add a datastore only when it does something the existing one can't do well. "Faster reads" isn't enough if the data already sits in memory.

---

## 3. Queues

### 3.1 SQS (S3 → ingest)
| Setting | Value | Why |
|---|---|---|
| Type | **Standard** (not FIFO) | Consumers are idempotent, so ordering and dedupe aren't needed. FIFO adds throughput limits and cost for nothing |
| Batch size | 1 | One file per invocation; a poison file can't sink others |
| Visibility timeout | 6 × Lambda timeout | AWS guidance: prevents duplicate processing while a long file is being parsed |
| maxReceiveCount → DLQ | 3 | Bounded retries; failures become visible |
| Event source max concurrency | 5 | **Backpressure** for the DB connection budget |
| Long polling | Managed by the Lambda event source mapping | No empty-receive cost |

### 3.2 Postgres as the internal work queue (notifications, batch claims)
`SELECT … FOR UPDATE SKIP LOCKED LIMIT 500` gives N competing workers without blocking, plus leases for crash recovery.
**Why not SQS here:** n8n has no SQS trigger, and the queue must commit in the **same transaction** as the data it describes.
**Ceiling:** comfortably thousands of jobs/s on modest hardware. Far above SES send rates, so the queue is never the bottleneck.

### 3.3 Fair scheduling across tenants (Tier 2)
Claim order `(tenant_last_served_at, created_at)` approximates **weighted fair queuing / deficit round robin**, so one partner's huge batch can't starve the others. Large batches are claimed in chunks.

---

## 4. Rate limiting: algorithm choice

| Algorithm | Memory | Burst control | Precision | Verdict |
|---|---|---|---|---|
| Fixed window counter | O(1) | ❌ allows 2× burst at window edges | Low | Rejected |
| Sliding window log | O(requests) | ✅ | Exact | Too much memory |
| Sliding window counter | O(1) | ≈ | Approximate | OK |
| Token bucket | O(1), 2 fields | ✅ configurable burst | Good | Good |
| **GCRA** (generic cell rate algorithm) | **O(1), one timestamp** | ✅ | Exact spacing | **Chosen for multi-worker SES pacing** (one Redis key, atomic script) |

- **Tier 1** (single worker): the n8n **Loop Over Items + Wait (1 s)** node pair already enforces the 1 email/s sandbox rate. No Redis needed.
- **Tier 2:** GCRA in Redis shared by all workers → the total stays under the SES max send rate.
- **Retries:** exponential backoff with **full jitter**, `sleep = random(0, min(cap, base·2^n))`. This avoids synchronized retry storms.

---

## 5. Workers and compute

### 5.1 Lambda
| Optimization | Detail |
|---|---|
| **arm64 (Graviton)** | Lower price per ms for the same work |
| Memory = CPU | CPU scales with memory (~1 vCPU at 1,769 MB). Ingest is parse-bound → start at 1,024 MB, then **tune with AWS Lambda Power Tuning** to find the cost/speed sweet spot |
| Small deployment package | One static Go binary per function (~4 MB zipped, `provided.al2023`): no interpreter to start, no layer, no dependency tree to import → cold starts in tens of ms |
| Init outside the handler | DB pool, S3 client and compiled regexes created once per container and reused while warm |
| Streaming S3 read | `get_object()["Body"].iter_lines()` → constant memory; gzip decompressed as a stream |
| Timeout budget | Stop accepting work at T-60 s; SQS redelivers; a checkpoint (last committed line) makes the resume idempotent (Tier 3 chunking) |

### 5.2 n8n workers
| Optimization | Detail |
|---|---|
| **Avoid item explosion** | n8n's cost is per item. Pass collections as **one item holding arrays** (classes, cut points). The Code node loops internally |
| Push set work to SQL | n8n orchestrates; Postgres computes (§1.2) |
| Code node in **JavaScript** | Native and fast; BigInt for wide bitmasks. Python in n8n runs in a slower sandbox |
| Webhook responds immediately (202) | Lambda isn't held open while matching runs |
| Sub-workflows for paged work | Each page runs in its own execution → memory released per page |
| `N8N_DEFAULT_BINARY_DATA_MODE=filesystem` | Crawled HTML stays out of memory and the DB |
| Execution pruning (`EXECUTIONS_DATA_PRUNE`, max age 7 d; always save errors) | Prevents n8n's own DB from bloating |
| Queue mode (Tier 2) | Main + N workers with `--concurrency`; webhook processors scale separately |
| Per-node Retry On Fail + error outputs | Transient failures retried locally instead of failing the whole run |

---

## 6. Matching algorithm (Treasure Hunt): complexity

| Step | Algorithm | Complexity |
|---|---|---|
| Cut points | Sorted unique thresholds per attribute | O(P log P) |
| Class assignment | `width_bucket` (binary search) + hash aggregate, in SQL | O(U log P) |
| Per-attribute masks | Sort products by threshold → **prefix unions** (each value's mask = OR of products whose threshold ≤ value) | O(P) per attribute |
| Class eligibility | `inc & score & age & emp` | O(C · P/64) |
| Ranking | **Class-level** (rank depends on product attributes such as rate) → top-K once per class, not per user | O(C · P log K) |
| Expansion to users | One set-based SQL insert | O(matches) inside the DB |
| **Product change** | New masks vs old: `gained = new & ~old` (bit ops) → only users in classes with gained bits get notified | O(C) instead of O(U) |

**Measured (real CSV, 10 illustrative products):** U = 10,000 → C = 378; identical to brute force; ~3× faster even at this size. The gap grows with U, because C doesn't.

---

## 7. LLM (token and latency optimization)

| Optimization | Mechanism | Saves |
|---|---|---|
| **Compile once** | Criteria → rules at crawl time, cached by `criteria_hash` | O(U·P) → O(changed P) calls |
| **Projected cache keys** | Key on `depends_on` features only | 20k pairs → 113 keys (simulation) |
| **Normalized-text dedupe** | Identical soft-rule text across lenders ("3 years business continuity") → one judgment | Further key collapse |
| **Batch prompts** | ~25 keys per request | Instruction tokens paid once per batch; fewer requests under RPM limits |
| **Input reduction** | Boilerplate removal + **keyword windowing** (keep ±N sentences around "eligib", "income", "interest", "CIBIL", "age") | Typically ~10× fewer input tokens per page |
| **Structured output** | JSON schema, short enums | Smaller, parseable output; no retries for format |
| **Provider prompt caching** | Static system prompt + schema first, variable text last | Cheaper repeated prefixes where the provider supports it |
| **Model tiering** | Small model first; escalate only if validation fails | Pays for capability only when needed |
| **Circuit breaker** | Stop calling after N failures | No wasted calls during an outage |

---

## 8. Web crawler optimization

| Optimization | Mechanism | Why |
|---|---|---|
| **Sitemap-driven discovery** | Read `sitemap.xml` `<lastmod>` → fetch only product pages that changed | Don't walk the whole site |
| **Conditional GET** | `If-None-Match` (ETag) / `If-Modified-Since` → `304` | Zero body bytes when unchanged |
| **Compression + keep-alive** | `Accept-Encoding: gzip, br`; reuse the connection per host | Fewer bytes, no repeated TLS handshakes |
| **Politeness frontier** | Per-host queue with delay (honour `Crawl-delay`); hosts crawled **in parallel**, a single host **serially** | Fast overall, polite per site |
| `robots.txt` cache | Fetched once per 24 h per host | Compliance without repeated fetches |
| **Section hashing** | SHA-256 of the extracted loan section (not the whole page: ads and dates change daily) | Precise change detection |
| **Adaptive revisit** (inside the daily schedule) | A page unchanged k times is deep-processed every 2^k days (capped at 7); reset on change | Change-rate-aware crawling; the daily trigger stays as the brief requires |
| **Extraction ladder** | JSON-LD → CSS selectors → LLM fallback (layout-change bonus) | Cheapest reliable method first |
| **Per-host circuit breaker** | Repeated 429/5xx → skip that host this run | Don't hammer a struggling site |
| Headless browser only as a fallback | For JS-only pages | Heavy; avoid by default |
| **Near-duplicate detection** (SimHash; documented) | When section hashing gets noisy | Robust change detection |

---

## 9. S3 and upload path
- Multipart: 8 MB parts, 4 in parallel, per-part SHA-256 (§DESIGN 9.1). Browser gzip cuts bytes ~5–10×.
- Same region as Lambda/RDS (ap-south-1) → no cross-region transfer cost or latency.
- Ingest reads **as a stream**; Tier 3 uses **byte-range GETs** so N workers parse chunks in parallel (chunk boundaries aligned to the next newline).
- Lifecycle: abort incomplete multipart uploads after 1 day; expire raw files after 7 days.
- S3 Select: rejected (closed to new customers since 2024).

---

## 10. API and UI
- Status polling with **adaptive interval** (1 s → 5 s while a stage runs) and **ETag / `If-None-Match`** → `304` when nothing changed (cheap for client and server).
- Status reads hit the **primary** (read-your-writes; §1.7).
- Static UI on CloudFront: hashed filenames + long cache TTL, Brotli/gzip, no framework → tiny payload.

---

## 11. Email
- **One digest per user** instead of one per match → several-fold fewer sends.
- Product "cards" rendered **once per class** (identical within a class); only the name and amounts are personalized → negligible render cost even at 500k/day.
- Pacing: Wait node (Tier 1) → GCRA in Redis (Tier 2); jittered retries on throttling.

---

## 12. What we'll measure to prove it (not just claim it)

**Reproduce the ingest benchmark** (any Postgres; numbers in §1.1 are from a local Postgres 15):
```bash
python3 scripts/make_demo_csv.py 1000000 > /tmp/users_1m.csv          # fresh user_ids + 4 realistic bad rows
DATABASE_URL=postgresql://…/bench go run ./apps/migrate
DATABASE_URL=postgresql://…/bench N8N_WEBHOOK_URL= go run ./apps/ingest_local /tmp/users_1m.csv   # prints rows and elapsed_ms
```

| Metric | Tool |
|---|---|
| Ingest rows/s at 10k and 1M rows | Synthetic CSV generator + timing in `pipeline_events` |
| Match time and funnel counts (U → C → pairs → LLM keys) | `pipeline_events.counts` |
| Query plans of the hot queries | `EXPLAIN (ANALYZE, BUFFERS)` in tests |
| Lambda duration vs memory | Lambda Power Tuning (if deployed) |
| Tokens per batch / per crawl | `llm_judgments` + crawl logs |
| Crawl bytes saved | Count of 304s and hash-unchanged skips in `crawl_runs` |
