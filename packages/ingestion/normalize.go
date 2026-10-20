package ingestion

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// Header aliases and value parsers for real-world (Indian) spreadsheets. Pure functions; each
// parser returns the normalised value or a *badValue with a stable code and a human message.

type badValue struct{ code, message string }

func bad(code, format string, args ...any) *badValue {
	return &badValue{code: code, message: fmt.Sprintf(format, args...)}
}

// ------------------------------------------------------------------ headers

var (
	headerUnits = regexp.MustCompile(`\((?:₹|rs\.?|inr|in rs\.?|in ₹|per month|monthly|years|yrs)\)`)
	nonAlnum    = regexp.MustCompile(`[^a-z0-9]+`)
)

// normalizeHeader: "Monthly Income (₹)" → "monthly_income"; "\ufeffUser ID" → "user_id".
func normalizeHeader(cell string) string {
	t := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(cell, "\ufeff", "")))
	t = headerUnits.ReplaceAllString(t, "")
	return strings.Trim(nonAlnum.ReplaceAllString(t, "_"), "_")
}

var aliasToColumn = func() map[string]string {
	m := map[string]string{}
	for _, c := range columns {
		for _, a := range c.Aliases {
			m[a] = c.Name
		}
	}
	return m
}()

// mapHeader returns column → index (first occurrence wins).
func mapHeader(cells []string) map[string]int {
	out := map[string]int{}
	for i, cell := range cells {
		if canon, ok := aliasToColumn[normalizeHeader(cell)]; ok {
			if _, dup := out[canon]; !dup {
				out[canon] = i
			}
		}
	}
	return out
}

// ------------------------------------------------------------------ values

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

const maxIncomePaise = 100_000_000 * 100 // ₹10 crore a month: a typo or an annual figure

var (
	currency = regexp.MustCompile(`(₹|rs\.?|inr)`)
	perMonth = regexp.MustCompile(`(/-|/\s*month|/\s*mo|per month|p\.?m\.?|monthly)$`)
	amountRe = regexp.MustCompile(`^([0-9]*\.?[0-9]+(?:e[+-]?[0-9]+)?)\s*([a-z]*)$`)
	units    = map[string]float64{"l": 1e5, "lac": 1e5, "lakh": 1e5, "lakhs": 1e5, "lacs": 1e5, "k": 1e3, "thousand": 1e3,
		"cr": 1e7, "crore": 1e7, "crores": 1e7}
	stripSep = strings.NewReplacer(",", "", " ", "")
)

// parseAmount: "₹1,20,000" / "1,20,000.00" / "1.2L" / "50k" / "1.2E+05" / "Rs. 45000/month" → paise.
// Money is an integer number of paise: exact, no floating-point drift in the database.
func parseAmount(raw string) (int64, *badValue) {
	t := strings.TrimSpace(raw)
	if isDigits(t) && len(t) <= 12 { // fast path: plain digits, the overwhelmingly common case
		v, _ := strconv.ParseInt(t, 10, 64)
		if v*100 > maxIncomePaise {
			return 0, bad("OUT_OF_RANGE", "monthly income %d is implausibly high (annual figure?)", v)
		}
		return v * 100, nil
	}
	t = strings.ToLower(t)
	if t == "" {
		return 0, bad("REQUIRED", "value is missing")
	}
	t = currency.ReplaceAllString(t, "")
	t = perMonth.ReplaceAllString(strings.TrimSpace(t), "")
	m := amountRe.FindStringSubmatch(stripSep.Replace(t))
	if m == nil {
		return 0, bad("NOT_A_NUMBER", "'%s' is not an amount", raw)
	}
	mult := 1.0
	if m[2] != "" {
		u, ok := units[m[2]]
		if !ok {
			return 0, bad("NOT_A_NUMBER", "'%s' is not an amount", raw)
		}
		mult = u
	}
	f, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, bad("NOT_A_NUMBER", "'%s' is not an amount", raw)
	}
	paise := int64(math.Round(f * mult * 100))
	if paise > maxIncomePaise {
		return 0, bad("OUT_OF_RANGE", "monthly income %s is implausibly high (annual figure?)", formatPaise(paise))
	}
	return paise, nil
}

var noCreditHistory = map[string]bool{"": true, "na": true, "n/a": true, "nil": true, "none": true, "null": true, "-": true,
	"--": true, "0": true, "-1": true, "ntc": true, "new": true, "no history": true, "nh": true}

// parseCreditScore: 0 means new-to-credit (no bureau history) — common in India, not an error.
func parseCreditScore(raw string) (int, *badValue) {
	t := strings.TrimSpace(raw)
	if isDigits(t) && len(t) <= 3 {
		if v, _ := strconv.Atoi(t); v >= 300 && v <= 900 {
			return v, nil
		}
	}
	t = strings.ToLower(t)
	if noCreditHistory[t] {
		return 0, nil
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return 0, bad("NOT_A_NUMBER", "credit score '%s' is not a number", raw)
	}
	if f != math.Trunc(f) || f < 300 || f > 900 {
		return 0, bad("OUT_OF_RANGE", "credit score %s must be a whole number in 300–900", raw)
	}
	return int(f), nil
}

var ageRe = regexp.MustCompile(`^\s*([0-9]+(?:\.0+)?)\s*(?:y|yr|yrs|year|years)?\s*$`)

// parseAge: "35", "35.0", "35 yrs", "35 years" → 35.
func parseAge(raw string) (int, *badValue) {
	t := strings.TrimSpace(raw)
	if isDigits(t) && len(t) <= 3 {
		if v, _ := strconv.Atoi(t); v >= 18 && v <= 100 {
			return v, nil
		}
	}
	m := ageRe.FindStringSubmatch(strings.ToLower(raw))
	if m == nil {
		if t == "" {
			return 0, bad("REQUIRED", "age '%s' is not a whole number", raw)
		}
		return 0, bad("NOT_A_NUMBER", "age '%s' is not a whole number", raw)
	}
	f, _ := strconv.ParseFloat(m[1], 64)
	if f < 18 || f > 100 {
		return 0, bad("OUT_OF_RANGE", "age %d must be between 18 and 100", int(f))
	}
	return int(f), nil
}

var employmentAliases = func() map[string]string {
	m := map[string]string{}
	for canon, list := range map[string][]string{
		"Salaried": {"salaried", "salary", "employed", "service", "job", "privatejob", "governmentjob", "govtjob", "government",
			"salariedemployee", "employee"},
		"Self-Employed": {"selfemployed", "self", "freelancer", "freelance", "professional", "selfemployedprofessional", "consultant"},
		"Business": {"business", "businessowner", "businessman", "businesswoman", "shopkeeper", "proprietor", "merchant", "trader",
			"selfemployedbusiness", "smb", "msme"},
	} {
		for _, a := range list {
			m[a] = canon
		}
	}
	return m
}()

func parseEmployment(raw string) (string, *badValue) {
	switch raw { // fast path: already canonical
	case "Salaried", "Self-Employed", "Business":
		return raw, nil
	}
	key := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' {
			return r
		}
		return -1
	}, strings.ToLower(raw))
	if key == "" {
		return "", bad("REQUIRED", "employment status is missing")
	}
	if canon, ok := employmentAliases[key]; ok {
		return canon, nil
	}
	return "", bad("UNKNOWN_VALUE", "'%s' is not one of Salaried, Self-Employed, Business", raw)
}

var (
	emailRe       = regexp.MustCompile("^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9-]+)+$")
	reservedExact = map[string]bool{"example.com": true, "example.net": true, "example.org": true}
	reservedTLDs  = []string{".example.com", ".example.net", ".example.org", ".example", ".test", ".invalid", ".localhost", ".local"}
	domainCache   sync.Map // a file has few distinct domains; decide each once
)

// parseEmail returns (normalised, deliverable). Undeliverable (RFC 2606/6761 reserved) addresses
// are stored but never mailed.
func parseEmail(raw string) (string, bool, *badValue) {
	e := strings.ToLower(strings.TrimSpace(raw))
	if e == "" {
		return "", false, bad("REQUIRED", "email is missing")
	}
	if len(e) > 254 || !emailRe.MatchString(e) {
		return "", false, bad("INVALID_EMAIL", "'%s' is not a valid email address", raw)
	}
	domain := e[strings.LastIndexByte(e, '@')+1:]
	if v, ok := domainCache.Load(domain); ok {
		return e, v.(bool), nil
	}
	deliverable := !reservedExact[domain]
	for _, s := range reservedTLDs {
		deliverable = deliverable && !strings.HasSuffix(domain, s)
	}
	domainCache.Store(domain, deliverable)
	return e, deliverable, nil
}

var sciRe = regexp.MustCompile(`(?i)^[0-9](?:\.[0-9]+)?e\+?[0-9]+$`)

func parseUserID(raw string) (string, *badValue) {
	uid := strings.TrimSpace(raw)
	switch {
	case uid == "":
		return "", bad("REQUIRED", "user_id is missing")
	case sciRe.MatchString(uid):
		// Excel turned a long numeric ID into 1.23E+11 — the original digits are lost.
		return "", bad("USER_ID_CORRUPTED", "'%s' looks like Excel scientific notation; format the column as Text", raw)
	case len(uid) > 64:
		return "", bad("TOO_LONG", "user_id is longer than 64 characters")
	}
	return uid, nil
}

func parseName(raw string) string {
	name := strings.Join(strings.Fields(raw), " ")
	if r := []rune(name); len(r) > 200 { // cut on a character boundary, never mid-UTF-8
		name = string(r[:200])
	}
	return name
}

func formatPaise(p int64) string { return fmt.Sprintf("%d.%02d", p/100, p%100) }
