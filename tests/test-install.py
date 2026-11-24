# SPDX-License-Identifier: GPL-3.0-or-later
"""Exercise the release installer in a private settings session, with root actions mocked."""
import configparser
import hashlib
import io
import json
import os
import pathlib
import platform
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
        'gnome-shell': '#!/bin/sh\n[ -n "$TEST_SHELL_VERSION" ] || exit 127\nprintf "GNOME Shell %s\\n" "$TEST_SHELL_VERSION"\n',
        'plasmashell': '''#!/bin/sh
[ -n "$TEST_PLASMA_VERSION" ] || exit 127
[ "${QT_QPA_PLATFORM:-}" != offscreen ] || exit 1
printf 'plasmashell %s\\n' "$TEST_PLASMA_VERSION"
''',
        'gnome-extensions': '#!/bin/sh\nprintf "extensions %s\\n" "$*" >> "$TEST_COMMAND_LOG"\n',
        'systemctl': '#!/bin/sh\nprintf "systemctl %s\\n" "$*" >> "$TEST_COMMAND_LOG"\n[ "$1" = --user ]\n',
        'sudo': '''#!/bin/sh
printf 'sudo %s\n' "$*" >> "$TEST_COMMAND_LOG"
case "$1" in
    apt-get|dnf|pacman|zypper) exit 0 ;;
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

    def session_env(directory):
        runtime = directory / 'run'
        runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
        env = dict(os.environ, PATH=str(commands) + ':' + os.environ['PATH'],
                   HOME=str(directory / 'home'), XDG_DATA_HOME=str(directory / 'data'),
                   XDG_STATE_HOME=str(directory / 'state'), XDG_CONFIG_HOME=str(directory / 'config'),
                   XDG_CACHE_HOME=str(directory / 'cache'), XDG_RUNTIME_DIR=str(runtime), XDG_CURRENT_DESKTOP='',
                   GSETTINGS_BACKEND='keyfile', TEST_COMMAND_LOG=str(log))
        for name in ('DBUS_SESSION_BUS_ADDRESS', 'DCONF_PROFILE', 'GSETTINGS_SCHEMA_DIR',
                     'QT_QPA_PLATFORM', 'LUX_OS_RELEASE'):
            env.pop(name, None)
        return env

    env = session_env(root)

    def install(version='50.0', plasma='', *, directory=root, release=None):
        install_env = dict(session_env(directory), TEST_SHELL_VERSION=version, TEST_PLASMA_VERSION=plasma)
        if release is not None:
            install_env['LUX_OS_RELEASE'] = str(release)
        return subprocess.run(['dbus-run-session', '--', 'bash', str(source / 'install.sh')],
                              input='y\n', text=True, capture_output=True,
                              env=install_env, timeout=90)

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
        assert f'Found: GNOME Shell {unsupported}' in rejected.stdout, rejected.stdout + rejected.stderr
        assert rejected.returncode != 0 and not log.exists(), f'GNOME {unsupported} modified the system'
        assert not (root / 'data').exists(), f'Rejected GNOME {unsupported} install created an extension'
    print('PASS: GNOME 49 and 52 are rejected before installation')
    for version, plasma, found in [('', '6.1', 'plasmashell 6.1'), ('', '', 'no Plasma')]:
        rejected = install(version, plasma)
        assert rejected.returncode != 0 and found in rejected.stdout, rejected.stdout + rejected.stderr
        assert 'no GNOME Shell' in rejected.stdout and not log.exists()
        assert not any((root / name).exists() for name in ('data', 'state', 'config', 'home'))
    release = root / 'os-release'
    release.write_text('ID=unsupported\nID_LIKE="notdebian archlinux"\n')
    rejected = install(release=release)
    assert rejected.returncode != 0 and 'unsupported' in rejected.stdout, rejected.stdout + rejected.stderr
    assert not log.exists() and not any((root / name).exists() for name in ('data', 'state', 'config', 'home'))
    print('PASS: Plasma 6.1, missing desktops and an unsupported distro are rejected before installation')
    fresh = install()
    assert fresh.returncode == 0, fresh.stdout + fresh.stderr
    target = root / 'data/gnome-shell/extensions' / UUID
    assert (target / 'schemas/gschemas.compiled').exists()
    for name in ('extension.js', 'keyboardController.js', 'brightnessModel.js', 'prefs.js', 'metadata.json'):
        assert (target / name).read_bytes() == (source / UUID / name).read_bytes()
    state = json.loads(settings("print(json.dumps([brightness.get_boolean('enabled'), brightness.get_boolean('keyboard-auto-enabled'), media.get_int('volume-step'), shell.get_strv('enabled-extensions')]))"))
    assert state[:3] == [True, True, 5] and UUID in state[3], state
    distro = platform.freedesktop_os_release()
    distro_ids = [distro['ID'], *distro.get('ID_LIKE', '').split()]
    managers = {'ubuntu': 'apt-get install', 'debian': 'apt-get install', 'fedora': 'dnf install',
                'arch': 'pacman -S', 'suse': 'zypper --non-interactive install'}
    expected = next(managers['suse' if name.startswith('opensuse') else name] for name in distro_ids
                    if name in managers or name.startswith('opensuse'))
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

    # Read each reference family's lists independently of the os-release supplied to the installer.
    def package_groups(distro_id):
        script = 'source "$1"; printf "%s\\n" "${common[*]}" "${gnome[*]}" "${kde[*]}"'
        return subprocess.check_output(['bash', '-ec', script, 'bash', str(source / 'packages.sh')],
                                       env=dict(env, ID=distro_id, ID_LIKE=''), text=True).splitlines()

    packages = {
        'apt': ('apt-get install -y', package_groups('debian')),
        'dnf': ('dnf install -y', package_groups('fedora')),
        'pacman': ('pacman -S --needed --noconfirm', package_groups('arch')),
        'zypper': ('zypper --non-interactive install', package_groups('opensuse-tumbleweed')),
    }
    cases = [
        # ID, ID_LIKE, package manager, GNOME Shell, Plasma, expected desktop(s)
        ('ubuntu', 'debian', 'apt', '50.0', '', 'gnome'),
        ('debian', '', 'apt', '', '6.6.7', 'kde'),
        ('fedora', '', 'dnf', '51.0', '6.2', 'both'),
        ('arch', '', 'pacman', '50.0', '6.10', 'both'),
        ('opensuse-tumbleweed', '', 'zypper', '51.0', '6.6', 'both'),
        ('opensuse-leap', '', 'zypper', '', '6.6', 'kde'),
        ('linuxmint', 'ubuntu debian', 'apt', '50.0', '6.6', 'both'),
        ('endeavouros', 'arch', 'pacman', '49.0', '6.6', 'kde'),
        ('geckolinux', 'opensuse suse', 'zypper', '51.0', '6.1', 'gnome'),
    ]
    for distro_id, like, manager, version, plasma, desktops in cases:
        directory = root / distro_id
        release.write_text(f'ID={distro_id}\nID_LIKE="{like}"\n')
        log.write_text('')
        result = install(version, plasma, directory=directory, release=release)
        assert result.returncode == 0, result.stdout + result.stderr
        lines = log.read_text().splitlines()
        gnome = desktops in ('gnome', 'both')
        kde = desktops in ('kde', 'both')
        command, (common, gnome_packages, kde_packages) = packages[manager]
        requested = [common]
        if gnome:
            requested.append(gnome_packages)
        if kde:
            requested.append(kde_packages)
        expected = ['sudo apt-get update'] if manager == 'apt' else []
        expected.append(f"sudo {command} {' '.join(requested)}")
        assert [s for s in lines if s.startswith('sudo ') and not s.startswith('sudo bash ')] == expected, lines

        extension = directory / 'data/gnome-shell/extensions' / UUID
        share = directory / 'home/.local/share'
        assert (extension / 'schemas/gschemas.compiled').exists() == gnome
        if not gnome:
            assert not any(s.startswith('extensions ') for s in lines), lines
        assert (share / 'lux-capacitor/schemas/gschemas.compiled').exists() == kde
        assert (share / 'lux-capacitor/kdeDaemon.js').exists() == kde
        assert (directory / 'home/.config/systemd/user/lux-capacitor.service').exists() == kde
        launcher = share / 'applications/lux-capacitor-settings.desktop'
        assert launcher.exists() == kde
        if kde:
            assert str(share / 'lux-capacitor/kdeSettings.js') in launcher.read_text()
            assert 'systemctl --user enable lux-capacitor.service' in lines, lines
        if gnome and kde:
            assert result.stdout.index('Installed extension') < result.stdout.index('Installed the KDE')
        print(f'PASS: {distro_id} requests the expected {manager} packages and installs the selected desktops')
    print('NOTE: package installation, the privileged sleep hook and live desktop activation were mocked.')
