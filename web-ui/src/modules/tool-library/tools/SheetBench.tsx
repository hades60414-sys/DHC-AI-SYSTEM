import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardPaste, Download, Plus, Table2, Trash2, Undo2 } from 'lucide-react';

import { readSpreadsheetFile } from '@/modules/tool-library/importers';
import ToolFrame from '@/modules/tool-library/ToolFrame';
import type { ToolProps } from '@/modules/tool-library/catalog';
import {
  MAX_COLS, MAX_ROWS, MAX_SHEETS, MAX_STEPS, aiContext, applyStep, buildBrief, describeStep, emptySheet, numericColumns, parseBenchData,
  parsePaste, parseStep, replaySteps, toCsv, toTable,
} from '@/modules/tool-library/tools/sheetModel';
import type { BenchData, SheetData, Step, Table } from '@/modules/tool-library/tools/sheetModel';
import SendMenu from '@/modules/tool-library/tools/SendMenu';
import { sheetToDocHandoff, sheetToSlideHandoff } from '@/modules/tool-library/tools/handoffModel';
import { createToolSaver, loadToolData } from '@/shared/customTools';
import { sendToTool } from '@/shared/toolHandoff';
import type { AssistMessage } from '@/shared/customTools';
import { cn } from '@/shared/utils';

const PAGE_ROWS = 200;
const MAX_AI_STEPS = 20;

type GridProps = {
  table: Table;
  /** The sort the last step set, to flip it on the next header click. */
  sortedBy: { column: string; order: 'asc' | 'desc' } | null;
  onSort: (column: string) => void;
  onEdit: (row: number, column: string, value: string) => void;
};

/** The table: plain cells (fast), one input at a time for editing, a page of rows at a time. */
function Grid({ table, sortedBy, onSort, onEdit }: GridProps) {
  const [visible, setVisible] = useState(PAGE_ROWS);
  // Number columns line up on the right, like Excel.
  const numeric = useMemo(() => numericColumns(table), [table]);
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [draft, setDraft] = useState('');

  const commit = () => {
    if (editing && draft !== table.rows[editing.r]?.[editing.c]) onEdit(editing.r + 1, table.columns[editing.c], draft);
    setEditing(null);
  };

  return (
    <div>
      <table className="border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-muted">
          <tr>
            <th className="border border-border px-1.5 py-1 text-right font-normal text-muted-foreground">#</th>
            {table.columns.map((name) => (
              <th key={name} className="border border-border p-0 text-left font-semibold text-foreground">
                <button type="button" onClick={() => onSort(name)} title="點一下排序（會記成一個步驟）" className={cn('flex w-full items-center gap-1 whitespace-nowrap px-2 py-1 hover:bg-background', numeric[table.columns.indexOf(name)] && 'justify-end')}>
                  {name}
                  {sortedBy?.column === name && <span className="text-primary">{sortedBy.order === 'asc' ? '▲' : '▼'}</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.slice(0, visible).map((row, r) => (
            <tr key={r}>
              <td className="border border-border bg-muted/40 px-1.5 py-0.5 text-right text-muted-foreground">{r + 1}</td>
              {row.map((cell, c) => (
                <td
                  key={c}
                  onClick={() => { setEditing({ r, c }); setDraft(cell); }}
                  className={cn('max-w-96 cursor-text whitespace-nowrap border border-border px-2 py-0.5 text-foreground', numeric[c] && 'text-right tabular-nums')}
                >
                  {editing?.r === r && editing.c === c ? (
                    <input
                      autoFocus
                      aria-label={`${table.columns[c]} 第 ${r + 1} 列`}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={commit}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Enter') commit();
                        if (event.key === 'Escape') { event.preventDefault(); setEditing(null); }
                      }}
                      className="w-full min-w-24 bg-background text-foreground outline-none ring-1 ring-primary"
                    />
                  ) : (
                    <span className="block overflow-hidden text-ellipsis">{cell || ' '}</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.rows.length > visible && (
        <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
          <span>顯示 {visible} / {table.rows.length} 列</span>
          <button type="button" onClick={() => setVisible(visible + PAGE_ROWS)} className="rounded border border-border px-2 py-0.5 hover:bg-muted">再顯示 {PAGE_ROWS} 列</button>
          <button type="button" onClick={() => setVisible(table.rows.length)} className="rounded border border-border px-2 py-0.5 hover:bg-muted">全部</button>
        </div>
      )}
    </div>
  );
}

function PasteBox({ onGrid }: { onGrid: (text: string) => void }) {
  const [text, setText] = useState('');
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-2 p-6">
      <p className="text-sm text-foreground">從 Excel 選好範圍複製（Ctrl+C），在下面的框按 Ctrl+V 貼上；CSV 文字也可以。</p>
      <textarea
        aria-label="貼上表格"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData('text');
          if (!pasted) return;
          event.preventDefault();
          onGrid(pasted);
        }}
        rows={10}
        placeholder="在這裡貼上"
        className="rounded-md border border-border bg-background p-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
      />
      <button
        type="button"
        onClick={() => onGrid(text)}
        disabled={!text.trim()}
        className="self-start rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
      >
        轉成表格
      </button>
      <p className="text-xs text-muted-foreground">上限 {MAX_ROWS} 列 × {MAX_COLS} 欄，超過的部分不會收進來。</p>
    </div>
  );
}

const downloadCsv = (name: string, table: Table) => {
  const blob = new Blob([`﻿${toCsv(table)}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name.replace(/[\\/:*?"<>|]/g, '_') || '工作表'}.csv`;
  link.click();
  URL.revokeObjectURL(url);
};

/** DHC CLI 10/14 試算工作台: paste from Excel, let the AI propose steps, run them exactly, undo, export, 開工. */
export default function SheetBench({ profileId, profileName, isMobile, onClose, onStartWork }: ToolProps) {
  const [data, setData] = useState<BenchData | null>(null);
  const [failed, setFailed] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [notice, setNotice] = useState('');
  const dataRef = useRef<BenchData | null>(null);
  const saver = useMemo(() => createToolSaver('sheet-bench', profileId, () => setFailed(true)), [profileId]);

  const commitData = useCallback((next: BenchData) => {
    dataRef.current = next;
    setData(next);
    saver.save(next);
  }, [saver]);

  useEffect(() => {
    let cancelled = false;
    loadToolData('sheet-bench', profileId)
      .then((stored) => {
        if (cancelled) return;
        const parsed = parseBenchData(stored);
        dataRef.current = parsed;
        setData(parsed);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [profileId]);

  const active = data?.sheets.find((sheet) => sheet.id === data.activeId) ?? null;
  const base = useMemo(() => (active ? toTable(active.raw, active.header) : null), [active?.raw, active?.header]); // eslint-disable-line react-hooks/exhaustive-deps
  const replayed = useMemo(() => (base && active ? replaySteps(base, active.steps) : null), [base, active?.steps]); // eslint-disable-line react-hooks/exhaustive-deps
  const table = replayed?.table ?? null;
  const tableRef = useRef<Table | null>(null);
  useEffect(() => { tableRef.current = table; }, [table]);

  const patchSheet = useCallback((id: string, patch: Partial<SheetData>) => {
    const current = dataRef.current;
    if (!current) return;
    commitData({ ...current, sheets: current.sheets.map((sheet) => (sheet.id === id ? { ...sheet, ...patch } : sheet)) });
  }, [commitData]);

  const close = useCallback(() => {
    void saver.flush();
    onClose();
  }, [onClose, saver]);

  if (!data) {
    return (
      <ToolFrame icon={Table2} title="試算工作台" profileName={profileName} failed={failed} isMobile={isMobile} onClose={onClose}>
        <p className="py-6 text-center text-sm text-muted-foreground">{failed ? '讀不到資料，稍後再開一次。' : '載入中…'}</p>
      </ToolFrame>
    );
  }
  if (!active || !table || !replayed) return null;

  const hasData = active.raw.length > 0;
  const lastStep = active.steps[active.steps.length - 1];
  const sortedBy = lastStep?.op === 'sort' ? { column: lastStep.column, order: lastStep.order } : null;

  const addSteps = (steps: Step[]) => patchSheet(active.id, { steps: [...active.steps, ...steps] });

  const loadPasted = (text: string) => {
    const grid = parsePaste(text);
    if (grid.raw.length === 0) { setNotice('貼上的內容是空的。'); return; }
    if (active.steps.length > 0 && !window.confirm('這張工作表已有整理步驟，貼上新資料會清掉它們。繼續？')) return;
    patchSheet(active.id, {
      raw: grid.raw,
      header: true,
      truncated: grid.truncated,
      steps: [],
      source: `從 Excel 貼上（${grid.delimiter === 'tab' ? 'Tab 分隔' : 'CSV'}，${new Date().toLocaleString('zh-TW', { hour12: false })}）`,
    });
    setPasting(false);
    setNotice('');
  };

  const sortBy = (column: string) => {
    if (active.steps.length >= MAX_STEPS) { setNotice(`步驟已達上限 ${MAX_STEPS}。`); return; }
    addSteps([{ op: 'sort', column, order: sortedBy?.column === column && sortedBy.order === 'asc' ? 'desc' : 'asc' }]);
  };

  const editCell = (row: number, column: string, value: string) => {
    const step: Step = { op: 'set_cell', row, column, value };
    // Typing over the same cell again just replaces the earlier edit.
    if (lastStep?.op === 'set_cell' && lastStep.row === row && lastStep.column === column) {
      patchSheet(active.id, { steps: [...active.steps.slice(0, -1), step] });
      return;
    }
    if (active.steps.length >= MAX_STEPS) { setNotice(`步驟已達上限 ${MAX_STEPS}。`); return; }
    addSteps([step]);
  };

  const undo = () => patchSheet(active.id, { steps: active.steps.slice(0, -1) });

  const applyFromAi = (result: unknown): string => {
    const current = dataRef.current;
    const sheet = current?.sheets.find((item) => item.id === current.activeId);
    const startTable = tableRef.current;
    const list = (result as { steps?: unknown } | null)?.steps;
    if (!current || !sheet || !startTable || !Array.isArray(list)) throw new Error('no steps');
    let running = startTable;
    const applied: Step[] = [];
    const notes: string[] = [];
    let problem = '';
    const queue = list.slice(0, MAX_AI_STEPS);
    for (const [index, raw] of queue.entries()) {
      if (sheet.steps.length + applied.length >= MAX_STEPS) { problem = `步驟已達上限 ${MAX_STEPS}`; break; }
      try {
        const step = parseStep(raw);
        // 彙總 goes to a new sheet built from the table so far, so the detail rows stay here.
        if (step.op === 'group_by' && current.sheets.length < MAX_SHEETS) {
          const summary = {
            ...emptySheet(`${sheet.name}-彙總`.slice(0, 40)),
            raw: [running.columns, ...running.rows],
            source: `由「${sheet.name}」彙總`,
          };
          const rest: Step[] = [];
          let tail = running;
          try {
            for (const later of queue.slice(index)) {
              const parsed = parseStep(later);
              tail = applyStep(tail, parsed).table;
              rest.push(parsed);
            }
          } catch (error) {
            problem = `彙總表第 ${rest.length + 1} 步沒做成：${(error as Error).message}`;
          }
          const sheets = current.sheets.map((item) => (item.id === sheet.id ? { ...item, steps: [...item.steps, ...applied] } : item));
          commitData({ ...current, sheets: [...sheets, { ...summary, steps: rest }], activeId: summary.id });
          const head = [
            applied.length > 0 ? `這張工作表執行了 ${applied.length} 步：\n${notes.map((n, i) => `${i + 1}. ${n}`).join('\n')}` : '',
            `彙總放在新的工作表「${summary.name}」（${tail.rows.length} 列），原本的明細留在「${sheet.name}」。`,
          ].filter(Boolean).join('\n');
          return problem ? `${head}\n${problem}` : head;
        }
        const done = applyStep(running, step);
        running = done.table;
        applied.push(step);
        notes.push(`${describeStep(step)}${done.note ? `（${done.note}）` : ''}`);
      } catch (error) {
        problem = `第 ${applied.length + 1} 步沒做成：${(error as Error).message}`;
        break;
      }
    }
    if (applied.length > 0) patchSheet(sheet.id, { steps: [...sheet.steps, ...applied] });
    const head = applied.length > 0 ? `已執行 ${applied.length} 步，可按「復原」退回：\n${notes.map((n, i) => `${i + 1}. ${n}`).join('\n')}` : '沒有執行任何步驟';
    return problem ? `${head}\n${problem}` : head;
  };

  const setChat = (chat: AssistMessage[]) => { if (dataRef.current) patchSheet(dataRef.current.activeId, { chat }); };

  const startWork = () => {
    if (!onStartWork) return;
    void saver.flush();
    onStartWork(buildBrief(active.name, active.source, base as Table, active.steps, table));
    onClose();
  };

  const importFiles = async (files: File[]): Promise<string> => {
    const notes: string[] = [];
    const incoming: SheetData[] = [];
    for (const file of files) {
      let read: Awaited<ReturnType<typeof readSpreadsheetFile>>;
      try {
        read = await readSpreadsheetFile(file);
      } catch (error) {
        notes.push(`${file.name}：${(error as Error).message}`);
        continue;
      }
      const stem = file.name.replace(/\.[^.\\/]+$/, '');
      const isBook = /\.xls[xm]$/i.test(file.name);
      for (const sheet of read) {
        const where = isBook ? `${file.name} 的工作表『${sheet.name}』` : file.name;
        if (sheet.rows.length === 0) { notes.push(`${where}是空的，略過`); continue; }
        const width = Math.min(MAX_COLS, sheet.rows[0].length);
        const truncated = sheet.rows.length > MAX_ROWS + 1 || sheet.rows[0].length > MAX_COLS;
        const raw = sheet.rows.slice(0, MAX_ROWS + 1).map((row) => row.slice(0, width));
        incoming.push({
          ...emptySheet((isBook ? `${stem}-${sheet.name}` : stem).slice(0, 40)),
          raw,
          truncated,
          source: `匯入 ${where}（${new Date().toLocaleString('zh-TW', { hour12: false })}）`,
        });
        notes.push(`已匯入 ${where}：${Math.max(0, raw.length - 1).toLocaleString('en-US')} 列 × ${width} 欄${truncated ? `（超過 ${MAX_ROWS} 列 × ${MAX_COLS} 欄，多的沒收進來）` : ''}`);
      }
    }
    const current = dataRef.current;
    if (!current || incoming.length === 0) return notes.join('；') || '沒有可匯入的內容。';
    // A still-empty current sheet is dropped so the import does not leave a blank sheet behind.
    const kept = current.sheets.filter((sheet) => !(sheet.id === current.activeId && sheet.raw.length === 0 && sheet.steps.length === 0));
    const taken = incoming.slice(0, Math.max(0, MAX_SHEETS - kept.length));
    if (taken.length === 0) return `工作表已達上限 ${MAX_SHEETS} 張，先刪掉不要的再匯入。`;
    commitData({ ...current, sheets: [...kept, ...taken], activeId: taken[0].id });
    setPasting(false);
    setNotice('');
    const skipped = incoming.length - taken.length;
    return [...notes, ...(skipped > 0 ? [`工作表最多 ${MAX_SHEETS} 張，有 ${skipped} 張沒匯入`] : [])].join('；');
  };

  const sendTable = (build: typeof sheetToDocHandoff) => {
    void saver.flush();
    sendToTool(build(active.name, table));
  };

  const addSheet = () => {
    if (data.sheets.length >= MAX_SHEETS) { setNotice(`工作表最多 ${MAX_SHEETS} 張。`); return; }
    const sheet = emptySheet(`工作表 ${data.sheets.length + 1}`);
    commitData({ ...data, sheets: [...data.sheets, sheet], activeId: sheet.id });
    setPasting(false);
  };
  const renameSheet = () => {
    const name = window.prompt('工作表名稱', active.name)?.trim();
    if (name) patchSheet(active.id, { name: name.slice(0, 40) });
  };
  const removeSheet = () => {
    if (!window.confirm(`刪除工作表「${active.name}」？刪了就找不回來。`)) return;
    const rest = data.sheets.filter((sheet) => sheet.id !== active.id);
    const sheets = rest.length > 0 ? rest : [emptySheet('工作表 1')];
    commitData({ ...data, sheets, activeId: sheets[0].id });
  };

  return (
    <ToolFrame
      icon={Table2}
      title="試算工作台"
      profileName={profileName}
      failed={failed}
      isMobile={isMobile}
      onClose={close}
      headerExtra={(
        <>
          <select
            aria-label="選擇工作表"
            value={active.id}
            onChange={(event) => { commitData({ ...data, activeId: event.target.value }); setPasting(false); }}
            className="min-w-0 max-w-48 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
          >
            {data.sheets.map((sheet) => <option key={sheet.id} value={sheet.id}>{sheet.name}</option>)}
          </select>
          <button type="button" onClick={addSheet} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="新工作表" aria-label="新工作表"><Plus className="h-4 w-4" /></button>
          <button type="button" onClick={renameSheet} className="shrink-0 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">改名</button>
          <button type="button" onClick={removeSheet} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive" title="刪除這張工作表" aria-label="刪除這張工作表"><Trash2 className="h-4 w-4" /></button>
          <SendMenu
            items={[
              { label: '表格放進文件', disabled: !hasData, onPick: () => sendTable(sheetToDocHandoff) },
              { label: '做成一頁簡報', disabled: !hasData, onPick: () => sendTable(sheetToSlideHandoff) },
            ]}
          />
        </>
      )}
      importer={{ accept: '.xlsx,.xlsm,.csv,.tsv,.txt', hint: '匯入 Excel（.xlsx）或 CSV／TSV，每張工作表會變成一張', onFiles: importFiles }}
      assist={{
        tool: 'sheet-bench',
        getContext: () => (tableRef.current ? aiContext(active.name, tableRef.current, dataRef.current?.sheets.find((s) => s.id === dataRef.current?.activeId)?.steps ?? []) : null),
        onResult: applyFromAi,
        chat: active.chat,
        onChatChange: setChat,
        intro: '先貼上一份表格，再跟我說要怎麼整理，例如「去掉前後空白、把金額轉成數字、算每個客戶的金額合計」。我只會給步驟，由頁面精確計算，每一步都能復原。',
        placeholder: '要怎麼整理這份表？（Enter 送出）',
        busyText: 'AI 正在想步驟（約 15–60 秒）',
      }}
      startWork={{
        hint: '整理好了按「開工」：會開新對話，請 AI 把這些步驟寫成可重跑的 Node.js 腳本。',
        disabled: !hasData || active.steps.length === 0,
        onStart: onStartWork ? startWork : null,
      }}
      footerExtra={(
        <button
          type="button"
          onClick={() => downloadCsv(active.name, table)}
          disabled={!hasData}
          className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
          匯出 CSV
        </button>
      )}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          <button type="button" onClick={() => setPasting(true)} className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-foreground hover:bg-muted">
            <ClipboardPaste className="h-3.5 w-3.5" />
            貼上新資料
          </button>
          <label className="flex items-center gap-1" title={active.steps.length > 0 ? '已有步驟，先復原到沒有步驟才能改' : ''}>
            <input
              type="checkbox"
              checked={active.header}
              disabled={active.steps.length > 0}
              onChange={(event) => patchSheet(active.id, { header: event.target.checked })}
            />
            第一列是欄名
          </label>
          {hasData && <span>{table.rows.length} 列 × {table.columns.length} 欄</span>}
          {active.truncated && <span className="text-destructive">貼上的內容超過 {MAX_ROWS} 列 × {MAX_COLS} 欄，多出的部分沒有收進來。</span>}
          {replayed.failedAt !== null && <span className="text-destructive">第 {replayed.failedAt + 1} 步之後的步驟無法套用，已停在那裡。</span>}
          {notice && <span className="text-destructive">{notice}</span>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {!hasData || pasting ? <PasteBox onGrid={loadPasted} /> : (
            <Grid key={`${active.id}:${active.header}`} table={table} sortedBy={sortedBy} onSort={sortBy} onEdit={editCell} />
          )}
        </div>
        <div className="max-h-40 flex-shrink-0 overflow-y-auto border-t border-border bg-muted/20 px-3 py-1.5 text-xs">
          <div className="mb-1 flex items-center gap-2">
            <span className="font-semibold text-foreground">步驟（{active.steps.length}）</span>
            <button type="button" onClick={undo} disabled={active.steps.length === 0} className="flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-foreground hover:bg-muted disabled:opacity-40">
              <Undo2 className="h-3 w-3" />
              復原最後一步
            </button>
          </div>
          {active.steps.length === 0 ? (
            <p className="text-muted-foreground">還沒有步驟。請 AI 整理、點欄名排序或直接改格子，都會記在這裡。</p>
          ) : (
            <ol className={cn('list-decimal space-y-0.5 pl-5 text-foreground')}>
              {active.steps.map((step, index) => <li key={index}>{describeStep(step)}</li>)}
            </ol>
          )}
        </div>
      </div>
    </ToolFrame>
  );
}
