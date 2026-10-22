#!/usr/bin/env bash
# Install the Fear Tracker GNOME extension (and optionally the overlay
# server as a systemd user service). Safe to run repeatedly.
#
#   scripts/install.sh            symlink the extension (edits in the repo apply after re-login)
#   scripts/install.sh --copy     copy the extension instead of symlinking
#   scripts/install.sh --service  also install + start the systemd user service
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="fear-tracker@local"
EXT_SRC="$REPO/extension/$UUID"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
EXT_DEST="$DATA_HOME/gnome-shell/extensions/$UUID"
APP_LINK="$DATA_HOME/fear-tracker"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

copy=0
service=0
for arg in "$@"; do
    case "$arg" in
        --copy) copy=1 ;;
        --service) service=1 ;;
        -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

step() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }

step "Compiling GSettings schema"
glib-compile-schemas --strict "$EXT_SRC/schemas"

step "Installing extension to $EXT_DEST"
mkdir -p "$(dirname "$EXT_DEST")"
if [[ -L "$EXT_DEST" || -e "$EXT_DEST" ]]; then
    rm -rf -- "$EXT_DEST"
fi
if (( copy )); then
    cp -r -- "$EXT_SRC" "$EXT_DEST"
else
    ln -s -- "$EXT_SRC" "$EXT_DEST"
fi

step "Linking $APP_LINK -> $REPO"
if [[ -L "$APP_LINK" ]]; then
    rm -- "$APP_LINK"
elif [[ -e "$APP_LINK" ]]; then
    echo "error: $APP_LINK exists and is not a symlink; remove it and re-run" >&2
    exit 1
fi
ln -s -- "$REPO" "$APP_LINK"

step "Creating state file (if missing)"
python3 "$REPO/scripts/set_fear.py" --init

if (( service )); then
    step "Installing systemd user service"
    mkdir -p "$UNIT_DIR"
    install -m 644 "$REPO/systemd/fear-overlay.service" "$UNIT_DIR/fear-overlay.service"
    systemctl --user daemon-reload
    systemctl --user enable --now fear-overlay.service
    systemctl --user restart fear-overlay.service
fi

# Mark the extension enabled. If the running shell doesn't know it yet (first
# install on Wayland), add it to enabled-extensions so it loads after re-login.
if command -v gnome-extensions >/dev/null && gnome-extensions enable "$UUID" 2>/dev/null; then
    :
elif command -v gsettings >/dev/null && gsettings get org.gnome.shell enabled-extensions >/dev/null 2>&1; then
    current="$(gsettings get org.gnome.shell enabled-extensions)"
    if [[ "$current" != *"'$UUID'"* ]]; then
        updated="$(python3 -c '
import ast, sys
cur = sys.argv[1].removeprefix("@as ")
items = ast.literal_eval(cur)
print(repr(items + [sys.argv[2]]))' "$current" "$UUID")"
        gsettings set org.gnome.shell enabled-extensions "$updated"
    fi
fi

echo
step "Done. Remaining steps:"
if gnome-extensions info "$UUID" 2>/dev/null | grep -q 'State: ACTIVE'; then
    echo "  - The extension is active. After editing extension code, log out and back in to reload it."
else
    echo "  - Log out and back in (Wayland can't reload GNOME Shell in place)."
    echo "    The extension is pre-enabled; if the top bar shows no 'Fear', run:"
    echo "      gnome-extensions enable $UUID"
fi
if (( service )); then
    echo "  - Server is running: systemctl --user status fear-overlay"
else
    echo "  - Start the overlay server:  make serve"
    echo "    (or re-run with --service to run it as a systemd user service)"
fi
echo "  - OBS Browser Source URL:    http://127.0.0.1:${FEAR_PORT:-8765}/overlay.html"
