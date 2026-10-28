import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, CalendarPlus, GanttChart, Kanban, Link2, ListChecks, Pencil, Plus, Sun, Trash2, Undo2 } from 'lucide-react';

import { TaskMarker } from '@/modules/todo-dock';
import ToolFrame from '@/modules/tool-library/ToolFrame';
import type { ToolProps } from '@/modules/tool-library/catalog';
import {
  COLUMNS, QUADRANT_LABEL, aiContext, applyAiItems, boardBrief, boardFromCardsPayload, cardBrief, columnLabel, dateOfDay,
  emptyBoard, emptyItem, MAX_BOARD_ITEMS, dayIndexAt, ganttDayWidth, ganttGrid, moveSpan, resizeSpan, itemsFromRows, itemsFromText, itemsFromTodos, parseBoards, todayText,
  stripLegacyTodoNote, syncWithTodos, todoRows,
} from '@/modules/tool-library/tools/projectBoardModel';
import type { ColumnId, ProjectBoardData, WorkItem } from '@/modules/tool-library/tools/projectBoardModel';
import { readSpreadsheetFile, readTextFile } from '@/modules/tool-library/importers';
import { createToolSaver, loadToolData } from '@/shared/customTools';
import type { AssistMessage } from '@/shared/customTools';
import { addTodo, editTodo, effectiveQuadrant, readPersonTodos, setTodoDone, setTodoToday, startPersonTodosSync, usePersonTodos } from '@/shared/personTodos';
import type { TodoItem } from '@/shared/personTodos';
import { takeHandoff } from '@/shared/toolHandoff';
import { cn } from '@/shared/utils';

const TOOL_ID = 'project-board';
const DAY_WIDTH = 28;
const LABEL_WIDTH = 176;

// Bar and card accent per column.
const COLUMN_STYLE: Record<ColumnId, string> = {
  todo: 'bg-slate-400/80',
  doing: 'bg-sky-500/80',
  ai: 'bg-violet-500/80',
  done: 'bg-emerald-500/80',
};

const handedText = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

type EditorProps = {
  draft: WorkItem;
  /** The to-do this card follows; its name and quadrant are edited in 待辦. */
  linked?: TodoItem;
  todos: TodoItem[];
  isNew: boolean;
  others: WorkItem[];
  onSave: (item: WorkItem) => void;
  onDelete: () => void;
  onCancel: () => void;
};

/** Edit one card: title, note, dates, column and what it waits for. */
function ItemEditor({ draft, linked: initialLink, todos, isNew, others, onSave, onDelete, onCancel }: EditorProps) {
  const [item, setItem] = useState(draft);
  const linked = item.todoId ? initialLink : undefined;
  const set = (patch: Partial<WorkItem>) => setItem((current) => ({ ...current, ...patch }));
  const field = 'w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary';

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-3" role="dialog" aria-label={isNew ? '新增工作' : '編輯工作'}>
      <div className="max-h-full w-full max-w-md space-y-3 overflow-y-auto rounded-lg border border-border bg-background p-4 shadow-xl">
        <label className="block text-xs text-muted-foreground">
          標題
          <input
            aria-label="標題"
            value={linked ? linked.text : item.title}
            readOnly={Boolean(linked)}
            onChange={(event) => set({ title: event.target.value })}
            className={cn(field, 'mt-1', linked && 'cursor-default bg-muted/40')}
            autoFocus={!linked}
          />
        </label>
        {linked && (
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground">
            <TaskMarker quadrant={effectiveQuadrant(todos, linked.id)} main={!linked.parentId} />
            <span className="min-w-0 flex-1">連到你的待辦：名稱、四象限、到期日在待辦改；這張卡拖到完成，待辦也會勾掉。</span>
            <button
              type="button"
              onClick={() => set({ todoId: undefined, title: linked.text })}
              className="shrink-0 rounded px-1.5 py-0.5 text-foreground hover:bg-muted"
            >
              解除連結
            </button>
          </div>
        )}
        <label className="block text-xs text-muted-foreground">
          說明
          <textarea aria-label="說明" value={item.note} onChange={(event) => set({ note: event.target.value })} rows={4} className={cn(field, 'mt-1 resize-none')} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs text-muted-foreground">
            開始日
            <input aria-label="開始日" type="date" value={item.start} onChange={(event) => set({ start: event.target.value })} className={cn(field, 'mt-1')} />
          </label>
          <label className="block text-xs text-muted-foreground">
            結束日
            <input aria-label="結束日" type="date" value={item.end} onChange={(event) => set({ end: event.target.value })} className={cn(field, 'mt-1')} />
          </label>
        </div>
        <label className="block text-xs text-muted-foreground">
          欄位
          <select aria-label="欄位" value={item.column} onChange={(event) => set({ column: event.target.value as ColumnId })} className={cn(field, 'mt-1')}>
            {COLUMNS.map((column) => <option key={column.id} value={column.id}>{column.label}</option>)}
          </select>
        </label>
        {others.length > 0 && (
          <fieldset className="text-xs text-muted-foreground">
            <legend>要等這些做完（相依）</legend>
            <div className="mt-1 max-h-28 space-y-0.5 overflow-y-auto rounded-md border border-border p-1.5">
              {others.map((other) => (
                <label key={other.id} className="flex items-center gap-1.5 text-foreground">
                  <input
                    type="checkbox"
                    checked={item.dependsOn.includes(other.id)}
                    onChange={(event) => set({ dependsOn: event.target.checked ? [...item.dependsOn, other.id] : item.dependsOn.filter((id) => id !== other.id) })}
                  />
                  <span className="truncate">{linkedTodo(todos, other)?.text ?? other.title}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="flex items-center gap-2 pt-1">
          {!isNew && (
            <button type="button" onClick={onDelete} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
              刪除
            </button>
          )}
          <button type="button" onClick={onCancel} className="ml-auto rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-muted">取消</button>
          <button
            type="button"
            onClick={() => onSave({ ...item, title: (linked ? linked.text : item.title).trim() })}
            disabled={!(linked ? linked.text : item.title).trim()}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            儲存
          </button>
        </div>
      </div>
    </div>
  );
}

type PickerProps = {
  todos: TodoItem[];
  /** To-do ids that already have a card on this board. */
  onBoard: ReadonlySet<string>;
  onImport: (ids: Set<string>) => void;
  onCancel: () => void;
};

/** 從待辦匯入: the person's open to-dos as a tree with checkboxes; 今日待辦 ones start checked. */
function TodoPicker({ todos, onBoard, onImport, onCancel }: PickerProps) {
  const rows = useMemo(() => todoRows(todos), [todos]);
  const free = rows.filter(({ todo }) => !onBoard.has(todo.id));
  const [picked, setPicked] = useState(() => new Set(free.filter(({ todo }) => todo.today).map(({ todo }) => todo.id)));
  const toggle = (id: string, on: boolean) => setPicked((current) => {
    const next = new Set(current);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  const flat = 'rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground';

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-3" role="dialog" aria-label="從待辦匯入">
      <div className="flex max-h-full w-full max-w-md flex-col gap-2 rounded-lg border border-border bg-background p-4 shadow-xl">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">從待辦匯入</h3>
          <button type="button" onClick={() => setPicked(new Set(free.map(({ todo }) => todo.id)))} className={cn(flat, 'ml-auto')}>全選</button>
          <button type="button" onClick={() => setPicked(new Set())} className={flat}>全不選</button>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto rounded-md border border-border p-1.5">
          {rows.length === 0 && <p className="px-1 py-3 text-center text-xs text-muted-foreground">沒有未完成的待辦。</p>}
          {rows.map(({ todo, depth, quadrant }) => {
            const already = onBoard.has(todo.id);
            return (
              <label key={todo.id} className={cn('flex items-center gap-1.5 text-sm text-foreground', already && 'opacity-50')} style={{ paddingLeft: depth * 16 }}>
                <input type="checkbox" aria-label={todo.text} disabled={already} checked={!already && picked.has(todo.id)} onChange={(event) => toggle(todo.id, event.target.checked)} />
                <span className="min-w-0 flex-1 truncate">{todo.text}</span>
                {quadrant && <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">{QUADRANT_LABEL[quadrant]}</span>}
                {todo.due && <span className="shrink-0 text-[11px] text-muted-foreground">{todo.due}</span>}
                {already && <span className="shrink-0 text-[11px] text-muted-foreground">已在板上</span>}
              </label>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onCancel} className="ml-auto rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-muted">取消</button>
          <button type="button" onClick={() => onImport(picked)} disabled={picked.size === 0} className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
            匯入{picked.size > 0 ? ` ${picked.size} 項` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

type ViewProps = {
  items: WorkItem[];
  /** The person's to-dos; a card with todoId shows that to-do's text, quadrant, due date and 今日. */
  todos: TodoItem[];
  onEdit: (item: WorkItem) => void;
};

/** The to-do a card is linked to, if it still exists. */
const linkedTodo = (todos: TodoItem[], item: WorkItem) => (item.todoId ? todos.find((todo) => todo.id === item.todoId) : undefined);
/** A card as the person sees it: a linked card takes its to-do's current name, and its due date when it has no end. */
const liveItem = (item: WorkItem, todos: TodoItem[]): WorkItem => {
  const todo = linkedTodo(todos, item);
  return todo ? { ...item, title: todo.text, end: item.end || todo.due || '' } : item;
};
const liveBoard = (board: ProjectBoardData, todos: TodoItem[]): ProjectBoardData => ({ ...board, items: board.items.map((item) => liveItem(item, todos)) });

type KanbanProps = ViewProps & {
  canHandOff: boolean;
  canToToday: boolean;
  onToToday: (item: WorkItem) => void;
  /** Puts a linked to-do on 今日待辦. */
  onTodayLinked: (todo: TodoItem) => void;
  onMove: (id: string, column: ColumnId) => void;
  onHandOff: (item: WorkItem) => void;
  onAdd: (column: ColumnId) => void;
};

function KanbanView({ items, todos, canHandOff, canToToday, onToToday, onTodayLinked, onEdit, onMove, onHandOff, onAdd }: KanbanProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<ColumnId | null>(null);

  return (
    <div className="grid h-full min-w-[44rem] grid-cols-4 gap-2 p-3">
      {COLUMNS.map((column) => {
        const inColumn = items.filter((item) => item.column === column.id);
        return (
          <div
            key={column.id}
            data-testid={`column-${column.id}`}
            onDragOver={(event) => { event.preventDefault(); setOverColumn(column.id); }}
            onDragLeave={() => setOverColumn((current) => (current === column.id ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              const id = dragId ?? event.dataTransfer.getData('text/plain');
              setDragId(null);
              setOverColumn(null);
              if (id) onMove(id, column.id);
            }}
            className={cn('flex min-h-0 flex-col rounded-lg border border-border bg-muted/30', overColumn === column.id && 'border-primary bg-primary/5')}
          >
            <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5">
              <span className={cn('h-2 w-2 rounded-full', COLUMN_STYLE[column.id])} />
              <span className="text-xs font-semibold text-foreground">{column.label}</span>
              <span className="text-[11px] text-muted-foreground">{inColumn.length}</span>
              <button type="button" onClick={() => onAdd(column.id)} aria-label={`在${column.label}新增工作`} className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-1.5">
              {inColumn.map((item) => {
                const todo = linkedTodo(todos, item);
                const title = todo?.text ?? item.title;
                const note = stripLegacyTodoNote(item.note);
                const end = item.end || todo?.due || '';
                return (
                <div
                  key={item.id}
                  draggable
                  onDragStart={(event) => { setDragId(item.id); event.dataTransfer.setData('text/plain', item.id); event.dataTransfer.effectAllowed = 'move'; }}
                  onDragEnd={() => { setDragId(null); setOverColumn(null); }}
                  className={cn('cursor-grab rounded-md border border-border bg-background p-2 text-sm shadow-sm', dragId === item.id && 'opacity-50')}
                >
                  <div className="flex items-start gap-1.5">
                    {todo && <TaskMarker quadrant={effectiveQuadrant(todos, todo.id)} main={!todo.parentId} className="mt-1.5" />}
                    <span className="min-w-0 flex-1 break-words font-medium text-foreground">{title}</span>
                    {todo && (
                      <span title="連到你的待辦：在待辦勾掉，這張卡就移到完成；這張卡拖到完成，待辦也會勾掉" className="mt-0.5 shrink-0 text-muted-foreground">
                        <Link2 className="h-3 w-3" aria-label="連到待辦" />
                      </span>
                    )}
                    <button type="button" onClick={() => onEdit(item)} aria-label={`編輯 ${item.title}`} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                      <Pencil className="h-3 w-3" />
                    </button>
                  </div>
                  {note && <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">{note}</p>}
                  {(item.start || end) && <p className="mt-1 text-[11px] text-muted-foreground">{item.start ? `${item.start} ~ ${end || '？'}` : `到期 ${end}`}</p>}
                  {item.dependsOn.length > 0 && (
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      等：{item.dependsOn.map((id) => items.find((other) => other.id === id)?.title).filter(Boolean).join('、')}
                    </p>
                  )}
                  <div className="mt-1 flex items-center gap-1">
                    {item.handedAt && <span className="text-[11px] text-violet-500">{handedText(item.handedAt)} 交給 AI</span>}
                    {todo && todo.today && !todo.done && (
                      <span className="flex items-center gap-0.5 rounded bg-amber-500/15 px-1 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                        <Sun className="h-3 w-3" />
                        今日
                      </span>
                    )}
                    {todo && !todo.today && !todo.done && (
                      <button
                        type="button"
                        onClick={() => onTodayLinked(todo)}
                        aria-label={`排進今日待辦：${title}`}
                        className="ml-auto flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-primary"
                      >
                        <CalendarPlus className="h-3 w-3" />
                        排進今日
                      </button>
                    )}
                    {!todo && item.column !== 'done' && (
                      <button
                        type="button"
                        onClick={() => onToToday(item)}
                        disabled={!canToToday}
                        aria-label={`加到今日待辦：${item.title}`}
                        title={canToToday ? '' : '這台裝置的專案設定沒有對應的專案'}
                        className="ml-auto flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-primary disabled:opacity-40"
                      >
                        <CalendarPlus className="h-3 w-3" />
                        加到今日待辦
                      </button>
                    )}
                    {item.column !== 'done' && (
                      <button
                        type="button"
                        onClick={() => onHandOff(item)}
                        disabled={!canHandOff}
                        style={todo?.today && !todo.done ? { marginLeft: 'auto' } : undefined}
                        aria-label={`交給 AI：${item.title}`}
                        className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-primary disabled:opacity-40"
                      >
                        <Bot className="h-3 w-3" />
                        交給 AI
                      </button>
                    )}
                  </div>
                </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Day grid with one CSS bar per dated card, a line for today, and the cards without dates listed below. */
type GanttProps = ViewProps & {
  /** Sets both dates of a card (drop on a day, move or resize a bar). */
  onSchedule: (id: string, start: string, end: string) => void;
};
type BarDrag = { id: string; mode: 'move' | 'resize'; startX: number; delta: number; offset: number; length: number };

function GanttView({ items: cards, todos, onEdit, onSchedule }: GanttProps) {
  const today = todayText();
  // A linked card without its own end date uses the to-do's due date.
  const items = useMemo(() => cards.map((item) => {
    const todo = linkedTodo(todos, item);
    return todo && !item.end && todo.due ? { ...item, end: todo.due } : item;
  }), [cards, todos]);
  const layout = useMemo(() => ganttGrid(items, today), [items, today]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return undefined;
    const measure = () => setWidth(node.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const dayWidth = ganttDayWidth(width, LABEL_WIDTH, layout.days, DAY_WIDTH);
  const gridWidth = layout.days * dayWidth;
  const dayCells = Array.from({ length: layout.days }, (_, index) => dateOfDay(layout.firstDay + index));
  const isWeekend = (index: number) => (layout.firstDay + index + 3) % 7 >= 5;

  const chipId = useRef('');
  const [overDate, setOverDate] = useState('');
  const dropOn = (event: React.DragEvent, date: string) => {
    event.preventDefault();
    setOverDate('');
    const id = event.dataTransfer.getData('text/plain') || chipId.current;
    chipId.current = '';
    if (id && cards.some((card) => card.id === id)) onSchedule(id, date, date);
  };
  const dropInRow = (event: React.DragEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    dropOn(event, dateOfDay(layout.firstDay + dayIndexAt((event.clientX || 0) - rect.left, dayWidth, layout.days)));
  };

  // Moving or resizing a bar: pointer events, snapped to whole days, committed on pointerup.
  const dragRef = useRef<BarDrag | null>(null);
  const [drag, setDrag] = useState<BarDrag | null>(null);
  const setBarDrag = (next: BarDrag | null) => { dragRef.current = next; setDrag(next); };
  const barDown = (event: React.PointerEvent<HTMLElement>, id: string, mode: BarDrag['mode'], offset: number, length: number) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setBarDrag({ id, mode, startX: event.clientX, delta: 0, offset, length });
  };
  const barMove = (event: React.PointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (!current) return;
    const raw = Math.round((event.clientX - current.startX) / dayWidth);
    const delta = current.mode === 'move'
      ? Math.min(Math.max(raw, -current.offset), layout.days - current.length - current.offset)
      : Math.min(Math.max(raw, 1 - current.length), layout.days - current.offset - current.length);
    if (delta !== current.delta) setBarDrag({ ...current, delta });
  };
  const barUp = (item: WorkItem) => {
    const current = dragRef.current;
    setBarDrag(null);
    if (!current || current.id !== item.id) return;
    if (current.delta === 0) {
      if (current.mode === 'move') onEdit(item);
      return;
    }
    const start = item.start || item.end;
    const end = item.end || item.start;
    const next = current.mode === 'move' ? moveSpan(start, end, current.delta) : resizeSpan(start, end, current.delta);
    onSchedule(item.id, next.start, next.end);
  };

  const dayHeader = (date: string, index: number) => (date.slice(8) === '01' || index === 0 ? `${Number(date.slice(5, 7))}/${Number(date.slice(8))}` : Number(date.slice(8)));

  return (
    <div className="p-3">
      {layout.bars.length === 0 && <p className="mb-2 text-xs text-muted-foreground">把下面的工作拖到日期上就排好時程；或請右邊 AI 排時程</p>}
      <div ref={wrapRef} className="overflow-x-auto rounded-lg border border-border">
        <div style={{ width: LABEL_WIDTH + gridWidth }}>
          <div className="flex border-b border-border bg-muted/40 text-[10px] text-muted-foreground">
            <div className="sticky left-0 z-10 shrink-0 border-r border-border bg-muted px-2 py-1" style={{ width: LABEL_WIDTH }}>工作</div>
            <div className="flex">
              {dayCells.map((date, index) => (
                <div
                  key={date}
                  className={cn('shrink-0 border-r border-border/50 py-1 text-center', isWeekend(index) && 'bg-muted/70', date === today && 'bg-primary/15 font-semibold text-primary')}
                  style={{ width: dayWidth }}
                  title={date}
                >
                  {dayHeader(date, index)}
                </div>
              ))}
            </div>
          </div>
          <div className="relative">
            <div className="pointer-events-none absolute inset-y-0 flex" style={{ left: LABEL_WIDTH, width: gridWidth }}>
              {dayCells.map((date, index) => (
                <div key={date} className={cn('shrink-0 border-r border-border/30', isWeekend(index) && 'bg-muted/40', date === today && 'bg-primary/10')} style={{ width: dayWidth }} />
              ))}
              {layout.todayOffset >= 0 && layout.todayOffset < layout.days && (
                <div className="absolute inset-y-0 w-px bg-red-500" style={{ left: layout.todayOffset * dayWidth + dayWidth / 2 }} />
              )}
            </div>
            {layout.bars.map(({ item, offset, length }) => {
              const todo = linkedTodo(todos, item);
              const dragging = drag?.id === item.id ? drag : null;
              const shownOffset = dragging?.mode === 'move' ? offset + dragging.delta : offset;
              const shownLength = dragging?.mode === 'resize' ? length + dragging.delta : length;
              const overdue = item.column !== 'done' && (item.end || item.start) < today;
              return (
                <div key={item.id} className="relative flex h-8 items-center border-b border-border/50" onDragOver={(event) => event.preventDefault()} onDrop={dropInRow}>
                  <button
                    type="button"
                    onClick={() => onEdit(item)}
                    className="sticky left-0 z-10 shrink-0 truncate border-r border-border bg-background px-2 text-left text-xs text-foreground hover:text-primary"
                    style={{ width: LABEL_WIDTH }}
                    title={item.title}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className={cn('h-2 w-2 shrink-0 rounded-full', COLUMN_STYLE[item.column])} />
                      {item.todoId && todo && <TaskMarker quadrant={effectiveQuadrant(todos, item.todoId)} main={!todo.parentId} />}
                      <span className="truncate">{todo?.text ?? item.title}</span>
                      {todo?.today && !todo.done && <Sun className="h-3 w-3 shrink-0 text-amber-500" aria-label="今日" />}
                    </span>
                  </button>
                  <div className="relative h-full" style={{ width: gridWidth }}>
                    <div
                      data-testid={`bar-${item.id}`}
                      className={cn('absolute top-1.5 h-5 cursor-grab touch-none select-none rounded', COLUMN_STYLE[item.column], overdue && 'outline outline-2 outline-red-500', dragging && 'opacity-80')}
                      style={{ left: shownOffset * dayWidth + 1, width: shownLength * dayWidth - 2 }}
                      title={`${item.title}（${columnLabel(item.column)}）${item.start || item.end}${item.start && item.end ? ` ~ ${item.end}` : ''}`}
                      onPointerDown={(event) => barDown(event, item.id, 'move', offset, length)}
                      onPointerMove={barMove}
                      onPointerUp={() => barUp(item)}
                      onPointerCancel={() => setBarDrag(null)}
                    >
                      <div
                        data-testid={`resize-${item.id}`}
                        className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r bg-black/20"
                        onPointerDown={(event) => barDown(event, item.id, 'resize', offset, length)}
                        onPointerMove={barMove}
                        onPointerUp={() => barUp(item)}
                        onPointerCancel={() => setBarDrag(null)}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
            <div className="relative flex h-9 items-center">
              <div className="sticky left-0 z-10 shrink-0 border-r border-border bg-background px-2 text-[11px] text-muted-foreground" style={{ width: LABEL_WIDTH }}>拖到這裡排日期</div>
              <div className="flex h-full border-dashed" style={{ width: gridWidth }} data-testid="drop-lane">
                {dayCells.map((date) => (
                  <div
                    key={date}
                    data-testid={`drop-${date}`}
                    title={date}
                    className={cn('h-full shrink-0 border-y border-dashed border-border/60', overDate === date && 'bg-primary/25')}
                    style={{ width: dayWidth }}
                    onDragOver={(event) => { event.preventDefault(); setOverDate(date); }}
                    onDragLeave={() => setOverDate((current) => (current === date ? '' : current))}
                    onDrop={(event) => dropOn(event, date)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="mt-3">
        <h3 className="mb-1 text-xs font-semibold text-foreground">未排時程</h3>
        {layout.unscheduled.length === 0 ? (
          <p className="text-xs text-muted-foreground">每一項都排好了。</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {layout.unscheduled.map((item) => {
              const todo = linkedTodo(todos, item);
              return (
                <button
                  key={item.id}
                  type="button"
                  draggable
                  onDragStart={(event) => {
                    chipId.current = item.id;
                    event.dataTransfer.setData('text/plain', item.id);
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => { chipId.current = ''; setOverDate(''); }}
                  onClick={() => onEdit(item)}
                  className="flex cursor-grab items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted"
                >
                  {!(item.todoId && todo) && <span className={cn('h-2 w-2 rounded-full', COLUMN_STYLE[item.column])} />}
                  {item.todoId && todo && <TaskMarker quadrant={effectiveQuadrant(todos, item.todoId)} main={!todo.parentId} />}
                  {todo?.text ?? item.title}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** DHC CLI 10/14 專案板: one list of work items shown as kanban or gantt, per person; cards can be handed to the AI. */
export default function ProjectBoard({ profileId, profileName, projectId, isMobile, onClose, onStartWork }: ToolProps) {
  const [boards, setBoards] = useState<ProjectBoardData[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<'kanban' | 'gantt'>('kanban');
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<{ item: WorkItem; isNew: boolean } | null>(null);
  // What the list was before the AI's last change, for 復原.
  const [undo, setUndo] = useState<{ boardId: string; items: WorkItem[] } | null>(null);
  const [picking, setPicking] = useState(false);
  // One line in the header (a handoff arrived, a to-do was added...); a click clears it.
  const [note, setNote] = useState('');
  const todos = usePersonTodos(projectId ?? '').items;
  useEffect(() => (projectId ? startPersonTodosSync() : undefined), [projectId]);
  const saver = useMemo(() => createToolSaver(TOOL_ID, profileId, () => setFailed(true)), [profileId]);
  const boardsRef = useRef<ProjectBoardData[]>([]);
  boardsRef.current = boards ?? [];

  const commit = useCallback((next: ProjectBoardData[]) => {
    boardsRef.current = next;
    setBoards(next);
    saver.save({ boards: next });
  }, [saver]);

  useEffect(() => {
    let cancelled = false;
    loadToolData(TOOL_ID, profileId)
      .then((stored) => {
        if (cancelled) return;
        let list = parseBoards(stored);
        let changed = false;
        // Cards handed over by another tool (規劃白板...) become a new board.
        const handoff = takeHandoff(TOOL_ID);
        const made = handoff?.kind === 'cards' ? boardFromCardsPayload(handoff.payload) : null;
        if (made) {
          list = [{ ...emptyBoard(made.name), items: made.items }, ...list];
          setNote(`從${handoff?.from ?? '其他工具'}建立了 ${made.items.length} 張卡片`);
          changed = true;
        }
        if (list.length === 0) {
          list = [emptyBoard('我的第一個專案板')];
          changed = true;
        }
        if (changed) saver.save({ boards: list });
        boardsRef.current = list;
        setBoards(list);
        setActiveId(list[0].id);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [profileId, saver]);

  const active = boards?.find((board) => board.id === activeId) ?? null;

  // A linked card's end date is its to-do's due date: scheduling here (甘特圖, editor, AI) updates 待辦 too.
  const todosRef = useRef(todos);
  todosRef.current = todos;
  const pushDueDates = useCallback((before: WorkItem[], after: WorkItem[]) => {
    if (!projectId) return;
    const old = new Map(before.map((item) => [item.id, item.end]));
    for (const item of after) {
      const todo = linkedTodo(todosRef.current, item);
      if (!todo || todo.done || !old.has(item.id) || old.get(item.id) === item.end || (todo.due ?? '') === item.end) continue;
      editTodo(projectId, todo.id, item.end ? `${todo.text} @${item.end}` : todo.text);
    }
  }, [projectId]);

  /** Applies a change to one board using the latest list (the AI answers long after the click that asked). */
  const updateBoard = useCallback((boardId: string, change: (board: ProjectBoardData) => ProjectBoardData) => {
    const before = boardsRef.current.find((board) => board.id === boardId)?.items ?? [];
    const next = boardsRef.current.map((board) => (board.id === boardId ? { ...change(board), updatedAt: new Date().toISOString() } : board));
    commit(next);
    pushDueDates(before, next.find((board) => board.id === boardId)?.items ?? []);
  }, [commit, pushDueDates]);
  const setItems = (items: WorkItem[]) => { if (active) updateBoard(active.id, (board) => ({ ...board, items })); };

  const create = () => {
    const board = emptyBoard(`專案板 ${boardsRef.current.length + 1}`);
    commit([board, ...boardsRef.current]);
    setActiveId(board.id);
  };
  const rename = () => {
    if (!active) return;
    const name = window.prompt('專案板名稱', active.name)?.trim();
    if (name) updateBoard(active.id, (board) => ({ ...board, name }));
  };
  const remove = () => {
    if (!active) return;
    if (!window.confirm(`刪除專案板「${active.name}」？刪了就找不回來。`)) return;
    const rest = boardsRef.current.filter((board) => board.id !== active.id);
    const next = rest.length > 0 ? rest : [emptyBoard('我的第一個專案板')];
    commit(next);
    setActiveId(next[0].id);
  };

  const close = () => {
    void saver.flush();
    onClose();
  };

  // 交給 AI: confirm, mark the card, open a chat with this card as the work order. Finishing is the person's call.
  const handOff = async (item: WorkItem) => {
    if (!active || !onStartWork) return;
    if (!window.confirm(`把「${item.title}」交給 AI？會開一個新對話，把這張卡當成工作說明送出。`)) return;
    const handedAt = new Date().toISOString();
    const items = active.items.map((other) => (other.id === item.id ? { ...other, column: 'ai' as const, handedAt } : other));
    updateBoard(active.id, (board) => ({ ...board, items }));
    await saver.flush();
    onStartWork(cardBrief(liveBoard({ ...active, items }, todos), liveItem({ ...item, column: 'ai', handedAt }, todos)));
    onClose();
  };

  const move = (id: string, column: ColumnId) => {
    if (!active) return;
    const item = active.items.find((other) => other.id === id);
    if (!item || item.column === column) return;
    if (column === 'ai') {
      if (onStartWork) void handOff(item);
      else window.alert('這台裝置的專案設定沒有對應的專案，不能交給 AI。');
      return;
    }
    setItems(active.items.map((other) => (other.id === id ? { ...other, column } : other)));
    // A linked card moved into or out of 完成 ticks or unticks its to-do.
    const todo = projectId ? linkedTodo(todos, item) : undefined;
    if (projectId && todo && (column === 'done') !== todo.done) setTodoDone(projectId, todo.id, column === 'done');
  };

  // The other way: a to-do ticked or reopened in 待辦 moves its card.
  useEffect(() => {
    if (!active || syncWithTodos(active.items, todos) === active.items) return;
    updateBoard(active.id, (board) => ({ ...board, items: syncWithTodos(board.items, todos) }));
  }, [todos, active, updateBoard]);

  const saveItem = (item: WorkItem) => {
    if (!active) return;
    const exists = active.items.some((other) => other.id === item.id);
    // A card whose dates were swapped is put right rather than rejected.
    const fixed = item.start && item.end && item.end < item.start ? { ...item, start: item.end, end: item.start } : item;
    setItems(exists ? active.items.map((other) => (other.id === item.id ? fixed : other)) : [...active.items, fixed]);
    setEditing(null);
  };
  const deleteItem = () => {
    if (!active || !editing) return;
    if (!window.confirm(`刪除「${editing.item.title}」？`)) return;
    const id = editing.item.id;
    setItems(active.items.filter((other) => other.id !== id).map((other) => ({ ...other, dependsOn: other.dependsOn.filter((dep) => dep !== id) })));
    setEditing(null);
  };

  // 匯入: spreadsheets map columns by header name; a .txt is one item per line. Cards are appended to the current board.
  const importFiles = async (files: File[]): Promise<string> => {
    if (!active) return '還沒有專案板，沒有匯入';
    const added: WorkItem[] = [];
    let skipped = 0;
    const notes: string[] = [];
    for (const file of files) {
      try {
        let result;
        if (/.txt$/i.test(file.name)) {
          const content = await readTextFile(file);
          if (content.includes('	')) {
            const sheets = await readSpreadsheetFile(file);
            result = itemsFromRows(sheets[0]?.rows ?? []);
          } else result = itemsFromText(content);
        } else {
          const sheets = await readSpreadsheetFile(file);
          result = itemsFromRows(sheets[0]?.rows ?? []);
        }
        added.push(...result.items);
        skipped += result.skipped;
      } catch {
        notes.push(`${file.name} 讀不了`);
      }
    }
    const room = Math.max(0, MAX_BOARD_ITEMS - active.items.length);
    const kept = added.slice(0, room);
    if (kept.length > 0) updateBoard(active.id, (board) => ({ ...board, items: [...board.items, ...kept] }));
    const parts = [kept.length > 0 ? `匯入了 ${kept.length} 張卡片（依狀態欄放進各欄，沒有就放待辦）` : '沒有匯入任何卡片'];
    if (skipped > 0) parts.push(`略過 ${skipped} 列空白或沒有標題`);
    if (added.length > kept.length) parts.push(`超過 ${MAX_BOARD_ITEMS} 張上限，${added.length - kept.length} 張沒放進去`);
    return [...parts, ...notes].join('；');
  };

  // 從待辦匯入: the picked to-dos become cards in 待辦 (to-dos already on this board are skipped).
  const importTodos = (ids: Set<string>) => {
    setPicking(false);
    if (!active) return;
    const onBoard = new Set(active.items.flatMap((item) => (item.todoId ? [item.todoId] : [])));
    const fresh = itemsFromTodos(todos, ids, onBoard);
    const kept = fresh.slice(0, Math.max(0, MAX_BOARD_ITEMS - active.items.length));
    if (kept.length > 0) updateBoard(active.id, (board) => ({ ...board, items: [...board.items, ...kept] }));
    setNote(kept.length > 0 ? `從待辦匯入了 ${kept.length} 張卡片` : '沒有匯入任何卡片');
  };

  // 加到今日待辦: a card that is not linked yet becomes a to-do on 今日待辦 and is linked to it from then on.
  const toToday = (item: WorkItem) => {
    if (!projectId) return;
    const linked = item.todoId ? readPersonTodos(projectId).items.find((todo) => todo.id === item.todoId) : undefined;
    if (linked && !linked.done) { setNote(`「${item.title}」已經在待辦裡`); return; }
    const before = new Set(readPersonTodos(projectId).items.map((todo) => todo.id));
    const added = addTodo(projectId, `${item.title}${item.end ? ` @${item.end}` : ''}`, { today: true });
    // Remember the new to-do on the card, so pressing it again says it is already there.
    const created = readPersonTodos(projectId).items.find((todo) => !before.has(todo.id));
    if (added && created && active) {
      updateBoard(active.id, (board) => ({ ...board, items: board.items.map((card) => (card.id === item.id ? { ...card, todoId: created.id } : card)) }));
    }
    setNote(added ? `「${item.title}」已加到今日待辦` : '沒有加到待辦');
  };

  const startWork = async () => {
    if (!active || !onStartWork) return;
    await saver.flush();
    onStartWork(boardBrief(liveBoard(active, todos)));
    onClose();
  };

  const onChatChange = (chat: AssistMessage[]) => {
    if (active) updateBoard(active.id, (board) => ({ ...board, chat }));
  };

  const iconButton = 'rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground';
  const viewButton = (id: 'kanban' | 'gantt', label: string, Icon: typeof Kanban) => (
    <button
      type="button"
      onClick={() => setView(id)}
      aria-pressed={view === id}
      className={cn('flex items-center gap-1 rounded px-2 py-1 text-xs', view === id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );

  return (
    <ToolFrame
      icon={Kanban}
      title="專案板"
      profileName={profileName}
      failed={failed}
      isMobile={isMobile}
      onClose={close}
      importer={active ? { accept: '.csv,.tsv,.txt,.xlsx', hint: '匯入 CSV／Excel 表格或一行一項的文字清單，加到目前的專案板', onFiles: importFiles } : undefined}
      headerExtra={boards && (
        <>
          <select
            aria-label="選擇專案板"
            value={activeId ?? ''}
            onChange={(event) => setActiveId(event.target.value)}
            className="min-w-0 max-w-48 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
          >
            {boards.map((board) => <option key={board.id} value={board.id}>{board.name}</option>)}
          </select>
          <button type="button" onClick={create} className={iconButton} title="新專案板" aria-label="新專案板"><Plus className="h-4 w-4" /></button>
          <button type="button" onClick={rename} disabled={!active} className="shrink-0 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">改名</button>
          <button type="button" onClick={remove} disabled={!active} className={cn(iconButton, 'hover:text-destructive')} title="刪除這個專案板" aria-label="刪除這個專案板"><Trash2 className="h-4 w-4" /></button>
          <button
            type="button"
            onClick={() => setPicking(true)}
            disabled={!projectId || !active}
            title={projectId ? '把待辦變成這個板子的卡片' : '這台裝置的專案設定沒有對應的專案，沒有待辦可匯入'}
            className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-40"
          >
            <ListChecks className="h-3.5 w-3.5" />
            從待辦匯入
          </button>
          {note && (
            <button type="button" onClick={() => setNote('')} title="按一下關掉" className="min-w-0 max-w-[20rem] truncate text-xs text-muted-foreground hover:text-foreground">
              {note}
            </button>
          )}
          <span className="mx-1 h-4 w-px shrink-0 bg-border" />
          <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5">
            {viewButton('kanban', '看板', Kanban)}
            {viewButton('gantt', '甘特圖', GanttChart)}
          </div>
          {undo && undo.boardId === activeId && (
            <button
              type="button"
              onClick={() => { updateBoard(undo.boardId, (board) => ({ ...board, items: undo.items })); setUndo(null); }}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-muted"
            >
              <Undo2 className="h-3.5 w-3.5" />
              復原 AI 的更動
            </button>
          )}
        </>
      )}
      assist={active ? {
        tool: TOOL_ID,
        getContext: () => aiContext(liveBoard(boardsRef.current.find((board) => board.id === active.id) ?? active, todos), todayText()),
        onResult: (result) => {
          const current = boardsRef.current.find((board) => board.id === active.id);
          const items = current ? applyAiItems(current.items, result) : null;
          if (!current || !items) return 'AI 給的工作清單是空的，沒有套用';
          setUndo({ boardId: current.id, items: current.items });
          updateBoard(current.id, (board) => ({ ...board, items }));
          return '工作清單已更新，不滿意可按上方「復原 AI 的更動」';
        },
        chat: active.chat,
        onChatChange,
        intro: '說你想做什麼，例如「幫我把月底風險報表拆成 6 個步驟，排在這兩週」。AI 會拆工作、排時程、整理順序，更動可以復原。',
        placeholder: '要拆什麼、排什麼？（Enter 送出）',
      } : undefined}
      startWork={{
        hint: '整張板當成工作說明，開一個新對話送出（優先處理「交給 AI」欄）。',
        disabled: !active || active.items.length === 0,
        onStart: onStartWork ? () => void startWork() : null,
      }}
    >
      {!boards ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{failed ? '讀不到專案板，稍後再開一次。' : '載入中…'}</p>
      ) : active ? (
        view === 'kanban' ? (
          <KanbanView
            items={active.items}
            canHandOff={Boolean(onStartWork)}
            canToToday={Boolean(projectId)}
            onToToday={toToday}
            todos={todos}
            onTodayLinked={(todo) => { if (projectId) { setTodoToday(projectId, todo.id, true); setNote(`「${todo.text}」已排進今日待辦`); } }}
            onEdit={(item) => setEditing({ item, isNew: false })}
            onMove={move}
            onHandOff={(item) => void handOff(item)}
            onAdd={(column) => setEditing({ item: emptyItem('', column), isNew: true })}
          />
        ) : (
          <GanttView
            items={active.items}
            todos={todos}
            onEdit={(item) => setEditing({ item, isNew: false })}
            onSchedule={(id, start, end) => setItems(active.items.map((item) => (item.id === id ? { ...item, start, end } : item)))}
          />
        )
      ) : null}
      {picking && active && (
        <TodoPicker
          todos={todos}
          onBoard={new Set(active.items.flatMap((item) => (item.todoId ? [item.todoId] : [])))}
          onImport={importTodos}
          onCancel={() => setPicking(false)}
        />
      )}
      {editing && active && (
        <ItemEditor
          key={editing.item.id}
          draft={editing.item}
          isNew={editing.isNew}
          others={active.items.filter((other) => other.id !== editing.item.id)}
          linked={linkedTodo(todos, editing.item)}
          todos={todos}
          onSave={saveItem}
          onDelete={deleteItem}
          onCancel={() => setEditing(null)}
        />
      )}
    </ToolFrame>
  );
}
