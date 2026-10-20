package ingestion

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"loanengine/packages/batches"
	"loanengine/packages/database"
	"loanengine/packages/ingestion/internal/s3reader"
	"loanengine/packages/orchestration"
)

const (
	earlyAbortAfter = 1_000 // rows seen before the early check
	earlyAbortRatio = 0.5   // >50% bad in the first 1,000 rows = wrong file; stop reading now
)

// tally counts rows and keeps the first N errors. `seen` finds duplicate user_ids while
// streaming (O(1) per row), which lets the merge skip a 1M-row sort when there are none.
type tally struct {
	total, valid, rejected, duplicates int
	errors                             []RowError
	maxKept                            int
	seen                               map[string]int
}

func (t *tally) keep(errs ...RowError) {
	if room := t.maxKept - len(t.errors); room > 0 {
		t.errors = append(t.errors, errs[:min(room, len(errs))]...)
	}
}

// source streams validated rows into COPY: the file is never held in memory.
type source struct {
	rows   *rowReader
	t      *tally
	raw    [7]string
	values []any
	err    error
}

func (s *source) Next() bool {
	for {
		row, err := s.rows.next(&s.raw)
		if err != nil {
			if !errors.Is(err, io.EOF) {
				s.err = err
			}
			return false
		}
		s.t.total++
		rec, rowErrs, err := validate(row, &s.raw)
		if err != nil {
			s.err = err
			return false
		}
		if rowErrs != nil {
			s.t.rejected++
			s.t.keep(rowErrs...)
		}
		if s.t.total == earlyAbortAfter && float64(s.t.rejected)/float64(s.t.total) > earlyAbortRatio {
			s.err = fail("TOO_MANY_INVALID_ROWS", fmt.Sprintf("%d of the first %d rows are invalid — wrong file?", s.t.rejected, s.t.total))
			return false
		}
		if rowErrs != nil {
			continue
		}
		s.t.valid++
		if prev, dup := s.t.seen[rec.userID]; dup {
			s.t.duplicates++
			col, val := "user_id", rec.userID
			s.t.keep(RowError{Row: prev, Column: &col, Code: "DUPLICATE_USER_ID",
				Problem: fmt.Sprintf("user_id repeated; row %d was used instead", row), RawValue: &val})
		}
		s.t.seen[rec.userID] = row
		s.values = copyValues(row, rec)
		return true
	}
}

func (s *source) Values() ([]any, error) { return s.values, nil }
func (s *source) Err() error             { return s.err }

// Run ingests an uploaded object from storage (called by the SQS worker).
func Run(ctx context.Context, pool *database.Pool, batchID, key string) (Result, error) {
	keys := LoadKeys()
	return run(ctx, pool, batchID, keys, func() (io.ReadCloser, error) { return s3reader.Open(ctx, keys.Bucket, key) })
}

// RunReader ingests a local stream (CLI, tests). Same pipeline, different source.
func RunReader(ctx context.Context, pool *database.Pool, batchID string, r io.Reader) (Result, error) {
	return run(ctx, pool, batchID, LoadKeys(), func() (io.ReadCloser, error) { return io.NopCloser(r), nil })
}

func run(ctx context.Context, pool *database.Pool, batchID string, keys Keys, open func() (io.ReadCloser, error)) (Result, error) {
	started := time.Now()
	res := Result{BatchID: batchID}
	// CREATED is accepted too: the S3 event can arrive before uploads.Complete commits UPLOADED.
	claimed, err := batches.Claim(ctx, pool, batchID, []batches.Status{batches.Created, batches.Uploaded}, batches.Parsing, keys.Lease)
	if err != nil {
		return res, err
	}
	if !claimed {
		slog.Info("batch already claimed or finished; skipping duplicate delivery", "batch_id", batchID)
		res.Status = "SKIPPED"
		return res, nil
	}
	_ = batches.RecordEvent(ctx, pool, batchID, "ingest", "started", nil)

	t := &tally{maxKept: keys.MaxErrorRows, seen: make(map[string]int, 1<<16)}
	var encoding string
	err = database.InTx(ctx, pool, func(tx pgx.Tx) error {
		if err := createStaging(ctx, tx); err != nil {
			return err
		}
		body, err := open()
		if err != nil {
			return err
		}
		defer body.Close()
		text, enc, err := openText(body, keys.MaxDecompressed)
		if err != nil {
			return err
		}
		encoding = enc
		rows, err := newRowReader(text)
		if err != nil {
			return err
		}
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"staging_users"}, stagingColumns, &source{rows: rows, t: t}); err != nil {
			return err
		}
		if err := circuitBreaker(t, keys.MaxInvalidRatio); err != nil {
			return err
		}
		hasDuplicates := t.duplicates > 0
		t.seen = nil // free the map before the merge
		inserted, updated, err := merge(ctx, tx, batchID, hasDuplicates)
		if err != nil {
			return err
		}
		res.RowsInserted, res.RowsUpdated = int(inserted), int(updated)
		// Same transaction as the merge: users and the LOADED status commit together or not at all.
		if _, err := batches.Transition(ctx, tx, batchID, []batches.Status{batches.Parsing}, batches.Loaded, batches.Fields{
			RowsTotal: &t.total, RowsValid: &t.valid, RowsRejected: &t.rejected, RowsInserted: &res.RowsInserted,
			RowsUpdated: &res.RowsUpdated}); err != nil {
			return err
		}
		return batches.RecordEvent(ctx, tx, batchID, "ingest", "loaded", map[string]any{"encoding": encoding,
			"rows_total": t.total, "rows_valid": t.valid, "rows_rejected": t.rejected, "inserted": inserted, "updated": updated,
			"duplicates": t.duplicates, "ms": time.Since(started).Milliseconds()})
	})
	res.RowsTotal, res.RowsValid, res.RowsRejected, res.Duplicates = t.total, t.valid, t.rejected, t.duplicates
	res.ElapsedMS = time.Since(started).Milliseconds()

	var failed *Failed
	if errors.As(err, &failed) {
		_ = saveErrors(ctx, pool, batchID, t.errors)
		msg := failed.Error()
		_, _ = batches.Transition(ctx, pool, batchID, []batches.Status{batches.Parsing}, batches.Failed,
			batches.Fields{Error: &msg, RowsTotal: &t.total, RowsValid: &t.valid, RowsRejected: &t.rejected})
		_ = batches.RecordEvent(ctx, pool, batchID, "ingest", "failed", map[string]string{"code": failed.Code, "message": failed.Message})
		res.Status, res.Error = string(batches.Failed), failed.Message
		return res, nil
	}
	if err != nil {
		// Infrastructure failure (DB down, S3 timeout): propagate. SQS redelivers, the expired lease
		// lets the retry reclaim the batch, and after 3 attempts the message lands in the DLQ.
		return res, err
	}
	if err := saveErrors(ctx, pool, batchID, t.errors); err != nil {
		slog.Warn("could not save row errors", "batch_id", batchID, "err", err)
	}
	res.Status = string(batches.Loaded)
	status := "awaiting_sweeper"
	if orchestration.TriggerMatching(ctx, batchID) {
		status = "matching_triggered"
	}
	_ = batches.RecordEvent(ctx, pool, batchID, "ingest", status, nil)
	return res, nil
}

func circuitBreaker(t *tally, maxRatio float64) error {
	if t.total == 0 {
		return fail("NO_ROWS", "the file has a header but no data rows")
	}
	if t.valid == 0 || float64(t.rejected)/float64(t.total) > maxRatio {
		return fail("TOO_MANY_INVALID_ROWS", fmt.Sprintf("%d of %d rows are invalid (limit %.0f%%); nothing was saved — "+
			"fix the file using the error report and upload again", t.rejected, t.total, maxRatio*100))
	}
	return nil
}
