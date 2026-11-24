// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw?version=1';
import System from 'system';

import {loadSettings} from './kdeSchema.js';
import {buildPreferences} from './preferencesPage.js';

const app = new Adw.Application({application_id: 'io.github.ericgetsit.LuxCapacitor'});
app.connect('activate', () => {
    let window = app.active_window;
    if (!window) {
        window = new Adw.PreferencesWindow({application: app, title: 'Lux Capacitor'});
        buildPreferences(window, loadSettings(), {kde: true});
    }
    window.present();
});
System.exit(app.run([System.programInvocationName, ...ARGV]));
