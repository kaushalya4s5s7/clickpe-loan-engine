package ingestion

import (
	"context"
	"math/big"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"loanengine/packages/database"
)

// All SQL owned by ingestion: staging, the users merge, and ingest_errors.

var stagingColumns = []string{"row_number", "user_id", "name", "email", "email_deliverable", "monthly_income",
	"credit_score", "employment_status", "age"}

func createStaging(ctx context.Context, tx pgx.Tx) error {
	// TEMP: private to this session (concurrent batches can't collide), not WAL-logged (fast), and
	// ON COMMIT DROP cleans up even though the connection is reused by the next invocation.
	_, err := tx.Exec(ctx, `CREATE TEMP TABLE staging_users (
		row_number int, user_id text, name text, email text, email_deliverable boolean,
		monthly_income numeric(12,2), credit_score smallint, employment_status text, age smallint
	) ON COMMIT DROP`)
	return err
}

// copyValues converts a record to binary-COPY values (money as an exact numeric with 2 decimals).
func copyValues(row int, r userRecord) []any {
	var credit any
	if r.credit > 0 {
		credit = int16(r.credit)
	}
	var name any
	if r.name != "" {
		name = r.name
	}
	income := pgtype.Numeric{Int: big.NewInt(r.incomePaise), Exp: -2, Valid: true}
	return []any{int32(row), r.userID, name, r.email, r.deliverable, income, credit, r.employment, int16(r.age)}
}

const mergeLock = 727_002 // "a merge into users is running"

// merge applies staging → users and returns (inserted, updated).
//
// Concurrency: merges are SERIALISED with a transaction-scoped advisory lock. Measured on 1M rows,
// 4 or 8 parallel merges were no faster than one (Postgres funnels writes through one WAL), so
// serialising costs no throughput, and it removes every cross-batch race: no deadlocks between
// uploads touching the same people in different orders, no duplicate-key failures when two files
// add the same new person, and a clear rule (the batch that commits last wins). Parsing,
// validation and COPY of concurrent uploads still run in parallel. (docs/DESIGN.md §9.14)
//
// Speed: UPDATE-then-plain-INSERT avoids ON CONFLICT's speculative insertion on every row (safe
// because of the lock); DISTINCT ON's sort runs only if the file really has duplicate user_ids;
// unchanged rows are not rewritten, so only real changes get this batch's id.
func merge(ctx context.Context, tx pgx.Tx, batchID string, hasDuplicates bool) (inserted, updated int64, err error) {
	for _, stmt := range []string{
		"SELECT pg_advisory_xact_lock(" + itoa(mergeLock) + ")",
		"SET LOCAL work_mem = '256MB'",
		"ANALYZE staging_users", // temp tables have no stats; without this the planner guesses
	} {
		if _, err = tx.Exec(ctx, stmt); err != nil {
			return
		}
	}
	source := "staging_users"
	if hasDuplicates {
		source = "(SELECT DISTINCT ON (user_id) * FROM staging_users ORDER BY user_id, row_number DESC)"
	}
	tag, err := tx.Exec(ctx, `UPDATE users u SET
		name = s.name, email = s.email, email_deliverable = s.email_deliverable,
		monthly_income = s.monthly_income, credit_score = s.credit_score,
		employment_status = s.employment_status::employment_t, age = s.age,
		last_batch_id = $1::uuid, updated_at = now()
	FROM `+source+` s
	WHERE u.user_id = s.user_id
	  AND (u.name, u.email, u.monthly_income, u.credit_score, u.employment_status::text, u.age)
	      IS DISTINCT FROM (s.name, s.email, s.monthly_income, s.credit_score, s.employment_status, s.age)`, batchID)
	if err != nil {
		return
	}
	updated = tag.RowsAffected()
	tag, err = tx.Exec(ctx, `INSERT INTO users (user_id, name, email, email_deliverable, monthly_income, credit_score,
		employment_status, age, last_batch_id)
	SELECT s.user_id, s.name, s.email, s.email_deliverable, s.monthly_income, s.credit_score,
	       s.employment_status::employment_t, s.age, $1::uuid
	FROM `+source+` s
	WHERE NOT EXISTS (SELECT 1 FROM users x WHERE x.user_id = s.user_id)
	ORDER BY s.user_id`, batchID) // sorted inserts keep primary-key B-tree writes local
	if err != nil {
		return
	}
	return tag.RowsAffected(), updated, nil
}

func saveErrors(ctx context.Context, q database.Querier, batchID string, errs []RowError) error {
	if len(errs) == 0 {
		return nil
	}
	id := pgtype.UUID{Bytes: uuid.MustParse(batchID), Valid: true}
	_, err := q.CopyFrom(ctx, pgx.Identifier{"ingest_errors"},
		[]string{"batch_id", "line_no", "column_name", "code", "message", "raw_value"},
		pgx.CopyFromSlice(len(errs), func(i int) ([]any, error) {
			e := errs[i]
			return []any{id, int32(e.Row), e.Column, e.Code, e.Problem, e.RawValue}, nil
		}))
	return err
}

func loadErrors(ctx context.Context, q database.Querier, batchID string, limit int) ([]RowError, error) {
	rows, err := q.Query(ctx, `SELECT line_no, column_name, code, message, raw_value FROM ingest_errors
		WHERE batch_id = $1::uuid ORDER BY line_no, column_name LIMIT $2`, batchID, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (RowError, error) {
		var e RowError
		return e, r.Scan(&e.Row, &e.Column, &e.Code, &e.Problem, &e.RawValue)
	})
}
