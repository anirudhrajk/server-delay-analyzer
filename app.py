"""
app.py  -  Server Delay Analyzer (local website)
================================================
    pip install -r requirements.txt
    python app.py
then open http://127.0.0.1:5050  (the address is also printed when it starts)

What it can scan:
  Website   where the time goes when a page loads (scanners/website.py)
  Folder    why a folder is slow to read, copy or sync (scanners/folder.py)
  Program   a running process, a command, or tune a program's threads and
            batch size with our formula (scanners/program.py)
  Your data an uploaded CSV of measurements (analyzer.py)

Safety: the server only listens on 127.0.0.1 (this computer). Because it can run
commands and read folders, every request must also carry a secret token that is
put into the page when you open it, so no other website you visit can use it.
"""
import hmac
import os
import secrets

from flask import Flask, Response, abort, jsonify, request, send_from_directory

from analyzer import DataError, analyse, make_sample, parse_csv
from jobs import Busy, JobRunner
from scanners import folder, program, website
from scanners.common import ScanError

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
TOKEN = secrets.token_urlsafe(24)
# Hosted mode (SDA_HOSTED=1, set on Render): the site is public, so everything that
# touches the server's own files, programs or commands is switched off, and the
# tuner only runs the built-in demo server.
HOSTED = os.environ.get("SDA_HOSTED") == "1"
LOCAL_ONLY = {"/api/scan/folder", "/api/processes", "/api/scan/process", "/api/scan/command"}
DEMO_TEMPLATE = "python samples/demo_server.py --threads {n} --batch {b}"
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
OPEN_PATHS = {"/api/health", "/api/sample"}

app = Flask(__name__, static_folder=WEB, static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024  # 10 MB upload limit
jobs = JobRunner()


# ---------------------------------------------------------------- safety checks
def _hostname(hostport):
    """'127.0.0.1:5000' -> '127.0.0.1',  '[::1]:5000' -> '[::1]'."""
    hp = (hostport or "").lower().split("/", 1)[0]
    return hp.split("]")[0] + "]" if hp.startswith("[") else hp.rsplit(":", 1)[0]


@app.before_request
def only_this_computer():
    if HOSTED:
        origin = request.headers.get("Origin")
        if origin and _hostname(origin.split("://", 1)[-1]) != _hostname(request.host):
            abort(403)                  # blocks other websites
        if request.path in LOCAL_ONLY:
            return jsonify(error="This scan only works when you run the analyzer on your own computer."), 403
    elif _hostname(request.host) not in LOCAL_HOSTS:
        abort(403)                      # blocks DNS-rebinding tricks
    origin = request.headers.get("Origin")
    if not HOSTED and origin and _hostname(origin.split("://", 1)[-1]) not in LOCAL_HOSTS:
        abort(403)                      # blocks other websites
    if request.path.startswith("/api/") and request.path not in OPEN_PATHS:
        if not hmac.compare_digest(request.headers.get("X-Token", ""), TOKEN):
            return jsonify(error="This page is out of date. Reload it (the server was restarted)."), 401


@app.after_request
def no_cache(resp):
    if request.path == "/" or request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


# ---------------------------------------------------------------- pages
@app.route("/")
def index():
    with open(os.path.join(WEB, "index.html"), encoding="utf-8") as f:
        html = f.read().replace("{{APP_TOKEN}}", TOKEN).replace("{{APP_HOSTED}}", "1" if HOSTED else "")
    return Response(html, mimetype="text/html")


@app.route("/api/health")
def health():
    return jsonify(ok=True)


@app.route("/api/sample")
def sample():
    return Response(make_sample(), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=sample_server_log.csv"})


# ---------------------------------------------------------------- uploaded data
def _current(t, bs):
    t, bs = (str(t or "").strip(), str(bs or "").strip())
    if not t and not bs:
        return None
    try:
        t, bs = float(t), float(bs)
    except ValueError:
        raise DataError("Current threads and batch size must both be numbers (or leave both empty).")
    if t <= 0 or bs <= 0:
        raise DataError("Current threads and batch size must be greater than 0.")
    return t, bs


@app.route("/api/analyze", methods=["POST"])
def api_analyze():
    try:
        f = request.files.get("file")
        if f is not None and f.filename:
            raw = f.read()
        elif request.form.get("sample") == "1":
            raw = make_sample().encode()
        else:
            raise DataError("Choose a CSV file to upload.")
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise DataError("The file is not a text CSV file.")
        n, b, d, skipped = parse_csv(text)
        result = analyse(n, b, d, _current(request.form.get("threads"), request.form.get("batch")))
        result["skipped_rows"] = skipped
        result["kind"] = "data"
        return jsonify(result)
    except DataError as e:
        return jsonify(error=str(e)), 400


# ---------------------------------------------------------------- scans (run in the background)
def _start(kind, fn, *args, **kwargs):
    try:
        job = jobs.start(kind, fn, *args, **kwargs)
    except Busy as e:
        return jsonify(error=str(e)), 429
    return jsonify(job=job.id)


def _body():
    return request.get_json(silent=True) or {}


@app.route("/api/scan/website", methods=["POST"])
def scan_website():
    b = _body()
    try:
        url = website.normalise_url(b.get("url"))
        samples = int(b.get("samples", 3))
    except (ScanError, ValueError) as e:
        return jsonify(error=str(e)), 400
    return _start("website", website.scan_website, url, samples, bool(b.get("files", True)))


@app.route("/api/scan/folder", methods=["POST"])
def scan_folder():
    b = _body()
    try:
        read_mb = int(b.get("read_mb", 256))
    except ValueError:
        return jsonify(error="Read limit must be a number."), 400
    return _start("folder", folder.scan_folder, b.get("path", ""), read_mb)


@app.route("/api/processes")
def processes():
    try:
        return jsonify(processes=program.list_processes())
    except ScanError as e:
        return jsonify(error=str(e)), 400


@app.route("/api/scan/process", methods=["POST"])
def scan_process():
    b = _body()
    try:
        pid, seconds = int(b.get("pid")), float(b.get("seconds", 10))
    except (TypeError, ValueError):
        return jsonify(error="Pick a program from the list."), 400
    return _start("process", program.watch_process, pid, seconds)


@app.route("/api/scan/command", methods=["POST"])
def scan_command():
    b = _body()
    try:
        repeats, timeout = int(b.get("repeats", 3)), float(b.get("timeout", 120))
    except (TypeError, ValueError):
        return jsonify(error="Repeats and time limit must be numbers."), 400
    if not str(b.get("command", "")).strip():
        return jsonify(error="Type a command to run, for example:  python my_script.py"), 400
    return _start("command", program.run_command, b.get("command"), b.get("cwd", ""), repeats, timeout,
                  bool(b.get("shell")), default_cwd=HERE)


@app.route("/api/scan/tune", methods=["POST"])
def scan_tune():
    b = _body()
    try:
        repeats, timeout = int(b.get("repeats", 1)), float(b.get("timeout", 60))
        current = _current(b.get("current_n"), b.get("current_b"))
        template = str(b.get("template", ""))
        if "{n}" not in template or "{b}" not in template:
            raise ScanError("The command must contain {n} where the number of threads goes and {b} where the batch "
                            "size goes, for example:  python my_server.py --threads {n} --batch {b}")
        ns = program.parse_values(b.get("n_values"), "Threads")
        bs = program.parse_values(b.get("b_values"), "Batch sizes")
        if HOSTED:
            if " ".join(template.split()) != DEMO_TEMPLATE or b.get("shell") or str(b.get("cwd", "")).strip():
                raise ScanError("On the website only the demo server can be tuned. "
                                "Run the analyzer on your own computer to tune your own program.")
            if max(ns + bs) > 64:
                raise ScanError("On the website, threads and batch sizes go up to 64.")
    except (ScanError, DataError, TypeError, ValueError) as e:
        return jsonify(error=str(e)), 400
    return _start("tune", program.tune, template, b.get("n_values"), b.get("b_values"), repeats,
                  "printed" if b.get("metric") == "printed" else "time", b.get("cwd", ""), timeout,
                  bool(b.get("shell")), current, default_cwd=HERE)


@app.route("/api/jobs/<job_id>")
def job_status(job_id):
    job = jobs.get(job_id)
    if job is None:
        return jsonify(error="This scan is no longer available. Start it again."), 404
    return jsonify(job.snapshot())


@app.route("/api/jobs/<job_id>/cancel", methods=["POST"])
def job_cancel(job_id):
    job = jobs.get(job_id)
    if job is None:
        return jsonify(error="Unknown scan."), 404
    job.cancel()
    return jsonify(ok=True)


@app.errorhandler(413)
def too_big(_):
    return jsonify(error="The file is larger than 10 MB."), 413


@app.errorhandler(403)
def forbidden(_):
    return jsonify(error="This request was blocked." if HOSTED else "Only this computer can use the analyzer."), 403


DEFAULT_PORT = 5050   # not 5000: other projects (e.g. SignBridge) often use 5000


def _port_in_use(port):
    """True if something already answers on 127.0.0.1:port. (Windows lets two servers
    share a port silently, and the older one keeps the traffic, so check first.)"""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _free_port(start):
    for port in range(start, start + 20):
        if not _port_in_use(port):
            return port
    raise SystemExit(f"Ports {start}-{start + 19} are all busy. Close another server and try again.")


if __name__ == "__main__":
    wanted = int(os.environ.get("PORT", DEFAULT_PORT))
    port = _free_port(wanted)
    if port != wanted:
        print(f"\n  Port {wanted} is already used by another program, so using {port} instead.")
    print(f"\n  Server Delay Analyzer running at  http://127.0.0.1:{port}\n  Press Ctrl+C to stop.\n")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
