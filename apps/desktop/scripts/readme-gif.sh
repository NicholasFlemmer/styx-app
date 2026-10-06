#!/usr/bin/env bash
# Records the README media (e2e/readme/): the hero video, turned into .github/assets/readme-hero.gif (needs
# ffmpeg), and the still screenshots.
# Run after `pnpm -F @styx/desktop build`.
set -euo pipefail
cd "$(dirname "$0")/.."
assets=../../.github/assets
rm -rf "$assets/readme-video"
npx playwright test -c e2e/playwright.config.ts --project=readme --reporter=line
video=$(ls -t "$assets"/readme-video/*.webm | head -1)
palette=$(mktemp -t styx-palette).png
filters="fps=15,scale=960:-1:flags=lanczos"
ffmpeg -v error -y -i "$video" -vf "$filters,palettegen=max_colors=128:stats_mode=diff" "$palette"
ffmpeg -v error -y -i "$video" -i "$palette" -lavfi "$filters [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" "$assets/readme-hero.gif"
rm -rf "$assets/readme-video" "$palette"
ls -la "$assets/readme-hero.gif"
