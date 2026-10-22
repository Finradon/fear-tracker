import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    COUNTDOWN_LIMIT, FearStore, MAX_COUNTDOWNS, NAME_LIMIT, clamp, pipText,
} from './state.js';

const GRID_COLUMNS = 7;
const FLASH_MS = 450;
const DEFAULT_COUNTDOWN_START = 6;

// A menu row that only hosts its own widgets: clicking it does nothing. It
// stays reactive because St styles non-reactive widgets as :insensitive,
// which dims all of their text.
function contentItem() {
    const item = new PopupMenu.PopupBaseMenuItem({activate: false, hover: false, can_focus: false});
    item.track_hover = false;
    return item;
}

const FearIndicator = GObject.registerClass(
class FearIndicator extends PanelMenu.Button {
    /**
     * @param {object} actions - {step(delta), set(value), reset(), openPrefs(),
     *   addCountdown(name, start, kind), stepCountdown(id, delta), removeCountdown(id)}
     */
    _init(actions) {
        super._init(0.5, 'Fear Tracker');
        this._actions = actions;
        this._flashId = 0;
        this._rowsIdleId = 0;
        this._gridMax = -1;
        this._countdowns = [];
        this._countdownKey = null;
        this._countdownRows = new Map();
        this._addStart = DEFAULT_COUNTDOWN_START;

        this._label = new St.Label({
            text: 'Fear –',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'fear-tracker-label',
        });
        this.add_child(this._label);

        this._buildMenu();
        this.connect('destroy', () => this._onIndicatorDestroy());
    }

    _buildMenu() {
        const header = contentItem();
        const headerBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._title = new St.Label({style_class: 'fear-tracker-title'});
        this._pips = new St.Label({style_class: 'fear-tracker-pips'});
        headerBox.add_child(this._title);
        headerBox.add_child(this._pips);
        header.add_child(headerBox);
        this.menu.addMenuItem(header);

        const controls = contentItem();
        const controlBox = new St.BoxLayout({x_expand: true, style_class: 'fear-tracker-controls'});
        controlBox.add_child(this._makeButton({icon_name: 'list-remove-symbolic'},
            'Decrease Fear', () => this._actions.step(-1)));
        controlBox.add_child(this._makeButton({icon_name: 'list-add-symbolic'},
            'Increase Fear', () => this._actions.step(1)));
        controlBox.add_child(this._makeButton({label: 'Reset'},
            'Reset Fear to 0', () => this._actions.reset()));
        controls.add_child(controlBox);
        this.menu.addMenuItem(controls);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Set value'));

        const gridItem = contentItem();
        this._grid = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'fear-tracker-grid',
        });
        gridItem.add_child(this._grid);
        this.menu.addMenuItem(gridItem);
        this._numberButtons = [];

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Countdowns'));
        this._countdownSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._countdownSection);
        this._buildAddForm();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Preferences', () => this._actions.openPrefs());
    }

    _buildAddForm() {
        this._addItem = contentItem();
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'fear-tracker-add',
        });

        this._nameEntry = new St.Entry({
            hint_text: 'New countdown name',
            can_focus: true,
            x_expand: true,
            style_class: 'fear-tracker-entry',
        });
        this._nameEntry.clutter_text.set_max_length(NAME_LIMIT);
        this._nameEntry.clutter_text.connect('activate', () => this._submitCountdown());
        box.add_child(this._nameEntry);

        const row = new St.BoxLayout({x_expand: true, style_class: 'fear-tracker-add-row'});
        row.add_child(new St.Label({text: 'Start', y_align: Clutter.ActorAlign.CENTER}));
        this._startLabel = new St.Label({
            text: `${this._addStart}`,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'fear-tracker-start',
        });
        row.add_child(this._makeButton({icon_name: 'list-remove-symbolic'}, 'Lower start value',
            () => this._changeStart(-1), 'fear-tracker-small'));
        row.add_child(this._startLabel);
        row.add_child(this._makeButton({icon_name: 'list-add-symbolic'}, 'Raise start value',
            () => this._changeStart(1), 'fear-tracker-small'));

        this._kindButton = new St.Button({
            style_class: 'button fear-tracker-kind',
            label: 'Consequence',
            toggle_mode: true,
            can_focus: true,
            x_expand: true,
            accessible_name: 'Countdown type',
        });
        this._kindButton.connect('notify::checked', () => {
            this._kindButton.label = this._kindButton.checked ? 'Progress' : 'Consequence';
        });
        row.add_child(this._kindButton);
        row.add_child(this._makeButton({label: 'Add'}, 'Add countdown',
            () => this._submitCountdown(), 'fear-tracker-small'));
        box.add_child(row);

        this._addItem.add_child(box);
        this.menu.addMenuItem(this._addItem);

        this._fullItem = new PopupMenu.PopupMenuItem(
            `${MAX_COUNTDOWNS} countdowns active; delete one to add another`,
            {reactive: false, can_focus: false});
        this._fullItem.add_style_class_name('fear-tracker-note');
        this.menu.addMenuItem(this._fullItem);
    }

    _changeStart(delta) {
        this._addStart = clamp(this._addStart + delta, 1, COUNTDOWN_LIMIT);
        this._startLabel.text = `${this._addStart}`;
    }

    _submitCountdown() {
        if (this._countdowns.length >= MAX_COUNTDOWNS)
            return;
        const kind = this._kindButton.checked ? 'progress' : 'consequence';
        this._actions.addCountdown(this._nameEntry.get_text().trim(), this._addStart, kind);
        this._nameEntry.set_text('');
    }

    _makeButton(content, accessibleName, onClick, extraClass = 'fear-tracker-button') {
        const button = new St.Button({
            style_class: `button ${extraClass}`,
            can_focus: true,
            x_expand: extraClass === 'fear-tracker-button',
            accessible_name: accessibleName,
        });
        if (content.icon_name)
            button.child = new St.Icon({icon_name: content.icon_name, icon_size: 16});
        else
            button.label = content.label;
        button.connect('clicked', onClick);
        return button;
    }

    _rebuildGrid(max) {
        this._grid.destroy_all_children();
        this._numberButtons = [];
        let row = null;
        for (let value = 0; value <= max; value++) {
            if (value % GRID_COLUMNS === 0) {
                row = new St.BoxLayout({style_class: 'fear-tracker-grid-row'});
                this._grid.add_child(row);
            }
            const button = new St.Button({
                style_class: 'button fear-tracker-number',
                label: `${value}`,
                can_focus: true,
                accessible_name: `Set Fear to ${value}`,
            });
            button.connect('clicked', () => this._actions.set(value));
            row.add_child(button);
            this._numberButtons.push(button);
        }
        this._gridMax = max;
    }

    update(fear, max, countdowns) {
        this._label.text = `Fear ${fear}`;
        this._title.text = `Fear ${fear} / ${max}`;
        this._pips.text = pipText(fear, max);
        if (max !== this._gridMax)
            this._rebuildGrid(max);
        this._numberButtons.forEach((button, value) => {
            button.checked = value === fear;
        });
        this._updateCountdowns(countdowns);
    }

    _updateCountdowns(countdowns) {
        this._countdowns = countdowns;
        const full = countdowns.length >= MAX_COUNTDOWNS;
        this._addItem.visible = !full;
        this._fullItem.visible = full;

        const key = countdowns.map(c => c.id).join();
        if (key === this._countdownKey) {
            this._refreshCountdownRows();
            return;
        }
        // Rebuild later: this may run inside the clicked handler of a row's
        // delete button, which must not be destroyed during its own signal.
        this._countdownKey = key;
        if (!this._rowsIdleId) {
            this._rowsIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._rowsIdleId = 0;
                this._rebuildCountdownRows();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _rebuildCountdownRows() {
        this._countdownSection.removeAll();
        this._countdownRows.clear();
        if (this._countdowns.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('No countdowns', {reactive: false, can_focus: false});
            empty.add_style_class_name('fear-tracker-note');
            this._countdownSection.addMenuItem(empty);
        }
        for (const {id} of this._countdowns) {
            const item = contentItem();
            const box = new St.BoxLayout({x_expand: true, style_class: 'fear-tracker-cd-row'});
            const name = new St.Label({
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'fear-tracker-cd-name',
            });
            const value = new St.Label({
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'fear-tracker-cd-value',
            });
            box.add_child(name);
            box.add_child(value);
            box.add_child(this._makeButton({icon_name: 'list-remove-symbolic'}, 'Tick down',
                () => this._actions.stepCountdown(id, -1), 'fear-tracker-small'));
            box.add_child(this._makeButton({icon_name: 'list-add-symbolic'}, 'Tick up',
                () => this._actions.stepCountdown(id, 1), 'fear-tracker-small'));
            box.add_child(this._makeButton({icon_name: 'window-close-symbolic'}, 'Delete countdown',
                () => this._actions.removeCountdown(id), 'fear-tracker-small'));
            item.add_child(box);
            this._countdownSection.addMenuItem(item);
            this._countdownRows.set(id, {name, value});
        }
        this._refreshCountdownRows();
    }

    _refreshCountdownRows() {
        for (const c of this._countdowns) {
            const row = this._countdownRows.get(c.id);
            if (!row)
                continue;
            row.name.text = c.name || 'Countdown';
            row.value.text = `${c.value} / ${c.start}`;
            row.value.style_class = `fear-tracker-cd-value ${c.kind}${c.value === 0 ? ' triggered' : ''}`;
        }
    }

    flash() {
        this._label.add_style_class_name('fear-tracker-flash');
        if (this._flashId)
            GLib.source_remove(this._flashId);
        this._flashId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FLASH_MS, () => {
            this._flashId = 0;
            this._label.remove_style_class_name('fear-tracker-flash');
            return GLib.SOURCE_REMOVE;
        });
    }

    _onIndicatorDestroy() {
        if (this._flashId) {
            GLib.source_remove(this._flashId);
            this._flashId = 0;
        }
        if (this._rowsIdleId) {
            GLib.source_remove(this._rowsIdleId);
            this._rowsIdleId = 0;
        }
        this._actions = null;
    }
});

const KEYBINDINGS = {
    'increment-fear': ext => ext._step(1, true),
    'decrement-fear': ext => ext._step(-1, true),
    'reset-fear': ext => ext._set(0, true),
};

export default class FearTrackerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._max = this._settings.get_int('max-fear');
        this._fear = 0;
        this._countdowns = [];
        this._osdIcon = Gio.FileIcon.new(
            this.dir.get_child('icons').get_child('fear-symbolic.svg'));

        this._indicator = new FearIndicator({
            step: delta => this._step(delta, false),
            set: value => this._set(value, false),
            reset: () => this._set(0, false),
            openPrefs: () => this.openPreferences(),
            addCountdown: (name, start, kind) => this._addCountdown(name, start, kind),
            stepCountdown: (id, delta) => this._stepCountdown(id, delta),
            removeCountdown: id => this._removeCountdown(id),
        });
        this._indicator.update(this._fear, this._max, this._countdowns);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._store = new FearStore(state => this._adopt(state));
        this._settingsChangedId = this._settings.connect('changed::max-fear', () => {
            const max = this._settings.get_int('max-fear');
            if (max !== this._max)
                this._apply(this._fear, max, false);
        });

        for (const [name, handler] of Object.entries(KEYBINDINGS)) {
            Main.wm.addKeybinding(name, this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => handler(this));
        }

        this._loadInitial().catch(logError);
    }

    disable() {
        for (const name of Object.keys(KEYBINDINGS))
            Main.wm.removeKeybinding(name);

        this._settings.disconnect(this._settingsChangedId);
        this._store.destroy();
        this._indicator.destroy();

        this._settings = null;
        this._store = null;
        this._indicator = null;
        this._osdIcon = null;
    }

    async _loadInitial() {
        const store = this._store;
        const state = await store.load();
        // The extension may have been disabled while we were reading.
        if (store !== this._store)
            return;
        if (state)
            this._adopt(state);
        else
            this._apply(this._fear, this._max, false);
    }

    // State written by someone else (or the persisted state at startup):
    // take it over, including max, without writing it back.
    _adopt({fear, max, countdowns}) {
        this._max = max;
        this._fear = clamp(fear, 0, max);
        this._countdowns = countdowns;
        if (this._settings.get_int('max-fear') !== max)
            this._settings.set_int('max-fear', max);
        this._indicator.update(this._fear, this._max, this._countdowns);
    }

    _step(delta, fromShortcut) {
        this._set(this._fear + delta, fromShortcut);
    }

    _set(value, fromShortcut) {
        this._apply(value, this._max, fromShortcut);
    }

    _addCountdown(name, start, kind) {
        if (this._countdowns.length >= MAX_COUNTDOWNS)
            return;
        start = clamp(start, 1, COUNTDOWN_LIMIT);
        const id = GLib.uuid_string_random().slice(0, 8);
        this._countdowns = [...this._countdowns,
            {id, name: name.slice(0, NAME_LIMIT), start, value: start, kind}];
        this._apply(this._fear, this._max, false);
    }

    _stepCountdown(id, delta) {
        this._countdowns = this._countdowns.map(c =>
            c.id === id ? {...c, value: clamp(c.value + delta, 0, c.start)} : c);
        this._apply(this._fear, this._max, false);
    }

    _removeCountdown(id) {
        this._countdowns = this._countdowns.filter(c => c.id !== id);
        this._apply(this._fear, this._max, false);
    }

    _apply(fear, max, fromShortcut) {
        this._max = max;
        this._fear = clamp(fear, 0, max);
        this._indicator.update(this._fear, this._max, this._countdowns);
        this._store.save({fear: this._fear, max: this._max, countdowns: this._countdowns});

        if (fromShortcut) {
            this._indicator.flash();
            if (this._settings.get_boolean('show-osd')) {
                Main.osdWindowManager.showAll(this._osdIcon,
                    `Fear ${this._fear} / ${this._max}`, this._fear / this._max, 1);
            }
        }
    }
}
