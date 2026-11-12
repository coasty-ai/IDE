#!/bin/bash
# Builds Workbench.app and Workbench-<version>-arm64.dmg for macOS 13.5 or later on Apple silicon, into workbench/dist/:
# the native window (WorkbenchApp.swift), its icon, Node with npm, and Workbench itself. Needs the Xcode command line
# tools (swiftc, iconutil, hdiutil, codesign). The app is ad-hoc signed: on another Mac, macOS asks once before it
# opens it (System Settings → Privacy & Security → Open Anyway).
#
#   workbench/app/mac/build.sh [--node <Node folder: bin/node and lib/node_modules/npm>] [--no-dmg] [--install]
#
#   --node <folder>  use this Node (darwin-arm64) instead of downloading the pinned one from nodejs.org
#   --no-dmg         build the app only
#   --install        also put the app in /Applications (or ~/Applications when that is not writable); refused while
#                    that copy is open, and inside an agent
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
while [ $# -gt 0 ]; do
  case "$1" in
    --node) NODE_DIR="$2"; shift 2 ;;
    --no-dmg) DMG=0; shift ;;
    --install) INSTALL=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ "$(uname -s)" = "Darwin" ] || { echo "The Mac app is built on a Mac." >&2; exit 2; }
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
  <key>NSHumanReadableCopyright</key><string>Workbench</string>
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

# --- ad-hoc signature (Apple silicon runs only signed code; Node keeps its own signature inside)
codesign --force --sign - --timestamp=none "$APP/Contents/MacOS/Workbench"
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --strict "$APP"
echo "Built $APP ($(du -sh "$APP" | cut -f1))"

# --- the disk image: the app and a link to Applications, to drag it into
if [ "$DMG" = 1 ]; then
  STAGE="$BUILD/dmg"
  rm -rf "$STAGE"; mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  OUT="$DIST/Workbench-$VERSION-arm64.dmg"
  rm -f "$OUT"
  hdiutil create -quiet -volname "Workbench" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
  echo "Built $OUT ($(du -sh "$OUT" | cut -f1))"
fi

if [ "$INSTALL" = 1 ]; then
  mkdir -p "$DEST"
  rm -rf "$DEST/Workbench.app"
  cp -R "$APP" "$DEST/"
  echo "Installed $DEST/Workbench.app"
fi
rm -rf "$BUILD"
