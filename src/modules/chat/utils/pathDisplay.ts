/**
 * DHC CLI UI night 3: tool rows used to print whole Windows paths, which truncated to the useless head
 * ("C:\Users\demo\DHC Workspace\…"). Show the file name first and only the last two folders,
 * dimmed; the full path stays in the tooltip. Splits on both separators, so it also works for POSIX paths.
 */
export function splitPathForDisplay(value: string): { name: string; parentHint: string } {
  const parts = value.split(/[\\/]/).filter(Boolean);
  const name = parts.pop() || value;
  const parentHint = parts.length > 0 ? `${parts.length > 2 ? '…/' : ''}${parts.slice(-2).join('/')}` : '';
  return { name, parentHint };
}

/** True when a tool title looks like a path rather than a command or free text. */
export function looksLikePath(value: string): boolean {
  return /^(?:[A-Za-z]:)?[\\/]/.test(value) || /^[^\s]+[\\/][^\s]+$/.test(value);
}
