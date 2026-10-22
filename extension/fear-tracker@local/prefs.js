import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SHORTCUTS = [
    ['increment-fear', 'Increase Fear'],
    ['decrement-fear', 'Decrease Fear'],
    ['reset-fear', 'Reset Fear'],
];

function isFunctionKey(keyval) {
    return keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35;
}

export default class FearTrackerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keep a reference so the settings object lives as long as the window.
        window._settings = settings;
        window.set_default_size(560, 620);

        const page = new Adw.PreferencesPage({
            title: 'Fear Tracker',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const fearGroup = new Adw.PreferencesGroup({title: 'Fear'});
        page.add(fearGroup);

        const maxRow = Adw.SpinRow.new_with_range(1, 30, 1);
        maxRow.title = 'Maximum Fear';
        maxRow.subtitle = 'Daggerheart default is 12';
        settings.bind('max-fear', maxRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        fearGroup.add(maxRow);

        const osdRow = new Adw.SwitchRow({
            title: 'On-screen popup',
            subtitle: 'Briefly show the new value when a shortcut is used',
        });
        settings.bind('show-osd', osdRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        fearGroup.add(osdRow);

        const keysGroup = new Adw.PreferencesGroup({
            title: 'Keyboard Shortcuts',
            description: 'Click a row and press the new key combination',
        });
        page.add(keysGroup);
        for (const [key, title] of SHORTCUTS)
            keysGroup.add(this._shortcutRow(window, settings, key, title));

        const filesGroup = new Adw.PreferencesGroup({title: 'Output'});
        page.add(filesGroup);
        filesGroup.add(new Adw.ActionRow({
            title: 'State files',
            subtitle: GLib.build_filenamev([GLib.get_user_config_dir(), 'fear-tracker']),
            subtitle_selectable: true,
        }));
        filesGroup.add(new Adw.ActionRow({
            title: 'Overlay URL',
            subtitle: 'http://127.0.0.1:8765/overlay.html (default port, server must be running)',
            subtitle_selectable: true,
        }));
    }

    _shortcutRow(window, settings, key, title) {
        const row = new Adw.ActionRow({title, activatable: true});

        const label = new Gtk.ShortcutLabel({
            disabled_text: 'Disabled',
            valign: Gtk.Align.CENTER,
        });
        const sync = () => {
            label.accelerator = settings.get_strv(key)[0] ?? '';
        };
        sync();
        const changedId = settings.connect(`changed::${key}`, sync);
        row.connect('destroy', () => settings.disconnect(changedId));
        row.add_suffix(label);

        const resetButton = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: 'Restore default',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        resetButton.connect('clicked', () => settings.reset(key));
        row.add_suffix(resetButton);

        row.connect('activated', () => this._captureShortcut(window, settings, key, title));
        return row;
    }

    _captureShortcut(window, settings, key, title) {
        const dialog = new Adw.AlertDialog({
            heading: title,
            body: 'Press a key combination with Ctrl, Alt, Shift or Super (F-keys work alone).\n' +
                  'Esc cancels, Backspace disables the shortcut.',
        });
        dialog.add_response('cancel', 'Cancel');

        const controller = new Gtk.EventControllerKey({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;
            const lower = Gdk.keyval_to_lower(keyval);

            if (!mask && lower === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!mask && lower === Gdk.KEY_BackSpace) {
                settings.set_strv(key, []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            // Ignore lone modifiers and bare printable keys.
            if (!Gtk.accelerator_valid(lower, mask) || (!mask && !isFunctionKey(lower)))
                return Gdk.EVENT_STOP;

            settings.set_strv(key, [Gtk.accelerator_name_with_keycode(null, lower, keycode, mask)]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present(window);
    }
}
