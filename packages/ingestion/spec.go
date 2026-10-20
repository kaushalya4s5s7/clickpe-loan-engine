package ingestion

// ColumnSpec is the accepted file format. Published (GET /v1/uploads/schema) so the console checks
// headers BEFORE uploading with the very table the server validates with — one source of truth.
type ColumnSpec struct {
	Name     string   `json:"name"`
	Required bool     `json:"required"`
	Aliases  []string `json:"aliases"`
	Example  string   `json:"example"`
	Hint     string   `json:"hint"`
}

var columns = []ColumnSpec{
	{"user_id", true, []string{"user_id", "userid", "id", "customer_id", "cust_id", "uid", "lead_id", "applicant_id"}, "U1001",
		"Unique per person. Format the column as Text in Excel so long IDs aren't mangled."},
	{"name", false, []string{"name", "full_name", "customer_name", "applicant_name"}, "Asha Rao",
		"Optional. Used to greet the person in the email."},
	{"email", true, []string{"email", "email_id", "email_address", "mail", "e_mail", "mail_id"}, "asha.rao@example.com",
		"Where offers are sent."},
	{"monthly_income", true, []string{"monthly_income", "income", "monthly_salary", "salary", "net_monthly_income", "net_income",
		"take_home", "monthly_take_home", "income_per_month"}, "45000", "Monthly, in ₹. 45000, ₹45,000, 1.2L and 50k all work."},
	{"credit_score", true, []string{"credit_score", "cibil", "cibil_score", "score", "credit", "bureau_score"}, "742",
		"300–900. Leave blank or write NA for people with no credit history."},
	{"employment_status", true, []string{"employment_status", "employment", "employment_type", "occupation", "profession",
		"job_type"}, "Salaried", "Salaried, Self-Employed or Business (common variants are understood)."},
	{"age", true, []string{"age", "age_years", "age_in_years"}, "31", "18–100. 35 or '35 yrs' both work."},
}

func Columns() []ColumnSpec { return columns }
