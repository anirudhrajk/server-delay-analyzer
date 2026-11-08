"""
store.py  -  accounts and saved reports
=======================================
Each person signs in with their own user ID and password, and every report they
make is saved to their own history.

Where it is kept:
  * DATABASE_URL set (PostgreSQL: Neon, Render Postgres, Supabase...)  -> there.
    Use this online: a file inside a cloud container is wiped on every deploy.
  * otherwise a SQLite file next to the app (sda.db), fine on your own computer.

Passwords are never stored, only a salted scrypt hash (werkzeug).
"""
import json
import os
import queue
import re
import sqlite3
import threading
import time
import uuid

from werkzeug.security import check_password_hash, generate_password_hash

HERE = os.path.dirname(os.path.abspath(__file__))
KEEP_PER_USER = 100           # oldest reports beyond this are removed
USER_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")


class AccountError(Exception):
    pass


def _clean_url(url):
    url = (url or "").strip()
    if url.startswith("DATABASE_URL="):
        url = url[len("DATABASE_URL="):].strip()
    return url.strip("\"'").strip()


class Store:
    def __init__(self, url=None, sqlite_path=None):
        url = _clean_url(os.environ.get("DATABASE_URL", "") if url is None else url)
        self.pg = url.startswith(("postgres://", "postgresql://"))
        if self.pg:
            import psycopg  # only needed online
            self._psycopg = psycopg
            self.url = url
            self._pool = queue.LifoQueue(maxsize=4)
            self.ph = "%s"
        else:
            self.path = sqlite_path or os.path.join(HERE, "sda.db")
            self.ph = "?"
        self._schema_lock = threading.Lock()
        self._init()

    @property
    def kind(self):
        return "PostgreSQL" if self.pg else "SQLite"

    # ------------------------------------------------------------ connections
    def _connect(self):
        if self.pg:
            return self._psycopg.connect(
                self.url, connect_timeout=10, keepalives=1, keepalives_idle=30,
                keepalives_interval=10, keepalives_count=3,
                options="-c statement_timeout=15000")
        c = sqlite3.connect(self.path, timeout=15)
        c.execute("PRAGMA foreign_keys = ON")
        return c

    def _run(self, sql, args=(), fetch=None):
        """Run one statement in its own transaction. fetch: None, 'one' or 'all'."""
        sql = sql.replace("?", self.ph)
        for attempt in (0, 1):
            conn = None
            try:
                if self.pg:
                    try:
                        conn = self._pool.get_nowait()
                    except queue.Empty:
                        conn = self._connect()
                else:
                    conn = self._connect()
                cur = conn.cursor()
                cur.execute(sql, args)
                out = cur.fetchone() if fetch == "one" else cur.fetchall() if fetch == "all" else cur.rowcount
                conn.commit()
                if self.pg:
                    try:
                        self._pool.put_nowait(conn)
                        conn = None
                    except queue.Full:
                        pass
                return out
            except Exception as e:
                broken = self.pg and isinstance(e, self._psycopg.OperationalError)
                if conn is not None:
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                if broken and attempt == 0:   # the database closed an idle connection: retry once
                    try:
                        conn.close()
                    except Exception:
                        pass
                    conn = None
                    continue
                raise
            finally:
                if conn is not None:
                    try:
                        conn.close()
                    except Exception:
                        pass

    def _init(self):
        idcol = "SERIAL PRIMARY KEY" if self.pg else "INTEGER PRIMARY KEY AUTOINCREMENT"
        with self._schema_lock:
            self._run(f"""CREATE TABLE IF NOT EXISTS sda_users (
                id {idcol},
                username TEXT NOT NULL,
                username_key TEXT NOT NULL UNIQUE,
                pw_hash TEXT NOT NULL,
                created DOUBLE PRECISION NOT NULL)""")
            self._run("""CREATE TABLE IF NOT EXISTS sda_history (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES sda_users(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                target TEXT NOT NULL,
                created DOUBLE PRECISION NOT NULL,
                result TEXT NOT NULL)""")
            self._run("CREATE INDEX IF NOT EXISTS sda_history_user ON sda_history (user_id, created)")

    # ------------------------------------------------------------ accounts
    def create_user(self, username, password):
        username = (username or "").strip()
        if not USER_RE.match(username):
            raise AccountError("User ID: 3 to 32 letters, numbers, dots, dashes or underscores.")
        if len(password or "") < 8:
            raise AccountError("Password: at least 8 characters.")
        if len(password) > 200:
            raise AccountError("Password is too long.")
        if self._run("SELECT id FROM sda_users WHERE username_key = ?", (username.lower(),), "one"):
            raise AccountError("That user ID is taken. Pick another one.")
        try:
            self._run("INSERT INTO sda_users (username, username_key, pw_hash, created) VALUES (?, ?, ?, ?)",
                      (username, username.lower(), generate_password_hash(password), time.time()))
        except Exception as e:
            if "unique" in str(e).lower():
                raise AccountError("That user ID is taken. Pick another one.")
            raise
        return self.find_user(username)

    def find_user(self, username):
        row = self._run("SELECT id, username, pw_hash FROM sda_users WHERE username_key = ?",
                        ((username or "").strip().lower(),), "one")
        return {"id": row[0], "username": row[1], "pw_hash": row[2]} if row else None

    def user_by_id(self, user_id):
        row = self._run("SELECT id, username FROM sda_users WHERE id = ?", (user_id,), "one")
        return {"id": row[0], "username": row[1]} if row else None

    def check_login(self, username, password):
        u = self.find_user(username)
        if u and check_password_hash(u["pw_hash"], password or ""):
            return {"id": u["id"], "username": u["username"]}
        if not u:   # same work either way, so timing does not reveal which IDs exist
            check_password_hash(_DUMMY_HASH, password or "")
        return None

    # ------------------------------------------------------------ history
    def save_report(self, user_id, kind, target, result):
        rid = uuid.uuid4().hex[:16]
        self._run("INSERT INTO sda_history (id, user_id, kind, target, created, result) VALUES (?, ?, ?, ?, ?, ?)",
                  (rid, user_id, kind, (target or "")[:500], time.time(), json.dumps(result, default=str)))
        old = self._run("SELECT id FROM sda_history WHERE user_id = ? ORDER BY created DESC LIMIT 1000 OFFSET ?",
                        (user_id, KEEP_PER_USER), "all")
        for (oid,) in old:
            self._run("DELETE FROM sda_history WHERE id = ? AND user_id = ?", (oid, user_id))
        return rid

    def list_reports(self, user_id, limit=KEEP_PER_USER):
        rows = self._run("SELECT id, kind, target, created FROM sda_history WHERE user_id = ? "
                         "ORDER BY created DESC LIMIT ?", (user_id, limit), "all")
        return [{"id": r[0], "kind": r[1], "target": r[2], "created": r[3]} for r in rows]

    def get_report(self, user_id, report_id):
        row = self._run("SELECT kind, target, created, result FROM sda_history WHERE id = ? AND user_id = ?",
                        (report_id, user_id), "one")
        if not row:
            return None
        return {"id": report_id, "kind": row[0], "target": row[1], "created": row[2], "result": json.loads(row[3])}

    def delete_report(self, user_id, report_id):
        return self._run("DELETE FROM sda_history WHERE id = ? AND user_id = ?", (report_id, user_id)) > 0

    def clear_reports(self, user_id):
        return self._run("DELETE FROM sda_history WHERE user_id = ?", (user_id,))


_DUMMY_HASH = generate_password_hash("not-a-real-password")
