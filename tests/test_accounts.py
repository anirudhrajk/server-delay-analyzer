"""Accounts, private history and the shared scan line (run: python -m unittest discover -s tests)."""
import os
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as app_module  # noqa: E402
from jobs import Busy, JobRunner  # noqa: E402
from store import AccountError, Store  # noqa: E402


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(url="", sqlite_path=os.path.join(self.tmp.name, "t.db"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_accounts(self):
        u = self.store.create_user("Anirudh", "correct horse")
        self.assertEqual(u["username"], "Anirudh")
        with self.assertRaises(AccountError):
            self.store.create_user("anirudh", "another pass")       # same ID, any case
        with self.assertRaises(AccountError):
            self.store.create_user("ab", "long enough")              # too short
        with self.assertRaises(AccountError):
            self.store.create_user("asher", "short")                 # weak password
        self.assertIsNotNone(self.store.check_login("ANIRUDH", "correct horse"))
        self.assertIsNone(self.store.check_login("anirudh", "wrong password"))
        self.assertIsNone(self.store.check_login("nobody", "correct horse"))
        row = self.store._run("SELECT pw_hash FROM sda_users", fetch="one")
        self.assertNotIn("correct horse", row[0])                    # only a hash is kept

    def test_history_is_private(self):
        a = self.store.create_user("varsha", "password1")["id"]
        b = self.store.create_user("asher", "password2")["id"]
        rid = self.store.save_report(a, "website", "https://example.com/", {"kind": "website", "x": 1})
        self.assertEqual([r["id"] for r in self.store.list_reports(a)], [rid])
        self.assertEqual(self.store.list_reports(b), [])
        self.assertIsNone(self.store.get_report(b, rid))
        self.assertFalse(self.store.delete_report(b, rid))
        self.assertEqual(self.store.get_report(a, rid)["result"], {"kind": "website", "x": 1})
        self.assertTrue(self.store.delete_report(a, rid))


class JobLineTest(unittest.TestCase):
    def test_owner_limit_and_line(self):
        runner = JobRunner(slots=1)
        gate = threading.Event()

        def slow(job):
            gate.wait(5)
            return {"kind": "data"}

        j1 = runner.start("x", 1, slow)
        j2 = runner.start("x", 2, slow)
        with self.assertRaises(Busy):                     # person 1 may have 2 going, not 3
            runner.start("x", 1, slow)
            runner.start("x", 1, slow)
        time.sleep(0.6)
        self.assertEqual(j1.status, "running")
        job, ahead = runner.get(j2.id, 2)
        self.assertEqual(job.status, "queued")            # only one slot: person 2 waits in line
        self.assertEqual(runner.get(j2.id, 1), (None, 0))  # and person 1 cannot see person 2's scan
        gate.set()
        for _ in range(50):
            if j2.status == "done":
                break
            time.sleep(0.1)
        self.assertEqual(j2.status, "done")


class WebTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._old_store = app_module.store
        app_module.store = Store(url="", sqlite_path=os.path.join(self.tmp.name, "w.db"))
        app_module._fails.clear()
        app_module.app.config["TESTING"] = True

    def tearDown(self):
        app_module.store = self._old_store
        self.tmp.cleanup()

    def client(self):
        return app_module.app.test_client()

    def _token(self, c):
        html = c.get("/", base_url="http://127.0.0.1:5050").get_data(as_text=True)
        return html.split('name="app-token" content="')[1].split('"')[0]

    def test_sign_up_scan_and_privacy(self):
        base = "http://127.0.0.1:5050"
        a, b = self.client(), self.client()
        self.assertEqual(a.get("/", base_url=base).status_code, 302)                      # must sign in first
        self.assertEqual(a.get("/api/history", base_url=base).status_code, 401)
        r = a.post("/api/auth/signup", json={"username": "anirudh", "password": "password-a"}, base_url=base)
        self.assertEqual(r.status_code, 200)
        r = b.post("/api/auth/signup", json={"username": "anirudh", "password": "password-b"}, base_url=base)
        self.assertEqual(r.status_code, 400)                                                # ID taken
        b.post("/api/auth/signup", json={"username": "bhuvii", "password": "password-b"}, base_url=base)
        ta, tb = self._token(a), self._token(b)
        self.assertEqual(a.get("/api/history", base_url=base).status_code, 401)            # no token
        r = a.post("/api/analyze", data={"sample": "1"}, headers={"X-Token": ta}, base_url=base)
        self.assertEqual(r.status_code, 200)
        rid = r.get_json()["report_id"]
        self.assertEqual(len(a.get("/api/history", headers={"X-Token": ta}, base_url=base).get_json()["reports"]), 1)
        self.assertEqual(b.get("/api/history", headers={"X-Token": tb}, base_url=base).get_json()["reports"], [])
        self.assertEqual(b.get("/api/history/" + rid, headers={"X-Token": tb}, base_url=base).status_code, 404)
        self.assertEqual(b.get("/api/history/" + rid, headers={"X-Token": ta}, base_url=base).status_code, 401)
        # sign out, then a wrong password is refused and the right one works
        a.post("/api/auth/logout", headers={"X-Token": ta}, base_url=base)
        self.assertEqual(a.get("/", base_url=base).status_code, 302)
        r = a.post("/api/auth/login", json={"username": "Anirudh", "password": "nope-nope"}, base_url=base)
        self.assertEqual(r.status_code, 401)
        r = a.post("/api/auth/login", json={"username": "Anirudh", "password": "password-a"}, base_url=base)
        self.assertEqual(r.status_code, 200)
        ta = self._token(a)
        self.assertEqual(len(a.get("/api/history", headers={"X-Token": ta}, base_url=base).get_json()["reports"]), 1)

    def test_login_needs_json(self):
        r = self.client().post("/api/auth/login", data={"username": "x", "password": "y"}, base_url="http://127.0.0.1:5050")
        self.assertEqual(r.status_code, 400)


if __name__ == "__main__":
    unittest.main()
