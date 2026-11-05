import { ChevronLeft, ChevronRight, LogOut, MessageCircle, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import type { AppTab, Project, ProjectSession } from '@/shared/types';
import { useBackgroundWork } from '@/shared/backgroundWork';
import { useBusySessionIdSet } from '@/shared/context/SessionProtectionContext';
import { endFlashSession, useIsFlashSession } from '@/shared/flashTasks';
import { cn } from '@/shared/utils';
import { CommandModeControl } from '@/modules/command-mode';
import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';
import MobileRailToggle from '@/modules/project-workspace/MobileRailToggle';
import WorkspaceTabs from '@/modules/project-workspace/WorkspaceTabs';
import WorkspaceTitle from '@/modules/project-workspace/WorkspaceTitle';
import { readCoSession } from '@/shared/coSessions';
import { markSeen, openChatPanel, roomOfSession, setChatContext, useMyMentions } from '@/shared/chatRoom';
import { ChatRoomButton } from '@/modules/chat-room';

type WorkspaceHeaderProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  isMobile: boolean;
  onMenuClick: () => void;
};

/** Rendered by WorkspaceMain to show the workspace title alongside the scrollable tab bar. */
export default function WorkspaceHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  isMobile,
  onMenuClick,
}: WorkspaceHeaderProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const hasOverflow = canScrollLeft || canScrollRight;
  // DHC CLI 快閃任務: end the open task from here too — same no-dialog delete as the sidebar ×.
  const isFlash = useIsFlashSession(selectedSession?.id, selectedProject);
  const flashSessionId = activeTab === 'chat' && selectedSession && isFlash ? selectedSession.id : null;
  const busySessionIds = useBusySessionIdSet();
  const backgroundWork = useBackgroundWork(flashSessionId ?? '');
  const showFlashEnd = flashSessionId !== null && !busySessionIds.has(flashSessionId) && !backgroundWork;

  // DHC CLI 10/16 聊天室: the open session gets its own room tab, and opening it clears its mentions of you.
  const chatSessionId = activeTab === 'chat' ? selectedSession?.id ?? null : null;
  const chatSessionTitle = selectedSession
    ? String(readCoSession(selectedSession.id)?.title || selectedSession.summary || selectedSession.name || selectedSession.title || '')
    : '';
  const mentionHere = useMyMentions().get(chatSessionId ? roomOfSession(chatSessionId) : '') ?? 0;
  useEffect(() => {
    setChatContext(chatSessionId && selectedSession ? {
      kind: 'session',
      id: chatSessionId,
      title: chatSessionTitle,
      ownerProjectId: readCoSession(chatSessionId)?.ownerProjectId ?? selectedProject.projectId,
      provider: selectedSession.__provider,
    } : null);
  }, [chatSessionId, chatSessionTitle, selectedProject.projectId, selectedSession]);
  useEffect(() => {
    if (chatSessionId && mentionHere > 0) markSeen(roomOfSession(chatSessionId));
  }, [chatSessionId, mentionHere]);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();

    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);

    return () => observer.disconnect();
  }, [updateScrollState]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

      const maxScrollLeft = el.scrollWidth - el.clientWidth;
      const canMove = event.deltaY < 0 ? el.scrollLeft > 0 : el.scrollLeft < maxScrollLeft;
      if (!canMove) return;

      event.preventDefault();
      const lineMultiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 20 : 1;
      el.scrollBy({ left: event.deltaY * lineMultiplier, behavior: 'auto' });
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const activeTabElement = scrollRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      activeTabElement?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      updateScrollState();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, updateScrollState]);

  const scrollTabs = (direction: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(180, el.clientWidth * 0.65), behavior: 'smooth' });
  };

  return (
    <header data-minimal-zone="header" className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background/95 px-3 py-1.5 backdrop-blur-sm sm:px-4 sm:py-2">
      <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 items-center gap-2 sm:max-w-[min(34%,24rem)] sm:flex-[1_1_18rem]">
          {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
          <WorkspaceTitle
            activeTab={activeTab}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            shouldShowTasksTab={shouldShowTasksTab}
          />
          {showFlashEnd && (
            <button
              data-presenter-extra
              type="button"
              title="結束這個快閃任務：移到側欄「封存」，7 天內可以還原，之後自動刪除"
              className="flex h-7 flex-shrink-0 items-center gap-1 rounded-md border border-red-500/40 px-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
              onClick={() => void endFlashSession(flashSessionId)}
            >
              <X className="h-3.5 w-3.5" />
              結束任務
            </button>
          )}
          <CommandModeControl projectKey={selectedProject.fullPath || null} />
          {/* 手機：右上角只有漢堡，展開後往左排 聊天室／工具庫／待辦（原本的 聊天／終端機／檔案 切換已拿掉） */}
          {isMobile && <MobileRailToggle />}
        </div>

        {/* 投影 外觀：PRESENTER 頂列右邊是員編＋登出（純裝飾），真的分頁按住 Alt 才出現 */}
        <div className="presenter-only ml-auto items-center gap-3 text-sm text-foreground/80">
          <span>user01</span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">登出<LogOut className="h-3.5 w-3.5" /></span>
        </div>
        {!isMobile && (
        <div data-presenter-extra className="-mx-3 min-w-0 sm:mx-0 sm:flex-1">
          <div className="relative ml-auto w-fit max-w-full">
            {canScrollLeft && (
              <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-12 bg-gradient-to-r from-background via-background/90 to-transparent" />
            )}
            <div
              ref={scrollRef}
              onScroll={updateScrollState}
              className={cn(
                'scrollbar-hide max-w-full scroll-smooth overflow-x-auto overscroll-x-contain px-3 [-webkit-overflow-scrolling:touch]',
                hasOverflow ? 'sm:px-9' : 'sm:pl-3 sm:pr-0',
              )}
            >
              <WorkspaceTabs
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                shouldShowTasksTab={shouldShowTasksTab}
              />
            </div>
            {canScrollRight && (
              <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l from-background via-background/90 to-transparent" />
            )}

            {canScrollLeft && (
              <button
                type="button"
                onClick={() => scrollTabs(-1)}
                aria-label={t('navigation.scrollTabsLeft', { defaultValue: 'Scroll tabs left' })}
                className="absolute left-1 top-1/2 z-20 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md border border-border/70 bg-background/95 text-muted-foreground shadow-sm outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 sm:flex"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            )}
            {canScrollRight && (
              <button
                type="button"
                onClick={() => scrollTabs(1)}
                aria-label={t('navigation.scrollTabsRight', { defaultValue: 'Scroll tabs right' })}
                className="absolute right-1 top-1/2 z-20 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md border border-border/70 bg-background/95 text-muted-foreground shadow-sm outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 sm:flex"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
        )}
        {/* 11/01 極簡模式：標題旁的聊天室圖示藏起來了，改放頁首右上角，滑鼠靠近頁首才淡入（index.css data-minimal-only）。 */}
        {!isMobile && (
          <div data-presenter-extra data-minimal-only className="flex flex-shrink-0 items-center">
            {chatSessionId ? (
              <ChatRoomButton kind="session" id={chatSessionId} className="h-7 w-7 justify-center" />
            ) : (
              <button
                type="button"
                aria-label="聊天室"
                title="聊天室"
                onClick={() => openChatPanel()}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                <MessageCircle className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
