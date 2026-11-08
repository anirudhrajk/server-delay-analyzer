"""
jobs.py  -  runs long scans in the background so the page can show progress
============================================================================
A scan function receives a Job as its first argument and calls
job.update(progress, message) now and then. If the user pressed Cancel,
update() raises Cancelled, which stops the scan cleanly.

Several people can use the site at once:
  * every job belongs to one person (owner); nobody else can see or cancel it;
  * each person can have PER_USER scans going at a time;
  * at most SLOTS scans actually run at once on the server. The rest wait in a
    first-come, first-served line and the page shows "Waiting in line (2 ahead)".
"""
import collections
import os
import threading
import time
import traceback
import uuid

from analyzer import DataError
from scanners.common import ScanError

SLOTS = int(os.environ.get("SDA_SLOTS", "3"))     # scans running at the same moment
PER_USER = 2                                       # scans one person can have going
MAX_WAITING = 40                                   # beyond this, new scans are refused
KEEP_SECONDS = 15 * 60                             # finished jobs stay pollable this long


class Cancelled(Exception):
    pass


class Busy(Exception):
    pass


class Job:
    def __init__(self, kind, owner):
        self.id = uuid.uuid4().hex
        self.kind = kind
        self.owner = owner
        self.status = "queued"
        self.progress = 0.0
        self.message = "Waiting for a free slot…"
        self.result = None
        self.error = None
        self.report_id = None
        self.created = time.time()
        self.started = None
        self.finished = None
        self._cancel = threading.Event()

    @property
    def cancelled(self):
        return self._cancel.is_set()

    @property
    def active(self):
        return self.status in ("queued", "running")

    def cancel(self):
        self._cancel.set()

    def update(self, progress=None, message=None):
        if self._cancel.is_set():
            raise Cancelled()
        if progress is not None:
            self.progress = max(0.0, min(1.0, float(progress)))
        if message is not None:
            self.message = message

    def snapshot(self, ahead=0):
        # the page treats "queued" like "running" (keeps polling) and just shows the message
        out = {"id": self.id, "kind": self.kind, "status": "running" if self.status == "queued" else self.status,
               "queued": self.status == "queued", "progress": self.progress,
               "message": (f"Waiting in line ({ahead} ahead)…" if ahead else "Next in line…")
               if self.status == "queued" else self.message,
               "elapsed": (self.finished or time.time()) - self.created}
        if self.status == "done":
            out["result"] = self.result
            out["report_id"] = self.report_id
        if self.status == "error":
            out["error"] = self.error
        return out


class JobRunner:
    def __init__(self, slots=SLOTS, on_done=None):
        self.jobs = {}
        self.lock = threading.Lock()
        self.line = collections.deque()          # queued jobs, oldest first
        self.slots = threading.Semaphore(slots)
        self.on_done = on_done                   # on_done(job, result) -> report id, after a scan succeeds

    def _prune(self):
        now = time.time()
        for jid in [j.id for j in self.jobs.values() if not j.active and now - (j.finished or now) > KEEP_SECONDS]:
            del self.jobs[jid]

    def start(self, kind, owner, fn, *args, **kwargs):
        with self.lock:
            self._prune()
            mine = [j for j in self.jobs.values() if j.owner == owner and j.active]
            if len(mine) >= PER_USER:
                raise Busy(f"You already have {len(mine)} scans going. Wait for one to finish or cancel it.")
            if len(self.line) >= MAX_WAITING:
                raise Busy("The analyzer is very busy right now. Try again in a minute.")
            job = Job(kind, owner)
            self.jobs[job.id] = job
            self.line.append(job)

        def run():
            got = False
            try:
                while not job.cancelled:                     # wait for a free slot, in arrival order
                    with self.lock:
                        first = bool(self.line) and self.line[0] is job
                    if first and self.slots.acquire(timeout=0.5):
                        got = True
                        break
                    if not first:
                        time.sleep(0.25)
                with self.lock:
                    if job in self.line:
                        self.line.remove(job)
                if not got:
                    raise Cancelled()
                job.status, job.started, job.message = "running", time.time(), "Starting…"
                result = fn(job, *args, **kwargs)
                if self.on_done:
                    try:
                        job.report_id = self.on_done(job, result)
                    except Exception:            # the scan still worked; only saving it failed
                        traceback.print_exc()
                job.result = result
                job.progress, job.status = 1.0, "done"
            except Cancelled:
                job.status, job.message = "cancelled", "Cancelled."
            except (ScanError, DataError) as e:
                job.status, job.error = "error", str(e)
            except Exception as e:  # a bug: say so instead of hanging
                traceback.print_exc()
                job.status, job.error = "error", f"Unexpected error: {type(e).__name__}: {e}"
            finally:
                job.finished = time.time()
                if got:
                    self.slots.release()

        threading.Thread(target=run, name=f"job-{kind}-{job.id[:8]}", daemon=True).start()
        return job

    def get(self, job_id, owner):
        """(job, how many are ahead of it in line), only if the job belongs to this person."""
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None or job.owner != owner:
                return None, 0
            ahead = self.line.index(job) if job.status == "queued" and job in self.line else 0
            return job, ahead
