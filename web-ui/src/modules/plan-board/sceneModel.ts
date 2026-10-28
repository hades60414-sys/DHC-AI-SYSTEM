import { BOARD_MODES } from '@/modules/plan-board/boardModes';
import { BOX_HEIGHT, BOX_WIDTH } from '@/shared/planBoards';
import type { PlanChatMessage, PlanEdge, PlanNode } from '@/shared/planBoards';

/**
 * DHC CLI 10/13 規劃白板: what the AI and 開工 understand of an Excalidraw scene. Shapes (rectangle, ellipse,
 * diamond) with their label are boxes; arrows bound at both ends to boxes are connections; free text is a note;
 * freehand strokes and loose lines are only counted. The AI redraws boxes and connections; everything else on the
 * canvas stays as drawn.
 */

/** The element fields read here; the canvas keeps every other field as Excalidraw wrote it. */
export type SceneElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  text?: string;
  containerId?: string | null;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  roughness?: number;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  boundElements?: ReadonlyArray<{ id: string; type: string }> | null;
};

const SHAPES = new Set(['rectangle', 'ellipse', 'diamond']);
// Excalidraw's black and the board's grey default are plain lines, not a colour someone chose.
const PLAIN_STROKES = new Set(['#1e1e1e', '#868e96']);

export type ScenePlan = {
  nodes: PlanNode[];
  edges: PlanEdge[];
  /** Free text on the canvas, top to bottom. */
  notes: string[];
  /** Freehand strokes and loose lines or arrows, which only a person can read. */
  sketches: number;
  colors: Map<string, { stroke?: string; fill?: string }>;
};

const clean = (text: string) => text.trim().replace(/\s+/g, ' ');

export function sceneToPlan(all: ReadonlyArray<SceneElement>): ScenePlan {
  const elements = all.filter((element) => !element.isDeleted);
  const labelOf = new Map<string, string>();
  for (const element of elements) {
    if (element.type === 'text' && element.containerId) labelOf.set(element.containerId, element.text ?? '');
  }
  const shapes = elements.filter((element) => SHAPES.has(element.type));
  const shapeIds = new Set(shapes.map((shape) => shape.id));
  const nodes: PlanNode[] = shapes.map((shape) => ({
    id: shape.id,
    x: Math.round(shape.x),
    y: Math.round(shape.y),
    w: Math.round(shape.width),
    h: Math.round(shape.height),
    text: labelOf.get(shape.id) ?? '',
  }));
  const colors = new Map<string, { stroke?: string; fill?: string }>();
  for (const shape of shapes) {
    const stroke = shape.strokeColor && !PLAIN_STROKES.has(shape.strokeColor) ? shape.strokeColor : undefined;
    const fill = shape.backgroundColor && shape.backgroundColor !== 'transparent' ? shape.backgroundColor : undefined;
    if (stroke || fill) colors.set(shape.id, { stroke, fill });
  }
  const edges: PlanEdge[] = [];
  let sketches = 0;
  for (const element of elements) {
    if (element.type === 'arrow') {
      const from = element.startBinding?.elementId;
      const to = element.endBinding?.elementId;
      if (from && to && shapeIds.has(from) && shapeIds.has(to) && from !== to) {
        edges.push({ id: element.id, from, to, text: labelOf.get(element.id) ?? '' });
      } else {
        sketches += 1;
      }
    } else if (element.type === 'freedraw' || element.type === 'line') {
      sketches += 1;
    }
  }
  const notes = elements
    .filter((element) => element.type === 'text' && !element.containerId && clean(element.text ?? ''))
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((element) => clean(element.text ?? ''));
  return { nodes, edges, notes, sketches, colors };
}

/** Ids the AI owns when it redraws: boxes, their labels, bound arrows and the arrows' labels. */
export function redrawnIds(all: ReadonlyArray<SceneElement>, plan: ScenePlan): Set<string> {
  const owned = new Set<string>([...plan.nodes.map((node) => node.id), ...plan.edges.map((edge) => edge.id)]);
  for (const element of all) {
    if (element.type === 'text' && element.containerId && owned.has(element.containerId)) owned.add(element.id);
  }
  return owned;
}

type Skeleton = Record<string, unknown>;

/**
 * The AI's boxes and arrows as Excalidraw skeletons. A box the AI kept (same id) keeps its shape and colours; new
 * ones are plain rectangles.
 */
export function planToSkeletons(nodes: PlanNode[], edges: PlanEdge[], previous: ReadonlyArray<SceneElement>): Skeleton[] {
  const before = new Map(previous.map((element) => [element.id, element]));
  const style = (element: SceneElement | undefined) => (element ? {
    strokeColor: element.strokeColor,
    backgroundColor: element.backgroundColor,
    fillStyle: element.fillStyle,
    strokeWidth: element.strokeWidth,
    strokeStyle: element.strokeStyle,
    roughness: element.roughness,
  } : {});
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const boxes: Skeleton[] = nodes.map((node) => {
    const old = before.get(node.id);
    return {
      type: old && SHAPES.has(old.type) ? old.type : 'rectangle',
      id: node.id,
      x: node.x,
      y: node.y,
      width: node.w || BOX_WIDTH,
      height: node.h || BOX_HEIGHT,
      ...style(old),
      ...(node.text.trim() ? { label: { text: node.text } } : {}),
    };
  });
  const arrows: Skeleton[] = edges.flatMap((edge) => {
    const from = byId.get(edge.from);
    if (!from) return [];
    const old = before.get(edge.id);
    return [{
      type: 'arrow',
      id: edge.id,
      x: from.x + from.w,
      y: from.y + from.h / 2,
      start: { id: edge.from },
      end: { id: edge.to },
      ...(old ? { strokeColor: old.strokeColor, strokeWidth: old.strokeWidth, strokeStyle: old.strokeStyle } : {}),
      ...(edge.text.trim() ? { label: { text: edge.text } } : {}),
    }];
  });
  return [...boxes, ...arrows];
}

const COLOR_NAMES: Record<string, string> = {
  '#e03131': '紅', '#ffc9c9': '淺紅', '#2f9e44': '綠', '#b2f2bb': '淺綠', '#1971c2': '藍', '#a5d8ff': '淺藍',
  '#f08c00': '橘', '#ffec99': '淺黃', '#6741d9': '紫', '#d0bfff': '淺紫', '#868e96': '灰', '#e9ecef': '淺灰',
  '#c2255c': '桃紅', '#fcc2d7': '淺粉', '#0c8599': '青', '#99e9f2': '淺青', '#ffffff': '白', '#1e1e1e': '黑',
  '#f59f00': '黃', '#3b5bdb': '靛', '#846358': '棕', '#ffd8a8': '淺橘', '#bac8ff': '淺靛', '#ced4da': '灰',
  '#ff8787': '紅', '#ffa94d': '橘', '#ffd43b': '黃', '#69db7c': '綠', '#3bc9db': '青', '#4dabf7': '藍',
  '#748ffc': '靛', '#9775fa': '紫', '#f783ac': '粉', '#adb5bd': '灰',
};
// A fill may carry transparency ('#rrggbbaa'); the name is the colour's.
const colorName = (hex: string) => COLOR_NAMES[hex.toLowerCase().slice(0, 7)] ?? hex;

/** The brief a new session gets when 開工 is pressed: every box, arrow and note, and what was asked in the chat. */
export function boardBrief(
  name: string,
  plan: ScenePlan,
  chat: PlanChatMessage[],
  mode: { briefLead: (name: string) => string; briefAsk: string } = BOARD_MODES.free,
): string {
  const label = (node: PlanNode) => {
    const text = clean(node.text) || '（空白方框）';
    const color = plan.colors.get(node.id);
    const tags = [color?.fill && `底色${colorName(color.fill)}`, color?.stroke && `框線${colorName(color.stroke)}`].filter(Boolean);
    return tags.length > 0 ? `${text}〔${tags.join('、')}〕` : text;
  };
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  // Reading order: top to bottom, then left to right.
  const ordered = [...plan.nodes].sort((a, b) => (Math.abs(a.y - b.y) > BOX_HEIGHT / 2 ? a.y - b.y : a.x - b.x));
  const lines = [mode.briefLead(name)];
  if (ordered.length > 0) lines.push('', '方框：', ...ordered.map((node) => `- ${label(node)}`));
  if (plan.edges.length > 0) {
    lines.push('', '連線（箭頭方向）：');
    for (const edge of plan.edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) continue;
      lines.push(`- ${clean(from.text) || '（空白方框）'} → ${clean(to.text) || '（空白方框）'}${clean(edge.text) ? `（${clean(edge.text)}）` : ''}`);
    }
  }
  if (plan.notes.length > 0) lines.push('', '白板上的文字註記：', ...plan.notes.map((note) => `- ${note}`));
  if (plan.colors.size > 0) lines.push('', '方框的顏色是我用來分類或標重點的，看不出意思就問我。');
  if (plan.sketches > 0) lines.push('', `白板上另有 ${plan.sketches} 筆手繪或沒接到方框的線，文字說明不到，需要的話請我描述。`);
  const asked = chat.filter((message) => message.role === 'user').slice(-8);
  if (asked.length > 0) lines.push('', '規劃時我在白板對話框說過：', ...asked.map((message) => `- ${clean(message.text)}`));
  lines.push('', mode.briefAsk);
  return lines.join('\n');
}

type Point = readonly [number, number];
/** Mostly left–right (else up–down), from the first to the last point. */
export function isHorizontal(points: ReadonlyArray<Point>): boolean {
  const first = points[0] ?? [0, 0];
  const last = points[points.length - 1] ?? first;
  return Math.abs(last[0] - first[0]) >= Math.abs(last[1] - first[1]);
}

/**
 * Arrowheads that make a line point the way it looks on screen — 'forward' is right (or down for an up–down line),
 * 'back' is left (or up) — whichever end was drawn first. 'none' is a plain line, 'both' a two-way arrow.
 */
export function arrowheadsFor(direction: 'none' | 'back' | 'forward' | 'both', points: ReadonlyArray<Point>) {
  if (direction === 'none') return { startArrowhead: null, endArrowhead: null };
  if (direction === 'both') return { startArrowhead: 'arrow', endArrowhead: 'arrow' };
  const first = points[0] ?? [0, 0];
  const last = points[points.length - 1] ?? first;
  const endIsForward = isHorizontal(points) ? last[0] >= first[0] : last[1] >= first[1];
  const headAtEnd = (direction === 'forward') === endIsForward;
  return headAtEnd ? { startArrowhead: null, endArrowhead: 'arrow' } : { startArrowhead: 'arrow', endArrowhead: null };
}

/** '#rrggbbaa' → base '#rrggbb' and 0–100. */
export function splitAlpha(color: string): { base: string; alpha: number } {
  if (/^#[0-9a-f]{8}$/i.test(color)) return { base: color.slice(0, 7), alpha: Math.round((parseInt(color.slice(7), 16) / 255) * 100) };
  return { base: color, alpha: 100 };
}

export function withAlpha(base: string, alpha: number): string {
  if (base === 'transparent' || alpha >= 100) return base;
  return `${base}${Math.round((Math.max(0, alpha) / 100) * 255).toString(16).padStart(2, '0')}`;
}
