#!/usr/bin/env bash
# Puts finished builds on the update feed (#119), so every installed Styx updates itself in place.
# macOS: run after `pnpm package:mac` (release/latest-mac.yml). Windows and Linux: put the CI build's files in
# release/ (Actions › release › styx-win: the .exe, its .blockmap and latest.yml; styx-linux: the .AppImage, .deb and
# latest-linux.yml), then run this; it publishes whichever are there. Uploads go through the `gcloud` shim on PATH (Styx asks for a scoped grant and audits the call). The
# installers go up first and the feed file last, so a client never sees a version whose files are not there yet.
# Refuses to publish a version the feed already serves: bump apps/desktop/package.json.
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

upload() { gcloud storage cp "$@"; }

# publish <os folder> <feed file> <installer extension> <stable alias for the website's Download button>
publish() {
  local os=$1 yml=$2 ext=$3 alias=$4
  local feed="https://storage.googleapis.com/$BUCKET/$os/$yml"
  if ! grep -q "^version: $version$" "$rel/$yml"; then
    echo "release/$yml is not version $version: rebuild it."
    exit 1
  fi
  local live
  live=$(curl -fsS "$feed" 2>/dev/null | sed -n 's/^version: //p' || true)
  if [ "$live" = "$version" ]; then
    echo "The $os feed already serves $version. Bump \"version\" in apps/desktop/package.json, rebuild, then publish."
    exit 1
  fi
  local f
  # Line by line: installers before 0.4.7 had spaces in their names ("Styx Setup 0.4.2.exe").
  while IFS= read -r f; do
    upload "$rel/$f" "gs://$BUCKET/$os/$f"
    if [ -f "$rel/$f.blockmap" ]; then upload "$rel/$f.blockmap" "gs://$BUCKET/$os/$f.blockmap"; fi
  done < <(sed -n 's/^  - url: //p' "$rel/$yml")
  upload --cache-control="no-cache, max-age=0" "$rel/$yml" "gs://$BUCKET/$os/$yml"
  # One address that always holds the newest installer (no website redeploy per release).
  local installer
  installer=$(sed -n "s/^  - url: \(.*\.$ext\)$/\1/p" "$rel/$yml" | head -1)
  if [ -n "$installer" ]; then
    upload --cache-control="no-cache, max-age=0" "$rel/$installer" "gs://$BUCKET/$os/$alias"
  fi
  echo "Published $version for $os (was ${live:-nothing})."
}

published=0
if [ -f "$rel/latest-mac.yml" ]; then publish mac latest-mac.yml dmg Styx-latest-arm64.dmg; published=1; fi
if [ -f "$rel/latest.yml" ]; then publish win latest.yml exe Styx-latest-x64.exe; published=1; fi
# Linux: the AppImage is the updating build; the .deb is uploaded beside it under a stable name.
if [ -f "$rel/latest-linux.yml" ]; then
  publish linux latest-linux.yml AppImage Styx-latest-x86_64.AppImage
  deb=$(ls "$rel"/*.deb 2>/dev/null | head -1 || true)
  if [ -n "$deb" ]; then
    upload "$deb" "gs://$BUCKET/linux/$(basename "$deb")"
    upload --cache-control="no-cache, max-age=0" "$deb" "gs://$BUCKET/linux/Styx-latest-amd64.deb"
  fi
  published=1
fi
if [ "$published" = 0 ]; then
  echo "Nothing to publish: run pnpm package:mac, or put the Windows or Linux build from CI in release/."
  exit 1
fi
echo "Open copies show \"Update available\" within 30 minutes, when their window is next focused, or at launch."
