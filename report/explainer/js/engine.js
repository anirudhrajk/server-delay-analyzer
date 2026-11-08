/* ============================================================
   SERVER DELAY ENGINE  –  all maths for the prototype
   D(n,b) = A/n + B·n + C/b + E·b + k·n·b
     n = worker threads ("cooks"), b = batch size ("orders per batch")
   Every number shown on the page is computed here – nothing is typed in.
   ============================================================ */
(function (root) {
  'use strict';

  // ---------- the model ----------
  function D(p, n, b) { return p.A / n + p.B * n + p.C / b + p.E * b + p.k * n * b; }
  function terms(p, n, b) {
    return { queue: p.A / n, crowd: p.B * n, setup: p.C / b, wait: p.E * b, clash: p.k * n * b };
  }
  // gradient  ∇D = [∂D/∂n, ∂D/∂b]
  function grad(p, n, b) {
    return [-p.A / (n * n) + p.B + p.k * b, -p.C / (b * b) + p.E + p.k * n];
  }
  // Hessian  H = [[D_nn, D_nb],[D_bn, D_bb]]
  function hess(p, n, b) {
    return [[2 * p.A / (n * n * n), p.k], [p.k, 2 * p.C / (b * b * b)]];
  }

  // ---------- 2x2 linear algebra ----------
  function det2(H) { return H[0][0] * H[1][1] - H[0][1] * H[1][0]; }
  // eigenvalues of a symmetric 2x2 matrix (always real)
  function eig2(H) {
    var a = H[0][0], d = H[1][1], c = H[0][1];
    var m = (a + d) / 2, r = Math.hypot((a - d) / 2, c);
    return [m - r, m + r];
  }
  // solve H x = r  (Cramer's rule)
  function solve2(H, r) {
    var dt = det2(H);
    return [(r[0] * H[1][1] - H[0][1] * r[1]) / dt, (H[0][0] * r[1] - H[1][0] * r[0]) / dt];
  }

  // ---------- Method 0: closed form (exact only when k = 0) ----------
  function closedForm(p) { return { n: Math.sqrt(p.A / p.B), b: Math.sqrt(p.C / p.E) }; }

  // ---------- Method 1: Newton's method  x ← x − H⁻¹∇D ----------
  function newton(p, opts) {
    opts = opts || {};
    var maxIter = opts.maxIter || 60, tol = opts.tol || 1e-10;
    var s0 = closedForm(p), n = s0.n, b = s0.b, path = [];
    for (var it = 0; it <= maxIter; it++) {
      var g = grad(p, n, b), f = D(p, n, b), gn = Math.hypot(g[0], g[1]);
      var row = { it: it, n: n, b: b, D: f, gnorm: gn };
      path.push(row);
      if (gn < tol) break;
      var H = hess(p, n, b), ev = eig2(H), s, kind;
      if (ev[0] > 0) { s = solve2(H, g); kind = 'Newton'; } else { s = [g[0], g[1]]; kind = 'gradient'; }
      var slope = g[0] * s[0] + g[1] * s[1], t = 1, nn = n, bb = b, ok = false;
      for (var j = 0; j < 80; j++) {
        nn = n - t * s[0]; bb = b - t * s[1];
        if (nn > 0 && bb > 0) {
          var ff = D(p, nn, bb);
          if (ff <= f - 1e-4 * t * slope || ff <= f + 1e-13 * Math.abs(f) && gn < 1e-6) { ok = true; break; }
        }
        t /= 2;
      }
      row.step = kind; row.t = t;
      if (!ok) break;
      n = nn; b = bb;
    }
    var last = path[path.length - 1];
    var Hs = hess(p, last.n, last.b);
    return { n: last.n, b: last.b, D: last.D, gnorm: last.gnorm, path: path,
             converged: last.gnorm < 1e-8, H: Hs, eig: eig2(Hs), det: det2(Hs) };
  }

  // ---------- Method 2: brute-force grid search (no calculus at all) ----------
  function gridSearch(p, opts) {
    opts = opts || {};
    var lo = 0.05, hi = 500, N = opts.N || 700, refines = opts.refines || 5, evals = 0;
    var L0 = Math.log(lo), L1 = Math.log(hi), h = (L1 - L0) / (N - 1);
    var best = Infinity, bi = 0, bj = 0;
    for (var i = 0; i < N; i++) {
      var n = Math.exp(L0 + i * h);
      for (var j = 0; j < N; j++) {
        var b = Math.exp(L0 + j * h), v = D(p, n, b); evals++;
        if (v < best) { best = v; bi = n; bj = b; }
      }
    }
    var bn = bi, bb = bj, wn = bn * (Math.exp(2 * h) - 1), wb = bb * (Math.exp(2 * h) - 1), M = 101;
    for (var r = 0; r < refines; r++) {
      var nLo = Math.max(1e-6, bn - wn), bLo = Math.max(1e-6, bb - wb);
      var dn = (bn + wn - nLo) / (M - 1), db = (bb + wb - bLo) / (M - 1), cn = bn, cb = bb;
      for (var a = 0; a < M; a++) {
        var x = nLo + a * dn;
        for (var c = 0; c < M; c++) {
          var y = bLo + c * db, w = D(p, x, y); evals++;
          if (w < best) { best = w; cn = x; cb = y; }
        }
      }
      bn = cn; bb = cb; wn = 2 * dn; wb = 2 * db;
    }
    return { n: bn, b: bb, D: best, evals: evals };
  }

  // ---------- general linear solver (Gaussian elimination, partial pivoting) ----------
  function solveLinear(M, y) {
    var n = y.length, A = M.map(function (r, i) { return r.slice().concat([y[i]]); });
    for (var c = 0; c < n; c++) {
      var piv = c;
      for (var r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      var tmp = A[c]; A[c] = A[piv]; A[piv] = tmp;
      if (Math.abs(A[c][c]) < 1e-300) return null;
      for (var r2 = c + 1; r2 < n; r2++) {
        var f = A[r2][c] / A[c][c];
        for (var k = c; k <= n; k++) A[r2][k] -= f * A[c][k];
      }
    }
    var x = new Array(n);
    for (var i = n - 1; i >= 0; i--) {
      var s = A[i][n];
      for (var j = i + 1; j < n; j++) s -= A[i][j] * x[j];
      x[i] = s / A[i][i];
    }
    return x;
  }

  // ---------- random numbers (seeded => every run is reproducible) ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function gaussian(rng) {
    var u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // ---------- least-squares quadratic surface fit ----------
  // Q(u,v) = c0 + c1 u + c2 v + c3 u² + c4 uv + c5 v²,   u=(n-cn)/wn, v=(b-cb)/wb
  function fitQuadratic(samples, cn, cb, wn, wb) {
    var XtX = [], Xty = [0, 0, 0, 0, 0, 0], i, j;
    for (i = 0; i < 6; i++) XtX.push([0, 0, 0, 0, 0, 0]);
    var rows = samples.map(function (s) {
      var u = (s.n - cn) / wn, v = (s.b - cb) / wb;
      return [1, u, v, u * u, u * v, v * v];
    });
    rows.forEach(function (x, r) {
      for (i = 0; i < 6; i++) {
        Xty[i] += x[i] * samples[r].y;
        for (j = 0; j < 6; j++) XtX[i][j] += x[i] * x[j];
      }
    });
    var c = solveLinear(XtX, Xty);
    if (!c) return null;
    var ss = 0, st = 0, mean = 0, fmin = Infinity, fmax = -Infinity;
    samples.forEach(function (s) { mean += s.y; }); mean /= samples.length;
    rows.forEach(function (x, r) {
      var q = 0; for (i = 0; i < 6; i++) q += c[i] * x[i];
      ss += Math.pow(samples[r].y - q, 2); st += Math.pow(samples[r].y - mean, 2);
      fmin = Math.min(fmin, q); fmax = Math.max(fmax, q);
    });
    var Hs = [[2 * c[3], c[4]], [c[4], 2 * c[5]]];
    var evs = eig2(Hs);
    var st2 = Math.abs(det2(Hs)) > 1e-14 ? solve2(Hs, [-c[1], -c[2]]) : [NaN, NaN];
    var Ho = [[Hs[0][0] / (wn * wn), Hs[0][1] / (wn * wb)], [Hs[1][0] / (wn * wb), Hs[1][1] / (wb * wb)]];
    return {
      c: c, XtX: XtX, Xty: Xty, Hscaled: Hs, eigScaled: evs, H: Ho, eig: eig2(Ho),
      n: cn + wn * st2[0], b: cb + wb * st2[1], pd: evs[0] > 0,
      rmse: Math.sqrt(ss / Math.max(1, samples.length - 6)), r2: st > 0 ? 1 - ss / st : 1,
      signal: fmax - fmin
    };
  }

  // ---------- Method 3 (OUR METHOD): Measure → Fit → Solve → Verify, on a LOG scale, with Zoom ----------
  // It never looks at the formula. It only "measures" noisy delays at chosen settings.
  // Key idea: knobs are measured in "doublings" (u = ln n, v = ln b). On that scale
  // a 1/x + x trade-off becomes an almost perfect bowl (cosh shape), so a quadratic fits it well.
  function ourMethod(p, opts) {
    opts = opts || {};
    var noise = opts.noise == null ? 0.02 : opts.noise;
    var per = opts.perSide || 5, seed = opts.seed == null ? 7 : opts.seed;
    var maxRounds = opts.maxRounds || 14, shrink = opts.shrink || 0.5;
    var R = opts.range || { nLo: 1, nHi: 50, bLo: 1, bHi: 50 };
    var useLog = opts.scale !== 'linear';
    var F = useLog ? Math.log : function (x) { return x; };
    var G = useLog ? Math.exp : function (x) { return x; };
    var LMIN = F(0.25), LMAX = F(400);
    var rng = mulberry32(seed);
    var cu = (F(R.nLo) + F(R.nHi)) / 2, cv = (F(R.bLo) + F(R.bHi)) / 2;
    var hu = (F(R.nHi) - F(R.nLo)) / 2, hv = (F(R.bHi) - F(R.bLo)) / 2;
    var rounds = [], all = [], est = null, stopReason = 'round limit reached', measurements = 0;
    function clampL(x) { return Math.min(LMAX, Math.max(LMIN, x)); }

    for (var r = 0; r < maxRounds; r++) {
      var uLo = clampL(cu - hu), uHi = clampL(cu + hu), vLo = clampL(cv - hv), vHi = clampL(cv + hv);
      var samples = [], bestS = null;
      for (var i = 0; i < per; i++) for (var j = 0; j < per; j++) {
        var u = uLo + (uHi - uLo) * i / (per - 1), v = vLo + (vHi - vLo) * j / (per - 1);
        var n = G(u), b = G(v);
        var y = D(p, n, b) * (1 + noise * gaussian(rng));
        var s = { n: n, b: b, u: u, v: v, y: y, round: r };
        samples.push(s); all.push(s); measurements++;
        if (!bestS || y < bestS.y) bestS = s;
      }
      var mcu = (uLo + uHi) / 2, mcv = (vLo + vHi) / 2, mwu = (uHi - uLo) / 2, mwv = (vHi - vLo) / 2;
      var fit = fitQuadratic(samples.map(function (s) { return { n: s.u, b: s.v, y: s.y }; }), mcu, mcv, mwu, mwv);
      if (fit) { fit.u = fit.n; fit.v = fit.b; fit.n = G(fit.u); fit.b = G(fit.v); }
      var rec = { round: r + 1, nLo: G(uLo), nHi: G(uHi), bLo: G(vLo), bHi: G(vHi),
                  count: samples.length, fit: fit, best: bestS, samples: samples };

      // stop when the bowl is flatter than the measurement noise – zooming more would only fit noise
      if (r > 0 && fit && fit.signal < 6 * fit.rmse) {
        rec.action = 'Stop: bowl is flatter than the noise';
        rounds.push(rec); stopReason = 'noise floor reached – zooming further would only fit noise';
        break;
      }
      var nu, nv, zoom;
      if (fit && fit.pd && isFinite(fit.u) && isFinite(fit.v)) {
        var inside = fit.u >= uLo && fit.u <= uHi && fit.v >= vLo && fit.v <= vHi;
        if (inside) { nu = fit.u; nv = fit.v; zoom = true; rec.action = 'Bowl bottom inside → zoom in'; }
        else {
          nu = Math.min(Math.max(fit.u, uLo), uHi); nv = Math.min(Math.max(fit.v, vLo), vHi); zoom = false;
          rec.action = 'Bowl bottom outside → slide window';
        }
      } else {
        nu = bestS.u; nv = bestS.v; zoom = false;
        rec.action = 'No bowl yet → slide to best reading';
      }
      var moved = est ? Math.hypot(nu - est.u, nv - est.v) : Infinity;
      est = { u: nu, v: nv, n: G(nu), b: G(nv) };
      rec.est = { n: est.n, b: est.b };
      rec.zoom = zoom;
      rounds.push(rec);
      cu = nu; cv = nv;
      if (zoom) { hu *= shrink; hv *= shrink; }
      if (zoom && moved < 1e-7) { stopReason = 'estimate stopped moving'; break; }
    }
    var lastFit = null;
    for (var q = rounds.length - 1; q >= 0; q--) if (rounds[q].est && rounds[q].fit && rounds[q].fit.pd) { lastFit = rounds[q].fit; break; }
    return { n: est.n, b: est.b, D: D(p, est.n, est.b), rounds: rounds, samples: all,
             measurements: measurements, stopReason: stopReason, lastFit: lastFit };
  }

  // ---------- best whole-number setting (you cannot run 9.7 threads) ----------
  function integerBest(p, n, b) {
    var best = null;
    for (var i = Math.max(1, Math.floor(n) - 3); i <= Math.ceil(n) + 3; i++)
      for (var j = Math.max(1, Math.floor(b) - 3); j <= Math.ceil(b) + 3; j++) {
        var v = D(p, i, j);
        if (!best || v < best.D) best = { n: i, b: j, D: v };
      }
    return best;
  }

  // ---------- automatic self-test: many random servers, all methods must agree ----------
  function selfTest(count, seed) {
    var rng = mulberry32(seed || 2026), pass = 0, worst = 0, fails = [];
    for (var t = 0; t < count; t++) {
      var p = { A: 50 + rng() * 950, B: 0.5 + rng() * 19.5, C: 10 + rng() * 490, E: 0.5 + rng() * 19.5, k: rng() * 0.5 };
      var nw = newton(p), gs = gridSearch(p, { N: 260, refines: 4 });
      var rel = Math.abs(nw.D - gs.D) / gs.D;
      var posErr = Math.hypot((nw.n - gs.n) / nw.n, (nw.b - gs.b) / nw.b);
      var ok = nw.converged && nw.eig[0] > 0 && nw.D <= gs.D * (1 + 1e-9) && posErr < 1e-3;
      worst = Math.max(worst, posErr);
      if (ok) pass++; else fails.push({ p: p, newton: nw, grid: gs });
    }
    return { count: count, pass: pass, worstPositionGap: worst, fails: fails };
  }

  // ---------- experiment: linear-scale fitting vs our log-scale fitting ----------
  function scaleExperiment(count, noise, seed) {
    var rng = mulberry32(seed || 99), out = { count: count, noise: noise, linear: { ok: 0, gaps: [] }, log: { ok: 0, gaps: [] } };
    for (var t = 0; t < count; t++) {
      var p = { A: 50 + rng() * 950, B: 0.5 + rng() * 19.5, C: 10 + rng() * 490, E: 0.5 + rng() * 19.5, k: rng() * 0.5 };
      var ex = newton(p);
      ['linear', 'log'].forEach(function (sc) {
        var m = ourMethod(p, { noise: noise, seed: t + 1, scale: sc });
        var gap = (m.D - ex.D) / ex.D;
        out[sc].gaps.push(gap);
        if (gap < 0.01) out[sc].ok++;
      });
    }
    ['linear', 'log'].forEach(function (sc) {
      var g = out[sc].gaps.slice().sort(function (a, b) { return a - b; });
      out[sc].median = g[Math.floor(g.length / 2)]; out[sc].worst = g[g.length - 1];
      out[sc].mean = g.reduce(function (a, b) { return a + b; }, 0) / g.length;
    });
    return out;
  }

  root.Engine = {
    scaleExperiment: scaleExperiment,
    D: D, terms: terms, grad: grad, hess: hess, eig2: eig2, det2: det2, solve2: solve2,
    closedForm: closedForm, newton: newton, gridSearch: gridSearch, solveLinear: solveLinear,
    fitQuadratic: fitQuadratic, ourMethod: ourMethod, integerBest: integerBest, selfTest: selfTest,
    mulberry32: mulberry32
  };
})(typeof window !== 'undefined' ? window : globalThis);
