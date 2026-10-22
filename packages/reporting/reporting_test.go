package reporting_test

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"loanengine/internal/testdb"
	"loanengine/packages/batches"
	"loanengine/packages/reporting"
)

func TestOverviewSummaryAndCatalogue(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx, id := context.Background(), uuid.NewString()
	_ = batches.Create(ctx, pool, id, "f.csv", "uploads/"+id+"/f.csv", 1, nil, nil)
	for _, sql := range []string{
		`INSERT INTO loan_products (product_key, lender_name, product_name, source_url, extraction_method, criteria_hash,
		  min_monthly_income, employment_types) VALUES ('a','HDFC Bank','Personal Loan','https://h','llm','x',25000,'{Salaried}'),
		  ('b','Kotak Mahindra Bank','Personal Loan','https://k','llm','y',30000,NULL)`,
		`INSERT INTO users (user_id, email, email_deliverable, monthly_income, employment_status, age, last_batch_id)
		  VALUES ('U1','a@example.com',false,50000,'Salaried',30,'` + id + `'), ('U2','a@example.com',false,50000,'Salaried',30,'` + id + `')`,
		`INSERT INTO matches (user_id, product_id, status, score, decided_by, batch_id) VALUES
		  ('U1',1,'ELIGIBLE',80,'RULES','` + id + `'), ('U2',1,'LIKELY',75,'RULES','` + id + `'), ('U1',2,'ELIGIBLE',70,'RULES','` + id + `')`,
		`INSERT INTO notifications (user_id, batch_id, digest_key, recipient, status) VALUES ('U1','` + id + `','d','me+1@gmail.com','SENT')`,
	} {
		if _, err := pool.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	o, err := reporting.GetOverview(ctx, pool)
	if err != nil || o.ActiveProducts != 2 || o.Lenders != 2 || o.Users != 2 || o.Matches != 3 || o.EmailsSent != 1 || o.Uploads != 1 {
		t.Fatalf("%+v %v", o, err)
	}
	s, err := reporting.GetBatchSummary(ctx, pool, id)
	if err != nil || s.UsersMatched != 2 || s.EmailsSent != 1 || s.ByProduct[0] != (reporting.ProductMatches{"HDFC Bank", "Personal Loan", 2, 1, 1}) {
		t.Fatalf("%+v %v", s, err)
	}
	ps, err := reporting.Products(ctx, pool)
	if err != nil || len(ps) != 2 || ps[0].EmploymentTypes[0] != "Salaried" || ps[1].EmploymentTypes != nil {
		t.Fatalf("%+v %v", ps, err)
	}
}

func TestBatchConfirmations(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx, id, other := context.Background(), uuid.NewString(), uuid.NewString()
	for _, b := range []string{id, other} {
		if err := batches.Create(ctx, pool, b, "f.csv", "uploads/"+b+"/f.csv", 1, nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	if c, err := reporting.GetBatchConfirmations(ctx, pool, id); err != nil || c != (reporting.Confirmations{}) {
		t.Fatalf("zero state: %+v %v", c, err)
	}
	for _, sql := range []string{
		`INSERT INTO users (user_id, email, email_deliverable, monthly_income, employment_status, age) VALUES
		  ('U1','a@example.com',false,50000,'Salaried',30), ('U2','b@example.com',false,50000,'Salaried',30),
		  ('U3','c@example.com',false,50000,'Salaried',30), ('U4','d@example.com',false,50000,'Salaried',30),
		  ('U5','e@example.com',false,50000,'Salaried',30)`,
		// asked = SENT with questions; a FAILED one, a SENT one without questions and another batch don't count
		`INSERT INTO notifications (user_id, batch_id, digest_key, recipient, status, questions) VALUES
		  ('U1','` + id + `','d1','me@gmail.com','SENT','["work_experience"]'),
		  ('U2','` + id + `','d2','me@gmail.com','SENT','["city","employer_type"]'),
		  ('U3','` + id + `','d3','me@gmail.com','FAILED','["city"]'),
		  ('U4','` + id + `','d4','me@gmail.com','SENT',NULL),
		  ('U5','` + other + `','d5','me@gmail.com','SENT','["city"]')`,
		`INSERT INTO user_declarations (user_id, batch_id, answers, flagged, unlocked) VALUES
		  ('U1','` + id + `','{"city":"Pune"}',false,3), ('U2','` + id + `','{}',true,0),
		  ('U5','` + other + `','{}',false,5)`,
	} {
		if _, err := pool.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	c, err := reporting.GetBatchConfirmations(ctx, pool, id)
	if err != nil || c != (reporting.Confirmations{Asked: 2, Answered: 2, Flagged: 1, Unlocked: 3}) {
		t.Fatalf("%+v %v", c, err)
	}
}
