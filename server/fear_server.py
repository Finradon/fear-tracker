#!/usr/bin/env python3
"""Serve the Fear overlay and /state on 127.0.0.1 (stdlib only).

Usage: fear_server.py [--port N] [--state-dir DIR] [--verbose]
Environment: FEAR_PORT, FEAR_STATE_DIR
"""

import argparse
import json
import os
import sys
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from fearstate import default_state, default_state_dir, read_state

HOST = "127.0.0.1"
DEFAULT_PORT = 8765
OVERLAY_DIR = Path(__file__).resolve().parent.parent / "overlay"
ALLOWED_HOSTS = {"127.0.0.1", "localhost"}


class FearHandler(SimpleHTTPRequestHandler):
    server_version = "FearOverlay/1.0"
    sys_version = ""

    def __init__(self, *args, state_dir: Path, verbose: bool, **kwargs):
        self.state_dir = state_dir
        self.verbose = verbose
        super().__init__(*args, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_GET(self):
        self._dispatch(head=False)

    def do_HEAD(self):
        self._dispatch(head=True)

    def _dispatch(self, head: bool):
        # Reject foreign Host headers (DNS rebinding from a web page).
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].lower()
        if host not in ALLOWED_HOSTS:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        path = urlsplit(self.path).path
        if path == "/state":
            self._send_state(head)
        elif path == "/":
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/overlay.html")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif self._escapes_root():
            self.send_error(HTTPStatus.NOT_FOUND)
        elif head:
            super().do_HEAD()
        else:
            super().do_GET()

    def _send_state(self, head: bool):
        state = read_state(self.state_dir) or default_state()
        body = json.dumps(state).encode()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def _escapes_root(self) -> bool:
        # The base class already drops '..' segments; additionally refuse
        # anything that resolves (e.g. via symlinks) outside overlay/.
        root = os.path.realpath(self.directory)
        resolved = os.path.realpath(self.translate_path(self.path))
        return resolved != root and not resolved.startswith(root + os.sep)

    def list_directory(self, path):
        self.send_error(HTTPStatus.NOT_FOUND)
        return None

    def log_message(self, format, *args):
        if self.verbose:
            super().log_message(format, *args)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int,
                        default=int(os.environ.get("FEAR_PORT", DEFAULT_PORT)),
                        help=f"port on {HOST} (default: $FEAR_PORT or {DEFAULT_PORT})")
    parser.add_argument("--state-dir", type=Path, default=default_state_dir(),
                        help="directory containing fear.json (default: ~/.config/fear-tracker)")
    parser.add_argument("-v", "--verbose", action="store_true", help="log every request")
    return parser.parse_args(argv)


def make_server(port: int, state_dir: Path, verbose: bool = False) -> ThreadingHTTPServer:
    handler = partial(FearHandler, directory=str(OVERLAY_DIR),
                      state_dir=state_dir, verbose=verbose)
    return ThreadingHTTPServer((HOST, port), handler)


def main(argv=None):
    args = parse_args(argv)
    try:
        server = make_server(args.port, args.state_dir.expanduser(), args.verbose)
    except OSError as e:
        sys.exit(f"fear_server: cannot bind {HOST}:{args.port}: {e.strerror}")
    host, port = server.server_address[:2]
    print(f"Fear overlay: http://{host}:{port}/overlay.html  (state: {args.state_dir})",
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
