import '@/modules/plan-board/excalidrawAssets';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { CaptureUpdateAction, Excalidraw, MainMenu, convertToExcalidrawElements, exportToBlob, newElementWith, restoreElements } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import { CornerDownLeft, Ellipsis, Kanban, Loader2, Lock, MessageSquare, MousePointer2, Palette, Play, Send, Sparkles, Trash2, Undo2, Upload, Users, Workflow, X } from 'lucide-react';

import { BOARD_MODES, MODE_ORDER } from '@/modules/plan-board/boardModes';
import { boardNameFromFile, extractMermaid, importKind, parseExcalidrawJson } from '@/modules/plan-board/boardImport';
import BoardPicker from '@/modules/plan-board/BoardPicker';
import BoardShareDialog from '@/modules/plan-board/BoardShareDialog';
import ColorBar, { DEFAULT_STROKE } from '@/modules/plan-board/ColorBar';
import { readTextFile } from '@/modules/tool-library/importers';
import { boardToCards } from '@/modules/plan-board/boardToCards';
import { diffNodes, fitBoxesToText, resolveOverlaps, spreadForLabels } from '@/modules/plan-board/boardLayout';
import { acceptLinks } from '@/modules/plan-board/boxLinkData';
import { boardBrief, planToSkeletons, redrawnIds, sceneToPlan, wholeGroupOf } from '@/modules/plan-board/sceneModel';
import type { SceneElement } from '@/modules/plan-board/sceneModel';
import { api } from '@/shared/api';
import { createCoBoardSaver, elementsDiffer, hasUnsaved, loadCoBoards, mergeChat, mergeElements, restoreTo, toPersonal, withMembers, withoutMember } from '@/shared/coBoards';
import { useCoPeople } from '@/shared/coSessions';
import type { CoPerson } from '@/shared/coSessions';
import { useUserAvatar } from '@/shared/userAvatars';
import { PersonAvatar } from '@/modules/user-avatar';
import type { CoBoard } from '@/shared/coBoards';
import { sendToTool } from '@/shared/toolHandoff';
import { autoNameOf, createBoardSaver, emptyBoard, loadBoards, parseEdges, parseNodes, parseNotes, saveBoardStyle } from '@/shared/planBoards';
import type { BoardMode, BoardStyle, PlanBoard, PlanChatMessage, PlanLink } from '@/shared/planBoards';
import { cn } from '@/shared/utils';
import CanvasEmbed, { canvasLinkOf, storedNameOfLink } from '@/modules/canvas/CanvasEmbed';
import { takePendingCanvasCard } from '@/modules/canvas/canvasStore';
import { BoardNotesLayer, ChatRoomButton, CopyNameButton, NoteButton, ensureBoards, useRefAction, useRefCandidates } from '@/modules/chat-room';
import { BoxLinksLayer, BoxRefPicker } from '@/modules/plan-board/BoxLinks';
import type { BoardView } from '@/modules/chat-room';
import { markSeen, roomOfBoard, setBoardContext, useChatMe, useChatPanel } from '@/shared/chatRoom';
import { useIsTeamMode } from '@/shared/dhcConfig';

type CanvasProps = {
  board: PlanBoard;
  isMobile: boolean;
  /** Pen, fill, font and line settings to start with (the person's last used). */
  style: BoardStyle;
  onStyleChange: (style: BoardStyle) => void;
  onChange: (board: PlanBoard) => void;
  /** Null when this device's profile has no project to start work in. */
  onStartWork: ((brief: string) => void) | null;
  /** Puts the brief in the composer of the conversation the board was opened from; null when none was open. */
  onSendToChat: ((brief: string) => void) | null;
  /** The person's project (the AI runs there with their memory) and the conversation open behind the board. */
  projectId: string | null;
  sessionId: string | null;
  /** Co-Work: the shared board's latest copy from the server (merged in as it changes) and this person's name. */
  remote: CoBoard | null;
  myName: string;
  /** Closes the board window (saving first), before jumping from a linked box. */
  onLeave: () => void;
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
// The chat column's width, per device, dragged from its left edge.
const CHAT_WIDTH_KEY = 'dhc.boardChatWidth';
/** The board this profile had open last; reopening the window starts there. */
const lastBoardKey = (profileId: string) => `dhc.boardLast:p:${profileId}`;
const CHAT_WIDTH = { min: 280, max: 720, initial: 320 };
const readChatWidth = () => {
  const saved = Number(localStorage.getItem(CHAT_WIDTH_KEY));
  return Number.isFinite(saved) && saved >= CHAT_WIDTH.min ? Math.min(saved, CHAT_WIDTH.max) : CHAT_WIDTH.initial;
};

// 10/19: the AI may link boxes to at most this many conversations and whiteboards.
const MAX_LINKABLES = 80;
const BOARD_IMAGE_MAX_PX = 1600;

/** The board as a PNG (base64, no data: prefix) for the AI to look at; undefined if the export fails. */
async function boardImage(api: ExcalidrawImperativeAPI): Promise<string | undefined> {
  try {
    const state = api.getAppState();
    const blob = await exportToBlob({
      elements: api.getSceneElements(),
      appState: { exportBackground: true, viewBackgroundColor: state.viewBackgroundColor, exportWithDarkMode: state.theme === 'dark' },
      files: api.getFiles(),
      mimeType: 'image/png',
      getDimensions: (width: number, height: number) => {
        const scale = Math.min(1, BOARD_IMAGE_MAX_PX / Math.max(width, height));
        return { width: Math.round(width * scale), height: Math.round(height * scale), scale };
      },
    });
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return url.slice(url.indexOf(',') + 1);
  } catch {
    return undefined;
  }
}

const liveElements = (elements: ReadonlyArray<unknown>) => (elements as SceneElement[]).filter((element) => !element.isDeleted);
// Every edit bumps an element's version, so this changes exactly when the drawing does (not on scroll or select).
const sceneSignature = (elements: ReadonlyArray<SceneElement>) => elements.map((element) => `${element.id}:${(element as { version?: number }).version ?? 0}`).join('|');

function BoardCanvas({ board, isMobile, style, onStyleChange, onChange, onStartWork, onSendToChat, projectId, sessionId, remote, myName, onLeave }: CanvasProps) {
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const [chat, setChat] = useState<PlanChatMessage[]>(board.chat);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [showChat, setShowChat] = useState(!isMobile);
  const [chatWidth, setChatWidth] = useState(readChatWidth);
  const people = useCoPeople();
  const myAvatar = useUserAvatar();
  /**
   * Who asked: their project's profile (name and avatar). Older messages have no project: a name on a shared board
   * is matched by name; no name at all was written by whoever had the board then, i.e. this person.
   */
  const speakerOf = (message: PlanChatMessage): CoPerson => {
    if (!message.who || message.who === projectId) {
      if (message.by && message.by !== myName) return [...people.values()].find((person) => person.name === message.by) ?? { name: message.by, avatarId: null };
      return { name: myName, avatarId: myAvatar };
    }
    return people.get(message.who) ?? { name: message.by || '（未知）', avatarId: null };
  };
  // The canvas before each AI redraw, by the time of the answer that made it (this visit only), for 復原這次修改.
  const beforeAnswer = useRef(new Map<string, SceneElement[]>());
  const [undoable, setUndoable] = useState<Set<string>>(new Set());
  const [hasContent, setHasContent] = useState(board.elements.length > 0);
  const chatEnd = useRef<HTMLDivElement>(null);
  const canvasArea = useRef<HTMLDivElement>(null);
  const refAction = useRefAction();
  // What @@ offers is also what the AI may link boxes to; whiteboards load once, on first open.
  const refCandidates = useRefCandidates();
  const chatMe = useChatMe();
  useEffect(() => { ensureBoards(chatMe); }, [chatMe]);

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

  // DHC CLI 10/29 畫布: 存到白板 leaves a card and opens this window; the board it opens on gets it in mid-view, selected
  // so it can be dragged into place. It is an embeddable drawn by CanvasEmbed (see renderEmbeddable below).
  useEffect(() => {
    if (!excalidraw) return;
    const card = takePendingCanvasCard();
    if (!card) return;
    const view = excalidraw.getAppState();
    const zoom = view.zoom.value;
    const width = 640;
    const height = 440;
    const [base] = convertToExcalidrawElements([{
      type: 'rectangle',
      x: -view.scrollX + view.width / 2 / zoom - width / 2,
      y: -view.scrollY + view.height / 2 / zoom - height / 2,
      width,
      height,
    }]);
    const element = { ...base, type: 'embeddable', link: canvasLinkOf(card.storedName), backgroundColor: 'transparent', roundness: null, customData: { dhcCanvas: { title: card.title } } };
    excalidraw.setActiveTool({ type: 'selection' });
    excalidraw.updateScene({
      elements: [...excalidraw.getSceneElementsIncludingDeleted(), element] as never,
      appState: { selectedElementIds: { [element.id]: true } } as never,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
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
  // Ctrl+G groups (Excalidraw); pressed again on a selection that is already one whole group, it ungroups it
  // (Excalidraw itself only ungroups on Ctrl+Shift+G and does nothing on a second Ctrl+G).
  useEffect(() => {
    const area = canvasArea.current;
    if (!area || !excalidraw) return undefined;
    const toggle = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'g') return;
      if (!area.contains(document.activeElement) && document.activeElement !== document.body) return;
      const state = excalidraw.getAppState();
      if (state.editingTextElement) return;
      const groupId = wholeGroupOf(excalidraw.getSceneElements().filter((element) => !element.isDeleted), state.selectedElementIds);
      if (!groupId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const next = excalidraw.getSceneElements().map((element) => (element.groupIds.includes(groupId)
        ? newElementWith(element, { groupIds: element.groupIds.filter((id) => id !== groupId) })
        : element));
      excalidraw.updateScene({
        elements: next,
        appState: { selectedGroupIds: {}, editingGroupId: null } as never,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    };
    window.addEventListener('keydown', toggle, { capture: true });
    return () => window.removeEventListener('keydown', toggle, { capture: true });
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
  // Excalidraw shows nothing on a locked element (right-click 鎖定 / Ctrl+Shift+L), yet the eraser and clicks pass
  // through it, so it reads as "cannot be deleted". Say how many there are and offer to unlock them.
  const [lockedCount, setLockedCount] = useState(() => liveElements(board.elements).filter((element) => (element as { locked?: boolean }).locked).length);

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
    setLockedCount(live.filter((element) => (element as { locked?: boolean }).locked).length);
    setSceneTick((tick) => tick + 1);
    // A shared board keeps deleted elements, so the deletion reaches the others' pages.
    save(boardRef.current.co ? elements as SceneElement[] : live, chatRef.current);
  }, [onStyleChange, save]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: 'end' });
  }, [chat, busy]);

  const currentElements = () => liveElements(excalidraw?.getSceneElements() ?? board.elements);
  const allElements = () => (excalidraw?.getSceneElementsIncludingDeleted() ?? board.elements) as SceneElement[];
  const sceneForSave = () => (boardRef.current.co ? allElements() : currentElements());

  // Co-Work: the others' latest copy, merged in element by element (and their chat messages). Saved back only when
  // this page still has something the server's copy lacks: another page's save replaced the record without it.
  useEffect(() => {
    if (!excalidraw || !remote) return;
    const all = allElements();
    const merged = mergeElements(all, restoreElements(remote.elements as never, null)) as SceneElement[];
    if (elementsDiffer(all, merged)) {
      const live = liveElements(merged);
      signature.current = sceneSignature(live);
      excalidraw.updateScene({ elements: merged as never, captureUpdate: CaptureUpdateAction.NEVER });
      setHasContent(live.length > 0);
      setLockedCount(live.filter((element) => (element as { locked?: boolean }).locked).length);
      setSceneTick((tick) => tick + 1);
    }
    const chatNow = mergeChat(chatRef.current, remote.chat);
    if (chatNow.length !== chatRef.current.length) setChat(chatNow);
    if (hasUnsaved(remote.elements, merged)) save(merged, chatNow);
  }, [remote, excalidraw]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    const text = message.trim();
    if (!text || busy || !excalidraw) return;
    const history = chatRef.current;
    // On a shared board each question carries who asked it, for the others and for the AI.
    const by = boardRef.current.co ? myName : undefined;
    const withQuestion = [...history, {
      role: 'user' as const,
      text,
      at: new Date().toISOString(),
      ...(by ? { by } : {}),
      ...(projectId ? { who: projectId } : {}),
    }];
    setChat(withQuestion);
    save(sceneForSave(), withQuestion);
    setMessage('');
    setBusy(true);
    let answer = '';
    let snapshot: SceneElement[] | null = null;
    try {
      const scene = currentElements();
      const plan = sceneToPlan(scene);
      const modeNote = BOARD_MODES[boardRef.current.mode].aiNote;
      const selected = selectedBoxIds();
      const linkables = [...refCandidates.sessions, ...(refCandidates.boards ?? [])]
        .filter((ref): ref is PlanLink => (ref.kind === 'session' || ref.kind === 'board') && ref.id !== boardRef.current.id)
        .slice(0, MAX_LINKABLES);
      const image = await boardImage(excalidraw);
      const response = await api.planBoardAssist({
        board: {
          nodes: plan.nodes.map((node) => {
            const fill = plan.colors.get(node.id)?.fill;
            return fill ? { ...node, fill } : node;
          }),
          edges: plan.edges,
          loose: plan.loose,
        },
        chat: history.map((item) => (item.by ? { role: item.role, text: `${item.by}：${item.text}` } : { role: item.role, text: item.text })),
        message: `${by ? `（${by} 問）` : ''}${text}${modeNote}`,
        projectId,
        sessionId,
        selected,
        linkables,
        ...(image ? { image } : {}),
      });
      const payload = (await response.json().catch(() => null)) as { data?: { reply?: string; board?: unknown } } | null;
      if (!response.ok || !payload?.data) {
        answer = response.status === 404 ? '要等系統重啟後才能用 AI 畫圖。' : 'AI 這次沒有回應，稍後再試一次。';
        return;
      }
      answer = payload.data.reply ?? '';
      const drawn = payload.data.board;
      if (drawn && typeof drawn === 'object') {
        const raw = drawn as { nodes?: unknown; edges?: unknown; notes?: unknown; remove?: unknown };
        const parsed = acceptLinks(parseNodes(raw.nodes), linkables);
        const edges = parseEdges(raw.edges, parsed);
        const notes = parseNotes(raw.notes);
        const removeIds = new Set(Array.isArray(raw.remove) ? raw.remove.filter((id): id is string => typeof id === 'string') : []);
        // Boxes big enough for their text and clear of each other, then arrow labels need room between their boxes.
        const nodes = spreadForLabels(resolveOverlaps(fitBoxesToText(parsed)), edges);
        const all = allElements();
        const latest = liveElements(all);
        const before = sceneToPlan(latest);
        const looseKind = new Map(before.loose.map((item) => [item.id, item.kind]));
        const cleared = new Set([...removeIds].filter((id) => looseKind.has(id)));
        const sceneIds = new Set(all.map((element) => element.id));
        const moved = new Map(notes.filter((note) => note.id && looseKind.get(note.id) === 'text' && !cleared.has(note.id)).map((note) => [note.id!, note]));
        const added = notes.filter((note) => !note.id || !sceneIds.has(note.id));
        if (nodes.length > 0 || cleared.size > 0 || moved.size > 0 || added.length > 0) {
          let next: SceneElement[] = all;
          let change = { added: [] as string[], changed: [] as string[], removed: [] as string[] };
          if (nodes.length > 0) {
            const owned = redrawnIds(latest, before);
            const kept = all.filter((element) => !owned.has(element.id));
            const priorVersion = new Map(all.map((element) => [element.id, (element as { version?: number }).version ?? 0]));
            // Each redrawn element outranks the copy it replaces, and what the AI took away is marked deleted rather
            // than dropped, so on a shared board the others' pages take the redraw instead of merging the old one back.
            const redrawn = (convertToExcalidrawElements(planToSkeletons(nodes, edges, latest) as never, { regenerateIds: false }) as unknown as SceneElement[])
              .map((element) => (priorVersion.has(element.id) ? { ...element, version: priorVersion.get(element.id)! + 1 } : element));
            const redrawnIdSet = new Set(redrawn.map((element) => element.id));
            const removed = latest.filter((element) => owned.has(element.id) && !redrawnIdSet.has(element.id))
              .map((element) => newElementWith(element as Parameters<typeof newElementWith>[0], { isDeleted: true }) as unknown as SceneElement);
            next = [...kept, ...removed, ...redrawn];
            change = diffNodes(before.nodes, nodes);
          }
          // Loose things: what the AI cleared is marked deleted (like a removed box), a moved or reworded note is
          // edited in place (its size re-measured for the new text), and a new note is a plain text element.
          next = next.map((element) => {
            if (cleared.has(element.id) || (element.containerId && cleared.has(element.containerId))) return newElementWith(element as Parameters<typeof newElementWith>[0], { isDeleted: true }) as unknown as SceneElement;
            const note = moved.get(element.id);
            if (!note) return element;
            const edited = newElementWith(element as Parameters<typeof newElementWith>[0], { x: note.x, y: note.y, text: note.text, originalText: note.text } as never);
            return restoreElements([edited], null, { refreshDimensions: true })[0] as unknown as SceneElement;
          });
          if (added.length > 0) {
            next = [...next, ...(convertToExcalidrawElements(added.map((note) => ({ type: 'text', x: note.x, y: note.y, text: note.text })) as never) as unknown as SceneElement[])];
          }
          excalidraw.updateScene({ elements: next as never, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
          excalidraw.scrollToContent(undefined, { fitToContent: true, animate: true });
          const touched = [...change.added, ...change.changed];
          // What changed is left selected, so it stands out until the next click.
          if (touched.length > 0) {
            excalidraw.updateScene({
              appState: { selectedElementIds: Object.fromEntries(touched.map((id) => [id, true])) } as never,
              captureUpdate: CaptureUpdateAction.NEVER,
            });
          }
          const counts = [
            change.added.length > 0 && `新增 ${change.added.length}`,
            change.changed.length > 0 && `修改 ${change.changed.length}`,
            change.removed.length > 0 && `刪除 ${change.removed.length}`,
          ].filter(Boolean).join('、');
          const tidied = cleared.size > 0 ? `${counts ? '；' : '：'}清掉 ${cleared.size} 個多餘的線或註記` : '';
          answer += `\n（白板已更新${counts ? `：${counts} 個方框，改到的已選起來` : ''}${tidied}。不滿意按下面「復原這次修改」）`;
          snapshot = latest;
        }
      }
    } catch {
      answer = '連不到伺服器，稍後再試一次。';
    } finally {
      const at = new Date().toISOString();
      const withAnswer = [...chatRef.current, { role: 'assistant' as const, text: answer, at }];
      if (snapshot) {
        beforeAnswer.current.set(at, snapshot);
        setUndoable((set) => new Set(set).add(at));
      }
      setChat(withAnswer);
      save(sceneForSave(), withAnswer);
      setBusy(false);
    }
  };

  /** Selected boxes, a selected label counting as its box. */
  const selectedBoxIds = () => {
    const elements = currentElements();
    const byId = new Map(elements.map((element) => [element.id, element]));
    const boxes = new Set(sceneToPlan(elements).nodes.map((node) => node.id));
    const ids = Object.keys(tools.selectedIds).map((id) => byId.get(id)?.containerId ?? id);
    return [...new Set(ids)].filter((id) => boxes.has(id));
  };

  /** Back to the canvas as it was just before that answer redrew it (a later hand edit is undone with it). */
  const undoAnswer = (at: string) => {
    const before = beforeAnswer.current.get(at);
    if (!excalidraw || !before) return;
    if (!window.confirm('回到這次 AI 修改之前的白板？之後手動改的地方也會一起回去。')) return;
    excalidraw.updateScene({ elements: restoreTo(allElements(), before) as never, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    beforeAnswer.current.delete(at);
    setUndoable((set) => {
      const next = new Set(set);
      next.delete(at);
      return next;
    });
  };

  const dragChatWidth = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = chatWidth;
    let width = startWidth;
    const move = (moveEvent: PointerEvent) => {
      width = Math.min(CHAT_WIDTH.max, Math.max(CHAT_WIDTH.min, startWidth + startX - moveEvent.clientX));
      setChatWidth(width);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try { localStorage.setItem(CHAT_WIDTH_KEY, String(width)); } catch { /* this page load only */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const brief = () => {
    const scene = currentElements();
    save(scene, chatRef.current);
    return boardBrief(boardRef.current.name, sceneToPlan(scene), chatRef.current, BOARD_MODES[boardRef.current.mode]);
  };
  const startWork = () => {
    if (onStartWork) onStartWork(brief());
  };
  const sendToChat = () => {
    if (onSendToChat) onSendToChat(brief());
  };
  const selectedCount = useMemo(() => (excalidraw ? selectedBoxIds().length : 0), [tools.selectedIds, excalidraw]); // eslint-disable-line react-hooks/exhaustive-deps
  // Out of the way while Excalidraw's own side panel (library, search) is open.
  const showColors = Boolean(excalidraw) && !tools.sidebarOpen
    && (Object.keys(tools.selectedIds).length > 0 || DRAWING_TOOLS.has(tools.tool));

  const isDark = document.documentElement.classList.contains('dark');
  const boardChatContext = useChatPanel().boardContext;

  const unlockAll = () => {
    if (!excalidraw) return;
    const next = excalidraw.getSceneElements().map((element) => (element.locked ? newElementWith(element, { locked: false }) : element));
    excalidraw.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  };

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
            validateEmbeddable={(link: string) => (storedNameOfLink(link) ? true : undefined)}
            renderEmbeddable={(element) => (storedNameOfLink(element.link)
              ? <CanvasEmbed link={element.link as string} title={(element.customData as { dhcCanvas?: { title?: string } } | undefined)?.dhcCanvas?.title} />
              : null)}
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
          {excalidraw && <BoxLinksLayer api={excalidraw} onJump={(ref) => { onLeave(); refAction(ref); }} />}
          {excalidraw && canvasArea.current && <BoxRefPicker api={excalidraw} area={canvasArea.current} />}
          {excalidraw && (
            <BoardNotesLayer
              board={{ kind: 'board', id: board.id, title: board.name }}
              view={excalidraw as unknown as BoardView}
              context={boardChatContext?.id === board.id ? boardChatContext : null}
            />
          )}
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
          {lockedCount > 0 && excalidraw && (
            <div
              data-testid="board-locked-hint"
              className={cn(
                'absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-amber-500/60 bg-background/95 px-2.5 py-1.5 text-xs text-foreground shadow-lg',
                isMobile ? 'top-14' : 'bottom-3',
              )}
            >
              <Lock className="h-3.5 w-3.5 text-amber-500" />
              有 {lockedCount} 個鎖定的元素，選不到也擦不掉
              <button type="button" onClick={unlockAll} className="rounded border border-border px-1.5 py-0.5 hover:border-primary hover:bg-muted">
                全部解鎖
              </button>
            </div>
          )}
          {/* 11/01: the bottom bar is gone; 帶回目前對話 and 開工 sit at the canvas's bottom right, left of Excalidraw's help. */}
          <div className={cn('absolute right-14 z-10 flex items-center gap-2', isMobile ? 'top-14' : 'bottom-4')}>
            {isMobile && (
              <button
                type="button"
                onClick={() => setShowChat(!showChat)}
                className={cn('flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground shadow hover:bg-muted', showChat && 'border-primary text-primary')}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                AI
              </button>
            )}
            {onSendToChat && (
              <button
                type="button"
                onClick={sendToChat}
                disabled={!hasContent}
                title="關掉白板，把這張圖的工作說明放進剛才那段對話的輸入框（不會自動送出）"
                className="flex items-center gap-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow hover:bg-muted disabled:opacity-40"
              >
                <CornerDownLeft className="h-3.5 w-3.5" />
                帶回目前對話
              </button>
            )}
            <button
              type="button"
              onClick={startWork}
              disabled={!hasContent || !onStartWork}
              title={onStartWork ? undefined : '這台裝置的專案設定沒有對應的專案，先到 設定 → 專案設定 選好你的專案才能開工。'}
              data-tutorial-tip={`開工：開一個新對話，把這張圖當工作說明送出${board.mode === 'free' ? '' : `（${BOARD_MODES[board.mode].label}模式）`}`}
              className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5" />
              開工
            </button>
          </div>
        </div>

        {showChat && (
          <div
            className={cn('relative flex min-h-0 flex-col border-l border-border bg-background', isMobile && 'absolute inset-x-0 bottom-0 z-20 h-1/2 border-t')}
            data-tutorial-tip="AI 助手：說想規劃什麼，它會在白板上畫出來，可繼續叫它改"
            style={isMobile ? undefined : { width: chatWidth }}
          >
            {!isMobile && (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="拖曳調整對話欄寬度"
                title="拖曳調整寬度"
                onPointerDown={dragChatWidth}
                className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-primary/30"
              />
            )}
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-sm">
              {chat.length === 0 && (
                <p data-tutorial className="text-xs leading-relaxed text-muted-foreground">{BOARD_MODES[board.mode].intro}</p>
              )}
              {chat.map((item, index) => (
                <div key={index} data-testid="board-chat-message" className={cn('flex flex-col', item.role === 'user' ? 'items-end' : 'items-start')}>
                  {item.role === 'user' ? (
                    <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span>{speakerOf(item).name}</span>
                      <PersonAvatar person={speakerOf(item)} className="h-5 w-5 shrink-0" />
                    </div>
                  ) : (
                    <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-primary">
                        <Sparkles className="h-3 w-3" />
                      </span>
                      <span>AI 助手</span>
                    </div>
                  )}
                <div
                  className={cn(
                    'whitespace-pre-wrap rounded-lg px-2.5 py-1.5',
                    item.role === 'user' ? 'ml-6 bg-primary text-primary-foreground' : 'mr-6 bg-muted text-foreground',
                  )}
                >
                  {item.text}
                  {item.at && undoable.has(item.at) && (
                    <button
                      type="button"
                      onClick={() => undoAnswer(item.at!)}
                      className="mt-1.5 flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground hover:border-primary"
                    >
                      <Undo2 className="h-3 w-3" />
                      復原這次修改
                    </button>
                  )}
                </div>
                </div>
              ))}
              {busy && (
                <div className="mr-6 flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  AI 正在查記憶和畫圖（約 30–120 秒）
                </div>
              )}
              <div ref={chatEnd} />
            </div>
            {selectedCount > 0 && (
              <div data-testid="board-selected-chip" className="flex items-center gap-1 border-t border-border px-2 pt-1.5 text-xs text-primary">
                <MousePointer2 className="h-3 w-3" />
                已選 {selectedCount} 個方框，說「這個」「它們」就是指它們
              </div>
            )}
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
                placeholder="要畫或改什麼？"
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
  /** The conversation open behind the board: the AI reads its latest messages, and 帶回目前對話 drafts the brief there. */
  sessionId: string | null;
  onSendToChat: ((brief: string) => void) | null;
  /** 10/16: open on this board (a @@whiteboard jump from the chat room or a sticky note). */
  initialBoardId?: string | null;
};

/** DHC CLI 10/13 規劃白板: full-screen Excalidraw canvas with the person's boards, an AI chat beside it, and 開工. */
export default function PlanBoardWindow({ profileId, profileName, legacyProjectId, isMobile, onClose, onStartWork, sessionId, onSendToChat, initialBoardId }: PlanBoardProps) {
  const isTeamMode = useIsTeamMode();
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

  // Co-Work: this person is their project; shared boards come from the shared record and save back there.
  const me = legacyProjectId;
  const coSaver = useMemo(() => createCoBoardSaver(() => setFailed(true)), []);
  const people = useCoPeople();
  const nameOf = useCallback((projectId: string) => people.get(projectId)?.name ?? '（未知）', [people]);
  const [remote, setRemote] = useState<CoBoard | null>(null);
  const [coNote, setCoNote] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  // 11/01: on a phone the secondary tools fold into this ⋯ menu so the close button always fits.
  const [toolsOpen, setToolsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadBoards(profileId, legacyProjectId), loadCoBoards(me).catch(() => [] as CoBoard[])])
      .then(([{ boards: stored, style: savedStyle }, shared]) => {
        if (cancelled) return;
        let list = stored;
        setStyle(savedStyle);
        if (list.length === 0 && shared.length === 0) {
          const first = emptyBoard('我的第一張白板');
          saver.save(first);
          list = [first];
        }
        const all = [...shared, ...list];
        setBoards(all);
        const last = localStorage.getItem(lastBoardKey(profileId));
        setActiveId(all.find((board) => board.id === initialBoardId)?.id ?? all.find((board) => board.id === last)?.id ?? all[0].id);
        if (initialBoardId && !all.some((board) => board.id === initialBoardId)) setCoNote('那張白板不是你的、也沒有和你 Co-Work，打不開；請對方用 Co-Work 邀請你。');
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [profileId, legacyProjectId, saver, me, initialBoardId]);

  const close = useCallback(() => {
    void saver.flush();
    void coSaver.flush();
    onClose();
  }, [onClose, saver, coSaver]);

  const active = boards?.find((board) => board.id === activeId) ?? null;

  // DHC CLI 10/16 聊天室: the open board gets its own room tab; opening it clears its mentions of you.
  const activeName = active?.name ?? '';
  const activeMembers = active ? (active.co ? [active.co.ownerProjectId, ...active.co.members] : me ? [me] : undefined) : undefined;
  const membersKey = activeMembers?.join(',') ?? '';
  useEffect(() => {
    setBoardContext(activeId ? { kind: 'board', id: activeId, title: activeName, members: membersKey ? membersKey.split(',') : undefined } : null);
    if (activeId) markSeen(roomOfBoard(activeId));
  }, [activeId, activeName, membersKey]);
  useEffect(() => {
    if (activeId) try { localStorage.setItem(lastBoardKey(profileId), activeId); } catch { /* this page load only */ }
  }, [activeId, profileId]);
  useEffect(() => () => setBoardContext(null), []);
  const update = useCallback((board: PlanBoard) => {
    setBoards((list) => (list ?? []).map((item) => (item.id === board.id ? board : item)));
    if (board.co) coSaver.save(board as CoBoard);
    else saver.save(board);
  }, [saver, coSaver]);

  // The others' changes: every 5 seconds while a shared board is open, otherwise once a minute (new invitations),
  // only while the page is in view. The open board's copy goes to the canvas to merge; the rest replace the list.
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const activeShared = Boolean(active?.co);
  useEffect(() => {
    if (!me || !boards) return undefined;
    let cancelled = false;
    const pull = async () => {
      if (document.visibilityState !== 'visible') return;
      let shared: CoBoard[];
      try { shared = await loadCoBoards(me); } catch { return; }
      if (cancelled) return;
      const fresh = new Map(shared.map((board) => [board.id, board]));
      const open = activeRef.current;
      setRemote(open ? fresh.get(open) ?? null : null);
      setBoards((list) => {
        if (!list) return list;
        const known = new Set(list.map((board) => board.id));
        const next = list.flatMap((board) => {
          if (!board.co) return [board];
          const latest = fresh.get(board.id);
          if (!latest) return [];
          // The open board keeps what the canvas holds; only its name, mode and who is in it come from the server.
          return [board.id === open ? { ...board, name: latest.name, mode: latest.mode, co: latest.co } : latest];
        });
        return [...shared.filter((board) => !known.has(board.id)), ...next];
      });
    };
    const timer = window.setInterval(() => { void pull(); }, activeShared ? 5_000 : 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [me, activeShared, Boolean(boards)]); // eslint-disable-line react-hooks/exhaustive-deps

  // The open board stopped being shared with this person (they were taken off, or the owner ended it).
  useEffect(() => {
    if (!boards || activeId === null || boards.some((board) => board.id === activeId)) return;
    setCoNote('這張共享白板已結束或你已不在成員裡。');
    if (boards.length > 0) setActiveId(boards[0].id);
    else {
      const first = emptyBoard('我的第一張白板');
      saver.save(first);
      setBoards([first]);
      setActiveId(first.id);
    }
  }, [boards, activeId, saver]);

  // Opening a board someone shared says who shared it (and their note), then clears the invitation.
  useEffect(() => {
    const invite = me ? active?.co?.invites?.[me] : undefined;
    if (!me || !active || !invite) return;
    setCoNote(`${nameOf(invite.from)} 分享了「${active.name}」給你${invite.message ? `：${invite.message}` : ''}（按一下關掉）`);
    void coSaver.change(active.id, (server) => {
      if (!server?.co.invites?.[me]) return server ?? null;
      const { [me]: _seen, ...invites } = server.co.invites;
      const co = { ...server.co };
      if (Object.keys(invites).length > 0) co.invites = invites;
      else delete co.invites;
      return { ...server, co };
    });
  }, [me, active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const invitations = (boards ?? []).filter((board) => me && board.id !== activeId && board.co?.invites?.[me]);

  /** Shares the open board with exactly `members` (the owner); an empty list makes it the owner's own board again. */
  const shareWith = async (members: string[], message: string) => {
    if (!active || !me) return;
    const owner = active.co?.ownerProjectId ?? me;
    const invite = { from: me, message };
    if (!active.co) {
      const shared = withMembers(active, owner, members, invite);
      if (!shared) return;
      await coSaver.change(shared.id, () => shared);
      saver.remove(active.id);
      setBoards((list) => (list ?? []).map((board) => (board.id === shared.id ? shared : board)));
      return;
    }
    if (members.length === 0) {
      const personal = toPersonal({ ...(active as CoBoard) });
      await coSaver.change(active.id, () => null);
      saver.save(personal);
      setBoards((list) => (list ?? []).map((board) => (board.id === personal.id ? personal : board)));
      return;
    }
    await coSaver.change(active.id, (server) => (server ? withMembers(server, owner, members, invite) : null));
    const shared = withMembers(active, owner, members, invite);
    if (shared) setBoards((list) => (list ?? []).map((board) => (board.id === shared.id ? { ...board, co: shared.co } : board)));
  };
  const setMode = (mode: BoardMode) => {
    if (active) update({ ...active, mode, updatedAt: new Date().toISOString() });
  };
  const plan = useMemo(() => sceneToPlan((active?.elements ?? []) as SceneElement[]), [active?.elements]);
  // 11/01: a new board starts empty with its name box open; left blank, it names itself from what comes first.
  const [naming, setNaming] = useState(false);
  const create = () => {
    const board: PlanBoard = { ...emptyBoard(`白板 ${(boards?.length ?? 0) + 1}`, active?.mode ?? 'free'), autoName: true };
    setBoards((list) => [board, ...(list ?? [])]);
    setActiveId(board.id);
    saver.save(board);
    setNaming(true);
  };
  const rename = (typed: string) => {
    setNaming(false);
    const name = typed.trim();
    if (!active || !name || (name === active.name && !active.autoName)) return;
    const { autoName: _auto, ...rest } = active;
    update({ ...rest, name, updatedAt: new Date().toISOString() });
  };
  const autoName = active?.autoName ? autoNameOf(active.chat, plan.nodes) : null;
  useEffect(() => {
    if (!active?.autoName || !autoName || naming) return undefined;
    // Waits for a pause so a box being typed into is not named after its first letter.
    const timer = window.setTimeout(() => {
      const { autoName: _auto, ...rest } = active;
      update({ ...rest, name: autoName, updatedAt: new Date().toISOString() });
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [active, autoName, naming, update]);
  const remove = () => {
    if (!active || !boards) return;
    if (active.co && me) {
      const isOwner = active.co.ownerProjectId === me;
      const ask = isOwner
        ? `刪除共享白板「${active.name}」？所有成員都會看不到，刪了就找不回來。`
        : `退出共享白板「${active.name}」？白板會留給其他人，你這邊不再列出。`;
      if (!window.confirm(ask)) return;
      void coSaver.change(active.id, (server) => (isOwner || !server ? null : withoutMember(server, me)));
    } else {
      if (!window.confirm(`刪除白板「${active.name}」？刪了就找不回來。`)) return;
      saver.remove(active.id);
    }
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
    await Promise.all([saver.flush(), coSaver.flush()]);
    onStartWork?.(brief);
    onClose();
  };
  const sendToChat = async (brief: string) => {
    await Promise.all([saver.flush(), coSaver.flush()]);
    onSendToChat?.(brief);
    onClose();
  };

  // 轉成專案板: boxes become cards in arrow order; the page closes this window and opens 專案板, which makes a new board.
  const toProjectBoard = async () => {
    if (!active || plan.nodes.length === 0) return;
    await saver.flush();
    sendToTool({ tool: 'project-board', kind: 'cards', payload: { boardName: active.name, cards: boardToCards(plan.nodes, plan.edges) }, from: `規劃白板『${active.name}』` });
  };

  const boardChips = active && (
    <>
      <CopyNameButton chip={{ kind: 'board', id: active.id, label: active.name }} />
      <NoteButton target={{ kind: 'board', id: active.id, title: active.name }} />
      <ChatRoomButton kind="board" id={active.id} />
    </>
  );
  const coWorkButton = isTeamMode && me && active && (
    <button
      type="button"
      onClick={() => setShareOpen(true)}
      disabled={Boolean(active.co) && active.co?.ownerProjectId !== me}
      title={active.co
        ? `共享中：${[active.co.ownerProjectId, ...active.co.members].map(nameOf).join('、')}${active.co.ownerProjectId === me ? '（按一下改成員）' : '（只有建立者能改成員）'}`
        : '邀請同事一起畫這張白板（大家改的會互相合併，約 5 秒同步一次）'}
      className={cn('flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted', active.co ? 'border-primary text-primary' : 'border-border bg-background text-foreground')}
    >
      <Users className="h-3.5 w-3.5" />
      {active.co ? `Co-Work · ${active.co.members.length + 1} 人` : 'Co-Work'}
    </button>
  );
  const deleteButton = (
    <button type="button" onClick={remove} disabled={!active} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive" title={active?.co && active.co.ownerProjectId !== me ? '退出這張共享白板' : '刪除這張白板'} aria-label="刪除這張白板">
      <Trash2 className="h-4 w-4" />
    </button>
  );
  const importButton = (
    <button
      type="button"
      onClick={() => fileInput.current?.click()}
      title="匯入 Excalidraw 白板檔（.excalidraw／.json）或 Mermaid 流程圖（.mmd／.md／.txt），變成新白板；也可以直接把檔案拖進視窗"
      className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted"
    >
      <Upload className="h-3.5 w-3.5" />
      匯入
    </button>
  );
  const projectBoardButton = (
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
  );

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background" role="dialog" aria-label="規劃白板">
      <div className="relative z-30 flex h-12 flex-shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3 max-md:h-auto max-md:min-h-12 max-md:flex-wrap max-md:py-1.5">
        <Workflow className="h-4 w-4 shrink-0 text-primary" />
        <span className="shrink-0 text-sm font-semibold text-foreground max-md:hidden">規劃白板</span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground max-md:hidden" title="白板跟著這台裝置的專案設定（帳號）走，別人看不到">{profileName}</span>
        {boards && (
          <BoardPicker
            boards={boards}
            active={active}
            naming={naming}
            onPick={(id) => { setNaming(false); setActiveId(id); }}
            onCreate={create}
            onStartRename={() => setNaming(true)}
            onRename={rename}
          />
        )}
        {active && (
          <select
            aria-label="白板模式"
            title="模式決定 AI 怎麼排版、開工要產出什麼"
            value={active.mode}
            onChange={(event) => setMode(event.target.value as BoardMode)}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground max-md:min-w-0 max-md:max-w-[7rem] max-md:shrink"
          >
            {MODE_ORDER.map((mode) => <option key={mode} value={mode}>模式：{BOARD_MODES[mode].label}</option>)}
          </select>
        )}
        <div className="contents max-md:hidden">
          {boardChips}
          {coWorkButton}
          {deleteButton}
          {importButton}
          {projectBoardButton}
        </div>
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
        <div className="relative hidden max-md:ml-auto max-md:block">
          <button
            type="button"
            onClick={() => setToolsOpen((value) => !value)}
            aria-label="更多工具"
            aria-expanded={toolsOpen}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Ellipsis className="h-4 w-4" />
          </button>
          {toolsOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setToolsOpen(false)} />
              <div
                role="menu"
                aria-label="更多工具"
                onClick={(event) => { if ((event.target as HTMLElement).closest('button')) setToolsOpen(false); }}
                className="fixed right-2 top-12 z-50 flex w-56 max-w-[calc(100vw-1rem)] flex-wrap items-center gap-2 rounded-md border border-border bg-background p-2 shadow-xl"
              >
                {boardChips}
                {coWorkButton}
                {deleteButton}
                {importButton}
                {projectBoardButton}
              </div>
            </>
          )}
        </div>
        {importNote && (
          <button type="button" onClick={() => setImportNote('')} title="按一下關掉" className="max-w-[24rem] truncate text-xs text-muted-foreground hover:text-foreground max-md:order-last max-md:max-w-full max-md:basis-full max-md:text-left">
            {importNote}
          </button>
        )}
        {invitations.map((board) => {
          const invite = board.co!.invites![me!];
          return (
            <button
              key={board.id}
              type="button"
              data-testid="board-invite"
              onClick={() => setActiveId(board.id)}
              title={invite.message || '按一下打開'}
              className="flex max-w-72 shrink-0 items-center gap-1 truncate max-md:order-last max-md:max-w-full max-md:basis-full rounded-md border border-amber-500/60 bg-amber-500/10 px-2 py-1 text-xs text-foreground hover:bg-amber-500/20"
            >
              <Users className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              {nameOf(invite.from)} 分享了「{board.name}」{invite.message ? `：${invite.message}` : ''}
            </button>
          );
        })}
        {coNote && (
          <button type="button" onClick={() => setCoNote('')} title="按一下關掉" className="truncate text-xs text-amber-500 max-md:order-last max-md:basis-full max-md:text-left">{coNote}</button>
        )}
        {failed && <span className="truncate text-xs text-destructive max-md:order-last max-md:basis-full">有變更沒存到伺服器，請稍後重新整理再確認。</span>}
        <button type="button" onClick={close} aria-label="關閉白板" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground md:ml-auto max-md:order-2 max-md:shrink-0">
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
          onSendToChat={onSendToChat ? (brief) => void sendToChat(brief) : null}
          projectId={legacyProjectId}
          sessionId={sessionId}
          remote={remote?.id === active.id ? remote : null}
          myName={profileName}
          onLeave={close}
        />
      ) : null}
      {isTeamMode && shareOpen && active && me && (
        <BoardShareDialog
          boardName={active.name}
          me={me}
          members={active.co?.members ?? []}
          people={people}
          onCancel={() => setShareOpen(false)}
          onSave={async (members, message) => {
            await shareWith(members, message);
            setShareOpen(false);
          }}
        />
      )}
    </div>
  );
}
