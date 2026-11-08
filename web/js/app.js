/* Server Delay Analyzer – page logic.
   All measuring and maths run in Python (app.py and the scanners). This file sends
   what you typed, shows progress, and draws the results it gets back.
   Visual effects: WebThreads (background), Shredder (file list), MagicBento (dashboard),
   from React Bits, ported to plain JavaScript in webthreads.js, shredder.js, magicbento.js. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const TOKEN = (document.querySelector('meta[name="app-token"]') || {}).content || '';
  const HOSTED = ((document.querySelector('meta[name="app-hosted"]') || {}).content || '') === '1';
  const USER = ((document.querySelector('meta[name="app-user"]') || {}).content || '');
  if (HOSTED) document.documentElement.classList.add('hosted');
  const ON_SERVER = /^https?:$/.test(location.protocol) && TOKEN && TOKEN.indexOf('{{') !== 0;

  // ------------------------------------------------------------------ helpers
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function ms(x) {
    if (x == null || !isFinite(x)) return '—';
    if (x >= 10000) return (x / 1000).toFixed(1) + ' s';
    if (x >= 1000) return (x / 1000).toFixed(2) + ' s';
    if (x >= 100) return x.toFixed(0) + ' ms';
    if (x >= 10) return x.toFixed(1) + ' ms';
    return x.toFixed(2) + ' ms';
  }
  function bytes(n) {
    if (n == null || !isFinite(n)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return i ? n.toFixed(1) + ' ' + u[i] : Math.round(n) + ' B';
  }
  const num = (x) => (Math.abs(x - Math.round(x)) < 1e-9 ? String(Math.round(x)) : Number(x).toFixed(1));
  const setting = (n, b) => num(n) + ' thread' + (n == 1 ? '' : 's') + ', batches of ' + num(b);

  async function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'X-Token': TOKEN }, opts.headers || {});
    let r;
    try { r = await fetch(path, opts); }
    catch (e) { throw new Error('Cannot reach the analyzer. Is "python app.py" still running?'); }
    let j;
    try { j = await r.json(); } catch (e) { throw new Error('The analyzer sent an unexpected reply (HTTP ' + r.status + ').'); }
    if (r.status === 401 && j.login) { location.replace('/login'); throw new Error('Please sign in again.'); }
    if (!r.ok) throw new Error(j.error || ('Error ' + r.status));
    return j;
  }
  const postJSON = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  function showError(msg) { $('error').textContent = msg || ''; $('error').hidden = !msg; }

  // remember what was typed (per browser, only for convenience)
  function remember(id) {
    const el = $(id), key = 'sda:' + id;
    try {
      const v = localStorage.getItem(key);
      if (v != null) { if (el.type === 'checkbox') el.checked = v === '1'; else el.value = v; }
    } catch (e) { /* storage blocked: fine */ }
    el.addEventListener('change', () => {
      try { localStorage.setItem(key, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value); } catch (e) { /* ignore */ }
    });
  }
  ['w-url', 'w-samples', 'w-files', 'd-path', 'd-read', 'pr-seconds', 'r-cmd', 'r-repeats', 'r-timeout', 'r-cwd', 'r-shell',
   't-cmd', 't-n', 't-b', 't-metric', 't-repeats', 't-cn', 't-cb', 't-timeout', 't-cwd', 't-shell'].forEach(remember);

  // ------------------------------------------------------------------ background (React Bits WebThreads)
  try {
    if (window.WebThreads) {
      window.WebThreads($('bgThreads'), { colors: ['#5227FF', '#FF9FFC'], coreColor: '#FFFFFF', threadCount: 6, spread: 0.18 });
    }
  } catch (e) { /* no WebGL2: the page still works on plain black */ }

  // MagicBento settings asked for (dashboard)
  const BENTO = { columns: 4, rowHeight: 200, gap: 12, radius: 20, enableBorderGlow: true, enableSpotlight: true,
                  spotlightRadius: 300, clickEffect: true };
  // Shredder settings asked for (file list)
  const SHRED = { width: 340, height: 460, feedSpeed: 180, bite: 18, stripWidth: 10, curl: 1, autoAnimate: false,
                  loop: false, loopAfterDelete: false, fallHeight: 140 };

  // ------------------------------------------------------------------ modes
  let mode = 'website';
  const lastResult = {};
  function setMode(m) {
    mode = m;
    document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'p-' + m));
    showError('');
    syncReopen();
    if (m === 'program' && !procsLoaded && !HOSTED) loadProcesses();
    try { localStorage.setItem('sda:mode', m); } catch (e) { /* ignore */ }
  }
  function currentResult() {
    if (lastResult[mode]) return lastResult[mode];
    if (mode === 'folder' && localFolder) return { kind: 'local' };
    return null;
  }
  document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  document.querySelectorAll('.sub-mode').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.sub-mode').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.subpanel').forEach((p) => p.classList.toggle('active', p.id === 's-' + b.dataset.sub));
  }));

  // ------------------------------------------------------------------ jobs
  let job = null, pollTimer = null;
  function setBusy(busy) {
    document.querySelectorAll('.scan-btn, #analyzeBtn, #sampleBtn').forEach((b) => {
      b.disabled = busy || (b.id === 'analyzeBtn' && !$('file').files[0]) || (b.id === 'pr-watch' && !pickedPid);
    });
  }
  function showProgress(p, msg, elapsed) {
    $('progress').hidden = false;
    $('progBar').style.width = Math.round((p || 0) * 100) + '%';
    $('progMsg').textContent = msg || '';
    $('progTime').textContent = elapsed != null ? Math.round(elapsed) + ' s' : '';
  }
  async function startJob(path, body) {
    if (job) return;
    showError('');
    lastResult[mode] = null;
    syncReopen();
    setBusy(true);
    try {
      const r = await postJSON(path, body);
      job = { id: r.job, mode: mode };
      showProgress(0, 'Starting…', 0);
      poll();
    } catch (e) { showError(e.message); setBusy(false); }
  }
  function poll() {
    pollTimer = setTimeout(async () => {
      try {
        const s = await api('/api/jobs/' + job.id);
        showProgress(s.progress, s.message, s.elapsed);
        if (s.status === 'running') return poll();
        const forMode = job.mode;
        endJob();
        if (s.status === 'done') {
          lastResult[forMode] = s.result;
          if (mode === forMode) openResults(s.result);
          syncReopen();
        } else if (s.status === 'error') showError(s.error);
      } catch (e) { endJob(); showError(e.message); }
    }, 400);
  }
  function endJob() { job = null; clearTimeout(pollTimer); $('progress').hidden = true; setBusy(false); }
  $('cancelBtn').addEventListener('click', () => {
    if (!job) return;
    $('progMsg').textContent = 'Cancelling…';
    api('/api/jobs/' + job.id + '/cancel', { method: 'POST' }).catch(() => {});
  });

  // ------------------------------------------------------------------ results view (own full screen)
  // Opens with React Bits ScrollExpand: a small rounded window with the name in it, which then
  // opens to full screen by itself (no scrolling). Back = PS5-style: the report pushes outward.
  let se = null, rvOpen = false, rvBusy = false, rvReturn = null;
  const RV_TITLE = { website: 'Website', folder: 'Folder', process: 'Program', command: 'Command', data: 'Your data', tune: 'Tuning', local: 'Folder' };
  function shortName(r) {
    if (r.kind === 'local') return localFolder ? localFolder.name : 'Folder';
    if (r.kind === 'data') return 'Your measurements';
    if (r.kind === 'tune') return 'Best setting';
    let t = String(r.target || RV_TITLE[r.kind] || 'Report');
    try { if (r.kind === 'website') t = new URL(t).hostname.replace(/^www\./, ''); } catch (e) { /* keep */ }
    t = t.replace(/[\\/]+$/, '');
    const parts = t.split(/[\\/]/);
    if (parts.length > 1 && r.kind === 'folder') t = parts[parts.length - 1] || t;
    return t.length > 26 ? t.slice(0, 25) + '…' : t;
  }
  function openResults(r) {
    if (!r) return;
    rvReturn = document.activeElement;
    const view = $('resultsView'), scroller = $('rvScroll');
    view.classList.remove('leaving');
    view.hidden = false;
    document.documentElement.classList.add('rv-open');
    rvOpen = true; rvBusy = true;
    const old = se;
    se = window.ScrollExpand($('rvStage'), {
      media: scroller, title: shortName(r), scrollHint: 'Report ready',
      autoPlay: true, overlayScrim: 0, startWidth: 46, startHeight: 52, startRadius: 28, mediaZoom: 1.35,
      onProgress: (p, e) => { scroller.style.filter = e >= 1 ? 'none' : 'brightness(' + (0.28 + 0.72 * e).toFixed(3) + ') blur(' + (3 * (1 - e)).toFixed(2) + 'px)'; }
    });
    if (old) old.destroy();
    const t = se.el.querySelector('.scroll-expand__title');
    if (t) { const k = document.createElement('small'); k.textContent = RV_TITLE[r.kind] || 'Report'; t.prepend(k); }
    scroller.scrollTop = 0;
    showResult(r);
    setTimeout(() => { if (rvOpen) document.documentElement.classList.add('rv-covered'); }, 600);
    se.play({ duration: 1500, delay: 550 }).then(() => {
      // fully open: drop the effect styles so the report scrolls and lays out normally
      se.media.style.transform = 'none'; se.media.style.willChange = 'auto'; se.media.style.filter = 'none';
      se.frame.style.clipPath = 'none'; se.frame.style.willChange = 'auto';
      rvBusy = false;
      $('rvBack').focus({ preventScroll: true });
    });
  }
  function closeResults() {
    if (!rvOpen) return;
    const view = $('resultsView');
    rvOpen = false;
    document.documentElement.classList.remove('rv-covered');
    view.classList.add('leaving');
    document.documentElement.classList.remove('rv-open');
    setTimeout(() => {
      if (rvOpen) return;
      view.hidden = true; view.classList.remove('leaving');
      syncReopen();
      if (rvReturn && rvReturn.focus) rvReturn.focus({ preventScroll: true });
    }, 420);
  }
  function syncReopen() { $('reopen').hidden = rvOpen || !currentResult(); }
  $('rvBack').addEventListener('click', closeResults);
  $('reopen').addEventListener('click', () => openResults(currentResult()));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && rvOpen && !rvBusy) closeResults(); });

  // ------------------------------------------------------------------ website / folder
  $('f-website').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!$('w-url').value.trim()) return showError('Type a website address, for example https://example.com');
    startJob('/api/scan/website', { url: $('w-url').value, samples: +$('w-samples').value, files: $('w-files').checked });
  });
  $('f-folder').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!$('d-path').value.trim()) {
      return showError(localFolder
        ? 'To time "' + localFolder.name + '", paste its full path, for example C:\\Users\\you\\' + localFolder.name +
          '\n(Browsers never tell a page where a folder is on your disk.)'
        : 'Type the path of a folder, for example C:\\Users\\you\\Documents');
    }
    startJob('/api/scan/folder', { path: $('d-path').value, read_mb: +$('d-read').value });
  });

  // ---------- folder picked in the browser (listed here only, never uploaded)
  let localFolder = null;
  const MAX_LOCAL = 50000;
  function setLocalFolder(entries) {
    if (!entries.length) { showError('That folder looks empty, or the browser could not read it.'); return; }
    const root = entries[0].path.split('/')[0] || 'Folder';
    const files = entries.map((f) => ({ path: f.path.indexOf('/') >= 0 ? f.path.slice(f.path.indexOf('/') + 1) : f.path, size: f.size }));
    const total = files.reduce((s, f) => s + f.size, 0);
    const dirs = new Set();
    files.forEach((f) => { const parts = f.path.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); });
    localFolder = { name: root, files, total, dirs: dirs.size, capped: entries.length >= MAX_LOCAL };
    $('fdrop').classList.add('has');
    $('fdropMain').innerHTML = '<b>' + esc(root) + '</b> · ' + files.length.toLocaleString() + (localFolder.capped ? '+' : '') +
      ' files · ' + bytes(total) + ' · <u>change</u>';
    showError('');
    if (mode === 'folder') openResults(currentResult());
    syncReopen();
    $('d-path').focus();
  }
  $('fpick').addEventListener('change', () => {
    const list = Array.from($('fpick').files).slice(0, MAX_LOCAL);
    setLocalFolder(list.map((f) => ({ path: f.webkitRelativePath || f.name, size: f.size })));
  });
  const fdrop = $('fdrop');
  ['dragenter', 'dragover'].forEach((ev) => fdrop.addEventListener(ev, (e) => { e.preventDefault(); fdrop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => fdrop.addEventListener(ev, (e) => { e.preventDefault(); fdrop.classList.remove('over'); }));
  fdrop.addEventListener('drop', async (e) => {
    const items = Array.from(e.dataTransfer.items || []).map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (!items.length) return;
    $('fdropMain').textContent = 'Reading the folder…';
    const out = [];
    const fileOf = (entry) => new Promise((res) => entry.file((f) => res(f), () => res(null)));
    const readAll = (reader) => new Promise((res) => {
      const all = [];
      const next = () => reader.readEntries((batch) => { if (!batch.length) return res(all); all.push.apply(all, batch); next(); }, () => res(all));
      next();
    });
    async function walk(entry, prefix) {
      if (out.length >= MAX_LOCAL) return;
      if (entry.isFile) { const f = await fileOf(entry); if (f) out.push({ path: prefix + entry.name, size: f.size }); }
      else if (entry.isDirectory) { for (const child of await readAll(entry.createReader())) await walk(child, prefix + entry.name + '/'); }
    }
    for (const it of items) await walk(it, items.length > 1 || it.isFile ? 'Dropped/' : '');
    setLocalFolder(out);
  });

  // ------------------------------------------------------------------ program: watch
  let procs = [], procsLoaded = false, pickedPid = null;
  async function loadProcesses() {
    procsLoaded = true;
    $('pr-list').innerHTML = '<p class="hint">Loading programs…</p>';
    try { procs = (await api('/api/processes')).processes; drawProcesses(); }
    catch (e) { $('pr-list').innerHTML = '<p class="hint">' + esc(e.message) + '</p>'; procsLoaded = false; }
  }
  function drawProcesses() {
    const f = $('pr-filter').value.trim().toLowerCase();
    const rows = procs.filter((p) => !f || p.name.toLowerCase().includes(f) || String(p.pid) === f);
    $('pr-list').innerHTML = '<table><tr><th>Program</th><th class="num">PID</th><th class="num">CPU now</th><th class="num">Memory</th></tr>' +
      rows.map((p) => '<tr class="pick' + (p.pid === pickedPid ? ' sel' : '') + '" data-pid="' + p.pid + '"><td>' + esc(p.name) + '</td><td class="num">' + p.pid +
        '</td><td class="num">' + p.cpu.toFixed(0) + '%</td><td class="num">' + (p.mem / 1048576).toFixed(0) + ' MB</td></tr>').join('') +
      (rows.length ? '' : '<tr><td colspan="4" class="muted">No matching program.</td></tr>') + '</table>';
  }
  $('pr-list').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-pid]');
    if (!tr) return;
    pickedPid = +tr.dataset.pid;
    drawProcesses();
    setBusy(!!job);
  });
  $('pr-filter').addEventListener('input', drawProcesses);
  $('pr-refresh').addEventListener('click', loadProcesses);
  $('pr-watch').addEventListener('click', () => {
    if (pickedPid) startJob('/api/scan/process', { pid: pickedPid, seconds: +$('pr-seconds').value });
  });

  // ------------------------------------------------------------------ program: run / tune
  $('f-run').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!$('r-cmd').value.trim()) return showError('Type a command to run, for example:  python my_script.py');
    startJob('/api/scan/command', { command: $('r-cmd').value, cwd: $('r-cwd').value, repeats: +$('r-repeats').value,
                                    timeout: +$('r-timeout').value, shell: $('r-shell').checked });
  });
  function countValues(s) { return new Set(String(s).split(/[\s,;]+/).filter((x) => /^\d+$/.test(x))).size; }
  function tunePlan() {
    const g = countValues($('t-n').value) * countValues($('t-b').value), r = +$('t-repeats').value;
    $('t-plan').textContent = g ? 'About ' + (g * r + 4) + ' to ' + (g * r + 8 + 24 + 2 * Math.max(2, r)) + ' runs.' : '';
  }
  ['t-n', 't-b', 't-repeats'].forEach((id) => $(id).addEventListener('input', tunePlan));
  tunePlan();
  $('t-demo').addEventListener('click', () => {
    $('t-cmd').value = 'python samples/demo_server.py --threads {n} --batch {b}';
    $('t-n').value = '1, 2, 4, 8, 16'; $('t-b').value = '1, 2, 4, 8, 16, 32';
    $('t-metric').value = 'printed'; $('t-cwd').value = ''; $('t-cn').value = '4'; $('t-cb').value = '16';
    ['t-cmd', 't-n', 't-b', 't-metric', 't-cwd', 't-cn', 't-cb'].forEach((id) => $(id).dispatchEvent(new Event('change')));
    tunePlan();
  });
  if (HOSTED) {
    const tuneTab = document.querySelector('.sub-mode[data-sub=tune]');
    if (tuneTab) tuneTab.click();
    $('t-demo').click();
    ['t-cmd', 't-cwd'].forEach((id) => { $(id).readOnly = true; });
    $('t-shell').disabled = true;
  }
  $('f-tune').addEventListener('submit', (e) => {
    e.preventDefault();
    startJob('/api/scan/tune', {
      template: $('t-cmd').value, n_values: $('t-n').value, b_values: $('t-b').value, metric: $('t-metric').value,
      repeats: +$('t-repeats').value, current_n: $('t-cn').value, current_b: $('t-cb').value,
      timeout: +$('t-timeout').value, cwd: $('t-cwd').value, shell: $('t-shell').checked });
  });

  // ------------------------------------------------------------------ your data (upload)
  const drop = $('drop'), file = $('file');
  function fileChosen() {
    const f = file.files[0];
    drop.classList.toggle('has', !!f);
    $('dropMain').innerHTML = f ? '<b>' + esc(f.name) + '</b> · ' + (f.size / 1024).toFixed(1) + ' KB · <u>change</u>'
                                : 'Drop your measurements here, or <u>choose a file</u>';
    setBusy(!!job);
  }
  file.addEventListener('change', fileChosen);
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) { file.files = e.dataTransfer.files; fileChosen(); } });
  async function upload(useSample) {
    const fd = new FormData();
    if (useSample) fd.append('sample', '1'); else if (file.files[0]) fd.append('file', file.files[0]);
    fd.append('threads', $('threads').value); fd.append('batch', $('batch').value);
    showError(''); setBusy(true);
    try {
      const res = await api('/api/analyze', { method: 'POST', body: fd });
      lastResult.data = res;
      if (mode === 'data') openResults(res);
      syncReopen();
    } catch (e) { showError(e.message); }
    setBusy(false);
  }
  $('form').addEventListener('submit', (e) => { e.preventDefault(); upload(false); });
  $('sampleBtn').addEventListener('click', () => upload(true));

  // ------------------------------------------------------------------ dashboard (React Bits MagicBento)
  let bentos = [], explorer = null, sizer = null, LAST = null, MAP = null;
  function clearDash() {
    bentos.forEach((b) => b.destroy()); bentos = [];
    if (explorer) { explorer.destroy(); explorer = null; }
    if (sizer) { sizer.disconnect(); sizer = null; }
    $('dash').innerHTML = ''; $('details').innerHTML = '';
    LAST = null; MAP = null;
  }
  function bento(host, items, extra) {
    const b = window.MagicBento(host, items, Object.assign({}, BENTO, extra || {}));
    bentos.push(b);
    return b;
  }
  // canvases follow the size of their card, so charts stay sharp at every column count
  function autoDraw(canvas, draw) {
    const fit = () => {
      const w = Math.round(canvas.clientWidth), h = Math.round(canvas.clientHeight);
      if (w < 20 || h < 20) return;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      draw();
    };
    if (!sizer) sizer = new ResizeObserver((entries) => entries.forEach((e) => e.target._fit && e.target._fit()));
    canvas._fit = fit;
    sizer.observe(canvas);
    fit();
  }

  function when(d) {
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const diff = Math.round((day - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
    if (diff === 0) return 'Today, ' + t;
    if (diff === 1) return 'Yesterday, ' + t;
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === day.getFullYear() ? undefined : 'numeric' }) + ', ' + t;
  }
  window.__sdaWhen = when;

  function showResult(r) {
    clearDash();
    if (!r) return;
    const KIND = { website: 'Website analyzed', folder: 'Folder scanned', process: 'Program watched', command: 'Command timed',
                   data: 'Measurements analyzed', tune: 'Settings tuned', local: 'Folder picked' };
    $('dashKind').textContent = KIND[r.kind] || 'Report';
    if (r.kind === 'data' || r.kind === 'tune') renderFormula(r);
    else if (r.kind === 'local') renderLocal();
    else renderReport(r);
    // the thing that was analyzed: a real link for websites
    const tg = $('dashTarget'), txt = tg.textContent;
    if (r.kind === 'website' && /^https?:\/\//i.test(txt)) {
      tg.innerHTML = '<a href="' + esc(txt) + '" target="_blank" rel="noopener noreferrer">' +
        esc(txt.replace(/^https?:\/\//i, '').replace(/\/$/, '')) + ' <span aria-hidden="true">&#8599;</span></a>';
    }
    $('dashWhen').textContent = when(r._savedAt ? new Date(r._savedAt * 1000) : new Date());
  }

  // monochrome: shades of white, brightest = the part that matters most
  const PART_COLORS = { redirect: 'rgba(245,245,247,.22)', dns: 'rgba(245,245,247,.38)', connect: 'rgba(245,245,247,.52)', tls: 'rgba(245,245,247,.66)', wait: 'rgba(245,245,247,.95)', download: 'rgba(245,245,247,.8)',
                        list: 'rgba(245,245,247,.4)', open: 'rgba(245,245,247,.9)', data: 'rgba(245,245,247,.62)', cpu: 'rgba(245,245,247,.9)', waiting: 'rgba(245,245,247,.42)' };
  const SPARE = ['rgba(245,245,247,.85)', 'rgba(245,245,247,.65)', 'rgba(245,245,247,.48)', 'rgba(245,245,247,.34)', 'rgba(245,245,247,.24)', 'rgba(245,245,247,.16)'];
  const colorOf = (key, i, map) => (map || PART_COLORS)[key] || SPARE[i % SPARE.length];

  function causeCard(c, cls, extraHtml) {
    return '<div class="cause ' + (cls || '') + '"><div class="cause-head"><span class="cause-name">' +
      (c.severity ? '<span class="sev ' + esc(c.severity) + '">' + esc(c.severity) + '</span>' : '') + esc(c.name) + '</span>' +
      (c.impact ? '<span class="cause-extra">' + esc(c.impact) + '</span>' : '') + '</div>' +
      '<div class="cause-why">' + esc(c.why) + '</div>' + (c.fix ? '<div class="cause-fix">Fix: <b>' + esc(c.fix) + '</b></div>' : '') +
      (extraHtml || '') + '</div>';
  }

  function stackRows(rows, colors) {
    const max = Math.max.apply(null, rows.map((r) => r.total || 0).concat([1e-9]));
    const keys = [];
    const html = rows.map((r) => {
      const parts = r.parts.filter((p) => p.value > 0);
      parts.forEach((p) => { if (!keys.some((k) => k.key === p.key)) keys.push({ key: p.key, label: p.label }); });
      return '<div class="split-row"><div class="split-label"><span>' + esc(r.label) + '</span><b>' + ms(r.total) + '</b></div>' +
        '<div class="stack" style="width:' + Math.max(1, r.total / max * 100).toFixed(1) + '%">' +
        parts.map((p) => '<i style="width:' + (p.value / (r.total || 1) * 100).toFixed(2) + '%;background:' +
          colorOf(p.key, keys.findIndex((k) => k.key === p.key), colors) + '" title="' + esc(p.label) + ': ' + ms(p.value) + '"></i>').join('') +
        '</div></div>';
    }).join('');
    const legend = keys.map((k, i) => '<span><i style="background:' + colorOf(k.key, i, colors) + '"></i>' + esc(k.label) + '</span>').join('');
    return { html, legend };
  }

  const LEVEL = { good: ['Looks good', ''], warn: ['Needs attention', 'warn'], bad: ['Slow', 'bad'] };
  function verdictItem(level, title, sub) {
    const lv = LEVEL[level] || LEVEL.good;
    return { colSpan: 2, className: 'card-verdict' + (lv[1] ? ' lv-' + lv[1] : ''),
      html: '<span class="badge ' + lv[1] + '">' + lv[0] + '</span><div class="verdict-title">' + esc(title) + '</div>' +
            '<div class="verdict-sub">' + esc(sub) + '</div>' };
  }
  const TONE = { good: 'v-good', warm: 'v-warm', warn: 'v-warm', bad: 'v-bad' };
  // "23.8 KB" -> big number, small grey unit
  function numUnit(v) {
    const m = String(v == null ? '' : v).match(/^([−\-+]?[\d.,]+)\s*(ms|s|µs|KB|MB|GB|TB|B|%)$/);
    return m ? esc(m[1]) + '<span class="u">' + esc(m[2]) + '</span>' : esc(v);
  }
  function statItem(label, value, sub, tone, id) {
    return { html: '<div class="mb-k">' + esc(label) + '</div><div class="mb-v ' + (TONE[tone] || '') + '"' + (id ? ' id="' + id + '"' : '') + '>' +
      numUnit(value) + '</div><div class="stat-spark"></div><div class="mb-s">' + esc(sub) + '</div>' };
  }
  function tableHtml(t, maxRows) {
    if (!t.rows || !t.rows.length) return '';
    const rows = maxRows ? t.rows.slice(0, maxRows) : t.rows;
    return '<h3 class="mb-h">' + esc(t.title) + '</h3>' + (t.note ? '<p class="mb-note">' + esc(t.note) + '</p>' : '') +
      '<div class="tbl"><table><tr>' + t.columns.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr>' +
      rows.map((row) => '<tr>' + row.map((v, i) => '<td' + (i > 0 && /^[\d.,±+−~ ]+\s?(ms|s|B|KB|MB|GB|TB|%)?$/.test(String(v)) ? ' class="num"' : '') + '>' +
        esc(v) + '</td>').join('') + '</tr>').join('') + '</table></div>';
  }
  const detailBento = (items) => bento($('details'), items, { columns: 1, rowHeight: 100, intro: true });

  // ---------- generic report: website, folder, program
  function renderReport(r) {
    $('dashTarget').textContent = r.target || '';
    const items = [verdictItem(r.verdict.level, r.verdict.title, r.verdict.sub)];
    (r.stats || []).forEach((s) => items.push(statItem(s.label, s.value, s.sub, s.tone)));
    const causesTitle = r.verdict.level === 'good' ? 'What could still be better' : 'Why it is slow';
    items.push({ colSpan: 2, rowSpan: 2, html: '<h3 class="mb-h">' + causesTitle + '</h3>' + (r.causes.length
      ? r.causes.map((c) => causeCard(c, c.severity)).join('')
      : '<p class="okline">Nothing stands out. No delay above the usual levels was found.</p>') });
    const bd = r.breakdown;
    if (bd) {
      const s = stackRows(bd.rows);
      items.push({ colSpan: 2, rowSpan: 2, html: '<h3 class="mb-h">' + esc(bd.title) + '</h3>' + (bd.note ? '<p class="mb-note">' + esc(bd.note) + '</p>' : '') +
        '<div>' + s.html + '</div><div class="legend">' + s.legend + '</div>' });
    }
    (r.charts || []).forEach((c, i) => items.push({ colSpan: 2, html: '<h3 class="mb-h">' + esc(c.title) + '</h3><div class="chart-wrap"><canvas id="chart' + i + '"></canvas></div>' }));
    bento($('dash'), items);
    (r.charts || []).forEach((c, i) => autoDraw($('chart' + i), () => drawLine($('chart' + i), c)));

    // details: file explorer (Shredder), tables, output, notes
    const sets = fileSets(r);
    const used = new Set(sets.map((s) => s.title));
    const det = [];
    if (sets.length) det.push({ node: explorerShell(), className: 'card-files' });
    (r.tables || []).filter((t) => !used.has(t.title) && t.rows && t.rows.length).forEach((t) => det.push({ html: tableHtml(t) }));
    if (r.output) det.push({ html: '<h3 class="mb-h">Last output of the command</h3><pre class="out">' + esc(r.output) + '</pre>' });
    det.push({ html: '<h3 class="mb-h">How sure are we?</h3><ul class="notes-list">' + (r.notes || []).map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul>' });
    detailBento(det);
    if (sets.length) explorer = mountExplorer(sets);
  }

  // ---------- folder picked in the browser, before timing it
  function renderLocal() {
    const f = localFolder;
    $('dashTarget').textContent = f.name;
    const largest = f.files.reduce((a, b) => (b.size > a.size ? b : a), f.files[0]);
    const items = [
      verdictItem('good', '"' + f.name + '" has ' + f.files.length.toLocaleString() + (f.capped ? '+' : '') + ' files', 'Listed in this browser only. To time it, paste its full path above and press Scan folder: we then measure listing, opening and reading, and explain any delay.'),
      statItem('Files', f.files.length.toLocaleString() + (f.capped ? '+' : ''), f.capped ? 'only the first ' + MAX_LOCAL.toLocaleString() + ' listed' : 'in all sub-folders'),
      statItem('Total size', bytes(f.total), 'average ' + bytes(f.total / f.files.length) + ' per file'),
      statItem('Largest file', bytes(largest.size), largest.path),
      statItem('Sub-folders', f.dirs.toLocaleString(), 'inside ' + f.name)
    ];
    bento($('dash'), items);
    detailBento([{ node: explorerShell(), className: 'card-files' }]);
    explorer = mountExplorer(fileSets(null));
  }

  // ------------------------------------------------------------------ file explorer (React Bits Shredder)
  const SHRED_ROWS = 8;
  function parseVal(s) {
    const m = String(s == null ? '' : s).replace(/,/g, '').trim().match(/^([\d.]+)\s*(ms|s|B|KB|MB|GB|TB)?/);
    if (!m) return 0;
    const u = { ms: 1, s: 1000, B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 }[m[2]] || 1;
    return parseFloat(m[1]) * u;
  }
  function badge(name, kind) {
    if (kind) return String(kind).slice(0, 4).toUpperCase();
    const base = String(name).split(/[\\/]/).pop();
    const dot = base.lastIndexOf('.');
    return dot > 0 && base.length - dot <= 6 ? base.slice(dot + 1, dot + 5).toUpperCase() : 'FILE';
  }
  // Which report tables become file lists: [title, label, name column, value column, kind column]
  const FILE_TABLES = [
    ['Largest files', 'Largest', 0, 1, null, 'size'],
    ['Slowest files to open and read', 'Slowest to read', 0, 4, null, 'time'],
    ['Slowest sub-folders', 'Sub-folders', 0, 3, 'DIR', 'time'],
    ['Fullest folders', 'Fullest folders', 0, 1, 'DIR', 'count'],
    ['Slowest files on the page', 'Page files', 1, 5, 2, 'time']
  ];
  function fileSets(r) {
    const sets = [];
    if (r && r.tables) {
      FILE_TABLES.forEach(([title, label, nc, vc, kc, unit]) => {
        const t = r.tables.find((x) => x.title === title);
        if (!t || !t.rows || !t.rows.length) return;
        sets.push({ key: title, title, label, unit, metric: t.columns[vc], items: t.rows.map((row, i) => ({
          id: title + ':' + i, name: String(row[nc]), shown: String(row[vc]), value: parseVal(row[vc]),
          icon: kc === 'DIR' ? 'DIR' : badge(row[nc], typeof kc === 'number' ? row[0] : null),
          cols: t.columns.map((c, j) => [c, String(row[j])]) })) });
      });
    }
    if (localFolder && (!r || r.kind === 'folder' || r.kind === 'local')) {
      const files = localFolder.files.slice().sort((a, b) => b.size - a.size).slice(0, 300);
      sets.push({ key: 'local', title: 'Picked folder', label: 'Picked folder', unit: 'size', metric: 'Size', items: files.map((f, i) => ({
        id: 'local:' + i, name: f.path, shown: bytes(f.size), value: f.size, icon: badge(f.path),
        cols: [['Size', bytes(f.size)], ['Share of folder', localFolder.total ? (f.size / localFolder.total * 100).toFixed(1) + '%' : '—'],
               ['Folder', f.path.indexOf('/') >= 0 ? f.path.slice(0, f.path.lastIndexOf('/')) : '(top level)']] })) });
    }
    return sets;
  }
  function explorerShell() {
    const el = document.createElement('div');
    el.className = 'fx';
    el.innerHTML =
      '<div class="fx-head"><div><h3 class="mb-h">Files</h3><p class="mb-note" id="fxNote"></p></div>' +
      '<div class="fx-tools"><div class="fx-tabs" id="fxTabs"></div><div class="fx-tabs" id="fxView">' +
      '<button type="button" data-v="shred" class="on">Shredder</button><button type="button" data-v="list">List</button></div>' +
      '<button type="button" id="fxRestore" hidden>Restore all</button></div></div>' +
      '<div id="fxMain"></div>';
    return el;
  }
  function mountExplorer(sets) {
    const st = { set: sets[0].key, view: 'shred', sel: null, gone: {}, order: {} };
    try { const v = localStorage.getItem('sda:fxview'); if (v === 'list' || v === 'shred') st.view = v; } catch (e) { /* ignore */ }
    sets.forEach((s) => { st.gone[s.key] = new Set(); st.order[s.key] = s.items.slice().sort((a, b) => b.value - a.value).map((i) => i.id); });
    let shred = null;
    const cur = () => sets.find((s) => s.key === st.set);
    const byId = (s) => new Map(s.items.map((i) => [i.id, i]));
    const live = (s) => { const m = byId(s); return st.order[s.key].filter((id) => !st.gone[s.key].has(id)).map((id) => m.get(id)); };
    const maxOf = (s) => Math.max.apply(null, s.items.map((i) => i.value).concat([1e-9]));

    function rowFace(item) {
      const s = cur(), w = Math.max(2, item.value / maxOf(s) * 100);
      const d = document.createElement('div');
      d.className = 'row' + (item.id === st.sel ? ' sel' : '');
      d.dataset.id = item.id;
      d.innerHTML = '<span class="ic">' + esc(item.icon) + '</span><span class="nm" title="' + esc(item.name) + '">' + esc(item.name) +
        '</span><span class="sz">' + esc(item.shown) + '</span><span class="rb"><i style="width:' + w.toFixed(1) + '%"></i></span>';
      return d;
    }
    function shredHeight(n) { return Math.max(SHRED.height, SHRED.fallHeight + 4 + 18 + n * 60); }

    function drawTabs() {
      $('fxTabs').innerHTML = sets.map((s) => '<button type="button" data-k="' + esc(s.key) + '"' + (s.key === st.set ? ' class="on"' : '') + '>' +
        esc(s.label) + '<span class="n">' + live(s).length + '</span></button>').join('');
      $('fxView').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === st.view));
      $('fxRestore').hidden = !st.gone[st.set].size;
      const s = cur();
      $('fxNote').textContent = s.title + ' · ' + s.items.length + ' item' + (s.items.length === 1 ? '' : 's') + ', by ' + s.metric.toLowerCase() +
        (st.view === 'shred' ? '. Drag to reorder; drag into the slot (or press Delete) to clear it from this list.' : '.');
    }
    function drawSide() {
      const s = cur(), max = maxOf(s), m = byId(s);
      const order = st.order[s.key].map((id) => m.get(id));
      const bars = order.map((i) => '<button type="button" class="fx-bar' + (i.id === st.sel ? ' on' : '') + (st.gone[s.key].has(i.id) ? ' gone' : '') +
        '" data-id="' + esc(i.id) + '"><span class="l" title="' + esc(i.name) + '">' + esc(i.name) + '</span><span class="t"><i style="width:' +
        Math.max(1.5, i.value / max * 100).toFixed(1) + '%"></i></span><span class="v">' + esc(i.shown) + '</span></button>').join('');
      const sel = st.sel && m.get(st.sel);
      const total = s.items.reduce((a, i) => a + i.value, 0);
      const detail = sel
        ? '<span class="eyebrow small">' + esc(s.label) + ' · #' + (st.order[s.key].indexOf(sel.id) + 1) + ' of ' + s.items.length + '</span>' +
          '<h4>' + esc(sel.name) + '</h4><div class="fx-kv">' + sel.cols.map(([k, v]) => '<div><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('') + '</div>' +
          '<div class="fx-share">' + (total ? (sel.value / total * 100).toFixed(1) + '% of this list\'s ' + esc(s.metric.toLowerCase()) : '') +
          '<div class="bar"><i style="width:' + (total ? Math.max(1, sel.value / total * 100) : 0).toFixed(1) + '%"></i></div></div>'
        : '<div class="fx-empty">Click a file (or a bar) to see its details here.</div>';
      return { bars, detail };
    }
    function refreshSide() {
      const side = drawSide();
      const b = $('fxBars'), d = $('fxDetail');
      if (b) { const top = b.scrollTop; b.innerHTML = side.bars; b.scrollTop = top; }
      if (d) d.innerHTML = side.detail;
      document.querySelectorAll('#fxMain .row').forEach((r) => r.classList.toggle('sel', r.dataset.id === st.sel));
    }
    function select(id) { st.sel = id; refreshSide(); }

    function draw() {
      if (shred) { shred.destroy(); shred = null; }
      drawTabs();
      const s = cur(), side = drawSide();
      if (st.view === 'list') {
        const max = maxOf(s), m = byId(s);
        $('fxMain').innerHTML = '<div class="fx-list"><div class="tbl"><table><tr>' + s.items[0].cols.map((c) => '<th>' + esc(c[0]) + '</th>').join('') +
          '<th style="width:28%">' + esc(s.metric) + '</th></tr>' + st.order[s.key].map((id) => m.get(id)).map((i) =>
          '<tr class="pick' + (i.id === st.sel ? ' sel' : '') + '" data-id="' + esc(i.id) + '">' + i.cols.map((c, j) => '<td' + (j > 0 && /^[\d.,]+\s?(ms|s|B|KB|MB|GB|TB|%)?/.test(c[1]) ? ' class="num"' : '') + '>' + esc(c[1]) + '</td>').join('') +
          '<td><div class="bar" style="margin:0"><i style="width:' + Math.max(1.5, i.value / max * 100).toFixed(1) + '%;background:rgba(245,245,247,.85)"></i></div></td></tr>').join('') +
          '</table></div></div><div class="fx-detail" id="fxDetail" style="margin-top:14px">' + side.detail + '</div>';
        return;
      }
      $('fxMain').innerHTML = '<div class="fx-body"><div class="fx-shred"><div id="fxShred"></div>' +
        '<div class="fx-help">Top ' + SHRED_ROWS + ' shown here · all of them in the bars</div></div>' +
        '<div class="fx-side"><div class="fx-bars" id="fxBars">' + side.bars + '</div><div class="fx-detail" id="fxDetail">' + side.detail + '</div></div></div>';
      const shown = live(s).slice(0, SHRED_ROWS);
      shred = window.Shredder($('fxShred'), Object.assign({}, SHRED, {
        height: shredHeight(shown.length),
        items: shown,
        renderItem: rowFace,
        onShred: (f) => {
          st.gone[s.key].add(f.id);
          if (st.sel === f.id) st.sel = null;
          const next = live(s).slice(0, SHRED_ROWS);
          shred.setItems(next);
          drawTabs();
          refreshSide();
        },
        onReorder: (next) => {
          const ids = next.map((i) => i.id), rest = st.order[s.key].filter((id) => ids.indexOf(id) < 0);
          st.order[s.key] = ids.concat(rest);
          refreshSide();
        },
        onSelect: (f) => select(f.id)
      }));
    }
    const root = $('fxMain').parentNode;
    root.addEventListener('click', (e) => {
      const tab = e.target.closest('#fxTabs button');
      if (tab) { st.set = tab.dataset.k; st.sel = null; draw(); return; }
      const v = e.target.closest('#fxView button');
      if (v) { st.view = v.dataset.v; try { localStorage.setItem('sda:fxview', st.view); } catch (err) { /* ignore */ } draw(); return; }
      if (e.target.closest('#fxRestore')) { st.gone[st.set].clear(); draw(); return; }
      const bar = e.target.closest('.fx-bar, tr[data-id]');
      if (bar) select(bar.dataset.id);
    });
    draw();
    return { destroy() { if (shred) shred.destroy(); shred = null; } };
  }

  // ------------------------------------------------------------------ charts
  function drawLine(cv, c) {
    const ctx = cv.getContext('2d'), W = cv.width, H = cv.height, m = { l: 44, r: 10, t: 10, b: 26 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b, xs = c.x, ys = c.y;
    ctx.clearRect(0, 0, W, H);
    ctx.font = '500 11px Inter, "Segoe UI", system-ui, sans-serif';
    if (!xs.length) { ctx.fillStyle = 'rgba(244,244,245,.5)'; ctx.fillText('No samples', m.l, m.t + 20); return; }
    const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs) || 1, y1 = Math.max(1e-6, Math.max.apply(null, ys)) * 1.15;
    const X = (x) => m.l + (x1 > x0 ? (x - x0) / (x1 - x0) : 0.5) * pw, Y = (y) => m.t + (1 - y / y1) * ph;
    ctx.fillStyle = 'rgba(244,244,245,.45)'; ctx.textAlign = 'right';
    for (let q = 0; q <= 4; q++) {
      const v = y1 * q / 4, y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(m.l + pw, y); ctx.stroke();
      ctx.fillText(v < 10 ? v.toFixed(1) : v.toFixed(0), m.l - 6, y + 4);
    }
    ctx.textAlign = 'center'; ctx.fillText('seconds  ·  ' + c.unit, m.l + pw / 2, H - 6);
    const fill = ctx.createLinearGradient(0, m.t, 0, m.t + ph);
    fill.addColorStop(0, 'rgba(245,245,247,.16)'); fill.addColorStop(1, 'rgba(245,245,247,0)');
    ctx.beginPath(); ctx.moveTo(X(xs[0]), Y(0));
    xs.forEach((x, i) => ctx.lineTo(X(x), Y(ys[i]))); ctx.lineTo(X(xs[xs.length - 1]), Y(0)); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    const line = ctx.createLinearGradient(m.l, 0, m.l + pw, 0);
    line.addColorStop(0, 'rgba(245,245,247,.75)'); line.addColorStop(1, '#f5f5f7');
    ctx.beginPath(); xs.forEach((x, i) => (i ? ctx.lineTo(X(x), Y(ys[i])) : ctx.moveTo(X(x), Y(ys[i]))));
    ctx.strokeStyle = line; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
  }

  // ---------- formula results (your data and tuning)
  const CAUSE_COLORS = { overload: '#ff453a', queue: 'rgba(245,245,247,.95)', crowd: 'rgba(245,245,247,.75)', setup: 'rgba(245,245,247,.58)', wait: 'rgba(245,245,247,.42)', clash: 'rgba(245,245,247,.28)', base: 'rgba(245,245,247,.16)' };
  const ORDER = ['base', 'overload', 'queue', 'crowd', 'setup', 'wait', 'clash'];

  function renderFormula(r) {
    LAST = r;
    const cur = r.current, rec = r.recommended, imp = r.improvement, worth = imp.pct > 0.01;
    const who = r.kind === 'tune' ? 'Your program' : 'Your server';
    $('dashTarget').textContent = r.kind === 'tune' ? r.tune.template : 'Uploaded measurements';
    const byKey = {}; r.causes.forEach((c) => { byKey[c.key] = c; });
    const main = r.main_causes.map((k) => byKey[k].name.toLowerCase());
    const items = [];
    items.push(verdictItem(worth ? 'warn' : 'good',
      worth ? who + ' can be ' + (imp.pct * 100).toFixed(0) + '% faster.' : who + ' is already close to its fastest setting.',
      worth ? 'Switch from ' + setting(cur.n, cur.b) + ' to ' + setting(rec.n, rec.b) + '. ' +
              (main.length ? 'Main reason' + (main.length > 1 ? 's' : '') + ': ' + main.join(', plus ') + '.' : '')
            : 'At ' + setting(cur.n, cur.b) + ' you are within 1% of the best setting found.'));
    items.push(statItem('Delay now', ms(cur.delay), setting(cur.n, cur.b) + (cur.measured != null ? ' · measured' : ' · predicted') + (cur.overloaded ? ' · overloaded' : ''), 'warm'));
    items.push(statItem('With our setting', ms(rec.D), rec.source === 'measured' ? 'measured at this setting' : 'predicted by the formula', 'good'));
    items.push(statItem('Saved per request', worth ? ms(imp.ms) : '—', worth ? (imp.pct * 100).toFixed(1) + '% less waiting' : 'no meaningful gain', 'good'));
    items.push(statItem('Recommended setting', num(rec.n) + ' × ' + num(rec.b), num(rec.n) + ' threads, batch size ' + num(rec.b)));

    if (r.kind === 'tune') {
      const t = r.tune, err = t.formula_error_pct;
      items.push({ colSpan: 2, html: '<h3 class="mb-h">Use this command</h3><div class="cmd">' + esc(t.example_command) + '</div><div class="facts">' +
        '<span><b>' + t.runs + '</b> runs measured (' + esc(t.metric) + ')</span>' +
        (err != null ? '<span>Formula predicted <b>' + ms(rec.predicted) + '</b>, measured <b>' + ms(rec.D) + '</b> (' + (err >= 0 ? '+' : '') + err.toFixed(1) + '%)</span>' : '') +
        '<span>Grid → formula\'s picks (' + t.refine.filter((x) => x.n).length + ') → zoom rounds (' + t.zoom.filter((z) => z.tried.length).length + ') → confirmed</span>' +
        (t.failures.length ? '<span class="v-warm">' + t.failures.length + ' run' + (t.failures.length > 1 ? 's' : '') + ' failed and were left out</span>' : '') + '</div>' });
    }
    if (r.warnings.length) {
      items.push({ colSpan: 2, html: '<h3 class="mb-h">Check before you trust it</h3>' + r.warnings.map((w) => '<div class="warn-box">' + esc(w) + '</div>').join('') });
    }

    const mainCs = r.causes.filter((c) => r.main_causes.indexOf(c.key) >= 0);
    let causesHtml;
    if (!worth || !mainCs.length) causesHtml = '<p class="okline">Nothing stands out. Every source of delay is already close to its lowest level.</p>';
    else {
      const top = mainCs[0].extra;
      causesHtml = mainCs.map((c, i) => causeCard({ name: c.name, why: c.why, fix: c.fix, impact: '+' + ms(c.extra) }, i === 0 ? 'main' : '',
        '<div class="bar"><i style="width:' + Math.max(3, c.extra / top * 100).toFixed(1) + '%;background:' + CAUSE_COLORS[c.key] + '"></i></div>')).join('') +
        '<p class="mb-note">Extra milliseconds each cause adds compared with the recommended setting.</p>';
    }
    items.push({ colSpan: 2, rowSpan: 2, html: '<h3 class="mb-h">Why it is slow</h3>' + causesHtml });

    function total(f) { return ORDER.reduce((s, k) => s + (byKey[k] ? Math.max(0, byKey[k][f]) : 0), 0); }
    const rows = [['Now · ' + setting(cur.n, cur.b), 'now'], ['Recommended · ' + setting(rec.n, rec.b), 'best']].map(([label, f]) => ({
      label, total: total(f), parts: ORDER.filter((k) => byKey[k]).map((k) => ({ key: k, label: byKey[k].name, value: Math.max(0, byKey[k][f]) })) }));
    const s = stackRows(rows, CAUSE_COLORS);
    items.push({ colSpan: 2, rowSpan: 2, html: '<h3 class="mb-h">Where the time goes</h3><p class="mb-note">Delay per request, split by cause.</p><div>' + s.html +
      '</div><div class="legend">' + s.legend + '</div>' });

    items.push({ colSpan: 4, rowSpan: 2, html: '<h3 class="mb-h">Delay across settings</h3><p class="mb-note">Brighter is faster. Dots are measurements. Hover to see the expected delay of any setting.</p>' +
      '<div class="mapwrap"><canvas id="map"></canvas><div class="tip" id="tip" hidden></div></div>' +
      '<div class="maplegend"><span><i class="dot cur"></i>Now</span><span><i class="dot rec"></i>Recommended</span><span><i class="dot meas"></i>Measured</span><span><i class="dot over"></i>Overloaded</span></div>' });

    const q = { good: 'Good', fair: 'Fair', poor: 'Poor' }[r.fit.quality];
    items.push({ colSpan: 4, html: '<h3 class="mb-h">The numbers behind it</h3><div class="summary-list">' +
      '<span><b>' + r.rows.toLocaleString() + '</b> measurements</span>' +
      '<span><b>' + r.settings_measured + '</b> different settings</span>' +
      (r.skipped_rows ? '<span><b>' + r.skipped_rows + '</b> unreadable rows skipped</span>' : '') +
      '<span>Formula fit: <b>' + q + '</b> (typical error ' + (r.fit.typical_error * 100).toFixed(1) + '%, relative R² ' + r.fit.r2.toFixed(3) + ')</span>' +
      '<span>Formula\'s lowest point: <b>' + num(r.best.n) + ' × ' + num(r.best.b) + '</b> (' + (r.best.is_minimum ? 'confirmed minimum' : 'at the edge of the data') + ')</span>' +
      '<span>Recommendation: <b>' + esc(rec.reason) + '</b></span>' +
      '<span>Current setting from: <b>' + esc(cur.source) + '</b></span></div>' });
    bento($('dash'), items);
    autoDraw($('map'), () => drawMap(r));
    bindMap();

    if (r.kind === 'tune') {
      const pts = r.map.points.slice().sort((a, b) => a.mean - b.mean);
      const det = [{ html: tableHtml({ title: 'Measured settings, fastest first', columns: ['Threads', 'Batch', 'Runs', 'Average', 'Note'],
        rows: pts.slice(0, 15).map((p) => [num(p.n), num(p.b), String(p.count), ms(p.mean),
          (p.n == rec.n && p.b == rec.b) ? 'recommended' : p.overloaded ? 'overloaded' : '']) }) }];
      if (r.tune.failures.length) det.push({ html: tableHtml({ title: 'Runs that failed', columns: ['Threads', 'Batch', 'Why'],
        rows: r.tune.failures.map((f) => [String(f.n), String(f.b), f.why]) }) });
      detailBento(det);
    }
  }

  // ---------- delay map
  function colorFor(t) {
    const s = [[0, [245, 245, 247]], [0.1, [205, 205, 210]], [0.3, [140, 140, 148]], [0.55, [78, 78, 84]], [0.8, [34, 34, 38]], [1, [10, 10, 12]]];
    t = Math.min(1, Math.max(0, t));
    for (let i = 1; i < s.length; i++) if (t <= s[i][0]) {
      const a = s[i - 1], b = s[i], u = (t - a[0]) / (b[0] - a[0]);
      return [0, 1, 2].map((j) => Math.round(a[1][j] + (b[1][j] - a[1][j]) * u));
    }
    return s[s.length - 1][1];
  }
  function drawMap(r) {
    const cv = $('map'); if (!cv) return;
    const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    const m = { l: 56, r: 14, t: 10, b: 42 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
    const g = r.map, N = g.n.length, M = g.b.length;
    const x0 = Math.log(g.n[0]), x1 = Math.log(g.n[N - 1]), y0 = Math.log(g.b[0]), y1 = Math.log(g.b[M - 1]);
    let lo = Infinity; g.D.forEach((row) => row.forEach((v) => { lo = Math.min(lo, v); }));
    const hi = lo * 2.2;
    const X = (n) => m.l + (Math.log(n) - x0) / (x1 - x0) * pw, Y = (b) => m.t + (1 - (Math.log(b) - y0) / (y1 - y0)) * ph;
    ctx.clearRect(0, 0, W, H);
    const off = document.createElement('canvas'); off.width = N; off.height = M;
    const oc = off.getContext('2d'), img = oc.createImageData(N, M);
    for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) {
      const c = colorFor((g.D[i][j] - lo) / (hi - lo)), p = ((M - 1 - j) * N + i) * 4;
      img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2]; img.data[p + 3] = 255;
    }
    oc.putImageData(img, 0, 0);
    ctx.save(); ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(m.l, m.t, pw, ph, 10); else ctx.rect(m.l, m.t, pw, ph);
    ctx.clip(); ctx.imageSmoothingEnabled = true; ctx.drawImage(off, m.l, m.t, pw, ph); ctx.restore();
    ctx.fillStyle = 'rgba(245,245,247,.55)'; ctx.font = '500 11.5px Inter, "Segoe UI", system-ui, sans-serif'; ctx.textAlign = 'center';
    for (let v = 1; v <= 65536; v *= 2) if (v >= g.n[0] * 0.999 && v <= g.n[N - 1] * 1.001) ctx.fillText(v, X(v), H - m.b + 18);
    ctx.fillText('Worker threads', m.l + pw / 2, H - 6);
    ctx.textAlign = 'right';
    for (let v = 1; v <= 65536; v *= 2) if (v >= g.b[0] * 0.999 && v <= g.b[M - 1] * 1.001) ctx.fillText(v, m.l - 8, Y(v) + 4);
    ctx.save(); ctx.translate(14, m.t + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('Batch size', 0, 0); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(m.l, m.t, pw, ph); ctx.clip();
    g.points.forEach((pt) => {
      const px = X(pt.n), py = Y(pt.b);
      if (pt.overloaded) {
        ctx.strokeStyle = '#ff453a'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(px, py - 6); ctx.lineTo(px + 6, py); ctx.lineTo(px, py + 6); ctx.lineTo(px - 6, py); ctx.closePath(); ctx.stroke();
      } else { ctx.beginPath(); ctx.arc(px, py, 3, 0, 7); ctx.fillStyle = 'rgba(10,10,12,.55)'; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(245,245,247,.7)'; ctx.stroke(); }
    });
    function marker(n, b, col, label) {
      const px = X(n), py = Y(b);
      ctx.beginPath(); ctx.arc(px, py, 8, 0, 7); ctx.fillStyle = col; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#000'; ctx.stroke();
      ctx.font = '600 12.5px Inter, Segoe UI, sans-serif'; ctx.textAlign = px > m.l + pw - 120 ? 'right' : 'left';
      const tx = px + (ctx.textAlign === 'left' ? 12 : -12);
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.strokeText(label, tx, py - 10); ctx.fillStyle = col; ctx.fillText(label, tx, py - 10);
    }
    marker(r.current.n, r.current.b, '#ff453a', 'Now');
    marker(r.recommended.n, r.recommended.b, '#30d158', 'Recommended');
    ctx.restore();
    MAP = { m, pw, ph, x0, x1, y0, y1, g };
  }
  function bindMap() {
    const cv = $('map'), tip = $('tip');
    cv.addEventListener('mousemove', (e) => {
      if (!MAP) return;
      const rect = cv.getBoundingClientRect(), sx = cv.width / rect.width, sy = cv.height / rect.height;
      const x = (e.clientX - rect.left) * sx, y = (e.clientY - rect.top) * sy, m = MAP.m;
      if (x < m.l || x > m.l + MAP.pw || y < m.t || y > m.t + MAP.ph) { tip.hidden = true; return; }
      const n = Math.exp(MAP.x0 + (x - m.l) / MAP.pw * (MAP.x1 - MAP.x0));
      const b = Math.exp(MAP.y0 + (1 - (y - m.t) / MAP.ph) * (MAP.y1 - MAP.y0));
      const g = MAP.g, N = g.n.length, M = g.b.length;
      const i = Math.max(0, Math.min(N - 1, Math.round((Math.log(n) - MAP.x0) / (MAP.x1 - MAP.x0) * (N - 1))));
      const j = Math.max(0, Math.min(M - 1, Math.round((Math.log(b) - MAP.y0) / (MAP.y1 - MAP.y0) * (M - 1))));
      tip.textContent = n.toFixed(1) + ' threads · batch ' + b.toFixed(1) + ' → ~' + ms(g.D[i][j]);
      tip.hidden = false;
      let left = e.clientX - rect.left + 14;
      if (left + tip.offsetWidth > rect.width) left = e.clientX - rect.left - tip.offsetWidth - 10;
      tip.style.left = left + 'px'; tip.style.top = (e.clientY - rect.top + 14) + 'px';
    });
    cv.addEventListener('mouseleave', () => { tip.hidden = true; });
  }

  // ------------------------------------------------------------------ how it works (bento)
  const ICONS = {
    website: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.3l2 2h8.7A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5Z"/></svg>',
    program: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/></svg>',
    data: '<svg viewBox="0 0 24 24"><path d="M4 19V5M4 19h16M8 15l3-4 3 2 5-6"/></svg>'
  };
  const HOW = [
    ['website', 'Website', 'Loads the page on fresh connections and times each step: DNS, connecting, the secure handshake, server thinking time and download, then every file the page loads.'],
    ['folder', 'Folder', 'Lists every sub-folder and opens a sample of files, timing the fixed cost of opening each one and the cost of reading its data.'],
    ['program', 'Program', 'Watches CPU, disk, memory and network use. To tune, it measures many settings, fits our formula, solves it with Newton\'s method and confirms by re-running.'],
    ['data', 'Your data', 'Fits our delay formula to your measurements, sets aside overloaded settings and explains, cause by cause, where the extra delay comes from.']
  ];
  bento($('howGrid'), HOW.map(([k, t, p]) => ({
    html: '<div class="how-card"><span class="how-ic">' + ICONS[k] + '</span><h3>' + t + '</h3><p>' + esc(p) + '</p></div>',
    onClick: () => { setMode(k); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  })), { rowHeight: 220 });
  bentos = []; // the "how it works" grid stays when results change

  // ------------------------------------------------------------------ React Bits: SpecularButton on every button
  // (settings as asked; the list rows of the file explorer are rows, not buttons, so they stay plain)
  const SPECULAR = {
    radius: 18, tint: '#ffffff', tintOpacity: 0.04, textColor: '#f5f5f5', lineColor: '#ffffff', baseColor: '#525252',
    intensity: 1, idleIntensity: 0.35, shineSize: 10, shineFade: 34, thickness: 1.2, glow: 1, followMouse: true, proximity: 250
  };
  if (window.SpecularButton) window.SpecularButton.enhanceAll(document.body, SPECULAR, '.fx-bar, .card-files button');

  // ------------------------------------------------------------------ white pop when a Scan / Find button is pressed
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest && e.target.closest('button.primary');
    if (!b || b.disabled) return;
    const r = b.getBoundingClientRect();
    const pop = document.createElement('span');
    pop.className = 'btn-pop';
    const d = Math.hypot(r.width, r.height) * 2;
    pop.style.width = pop.style.height = d + 'px';
    pop.style.left = (e.clientX - r.left - d / 2) + 'px';
    pop.style.top = (e.clientY - r.top - d / 2) + 'px';
    b.appendChild(pop);
    b.classList.remove('popped'); void b.offsetWidth; b.classList.add('popped');
    pop.addEventListener('animationend', () => pop.remove());
    setTimeout(() => b.classList.remove('popped'), 520);
  });

  // ------------------------------------------------------------------ smooth wheel scrolling in the report
  // Eases the wheel at the screen's own refresh rate (144 Hz on a 144 Hz monitor).
  // Inner boxes that can scroll (tables, file lists) keep their normal scrolling.
  (function smoothScroll(el) {
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let target = 0, raf = 0, last = 0;
    const max = () => el.scrollHeight - el.clientHeight;
    const innerCanScroll = (node, dy) => {
      for (; node && node !== el; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight + 1) {
          const oy = getComputedStyle(node).overflowY;
          if ((oy === 'auto' || oy === 'scroll') &&
              (dy > 0 ? node.scrollTop + node.clientHeight < node.scrollHeight - 1 : node.scrollTop > 0)) return true;
        }
      }
      return false;
    };
    const step = (now) => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      const cur = el.scrollTop;
      const next = cur + (target - cur) * (1 - Math.exp(-dt * 14));
      el.scrollTop = Math.abs(target - next) < 0.5 ? target : next;
      if (Math.abs(target - el.scrollTop) >= 0.5) raf = requestAnimationFrame(step);
      else { raf = 0; last = 0; }
    };
    el.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (innerCanScroll(e.target, e.deltaY)) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? el.clientHeight : 1;
      if (!raf) target = el.scrollTop;
      target = Math.max(0, Math.min(max(), target + e.deltaY * unit));
      if (!raf) raf = requestAnimationFrame(step);
    }, { passive: false });
    // keyboard, scrollbar drag and code that sets scrollTop stay in sync
    el.addEventListener('scroll', () => { if (!raf) target = el.scrollTop; }, { passive: true });
  })($('rvScroll'));

  // ------------------------------------------------------------------ About (i button, top-right)
  // React Bits StaggeredMenu opens the panel; each team photo opens a React Bits ProfileCard.
  // Roles are from our entrepreneurship presentation (Team VAAB). Add an email to show its Contact button.
  const TEAM = [
    { key: 'varsha', name: 'Varsha Antonis V', role: 'Team Leader & Business Development', focus: 'Project lead · UI · Pitching', email: '' },
    { key: 'anirudh', name: 'Anirudh Raj K', role: 'AI & Backend Developer', focus: 'Python · ML · Backend', email: 'anirudhpanicker123@gmail.com' },
    { key: 'asher', name: 'Asher Jerom Biju', role: 'Data Analysis & Testing Lead', focus: 'Data · Testing · Evaluation', email: 'jeromeasher262@gmail.com' },
    { key: 'bhuvaneshwari', name: 'Bhuvaneshwari D', role: 'Research & Validation Lead', focus: 'Research · Surveys · Reports', email: 'bhuvii.dharma@gmail.com' }
  ];
  // ------------------------------------------------------------------ account bar + history
  (function account() {
    const bar = $('userbar');
    if (!bar) return;
    $('ubName').textContent = USER || 'Signed in';
    $('ubAv').textContent = (USER || '?').charAt(0).toUpperCase();
    // sit just left of the About button, whatever its width
    function place() {
      const t = document.querySelector('#aboutRoot .sm-toggle');
      if (!t) return;
      const r = t.getBoundingClientRect();
      if (r.width) { bar.style.right = Math.max(12, window.innerWidth - r.left + 10) + 'px'; bar.style.top = (r.top + (r.height - bar.offsetHeight) / 2) + 'px'; }
    }
    window.addEventListener('resize', place);
    setTimeout(place, 0); setTimeout(place, 600);
    if (window.ResizeObserver) setTimeout(() => { const t = document.querySelector('#aboutRoot .sm-toggle'); if (t) new ResizeObserver(place).observe(t); }, 0);

    $('signOut').addEventListener('click', async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* signed out anyway */ }
      location.replace('/login');
    });

    const LABEL = { website: 'Website', folder: 'Folder', process: 'Program', command: 'Command', data: 'Your data', tune: 'Tuning' };
    const ICON = {
      website: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/>',
      folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.3l2 2h8.7A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5Z"/>',
      process: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/>',
      command: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/>',
      tune: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
      data: '<path d="M4 19V5M4 19h16M8 15l3-4 3 2 5-6"/>'
    };
    function title(it) {
      let t = String(it.target || LABEL[it.kind] || 'Report');
      if (it.kind === 'website') { try { t = new URL(t).hostname.replace(/^www\./, ''); } catch (e) { /* keep */ } }
      return t;
    }
    const layer = $('histLayer'), list = $('histList');
    let lastFocus = null;
    async function load() {
      list.innerHTML = '<p class="hist-empty">Loading…</p>';
      try {
        const { reports } = await api('/api/history');
        $('histClear').hidden = !reports.length;
        $('histSub').textContent = reports.length ? reports.length + ' saved report' + (reports.length === 1 ? '' : 's') + ', newest first.' : 'Every report you make is saved here.';
        if (!reports.length) { list.innerHTML = '<p class="hist-empty">No reports yet. Run a scan and it will appear here.</p>'; return; }
        list.innerHTML = reports.map((it) =>
          '<div class="hist-item" data-id="' + esc(it.id) + '">' +
          '<button type="button" class="hist-open" data-id="' + esc(it.id) + '">' +
          '<span class="hist-ic"><svg viewBox="0 0 24 24" aria-hidden="true">' + (ICON[it.kind] || ICON.data) + '</svg></span>' +
          '<span class="hist-txt"><b>' + esc(title(it)) + '</b><small>' + esc(LABEL[it.kind] || 'Report') + ' · ' + esc(when(new Date(it.created * 1000))) + '</small></span></button>' +
          '<button type="button" class="hist-del" data-id="' + esc(it.id) + '" aria-label="Delete this report" title="Delete">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button></div>').join('');
      } catch (e) { list.innerHTML = '<p class="hist-empty">' + esc(e.message) + '</p>'; }
    }
    function open() {
      lastFocus = document.activeElement;
      layer.hidden = false;
      requestAnimationFrame(() => layer.classList.add('in'));
      $('histBtn').setAttribute('aria-expanded', 'true');
      load();
      $('histClose').focus({ preventScroll: true });
    }
    function close() {
      layer.classList.remove('in');
      $('histBtn').setAttribute('aria-expanded', 'false');
      setTimeout(() => { if (!layer.classList.contains('in')) layer.hidden = true; }, 320);
      if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
    }
    $('histBtn').addEventListener('click', open);
    $('histClose').addEventListener('click', close);
    layer.addEventListener('click', (e) => { if (e.target === layer) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !layer.hidden) { e.stopPropagation(); close(); } }, true);
    list.addEventListener('click', async (e) => {
      const del = e.target.closest('.hist-del'), opn = e.target.closest('.hist-open');
      if (del) {
        const row = del.closest('.hist-item');
        row.classList.add('going');
        try { await api('/api/history/' + del.dataset.id, { method: 'DELETE' }); load(); }
        catch (err) { row.classList.remove('going'); showError(err.message); }
      } else if (opn) {
        opn.disabled = true;
        try {
          const rep = await api('/api/history/' + opn.dataset.id);
          const r = rep.result; r._savedAt = rep.created;
          close();
          setTimeout(() => openResults(r), 200);
        } catch (err) { opn.disabled = false; list.insertAdjacentHTML('afterbegin', '<p class="hist-empty">' + esc(err.message) + '</p>'); }
      }
    });
    $('histClear').addEventListener('click', async () => {
      if (!confirm('Delete every report in your history? This cannot be undone.')) return;
      try { await api('/api/history', { method: 'DELETE' }); load(); } catch (e) { showError(e.message); }
    });
  })();

  (function about() {
    if (!window.StaggeredMenu || !window.gsap) return;
    const rootEl = $('aboutRoot');

    // what goes inside the panel, under the menu items
    const box = document.createElement('div');
    box.className = 'ab';
    box.innerHTML =
      '<section class="ab-sec" data-sm-reveal><h3 class="ab-k">About</h3>' +
      '<p class="ab-p">Server Delay Analyzer finds where the waiting comes from. Point it at a website, a folder, a program or your own measurements: it times every step, explains each cause in plain words, and works out the fastest setting with our own delay formula.</p></section>' +
      '<section class="ab-sec" data-sm-reveal><h3 class="ab-k">Developed by <b>Team VAAB</b></h3>' +
      '<div class="ab-team" role="list">' + TEAM.map((m, i) =>
        '<button type="button" class="ab-member" role="listitem" data-i="' + i + '" aria-label="' + esc(m.name + ', ' + m.role) + '">' +
        '<span class="ab-ph"><img src="img/team/' + m.key + '-thumb.webp" alt="" draggable="false"></span>' +
        '<span class="ab-nm">' + esc(m.name.split(' ')[0]) + '</span></button>').join('') +
      '</div><p class="ab-hint">Tap a photo to see their role.</p></section>';

    // the profile card layer (beside the panel; full screen on phones)
    const layer = document.createElement('div');
    layer.className = 'pc-layer';
    layer.hidden = true;
    layer.innerHTML = '<div class="pc-stage" id="pcStage"></div><button type="button" class="pc-close" aria-label="Close profile">&times;</button>';
    rootEl.append(layer);
    let card = null, current = -1;
    function showMember(i) {
      const m = TEAM[i];
      if (card) card.destroy();
      current = i;
      box.querySelectorAll('.ab-member').forEach((b) => b.classList.toggle('on', +b.dataset.i === i));
      layer.hidden = false;
      requestAnimationFrame(() => layer.classList.add('in'));
      card = window.ProfileCard($('pcStage'), {
        name: m.name, title: m.role, handle: 'Team VAAB', handlePrefix: '', status: m.focus, statusColor: '#a1a1a6',
        contactText: m.email ? 'Contact' : '', contactHref: m.email ? 'mailto:' + m.email : '',
        avatarUrl: 'img/team/' + m.key + '.webp', miniAvatarUrl: 'img/team/' + m.key + '-thumb.webp',
        iconUrl: new URL('img/logo.png', location.href).href, className: 'pc-team',
        holo: 0.8, glare: 0.5, tiltStrength: 12, parallax: 8, radius: 16, enableTilt: true, intro: true,
        showUserInfo: true, enableMobileTilt: false, theme: 'dark'
      });
    }
    function hideMember() {
      if (current < 0) return;
      current = -1;
      box.querySelectorAll('.ab-member').forEach((b) => b.classList.remove('on'));
      layer.classList.remove('in');
      setTimeout(() => { if (current < 0) { layer.hidden = true; if (card) { card.destroy(); card = null; } } }, 260);
    }
    box.addEventListener('click', (e) => {
      const b = e.target.closest('.ab-member');
      if (!b) return;
      const i = +b.dataset.i;
      if (i === current) hideMember(); else showMember(i);
    });
    layer.addEventListener('click', (e) => { if (!e.target.closest('.profile-card') || e.target.closest('.pc-close')) hideMember(); });

    const go = (m) => () => { menu.close(); if (rvOpen) closeResults(); setMode(m); window.scrollTo({ top: 0, behavior: 'smooth' }); };
    const menu = window.StaggeredMenu(rootEl, {
      position: 'right',
      items: [
        { label: 'Website', ariaLabel: 'Scan a website', link: '#', onClick: go('website') },
        { label: 'Folder', ariaLabel: 'Scan a folder', link: '#', onClick: go('folder') },
        { label: 'Program', ariaLabel: 'Watch or tune a program', link: '#', onClick: go('program') },
        { label: 'Your data', ariaLabel: 'Analyze your measurements', link: '#', onClick: go('data') }
      ],
      socialItems: [], displaySocials: false, displayItemNumbering: true,
      menuButtonColor: '#fff', openMenuButtonColor: '#fff', changeMenuColorOnOpen: true,
      colors: ['#2c2c30', '#161618'], logoUrl: '', accentColor: '#a1a1a6',
      isFixed: true, closeOnClickAway: true, ignoreClickAway: '.pc-layer',
      toggleLabels: ['About', 'Close'], toggleGlyph: 'i', panelLabel: 'About', content: box,
      onMenuClose: hideMember
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (current >= 0) { hideMember(); e.stopImmediatePropagation(); }
      else if (menu.isOpen()) { menu.close(); e.stopImmediatePropagation(); }
    }, true);
  })();

  // ------------------------------------------------------------------ React Bits: MetallicPaint logo
  (function logo() {
    const host = $('logoMetal');
    const gl2 = (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return false; } })();
    if (window.MetallicPaint && gl2) window.MetallicPaint(host, { imageSrc: 'img/logo.png', dpr: 4, scale: 0.92 });
    else host.innerHTML = '<img src="img/logo.png" alt="" class="logo-fallback">';
  })();

  // ------------------------------------------------------------------ start
  if (!ON_SERVER) {
    showError('This page needs the analyzer running. In the VS Code terminal run:  python app.py   then open the address it prints (normally http://127.0.0.1:5050)');
    document.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  } else {
    let saved = null;
    try { saved = localStorage.getItem('sda:mode'); } catch (e) { /* ignore */ }
    setMode(['website', 'folder', 'program', 'data'].indexOf(saved) >= 0 ? saved : 'website');
    setBusy(false);
  }
})();
