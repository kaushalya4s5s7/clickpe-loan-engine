// Command ingest_worker consumes SQS: one S3 "object created" event → ingestion.Run. Thin by design.
//
// Partial-batch responses: only the failed message is retried, never the whole batch. After 3 failed
// receives SQS moves it to the DLQ (alarmed). Duplicate deliveries are harmless — ingestion claims
// the batch with a compare-and-set.
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/url"
	"os"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"

	"loanengine/packages/database"
	"loanengine/packages/ingestion"
	"loanengine/packages/uploads"
)

// ingestFunc is ingestion.Run; a variable so tests can drive the worker without S3.
type ingestFunc func(ctx context.Context, pool *database.Pool, batchID, key string) (ingestion.Result, error)

func objectKeys(body string) ([]string, error) {
	var probe struct {
		Event string `json:"Event"`
	}
	if err := json.Unmarshal([]byte(body), &probe); err == nil && probe.Event == "s3:TestEvent" {
		return nil, nil // sent once when the bucket notification is configured
	}
	var ev events.S3Event
	if err := json.Unmarshal([]byte(body), &ev); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(ev.Records))
	for _, r := range ev.Records {
		k, err := url.QueryUnescape(r.S3.Object.Key) // S3 event keys are URL-encoded ("my+users.csv")
		if err != nil {
			return nil, err
		}
		keys = append(keys, k)
	}
	return keys, nil
}

func handle(ctx context.Context, pool *database.Pool, run ingestFunc, ev events.SQSEvent) events.SQSEventResponse {
	var resp events.SQSEventResponse
	for _, msg := range ev.Records {
		keys, err := objectKeys(msg.Body)
		for _, key := range keys {
			if err != nil {
				break
			}
			id := uploads.BatchIDFromKey(key)
			if id == "" {
				slog.Warn("ignoring object outside uploads/", "key", key)
				continue
			}
			var res ingestion.Result
			res, err = run(ctx, pool, id, key)
			slog.Info("ingested", "batch_id", id, "status", res.Status, "rows", res.RowsTotal, "rejected", res.RowsRejected,
				"ms", res.ElapsedMS)
		}
		if err != nil {
			slog.Error("ingest failed", "message_id", msg.MessageId, "err", err)
			resp.BatchItemFailures = append(resp.BatchItemFailures, events.SQSBatchItemFailure{ItemIdentifier: msg.MessageId})
		}
	}
	return resp
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	pool, err := database.Shared(context.Background())
	if err != nil {
		slog.Error("database", "err", err)
		os.Exit(1)
	}
	lambda.Start(func(ctx context.Context, ev events.SQSEvent) (events.SQSEventResponse, error) {
		return handle(ctx, pool, ingestion.Run, ev), nil
	})
}
