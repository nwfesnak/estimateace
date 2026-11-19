#!/usr/bin/env bash
# One-time (and safe to re-run) setup of the EstimateAce iOS + Android projects on the Mac mini.
# Usage:  npm run mobile:setup        (from the repo root)
# Full walkthrough: docs/MOBILE_RELEASE.md
set -euo pipefail
cd "$(dirname "$0")/.."

ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✘\033[0m %s\n' "$1"; MISSING=1; }
MISSING=0

echo "Checking tools…"
if [[ "$(uname)" != "Darwin" ]]; then warn "Not a Mac — iOS steps will be skipped (Android still works)."; fi
command -v node >/dev/null && ok "Node $(node -v)" || fail "Node.js 22+ (https://nodejs.org or: brew install node)"
if command -v node >/dev/null; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  (( major >= 22 )) || fail "Node $major is too old — Capacitor 8 needs Node 22 or newer"
fi
if [[ "$(uname)" == "Darwin" ]]; then
  if xcodebuild -version >/dev/null 2>&1; then ok "$(xcodebuild -version | head -1)"; else fail "Xcode (App Store) + run: sudo xcode-select -s /Applications/Xcode.app"; fi
  # Capacitor 8 uses Swift Package Manager for iOS — CocoaPods is NOT required.
  command -v pod >/dev/null && ok "CocoaPods $(pod --version) (optional)" || ok "CocoaPods not installed (not needed: this project uses Swift Package Manager)"
fi
if [[ -d "${ANDROID_HOME:-$HOME/Library/Android/sdk}" ]]; then ok "Android SDK at ${ANDROID_HOME:-$HOME/Library/Android/sdk}"; else warn "Android Studio / SDK not found yet (needed only for the Google Play build)"; fi
if command -v java >/dev/null; then ok "Java: $(java -version 2>&1 | head -1)"; else warn "Java not on PATH — Android Studio bundles its own JDK, that's fine"; fi
(( MISSING == 0 )) || { echo; echo "Install the missing tools above, then run this again."; exit 1; }

echo; echo "Installing npm packages…"
npm ci

echo; echo "Creating native projects if missing…"
[[ -d ios ]] || npx cap add ios
[[ -d android ]] || npx cap add android

echo; echo "Syncing Capacitor config + plugins into ios/ and android/…"
npx cap sync

echo; echo "Done. Next:"
echo "  • iOS:     npm run mobile:ios      (opens Xcode → set Team → Product › Archive)"
echo "  • Android: npm run mobile:android  (opens Android Studio → Build › Generate Signed App Bundle)"
echo "  • Icons/splash changed? python3 scripts/mobile-make-source-art.py && npm run mobile:assets"
