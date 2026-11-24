#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
if (( EUID == 0 )); then
    echo 'Run ./install.sh as your normal desktop user; it requests sudo for the system hook.' >&2
    exit 1
fi
base=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
uuid=lux-capacitor@extensions
# Earlier releases used these extension IDs (up to 0.1.2, then 0.1.3 to
# 0.2.1). Upgrades remove them so two brightness controllers never run at
# once.
legacy_uuids=(adaptive-brightness-v2@codex.local lux-capacitor@ierick17.github.io)
shell_version=$(gnome-shell --version)
if [[ ! "$shell_version" =~ GNOME\ Shell\ 5[01]([.]|$) ]]; then
    echo "This extension requires GNOME Shell 50 or 51; found: $shell_version" >&2
    exit 1
fi
glib-compile-schemas --strict "$base/$uuid/schemas"
# Fail before replacing files if there is no usable desktop settings session.
python3 - <<'PY'
from gi.repository import Gio
Gio.bus_get_sync(Gio.BusType.SESSION, None)
for name in ['org.gnome.shell', 'org.gnome.settings-daemon.plugins.media-keys']:
    Gio.Settings.new(name)
PY
# Install the privileged component first; do not leave a partial extension install
# when the administrator authentication is cancelled.
sudo bash "$base/install-resume-hook.sh"
target="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"
state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
save_root="$state_home/lux-capacitor"
# Releases up to 0.2.5 kept their backups under the earlier name.
if [[ -d "$state_home/adaptive-brightness" && ! -e "$save_root" ]]; then
    mv -- "$state_home/adaptive-brightness" "$save_root"
fi
mkdir -p "$save_root" "$(dirname "$target")"
save=$(mktemp -d "$save_root/$(date +%Y%m%d-%H%M%S)-XXXXXX")
# Keep this backup and the four before it; names sort by date.
find "$save_root" -mindepth 1 -maxdepth 1 -type d -name '20[0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]-*' |
    sort | head -n -5 | while IFS= read -r old; do rm -rf -- "$old"; done
dconf dump /org/gnome/shell/extensions/lux-capacitor/ > "$save/settings.ini"
dconf dump /org/gnome/shell/extensions/adaptive-brightness/ > "$save/settings-before-0.2.6.ini"
python3 - "$save/desktop-settings.json" <<'PY'
from gi.repository import Gio
import json, sys
keys = {'org.gnome.shell': ['enabled-extensions', 'disabled-extensions', 'disable-user-extensions'],
        'org.gnome.settings-daemon.plugins.media-keys': ['volume-step'],
        'org.gnome.settings-daemon.plugins.power': ['ambient-enabled']}
snapshot = {schema: {key: Gio.Settings.new(schema).get_value(key).unpack()
                    for key in names} for schema, names in keys.items()}
with open(sys.argv[1], 'w') as f:
    json.dump(snapshot, f, indent=2)
PY
if [[ -d "$target" ]]; then
    cp -a "$target" "$save/extension"
    gnome-extensions disable "$uuid" || true
    # Do not keep files that a newer version no longer ships.
    rm -rf -- "$target"
fi
for legacy_uuid in "${legacy_uuids[@]}"; do
    legacy="$(dirname "$target")/$legacy_uuid"
    if [[ -d "$legacy" ]]; then
        cp -a "$legacy" "$save/legacy-extension-$legacy_uuid"
        gnome-extensions disable "$legacy_uuid" || true
        rm -rf -- "$legacy"
    fi
done
mkdir -p "$target"
cp -a "$base/$uuid/." "$target/"
glib-compile-schemas "$target/schemas"
# Brightness settings need no setup: the schema defaults apply to a new
# installation and existing values are left alone. Releases up to 0.2.5
# stored them under another path; move those values to the current one.
python3 - "$uuid" "$target/schemas" "${legacy_uuids[@]}" <<'PY'
from gi.repository import Gio
import sys
source = Gio.SettingsSchemaSource.new_from_directory(sys.argv[2], Gio.SettingsSchemaSource.get_default(), False)
keys = source.lookup('org.gnome.shell.extensions.lux-capacitor.keys', False)
current = Gio.Settings.new_full(source.lookup('org.gnome.shell.extensions.lux-capacitor', False), None, None)
earlier = Gio.Settings.new_full(keys, None, '/org/gnome/shell/extensions/adaptive-brightness/')
for key in keys.list_keys():
    value = earlier.get_user_value(key)
    if value is not None:
        if current.get_user_value(key) is None:
            current.set_value(key, value)
        earlier.reset(key)
Gio.Settings.new('org.gnome.settings-daemon.plugins.media-keys').set_int('volume-step', 5)
settings = Gio.Settings.new('org.gnome.shell')
uuid = sys.argv[1]
legacy = sys.argv[3:]
enabled = [x for x in settings.get_strv('enabled-extensions') if x not in legacy]
if uuid not in enabled:
    enabled.append(uuid)
settings.set_strv('enabled-extensions', enabled)
settings.set_strv('disabled-extensions', [x for x in settings.get_strv('disabled-extensions')
                                          if x != uuid and x not in legacy])
Gio.Settings.sync()
PY
extensions_disabled=$(gsettings get org.gnome.shell disable-user-extensions)
if [[ "$extensions_disabled" == true ]]; then
    echo 'To activate Lux Capacitor, turn on the master switch in the Extensions app when you are ready.'
else
    gnome-extensions enable "$uuid" || true
fi
printf '\nInstalled extension and automatic sensor recovery after resume.\nExisting brightness preferences were preserved.\nLog out and back in to load the extension files.\nBackup: %s\n' "$save"
