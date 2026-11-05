import { Activity, BookOpen, CalendarClock, Folder, MessageSquare, RefreshCw, Search, X, PanelLeftClose } from 'lucide-react';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';

import { Button, Input, Tooltip } from '@/shared/ui';
import { CLOUDCLI_WORDMARK_FONT_FAMILY } from '@/shared/constants';
import { IS_PLATFORM,cn } from '@/shared/utils';
import { useIsPresenter } from '@/shared/context/ThemeContext';
import AlertBell from './AlertBell';
import type { SidebarSearchMode } from '@/shared/types';

const MOD_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

type SidebarHeaderProps = {
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  projectsCount: number;
  runningSessionsCount: number;
  archivedSessionsCount: number;
  isArchivedSessionsLoading: boolean;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCollapseSidebar: () => void;
  currentVersion: string;
  t: TFunction;
};

/** Module-level, not a nested render function, so the wordmark is not remounted on every SidebarHeader render. */
function LogoBlock({ t, version }: { t: TFunction; version: string }) {
  const isPresenter = useIsPresenter();
  if (isPresenter) {
    return <h1 className="truncate text-base font-bold leading-tight text-foreground">DHC CLI</h1>;
  }

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {/* DHC CLI: a line-drawn dog face (the same one as the 狗 avatar). */}
      <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-primary/90 shadow-sm">
        <svg className="h-5 w-5 text-primary-foreground" viewBox="12 13 40 40" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 30 Q20 19 32 19 Q44 19 44 30 Q44.5 46.5 32 47 Q19.5 46.5 20 30 Z" />
          <path d="M21.5 21.5 Q13 20 13.5 30 Q14 36 19.8 33.5" />
          <path d="M42.5 21.5 Q51 20 50.5 30 Q50 36 44.2 33.5" />
          <circle cx="26.5" cy="29" r="1.7" fill="currentColor" stroke="none" />
          <circle cx="37.5" cy="29" r="1.7" fill="currentColor" stroke="none" />
          <ellipse cx="32" cy="35.4" rx="2.7" ry="1.9" fill="currentColor" stroke="none" />
          <path d="M32 37.3 v2.4 M28 39.8 q2 2 4 0 q2 2 4 0" />
        </svg>
      </div>
      <div className="min-w-0">
        <h1
          className="truncate text-sm font-bold leading-tight tracking-tight text-foreground"
          style={{ fontFamily: CLOUDCLI_WORDMARK_FONT_FAMILY }}
        >
          {t('app.title')}
        </h1>
        {/* DHC CLI：版本從側欄底部搬到標題下方，底部省一列 */}
        <span data-minimal-hide className="block truncate text-[10px] leading-tight text-muted-foreground/50">v{version} · DHC 團隊</span>
      </div>
    </div>
  );
}

/** Rendered by SidebarContent at the top of the panel for the search box, search-mode tabs, refresh and new-project actions. */
export default function SidebarHeader({
  isPWA,
  isMobile,
  isLoading,
  projectsCount,
  runningSessionsCount,
  archivedSessionsCount,
  isArchivedSessionsLoading,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  onSearchModeChange,
  onRefresh,
  isRefreshing,
  onCollapseSidebar,
  currentVersion,
  t,
}: SidebarHeaderProps) {
  const showSearchTools = (projectsCount > 0 || runningSessionsCount > 0 || archivedSessionsCount > 0 || isArchivedSessionsLoading) && !isLoading;
  const searchPlaceholder = searchMode === 'conversations'
    ? t('search.conversationsPlaceholder')
    : searchMode === 'archived'
      ? t('search.archivedPlaceholder', 'Search archived sessions...')
      : searchMode === 'running'
        ? t('search.runningPlaceholder', 'Search running sessions...')
        : searchMode === 'scheduled'
          ? '搜尋排程內容或對話名稱…'
        : t('projects.searchPlaceholder');
  const runningBadgeText = runningSessionsCount > 99 ? '99+' : String(runningSessionsCount);

  return (
    <div className="flex-shrink-0">
      {/* Desktop header */}
      <div
        className="hidden px-3 pb-2 pt-3 md:block"
        style={{}}
      >
        <div className="flex items-center justify-between gap-2">
          {IS_PLATFORM ? (
            // DHC：點標誌回 DHC CLI 首頁（整頁重新載入），不再連到 cloudcli.ai
            <Link
              to="/"
              reloadDocument
              className="flex min-w-0 items-center gap-2.5 transition-opacity hover:opacity-80"
              title="回到 DHC AI System 首頁"
            >
              <LogoBlock t={t} version={currentVersion} />
            </Link>
          ) : (
            <LogoBlock t={t} version={currentVersion} />
          )}

          {/* DHC CLI 10/21：重整拿掉（點標題就是重整）。＋移到分頁列最右 */}
          <div className="flex flex-shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onCollapseSidebar}
              data-tutorial-tip="收合側欄，把空間讓給對話"
              title={t('tooltips.hideSidebar')}
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>


        {/* Search bar */}
        {showSearchTools && (
          <div className="mt-2.5 space-y-2">
            {/* Search mode toggle */}
            <div className="flex rounded-lg bg-muted/50 p-0.5">
              <button
                onClick={() => onSearchModeChange('projects')}
                data-tutorial-tip="專案：依專案分類看所有對話"
                aria-pressed={searchMode === 'projects'}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-normal transition-all",
                  searchMode === 'projects'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Folder className="h-3 w-3" />
                {t('search.modeProjects')}
              </button>
              {/* DHC CLI 10/31：對話回到中間並加上文字（例行拿掉後的位置）；封存從對話分頁上方的連結進入。 */}
              <button
                onClick={() => onSearchModeChange('conversations')}
                data-tutorial-tip="對話：不分專案，直接列出最近的對話"
                aria-pressed={searchMode === 'conversations' || searchMode === 'archived'}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-normal transition-all",
                  searchMode === 'conversations' || searchMode === 'archived'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <MessageSquare className="h-3 w-3" />
                {t('search.modeConversations')}
              </button>
              <button
                onClick={() => onSearchModeChange('query')}
                data-tutorial-tip="查詢：問內部法規、資料目錄和這個網站怎麼用"
                aria-pressed={searchMode === 'query'}
                title="查詢專區（DEMO）：法遵、DHC AI System 教學"
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-normal transition-all",
                  searchMode === 'query'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <BookOpen className="h-3 w-3" />
                查詢
              </button>
              <Tooltip content={t('search.runningTooltip', 'Running sessions')} position="top">
                <button
                  onClick={() => onSearchModeChange('running')}
                  data-tutorial-tip="執行中：只看正在跑的對話，綠色數字是數量"
                  aria-pressed={searchMode === 'running'}
                  aria-label={t('search.runningTooltip', 'Running sessions')}
                  title={t('search.runningTooltip', 'Running sessions')}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-normal transition-all",
                    searchMode === 'running'
                      ? "bg-background shadow-sm text-foreground ring-1 ring-emerald-500/15"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <span className="relative flex h-3 w-3 items-center justify-center">
                    <Activity className={cn("h-3 w-3", runningSessionsCount > 0 && "text-emerald-500")} />
                    {runningSessionsCount > 0 && (
                      <span className="absolute -right-2.5 -top-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-emerald-500 px-0.5 text-[8px] font-semibold leading-none text-white shadow-sm ring-1 ring-background">
                        {runningBadgeText}
                      </span>
                    )}
                  </span>
                </button>
              </Tooltip>
              {/* DHC CLI 11/01：新增專案的 ＋ 位置改成「排程」：列出時鐘與分流排好的訊息 */}
              <button
                type="button"
                onClick={() => onSearchModeChange('scheduled')}
                data-tutorial-tip="排程：看所有排好時間或排到夜間的訊息，可以點開或取消"
                aria-pressed={searchMode === 'scheduled'}
                aria-label="排程"
                title="排程"
                className={cn(
                  "flex items-center justify-center rounded-md px-2.5 py-1.5 transition-all",
                  searchMode === 'scheduled'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <CalendarClock className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                type="text"
                placeholder={searchPlaceholder}
                data-tutorial-tip={`輸入關鍵字篩選；${MOD_KEY} K 開啟指令面板（搜對話、檔案、指令）`}
                value={searchFilter}
                onChange={(event) => onSearchFilterChange(event.target.value)}
                className="nav-search-input h-9 rounded-xl border-0 pl-9 pr-14 text-sm transition-all duration-200 placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              {searchFilter ? (
                <button
                  onClick={onClearSearchFilter}
                  aria-label={t('tooltips.clearSearch')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 hover:bg-accent"
                >
                  <X className="h-3 w-3 text-muted-foreground" />
                </button>
              ) : (
                <kbd
                  aria-hidden
                  data-tutorial
                  title={t('tooltips.openCommandPalette')}
                  className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:inline-flex"
                >
                  {MOD_KEY}
                  <span>K</span>
                </kbd>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Desktop divider */}
      <div className="nav-divider hidden md:block" />

      {/* Mobile header */}
      <div
        className="p-3 pb-2 md:hidden"
        style={isPWA && isMobile ? { paddingTop: '16px' } : {}}
      >
        <div className="flex items-center justify-between">
          {IS_PLATFORM ? (
            // DHC：點標誌回 DHC CLI 首頁（整頁重新載入），不再連到 cloudcli.ai
            <Link
              to="/"
              reloadDocument
              className="flex min-w-0 items-center gap-2.5 transition-opacity active:opacity-70"
              title="回到 DHC AI System 首頁"
            >
              <LogoBlock t={t} version={currentVersion} />
            </Link>
          ) : (
            <LogoBlock t={t} version={currentVersion} />
          )}

          <div className="flex flex-shrink-0 gap-1.5">
            <button
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/50 transition-all active:scale-95"
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              <RefreshCw className={`h-4 w-4 text-muted-foreground ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            {/* DHC CLI 10/14：警示放最右，重新整理往左移；11/01 新增專案移到 專案設定 */}
            <AlertBell size="md" />
          </div>
        </div>

        {/* Mobile search */}
        {showSearchTools && (
          <div className="mt-2.5 space-y-2">
            <div className="flex rounded-lg bg-muted/50 p-0.5">
              <button
                onClick={() => onSearchModeChange('projects')}
                data-tutorial-tip="專案：依專案分類看所有對話"
                aria-pressed={searchMode === 'projects'}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-normal transition-all",
                  searchMode === 'projects'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Folder className="h-3 w-3" />
                {t('search.modeProjects')}
              </button>
              {/* DHC CLI 10/31：對話回到中間並加上文字（例行拿掉後的位置）；封存從對話分頁上方的連結進入。 */}
              <button
                onClick={() => onSearchModeChange('conversations')}
                data-tutorial-tip="對話：不分專案，直接列出最近的對話"
                aria-pressed={searchMode === 'conversations' || searchMode === 'archived'}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-normal transition-all",
                  searchMode === 'conversations' || searchMode === 'archived'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <MessageSquare className="h-3 w-3" />
                {t('search.modeConversations')}
              </button>
              <button
                onClick={() => onSearchModeChange('query')}
                data-tutorial-tip="查詢：問內部法規、資料目錄和這個網站怎麼用"
                aria-pressed={searchMode === 'query'}
                title="查詢專區（DEMO）：法遵、DHC AI System 教學"
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-normal transition-all",
                  searchMode === 'query'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <BookOpen className="h-3 w-3" />
                查詢
              </button>
              <Tooltip content={t('search.runningTooltip', 'Running sessions')} position="top">
                <button
                  onClick={() => onSearchModeChange('running')}
                  data-tutorial-tip="執行中：只看正在跑的對話，綠色數字是數量"
                  aria-pressed={searchMode === 'running'}
                  aria-label={t('search.runningTooltip', 'Running sessions')}
                  title={t('search.runningTooltip', 'Running sessions')}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-normal transition-all",
                    searchMode === 'running'
                      ? "bg-background shadow-sm text-foreground ring-1 ring-emerald-500/15"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <span className="relative flex h-3 w-3 items-center justify-center">
                    <Activity className={cn("h-3 w-3", runningSessionsCount > 0 && "text-emerald-500")} />
                    {runningSessionsCount > 0 && (
                      <span className="absolute -right-2.5 -top-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-emerald-500 px-0.5 text-[8px] font-semibold leading-none text-white shadow-sm ring-1 ring-background">
                        {runningBadgeText}
                      </span>
                    )}
                  </span>
                  <span className="sr-only">{t('search.modeRunning', 'Running')}</span>
                </button>
              </Tooltip>
              {/* DHC CLI 11/01：新增專案的 ＋ 位置改成「排程」：列出時鐘與分流排好的訊息 */}
              <button
                type="button"
                onClick={() => onSearchModeChange('scheduled')}
                data-tutorial-tip="排程：看所有排好時間或排到夜間的訊息，可以點開或取消"
                aria-pressed={searchMode === 'scheduled'}
                aria-label="排程"
                title="排程"
                className={cn(
                  "flex items-center justify-center rounded-md px-2.5 py-1.5 transition-all",
                  searchMode === 'scheduled'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <CalendarClock className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                type="text"
                placeholder={searchPlaceholder}
                data-tutorial-tip="輸入關鍵字篩選清單"
                value={searchFilter}
                onChange={(event) => onSearchFilterChange(event.target.value)}
                className="nav-search-input h-10 rounded-xl border-0 pl-10 pr-9 text-sm transition-all duration-200 placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              {searchFilter && (
                <button
                  onClick={onClearSearchFilter}
                  aria-label={t('tooltips.clearSearch')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 hover:bg-accent"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Mobile divider */}
      <div className="nav-divider md:hidden" />
    </div>
  );
}
