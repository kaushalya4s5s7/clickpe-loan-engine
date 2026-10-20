package uploads_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"testing"
	"time"

	"loanengine/internal/testdb"
	"loanengine/packages/batches"
	"loanengine/packages/uploads"
)

// fakeStore behaves like S3 for the parts of the contract we rely on, including rejecting a part
// whose bytes don't match its signed checksum.
type fakeStore struct {
	parts     map[int32][]byte
	cancelled bool
}

func (f *fakeStore) Start(context.Context, string, string) (string, error) {
	f.parts = map[int32][]byte{}
	return "up-1", nil
}
func (f *fakeStore) PresignPart(_ context.Context, _, _, _ string, part int32, sum string, _ time.Duration) (string, map[string]string, error) {
	return fmt.Sprintf("fake://part/%d", part), map[string]string{"x-amz-checksum-sha256": sum}, nil
}
func (f *fakeStore) Parts(context.Context, string, string, string) ([]uploads.Part, error) {
	var out []uploads.Part
	for n, b := range f.parts {
		out = append(out, uploads.Part{Number: n, ETag: "e", Size: int64(len(b))})
	}
	return out, nil
}
func (f *fakeStore) Finish(context.Context, string, string, string, []uploads.Part) error { return nil }
func (f *fakeStore) Cancel(context.Context, string, string, string) error {
	f.cancelled = true
	return nil
}

// put is what the browser does with a presigned URL.
func (f *fakeStore) put(n int32, data []byte, headers map[string]string) error {
	sum := sha256.Sum256(data)
	if base64.StdEncoding.EncodeToString(sum[:]) != headers["x-amz-checksum-sha256"] {
		return errors.New("BadDigest")
	}
	f.parts[n] = data
	return nil
}

func sha(b []byte) string { s := sha256.Sum256(b); return base64.StdEncoding.EncodeToString(s[:]) }

func setup(t *testing.T) (*uploads.Service, *fakeStore, context.Context) {
	store := &fakeStore{}
	keys := uploads.Keys{Bucket: "b", MaxUploadBytes: 200 * uploads.MiB, PartSize: 8 * uploads.MiB, URLTTL: time.Hour, Region: "ap-south-1"}
	return uploads.New(keys, store), store, context.Background()
}

func TestMultipartRoundTripWithResume(t *testing.T) {
	pool, _ := testdb.New(t)
	svc, store, ctx := setup(t)
	data := make([]byte, 9*uploads.MiB) // 2 parts
	s, err := svc.CreateSession(ctx, pool, "users.csv", int64(len(data)), nil)
	if err != nil || s.PartCount != 2 {
		t.Fatal(s, err)
	}
	part1 := data[:8*uploads.MiB]
	urls, _ := svc.PresignParts(ctx, pool, s.BatchID, []uploads.PartRequest{{PartNumber: 1, SHA256: sha(part1)}})
	if err := store.put(1, part1, urls[0].Headers); err != nil {
		t.Fatal(err)
	}
	listed, _ := svc.ListParts(ctx, pool, s.BatchID) // "the browser refreshed"
	if len(listed) != 1 || listed[0].PartNumber != 1 {
		t.Fatal(listed)
	}
	var inv *uploads.InvalidUpload
	if _, err := svc.Complete(ctx, pool, s.BatchID); !errors.As(err, &inv) || inv.Code != "INCOMPLETE_UPLOAD" {
		t.Fatal(err)
	}
	part2 := data[8*uploads.MiB:]
	urls, _ = svc.PresignParts(ctx, pool, s.BatchID, []uploads.PartRequest{{PartNumber: 2, SHA256: sha(part2)}})
	_ = store.put(2, part2, urls[0].Headers)
	done, err := svc.Complete(ctx, pool, s.BatchID)
	if err != nil || done.SizeBytes != int64(len(data)) {
		t.Fatal(done, err)
	}
	if b, _ := batches.Get(ctx, pool, s.BatchID); b.Status != batches.Uploaded {
		t.Fatal(b.Status)
	}
}

func TestCorruptedPartRejectedAndSizeLieCaught(t *testing.T) {
	pool, _ := testdb.New(t)
	svc, store, ctx := setup(t)
	s, _ := svc.CreateSession(ctx, pool, "users.csv", 100, nil)
	urls, _ := svc.PresignParts(ctx, pool, s.BatchID, []uploads.PartRequest{{PartNumber: 1, SHA256: sha([]byte("hello"))}})
	if store.put(1, []byte("HELLO"), urls[0].Headers) == nil {
		t.Fatal("corrupted bytes must be rejected")
	}
	big := make([]byte, 150) // declared 100, sends 150
	urls, _ = svc.PresignParts(ctx, pool, s.BatchID, []uploads.PartRequest{{PartNumber: 1, SHA256: sha(big)}})
	_ = store.put(1, big, urls[0].Headers)
	var inv *uploads.InvalidUpload
	if _, err := svc.Complete(ctx, pool, s.BatchID); !errors.As(err, &inv) || inv.Code != "SIZE_MISMATCH" || !store.cancelled {
		t.Fatal(err)
	}
	if b, _ := batches.Get(ctx, pool, s.BatchID); b.Status != batches.Aborted {
		t.Fatal(b.Status)
	}
}

func TestRejectedRequests(t *testing.T) {
	pool, _ := testdb.New(t)
	svc, _, ctx := setup(t)
	for _, c := range []struct {
		name string
		size int64
		code string
	}{{"users.exe", 10, "UNSUPPORTED_FILE_TYPE"}, {"users.csv", 0, "EMPTY_FILE"}, {"users.csv", 1 << 40, "FILE_TOO_LARGE"}} {
		var inv *uploads.InvalidUpload
		if _, err := svc.CreateSession(ctx, pool, c.name, c.size, nil); !errors.As(err, &inv) || inv.Code != c.code {
			t.Fatal(c, err)
		}
	}
	s, _ := svc.CreateSession(ctx, pool, "u.csv", 100, nil)
	for _, req := range []uploads.PartRequest{{PartNumber: 2, SHA256: sha([]byte("a"))}, {PartNumber: 1, SHA256: "not-base64!"}} {
		if _, err := svc.PresignParts(ctx, pool, s.BatchID, []uploads.PartRequest{req}); err == nil {
			t.Fatal("expected rejection", req)
		}
	}
}

func TestObjectKeysCannotEscapeThePrefix(t *testing.T) {
	if k := uploads.ObjectKey("id", "../../etc/passwd.csv"); k != "uploads/id/passwd.csv" {
		t.Fatal(k)
	}
	if uploads.BatchIDFromKey("uploads/abc/f.csv") != "abc" || uploads.BatchIDFromKey("other/x") != "" {
		t.Fatal("BatchIDFromKey")
	}
}
