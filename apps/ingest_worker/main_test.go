package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"loanengine/packages/database"

	"github.com/aws/aws-lambda-go/events"

	"loanengine/packages/ingestion"
)

func sqs(id, key string) events.SQSEvent {
	body, _ := json.Marshal(map[string]any{"Records": []any{map[string]any{"s3": map[string]any{"object": map[string]any{"key": key}}}}})
	return events.SQSEvent{Records: []events.SQSMessage{{MessageId: id, Body: string(body)}}}
}

func TestWorkerRoutesDecodedKeysAndReportsFailuresPerMessage(t *testing.T) {
	var seen []string
	run := func(_ context.Context, _ *database.Pool, batchID, key string) (ingestion.Result, error) {
		seen = append(seen, batchID+"|"+key)
		if batchID == "bad" {
			return ingestion.Result{}, errors.New("s3 timeout")
		}
		return ingestion.Result{Status: "LOADED"}, nil
	}
	ok := handle(context.Background(), nil, run, sqs("m1", "uploads/b1/my+users.csv"))
	if len(ok.BatchItemFailures) != 0 || seen[0] != "b1|uploads/b1/my users.csv" {
		t.Fatal(ok, seen)
	}
	failed := handle(context.Background(), nil, run, sqs("m2", "uploads/bad/x.csv"))
	if len(failed.BatchItemFailures) != 1 || failed.BatchItemFailures[0].ItemIdentifier != "m2" {
		t.Fatal(failed)
	}
	other := handle(context.Background(), nil, run, sqs("m3", "elsewhere/x.csv"))
	test := handle(context.Background(), nil, run, events.SQSEvent{Records: []events.SQSMessage{{MessageId: "t", Body: `{"Event":"s3:TestEvent"}`}}})
	if len(other.BatchItemFailures)+len(test.BatchItemFailures) != 0 || len(seen) != 2 {
		t.Fatal(other, test, seen)
	}
}
