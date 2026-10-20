package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"loanengine/internal/testdb"
	"loanengine/packages/notifications"
	"loanengine/packages/uploads"
)

type memStore struct{ parts map[int32]int64 }

func (m *memStore) Start(context.Context, string, string) (string, error) {
	m.parts = map[int32]int64{}
	return "up", nil
}
func (m *memStore) PresignPart(_ context.Context, _, _, _ string, n int32, sum string, _ time.Duration) (string, map[string]string, error) {
	return fmt.Sprint("fake://", n), map[string]string{"x-amz-checksum-sha256": sum}, nil
}
func (m *memStore) Parts(context.Context, string, string, string) ([]uploads.Part, error) {
	var out []uploads.Part
	for n, size := range m.parts {
		out = append(out, uploads.Part{Number: n, ETag: "e", Size: size})
	}
	return out, nil
}
func (m *memStore) Finish(context.Context, string, string, string, []uploads.Part) error { return nil }
func (m *memStore) Cancel(context.Context, string, string, string) error                 { return nil }

func newApp(t *testing.T) (*App, *memStore) {
	pool, _ := testdb.New(t)
	store := &memStore{}
	keys := uploads.Keys{Bucket: "b", MaxUploadBytes: 200 << 20, PartSize: 8 << 20, URLTTL: time.Hour, Region: "ap-south-1"}
	return &App{DB: pool, Uploads: uploads.New(keys, store), Now: time.Now}, store
}

func call(t *testing.T, a *App, method, resource string, path map[string]string, query map[string]string, body any) (int, map[string]any, string) {
	t.Helper()
	raw := ""
	if body != nil {
		b, _ := json.Marshal(body)
		raw = string(b)
	}
	resp, _ := a.Handle(context.Background(), request{HTTPMethod: method, Resource: resource, PathParameters: path,
		QueryStringParameters: query, Body: raw})
	var out map[string]any
	_ = json.Unmarshal([]byte(resp.Body), &out)
	if resp.Headers["Access-Control-Allow-Origin"] != "*" {
		t.Fatal("every response carries CORS headers")
	}
	return resp.StatusCode, out, resp.Body
}

func TestUploadFlowThroughHandlers(t *testing.T) {
	a, store := newApp(t)
	data := []byte("user_id,email\nU1,a@gmail.com\n")
	code, s, _ := call(t, a, "POST", "/v1/uploads", nil, nil, map[string]any{"filename": "u.csv", "size_bytes": len(data)})
	if code != 201 {
		t.Fatal(code, s)
	}
	id := s["batch_id"].(string)
	sum := sha256.Sum256(data)
	p := map[string]string{"batch_id": id}
	code, urls, _ := call(t, a, "POST", "/v1/uploads/{batch_id}/part-urls", p, nil,
		map[string]any{"parts": []map[string]any{{"part_number": 1, "sha256": base64.StdEncoding.EncodeToString(sum[:])}}})
	if code != 200 || len(urls["urls"].([]any)) != 1 {
		t.Fatal(code, urls)
	}
	store.parts[1] = int64(len(data))
	if code, done, _ := call(t, a, "POST", "/v1/uploads/{batch_id}/complete", p, nil, nil); code != 200 || done["status"] != "UPLOADED" {
		t.Fatal(code, done)
	}
	code, st, _ := call(t, a, "GET", "/v1/batches/{batch_id}", p, nil, nil)
	if code != 200 || st["batch"].(map[string]any)["status"] != "UPLOADED" || len(st["timeline"].([]any)) != 2 {
		t.Fatal(code, st)
	}
	if code, list, _ := call(t, a, "GET", "/v1/batches", nil, map[string]string{"limit": "5"}, nil); code != 200 || len(list["batches"].([]any)) != 1 {
		t.Fatal(code, list)
	}
}

func TestErrorModel(t *testing.T) {
	a, _ := newApp(t)
	cases := []struct {
		method, resource string
		path, query      map[string]string
		body             any
		status           int
		code             string
	}{
		{"POST", "/v1/uploads", nil, nil, map[string]any{"filename": "u.csv", "size_bytes": 1 << 40}, 413, "FILE_TOO_LARGE"},
		{"POST", "/v1/uploads", nil, nil, map[string]any{"filename": "u.csv"}, 400, "BAD_REQUEST"},
		{"GET", "/v1/batches/{batch_id}", map[string]string{"batch_id": "00000000-0000-0000-0000-000000000000"}, nil, nil, 404, "BATCH_NOT_FOUND"},
		{"GET", "/v1/batches/{batch_id}", map[string]string{"batch_id": "x' OR 1=1"}, nil, nil, 404, "BATCH_NOT_FOUND"},
		{"GET", "/v1/batches", nil, map[string]string{"limit": "x"}, nil, 400, "BAD_REQUEST"},
		{"GET", "/v1/nope", nil, nil, nil, 404, "NOT_FOUND"},
	}
	for _, c := range cases {
		status, out, _ := call(t, a, c.method, c.resource, c.path, c.query, c.body)
		if status != c.status || out["error"].(map[string]any)["code"] != c.code {
			t.Errorf("%s %s → %d %v", c.method, c.resource, status, out)
		}
	}
}

func TestInternalErrorsDoNotLeak(t *testing.T) {
	resp := toResponse("x", errors.New("db password=hunter2"))
	if resp.StatusCode != 500 || strings.Contains(resp.Body, "hunter2") {
		t.Fatal(resp)
	}
}

func TestUnsubscribeGetNeverUnsubscribes(t *testing.T) {
	t.Setenv("UNSUBSCRIBE_SECRET", "test-unsubscribe-secret-0123456789")
	a, _ := newApp(t)
	ctx := context.Background()
	_, _ = a.DB.Exec(ctx, `INSERT INTO users (user_id, email, email_deliverable, monthly_income, employment_status, age)
		VALUES ('U1','a@gmail.com',true,50000,'Salaried',30)`)
	tok, _ := notifications.MakeToken("U1", time.Now(), notifications.DefaultTTL)
	q := map[string]string{"t": tok}
	count := func() (n int) { _ = a.DB.QueryRow(ctx, "SELECT count(*) FROM suppression").Scan(&n); return }
	if code, _, body := call(t, a, "GET", "/v1/unsubscribe", nil, q, nil); code != 200 || !strings.Contains(body, `<form method="post"`) || count() != 0 {
		t.Fatal(code, body)
	}
	if code, _, _ := call(t, a, "POST", "/v1/unsubscribe", nil, q, nil); code != 200 || count() != 1 {
		t.Fatal(code)
	}
	if code, _, _ := call(t, a, "GET", "/v1/unsubscribe", nil, map[string]string{"t": "forged"}, nil); code != 400 {
		t.Fatal(code)
	}
}

func TestReadEndpoints(t *testing.T) {
	a, _ := newApp(t)
	_, sch, _ := call(t, a, "GET", "/v1/uploads/schema", nil, nil, nil)
	var required []string
	for _, c := range sch["columns"].([]any) {
		if m := c.(map[string]any); m["required"] == true {
			required = append(required, m["name"].(string))
		}
	}
	if strings.Join(required, ",") != "user_id,email,monthly_income,credit_score,employment_status,age" {
		t.Fatal(required)
	}
	if _, o, _ := call(t, a, "GET", "/v1/overview", nil, nil, nil); o["uploads"].(float64) != 0 {
		t.Fatal(o)
	}
	if _, p, body := call(t, a, "GET", "/v1/products", nil, nil, nil); len(p["products"].([]any)) != 0 {
		t.Fatal(body)
	}
}
