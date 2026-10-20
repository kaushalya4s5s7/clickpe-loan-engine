-- Loan Eligibility Engine — core schema (PostgreSQL 15+).
-- Idempotent: safe to re-run. Design notes live in docs/DESIGN.md §8.


DO $$ BEGIN
  CREATE TYPE employment_t AS ENUM ('Salaried', 'Self-Employed', 'Business');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Batch lifecycle. Every transition is a compare-and-set (UPDATE ... WHERE status = <expected>),
  -- so duplicate events and concurrent workers cannot move a batch twice.
  CREATE TYPE batch_status_t AS ENUM (
    'CREATED', 'UPLOADED', 'PARSING', 'LOADED', 'MATCHING', 'MATCHED',
    'NOTIFYING', 'DONE', 'FAILED', 'ABORTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------- ingestion
CREATE TABLE IF NOT EXISTS ingest_batches (
  id             uuid PRIMARY KEY,
  filename       text NOT NULL,
  s3_key         text NOT NULL UNIQUE,
  upload_id      text,
  size_bytes     bigint NOT NULL CHECK (size_bytes > 0),
  file_sha256    text,
  status         batch_status_t NOT NULL DEFAULT 'CREATED',
  lease_until    timestamptz,             -- matcher lease; expired lease = reclaimable
  error          text,
  rows_total     int,
  rows_valid     int,
  rows_rejected  int,
  rows_inserted  int,                     -- brand-new users
  rows_updated   int,                     -- existing users whose values changed
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 90);                 -- status updates stay HOT (no index churn)

-- The sweeper scans only batches that still need work.
CREATE INDEX IF NOT EXISTS ingest_batches_pending_idx
  ON ingest_batches (status, lease_until) WHERE status IN ('LOADED', 'MATCHING', 'MATCHED');

CREATE TABLE IF NOT EXISTS ingest_errors (
  batch_id   uuid NOT NULL REFERENCES ingest_batches(id) ON DELETE CASCADE,
  line_no    int  NOT NULL,               -- 1-based, as the user sees it in Excel
  column_name text,
  code       text NOT NULL,
  message    text NOT NULL,
  raw_value  text
);
CREATE INDEX IF NOT EXISTS ingest_errors_batch_idx ON ingest_errors (batch_id, line_no);

-- ---------------------------------------------------------------- users
-- email is deliberately NOT unique: in the sample file 9,771 of 10,000 rows share an
-- address with another user_id. Identity is user_id.
CREATE TABLE IF NOT EXISTS users (
  user_id            text PRIMARY KEY,
  name               text,
  email              text NOT NULL,
  email_deliverable  boolean NOT NULL,    -- false for reserved/test domains (example.com, ...)
  monthly_income     numeric(12,2) NOT NULL CHECK (monthly_income >= 0),
  credit_score       smallint CHECK (credit_score BETWEEN 300 AND 900), -- NULL = new-to-credit
  employment_status  employment_t NOT NULL,
  age                smallint NOT NULL CHECK (age BETWEEN 18 AND 100),
  consent_marketing  boolean NOT NULL DEFAULT true,
  last_batch_id      uuid REFERENCES ingest_batches(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 90);
-- "Users of this batch" — the only access path workflow B needs.
CREATE INDEX IF NOT EXISTS users_last_batch_idx ON users (last_batch_id);

-- ---------------------------------------------------------------- loan catalogue
CREATE TABLE IF NOT EXISTS loan_products (
  id                   bigserial PRIMARY KEY,
  product_key          text NOT NULL UNIQUE,   -- sha256(lender | normalized product name): stable across crawls
  lender_name          text NOT NULL,
  product_name         text NOT NULL,
  source_url           text NOT NULL,
  interest_rate_min    numeric(5,2),           -- % p.a.
  interest_rate_max    numeric(5,2),
  min_monthly_income   numeric(12,2),          -- NULL = not stated (passes)
  min_credit_score     smallint,               -- NULL = not stated (passes)
  accepts_ntc          boolean NOT NULL DEFAULT false, -- accepts users with no credit history
  min_age              smallint,
  max_age              smallint,
  employment_types     employment_t[],         -- NULL = any
  max_loan_amount      numeric(14,2),
  max_tenure_months    smallint,
  soft_rules           jsonb NOT NULL DEFAULT '[]', -- [{text, depends_on:[feature...]}] rules SQL can't express
  evidence             jsonb NOT NULL DEFAULT '{}', -- field -> verbatim quote from the page
  extraction_method    text NOT NULL,          -- llm | llm_fallback
  criteria_hash        text NOT NULL,          -- hash of the eligibility fields; drives cache invalidation
  is_active            boolean NOT NULL DEFAULT true,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (min_age IS NULL OR max_age IS NULL OR min_age <= max_age),
  CHECK (interest_rate_min IS NULL OR interest_rate_max IS NULL OR interest_rate_min <= interest_rate_max)
);

-- Per-page crawl state: conditional GET validators + section hash = "cheapest check first".
CREATE TABLE IF NOT EXISTS crawl_sources (
  url             text PRIMARY KEY,
  lender_name     text NOT NULL,
  page_role       text NOT NULL CHECK (page_role IN ('eligibility', 'rates')),
  etag            text,
  last_modified   text,
  section_hash    text,
  unchanged_runs  int NOT NULL DEFAULT 0,
  last_status     text,
  last_crawled_at timestamptz
);

CREATE TABLE IF NOT EXISTS crawl_runs (
  id              bigserial PRIMARY KEY,
  url             text NOT NULL,
  outcome         text NOT NULL,  -- not_modified | unchanged | extracted | fallback_extracted | failed
  products_found  int NOT NULL DEFAULT 0,
  bytes_fetched   int,
  tokens_used     int,
  error           text,
  at              timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- matching
-- One row per eligible (user, product) pair — the table name the brief asks for.
CREATE TABLE IF NOT EXISTS matches (
  user_id           text   NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  product_id        bigint NOT NULL REFERENCES loan_products(id) ON DELETE CASCADE,
  status            text   NOT NULL CHECK (status IN ('ELIGIBLE', 'LIKELY')),
  score             real   NOT NULL,          -- ranking score, higher = better offer
  unverified        jsonb  NOT NULL DEFAULT '[]', -- soft rules we could not check (missing data)
  decided_by        text   NOT NULL CHECK (decided_by IN ('RULES', 'LLM')),
  batch_id          uuid   REFERENCES ingest_batches(id),
  first_matched_at  timestamptz NOT NULL DEFAULT now(),
  notified_at       timestamptz,
  PRIMARY KEY (user_id, product_id)
);
-- Workflow C reads only un-notified matches. Partial + covering: the index shrinks
-- to almost nothing once emails go out, and the read never touches the heap.
CREATE INDEX IF NOT EXISTS matches_unnotified_idx
  ON matches (batch_id, user_id) INCLUDE (product_id, score) WHERE notified_at IS NULL;

-- Treasure Hunt stage 3 cache. Key = (product, criteria_hash, values of ONLY the features the
-- rule depends on) — so its size is bounded by feature cardinality, not by user count.
CREATE TABLE IF NOT EXISTS llm_judgments (
  cache_key    text PRIMARY KEY,
  product_id   bigint NOT NULL REFERENCES loan_products(id) ON DELETE CASCADE,
  verdict      text NOT NULL CHECK (verdict IN ('PASS', 'FAIL', 'UNKNOWN')),
  rationale    text,
  model        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- notifications
CREATE TABLE IF NOT EXISTS notifications (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  batch_id        uuid REFERENCES ingest_batches(id),
  digest_key      text NOT NULL,      -- hash of the product set offered: same offer => same key
  recipient       text NOT NULL,      -- after test-mode rewrite (never a sample-CSV address)
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  ses_message_id  text,
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  UNIQUE (user_id, digest_key)        -- the duplicate-email guard
);
CREATE INDEX IF NOT EXISTS notifications_user_sent_idx ON notifications (user_id, sent_at);

-- Unsubscribes / hard bounces. Stores a hash, so suppression survives a DPDP erasure.
CREATE TABLE IF NOT EXISTS suppression (
  email_hash  text PRIMARY KEY,
  reason      text NOT NULL CHECK (reason IN ('unsubscribe', 'bounce', 'complaint')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- observability
-- Timeline + funnel counts per batch; drives the UI status view and the Treasure Hunt metrics.
CREATE TABLE IF NOT EXISTS pipeline_events (
  id        bigserial PRIMARY KEY,
  batch_id  uuid,
  stage     text NOT NULL,
  status    text NOT NULL,
  detail    jsonb NOT NULL DEFAULT '{}',
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipeline_events_batch_idx ON pipeline_events (batch_id, id);
