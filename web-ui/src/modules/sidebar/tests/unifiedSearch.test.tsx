import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import type { ConversationSearchResults, Project, SidebarProjectListProps, SidebarSearchMode } from '@/shared/types';

/**
 * DHC CLI search: typing in the 專案 tab also finds conversations by title and content, with the
 * projects whose name matches listed first. Results from projects the sidebar hides (batch runs,
 * scratch folders) are dropped even when an older server still returns them.
 */

vi.mock('@/shared/ui', () => ({
  LLMProviderLogo: () => null,
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/modules/sidebar/SidebarHeader', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarFooter', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarRecentConversations', () => ({ default: () => <div>recent-conversations</div> }));
vi.mock('@/modules/sidebar/SidebarProjectList', () => ({
  default: ({ filteredProjects }: SidebarProjectListProps) => (
    <ul>{filteredProjects.map((project) => <li key={project.projectId}>project:{project.displayName}</li>)}</ul>
  ),
}));

const { default: SidebarContent } = await import('@/modules/sidebar/SidebarContent');
const { keepSearchResultsInProjects } = await import('@/modules/sidebar/hooks/useSidebarController');

const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const noop = () => {};

const project = (projectId: string, displayName: string) => ({
  projectId,
  name: displayName,
  displayName,
  fullPath: `C:\\Users\\demo\\DHC Workspace\\${displayName}`,
  sessions: [],
}) as unknown as Project;

const results = (overrides: Partial<ConversationSearchResults> = {}): ConversationSearchResults => ({
  query: 'VaR',
  totalMatches: 0,
  titleResults: [],
  results: [],
  ...overrides,
});

const renderSearch = (options: {
  searchMode?: SidebarSearchMode;
  searchFilter: string;
  conversationResults: ConversationSearchResults | null;
  isSearching?: boolean;
  filteredProjects?: Project[];
}) => {
  const filteredProjects = options.filteredProjects ?? [];
  const props = {
    isPWA: false,
    isMobile: false,
    isLoading: false,
    projects: filteredProjects,
    runningSessionsCount: 0,
    archivedProjects: [],
    archivedSessions: [],
    archivedSessionsCount: 0,
    isArchivedSessionsLoading: false,
    recentConversations: [],
    recentConversationsTotal: 0,
    recentConversationsHasMore: false,
    isRecentConversationsLoading: false,
    isLoadingMoreRecentConversations: false,
    recentConversationsError: false,
    searchFilter: options.searchFilter,
    onSearchFilterChange: noop,
    onClearSearchFilter: noop,
    searchMode: options.searchMode ?? 'projects',
    onSearchModeChange: noop,
    conversationResults: options.conversationResults,
    isSearching: options.isSearching ?? false,
    searchProgress: null,
    onRestoreArchivedProject: noop,
    onLoadMoreRecentConversations: noop,
    onRetryRecentConversations: noop,
    onArchivedSessionClick: noop,
    onRestoreArchivedSession: noop,
    onDeleteArchivedSession: noop,
    onConversationResultClick: noop,
    onRefresh: noop,
    isRefreshing: false,
    onCreateProject: noop,
    onCollapseSidebar: noop,
    updateAvailable: false,
    restartRequired: false,
    releaseInfo: null,
    latestVersion: null,
    currentVersion: '1.0.0',
    onShowVersionModal: noop,
    onShowSettings: noop,
    projectListProps: { filteredProjects, currentTime: new Date('2026-10-05T06:00:00Z') } as unknown as SidebarProjectListProps,
    t,
  } as unknown as React.ComponentProps<typeof SidebarContent>;
  return render(<SidebarContent {...props} />);
};

test('typing in the 專案 tab lists matching conversation titles and contents', () => {
  renderSearch({
    searchFilter: '幽靈',
    conversationResults: results({
      totalMatches: 1,
      titleResults: [{
        sessionId: 's1', provider: 'claude', projectId: 'p1', projectDisplayName: '月報',
        sessionTitle: '查幽靈用量', lastActivity: '2026-10-05T04:00:00Z',
      }],
      results: [{
        projectId: 'p2', projectName: 'C:\\x\\同事B', projectDisplayName: '同事B',
        sessions: [{
          sessionId: 's2', provider: 'claude', sessionSummary: '晨會',
          matches: [{ role: 'user', snippet: '額度有幽靈用量嗎', highlights: [{ start: 3, end: 5 }], timestamp: null, provider: 'claude' }],
        }],
      }],
    }),
  });

  assert.ok(screen.getByText('查幽靈用量'), 'title match shows');
  assert.ok(screen.getByText('晨會'), 'content match shows');
  assert.equal(screen.getByText('幽靈').tagName, 'MARK');
});

test('projects whose name matches come first, and suppress the empty-result message', () => {
  renderSearch({
    searchFilter: '同事',
    conversationResults: results({ query: '同事' }),
    filteredProjects: [project('p2', '同事B')],
  });

  assert.ok(screen.getByText('project:同事B'));
  assert.equal(screen.queryByText('search.noResults'), null);
});

test('the empty-result message shows when neither projects nor conversations match', () => {
  renderSearch({ searchFilter: 'zzz', conversationResults: results({ query: 'zzz' }) });

  assert.ok(screen.getByText('search.noResults'));
});

test('while contents are still being scanned the content section says so instead of only 0 matches', () => {
  renderSearch({
    searchFilter: 'VaR',
    isSearching: true,
    conversationResults: results({
      titleResults: [{
        sessionId: 's1', provider: 'claude', projectId: 'p1', projectDisplayName: '月報',
        sessionTitle: '問 DB2：VaR 限額怎麼算？', lastActivity: null,
      }],
    }),
  });

  assert.ok(screen.getByText('search.conversationContents'));
  assert.ok(screen.getByText('search.searching'));
});

test('a one-character query still just filters the project list', () => {
  renderSearch({ searchFilter: '同', conversationResults: null, filteredProjects: [project('p2', '同事B')] });

  assert.ok(screen.getByText('project:同事B'));
  assert.equal(screen.queryByText('search.modeProjects'), null, 'no search sections for one character');
});

test('results from projects outside the sidebar are dropped and the match count follows', () => {
  const match = { role: 'user', snippet: 'VaR', highlights: [], timestamp: null, provider: 'claude' as const };
  const kept = keepSearchResultsInProjects(results({
    totalMatches: 5,
    titleResults: [
      { sessionId: 'a', provider: 'claude', projectId: 'visible', projectDisplayName: '月報', sessionTitle: 'VaR', lastActivity: null },
      { sessionId: 'b', provider: 'claude', projectId: 'batch', projectDisplayName: 'qfolder-replica', sessionTitle: 'VaR', lastActivity: null },
    ],
    results: [
      { projectId: 'visible', projectName: 'v', projectDisplayName: '月報', sessions: [{ sessionId: 'a', sessionSummary: 'a', matches: [match, match] }] },
      { projectId: 'batch', projectName: 'b', projectDisplayName: 'qfolder-replica', sessions: [{ sessionId: 'b', sessionSummary: 'b', matches: [match, match] }] },
      { projectId: null, projectName: 'u', projectDisplayName: 'Unknown Project', sessions: [{ sessionId: 'c', sessionSummary: 'c', matches: [match] }] },
    ],
  }), new Set(['visible']));

  assert.deepEqual(kept.titleResults.map((result) => result.sessionId), ['a']);
  assert.deepEqual(kept.results.map((result) => result.projectId), ['visible', null]);
  assert.equal(kept.totalMatches, 3);
});
