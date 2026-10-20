// Package database owns connections, transactions and schema migrations.
//
// Infrastructure layer: it knows nothing about business concepts. Each service package owns its
// own SQL and receives a Querier (a pool or a transaction) from here.
package database

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Pool is the connection pool type (an alias, so apps depend on this package, not on the driver).
type Pool = pgxpool.Pool

// Querier is what repositories need: satisfied by both the pool and a transaction, so the same
// repository code runs inside or outside a transaction.
type Querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	CopyFrom(ctx context.Context, table pgx.Identifier, columns []string, src pgx.CopyFromSource) (int64, error)
}

var (
	poolOnce sync.Once
	pool     *pgxpool.Pool
	poolErr  error
)

// Shared returns the process-wide pool (one per warm Lambda container), created on first use.
//
// Why a tiny pool: a Lambda container serves one request at a time, so 2 connections cover the
// request plus a concurrent helper. Reuse across invocations saves a TLS handshake and an auth
// round trip (~20–50 ms to RDS) per request. At Tier 2, RDS Proxy multiplexes containers.
func Shared(ctx context.Context) (*pgxpool.Pool, error) {
	poolOnce.Do(func() {
		keys, err := LoadKeys()
		if err != nil {
			poolErr = err
			return
		}
		pool, poolErr = Open(ctx, keys.URL, 2)
	})
	return pool, poolErr
}

// Open creates a pool for an explicit URL (CLIs and tests).
func Open(ctx context.Context, url string, maxConns int32) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	cfg.MaxConns = maxConns
	cfg.ConnConfig.ConnectTimeout = 5 * time.Second
	cfg.ConnConfig.RuntimeParams["application_name"] = "loan-engine"
	// A runaway query must not hold a Lambda (or a lock) for 15 minutes.
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "300000"
	return pgxpool.NewWithConfig(ctx, cfg)
}

// InTx runs fn atomically: commit on success, rollback on any error or panic.
func InTx(ctx context.Context, p *pgxpool.Pool, fn func(pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, p, fn)
}
