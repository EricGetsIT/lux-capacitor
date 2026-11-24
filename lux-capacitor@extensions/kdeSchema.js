// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';

export function loadSettings() {
    const directory = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('schemas');
    const source = Gio.SettingsSchemaSource.new_from_directory(directory.get_path(),
        Gio.SettingsSchemaSource.get_default(), false);
    const id = 'org.gnome.shell.extensions.lux-capacitor';
    const schema = source.lookup(id, false);
    if (!schema)
        throw new Error(`Missing ${id} in ${directory.get_path()}`);
    return Gio.Settings.new_full(schema, null, null);
}
