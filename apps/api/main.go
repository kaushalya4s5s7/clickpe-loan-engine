// Command api is the HTTP backend behind API Gateway: one Lambda, one route table.
//
// Why one function, not one per route: every route shares the same dependencies (a DB pool and an
// S3 client), so one warm container serves all of them — one cold start instead of thirteen.
package main

import (
	"context"
	"log/slog"
	"os"
	"time"

	"github.com/aws/aws-lambda-go/lambda"

	"loanengine/packages/database"
	"loanengine/packages/uploads"
)

// App holds the dependencies handlers need; tests build it with a test DB and a fake S3.
type App struct {
	DB      *database.Pool
	Uploads *uploads.Service
	Now     func() time.Time
}

type handlerFunc func(*App, context.Context, request) (response, error)

var routes = map[string]handlerFunc{
	"GET /v1/overview":                      (*App).overview,
	"GET /v1/uploads/schema":                (*App).schema,
	"GET /v1/products":                      (*App).products,
	"GET /v1/batches":                       (*App).recentBatches,
	"POST /v1/uploads":                      (*App).createUpload,
	"POST /v1/uploads/{batch_id}/part-urls": (*App).partURLs,
	"GET /v1/uploads/{batch_id}/parts":      (*App).uploadedParts,
	"POST /v1/uploads/{batch_id}/complete":  (*App).completeUpload,
	"DELETE /v1/uploads/{batch_id}":         (*App).abortUpload,
	"GET /v1/batches/{batch_id}":            (*App).batchStatus,
	"GET /v1/batches/{batch_id}/errors.csv": (*App).errorsCSV,
	"GET /v1/unsubscribe":                   (*App).unsubscribePage,
	"POST /v1/unsubscribe":                  (*App).unsubscribe,
}

// Handle routes one API Gateway request. A panic in a handler becomes a 500, never a crash loop.
func (a *App) Handle(ctx context.Context, req request) (resp response, _ error) {
	route := req.HTTPMethod + " " + req.Resource
	h, found := routes[route]
	if !found {
		return fail(404, "NOT_FOUND", "no such route"), nil
	}
	defer func() {
		if r := recover(); r != nil {
			slog.Error("panic", "route", route, "panic", r)
			resp = fail(500, "INTERNAL", "something went wrong; please retry")
		}
	}()
	resp, err := h(a, ctx, req)
	if err != nil {
		return toResponse(route, err), nil
	}
	return resp, nil
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	ctx := context.Background()
	// Created once per container (outside the handler) and reused by every warm invocation.
	pool, err := database.Shared(ctx)
	if err != nil {
		slog.Error("database", "err", err)
		os.Exit(1)
	}
	svc, err := uploads.NewFromEnv(ctx)
	if err != nil {
		slog.Error("uploads", "err", err)
		os.Exit(1)
	}
	app := &App{DB: pool, Uploads: svc, Now: time.Now}
	lambda.Start(app.Handle)
}
