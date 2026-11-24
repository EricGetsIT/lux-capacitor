// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ScreenController} from '../lux-capacitor@extensions/screenController.js';
import {KeyboardController} from '../lux-capacitor@extensions/keyboardController.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function test(name, run) {
    run();
    print(`PASS: ${name}`);
}

function keyboardFixture(max = 200, initial = Math.round(max / 2)) {
    const settings = {
        auto: true,
        get_boolean() { return this.auto; },
        set_boolean(_key, enabled) { this.auto = enabled; },
    };
    const writes = [];
    const keyboard = new KeyboardController({settings, backend: 'upower'});
    keyboard._enabled = true;
    keyboard._keepPollingFast = () => {};
    keyboard._proxy = {
        get_name_owner: () => ':1.1',
        GetMaxBrightnessSync: () => [max],
        GetBrightnessSync: () => [initial],
        call(method, parameters, _flags, _timeout, _cancel, done) {
            assert(method === 'SetBrightness' && parameters.get_type_string() === '(i)',
                'wrong UPower method or signature');
            writes.push(...parameters.deep_unpack());
            done(this, {});
        },
        call_finish() {},
    };
    keyboard._onProxyOwnerChanged();
    return {keyboard, writes};
}

test('Without an idle monitor the keyboard is read less often after 10 s without a change', () => {
    const settings = {ints: {'keyboard-idle-timeout': 0, 'keyboard-dark-lux': 10},
        get_boolean: () => false, get_int(key) { return this.ints[key]; }};
    const c = new KeyboardController({settings, backend: 'upower', idleMonitor: null});
    c._file = {load_contents_async() {}};
    Object.assign(c, {_enabled: true, _pollStopped: false, _userIdle: false, _available: true});
    c._requestWrite = () => {};
    c.setAutoEnabled = () => {};
    c._setPollInterval(50);
    c._watchPollIdle();
    c._keepPollingFast();
    assert(c._pollMs === 50 && c._pollSlowId, 'polling did not start fast with a slowdown pending');
    // Fire the 10 s slowdown now instead of waiting for it.
    GLib.source_remove(c._pollSlowId);
    c._pollSlowId = 0;
    if (c._userIdle)
        c._setPollInterval(250);
    assert(c._pollMs === 250, 'polling did not slow down without an idle monitor');
    c._onActualLevel(0);
    c._onActualLevel(20);
    assert(c._pollMs === 50, 'a keyboard change did not restore fast polling');
    c._pollSlowId = GLib.source_remove(c._pollSlowId) && 0;
    c._pollId = GLib.source_remove(c._pollId) && 0;
    c._unwatchPollIdle();
});

test('UPower supplies the initial keyboard level and scales writes and echoes', () => {
    const {keyboard, writes} = keyboardFixture();
    assert(keyboard.available && keyboard.currentLevel === 50, 'initial UPower level');
    keyboard._requestWrite(30);
    keyboard._onPowerSignal(60, 'external');
    keyboard._requestWrite(100);
    keyboard._onPowerSignal(198, 'external');
    assert(writes.join() === '60,198', '100% must be capped before scaling');
    assert(keyboard.autoEnabled && keyboard.currentLevel === 100, 'own echo disabled Auto');
    keyboard._onPowerSignal(198, 'external');
    assert(!keyboard.autoEnabled, 'a second identical external change was still treated as ours');
});

test('A Plasma keyboard slider change immediately takes manual control', () => {
    const {keyboard, writes} = keyboardFixture();
    keyboard._resumeGuardUntil = GLib.get_monotonic_time() + 1_000_000;
    keyboard._onPowerSignal(144, 'external');
    assert(keyboard.currentLevel === 72 && !keyboard.autoEnabled && writes.length === 0,
        'slider value was lost or remapped');
});

test('A different raw UPower step is manual even when it rounds to an outstanding write', () => {
    const {keyboard} = keyboardFixture();
    keyboard._requestWrite(30);
    keyboard._onPowerSignal(59, 'external');
    assert(!keyboard.autoEnabled && keyboard.currentLevel === 30, 'adjacent raw step hid a slider change');
});

test('Own UPower echoes survive rounding on a three-step keyboard', () => {
    const {keyboard} = keyboardFixture(3, 0);
    keyboard._requestWrite(50);
    // The poll can see the rounded level before the D-Bus echo arrives.
    keyboard._onActualLevel(67);
    keyboard._onPowerSignal(2, 'external');
    assert(keyboard.autoEnabled && keyboard.currentLevel === 67, 'quantized echo took manual control');
});

test('Firmware hotkeys can cycle through every distinct step on a coarse UPower keyboard', () => {
    const {keyboard, writes} = keyboardFixture(3, 0);
    for (const [firmware, raw] of [[1, 1], [2, 2], [0, 3], [0, 0]]) {
        keyboard._onPowerSignal(firmware, 'internal');
        keyboard._onPowerSignal(raw, 'external');
    }
    assert(writes.join() === '1,2,3,0', 'the preset cycle got stuck between hardware steps');
});

test('A scaled sysfs hotkey and its internal UPower signal advance only one preset', () => {
    const {keyboard, writes} = keyboardFixture();
    keyboard._file = {
        load_contents_async(_cancel, done) { done(this, {}); },
        load_contents_finish() { return [true, new TextEncoder().encode('150\n')]; },
    };
    keyboard._pollActual();
    keyboard._onPowerSignal(150, 'internal');
    assert(!keyboard.autoEnabled && writes.join() === '150', 'firmware event missed or counted twice');
});

test('A UPower internal signal advances the Fn+Space preset before the next poll', () => {
    const {keyboard, writes} = keyboardFixture();
    keyboard._onPowerSignal(30, 'internal');
    keyboard._onActualLevel(15);
    assert(!keyboard.autoEnabled && writes.join() === '150', 'firmware signal did not select 75%');
});

const {KdeScreenBackend} = await import('../lux-capacitor@extensions/kdeScreenBackend.js');

function screenFixture() {
    const displays = {
        external: {IsInternal: false, Brightness: 75, MaxBrightness: 100},
        panel: {IsInternal: true, Brightness: 4000, MaxBrightness: 10000},
    };
    const writes = [];
    const handlers = new Map();
    const root = {
        owner: ':1.2',
        names: ['external', 'panel'],
        get_name_owner() { return this.owner; },
        call_sync(method, parameters) {
            assert(method === 'org.freedesktop.DBus.Properties.Get' &&
                parameters.deep_unpack().join() === 'org.kde.ScreenBrightness,DisplaysDBusNames',
            'wrong display enumeration');
            return new GLib.Variant('(v)', [new GLib.Variant('as', this.names)]);
        },
        connect(signal, callback) { handlers.set(signal, callback); return signal; },
        disconnect(signal) { assert(handlers.delete(signal), 'unknown signal'); },
    };
    const backend = new KdeScreenBackend(root, (owner, name) => {
        assert(owner === root.owner, 'display proxy belongs to an old PowerDevil');
        return {...displays[name], SetBrightnessWithContextRemote: (...args) =>
            writes.push([name, ...args.slice(0, 3)])};
    });
    const learned = [];
    const targets = [];
    backend.start({onUserChange: () => learned.push(backend.value),
        retarget: () => targets.push(backend.value)});
    function signal(name, signature, args) {
        handlers.get('g-signal')(root, root.owner, name, new GLib.Variant(signature, args));
    }
    function ownerChanged(owner) {
        root.owner = owner;
        handlers.get('notify::g-name-owner')();
    }
    return {root, displays, backend, writes, learned, targets, signal, ownerChanged, handlers};
}

test('PowerDevil selects the internal display and suppresses unchanged rounded writes', () => {
    const {backend, writes} = screenFixture();
    assert(backend.value === 0.4, 'external display selected first');
    backend.setSilently(0.40004);
    backend.setSilently(0.45678);
    assert(JSON.stringify(writes) === JSON.stringify([['panel', 4568, 1, 'lux-capacitor']]),
        'incorrect quiet write');
});

test('A screen fade reaches its target on a display with one-percent hardware steps', () => {
    const {backend, signal, writes} = screenFixture();
    signal('BrightnessRangeChanged', '(sii)', ['panel', 100, 50]);
    const screen = new ScreenController({settings: {}, backend});
    Object.assign(screen, {_autoEnabled: true, _speed: 'normal', _target: 0.4, _level: null});
    for (let tick = 0; tick < 600; tick++) {
        screen._lastTick = GLib.get_monotonic_time() - 100_000;
        const keepGoing = screen._tick();
        if (writes.length) {
            const [name, raw, , context] = writes.pop();
            signal('BrightnessChanged', '(siss)', [name, raw, ':1.4', context]);
        }
        if (!keepGoing)
            break;
    }
    assert(backend.value === 0.4, `fade stalled at ${backend.value}`);
});

test('Only manual brightness changes on the selected display are learned', () => {
    const {backend, learned, signal} = screenFixture();
    signal('BrightnessChanged', '(siss)', ['external', 50, ':1.3', 'slider']);
    signal('BrightnessChanged', '(siss)', ['panel', 6100, ':1.4', 'lux-capacitor']);
    assert(backend.value === 0.61 && !learned.length, 'own or unrelated change was learned');
    signal('BrightnessChanged', '(siss)', ['panel', 5300, ':1.3', '']);
    assert(learned.join() === '0.53', 'manual change learned before updating the value');
});

test('PowerDevil range, hotplug and owner changes retarget the available display', () => {
    const {root, backend, writes, learned, targets, signal, ownerChanged, handlers} = screenFixture();
    signal('BrightnessRangeChanged', '(sii)', ['panel', 20000, 5000]);
    assert(backend.value === 0.25, 'range signal argument order must be name, max, value');
    root.names = ['external'];
    signal('DisplayRemoved', '(s)', ['panel']);
    assert(backend.value === 0.75, 'external fallback');
    root.names = [];
    signal('DisplayRemoved', '(s)', ['external']);
    assert(backend.value === null, 'missing display');
    root.names = ['panel'];
    signal('DisplayAdded', '(s)', ['panel']);
    ownerChanged(null);
    assert(backend.value === null, 'vanished PowerDevil still has a display');
    backend.setSilently(0.9);
    ownerChanged(':1.9');
    assert(backend.value === 0.4 && !writes.length && !learned.length, 'owner restart');
    assert(targets.join() === '0.4,0.25,0.75,,0.4,,0.4', 'missed a retarget');
    backend.stop();
    assert(!handlers.size && backend.value === null, 'screen signals leaked on shutdown');
});

const hasDisplay = ['WAYLAND_DISPLAY', 'DISPLAY', 'BROADWAY_DISPLAY'].some(name => GLib.getenv(name));
if (hasDisplay && (await import('gi://Gtk?version=4.0')).default.init_check()) {
    const {default: Adw} = await import('gi://Adw?version=1');
    const {buildPreferences} = await import('../lux-capacitor@extensions/preferencesPage.js');
    Adw.init();
    test('KDE preferences expose both Auto switches and omit popup and idle controls', () => {
        const settings = Gio.Settings.new('org.gnome.shell.extensions.lux-capacitor');
        const window = new Adw.PreferencesWindow();
        buildPreferences(window, settings, {kde: true});
        function* widgets(parent) {
            yield parent;
            for (let child = parent.get_first_child(); child; child = child.get_next_sibling())
                yield* widgets(child);
        }
        const all = [...widgets(window.visible_page)];
        const groups = all.filter(widget => widget instanceof Adw.PreferencesGroup);
        assert(groups[0].title === 'Auto Brightness', 'Auto group must come first');
        const switches = [...widgets(groups[0])].filter(widget => widget instanceof Adw.SwitchRow);
        assert(switches.map(row => row.title).join() === 'Screen,Keyboard', 'missing Auto switch');
        for (const [index, key] of ['enabled', 'keyboard-auto-enabled'].entries()) {
            settings.set_boolean(key, false);
            assert(!switches[index].active, `settings did not update ${key} switch`);
            switches[index].active = true;
            assert(settings.get_boolean(key), `${key} switch did not update settings`);
        }
        assert(!groups.some(group => group.title === 'Popups'), 'Popups group on KDE');
        assert(!all.some(widget => widget instanceof Adw.PreferencesRow &&
            widget.title === 'Turn off when idle'), 'idle row on KDE');
        settings.set_int('keyboard-idle-timeout', 60);
        all.find(widget => widget instanceof Adw.ButtonRow &&
            widget.title === 'Reset Keyboard Settings').emit('activated');
        assert(settings.get_int('keyboard-idle-timeout') === 60, 'reset changed the hidden idle setting');
        window.close();
    });
} else {
    print('SKIP: KDE preferences widget check (GTK could not open a display)');
}
