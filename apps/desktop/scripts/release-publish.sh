#!/usr/bin/env bash
# Puts a finished macOS build on the update feed (#119), so every installed Styx updates itself in place.
# Run after `pnpm package:mac`. Uploads go through the `gcloud` shim on PATH (Styx asks for a scoped grant and
# audits the call). The installers go up first and `latest-mac.yml` last, so a client never sees a version whose
# files are not there yet. Refuses to publish a version the feed already serves: bump apps/desktop/package.json.
#
# One-time feed setup (a public-read bucket in the accounts API project):
#   gcloud storage buckets create gs://styx-desktop-releases --project=styx-api-20260922 \
#     --location=us-central1 --uniform-bucket-level-access
#   gcloud storage buckets add-iam-policy-binding gs://styx-desktop-releases \
#     --member=allUsers --role=roles/storage.objectViewer
set -euo pipefail
BUCKET="${STYX_RELEASE_BUCKET:-styx-desktop-releases}"
here=$(cd "$(dirname "$0")/.." && pwd)
rel="$here/release"
version=$(node -p "require('$here/package.json').version")
feed="https://storage.googleapis.com/$BUCKET/mac/latest-mac.yml"

if [ ! -f "$rel/latest-mac.yml" ]; then
  echo "No release/latest-mac.yml: run pnpm package:mac first."
  exit 1
fi
if ! grep -q "^version: $version$" "$rel/latest-mac.yml"; then
  echo "release/latest-mac.yml is not version $version: rebuild with pnpm package:mac."
  exit 1
fi
live=$(curl -fsS "$feed" 2>/dev/null | sed -n 's/^version: //p' || true)
if [ "$live" = "$version" ]; then
  echo "The feed already serves $version. Bump \"version\" in apps/desktop/package.json, rebuild, then publish."
  exit 1
fi

upload() { gcloud storage cp "$@"; }
for f in $(sed -n 's/^  - url: //p' "$rel/latest-mac.yml"); do
  upload "$rel/$f" "gs://$BUCKET/mac/$f"
  if [ -f "$rel/$f.blockmap" ]; then upload "$rel/$f.blockmap" "gs://$BUCKET/mac/$f.blockmap"; fi
done
upload --cache-control="no-cache, max-age=0" "$rel/latest-mac.yml" "gs://$BUCKET/mac/latest-mac.yml"
echo "Published $version (was ${live:-nothing}). Open copies show "Update available" within 30 minutes, when their window is next focused, or at launch."
