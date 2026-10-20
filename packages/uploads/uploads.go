// Package uploads hands out resumable, checksummed, size-capped multipart upload sessions.
//
// The browser sends file bytes straight to object storage with short-lived signed URLs; this
// package only grants permission and verifies the result. File bytes never pass through
// API Gateway or Lambda (no 10 MB / 29 s limits). See docs/DESIGN.md §9.1.
package uploads

import (
	"context"
	"encoding/base64"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"loanengine/packages/batches"
	"loanengine/packages/database"
	"loanengine/packages/uploads/internal/s3store"
)

const (
	MiB        = 1 << 20
	s3MaxParts = 10_000
)

// ObjectStore is the storage capability uploads needs; S3 in production, a fake in tests.
type ObjectStore interface {
	Start(ctx context.Context, bucket, key string) (string, error)
	PresignPart(ctx context.Context, bucket, key, uploadID string, part int32, sha256b64 string, ttl time.Duration) (string, map[string]string, error)
	Parts(ctx context.Context, bucket, key, uploadID string) ([]s3store.Part, error)
	Finish(ctx context.Context, bucket, key, uploadID string, parts []s3store.Part) error
	Cancel(ctx context.Context, bucket, key, uploadID string) error
}

// Part re-exports the storage part type as part of this package's contract.
type Part = s3store.Part

// InvalidUpload is a client error with a stable machine-readable code (mapped to HTTP 4xx by apps/api).
type InvalidUpload struct{ Code, Message string }

func (e *InvalidUpload) Error() string { return e.Message }

type Session struct {
	BatchID     string `json:"batch_id"`
	PartSize    int64  `json:"part_size"`
	PartCount   int    `json:"part_count"`
	MaxParallel int    `json:"max_parallel"` // client hint: saturates a typical uplink without starving the tab
}

type PartRequest struct {
	PartNumber int    `json:"part_number"`
	SHA256     string `json:"sha256"`
}

type PartURL struct {
	PartNumber int               `json:"part_number"`
	URL        string            `json:"url"`
	Headers    map[string]string `json:"headers"`
}

type UploadedPart struct {
	PartNumber int    `json:"part_number"`
	ETag       string `json:"etag"`
	Size       int64  `json:"size"`
}

type Completed struct {
	BatchID   string `json:"batch_id"`
	SizeBytes int64  `json:"size_bytes"`
	Status    string `json:"status"`
}

// Service orchestrates policy (pure rules), storage (vendor) and batches (state).
type Service struct {
	keys  Keys
	store ObjectStore
}

// New takes the store explicitly: a real runtime dependency (S3 vs. a test fake), not abstraction for its own sake.
func New(keys Keys, store ObjectStore) *Service { return &Service{keys: keys, store: store} }

// NewFromEnv wires the production S3 store.
func NewFromEnv(ctx context.Context) (*Service, error) {
	keys, err := LoadKeys()
	if err != nil {
		return nil, err
	}
	store, err := s3store.New(ctx, keys.Region)
	if err != nil {
		return nil, err
	}
	return New(keys, store), nil
}

func (s *Service) CreateSession(ctx context.Context, q database.Querier, filename string, size int64, sha256 *string) (Session, error) {
	parts, err := validateRequest(filename, size, s.keys.MaxUploadBytes, s.keys.PartSize)
	if err != nil {
		return Session{}, err
	}
	id := uuid.NewString()
	key := ObjectKey(id, filename)
	uploadID, err := s.store.Start(ctx, s.keys.Bucket, key)
	if err != nil {
		return Session{}, err
	}
	if err := batches.Create(ctx, q, id, filename, key, size, &uploadID, sha256); err != nil {
		return Session{}, err
	}
	return Session{BatchID: id, PartSize: s.keys.PartSize, PartCount: parts, MaxParallel: 4}, nil
}

func (s *Service) openBatch(ctx context.Context, q database.Querier, id string) (batches.Batch, error) {
	b, err := batches.Get(ctx, q, id)
	if err != nil {
		return b, err
	}
	if b.Status != batches.Created || b.UploadID == nil {
		return b, &InvalidUpload{"INVALID_STATE", fmt.Sprintf("upload is %s, not accepting parts", b.Status)}
	}
	return b, nil
}

func (s *Service) partCount(size int64) int {
	return int(math.Ceil(float64(size) / float64(s.keys.PartSize)))
}

func (s *Service) PresignParts(ctx context.Context, q database.Querier, id string, reqs []PartRequest) ([]PartURL, error) {
	b, err := s.openBatch(ctx, q, id)
	if err != nil {
		return nil, err
	}
	count := s.partCount(b.SizeBytes)
	if len(reqs) == 0 || len(reqs) > 100 {
		return nil, &InvalidUpload{"BAD_PARTS", "request between 1 and 100 parts at a time"}
	}
	out := make([]PartURL, 0, len(reqs))
	for _, r := range reqs {
		if r.PartNumber < 1 || r.PartNumber > count {
			return nil, &InvalidUpload{"BAD_PARTS", fmt.Sprintf("part numbers must be in 1..%d", count)}
		}
		if raw, err := base64.StdEncoding.DecodeString(r.SHA256); err != nil || len(raw) != 32 {
			return nil, &InvalidUpload{"BAD_CHECKSUM", "checksum must be base64-encoded SHA-256"}
		}
		url, headers, err := s.store.PresignPart(ctx, s.keys.Bucket, b.S3Key, *b.UploadID, int32(r.PartNumber), r.SHA256, s.keys.URLTTL)
		if err != nil {
			return nil, err
		}
		out = append(out, PartURL{PartNumber: r.PartNumber, URL: url, Headers: headers})
	}
	return out, nil
}

// ListParts tells a resuming client which parts S3 already holds.
func (s *Service) ListParts(ctx context.Context, q database.Querier, id string) ([]UploadedPart, error) {
	b, err := s.openBatch(ctx, q, id)
	if err != nil {
		return nil, err
	}
	parts, err := s.store.Parts(ctx, s.keys.Bucket, b.S3Key, *b.UploadID)
	out := make([]UploadedPart, len(parts))
	for i, p := range parts {
		out[i] = UploadedPart{PartNumber: int(p.Number), ETag: p.ETag, Size: p.Size}
	}
	return out, err
}

// Complete assembles the object from the parts S3 actually has (server truth, not client claims):
// every expected part present and the total equal to the declared size, so a client can't
// declare 1 MB and then upload 5 GB.
func (s *Service) Complete(ctx context.Context, q database.Querier, id string) (Completed, error) {
	b, err := s.openBatch(ctx, q, id)
	if err != nil {
		return Completed{}, err
	}
	stored, err := s.store.Parts(ctx, s.keys.Bucket, b.S3Key, *b.UploadID)
	if err != nil {
		return Completed{}, err
	}
	sort.Slice(stored, func(i, j int) bool { return stored[i].Number < stored[j].Number })
	expected := s.partCount(b.SizeBytes)
	var missing []int
	have := map[int32]bool{}
	var total int64
	for _, p := range stored {
		have[p.Number] = true
		total += p.Size
	}
	for n := 1; n <= expected; n++ {
		if !have[int32(n)] {
			missing = append(missing, n)
		}
	}
	if len(missing) > 0 || len(stored) != expected {
		return Completed{}, &InvalidUpload{"INCOMPLETE_UPLOAD", fmt.Sprintf("missing parts: %v", head(missing, 20))}
	}
	if total != b.SizeBytes || total > s.keys.MaxUploadBytes {
		_ = s.store.Cancel(ctx, s.keys.Bucket, b.S3Key, *b.UploadID)
		msg := "size mismatch"
		_, _ = batches.Transition(ctx, q, id, []batches.Status{batches.Created}, batches.Aborted, batches.Fields{Error: &msg})
		return Completed{}, &InvalidUpload{"SIZE_MISMATCH", fmt.Sprintf("declared %d bytes, received %d", b.SizeBytes, total)}
	}
	if err := s.store.Finish(ctx, s.keys.Bucket, b.S3Key, *b.UploadID, stored); err != nil {
		return Completed{}, err
	}
	// The S3 event may reach the ingest worker before this commit; the worker accepts CREATED too.
	if _, err := batches.Transition(ctx, q, id, []batches.Status{batches.Created}, batches.Uploaded, batches.Fields{}); err != nil {
		return Completed{}, err
	}
	_ = batches.RecordEvent(ctx, q, id, "upload", "completed", map[string]any{"size_bytes": total, "parts": expected})
	return Completed{BatchID: id, SizeBytes: total, Status: string(batches.Uploaded)}, nil
}

func (s *Service) Abort(ctx context.Context, q database.Querier, id string) error {
	b, err := s.openBatch(ctx, q, id)
	if err != nil {
		return err
	}
	if err := s.store.Cancel(ctx, s.keys.Bucket, b.S3Key, *b.UploadID); err != nil {
		return err
	}
	msg := "aborted by user"
	_, err = batches.Transition(ctx, q, id, []batches.Status{batches.Created}, batches.Aborted, batches.Fields{Error: &msg})
	_ = batches.RecordEvent(ctx, q, id, "upload", "aborted", nil)
	return err
}

// ---------------------------------------------------------------- pure rules

var (
	allowedSuffixes = []string{".csv", ".csv.gz", ".txt", ".tsv"}
	unsafeChars     = regexp.MustCompile(`[^A-Za-z0-9._-]+`)
)

func validateRequest(filename string, size, maxBytes, partSize int64) (int, error) {
	lower := strings.ToLower(filename)
	ok := false
	for _, s := range allowedSuffixes {
		ok = ok || strings.HasSuffix(lower, s)
	}
	switch {
	case filename == "" || !ok:
		return 0, &InvalidUpload{"UNSUPPORTED_FILE_TYPE", "Upload a CSV file (.csv, .csv.gz, .txt, .tsv)"}
	case size <= 0:
		return 0, &InvalidUpload{"EMPTY_FILE", "The file is empty"}
	case size > maxBytes:
		return 0, &InvalidUpload{"FILE_TOO_LARGE", fmt.Sprintf("File is %d bytes; the limit is %d", size, maxBytes)}
	}
	parts := int(math.Ceil(float64(size) / float64(partSize)))
	if parts > s3MaxParts {
		return 0, &InvalidUpload{"FILE_TOO_LARGE", "Too many parts for this part size"}
	}
	return parts, nil
}

// SafeFilename keeps user-controlled path characters out of object keys (no "../", no spaces).
func SafeFilename(name string) string {
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	name = strings.Trim(unsafeChars.ReplaceAllString(name, "_"), "._")
	if len(name) > 100 {
		name = name[:100]
	}
	if name == "" {
		return "upload.csv"
	}
	return name
}

// ObjectKey puts the batch id first so the ingest worker can recover it from the S3 event.
func ObjectKey(batchID, filename string) string {
	return "uploads/" + batchID + "/" + SafeFilename(filename)
}

// BatchIDFromKey is the inverse of ObjectKey ("" if the key isn't an upload).
func BatchIDFromKey(key string) string {
	parts := strings.Split(key, "/")
	if len(parts) >= 3 && parts[0] == "uploads" {
		return parts[1]
	}
	return ""
}

func head(xs []int, n int) []int { return xs[:min(n, len(xs))] }
