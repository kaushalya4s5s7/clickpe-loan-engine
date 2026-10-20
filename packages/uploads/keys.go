package uploads

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Keys struct {
	Bucket         string
	MaxUploadBytes int64         // hard cap per file; enforced at session start AND at completion
	PartSize       int64         // 8 MiB: 1 GB = 128 parts; a retried part on 4G costs seconds, not minutes
	URLTTL         time.Duration // part URLs are requested lazily, so they never go stale
	Region         string
}

func LoadKeys() (Keys, error) {
	k := Keys{Bucket: strings.TrimSpace(os.Getenv("UPLOAD_BUCKET")), MaxUploadBytes: envInt("MAX_UPLOAD_BYTES", 200*MiB),
		PartSize: envInt("PART_SIZE_BYTES", 8*MiB), URLTTL: time.Duration(envInt("PART_URL_TTL_SECONDS", 3600)) * time.Second,
		Region: firstNonEmpty(os.Getenv("AWS_REGION"), os.Getenv("AWS_DEFAULT_REGION"), "ap-south-1")}
	switch {
	case k.Bucket == "":
		return k, fmt.Errorf("UPLOAD_BUCKET is not set")
	case k.PartSize < 5*MiB:
		return k, fmt.Errorf("PART_SIZE_BYTES must be >= 5 MiB (S3 minimum for non-final parts)")
	}
	return k, nil
}

func envInt(name string, def int64) int64 {
	if v, err := strconv.ParseInt(os.Getenv(name), 10, 64); err == nil {
		return v
	}
	return def
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v != "" {
			return v
		}
	}
	return ""
}
