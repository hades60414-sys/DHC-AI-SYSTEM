import type { PlanEdge, PlanNode } from '@/shared/planBoards';

/** 規劃白板 -> 專案板: whiteboard boxes become cards (the payload of a 'cards' handoff). */
export type BoardCard = { id: string; title: string; note: string; dependsOn: string[] };

const BOX_ROW = 40;

/**
 * Cards in work order: a box comes after the boxes arrows lead into it. Ties, boxes in a cycle and unconnected boxes
 * follow reading order (top to bottom, then left to right). dependsOn lists the arrows' predecessors, minus any
 * arrow that closes a cycle (it would point at a card that comes later).
 */
export function boardToCards(nodes: PlanNode[], edges: PlanEdge[]): BoardCard[] {
  const reading = [...nodes].sort((a, b) => (Math.abs(a.y - b.y) > BOX_ROW ? a.y - b.y : a.x - b.x));
  const ids = new Set(nodes.map((node) => node.id));
  const preds = new Map<string, Set<string>>(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    if (ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to) preds.get(edge.to)?.add(edge.from);
  }
  const placed: PlanNode[] = [];
  const done = new Set<string>();
  const remaining = [...reading];
  while (remaining.length > 0) {
    // First box in reading order whose predecessors are all placed; none (a cycle) -> first in reading order.
    let index = remaining.findIndex((node) => [...(preds.get(node.id) ?? [])].every((id) => done.has(id)));
    if (index < 0) index = 0;
    const [next] = remaining.splice(index, 1);
    placed.push(next);
    done.add(next.id);
  }
  const rank = new Map(placed.map((node, position) => [node.id, position]));
  // Empty boxes (layout spacers, half-drawn shapes) are not work; they are left out, and so are arrows to them.
  const blank = new Set(nodes.filter((node) => !node.text.trim()).map((node) => node.id));
  return placed.filter((node) => !blank.has(node.id)).map((node) => {
    const [first = '', ...rest] = node.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return {
      id: node.id,
      title: first || '（空白方框）',
      note: rest.join('\n'),
      dependsOn: [...(preds.get(node.id) ?? [])].filter((id) => !blank.has(id) && (rank.get(id) ?? 0) < (rank.get(node.id) ?? 0)),
    };
  });
}
