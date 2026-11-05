import type { ChatRef } from '@/shared/chatRoom';
import type { PlanLink, PlanNode } from '@/shared/planBoards';

/** What a linked whiteboard box keeps in its customData (10/19 規劃白板 @@ in a box). Kept free of Excalidraw so it tests in node. */

export type LinkKind = 'session' | 'board';

// The chat room's colours: violet for a conversation, green for a whiteboard (light paper, the theme inverts it).
const LINK_COLORS: Record<LinkKind, { backgroundColor: string; strokeColor: string }> = {
  session: { backgroundColor: '#e5dbff', strokeColor: '#7048e8' },
  board: { backgroundColor: '#c3fae8', strokeColor: '#0ca678' },
};

export function linkOf(element: { customData?: Record<string, unknown> }): ChatRef | null {
  const raw = element.customData?.dhcRef as Partial<ChatRef> | undefined;
  if (!raw || (raw.kind !== 'session' && raw.kind !== 'board') || typeof raw.id !== 'string' || typeof raw.label !== 'string') return null;
  return { kind: raw.kind, id: raw.id, label: raw.label };
}

/** The patch that links a box: the reference plus the chat room's fill and line. */
export function linkPatch(element: { customData?: Record<string, unknown> }, ref: ChatRef) {
  const colors = LINK_COLORS[ref.kind as LinkKind];
  return { customData: { ...element.customData, dhcRef: ref }, fillStyle: 'solid', ...colors };
}

/**
 * The AI's links checked against what @@ offers (`linkables`): a link to anything else is dropped, so the box keeps
 * the link it had; a kept one takes its label from the list. null (unlink) passes through.
 */
export function acceptLinks(nodes: PlanNode[], linkables: ReadonlyArray<PlanLink>): PlanNode[] {
  const known = new Map(linkables.map((ref) => [`${ref.kind}:${ref.id}`, ref]));
  return nodes.map((node) => {
    if (!node.link) return node;
    const ref = known.get(`${node.link.kind}:${node.link.id}`);
    if (ref) return { ...node, link: { kind: ref.kind, id: ref.id, label: ref.label } };
    const { link: _dropped, ...rest } = node;
    return rest;
  });
}
