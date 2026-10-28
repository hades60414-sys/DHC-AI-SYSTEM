/**
 * DHC CLI 10/14 工具庫串接: one tool hands something to another (試算工作台的表 → 文件共編, 白板 → 專案板…).
 * The sender calls sendToTool; the page (ProjectWishPool) closes the sender and opens the receiver, which takes
 * the waiting handoff once its own data has loaded. Lives in memory only: a reload drops an untaken handoff.
 */
export type ToolHandoff = {
  /** Receiving tool id (src/modules/tool-library/catalog.ts). */
  tool: string;
  /** What is being handed over; each receiver documents the kinds it accepts. */
  kind: string;
  payload: unknown;
  /** Shown by the receiver, e.g. 「來自 試算工作台『部位』」. */
  from: string;
};

let pending: ToolHandoff | null = null;
const listeners = new Set<(handoff: ToolHandoff) => void>();

export function sendToTool(handoff: ToolHandoff): void {
  pending = handoff;
  listeners.forEach((listener) => listener(handoff));
}

/** The handoff waiting for this tool, once; null when there is none. */
export function takeHandoff(tool: string): ToolHandoff | null {
  if (!pending || pending.tool !== tool) return null;
  const handoff = pending;
  pending = null;
  return handoff;
}

/** Called when a tool sends something, so the page can open the receiver; returns the cleanup. */
export function onToolHandoff(listener: (handoff: ToolHandoff) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
