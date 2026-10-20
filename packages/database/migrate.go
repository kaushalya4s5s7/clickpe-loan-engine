package database

import (
	"context"
	"embed"
	"io/fs"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The schema ships inside every binary: a deploy can never run code against a missing migration file.
//
//go:embed migrations/*.sql
var migrationFiles embed.FS

const migrationLock = 727_001 // fixed key: "schema migration" in pg_locks

// Migrate applies pending migrations in filename order, each exactly once, and returns their
// names. An advisory lock serialises concurrent runners (two deploys can't double-apply).
func Migrate(ctx context.Context, p *pgxpool.Pool) ([]string, error) {
	names, err := fs.Glob(migrationFiles, "migrations/*.sql")
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	var applied []string
	err = InTx(ctx, p, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", migrationLock); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
			name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
			return err
		}
		for _, path := range names {
			name := path[len("migrations/"):]
			var done bool
			if err := tx.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name = $1)", name).Scan(&done); err != nil {
				return err
			}
			if done {
				continue
			}
			body, err := migrationFiles.ReadFile(path)
			if err != nil {
				return err
			}
			// Simple protocol: a migration file may hold many statements (and DO $$ blocks).
			if _, err := tx.Conn().PgConn().Exec(ctx, string(body)).ReadAll(); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations (name) VALUES ($1)", name); err != nil {
				return err
			}
			applied = append(applied, name)
		}
		return nil
	})
	return applied, err
}
