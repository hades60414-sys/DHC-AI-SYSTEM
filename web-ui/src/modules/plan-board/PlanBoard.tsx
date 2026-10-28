import '@/modules/plan-board/excalidrawAssets';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaptureUpdateAction, Excalidraw, MainMenu, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
// The package exposes its stylesheet through an exports map the lint resolver does not follow; Vite resolves it.
// oxlint-disable-next-line importx/no-unresolved
import '@excalidraw/excalidraw/index.css';
import { Kanban, Loader2, MessageSquare, Palette, Play, Plus, Send, Trash2, Upload, Workflow, X } from 'lucide-react';

import { BOARD_MODES, MODE_ORDER } from '@/modules/plan-board/boardModes';
import { boardNameFromFile, extractMermaid, importKind, parseExcalidrawJson } from '@/modules/plan-board/boardImport';
import ColorBar, { DEFAULT_STROKE } from '@/modules/plan-board/ColorBar';
import { readTextFile } from '@/modules/tool-library';
import { boardToCards } from '@/modules/plan-board/boardToCards';
import { boardBrief, planToSkeletons, redrawnIds, sceneToPlan } from '@/modules/plan-board/sceneModel';
import type { SceneElement } from '@/modules/plan-board/sceneModel';
import { api } from '@/shared/api';
import { sendToTool } from '@/shared/toolHandoff';
import { createBoardSaver, emptyBoard, loadBoards, parseEdges, parseNodes, saveBoardStyle } from '@/shared/planBoards';
import type { BoardMode, BoardStyle, PlanBoard, PlanChatMessage } from '@/shared/planBoards';
import { cn } from '@/shared/utils';

type CanvasProps = {
  board: PlanBoard;
  isMobile: boolean;
  /** Pen, fill, font and line settings to start with (the person's last used). */
  style: BoardStyle;
  onStyleChange: (style: BoardStyle) => void;
  onChange: (board: PlanBoard) => void;
  /** Null when this device's profile has no project to start work in. */
  onStartWork: ((brief: string) => void) | null;
};

// What Excalidraw uses for the next thing drawn; kept per person so it is not reset on every visit.
const STYLE_KEYS = [
  'currentItemStrokeColor', 'currentItemBackgroundColor', 'currentItemFillStyle', 'currentItemStrokeWidth',
  'currentItemStrokeStyle', 'currentItemRoughness', 'currentItemOpacity', 'currentItemFontFamily',
  'currentItemFontSize', 'currentItemTextAlign', 'currentItemRoundness', 'currentItemArrowType',
  'currentItemStartArrowhead', 'currentItemEndArrowhead',
] as const;
// Black on the light canvas, white on the dark one.
const DEFAULT_STYLE: BoardStyle = { currentItemStrokeColor: DEFAULT_STROKE };
// The first default (10/13 afternoon) was this grey, which turns dim on the dark canvas; a saved grey is that default.
const OLD_DEFAULT_STROKE = '#868e96';
const DRAWING_TOOLS = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text']);
// What a double click types into (a box's label, or the text itself).
const TYPABLE = new Set(['rectangle', 'diamond', 'ellipse', 'text']);
type ToolState = { selectedIds: Record<string, true>; tool: string; fill: string; sidebarOpen: boolean };
// Folded or open, per device: someone who closed the colour panel does not want it back on every click.
const COLORS_FOLDED_KEY = 'dhc.boardColorsFolded';

const liveElements = (elements: ReadonlyArray<unknown>) => (elements as SceneElement[]).filter((element) => !element.isDeleted);
// Every edit bumps an element's version, so this changes exactly when the drawing does (not on scroll or select).
const sceneSignature = (elements: ReadonlyArray<SceneElement>) => elements.map((element) => `${element.id}:${(element as { version?: number }).version ?? 0}`).join('|');

function BoardCanvas({ board, isMobile, style, onStyleChange, onChange, onStartWork }: CanvasProps) {
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const [chat, setChat] = useState<PlanChatMessage[]>(board.chat);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [showChat, setShowChat] = useState(!isMobile);
  const [hasContent, setHasContent] = useState(board.elements.length > 0);
  const chatEnd = useRef<HTMLDivElement>(null);
  const canvasArea = useRef<HTMLDivElement>(null);

  // The site's dark theme forces every textarea to light grey (index.css, !important); Excalidraw's text editor is a
  // textarea it colours inline and then inverts in the dark theme, so the forced grey came out dim while typing.
  // Put the editor's own colour back with an important inline value, which outranks the stylesheet.
  useEffect(() => {
    const area = canvasArea.current;
    if (!area) return undefined;
    const fix = () => {
      area.querySelectorAll<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg').forEach((editor) => {
        const color = editor.style.getPropertyValue('color');
        if (!color || editor.style.getPropertyPriority('color') === 'important') return;
        for (const property of ['color', '-webkit-text-fill-color', 'caret-color']) editor.style.setProperty(property, color, 'important');
      });
    };
    const observer = new MutationObserver(fix);
    observer.observe(area, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    return () => observer.disconnect();
  }, []);

  // Opens on the hand (dragging moves the board) with the tool lock on, so a drawn box does not drop back to
  // selection; the person switches tools themselves (the lock icon on the toolbar turns it off).
  useEffect(() => {
    excalidraw?.setActiveTool({ type: 'hand', locked: true });
    // The whole drawing in view on open (an imported or AI-drawn board can be wider than the window); never zoomed in.
    if (excalidraw && liveElements(excalidraw.getSceneElements()).length > 0) {
      excalidraw.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9, maxZoom: 1 });
    }
  }, [excalidraw]);

  // The wheel zooms (Excalidraw pans with it and zooms with Ctrl+wheel). Only over the drawing itself: the library,
  // menus and panels keep scrolling. Panning stays on space+drag, the hand tool and the middle button.
  useEffect(() => {
    const area = canvasArea.current;
    if (!area) return undefined;
    const toZoom = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || !(event.target instanceof HTMLCanvasElement)) return;
      event.preventDefault();
      event.stopPropagation();
      event.target.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        clientX: event.clientX,
        clientY: event.clientY,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
      }));
    };
    area.addEventListener('wheel', toZoom, { capture: true, passive: false });
    return () => area.removeEventListener('wheel', toZoom, { capture: true });
  }, []);

  // With the selection tool, press twice on empty board and keep the second press down: dragging moves the board and
  // letting go leaves the selection tool as it was, so there is no switching back and forth. A double press on a
  // shape still edits its text; a double click on empty board without dragging still adds text.
  useEffect(() => {
    const area = canvasArea.current;
    if (!area || !excalidraw) return undefined;
    const DOUBLE_MS = 350;
    const NEAR_PX = 12;
    let lastUp = { time: 0, x: 0, y: 0 };
    let pan: { id: number; x: number; y: number; scrollX: number; scrollY: number; moved: boolean } | null = null;
    let swallowDblclickUntil = 0;
    // Set when a double click with the hand switched to selection: the hand comes back once the typing ends (or, for
    // something not typed into, once nothing is selected). Choosing another tool meanwhile cancels it.
    let backToHand: { typing: boolean; editing: boolean } | null = null;
    const stopWatching = excalidraw.onChange((_elements, state) => {
      if (!backToHand) return;
      if (state.activeTool.type !== 'selection') {
        backToHand = null;
        return;
      }
      if (state.editingTextElement) {
        backToHand.editing = true;
        return;
      }
      const done = backToHand.typing ? backToHand.editing : Object.keys(state.selectedElementIds).length === 0;
      if (!done) return;
      backToHand = null;
      window.setTimeout(() => {
        excalidraw.setActiveTool({ type: 'hand' });
        excalidraw.updateScene({ appState: { selectedElementIds: {} } as never, captureUpdate: CaptureUpdateAction.NEVER });
      }, 0);
    });

    /** The topmost drawn thing under the pointer (a label counts as its box), by bounding box. */
    const elementAt = (clientX: number, clientY: number) => {
      const state = excalidraw.getAppState();
      const zoom = state.zoom.value;
      const x = (clientX - state.offsetLeft) / zoom - state.scrollX;
      const y = (clientY - state.offsetTop) / zoom - state.scrollY;
      const pad = 8 / zoom;
      const elements = excalidraw.getSceneElements();
      const hit = [...elements].reverse().find((element) => {
        const points = (element as { points?: ReadonlyArray<readonly [number, number]> }).points;
        const xs = points?.length ? points.map((point) => element.x + point[0]) : [element.x, element.x + element.width];
        const ys = points?.length ? points.map((point) => element.y + point[1]) : [element.y, element.y + element.height];
        return x >= Math.min(...xs) - pad && x <= Math.max(...xs) + pad && y >= Math.min(...ys) - pad && y <= Math.max(...ys) + pad;
      });
      const containerId = (hit as { containerId?: string | null } | undefined)?.containerId;
      return containerId ? elements.find((element) => element.id === containerId) ?? hit : hit;
    };
    const onEmptyBoard = (clientX: number, clientY: number) => !elementAt(clientX, clientY);

    const down = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof HTMLCanvasElement)) return;
      if (excalidraw.getAppState().activeTool.type !== 'selection') return;
      const isSecondPress = event.timeStamp - lastUp.time < DOUBLE_MS
        && Math.hypot(event.clientX - lastUp.x, event.clientY - lastUp.y) < NEAR_PX;
      if (!isSecondPress || !onEmptyBoard(event.clientX, event.clientY)) return;
      event.preventDefault();
      event.stopPropagation();
      const state = excalidraw.getAppState();
      pan = { id: event.pointerId, x: event.clientX, y: event.clientY, scrollX: state.scrollX, scrollY: state.scrollY, moved: false };
      excalidraw.setCursor('grabbing');
    };
    const move = (event: PointerEvent) => {
      if (!pan || event.pointerId !== pan.id) return;
      event.stopPropagation();
      const zoom = excalidraw.getAppState().zoom.value;
      const dx = event.clientX - pan.x;
      const dy = event.clientY - pan.y;
      if (Math.hypot(dx, dy) > 3) pan.moved = true;
      excalidraw.updateScene({
        appState: { scrollX: pan.scrollX + dx / zoom, scrollY: pan.scrollY + dy / zoom } as never,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    };
    const up = (event: PointerEvent) => {
      if (pan && event.pointerId === pan.id) {
        event.stopPropagation();
        if (pan.moved) swallowDblclickUntil = event.timeStamp + 500;
        pan = null;
        lastUp = { time: 0, x: 0, y: 0 };
        excalidraw.resetCursor();
        return;
      }
      if (event.target instanceof HTMLCanvasElement) lastUp = { time: event.timeStamp, x: event.clientX, y: event.clientY };
    };
    // A drag is not a double click: no text box where the board was let go.
    const dblclick = (event: MouseEvent) => {
      if (event.timeStamp < swallowDblclickUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // With the hand, a double click on something switches to selection with it selected (its settings show), and
      // a box or text goes straight into typing. On empty board the hand stays.
      if (!(event.target instanceof HTMLCanvasElement) || excalidraw.getAppState().activeTool.type !== 'hand') return;
      const hit = elementAt(event.clientX, event.clientY);
      if (!hit) return;
      event.preventDefault();
      event.stopPropagation();
      const canvas = event.target;
      const { clientX, clientY } = event;
      excalidraw.setActiveTool({ type: 'selection' });
      excalidraw.updateScene({ appState: { selectedElementIds: { [hit.id]: true } } as never, captureUpdate: CaptureUpdateAction.NEVER });
      // Only now: the tool switch itself reports an empty selection, which would read as "done".
      backToHand = { typing: TYPABLE.has(hit.type), editing: false };
      if (TYPABLE.has(hit.type)) {
        // Excalidraw's own double click, now that the selection tool is in hand, opens the text editor.
        window.requestAnimationFrame(() => {
          canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX, clientY }));
        });
      }
    };
    area.addEventListener('pointerdown', down, { capture: true });
    window.addEventListener('pointermove', move, { capture: true });
    window.addEventListener('pointerup', up, { capture: true });
    area.addEventListener('dblclick', dblclick, { capture: true });
    return () => {
      stopWatching();
      area.removeEventListener('pointerdown', down, { capture: true });
      window.removeEventListener('pointermove', move, { capture: true });
      window.removeEventListener('pointerup', up, { capture: true });
      area.removeEventListener('dblclick', dblclick, { capture: true });
    };
  }, [excalidraw]);
  const boardRef = useRef(board);
  boardRef.current = board;
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const signature = useRef(sceneSignature(liveElements(board.elements)));
  const [tools, setTools] = useState<ToolState>({ selectedIds: {}, tool: 'selection', fill: 'transparent', sidebarOpen: false });
  const [colorsFolded, setColorsFolded] = useState(() => localStorage.getItem(COLORS_FOLDED_KEY) === '1');
  const foldColors = (folded: boolean) => {
    setColorsFolded(folded);
    try { localStorage.setItem(COLORS_FOLDED_KEY, folded ? '1' : '0'); } catch { /* this page load only */ }
  };
  const toolsKey = useRef('');
  const styleJson = useRef('');
  const [sceneTick, setSceneTick] = useState(0);

  const initialData = useMemo(() => ({
    elements: board.elements as never,
    appState: {
      ...DEFAULT_STYLE,
      ...style,
      ...(style.currentItemStrokeColor === OLD_DEFAULT_STROKE ? { currentItemStrokeColor: DEFAULT_STROKE } : {}),
    } as never,
    scrollToContent: true,
  }), [board.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback((elements: SceneElement[], nextChat: PlanChatMessage[]) => {
    onChange({ ...boardRef.current, elements, chat: nextChat, updatedAt: new Date().toISOString() });
  }, [onChange]);

  const handleChange = useCallback((elements: ReadonlyArray<unknown>, appState: Record<string, unknown>) => {
    // Selection and tool drive the colour panel; only a real change re-renders it.
    const selectedIds = (appState.selectedElementIds ?? {}) as Record<string, true>;
    const tool = String((appState.activeTool as { type?: string } | undefined)?.type ?? 'selection');
    const fill = String(appState.currentItemBackgroundColor ?? 'transparent');
    const sidebarOpen = Boolean(appState.openSidebar);
    const key = `${Object.keys(selectedIds).sort().join(',')}|${tool}|${fill}|${sidebarOpen}`;
    if (key !== toolsKey.current) {
      toolsKey.current = key;
      setTools({ selectedIds, tool, fill, sidebarOpen });
    }
    const nextStyle = Object.fromEntries(STYLE_KEYS.map((name) => [name, appState[name] ?? null]));
    const nextStyleJson = JSON.stringify(nextStyle);
    if (nextStyleJson !== styleJson.current) {
      // The first report is just the starting style; only later changes are the person's.
      if (styleJson.current) onStyleChange(nextStyle);
      styleJson.current = nextStyleJson;
    }
    const live = liveElements(elements);
    const next = sceneSignature(live);
    if (next === signature.current) return;
    signature.current = next;
    setHasContent(live.length > 0);
    setSceneTick((tick) => tick + 1);
    save(live, chatRef.current);
  }, [onStyleChange, save]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: 'end' });
  }, [chat, busy]);

  const currentElements = () => liveElements(excalidraw?.getSceneElements() ?? board.elements);

  const send = async () => {
    const text = message.trim();
    if (!text || busy || !excalidraw) return;
    const history = chatRef.current;
    const withQuestion = [...history, { role: 'user' as const, text }];
    setChat(withQuestion);
    save(currentElements(), withQuestion);
    setMessage('');
    setBusy(true);
    let answer = '';
    try {
      const scene = currentElements();
      const plan = sceneToPlan(scene);
      // Notes and sketches are not redrawn, but the AI should know they are there.
      const context = [
        plan.notes.length > 0 && `（白板上另有文字註記：${plan.notes.join('；')}）`,
        plan.sketches > 0 && `（另有 ${plan.sketches} 筆手繪，不會被改動）`,
      ].filter(Boolean).join('');
      const modeNote = BOARD_MODES[boardRef.current.mode].aiNote;
      const response = await api.planBoardAssist({ board: { nodes: plan.nodes, edges: plan.edges }, chat: history, message: `${text}${context}${modeNote}` });
      const payload = (await response.json().catch(() => null)) as { data?: { reply?: string; board?: unknown } } | null;
      if (!response.ok || !payload?.data) {
        answer = response.status === 404 ? '要等系統重啟後才能用 AI 畫圖。' : 'AI 這次沒有回應，稍後再試一次。';
        return;
      }
      answer = payload.data.reply ?? '';
      const drawn = payload.data.board;
      if (drawn && typeof drawn === 'object') {
        const nodes = parseNodes((drawn as { nodes?: unknown }).nodes);
        const edges = parseEdges((drawn as { edges?: unknown }).edges, nodes);
        if (nodes.length > 0) {
          const latest = currentElements();
          const owned = redrawnIds(latest, sceneToPlan(latest));
          const kept = latest.filter((element) => !owned.has(element.id));
          const redrawn = convertToExcalidrawElements(planToSkeletons(nodes, edges, latest) as never, { regenerateIds: false });
          excalidraw.updateScene({ elements: [...kept, ...redrawn] as never, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
          excalidraw.scrollToContent(undefined, { fitToContent: true, animate: true });
          answer += '\n（白板已更新，不滿意可按 Ctrl+Z 復原）';
        }
      }
    } catch {
      answer = '連不到伺服器，稍後再試一次。';
    } finally {
      const withAnswer = [...chatRef.current, { role: 'assistant' as const, text: answer }];
      setChat(withAnswer);
      save(currentElements(), withAnswer);
      setBusy(false);
    }
  };

  const startWork = () => {
    if (!onStartWork) return;
    const scene = currentElements();
    save(scene, chatRef.current);
    onStartWork(boardBrief(boardRef.current.name, sceneToPlan(scene), chatRef.current, BOARD_MODES[boardRef.current.mode]));
  };
  // Out of the way while Excalidraw's own side panel (library, search) is open.
  const showColors = Boolean(excalidraw) && !tools.sidebarOpen
    && (Object.keys(tools.selectedIds).length > 0 || DRAWING_TOOLS.has(tools.tool));

  const isDark = document.documentElement.classList.contains('dark');

  return (
    <>
      <div className="relative flex min-h-0 flex-1">
        <div ref={canvasArea} className="relative min-w-0 flex-1">
          <Excalidraw
            excalidrawAPI={setExcalidraw}
            initialData={initialData}
            onChange={handleChange as never}
            langCode="zh-TW"
            theme={isDark ? 'dark' : 'light'}
            UIOptions={{
              canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false },
              tools: { image: false },
            }}
          >
            <MainMenu>
              <MainMenu.DefaultItems.SaveAsImage />
              <MainMenu.DefaultItems.SearchMenu />
              <MainMenu.DefaultItems.Help />
              <MainMenu.DefaultItems.ClearCanvas />
              <MainMenu.Separator />
              <MainMenu.DefaultItems.ChangeCanvasBackground />
            </MainMenu>
          </Excalidraw>
          {showColors && excalidraw && (
            <div className="absolute right-3 top-16 z-10">
              {colorsFolded ? (
                <button
                  type="button"
                  onClick={() => foldColors(false)}
                  className="flex items-center gap-1 rounded-lg border border-border bg-background/95 px-2 py-1.5 text-xs text-foreground shadow-lg hover:bg-muted"
                >
                  <Palette className="h-3.5 w-3.5" />
                  顏色
                </button>
              ) : (
                <ColorBar
                  key={sceneTick}
                  api={excalidraw}
                  isDark={isDark}
                  selectedIds={tools.selectedIds}
                  currentFill={tools.fill}
                  onClose={() => foldColors(true)}
                />
              )}
            </div>
          )}
        </div>

        {showChat && (
          <div className={cn('flex min-h-0 flex-col border-l border-border bg-background', isMobile ? 'absolute inset-x-0 bottom-0 z-20 h-1/2 border-t' : 'w-80')}>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-sm">
              {chat.length === 0 && (
                <p className="text-xs leading-relaxed text-muted-foreground">{BOARD_MODES[board.mode].intro}</p>
              )}
              {chat.map((item, index) => (
                <div
                  key={index}
                  className={cn(
                    'whitespace-pre-wrap rounded-lg px-2.5 py-1.5',
                    item.role === 'user' ? 'ml-6 bg-primary text-primary-foreground' : 'mr-6 bg-muted text-foreground',
                  )}
                >
                  {item.text}
                </div>
              ))}
              {busy && (
                <div className="mr-6 flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  AI 正在畫（約 15–60 秒）
                </div>
              )}
              <div ref={chatEnd} />
            </div>
            <div className="flex items-end gap-1.5 border-t border-border p-2">
              <textarea
                aria-label="跟 AI 說要畫什麼"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                placeholder="要畫或改什麼？（Enter 送出）"
                className="min-h-0 flex-1 resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={busy || !message.trim()}
                aria-label="送出"
                className="rounded-md bg-primary p-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-shrink-0 items-center gap-2 border-t border-border bg-muted/40 px-3 py-2">
        <button
          type="button"
          onClick={() => setShowChat(!showChat)}
          className={cn('flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted', showChat && 'border-primary text-primary')}
        >
          <MessageSquare className="h-3.5 w-3.5" />
          AI 對話
        </button>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {onStartWork
            ? `規劃好了就按「開工」：會開一個新對話，把這張圖當成工作說明直接送出${board.mode === 'free' ? '' : `（${BOARD_MODES[board.mode].label}模式：${board.mode === 'sop' ? '寫成 SOP 文件' : board.mode === 'mindmap' ? '整理成大綱和待辦' : '做成資料管線'}）`}。`
            : '這台裝置的專案設定沒有對應的專案，先到 設定 → 專案設定 選好你的專案才能開工。'}
        </span>
        <button
          type="button"
          onClick={startWork}
          disabled={!hasContent || !onStartWork}
          className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          <Play className="h-3.5 w-3.5" />
          開工
        </button>
      </div>
    </>
  );
}

type PlanBoardProps = {
  /** Whose boards: this device's 專案設定 profile. */
  profileId: string;
  profileName: string;
  /** Where the first version kept this person's boards, read once if the profile has none. */
  legacyProjectId: string | null;
  isMobile: boolean;
  onClose: () => void;
  /** Opens a new chat in the person's project and sends the brief; null when the profile has no project. */
  onStartWork: ((brief: string) => void) | null;
};

/** DHC CLI 10/13 規劃白板: full-screen Excalidraw canvas with the person's boards, an AI chat beside it, and 開工. */
export default function PlanBoardWindow({ profileId, profileName, legacyProjectId, isMobile, onClose, onStartWork }: PlanBoardProps) {
  const [boards, setBoards] = useState<PlanBoard[] | null>(null);
  const [style, setStyle] = useState<BoardStyle>({});
  const styleTimer = useRef<number | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const saver = useMemo(() => createBoardSaver(profileId, () => setFailed(true)), [profileId]);
  const onStyleChange = useCallback((next: BoardStyle) => {
    setStyle(next);
    if (styleTimer.current !== null) window.clearTimeout(styleTimer.current);
    styleTimer.current = window.setTimeout(() => saveBoardStyle(profileId, next), 1000);
  }, [profileId]);

  useEffect(() => {
    let cancelled = false;
    loadBoards(profileId, legacyProjectId)
      .then(({ boards: stored, style: savedStyle }) => {
        if (cancelled) return;
        let list = stored;
        setStyle(savedStyle);
        if (list.length === 0) {
          const first = emptyBoard('我的第一張白板');
          saver.save(first);
          list = [first];
        }
        setBoards(list);
        setActiveId(list[0].id);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [profileId, legacyProjectId, saver]);

  const close = useCallback(() => {
    void saver.flush();
    onClose();
  }, [onClose, saver]);

  const active = boards?.find((board) => board.id === activeId) ?? null;
  const update = useCallback((board: PlanBoard) => {
    setBoards((list) => (list ?? []).map((item) => (item.id === board.id ? board : item)));
    saver.save(board);
  }, [saver]);
  const setMode = (mode: BoardMode) => {
    if (active) update({ ...active, mode, updatedAt: new Date().toISOString() });
  };
  const create = () => {
    const board = emptyBoard(`白板 ${(boards?.length ?? 0) + 1}`, active?.mode ?? 'free');
    setBoards((list) => [board, ...(list ?? [])]);
    setActiveId(board.id);
    saver.save(board);
  };
  const rename = () => {
    if (!active) return;
    const name = window.prompt('白板名稱', active.name)?.trim();
    if (name) update({ ...active, name, updatedAt: new Date().toISOString() });
  };
  const remove = () => {
    if (!active || !boards) return;
    if (!window.confirm(`刪除白板「${active.name}」？刪了就找不回來。`)) return;
    saver.remove(active.id);
    const rest = boards.filter((board) => board.id !== active.id);
    const next = rest.length > 0 ? rest : [emptyBoard('我的第一張白板')];
    if (rest.length === 0) saver.save(next[0]);
    setBoards(next);
    setActiveId(next[0].id);
  };
  // 匯入: .excalidraw/.json scenes and Mermaid text each become a new board (the current one is never touched).
  const [importNote, setImportNote] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const importFiles = useCallback(async (files: File[]) => {
    const made: PlanBoard[] = [];
    const problems: string[] = [];
    for (const file of files) {
      const kind = importKind(file.name);
      if (kind === 'unsupported') { problems.push(`${file.name} 不支援（可用 .excalidraw／.json／.mmd／.md／.txt）`); continue; }
      try {
        const text = await readTextFile(file);
        let elements: unknown[];
        if (kind === 'excalidraw') {
          const parsed = parseExcalidrawJson(text);
          if ('error' in parsed) { problems.push(`${file.name}：${parsed.error}`); continue; }
          elements = parsed.elements;
        } else {
          const source = extractMermaid(text);
          if (!source) { problems.push(`${file.name}：找不到 Mermaid 圖（要以 flowchart、graph、sequenceDiagram 等開頭，或放在 mermaid 程式碼區塊裡）`); continue; }
          const { parseMermaidToExcalidraw } = await import('@excalidraw/mermaid-to-excalidraw');
          const converted = await parseMermaidToExcalidraw(source);
          elements = convertToExcalidrawElements(converted.elements as never) as unknown[];
        }
        made.push({ ...emptyBoard(boardNameFromFile(file.name), 'free'), elements });
      } catch {
        problems.push(`${file.name}：轉換失敗（語法可能不支援）`);
      }
    }
    if (made.length > 0) {
      for (const board of made) saver.save(board);
      setBoards((list) => [...made.reverse(), ...(list ?? [])]);
      setActiveId(made[0].id);
    }
    setImportNote([made.length > 0 ? `匯入了 ${made.length} 張新白板：${made.map((board) => board.name).join('、')}` : '沒有匯入任何白板', ...problems].join('；'));
  }, [saver]);

  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const over = (event: DragEvent) => { if (hasFiles(event)) event.preventDefault(); };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      void importFiles(Array.from(event.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  }, [importFiles]);

  const startWork = async (brief: string) => {
    await saver.flush();
    onStartWork?.(brief);
    onClose();
  };

  // 轉成專案板: boxes become cards in arrow order; the page closes this window and opens 專案板, which makes a new board.
  const plan = useMemo(() => sceneToPlan((active?.elements ?? []) as SceneElement[]), [active?.elements]);
  const toProjectBoard = async () => {
    if (!active || plan.nodes.length === 0) return;
    await saver.flush();
    sendToTool({ tool: 'project-board', kind: 'cards', payload: { boardName: active.name, cards: boardToCards(plan.nodes, plan.edges) }, from: `規劃白板『${active.name}』` });
  };

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background" role="dialog" aria-label="規劃白板">
      <div className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3">
        <Workflow className="h-4 w-4 shrink-0 text-primary" />
        <span className="shrink-0 text-sm font-semibold text-foreground">規劃白板</span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground" title="白板跟著這台裝置的專案設定（帳號）走，別人看不到">{profileName}</span>
        {boards && (
          <select
            aria-label="選擇白板"
            value={activeId ?? ''}
            onChange={(event) => setActiveId(event.target.value)}
            className="min-w-0 max-w-[14rem] rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
          >
            {boards.map((board) => <option key={board.id} value={board.id}>{board.name}</option>)}
          </select>
        )}
        {active && (
          <select
            aria-label="白板模式"
            title="模式決定 AI 怎麼排版、開工要產出什麼"
            value={active.mode}
            onChange={(event) => setMode(event.target.value as BoardMode)}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
          >
            {MODE_ORDER.map((mode) => <option key={mode} value={mode}>模式：{BOARD_MODES[mode].label}</option>)}
          </select>
        )}
        <button type="button" onClick={create} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="新白板" aria-label="新白板">
          <Plus className="h-4 w-4" />
        </button>
        <button type="button" onClick={rename} disabled={!active} className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          改名
        </button>
        <button type="button" onClick={remove} disabled={!active} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive" title="刪除這張白板" aria-label="刪除這張白板">
          <Trash2 className="h-4 w-4" />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".excalidraw,.json,.mmd,.mermaid,.md,.txt"
          className="hidden"
          data-testid="board-import-input"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (files.length > 0) void importFiles(files);
          }}
        />
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          title="匯入 Excalidraw 白板檔（.excalidraw／.json）或 Mermaid 流程圖（.mmd／.md／.txt），變成新白板；也可以直接把檔案拖進視窗"
          className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted"
        >
          <Upload className="h-3.5 w-3.5" />
          匯入
        </button>
        <button
          type="button"
          onClick={() => void toProjectBoard()}
          disabled={plan.nodes.length === 0}
          title={plan.nodes.length === 0 ? '白板上還沒有方框' : '把方框依箭頭順序做成專案板的卡片（會開一個新的專案板）'}
          className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-40"
        >
          <Kanban className="h-3.5 w-3.5" />
          轉成專案板
        </button>
        {importNote && (
          <button type="button" onClick={() => setImportNote('')} title="按一下關掉" className="max-w-[24rem] truncate text-xs text-muted-foreground hover:text-foreground">
            {importNote}
          </button>
        )}
        {failed && <span className="truncate text-xs text-destructive">有變更沒存到伺服器，請稍後重新整理再確認。</span>}
        <button type="button" onClick={close} aria-label="關閉白板" className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      {!boards ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{failed ? '讀不到白板，稍後再開一次。' : '載入中…'}</p>
      ) : active ? (
        <BoardCanvas
          key={active.id}
          board={active}
          isMobile={isMobile}
          style={style}
          onStyleChange={onStyleChange}
          onChange={update}
          onStartWork={onStartWork ? (brief) => void startWork(brief) : null}
        />
      ) : null}
    </div>
  );
}
