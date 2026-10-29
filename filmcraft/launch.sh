#!/bin/zsh
# FilmCraft + Kilnframe: starts the Kilnframe app (the companion that makes the animations), FilmCraft with its
# control channel open, and the Kilnframe panel window that drives FilmCraft through that channel.
# The control token is new for every start; it reaches the panel only through ~/.kilnframe/filmcraft.json (0600)
# and FilmCraft only through its environment, never a command line.
set -u
ROOT="${0:A:h:h}"
PORT="${KILNFRAME_FILMCRAFT_PORT:-47720}"
FILMCRAFT="/Applications/FilmCraft.app/Contents/MacOS/FilmCraft"
ELECTRON="$ROOT/packages/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
PANEL="$ROOT/packages/panel/dist-filmcraft"
ENDPOINT="$HOME/.kilnframe/filmcraft.json"
LOG="$HOME/.kilnframe/filmcraft-launch.log"

say_error() {
  /usr/bin/osascript -e "display alert \"FilmCraft + Kilnframe\" message \"$1\" as critical" >/dev/null 2>&1
  exit 1
}

mkdir -p "$HOME/.kilnframe"
[[ -x "$FILMCRAFT" ]] || say_error "FilmCraft bulunamadı: /Applications/FilmCraft.app"
[[ -x "$ELECTRON" && -f "$PANEL/main.js" ]] || say_error "Kilnframe paneli derlenmemiş. $ROOT içinde: corepack pnpm --filter @kilnframe/panel build:filmcraft"

# the companion: the Kilnframe menu bar app
/usr/bin/open -g -a Kilnframe 2>/dev/null

listening() { /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -q FilmCraft; }

if listening && [[ -f "$ENDPOINT" ]]; then
  : # FilmCraft is already open for Kilnframe: only the panel is missing
elif /usr/bin/pgrep -x FilmCraft >/dev/null; then
  say_error "FilmCraft zaten açık ama Kilnframe bağlantısı olmadan açılmış. Önce FilmCraft'ı kapat (projeni kaydet), sonra bu uygulamayı tekrar aç."
else
  TOKEN="$(/usr/bin/openssl rand -hex 32)"
  (umask 077 && print -r -- "{\"port\": $PORT, \"token\": \"$TOKEN\"}" > "$ENDPOINT")
  FILMCRAFT_CONTROL_TOKEN="$TOKEN" nohup "$FILMCRAFT" --control "$PORT" >>"$LOG" 2>&1 &
  disown
  for _ in {1..60}; do
    listening && break
    sleep 0.5
  done
  listening || say_error "FilmCraft açıldı ama kontrol kanalı başlamadı. Ayrıntı: $LOG"
fi

# one panel window at a time
if ! /usr/bin/pgrep -f "dist-filmcraft" >/dev/null; then
  nohup "$ELECTRON" "$PANEL" >>"$LOG" 2>&1 &
  disown
fi
