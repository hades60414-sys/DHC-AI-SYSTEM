import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown as markdownLanguage } from '@codemirror/lang-markdown';
import { ChevronLeft, ChevronRight, Download, Pencil, Play, Plus, Presentation, Trash2, Undo2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { readPptxAsMarkdown, readTextFile } from '@/modules/tool-library/importers';
import ToolFrame from '@/modules/tool-library/ToolFrame';
import type { ToolProps } from '@/modules/tool-library/catalog';
import { DECK_CSS, buildDeckHtml, deckBrief, fitSlideElement, isTitleSlide, newDeck, parseDeckData, splitSlides } from '@/modules/tool-library/tools/deckModel';
import type { Deck, DeckData, DeckTarget } from '@/modules/tool-library/tools/deckModel';
import { applyDeckHandoff, deckToDocHandoff } from '@/modules/tool-library/tools/handoffModel';
import SendMenu from '@/modules/tool-library/tools/SendMenu';
import { safeFileName } from '@/modules/tool-library/tools/workshopModel';
import { createToolSaver, loadToolData } from '@/shared/customTools';
import { sendToTool, takeHandoff } from '@/shared/toolHandoff';
import { cn } from '@/shared/utils';

const TOOL_ID = 'deck-studio';
const MAX_UNDO = 20;
const buttonClass = 'flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-40';
const EDITOR_EXTENSIONS = [markdownLanguage()];

function SlideView({ body }: { body: string }) {
  const slideRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slide = slideRef.current;
    if (!slide) return undefined;
    fitSlideElement(slide);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => fitSlideElement(slide));
    observer.observe(slide);
    return () => observer.disconnect();
  }, [body]);
  return (
    <div className="deck-box">
      <div ref={slideRef} className={cn('deck-slide', isTitleSlide(body) && 'deck-title')}>
        <div className="deck-in"><ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown></div>
      </div>
    </div>
  );
}

function Present({ bodies, start, onExit }: { bodies: string[]; start: number; onExit: () => void }) {
  const [index, setIndex] = useState(start);
  const last = bodies.length - 1;
  useEffect(() => {
    document.documentElement.requestFullscreen?.().catch(() => { /* the overlay is already full-window */ });
    return () => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); };
  }, []);
  useEffect(() => {
    // Capture phase: Esc leaves the presentation only, not the whole tool window.
    const onKey = (event: KeyboardEvent) => {
      const next = event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ' ? 1
        : event.key === 'ArrowLeft' || event.key === 'PageUp' ? -1 : 0;
      if (event.key === 'Escape') onExit();
      else if (next) setIndex((current) => Math.max(0, Math.min(last, current + next)));
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [last, onExit]);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black" role="dialog" aria-label="簡報播放">
      <div
        className="relative w-[min(100vw,calc(100vh*16/9))] cursor-pointer"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setIndex((current) => Math.max(0, Math.min(last, current + (event.clientX - rect.left < rect.width / 3 ? -1 : 1))));
        }}
      >
        <SlideView body={bodies[index] ?? ''} />
      </div>
      <button type="button" onClick={onExit} aria-label="結束播放" className="absolute right-3 top-3 rounded p-1 text-white/60 hover:text-white"><X className="h-5 w-5" /></button>
      <span className="absolute bottom-2 right-3 text-xs text-white/50">{index + 1} / {bodies.length}　方向鍵換頁・Esc 結束</span>
    </div>
  );
}

export default function DeckStudio({ profileId, profileName, isMobile, onClose, onStartWork }: ToolProps) {
  const [data, setData] = useState<DeckData | null>(null);
  const [failed, setFailed] = useState(false);
  const [slideIndex, setSlideIndex] = useState(0);
  const [presenting, setPresenting] = useState(false);
  const [target, setTarget] = useState<DeckTarget>('pptx');
  const [undoCount, setUndoCount] = useState(0);
  const [handoffNote, setHandoffNote] = useState('');
  const dataRef = useRef<DeckData | null>(null);
  const undoStack = useRef<Array<{ deckId: string; markdown: string }>>([]);
  const saver = useMemo(() => createToolSaver(TOOL_ID, profileId, () => setFailed(true)), [profileId]);

  useEffect(() => {
    let cancelled = false;
    const finish = (value: unknown) => {
      let next = parseDeckData(value);
      if (next.decks.length === 0) {
        const first = newDeck('我的簡報');
        next = { decks: [first], activeId: first.id };
      }
      const handoff = takeHandoff(TOOL_ID);
      const applied = handoff ? applyDeckHandoff(next, handoff) : null;
      if (applied) {
        next = applied.data;
        if (applied.undo) { undoStack.current = [{ deckId: applied.undo.id, markdown: applied.undo.markdown }]; setUndoCount(1); }
        setHandoffNote(applied.note);
        saver.save(next);
      }
      dataRef.current = next;
      setData(next);
    };
    loadToolData(TOOL_ID, profileId).then((value) => { if (!cancelled) finish(value); }).catch(() => {
      if (cancelled) return;
      setFailed(true);
      finish(null);
    });
    return () => { cancelled = true; void saver.flush(); };
  }, [profileId, saver]);

  const update = useCallback((change: (current: DeckData) => DeckData) => {
    if (!dataRef.current) return;
    const next = change(dataRef.current);
    dataRef.current = next;
    setData(next);
    saver.save(next);
  }, [saver]);

  const active: Deck | null = data?.decks.find((deck) => deck.id === data.activeId) ?? null;
  const patchActive = (patch: Partial<Deck>) => update((current) => ({
    ...current, decks: current.decks.map((deck) => (deck.id === current.activeId ? { ...deck, ...patch } : deck)),
  }));

  const slides = useMemo(() => splitSlides(active?.markdown ?? ''), [active?.markdown]);
  const index = Math.min(slideIndex, slides.length - 1);
  const current = slides[index];
  const isDark = document.documentElement.classList.contains('dark');

  const handleClose = () => { void saver.flush(); onClose(); };

  const applyResult = (result: unknown) => {
    const value = result as { markdown?: unknown } | null;
    const deck = dataRef.current?.decks.find((item) => item.id === dataRef.current?.activeId);
    if (!deck || !value || typeof value.markdown !== 'string' || !value.markdown.trim()) throw new Error('bad result');
    undoStack.current = [...undoStack.current, { deckId: deck.id, markdown: deck.markdown }].slice(-MAX_UNDO);
    setUndoCount(undoStack.current.length);
    patchActive({ markdown: value.markdown });
    return '稿子已更新，不滿意可按上方「復原」';
  };

  const undo = () => {
    const last = undoStack.current.at(-1);
    if (!last) return;
    undoStack.current = undoStack.current.slice(0, -1);
    setUndoCount(undoStack.current.length);
    update((state) => ({ ...state, decks: state.decks.map((deck) => (deck.id === last.deckId ? { ...deck, markdown: last.markdown } : deck)) }));
  };

  const addDeck = () => {
    const deck = newDeck(`簡報 ${(data?.decks.length ?? 0) + 1}`);
    update((state) => ({ decks: [...state.decks, deck], activeId: deck.id }));
    setSlideIndex(0);
  };

  const rename = () => {
    if (!active) return;
    const name = window.prompt('簡報名稱', active.name)?.trim();
    if (name) patchActive({ name: name.slice(0, 60) });
  };

  const remove = () => {
    if (!active || !window.confirm(`刪除簡報「${active.name}」？`)) return;
    update((state) => {
      const decks = state.decks.filter((deck) => deck.id !== active.id);
      if (decks.length === 0) {
        const fresh = newDeck('我的簡報');
        return { decks: [fresh], activeId: fresh.id };
      }
      return { decks, activeId: decks[0].id };
    });
    setSlideIndex(0);
  };

  const importFiles = async (files: File[]): Promise<string> => {
    const notes: string[] = [];
    const incoming: Deck[] = [];
    for (const file of files) {
      try {
        const lower = file.name.toLowerCase();
        let markdown: string;
        if (lower.endsWith('.pptx')) markdown = await readPptxAsMarkdown(file);
        else if (lower.endsWith('.ppt')) throw new Error('舊版 .ppt 讀不了，請在 PowerPoint 另存成 .pptx');
        else if (lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.markdown')) markdown = await readTextFile(file);
        else throw new Error('不支援這種檔案，請用 .md、.txt 或 .pptx');
        if (!markdown.trim()) throw new Error('裡面沒有讀到文字');
        incoming.push(newDeck((file.name.replace(/\.[^.\\/]+$/, '') || '匯入的簡報').slice(0, 60), markdown));
      } catch (error) {
        notes.push(`${file.name}：${(error as Error).message}`);
      }
    }
    if (incoming.length > 0) {
      update((state) => ({ decks: [...state.decks, ...incoming], activeId: incoming[0].id }));
      setSlideIndex(0);
    }
    return [
      incoming.length > 0 ? `已匯入 ${incoming.map((deck) => `${deck.name}（${splitSlides(deck.markdown).length} 頁）`).join('、')}` : '',
      ...notes,
    ].filter(Boolean).join('；') || '沒有可匯入的內容。';
  };

  const downloadHtml = () => {
    if (!active) return;
    const url = URL.createObjectURL(new Blob([buildDeckHtml(active.name, active.markdown)], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeFileName(active.name)}.html`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const headerExtra = data && active && (
    <>
      <select
        aria-label="我的簡報"
        value={data.activeId ?? ''}
        onChange={(event) => { update((state) => ({ ...state, activeId: event.target.value })); setSlideIndex(0); }}
        className="max-w-40 shrink-0 rounded-md border border-border bg-background px-1.5 py-1 text-xs text-foreground"
      >
        {data.decks.map((deck) => <option key={deck.id} value={deck.id}>{deck.name}</option>)}
      </select>
      <button type="button" onClick={addDeck} className={buttonClass}><Plus className="h-3.5 w-3.5" />新增</button>
      <button type="button" onClick={rename} className={buttonClass}><Pencil className="h-3.5 w-3.5" />改名</button>
      <button type="button" onClick={undo} disabled={undoCount === 0} className={buttonClass}><Undo2 className="h-3.5 w-3.5" />復原</button>
      <button type="button" onClick={() => setPresenting(true)} className={buttonClass}><Play className="h-3.5 w-3.5" />播放</button>
      <SendMenu items={[{ label: '轉成文件', disabled: !active.markdown.trim(), onPick: () => { void saver.flush(); sendToTool(deckToDocHandoff(active.name, active.markdown)); } }]} />
      <button type="button" onClick={downloadHtml} className={buttonClass}><Download className="h-3.5 w-3.5" />下載網頁簡報</button>
      <button type="button" onClick={remove} className={buttonClass}><Trash2 className="h-3.5 w-3.5" />刪除</button>
      {handoffNote && <button type="button" onClick={() => setHandoffNote('')} title="按一下關掉" className="max-w-[24rem] shrink-0 truncate text-xs text-muted-foreground hover:text-foreground">{handoffNote}</button>}
    </>
  );

  return (
    <ToolFrame
      icon={Presentation}
      title="簡報影片工作室"
      profileName={profileName}
      headerExtra={headerExtra}
      failed={failed}
      isMobile={isMobile}
      onClose={handleClose}
      importer={{ accept: '.md,.txt,.pptx', hint: '匯入 Markdown、文字檔或 PowerPoint（.pptx）當新簡報', onFiles: importFiles }}
      assist={active ? {
        tool: TOOL_ID,
        getContext: () => ({ title: active.name, markdown: active.markdown }),
        onResult: applyResult,
        chat: active.chat,
        onChatChange: (chat) => patchActive({ chat }),
        intro: '告訴我簡報主題與對象，我幫你排大綱、寫每一頁、補旁白。旁白用「> 旁白：」開頭，不會顯示在投影片上，做成影片時會被唸出來。',
        placeholder: '想做什麼簡報？（Enter 送出）',
      } : undefined}
      startWork={{
        hint: '把稿子交給 AI，做成 PPTX 或有配音的 MP4。',
        label: '做成 PPTX／影片',
        disabled: !active || !active.markdown.trim(),
        onStart: onStartWork ? () => { if (!active) return; void saver.flush(); onStartWork(deckBrief(active.name, active.markdown, target)); } : null,
      }}
      footerExtra={(
        <select aria-label="輸出格式" value={target} onChange={(event) => setTarget(event.target.value as DeckTarget)} className="shrink-0 rounded-md border border-border bg-background px-1.5 py-1 text-xs text-foreground">
          <option value="pptx">PPTX</option>
          <option value="mp4">配音 MP4</option>
        </select>
      )}
    >
      <style>{DECK_CSS}</style>
      {!active && <p className="p-6 text-sm text-muted-foreground">載入中…</p>}
      {active && (
        <div className={cn('flex h-full min-h-0', isMobile ? 'flex-col' : 'flex-row')}>
          <div className={cn('min-h-0 border-border', isMobile ? 'h-1/2 border-b' : 'w-1/2 border-r')}>
            <CodeMirror
              value={active.markdown}
              height="100%"
              style={{ height: '100%' }}
              theme={isDark ? 'dark' : 'light'}
              extensions={EDITOR_EXTENSIONS}
              onChange={(value) => patchActive({ markdown: value })}
              basicSetup={{ lineNumbers: false, foldGutter: false }}
              aria-label="簡報稿子"
            />
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
            <div className="overflow-hidden rounded-md border border-border shadow-sm"><SlideView body={current.body} /></div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <button type="button" aria-label="上一頁" onClick={() => setSlideIndex(Math.max(0, index - 1))} disabled={index === 0} className={buttonClass}><ChevronLeft className="h-3.5 w-3.5" /></button>
              <span>{index + 1} / {slides.length}</span>
              <button type="button" aria-label="下一頁" onClick={() => setSlideIndex(Math.min(slides.length - 1, index + 1))} disabled={index >= slides.length - 1} className={buttonClass}><ChevronRight className="h-3.5 w-3.5" /></button>
            </div>
            <div className="rounded-md bg-muted/50 p-2 text-xs text-foreground">
              <span className="font-medium">旁白：</span>
              {current.narration.length > 0 ? current.narration.join(' ') : <span className="text-muted-foreground">這頁還沒有旁白（寫一行「&gt; 旁白：…」）</span>}
            </div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {slides.map((slide, i) => (
                <button key={i} type="button" aria-label={`第 ${i + 1} 頁`} onClick={() => setSlideIndex(i)} className={cn('overflow-hidden rounded border-2', i === index ? 'border-primary' : 'border-border')}>
                  <div className="pointer-events-none"><SlideView body={slide.body} /></div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {presenting && <Present bodies={slides.map((slide) => slide.body)} start={index} onExit={() => setPresenting(false)} />}
    </ToolFrame>
  );
}
