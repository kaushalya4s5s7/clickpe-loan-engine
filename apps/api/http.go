package main

// Transport helpers for API Gateway (REST, Lambda proxy). The ONE place where service errors
// become HTTP status codes, so handlers stay four lines. Error model: {"error":{"code","message"}}.

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/aws/aws-lambda-go/events"

	"loanengine/packages/batches"
	"loanengine/packages/notifications"
	"loanengine/packages/uploads"
)

type response = events.APIGatewayProxyResponse
type request = events.APIGatewayProxyRequest

var cors = map[string]string{"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type,X-Api-Key",
	"Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS"}

// statusFor maps stable service error codes to HTTP statuses (anything unlisted is a 400).
var statusFor = map[string]int{"FILE_TOO_LARGE": 413, "INVALID_STATE": 409, "SIZE_MISMATCH": 422, "INCOMPLETE_UPLOAD": 409}

type badRequest struct{ msg string }

func (b *badRequest) Error() string { return b.msg }

func respond(status int, contentType, body string, extra map[string]string) response {
	h := map[string]string{"Content-Type": contentType}
	for k, v := range cors {
		h[k] = v
	}
	for k, v := range extra {
		h[k] = v
	}
	return response{StatusCode: status, Headers: h, Body: body}
}

func ok(status int, v any) response {
	body, _ := json.Marshal(v)
	return respond(status, "application/json", string(body), nil)
}

func fail(status int, code, msg string) response {
	return ok(status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

// toResponse turns a handler error into the error model; unknown errors never leak internals.
func toResponse(route string, err error) response {
	var inv *uploads.InvalidUpload
	var br *badRequest
	switch {
	case errors.As(err, &inv):
		status := statusFor[inv.Code]
		if status == 0 {
			status = http.StatusBadRequest
		}
		return fail(status, inv.Code, inv.Message)
	case errors.As(err, &br):
		return fail(http.StatusBadRequest, "BAD_REQUEST", br.msg)
	case errors.Is(err, batches.ErrNotFound):
		return fail(http.StatusNotFound, "BATCH_NOT_FOUND", "no such batch")
	case errors.Is(err, notifications.ErrInvalidToken):
		return fail(http.StatusBadRequest, "INVALID_TOKEN", "this link is invalid or has expired")
	}
	slog.Error("unhandled error", "route", route, "err", err)
	return fail(http.StatusInternalServerError, "INTERNAL", "something went wrong; please retry")
}

func decode(req request, into any) error {
	body := req.Body
	if req.IsBase64Encoded {
		raw, err := base64.StdEncoding.DecodeString(body)
		if err != nil {
			return &badRequest{"body must be JSON"}
		}
		body = string(raw)
	}
	if body == "" {
		body = "{}"
	}
	if err := json.Unmarshal([]byte(body), into); err != nil {
		return &badRequest{"body must be a JSON object"}
	}
	return nil
}

func pathParam(req request, name string) (string, error) {
	if v := req.PathParameters[name]; v != "" {
		return v, nil
	}
	return "", &badRequest{"missing path parameter " + name}
}
