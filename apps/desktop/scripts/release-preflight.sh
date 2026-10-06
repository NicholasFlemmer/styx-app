#!/usr/bin/env bash
# Release preflight for the signed + notarized macOS build (`pnpm package:mac`).
# Prints one line per requirement and exits non-zero when something a release needs is missing, together with
# the exact command that fixes it. Nothing here writes anything.
set -u
PROFILE="${APPLE_KEYCHAIN_PROFILE:-styx-notary}"
ok=0; missing=0
pass() { printf '  ok       %s\n' "$1"; ok=$((ok+1)); }
fail() { printf '  MISSING  %s\n' "$1"; missing=$((missing+1)); }
note() { printf '           %s\n' "$1"; }

echo "Styx release preflight (macOS)"
if [ "$(uname -s)" != "Darwin" ]; then
  fail "macOS host (this is $(uname -s)); package:mac must run on a Mac"
  exit 1
fi

# 1. Developer ID Application certificate (electron-builder picks it up automatically).
identity=$(security find-identity -v -p codesigning 2>/dev/null | grep 'Developer ID Application' | head -1)
if [ -n "${CSC_LINK:-}" ]; then
  # CI: the certificate comes from the CSC_LINK secret (base64 .p12) and electron-builder imports it at build time.
  # A Keychain export may use legacy ciphers, which OpenSSL 3 only reads with -legacy (LibreSSL reads them as is).
  p12=$(mktemp)
  printf '%s' "$CSC_LINK" | base64 --decode > "$p12" 2>/dev/null || true
  subject=$({ openssl pkcs12 -in "$p12" -nokeys -passin "pass:${CSC_KEY_PASSWORD:-}" 2>/dev/null \
    || openssl pkcs12 -in "$p12" -nokeys -legacy -passin "pass:${CSC_KEY_PASSWORD:-}" 2>/dev/null; } \
    | sed -n 's/^subject=.*CN *= *//p' | grep -m1 '^Developer ID Application' || true)
  rm -f "$p12"
  case "$subject" in
    "Developer ID Application"*)
      pass "signing certificate: ${subject%%,*} (CSC_LINK)"
      team=$(echo "$subject" | sed -nE 's/.*\(([A-Z0-9]{10})\).*/\1/p')
      ;;
    *)
      fail "CSC_LINK is not a readable Developer ID Application certificate (check CSC_LINK / CSC_KEY_PASSWORD)"
      team=""
      ;;
  esac
elif [ -n "$identity" ]; then
  pass "signing identity: $(echo "$identity" | sed -E 's/^ *[0-9]+\) [0-9A-F]+ //')"
  team=$(echo "$identity" | sed -nE 's/.*\(([A-Z0-9]{10})\).*/\1/p')
else
  fail "no 'Developer ID Application' certificate in the login keychain"
  note "Xcode › Settings › Accounts › Manage Certificates › + › Developer ID Application, or import the .p12"
  team=""
fi

# 2. notarytool
if xcrun notarytool --version >/dev/null 2>&1; then
  pass "xcrun notarytool $(xcrun notarytool --version 2>/dev/null | head -1)"
else
  fail "xcrun notarytool (install Xcode command line tools: xcode-select --install)"
fi

# 3. Notary credentials: CI API key env, or the keychain profile (this call reaches Apple; a few seconds).
if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
  if [ -f "$APPLE_API_KEY" ]; then pass "notary credentials: API key $APPLE_API_KEY_ID (env)"; else fail "APPLE_API_KEY points to a missing file: $APPLE_API_KEY"; fi
elif xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  pass "notary credentials: keychain profile '$PROFILE'"
else
  fail "notary credentials: keychain profile '$PROFILE' is missing or rejected by Apple"
  note "create it once (app-specific password from appleid.apple.com › Sign-In and Security › App-Specific Passwords):"
  note "  xcrun notarytool store-credentials $PROFILE --apple-id <apple id email> --team-id ${team:-<TEAM_ID>} --password <app-specific password>"
fi

# 4. Entitlements and the hook the build expects.
here=$(cd "$(dirname "$0")/.." && pwd)
for f in build/entitlements.mac.plist build/notarize.cjs build/icon.icns; do
  if [ -f "$here/$f" ]; then pass "$f"; else fail "$f (packaging input, must be in the repo)"; fi
done

# 5. The bundled CLI the shims and `styx mcp` exec (built by `pnpm run build` → build:cli).
if [ -f "$here/resources/cli/styx.js" ]; then pass "resources/cli/styx.js (bundled CLI)"; else note "resources/cli/styx.js not built yet; package:mac builds it"; fi

echo
if [ "$missing" -eq 0 ]; then
  echo "All $ok checks passed. Run: pnpm package:mac"
  exit 0
fi
echo "$missing missing, $ok ok. Fix the lines above, then run: pnpm release:preflight"
exit 1
