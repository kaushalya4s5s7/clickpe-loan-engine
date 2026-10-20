package main

// Handlers: receive → validate shape → call a package → respond. No SQL, no AWS SDK, no rules here.

import (
	"context"
	"fmt"
	"html"
	"net/http"
	"strconv"

	"loanengine/packages/batches"
	"loanengine/packages/ingestion"
	"loanengine/packages/notifications"
	"loanengine/packages/reporting"
	"loanengine/packages/uploads"
)

func (a *App) overview(ctx context.Context, _ request) (response, error) {
	o, err := reporting.GetOverview(ctx, a.DB) // aggregates only: safe without an API key
	return ok(http.StatusOK, o), err
}

func (a *App) schema(context.Context, request) (response, error) {
	return ok(http.StatusOK, map[string]any{"columns": ingestion.Columns()}), nil
}

func (a *App) products(ctx context.Context, _ request) (response, error) {
	ps, err := reporting.Products(ctx, a.DB)
	return ok(http.StatusOK, map[string]any{"products": ps}), err
}

func (a *App) recentBatches(ctx context.Context, req request) (response, error) {
	limit := 20
	if v, set := req.QueryStringParameters["limit"]; set {
		n, err := strconv.Atoi(v)
		if err != nil {
			return response{}, &badRequest{"limit must be a number"}
		}
		limit = n
	}
	bs, err := batches.Recent(ctx, a.DB, limit)
	return ok(http.StatusOK, map[string]any{"batches": bs}), err
}

func (a *App) createUpload(ctx context.Context, req request) (response, error) {
	var body struct {
		Filename  string  `json:"filename"`
		SizeBytes *int64  `json:"size_bytes"`
		SHA256    *string `json:"sha256"`
	}
	if err := decode(req, &body); err != nil {
		return response{}, err
	}
	if body.SizeBytes == nil {
		return response{}, &badRequest{"size_bytes must be an integer"}
	}
	s, err := a.Uploads.CreateSession(ctx, a.DB, body.Filename, *body.SizeBytes, body.SHA256)
	return ok(http.StatusCreated, s), err
}

func (a *App) partURLs(ctx context.Context, req request) (response, error) {
	id, err := pathParam(req, "batch_id")
	var body struct {
		Parts []uploads.PartRequest `json:"parts"`
	}
	if err == nil {
		err = decode(req, &body)
	}
	if err != nil {
		return response{}, err
	}
	urls, err := a.Uploads.PresignParts(ctx, a.DB, id, body.Parts)
	return ok(http.StatusOK, map[string]any{"urls": urls}), err
}

func (a *App) uploadedParts(ctx context.Context, req request) (response, error) {
	id, err := pathParam(req, "batch_id")
	if err != nil {
		return response{}, err
	}
	parts, err := a.Uploads.ListParts(ctx, a.DB, id)
	if parts == nil {
		parts = []uploads.UploadedPart{}
	}
	return ok(http.StatusOK, map[string]any{"parts": parts}), err
}

func (a *App) completeUpload(ctx context.Context, req request) (response, error) {
	id, err := pathParam(req, "batch_id")
	if err != nil {
		return response{}, err
	}
	done, err := a.Uploads.Complete(ctx, a.DB, id)
	return ok(http.StatusOK, done), err
}

func (a *App) abortUpload(ctx context.Context, req request) (response, error) {
	id, err := pathParam(req, "batch_id")
	if err != nil {
		return response{}, err
	}
	return respond(http.StatusNoContent, "application/json", "", nil), a.Uploads.Abort(ctx, a.DB, id)
}

// batchStatus is everything the batch page shows, in one poll.
func (a *App) batchStatus(ctx context.Context, req request) (response, error) {
	id, err := pathParam(req, "batch_id")
	if err != nil {
		return response{}, err
	}
	b, err := batches.Get(ctx, a.DB, id)
	if err != nil {
		return response{}, err
	}
	timeline, err := batches.Timeline(ctx, a.DB, id)
	if err != nil {
		return response{}, err
	}
	preview, err := ingestion.ErrorPreview(ctx, a.DB, id, 8)
	if err != nil {
		return response{}, err
	}
	summary, err := reporting.GetBatchSummary(ctx, a.DB, id)
	return ok(http.StatusOK, map[string]any{"batch": b, "timeline": timeline, "errors_preview": preview, "summary": summary}), err
}

func (a *App) errorsCSV(ctx context.Context, req request) (response, error) {
	id, err := pathParam(req, "batch_id")
	if err != nil {
		return response{}, err
	}
	if _, err := batches.Get(ctx, a.DB, id); err != nil {
		return response{}, err
	}
	report, err := ingestion.ErrorReportCSV(ctx, a.DB, id)
	return respond(http.StatusOK, "text/csv; charset=utf-8", string(report),
		map[string]string{"Content-Disposition": fmt.Sprintf(`attachment; filename="errors-%s.csv"`, id[:8])}), err
}

// Unsubscribe: GET shows a confirm button, POST unsubscribes. Never unsubscribe on GET: mail
// scanners and link previewers open every link in an email. POST also serves RFC 8058 one-click.
const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Unsubscribe · Loan Match</title><style>
body{margin:0;font-family:system-ui,-apple-system,sans-serif;color:#1e1e1e;background:#fff}
main{max-width:30rem;margin:5rem auto;padding:0 1rem} h1{font-family:Georgia,serif;font-weight:400;font-size:2.2rem;letter-spacing:-.02em}
p{color:#7f7f7f} button{font:inherit;padding:.7rem 1.2rem;border-radius:8px;border:0;background:#07f;color:#fff;cursor:pointer}
</style></head><body><main>%s</main></body></html>`

func htmlPage(status int, content string) response {
	return respond(status, "text/html; charset=utf-8", fmt.Sprintf(page, content), nil)
}

func (a *App) unsubscribePage(_ context.Context, req request) (response, error) {
	token := req.QueryStringParameters["t"]
	if _, err := notifications.VerifyToken(token, a.Now()); err != nil {
		return response{}, err // bad links fail here, before showing a button
	}
	return htmlPage(http.StatusOK, fmt.Sprintf(`<h1>Stop loan offer emails?</h1><form method="post" action="?t=%s">
<button type="submit">Unsubscribe</button></form>`, html.EscapeString(token))), nil
}

func (a *App) unsubscribe(ctx context.Context, req request) (response, error) {
	if _, err := notifications.Unsubscribe(ctx, a.DB, req.QueryStringParameters["t"], a.Now()); err != nil {
		return response{}, err
	}
	return htmlPage(http.StatusOK, "<h1>You're unsubscribed</h1><p>You won't receive loan offer emails from us again.</p>"), nil
}
