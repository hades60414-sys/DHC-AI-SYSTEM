import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { setRailCount, useRailOpenRequest } from '@/shared/mobileRail';
import { ChevronLeft, ListTodo, X } from 'lucide-react';

import EisenhowerMatrix from '@/modules/todo-dock/EisenhowerMatrix';
import TodayTodoList, { FILTER_KEY, FILTERS, readFilter } from '@/modules/todo-dock/TodayTodoList';
import type { TodayFilter } from '@/modules/todo-dock/TodayTodoList';
import TodoTrash from '@/modules/todo-dock/TodoTrash';
import { useTodoPerson } from '@/modules/todo-dock/todoPerson';
import { isDueNow, startPersonTodosSync, usePersonTodos } from '@/shared/personTodos';
import type { Project } from '@/shared/types';
import { cn } from '@/shared/utils';

const OPEN_STORAGE_KEY = 'dhc.todoDockOpen';
// Top of the right-edge stack: 待辦, 自選功能, 聊天室 (10/16), one handle-height apart; 聊天室 sits at 90% from the top
// on desktop and 46px under the middle on a phone.
const DESKTOP_HANDLE_STYLE: CSSProperties = { top: 'calc(90% - 92px)', transform: 'translateY(-50%)' };
const MOBILE_HANDLE_STYLE: CSSProperties = { bottom: 'calc(50% + 46px)' };

const readStored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStored = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the choice lasts for this page load.
  }
};

type TodoDockProps = {
  projects: Project[];
  isMobile: boolean;
};

/**
 * DHC CLI 待辦: a right-edge handle beside quick settings. One list per person (workspace project), opening on this
 * device's own person. On desktop the list docks next to the chat, which narrows to make room, so nothing is
 * covered and it can stay open while working; a phone has no room, so there it slides over the chat.
 * 10/06: the dock is 今日待辦 and its count is today only; the full 艾森豪矩陣 opens from a button in its header.
 * 10/08: that button is now 全部待辦, a bar above the list with a left chevron (the matrix opens to the left), not a header chip.
 */
export default function TodoDock({ projects, isMobile }: TodoDockProps) {
  useEffect(() => startPersonTodosSync(), []);

  // 11/01: only this device's own list, no switcher, so nobody else's to-dos show on a shared screen.
  const { people, ownId: personId } = useTodoPerson(projects);
  const personItems = usePersonTodos(personId ?? '').items;
  const openCount = personItems.filter((item) => (item.today && !item.done) || isDueNow(item)).length;
  useEffect(() => setRailCount('todo', openCount), [openCount]);
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [filter, setFilterState] = useState(readFilter);
  const setFilter = (next: TodayFilter) => {
    setFilterState(next);
    writeStored(FILTER_KEY, JSON.stringify(next));
  };
  // Only the docked panel comes back open after a reload; on a phone it would cover the chat.
  const [isOpen, setIsOpen] = useState(() => !isMobile && readStored(OPEN_STORAGE_KEY) === '1');

  // 手機頂端選單的「待辦」
  useRailOpenRequest('todo', () => setIsOpen(true));

  const toggle = () => {
    if (!isMobile) writeStored(OPEN_STORAGE_KEY, isOpen ? '0' : '1');
    setIsOpen(!isOpen);
  };

  // Docked, the right 2.5rem stays empty for the edge handles (this one and quick settings), so they never sit on the list.
  const panel = (
    <div className={cn('flex h-full flex-col', isMobile ? 'w-64' : 'w-[18.5rem]')}>
      <div className={cn('flex h-14 flex-shrink-0 items-center gap-2 border-b border-border bg-muted/40 pl-3', 'pr-2')}>
        <ListTodo className="h-4 w-4 shrink-0 text-primary" />
        <span className="shrink-0 text-sm font-semibold text-foreground">今日待辦</span>
        <button type="button" aria-label="關閉待辦" title="收起待辦" onClick={toggle} className="ml-auto shrink-0 rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      {/* 11/01: one toolbar row — a light 全部待辦 link on the left, the 重要／緊急 toggles on the right (was a big card + header toggles). */}
      {personId && (
        <div className={cn('flex flex-shrink-0 items-center gap-2 border-b border-border px-2 py-1.5', !isMobile && 'pr-8')}>
          <button
            type="button"
            onClick={() => setMatrixOpen(true)}
            aria-label="打開全部待辦"
            data-tutorial-tip="全部待辦：所有待辦依重要／緊急分四格"
            title="所有待辦，依重要／緊急分四格"
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md pl-1 pr-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4 shrink-0" />
            <span className="truncate">全部待辦</span>
          </button>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {FILTERS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter[key]}
                data-tutorial-tip={`只看${label}的待辦；再按一下取消`}
                title={filter[key] ? `只看${label}的（再按一下取消）；到期的一律顯示` : `只看${label}的；到期的一律顯示`}
                onClick={() => setFilter({ ...filter, [key]: !filter[key] })}
                className={cn(
                  'h-7 shrink-0 rounded border px-2 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  filter[key] ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {/* 11/01: pr-14 → pr-6; the handles overlap the scrollbar, so 1.5rem still clears them and the checkboxes sit further right. */}
      <div className={cn('min-h-0 flex-1 overflow-y-auto py-2', !isMobile && 'pr-6')}>
        {personId ? (
          <TodayTodoList key={personId} personId={personId} filter={filter} onClearFilter={() => setFilter({ important: false, urgent: false })} />
        ) : (
          <p className="px-4 py-4 text-center text-xs text-muted-foreground">還沒有任何人的工作區。</p>
        )}
      </div>
    </div>
  );

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        data-rail-item
        aria-pressed={isOpen}
        aria-label={isOpen ? '收起待辦' : '打開待辦'}
        data-tutorial-tip="今日待辦：點一下展開或收起，紅圓點數字是未完成項數"
        title={openCount > 0 ? `今日待辦（${openCount} 項未完成）` : '今日待辦'}
        className={cn(
          'fixed right-0 z-50 rounded-l-md border p-2 shadow-lg transition-colors',
          isOpen
            ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
            : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700',
        )}
        style={isMobile ? MOBILE_HANDLE_STYLE : DESKTOP_HANDLE_STYLE}
      >
        <ListTodo className="h-5 w-5" />
        {openCount > 0 && (
          <span className="absolute -left-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
            {openCount > 99 ? '99+' : openCount}
          </span>
        )}
      </button>
      {/* Outward-pointing triangle just left of the handle: straight to 全部待辦, which opens to the left.
          Always there, list open or not; the docked list keeps 1rem more on its right so it never sits on a checkbox. */}
      {personId && (
        <button
          type="button"
          onClick={() => setMatrixOpen(true)}
          data-rail-item
          data-rail-aux
          aria-label="直接打開全部待辦"
          data-tutorial-tip="全部待辦：直接打開，依重要／緊急分四格"
          title="全部待辦"
          className='fixed right-[38px] z-40 flex h-[38px] w-5 items-center justify-center text-primary opacity-50 transition-opacity hover:opacity-100'
          style={isMobile ? MOBILE_HANDLE_STYLE : DESKTOP_HANDLE_STYLE}
        >
          <svg viewBox="0 0 10 24" aria-hidden="true" fill="currentColor" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" className="h-6 w-2.5">
            <path d="M8.5 2.5v19L1.5 12z" />
          </svg>
        </button>
      )}

      {isOpen && (isMobile ? (
        <>
          <button
            type="button"
            aria-label="關閉待辦清單"
            onClick={toggle}
            className="fixed inset-0 z-[55] bg-background/60 backdrop-blur-sm"
          />
          <aside aria-label="待辦清單" className="fixed right-0 top-0 z-[56] h-full border-l border-border bg-background shadow-xl">
            {panel}
          </aside>
        </>
      ) : (
        <aside aria-label="待辦清單" className="h-full flex-shrink-0 border-l border-border bg-background">
          {panel}
        </aside>
      ))}

      {isOpen && !isMobile && personId && <TodoTrash personId={personId} page />}

      {matrixOpen && personId && (
        <EisenhowerMatrix
          personId={personId}
          personName={people.find((project) => project.projectId === personId)?.displayName ?? ''}
          isMobile={isMobile}
          onClose={() => setMatrixOpen(false)}
        />
      )}
    </>
  );
}
