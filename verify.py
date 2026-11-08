"""
verify.py  -  Independent check of the Server Delay Minimizer
=============================================================
This script does NOT reuse any code from the website. It re-does the maths
with standard, trusted Python libraries (NumPy, SciPy, SymPy) so the numbers
on the website can be checked by anyone.

Run:   pip install numpy scipy sympy
       python verify.py
"""
import numpy as np
from scipy.optimize import minimize
import sympy as sp

# ------------------------------------------------------------------
# 1. Symbolic proof (SymPy): derivatives, Hessian, k = 0 closed form, cosh identity
# ------------------------------------------------------------------
n, b, A, B, C, E, k, u = sp.symbols('n b A B C E k u', positive=True)
D = A/n + B*n + C/b + E*b + k*n*b

Dn, Db = sp.diff(D, n), sp.diff(D, b)
H = sp.hessian(D, (n, b))
print("=== 1. SYMBOLIC CHECK (SymPy) ===")
print("dD/dn =", Dn)
print("dD/db =", Db)
print("Hessian =", H.tolist())
sol = sp.solve([Dn.subs(k, 0), Db.subs(k, 0)], [n, b], dict=True)
print("k = 0 critical point:", sol)

# On the log scale (n = e^u) the trade-off A/n + B*n is 2*sqrt(AB)*cosh(u - u*)
ustar = sp.log(sp.sqrt(A/B))
lhs = A*sp.exp(-u) + B*sp.exp(u)
rhs = 2*sp.sqrt(A*B)*sp.cosh(u - ustar)
print("Log-scale cosh identity holds:", sp.simplify((lhs - rhs).rewrite(sp.exp)) == 0)

# ------------------------------------------------------------------
# 2. Numerical minimum for the website's presets (SciPy optimiser)
# ------------------------------------------------------------------
PRESETS = {
    "Default kitchen": dict(A=400, B=4,  C=90,  E=2.5, k=0.05),
    "Rush hour":       dict(A=950, B=3,  C=120, E=2,   k=0.04),
    "Tiny kitchen":    dict(A=300, B=15, C=60,  E=6,   k=0.2),
    "Heavy clash":     dict(A=600, B=2,  C=300, E=1.5, k=0.45),
}

def delay(x, p):
    nn, bb = x
    return p['A']/nn + p['B']*nn + p['C']/bb + p['E']*bb + p['k']*nn*bb

def grad(x, p):
    nn, bb = x
    return np.array([-p['A']/nn**2 + p['B'] + p['k']*bb, -p['C']/bb**2 + p['E'] + p['k']*nn])

def hess(x, p):
    nn, bb = x
    return np.array([[2*p['A']/nn**3, p['k']], [p['k'], 2*p['C']/bb**3]])

print("\n=== 2. NUMERICAL MINIMUM (SciPy L-BFGS-B + NumPy eigenvalues) ===")
print(f"{'preset':<16}{'n*':>12}{'b*':>12}{'D* (ms)':>14}{'|grad|':>11}   eigenvalues of H")
for name, p in PRESETS.items():
    x0 = [np.sqrt(p['A']/p['B']), np.sqrt(p['C']/p['E'])]
    r = minimize(delay, x0, args=(p,), jac=grad, method='L-BFGS-B',
                 bounds=[(1e-3, 1e3), (1e-3, 1e3)], options=dict(ftol=1e-15, gtol=1e-12))
    ev = np.linalg.eigvalsh(hess(r.x, p))
    print(f"{name:<16}{r.x[0]:>12.6f}{r.x[1]:>12.6f}{r.fun:>14.6f}{np.linalg.norm(grad(r.x, p)):>11.1e}   "
          f"{ev[0]:.4f}, {ev[1]:.4f}  ->  {'MINIMUM (positive definite)' if ev.min() > 0 else 'NOT a minimum'}")

# ------------------------------------------------------------------
# 3. Brute force: is there any lower point on a fine grid?
# ------------------------------------------------------------------
print("\n=== 3. BRUTE-FORCE GRID (1000 x 1000 points, 0.05 .. 500 on a log grid) ===")
g = np.exp(np.linspace(np.log(0.05), np.log(500), 1000))
NN, BB = np.meshgrid(g, g, indexing='ij')
for name, p in PRESETS.items():
    Z = delay((NN, BB), p)
    i, j = np.unravel_index(np.argmin(Z), Z.shape)
    print(f"{name:<16} grid best n={NN[i, j]:.3f}  b={BB[i, j]:.3f}  D={Z[i, j]:.6f}")

# ------------------------------------------------------------------
# 4. Our method's core step, re-done with NumPy least squares (log scale)
# ------------------------------------------------------------------
print("\n=== 4. LOG-SCALE QUADRATIC FIT WITH numpy.linalg.lstsq (no noise, shrinking window) ===")
p = PRESETS["Default kitchen"]
cu, cv, hu, hv = np.log(np.sqrt(50)), np.log(np.sqrt(50)), np.log(50)/2, np.log(50)/2
for rnd in range(1, 9):
    us = np.linspace(cu - hu, cu + hu, 5); vs = np.linspace(cv - hv, cv + hv, 5)
    U, V = np.meshgrid(us, vs, indexing='ij'); U, V = U.ravel(), V.ravel()
    y = delay((np.exp(U), np.exp(V)), p)
    s, t = (U - cu)/hu, (V - cv)/hv
    X = np.column_stack([np.ones_like(s), s, t, s*s, s*t, t*t])
    c, *_ = np.linalg.lstsq(X, y, rcond=None)
    Hq = np.array([[2*c[3], c[4]], [c[4], 2*c[5]]])
    st = np.linalg.solve(Hq, -c[1:3])
    cu, cv = cu + hu*st[0], cv + hv*st[1]
    hu, hv = hu/2, hv/2
    print(f"round {rnd}: n = {np.exp(cu):.6f}  b = {np.exp(cv):.6f}  "
          f"eigenvalues of fitted H = {np.round(np.linalg.eigvalsh(Hq), 3)}")
print("The website should show n* = 9.673458, b* = 5.492191, D* = 112.817896 for the default kitchen.")
