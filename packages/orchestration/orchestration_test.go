package orchestration_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"loanengine/packages/orchestration"
)

const secret = "doorbell-secret-0123456789"

func TestSignedRequestThatN8nCanVerify(t *testing.T) {
	var got *http.Request
	var body []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, body = r, must(io.ReadAll(r.Body))
	}))
	defer srv.Close()
	t.Setenv("N8N_WEBHOOK_URL", srv.URL+"/webhook/batch-loaded")
	t.Setenv("N8N_WEBHOOK_SECRET", secret)
	if !orchestration.TriggerMatching(context.Background(), "b-1") {
		t.Fatal("expected success")
	}
	var payload map[string]string
	_ = json.Unmarshal(body, &payload)
	if payload["batch_id"] != "b-1" || got.Header.Get("X-Signature") != orchestration.Sign(secret, got.Header.Get("X-Timestamp"), "b-1") {
		t.Fatalf("bad request: %s %v", body, got.Header)
	}
}

func TestFailureNeverRaisesAndDisabledWithoutURL(t *testing.T) {
	t.Setenv("N8N_WEBHOOK_SECRET", secret)
	t.Setenv("N8N_WEBHOOK_URL", "http://127.0.0.1:9/unreachable")
	if orchestration.TriggerMatching(context.Background(), "b-1") {
		t.Fatal("unreachable must be false")
	}
	t.Setenv("N8N_WEBHOOK_URL", "")
	if orchestration.TriggerMatching(context.Background(), "b-1") {
		t.Fatal("disabled must be false")
	}
}

// Contract: n8n's JavaScript verifier (apps/workflows/src/code/signature.js) accepts what Go signs.
func TestSignatureVerifiesInN8nJavaScript(t *testing.T) {
	id, ts := "0b6f2a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", strconv.FormatInt(time.Now().Unix(), 10)
	args, _ := json.Marshal([]any{map[string]string{"X-Timestamp": ts, "X-Signature": orchestration.Sign(secret, ts, id)},
		map[string]string{"batch_id": id}, secret, must(strconv.Atoi(ts))})
	cmd := exec.Command("node", "../../apps/workflows/tests/run_module.js", "signature", "verifyDoorbell")
	cmd.Stdin = strings.NewReader(string(args))
	out, err := cmd.Output()
	if err != nil || !strings.Contains(string(out), `"ok":true`) {
		t.Fatalf("JS rejected Go's signature: %s %v", out, err)
	}
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
