# Repository Architecture — Loan Eligibility Engine

> The universal architecture rules, applied to **this** product: a Go backend on Lambda, n8n workflows, Postgres, and a Next.js console.
> System design (what runs where): [`DESIGN.md`](./DESIGN.md). Why Go: DESIGN §9.15. This file covers how the **code** is organised and how its boundaries are enforced.

The goal: the **smallest structure that stays clean, testable and production-ready**. We don't add packages to look modular. Every package below exists because it's a real capability with a stable contract.

---

## 1. Capabilities first (scaffolding rule)

| Capability | What it does | Runtime |
|---|---|---|
| Upload sessions | Start, sign, resume, complete and abort multipart uploads | Go (Lambda `api`) |
| Batch lifecycle | Status state machine (compare-and-set), leases, timeline | Go + n8n (shared DB contract) |
| Ingestion | Decode → normalise → validate → streaming `COPY` → serialised merge; error report | Go (Lambda `ingest`) |
| Orchestration trigger | Rings n8n's webhook when a batch is loaded (HMAC-signed) | Go |
| Notifications (non-send parts) | Unsubscribe tokens, suppression list | Go |
| Reporting (read model) | Overview, catalogue and batch summary for the console | Go |
| Product discovery · Matching · Email sending | Workflows A, B and C | n8n (the brief requires it) |
| Operations console | Landing, upload flow, batch results, history, catalogue | Next.js (static export) |
| Database | Connections, transactions, embedded migrations (the schema is the contract between Go and n8n) | Go + SQL |

- **Matching, crawling and email sending live in n8n**, because the brief says "all core business logic must be orchestrated through n8n". So there is no Go `matching`, `catalog` or `email` package.
- **The database schema is the contract** between Go and n8n. They never call each other's code; they meet only at the tables and at the webhook.

---

## 2. Repository layout

```text
.
├── go.mod                         # ONE Go module ("loanengine"): one dependency catalog for the backend
├── apps/                          # deployables — import packages, are never imported
│   ├── api/                       # λ: every HTTP route; route table + thin handlers + error model
│   ├── ingest_worker/             # λ: SQS consumer (S3 event → ingestion.Run)
│   ├── migrate/                   # CLI: apply embedded migrations
│   ├── ingest_local/              # CLI: local mode, and the entry point the Python harness drives
│   ├── web/                       # operations console — Next.js 16 static export → S3 + CloudFront
│   │   └── src/{app,components,hooks,lib}   # lib/api is the console's only path to the backend
│   └── workflows/                 # n8n: src/code (JS, node-tested) · src/sql · src/workflows (graphs) → dist/*.json
├── packages/                      # service packages, named by capability (never by vendor)
│   ├── database/                  # pool, transactions, Migrate; migrations/*.sql embedded with go:embed
│   ├── batches/                   # state machine; owns ingest_batches + pipeline_events SQL
│   ├── uploads/                   # sessions; internal/s3store holds the AWS SDK (private)
│   ├── ingestion/                 # pipeline; internal/s3reader holds the AWS SDK (private)
│   ├── orchestration/             # signed doorbell (stdlib HTTP + HMAC)
│   ├── notifications/             # tokens + suppression
│   └── reporting/                 # read model for the console (never writes)
├── internal/                      # module-private test infrastructure
│   ├── testdb/                    # a fresh, migrated Postgres database per test
│   └── archtest/                  # the rules of §6 as a Go test
├── tests/                         # Python harness: n8n SQL + JS against the Go binaries
│   ├── e2e/                       # crawl → ingest → match → notify, races, notification SQL
│   ├── oracle/                    # brute-force matcher (differential testing)
│   └── fixtures/                  # bank-page snapshots, recorded/golden LLM replies
├── scripts/                       # build_lambdas, deploy_web, smoke_aws, eval_extraction, make_demo_csv
├── serverless.yml · docker-compose.yml · .env.example · README.md
```

**Why `apps/` + `packages/` rather than Go's usual `cmd/` + `internal/`:** the same ideas under the names the universal rules use. `apps/*` are the `cmd/` binaries. Privacy is still Go's `internal/`, placed **inside each package** for its vendor adapters.

---

## 3. Package types, mapped

| Type (universal rule) | Ours | Notes |
|---|---|---|
| Service packages | `batches`, `uploads`, `ingestion`, `orchestration`, `notifications`, `reporting` | `reporting` is a read model: it never writes |
| Infrastructure | `database` | The bottom layer; knows nothing about business |
| Applications | `apps/api`, `apps/ingest_worker`, `apps/migrate`, `apps/ingest_local`, `apps/web`, `apps/workflows` | Deployables and CLIs |
| UI packages | none | One console app; a `design-system` package would have one consumer (rule 16) |
| Configuration | `go.mod`, `pyproject.toml` (harness), `apps/web/package.json` | Tooling only |

**Vendor names never appear as package names:** `uploads`, not `s3`; `orchestration`, not `n8n`.

---

## 4. Dependency direction

```text
apps/api ──────────────┬──────────────┬──────────┐        apps/ingest_worker ──┐
   │                   │              │          │              │              │
   ▼                   ▼              ▼          ▼              ▼              ▼
uploads          notifications    reporting   batches       ingestion ──► orchestration
   │                   │              │          ▲              │
   └──► batches ◄──────┼──────────────┼──────────┴──────────────┘
           │           │              │
           ▼           ▼              ▼
                     database
```

| Package | May import | Never imports |
|---|---|---|
| `database` | pgx | any service, any app |
| `batches` | `database` | other services |
| `uploads` | `batches`, `database`; its own `internal/s3store` | `ingestion`, apps |
| `ingestion` | `batches`, `database`, `orchestration`; its own `internal/s3reader` | `uploads`, apps |
| `orchestration` | stdlib only | everything else (reusable by any service) |
| `notifications` | `database` | other services, apps |
| `reporting` | `database` | every other package |
| `apps/*` | any package's public API | other apps, any package's `internal/`, the database driver |

**Why `ingestion → orchestration` and not the worker calling both:** "load the batch, then tell n8n" is one business rule. If the handler did it, a second entry point (`apps/ingest_local`) could forget the doorbell.

---

## 5. Inside a service package

```text
packages/uploads/
├── uploads.go          # the public API: Service, Session, PartURL, InvalidUpload, ObjectKey, …
├── keys.go             # this package's environment contract (LoadKeys), validated on use
├── uploads_test.go     # behaviour through the public API (real Postgres, in-memory fake store)
└── internal/
    └── s3store/        # the AWS SDK. Only code under packages/uploads/ can import this — the COMPILER says so
```

The universal rules' `public/` and `private/` map onto Go like this:
- **Public:** exported identifiers in the package root.
- **Private:** unexported identifiers (each package's SQL is unexported) plus the package's `internal/` folder.

If another package needs something private, it is promoted into the public API on purpose. Example: `uploads.Part` re-exports the storage part type.

### Public contracts (the whole surface)

| Package | Public API |
|---|---|
| `database` | `Pool` (type), `Querier`, `Shared(ctx)`, `Open`, `InTx`, `Migrate`, `LoadKeys` |
| `batches` | `Create`, `Get`, `Transition` (CAS), `Claim` (lease), `RecordEvent`, `Timeline`, `Recent`, `ValidID`, `Status`, `ErrNotFound` |
| `uploads` | `New(keys, store)`, `NewFromEnv`, `Service.{CreateSession, PresignParts, ListParts, Complete, Abort}`, `ObjectStore`, `ObjectKey`, `BatchIDFromKey`, `InvalidUpload` |
| `ingestion` | `Run(ctx, pool, batchID, key)`, `RunReader`, `ErrorReportCSV`, `ErrorPreview`, `Columns()`, `Result`, `Failed` |
| `orchestration` | `TriggerMatching(ctx, batchID) bool` (best effort), `Sign` |
| `notifications` | `MakeToken`, `VerifyToken`, `Unsubscribe`, `ErrInvalidToken` |
| `reporting` | `GetOverview`, `Products`, `GetBatchSummary` |

---

## 6. How the boundaries are enforced (not just documented)

| Rule | Enforced by |
|---|---|
| Nobody imports another package's private layer | **The Go compiler** (`internal/`) |
| No dependency cycles | **The Go compiler** |
| Package → package edges match the table in §4 | `internal/archtest` |
| Packages never import apps; apps never import each other | `internal/archtest` |
| AWS SDK only inside a package's `internal/` adapter | `internal/archtest` |
| Lambda runtime (`aws-lambda-go`) only in apps (the transport layer) | `internal/archtest` |
| Database driver never in apps (they use `database.Pool`) | `internal/archtest` |
| Environment read only in a package's `keys.go` | `internal/archtest` |

`archtest` was checked against a planted violation: it fails, as it should.

---

## 7. Thin transport layer

```go
func (a *App) completeUpload(ctx context.Context, req request) (response, error) {
	id, err := pathParam(req, "batch_id")   // 1. receive / validate shape
	if err != nil {
		return response{}, err
	}
	done, err := a.Uploads.Complete(ctx, a.DB, id) // 2. call the service
	return ok(http.StatusOK, done), err      // 3. respond — errors become HTTP in ONE place (http.go)
}
```

- No SQL, no AWS SDK and no business rules in handlers.
- Routing is a table keyed by `"METHOD /resource"` in `apps/api/main.go`.
- A handler panic becomes a 500, never a crash loop.
- **n8n follows the same rule:** Code nodes call tested functions from `apps/workflows/src/code/`, and SQL lives in `src/sql/` files.

---

## 8. Instances vs factories

- **Instances** where the service configures itself. `database.Shared(ctx)` is one pool per Lambda container, created in `main` (outside the handler) and reused by every warm invocation. That saves a TLS handshake plus Postgres auth on each request.
- **One factory with a real reason:** `uploads.New(keys, store)`. The store is a genuine runtime dependency (S3 in production, an in-memory fake in tests). `NewFromEnv` wires production.
- **Dependency injection for apps:** `App{DB, Uploads, Now}`. Tests build it with a test database, a fake store and a fixed clock.

---

## 9. Environment variables

- Each package owns its variables in `keys.go` (`LoadKeys`), and fails fast with a clear message.
- **Nothing else reads the environment.** `archtest` checks this.
- n8n gets its secrets through **n8n credentials** and its config through `docker-compose.yml`. Workflow JSON never contains secrets.

| Owner | Variables |
|---|---|
| `database` | `DATABASE_URL` (`sslmode=require` in AWS) |
| `uploads` | `UPLOAD_BUCKET`, `MAX_UPLOAD_BYTES`, `PART_SIZE_BYTES`, `PART_URL_TTL_SECONDS`, `AWS_REGION` |
| `ingestion` | `UPLOAD_BUCKET`, `MAX_INVALID_RATIO`, `MAX_ERROR_ROWS`, `MAX_DECOMPRESSED_BYTES`, `INGEST_LEASE_SECONDS` |
| `orchestration` | `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET` |
| `notifications` | `UNSUBSCRIBE_SECRET` |
| console (build time) | `NEXT_PUBLIC_API_URL` (read in exactly one file, `src/lib/config.ts`) |

---

## 10. Database boundary

- `packages/database` owns **connections and migrations**, nothing domain-specific. Migrations are embedded in every binary with `go:embed`, so a deploy can't run code against a missing migration.
- Each service owns its SQL as unexported functions:
  - `batches` owns `ingest_batches` and `pipeline_events`
  - `ingestion` owns staging, the `users` merge and `ingest_errors`
  - `notifications` owns `suppression`
- **One writer per table.** For n8n: A writes `loan_products`/`crawl_*`, B writes `matches`/`llm_judgments`, C writes `notifications`. `reporting` only reads.

---

## 11. External integrations, isolated

| Capability | Vendor today | Isolation point |
|---|---|---|
| Object storage | S3 | `uploads/internal/s3store` (behind `ObjectStore`), `ingestion/internal/s3reader` |
| Workflow trigger | n8n webhook | `orchestration` (stdlib HTTP; swapping n8n touches one file) |
| LLM | Any OpenAI-compatible API | One n8n credential + `LLM_BASE_URL`/`LLM_MODEL` |
| Email | SES (via the n8n SES node, as the brief requires) | Workflow C only |
| Database | Postgres (RDS / local) | `database` + each package's own SQL |

---

## 12. Testing strategy (boundaries over internals)

| Layer | What | How |
|---|---|---|
| Go packages | Behaviour through public APIs | `go test ./...`; real Postgres with a **fresh database per test** (`internal/testdb`, refuses anything not `*_test`); S3 via an in-memory fake that enforces checksums like S3 |
| Real AWS SDK | Presigned URL is regional and signs the SHA-256 header | Offline test with the real SDK signer |
| Cross-language contracts | Go ⇄ n8n JavaScript: doorbell signatures, unsubscribe tokens byte-identical | Go tests call `node` |
| n8n logic | Matcher, renderer, validators | `node --test` |
| Seams (Go → n8n SQL → JS) | Optimised matching == brute-force oracle on the 10,000-row sample; full crawl→match→email; races | Python harness driving the Go binaries |
| Races | Overlapping parallel uploads; notifiers racing for one person | Real OS processes. **Both tests fail without their fix** |
| Architecture | §6 | `internal/archtest` |
| Console | API client, resumable upload, CSV pre-check, pipeline states | `node --test` on framework-free TS |

---

## 13. Dependency management

- **Go:** one `go.mod`.
  - Runtime deps: `pgx` (Postgres), the AWS SDK v2 (S3 only), `aws-lambda-go`, `x/text` (Windows-1252/UTF-16 decoding), `uuid`.
  - No web framework: one route table is enough.
- **Console:** `next`, `react`, `react-dom`, exact versions pinned.
- **Harness:** `psycopg`, `pytest`, `ruff`. Not shipped.
- **Images:** n8n and Postgres versions pinned in `docker-compose.yml`.

---

## 14. What we deliberately did NOT create (rules 16 & 18)

| Not created | Why |
|---|---|
| `matching` / `catalog` / `email` packages | That logic must live in n8n (brief) |
| `users` package | Users have one writer (ingestion) and are read by n8n via SQL |
| `ai` package | No backend code calls an LLM; n8n does |
| `design-system` | One console app |
| A web framework / router library | One route table and API Gateway's routing are enough |
| One Lambda per route | Shared dependencies → one warm container serves all routes (one cold start, not thirteen) |
| Microservices, Kafka, an event bus | One SQS queue (S3 → ingest) is justified by retries and DLQ; nothing else is |
| Shared "utils" package | Helpers stay in the package that needs them; duplication beats coupling |

---

## 15. Decision priority applied

**Correctness → clear boundaries → maintainability → testability → simplicity → performance → scale.**

- **Correctness:** CAS transitions and a serialised merge beat "just update" and "merge in parallel". Parallel merges were also measured *no faster*.
- **Clear boundaries:** compiler-enforced `internal/` beats a convention plus a lint test.
- **Performance, with proof:** class-based bitset matching and the move to Go were kept only because tests and benchmarks prove them correct and faster.
