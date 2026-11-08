"""
delay_model.py  -  the delay model and the exact optimiser (back end only)
=========================================================================
D(n,b) = D0 + A/n + B*n + C/b + E*b + k*n*b

  n  = worker threads,  b = batch size
  D0 = fixed base delay (network, disk...). It does not depend on n or b,
       so it never moves the best setting.

The minimum is found with Newton's method (solve H*step = grad at every
iteration, with backtracking), and confirmed with the Hessian eigenvalue test.
SciPy's bounded optimiser is used as a cross-check and as a fallback when the
best setting lies on the edge of the allowed range.
"""
import math

import numpy as np
from scipy.optimize import minimize

TERMS = ("A", "B", "C", "E", "k")


def delay(p, n, b):
    return p.get("D0", 0.0) + p["A"] / n + p["B"] * n + p["C"] / b + p["E"] * b + p["k"] * n * b


def terms(p, n, b):
    """Delay split into its causes (milliseconds)."""
    return {
        "base": p.get("D0", 0.0),
        "queue": p["A"] / n,
        "crowd": p["B"] * n,
        "setup": p["C"] / b,
        "wait": p["E"] * b,
        "clash": p["k"] * n * b,
    }


def grad(p, n, b):
    return np.array([-p["A"] / n**2 + p["B"] + p["k"] * b,
                     -p["C"] / b**2 + p["E"] + p["k"] * n])


def hess(p, n, b):
    return np.array([[2 * p["A"] / n**3, p["k"]],
                     [p["k"], 2 * p["C"] / b**3]])


def newton(p, n0, b0, max_iter=60, tol=1e-10):
    """Newton's method with backtracking; returns (n, b, converged, iterations)."""
    n, b = float(n0), float(b0)
    for it in range(max_iter + 1):
        g = grad(p, n, b)
        gn = math.hypot(*g)
        if gn < tol:
            return n, b, True, it
        H = hess(p, n, b)
        if np.linalg.eigvalsh(H)[0] > 0:
            s = np.linalg.solve(H, g)
        else:
            s = g
        f, slope, t, ok = delay(p, n, b), float(g @ s), 1.0, False
        for _ in range(80):
            nn, bb = n - t * s[0], b - t * s[1]
            if nn > 0 and bb > 0:
                ff = delay(p, nn, bb)
                if ff <= f - 1e-4 * t * slope or (ff <= f + 1e-13 * abs(f) and gn < 1e-6):
                    ok = True
                    break
            t /= 2
        if not ok:
            break
        n, b = nn, bb
    return n, b, math.hypot(*grad(p, n, b)) < 1e-8, it


def optimise(p, bounds=None):
    """
    Best (n, b) for the model p.
    bounds = ((n_lo, n_hi), (b_lo, b_hi)) limits the answer to a sensible range.
    Returns a dict with the setting, the delay, the Hessian check and a flag
    telling whether the answer sits on the edge of the range.
    """
    if bounds is None:
        bounds = ((1e-3, 1e3), (1e-3, 1e3))
    (nlo, nhi), (blo, bhi) = bounds

    # start: the k = 0 closed form when it exists, else the middle of the range
    n0 = math.sqrt(p["A"] / p["B"]) if p["A"] > 0 and p["B"] > 0 else math.sqrt(nlo * nhi)
    b0 = math.sqrt(p["C"] / p["E"]) if p["C"] > 0 and p["E"] > 0 else math.sqrt(blo * bhi)
    n0, b0 = min(max(n0, nlo), nhi), min(max(b0, blo), bhi)

    n, b, conv, iters = newton(p, n0, b0)
    inside = conv and nlo <= n <= nhi and blo <= b <= bhi
    method = "newton"

    # cross-check / fallback: SciPy, bounded, on the log scale
    def f(x):
        return delay(p, math.exp(x[0]), math.exp(x[1]))
    r = minimize(f, [math.log(n0), math.log(b0)], method="L-BFGS-B",
                 bounds=[(math.log(nlo), math.log(nhi)), (math.log(blo), math.log(bhi))],
                 options=dict(ftol=1e-15, gtol=1e-12))
    sn, sb = math.exp(r.x[0]), math.exp(r.x[1])
    if not inside or delay(p, sn, sb) < delay(p, n, b) - 1e-9:
        n, b, method = sn, sb, "bounded"

    H = hess(p, n, b)
    ev = np.linalg.eigvalsh(H)
    rel = 1e-6
    edge = {
        "n": "low" if n <= nlo * (1 + rel) else "high" if n >= nhi * (1 - rel) else None,
        "b": "low" if b <= blo * (1 + rel) else "high" if b >= bhi * (1 - rel) else None,
    }
    return {
        "n": n, "b": b, "D": delay(p, n, b),
        "grad_norm": float(np.linalg.norm(grad(p, n, b))),
        "eigenvalues": [float(e) for e in ev],
        "is_minimum": bool(ev.min() > 0) and edge["n"] is None and edge["b"] is None,
        "edge": edge, "method": method, "newton_iterations": iters,
        "scipy_agrees": abs(delay(p, sn, sb) - delay(p, n, b)) <= 1e-9 * max(1.0, delay(p, n, b)),
    }


def best_whole_numbers(p, n, b, bounds):
    """You cannot run 9.7 threads: best integer setting near the optimum, inside the range."""
    (nlo, nhi), (blo, bhi) = bounds
    best = None
    for i in range(max(1, math.floor(n) - 3, math.ceil(nlo)), min(math.ceil(n) + 3, math.floor(nhi)) + 1):
        for j in range(max(1, math.floor(b) - 3, math.ceil(blo)), min(math.ceil(b) + 3, math.floor(bhi)) + 1):
            v = delay(p, i, j)
            if best is None or v < best["D"]:
                best = {"n": i, "b": j, "D": v}
    if best is None:  # range narrower than one integer step
        i, j = max(1, round(n)), max(1, round(b))
        best = {"n": i, "b": j, "D": delay(p, i, j)}
    return best


if __name__ == "__main__":
    P = {"A": 400, "B": 4, "C": 90, "E": 2.5, "k": 0.05}
    o = optimise(P)
    print(f"n* = {o['n']:.6f}  b* = {o['b']:.6f}  D* = {o['D']:.6f}  "
          f"eigenvalues = {[round(e, 4) for e in o['eigenvalues']]}  minimum = {o['is_minimum']}")
