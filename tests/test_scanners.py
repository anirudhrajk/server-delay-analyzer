"""
Tests for the scanners and the web server's safety checks.
Run from the project folder:   python -m unittest discover tests
"""
import functools
import http.server
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from analyzer import analyse  # noqa: E402
from scanners import folder, program, website  # noqa: E402
from scanners.common import ScanError  # noqa: E402


class FakeJob:
    def update(self, progress=None, message=None):
        pass


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class TestWebsite(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        with open(os.path.join(cls.dir, "index.html"), "w") as f:
            f.write('<html><head><link rel="stylesheet" href="style.css"><script src="missing.js"></script>'
                    '<script src="app.js" defer></script></head><body><img src="pic.png"></body></html>')
        for name, size in (("style.css", 3000), ("app.js", 5000), ("pic.png", 400_000)):
            with open(os.path.join(cls.dir, name), "wb") as f:
                f.write(b"x" * size)
        handler = functools.partial(QuietHandler, directory=cls.dir)
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}/"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.dir, ignore_errors=True)

    def test_scan_finds_files_and_the_broken_one(self):
        r = website.scan_website(FakeJob(), self.url, samples=3, check_files=True)
        json.dumps(r)
        self.assertEqual(r["kind"], "website")
        names = [c["name"] for c in r["causes"]]
        self.assertTrue(any("broken file" in n for n in names), names)
        self.assertTrue(any("large image" in n for n in names), names)
        self.assertEqual(r["stats"][3]["value"], "4")
        self.assertEqual(len(r["breakdown"]["rows"]), 4)  # typical + 3 visits

    def test_bad_addresses(self):
        for bad in ("", "ftp://example.com", "http://"):
            with self.assertRaises(ScanError):
                website.normalise_url(bad)
        self.assertEqual(website.normalise_url("example.com"), "https://example.com/")

    def test_resource_parser(self):
        html = (b'<head><script src="/a.js"></script><script async src="b.js"></script><link rel="stylesheet" href="c.css">'
                b'</head><body><img src="data:image/png;base64,xx"><img loading="lazy" src="//cdn.test/d.png"></body>')
        res, _ = website.find_resources(html, "https://site.test/page/")
        got = {(r["kind"], r["url"], r["blocking"], r["lazy"]) for r in res}
        self.assertIn(("script", "https://site.test/a.js", True, False), got)
        self.assertIn(("script", "https://site.test/page/b.js", False, False), got)
        self.assertIn(("style", "https://site.test/page/c.css", True, False), got)
        self.assertIn(("image", "https://cdn.test/d.png", False, True), got)
        self.assertEqual(len(res), 4)


class TestFolder(unittest.TestCase):
    def test_many_small_files(self):
        d = tempfile.mkdtemp()
        try:
            for i in range(800):
                sub = os.path.join(d, f"part{i % 4}")
                os.makedirs(sub, exist_ok=True)
                with open(os.path.join(sub, f"f{i}.txt"), "wb") as f:
                    f.write(b"y" * 200)
            with open(os.path.join(d, "big.bin"), "wb") as f:
                f.write(os.urandom(3 * 1024 * 1024))
            r = folder.scan_folder(FakeJob(), d, read_mb=64)
            json.dumps(r)
            self.assertEqual(r["stats"][0]["value"], "801")
            self.assertEqual(len(r["breakdown"]["rows"][0]["parts"]), 3)
            self.assertTrue(any(t["title"] == "Slowest sub-folders" for t in r["tables"]))
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_missing_folder(self):
        with self.assertRaises(ScanError):
            folder.scan_folder(FakeJob(), os.path.join(ROOT, "no_such_folder_123"))


class TestProgram(unittest.TestCase):
    def test_waiting_command(self):
        r = program.run_command(FakeJob(), f'"{sys.executable}" -c "import time; time.sleep(0.6)"', "", 2, 30, False, default_cwd=ROOT)
        json.dumps(r)
        self.assertTrue(any(c["name"].startswith("Waiting") for c in r["causes"]), [c["name"] for c in r["causes"]])

    def test_failing_command(self):
        r = program.run_command(FakeJob(), f'"{sys.executable}" -c "raise SystemExit(3)"', "", 1, 30, False, default_cwd=ROOT)
        self.assertEqual(r["causes"][0]["name"], "The command failed")

    def test_timeout_kills_the_command(self):
        r = program.run_command(FakeJob(), f'"{sys.executable}" -c "import time; time.sleep(30)"', "", 1, 1, False, default_cwd=ROOT)
        self.assertEqual(r["causes"][0]["name"], "The command did not finish")

    def test_tune_demo_finds_a_fast_safe_setting(self):
        tpl = f'"{sys.executable}" samples/demo_server.py --threads {{n}} --batch {{b}}'
        r = program.tune(FakeJob(), tpl, "1,2,4,8,16", "1,2,4,8,16,32", 1, "printed", "", 60, False, (4, 16), default_cwd=ROOT)
        json.dumps(r)
        rec = r["recommended"]
        self.assertEqual(rec["source"], "measured")
        self.assertLess(rec["D"], 9.5)          # true best of the demo is about 8.1 ms
        self.assertNotIn((rec["n"], rec["b"]), {(o["n"], o["b"]) for o in r["overloaded"]})
        self.assertGreater(r["improvement"]["pct"], 0.4)

    def test_tune_needs_placeholders(self):
        with self.assertRaises(ScanError):
            program.tune(FakeJob(), "python x.py", "1,2,4", "1,2,4", default_cwd=ROOT)


class TestOverload(unittest.TestCase):
    def test_cliff_is_set_aside_and_never_recommended(self):
        p = {"A": 400, "B": 4, "C": 90, "E": 2.5, "k": 0.05}
        n, b, d = [], [], []
        for nn in (1, 2, 4, 8, 16, 32):
            for bb in (1, 2, 4, 8, 16, 32):
                v = p["A"] / nn + p["B"] * nn + p["C"] / bb + p["E"] * bb + p["k"] * nn * bb
                if nn * bb <= 2:
                    v *= 60            # can't keep up: delay explodes
                n.append(nn); b.append(bb); d.append(v)
        r = analyse(np.array(n, float), np.array(b, float), np.array(d))
        over = {(o["n"], o["b"]) for o in r["overloaded"]}
        self.assertEqual(over, {(1.0, 1.0), (1.0, 2.0), (2.0, 1.0)})
        self.assertEqual((r["recommended"]["n"], r["recommended"]["b"]), (10, 5))


class TestServerSafety(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import tempfile
        import app as app_module
        from store import Store
        cls.tmp = tempfile.TemporaryDirectory()
        cls.app_module = app_module
        cls._old_store = app_module.store
        app_module.store = Store(url="", sqlite_path=os.path.join(cls.tmp.name, "s.db"))
        cls.client = app_module.app.test_client()
        cls.client.post("/api/auth/signup", json={"username": "tester", "password": "test-password"})
        html = cls.client.get("/").get_data(as_text=True)
        cls.TOKEN = html.split('name="app-token" content="')[1].split('"')[0]

    @classmethod
    def tearDownClass(cls):
        cls.app_module.store = cls._old_store
        cls.tmp.cleanup()

    def test_page_carries_token(self):
        r = self.client.get("/")
        self.assertIn(self.TOKEN, r.get_data(as_text=True))
        self.assertGreater(len(self.TOKEN), 20)

    def test_api_needs_token(self):
        r = self.client.post("/api/scan/folder", json={"path": ROOT})
        self.assertEqual(r.status_code, 401)

    def test_other_websites_are_blocked(self):
        h = {"X-Token": self.TOKEN, "Origin": "https://evil.example"}
        self.assertEqual(self.client.post("/api/scan/folder", json={"path": ROOT}, headers=h).status_code, 403)

    def test_dns_rebinding_is_blocked(self):
        r = self.client.get("/", headers={"Host": "attacker.example:5000"})
        self.assertEqual(r.status_code, 403)

    def test_health_and_job_flow(self):
        self.assertEqual(self.client.get("/api/health").status_code, 200)
        h = {"X-Token": self.TOKEN}
        r = self.client.post("/api/scan/folder", json={"path": os.path.join(ROOT, "samples"), "read_mb": 16}, headers=h)
        self.assertEqual(r.status_code, 200)
        job_id = r.get_json()["job"]
        import time
        for _ in range(100):
            s = self.client.get(f"/api/jobs/{job_id}", headers=h).get_json()
            if s["status"] != "running":
                break
            time.sleep(0.1)
        self.assertEqual(s["status"], "done", s.get("error"))
        self.assertEqual(s["result"]["kind"], "folder")
        self.assertTrue(s["report_id"])                                   # saved to this person's history
        hist = self.client.get("/api/history", headers=h).get_json()["reports"]
        self.assertIn(s["report_id"], [x["id"] for x in hist])


if __name__ == "__main__":
    unittest.main()
