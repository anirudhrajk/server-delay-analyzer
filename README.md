# Server Delayed: Finding the Minimum Delay of a Server

Linear Algebra & Calculus micro project.

**Server Delay Analyzer** is a website that runs on your own computer. It measures where time goes and explains why something is slow:

| Mode | What you give it | What it tells you |
|---|---|---|
| 🌐 **Website** | an address, e.g. `example.com` | time for each step of loading the page (redirects, DNS, connecting, TLS, server thinking time, download), the slowest files on the page, and the causes, graded with Google's published speed limits |
| 📁 **Folder** | a folder path | how long the folder takes to list and read, and why: many small files, a slow drive, slow file opening (antivirus), cloud-only files, very full folders, build/cache folders |
| ⚙️ **Program** | a running program, or a command | CPU, disk, memory and network use; how much time is computing and how much is waiting |
| ⚙️ **Program → Tune** | a command with `{n}` (threads) and `{b}` (batch size) | the fastest setting, found with **our formula**, confirmed by real runs |
| 📈 **Your data** | a CSV of threads, batch size and delay | the fastest setting and the causes of delay, from **our formula** |

No API key, account or internet service is needed (the website scan only contacts the website you type).

## How to run (VS Code)
1. Open the `Server Delayed` folder in VS Code (**File → Open Folder**).
2. Open a terminal (**Terminal → New Terminal**) and install the packages once:
   ```
   pip install -r requirements.txt
   ```
3. Start the website:
   ```
   python app.py
   ```
4. Open **http://127.0.0.1:5050** in your browser (the exact address is printed in the terminal). Press **Ctrl+C** in the terminal to stop.

   The app uses port 5050, not 5000, because other projects (like SignBridge) use 5000. If 5050 is busy it picks the next free port and prints it.

You can also press **F5** and pick **"Run website (app.py)"**. After changing any Python file, stop the server (Ctrl+C) and start it again.

- **Tests:** `python -m unittest discover tests` (27 tests)
- **Independent maths check:** `python verify.py`

## Accuracy: what is and is not possible
No delay tool can be 100% accurate: networks, disks and CPUs change from one second to the next, and caches make a second reading faster than the first. So the analyzer:
- measures several times and shows the **middle value and the spread** (website visits, command runs);
- says in plain words **what it could not see**, in a "How sure are we?" box on every result;
- for tuning, **never trusts the formula alone**: the recommended setting is always one that was actually run, and the formula's prediction is compared with that measurement (typically within 2–5% on the demo).

## Our method in the app: Measure → Fit → Solve → Verify → Zoom
Used by **Program → Tune** (and the fit/solve part by **Your data**):

1. **Measure** the program on a grid of settings on a doubling scale (for example threads 1, 2, 4, 8, 16 × batch 1 … 32).
2. **Screen**: settings over 10× slower than the typical one are **overloaded** (the queue grows without limit, a cliff no smooth formula can follow). They are reported as a cause and kept out of the fit.
3. **Fit** our delay formula by least squares:
   ```
   D(n,b) = D0 + A/n + B·n + C/b + E·b + k·n·b
            base  queue  crowd  setup  wait  clash
   ```
   This is linear in the unknowns, so it is a least-squares problem on the columns 1, 1/n, n, 1/b, b, n·b. Every cost is kept ≥ 0 (non-negative least squares), and each row is weighted by 1/delay, so the fit minimises **relative** error. Measurement noise grows with the delay, and one huge reading cannot drag the fit.
4. **Solve**: set ∂D/∂n = ∂D/∂b = 0 and solve with **Newton's method** (a 2×2 linear system H·Δ = ∇D per step), then check that both **Hessian eigenvalues** are > 0 (a true minimum).
5. **Verify**: run the formula's best unmeasured setting for real, refit, and repeat. Settings with no more capacity than an overloaded one are skipped.
6. **Zoom** (from our Log-Scale Bowl Search): around the best measured setting, measure the halfway points on the doubling scale, halving the step each round. This finds optima that sit right next to an overload cliff.
7. **Confirm**: re-run the two best settings and keep the winner.

On the demo server (`samples/demo_server.py`, true best ≈ 8.1 ms at 5 threads × batch 2) the tuner landed within 0–1.5% of the true best in every trial, in about 45 runs.

**Your data** cannot re-run anything, so it recommends the formula's best whole-number setting, unless the formula fits poorly (typical error over 25%) or that setting is next to overloaded ones; then it recommends the best measured setting instead.

### Fit quality shown on the page
- **Typical error**: the median of |predicted − measured| / measured over all settings. Good ≤ 10%, fair ≤ 25%.
- **Relative R²**: R² on the same 1/delay-weighted scale that the fit minimises.

## Files
| File | What it is |
|---|---|
| `app.py` | Flask web server: the page, the scan endpoints, background jobs, and the safety checks |
| `jobs.py` | Runs scans in the background with progress and Cancel |
| `delay_model.py` | The delay formula, Newton's method, Hessian check, best whole-number setting |
| `analyzer.py` | Reads CSV data, screens overload, fits the formula (weighted NNLS), explains the causes |
| `scanners/website.py` | Website scanner |
| `scanners/folder.py` | Folder scanner |
| `scanners/program.py` | Program watcher, command timer, and the tuner |
| `scanners/common.py` | Shared report format and helpers |
| `verify.py` | Independent check of the maths with NumPy, SciPy and SymPy |
| `tests/` | Automatic tests (`python -m unittest discover tests`) |
| `samples/sample_server_log.csv` | Example measurements for **Your data** |
| `samples/demo_server.py` | Simulated batching server for trying **Tune** |
| `web/` | The website (`index.html`, `css/style.css`, `js/app.js`) |
| `report/explainer/` | The original interactive maths explainer, for the report and the viva (open `report/explainer/index.html` directly) |
| `requirements.txt` | Python packages |
| `.vscode/launch.json` | F5 run settings for VS Code |

## Safety
- The server listens only on `127.0.0.1`, so other computers cannot reach it.
- It can run commands and read folders, so every request must carry a secret token that is put into the page when you open it. Requests from other websites, and DNS-rebinding tricks, are refused.
- Folder scans only open files for reading. Online-only cloud files are never opened, because opening one would download it.
- Website scans are gentle: about as many requests as one visit with a browser (at most 60 page files, 6 at a time). The app does **not** load-test websites.
- Commands run with your own permissions and have a time limit. Cancel stops them, including any child processes.

## Verified numbers (default kitchen: A=400, B=4, C=90, E=2.5, k=0.05)
| Method | n* | b* | D* (ms) |
|---|---|---|---|
| Newton (`delay_model.py`) | 9.673458 | 5.492191 | 112.817896 |
| SciPy optimiser (`verify.py`) | 9.673458 | 5.492191 | 112.817896 |
| Analyzer, from noiseless measurements | 9.673458 | 5.492191 | 112.817896 |
| Hessian eigenvalues | 0.8721, 1.0982 | both > 0 | **minimum** ✓ |

The best whole-number setting is 10 threads × batches of 5, which gives 113.00 ms (only +0.16% above the true minimum). The tests check all of this automatically.

## The kitchen picture (for the presentation)
A server is a **kitchen**, requests are **orders**, and delay is **how long a customer waits**.
- **n = cooks (worker threads).** With too few, orders pile up. With too many, they bump into each other.
- **b = batch size.** Cooking 1 pizza at a time means re-heating the oven every time. Waiting for 30 orders means the first customer starves.

The same idea appears in the website and folder scans: a fixed **setup cost** (opening a connection, opening a file) paid again and again is the C/b term of the formula. Reusing connections and bundling small files are the website and folder versions of "use bigger batches".

## Log-Scale Bowl Search (in the explainer)
`report/explainer/` shows the full method for when you can choose what to measure: measure a 5×5 grid on a log (doubling) scale, fit a quadratic bowl by least squares, jump to its bottom, check the fitted Hessian, zoom in, and stop when the bowl is flatter than the noise. On the log scale, A/n + B·n = 2√(AB)·cosh(u − u*), which `verify.py` proves with SymPy. With 300 random servers and 2% noise, the log scale lands within 1% of the best delay 300/300 times, against about 1 in 3 on the ordinary scale.

## Honest note on originality
Least squares, Newton's method, quadratic-surface fitting and pattern search are standard tools (Response Surface Methodology, Box & Wilson, 1951). Our contribution is:
1. our own delay model with a plain-language cause for every term, applied to uploaded data and to real programs;
2. fitting and zooming on a **log (doubling) scale**, backed by the exact cosh identity;
3. **relative-error** fitting with overload screening, so a model that cannot follow a queueing cliff is never trusted blindly; and
4. a verify-by-measuring loop, so every recommendation is a setting that was really run.

## Hosted version (Render)

`render.yaml` deploys the app as a public website with `SDA_HOSTED=1`. On the public
site, scans that would touch the server's own computer are switched off:

* Website scans work, but private and internal addresses are refused.
* Your data (CSV upload) works as normal.
* Folder: you can still list a folder's files in your browser; timing a folder needs the local app.
* Program: only the tuner with the built-in demo server; watching programs and running
  commands need the local app (`python app.py`).
