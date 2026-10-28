import { useState } from 'react';
import type { DragEvent } from 'react';
import { Check, Plus, X } from 'lucide-react';

import TaskMarker from '@/modules/todo-dock/TaskMarker';
import TimeTag from '@/modules/todo-dock/TimeTag';
import { isToday, parentTrail, QUADRANTS, TODO_DRAG_TYPE } from '@/modules/todo-dock/quadrants';
import {
  addTodo,
  clearToday,
  dateKey,
  editTodo,
  isDueNow,
  todoEditText,
  effectiveQuadrant,
  reorderToday,
  setTodoDone,
  setTodoToday,
  todoChildren,
  todoDescendants,
  usePersonTodos,
} from '@/shared/personTodos';
import type { TodoItem } from '@/shared/personTodos';
import { TODO_CHAT_DRAG_TYPE } from '@/shared/todoChatDrag';
import type { TodoChatPayload } from '@/shared/todoChatDrag';
import { cn } from '@/shared/utils';

type TodayTodoListProps = {
  personId: string;
};

const QUADRANT_ORDER = [...QUADRANTS.map((meta) => meta.id), undefined];
const DRAG_TYPE = 'application/x-dhc-today';
/** Per person: the day the leftover prompt was last answered on this device. */
const CARRY_ASKED_KEY = 'dhc.todoCarryAsked:';

type DropMark = { id: string; after: boolean };

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
 */
export default function TodayTodoList({ personId }: TodayTodoListProps) {
  const { items } = usePersonTodos(personId);
  const [draft, setDraft] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [adding, setAdding] = useState(false);
  const [bottomDraft, setBottomDraft] = useState('');
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
  // Due today or overdue comes first, earliest due on top; the rest keep the dragged order, then quadrant order.
  const open = items
    .filter((item) => onToday(item) && !shownUnderToday.has(item.id))
    .sort((a, b) => {
      const dueA = isDueNow(a, todayKey);
      const dueB = isDueNow(b, todayKey);
      return Number(dueB) - Number(dueA)
        || (dueA && dueB ? (a.due as string).localeCompare(b.due as string) : 0)
        || (a.todayRank ?? Infinity) - (b.todayRank ?? Infinity)
        || rank(a) - rank(b);
    });
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

  const submitDraft = () => {
    if (!draft.trim()) setAdding(true);
    else if (addTodo(personId, draft, { today: true })) setDraft('');
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
          placeholder="新增，結尾 @10/20 設期限"
          aria-label="新增今日待辦"
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

      {open.length === 0 && !adding ? (
        <p className="px-2 py-3 text-center text-sm text-muted-foreground">今天沒有待辦。到矩陣按 ☀ 匯入。</p>
      ) : (
        <ul className="space-y-1">
          {open.map((item) => (
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
                  if (event.key === 'Enter' && addTodo(personId, bottomDraft, { today: true })) setBottomDraft('');
                  if (event.key === 'Escape') {
                    setBottomDraft('');
                    setAdding(false);
                  }
                }}
                onBlur={() => {
                  if (!bottomDraft.trim()) setAdding(false);
                }}
                placeholder="新任務，Enter 存，Esc 收起"
                aria-label="新增任務到最下方"
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
                  <span className="h-6 w-6 shrink-0" />
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
  const children = todoChildren(items, item.id);
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
      <div className={cn('group flex cursor-grab items-start gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50 active:cursor-grabbing')}>
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
                if (event.key === 'Enter') finishEdit();
                if (event.key === 'Escape') setEditing(false);
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
        <CheckBox item={item} personId={personId} small={level > 0} />
        {/* Same width either way, so every checkbox lines up in one column. */}
        {!item.today && <span className="h-6 w-6 shrink-0" />}
        {item.today && (
          <button
            type="button"
            aria-label={`移出今日：${item.text}`}
            title="移出今日（矩陣裡還在）"
            onClick={() => setTodoToday(personId, item.id, false)}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 max-md:opacity-60"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {children.length > 0 && (
        <ul className="ml-3">
          {children.map((child, index) => (
            <TodayRow
              key={child.id}
              item={child}
              items={items}
              personId={personId}
              level={level + 1}
              last={index === children.length - 1}
            />
          ))}
        </ul>
      )}
    </Wrapper>
  );
}
