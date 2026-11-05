import type { PlanEdge, PlanNode } from '@/shared/planBoards';

/**
 * DHC CLI 10/14 規劃白板: two checks on a board the AI sent back before it is drawn. An arrow's label sits in the gap
 * between its two boxes, so a gap narrower than the label puts the words on top of the boxes; the boxes past that
 * gap move over until the label fits. And what the AI changed, so the page can say so and select it.
 */

// Excalidraw draws labels at 20px: a CJK character is about that wide, Latin letters about half.
const WIDE_CHAR_PX = 20;
const NARROW_CHAR_PX = 11;
const LABEL_PADDING_PX = 40;
const MAX_PASSES = 20;

const isWide = (char: string) => /[⺀-鿿가-힯豈-﫿＀-￯]/.test(char);
const lineWidth = (line: string) => [...line].reduce((sum, char) => sum + (isWide(char) ? WIDE_CHAR_PX : NARROW_CHAR_PX), 0);

/** Width of the longest line of an arrow label, plus room on both sides. */
export function labelWidth(text: string): number {
  const lines = text.trim().split(/\r?\n/);
  const widest = Math.max(...lines.map(lineWidth));
  return widest + LABEL_PADDING_PX;
}

/** Label height: one 20px font line is about 25px. */
const LINE_PX = 25;
const labelHeight = (text: string) => text.trim().split(/\r?\n/).length * LINE_PX + LABEL_PADDING_PX;

const MAX_FIT_WIDTH = 360;
// Text in a diamond only has about the middle half of the outline, so a diamond needs this much more than a box.
const DIAMOND_FACTOR = 1.6;
const MAX_OVERLAP_PASSES = 50;


/** Lines the text takes when Excalidraw wraps it at `room` px, character by character. */
function wrappedLines(lines: string[], room: number): number {
  return lines.reduce((count, line) => {
    let rows = 1;
    let used = 0;
    for (const char of line) {
      const px = isWide(char) ? WIDE_CHAR_PX : NARROW_CHAR_PX;
      if (used > 0 && used + px > room) {
        rows += 1;
        used = 0;
      }
      used += px;
    }
    return count + rows;
  }, 0);
}

/**
 * 10/19: Excalidraw wraps a long label and grows the box downward over the box below. Boxes are made big enough for
 * their text first: a one-line label too wide for its box widens it (up to 360), then the box is as tall as the
 * wrapped lines need. Boxes only grow.
 */
export function fitBoxesToText(nodes: PlanNode[]): PlanNode[] {
  return nodes.map((node) => {
    const text = node.text.trim();
    if (!text) return node;
    const factor = node.shape === 'diamond' ? DIAMOND_FACTOR : 1;
    const lines = text.split(/\r?\n/);
    // Sizes below are what a plain box would need; a diamond's outline is that times the factor.
    let inner = node.w / factor;
    if (lines.length === 1 && lineWidth(lines[0]) > inner - LABEL_PADDING_PX) {
      inner = Math.max(inner, Math.min(MAX_FIT_WIDTH, lineWidth(lines[0]) + LABEL_PADDING_PX));
    }
    const needH = wrappedLines(lines, inner - LABEL_PADDING_PX) * LINE_PX + LABEL_PADDING_PX;
    const w = Math.max(node.w, Math.round(inner * factor));
    const h = Math.max(node.h, Math.round(needH * factor));
    return w === node.w && h === node.h ? node : { ...node, w, h };
  });
}

/**
 * 10/19: boxes closer than `gap` (or overlapping) are moved apart: the lower one (by centre, else the one further
 * right) goes down until it clears, which may push the next one in turn. Boxes that clear everything stay put.
 */
export function resolveOverlaps(nodes: PlanNode[], gap = 40): PlanNode[] {
  const placed = nodes.map((node) => ({ ...node }));
  const centerY = (node: PlanNode) => node.y + node.h / 2;
  for (let pass = 0; pass < MAX_OVERLAP_PASSES; pass += 1) {
    let moved = false;
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i];
        const b = placed[j];
        const close = a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
        if (!close) continue;
        // Two boxes on one row (a box widened to fit its text) move apart sideways, so the row stays a row;
        // otherwise the lower one goes down.
        if (Math.abs((a.x + a.w / 2) - (b.x + b.w / 2)) > Math.abs(centerY(a) - centerY(b))) {
          const [left, right] = a.x + a.w / 2 <= b.x + b.w / 2 ? [a, b] : [b, a];
          right.x = left.x + left.w + gap;
        } else {
          const [upper, lower] = centerY(a) > centerY(b) ? [b, a] : [a, b];
          lower.y = upper.y + upper.h + gap;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  return placed.map((node, index) => (node.x === nodes[index].x && node.y === nodes[index].y ? nodes[index] : node));
}

/**
 * Boxes moved apart so every arrow label fits between its boxes. A left–right arrow pushes every box at or right of
 * its far box further right; an up–down arrow pushes boxes at or below it down. Whole columns and rows move together,
 * so a board laid out in a grid stays a grid.
 */
export function spreadForLabels(nodes: PlanNode[], edges: PlanEdge[]): PlanNode[] {
  const placed = nodes.map((node) => ({ ...node }));
  const byId = new Map(placed.map((node) => [node.id, node]));
  const labelled = edges.filter((edge) => edge.text.trim());
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let moved = false;
    for (const edge of labelled) {
      const a = byId.get(edge.from);
      const b = byId.get(edge.to);
      if (!a || !b) continue;
      const dx = (b.x + b.w / 2) - (a.x + a.w / 2);
      const dy = (b.y + b.h / 2) - (a.y + a.h / 2);
      if (Math.abs(dx) >= Math.abs(dy)) {
        const [left, right] = dx >= 0 ? [a, b] : [b, a];
        const deficit = labelWidth(edge.text) - (right.x - (left.x + left.w));
        if (deficit <= 0) continue;
        const from = right.x;
        for (const node of placed) if (node !== left && node.x >= from) node.x += deficit;
        moved = true;
      } else {
        const [top, bottom] = dy >= 0 ? [a, b] : [b, a];
        const deficit = labelHeight(edge.text) - (bottom.y - (top.y + top.h));
        if (deficit <= 0) continue;
        const from = bottom.y;
        for (const node of placed) if (node !== top && node.y >= from) node.y += deficit;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return placed;
}

type Point = [number, number];
type Side = 'left' | 'right' | 'top' | 'bottom';
/** An arrow's start (absolute) and its points relative to it, as Excalidraw stores them. */
export type ArrowRoute = { x: number; y: number; points: Point[] };

// Bends sit this far off the box, so the slanted stretch stays short and the label lands on the straight part.
const BEND_PX = 20;
// Below this the two ends are treated as level and the arrow stays straight.
const LEVEL_PX = 8;
// A label is about this tall above and below its line; a stretch must clear other boxes by it.
const LABEL_CLEARANCE_PX = 18;
// Half the distance between a two-way pair's lines, so their labels (about 25px tall) do not touch.
const PAIR_HALF_GAP_PX = 17;

/**
 * How every arrow runs. Arrows leaving (or reaching) the same side of a box get their own points spread along that
 * side, in the order of the boxes at their other end, so a fan of arrows does not start from one spot and a two-way
 * pair runs as two parallel lines. An arrow whose ends are not level gets two bends: it turns right off the box and
 * runs straight at the far box's level (or its own, if that row has boxes in the way), so its label sits on a
 * straight stretch of its own instead of where the fan's lines cross.
 */
export function routeArrows(nodes: PlanNode[], edges: PlanEdge[]): Map<string, ArrowRoute> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const center = (node: PlanNode): Point => [node.x + node.w / 2, node.y + node.h / 2];
  type Leg = { edge: PlanEdge; index: number; from: PlanNode; to: PlanNode; horizontal: boolean; fromSide: Side; toSide: Side };
  const legs: Leg[] = edges.flatMap((edge, index) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return [];
    const [fx, fy] = center(from);
    const [tx, ty] = center(to);
    const horizontal = Math.abs(tx - fx) >= Math.abs(ty - fy);
    const fromSide: Side = horizontal ? (tx >= fx ? 'right' : 'left') : (ty >= fy ? 'bottom' : 'top');
    const opposite: Record<Side, Side> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
    return [{ edge, index, from, to, horizontal, fromSide, toSide: opposite[fromSide] }];
  });

  // Every arrow end on each side of each box, ordered along that side by where the other box is.
  const ends = new Map<string, Array<{ leg: Leg; other: PlanNode }>>();
  const addEnd = (box: PlanNode, side: Side, leg: Leg, other: PlanNode) => {
    const key = `${box.id}:${side}`;
    ends.set(key, [...(ends.get(key) ?? []), { leg, other }]);
  };
  for (const leg of legs) {
    addEnd(leg.from, leg.fromSide, leg, leg.to);
    addEnd(leg.to, leg.toSide, leg, leg.from);
  }
  const anchor = (box: PlanNode, side: Side, leg: Leg): Point => {
    const list = [...(ends.get(`${box.id}:${side}`) ?? [])];
    const along = (other: PlanNode) => (side === 'left' || side === 'right' ? center(other)[1] : center(other)[0]);
    list.sort((a, b) => along(a.other) - along(b.other) || a.leg.index - b.leg.index);
    const share = (list.findIndex((item) => item.leg === leg) + 1) / (list.length + 1);
    if (side === 'left') return [box.x, box.y + box.h * share];
    if (side === 'right') return [box.x + box.w, box.y + box.h * share];
    if (side === 'top') return [box.x + box.w * share, box.y];
    return [box.x + box.w * share, box.y + box.h];
  };

  // A straight stretch at `level` from a to b that runs through no box but the arrow's own two.
  const clear = (leg: Leg, horizontal: boolean, level: number, a: number, b: number) => nodes.every((box) => {
    if (box === leg.from || box === leg.to) return true;
    const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
    return horizontal
      ? !(box.x < hi && box.x + box.w > lo && level > box.y - LABEL_CLEARANCE_PX && level < box.y + box.h + LABEL_CLEARANCE_PX)
      : !(box.y < hi && box.y + box.h > lo && level > box.x - LABEL_CLEARANCE_PX && level < box.x + box.w + LABEL_CLEARANCE_PX);
  });

  // Two-way pairs with a label: their straight stretches go one above (or left of) the other, a label's height apart.
  const pairKey = (leg: Leg) => [leg.from.id, leg.to.id].sort().join('|');
  const pairs = new Map<string, Leg[]>();
  for (const leg of legs) pairs.set(pairKey(leg), [...(pairs.get(pairKey(leg)) ?? []), leg]);
  const pairLane = (leg: Leg, start: Point, end: Point): number | null => {
    const pair = pairs.get(pairKey(leg)) ?? [];
    if (pair.length < 2 || !pair.some((item) => item.edge.text.trim())) return null;
    const across = leg.horizontal ? 1 : 0;
    const middle = (start[across] + end[across]) / 2;
    const first = pair.reduce((low, item) => (item.index < low.index ? item : low), pair[0]);
    return middle + (leg === first ? -1 : 1) * PAIR_HALF_GAP_PX;
  };

  const routes = new Map<string, ArrowRoute>();
  for (const leg of legs) {
    const start = anchor(leg.from, leg.fromSide, leg);
    const end = anchor(leg.to, leg.toSide, leg);
    const relative = (points: Point[]): ArrowRoute => ({
      x: start[0],
      y: start[1],
      points: points.map(([px, py]) => [Math.round(px - start[0]), Math.round(py - start[1])]),
    });
    const along = leg.horizontal ? 0 : 1;
    const across = leg.horizontal ? 1 : 0;
    const level = Math.abs(end[across] - start[across]) < LEVEL_PX;
    const room = Math.abs(end[along] - start[along]) > BEND_PX * 3;
    let path: Point[] = [start, end];
    const pinned = pairLane(leg, start, end);
    if ((!level || pinned !== null) && room) {
      const dir = Math.sign(end[along] - start[along]);
      const a = start[along] + dir * BEND_PX;
      const b = end[along] - dir * BEND_PX;
      const candidates = pinned !== null ? [pinned] : [end[across], start[across]];
      const lane = candidates.find((value) => clear(leg, leg.horizontal, value, a, b));
      if (lane !== undefined) {
        const at = (alongValue: number): Point => (leg.horizontal ? [alongValue, lane] : [lane, alongValue]);
        path = [start, at(a), at(b), end];
      }
    }
    routes.set(leg.edge.id, relative(path));
  }
  return routes;
}

export type BoardChange ={ added: string[]; changed: string[]; removed: string[] };

/** Boxes the AI added, changed (text, place or size) or took away, by id. */
export function diffNodes(before: PlanNode[], after: PlanNode[]): BoardChange {
  const old = new Map(before.map((node) => [node.id, node]));
  const added: string[] = [];
  const changed: string[] = [];
  for (const node of after) {
    const prior = old.get(node.id);
    if (!prior) added.push(node.id);
    else if (prior.text.trim() !== node.text.trim() || prior.x !== node.x || prior.y !== node.y || prior.w !== node.w || prior.h !== node.h) changed.push(node.id);
  }
  const kept = new Set(after.map((node) => node.id));
  const removed = before.filter((node) => !kept.has(node.id)).map((node) => node.id);
  return { added, changed, removed };
}

/** Boxes with no arrow in or out; a board of one box has none worth pointing out. */
export function unconnected(nodes: PlanNode[], edges: PlanEdge[]): PlanNode[] {
  if (nodes.length < 2) return [];
  const linked = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  return nodes.filter((node) => !linked.has(node.id));
}
