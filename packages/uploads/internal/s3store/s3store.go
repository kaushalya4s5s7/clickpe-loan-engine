// Package s3store is the only code in uploads that knows S3 exists (vendor isolation).
package s3store

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type Part struct {
	Number   int32
	ETag     string
	Size     int64
	Checksum string
}

type Store struct {
	client  *s3.Client
	presign *s3.PresignClient
}

// New builds a client pinned to the bucket's REGIONAL endpoint: the global endpoint can answer a
// fresh non-us-east-1 bucket with a 307 redirect, which browsers refuse to follow for a CORS PUT.
func New(ctx context.Context, region string, opts ...func(*s3.Options)) (*Store, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, err
	}
	opts = append([]func(*s3.Options){func(o *s3.Options) {
		o.BaseEndpoint = aws.String(fmt.Sprintf("https://s3.%s.amazonaws.com", region))
		// Only the checksum we choose (SHA-256 per part); no SDK-added defaults the browser can't reproduce.
		o.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired
	}}, opts...)
	client := s3.NewFromConfig(cfg, opts...)
	return &Store{client: client, presign: s3.NewPresignClient(client)}, nil
}

func (s *Store) Start(ctx context.Context, bucket, key string) (string, error) {
	out, err := s.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket: &bucket, Key: &key, ContentType: aws.String("text/csv"),
		ChecksumAlgorithm: types.ChecksumAlgorithmSha256, ServerSideEncryption: types.ServerSideEncryptionAes256,
	})
	if err != nil {
		return "", err
	}
	return aws.ToString(out.UploadId), nil
}

// PresignPart signs the part's SHA-256 INTO the URL: S3 rejects the PUT unless the client sends
// exactly that x-amz-checksum-sha256 header and the bytes hash to it. Returns the headers the
// client must send (they are part of the signature).
func (s *Store) PresignPart(ctx context.Context, bucket, key, uploadID string, part int32, sha256b64 string, ttl time.Duration) (string, map[string]string, error) {
	req, err := s.presign.PresignUploadPart(ctx, &s3.UploadPartInput{
		Bucket: &bucket, Key: &key, UploadId: &uploadID, PartNumber: aws.Int32(part),
		ChecksumAlgorithm: types.ChecksumAlgorithmSha256, ChecksumSHA256: &sha256b64,
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", nil, err
	}
	headers := map[string]string{}
	for name, values := range req.SignedHeader {
		if http.CanonicalHeaderKey(name) != "Host" && len(values) > 0 {
			headers[name] = values[0]
		}
	}
	return req.URL, headers, nil
}

func (s *Store) Parts(ctx context.Context, bucket, key, uploadID string) ([]Part, error) {
	var out []Part
	p := s3.NewListPartsPaginator(s.client, &s3.ListPartsInput{Bucket: &bucket, Key: &key, UploadId: &uploadID})
	for p.HasMorePages() {
		page, err := p.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, x := range page.Parts {
			out = append(out, Part{Number: aws.ToInt32(x.PartNumber), ETag: aws.ToString(x.ETag), Size: aws.ToInt64(x.Size),
				Checksum: aws.ToString(x.ChecksumSHA256)})
		}
	}
	return out, nil
}

func (s *Store) Finish(ctx context.Context, bucket, key, uploadID string, parts []Part) error {
	completed := make([]types.CompletedPart, len(parts))
	for i, p := range parts {
		completed[i] = types.CompletedPart{PartNumber: aws.Int32(p.Number), ETag: aws.String(p.ETag)}
		if p.Checksum != "" {
			completed[i].ChecksumSHA256 = aws.String(p.Checksum)
		}
	}
	_, err := s.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket: &bucket, Key: &key, UploadId: &uploadID, MultipartUpload: &types.CompletedMultipartUpload{Parts: completed},
	})
	return err
}

func (s *Store) Cancel(ctx context.Context, bucket, key, uploadID string) error {
	_, err := s.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{Bucket: &bucket, Key: &key, UploadId: &uploadID})
	return err
}
