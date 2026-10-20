package ingestion_test

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/unicode"

	"loanengine/internal/testdb"
	"loanengine/packages/batches"
	"loanengine/packages/ingestion"
)

const header = "user_id,name,email,monthly_income,credit_score,employment_status,age\n"

func ingest(t *testing.T, pool *pgxpool.Pool, body []byte) (string, ingestion.Result) {
	t.Helper()
	ctx, id := context.Background(), uuid.NewString()
	if err := batches.Create(ctx, pool, id, "users.csv", "uploads/"+id+"/users.csv", 100, nil, nil); err != nil {
		t.Fatal(err)
	}
	res, err := ingestion.RunReader(ctx, pool, id, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	return id, res
}

func one(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) (v any) {
	t.Helper()
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func good(n int) string {
	var b strings.Builder
	for i := range n {
		fmt.Fprintf(&b, "U%d,N,u%d@gmail.com,50000,750,Salaried,30\n", i, i)
	}
	return b.String()
}

func TestCleanFileLoads(t *testing.T) {
	pool, _ := testdb.New(t)
	id, res := ingest(t, pool, []byte(header+"U1,Asha,asha@gmail.com,50000,750,Salaried,30\nU2,Ravi,ravi@example.com,\"1,20,000\",NA,Business Owner,41\n"))
	if res.Status != "LOADED" || res.RowsValid != 2 || res.RowsInserted != 2 {
		t.Fatalf("%+v", res)
	}
	var income float64
	var credit *int
	var emp string
	var deliverable bool
	_ = pool.QueryRow(context.Background(), "SELECT monthly_income, credit_score, employment_status::text, email_deliverable FROM users WHERE user_id='U2'").
		Scan(&income, &credit, &emp, &deliverable)
	if income != 120000 || credit != nil || emp != "Business" || deliverable {
		t.Fatal(income, credit, emp, deliverable)
	}
	if b, _ := batches.Get(context.Background(), pool, id); b.Status != batches.Loaded {
		t.Fatal(b.Status)
	}
}

func TestReuploadTouchesOnlyChangedRows(t *testing.T) {
	pool, _ := testdb.New(t)
	body := header + "U1,Asha,asha@gmail.com,50000,750,Salaried,30\nU2,Ravi,r@gmail.com,60000,700,Salaried,35\n"
	ingest(t, pool, []byte(body))
	second, res := ingest(t, pool, []byte(strings.Replace(body, "60000", "65000", 1)))
	if res.RowsInserted != 0 || res.RowsUpdated != 1 {
		t.Fatalf("%+v", res)
	}
	if one(t, pool, "SELECT string_agg(user_id, ',') FROM users WHERE last_batch_id = $1::uuid", second) != "U2" {
		t.Fatal("only the changed user belongs to the new batch")
	}
}

func TestDuplicateUserIDLastRowWins(t *testing.T) {
	pool, _ := testdb.New(t)
	id, res := ingest(t, pool, []byte(header+"U1,A,a@gmail.com,50000,750,Salaried,30\nU1,A,a@gmail.com,70000,750,Salaried,30\n"))
	if res.Duplicates != 1 {
		t.Fatalf("%+v", res)
	}
	var income float64
	_ = pool.QueryRow(context.Background(), "SELECT monthly_income FROM users").Scan(&income)
	report, _ := ingestion.ErrorReportCSV(context.Background(), pool, id)
	if income != 70000 || !strings.Contains(string(report), "DUPLICATE_USER_ID") || !strings.Contains(string(report), "row 3 was used") {
		t.Fatal(income, string(report))
	}
}

func TestBadRowsReportedWithSpreadsheetRowNumbers(t *testing.T) {
	pool, _ := testdb.New(t)
	id, res := ingest(t, pool, []byte(header+good(9)+"U99,N,bad-email,abc,999,Pilot,12\n"))
	if res.Status != "LOADED" || res.RowsRejected != 1 {
		t.Fatalf("%+v", res)
	}
	errs, _ := ingestion.ErrorPreview(context.Background(), pool, id, 10)
	codes := map[string]bool{}
	for _, e := range errs {
		codes[e.Code] = true
		if e.Row != 11 { // header is row 1, so the 10th data row is row 11
			t.Fatal("row number", e.Row)
		}
	}
	if len(codes) != 4 || !codes["INVALID_EMAIL"] || !codes["NOT_A_NUMBER"] || !codes["OUT_OF_RANGE"] || !codes["UNKNOWN_VALUE"] {
		t.Fatal(codes)
	}
}

func TestCircuitBreakerMergesNothing(t *testing.T) {
	pool, _ := testdb.New(t)
	id, res := ingest(t, pool, []byte(header+"U1,N,a@gmail.com,50000,750,Salaried,30\n"+strings.Repeat("U2,N,x,y,z,w,v\n", 3)))
	if res.Status != "FAILED" || !strings.Contains(res.Error, "invalid") || one(t, pool, "SELECT count(*) FROM users").(int64) != 0 {
		t.Fatalf("%+v", res)
	}
	if b, _ := batches.Get(context.Background(), pool, id); b.Status != batches.Failed {
		t.Fatal(b.Status)
	}
}

func TestEncodingsAndGzip(t *testing.T) {
	body := header + "U1,José Müller,j@gmail.com,50000,750,Salaried,30\n"
	u16, _ := unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewEncoder().String(body)
	cp, _ := charmap.Windows1252.NewEncoder().String(body)
	var gz bytes.Buffer
	w := gzip.NewWriter(&gz)
	_, _ = w.Write([]byte(body))
	_ = w.Close()
	for name, raw := range map[string][]byte{"utf-8-bom": append([]byte("\xef\xbb\xbf"), body...), "utf-16": []byte(u16),
		"cp1252": []byte(cp), "gzip": gz.Bytes()} {
		t.Run(name, func(t *testing.T) {
			pool, _ := testdb.New(t)
			_, res := ingest(t, pool, raw)
			if res.Status != "LOADED" || one(t, pool, "SELECT name FROM users") != "José Müller" {
				t.Fatalf("%+v", res)
			}
		})
	}
}

func TestMessyHeaderSemicolonsTitleRowAndAliases(t *testing.T) {
	pool, _ := testdb.New(t)
	_, res := ingest(t, pool, []byte("Leads export — October\n\nCustomer ID;Full Name;Email ID;Monthly Salary (₹);CIBIL Score;Occupation;Age (years)\n"+
		"C1;Asha;asha@gmail.com;₹1,20,000;780;self employed;33 yrs\n\n\n"))
	if res.Status != "LOADED" || res.RowsValid != 1 || one(t, pool, "SELECT employment_status::text FROM users") != "Self-Employed" {
		t.Fatalf("%+v", res)
	}
}

func TestWholeFileRejections(t *testing.T) {
	pool, _ := testdb.New(t)
	for body, want := range map[string]string{
		"user_id,email,age\nU1,a@gmail.com,30\n":   "monthly_income",
		"PK\x03\x04" + strings.Repeat("\x00", 100): "save it as CSV",
	} {
		if _, res := ingest(t, pool, []byte(body)); res.Status != "FAILED" || !strings.Contains(res.Error, want) {
			t.Fatalf("%+v", res)
		}
	}
}

func TestDuplicateDeliveryIsSkipped(t *testing.T) {
	pool, _ := testdb.New(t)
	id, first := ingest(t, pool, []byte(header+"U1,A,a@gmail.com,50000,750,Salaried,30\n"))
	again, _ := ingestion.RunReader(context.Background(), pool, id, strings.NewReader("irrelevant"))
	if first.Status != "LOADED" || again.Status != "SKIPPED" {
		t.Fatal(first.Status, again.Status)
	}
}

func TestFormulaInjectionNeutralisedInReport(t *testing.T) {
	pool, _ := testdb.New(t)
	id, _ := ingest(t, pool, []byte(header+good(9)+"U9,N,u9@gmail.com,=HYPERLINK(\"http://evil\"),750,Salaried,30\n"))
	report, _ := ingestion.ErrorReportCSV(context.Background(), pool, id)
	if !strings.Contains(string(report), "'=HYPERLINK") || !bytes.HasPrefix(report, []byte("\xef\xbb\xbf")) {
		t.Fatal(string(report))
	}
}

func TestSampleFileLoadsFully(t *testing.T) {
	pool, _ := testdb.New(t)
	data, err := os.ReadFile("../../data/users.csv")
	if err != nil {
		t.Skip("sample file not present")
	}
	_, res := ingest(t, pool, data)
	if res.Status != "LOADED" || res.RowsValid != 10_000 || res.RowsRejected != 0 {
		t.Fatalf("%+v", res)
	}
	if one(t, pool, "SELECT count(*) FROM users WHERE email_deliverable").(int64) != 0 {
		t.Fatal("every sample address is @example.com → never mailed")
	}
}
