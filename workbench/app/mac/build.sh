#!/bin/bash
# Builds Workbench.app and Workbench-<version>-arm64.dmg for macOS 13.5 or later on Apple silicon, into workbench/dist/:
# the native window (WorkbenchApp.swift), its icon, Node with npm, and Workbench itself. Needs the Xcode command line
# tools (swiftc, iconutil, hdiutil, codesign). Without --sign the app is ad-hoc signed: on another Mac, macOS asks once
# before it opens it (System Settings → Privacy & Security → Open Anyway). With a Developer ID and --notarize, it opens
# like any app from the web.
#
#   workbench/app/mac/build.sh [--node <Node folder>] [--no-dmg] [--install] [--sign <identity>] [--notarize <profile>] [--hardened]
#
#   --node <folder>       use this Node (darwin-arm64: bin/node and lib/node_modules/npm) instead of downloading the
#                         pinned one from nodejs.org
#   --no-dmg              build the app only
#   --install             also put the app in /Applications (or ~/Applications when that is not writable); refused
#                         while that copy is open, and inside an agent
#   --sign <identity>     sign with this identity from the login keychain, e.g. "Developer ID Application: Name
#                         (TEAMID)", with the hardened runtime and a secure timestamp. Also WORKBENCH_SIGN_IDENTITY.
#   --notarize <profile>  send the app and the disk image to Apple's notary service and staple the tickets; <profile> is
#                         a notarytool keychain profile (xcrun notarytool store-credentials <profile> …). Needs --sign.
#                         Also WORKBENCH_NOTARY_PROFILE.
#   --hardened            sign ad-hoc but with the hardened runtime and the entitlements a Developer ID build uses: a
#                         check, on this Mac, that the app and its Node run as they will once signed
#
# The bundled Node is re-signed with node.entitlements when the app is signed with the hardened runtime: Node's own
# release signature asks for get-task-allow, which Apple's notary service refuses.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WB="$(cd "$HERE/../.." && pwd)"
DIST="$WB/dist"
BUILD="$DIST/build"
APP="$DIST/Workbench.app"
NODE_VERSION="v26.13.1"
NODE_DIR=""
DMG=1
INSTALL=0
SIGN_ID="${WORKBENCH_SIGN_IDENTITY:--}"
NOTARY="${WORKBENCH_NOTARY_PROFILE:-}"
HARDENED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --node) NODE_DIR="$2"; shift 2 ;;
    --no-dmg) DMG=0; shift ;;
    --install) INSTALL=1; shift ;;
    --sign) [ -n "${2:-}" ] || { echo "--sign needs an identity, like \"Developer ID Application: Name (TEAMID)\"." >&2; exit 2; }; SIGN_ID="$2"; shift 2 ;;
    --notarize) [ -n "${2:-}" ] || { echo "--notarize needs a notarytool keychain profile." >&2; exit 2; }; NOTARY="$2"; shift 2 ;;
    --hardened) HARDENED=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ "$(uname -s)" = "Darwin" ] || { echo "The Mac app is built on a Mac." >&2; exit 2; }
if [ -n "$NOTARY" ] && [ "$SIGN_ID" = "-" ]; then
  echo "Notarizing needs a Developer ID: give --sign \"Developer ID Application: Name (TEAMID)\" too." >&2; exit 2
fi
[ "$SIGN_ID" != "-" ] && HARDENED=1   # a real identity always signs with the hardened runtime
if [ "$INSTALL" = 1 ] && [ -n "${WORKBENCH_AGENT_ID+set}" ]; then
  echo "This is running inside an agent, so it will not replace the Workbench app in Applications: build without --install." >&2; exit 2
fi
if [ "$INSTALL" = 1 ]; then
  DEST="/Applications"
  [ -w "$DEST" ] || DEST="$HOME/Applications"
  if pgrep -f "$DEST/Workbench.app/Contents/MacOS/Workbench" >/dev/null 2>&1; then
    echo "Workbench is open. Quit it first (its agents stop), then install again." >&2; exit 2
  fi
fi
command -v swiftc >/dev/null || { echo "swiftc was not found: install the Xcode command line tools (xcode-select --install)." >&2; exit 2; }

VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$WB/package.json" | head -1)"
VERSION="${VERSION:-0.0.0}"
rm -rf "$BUILD" "$APP"
mkdir -p "$BUILD" "$DIST"

# --- Node: a given folder, or the pinned release from nodejs.org, checked against its published SHA-256
if [ -z "$NODE_DIR" ]; then
  CACHE="$HOME/Library/Caches/workbench-build"
  mkdir -p "$CACHE"
  NODE_DIR="$CACHE/node-$NODE_VERSION-darwin-arm64"
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    TGZ="node-$NODE_VERSION-darwin-arm64.tar.gz"
    echo "Downloading Node ${NODE_VERSION}…"
    curl -fsSL -o "$CACHE/$TGZ" "https://nodejs.org/dist/$NODE_VERSION/$TGZ"
    curl -fsSL -o "$CACHE/SHASUMS256-$NODE_VERSION.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
    WANT="$(grep " $TGZ\$" "$CACHE/SHASUMS256-$NODE_VERSION.txt" | awk '{print $1}')"
    HAVE="$(shasum -a 256 "$CACHE/$TGZ" | awk '{print $1}')"
    [ -n "$WANT" ] && [ "$WANT" = "$HAVE" ] || { echo "Node's download does not match its published checksum." >&2; exit 1; }
    tar -xzf "$CACHE/$TGZ" -C "$CACHE"
  fi
fi
[ -x "$NODE_DIR/bin/node" ] || { echo "No node program in $NODE_DIR/bin." >&2; exit 2; }
NODE_REAL="$(cd "$NODE_DIR/bin" && pwd)/node"
file "$NODE_REAL" | grep -q arm64 || { echo "$NODE_REAL is not built for Apple silicon (arm64)." >&2; exit 2; }
NPM_DIR="$(cd "$NODE_DIR" && pwd)/lib/node_modules/npm"
[ -f "$NPM_DIR/bin/npm-cli.js" ] || { echo "No npm in $NODE_DIR/lib/node_modules: give --node the whole Node folder, as nodejs.org ships it." >&2; exit 2; }

# --- the native window and the icon
echo "Compiling the app…"
swiftc -O -swift-version 5 -target arm64-apple-macos13.5 -framework AppKit -framework WebKit \
  "$HERE/WorkbenchApp.swift" -o "$BUILD/Workbench"
swiftc -O -swift-version 5 -target arm64-apple-macos13.5 -framework AppKit "$HERE/MakeIcon.swift" -o "$BUILD/make-icon"
"$BUILD/make-icon" "$BUILD/AppIcon.iconset"
iconutil -c icns "$BUILD/AppIcon.iconset" -o "$BUILD/AppIcon.icns"

# --- the bundle: Contents/MacOS/Workbench, Contents/Resources/{node/bin/{node,npm,npx}, node/lib/node_modules/npm,
# workbench/…, AppIcon.icns}. npm is there because Workbench puts node's folder on the PATH of agents and checks that
# have no node of their own, and they run `npm test`.
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/node/bin" "$APP/Contents/Resources/node/lib/node_modules" "$APP/Contents/Resources/workbench"
cp "$BUILD/Workbench" "$APP/Contents/MacOS/Workbench"
cp "$NODE_REAL" "$APP/Contents/Resources/node/bin/node"
cp -R "$NPM_DIR" "$APP/Contents/Resources/node/lib/node_modules/"
ln -s ../lib/node_modules/npm/bin/npm-cli.js "$APP/Contents/Resources/node/bin/npm"
ln -s ../lib/node_modules/npm/bin/npx-cli.js "$APP/Contents/Resources/node/bin/npx"
cp "$BUILD/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
for item in bin src ui package.json README.md ARCHITECTURE.md; do cp -R "$WB/$item" "$APP/Contents/Resources/workbench/"; done
# Licenses: Workbench's own, Node's (with the libraries it bundles), and a list of the rest (npm's and the typeface's
# own files travel inside their folders).
cp "$WB/../LICENSE" "$APP/Contents/Resources/LICENSE"
cp "$HERE/THIRD_PARTY_NOTICES.md" "$APP/Contents/Resources/THIRD_PARTY_NOTICES.md"
[ -f "$NODE_DIR/LICENSE" ] || { echo "No LICENSE in $NODE_DIR: give --node the whole Node folder, as nodejs.org ships it." >&2; exit 2; }
cp "$NODE_DIR/LICENSE" "$APP/Contents/Resources/node/LICENSE"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Workbench</string>
  <key>CFBundleDisplayName</key><string>Workbench</string>
  <key>CFBundleIdentifier</key><string>ai.coasty.workbench</string>
  <key>CFBundleExecutable</key><string>Workbench</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.5</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHumanReadableCopyright</key><string>© 2026 Coasty. MIT License.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSMicrophoneUsageDescription</key><string>Hold the space bar to talk to Workbench instead of typing.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>What you say while holding the space bar becomes words for Workbench.</string>
  <key>CFBundleDocumentTypes</key>
  <array><dict>
    <key>CFBundleTypeName</key><string>Folder</string>
    <key>CFBundleTypeRole</key><string>Viewer</string>
    <key>LSItemContentTypes</key><array><string>public.folder</string></array>
    <key>LSHandlerRank</key><string>Alternate</string>
  </dict></array>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist" >/dev/null

# --- signature. Plain: ad-hoc, and Node keeps its own release signature (Apple silicon runs only signed code). With the
# hardened runtime (--hardened, or any --sign identity): inside out, Node with node.entitlements, then the app with
# Workbench.entitlements; a real identity gets a secure timestamp, which notarizing needs.
if [ "$HARDENED" = 0 ]; then
  codesign --force --sign - --timestamp=none "$APP/Contents/MacOS/Workbench"
  codesign --force --sign - --timestamp=none "$APP"
else
  STAMP=--timestamp
  [ "$SIGN_ID" = "-" ] && STAMP=--timestamp=none
  codesign --force --sign "$SIGN_ID" "$STAMP" --options runtime --entitlements "$HERE/node.entitlements" "$APP/Contents/Resources/node/bin/node"
  codesign --force --sign "$SIGN_ID" "$STAMP" --options runtime --entitlements "$HERE/Workbench.entitlements" "$APP/Contents/MacOS/Workbench"
  codesign --force --sign "$SIGN_ID" "$STAMP" --options runtime --entitlements "$HERE/Workbench.entitlements" "$APP"
fi
codesign --verify --strict --deep "$APP"
echo "Built $APP ($(du -sh "$APP" | cut -f1))$([ "$HARDENED" = 1 ] && echo ", hardened runtime, signed as ${SIGN_ID/#-/ad-hoc}")"

# --- notarization of the app, so a copy dragged out of the disk image opens offline too
if [ -n "$NOTARY" ]; then
  echo "Sending the app to Apple's notary service (this takes a few minutes)…"
  ditto -c -k --keepParent "$APP" "$BUILD/Workbench.zip"
  xcrun notarytool submit "$BUILD/Workbench.zip" --keychain-profile "$NOTARY" --wait
  xcrun stapler staple "$APP"
fi

# --- the disk image: the app and a link to Applications, to drag it into
if [ "$DMG" = 1 ]; then
  STAGE="$BUILD/dmg"
  rm -rf "$STAGE"; mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  OUT="$DIST/Workbench-$VERSION-arm64.dmg"
  rm -f "$OUT"
  hdiutil create -quiet -volname "Workbench" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
  if [ "$SIGN_ID" != "-" ]; then codesign --force --sign "$SIGN_ID" --timestamp "$OUT"; fi
  if [ -n "$NOTARY" ]; then
    echo "Sending the disk image to Apple's notary service…"
    xcrun notarytool submit "$OUT" --keychain-profile "$NOTARY" --wait
    xcrun stapler staple "$OUT"
  fi
  # The checksum people can compare a download with: shasum -a 256 -c Workbench-<version>-arm64.dmg.sha256
  (cd "$DIST" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256")
  echo "Built $OUT ($(du -sh "$OUT" | cut -f1)) and its SHA-256 checksum"
fi

if [ "$INSTALL" = 1 ]; then
  mkdir -p "$DEST"
  rm -rf "$DEST/Workbench.app"
  cp -R "$APP" "$DEST/"
  echo "Installed $DEST/Workbench.app"
fi
rm -rf "$BUILD"
