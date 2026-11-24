// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {KeyboardController, isLevel, removeSource} from './keyboardController.js';
import {BRIGHTNESS_EPSILON, ScreenController} from './screenController.js';

const POWER_SCHEMA = 'org.gnome.settings-daemon.plugins.power';
// Releases up to 0.2.5 stored their settings here.
const LEGACY_SETTINGS_PATH = '/org/gnome/shell/extensions/adaptive-brightness/';
const KEY_STEP = 0.05;

// Replace object[name] with wrap(original). The returned function restores
// the original, unless something else has replaced the method since.
function patchMethod(object, name, wrap) {
    const original = object[name];
    const own = Object.hasOwn(object, name);
    const replacement = wrap(original);
    object[name] = replacement;
    return () => {
        if (object[name] !== replacement)
            return;
        if (own)
            object[name] = original;
        else
            delete object[name];
    };
}

export default class LuxCapacitorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._migrateLegacySettings();
        this._powerSettings = new Gio.Settings({schema_id: POWER_SCHEMA});
        this._manager = Main.brightnessManager;
        this._applying = false;
        this._destroyed = false;
        this._originalKeySteps = new Map();
        this._restoreShowOSD = null;
        this._restoreShowOsdWindow = null;
        this._speakerQuickItem = null;
        this._menuSetupId = 0;
        this._menuAttempts = 0;
        this._screenQuickItem = null;
        this._screenMenuEnabledId = 0;
        this._screenQuickItemDestroyId = 0;
        this._screenAutoMenuItemDestroyId = 0;
        this._screenSectionWasVisible = null;
        this._screenAutoMenuItem = null;
        this._keyboardAutoMenuItem = null;
        this._keyboardQuickItem = null;
        this._keyboardSliderId = 0;
        this._keyboardDiscreteId = 0;

        this._keyboard = new KeyboardController({
            settings: this._settings,
            idleMonitor: global.backend.get_core_idle_monitor(),
            onChanged: () => this._onKeyboardChanged(),
            onManualChanged: level => this._showKeyboardOSD(level),
            isDimming: () => this._manager?.dimming ?? false,
        });
        this._screen = new ScreenController({
            settings: this._settings,
            backend: this._createScreenBackend(),
            keyboard: this._keyboard,
            onStateChanged: () => this._syncToggle(),
        });
        this._userUpdateId = this._manager.connect('user-update', () => {
            if (!this._applying)
                this._screen.onUserChange();
        });
        this._managerChangedId = this._manager.connect('changed',
            () => this._onManagerChanged());

        // GNOME 50 treats its brightness slider as an auto-brightness bias.
        // This extension uses the same slider for actual backlight brightness.
        this._takeOverNativeAmbient();
        this._enforceKeyStep();
        this._patchBrightnessOSD();
        this._patchSpeakerOSD();
        this._scheduleQuickSettingsMenus();
        this._keyboard.enable();
        this._screen.start();
        // The extension also runs on the lock screen (session-modes), so
        // GNOME no longer hands brightness back to its own, much brighter,
        // automatic brightness whenever the screen locks. Only the Auto
        // switches are hidden while locked.
        this._sessionModeId = Main.sessionMode.connect('updated',
            () => this._onSessionModeChanged());
    }

    disable() {
        this._destroyed = true;
        if (this._sessionModeId)
            Main.sessionMode.disconnect(this._sessionModeId);
        this._sessionModeId = 0;
        this._screen?.stop();
        this._menuSetupId = removeSource(this._menuSetupId);
        this._removeScreenAutoSwitch();
        this._keyboardAutoMenuItem?.destroy();
        this._keyboardAutoMenuItem = null;
        this._restoreKeyboardManualHandlers();
        this._keyboardQuickItem = null;
        this._keyboard?.disable();
        this._keyboard = null;
        this._restoreKeySteps();
        this._restoreBrightnessOSD();
        this._restoreSpeakerSlider();
        this._restoreSpeakerOSD();
        if (this._userUpdateId)
            this._manager.disconnect(this._userUpdateId);
        if (this._managerChangedId)
            this._manager.disconnect(this._managerChangedId);
        if (this._powerSettingsId)
            this._powerSettings.disconnect(this._powerSettingsId);

        this._restoreNativeAmbient();

        this._manager = null;
        this._settings = null;
        this._powerSettings = null;
        this._screen = null;
    }

    // Move values an earlier release stored under the old settings path.
    // Values already set under the new path win. setup.sh does the same
    // for installer upgrades; this covers a ZIP installed by hand.
    _migrateLegacySettings() {
        try {
            const source = Gio.SettingsSchemaSource.new_from_directory(
                this.dir.get_child('schemas').get_path(),
                Gio.SettingsSchemaSource.get_default(), false);
            const schema = source.lookup(`${this._settings.schema_id}.keys`, false);
            const legacy = new Gio.Settings({settings_schema: schema,
                path: LEGACY_SETTINGS_PATH});
            for (const key of schema.list_keys()) {
                const value = legacy.get_user_value(key);
                if (value === null)
                    continue;
                if (this._settings.get_user_value(key) === null)
                    this._settings.set_value(key, value);
                legacy.reset(key);
            }
        } catch (error) {
            console.error(`Lux Capacitor: could not move earlier settings: ${error}`);
        }
    }

    _takeOverNativeAmbient() {
        if (!this._settings.get_boolean('native-override-active')) {
            this._settings.set_boolean('native-ambient-was-enabled',
                this._powerSettings.get_boolean('ambient-enabled'));
            this._settings.set_boolean('native-override-active', true);
        }
        this._powerSettings.set_boolean('ambient-enabled', false);
        this._powerSettingsId = this._powerSettings.connect(
            'changed::ambient-enabled', () => {
                if (this._powerSettings.get_boolean('ambient-enabled'))
                    this._powerSettings.set_boolean('ambient-enabled', false);
            });

        // Preserve the currently visible brightness during the handover.
        // Setting autoBrightnessTarget normally calls _sync immediately;
        // inhibit that call until the actual slider value is in place.
        const actual = this._getActualBrightness();
        this._withoutSync(manager => {
            manager.autoBrightnessTarget = -1;
            if (actual !== null && manager.globalScale) {
                manager.globalScale.value = actual;
                manager._globalScaleChanged = true;
            }
        });
    }

    _restoreNativeAmbient() {
        if (!this._settings.get_boolean('native-override-active'))
            return;
        const previous = this._settings.get_boolean('native-ambient-was-enabled');
        this._settings.set_boolean('native-override-active', false);
        if (previous && !this._powerSettings.get_boolean('ambient-enabled')) {
            // Restore GNOME's centered bias while preserving actual brightness.
            const actual = this._getActualBrightness();
            this._withoutSync(manager => {
                if (actual !== null && manager.globalScale) {
                    manager.globalScale.value = 0.5;
                    manager._globalScaleChanged = true;
                    manager.autoBrightnessTarget = actual;
                }
            });
            this._powerSettings.set_boolean('ambient-enabled', previous);
        }
    }

    _getActualBrightness() {
        const values = this._manager.scales.flatMap(scale =>
            scale.monitor.get_monitors()
                .filter(monitor => monitor.get_backlight() && monitor.is_active())
                .map(monitor => {
                    const backlight = monitor.get_backlight();
                    const span = backlight.brightnessMax - backlight.brightnessMin;
                    return span > 0
                        ? (backlight.brightness - backlight.brightnessMin) / span
                        : 0;
                }));
        return values.length > 0 ? Math.max(...values) : null;
    }

    _createScreenBackend() {
        const manager = this._manager;
        return {
            get value() {
                return manager.globalScale?.value ?? null;
            },
            setSilently: value => this._setBrightnessSilently(value),
        };
    }

    _setBrightnessSilently(value) {
        const manager = this._manager;
        if (!manager?.globalScale)
            return;
        if (Math.abs(manager.globalScale.value - value) < BRIGHTNESS_EPSILON &&
            manager.autoBrightnessTarget < 0)
            return;

        this._applying = true;
        try {
            this._withoutSync(() => {
                manager.autoBrightnessTarget = -1;
                manager.globalScale.value = value;
                manager._globalScaleChanged = true;
            });
        } finally {
            this._applying = false;
        }
    }

    // Each assignment to the brightness manager normally calls _sync. Make
    // the whole change first, then sync once unless updates were inhibited.
    _withoutSync(change) {
        const manager = this._manager;
        const previousInhibit = manager._inhibitUpdates;
        manager._inhibitUpdates = true;
        try {
            change(manager);
        } finally {
            manager._inhibitUpdates = previousInhibit;
        }
        if (!previousInhibit)
            manager._sync({showOSD: false});
    }

    _onManagerChanged() {
        this._enforceKeyStep();
        this._scheduleQuickSettingsMenus();
        this._keepScreenMenuAvailable();
        this._screen.retarget();
        this._syncToggle();
    }

    _onKeyboardChanged() {
        if (this._destroyed)
            return;
        this._syncKeyboardToggle();
        this._screen.onKeyboardChanged();
    }

    _syncToggle() {
        if (this._screenAutoMenuItem)
            this._screenAutoMenuItem.state = this._screen.autoEnabled;
    }

    _syncKeyboardToggle() {
        // The switch is hidden on the lock screen; the tile still updates.
        if (this._keyboardAutoMenuItem) {
            this._keyboardAutoMenuItem.state = !!this._keyboard?.autoEnabled;
            this._keyboardAutoMenuItem.reactive = !!this._keyboard?.available;
        }

        // Firmware hotkeys can bypass GNOME's cached D-Bus brightness. Update
        // only the displayed slider value, with its write callbacks blocked.
        const item = this._keyboardQuickItem;
        const level = this._keyboard?.currentLevel;
        if (!item || !isLevel(level))
            return;
        item.checked = level > 0;
        item.subtitle = `${level}%`;
        // Pointer input owns the thumb during a drag.
        if (this._keyboardDragging)
            return;
        item._sliderItem.block_signal_handler(item._sliderItemChangedId);
        item._discreteItem.block_signal_handler(item._discreteItemChangedId);
        try {
            item._sliderItem.value = level;
        } finally {
            item._discreteItem.unblock_signal_handler(item._discreteItemChangedId);
            item._sliderItem.unblock_signal_handler(item._sliderItemChangedId);
        }
    }

    _showKeyboardOSD(level) {
        if (this._destroyed)
            return;
        const icon = Gio.ThemedIcon.new_from_names([
            level > 0 ? 'keyboard-brightness-high-symbolic' : 'keyboard-brightness-off-symbolic',
            'display-brightness-symbolic',
        ]);
        Main.osdWindowManager.showAll(icon, this._showNumbers() ? `${level}%` : null,
            level / 100, 1);
    }

    _enforceKeyStep() {
        const scales = [this._manager.globalScale, ...this._manager.scales];
        // GNOME replaces its monitor scales when monitors change.
        for (const [scale, restores] of this._originalKeySteps) {
            if (!scales.includes(scale)) {
                restores.forEach(restore => restore());
                this._originalKeySteps.delete(scale);
            }
        }
        for (const scale of scales) {
            if (!scale || this._originalKeySteps.has(scale))
                continue;
            // Shell's keybindings call these methods. Setting value normally
            // keeps the user-update signal and lux preference learning intact.
            this._originalKeySteps.set(scale, [
                patchMethod(scale, 'stepUp', () => () => {
                    scale.value = Math.min(1, scale.value + KEY_STEP);
                }),
                patchMethod(scale, 'stepDown', () => () => {
                    scale.value = Math.max(0, scale.value - KEY_STEP);
                }),
            ]);
        }
    }

    _restoreKeySteps() {
        for (const restores of this._originalKeySteps.values())
            restores.forEach(restore => restore());
        this._originalKeySteps.clear();
    }

    _showNumbers() {
        return this._settings.get_boolean('show-osd-numbers');
    }

    _patchBrightnessOSD() {
        const manager = this._manager;
        this._restoreShowOSD = patchMethod(manager, '_showOSD', original => scales => {
            // The input can be an iterator, so retain it for the numeric labels.
            const shownScales = [...scales];
            original.call(manager, shownScales);
            if (!this._showNumbers())
                return;
            for (const scale of shownScales) {
                const monitor = scale.monitor.get_number();
                Main.osdWindowManager._osdWindows[monitor]?.setLabel(
                    String(Math.round(scale.value * 100)));
            }
        });
    }

    _restoreBrightnessOSD() {
        this._restoreShowOSD?.();
        this._restoreShowOSD = null;
    }

    _patchSpeakerOSD() {
        const manager = Main.osdWindowManager;
        this._restoreShowOsdWindow = patchMethod(manager, '_showOsdWindow',
            original => (monitorIndex, icon, label, level, maxLevel) => {
                const names = icon?.get_names?.() ?? [];
                const isSpeaker = names.some(name =>
                    /^audio-volume-(muted|low|medium|high|overamplified)(-symbolic)?$/.test(name));
                const shownLabel = isSpeaker && Number.isFinite(level) && this._showNumbers()
                    ? String(Math.round(level * 100)) : label;
                const result = original.call(manager,
                    monitorIndex, icon, shownLabel, level, maxLevel);
                const isBrightness = names.includes('display-brightness-symbolic');
                if ((isSpeaker || isBrightness) && Number.isFinite(level)) {
                    // Repeated 100 ms animations lag behind rapid slider reversals.
                    const bar = manager._osdWindows[monitorIndex]?._level;
                    if (bar) {
                        bar.remove_transition('value');
                        bar.value = level;
                    }
                }
                return result;
            });
    }

    _restoreSpeakerOSD() {
        this._restoreShowOsdWindow?.();
        this._restoreShowOsdWindow = null;
    }

    _patchSpeakerSlider(item) {
        this._speakerQuickItem = item;
        this._restoreSliderChanged = patchMethod(item, '_sliderChanged',
            original => (...args) => {
                original.apply(item, args);
                // GNOME blocks this handler when synchronizing backend volume updates.
                if (item.stream)
                    item.showOSD();
            });
    }

    _restoreSpeakerSlider() {
        this._restoreSliderChanged?.();
        this._restoreSliderChanged = null;
        this._speakerQuickItem = null;
    }

    _onSessionModeChanged() {
        if (Main.sessionMode.isLocked) {
            // Nobody should change Auto settings on a locked laptop.
            this._menuSetupId = removeSource(this._menuSetupId);
            this._removeScreenAutoSwitch();
            this._keyboardAutoMenuItem?.destroy();
            this._keyboardAutoMenuItem = null;
        } else {
            this._scheduleQuickSettingsMenus();
        }
    }

    _scheduleQuickSettingsMenus() {
        if (this._menuSetupId || Main.sessionMode.isLocked)
            return;
        const currentScreen = Main.panel.statusArea.quickSettings?._brightness
            ?.quickSettingsItems?.[0];
        if (this._screenQuickItem && this._screenQuickItem !== currentScreen)
            this._removeScreenAutoSwitch();
        if (this._screenAutoMenuItem && this._keyboardAutoMenuItem && this._speakerQuickItem)
            return;
        this._menuAttempts = 0;
        this._menuSetupId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100,
            () => {
                const quickSettings = Main.panel.statusArea.quickSettings;
                const screen = quickSettings?._brightness?.quickSettingsItems?.[0];
                const keyboard = quickSettings?._backlight?.quickSettingsItems?.[0];
                const speaker = quickSettings?._volumeOutput?.quickSettingsItems?.[0];
                if (speaker && !this._speakerQuickItem)
                    this._patchSpeakerSlider(speaker);

                if (this._screenQuickItem && this._screenQuickItem !== screen)
                    this._removeScreenAutoSwitch();
                if (screen && !this._screenAutoMenuItem)
                    this._addScreenAutoSwitch(screen);
                if (keyboard && !this._keyboardAutoMenuItem)
                    this._addKeyboardAutoSwitch(keyboard);

                this._menuAttempts++;
                if ((this._screenAutoMenuItem && this._keyboardAutoMenuItem && this._speakerQuickItem) ||
                    this._menuAttempts >= 100) {
                    this._menuSetupId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
    }

    _addScreenAutoSwitch(item) {
        if (!item.menu || !item._monitorBrightnessSection)
            return;
        const switchItem = new PopupMenu.PopupSwitchMenuItem(
            'Auto Brightness', this._screen.autoEnabled);
        switchItem.connect('toggled', (_item, state) => {
            if (state !== this._settings.get_boolean('enabled'))
                this._settings.set_boolean('enabled', state);
        });
        item.menu.addMenuItem(switchItem, 0);
        this._screenQuickItem = item;
        this._screenSectionWasVisible = item._monitorBrightnessSection.actor.visible;
        this._screenAutoMenuItem = switchItem;
        this._screenMenuEnabledId = item.connect('notify::menu-enabled', () => {
            if (!this._destroyed && this._screenQuickItem === item &&
                !item.menuEnabled)
                this._keepScreenMenuAvailable();
        });
        this._screenQuickItemDestroyId = item.connect('destroy', () => {
            if (this._screenQuickItem !== item)
                return;
            this._screenQuickItem = null;
            this._screenMenuEnabledId = 0;
            this._screenQuickItemDestroyId = 0;
            this._screenSectionWasVisible = null;
            this._screenAutoMenuItem = null;
            this._screenAutoMenuItemDestroyId = 0;
            if (!this._destroyed)
                this._scheduleQuickSettingsMenus();
        });
        this._screenAutoMenuItemDestroyId = switchItem.connect('destroy', () => {
            if (this._screenAutoMenuItem !== switchItem)
                return;
            this._screenAutoMenuItem = null;
            this._screenAutoMenuItemDestroyId = 0;
            if (!this._destroyed)
                this._scheduleQuickSettingsMenus();
        });
        this._keepScreenMenuAvailable();
    }

    _removeScreenAutoSwitch() {
        const item = this._screenQuickItem;
        if (item && this._screenMenuEnabledId)
            item.disconnect(this._screenMenuEnabledId);
        if (item && this._screenQuickItemDestroyId)
            item.disconnect(this._screenQuickItemDestroyId);
        this._screenMenuEnabledId = 0;
        this._screenQuickItemDestroyId = 0;

        const switchItem = this._screenAutoMenuItem;
        if (switchItem && this._screenAutoMenuItemDestroyId)
            switchItem.disconnect(this._screenAutoMenuItemDestroyId);
        this._screenAutoMenuItemDestroyId = 0;
        this._screenAutoMenuItem = null;
        switchItem?.destroy();

        if (item) {
            item.menuEnabled = this._manager.scales.length > 1;
            const section = item._monitorBrightnessSection?.actor;
            if (section && this._screenSectionWasVisible !== null)
                section.visible = this._screenSectionWasVisible;
        }
        this._screenQuickItem = null;
        this._screenSectionWasVisible = null;
    }

    _keepScreenMenuAvailable() {
        if (!this._screenQuickItem)
            return;
        if (!this._screenQuickItem.menuEnabled)
            this._screenQuickItem.menuEnabled = true;
        const section = this._screenQuickItem._monitorBrightnessSection?.actor;
        if (section)
            section.visible = this._manager.scales.length > 1;
    }

    _addKeyboardAutoSwitch(item) {
        if (!item.menu || !this._keyboard)
            return;
        const switchItem = new PopupMenu.PopupSwitchMenuItem(
            'Auto Brightness', this._keyboard.autoEnabled);
        switchItem.connect('toggled', (_item, state) => {
            if (state !== this._keyboard.autoEnabled)
                this._keyboard.setAutoEnabled(state);
        });
        item.menu.addMenuItem(switchItem, 0);
        this._keyboardAutoMenuItem = switchItem;
        // The tile's handlers stay installed while the switch is hidden on
        // the lock screen, so they are only replaced for a new tile.
        if (this._keyboardQuickItem !== item) {
            if (this._keyboardQuickItem)
                this._restoreKeyboardManualHandlers();
            this._keyboardQuickItem = item;
            this._installKeyboardManualHandlers(item);
        }
        this._syncKeyboardToggle();
    }

    _installKeyboardManualHandlers(item) {
        // Replace only the native manual-write callbacks. GNOME's _sync()
        // blocks these IDs while displaying automatic/property updates, so
        // those updates cannot be mistaken for a user dragging the slider.
        this._keyboardOriginalSubtitle = item.subtitle;
        this._keyboardDragging = false;
        const slider = item._sliderItem._slider;
        this._keyboardDragBeginId = slider.connect('drag-begin', () => {
            this._keyboardDragging = true;
        });
        this._keyboardDragEndId = slider.connect('drag-end', () => {
            this._keyboardDragging = false;
            this._syncKeyboardToggle();
        });
        // GNOME's own property-change callback also moves the thumb, so it
        // must not run while the user drags the slider.
        this._restoreKeyboardSync = patchMethod(item, '_sync', original => () => {
            if (!this._keyboardDragging)
                original.call(item);
            this._syncKeyboardToggle();
        });
        this._keyboardOriginalSliderId = item._sliderItemChangedId;
        this._keyboardOriginalDiscreteId = item._discreteItemChangedId;
        item._sliderItem.block_signal_handler(this._keyboardOriginalSliderId);
        item._discreteItem.block_signal_handler(this._keyboardOriginalDiscreteId);
        this._keyboardSliderId = item._sliderItem.connect('notify::value', () => {
            if (item._sliderItem.visible)
                this._keyboard?.setManualLevel(item._sliderItem.value);
        });
        this._keyboardDiscreteId = item._discreteItem.connect('notify::value', () => {
            if (item._discreteItem.visible)
                this._keyboard?.setManualLevel(item._discreteItem.value);
        });
        item._sliderItemChangedId = this._keyboardSliderId;
        item._discreteItemChangedId = this._keyboardDiscreteId;
        // GNOME's tile click writes 0 or 100 straight to the power daemon.
        // Route it through the controller like the slider, so it turns
        // keyboard Auto off and its write is recognized as the extension's own.
        this._keyboardOriginalClickedId = GObject.signal_handler_find(item, {signalId: 'clicked'});
        if (this._keyboardOriginalClickedId)
            item.block_signal_handler(this._keyboardOriginalClickedId);
        this._keyboardClickedId = item.connect('clicked', () => this._keyboard?.toggleLight());
    }

    _restoreKeyboardManualHandlers() {
        const item = this._keyboardQuickItem;
        if (!item)
            return;
        const slider = item._sliderItem._slider;
        if (this._keyboardDragBeginId)
            slider.disconnect(this._keyboardDragBeginId);
        if (this._keyboardDragEndId)
            slider.disconnect(this._keyboardDragEndId);
        this._keyboardDragBeginId = 0;
        this._keyboardDragEndId = 0;
        this._keyboardDragging = false;
        this._restoreKeyboardSync?.();
        this._restoreKeyboardSync = null;
        item.subtitle = this._keyboardOriginalSubtitle;
        if (this._keyboardSliderId) {
            item._sliderItem.disconnect(this._keyboardSliderId);
            item._sliderItemChangedId = this._keyboardOriginalSliderId;
            item._sliderItem.unblock_signal_handler(this._keyboardOriginalSliderId);
        }
        if (this._keyboardDiscreteId) {
            item._discreteItem.disconnect(this._keyboardDiscreteId);
            item._discreteItemChangedId = this._keyboardOriginalDiscreteId;
            item._discreteItem.unblock_signal_handler(this._keyboardOriginalDiscreteId);
        }
        this._keyboardSliderId = 0;
        this._keyboardDiscreteId = 0;
        if (this._keyboardClickedId)
            item.disconnect(this._keyboardClickedId);
        if (this._keyboardOriginalClickedId)
            item.unblock_signal_handler(this._keyboardOriginalClickedId);
        this._keyboardClickedId = 0;
        this._keyboardOriginalClickedId = 0;
    }
}
