package orchestration

import (
	"errors"
	"os"
	"strings"
	"time"
)

type Keys struct {
	WebhookURL    string // empty = doorbell disabled (sweeper-only mode)
	WebhookSecret string // shared HMAC secret with the n8n workflow
	Timeout       time.Duration
}

func LoadKeys() (Keys, error) {
	k := Keys{WebhookURL: strings.TrimSpace(os.Getenv("N8N_WEBHOOK_URL")), WebhookSecret: os.Getenv("N8N_WEBHOOK_SECRET"),
		Timeout: 3 * time.Second}
	if k.WebhookURL != "" && len(k.WebhookSecret) < 16 {
		return k, errors.New("N8N_WEBHOOK_SECRET must be at least 16 characters")
	}
	return k, nil
}
