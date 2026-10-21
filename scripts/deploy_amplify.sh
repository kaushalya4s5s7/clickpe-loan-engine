#!/usr/bin/env bash
# Publish the console to AWS Amplify Hosting (HTTPS + short URL), no git connection needed.
#   bash scripts/deploy_amplify.sh [stage]     (run after scripts/deploy_web.sh has built apps/web/out)
# Idempotent: reuses the Amplify app/branch and uploads a new zip as a fresh deployment.
set -euo pipefail
cd "$(dirname "$0")/.."
export AWS_REGION=ap-south-1 AWS_PAGER=""
STAGE=${1:-dev}
APP_NAME="loan-engine-$STAGE"
BRANCH=main

[ -f apps/web/out/index.html ] || { echo "apps/web/out missing: run scripts/deploy_web.sh first"; exit 1; }

APP_ID=$(aws amplify list-apps --query "apps[?name=='$APP_NAME'].appId | [0]" --output text)
if [ -z "$APP_ID" ] || [ "$APP_ID" = "None" ]; then
  APP_ID=$(aws amplify create-app --name "$APP_NAME" --platform WEB --query app.appId --output text)
fi
aws amplify get-branch --app-id "$APP_ID" --branch-name "$BRANCH" >/dev/null 2>&1 \
  || aws amplify create-branch --app-id "$APP_ID" --branch-name "$BRANCH" --stage PRODUCTION >/dev/null

ZIP="build/console.zip"
mkdir -p build && rm -f "$ZIP"
(cd apps/web/out && zip -qr "../../../$ZIP" .)

read -r JOB_ID UPLOAD_URL < <(aws amplify create-deployment --app-id "$APP_ID" --branch-name "$BRANCH" \
  --query '[jobId, zipUploadUrl]' --output text)
curl -sf -X PUT -H "Content-Type: application/zip" --upload-file "$ZIP" "$UPLOAD_URL" >/dev/null
aws amplify start-deployment --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB_ID" >/dev/null

for _ in $(seq 1 60); do
  STATUS=$(aws amplify get-job --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB_ID" --query job.summary.status --output text)
  case "$STATUS" in SUCCEED) break ;; FAILED|CANCELLED) echo "Amplify deployment $STATUS"; exit 1 ;; esac
  sleep 5
done
DOMAIN=$(aws amplify get-app --app-id "$APP_ID" --query app.defaultDomain --output text)
echo "console: https://$BRANCH.$DOMAIN   (status: $STATUS)"
