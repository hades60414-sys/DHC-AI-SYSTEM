// Motion recipes for scene code. Each one adds tweens to the master timeline at an absolute time and returns the timeline.
// World coordinates: #world is the canvas-sized layer the camera moves; positions come from layout (offsetLeft/Top), not transforms.
const gsap = () => window.gsap;
const SVGNS = 'http://www.w3.org/2000/svg';
const stageSize = () => { const s = document.getElementById('stage'); return [s.clientWidth, s.clientHeight]; };

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function reveal(tl, targets, at, { y = 36, blur = 10, stagger = 0.06, duration = 0.8, ease = 'expo.out' } = {}) {
  return tl.fromTo(targets, { autoAlpha: 0, y, filter: `blur(${blur}px)` },
    { autoAlpha: 1, y: 0, filter: 'blur(0px)', duration, ease, stagger }, at);
}

export function exit(tl, targets, at, { y = -18, duration = 0.4, stagger = 0.03 } = {}) {
  return tl.to(targets, { autoAlpha: 0, y, filter: 'blur(6px)', duration, ease: 'power2.in', stagger }, at);
}

export function pop(tl, targets, at, { stagger = 0.06, duration = 0.6, from = 0.6 } = {}) {
  return tl.fromTo(targets, { autoAlpha: 0, scale: from }, { autoAlpha: 1, scale: 1, duration, ease: 'back.out(1.7)', stagger }, at);
}

// Mask-up title by character. Works for Chinese (one glyph per char).
export function title(tl, el, at, { stagger = 0.035, duration = 0.9 } = {}) {
  el.style.fontKerning = 'none';
  const split = window.SplitText.create(el, { type: 'chars,lines', mask: 'lines' });
  return tl.fromTo(split.chars, { yPercent: 115 }, { yPercent: 0, duration, ease: 'expo.out', stagger }, at);
}

export function typewriter(tl, el, at, { cps = 24 } = {}) {
  el.style.fontKerning = 'none';
  const split = window.SplitText.create(el, { type: 'chars' });
  return tl.fromTo(split.chars, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.01, stagger: 1 / cps, ease: 'none' }, at);
}

export function scramble(tl, el, text, at, { duration = 0.9, chars = '01<>/#[]=+' } = {}) {
  return tl.to(el, { scrambleText: { text, chars, speed: 0.5 }, duration, ease: 'none' }, at);
}

export function count(tl, el, to, at, { from = 0, duration = 1.2, format = v => Math.round(v).toLocaleString('zh-TW') } = {}) {
  const o = { v: from };
  el.textContent = format(from);
  return tl.to(o, { v: to, duration, ease: 'power2.out', onUpdate: () => { el.textContent = format(o.v); } }, at);
}

export function draw(tl, paths, at, { duration = 0.9, ease = 'power2.inOut', stagger = 0.12 } = {}) {
  return tl.fromTo(paths, { drawSVG: '0%' }, { drawSVG: '100%', duration, ease, stagger }, at);
}

// Dots travelling along an SVG path from `at` until `until`, one every `every` seconds.
// `layer` is the SVG element (often a <g>) the dots go into; dim that group to dim a whole flow at once.
export function packets(tl, path, at, until, { every = 0.4, travel = 1.1, r = 7, className = 'packet', layer = path.ownerSVGElement } = {}) {
  for (let t0 = at; t0 + travel <= until + 0.001; t0 += every) {
    const dot = document.createElementNS(SVGNS, 'circle');
    dot.setAttribute('r', r);
    dot.setAttribute('class', className);
    layer.appendChild(dot);
    gsap().set(dot, { autoAlpha: 0 });
    tl.set(dot, { autoAlpha: 1 }, t0)
      .to(dot, { motionPath: { path, align: path, alignOrigin: [0.5, 0.5], start: 0, end: 1 }, duration: travel, ease: 'power1.inOut', immediateRender: false }, t0)
      .set(dot, { autoAlpha: 0 }, t0 + travel);
  }
  return tl;
}

// Camera: center world point (x, y) at `scale`. duration 0 cuts instantly.
export function camera(tl, { x, y, scale = 1 }, at, { duration = 1.2, ease = 'power2.inOut' } = {}) {
  const [w, h] = stageSize();
  const vars = { x: w / 2 - x * scale, y: h / 2 - y * scale, scale, transformOrigin: '0 0' };
  return duration ? tl.to('#world', { ...vars, duration, ease }, at) : tl.set('#world', vars, at);
}

// Move an element along an SVG path (e.g. a card flying through a connector), fading in at the start.
// Start states are set at build time with gsap.set: a tl.set() at 0 is not applied until the playhead first moves past 0.
export function follow(tl, el, path, at, { duration = 1.2, ease = 'power2.inOut', from = 0, to = 1 } = {}) {
  gsap().set(el, { autoAlpha: 0 });
  return tl.to(el, { motionPath: { path, align: path, alignOrigin: [0.5, 0.5], start: from, end: to }, duration, ease, immediateRender: false }, at)
    .to(el, { autoAlpha: 1, duration: 0.25 }, at);
}

// Layout-space anchor of an element inside #world: side = center|left|right|top|bottom.
export function anchor(el, side = 'center') {
  let x = 0, y = 0;
  for (let n = el; n && n.id !== 'world'; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
  const w = el.offsetWidth, h = el.offsetHeight;
  return {
    center: [x + w / 2, y + h / 2], left: [x, y + h / 2], right: [x + w, y + h / 2], top: [x + w / 2, y], bottom: [x + w / 2, y + h],
  }[side];
}

// Curved connector between two elements (or [x, y] world points), drawn into <svg id="links"> or `layer`. Returns the <path>.
export function link(a, b, { from = 'right', to = 'left', bend = 0.45, className = 'link', layer = document.getElementById('links') } = {}) {
  const svg = layer;
  const [x1, y1] = Array.isArray(a) ? a : anchor(a, from), [x2, y2] = Array.isArray(b) ? b : anchor(b, to);
  const dx = (x2 - x1) * bend, dy = (y2 - y1) * bend;
  const horizontal = from === 'right' || from === 'left';
  const d = horizontal
    ? `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`
    : `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('class', className);
  svg.appendChild(p);
  return p;
}

// Slow drifting bokeh lights for depth (usually into #bg). Seeded positions and one finite tween each, so seeks are exact.
export function bokeh(tl, layer, total, { count = 26, seed = 3 } = {}) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const [w, h] = stageSize();
  for (let i = 0; i < count; i++) {
    const d = document.createElement('div');
    const size = 6 + rnd() * 22;
    d.className = 'bokeh';
    Object.assign(d.style, { left: `${rnd() * w}px`, top: `${rnd() * h}px`, width: `${size}px`, height: `${size}px`, opacity: (0.08 + rnd() * 0.22).toFixed(2) });
    layer.appendChild(d);
    tl.fromTo(d, { x: 0, y: 0 }, { x: (rnd() - 0.5) * 220, y: -40 - rnd() * 160, duration: total, ease: 'none' }, 0);
  }
  return tl;
}

// Raw SVG path from a `d` string, for routes link() cannot express.
export function route(d, { className = 'link', layer = document.getElementById('links') } = {}) {
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('class', className);
  layer.appendChild(p);
  return p;
}

// Expanding ring behind an element (place a .ring child inside it).
export function pulse(tl, el, at, { times = 2, every = 0.8 } = {}) {
  const ring = el.querySelector('.ring') ?? el.appendChild(Object.assign(document.createElement('div'), { className: 'ring' }));
  gsap().set(ring, { autoAlpha: 0 });
  for (let i = 0; i < times; i++) tl.fromTo(ring, { scale: 1, autoAlpha: 0.7 }, { scale: 1.7, autoAlpha: 0, duration: 0.9, ease: 'power2.out', immediateRender: false }, at + i * every);
  return tl;
}

export function glow(tl, el, at, { duration = 0.5, hold = 1.2, color = 'var(--warm)' } = {}) {
  return tl.to(el, { boxShadow: `0 0 0 3px ${color}, 0 0 48px 6px ${color}`, duration, ease: 'power2.out' }, at)
    .to(el, { boxShadow: '0 0 0 0px transparent, 0 0 0px 0px transparent', duration: 0.6, ease: 'power2.inOut' }, at + duration + hold);
}

// Rubber stamp with a short shake: for "blocked" / "approved" moments.
export function stamp(tl, el, at) {
  return tl.fromTo(el, { autoAlpha: 0, scale: 1.9, rotation: -16 }, { autoAlpha: 1, scale: 1, rotation: -8, duration: 0.32, ease: 'power4.in' }, at)
    .fromTo(el, { x: -5 }, { x: 5, duration: 0.05, repeat: 5, yoyo: true, ease: 'none', immediateRender: false }, at + 0.32)
    .set(el, { x: 0 }, at + 0.62);
}

// Pointer moves through points [{x, y, at}] and clicks where click: true (ripple from a .ripple child).
export function pointer(tl, el, points, { duration = 0.7 } = {}) {
  const ripple = el.querySelector('.ripple');
  for (const p of points) {
    tl.to(el, { x: p.x, y: p.y, duration, ease: 'power3.inOut' }, p.at);
    if (p.click) {
      tl.to(el, { scale: 0.82, duration: 0.08, yoyo: true, repeat: 1, ease: 'power1.inOut' }, p.at + duration);
      if (ripple) tl.fromTo(ripple, { scale: 0.2, autoAlpha: 0.8 }, { scale: 2.2, autoAlpha: 0, duration: 0.5, ease: 'power2.out', immediateRender: false }, p.at + duration);
    }
  }
  return tl;
}

// Inline an icon from the asset library (Lucide). Example: icon('server') -> <svg ...>.
const iconCache = {};
export async function loadIcons(names) {
  await Promise.all(names.map(async n => {
    if (iconCache[n]) return;
    const r = await fetch(`/vendor/lucide-static/icons/${n}.svg`);
    if (!r.ok) throw new Error(`icon not found: ${n}`);
    iconCache[n] = await r.text();
  }));
}
export function icon(name, cls = 'icon') {
  if (!iconCache[name]) throw new Error(`icon ${name} not loaded; call loadIcons([...]) first`);
  return iconCache[name].replace('<svg', `<svg class="${cls}"`);
}
