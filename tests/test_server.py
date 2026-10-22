import http.client
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "server"))

import fear_server  # noqa: E402
import fearstate  # noqa: E402


class StateFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_write_and_read_roundtrip(self):
        state = fearstate.write_state(self.dir, 5, 12)
        self.assertEqual(fearstate.read_state(self.dir), state)
        self.assertEqual((self.dir / "fear.txt").read_text(), "●●●●●○○○○○○○")
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ["fear.json", "fear.txt"])

    def test_write_clamps(self):
        self.assertEqual(fearstate.write_state(self.dir, 99, 12)["fear"], 12)
        self.assertEqual(fearstate.write_state(self.dir, -3, 12)["fear"], 0)
        self.assertEqual(fearstate.write_state(self.dir, 5, 0)["max"], 1)
        self.assertEqual(fearstate.write_state(self.dir, 5, 0)["fear"], 1)
        self.assertEqual(fearstate.write_state(self.dir, 40, 99)["max"], fearstate.MAX_LIMIT)

    def test_missing_and_corrupt(self):
        self.assertIsNone(fearstate.read_state(self.dir))
        for content in ["", "{", "[]", "null", '{"fear": "3"}', '{"fear": true}', "\xff"]:
            (self.dir / "fear.json").write_text(content)
            self.assertIsNone(fearstate.read_state(self.dir), content)

    def test_normalize(self):
        n = fearstate.normalize
        self.assertEqual(n({"fear": 20, "max": 6, "updated": 1}), {"fear": 6, "max": 6, "updated": 1})
        self.assertEqual(n({"fear": 3}), {"fear": 3, "max": 12, "updated": 0})
        self.assertEqual(n({"fear": 3, "max": "x", "updated": 1.5})["max"], 12)
        self.assertEqual(n({"fear": -1, "max": 12})["fear"], 0)

    def test_concurrent_reads_never_see_partial_file(self):
        stop = threading.Event()
        errors = []

        def reader():
            while not stop.is_set():
                try:
                    raw = (self.dir / "fear.json").read_text()
                except FileNotFoundError:
                    continue
                try:
                    json.loads(raw)
                except ValueError:
                    errors.append(raw)

        fearstate.write_state(self.dir, 0, 12)
        threads = [threading.Thread(target=reader) for _ in range(3)]
        for t in threads:
            t.start()
        for i in range(300):
            fearstate.write_state(self.dir, i % 13, 12)
        stop.set()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        cls.server = fear_server.make_server(0, cls.dir)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def request(self, path, method="GET", host=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Host": host} if host else {}
        conn.request(method, path, headers=headers)
        res = conn.getresponse()
        body = res.read()
        conn.close()
        return res, body

    def test_binds_loopback_only(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")

    def test_state_default_when_missing(self):
        (self.dir / "fear.json").unlink(missing_ok=True)
        res, body = self.request("/state")
        self.assertEqual(res.status, 200)
        self.assertEqual(res.getheader("Content-Type"), "application/json")
        self.assertEqual(json.loads(body), {"fear": 0, "max": 12, "updated": 0})

    def test_state_reads_fresh_each_time(self):
        fearstate.write_state(self.dir, 4, 12)
        self.assertEqual(json.loads(self.request("/state")[1])["fear"], 4)
        fearstate.write_state(self.dir, 9, 10)
        state = json.loads(self.request("/state")[1])
        self.assertEqual((state["fear"], state["max"]), (9, 10))

    def test_state_corrupt_and_out_of_range(self):
        (self.dir / "fear.json").write_text("{not json")
        self.assertEqual(json.loads(self.request("/state")[1])["fear"], 0)
        (self.dir / "fear.json").write_text('{"fear": 50, "max": 8, "updated": 7}')
        self.assertEqual(json.loads(self.request("/state")[1]), {"fear": 8, "max": 8, "updated": 7})

    def test_no_store_everywhere(self):
        for path in ["/state", "/overlay.html", "/missing", "/"]:
            res, _ = self.request(path)
            self.assertEqual(res.getheader("Cache-Control"), "no-store", path)

    def test_overlay_and_root_redirect(self):
        res, body = self.request("/overlay.html")
        self.assertEqual(res.status, 200)
        self.assertIn(b"<title>Fear</title>", body)
        res, _ = self.request("/")
        self.assertEqual((res.status, res.getheader("Location")), (302, "/overlay.html"))
        res, body = self.request("/overlay.html?theme=frost&size=lg")
        self.assertEqual(res.status, 200)

    def test_head(self):
        res, body = self.request("/state", method="HEAD")
        self.assertEqual((res.status, body), (200, b""))

    def test_path_traversal(self):
        for path in ["/../server/fear_server.py", "/..%2fserver/fear_server.py",
                     "/%2e%2e/%2e%2e/etc/passwd", "//etc/passwd", "/../../../../etc/passwd"]:
            res, body = self.request(path)
            self.assertEqual(res.status, 404, path)
            self.assertNotIn(b"root:", body)

    def test_symlink_escape(self):
        link = REPO / "overlay" / "escape-test-link"
        try:
            link.symlink_to("/etc")
            res, _ = self.request("/escape-test-link/hostname")
            self.assertEqual(res.status, 404)
        finally:
            link.unlink(missing_ok=True)

    def test_no_directory_listing(self):
        res, _ = self.request("/overlay/")
        self.assertEqual(res.status, 404)

    def test_foreign_host_rejected(self):
        res, _ = self.request("/state", host="evil.example:8765")
        self.assertEqual(res.status, 403)
        res, _ = self.request("/state", host=f"localhost:{self.port}")
        self.assertEqual(res.status, 200)

    def test_post_not_allowed(self):
        res, _ = self.request("/state", method="POST")
        self.assertEqual(res.status, 501)


class SetFearCliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name) / "state"

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, str(REPO / "scripts" / "set_fear.py"), "--state-dir", str(self.dir), *args],
            capture_output=True, text=True, check=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        ).stdout

    def state(self):
        return fearstate.read_state(self.dir)

    def test_absolute_relative_and_max(self):
        self.run_cli("--init")
        self.assertEqual(self.state()["fear"], 0)
        self.run_cli("5")
        self.run_cli("+3")
        self.assertEqual(self.state()["fear"], 8)
        self.run_cli("-2")
        self.assertEqual(self.state()["fear"], 6)
        self.run_cli("+20")
        self.assertEqual(self.state()["fear"], 12)
        self.run_cli("--max", "8")
        self.assertEqual((self.state()["fear"], self.state()["max"]), (8, 8))
        out = self.run_cli()
        self.assertIn("Fear 8/8", out)

    def test_init_does_not_overwrite(self):
        self.run_cli("7")
        self.run_cli("--init")
        self.assertEqual(self.state()["fear"], 7)


if __name__ == "__main__":
    unittest.main()
