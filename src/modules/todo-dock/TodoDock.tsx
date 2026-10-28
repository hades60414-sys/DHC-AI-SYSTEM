import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { ChevronLeft, LayoutGrid, ListTodo } from 'lucide-react';
import { useIsTeamMode } from '@/shared/dhcConfig';

import { isQueryProject, isWorkspaceProject } from '@/modules/sidebar';
import EisenhowerMatrix from '@/modules/todo-dock/EisenhowerMatrix';
import TodayTodoList from '@/modules/todo-dock/TodayTodoList';
import { isFlashProject } from '@/shared/flashTasks';
import { isDueNow, startPersonTodosSync, usePersonTodos } from '@/shared/personTodos';
import type { Project } from '@/shared/types';
import { resolveSettingsProjectId } from '@/shared/userSettings';
import { cn } from '@/shared/utils';

const PERSON_STORAGE_KEY = 'dhc.todosPerson';
const OPEN_STORAGE_KEY = 'dhc.todoDockOpen';
// Top of the right-edge stack: 待辦, 版本更新, 功能許願池, one handle-height apart; 許願池 sits at 90% from the top
// on desktop and 50% from the bottom on a phone (where the quick-settings handle used to be).
const DESKTOP_HANDLE_STYLE: CSSProperties = { top: 'calc(90% - 92px)', transform: 'translateY(-50%)' };
const MOBILE_HANDLE_STYLE: CSSProperties = { bottom: 'calc(50% + 92px)' };

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
  // Personal mode: one list, no "whose todos" picker.
  const isTeam = useIsTeamMode();

  const people = useMemo(
    () => projects.filter((project) => isWorkspaceProject(project) && !isQueryProject(project) && !isFlashProject(project)),
    [projects],
  );
  const [chosenId, setChosenId] = useState<string | null>(() => readStored(PERSON_STORAGE_KEY));
  const personId = [chosenId, resolveSettingsProjectId(people), people[0]?.projectId]
    .find((id) => id && people.some((project) => project.projectId === id)) ?? null;
  const personItems = usePersonTodos(personId ?? '').items;
  const openCount = personItems.filter((item) => (item.today && !item.done) || isDueNow(item)).length;
  const allOpenCount = personItems.filter((item) => !item.done).length;
  const [matrixOpen, setMatrixOpen] = useState(false);
  // Only the docked panel comes back open after a reload; on a phone it would cover the chat.
  const [isOpen, setIsOpen] = useState(() => !isMobile && readStored(OPEN_STORAGE_KEY) === '1');

  const toggle = () => {
    if (!isMobile) writeStored(OPEN_STORAGE_KEY, isOpen ? '0' : '1');
    setIsOpen(!isOpen);
  };
  const choosePerson = (projectId: string) => {
    setChosenId(projectId);
    writeStored(PERSON_STORAGE_KEY, projectId);
  };

  // Docked, the right 2.5rem stays empty for the edge handles (this one and quick settings), so they never sit on the list.
  const panel = (
    <div className={cn('flex h-full flex-col', isMobile ? 'w-64' : 'w-[18.5rem]')}>
      <div className={cn('flex h-14 flex-shrink-0 items-center gap-2 border-b border-border bg-muted/40 pl-3', isMobile ? 'pr-3' : 'pr-[3.25rem]')}>
        <ListTodo className="h-4 w-4 shrink-0 text-primary" />
        <span className="shrink-0 text-sm font-semibold text-foreground">今日待辦</span>
        {isTeam && personId && (
          <select
            aria-label="誰的待辦"
            value={personId}
            onChange={(event) => choosePerson(event.target.value)}
            className="min-w-0 bg-transparent text-xs text-foreground outline-none"
          >
            {people.map((project) => (
              <option key={project.projectId} value={project.projectId}>
                {project.displayName}
              </option>
            ))}
          </select>
        )}
      </div>
      {personId && (
        <div className={cn('flex-shrink-0 border-b border-border p-2', !isMobile && 'pr-12')}>
          <button
            type="button"
            onClick={() => setMatrixOpen(true)}
            aria-label="打開全部待辦"
            title="所有待辦，依重要／緊急分四格"
            className="flex h-9 w-full items-center gap-2 rounded-md border border-border bg-muted/60 px-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            <ChevronLeft className="h-4 w-4 text-muted-foreground" />
            <LayoutGrid className="h-4 w-4 text-primary" />
            全部待辦
            <span className="ml-auto rounded-full bg-background px-2 py-0.5 text-xs tabular-nums">{allOpenCount}</span>
          </button>
        </div>
      )}
      <div className={cn('min-h-0 flex-1 overflow-y-auto py-2', !isMobile && 'pr-14')}>
        {personId ? (
          <TodayTodoList key={personId} personId={personId} />
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
        aria-pressed={isOpen}
        aria-label={isOpen ? '收起待辦' : '打開待辦'}
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
          aria-label="直接打開全部待辦"
          title="全部待辦"
          className="fixed right-[38px] z-40 flex h-[38px] w-5 items-center justify-center text-primary opacity-50 transition-opacity hover:opacity-100"
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
