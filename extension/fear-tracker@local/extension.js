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

import {FearStore, clamp, pipText} from './state.js';

const GRID_COLUMNS = 7;
const FLASH_MS = 450;

const FearIndicator = GObject.registerClass(
class FearIndicator extends PanelMenu.Button {
    /**
     * @param {object} actions - {step(delta), set(value), reset(), openPrefs()}
     */
    _init(actions) {
        super._init(0.5, 'Fear Tracker');
        this._actions = actions;
        this._flashId = 0;
        this._gridMax = -1;

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
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
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

        const controls = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
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

        const gridItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._grid = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'fear-tracker-grid',
        });
        gridItem.add_child(this._grid);
        this.menu.addMenuItem(gridItem);
        this._numberButtons = [];

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Preferences', () => this._actions.openPrefs());
    }

    _makeButton(content, accessibleName, onClick) {
        const button = new St.Button({
            style_class: 'button fear-tracker-button',
            can_focus: true,
            x_expand: true,
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

    update(fear, max) {
        this._label.text = `Fear ${fear}`;
        this._title.text = `Fear ${fear} / ${max}`;
        this._pips.text = pipText(fear, max);
        if (max !== this._gridMax)
            this._rebuildGrid(max);
        this._numberButtons.forEach((button, value) => {
            button.checked = value === fear;
        });
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
        this._osdIcon = Gio.FileIcon.new(
            this.dir.get_child('icons').get_child('fear-symbolic.svg'));

        this._indicator = new FearIndicator({
            step: delta => this._step(delta, false),
            set: value => this._set(value, false),
            reset: () => this._set(0, false),
            openPrefs: () => this.openPreferences(),
        });
        this._indicator.update(this._fear, this._max);
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
    _adopt({fear, max}) {
        this._max = max;
        this._fear = clamp(fear, 0, max);
        if (this._settings.get_int('max-fear') !== max)
            this._settings.set_int('max-fear', max);
        this._indicator.update(this._fear, this._max);
    }

    _step(delta, fromShortcut) {
        this._set(this._fear + delta, fromShortcut);
    }

    _set(value, fromShortcut) {
        this._apply(value, this._max, fromShortcut);
    }

    _apply(fear, max, fromShortcut) {
        this._max = max;
        this._fear = clamp(fear, 0, max);
        this._indicator.update(this._fear, this._max);
        this._store.save(this._fear, this._max);

        if (fromShortcut) {
            this._indicator.flash();
            if (this._settings.get_boolean('show-osd')) {
                Main.osdWindowManager.showAll(this._osdIcon,
                    `Fear ${this._fear} / ${this._max}`, this._fear / this._max, 1);
            }
        }
    }
}
