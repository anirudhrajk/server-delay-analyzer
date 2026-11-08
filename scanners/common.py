"""
Shared pieces for the scanners: the error type shown to the user, and small
helpers that build the report every scanner returns.

Every scanner returns a report shaped like this, so the web page can draw any
of them the same way:

    {
      "kind": "website" | "folder" | "process" | "command",
      "verdict": {"title": str, "sub": str, "level": "good" | "warn" | "bad"},
      "stats":   [{"label", "value", "sub", "tone"}],         # 4 headline numbers
      "causes":  [{"name", "why", "fix", "impact", "severity"}],  # biggest first
      "breakdown": {"title", "note", "rows": [{"label", "total", "parts": [{"key", "label", "value"}]}]},
      "charts":  [{"title", "unit", "x": [...], "y": [...]}],
      "tables":  [{"title", "note", "columns": [...], "rows": [[...]]}],
      "notes":   [str],   # how accurate the numbers are, in plain words
    }
"""
import math
import statistics


class ScanError(ValueError):
    """A problem the user can fix (bad address, missing folder...), in plain words."""


SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2, "info": 3}


def stat(label, value, sub="", tone=""):
    return {"label": label, "value": value, "sub": sub, "tone": tone}


def cause(name, why, fix, impact="", severity="medium", impact_ms=None):
    return {"name": name, "why": why, "fix": fix, "impact": impact,
            "severity": severity, "impact_ms": impact_ms}


def sort_causes(causes):
    return sorted(causes, key=lambda c: (SEVERITY_ORDER.get(c["severity"], 9), -(c.get("impact_ms") or 0)))


def table(title, columns, rows, note=""):
    return {"title": title, "columns": columns, "rows": rows, "note": note}


def fmt_ms(ms):
    if ms is None or not math.isfinite(ms):
        return "—"
    if ms >= 10000:
        return f"{ms / 1000:.1f} s"
    if ms >= 1000:
        return f"{ms / 1000:.2f} s"
    if ms >= 100:
        return f"{ms:.0f} ms"
    if ms >= 10:
        return f"{ms:.1f} ms"
    return f"{ms:.2f} ms"


def fmt_bytes(n):
    if n is None:
        return "—"
    n = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def median(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def spread(xs):
    """(min, max) of a list, ignoring None."""
    xs = [x for x in xs if x is not None]
    return (min(xs), max(xs)) if xs else (None, None)
