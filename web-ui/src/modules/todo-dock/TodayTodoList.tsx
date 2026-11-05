import { useState } from 'react';
import type { DragEvent } from 'react';
import { CalendarClock, Check, Plus, X } from 'lucide-react';

import TaskMarker from '@/modules/todo-dock/TaskMarker';
import TimeTag from '@/modules/todo-dock/TimeTag';
import { isToday, parentTrail, QUADRANTS, TODO_DRAG_TYPE } from '@/modules/todo-dock/quadrants';
import {
  addTodo,
  clearToday,
  dateKey,
  splitDue,
  editTodo,
  isDueNow,
  todoEditText,
  effectiveQuadrant,
  MAX_TODO_DEPTH,
  reorderToday,
  setTodoDone,
  setTodoDue,
  setTodoToday,
  todoChildren,
  todoDepth,
  todoDescendants,
  usePersonTodos,
} from '@/shared/personTodos';
import type { TodoItem } from '@/shared/personTodos';
import { TODO_CHAT_DRAG_TYPE } from '@/shared/todoChatDrag';
import type { TodoChatPayload } from '@/shared/todoChatDrag';
import { cn } from '@/shared/utils';

type TodayTodoListProps = {
  personId: string;
  /** The dock's 重要／緊急 toggles (in its 全部待辦 row); the matrix's 今日待辦 column shows everything. */
  filter?: TodayFilter;
  /** Turns both toggles off; offered when a task just added is hidden by them. */
  onClearFilter?: () => void;
};

const QUADRANT_ORDER = [...QUADRANTS.map((meta) => meta.id), undefined];
const DRAG_TYPE = 'application/x-dhc-today';
/** 11/01: on a touch screen the small row controls get a ~40px hit area (an invisible ::before) without growing the row. */
const TOUCH_HIT = 'relative [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-x-[7px] [@media(pointer:coarse)]:before:-inset-y-[10px] [@media(pointer:coarse)]:before:content-[""]';
/** Per person: the day the leftover prompt was last answered on this device. */
const CARRY_ASKED_KEY = 'dhc.todoCarryAsked:';

type DropMark = { id: string; after: boolean };

/** This device's 今日待辦 filter: show only important (q1, q2) and/or only urgent (q1, q3) tasks. */
export const FILTER_KEY = 'dhc.todayFilter';
export type TodayFilter = { important: boolean; urgent: boolean };
export const FILTERS: ReadonlyArray<{ key: keyof TodayFilter; label: string; quadrants: readonly string[] }> = [
  { key: 'important', label: '重要', quadrants: ['q1', 'q2'] },
  { key: 'urgent', label: '緊急', quadrants: ['q1', 'q3'] },
];
export const readFilter = (): TodayFilter => {
  try {
    const stored = JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}');
    return { important: stored.important === true, urgent: stored.urgent === true };
  } catch {
    return { important: false, urgent: false };
  }
};

const tomorrowKey = () => {
  const now = new Date();
  return dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
};

const openSubtaskLines = (items: TodoItem[], id: string, depth = 0): string[] =>
  todoChildren(items, id)
    .filter((child) => !child.done)
    .flatMap((child) => [`${'  '.repeat(depth)}${child.text}`, ...openSubtaskLines(items, child.id, depth + 1)]);

/** Any row can be dragged into the chat (see shared/todoChatDrag) or onto a matrix quadrant to set its colour. */
const setChatDrag = (dataTransfer: DataTransfer, items: TodoItem[], item: TodoItem) => {
  const payload: TodoChatPayload = { text: item.text, trail: parentTrail(items, item), subtasks: openSubtaskLines(items, item.id) };
  dataTransfer.setData(TODO_CHAT_DRAG_TYPE, JSON.stringify(payload));
  dataTransfer.setData(TODO_DRAG_TYPE, item.id);
};

/**
 * 今日待辦 in the dock: the tasks pulled in from the matrix (any level) plus quick ones typed here, which land in
 * the matrix as 未分類. A task's subtasks are listed under it so they can be ticked off here too; a subtask that
 * was pulled in on its own while its parent is also on today shows only under the parent. Ticking one off ticks
 * the same task in the matrix; × only takes it off today.
 * 10/07: rows drag up and down to set the order; ＋ with an empty box opens an input at the bottom of the list.
 * 10/08: any row, subtasks included, can also be dragged into the chat (subtasks don't reorder).
 * 10/08: the checkbox moved after the text; the front slot is the task's marker (status light) and the tree lines end on it.
 * 10/13: a task due today or overdue shows here on top even if it was never put on today; a one-line prompt asks
 * once a day what to do with tasks left over from an earlier day.
 * 10/31: ＋ after a row's text (on hover) opens a subtask input under it, like the matrix card's ＋.
 * 10/31: the dock's 重要／緊急 toggles filter the top-level rows by quadrant (both on = 重要且緊急); a task due today or
 * overdue always shows. Reordering still works on the full list.
 */
export default function TodayTodoList({ personId, filter = { important: false, urgent: false }, onClearFilter }: TodayTodoListProps) {
  const { items } = usePersonTodos(personId);
  const [draft, setDraft] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [adding, setAdding] = useState(false);
  const [bottomDraft, setBottomDraft] = useState('');
  const [hiddenNote, setHiddenNote] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropMark, setDropMark] = useState<DropMark | null>(null);
  const [, rerender] = useState(0);
  const carryAsked = localStorage.getItem(CARRY_ASKED_KEY + personId);
  const todayKey = dateKey(new Date());
  const rank = (item: TodoItem) => QUADRANT_ORDER.indexOf(effectiveQuadrant(items, item.id));
  const onToday = (item: TodoItem) => (item.today && !item.done) || isDueNow(item, todayKey);
  const shownUnderToday = new Set(
    items.filter(onToday).flatMap((item) => todoDescendants(items, item.id).map((child) => child.id)),
  );
  // A due (today or overdue) task never dragged here comes first, earliest due on top; once dragged, the dragged
  // order wins (10/31: otherwise nothing could be dragged above a due task). Then quadrant order.
  const pinnedDue = (item: TodoItem) => isDueNow(item, todayKey) && item.todayRank === undefined;
  const open = items
    .filter((item) => onToday(item) && !shownUnderToday.has(item.id))
    .sort((a, b) => {
      const dueA = pinnedDue(a);
      const dueB = pinnedDue(b);
      return Number(dueB) - Number(dueA)
        || (dueA && dueB ? (a.due as string).localeCompare(b.due as string) : 0)
        || (a.todayRank ?? Infinity) - (b.todayRank ?? Infinity)
        || rank(a) - rank(b);
    });
  const passesFilter = (item: TodoItem) => {
    // 到期一律顯示，包括掛在不符篩選的任務底下的子任務
    if (isDueNow(item, todayKey) || todoDescendants(items, item.id).some((child) => !child.done && isDueNow(child, todayKey))) return true;
    const quadrant = effectiveQuadrant(items, item.id) ?? '';
    return FILTERS.every(({ key, quadrants }) => !filter[key] || quadrants.includes(quadrant));
  };
  const shown = open.filter(passesFilter);
  // Put on 今日待辦 before today and still open; tasks from before 10/13 have no todayAt and go by when they were made.
  const leftover = open.filter((item) => item.today && dateKey(new Date(item.todayAt ?? item.createdAt)) < todayKey);
  const askCarry = leftover.length > 0 && carryAsked !== todayKey;
  const answerCarry = (clear: boolean) => {
    if (clear) clearToday(personId, leftover.map((item) => item.id));
    localStorage.setItem(CARRY_ASKED_KEY + personId, todayKey);
    rerender((count) => count + 1);
  };
  const doneToday = items
    .filter((item) => item.today && item.done && isToday(item.doneAt))
    .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));

  // A new task is 未分類, so any active 重要／緊急 toggle hides it unless it is already due: say so instead of letting it vanish.
  const addToday = (text: string) => {
    if (!addTodo(personId, text, { today: true })) return false;
    const due = splitDue(text).due;
    setHiddenNote((filter.important || filter.urgent) && !(due && due <= todayKey));
    return true;
  };
  const submitDraft = () => {
    if (!draft.trim()) setAdding(true);
    else if (addToday(draft)) setDraft('');
  };

  const dropOn = (target: DropMark) => {
    const moving = draggingId;
    setDraggingId(null);
    setDropMark(null);
    if (!moving || moving === target.id) return;
    const ids = open.map((item) => item.id).filter((id) => id !== moving);
    ids.splice(ids.indexOf(target.id) + (target.after ? 1 : 0), 0, moving);
    reorderToday(personId, ids);
  };

  return (
    <div className="space-y-2 px-2">
      <form
        className="flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          submitDraft();
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="新增"
          aria-label="新增今日待辦"
          data-tutorial-tip="輸入待辦按 Enter；結尾加 @10/20 設期限"
          className="h-9 min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2 text-sm outline-none focus:border-primary/50"
        />
        <button
          type="submit"
          aria-label={draft.trim() ? '加入今日待辦' : '在清單最下方新增'}
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Plus className="h-4 w-4" />
        </button>
      </form>

      {hiddenNote && (filter.important || filter.urgent) && (
        <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-muted/60 px-2 py-1.5 text-xs">
          <span className="text-muted-foreground">已新增，目前篩選中看不到</span>
          <button
            type="button"
            onClick={() => {
              onClearFilter?.();
              setHiddenNote(false);
            }}
            className="ml-auto rounded px-1.5 py-0.5 font-medium text-primary hover:bg-background"
          >
            取消篩選
          </button>
        </div>
      )}

      {askCarry && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-muted/60 px-2 py-1.5 text-xs">
          <span className="text-muted-foreground">之前留下 {leftover.length} 項還沒做完</span>
          <span className="ml-auto flex gap-1">
            <button type="button" onClick={() => answerCarry(false)} className="rounded px-1.5 py-0.5 hover:bg-background">
              留著
            </button>
            <button type="button" onClick={() => answerCarry(true)} className="rounded px-1.5 py-0.5 hover:bg-background">
              全部移出今日
            </button>
          </span>
        </div>
      )}

      {shown.length === 0 && !adding ? (
        <p className="px-2 py-3 text-center text-sm text-muted-foreground">
          {open.length > 0 ? '篩選後沒有待辦。' : <>今天沒有待辦。<span data-tutorial>到矩陣按 ☀ 匯入。</span></>}
        </p>
      ) : (
        <ul className="space-y-1">
          {shown.map((item) => (
            <li
              key={item.id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(DRAG_TYPE, item.id);
                setChatDrag(event.dataTransfer, items, item);
                event.dataTransfer.effectAllowed = 'copyMove';
                setDraggingId(item.id);
              }}
              onDragEnd={() => {
                setDraggingId(null);
                setDropMark(null);
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                const after = event.clientY > box.top + box.height / 2;
                if (dropMark?.id !== item.id || dropMark.after !== after) setDropMark({ id: item.id, after });
              }}
              onDrop={(event) => {
                event.preventDefault();
                // A reorder inside the matrix's 今日待辦 column shouldn't also hit that column's drop zone.
                event.stopPropagation();
                const box = event.currentTarget.getBoundingClientRect();
                dropOn({ id: item.id, after: event.clientY > box.top + box.height / 2 });
              }}
              className={cn('relative', draggingId === item.id && 'opacity-40')}
            >
              {dropMark?.id === item.id && draggingId !== item.id && (
                <span className={cn('pointer-events-none absolute inset-x-1 h-0.5 rounded bg-primary', dropMark.after ? '-bottom-[3px]' : '-top-[3px]')} />
              )}
              <TodayRow item={item} items={items} personId={personId} level={0} />
            </li>
          ))}
          {adding && (
            <li className="px-1.5 py-1">
              <input
                autoFocus
                value={bottomDraft}
                onChange={(event) => setBottomDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing && addToday(bottomDraft)) setBottomDraft('');
                  if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
                    setBottomDraft('');
                    setAdding(false);
                  }
                }}
                onBlur={() => {
                  if (!bottomDraft.trim()) setAdding(false);
                }}
                placeholder="新增"
                aria-label="新增任務到最下方"
                data-tutorial-tip="輸入待辦按 Enter；Esc 收起"
                className="h-8 w-full rounded-md border border-primary/40 bg-background px-2 text-sm outline-none"
              />
            </li>
          )}
        </ul>
      )}

      {doneToday.length > 0 && (
        <div className="border-t border-border/50 pt-1.5">
          <button
            type="button"
            onClick={() => setShowDone((value) => !value)}
            aria-expanded={showDone}
            className="px-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {showDone ? '▾' : '▸'} 今日完成 {doneToday.length}
          </button>
          {showDone && (
            <ul className="mt-1 space-y-0.5">
              {doneToday.map((item) => (
                <li key={item.id} className="flex items-start gap-2 rounded-md px-1.5 py-1">
                  <span className="w-3 shrink-0" />
                  <span className="min-w-0 flex-1 break-words text-sm leading-6 text-muted-foreground line-through">
                    {item.text}
                  </span>
                  <CheckBox item={item} personId={personId} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function CheckBox({ item, personId, small }: { item: TodoItem; personId: string; small?: boolean }) {
  return (
    <button
      type="button"
      aria-label={item.done ? `改回未完成：${item.text}` : `完成：${item.text}`}
      onClick={() => setTodoDone(personId, item.id, !item.done)}
      className={cn(
        'flex shrink-0 items-center justify-center rounded border',
        TOUCH_HIT,
        small ? 'mt-[4px] h-4 w-4' : 'mt-[3px] h-[18px] w-[18px]',
        item.done ? 'border-primary/50 bg-primary/10 text-primary' : 'border-muted-foreground/40 hover:border-primary',
      )}
    >
      {item.done && <Check className="h-3 w-3" />}
    </button>
  );
}

function TodayRow({
  item,
  items,
  personId,
  level,
  last = false,
}: {
  item: TodoItem;
  items: TodoItem[];
  personId: string;
  level: number;
  last?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [addingSub, setAddingSub] = useState(false);
  const [subDraft, setSubDraft] = useState('');
  const children = todoChildren(items, item.id);
  const dueNow = isDueNow(item);
  const canSplit = !item.done && todoDepth(items, item.id) < MAX_TODO_DEPTH;
  const closeSub = () => {
    setSubDraft('');
    setAddingSub(false);
  };
  const trail = level === 0 ? parentTrail(items, item) : '';
  const finishEdit = () => {
    editTodo(personId, item.id, editText);
    setEditing(false);
  };

  const Wrapper = level === 0 ? 'div' : 'li';

  return (
    <Wrapper
      {...(level > 0 && {
        draggable: true,
        onDragStart: (event: DragEvent) => {
          // Stop here so the top-level row doesn't start a reorder: a subtask goes to the chat or a quadrant.
          event.stopPropagation();
          setChatDrag(event.dataTransfer, items, item);
          event.dataTransfer.effectAllowed = 'copyMove';
        },
      })}
      className={cn(
        // Tree line: trunk from the parent's marker, elbow into this row's marker; it stops there on the last branch.
        level > 0 &&
          'relative pl-3 before:absolute before:left-0 before:top-0 before:w-px before:bg-muted-foreground/40 after:absolute after:left-0 after:top-[16px] after:h-px after:w-[19px] after:bg-muted-foreground/40',
        level > 0 && (last ? 'before:h-[16px]' : 'before:bottom-0'),
      )}
    >
      <div className={cn('group relative flex cursor-grab items-start gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50 active:cursor-grabbing')}>
        <span className="flex h-6 w-3 shrink-0 items-center justify-center">
          <TaskMarker quadrant={effectiveQuadrant(items, item.id)} main={!item.parentId} />
        </span>
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              value={editText}
              onChange={(event) => setEditText(event.target.value)}
              onBlur={finishEdit}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) finishEdit();
                if (event.key === 'Escape' && !event.nativeEvent.isComposing) setEditing(false);
              }}
              aria-label="修改待辦"
              className="w-full rounded border border-primary/40 bg-background px-1 text-sm outline-none"
            />
          ) : (
            <span
              className={cn(
                'block cursor-text break-words leading-6',
                level === 0 ? 'text-sm font-medium text-foreground' : 'text-[13px] text-foreground/90',
                item.done && 'text-muted-foreground line-through',
              )}
              title="點兩下修改"
              onDoubleClick={() => {
                setEditing(true);
                setEditText(todoEditText(item));
              }}
            >
              {item.text}
              <TimeTag item={item} showAge={level === 0} className="ml-1.5 font-normal" />
            </span>
          )}
          {trail && <span className="block truncate text-[11px] text-muted-foreground">↳ {trail}</span>}
        </div>
        {/* 10/31: ＋ and × float over the row on hover and take no room, so the text gets the width up to the checkbox. */}
        {!editing && (canSplit || item.today || dueNow) && (
          <span className="absolute right-8 top-1 hidden items-center gap-0.5 rounded-md bg-muted px-0.5 shadow-sm group-hover:flex max-md:static max-md:flex max-md:bg-transparent max-md:opacity-60 max-md:shadow-none [@media(pointer:coarse)]:gap-3">
            {canSplit && (
              <button
                type="button"
                aria-label={`拆子任務：${item.text}`}
                title="往下拆一個子任務"
                onClick={() => setAddingSub(true)}
                className={cn('flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground', TOUCH_HIT)}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            )}
            {dueNow ? (
              // 到期的項目移出今日也會因期限再列進來，所以這裡給「延後一天」。
              <button
                type="button"
                aria-label={`延後一天：${item.text}`}
                title="已到期，會一直列在今日；按這裡把期限延到明天"
                onClick={() => setTodoDue(personId, item.id, tomorrowKey())}
                className={cn('flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground', TOUCH_HIT)}
              >
                <CalendarClock className="h-3.5 w-3.5" />
              </button>
            ) : (
              item.today && (
                <button
                  type="button"
                  aria-label={`移出今日：${item.text}`}
                  title="移出今日（矩陣裡還在）"
                  onClick={() => setTodoToday(personId, item.id, false)}
                  className={cn('flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground', TOUCH_HIT)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )
            )}
          </span>
        )}
        <CheckBox item={item} personId={personId} small={level > 0} />
      </div>
      {(children.length > 0 || addingSub) && (
        <ul className="ml-3">
          {children.map((child, index) => (
            <TodayRow
              key={child.id}
              item={child}
              items={items}
              personId={personId}
              level={level + 1}
              last={!addingSub && index === children.length - 1}
            />
          ))}
          {addingSub && (
            <li className="relative py-1 pl-3 pr-1.5 before:absolute before:left-0 before:top-0 before:h-[20px] before:w-px before:bg-muted-foreground/40 after:absolute after:left-0 after:top-[20px] after:h-px after:w-3 after:bg-muted-foreground/40">
              <input
                autoFocus
                value={subDraft}
                onChange={(event) => setSubDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === 'Enter' && addTodo(personId, subDraft, { parentId: item.id })) setSubDraft('');
                  if (event.key === 'Escape') closeSub();
                }}
                onBlur={() => {
                  if (!subDraft.trim()) closeSub();
                }}
                placeholder="子任務"
                aria-label={`新增子任務到${item.text}`}
                data-tutorial-tip="Enter 存、Esc 收起"
                className="h-8 w-full rounded-md border border-primary/40 bg-background px-2 text-sm outline-none"
              />
            </li>
          )}
        </ul>
      )}
    </Wrapper>
  );
}
