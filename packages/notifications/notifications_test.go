package notifications_test

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strings"
	"testing"
	"time"

	"loanengine/internal/testdb"
	"loanengine/packages/notifications"
)

const secret = "test-unsubscribe-secret-0123456789"

func TestTokenRoundTripAndTamperDetection(t *testing.T) {
	t.Setenv("UNSUBSCRIBE_SECRET", secret)
	now := time.Unix(1000, 0)
	tok, _ := notifications.MakeToken("U-42", now, notifications.DefaultTTL)
	if uid, err := notifications.VerifyToken(tok, now.Add(time.Hour)); err != nil || uid != "U-42" {
		t.Fatal(uid, err)
	}
	p := strings.Split(tok, ".")
	for _, bad := range []string{p[0] + ".9999999999." + p[2], "garbage", ""} {
		if _, err := notifications.VerifyToken(bad, now); !errors.Is(err, notifications.ErrInvalidToken) {
			t.Fatal(bad, err)
		}
	}
	if _, err := notifications.VerifyToken(tok, now.Add(100*24*time.Hour)); err == nil {
		t.Fatal("expired token accepted")
	}
}

// Contract: the email renderer in n8n produces byte-identical tokens.
func TestTokenIdenticalToN8nJavaScript(t *testing.T) {
	t.Setenv("UNSUBSCRIBE_SECRET", secret)
	now := time.Now().Truncate(time.Second)
	goTok, _ := notifications.MakeToken("U-42 ü", now, notifications.DefaultTTL)
	args, _ := json.Marshal([]any{"U-42 ü", secret, now.Unix()})
	cmd := exec.Command("node", "../../apps/workflows/tests/run_module.js", "email", "unsubscribeToken")
	cmd.Stdin = strings.NewReader(string(args))
	out, err := cmd.Output()
	var jsTok string
	_ = json.Unmarshal(out, &jsTok)
	if err != nil || jsTok != goTok {
		t.Fatalf("go=%s js=%s err=%v", goTok, jsTok, err)
	}
}

func TestUnsubscribeSuppressesEveryUserSharingTheAddress(t *testing.T) {
	t.Setenv("UNSUBSCRIBE_SECRET", secret)
	pool, _ := testdb.New(t)
	ctx := context.Background()
	_, _ = pool.Exec(ctx, `INSERT INTO users (user_id, email, email_deliverable, monthly_income, employment_status, age)
		VALUES ('U1','Same@Gmail.com',true,50000,'Salaried',30), ('U2','same@gmail.com',true,50000,'Salaried',30)`)
	tok, _ := notifications.MakeToken("U1", time.Now(), notifications.DefaultTTL)
	for range 2 { // idempotent
		if ok, err := notifications.Unsubscribe(ctx, pool, tok, time.Now()); !ok || err != nil {
			t.Fatal(ok, err)
		}
	}
	var n int
	_ = pool.QueryRow(ctx, "SELECT count(*) FROM suppression WHERE email_hash = encode(sha256('same@gmail.com'), 'hex')").Scan(&n)
	if n != 1 {
		t.Fatal(n)
	}
}
