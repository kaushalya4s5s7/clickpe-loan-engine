#!/usr/bin/env bash
# Build the Next.js console against the deployed API and publish it to S3 + CloudFront.
#   bash scripts/deploy_web.sh [stage]        (run after `npx serverless@3 deploy`)
set -euo pipefail
cd "$(dirname "$0")/.."
STAGE=${1:-dev}
STACK="loan-engine-$STAGE"
out() { aws cloudformation describe-stacks --stack-name "$STACK" --region ap-south-1 \
          --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
API_URL=$(out ServiceEndpoint)
BUCKET=$(out WebBucketName)
DIST=$(out WebDistributionId)

(cd apps/web && npm ci --no-audit --no-fund && NEXT_PUBLIC_API_URL="$API_URL" NEXT_TELEMETRY_DISABLED=1 npm run build)

# Hashed assets never change → cache for a year. HTML must always revalidate so a deploy is seen at once.
aws s3 sync apps/web/out/_next "s3://$BUCKET/_next" --delete --cache-control "public,max-age=31536000,immutable"
aws s3 sync apps/web/out "s3://$BUCKET" --delete --exclude "_next/*" --cache-control "public,max-age=0,must-revalidate"
if [ -n "$DIST" ] && [ "$DIST" != "None" ]; then   # no-CDN deploy (S3 website) has no distribution
  aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" >/dev/null
fi
echo "console: $(out WebUrl)   (API: $API_URL)"
