import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Trash2, Undo2 } from 'lucide-react';

import { TODO_DRAG_TYPE } from '@/modules/todo-dock/quadrants';
import { readPersonTodos, removeTodo, restoreTodos, todoDescendants } from '@/shared/personTodos';
import type { TodoItem } from '@/shared/personTodos';
import { cn } from '@/shared/utils';

const UNDO_MS = 8_000;

/**
 * 10/15 垃圾桶 for 全部待辦 and 行事曆: while any task is being dragged, a bin floats at the bottom centre of the
 * window; dropping a task there deletes it with its subtasks, and a 復原 bar brings them back for a few seconds.
 * It floats over the content instead of taking room, so the cards don't shift when a drag begins (Chrome drops the
 * drag when they do). Phones have no drag and drop, so it never shows there.
 * A round bin low at the bottom, so it covers as little as possible. `page` = 今日待辦: pinned to the bottom of the
 * docked list, not the window centre (that is where the chat composer's drop target sits), under the dialogs
 * (z-50 < their z-[60]) so only one bin is ever reachable.
 */
export default function TodoTrash({ personId, page = false }: { personId: string; page?: boolean }) {
  const spot = page ? 'fixed bottom-3 z-50' : 'absolute bottom-2 z-30';
  const binSpot = page ? 'right-[7.5rem]' : 'left-1/2 -translate-x-1/2';
  const barSpot = page ? 'right-2 max-w-[17rem]' : 'left-1/2 max-w-[90%] -translate-x-1/2';
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState(false);
  const [removed, setRemoved] = useState<{ text: string; items: TodoItem[] } | null>(null);
  const timer = useRef<number>();
  const draggingRef = useRef(false);
  draggingRef.current = dragging;

  useEffect(() => {
    // Every task drag (cards, chips, 今日待辦 rows) carries the same type. Cards stop their dragstart from bubbling
    // (nested cards), so this listens on the way down and reads the type a tick later, once the source has set it.
    const start = (event: globalThis.DragEvent) => {
      const transfer = event.dataTransfer;
      window.setTimeout(() => {
        if (transfer?.types.includes(TODO_DRAG_TYPE)) setDragging(true);
      }, 0);
    };
    // A tick later too, so a drop on the bin is handled before the bin goes away. dragend alone is not enough: when a
    // drop re-renders the dragged element away (a 行事曆 chip moving to another day), dragend fires on a detached node
    // and never reaches the window, so the drop itself and the first mouse move after it also end the drag.
    const end = () => window.setTimeout(() => {
      setDragging(false);
      setOver(false);
    }, 0);
    window.addEventListener('dragstart', start, true);
    window.addEventListener('dragend', end, true);
    window.addEventListener('drop', end, true);
    // Browsers send no mouse moves during a drag, so the first one after a stuck drag clears it.
    const moved = () => {
      if (draggingRef.current) end();
    };
    window.addEventListener('mousemove', moved, true);
    return () => {
      window.removeEventListener('dragstart', start, true);
      window.removeEventListener('dragend', end, true);
      window.removeEventListener('drop', end, true);
      window.removeEventListener('mousemove', moved, true);
      window.clearTimeout(timer.current);
    };
  }, []);

  const trash = (id: string) => {
    const items = readPersonTodos(personId).items;
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    removeTodo(personId, id);
    setRemoved({ text: item.text, items: [item, ...todoDescendants(items, id)] });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setRemoved(null), UNDO_MS);
  };

  const undo = () => {
    if (removed) restoreTodos(personId, removed.items);
    window.clearTimeout(timer.current);
    setRemoved(null);
  };

  return (
    <>
      {dragging && (
        <div
          role="region"
          aria-label="垃圾桶"
          title="拖到這裡刪除"
          onDragOver={(event: DragEvent) => {
            if (!event.dataTransfer.types.includes(TODO_DRAG_TYPE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event: DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            const id = event.dataTransfer.getData(TODO_DRAG_TYPE);
            setDragging(false);
            setOver(false);
            if (id) trash(id);
          }}
          className={cn(
            spot,
            binSpot,
            'flex h-14 w-14 items-center justify-center rounded-full border-2 border-dashed shadow-xl transition-all',
            over
              ? 'scale-110 border-red-500 bg-red-500 text-white'
              : 'border-red-500/60 bg-background/95 text-red-600 dark:text-red-400',
          )}
        >
          <Trash2 className="h-6 w-6" />
        </div>
      )}
      {removed && !dragging && (
        <div
          role="status"
          className={cn(spot, barSpot, 'flex items-center gap-3 rounded-full border border-border bg-background px-4 py-2 text-sm shadow-xl')}
        >
          <span className="min-w-0 truncate">
            已刪除「{removed.text}」{removed.items.length > 1 && `與 ${removed.items.length - 1} 個子任務`}
          </span>
          <button type="button" onClick={undo} className="flex shrink-0 items-center gap-1 font-medium text-primary hover:underline">
            <Undo2 className="h-4 w-4" />
            復原
          </button>
        </div>
      )}
    </>
  );
}
