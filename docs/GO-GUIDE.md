# Go, Explained Through Our Own Code

> For: someone who knows programming (Python/JS) but not Go.
> Goal: after one read you can open any `.go` file in this repo and explain every line, and *why* it's written that way.
> Every example below is real code from this repo, with the file next to it.

**How to read this:** each topic is **What it is → Our code → Why we did it this way → One-liner you can say out loud**.

---

## 0. The 60-second mental model

- Go compiles to **one native binary**. No interpreter, no `pip install` on the server. Our Lambda ships a ~4 MB file called `bootstrap`, and that's the whole app.
- Go is **statically typed** (the compiler checks types) but feels light, because it **infers types**: `x := 5`.
- Go is **deliberately small**:
  - no classes, no inheritance
  - no exceptions (errors are ordinary return values)
  - no "magic" decorators
  - what you read is what runs
- The tooling decides style, so there are no style debates:
  - `gofmt` formats the code
  - `go vet` catches mistakes
  - `go test` runs the tests

> Say it: "Go gives us a single fast binary, compile-time type checks, and a small language where nothing is hidden."

---

## 1. Modules, packages, and the capital-letter rule

**Module = the whole project.** `go.mod` names it and pins dependency versions (like `package.json` + lockfile; `go.sum` holds checksums).
```go
// go.mod
module loanengine
```
**Package = one folder.** Every `.go` file in a folder starts with the same `package` name. You import a package by its path inside the module:
```go
import "loanengine/packages/batches"   // then use: batches.Get(...)
```

**Exported vs unexported: the first letter decides visibility.** There's no `public`/`private` keyword:
- a name starting with a **Capital** is visible outside the package
- a name starting with a **lowercase** letter is private to the package
```go
func Claim(...)  // packages/batches/batches.go  → exported: other packages can call batches.Claim
func merge(...)  // packages/ingestion/repository.go → unexported: only ingestion can call it
```
**`internal/` folders are compiler-enforced privacy.** Code inside `packages/uploads/internal/s3store` can only be imported by code under `packages/uploads/`. Anyone else gets a **compile error**. That's how our "vendor SDK stays private" rule is guaranteed, not just hoped for.

> Say it: "Capital letter = public API. `internal/` = private, enforced by the compiler. That's our public/private architecture rule for free."

---

## 2. Variables and basic types

```go
x := 5            // declare + infer type (inside functions)
var pool *pgxpool.Pool // declare with explicit type (package level), starts as nil
const sniffBytes = 64 * 1024
```
- Every type has a **zero value**: `0`, `""`, `false`, `nil`. A new variable is never "undefined".
- `int64`, `int32`, `int16`: sized integers. We choose sizes to match Postgres columns (`smallint` → `int16`).

### Money is an integer (paise), never a float
```go
// packages/ingestion/normalize.go
func parseAmount(raw string) (int64, *badValue) // returns PAISE: ₹1,20,000 → 12000000
```
**Why:** floats can't represent 0.1 exactly, so money drifts. Integers are exact. We convert to Postgres `numeric(12,2)` with `pgtype.Numeric{Int: paise, Exp: -2}`, which means "this integer × 10⁻²".

> Say it: "Money is stored as integer paise so no rounding error can ever creep in."

---

## 3. Structs (Go's "objects") and struct tags

A struct is a named bundle of fields, like a Python dataclass:
```go
// packages/batches/batches.go
type Batch struct {
	ID        string  `json:"id"`
	Error     *string `json:"error"`      // pointer → can be nil (SQL NULL)
	RowsTotal *int    `json:"rows_total"`
	CreatedAt time.Time `json:"created_at"`
}
```
- The text in backticks is a **struct tag**. `json:"rows_total"` tells the JSON encoder which key to use. Our API speaks `snake_case` because of these tags.
- **`*string` (a pointer) is how we model "may be NULL".** A plain `string` can't be "missing"; its zero value is `""`, which is a real value. A `*string` can be `nil`, which maps to SQL `NULL` and JSON `null`.

> Say it: "Pointers on struct fields mean 'optional'. That's how a database NULL becomes JSON null."

---

## 4. Defined types, constants, `iota`

```go
type Status string               // a NEW type whose underlying type is string
const (
	Created Status = "CREATED"
	Parsing Status = "PARSING"
)
```
**Why a new type instead of plain `string`:** a function that takes a `Status` won't accidentally accept a random string, so the compiler catches typos in states.

`iota` numbers constants automatically (0, 1, 2…):
```go
// packages/ingestion/rows.go
const (
	colUserID = iota // 0
	colName          // 1
	colEmail         // 2
	...
)
```
We use these as fixed positions in a `[7]string` array: one slot per column, no map lookups in the hot loop.

### Type alias (`=`) vs defined type
```go
type Pool = pgxpool.Pool  // ALIAS: the exact same type, just another name (packages/database)
type Status string        // DEFINED: a brand-new type
```
**Why the alias:** apps write `database.Pool` and never import the database driver. Swapping the driver later touches one package.

---

## 5. Arrays, slices, maps

```go
var raw [7]string           // ARRAY: fixed size, part of the type. Reused for every row, so no allocation
errs := []RowError{}        // SLICE: growable list (like a Python list)
errs = append(errs, e)      // append returns the (possibly new) slice
seen := make(map[string]int, 1<<16) // MAP: hash map, pre-sized for ~65k keys
if prev, dup := seen[id]; dup { ... } // "comma ok": dup tells you whether the key existed
```
- **`seen` is our duplicate detector:** O(1) per row, so we only pay for SQL's slow `DISTINCT ON` sort when duplicates really exist.
- **`1<<16`** is bit-shifting: 2¹⁶ = 65,536. Pre-sizing avoids repeated growth.

---

## 6. Functions: multiple returns and errors as values

Go functions can return several values. The convention: **the last one is an `error`**.
```go
b, err := batches.Get(ctx, pool, id)
if err != nil {
	return response{}, err   // handle or pass up, explicitly, right here
}
```
**There are no exceptions.** Every failure is a value you must look at. It's verbose, but you can see every failure path by reading the code. Nothing jumps invisibly up the stack.

### Three kinds of errors we use
1. **Sentinel error.** A fixed value to compare against:
   ```go
   var ErrNotFound = errors.New("BATCH_NOT_FOUND")           // batches
   if errors.Is(err, batches.ErrNotFound) { /* → 404 */ }    // apps/api/http.go
   ```
2. **Custom error type.** It carries data (a code plus a message):
   ```go
   type InvalidUpload struct{ Code, Message string }          // uploads
   func (e *InvalidUpload) Error() string { return e.Message } // having Error() makes it an error
   var inv *uploads.InvalidUpload
   if errors.As(err, &inv) { status := statusFor[inv.Code] }  // pull the typed error out
   ```
3. **Wrapped error.** It adds context but keeps the original inside:
   ```go
   return nil, fmt.Errorf("parse DATABASE_URL: %w", err)   // %w = wrap (errors.Is/As still see the inner error)
   ```
**`errors.Is`** asks "is this that specific error?". **`errors.As`** asks "is this an error of that type? Then give it to me."

> Say it: "Errors are values. Sentinels for 'which error', typed errors for 'error with data', and `%w` to add context without losing the cause. All HTTP mapping happens in one place: `apps/api/http.go`."

---

## 7. Methods and receivers

A method is a function attached to a type:
```go
// packages/uploads/uploads.go
func (s *Service) Complete(ctx context.Context, q database.Querier, id string) (Completed, error)
```
- `(s *Service)` is the **receiver**: like `self` in Python.
- `*Service` is a **pointer receiver**. The method works on the original value, not a copy, and copying is avoided. That's our default.

---

## 8. Interfaces: the most important idea in Go

An interface is **a list of methods**. Any type that has those methods **automatically** satisfies it. There's no `implements` keyword.
```go
// packages/uploads/uploads.go
type ObjectStore interface {
	Start(ctx context.Context, bucket, key string) (string, error)
	PresignPart(...) (string, map[string]string, error)
	Parts(...) ([]s3store.Part, error)
	Finish(...) error
	Cancel(...) error
}
```
- **Production:** `internal/s3store.Store` has these methods, so it *is* an `ObjectStore`.
- **Tests:** `fakeStore` in `uploads_test.go` has them too, and it even rejects bytes that don't match the checksum, like S3. The service can't tell the difference.

**Our other interfaces:**
- `database.Querier` (Exec/Query/QueryRow/CopyFrom) is satisfied by **both** the pool and a transaction. The same repository code runs inside or outside a transaction.
- **pgx's `CopyFromSource`** (`Next() bool`, `Values()`, `Err()`). Our `source` type in `ingestion/pipeline.go` implements it. Each time Postgres asks "next row?", we read one CSV line, validate it, and hand it over. **That's how 1M rows stream into the database without ever being held in memory.**

> Say it: "Interfaces are small and implicit. Business logic depends on the interface; S3 is one implementation and the test fake is another. That's vendor isolation plus testability in one idea."

---

## 9. `io.Reader`: streaming as Lego bricks

`io.Reader` is a one-method interface: `Read(p []byte) (n int, err error)`. Anything that produces bytes is a Reader, so readers **wrap readers**:
```
S3 body ─► bufio (peek 64 KB) ─► gzip.NewReader? ─► cappedReader (bomb guard) ─► UTF-16/cp1252 decoder ─► csv.Reader ─► COPY
```
From `packages/ingestion/decode.go`:
```go
br := bufio.NewReaderSize(raw, sniffBytes+4096)
head, _ := br.Peek(sniffBytes)                 // LOOK at the first 64 KB without consuming it
if bytes.HasPrefix(head, []byte{0x1f, 0x8b}) { // gzip magic number
	gz, _ := gzip.NewReader(br)
	br = bufio.NewReaderSize(&cappedReader{r: gz, left: maxDecompressed}, ...)
}
```
`cappedReader` is our own 10-line Reader that **errors once too many bytes come out**. A 1 MB gzip can't expand into 100 GB.

`io.MultiReader(a, b)` glues readers end to end. We use it to re-attach the header lines we already consumed while searching for the header row.

> Say it: "Every stage is an `io.Reader` wrapping the previous one, so memory is constant whatever the file size."

---

## 10. `context.Context`: deadlines and cancellation

Almost every function takes `ctx context.Context` as its **first argument**. It carries a deadline and a cancel signal down the call chain.
```go
// packages/orchestration/orchestration.go
ctx, cancel := context.WithTimeout(ctx, keys.Timeout) // 3 seconds
defer cancel()
req, _ := http.NewRequestWithContext(ctx, http.MethodPost, keys.WebhookURL, body)
```
If n8n is slow, the request is abandoned after 3 s. The doorbell is best-effort, and the sweeper is the safety net.

---

## 11. `defer`, `panic`, `recover`

`defer` schedules a call to run **when the function returns, however it returns**. It's Go's `finally`:
```go
body, err := open()
defer body.Close()          // the file/stream always gets closed
```
`panic` is a crash, used only for "impossible" bugs. `recover` catches it inside a deferred function:
```go
// apps/api/main.go
defer func() {
	if r := recover(); r != nil {
		resp = fail(500, "INTERNAL", "something went wrong; please retry")
	}
}()
```
A bug in one handler becomes a 500 response, not a crashed Lambda.

---

## 12. Functions as values, closures, method expressions

Functions are values you can store and pass around. Our **route table** is a map from route to handler:
```go
// apps/api/main.go
var routes = map[string]handlerFunc{
	"GET /v1/overview":                      (*App).overview,  // a "method expression"
	"POST /v1/uploads/{batch_id}/complete":  (*App).completeUpload,
}
```
`(*App).overview` turns a method into a plain function whose first argument is the `*App`. Routing is one map lookup: no framework, no magic.

A **closure** is a function that captures variables around it:
```go
err = database.InTx(ctx, pool, func(tx pgx.Tx) error {
	// everything here runs in ONE transaction; returning an error rolls it all back
})
```

---

## 13. Generics (light use)

`[T any]` means "works for any type T":
```go
func must[T any](v T, err error) T { if err != nil { panic(err) }; return v } // orchestration_test.go
rows, _ := q.Query(...)
s.ByProduct, err = pgx.CollectRows(rows, pgx.RowToStructByPos[ProductMatches]) // reporting.go
```
`RowToStructByPos[ProductMatches]` fills each struct field from the SQL columns in order.

---

## 14. Package-level state done safely: `sync.Once`, `sync.Map`

```go
// packages/database/database.go
var poolOnce sync.Once
func Shared(ctx context.Context) (*pgxpool.Pool, error) {
	poolOnce.Do(func() { pool, poolErr = Open(ctx, keys.URL, 2) }) // runs exactly once per process
	return pool, poolErr
}
```
- **Why:** a Lambda container lives across many requests. Creating the pool **once** and reusing it saves a TLS handshake and a database login (~20–50 ms) on every request.
- **`sync.Map`** is a map that's safe to use from several goroutines at once. We cache "is this email domain deliverable?" (`parseEmail`), because a file has few distinct domains.

---

## 15. Goroutines: why we (almost) don't use them

Goroutines (`go f()`) are Go's famous cheap threads. **We deliberately don't start any in our own code:**
- **Lambda already gives us concurrency.** Each container handles one request; AWS runs more containers under load.
- **Ingest overlap happens without goroutines.** Parsing and database writing overlap through the streaming `CopyFromSource`: Postgres pulls rows while we parse.
- **Parallel merges were measured no faster** (Postgres writes through one log, DESIGN §9.14). So we *serialise* merges with an advisory lock instead.

Less concurrency in our code means fewer race conditions. The races that do matter are handled in the database and tested with real parallel processes.

> Say it: "Concurrency comes from Lambda and Postgres. Our own code stays sequential and easy to reason about."

---

## 16. Strings, bytes, runes, UTF-8

- A Go `string` is **bytes** (usually UTF-8). `len("₹")` is **3**, not 1.
- A **rune** is one Unicode character. To cut a name to 200 *characters* safely:
  ```go
  if r := []rune(name); len(r) > 200 { name = string(r[:200]) } // never cut a ₹ or a Hindi letter in half
  ```
- `utf8.ValidString(v)` rejects bad bytes before they reach Postgres.
- The Excel **BOM** (byte-order mark, `﻿`) is stripped from headers. In source code we always write the *escape* `"﻿"`. The raw invisible character won't compile mid-file.

---

## 17. Standard-library tools we lean on

| Package | Used for | Where |
|---|---|---|
| `encoding/csv` | Parsing (`LazyQuotes` tolerates messy quotes, `ReuseRecord` avoids an allocation per row, `FieldsPerRecord = -1` allows ragged rows) | `ingestion/rows.go` |
| `encoding/json` | API bodies; `json.RawMessage` passes JSONB through untouched | `apps/api`, `batches` |
| `regexp` | Compiled **once** at package level (`regexp.MustCompile`), not per row | `ingestion/normalize.go` |
| `crypto/hmac`, `crypto/sha256` | Doorbell signatures; `hmac.Equal` compares in **constant time** (no timing attack) | `orchestration`, `notifications` |
| `embed` | `//go:embed migrations/*.sql` bakes the SQL into the binary | `database/migrate.go` |
| `log/slog` | Structured JSON logs (`slog.Info("ingested", "batch_id", id)`) | apps |
| `net/http` | The doorbell client; `httptest` fakes a server in tests | `orchestration` |
| `golang.org/x/text` | Decoding Windows-1252 and UTF-16 spreadsheets | `ingestion/decode.go` |

**Newer built-ins you'll see:**
- `min(...)` / `max(...)` (Go 1.21)
- `for range 2 { }` loops twice (Go 1.22)

---

## 18. Talking to Postgres with pgx

```go
// Parameters are $1, $2 — values never touch the SQL text, so SQL injection is impossible
tag, err := q.Exec(ctx, `UPDATE ingest_batches SET status = $1 ... WHERE id = $3::uuid AND status = ANY($4::batch_status_t[])`, ...)
return tag.RowsAffected() == 1, err   // compare-and-set: 1 row = I won, 0 = someone else already moved it
```
- **`QueryRow(...).Scan(&a, &b)`** reads one row into variables. `&a` means "the address of a", so Scan can write into it.
- **`pgx.ErrNoRows`** comes back when there's no row; we turn it into `ErrNotFound`.
- **`CopyFrom`** is Postgres's bulk-load protocol in **binary** form: the fastest way to insert millions of rows.
- **`id = $1::uuid`, not `id::text = $1`:** the second form makes Postgres convert every row's id before comparing, so it can't use the primary-key index and scans the whole table. We validate the id format in Go first (`batches.ValidID`), so garbage input is a clean "not found".

---

## 19. Testing in Go

- Test files end in **`_test.go`** and are left out of the production binary.
- **Two styles:**
  - `package ingestion` (same package) can test private helpers like `parseAmount`
  - `package ingestion_test` (black box) sees only the public API, like a real caller would
- **Table-driven tests:** one loop over many cases:
  ```go
  for raw, paise := range map[string]int64{"₹1,20,000": 12_000_000, "1.2L": 12_000_000, "50k": 5_000_000} {
	if got, b := parseAmount(raw); b != nil || got != paise { t.Errorf("%q → %d", raw, got) }
  }
  ```
- **Useful helpers:**
  - `t.Helper()`: failures point at the caller's line
  - `t.Setenv(...)`: set an environment variable, auto-restored afterwards
  - `t.Cleanup(...)`: run something after the test (we drop the test database)
  - `t.Skip(...)`: skip when Postgres isn't there
  - `t.Run(name, ...)`: subtests
- **`internal/testdb.New(t)`** gives **each test its own fresh database**, so tests can run in parallel without colliding.
- **Commands:** `go test ./...` runs everything. `-v` shows each test. `-run TestName` runs one test.
- **`internal/archtest`** parses our own source code (`go/parser`) to enforce the architecture rules. We checked that it fails on a deliberately planted violation.

---

## 20. Building for Lambda

```bash
# scripts/build_lambdas.sh
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -tags lambda.norpc -trimpath -ldflags="-s -w" -o build/lambda/api/bootstrap ./apps/api
```
| Flag | Meaning | Why |
|---|---|---|
| `GOOS=linux GOARCH=arm64` | Cross-compile for Linux on ARM, from a Mac | Lambda Graviton (cheaper per ms) |
| `CGO_ENABLED=0` | Pure Go, no C libraries | A fully **static** binary; runs anywhere |
| `-tags lambda.norpc` | Leaves out an old RPC layer in the Lambda library | Smaller binary, faster cold start |
| `-trimpath` | Removes local file paths from the binary | Reproducible builds; no laptop paths leaked |
| `-ldflags="-s -w"` | Strips debug symbols | Smaller zip (~4 MB) |

- On Lambda the runtime is `provided.al2023`, and it simply executes the file named **`bootstrap`**.
- `lambda.Start(app.Handle)` hands our function to AWS. Everything *before* that line in `main` (the pool, the S3 client) runs once per container.

---

## 21. Reading our backend in 30 minutes (suggested order)

1. `packages/batches/batches.go`: structs, constants, pgx, compare-and-set. The simplest complete package.
2. `packages/orchestration/orchestration.go`: context timeouts, HMAC, "never fail" design.
3. `packages/uploads/uploads.go` + `internal/s3store`: interfaces and vendor isolation.
4. `packages/ingestion/` in this order: `decode.go` (Readers) → `normalize.go` (parsers) → `rows.go` (CSV) → `validate.go` → `pipeline.go` (the `CopyFromSource`, the transaction, the circuit breaker) → `repository.go` (the serialised merge).
5. `apps/api/main.go` → `http.go` → `handlers.go`: route table, error model, thin handlers.
6. `apps/ingest_worker/main.go`: SQS event → `ingestion.Run`, partial-batch failures.
7. `internal/archtest`: the architecture rules as code.

---

## 22. Ten questions a senior engineer may ask, with short answers

1. **Why no exceptions?** Errors are values, so every failure path is visible in the code, and mapping them to HTTP happens once, in `http.go`.
2. **How do you test without AWS?** Business logic depends on the small `ObjectStore` interface; tests use an in-memory fake that enforces checksums like S3. The real SDK is checked offline for correct signing, and against real S3 once in `smoke_aws.py`.
3. **How does a 1 GB file not run you out of memory?** Every stage is an `io.Reader`, and rows flow into binary `COPY` through `CopyFromSource`. Only the duplicate map grows: ~220 MB per 1M rows.
4. **Why one Lambda for 13 routes?** They share the same dependencies, so one warm container serves them all: one cold start, not thirteen. Routing is a map lookup.
5. **What enforces your package boundaries?** The compiler (`internal/`, no import cycles) plus `internal/archtest` for the dependency table, vendor isolation and environment-variable rules.
6. **Why integer paise?** Floats can't represent decimal money exactly; integers can. Postgres stores it as `numeric(12,2)`.
7. **Why `sync.Once` for the pool?** Lambda reuses containers. Building the pool once avoids a TLS handshake plus a database login per request, and `Once` is safe if two callers race.
8. **Why so few goroutines?** Lambda and Postgres provide the concurrency; sequential code has fewer races. Parallel merges were measured no faster anyway.
9. **How do you stop SQL injection?** Only `$1`-style parameters. The only text ever spliced into SQL is from a fixed list in our own code (column names, the `staging_users` source), never user input.
10. **Why Go over Python here?** Measured: 1M-row ingest takes 6.0–6.8 s in Go vs 15.0 s in tuned Python, with faster cold starts, a single binary and compiler-enforced boundaries (DESIGN §9.15). Python stays as the test/eval harness, where its ecosystem is strongest.
