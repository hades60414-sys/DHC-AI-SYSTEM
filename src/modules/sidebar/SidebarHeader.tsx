import { Activity, BookOpen, Folder, FolderPlus, MessageSquare, Plus, RefreshCw, Repeat, Search, X, PanelLeftClose } from 'lucide-react';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';

import { Button, Input, Tooltip } from '@/shared/ui';
import { CLOUDCLI_WORDMARK_FONT_FAMILY } from '@/shared/constants';
import { IS_PLATFORM,cn } from '@/shared/utils';
import AlertBell from '@/modules/sidebar/AlertBell';
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
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  currentVersion: string;
  t: TFunction;
};

/** Module-level, not a nested render function, so the wordmark is not remounted on every SidebarHeader render. */
function LogoBlock({ t, version }: { t: TFunction; version: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {/* DHC CLI mascot: a line-drawn owl. */}
      <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-primary/90 shadow-sm">
        <svg className="h-5 w-5 text-primary-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 10 L6.5 4.5 L10 7.5 H14 L17.5 4.5 L19 10 V14.5 A7 7 0 0 1 5 14.5 Z" />
          <circle cx="9.3" cy="12" r="2.3" />
          <circle cx="14.7" cy="12" r="2.3" />
          <circle cx="9.3" cy="12" r="0.7" fill="currentColor" stroke="none" />
          <circle cx="14.7" cy="12" r="0.7" fill="currentColor" stroke="none" />
          <path d="M11 15.6 L12 17 L13 15.6" />
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
        <span className="block truncate text-[10px] leading-tight text-muted-foreground/50">v{version} · DHC CLI</span>
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
  onCreateProject,
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
              title="回到 DHC CLI 首頁"
            >
              <LogoBlock t={t} version={currentVersion} />
            </Link>
          ) : (
            <LogoBlock t={t} version={currentVersion} />
          )}

          <div className="flex flex-shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onRefresh}
              disabled={isRefreshing}
              title={t('tooltips.refresh')}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${
                  isRefreshing ? 'animate-spin' : ''
                }`}
              />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onCreateProject}
              title={t('tooltips.createProject')}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <AlertBell />
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onCollapseSidebar}
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
              <button
                onClick={() => onSearchModeChange('routine')}
                aria-pressed={searchMode === 'routine'}
                title="例行工作：每月／每季重複的報告，點進去說「更新10月」就照上次的做法產新的"
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-normal transition-all",
                  searchMode === 'routine'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Repeat className="h-3 w-3" />
                例行
              </button>
              <button
                onClick={() => onSearchModeChange('query')}
                aria-pressed={searchMode === 'query'}
                title="查詢專區：DHC CLI 教學，以及你自己接的文件／資料庫問答"
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
              {/* DHC CLI：對話縮成圖示放最右（原封存的位置）；封存改從對話分頁上方的連結進入。 */}
              <Tooltip content={t('search.modeConversations')} position="top">
                <button
                  onClick={() => onSearchModeChange('conversations')}
                  aria-pressed={searchMode === 'conversations' || searchMode === 'archived'}
                  aria-label={t('search.modeConversations')}
                  title={t('search.modeConversations')}
                  className={cn(
                    "flex items-center justify-center rounded-md px-2.5 py-1.5 text-xs font-normal transition-all",
                    searchMode === 'conversations' || searchMode === 'archived'
                      ? "bg-background shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <MessageSquare className="h-3 w-3" />
                </button>
              </Tooltip>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                type="text"
                placeholder={searchPlaceholder}
                value={searchFilter}
                onChange={(event) => onSearchFilterChange(event.target.value)}
                className="nav-search-input h-9 rounded-xl border-0 pl-9 pr-14 text-sm transition-all duration-200 placeholder:text-muted-foreground/40 focus-visible:ring-0 focus-visible:ring-offset-0"
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
              title="回到 DHC CLI 首頁"
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
            <button
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/90 text-primary-foreground transition-all active:scale-95"
              onClick={onCreateProject}
            >
              <FolderPlus className="h-4 w-4" />
            </button>
            {/* DHC CLI 10/14：警示放最右，重新整理／新增專案往左移 */}
            <AlertBell size="md" />
          </div>
        </div>

        {/* Mobile search */}
        {showSearchTools && (
          <div className="mt-2.5 space-y-2">
            <div className="flex rounded-lg bg-muted/50 p-0.5">
              <button
                onClick={() => onSearchModeChange('projects')}
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
              <button
                onClick={() => onSearchModeChange('routine')}
                aria-pressed={searchMode === 'routine'}
                title="例行工作：每月／每季重複的報告，點進去說「更新10月」就照上次的做法產新的"
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-normal transition-all",
                  searchMode === 'routine'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Repeat className="h-3 w-3" />
                例行
              </button>
              <button
                onClick={() => onSearchModeChange('query')}
                aria-pressed={searchMode === 'query'}
                title="查詢專區：DHC CLI 教學，以及你自己接的文件／資料庫問答"
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
              {/* DHC CLI：對話縮成圖示放最右（原封存的位置）；封存改從對話分頁上方的連結進入。 */}
              <Tooltip content={t('search.modeConversations')} position="top">
                <button
                  onClick={() => onSearchModeChange('conversations')}
                  aria-pressed={searchMode === 'conversations' || searchMode === 'archived'}
                  aria-label={t('search.modeConversations')}
                  title={t('search.modeConversations')}
                  className={cn(
                    "flex items-center justify-center rounded-md px-2.5 py-1.5 text-xs font-normal transition-all",
                    searchMode === 'conversations' || searchMode === 'archived'
                      ? "bg-background shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <MessageSquare className="h-3 w-3" />
                </button>
              </Tooltip>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                type="text"
                placeholder={searchPlaceholder}
                value={searchFilter}
                onChange={(event) => onSearchFilterChange(event.target.value)}
                className="nav-search-input h-10 rounded-xl border-0 pl-10 pr-9 text-sm transition-all duration-200 placeholder:text-muted-foreground/40 focus-visible:ring-0 focus-visible:ring-offset-0"
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
