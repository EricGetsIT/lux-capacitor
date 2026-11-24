# SPDX-License-Identifier: GPL-3.0-or-later
"""Exercise the release installer in a private settings session, with root actions mocked."""
import configparser
import hashlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile

UUID = 'lux-capacitor@extensions'
assert os.geteuid() != 0, 'Run as a normal user (or runuser -u nobody in a container)'
artifact = pathlib.Path(sys.argv[1]).resolve()
payload = artifact.read_bytes().split(b'__LUX_CAPACITOR_PAYLOAD__\n', 1)[1]

with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
        archive.extractall(root, filter='data')
    source = root / 'Lux-Capacitor'
    for line in (source / 'SHA256SUMS').read_text().splitlines():
        digest, name = line.split('  ', 1)
        assert hashlib.sha256((source / name).read_bytes()).hexdigest() == digest
    recovery = configparser.ConfigParser()
    recovery.read(source / '50-lux-capacitor-restart.conf')
    assert recovery.get('Service', 'Restart', fallback=None) == 'on-failure', 'Missing sensor crash recovery in installer'
    assert recovery.get('Service', 'RestartSec') == '5s', 'Missing delay between sensor restarts'
    commands = root / 'bin'
    commands.mkdir()
    log = root / 'commands.log'
    stubs = {
        'gnome-shell': '#!/bin/sh\nprintf "GNOME Shell %s\\n" "${TEST_SHELL_VERSION:-50.0}"\n',
        'gnome-extensions': '#!/bin/sh\nprintf "extensions %s\\n" "$*" >> "$TEST_COMMAND_LOG"\n',
        'sudo': '''#!/bin/sh
printf 'sudo %s\n' "$*" >> "$TEST_COMMAND_LOG"
case "$1" in
    apt-get|dnf) exit 0 ;;
    bash) case "$2" in */install-resume-hook.sh) exit 0 ;; esac ;;
esac
echo 'Unexpected privileged command' >&2
exit 1
''',
    }
    for name, script in stubs.items():
        p = commands / name
        p.write_text(script)
        p.chmod(0o755)
    env = dict(os.environ, PATH=str(commands) + ':' + os.environ['PATH'],
               XDG_DATA_HOME=str(root / 'data'), XDG_STATE_HOME=str(root / 'state'),
               XDG_CONFIG_HOME=str(root / 'config'), GSETTINGS_BACKEND='keyfile',
               TEST_COMMAND_LOG=str(log))
    for name in ('DBUS_SESSION_BUS_ADDRESS', 'DCONF_PROFILE', 'GSETTINGS_SCHEMA_DIR'):
        env.pop(name, None)

    def install(version='50.0'):
        return subprocess.run(['dbus-run-session', '--', 'bash', str(source / 'install.sh')],
                              input='y\n', text=True, capture_output=True,
                              env=dict(env, TEST_SHELL_VERSION=version), timeout=90)

    def settings(code):
        prelude = f'''from gi.repository import Gio
import json
schema_source = Gio.SettingsSchemaSource.new_from_directory({str(source / UUID / 'schemas')!r}, Gio.SettingsSchemaSource.get_default(), False)
brightness = Gio.Settings.new_full(schema_source.lookup('org.gnome.shell.extensions.lux-capacitor', False), None, None)
shell = Gio.Settings.new('org.gnome.shell')
media = Gio.Settings.new('org.gnome.settings-daemon.plugins.media-keys')
earlier = Gio.Settings.new_full(schema_source.lookup('org.gnome.shell.extensions.lux-capacitor.keys', False), None, '/org/gnome/shell/extensions/adaptive-brightness/')
'''
        p = subprocess.run(['dbus-run-session', '--', 'python3', '-c', prelude + code],
                           env=env, text=True, capture_output=True, check=True, timeout=20)
        return p.stdout.strip()

    for unsupported in ('49.0', '52.0'):
        rejected = install(unsupported)
        assert rejected.returncode != 0 and not log.exists(), f'GNOME {unsupported} modified the system'
        assert not (root / 'data').exists(), f'Rejected GNOME {unsupported} install created an extension'
    print('PASS: GNOME 49 and 52 are rejected before installation')
    fresh = install()
    assert fresh.returncode == 0, fresh.stdout + fresh.stderr
    target = root / 'data/gnome-shell/extensions' / UUID
    assert (target / 'schemas/gschemas.compiled').exists()
    for name in ('extension.js', 'keyboardController.js', 'brightnessModel.js', 'prefs.js', 'metadata.json'):
        assert (target / name).read_bytes() == (source / UUID / name).read_bytes()
    state = json.loads(settings("print(json.dumps([brightness.get_boolean('enabled'), brightness.get_boolean('keyboard-auto-enabled'), media.get_int('volume-step'), shell.get_strv('enabled-extensions')]))"))
    assert state[:3] == [True, True, 5] and UUID in state[3], state
    distro = pathlib.Path('/etc/os-release').read_text()
    expected = 'dnf install' if '\nID=fedora\n' in '\n' + distro else 'apt-get install'
    assert expected in log.read_text(), 'Wrong distribution package-manager path'
    print('PASS: fresh release install copies files, compiles schema, enables both Auto settings, and selects the distribution package manager')

    settings("brightness.set_boolean('enabled', False)\nbrightness.set_boolean('keyboard-auto-enabled', False)\nbrightness.set_string('anchors', '[{\"lux\":40,\"brightness\":0.7}]')\nGio.Settings.sync()\n")
    (target / 'extension.js').write_text('// previous extension\n')
    upgraded = install()
    assert upgraded.returncode == 0, upgraded.stdout + upgraded.stderr
    state = json.loads(settings("print(json.dumps([brightness.get_boolean('enabled'), brightness.get_boolean('keyboard-auto-enabled'), brightness.get_string('anchors')]))"))
    assert state == [False, False, '[{"lux":40,"brightness":0.7}]'], state
    backups = list((root / 'state/lux-capacitor').glob('*/extension/extension.js'))
    assert any(p.read_text() == '// previous extension\n' for p in backups), 'Previous extension was not backed up'
    assert (target / 'extension.js').read_bytes() == (source / UUID / 'extension.js').read_bytes()
    print('PASS: upgrade preserves manual settings and calibration and backs up the previous extension')

    # Earlier releases used other extension IDs; upgrading must replace both.
    legacy_uuids = ['adaptive-brightness-v2@codex.local', 'lux-capacitor@ierick17.github.io']
    legacies = [root / 'data/gnome-shell/extensions' / name for name in legacy_uuids]
    for legacy in legacies:
        legacy.mkdir(parents=True)
        (legacy / 'extension.js').write_text(f'// {legacy.name}\n')
    settings(f"shell.set_strv('enabled-extensions', {legacy_uuids + ['other@example.com']!r})\nGio.Settings.sync()\n")
    migrated = install()
    assert migrated.returncode == 0, migrated.stdout + migrated.stderr
    assert not any(legacy.exists() for legacy in legacies), 'A previous extension ID was left installed'
    enabled = json.loads(settings("print(json.dumps(shell.get_strv('enabled-extensions')))"))
    assert not set(legacy_uuids) & set(enabled) and UUID in enabled and 'other@example.com' in enabled, enabled
    state = json.loads(settings("print(json.dumps(brightness.get_string('anchors')))"))
    assert state == '[{"lux":40,"brightness":0.7}]', 'Settings were lost when the extension ID changed'
    for name in legacy_uuids:
        backups = list((root / 'state/lux-capacitor').glob(f'*/legacy-extension-{name}/extension.js'))
        assert any(p.read_text() == f'// {name}\n' for p in backups), f'{name} was not backed up'
    print('PASS: upgrade from both previous extension IDs removes them, keeps settings, and backs them up')

    # Releases up to 0.2.5 stored settings and backups under the earlier name.
    settings("brightness.reset('anchors')\nbrightness.set_int('keyboard-dark-lux', 30)\n"
             "earlier.set_string('anchors', '[{\"lux\":5,\"brightness\":0.2}]')\nearlier.set_int('keyboard-dark-lux', 50)\n"
             "earlier.set_boolean('dim-on-battery', True)\nGio.Settings.sync()\n")
    (root / 'state/lux-capacitor').rename(root / 'state/adaptive-brightness')
    renamed = install()
    assert renamed.returncode == 0, renamed.stdout + renamed.stderr
    state = json.loads(settings("print(json.dumps([brightness.get_string('anchors'), brightness.get_int('keyboard-dark-lux'), brightness.get_boolean('dim-on-battery'), [k for k in ('anchors', 'keyboard-dark-lux', 'dim-on-battery') if earlier.get_user_value(k) is not None]]))"))
    assert state == ['[{"lux":5,"brightness":0.2}]', 30, True, []], state
    assert not (root / 'state/adaptive-brightness').exists() and \
        list((root / 'state/lux-capacitor').glob('*/legacy-extension-*')), 'Earlier backups were not moved'
    settings("brightness.set_string('anchors', '[{\"lux\":40,\"brightness\":0.7}]')\nGio.Settings.sync()\n")
    print('PASS: settings and backups stored under the earlier name move to the current one, and newer values win')

    settings("shell.set_boolean('disable-user-extensions', False)\nGio.Settings.sync()")
    log.write_text('')
    gnome51 = install('51.0')
    assert gnome51.returncode == 0, gnome51.stdout + gnome51.stderr
    assert (target / 'extension.js').read_bytes() == (source / UUID / 'extension.js').read_bytes()
    state = json.loads(settings("print(json.dumps(brightness.get_string('anchors')))"))
    assert state == '[{"lux":40,"brightness":0.7}]', 'GNOME 51 install lost settings'
    assert settings("print(shell.get_boolean('disable-user-extensions'))") == 'False'
    assert f'extensions enable {UUID}' in log.read_text(), 'Active extensions did not get live activation'
    print('PASS: GNOME 51 install succeeds and keeps settings')
    # Someone who turned off all user extensions can choose when to activate them.
    settings("shell.set_boolean('disable-user-extensions', True)\nshell.set_strv('enabled-extensions', ['other@example.com'])\nGio.Settings.sync()")
    log.write_text('')
    paused = install()
    assert paused.returncode == 0, paused.stdout + paused.stderr
    state = json.loads(settings("print(json.dumps([shell.get_boolean('disable-user-extensions'), shell.get_strv('enabled-extensions')]))"))
    assert state == [True, ['other@example.com', UUID]], 'Installer overrode the master switch or lost an extension'
    assert f'extensions enable {UUID}' not in log.read_text(), 'Installer requested live activation while extensions were off'
    assert 'turn on' in paused.stdout.lower() and 'extensions app' in paused.stdout.lower(), 'Missing activation instructions'
    print('PASS: installation preserves the disabled master switch and explains how to activate later')
    print('NOTE: package installation, privileged resume-hook installation, and live GNOME Shell activation were mocked; no physical hardware was tested.')
