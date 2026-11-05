import { useEffect, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { CalendarDays, CalendarPlus, Check, ChevronLeft, ChevronRight, Sun, X } from 'lucide-react';

import TaskMarker from '@/modules/todo-dock/TaskMarker';
import TodoTrash from '@/modules/todo-dock/TodoTrash';
import { parentTrail, TODO_DRAG_TYPE } from '@/modules/todo-dock/quadrants';
import { useTodoPerson } from '@/modules/todo-dock/todoPerson';
import {
  addTodo,
  dateKey,
  daysBetween,
  effectiveQuadrant,
  setTodoDone,
  setTodoDue,
  setTodoToday,
  usePersonTodos,
} from '@/shared/personTodos';
import type { TodoItem } from '@/shared/personTodos';
import type { Project } from '@/shared/types';
import { cn } from '@/shared/utils';
import { useIsTeamMode } from '@/shared/dhcConfig';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const CHIPS_PER_DAY = 3;
const UNSCHEDULED = 'unscheduled';

const draggedId = (event: DragEvent) => event.dataTransfer.getData(TODO_DRAG_TYPE);
const carriesTodo = (event: DragEvent) => event.dataTransfer.types.includes(TODO_DRAG_TYPE);
const startDrag = (id: string) => (event: DragEvent) => {
  event.dataTransfer.setData(TODO_DRAG_TYPE, id);
  event.dataTransfer.effectAllowed = 'move';
};

const monthStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1);

/** The month's days in whole Monday-first weeks. */
function monthCells(month: Date): Date[] {
  const offset = (month.getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const count = Math.ceil((offset + days) / 7) * 7;
  return Array.from({ length: count }, (_, index) => new Date(month.getFullYear(), month.getMonth(), index - offset + 1));
}

const dayLabel = (key: string) => {
  const [year, month, day] = key.split('-').map(Number);
  const weekday = WEEKDAYS[(new Date(year, month - 1, day).getDay() + 6) % 7];
  return `${month}月${day}日（週${weekday}）`;
};

const fromToday = (key: string, today: string) => {
  const left = daysBetween(today, key);
  if (left === 0) return '今天';
  if (left === 1) return '明天';
  return left > 0 ? `${left} 天後` : `${-left} 天前`;
};

// Open first, then the order the matrix shows them in.
const byOpenThenQuadrant = (items: TodoItem[]) => (a: TodoItem, b: TodoItem) =>
  Number(a.done) - Number(b.done) || (effectiveQuadrant(items, a.id) ?? 'q9').localeCompare(effectiveQuadrant(items, b.id) ?? 'q9');

type TodoCalendarProps = {
  projects?: Project[];
  isMobile: boolean;
  onClose: () => void;
};

/**
 * DHC CLI 10/15 行事曆: the 待辦 lists laid out by due date; a 工具庫 tool since 10/16 (it had its own right-edge handle).
 * It reads and writes the same per-person list as 待辦, so a change in one shows in the other: dragging a task onto
 * a day sets its due date (and a task due today or earlier already shows on 今日待辦), dragging it to 未排期 clears
 * it, and a task typed into a day gets that day as its due date. ☀ puts a task on 今日待辦 from here too.
 * Double-clicking a day opens a box right in that cell (on a phone, where cells are tiny, it jumps to the day's box).
 */
export default function TodoCalendar({ projects = [], isMobile, onClose }: TodoCalendarProps) {
  const { people, personId: selectedPersonId, ownId, choosePerson } = useTodoPerson(projects);
  const isTeamMode = useIsTeamMode();
  const personId = isTeamMode ? selectedPersonId : ownId;
  const { items } = usePersonTodos(personId ?? '');
  const today = dateKey(new Date());
  const [month, setMonth] = useState(() => monthStart(new Date()));
  const [selected, setSelected] = useState(today);
  const [over, setOver] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [inlineDay, setInlineDay] = useState<string | null>(null);
  const [inlineDraft, setInlineDraft] = useState('');
  const dayInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Escape in a text box only leaves that box.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !(event.target instanceof HTMLElement && event.target.closest('input, select'))) onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const goToday = () => {
    setMonth(monthStart(new Date()));
    setSelected(today);
  };
  const shiftMonth = (step: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + step, 1));

  const dueOn = (key: string) => items.filter((item) => item.due === key).sort(byOpenThenQuadrant(items));
  const doneOn = (key: string) => items.filter((item) => item.done && item.doneAt && dateKey(new Date(item.doneAt)) === key);
  const unscheduled = items.filter((item) => !item.done && !item.due).sort(byOpenThenQuadrant(items));

  const dropZone = (target: string, onDrop: (id: string) => void) => ({
    onDragOver: (event: DragEvent) => {
      if (!carriesTodo(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (over !== target) setOver(target);
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver((current) => (current === target ? null : current));
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setOver(null);
      const id = draggedId(event);
      if (id && personId) onDrop(id);
    },
  });

  const openInline = (key: string) => {
    setSelected(key);
    if (isMobile) {
      dayInputRef.current?.focus();
      dayInputRef.current?.scrollIntoView({ block: 'center' });
      return;
    }
    setInlineDay(key);
    setInlineDraft('');
  };
  // Enter adds and keeps the box open for the next one; leaving the box adds what is typed, then closes it.
  const commitInline = (close: boolean) => {
    if (personId && inlineDay && addTodo(personId, inlineDraft, { due: inlineDay })) setInlineDraft('');
    if (close) setInlineDay(null);
  };

  const addToDay = () => {
    if (personId && addTodo(personId, draft, { due: selected })) setDraft('');
  };

  const taskTitle = (item: TodoItem) => {
    const trail = parentTrail(items, item);
    return trail ? `${item.text}（${trail}）` : item.text;
  };

  /** A task row in the side panel: done box, marker, text, then ☀ and the given trailing button. */
  const taskRow = (item: TodoItem, trailing: ReactNode) => (
    <li
      key={item.id}
      draggable={!item.done}
      onDragStart={startDrag(item.id)}
      onDragEnd={() => setOver(null)}
      className={cn('group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60', !item.done && 'cursor-grab')}
    >
      <button
        type="button"
        onClick={() => personId && setTodoDone(personId, item.id, !item.done)}
        aria-label={item.done ? `取消完成 ${item.text}` : `完成 ${item.text}`}
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
          item.done ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50 hover:border-primary',
        )}
      >
        {item.done && <Check className="h-3 w-3" />}
      </button>
      <TaskMarker quadrant={effectiveQuadrant(items, item.id)} main={!item.parentId} />
      <span title={taskTitle(item)} className={cn('min-w-0 flex-1 truncate', item.done && 'text-muted-foreground line-through')}>
        {item.text}
      </span>
      {!item.done && (
        <button
          type="button"
          onClick={() => personId && setTodoToday(personId, item.id, !item.today)}
          aria-pressed={item.today}
          aria-label={item.today ? `從今日待辦拿掉 ${item.text}` : `加到今日待辦 ${item.text}`}
          title={item.today ? '在今日待辦裡（再按拿掉）' : '加到今日待辦'}
          className={cn(
            'shrink-0 rounded p-0.5',
            item.today ? 'text-amber-500' : 'text-muted-foreground hover:text-amber-500',
            !item.today && !isMobile && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          )}
        >
          <Sun className="h-3.5 w-3.5" />
        </button>
      )}
      {trailing}
    </li>
  );

  const selectedDue = dueOn(selected);
  const selectedDone = doneOn(selected).filter((item) => item.due !== selected);
  const selectedInMonth = selected.startsWith(dateKey(month).slice(0, 7));
  const hoverOnly = !isMobile && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100';

  const grid = (
    <div className={cn('flex min-w-0 flex-col', isMobile ? 'p-2' : 'min-h-0 flex-1 p-3')}>
      <div className="grid flex-shrink-0 grid-cols-7 pb-1 text-center text-[11px] font-medium text-muted-foreground">
        {WEEKDAYS.map((name, index) => (
          <span key={name} className={cn(index >= 5 && 'text-muted-foreground/60')}>{name}</span>
        ))}
      </div>
      <div className={cn('grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border', !isMobile && 'min-h-0 flex-1 auto-rows-fr')}>
        {monthCells(month).map((date) => {
          const key = dateKey(date);
          const inMonth = date.getMonth() === month.getMonth();
          const weekend = date.getDay() === 0 || date.getDay() === 6;
          const due = dueOn(key);
          const doneCount = doneOn(key).length;
          const hidden = due.length - CHIPS_PER_DAY;
          return (
            <div
              key={key}
              role="gridcell"
              aria-label={`${dayLabel(key)}，${due.filter((item) => !item.done).length} 項到期`}
              aria-selected={key === selected}
              onClick={() => setSelected(key)}
              onDoubleClick={(event) => {
                if (!(event.target instanceof HTMLElement && event.target.closest('input'))) openInline(key);
              }}
              title="雙擊新增這天的待辦"
              {...dropZone(key, (id) => {
                setTodoDue(personId as string, id, key);
                setSelected(key);
              })}
              className={cn(
                'flex min-w-0 cursor-pointer flex-col gap-0.5 overflow-hidden p-1 text-left',
                isMobile ? 'min-h-[3.25rem]' : 'min-h-[5.5rem]',
                weekend ? 'bg-muted/20' : 'bg-background',
                !inMonth && 'opacity-45',
                key === selected && 'ring-2 ring-inset ring-primary/60',
                over === key && 'bg-primary/10 ring-2 ring-inset ring-primary',
              )}
            >
              <div className="flex items-center gap-1">
                <span
                  className={cn(
                    'flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs tabular-nums',
                    key === today ? 'bg-primary font-semibold text-primary-foreground' : 'text-foreground',
                  )}
                >
                  {date.getDate()}
                </span>
                {doneCount > 0 && (
                  <span title={`這天完成 ${doneCount} 項`} className="ml-auto flex items-center text-[10px] text-emerald-600 dark:text-emerald-400">
                    <Check className="h-3 w-3" />
                    {doneCount}
                  </span>
                )}
              </div>
              {isMobile ? (
                due.length > 0 && (
                  <div className="flex flex-wrap gap-0.5 px-0.5">
                    {due.slice(0, 4).map((item) => (
                      <TaskMarker
                        key={item.id}
                        quadrant={effectiveQuadrant(items, item.id)}
                        main={false}
                        className={cn(item.done && 'opacity-40')}
                      />
                    ))}
                  </div>
                )
              ) : (
                <>
                  {due.slice(0, CHIPS_PER_DAY).map((item) => (
                    <div
                      key={item.id}
                      draggable={!item.done}
                      onDragStart={startDrag(item.id)}
                      onDragEnd={() => setOver(null)}
                      title={taskTitle(item)}
                      className={cn(
                        'flex min-w-0 items-center gap-1 rounded bg-muted/70 px-1 py-px text-[11px] leading-4',
                        item.done ? 'text-muted-foreground line-through' : 'cursor-grab text-foreground hover:bg-muted',
                        !item.done && key < today && 'text-red-600 dark:text-red-400',
                      )}
                    >
                      <TaskMarker quadrant={effectiveQuadrant(items, item.id)} main={!item.parentId} className="scale-75" />
                      <span className="min-w-0 flex-1 truncate">{item.text}</span>
                      {item.today && !item.done && <Sun aria-label="在今日待辦" className="h-2.5 w-2.5 shrink-0 text-amber-500" />}
                    </div>
                  ))}
                  {hidden > 0 && <span className="px-1 text-[10px] text-muted-foreground">還有 {hidden} 項</span>}
                  {inlineDay === key && (
                    <input
                      autoFocus
                      value={inlineDraft}
                      onChange={(event) => setInlineDraft(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          commitInline(false);
                        } else if (event.key === 'Escape') {
                          setInlineDay(null);
                        }
                      }}
                      onBlur={() => commitInline(true)}
                      placeholder="新增"
                      aria-label="在這天新增待辦"
                      data-tutorial-tip="輸入待辦按 Enter，期限就是這一天；點別處也會存"
                      className="w-full min-w-0 rounded border border-primary bg-background px-1 py-px text-[11px] leading-4 outline-none"
                    />
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  const dayPanel = (
    <section aria-label="這天的待辦" className={cn('flex flex-col', !isMobile && 'max-h-[55%] min-h-0 border-b border-border')}>
      <h3 className="flex h-10 flex-shrink-0 items-center gap-2 border-b border-border px-3 text-xs font-semibold">
        {dayLabel(selected)}
        <span className={cn('font-normal', selected < today ? 'text-muted-foreground' : 'text-primary')}>{fromToday(selected, today)}</span>
        {!selectedInMonth && (
          <button
            type="button"
            onClick={() => setMonth(monthStart(new Date(`${selected}T00:00:00`)))}
            className="ml-auto text-[11px] font-normal text-primary hover:underline"
          >
            看那個月
          </button>
        )}
      </h3>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {selectedDue.length === 0 && selectedDone.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">這天沒有到期的待辦。</p>
        ) : (
          <ul className="space-y-0.5">
            {selectedDue.map((item) => taskRow(item, !item.done && (
              <button
                type="button"
                onClick={() => setTodoDue(personId as string, item.id, undefined)}
                aria-label={`取消期限 ${item.text}`}
                title="取消期限（移回未排期）"
                className={cn('shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground', hoverOnly)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )))}
          </ul>
        )}
        {selectedDone.length > 0 && (
          <>
            <p className="mt-2 px-2 text-[11px] text-muted-foreground">這天完成</p>
            <ul className="space-y-0.5">{selectedDone.map((item) => taskRow(item, null))}</ul>
          </>
        )}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          addToDay();
        }}
        className="flex flex-shrink-0 gap-1.5 border-t border-border p-2"
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="新增待辦"
          data-tutorial-tip={`輸入待辦按 Enter，期限是 ${Number(selected.slice(5, 7))}/${Number(selected.slice(8))}`}
          ref={dayInputRef}
          aria-label="新增到這天"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
        >
          新增
        </button>
      </form>
    </section>
  );

  const unscheduledPanel = (
    <section
      aria-label="未排期"
      {...dropZone(UNSCHEDULED, (id) => setTodoDue(personId as string, id, undefined))}
      className={cn('flex min-h-0 flex-col', !isMobile && 'flex-1', over === UNSCHEDULED && 'bg-primary/5 ring-2 ring-inset ring-primary')}
    >
      <h3 className="flex h-10 flex-shrink-0 items-center gap-2 border-b border-border px-3 text-xs font-semibold">
        未排期 {unscheduled.length}
        <span className="truncate font-normal text-muted-foreground">{isMobile ? '按 ＋ 排到選的那天' : '拖到日期上＝設期限'}</span>
      </h3>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {unscheduled.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">所有待辦都有期限了。</p>
        ) : (
          <ul className="space-y-0.5">
            {unscheduled.map((item) => taskRow(item, (
              <button
                type="button"
                onClick={() => setTodoDue(personId as string, item.id, selected)}
                aria-label={`排到 ${dayLabel(selected)}：${item.text}`}
                title={`排到 ${dayLabel(selected)}`}
                className={cn('shrink-0 rounded p-0.5 text-muted-foreground hover:text-primary', hoverOnly)}
              >
                <CalendarPlus className="h-3.5 w-3.5" />
              </button>
            )))}
          </ul>
        )}
      </div>
    </section>
  );

  return (
    <div className="fixed inset-0 z-[60]">
      <button type="button" aria-label="關閉行事曆" onClick={onClose} className="absolute inset-0 bg-background/70 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-label="行事曆"
        className={cn(
          'absolute flex flex-col overflow-hidden border border-border bg-background shadow-2xl',
          isMobile ? 'inset-0' : 'inset-6 rounded-xl',
        )}
      >
        {!isMobile && personId && <TodoTrash personId={personId} />}
        <div className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3">
          <CalendarDays className="h-4 w-4 shrink-0 text-primary" />
          {!isMobile && <span className="shrink-0 text-sm font-semibold">行事曆</span>}
          {isTeamMode && personId && (
            <select
              aria-label="誰的行事曆"
              value={personId}
              onChange={(event) => choosePerson(event.target.value)}
              className="min-w-0 max-w-[7rem] bg-transparent text-xs text-foreground outline-none"
            >
              {people.map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {project.displayName}
                </option>
              ))}
            </select>
          )}
          <div className="ml-1 flex shrink-0 items-center gap-0.5">
            <button type="button" onClick={() => shiftMonth(-1)} aria-label="上個月" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-[5.5rem] text-center text-sm font-medium tabular-nums">
              {month.getFullYear()} 年 {month.getMonth() + 1} 月
            </span>
            <button type="button" onClick={() => shiftMonth(1)} aria-label="下個月" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
              <ChevronRight className="h-4 w-4" />
            </button>
            <button type="button" onClick={goToday} className="ml-1 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted">
              今天
            </button>
          </div>
          {!isMobile && (
            <span className="ml-3 truncate text-[11px] text-muted-foreground">
              資料就是待辦：雙擊日期＝新增，拖到日期＝設期限，拖回未排期＝取消，拖到垃圾桶＝刪除；到期那天自動出現在今日待辦；☀＝加到今日待辦
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="收起行事曆"
            className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {personId ? (
          <div className={cn('flex min-h-0 flex-1', isMobile ? 'flex-col overflow-y-auto' : 'flex-row')}>
            {grid}
            <aside className={cn('flex flex-col', isMobile ? 'border-t border-border' : 'w-80 flex-shrink-0 border-l border-border')}>
              {dayPanel}
              {unscheduledPanel}
            </aside>
          </div>
        ) : (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">還沒有任何人的工作區。</p>
        )}
      </div>
    </div>
  );
}
