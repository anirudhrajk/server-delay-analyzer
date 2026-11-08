/* ProfileCard: vanilla port of React Bits <ProfileCard /> (JS-CSS variant).
   Spring tilt, light, holo foil, glare and intro motion are the original's. The Hugeicons
   Mail01Icon is drawn inline (same 24px stroke icon), so no icon package is needed.
   Additions: handlePrefix ('@' by default; '' to show plain text) and contactHref (a mailto: link).
   Usage: const c = ProfileCard(host, props); c.destroy(); */
(function () {
  const THEMES = {
    dark: {
      '--pc-frame': 'rgba(38, 35, 46, 0.66)', '--pc-frame-edge': 'rgba(255, 255, 255, 0.08)',
      '--pc-frame-highlight': 'rgba(255, 255, 255, 0.07)',
      '--pc-frame-shadow': '0 22px 44px -20px rgba(0, 0, 0, 0.8), 0 6px 16px -8px rgba(0, 0, 0, 0.5)',
      '--pc-tile': 'linear-gradient(180deg, #3a3644 0%, #27242f 100%)', '--pc-tile-edge': 'rgba(255, 255, 255, 0.07)',
      '--pc-tile-highlight': 'rgba(255, 255, 255, 0.12)', '--pc-tile-shadow': '0 4px 10px -4px rgba(0, 0, 0, 0.7)',
      '--pc-ink': '#f4f4f5', '--pc-muted': 'rgba(244, 244, 245, 0.6)', '--pc-hover': 'brightness(1.12)',
      '--pc-press': 'brightness(0.8)', '--pc-shade': 'rgba(0, 0, 0, 0.4)'
    },
    light: {
      '--pc-frame': 'rgba(240, 240, 243, 0.8)', '--pc-frame-edge': 'rgba(24, 24, 27, 0.07)',
      '--pc-frame-highlight': 'rgba(255, 255, 255, 0.95)',
      '--pc-frame-shadow': '0 22px 44px -22px rgba(24, 24, 27, 0.3), 0 6px 16px -10px rgba(24, 24, 27, 0.16)',
      '--pc-tile': 'linear-gradient(180deg, #ffffff 0%, #f6f6f8 100%)', '--pc-tile-edge': 'rgba(24, 24, 27, 0.08)',
      '--pc-tile-highlight': 'rgba(255, 255, 255, 1)', '--pc-tile-shadow': '0 4px 10px -5px rgba(24, 24, 27, 0.25)',
      '--pc-ink': '#27272a', '--pc-muted': 'rgba(39, 39, 42, 0.6)', '--pc-hover': 'brightness(0.97)',
      '--pc-press': 'brightness(0.92)', '--pc-shade': 'rgba(24, 24, 27, 0.14)'
    }
  };
  const FOILS = {
    dark: { '--pc-blend': 'color-dodge', '--pc-holo-filter': 'hue-rotate(0deg)', '--pc-sheen': 'rgba(255, 255, 255, 0.16)' },
    light: { '--pc-blend': 'multiply', '--pc-holo-filter': 'invert(1) hue-rotate(180deg)', '--pc-sheen': 'rgba(255, 255, 255, 0)' }
  };
  const GRAIN = 'url("data:image/svg+xml,' + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='500' height='500'><filter id='g' x='0' y='0' width='100%' height='100%' color-interpolation-filters='sRGB'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0.55 0 0 0 -0.24 0.55 0 0 0 -0.24 0.55 0 0 0 -0.24 0 0 0 0 1'/></filter><rect width='100%' height='100%' filter='url(#g)'/></svg>"
  ) + '")';
  // Hugeicons "Mail01Icon" (stroke, 24px viewBox)
  const MAIL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2 6L8.913 9.917C11.462 11.361 12.538 11.361 15.087 9.917L22 6" />' +
    '<path d="M2.016 13.476C2.081 16.541 2.114 18.074 3.245 19.209C4.376 20.345 5.95 20.384 9.099 20.463C11.039 20.512 12.961 20.512 14.901 20.463C18.05 20.384 19.624 20.345 20.755 19.209C21.886 18.074 21.919 16.541 21.984 13.476C22.005 12.49 22.005 11.51 21.984 10.524C21.919 7.459 21.886 5.926 20.755 4.791C19.624 3.655 18.05 3.616 14.901 3.537C12.961 3.488 11.039 3.488 9.099 3.537C5.95 3.616 4.376 3.655 3.245 4.791C2.114 5.926 2.081 7.459 2.016 10.524C1.995 11.51 1.995 12.49 2.016 13.476Z" /></svg>';

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const isDark = (color) => {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color).trim());
    if (!m) return null;
    const hex = m[1].length === 3 ? m[1].replace(/./g, (d) => d + d) : m[1];
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
  };
  const make = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  function ProfileCard(host, props) {
    const p = Object.assign({
      avatarUrl: '', iconUrl: '', miniAvatarUrl: '', name: 'Javi A. Torres', title: 'Software Engineer', handle: 'javicodes',
      handlePrefix: '@', status: 'Online', statusColor: '#22c55e', contactText: 'Contact', contactHref: '', showUserInfo: true,
      onContactClick: null, theme: 'dark', backdropColor: '', radius: 16, holo: 0.8, glare: 0.5, enableTilt: true,
      tiltStrength: 12, parallax: 8, enableMobileTilt: false, mobileTiltSensitivity: 5, intro: true, className: ''
    }, props || {});

    // ---------- DOM
    const root = make('div', ('profile-card ' + p.className).trim());
    const palette = p.theme === 'light' ? 'light' : 'dark';
    const darkBack = p.backdropColor ? isDark(p.backdropColor) : null;
    const foil = p.backdropColor ? ((darkBack == null ? palette === 'dark' : darkBack) ? 'dark' : 'light') : palette;
    const backdrop = p.backdropColor
      ? 'linear-gradient(180deg, color-mix(in srgb, ' + p.backdropColor + ', #ffffff 12%) 0%, color-mix(in srgb, ' + p.backdropColor + ', #000000 18%) 100%)'
      : 'var(--pc-tile)';
    const vars = Object.assign({}, THEMES[palette], FOILS[foil], {
      '--pc-radius': Math.max(0, p.radius) + 'px', '--pc-backdrop': backdrop, '--pc-holo': clamp(p.holo, 0, 1),
      '--pc-glare': clamp(p.glare, 0, 1), '--pc-parallax': Math.max(0, p.parallax) + 'px', '--pc-status': p.statusColor,
      '--pc-grain': GRAIN, '--pc-pattern': p.iconUrl ? 'url("' + p.iconUrl + '")' : 'linear-gradient(#000, #000)',
      '--pc-pattern-size': p.iconUrl ? '180% auto' : '100% 100%', '--pc-holo-gain': p.iconUrl ? 1.25 : 0.75,
      '--pc-holo-detail': p.iconUrl && foil === 'dark' ? 1 : 0
    });
    Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, String(v)));

    const body = make('div', 'profile-card__body');
    const tile = make('div', 'profile-card__tile');
    const holo = make('span', 'profile-card__holo');
    holo.append(make('span', 'profile-card__holo-glow'), make('span', 'profile-card__holo-shift'));
    tile.append(make('span', 'profile-card__sheen'), holo);
    if (p.avatarUrl) {
      const img = make('img', 'profile-card__photo');
      img.src = p.avatarUrl; img.alt = p.name || ''; img.loading = 'lazy'; img.draggable = false;
      tile.append(img);
    }
    if (p.name || p.title) {
      tile.append(make('span', 'profile-card__scrim'));
      const info = make('div', 'profile-card__info');
      if (p.name) info.append(make('h3', 'profile-card__name', p.name));
      if (p.title) info.append(make('p', 'profile-card__title', p.title));
      tile.append(info);
    }
    tile.append(make('span', 'profile-card__tile-rim'));
    body.append(tile);

    if (p.showUserInfo) {
      const footer = make('div', 'profile-card__footer');
      if (p.miniAvatarUrl) {
        const av = make('span', 'profile-card__avatar');
        const im = make('img'); im.src = p.miniAvatarUrl; im.alt = ''; im.loading = 'lazy'; im.draggable = false;
        av.append(im); footer.append(av);
      }
      const meta = make('div', 'profile-card__meta');
      if (p.handle) meta.append(make('span', 'profile-card__handle', p.handlePrefix + p.handle));
      if (p.status) meta.append(make('span', 'profile-card__status', p.status));
      footer.append(meta);
      if (p.contactText) {
        const btn = make(p.contactHref ? 'a' : 'button', 'profile-card__contact');
        if (p.contactHref) { btn.href = p.contactHref; } else { btn.type = 'button'; }
        btn.setAttribute('aria-label', p.name ? p.contactText + ' ' + p.name : p.contactText);
        btn.innerHTML = MAIL;
        btn.append(document.createTextNode(p.contactText));
        if (p.onContactClick) btn.addEventListener('click', p.onContactClick);
        footer.append(btn);
      }
      body.append(footer);
    }
    body.append(make('span', 'profile-card__glare'), make('span', 'profile-card__shade'), make('span', 'profile-card__rim'));
    root.append(body);
    host.append(root);

    // ---------- motion (first useEffect in the original)
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const size = { width: root.offsetWidth, height: root.offsetHeight };
    const x = { p: 0, v: 0, target: 0 };
    const y = { p: 0, v: 0, target: 0 };
    const light = { p: 0, target: 0 };
    let raf = 0, last = 0, slowUntil = 0, touchId = null;

    const write = () => {
      const angle = p.enableTilt && !reduced ? p.tiltStrength : 0;
      const tilt = Math.min(1, Math.hypot(x.p, y.p));
      const s = root.style;
      s.setProperty('--pc-light-x', ((x.p + 1) * 0.5 * size.width).toFixed(1) + 'px');
      s.setProperty('--pc-light-y', ((y.p + 1) * 0.5 * size.height).toFixed(1) + 'px');
      s.setProperty('--pc-pointer-x', ((x.p + 1) * 50).toFixed(2) + '%');
      s.setProperty('--pc-pointer-y', ((y.p + 1) * 50).toFixed(2) + '%');
      s.setProperty('--pc-band-x', (50 + x.p * 15).toFixed(2) + '%');
      s.setProperty('--pc-band-y', (50 + y.p * 15).toFixed(2) + '%');
      s.setProperty('--pc-rotate-x', (y.p * angle).toFixed(3) + 'deg');
      s.setProperty('--pc-rotate-y', (-x.p * angle).toFixed(3) + 'deg');
      s.setProperty('--pc-shift-x', (x.p * (reduced ? 0 : p.parallax)).toFixed(2) + 'px');
      s.setProperty('--pc-shift-y', (y.p * (reduced ? 0 : p.parallax)).toFixed(2) + 'px');
      s.setProperty('--pc-reach', tilt.toFixed(4));
      s.setProperty('--pc-tilt', (tilt * light.p).toFixed(4));
      s.setProperty('--pc-active', light.p.toFixed(4));
    };
    const frame = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000 || 0);
      last = now;
      const slow = now < slowUntil;
      const stiffness = slow ? 24 : 120, damping = slow ? 9 : 16;
      const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        for (const axis of [x, y]) { axis.v += (stiffness * (axis.target - axis.p) - damping * axis.v) * h; axis.p += axis.v * h; }
      }
      const tau = light.target > light.p ? 0.18 : slow ? 0.9 : 0.45;
      light.p += (light.target - light.p) * (1 - Math.exp(-dt / tau));
      write();
      const moving = Math.abs(x.target - x.p) > 0.0005 || Math.abs(y.target - y.p) > 0.0005 ||
        Math.abs(x.v) > 0.0005 || Math.abs(y.v) > 0.0005 || Math.abs(light.target - light.p) > 0.002;
      if (moving) raf = requestAnimationFrame(frame);
      else { x.p = x.target; y.p = y.target; light.p = light.target; write(); raf = 0; }
    };
    const wake = () => { if (raf) return; last = performance.now(); raf = requestAnimationFrame(frame); };
    const aim = (nx, ny, on = true) => { x.target = clamp(nx, -1, 1); y.target = clamp(ny, -1, 1); light.target = on ? 1 : 0; slowUntil = 0; wake(); };
    const aimAt = (e) => {
      const r = root.getBoundingClientRect();
      if (!r.width || !r.height) return;
      aim(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
    };
    const release = () => aim(0, 0, false);
    const onEnter = (e) => { if (e.pointerType === 'mouse') aimAt(e); };
    const onMove = (e) => { if (e.pointerType === 'mouse' || e.pointerId === touchId) aimAt(e); };
    const onLeave = (e) => { if (e.pointerType === 'mouse') release(); };
    const onDown = (e) => { if (e.pointerType === 'mouse') return; touchId = e.pointerId; aimAt(e); };
    const onUp = (e) => { if (e.pointerId !== touchId) return; touchId = null; release(); };
    root.addEventListener('pointerenter', onEnter);
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerleave', onLeave);
    root.addEventListener('pointerdown', onDown);
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', onUp);
    const observer = new ResizeObserver(() => { size.width = root.offsetWidth; size.height = root.offsetHeight; write(); });
    observer.observe(root);

    if (p.intro && !reduced) {
      x.p = 0.62; y.p = -0.55; light.p = 1;
      slowUntil = performance.now() + 1400;
      write(); wake();
    } else write();

    // ---------- optional phone tilt (third useEffect)
    let listening = false;
    const onOrientation = (e) => {
      if (e.beta == null || e.gamma == null) return;
      aim((e.gamma * p.mobileTiltSensitivity) / 150, ((e.beta - 20) * p.mobileTiltSensitivity) / 150);
    };
    const onClick = () => {
      const Motion = window.DeviceOrientationEvent;
      const listen = () => { if (listening) return; listening = true; window.addEventListener('deviceorientation', onOrientation); };
      if (Motion && typeof Motion.requestPermission === 'function') {
        Motion.requestPermission().then((st) => { if (st === 'granted') listen(); }).catch(() => {});
      } else listen();
    };
    if (p.enableMobileTilt) root.addEventListener('click', onClick);

    return {
      el: root,
      destroy() {
        cancelAnimationFrame(raf);
        observer.disconnect();
        root.removeEventListener('pointerenter', onEnter);
        root.removeEventListener('pointermove', onMove);
        root.removeEventListener('pointerleave', onLeave);
        root.removeEventListener('pointerdown', onDown);
        root.removeEventListener('pointerup', onUp);
        root.removeEventListener('pointercancel', onUp);
        root.removeEventListener('click', onClick);
        window.removeEventListener('deviceorientation', onOrientation);
        root.remove();
      }
    };
  }
  window.ProfileCard = ProfileCard;
})();
