import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { markdown as markdownLanguage } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { Download, FileText, Plus, Trash2, Undo2 } from 'lucide-react';

import { readDocxAsMarkdown, readTextFile } from '@/modules/tool-library/importers';
import ToolFrame from '@/modules/tool-library/ToolFrame';
import type { ToolProps } from '@/modules/tool-library/catalog';
import { MAX_DOCS, MAX_DOC_CHARS, applyDocResult, buildDocx, docBrief, docContext, emptyDoc, parseDocsData } from '@/modules/tool-library/tools/docModel';
import type { DocItem, DocsData, Selection } from '@/modules/tool-library/tools/docModel';
import { applyDocHandoff, docToDeckHandoff } from '@/modules/tool-library/tools/handoffModel';
import SendMenu from '@/modules/tool-library/tools/SendMenu';
import { createToolSaver, loadToolData } from '@/shared/customTools';
import type { AssistMessage } from '@/shared/customTools';
import { sendToTool, takeHandoff } from '@/shared/toolHandoff';
import { cn } from '@/shared/utils';

const MAX_UNDO = 10;
const EXTENSIONS = [markdownLanguage(), EditorView.lineWrapping];

const downloadBlob = (name: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
};

/** DHC CLI 10/14 文件共編: Markdown on the left, live preview on the right, an AI that rewrites (with undo), Word export, 開工. */
export default function DocEditor({ profileId, profileName, isMobile, onClose, onStartWork }: ToolProps) {
  const [data, setData] = useState<DocsData | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const [handoffNote, setHandoffNote] = useState('');
  const [pane, setPane] = useState<'edit' | 'preview'>('edit');
  // What the AI replaced, newest last, so 「復原 AI 修改」 can put it back.
  const [undoStack, setUndoStack] = useState<Array<{ docId: string; markdown: string }>>([]);
  const dataRef = useRef<DocsData | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const askedRef = useRef<{ selection: Selection | null; truncated: boolean }>({ selection: null, truncated: false });
  const saver = useMemo(() => createToolSaver('doc-editor', profileId, () => setFailed(true)), [profileId]);

  const commitData = useCallback((next: DocsData) => {
    dataRef.current = next;
    setData(next);
    saver.save(next);
  }, [saver]);

  useEffect(() => {
    let cancelled = false;
    loadToolData('doc-editor', profileId)
      .then((stored) => {
        if (cancelled) return;
        let parsed = parseDocsData(stored);
        const handoff = takeHandoff('doc-editor');
        const applied = handoff ? applyDocHandoff(parsed, handoff) : null;
        if (applied) {
          parsed = applied.data;
          if (applied.undo) setUndoStack([{ docId: applied.undo.id, markdown: applied.undo.markdown }]);
          setHandoffNote(applied.note);
          saver.save(parsed);
        }
        dataRef.current = parsed;
        setData(parsed);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [profileId, saver]);

  const close = useCallback(() => {
    void saver.flush();
    onClose();
  }, [onClose, saver]);

  const active = data?.docs.find((doc) => doc.id === data.activeId) ?? null;

  const patchDoc = useCallback((id: string, patch: Partial<DocItem>) => {
    const current = dataRef.current;
    if (!current) return;
    commitData({ ...current, docs: current.docs.map((doc) => (doc.id === id ? { ...doc, ...patch, updatedAt: new Date().toISOString() } : doc)) });
  }, [commitData]);

  if (!data) {
    return (
      <ToolFrame icon={FileText} title="文件共編" profileName={profileName} failed={failed} isMobile={isMobile} onClose={onClose}>
        <p className="py-6 text-center text-sm text-muted-foreground">{failed ? '讀不到文件，稍後再開一次。' : '載入中…'}</p>
      </ToolFrame>
    );
  }
  if (!active) return null;

  const readSelection = (): Selection | null => {
    const view = viewRef.current;
    if (!view) return null;
    const { from, to } = view.state.selection.main;
    return from === to ? null : { from, to, text: view.state.sliceDoc(from, to) };
  };

  const applyFromAi = (result: unknown): string => {
    const current = dataRef.current;
    const doc = current?.docs.find((item) => item.id === current.activeId);
    if (!current || !doc) throw new Error('no doc');
    const { selection, truncated } = askedRef.current;
    const applied = applyDocResult(doc.markdown, selection, result, truncated);
    setUndoStack((stack) => [...stack, { docId: doc.id, markdown: doc.markdown }].slice(-MAX_UNDO));
    patchDoc(doc.id, { markdown: applied.markdown });
    return applied.note;
  };

  const undoAi = () => {
    const last = [...undoStack].reverse().find((item) => item.docId === active.id);
    if (!last) return;
    const index = undoStack.lastIndexOf(last);
    setUndoStack(undoStack.filter((_, i) => i !== index));
    patchDoc(active.id, { markdown: last.markdown });
  };
  const canUndo = undoStack.some((item) => item.docId === active.id);

  const addDoc = () => {
    if (data.docs.length >= MAX_DOCS) { setNotice(`文件最多 ${MAX_DOCS} 份。`); return; }
    const doc = emptyDoc(`文件 ${data.docs.length + 1}`);
    commitData({ ...data, docs: [doc, ...data.docs], activeId: doc.id });
  };
  const importFiles = async (files: File[]): Promise<string> => {
    const notes: string[] = [];
    const incoming: Array<{ title: string; markdown: string; cut: boolean }> = [];
    for (const file of files) {
      try {
        const lower = file.name.toLowerCase();
        let markdown: string;
        if (lower.endsWith('.docx')) markdown = await readDocxAsMarkdown(file);
        else if (lower.endsWith('.doc')) throw new Error('舊版 .doc 讀不了，請在 Word 另存成 .docx');
        else if (lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.markdown')) markdown = await readTextFile(file);
        else throw new Error('不支援這種檔案，請用 .md、.txt 或 .docx');
        if (!markdown.trim()) throw new Error('裡面沒有讀到文字');
        incoming.push({ title: (file.name.replace(/\.[^.\\/]+$/, '') || '匯入的文件').slice(0, 80), markdown: markdown.slice(0, MAX_DOC_CHARS), cut: markdown.length > MAX_DOC_CHARS });
      } catch (error) {
        notes.push(`${file.name}：${(error as Error).message}`);
      }
    }
    const current = dataRef.current;
    if (!current || incoming.length === 0) return notes.join('；') || '沒有可匯入的內容。';
    const activeDoc = current.docs.find((doc) => doc.id === current.activeId);
    let docs = [...current.docs];
    let activeId = current.activeId;
    const done: string[] = [];
    let skipped = 0;
    incoming.forEach((item, index) => {
      const label = `${item.title}${item.cut ? `（超過 ${MAX_DOC_CHARS} 字，後面的沒收進來）` : ''}`;
      if (index === 0 && activeDoc && !activeDoc.markdown.trim()) {
        docs = docs.map((doc) => (doc.id === activeDoc.id ? { ...doc, title: item.title, markdown: item.markdown, updatedAt: new Date().toISOString() } : doc));
        activeId = activeDoc.id;
        done.push(label);
      } else if (docs.length >= MAX_DOCS) {
        skipped += 1;
      } else {
        const doc = { ...emptyDoc(item.title), markdown: item.markdown };
        docs = [doc, ...docs];
        if (done.length === 0) activeId = doc.id;
        done.push(label);
      }
    });
    commitData({ ...current, docs, activeId });
    return [
      done.length > 0 ? `已匯入 ${done.join('、')}` : '',
      skipped > 0 ? `文件最多 ${MAX_DOCS} 份，有 ${skipped} 份沒匯入` : '',
      ...notes,
    ].filter(Boolean).join('；');
  };
  const renameDoc = () => {
    const title = window.prompt('文件名稱', active.title)?.trim();
    if (title) patchDoc(active.id, { title: title.slice(0, 80) });
  };
  const removeDoc = () => {
    if (!window.confirm(`刪除文件「${active.title}」？刪了就找不回來。`)) return;
    const rest = data.docs.filter((doc) => doc.id !== active.id);
    const docs = rest.length > 0 ? rest : [emptyDoc('我的第一份文件')];
    commitData({ ...data, docs, activeId: docs[0].id });
  };

  const exportWord = async () => {
    try {
      const bytes = await buildDocx(active.markdown);
      downloadBlob(`${active.title.replace(/[\\/:*?"<>|]/g, '_') || '文件'}.docx`, new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
      setNotice('');
    } catch {
      setNotice('匯出 Word 失敗。');
    }
  };

  const startWork = () => {
    if (!onStartWork) return;
    void saver.flush();
    onStartWork(docBrief(active.title, active.markdown));
    onClose();
  };

  const setChat = (chat: AssistMessage[]) => { if (dataRef.current) commitData({ ...dataRef.current, chat }); };
  const dark = document.documentElement.classList.contains('dark');

  const editor = (
    <CodeMirror
      key={active.id}
      value={active.markdown}
      onChange={(value) => { if (value.length <= MAX_DOC_CHARS) patchDoc(active.id, { markdown: value }); else setNotice(`文件最長 ${MAX_DOC_CHARS} 字。`); }}
      onCreateEditor={(view) => { viewRef.current = view; }}
      extensions={EXTENSIONS}
      theme={dark ? oneDark : undefined}
      height="100%"
      style={{ height: '100%', fontSize: '14px' }}
      placeholder="在這裡寫 Markdown（# 標題、- 清單、**粗體**、| 表格 |）…"
      basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
    />
  );
  const preview = (
    <div className="h-full overflow-y-auto bg-background px-6 py-4">
      <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:font-semibold prose-a:text-blue-600">
        {active.markdown.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{active.markdown}</ReactMarkdown> : <p className="text-muted-foreground">預覽會顯示在這裡。</p>}
      </div>
    </div>
  );

  return (
    <ToolFrame
      icon={FileText}
      title="文件共編"
      profileName={profileName}
      failed={failed}
      isMobile={isMobile}
      onClose={close}
      headerExtra={(
        <>
          <select
            aria-label="選擇文件"
            value={active.id}
            onChange={(event) => commitData({ ...data, activeId: event.target.value })}
            className="min-w-0 max-w-56 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
          >
            {data.docs.map((doc) => <option key={doc.id} value={doc.id}>{doc.title}</option>)}
          </select>
          <button type="button" onClick={addDoc} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="新文件" aria-label="新文件"><Plus className="h-4 w-4" /></button>
          <button type="button" onClick={renameDoc} className="shrink-0 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">改名</button>
          <button type="button" onClick={removeDoc} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive" title="刪除這份文件" aria-label="刪除這份文件"><Trash2 className="h-4 w-4" /></button>
          <SendMenu items={[{ label: '做成簡報', disabled: !active.markdown.trim(), onPick: () => { void saver.flush(); sendToTool(docToDeckHandoff(active.title, active.markdown)); } }]} />
          {notice && <span className="shrink-0 text-xs text-destructive">{notice}</span>}
          {handoffNote && <button type="button" onClick={() => setHandoffNote('')} title="按一下關掉" className="max-w-[24rem] shrink-0 truncate text-xs text-muted-foreground hover:text-foreground">{handoffNote}</button>}
        </>
      )}
      importer={{ accept: '.md,.txt,.docx', hint: '匯入 Markdown、文字檔或 Word（.docx）', onFiles: importFiles }}
      assist={{
        tool: 'doc-editor',
        getContext: () => {
          const selection = readSelection();
          askedRef.current = { selection, truncated: active.markdown.length > 90_000 };
          return docContext(active.title, active.markdown, selection);
        },
        onResult: applyFromAi,
        chat: data.chat,
        onChatChange: setChat,
        intro: '請我幫你寫、補章節、改寫或統一用語。想只改某一段，先在左邊選取那段文字再跟我說。改完可以按「復原 AI 修改」退回。',
        placeholder: '要寫什麼、改什麼？（Enter 送出）',
        busyText: 'AI 正在寫（約 15–60 秒）',
      }}
      startWork={{
        hint: '寫到一半可以按「開工」：會開新對話，請 AI 接著把這份文件寫完。',
        disabled: !active.markdown.trim(),
        onStart: onStartWork ? startWork : null,
      }}
      footerExtra={(
        <>
          <button
            type="button"
            onClick={undoAi}
            disabled={!canUndo}
            className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-40"
          >
            <Undo2 className="h-3.5 w-3.5" />
            復原 AI 修改
          </button>
          <button
            type="button"
            onClick={() => void exportWord()}
            disabled={!active.markdown.trim()}
            className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            匯出 Word
          </button>
        </>
      )}
    >
      <div className="flex h-full min-h-0 flex-col">
        {isMobile && (
          <div className="flex flex-shrink-0 gap-1 border-b border-border p-1.5 text-xs">
            {(['edit', 'preview'] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setPane(key)}
                className={cn('rounded-md px-3 py-1', pane === key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
              >
                {key === 'edit' ? '編輯' : '預覽'}
              </button>
            ))}
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          {(!isMobile || pane === 'edit') && <div className={cn('min-h-0 min-w-0 overflow-auto', isMobile ? 'flex-1' : 'w-1/2 border-r border-border')}>{editor}</div>}
          {(!isMobile || pane === 'preview') && <div className={cn('min-h-0 min-w-0', isMobile ? 'flex-1' : 'w-1/2')}>{preview}</div>}
        </div>
      </div>
    </ToolFrame>
  );
}
