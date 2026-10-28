import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject, PointerEvent as ReactPointerEvent } from 'react';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { MergeView } from '@codemirror/merge';
import { StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { Decoration, EditorView, GutterMarker, drawSelection, gutter, keymap, lineNumbers } from '@codemirror/view';
import { GitCompare, Plus, Trash2 } from 'lucide-react';

import ToolFrame from '@/modules/tool-library/ToolFrame';
import { readTextFile } from '@/modules/tool-library/importers';
import type { ToolProps } from '@/modules/tool-library/catalog';
import {
  LANGUAGES, MAX_REVIEWS, SEVERITY_LABEL, diffStats, emptyReview, findingDecorations, lineDiff, parseFindings, parseReviews, planCodeImport, reviewBrief, severitySummary,
} from '@/modules/tool-library/tools/codeReviewModel';
import type { Finding, ImportedSource, LanguageId, LineDecoration, Review, Severity } from '@/modules/tool-library/tools/codeReviewModel';
import { sqlLanguage } from '@/modules/tool-library/tools/sqlLanguage';
import { createToolSaver, loadToolData } from '@/shared/customTools';
import type { AssistMessage } from '@/shared/customTools';
import { cn } from '@/shared/utils';

const TOOL_ID = 'code-review';

const SEVERITY_STYLE: Record<Finding['severity'], string> = {
  high: 'bg-red-500/15 text-red-600 dark:text-red-400',
  mid: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  low: 'bg-slate-500/15 text-muted-foreground',
};

// SQL uses our own small T-SQL highlighter (no lang-sql package); plain text has no language extension.
const languageExtension = (language: LanguageId): Extension => {
  switch (language) {
    case 'sql': return sqlLanguage;
    case 'python': return python();
    case 'javascript': return javascript();
    case 'json': return json();
    case 'html': return html();
    case 'css': return css();
    case 'markdown': return markdown();
    default: return [];
  }
};

const SEVERITY_RANK: Record<Severity, number> = { high: 0, mid: 1, low: 2 };
const DOT_COLOUR: Record<Severity, string> = { high: 'rgb(239,68,68)', mid: 'rgb(245,158,11)', low: 'rgb(100,116,139)' };

const setMarks = StateEffect.define<LineDecoration[]>();
const setFlash = StateEffect.define<number | null>();
type MarkState = { specs: LineDecoration[]; flash: number | null };

const marksField = StateField.define<MarkState>({
  create: () => ({ specs: [], flash: null }),
  update(value, transaction) {
    let next = value;
    for (const effect of transaction.effects) {
      if (effect.is(setMarks)) next = { ...next, specs: effect.value };
      else if (effect.is(setFlash)) next = { ...next, flash: effect.value };
    }
    return next;
  },
});

/** Worst severity and the joined titles for one line (null when no finding points there). */
function lineMark(state: EditorState, lineNumber: number): { severity: Severity; title: string } | null {
  const here = state.field(marksField).specs.filter((spec) => spec.line === lineNumber);
  if (here.length === 0) return null;
  const severity = here.reduce((worst, spec) => (SEVERITY_RANK[spec.severity] < SEVERITY_RANK[worst] ? spec.severity : worst), here[0].severity);
  return { severity, title: here.map((spec) => `[${SEVERITY_LABEL[spec.severity]}] ${spec.title}`).join('\n') };
}

class DotMarker extends GutterMarker {
  constructor(private readonly severity: Severity, private readonly title: string) { super(); }
  eq(other: DotMarker) { return other.severity === this.severity && other.title === this.title; }
  toDOM() {
    const dot = document.createElement('span');
    dot.className = 'cm-finding-dot';
    dot.title = this.title;
    dot.style.background = DOT_COLOUR[this.severity];
    return dot;
  }
}

const markDecorations = (state: EditorState) => {
  const { specs, flash } = state.field(marksField);
  const lines = new Set<number>(specs.map((spec) => spec.line));
  if (flash !== null) lines.add(flash);
  const ranges = [...lines]
    .filter((number) => number >= 1 && number <= state.doc.lines)
    .sort((left, right) => left - right)
    .map((number) => {
      const mark = lineMark(state, number);
      const classes = [mark ? `cm-finding cm-finding-${mark.severity}` : '', flash === number ? 'cm-finding-flash' : ''].filter(Boolean).join(' ');
      return Decoration.line({ class: classes, ...(mark ? { attributes: { title: mark.title } } : {}) }).range(state.doc.line(number).from);
    });
  return Decoration.set(ranges);
};

const tint = (rgb: string) => `linear-gradient(rgba(${rgb},.13), rgba(${rgb},.13))`;
const findingExtensions: Extension[] = [
  marksField,
  EditorView.decorations.compute([marksField], markDecorations),
  gutter({
    class: 'cm-finding-gutter',
    lineMarker: (view, block) => {
      const mark = lineMark(view.state, view.state.doc.lineAt(block.from).number);
      return mark ? new DotMarker(mark.severity, mark.title) : null;
    },
    lineMarkerChange: (update) => update.startState.field(marksField) !== update.state.field(marksField),
    initialSpacer: () => new DotMarker('low', ''),
  }),
  EditorView.baseTheme({
    '.cm-finding-gutter': { width: '14px' },
    '.cm-finding-gutter .cm-gutterElement': { display: 'flex', alignItems: 'center', justifyContent: 'center' },
    '.cm-finding-dot': { display: 'block', width: '8px', height: '8px', borderRadius: '50%' },
    '.cm-finding-high': { backgroundImage: tint('239,68,68'), boxShadow: 'inset 3px 0 0 rgb(239,68,68)' },
    '.cm-finding-mid': { backgroundImage: tint('245,158,11'), boxShadow: 'inset 3px 0 0 rgb(245,158,11)' },
    '.cm-finding-low': { backgroundImage: tint('100,116,139'), boxShadow: 'inset 3px 0 0 rgb(100,116,139)' },
    '.cm-finding-flash': { backgroundImage: tint('250,204,21'), backgroundColor: 'rgba(250,204,21,.45) !important' },
  }),
];

type PanesHandle = { goToLine: (side: 'before' | 'after', line: number) => void };

type PanesProps = {
  reviewId: string;
  language: LanguageId;
  before: string;
  after: string;
  findings: Finding[];
  onBefore: (value: string) => void;
  onAfter: (value: string) => void;
  handle: MutableRefObject<PanesHandle | null>;
};

/** The two editors side by side with changed lines highlighted; rebuilt only when the review or language changes. */
function DiffPanes({ reviewId, language, before, after, findings, onBefore, onAfter, handle }: PanesProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MergeView | null>(null);
  const initial = useRef({ before, after });
  initial.current = { before, after };
  const findingsRef = useRef(findings);
  findingsRef.current = findings;
  const marksSender = useRef<((specs: LineDecoration[]) => void) | null>(null);
  const flashTimer = useRef<number | null>(null);
  const callbacks = useRef({ onBefore, onAfter });
  callbacks.current = { onBefore, onAfter };

  useEffect(() => {
    if (!host.current) return undefined;
    const isDark = document.documentElement.classList.contains('dark');
    const shared = (report: (value: string) => void): Extension[] => [
      findingExtensions,
      lineNumbers(),
      history(),
      drawSelection(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.lineWrapping,
      EditorView.theme({ '&': { fontSize: '13px' }, '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' } }),
      languageExtension(language),
      isDark ? oneDark : [],
      // Keys typed in an editor must not reach the window's Esc-closes handler or the page's shortcuts.
      EditorView.domEventHandlers({ keydown: (event) => { event.stopPropagation(); return false; } }),
      EditorView.updateListener.of((update) => { if (update.docChanged) report(update.state.doc.toString()); }),
    ];
    const view = new MergeView({
      a: { doc: initial.current.before, extensions: shared((value) => callbacks.current.onBefore(value)) },
      b: { doc: initial.current.after, extensions: shared((value) => callbacks.current.onAfter(value)) },
      parent: host.current,
      highlightChanges: true,
      gutter: true,
    });
    viewRef.current = view;
    const sendMarks = (specs: LineDecoration[]) => {
      view.a.dispatch({ effects: setMarks.of(specs.filter((spec) => spec.side === 'before')) });
      view.b.dispatch({ effects: setMarks.of(specs.filter((spec) => spec.side === 'after')) });
    };
    sendMarks(findingDecorations(findingsRef.current));
    marksSender.current = sendMarks;
    handle.current = {
      goToLine: (side, line) => {
        const editor = side === 'before' ? view.a : view.b;
        const target = editor.state.doc.line(Math.min(Math.max(1, line), editor.state.doc.lines));
        editor.dispatch({ selection: { anchor: target.from }, effects: [EditorView.scrollIntoView(target.from, { y: 'center' }), setFlash.of(target.number)] });
        editor.focus();
        if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => {
          flashTimer.current = null;
          editor.dispatch({ effects: setFlash.of(null) });
        }, 1200);
      },
    };
    return () => {
      handle.current = null;
      marksSender.current = null;
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
      flashTimer.current = null;
      viewRef.current = null;
      view.destroy();
    };
  }, [reviewId, language, handle]);

  // New findings repaint the marks without rebuilding the editors.
  useEffect(() => { marksSender.current?.(findingDecorations(findings)); }, [findings]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-2 border-b border-border bg-muted/30 text-xs font-medium text-muted-foreground">
        <span className="px-3 py-1">舊版（貼在左邊）</span>
        <span className="border-l border-border px-3 py-1">新版（貼在右邊）</span>
      </div>
      <div ref={host} data-testid="diff-panes" className="min-h-0 flex-1 overflow-hidden [&_.cm-mergeView]:h-full [&_.cm-mergeViewEditors]:min-h-full [&_.cm-mergeViewEditor>.cm-editor]:min-h-full" />
    </div>
  );
}

/** DHC CLI 10/14 程式差異審閱台: two versions side by side, AI findings you can jump to, tick the ones to hand to the chat. */
export default function CodeReview({ profileId, profileName, isMobile, onClose, onStartWork }: ToolProps) {
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  // Bumped after an import so the editors are rebuilt from the new text.
  const [paneRevision, setPaneRevision] = useState(0);
  const saver = useMemo(() => createToolSaver(TOOL_ID, profileId, () => setFailed(true)), [profileId]);
  const reviewsRef = useRef<Review[]>([]);
  reviewsRef.current = reviews ?? [];
  const handle = useRef<PanesHandle | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Height of the findings pane as a share of the tool area; dragged with the handle.
  const [panelPct, setPanelPct] = useState(35);

  const commit = useCallback((next: Review[]) => {
    reviewsRef.current = next;
    setReviews(next);
    saver.save({ reviews: next });
  }, [saver]);

  useEffect(() => {
    let cancelled = false;
    loadToolData(TOOL_ID, profileId)
      .then((stored) => {
        if (cancelled) return;
        let list = parseReviews(stored);
        if (list.length === 0) {
          list = [emptyReview('審閱 1')];
          saver.save({ reviews: list });
        }
        reviewsRef.current = list;
        setReviews(list);
        setActiveId(list[0].id);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [profileId, saver]);

  const active = reviews?.find((review) => review.id === activeId) ?? null;

  const updateReview = useCallback((reviewId: string, patch: Partial<Review>) => {
    commit(reviewsRef.current.map((review) => (review.id === reviewId ? { ...review, ...patch, updatedAt: new Date().toISOString() } : review)));
  }, [commit]);

  const select = (id: string) => {
    setActiveId(id);
    setChosen(new Set());
  };
  const create = () => {
    if (reviewsRef.current.length >= MAX_REVIEWS) {
      window.alert(`最多留 ${MAX_REVIEWS} 份審閱，先刪掉不用的再新增。`);
      return;
    }
    const review = emptyReview(`審閱 ${reviewsRef.current.length + 1}`);
    commit([review, ...reviewsRef.current]);
    select(review.id);
  };
  const rename = () => {
    if (!active) return;
    const name = window.prompt('審閱名稱', active.name)?.trim();
    if (name) updateReview(active.id, { name });
  };
  const remove = () => {
    if (!active) return;
    if (!window.confirm(`刪除審閱「${active.name}」？刪了就找不回來。`)) return;
    const rest = reviewsRef.current.filter((review) => review.id !== active.id);
    const next = rest.length > 0 ? rest : [emptyReview('審閱 1')];
    commit(next);
    select(next[0].id);
  };
  const importFiles = async (files: File[]): Promise<string> => {
    if (!active) return '還沒有審閱，沒有匯入';
    const sources: ImportedSource[] = [];
    const failedNames: string[] = [];
    for (const file of files) {
      try {
        sources.push({ name: file.name, lastModified: file.lastModified, text: await readTextFile(file) });
      } catch {
        failedNames.push(file.name);
      }
    }
    const current = reviewsRef.current.find((review) => review.id === active.id) ?? active;
    const plan = planCodeImport(sources, current);
    if (!plan) return failedNames.length > 0 ? `${failedNames.join('、')} 讀不了` : '沒有可匯入的文字檔';
    updateReview(active.id, { before: plan.before, after: plan.after, findings: [], ...(plan.language ? { language: plan.language } : {}) });
    setChosen(new Set());
    setPaneRevision((value) => value + 1);
    return failedNames.length > 0 ? `${plan.message}；${failedNames.join('、')} 讀不了` : plan.message;
  };

  const close = () => {
    void saver.flush();
    onClose();
  };

  const stats = useMemo(() => (active ? diffStats(lineDiff(active.before, active.after)) : null), [active?.before, active?.after]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosenFindings = active ? active.findings.filter((_, index) => chosen.has(index)) : [];

  const startWork = async () => {
    if (!active || !onStartWork) return;
    await saver.flush();
    onStartWork(reviewBrief(active, chosenFindings));
    onClose();
  };

  const toggle = (index: number) => setChosen((current) => {
    const next = new Set(current);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    return next;
  });

  const dragPanel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const body = bodyRef.current;
    if (!body) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const rect = body.getBoundingClientRect();
      if (rect.height <= 0) return;
      setPanelPct(Math.min(70, Math.max(12, ((rect.bottom - moveEvent.clientY) / rect.height) * 100)));
    };
    const stop = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', stop);
      target.removeEventListener('pointercancel', stop);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', stop);
    target.addEventListener('pointercancel', stop);
  };

  const iconButton = 'rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground';

  return (
    <ToolFrame
      icon={GitCompare}
      title="程式差異審閱台"
      profileName={profileName}
      failed={failed}
      isMobile={isMobile}
      onClose={close}
      importer={active ? { accept: '.sql,.txt,.py,.js,.ts,.json,.html,.css,.md,.vb,.bas,.cs,.java,.xml,.yaml,.yml,.ini,.cfg,.log,text/*', hint: '匯入程式檔：1 個檔放進空的那邊（先左後右），2 個檔較舊的放舊版、較新的放新版', onFiles: importFiles } : undefined}
      headerExtra={reviews && (
        <>
          <select
            aria-label="選擇審閱"
            value={activeId ?? ''}
            onChange={(event) => select(event.target.value)}
            className="min-w-0 max-w-48 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
          >
            {reviews.map((review) => <option key={review.id} value={review.id}>{review.name}</option>)}
          </select>
          <button type="button" onClick={create} className={iconButton} title="新審閱" aria-label="新審閱"><Plus className="h-4 w-4" /></button>
          <button type="button" onClick={rename} disabled={!active} className="shrink-0 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">改名</button>
          <button type="button" onClick={remove} disabled={!active} className={cn(iconButton, 'hover:text-destructive')} title="刪除這份審閱" aria-label="刪除這份審閱"><Trash2 className="h-4 w-4" /></button>
          <span className="mx-1 h-4 w-px shrink-0 bg-border" />
          <select
            aria-label="語言"
            value={active?.language ?? 'sql'}
            onChange={(event) => active && updateReview(active.id, { language: event.target.value as LanguageId })}
            className="shrink-0 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
          >
            {LANGUAGES.map((language) => <option key={language.id} value={language.id}>{language.label}</option>)}
          </select>
          {stats && <span className="shrink-0 text-[11px] text-muted-foreground">{stats.hunks === 0 ? '兩版相同' : `${stats.hunks} 處差異（+${stats.added} −${stats.removed}）`}</span>}
        </>
      )}
      assist={active ? {
        tool: TOOL_ID,
        getContext: () => {
          const current = reviewsRef.current.find((review) => review.id === active.id) ?? active;
          return { language: current.language, before: current.before, after: current.after };
        },
        onResult: (result) => {
          const findings = parseFindings((result as { findings?: unknown } | null)?.findings);
          updateReview(active.id, { findings });
          setChosen(new Set());
          return findings.length > 0 ? `找到 ${findings.length} 項，列在下方，點一項會跳到那一行` : 'AI 沒有發現問題';
        },
        chat: active.chat,
        onChatChange: (chat: AssistMessage[]) => updateReview(active.id, { chat }),
        intro: '先把舊版貼在左邊、新版貼在右邊，再說「幫我審閱這次修改」，或指定重點，例如「看 JOIN 條件有沒有讓筆數變多」。AI 會把風險列在下方，點一項就跳到那一行。',
        placeholder: '要審什麼？（Enter 送出）',
        busyText: 'AI 正在審閱（約 30–120 秒）',
      } : undefined}
      startWork={{
        hint: chosenFindings.length > 0 ? `已勾選 ${chosenFindings.length} 項問題，開工會連同兩版差異交給對話去改。` : '勾選下方要處理的問題，按「開工」把差異與清單交給對話去改。',
        disabled: !active || (!active.before && !active.after),
        onStart: onStartWork ? () => void startWork() : null,
      }}
    >
      {!reviews ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{failed ? '讀不到審閱，稍後再開一次。' : '載入中…'}</p>
      ) : active ? (
        <div ref={bodyRef} className="flex h-full min-h-0 flex-col">
          <DiffPanes
            key={`${active.id}:${active.language}:${paneRevision}`}
            reviewId={active.id}
            language={active.language}
            before={active.before}
            after={active.after}
            findings={active.findings}
            onBefore={(value) => updateReview(active.id, { before: value })}
            onAfter={(value) => updateReview(active.id, { after: value })}
            handle={handle}
          />
          {active.findings.length > 0 && (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="拖曳調整問題清單高度"
              data-testid="findings-handle"
              onPointerDown={dragPanel}
              className="h-1.5 shrink-0 cursor-row-resize touch-none border-t border-border bg-muted/40 hover:bg-primary/30"
            />
          )}
          <div
            className={cn('flex shrink-0 flex-col bg-muted/20', active.findings.length === 0 && 'border-t border-border')}
            style={active.findings.length > 0 ? { height: `${panelPct}%` } : undefined}
            data-testid="findings"
          >
            <div className="flex shrink-0 items-center gap-3 border-b border-border bg-muted px-3 py-1 text-xs font-semibold text-foreground">
              <span>AI 發現的問題（{active.findings.length}）</span>
              {active.findings.length > 0 && <span className="font-normal text-muted-foreground" data-testid="severity-summary">{severitySummary(active.findings)}</span>}
              {active.findings.length === 0 && <span className="font-normal text-muted-foreground">還沒有。在右邊的 AI 對話請它審閱。</span>}
            </div>
            {active.findings.length > 0 && (
              <ul className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto">
                {active.findings.map((finding, index) => (
                  <li key={`${index}:${finding.title}`} className="flex items-start gap-2 px-3 py-1.5 text-xs">
                    <input type="checkbox" aria-label={`處理：${finding.title}`} checked={chosen.has(index)} onChange={() => toggle(index)} className="mt-0.5" />
                    <button type="button" onClick={() => handle.current?.goToLine(finding.side, finding.line)} className="min-w-0 flex-1 text-left hover:text-primary">
                      <span className="flex items-center gap-1.5">
                        <span className={cn('shrink-0 rounded px-1 py-0.5 text-[10px] font-medium', SEVERITY_STYLE[finding.severity])}>{SEVERITY_LABEL[finding.severity]}</span>
                        <span className="min-w-0 truncate font-medium text-foreground">{finding.title}</span>
                        <span className="shrink-0 text-muted-foreground">{finding.side === 'after' ? '新版' : '舊版'}第 {finding.line} 行</span>
                      </span>
                      {finding.detail && <span className="mt-0.5 block whitespace-pre-wrap text-muted-foreground">{finding.detail}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </ToolFrame>
  );
}
