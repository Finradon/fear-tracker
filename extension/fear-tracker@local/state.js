// Fear state persistence: ~/.config/fear-tracker/{fear.json,fear.txt}.
// Shared format with server/fearstate.py; keep the two in sync.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

export const DEFAULT_MAX = 12;
export const MAX_LIMIT = 30;
export const MAX_COUNTDOWNS = 3;
export const COUNTDOWN_LIMIT = 30;
export const NAME_LIMIT = 32;

const COUNTDOWN_ID = /^[A-Za-z0-9_-]{1,16}$/;

const MONITOR_DEBOUNCE_MS = 100;

export function clamp(value, lo, hi) {
    return Math.min(hi, Math.max(lo, value));
}

export function pipText(fear, max) {
    return '●'.repeat(fear) + '○'.repeat(max - fear);
}

/**
 * Keep the valid countdowns (at most MAX_COUNTDOWNS), dropping bad entries.
 *
 * @param {*} raw - parsed JSON
 */
export function normalizeCountdowns(raw) {
    if (!Array.isArray(raw))
        return [];
    const result = [];
    const seen = new Set();
    for (const c of raw) {
        if (result.length === MAX_COUNTDOWNS)
            break;
        if (!c || typeof c !== 'object' || !Number.isInteger(c.start))
            continue;
        if (typeof c.id !== 'string' || !COUNTDOWN_ID.test(c.id) || seen.has(c.id))
            continue;
        const start = clamp(c.start, 1, COUNTDOWN_LIMIT);
        result.push({
            id: c.id,
            name: typeof c.name === 'string' ? c.name.trim().slice(0, NAME_LIMIT) : '',
            start,
            value: Number.isInteger(c.value) ? clamp(c.value, 0, start) : start,
            kind: c.kind === 'progress' ? 'progress' : 'consequence',
        });
        seen.add(c.id);
    }
    return result;
}

/**
 * Validate a parsed fear.json object. Returns {fear, max, updated, countdowns}
 * with clamped values, or null if the object is unusable.
 *
 * @param {*} raw - parsed JSON
 */
export function normalize(raw) {
    if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.fear))
        return null;
    const max = Number.isInteger(raw.max) ? clamp(raw.max, 1, MAX_LIMIT) : DEFAULT_MAX;
    return {
        fear: clamp(raw.fear, 0, max),
        max,
        updated: Number.isInteger(raw.updated) ? raw.updated : 0,
        countdowns: normalizeCountdowns(raw.countdowns),
    };
}

export class FearStore {
    /**
     * @param {Function} onExternalChange - called with {fear, max, updated, countdowns}
     *   when another process (e.g. scripts/set_fear.py) rewrites fear.json
     */
    constructor(onExternalChange) {
        this._onExternalChange = onExternalChange;
        this._dir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_config_dir(), 'fear-tracker']));
        this._jsonFile = this._dir.get_child('fear.json');
        this._txtFile = this._dir.get_child('fear.txt');
        this._encoder = new TextEncoder();

        this._pending = null;
        this._writing = false;
        this._lastWritten = null;
        this._debounceId = 0;
        this._destroyed = false;

        GLib.mkdir_with_parents(this._dir.get_path(), 0o755);

        this._monitor = this._jsonFile.monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monitorId = this._monitor.connect('changed', () => this._queueReload());
    }

    get path() {
        return this._dir.get_path();
    }

    /** @returns {Promise<object|null>} the normalized state on disk, or null */
    async load() {
        try {
            const [bytes] = await this._jsonFile.load_contents_async(null);
            return normalize(JSON.parse(new TextDecoder().decode(bytes)));
        } catch {
            return null;
        }
    }

    /**
     * Persist a new state. Writes are serialized and coalesced, so rapid
     * key presses never interleave and the last value always wins.
     *
     * @param {object} state - {fear, max, countdowns}
     */
    save({fear, max, countdowns}) {
        this._pending = {fear, max, updated: Date.now(), countdowns};
        if (!this._writing)
            this._flush().catch(e => console.error(`fear-tracker: write failed: ${e.message}`));
    }

    async _flush() {
        this._writing = true;
        try {
            while (this._pending) {
                const state = this._pending;
                this._pending = null;
                // eslint-disable-next-line no-await-in-loop
                await this._writeAtomic(this._jsonFile, `${JSON.stringify(state)}\n`);
                // eslint-disable-next-line no-await-in-loop
                await this._writeAtomic(this._txtFile, pipText(state.fear, state.max));
                this._lastWritten = state;
            }
        } finally {
            this._writing = false;
        }
    }

    // Write to a hidden temp file in the same directory, then rename(2) it
    // over the target, so readers see either the old or the new file.
    async _writeAtomic(file, text) {
        const tmp = this._dir.get_child(
            `.${file.get_basename()}.${GLib.uuid_string_random()}.tmp`);
        await tmp.replace_contents_bytes_async(
            new GLib.Bytes(this._encoder.encode(text)),
            null, false, Gio.FileCreateFlags.NONE, null);
        if (GLib.rename(tmp.get_path(), file.get_path()) !== 0) {
            try {
                tmp.delete(null);
            } catch {}
            throw new Error(`could not rename ${tmp.get_path()}`);
        }
    }

    _queueReload() {
        if (this._debounceId)
            GLib.source_remove(this._debounceId);
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MONITOR_DEBOUNCE_MS, () => {
            this._debounceId = 0;
            this._reload().catch(logError);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _reload() {
        // Our own writes also trigger the monitor; ignore them.
        if (this._writing || this._pending)
            return;
        const state = await this.load();
        if (this._destroyed || !state || this._writing || this._pending)
            return;
        if (this._lastWritten && state.updated === this._lastWritten.updated)
            return;
        this._lastWritten = state;
        this._onExternalChange(state);
    }

    destroy() {
        this._destroyed = true;
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
        this._monitor.disconnect(this._monitorId);
        this._monitor.cancel();
        this._monitor = null;
        this._onExternalChange = null;
    }
}
