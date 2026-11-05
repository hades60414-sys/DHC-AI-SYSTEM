import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { GripHorizontal, StickyNote as StickyNoteIcon, Trash2, X } from 'lucide-react';

import { PersonAvatar } from '@/modules/user-avatar';
import {
  NOTE_COLORS,
  addNote,
  armNotePlacement,
  flushNote,
  keepMentioned,
  removeNote,
  updateNote,
  useChatMe,
  useNotePlacement,
  useNotesOn,
} from '@/shared/chatRoom';
import type { ChatContext, ChatRef, NoteColor, NoteTarget, StickyNote } from '@/shared/chatRoom';
import { useEscapeClose } from '@/shared/escapeStack';
import { cn } from '@/shared/utils';

import { InviteOffer, outsiders } from '@/modules/chat-room/ChatRoom';
import { RefInput, RefText, carriesRef, readDroppedRef, shortTime, usePerson } from '@/modules/chat-room/refs';

const PAPER: Record<NoteColor, string> = {
  yellow: 'bg-[#fff7c2] border-[#f0de7a] dark:bg-[#4a4320] dark:border-[#6b5f22]',
  pink: 'bg-[#ffe1ea] border-[#f5b3c6] dark:bg-[#4a2532] dark:border-[#6e3346]',
  blue: 'bg-[#dff0ff] border-[#a9d2f5] dark:bg-[#1f3448] dark:border-[#2d4d6b]',
  green: 'bg-[#e2f7e1] border-[#ade3aa] dark:bg-[#21402a] dark:border-[#2f5c3b]',
  purple: 'bg-[#eee6ff] border-[#cbb8f5] dark:bg-[#33284d] dark:border-[#4a3a70]',
};
const DOT: Record<NoteColor, string> = {
  yellow: 'bg-[#f5d94a]', pink: 'bg-[#f48fb1]', blue: 'bg-[#64b5f6]', green: 'bg-[#81c784]', purple: 'bg-[#b39ddb]',
};
const MIN_W = 120;
// 10/16: low enough for a one-line note (the header strip plus one line of text).
const MIN_H = 56;

type BoxProps = {
  note: StickyNote;
  left: number;
  top: number;
  context: ChatContext | null;
  /** Live drag/resize preview in screen pixels; the layer turns the final offset into stored coordinates. */
  onMove: (note: StickyNote, dx: number, dy: number) => void;
  autoEdit?: boolean;
  /** Whiteboard zoom: the paper is drawn at this scale; its size is stored at zoom 1. */
  scale?: number;
};

/**
 * Follows one pointer gesture on window. `done(false)` runs on release, `done(true)` when the system cancels it
 * (pointercancel, e.g. a phone scroll gesture takes over). The returned function drops the listeners without calling
 * anything, for unmount.
 */
function trackPointer(move: (e: PointerEvent) => void, done: (cancelled: boolean) => void): () => void {
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
  };
  const up = () => { stop(); done(false); };
  const cancel = () => { stop(); done(true); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  return stop;
}

/**
 * Pointer-drag helper: calls `onDrag` with the offset from where it started and `onEnd` with the last one. A
 * cancelled gesture (or an unmount) commits nothing; `onCancel` resets the preview.
 */
function useDrag(onDrag: (dx: number, dy: number) => void, onEnd: (dx: number, dy: number) => void, onCancel?: () => void) {
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);
  return (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    stopRef.current?.();
    const start = { x: event.clientX, y: event.clientY };
    let last = { dx: 0, dy: 0 };
    stopRef.current = trackPointer(
      (e) => {
        last = { dx: e.clientX - start.x, dy: e.clientY - start.y };
        onDrag(last.dx, last.dy);
      },
      (cancelled) => {
        stopRef.current = null;
        if (cancelled) onCancel?.(); else onEnd(last.dx, last.dy);
      },
    );
  };
}

/**
 * One sticky note: a paper card with its writer, a text with @ / @@ chips, drag by the top strip, resize from the
 * corner, five colours. Click the text to edit (anyone can); a session dragged onto it drops in as @@title.
 */
export function StickyNoteBox({ note, left, top, context, onMove, autoEdit, scale = 1 }: BoxProps) {
  const me = useChatMe();
  const author = usePerson(note.by);
  const [editing, setEditing] = useState(Boolean(autoEdit));
  const [offset, setOffset] = useState({ dx: 0, dy: 0 });
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [offer, setOffer] = useState<ChatRef[]>([]);
  // 11/01: a tap selects the note; on a touch screen (no hover) its colour dots and 刪除 show while it is selected.
  const [selected, setSelected] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selected) return undefined;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setSelected(false);
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [selected]);
  const refsAtEdit = useRef<ChatRef[]>(note.refs);
  useEffect(() => {
    if (autoEdit) justCreated = null;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const startMove = useDrag((dx, dy) => setOffset({ dx, dy }), (dx, dy) => {
    setOffset({ dx: 0, dy: 0 });
    if (dx || dy) onMove(note, dx, dy);
  }, () => setOffset({ dx: 0, dy: 0 }));
  const startResize = useDrag(
    (dx, dy) => setSize({ w: Math.max(MIN_W, note.w + dx / scale), h: Math.max(MIN_H, note.h + dy / scale) }),
    (dx, dy) => {
      setSize(null);
      if (dx || dy) updateNote(note.id, { w: Math.max(MIN_W, note.w + dx / scale), h: Math.max(MIN_H, note.h + dy / scale) });
    },
    () => setSize(null),
  );

  const startEdit = () => {
    refsAtEdit.current = note.refs;
    setEditing(true);
  };
  const finishEdit = () => {
    setEditing(false);
    flushNote(note.id);
    const before = new Set(refsAtEdit.current.map((ref) => `${ref.kind}:${ref.id}`));
    const added = note.refs.filter((ref) => !before.has(`${ref.kind}:${ref.id}`));
    setOffer(outsiders(context, added));
  };
  const drop = (ref: ChatRef) => {
    const text = `${note.text}${note.text && !note.text.endsWith(' ') ? ' ' : ''}${ref.kind === 'person' ? '@' : '@@'}${ref.label} `;
    updateNote(note.id, { text, refs: keepMentioned(text, [...note.refs, ref]) });
  };

  const w = size?.w ?? note.w;
  const h = size?.h ?? note.h;
  const mentionsMe = note.refs.some((ref) => ref.kind === 'person' && ref.id === me) && note.by !== me;

  return (
    <div
      ref={box}
      data-testid="sticky-note"
      data-note-id={note.id}
      onPointerDown={() => setSelected(true)}
      data-tutorial-tip="便利貼：點一下打字；@ 標記人、@@ 標記對話或白板；拖上方移動"
      className={cn(
        'group/note pointer-events-auto absolute flex flex-col rounded-md border shadow-[0_6px_18px_-6px_rgba(0,0,0,0.25)] transition-shadow hover:shadow-[0_10px_28px_-8px_rgba(0,0,0,0.35)]',
        PAPER[note.color],
        (offset.dx || offset.dy) && 'z-20 shadow-2xl',
        mentionsMe && 'ring-2 ring-rose-300/70',
      )}
      style={{ left: left + offset.dx, top: top + offset.dy, width: w, height: h, ...(scale !== 1 && { transform: `scale(${scale})`, transformOrigin: "0 0" }) }}
      onDragOver={(event) => {
        if (!carriesRef(event)) return;
        event.preventDefault();
      }}
      onDrop={(event) => {
        if (editing) return;
        const ref = readDroppedRef(event);
        if (!ref) return;
        event.preventDefault();
        drop(ref);
      }}
    >
      <div onPointerDown={startMove} className="flex cursor-grab touch-none items-center gap-1.5 rounded-t-md px-2 pb-0.5 pt-1.5 active:cursor-grabbing">
        <PersonAvatar person={author} className="h-4 w-4 text-[8px]" />
        <span className="min-w-0 truncate text-[11px] font-medium text-black/70 dark:text-white/80">{author.name}</span>
        <span className="shrink-0 text-[10px] text-black/40 dark:text-white/40">{shortTime(note.updatedAt)}</span>
        <GripHorizontal className="mx-auto h-3 w-3 shrink-0 text-black/20 opacity-0 transition group-hover/note:opacity-100 dark:text-white/30" />
        <span className={cn('flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover/note:opacity-100 [@media(pointer:coarse)]:gap-1.5', (selected || editing) && '[@media(pointer:coarse)]:opacity-100')}>
          {NOTE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`顏色 ${color}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => updateNote(note.id, { color })}
              className={cn('h-2.5 w-2.5 rounded-full ring-black/30 transition hover:scale-125 [@media(pointer:coarse)]:h-6 [@media(pointer:coarse)]:w-6', DOT[color], note.color === color && 'ring-1')}
            />
          ))}
          <button
            type="button"
            aria-label="刪除便利貼"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              if (note.by === me || window.confirm('這張便利貼是別人貼的，確定刪除？')) removeNote(note.id);
            }}
            className="ml-1 rounded p-0.5 text-black/40 hover:bg-black/10 hover:text-red-600 dark:text-white/50 [@media(pointer:coarse)]:p-2"
          >
            <Trash2 className="h-3 w-3 [@media(pointer:coarse)]:h-4 [@media(pointer:coarse)]:w-4" />
          </button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2 text-[13px] leading-relaxed text-black/85 dark:text-white/90" onClick={() => !editing && startEdit()}>
        {editing ? (
          <RefInput
            value={note.text}
            refs={note.refs}
            onChange={(text, refs) => updateNote(note.id, { text, refs })}
            autoFocus
            rows={3}
            placeholder="寫點什麼…"
            className="h-full"
            textareaClassName="h-full text-[13px] text-black/85 placeholder:text-black/35 dark:text-white/90 dark:placeholder:text-white/40"
          />
        ) : note.text ? (
          <RefText text={note.text} refs={note.refs} />
        ) : (
          <span className="text-black/35 dark:text-white/40">點這裡寫字…</span>
        )}
      </div>
      {editing && (
        <button
          type="button"
          onClick={finishEdit}
          className="absolute -bottom-3 right-8 rounded-full bg-foreground px-2 py-0.5 text-[10px] font-medium text-background shadow"
        >
          完成
        </button>
      )}
      {/* Resize from the corner: a faint grip at rest, clear on hover (10/16: the first one was too easy to miss). */}
      <div
        onPointerDown={startResize}
        title="拖這裡調整大小"
        data-testid="note-resize"
        className="absolute bottom-0 right-0 flex h-5 w-5 cursor-nwse-resize touch-none items-end justify-end rounded-br-md p-1 text-black/25 transition-colors hover:text-black/60 group-hover/note:text-black/45 dark:text-white/25 dark:hover:text-white/70 dark:group-hover/note:text-white/50"
      >
        <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" aria-hidden>
          <path d="M9 1 1 9M9 5 5 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </div>
      {offer.length > 0 && context && (
        <div className="absolute left-0 top-full mt-1.5 w-[max(100%,18rem)]">
          <InviteOffer context={context} people={offer} message={note.text} onDone={() => setOffer([])} />
        </div>
      )}
    </div>
  );
}

/** The dashed rectangle drawn while placing a new note; returns the drawn box (container pixels) on release. */
function PlacementOverlay({ onPlace, onCancel, hint }: { onPlace: (box: { x: number; y: number; w: number; h: number }) => void; onCancel: () => void; hint: string }) {
  const area = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  useEscapeClose(onCancel);
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);
  const down = (event: ReactPointerEvent) => {
    if (event.button !== 0 || !area.current) return;
    event.preventDefault();
    stopRef.current?.();
    const origin = area.current.getBoundingClientRect();
    const start = { x: event.clientX - origin.left, y: event.clientY - origin.top };
    let current = { x: start.x, y: start.y, w: 0, h: 0 };
    stopRef.current = trackPointer(
      (e) => {
        const x = e.clientX - origin.left;
        const y = e.clientY - origin.top;
        current = { x: Math.min(x, start.x), y: Math.min(y, start.y), w: Math.abs(x - start.x), h: Math.abs(y - start.y) };
        setRect(current);
      },
      (cancelled) => {
        stopRef.current = null;
        setRect(null);
        if (cancelled) return;
        // A click without a drag still gets a note of the usual size.
        onPlace(current.w < 40 || current.h < 30 ? { x: start.x, y: start.y, w: 220, h: 140 } : { ...current, w: Math.max(MIN_W, current.w), h: Math.max(MIN_H, current.h) });
      },
    );
  };
  return (
    <div ref={area} onPointerDown={down} data-testid="note-placement" className="absolute inset-0 z-30 cursor-crosshair touch-none bg-amber-200/10">
      <div className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full bg-foreground/90 px-3 py-1.5 text-xs text-background shadow-lg">
        <StickyNoteIcon className="h-3.5 w-3.5" />
        {hint}
        <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={onCancel} className="pointer-events-auto rounded-full p-0.5 hover:bg-background/20" aria-label="取消">
          <X className="h-3 w-3" />
        </button>
      </div>
      {rect && <div className="pointer-events-none absolute rounded-md border-2 border-dashed border-amber-500 bg-amber-200/30" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />}
    </div>
  );
}

const anchorsIn = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>('[data-jump-anchor]'));
/** An element's top in the scroll content's coordinates. */
const contentTop = (container: HTMLElement, el: HTMLElement) => el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;

/** Where a session note shows, in the scroll content's pixels. */
function placeOnSession(container: HTMLElement, note: Pick<StickyNote, 'anchor' | 'dy' | 'xFrac'>) {
  const anchor = note.anchor ? anchorsIn(container).find((el) => el.dataset.jumpAnchor === note.anchor) : null;
  return { left: Math.round((note.xFrac ?? 0.6) * container.clientWidth), top: (anchor ? contentTop(container, anchor) : 0) + (note.dy ?? 16) };
}

/** Content pixels → the prompt above that spot and how far below it, so the note stays with that part of the talk. */
function anchorOnSession(container: HTMLElement, x: number, y: number) {
  let anchor: HTMLElement | null = null;
  for (const el of anchorsIn(container)) {
    if (contentTop(container, el) <= y) anchor = el;
  }
  const base = anchor ? contentTop(container, anchor) : 0;
  return { anchor: anchor?.dataset.jumpAnchor, dy: y - base, xFrac: Math.min(0.95, Math.max(0, x / Math.max(1, container.clientWidth))) };
}

/** The note just drawn opens ready to type. */
let justCreated: string | null = null;

/**
 * The notes on a session, inside its transcript's scroll area. Each hangs from the prompt above it
 * (`data-jump-anchor`), so it stays beside the same part of the conversation as messages load or the window resizes.
 */
export function SessionNotesLayer({ sessionId, scrollContainerRef, context }: { sessionId: string | null | undefined; scrollContainerRef: RefObject<HTMLDivElement>; context: ChatContext | null }) {
  const notes = useNotesOn('session', sessionId);
  const [, setTick] = useState(0);

  // Re-measure when the transcript grows, rows hydrate or the window resizes.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || notes.length === 0) return undefined;
    const observer = new ResizeObserver(() => setTick((n) => n + 1));
    observer.observe(container);
    for (const child of Array.from(container.children)) observer.observe(child);
    setTick((n) => n + 1);
    return () => observer.disconnect();
  }, [scrollContainerRef, notes.length]);

  const container = scrollContainerRef.current;
  if (!sessionId || notes.length === 0 || !container) return null;

  return (
    <div className="pointer-events-none absolute left-0 right-0 top-0 z-20 h-0">
      {notes.map((note) => {
        const { left, top } = placeOnSession(container, note);
        const autoEdit = note.id === justCreated;
        return (
          <StickyNoteBox
            key={note.id}
            note={note}
            left={Math.min(left, Math.max(0, container.clientWidth - note.w - 8))}
            top={top}
            context={context}
            autoEdit={autoEdit}
            onMove={(moved, dx, dy) => {
              const at = placeOnSession(container, moved);
              updateNote(moved.id, anchorOnSession(container, at.left + dx, at.top + dy));
            }}
          />
        );
      })}
    </div>
  );
}

/** Over the visible transcript while 便利貼 is armed for this session: drag out the new note. */
export function SessionNotePlacement({ sessionId, title, scrollContainerRef }: { sessionId: string | null | undefined; title: string; scrollContainerRef: RefObject<HTMLDivElement> }) {
  const placing = useNotePlacement();
  const me = useChatMe();
  if (!sessionId || !me || placing?.kind !== 'session' || placing.id !== sessionId) return null;
  return (
    <PlacementOverlay
      hint="在對話上拉出便利貼的範圍（Esc 取消）"
      onCancel={() => armNotePlacement(null)}
      onPlace={(box) => {
        armNotePlacement(null);
        const container = scrollContainerRef.current;
        if (!container) return;
        const note = addNote({ target: { kind: 'session', id: sessionId, title }, by: me, text: '', refs: [], color: 'yellow', w: box.w, h: box.h, ...anchorOnSession(container, box.x, box.y + container.scrollTop) });
        justCreated = note.id;
      }}
    />
  );
}

type Viewport = { scrollX: number; scrollY: number; zoom: number };
/** The bit of Excalidraw's imperative API the notes need: where the view is, and word when it pans or zooms. */
export type BoardView = {
  getAppState: () => { scrollX: number; scrollY: number; zoom: { value: number } };
  onScrollChange: (callback: (scrollX: number, scrollY: number, zoom: { value: number }) => void) => () => void;
};

function useViewport(view: BoardView): Viewport {
  const read = () => {
    const app = view.getAppState();
    return { scrollX: app.scrollX, scrollY: app.scrollY, zoom: app.zoom.value };
  };
  const [viewport, setViewport] = useState<Viewport>(read);
  useEffect(() => view.onScrollChange((scrollX, scrollY, zoom) => setViewport({ scrollX, scrollY, zoom: zoom.value })), [view]);
  return viewport;
}

/**
 * The notes on a whiteboard. They live in scene coordinates and scale with the zoom, so they stay pinned to the
 * drawing like a sticker.
 */
export function BoardNotesLayer({ board, view, context }: { board: NoteTarget; view: BoardView; context: ChatContext | null }) {
  const viewport = useViewport(view);
  const notes = useNotesOn('board', board.id);
  const placing = useNotePlacement();
  const me = useChatMe();
  const isPlacing = placing?.kind === 'board' && placing.id === board.id;
  const toScreen = (x: number, y: number) => ({ left: (x + viewport.scrollX) * viewport.zoom, top: (y + viewport.scrollY) * viewport.zoom });
  const toScene = (left: number, top: number) => ({ x: left / viewport.zoom - viewport.scrollX, y: top / viewport.zoom - viewport.scrollY });

  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
      {notes.map((note) => {
        const { left, top } = toScreen(note.x ?? 0, note.y ?? 0);
        return (
          <StickyNoteBox
            key={note.id}
            note={note}
            left={left}
            top={top}
            context={context}
            autoEdit={note.id === justCreated}
            scale={viewport.zoom}
            onMove={(moved, dx, dy) => {
              const at = toScreen(moved.x ?? 0, moved.y ?? 0);
              updateNote(moved.id, toScene(at.left + dx, at.top + dy));
            }}
          />
        );
      })}
      {isPlacing && me && (
        <div className="pointer-events-auto absolute inset-0">
          <PlacementOverlay
            hint="在白板上拉出便利貼的範圍（Esc 取消）"
            onCancel={() => armNotePlacement(null)}
            onPlace={(box) => {
              armNotePlacement(null);
              const note = addNote({ target: board, by: me, text: '', refs: [], color: 'yellow', w: box.w / viewport.zoom, h: box.h / viewport.zoom, ...toScene(box.x, box.y) });
              justCreated = note.id;
            }}
          />
        </div>
      )}
    </div>
  );
}

/** 便利貼 next to the beaker: arms placement on the open session (or whiteboard); press again to cancel. */
export function NoteButton({ target, className }: { target: NoteTarget | null; className?: string }) {
  const placing = useNotePlacement();
  const me = useChatMe();
  const active = Boolean(target && placing?.id === target.id);
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label="新增便利貼"
      data-tutorial-tip="便利貼：點一下，在畫面上拉出一個框來寫備忘"
      title={!target ? '先打開一個對話才能貼便利貼' : !me ? '先在設定選好你的專案設定' : '新增便利貼：拉出一個框，可以打字、@ 標記人、@@ 標記對話或白板'}
      disabled={!target || !me}
      onClick={() => armNotePlacement(active ? null : target)}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40',
        active && 'bg-amber-400/20 text-amber-600 dark:text-amber-300',
        className,
      )}
    >
      <StickyNoteIcon className="h-4 w-4" />
    </button>
  );
}
