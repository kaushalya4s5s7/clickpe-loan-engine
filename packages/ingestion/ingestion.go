// Package ingestion turns an uploaded spreadsheet into clean rows in `users`.
//
// decode (gzip/BOM/encoding) → find header (aliases, delimiter) → normalise (₹1,20,000, 1.2L, "NA"
// credit = new-to-credit) → validate → streaming binary COPY into staging → one serialised merge.
// Bad rows are reported, never silently dropped; a mostly-bad file is rejected whole.
package ingestion

// Result is the outcome of one ingest.
type Result struct {
	BatchID      string `json:"batch_id"`
	Status       string `json:"status"` // LOADED | FAILED | SKIPPED (duplicate delivery)
	RowsTotal    int    `json:"rows_total"`
	RowsValid    int    `json:"rows_valid"`
	RowsRejected int    `json:"rows_rejected"`
	RowsInserted int    `json:"rows_inserted"` // new users
	RowsUpdated  int    `json:"rows_updated"`  // existing users whose values changed (unchanged rows aren't touched)
	Duplicates   int    `json:"duplicates"`    // same user_id repeated in the file (last row wins)
	Error        string `json:"error,omitempty"`
	ElapsedMS    int64  `json:"elapsed_ms"`
}

// Failed means the file as a whole is unusable (wrong columns, too many bad rows, bad encoding).
type Failed struct{ Code, Message string }

func (f *Failed) Error() string { return f.Code + ": " + f.Message }

func fail(code, msg string) *Failed { return &Failed{Code: code, Message: msg} }
