# SPDX-License-Identifier: GPL-3.0-or-later
"""Run the sleep hook against temporary driver files and a simulated systemctl."""
import os
from pathlib import Path
import subprocess
import tempfile

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    driver = root / 'driver'
    driver.mkdir()
    calls = root / 'calls'
    systemctl = root / 'systemctl'
    systemctl.write_text('#!/bin/sh\necho "$*" >> "$CALLS"\n[ "$1" != "$FAIL_COMMAND" ]\n')
    systemctl.chmod(0o755)
    hook = root / 'hook'
    source = Path('90-restart-iio-sensor-proxy').read_text()
    # Redirect the two absolute system paths before executing any part of the hook.
    assert source.count('/sys/bus/i2c/drivers/i2c_hid_acpi') == 1
    assert '/usr/bin/systemctl' in source
    hook.write_text(source.replace('/sys/bus/i2c/drivers/i2c_hid_acpi', str(driver))
                    .replace('/usr/bin/systemctl', str(systemctl)))

    def run(phase, fail=''):
        calls.write_text('')
        result = subprocess.run(['sh', hook, phase, 'suspend'], capture_output=True, text=True,
                                env=dict(os.environ, CALLS=str(calls), FAIL_COMMAND=fail))
        return result.returncode, calls.read_text().splitlines()

    expected = ['stop iio-sensor-proxy.service', '--no-block restart iio-sensor-proxy.service']
    assert run('pre') == (0, [])
    assert run('post') == (0, expected)
    assert not (driver / 'unbind').exists()
    device = 'i2c-FRMW0005:00'
    (driver / device).touch()
    assert run('post') == (0, expected)
    assert (driver / 'unbind').read_text() == (driver / 'bind').read_text() == device
    (driver / 'unbind').write_text('')
    status, commands = run('post', fail='stop')
    assert status != 0 and commands == expected and not (driver / 'unbind').read_text(), \
        'failed stop must skip the reset and still queue recovery'
    (driver / 'bind').unlink()
    (driver / 'bind').mkdir()
    status, commands = run('post')
    assert status != 0 and commands == expected, 'failed device reset skipped service recovery'
    print('PASS: resume hook covers pre-sleep, Framework reset, other hardware, and failure recovery')
