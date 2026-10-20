package ingestion

import (
	"bufio"
	"encoding/csv"
	"errors"
	"io"
	"strings"
)

const headLines = 20 // a title or notes block above the header is common in exported reports

var delimiters = []rune{',', ';', '\t', '|'}

// rowReader finds the header row and delimiter, then streams data rows with the row numbers the
// user sees in Excel (header row included), so error reports point at the right row.
type rowReader struct {
	csv       *csv.Reader
	index     [7]int // position of each column (in `columns` order); -1 = absent
	headerRow int
}

const (
	colUserID = iota
	colName
	colEmail
	colIncome
	colCredit
	colEmployment
	colAge
)

func newRowReader(text io.Reader) (*rowReader, error) {
	br := bufio.NewReaderSize(text, 1<<20)
	var head []string
	for len(head) < headLines {
		line, err := br.ReadString('\n')
		if line != "" {
			head = append(head, line)
		}
		if err != nil {
			break
		}
	}
	delim, idx, mapping := findHeader(head)
	if mapping == nil {
		return nil, fail("HEADER_NOT_FOUND", "no header row found; expected columns like user_id, email, monthly_income, "+
			"credit_score, employment_status, age")
	}
	var missing []string
	for _, c := range columns {
		if _, ok := mapping[c.Name]; c.Required && !ok {
			missing = append(missing, c.Name)
		}
	}
	if len(missing) > 0 {
		return nil, fail("MISSING_COLUMNS", "required column(s) not found: "+strings.Join(missing, ", "))
	}
	r := csv.NewReader(io.MultiReader(strings.NewReader(strings.Join(head[idx+1:], "")), br))
	r.Comma, r.LazyQuotes, r.FieldsPerRecord, r.ReuseRecord = delim, true, -1, true
	rr := &rowReader{csv: r, headerRow: idx + 1}
	for i, c := range columns {
		rr.index[i] = -1
		if pos, ok := mapping[c.Name]; ok {
			rr.index[i] = pos
		}
	}
	return rr, nil
}

// findHeader tries every delimiter on the first lines; the row matching the most known columns wins.
func findHeader(head []string) (rune, int, map[string]int) {
	bestHits, bestDelim, bestIdx := 0, ',', 0
	var best map[string]int
	for _, d := range delimiters {
		for i, line := range head {
			r := csv.NewReader(strings.NewReader(line))
			r.Comma, r.LazyQuotes, r.FieldsPerRecord = d, true, -1
			cells, err := r.Read()
			if err != nil {
				continue
			}
			if m := mapHeader(cells); len(m) > bestHits {
				bestHits, bestDelim, bestIdx, best = len(m), d, i, m
			}
		}
	}
	if bestHits < 3 {
		return ',', 0, nil
	}
	return bestDelim, bestIdx, best
}

// next returns the next non-blank data row as raw cells in `columns` order.
func (r *rowReader) next(out *[7]string) (rowNumber int, err error) {
	for {
		rec, err := r.csv.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return 0, io.EOF
			}
			var pe *csv.ParseError
			if errors.As(err, &pe) {
				return 0, fail("BAD_CSV", "the file isn't valid CSV near row "+itoa(r.headerRow+pe.Line))
			}
			return 0, err
		}
		blank := true
		for _, cell := range rec {
			if strings.TrimSpace(cell) != "" {
				blank = false
				break
			}
		}
		if blank {
			continue // trailing empty rows from Excel
		}
		for i, pos := range r.index {
			if pos >= 0 && pos < len(rec) {
				out[i] = rec[pos]
			} else {
				out[i] = ""
			}
		}
		line, _ := r.csv.FieldPos(0)
		return r.headerRow + line, nil
	}
}
