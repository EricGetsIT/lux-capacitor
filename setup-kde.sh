#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
if (( EUID == 0 )); then
    echo 'Run ./setup-kde.sh as your normal desktop user. It requests sudo for the sleep hook.' >&2
    exit 1
fi
for tool in plasmashell gjs glib-compile-schemas; do
    command -v "$tool" >/dev/null || { echo "Required tool is missing: $tool" >&2; exit 1; }
done
# Plasma 6.6 crashes with QT_QPA_PLATFORM=offscreen; --version works without a display.
version=$(plasmashell --version 2>/dev/null || true)
if ! [[ $version =~ ^plasmashell[[:space:]]+([0-9]+)\.([0-9]+)(\.|$) ]] ||
    (( BASH_REMATCH[1] < 6 || (BASH_REMATCH[1] == 6 && BASH_REMATCH[2] < 2) )); then
    echo "Lux Capacitor requires Plasma 6.2 or newer. Found: $version" >&2
    exit 1
fi

base=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_dir="$base/lux-capacitor@extensions"
share="$HOME/.local/share"
target="$share/lux-capacitor"
unit="$HOME/.config/systemd/user/lux-capacitor.service"
desktop="$share/applications/lux-capacitor-settings.desktop"
save_root="${XDG_STATE_HOME:-$HOME/.local/state}/lux-capacitor"

mkdir -p "$share"
stage=$(mktemp -d "$share/.lux-capacitor-XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
mkdir -p "$stage/app/schemas"
cp "$source_dir"/{brightnessModel,keyboardController,screenController,preferencesPage,kdeSchema,kdeScreenBackend,kdeDaemon,kdeSettings}.js "$stage/app/"
cp "$source_dir"/schemas/*.xml "$stage/app/schemas/"
glib-compile-schemas --strict "$stage/app/schemas"

# Quote the Exec argument, then let KeyFile escape it for the desktop entry.
gjs -c '
    imports.gi.versions.Adw = "1";
    const {Adw, GLib} = imports.gi;
    if (!Adw.ButtonRow)
        throw new Error("The settings app requires libadwaita with Adw.ButtonRow");
    const file = new GLib.KeyFile();
    file.load_from_file(ARGV[0], GLib.KeyFileFlags.NONE);
    const group = "Desktop Entry";
    const path = ARGV[2].replace(/["`$\\]/g, "\\$&").replace(/%/g, "%%");
    const exec = file.get_string(group, "Exec").replace("@SETTINGS_SCRIPT@", () => path);
    file.set_string(group, "Exec", exec);
    file.save_to_file(ARGV[1]);
' "$base/kde/lux-capacitor-settings.desktop" "$stage/settings.desktop" "$target/kdeSettings.js"

# A cancelled sudo prompt must leave the previous installation running.
sudo bash "$base/install-resume-hook.sh"
save=
if [[ -e $target || -e $unit || -e $desktop ]]; then
    mkdir -p "$save_root"
    # A T-separated timestamp keeps KDE snapshots out of setup.sh's GNOME rotation.
    save=$(mktemp -d "$save_root/$(date +%Y%m%dT%H%M%S)-XXXXXX")
    mkdir "$save/kde"
    if [[ -d $target ]]; then cp -a "$target/." "$save/kde/"; fi
    if [[ -f $unit ]]; then cp -p "$unit" "$save/kde/"; fi
    if [[ -f $desktop ]]; then cp -p "$desktop" "$save/kde/"; fi
    echo "Previous KDE installation backed up to $save/kde"
fi

start=()
if [[ :${XDG_CURRENT_DESKTOP:-}: == *:KDE:* ]]; then
    start=(--now)
    # enable --now leaves an already running copy on the old code.
    if systemctl --user is-active --quiet lux-capacitor.service; then
        systemctl --user stop lux-capacitor.service
    fi
fi
mkdir -p "$(dirname "$unit")" "$(dirname "$desktop")"
rm -rf -- "$target"
mv -- "$stage/app" "$target"
install -m 644 "$base/kde/lux-capacitor.service" "$unit"
install -m 644 "$stage/settings.desktop" "$desktop"
systemctl --user daemon-reload
systemctl --user enable "${start[@]}" lux-capacitor.service

if [[ -n $save ]]; then
    # The GNOME installer also keeps backups in save_root. Rotate only KDE installs.
    find "$save_root" -mindepth 1 -maxdepth 1 -type d -name '20??????T??????-*' \
        -exec test -d '{}/kde' \; -printf '%T@ %p\0' | sort -zrn | tail -z -n +6 |
        while IFS= read -r -d '' entry; do
            old=${entry#* }
            rm -rf -- "$old/kde"
            rmdir --ignore-fail-on-non-empty -- "$old"
        done
fi
printf 'Installed the KDE brightness service in %s, the Lux Capacitor settings launcher, and the system sleep hook.\n' "$target"
echo 'Check the service with: systemctl --user status lux-capacitor'
