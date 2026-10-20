// Package batches is the lifecycle of one upload, from CREATED to DONE.
//
// Every status change is a compare-and-set, so duplicate S3 events, SQS redeliveries and
// concurrent workers can never move a batch twice. The timeline (pipeline_events) is the audit
// trail the console shows and the funnel metrics come from.
package batches

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"loanengine/packages/database"
)

type Status string

const (
	Created   Status = "CREATED"   // upload session started, parts may be arriving
	Uploaded  Status = "UPLOADED"  // S3 assembled the object
	Parsing   Status = "PARSING"   // ingest worker holds the lease
	Loaded    Status = "LOADED"    // users merged; waiting for workflow B
	Matching  Status = "MATCHING"  // workflow B holds the lease
	Matched   Status = "MATCHED"   // matches written; workflow C running
	Notifying Status = "NOTIFYING" // workflow C sending
	Done      Status = "DONE"
	Failed    Status = "FAILED"
	Aborted   Status = "ABORTED"
)

var ErrNotFound = errors.New("BATCH_NOT_FOUND")

type Batch struct {
	ID           string    `json:"id"`
	Filename     string    `json:"filename"`
	S3Key        string    `json:"s3_key"`
	UploadID     *string   `json:"upload_id"`
	SizeBytes    int64     `json:"size_bytes"`
	Status       Status    `json:"status"`
	Error        *string   `json:"error"`
	RowsTotal    *int      `json:"rows_total"`
	RowsValid    *int      `json:"rows_valid"`
	RowsRejected *int      `json:"rows_rejected"`
	RowsInserted *int      `json:"rows_inserted"`
	RowsUpdated  *int      `json:"rows_updated"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// Fields are the columns a transition may set alongside the status (nil = leave unchanged).
type Fields struct {
	Error                                                         *string
	RowsTotal, RowsValid, RowsRejected, RowsInserted, RowsUpdated *int
}

type Event struct {
	Stage  string          `json:"stage"`
	Status string          `json:"status"`
	Detail json.RawMessage `json:"detail"`
	At     time.Time       `json:"at"`
}

// Summary is one row of the upload history.
type Summary struct {
	ID           string    `json:"id"`
	Filename     string    `json:"filename"`
	Status       Status    `json:"status"`
	SizeBytes    int64     `json:"size_bytes"`
	RowsTotal    *int      `json:"rows_total"`
	RowsValid    *int      `json:"rows_valid"`
	RowsRejected *int      `json:"rows_rejected"`
	RowsInserted *int      `json:"rows_inserted"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func Create(ctx context.Context, q database.Querier, id, filename, s3Key string, sizeBytes int64, uploadID, sha256 *string) error {
	if _, err := q.Exec(ctx, `INSERT INTO ingest_batches (id, filename, s3_key, size_bytes, upload_id, file_sha256)
		VALUES ($1, $2, $3, $4, $5, $6)`, id, filename, s3Key, sizeBytes, uploadID, sha256); err != nil {
		return err
	}
	return RecordEvent(ctx, q, id, "upload", "started", map[string]any{"filename": filename, "size_bytes": sizeBytes})
}

// ValidID reports whether id is a UUID. Callers with untrusted ids check first, so a malformed
// id is "not found" rather than a database error, and every lookup can use the primary key.
func ValidID(id string) bool {
	_, err := uuid.Parse(id)
	return err == nil
}

func Get(ctx context.Context, q database.Querier, id string) (Batch, error) {
	if !ValidID(id) {
		return Batch{}, ErrNotFound
	}
	var b Batch
	err := q.QueryRow(ctx, `SELECT id::text, filename, s3_key, upload_id, size_bytes, status::text, error, rows_total,
		rows_valid, rows_rejected, rows_inserted, rows_updated, created_at, updated_at
		FROM ingest_batches WHERE id = $1::uuid`, id).Scan(
		&b.ID, &b.Filename, &b.S3Key, &b.UploadID, &b.SizeBytes, &b.Status, &b.Error, &b.RowsTotal,
		&b.RowsValid, &b.RowsRejected, &b.RowsInserted, &b.RowsUpdated, &b.CreatedAt, &b.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Batch{}, ErrNotFound
	}
	return b, err
}

// Transition moves the batch to `to` only if it is currently in one of `from`. False means another
// actor got there first — callers treat that as "not my job", which makes duplicates harmless.
func Transition(ctx context.Context, q database.Querier, id string, from []Status, to Status, f Fields) (bool, error) {
	sets, args := []string{"status = $1", "updated_at = now()"}, []any{string(to)}
	add := func(col string, v any) {
		args = append(args, v)
		sets = append(sets, fmt.Sprintf("%s = $%d", col, len(args)))
	}
	if f.Error != nil {
		add("error", *f.Error)
	}
	for col, v := range map[string]*int{"rows_total": f.RowsTotal, "rows_valid": f.RowsValid, "rows_rejected": f.RowsRejected,
		"rows_inserted": f.RowsInserted, "rows_updated": f.RowsUpdated} {
		if v != nil {
			add(col, *v)
		}
	}
	args = append(args, id, statusStrings(from))
	tag, err := q.Exec(ctx, fmt.Sprintf(`UPDATE ingest_batches SET %s
		WHERE id = $%d::uuid AND status = ANY($%d::batch_status_t[])`, strings.Join(sets, ", "), len(args)-1, len(args)), args...)
	return tag.RowsAffected() == 1, err
}

// Claim takes exclusive ownership for `lease`. It succeeds if the batch is in one of `from`, OR is
// already in `to` with an expired lease — crash recovery: a worker that died leaves an expired
// lease behind, and the redelivered message reclaims the batch instead of finding it stuck.
func Claim(ctx context.Context, q database.Querier, id string, from []Status, to Status, lease time.Duration) (bool, error) {
	tag, err := q.Exec(ctx, `UPDATE ingest_batches
		SET status = $1, lease_until = now() + make_interval(secs => $2), updated_at = now()
		WHERE id = $3::uuid AND (status = ANY($4::batch_status_t[]) OR (status = $1 AND lease_until < now()))`,
		string(to), lease.Seconds(), id, statusStrings(from))
	return tag.RowsAffected() == 1, err
}

func RecordEvent(ctx context.Context, q database.Querier, id, stage, status string, detail any) error {
	if detail == nil {
		detail = map[string]any{}
	}
	body, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	_, err = q.Exec(ctx, "INSERT INTO pipeline_events (batch_id, stage, status, detail) VALUES ($1::uuid, $2, $3, $4)",
		id, stage, status, body)
	return err
}

func Timeline(ctx context.Context, q database.Querier, id string) ([]Event, error) {
	if !ValidID(id) {
		return nil, ErrNotFound
	}
	rows, err := q.Query(ctx, "SELECT stage, status, detail, at FROM pipeline_events WHERE batch_id = $1::uuid ORDER BY id", id)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Event, error) {
		var e Event
		return e, r.Scan(&e.Stage, &e.Status, &e.Detail, &e.At)
	})
}

// Recent lists the latest uploads (index: ingest_batches_created_idx).
func Recent(ctx context.Context, q database.Querier, limit int) ([]Summary, error) {
	limit = max(1, min(limit, 100))
	rows, err := q.Query(ctx, `SELECT id::text, filename, status::text, size_bytes, rows_total, rows_valid, rows_rejected,
		rows_inserted, created_at, updated_at FROM ingest_batches ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Summary, error) {
		var s Summary
		return s, r.Scan(&s.ID, &s.Filename, &s.Status, &s.SizeBytes, &s.RowsTotal, &s.RowsValid, &s.RowsRejected,
			&s.RowsInserted, &s.CreatedAt, &s.UpdatedAt)
	})
}

func statusStrings(ss []Status) []string {
	out := make([]string, len(ss))
	for i, s := range ss {
		out[i] = string(s)
	}
	return out
}
