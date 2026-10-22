# Fear Tracker: a Daggerheart Fear overlay for Zoom

Track the GM's **Fear** from the GNOME top bar and show it to your players as a
small glowing overlay in your webcam feed.

```
GNOME Shell extension ──atomic write──▶ ~/.config/fear-tracker/fear.json ◀──read── fear_server.py ──HTTP──▶ overlay.html
 (top bar + shortcuts)                  ~/.config/fear-tracker/fear.txt        (127.0.0.1:8765)          (OBS Browser Source)
                                                                                                                 │
                                                       Zoom ◀── OBS Virtual Camera (v4l2loopback) ◀── OBS scene ◀┘
```

- **Extension** (`extension/fear-tracker@local`): shows `Fear 5` in the top bar. The popup has −, + and Reset buttons, a 0…max grid to set an exact value, and a link to Preferences. Global shortcuts work everywhere, and an on-screen popup confirms each press.
- **Server** (`server/fear_server.py`): Python 3 stdlib only. It serves `overlay/` and `/state` on 127.0.0.1 only.
- **Overlay** (`overlay/overlay.html`): one self-contained file with a transparent background. It shows a row of diamond "ember" pips that pulse while lit, flare and shake the bar when Fear rises, and gutter out when it falls.
- **Fallback**: `fear.txt` contains `●●●●●○○○○○○○` for an OBS Text source.

```
extension/fear-tracker@local/   metadata.json, extension.js, state.js, prefs.js, stylesheet.css, icons/, schemas/
server/                         fear_server.py (HTTP), fearstate.py (file format + atomic writes)
overlay/overlay.html            the OBS browser-source page
scripts/                        install.sh, uninstall.sh, set_fear.py (demo/test writer)
systemd/fear-overlay.service    optional user service for the server
tests/test_server.py            stdlib unittest suite
Makefile                        serve / install / demo / test / check / pack
```

---

## Quick start

```sh
git clone <this repo> ~/repos/fear-tracker && cd ~/repos/fear-tracker
make install-service          # extension + server as a systemd user service
# log out and back in (Wayland)
python3 scripts/set_fear.py 5 # or press Ctrl+Super+Page Up
```

In OBS, add a **Browser Source** with the URL `http://127.0.0.1:8765/overlay.html` and a size of 800×100. Then click **Start Virtual Camera** and pick "OBS Virtual Camera" in Zoom.

The rest of this file is the detailed version.

---

## 1. OBS and the virtual camera on CachyOS

### Packages

| What | Package | Notes |
|---|---|---|
| OBS Studio | `obs-studio` | CachyOS's optimized rebuild (`cachyos-extra-v3`/`-v4`/`-znver4`; pacman picks the one for your CPU). |
| **Browser Source** | `obs-studio-plugin-browser` | **Required.** The CEF browser plugin is a separate package, and without it OBS has no "Browser" source. Install it from the same repo as `obs-studio` so the versions match. |
| v4l2loopback kernel module | *none* (in the CachyOS kernel) | See below. |
| `v4l2loopback-ctl` (optional) | `v4l2loopback-utils` | Depends on the virtual `V4L2LOOPBACK-MODULE`, which the CachyOS kernels provide, so it won't pull in DKMS. |
| `v4l2-ctl` (handy for debugging) | `v4l-utils` | |

```sh
sudo pacman -S --needed obs-studio obs-studio-plugin-browser v4l-utils
paru -S zoom        # AUR (or yay -S zoom)
```

`obs-studio` lists `v4l2loopback-dkms` as an *optional* dependency. Ignore that on a CachyOS kernel (see below).

**v4l2loopback on CachyOS.** The CachyOS kernels (`linux-cachyos`, `-bore`, `-lts`, …) build v4l2loopback in-tree as a regular module (`CONFIG_V4L2_LOOPBACK=m`, `drivers/media/v4l2-core/v4l2loopback.c`, version 0.15.4 on the 7.3 kernel). Their packages declare `provides=(… V4L2LOOPBACK-MODULE …)`, so there is **no separate kernel-specific package and you don't need DKMS**. Check with:

```sh
modinfo v4l2loopback | head -3     # filename: .../kernel/drivers/media/v4l2-core/v4l2loopback.ko.zst
```

Don't also install `v4l2loopback-dkms` on a CachyOS kernel. It would build a second copy that shadows the in-tree one, and DKMS version mismatches are the usual cause of the "OBS virtual camera broke after update" reports on the CachyOS forum. You only need `v4l2loopback-dkms` plus the matching `*-headers` package if you boot a non-CachyOS kernel such as stock Arch `linux`.

(Not used here: the Flatpak OBS `com.obsproject.Studio` bundles the browser plugin, but it can't `modprobe`, so it relies on the module config below.)

### Load the module (persistent across reboots)

`exclusive_caps=1` is required. Without it, Chromium/WebRTC-based apps (Zoom included) don't list the loopback as a camera.

```sh
echo v4l2loopback | sudo tee /etc/modules-load.d/v4l2loopback.conf
echo 'options v4l2loopback devices=1 video_nr=10 card_label="OBS Virtual Camera" exclusive_caps=1' \
  | sudo tee /etc/modprobe.d/v4l2loopback.conf
sudo modprobe -r v4l2loopback 2>/dev/null; sudo modprobe v4l2loopback
v4l2-ctl --list-devices            # should list "OBS Virtual Camera (platform:v4l2loopback-000): /dev/video10"
```

Without the persistent config, OBS offers to load the module itself (with a polkit password prompt) when you click *Start Virtual Camera*. The config above avoids that prompt and keeps the device name stable.

## 2. Install the GNOME extension

Requires GNOME Shell 51 (`metadata.json` declares `"shell-version": ["51"]`).

```sh
make install            # = scripts/install.sh            (extension only)
make install-service    # = scripts/install.sh --service  (extension + systemd user service)
```

`install.sh` is idempotent. It:

1. compiles the GSettings schema (`glib-compile-schemas`) into `extension/fear-tracker@local/schemas/`,
2. symlinks the extension into `~/.local/share/gnome-shell/extensions/fear-tracker@local` (`--copy` copies it instead),
3. symlinks `~/.local/share/fear-tracker` to the repo (the systemd unit runs the server from there),
4. creates `~/.config/fear-tracker/fear.json` with Fear 0 if it doesn't exist yet,
5. with `--service`, installs and starts `fear-overlay.service`,
6. marks the extension enabled (`gnome-extensions enable`, or adds it to `enabled-extensions` if the running shell doesn't know it yet).

**Wayland caveat:** GNOME Shell only discovers new extensions at login and can't be restarted in place on Wayland. After the first install, or after editing extension code, **log out and back in**. Then confirm:

```sh
gnome-extensions info fear-tracker@local    # State: ACTIVE
gnome-extensions enable fear-tracker@local  # if it says DISABLED/INACTIVE
```

### Using it

| Action | Default shortcut |
|---|---|
| Fear +1 | **Ctrl+Super+Page Up** |
| Fear −1 | **Ctrl+Super+Page Down** |
| Reset to 0 | **Ctrl+Super+Home** |

These combos aren't used by any GNOME 51 default binding, and they sit on the base level of every keyboard layout, unlike `[`/`]` on German layouts. Holding a key doesn't auto-repeat. Shortcuts work in normal mode and in the Overview, but not on the lock screen or while a modal dialog is open.

**Preferences** (top-bar menu → Preferences, or `gnome-extensions prefs fear-tracker@local`):
- **Maximum Fear**: 1–30, default 12. Lowering it clamps the current value.
- **On-screen popup**: on or off for the popup shown on shortcut presses.
- **Keyboard Shortcuts**: click a row and press a combo. Esc cancels, Backspace disables, and ↶ restores the default.

The value is clamped to [0, max], persists in `fear.json`, and is reloaded when the extension starts, so it survives shell restarts and reboots. If another program rewrites `fear.json` (for example `set_fear.py`), the extension picks the change up within about 0.1 s, including a changed max.

## 3. Start the overlay server

Foreground:

```sh
make serve                         # = python3 server/fear_server.py --port 8765
python3 server/fear_server.py --port 9000 --verbose
FEAR_PORT=9000 python3 server/fear_server.py
```

As a systemd user service (`make install-service` does this for you):

```sh
mkdir -p ~/.config/systemd/user
cp systemd/fear-overlay.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now fear-overlay.service
systemctl --user status fear-overlay        # logs: journalctl --user -u fear-overlay
```

The unit runs `~/.local/share/fear-tracker/server/fear_server.py`, which `install.sh` links to this repo. To change the port, `systemctl --user edit fear-overlay` and add `[Service]` / `Environment=FEAR_PORT=9000`.

Endpoints, all with `Cache-Control: no-store`:

| Path | Response |
|---|---|
| `/overlay.html` | the overlay (`/` redirects here) |
| `/state` | `{"fear": 5, "max": 12, "updated": 1792653089491}`. The file is read fresh on every request. If it is missing or invalid, the server returns `{"fear": 0, "max": 12, "updated": 0}`. |

The server binds to **127.0.0.1 only**. It rejects requests whose `Host` header isn't `127.0.0.1` or `localhost` (DNS-rebinding protection), refuses paths that resolve outside `overlay/` (including via symlinks), disables directory listings, and only answers GET and HEAD.

## 4. OBS scene setup

1. **Sources → + → Video Capture Device (V4L2)**: pick your real webcam, **not** "OBS Virtual Camera". Right-click it, choose **Transform → Fit to screen**, and set the canvas (Settings → Video) to 1280×720 or 1920×1080.
2. **Sources → + → Browser**:
   - URL: `http://127.0.0.1:8765/overlay.html` (add parameters, see below)
   - Width/Height: see the table below
   - Leave *Custom CSS* empty or delete its default rule. The page already has a transparent background, no margins and no scrollbars.
   - Optional: tick *Refresh browser when scene becomes active*. Leave *Shutdown source when not visible* off.
3. Make sure the Browser source is **above** the webcam in the source list.
4. **Make it a corner element.** Select the browser source and drag it into a corner, or use Edit → Transform → Edit Transform (Ctrl+E):
   - Bottom-left: Position `0, 1080 − height` with Positional Alignment *Bottom Left*, or simply drag it there; the red snapping guides help.
   - Use `?align=left` for a left corner and `?align=right` for a right corner, so the pips hug the screen edge inside the source box.
   - To make it smaller, prefer `?size=sm` over scaling the source down, so the overlay stays crisp. Scaling works too.

Recommended Browser source sizes (12 pips, label on):

| `size=` | pip px | Source W×H | Content width |
|---|---|---|---|
| `xs` | 16 | 500×60 | ≈ 310 px |
| `sm` | 22 | 600×80 | ≈ 430 px |
| `md` (default) | 30 | **800×100** | ≈ 585 px |
| `lg` | 42 | 1100×130 | ≈ 820 px |
| `xl` | 58 | 1400×170 | ≈ 1130 px |

If the source is too narrow, the pips wrap onto a second row instead of being cut off, so for large `max` values give the source more height.

### Overlay URL parameters

| Param | Values | Default |
|---|---|---|
| `theme` | `ember` (purple/magenta), `frost` (ice blue), `blood` (crimson) | `ember` |
| `size` | `xs` `sm` `md` `lg` `xl`, or a pip size in px (8–200) | `md` |
| `align` | `left` `center` `right` | `center` |
| `label` | `1` shows "FEAR 5" before the pips, `0` hides it | `1` |
| `count` | `0` hides just the number | `1` |
| `plate` | `0` removes the dark backing plate | `1` |
| `motion` | `0` disables the pulse, flare and tremor (also honours *prefers-reduced-motion*) | `1` |
| `poll` | polling interval in ms (100–5000) | `300` |
| `bg` | hex colour, e.g. `bg=333`, for previewing in a normal browser; **don't use it in OBS** | transparent |

Example: `http://127.0.0.1:8765/overlay.html?theme=frost&size=sm&align=left`

The overlay polls `/state` with `setTimeout`. If the server is unreachable or returns garbage, it keeps showing the last good state without flicker or error UI. It stays invisible until the first successful poll. All effects are CSS animations; there is no `requestAnimationFrame` loop. When the value doesn't change, the only work is the poll and the opacity/transform pulse on lit pips, which the compositor handles.

### Fallback: plain Text source

If the browser plugin isn't available: **Sources → + → Text (FreeType 2)**, tick **Read from file**, and choose `~/.config/fear-tracker/fear.txt`. Pick a font with ● and ○ glyphs (DejaVu Sans, Noto Sans Symbols 2). OBS re-reads the file about once a second. Add a *Color Correction* or *Glow* filter to taste.

## 5. Zoom

1. In OBS, click **Start Virtual Camera** (Controls panel).
2. In Zoom, go to **Settings → Video → Camera** and choose **OBS Virtual Camera**, or `Dummy video device`/`/dev/video10` if you didn't set `card_label`.
3. Untick **Mirror my video**. Zoom mirrors only *your* self-view, so the overlay looks reversed to you, while participants always see it the right way round. Unticking it makes your preview match what players see.

Zoom-on-Linux notes:
- Start the OBS virtual camera **before** opening Zoom, or at least before opening its video settings. With `exclusive_caps=1` the device only advertises itself as a capture device once something is writing to it, so Zoom may not list it, or may show black, if OBS started later. If that happens, restart Zoom's video (stop and start video) or restart Zoom.
- **AUR `zoom`** (the setup assumed here) is the unsandboxed native client. It opens `/dev/video10` directly, and logind gives the logged-in user access to all video4linux devices, including the loopback one, so no `video` group or permissions are needed. It is an X11 app and runs under XWayland on GNOME, which doesn't affect the camera.
- If you use Flatpak Zoom (`us.zoom.Zoom`) instead, it ships with `--device=all`, so it can also see `/dev/video*`. If you've tightened it with Flatseal, re-allow "All devices".
- Zoom in a browser (app.zoom.us) works too: pick "OBS Virtual Camera" in the browser's camera permission prompt.
- Don't let both OBS and Zoom open the **real** webcam. Zoom must use the virtual camera only.
- Zoom may compress the video heavily. The `md`/`lg` sizes survive that better than `xs`.

---

## Demo / test mode (no GNOME needed)

`scripts/set_fear.py` writes the same files atomically, so you can test the server, overlay and OBS before the extension works:

```sh
make serve &                          # or the systemd service
python3 scripts/set_fear.py           # show current state
python3 scripts/set_fear.py 5         # set to 5
python3 scripts/set_fear.py +2        # relative
python3 scripts/set_fear.py -1
python3 scripts/set_fear.py 3 --max 8 # change max (overlay re-renders 8 pips)
make demo                             # random walk every 1.5 s, Ctrl+C to stop
```

Preview in any browser: `http://127.0.0.1:8765/overlay.html?bg=333`

## State file format

`~/.config/fear-tracker/` (or `$XDG_CONFIG_HOME/fear-tracker`; the server and `set_fear.py` also accept `FEAR_STATE_DIR` / `--state-dir`):

- `fear.json`: `{"fear":5,"max":12,"updated":1792653089491}` (`updated` = Unix ms)
- `fear.txt`: `●●●●●○○○○○○○` (no trailing newline)

Every writer (the extension's `state.js` and the Python `fearstate.py`) writes a hidden temp file in the same directory and `rename(2)`s it over the target, so readers see either the old file or the new one, never a partial write. Every reader (the extension, the server and the overlay) applies the same rules: `fear` must be an integer, `max` is clamped to 1–30 (default 12), and `fear` is clamped to [0, max].

## Development

```sh
make test     # 19 stdlib unittest cases: state format, atomicity under concurrent reads, server, CLI
make check    # tests + strict schema compile (+ JS syntax check if node happens to be installed)
make pack     # fear-tracker@local.shell-extension.zip for `gnome-extensions install`
```

Test the extension in a nested shell without logging out (GNOME 49+ replaced `--nested` with the Mutter devkit):

```sh
sudo pacman -S --needed mutter-devkit
dbus-run-session gnome-shell --devkit --wayland
```

Note that the nested shell shares your real `~/.config/fear-tracker` and GSettings.

### GNOME 51 notes

Checked against the gnome-shell 51.1 source and the gjs.guide port guide:
- ESM extension (`export default class … extends Extension`), `shell-version: ["51"]`.
- `disable()` is synchronous. GNOME 51 errors if it is `async`.
- Layout uses `orientation: Clutter.Orientation.VERTICAL`, because the St `vertical` property was removed in 51.
- Keybindings go through `Main.wm.addKeybinding(name, settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL | OVERVIEW, handler)` and are removed in `disable()`.
- The shortcut confirmation uses `Main.osdWindowManager.showAll()` (a level-bar OSD like the volume popup) plus a brief glow on the panel label, rather than a MessageTray notification. Notifications would pile up in the message list during a session, while the OSD is transient. You can switch it off in Preferences.
- File I/O in the shell is async (`Gio._promisify`). Writes are serialized and coalesced, so mashing + never interleaves writes.
- None of the brief's requirements conflicted with GNOME 51, so nothing was dropped.

## Troubleshooting

**Extension not loading / no "Fear" in the top bar**
- `gnome-extensions info fear-tracker@local`. If `State: ERROR`, look at the shell log: `journalctl -f -o cat /usr/bin/gnome-shell` (log out and in, then watch for `fear-tracker`).
- `gnome-extensions list --enabled` should include it. Also check that `gsettings get org.gnome.shell disable-user-extensions` is `false`.
- `Schema … could not be found`: the compiled schema is missing. Run `make schemas` (or re-run `install.sh`), then log out and in.
- "Not compatible with this version": your shell isn't 51 (`gnome-shell --version`). Add your major version to `shell-version` in `metadata.json` at your own risk.
- Shortcut does nothing: another app or GNOME binding may own the combo. Rebind it in Preferences. Settings → Keyboard → View and Customize Shortcuts shows GNOME's own bindings.

**Overlay not updating**
- `curl -s http://127.0.0.1:8765/state` should change after you press +. If it doesn't, check `cat ~/.config/fear-tracker/fear.json`.
- If the file changes but `/state` doesn't, the server is reading another directory: check `XDG_CONFIG_HOME` / `--state-dir`, and the "state:" path the server prints at startup.
- If `/state` changes but OBS doesn't, right-click the Browser source → Properties → **Refresh cache of current page**, and check the URL and port.
- Browser source blank or source type missing: `obs-studio-plugin-browser` isn't installed (or you're on an old OBS build).
- `cannot bind 127.0.0.1:8765` means something else holds the port (maybe the systemd service and `make serve` at the same time). Use `ss -ltnp | grep 8765`.

**Black or missing virtual camera**
- `lsmod | grep v4l2loopback` and `v4l2-ctl --list-devices`.
- `modprobe: FATAL: Module v4l2loopback not found`: you're not on a CachyOS kernel (`uname -r`), so install `v4l2loopback-dkms` plus headers, or boot the CachyOS kernel. On a CachyOS kernel, a stale DKMS copy may also be shadowing the in-tree module: `pacman -Q v4l2loopback-dkms` should report it isn't installed.
- Zoom shows black: start the OBS virtual camera first, then (re)start video in Zoom. Make sure `exclusive_caps=1` is set: `cat /sys/module/v4l2loopback/parameters/exclusive_caps` should start with `Y`.
- OBS says "virtual camera already in use" or fails: another program has `/dev/video10` open (`fuser /dev/video10`).

**Mirrored video in Zoom**: Settings → Video → untick *Mirror my video*. Only your self-view is mirrored; others see it correctly. Don't flip the source in OBS.

**Overlay looks blurry**: use a larger `size=` instead of scaling the source up, and make the source size match the table.

## Manual test checklist for tonight

These parts could not be tested on the dev host: real hardware, OBS, Zoom, and your actual GNOME login session.

1. `uname -r` shows a cachyos kernel, and `modinfo v4l2loopback` works.
2. Install the packages and the modprobe config (section 1). `v4l2-ctl --list-devices` shows "OBS Virtual Camera".
3. `make install-service`, then log out and in. `gnome-extensions info fear-tracker@local` shows `State: ACTIVE`, and the top bar shows `Fear N`.
4. Press Ctrl+Super+Page Up three times. The label goes up, an OSD appears, and `cat ~/.config/fear-tracker/fear.txt` shows three ●.
5. Open the menu: −, + and Reset work, clicking a number sets it, and Preferences opens.
6. In Preferences, set Maximum Fear to 8. The menu grid shows 0–8, and the overlay shows 8 pips.
7. `curl -s http://127.0.0.1:8765/state` matches the panel.
8. Open `http://127.0.0.1:8765/overlay.html?bg=333` in Firefox. Pips glow and pulse, a + press causes a flare and tremor, and a − press causes a fade.
9. OBS: webcam plus Browser source (800×100) in a corner. The background is transparent over the webcam.
10. Stop the server (`systemctl --user stop fear-overlay`). The overlay keeps the last value. Start it again and the overlay catches up.
11. Start the virtual camera, then start Zoom → Settings → Video → OBS Virtual Camera. The overlay is visible; untick Mirror.
12. Log out and in (or reboot). The value persists.

## Uninstall

```sh
make uninstall                 # keeps ~/.config/fear-tracker
scripts/uninstall.sh --purge   # also deletes the state files
```

The modprobe config from section 1 is yours to remove: `/etc/modules-load.d/v4l2loopback.conf` and `/etc/modprobe.d/v4l2loopback.conf`.

## License

MIT, see [LICENSE](LICENSE).
