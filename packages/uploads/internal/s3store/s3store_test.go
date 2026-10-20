package s3store

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// The real SDK signer, offline: proves the URL is regional and the SHA-256 header is SIGNED.
// (S3 then refuses any part whose bytes don't match — verified against real S3 by scripts/smoke_aws.py.)
func TestPresignedPartSignsChecksumOnRegionalEndpoint(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret")
	store, err := New(context.Background(), "ap-south-1", func(o *s3.Options) {
		o.Credentials = aws.NewCredentialsCache(credentials.NewStaticCredentialsProvider("AKIDEXAMPLE", "secret", ""))
	})
	if err != nil {
		t.Fatal(err)
	}
	sum := "LCa0a2j/xo/5m0U8HTBBNBNCLXBkg7+g+YpeiGJm564=" // sha256("foo")
	url, headers, err := store.PresignPart(context.Background(), "bkt", "uploads/x/f.csv", "up-1", 1, sum, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(url, "https://bkt.s3.ap-south-1.amazonaws.com/") {
		t.Fatalf("not regional/virtual-hosted: %s", url)
	}
	if !strings.Contains(strings.ToLower(url), "x-amz-signedheaders=host%3bx-amz-checksum-sha256") {
		t.Fatalf("checksum header not signed: %s", url)
	}
	found := false
	for k, v := range headers {
		found = found || (strings.EqualFold(k, "x-amz-checksum-sha256") && v == sum)
	}
	if !found {
		t.Fatalf("client must be told to send the checksum header: %v", headers)
	}
}
