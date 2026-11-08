"""
program.py  -  why is a program slow?
=====================================
Three tools:

watch_process  Watch a program that is already running for a few seconds:
               CPU use, disk traffic, memory, threads, network connections,
               and what the rest of the computer is doing.
run_command    Run a command a few times and split its time into
               "busy on the CPU" and "waiting" (disk, network, sleep, locks).
tune           Our formula on a real program. The command contains {n} (threads)
               and {b} (batch size). We
                 1. MEASURE a grid of settings,
                 2. FIT    D(n,b) = D0 + A/n + B*n + C/b + E*b + k*n*b,
                 3. SOLVE  for its best setting (Newton + Hessian check),
                 4. VERIFY by running that setting for real, refit, repeat,
               and finally re-run the two best settings to confirm the winner.
               The answer is always a setting that was really measured.
"""
import ctypes
import os
import re
import shlex
import statistics
import subprocess
import sys
import threading
import time

import numpy as np

try:
    import psutil
except ImportError:  # the page explains how to install it
    psutil = None

from analyzer import analyse
from delay_model import delay
from .common import ScanError, cause, fmt_bytes, fmt_ms, sort_causes, stat, table

WINDOWS = os.name == "nt"
CREATE_NO_WINDOW = 0x08000000
MAX_TUNE_RUNS = 150
REFINE_ROUNDS = 4
ZOOM_ROUNDS = 3


def _grid_ratio(vals):
    """Typical ratio between neighbouring values (2 for 1,2,4,8)."""
    r = [b / a for a, b in zip(vals, vals[1:]) if a > 0]
    return max(1.2, float(np.exp(np.median(np.log(r))))) if r else 2.0
METRIC_RE = re.compile(r"delay_ms\s*[=:]\s*([0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)", re.I)


def _need_psutil():
    if psutil is None:
        raise ScanError("The 'psutil' package is missing. In the VS Code terminal run:  pip install -r requirements.txt")


# --------------------------------------------------------------------------------------
# exact CPU and disk totals of a finished process (Windows keeps them while we hold its handle)
# --------------------------------------------------------------------------------------
class _FILETIME(ctypes.Structure):
    _fields_ = [("lo", ctypes.c_uint32), ("hi", ctypes.c_uint32)]


class _IO(ctypes.Structure):
    _fields_ = [(f, ctypes.c_ulonglong) for f in
                ("ReadOps", "WriteOps", "OtherOps", "ReadBytes", "WriteBytes", "OtherBytes")]


def _win_totals(handle):
    """(cpu_seconds, read_bytes, write_bytes) for a process handle, or None."""
    try:
        k32 = ctypes.windll.kernel32
        c, e, k, u = _FILETIME(), _FILETIME(), _FILETIME(), _FILETIME()
        if not k32.GetProcessTimes(ctypes.c_void_p(int(handle)), ctypes.byref(c), ctypes.byref(e), ctypes.byref(k), ctypes.byref(u)):
            return None
        cpu = ((k.hi << 32 | k.lo) + (u.hi << 32 | u.lo)) / 1e7
        io = _IO()
        if k32.GetProcessIoCounters(ctypes.c_void_p(int(handle)), ctypes.byref(io)):
            return cpu, io.ReadBytes, io.WriteBytes
        return cpu, 0, 0
    except Exception:
        return None


def _kill_tree(pid):
    try:
        parent = psutil.Process(pid)
        kids = parent.children(recursive=True)
    except psutil.Error:
        kids, parent = [], None
    for p in kids + ([parent] if parent else []):
        try:
            p.kill()
        except psutil.Error:
            pass


def _split_command(command, shell):
    command = (command or "").strip()
    if not command:
        raise ScanError("Type a command to run, for example:  python my_script.py")
    if shell or WINDOWS:
        return command          # Windows parses the command line itself
    try:
        return shlex.split(command)
    except ValueError as e:
        raise ScanError(f"Could not read the command: {e}")


def _check_cwd(cwd, default):
    cwd = (cwd or "").strip().strip('"') or default
    cwd = os.path.abspath(os.path.expanduser(cwd))
    if not os.path.isdir(cwd):
        raise ScanError(f"The working folder does not exist: {cwd}")
    return cwd


def run_once(job, command, cwd, timeout, shell, want_metric=False):
    """Run one command, measuring wall time, CPU time, disk traffic and peak memory."""
    _need_psutil()
    args = _split_command(command, shell)
    tail = bytearray()
    flags = CREATE_NO_WINDOW if WINDOWS else 0
    t0 = time.perf_counter()
    try:
        proc = subprocess.Popen(args, cwd=cwd, shell=shell, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, creationflags=flags)
    except FileNotFoundError:
        raise ScanError("Could not find the program in that command. Check the spelling, or tick "
                        "'Run through the command shell' for built-in commands like dir.")
    except OSError as e:
        raise ScanError(f"Could not start the command: {e}")

    def pump():
        for chunk in iter(lambda: proc.stdout.read(4096), b""):
            tail.extend(chunk)
            if len(tail) > 65536:
                del tail[:-65536]
    reader = threading.Thread(target=pump, daemon=True)
    reader.start()

    try:
        ps = psutil.Process(proc.pid)
    except psutil.Error:
        ps = None
    kid_cpu, kid_io, main_cpu, main_io = {}, {}, 0.0, (0, 0)
    peak_rss, peak_threads, net, timed_out, last_net = 0, 0, False, False, 0.0
    try:
        while True:
            try:
                proc.wait(timeout=0.05)
                break
            except subprocess.TimeoutExpired:
                pass
            if time.perf_counter() - t0 > timeout:
                timed_out = True
                break
            job.update()  # raises Cancelled if the user pressed Cancel
            if ps is None:
                continue
            try:
                with ps.oneshot():
                    ct = ps.cpu_times()
                    main_cpu = ct.user + ct.system
                    rss, threads = ps.memory_info().rss, ps.num_threads()
                    try:
                        io = ps.io_counters()
                        main_io = (io.read_bytes, io.write_bytes)
                    except (psutil.Error, AttributeError):
                        pass
                for k in ps.children(recursive=True):
                    try:
                        with k.oneshot():
                            kt = k.cpu_times()
                            kid_cpu[k.pid] = kt.user + kt.system
                            rss += k.memory_info().rss
                            threads += k.num_threads()
                            try:
                                kio = k.io_counters()
                                kid_io[k.pid] = (kio.read_bytes, kio.write_bytes)
                            except (psutil.Error, AttributeError):
                                pass
                    except psutil.Error:
                        pass
                peak_rss, peak_threads = max(peak_rss, rss), max(peak_threads, threads)
                if time.perf_counter() - last_net > 1.0:
                    last_net = time.perf_counter()
                    try:
                        net = net or any(c.raddr for c in ps.net_connections(kind="inet"))
                    except (psutil.Error, AttributeError):
                        pass
            except psutil.Error:
                pass
    finally:
        if proc.poll() is None:
            _kill_tree(proc.pid)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
    wall = time.perf_counter() - t0
    if WINDOWS:
        exact = _win_totals(getattr(proc, "_handle", 0))
        if exact:
            main_cpu, main_io = exact[0], (exact[1], exact[2])
    reader.join(timeout=2)
    try:
        proc.stdout.close()
    except OSError:
        pass
    out = tail.decode("utf-8", errors="replace")
    cpu = main_cpu + sum(kid_cpu.values())
    rd = main_io[0] + sum(v[0] for v in kid_io.values())
    wr = main_io[1] + sum(v[1] for v in kid_io.values())
    metric = None
    if want_metric:
        found = METRIC_RE.findall(out)
        metric = float(found[-1]) if found else None
    return {"wall_ms": wall * 1000, "cpu_ms": cpu * 1000, "cores": cpu / wall if wall > 0 else 0.0,
            "read": rd, "write": wr, "peak_rss": peak_rss, "threads": peak_threads, "net": net,
            "exit": proc.returncode, "timed_out": timed_out, "output": out[-4000:], "metric": metric}


# --------------------------------------------------------------------------------------
# run a command a few times
# --------------------------------------------------------------------------------------
def run_command(job, command, cwd, repeats=3, timeout=120, shell=False, default_cwd="."):
    cwd = _check_cwd(cwd, default_cwd)
    repeats = max(1, min(int(repeats), 10))
    timeout = max(1, min(float(timeout), 3600))
    runs = []
    for i in range(repeats):
        job.update(i / repeats, f"Run {i + 1} of {repeats}…")
        r = run_once(job, command, cwd, timeout, shell)
        runs.append(r)
        if r["timed_out"]:
            break
    return _command_report(command, cwd, runs, timeout)


def _command_report(command, cwd, runs, timeout):
    walls = [r["wall_ms"] for r in runs]
    med = statistics.median(walls)
    cores = statistics.median([r["cores"] for r in runs])
    logical = psutil.cpu_count() or 1
    busy = statistics.median([min(r["cpu_ms"], r["wall_ms"]) for r in runs])
    waiting = max(0.0, med - busy)
    io_rate = statistics.median([(r["read"] + r["write"]) / max(1e-9, r["wall_ms"] / 1000) for r in runs])
    peak = max(r["peak_rss"] for r in runs)
    net = any(r["net"] for r in runs)
    causes, notes, first_causes = [], [], []

    last = runs[-1]
    if last["timed_out"]:
        first_causes.append(cause("The command did not finish", f"It was still running after {timeout:.0f} s and was stopped.",
                            "Raise the time limit, or check whether it is stuck waiting for input.", f">{timeout:.0f} s", "high", timeout * 1000))
    elif last["exit"] not in (0, None):
        first_causes.append(cause("The command failed", f"It ended with exit code {last['exit']}. Its last output is shown below.",
                            "Fix the error first: a failing run is not a fair speed test.", "", "high", 0))

    share = waiting / med if med else 0
    if share > 0.5 and med > 200:
        if io_rate > 20 * 1048576:
            why, fix, name = (f"It moves {fmt_bytes(io_rate)}/s to and from disk and spends {share:.0%} of its time not using the CPU.",
                              "Read and write in bigger blocks, cache results, or use a faster drive.", "Waiting for the disk")
        elif net:
            why, fix, name = (f"It has network connections open and spends {share:.0%} of its time not using the CPU.",
                              "Make fewer, bigger network calls, run them in parallel, or cache answers.", "Waiting for the network")
        else:
            why, fix, name = (f"It spends {share:.0%} of its time neither computing nor using the disk much.",
                              "Look for sleeps, timeouts, locks, or a slow service it calls.", "Waiting (sleeping, locks or another service)")
        causes.append(cause(name, why, fix, f"{fmt_ms(waiting)}", "high" if share > 0.75 else "medium", waiting))
    if 0.8 <= cores <= 1.2 and logical > 1 and med > 1000:
        gain = med - med / min(logical, 4)
        causes.append(cause("Uses only one CPU core",
                            f"It keeps one core busy while {logical - 1} others sit idle.",
                            "Split the work across threads or processes (for example with a pool of workers).",
                            f"up to −{fmt_ms(gain)}", "medium", gain))
    if cores > 0.85 * logical:
        causes.append(cause("All CPU cores are busy",
                            f"It uses about {cores:.1f} of {logical} cores the whole time.",
                            "Do less work (better algorithm, caching) or use a faster computer.", "", "medium", 0))
    if len(runs) >= 3:
        first, rest = walls[0], statistics.median(walls[1:])
        if first > 1.3 * rest and first - rest > 100:
            causes.append(cause("The first run is slower",
                                f"Run 1 took {fmt_ms(first)}, later runs about {fmt_ms(rest)}: files and libraries were loaded from disk the first time.",
                                "Normal after a restart. Keep the program running (a server or daemon) instead of starting it fresh each time.",
                                f"+{fmt_ms(first - rest)}", "low", first - rest))
        lo, hi = min(walls[1:]), max(walls[1:])
        if hi - lo > 0.2 * rest and hi - lo > 100:
            causes.append(cause("Run time varies a lot",
                                f"Repeat runs took between {fmt_ms(lo)} and {fmt_ms(hi)}.",
                                "Close other heavy programs while measuring, and check for background tasks.",
                                f"±{fmt_ms((hi - lo) / 2)}", "low", (hi - lo) / 2))
    vm = psutil.virtual_memory()
    if peak > 0.5 * vm.available:
        causes.append(cause("Uses a lot of memory", f"It needed up to {fmt_bytes(peak)}; only {fmt_bytes(vm.available)} is free.",
                            "Process data in smaller pieces, or close other programs.", "", "medium", 0))
    causes = first_causes + sort_causes(causes)   # a failed or stuck run always comes first

    level = "bad" if any(c["severity"] == "high" for c in causes) else "warn" if any(c["severity"] == "medium" for c in causes) else "good"
    title = f"The command takes {fmt_ms(med)}" + (" — mostly waiting." if share > 0.5 else " — mostly computing." if med > 50 else ".")
    top = [c["name"].lower() for c in causes if c["severity"] in ("high", "medium")][:2]
    stats = [stat("Typical run time", fmt_ms(med), f"middle of {len(runs)} run{'s' if len(runs) > 1 else ''}", "warm" if level != "good" else "good"),
             stat("CPU cores used", f"{cores:.2f}", f"of {logical} on this computer"),
             stat("Time spent waiting", f"{share:.0%}", fmt_ms(waiting), "warm" if share > 0.5 else "good"),
             stat("Peak memory", fmt_bytes(peak) if peak else "—", f"disk: {fmt_bytes(io_rate)}/s")]
    rows = [{"label": f"Run {i + 1}", "total": r["wall_ms"],
             "parts": [{"key": "cpu", "label": "Busy on the CPU", "value": min(r["cpu_ms"], r["wall_ms"])},
                       {"key": "waiting", "label": "Waiting (disk, network, sleep, locks)", "value": max(0.0, r["wall_ms"] - r["cpu_ms"])}]}
            for i, r in enumerate(runs)]
    tables = [table("Each run", ["Run", "Time", "CPU time", "Cores used", "Disk read", "Disk written", "Peak memory", "Exit code"],
                    [[str(i + 1), fmt_ms(r["wall_ms"]), fmt_ms(r["cpu_ms"]), f"{r['cores']:.2f}", fmt_bytes(r["read"]),
                      fmt_bytes(r["write"]), fmt_bytes(r["peak_rss"]), "timed out" if r["timed_out"] else str(r["exit"])]
                     for i, r in enumerate(runs)])]
    notes += [f"Command: {command}   (in {cwd})",
              "When a program uses several cores, its CPU time can be larger than its run time; the bars then show it as fully busy.",
              "CPU time of short-lived helper processes is sampled every 50 ms, so very short helpers may be under-counted."]
    return {"kind": "command", "target": command,
            "verdict": {"title": title, "sub": ("Biggest delays: " + " and ".join(top) + ".") if top else "No major problems found.", "level": level},
            "stats": stats, "causes": causes,
            "breakdown": {"title": "Where the time goes", "note": "Each run split into computing and waiting.", "rows": rows},
            "charts": [], "tables": tables, "notes": notes, "output": last["output"][-2000:]}


# --------------------------------------------------------------------------------------
# watch a running process
# --------------------------------------------------------------------------------------
def list_processes(limit=60):
    _need_psutil()
    procs = []
    for p in psutil.process_iter(["pid", "name", "memory_info"]):
        try:
            p.cpu_percent(None)
            procs.append(p)
        except psutil.Error:
            pass
    time.sleep(0.5)
    out = []
    for p in procs:
        try:
            out.append({"pid": p.pid, "name": p.info["name"] or "?", "cpu": p.cpu_percent(None),
                        "mem": p.info["memory_info"].rss if p.info["memory_info"] else 0})
        except psutil.Error:
            pass
    out = [x for x in out if x["pid"] not in (0, 4) and x["name"] not in ("System Idle Process",)]
    out.sort(key=lambda x: (-x["cpu"], -x["mem"]))
    return out[:limit]


def watch_process(job, pid, seconds=10):
    _need_psutil()
    seconds = max(3, min(float(seconds), 120))
    try:
        p = psutil.Process(int(pid))
        name = p.name()
        p.cpu_times()
    except (ValueError, TypeError):
        raise ScanError("Pick a program from the list.")
    except psutil.NoSuchProcess:
        raise ScanError("That program has already closed. Refresh the list.")
    except psutil.AccessDenied:
        raise ScanError("Windows does not let other programs look inside this one (it belongs to the system). "
                        "Pick one of your own programs, or start VS Code as administrator.")
    logical = psutil.cpu_count() or 1
    psutil.cpu_percent(None)
    t_list, cpu_list, disk_list, sys_list = [], [], [], []
    def snap():
        with p.oneshot():
            ct = p.cpu_times()
            try:
                io = p.io_counters()
                ioc = (io.read_bytes, io.write_bytes, io.read_count + io.write_count)
            except (psutil.Error, AttributeError):
                ioc = (0, 0, 0)
            mem = p.memory_info()
            return ct.user + ct.system, ioc, mem.rss, p.num_threads(), p.num_ctx_switches()
    try:
        c0, io0, rss0, thr0, cs0 = snap()
    except psutil.Error as e:
        raise ScanError(f"Could not read the program: {e}")
    t0 = time.perf_counter()
    prev_t, prev_c, prev_io = t0, c0, io0
    peak_rss, peak_thr, ended, conns = rss0, thr0, False, []
    while time.perf_counter() - t0 < seconds:
        time.sleep(0.5)
        job.update((time.perf_counter() - t0) / seconds, f"Watching {name}… {time.perf_counter() - t0:.0f} of {seconds:.0f} s")
        try:
            c, io, rss, thr, _ = snap()
        except psutil.NoSuchProcess:
            ended = True
            break
        except psutil.Error:
            continue
        now = time.perf_counter()
        dt = now - prev_t
        t_list.append(round(now - t0, 1))
        cpu_list.append(round((c - prev_c) / dt, 3))
        disk_list.append(round(((io[0] - prev_io[0]) + (io[1] - prev_io[1])) / dt / 1048576, 3))
        sys_list.append(psutil.cpu_percent(None))
        prev_t, prev_c, prev_io = now, c, io
        peak_rss, peak_thr = max(peak_rss, rss), max(peak_thr, thr)
    try:
        conns = [c for c in p.net_connections(kind="inet") if c.raddr]
    except (psutil.Error, AttributeError):
        conns = []
    try:
        _, _, _, _, cs1 = snap()
        cs_rate = ((cs1.voluntary + cs1.involuntary) - (cs0.voluntary + cs0.involuntary)) / max(1e-9, prev_t - t0)
    except psutil.Error:
        cs_rate = None
    window = max(1e-9, prev_t - t0)
    cores = (prev_c - c0) / window
    disk = ((prev_io[0] - io0[0]) + (prev_io[1] - io0[1])) / window
    ops = (prev_io[2] - io0[2]) / window
    sys_cpu = statistics.mean(sys_list) if sys_list else psutil.cpu_percent(None)
    vm = psutil.virtual_memory()

    causes = []
    if sys_cpu > 90 and cores < 0.5 * logical:
        causes.append(cause("The computer's CPU is full",
                            f"The whole computer is at {sys_cpu:.0f}% CPU, mostly because of other programs, so {name} has to wait its turn.",
                            "Close heavy programs, or check Task Manager for what is using the CPU.", f"{sys_cpu:.0f}% CPU", "high", 0))
    if 0.8 <= cores <= 1.25 and logical > 1:
        causes.append(cause("Limited by one CPU core",
                            f"{name} keeps about one core busy while {logical - 1} others are free: its work runs on a single thread.",
                            "If it is your program, spread the work over several threads or processes.", f"{cores:.2f} cores", "medium", 0))
    elif cores > 0.8 * logical:
        causes.append(cause("Using all CPU cores", f"{name} uses {cores:.1f} of {logical} cores.",
                            "It needs less work or a faster CPU.", f"{cores:.1f} cores", "medium", 0))
    if disk > 30 * 1048576 or ops > 1000:
        causes.append(cause("Heavy disk use", f"It reads and writes {fmt_bytes(disk)}/s ({ops:.0f} operations per second).",
                            "Use bigger, fewer reads and writes, cache data in memory, or move it to an SSD.", f"{fmt_bytes(disk)}/s", "medium", 0))
    if vm.percent > 90:
        causes.append(cause("The computer is low on memory", f"{vm.percent:.0f}% of memory is in use, so Windows moves data to disk.",
                            "Close programs or add memory.", f"{vm.percent:.0f}% used", "high", 0))
    if cs_rate and cs_rate > 20000:
        causes.append(cause("Threads switching constantly", f"{cs_rate:,.0f} thread switches per second with {peak_thr} threads.",
                            "Use fewer threads (a pool sized to the CPU cores) and less locking.", f"{cs_rate:,.0f}/s", "medium", 0))
    if cores < 0.05 and disk < 1048576:
        if conns:
            causes.append(cause("Mostly waiting for the network",
                                f"It hardly uses the CPU or disk and has {len(conns)} network connection{'s' if len(conns) > 1 else ''} open.",
                                "If it feels slow, the delay is on the other side: a server, website or database it talks to.",
                                "idle", "low", 0))
        else:
            causes.append(cause("Idle", f"{name} is not doing any work right now (waiting for you, a timer or another program).",
                                "Watch it while it is doing the slow task.", "idle", "info", 0))
    if ended:
        causes.append(cause("The program closed during the scan", "Numbers cover only the time it was running.", "", "", "info", 0))
    causes = sort_causes(causes)

    level = "bad" if any(c["severity"] == "high" for c in causes) else "warn" if any(c["severity"] == "medium" for c in causes) else "good"
    title = f"{name}: " + ("busy on the CPU" if cores >= 0.8 else "mostly waiting" if cores < 0.2 else "partly busy") + \
            f" ({cores:.2f} cores over {window:.0f} s)."
    top = [c["name"].lower() for c in causes if c["severity"] in ("high", "medium")][:2]
    stats = [stat("CPU cores used", f"{cores:.2f}", f"of {logical} on this computer", "warm" if cores >= 0.8 else ""),
             stat("Disk traffic", f"{fmt_bytes(disk)}/s", f"{ops:.0f} operations/s"),
             stat("Memory", fmt_bytes(peak_rss), f"{peak_thr} threads"),
             stat("Whole computer", f"{sys_cpu:.0f}% CPU", f"{vm.percent:.0f}% memory used", "warm" if sys_cpu > 90 or vm.percent > 90 else "")]
    charts = [{"title": f"CPU cores used by {name}", "unit": "cores", "x": t_list, "y": cpu_list},
              {"title": "Disk traffic", "unit": "MB/s", "x": t_list, "y": disk_list}]
    tables = [table("Network connections", ["Remote address", "Status"],
                    [[f"{c.raddr.ip}:{c.raddr.port}", c.status] for c in conns[:15]])] if conns else []
    notes = [f"Watched process {pid} ({name}) for {window:.0f} seconds, sampling every 0.5 s.",
             "This shows what the program was doing during the scan only. Watch it while the slow thing is happening."]
    return {"kind": "process", "target": f"{name} (PID {pid})",
            "verdict": {"title": title, "sub": ("Biggest issues: " + " and ".join(top) + ".") if top else "No major problems found.", "level": level},
            "stats": stats, "causes": causes, "breakdown": None, "charts": charts, "tables": tables, "notes": notes}


# --------------------------------------------------------------------------------------
# tune threads and batch size with our formula
# --------------------------------------------------------------------------------------
def parse_values(text, label):
    vals = set()
    for part in re.split(r"[,\s;]+", (text or "").strip()):
        if not part:
            continue
        try:
            v = int(part)
        except ValueError:
            raise ScanError(f"{label}: '{part}' is not a whole number.")
        if v < 1 or v > 100000:
            raise ScanError(f"{label}: values must be between 1 and 100000.")
        vals.add(v)
    vals = sorted(vals)
    if len(vals) < 3:
        raise ScanError(f"{label}: give at least 3 different values, for example 1, 2, 4, 8.")
    if len(vals) > 12:
        raise ScanError(f"{label}: at most 12 values.")
    return vals


def next_candidate(res, measured_keys):
    """
    The formula's best whole-number setting that has not been run yet, skipping any
    setting with no more capacity (threads AND batch no larger) than one that was
    overloaded or close to overload. None if the formula expects no gain.
    """
    p = res["fit"]["params"]
    (nlo, nhi), (blo, bhi) = res["bounds"]
    risky = [(o["n"], o["b"]) for o in res["overloaded"] + res["near_overload"]]
    best_meas = res["best_measured"]["D"]
    cands = []
    for n in range(max(1, int(np.ceil(nlo))), int(np.floor(nhi)) + 1):
        for b in range(max(1, int(np.ceil(blo))), int(np.floor(bhi)) + 1):
            if (n, b) in measured_keys or any(n <= on and b <= ob for on, ob in risky):
                continue
            cands.append((delay(p, n, b), n, b))
    if not cands:
        return None
    pred, n, b = min(cands)
    if pred >= 0.99 * best_meas:
        return None
    return (n, b), pred


def tune(job, template, n_text, b_text, repeats=1, metric="time", cwd="", timeout=60, shell=False,
         current=None, default_cwd="."):
    if "{n}" not in (template or "") or "{b}" not in (template or ""):
        raise ScanError("The command must contain {n} where the number of threads goes and {b} where the batch size goes, "
                        "for example:  python my_server.py --threads {n} --batch {b}")
    ns, bs = parse_values(n_text, "Threads"), parse_values(b_text, "Batch sizes")
    repeats = max(1, min(int(repeats), 5))
    timeout = max(1, min(float(timeout), 1800))
    cwd = _check_cwd(cwd, default_cwd)
    grid = [(n, b) for n in ns for b in bs]
    planned = len(grid) * repeats + REFINE_ROUNDS * 2 + ZOOM_ROUNDS * 4 * 2 + 2 * max(2, repeats)
    if planned > MAX_TUNE_RUNS:
        raise ScanError(f"That is about {planned} runs (limit {MAX_TUNE_RUNS}). Use fewer values or fewer repeats.")
    want_metric = metric == "printed"

    rows, failures, outputs = [], [], {}
    done = [0]

    def measure(n, b, phase):
        cmd = template.replace("{n}", str(n)).replace("{b}", str(b))
        r = run_once(job, cmd, cwd, timeout, shell, want_metric)
        done[0] += 1
        job.update(min(0.97, done[0] / planned), f"{phase}: {n} threads, batch {b}  ({done[0]} runs so far)")
        outputs[(n, b)] = r["output"]
        if r["timed_out"]:
            failures.append((n, b, f"timed out after {timeout:.0f} s"))
            return None
        if r["exit"] != 0:
            failures.append((n, b, f"exit code {r['exit']}"))
            return None
        value = r["metric"] if want_metric else r["wall_ms"]
        if value is None:
            failures.append((n, b, "no 'delay_ms=' number in its output"))
            return None
        rows.append({"n": n, "b": b, "value": value, "phase": phase, "wall": r["wall_ms"]})
        return value

    # 1. MEASURE the grid
    for n, b in grid:
        for _ in range(repeats):
            measure(n, b, "Measuring")
        if len(failures) >= 3 and not rows:
            n0, b0, why = failures[0]
            out = outputs.get((n0, b0), "").strip()[-600:]
            raise ScanError(f"The first runs all failed ({why}). Check the command." + (f" Its output was:\n{out}" if out else ""))

    def arrays():
        return (np.array([r["n"] for r in rows], float), np.array([r["b"] for r in rows], float),
                np.array([r["value"] for r in rows], float))

    # 2-4. FIT -> SOLVE -> VERIFY, up to REFINE_ROUNDS rounds
    refine = []
    for rnd in range(REFINE_ROUNDS):
        res = analyse(*arrays(), current=current)
        pick = next_candidate(res, {(r["n"], r["b"]) for r in rows})
        if pick is None:
            refine.append({"round": rnd + 1, "n": None, "b": None, "predicted": None, "measured": None,
                           "note": "the formula expects no better setting than ones already measured"})
            break
        key, predicted = pick
        vals = [measure(key[0], key[1], f"Checking the formula's pick (round {rnd + 1})") for _ in range(2)]
        vals = [v for v in vals if v is not None]
        refine.append({"round": rnd + 1, "n": key[0], "b": key[1], "predicted": predicted,
                       "measured": statistics.mean(vals) if vals else None, "note": ""})
        if not vals:
            break

    # 5. ZOOM (from our Log-Scale Bowl Search): around the best measured setting, measure the
    #    half-way points on the doubling scale, halving the step each round. This finds optima
    #    that sit next to an overload cliff, where no smooth formula can be trusted.
    zoom = []
    step = max(_grid_ratio(ns), _grid_ratio(bs)) ** 0.5
    for rnd in range(ZOOM_ROUNDS):
        res = analyse(*arrays(), current=current, prefer_measured=True)
        bn, bb = int(res["best_measured"]["n"]), int(res["best_measured"]["b"])
        measured_keys = {(r["n"], r["b"]) for r in rows}
        over = {(int(o["n"]), int(o["b"])) for o in res["overloaded"]}
        tried = []
        for n, b in ((round(bn / step), bb), (round(bn * step), bb), (bn, round(bb / step)), (bn, round(bb * step))):
            n, b = max(1, int(n)), max(1, int(b))
            if (n, b) in measured_keys or (n, b) in tried or any(n <= on and b <= ob for on, ob in over):
                continue
            tried.append((n, b))
            for _ in range(2):
                measure(n, b, f"Zooming in around {bn}x{bb} (round {rnd + 1})")
        zoom.append({"round": rnd + 1, "around": [bn, bb], "step": step, "tried": tried})
        if not tried:
            break
        step = step ** 0.5

    # 6. CONFIRM: re-run the two best measured settings, keep the winner
    res = analyse(*arrays(), current=current, prefer_measured=True)
    means = {}
    for r in rows:
        means.setdefault((r["n"], r["b"]), []).append(r["value"])
    over = {(o["n"], o["b"]) for o in res["overloaded"]}
    ranked = sorted((k for k in means if k not in over), key=lambda k: statistics.mean(means[k]))[:2]
    for k in ranked:
        for _ in range(max(2, repeats)):
            measure(k[0], k[1], "Confirming the winner")
    res = analyse(*arrays(), current=current, prefer_measured=True)

    rec = res["recommended"]
    pred_at_rec = rec["predicted"]
    res["kind"] = "tune"
    res["tune"] = {
        "template": template, "metric": "printed delay_ms" if want_metric else "run time",
        "runs": len(rows), "failures": [{"n": n, "b": b, "why": w} for n, b, w in failures],
        "refine": refine, "zoom": zoom,
        "formula_error_pct": (pred_at_rec / rec["D"] - 1) * 100 if rec["D"] else None,
        "unit": "ms",
        "example_command": template.replace("{n}", str(int(rec["n"]))).replace("{b}", str(int(rec["b"]))),
    }
    res["skipped_rows"] = 0
    return res
