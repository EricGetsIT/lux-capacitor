// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const NAME = 'org.kde.ScreenBrightness';
const PATH = '/org/kde/ScreenBrightness';
const CONTEXT = 'lux-capacitor';
const SUPPRESS_INDICATOR = 1;

const ScreenProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="${NAME}">
    <property name="DisplaysDBusNames" type="as" access="read"/>
    <signal name="BrightnessChanged">
      <arg name="displayName" type="s"/>
      <arg name="value" type="i"/>
      <arg name="sourceClientName" type="s"/>
      <arg name="sourceClientContext" type="s"/>
    </signal>
    <signal name="BrightnessRangeChanged">
      <arg name="displayName" type="s"/>
      <arg name="max" type="i"/>
      <arg name="value" type="i"/>
    </signal>
    <signal name="DisplayAdded"><arg name="displayName" type="s"/></signal>
    <signal name="DisplayRemoved"><arg name="displayName" type="s"/></signal>
  </interface>
</node>`);

const DisplayProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="${NAME}.Display">
    <property name="Brightness" type="i" access="read"/>
    <property name="MaxBrightness" type="i" access="read"/>
    <property name="IsInternal" type="b" access="read"/>
    <property name="Label" type="s" access="read"/>
    <method name="SetBrightness">
      <arg name="brightness" type="i" direction="in"/>
      <arg name="flags" type="u" direction="in"/>
    </method>
    <method name="SetBrightnessWithContext">
      <arg name="brightness" type="i" direction="in"/>
      <arg name="flags" type="u" direction="in"/>
      <arg name="context" type="s" direction="in"/>
    </method>
  </interface>
</node>`);

export function pickDisplay(displays) {
    return displays.find(display => display.proxy.IsInternal) ?? displays[0] ?? null;
}

export function isUserChange(context) {
    return context !== CONTEXT;
}

export class KdeScreenBackend {
    constructor(root = new ScreenProxy(Gio.DBus.session, NAME, PATH),
        makeDisplay = (owner, name) => new DisplayProxy(Gio.DBus.session, owner, `${PATH}/${name}`)) {
        this._root = root;
        this._makeDisplay = makeDisplay;
        this._display = null;
    }

    get value() {
        return this._display && this._max > 0 ? this._brightness / this._max : null;
    }

    get stepSize() {
        return this._display && this._max > 0 ? 1 / this._max : 0;
    }

    start(screen) {
        this._screen = screen;
        this._ownerId = this._root.connect('notify::g-name-owner', () => this._refresh());
        this._signalId = this._root.connect('g-signal', (_proxy, _sender, signal, parameters) => {
            if (signal === 'BrightnessChanged') {
                const [name, value, , context] = parameters.deep_unpack();
                if (name !== this._display?.name)
                    return;
                this._brightness = value;
                if (isUserChange(context))
                    screen.onUserChange();
            } else if (signal === 'BrightnessRangeChanged') {
                this._refresh(...parameters.deep_unpack());
            } else if (signal === 'DisplayAdded' || signal === 'DisplayRemoved') {
                this._refresh();
            }
        });
        this._refresh();
    }

    _refresh(rangeName, max, brightness) {
        const owner = this._root.get_name_owner();
        this._display = null;
        if (owner) {
            try {
                // Hotplug signals can precede the root proxy's property-cache update.
                const [names] = this._root.call_sync('org.freedesktop.DBus.Properties.Get',
                    new GLib.Variant('(ss)', [NAME, 'DisplaysDBusNames']),
                    Gio.DBusCallFlags.NONE, -1, null).deep_unpack();
                const displays = names.deep_unpack().map(name =>
                    ({name, proxy: this._makeDisplay(owner, name)}));
                this._display = pickDisplay(displays.filter(({proxy}) =>
                    proxy.MaxBrightness > 0 && Number.isInteger(proxy.Brightness)));
                if (this._display) {
                    const rangeChanged = this._display.name === rangeName;
                    this._max = rangeChanged ? max : this._display.proxy.MaxBrightness;
                    this._brightness = rangeChanged ? brightness : this._display.proxy.Brightness;
                }
            } catch (error) {
                console.warn(`Lux Capacitor: screen brightness unavailable: ${error}`);
            }
        }
        this._screen.retarget();
    }

    setSilently(value) {
        if (this.value === null)
            return;
        const raw = Math.round(value * this._max);
        if (raw !== this._brightness) {
            this._display.proxy.SetBrightnessWithContextRemote(raw, SUPPRESS_INDICATOR, CONTEXT,
                (_result, error) => {
                    if (error)
                        console.warn(`Lux Capacitor: screen brightness write failed: ${error}`);
                });
        }
    }

    stop() {
        this._root.disconnect(this._signalId);
        this._root.disconnect(this._ownerId);
        this._display = null;
        this._screen = null;
    }
}
