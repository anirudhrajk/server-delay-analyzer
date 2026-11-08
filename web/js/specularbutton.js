/* SpecularButton: vanilla port of React Bits <SpecularButton /> (JS-CSS variant).
   Shader, rim maths and pointer behaviour are copied from the original.
   Differences: one shared WebGL2 renderer for all buttons (copied to a 2D canvas per
   button), and enhance(button) upgrades an existing <button> in place.
   API: SpecularButton(host, props) | SpecularButton.enhance(btn, props) | SpecularButton.enhanceAll(root, props, skipSelector) */
(function () {
const PAD = 24;
const TAU = Math.PI * 2;

const VERTEX = `#version 300 es
in vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uHalf;
uniform float uRadius;
uniform float uPx;
uniform float uSpot;
uniform vec2 uEntry;
uniform vec3 uLineColor;
uniform vec3 uBaseColor;
uniform float uIntensity;
uniform vec2 uWindow;
uniform float uThickness;
uniform float uGlow;
out vec4 outColor;

float roundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float loopPosition(vec2 p, vec2 b, float r) {
  vec2 inner = b - r;
  float arc = 1.5707963 * r;
  float quarter = inner.x + inner.y + arc;
  vec2 a = abs(p);
  vec2 q = a - inner;
  float s = q.x > 0.0 && q.y > 0.0
    ? inner.y + atan(q.y, q.x) * r
    : (q.x > q.y ? min(a.y, inner.y) : inner.y + arc + inner.x - min(a.x, inner.x));
  if (p.x < 0.0) s = p.y >= 0.0 ? 2.0 * quarter - s : 2.0 * quarter + s;
  else if (p.y < 0.0) s = 4.0 * quarter - s;
  return s / max(4.0 * quarter, 0.0001);
}

float lobe(float position, float center) {
  float gap = abs(fract(position - center + 0.5) - 0.5);
  return 1.0 - smoothstep(uWindow.x, uWindow.x + uWindow.y, gap);
}

void main() {
  vec2 p = gl_FragCoord.xy - uCenter;
  float d = roundedBox(p, uHalf, uRadius);
  float position = loopPosition(p, uHalf, uRadius);
  float key = lobe(position, uSpot);
  float back = lobe(position, uSpot + 0.5);
  float streak = key + back * 0.45;
  float width = max(uThickness * uPx * mix(1.0, max(key, back), 0.6), 0.35);
  float band = smoothstep(-width - 0.6, -width + 0.6, d) * (1.0 - smoothstep(-0.6, 0.6, d));
  float hair = smoothstep(-uPx - 0.6, -uPx + 0.6, d) * (1.0 - smoothstep(-0.6, 0.6, d));
  float inside = 1.0 - smoothstep(-0.6, 0.6, d);
  vec2 pool = (p - uEntry) / (uHalf.y * vec2(1.6, 1.1));
  float glow = streak * 0.2 * exp(-abs(d + width * 0.5) / (5.0 * uPx)) + inside * 0.08 * exp(-dot(pool, pool));
  float light = clamp((band * streak + glow * uGlow) * uIntensity, 0.0, 1.0);
  vec4 base = vec4(uBaseColor, 1.0) * hair * 0.6;
  outColor = vec4(uLineColor, 1.0) * light + base * (1.0 - light);
}`;

const UNIFORMS = [
  'uCenter',
  'uHalf',
  'uRadius',
  'uPx',
  'uSpot',
  'uEntry',
  'uLineColor',
  'uBaseColor',
  'uIntensity',
  'uWindow',
  'uThickness',
  'uGlow'
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const wrap = value => value - Math.floor(value);

const loopPosition = (x, y, halfX, halfY, r) => {
  const innerX = halfX - r;
  const innerY = halfY - r;
  const arc = (Math.PI / 2) * r;
  const quarter = innerX + innerY + arc;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const qx = ax - innerX;
  const qy = ay - innerY;
  let s;
  if (qx > 0 && qy > 0) s = innerY + Math.atan2(qy, qx) * r;
  else if (qx > qy) s = Math.min(ay, innerY);
  else s = innerY + arc + innerX - Math.min(ax, innerX);
  if (x < 0) s = y >= 0 ? 2 * quarter - s : 2 * quarter + s;
  else if (y < 0) s = 4 * quarter - s;
  return wrap(s / Math.max(4 * quarter, 0.0001));
};

const rimPoint = (position, halfX, halfY, r) => {
  const innerX = halfX - r;
  const innerY = halfY - r;
  const arc = (Math.PI / 2) * r;
  const quarter = innerX + innerY + arc;
  let s = wrap(position) * 4 * quarter;
  let signX = 1;
  let signY = 1;
  if (s > 3 * quarter) {
    s = 4 * quarter - s;
    signY = -1;
  } else if (s > 2 * quarter) {
    s -= 2 * quarter;
    signX = -1;
    signY = -1;
  } else if (s > quarter) {
    s = 2 * quarter - s;
    signX = -1;
  }
  let x = innerX - (s - innerY - arc);
  let y = halfY;
  if (s <= innerY) {
    x = halfX;
    y = s;
  } else if (s <= innerY + arc) {
    const angle = (s - innerY) / Math.max(r, 0.0001);
    x = innerX + Math.cos(angle) * r;
    y = innerY + Math.sin(angle) * r;
  }
  return [x * signX, y * signY];
};

const compile = (gl, type, source) => {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
};

const link = gl => {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.bindAttribLocation(program, 0, 'aPosition');
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
  gl.deleteProgram(program);
  return null;
};


  // ---------------------------------------------------------------------------
  // One shared WebGL2 renderer for every button (browsers allow only ~16 WebGL
  // contexts per page). Each button draws through it, then copies the pixels to
  // its own light 2D canvas. Same shader, same look as the React component.
  // ---------------------------------------------------------------------------
  let shared = null;
  function renderer() {
    if (shared !== null) return shared;
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true
    });
    const program = gl && link(gl);
    if (!gl || !program) { shared = false; return shared; }
    const uniforms = {};
    for (const name of UNIFORMS) uniforms[name] = gl.getUniformLocation(program, name);
    const buffer = gl.createBuffer();
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    shared = { canvas, gl, program, uniforms, vao };
    return shared;
  }

  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const colors = new Map();
  const toRgb = value => {
    if (colors.has(value)) return colors.get(value);
    let rgb = [1, 1, 1];
    if (probe) {
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = '#000000';
      probe.fillStyle = value;
      probe.fillRect(0, 0, 1, 1);
      const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
      rgb = [r / 255, g / 255, b / 255];
    }
    colors.set(value, rgb);
    return rgb;
  };
  const reduce = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) || false;

  // shared pointer, so one listener serves every button
  const pointer = { x: 0, y: 0, known: false };
  const live = new Set();
  window.addEventListener('pointermove', e => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.known = true; live.forEach(b => b._sbMove()); }, { passive: true });
  const pointerEnd = e => { if (e.pointerType === 'mouse') return; pointer.known = false; live.forEach(b => b._sbWake()); };
  window.addEventListener('pointerup', pointerEnd, { passive: true });
  window.addEventListener('pointercancel', pointerEnd, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { pointer.known = false; live.forEach(b => b._sbWake()); });

  const DEFAULTS = {
    size: '', radius: 18, tint: '#ffffff', tintOpacity: 0.04, blur: 0, textColor: '#f5f5f5',
    lineColor: '#ffffff', baseColor: '#525252', intensity: 1, idleIntensity: 0.35, activeIntensity: 0.9,
    shineSize: 10, shineFade: 34, thickness: 1.2, glow: 1, speed: 0.35, followMouse: true, proximity: 250,
    autoAnimate: false
  };

  // Turn an existing <button> into a SpecularButton (keeps its id, text and click handlers).
  function enhance(button, props) {
    if (!button || button._sb) return button && button._sb;
    const p = Object.assign({}, DEFAULTS, props || {});
    const r = renderer();
    button.classList.add('specular-button');
    if (p.size) button.classList.add('specular-button--' + p.size);
    if (p.radius != null) button.style.setProperty('--sb-radius', p.radius + 'px');
    button.style.setProperty('--sb-tint', p.tint);
    button.style.setProperty('--sb-tint-opacity', p.tintOpacity);
    button.style.setProperty('--sb-blur', p.blur + 'px');
    button.style.setProperty('--sb-text-color', p.textColor);
    if (!r) return null; // no WebGL2: the CSS look still applies

    // wrap the current content in the label span (and keep it wrapped if text is replaced later)
    const label = document.createElement('span');
    label.className = 'specular-button__label';
    while (button.firstChild) label.appendChild(button.firstChild);
    const canvas = document.createElement('canvas');
    canvas.className = 'specular-button__light';
    canvas.setAttribute('aria-hidden', 'true');
    button.append(canvas, label);
    const ctx = canvas.getContext('2d');

    const view = { width: 1, height: 1, ratio: 1 };
    const state = { spot: 0, level: 0, press: 0, ready: false, near: false };
    let raf = 0, last = 0, visible = true;

    const settings = () => {
      const on = button.classList.contains('active') || button.classList.contains('on') || button.getAttribute('aria-selected') === 'true';
      const dis = button.disabled;
      return {
        radius: Math.max(0, parseFloat(getComputedStyle(button).borderTopLeftRadius) || p.radius),
        lineColor: String(p.lineColor), baseColor: String(p.baseColor),
        intensity: Math.max(0, p.intensity) * (dis ? 0.5 : 1),
        idleIntensity: clamp(on ? p.activeIntensity : button.classList.contains('primary') ? Math.max(p.idleIntensity, 0.6) : p.idleIntensity, 0, 1),
        shineSize: Math.max(0, p.shineSize), shineFade: Math.max(0, p.shineFade),
        thickness: Math.max(0, p.thickness), glow: Math.max(0, p.glow), speed: p.speed,
        followMouse: p.followMouse, proximity: Math.max(1, p.proximity), autoAnimate: p.autoAnimate, disabled: dis
      };
    };
    let s = settings();

    const cornerRadius = st => Math.min(st.radius, view.width / 2, view.height / 2);
    const restSpot = st => {
      const rr = cornerRadius(st);
      const inset = rr * (1 - Math.SQRT1_2);
      return loopPosition(inset - view.width / 2, view.height / 2 - inset, view.width / 2, view.height / 2, rr);
    };
    const aim = st => {
      if (!st.followMouse || st.disabled || !pointer.known) return null;
      const rect = button.getBoundingClientRect();
      const scale = rect.width / view.width || 1;
      const halfX = view.width / 2, halfY = view.height / 2;
      const x = (pointer.x - rect.left - rect.width / 2) / scale;
      const y = (rect.top + rect.height / 2 - pointer.y) / scale;
      const distance = Math.hypot(Math.max(Math.abs(x) - halfX, 0), Math.max(Math.abs(y) - halfY, 0));
      const t = clamp(1 - distance / st.proximity, 0, 1);
      const near = t * t * (3 - 2 * t);
      const nearest = loopPosition(x, y, halfX, halfY, cornerRadius(st));
      if (distance > 0) return { spot: nearest, near };
      const depth = clamp(Math.min(halfX - Math.abs(x), halfY - Math.abs(y)) / (halfY * 0.8), 0, 1);
      const sway = restSpot(st) - (x / halfX) * 0.06 - (y / halfY) * 0.02;
      const offset = sway - nearest - Math.round(sway - nearest);
      return { spot: wrap(nearest + offset * depth * depth * (3 - 2 * depth)), near };
    };

    const draw = st => {
      const { gl, program, uniforms, vao } = r;
      const glc = r.canvas;
      if (glc.width !== canvas.width || glc.height !== canvas.height) { glc.width = canvas.width; glc.height = canvas.height; }
      const { width, height } = view;
      const scaleX = canvas.width / (width + PAD * 2);
      const scaleY = canvas.height / (height + PAD * 2);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.uniform2f(uniforms.uCenter, (PAD + width / 2) * scaleX, (PAD + height / 2) * scaleY);
      gl.uniform2f(uniforms.uHalf, (width / 2) * scaleX, (height / 2) * scaleY);
      gl.uniform1f(uniforms.uRadius, Math.min(st.radius, width / 2, height / 2) * scaleX);
      gl.uniform1f(uniforms.uPx, view.ratio);
      const rr = Math.min(st.radius, width / 2, height / 2);
      const [rimX, rimY] = rimPoint(state.spot, width / 2, height / 2, rr);
      const pull = 1 - Math.min(0.35 * (height / 2), Math.hypot(rimX, rimY)) / Math.max(Math.hypot(rimX, rimY), 0.0001);
      gl.uniform1f(uniforms.uSpot, state.spot);
      gl.uniform2f(uniforms.uEntry, rimX * pull * scaleX, rimY * pull * scaleY);
      gl.uniform3fv(uniforms.uLineColor, toRgb(st.lineColor));
      gl.uniform3fv(uniforms.uBaseColor, toRgb(st.baseColor));
      gl.uniform1f(uniforms.uIntensity, st.intensity * (state.level + state.press * 0.8));
      gl.uniform2f(uniforms.uWindow, st.shineSize / 360 + state.press * 0.06, st.shineFade / 360 + 0.0001);
      gl.uniform1f(uniforms.uThickness, st.thickness);
      gl.uniform1f(uniforms.uGlow, st.glow);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(glc, 0, 0);
    };

    const frame = now => {
      raf = 0;
      if (!visible || !button.isConnected) return;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      const target = aim(s);
      const spinning = s.autoAnimate && !reduce;
      const steering = !!target && target.near > 0;
      if (!state.ready) {
        state.spot = restSpot(s);
        state.level = s.autoAnimate ? 1 : s.idleIntensity;
        state.ready = true;
      }
      let diff = 0;
      if (spinning && !steering) state.spot = wrap(state.spot + (s.speed / TAU) * dt);
      else {
        diff = (steering ? target.spot : restSpot(s)) - state.spot;
        diff -= Math.round(diff);
        state.spot = wrap(state.spot + diff * (1 - Math.exp(-dt * 8)));
      }
      const level = s.autoAnimate ? 1 : s.idleIntensity + (1 - s.idleIntensity) * (target ? target.near : 0);
      state.level += (level - state.level) * (1 - Math.exp(-dt * 7));
      state.press *= Math.exp(-dt * 5);
      draw(s);
      const settling = Math.abs(diff) > 0.0002 || Math.abs(level - state.level) > 0.001 || state.press > 0.002;
      if (settling || (spinning && !steering)) raf = requestAnimationFrame(frame);
      else last = 0;
    };
    const wake = () => { if (!raf && visible && view.width > 1) raf = requestAnimationFrame(frame); };

    const measure = entry => {
      const box = entry && entry.borderBoxSize && entry.borderBoxSize[0];
      view.width = Math.max(1, box ? box.inlineSize : button.offsetWidth);
      view.height = Math.max(1, box ? box.blockSize : button.offsetHeight);
      view.ratio = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.max(1, Math.round((view.width + PAD * 2) * view.ratio));
      canvas.height = Math.max(1, Math.round((view.height + PAD * 2) * view.ratio));
      s = settings();
      if (state.ready) draw(s);
      wake();
    };

    // only wake for pointer moves near this button (or when it must fade back)
    button._sbWake = wake;
    button._sbMove = () => {
      if (!visible || view.width <= 1) return;
      const rect = button.getBoundingClientRect();
      const dx = Math.max(rect.left - pointer.x, 0, pointer.x - rect.right);
      const dy = Math.max(rect.top - pointer.y, 0, pointer.y - rect.bottom);
      const near = Math.hypot(dx, dy) < s.proximity + 20;
      if (near || state.near) wake();
      state.near = near;
    };
    const onPointerDown = e => {
      pointer.x = e.clientX; pointer.y = e.clientY; pointer.known = true;
      if (!button.disabled) state.press = 1;
      wake();
    };

    const resizeObserver = new ResizeObserver(entries => measure(entries[entries.length - 1]));
    resizeObserver.observe(button);
    const intersection = new IntersectionObserver(entries => {
      visible = entries.some(e => e.isIntersecting);
      if (visible) { last = 0; wake(); }
    });
    intersection.observe(button);
    // selected / disabled changes brighten or dim the rim
    const mutation = new MutationObserver(() => { s = settings(); wake(); });
    mutation.observe(button, { attributes: true, attributeFilter: ['class', 'disabled', 'aria-selected'] });
    button.addEventListener('pointerdown', onPointerDown);
    live.add(button);
    measure();

    const api = {
      el: button, label,
      setText(text) { label.textContent = text; },
      destroy() {
        cancelAnimationFrame(raf);
        resizeObserver.disconnect(); intersection.disconnect(); mutation.disconnect();
        button.removeEventListener('pointerdown', onPointerDown);
        live.delete(button);
        canvas.remove();
        while (label.firstChild) button.insertBefore(label.firstChild, label);
        label.remove();
        button.classList.remove('specular-button');
        delete button._sb;
      }
    };
    button._sb = api;
    return api;
  }

  // Build a new SpecularButton, like the React component.
  function SpecularButton(host, props) {
    const p = Object.assign({ children: 'Get Started', type: 'button', className: '' }, props || {});
    const b = document.createElement('button');
    b.type = p.type;
    if (p.className) b.className = p.className;
    b.disabled = !!p.disabled;
    if (typeof p.children === 'string') b.textContent = p.children; else if (p.children) b.append(p.children);
    if (p.onClick) b.addEventListener('click', p.onClick);
    host.append(b);
    return enhance(b, Object.assign({ size: 'lg' }, p));
  }

  // Upgrade every button now and any added later (skips elements marked data-plain).
  function enhanceAll(root, props, skip) {
    const ok = el => el.tagName === 'BUTTON' && !el._sb && !el.closest('[data-plain]') && !(skip && el.matches(skip));
    (root || document).querySelectorAll('button').forEach(b => { if (ok(b)) enhance(b, props); });
    const mo = new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(n => {
      if (n.nodeType !== 1) return;
      if (ok(n)) enhance(n, props);
      n.querySelectorAll && n.querySelectorAll('button').forEach(b => { if (ok(b)) enhance(b, props); });
    })));
    mo.observe(root || document.body, { childList: true, subtree: true });
    return mo;
  }

  SpecularButton.enhance = enhance;
  SpecularButton.enhanceAll = enhanceAll;
  window.SpecularButton = SpecularButton;
})();
