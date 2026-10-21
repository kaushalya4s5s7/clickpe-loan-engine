#!/usr/bin/env bash
# Compile the Go Lambdas: static linux/arm64 binaries named "bootstrap" (provided.al2023 runtime).
set -euo pipefail
cd "$(dirname "$0")/.."
for app in api ingest_worker; do
  name=${app%_worker}                         # api, ingest
  out="build/lambda/$name"
  rm -rf "$out" && mkdir -p "$out"
  # lambda.norpc: drop the legacy RPC shim (smaller binary, faster cold start); -s -w: no debug symbols
  GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -tags lambda.norpc -trimpath -ldflags="-s -w" -o "$out/bootstrap" "./apps/$app"
  (cd "$out" && zip -q -9 "../$name.zip" bootstrap)
  echo "$name: $(du -h "build/lambda/$name.zip" | cut -f1)"
done
