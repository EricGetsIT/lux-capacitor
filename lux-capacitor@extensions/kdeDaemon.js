// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';

import {KeyboardController} from './keyboardController.js';
import {KdeScreenBackend} from './kdeScreenBackend.js';
import {loadSettings} from './kdeSchema.js';
import {ScreenController} from './screenController.js';

const settings = loadSettings();
const backend = new KdeScreenBackend();
const keyboard = new KeyboardController({settings, backend: 'upower', idleMonitor: null,
    onChanged: () => screen.onKeyboardChanged()});
const screen = new ScreenController({settings, backend, keyboard});
const loop = new GLib.MainLoop(null, false);

keyboard.enable();
screen.start();
backend.start(screen);
for (const signal of [15, 2]) { // SIGTERM, SIGINT
    GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, signal, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
}
try {
    loop.run();
} finally {
    backend.stop();
    screen.stop();
    keyboard.disable();
    Gio.Settings.sync();
}
