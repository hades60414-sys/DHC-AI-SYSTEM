import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronLeft, ChevronRight, Code2, Copy, Download, FilePenLine, LayoutPanelLeft, MousePointerClick, Presentation, Terminal, X } from 'lucide-react';

import { api } from '@/shared/api';
import { requestOpenBoard } from '@/shared/chatRoom';
import { readActiveSettingsProfileId } from '@/shared/userSettings';
import { CANVAS_SANDBOX, pageFor, readBridgeMessage, selectCommand, withBridge } from '@/modules/canvas/canvasBridge';
import type { BridgeMessage, CanvasRect } from '@/modules/canvas/canvasBridge';
import type { CanvasDoc } from '@/modules/canvas/canvasModel';
import { closeCanvas, selectCanvasDoc, setCanvasCurrent, setPendingCanvasCard, useCanvasDocs, useCanvasState } from '@/modules/canvas/canvasStore';

/**
 * DHC CLI 10/29 畫布 panel beside the chat: the live page (預覽), its source (程式碼), what it printed (主控台), the
 * versions one by one, 框選修改 (pick an element or highlight text, say what to change, it goes to the chat as a
 * turn), and 存到白板 (the page becomes a card on the whiteboard that still works there).
 */
type Tab = 'preview' | 'code' | 'console';
type ConsoleLine = { level: string; text: string; at: number };
type Picked = { label: string; snippet: string; selector?: string; rect: CanvasRect; asking: boolean };

const WIDTH_KEY = 'dhc.canvasWidth';
const WIDTH = { min: 360, initial: 560 };

/** 11/01: a restored or first width never takes more than 3/4 of the window (a width saved on a bigger screen used to crowd the chat out). */
export const clampCanvasWidth = (width: number, viewport: number): number => Math.min(Math.max(WIDTH.min, Math.round(viewport * 0.75)), Math.max(WIDTH.min, width));
const MAX_CONSOLE = 200;
const BOARD_LAST_KEY = (profileId: string) => `dhc.boardLast:p:${profileId}`;

function renderMarkdown(content: string): string {
  return renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>);
}

/** The whole page for a version, as it is downloaded or put on the whiteboard (no bridge in it). */
export function pageOfDoc(doc: CanvasDoc, content: string): string {
  return pageFor(doc.kind, content, doc.kind === 'md' ? renderMarkdown(content) : undefined);
}

/** The chat turn 框選修改 sends. */
export function selectionPrompt(doc: CanvasDoc, versionNo: number, picked: Pick<Picked, 'snippet' | 'selector'>, ask: string): string {
  const where = doc.path ? `檔案：${doc.path}（畫布第 ${versionNo} 版）` : `回覆裡的網頁（畫布第 ${versionNo} 版）`;
  const how = doc.path ? '用 Edit 只改這一段，其餘保持原樣。' : '只改這一段，其餘保持原樣，回覆修改後完整的 ```html 區塊。';
  return [
    `[畫布框選修改] ${where}`,
    '選取的部分：',
    '```html',
    picked.snippet,
    '```',
    ...(picked.selector ? [`選取器：${picked.selector}`] : []),
    `要求：${ask.trim()}`,
    how,
  ].join('\n');
}

const fileNameOf = (doc: CanvasDoc) => {
  const base = (doc.path?.split(/[\\/]/).pop() ?? doc.title).replace(/\.(md|markdown|svg|htm)$/i, '');
  return /\.html$/i.test(base) ? base : `${base}.html`;
};

export default function CanvasPanel({ isMobile, onOpenInEditor }: { isMobile: boolean; onOpenInEditor?: (path: string) => void }) {
  const state = useCanvasState();
  const docs = useCanvasDocs();
  const doc = docs.find((item) => item.id === state.activeDocId) ?? docs[0] ?? null;
  const [versionIndex, setVersionIndex] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('preview');
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [ask, setAsk] = useState('');
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [width, setWidth] = useState(() => clampCanvasWidth(Number(localStorage.getItem(WIDTH_KEY)) || WIDTH.initial, window.innerWidth));
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // A new version (or another document) shows its newest; stepping back is a choice the next version undoes.
  const versionCount = doc?.versions.length ?? 0;
  useEffect(() => { setVersionIndex(null); }, [doc?.id, versionCount]);
  const index = Math.min(versionIndex ?? versionCount - 1, versionCount - 1);
  const version = doc && index >= 0 ? doc.versions[index] : null;
  const content = version?.content ?? null;

  // A file first changed by Edit: fetch it as it is now so the versions can be worked out backwards.
  // 11/01: read again when a later Edit/Write arrives, so the answer is never older than the newest version.
  const newestKey = doc?.versions[doc.versions.length - 1]?.messageKey ?? '';
  const needsPath = doc?.needsCurrent && doc.path && !state.currents.has(doc.path) ? doc.path : null;
  useEffect(() => {
    if (!needsPath || !state.projectId) return undefined;
    let cancelled = false;
    api.readFile(state.projectId, needsPath)
      .then(async (response) => (response.ok ? String((await response.json()).content ?? '') : null))
      .catch(() => null)
      .then((text) => { if (!cancelled) setCanvasCurrent(needsPath, text); });
    return () => { cancelled = true; };
  }, [needsPath, state.projectId, newestKey]);

  const page = useMemo(() => (doc && content !== null ? pageOfDoc(doc, content) : null), [doc, content]);
  const srcDoc = useMemo(() => (page ? withBridge(page) : null), [page]);

  useEffect(() => {
    setConsoleLines([]);
    setPicked(null);
  }, [srcDoc]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message: BridgeMessage | null = readBridgeMessage(event, frameRef.current?.contentWindow);
      if (!message) return;
      if (message.type === 'ready') {
        if (selecting) frameRef.current?.contentWindow?.postMessage(selectCommand(true), '*');
      } else if (message.type === 'console') {
        setConsoleLines((lines) => [...lines, { level: message.level, text: message.text, at: Date.now() }].slice(-MAX_CONSOLE));
      } else if (message.type === 'select') {
        setPicked({ label: message.text.trim().slice(0, 60) || message.selector, snippet: message.html, selector: message.selector, rect: message.rect, asking: true });
        setSelecting(false);
      } else if (message.type === 'text') {
        setPicked({ label: message.text.trim().slice(0, 60), snippet: message.text, rect: message.rect, asking: false });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [selecting]);

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(selectCommand(selecting), '*');
  }, [selecting]);

  const flash = useCallback((text: string) => {
    setNote(text);
    window.setTimeout(() => setNote((current) => (current === text ? '' : current)), 4000);
  }, []);

  const send = () => {
    if (!doc || !picked || !ask.trim() || !state.submitText) return;
    state.submitText(selectionPrompt(doc, index + 1, picked, ask));
    setPicked(null);
    setAsk('');
    flash('已送到對話，Claude 改好後畫布會換成新的一版。');
  };

  const download = () => {
    if (!doc || !page) return;
    const url = URL.createObjectURL(new Blob([page], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileNameOf(doc);
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const saveToBoard = async () => {
    if (!doc || !page || busy) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('files', new File([page], fileNameOf(doc), { type: 'text/html' }));
      const response = await api.assets.uploadFiles(form);
      if (!response.ok) throw new Error(String(response.status));
      // The record's path ends in the stored file name (`<ts>-<rand>-<name>` under ~/.cloudcli/assets).
      const storedName = String((await response.json()).attachments?.[0]?.path ?? '').split('/').pop();
      if (!storedName) throw new Error('no stored name');
      setPendingCanvasCard({ storedName, title: doc.title });
      const profileId = readActiveSettingsProfileId();
      let last = '';
      try { last = profileId ? localStorage.getItem(BOARD_LAST_KEY(profileId)) ?? '' : ''; } catch { /* none */ }
      requestOpenBoard(last);
    } catch {
      flash('存到白板失敗，請再試一次。');
    } finally {
      setBusy(false);
    }
  };

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const max = clampCanvasWidth(Infinity, window.innerWidth);
    let next = startWidth;
    const move = (moveEvent: PointerEvent) => {
      next = Math.min(max, Math.max(WIDTH.min, startWidth + startX - moveEvent.clientX));
      setWidth(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try { localStorage.setItem(WIDTH_KEY, String(next)); } catch { /* this page load only */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (!state.open) return null;
  const errors = consoleLines.filter((line) => line.level === 'error').length;
  const iconButton = 'inline-flex h-7 flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';
  const tabButton = (value: Tab, label: string, Icon: typeof Code2, badge?: number) => (
    <button type="button" onClick={() => setTab(value)} aria-pressed={tab === value}
      className={`${iconButton} ${tab === value ? 'bg-muted text-foreground' : ''}`}>
      <Icon className="h-3.5 w-3.5" />{label}
      {badge ? <span className="rounded-full bg-red-500 px-1.5 text-[10px] font-medium text-white">{badge}</span> : null}
    </button>
  );
  const popupStyle = picked && bodyRef.current
    ? { left: Math.max(8, Math.min(picked.rect.x, bodyRef.current.clientWidth - 328)), top: Math.max(8, Math.min(picked.rect.y + picked.rect.h + 6, bodyRef.current.clientHeight - (picked.asking ? 150 : 40))) }
    : undefined;

  return (
    <aside
      data-dhc-canvas=""
      aria-label="畫布"
      className={isMobile ? 'fixed inset-0 z-50 flex flex-col bg-background' : 'relative flex h-full flex-shrink-0 flex-col border-l border-border bg-background'}
      style={isMobile ? undefined : { width }}
    >
      {!isMobile && (
        <div role="separator" aria-label="調整畫布寬度" onPointerDown={startResize}
          className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-primary/20" />
      )}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <LayoutPanelLeft className="h-4 w-4 flex-shrink-0 text-primary" />
        {docs.length > 1 ? (
          <select value={doc?.id ?? ''} onChange={(event) => selectCanvasDoc(event.target.value)} aria-label="切換畫布"
            className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-1.5 py-1 text-sm">
            {docs.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={doc?.path}>{doc?.title ?? '畫布'}</span>
        )}
        <button type="button" onClick={closeCanvas} aria-label="關閉畫布" className={iconButton}><X className="h-4 w-4" /></button>
      </div>

      {doc ? (
        <>
          <div className="flex items-center gap-0.5 overflow-x-auto border-b border-border px-1.5 py-1">
            <button type="button" className={iconButton} disabled={index <= 0} onClick={() => setVersionIndex(index - 1)} aria-label="上一版"><ChevronLeft className="h-4 w-4" /></button>
            <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">第 {index + 1}／{versionCount} 版</span>
            <button type="button" className={iconButton} disabled={index >= versionCount - 1} onClick={() => setVersionIndex(index + 1)} aria-label="下一版"><ChevronRight className="h-4 w-4" /></button>
            <span className="mx-1 h-4 w-px bg-border" />
            {tabButton('preview', '預覽', Presentation)}
            {tabButton('code', '程式碼', Code2)}
            {tabButton('console', '主控台', Terminal, errors)}
            <span className="flex-1" />
            <button type="button" disabled={!srcDoc || !state.submitText} aria-pressed={selecting}
              title="點選畫面上的一個區塊，告訴 Claude 只改那裡；也可以直接反白文字"
              onClick={() => { setTab('preview'); setSelecting((on) => !on); setPicked(null); }}
              className={`${iconButton} ${selecting ? 'bg-amber-500/15 text-amber-600 dark:text-amber-300' : ''}`}>
              <MousePointerClick className="h-3.5 w-3.5" />框選修改
            </button>
            <button type="button" className={iconButton} disabled={!page || busy} onClick={() => { void saveToBoard(); }} title="放到規劃白板，卡片在白板上也能操作">
              <FilePenLine className="h-3.5 w-3.5" />{busy ? '存入中…' : '白板'}
            </button>
            <button type="button" className={iconButton} disabled={!page} onClick={download} aria-label="下載"><Download className="h-3.5 w-3.5" /></button>
          </div>

          <div ref={bodyRef} className="relative min-h-0 flex-1 overflow-hidden">
            {content === null ? (
              <p className="p-4 text-sm text-muted-foreground">
                {doc.needsCurrent ? '正在讀取檔案目前的內容…' : '這一版還原不出來：檔案在這個對話之前就存在，或中間被其他方式改過。'}
              </p>
            ) : tab === 'preview' ? (
              <iframe ref={frameRef} title={doc.title} sandbox={CANVAS_SANDBOX} srcDoc={srcDoc ?? ''} className="h-full w-full border-0 bg-white" />
            ) : tab === 'code' ? (
              <div className="flex h-full flex-col">
                <div className="flex items-center gap-1 border-b border-border px-2 py-1">
                  <button type="button" className={iconButton} onClick={() => { void navigator.clipboard?.writeText(content).then(() => flash('已複製。')); }}>
                    <Copy className="h-3.5 w-3.5" />複製
                  </button>
                  {doc.path && onOpenInEditor && (
                    <button type="button" className={iconButton} onClick={() => onOpenInEditor(doc.path as string)}>在編輯器開啟（可直接改）</button>
                  )}
                </div>
                <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-xs">{content}</pre>
              </div>
            ) : (
              <div className="h-full overflow-auto p-2 font-mono text-xs">
                {consoleLines.length === 0 ? <p className="text-muted-foreground">預覽還沒有印出任何東西。</p> : consoleLines.map((line, i) => (
                  <div key={`${line.at}-${i}`} className={line.level === 'error' ? 'text-red-500' : line.level === 'warn' ? 'text-amber-600 dark:text-amber-300' : 'text-foreground'}>{line.text}</div>
                ))}
              </div>
            )}

            {picked && tab === 'preview' && (
              <div className="absolute z-20 w-80 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl" style={popupStyle}>
                {!picked.asking ? (
                  <button type="button" className="text-xs font-medium text-primary" onClick={() => setPicked({ ...picked, asking: true })}>修改這段</button>
                ) : (
                  <>
                    <p className="mb-1 truncate text-[11px] text-muted-foreground">選取：{picked.label}</p>
                    <textarea autoFocus value={ask} onChange={(event) => setAsk(event.target.value)} rows={3} placeholder="要怎麼改？"
                      data-tutorial-tip="說想怎麼改這一段，例：把這個表格改成長條圖；Enter 送出"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
                        if (event.key === 'Escape') setPicked(null);
                      }}
                      className="w-full resize-none rounded-md border border-border bg-background p-1.5 text-sm" />
                    <div className="mt-1 flex justify-end gap-1">
                      <button type="button" className={iconButton} onClick={() => setPicked(null)}>取消</button>
                      <button type="button" disabled={!ask.trim() || !state.submitText} onClick={send}
                        className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-40">送出修改</button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">這個對話還沒有畫布。<span data-tutorial>開啟輸入框的「畫布」後請 Claude 做網頁、圖表或試算器，就會出現在這裡。</span></p>
      )}
      {note && <div className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">{note}</div>}
    </aside>
  );
}
