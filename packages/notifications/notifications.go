// Package notifications owns the parts of notifying that are not sending.
//
// Sending lives in n8n workflow C (the brief requires the n8n SES node). This package owns the
// unsubscribe link: signed tokens (generated identically by n8n's email renderer) and the
// suppression list workflow C checks before every send.
package notifications

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"loanengine/packages/database"
)

var ErrInvalidToken = errors.New("INVALID_TOKEN")

const DefaultTTL = 90 * 24 * time.Hour // links in old emails keep working for a quarter

var b64 = base64.RawURLEncoding

func sign(secret, payload string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(payload))
	return b64.EncodeToString(m.Sum(nil)[:16])
}

// MakeToken returns "<user_id b64url>.<expiry unix>.<sig>": no email or other PII in the URL.
// Identical to apps/workflows/src/code/email.js::unsubscribeToken (contract-tested).
func MakeToken(userID string, now time.Time, ttl time.Duration) (string, error) {
	keys, err := LoadKeys()
	if err != nil {
		return "", err
	}
	payload := b64.EncodeToString([]byte(userID)) + "." + strconv.FormatInt(now.Add(ttl).Unix(), 10)
	return payload + "." + sign(keys.UnsubscribeSecret, payload), nil
}

// VerifyToken returns the user_id inside a valid, unexpired token.
func VerifyToken(token string, now time.Time) (string, error) {
	keys, err := LoadKeys()
	if err != nil {
		return "", err
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", ErrInvalidToken
	}
	// constant-time comparison: no timing side channel on the signature
	if !hmac.Equal([]byte(parts[2]), []byte(sign(keys.UnsubscribeSecret, parts[0]+"."+parts[1]))) {
		return "", ErrInvalidToken
	}
	expiry, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || expiry < now.Unix() {
		return "", ErrInvalidToken
	}
	uid, err := b64.DecodeString(parts[0])
	if err != nil {
		return "", ErrInvalidToken
	}
	return string(uid), nil
}

// Unsubscribe suppresses the address behind a token. Idempotent; false if the user is gone.
// Suppression is keyed by sha256(lower(email)), so it covers every user_id sharing that address
// (common in partner data) and survives deleting the user (DPDP erasure).
func Unsubscribe(ctx context.Context, q database.Querier, token string, now time.Time) (bool, error) {
	userID, err := VerifyToken(token, now)
	if err != nil {
		return false, err
	}
	var email string
	err = q.QueryRow(ctx, "UPDATE users SET consent_marketing = false, updated_at = now() WHERE user_id = $1 RETURNING email",
		userID).Scan(&email)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	_, err = q.Exec(ctx, `INSERT INTO suppression (email_hash, reason)
		VALUES (encode(sha256(convert_to(lower($1), 'UTF8')), 'hex'), 'unsubscribe') ON CONFLICT (email_hash) DO NOTHING`, email)
	return err == nil, err
}
