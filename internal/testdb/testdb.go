// Package testdb gives each test a fresh, fully migrated Postgres database.
//
// Tests run against REAL Postgres (COPY, ON CONFLICT, enum casts and advisory locks are exactly
// where fakes lie). Each test gets its own database, so test packages can run in parallel.
package testdb

import (
	"context"
	"fmt"
	"math/rand/v2"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"loanengine/packages/database"
)

const defaultURL = "postgresql://postgres:postgres@localhost:5432/loan_engine_test"

// New creates database "<base>_<random>", migrates it, and drops it when the test ends.
func New(t testing.TB) (*pgxpool.Pool, string) {
	t.Helper()
	ctx := context.Background()
	base := os.Getenv("TEST_DATABASE_URL")
	if base == "" {
		base = defaultURL
	}
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	baseName := strings.TrimPrefix(u.Path, "/")
	if !strings.HasSuffix(baseName, "_test") {
		t.Fatalf("refusing: TEST_DATABASE_URL must name a *_test database, got %q", baseName)
	}
	admin, err := pgx.Connect(ctx, base)
	if err != nil {
		t.Skipf("no test Postgres at %s: %v", base, err)
	}
	defer admin.Close(ctx)
	name := fmt.Sprintf("%s_%08x", baseName, rand.Uint32())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	testURL := u.String()
	pool, err := database.Open(ctx, testURL, 8)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		if c, err := pgx.Connect(ctx, base); err == nil {
			_, _ = c.Exec(ctx, "DROP DATABASE IF EXISTS "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)")
			_ = c.Close(ctx)
		}
	})
	return pool, testURL
}
