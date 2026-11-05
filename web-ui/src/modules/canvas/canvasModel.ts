import type { ChatMessage } from '@/shared/types';

/**
 * DHC CLI 10/29 畫布 (after Gemini Canvas): the deliverables a conversation produced — HTML, SVG and Markdown files
 * Claude wrote, and ```html blocks in its replies — each with every version, so the panel can show the latest live
 * and step back through the earlier ones. Built from the transcript alone; a file first touched by Edit (it existed
 * before this conversation) has no known start, so its versions are worked out backwards from the file as it is now.
 */
export type CanvasKind = 'html' | 'svg' | 'md';

export type CanvasVersion = {
  /** null: not known yet (needs the file's current content) or not recoverable. */
  content: string | null;
  /** Where in the transcript this version came from (the tool call or the reply). */
  messageKey: string;
};

export type CanvasDoc = {
  /** `file:<path>` or `fence` (the conversation's ```html blocks share one document). */
  id: string;
  kind: CanvasKind;
  title: string;
  /** Absolute file path, absent for ```html blocks. */
  path?: string;
  versions: CanvasVersion[];
  /** Set when some version can only be worked out from the file's current content. */
  needsCurrent?: boolean;
};

type EditOp = { old: string; next: string; all: boolean };
type FileOp = { kind: 'write'; content: string; key: string } | { kind: 'edit'; edits: EditOp[]; key: string };

const KIND_BY_EXT: Record<string, CanvasKind> = { html: 'html', htm: 'html', svg: 'svg', md: 'md', markdown: 'md' };
/** Kinds that open the panel by themselves; Markdown is everywhere (notes, memory, checkpoints) so it waits to be picked. */
export const AUTO_OPEN_KINDS: ReadonlySet<CanvasKind> = new Set(['html', 'svg']);
const MIN_FENCE_CHARS = 120;
const FENCE = /```(?:html|htm)[^\S\n]*\n([\s\S]*?)```/gi;

export function kindOfPath(path: string): CanvasKind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return ext ? KIND_BY_EXT[ext] ?? null : null;
}

const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

export function titleOf(content: string | null, fallback: string): string {
  const title = content ? /<title[^>]*>([^<]{1,80})<\/title>/i.exec(content)?.[1]?.trim() : '';
  if (title) return title;
  const heading = content ? /^#\s+(.{1,80})$/m.exec(content)?.[1]?.trim() : '';
  return heading || fallback;
}

/** One Edit on known content; null when the text to replace is not there (the file changed some other way). */
export function applyEdit(content: string, edit: EditOp): string | null {
  if (!edit.old) return null;
  if (!content.includes(edit.old)) return null;
  return edit.all ? content.split(edit.old).join(edit.next) : content.replace(edit.old, () => edit.next);
}

/**
 * The same Edit undone: the content before it, given the content after it. Only when the new text appears once:
 * with more copies there is no telling which one the Edit made (a replace_all can't be told from copies that were
 * already there either), and a wrong old version is worse than "not recoverable".
 */
export function undoEdit(content: string, edit: EditOp): string | null {
  if (!edit.next || edit.all) return null;
  if (content.split(edit.next).length !== 2) return null;
  return content.replace(edit.next, () => edit.old);
}

function editsOf(toolName: string, input: Record<string, unknown>): EditOp[] | null {
  if (toolName === 'Edit') {
    return [{ old: String(input.old_string ?? ''), next: String(input.new_string ?? ''), all: Boolean(input.replace_all) }];
  }
  if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.map((edit) => {
      const item = (edit ?? {}) as Record<string, unknown>;
      return { old: String(item.old_string ?? ''), next: String(item.new_string ?? ''), all: Boolean(item.replace_all) };
    });
  }
  return null;
}

/** A tool call's input; chat messages carry it as pretty-printed JSON text (useChatMessages). */
function inputOf(message: ChatMessage): Record<string, unknown> {
  const raw = message.toolInput;
  if (typeof raw !== 'string') return (raw ?? {}) as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

/** Whether a tool call changed the file: it has a result and the result is not an error (still waiting = not yet). */
function applied(message: ChatMessage): boolean {
  const result = message.toolResult as { isError?: boolean } | null | undefined;
  return Boolean(result) && !result?.isError;
}

/**
 * Versions of one file from its Write/Edit calls in order. Forward from the first Write; before any Write,
 * backwards from `current` (the file's content now), when given.
 */
export function resolveFileVersions(ops: FileOp[], current?: string | null): { versions: CanvasVersion[]; needsCurrent: boolean } {
  const versions: CanvasVersion[] = ops.map((op) => ({ content: null, messageKey: op.key }));
  let known: string | null = null;
  let firstKnown = -1;
  ops.forEach((op, index) => {
    if (op.kind === 'write') known = op.content;
    else if (known !== null) known = op.edits.reduce<string | null>((text, edit) => (text === null ? null : applyEdit(text, edit)), known);
    versions[index].content = known;
    if (known !== null && firstKnown === -1) firstKnown = index;
  });
  // Edits before a Write stay unknown: the file now is past that Write, so walking back can't reach them.
  if (firstKnown !== -1) return { versions, needsCurrent: false };
  if (current === undefined) return { versions, needsCurrent: true };
  if (current === null) return { versions, needsCurrent: false };
  // Only Edits: walk back from the file as it is now.
  let text: string | null = current;
  for (let index = ops.length - 1; index >= 0 && text !== null; index -= 1) {
    versions[index].content = text;
    const op = ops[index];
    text = op.kind === 'edit' ? [...op.edits].reverse().reduce<string | null>((value, edit) => (value === null ? null : undoEdit(value, edit)), text) : null;
  }
  return { versions, needsCurrent: false };
}

// Stable across pages of history being loaded above (an index is not).
const keyOf = (message: ChatMessage) => String(message.toolId ?? message.toolCallId ?? message.transcriptAnchorId ?? `t${new Date(message.timestamp).getTime()}`);

/** The conversation's canvas documents, newest-touched first. `currents` holds files' content now, by path. */
export function extractCanvases(messages: ChatMessage[], currents: ReadonlyMap<string, string | null> = new Map()): CanvasDoc[] {
  const fileOps = new Map<string, FileOp[]>();
  const lastTouch = new Map<string, number>();
  const fences: CanvasVersion[] = [];
  messages.forEach((message, index) => {
    if (message.isToolUse) {
      if (!message.toolName || !FILE_TOOLS.has(message.toolName) || !applied(message)) return;
      const input = inputOf(message);
      const path = typeof input.file_path === 'string' ? input.file_path : '';
      if (!path || !kindOfPath(path)) return;
      const key = keyOf(message);
      let op: FileOp | null = null;
      if (message.toolName === 'Write' && typeof input.content === 'string') op = { kind: 'write', content: input.content, key };
      else {
        const edits = editsOf(message.toolName, input);
        if (edits) op = { kind: 'edit', edits, key };
      }
      if (!op) return;
      const id = `file:${path}`;
      fileOps.set(id, [...(fileOps.get(id) ?? []), op]);
      lastTouch.set(id, index);
      return;
    }
    if (message.type !== 'assistant' || message.isToolUse || typeof message.content !== 'string') return;
    for (const match of message.content.matchAll(FENCE)) {
      const body = match[1].trim();
      if (body.length >= MIN_FENCE_CHARS && /<[a-z!]/i.test(body)) {
        fences.push({ content: body, messageKey: `${keyOf(message)}#${match.index ?? 0}` });
        lastTouch.set('fence', index);
      }
    }
  });

  const docs: CanvasDoc[] = [];
  for (const [id, ops] of fileOps) {
    const path = id.slice('file:'.length);
    const current = currents.has(path) ? currents.get(path) : undefined;
    const { versions, needsCurrent } = resolveFileVersions(ops, current);
    const latest = [...versions].reverse().find((version) => version.content !== null)?.content ?? null;
    docs.push({ id, kind: kindOfPath(path) as CanvasKind, title: titleOf(latest, baseName(path)), path, versions, ...(needsCurrent ? { needsCurrent } : {}) });
  }
  if (fences.length > 0) {
    docs.push({ id: 'fence', kind: 'html', title: titleOf(fences[fences.length - 1].content, '回覆裡的網頁'), versions: fences });
  }
  return docs.sort((a, b) => (lastTouch.get(b.id) ?? 0) - (lastTouch.get(a.id) ?? 0));
}

/** Each document's newest version, to tell a version made now from older history loaded above. */
export const newestKeys = (docs: CanvasDoc[]) => new Map(docs.map((doc) => [doc.id, doc.versions[doc.versions.length - 1]?.messageKey ?? '']));

/**
 * The document that should open by itself: an HTML/SVG file whose newest version is not the one in `before` and was
 * made in a message that is not older history loaded above (`fresh`, from keysNotAbove).
 * Blocks in replies don't open by themselves: they may be HTML Claude quoted from a page it read.
 */
export function docToAutoOpen(docs: CanvasDoc[], before: ReadonlyMap<string, string>, fresh?: ReadonlySet<string>): CanvasDoc | null {
  return docs.find((doc) => {
    if (doc.id === 'fence' || !AUTO_OPEN_KINDS.has(doc.kind)) return false;
    const newest = doc.versions[doc.versions.length - 1]?.messageKey ?? '';
    return newest !== (before.get(doc.id) ?? '') && (!fresh || fresh.has(newest));
  }) ?? null;
}

export const keySet = (messages: ChatMessage[]) => new Set(messages.map(keyOf));

/**
 * Keys of the messages from the first one already in `previousKeys` on: the transcript as it was plus what came at
 * the end (a tool call that was waiting and now has its result keeps its key and counts). What lies before that is
 * older history loaded above. When no message is known any more (the first turn's own message swapped for the
 * server's copy), all count: loading history never drops the messages already shown.
 */
export function keysNotAbove(messages: ChatMessage[], previousKeys: ReadonlySet<string>): Set<string> {
  const keys = messages.map(keyOf);
  const at = keys.findIndex((key) => previousKeys.has(key));
  return new Set(at === -1 ? keys : keys.slice(at));
}
