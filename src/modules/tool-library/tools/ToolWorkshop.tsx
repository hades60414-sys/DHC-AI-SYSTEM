import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, Hammer, Pencil, Plus, Share2, Trash2, Undo2 } from 'lucide-react';

import ToolFrame from '@/modules/tool-library/ToolFrame';
import { readTextFile } from '@/modules/tool-library/importers';
import type { ToolProps } from '@/modules/tool-library/catalog';
import {
  PREVIEW_SANDBOX, WORKSHOP_TEMPLATES, buildSrcdoc, importedTool, newWorkshopTool, parseWorkshopData, parseWorkshopResult, safeFileName, workshopBrief,
} from '@/modules/tool-library/tools/workshopModel';
import type { WorkshopData, WorkshopTool } from '@/modules/tool-library/tools/workshopModel';
import { createToolSaver, loadToolData } from '@/shared/customTools';
import { MAX_SHARED_HTML, removeSharedTool, shareTool, startSharedToolsSync, useSharedTools } from '@/shared/sharedTools';
import { cn } from '@/shared/utils';

const TOOL_ID = 'tool-workshop';
const MAX_UNDO = 20;

type Undo = { toolId: string; name: string; html: string };
const buttonClass = 'flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-40';

function Preview({ html, title }: { html: string; title: string }) {
  const srcDoc = useMemo(() => buildSrcdoc(html), [html]);
  return <iframe title={title} sandbox={PREVIEW_SANDBOX} srcDoc={srcDoc} className="h-full w-full border-0 bg-white" />;
}

function download(name: string, html: string) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${safeFileName(name)}.html`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function ToolWorkshop({ profileId, profileName, isMobile, onClose, onStartWork }: ToolProps) {
  const [data, setData] = useState<WorkshopData | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<'mine' | 'shared'>('mine');
  const [showTemplates, setShowTemplates] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const [sharedPick, setSharedPick] = useState<string | null>(null);
  const dataRef = useRef<WorkshopData | null>(null);
  const undoStack = useRef<Undo[]>([]);
  const shared = useSharedTools();
  const saver = useMemo(() => createToolSaver(TOOL_ID, profileId, () => setFailed(true)), [profileId]);

  useEffect(() => startSharedToolsSync(), []);
  useEffect(() => {
    let cancelled = false;
    loadToolData(TOOL_ID, profileId)
      .then((value) => {
        if (cancelled) return;
        const next = parseWorkshopData(value);
        dataRef.current = next;
        setData(next);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        const empty = parseWorkshopData(null);
        dataRef.current = empty;
        setData(empty);
      });
    return () => { cancelled = true; void saver.flush(); };
  }, [profileId, saver]);

  const update = useCallback((change: (current: WorkshopData) => WorkshopData) => {
    if (!dataRef.current) return;
    const next = change(dataRef.current);
    dataRef.current = next;
    setData(next);
    saver.save(next);
  }, [saver]);

  const active: WorkshopTool | null = data?.tools.find((tool) => tool.id === data.activeId) ?? null;
  const patchActive = (patch: Partial<WorkshopTool>) => update((current) => ({
    ...current, tools: current.tools.map((tool) => (tool.id === current.activeId ? { ...tool, ...patch } : tool)),
  }));

  const addTool = (name: string, template: string, html = '') => {
    const tool = newWorkshopTool(name, template, html);
    update((current) => ({ tools: [...current.tools, tool], activeId: tool.id }));
    setTab('mine');
    setShowTemplates(false);
  };

  // 匯入: each .html file becomes a new tool in 我的工具; it only ever renders in the sandboxed preview.
  const importFiles = async (files: File[]): Promise<string> => {
    const tools: WorkshopTool[] = [];
    const problems: string[] = [];
    for (const file of files) {
      if (!/.html?$/i.test(file.name)) { problems.push(`${file.name} 不是 .html`); continue; }
      try {
        const result = importedTool(file.name, await readTextFile(file));
        if ('tool' in result) tools.push(result.tool);
        else problems.push(result.error);
      } catch {
        problems.push(`${file.name} 讀不了`);
      }
    }
    if (tools.length > 0) {
      update((current) => ({ tools: [...current.tools, ...tools], activeId: tools[tools.length - 1].id }));
      setTab('mine');
      setShowTemplates(false);
    }
    const head = tools.length > 0 ? `匯入了 ${tools.length} 個工具到「我的工具」：${tools.map((tool) => tool.name).join('、')}` : '沒有匯入任何工具';
    return [head, ...problems].join('；');
  };

  const handleClose = () => { void saver.flush(); onClose(); };

  const applyResult = (result: unknown) => {
    const current = dataRef.current?.tools.find((tool) => tool.id === dataRef.current?.activeId);
    if (!current) return undefined;
    const { name, html } = parseWorkshopResult(result);
    undoStack.current = [...undoStack.current, { toolId: current.id, name: current.name, html: current.html }].slice(-MAX_UNDO);
    setUndoCount(undoStack.current.length);
    const renamed = name && (!current.html || /^(未命名工具|空白|計算機|表單.*|儀表板.*)$/.test(current.name));
    patchActive({ html, ...(renamed ? { name } : {}) });
    return '已更新，不滿意可按上方「復原」';
  };

  const undo = () => {
    const last = undoStack.current.at(-1);
    if (!last) return;
    undoStack.current = undoStack.current.slice(0, -1);
    setUndoCount(undoStack.current.length);
    update((current) => ({ ...current, tools: current.tools.map((tool) => (tool.id === last.toolId ? { ...tool, name: last.name, html: last.html } : tool)) }));
  };

  const rename = () => {
    if (!active) return;
    const name = window.prompt('工具名稱', active.name)?.trim();
    if (name) patchActive({ name: name.slice(0, 60) });
  };

  const remove = () => {
    if (!active || !window.confirm(`刪除「${active.name}」？（已分享到大家的工具的副本不會刪）`)) return;
    update((current) => {
      const tools = current.tools.filter((tool) => tool.id !== active.id);
      return { tools, activeId: tools[0]?.id ?? null };
    });
  };

  const share = () => {
    if (!active?.html) return;
    if (new Blob([active.html]).size > MAX_SHARED_HTML) {
      window.alert('這個工具超過 200KB，太大無法分享。請請 AI 精簡後再試。');
      return;
    }
    if (window.confirm(`把「${active.name}」的目前版本分享給所有人？（署名：${profileName}）`)) shareTool({ name: active.name, html: active.html, author: profileName });
  };

  const sharedActive = shared.find((item) => item.id === sharedPick) ?? null;

  const headerExtra = (
    <>
      <div className="flex shrink-0 overflow-hidden rounded-md border border-border text-xs">
        {([['mine', '我的工具'], ['shared', '大家的工具']] as const).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setTab(id)} className={cn('px-2 py-1', tab === id ? 'bg-primary text-primary-foreground' : 'bg-background text-foreground hover:bg-muted')}>{label}</button>
        ))}
      </div>
      {tab === 'mine' && data && (
        <>
          {data.tools.length > 0 && (
            <select
              aria-label="我的工具"
              value={data.activeId ?? ''}
              onChange={(event) => update((current) => ({ ...current, activeId: event.target.value }))}
              className="max-w-40 shrink-0 rounded-md border border-border bg-background px-1.5 py-1 text-xs text-foreground"
            >
              {data.tools.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}
            </select>
          )}
          <div className="relative shrink-0">
            <button type="button" onClick={() => setShowTemplates(!showTemplates)} className={buttonClass}><Plus className="h-3.5 w-3.5" />新增</button>
            {showTemplates && (
              <div className="absolute left-0 top-full z-30 mt-1 w-56 rounded-md border border-border bg-background p-1 shadow-lg">
                {WORKSHOP_TEMPLATES.map((template) => (
                  <button key={template.name} type="button" onClick={() => addTool(template.name === '空白' ? '未命名工具' : template.name, template.name)} className="block w-full rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted">
                    {template.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          {active && (
            <>
              <button type="button" onClick={rename} className={buttonClass}><Pencil className="h-3.5 w-3.5" />改名</button>
              <button type="button" onClick={undo} disabled={undoCount === 0} className={buttonClass}><Undo2 className="h-3.5 w-3.5" />復原</button>
              <button type="button" onClick={() => download(active.name, active.html)} disabled={!active.html} className={buttonClass}><Download className="h-3.5 w-3.5" />下載</button>
              <button type="button" onClick={share} disabled={!active.html} className={buttonClass}><Share2 className="h-3.5 w-3.5" />分享到大家的工具</button>
              <button type="button" onClick={remove} className={buttonClass}><Trash2 className="h-3.5 w-3.5" />刪除</button>
            </>
          )}
        </>
      )}
    </>
  );

  const emptyHint = active ? (WORKSHOP_TEMPLATES.find((template) => template.name === active.template)?.hint ?? WORKSHOP_TEMPLATES[0].hint) : '';

  return (
    <ToolFrame
      icon={Hammer}
      title="小工具工坊"
      profileName={profileName}
      headerExtra={headerExtra}
      failed={failed}
      isMobile={isMobile}
      onClose={handleClose}
      importer={{ accept: '.html,.htm', hint: '匯入 .html 檔，每個檔變成「我的工具」裡的一個新工具（單檔、200KB 內）', onFiles: importFiles }}
      assist={tab === 'mine' && active ? {
        tool: TOOL_ID,
        getContext: () => ({ name: active.name, html: active.html, template: active.template }),
        onResult: applyResult,
        chat: active.chat,
        onChatChange: (chat) => patchActive({ chat }),
        intro: '描述你想要的小工具，例如「算股票手續費和證交稅的計算機」。做好後可以在左邊直接試用，再叫我修改。',
        placeholder: '想做什麼工具？（Enter 送出）',
      } : undefined}
      startWork={tab === 'mine' ? {
        hint: '把這個小工具交給 AI，做成正式的頁面或功能。',
        disabled: !active?.html,
        onStart: onStartWork ? () => { if (!active) return; void saver.flush(); onStartWork(workshopBrief(active)); } : null,
      } : undefined}
    >
      {!data && <p className="p-6 text-sm text-muted-foreground">載入中…</p>}
      {data && tab === 'mine' && (
        active ? (
          active.html
            ? <Preview html={active.html} title={`預覽：${active.name}`} />
            : <div className="p-6 text-sm text-muted-foreground"><p className="mb-1 font-medium text-foreground">{active.name}（{active.template}）</p><p>{emptyHint}</p><p className="mt-1">在右邊的 AI 對話描述想要的工具，做好會直接顯示在這裡。</p></div>
        ) : (
          <div className="p-6">
            <p className="mb-3 text-sm text-muted-foreground">還沒有工具。選一個起點：</p>
            <div className="flex flex-wrap gap-2">
              {WORKSHOP_TEMPLATES.map((template) => (
                <button key={template.name} type="button" onClick={() => addTool(template.name === '空白' ? '未命名工具' : template.name, template.name)} className="w-52 rounded-lg border border-border p-3 text-left hover:bg-muted">
                  <span className="block text-sm font-medium text-foreground">{template.name}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{template.hint}</span>
                </button>
              ))}
            </div>
          </div>
        )
      )}
      {data && tab === 'shared' && (
        <div className={cn('flex h-full', isMobile && 'flex-col')}>
          <div className={cn('shrink-0 space-y-1 overflow-y-auto border-border p-2', isMobile ? 'max-h-48 border-b' : 'w-72 border-r')}>
            {shared.length === 0 && <p className="p-2 text-xs text-muted-foreground">還沒有人分享。在「我的工具」按「分享到大家的工具」。</p>}
            {shared.map((item) => (
              <div key={item.id} className={cn('rounded-md border p-2', sharedPick === item.id ? 'border-primary bg-muted' : 'border-border')}>
                <button type="button" onClick={() => setSharedPick(item.id)} className="block w-full text-left">
                  <span className="block truncate text-sm font-medium text-foreground">{item.name}</span>
                  <span className="block text-[11px] text-muted-foreground">{item.author || '匿名'}　{item.sharedAt.slice(0, 10)}</span>
                </button>
                {sharedPick === item.id && (
                  <div className="mt-1.5 flex gap-1.5">
                    <button type="button" onClick={() => addTool(`${item.name}（複製）`, '空白', item.html)} className={buttonClass}><Copy className="h-3.5 w-3.5" />複製一份來改</button>
                    {item.author === profileName && (
                      <button type="button" onClick={() => { if (window.confirm(`刪除分享的「${item.name}」？`)) { removeSharedTool(item.id); setSharedPick(null); } }} className={buttonClass}><Trash2 className="h-3.5 w-3.5" />刪除</button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="min-h-0 min-w-0 flex-1">
            {sharedActive ? <Preview html={sharedActive.html} title={`預覽：${sharedActive.name}`} /> : <p className="p-6 text-sm text-muted-foreground">點左邊的工具可以預覽。</p>}
          </div>
        </div>
      )}
    </ToolFrame>
  );
}
