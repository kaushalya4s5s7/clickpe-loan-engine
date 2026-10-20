package batches_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"loanengine/internal/testdb"
	"loanengine/packages/batches"
)

func newBatch(t *testing.T) (context.Context, *testing.T, string) {
	return context.Background(), t, uuid.NewString()
}

func TestTransitionIsCompareAndSet(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx, _, id := newBatch(t)
	must(t, batches.Create(ctx, pool, id, "f.csv", "uploads/"+id+"/f.csv", 10, nil, nil))
	ok, err := batches.Transition(ctx, pool, id, []batches.Status{batches.Created}, batches.Uploaded, batches.Fields{})
	must(t, err)
	again, _ := batches.Transition(ctx, pool, id, []batches.Status{batches.Created}, batches.Uploaded, batches.Fields{})
	if !ok || again {
		t.Fatalf("first transition must win, second must lose: %v %v", ok, again)
	}
	b, _ := batches.Get(ctx, pool, id)
	if b.Status != batches.Uploaded {
		t.Fatal(b.Status)
	}
}

func TestClaimReclaimsOnlyExpiredLeases(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx, _, id := newBatch(t)
	must(t, batches.Create(ctx, pool, id, "f.csv", "uploads/"+id+"/f.csv", 10, nil, nil))
	from := []batches.Status{batches.Created}
	first, _ := batches.Claim(ctx, pool, id, from, batches.Parsing, time.Minute)
	held, _ := batches.Claim(ctx, pool, id, from, batches.Parsing, time.Minute)
	_, _ = pool.Exec(ctx, "UPDATE ingest_batches SET lease_until = now() - interval '1 s' WHERE id = $1::uuid", id)
	reclaimed, _ := batches.Claim(ctx, pool, id, from, batches.Parsing, time.Minute)
	if !first || held || !reclaimed {
		t.Fatalf("claim=%v held=%v reclaim=%v", first, held, reclaimed)
	}
}

func TestMissingBatchAndTimeline(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx, _, id := newBatch(t)
	for _, bad := range []string{id, "not-a-uuid", "'; DROP TABLE users;--"} {
		if _, err := batches.Get(ctx, pool, bad); !errors.Is(err, batches.ErrNotFound) {
			t.Fatal(bad, err)
		}
	}
	must(t, batches.Create(ctx, pool, id, "f.csv", "uploads/"+id+"/f.csv", 10, nil, nil))
	must(t, batches.RecordEvent(ctx, pool, id, "ingest", "started", nil))
	tl, _ := batches.Timeline(ctx, pool, id)
	if len(tl) != 2 || tl[0].Stage != "upload" || tl[1].Stage != "ingest" {
		t.Fatalf("%+v", tl)
	}
	recent, _ := batches.Recent(ctx, pool, 5)
	if len(recent) != 1 || recent[0].ID != id {
		t.Fatalf("%+v", recent)
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
