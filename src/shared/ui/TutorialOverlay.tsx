import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { useTheme } from '@/shared/context/ThemeContext';

/**
 * 教學模式 coach marks (11/01). While <html> has .tutorial (ThemeContext: saved switch or Ctrl held), every visible
 * element carrying data-tutorial-tip gets a faint box, so the user sees what can be explained. Full callouts, joined
 * to their box by a line, only appear for the control under the pointer / with focus / picked in the bottom bar,
 * plus a few close neighbours when there is room: showing all ~35 at once covered the page (user, 11/01).
 * With a modal open only that modal's controls are marked. Colours are fixed amber / coffee tokens (--tutorial-*,
 * index.css), not the theme primary. Only the bottom bar takes the pointer; the rest of the layer lets clicks through.
 * Reviewed twice by Astra (11/01): innermost target, modal scope, overflow clipping, wrapping, routing, titles.
 */

type Rect = { x: number; y: number; w: number; h: number };
type Seg = { x1: number; y1: number; x2: number; y2: number };
type Mark = { box: Rect; label: Rect | null; path: Seg[]; tip: string; active: boolean };

const NEIGHBOURS = 3;
const NEIGHBOUR_RADIUS = 220;
const LABEL_MAX_W = 260;
const PAD_X = 8;
const PAD_Y = 5;
const LINE_H = 19;
const FONT = '13px "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif';
const GAP = 14;
const MAX_REACH = 180;

const overlaps = (a: Rect, b: Rect, margin = 0) =>
  a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;

let measureCtx: CanvasRenderingContext2D | null | undefined;
const textWidth = (s: string) => {
  if (measureCtx === undefined) {
    measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    if (measureCtx) measureCtx.font = FONT;
  }
  return measureCtx?.measureText(s).width ?? s.length * 13;
};

/** Callout size: greedy wrap character by character (the label wraps with overflow-wrap:anywhere), plus padding and border. */
export const labelSize = (tip: string, maxW: number) => {
  const inner = maxW - PAD_X * 2 - 2;
  let lines = 1;
  let line = '';
  let widest = 0;
  for (const ch of tip) {
    const next = line + ch;
    if (line && textWidth(next) > inner) {
      widest = Math.max(widest, textWidth(line));
      lines += 1;
      line = ch;
    } else {
      line = next;
    }
  }
  widest = Math.max(widest, textWidth(line));
  return { w: Math.ceil(Math.min(maxW, widest + PAD_X * 2 + 4)), h: lines * LINE_H + PAD_Y * 2 + 2 };
};

const nearestOn = (r: Rect, px: number, py: number) => ({
  x: Math.min(Math.max(px, r.x), r.x + r.w),
  y: Math.min(Math.max(py, r.y), r.y + r.h),
});

/** Whether segment s passes through rect r (Liang-Barsky clip). */
const segHits = (s: Seg, r: Rect) => {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [[-dx, s.x1 - r.x], [dx, r.x + r.w - s.x1], [-dy, s.y1 - r.y], [dy, r.y + r.h - s.y1]];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return t1 - t0 > 0.02;
};

/** Straight connector from the callout's facing edge to the box edge; the L-shaped elbow is the fallback route. */
export const routes = (box: Rect, label: Rect): Seg[][] => {
  const from = nearestOn(label, box.x + box.w / 2, box.y + box.h / 2);
  const to = nearestOn(box, from.x, from.y);
  const straight = [{ x1: from.x, y1: from.y, x2: to.x, y2: to.y }];
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  // Elbow: leave the callout vertically (or horizontally) and turn once onto the box centre line.
  const vFrom = nearestOn(label, cx, cy);
  const elbowV = [
    { x1: vFrom.x, y1: vFrom.y, x2: vFrom.x, y2: cy },
    { x1: vFrom.x, y1: cy, x2: vFrom.x < box.x ? box.x : box.x + box.w, y2: cy },
  ];
  const elbowH = [
    { x1: vFrom.x, y1: vFrom.y, x2: cx, y2: vFrom.y },
    { x1: cx, y1: vFrom.y, x2: cx, y2: vFrom.y < box.y ? box.y : box.y + box.h },
  ];
  return [straight, elbowH, elbowV];
};

const shrink = (r: Rect, by: number): Rect => ({ x: r.x + by, y: r.y + by, w: Math.max(0, r.w - by * 2), h: Math.max(0, r.h - by * 2) });

/**
 * Puts each active callout near its box: candidate spots ranked by distance, the first one inside the viewport and
 * within MAX_REACH that covers no marked box and no earlier callout, and that has a connector route crossing no other
 * box or callout. When nothing qualifies a neighbour's callout is dropped (the box stays) instead of covering something.
 */
export const layoutMarks = (
  items: { tip: string; box: Rect; active: boolean; direct?: boolean }[],
  vw: number,
  vh: number,
): Mark[] => {
  const maxW = Math.min(LABEL_MAX_W, vw - 16);
  const placed: Rect[] = [];
  const boxes = items.map((i) => i.box);
  return items.map(({ tip, box, active, direct }) => {
    if (!active) return { box, label: null, path: [], tip, active };
    const { w, h } = labelSize(tip, maxW);
    const spots: Rect[] = [];
    // Kept inside the viewport so a narrow window still has spots above and below (Astra round 3).
    const clampX = (x: number) => Math.min(Math.max(8, x), vw - w - 8);
    const xs = [...new Set([box.x, box.x + box.w - w, box.x + box.w / 2 - w / 2].map(clampX))];
    for (let k = 0; k < 6; k += 1) {
      for (const x of xs) {
        spots.push({ x, y: box.y + box.h + GAP + k * (h + 6), w, h });
        spots.push({ x, y: box.y - h - GAP - k * (h + 6), w, h });
      }
      const ys = [box.y + box.h / 2 - h / 2 + k * (h + 6), box.y + box.h / 2 - h / 2 - k * (h + 6)];
      for (const y of ys) {
        spots.push({ x: box.x + box.w + GAP, y, w, h });
        spots.push({ x: box.x - w - GAP, y, w, h });
      }
    }
    const reach = (s: Rect) => {
      const p = nearestOn(s, box.x + box.w / 2, box.y + box.h / 2);
      const q = nearestOn(box, p.x, p.y);
      return Math.hypot(p.x - q.x, p.y - q.y);
    };
    const ranked = spots
      .map((s) => ({ s, d: reach(s) }))
      .filter(({ s, d }) => d <= MAX_REACH && s.x >= 4 && s.y >= 4 && s.x + s.w <= vw - 4 && s.y + s.h <= vh - 4)
      .sort((a, b) => a.d - b.d);
    for (const { s } of ranked) {
      if (placed.some((p) => overlaps(p, s, 6)) || boxes.some((b) => overlaps(b, s, 2))) continue;
      const obstacles = [...boxes.filter((b) => b !== box), ...placed].map((r) => shrink(r, 1));
      const path = routes(box, s).find((segs) => segs.every((seg) => !obstacles.some((o) => segHits(seg, o))));
      if (!path) continue;
      placed.push(s);
      return { box, label: s, path, tip, active };
    }
    // The control the user is pointing at always gets its callout: it may cover the faint neighbouring boxes, never
    // another callout or its own control.
    if (direct) {
      const s = ranked.map((r) => r.s).find((c) => !placed.some((p) => overlaps(p, c, 6)) && !overlaps(box, c, 2));
      if (s) {
        placed.push(s);
        return { box, label: s, path: routes(box, s)[0], tip, active };
      }
    }
    return { box, label: null, path: [], tip, active };
  });
};

const isShown = (el: Element, r: DOMRect) => {
  if (r.width < 2 || r.height < 2) return false;
  const check = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
  return check ? check.call(el, { checkOpacity: true, checkVisibilityCSS: true }) : true;
};

/** The element's rect cut down to the viewport and every clipping (overflow ≠ visible) ancestor; null when nothing shows. */
const visibleRect = (el: Element, clipCache: Map<Element, Rect | null>): Rect | null => {
  const r = el.getBoundingClientRect();
  if (!isShown(el, r)) return null;
  let x1 = Math.max(r.left, 0);
  let y1 = Math.max(r.top, 0);
  let x2 = Math.min(r.right, window.innerWidth);
  let y2 = Math.min(r.bottom, window.innerHeight);
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (!clipCache.has(p)) {
      const cs = getComputedStyle(p);
      const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
      const pr = p.getBoundingClientRect();
      clipCache.set(p, clips ? { x: pr.left, y: pr.top, w: pr.width, h: pr.height } : null);
    }
    const c = clipCache.get(p);
    if (c) {
      x1 = Math.max(x1, c.x);
      y1 = Math.max(y1, c.y);
      x2 = Math.min(x2, c.x + c.w);
      y2 = Math.min(y2, c.y + c.h);
    }
    if (x2 - x1 < 2 || y2 - y1 < 2) return null;
  }
  // Covered by something on top (a full-screen tool such as 規劃白板, a panel, a popover): the element must be what
  // the browser hits at one of a few points inside its visible part. The coach-mark layer itself takes no pointer,
  // so it never counts as the cover (user, 11/01: the page behind the plan board was being marked).
  const probes: [number, number][] = [[0.5, 0.5], [0.2, 0.3], [0.8, 0.7]];
  const reachable = probes.some(([fx, fy]) => {
    const hit = document.elementFromPoint(x1 + (x2 - x1) * fx, y1 + (y2 - y1) * fy);
    return Boolean(hit && (el === hit || el.contains(hit)));
  });
  if (!reachable) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
};

/** The open modal that is actually on top (the one hit at its own centre), or null. Non-modal dialogs don't scope. */
const topModal = (): Element | null => {
  const modals = [...document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"], dialog[open]')];
  for (const m of modals.reverse()) {
    const r = m.getBoundingClientRect();
    if (r.width < 2 || !isShown(m, r)) continue;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 40));
    if (hit && m.contains(hit)) return m;
  }
  return null;
};

const pointer = { x: -1, y: -1 };
/** Set by the bottom bar's ‹ ›; cleared when the pointer moves again. */
let picked: Element | null = null;

const collect = (): { marks: Mark[]; targets: Element[] } => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const scope: ParentNode = topModal() ?? document;
  const clipCache = new Map<Element, Rect | null>();
  const els = [...scope.querySelectorAll('[data-tutorial-tip]')];
  const items = els.flatMap((el) => {
    const tip = (el as HTMLElement).dataset.tutorialTip?.trim();
    const box = tip ? visibleRect(el, clipCache) : null;
    return tip && box ? [{ el, tip, box }] : [];
  });
  // The direct target is the innermost tip under the pointer, else the one holding keyboard focus, else the picked one.
  const tipOf = (node: Element | null) => node?.closest('[data-tutorial-tip]') ?? null;
  const focused = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  const hovered = pointer.x >= 0 ? document.elementFromPoint(pointer.x, pointer.y) : null;
  const direct = (picked && items.some((i) => i.el === picked) ? picked : null)
    ?? tipOf(hovered) ?? tipOf(focused);
  const anchor = items.find((i) => i.el === direct)?.box
    ?? (pointer.x >= 0 ? { x: pointer.x, y: pointer.y, w: 0, h: 0 } : null);
  const distance = (b: Rect) => {
    if (!anchor) return Infinity;
    const c = nearestOn(b, anchor.x + anchor.w / 2, anchor.y + anchor.h / 2);
    const a = nearestOn(anchor, c.x, c.y);
    return Math.hypot(c.x - a.x, c.y - a.y);
  };
  const neighbours = items
    .filter((i) => i.el !== direct && !i.el.contains(direct) && !(direct && direct.contains(i.el)))
    .map((i) => ({ i, d: distance(i.box) }))
    .filter(({ d }) => d < NEIGHBOUR_RADIUS)
    .sort((a, b) => a.d - b.d)
    .slice(0, direct ? NEIGHBOURS : NEIGHBOURS + 1)
    .map(({ i }) => i);
  const first = items.find((i) => i.el === direct);
  const active = [...(first ? [first] : []), ...neighbours];
  const ordered = [...active, ...items.filter((i) => !active.includes(i))];
  const marks = layoutMarks(ordered.map((i) => ({ tip: i.tip, box: i.box, active: active.includes(i), direct: i === first })), vw, vh);
  return { marks, targets: items.map((i) => i.el) };
};

/** Phones cannot press Ctrl twice, so the bottom bar gets a × and talks about tapping instead. */
export const isTouchDevice = () =>
  typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches === true || window.innerWidth < 768);

export default function TutorialOverlay() {
  const { setTutorial } = useTheme();
  const touch = isTouchDevice();
  const [on, setOn] = useState(() => document.documentElement.classList.contains('tutorial'));
  const [marks, setMarks] = useState<Mark[]>([]);
  const [step, setStep] = useState<(delta: number) => void>(() => () => undefined);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setOn(root.classList.contains('tutorial')));
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!on) {
      setMarks([]);
      return undefined;
    }
    let last = '';
    let frame = 0;
    let targets: Element[] = [];
    const refresh = () => {
      frame = 0;
      const next = collect();
      targets = next.targets;
      const key = JSON.stringify(next.marks);
      if (key !== last) {
        last = key;
        setMarks(next.marks);
      }
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(refresh);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      // Moving within the bottom bar keeps the ‹ › position; going back to the page resumes pointer exploration.
      if (!(event.target as Element | null)?.closest?.('[data-tutorial-bar]')) picked = null;
      schedule();
    };
    const onLeave = () => {
      pointer.x = -1;
      pointer.y = -1;
      schedule();
    };
    // The native title tooltip would pop up over the callout: park titles inside tips while the mode is on.
    const onOver = (event: MouseEvent) => {
      const host = (event.target as Element | null)?.closest?.('[data-tutorial-tip]');
      if (!host) return;
      for (const el of [host, ...host.querySelectorAll('[title]')]) {
        const title = el.getAttribute('title');
        if (title) {
          el.setAttribute('data-tutorial-title', title);
          el.removeAttribute('title');
        }
      }
    };
    setStep(() => (delta: number) => {
      if (!targets.length) return;
      const at = picked ? targets.indexOf(picked) : -1;
      picked = targets[(at + delta + targets.length) % targets.length];
      schedule();
    });
    refresh();
    const timer = window.setInterval(schedule, 400);
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    window.addEventListener('blur', onLeave);
    document.addEventListener('mouseover', onOver, true);
    const events: [string, boolean][] = [['resize', false], ['scroll', true], ['focusin', true]];
    for (const [type, capture] of events) window.addEventListener(type, schedule, { capture, passive: true });
    return () => {
      window.clearInterval(timer);
      window.cancelAnimationFrame(frame);
      picked = null;
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', onLeave);
      document.removeEventListener('mouseover', onOver, true);
      for (const [type, capture] of events) window.removeEventListener(type, schedule, { capture });
      for (const el of document.querySelectorAll('[data-tutorial-title]')) {
        if (!el.hasAttribute('title')) el.setAttribute('title', el.getAttribute('data-tutorial-title') ?? '');
        el.removeAttribute('data-tutorial-title');
      }
    };
  }, [on]);

  if (!on) return null;
  const barButton = 'pointer-events-auto rounded-full px-2 leading-5 hover:opacity-80 focus-visible:outline focus-visible:outline-2';
  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[110]" data-testid="tutorial-overlay">
      <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
        {marks.map(({ box, path, tip }) => path.length > 0 && (
          <g key={`l|${tip}|${box.x}|${box.y}`}>
            {path.map((s, i) => <line key={`h${i}`} {...s} stroke="var(--tutorial-halo)" strokeWidth={5} strokeLinecap="round" />)}
            {path.map((s, i) => <line key={`i${i}`} {...s} stroke="var(--tutorial-ink)" strokeWidth={2} strokeLinecap="round" />)}
            <circle cx={path[path.length - 1].x2} cy={path[path.length - 1].y2} r={3.5} fill="var(--tutorial-ink)" stroke="var(--tutorial-halo)" strokeWidth={1.5} />
          </g>
        ))}
      </svg>
      {marks.map(({ box, active, tip }) => (
        <div
          key={`b|${tip}|${box.x}|${box.y}`}
          aria-hidden="true"
          data-tutorial-box={active ? 'active' : 'idle'}
          className="fixed rounded-md"
          style={{
            left: box.x - 3,
            top: box.y - 3,
            width: box.w + 6,
            height: box.h + 6,
            border: active ? '2px solid var(--tutorial-ink)' : '1.5px dashed var(--tutorial-ink)',
            boxShadow: active ? '0 0 0 2px var(--tutorial-halo)' : undefined,
            opacity: active ? 1 : 0.5,
          }}
        />
      ))}
      {marks.map(({ box, label, tip }) => label && (
        <div
          key={`t|${tip}|${box.x}|${box.y}`}
          role="note"
          data-tutorial-label
          className="fixed rounded-md shadow-lg"
          style={{
            left: label.x,
            top: label.y,
            width: label.w,
            padding: `${PAD_Y}px ${PAD_X}px`,
            font: FONT,
            lineHeight: `${LINE_H}px`,
            overflowWrap: 'anywhere',
            background: 'var(--tutorial-ink)',
            color: 'var(--tutorial-text)',
            border: '1px solid var(--tutorial-halo)',
          }}
        >
          {tip}
        </div>
      ))}
      <div
        className="fixed bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] shadow-sm"
        style={{ background: 'var(--tutorial-ink)', color: 'var(--tutorial-text)' }}
        data-testid="tutorial-badge"
        data-tutorial-bar
      >
        <button type="button" className={barButton} aria-label="上一個說明" onClick={() => step(-1)}>‹</button>
        <span>{touch ? '教學模式 · 點虛線框或按 ‹ › 看說明' : '教學模式 · 滑到虛線框或按 ‹ › 看說明 · 連按兩下 Ctrl 關閉'}</span>
        <button type="button" className={barButton} aria-label="下一個說明" onClick={() => step(1)}>›</button>
        {touch && <button type="button" className={barButton} aria-label="關閉教學模式" onClick={() => setTutorial(false)}>×</button>}
      </div>
    </div>,
    document.body,
  );
}
