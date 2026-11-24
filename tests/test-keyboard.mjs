// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import {KeyboardController, automaticKeyboardTarget, fromHardware, toHardware} from '../lux-capacitor@extensions/keyboardController.js';
import {ScreenController} from '../lux-capacitor@extensions/screenController.js';
import Extension, {Main} from './extension-fixture.mjs';

const KeyboardControl = GObject.registerClass({Properties: {
    value: GObject.ParamSpec.int('value', null, null, GObject.ParamFlags.READWRITE, 0, 100, 0),
}}, class KeyboardControl extends GObject.Object {
    _init() { super._init(); this._value = 0; }
    get value() { return this._value; }
    set value(v) { this._value = v; this.notify('value'); }
});

function assert(value, message) {
    if (!value)
        throw new Error(message);
}
let count = 0;
function test(name, callback) {
    callback();
    print(`PASS: ${name}`);
    count++;
}
function fixture(auto = true, level = 0) {
    const settings = {
        value: auto,
        ints: {'keyboard-idle-timeout': 0, 'keyboard-dark-lux': 10},
        get_boolean() { return this.value; },
        set_boolean(_key, value) { this.value = value; },
        get_int(key) { return this.ints[key]; },
    };
    const writes = [];
    const popups = [];
    const c = new KeyboardController({settings, onManualChanged: value => popups.push(value)});
    Object.assign(c, {_enabled: true, _available: true, _lastActual: level,
        _currentLevel: level, _smoothLevel: level});
    c._startRamp = () => {};
    c._stopRamp = () => {};
    // These tests supply hardware readings directly. The polling test uses its own controller.
    c._keepPollingFast = () => {};
    c._requestWrite = value => {
        writes.push(value);
        c._lastRequested = value;
        c._ownWrites.push({level: value, expires: GLib.get_monotonic_time() + 2_000_000});
    };
    return {c, settings, writes, popups};
}
function acknowledge(c, level) {
    c._onProxySignal('BrightnessChanged', new GLib.Variant('(is)', [level, 'set property']));
}

test('Five spaced hardware changes request the restored 20, 50, 75, 100, 0 presets', () => {
    const {c, settings, writes, popups} = fixture();
    // Representative native changes from the corresponding manual settings.
    // This verifies remapping, not firmware Auto removal or physical timing.
    const hardware = [20, 75, 0, 100, 5];
    const expected = [20, 50, 75, 100, 0];
    for (let i = 0; i < expected.length; i++) {
        c._settleUntil = 0;
        c._ownWrites = [];
        c._onActualLevel(hardware[i]);
        assert(writes.at(-1) === expected[i], `wrong preset at step ${i}`);
        assert(popups.length === i, 'popup shown before the selected value was confirmed');
        acknowledge(c, expected[i]);
        assert(c.currentLevel === expected[i] && popups.at(-1) === expected[i], 'feedback mismatch');
    }
    assert(!settings.value && writes.join() === expected.join(), 'manual sequence changed Auto incorrectly');
});

test('Keyboard Auto finishes a fade instead of lingering at a few percent', () => {
    const {c, writes} = fixture(true, 10);
    c._target = 0;
    let ticks = 0;
    // Simulate 100 ms ramp ticks; before the minimum speed, 10% -> 0 took about 7 s.
    while (c._smoothLevel !== 0 && ticks < 100) {
        c._lastRampTick = GLib.get_monotonic_time() - 100_000;
        c._rampTick();
        ticks++;
    }
    assert(c._smoothLevel === 0 && ticks <= 25 && writes.at(-1) === 0,
        `fade from 10% took ${ticks} ticks`);
});

test('Fn+Space turns keyboard Auto off at any level, even mid-fade', () => {
    // Auto fading out passes through levels the firmware also uses. A
    // press landing on one of them was taken for the fade's own write, so
    // Auto stayed on and faded the light straight back to 0.
    for (const [current, firmware, preset] of [[3, 20, 20], [15, 20, 20], [30, 75, 50], [60, 75, 75], [0, 20, 20]]) {
        const {c, settings, writes} = fixture(true, current);
        c._target = 0;
        const now = GLib.get_monotonic_time();
        for (const level of [80, 75, 60, 50, 30, 20, 15, 3, 0].filter(l => l >= current))
            c._ownWrites.push({level, expires: now + 2_000_000});
        c._lastRequested = current;
        c._onActualLevel(firmware);
        assert(!settings.value && writes.at(-1) === preset,
            `press at ${current}% -> firmware ${firmware}% kept Auto on (writes ${writes.join()})`);
    }
});

test('Quick Fn+Space presses each advance one preset, with no press lost', () => {
    const {c, settings, writes, popups} = fixture(false, 0);
    // Firmware levels from a hardware log, pressed faster than the settle
    // window. A press used to be ignored there, leaving the firmware's 0
    // on screen and every later preset out of sequence.
    const firmware = [20, 75, 0, 100, 0];
    const expected = [20, 50, 75, 100, 0];
    for (let i = 0; i < firmware.length; i++) {
        c._onActualLevel(firmware[i]);
        acknowledge(c, expected[i]);
    }
    assert(!settings.value && writes.join() === expected.join() && popups.join() === expected.join(),
        `a quick press was lost: ${writes.join()}`);
});

test('A forwarded firmware signal does not advance the cycle twice', () => {
    const {c, writes} = fixture(false, 20);
    c._onActualLevel(75);
    c._onProxySignal('BrightnessChanged', new GLib.Variant('(is)', [75, 'internal']));
    assert(writes.join() === '50', 'one hardware event advanced multiple times');
});

test('Manual slider selection turns software Auto off and writes the selected value', () => {
    const {c, settings, writes, popups} = fixture(true, 20);
    c.setManualLevel(43);
    acknowledge(c, 43);
    assert(!settings.value && c.currentLevel === 43 && writes.join() === '43', 'manual override failed');
    assert(popups.length === 0, 'slider unexpectedly emitted a hardware-key popup');
});

test('Software Auto follows the existing sensor curve and stops responding when disabled', () => {
    const {c, settings, writes} = fixture(false, 20);
    c.setAutoEnabled(true);
    c.onSensorLevel(0);
    assert(settings.value && c._target === 55, 'dark-room Auto target changed');
    c.onSensorLevel(78);
    assert(settings.value && c._target === 0, 'bright-room Auto target changed');
    c.setAutoEnabled(false);
    c.onSensorLevel(0);
    assert(!settings.value && c._target === null && writes.length === 0, 'disabled Auto responded to sensor');
});

test('Desktop idle dimming and restoration preserve Auto without a manual remap', () => {
    const {c, settings, writes} = fixture(true, 36);
    let dimming = true;
    c._isDimming = () => dimming;
    c.onSensorLevel(6);
    c._onPowerSignal(30, 'external');
    c._onActualLevel(30);
    assert(settings.value && c.currentLevel === 30 && writes.length === 0,
        'desktop dimming was mistaken for a manual brightness key');
    c.onSensorLevel(0);
    assert(c._rampTick() === GLib.SOURCE_REMOVE && writes.length === 0,
        'Auto fought desktop dimming');
    dimming = false;
    let ramps = 0;
    c._startRamp = () => ramps++;
    c._onPowerSignal(36, 'external');
    c._onActualLevel(36);
    assert(settings.value && c.currentLevel === 36 && ramps > 0 && writes.length === 0,
        'restoration did not resume Auto cleanly');
});

test('Fn+Space still takes manual control while the desktop is dimmed', () => {
    const {c, settings, writes} = fixture(true, 36);
    c._isDimming = () => true;
    c._onPowerSignal(30, 'external');
    c._onActualLevel(75);
    assert(!settings.value && writes.join() === '50',
        'idle handling swallowed a real hardware brightness change');
});

test('Power notifications preserve manual mode and ignore own writes and hardware signals', () => {
    const {c, settings, writes} = fixture(false, 50);
    c._ownWrites.push({level: 75, expires: GLib.get_monotonic_time() + 2_000_000});
    c._onPowerSignal(75, 'external');
    c._onPowerSignal(20, 'internal');
    assert(c.currentLevel === 50, 'own or hardware event was treated as desktop dimming');
    c._onPowerSignal(30, 'external');
    c._onActualLevel(30);
    assert(!settings.value && c.currentLevel === 30 && writes.length === 0,
        'desktop notification enabled Auto or remapped brightness in manual mode');
});

test('Numeric keyboard popup is emitted once for a confirmed preset', () => {
    const {c, popups} = fixture(false, 20);
    c._onActualLevel(75);
    acknowledge(c, 50);
    c._onActualLevel(50);
    assert(popups.join() === '50', 'duplicate or incorrect popup');
});

test('A stale hardware read cannot overwrite a newer desktop brightness notification', () => {
    for (const ownWrite of [false, true]) {
        const {c, settings, writes} = fixture(true, 36);
        let completeRead;
        c._file = {
            load_contents_async(_cancel, callback) {
                completeRead = () => callback(this, {});
            },
            load_contents_finish() {
                return [true, new TextEncoder().encode('36')];
            },
        };
        c._pollActual();
        if (ownWrite)
            c._ownWrites.push({level: 30, expires: GLib.get_monotonic_time() + 2_000_000});
        c._onPowerSignal(30, 'external');
        if (ownWrite)
            acknowledge(c, 30);
        completeRead();
        assert(settings.value && c.currentLevel === 30 && writes.length === 0,
            `stale read disabled Auto (${ownWrite ? 'own fade' : 'desktop dim'})`);
        assert(!c._pollPending, 'discarded sample stopped future polling');
        c._file.load_contents_finish = () => [true, new TextEncoder().encode('75')];
        c._pollActual();
        completeRead();
        assert(!settings.value && writes.join() === '50',
            'a fresh manual change after the discarded sample was ignored');
    }
});

test('Retained Quick Settings UI displays restored-controller percentages without writing back', () => {
    const slider = new KeyboardControl();
    const discrete = new KeyboardControl();
    let feedbackWrites = 0;
    const item = {_sliderItem: slider, _discreteItem: discrete,
        _sliderItemChangedId: slider.connect('notify::value', () => feedbackWrites++),
        _discreteItemChangedId: discrete.connect('notify::value', () => feedbackWrites++)};
    const e = new Extension();
    const {c} = fixture(false, 50);
    Object.assign(e, {_keyboard: c, _keyboardQuickItem: item, _keyboardAutoMenuItem: {}});
    e._syncKeyboardToggle();
    assert(item.subtitle === '50%' && slider.value === 50 && item.checked,
        'retained UI disagrees with the restored controller');
    assert(e._keyboardAutoMenuItem.state === false && feedbackWrites === 0,
        'display update changed brightness or Auto');
    const displayed = [];
    Main.osdWindowManager = {showAll(_icon, label, level) { displayed.push([label, level]); }};
    e._settings = {get_boolean: () => true};
    e._showKeyboardOSD(50);
    assert(displayed[0][0] === '50%' && displayed[0][1] === 0.5, 'numeric popup was lost');
});

test('Native automatic brightness stays off during extension control and restores its previous state', () => {
    for (const initiallyEnabled of [false, true]) {
        const values = {'native-override-active': false, 'native-ambient-was-enabled': false};
        let native = initiallyEnabled;
        let changed;
        const e = new Extension();
        e._settings = {
            get_boolean(key) { return values[key]; },
            set_boolean(key, value) { values[key] = value; },
        };
        e._powerSettings = {
            get_boolean() { return native; },
            set_boolean(_key, value) { native = value; },
            connect(_signal, callback) { changed = callback; return 1; },
        };
        e._manager = {_inhibitUpdates: false, globalScale: {value: 0.4}, _sync() {}};
        e._getActualBrightness = () => 0.4;
        e._takeOverNativeAmbient();
        assert(!native && values['native-override-active'], 'Native Auto was not disabled');
        native = true;
        changed();
        assert(!native, 'Native Auto competed with the extension');
        e._restoreNativeAmbient();
        assert(native === initiallyEnabled && !values['native-override-active'], 'Previous native setting was not restored');
    }
});

test('Volume slider shows OSD for user changes, ignores backend sync, and restores its handler', () => {
    new Extension()._restoreSpeakerSlider();
    const Control = GObject.registerClass({
        Properties: {value: GObject.ParamSpec.double('value', 'value', 'value',
            GObject.ParamFlags.READWRITE, 0, 1.5, 0)},
    }, class VolumeSliderControl extends GObject.Object {});
    for (const ownHandler of [false, true]) {
        const slider = new Control();
        let writes = 0;
        const shown = [];
        const prototype = {
            _sliderChanged() { writes++; },
            showOSD() { shown.push(this.slider.value); },
        };
        const item = Object.assign(Object.create(prototype), {slider, stream: {}});
        if (ownHandler)
            item._sliderChanged = prototype._sliderChanged;
        const original = item._sliderChanged;
        const changedId = slider.connect('notify::value', () => item._sliderChanged());
        const e = new Extension();
        e._patchSpeakerSlider(item);
        slider.value = 0.5;
        slider.value = 1.25;
        assert(writes === 2 && shown.join(',') === '0.5,1.25', 'User changes lost volume writes or OSD');
        slider.block_signal_handler(changedId);
        slider.value = 0.2;
        slider.unblock_signal_handler(changedId);
        assert(writes === 2 && shown.length === 2, 'Backend sync triggered feedback');
        item.stream = null;
        slider.value = 0.3;
        assert(shown.length === 2, 'Missing output stream triggered OSD');
        item.stream = {};
        e._restoreSpeakerSlider();
        assert(item._sliderChanged === original && Object.hasOwn(item, '_sliderChanged') === ownHandler,
            'Disable did not restore the original handler');
        slider.value = 0.4;
        assert(writes === 4 && shown.length === 2, 'OSD patch survived disable');
        e._patchSpeakerSlider(item);
        slider.value = 0.6;
        assert(shown.length === 3, 'Re-enable duplicated or lost feedback');
        const otherWrapper = () => {};
        item._sliderChanged = otherWrapper;
        e._restoreSpeakerSlider();
        assert(item._sliderChanged === otherWrapper, 'Disable overwrote another extension');
        slider.disconnect(changedId);
    }
});

test('Brightness and volume OSD bars follow rapid reversals immediately and restore on disable', () => {
    for (const ownHandler of [false, true]) {
        const bars = [0, 1].map(() => ({
            value: 0, pending: null, removed: 0,
            remove_transition(name) {
                assert(name === 'value', 'Popup fade was changed');
                this.pending = null;
                this.removed++;
            },
        }));
        const calls = [];
        const prototype = {
            _showOsdWindow(monitor, icon, label, level, maxLevel) {
                calls.push([monitor, label, level, maxLevel]);
                if (Number.isFinite(level))
                    bars[monitor].pending = level;
                return 'original-result';
            },
        };
        const manager = Object.assign(Object.create(prototype), {
            _osdWindows: bars.map(bar => ({_level: bar})),
        });
        if (ownHandler)
            manager._showOsdWindow = prototype._showOsdWindow;
        Main.osdWindowManager = manager;
        const original = manager._showOsdWindow;
        const e = new Extension();
        e._settings = {get_boolean: () => true};
        e._patchSpeakerOSD();
        for (const [monitor, name] of [[0, 'display-brightness-symbolic'], [1, 'audio-volume-high-symbolic']]) {
            const icon = new Gio.ThemedIcon({name});
            for (const level of [0.9, 0.1, 1, 0, 0.6]) {
                assert(manager._showOsdWindow(monitor, icon, 'label', level, 1) === 'original-result',
                    'Original OSD result was lost');
                assert(bars[monitor].value === level && bars[monitor].pending === null,
                    'OSD still trails the current slider level');
            }
        }
        const call = calls.at(-1);
        assert(call[1] === '60' && call[3] === 1, 'Numeric volume label or range changed');
        manager._showOsdWindow(1, new Gio.ThemedIcon({name: 'audio-volume-overamplified-symbolic'}), null, 1.25, 1.5);
        assert(bars[1].value === 1.25 && calls.at(-1)[1] === '125', 'Amplified volume was clamped');
        const removed = bars[0].removed;
        manager._showOsdWindow(0, new Gio.ThemedIcon({name: 'microphone-sensitivity-high-symbolic'}), null, 0.4, 1);
        assert(bars[0].pending === 0.4 && bars[0].removed === removed, 'Unrelated OSD animation changed');
        manager._showOsdWindow(0, null, 'No level', null, 1);
        assert(bars[0].removed === removed, 'Missing level changed animation');
        e._restoreSpeakerOSD();
        assert(manager._showOsdWindow === original && Object.hasOwn(manager, '_showOsdWindow') === ownHandler,
            'Disable did not restore original OSD behavior');
    }
});

test('Turning off percentages leaves the popups without numbers but keeps their bars', () => {
    const e = new Extension();
    e._settings = {get_boolean: key => key !== 'show-osd-numbers'};
    const bar = {value: 0, remove_transition() {}};
    const labels = [];
    const windows = [{_level: bar, setLabel: label => labels.push(['set', label])}];
    Main.osdWindowManager = Object.assign(Object.create({
        _showOsdWindow(_monitor, _icon, label) { labels.push(['window', label]); },
    }), {_osdWindows: windows, showAll(_icon, label) { labels.push(['keyboard', label]); }});
    e._patchSpeakerOSD();
    Main.osdWindowManager._showOsdWindow(0, new Gio.ThemedIcon({name: 'audio-volume-high-symbolic'}), null, 0.6, 1);
    assert(bar.value === 0.6, 'the volume bar no longer follows the slider');
    e._manager = {_showOSD() {}};
    e._patchBrightnessOSD();
    e._manager._showOSD([{value: 0.4, monitor: {get_number: () => 0}}]);
    e._showKeyboardOSD(50);
    assert(JSON.stringify(labels) === JSON.stringify([['window', null], ['keyboard', null]]),
        `numbers were still shown: ${JSON.stringify(labels)}`);
    e._restoreBrightnessOSD();
    e._restoreSpeakerOSD();
});

function screenFixture(anchors = '[]', backend = {
    value: 0.5,
    setSilently(value) { this.value = value; },
}) {
    const values = {anchors, 'anchor-unit': anchors === '[]' ? '' : 'lux', enabled: true,
        'transition-speed': 'normal', 'light-sensitivity': 'normal',
        'screen-min-brightness': 0, 'screen-max-brightness': 100, 'dim-on-battery': false};
    let writes = 0;
    const handlers = new Map();
    const settings = {
        get_string(key) { return values[key]; },
        set_string(key, value) {
            values[key] = value;
            writes++;
            handlers.get(`changed::${key}`)?.();
        },
        get_boolean(key) { return values[key]; },
        set_boolean(key, value) { values[key] = value; handlers.get(`changed::${key}`)?.(); },
        get_int(key) { return values[key]; },
        connect(signal, callback) { handlers.set(signal, callback); return signal; },
        disconnect(signal) { handlers.delete(signal); },
    };
    const screen = new ScreenController({settings, backend});
    screen._connectSensor = () => {
        screen._sensor = {LightLevelUnit: 'lux', ReleaseLightRemote() {}, disconnect() {}};
        screen._sensorClaimed = true;
    };
    screen._connectUPower = () => {};
    screen.start();

    const targets = [];
    const setTarget = screen._setTarget.bind(screen);
    screen._setTarget = target => {
        targets.push(target);
        setTarget(target);
    };
    const sense = lux => {
        screen._sensor.LightLevel = lux;
        screen._onSensorPropertiesChanged();
    };
    const drag = value => {
        backend.value = value;
        screen.onUserChange();
    };
    return {screen, settings, values, targets, sense, drag, writes: () => writes};
}

function gnomeScreenFixture() {
    const e = new Extension();
    e._manager = {globalScale: {value: 0.5}, scales: [], autoBrightnessTarget: -1,
        _inhibitUpdates: false, _sync() {}};
    e._originalKeySteps = new Map();
    const {screen, settings, values, targets, sense} = screenFixture('[]', e._createScreenBackend());
    e._settings = settings;
    e._screen = screen;
    return {e, screen, values, targets, sense};
}

function waitForAnchorSave(screen) {
    while (screen._saveAnchorsId)
        GLib.MainContext.default().iteration(true);
}

test('Screen ignores small light fluctuations but follows real changes', () => {
    const {screen, targets, sense} = screenFixture();
    for (const lux of [40, 42, 44, 46])
        sense(lux);
    assert(targets.length === 1, 'sensor noise re-targeted the screen');
    sense(60);
    assert(targets.length === 2, 'a real light change was ignored');
    screen.stop();
});

test('A plain screen backend receives fade steps and learns a user change', () => {
    const applied = [];
    const loop = GLib.MainLoop.new(null, false);
    const backend = {
        value: 0.1,
        setSilently(value) {
            this.value = value;
            applied.push(value);
            if (applied.length === 2)
                loop.quit();
        },
    };
    const {screen, values, sense} = screenFixture('[]', backend);
    sense(500);
    // Bound the wait if the light change fails to start a fade.
    const timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
        loop.quit();
        return GLib.SOURCE_CONTINUE;
    });
    loop.run();
    GLib.source_remove(timeout);
    assert(applied.length === 2 && applied[0] > 0.1 && applied[1] > applied[0] &&
        applied[1] < screen._target, 'the backend did not receive successive fade steps');
    backend.value = 0.67;
    screen.onUserChange();
    screen.stop();
    const anchors = JSON.parse(values.anchors);
    assert(anchors.length === 1 && anchors[0].lux === 500 && anchors[0].brightness === 0.67 &&
        values['anchor-unit'] === 'lux', 'the manual backend value was not learned');
});

test('A screen slider drag saves one settled preference after the drag', () => {
    const {screen, values, sense, drag, writes} = screenFixture();
    sense(60);
    for (const value of [0.6, 0.62, 0.64])
        drag(value);
    assert(writes() === 0 && screen._saveAnchorsId, 'drag wrote settings on every step');
    waitForAnchorSave(screen);
    const saved = JSON.parse(values.anchors);
    assert(saved.length === 1 && saved[0].lux === 60 && saved[0].brightness === 0.64 &&
        values['anchor-unit'] === 'lux', 'settled preference was not saved');
    screen.stop();
});

test('Turning screen Auto off resets preferences and cancels a pending save', () => {
    const {screen, settings, values, sense, drag} = screenFixture();
    sense(60);
    drag(0.7);
    settings.set_boolean('enabled', false);
    assert(!screen._saveAnchorsId && values.anchors === '[]' && screen._anchors.length === 0,
        'pending save survived the reset');
    screen.stop();
});

test('Disabling (on logout) writes a pending screen preference', () => {
    const {e, values, sense} = gnomeScreenFixture();
    Main.sessionMode = {isLocked: true};
    Main.osdWindowManager = {};
    sense(60);
    e._manager.globalScale.value = 0.7;
    e._screen.onUserChange();
    e.disable();
    assert(JSON.parse(values.anchors)[0]?.brightness === 0.7, 'pending preference was lost on lock');
});

test('Locking hides the Auto switches but keeps brightness control running', () => {
    const {e, targets, sense} = gnomeScreenFixture();
    let destroyed = 0;
    const keyboardTile = {};
    Object.assign(e, {
        _screenQuickItem: {disconnect() {}, menuEnabled: true,
            _monitorBrightnessSection: {actor: {visible: true}}},
        _screenAutoMenuItem: {disconnect() {}, destroy() { destroyed++; }},
        _screenMenuEnabledId: 1, _screenQuickItemDestroyId: 2, _screenAutoMenuItemDestroyId: 3,
        _screenSectionWasVisible: true,
        _keyboardAutoMenuItem: {destroy() { destroyed++; }},
        _keyboardQuickItem: keyboardTile, _menuSetupId: 0,
    });
    Main.sessionMode = {isLocked: true};
    e._onSessionModeChanged();
    assert(destroyed === 2 && !e._screenAutoMenuItem && !e._keyboardAutoMenuItem,
        'an Auto switch stayed visible on the lock screen');
    assert(e._keyboardQuickItem === keyboardTile, 'the keyboard tile lost its handlers on the lock screen');
    sense(5);
    sense(500);
    assert(targets.length === 2 && targets[1] > targets[0], 'brightness stopped following the light while locked');
    e._scheduleQuickSettingsMenus();
    assert(!e._menuSetupId, 'a menu retry re-added the switches while locked');
    Main.sessionMode = {isLocked: false};
    let scheduled = 0;
    e._scheduleQuickSettingsMenus = () => scheduled++;
    e._onSessionModeChanged();
    assert(scheduled === 1, 'the switches were not restored after unlocking');
    e._screen.stop();
});

test('A closed lid turns keyboard Auto light off and ignores the darkness under it', () => {
    const {c, settings, writes} = fixture(true, 30);
    c.onSensorLevel(0);
    assert(c._target === 55, 'Auto did not light the keyboard in the dark');
    c.setLidClosed(true);
    assert(writes.at(-1) === 0 && c._target === 0 && settings.value, 'closing the lid left the light on or turned Auto off');
    c._onActualLevel(0);
    assert(settings.value && writes.join() === '0', 'the off write was mistaken for Fn+Space');
    c.onSensorLevel(0);
    assert(c._lux === null && c._target === 0, 'darkness under the closed lid lit the keyboard');
    c.setLidClosed(false);
    assert(c._target === 0 && writes.join() === '0', 'opening the lid lit the keyboard before a fresh reading');
    c.onSensorLevel(0);
    assert(c._target === 55, 'keyboard Auto did not resume after opening the lid');
});

test('A closed lid turns a manual keyboard level off and restores it on opening', () => {
    const {c, settings, writes} = fixture(false, 50);
    c.setLidClosed(true);
    c.setLidClosed(false);
    assert(!settings.value && writes.join() === '0,50', `manual level not restored: ${writes.join()}`);
});

test('The docked slider and tile edit the level to restore on opening', () => {
    for (const auto of [false, true]) {
        const {c, settings, writes} = fixture(auto, 50);
        c.setLidClosed(true);
        acknowledge(c, 0);
        c.setManualLevel(20);
        c.setManualLevel(75);
        assert(!settings.value && c.currentLevel === 75, 'slider lost the docked selection');
        c.toggleLight();
        assert(c.currentLevel === 0, 'tile did not clear the docked selection');
        c.toggleLight();
        assert(c.currentLevel === 75, 'tile did not restore the docked selection');
        assert(writes.join() === '0', 'a docked control lit the closed keyboard');
        c.setLidClosed(false);
        assert(writes.join() === '0,75', 'opening did not apply the latest selection');
    }
});

test('Backlight reports while docked cannot replace a pending choice or disable Auto', () => {
    for (const auto of [false, true]) {
        const {c, settings, writes} = fixture(auto, 50);
        c.setLidClosed(true);
        acknowledge(c, 0);
        for (const report of [() => c._onPowerSignal(50, 'external'),
            () => c._onActualLevel(50), () => acknowledge(c, 50)]) {
            report();
            assert(writes.at(-1) === 0 && settings.value === auto, 'a docked report took manual control');
            acknowledge(c, 0);
        }
        assert(writes.join() === '0,0,0,0', 'restored hardware levels were left on while docked');
        c.setLidClosed(false);
        assert(writes.at(-1) === (auto ? 0 : 50), 'a docked report changed the restore level');
    }
});

test('A late off reading after reopening keeps the selected manual level', () => {
    const {c, writes} = fixture(false, 50);
    c.setLidClosed(true);
    c.setManualLevel(75);
    c.setLidClosed(false);
    c._onActualLevel(0);
    acknowledge(c, 75);
    assert(writes.join() === '0,75' && c.currentLevel === 75,
        'the late lid-close reading was remapped as a keyboard shortcut');
});

test('Closing the lid releases the light sensor and opening it resumes screen Auto', () => {
    const {screen, targets, sense} = screenFixture();
    let released = 0;
    let claimed = 0;
    screen._releaseSensor = () => {
        released++;
        screen._sensorClaimed = false;
    };
    screen._claimSensor = () => {
        claimed++;
        screen._sensorClaimed = true;
        screen._readLux();
    };
    sense(300);
    const upower = {LidIsPresent: true, LidIsClosed: true, OnBattery: false, disconnect() {}};
    screen._upower = upower;
    screen._onPowerChanged();
    assert(released === 1 && screen._lux === null, 'the sensor stayed claimed under a closed lid');
    sense(0);
    assert(targets.length === 1, 'darkness under the closed lid moved the screen');
    screen._sensor.LightLevel = 300;
    upower.LidIsClosed = false;
    screen._onPowerChanged();
    assert(claimed === 1 && screen._lux === 300 && targets.length === 2, 'screen Auto did not resume after opening the lid');
    screen.stop();
});

test('Sensor service restart discards stale claims and resumes Auto on a fresh reading', () => {
    const {screen, targets} = screenFixture();
    let owner = ':1.20';
    const claims = [];
    Object.assign(screen, {_sensorClaimed: false, _sensorGeneration: 0, _sensor: {
        HasAmbientLight: true, LightLevel: 20, LightLevelUnit: 'lux',
        get_name_owner: () => owner, ClaimLightRemote: callback => claims.push(callback),
        ReleaseLightRemote() {}, disconnect() {},
    }});
    screen._claimSensor();
    owner = null;
    screen._onSensorOwnerChanged();
    owner = ':1.21';
    screen._sensor.LightLevel = 80;
    screen._onSensorOwnerChanged();
    assert(claims.length === 2, 'the replacement sensor service was not claimed');
    claims[0](null, null);
    assert(!screen._sensorClaimed && screen._lux === null && targets.length === 0, 'a stale claim moved the screen');
    claims[1](null, null);
    assert(screen._sensorClaimed && screen._lux === 80 && targets.length === 1, 'Auto did not resume on the new service');
    screen.stop();
});

test('Contradicting preferences stored by earlier versions are cleaned up on load', () => {
    const {screen} = screenFixture('[{"lux":40,"brightness":0.9},{"lux":150,"brightness":0.3}]');
    assert(screen._anchors.length === 1 && screen._anchors[0].lux === 150, 'stored contradiction was kept');
    screen.stop();
});

function idleMonitor() {
    return {
        idle: null, active: null, removed: [],
        add_idle_watch(_ms, callback) { this.idle = callback; return 1; },
        add_user_active_watch(callback) { this.active = callback; return 2; },
        remove_watch(id) { this.removed.push(id); },
    };
}

test('The default dark threshold keeps the original keyboard policy', () => {
    for (const lux of [0, 2, 10, 18, 24, 25, 30, 100]) {
        for (const wasLit of [false, true]) {
            const expected = wasLit ? lux < 25 : lux <= 10;
            const {lit} = automaticKeyboardTarget(lux, wasLit);
            assert(lit === expected, `default threshold changed at ${lux} lux`);
        }
    }
    assert(automaticKeyboardTarget(15, false, 20).lit && !automaticKeyboardTarget(15).lit,
        'a higher dark threshold did not light the keyboard');
});

test('Idle timeout fades only Auto light and restores it on activity', () => {
    const {c, settings, writes} = fixture(true, 55);
    const monitor = idleMonitor();
    c._idleMonitor = monitor;
    settings.ints['keyboard-idle-timeout'] = 30;
    c._watchIdle();
    c.onSensorLevel(0);
    assert(c._target === 55, 'Auto did not light the keyboard');
    monitor.idle();
    assert(settings.value && c._target === 0, 'idle did not fade Auto light while keeping Auto on');
    monitor.active();
    assert(settings.value && c._target === 55 && writes.length === 0, 'activity did not restore Auto light');
});

test('Idle timeout never changes a manual keyboard level', () => {
    const {c, settings, writes} = fixture(false, 50);
    const monitor = idleMonitor();
    c._idleMonitor = monitor;
    settings.ints['keyboard-idle-timeout'] = 5;
    c._watchIdle();
    monitor.idle();
    monitor.active();
    assert(!settings.value && c._target === null && writes.length === 0, 'idle changed a manual level');
});

test('Idle fade writes are not mistaken for Fn+Space', () => {
    const {c, settings, writes, popups} = fixture(true, 55);
    const monitor = idleMonitor();
    c._idleMonitor = monitor;
    settings.ints['keyboard-idle-timeout'] = 30;
    c._watchIdle();
    c.onSensorLevel(0);
    monitor.idle();
    for (const level of [40, 20, 0]) {
        c._requestWrite(level);
        c._onActualLevel(level);
    }
    assert(settings.value && writes.join() === '40,20,0' && popups.length === 0,
        'idle fade advanced a preset or turned Auto off');
});

test('Fn+Space from an Auto level advances exactly one preset in either detection order', () => {
    for (const pollFirst of [true, false]) {
        const {c, settings, writes} = fixture(true, 37);
        if (pollFirst) {
            c._onActualLevel(75);
            c._onProxySignal('BrightnessChanged', new GLib.Variant('(is)', [75, 'internal']));
        } else {
            c._onProxySignal('BrightnessChanged', new GLib.Variant('(is)', [75, 'internal']));
            c._onActualLevel(75);
        }
        assert(!settings.value && writes.join() === '50',
            `one press did not give one preset (${pollFirst ? 'poll' : 'signal'} first)`);
    }
});

test('Battery dimming keeps learned preferences undimmed and exact', () => {
    const {screen, targets, sense, drag} = screenFixture();
    Object.assign(screen, {_dimOnBattery: true, _onBattery: true});
    sense(60);
    drag(0.51);
    assert(Math.abs(screen._anchors[0].brightness - 0.6) < 1e-9, 'battery dimming was learned as a preference');
    screen._onBattery = false;
    screen._retargetNow();
    assert(Math.abs(targets.at(-1) - 0.6) < 1e-9, 'preference was not restored on AC power');
    screen.stop();
});

test('A small or slow screen fade reaches its target instead of stalling', () => {
    // Steps under the write threshold were skipped and then repeated from the
    // same slider value, so the 15% battery dimming never reached the screen.
    for (const [speed, from, to] of [['normal', 0.43, 0.43 * 0.85], ['subtle', 0.6, 0.5],
        ['normal', 0.5, 0.51], ['fast', 0.2, 0.9]]) {
        const {e, screen} = gnomeScreenFixture();
        const scale = e._manager.globalScale;
        scale.value = from;
        Object.assign(screen, {_speed: speed, _target: to, _level: null, _holdUntil: 0, _timerId: 1});
        let ticks = 0;
        let running = true;
        // Simulate 100 ms ticks for up to a minute.
        while (running && ticks < 600) {
            screen._lastTick = GLib.get_monotonic_time() - 100_000;
            running = screen._tick() === GLib.SOURCE_CONTINUE;
            ticks++;
        }
        assert(!running && !screen._timerId && Math.abs(scale.value - to) <= 0.003,
            `${speed} fade ${from} -> ${to} stopped at ${scale.value} after ${ticks} ticks`);
    }
    const {e, screen} = gnomeScreenFixture();
    const scale = e._manager.globalScale;
    scale.value = 0.8;
    Object.assign(screen, {_speed: 'normal', _target: 0.3, _level: null, _holdUntil: 0, _timerId: 1});
    screen._lastTick = GLib.get_monotonic_time() - 100_000;
    screen._tick();
    scale.value = 0.4;
    screen._lastTick = GLib.get_monotonic_time() - 100_000;
    screen._tick();
    assert(scale.value < 0.4 && scale.value > 0.39, 'the fade ignored a slider value changed from outside');
});

test('A missing keyboard backlight stops polling instead of failing on every poll', () => {
    const {c} = fixture(true, 0);
    c._file = {
        load_contents_async(_cancel, callback) { callback(this, {}); },
        load_contents_finish() {
            throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND, 'No such file');
        },
    };
    c._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60_000, () => GLib.SOURCE_REMOVE);
    c._pollActual();
    assert(c._pollId === 0 && !c._pollPending, 'polling continued without a keyboard backlight');
});

test('The keyboard level is read less often while idle and fast again on any change', () => {
    const settings = {ints: {'keyboard-idle-timeout': 0, 'keyboard-dark-lux': 10},
        get_boolean: () => false, get_int(key) { return this.ints[key]; }};
    const watches = {};
    let nextId = 1;
    const monitor = {
        add_idle_watch(ms, callback) { watches.idle = [ms, callback]; return nextId++; },
        add_user_active_watch(callback) { watches.active = callback; return nextId++; },
        remove_watch() {},
    };
    const c = new KeyboardController({settings, idleMonitor: monitor});
    c._file = {load_contents_async() {}};
    Object.assign(c, {_enabled: true, _pollStopped: false, _userIdle: false, _available: true});
    c._requestWrite = () => {};
    c.setAutoEnabled = () => {};
    c._setPollInterval(50);
    c._watchPollIdle();
    assert(c._pollMs === 50 && watches.idle[0] === 10_000, 'polling did not start fast');
    watches.idle[1]();
    assert(c._pollMs === 250, 'polling did not slow down while idle');
    c._onActualLevel(0);
    c._onActualLevel(20);
    assert(c._pollMs === 50 && c._pollSlowId, 'a keyboard change while idle did not restore fast polling');
    c._pollSlowId = GLib.source_remove(c._pollSlowId) && 0;
    watches.idle[1]();
    assert(c._pollMs === 250, 'polling did not slow down again');
    watches.active();
    assert(c._pollMs === 50 && !c._userIdle, 'input did not restore fast polling');
    c._pollStopped = true;
    watches.idle[1]();
    assert(c._pollMs === 50, 'polling restarted after it was stopped for a missing backlight');
    c._enabled = true;
    c._pollId = GLib.source_remove(c._pollId) && 0;
    c._unwatchPollIdle();
});

test('Resetting learned brightness from the settings window reaches the extension', () => {
    const {screen, settings, values, targets, sense, drag} = screenFixture();
    sense(60);
    drag(0.9);
    settings.set_string('anchors', '[]');
    settings.set_string('anchor-unit', '');
    assert(screen._anchors.length === 0 && !screen._saveAnchorsId && targets.length === 2,
        'external reset was ignored or overwritten');
    screen._saveAnchors();
    assert(screen._anchors.length === 0 && values.anchors === '[]', 'own save reloaded preferences');
    screen.stop();
});

test('100% is written as 99%, so Fn+Space cannot lock the light off from it', () => {
    // Recorded on the Framework EC: a press from exactly 100% locks the
    // light off and reverts host writes; the same press from 99% does not.
    assert(toHardware(100) === 99 && toHardware(75) === 75 && toHardware(0) === 0,
        'wrong hardware level');
    assert(fromHardware(99) === 100 && fromHardware(100) === 100 && fromHardware(50) === 50,
        'wrong reading');
    const {c, settings, writes} = fixture(false, 0);
    c.setManualLevel(99);
    assert(writes.join() === '100', 'a 99% request was not treated as 100%');
    c._onProxySignal('BrightnessChanged', new GLib.Variant('(is)', [99, 'set property']));
    assert(c.currentLevel === 100 && !settings.value, 'the 99% echo of a 100% write was not recognized');
    let completeRead;
    c._file = {
        load_contents_async(_cancel, callback) { completeRead = () => callback(this, {}); },
        load_contents_finish() { return [true, new TextEncoder().encode('99')]; },
    };
    c._settleUntil = 0;
    c._pollActual();
    completeRead();
    assert(c.currentLevel === 100 && writes.length === 1, 'a 99% reading was taken for a key press');
});

test('A firmware override of a manual write is shown, not taken for Fn+Space', () => {
    const {c, settings, writes, popups} = fixture(false, 0);
    c.toggleLight();
    acknowledge(c, 100);
    c._onActualLevel(100);
    // The locked EC puts the light back off within the settle window.
    c._onActualLevel(0);
    assert(c.currentLevel === 100, 'the reading inside the settle window was not ignored');
    c._settleUntil = 0;
    c._onActualLevel(0);
    assert(c.currentLevel === 0 && writes.join() === '100' && popups.length === 0 && !settings.value,
        'the overridden level was not shown, or was taken for a key press');
    // The next Fn+Space press still advances exactly one preset.
    c._onActualLevel(20);
    assert(writes.join() === '100,20', 'Fn+Space after an override did not give one preset');
});

test('The keyboard tile turns the light off and back on at the last chosen level', () => {
    const {c, settings, writes} = fixture(true, 30);
    c.toggleLight();
    assert(!settings.value && writes.join() === '0', 'the tile did not turn Auto off and the light off');
    acknowledge(c, 0);
    c.toggleLight();
    acknowledge(c, 100);
    assert(writes.join() === '0,100', 'with no chosen level the tile did not use 100%');
    c.setManualLevel(50);
    acknowledge(c, 50);
    c.toggleLight();
    acknowledge(c, 0);
    c.toggleLight();
    acknowledge(c, 50);
    assert(writes.join() === '0,100,50,0,50' && c.currentLevel === 50,
        'the tile did not come back at the last chosen level');
});

test('The keyboard tile click goes through the controller and is restored on disable', () => {
    const Tile = GObject.registerClass({Signals: {clicked: {}}},
        class KeyboardTile extends GObject.Object {});
    const slider = new KeyboardControl();
    const discrete = new KeyboardControl();
    slider._slider = {connect: () => 1, disconnect() {}};
    const item = new Tile();
    Object.assign(item, {_sliderItem: slider, _discreteItem: discrete, subtitle: 'native',
        _sliderItemChangedId: slider.connect('notify::value', () => {}),
        _discreteItemChangedId: discrete.connect('notify::value', () => {})});
    let nativeClicks = 0;
    item.connect('clicked', () => nativeClicks++);
    let toggles = 0;
    const e = new Extension();
    Object.assign(e, {_keyboard: {toggleLight: () => toggles++}, _keyboardQuickItem: item});
    e._installKeyboardManualHandlers(item);
    item.emit('clicked');
    assert(toggles === 1 && nativeClicks === 0, 'the tile click still wrote directly');
    e._restoreKeyboardManualHandlers();
    item.emit('clicked');
    assert(toggles === 1 && nativeClicks === 1, 'disable did not restore the native tile click');
});

for (const name of ['extension.js', 'screenController.js', 'keyboardController.js', 'brightnessModel.js',
    'prefs.js', 'preferencesPage.js']) {
    const [ok, bytes] = Gio.File.new_for_path(`lux-capacitor@extensions/${name}`).load_contents(null);
    assert(ok, `unable to read ${name}`);
    Reflect.parse(new TextDecoder().decode(bytes), {target: 'module'});
}
print(`${count} regression checks passed; all extension modules parse.`);
