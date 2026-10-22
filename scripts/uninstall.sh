#!/usr/bin/env bash
# Reverse scripts/install.sh. Keeps ~/.config/fear-tracker unless --purge.
set -euo pipefail

UUID="fear-tracker@local"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
EXT_DEST="$DATA_HOME/gnome-shell/extensions/$UUID"
APP_LINK="$DATA_HOME/fear-tracker"
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/fear-overlay.service"
STATE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/fear-tracker"

purge=0
[[ "${1:-}" == "--purge" ]] && purge=1

step() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }

if command -v gnome-extensions >/dev/null; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
fi
if command -v gsettings >/dev/null && gsettings get org.gnome.shell enabled-extensions >/dev/null 2>&1; then
    current="$(gsettings get org.gnome.shell enabled-extensions)"
    if [[ "$current" == *"'$UUID'"* ]]; then
        step "Removing $UUID from enabled-extensions"
        updated="$(python3 -c '
import ast, sys
items = ast.literal_eval(sys.argv[1].removeprefix("@as "))
print(repr([i for i in items if i != sys.argv[2]]))' "$current" "$UUID")"
        gsettings set org.gnome.shell enabled-extensions "$updated"
    fi
fi

if [[ -f "$UNIT" ]]; then
    step "Removing systemd user service"
    systemctl --user disable --now fear-overlay.service 2>/dev/null || true
    rm -f -- "$UNIT"
    systemctl --user daemon-reload
fi

if [[ -L "$EXT_DEST" || -e "$EXT_DEST" ]]; then
    step "Removing $EXT_DEST"
    rm -rf -- "$EXT_DEST"
fi

if [[ -L "$APP_LINK" ]]; then
    step "Removing $APP_LINK"
    rm -- "$APP_LINK"
fi

if (( purge )) && [[ -d "$STATE_DIR" ]]; then
    step "Removing $STATE_DIR"
    rm -rf -- "$STATE_DIR"
fi

step "Done. Log out and back in to unload the extension from GNOME Shell."
