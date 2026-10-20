package ingestion

import (
	"strconv"
	"unicode/utf8"
)

// userRecord is one clean row, ready for COPY.
type userRecord struct {
	userID, name, email, employment string
	deliverable                     bool
	incomePaise                     int64
	credit                          int // 0 = new-to-credit (NULL in the database)
	age                             int
}

// RowError is one problem in one cell. Every problem in a row is reported, not just the first.
type RowError struct {
	Row      int     `json:"row"`
	Column   *string `json:"column"`
	Code     string  `json:"code"`
	Problem  string  `json:"problem"`
	RawValue *string `json:"value_found"`
}

var columnNames = func() [7]string {
	var n [7]string
	for i, c := range columns {
		n[i] = c.Name
	}
	return n
}()

// validate is the per-row hot path: no allocations beyond the record and its strings.
func validate(row int, raw *[7]string) (userRecord, []RowError, error) {
	for _, v := range raw {
		if !utf8.ValidString(v) {
			return userRecord{}, nil, fail("BAD_ENCODING", "the file's text encoding could not be read; save it as 'CSV UTF-8'")
		}
	}
	var errs []RowError
	note := func(col int, b *badValue) {
		if b != nil {
			name, val := columnNames[col], raw[col]
			if len(val) > 200 {
				val = val[:200]
			}
			errs = append(errs, RowError{Row: row, Column: &name, Code: b.code, Problem: b.message, RawValue: &val})
		}
	}
	var rec userRecord
	var b *badValue
	rec.userID, b = parseUserID(raw[colUserID])
	note(colUserID, b)
	rec.email, rec.deliverable, b = parseEmail(raw[colEmail])
	note(colEmail, b)
	rec.incomePaise, b = parseAmount(raw[colIncome])
	note(colIncome, b)
	rec.credit, b = parseCreditScore(raw[colCredit])
	note(colCredit, b)
	rec.employment, b = parseEmployment(raw[colEmployment])
	note(colEmployment, b)
	rec.age, b = parseAge(raw[colAge])
	note(colAge, b)
	if errs != nil {
		return userRecord{}, errs, nil
	}
	rec.name = parseName(raw[colName])
	return rec, nil, nil
}

func itoa(n int) string { return strconv.Itoa(n) }
