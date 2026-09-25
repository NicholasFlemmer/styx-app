#!/usr/bin/env bash
# Build heystyx.com and deploy it to Cloud Run. Usage: apps/website/deploy/deploy.sh
set -euo pipefail
PROJECT=styx-api-20260922
REGION=us-central1
SERVICE=styx-web
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

cd "$ROOT"
# The legal pages quote lib/legal.ts; publishing them with placeholders in would be worse than not publishing.
if grep -qE "'\[[A-Z ]+\]'" "$ROOT/apps/website/lib/legal.ts"; then
  echo "lib/legal.ts still has [PLACEHOLDERS] (entity, address, email or courts). Fill them in before deploying." >&2
  exit 1
fi
NEXT_PUBLIC_SITE_URL=https://heystyx.com NEXT_PUBLIC_GTM_ID="${GTM_ID:?set GTM_ID, e.g. GTM_ID=GTM-XXXXXXX apps/website/deploy/deploy.sh}" pnpm -F @styx/website build

STAGE="$(mktemp -d)"
trap 'rm -r "$STAGE"' EXIT
cp "$HERE/Dockerfile" "$HERE/nginx.conf" "$HERE/security-headers.conf" "$STAGE/"
cp -R "$ROOT/apps/website/out" "$STAGE/out"

gcloud run deploy "$SERVICE" \
  --project "$PROJECT" --region "$REGION" \
  --source "$STAGE" \
  --port 8080 --allow-unauthenticated \
  --cpu 1 --memory 256Mi --min-instances 0 --max-instances 5 --concurrency 200 \
  --quiet
