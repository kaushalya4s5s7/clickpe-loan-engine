#!/bin/sh
# n8n container entrypoint: wire credentials + workflows from env, then start n8n.
# Idempotent: re-running re-imports the same ids (credentials are re-encrypted with N8N_ENCRYPTION_KEY).
set -eu

CREDS=/tmp/loan-engine-credentials.json
node /init/make_credentials.js > "$CREDS"
n8n import:credentials --input="$CREDS"
rm -f "$CREDS"                                   # plaintext never stays on disk

n8n import:workflow --separate --input=/workflows
for id in loanEngineErrorE loanEngineConfmD loanEngineNotifC loanEngineMatchB loanEngineCrawlA; do
  # n8n 2.x publishes workflows; older CLIs activate them.
  n8n publish:workflow --id="$id" 2>/dev/null || n8n update:workflow --id="$id" --active=true
done

exec n8n start
