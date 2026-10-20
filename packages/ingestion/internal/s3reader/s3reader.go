// Package s3reader streams an uploaded object. The only S3 code in ingestion (vendor isolation).
package s3reader

import (
	"context"
	"io"
	"sync"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

var (
	once   sync.Once
	client *s3.Client
	cfgErr error
)

// Open returns the object body as a stream: bytes arrive as they're read, so a 1 GB file never
// sits in memory. The client is created once per container.
func Open(ctx context.Context, bucket, key string) (io.ReadCloser, error) {
	once.Do(func() {
		cfg, err := config.LoadDefaultConfig(ctx)
		cfgErr = err
		client = s3.NewFromConfig(cfg)
	})
	if cfgErr != nil {
		return nil, cfgErr
	}
	out, err := client.GetObject(ctx, &s3.GetObjectInput{Bucket: &bucket, Key: &key})
	if err != nil {
		return nil, err
	}
	return out.Body, nil
}
