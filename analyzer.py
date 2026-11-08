"""
analyzer.py  -  turns measurements (threads, batch size, delay) into a diagnosis
===============================================================================
1. Read    the measurements (an uploaded CSV, or runs made by the tuner).
2. Screen  settings that are OVERLOADED (delay over 10x the typical one): there the
           queue grows without limit, a cliff no smooth formula can follow. They are
           reported as a cause of their own and kept out of the fit.
3. Fit     D(n,b) = D0 + A/n + B*n + C/b + E*b + k*n*b by weighted least squares
           with every cost >= 0 (non-negative least squares). Rows are weighted by
           1/delay, so the fit minimises RELATIVE error: measurement noise grows in
           proportion to the delay, and one huge reading cannot drag the fit.
4. Solve   for the best setting (Newton's method + Hessian check, delay_model.py).
5. Choose  the recommendation: the formula's best whole-number setting, unless the
           formula fits badly or that setting has less capacity than an overloaded
           one; then the best setting actually measured.
6. Explain why the current setting is slow, cause by cause.
"""
import csv
import io
import math

import numpy as np
from scipy.optimize import nnls

from delay_model import best_whole_numbers, delay, optimise, terms

# Column names we recognise (lower-case, spaces/dashes ignored)
ALIASES = {
    "n": {"threads", "thread", "workers", "worker", "n", "cooks", "workerthreads", "threadcount", "concurrency"},
    "b": {"batch", "batchsize", "b", "batch_size", "ordersperbatch", "batchlen"},
    "d": {"delay", "delayms", "latency", "latencyms", "responsetime", "responsetimems", "ms", "d", "time", "timems", "wait", "waitms"},
}

# Plain-language description of every cause of delay
CAUSES = {
    "overload": {"name": "Overloaded: work arrives faster than it is finished",
                 "why": "At this setting the queue keeps growing, so delay explodes.",
                 "fix": "Add capacity: more threads or bigger batches."},
    "queue": {"name": "Requests queuing up", "why": "Too few worker threads, so requests wait in line.",
              "fix": "Add worker threads."},
    "crowd": {"name": "Threads getting in each other's way", "why": "Too many threads compete for CPU and locks.",
              "fix": "Use fewer worker threads."},
    "setup": {"name": "Per-batch overhead", "why": "Batches are small, so start-up work is repeated too often.",
              "fix": "Use bigger batches."},
    "wait":  {"name": "Waiting for batches to fill", "why": "Batches are large, so early requests wait for the rest.",
              "fix": "Use smaller batches."},
    "clash": {"name": "Memory and resource clash", "why": "Threads x batch size is too large for the machine.",
              "fix": "Reduce threads or batch size."},
    "base":  {"name": "Fixed base delay", "why": "Network, disk or code time that tuning cannot remove.",
              "fix": "Not fixable by tuning threads or batch size."},
}

MAX_ROWS = 200_000
OVERLOAD_FACTOR = 10.0     # a setting this many times slower than the typical one is "overloaded"
NEAR_OVERLOAD = 2.0        # measured more than 2x what the formula expects: close to overload
GOOD_FIT, FAIR_FIT = 0.10, 0.25   # typical (median) relative error of the formula


class DataError(ValueError):
    """Problem with the uploaded data, explained in plain words for the user."""


def _key(s):
    return "".join(ch for ch in s.lower() if ch.isalnum() or ch == "_").replace("_", "")


def parse_csv(text):
    """Return three float arrays (n, b, d) from CSV/TSV text with a header row."""
    text = text.lstrip("﻿").strip()
    if not text:
        raise DataError("The file is empty.")
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    reader = csv.reader(io.StringIO(text), dialect)
    header = next(reader, None) or []
    cols = {}
    for i, h in enumerate(header):
        k = _key(h)
        for role, names in ALIASES.items():
            if role not in cols and (k in {_key(x) for x in names}):
                cols[role] = i
    missing = [label for role, label in (("n", "threads"), ("b", "batch_size"), ("d", "delay_ms")) if role not in cols]
    if missing:
        raise DataError("Could not find these columns: " + ", ".join(missing) +
                        ". The first row must be a header such as: threads,batch_size,delay_ms")

    n, b, d, skipped = [], [], [], 0
    for row in reader:
        if not row or all(not c.strip() for c in row):
            continue
        try:
            vn, vb, vd = (float(row[cols[r]]) for r in ("n", "b", "d"))
        except (ValueError, IndexError):
            skipped += 1
            continue
        if not (vn > 0 and vb > 0 and vd >= 0) or not all(map(math.isfinite, (vn, vb, vd))):
            skipped += 1
            continue
        n.append(vn); b.append(vb); d.append(vd)
        if len(n) > MAX_ROWS:
            raise DataError(f"Too many rows (limit {MAX_ROWS:,}).")
    return np.array(n), np.array(b), np.array(d), skipped


def fit_model(n, b, d):
    """
    Non-negative least squares fit of D0, A, B, C, E, k, minimising relative error.
    Returns (params, r2, rmse). r2 is measured on the same relative scale the fit
    minimises (weighted R^2, rows weighted by 1/delay); rmse is in milliseconds.
    The fit quality shown to users is the typical relative error (see analyse),
    because that is what a user can picture.
    """
    X = np.column_stack([np.ones_like(n), 1 / n, n, 1 / b, b, n * b])
    w = 1.0 / np.maximum(d, 1e-9 * max(1.0, float(np.max(d))))
    Xw, yw = X * w[:, None], d * w
    scale = np.linalg.norm(Xw, axis=0)
    scale[scale == 0] = 1
    coef, _ = nnls(Xw / scale, yw)
    coef = coef / scale
    pred = X @ coef
    w2 = w ** 2
    d_bar = float(np.sum(w2 * d) / np.sum(w2))                 # weighted mean
    ss_res_w = float(np.sum(w2 * (d - pred) ** 2))
    ss_tot_w = float(np.sum(w2 * (d - d_bar) ** 2))
    r2 = 1 - ss_res_w / ss_tot_w if ss_tot_w > 0 else 1.0
    rmse = math.sqrt(float(np.sum((d - pred) ** 2)) / max(1, len(d) - 6))
    p = dict(zip(("D0", "A", "B", "C", "E", "k"), (float(c) for c in coef)))
    return p, r2, rmse


def group_settings(n, b, d):
    """Mean delay per distinct (n, b) setting: {(n, b): {"count", "mean", "last"}}."""
    out = {}
    for i, (x, y, v) in enumerate(zip(n, b, d)):
        g = out.setdefault((float(x), float(y)), {"count": 0, "sum": 0.0, "last": 0})
        g["count"] += 1
        g["sum"] += float(v)
        g["last"] = i
    for g in out.values():
        g["mean"] = g["sum"] / g["count"]
    return out


def analyse(n, b, d, current=None, prefer_measured=False):
    """
    Full analysis of measurements. `current` = (threads, batch) or None.
    prefer_measured=True (used by the tuner, which can re-run settings) always
    recommends the best setting that was actually measured.
    """
    n, b, d = np.asarray(n, float), np.asarray(b, float), np.asarray(d, float)
    if len(d) < 6:
        raise DataError(f"Need at least 6 measurements; there are {len(d)} usable rows.")
    un, ub = np.unique(n), np.unique(b)
    if len(un) < 3 or len(ub) < 3:
        raise DataError("Need at least 3 different thread counts and 3 different batch sizes, "
                        f"so their effects can be told apart (found {len(un)} and {len(ub)}). "
                        "Measure a few more settings.")

    settings = group_settings(n, b, d)
    typical = float(np.median([g["mean"] for g in settings.values()]))
    over_set = {s for s, g in settings.items() if g["mean"] > OVERLOAD_FACTOR * typical}
    keep = np.array([(float(x), float(y)) not in over_set for x, y in zip(n, b)])
    if keep.sum() < 6 or len(np.unique(n[keep])) < 3 or len(np.unique(b[keep])) < 3:
        keep[:] = True          # too little left: fit everything rather than nothing
        over_set = set()

    p, r2, rmse = fit_model(n[keep], b[keep], d[keep])
    kept_settings = [(s, g) for s, g in settings.items() if s not in over_set]
    rel_err = [abs(delay(p, s[0], s[1]) / g["mean"] - 1) for s, g in kept_settings if g["mean"] > 0]
    typical_err = float(np.median(rel_err)) if rel_err else 0.0
    quality = "good" if typical_err <= GOOD_FIT else "fair" if typical_err <= FAIR_FIT else "poor"
    near = sorted(s for s, g in kept_settings if g["mean"] > NEAR_OVERLOAD * delay(p, s[0], s[1]))

    # Only recommend settings near what was actually measured (up to 2x outside it).
    bounds = ((max(1.0, un.min() / 2), un.max() * 2), (max(1.0, ub.min() / 2), ub.max() * 2))
    opt = optimise(p, bounds)
    model_pick = best_whole_numbers(p, opt["n"], opt["b"], bounds)

    def measured(s):
        g = settings.get((float(s[0]), float(s[1])))
        return g["mean"] if g else None

    ok_settings = {s: g for s, g in settings.items() if s not in over_set}
    pool = {s: g for s, g in ok_settings.items() if g["count"] >= 2} or ok_settings
    best_meas_s = min(pool, key=lambda s: pool[s]["mean"])
    best_measured = {"n": best_meas_s[0], "b": best_meas_s[1], "D": pool[best_meas_s]["mean"],
                     "count": pool[best_meas_s]["count"]}

    # Has the formula's pick no more capacity than a setting that was overloaded (or nearly)?
    starved = any(model_pick["n"] <= on and model_pick["b"] <= ob for on, ob in list(over_set) + near)
    if prefer_measured:
        rec_s, source, reason = best_meas_s, "measured", "lowest delay of every setting that was run"
    elif quality == "poor":
        rec_s, source, reason = best_meas_s, "measured", "the formula does not fit this data well, so we trust the measurements"
    elif starved:
        rec_s, source, reason = best_meas_s, "measured", "the formula's pick is close to settings that were overloaded"
    else:
        rec_s, source, reason = (model_pick["n"], model_pick["b"]), "formula", "best whole-number setting of the fitted formula"
        if measured(rec_s) is None:
            reason += " (predicted: it was not in your measurements, so run it once to confirm)"
    rec_pred = delay(p, rec_s[0], rec_s[1])
    rec_meas = measured(rec_s)
    rec_D = rec_meas if (source == "measured" and rec_meas is not None) else rec_pred
    recommended = {"n": rec_s[0], "b": rec_s[1], "D": rec_D, "predicted": rec_pred, "measured": rec_meas,
                   "source": source, "reason": reason}
    if source == "formula" and float(rec_s[0]).is_integer() and float(rec_s[1]).is_integer():
        recommended["n"], recommended["b"] = int(rec_s[0]), int(rec_s[1])

    # Current setting: given by the user, else the setting measured most often (latest on a tie).
    if current:
        cn, cb = float(current[0]), float(current[1])
        source_cur = "you entered it"
    else:
        cn, cb = max(settings, key=lambda s: (settings[s]["count"], settings[s]["last"]))
        source_cur = "most measured setting"
    cur_pred = delay(p, cn, cb)
    cur_meas = measured((cn, cb))
    cur_over = (cn, cb) in over_set
    cur_D = cur_meas if cur_meas is not None else cur_pred

    # Why is it slow? Extra delay of each cause compared with the recommended setting.
    tc, tb = terms(p, cn, cb), terms(p, recommended["n"], recommended["b"])
    causes = []
    if cur_over:
        excess = max(0.0, cur_D - cur_pred)
        causes.append({"key": "overload", **CAUSES["overload"], "now": excess, "best": 0.0, "extra": excess})
    for key in ("queue", "crowd", "setup", "wait", "clash", "base"):
        causes.append({"key": key, **CAUSES[key], "now": tc[key], "best": tb[key], "extra": tc[key] - tb[key]})
    causes.sort(key=lambda c: c["extra"], reverse=True)
    gap = cur_D - rec_D
    main = [c for c in causes if c["extra"] > max(0.05 * gap, 1e-9) and c["key"] != "base"]

    # Predicted delay over the range, for the map on the page
    G = 44
    gn = np.exp(np.linspace(math.log(bounds[0][0]), math.log(bounds[0][1]), G))
    gb = np.exp(np.linspace(math.log(bounds[1][0]), math.log(bounds[1][1]), G))
    NN, BB = np.meshgrid(gn, gb, indexing="ij")
    Z = delay(p, NN, BB)

    warnings = []
    if near:
        warnings.append("Close to overload: at " + ", ".join(f"{_num(x)}x{_num(y)}" for x, y in near[:6])
                        + " the delay is more than twice what the formula expects, a sign the server is near its limit there.")
    if quality != "good":
        warnings.append("The formula explains only part of these measurements (noise, or something else also affects "
                        "delay). " + ("The recommendation is the best measured setting." if source == "measured"
                                      else "Treat the recommendation as a starting point and re-measure."))
    if over_set:
        warnings.append(f"{len(over_set)} setting{'s' if len(over_set) > 1 else ''} overloaded (over "
                        f"{OVERLOAD_FACTOR:.0f}x the typical delay): "
                        + ", ".join(f"{_num(x)}x{_num(y)}" for x, y in sorted(over_set)[:6])
                        + (f" and {len(over_set) - 6} more" if len(over_set) > 6 else "")
                        + ". They were left out of the formula fit.")
    if source == "formula" and (opt["edge"]["n"] or opt["edge"]["b"]):
        which = []
        if opt["edge"]["n"]:
            which.append(("more" if opt["edge"]["n"] == "high" else "fewer") + " threads")
        if opt["edge"]["b"]:
            which.append(("bigger" if opt["edge"]["b"] == "high" else "smaller") + " batches")
        warnings.append("Delay was still falling at the edge of what you measured. Try measuring "
                        + " and ".join(which) + " to find the true best setting.")

    return {
        "rows": int(len(d)),
        "settings_measured": len(settings),
        "overloaded": [{"n": x, "b": y, "mean": settings[(x, y)]["mean"]} for x, y in sorted(over_set)],
        "fit": {"r2": r2, "rmse": rmse, "typical_error": typical_err, "quality": quality, "params": p,
                "rows_used": int(keep.sum())},
        "bounds": bounds,
        "near_overload": [{"n": x, "b": y} for x, y in near],
        "current": {"n": cn, "b": cb, "source": source_cur, "predicted": cur_pred, "measured": cur_meas,
                    "delay": cur_D, "overloaded": cur_over},
        "best": {"n": opt["n"], "b": opt["b"], "D": opt["D"], "is_minimum": opt["is_minimum"],
                 "eigenvalues": opt["eigenvalues"], "method": opt["method"]},
        "model_pick": model_pick,
        "best_measured": best_measured,
        "recommended": recommended,
        "improvement": {"ms": gap, "pct": gap / cur_D if cur_D > 0 else 0.0},
        "causes": causes,
        "main_causes": [c["key"] for c in main],
        "warnings": warnings,
        "map": {"n": gn.tolist(), "b": gb.tolist(), "D": Z.tolist(),
                "points": [{"n": x, "b": y, "count": g["count"], "mean": g["mean"], "overloaded": (x, y) in over_set}
                           for (x, y), g in settings.items()]},
    }


def _num(x):
    return str(int(x)) if float(x).is_integer() else f"{x:.1f}"


def make_sample(seed=7, noise=0.03):
    """A realistic test log: a sweep of settings plus a busy production setting (4 threads, batches of 16)."""
    rng = np.random.default_rng(seed)
    p = {"D0": 20.0, "A": 400, "B": 4, "C": 90, "E": 2.5, "k": 0.05}
    rows = []
    for nn in (2, 4, 6, 8, 12, 16, 24, 32):
        for bb in (1, 2, 4, 8, 16, 32):
            for _ in range(2):
                rows.append((nn, bb))
    rows += [(4, 16)] * 12
    out = io.StringIO()
    out.write("threads,batch_size,delay_ms\n")
    for nn, bb in rows:
        v = delay(p, nn, bb) * (1 + noise * rng.standard_normal())
        out.write(f"{nn},{bb},{v:.2f}\n")
    return out.getvalue()
