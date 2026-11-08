/* ScrollExpand: vanilla port of React Bits <ScrollExpand /> (JS-CSS variant).
   Same props, same maths (clip-path frame that opens to full size, media zoom,
   title out, overlay in). Two additions for this app:
     onProgress(p, eased): called on every frame (we dim the report while the window is small)
     media: a DOM node to use instead of an <img>/<video> (we put the report in it)
     play({duration, delay}): drive the progress by time instead of by scrolling,
       so the frame opens on its own. Returns a Promise that resolves at the end.
   Usage: const se = ScrollExpand(host, props); se.play().then(...); se.destroy(); */
(function () {
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smoothstep = (edge0, edge1, x) => {
    const t = clamp((x - edge0) / (edge1 - edge0 || 1e-6), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const DEFAULTS = {
    src: '', mediaType: 'image', poster: '', alt: '', title: '', scrollHint: '',
    startWidth: 42, startHeight: 58, startRadius: 24, endRadius: 0, mediaZoom: 1.35,
    scrollDistance: 1.2, holdDistance: 0.35, smoothing: 0.1, overlayScrim: 0.45,
    useWindowScroll: false, enabled: true, children: null, className: '', media: null, onProgress: null,
    autoPlay: false
  };
  const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

  function ScrollExpand(host, props) {
    const c = Object.assign({}, DEFAULTS, props || {});
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const root = el('div', ('scroll-expand ' + (c.useWindowScroll || c.autoPlay ? '' : 'scroll-expand--scroller ') +
      (c.autoPlay ? 'scroll-expand--auto ' : '') + c.className).trim());
    const track = el('div', 'scroll-expand__track');
    const stage = el('div', 'scroll-expand__stage');
    const frame = el('div', 'scroll-expand__frame');
    let media;
    if (c.media) { media = c.media; media.classList.add('scroll-expand__media'); }
    else if (c.mediaType === 'video') {
      media = el('video', 'scroll-expand__media');
      Object.assign(media, { src: c.src, poster: c.poster, autoplay: true, muted: true, loop: true, playsInline: true });
    } else {
      media = el('img', 'scroll-expand__media');
      media.src = c.src; media.alt = c.alt; media.draggable = false;
    }
    const scrim = el('div', 'scroll-expand__scrim');
    frame.append(media, scrim);
    let overlay = null, titleEl = null, hint = null;
    if (c.children) {
      overlay = el('div', 'scroll-expand__overlay');
      if (typeof c.children === 'string') overlay.innerHTML = c.children; else overlay.append(c.children);
      frame.append(overlay);
    }
    stage.append(frame);
    if (c.title) { titleEl = el('div', 'scroll-expand__title'); titleEl.textContent = c.title; stage.append(titleEl); }
    if (c.scrollHint) { hint = el('div', 'scroll-expand__hint'); hint.textContent = c.scrollHint; stage.append(hint); }
    track.append(stage); root.append(track); host.append(root);

    function applyProgress(p) {
      const e = smoothstep(0, 1, p);
      const w = c.startWidth + (100 - c.startWidth) * e;
      const h = c.startHeight + (100 - c.startHeight) * e;
      const ix = Math.max(0, (100 - w) / 2);
      const iy = Math.max(0, (100 - h) / 2);
      const r = c.startRadius + (c.endRadius - c.startRadius) * e;
      frame.style.clipPath = 'inset(' + iy + '% ' + ix + '% ' + iy + '% ' + ix + '% round ' + r + 'px)';
      media.style.transform = 'scale(' + (c.mediaZoom + (1 - c.mediaZoom) * e) + ')';
      scrim.style.opacity = String(c.overlayScrim * e);
      if (titleEl) {
        const out = smoothstep(0.4, 0.88, p);
        titleEl.style.opacity = String(1 - out);
        titleEl.style.transform = 'translate3d(0, ' + (-28 * out) + 'px, 0) scale(' + (1 + 0.06 * out) + ')';
      }
      if (hint) {
        const gone = smoothstep(0, 0.12, p);
        hint.style.opacity = String(1 - gone);
        hint.style.transform = 'translate3d(0, ' + (8 * gone) + 'px, 0)';
      }
      if (overlay) {
        const inn = smoothstep(0.68, 1, p);
        overlay.style.opacity = String(inn);
        overlay.style.transform = 'translate3d(0, ' + (18 * (1 - inn)) + 'px, 0)';
      }
      if (c.onProgress) c.onProgress(p, e);
    }

    let raf = 0, current = 0, target = 0, stageH = 0, running = false;
    const measure = () => {
      stageH = c.useWindowScroll ? window.innerHeight : root.clientHeight;
      if (stageH <= 0) return;
      stage.style.height = stageH + 'px';
      track.style.height = (c.autoPlay ? stageH : stageH * (1 + Math.max(0, c.scrollDistance) + Math.max(0, c.holdDistance))) + 'px';
      const w = root.clientWidth || stageH;
      stage.style.setProperty('--se-title-size', clamp(w * 0.075, 20, 84) + 'px');
    };
    const readProgress = () => {
      if (!c.enabled) return 1;
      const span = stageH * Math.max(0.01, c.scrollDistance);
      if (c.useWindowScroll) return clamp(-track.getBoundingClientRect().top / span, 0, 1);
      return clamp(root.scrollTop / span, 0, 1);
    };
    const tick = () => {
      const k = c.smoothing <= 0 ? 1 : 1 - Math.exp(-1 / (60 * c.smoothing));
      current += (target - current) * k;
      if (Math.abs(target - current) < 0.0004) { current = target; running = false; }
      applyProgress(current);
      raf = running ? requestAnimationFrame(tick) : 0;
    };
    const kick = () => { if (running) return; running = true; if (!raf) raf = requestAnimationFrame(tick); };
    const onScroll = () => {
      target = readProgress();
      if (c.smoothing <= 0 || reduceMotion) { current = target; applyProgress(current); return; }
      kick();
    };
    const onResize = () => {
      measure();
      if (c.autoPlay) { applyProgress(current); return; }
      target = readProgress(); current = target; applyProgress(current);
    };

    measure();
    if (!c.autoPlay) { target = readProgress(); current = target; }
    applyProgress(current);

    const scroller = c.useWindowScroll ? window : root;
    if (!c.autoPlay) scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(root);

    // time-driven opening (no scrolling needed)
    let playRaf = 0;
    function play(opts) {
      const o = Object.assign({ duration: 1500, delay: 450 }, opts || {});
      cancelAnimationFrame(playRaf);
      current = 0; applyProgress(0);
      if (reduceMotion) { current = 1; applyProgress(1); return Promise.resolve(); }
      return new Promise((resolve) => {
        const t0 = performance.now() + o.delay;
        const step = (now) => {
          const p = clamp((now - t0) / o.duration, 0, 1);
          current = p; applyProgress(p);
          if (p < 1) playRaf = requestAnimationFrame(step); else resolve();
        };
        playRaf = requestAnimationFrame(step);
      });
    }

    return {
      el: root, frame, media,
      setProgress: (p) => { current = clamp(p, 0, 1); applyProgress(current); },
      play,
      destroy() {
        cancelAnimationFrame(raf); cancelAnimationFrame(playRaf);
        scroller.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onResize);
        ro.disconnect();
        root.remove();
      }
    };
  }
  window.ScrollExpand = ScrollExpand;
})();
