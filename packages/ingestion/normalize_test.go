package ingestion

import "testing"

// Value parsing for real-world Indian spreadsheets (docs/DESIGN.md §9.2).

func TestAmounts(t *testing.T) {
	for raw, paise := range map[string]int64{
		"45000": 4_500_000, "₹1,20,000": 12_000_000, "1,20,000.00": 12_000_000, "1.2L": 12_000_000, "1.2 lakh": 12_000_000,
		"50k": 5_000_000, "1.2E+05": 12_000_000, "Rs. 45000/month": 4_500_000, "INR 30,000 /-": 3_000_000, "  62000  ": 6_200_000,
	} {
		if got, b := parseAmount(raw); b != nil || got != paise {
			t.Errorf("%q → %d %v, want %d", raw, got, b, paise)
		}
	}
	for raw, code := range map[string]string{"": "REQUIRED", "abc": "NOT_A_NUMBER", "12 apples": "NOT_A_NUMBER", "500 crore": "OUT_OF_RANGE"} {
		if _, b := parseAmount(raw); b == nil || b.code != code {
			t.Errorf("%q → %v, want %s", raw, b, code)
		}
	}
}

func TestCreditScores(t *testing.T) {
	for _, raw := range []string{"", "NA", "n/a", "-", "0", "-1", "NTC", "None"} {
		if v, b := parseCreditScore(raw); b != nil || v != 0 {
			t.Errorf("%q should mean new-to-credit, got %d %v", raw, v, b)
		}
	}
	for raw, code := range map[string]string{"950": "OUT_OF_RANGE", "720.5": "OUT_OF_RANGE", "good": "NOT_A_NUMBER"} {
		if _, b := parseCreditScore(raw); b == nil || b.code != code {
			t.Errorf("%q → %v, want %s", raw, b, code)
		}
	}
}

func TestAgesEmploymentEmailUserID(t *testing.T) {
	for raw, want := range map[string]int{"35": 35, "35.0": 35, "35 yrs": 35, "40 Years": 40} {
		if v, b := parseAge(raw); b != nil || v != want {
			t.Errorf("age %q → %d %v", raw, v, b)
		}
	}
	for _, raw := range []string{"17", "101", "35.5", "thirty"} {
		if _, b := parseAge(raw); b == nil {
			t.Errorf("age %q should fail", raw)
		}
	}
	for raw, want := range map[string]string{"Salaried": "Salaried", "SALARIED": "Salaried", "self employed": "Self-Employed",
		"SELF-EMPLOYED": "Self-Employed", "Business Owner": "Business", "shopkeeper": "Business"} {
		if v, b := parseEmployment(raw); b != nil || v != want {
			t.Errorf("employment %q → %q %v", raw, v, b)
		}
	}
	if e, ok, b := parseEmail("  Rahul.K@Gmail.com "); b != nil || e != "rahul.k@gmail.com" || !ok {
		t.Error(e, ok, b)
	}
	if _, ok, _ := parseEmail("user1@example.com"); ok {
		t.Error("example.com must be undeliverable")
	}
	if _, ok, _ := parseEmail("a@mail.test"); ok {
		t.Error(".test must be undeliverable")
	}
	if _, _, b := parseEmail("not-an-email"); b == nil {
		t.Error("invalid email accepted")
	}
	if _, b := parseUserID("1.23457E+11"); b == nil || b.code != "USER_ID_CORRUPTED" {
		t.Error(b)
	}
}

func TestHeaderNormalisation(t *testing.T) {
	for raw, want := range map[string]string{"Monthly Income (₹)": "monthly_income", "\ufeffUser ID": "user_id", "CIBIL Score": "cibil_score"} {
		if got := normalizeHeader(raw); got != want {
			t.Errorf("%q → %q", raw, got)
		}
	}
}
