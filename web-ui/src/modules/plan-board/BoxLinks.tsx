import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaptureUpdateAction, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { ArrowUpRight, X } from 'lucide-react';

import { RefIcon, REF_STYLE, ensureBoards, queryAt, useRefCandidates } from '@/modules/chat-room';
import { useChatMe } from '@/shared/chatRoom';
import type { ChatRef } from '@/shared/chatRoom';
import { cn } from '@/shared/utils';
import { linkOf, linkPatch } from '@/modules/plan-board/boxLinkData';
import type { LinkKind } from '@/modules/plan-board/boxLinkData';

/**
 * DHC CLI 10/19 規劃白板: typing @@ inside a box links it to a conversation or whiteboard. The box takes the title as
 * its text and the chat room's colours, and a small tab on its top edge jumps there. The link lives in the box's
 * customData, so it saves and syncs with the drawing.
 */

const BOXES = new Set(['rectangle', 'ellipse', 'diamond']);
const TAB_TEXT: Record<LinkKind, string> = { session: '對話', board: '白板' };

type Element = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  containerId?: string | null;
  customData?: Record<string, unknown>;
};

function unlinkPatch(element: { customData?: Record<string, unknown> }) {
  const { dhcRef: _gone, ...rest } = element.customData ?? {};
  return { customData: rest };
}

const patchElement = (api: ExcalidrawImperativeAPI, id: string, patchOf: (element: Element) => Record<string, unknown>) => {
  const next = api.getSceneElements().map((element) => (element.id === id ? newElementWith(element as never, patchOf(element as unknown as Element) as never) : element));
  api.updateScene({ elements: next as never, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
};

/** The box whose label is being typed, if the text editor is open on one. */
function editedBox(api: ExcalidrawImperativeAPI): Element | null {
  const editing = api.getAppState().editingTextElement as Element | null;
  if (!editing?.containerId) return null;
  const box = api.getSceneElements().find((element) => element.id === editing.containerId) as unknown as Element | undefined;
  return box && BOXES.has(box.type) ? box : null;
}

type Picking = { editor: HTMLTextAreaElement; start: number; caret: number; text: string; boxId: string };

/**
 * The @@ list under Excalidraw's text editor while a box's label is typed. Picking puts the title in the box, closes
 * the editor and links the box once Excalidraw has taken the text.
 */
export function BoxRefPicker({ api, area }: { api: ExcalidrawImperativeAPI; area: HTMLElement }) {
  const me = useChatMe();
  const { sessions, boards } = useRefCandidates();
  const [picking, setPicking] = useState<Picking | null>(null);
  const [cursor, setCursor] = useState(0);
  const pending = useRef<{ boxId: string; ref: ChatRef } | null>(null);

  const suggestions = useMemo(() => {
    if (!picking) return [];
    const match = (label: string) => label.toLowerCase().includes(picking.text);
    return [
      ...sessions.filter((item) => match(item.label)).slice(0, 6),
      ...(boards ?? []).filter((item) => match(item.label)).slice(0, 4),
    ];
  }, [picking, sessions, boards]);
  const live = useRef({ picking, suggestions, cursor });
  live.current = { picking, suggestions, cursor };

  useEffect(() => {
    if (picking) ensureBoards(me);
  }, [picking, me]);

  // The link goes on once the editor has closed and Excalidraw has written the label.
  useEffect(() => api.onChange((_elements, state) => {
    const link = pending.current;
    if (!link || state.editingTextElement) return;
    pending.current = null;
    window.setTimeout(() => patchElement(api, link.boxId, (element) => linkPatch(element, link.ref)), 0);
  }), [api]);

  useEffect(() => {
    const read = (editor: HTMLTextAreaElement) => {
      const box = editedBox(api);
      const query = box ? queryAt(editor.value, editor.selectionStart) : null;
      setPicking(box && query?.kind === 'item' ? { editor, start: query.start, caret: editor.selectionStart, text: query.text, boxId: box.id } : null);
      setCursor(0);
    };
    const isEditor = (target: EventTarget | null): target is HTMLTextAreaElement =>
      target instanceof HTMLTextAreaElement && target.classList.contains('excalidraw-wysiwyg');
    const onInput = (event: Event) => {
      if (isEditor(event.target)) read(event.target);
    };
    // Capture on the area runs before the editor's own keydown, so the list keeps Enter, arrows and Escape.
    const onKey = (event: KeyboardEvent) => {
      const { picking: open, suggestions: list, cursor: at } = live.current;
      if (!open || !isEditor(event.target) || list.length === 0 || event.isComposing) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        setCursor((at + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length);
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        pick(list[at]);
      } else if (event.key === 'Escape') {
        setPicking(null);
      } else {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onBlur = (event: FocusEvent) => {
      if (isEditor(event.target)) setPicking(null);
    };
    area.addEventListener('input', onInput, true);
    area.addEventListener('keydown', onKey, true);
    area.addEventListener('focusout', onBlur, true);
    return () => {
      area.removeEventListener('input', onInput, true);
      area.removeEventListener('keydown', onKey, true);
      area.removeEventListener('focusout', onBlur, true);
    };
  }, [api, area]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (ref: ChatRef) => {
    const open = live.current.picking;
    if (!open) return;
    const { editor, start, caret, boxId } = open;
    editor.value = editor.value.slice(0, start) + ref.label + editor.value.slice(caret);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    pending.current = { boxId, ref };
    setPicking(null);
    editor.blur();
  };

  if (!picking) return null;
  const rect = picking.editor.getBoundingClientRect();
  return createPortal(
    <div
      className="fixed z-[80] w-64 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-xl"
      style={{ left: rect.left, top: rect.bottom + 6 }}
    >
      <div className="px-2 pb-1 pt-0.5 text-[10px] text-muted-foreground">把這個框連到對話或白板（@@）</div>
      {suggestions.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">{!boards ? '載入中…' : '沒有符合的'}</div>
      ) : suggestions.map((ref, index) => (
        <button
          key={`${ref.kind}:${ref.id}`}
          type="button"
          onMouseDown={(event) => {
            event.preventDefault();
            pick(ref);
          }}
          onMouseEnter={() => setCursor(index)}
          className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs', index === cursor ? 'bg-accent text-accent-foreground' : 'text-foreground')}
        >
          <span className={cn('flex h-5 w-5 items-center justify-center rounded-full', REF_STYLE[ref.kind])}><RefIcon kind={ref.kind} /></span>
          <span className="min-w-0 flex-1 truncate">{ref.label}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{TAB_TEXT[ref.kind as LinkKind]}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

type Viewport = { scrollX: number; scrollY: number; zoom: number };

/** The tabs on linked boxes: on the top edge (centred on a diamond's tip), scaled with the zoom like the notes. */
export function BoxLinksLayer({ api, onJump }: { api: ExcalidrawImperativeAPI; onJump: (ref: ChatRef) => void }) {
  const read = () => {
    const state = api.getAppState();
    return { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value };
  };
  const [viewport, setViewport] = useState<Viewport>(read);
  const [linked, setLinked] = useState<Element[]>([]);
  useEffect(() => api.onScrollChange((scrollX, scrollY, zoom) => setViewport({ scrollX, scrollY, zoom: zoom.value })), [api]);
  useEffect(() => {
    let key = '';
    const collect = (elements: ReadonlyArray<unknown>) => {
      const boxes = (elements as Element[]).filter((element) => !element.isDeleted && BOXES.has(element.type) && linkOf(element));
      const next = JSON.stringify(boxes.map((box) => [box.id, box.type, box.x, box.y, box.width, box.height, linkOf(box)]));
      if (next === key) return;
      key = next;
      setLinked(boxes);
    };
    collect(api.getSceneElements());
    return api.onChange((elements) => collect(elements));
  }, [api]);

  return (
    <div className="pointer-events-none absolute inset-0 z-[4] overflow-hidden">
      {linked.map((box) => {
        const ref = linkOf(box) as ChatRef;
        const kind = ref.kind as LinkKind;
        const diamond = box.type === 'diamond';
        const left = (box.x + (diamond ? box.width / 2 : 0) + viewport.scrollX) * viewport.zoom;
        const top = (box.y + viewport.scrollY) * viewport.zoom;
        return (
          <div
            key={box.id}
            data-testid="box-link"
            className="group/link pointer-events-auto absolute flex items-center gap-1"
            style={{ left, top, transform: `${diamond ? 'translateX(-50%) ' : ''}translateY(-100%) scale(${viewport.zoom})`, transformOrigin: diamond ? '50% 100%' : '0 100%' }}
          >
            <button
              type="button"
              title={kind === 'session' ? `跳到對話「${ref.label}」` : `打開白板「${ref.label}」`}
              onClick={() => onJump(ref)}
              className="mb-1 flex items-center gap-1.5 rounded-lg border border-border bg-background/95 py-0.5 pl-0.5 pr-1.5 text-[11px] font-medium text-foreground shadow-sm transition hover:border-violet-400/60 hover:shadow-md"
            >
              <span className={cn('flex h-5 w-5 items-center justify-center rounded-md text-white', kind === 'session' ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500' : 'bg-gradient-to-br from-emerald-500 to-teal-500')}>
                <RefIcon kind={kind} className="h-3 w-3" />
              </span>
              {TAB_TEXT[kind]}
              <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
            <button
              type="button"
              aria-label="取消連結"
              title="取消連結（框和文字留著）"
              onClick={() => patchElement(api, box.id, unlinkPatch)}
              className="mb-1 rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover/link:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
