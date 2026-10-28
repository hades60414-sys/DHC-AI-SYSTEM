/**
 * DHC CLI 10/13: a message that should be sent as the first turn of the next new chat in a project (規劃白板
 * 「開工」). The board opens the new chat; the chat sends it once it is the empty conversation of that project.
 * Lives only in this page: a reload drops it rather than sending it somewhere unexpected later.
 */
let pending: { projectId: string; prompt: string } | null = null;

export function queueAutoStart(projectId: string, prompt: string): void {
  pending = { projectId, prompt };
}

/** Returns the waiting prompt for this project once, then forgets it. */
export function takeAutoStart(projectId: string | undefined): string | null {
  if (!pending || !projectId || pending.projectId !== projectId) return null;
  const { prompt } = pending;
  pending = null;
  return prompt;
}
