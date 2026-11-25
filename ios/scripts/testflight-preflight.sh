#!/bin/zsh
# TestFlight preflight (M3, D-051): archive the Release build locally and check it. Never exports or uploads.
# Usage: ios/scripts/testflight-preflight.sh [build-number]
#   VALIDATE_URL=https://example.invalid ios/scripts/testflight-preflight.sh  -> validation-only archive (separate path,
#   NEVER to be uploaded) to check the Release settings before the real tunnel URL exists.
# Exit 0 = archive ready for an owner-approved upload; non-zero = a listed check failed.
set -u
cd "${0:A:h}/.."
BUILD_NUMBER=${1:-}
OUT=build/testflight
[[ -n ${VALIDATE_URL:-} ]] && OUT=build/testflight-validation-DO-NOT-UPLOAD
ARCHIVE=$OUT/MonetaLab.xcarchive
mkdir -p $OUT
fail=0
check() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }

args=(-project MonetaLab.xcodeproj -scheme MonetaLab -configuration Release -destination 'generic/platform=iOS' -archivePath $ARCHIVE)
[[ -n $BUILD_NUMBER ]] && args+=(CURRENT_PROJECT_VERSION=$BUILD_NUMBER)
[[ -n ${VALIDATE_URL:-} ]] && args+=("MONETALAB_API_BASE_URL=$VALIDATE_URL")
echo "Archiving Release (local only; no export, no upload)..."
if ! xcodebuild archive "${args[@]}" > $OUT/archive.log 2>&1; then
  echo "FAIL  archive (see ios/$OUT/archive.log)"; grep -E "error:" $OUT/archive.log | head -5; exit 1
fi
APP=$ARCHIVE/Products/Applications/MonetaLab.app
PLIST=$APP/Info.plist
get() { /usr/libexec/PlistBuddy -c "Print :$1" $PLIST 2>/dev/null; }
URL=$(get MonetaLabAPIBaseURL)

check "bundle id is dev.monetalab.qa.MonetaLab"                 '[[ "$(get CFBundleIdentifier)" == dev.monetalab.qa.MonetaLab ]]'
check "version $(get CFBundleShortVersionString) build $(get CFBundleVersion)" '[[ -n "$(get CFBundleVersion)" ]]'
check "API base URL is HTTPS and not local ($URL)"              '[[ "$URL" == https://* && "$URL" != *127.0.0.1* && "$URL" != *localhost* && "$URL" != *.local* ]]'
check "app icon compiled (CFBundleIcons)"                       '/usr/libexec/PlistBuddy -c "Print :CFBundleIcons:CFBundlePrimaryIcon" $PLIST >/dev/null 2>&1'
check "no arbitrary-loads ATS exception"                        '! /usr/libexec/PlistBuddy -c "Print :NSAppTransportSecurity:NSAllowsArbitraryLoads" $PLIST >/dev/null 2>&1'
check "Debug-only StoreKit probe/diagnostics absent"            '! strings $APP/MonetaLab | grep -qE "STOREKIT_PROBE|MonetaLabStoreKitProbe|StoreKit diagnostics"'
check "no StoreKit configuration file bundled"                  '[[ -z "$(find $APP -name "*.storekit")" ]]'
TEAM=$(codesign -dv $APP 2>&1 | sed -n 's/^TeamIdentifier=//p')
check "signed for team K77523YT8C ($TEAM)"                      '[[ "$TEAM" == K77523YT8C ]]'
if security find-identity -v -p codesigning | grep -q "Apple Distribution"; then
  echo "PASS  Apple Distribution identity present (needed to export for App Store Connect)"
else
  echo "NOTE  no Apple Distribution identity: Xcode Organizer > Distribute App can create it (owner approval)"
fi
echo "Archive: ios/$ARCHIVE"
exit $fail
