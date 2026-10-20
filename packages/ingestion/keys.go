package ingestion

import (
	"os"
	"strconv"
	"time"
)

type Keys struct {
	Bucket          string
	MaxInvalidRatio float64       // circuit breaker: above this share of bad rows, merge nothing
	MaxErrorRows    int           // stored error rows per batch (all are counted; the first N are kept)
	MaxDecompressed int64         // gzip-bomb guard
	Lease           time.Duration // parse lease; must exceed the Lambda timeout
}

func LoadKeys() Keys {
	return Keys{
		Bucket:          os.Getenv("UPLOAD_BUCKET"),
		MaxInvalidRatio: envFloat("MAX_INVALID_RATIO", 0.2),
		MaxErrorRows:    int(envFloat("MAX_ERROR_ROWS", 10_000)),
		MaxDecompressed: int64(envFloat("MAX_DECOMPRESSED_BYTES", 2<<30)),
		Lease:           time.Duration(envFloat("INGEST_LEASE_SECONDS", 960)) * time.Second,
	}
}

func envFloat(name string, def float64) float64 {
	if v, err := strconv.ParseFloat(os.Getenv(name), 64); err == nil {
		return v
	}
	return def
}
