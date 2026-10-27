// In-page runtime. Builds ONE paused GSAP master timeline from build/timeline.json plus the project's scene functions.
// The renderer calls window.__studio.seek(t) per frame, so scene code must be a pure function of time:
// tweens and timelines only, no setTimeout, no Date, no unseeded Math.random.
import { loadIcons, icon } from './recipes.js';

const hooks = [];
export const onFrame = fn => hooks.push(fn);

export async function boot(scenes, opts) {
  try {
    await build(scenes, opts);
  } catch (e) {
    window.__studioError = e.stack || String(e);
    throw e;
  }
}

async function build(scenes, { drift = true } = {}) {
  const { gsap } = window;
  gsap.registerPlugin(...['SplitText', 'DrawSVGPlugin', 'MotionPathPlugin', 'ScrambleTextPlugin', 'CustomEase', 'MorphSVGPlugin']
    .map(n => window[n]).filter(Boolean));
  gsap.config({ force3D: false });
  const tl = await (await fetch('build/timeline.json', { cache: 'no-store' })).json();
  const iconEls = [...document.querySelectorAll('[data-icon]')];
  await loadIcons([...new Set(iconEls.map(e => e.dataset.icon))]);
  for (const e of iconEls) e.innerHTML = icon(e.dataset.icon);
  await document.fonts.ready;

  const master = gsap.timeline({ paused: true, defaults: { ease: 'power3.out', duration: 0.7 } });
  // Slow push-pull "breathing" so held shots never freeze (the craft bar wants motion in every frame).
  if (drift) master.fromTo('#drift', { scale: 1, x: 0, y: 0 }, { scale: 1.04, x: -22, y: -12, duration: 7, ease: 'sine.inOut', yoyo: true, repeat: Math.ceil(tl.duration / 7) }, 0);
  grain(master, tl.duration);

  for (const s of tl.scenes) {
    const fn = scenes[s.id];
    if (!fn) throw new Error(`scenes.js has no function for scene "${s.id}"`);
    const at = (cue = 'start', offset = 0) => {
      const c = s.cues[cue];
      if (c == null) throw new Error(`scene ${s.id}: unknown cue "${cue}" (have ${Object.keys(s.cues).join(', ')})`);
      return s.start + c + offset;
    };
    fn({ tl: master, gsap, at, start: s.start, end: s.end, dur: s.end - s.start, total: tl.duration, data: s.data, scene: s });
  }
  subtitles(master, tl.scenes.flatMap(s => s.subtitles));
  master.seek(0, false);
  window.__studio = {
    ready: true,
    duration: tl.duration,
    fps: tl.canvas.fps,
    master,
    async seek(t) {
      master.seek(t, false);
      for (const a of document.getAnimations()) { a.pause(); a.currentTime = t * 1000; }
      for (const h of hooks) await h(t);
    },
  };
}

function subtitles(master, cues) {
  const box = document.getElementById('subs');
  if (!box) return;
  for (const c of cues) {
    const el = document.createElement('div');
    el.className = 'sub';
    el.textContent = c.text;
    box.appendChild(el);
    master.fromTo(el, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.2, ease: 'power2.out' }, c.start)
      .to(el, { autoAlpha: 0, duration: 0.15, ease: 'power1.in' }, Math.max(c.start + 0.25, c.end - 0.15));
  }
}

// Film grain: a seeded noise tile whose offset jumps every frame-ish, so it reads as live grain yet stays deterministic.
function grain(master, duration) {
  const el = document.getElementById('grain');
  if (!el) return;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(256, 256);
  let seed = 7;
  for (let i = 0; i < img.data.length; i += 4) {
    seed = (seed * 16807) % 2147483647;
    const v = seed % 256;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  el.style.backgroundImage = `url(${c.toDataURL()})`;
  master.fromTo(el, { backgroundPosition: '0px 0px' }, {
    backgroundPosition: `${Math.round(duration * 24 * 37) % 9973}px ${Math.round(duration * 24 * 53) % 9973}px`,
    ease: `steps(${Math.max(1, Math.round(duration * 24))})`, duration,
  }, 0);
}
