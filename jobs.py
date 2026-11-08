"""
jobs.py  -  runs long scans in the background so the page can show progress
============================================================================
A scan function receives a Job as its first argument and calls
job.update(progress, message) now and then. If the user pressed Cancel,
update() raises Cancelled, which stops the scan cleanly.
"""
import threading
import time
import traceback
import uuid

from analyzer import DataError
from scanners.common import ScanError

MAX_RUNNING = 2
KEEP = 30


class Cancelled(Exception):
    pass


class Busy(Exception):
    pass


class Job:
    def __init__(self, kind):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.status = "running"
        self.progress = 0.0
        self.message = "Starting…"
        self.result = None
        self.error = None
        self.started = time.time()
        self.finished = None
        self._cancel = threading.Event()

    @property
    def cancelled(self):
        return self._cancel.is_set()

    def cancel(self):
        self._cancel.set()

    def update(self, progress=None, message=None):
        if self._cancel.is_set():
            raise Cancelled()
        if progress is not None:
            self.progress = max(0.0, min(1.0, float(progress)))
        if message is not None:
            self.message = message

    def snapshot(self):
        out = {"id": self.id, "kind": self.kind, "status": self.status,
               "progress": self.progress, "message": self.message,
               "elapsed": (self.finished or time.time()) - self.started}
        if self.status == "done":
            out["result"] = self.result
        if self.status == "error":
            out["error"] = self.error
        return out


class JobRunner:
    def __init__(self):
        self.jobs = {}
        self.lock = threading.Lock()

    def start(self, kind, fn, *args, **kwargs):
        with self.lock:
            running = [j for j in self.jobs.values() if j.status == "running"]
            if len(running) >= MAX_RUNNING:
                raise Busy("Another scan is still running. Wait for it to finish or cancel it.")
            job = Job(kind)
            self.jobs[job.id] = job
            old = sorted(self.jobs.values(), key=lambda j: j.started)[:-KEEP]
            for j in old:
                if j.status != "running":
                    del self.jobs[j.id]

        def run():
            try:
                job.result = fn(job, *args, **kwargs)
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

        threading.Thread(target=run, name=f"job-{kind}-{job.id}", daemon=True).start()
        return job

    def get(self, job_id):
        with self.lock:
            return self.jobs.get(job_id)
