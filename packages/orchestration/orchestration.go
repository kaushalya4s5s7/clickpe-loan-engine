// Package orchestration tells the workflow engine that a batch is ready for matching.
//
// Best-effort by design: if the call fails, the batch is still LOADED in the database and the
// n8n sweeper picks it up within minutes. The DB row is the source of truth; this call only
// removes the polling delay. See docs/DESIGN.md §9.4.
package orchestration

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"
)

// Sign = hex(HMAC-SHA256(secret, "<timestamp>.<batch_id>")). We sign the field that matters rather
// than raw body bytes: n8n hands its Code node an already-parsed body, and re-serialising JSON
// byte-for-byte is fragile. n8n rejects signatures older than 5 minutes (no replays).
func Sign(secret, timestamp, batchID string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(timestamp + "." + batchID))
	return hex.EncodeToString(m.Sum(nil))
}

var client = &http.Client{}

// TriggerMatching rings the doorbell. It never returns an error: failure only means the sweeper
// will notice the batch a little later.
func TriggerMatching(ctx context.Context, batchID string) bool {
	keys, err := LoadKeys()
	if err != nil {
		slog.Warn("doorbell misconfigured", "err", err)
		return false
	}
	if keys.WebhookURL == "" {
		slog.Info("doorbell disabled; sweeper will pick up the batch", "batch_id", batchID)
		return false
	}
	body, _ := json.Marshal(map[string]string{"batch_id": batchID, "event": "batch_loaded"})
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	ctx, cancel := context.WithTimeout(ctx, keys.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, keys.WebhookURL, bytes.NewReader(body))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Timestamp", ts)
	req.Header.Set("X-Signature", Sign(keys.WebhookSecret, ts, batchID))
	resp, err := client.Do(req)
	if err != nil {
		slog.Warn("doorbell failed", "batch_id", batchID, "err", err)
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}
