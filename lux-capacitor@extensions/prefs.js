// SPDX-License-Identifier: GPL-3.0-or-later
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {buildPreferences} from './preferencesPage.js';

export default class LuxCapacitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        buildPreferences(window, this.getSettings());
    }
}
