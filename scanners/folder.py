"""
folder.py  -  why is a folder slow to open, copy, back up or sync?
==================================================================
1. List every sub-folder, timing how long each listing takes.
2. Read a sample of the files (read-only, up to a size and time budget),
   timing how long each file takes to OPEN and how long its data takes to READ.
3. Split the cost of reading the whole folder into
       listing  +  opening files (fixed cost per file)  +  reading data (cost per byte)
   The fixed cost per file is the folder version of the "setup cost" in our
   formula: thousands of small files pay it thousands of times.

Online-only cloud files (OneDrive "files on demand") are never opened,
because opening one would download it.
"""
import os
import stat as st
import statistics
import time

from .common import ScanError, cause, fmt_bytes, fmt_ms, sort_causes, stat, table

CHUNK = 1024 * 1024
SMALL = 64 * 1024
PER_FILE_CAP = 16 * 1024 * 1024   # read at most 16 MB of any one file, so big files don't use up the sample
MAX_FILES = 200_000
MAX_LIST_SECONDS = 90
MAX_READ_SECONDS = 60
CLOUD_ATTRS = 0x400000 | 0x40000 | 0x1000  # RECALL_ON_DATA_ACCESS | RECALL_ON_OPEN | OFFLINE
HEAVY_DIRS = {"node_modules", ".git", "__pycache__", ".venv", "venv", ".cache", "build", "dist", "target", ".gradle", ".next"}


def _is_cloud_only(s):
    return bool(getattr(s, "st_file_attributes", 0) & CLOUD_ATTRS)


def scan_folder(job, path, read_mb=256):
    path = os.path.abspath(os.path.expanduser((path or "").strip().strip('"').strip("'")))
    if not (path or "").strip():
        raise ScanError("Type the path of a folder, for example C:\\Users\\you\\Documents")
    if not os.path.exists(path):
        raise ScanError(f"This folder does not exist: {path}")
    if not os.path.isdir(path):
        raise ScanError(f"This is a file, not a folder: {path}")
    budget = max(16, min(int(read_mb), 4096)) * 1024 * 1024

    # ---- 1. list -------------------------------------------------------------------
    files, dirs, notes = [], [], []
    perm_dirs, links, cloud, long_paths = 0, 0, 0, 0
    heavy = {}
    stack = [(path, 0)]
    t_start = time.perf_counter()
    truncated = False
    while stack:
        d, depth = stack.pop()
        t0 = time.perf_counter()
        try:
            with os.scandir(d) as it:
                entries = list(it)
            stats = []
            for e in entries:
                try:
                    stats.append((e, e.stat(follow_symlinks=False)))
                except OSError:
                    stats.append((e, None))
        except PermissionError:
            perm_dirs += 1
            continue
        except OSError:
            perm_dirs += 1
            continue
        dt = (time.perf_counter() - t0) * 1000
        rel = os.path.relpath(d, path)
        top = "(this folder)" if rel == "." else rel.split(os.sep)[0]
        dirs.append({"path": d, "rel": rel, "entries": len(entries), "ms": dt, "depth": depth, "top": top})
        for e, s in stats:
            if e.is_symlink():
                links += 1
                continue
            if s is None:
                continue
            if st.S_ISDIR(s.st_mode):
                if e.name in HEAVY_DIRS:
                    heavy.setdefault(e.name, 0)
                stack.append((e.path, depth + 1))
            elif st.S_ISREG(s.st_mode):
                child_top = top if rel != "." else "(this folder)"
                hv = next((p for p in e.path[len(path):].split(os.sep) if p in HEAVY_DIRS), None)
                if hv:
                    heavy[hv] = heavy.get(hv, 0) + 1
                c = _is_cloud_only(s)
                cloud += c
                if len(e.path) >= 240:
                    long_paths += 1
                files.append({"path": e.path, "size": s.st_size, "top": child_top, "cloud": c})
        if len(files) >= MAX_FILES:
            truncated = True
            notes.append(f"Stopped listing after {MAX_FILES:,} files; numbers cover that part only.")
            break
        if time.perf_counter() - t_start > MAX_LIST_SECONDS:
            truncated = True
            notes.append(f"Stopped listing after {MAX_LIST_SECONDS} seconds; numbers cover the part that was listed.")
            break
        if len(dirs) % 50 == 0:
            job.update(min(0.35, 0.02 + len(files) / 400_000), f"Listing… {len(dirs):,} folders, {len(files):,} files")
    list_ms = (time.perf_counter() - t_start) * 1000
    if not files and not dirs:
        raise ScanError("Windows did not allow this folder to be read.")

    # ---- 2. read a sample ------------------------------------------------------------
    # Read files in a spread-out order (every k-th) so the sample covers the whole tree.
    readable = [f for f in files if not f["cloud"]]
    order = sorted(range(len(readable)), key=lambda i: (i * 7919) % max(1, len(readable)))
    read, used, locked = [], 0, 0
    t_read0 = time.perf_counter()
    buf = bytearray(CHUNK)
    for count, i in enumerate(order):
        f = readable[i]
        if used >= budget or time.perf_counter() - t_read0 > MAX_READ_SECONDS:
            break
        want = min(f["size"], budget - used, PER_FILE_CAP)
        t0 = time.perf_counter()
        try:
            fh = open(f["path"], "rb", buffering=0)
        except OSError:
            locked += 1
            continue
        t1 = time.perf_counter()
        got = 0
        try:
            while got < want:
                n = fh.readinto(buf)
                if not n:
                    break
                got += n
        except OSError:
            locked += 1
        finally:
            fh.close()
        t2 = time.perf_counter()
        used += got
        f.update({"open_ms": (t1 - t0) * 1000, "read_ms": (t2 - t1) * 1000, "read_bytes": got, "partial": got < f["size"]})
        read.append(f)
        if count % 25 == 0:
            job.update(0.35 + 0.6 * min(1.0, max(used / budget, (time.perf_counter() - t_read0) / MAX_READ_SECONDS)),
                       f"Reading… {len(read):,} files, {fmt_bytes(used)}")
    if len(read) < len(readable):
        notes.append(f"Read {len(read):,} of {len(readable):,} files ({fmt_bytes(used)}) as a sample; "
                     "the whole-folder time is estimated from that sample.")

    job.update(0.97, "Working out the causes…")
    return _report(path, files, dirs, read, list_ms, perm_dirs, links, cloud, long_paths, locked, heavy, truncated, notes)


def _report(path, files, dirs, read, list_ms, perm_dirs, links, cloud, long_paths, locked, heavy, truncated, notes):
    n_files = len(files)
    total_bytes = sum(f["size"] for f in files)
    small = [f for f in read if f["size"] <= SMALL]
    big = [f for f in read if f["read_bytes"] >= CHUNK]

    open_med = statistics.median([f["open_ms"] for f in read]) if read else 0.0
    small_over = statistics.median([f["open_ms"] + f["read_ms"] for f in small]) if small else open_med
    if big and sum(f["read_ms"] for f in big) > 0:
        mbps = sum(f["read_bytes"] for f in big) / 1048576 / (sum(f["read_ms"] for f in big) / 1000)
    elif read and sum(f["read_ms"] for f in read) > 0:
        mbps = sum(f["read_bytes"] for f in read) / 1048576 / (sum(f["read_ms"] for f in read) / 1000)
    else:
        mbps = None
    big_data_mb = sum(f["read_bytes"] for f in big) / 1048576

    # estimated time to read everything once: listing + per-file cost + data
    per_file_ms = small_over if small else open_med
    readable_files = n_files - cloud
    est_open = readable_files * per_file_ms
    est_data = (total_bytes / 1048576) / mbps * 1000 if mbps else 0.0
    est_total = list_ms + est_open + est_data
    listing_rate = list_ms / max(1, sum(d["entries"] for d in dirs)) * 1000  # ms per 1000 entries

    causes = []
    if n_files > 500 and est_open > 0.35 * est_total:
        n_small = sum(1 for f in files if f["size"] <= SMALL)
        causes.append(cause(
            "Too many small files",
            f"{n_files:,} files, {n_small / max(1, n_files):.0%} of them under 64 KB. Each file costs about "
            f"{fmt_ms(per_file_ms)} just to open, so opening them takes longer than reading their data.",
            "Zip folders you rarely use, combine small files, and keep build or cache folders out of sync and backup.",
            f"{fmt_ms(est_open)}", "high" if est_open > 0.6 * est_total else "medium", est_open))
    if mbps is not None and big_data_mb >= 8 and mbps < 80:
        causes.append(cause(
            "Slow drive",
            f"Big files read at only {mbps:.0f} MB/s. A modern SSD reads at 500 MB/s or more; "
            "this speed is typical of a hard disk, USB stick, SD card or network drive.",
            "Move the folder to an SSD, or copy it locally before working on it.",
            f"{fmt_ms(est_data)}", "high" if mbps < 30 else "medium", est_data))
    if read and open_med > 2.0:
        causes.append(cause(
            "Opening each file is slow",
            f"Just opening a file takes {fmt_ms(open_med)} (on a normal SSD it is well under 0.5 ms). "
            "Usually antivirus scanning, encryption, or a network or cloud drive is checking every file.",
            "Add the folder to your antivirus exclusions if you trust it, or work from a local copy.",
            f"{fmt_ms(readable_files * open_med)}", "medium", readable_files * open_med))
    crowded = sorted([d for d in dirs if d["entries"] >= 5000], key=lambda d: -d["entries"])
    if crowded:
        causes.append(cause(
            f"{len(crowded)} folder{'s' if len(crowded) > 1 else ''} with thousands of items",
            f"The biggest one, {crowded[0]['rel']}, has {crowded[0]['entries']:,} items and took {fmt_ms(crowded[0]['ms'])} just to list. "
            "File Explorer gets slow with folders this full.",
            "Split it into sub-folders (for example by year or by first letter).",
            fmt_ms(sum(d["ms"] for d in crowded)), "medium", sum(d["ms"] for d in crowded)))
    if cloud:
        causes.append(cause(
            f"{cloud:,} online-only cloud files",
            "These files are only in the cloud (OneDrive files-on-demand). Opening one downloads it first, "
            "which can take seconds per file.",
            "Right-click the folder and choose 'Always keep on this device' if you use it often.",
            "download on open", "medium" if cloud > 20 else "low", 0))
    heavy_files = sum(heavy.values())
    if n_files and heavy_files > 0.3 * n_files and heavy_files > 1000:
        names = ", ".join(f"{k} ({v:,})" for k, v in sorted(heavy.items(), key=lambda kv: -kv[1]) if v)
        causes.append(cause(
            "Build and cache folders hold most of the files",
            f"{heavy_files / n_files:.0%} of the files are inside tool folders: {names}. They can be rebuilt any time.",
            "Exclude them from OneDrive, backup and antivirus, or delete them when a project is finished.",
            f"{heavy_files:,} files", "medium", heavy_files * per_file_ms))
    if perm_dirs or locked:
        causes.append(cause(
            "Some items could not be read",
            f"{perm_dirs:,} folders and {locked:,} files were blocked (no permission, or in use by another program).",
            "Programs that copy or back up this folder will stall or fail on these items.",
            "", "low", 0))
    if long_paths:
        causes.append(cause(
            f"{long_paths:,} very long file paths",
            "Paths of 240+ characters break many Windows programs and backups.",
            "Shorten folder names or move the folder closer to the drive root.",
            "", "low", 0))
    causes = sort_causes(causes)

    level = "good" if not any(c["severity"] in ("high", "medium") for c in causes) else \
            "bad" if any(c["severity"] == "high" for c in causes) else "warn"
    name = os.path.basename(path.rstrip("\\/")) or path
    title = {"good": f"“{name}” reads quickly: about {fmt_ms(est_total)} for everything.",
             "warn": f"“{name}” is slower than it should be: about {fmt_ms(est_total)} to read everything.",
             "bad": f"“{name}” is slow: about {fmt_ms(est_total)} to read everything."}[level]
    top = [c["name"].lower() for c in causes if c["severity"] in ("high", "medium")][:2]
    sub = ("Biggest delays: " + " and ".join(top) + ".") if top else "No major problems found."

    stats = [
        stat("Files", f"{n_files:,}", f"{fmt_bytes(total_bytes)} in {len(dirs):,} folders"),
        stat("Time to read everything", fmt_ms(est_total), "estimated from the sample", "warm" if level != "good" else "good"),
        stat("Read speed", f"{mbps:.0f} MB/s" if mbps else "—", "big files" if big else "all files read",
             "warm" if mbps and mbps < 80 else "good"),
        stat("Cost per file", fmt_ms(per_file_ms), "to open a small file", "warm" if per_file_ms > 2 else "good"),
    ]

    breakdown = {"title": "Where the time goes", "note": "Estimated time to list and read the whole folder once.",
                 "rows": [{"label": "Whole folder", "total": est_total, "parts": [
                     {"key": "list", "label": "Listing folders", "value": list_ms},
                     {"key": "open", "label": "Opening files (per-file cost)", "value": est_open},
                     {"key": "data", "label": "Reading data", "value": est_data}]}]}

    # per top-level sub-folder
    groups = {}
    for f in files:
        g = groups.setdefault(f["top"], {"files": 0, "bytes": 0, "list": 0.0})
        g["files"] += 1
        g["bytes"] += f["size"]
    for d in dirs:
        groups.setdefault(d["top"], {"files": 0, "bytes": 0, "list": 0.0})["list"] += d["ms"]
    for g in groups.values():
        g["est"] = g["list"] + g["files"] * per_file_ms + ((g["bytes"] / 1048576) / mbps * 1000 if mbps else 0)
    tables = [
        table("Slowest sub-folders", ["Sub-folder", "Files", "Size", "Estimated time"],
              [[k, f"{g['files']:,}", fmt_bytes(g["bytes"]), fmt_ms(g["est"])]
               for k, g in sorted(groups.items(), key=lambda kv: -kv[1]["est"])[:15]]),
        table("Largest files", ["File", "Size"],
              [[os.path.relpath(f["path"], path), fmt_bytes(f["size"])] for f in sorted(files, key=lambda f: -f["size"])[:10]]),
    ]
    if read:
        tables.append(table("Slowest files to open and read", ["File", "Size", "Open", "Read", "Total"],
                            [[os.path.relpath(f["path"], path), fmt_bytes(f["size"]), fmt_ms(f["open_ms"]),
                              fmt_ms(f["read_ms"]) + (" (part)" if f["partial"] else ""), fmt_ms(f["open_ms"] + f["read_ms"])]
                             for f in sorted(read, key=lambda f: -(f["open_ms"] + f["read_ms"]))[:10]]))
    if crowded:
        tables.append(table("Fullest folders", ["Folder", "Items", "Time to list"],
                            [[d["rel"], f"{d['entries']:,}", fmt_ms(d["ms"])] for d in crowded[:10]]))

    notes = notes + [
        f"Listing took {fmt_ms(list_ms)} ({fmt_ms(listing_rate)} per 1,000 items).",
        "Files you opened recently come from Windows' memory cache, so they look faster than a first read from the disk. "
        "Restart and scan again to see cold-disk speed.",
        "Nothing was changed: files were only opened for reading.",
    ]
    if mbps and mbps > 2000:
        notes.append(f"Data came in at {mbps:,.0f} MB/s, faster than any disk: it was already in memory, so the disk speed itself is hidden.")
    if truncated:
        notes.append("The scan was cut short (see above), so totals are for the scanned part only.")

    return {"kind": "folder", "target": path,
            "verdict": {"title": title, "sub": sub, "level": level},
            "stats": stats, "causes": causes, "breakdown": breakdown, "charts": [], "tables": tables, "notes": notes}
