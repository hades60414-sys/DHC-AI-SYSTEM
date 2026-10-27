// 開源 ＋ DHC CLI 架構 teaser. One continuous world; the camera visits each part as the narration names it,
// and focus() dims whatever the current line is not about.
import { $, $$, reveal, exit, pop, title, typewriter, count, draw, packets, camera, route, link, pulse, stamp, follow, bokeh } from '/studio/recipes.js';

const WALL_GLOW = '0 0 40px rgba(92,200,255,.35), inset 0 0 18px rgba(92,200,255,.4)';
const HOST = ['#host', '#tag-host'];
const GATE = ['#gate', '#danger', '#stop', '#human'];
const DOCS = ['#docs', '#tag-docs', '#question', '#timer'];
const paths = {};

function focus(tl, at, { dim = [], bright = [] }) {
  if (dim.length) tl.to(dim, { opacity: 0.22, duration: 0.6, ease: 'power2.inOut' }, at);
  if (bright.length) tl.to(bright, { opacity: 1, duration: 0.6, ease: 'power2.inOut' }, at);
}

export function hook({ tl, at, total }) {
  camera(tl, { x: 1930, y: 900, scale: 1.0 }, 0, { duration: 0 });
  bokeh(tl, $('#bg'), total);
  tl.fromTo('#wall', { scaleY: 0 }, { scaleY: 1, duration: 1.1, ease: 'expo.out' }, 0.15);
  tl.fromTo('#wall .scan', { y: 0 }, { y: 1900, duration: 2.6, ease: 'none', repeat: Math.ceil(total / 2.6) }, 0.8);
  title(tl, $('#hook-in'), at('in'));
  title(tl, $('#hook-out'), at('out'));
  tl.to('#wall', { boxShadow: '0 0 90px rgba(92,200,255,.9), inset 0 0 30px rgba(255,255,255,.6)', duration: 0.35, ease: 'power2.out' }, at('out', 0.05))
    .to('#wall', { boxShadow: WALL_GLOW, duration: 1.0, ease: 'power2.inOut' }, at('out', 0.6));
  exit(tl, ['#hook-in', '#hook-out'], at('end', -0.55), { duration: 0.45 });
}

export function bridge({ tl, at, total }) {
  camera(tl, { x: 1640, y: 760, scale: 0.6 }, at('start'), { duration: 1.8 });
  reveal(tl, ['#lbl-in', '#lbl-out'], at('start', 0.8), { stagger: 0.15 });
  pop(tl, '#browser', at('start', 0.5), { from: 0.85 });
  reveal(tl, '#b-me', at('start', 1.1), { y: 16 });
  pop(tl, '#exit', at('tunnel', -0.3));
  paths.browser = route('M900,545 C1300,545 1500,428 1872,428', { layer: $('#pipes') });
  paths.trunk = route('M1988,428 C2150,428 2210,640 2330,640', { layer: $('#pipes') });
  draw(tl, paths.browser, at('tunnel'), { duration: 0.9 });
  draw(tl, paths.trunk, at('tunnel', 0.8), { duration: 0.7 });
  pop(tl, '#outbound', at('tunnel', 1.3));
  pop(tl, '#brain', at('brain', -0.15), { from: 0.4, duration: 0.9 });
  reveal(tl, '#brain-label', at('brain', 0.3));
  const spin = total - at('brain');
  tl.fromTo('#brain .r1', { rotation: 0 }, { rotation: 360, svgOrigin: '230 230', duration: spin, ease: 'none' }, at('brain'))
    .fromTo('#brain .r2', { rotation: 0 }, { rotation: -540, svgOrigin: '230 230', duration: spin, ease: 'none' }, at('brain'))
    .fromTo('#brain .r3', { rotation: 0 }, { rotation: 720, svgOrigin: '230 230', duration: spin, ease: 'none' }, at('brain'));
  packets(tl, paths.browser, at('brain', 0.4), total, { every: 0.55, travel: 1.2, layer: $('#flow') });
  packets(tl, paths.trunk, at('brain', 1.0), total, { every: 0.55, travel: 0.9, layer: $('#flow') });
  pop(tl, '#b-ai', at('brain', 0.9));
  tl.fromTo('#b-ai .dots b', { y: 0 }, { y: -9, duration: 0.32, yoyo: true, repeat: Math.ceil(total / 0.32), stagger: 0.12, ease: 'sine.inOut' }, at('brain', 1.1));
}

export function hands({ tl, at, total }) {
  camera(tl, { x: 1600, y: 930, scale: 0.58 }, at('start'), { duration: 1.4 });
  pop(tl, ['#tag-host', '#host'], at('hand1'), { stagger: 0.12, from: 0.85 });
  paths.arm1 = route('M760,1010 C900,700 1500,470 1872,452', { layer: $('#pipes') });
  draw(tl, paths.arm1, at('hand1', 0.3), { duration: 0.8 });
  packets(tl, paths.arm1, at('hand1', 1.0), total, { every: 0.7, travel: 1.3, layer: $('#flow') });
  pop(tl, ['#tag-docs', '#docs'], at('hand2'), { stagger: 0.12, from: 0.85 });
  paths.arm2 = route('M1580,1010 C1640,760 1760,520 1872,464', { layer: $('#pipes') });
  draw(tl, paths.arm2, at('hand2', 0.3), { duration: 0.7 });
  packets(tl, paths.arm2, at('hand2', 1.0), total, { every: 0.7, travel: 1.0, layer: $('#flow') });
}

export function control({ tl, at, total }) {
  camera(tl, { x: 560, y: 1270, scale: 1.0 }, at('start'), { duration: 1.3 });
  focus(tl, at('start', 0.3), { dim: ['#docs', '#tag-docs'] });
  tl.to('#ghost-host', { autoAlpha: 0, scale: 0.8, duration: 0.5 }, at('agent', 0.2));
  reveal(tl, '#agent', at('agent', 0.5), { y: 16 });
  tl.fromTo('#agent .live', { scale: 1, opacity: 1 }, { scale: 1.6, opacity: 0.4, duration: 0.6, yoyo: true, repeat: Math.ceil((total - at('agent')) / 0.6), ease: 'sine.inOut' }, at('agent', 0.7));
  reveal(tl, ['#wl1', '#wl2', '#wl3'], at('agent', 1.0), { stagger: 0.25, y: 20 });
  reveal(tl, '#raw', at('manifest', -0.3), { y: 20 });
  pop(tl, '#raw .lockbadge', at('manifest', 0.4));
  follow(tl, $('#manifest'), paths.arm1, at('manifest', 1.0), { duration: 1.8 });
  tl.to('#manifest', { autoAlpha: 0, scale: 0.6, duration: 0.3 }, at('manifest', 2.6));
}

export function gate({ tl, at }) {
  camera(tl, { x: 760, y: 1290, scale: 1.08 }, at('gate', -0.05), { duration: 0.45, ease: 'expo.inOut' });
  reveal(tl, '#gate .gate-label', at('gate', -0.1), { y: 10 });
  tl.fromTo('#gate .post', { scaleY: 0 }, { scaleY: 1, duration: 0.45, ease: 'back.out(1.6)' }, at('gate', 0.05));
  tl.fromTo('#danger', { autoAlpha: 0, x: 460 }, { autoAlpha: 1, x: 0, duration: 0.5, ease: 'power3.out' }, at('gate'));
  stamp(tl, $('#stop'), at('gate', 0.23));
  tl.fromTo('#danger', { x: 0 }, { x: 10, duration: 0.05, repeat: 5, yoyo: true, ease: 'none', immediateRender: false }, at('gate', 0.55))
    .set('#danger', { x: 0 }, at('gate', 0.85));
  pop(tl, '#human', at('human', 0.2));
}

export function rag({ tl, at }) {
  camera(tl, { x: 1580, y: 1290, scale: 1.0 }, at('start'), { duration: 1.3 });
  focus(tl, at('start', 0.2), { dim: [...HOST, ...GATE], bright: ['#docs', '#tag-docs'] });
  tl.to('#ghost-docs', { autoAlpha: 0, scale: 0.8, duration: 0.5 }, at('docs'));
  tl.fromTo($$('#stack .doc'), { autoAlpha: 0, x: 0, y: 30, rotation: 0 },
    { autoAlpha: 1, x: i => i * 7, y: i => -i * 7, rotation: i => (i - 2.5) * 5, duration: 0.7, stagger: 0.07, ease: 'power3.out' }, at('docs', 0.1));
  reveal(tl, '#count', at('docs', 0.1), { y: 10 });
  count(tl, $('#n67'), 67, at('docs', 0.2), { duration: 1.6 });
  const grid = $('#grid');
  for (let i = 0; i < 24; i++) grid.appendChild(Object.assign(document.createElement('div'), { className: 'cell' }));
  const cells = $$('#grid .cell');
  pop(tl, cells, at('docs', 1.8), { stagger: 0.03, from: 0.4, duration: 0.4 });
  pop(tl, '#question', at('ask', -0.1), { from: 0.8 });
  typewriter(tl, $('#q-text'), at('ask', 0.1), { cps: 14 });
  tl.fromTo('#beam', { autoAlpha: 0, x: 0 }, { autoAlpha: 1, duration: 0.15 }, at('found', -0.75))
    .to('#beam', { x: 280, duration: 0.7, ease: 'power1.inOut' }, at('found', -0.75))
    .to('#beam', { autoAlpha: 0, duration: 0.2 }, at('found', -0.05));
  tl.to([cells[5], cells[14], cells[19]], { backgroundColor: 'rgba(255,181,71,.35)', borderColor: '#ffb547', boxShadow: '0 0 22px rgba(255,181,71,.85)',
    duration: 0.3, stagger: 0.08 }, at('found'));
  pop(tl, '#timer', at('found', 0.25));
}

export function answer({ tl, at }) {
  camera(tl, { x: 2300, y: 900, scale: 0.75 }, at('start'), { duration: 1.4 });
  ['#fly1', '#fly2', '#fly3'].forEach((sel, i) => {
    const el = $(sel), t = at('answer', 0.1 + i * 0.14);
    follow(tl, el, paths.arm2, t, { duration: 0.9 });
    tl.to(el, { motionPath: { path: paths.trunk, align: paths.trunk, alignOrigin: [0.5, 0.5], start: 0, end: 1 }, duration: 0.8, ease: 'power2.inOut', immediateRender: false }, t + 0.9)
      .to(el, { autoAlpha: 0, scale: 0.5, duration: 0.25 }, t + 1.65);
  });
  pulse(tl, $('#brain'), at('answer', 1.9), { times: 2, every: 0.5 });
  pop(tl, '#answer', at('cite', -0.7), { from: 0.9 });
  tl.fromTo($$('#answer .line'), { scaleX: 0, transformOrigin: '0 50%' }, { scaleX: 1, duration: 0.5, stagger: 0.12, ease: 'power3.out' }, at('cite', -0.45));
  pop(tl, ['#cite1', '#cite2'], at('cite', 0.15), { stagger: 0.15 });
  const cells = $$('#grid .cell');
  const refs = [link($('#cite1'), cells[5], { from: 'left', to: 'right', bend: 0.5, className: 'link warm dash', layer: $('#refs') }),
    link($('#cite2'), cells[19], { from: 'left', to: 'right', bend: 0.5, className: 'link warm dash', layer: $('#refs') })];
  draw(tl, refs, at('cite', 0.5), { duration: 1.0 });
}

export function local({ tl, at }) {
  camera(tl, { x: 1400, y: 640, scale: 0.85 }, at('start'), { duration: 1.3 });
  focus(tl, at('lock', 0.6), { dim: ['#docs', '#tag-docs', '#timer'] });
  pop(tl, '#exitlock', at('lock', 0.1), { from: 1.6, duration: 0.45 });
  tl.to(['#pipes', '#flow', '#refs'], { opacity: 0.12, duration: 0.6 }, at('lock', 0.2))
    .to('#brain', { opacity: 0.3, filter: 'grayscale(1)', duration: 0.8 }, at('lock', 0.2))
    .to(['#outbound', '#answer', '#brain-label'], { autoAlpha: 0.25, duration: 0.6 }, at('lock', 0.2))
    .to('#wall', { boxShadow: '0 0 70px rgba(255,181,71,.75), inset 0 0 22px rgba(255,181,71,.6)', duration: 0.6 }, at('lock', 0.2));
  pop(tl, '#local', at('lock', 0.9), { from: 0.85 });
  paths.local = route('M1560,1010 C1500,820 1420,700 1400,600', { className: 'link warm', layer: $('#localflow') });
  draw(tl, paths.local, at('lock', 1.4), { duration: 0.8 });
  packets(tl, paths.local, at('lock', 2.0), at('end', 1.0), { every: 0.5, travel: 1.0, className: 'packet warm', layer: $('#localflow') });
  tl.fromTo('#progress b', { scaleX: 0 }, { scaleX: 0.72, duration: at('end') - at('lock', 2.4), ease: 'power1.inOut' }, at('lock', 2.4));
  pop(tl, '#zero', at('slow', 0.6));
}

export function close({ tl, at }) {
  camera(tl, { x: 1600, y: 900, scale: 0.6 }, at('start'), { duration: 1.6 });
  focus(tl, at('start', 0.3), { bright: [...HOST, ...GATE, '#docs', '#tag-docs'] });
  tl.to(['#pipes', '#flow'], { opacity: 1, duration: 0.8 }, at('start', 0.3))
    .to(['#refs', '#localflow'], { opacity: 0, duration: 0.6 }, at('start', 0.3))
    .to('#brain', { opacity: 1, filter: 'grayscale(0)', duration: 0.8 }, at('start', 0.3))
    .to(['#outbound', '#brain-label'], { autoAlpha: 1, duration: 0.6 }, at('start', 0.3))
    .to(['#answer', '#zero', '#question', '#timer'], { autoAlpha: 0, duration: 0.5 }, at('start', 0.3))
    .to('#exitlock', { autoAlpha: 0, scale: 0.6, duration: 0.4 }, at('start', 0.3))
    .to('#wall', { boxShadow: WALL_GLOW, duration: 0.8 }, at('start', 0.3))
    .to('#drift', { filter: 'blur(2px) brightness(0.55)', duration: 0.8, ease: 'power2.inOut' }, at('start', 0.5));
  title(tl, $('#close-1'), at('start', 0.4));
  title(tl, $('#close-2'), at('inside'));
  tl.to('#drift', { filter: 'blur(10px) brightness(0.4)', duration: 1.0, ease: 'power2.inOut' }, at('logo', -0.6));
  exit(tl, ['#close-1', '#close-2'], at('logo', -0.6), { duration: 0.5 });
  tl.fromTo('#logo', { autoAlpha: 0, scale: 0.86, filter: 'blur(14px)' }, { autoAlpha: 1, scale: 1, filter: 'blur(0px)', duration: 1.0, ease: 'expo.out' }, at('logo'));
  tl.fromTo('#logo .shine', { backgroundPosition: '120% 0' }, { backgroundPosition: '-20% 0', duration: 1.3, ease: 'power2.inOut' }, at('logo', 0.7));
  reveal(tl, '#logo-sub', at('logo', 0.5), { y: 18 });
}
