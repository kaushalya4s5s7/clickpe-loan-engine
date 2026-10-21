#!/usr/bin/env bash
# One-shot AWS deploy (README §2b, automated). Run from the repo root after `aws login`:
#   bash scripts/deploy_all.sh
# Idempotent: re-running updates the stack in place. Tear down: npx serverless@3 remove
# Never prints secrets. n8n stays self-hosted in Docker; AWS reaches it through a Cloudflare tunnel.
set -euo pipefail
cd "$(dirname "$0")/.."
export AWS_REGION=ap-south-1 AWS_PAGER=""
STACK=loan-engine-dev

envset() {  # envset KEY VALUE → replace KEY=... in .env (or append)
  python3 - "$1" "$2" <<'EOF'
import re, sys
k, v = sys.argv[1], sys.argv[2]
s = open(".env").read()
s, n = re.subn(rf"(?m)^{k}=.*$", lambda m: f"{k}={v}", s)
open(".env", "w").write(s if n else s.rstrip("\n") + f"\n{k}={v}\n")
EOF
}
envget() { grep "^$1=" .env | head -1 | cut -d= -f2- | awk '{print $1}'; }

echo "1/7 secrets → SSM Parameter Store (encrypted)"
if ! aws ssm get-parameter --name /loan-engine/db-password >/dev/null 2>&1; then
  aws ssm put-parameter --name /loan-engine/db-password --type SecureString --value "$(openssl rand -hex 24)" >/dev/null
fi
aws ssm put-parameter --name /loan-engine/webhook-secret --type SecureString --overwrite --value "$(envget N8N_WEBHOOK_SECRET)" >/dev/null
aws ssm put-parameter --name /loan-engine/unsubscribe-secret --type SecureString --overwrite --value "$(envget UNSUBSCRIBE_SECRET)" >/dev/null

echo "2/7 public HTTPS tunnel to n8n (Cloudflare quick tunnel; URL changes if the tunnel restarts)"
docker compose --profile tunnel up -d cloudflared >/dev/null
TUNNEL=""
for _ in $(seq 1 30); do
  TUNNEL=$(docker compose logs cloudflared 2>&1 | grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" | tail -1 || true)
  [ -n "$TUNNEL" ] && break; sleep 2
done
[ -n "$TUNNEL" ] || { echo "tunnel URL not found: docker compose logs cloudflared"; exit 1; }
envset N8N_WEBHOOK_URL "$TUNNEL/webhook/batch-loaded"
envset N8N_PUBLIC_URL "$TUNNEL/"
echo "    $TUNNEL"

echo "3/7 Go Lambdas (linux/arm64)"
bash scripts/build_lambdas.sh

echo "4/7 serverless deploy (API Gateway, Lambdas, S3, SQS, RDS, console hosting; first run ~10-15 min)"
# serverless v3 can't read `aws login` sessions (nor credential_process profiles), so hand it a fresh
# export (~10-15 min). The FIRST deploy creates RDS and can outlive that: CloudFormation keeps going
# server-side — wait for UPDATE_COMPLETE in the console and re-run this script (later runs take ~1 min).
aws sts get-caller-identity >/dev/null      # forces a credential refresh before exporting
eval "$(aws configure export-credentials --format env)"
# CDN=true once AWS has verified the account for CloudFront; until then the console is a public S3 website.
npx --yes serverless@3 deploy --region ap-south-1 --param="cdn=${CDN:-false}"

out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
API_URL=$(out ServiceEndpoint); DB_HOST=$(out DatabaseHost)
DB_PASS=$(aws ssm get-parameter --name /loan-engine/db-password --with-decryption --query Parameter.Value --output text)
RDS_URL="postgresql://loanadmin:${DB_PASS}@${DB_HOST}:5432/loan_engine?sslmode=require"

echo "5/7 database schema on RDS"
DATABASE_URL="$RDS_URL" go run ./apps/migrate

echo "6/7 n8n → RDS, unsubscribe → API; reload n8n; crawl products into RDS"
envset APP_DATABASE_URL "$RDS_URL"
envset UNSUBSCRIBE_BASE_URL "$API_URL/v1/unsubscribe"
docker compose up -d --force-recreate n8n >/dev/null
for _ in $(seq 1 40); do curl -sf localhost:5678/healthz >/dev/null && break; sleep 3; done; sleep 8
docker compose exec -T -e N8N_RUNNERS_BROKER_PORT=5690 -e N8N_PORT=5699 n8n \
  n8n execute --id=loanEngineCrawlA >/dev/null 2>&1 && echo "    crawler finished" || echo "    crawler run failed — run 'A · Discover loan products' from the n8n UI"

echo "7/7 console → S3 (+ CloudFront when CDN=true) → AWS Amplify Hosting (HTTPS, short URL)"
bash scripts/deploy_web.sh
CONSOLE=$(bash scripts/deploy_amplify.sh | grep -oE "https://[^ ]+")

API_KEY=$(aws apigateway get-api-keys --name-query "loan-engine-dev-ops" --include-values --query 'items[0].value' --output text)
echo
echo "DONE"
echo "  Console : $CONSOLE/upload/   (also $(out WebUrl))"
echo "  API     : $API_URL"
echo "  API key : saved to build/api-key.txt (paste it once in the console → Connect)"
echo "$API_KEY" > build/api-key.txt
echo "  n8n     : http://localhost:5678  (public via $TUNNEL — keep this Mac + Docker running)"
