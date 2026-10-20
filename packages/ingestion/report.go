package ingestion

import (
	"bytes"
	"context"
	"encoding/csv"
	"strconv"
	"strings"

	"loanengine/packages/database"
)

// ErrorReportCSV is the downloadable error report: opens correctly in Excel and is safe to open.
func ErrorReportCSV(ctx context.Context, q database.Querier, batchID string) ([]byte, error) {
	errs, err := loadErrors(ctx, q, batchID, 1_000_000)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	buf.WriteString("\ufeff") // UTF-8 BOM: without it Excel shows ₹ and Hindi/Gujarati names as mojibake
	w := csv.NewWriter(&buf)
	_ = w.Write([]string{"row", "column", "code", "problem", "value_found"})
	for _, e := range errs {
		_ = w.Write([]string{strconv.Itoa(e.Row), safe(deref(e.Column)), safe(e.Code), safe(e.Problem), safe(deref(e.RawValue))})
	}
	w.Flush()
	return buf.Bytes(), w.Error()
}

// ErrorPreview is the first rows of the report, shown inline on the batch page.
func ErrorPreview(ctx context.Context, q database.Querier, batchID string, limit int) ([]RowError, error) {
	errs, err := loadErrors(ctx, q, batchID, limit)
	if errs == nil {
		errs = []RowError{}
	}
	return errs, err
}

// safe guards against CSV formula injection: '=HYPERLINK(...)' must not execute in Excel.
func safe(v string) string {
	if v != "" && strings.ContainsAny(v[:1], "=+-@\t\r") {
		return "'" + v
	}
	return v
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
