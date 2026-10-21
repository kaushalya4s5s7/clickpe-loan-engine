# Scale & Product Context — Embedding the Engine into ClickPe

> This isn't a standalone demo. It's a component that would live inside ClickPe.
> So we size it for **ClickPe's growth path**, not for the 10,000-row sample.

---

## 1. What we know about ClickPe (public sources, Oct 2026)

| Fact | Source |
|---|---|
| Lending marketplace: small business loans **repaid in small daily installments** (auto-debit), aimed at **small shop owners with daily income** | YC company page / YC launch post |
| Connects borrowers to RBI-registered NBFCs and banks; loans reportedly ₹2,000–₹2,00,000 | Third-party profile (unverified) |
| Founded 2022, YC W23, Surat; reported focus on Gujarat & Rajasthan | YC page; third-party profile |
| Team roughly 14 people; ~54k website visits/month | Inc42 |
| **No public numbers** on users, loans disbursed or lenders | — |

**Inference (ours, not a fact):** today's active user base is plausibly tens of thousands to low hundreds of thousands.
**Addressable market:** **7.22 crore (72.2M) Udyam-registered MSMEs** as of 30 Nov 2025 (Lok Sabha reply), past 7.3 crore by year-end (Ministry of MSME year-end review).

**Product consequences:**
- ClickPe's core borrower is the **"Business" employment segment** (32% of the sample CSV). Matching and ranking must understand **repayment frequency** (daily vs monthly) and **daily affordability** (daily instalment vs monthly income ÷ 30), not only monthly EMI.
- Shopkeepers in Tier-2/3 India live on **WhatsApp/SMS more than email**. The brief requires email, so we build email. But notifications are modelled **channel-agnostically** (a `channel` column, a pluggable sender) so WhatsApp can be added without a redesign.

---

## 2. Design targets (capacity tiers)

We design the data model for **Tier 2** and make sure **Tier 3 needs configuration and partitioning, not a rewrite.** The 72-hour build runs at Tier 1.

| | **Tier 1: now** | **Tier 2: design point (2–3 yrs)** | **Tier 3: India-scale ceiling** |
|---|---|---|---|
| Users in DB | 100k | **10M** | 70M+ (all Udyam MSMEs) |
| Largest single upload | 100k rows (~10 MB) | **1M rows (~100 MB)** | 10M rows (~1 GB) |
| Uploads/day | a few | ~50 (many partners) | 500+ |
| Loan products | 10–30 | **200–500** (more lenders × state × segment variants) | 1,000+ |
| New-match notifications/day | ~100s | **~500k** (5% of users) | millions |
| Online "what can I get?" lookups | — | **~100 req/s peak** from the ClickPe app | 1,000+ req/s |

---

## 3. Back-of-envelope at Tier 2 (and what it forces us to change)

### 3.1 Users table
~200 B/row + indexes ≈ 600 B → **10M × 600 B ≈ 6 GB**. Fine on one Postgres instance. No sharding needed at Tier 2.

### 3.2 Matches table: the naive design breaks here ⚠️
Store every eligible pair: 10M users × ~30% of 500 products ≈ **1.5 billion rows** (≈150 GB+). That's unacceptable.

**Decision: store matches at the class level, materialize only what's needed.**
```
user_class(user_id PK, class_id)              -- 10M rows, ~200 MB
class_matches(class_id PK, product_mask bit(512), computed_at, catalog_version)
                                               -- thousands of rows
user_offers(user_id, product_id, rank, score)  -- top-K (K=10) only → 100M rows, partitioned
```
- "Which products is user X eligible for?" → `user_class` → `class_matches` → 2 indexed lookups.
- This is the **coordinate compression from Feature 7, applied to storage, not just compute.**
- The brief's `matches` table becomes **`user_offers` (top-K) plus a view** that expands class masks when needed.

### 3.3 Product changes become cheap
A lender changes one rate or threshold → **recompute only `class_matches`** (thousands of rows), then diff the masks.
Users whose class gained a bit are the only ones with *new* matches → only they enter the notification queue.
**Naive model:** a product change re-evaluates 10M users. **Class model:** it touches a few thousand rows.

### 3.4 Bitmask width
500 products > 64 bits → masks become **arbitrary-width bitsets**: Postgres `bit(512)` with `&`, JS `BigInt`. The algorithm is unchanged.
Class count upper bound at 500 products: (income cuts + 1) × (score cuts + 1) × (age bands) × 3 ≈ 41 × 16 × 21 × 3 ≈ **41k**. That's the theoretical maximum; far fewer are populated (Tier 1 measured: 378).

### 3.5 Ingestion
1M rows ≈ 100 MB → streaming + `COPY` at roughly 50–100k rows/s ≈ **10–20 s**, well inside Lambda's 15 minutes.
At Tier 3 (10M rows / ~1 GB) we're near the limit → **splitter Lambda → byte-range chunks → SQS → N workers** (documented, not built).

### 3.6 n8n throughput: the real Tier-2 bottleneck
n8n has overhead **per item**, and a single execution keeps all its items in memory.
- **Never 41k items:** class data passes as **one item holding arrays**. The Code node does the bitset loop internally (milliseconds).
- **Never 500k emails in one execution:** WF-C becomes a **dispatcher**. It claims pages of 500 notifications (`FOR UPDATE SKIP LOCKED`) and runs a **sub-workflow per page**.
- **Queue mode (Redis + workers)** becomes required at Tier 2: workers run pages in parallel, and a **shared token bucket** keeps total throughput under the SES send-rate limit.
- 500k emails/day ≈ **6/s average**. SES production quotas are raised on request; the sandbox (200/day, 1/s) is only for the demo.

### 3.7 LLM cost: flat as users grow
Compile cost scales with **changed products**. Judgment cost scales with **distinct projected keys** (bounded by feature cardinality).
**10k users or 10M users → roughly the same LLM bill.** This is the strongest scale argument in the design.

---

## 4. Embedding into ClickPe: more than a CSV pipeline

| Entry point | Today (brief) | Embedded product |
|---|---|---|
| Bulk partner leads | CSV upload → S3 → SQS → ingest | Same |
| **New user signs up in the ClickPe app** | — | `PUT /users/{id}` → compute class → mask lookup → offers in **<50 ms**. No batch needed. |
| **"What loans can I get?" in the app** | — | Online eligibility API reading `user_class` + `class_matches` (cacheable; the class table is tiny) |
| Lender changes terms | Daily crawl | Crawl **plus** a lender-partner admin/API feed. The crawler is one catalogue source; partner-provided data wins on conflict |
| Re-engagement | Email after upload | Diff-based "new offer for you" on catalogue change, frequency-capped |

**Same engine, two modes:** batch (a CSV of millions) and online (one user, in milliseconds). Both work because a user's eligibility reduces to "which class am I in?"

---

## 5. Multi-tenancy and fair scheduling (the real "load balancing" here)

ClickPe will take leads from **many partners** (distributors, apps, DSAs).
**Risk:** partner A uploads 5M rows and partner B's 2k-row upload waits an hour behind it (head-of-line blocking).

- `tenant_id` on `ingest_batches`, `users`, `notifications`; per-tenant quotas (max rows/day, max concurrent batches).
- **Weighted fair queuing:** the matcher and email dispatcher pick work **round-robin across tenants**, weighted by plan, instead of first-in-first-out. Implementation: `SKIP LOCKED` claim ordered by `(tenant_last_served_at, created_at)`.
- Large batches get **chunked**, so small tenants interleave between chunks.
- Per-tenant suppression lists and email sender identities.

This is where a classic scheduling algorithm earns its place.

---

## 6. Compliance (India): engineering requirements, not a footnote
*(Engineering view, not legal advice.)*
- **DPDP Act 2023:** process personal data only with consent for a stated purpose. Store `consent_marketing` and its source per user, and filter on it *before* matching for outreach. Support erasure (delete user → cascade offers and notifications). Retention limits on raw uploads (S3 lifecycle, 7 days).
- **RBI Digital Lending Directions:** communications should name the **regulated lender (bank/NBFC)** behind each product and avoid misleading claims. Our email shows the lender name, the rate *range* exactly as published, the source link, and "indicative, not an offer."
- **Data minimization by design:** the LLM never sees PII (only projected features), and logs never contain email or income.

---

## 7. What changes in the build because of this doc

| Area | Before | After |
|---|---|---|
| Matches storage | `matches(user_id, product_id)` for every pair | `user_class` + `class_matches(bitmask)` + top-K `user_offers` |
| Bitmask | 64-bit | Arbitrary width (`bit(n)` / BigInt) |
| Product change | (not handled) | Recompute class masks → diff → notify only gained users |
| Email workflow | Loop in one execution | Dispatcher + paged sub-workflows, shared token bucket |
| n8n | Single instance | Single for the demo; queue-mode compose profile included |
| Schema | Single-tenant | `tenant_id` everywhere, `consent_marketing`, `channel`, `repayment_frequency` on products |
| API | Upload + status | Also an online eligibility endpoint (stretch goal; same engine) |

**72-hour scope:** Tier-2-ready schema and algorithms, demoed at Tier 1, with a **synthetic 1M-row load test** to prove the ingest and matching numbers instead of just claiming them.

---

## Sources
- [YC — ClickPe](https://www.ycombinator.com/companies/clickpe) · [YC — DailyPe](https://ycombinator.com/companies/dailype) · [YC launch: DailyPe](https://www.ycombinator.com/launches/IKN-dailype-repay-your-loans-daily)
- [Inc42 — ClickPe](https://inc42.com/company/clickpe/) · [Dealroom — ClickPe](https://app.dealroom.co/companies/clickpe)
- [MSME year-end review 2025](https://www.aviation-defence-universe.com/year-end-review-2025-ministry-of-micro-small-medium-enterprises/) · Lok Sabha replies on Udyam registrations (Dec 2025, via [eparlib.sansad.in](https://eparlib.sansad.in/)). Verify the exact reply before quoting it in the video.
