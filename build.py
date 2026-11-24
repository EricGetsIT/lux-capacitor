# SPDX-License-Identifier: GPL-3.0-or-later
"""Build the one-file installer, the extension ZIP, and their checksums in dist/."""
from pathlib import Path
import gzip
import hashlib
import io
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT
OUTPUT = ROOT / 'dist/Install-Lux-Capacitor.run'
UUID = 'lux-capacitor@extensions'

HEADER = '''#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
    --help|-h)
        echo 'Lux Capacitor: Ubuntu / Fedora with GNOME Shell 50 or 51.'
        echo 'Run: bash ./Install-Lux-Capacitor.run (normal desktop user, no sudo).'
        echo 'Verify only: bash ./Install-Lux-Capacitor.run --check'
        echo 'Includes screen/keyboard Auto, manual presets, percentage displays, and the resume hook.'
        exit 0 ;;
    ''|--check) ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
esac
if [[ "${1:-}" != --check ]] && (( EUID == 0 )); then
    echo 'Run as your normal desktop user, without sudo.' >&2
    exit 1
fi
for tool in tar gzip sha256sum awk tail mktemp; do
    command -v "$tool" >/dev/null || { echo "Required tool is missing: $tool" >&2; exit 1; }
done
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
line=$(awk '$0 == "__LUX_CAPACITOR_PAYLOAD__" {print NR + 1; exit}' "$0")
[[ -n "$line" ]] || { echo 'Installer payload is missing.' >&2; exit 1; }
tail -n +"$line" "$0" > "$temporary/payload.tar.gz"
if ! (cd "$temporary" && printf '%s  payload.tar.gz\\n' '@DIGEST@' | sha256sum --check --status); then
    echo 'Installer is damaged. Obtain another copy before installing.' >&2
    exit 1
fi
tar --extract --gzip --file="$temporary/payload.tar.gz" --directory="$temporary" --no-same-owner
(cd "$temporary/Lux-Capacitor" && sha256sum --check --status SHA256SUMS)
if [[ "${1:-}" == --check ]]; then
    echo 'PASS: installer payload and all bundled files verified. No installation performed.'
    exit 0
fi
bash "$temporary/Lux-Capacitor/install.sh"
exit 0
__LUX_CAPACITOR_PAYLOAD__
'''

def build():
    OUTPUT.parent.mkdir(exist_ok=True)
    files = [SOURCE / name for name in ['install.sh', 'setup.sh', 'install-resume-hook.sh',
        '90-restart-iio-sensor-proxy', '50-lux-capacitor-restart.conf', 'README.md', 'LICENSE']]
    # setup.sh compiles the schema in a checkout; every install compiles its own.
    extension = sorted(p for p in (SOURCE / UUID).rglob('*')
        if p.is_file() and p.name != 'gschemas.compiled')
    files += extension
    hashes = {str(p.relative_to(SOURCE)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    manifest_path = SOURCE / 'SHA256SUMS'
    manifest = ''.join(f'{digest}  {name}\n' for name, digest in sorted(hashes.items())).encode()
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for path in sorted(files + [manifest_path]):
            name = path.relative_to(SOURCE)
            data = manifest if path == manifest_path else path.read_bytes()
            entry = tarfile.TarInfo(f'Lux-Capacitor/{name}')
            entry.size = len(data)
            entry.mode = 0o755 if path.suffix == '.sh' or path.name.startswith('90-') else 0o644
            archive.addfile(entry, io.BytesIO(data))
    payload = gzip.compress(buffer.getvalue(), mtime=0)
    header = HEADER.replace('@DIGEST@', hashlib.sha256(payload).hexdigest()).encode()
    OUTPUT.write_bytes(header + payload)
    OUTPUT.chmod(0o755)
    extension_zip = OUTPUT.parent / f'{UUID}.shell-extension.zip'
    with zipfile.ZipFile(extension_zip, 'w', zipfile.ZIP_DEFLATED, strict_timestamps=False) as archive:
        for path in extension:
            archive.write(path, path.relative_to(SOURCE / UUID))
        archive.write(SOURCE / 'LICENSE', 'LICENSE')
    artifacts = [OUTPUT, extension_zip]
    (OUTPUT.parent / 'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in artifacts))
    print(f'Built {OUTPUT} ({OUTPUT.stat().st_size:,} bytes)')

if __name__ == '__main__':
    build()
