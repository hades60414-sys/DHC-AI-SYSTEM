import { useEffect, useState } from 'react';
import type { DragEvent } from 'react';
import { Check, LayoutGrid, Link2, Plus, Sun, Trash2, Unlink, X } from 'lucide-react';

import TaskMarker from '@/modules/todo-dock/TaskMarker';
import TimeTag from '@/modules/todo-dock/TimeTag';
import TodayTodoList from '@/modules/todo-dock/TodayTodoList';
import { DESKTOP_GRID, parentTrail, QUADRANTS, quadrantMeta, TODO_DRAG_TYPE } from '@/modules/todo-dock/quadrants';
import {
  addTodo,
  bindTodo,
  canNestTodo,
  clearDoneTodos,
  editTodo,
  effectiveQuadrant,
  isOwnCard,
  MAX_TODO_DEPTH,
  moveTodo,
  nestTodo,
  removeTodo,
  setTodoDone,
  setTodoToday,
  todoChildren,
  todoDepth,
  todoDescendants,
  todoEditText,
  unlinkTodo,
  usePersonTodos,
} from '@/shared/personTodos';
import type { Quadrant, TodoItem } from '@/shared/personTodos';
import { cn } from '@/shared/utils';

type EisenhowerMatrixProps = {
  personId: string;
  personName: string;
  isMobile: boolean;
  onClose: () => void;
};

/** Which drop area the dragged card is over: a quadrant, 未分類, 今日待辦, or a card's title (nest under it). */
type DropTarget = Quadrant | 'inbox' | 'today' | `card:${string}`;

type DragState = {
  draggingId: string | null;
  over: DropTarget | null;
  setDragging: (id: string | null) => void;
  setOver: (target: DropTarget | null) => void;
};

const draggedId = (event: DragEvent) => event.dataTransfer.getData(TODO_DRAG_TYPE);
const carriesTodo = (event: DragEvent) => event.dataTransfer.types.includes(TODO_DRAG_TYPE);

/**
 * 艾森豪矩陣, opened from the 待辦 dock. Cards drag between quadrants; dropping one on another card's title makes it
 * that card's subtask (two levels at most). A subtask dragged to a quadrant splits out there and keeps a link to
 * its parent, which 綁回 undoes. ☀ (or dragging onto the 今日待辦 column) puts any task on today's list.
 */
export default function EisenhowerMatrix({ personId, personName, isMobile, onClose }: EisenhowerMatrixProps) {
  const { items } = usePersonTodos(personId);
  const [draggingId, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<DropTarget | null>(null);
  const [showDone, setShowDone] = useState(false);
  const drag: DragState = { draggingId, over, setDragging, setOver };

  useEffect(() => {
    // Escape in a text box only cancels that box.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !(event.target instanceof HTMLElement && event.target.closest('input, select'))) onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const cardsIn = (quadrant: Quadrant | undefined) =>
    items.filter((item) => !item.done && (quadrant ? item.quadrant === quadrant : !item.parentId && !item.quadrant));
  const inbox = cardsIn(undefined);
  const doneCards = items.filter((item) => item.done && isOwnCard(item));

  const dropZone = (target: DropTarget, onDrop: (id: string) => void) => ({
    onDragOver: (event: DragEvent) => {
      if (!carriesTodo(event)) return;
      event.preventDefault();
      if (over !== target) setOver(target);
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setOver(null);
      setDragging(null);
      const id = draggedId(event);
      if (id) onDrop(id);
    },
  });

  const cardProps = { items, personId, drag };

  const quadrantPanel = (meta: (typeof QUADRANTS)[number]) => {
    const cards = cardsIn(meta.id);
    return (
      <section
        key={meta.id}
        aria-label={meta.title}
        {...dropZone(meta.id, (id) => moveTodo(personId, id, meta.id))}
        className={cn(
          'flex min-h-[10rem] flex-col rounded-lg border p-2 transition-colors',
          meta.tint,
          over === meta.id && 'ring-2 ring-primary',
        )}
      >
        <h3 className="mb-1.5 flex items-center gap-1.5 px-1 text-xs font-semibold">
          <span className={cn('h-2 w-2 rounded-full', meta.dot)} />
          {meta.title}
          <span className="font-normal text-muted-foreground">· {meta.hint}</span>
          <span className="ml-auto font-normal text-muted-foreground">{cards.length}</span>
        </h3>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
          {cards.map((item) => (
            <TodoCard key={item.id} item={item} {...cardProps} />
          ))}
        </div>
        <AddInput
          label={`新增到${meta.title}`}
          placeholder="新增任務，Enter 存"
          onAdd={(text) => addTodo(personId, text, { quadrant: meta.id })}
        />
      </section>
    );
  };

  return (
    <div className="fixed inset-0 z-[60]">
      <button type="button" aria-label="關閉全部待辦" onClick={onClose} className="absolute inset-0 bg-background/70 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-label="全部待辦"
        className={cn(
          'absolute flex flex-col overflow-hidden border border-border bg-background shadow-2xl',
          isMobile ? 'inset-0' : 'inset-6 rounded-xl',
        )}
      >
        <div className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-4">
          <LayoutGrid className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">全部待辦</span>
          <span className="text-xs text-muted-foreground">{personName}</span>
          {!isMobile && (
            <span className="ml-3 truncate text-[11px] text-muted-foreground">
              拖卡片換象限；拖到別張卡的標題＝變成它的子任務；子任務拖回左邊未分類＝變回獨立任務；☀ 或拖到右邊＝匯入今日待辦；文字最後寫 @10/20＝期限
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="收起全部待辦"
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className={cn('flex min-h-0 flex-1', isMobile ? 'flex-col overflow-y-auto' : 'flex-row')}>
          {/* Always rendered: a drop area that appeared only once a drag began shifted the cards and Chrome dropped the drag. */}
          <aside
            aria-label="未分類"
            {...dropZone('inbox', (id) => moveTodo(personId, id, undefined))}
            className={cn(
              'flex flex-shrink-0 flex-col',
              isMobile ? 'm-3 mb-0 rounded-lg border border-dashed border-border' : 'w-64 border-r border-border',
              over === 'inbox' ? 'bg-primary/5 ring-2 ring-inset ring-primary' : !isMobile && 'bg-muted/20',
            )}
          >
            <h3 className="flex h-10 flex-shrink-0 items-center gap-1.5 border-b border-border px-3 text-xs font-semibold">
              <TaskMarker quadrant={undefined} main />
              未分類 {inbox.length}
              <span className="font-normal text-muted-foreground">（拖進象限，也可拖回來）</span>
            </h3>
            <div className={cn('space-y-1.5 p-2', !isMobile && 'min-h-0 flex-1 overflow-y-auto')}>
              {inbox.map((item) => (
                <TodoCard key={item.id} item={item} {...cardProps} />
              ))}
              <AddInput label="新增到未分類" placeholder="新增任務，Enter 存" onAdd={(text) => addTodo(personId, text)} />
            </div>
          </aside>

          <div className={cn('flex min-w-0 flex-1 flex-col gap-3 p-3', !isMobile && 'overflow-y-auto')}>
            <div className={cn('grid min-h-0 flex-1 gap-3', isMobile ? 'grid-cols-1' : 'grid-cols-2 grid-rows-2')}>
              {isMobile ? QUADRANTS.map(quadrantPanel) : DESKTOP_GRID.map((id) => quadrantPanel(quadrantMeta(id)!))}
            </div>

            {doneCards.length > 0 && (
              <div className="rounded-lg border border-border/60 p-2">
                <div className="flex items-center justify-between px-1">
                  <button
                    type="button"
                    onClick={() => setShowDone((value) => !value)}
                    aria-expanded={showDone}
                    className="text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    {showDone ? '▾' : '▸'} 已完成 {doneCards.length}
                  </button>
                  <button
                    type="button"
                    onClick={() => clearDoneTodos(personId)}
                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-red-600"
                  >
                    <Trash2 className="h-3 w-3" />
                    清除已完成
                  </button>
                </div>
                {showDone && (
                  <div className="mt-1.5 grid gap-1.5 md:grid-cols-3">
                    {doneCards.map((item) => (
                      <TodoCard key={item.id} item={item} {...cardProps} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {!isMobile && (
            <aside
              aria-label="今日待辦"
              {...dropZone('today', (id) => setTodoToday(personId, id, true))}
              className={cn(
                'flex w-72 flex-shrink-0 flex-col border-l border-border',
                over === 'today' ? 'bg-primary/5 ring-2 ring-inset ring-primary' : 'bg-muted/20',
              )}
            >
              <h3 className="flex h-10 flex-shrink-0 items-center gap-1.5 border-b border-border px-3 text-xs font-semibold">
                <Sun className="h-3.5 w-3.5 text-amber-500" />
                今日待辦
                <span className="font-normal text-muted-foreground">（拖卡片到這裡）</span>
              </h3>
              <div className="min-h-0 flex-1 overflow-y-auto py-2">
                <TodayTodoList personId={personId} />
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

function AddInput({ label, placeholder, onAdd, autoFocus, onDone }: {
  label: string;
  placeholder: string;
  onAdd: (text: string) => boolean;
  autoFocus?: boolean;
  onDone?: () => void;
}) {
  const [draft, setDraft] = useState('');
  return (
    <form
      className="mt-1.5 flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (onAdd(draft)) setDraft('');
      }}
    >
      <input
        autoFocus={autoFocus}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onDone?.();
        }}
        onBlur={() => {
          if (!draft.trim()) onDone?.();
        }}
        placeholder={placeholder}
        aria-label={label}
        className="h-7 min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2 text-xs outline-none focus:border-primary/50"
      />
      <button
        type="submit"
        disabled={!draft.trim()}
        aria-label={label}
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </form>
  );
}

type TodoCardProps = {
  item: TodoItem;
  items: TodoItem[];
  personId: string;
  drag: DragState;
  /** Set on a subtask nested in its parent: where the parent's tree line runs and whether this is its last branch. */
  branch?: { anchor: string; last: boolean };
};

/**
 * Tree line for a nested row: a trunk down the left edge (stopping at the elbow on the last branch) and an
 * elbow into the row. The elbow sits at the row's checkbox centre; a 已拆到 note row is shorter.
 */
function branchClass(anchor: string, last: boolean, note = false) {
  return cn(
    anchor,
    'relative pl-4 before:absolute before:left-0 before:top-0 before:w-px before:bg-muted-foreground/40 after:absolute after:left-0 after:h-px after:w-3 after:bg-muted-foreground/40',
    note ? 'after:top-[10px]' : 'after:top-[13px]',
    !last ? 'before:bottom-0' : note ? 'before:h-[10px]' : 'before:h-[13px]',
  );
}

function TodoCard({ item, items, personId, drag, branch }: TodoCardProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [adding, setAdding] = useState(false);
  const depth = todoDepth(items, item.id);
  const children = todoChildren(items, item.id);
  const nestTarget: DropTarget = `card:${item.id}`;
  const canTakeDrop = drag.draggingId !== null && canNestTodo(items, drag.draggingId, item.id);
  const splitOut = Boolean(item.parentId && item.quadrant);
  // Subtask trunks start under this card's marker: the diamond on a main card, the dot on a split-out one,
  // the checkbox on a nested row.
  const childAnchor = depth === 0 ? 'ml-[7px]' : splitOut ? 'ml-[5px]' : 'ml-[10px]';

  const finishEdit = () => {
    editTodo(personId, item.id, editText);
    setEditing(false);
  };
  const remove = () => {
    const below = todoDescendants(items, item.id).length;
    if (below === 0 || window.confirm(`「${item.text}」連同 ${below} 個子任務一起刪除？`)) removeTodo(personId, item.id);
  };

  return (
    <div
      draggable={!editing}
      onDragStart={(event) => {
        event.stopPropagation();
        event.dataTransfer.setData(TODO_DRAG_TYPE, item.id);
        event.dataTransfer.effectAllowed = 'move';
        // Changing the page inside dragstart can make Chrome cancel the drag, so the highlight waits a tick.
        window.setTimeout(() => drag.setDragging(item.id), 0);
      }}
      onDragEnd={() => {
        drag.setDragging(null);
        drag.setOver(null);
      }}
      className={cn(
        depth === 0 || splitOut
          ? 'rounded-md border border-border bg-background px-1.5 py-1 shadow-sm'
          : branch && branchClass(branch.anchor, branch.last),
        drag.draggingId === item.id && 'opacity-40',
      )}
    >
      {splitOut && (
        <div className="flex items-center gap-1 px-0.5 text-[10px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">↳ 屬於 {parentTrail(items, item)}</span>
          <button
            type="button"
            onClick={() => bindTodo(personId, item.id)}
            aria-label={`綁回原卡：${item.text}`}
            title="綁回原卡，跟著上層走"
            className="flex shrink-0 items-center gap-0.5 rounded px-1 hover:bg-muted hover:text-foreground"
          >
            <Link2 className="h-3 w-3" />
            綁回
          </button>
          <button
            type="button"
            onClick={() => unlinkTodo(personId, item.id)}
            aria-label={`獨立：${item.text}`}
            title="解除上下層關係，變成獨立任務"
            className="flex shrink-0 items-center gap-0.5 rounded px-1 hover:bg-muted hover:text-foreground"
          >
            <Unlink className="h-3 w-3" />
            獨立
          </button>
        </div>
      )}
      <div
        onDragOver={(event) => {
          if (!carriesTodo(event) || !canTakeDrop) return;
          event.preventDefault();
          event.stopPropagation();
          if (drag.over !== nestTarget) drag.setOver(nestTarget);
        }}
        onDrop={(event) => {
          if (!canTakeDrop) return;
          event.preventDefault();
          event.stopPropagation();
          drag.setOver(null);
          drag.setDragging(null);
          nestTodo(personId, draggedId(event), item.id);
        }}
        className={cn(
          'group flex items-start gap-1.5 rounded px-0.5 py-0.5 max-md:flex-wrap',
          drag.over === nestTarget && 'bg-primary/10 ring-1 ring-primary',
        )}
      >
        {(depth === 0 || splitOut) && (
          <TaskMarker quadrant={effectiveQuadrant(items, item.id)} main={!item.parentId} className="mt-[6px]" />
        )}
        <button
          type="button"
          aria-label={item.done ? `改回未完成：${item.text}` : `完成：${item.text}`}
          onClick={() => setTodoDone(personId, item.id, !item.done)}
          className={cn(
            'mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded border',
            item.done ? 'border-primary/50 bg-primary/10 text-primary' : 'border-muted-foreground/40 hover:border-primary',
          )}
        >
          {item.done && <Check className="h-3 w-3" />}
        </button>
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
            aria-label="修改任務"
            className="min-w-0 flex-1 rounded border border-primary/40 bg-background px-1 text-xs outline-none max-md:basis-[calc(100%-1.75rem)]"
          />
        ) : (
          <span
            className={cn(
              'min-w-0 flex-1 cursor-grab break-words leading-5 max-md:basis-[calc(100%-2.75rem)]',
              depth === 0 ? 'text-[13px] font-medium' : 'text-xs',
              item.done ? 'text-muted-foreground line-through' : 'text-foreground',
            )}
            title="拖曳搬移；點兩下修改"
            onDoubleClick={() => {
              setEditing(true);
              setEditText(todoEditText(item));
            }}
          >
            {item.text}
            <TimeTag item={item} showAge={depth === 0 || splitOut} className="ml-1.5 font-normal" />
          </span>
        )}
        <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100 max-md:ml-auto max-md:gap-1 max-md:opacity-70">
          {!item.done && (
            <button
              type="button"
              onClick={() => setTodoToday(personId, item.id, !item.today)}
              aria-label={item.today ? `移出今日：${item.text}` : `匯入今日：${item.text}`}
              aria-pressed={item.today}
              title={item.today ? '已在今日待辦，按一下移出' : '匯入今日待辦'}
              className="flex h-5 w-5 items-center justify-center rounded hover:bg-muted"
            >
              <Sun className={cn('h-3.5 w-3.5', item.today ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground')} />
            </button>
          )}
          {depth < MAX_TODO_DEPTH && !item.done && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              aria-label={`拆子任務：${item.text}`}
              title="往下拆一個子任務"
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
          <MoveSelect item={item} personId={personId} />
          <button
            type="button"
            onClick={remove}
            aria-label={`刪除：${item.text}`}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-red-600"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {item.today && !item.done && <Sun className="mt-1 h-3 w-3 shrink-0 fill-amber-400 text-amber-500 group-hover:hidden max-md:hidden" />}
      </div>

      {children.map((child, index) =>
        child.quadrant ? (
          <div
            key={child.id}
            className={cn(
              branchClass(childAnchor, !adding && index === children.length - 1, true),
              'truncate text-[10px] leading-5 text-muted-foreground',
            )}
          >
            ↗ 已拆到{quadrantMeta(child.quadrant)?.title}：{child.text}
          </div>
        ) : (
          <TodoCard
            key={child.id}
            item={child}
            items={items}
            personId={personId}
            drag={drag}
            branch={{ anchor: childAnchor, last: !adding && index === children.length - 1 }}
          />
        ),
      )}
      {adding && (
        <div className={branchClass(childAnchor, true)}>
          <AddInput
            autoFocus
            label={`新增子任務到${item.text}`}
            placeholder="子任務，Enter 存，Esc 收"
            onAdd={(text) => addTodo(personId, text, { parentId: item.id })}
            onDone={() => setAdding(false)}
          />
        </div>
      )}
    </div>
  );
}

/** Touch screens have no drag and drop, so every card also moves through this menu. */
const isBound = (item: TodoItem) => Boolean(item.parentId) && !item.quadrant;

function MoveSelect({ item, personId }: { item: TodoItem; personId: string }) {
  return (
    <select
      aria-label={`移到：${item.text}`}
      value=""
      onChange={(event) => {
        const next = event.target.value;
        if (next === 'bound') bindTodo(personId, item.id);
        else moveTodo(personId, item.id, next === 'inbox' ? undefined : (next as Quadrant));
      }}
      className="h-5 rounded border border-border/60 bg-background px-0.5 text-[10px] text-muted-foreground outline-none md:hidden"
    >
      <option value="" disabled>移到…</option>
      {item.parentId && !isBound(item) && <option value="bound">綁回上層</option>}
      <option value="inbox">{item.parentId ? '未分類（變成獨立任務）' : '未分類'}</option>
      {QUADRANTS.map((meta) => (
        <option key={meta.id} value={meta.id}>
          {meta.title}
        </option>
      ))}
    </select>
  );
}
