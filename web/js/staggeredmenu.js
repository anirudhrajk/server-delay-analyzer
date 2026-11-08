/* StaggeredMenu: vanilla port of React Bits <StaggeredMenu /> (JS-CSS variant). Needs GSAP (window.gsap).
   The GSAP timelines (pre-layers, panel, staggered items, numbering, socials, icon spin,
   colour change and label cycling) are the original's. Additions for this app:
     content      a DOM node shown in the panel under the list (our About + team)
     toggleLabels ['About', 'Close'] instead of ['Menu', 'Close']
     toggleGlyph  text shown in the icon while closed (we show "i"); it turns into the original × when open
     ignoreClickAway  a selector whose clicks must not close the menu (our profile card)
   Usage: const m = StaggeredMenu(host, props); m.open(); m.close(); m.toggle(); m.destroy(); */
(function () {
  const el = (tag, cls, attrs) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) Object.entries(attrs).forEach(([k, v]) => { if (v != null) n.setAttribute(k, v); });
    return n;
  };

  function StaggeredMenu(host, props) {
    const gsap = window.gsap;
    const p = Object.assign({
      position: 'right', colors: ['#B497CF', '#5227FF'], items: [], socialItems: [], displaySocials: true,
      displayItemNumbering: true, className: '', logoUrl: '', menuButtonColor: '#fff', openMenuButtonColor: '#fff',
      accentColor: '#5227FF', changeMenuColorOnOpen: true, isFixed: false, closeOnClickAway: true,
      onMenuOpen: null, onMenuClose: null, content: null, toggleLabels: ['Menu', 'Close'], toggleGlyph: '',
      ignoreClickAway: null, panelLabel: 'Menu'
    }, props || {});
    const [LABEL_CLOSED, LABEL_OPEN] = p.toggleLabels;

    // ---------- DOM (same structure and class names as the React component)
    const wrapper = el('div', ((p.className ? p.className + ' ' : '') + 'staggered-menu-wrapper' + (p.isFixed ? ' fixed-wrapper' : '')),
      { 'data-position': p.position });
    if (p.accentColor) wrapper.style.setProperty('--sm-accent', p.accentColor);

    const preContainer = el('div', 'sm-prelayers', { 'aria-hidden': 'true' });
    (() => {
      const raw = p.colors && p.colors.length ? p.colors.slice(0, 4) : ['#1e1e22', '#35353c'];
      const arr = raw.slice();
      if (arr.length >= 3) arr.splice(Math.floor(arr.length / 2), 1);
      arr.forEach((c) => { const l = el('div', 'sm-prelayer'); l.style.background = c; preContainer.append(l); });
    })();

    const header = el('header', 'staggered-menu-header', { 'aria-label': 'Main navigation header' });
    if (p.logoUrl) {
      const logo = el('div', 'sm-logo', { 'aria-label': 'Logo' });
      const img = el('img', 'sm-logo-img', { src: p.logoUrl, alt: 'Logo', draggable: 'false', width: '110', height: '24' });
      logo.append(img); header.append(logo);
    } else header.append(el('div', 'sm-logo'));
    const panelId = 'staggered-menu-panel-' + Math.random().toString(36).slice(2, 7);
    const toggleBtn = el('button', 'sm-toggle', { type: 'button', 'aria-label': 'Open ' + p.panelLabel, 'aria-expanded': 'false', 'aria-controls': panelId });
    const textWrap = el('span', 'sm-toggle-textWrap', { 'aria-hidden': 'true' });
    const textInner = el('span', 'sm-toggle-textInner');
    textWrap.append(textInner);
    const icon = el('span', 'sm-icon', { 'aria-hidden': 'true' });
    const plusH = el('span', 'sm-icon-line');
    const plusV = el('span', 'sm-icon-line sm-icon-line-v');
    icon.append(plusH, plusV);
    let glyph = null;
    if (p.toggleGlyph) {
      glyph = el('span', 'sm-icon-glyph'); glyph.textContent = p.toggleGlyph;
      icon.append(glyph);
      icon.classList.add('has-glyph');
    }
    toggleBtn.append(textWrap, icon);
    header.append(toggleBtn);

    const panel = el('aside', 'staggered-menu-panel', { id: panelId, 'aria-hidden': 'true', 'aria-label': p.panelLabel });
    const inner = el('div', 'sm-panel-inner');
    const list = el('ul', 'sm-panel-list', { role: 'list' });
    if (p.displayItemNumbering) list.setAttribute('data-numbering', '');
    if (p.items && p.items.length) {
      p.items.forEach((it, idx) => {
        const li = el('li', 'sm-panel-itemWrap');
        const a = el('a', 'sm-panel-item', { href: it.link || '#', 'aria-label': it.ariaLabel, 'data-index': String(idx + 1) });
        const lab = el('span', 'sm-panel-itemLabel'); lab.textContent = it.label;
        a.append(lab);
        if (it.onClick) a.addEventListener('click', (e) => { e.preventDefault(); it.onClick(e); });
        li.append(a); list.append(li);
      });
    } else {
      const li = el('li', 'sm-panel-itemWrap', { 'aria-hidden': 'true' });
      const s = el('span', 'sm-panel-item'); const lab = el('span', 'sm-panel-itemLabel'); lab.textContent = 'No items';
      s.append(lab); li.append(s); list.append(li);
    }
    inner.append(list);
    if (p.content) inner.append(p.content);
    if (p.displaySocials && p.socialItems && p.socialItems.length) {
      const soc = el('div', 'sm-socials', { 'aria-label': 'Social links' });
      const h = el('h3', 'sm-socials-title'); h.textContent = 'Socials';
      const ul = el('ul', 'sm-socials-list', { role: 'list' });
      p.socialItems.forEach((s) => {
        const li = el('li', 'sm-socials-item');
        const a = el('a', 'sm-socials-link', { href: s.link, target: '_blank', rel: 'noopener noreferrer' });
        a.textContent = s.label; li.append(a); ul.append(li);
      });
      soc.append(h, ul); inner.append(soc);
    }
    panel.append(inner);
    wrapper.append(preContainer, header, panel);
    host.append(wrapper);

    // ---------- text lines (React state textLines)
    const setTextLines = (lines) => {
      textInner.innerHTML = '';
      lines.forEach((l) => { const s = el('span', 'sm-toggle-line'); s.textContent = l; textInner.append(s); });
    };
    setTextLines([LABEL_CLOSED, LABEL_OPEN]);

    // ---------- initial state (useLayoutEffect)
    let open = false, busy = false;
    let openTl = null, closeTween = null, spinTween = null, textCycleAnim = null, colorTween = null;
    const preLayers = Array.from(preContainer.querySelectorAll('.sm-prelayer'));
    const offscreen = p.position === 'left' ? -100 : 100;
    gsap.set([panel, ...preLayers], { xPercent: offscreen, opacity: 1 });
    gsap.set(preContainer, { xPercent: 0, opacity: 1 });
    gsap.set(plusH, { transformOrigin: '50% 50%', rotate: 0 });
    gsap.set(plusV, { transformOrigin: '50% 50%', rotate: 90 });
    gsap.set(icon, { rotate: 0, transformOrigin: '50% 50%' });
    gsap.set(textInner, { yPercent: 0 });
    gsap.set(toggleBtn, { color: p.menuButtonColor });
    if (glyph) gsap.set([plusH, plusV], { opacity: 0, scale: 0.4 });

    function buildOpenTimeline() {
      if (openTl) openTl.kill();
      if (closeTween) { closeTween.kill(); closeTween = null; }
      const itemEls = Array.from(panel.querySelectorAll('.sm-panel-itemLabel'));
      const numberEls = Array.from(panel.querySelectorAll('.sm-panel-list[data-numbering] .sm-panel-item'));
      const socialTitle = panel.querySelector('.sm-socials-title');
      const socialLinks = Array.from(panel.querySelectorAll('.sm-socials-link'));
      const extras = Array.from(panel.querySelectorAll('[data-sm-reveal]')); // our About content
      const layerStates = preLayers.map((l) => ({ el: l, start: offscreen }));

      if (itemEls.length) gsap.set(itemEls, { yPercent: 140, rotate: 10 });
      if (numberEls.length) gsap.set(numberEls, { '--sm-num-opacity': 0 });
      if (socialTitle) gsap.set(socialTitle, { opacity: 0 });
      if (socialLinks.length) gsap.set(socialLinks, { y: 25, opacity: 0 });
      if (extras.length) gsap.set(extras, { y: 25, opacity: 0 });

      const tl = gsap.timeline({ paused: true });
      layerStates.forEach((ls, i) => {
        tl.fromTo(ls.el, { xPercent: ls.start }, { xPercent: 0, duration: 0.5, ease: 'power4.out' }, i * 0.07);
      });
      const lastTime = layerStates.length ? (layerStates.length - 1) * 0.07 : 0;
      const panelInsertTime = lastTime + (layerStates.length ? 0.08 : 0);
      const panelDuration = 0.65;
      tl.fromTo(panel, { xPercent: offscreen }, { xPercent: 0, duration: panelDuration, ease: 'power4.out' }, panelInsertTime);

      if (itemEls.length) {
        const itemsStart = panelInsertTime + panelDuration * 0.15;
        tl.to(itemEls, { yPercent: 0, rotate: 0, duration: 1, ease: 'power4.out', stagger: { each: 0.1, from: 'start' } }, itemsStart);
        if (numberEls.length) {
          tl.to(numberEls, { duration: 0.6, ease: 'power2.out', '--sm-num-opacity': 1, stagger: { each: 0.08, from: 'start' } }, itemsStart + 0.1);
        }
      }
      if (socialTitle || socialLinks.length || extras.length) {
        const socialsStart = panelInsertTime + panelDuration * 0.4;
        if (socialTitle) tl.to(socialTitle, { opacity: 1, duration: 0.5, ease: 'power2.out' }, socialsStart);
        if (socialLinks.length) {
          tl.to(socialLinks, {
            y: 0, opacity: 1, duration: 0.55, ease: 'power3.out', stagger: { each: 0.08, from: 'start' },
            onComplete: () => gsap.set(socialLinks, { clearProps: 'opacity' })
          }, socialsStart + 0.04);
        }
        if (extras.length) {
          tl.to(extras, { y: 0, opacity: 1, duration: 0.6, ease: 'power3.out', stagger: { each: 0.08, from: 'start' } }, socialsStart);
        }
      }
      openTl = tl;
      return tl;
    }

    function playOpen() {
      if (busy) return;
      busy = true;
      const tl = buildOpenTimeline();
      if (tl) { tl.eventCallback('onComplete', () => { busy = false; }); tl.play(0); } else busy = false;
    }

    function playClose() {
      if (openTl) { openTl.kill(); openTl = null; }
      const all = [...preLayers, panel];
      if (closeTween) closeTween.kill();
      closeTween = gsap.to(all, {
        xPercent: offscreen, duration: 0.32, ease: 'power3.in', overwrite: 'auto',
        onComplete: () => {
          const itemEls = Array.from(panel.querySelectorAll('.sm-panel-itemLabel'));
          if (itemEls.length) gsap.set(itemEls, { yPercent: 140, rotate: 10 });
          const numberEls = Array.from(panel.querySelectorAll('.sm-panel-list[data-numbering] .sm-panel-item'));
          if (numberEls.length) gsap.set(numberEls, { '--sm-num-opacity': 0 });
          const socialTitle = panel.querySelector('.sm-socials-title');
          const socialLinks = Array.from(panel.querySelectorAll('.sm-socials-link'));
          if (socialTitle) gsap.set(socialTitle, { opacity: 0 });
          if (socialLinks.length) gsap.set(socialLinks, { y: 25, opacity: 0 });
          busy = false;
        }
      });
    }

    function animateIcon(opening) {
      if (spinTween) spinTween.kill();
      if (opening) spinTween = gsap.to(icon, { rotate: 225, duration: 0.8, ease: 'power4.out', overwrite: 'auto' });
      else spinTween = gsap.to(icon, { rotate: 0, duration: 0.35, ease: 'power3.inOut', overwrite: 'auto' });
      if (glyph) { // "i" while closed, the original × while open
        gsap.to(glyph, { opacity: opening ? 0 : 1, scale: opening ? 0.4 : 1, duration: opening ? 0.2 : 0.35, ease: 'power2.out', overwrite: 'auto' });
        gsap.to([plusH, plusV], { opacity: opening ? 1 : 0, scale: opening ? 1 : 0.4, duration: opening ? 0.35 : 0.2, ease: 'power2.out', overwrite: 'auto' });
      }
    }

    function animateColor(opening) {
      if (colorTween) colorTween.kill();
      if (p.changeMenuColorOnOpen) {
        colorTween = gsap.to(toggleBtn, { color: opening ? p.openMenuButtonColor : p.menuButtonColor, delay: 0.18, duration: 0.3, ease: 'power2.out' });
      } else gsap.set(toggleBtn, { color: p.menuButtonColor });
    }

    function animateText(opening) {
      if (textCycleAnim) textCycleAnim.kill();
      const currentLabel = opening ? LABEL_CLOSED : LABEL_OPEN;
      const targetLabel = opening ? LABEL_OPEN : LABEL_CLOSED;
      const cycles = 3;
      const seq = [currentLabel];
      let last = currentLabel;
      for (let i = 0; i < cycles; i++) { last = last === LABEL_CLOSED ? LABEL_OPEN : LABEL_CLOSED; seq.push(last); }
      if (last !== targetLabel) seq.push(targetLabel);
      seq.push(targetLabel);
      setTextLines(seq);
      gsap.set(textInner, { yPercent: 0 });
      const lineCount = seq.length;
      const finalShift = ((lineCount - 1) / lineCount) * 100;
      textCycleAnim = gsap.to(textInner, { yPercent: -finalShift, duration: 0.5 + lineCount * 0.07, ease: 'power4.out' });
    }

    function setOpenState(v) {
      open = v;
      if (v) wrapper.setAttribute('data-open', ''); else wrapper.removeAttribute('data-open');
      toggleBtn.setAttribute('aria-expanded', String(v));
      toggleBtn.setAttribute('aria-label', (v ? 'Close ' : 'Open ') + p.panelLabel);
      panel.setAttribute('aria-hidden', String(!v));
      if (v) document.addEventListener('mousedown', handleClickOutside);
      else document.removeEventListener('mousedown', handleClickOutside);
    }

    function toggleMenu() {
      const target = !open;
      setOpenState(target);
      if (target) { if (p.onMenuOpen) p.onMenuOpen(); playOpen(); }
      else { if (p.onMenuClose) p.onMenuClose(); playClose(); }
      animateIcon(target); animateColor(target); animateText(target);
    }

    function closeMenu() {
      if (!open) return;
      setOpenState(false);
      if (p.onMenuClose) p.onMenuClose();
      playClose(); animateIcon(false); animateColor(false); animateText(false);
    }

    function handleClickOutside(event) {
      if (!p.closeOnClickAway) return;
      if (p.ignoreClickAway && event.target.closest && event.target.closest(p.ignoreClickAway)) return;
      if (!panel.contains(event.target) && !toggleBtn.contains(event.target)) closeMenu();
    }

    toggleBtn.addEventListener('click', toggleMenu);

    return {
      el: wrapper, panel, toggle: toggleBtn,
      open: () => { if (!open) toggleMenu(); },
      close: closeMenu,
      isOpen: () => open,
      destroy() {
        document.removeEventListener('mousedown', handleClickOutside);
        [openTl, closeTween, spinTween, textCycleAnim, colorTween].forEach((t) => t && t.kill());
        wrapper.remove();
      }
    };
  }
  window.StaggeredMenu = StaggeredMenu;
})();
