#!/usr/bin/env bash
# Sign the desktop app with the local "Jarvis Local Signing" identity.
#
# Ad-hoc builds get a new code fingerprint on every build, and macOS ties
# Accessibility / Screen Recording / Automation grants to that fingerprint,
# so every rebuild silently lost the permissions. Signing with one stable
# (self-signed, local-only) certificate keeps the designated requirement
# "identifier com.openjarvis.desktop + this certificate" the same forever.
#
# Usage: scripts/desktop/sign-local.sh [/Applications/Jarvis.app]
set -euo pipefail
APP="${1:-/Applications/Jarvis.app}"
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
ENTITLEMENTS="$HERE/frontend/src-tauri/Entitlements.plist"
IDENTITY="${JARVIS_SIGNING_IDENTITY:-Jarvis Local Signing}"

if ! security find-certificate -c "$IDENTITY" >/dev/null 2>&1; then
  echo "No '$IDENTITY' certificate in your keychain; leaving the app ad-hoc signed." >&2
  exit 1
fi
HASH="$(security find-certificate -c "$IDENTITY" -Z | awk '/SHA-1/{print $3; exit}')"
codesign --force --deep --options runtime --entitlements "$ENTITLEMENTS" --sign "$HASH" "$APP"
codesign --verify --deep --strict "$APP"
codesign -d -r- "$APP" 2>&1 | tail -1
