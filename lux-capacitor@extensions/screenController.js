// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    BATTERY_DIM_FACTOR,
    advanceBrightness,
    parseAnchors,
    preferredBrightness,
    significantLuxChange,
    upsertPreference,
} from './brightnessModel.js';
import {removeSource} from './keyboardController.js';

const SENSOR_XML = `
<node>
  <interface name="net.hadess.SensorProxy">
    <method name="ClaimLight"/>
    <method name="ReleaseLight"/>
    <property name="HasAmbientLight" type="b" access="read"/>
    <property name="LightLevel" type="d" access="read"/>
    <property name="LightLevelUnit" type="s" access="read"/>
  </interface>
</node>`;
const SensorProxy = Gio.DBusProxy.makeProxyWrapper(SENSOR_XML);

const UPOWER_XML = `
<node>
  <interface name="org.freedesktop.UPower">
    <property name="OnBattery" type="b" access="read"/>
    <property name="LidIsClosed" type="b" access="read"/>
    <property name="LidIsPresent" type="b" access="read"/>
  </interface>
</node>`;
const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(UPOWER_XML);
const SCREEN_OPTION_KEYS = ['transition-speed', 'light-sensitivity',
    'screen-min-brightness', 'screen-max-brightness', 'dim-on-battery'];

const TICK_MS = 100;
const MANUAL_HOLD_US = 1_500_000;
export const BRIGHTNESS_EPSILON = 0.003;
const SAVE_DELAY_MS = 500;

// backend.value is 0..1, or null while unavailable. The desktop calls
// onUserChange() for manual changes only.
export class ScreenController {
    constructor({settings, backend, keyboard = null, onStateChanged = () => {}}) {
        this._settings = settings;
        this._backend = backend;
        this._keyboard = keyboard;
        this._onStateChanged = onStateChanged;
        this._destroyed = true;
        this._sensorGeneration = 0;
    }

    get autoEnabled() {
        return this._autoEnabled;
    }

    start() {
        if (!this._destroyed)
            return;
        this._destroyed = false;
        this._anchors = this._loadAnchors();
        this._anchorUnit = this._settings.get_string('anchor-unit');
        this._saveAnchorsId = 0;
        this._autoEnabled = this._settings.get_boolean('enabled');
        this._lux = null;
        this._targetLux = null;
        this._unit = null;
        this._target = null;
        this._level = null;
        this._holdUntil = 0;
        this._lastTick = 0;
        this._timerId = 0;
        this._sensorRetryId = 0;
        this._claimRetryId = 0;
        this._sensor = null;
        this._cancellable = new Gio.Cancellable();
        this._sensorClaimed = false;
        this._claimPending = false;
        this._sensorGeneration++;
        this._lastKeyboardAuto = this._keyboard?.autoEnabled ?? false;
        this._onBattery = false;
        this._lidClosed = false;
        this._upower = null;
        this._writingAnchors = false;
        this._readScreenOptions();

        this._settingsIds = [
            this._settings.connect('changed::enabled', () => this._onEnabledChanged()),
            this._settings.connect('changed::anchors', () => this._onAnchorsChanged()),
            ...SCREEN_OPTION_KEYS.map(key =>
                this._settings.connect(`changed::${key}`, () => this._onScreenOptionsChanged())),
        ];
        this._connectSensor();
        this._connectUPower();
    }

    stop() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._stopTimer();
        // Disable runs on logout, so write a pending preference now.
        if (this._saveAnchorsId) {
            this._saveAnchorsId = removeSource(this._saveAnchorsId);
            this._saveAnchors();
        }
        this._sensorRetryId = removeSource(this._sensorRetryId);
        this._claimRetryId = removeSource(this._claimRetryId);
        this._releaseSensor();
        this._cancellable?.cancel();

        if (this._sensor) {
            this._sensor.disconnect(this._sensorPropertiesId);
            this._sensor.disconnect(this._sensorOwnerId);
            this._sensor = null;
        }
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        if (this._upower) {
            this._upower.disconnect(this._powerChangedId);
            this._upower = null;
        }
        this._cancellable = null;
        this._lux = null;
    }

    onUserChange() {
        if (this._destroyed || !this._autoEnabled || this._lux === null)
            return;
        const value = this._backend.value;
        if (!Number.isFinite(value))
            return;

        // Store the undimmed preference so battery dimming stays a small,
        // separate adjustment on top of what the user chose.
        this._anchors = upsertPreference(this._anchors, this._lux,
            Math.min(1, value / this._batteryFactor()));
        this._anchorUnit = this._unit ?? '';
        this._scheduleAnchorSave();
        this._targetLux = this._lux;
        this._target = value;
        this._holdUntil = GLib.get_monotonic_time() + MANUAL_HOLD_US;
        this._stopTimer();
    }

    retarget() {
        if (this._autoEnabled && this._lux !== null)
            this._retarget(this._lux);
    }

    _onEnabledChanged() {
        const enabled = this._settings.get_boolean('enabled');
        if (enabled === this._autoEnabled)
            return;
        this._autoEnabled = enabled;

        // Turning Auto off or on resets learned preferences to the default curve.
        this._clearAnchors();
        this._targetLux = null;
        this._target = null;
        this._holdUntil = 0;
        this._stopTimer();

        if (enabled) {
            if (this._sensorClaimed)
                this._readLux();
            else
                this._claimSensor();
        } else {
            this._updateSensorClaim();
        }
        this._onStateChanged();
    }

    onKeyboardChanged() {
        if (this._destroyed)
            return;
        const autoEnabled = this._keyboard?.autoEnabled ?? false;
        const resumedAuto = autoEnabled && !this._lastKeyboardAuto;
        this._lastKeyboardAuto = autoEnabled;
        this._updateSensorClaim();
        if (resumedAuto && this._sensorClaimed)
            this._readLux();
    }

    _sensorDesired() {
        return !this._lidClosed && (this._autoEnabled || !!this._keyboard?.autoEnabled);
    }

    _updateSensorClaim() {
        if (this._sensorDesired()) {
            this._claimSensor();
        } else {
            this._releaseSensor();
            this._claimRetryId = removeSource(this._claimRetryId);
        }
    }

    _loadAnchors() {
        // Earlier versions could store contradicting preferences.
        return parseAnchors(this._settings.get_string('anchors'));
    }

    _scheduleAnchorSave() {
        // A slider drag emits many updates; write the settled preference once.
        removeSource(this._saveAnchorsId);
        this._saveAnchorsId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS,
            () => {
                this._saveAnchorsId = 0;
                this._saveAnchors();
                return GLib.SOURCE_REMOVE;
            });
    }

    _saveAnchors() {
        this._writingAnchors = true;
        try {
            this._settings.set_string('anchors', JSON.stringify(this._anchors));
            this._settings.set_string('anchor-unit', this._anchorUnit);
        } finally {
            this._writingAnchors = false;
        }
    }

    _onAnchorsChanged() {
        // The preferences window resets learned brightness through settings.
        if (this._writingAnchors)
            return;
        this._saveAnchorsId = removeSource(this._saveAnchorsId);
        this._anchors = this._loadAnchors();
        this._anchorUnit = this._settings.get_string('anchor-unit');
        this._retargetNow();
    }

    _readScreenOptions() {
        this._speed = this._settings.get_string('transition-speed');
        this._sensitivity = this._settings.get_string('light-sensitivity');
        this._limits = {
            min: this._settings.get_int('screen-min-brightness') / 100,
            max: this._settings.get_int('screen-max-brightness') / 100,
        };
        this._dimOnBattery = this._settings.get_boolean('dim-on-battery');
    }

    _onScreenOptionsChanged() {
        this._readScreenOptions();
        this._retargetNow();
    }

    _retargetNow() {
        this._targetLux = null;
        this.retarget();
    }

    _batteryFactor() {
        return this._dimOnBattery && this._onBattery ? BATTERY_DIM_FACTOR : 1;
    }

    _connectUPower() {
        const cancellable = this._cancellable;
        new UPowerProxy(Gio.DBus.system, 'org.freedesktop.UPower',
            '/org/freedesktop/UPower', (proxy, error) => {
                // A request cancelled by stop() can finish after a quick
                // re-enable; it belongs to the previous session.
                if (this._destroyed || cancellable !== this._cancellable)
                    return;
                if (error) {
                    console.error(`Lux Capacitor: power status unavailable: ${error}`);
                    return;
                }
                this._upower = proxy;
                this._powerChangedId = proxy.connect('g-properties-changed',
                    () => this._onPowerChanged());
                this._onPowerChanged();
            }, cancellable);
    }

    _onPowerChanged() {
        const lidClosed = !!this._upower?.LidIsPresent && !!this._upower?.LidIsClosed;
        if (lidClosed !== this._lidClosed) {
            this._lidClosed = lidClosed;
            this._onLidChanged();
        }
        const onBattery = !!this._upower?.OnBattery;
        if (onBattery === this._onBattery)
            return;
        this._onBattery = onBattery;
        if (this._dimOnBattery)
            this._retargetNow();
    }

    // A closed lid covers the light sensor, which then reads darkness, and
    // hides the built-in screen and keyboard. Docked laptops keep running
    // like this, so release the sensor and turn the keyboard light off until
    // the lid opens; the reopened sensor's first reading retargets both.
    _onLidChanged() {
        this._keyboard?.setLidClosed(this._lidClosed);
        if (this._lidClosed) {
            this._stopTimer();
            this._lux = null;
        }
        this._targetLux = null;
        this._updateSensorClaim();
        this._onStateChanged();
    }

    _clearAnchors() {
        this._saveAnchorsId = removeSource(this._saveAnchorsId);
        this._anchors = [];
        this._anchorUnit = '';
        this._saveAnchors();
    }

    _connectSensor() {
        const cancellable = this._cancellable;
        new SensorProxy(Gio.DBus.system, 'net.hadess.SensorProxy',
            '/net/hadess/SensorProxy', (proxy, error) => {
                if (this._destroyed || cancellable !== this._cancellable)
                    return;
                if (error) {
                    console.error(`Lux Capacitor: light sensor unavailable: ${error}`);
                    this._onStateChanged();
                    this._sensorRetryId = GLib.timeout_add_seconds(
                        GLib.PRIORITY_DEFAULT, 15, () => {
                            this._sensorRetryId = 0;
                            this._connectSensor();
                            return GLib.SOURCE_REMOVE;
                        });
                    return;
                }

                this._sensor = proxy;
                this._sensorPropertiesId = proxy.connect('g-properties-changed',
                    () => this._onSensorPropertiesChanged());
                this._sensorOwnerId = proxy.connect('notify::g-name-owner',
                    () => this._onSensorOwnerChanged());
                this._onStateChanged();
                if (this._sensorDesired())
                    this._claimSensor();
            }, cancellable);
    }

    _onSensorOwnerChanged() {
        this._sensorGeneration++;
        this._claimPending = false;
        this._sensorClaimed = false;
        this._lux = null;
        this._targetLux = null;
        this._stopTimer();
        if (this._sensor?.get_name_owner() && this._sensorDesired())
            this._claimSensor();
        this._onStateChanged();
    }

    _onSensorPropertiesChanged() {
        if (this._sensorDesired() && !this._sensorClaimed && !this._claimPending)
            this._claimSensor();
        if (this._sensorClaimed)
            this._readLux();
        this._onStateChanged();
    }

    _claimSensor() {
        if (!this._sensorDesired() || !this._sensor?.HasAmbientLight ||
            !this._sensor.get_name_owner() || this._sensorClaimed ||
            this._claimPending || this._claimRetryId)
            return;
        this._claimPending = true;
        const proxy = this._sensor;
        const generation = this._sensorGeneration;
        proxy.ClaimLightRemote((_result, error) => {
            if (generation !== this._sensorGeneration)
                return;
            this._claimPending = false;
            if (error) {
                if (!this._destroyed)
                    console.error(`Lux Capacitor: could not claim light sensor: ${error}`);
                if (!this._destroyed && this._sensorDesired() && !this._claimRetryId) {
                    this._claimRetryId = GLib.timeout_add_seconds(
                        GLib.PRIORITY_DEFAULT, 15, () => {
                            this._claimRetryId = 0;
                            this._claimSensor();
                            return GLib.SOURCE_REMOVE;
                        });
                }
                this._onStateChanged();
                return;
            }
            if (this._destroyed || !this._sensorDesired()) {
                // A ClaimLight response can arrive after the toggle or the
                // extension has been turned off. Release that exact claim.
                proxy.ReleaseLightRemote(() => {});
                return;
            }
            this._sensorClaimed = true;
            this._readLux();
            this._onStateChanged();
        });
    }

    _releaseSensor() {
        if (!this._sensorClaimed || !this._sensor)
            return;
        this._sensorClaimed = false;
        this._sensor.ReleaseLightRemote((_result, error) => {
            if (error && !this._destroyed)
                console.error(`Lux Capacitor: could not release light sensor: ${error}`);
        });
        this._onStateChanged();
    }

    _readLux() {
        if (!this._sensorClaimed || !this._sensorDesired())
            return;
        const rawLevel = this._sensor.LightLevel;
        const unit = this._sensor.LightLevelUnit;
        if (!Number.isFinite(rawLevel) || rawLevel < 0 ||
            !['lux', 'vendor'].includes(unit))
            return;

        if (this._anchorUnit && this._anchorUnit !== unit) {
            this._clearAnchors();
            this._targetLux = null;
        }
        this._unit = unit;
        // SensorProxy's vendor unit is a relative 0-100 reading. Map it to
        // the curve's 0-1600 range.
        const lux = unit === 'vendor' ? rawLevel * 16 : rawLevel;
        this._lux = lux;
        // Small sensor fluctuations should not keep nudging the screen.
        if (this._autoEnabled && significantLuxChange(this._targetLux, lux, this._sensitivity))
            this._retarget(lux);
        this._keyboard?.onSensorLevel(lux);
        this._onStateChanged();
    }

    _retarget(lux) {
        this._targetLux = lux;
        this._setTarget(preferredBrightness(lux, this._anchors, this._limits) *
            this._batteryFactor());
    }

    _setTarget(target) {
        if (!this._autoEnabled || !Number.isFinite(target))
            return;
        this._target = target;
        if (!this._timerId) {
            this._level = null;
            this._lastTick = GLib.get_monotonic_time();
            this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS,
                () => this._tick());
        }
    }

    _tick() {
        const shown = this._backend.value;
        if (!this._autoEnabled || shown === null || this._target === null) {
            this._timerId = 0;
            return GLib.SOURCE_REMOVE;
        }
        const now = GLib.get_monotonic_time();
        const dt = Math.min((now - this._lastTick) / 1_000_000, 1);
        this._lastTick = now;
        if (now < this._holdUntil)
            return GLib.SOURCE_CONTINUE;

        // The backend can skip small writes. Continue from the fade's own
        // position so it won't repeat the same skipped step forever. Start
        // again from the displayed level if something else has moved it.
        // Hardware with discrete levels can also round a fade step back to shown.
        const tolerance = Math.max(BRIGHTNESS_EPSILON, this._backend.stepSize ?? 0);
        const current = this._level !== null && Math.abs(this._level - shown) < tolerance
            ? this._level : shown;
        let next = advanceBrightness(current, this._target, dt, this._speed);
        const done = Math.abs(next - this._target) <= BRIGHTNESS_EPSILON;
        if (done)
            next = this._target;
        this._level = next;
        this._backend.setSilently(next);
        if (done) {
            this._timerId = 0;
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }

    _stopTimer() {
        this._timerId = removeSource(this._timerId);
    }
}
