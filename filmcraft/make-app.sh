#!/bin/zsh
# Makes ~/Applications/FilmCraft + Kilnframe.app: a double-clickable wrapper around launch.sh in this checkout.
set -eu
ROOT="${0:A:h:h}"
APP="$HOME/Applications/FilmCraft + Kilnframe.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/MacOS/launcher" <<SH
#!/bin/zsh
exec "$ROOT/filmcraft/launch.sh"
SH
chmod +x "$APP/Contents/MacOS/launcher"
cp /Applications/FilmCraft.app/Contents/Resources/FilmCraft.icns "$APP/Contents/Resources/app.icns"
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>FilmCraft + Kilnframe</string>
  <key>CFBundleDisplayName</key><string>FilmCraft + Kilnframe</string>
  <key>CFBundleIdentifier</key><string>local.kilnframe.filmcraft-launcher</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>app</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PL
codesign --force -s - "$APP" 2>/dev/null || true
echo "$APP"
